// Spawn the signature-aggregator HTTP server.
//
// signature-aggregator is a stateless HTTP service that, given a Warp unsigned
// message + a (subnet/blockchain) context, queries validators for BLS
// signatures and returns the aggregated signed message.
//
// Config schema (mirrors the working layout in
// avalanche-sdk-typescript/e2e/src/signature-aggregator/index.ts):
//   - log-level
//   - p-chain-api.base-url     — P-Chain API
//   - info-api.base-url        — node info API
//   - api-port                 — HTTP listen port
//   - metrics-port             — metrics listen port
//   - allow-private-ips        — allow 127.0.0.1 peers
//   - manually-tracked-peers   — list of { id, ip } for every node we want
//                                sig-aggregator to dial directly
//   - tracked-subnet-ids       — subnets to pre-track at startup so peers
//                                are dialed before the first /aggregate
//                                request arrives
//
// The binary is provisioned via @interchain-kit/icm-services-installer.

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import * as path from "node:path";

import { installBinary } from "@interchain-kit/icm-services-installer";

import type { ProcessHandle } from "./types.js";
import { paths as networkPaths } from "./config.js";
import { PRIMARY_PORTS } from "./network.js";

export interface PeerConfig {
  /** Avalanche NodeID-... string. */
  id: string;
  /** "<host>:<stakingPort>" — sig-aggregator dials this directly. */
  ip: string;
}

export interface SigAggOptions {
  /** Network work directory; per-node data dirs live under `<workDir>/data`. */
  workDir: string;
  /** P-Chain / info API base URL of the primary network bootstrap node. */
  infoApiBaseUrl: string;
  /** HTTP API port. Defaults to 8080. */
  apiPort?: number;
  /** Metrics port. Defaults to 8081. */
  metricsPort?: number;
  /** Log verbosity. Defaults to "info". */
  logLevel?: string;
  /** Subnets to pre-track at startup (typically the freshly-converted L1's). */
  trackedSubnets?: string[];
}

export interface SigAggConfig {
  "log-level": string;
  "p-chain-api": { "base-url": string };
  "info-api": { "base-url": string };
  "api-port": number;
  "metrics-port": number;
  "allow-private-ips": boolean;
  "manually-tracked-peers": PeerConfig[];
  "tracked-subnet-ids"?: string[];
}

export interface AggregateSignaturesRequest {
  message: string;
  justification?: string;
  "signing-subnet-id"?: string;
  "quorum-percentage"?: number;
}

export interface AggregateSignaturesResponse {
  "signed-message"?: string;
  error?: string;
}

export interface StartSigAggResult {
  process: ProcessHandle;
  configPath: string;
  config: SigAggConfig;
  apiPort: number;
  metricsPort: number;
  /** Resolved manually-tracked peers (one per node we discovered). */
  peers: PeerConfig[];
  /**
   * Make an /aggregate-signatures request against the running aggregator.
   * Default quorum is 67% (mirrors the EVM warp precompile / avalanchego P-Chain
   * verifier hard-coded WarpQuorumNumerator).
   */
  aggregateSignatures: (
    req: AggregateSignaturesRequest,
  ) => Promise<AggregateSignaturesResponse>;
  /** Health endpoint result. */
  isHealthy: () => Promise<boolean>;
}

/**
 * Fetch each primary node's NodeID via `info.getNodeID` against its API URI.
 * Returns { id, ip } pairs where ip is `127.0.0.1:<stakingPort>`. Staking
 * port lives at `httpPort + 1` per the PRIMARY_PORTS pattern.
 */
async function fetchPeersFromApis(apiURIs: string[]): Promise<PeerConfig[]> {
  const peers: PeerConfig[] = [];
  for (const uri of apiURIs) {
    try {
      const res = await fetch(`${uri}/ext/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info.getNodeID",
        }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        result?: { nodeID?: string };
      };
      const nodeID = json.result?.nodeID;
      if (!nodeID) continue;
      // Derive the staking port from the API URI's port. Per PRIMARY_PORTS,
      // stakingPort = httpPort + 1.
      const u = new URL(uri);
      const httpPort = Number(u.port);
      if (!Number.isFinite(httpPort) || httpPort <= 0) continue;
      const stakingPort = httpPort + 1;
      peers.push({ id: nodeID, ip: `127.0.0.1:${stakingPort}` });
    } catch {
      // best-effort: skip nodes that can't be reached
    }
  }
  return peers;
}

/**
 * Walk `<workDir>/data` for per-node subdirectories that look like avalanchego
 * data dirs (network.ts writes `node-N`, l1.ts writes `<l1>-<role>-<index>`).
 *
 * For each one, derive the HTTP port from the index suffix, then call
 * `info.getNodeID` against `http://127.0.0.1:<httpPort>` to learn the
 * NodeID. Returns one peer entry per node we could reach.
 */
export async function discoverNetworkPeers(workDir: string): Promise<PeerConfig[]> {
  return discoverPeers(workDir);
}

async function discoverPeers(workDir: string): Promise<PeerConfig[]> {
  const p = networkPaths(workDir);
  let entries: string[] = [];
  try {
    entries = await readdir(p.data);
  } catch {
    return [];
  }

  // Each per-node dir name ends in `-<index>` where <index> is the slot we
  // used to allocate ports. Parse that, compute httpPort, ask the node for
  // its NodeID. We can't read NodeID from disk reliably (avalanchego writes
  // ephemeral staking keys with random PEM contents on every boot), so the
  // HTTP probe is the only authoritative source.
  const apiURIs: string[] = [];
  for (const name of entries) {
    const m = name.match(/-(\d+)$/) ?? name.match(/^node-(\d+)$/);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isFinite(idx)) continue;
    const httpPort = PRIMARY_PORTS.BASE_HTTP_PORT + idx * PRIMARY_PORTS.PORT_INCREMENT;
    apiURIs.push(`http://127.0.0.1:${httpPort}`);
  }

  return fetchPeersFromApis(apiURIs);
}

export function buildSigAggConfig(opts: {
  apiPort: number;
  metricsPort: number;
  logLevel: string;
  infoApiBaseUrl: string;
  peers: PeerConfig[];
  trackedSubnets?: string[];
}): SigAggConfig {
  const cfg: SigAggConfig = {
    "log-level": opts.logLevel,
    "p-chain-api": { "base-url": opts.infoApiBaseUrl },
    "info-api": { "base-url": opts.infoApiBaseUrl },
    "api-port": opts.apiPort,
    "metrics-port": opts.metricsPort,
    "allow-private-ips": true,
    "manually-tracked-peers": opts.peers,
  };
  if (opts.trackedSubnets && opts.trackedSubnets.length > 0) {
    cfg["tracked-subnet-ids"] = opts.trackedSubnets;
  }
  return cfg;
}

export async function startSignatureAggregator(
  opts: SigAggOptions,
): Promise<StartSigAggResult> {
  const p = networkPaths(opts.workDir);
  await mkdir(p.logs, { recursive: true });
  await mkdir(opts.workDir, { recursive: true });

  const peers = await discoverPeers(opts.workDir);
  if (peers.length === 0) {
    throw new Error(
      `signature-aggregator: discovered 0 peer nodes under ${p.data}. ` +
        `Ensure the primary network and L1 validator nodes are running before starting sig-aggregator.`,
    );
  }

  const apiPort = opts.apiPort ?? 8080;
  const metricsPort = opts.metricsPort ?? 8081;
  const config = buildSigAggConfig({
    apiPort,
    metricsPort,
    logLevel: opts.logLevel ?? "info",
    infoApiBaseUrl: opts.infoApiBaseUrl,
    peers,
    trackedSubnets: opts.trackedSubnets,
  });

  const configPath = path.join(opts.workDir, "signature-aggregator.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const binary = await installBinary("signature-aggregator", { cacheDir: p.bin });
  const logFile = path.join(p.logs, "signature-aggregator.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(binary, ["--config-file", configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("Failed to spawn signature-aggregator (no pid)");
  }

  const apiUrl = `http://127.0.0.1:${apiPort}`;

  const isHealthy = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${apiUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { status?: string };
      return json.status === "up";
    } catch {
      return false;
    }
  };

  // Wait for /health to report up before returning so callers don't try to
  // /aggregate-signatures before the binary has finished binding ports.
  const startDeadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < startDeadline) {
    if (await isHealthy()) {
      healthy = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    throw new Error(
      `signature-aggregator failed to become healthy within 20s. See ${logFile} for details.`,
    );
  }

  const aggregateSignatures = async (
    req: AggregateSignaturesRequest,
  ): Promise<AggregateSignaturesResponse> => {
    const body: AggregateSignaturesRequest = {
      "quorum-percentage": 67,
      ...req,
    };
    try {
      const res = await fetch(`${apiUrl}/aggregate-signatures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res.json()) as AggregateSignaturesResponse;
      if (!res.ok) {
        return { error: json.error ?? `HTTP ${res.status}` };
      }
      return json;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    process: { pid: child.pid, binary, logFile },
    configPath,
    config,
    apiPort,
    metricsPort,
    peers,
    aggregateSignatures,
    isHealthy,
  };
}
