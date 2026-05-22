// Consumer-side artifact loader.
//
// Reads what the producer writes to <workDir>/artifacts/. Walks up from cwd so
// scripts work from anywhere in the repo. Override with $INTERCHAIN_KIT_WORK_DIR.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Abi, Hex } from "viem";
import type { NetworkArtifactDoc, L1Handle } from "../types.js";

const ARTIFACT_DIR_NAME = ".interchain-kit";

/**
 * Walk up from cwd looking for the `.interchain-kit/` workdir that
 * `tmpnetjs up` writes. Override with `$INTERCHAIN_KIT_WORK_DIR`. Throws
 * with a hint if not found.
 */
export function findWorkDir(): string {
  if (process.env.INTERCHAIN_KIT_WORK_DIR) {
    return resolve(process.env.INTERCHAIN_KIT_WORK_DIR);
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ARTIFACT_DIR_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    ".interchain-kit/ not found above cwd. Run `tmpnetjs up` first, " +
      "or set $INTERCHAIN_KIT_WORK_DIR.",
  );
}

function walkUpForFile(relativePath: string[]): string | null {
  if (process.env.INTERCHAIN_KIT_WORK_DIR) {
    const direct = resolve(process.env.INTERCHAIN_KIT_WORK_DIR, ...relativePath.slice(1));
    if (existsSync(direct)) return direct;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ...relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the network.json that `tmpnetjs up` writes. Walks up from cwd looking
 * for `.interchain-kit/artifacts/network.json` so the call works from any
 * subdirectory of the repo. Override with `$INTERCHAIN_KIT_WORK_DIR`.
 */
export function loadNetwork(): NetworkArtifactDoc {
  const found = walkUpForFile([ARTIFACT_DIR_NAME, "artifacts", "network.json"]);
  if (found) return JSON.parse(readFileSync(found, "utf-8")) as NetworkArtifactDoc;
  throw new Error(
    `network.json not found. Run \`tmpnetjs up\` from the repo root first — ` +
      `that boots a local network and writes the artifacts these scripts read.`,
  );
}

/** Pick the L1 with the given `name`, or the first L1 if `name` is undefined. */
export function pickL1(doc: NetworkArtifactDoc, name?: string): L1Handle {
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

/**
 * Load a forge artifact (`contracts/out/<name>.sol/<name>.json`) and return
 * its `abi` + `bytecode`. Walks up from cwd. Throws with a `forge build`
 * hint if missing.
 */
export function loadArtifact(contractName: string): { abi: Abi; bytecode: Hex } {
  const found = walkUpForFile(["contracts", "out", `${contractName}.sol`, `${contractName}.json`]);
  if (found) {
    const j = JSON.parse(readFileSync(found, "utf-8")) as {
      abi: Abi;
      bytecode: { object: Hex };
    };
    return { abi: j.abi, bytecode: j.bytecode.object };
  }
  throw new Error(
    `Forge artifact ${contractName} not found. Run \`forge build --root contracts\` first.`,
  );
}
