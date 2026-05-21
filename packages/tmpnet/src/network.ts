// Boot the avalanchego primary network (P, X, C chains).
//
// This is a TypeScript translation of avalanche-benchmark's
// `local/internal/network/network.go`. Each call to `startPrimaryNetwork`:
//
//   1. Locates an avalanchego binary (env > PATH > workDir/bin).
//   2. For each requested primary node:
//        - allocates HTTP/staking ports (9650 + 100*i, +1).
//        - prepares a private node data dir under <workDir>/data/node-N/.
//        - spawns avalanchego with `--network-id=local` and a fresh ephemeral
//          staking key. Node 0 is the bootstrap; others bootstrap off it.
//        - tees stdout+stderr to <workDir>/logs/node-N.log.
//   3. Polls `/ext/info` on every node until they all report a node ID,
//      then resolves with handles + RPC URLs.
//
// `--network-id=local` makes avalanchego load its built-in local genesis,
// which pre-funds the EWOQ key on the C-Chain. We don't need to provide
// `--genesis-file` for that — it's only required for custom networks.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";

import type { paths as Paths } from "./config.js";
import { spawnTracked } from "./process.js";
import type { ProcessHandle } from "./types.js";

/**
 * Avalanchego ships 5 preconfigured local-network staker keys. The local
 * genesis stamps them into the initial primary-network validator set, so
 * using these keys (instead of ephemeral certs) lets a 1-or-more-node
 * primary network actually leave bootstrap.
 *
 * Lookup order:
 *   1. AVALANCHEGO_STAKING_KEYS_DIR (explicit override)
 *   2. <dirname(AVALANCHEGO_PATH)>/../staking/local
 *   3. $HOME/code/avalanchego/staking/local
 */
function resolveStakingKeysDir(avalanchegoBinary: string): string | undefined {
  const candidates: string[] = [];
  const env = process.env.AVALANCHEGO_STAKING_KEYS_DIR?.trim();
  if (env) candidates.push(env);
  // <avalanchego>/build/avalanchego => <avalanchego>/staking/local
  candidates.push(
    path.join(path.dirname(avalanchegoBinary), "..", "staking", "local"),
  );
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, "code", "avalanchego", "staking", "local"));
  }
  for (const dir of candidates) {
    const abs = path.resolve(dir);
    if (existsSync(path.join(abs, "staker1.key"))) return abs;
  }
  return undefined;
}

/** Number of preconfigured local stakers shipped with avalanchego. */
const MAX_LOCAL_STAKERS = 5;

/** Result of {@link startPrimaryNetwork}. */
export interface PrimaryNetwork {
  /** One handle per spawned avalanchego process, in node-index order. */
  nodes: PrimaryNodeHandle[];
  /** Canonical C-Chain RPC URL (uses node 0). */
  cChainRpcUrl: string;
  /** Where every node has its HTTP API listening (`http://127.0.0.1:<port>`). */
  apiURIs: string[];
}

/** Per-node metadata we hold onto for downstream l1/icm work. */
export interface PrimaryNodeHandle extends ProcessHandle {
  /** Sequential index (0 is the bootstrap node). */
  index: number;
  /** `http://127.0.0.1:<httpPort>` — base URL for /ext/info, /ext/bc/P, etc. */
  apiURI: string;
  /** NodeID-... string returned by `info.getNodeID`. Filled once healthy. */
  nodeID: string;
  /** HTTP API port. */
  httpPort: number;
  /** P2P staking port. */
  stakingPort: number;
}

const BASE_HTTP_PORT = 9650;
/** Per-node port stride. Mirrors avalanche-benchmark. */
const PORT_INCREMENT = 100;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 250;

/**
 * Locate a usable `avalanchego` binary. Lookup order:
 *
 *   1. `process.env.AVALANCHEGO_PATH` (highest priority — explicit user choice)
 *   2. The PATH (via `which avalanchego`)
 *   3. `<workDir>/bin/avalanchego` (where our installer drops it)
 *
 * Throws with install instructions if none of those resolve to an existing
 * file. We deliberately don't try `$HOME/code/avalanchego/build/avalanchego`
 * or similar — those leak my developer environment into someone else's repo.
 */
export function findAvalanchego(workDir: string): string {
  const candidates: string[] = [];
  const envPath = process.env.AVALANCHEGO_PATH?.trim();
  if (envPath) candidates.push(envPath);

  try {
    const onPath = execSync("which avalanchego", { encoding: "utf8" }).trim();
    if (onPath) candidates.push(onPath);
  } catch {
    // `which` returns non-zero when not found — fine, fall through.
  }

  candidates.push(path.join(workDir, "bin", "avalanchego"));

  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (existsSync(abs)) return abs;
  }

  throw new Error(
    [
      "avalanchego binary not found.",
      "",
      "Tried (in order):",
      ...candidates.map((c) => `  - ${c}`),
      "",
      "Fixes:",
      "  - Set AVALANCHEGO_PATH=/path/to/avalanchego",
      "  - Install via `go install github.com/ava-labs/avalanchego@latest`",
      "  - Or drop the binary at <workDir>/bin/avalanchego",
    ].join("\n"),
  );
}

/**
 * Spawn the primary network and wait for every node to be healthy.
 *
 * @param cfg - Normalized network config (see config.ts). We only read
 *   `cfg.primaryNodes` and `cfg.workDir` here.
 * @param ps  - Output of `paths(cfg.workDir)`.
 */
export async function startPrimaryNetwork(
  cfg: { primaryNodes: number; workDir: string },
  ps: ReturnType<typeof Paths>,
): Promise<PrimaryNetwork> {
  const avalanchego = findAvalanchego(cfg.workDir);
  const stakingKeysDir = resolveStakingKeysDir(avalanchego);

  // Pre-create top-level dirs the spawn helper would otherwise have to make
  // lazily. Saves a per-process mkdir and matches paths.go in benchmark.
  for (const dir of [ps.data, ps.logs, ps.bin, ps.artifacts]) {
    mkdirSync(dir, { recursive: true });
  }

  const nodeCount = Math.min(
    Math.max(1, cfg.primaryNodes),
    MAX_LOCAL_STAKERS,
  );
  const nodes: PrimaryNodeHandle[] = [];

  // Start the bootstrap node first. Subsequent nodes will use its NodeID +
  // staking endpoint to join. We can't compute the NodeID up front because
  // we're letting avalanchego generate ephemeral staking keys per node.
  const bootstrap = await spawnPrimaryNode({
    index: 0,
    avalanchego,
    paths: ps,
    bootstrap: undefined, // node 0 IS the bootstrap; no peer
    stakerNum: 1,
    stakingKeysDir,
  });
  nodes.push(bootstrap);

  // Remaining nodes bootstrap off node 0. They share a process group so they
  // all live and die together, but each has its own data dir.
  for (let i = 1; i < nodeCount; i++) {
    const node = await spawnPrimaryNode({
      index: i,
      avalanchego,
      paths: ps,
      bootstrap: {
        nodeID: bootstrap.nodeID,
        stakingPort: bootstrap.stakingPort,
      },
      stakerNum: i + 1,
      stakingKeysDir,
    });
    nodes.push(node);
  }

  // Every primary node serves the C-Chain at the same path. We arbitrarily
  // return node 0's URL for downstream wallets; callers needing load balancing
  // can iterate `apiURIs`.
  const node0 = nodes[0];
  if (!node0) {
    throw new Error("internal: primary network started 0 nodes");
  }
  return {
    nodes,
    cChainRpcUrl: `${node0.apiURI}/ext/bc/C/rpc`,
    apiURIs: nodes.map((n) => n.apiURI),
  };
}

interface SpawnPrimaryNodeArgs {
  index: number;
  avalanchego: string;
  paths: ReturnType<typeof Paths>;
  /** Pass omitted for the bootstrap node, set for everyone else. */
  bootstrap: { nodeID: string; stakingPort: number } | undefined;
  /**
   * 1-based index into the preconfigured local staker key set
   * (staker1..staker5). When the keys are unavailable we fall back to
   * ephemeral staking certs.
   */
  stakerNum?: number;
  stakingKeysDir?: string | undefined;
}

/**
 * Spawn one avalanchego primary-network node, wait for it to expose a node
 * ID via `/ext/info`, and return its handle.
 *
 * Implementation notes:
 *   - We rely on `--network-id=local` to populate the built-in EWOQ genesis.
 *     Custom networks would also need `--genesis-file`.
 *   - `--sybil-protection-enabled=false` lets us run with a single
 *     ephemeral staking key without needing pre-distributed stakers.
 *   - The bootstrap node is told to expect zero peers (`--bootstrap-ips=`,
 *     `--bootstrap-ids=`) so it doesn't sit forever trying to join.
 */
async function spawnPrimaryNode(args: SpawnPrimaryNodeArgs): Promise<PrimaryNodeHandle> {
  const { index, avalanchego, paths: ps, bootstrap } = args;
  const httpPort = BASE_HTTP_PORT + index * PORT_INCREMENT;
  const stakingPort = httpPort + 1;
  const nodeDir = path.join(ps.data, `node-${index}`);
  const logFile = path.join(ps.logs, `node-${index}.log`);
  const name = `node-${index}`;

  // Subdirectories avalanchego will write into. Creating them up-front
  // makes flags + on-disk layout legible from the outside.
  for (const sub of ["db", "logs", "staking", "chainData", "configs"]) {
    mkdirSync(path.join(nodeDir, sub), { recursive: true });
  }

  const cliArgs: string[] = [
    `--http-port=${httpPort}`,
    `--staking-port=${stakingPort}`,
    "--http-host=127.0.0.1",
    "--network-id=local",
    // sybil-protection MUST stay ON (default). With it off, every node
    // reports myNodeID=NodeID-111...DBWJs at the network layer, which
    // doesn't match the staker NodeID that ConvertSubnetToL1 baked into
    // the L1 validator set. Result: L1 consensus can't find its peers
    // and the chain never leaves bootstrap.
    `--data-dir=${nodeDir}`,
    `--db-dir=${path.join(nodeDir, "db")}`,
    `--log-dir=${path.join(nodeDir, "logs")}`,
    `--chain-data-dir=${path.join(nodeDir, "chainData")}`,
  ];

  // Prefer the preconfigured local staker keys when they're available —
  // the local network's genesis stamps these NodeIDs into the initial
  // primary-network validator set, so consensus can converge with as
  // few as 1 node. Fall back to ephemeral certs (with a non-validator
  // NodeID) only if the keys aren't accessible.
  const stakerNum = args.stakerNum ?? 0;
  if (
    args.stakingKeysDir &&
    stakerNum >= 1 &&
    stakerNum <= 5 &&
    existsSync(path.join(args.stakingKeysDir, `staker${stakerNum}.crt`))
  ) {
    cliArgs.push(
      `--staking-tls-cert-file=${path.join(args.stakingKeysDir, `staker${stakerNum}.crt`)}`,
      `--staking-tls-key-file=${path.join(args.stakingKeysDir, `staker${stakerNum}.key`)}`,
      `--staking-signer-key-file=${path.join(args.stakingKeysDir, `signer${stakerNum}.key`)}`,
    );
  } else {
    cliArgs.push(
      "--staking-ephemeral-cert-enabled=true",
      "--staking-ephemeral-signer-enabled=true",
    );
  }

  if (bootstrap) {
    cliArgs.push(
      `--bootstrap-ips=127.0.0.1:${bootstrap.stakingPort}`,
      `--bootstrap-ids=${bootstrap.nodeID}`,
    );
  } else {
    // Explicitly empty values stop avalanchego from looking up the default
    // mainnet bootstrappers. Without these the bootstrap node will hang
    // trying to contact peers that don't exist on the local network.
    cliArgs.push("--bootstrap-ips=", "--bootstrap-ids=");
  }

  const handle = spawnTracked(name, avalanchego, cliArgs, logFile, {
    cwd: nodeDir,
    pidFile: ps.pidFile,
  });

  const apiURI = `http://127.0.0.1:${httpPort}`;
  const nodeID = await waitForNodeID(apiURI, HEALTH_TIMEOUT_MS);

  return {
    ...handle,
    index,
    apiURI,
    nodeID,
    httpPort,
    stakingPort,
  };
}

/**
 * Poll `<apiURI>/ext/info { method: "info.getNodeID" }` until it returns a
 * non-empty NodeID or the deadline elapses. We use this as our "is the node
 * up?" signal rather than `/ext/health` because health is much pickier (it
 * wants chains to be bootstrapped) and we just want the HTTP server alive.
 */
export async function waitForNodeID(
  apiURI: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = undefined;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiURI}/ext/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info.getNodeID",
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          result?: { nodeID?: string };
        };
        const nodeID = json.result?.nodeID;
        if (nodeID && nodeID.startsWith("NodeID-")) {
          return nodeID;
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${apiURI}/ext/info. ` +
      `Last error: ${String(lastErr)}`,
  );
}

/**
 * Wait until every node in the primary network reports `info.isBootstrapped`
 * for the P, X, and C chains. Heavier than {@link waitForNodeID} but the
 * right check before issuing a CreateSubnet tx.
 */
export async function waitForBootstrap(
  apiURI: string,
  chain: "P" | "X" | "C",
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiURI}/ext/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info.isBootstrapped",
          params: { chain },
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          result?: { isBootstrapped?: boolean };
        };
        if (json.result?.isBootstrapped === true) return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for ${chain}-Chain bootstrap at ${apiURI}: ${String(lastErr)}`,
  );
}

/** Re-exported so callers can compute extra ports without doing arithmetic. */
export const PRIMARY_PORTS = {
  BASE_HTTP_PORT,
  PORT_INCREMENT,
};
