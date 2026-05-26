// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  SimpleMessage.t.sol — ICM Basics round-trip tests
// -----------------------------------------------------------------------------
//  These tests exercise the SimpleSender / SimpleReceiver pair against the
//  REAL `TeleporterMessenger` from `icm-contracts`. The FoundryWarpHarness
//  stands in for what the off-chain relayer + Warp precompile would do on a
//  live network:
//    - It deploys a Teleporter stack per simulated chain.
//    - It mocks the Warp precompile so messages are queued in-EVM.
//    - `harness.relayAll()` flushes the queue and delivers every queued
//       message to its destination's TeleporterMessenger.
//
//  The high-level flow each test follows:
//    1. setUp deploys two "chains" (A and B), each with their own
//       TeleporterRegistry + TeleporterMessenger.
//    2. SimpleSender is deployed on Chain A, wired to A's messenger.
//    3. SimpleReceiver is deployed on Chain B, wired to B's registry.
//    4. The test calls `sender.sendMessage(...)` and then `harness.relayAll()`
//       to simulate the relayer delivering the message.
//    5. Assertions check receiver state.
// =============================================================================

import {Test, console2} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {TeleporterRegistry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";

import {SimpleSender} from "../../../src/examples/icm-basics/SimpleSender.sol";
import {SimpleReceiver} from "../../../src/examples/icm-basics/SimpleReceiver.sol";

contract SimpleMessageTest is Test {
    // Arbitrary chain IDs — any non-zero, distinct bytes32 values work for tests.
    bytes32 constant CHAIN_A = bytes32(uint256(0xA));
    bytes32 constant CHAIN_B = bytes32(uint256(0xB));

    FoundryWarpHarness harness;

    TeleporterRegistry regA;
    TeleporterMessenger msgrA;
    TeleporterRegistry regB;
    TeleporterMessenger msgrB;

    SimpleSender sender;
    SimpleReceiver receiver;

    address user = makeAddr("user");

    function setUp() public {
        // 1) Spin up the harness and two simulated chains.
        harness = new FoundryWarpHarness();
        (regA, msgrA) = harness.deployChain(CHAIN_A);
        (regB, msgrB) = harness.deployChain(CHAIN_B);

        // 2) Deploy SimpleSender on Chain A. The harness's startDeploy/endDeploy
        //    pair tells the mocked Warp precompile "any getBlockchainID() call
        //    during this constructor should return CHAIN_A". SimpleSender
        //    doesn't actually query Warp in its ctor, but doing this is the
        //    pattern for any contract that might (and is harmless if it doesn't).
        harness.startDeploy(CHAIN_A);
        sender = new SimpleSender(address(msgrA));
        harness.endDeploy();
        harness.pinChain(address(sender), CHAIN_A);
        vm.label(address(sender), "SimpleSender");

        // 3) Deploy SimpleReceiver on Chain B, wired to Chain B's registry.
        harness.startDeploy(CHAIN_B);
        receiver = new SimpleReceiver(address(regB), 1);
        harness.endDeploy();
        harness.pinChain(address(receiver), CHAIN_B);
        vm.label(address(receiver), "SimpleReceiver");
    }

    // -------------------------------------------------------------------------
    //  Test 1 — happy path: one message, A -> B, asserted on B.
    // -------------------------------------------------------------------------
    function test_sendAndReceive_happyPath() public {
        string memory greeting = "Hello, Avalanche!";

        // Send from Chain A. Under the hood SimpleSender hands the message to
        // msgrA which queues it inside the mocked Warp precompile.
        bytes32 messageID = sender.sendMessage(CHAIN_B, address(receiver), greeting);
        assertTrue(messageID != bytes32(0), "messageID should be nonzero");

        // Drain the queue — this is the harness equivalent of a relayer.
        uint256 delivered = harness.relayAll();
        assertEq(delivered, 1, "exactly one message delivered");

        // Verify receiver state.
        assertEq(receiver.latestMessage(), greeting, "latest string mismatch");
        assertEq(receiver.latestSourceBlockchainID(), CHAIN_A, "source chain mismatch");
        assertEq(receiver.historyLength(), 1, "history length");
        assertEq(receiver.getMessage(0), greeting, "history[0] mismatch");
    }

    // -------------------------------------------------------------------------
    //  Test 2 — originSenderAddress is the EOA that called sender, not the
    //  sender contract itself? Actually: per Teleporter semantics, the
    //  `originSenderAddress` is the `msg.sender` of `sendCrossChainMessage`
    //  on the source chain. Since SimpleSender calls Teleporter, the origin
    //  sender is the SimpleSender CONTRACT, not the user. We assert that
    //  to make the semantics explicit (and catch any future misunderstanding).
    // -------------------------------------------------------------------------
    function test_originSenderAddress_isSenderContract() public {
        vm.prank(user); // user calls SimpleSender, but...
        sender.sendMessage(CHAIN_B, address(receiver), "who am i?");
        harness.relayAll();

        // ...Teleporter records the *immediate caller* of sendCrossChainMessage,
        // which is the SimpleSender contract itself. This is important: any
        // access control on the destination must trust the sender CONTRACT,
        // not the original EOA.
        assertEq(
            receiver.latestOriginSenderAddress(),
            address(sender),
            "originSenderAddress should be the SimpleSender contract"
        );
        assertTrue(receiver.latestOriginSenderAddress() != user, "originSenderAddress is NOT the EOA");
    }

    // -------------------------------------------------------------------------
    //  Test 3 — multiple messages, delivered in order, history is preserved.
    // -------------------------------------------------------------------------
    function test_multipleMessages_preserveOrderAndHistory() public {
        string[3] memory messages = ["first", "second", "third"];

        // Send all three in one transaction's worth of calls. The harness
        // queues them up; relayAll drains them in FIFO order.
        for (uint256 i = 0; i < messages.length; i++) {
            sender.sendMessage(CHAIN_B, address(receiver), messages[i]);
        }

        uint256 delivered = harness.relayAll();
        assertEq(delivered, 3, "three messages delivered");

        // Latest reflects the LAST send.
        assertEq(receiver.latestMessage(), "third", "latest = third");

        // History was appended in order.
        assertEq(receiver.historyLength(), 3, "history length");
        assertEq(receiver.getMessage(0), "first");
        assertEq(receiver.getMessage(1), "second");
        assertEq(receiver.getMessage(2), "third");
    }
}
