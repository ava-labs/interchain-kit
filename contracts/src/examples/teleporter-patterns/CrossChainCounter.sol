// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  Teleporter Patterns — CrossChainCounter (cross-chain state mutation)
// -----------------------------------------------------------------------------
//  A trivial counter where the increment is triggered REMOTELY. The same
//  contract is deployed on every chain in the network. Each instance has its
//  own local `value`. Anyone can call `incrementLocal()` on their local chain,
//  OR they can call `incrementRemote(destChainID)` to send a Teleporter message
//  that, when delivered, calls `_applyIncrement` on the destination instance.
//
//  This is the foundation for almost every cross-chain dApp pattern:
//    - cross-chain governance ("propose on Chain A, execute on Chain B")
//    - cross-chain NFT / token state updates
//    - cross-chain oracles ("push price from Chain A to Chain B")
//
//  Compared to PingPong, this example shows:
//    - A "peer registry": one contract instance may have peers on N chains,
//      not just one. Mapping (chainID => peer address).
//    - Payload includes the amount to increment by, demonstrating that
//      cross-chain messages carry rich, ABI-encoded calldata.
//    - The receive callback DOES NOT spawn a reply — fire-and-forget.
// =============================================================================

import {
    ITeleporterMessenger,
    TeleporterMessageInput,
    TeleporterFeeInfo
} from "@teleporter/ITeleporterMessenger.sol";
import {ITeleporterReceiver} from "@teleporter/ITeleporterReceiver.sol";

contract CrossChainCounter is ITeleporterReceiver {
    /// @notice The local TeleporterMessenger on the chain this instance lives on.
    ITeleporterMessenger public immutable teleporterMessenger;

    /// @notice The current local counter value.
    uint256 public value;

    /// @notice Peer registry: for each remote chainID, the trusted peer contract
    ///         address that is allowed to instruct us to increment. Messages
    ///         from any other source address on that chain are rejected.
    mapping(bytes32 => address) public peers;

    /// @notice Required gas the relayer must supply for the destination call.
    ///         Bumping `value` + reading a peer mapping is well under 100k, but
    ///         we leave headroom for the event emission and future fields.
    uint256 public constant DESTINATION_GAS_LIMIT = 200_000;

    event PeerSet(bytes32 indexed chainID, address indexed peerAddress);
    event LocalIncrement(uint256 amount, uint256 newValue);
    event RemoteIncrementSent(
        bytes32 indexed messageID,
        bytes32 indexed destinationChainID,
        address indexed destinationAddress,
        uint256 amount
    );
    event RemoteIncrementApplied(
        bytes32 indexed sourceChainID, address indexed sourceAddress, uint256 amount, uint256 newValue
    );

    constructor(address teleporterMessengerAddress) {
        require(teleporterMessengerAddress != address(0), "CrossChainCounter: zero messenger");
        teleporterMessenger = ITeleporterMessenger(teleporterMessengerAddress);
    }

    /// @notice Register the address of a peer CrossChainCounter on another chain.
    /// @dev    Kept open (no owner gate) for the sake of test simplicity. In
    ///         production this MUST be access-controlled — whoever can call
    ///         this can authorize an attacker contract to mutate our state.
    function setPeer(bytes32 chainID, address peerAddress) external {
        require(chainID != bytes32(0), "CrossChainCounter: zero chainID");
        require(peerAddress != address(0), "CrossChainCounter: zero peer");
        require(peers[chainID] == address(0), "CrossChainCounter: peer already set");
        peers[chainID] = peerAddress;
        emit PeerSet(chainID, peerAddress);
    }

    /// @notice Bump the local counter by `amount`. No cross-chain interaction.
    function incrementLocal(uint256 amount) external {
        value += amount;
        emit LocalIncrement(amount, value);
    }

    /// @notice Send a Teleporter message that bumps the counter on
    ///         `destinationChainID` by `amount`.
    /// @param  destinationChainID  The bytes32 blockchainID of the target L1.
    /// @param  amount              How much to add to the remote counter.
    /// @return messageID           The Teleporter messageID for the outbound msg.
    function incrementRemote(
        bytes32 destinationChainID,
        uint256 amount
    ) external returns (bytes32 messageID) {
        address peer = peers[destinationChainID];
        require(peer != address(0), "CrossChainCounter: peer not set");

        // Payload is just the increment amount. The receiver knows its own
        // identity, so we don't need to include "counter address" or similar.
        bytes memory payload = abi.encode(amount);

        messageID = teleporterMessenger.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: destinationChainID,
                destinationAddress: peer,
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: DESTINATION_GAS_LIMIT,
                allowedRelayerAddresses: new address[](0),
                message: payload
            })
        );

        emit RemoteIncrementSent(messageID, destinationChainID, peer, amount);
    }

    /// @notice Teleporter delivery entry point. Gated to (a) the local
    ///         messenger and (b) the configured peer on the source chain.
    function receiveTeleporterMessage(
        bytes32 sourceBlockchainID,
        address originSenderAddress,
        bytes calldata message
    ) external override {
        // (a) Only the local TeleporterMessenger may deliver to us.
        require(
            msg.sender == address(teleporterMessenger), "CrossChainCounter: unauthorized messenger"
        );
        // (b) Only the trusted peer on the source chain may instruct us.
        address expectedPeer = peers[sourceBlockchainID];
        require(expectedPeer != address(0), "CrossChainCounter: unknown source chain");
        require(originSenderAddress == expectedPeer, "CrossChainCounter: untrusted sender");

        uint256 amount = abi.decode(message, (uint256));
        value += amount;
        emit RemoteIncrementApplied(sourceBlockchainID, originSenderAddress, amount, value);
    }
}
