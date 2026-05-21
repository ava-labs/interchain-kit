// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test, console2} from "forge-std/Test.sol";

import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";
import {TeleporterRegistry} from "@teleporter/registry/TeleporterRegistry.sol";
import {TeleporterMessenger} from "@teleporter/TeleporterMessenger.sol";
import {TeleporterFeeInfo} from "@teleporter/ITeleporterMessenger.sol";

import {ERC20TokenHome} from "@ictt/TokenHome/ERC20TokenHome.sol";
import {ERC20TokenRemote} from "@ictt/TokenRemote/ERC20TokenRemote.sol";
import {TokenRemoteSettings} from "@ictt/TokenRemote/interfaces/ITokenRemote.sol";
import {SendTokensInput} from "@ictt/interfaces/ITokenTransferrer.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DemoUSDC is ERC20 {
    constructor() ERC20("Demo USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Round-trip test against unmodified `ERC20TokenHome` /
///         `ERC20TokenRemote` from `icm-contracts`. The FoundryWarpHarness
///         shuttles every real warp message between them.
///
/// Flow exercised:
///   1. Deploy two chains (C-Chain, L1) via harness.
///   2. Deploy real ERC20TokenHome on C-Chain pointing at C-Chain registry.
///   3. Deploy real ERC20TokenRemote on L1 pointing at L1 registry.
///   4. remote.registerWithHome(...)        -> harness relays L1 -> C
///   5. home.addCollateral(...)             -> harness relays C -> L1 (collateral confirmation)
///   6. home.send(...)                       -> harness relays C -> L1 (minting on remote)
///   7. assert recipient balance on remote.
contract CrossChainRoundtrip is Test {
    bytes32 constant C_CHAIN  = bytes32(uint256(0xC1));
    bytes32 constant L1_CHAIN = bytes32(uint256(0x71));

    FoundryWarpHarness harness;
    TeleporterRegistry regC;
    TeleporterMessenger msgrC;
    TeleporterRegistry regL1;
    TeleporterMessenger msgrL1;
    DemoUSDC usdc;
    ERC20TokenHome home;
    ERC20TokenRemote remote;

    address admin = makeAddr("admin");
    address depositor = makeAddr("depositor");
    address recipient = makeAddr("recipient");

    function setUp() public {
        harness = new FoundryWarpHarness();
        (regC,  msgrC)  = harness.deployChain(C_CHAIN);
        (regL1, msgrL1) = harness.deployChain(L1_CHAIN);

        usdc = new DemoUSDC();

        // Deploy ERC20TokenHome on "C-Chain". Its initializer queries
        // getBlockchainID via the warp precompile; the harness's
        // startDeploy/endDeploy frames the deploy with the chainId fallback.
        harness.startDeploy(C_CHAIN);
        home = new ERC20TokenHome(address(regC), admin, 1, address(usdc), 6);
        harness.endDeploy();
        harness.pinChain(address(home), C_CHAIN);
        vm.label(address(home), "ERC20TokenHome");

        harness.startDeploy(L1_CHAIN);
        remote = new ERC20TokenRemote(
            TokenRemoteSettings({
                teleporterRegistryAddress: address(regL1),
                teleporterManager: admin,
                minTeleporterVersion: 1,
                tokenHomeBlockchainID: C_CHAIN,
                tokenHomeAddress: address(home),
                tokenHomeDecimals: 6
            }),
            "Wrapped Demo USDC",
            "wUSDC",
            6
        );
        harness.endDeploy();
        harness.pinChain(address(remote), L1_CHAIN);
        vm.label(address(remote), "ERC20TokenRemote");
    }

    function test_full_roundtrip_register_collateralize_send() public {
        // ---- Step 1: register the remote with the home (L1 -> C) ----
        remote.registerWithHome(TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}));
        uint256 delivered = harness.relayAll();
        console2.log("Delivered after register:", delivered);
        assertEq(delivered, 1, "register message delivered");

        // ---- Step 2: collateralize the home for this remote ----
        // ERC20TokenRemote initialReserveImbalance defaults to 0 if remote has same decimals
        // as home AND initialReserveImbalance is passed as 0 to the remote (default in our
        // ctor: the remote derived it as 0 since totalSupply()=0). So no collateral is needed.
        // We'll send directly.

        // ---- Step 3: depositor sends 1000 USDC on C-Chain -> recipient on L1 ----
        uint256 amount = 1_000 * 1e6;
        usdc.mint(depositor, amount);

        vm.startPrank(depositor);
        usdc.approve(address(home), amount);
        home.send(
            SendTokensInput({
                destinationBlockchainID: L1_CHAIN,
                destinationTokenTransferrerAddress: address(remote),
                recipient: recipient,
                primaryFeeTokenAddress: address(0),
                primaryFee: 0,
                secondaryFee: 0,
                requiredGasLimit: 200_000,
                multiHopFallback: address(0)
            }),
            amount
        );
        vm.stopPrank();

        delivered = harness.relayAll();
        console2.log("Delivered after send:", delivered);

        // ---- Verify ----
        // remote is itself an ERC20 (the wrapped token); recipient should now have `amount`.
        assertEq(IERC20(address(remote)).balanceOf(recipient), amount, "wrapped USDC minted to recipient");
        // home holds the collateral
        assertEq(usdc.balanceOf(address(home)), amount, "home holds the original USDC");
        // depositor's USDC was consumed
        assertEq(usdc.balanceOf(depositor), 0, "depositor drained");
    }
}
