# interchain-kit

Local development kit for Avalanche **Interchain Messaging (ICM)** and **Interchain Token Transfer (ICTT)**.

Two flows, one repo:

| Flow | Boots in | What it gives you |
|---|---|---|
| **Foundry harness** | ~100ms | Real, unmodified `icm-contracts` (Teleporter + ICTT) running end-to-end inside a single EVM. Best for TDD on your solidity. |
| **Local tmpnet + relayer** | seconds | A real local Avalanche network (Primary + one or more L1s) with `icm-relayer` and `signature-aggregator` wired up. Best for end-to-end validation before Fuji. |

Both flows use the same contracts. Iterate fast in the harness, then prove it E2E.

## Layout

```
contracts/          # Foundry-first. Your solidity lives here.
  src/examples/     # ICM basics, ICTT ERC20, ICTT native, custom receivers
  test/             # Harness tests
  script/           # Tmpnet deploy scripts
packages/
  harness/          # FoundryWarpHarness + MockWarpPrecompile (used by tests)
  tmpnet/           # TypeScript orchestrator: nodes + L1 + ICM + relayer
  icm-services-installer/  # Pulls icm-relayer + signature-aggregator binaries
```

## Quickstart

### Foundry harness (no network needed)

```bash
pnpm install
cd contracts && forge install  # one-time
pnpm test:harness
```

### Local tmpnet (Phase 3 — coming soon)

```bash
pnpm up                        # boot nodes, create L1, deploy ICM, start relayer
pnpm test:e2e                  # run examples against the live network
pnpm down                      # stop (preserves snapshot)
pnpm clean                     # nuke everything
```

## Status (2026-05-21)

| Surface | State | Notes |
|---|---|---|
| Foundry harness | ✅ Green | `FoundryWarpHarness` + `MockWarpPrecompile`; `relayAll()` drains messages spawned during delivery. |
| Example contracts | ✅ 14/14 tests pass | `icm-basics`, `ictt-erc20`, `ictt-native`, `teleporter-patterns` (PingPong + CrossChainCounter). |
| `@interchain-kit/icm-services-installer` | ✅ 12/12 tests pass | Downloads `icm-relayer` v1.7.5 + `signature-aggregator` v0.5.4 with sha256 verify. |
| `@interchain-kit/tmpnet` (types + CLI) | ✅ Typecheck clean | Public API surface defined; CLI dispatch wired. |
| `pnpm up` end-to-end | ⚠️ Blocked on `initializeValidatorSet` step | Primary network ✅, CreateSubnet/Chain/ConvertSubnetToL1 ✅, L1 genesis validates ✅. L1 then never finishes bootstrap because `ValidatorManager.initializeValidatorSet(...)` is not yet called post-conversion. Canonical recipe in `~/code/avalanche-sdk-typescript/e2e/test/warp-l1-flow.integration.test.ts:388`. See `packages/tmpnet/README.md`. |
| E2E demo scripts | ✅ Typecheck clean | `examples/send-message.ts`, `examples/transfer-token.ts`. Will run once tmpnet boots fully. |

## Replaces

This repo is the next-gen replacement for `ava-labs/avalanche-starter-kit`.
