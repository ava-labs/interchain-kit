// =============================================================================
//  send-message.ts — minimal ICM "hello, world" against a local network.
// -----------------------------------------------------------------------------
//  What this does, top to bottom:
//
//    1. Read network.json (written by `pnpm up`).
//    2. Deploy `SimpleSender` on C-Chain — it talks to the local Teleporter.
//    3. Deploy `SimpleReceiver` on the destination L1 — registered against
//       that chain's TeleporterRegistry.
//    4. Call sender.sendMessage(...). This emits a SendCrossChainMessage event
//       that the icm-relayer (already running because of `pnpm up`) picks up.
//    5. Poll receiver.latestMessage() on the L1 until it changes.
//
//  Run with: pnpm tsx examples/send-message.ts [--destination <l1-name>]
// =============================================================================

import {
  loadNetwork,
  makeClients,
  loadArtifact,
  blockchainIdToBytes32,
  pollUntil,
  parseArgs,
  pickDestination,
  type Address,
} from "./lib.js";
import type { Hex } from "viem";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = loadNetwork();
  const dest = pickDestination(network, args.destination);

  console.log(`Source:      C-Chain  (evmChainId=${network.cChain.evmChainId})`);
  console.log(`Destination: ${dest.name}  (evmChainId=${dest.evmChainId})`);
  console.log(`Funded:      ${network.funded.address}\n`);

  // Build viem clients for both chains. Same private key works everywhere
  // because tmpnet pre-funds the dev account on every chain.
  const src = makeClients(network.cChain, network.funded.privateKey);
  const dst = makeClients(dest, network.funded.privateKey);

  // Load the forge-built artifacts. (Run `forge build --root contracts` first.)
  const sender = loadArtifact("SimpleSender");
  const receiver = loadArtifact("SimpleReceiver");

  // ---- 1. Deploy SimpleSender on C-Chain. ---------------------------------
  // Constructor takes one arg: the local TeleporterMessenger address.
  console.log("Deploying SimpleSender on C-Chain...");
  const senderTx = await src.walletClient.deployContract({
    abi: sender.abi,
    bytecode: sender.bytecode,
    account: src.account,
    chain: src.chain,
    args: [network.cChain.teleporter],
  });
  const senderReceipt = await src.publicClient.waitForTransactionReceipt({ hash: senderTx });
  const senderAddress = senderReceipt.contractAddress as Address;
  console.log(`  -> ${senderAddress}`);

  // ---- 2. Deploy SimpleReceiver on the destination L1. --------------------
  // Constructor: (teleporterRegistryAddress, minTeleporterVersion). The
  // registry tells the contract which messenger versions to trust.
  console.log(`Deploying SimpleReceiver on ${dest.name}...`);
  const receiverTx = await dst.walletClient.deployContract({
    abi: receiver.abi,
    bytecode: receiver.bytecode,
    account: dst.account,
    chain: dst.chain,
    args: [dest.teleporterRegistry, 1n],
  });
  const receiverReceipt = await dst.publicClient.waitForTransactionReceipt({ hash: receiverTx });
  const receiverAddress = receiverReceipt.contractAddress as Address;
  console.log(`  -> ${receiverAddress}\n`);

  // ---- 3. Send the message. -----------------------------------------------
  // Teleporter identifies the destination L1 by bytes32, not by EVM chain ID.
  // network.json gives us the cb58 form, so convert.
  const destBlockchainIdBytes32 = blockchainIdToBytes32(dest.blockchainId);
  const message = "Hello from C-Chain!";

  // Snapshot the receiver state *before* sending so we know what "changed"
  // means when we poll.
  const before = (await dst.publicClient.readContract({
    address: receiverAddress,
    abi: receiver.abi,
    functionName: "latestMessage",
  })) as string;
  console.log(`Receiver.latestMessage (before): "${before}"`);

  console.log(`Sending message: "${message}"`);
  const sendTx = await src.walletClient.writeContract({
    address: senderAddress,
    abi: sender.abi,
    functionName: "sendMessage",
    args: [destBlockchainIdBytes32, receiverAddress, message],
    account: src.account,
    chain: src.chain,
  });
  const sendReceipt = await src.publicClient.waitForTransactionReceipt({ hash: sendTx });
  console.log(`  tx: ${sendTx} (block ${sendReceipt.blockNumber})\n`);

  // ---- 4. Poll the destination for delivery. ------------------------------
  // The relayer watches Chain A logs, gathers BLS signatures from the source
  // L1's validators, then calls receiveCrossChainMessage on Chain B. Total
  // latency on a local tmpnet is typically 2-5 seconds.
  console.log(`Polling receiver.latestMessage on ${dest.name}...`);
  const after = await pollUntil(
    async () =>
      (await dst.publicClient.readContract({
        address: receiverAddress,
        abi: receiver.abi,
        functionName: "latestMessage",
      })) as string,
    (v) => v === message,
    { timeoutMs: 60_000, label: "receiver.latestMessage to update" },
  );

  console.log(`Receiver.latestMessage (after):  "${after}"`);
  console.log("\nDone. ICM round-trip succeeded.");
}

main().catch((err) => {
  console.error("\nsend-message failed:", err.message ?? err);
  process.exit(1);
});

// (We don't import Hex above except for type clarity in helpers.)
export type { Hex };
