// EWOQ — the well-known funded test account used by the avalanchego local
// network. Anyone who has spun up `avalanchego --network-id=local` has bumped
// into this key. It owns the entire local network supply and is the only
// signer we need for CreateSubnet / CreateChain / ConvertSubnetToL1.
//
// IMPORTANT: this key is public. NEVER use it on Fuji or mainnet — funds
// sent to its address on a public network will be swept instantly.

import { hexToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { FundedAccount } from "../types.js";

/**
 * EWOQ private key in 0x-prefixed hex form. This is the canonical
 * "PrivateKey-ewoqjP7PxY4yr3iLTpLisriqt94hdyDFNgchSxGGztUrTXtNN" used by
 * avalanchego's local genesis, expressed as raw 32-byte secp256k1 scalar.
 */
export const EWOQ_PRIVATE_KEY: Hex =
  "0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027";

/**
 * EWOQ Ethereum address. The local genesis (both primary network C-Chain and
 * any subnet-evm L1 we spawn) pre-funds this address with a huge balance.
 */
export const EWOQ_EVM_ADDRESS: Address = "0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC";

/** Raw 32-byte private key. */
export function ewoqPrivateKeyBytes(): Uint8Array {
  return hexToBytes(EWOQ_PRIVATE_KEY);
}

/** A viem-compatible local account wrapping the EWOQ key. */
export function ewoqViemAccount() {
  return privateKeyToAccount(EWOQ_PRIVATE_KEY);
}

/** Public bundle exposed to consumers of tmpnetjs. */
export function fundedAccount(): FundedAccount {
  return {
    address: EWOQ_EVM_ADDRESS,
    privateKey: EWOQ_PRIVATE_KEY,
  };
}
