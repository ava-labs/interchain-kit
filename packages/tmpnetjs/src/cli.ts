#!/usr/bin/env node
// CLI dispatcher. Calls into ./commands.* once those land.

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

import { up, down, clean } from "./index.js";
import { paths } from "./internal/config.js";

const USAGE = `
tmpnetjs — local Avalanche network for ICM/ICTT dev

  tmpnetjs up      [--fresh]              Boot network + L1 + ICM + relayer
                                          --fresh: skip snapshot restore, cold boot
  tmpnetjs down    [--delete-snapshot]    Stop processes (snapshot kept by default;
                                          pass --delete-snapshot to nuke it too)
  tmpnetjs clean                          Nuke data, snapshots, logs
  tmpnetjs status                         Show running processes + artifact paths

Run with no args to see this help.
`.trim();

interface PidRecordRich {
  name: string;
  pid: number;
  binary?: string;
  logFile?: string;
  kind?: string;
  pgid?: number;
  startedAt?: string;
}

/** Tolerant read of the pid file — accepts both the rich `{processes: []}` shape and the legacy inline `{pids: []}` shape. */
function readPidFileTolerant(pidFile: string): PidRecordRich[] {
  if (!existsSync(pidFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as { processes?: unknown; pids?: unknown };
  // Rich shape wins when both are present.
  if (Array.isArray(obj.processes)) {
    return obj.processes.filter(
      (p): p is PidRecordRich =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { pid?: unknown }).pid === "number",
    );
  }
  if (Array.isArray(obj.pids)) {
    return (obj.pids as unknown[])
      .filter((n): n is number => typeof n === "number")
      .map((pid, i) => ({ name: `pid-${i}`, pid }));
  }
  return [];
}

/** POSIX `kill(pid, 0)` — true if the process exists. */
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function statusCommand(): Promise<number> {
  const workDir = path.resolve(process.cwd(), ".interchain-kit");
  const p = paths(workDir);
  const records = readPidFileTolerant(p.pidFile);

  console.log(`workDir: ${workDir}`);
  console.log("");
  console.log("processes:");
  if (records.length === 0) {
    console.log("  (no pid file — network is down)");
  } else {
    for (const r of records) {
      const alive = isAlive(r.pid) ? "alive" : "dead";
      const kind = r.kind ? ` [${r.kind}]` : "";
      console.log(`  ${r.name}${kind} pid=${r.pid} ${alive}`);
    }
  }

  console.log("");
  console.log("artifacts:");
  const networkJson = path.join(p.artifacts, "network.json");
  const addressesTs = path.join(p.artifacts, "addresses.ts");
  const envFile = path.join(p.artifacts, ".env");
  console.log(`  network.json: ${networkJson}${existsSync(networkJson) ? "" : " (missing)"}`);
  console.log(`  addresses.ts: ${addressesTs}${existsSync(addressesTs) ? "" : " (missing)"}`);
  console.log(`  .env:         ${envFile}${existsSync(envFile) ? "" : " (missing)"}`);

  return 0;
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "up": {
      // `--fresh` skips the snapshot-restore short-circuit in the orchestrator,
      // forcing a cold boot. The end-of-run capture still overwrites any
      // existing snapshot for this config hash.
      const fresh = rest.includes("--fresh");
      await up({ fresh });
      return 0;
    }
    case "down": {
      // `--delete-snapshot` is the destructive opt-in. The default is to
      // keep the snapshot so the next `up` is a fast restore.
      const keepSnapshot = !rest.includes("--delete-snapshot");
      await down({ keepSnapshot });
      return 0;
    }
    case "clean":
      await clean();
      return 0;
    case "status":
      return statusCommand();
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
