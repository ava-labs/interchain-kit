// Post-mortem helpers: pull the real failure out of node logs so timeout
// errors can say what actually went wrong.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Scan every `*.log` in `logsDir` for avalanchego's `error creating chain`
 * line for `blockchainId`. This is where plugin handshake failures and VM
 * init crashes land — the chain's RPC just 404s while the orchestrator polls.
 *
 * Returns the matching line (truncated) or undefined. Best-effort: any I/O
 * error reads as "nothing found".
 */
export function findChainCreationError(
  logsDir: string,
  blockchainId: string,
): string | undefined {
  let files: string[];
  try {
    files = readdirSync(logsDir).filter((f) => f.endsWith(".log"));
  } catch {
    return undefined;
  }
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(path.join(logsDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.includes("error creating chain")) continue;
      if (!line.includes(blockchainId)) continue;
      const trimmed = line.length > 900 ? `${line.slice(0, 900)}...` : line;
      return `${file}: ${trimmed}`;
    }
  }
  return undefined;
}
