// Glue layer for up() / down() / clean(). Composes network.ts + l1.ts + icm.ts
// + relayer.ts + sigagg.ts + artifacts.ts + snapshot.ts into the public CLI flow.

import { mkdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";

import { normalizeConfig, paths } from "../internal/config.js";
import type {
  ChainHandle,
  L1Handle,
  NetworkConfig,
  NetworkHandle,
} from "../types.js";
import {
  captureSnapshot,
  configHash,
  deleteSnapshot,
  hasSnapshot,
  restoreSnapshot,
  validateSnapshot,
} from "./snapshot.js";
import { startPrimaryNetwork, waitForBootstrap, findAvalanchego, PRIMARY_PORTS } from "../network/spawn.js";
import { createL1, uninstallFeeStatePatch, resolvePluginDir, SUBNET_EVM_VM_ID } from "../l1/create.js";
import {
  assertNoStaleNetwork,
  assertPortsFree,
  checkRpcChainVmCompatibility,
  PreflightError,
} from "../internal/preflight.js";
import { findChainCreationError } from "../internal/diagnose.js";
import { deployIcmStack, type DeployTarget } from "../icm/teleporter.js";
import { startRelayer } from "../icm/relayer.js";
import { startSignatureAggregator, type StartSigAggResult } from "../icm/sigagg.js";
import { initializeL1ValidatorSet } from "../l1/validator-set.js";
import { writeArtifactsForNetwork } from "./artifacts.js";
import { fundedAccount, EWOQ_PRIVATE_KEY } from "../internal/wallet.js";
import { DEFAULT_RELAYER_ADDRESS } from "../icm/relayer.js";
import {
  killTracked,
  readPidFile,
  setPidFileHash,
  type PidRecord,
  type ProcessKind,
} from "../internal/process.js";
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

/**
 * Reap every PID currently recorded in the pid file. Used both by `down()`
 * and by `up()`'s SIGINT / try-catch error path. Kill order:
 *
 *   relayer → sigagg → l1 nodes → primary nodes
 *
 * The high-level services exit cleanly on SIGTERM; killing them first means
 * they won't reconnect to nodes that are mid-shutdown and emit confusing
 * "peer closed connection" log lines. avalanchego (primary + l1) gets killed
 * by process-group signal so the subnet-evm plugin grandchild dies with it.
 */
async function reapAll(pidFile: string): Promise<void> {
  const { processes } = readPidFile(pidFile);
  const order: ProcessKind[] = ["relayer", "sigagg", "l1", "primary"];
  for (const kind of order) {
    const group = processes.filter((p) => p.kind === kind);
    // Reap one kind in parallel — they're independent processes.
    await Promise.all(group.map((p) => killTracked(p)));
  }
}

/**
 * Defensive sweep for orphaned subnet-evm plugin children. SIGTERM cascades
 * via process-group, but if a previous run pre-dated detached spawns there
 * may still be PPID=1 orphans on this host. Match by both the plugin VM ID
 * AND the configured workDir so we never touch another user's processes.
 */
function sweepOrphanedPlugins(workDir: string): void {
  try {
    // `ps -A -o pid=,command=` is portable across macOS/Linux. We filter in
    // JS so we can match against the full command line (which includes the
    // plugin path under workDir).
    const out = execSync("ps -A -o pid=,command=", { encoding: "utf8" });
    const wanted = path.resolve(workDir);
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx <= 0) continue;
      const pid = Number(trimmed.slice(0, spaceIdx));
      if (!Number.isFinite(pid) || pid <= 1) continue;
      const cmd = trimmed.slice(spaceIdx + 1);
      // Two heuristics; require BOTH so we don't kill someone else's
      // subnet-evm from a different workspace.
      if (!cmd.includes(SUBNET_EVM_VM_ID)) continue;
      if (!cmd.includes(wanted)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    // ps not available or returned non-zero — sweep is best-effort.
  }
}

export async function up(opts: UpOptions = {}): Promise<NetworkHandle> {
  const config = normalizeConfig(opts.config);
  const p = paths(config.workDir);
  await mkdir(config.workDir, { recursive: true });

  const hash = configHash(config);

  // Install signal handlers + cleanup-on-throw FIRST so anything that spawns
  // below is reaped on Ctrl-C or partial failure. PIDs go to disk
  // incrementally inside spawnTracked, so reapAll always sees the
  // latest set.
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted) return; // double Ctrl-C — let Node force-exit
    interrupted = true;
    console.error(`\n[up] received ${sig}, tearing down partial network...`);
    reapAll(p.pidFile)
      .catch(() => undefined)
      .finally(() => {
        uninstallFeeStatePatch();
        process.exit(130);
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // ---- Preflight: fail in milliseconds, not minutes. ---------------------
    // (a) Refuse to boot over a previous network that's still running.
    assertNoStaleNetwork(p.pidFile);
    // (b) Every node HTTP port must be bindable (primary nodes + L1 nodes all
    // follow the same base+stride layout, in spawn order).
    const totalNodes =
      config.primaryNodes +
      config.l1s.reduce((n, l1) => n + l1.validators + l1.rpcNodes + l1.archiveNodes, 0);
    await assertPortsFree(
      Array.from(
        { length: totalNodes },
        (_, i) => PRIMARY_PORTS.BASE_HTTP_PORT + i * PRIMARY_PORTS.PORT_INCREMENT,
      ),
    );
    // (c) If we'll create L1s, the subnet-evm plugin must exist AND speak the
    // same RPCChainVM protocol as avalanchego. A mismatch otherwise burns the
    // full L1-RPC timeout with the handshake error hidden in a node log.
    if (config.l1s.length > 0) {
      const avalanchegoBinary = findAvalanchego(config.workDir);
      const pluginDir = resolvePluginDir(avalanchegoBinary);
      checkRpcChainVmCompatibility(
        avalanchegoBinary,
        path.join(pluginDir, SUBNET_EVM_VM_ID),
      );
    }

    if (!opts.fresh && (await hasSnapshot(config.workDir, hash))) {
      const v = await validateSnapshot(config.workDir, hash);
      if (v.ok) {
        console.log(`[snapshot] restoring cached state for config ${hash}...`);
        await restoreSnapshot(config.workDir, hash);
        // Snapshots capture disk state, not running processes — fall through
        // and relaunch nodes against the restored data dirs.
      } else {
        console.log(`[snapshot] ignoring stale snapshot (${v.reason}); cold boot`);
        await deleteSnapshot(config.workDir, hash);
        // Wipe data too — residual C-Chain state from a prior run would leave
        // the Teleporter deployer with a non-zero nonce, breaking the
        // universal-deployer invariant the relayer relies on.
        await rm(p.data, { recursive: true, force: true });
      }
    } else if (opts.fresh) {
      // Same reasoning as above: --fresh implies "act like clean was just run."
      await rm(p.data, { recursive: true, force: true });
    }

    // Tag the pid file with the hash so `down --delete-snapshot` and tools
    // that need to associate processes with a snapshot can find it.
    setPidFileHash(p.pidFile, hash);

    // 1. Spawn primary network.
    console.log(`[primary] booting ${config.primaryNodes} avalanchego node(s)...`);
    const primary = await startPrimaryNetwork(
      { primaryNodes: config.primaryNodes, workDir: config.workDir },
      p,
    );
    const primaryApiURI = primary.apiURIs[0];
    if (!primaryApiURI) throw new Error("startPrimaryNetwork returned no API URIs");
    console.log(`[primary] ${primary.nodes.length} node(s) up @ ${primaryApiURI}`);

    // Wait for P-Chain bootstrap completion before issuing any txs —
    // waitForNodeID only verifies /ext/info is reachable, not that the
    // P/X/C chains have caught up. Without this, the first CreateSubnetTx
    // fails with "Transaction status not found" because the executor
    // hasn't initialized yet.
    console.log("[primary] waiting for P-Chain bootstrap (~60s)...");
    await waitForBootstrap(primaryApiURI, "P", 120_000);
    console.log(`[primary] P-Chain online @ ${primaryApiURI}`);

    // 2. Create each L1.
    const l1Results = [];
    for (const l1Config of config.l1s) {
      console.log(`[l1 ${l1Config.name}] creating subnet + chain + L1 conversion...`);
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
      console.log(`[init-l1 ${r.l1.name}] initializing ValidatorManager...`);
      const initResult = await initializeL1ValidatorSet({
        workDir: config.workDir,
        primaryURI: primaryApiURI,
        subnetId: r.l1.subnetId,
        blockchainId: r.l1.blockchainId,
        l1EvmChainId: r.l1.evmChainId,
        l1RpcUrl: r.l1.rpcUrl,
        validatorNodeId: r.bootstrapValidator.nodeId,
        validatorBlsPublicKey: r.bootstrapValidator.blsPublicKey,
        timeouts: config.timeouts,
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
      console.log(`[l1 ${r.l1.name}] waiting for EVM RPC to start producing blocks...`);
      try {
        await waitForChainBootstrap(r.l1.rpcUrl, config.timeouts?.l1RpcMs);
      } catch (err) {
        // The timeout itself says nothing — the cause (plugin handshake
        // failure, VM init crash) is in the node log. Surface it.
        const cause = findChainCreationError(p.logs, r.l1.blockchainId);
        throw cause
          ? new Error(`${(err as Error).message}\nNode log shows the chain failed to start:\n  ${cause}`)
          : err;
      }
      console.log(`[l1 ${r.l1.name}] RPC online @ ${r.l1.rpcUrl}`);
    }

    // 4. Deploy Teleporter + Registry on every chain.
    console.log("[icm] deploying Teleporter + Registry on every chain...");
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
    console.log("[relayer] funding relayer EOA on C-Chain...");
    await fundRelayerOn(cChain.rpcUrl, cChain.evmChainId);

    // 7. Start signature-aggregator (if not already running from L1 init) + relayer.
    if (!sigaggResult) {
      console.log("[sigagg] starting signature-aggregator...");
      sigaggResult = await startSignatureAggregator({
        workDir: config.workDir,
        infoApiBaseUrl: primaryApiURI,
        apiPort: 8090,
        metricsPort: 8091,
      });
    }
    console.log("[relayer] discovering peer nodes...");
    const { discoverNetworkPeers } = await import("../icm/sigagg.js");
    const relayerPeers = await discoverNetworkPeers(config.workDir);
    console.log("[relayer] spawning icm-relayer...");
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

    // 8. Write artifacts (network.json + addresses.ts + .env).
    console.log(`[artifacts] writing to ${p.artifacts}...`);
    network.artifacts = await writeArtifactsForNetwork(network, config.workDir);

    // 9. Capture a snapshot for next `up`.
    console.log(`[snapshot] capturing state for next 'up' (key=${hash})...`);
    await captureSnapshot(config.workDir, hash).catch((err: unknown) => {
      console.error(`warning: snapshot capture failed (${(err as Error).message})`);
    });

    console.log("[up] network ready");
    return network;
  } catch (err) {
    if (err instanceof PreflightError) {
      // Nothing was spawned, and the pid file may describe a previous,
      // still-healthy network — reaping here would kill the very processes
      // the error tells the user about. Just rethrow.
      console.error(`[up] preflight failed: ${(err as Error).message}`);
      throw err;
    }
    // Tear down anything we spawned so the user isn't left with zombies.
    console.error(`[up] failed, reaping in-progress processes: ${(err as Error).message}`);
    await reapAll(p.pidFile).catch(() => undefined);
    sweepOrphanedPlugins(config.workDir);
    uninstallFeeStatePatch();
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export async function down(opts: DownOptions = {}): Promise<void> {
  const workDir = opts.workDir ?? path.join(process.cwd(), ".interchain-kit");
  const keepSnapshot = opts.keepSnapshot ?? true;
  const p = paths(workDir);

  // Always restore globalThis.fetch — installFeeStatePatch in l1/create.ts
  // wraps it during up(). Without this, a process that embeds up()/down()
  // (e.g. integration tests) keeps the wrapper indefinitely.
  uninstallFeeStatePatch();

  const { processes } = readPidFile(p.pidFile);
  if (processes.length === 0) {
    // No record of anything running; still do the orphan sweep below so
    // stale subnet-evm processes from earlier runs don't pile up.
  } else {
    await reapAll(p.pidFile);
  }

  // Defensive sweep: pick up any subnet-evm plugin grandchild that didn't
  // die with its avalanchego parent (e.g. an avalanchego killed before this
  // PID record schema landed).
  sweepOrphanedPlugins(workDir);

  // Wipe the pid file last so a partial failure above leaves something for
  // the next `down` to retry.
  await rm(p.pidFile, { force: true });

  if (!keepSnapshot) {
    await rm(p.snapshots, { recursive: true, force: true });
  }
}

export async function clean(opts: { workDir?: string } = {}): Promise<void> {
  const workDir = opts.workDir ?? path.join(process.cwd(), ".interchain-kit");
  const p = paths(workDir);

  // Try to bring down anything that's still running. If down() throws
  // (corrupt pid file, etc.) keep going — the user asked for a nuke.
  await down({ workDir, keepSnapshot: false }).catch(() => undefined);

  // Wipe everything except cached binaries (those are big and reusable).
  await Promise.all([
    rm(p.data, { recursive: true, force: true }),
    rm(p.artifacts, { recursive: true, force: true }),
    rm(p.snapshots, { recursive: true, force: true }),
    rm(p.logs, { recursive: true, force: true }),
    rm(p.pidFile, { force: true }),
    rm(p.relayerConfigPath, { force: true }),
    rm(p.sigaggConfigPath, { force: true }),
    rm(p.icmRelayerStorageDir, { recursive: true, force: true }),
  ]);
}

// Re-export internal pid types so callers (status command, debuggers) can
// inspect the same record we write.
export type { PidRecord, ProcessKind };
