// Post-L1-conversion snapshot/restore.
//
// The slow step in `up` is bootstrapping nodes + converting the subnet to an L1.
// Once we've done that for a given config, we capture the state of every node
// data dir + the artifacts dir into a tarball keyed by a config hash.
//
// Subsequent `up` runs:
//   - hash the config the user passed
//   - if a snapshot exists for that hash, untar it back into place (instant restart)
//   - if not, do the full boot, then snapshot at the end
//
// `up --fresh` skips the restore step (but still re-snapshots at the end).

import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import type { NetworkConfig } from "./types.js";
import { paths } from "./config.js";

/** Hash a config to a short, filesystem-safe key. */
export function configHash(config: NetworkConfig): string {
  // Stable JSON for hashing — sort keys by stringifying explicitly.
  const stable = JSON.stringify({
    primaryNodes: config.primaryNodes,
    l1s: config.l1s.map((l1) => ({
      name: l1.name,
      evmChainId: l1.evmChainId,
      validators: l1.validators,
      rpcNodes: l1.rpcNodes,
      archiveNodes: l1.archiveNodes,
      // Genesis is intentionally part of the snapshot key — a genesis change
      // means a different chain state.
      genesis: l1.genesis ?? null,
    })),
  });
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export function snapshotPath(workDir: string, hash: string): string {
  return path.join(paths(workDir).snapshots, `${hash}.tar.gz`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if a snapshot exists for this config. */
export async function hasSnapshot(workDir: string, hash: string): Promise<boolean> {
  return exists(snapshotPath(workDir, hash));
}

/** Capture the current data + artifacts dirs into a snapshot tarball. */
export async function captureSnapshot(workDir: string, hash: string): Promise<string> {
  const p = paths(workDir);
  await mkdir(p.snapshots, { recursive: true });
  const dest = snapshotPath(workDir, hash);

  // tar -czf <dest> -C <workDir> data artifacts
  const dataExists = await exists(p.data);
  const artifactsExists = await exists(p.artifacts);
  const args = ["-czf", dest, "-C", workDir];
  if (dataExists) args.push("data");
  if (artifactsExists) args.push("artifacts");
  if (args.length === 4) {
    throw new Error("nothing to snapshot: data and artifacts dirs both missing");
  }
  await runTar(args);
  return dest;
}

/** Restore a previously-captured snapshot into the work dir. Wipes existing data/artifacts. */
export async function restoreSnapshot(workDir: string, hash: string): Promise<void> {
  const src = snapshotPath(workDir, hash);
  if (!(await exists(src))) {
    throw new Error(`no snapshot for hash ${hash} at ${src}`);
  }
  const p = paths(workDir);
  // Clear any in-progress dirs first so we don't merge old + new.
  await rm(p.data, { recursive: true, force: true });
  await rm(p.artifacts, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await runTar(["-xzf", src, "-C", workDir]);
}

/** Delete a snapshot. Idempotent. */
export async function deleteSnapshot(workDir: string, hash: string): Promise<void> {
  await rm(snapshotPath(workDir, hash), { force: true });
}

/** List all snapshot hashes currently on disk. */
export async function listSnapshots(workDir: string): Promise<string[]> {
  const dir = paths(workDir).snapshots;
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  return entries
    .filter((e) => e.endsWith(".tar.gz"))
    .map((e) => e.replace(/\.tar\.gz$/, ""));
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}
