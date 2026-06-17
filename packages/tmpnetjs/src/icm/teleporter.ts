// Deploy TeleporterMessenger + TeleporterRegistry to every chain in the
// network.
//
// On mainnet/testnet TeleporterMessenger is deployed via a Nick's-method-style
// universal deployer (deterministic CREATE2 from a known EOA) so that the
// messenger address is identical across every chain. For local nets we don't
// need that property — we just deploy normally from our funded account. The
// resulting address WILL differ from the canonical 0x253b2784… mainnet/testnet
// address. Anything that hard-codes the canonical address must read the value
// emitted in `addresses.ts` / `.env` instead.
//
// Registry: TeleporterRegistry takes `(version, protocolAddress)[]` initial
// entries. We seed it with `[(1, messenger)]` so `getLatestTeleporter()`
// resolves immediately after deploy.

import { accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  parseEther,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Single-use Teleporter deployer. Distinct from the funded EWOQ + relayer
 * keys. We use a fresh account so deploys execute from nonce 0 on every chain
 * (CREATE addresses are a function of (deployer, nonce) — same on both → same
 * Teleporter address everywhere, which icm-relayer relies on to find the
 * destination's Teleporter contract).
 *
 * Anvil[1]. Local-only.
 */
const TELEPORTER_DEPLOYER_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

import type { ChainHandle } from "../types.js";

/** Subset of ChainHandle required to deploy ICM on it. */
export interface DeployTarget {
  name: string;
  evmChainId: number;
  rpcUrl: string;
}

export interface DeployedIcm {
  teleporter: Address;
  teleporterRegistry: Address;
}

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Locate <monorepoRoot>/contracts/out. Walk up from this file until we find a
 * directory containing `contracts/foundry.toml`.
 */
function resolveContractsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "contracts", "foundry.toml");
    try {
      accessSync(candidate);
      return path.join(dir, "contracts");
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate <monorepoRoot>/contracts/foundry.toml when looking " +
      `for forge artifacts (started from ${__dirname}).`,
  );
}

async function loadArtifact(name: string): Promise<ForgeArtifact> {
  const outDir = path.join(resolveContractsDir(), "out", `${name}.sol`, `${name}.json`);
  const raw = await readFile(outDir, "utf8");
  const json = JSON.parse(raw) as ForgeArtifact;
  if (!json.bytecode?.object || json.bytecode.object === "0x") {
    throw new Error(
      `Forge artifact for ${name} at ${outDir} has empty bytecode. ` +
        `Run \`forge build --root ${resolveContractsDir()}\` first.`,
    );
  }
  return json;
}

/** Minimal viem Chain object for a local EVM chain — only chainId is enforced. */
function viemChain(target: DeployTarget): Chain {
  return {
    id: target.evmChainId,
    name: target.name,
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [target.rpcUrl] } },
  };
}

/**
 * Deploy TeleporterMessenger + TeleporterRegistry to every chain in `targets`.
 * Returns a map keyed by chain name.
 */
/**
 * Wait for a transaction receipt, tolerating a fresh C-Chain whose very first
 * block hasn't been accepted yet.
 *
 * coreth returns `eth_getTransactionByHash` WITH a blockNumber for a tx sitting
 * in a built-but-not-yet-accepted block, while `eth_getTransactionReceipt`
 * stays null until that block is *accepted* (~1s later, gated by proposerVM's
 * min-block-delay). viem's stock `waitForTransactionReceipt` reads that
 * intermediate state as a possible replacement and rejects with
 * `TransactionReceiptNotFoundError` almost immediately — before the block is
 * ever accepted. The L1 chains dodge this because they get explicit warm-up
 * txs; the C-Chain's first-ever tx (funding the Teleporter deployer) hits it
 * every cold boot. Poll the receipt directly instead, swallowing not-found
 * until the block lands.
 */
export async function waitForReceipt(
  client: PublicClient,
  hash: Hex,
  timeoutMs = 120_000,
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (err) {
      if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for receipt of ${hash}. ` +
            `The tx was accepted into the mempool but no block carrying it was ever ` +
            `accepted — check the owning chain's node log for a stalled VM.`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function deployIcmStack(
  targets: ReadonlyArray<DeployTarget>,
  walletKey: Hex,
): Promise<Map<string, DeployedIcm>> {
  const messengerArtifact = await loadArtifact("TeleporterMessenger");
  const registryArtifact = await loadArtifact("TeleporterRegistry");
  const funder = privateKeyToAccount(walletKey);
  const deployer = privateKeyToAccount(TELEPORTER_DEPLOYER_KEY);

  // Canonical addresses the deployer reaches from nonces 0 and 1. Both must
  // match on every chain — that's the whole point of the single-use deployer.
  // If they don't (e.g. the data dir was reused from a prior run that already
  // bumped the deployer's nonce on one chain but not others), the relayer
  // will fail because it assumes one Teleporter address per chain.
  const canonicalTeleporter = getContractAddress({ from: deployer.address, nonce: 0n });
  const canonicalRegistry = getContractAddress({ from: deployer.address, nonce: 1n });

  const out = new Map<string, DeployedIcm>();
  for (const target of targets) {
    const chain = viemChain(target);
    const transport = http(target.rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const funderClient = createWalletClient({ chain, transport, account: funder });
    const walletClient = createWalletClient({ chain, transport, account: deployer });

    // Idempotent: if Teleporter is already at the canonical address (e.g.
    // because the C-Chain state was restored from a previous run's snapshot),
    // reuse it instead of re-deploying. Re-deploying from a non-zero deployer
    // nonce would land Teleporter at a different address, breaking the
    // universal-deployer invariant the relayer depends on.
    const existingCode = await publicClient.getCode({ address: canonicalTeleporter });
    if (existingCode && existingCode !== "0x") {
      out.set(target.name, {
        teleporter: canonicalTeleporter,
        teleporterRegistry: canonicalRegistry,
      });
      continue;
    }

    // 0) Fund the single-use deployer with 10 AVAX (cheap; just for gas).
    //    Skip if already funded (idempotent across runs).
    const deployerBalance = await publicClient.getBalance({ address: deployer.address });
    if (deployerBalance < parseEther("1")) {
      const fundHash = await funderClient.sendTransaction({
        to: deployer.address,
        value: parseEther("10"),
      });
      await waitForReceipt(publicClient, fundHash);
    }

    // Defensive: confirm the deployer's nonce is 0 before deploying. If it
    // isn't, the chain was used previously and continuing would land
    // Teleporter at a non-canonical address.
    const deployerNonce = await publicClient.getTransactionCount({
      address: deployer.address,
    });
    if (deployerNonce !== 0) {
      throw new Error(
        `Teleporter deployer ${deployer.address} has nonce ${deployerNonce} on ${target.name} ` +
          `but no Teleporter at the canonical address ${canonicalTeleporter}. ` +
          `The chain state appears to be from a partial prior run — run \`pnpm run clean\` and try again.`,
      );
    }

    // 1) Deploy TeleporterMessenger (no constructor args) from nonce 0 of the
    //    dedicated deployer — same address on every chain.
    const messengerTxHash = await walletClient.deployContract({
      abi: messengerArtifact.abi,
      bytecode: messengerArtifact.bytecode.object,
    });
    const messengerReceipt = await waitForReceipt(publicClient, messengerTxHash);
    if (!messengerReceipt.contractAddress) {
      throw new Error(`TeleporterMessenger deploy on ${target.name} returned no contractAddress`);
    }
    const teleporter = messengerReceipt.contractAddress;

    // 2) Deploy TeleporterRegistry with [(1, messenger)] seed.
    const registryTxHash = await walletClient.deployContract({
      abi: registryArtifact.abi,
      bytecode: registryArtifact.bytecode.object,
      args: [[{ version: 1n, protocolAddress: teleporter }]],
    });
    const registryReceipt = await waitForReceipt(publicClient, registryTxHash);
    if (!registryReceipt.contractAddress) {
      throw new Error(`TeleporterRegistry deploy on ${target.name} returned no contractAddress`);
    }

    out.set(target.name, {
      teleporter,
      teleporterRegistry: registryReceipt.contractAddress,
    });
  }
  return out;
}

/** Convenience: merge deployment results into existing ChainHandles. */
export function applyIcmAddresses<T extends ChainHandle>(
  chains: T[],
  deployed: Map<string, DeployedIcm>,
): T[] {
  return chains.map((c) => {
    const d = deployed.get(c.name);
    if (!d) throw new Error(`No ICM deployment found for chain "${c.name}"`);
    return { ...c, teleporter: d.teleporter, teleporterRegistry: d.teleporterRegistry };
  });
}
