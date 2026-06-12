// Preflight checks run at the top of `up()` so misconfigurations fail in
// milliseconds with an actionable message, instead of minutes later behind a
// bootstrap timeout whose real cause is buried in a node log.

import { execSync } from "node:child_process";
import { createServer } from "node:net";

import { readPidFile } from "./process.js";

/**
 * Thrown by preflight checks, always BEFORE anything is spawned. `up()`'s
 * failure path must NOT reap on these — the pid file still describes the
 * previous (possibly healthy) network, and reaping it would kill the very
 * processes the error tells the user to shut down deliberately.
 */
export class PreflightError extends Error {}

/**
 * Parse the RPCChainVM protocol version a binary implements.
 *
 *   - avalanchego: `--version-json` → `{ ..., "rpcchainvm": 44 }`
 *   - subnet-evm:  `--version`      → `Subnet-EVM/v0.8.0 [AvalancheGo=v1.14.0, rpcchainvm=44]`
 *
 * Returns undefined when the binary doesn't support the flag or the output
 * doesn't match — the compatibility check is best-effort and must never block
 * a boot that would otherwise work.
 */
function rpcChainVmVersion(binary: string, flag: "--version-json" | "--version"): number | undefined {
  let out: string;
  try {
    out = execSync(`${JSON.stringify(binary)} ${flag}`, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
  if (flag === "--version-json") {
    try {
      const json = JSON.parse(out) as { rpcchainvm?: number };
      return typeof json.rpcchainvm === "number" ? json.rpcchainvm : undefined;
    } catch {
      return undefined;
    }
  }
  const m = /rpcchainvm[=\s:]+(\d+)/i.exec(out);
  return m ? Number(m[1]) : undefined;
}

/**
 * Fail fast when avalanchego and the subnet-evm plugin implement different
 * RPCChainVM protocol versions. A mismatch otherwise surfaces only as
 * `error creating chain ... handshake failed` inside the L1 node's log while
 * the orchestrator waits out a 3-minute RPC-bootstrap timeout.
 */
export function checkRpcChainVmCompatibility(avalanchegoBinary: string, pluginPath: string): void {
  const nodeProto = rpcChainVmVersion(avalanchegoBinary, "--version-json");
  const vmProto = rpcChainVmVersion(pluginPath, "--version");
  if (nodeProto === undefined || vmProto === undefined) return; // best-effort
  if (nodeProto === vmProto) return;
  throw new PreflightError(
    [
      `RPCChainVM protocol mismatch: avalanchego implements v${nodeProto}, the subnet-evm plugin implements v${vmProto}.`,
      `  avalanchego: ${avalanchegoBinary}`,
      `  plugin:      ${pluginPath}`,
      "The versions must match exactly — the L1 chain would fail its plugin handshake",
      "and its RPC would 404 forever. Use binaries released together (e.g. the pair",
      "avalanche-cli installs), or rebuild subnet-evm against this avalanchego.",
    ].join("\n"),
  );
}

/**
 * Refuse to boot when the pid file still records live processes from a
 * previous run. Booting over them makes the old and new networks fight over
 * ports and lets a late-running reaper kill the new network's nodes.
 */
export function assertNoStaleNetwork(pidFile: string): void {
  const { processes } = readPidFile(pidFile);
  const alive = processes.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (alive.length === 0) return;
  throw new PreflightError(
    `A previous network appears to be running (live pids: ${alive
      .map((p) => `${p.pid}/${p.kind}`)
      .join(", ")}). Run \`tmpnetjs down\` first.`,
  );
}

/**
 * Verify each port can be bound before spawning anything. A stale or foreign
 * process on a node port otherwise kills the boot minutes in with
 * `bind: address already in use` in one node's log.
 */
export async function assertPortsFree(ports: number[]): Promise<void> {
  const busy: number[] = [];
  for (const port of ports) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (!free) busy.push(port);
  }
  if (busy.length === 0) return;
  throw new PreflightError(
    `Port(s) ${busy.join(", ")} are already in use — a previous network may still be ` +
      `running. Run \`tmpnetjs down\`, or find the holder with \`lsof -i :${busy[0]}\`.`,
  );
}
