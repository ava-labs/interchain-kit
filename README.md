<div align="center">
  <img src="https://github.com/user-attachments/assets/883003c6-0f0b-426c-aa3d-15d23ad7c497" alt="interchain-kit" width="320" />

  <h1>interchain-kit</h1>

  <p>
    <strong>Local dev kit for Avalanche ICM &amp; ICTT.</strong><br/>
    One command boots a real network with L1, Teleporter, relayer, and signature-aggregator wired up.
  </p>

  <p>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-BSD--3-blue.svg" alt="License: BSD-3" /></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A520-43853d.svg" alt="Node >= 20" />
    <img src="https://img.shields.io/badge/pnpm-%E2%89%A59-f69220.svg" alt="pnpm >= 9" />
    <img src="https://img.shields.io/badge/solidity-0.8.25-636363.svg" alt="Solidity 0.8.25" />
    <img src="https://img.shields.io/badge/built%20with-foundry-202020.svg" alt="Built with Foundry" />
  </p>
</div>

---

## Two flows

| Flow | Boots in | What you get |
|---|---|---|
| **Foundry harness** | ~100 ms | Real, unmodified `icm-contracts` (Teleporter + ICTT) end-to-end inside a single EVM. Best for TDD on your Solidity. |
| **Local tmpnet + relayer** | ~3 min cold, snapshot after | Real local Avalanche network (Primary + L1s) with `icm-relayer` and `signature-aggregator`. Best for E2E validation before Fuji. |

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
  tmpnetjs/                     JS analog of avalanchego tmpnet. Producer
                                (boot network → L1 → ICM → validator-set →
                                relayer + sigagg → artifacts) + consumer
                                SDK (loadNetwork, makeClients, …).
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
- An **avalanchego** binary, built with the bundled subnet-evm plugin. The avalanchego source tree includes a `graft/` directory holding plugin sources — that's where the subnet-evm build script lives. From a fresh checkout:
  ```bash
  git clone https://github.com/ava-labs/avalanchego
  cd avalanchego
  ./scripts/build.sh                         # builds the avalanchego binary
  cd graft/subnet-evm && ./scripts/build.sh  # builds the subnet-evm plugin
  ```
  The second step symlinks the plugin into `<avalanchego>/build/plugins/` under its VM ID (`srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy`). Confirm that file exists before booting.
- Set `AVALANCHEGO_PATH` to the binary:
  ```bash
  export AVALANCHEGO_PATH=/path/to/avalanchego/build/avalanchego
  ```

## Quickstart

### Foundry harness — no network needed

```bash
pnpm install
pnpm test:harness                # forge test --root contracts
```

### Local tmpnet — full E2E

```bash
pnpm run up                      # boots primary network + L1 + ICM + relayer + sigagg
```

`pnpm run up` does:

1. Spawns 5 primary-network nodes (avalanchego's preconfigured local stakers).
2. Creates a subnet via P-Chain (`@avalanche-sdk/client` wallet).
3. Issues `CreateChainTx` for a subnet-evm L1 with the `ValidatorManager` proxy pre-allocated at `0xfacade…`.
4. Spawns L1 validator + RPC nodes tracking the subnet.
5. `ConvertSubnetToL1Tx` on the P-Chain.
6. `initializeValidatorSet` on the L1 via signature-aggregator + warp.
7. Deploys `TeleporterMessenger` + `TeleporterRegistry` on every chain from a single-use deployer (so addresses match across chains — the relayer requires this).
8. Funds the relayer EOA on C-Chain (L1s pre-fund in genesis).
9. Starts `icm-relayer` (`:8080`) and `signature-aggregator` (`:8090`) with peer discovery.
10. Writes `network.json`, `addresses.ts`, and `.env` to `.interchain-kit/artifacts/`.

Then run the demos:

```bash
cd examples
pnpm exec tsx send-message.ts                       # ICM round-trip C-Chain → L1
pnpm exec tsx transfer-token.ts                     # ICTT ERC20 round-trip
pnpm exec tsx validator-manager-setup.ts            # Deploy + upgrade VM, print state
AVALANCHEGO_PATH=… pnpm exec tsx add-validator.ts   # Register a new L1 validator
```

Teardown:

```bash
pnpm run down                    # stop processes (snapshot preserved)
pnpm run clean                   # nuke data, snapshots, logs
```

## Use `tmpnetjs` in your own scripts

The examples are just thin consumers of [`tmpnetjs`](./packages/tmpnetjs) — boot the network with `pnpm run up`, then drive it from any TypeScript file:

```ts
import { loadNetwork, makeClients, pickL1, pollUntil } from "tmpnetjs";

const net = loadNetwork();
const dst = pickL1(net, "myl1");
const { publicClient, walletClient } = makeClients(net.cChain, net.funded.privateKey);
// … your ICM/ICTT/whatever scenario
```

Producer-side API (`up`, `down`, `Network.start`, `captureSnapshot`, …) is also exported — see [`packages/tmpnetjs/README.md`](./packages/tmpnetjs/README.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `avalanchego binary not found` (lists tried paths) | Set `AVALANCHEGO_PATH` to the absolute path of the built binary, e.g. `<avalanchego>/build/avalanchego`. |
| Node never goes healthy / "plugin not found" / subnet won't bootstrap | The subnet-evm plugin isn't where avalanchego expects. Confirm `<avalanchego>/build/plugins/srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy` exists. Rebuild via `cd <avalanchego>/graft/subnet-evm && ./scripts/build.sh` if missing. |
| `up` fails partway, subsequent runs reuse stale data and fail again | `pnpm run clean` then `pnpm run up`. `clean` nukes `.interchain-kit/` (data, snapshots, logs). |
| `forge: command not found` | Install Foundry: <https://book.getfoundry.sh/getting-started/installation>. |
| Port already in use (`:9650-9950`, `:8080`, `:8090`, `:9090`) | The primary nodes use `9650+100*i`, `icm-relayer` binds `:8080` (API) + `:9090` (metrics), `signature-aggregator` binds `:8090`. Kill the process holding them (`lsof -iTCP:8080 -sTCP:LISTEN`) or stop the other service. |

## Replaces

The next-gen replacement for [`ava-labs/avalanche-starter-kit`](https://github.com/ava-labs/avalanche-starter-kit). Built on `@avalanche-sdk/{client,interchain}` and the bundled subnet-evm in the avalanchego graft. `avalanche-cli` is intentionally not used — every primitive is driven directly.

## License

[BSD 3-Clause](./LICENSE).
