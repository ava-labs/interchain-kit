# interchain-kit
<img width="1647" height="1158" alt="Gemini_Generated_Image_1k3a6u1k3a6u1k3a" src="https://github.com/user-attachments/assets/883003c6-0f0b-426c-aa3d-15d23ad7c497" />


Local dev kit for Avalanche **Interchain Messaging (ICM)** and **Interchain Token Transfer (ICTT)**. One command boots a real network with L1, Teleporter, relayer, and signature-aggregator wired up.

Two complementary flows:

| Flow | Boots in | What it gives you |
|---|---|---|
| **Foundry harness** | ~100ms | Real, unmodified `icm-contracts` (Teleporter + ICTT) running end-to-end inside a single EVM. Best for TDD on your Solidity. |
| **Local tmpnet + relayer** | ~3 min first run, snapshot on subsequent | Real local Avalanche network (Primary + L1s) with `icm-relayer` and `signature-aggregator`. Best for E2E validation before Fuji. |

Same contracts work in both. Iterate fast in the harness, then prove it E2E.

## Layout

```
contracts/                      Foundry-first. icm-contracts v1.0.9 pinned.
  src/examples/
    icm-basics/                 SimpleSender + SimpleReceiver
    ictt-erc20/                 ERC20 round-trip + DemoERC20
    ictt-native/                Native token home/remote
    teleporter-patterns/        PingPong + CrossChainCounter
  test/examples/                17 harness tests, all green
packages/
  harness/                      FoundryWarpHarness + MockWarpPrecompile
  tmpnet/                       TS orchestrator (network → L1 → ICM →
                                validator-set → relayer + sigagg → artifacts)
  icm-services-installer/       Downloads icm-relayer + signature-aggregator
examples/                       End-to-end demos against the live network
  send-message.ts               ICM hello-world
  transfer-token.ts             ICTT ERC20 transfer
  validator-manager-setup.ts    Deploy + upgrade + initialize ValidatorManager
  add-validator.ts              Register a new L1 validator
```

## Prerequisites

- **Node 20+** and **pnpm 9+**
- **Foundry** (`forge`)
- An **avalanchego** binary. Easiest: clone `ava-labs/avalanchego`, `./scripts/build.sh`, then build the bundled subnet-evm plugin: `cd graft/subnet-evm && ./scripts/build.sh` (symlinks into `<avalanchego>/build/plugins/`).
- Set `AVALANCHEGO_PATH` to the binary, e.g. `export AVALANCHEGO_PATH=$HOME/code/avalanchego/build/avalanchego`.

## Quickstart

### 1. Foundry harness (no network needed)

```bash
pnpm install
pnpm test:harness                # forge test --root contracts
```

### 2. Local tmpnet

```bash
pnpm run up                      # boots primary network + L1 + ICM + relayer + sigagg
```

This:
1. Spawns 5 primary-network nodes (uses avalanchego's preconfigured local stakers).
2. Creates a subnet via P-Chain (`@avalanche-sdk/client` wallet).
3. Issues `CreateChainTx` for a subnet-evm L1 with a `ValidatorManager` proxy pre-allocated at `0xfacade…`.
4. Spawns L1 validator + RPC nodes tracking the subnet.
5. `ConvertSubnetToL1Tx` on the P-Chain.
6. `initializeValidatorSet` on the L1 via signature-aggregator + warp.
7. Deploys `TeleporterMessenger` + `TeleporterRegistry` on every chain from a single-use deployer (so addresses match across chains — the relayer requires this).
8. Funds the relayer EOA on C-Chain (L1s pre-fund in genesis).
9. Starts `icm-relayer` (port 8080) and `signature-aggregator` (port 8090) with peer discovery.
10. Writes `network.json`, `addresses.ts`, and `.env` to `.interchain-kit/artifacts/`.

Then run the demos:

```bash
cd examples
pnpm exec tsx send-message.ts                  # ICM round-trip C-Chain → L1
pnpm exec tsx transfer-token.ts                # ICTT ERC20 round-trip
pnpm exec tsx validator-manager-setup.ts       # Deploy + upgrade VM, print state
AVALANCHEGO_PATH=… pnpm exec tsx add-validator.ts  # Register a new L1 validator
```

Teardown:

```bash
pnpm run down                    # stop processes (snapshot preserved)
pnpm run clean                   # nuke data, snapshots, logs
```

## Replaces

This repo is the next-gen replacement for [`ava-labs/avalanche-starter-kit`](https://github.com/ava-labs/avalanche-starter-kit). Built on `@avalanche-sdk/{client,interchain}` and the bundled subnet-evm in the avalanchego graft. `avalanche-cli` is intentionally not used — every primitive is driven directly.

## License

BSD 3-Clause. See [LICENSE](./LICENSE).
