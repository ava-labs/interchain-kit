// Glue layer for up() / down() / clean(). Composes network.ts + l1.ts + icm.ts
// + relayer.ts + sigagg.ts + artifacts.ts + snapshot.ts into the public CLI flow.

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import { normalizeConfig, paths } from "./config.js";
import type {
  ChainHandle,
  L1Handle,
  NetworkConfig,
  NetworkHandle,
  ProcessHandle,
} from "./types.js";
import { captureSnapshot, configHash, hasSnapshot, restoreSnapshot } from "./snapshot.js";
import { startPrimaryNetwork, waitForBootstrap } from "./network.js";
import { createL1 } from "./l1.js";
import { deployIcmStack, type DeployTarget } from "./icm.js";
import { startRelayer } from "./relayer.js";
import { startSignatureAggregator, type StartSigAggResult } from "./sigagg.js";
import { initializeL1ValidatorSet } from "./validator-set.js";
import { writeArtifactsForNetwork } from "./artifacts.js";
import { fundedAccount, EWOQ_PRIVATE_KEY } from "./wallet.js";
import { DEFAULT_RELAYER_ADDRESS } from "./relayer.js";
import { createWalletClient, createPublicClient, http, parseEther, defineChain, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface UpOptions {
  /** Skip snapshot restore even if one exists. Default false. */
  fresh?: boolean;
  /** Override the full config. If omitted, uses DEFAULT_NETWORK. */
  config?: Partial<NetworkConfig>;
}

export interface DownOptions {
  /** Keep the snapshot for next `up`. Default true. */
  keepSnapshot?: boolean;
  /** Where the network lives. Default `<cwd>/.interchain-kit`. */
  workDir?: string;
}

interface PidRecord {
  hash: string;
  pids: number[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readPidRecord(pidFile: string): Promise<PidRecord | null> {
  if (!(await exists(pidFile))) return null;
  try {
    return JSON.parse(await readFile(pidFile, "utf8")) as PidRecord;
  } catch {
    return null;
  }
}

async function writePidRecord(pidFile: string, record: PidRecord): Promise<void> {
  await mkdir(path.dirname(pidFile), { recursive: true });
  await writeFile(pidFile, JSON.stringify(record, null, 2));
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
}

/**
 * Query a running avalanchego node for the local C-Chain blockchain ID.
 * Local C-Chain has EVM chainId 43112 and a deterministic blockchain ID, but
 * fetching from the node avoids hardcoding it.
 */
/** Poll an L1's EVM RPC until it stops returning 503 / "bootstrapping". */
async function waitForChainBootstrap(rpcUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: string = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string; error?: { message: string } };
        if (json.result) return;
        lastErr = json.error?.message ?? "unknown";
      } else {
        lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`L1 chain at ${rpcUrl} never bootstrapped within ${timeoutMs}ms: ${lastErr}`);
}

async function fetchCChainBlockchainId(apiURI: string): Promise<string> {
  const res = await fetch(`${apiURI}/ext/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "info.getBlockchainID",
      params: { alias: "C" },
    }),
  });
  const json = (await res.json()) as { result?: { blockchainID?: string }; error?: { message: string } };
  if (json.error) throw new Error(`info.getBlockchainID failed: ${json.error.message}`);
  if (!json.result?.blockchainID) throw new Error("info.getBlockchainID returned no blockchainID");
  return json.result.blockchainID;
}

const LOCAL_C_CHAIN_EVM_ID = 43112;

/** Fund the relayer EOA on a chain. L1s pre-fund in genesis; C-Chain needs this. */
async function fundRelayerOn(rpcUrl: string, evmChainId: number, amountAvax = 100n): Promise<void> {
  const chain = defineChain({
    id: evmChainId,
    name: `local-${evmChainId}`,
    nativeCurrency: { name: "Avax", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  if ((await pub.getBalance({ address: getAddress(DEFAULT_RELAYER_ADDRESS) })) > 0n) return;
  const account = privateKeyToAccount(EWOQ_PRIVATE_KEY);
  const wc = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const hash = await wc.sendTransaction({
    // getAddress() returns the checksummed form viem 2.50+ requires. The
    // constant in relayer.ts uses the Anvil[0] mixed-case string which
    // doesn't survive viem's strict checksum validation.
    to: getAddress(DEFAULT_RELAYER_ADDRESS),
    value: parseEther(amountAvax.toString()),
  });
  await pub.waitForTransactionReceipt({ hash });
}

export async function up(opts: UpOptions = {}): Promise<NetworkHandle> {
  const config = normalizeConfig(opts.config);
  const p = paths(config.workDir);
  await mkdir(config.workDir, { recursive: true });

  const hash = configHash(config);
  if (!opts.fresh && (await hasSnapshot(config.workDir, hash))) {
    await restoreSnapshot(config.workDir, hash);
    // Snapshots capture disk state, not running processes — fall through and
    // relaunch nodes against the restored data dirs.
  }

  // 1. Spawn primary network.
  const primary = await startPrimaryNetwork(
    { primaryNodes: config.primaryNodes, workDir: config.workDir },
    p,
  );
  const primaryApiURI = primary.apiURIs[0];
  if (!primaryApiURI) throw new Error("startPrimaryNetwork returned no API URIs");

  // Wait for P-Chain bootstrap completion before issuing any txs —
  // waitForNodeID only verifies /ext/info is reachable, not that the
  // P/X/C chains have caught up. Without this, the first CreateSubnetTx
  // fails with "Transaction status not found" because the executor
  // hasn't initialized yet.
  await waitForBootstrap(primaryApiURI, "P", 120_000);

  // 2. Create each L1.
  const l1Results = [];
  for (const l1Config of config.l1s) {
    l1Results.push(
      await createL1(
        l1Config,
        {
          apiURIs: primary.apiURIs,
          nodeCount: primary.nodes.length,
        },
        p,
        config.workDir,
      ),
    );
  }

  // 3. Discover C-Chain blockchain ID from the live node.
  const cChainBlockchainId = await fetchCChainBlockchainId(primaryApiURI);

  // 3b. Initialize each L1's ValidatorManager.
  //
  // ConvertSubnetToL1 only updates P-Chain state — the L1's ValidatorManager
  // contract on the EVM still has _initialized=false and the chain refuses
  // to produce blocks until initializeValidatorSet runs. The orchestrator
  // in validator-set.ts handles: advancing P-Chain height, rolling past
  // the first ACP-181 epoch, starting sig-aggregator, calling
  // initializeValidatorSet, then waiting for the L1 RPC to come online.
  let sigaggResult: StartSigAggResult | null = null;
  for (const r of l1Results) {
    const initResult = await initializeL1ValidatorSet({
      workDir: config.workDir,
      primaryURI: primaryApiURI,
      subnetId: r.l1.subnetId,
      blockchainId: r.l1.blockchainId,
      l1EvmChainId: r.l1.evmChainId,
      l1RpcUrl: r.l1.rpcUrl,
      validatorNodeId: r.bootstrapValidator.nodeId,
      validatorBlsPublicKey: r.bootstrapValidator.blsPublicKey,
      log: (msg) => console.log(`[init-l1 ${r.l1.name}] ${msg}`),
    });
    // The sig-aggregator the orchestrator started stays alive — we reuse it
    // as the network's sigagg below. Multiple L1s share the same instance
    // since later starts are short-circuited by the port-in-use check (and
    // tracked-subnet-ids only matters at startup; aggregator requests pass
    // signing-subnet-id per-request anyway).
    if (!sigaggResult) sigaggResult = initResult.sigagg;
  }

  // 3c. Wait for every L1's EVM RPC to finish bootstrapping. After
  // initializeValidatorSet commits, the chain begins producing blocks and
  // the RPC stops returning 503.
  for (const r of l1Results) {
    await waitForChainBootstrap(r.l1.rpcUrl);
  }

  // 4. Deploy Teleporter + Registry on every chain.
  const deployTargets: DeployTarget[] = [
    { name: "cchain", evmChainId: LOCAL_C_CHAIN_EVM_ID, rpcUrl: primary.cChainRpcUrl },
    ...l1Results.map((r) => ({
      name: r.l1.name,
      evmChainId: r.l1.evmChainId,
      rpcUrl: r.l1.rpcUrl,
    })),
  ];
  const icmAddresses = await deployIcmStack(deployTargets, EWOQ_PRIVATE_KEY);

  const cchainIcm = icmAddresses.get("cchain");
  if (!cchainIcm) throw new Error("deployIcmStack did not return cchain addresses");

  // 5. Assemble ChainHandle (C-Chain) and L1Handle[] with the deployed addresses.
  const cChain: ChainHandle = {
    name: "cchain",
    evmChainId: LOCAL_C_CHAIN_EVM_ID,
    blockchainId: cChainBlockchainId,
    rpcUrl: primary.cChainRpcUrl,
    wsUrl: primary.cChainRpcUrl.replace(/^http/, "ws").replace(/\/rpc$/, "/ws"),
    teleporter: cchainIcm.teleporter,
    teleporterRegistry: cchainIcm.teleporterRegistry,
  };

  const l1s: L1Handle[] = l1Results.map((r) => {
    const icm = icmAddresses.get(r.l1.name);
    if (!icm) throw new Error(`deployIcmStack did not return addresses for L1 "${r.l1.name}"`);
    return {
      ...r.l1,
      teleporter: icm.teleporter,
      teleporterRegistry: icm.teleporterRegistry,
    };
  });

  // 6. Fund the relayer EOA on C-Chain (L1s already pre-fund it in genesis).
  await fundRelayerOn(cChain.rpcUrl, cChain.evmChainId);

  // 7. Start signature-aggregator (if not already running from L1 init) + relayer.
  if (!sigaggResult) {
    sigaggResult = await startSignatureAggregator({
      workDir: config.workDir,
      infoApiBaseUrl: primaryApiURI,
      apiPort: 8090,
      metricsPort: 8091,
    });
  }
  const { discoverNetworkPeers } = await import("./sigagg.js");
  const relayerPeers = await discoverNetworkPeers(config.workDir);
  const relayerResult = await startRelayer(
    [cChain, ...l1s.map((l1) => ({ ...l1, subnetId: l1.subnetId }))],
    {
      workDir: config.workDir,
      infoApiBaseUrl: primaryApiURI,
      peers: relayerPeers,
    },
  );

  const network: NetworkHandle = {
    cChain,
    l1s,
    relayer: relayerResult.process,
    signatureAggregator: sigaggResult.process,
    funded: fundedAccount(),
    artifacts: {
      dir: p.artifacts,
      networkJson: path.join(p.artifacts, "network.json"),
      addressesTs: path.join(p.artifacts, "addresses.ts"),
      envFile: path.join(p.artifacts, ".env"),
    },
  };

  // 7. Write artifacts (network.json + addresses.ts + .env).
  network.artifacts = await writeArtifactsForNetwork(network, config.workDir);

  // 8. Capture a snapshot for next `up`.
  await captureSnapshot(config.workDir, hash).catch((err: unknown) => {
    console.error(`warning: snapshot capture failed (${(err as Error).message})`);
  });

  // 9. Record all PIDs for `down`.
  const allPids: number[] = [
    ...primary.nodes.map((n) => n.pid),
    ...l1Results.flatMap((r) => r.nodes.map((n: ProcessHandle) => n.pid)),
    relayerResult.process.pid,
    sigaggResult.process.pid,
  ];
  await writePidRecord(p.pidFile, { hash, pids: allPids });

  return network;
}

export async function down(opts: DownOptions = {}): Promise<void> {
  const workDir = opts.workDir ?? path.join(process.cwd(), ".interchain-kit");
  const keepSnapshot = opts.keepSnapshot ?? true;
  const p = paths(workDir);

  const record = await readPidRecord(p.pidFile);
  if (!record) return;

  for (const pid of record.pids) killPid(pid);
  await rm(p.pidFile, { force: true });

  if (!keepSnapshot) {
    await rm(p.snapshots, { recursive: true, force: true });
  }
}

export async function clean(opts: { workDir?: string } = {}): Promise<void> {
  const workDir = opts.workDir ?? path.join(process.cwd(), ".interchain-kit");
  const p = paths(workDir);

  const record = await readPidRecord(p.pidFile);
  if (record) for (const pid of record.pids) killPid(pid);

  // Wipe everything except cached binaries (those are big and reusable).
  await Promise.all([
    rm(p.data, { recursive: true, force: true }),
    rm(p.artifacts, { recursive: true, force: true }),
    rm(p.snapshots, { recursive: true, force: true }),
    rm(p.logs, { recursive: true, force: true }),
    rm(p.pidFile, { force: true }),
  ]);
}
