// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  ICM Basics — SimpleReceiver
// -----------------------------------------------------------------------------
//  Companion to `SimpleSender`. Lives on the DESTINATION chain (Chain B).
//
//  Receivers of ICM messages MUST implement `ITeleporterReceiver`. The local
//  TeleporterMessenger calls `receiveTeleporterMessage(...)` on this contract
//  when a relayer delivers a message addressed to it.
//
//  Rather than implementing the interface directly, we inherit from
//  `TeleporterRegistryApp`. That base contract gives us, for free:
//    - A check that the caller is a registered, current-enough Teleporter
//      version (prevents random EOAs from spoofing messages).
//    - A reentrancy guard around message delivery.
//    - Pause / version-upgrade hooks (we don't use them here, but they're
//      good hygiene for production).
//
//  We override `_receiveTeleporterMessage` for our business logic: decode the
//  string, store it as "latest", and append to history.
// =============================================================================

import {TeleporterRegistryApp} from "@teleporter/registry/TeleporterRegistryApp.sol";

contract SimpleReceiver is TeleporterRegistryApp {
    /// @notice The most recent message received (decoded string).
    string public latestMessage;

    /// @notice The L1 the most recent message came from.
    bytes32 public latestSourceBlockchainID;

    /// @notice The address (on the source L1) that originally called sendMessage.
    /// @dev    This is provided by Teleporter and is non-spoofable — it's the
    ///         actual `msg.sender` of `sendCrossChainMessage` on Chain A.
    address public latestOriginSenderAddress;

    /// @notice Append-only log of every message ever received.
    string[] public history;

    /// @notice Emitted whenever a cross-chain message is successfully processed.
    event MessageReceived(
        bytes32 indexed sourceBlockchainID,
        address indexed originSenderAddress,
        string message
    );

    /// @param teleporterRegistryAddress Address of the TeleporterRegistry on
    ///        the local (destination) chain. The registry tells the base class
    ///        which messenger addresses are trusted.
    /// @param minTeleporterVersion The minimum Teleporter protocol version this
    ///        contract accepts deliveries from. Use `1` for the standard setup.
    constructor(address teleporterRegistryAddress, uint256 minTeleporterVersion)
        TeleporterRegistryApp(teleporterRegistryAddress, minTeleporterVersion)
    {}

    // -------------------------------------------------------------------------
    //  Views
    // -------------------------------------------------------------------------

    /// @notice Number of messages received so far.
    function historyLength() external view returns (uint256) {
        return history.length;
    }

    /// @notice Convenience accessor for a single historical message.
    function getMessage(uint256 index) external view returns (string memory) {
        return history[index];
    }

    // -------------------------------------------------------------------------
    //  ICM hook
    // -------------------------------------------------------------------------

    /// @dev Called by `TeleporterRegistryApp.receiveTeleporterMessage` after it
    ///      verifies the caller is a trusted Teleporter version. Anything we
    ///      do here is the application-specific message handling.
    function _receiveTeleporterMessage(
        bytes32 sourceBlockchainID,
        address originSenderAddress,
        bytes memory message
    ) internal override {
        // Mirror the encoding used by SimpleSender: a single ABI-encoded string.
        string memory decoded = abi.decode(message, (string));

        latestMessage = decoded;
        latestSourceBlockchainID = sourceBlockchainID;
        latestOriginSenderAddress = originSenderAddress;
        history.push(decoded);

        emit MessageReceived(sourceBlockchainID, originSenderAddress, decoded);
    }

    /// @dev Required by TeleporterRegistryApp. In a real deployment this would
    ///      gate version upgrades behind an owner / multisig. For this teaching
    ///      example we leave it permissionless — nobody is meant to call the
    ///      upgrade entrypoints in tests anyway.
    function _checkTeleporterRegistryAppAccess() internal pure override {}
}
