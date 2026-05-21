# @interchain-kit/harness

Two solidity files that let Foundry tests exercise **real** `icm-contracts`
(Teleporter + ICTT) end-to-end inside a single EVM:

- `FoundryWarpHarness.sol` — deploys Teleporter + Registry per simulated chain, shuttles warp messages between them.
- `MockWarpPrecompile.sol` — etched at the subnet-evm Warp precompile address (`0x0200...05`). Per-caller chain IDs, message queue, returns inflight messages with correct origin.

## How tests use it

```solidity
import {FoundryWarpHarness} from "@interchain-kit/harness/FoundryWarpHarness.sol";

contract MyTest is Test {
    function setUp() public {
        FoundryWarpHarness harness = new FoundryWarpHarness();
        (TeleporterRegistry regA, TeleporterMessenger msgrA) = harness.deployChain(CHAIN_A_ID);
        (TeleporterRegistry regB, TeleporterMessenger msgrB) = harness.deployChain(CHAIN_B_ID);
        // Deploy your contracts on each "chain" using the registry addresses.
    }

    function test_crosschain_thing() public {
        // ... do thing that emits a warp message on chain A ...
        harness.relayAll();   // delivers all queued messages to their destinations
        // ... assert state on chain B ...
    }
}
```

## What is faked

Only the subnet-evm Warp precompile (`0x0200000000000000000000000000000000000005`).
Everything else — `TeleporterMessenger`, `TeleporterRegistry`, `ERC20TokenHome`,
`ERC20TokenRemote`, etc. — is the unmodified source from `ava-labs/icm-contracts`.

## Why this exists

Running tmpnet + relayer + sig-aggregator for every solidity change is slow
(tens of seconds per iteration). The harness gives you the same correctness
guarantees for ICM/ICTT logic in ~100ms per test, so the TDD loop stays fast.
Use the tmpnet flow (see repo root) for true end-to-end validation before
shipping.
