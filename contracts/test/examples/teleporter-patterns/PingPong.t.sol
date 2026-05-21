// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test, console2} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {TeleporterRegistry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";

import {PingPong} from "../../../src/examples/teleporter-patterns/PingPong.sol";

/// @notice Demonstrates a request/reply round-trip:
///   1. Deploy PingPong on Chain A and Chain B.
///   2. Configure each as the other's peer.
///   3. Call `ping` on A.
///   4. harness.relayAll() delivers A->B, which spawns a B->A reply. The same
///      call to relayAll() drains that reply too because the harness loops
///      over the live queue length.
///   5. Assert A has a recorded Pong with the matching nonce.
contract PingPongTest is Test {
    bytes32 constant CHAIN_A = bytes32(uint256(0xA1));
    bytes32 constant CHAIN_B = bytes32(uint256(0xB1));

    FoundryWarpHarness harness;
    TeleporterMessenger msgrA;
    TeleporterMessenger msgrB;

    PingPong pingPongA;
    PingPong pingPongB;

    function setUp() public {
        harness = new FoundryWarpHarness();
        (, msgrA) = harness.deployChain(CHAIN_A);
        (, msgrB) = harness.deployChain(CHAIN_B);

        // Deploy the receiver-capable contract on each chain. We wrap each
        // deploy with startDeploy/endDeploy so any constructor-time warp queries
        // resolve to the right chainId — PingPong itself doesn't make any, but
        // wrapping is cheap and matches the canonical pattern used elsewhere.
        harness.startDeploy(CHAIN_A);
        pingPongA = new PingPong(address(msgrA));
        harness.endDeploy();
        harness.pinChain(address(pingPongA), CHAIN_A);
        vm.label(address(pingPongA), "PingPong-A");

        harness.startDeploy(CHAIN_B);
        pingPongB = new PingPong(address(msgrB));
        harness.endDeploy();
        harness.pinChain(address(pingPongB), CHAIN_B);
        vm.label(address(pingPongB), "PingPong-B");

        // Each side trusts the other.
        pingPongA.setPeer(CHAIN_B, address(pingPongB));
        pingPongB.setPeer(CHAIN_A, address(pingPongA));
    }

    function test_ping_triggers_pong_reply() public {
        uint256 nonce = 42;

        // Pre-conditions.
        assertEq(pingPongA.pongsReceived(), 0, "no pongs yet on A");
        assertEq(pingPongB.pingsReceived(), 0, "no pings yet on B");

        // Fire a ping on A.
        pingPongA.ping(nonce);

        // One message in flight: A -> B (the ping). When the harness delivers
        // it, B's receiveTeleporterMessage will SYNCHRONOUSLY enqueue a second
        // message B -> A (the pong). relayAll() loops over the current queue
        // length each iteration, so it picks up that reply in the same call.
        uint256 delivered = harness.relayAll();
        console2.log("Messages delivered:", delivered);
        assertEq(delivered, 2, "ping + pong both delivered");

        // Post-conditions: B saw the ping, A saw the matching pong.
        assertEq(pingPongB.pingsReceived(), 1, "B recorded one ping");
        assertEq(pingPongA.pongsReceived(), 1, "A recorded one pong");
        assertEq(pingPongA.lastPongNonce(), nonce, "pong nonce matches request");
    }

    function test_multiple_pings_yield_multiple_pongs() public {
        // Send three pings before relaying anything. All six messages
        // (3 pings + 3 pongs) should drain in a single relayAll call.
        pingPongA.ping(1);
        pingPongA.ping(2);
        pingPongA.ping(3);

        uint256 delivered = harness.relayAll();
        assertEq(delivered, 6, "3 pings + 3 pongs");
        assertEq(pingPongB.pingsReceived(), 3);
        assertEq(pingPongA.pongsReceived(), 3);
        // Last pong corresponds to the last ping.
        assertEq(pingPongA.lastPongNonce(), 3);
    }
}
