// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {WarpMessage, WarpBlockHash, IWarpMessenger} from "@subnet-evm/IWarpMessenger.sol";

/// @title MockWarpPrecompile
/// @notice A drop-in replacement for the subnet-evm Warp precompile
///         (`0x0200000000000000000000000000000000000005`) used by Foundry tests
///         to exercise real ICM / ICTT contracts end-to-end in a single EVM
///         instance.
///
/// @dev This is installed at the precompile address with `vm.etch(...)` by the
///      `FoundryWarpHarness` library. Once installed, the real
///      `TeleporterMessenger` and real `ERC20TokenHome` / `ERC20TokenRemote`
///      contracts can be deployed unmodified — they will call into this mock
///      whenever they reach for `WARP_MESSENGER`.
///
///      Three things this mock fakes:
///
///        1. `getBlockchainID()` returns different values per caller, so two
///           TeleporterMessenger instances deployed at distinct addresses
///           each cache distinct blockchain IDs (the harness assigns them).
///
///        2. `sendWarpMessage(payload)` records `{sender: msg.sender, payload}`
///           into a queue the harness drains via `relayAll()`. The returned
///           messageID is a deterministic hash so logs are stable.
///
///        3. `getVerifiedWarpMessage(idx)` returns the "currently inflight"
///           message that the harness has staged immediately before invoking
///           `receiveCrossChainMessage` on the destination Teleporter.
///
///           **Key trick:** the returned `originSenderAddress` is set to
///           `msg.sender` — i.e. the destination Teleporter's own address.
///           That bypasses the universal-deployer self-check
///           (`warpMessage.originSenderAddress == address(this)`) in
///           `TeleporterMessenger.receiveCrossChainMessage` without having
///           to deploy both messengers at the same address.
contract MockWarpPrecompile is IWarpMessenger {
    /// @dev message captured from sendWarpMessage
    struct Queued {
        address sender;     // who called sendWarpMessage (e.g. source TeleporterMessenger)
        bytes32 sourceChainID;
        bytes payload;      // raw bytes — for Teleporter, this is the encoded TeleporterMessage
        bool delivered;
    }

    /// @dev message currently staged for the next getVerifiedWarpMessage call
    struct Inflight {
        bool set;
        bytes32 sourceChainID;
        bytes payload;
    }

    mapping(address => bytes32) public chainIdOf;     // sender -> chain id (used after deploy)
    bytes32 public currentDeployChain;                // fallback during deploy when msg.sender not yet registered
    Queued[] public queue;
    Inflight internal _inflight;

    // ------ harness administration (called via vm.store-style helpers from FoundryWarpHarness) ------

    function _harness_setChainId(address sender, bytes32 chainId) external {
        chainIdOf[sender] = chainId;
    }

    function _harness_setCurrentDeployChain(bytes32 chainId) external {
        currentDeployChain = chainId;
    }

    function _harness_stageInflight(bytes32 sourceChainID, bytes calldata payload) external {
        _inflight = Inflight({set: true, sourceChainID: sourceChainID, payload: payload});
    }

    function _harness_clearInflight() external {
        delete _inflight;
    }

    function _harness_queueLength() external view returns (uint256) {
        return queue.length;
    }

    function _harness_markDelivered(uint256 idx) external {
        queue[idx].delivered = true;
    }

    function _harness_getQueued(uint256 idx) external view returns (Queued memory) {
        return queue[idx];
    }

    // ------ IWarpMessenger ------

    function sendWarpMessage(
        bytes calldata payload
    ) external override returns (bytes32 messageID) {
        bytes32 src = chainIdOf[msg.sender];
        queue.push(Queued({sender: msg.sender, sourceChainID: src, payload: payload, delivered: false}));
        messageID = keccak256(abi.encode(src, msg.sender, queue.length, payload));
        emit SendWarpMessage(msg.sender, messageID, payload);
    }

    function getVerifiedWarpMessage(
        uint32 /* index */
    ) external view override returns (WarpMessage memory message, bool valid) {
        // The harness stages one inflight message immediately before calling
        // receiveCrossChainMessage. We return it with originSenderAddress =
        // msg.sender (i.e. the destination messenger itself) so the
        // universal-deployer self-check passes.
        if (!_inflight.set) {
            return (WarpMessage({sourceChainID: bytes32(0), originSenderAddress: address(0), payload: ""}), false);
        }
        message = WarpMessage({
            sourceChainID: _inflight.sourceChainID,
            originSenderAddress: msg.sender,
            payload: _inflight.payload
        });
        valid = true;
    }

    function getVerifiedWarpBlockHash(
        uint32 /* index */
    ) external pure override returns (WarpBlockHash memory, bool) {
        revert("MockWarp: getVerifiedWarpBlockHash not implemented");
    }

    function getBlockchainID() external view override returns (bytes32) {
        bytes32 id = chainIdOf[msg.sender];
        if (id != bytes32(0)) return id;
        require(currentDeployChain != bytes32(0), "MockWarp: no chainId for caller and no current deploy chain");
        return currentDeployChain;
    }
}
