// =============================================================================
//  add-validator.ts — register a second validator with the L1's ValidatorManager.
// -----------------------------------------------------------------------------
//  Prereq: `validator-manager-setup.ts` has run. The proxy at 0xfacade… points
//  at a real ValidatorManager with an initialized validator set (bootstrap
//  validator at weight 100).
//
//  This script demonstrates the ACP-77 "RegisterL1Validator" dance:
//    1. Spawn a fresh avalanchego node tracking the L1's subnet.
//    2. Read its NodeID + BLS pubkey + PoP via /ext/info.
//    3. ValidatorManager.initiateValidatorRegistration(...) on the L1 emits an
//       unsigned RegisterL1ValidatorMessage.
//    4. Aggregate BLS sigs across L1 validators via signature-aggregator.
//    5. RegisterL1ValidatorTx on the P-Chain with the signed warp message + PoP.
//    6. L1ValidatorRegistrationMessage(validationID, true) ACK — sigagg signs it.
//    7. completeValidatorRegistration(0) on the L1 with the ACK packed into the
//       warp precompile's access list.
//
//  `@avalanche-sdk/interchain`'s `registerL1Validator` hides 3-7; we supply:
//    - aggregateSignatures (4 + 6)
//    - getBlsProofOfPossession (the new node's PoP)
//    - submitPChainRegisterTx (5; the SDK has no P-Chain wallet)
//
//  Run: pnpm exec tsx add-validator.ts
//  Spawned node stays running; kill with `pkill -9 avalanchego`.
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import * as path from "node:path";

import {
  loadNetwork,
  pickL1,
  makeClients,
  findAvalanchego,
  findWorkDir,
  aggregateSignaturesAt,
} from "tmpnetjs";
import { utils } from "@avalabs/avalanchejs";
import { createAvalancheWalletClient } from "@avalanche-sdk/client";
import { privateKeyToAvalancheAccount } from "@avalanche-sdk/client/accounts";
import { avalancheLocal } from "@avalanche-sdk/client/chains";
import {
  registerL1Validator,
  ValidatorManagerAbi,
  type AggregateSignaturesFn,
} from "@avalanche-sdk/interchain";
import { getAddress, type Address, type Hex } from "viem";

const LOCAL_NETWORK_ID = 12345;

// Pick a port pair above the primary nodes (9650, 9750, ...) and existing L1
// nodes (10150, 10250, ...). 10750+ leaves headroom for more L1s.
const NEW_NODE_HTTP_PORT = 10750;
const NEW_NODE_STAKING_PORT = 10751;

async function main() {
  const network = loadNetwork();
  const l1 = pickL1(network);
  console.log(`L1:        ${l1.name}  (subnetId=${l1.subnetId})`);
  console.log(`L1 RPC:    ${l1.rpcUrl}`);
  console.log(`Funded:    ${network.funded.address}\n`);

  // ---- 1. Spawn a fresh validator node tracking the L1's subnet. ---------
  // Mirror tmpnetjs/src/l1.ts:spawnL1Node, different port pair. Bootstraps off
  // primary node 0 (port 9651) with ephemeral staking cert + BLS key.
  console.log(`Spawning new avalanchego validator on port ${NEW_NODE_HTTP_PORT}...`);
  const { apiURI, logFile } = spawnValidatorNode({
    workDir: findWorkDir(),
    subnetId: l1.subnetId,
    httpPort: NEW_NODE_HTTP_PORT,
    stakingPort: NEW_NODE_STAKING_PORT,
  });
  console.log(`  log:  ${logFile}`);
  console.log(`  api:  ${apiURI}\n`);

  // ---- 2. Wait for the node and capture its identity. --------------------
  console.log("Waiting for new node to come up...");
  const identity = await waitForNodeIdentity(apiURI, 90_000);
  console.log(`  NodeID:    ${identity.nodeID}`);
  console.log(`  BLS pubkey ${identity.blsPublicKey.slice(0, 18)}...`);
  console.log(`  BLS PoP    ${identity.blsProofOfPossession.slice(0, 18)}...\n`);

  // ---- 3. EVM + P-Chain clients. -----------------------------------------
  const { walletClient, publicClient } = makeClients(l1, network.funded.privateKey);
  const pAccount = privateKeyToAvalancheAccount(network.funded.privateKey);
  const ownerPAddr = pAccount.getXPAddress("P", "local");
  const pWallet = createAvalancheWalletClient({
    chain: avalancheLocal,
    transport: { type: "http", url: `${new URL(network.cChain.rpcUrl).origin}/ext/bc/C/rpc` },
    account: pAccount,
  });

  // PChainOwner struct on the EVM side wants 20-byte addresses, not bech32.
  // Convert and pass as Address (viem accepts any 20-byte hex).
  const ownerPBytes = utils.bech32ToBytes(ownerPAddr);
  const ownerAddrEvm = getAddress(`0x${Buffer.from(ownerPBytes).toString("hex")}`);
  const balanceOwner = { threshold: 1, addresses: [ownerAddrEvm] as const };

  // ---- 4. Drive the SDK's two-phase register flow. -----------------------
  console.log("Driving registerL1Validator (initiate → P-Chain → complete)...");

  const aggregate: AggregateSignaturesFn = async ({
    unsignedMessageHex,
    signingSubnetId,
    justificationHex,
  }) =>
    (await aggregateSignaturesAt({
      message: unsignedMessageHex,
      justification: justificationHex,
      "signing-subnet-id": signingSubnetId,
    })) as Hex;

  const result = await registerL1Validator(walletClient as never, publicClient as never, {
    onProgress: (m) => console.log(`  [register] ${m}`),
    validatorManagerAddress: getAddress(l1.validatorManager),
    networkId: LOCAL_NETWORK_ID,
    subnetId: l1.subnetId,
    validator: {
      nodeId: identity.nodeID,
      blsPublicKey: identity.blsPublicKey,
      weight: 1n,
      remainingBalanceOwner: balanceOwner,
      disableOwner: balanceOwner,
    },
    aggregateSignatures: aggregate,

    // The new node already exposes its PoP via /ext/info. A real "BYO key"
    // flow would receive this out-of-band from the operator.
    getBlsProofOfPossession: async () => identity.blsProofOfPossession,

    // The SDK has no P-Chain wallet, so we submit RegisterL1ValidatorTx
    // ourselves. Steps inside:
    //   a. Advance P-Chain a couple heights so the L1's proposerVM catches
    //      up past subnet conversion (warp recommendedPChainHeight lags tip).
    //   b. Build + send RegisterL1ValidatorTx with the signed warp message +
    //      BLS PoP + 0.1 AVAX (in nAVAX) for continuous-fee subscription.
    //   c. Wait for commit.
    //   d. Roll the L1 forward one epoch so the ACK warp message gets
    //      verified at the post-registration epoch.
    submitPChainRegisterTx: async ({ signedWarpMessageHex, blsProofOfPossessionHex }) => {
      console.log("    advancing P-Chain (2 self-transfers)...");
      for (let i = 0; i < 2; i++) {
        const adv = await pWallet.pChain.prepareBaseTxn({});
        const r = await pWallet.sendXPTransaction({ tx: adv.tx, chainAlias: "P" });
        await waitForPChainCommit(pWallet, r.txHash);
      }
      console.log("    sleeping 30s for proposerVM catch-up...");
      await sleep(30_000);

      console.log("    submitting RegisterL1ValidatorTx...");
      const txnRequest = await pWallet.pChain.prepareRegisterL1ValidatorTxn({
        // Field is named *InAvax* but semantically takes nAVAX — SDK quirk.
        initialBalanceInAvax: 100_000_000n,
        blsSignature: blsProofOfPossessionHex,
        message: signedWarpMessageHex,
      });
      const { txHash } = await pWallet.sendXPTransaction({ tx: txnRequest.tx, chainAlias: "P" });
      await waitForPChainCommit(pWallet, txHash);
      console.log(`    P-Chain RegisterL1ValidatorTx committed: ${txHash}`);

      console.log("    rolling L1 past epoch...");
      const epochAccount = walletClient.account;
      if (epochAccount) {
        const txA = await walletClient.sendTransaction({
          to: epochAccount.address,
          value: 0n,
          chain: walletClient.chain,
          account: epochAccount,
        } as never);
        await publicClient.waitForTransactionReceipt({ hash: txA });
        await sleep(35_000);
        const txB = await walletClient.sendTransaction({
          to: epochAccount.address,
          value: 0n,
          chain: walletClient.chain,
          account: epochAccount,
        } as never);
        await publicClient.waitForTransactionReceipt({ hash: txB });
      }

      return { txId: txHash };
    },
  });

  console.log(`\nRegistered. validationID=${result.validationID}`);
  console.log(`  initiate tx (L1):   ${result.initiateTxHash}`);
  console.log(`  P-Chain tx:         ${result.pChainRegisterTxId}`);
  console.log(`  complete tx (L1):   ${result.completeTxHash}\n`);

  // ---- 5. Verify on both sides. ------------------------------------------
  const vm = { address: getAddress(l1.validatorManager) as Address, abi: ValidatorManagerAbi };
  const onChain = (await publicClient.readContract({
    ...vm,
    functionName: "getValidator",
    args: [result.validationID],
  })) as { nodeID: Hex; weight: bigint; status: number };
  const totalWeight = (await publicClient.readContract({
    ...vm,
    functionName: "l1TotalWeight",
  })) as bigint;
  console.log(`EVM ValidatorManager:`);
  console.log(`  validator status=${onChain.status} weight=${onChain.weight}`);
  console.log(`  l1TotalWeight=${totalWeight}`);

  const pChainValidators = await fetchPChainValidators(network.cChain.rpcUrl, l1.subnetId);
  console.log(`\nP-Chain subnet validators (${pChainValidators.length}):`);
  for (const v of pChainValidators) {
    console.log(`  ${v.nodeID} weight=${v.weight}`);
  }

  console.log("\nDone. Spawned node still running — kill with `pkill -9 avalanchego` when done.");
}

// ---------------------------------------------------------------------------
// Spawn the extra node. Lifted to a helper here (vs. tmpnetjs.Network.spawn…)
// to keep the actual avalanchego flags visible in the example. The plugin
// dir is resolved by tmpnetjs::findAvalanchego's sibling logic.
// ---------------------------------------------------------------------------

interface SpawnOpts {
  workDir: string;
  subnetId: string;
  httpPort: number;
  stakingPort: number;
}

function spawnValidatorNode(opts: SpawnOpts): { apiURI: string; logFile: string } {
  const avalanchego = findAvalanchego(opts.workDir);
  const pluginDir = path.join(path.dirname(avalanchego), "plugins");

  const name = `add-validator-${opts.httpPort}`;
  const nodeDir = path.join(opts.workDir, "data", name);
  const logFile = path.join(opts.workDir, "logs", `${name}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  for (const sub of ["db", "logs", "staking", "chainData", "configs"]) {
    mkdirSync(path.join(nodeDir, sub), { recursive: true });
  }

  // Primary node 0's NodeID, derived from staker1.key (the preconfigured
  // local staker tmpnetjs uses). Deterministic on a freshly `tmpnetjs up`ed
  // network. (We can't easily derive it here without P-Chain access, so we
  // hardcode the known value.)
  const cliArgs = [
    `--http-port=${opts.httpPort}`,
    `--staking-port=${opts.stakingPort}`,
    "--network-id=local",
    "--staking-ephemeral-cert-enabled=true",
    "--staking-ephemeral-signer-enabled=true",
    `--data-dir=${nodeDir}`,
    `--db-dir=${path.join(nodeDir, "db")}`,
    `--log-dir=${path.join(nodeDir, "logs")}`,
    `--chain-data-dir=${path.join(nodeDir, "chainData")}`,
    `--track-subnets=${opts.subnetId}`,
    `--bootstrap-ips=127.0.0.1:9651`,
    `--bootstrap-ids=NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg`,
    `--plugin-dir=${pluginDir}`,
    `--http-host=127.0.0.1`,
  ];

  const logFd = openSync(logFile, "a");
  const child = spawn(avalanchego, cliArgs, {
    cwd: nodeDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) throw new Error("avalanchego failed to launch (no PID)");

  return { apiURI: `http://127.0.0.1:${opts.httpPort}`, logFile };
}

// ---------------------------------------------------------------------------
// Network + tx helpers
// ---------------------------------------------------------------------------

async function waitForNodeIdentity(
  apiURI: string,
  timeoutMs: number,
): Promise<{ nodeID: string; blsPublicKey: Hex; blsProofOfPossession: Hex }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiURI}/ext/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "info.getNodeID" }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          result?: {
            nodeID?: string;
            nodePOP?: { publicKey?: string; proofOfPossession?: string };
          };
        };
        const nodeID = json.result?.nodeID;
        const pk = json.result?.nodePOP?.publicKey;
        const pop = json.result?.nodePOP?.proofOfPossession;
        if (nodeID && pk && pop) {
          return { nodeID, blsPublicKey: pk as Hex, blsProofOfPossession: pop as Hex };
        }
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${apiURI}/ext/info: ${lastErr}`);
}

async function waitForPChainCommit(
  wallet: ReturnType<typeof createAvalancheWalletClient>,
  txID: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    try {
      const { status } = await wallet.pChain.getTxStatus({ txID });
      lastStatus = status;
      if (status === "Committed") return;
      if (status === "Dropped") throw new Error(`P-Chain tx ${txID} dropped`);
    } catch (err) {
      if (Date.now() > deadline - 1000) throw err;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for P-Chain tx ${txID} (last=${lastStatus})`);
}

interface PChainSubnetValidator {
  nodeID: string;
  weight: string;
}

async function fetchPChainValidators(
  cChainRpcUrl: string,
  subnetId: string,
): Promise<PChainSubnetValidator[]> {
  const apiBase = new URL(cChainRpcUrl).origin;
  const res = await fetch(`${apiBase}/ext/bc/P`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "platform.getCurrentValidators",
      params: { subnetID: subnetId },
    }),
  });
  const json = (await res.json()) as { result?: { validators?: PChainSubnetValidator[] } };
  return json.result?.validators ?? [];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error("\nadd-validator failed:", err.message ?? err);
  process.exit(1);
});
