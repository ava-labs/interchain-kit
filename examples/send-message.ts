// =============================================================================
//  send-message.ts — minimal ICM "hello, world" against a local network.
// -----------------------------------------------------------------------------
//  Top to bottom:
//    1. Read network.json (written by `tmpnetjs up`).
//    2. Deploy SimpleSender on C-Chain, talking to the local TeleporterMessenger.
//    3. Deploy SimpleReceiver on the destination L1, registered against that
//       chain's TeleporterRegistry.
//    4. Call sender.sendMessage(...) — emits SendCrossChainMessage; icm-relayer
//       picks it up.
//    5. Poll receiver.latestMessage() on the L1 until it changes.
//
//  Run: pnpm tsx examples/send-message.ts [--destination <l1-name>]
// =============================================================================

import {
  loadNetwork,
  pickL1,
  loadArtifact,
  makeClients,
  blockchainIdToBytes32,
  pollUntil,
} from "tmpnetjs";
import type { Address } from "viem";

async function main() {
  // Flag takes precedence over env var.
  const destName = argAfter("--destination") ?? process.env.DESTINATION;
  const network = loadNetwork();
  const dest = pickL1(network, destName);

  console.log(`Source:      C-Chain  (evmChainId=${network.cChain.evmChainId})`);
  console.log(`Destination: ${dest.name}  (evmChainId=${dest.evmChainId})`);
  console.log(`Funded:      ${network.funded.address}\n`);

  const src = makeClients(network.cChain, network.funded.privateKey);
  const dst = makeClients(dest, network.funded.privateKey);

  const sender = loadArtifact("SimpleSender");
  const receiver = loadArtifact("SimpleReceiver");

  // ---- 1. Deploy SimpleSender on C-Chain (ctor: teleporterMessenger). -----
  console.log("Deploying SimpleSender on C-Chain...");
  const senderTx = await src.walletClient.deployContract({
    abi: sender.abi,
    bytecode: sender.bytecode,
    account: src.account,
    chain: src.chain,
    args: [network.cChain.teleporter],
  });
  const senderAddress = (await src.publicClient.waitForTransactionReceipt({ hash: senderTx }))
    .contractAddress as Address;
  console.log(`  -> ${senderAddress}`);

  // ---- 2. Deploy SimpleReceiver on the L1 (ctor: registry, minVersion). ---
  console.log(`Deploying SimpleReceiver on ${dest.name}...`);
  const receiverTx = await dst.walletClient.deployContract({
    abi: receiver.abi,
    bytecode: receiver.bytecode,
    account: dst.account,
    chain: dst.chain,
    args: [dest.teleporterRegistry, 1n],
  });
  const receiverAddress = (await dst.publicClient.waitForTransactionReceipt({ hash: receiverTx }))
    .contractAddress as Address;
  console.log(`  -> ${receiverAddress}\n`);

  // ---- 3. Send the message. -----------------------------------------------
  // Teleporter addresses destination chains by bytes32, not EVM chain ID.
  const destBlockchainIdBytes32 = blockchainIdToBytes32(dest.blockchainId);
  const message = "Hello from C-Chain!";

  console.log(`Sending message: "${message}"`);
  const sendTx = await src.walletClient.writeContract({
    address: senderAddress,
    abi: sender.abi,
    functionName: "sendMessage",
    args: [destBlockchainIdBytes32, receiverAddress, message],
    account: src.account,
    chain: src.chain,
  });
  await src.publicClient.waitForTransactionReceipt({ hash: sendTx });
  console.log(`  tx: ${sendTx}\n`);

  // ---- 4. Poll the destination. The relayer collects BLS sigs from the
  //          source's validators and delivers receiveCrossChainMessage. Local
  //          tmpnet latency: ~2-5s.
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

  console.log(`Receiver.latestMessage (after): "${after}"`);
  console.log("\nDone. ICM round-trip succeeded.");
}

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((err) => {
  console.error("\nsend-message failed:", err.message ?? err);
  process.exit(1);
});
