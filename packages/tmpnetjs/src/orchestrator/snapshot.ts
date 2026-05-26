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
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import type { NetworkConfig } from "../types.js";
import { paths } from "../internal/config.js";

/**
 * Current snapshot metadata schema version. Bump when the shape of
 * `SnapshotMeta` changes incompatibly so existing snapshots are ignored.
 */
const SNAPSHOT_META_VERSION = 1;

/** Sidecar metadata written alongside every snapshot tarball. */
export interface SnapshotMeta {
  /** Schema version. Mismatched versions are treated as stale. */
  version: number;
  /** Hash of the NetworkConfig that produced this snapshot. */
  configHash: string;
  /** Absolute path to the avalanchego binary used. Diagnostic. */
  avalanchegoBinaryPath: string;
  /** Cheap "binary identity" proxy — `<mtimeMs>:<size>`. */
  avalanchegoBinaryFingerprint: string;
  /** ISO 8601 capture timestamp. Diagnostic only. */
  capturedAt: string;
}

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

/** Sidecar meta path: same dir as the tarball, `.meta.json` suffix. */
export function snapshotMetaPath(workDir: string, hash: string): string {
  return path.join(paths(workDir).snapshots, `${hash}.meta.json`);
}

/**
 * Compute a cheap, stable identity for an avalanchego binary. We use
 * `<mtimeMs>:<size>` rather than a content hash — rebuilding the binary
 * always touches both fields, and skipping the SHA keeps `up` quick on
 * cold start when no snapshot exists yet.
 */
async function fingerprintBinary(binaryPath: string): Promise<string> {
  const st = await stat(binaryPath);
  return `${Math.floor(st.mtimeMs)}:${st.size}`;
}

/** Resolve the avalanchego binary the same way the runtime does. */
function resolveAvalanchegoPath(): string {
  return process.env.AVALANCHEGO_PATH ?? "avalanchego";
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

/**
 * Capture the current data + artifacts dirs into a snapshot tarball AND a
 * sidecar `.meta.json` describing the binary + config that produced it.
 * Subsequent `restoreSnapshot` calls validate the meta before extracting —
 * an avalanchego upgrade or config change is treated as a cold boot, not a
 * silent restore of stale state.
 */
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

  // Write sidecar meta. If the binary is unresolvable for any reason, drop a
  // best-effort fingerprint of "unknown" — the snapshot is still usable but
  // a follow-up restore will refuse it (which is the safer default).
  const binaryPath = resolveAvalanchegoPath();
  let fingerprint = "unknown";
  try {
    fingerprint = await fingerprintBinary(binaryPath);
  } catch {
    // Binary not at this path — leave fingerprint as "unknown" so any
    // subsequent restore is forced to ignore the snapshot.
  }
  const meta: SnapshotMeta = {
    version: SNAPSHOT_META_VERSION,
    configHash: hash,
    avalanchegoBinaryPath: binaryPath,
    avalanchegoBinaryFingerprint: fingerprint,
    capturedAt: new Date().toISOString(),
  };
  await writeFile(snapshotMetaPath(workDir, hash), JSON.stringify(meta, null, 2), "utf8");
  return dest;
}

/**
 * Read the snapshot sidecar meta. Returns null if missing/corrupt/wrong
 * schema version — caller treats null as "snapshot is not safe to restore".
 */
export async function readSnapshotMeta(
  workDir: string,
  hash: string,
): Promise<SnapshotMeta | null> {
  const metaPath = snapshotMetaPath(workDir, hash);
  if (!(await exists(metaPath))) return null;
  try {
    const raw = await readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SnapshotMeta>;
    if (
      parsed.version !== SNAPSHOT_META_VERSION ||
      typeof parsed.configHash !== "string" ||
      typeof parsed.avalanchegoBinaryFingerprint !== "string"
    ) {
      return null;
    }
    return parsed as SnapshotMeta;
  } catch {
    return null;
  }
}

/**
 * Validate a snapshot's sidecar meta against the live environment. Returns
 * `{ ok: true }` if restore is safe, or `{ ok: false, reason }` if the
 * snapshot was captured against a different binary/config/schema. Reason
 * is human-readable and meant to be logged by the caller.
 */
export async function validateSnapshot(
  workDir: string,
  hash: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const meta = await readSnapshotMeta(workDir, hash);
  if (!meta) {
    return { ok: false, reason: "snapshot has no meta sidecar (or unknown schema)" };
  }
  if (meta.configHash !== hash) {
    return {
      ok: false,
      reason: `snapshot configHash ${meta.configHash} != current ${hash}`,
    };
  }
  let liveFingerprint = "unknown";
  try {
    liveFingerprint = await fingerprintBinary(resolveAvalanchegoPath());
  } catch {
    return { ok: false, reason: "current avalanchego binary not found on disk" };
  }
  if (meta.avalanchegoBinaryFingerprint !== liveFingerprint) {
    return {
      ok: false,
      reason: `avalanchego binary changed (snapshot=${meta.avalanchegoBinaryFingerprint}, live=${liveFingerprint})`,
    };
  }
  return { ok: true };
}

/**
 * Restore a previously-captured snapshot into the work dir. Wipes existing
 * data/artifacts. Throws if the snapshot tarball is missing — does NOT
 * throw on meta mismatch, since the orchestrator should pre-validate with
 * `validateSnapshot` and fall through to cold boot when the answer is no.
 */
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

/** Delete a snapshot (tarball + meta sidecar). Idempotent. */
export async function deleteSnapshot(workDir: string, hash: string): Promise<void> {
  await rm(snapshotPath(workDir, hash), { force: true });
  await rm(snapshotMetaPath(workDir, hash), { force: true });
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
