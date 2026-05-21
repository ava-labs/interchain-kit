# @interchain-kit/tmpnet

One-command local Avalanche network orchestrator. **Phase 3 — implementation in progress.**

## Status (2026-05-21, after SDK migration)

- ✅ `findAvalanchego` resolves the binary (env, `which`, fallback path)
- ✅ `resolvePluginDir` finds subnet-evm plugin (env override, `<avalanchego>/build/plugins`, fallback paths)
- ✅ Primary network spawns + bootstraps healthy (avalanchego v1.14.2)
- ✅ Migrated from `@avalabs/avalanchejs` direct calls to `@avalanche-sdk/client` — P-Chain ops use `walletClient.pChain.prepare*Txn` + `sendXPTransaction` + `waitForTxn`. **This fixes the previous "invalid signature" rejection** (the SDK builds SECP256K1 credentials differently).
- ✅ `getFeeState()` interception via global `fetch` patch (synthesize high capacity for fresh local P-Chain — documented in `l1.ts`)
- ✅ Relayer EOA pre-funded in L1 genesis (`DEFAULT_RELAYER_ADDRESS` allocated 10k AVAX); C-Chain funding via post-boot transfer in `commands.ts:fundRelayerOn()`.
- ✅ CreateSubnetTx, CreateChainTx, ConvertSubnetToL1Tx all succeed against the P-Chain
- ✅ L1 validator + RPC nodes spawn with correct `--plugin-dir` + `--track-subnets` flags
- ✅ **L1 genesis validates** (after porting the recipe from `avalanche-sdk-typescript/e2e/test/helpers/genesis.ts`): `durangoTimestamp = 1607144400` (hardcoded local activation, NOT 0), `warpConfig.blockTimestamp = same value` (equal allowed; 0 reads as "unset"), `shanghaiTime: 0` + `cancunTime: 0` (required for PUSH0 since icm-contracts is solc 0.8.25), `genesis.timestamp = wall-clock now`.
- ✅ Bootstrap-wait loop added (`waitForChainBootstrap` polls `eth_chainId` until L1 RPC stops returning 503)
- ❌ **L1 never finishes bootstrapping within 60s** — post-ConvertSubnetToL1, the L1 has no active validator set (`ValidatorManager` is at the proxy address but `initializeValidatorSet` hasn't been called yet), so it produces no blocks → RPC stays in "bootstrapping" forever. Chicken-and-egg.
- ⏳ Steps blocked: `initializeValidatorSet` via sigagg, ICM deploy, relayer config + spawn, artifacts emit, snapshot capture.

## Known issue: initializeValidatorSet is the missing step

After ConvertSubnetToL1, the L1 needs `ValidatorManager.initializeValidatorSet(...)` called with a signed warp message of the SubnetToL1ConversionData. The signature-aggregator fetches the message, signs it with primary network validators (the L1 has no validators yet, so SubnetToL1Conversion messages go via the P-Chain), and the relayer (or a direct call) delivers it to the proxy.

**Canonical recipe** — `~/code/avalanche-sdk-typescript/e2e/test/warp-l1-flow.integration.test.ts:388-465` ("step 7"):

1. `waitForL1ValidatorRegistered(walletClient, subnetId)` — poll P-Chain until validator shows up
2. Advance P-Chain height ×2 with self-transfers (`prepareBaseTxn`) so the L1's proposerVM catches the subnet conversion
3. Sleep 30s
4. `rollL1PastFirstEpoch(l1WalletClient, l1PublicClient, …)` — additional time-advance dance on the L1 side
5. Start signature-aggregator with `{ trackedSubnets: [subnetId] }`
6. Call `initializeValidatorSet(l1WalletClient, l1PublicClient, { contractAddress: VALIDATOR_MANAGER_PROXY_ADDRESS, networkId: 12345, subnetId, blockchainId, validators: [{ nodeId, weight: 100n, blsPublicKey }], aggregateSignatures: <fn driving sigagg> })` from `@avalanche-sdk/interchain`.

Once `initializeValidatorSet` returns, the L1 starts producing blocks. RPC unblocks. ICM deploy can proceed.

## What works in this repo right now

- Boot primary network ✅
- Build subnet-evm from `~/code/avalanchego/graft/subnet-evm` ✅ (run `cd ~/code/avalanchego/graft/subnet-evm && ./scripts/build.sh` once; symlinks into `~/code/avalanchego/build/plugins/`)
- `AVALANCHEGO_PATH=… node packages/tmpnet/bin/interchain-kit.js up` ✅ runs through CreateSubnet/CreateChain/ConvertSubnetToL1, fails predictably at the bootstrap wait. State on disk after failure is reproducible.

## What it will do

```bash
pnpm up      # boot primary nodes + 1 L1, deploy Teleporter/ICTT, start relayer
pnpm down    # stop processes (keep snapshot for fast restart)
pnpm clean   # nuke everything
```

A single config file (`network.config.ts`) controls:
- primary network node count
- number and shape of L1s (validators, RPC nodes, archive nodes)
- chain IDs and genesis settings per L1

Default: Primary + one EVM L1. Edit `network.config.ts` to scale up.

## How it works

1. Spawn `avalanchego` processes for the primary network (via tmpnet patterns from `avalanche-benchmark/local`).
2. Create L1 + convert subnet → L1 using `avalanche-sdk-typescript` (chainkit + interchain).
3. Deploy `TeleporterMessenger` + `TeleporterRegistry` on every chain.
4. Generate `icm-relayer` config covering all (source, destination) pairs; spawn it.
5. Spawn `signature-aggregator` HTTP server.
6. Write `addresses.ts` / `network.json` under `.interchain-kit/artifacts/` for tests + scripts to import.

After the first successful `up`, we snapshot post-L1-conversion state. Subsequent `up` runs restore from that snapshot — fresh contract state, but no waiting for L1 bootstrap.

## Explicitly not used

- `avalanche-cli` — deprecated. We use the underlying primitives directly.

## Binaries

Pulled by `@interchain-kit/icm-services-installer`:
- `icm-relayer` v1.7.5
- `signature-aggregator` v0.5.4
