// EWOQ — the well-known funded test account used by the avalanchego local
// network. Anyone who has spun up `avalanchego --network-id=local` has bumped
// into this key. It owns the entire local network supply and is the only
// signer we need for CreateSubnet / CreateChain / ConvertSubnetToL1.
//
// IMPORTANT: this key is public. NEVER use it on Fuji or mainnet — funds
// sent to its address on a public network will be swept instantly.

import { networkIDs, secp256k1, utils } from "@avalabs/avalanchejs";
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const LocalHRP = networkIDs.LocalHRP;

import type { FundedAccount } from "./types.js";

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
export const EWOQ_EVM_ADDRESS: Address =
  "0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC";

/** Raw 32-byte private key for use with avalanchejs signers. */
export function ewoqPrivateKeyBytes(): Uint8Array {
  return hexToBytes(EWOQ_PRIVATE_KEY);
}

/**
 * Derive the EWOQ P-Chain bech32 address for the local network HRP. Returns
 * something like `P-local18jma8ppw3nhx5r4ap8clazz0dps7rv5u9xde7p`.
 *
 * @param hrp - bech32 human-readable prefix. Defaults to "local" (the HRP
 *   avalanchego uses when started with `--network-id=local`).
 */
export function ewoqPChainAddress(hrp: string = LocalHRP): string {
  const pubKey = secp256k1.getPublicKey(ewoqPrivateKeyBytes());
  const addrBytes = secp256k1.publicKeyBytesToAddress(pubKey);
  return `P-${utils.formatBech32(hrp, addrBytes)}`;
}

/**
 * Raw 20-byte P-Chain address derived from the EWOQ key. This is what
 * avalanchejs tx builders want for `subnetOwners`, `fromAddressesBytes`, etc.
 */
export function ewoqPChainAddressBytes(): Uint8Array {
  const pubKey = secp256k1.getPublicKey(ewoqPrivateKeyBytes());
  return secp256k1.publicKeyBytesToAddress(pubKey);
}

/**
 * EVM-address derivation from the EWOQ key. Verified against the well-known
 * `0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC`. Provided as a helper for
 * tests that want to assert the derivation, not as the source of truth — the
 * canonical address is the constant {@link EWOQ_EVM_ADDRESS}.
 */
export function deriveEwoqEvmAddress(): Address {
  const pubKey = secp256k1.getPublicKey(ewoqPrivateKeyBytes());
  // avalanchejs returns the 33-byte compressed public key. To get an Ethereum
  // address we need the 64-byte uncompressed form (drop the leading 0x04
  // prefix) and then keccak256 + take the trailing 20 bytes.
  const uncompressed = secp256k1.publicKeyToEthAddress(pubKey);
  // publicKeyToEthAddress already returns the 20-byte address bytes.
  return ("0x" + bytesToHex(uncompressed).slice(2)) as Address;
}

/** A viem-compatible local account wrapping the EWOQ key. */
export function ewoqViemAccount() {
  return privateKeyToAccount(EWOQ_PRIVATE_KEY);
}

/** Public bundle exposed to consumers of @interchain-kit/tmpnet. */
export function fundedAccount(): FundedAccount {
  return {
    address: EWOQ_EVM_ADDRESS,
    privateKey: EWOQ_PRIVATE_KEY,
  };
}

// keccak256 is re-exported so tests can sanity-check our address derivation
// against a known reference implementation without pulling viem directly.
export const _keccak256 = keccak256;
