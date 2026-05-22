// Avalanche-specific codecs.
//
// cb58 is Avalanche's variant of Base58Check — same structure as Bitcoin
// (base58( payload || checksum )), but the checksum is the LAST 4 bytes of
// sha256(payload), not the first 4. Easy gotcha when reusing reference impls.

import { createHash } from "node:crypto";
import type { Hex } from "viem";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array();
  let n = 0n;
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 char "${ch}"`);
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Re-add leading zero bytes lost to base58's positional notation (each
  // leading '1' in the encoded string is a leading 0x00 in the bytes).
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
}

/**
 * Decode a cb58 string and return the underlying 32-byte payload as a `0x`-
 * prefixed hex string. This is the `bytes32` form Teleporter uses to address
 * destination chains.
 */
export function blockchainIdToBytes32(cb58Id: string): Hex {
  const raw = base58Decode(cb58Id);
  if (raw.length < 4) throw new Error(`cb58 string too short: "${cb58Id}"`);
  const payload = raw.slice(0, -4);
  const checksum = raw.slice(-4);
  const expected = createHash("sha256").update(payload).digest().subarray(-4);
  if (!checksum.every((b, i) => b === expected[i])) {
    throw new Error(`cb58 checksum mismatch on "${cb58Id}"`);
  }
  if (payload.length !== 32) {
    throw new Error(`expected 32-byte blockchainId, got ${payload.length} from "${cb58Id}"`);
  }
  return ("0x" + Buffer.from(payload).toString("hex")) as Hex;
}
