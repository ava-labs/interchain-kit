// Public entry for tmpnetjs.
//
// Two-sided surface:
//   - Consumer  — read the artifacts and talk to a booted network
//                 (loadNetwork, makeClients, pollUntil, …)
//   - Producer  — boot/snapshot/tear-down a local Avalanche network
//                 (up, down, clean, captureSnapshot, …)
//
// Source layout:
//   sdk/           consumer-side helpers
//   network/       producer: primary network (avalanchego nodes)
//   l1/            producer: L1 lifecycle (create, genesis, validator set)
//   icm/           producer: Teleporter + icm-relayer + signature-aggregator
//   orchestrator/  producer: top-level commands, snapshot, artifacts
//   internal/      shared internals (not exported)
//
// Examples and downstream code should only import from "tmpnetjs", never
// reach into subpaths directly.

// ---- Types -----------------------------------------------------------------

export type {
  NetworkConfig,
  L1Config,
  NetworkHandle,
  ChainHandle,
  L1Handle,
  ProcessHandle,
  FundedAccount,
  NetworkArtifacts,
  NetworkArtifactDoc,
} from "./types.js";

// ---- Consumer SDK ----------------------------------------------------------

export { loadNetwork, pickL1, loadArtifact, findWorkDir } from "./sdk/load.js";
export { makeClients, viemChainFor, type Clients } from "./sdk/client.js";
export { blockchainIdToBytes32 } from "./sdk/codec.js";
export { pollUntil } from "./sdk/poll.js";

// `findAvalanchego` is producer-side but useful enough for consumer scripts
// (add-validator.ts) that we surface it.
export { findAvalanchego } from "./network/spawn.js";

// ---- Producer: config + commands ------------------------------------------

export { DEFAULT_NETWORK, DEFAULT_L1, normalizeConfig, paths } from "./internal/config.js";

export { up, down, clean } from "./orchestrator/commands.js";
export type { UpOptions, DownOptions } from "./orchestrator/commands.js";

export {
  configHash,
  hasSnapshot,
  captureSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  listSnapshots,
} from "./orchestrator/snapshot.js";

// ---- ICM service runtime helpers ------------------------------------------

// signature-aggregator: exposed so consumer scripts can drive the running
// aggregator without re-implementing the HTTP client.
export {
  startSignatureAggregator,
  discoverNetworkPeers,
  aggregateSignaturesAt,
  DEFAULT_SIGAGG_URL,
  type StartSigAggResult,
  type SigAggOptions,
  type AggregateSignaturesRequest,
  type AggregateSignaturesResponse,
} from "./icm/sigagg.js";
