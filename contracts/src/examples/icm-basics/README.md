# ICM Basics — Hello, Avalanche

The "Hello, World!" of Avalanche **Interchain Messaging (ICM)**. A
`SimpleSender` contract on Chain A ships a `string` to a `SimpleReceiver`
contract on Chain B. The receiver stores the latest message and a full history
of every message it has ever received.

This example is designed to be the **first** thing a Solidity developer reads
when learning ICM. It introduces the core pattern in ~100 lines of contract
code with zero distractions.

## What is ICM?

Interchain Messaging is the protocol that lets contracts on one Avalanche L1
talk to contracts on another L1. Conceptually:

1. Your contract on Chain A calls `TeleporterMessenger.sendCrossChainMessage`,
   passing the destination chain ID, destination address, and a `bytes` payload.
2. Chain A's validators sign an attestation of that message via the **Warp
   precompile** (a low-level cryptographic primitive built into the EVM on
   Avalanche L1s).
3. An off-chain **relayer** picks up the attested message and submits it to
   the `TeleporterMessenger` on Chain B.
4. Chain B's messenger verifies the attestation and calls
   `receiveTeleporterMessage(sourceBlockchainID, originSenderAddress, message)`
   on your destination contract.

Your application code only ever interacts with the friendly
`TeleporterMessenger` API — Warp signatures and relayer logistics are handled
for you.

## Files

| File | Role |
|---|---|
| [`SimpleSender.sol`](./SimpleSender.sol) | Lives on Chain A. Exposes `sendMessage(destChainID, destAddress, message)`. |
| [`SimpleReceiver.sol`](./SimpleReceiver.sol) | Lives on Chain B. Inherits `TeleporterRegistryApp` and overrides `_receiveTeleporterMessage` to store the message. |

The matching tests are in
[`contracts/test/examples/icm-basics/SimpleMessage.t.sol`](../../../test/examples/icm-basics/SimpleMessage.t.sol).

## Running the tests

The tests use `FoundryWarpHarness` to simulate two L1s inside a single Foundry
EVM — no networks, no relayer, no Avalanche CLI required. The harness queues
warp messages and delivers them when you call `harness.relayAll()`.

```bash
forge test \
  --root contracts \
  --match-path "test/examples/icm-basics/*" \
  -vv
```

You should see three passing tests:

- `test_sendAndReceive_happyPath` — one message round-trip.
- `test_originSenderAddress_isSenderContract` — proves the `originSenderAddress`
  delivered to the receiver is the **sender contract**, not the EOA that called
  it. (Important for access control on the destination.)
- `test_multipleMessages_preserveOrderAndHistory` — three sequential messages
  arrive in order and the history array is populated correctly.

## Key takeaways

- **Encoding is your responsibility.** Both sides agree on how the
  `bytes message` is encoded. Here we use `abi.encode(string)` /
  `abi.decode(bytes, (string))`. For richer payloads, encode a struct.
- **Inherit `TeleporterRegistryApp`** on the receiver instead of implementing
  `ITeleporterReceiver` directly. The base contract handles version checks,
  pausing, and reentrancy protection — three things you'd otherwise have to
  rebuild yourself.
- **`originSenderAddress` is non-spoofable** — it's whatever address called
  `sendCrossChainMessage` on the source chain. If you want to authenticate
  "this message came from MyTrustedContract on Chain A", compare against
  *that contract address*, not against any user EOA.
- **Fees are optional.** This example uses zero-fee messages, which is fine
  for tests and demos. In production you'll set a `TeleporterFeeInfo` with an
  ERC-20 token + amount to incentivize relayers.

## Next steps

Once you've internalized this pattern, move on to:

- `ictt-erc20/` — using ICM to ship ERC-20 tokens between chains.
- `teleporter-patterns/` — request/response, multi-hop, and other recipes.
