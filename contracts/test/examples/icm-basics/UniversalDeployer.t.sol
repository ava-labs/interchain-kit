// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  UniversalDeployer.t.sol — universal-deployer fidelity check
// -----------------------------------------------------------------------------
//  Teleporter enforces the universal-deployer pattern in
//  `TeleporterMessenger.receiveCrossChainMessage` with
//
//      require(
//          warpMessage.originSenderAddress == address(this),
//          "TeleporterMessenger: invalid origin sender address"
//      );
//
//  On a real Avalanche network the requirement is met automatically because
//  Nick's-method deployment yields the SAME messenger address on every L1.
//  A developer who deploys via a custom factory at different addresses on
//  different chains will trip this check at delivery time.
//
//  Earlier versions of `MockWarpPrecompile` returned `originSenderAddress =
//  msg.sender` (the destination messenger itself) unconditionally, which
//  meant the harness silently bypassed this check — tests would pass, then
//  the same setup would revert on tmpnet or mainnet.
//
//  This test pins the fidelity guarantee in place:
//    - Deploy TWO messengers OUTSIDE of `harness.deployChain`, guaranteeing
//      distinct addresses (and explicitly NOT marking them canonical).
//    - Stage an inflight message whose `originSenderAddress` is the actual
//      (and therefore wrong) source messenger.
//    - Call `receiveCrossChainMessage` on the destination messenger.
//    - Assert the universal-deployer revert.
//
//  We exercise the failure through the harness's public `relayAll` so the
//  whole pipeline (including the mock's `_harness_*` gating) is in scope.
// =============================================================================

import {Test} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {MockWarpPrecompile} from "@interchain-kit/harness/MockWarpPrecompile.sol";

import {TeleporterRegistry, ProtocolRegistryEntry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";
import {TeleporterMessageInput, TeleporterFeeInfo} from "@teleporter/ITeleporterMessenger.sol";

import {SimpleSender} from "../../../src/examples/icm-basics/SimpleSender.sol";
import {SimpleReceiver} from "../../../src/examples/icm-basics/SimpleReceiver.sol";

contract UniversalDeployerTest is Test {
    bytes32 constant CHAIN_A = bytes32(uint256(0xA));
    bytes32 constant CHAIN_B = bytes32(uint256(0xB));

    FoundryWarpHarness harness;
    MockWarpPrecompile mock;

    TeleporterRegistry regA;
    TeleporterMessenger msgrA;
    TeleporterRegistry regB;
    TeleporterMessenger msgrB;

    function setUp() public {
        harness = new FoundryWarpHarness();
        (regA, msgrA) = harness.deployChain(CHAIN_A);
        (regB, msgrB) = harness.deployChain(CHAIN_B);
        mock = harness.mock();
    }

    /// @notice With the harness's `deployChain`, both messengers are
    ///         registered as a canonical pair so the harness reports the
    ///         destination's own address as `originSenderAddress` — modelling
    ///         what a universally-deployed pair would attest. Delivery
    ///         succeeds.
    function test_canonicalPair_universalDeployerCheck_passes() public {
        // Sanity: both messengers were registered as canonical by deployChain.
        assertTrue(harness.canonicalMessenger(address(msgrA)));
        assertTrue(harness.canonicalMessenger(address(msgrB)));

        SimpleSender sender = new SimpleSender(address(msgrA));
        harness.pinChain(address(sender), CHAIN_A);

        SimpleReceiver receiver = new SimpleReceiver(address(regB), 1);
        harness.pinChain(address(receiver), CHAIN_B);

        bytes32 mid = sender.sendMessage(CHAIN_B, address(receiver), "ok");
        assertTrue(mid != bytes32(0));

        uint256 delivered = harness.relayAll();
        assertEq(delivered, 1, "canonical pair delivers");
        assertEq(receiver.latestMessage(), "ok");
    }

    /// @notice A messenger created OUTSIDE the harness (via `new
    ///         TeleporterMessenger()`) is at a different address and is NOT a
    ///         canonical pair with the harness-managed destination. The
    ///         harness reports the rogue's actual address as
    ///         `originSenderAddress`, and `receiveCrossChainMessage` reverts
    ///         exactly as it would on a real network where universal
    ///         deployment was skipped.
    function test_rogueSourceMessenger_universalDeployerCheck_reverts() public {
        // Deploy a rogue messenger that PRETENDS to live on CHAIN_A but at a
        // distinct address from the canonical msgrA. This is the scenario the
        // audit calls out: a developer with their own factory ending up at a
        // different EVM address on each chain.
        harness.startDeploy(CHAIN_A);
        TeleporterMessenger rogueMessenger = new TeleporterMessenger();
        harness.endDeploy();
        harness.pinChain(address(rogueMessenger), CHAIN_A);

        assertTrue(
            address(rogueMessenger) != address(msgrA),
            "rogue must be at a different address from canonical msgrA"
        );
        assertFalse(
            harness.canonicalMessenger(address(rogueMessenger)), "rogue was not deployed via deployChain"
        );

        // The rogue needs a registry on CHAIN_A that recognises it so
        // upstream code paths like `TeleporterRegistryApp` would work — not
        // used here, since we drive `sendCrossChainMessage` directly, but
        // wiring it makes the failure mode unambiguous.
        ProtocolRegistryEntry[] memory initial = new ProtocolRegistryEntry[](1);
        initial[0] = ProtocolRegistryEntry({version: 1, protocolAddress: address(rogueMessenger)});
        harness.startDeploy(CHAIN_A);
        new TeleporterRegistry(initial);
        harness.endDeploy();

        // A receiver on CHAIN_B that uses the canonical (harness-managed) registry.
        SimpleReceiver receiver = new SimpleReceiver(address(regB), 1);
        harness.pinChain(address(receiver), CHAIN_B);

        // Send from the rogue messenger directly. Anyone is allowed to invoke
        // `sendCrossChainMessage` — there's no whitelist. The message gets
        // queued in the mock with `sender = address(rogueMessenger)`.
        rogueMessenger.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: CHAIN_B,
                destinationAddress: address(receiver),
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: 300_000,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode("from a rogue")
            })
        );

        // Relaying should fail at the universal-deployer check inside msgrB,
        // because the harness honestly reports the rogue's address (not the
        // destination's). This is the fidelity guarantee.
        vm.expectRevert("TeleporterMessenger: invalid origin sender address");
        harness.relayAll();

        // Receiver state is untouched.
        assertEq(receiver.historyLength(), 0, "no message reached the receiver");
    }

    /// @notice Defence-in-depth: confirm the precompile's `_harness_*` admin
    ///         entrypoints reject calls from anyone but the harness, so a
    ///         contract under test cannot stage a fake inflight to bypass
    ///         the check above.
    function test_unauthorisedHarnessAdmin_reverts() public {
        // The test contract itself is not the harness.
        assertTrue(address(this) != address(harness));

        vm.expectRevert("MockWarpPrecompile: not harness");
        mock._harness_stageInflight(CHAIN_A, address(this), bytes(""));

        vm.expectRevert("MockWarpPrecompile: not harness");
        mock._harness_clearInflight();

        vm.expectRevert("MockWarpPrecompile: not harness");
        mock._harness_setChainId(address(this), CHAIN_A);

        vm.expectRevert("MockWarpPrecompile: not harness");
        mock._harness_setCurrentDeployChain(CHAIN_A);

        vm.expectRevert("MockWarpPrecompile: not harness");
        mock._harness_markDelivered(0);

        // _harness_init is one-shot and was claimed by the harness in its
        // constructor; a second call must revert too.
        vm.expectRevert("MockWarpPrecompile: already initialised");
        mock._harness_init(address(this));
    }
}
