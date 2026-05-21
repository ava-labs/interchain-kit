// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test, console2} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {TeleporterRegistry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";
import {TeleporterFeeInfo} from "@teleporter/ITeleporterMessenger.sol";

import {NativeTokenHome} from "@ictt/TokenHome/NativeTokenHome.sol";
import {NativeTokenRemote} from "@ictt/TokenRemote/NativeTokenRemote.sol";
import {TokenRemoteSettings} from "@ictt/TokenRemote/interfaces/ITokenRemote.sol";
import {SendTokensInput} from "@ictt/interfaces/ITokenTransferrer.sol";
import {WrappedNativeToken} from "@ictt/WrappedNativeToken.sol";

import {MockNativeMinter} from "../../../src/examples/ictt-native/NativeRoundTrip.sol";

/// @notice Round-trip test against unmodified `NativeTokenHome` / `NativeTokenRemote`
///         from `icm-contracts`. The FoundryWarpHarness shuttles every real warp
///         message between two chains living in the same EVM.
///
/// Mental model:
///   - Chain A ("Home L1"): a chain whose native token is AVAX. `NativeTokenHome`
///     wraps inbound AVAX into a WAVAX-style ERC20 and locks it; outbound AVAX
///     on the other chain is *minted natively* by the corresponding remote.
///   - Chain B ("Remote L1"): a chain whose native token IS the bridged AVAX —
///     `NativeTokenRemote` is both an `IWrappedNativeToken` (ERC20 wrapper) AND
///     the mint/burn authority for the chain's native gas token via the
///     NativeMinter precompile (mocked here).
///
/// Flow exercised by `test_full_roundtrip_home_to_remote_and_back`:
///   1. Deploy two chains (HOME, REMOTE) via harness.
///   2. Deploy `WrappedNativeToken` + `NativeTokenHome` on HOME.
///   3. Deploy `NativeTokenRemote` on REMOTE with a non-zero initialReserveImbalance.
///   4. remote.registerWithHome(...)            -> harness relays REMOTE->HOME
///   5. home.addCollateral{value: reserve}(...) -> records collateral locally
///   6. home.send{value: amount}(...)           -> harness relays HOME->REMOTE
///      => native minted to recipient on REMOTE, remote becomes collateralized
///   7. remote.send{value: returnAmount}(...)   -> harness relays REMOTE->HOME
///      => WAVAX unwrapped & AVAX returned to recipient on HOME
contract NativeRoundTrip is Test {
    bytes32 constant HOME_CHAIN = bytes32(uint256(0xA1));
    bytes32 constant REMOTE_CHAIN = bytes32(uint256(0xB1));

    /// @notice Subnet-EVM's canonical NativeMinter precompile address.
    address constant NATIVE_MINTER_PRECOMPILE = 0x0200000000000000000000000000000000000001;

    /// @notice Initial reserve imbalance: the amount of "native supply" the remote
    ///         chain genesis-allocates BEFORE any collateral is locked on the home.
    ///         The home must lock this much WAVAX before the remote is considered
    ///         collateralized and able to send tokens back.
    uint256 constant INITIAL_RESERVE_IMBALANCE = 100 ether;

    FoundryWarpHarness harness;
    TeleporterRegistry regHome;
    TeleporterMessenger msgrHome;
    TeleporterRegistry regRemote;
    TeleporterMessenger msgrRemote;

    WrappedNativeToken wavax; // WAVAX on the home chain
    NativeTokenHome home;
    NativeTokenRemote remote;

    address admin = makeAddr("admin");
    address sender = makeAddr("sender"); // pays AVAX on HOME to bridge to REMOTE
    address recipient = makeAddr("recipient"); // receives native gas on REMOTE
    address backHome = makeAddr("backHome"); // receives unwrapped AVAX on HOME

    function setUp() public {
        // -------- harness & two chains --------
        harness = new FoundryWarpHarness();
        (regHome, msgrHome) = harness.deployChain(HOME_CHAIN);
        (regRemote, msgrRemote) = harness.deployChain(REMOTE_CHAIN);

        // -------- mock the NativeMinter precompile on the remote --------
        // Without this, `NativeTokenRemote` will revert when it tries to call
        // mintNativeCoin on the (non-existent) precompile. See MockNativeMinter
        // for why etching works.
        MockNativeMinter template = new MockNativeMinter();
        vm.etch(NATIVE_MINTER_PRECOMPILE, address(template).code);
        vm.label(NATIVE_MINTER_PRECOMPILE, "NativeMinterPrecompile");

        // -------- deploy WAVAX + NativeTokenHome on the home chain --------
        // Each chain's ICTT contracts cache their own blockchainID at construction
        // by querying the warp precompile; the harness's startDeploy/endDeploy
        // frames the deploy with the right chain context.
        harness.startDeploy(HOME_CHAIN);
        wavax = new WrappedNativeToken("AVAX");
        home = new NativeTokenHome(
            address(regHome),
            admin,
            1, // minTeleporterVersion
            address(wavax)
        );
        harness.endDeploy();
        harness.pinChain(address(wavax), HOME_CHAIN);
        harness.pinChain(address(home), HOME_CHAIN);
        vm.label(address(wavax), "WAVAX");
        vm.label(address(home), "NativeTokenHome");

        // -------- deploy NativeTokenRemote on the remote chain --------
        // For the *native* variant the remote MUST have a non-zero
        // initialReserveImbalance — this represents native supply that already
        // exists on the remote at genesis and therefore must be collateralized
        // on the home before bridging back is permitted.
        harness.startDeploy(REMOTE_CHAIN);
        remote = new NativeTokenRemote(
            TokenRemoteSettings({
                teleporterRegistryAddress: address(regRemote),
                teleporterManager: admin,
                minTeleporterVersion: 1,
                tokenHomeBlockchainID: HOME_CHAIN,
                tokenHomeAddress: address(home),
                tokenHomeDecimals: 18
            }),
            "AVAX", // native asset symbol on the remote chain
            INITIAL_RESERVE_IMBALANCE,
            0 // burnedFeesReportingRewardPercentage
        );
        harness.endDeploy();
        harness.pinChain(address(remote), REMOTE_CHAIN);
        vm.label(address(remote), "NativeTokenRemote");
    }

    // -------------------------------------------------------------------------
    //                              HAPPY PATH
    // -------------------------------------------------------------------------

    function test_full_roundtrip_home_to_remote_and_back() public {
        // ---- Step 1: remote tells home it exists (REMOTE -> HOME) ----
        remote.registerWithHome(TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}));
        assertEq(harness.relayAll(), 1, "register delivered to home");

        // ---- Step 2: collateralize the home with WAVAX equal to the remote's
        //              initialReserveImbalance. No message is sent: addCollateral
        //              just locks native tokens on the home side. ----
        vm.deal(admin, INITIAL_RESERVE_IMBALANCE);
        vm.prank(admin);
        home.addCollateral{value: INITIAL_RESERVE_IMBALANCE}(REMOTE_CHAIN, address(remote));

        // Home should now hold WAVAX equal to the locked amount.
        assertEq(wavax.balanceOf(address(home)), INITIAL_RESERVE_IMBALANCE, "home WAVAX collateral");
        // Remote is still *not* collateralized — that flag only flips when the
        // first SEND message arrives from the home.
        assertEq(remote.getIsCollateralized(), false, "remote not yet collateralized");

        // ---- Step 3: sender bridges 5 AVAX HOME -> REMOTE ----
        uint256 sendAmount = 5 ether;
        vm.deal(sender, sendAmount);
        vm.prank(sender);
        home.send{value: sendAmount}(
            SendTokensInput({
                destinationBlockchainID: REMOTE_CHAIN,
                destinationTokenTransferrerAddress: address(remote),
                recipient: recipient,
                primaryFeeTokenAddress: address(0),
                primaryFee: 0,
                secondaryFee: 0,
                requiredGasLimit: 250_000,
                multiHopFallback: address(0)
            })
        );
        assertEq(harness.relayAll(), 1, "send delivered to remote");

        // Recipient on REMOTE should have received native gas (via mocked minter).
        assertEq(recipient.balance, sendAmount, "native AVAX minted on remote");
        // Home now holds collateral + the new send.
        assertEq(
            wavax.balanceOf(address(home)),
            INITIAL_RESERVE_IMBALANCE + sendAmount,
            "home WAVAX after send"
        );
        // First SEND from home flips the remote into "collateralized" state.
        assertEq(remote.getIsCollateralized(), true, "remote collateralized after first send");

        // ---- Step 4: recipient sends 2 AVAX back REMOTE -> HOME ----
        uint256 returnAmount = 2 ether;
        // recipient already has `sendAmount` native, no extra vm.deal needed.
        vm.prank(recipient);
        remote.send{value: returnAmount}(
            SendTokensInput({
                destinationBlockchainID: HOME_CHAIN,
                destinationTokenTransferrerAddress: address(home),
                recipient: backHome,
                primaryFeeTokenAddress: address(0),
                primaryFee: 0,
                secondaryFee: 0,
                requiredGasLimit: 250_000,
                multiHopFallback: address(0)
            })
        );
        assertEq(harness.relayAll(), 1, "return delivered to home");

        // backHome should have received native AVAX equal to returnAmount.
        assertEq(backHome.balance, returnAmount, "native AVAX received back on home");
        // Home's WAVAX should have decreased by the returnAmount (unwrapped).
        assertEq(
            wavax.balanceOf(address(home)),
            INITIAL_RESERVE_IMBALANCE + sendAmount - returnAmount,
            "home WAVAX after return"
        );
        // Recipient's native balance on REMOTE decreased — the burn address holds
        // the difference.
        assertEq(recipient.balance, sendAmount - returnAmount, "recipient AVAX after send back");
    }

    // -------------------------------------------------------------------------
    //                            NEGATIVE PATHS
    // -------------------------------------------------------------------------

    /// @notice Sending from the remote before any HOME->REMOTE transfer has
    ///         arrived must revert: `_isCollateralized` is still false.
    function test_revert_remote_send_before_collateralization() public {
        // Register so the remote at least knows about the home, but DO NOT
        // bridge anything from the home — the remote stays uncollateralized.
        remote.registerWithHome(TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}));
        harness.relayAll();

        // Even after registration, the remote should refuse outbound transfers.
        assertEq(remote.getIsCollateralized(), false, "precondition: uncollateralized");

        vm.deal(recipient, 1 ether);
        vm.prank(recipient);
        vm.expectRevert("NativeTokenRemote: contract undercollateralized");
        remote.send{value: 1 ether}(
            SendTokensInput({
                destinationBlockchainID: HOME_CHAIN,
                destinationTokenTransferrerAddress: address(home),
                recipient: backHome,
                primaryFeeTokenAddress: address(0),
                primaryFee: 0,
                secondaryFee: 0,
                requiredGasLimit: 250_000,
                multiHopFallback: address(0)
            })
        );
    }

    /// @notice Sending from the home before the remote has registered itself
    ///         must revert: the home has no record of the destination and
    ///         therefore can't know how to scale the amount or whether the
    ///         remote is collateralized. This is the most common foot-gun for
    ///         devs — forgetting to call `registerWithHome` before bridging.
    function test_revert_home_send_before_remote_registers() public {
        // NOTE: deliberately skipping `remote.registerWithHome(...)` here.

        vm.deal(sender, 1 ether);
        vm.prank(sender);
        vm.expectRevert("TokenHome: remote not registered");
        home.send{value: 1 ether}(
            SendTokensInput({
                destinationBlockchainID: REMOTE_CHAIN,
                destinationTokenTransferrerAddress: address(remote),
                recipient: recipient,
                primaryFeeTokenAddress: address(0),
                primaryFee: 0,
                secondaryFee: 0,
                requiredGasLimit: 250_000,
                multiHopFallback: address(0)
            })
        );
    }
}
