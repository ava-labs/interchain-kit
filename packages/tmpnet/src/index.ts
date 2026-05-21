// Public entry for @interchain-kit/tmpnet.

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

export { DEFAULT_NETWORK, DEFAULT_L1, normalizeConfig, paths } from "./config.js";

// Implementations land in:
//   network.ts  — spawn avalanchego, primary network boot
//   l1.ts       — CreateSubnet → CreateChain(SubnetEVMID) → ConvertSubnetToL1
//   icm.ts      — deploy TeleporterMessenger + TeleporterRegistry per chain
//   relayer.ts  — generate icm-relayer config + spawn relayer
//   sigagg.ts   — spawn signature-aggregator
//   artifacts.ts— write network.json + addresses.ts + .env
//   snapshot.ts — tar-up post-L1 state; restore on subsequent `up`
//   commands.ts — up() / down() / clean() — glue
//
// These are dispatched as Phase 3 follow-up work.

export { up, down, clean } from "./commands.js";
export type { UpOptions, DownOptions } from "./commands.js";

export {
  configHash,
  hasSnapshot,
  captureSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  listSnapshots,
} from "./snapshot.js";

// Re-exported so demo scripts (and downstream consumers) can drive the
// signature-aggregator HTTP service from outside the orchestrator.
export {
  startSignatureAggregator,
  discoverNetworkPeers,
  type StartSigAggResult,
  type SigAggOptions,
  type AggregateSignaturesRequest,
  type AggregateSignaturesResponse,
} from "./sigagg.js";
