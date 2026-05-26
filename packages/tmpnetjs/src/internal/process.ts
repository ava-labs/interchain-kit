// Small helper for spawning long-lived child processes (avalanchego nodes,
// icm-relayer, signature-aggregator). Tracks PIDs in a JSON file so a later
// `interchain-kit down` can reap them, and tees stdout/stderr to per-process
// log files so failures are debuggable after the fact.
//
// Process-group strategy
// ----------------------
// avalanchego launches subnet-evm via go-plugin as a gRPC subprocess. SIGTERM
// to the avalanchego parent does NOT reliably cascade to the plugin child —
// users were seeing leftover `srEXiWaHuhNy…` PPID=1 orphans after `down`.
//
// To fix this we spawn every long-lived child with `detached: true`. On POSIX
// that makes the child a process-group leader: pgid == pid. We then record the
// pgid alongside the pid and have {@link killTracked} signal the whole group
// (`process.kill(-pgid, …)`) — every descendant the parent forked inherits the
// same pgid and gets reaped together.
//
// We still call `child.unref()` after spawn so Node doesn't keep the event
// loop alive while these are running; the orchestrator returns to its caller
// once the network is healthy.

import {
  ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import type { ProcessHandle } from "../types.js";

/** Process role — used by `down()` to pick a kill order. */
export type ProcessKind = "primary" | "l1" | "relayer" | "sigagg";

/** Per-role record in the PID-tracking file. */
export interface PidRecord {
  name: string;
  pid: number;
  /**
   * POSIX process group id. With `detached: true` this equals `pid`. Kept
   * separately so we can `process.kill(-pgid, sig)` to signal the whole
   * group — necessary for avalanchego's subnet-evm plugin children to die
   * with their parent.
   */
  pgid: number;
  /** Lifecycle category — drives the order in which `down()` reaps. */
  kind: ProcessKind;
  binary: string;
  logFile: string;
  /** ISO 8601 timestamp of when we started it. Diagnostic only. */
  startedAt: string;
}

/** What the PID file looks like on disk. */
export interface PidFileContents {
  /** Snapshot key for the config that produced this network (sha256/16). */
  hash?: string;
  processes: PidRecord[];
}

/** Options forwarded to {@link spawnTracked}. */
export interface SpawnTrackedOptions {
  /** Working directory for the child. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra environment variables, merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Path to the JSON PID file. We append a record on each spawn. */
  pidFile: string;
  /** Lifecycle category for this process — see {@link ProcessKind}. */
  kind: ProcessKind;
}

/**
 * Spawn a detached child process (its own process group) whose stdout/stderr
 * are redirected to `logFile`. `detached: true` makes the child a
 * process-group leader so {@link killTracked} can reap it AND any
 * grandchildren (avalanchego → subnet-evm plugin) in one signal.
 *
 * Idempotency: if `pidFile` already records a still-running process with the
 * same `name`, we return that existing handle instead of spawning a duplicate.
 * The same node restarting on the same data dir would otherwise corrupt the
 * staking DB.
 *
 * @param name - Stable identifier for this process (e.g. "node-0", "relayer").
 *   Used as the dedupe key in the PID file.
 * @param binary - Absolute path to the executable.
 * @param args - CLI args to pass.
 * @param logFile - Where stdout/stderr go (created/appended; parent dirs made).
 * @param opts - PID tracking + spawn options.
 */
export function spawnTracked(
  name: string,
  binary: string,
  args: readonly string[],
  logFile: string,
  opts: SpawnTrackedOptions,
): ProcessHandle {
  // If we already have a healthy record for this name, return it as-is. Lets
  // `interchain-kit up` be a no-op when everything's already running.
  const existing = findRunning(opts.pidFile, name);
  if (existing) {
    return {
      pid: existing.pid,
      binary: existing.binary,
      logFile: existing.logFile,
    };
  }

  // Ensure the log directory exists, then open it in append mode so we don't
  // truncate prior runs. The fd is closed in the parent after spawn() — the
  // child inherits its own dup.
  mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, "a");

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    // Child reads nothing from us; stdout/stderr both go to the log file.
    stdio: ["ignore", logFd, logFd],
    // Make the child a process-group leader so killTracked can reap the
    // whole subtree (incl. avalanchego's subnet-evm plugin grandchild).
    detached: true,
    windowsHide: true,
  };

  let child: ChildProcess;
  try {
    child = spawn(binary, args as string[], spawnOpts);
  } finally {
    // Parent doesn't need to keep the fd open — the child has its own dup.
    closeSync(logFd);
  }

  if (child.pid === undefined) {
    throw new Error(
      `spawn(${binary}) returned no PID; the binary likely failed to launch. ` +
        `Check ${logFile} for details.`,
    );
  }

  // Detach the child from our event loop. Without unref(), Node would refuse
  // to exit while these are running, which is the opposite of what we want for
  // a CLI that returns once the network is up.
  child.unref();

  // With `detached: true` on POSIX, the kernel sets pgid = pid. We record it
  // explicitly so a future killTracked can use process.kill(-pgid, ...) even
  // if libc-level getpgid is unavailable.
  const pgid = child.pid;

  // Record the new process in the PID file. Subsequent spawns will see it
  // and skip duplication.
  appendPid(opts.pidFile, {
    name,
    pid: child.pid,
    pgid,
    kind: opts.kind,
    binary,
    logFile,
    startedAt: new Date().toISOString(),
  });

  return {
    pid: child.pid,
    binary,
    logFile,
  };
}

/** Read the PID file, returning {processes: []} when missing/corrupt. */
export function readPidFile(pidFile: string): PidFileContents {
  if (!existsSync(pidFile)) {
    return { processes: [] };
  }
  try {
    const raw = readFileSync(pidFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PidFileContents>;
    if (!parsed || !Array.isArray(parsed.processes)) {
      return { processes: [] };
    }
    return {
      hash: parsed.hash,
      // Backward-compat: tolerate records missing pgid/kind from older runs.
      processes: parsed.processes.map((p) => ({
        ...p,
        pgid: p.pgid ?? p.pid,
        kind: p.kind ?? "primary",
      })),
    };
  } catch {
    // A corrupt PID file is recoverable — we just lose idempotency for this
    // run. Don't crash the orchestration over it.
    return { processes: [] };
  }
}

/** Persist `hash` into the PID file without disturbing the process list. */
export function setPidFileHash(pidFile: string, hash: string): void {
  mkdirSync(path.dirname(pidFile), { recursive: true });
  const current = readPidFile(pidFile);
  writeFileSync(
    pidFile,
    JSON.stringify({ hash, processes: current.processes }, null, 2),
    "utf8",
  );
}

/** Atomically append a record. Multiple roles call this serially. */
export function appendPid(pidFile: string, record: PidRecord): void {
  mkdirSync(path.dirname(pidFile), { recursive: true });
  const current = readPidFile(pidFile);
  // Replace any existing record with the same name — older entry is stale.
  const filtered = current.processes.filter((p) => p.name !== record.name);
  filtered.push(record);
  writeFileSync(
    pidFile,
    JSON.stringify({ hash: current.hash, processes: filtered }, null, 2),
    "utf8",
  );
}

/**
 * Look up a record by name and verify the OS still knows about that PID.
 * Returns undefined if the process exited or the record is missing.
 */
export function findRunning(
  pidFile: string,
  name: string,
): PidRecord | undefined {
  const { processes } = readPidFile(pidFile);
  const record = processes.find((p) => p.name === name);
  if (!record) return undefined;
  return isProcessAlive(record.pid) ? record : undefined;
}

/**
 * POSIX trick: `kill(pid, 0)` doesn't actually send a signal; it just returns
 * success if the process exists and we have permission to signal it. Used by
 * idempotency check above.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still
    // counts as "alive" for our purposes).
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Send a signal to the entire process group led by `pgid`. Falls back to
 * signaling the bare pid if the group send fails (e.g. on a host that didn't
 * actually detach the child — rare, but defensive).
 */
function signalGroup(record: PidRecord, signal: NodeJS.Signals): void {
  // process.kill(-pgid, ...) signals every member of the group. The negative
  // sign is the POSIX convention; Node forwards it directly to killpg(2).
  try {
    process.kill(-record.pgid, signal);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH from group kill on macOS can mean the leader already exited but
    // children survive; fall through to individual pid signaling.
    if (code !== "ESRCH" && code !== "EPERM") return;
  }
  try {
    process.kill(record.pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * SIGTERM the process group, wait `graceMs`, then SIGKILL anything still
 * alive. Used by `interchain-kit down`. Best-effort: if the PID is already
 * gone, we treat that as success.
 */
export async function killTracked(
  record: PidRecord,
  graceMs = 3000,
): Promise<void> {
  if (!isProcessAlive(record.pid)) return;
  signalGroup(record, "SIGTERM");
  // Give the process group a moment to exit cleanly before escalating.
  await new Promise((r) => setTimeout(r, graceMs));
  if (isProcessAlive(record.pid)) {
    signalGroup(record, "SIGKILL");
  }
}
