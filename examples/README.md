# examples

Two runnable demos that exercise a live interchain-kit tmpnet:

| Script | What it does |
|---|---|
| `send-message.ts` | Deploys `SimpleSender` on C-Chain + `SimpleReceiver` on the first L1, sends "Hello from C-Chain!", polls the receiver until it lands. |
| `transfer-token.ts` | Deploys an `ExampleERC20` + `ERC20TokenHome` on C-Chain and `ERC20TokenRemote` on the first L1, registers, then transfers 100 tokens C-Chain → L1 and polls for arrival. |

## Validator manager

These two demos exercise the L1's `ValidatorManager` contract. Run them in order — `add-validator.ts` assumes setup has already happened.

| Script | What it does |
|---|---|
| `validator-manager-setup.ts` | Deploys a real `ValidatorManager` impl, upgrades the genesis proxy at `0xfacade…` to point at it (also runs `initialize(settings)`), then calls `initializeValidatorSet` so the bootstrap validator from `ConvertSubnetToL1Tx` is reflected on-chain. Prints `isValidatorSetInitialized`, total weight, and the validator list. |
| `add-validator.ts` | Spawns a fresh avalanchego node on port 10750 tracking the L1's subnet, reads its NodeID + BLS PoP, then runs the SDK's `registerL1Validator` (EVM-initiate → sigagg → P-Chain `RegisterL1ValidatorTx` → sigagg ACK → EVM-complete). Verifies the new validator on both the L1's `ValidatorManager` and the P-Chain validator set. The spawned node is left running. |

Both scripts:

- Read `.interchain-kit/artifacts/network.json` (written by `pnpm up`) for RPC URLs, chain IDs, Teleporter addresses, and the funded dev key.
- Use viem only (no SDK runtime dep).
- Pull contract ABIs + bytecode from `contracts/out/` (forge build output).

## Prerequisites

1. **Boot the local network** from the repo root:

   ```bash
   pnpm install
   pnpm up
   ```

   This starts the primary network + one L1, deploys Teleporter, and starts the icm-relayer. It writes `.interchain-kit/artifacts/network.json` when it's ready.

2. **Compile contracts** so the demos can find ABIs + bytecode:

   ```bash
   forge build --root contracts
   ```

   This produces `contracts/out/SimpleSender.sol/SimpleSender.json`, etc.

3. **Install demo deps** (one-time, from this directory):

   ```bash
   cd examples
   pnpm install
   ```

## Run

From the **repo root** (the scripts expect `.interchain-kit/` and `contracts/out/` to be relative to CWD):

```bash
pnpm tsx examples/send-message.ts
pnpm tsx examples/transfer-token.ts --amount 250
```

### Flags

Both scripts accept:

- `--destination <l1-name>` — which L1 to send to (defaults to the first L1 in `network.json`). Must match a `name` in your `NetworkConfig`.
- `--amount <number>` — (`transfer-token` only) human-readable token amount, default `100`.

You can also set these as env vars: `DESTINATION=mychain AMOUNT=42 pnpm tsx examples/transfer-token.ts`.

## What you should see

`send-message.ts`:

```
Source:      C-Chain  (evmChainId=43112)
Destination: testlanche  (evmChainId=999001)
Funded:      0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC

Deploying SimpleSender on C-Chain...
  -> 0x5FbDB231...
Deploying SimpleReceiver on testlanche...
  -> 0xCf7Ed3AC...

Receiver.latestMessage (before): ""
Sending message: "Hello from C-Chain!"
  tx: 0xabc... (block 12)

Polling receiver.latestMessage on testlanche...
Receiver.latestMessage (after):  "Hello from C-Chain!"

Done. ICM round-trip succeeded.
```

`transfer-token.ts` prints similar deployment lines plus a balance journey: `0 -> 100000000000000000000`.

## Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `network.json not found at ...` | You haven't run `pnpm up`, or you're running the script from outside the repo root. | `cd` to the repo root and `pnpm up`. |
| `Forge artifact not found: contracts/out/...` | You haven't built the contracts yet. | `forge build --root contracts` |
| `Timed out after 60000ms waiting for receiver.latestMessage to update` | The icm-relayer isn't running, or hasn't picked up the message. | Check `.interchain-kit/logs/relayer.log`. If it's not running, `pnpm down && pnpm up` to recycle. |
| `Timed out … remote registration to reach home` | Same as above — registration sends a Teleporter message *back* to the home, so the relayer must be alive in both directions. | Same fix. |
| `expected 32-byte blockchainId, got N from "..."` | Your `network.json` is malformed (rare — file an issue). | Regenerate: `pnpm clean && pnpm up`. |
| `No L1 named "X" in network.json. Available: ...` | `--destination` doesn't match any L1 name. | Use one of the names listed. |

## Type-check only (no network needed)

```bash
cd examples
npx tsc --noEmit -p tsconfig.json
```

This is what CI runs.
