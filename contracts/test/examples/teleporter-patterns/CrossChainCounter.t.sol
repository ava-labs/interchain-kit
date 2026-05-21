// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test, console2} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {TeleporterRegistry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";

import {CrossChainCounter} from "../../../src/examples/teleporter-patterns/CrossChainCounter.sol";

/// @notice Exercises cross-chain state mutation:
///   - increment from A -> B and assert B grew, A didn't.
///   - increment from B -> A and assert A grew.
///   - queue a batch of 5 increments before relayAll and assert they all land.
contract CrossChainCounterTest is Test {
    bytes32 constant CHAIN_A = bytes32(uint256(0xA1));
    bytes32 constant CHAIN_B = bytes32(uint256(0xB1));

    FoundryWarpHarness harness;
    TeleporterMessenger msgrA;
    TeleporterMessenger msgrB;

    CrossChainCounter counterA;
    CrossChainCounter counterB;

    function setUp() public {
        harness = new FoundryWarpHarness();
        (, msgrA) = harness.deployChain(CHAIN_A);
        (, msgrB) = harness.deployChain(CHAIN_B);

        harness.startDeploy(CHAIN_A);
        counterA = new CrossChainCounter(address(msgrA));
        harness.endDeploy();
        harness.pinChain(address(counterA), CHAIN_A);
        vm.label(address(counterA), "Counter-A");

        harness.startDeploy(CHAIN_B);
        counterB = new CrossChainCounter(address(msgrB));
        harness.endDeploy();
        harness.pinChain(address(counterB), CHAIN_B);
        vm.label(address(counterB), "Counter-B");

        // Wire each side to recognize the other.
        counterA.setPeer(CHAIN_B, address(counterB));
        counterB.setPeer(CHAIN_A, address(counterA));
    }

    function test_increment_A_to_B() public {
        assertEq(counterA.value(), 0);
        assertEq(counterB.value(), 0);

        counterA.incrementRemote(CHAIN_B, 1);
        uint256 delivered = harness.relayAll();
        assertEq(delivered, 1, "one message delivered A->B");

        // B grew, A did not (incrementRemote does NOT touch local state).
        assertEq(counterB.value(), 1, "B incremented");
        assertEq(counterA.value(), 0, "A unchanged");
    }

    function test_increment_B_to_A() public {
        counterB.incrementRemote(CHAIN_A, 1);
        uint256 delivered = harness.relayAll();
        assertEq(delivered, 1, "one message delivered B->A");

        assertEq(counterA.value(), 1, "A incremented");
        assertEq(counterB.value(), 0, "B unchanged");
    }

    function test_batched_increments_A_to_B() public {
        // Queue five outbound messages BEFORE relaying any of them, then
        // drain the whole batch in a single relayAll().
        for (uint256 i = 0; i < 5; i++) {
            counterA.incrementRemote(CHAIN_B, 1);
        }

        uint256 delivered = harness.relayAll();
        assertEq(delivered, 5, "five messages delivered in one batch");
        assertEq(counterB.value(), 5, "B incremented five times");
        assertEq(counterA.value(), 0, "A still untouched");
    }

    function test_increment_amount_is_honored() public {
        // The payload carries the amount, not just a "+1" signal.
        counterA.incrementRemote(CHAIN_B, 7);
        counterA.incrementRemote(CHAIN_B, 13);
        harness.relayAll();
        assertEq(counterB.value(), 20, "amounts summed on remote");
    }

    function test_rejects_unconfigured_destination() public {
        bytes32 ghostChain = bytes32(uint256(0xDEAD));
        vm.expectRevert(bytes("CrossChainCounter: peer not set"));
        counterA.incrementRemote(ghostChain, 1);
    }
}
