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
///           The harness explicitly stages an `originSenderAddress` field in
///           the inflight info. This lets the harness be HONEST about who
///           the source messenger was (so Teleporter's universal-deployer
///           self-check at
///           `require(originSenderAddress == address(this))` correctly
///           reverts when source and destination messengers were deployed at
///           different addresses), instead of unconditionally reporting
///           `msg.sender` and silently bypassing that check. The harness's
///           `_deliver` records the actual sender of the corresponding
///           `sendWarpMessage` here; for canonical-pair messengers managed
///           by the harness it instead reports the destination address (so
///           tests modelling correctly universal-deployed contracts pass).
///
/// @dev Admin (`_harness_*`) functions are gated to a single `harnessAddress`
///      set once via `_harness_init` (called automatically by
///      `FoundryWarpHarness` after etching this code at the precompile
///      address). Without gating, any contract under test could spoof
///      inflight warp messages or rewrite chain-ID assignments, defeating
///      the purpose of the harness as a fidelity layer.
contract MockWarpPrecompile is IWarpMessenger {
    /// @dev message captured from sendWarpMessage
    struct Queued {
        address sender; // who called sendWarpMessage (e.g. source TeleporterMessenger)
        bytes32 sourceChainID;
        bytes payload; // raw bytes — for Teleporter, this is the encoded TeleporterMessage
        bool delivered;
    }

    /// @dev message currently staged for the next getVerifiedWarpMessage call
    struct Inflight {
        bool set;
        bytes32 sourceChainID;
        address originSenderAddress; // address to report to the destination as the source
        bytes payload;
    }

    /// @notice The harness contract permitted to invoke `_harness_*` admin
    ///         functions. Set once via `_harness_init` immediately after the
    ///         mock bytecode is etched at the canonical precompile address.
    /// @dev    Stored as a regular state slot so it survives the `vm.etch`
    ///         install: every chain's contracts call into this code with their
    ///         own `msg.sender`, but only the harness can mutate the mock.
    address public harnessAddress;

    mapping(address => bytes32) public chainIdOf; // sender -> chain id (used after deploy)
    bytes32 public currentDeployChain; // fallback during deploy when msg.sender not yet registered
    Queued[] public queue;
    Inflight internal _inflight;

    /// @dev Restricts a function to the harness contract registered via
    ///      `_harness_init`. All `_harness_*` admin entrypoints use this
    ///      modifier to prevent contracts under test from spoofing chain
    ///      assignments or inflight warp messages.
    modifier onlyHarness() {
        require(msg.sender == harnessAddress, "MockWarpPrecompile: not harness");
        _;
    }

    // ------ harness administration (only callable by the registered harness) ------

    /// @notice One-shot initialization that binds this mock to the harness
    ///         contract managing it. After this call, only `harness_` may
    ///         invoke `_harness_*` admin entrypoints.
    /// @dev    Callable exactly once. `FoundryWarpHarness` calls this from its
    ///         constructor immediately after etching the mock bytecode at the
    ///         canonical precompile address.
    function _harness_init(address harness_) external {
        require(harnessAddress == address(0), "MockWarpPrecompile: already initialised");
        require(harness_ != address(0), "MockWarpPrecompile: zero harness");
        harnessAddress = harness_;
    }

    function _harness_setChainId(address sender, bytes32 chainId) external onlyHarness {
        chainIdOf[sender] = chainId;
    }

    function _harness_setCurrentDeployChain(bytes32 chainId) external onlyHarness {
        currentDeployChain = chainId;
    }

    /// @notice Stage a message for the next `getVerifiedWarpMessage` call.
    /// @dev    The harness records the address that should be reported as
    ///         `originSenderAddress` to the destination. The honest choice
    ///         is the actual `sendWarpMessage` caller; the harness uses this
    ///         hook to faithfully surface universal-deployer mismatches
    ///         instead of unconditionally reporting `msg.sender` (which
    ///         would always equal the destination, hiding real bugs).
    function _harness_stageInflight(
        bytes32 sourceChainID,
        address originSenderAddress,
        bytes calldata payload
    ) external onlyHarness {
        _inflight = Inflight({
            set: true,
            sourceChainID: sourceChainID,
            originSenderAddress: originSenderAddress,
            payload: payload
        });
    }

    function _harness_clearInflight() external onlyHarness {
        delete _inflight;
    }

    function _harness_queueLength() external view returns (uint256) {
        return queue.length;
    }

    function _harness_markDelivered(uint256 idx) external onlyHarness {
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

    /// @notice Returns the inflight message that was staged immediately before
    ///         the harness invoked `receiveCrossChainMessage` on the
    ///         destination messenger.
    /// @dev    The reported `originSenderAddress` is whatever the harness
    ///         passed to `_harness_stageInflight` — NOT `msg.sender`. Reading
    ///         `msg.sender` would always equal the destination messenger and
    ///         silently bypass Teleporter's universal-deployer self-check,
    ///         masking real bugs in test setups where source/destination
    ///         messengers are deployed at different addresses.
    function getVerifiedWarpMessage(
        uint32 /* index */
    ) external view override returns (WarpMessage memory message, bool valid) {
        if (!_inflight.set) {
            return (WarpMessage({sourceChainID: bytes32(0), originSenderAddress: address(0), payload: ""}), false);
        }
        message = WarpMessage({
            sourceChainID: _inflight.sourceChainID,
            originSenderAddress: _inflight.originSenderAddress,
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
