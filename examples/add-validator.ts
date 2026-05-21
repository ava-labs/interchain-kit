// =============================================================================
//  add-validator.ts — register a second validator with the L1's ValidatorManager.
// -----------------------------------------------------------------------------
//  Prerequisite: `validator-manager-setup.ts` has already run, so the proxy
//  at 0xfacade… points at a real ValidatorManager impl with an initialized
//  validator set (the bootstrap validator at weight 100).
//
//  This script demonstrates the ACP-77 "RegisterL1Validator" cross-chain dance:
//
//    1. Spawn a fresh avalanchego node tracking the L1's subnet (so it can
//       sign warp messages once it's a validator).
//    2. Read its NodeID + BLS public key + proof-of-possession via
//       /ext/info → info.getNodeID.
//    3. Call `ValidatorManager.initiateValidatorRegistration(...)` on the L1.
//       The contract emits an *unsigned* warp message
//       (`RegisterL1ValidatorMessage`).
//    4. Aggregate BLS signatures across the L1's existing validators using
//       signature-aggregator (already running on :8090).
//    5. Submit `RegisterL1ValidatorTx` on the P-Chain with the signed warp
//       message + the new validator's BLS PoP. The P-Chain validates the
//       warp message + PoP, then adds the validator to its current set.
//    6. Build an `L1ValidatorRegistrationMessage(validationID, true)` ACK
//       (P-Chain is the source). Sigagg signs it (L1 validators sign it,
//       because the L1's warp predicate doesn't require primary-network
//       signers for P-Chain-source messages).
//    7. Call `completeValidatorRegistration(0)` back on the L1 EVM with the
//       signed ACK packed into the warp precompile's access list.
//
//  The @avalanche-sdk/interchain helper `registerL1Validator` hides phases
//  3–7; we just supply:
//    - `aggregateSignatures` callback (steps 4 + 6)
//    - `getBlsProofOfPossession` callback (returns the new node's BLS PoP)
//    - `submitPChainRegisterTx` callback (step 5; the SDK doesn't own a
//      P-Chain wallet, so the caller does the submit)
//
//  Run with:  pnpm exec tsx add-validator.ts
//
//  NOTE: the spawned validator node is intentionally left running so you can
//  poke at it (`curl http://127.0.0.1:10750/ext/info ...`). Kill it manually
//  when you're done: `pkill -9 avalanchego`.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync } from "node:fs";
import * as path from "node:path";

import { loadNetwork, makeClients, pickDestination, type Address } from "./lib.js";
import { utils } from "@avalabs/avalanchejs";
import { createAvalancheWalletClient } from "@avalanche-sdk/client";
import { privateKeyToAvalancheAccount } from "@avalanche-sdk/client/accounts";
import { avalancheLocal } from "@avalanche-sdk/client/chains";
import {
  registerL1Validator,
  ValidatorManagerAbi,
  type AggregateSignaturesFn,
} from "@avalanche-sdk/interchain";
import { getAddress, type Hex } from "viem";

const LOCAL_NETWORK_ID = 12345;
const SIGAGG_URL = "http://127.0.0.1:8090";

// Spawn the new node on a port range above the existing primary-network nodes
// (9650, 9750, 9850, ...) and existing L1 nodes (10150, 10250, ...). Picking
// 10750+ leaves a comfortable gap for additional L1s the user might add.
const NEW_NODE_HTTP_PORT = 10750;
const NEW_NODE_STAKING_PORT = 10751;

async function main() {
  const network = loadNetwork();
  const l1 = pickDestination(network);
  console.log(`L1:        ${l1.name}  (subnetId=${l1.subnetId})`);
  console.log(`L1 RPC:    ${l1.rpcUrl}`);
  console.log(`Funded:    ${network.funded.address}\n`);

  // ---- 1. Spawn a fresh validator node tracking the L1's subnet. --------
  // We mimic packages/tmpnet/src/l1.ts:spawnL1Node — same flags, just a
  // different port pair. The node bootstraps off primary node 0's staking
  // port (9651) and uses an ephemeral staking cert + BLS key (avalanchego
  // generates them in the data dir on first boot).
  console.log(`Spawning new avalanchego validator on port ${NEW_NODE_HTTP_PORT}...`);
  const { apiURI, logFile } = spawnValidatorNode({
    workDir: findInterchainKitDir(),
    subnetId: l1.subnetId,
    httpPort: NEW_NODE_HTTP_PORT,
    stakingPort: NEW_NODE_STAKING_PORT,
  });
  console.log(`  log:  ${logFile}`);
  console.log(`  api:  ${apiURI}\n`);

  // ---- 2. Wait for the node to be up + capture its identity. ------------
  console.log("Waiting for new node to come up...");
  const identity = await waitForNodeIdentity(apiURI, 90_000);
  console.log(`  NodeID:    ${identity.nodeID}`);
  console.log(`  BLS pubkey ${identity.blsPublicKey.slice(0, 18)}...`);
  console.log(`  BLS PoP    ${identity.blsProofOfPossession.slice(0, 18)}...\n`);

  // ---- 3. EVM clients on the L1 + P-Chain wallet client. ----------------
  // EVM client = us calling the ValidatorManager. P-Chain client = us
  // submitting `RegisterL1ValidatorTx` to commit the new validator to the
  // P-Chain's primary-network state.
  const { walletClient, publicClient } = makeClients(l1, network.funded.privateKey);
  const pAccount = privateKeyToAvalancheAccount(network.funded.privateKey);
  const ownerPAddr = pAccount.getXPAddress("P", "local");
  const pWallet = createAvalancheWalletClient({
    chain: avalancheLocal,
    transport: { type: "http", url: `${new URL(network.cChain.rpcUrl).origin}/ext/bc/C/rpc` },
    account: pAccount,
  });

  // The PChainOwner struct on the EVM side wants 20-byte addresses, not
  // bech32. Convert: bech32 → raw 20 bytes → 0x-hex. viem accepts any
  // 20-byte hex as an Address (it has no idea it's a P-Chain hash).
  const ownerPBytes = utils.bech32ToBytes(ownerPAddr);
  const ownerAddrEvm = getAddress(`0x${Buffer.from(ownerPBytes).toString("hex")}`);
  const balanceOwner = { threshold: 1, addresses: [ownerAddrEvm] as const };

  // ---- 4. Drive the SDK's two-phase register flow. ----------------------
  console.log("Driving registerL1Validator (initiate → P-Chain → complete)...");
  const aggregator = makeAggregator(SIGAGG_URL);

  const result = await registerL1Validator(walletClient as never, publicClient as never, {
    onProgress: (m) => console.log(`  [register] ${m}`),
    validatorManagerAddress: getAddress(l1.validatorManager) as Address,
    networkId: LOCAL_NETWORK_ID,
    subnetId: l1.subnetId,
    validator: {
      nodeId: identity.nodeID,
      blsPublicKey: identity.blsPublicKey,
      weight: 1n,
      remainingBalanceOwner: balanceOwner,
      disableOwner: balanceOwner,
    },
    aggregateSignatures: aggregator,

    // The new node already exposed its proof-of-possession via /ext/info.
    // For a "BYO key" workflow (operator runs the node, we never see the
    // private key) this would come from the operator out-of-band.
    getBlsProofOfPossession: async () => identity.blsProofOfPossession,

    // Submit the P-Chain RegisterL1ValidatorTx ourselves. The SDK can't —
    // it doesn't own a P-Chain wallet. Steps:
    //   a. Advance P-Chain height a couple times so the L1's proposerVM
    //      catches up past the conversion (avalanchego computes warp
    //      `recommendedPChainHeight` lagging the tip; before catch-up the
    //      L1's signer set is empty from the P-Chain's view).
    //   b. Build + send `RegisterL1ValidatorTx` with the signed warp message
    //      + BLS PoP + a small initial balance (100M nAVAX = 0.1 AVAX).
    //   c. Wait for commit.
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
        // 0.1 AVAX of initial balance, denominated in nanoAvax — the
        // validator burns this slowly to pay for its continuous-fee
        // subscription. Cheap on a local net. (Field is named *InAvax* but
        // semantically takes nanoAvax — quirk of the SDK type.)
        initialBalanceInAvax: 100_000_000n,
        blsSignature: blsProofOfPossessionHex,
        message: signedWarpMessageHex,
      });
      const { txHash } = await pWallet.sendXPTransaction({ tx: txnRequest.tx, chainAlias: "P" });
      await waitForPChainCommit(pWallet, txHash);
      console.log(`    P-Chain RegisterL1ValidatorTx committed: ${txHash}`);

      // Roll the L1 forward one epoch so its next block sees the
      // post-registration P-Chain state — otherwise the ACK warp message
      // gets verified at the pre-registration epoch and the new validator
      // hasn't been added to the L1's signer set yet.
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

  // ---- 5. Verify on both sides. -----------------------------------------
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

  console.log("\nDone. Spawned node is still running — kill with `pkill -9 avalanchego` when done.");
}

// ---------------------------------------------------------------------------
// Spawn helpers — minimal copy of packages/tmpnet/src/l1.ts:spawnL1Node so
// this script doesn't need an internal helper to be exported.
// ---------------------------------------------------------------------------

interface SpawnOpts {
  workDir: string;
  subnetId: string;
  httpPort: number;
  stakingPort: number;
}

function spawnValidatorNode(opts: SpawnOpts): { apiURI: string; logFile: string } {
  const avalanchego = findAvalanchego();
  const pluginDir = resolvePluginDir(avalanchego);

  const name = `add-validator-${opts.httpPort}`;
  const nodeDir = path.join(opts.workDir, "data", name);
  const logFile = path.join(opts.workDir, "logs", `${name}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  for (const sub of ["db", "logs", "staking", "chainData", "configs"]) {
    mkdirSync(path.join(nodeDir, sub), { recursive: true });
  }

  // Bootstrap off primary node 0 (always at 9650/9651 with our orchestrator).
  // We could query its NodeID dynamically, but on a freshly-`pnpm up`ed
  // network it's deterministic from the staker1.key.
  // To keep this script ergonomic, ask /ext/info synchronously.
  const cliArgs = [
    `--http-port=${opts.httpPort}`,
    `--staking-port=${opts.stakingPort}`,
    "--network-id=local",
    // Ephemeral staking cert + BLS signer — avalanchego generates a fresh
    // key on first boot. That's what makes this a "new" validator from the
    // network's perspective.
    "--staking-ephemeral-cert-enabled=true",
    "--staking-ephemeral-signer-enabled=true",
    `--data-dir=${nodeDir}`,
    `--db-dir=${path.join(nodeDir, "db")}`,
    `--log-dir=${path.join(nodeDir, "logs")}`,
    `--chain-data-dir=${path.join(nodeDir, "chainData")}`,
    `--track-subnets=${opts.subnetId}`,
    `--bootstrap-ips=127.0.0.1:9651`,
    `--bootstrap-ids=NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg`, // staker1's NodeID
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

function findAvalanchego(): string {
  const env = process.env.AVALANCHEGO_PATH;
  if (env && existsSync(env)) return env;
  // Fallback: <interchain-kit>/bin/avalanchego — where the installer drops it.
  const local = path.join(findInterchainKitDir(), "bin", "avalanchego");
  if (existsSync(local)) return local;
  throw new Error(
    "Couldn't find avalanchego. Set AVALANCHEGO_PATH or run `pnpm up` first " +
      "(the orchestrator drops one under .interchain-kit/bin/).",
  );
}

function resolvePluginDir(avalanchegoBinary: string): string {
  // subnet-evm VM ID — same constant used by the orchestrator.
  const SUBNET_EVM = "srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy";
  const candidates: string[] = [];
  if (process.env.AVALANCHEGO_PLUGIN_DIR) candidates.push(process.env.AVALANCHEGO_PLUGIN_DIR);
  candidates.push(path.join(path.dirname(avalanchegoBinary), "plugins"));
  for (const dir of candidates) {
    try {
      if (statSync(path.join(dir, SUBNET_EVM)).isFile()) return dir;
    } catch {}
  }
  throw new Error(`Cannot find subnet-evm plugin. Checked: ${candidates.join(", ")}`);
}

function findInterchainKitDir(): string {
  // walk up from cwd looking for .interchain-kit/
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const ck = path.join(dir, ".interchain-kit");
    if (existsSync(ck)) return ck;
    const parent = path.resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(".interchain-kit/ not found above cwd. Run `pnpm up` first.");
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
          return {
            nodeID,
            blsPublicKey: pk as Hex,
            blsProofOfPossession: pop as Hex,
          };
        }
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${apiURI}/ext/info: ${lastErr}`);
}

function makeAggregator(sigaggUrl: string): AggregateSignaturesFn {
  return async ({ unsignedMessageHex, signingSubnetId, justificationHex }) => {
    const deadline = Date.now() + 120_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      const res = await fetch(`${sigaggUrl}/aggregate-signatures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: unsignedMessageHex,
          justification: justificationHex,
          "signing-subnet-id": signingSubnetId,
          "quorum-percentage": 67,
        }),
      });
      const json = (await res.json()) as { "signed-message"?: string; error?: string };
      if (json["signed-message"]) {
        const hex = json["signed-message"];
        return (hex.startsWith("0x") ? hex : `0x${hex}`) as Hex;
      }
      lastErr = json.error ?? `HTTP ${res.status}`;
      if (!/no signatures|threshold/i.test(lastErr)) {
        throw new Error(`sig-aggregator: ${lastErr}`);
      }
      await sleep(3_000);
    }
    throw new Error(`sig-aggregator timed out: ${lastErr}`);
  };
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
