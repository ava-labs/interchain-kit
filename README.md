# icm-devkit (spike)

A Foundry harness that runs **real, unmodified** `icm-contracts` (Teleporter +
ICTT) end-to-end in a single EVM instance, with real warp messages shuttled
between two simulated chains by a harness library.

```
forge test --match-contract CrossChainRoundtrip -vv

  [PASS] test_full_roundtrip_register_collateralize_send() (gas: 2_222_884)
        1 test passed, ~110ms
```

That test:
1. Deploys two `TeleporterMessenger` + `TeleporterRegistry` stacks (one per chain)
2. Deploys real `ERC20TokenHome` on "C-Chain" pointing at C-Chain registry
3. Deploys real `ERC20TokenRemote` on "L1" pointing at L1 registry
4. Calls `remote.registerWithHome(...)` → harness shuttles the warp message → real `TokenHome.RemoteRegistered` fires
5. Calls `home.send(...)` → harness shuttles → real `TokenRemote` mints wrapped USDC to the recipient
6. Asserts balances

No mocks of ICTT or Teleporter. No tmpnet. No relayer. No docker. 110ms.

## How it works

Only **one thing** is faked: the subnet-evm Warp precompile at
`0x0200000000000000000000000000000000000005`.

```
            ┌──────────────────────────────────────┐
            │  ERC20TokenHome (REAL)               │
            │  TeleporterMessenger (REAL)          │
            │  TeleporterRegistry (REAL)           │
            └──────────────────┬───────────────────┘
                               │ sendWarpMessage
                               │ getBlockchainID
                               │ getVerifiedWarpMessage
                               ▼
            ┌──────────────────────────────────────┐
            │  MockWarpPrecompile  (etched at      │
            │  0x...05 via vm.etch)                │
            │                                      │
            │  • Per-caller chain IDs              │
            │  • Queue of pending warp messages    │
            │  • Returns inflight message with     │
            │    originSenderAddress = msg.sender  │
            │    (bypasses universal-deployer      │
            │     self-check without redeploying)  │
            └──────────────────────────────────────┘
                               ▲
                               │
            ┌──────────────────────────────────────┐
            │  ERC20TokenRemote (REAL)             │
            │  TeleporterMessenger (REAL)          │
            │  TeleporterRegistry (REAL)           │
            └──────────────────────────────────────┘
                               ▲
                               │ harness.relayAll()
                               │ pops queue, stages inflight,
                               │ calls receiveCrossChainMessage
                               │
            ┌──────────────────────────────────────┐
            │  FoundryWarpHarness (test lib)       │
            └──────────────────────────────────────┘
```

### The trick: bypassing the universal-deployer self-check

`TeleporterMessenger.receiveCrossChainMessage` insists
`warpMessage.originSenderAddress == address(this)` — because in production both
messengers are deployed at the same address via Nick's-method universal
deployer, so a message claiming to originate from a same-bytecode peer must
also be at this address.

In our single-EVM harness we have two messengers at *different* addresses.
We can't satisfy that check honestly. The mock precompile satisfies it
dishonestly: `getVerifiedWarpMessage` returns
`originSenderAddress = msg.sender` — i.e. the destination messenger's own
address. The check `warpMessage.originSenderAddress == address(this)` then
becomes `addr(destination) == addr(destination)` and passes.

This is safe **for testing** because the harness controls who calls
`receiveCrossChainMessage` and what's queued — it can't be tricked by an
attacker. In production the real precompile enforces real BLS signature
checks. The mock simply trusts the harness.

### Layout

```
src/harness/
  MockWarpPrecompile.sol     ~120 lines — the etched precompile mock
  FoundryWarpHarness.sol     ~140 lines — deployChain, relayAll, startDeploy

test/
  CrossChainRoundtrip.t.sol  full round-trip against real ERC20TokenHome/Remote
```

## What this unlocks

| Today's options for testing ICM apps | This harness |
|---|---|
| Foundry tests that mock TokenHome OR Remote, one side at a time (what `icm-contracts` itself does) | Full round-trip in one test, both sides real |
| `avalanche-cli` + DevContainer + Docker — slow, heavy, requires running multiple processes | `forge test` — milliseconds, no infra |
| tmpnet + relayer — most realistic but ~5min boot, hard to CI | Reserve for final validation only |

Same logic developers test for ICTT/ICM, now with **fast inner-loop**
fidelity.

## Next steps if we turn this spike into a real repo

1. **Multi-hop support** — extend harness to 3+ chains, exercise multi-hop ICTT.
2. **sendAndCall path** — already supported by the harness (it's just another teleporter message); add a test that fires a real recipient contract call cross-chain.
3. **Receipt/fee paths** — the test already exercises receipt enqueue; add explicit fee-paying tests.
4. **Reorg / failure simulation** — `harness.dropMessage(idx)`, `harness.duplicateMessage(idx)`, `harness.delay(idx, seconds)`.
5. **Parallel tmpnet runner** — same `*.scenario.ts` files driven by either the harness (fast) or a tmpnet+relayer wrapper (real). The harness is the dev loop; tmpnet is CI.
6. **Starter templates** — clone-and-go templates for common ICM patterns: cross-chain ERC20, sendAndCall router, ICTT with custom validation (like Tranched's PayInRouter).
7. **TeleporterRegistry.addProtocolVersion** — currently the mock reverts on `getVerifiedWarpBlockHash`. Add support if anyone needs to test registry upgrades.

## Caveats and known gaps

- **No real BLS / signature aggregation.** The harness skips the entire warp-signing pipeline. Tests verify protocol logic, not crypto.
- **No reorg semantics.** Messages always deliver in order, never drop. Add fault-injection helpers as needed.
- **Single EVM** — `vm.chainId` is one value at a time. The Teleporter `blockchainID` (the warp identity) is what the harness varies, not the EVM chain ID. Apps that read `block.chainid` for L1 vs C-Chain branching need additional plumbing.
- **`vm.etch` requirement** — the harness must run inside a Foundry test (`vm` cheatcodes), not a deployed contract.

## Running

```bash
forge build
forge test --match-contract CrossChainRoundtrip -vv     # logs
forge test --match-contract CrossChainRoundtrip -vvvv   # full trace incl. warp messages
```

## Status

This is a **spike** — a focused 30-minute proof that the technique works
against the real `icm-contracts` ICTT codebase. The harness API will evolve
as we build out the rest of the devkit. If you can read this README and the
two `src/harness/*.sol` files, you understand everything.
