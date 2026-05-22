# tmpnetjs

JS analog of avalanchego's [`tmpnet`](https://github.com/ava-labs/avalanchego/tree/master/tests/fixture/tmpnet). Boots a local Avalanche network — primary nodes, L1s, Teleporter, ICTT, `icm-relayer`, `signature-aggregator` — and exposes it both as an SDK and a CLI.

## Use it

### CLI

```bash
tmpnetjs up      # boot primary network + L1 + ICM + relayer + sigagg
tmpnetjs down    # stop processes (snapshot preserved)
tmpnetjs clean   # nuke data, snapshots, binaries
```

Artifacts land in `<cwd>/.interchain-kit/artifacts/`:
- `network.json` — canonical handle (chain IDs, RPC URLs, contract addresses, funded key)
- `addresses.ts` — typed re-export for TS scripts
- `.env` — flat key/value for shell + Foundry (`vm.envAddress`)

### SDK

```ts
import {
  loadNetwork,
  makeClients,
  pickL1,
  pollUntil,
  blockchainIdToBytes32,
} from "tmpnetjs";

const net = loadNetwork();
const dst = pickL1(net, "demo");

const { publicClient, walletClient, account } = makeClients(net.cChain, net.funded.privateKey);
```

The producer-side API (`up`, `down`, `clean`, `Network.start`) is also exported — see `src/commands.ts`.

## Requirements

- Node 20+, pnpm 9+
- An `avalanchego` binary built from source with the `subnet-evm` plugin (`<avalanchego>/build/plugins/srEXi...Dy`)
- `AVALANCHEGO_PATH` pointing at the binary

## Snapshots

After the first successful `up`, post-L1 state is snapshotted. Subsequent `up` runs restore — fresh contract state, no bootstrap wait.

## Explicitly not used

`avalanche-cli` — deprecated. tmpnetjs drives the underlying primitives directly:
- P-Chain: `@avalanche-sdk/client` (`prepare*Txn` + `sendXPTransaction`)
- Subnet conversion + ValidatorManager: `@avalanche-sdk/interchain`
- Sig-agg + relayer: prebuilt binaries via `@interchain-kit/icm-services-installer`

## Binaries

Managed by `@interchain-kit/icm-services-installer`:
- `icm-relayer` v1.7.5
- `signature-aggregator` v0.5.4
