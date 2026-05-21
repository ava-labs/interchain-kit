// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  Teleporter Patterns — PingPong (request/reply)
// -----------------------------------------------------------------------------
//  This is the canonical "request/reply" pattern over ICM. The same contract
//  is deployed on TWO different L1s. When chain A's PingPong receives a "ping"
//  from chain B's PingPong, it immediately fires a "pong" back to chain B.
//
//  Two things make this example interesting compared to the basic "send a
//  string" example:
//
//    1. The receiver does NOT just store data — it sends a NEW Teleporter
//       message during its own `receiveTeleporterMessage` callback. This is
//       perfectly legal and is how multi-hop / acknowledgement patterns work.
//
//    2. The contract is both a sender AND a receiver. To receive messages it
//       must implement `ITeleporterReceiver`. Teleporter delivers messages by
//       calling `receiveTeleporterMessage(sourceChainID, originSender, payload)`
//       on this contract, and we MUST gate that entry point so that only the
//       local TeleporterMessenger can call it.
//
//  Learner takeaways:
//    - Cross-chain "calls" are always one-shot fire-and-forget messages.
//      A reply is just a SECOND message going the other direction.
//    - Always validate `msg.sender == teleporterMessenger` in receive callbacks.
//    - Always validate `originSenderAddress == trustedPeer` to ignore traffic
//       from contracts you don't trust on the source chain.
// =============================================================================

import {
    ITeleporterMessenger,
    TeleporterMessageInput,
    TeleporterFeeInfo
} from "@teleporter/ITeleporterMessenger.sol";
import {ITeleporterReceiver} from "@teleporter/ITeleporterReceiver.sol";

contract PingPong is ITeleporterReceiver {
    /// @notice Discriminator byte at the front of every payload telling the
    ///         receiver which branch to take. Real apps typically use an enum
    ///         or a function-selector style 4-byte tag; one byte is plenty here.
    enum Kind {
        Ping,
        Pong
    }

    /// @notice The local TeleporterMessenger (canonical messenger on this chain).
    ITeleporterMessenger public immutable teleporterMessenger;

    /// @notice The chainID of the *peer* PingPong (the OTHER chain).
    /// @dev    Configured once via `setPeer`. In production you might want a
    ///         registry-based lookup, but for a pedagogical 2-chain example a
    ///         single hard-coded peer is the clearest design.
    bytes32 public peerBlockchainID;

    /// @notice The address of the peer PingPong contract on the peer chain.
    address public peerAddress;

    /// @notice True once `setPeer` has been called. We don't allow re-configuring
    ///         the peer after it's set — keeps the trust model unambiguous.
    bool public peerConfigured;

    /// @notice Bookkeeping: how many pings we've received from the peer.
    uint256 public pingsReceived;

    /// @notice Bookkeeping: how many pongs we've received back from the peer.
    uint256 public pongsReceived;

    /// @notice The last "nonce" we received in a Pong. Lets tests assert the
    ///         reply matches the request that triggered it.
    uint256 public lastPongNonce;

    /// @notice Required gas for the destination to process our message.
    /// @dev    Crucially this MUST cover the case where the receiver itself
    ///         calls `sendCrossChainMessage` to fire a reply — i.e. the gas
    ///         used by the ping side of the handler PLUS the cost of the
    ///         destination messenger storing the reply in its outbound queue
    ///         and calling into the warp precompile. The pong-receipt side of
    ///         the handler is cheap (just bookkeeping), so we don't need to
    ///         match this on the way back, but using one constant for both
    ///         directions keeps the example simple.
    uint256 public constant DESTINATION_GAS_LIMIT = 1_500_000;

    event PingSent(bytes32 indexed messageID, uint256 nonce);
    event PingReceived(uint256 nonce);
    event PongSent(bytes32 indexed messageID, uint256 nonce);
    event PongReceived(uint256 nonce);

    constructor(address teleporterMessengerAddress) {
        require(teleporterMessengerAddress != address(0), "PingPong: zero messenger");
        teleporterMessenger = ITeleporterMessenger(teleporterMessengerAddress);
    }

    /// @notice One-time configuration of the peer chain + peer contract address.
    /// @dev    Kept open (no owner) for simplicity in tests. In production this
    ///         should be `onlyOwner` or set in the constructor — but the address
    ///         of the peer is usually only known AFTER deployment, since both
    ///         sides need to deploy first. A typical pattern is to use a
    ///         deterministic CREATE2 address, or to set it via owner-gated init.
    function setPeer(bytes32 peerBlockchainID_, address peerAddress_) external {
        require(!peerConfigured, "PingPong: peer already set");
        require(peerBlockchainID_ != bytes32(0), "PingPong: zero peer chainID");
        require(peerAddress_ != address(0), "PingPong: zero peer address");
        peerBlockchainID = peerBlockchainID_;
        peerAddress = peerAddress_;
        peerConfigured = true;
    }

    /// @notice Fire a Ping at the peer. The peer will auto-reply with a Pong.
    /// @param  nonce  An arbitrary value we expect to see echoed back in the Pong.
    /// @return messageID  The Teleporter messageID for the outbound Ping.
    function ping(uint256 nonce) external returns (bytes32 messageID) {
        require(peerConfigured, "PingPong: peer not set");

        // Payload layout: (Kind kind, uint256 nonce).
        // The receiver branches on `kind` to know whether to reply.
        bytes memory payload = abi.encode(Kind.Ping, nonce);

        messageID = teleporterMessenger.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: peerBlockchainID,
                destinationAddress: peerAddress,
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: DESTINATION_GAS_LIMIT,
                allowedRelayerAddresses: new address[](0),
                message: payload
            })
        );

        emit PingSent(messageID, nonce);
    }

    /// @notice Teleporter delivery entry point. The local messenger calls this
    ///         when a message arrives on this chain destined for this address.
    /// @dev    Two security checks are mandatory and apply to EVERY receiver:
    ///           (a) Only the local TeleporterMessenger may call us.
    ///           (b) Only our trusted peer (chainID + address) may send to us.
    function receiveTeleporterMessage(
        bytes32 sourceBlockchainID,
        address originSenderAddress,
        bytes calldata message
    ) external override {
        // (a) Trust the local messenger only.
        require(msg.sender == address(teleporterMessenger), "PingPong: unauthorized messenger");
        // (b) Trust only our configured peer on the configured chain.
        require(peerConfigured, "PingPong: peer not set");
        require(sourceBlockchainID == peerBlockchainID, "PingPong: wrong source chain");
        require(originSenderAddress == peerAddress, "PingPong: untrusted sender");

        (Kind kind, uint256 nonce) = abi.decode(message, (Kind, uint256));

        if (kind == Kind.Ping) {
            // We were pinged — increment the counter and reply.
            pingsReceived += 1;
            emit PingReceived(nonce);

            // Construct the Pong payload (same shape, different Kind).
            bytes memory replyPayload = abi.encode(Kind.Pong, nonce);

            // Send the Pong back over Teleporter. Note: this is a brand-new
            // outbound message that the relayer (or test harness) must then
            // deliver. Tests that call `harness.relayAll()` after a ping will
            // see this new message enqueued and drain it automatically.
            bytes32 replyID = teleporterMessenger.sendCrossChainMessage(
                TeleporterMessageInput({
                    destinationBlockchainID: sourceBlockchainID, // bounce right back
                    destinationAddress: originSenderAddress,
                    feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                    requiredGasLimit: DESTINATION_GAS_LIMIT,
                    allowedRelayerAddresses: new address[](0),
                    message: replyPayload
                })
            );
            emit PongSent(replyID, nonce);
        } else {
            // We received a Pong: just record it.
            pongsReceived += 1;
            lastPongNonce = nonce;
            emit PongReceived(nonce);
        }
    }
}
