// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Vm} from "forge-std/Vm.sol";
import {INativeMinter} from "@avalabs/subnet-evm-contracts@1.2.2/contracts/interfaces/INativeMinter.sol";

/// @title MockNativeMinter
/// @notice Test-only stand-in for the Avalanche Subnet-EVM `NativeMinter` precompile
///         which lives at `0x0200000000000000000000000000000000000001` on real L1s.
///
/// @dev Why this exists:
/// The real `NativeMinter` precompile is implemented in Go inside subnet-evm — it
/// literally credits an account's native balance when called. In Foundry there is
/// no precompile at that address, so `NativeTokenRemote` (which calls
/// `NATIVE_MINTER.mintNativeCoin(...)` whenever it processes an incoming transfer
/// or `_withdraw`) would either revert or silently no-op.
///
/// We work around this by deploying this contract once, then `vm.etch`-ing its
/// runtime bytecode at the canonical precompile address. Because etched code
/// retains access to the Foundry cheatcode VM, the mock can call `vm.deal` to
/// credit native balance to the recipient — exactly what the real precompile
/// does on a live L1.
///
/// Usage from a test:
/// ```solidity
/// address constant NATIVE_MINTER_PRECOMPILE = 0x0200000000000000000000000000000000000001;
/// MockNativeMinter template = new MockNativeMinter();
/// vm.etch(NATIVE_MINTER_PRECOMPILE, address(template).code);
/// ```
///
/// After etching, every `NATIVE_MINTER.mintNativeCoin(addr, amt)` from
/// `NativeTokenRemote` will increase `addr.balance` by `amt`, faithfully
/// simulating native-token minting in a single-EVM Foundry test.
contract MockNativeMinter is INativeMinter {
    /// @notice Cheatcode VM address (forge-std). Etched code can still call this.
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Mints `amount` native tokens to `addr` by bumping its balance via `vm.deal`.
    /// @dev Mirrors the real precompile's effect (crediting native balance) without
    ///      requiring a custom precompile registration.
    function mintNativeCoin(address addr, uint256 amount) external override {
        vm.deal(addr, addr.balance + amount);
        emit NativeCoinMinted(msg.sender, addr, amount);
    }

    // ---- IAllowList no-ops (unused by NativeTokenRemote, present for ABI compat) ----

    function setAdmin(address) external override {}
    function setEnabled(address) external override {}
    function setManager(address) external override {}
    function setNone(address) external override {}

    function readAllowList(address) external pure override returns (uint256) {
        return 0;
    }
}
