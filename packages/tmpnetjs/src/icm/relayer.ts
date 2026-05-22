// Generate the icm-relayer config and spawn the binary.
//
// The relayer ships a JSON config schema (see icm-services repo,
// sample-relayer-config.json). YAML and JSON are both accepted by viper, but we
// emit JSON since the schema is strictly key-value and JSON avoids quoting
// surprises around addresses/IDs.
//
// Schema (the fields we actually populate; see icm-services for the full set):
//   - info-api.base-url            — node info API (avalanchego http endpoint)
//   - p-chain-api.base-url         — P-Chain API (same as info-api locally)
//   - source-blockchains[]         — every chain we listen on for outbound msgs
//       .subnet-id, .blockchain-id, .rpc-endpoint, .ws-endpoint,
//       .message-contracts[teleporter] { message-format: teleporter, settings.reward-address }
//   - destination-blockchains[]    — every chain we can deliver TO; must include
//       account-private-key (relayer EOA, must be funded on that chain)
//   - log-level                    — relayer log verbosity
//
// We do NOT generate (source, dest) PAIRS — the binary itself fans out: every
// source × every destination where source != destination is relayed. Just list
// each chain once per side.

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import * as path from "node:path";

import { installBinary } from "@interchain-kit/icm-services-installer";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ChainHandle, ProcessHandle } from "../types.js";
import { paths as networkPaths } from "../internal/config.js";

export interface RelayerOptions {
  /** Work directory root (same one used by `paths()`). */
  workDir: string;
  /**
   * Private key for the relayer EOA. Must be funded on EVERY destination
   * chain. If omitted, a deterministic test key is used (NOT funded
   * automatically — caller must fund it before relaying).
   */
  relayerPrivateKey?: Hex;
  /** Address that on-chain Teleporter messages should pay as their reward. */
  rewardAddress?: Address;
  /** API port for the relayer's HTTP server. Defaults to 8080. */
  apiPort?: number;
  /** Metrics port. Defaults to 9090. */
  metricsPort?: number;
  /** Node info/P-Chain API base URL (avalanchego http). */
  infoApiBaseUrl: string;
  /** Manually tracked peers (forwarded as `manually-tracked-peers`). */
  peers?: Array<{ id: string; ip: string }>;
}

/**
 * Deterministic test key — first account of the standard Hardhat/Anvil
 * mnemonic ("test test test ... junk"). Local dev only.
 */
export const DEFAULT_RELAYER_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** EVM address derived from {@link DEFAULT_RELAYER_KEY}. Standard Anvil[0]. */
export const DEFAULT_RELAYER_ADDRESS: Address =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cfFFb92266";

export interface RelayerConfig {
  "log-level": string;
  "info-api": { "base-url": string };
  "p-chain-api": { "base-url": string };
  "api-port": number;
  "metrics-port": number;
  "allow-private-ips"?: boolean;
  "manually-tracked-peers"?: Array<{ id: string; ip: string }>;
  "source-blockchains": SourceBlockchain[];
  "destination-blockchains": DestinationBlockchain[];
}

interface SourceBlockchain {
  "subnet-id": string;
  "blockchain-id": string;
  "rpc-endpoint": { "base-url": string };
  "ws-endpoint"?: { "base-url": string };
  "message-contracts": Record<
    string,
    {
      "message-format": "teleporter";
      settings: { "reward-address": Address };
    }
  >;
}

interface DestinationBlockchain {
  "subnet-id": string;
  "blockchain-id": string;
  "rpc-endpoint": { "base-url": string };
  "account-private-key": Hex;
}

/**
 * Build the relayer JSON config. Every chain becomes both a source and a
 * destination. The relayer routes any (source, dest) pair where dest != source.
 */
export function buildRelayerConfig(
  chains: ReadonlyArray<ChainHandle & { subnetId?: string }>,
  opts: RelayerOptions,
): RelayerConfig {
  const relayerKey = opts.relayerPrivateKey ?? DEFAULT_RELAYER_KEY;
  const rewardAddress =
    opts.rewardAddress ?? privateKeyToAccount(relayerKey).address;

  // Primary network subnet ID — used for the C-Chain. Constant on every
  // Avalanche network.
  const PRIMARY_NETWORK_SUBNET_ID = "11111111111111111111111111111111LpoYY";

  const sources: SourceBlockchain[] = chains.map((c) => ({
    "subnet-id": c.subnetId ?? PRIMARY_NETWORK_SUBNET_ID,
    "blockchain-id": c.blockchainId,
    "rpc-endpoint": { "base-url": c.rpcUrl },
    ...(c.wsUrl ? { "ws-endpoint": { "base-url": c.wsUrl } } : {}),
    "message-contracts": {
      [c.teleporter]: {
        "message-format": "teleporter",
        settings: { "reward-address": rewardAddress },
      },
    },
  }));

  const destinations: DestinationBlockchain[] = chains.map((c) => ({
    "subnet-id": c.subnetId ?? PRIMARY_NETWORK_SUBNET_ID,
    "blockchain-id": c.blockchainId,
    "rpc-endpoint": { "base-url": c.rpcUrl },
    "account-private-key": relayerKey,
  }));

  return {
    "log-level": "info",
    "info-api": { "base-url": opts.infoApiBaseUrl },
    "p-chain-api": { "base-url": opts.infoApiBaseUrl },
    "api-port": opts.apiPort ?? 8080,
    "metrics-port": opts.metricsPort ?? 9090,
    "allow-private-ips": true,
    ...(opts.peers ? { "manually-tracked-peers": opts.peers } : {}),
    "source-blockchains": sources,
    "destination-blockchains": destinations,
  };
}

export interface StartRelayerResult {
  process: ProcessHandle;
  configPath: string;
  config: RelayerConfig;
}

/**
 * Write the relayer config to `<workDir>/relayer.config.json`, install the
 * pinned icm-relayer binary, and spawn it detached with logs redirected to
 * `<workDir>/logs/icm-relayer.log`.
 */
export async function startRelayer(
  chains: ReadonlyArray<ChainHandle & { subnetId?: string }>,
  opts: RelayerOptions,
): Promise<StartRelayerResult> {
  const p = networkPaths(opts.workDir);
  await mkdir(p.logs, { recursive: true });
  await mkdir(opts.workDir, { recursive: true });

  const config = buildRelayerConfig(chains, opts);
  const configPath = path.join(opts.workDir, "relayer.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const binary = await installBinary("icm-relayer", { cacheDir: p.bin });
  const logFile = path.join(p.logs, "icm-relayer.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(binary, ["--config-file", configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("Failed to spawn icm-relayer (no pid)");
  }

  return {
    process: { pid: child.pid, binary, logFile },
    configPath,
    config,
  };
}
