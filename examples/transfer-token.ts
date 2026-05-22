// =============================================================================
//  transfer-token.ts — real ICTT round-trip against a local network.
// -----------------------------------------------------------------------------
//  ICTT = Interchain Token Transfer. Pattern:
//
//    Home chain (here: C-Chain)   --- locks underlying ERC20 ---
//        ERC20TokenHome  <--> ERC20TokenRemote on the L1 (mints wrapped tokens)
//
//  Flow:
//    1. Deploy DemoERC20 on C-Chain.
//    2. Deploy ERC20TokenHome against it on C-Chain.
//    3. Deploy ERC20TokenRemote on the L1.
//    4. remote.registerWithHome() — Teleporter message back to the home.
//    5. Approve home; home.send() the tokens.
//    6. Poll remote.balanceOf(recipient).
//
//  Run: pnpm tsx examples/transfer-token.ts [--amount 100] [--destination <l1>]
// =============================================================================

import {
  loadNetwork,
  pickL1,
  loadArtifact,
  makeClients,
  blockchainIdToBytes32,
  pollUntil,
} from "tmpnetjs";
import { parseUnits, zeroAddress, type Address } from "viem";

// ICTT always settles in 18-decimal balances over Teleporter. Picking 18 keeps
// our demo token 1:1 with no rescaling.
const TOKEN_DECIMALS = 18;

async function main() {
  const amountHuman = argAfter("--amount") ?? "100";
  const network = loadNetwork();
  const dest = pickL1(network, argAfter("--destination"));

  console.log(`Source:      C-Chain  (evmChainId=${network.cChain.evmChainId})`);
  console.log(`Destination: ${dest.name}  (evmChainId=${dest.evmChainId})`);
  console.log(`Amount:      ${amountHuman} DemoUSDC`);
  console.log(`Funded:      ${network.funded.address}\n`);

  const src = makeClients(network.cChain, network.funded.privateKey);
  const dst = makeClients(dest, network.funded.privateKey);

  const erc20 = loadArtifact("DemoERC20");
  const home = loadArtifact("ERC20TokenHome");
  const remote = loadArtifact("ERC20TokenRemote");

  // ---- 1. Deploy DemoERC20 on C-Chain. -----------------------------------
  console.log("Deploying DemoERC20 on C-Chain...");
  const erc20Hash = await src.walletClient.deployContract({
    abi: erc20.abi,
    bytecode: erc20.bytecode,
    account: src.account,
    chain: src.chain,
    args: ["Demo USDC", "USDC", 6],
  });
  const erc20Address = (await src.publicClient.waitForTransactionReceipt({ hash: erc20Hash }))
    .contractAddress as Address;
  console.log(`  -> ${erc20Address}`);

  // ---- 2. Deploy ERC20TokenHome on C-Chain. ------------------------------
  // ctor: (teleporterRegistry, teleporterManager, minTeleporterVersion,
  //        tokenAddress, tokenDecimals)
  console.log("Deploying ERC20TokenHome on C-Chain...");
  const homeHash = await src.walletClient.deployContract({
    abi: home.abi,
    bytecode: home.bytecode,
    account: src.account,
    chain: src.chain,
    args: [
      network.cChain.teleporterRegistry,
      network.funded.address,
      1n,
      erc20Address,
      TOKEN_DECIMALS,
    ],
  });
  const homeAddress = (await src.publicClient.waitForTransactionReceipt({ hash: homeHash }))
    .contractAddress as Address;
  console.log(`  -> ${homeAddress}`);

  // ---- 3. Deploy ERC20TokenRemote on the L1. -----------------------------
  // ctor takes a TokenRemoteSettings tuple plus token metadata.
  console.log(`Deploying ERC20TokenRemote on ${dest.name}...`);
  const homeBlockchainIdBytes32 = blockchainIdToBytes32(network.cChain.blockchainId);
  const remoteHash = await dst.walletClient.deployContract({
    abi: remote.abi,
    bytecode: remote.bytecode,
    account: dst.account,
    chain: dst.chain,
    args: [
      {
        teleporterRegistryAddress: dest.teleporterRegistry,
        teleporterManager: network.funded.address,
        minTeleporterVersion: 1n,
        tokenHomeBlockchainID: homeBlockchainIdBytes32,
        tokenHomeAddress: homeAddress,
        tokenHomeDecimals: TOKEN_DECIMALS,
      },
      "Wrapped DemoUSDC",
      "wDUSDC",
      TOKEN_DECIMALS,
    ],
  });
  const remoteAddress = (await dst.publicClient.waitForTransactionReceipt({ hash: remoteHash }))
    .contractAddress as Address;
  console.log(`  -> ${remoteAddress}\n`);

  // ---- 4. Register the remote with the home. -----------------------------
  // remote.registerWithHome(feeInfo) sends a Teleporter message back to the
  // home. After delivery, home accepts sends destined for this remote.
  console.log("Registering remote with home...");
  const regTx = await dst.walletClient.writeContract({
    address: remoteAddress,
    abi: remote.abi,
    functionName: "registerWithHome",
    args: [{ feeTokenAddress: zeroAddress, amount: 0n }],
    account: dst.account,
    chain: dst.chain,
  });
  await dst.publicClient.waitForTransactionReceipt({ hash: regTx });

  const destBlockchainIdBytes32 = blockchainIdToBytes32(dest.blockchainId);
  console.log("Waiting for home to see the remote registration...");
  await pollUntil(
    async () => {
      const settings = (await src.publicClient.readContract({
        address: homeAddress,
        abi: home.abi,
        functionName: "getRemoteTokenTransferrerSettings",
        args: [destBlockchainIdBytes32, remoteAddress],
      })) as { registered: boolean };
      return settings.registered === true;
    },
    (v) => v,
    { timeoutMs: 60_000, label: "remote registration to reach home" },
  );
  console.log("  Registered.\n");

  // ---- 5. Approve + send. -------------------------------------------------
  const amount = parseUnits(amountHuman, TOKEN_DECIMALS);
  console.log(`Approving home for ${amountHuman} DemoUSDC...`);
  const approveTx = await src.walletClient.writeContract({
    address: erc20Address,
    abi: erc20.abi,
    functionName: "approve",
    args: [homeAddress, amount],
    account: src.account,
    chain: src.chain,
  });
  await src.publicClient.waitForTransactionReceipt({ hash: approveTx });

  const recipient = network.funded.address;
  const balanceBefore = (await dst.publicClient.readContract({
    address: remoteAddress,
    abi: remote.abi,
    functionName: "balanceOf",
    args: [recipient],
  })) as bigint;
  console.log(`Remote balance (before): ${balanceBefore}`);

  console.log("Sending tokens...");
  const sendTx = await src.walletClient.writeContract({
    address: homeAddress,
    abi: home.abi,
    functionName: "send",
    args: [
      {
        destinationBlockchainID: destBlockchainIdBytes32,
        destinationTokenTransferrerAddress: remoteAddress,
        recipient,
        primaryFeeTokenAddress: zeroAddress,
        primaryFee: 0n,
        secondaryFee: 0n,
        requiredGasLimit: 250_000n,
        multiHopFallback: zeroAddress,
      },
      amount,
    ],
    account: src.account,
    chain: src.chain,
  });
  await src.publicClient.waitForTransactionReceipt({ hash: sendTx });
  console.log(`  send tx: ${sendTx}\n`);

  // ---- 6. Poll the remote balance. ----------------------------------------
  console.log("Polling remote balance...");
  const balanceAfter = await pollUntil(
    async () =>
      (await dst.publicClient.readContract({
        address: remoteAddress,
        abi: remote.abi,
        functionName: "balanceOf",
        args: [recipient],
      })) as bigint,
    (v) => v >= balanceBefore + amount,
    { timeoutMs: 90_000, label: "wrapped tokens to arrive on remote" },
  );
  console.log(`Remote balance (after):  ${balanceAfter}`);
  console.log("\nDone. ICTT round-trip succeeded.");
}

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((err) => {
  console.error("\ntransfer-token failed:", err.message ?? err);
  process.exit(1);
});
