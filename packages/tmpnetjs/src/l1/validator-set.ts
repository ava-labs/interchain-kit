// Post-conversion L1 bring-up: advance P-Chain, roll past first ACP-181
// epoch, start sig-aggregator, call initializeValidatorSet.
//
// Ported from avalanche-sdk-typescript/e2e/test/warp-l1-flow.integration.test.ts
// (step 7) plus the helpers/{wait,proposervm,sig-aggregator}.ts files. The
// Bun-isms (Bun.sleep, Bun.spawn, Bun.$) have been replaced with Node
// built-ins (setTimeout via promise, child_process.spawn already in sigagg.ts).
//
// Why this step is mandatory: ConvertSubnetToL1Tx commits the validator set
// on the P-Chain, but the L1's ValidatorManager contract on the EVM still
// has `_initialized = false`. Until initializeValidatorSet runs, the L1's
// validator set is empty from the EVM's perspective AND the chain refuses
// to produce blocks (eth_chainId returns 503). The flow:
//
//   1. Wait for getCurrentValidators(subnetID) to list >=1 validator —
//      this is the P-Chain acknowledging the conversion.
//   2. Advance P-Chain height by N self-transfers so the L1's proposerVM
//      catches the conversion in its tracked view of P-Chain.
//   3. Roll L1 past first ACP-181 epoch: send two cheap EVM txs separated
//      by >epochDuration so epoch 1 seals and the next block lands in
//      epoch 2 with a non-zero PChainHeight.
//   4. Start signature-aggregator tracking our subnet.
//   5. Call initializeValidatorSet via @avalanche-sdk/interchain. That
//      builds a SubnetToL1Conversion warp message, aggregates BLS sigs
//      across the L1's bootstrap validators, packs the signed message
//      into a Warp-precompile access list, and submits the EVM tx.
//   6. Wait for the L1 RPC to stop returning 503.

import { createAvalancheWalletClient } from "@avalanche-sdk/client";
import { privateKeyToAvalancheAccount } from "@avalanche-sdk/client/accounts";
import { avalancheLocal } from "@avalanche-sdk/client/chains";
import {
  initializeValidatorSet,
  VALIDATOR_MANAGER_PROXY_ADDRESS,
} from "@avalanche-sdk/interchain";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { startSignatureAggregator, type StartSigAggResult } from "../icm/sigagg.js";
import { findChainCreationError } from "../internal/diagnose.js";
import { paths as networkPaths } from "../internal/config.js";
import { EWOQ_PRIVATE_KEY } from "../internal/wallet.js";
import type { NetworkTimeouts } from "../types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// Default timeouts (ms). All overridable per-call via NetworkConfig.timeouts.
// `sigaggHealthMs` is part of the public surface but owned by sigagg.ts —
// the orchestrator forwards it directly to startSignatureAggregator.
// ----------------------------------------------------------------------------

/** Sleep after advancing P-Chain so the L1's proposerVM catches the conversion. */
const DEFAULT_POST_ADVANCE_MS = 30_000;
/** ACP-181 epoch duration on local network — must elapse between warm-up txs. */
const DEFAULT_EPOCH_MS = 35_000;
/** Maximum time the L1 RPC may stay 503 before we give up. */
const DEFAULT_L1_RPC_MS = 180_000;

/** Local network ID — matches avalanchego's `--network-id=local`. */
const TMPNET_NETWORK_ID = 12345;

// ----------------------------------------------------------------------------
// Wait helpers
// ----------------------------------------------------------------------------

type AvalancheWalletClient = ReturnType<typeof createAvalancheWalletClient>;

/**
 * Poll the P-Chain until `getCurrentValidators(subnetID)` reports at least
 * one validator. After ConvertSubnetToL1Tx commits, the validator takes a
 * few seconds to appear — without this wait, sig-aggregator finds 0 signers
 * and never converges.
 */
export async function waitForL1ValidatorRegistered(
  walletClient: AvalancheWalletClient,
  subnetID: string,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await walletClient.pChain.getCurrentValidators({
        subnetID,
      });
      const list = (current as { validators?: unknown[] }).validators ?? [];
      if (list.length > 0) return list.length;
    } catch {
      // try again
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for L1 validator on subnet ${subnetID}`);
}

/**
 * Issue `count` self-transfers via prepareBaseTxn + sendXPTransaction +
 * waitForTxn so the P-Chain height advances. The L1 proposerVM needs to
 * see post-conversion P-Chain blocks before it'll accept warp messages
 * signed against the new subnet.
 */
export async function advancePChainHeight(
  walletClient: AvalancheWalletClient,
  count: number,
  log: (msg: string) => void = () => {},
): Promise<void> {
  for (let i = 0; i < count; i++) {
    log(`advancing P-Chain height (${i + 1}/${count})...`);
    const advanceReq = await walletClient.pChain.prepareBaseTxn({});
    const res = await walletClient.sendXPTransaction(advanceReq);
    await waitForPChainCommit(walletClient, res.txHash);
  }
}

/** Long-window P-Chain tx wait — see l1.ts for the rationale. */
async function waitForPChainCommit(
  walletClient: AvalancheWalletClient,
  txID: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    try {
      const { status } = await walletClient.pChain.getTxStatus({ txID });
      lastStatus = status;
      if (status === "Committed") return;
      if (status === "Dropped") {
        throw new Error(`Tx ${txID} failed with status ${status}`);
      }
    } catch (err) {
      if (Date.now() > deadline - 1000) throw err;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for P-Chain tx ${txID} to commit (last status: ${lastStatus})`);
}

/**
 * Roll the L1 past its first ACP-181 epoch.
 *
 * avalanchego v1.14+ implements ACP-181 ("P-Chain epoched views"). Warp
 * predicate verification queries the validator set at the *epoch's* frozen
 * PChainHeight, NOT the block's current proposed height. Epoch 1 starts at
 * the genesis block whose parent has no PChainHeight, so epoch 1's
 * PChainHeight = 0 — and the L1's own subnet has no validators at height 0,
 * so signature verification finds zero signers and reverts.
 *
 * Sending two cheap warm-up txs separated by 35s causes the L1 to seal
 * epoch 1; the next block lands in epoch 2 and inherits the L1's now-current
 * pChainHeight.
 */
export async function rollL1PastFirstEpoch(
  l1WalletClient: WalletClient,
  l1PublicClient: PublicClient,
  epochDurationMs = 35_000,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const account = l1WalletClient.account;
  if (!account) throw new Error("rollL1PastFirstEpoch: walletClient has no account");
  const send = async (label: string) => {
    log(`rolling L1 past first epoch (${label})...`);
    const hash = await l1WalletClient.sendTransaction({
      to: account.address,
      value: 0n,
      chain: l1WalletClient.chain,
      account,
    } as never);
    await l1PublicClient.waitForTransactionReceipt({ hash });
  };

  await send("warm-up tx 1/2");
  await sleep(epochDurationMs);
  await send("warm-up tx 2/2");
}

// ----------------------------------------------------------------------------
// initializeL1ValidatorSet orchestrator
// ----------------------------------------------------------------------------

export interface InitializeL1ValidatorSetOptions {
  /** Network work directory (parent of `data/`, `logs/`, etc.). */
  workDir: string;
  /** Primary network API URI (e.g. http://127.0.0.1:9650). */
  primaryURI: string;
  /** Subnet ID of the L1 we're initializing. */
  subnetId: string;
  /** Blockchain ID of the L1's EVM chain. */
  blockchainId: string;
  /** L1 EVM chain ID (for the viem chain definition). */
  l1EvmChainId: number;
  /** L1 EVM RPC URL — must be served by an L1 validator node. */
  l1RpcUrl: string;
  /** Bootstrap validator's NodeID-... string. */
  validatorNodeId: string;
  /** Bootstrap validator's BLS public key (compressed G1, 48-byte 0x-hex). */
  validatorBlsPublicKey: Hex;
  /** Bootstrap validator weight passed to ConvertSubnetToL1Tx (default 100n). */
  validatorWeight?: bigint;
  /**
   * ValidatorManager (proxy) address on the L1. Defaults to the canonical
   * VALIDATOR_MANAGER_PROXY_ADDRESS from @avalanche-sdk/interchain.
   */
  validatorManagerAddress?: Address;
  /** Network ID. Defaults to local (12345). */
  networkId?: number;
  /** Logger. Defaults to console.log. */
  log?: (msg: string) => void;
  /** P-Chain advance count before rolling epoch. Default 2. */
  pChainAdvances?: number;
  /**
   * Sleep after P-Chain advance, before rolling epoch. Default 30_000ms.
   * @deprecated use `timeouts.postAdvanceMs` on NetworkConfig.
   */
  postAdvanceSleepMs?: number;
  /**
   * ACP-181 epoch duration on local network. Default 35_000ms.
   * @deprecated use `timeouts.epochMs` on NetworkConfig.
   */
  epochDurationMs?: number;
  /**
   * Optional bag of timeout overrides. Anything omitted falls back to the
   * documented default. Takes precedence over the deprecated *Ms fields
   * above when both are set.
   */
  timeouts?: Partial<NetworkTimeouts>;
}

export interface InitializeL1ValidatorSetResult {
  /** Signed warp message hex packed into the access list. */
  signedMessageHex: Hex;
  /** Tx hash of the initializeValidatorSet call on the L1. */
  txHash: Hex;
  /** The signature-aggregator process info — caller is responsible for cleanup. */
  sigagg: StartSigAggResult;
}

/**
 * Wrap `sigagg.aggregateSignatures` as the callback `initializeValidatorSet`
 * expects. Retries on "no signatures" / "threshold" — sig-aggregator needs
 * P2P warm-up time after /health reports up before it can actually collect
 * signatures from peers. Errors outside that pattern fail fast.
 */
function buildAggregator(
  sigagg: StartSigAggResult,
  opts: { timeoutMs?: number; retryDelayMs?: number; log?: (m: string) => void } = {},
) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const retryDelayMs = opts.retryDelayMs ?? 3_000;
  const log = opts.log ?? (() => {});
  return async ({
    unsignedMessageHex,
    signingSubnetId,
    justificationHex,
  }: {
    unsignedMessageHex: Hex;
    signingSubnetId: string;
    justificationHex: Hex;
  }): Promise<Hex> => {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      const sig = await sigagg.aggregateSignatures({
        message: unsignedMessageHex,
        justification: justificationHex,
        "signing-subnet-id": signingSubnetId,
      });
      if (sig["signed-message"]) {
        const hex = sig["signed-message"];
        return (hex.startsWith("0x") ? hex : `0x${hex}`) as Hex;
      }
      lastErr = sig.error ?? "unknown sig-aggregator error";
      if (!/no signatures|threshold/i.test(lastErr)) {
        throw new Error(`sig-aggregator failed: ${lastErr}`);
      }
      log(`waiting for sig-aggregator peers (${lastErr})...`);
      await sleep(retryDelayMs);
    }
    throw new Error(`sig-aggregator timed out: ${lastErr}`);
  };
}

/** Poll an L1's EVM RPC until it stops returning 503 / "bootstrapping". */
async function waitForL1Rpc(rpcUrl: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string; error?: { message: string } };
        if (json.result) return;
        lastErr = json.error?.message ?? "unknown";
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await sleep(500);
  }
  throw new Error(`L1 RPC ${rpcUrl} not ready after ${timeoutMs}ms: ${lastErr}`);
}

/**
 * Top-level orchestrator. Drives the full post-conversion bring-up:
 *   wait-for-validator → advance-P-Chain → roll-epoch → start-sigagg →
 *   initializeValidatorSet → wait-for-RPC.
 *
 * Returns the sigagg handle so the caller can kill it during teardown.
 */
export async function initializeL1ValidatorSet(
  opts: InitializeL1ValidatorSetOptions,
): Promise<InitializeL1ValidatorSetResult> {
  const log = opts.log ?? console.log;
  const networkId = opts.networkId ?? TMPNET_NETWORK_ID;
  const validatorManagerAddress =
    opts.validatorManagerAddress ??
    (VALIDATOR_MANAGER_PROXY_ADDRESS as Address);
  const weight = opts.validatorWeight ?? 100n;

  // 1. P-Chain wallet client for the EWOQ key (controls the subnet).
  const account = privateKeyToAvalancheAccount(EWOQ_PRIVATE_KEY);
  const walletClient = createAvalancheWalletClient({
    chain: avalancheLocal,
    transport: { type: "http", url: `${opts.primaryURI}/ext/bc/C/rpc` },
    account,
  });

  // Timeout resolution: per-call `timeouts` bag wins, then the legacy *Ms
  // fields, then the documented default.
  const t = opts.timeouts ?? {};
  const postAdvanceMs =
    t.postAdvanceMs ?? opts.postAdvanceSleepMs ?? DEFAULT_POST_ADVANCE_MS;
  const epochMs = t.epochMs ?? opts.epochDurationMs ?? DEFAULT_EPOCH_MS;
  const l1RpcMs = t.l1RpcMs ?? DEFAULT_L1_RPC_MS;

  log("waiting for L1 validator to register on P-Chain...");
  const count = await waitForL1ValidatorRegistered(walletClient, opts.subnetId);
  log(`L1 has ${count} validator(s) on P-Chain`);

  // 2. Advance P-Chain height + sleep so the L1's proposerVM sees the
  //    conversion in its tracked view of P-Chain.
  const advanceCount = opts.pChainAdvances ?? 2;
  await advancePChainHeight(walletClient, advanceCount, log);
  log(`sleeping ${postAdvanceMs}ms for proposerVM catch-up...`);
  await sleep(postAdvanceMs);

  // 3. L1 EVM clients. The RPC is reachable even though the chain isn't
  //    producing blocks yet — initializeValidatorSet uses eth_call /
  //    eth_estimateGas, not block production.
  try {
    await waitForL1RpcReadyForCall(opts.l1RpcUrl, log, l1RpcMs);
  } catch (err) {
    // An RPC that 404s for the whole timeout usually means the chain was
    // never created on the node (plugin handshake failure, VM crash). The
    // actual error is in the node log — attach it.
    const cause = findChainCreationError(networkPaths(opts.workDir).logs, opts.blockchainId);
    throw cause
      ? new Error(`${(err as Error).message}\nNode log shows the chain failed to start:\n  ${cause}`)
      : err;
  }
  const l1Chain = defineChain({
    id: opts.l1EvmChainId,
    name: `l1-${opts.l1EvmChainId}`,
    nativeCurrency: { decimals: 18, name: "AVAX", symbol: "AVAX" },
    rpcUrls: { default: { http: [opts.l1RpcUrl] } },
  });
  const evmAccount = privateKeyToAccount(EWOQ_PRIVATE_KEY);
  const l1WalletClient = createWalletClient({
    account: evmAccount,
    chain: l1Chain,
    transport: http(opts.l1RpcUrl),
  });
  const l1PublicClient = createPublicClient({
    chain: l1Chain,
    transport: http(opts.l1RpcUrl),
  });

  // 4. Roll past first epoch.
  await rollL1PastFirstEpoch(l1WalletClient, l1PublicClient, epochMs, log);

  // 5. Start sig-aggregator tracking this subnet.
  log("starting signature-aggregator...");
  // Sig-aggregator listens on 8090/8091 by default to avoid clashing with
  // the icm-relayer (8080). Callers can override via env if needed.
  const sigagg = await startSignatureAggregator({
    workDir: opts.workDir,
    infoApiBaseUrl: opts.primaryURI,
    trackedSubnets: [opts.subnetId],
    apiPort: 8090,
    metricsPort: 8091,
  });
  log(`signature-aggregator up @ http://127.0.0.1:${sigagg.apiPort} (peers=${sigagg.peers.length})`);

  // 6. initializeValidatorSet.
  const aggregator = buildAggregator(sigagg, { log });
  log("calling initializeValidatorSet...");
  const result = await initializeValidatorSet(
    l1WalletClient as never,
    l1PublicClient as never,
    {
      onProgress: log,
      contractAddress: validatorManagerAddress,
      networkId,
      subnetId: opts.subnetId,
      blockchainId: opts.blockchainId,
      validators: [
        {
          nodeId: opts.validatorNodeId,
          weight,
          blsPublicKey: opts.validatorBlsPublicKey,
        },
      ],
      aggregateSignatures: aggregator,
    },
  );

  if (result.receipt.status !== "success") {
    throw new Error(
      `initializeValidatorSet reverted (status=${result.receipt.status}). See tx ${result.txHash}.`,
    );
  }
  log(`initializeValidatorSet committed: ${result.txHash}`);

  // 7. Wait for the L1's RPC to start serving requests normally — once the
  //    contract is initialized, the chain begins producing blocks and 503
  //    errors clear. Respect the l1RpcMs override so slow CI can extend it.
  await waitForL1Rpc(opts.l1RpcUrl, l1RpcMs);
  log("L1 RPC online");

  return {
    signedMessageHex: result.signedMessageHex,
    txHash: result.txHash,
    sigagg,
  };
}

/**
 * Wait until the L1 RPC returns a successful eth_chainId (HTTP 200 with a
 * result field). The L1's avalanchego node returns 503 with
 * "API call rejected because chain is not done bootstrapping" until the
 * subnet-evm engine has finished its initial sync of the post-conversion
 * state. Once that completes, eth_chainId answers normally and we can
 * send the rollL1PastFirstEpoch warm-up txs.
 */
async function waitForL1RpcReadyForCall(
  rpcUrl: string,
  log: (m: string) => void,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  let logged = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string; error?: { message: string } };
        if (json.result) return;
        lastErr = json.error?.message ?? "no result";
      } else {
        lastErr = `HTTP ${res.status}`;
        if (!logged) {
          log(`waiting for L1 RPC bootstrap (${lastErr})...`);
          logged = true;
        }
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await sleep(1000);
  }
  throw new Error(`L1 RPC ${rpcUrl} never bootstrapped within ${timeoutMs}ms: ${lastErr}`);
}
