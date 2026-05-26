// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// =============================================================================
//  FeeMessage.t.sol — ICM with NON-ZERO relayer fee
// -----------------------------------------------------------------------------
//  This test exercises the fee-bearing path of Teleporter end-to-end:
//    1. A `FeeMessage` contract on Chain A pulls `feeAmount` ERC-20 tokens
//       from the user, approves the local TeleporterMessenger for them, then
//       calls `sendCrossChainMessage` with a non-zero `feeInfo`.
//    2. Teleporter performs a real `safeTransferFrom`, debiting the
//       FeeMessage contract and crediting the messenger.
//    3. The harness relays the message to Chain B, which writes a delivery
//       receipt into its outbound queue for Chain A.
//    4. A second, zero-fee message from B → A is sent so the receipt for
//       step 3 piggybacks back to Chain A.
//    5. When Chain A processes that receipt via `_markReceipt`, the
//       relayer-reward credit lands on the harness (the address it passes
//       as `relayerRewardAddress` to `receiveCrossChainMessage`).
//    6. The harness calls `redeemRelayerRewards`, draining its credit.
//
//  Why a round-trip? Real Teleporter pays the relayer only AFTER it can
//  prove delivery, via a receipt that travels in the opposite direction.
//  Zero-fee tests skip this entire dance — extending coverage here means
//  the harness is exercised against the same fee accounting code that runs
//  on tmpnet and mainnet.
// =============================================================================

import {Test, console2} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {TeleporterRegistry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";
import {TeleporterMessageInput, TeleporterFeeInfo} from "@teleporter/ITeleporterMessenger.sol";

import {DemoERC20} from "../../../src/examples/ictt-erc20/DemoERC20.sol";
import {FeeMessage} from "../../../src/examples/icm-basics/FeeMessage.sol";
import {SimpleReceiver} from "../../../src/examples/icm-basics/SimpleReceiver.sol";

contract FeeMessageTest is Test {
    bytes32 constant CHAIN_A = bytes32(uint256(0xA));
    bytes32 constant CHAIN_B = bytes32(uint256(0xB));

    FoundryWarpHarness harness;

    TeleporterRegistry regA;
    TeleporterMessenger msgrA;
    TeleporterRegistry regB;
    TeleporterMessenger msgrB;

    DemoERC20 feeToken;
    FeeMessage sender;
    SimpleReceiver receiver;

    address user = makeAddr("user");

    /// @dev Fee paid per message. Picked to be small enough to fit inside the
    ///      DemoERC20 starting supply but large enough that any rounding or
    ///      decimal mishap would be obvious.
    uint256 constant FEE_AMOUNT = 1_000 * 1e18;

    function setUp() public {
        harness = new FoundryWarpHarness();
        (regA, msgrA) = harness.deployChain(CHAIN_A);
        (regB, msgrB) = harness.deployChain(CHAIN_B);

        // Fee token lives on Chain A — same chain as the sender that pays it.
        // We don't bridge it; this test is about Teleporter fee accounting,
        // not ICTT.
        harness.startDeploy(CHAIN_A);
        feeToken = new DemoERC20("Fee Token", "FEE", 18);
        harness.endDeploy();
        vm.label(address(feeToken), "FeeToken");

        harness.startDeploy(CHAIN_A);
        sender = new FeeMessage(address(msgrA), address(feeToken));
        harness.endDeploy();
        harness.pinChain(address(sender), CHAIN_A);
        vm.label(address(sender), "FeeMessage-Sender");

        harness.startDeploy(CHAIN_B);
        receiver = new SimpleReceiver(address(regB), 1);
        harness.endDeploy();
        harness.pinChain(address(receiver), CHAIN_B);
        vm.label(address(receiver), "SimpleReceiver");
    }

    /// @notice Happy path: a fee-paying message moves tokens out of the
    ///         sender, the message reaches the receiver, and a return
    ///         receipt accrues the fee to the harness as relayer reward.
    function test_feePayingMessage_accruesRelayerRewards() public {
        // ---- 1. Fund the user with fee tokens and approve the sender ----
        feeToken.mint(user, FEE_AMOUNT);
        assertEq(feeToken.balanceOf(user), FEE_AMOUNT, "user funded");

        vm.prank(user);
        feeToken.approve(address(sender), FEE_AMOUNT);

        // ---- 2. Snapshot balances pre-send ----
        uint256 userBalBefore = feeToken.balanceOf(user);
        uint256 senderBalBefore = feeToken.balanceOf(address(sender));
        uint256 msgrABalBefore = feeToken.balanceOf(address(msgrA));

        // ---- 3. Send a fee-paying message A -> B ----
        vm.prank(user);
        bytes32 messageID = sender.sendMessage(CHAIN_B, address(receiver), FEE_AMOUNT, "paid hello");
        assertTrue(messageID != bytes32(0), "messageID nonzero");

        // The fee tokens have moved: user -> sender -> messenger.
        // After the chain of safeTransferFroms, the user is empty, the sender
        // is empty, and the messenger holds the fee.
        assertEq(feeToken.balanceOf(user), userBalBefore - FEE_AMOUNT, "user paid the fee");
        assertEq(feeToken.balanceOf(address(sender)), senderBalBefore, "sender holds no residual");
        assertEq(feeToken.balanceOf(address(msgrA)), msgrABalBefore + FEE_AMOUNT, "messenger holds the fee");

        // Teleporter recorded the fee for this messageID.
        (address recordedToken, uint256 recordedAmount) = msgrA.getFeeInfo(messageID);
        assertEq(recordedToken, address(feeToken), "fee token recorded");
        assertEq(recordedAmount, FEE_AMOUNT, "fee amount recorded");

        // ---- 4. Relay A -> B; receipt is enqueued on B's side ----
        uint256 deliveredAtoB = harness.relayAll();
        assertEq(deliveredAtoB, 1, "A->B delivered");
        assertEq(receiver.latestMessage(), "paid hello", "receiver got the message");

        // Sanity: harness has no reward credit yet — the receipt hasn't
        // travelled back to A.
        assertEq(
            msgrA.checkRelayerRewardAmount(address(harness), address(feeToken)),
            0,
            "no reward before receipt return"
        );

        // ---- 5. Send a zero-fee B -> A message so the A-side receipt
        //         piggybacks back to A and triggers reward accrual ----
        TeleporterMessageInput memory ackInput = TeleporterMessageInput({
            destinationBlockchainID: CHAIN_A,
            destinationAddress: address(0xdEaD), // no real receiver — message just carries the receipt
            feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
            requiredGasLimit: 200_000,
            allowedRelayerAddresses: new address[](0),
            message: bytes("ack")
        });
        msgrB.sendCrossChainMessage(ackInput);

        // ---- 6. Relay B -> A; A processes the receipt for messageID
        //         (the call into the unwired 0xdEaD destination is allowed
        //         to fail — Teleporter still markReceipt's the embedded
        //         receipt before invoking the destination handler) ----
        uint256 deliveredBtoA = harness.relayAll();
        assertEq(deliveredBtoA, 1, "B->A delivered (carrying receipt)");

        // ---- 7. Reward accrued to the harness (acting as relayer) ----
        uint256 reward = msgrA.checkRelayerRewardAmount(address(harness), address(feeToken));
        assertEq(reward, FEE_AMOUNT, "harness credited full fee as relayer reward");

        // ---- 8. Redeem and verify the ERC-20 actually transfers ----
        uint256 harnessBalBefore = feeToken.balanceOf(address(harness));
        vm.prank(address(harness));
        msgrA.redeemRelayerRewards(address(feeToken));
        assertEq(
            feeToken.balanceOf(address(harness)),
            harnessBalBefore + FEE_AMOUNT,
            "harness received the fee tokens"
        );
        // Reward credit zeroed after redemption.
        assertEq(msgrA.checkRelayerRewardAmount(address(harness), address(feeToken)), 0, "credit drained");
    }
}
