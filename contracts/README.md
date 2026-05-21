# contracts

Solidity workspace. Foundry-first.

## Examples

| Example | What it shows |
|---|---|
| `src/examples/icm-basics/` | Plain ICM: send a message from chain A to chain B, receive it. |
| `src/examples/ictt-erc20/` | ICTT ERC20 home/remote — wrap a token on one chain, receive it on another. |
| `src/examples/ictt-native/` | ICTT native token home/remote. |
| `src/examples/teleporter-patterns/` | Higher-level patterns built on Teleporter (DEX stub, NFT bridge stub). |

Each example has matching tests under `test/examples/<name>/` that drive the
contracts through the `FoundryWarpHarness` from `@interchain-kit/harness/`.

## Running tests

```bash
forge test -vv                                    # all examples
forge test --match-path test/examples/ictt-erc20  # one example
```

Or from the repo root:

```bash
pnpm test:harness
```

## Layout

```
src/examples/         # Your contracts. Read these for patterns.
test/examples/        # Matching harness tests.
script/               # Deploy scripts for the tmpnet flow (Phase 3).
lib/                  # Forge-installed deps (gitignored).
```

## Deps pinned

- `icm-contracts` — v1.0.9
- `openzeppelin-contracts-upgradeable` — pulled transitively, includes openzeppelin-contracts
- `forge-std` — latest
