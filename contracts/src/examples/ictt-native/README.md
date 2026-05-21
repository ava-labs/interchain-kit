# ICTT Native — Bridge AVAX as a Chain's Native Gas Token

This example shows a real `NativeTokenHome` + `NativeTokenRemote` round-trip
between two Avalanche L1s, run end-to-end inside a single Foundry EVM via the
`FoundryWarpHarness`.

It is the **native-token** counterpart to the ERC-20 example in
[`../ictt-erc20`](../ictt-erc20). Use this pattern when the asset you are
bridging is the gas token of either side of the bridge — e.g. bridging AVAX
from an Avalanche L1 where AVAX is wrapped as WAVAX, to another L1 where the
bridged AVAX **is the chain's native gas token** (minted via the Native Minter
precompile).

## How it works at a glance

```
  ┌─────────────── HOME L1 ───────────────┐         ┌────────── REMOTE L1 ───────────┐
  │  user pays msg.value = N AVAX         │         │  recipient.balance += N        │
  │            │                          │  ICM    │            ▲                   │
  │            ▼                          │ ──────► │            │ mintNativeCoin()  │
  │   NativeTokenHome.send                │         │   NativeTokenRemote handler    │
  │     ├ wraps to WAVAX (locked)         │         │     ▲                          │
  │     └ emits warp msg                  │ ◄────── │     │ NativeTokenRemote.send   │
  │   NativeTokenHome receives back       │  ICM    │     │ burns native to          │
  │     ├ withdraws WAVAX → AVAX          │         │     │ BURNED_FOR_TRANSFER_ADDR │
  │     └ sendValue(recipient)            │         │     └ emits warp msg           │
  └───────────────────────────────────────┘         └────────────────────────────────┘
```

Key differences vs. the ERC-20 variant:

| Step                  | ERC-20 home/remote                          | Native home/remote                                              |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Lock on home          | `safeTransferFrom` of the ERC-20            | `msg.value` → `WrappedNativeToken.deposit()`                    |
| Issue on remote       | `ERC20._mint` to recipient                  | `NativeMinter.mintNativeCoin(recipient, amount)` (precompile)   |
| Burn on remote        | `ERC20._burn` from sender                   | Send `msg.value` to `BURNED_FOR_TRANSFER_ADDRESS`               |
| Release on home       | `IERC20.transfer` to recipient              | `WrappedNativeToken.withdraw` then `payable.sendValue`          |
| Reserve imbalance     | Optional (`0` allowed)                      | **Required non-zero** — represents genesis supply on the remote |

## The reserve-imbalance gotcha

`NativeTokenRemote` enforces a non-zero `initialReserveImbalance` at init. This
is the amount of native gas that the remote chain genesis-allocates to itself
**before** the bridge is fully backed. Before the home has locked this much
collateral, the remote refuses outbound transfers (`onlyWhenCollateralized`).

In production this collateral is supplied by whoever bootstraps the bridge:

1. Deploy `NativeTokenHome` on the home chain.
2. Deploy `NativeTokenRemote` on the remote chain with
   `initialReserveImbalance = X`.
3. Call `remote.registerWithHome(...)` — the home learns the remote exists and
   records `collateralNeeded = X`.
4. Call `home.addCollateral{value: X}(remoteChainID, remoteAddress)` to lock
   `X` AVAX as WAVAX on the home.
5. From this point on the bridge is fully backed — every native AVAX minted on
   the remote is matched 1:1 by WAVAX locked on the home.

## Files

| File                                                                                  | Role                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`NativeRoundTrip.sol`](./NativeRoundTrip.sol)                                        | Contains `MockNativeMinter` — a test-only stand-in for the Subnet-EVM `NativeMinter` precompile so `NativeTokenRemote` can mint native gas inside a Foundry EVM.    |
| [`../../../test/examples/ictt-native/NativeRoundTrip.t.sol`](../../../test/examples/ictt-native/NativeRoundTrip.t.sol) | Round-trip test: register → collateralize → home→remote send → remote→home send, plus two negative-path tests. |

## Running

```bash
forge test --root contracts --match-path "test/examples/ictt-native/*" -vv
```

## Adapting this to real chains

Swap the `FoundryWarpHarness` plumbing for real deployments and the rest of
the code is identical:

- Deploy `WrappedNativeToken` + `NativeTokenHome` on the home chain (e.g.
  C-Chain).
- Deploy `NativeTokenRemote` on the destination L1 (your own L1, with the
  Native Minter precompile enabled and the remote contract whitelisted as a
  minter).
- Run an ICM relayer between the two chains.
- Call `registerWithHome` → `addCollateral` → users can now bridge.

No `MockNativeMinter` is needed on a real L1: the precompile at
`0x0200000000000000000000000000000000000001` mints natively, provided your
chain's `chain-config.json` includes the `nativeMinterConfig` precompile and
the `NativeTokenRemote` address in `adminAddresses` / `enabledAddresses`.
