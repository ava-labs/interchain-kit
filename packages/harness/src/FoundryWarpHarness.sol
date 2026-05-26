// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";

import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";
import {ITeleporterMessenger, TeleporterMessage} from "@teleporter/ITeleporterMessenger.sol";
import {TeleporterRegistry, ProtocolRegistryEntry} from "@teleporter/registry/TeleporterRegistry.sol";

import {MockWarpPrecompile} from "./MockWarpPrecompile.sol";

/// @title FoundryWarpHarness
/// @notice In-EVM cross-chain harness for testing real ICM/ICTT contracts in Foundry.
///
/// Usage:
/// ```solidity
/// FoundryWarpHarness harness = new FoundryWarpHarness();
/// (TeleporterRegistry regC, TeleporterMessenger msgrC) = harness.deployChain(C_CHAIN_ID);
/// (TeleporterRegistry regL1, TeleporterMessenger msgrL1) = harness.deployChain(L1_CHAIN_ID);
///
/// ERC20TokenHome home = new ERC20TokenHome(address(regC), admin, 1, address(usdc), 6);
/// ERC20TokenRemote remote = new ERC20TokenRemote(...settings using regL1...);
///
/// remote.registerWithHome(feeInfo);
/// harness.relayAll();                  // delivers register message C->L1 (well, L1->C)
/// home.addCollateral(...);             // collateralize
/// home.send(input, amount);            // emits warp message
/// harness.relayAll();                  // delivers
/// assertEq(wrappedToken.balanceOf(recipient), amount);
/// ```
///
/// Internals: deploys one `MockWarpPrecompile` instance once, then etches its
/// bytecode at the canonical precompile address (`0x...05`) so all unmodified
/// ICM contracts hit our mock. Each `deployChain` deploys a real
/// `TeleporterMessenger` + `TeleporterRegistry` and registers the chain-id <->
/// messenger mapping with the mock precompile.
///
/// ## Universal-deployer fidelity
///
/// On a real Avalanche network every L1 deploys `TeleporterMessenger` at the
/// SAME canonical address (Nick's-method universal deployment). The
/// `receiveCrossChainMessage` flow asserts
/// `warpMessage.originSenderAddress == address(this)`, trusting that the same
/// bytecode signed the message.
///
/// In a single EVM we cannot truly co-locate two messenger instances at the
/// same address with disjoint storage. The harness instead:
///   1. Records the actual source messenger in the mock's inflight info.
///   2. Treats messengers it deployed itself via `deployChain` as a CANONICAL
///      PAIR — for deliveries between them the mock is told to report the
///      destination's own address, faithfully modelling what a real
///      universally-deployed pair would attest.
///   3. For sources NOT deployed by `deployChain` (e.g. raw
///      `new TeleporterMessenger()` outside the harness), the mock reports
///      the actual source address. Teleporter's self-check then reverts
///      with `"invalid origin sender address"`, exactly as it would on
///      tmpnet / mainnet when a developer skips the universal-deployer
///      pattern.
contract FoundryWarpHarness {
    address public constant WARP_PRECOMPILE = 0x0200000000000000000000000000000000000005;

    // forge-std cheatcode VM
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockWarpPrecompile public mock;

    struct Chain {
        bytes32 chainId;
        TeleporterRegistry registry;
        TeleporterMessenger messenger;
    }

    mapping(bytes32 => Chain) public chains;
    mapping(address => bytes32) public chainIdOfMessenger;
    /// @dev Messengers deployed via `deployChain`. The harness treats these as
    ///      a canonical universally-deployed pair: deliveries originating
    ///      from any of them satisfy the destination's self-check. Sends
    ///      that originate from a messenger NOT in this set propagate the
    ///      true sender to the destination and therefore revert at the
    ///      universal-deployer check — matching real-network behaviour.
    mapping(address => bool) public canonicalMessenger;

    uint256 public deliveredCursor; // next index in the mock's queue to attempt

    constructor() {
        // 1. Deploy a "template" MockWarpPrecompile, then etch its bytecode at
        //    the canonical precompile address. We keep a separate state-bearing
        //    instance at WARP_PRECOMPILE — the etched code reads from its own
        //    storage there.
        MockWarpPrecompile template = new MockWarpPrecompile();
        vm.etch(WARP_PRECOMPILE, address(template).code);
        mock = MockWarpPrecompile(WARP_PRECOMPILE);
        // 2. Claim ownership of the etched mock so only this harness can call
        //    `_harness_*` admin functions on it. Without this gate, any
        //    contract under test could spoof inflight warp messages or
        //    rewrite chain assignments.
        mock._harness_init(address(this));
        vm.label(WARP_PRECOMPILE, "WARP_PRECOMPILE");
    }

    /// @notice Deploy a Teleporter stack representing a new chain identified by `chainId`.
    function deployChain(bytes32 chainId)
        external
        returns (TeleporterRegistry registry, TeleporterMessenger messenger)
    {
        require(chains[chainId].chainId == bytes32(0), "harness: chain already deployed");

        // Stage chainId as the deploy-time fallback. Any contract whose constructor
        // calls getBlockchainID (TeleporterRegistry, ERC20TokenHome, ERC20TokenRemote
        // via TeleporterUpgradeable init, etc.) will resolve to chainId.
        mock._harness_setCurrentDeployChain(chainId);

        messenger = new TeleporterMessenger();
        // Pin the messenger's chainId permanently so subsequent send/receive
        // calls (which may happen after the deploy-chain is unset) still resolve.
        mock._harness_setChainId(address(messenger), chainId);

        ProtocolRegistryEntry[] memory initial = new ProtocolRegistryEntry[](1);
        initial[0] = ProtocolRegistryEntry({version: 1, protocolAddress: address(messenger)});
        registry = new TeleporterRegistry(initial);
        // Registry doesn't re-query at runtime, but pin anyway for clarity.
        mock._harness_setChainId(address(registry), chainId);

        mock._harness_setCurrentDeployChain(bytes32(0));

        chains[chainId] = Chain({chainId: chainId, registry: registry, messenger: messenger});
        chainIdOfMessenger[address(messenger)] = chainId;
        canonicalMessenger[address(messenger)] = true;

        vm.label(address(registry), _label("Registry-", chainId));
        vm.label(address(messenger), _label("Messenger-", chainId));
    }

    /// @notice Stage a deploy-chain context for inline deploys outside `deployChain`
    ///         (e.g. user-app contracts whose constructors call getBlockchainID).
    ///         Pair with `endDeploy()`.
    function startDeploy(bytes32 chainId) external {
        mock._harness_setCurrentDeployChain(chainId);
    }

    function endDeploy() external {
        mock._harness_setCurrentDeployChain(bytes32(0));
    }

    /// @notice Pin a chainId for a specific address (e.g. an ICTT contract after deploy).
    ///         Optional — only needed if the contract queries getBlockchainID at runtime
    ///         (most cache it during init and don't re-query).
    function pinChain(address who, bytes32 chainId) external {
        mock._harness_setChainId(who, chainId);
    }

    /// @notice Drain the queue: deliver every message that has not yet been
    ///         delivered. Returns the number of messages delivered.
    /// @dev    Re-reads the queue length on every iteration so that messages
    ///         enqueued DURING delivery (e.g. a receiver that sends a reply
    ///         from inside `receiveTeleporterMessage`) are picked up in the
    ///         same call.
    function relayAll() external returns (uint256 delivered) {
        uint256 i = deliveredCursor;
        while (i < mock._harness_queueLength()) {
            MockWarpPrecompile.Queued memory q = mock._harness_getQueued(i);
            if (!q.delivered) {
                _deliver(i, q);
                delivered++;
            }
            unchecked {
                i++;
            }
        }
        deliveredCursor = i;
    }

    function _deliver(uint256 idx, MockWarpPrecompile.Queued memory q) internal {
        // Decode the TeleporterMessage from the queued payload to learn the destination
        TeleporterMessage memory tm = abi.decode(q.payload, (TeleporterMessage));
        Chain memory dest = chains[tm.destinationBlockchainID];
        require(dest.chainId != bytes32(0), "harness: unknown destination chain");

        // Decide what address to report as `originSenderAddress` to the
        // destination. For a CANONICAL pair (both messengers deployed via
        // `deployChain`), report the destination's own address — that
        // matches what a real universally-deployed pair would attest, and
        // lets Teleporter's `originSenderAddress == address(this)` check
        // pass. For any other source (e.g. a raw
        // `new TeleporterMessenger()` someone deployed outside the harness),
        // report the ACTUAL sender so the check reverts exactly as it would
        // on tmpnet / mainnet. This is the deliberate fidelity guarantee
        // surfaced by Gap 1 of the post-audit cleanup.
        address reportedOrigin =
            canonicalMessenger[q.sender] ? address(dest.messenger) : q.sender;

        mock._harness_stageInflight(q.sourceChainID, reportedOrigin, q.payload);
        // messageIndex argument is unused by our mock — it always returns the inflight
        dest.messenger.receiveCrossChainMessage(uint32(idx), address(this));
        mock._harness_clearInflight();
        mock._harness_markDelivered(idx);
    }

    // ------ small utilities ------

    function _label(string memory prefix, bytes32 chainId) internal pure returns (string memory) {
        return string.concat(prefix, _short(chainId));
    }

    function _short(bytes32 v) internal pure returns (string memory) {
        bytes memory s = new bytes(6);
        bytes16 hexChars = 0x30313233343536373839616263646566; // "0123456789abcdef"
        s[0] = "0";
        s[1] = "x";
        s[2] = hexChars[uint8(v[0]) >> 4];
        s[3] = hexChars[uint8(v[0]) & 0xf];
        s[4] = hexChars[uint8(v[1]) >> 4];
        s[5] = hexChars[uint8(v[1]) & 0xf];
        return string(s);
    }
}
