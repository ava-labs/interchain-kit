// Chain-time helpers for the local network.
//
// Local subnet-evm/coreth chains only produce blocks on demand, so
// `block.timestamp` stays frozen at the last block until a transaction lands.
// Anything that compares against block.timestamp (timelocks, vesting,
// auctions) appears stuck forever from eth_call / eth_estimateGas's
// perspective — gas estimation evaluates against the latest block, so even a
// transaction that WOULD succeed gets rejected client-side before submission.
//
// `mineBlock` nudges the chain with an empty self-transfer; `waitForChainTime`
// combines wall-clock waiting with nudging until block.timestamp catches up.

import type { Clients } from "./client.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Force the chain to produce one block by sending a zero-value self-transfer
 * from the client's account. The new block is stamped with the node's current
 * wall-clock time, which un-freezes `block.timestamp` for subsequent
 * eth_call / eth_estimateGas.
 */
export async function mineBlock(clients: Clients): Promise<void> {
  const hash = await clients.walletClient.sendTransaction({
    account: clients.account,
    chain: clients.chain,
    to: clients.account.address,
    value: 0n,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Wait until `block.timestamp` on the chain is >= `targetUnixSeconds`.
 *
 * Sleeps while wall-clock time is still short of the target, then mines
 * empty blocks until one is stamped past it. Use this before submitting a
 * transaction guarded by an on-chain time check (e.g. a timelock's
 * `unlockAt`):
 *
 *   await waitForChainTime(clients, unlockAt);
 *   await walletClient.writeContract({ functionName: "executeQueuedWithdrawal", ... });
 */
export async function waitForChainTime(
  clients: Clients,
  targetUnixSeconds: bigint | number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const target = BigInt(targetUnixSeconds);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const block = await clients.publicClient.getBlock();
    if (block.timestamp >= target) return;

    const wallMsRemaining = Number(target) * 1000 - Date.now();
    if (wallMsRemaining > 0) {
      // Wall clock hasn't reached the target yet — no point mining, a new
      // block would still be stamped too early.
      await sleep(Math.min(wallMsRemaining + 500, 5_000));
    } else {
      // Wall clock is past the target but the chain head predates it: mint a
      // fresh block so block.timestamp advances to "now".
      await mineBlock(clients);
    }
  }
  throw new Error(
    `Timed out after ${opts.timeoutMs ?? 120_000}ms waiting for chain time to reach ${target}.`,
  );
}
