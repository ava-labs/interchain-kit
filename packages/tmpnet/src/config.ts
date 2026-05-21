import * as path from "node:path";

import type { L1Config, NetworkConfig } from "./types.js";

/** Default L1 shape. One validator + one RPC, EVM chain id 999_001. */
export const DEFAULT_L1: L1Config = {
  name: "myl1",
  evmChainId: 999_001,
  validators: 1,
  rpcNodes: 1,
  archiveNodes: 0,
};

/** Default network: 5 primary nodes (matches the 5 preconfigured local stakers), one L1. */
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

/** Standard subpaths under workDir. */
export function paths(workDir: string) {
  return {
    data: path.join(workDir, "data"),
    snapshots: path.join(workDir, "snapshots"),
    bin: path.join(workDir, "bin"),
    artifacts: path.join(workDir, "artifacts"),
    logs: path.join(workDir, "logs"),
    pidFile: path.join(workDir, "pids.json"),
  };
}
