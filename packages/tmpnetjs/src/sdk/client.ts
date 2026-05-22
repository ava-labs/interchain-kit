// viem client factory for a tmpnetjs ChainHandle.

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ChainHandle } from "../types.js";

/** A viem-compatible `chain` object describing a tmpnetjs chain. */
export function viemChainFor(handle: ChainHandle): Chain {
  return defineChain({
    id: handle.evmChainId,
    name: handle.name,
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [handle.rpcUrl] } },
  });
}

/** Bundle of viem clients for one chain — `publicClient` reads, `walletClient` writes. */
export interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: Chain;
  account: Account;
}

/** Build a {@link Clients} bundle for `handle`, signing with `privateKey`. */
export function makeClients(handle: ChainHandle, privateKey: Hex): Clients {
  const chain = viemChainFor(handle);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(handle.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(handle.rpcUrl), account });
  return { publicClient, walletClient, chain, account };
}
