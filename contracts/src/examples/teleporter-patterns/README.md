# Teleporter Patterns

Two small, heavily-commented examples that show how to BUILD on top of
Avalanche Teleporter (ICM) — not just how to send a single string.

Both contracts target Solidity `0.8.25`, depend only on `@teleporter/` and
`@openzeppelin/`, and are exercised end-to-end by `FoundryWarpHarness` (the
in-EVM harness that shuttles real warp messages between simulated chains).

## 1. `PingPong.sol` — request / reply

The **same** contract is deployed on two chains. When chain B's `PingPong`
receives a `Ping` from chain A, it immediately fires a `Pong` back to A from
inside its `receiveTeleporterMessage` callback.

Lessons:

- A receiver may send a brand-new Teleporter message during its own delivery —
  this is how request/reply, multi-hop, and ack patterns are built.
- `FoundryWarpHarness.relayAll()` loops over the live queue length, so the
  newly-spawned reply is drained in the same call.
- Every receiver MUST gate `receiveTeleporterMessage` on
  `msg.sender == teleporterMessenger` **and** validate
  `(sourceBlockchainID, originSenderAddress)` against a trusted peer.

## 2. `CrossChainCounter.sol` — cross-chain state mutation

The same contract is deployed on every chain. Each instance owns a local
`value`. `incrementRemote(chainID, amount)` sends a Teleporter message that,
when delivered on the destination, bumps `value` there.

Lessons:

- A peer **registry** (mapping `chainID => peer address`) generalizes
  PingPong's single-peer model to N chains.
- The payload carries the operation data (the increment amount), so the
  destination contract knows exactly what to do.
- Fire-and-forget: no reply is generated.

## Tests

```bash
forge test --root contracts \
    --match-path "test/examples/teleporter-patterns/*" -vv
```

`PingPong.t.sol` asserts that one outbound `ping` triggers exactly two
relayed messages (the ping and its automatic pong), and that the pong
nonce echoes the request nonce.

`CrossChainCounter.t.sol` asserts forward + reverse increments, a 5-message
batch drained in a single `relayAll`, that the amount field is honored, and
that sending to an unconfigured peer reverts.

## Where to go next

- Replace the open `setPeer` calls with owner-gated initializers
  (`Ownable`, multi-sig, or governance).
- Add fees: set `feeInfo.feeTokenAddress` and `feeInfo.amount` so a relayer
  is rewarded for delivering your message in production.
- Graduate to `TeleporterRegistryApp` / `TeleporterRegistryAppUpgradeable`
  if you want versioned messenger lookups via `TeleporterRegistry` instead
  of hardcoding the messenger in the constructor.
