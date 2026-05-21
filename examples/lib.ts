// =============================================================================
//  examples/lib.ts — shared helpers for the demo scripts
// -----------------------------------------------------------------------------
//  Both send-message.ts and transfer-token.ts share three things:
//
//   1. Reading the network.json that `pnpm up` writes to .interchain-kit/.
//   2. Building viem clients (one public + one wallet) for any ChainHandle.
//   3. Converting a chain's cb58 blockchainId into the bytes32 form Teleporter
//      expects.
//
//  We keep this file dependency-light: viem + @avalabs/avalanchejs (for cb58).
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Hex,
  type Address,
  type PublicClient,
  type WalletClient,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";

import type { NetworkArtifactDoc, ChainHandle } from "../packages/tmpnet/src/types.js";

// ----- Network loading -----------------------------------------------------

/**
 * Read the network.json that `pnpm up` writes. We resolve relative to CWD so
 * users can run the scripts from anywhere in the repo.
 *
 * Throws with a clear message if the file is missing — the most common
 * "I just cloned this" failure mode.
 */
export function loadNetwork(): NetworkArtifactDoc {
  // Walk up from cwd looking for .interchain-kit/artifacts/network.json. Lets
  // these scripts be invoked from anywhere in the repo. Override with
  // INTERCHAIN_KIT_WORK_DIR=<path> if you keep state elsewhere.
  const candidates: string[] = [];
  if (process.env.INTERCHAIN_KIT_WORK_DIR) {
    candidates.push(resolve(process.env.INTERCHAIN_KIT_WORK_DIR, "artifacts", "network.json"));
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(resolve(dir, ".interchain-kit", "artifacts", "network.json"));
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    if (existsSync(c)) return JSON.parse(readFileSync(c, "utf-8")) as NetworkArtifactDoc;
  }
  throw new Error(
    `network.json not found. Tried:\n${candidates.map((c) => `  ${c}`).join("\n")}\n\n` +
      `Run \`pnpm up\` from the repo root first — that boots a local network ` +
      `and writes the artifacts these scripts read.`,
  );
}

// ----- Viem client construction --------------------------------------------

/**
 * Build a viem `chain` object for one of our local chains. viem needs this for
 * tx defaults (chainId, native currency, RPC URLs).
 */
function viemChainFor(handle: ChainHandle) {
  return defineChain({
    id: handle.evmChainId,
    name: handle.name,
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [handle.rpcUrl] } },
  });
}

/** A bundle of viem clients for a single chain — public reads + wallet writes. */
export interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: ReturnType<typeof viemChainFor>;
  account: ReturnType<typeof privateKeyToAccount>;
}

export function makeClients(handle: ChainHandle, privateKey: Hex): Clients {
  const chain = viemChainFor(handle);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(handle.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(handle.rpcUrl), account });
  return { publicClient, walletClient, chain, account };
}

// ----- cb58 → bytes32 -------------------------------------------------------

/**
 * Teleporter identifies destination L1s by `bytes32` (the chain's UUID). The
 * Avalanche RPCs and our network.json use the cb58 string form. Convert.
 *
 * cb58 layout: base58( payload || sha256(payload)[..4] ).
 *
 * We inline a small base58 decoder (Bitcoin alphabet) to keep this script
 * dependency-free. A full impl is ~30 lines; not worth pulling another dep.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array();
  // Big-int accumulator: result = sum(alphabet.indexOf(char) * 58^i).
  let n = 0n;
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 char "${ch}"`);
    n = n * 58n + BigInt(idx);
  }
  // Convert big-int to bytes (big-endian).
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Re-add leading zero bytes lost to base58's positional notation (each
  // leading '1' in the encoded string is a leading 0x00 in the bytes).
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
}

export function blockchainIdToBytes32(cb58Id: string): Hex {
  const raw = base58Decode(cb58Id);
  if (raw.length < 4) throw new Error(`cb58 string too short: "${cb58Id}"`);
  const payload = raw.slice(0, -4);
  const checksum = raw.slice(-4);
  // Avalanche cb58 uses the LAST 4 bytes of sha256(payload) — NOT the first 4
  // like Bitcoin Base58Check. Differs from every other reference impl, easy
  // gotcha.
  const expected = createHash("sha256").update(payload).digest().subarray(-4);
  if (!checksum.every((b, i) => b === expected[i])) {
    throw new Error(`cb58 checksum mismatch on "${cb58Id}"`);
  }
  if (payload.length !== 32) {
    throw new Error(`expected 32-byte blockchainId, got ${payload.length} from "${cb58Id}"`);
  }
  return ("0x" + Buffer.from(payload).toString("hex")) as Hex;
}

// ----- Forge artifact loading ----------------------------------------------

/**
 * Load a forge artifact (out/Foo.sol/Foo.json) and return its abi + bytecode.
 *
 * Pointed at the repo's `contracts/out/` directory. If the file is missing we
 * throw a hint telling the user to `forge build` — much friendlier than the
 * default ENOENT.
 */
export function loadArtifact(contractName: string): { abi: Abi; bytecode: Hex } {
  // Walk up looking for contracts/out/<name>.sol/<name>.json so this works
  // when called from anywhere in the repo tree.
  const candidates: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(resolve(dir, "contracts", "out", `${contractName}.sol`, `${contractName}.json`));
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
    }
  }
  throw new Error(
    `Forge artifact not found. Tried:\n${candidates.map((c) => `  ${c}`).join("\n")}\n\n` +
      `Run \`forge build --root contracts\` first so the ABIs + bytecode exist.`,
  );
}

// ----- Polling --------------------------------------------------------------

/**
 * Poll `read()` until `predicate(value)` is true, or we hit `timeoutMs`. Uses
 * a gentle linear backoff (1s → 2s → 3s …) capped at 5s.
 *
 * Returns the final value on success; throws on timeout. We keep this simple
 * on purpose — production code should use websocket subscriptions instead.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = opts.label ?? "condition";
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    attempt += 1;
    const wait = Math.min(5_000, 1_000 * attempt);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

// ----- CLI args -------------------------------------------------------------

/** Tiny `--flag value` parser. Returns `{ amount?, destination? }`. */
export function parseArgs(argv: string[]): { amount?: string; destination?: string } {
  const out: { amount?: string; destination?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--amount") out.amount = argv[++i];
    else if (a === "--destination") out.destination = argv[++i];
  }
  // Env vars as fallback (handy for `make` / CI).
  if (!out.amount && process.env.AMOUNT) out.amount = process.env.AMOUNT;
  if (!out.destination && process.env.DESTINATION) out.destination = process.env.DESTINATION;
  return out;
}

/** Pick the L1 the user asked for, or the first L1 if no name was given. */
export function pickDestination(
  doc: NetworkArtifactDoc,
  name?: string,
): NetworkArtifactDoc["l1s"][number] {
  if (doc.l1s.length === 0) {
    throw new Error("No L1s in network.json — your config has only the primary network.");
  }
  if (!name) return doc.l1s[0]!;
  const match = doc.l1s.find((l1) => l1.name === name);
  if (!match) {
    const names = doc.l1s.map((l) => l.name).join(", ");
    throw new Error(`No L1 named "${name}" in network.json. Available: ${names}`);
  }
  return match;
}

/** Re-export so the demo scripts only need to import from lib.ts. */
export type { NetworkArtifactDoc, Address };
