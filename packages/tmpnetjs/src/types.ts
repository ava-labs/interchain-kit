// Public types for tmpnetjs.
//
// These types define what users (and our CLI) interact with. The
// implementation lives in network.ts, l1.ts, icm.ts, relayer.ts.

import type { Address, Hex } from "viem";

// ----- Configuration -------------------------------------------------------

/** Top-level network shape. One config file controls the whole topology. */
export interface NetworkConfig {
  /** Number of primary-network validators (C/P/X chains). Default: 2. */
  primaryNodes: number;
  /** L1s to create. Each gets its own EVM subnet. Default: one L1. */
  l1s: L1Config[];
  /** Where to keep node data, snapshots, binaries. Default: `<cwd>/.interchain-kit`. */
  workDir?: string;
}

export interface L1Config {
  /** Short identifier used in filesystem paths and artifacts. */
  name: string;
  /** EVM chain ID for this L1. Pick something unique per L1 (e.g. 999001). */
  evmChainId: number;
  /** Number of dedicated validator nodes tracking this L1. Default: 1. */
  validators: number;
  /** Number of RPC-only nodes. Default: 1. */
  rpcNodes: number;
  /** Number of archive nodes. Default: 0. */
  archiveNodes: number;
  /**
   * Optional genesis override. If omitted, we generate a sensible default
   * (subnet-evm with the funded dev address pre-allocated AVAX and the
   * ValidatorManager proxy slot pre-allocated).
   */
  genesis?: unknown;
}

// ----- Runtime handle ------------------------------------------------------

/** Everything you need to interact with a running interchain-kit network. */
export interface NetworkHandle {
  /** C-Chain on the local primary network. */
  cChain: ChainHandle;
  /** The L1s you asked for, in declaration order. */
  l1s: L1Handle[];
  /** icm-relayer process metadata. */
  relayer: ProcessHandle;
  /** signature-aggregator process metadata. */
  signatureAggregator: ProcessHandle;
  /** Funded dev account — has AVAX on every chain. */
  funded: FundedAccount;
  /** Artifacts written to disk for tests and scripts. */
  artifacts: NetworkArtifacts;
}

export interface ChainHandle {
  /** Short name used in artifacts (`cchain`, or the L1's `name`). */
  name: string;
  /** EVM chain ID. */
  evmChainId: number;
  /** Avalanche blockchain ID (cb58 of the chain's UUID). */
  blockchainId: string;
  /** HTTP RPC URL for sending transactions. */
  rpcUrl: string;
  /** WebSocket RPC URL (omitted if the node doesn't enable it). */
  wsUrl?: string;
  /** TeleporterMessenger address on this chain. */
  teleporter: Address;
  /** TeleporterRegistry address on this chain. */
  teleporterRegistry: Address;
}

/** Same shape as ChainHandle, plus L1-specific fields. */
export interface L1Handle extends ChainHandle {
  /** Subnet ID this L1 was converted from. */
  subnetId: string;
  /** ValidatorManager proxy address (always at VALIDATOR_MANAGER_PROXY_ADDRESS). */
  validatorManager: Address;
}

export interface ProcessHandle {
  pid: number;
  /** Path to the binary running this process. */
  binary: string;
  /** Path to the log file we're tailing for this process. */
  logFile: string;
}

export interface FundedAccount {
  /** EVM address. Has AVAX on every chain. */
  address: Address;
  /** Private key. WARNING: local-only, do not reuse on testnet/mainnet. */
  privateKey: Hex;
}

// ----- Artifacts (what we write to disk for tests/scripts) -----------------

export interface NetworkArtifacts {
  /** Absolute path to the artifacts directory. */
  dir: string;
  /** Path to network.json (canonical, machine-readable). */
  networkJson: string;
  /** Path to addresses.ts (typed exports for solidity tests + TS scripts). */
  addressesTs: string;
  /** Path to .env file (for shell scripts and forge `vm.envAddress`). */
  envFile: string;
}

/** Shape of the emitted network.json (and what addresses.ts mirrors). */
export interface NetworkArtifactDoc {
  funded: FundedAccount;
  cChain: ChainHandle;
  l1s: L1Handle[];
}
