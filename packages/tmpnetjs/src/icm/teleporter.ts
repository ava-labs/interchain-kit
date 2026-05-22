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
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type Chain,
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
export async function deployIcmStack(
  targets: ReadonlyArray<DeployTarget>,
  walletKey: Hex,
): Promise<Map<string, DeployedIcm>> {
  const messengerArtifact = await loadArtifact("TeleporterMessenger");
  const registryArtifact = await loadArtifact("TeleporterRegistry");
  const funder = privateKeyToAccount(walletKey);
  const deployer = privateKeyToAccount(TELEPORTER_DEPLOYER_KEY);

  const out = new Map<string, DeployedIcm>();
  for (const target of targets) {
    const chain = viemChain(target);
    const transport = http(target.rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const funderClient = createWalletClient({ chain, transport, account: funder });
    const walletClient = createWalletClient({ chain, transport, account: deployer });

    // 0) Fund the single-use deployer with 10 AVAX (cheap; just for gas).
    //    Skip if already funded (idempotent across runs).
    const deployerBalance = await publicClient.getBalance({ address: deployer.address });
    if (deployerBalance < parseEther("1")) {
      const fundHash = await funderClient.sendTransaction({
        to: deployer.address,
        value: parseEther("10"),
      });
      await publicClient.waitForTransactionReceipt({ hash: fundHash });
    }

    // 1) Deploy TeleporterMessenger (no constructor args) from nonce 0 of the
    //    dedicated deployer — same address on every chain.
    const messengerTxHash = await walletClient.deployContract({
      abi: messengerArtifact.abi,
      bytecode: messengerArtifact.bytecode.object,
    });
    const messengerReceipt = await publicClient.waitForTransactionReceipt({
      hash: messengerTxHash,
    });
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
    const registryReceipt = await publicClient.waitForTransactionReceipt({
      hash: registryTxHash,
    });
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
