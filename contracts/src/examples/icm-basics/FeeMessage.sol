// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  ICM Basics — FeeMessage (paying a relayer)
// -----------------------------------------------------------------------------
//  A trimmed variant of `SimpleSender` that demonstrates a NON-ZERO fee.
//  Real Avalanche deployments rely on an off-chain relayer to pick up
//  `SendCrossChainMessage` events and deliver them to the destination
//  TeleporterMessenger. To compensate the relayer for that work, the sender
//  contract attaches an ERC-20 fee to every message. Teleporter pulls the fee
//  via `safeTransferFrom` at send time and credits the relayer when the
//  matching receipt is confirmed on the source chain.
//
//  This contract is intentionally narrow: one method, one knob (fee amount),
//  one bookkeeping event. Pair it with any receiver that implements
//  `ITeleporterReceiver` — for the tests, we use `SimpleReceiver`.
// =============================================================================

import {
    ITeleporterMessenger,
    TeleporterMessageInput,
    TeleporterFeeInfo
} from "@teleporter/ITeleporterMessenger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FeeMessage {
    using SafeERC20 for IERC20;

    /// @notice The local TeleporterMessenger this contract talks to.
    ITeleporterMessenger public immutable teleporterMessenger;

    /// @notice The ERC-20 used to pay relayers for this contract's messages.
    /// @dev    Real deployments often use a stablecoin or the chain's native
    ///         gas token wrapped as an ERC-20. We keep it pluggable.
    IERC20 public immutable feeToken;

    /// @notice Emitted whenever a fee-paying message is shipped to the
    ///         destination chain. Off-chain indexers can pair this with the
    ///         Teleporter `SendCrossChainMessage` event via `messageID`.
    event MessageSent(
        bytes32 indexed messageID,
        bytes32 indexed destinationBlockchainID,
        address indexed destinationAddress,
        uint256 feeAmount,
        string message
    );

    constructor(address teleporterMessengerAddress, address feeTokenAddress) {
        require(teleporterMessengerAddress != address(0), "FeeMessage: zero messenger");
        require(feeTokenAddress != address(0), "FeeMessage: zero fee token");
        teleporterMessenger = ITeleporterMessenger(teleporterMessengerAddress);
        feeToken = IERC20(feeTokenAddress);
    }

    /// @notice Send a string to `destinationAddress` on `destinationBlockchainID`
    ///         and pay `feeAmount` of `feeToken` to the relayer that ultimately
    ///         delivers the message.
    /// @dev    The caller MUST have approved `feeAmount` to this contract
    ///         BEFORE calling. This contract then approves Teleporter for that
    ///         exact amount and lets Teleporter's `safeTransferFrom` pull it
    ///         directly out of THIS contract's balance — which is the canonical
    ///         pattern for "the sending app holds the fee budget".
    function sendMessage(
        bytes32 destinationBlockchainID,
        address destinationAddress,
        uint256 feeAmount,
        string calldata message
    ) external returns (bytes32 messageID) {
        require(feeAmount > 0, "FeeMessage: zero fee");

        // Pull the fee from the caller into this contract — the caller is the
        // "owner" of the fee budget, this contract is the messenger's
        // counterparty.
        feeToken.safeTransferFrom(msg.sender, address(this), feeAmount);

        // Approve Teleporter to pull `feeAmount` from us. Teleporter performs a
        // `safeTransferFrom(address(this), teleporter, feeAmount)` inside
        // `sendCrossChainMessage`, recording the fee on the SentMessageInfo so
        // it can later be paid out to whoever submits the receipt.
        feeToken.forceApprove(address(teleporterMessenger), feeAmount);

        // Build and dispatch the message envelope. Compared with the zero-fee
        // example we only change `feeInfo` — everything else is identical.
        TeleporterMessageInput memory messageInput = TeleporterMessageInput({
            destinationBlockchainID: destinationBlockchainID,
            destinationAddress: destinationAddress,
            feeInfo: TeleporterFeeInfo({feeTokenAddress: address(feeToken), amount: feeAmount}),
            requiredGasLimit: 300_000,
            allowedRelayerAddresses: new address[](0),
            message: abi.encode(message)
        });

        messageID = teleporterMessenger.sendCrossChainMessage(messageInput);

        emit MessageSent(messageID, destinationBlockchainID, destinationAddress, feeAmount, message);
    }
}
