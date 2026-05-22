// Subnet-EVM genesis generation.
//
// Every L1 we spin up needs a genesis JSON before its CreateChain tx is
// issued. We want the genesis to do two things automatically:
//
//   1. Pre-fund the EWOQ dev account so users can deploy contracts and send
//      transactions immediately.
//   2. Pre-deploy the TransparentUpgradeableProxy + ProxyAdmin pair at the
//      well-known {@link VALIDATOR_MANAGER_PROXY_ADDRESS}. ConvertSubnetToL1
//      bakes the manager address into a hash before the chain has any state,
//      so the proxy *has* to exist in the genesis itself.
//
// The shape we emit matches what avalanchego's subnet-evm VM expects when
// it's passed via the CreateChain tx's `genesisData`.

import {
  buildValidatorManagerGenesisAlloc,
  VALIDATOR_MANAGER_PROXY_ADDRESS,
} from "@avalanche-sdk/interchain";
import type { Address } from "viem";

import { EWOQ_EVM_ADDRESS } from "../internal/wallet.js";
import { DEFAULT_RELAYER_ADDRESS } from "../icm/relayer.js";

/** A single entry in the subnet-evm genesis `alloc` map. */
export interface AllocEntry {
  balance: string;
  code?: string;
  nonce?: string;
  storage?: Record<string, string>;
}

/** Full subnet-evm genesis document. */
export interface SubnetEvmGenesis {
  config: Record<string, unknown>;
  alloc: Record<string, AllocEntry>;
  nonce: string;
  timestamp: string;
  extraData?: string;
  gasLimit: string;
  difficulty: string;
  mixHash: string;
  coinbase: string;
  number: string;
  gasUsed: string;
  parentHash: string;
  airdropHash?: string;
  airdropAmount?: string;
}

export interface DefaultSubnetEvmGenesisOptions {
  /** EVM chain id (must be unique across L1s + C-Chain on the same network). */
  chainId: number;
  /**
   * Owner of the ProxyAdmin pre-deployed alongside the ValidatorManager
   * proxy. Whoever this is controls the upgrade key. Defaults to the EWOQ
   * dev account, matching every other piece of pre-funded local state.
   */
  proxyAdminOwner?: Address;
  /**
   * Initial AVAX balance handed to the funded dev account, expressed in wei.
   * Default: 10,000 AVAX (18 decimals).
   */
  fundedBalanceWei?: bigint;
  /**
   * Extra alloc entries layered on top of the defaults (deployer + proxy).
   * Useful for tests that need to pre-fund additional addresses.
   */
  extraAlloc?: Record<string, AllocEntry>;
  /**
   * Optional override for the entire `config` block. If omitted we emit a
   * permissive defaults block (all forks active at genesis, no precompile
   * gating). Pass your own if you want stricter rules.
   */
  config?: Record<string, unknown>;
}

const DEFAULT_FUNDED_BALANCE_WEI = 10_000n * 10n ** 18n;

/**
 * Sane defaults for a local subnet-evm chain config. All forks active at
 * timestamp 0, no warp precompile gating (warp is enabled by default in
 * recent subnet-evm versions when subnetEVMTimestamp is set), and a low
 * minBaseFee so test transactions don't run into surprise gas pricing.
 */
/**
 * Hardcoded local-network Durango activation in avalanchego
 * (2020-12-05 05:00 UTC). subnet-evm checks `durangoTimestamp` against this
 * value — durangoTimestamp:0 reads as "not set" and fails warp verification.
 * Equal Durango + warp timestamps are allowed.
 */
const DURANGO_LOCAL_ACTIVATION_TIMESTAMP = 1607144400;

function defaultConfig(chainId: number): Record<string, unknown> {
  return {
    chainId,
    homesteadBlock: 0,
    eip150Block: 0,
    eip155Block: 0,
    eip158Block: 0,
    byzantiumBlock: 0,
    constantinopleBlock: 0,
    petersburgBlock: 0,
    istanbulBlock: 0,
    muirGlacierBlock: 0,
    berlinBlock: 0,
    londonBlock: 0,
    // shanghaiTime + cancunTime must be explicit. subnet-evm does NOT
    // auto-activate Shanghai when Durango is set, so PUSH0 + transient
    // storage (needed by icm-contracts v1.0.9, solc 0.8.25) would revert
    // without these.
    shanghaiTime: 0,
    cancunTime: 0,
    subnetEVMTimestamp: 0,
    durangoTimestamp: DURANGO_LOCAL_ACTIVATION_TIMESTAMP,
    feeConfig: {
      gasLimit: 15_000_000,
      targetBlockRate: 2,
      minBaseFee: 1_000_000_000,
      targetGas: 100_000_000,
      baseFeeChangeDenominator: 36,
      minBlockGasCost: 0,
      maxBlockGasCost: 1_000_000,
      blockGasCostStep: 200_000,
    },
    // Warp precompile required for ICM / ICTT / validator-manager flows.
    // blockTimestamp must equal Durango (both pin to the hardcoded local
    // activation timestamp); 0 reads as "unset" and fails verification.
    warpConfig: {
      blockTimestamp: DURANGO_LOCAL_ACTIVATION_TIMESTAMP,
      quorumNumerator: 67,
      requirePrimaryNetworkSigners: true,
    },
  };
}

/**
 * Build a subnet-evm genesis JSON object ready to be passed as the
 * `genesisData` field of a CreateChain transaction.
 *
 * Layout:
 *   - `alloc[<EWOQ>]`         — 10,000 AVAX to the dev account.
 *   - `alloc[<proxy addr>]`   — TransparentUpgradeableProxy bytecode + slots
 *                               from {@link buildValidatorManagerGenesisAlloc}.
 *   - `alloc[<admin addr>]`   — ProxyAdmin bytecode + Ownable slot pointing at
 *                               `proxyAdminOwner`.
 *   - `alloc[...extraAlloc]`  — caller-provided overrides win.
 */
export function defaultSubnetEvmGenesis(
  opts: DefaultSubnetEvmGenesisOptions,
): SubnetEvmGenesis {
  const proxyAdminOwner = (opts.proxyAdminOwner ?? EWOQ_EVM_ADDRESS) as `0x${string}`;
  const fundedBalance = opts.fundedBalanceWei ?? DEFAULT_FUNDED_BALANCE_WEI;

  const proxyAlloc = buildValidatorManagerGenesisAlloc({ proxyAdminOwner });

  // The proxy alloc keys are lowercase, non-0x-prefixed hex. Subnet-evm is
  // lenient about both, but keep them consistent to avoid the case where two
  // entries collide if the user passes an `extraAlloc` with the same address.
  const alloc: Record<string, AllocEntry> = {
    // Funded dev account — `0x` prefix stripped, lowercase, matches the
    // proxy entries' format from the SDK.
    [EWOQ_EVM_ADDRESS.slice(2).toLowerCase()]: {
      balance: "0x" + fundedBalance.toString(16),
    },
    // Pre-fund the icm-relayer EOA so message delivery doesn't need a
    // separate funding step on every L1. Keep this in sync with
    // DEFAULT_RELAYER_ADDRESS in relayer.ts.
    [DEFAULT_RELAYER_ADDRESS.slice(2).toLowerCase()]: {
      balance: "0x" + fundedBalance.toString(16),
    },
    ...proxyAlloc,
    ...(opts.extraAlloc ?? {}),
  };

  return {
    config: opts.config ?? defaultConfig(opts.chainId),
    alloc,
    nonce: "0x0",
    // Wall-clock timestamp. subnet-evm sets `shanghaiTime` to Durango's
    // activation (1607144400) at chain setup. Pre-validator-set the L1 has
    // no active validators and produces no blocks, so simulator calls run
    // against head=genesis. If genesis.timestamp < Durango, eth_estimateGas
    // sees pre-Shanghai and PUSH0 reverts on icm-contracts bytecode. Using
    // now() guarantees genesis.timestamp >> Durango activation.
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
    extraData: "0x00",
    gasLimit: "0xe4e1c0", // 15,000,000
    difficulty: "0x0",
    mixHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    coinbase: "0x0000000000000000000000000000000000000000",
    number: "0x0",
    gasUsed: "0x0",
    parentHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
}

/** Serialize a genesis to the exact bytes the CreateChain tx expects. */
export function genesisToBytes(genesis: SubnetEvmGenesis): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(genesis));
}

/**
 * Re-export the proxy address so callers (l1.ts, addresses.ts) can stamp it
 * into network artifacts without separately importing from the SDK.
 */
export { VALIDATOR_MANAGER_PROXY_ADDRESS };
