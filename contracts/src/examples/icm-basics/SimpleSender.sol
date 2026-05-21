// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  ICM Basics — SimpleSender
// -----------------------------------------------------------------------------
//  This is the "Hello, World!" of Avalanche Interchain Messaging (ICM).
//
//  ICM is the protocol that lets contracts on one Avalanche L1 talk to contracts
//  on another L1. Under the hood it uses the Warp precompile (for cryptographic
//  attestations from a source L1's validators) wrapped by a contract called
//  `TeleporterMessenger`, which provides a friendly "send/receive" API.
//
//  This contract lives on the SOURCE chain (Chain A). When `sendMessage` is
//  called, it asks the local `TeleporterMessenger` to package a payload and
//  ship it to a `SimpleReceiver` on the DESTINATION chain (Chain B).
//
//  The destination chain is identified by its `blockchainID` — a `bytes32`
//  hash derived on the P-Chain when the L1 is created. The destination address
//  is just the EVM address of the receiver contract on Chain B.
// =============================================================================

import {
    ITeleporterMessenger,
    TeleporterMessageInput,
    TeleporterFeeInfo
} from "@teleporter/ITeleporterMessenger.sol";

contract SimpleSender {
    /// @notice The local TeleporterMessenger this sender talks to.
    /// @dev    Every chain has a canonical TeleporterMessenger deployed at a
    ///         well-known address. We capture it once at construction so the
    ///         contract has a clear, immutable dependency.
    ITeleporterMessenger public immutable teleporterMessenger;

    /// @notice Emitted locally whenever we hand a message off to Teleporter.
    /// @dev    Useful for tests and indexers: gives us the `messageID` returned
    ///         by Teleporter so we can correlate this send with the eventual
    ///         delivery event on the destination chain.
    event MessageSent(
        bytes32 indexed messageID,
        bytes32 indexed destinationBlockchainID,
        address indexed destinationAddress,
        string message
    );

    constructor(address teleporterMessengerAddress) {
        require(teleporterMessengerAddress != address(0), "SimpleSender: zero messenger");
        teleporterMessenger = ITeleporterMessenger(teleporterMessengerAddress);
    }

    /// @notice Send a string message to a contract on another L1.
    /// @param  destinationBlockchainID  The `bytes32` chain ID of the target L1.
    /// @param  destinationAddress       The receiver contract address on that L1.
    /// @param  message                  Arbitrary UTF-8 string payload.
    /// @return messageID                Teleporter's unique ID for this message.
    function sendMessage(
        bytes32 destinationBlockchainID,
        address destinationAddress,
        string calldata message
    ) external returns (bytes32 messageID) {
        // ABI-encode the user payload. ICM messages are arbitrary `bytes`; both
        // sides agree on the encoding. Here we just wrap a single string.
        bytes memory encodedMessage = abi.encode(message);

        // Build the Teleporter "envelope". A few notable fields:
        //  - feeInfo: For a fee-paying message you'd specify an ERC-20 token
        //    and amount that a relayer earns for delivering. For this basic
        //    example we use zero fee (anyone can relay for free — fine in
        //    tests and demos, where our harness or a test relayer delivers).
        //  - requiredGasLimit: Upper bound on gas the destination call may use.
        //    The relayer must supply at least this much. We pick 300k to give
        //    the receiver room to do the `TeleporterRegistryApp` version
        //    check, write two storage slots, and push to the history array.
        //  - allowedRelayerAddresses: Empty array = any relayer may deliver.
        TeleporterMessageInput memory messageInput = TeleporterMessageInput({
            destinationBlockchainID: destinationBlockchainID,
            destinationAddress: destinationAddress,
            feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
            requiredGasLimit: 300_000,
            allowedRelayerAddresses: new address[](0),
            message: encodedMessage
        });

        // Hand the envelope to the local TeleporterMessenger. It will:
        //   1. Compute a unique messageID.
        //   2. Emit a `SendCrossChainMessage` event that off-chain relayers
        //      (or, in tests, our harness) watch for.
        //   3. Internally call the Warp precompile to attest the message.
        messageID = teleporterMessenger.sendCrossChainMessage(messageInput);

        emit MessageSent(messageID, destinationBlockchainID, destinationAddress, message);
    }
}
