import * as path from "node:path";

import type { L1Config, NetworkConfig } from "../types.js";

/** Default L1 shape. One validator + one RPC, EVM chain id 999_001. */
export const DEFAULT_L1: L1Config = {
  name: "myl1",
  evmChainId: 999_001,
  validators: 1,
  rpcNodes: 1,
  archiveNodes: 0,
};

/**
 * Default network: 5 primary nodes (matches the 5 preconfigured local stakers),
 * one L1. avalanchego won't let a node leave bootstrap until it's connected to
 * >=75% of validator stake ((3*weight+3)/4 in chains/manager.go), and the local
 * genesis stakes 5 equal-weight validators — so a node must reach >=4 of the 5
 * (the full mesh wired in startPrimaryNetwork makes that happen). Fewer than 4
 * primary nodes can never satisfy the threshold and will hang in bootstrap.
 */
export const DEFAULT_NETWORK: NetworkConfig = {
  primaryNodes: 5,
  l1s: [DEFAULT_L1],
};

/** Apply defaults and resolve the work dir to an absolute path. */
export function normalizeConfig(input: Partial<NetworkConfig> = {}): Required<NetworkConfig> {
  const workDir = input.workDir ?? path.join(process.cwd(), ".interchain-kit");
  return {
    primaryNodes: input.primaryNodes ?? DEFAULT_NETWORK.primaryNodes,
    l1s: (input.l1s ?? DEFAULT_NETWORK.l1s).map(normalizeL1),
    workDir: path.resolve(workDir),
    // Empty bag means "let validator-set.ts use its baked-in defaults".
    timeouts: input.timeouts ?? {},
  };
}

function normalizeL1(input: Partial<L1Config> & Pick<L1Config, "name" | "evmChainId">): L1Config {
  return {
    name: input.name,
    evmChainId: input.evmChainId,
    validators: input.validators ?? 1,
    rpcNodes: input.rpcNodes ?? 1,
    archiveNodes: input.archiveNodes ?? 0,
    genesis: input.genesis,
  };
}

/**
 * Standard subpaths under workDir plus a couple of "stray" siblings the
 * relayer creates outside workDir on its own (storage dir, written
 * relative to the relayer's cwd). These exist so `clean()` can wipe them
 * without ad-hoc string joins at the call site.
 */
export function paths(workDir: string) {
  return {
    data: path.join(workDir, "data"),
    snapshots: path.join(workDir, "snapshots"),
    bin: path.join(workDir, "bin"),
    artifacts: path.join(workDir, "artifacts"),
    logs: path.join(workDir, "logs"),
    pidFile: path.join(workDir, "pids.json"),
    /** Generated icm-relayer JSON config — lives directly under workDir. */
    relayerConfigPath: path.join(workDir, "relayer.config.json"),
    /** Generated signature-aggregator JSON config — also under workDir. */
    sigaggConfigPath: path.join(workDir, "signature-aggregator.config.json"),
    /**
     * Where icm-relayer writes its checkpoint DB. It chooses this path
     * relative to its own cwd (the workDir's PARENT — typically the repo
     * root), so it lives as a SIBLING of workDir, NOT inside it. `clean()`
     * needs the absolute path to nuke it.
     */
    icmRelayerStorageDir: path.join(path.dirname(workDir), ".icm-relayer-storage"),
  };
}
