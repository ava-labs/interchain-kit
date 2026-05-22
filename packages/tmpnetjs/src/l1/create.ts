// CreateSubnet → CreateChain(subnet-evm) → ConvertSubnetToL1 — the whole
// L1 spin-up dance.
//
// Translated from `local/internal/network/network.go` in avalanche-benchmark
// (lines ~180–330). The Go version uses
// `wallet/subnet/primary.MakePWallet`; in TypeScript we drop one level lower
// and call `@avalabs/avalanchejs` directly because the higher-level wallet
// client in `@avalanche-sdk/client` is built around a browser/Core extension
// transport. Talking to the local node's P-Chain JSON-RPC is fine for our
// case.
//
// Order of operations for each L1:
//   1. Generate / accept the subnet-evm genesis (proxy + EWOQ pre-funded).
//   2. Issue CreateSubnetTx — EWOQ-owned, threshold 1.
//   3. Issue CreateChainTx — vmID = SubnetEVMID.
//   4. Spawn (`validators` + `rpcNodes` + `archiveNodes`) avalanchego
//      processes tracking the new subnet.
//   5. Query each validator's `info.getNodeId` for NodeID + BLS PoP.
//   6. Issue ConvertSubnetToL1Tx referencing those validators and the
//      well-known ValidatorManager proxy address.
//
// Returns a partial {@link L1Handle} — teleporter / teleporterRegistry
// addresses are filled in by the ICM-deploy step in a later phase.

import { createAvalancheWalletClient } from "@avalanche-sdk/client";
import { privateKeyToAvalancheAccount } from "@avalanche-sdk/client/accounts";
import { avalancheLocal } from "@avalanche-sdk/client/chains";
import { avaxToNanoAvax } from "@avalanche-sdk/client/utils";
import { custom, http } from "viem";
import {
  VALIDATOR_MANAGER_PROXY_ADDRESS,
} from "@avalanche-sdk/interchain";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Address } from "viem";

import type { paths as Paths } from "../internal/config.js";
import {
  defaultSubnetEvmGenesis,
  type SubnetEvmGenesis,
} from "./genesis.js";
import {
  PRIMARY_PORTS,
  findAvalanchego,
  waitForNodeID,
} from "../network/spawn.js";
import { spawnTracked } from "../internal/process.js";
import type { L1Config, L1Handle, ProcessHandle } from "../types.js";
import { EWOQ_EVM_ADDRESS, EWOQ_PRIVATE_KEY } from "../internal/wallet.js";

/**
 * Avalanche's well-known subnet-evm VM ID, in cb58. Same constant used by
 * avalanchego, the CLI, and avalanche-benchmark.
 */
const SUBNET_EVM_VM_ID = "srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy";

/** Weight every L1 validator gets at conversion time. Matches benchmark. */
const VALIDATOR_WEIGHT = 100n;
/** 1 AVAX of initial validator balance (P-Chain side, denominated in nAVAX). */
const VALIDATOR_INITIAL_BALANCE_NAVAX = 1_000_000_000n;

/** Where the orchestrator finds each primary-network node. */
export interface PrimaryNetworkRef {
  /** All primary-network API URIs (`http://127.0.0.1:<port>`). */
  apiURIs: string[];
  /** The number of primary nodes already running (used to assign ports). */
  nodeCount: number;
}

/** Output of {@link createL1}. */
export interface CreateL1Result {
  /** Partial L1 handle — teleporter addresses filled in by the ICM phase. */
  l1: Omit<L1Handle, "teleporter" | "teleporterRegistry">;
  /** All node processes that were spawned for this L1. */
  nodes: ProcessHandle[];
  /**
   * Identity of the L1's bootstrap validator (the first validator node we
   * spawned for this L1, which is also the one listed in ConvertSubnetToL1).
   * Surfaced so callers can run initializeValidatorSet without redundant
   * info.getNodeID round-trips.
   */
  bootstrapValidator: {
    nodeId: string;
    blsPublicKey: `0x${string}`;
    blsProofOfPossession: `0x${string}`;
    apiURI: string;
  };
}

/**
 * Boot one L1 on top of an already-running primary network.
 *
 * @param l1Config  - L1 sizing + naming.
 * @param primary   - Primary network reference (URIs + node count).
 * @param ps        - paths() output for the parent workDir.
 */
export async function createL1(
  l1Config: L1Config,
  primary: PrimaryNetworkRef,
  ps: ReturnType<typeof Paths>,
  workDir: string,
): Promise<CreateL1Result> {
  if (primary.apiURIs.length === 0) {
    throw new Error("createL1: primary network has no API URIs");
  }
  const primaryURI = primary.apiURIs[0];
  if (!primaryURI) {
    throw new Error("createL1: primary network apiURIs[0] is undefined");
  }
  const avalanchego = findAvalanchego(workDir);

  // 1. Build (or accept) the subnet-evm genesis.
  const genesis: SubnetEvmGenesis =
    (l1Config.genesis as SubnetEvmGenesis | undefined) ??
    defaultSubnetEvmGenesis({
      chainId: l1Config.evmChainId,
      proxyAdminOwner: EWOQ_EVM_ADDRESS,
    });

  // Persist the genesis under <artifacts>/<l1>/genesis.json so users can see
  // exactly what was deployed.
  const artifactDir = path.join(ps.artifacts, l1Config.name);
  mkdirSync(artifactDir, { recursive: true });
  const genesisPath = path.join(artifactDir, "genesis.json");
  writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

  // 2. Set up the @avalanche-sdk/client wallet client targeting our local
  //    node. Two notes on the transport:
  //    - The SDK uses its own SECP256K1 signing path (signXPTransaction)
  //      which differs from avalanchejs's addTxSignatures.
  //    - On a freshly-bootstrapped local P-Chain, `platform.getFeeState`
  //      returns capacity=0 (the persisted last-block value) and avalanchejs
  //      pre-flight gas check rejects every tx. avalanchego itself computes
  //      capacity at block-acceptance time and accepts txs fine, so we lie
  //      about capacity in the transport to get past the pre-flight.
  installFeeStatePatch(primaryURI);
  const account = privateKeyToAvalancheAccount(EWOQ_PRIVATE_KEY);
  const walletClient = createAvalancheWalletClient({
    chain: avalancheLocal,
    transport: { type: "http", url: `${primaryURI}/ext/bc/C/rpc` },
    account,
  });
  const ewoqPAddr = account.getXPAddress("P", "local");

  // 3. CreateSubnetTx
  const createSubnetReq = await walletClient.pChain.prepareCreateSubnetTxn({
    subnetOwners: {
      addresses: [ewoqPAddr],
      threshold: 1,
    },
  });
  const createSubnetRes = await walletClient.sendXPTransaction(createSubnetReq);
  await waitForPChainCommit(walletClient, createSubnetRes.txHash);
  const subnetTxID = createSubnetRes.txHash;

  // 4. CreateChainTx (vmID = subnet-evm, genesis = our subnet-evm doc)
  const createChainReq = await walletClient.pChain.prepareCreateChainTxn({
    subnetId: subnetTxID,
    vmId: SUBNET_EVM_VM_ID,
    chainName: l1Config.name,
    genesisData: genesis as unknown as Record<string, unknown>,
    fromAddresses: [ewoqPAddr],
    subnetAuth: [0],
  });
  const createChainRes = await walletClient.sendXPTransaction(createChainReq);
  await waitForPChainCommit(walletClient, createChainRes.txHash);
  const blockchainID = createChainRes.txHash;

  // 5. Spawn validator + RPC + archive nodes for this L1.
  //    Index space continues after the primary network nodes so we don't
  //    collide on ports.
  const nodes: ProcessHandle[] = [];
  const validatorMeta: SpawnedL1Node[] = [];
  let nextIndex = primary.nodeCount;

  for (let v = 0; v < Math.max(1, l1Config.validators); v++) {
    const node = await spawnL1Node({
      role: "validator",
      l1Name: l1Config.name,
      avalanchego,
      paths: ps,
      bootstrap: primary,
      subnetId: subnetTxID,
      index: nextIndex,
    });
    nodes.push(node.process);
    validatorMeta.push(node);
    nextIndex += 1;
  }
  for (let r = 0; r < l1Config.rpcNodes; r++) {
    const node = await spawnL1Node({
      role: "rpc",
      l1Name: l1Config.name,
      avalanchego,
      paths: ps,
      bootstrap: primary,
      subnetId: subnetTxID,
      index: nextIndex,
    });
    nodes.push(node.process);
    nextIndex += 1;
  }
  for (let a = 0; a < l1Config.archiveNodes; a++) {
    const node = await spawnL1Node({
      role: "archive",
      l1Name: l1Config.name,
      avalanchego,
      paths: ps,
      bootstrap: primary,
      subnetId: subnetTxID,
      index: nextIndex,
    });
    nodes.push(node.process);
    nextIndex += 1;
  }

  // 6. Gather NodeID + BLS proof of possession from every L1 validator so
  //    they can be listed in the ConvertSubnetToL1Tx.
  const convertValidators = [];
  const validatorIdentities: Array<{
    nodeId: string;
    blsPublicKey: `0x${string}`;
    blsProofOfPossession: `0x${string}`;
    apiURI: string;
  }> = [];
  for (const v of validatorMeta) {
    const { nodeID, nodePoP } = await fetchNodeIdentity(v.apiURI);
    convertValidators.push({
      nodeId: nodeID,
      nodePoP: {
        publicKey: nodePoP.publicKey as `0x${string}`,
        proofOfPossession: nodePoP.proofOfPossession as `0x${string}`,
      },
      weight: VALIDATOR_WEIGHT,
      initialBalanceInAvax: avaxToNanoAvax(1),
      // The remaining-balance and deactivation owners are both the EWOQ
      // key. For a local dev network we don't need separate roles.
      remainingBalanceOwner: { addresses: [ewoqPAddr], threshold: 1 },
      deactivationOwner: { addresses: [ewoqPAddr], threshold: 1 },
    });
    validatorIdentities.push({
      nodeId: nodeID,
      blsPublicKey: nodePoP.publicKey as `0x${string}`,
      blsProofOfPossession: nodePoP.proofOfPossession as `0x${string}`,
      apiURI: v.apiURI,
    });
  }

  // 7. ConvertSubnetToL1Tx — points at the proxy address baked into genesis.
  const convertReq = await walletClient.pChain.prepareConvertSubnetToL1Txn({
    subnetId: subnetTxID,
    blockchainId: blockchainID,
    managerContractAddress: VALIDATOR_MANAGER_PROXY_ADDRESS as `0x${string}`,
    validators: convertValidators,
    subnetAuth: [0],
  });
  const convertRes = await walletClient.sendXPTransaction(convertReq);
  await waitForPChainCommit(walletClient, convertRes.txHash);

  // The first L1 validator node serves the RPC. If the user asked for
  // dedicated RPC nodes we'd prefer those, but we don't differentiate the
  // returned URL here — the artifacts step composes them.
  const firstValidator = validatorMeta[0];
  if (!firstValidator) {
    throw new Error("createL1: no L1 validator nodes spawned");
  }
  const rpcUrl = `${firstValidator.apiURI}/ext/bc/${blockchainID}/rpc`;
  const wsUrl = `${firstValidator.apiURI.replace(/^http/, "ws")}/ext/bc/${blockchainID}/ws`;

  const bootstrapValidator = validatorIdentities[0];
  if (!bootstrapValidator) {
    throw new Error("createL1: no validator identity captured");
  }

  return {
    l1: {
      name: l1Config.name,
      evmChainId: l1Config.evmChainId,
      blockchainId: blockchainID,
      rpcUrl,
      wsUrl,
      subnetId: subnetTxID,
      validatorManager: VALIDATOR_MANAGER_PROXY_ADDRESS as Address,
    },
    nodes,
    bootstrapValidator,
  };
}

// --- Internal helpers -------------------------------------------------------

interface SpawnedL1Node {
  role: "validator" | "rpc" | "archive";
  index: number;
  apiURI: string;
  nodeID: string;
  process: ProcessHandle;
}

interface SpawnL1NodeArgs {
  role: "validator" | "rpc" | "archive";
  l1Name: string;
  avalanchego: string;
  paths: ReturnType<typeof Paths>;
  bootstrap: PrimaryNetworkRef;
  subnetId: string;
  index: number;
}

/**
 * Spawn one L1 node (validator / rpc / archive). Each role uses the same
 * binary but slightly different flags: archive nodes bind to 0.0.0.0 with
 * permissive host allowlists for tools like Blockscout; the others stay
 * loopback-only.
 */
async function spawnL1Node(args: SpawnL1NodeArgs): Promise<SpawnedL1Node> {
  const httpPort =
    PRIMARY_PORTS.BASE_HTTP_PORT + args.index * PRIMARY_PORTS.PORT_INCREMENT;
  const stakingPort = httpPort + 1;
  const name = `${args.l1Name}-${args.role}-${args.index}`;
  const nodeDir = path.join(args.paths.data, name);
  const logFile = path.join(args.paths.logs, `${name}.log`);

  for (const sub of ["db", "logs", "staking", "chainData", "configs"]) {
    mkdirSync(path.join(nodeDir, sub), { recursive: true });
  }

  // Bootstrap off the primary network's node 0. We rely on the convention
  // that node 0 lives on the base staking port (9651). If primary node 0
  // hasn't been told its NodeID yet we'd have a chicken-and-egg, but
  // `network.ts:spawnPrimaryNode` blocks until /ext/info answers, so by the
  // time we get here we can ask for it again cheaply.
  const primary0Uri = args.bootstrap.apiURIs[0];
  if (!primary0Uri) {
    throw new Error("spawnL1Node: no primary URI available for bootstrap");
  }
  // Use 60s timeout — node 0 should answer immediately, but a fresh process
  // can briefly stall HTTP listens on slower machines.
  const bootstrapNodeID = await waitForNodeID(primary0Uri, 30_000);

  const cliArgs: string[] = [
    `--http-port=${httpPort}`,
    `--staking-port=${stakingPort}`,
    "--network-id=local",
    // Keep sybil-protection ON (default) — see network.ts for the
    // why: ConvertSubnetToL1's validator-set entries use staker NodeIDs,
    // and disabling sybil-protection makes peers identify themselves as
    // NodeID-111...DBWJs at the network layer, breaking subnet consensus.
    "--staking-ephemeral-cert-enabled=true",
    "--staking-ephemeral-signer-enabled=true",
    `--data-dir=${nodeDir}`,
    `--db-dir=${path.join(nodeDir, "db")}`,
    `--log-dir=${path.join(nodeDir, "logs")}`,
    `--chain-data-dir=${path.join(nodeDir, "chainData")}`,
    // Subscribe to our newly-created subnet so this node will actually
    // build/validate the L1 chain.
    `--track-subnets=${args.subnetId}`,
    `--bootstrap-ips=127.0.0.1:${PRIMARY_PORTS.BASE_HTTP_PORT + 1}`,
    `--bootstrap-ids=${bootstrapNodeID}`,
    // Point at a plugin dir that contains the subnet-evm binary. avalanchego
    // doesn't bundle subnet-evm by default; if `AVALANCHEGO_PLUGIN_DIR` is
    // set use that, otherwise fall back to common local layouts.
    `--plugin-dir=${resolvePluginDir(args.avalanchego)}`,
  ];

  if (args.role === "archive") {
    // Archive RPCs are intended for external tools (Blockscout): bind to
    // 0.0.0.0, accept any Host header, no pruning. The chain config block
    // that disables pruning lives under `<nodeDir>/configs/chains/<chainID>`
    // and is written by the orchestrator after blockchainID is known.
    cliArgs.push("--http-host=0.0.0.0", "--http-allowed-hosts=*");
  } else {
    cliArgs.push("--http-host=127.0.0.1");
  }

  const proc = spawnTracked(name, args.avalanchego, cliArgs, logFile, {
    cwd: nodeDir,
    pidFile: args.paths.pidFile,
  });

  const apiURI = `http://127.0.0.1:${httpPort}`;
  const nodeID = await waitForNodeID(apiURI, 60_000);

  return {
    role: args.role,
    index: args.index,
    apiURI,
    nodeID,
    process: proc,
  };
}

/** Fetch NodeID + BLS PoP from a node's `/ext/info`. */
async function fetchNodeIdentity(apiURI: string): Promise<{
  nodeID: string;
  nodePoP: { publicKey: string; proofOfPossession: string };
}> {
  const res = await fetch(`${apiURI}/ext/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "info.getNodeID",
    }),
  });
  if (!res.ok) {
    throw new Error(`info.getNodeID failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: {
      nodeID?: string;
      nodePOP?: { publicKey?: string; proofOfPossession?: string };
    };
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(`info.getNodeID error: ${json.error.message ?? "unknown"}`);
  }
  const nodeID = json.result?.nodeID;
  const pk = json.result?.nodePOP?.publicKey;
  const pop = json.result?.nodePOP?.proofOfPossession;
  if (!nodeID || !pk || !pop) {
    throw new Error(
      `info.getNodeID returned incomplete result: ${JSON.stringify(json)}`,
    );
  }
  return {
    nodeID,
    nodePoP: { publicKey: pk, proofOfPossession: pop },
  };
}

/**
 * Poll P-Chain getTxStatus until "Committed" or timeout. The SDK's built-in
 * waitForTxn only retries 10× at 300ms = 3 second window, which is too
 * short for CreateSubnet/CreateChain/ConvertSubnetToL1 on a freshly-booted
 * primary network (acceptance regularly takes 5-15s).
 */
async function waitForPChainCommit(
  walletClient: { pChain: { getTxStatus: (args: { txID: string }) => Promise<{ status: string }> } },
  txID: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    try {
      const { status } = await walletClient.pChain.getTxStatus({ txID });
      lastStatus = status;
      if (status === "Committed" || status === "Accepted") return;
      if (status === "Dropped" || status === "Rejected") {
        throw new Error(`Tx ${txID} failed with status ${status}`);
      }
    } catch (err) {
      // "tx not found" while propagating — retry
      if (Date.now() > deadline - 1000) throw err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for P-Chain tx ${txID} to commit (last status: ${lastStatus})`);
}

/**
 * Locate a plugin directory containing the subnet-evm binary (VM ID
 * `srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy`). avalanchego doesn't
 * ship subnet-evm by default. We check, in order:
 *   1. `$AVALANCHEGO_PLUGIN_DIR`
 *   2. `<avalanchego dir>/build/plugins`
 *   3. A couple of well-known local checkout layouts.
 */
function resolvePluginDir(avalanchegoBinary: string): string {
  const SUBNET_EVM = "srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy";
  const candidates: string[] = [];
  if (process.env.AVALANCHEGO_PLUGIN_DIR) {
    candidates.push(process.env.AVALANCHEGO_PLUGIN_DIR);
  }
  // ~/code/avalanchego/build/avalanchego => ~/code/avalanchego/build/plugins
  candidates.push(path.join(path.dirname(avalanchegoBinary), "plugins"));
  // Fall back to the avalanche-benchmark layout some devs already have.
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, "code", "avalanche-benchmark", "plugins"));
  }
  for (const dir of candidates) {
    try {
      if (statSync(path.join(dir, SUBNET_EVM)).isFile()) return dir;
    } catch {}
  }
  throw new Error(
    `Cannot find subnet-evm plugin (VM ID ${SUBNET_EVM}). Checked: ${candidates.join(", ")}. ` +
      `Set AVALANCHEGO_PLUGIN_DIR to a directory containing the file named "${SUBNET_EVM}". ` +
      `Build subnet-evm from github.com/ava-labs/subnet-evm and place the binary there.`,
  );
}

let _feeStatePatchInstalled = false;

/**
 * Monkey-patch globalThis.fetch to intercept `platform.getFeeState` calls
 * to the local node and synthesize a high-capacity response.
 *
 * Why: on a fresh local P-Chain, `platform.getFeeState` returns the
 * persisted last-block fee state (capacity=0 since no blocks have been
 * minted yet). avalanchego itself accepts new txs because it computes
 * capacity at acceptance time from elapsed wall-clock, but avalanchejs's
 * client-side gas-usage pre-flight check rejects them upfront. We don't
 * have a hook to override fee state through the @avalanche-sdk/client API,
 * so we intercept the HTTP layer instead. Local-dev only — never run this
 * against a non-local network.
 */
function installFeeStatePatch(primaryURI: string): void {
  if (_feeStatePatchInstalled) return;
  _feeStatePatchInstalled = true;

  // Both /ext/bc/P and /ext/bc/C/rpc on the primary URI need patching since
  // the SDK derives its P-Chain client from the C-Chain URL.
  const targetHosts = new Set([new URL(primaryURI).host]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(url);
      if (targetHosts.has(u.host) && u.pathname.endsWith("/ext/bc/P") && init?.body) {
        const body = typeof init.body === "string" ? init.body : null;
        if (body && body.includes('"platform.getFeeState"')) {
          // Parse to preserve the original id field so the RPC client matches.
          const parsed = JSON.parse(body) as { id?: number | string; jsonrpc?: string };
          return new Response(
            JSON.stringify({
              jsonrpc: parsed.jsonrpc ?? "2.0",
              id: parsed.id ?? 1,
              result: {
                capacity: "1000000000",
                excess: "0",
                price: "1",
                timestamp: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
    } catch {
      // Fall through to real fetch if URL parsing or body inspection fails.
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}
void custom;
void http;

