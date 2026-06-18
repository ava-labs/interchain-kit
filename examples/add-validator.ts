// =============================================================================
//  add-validator.ts — register a second validator with the L1's ValidatorManager.
// -----------------------------------------------------------------------------
//  Prereq: `validator-manager-setup.ts` has run. The proxy at 0xfacade… points
//  at a real ValidatorManager with an initialized validator set (bootstrap
//  validator at weight 100).
//
//  This script spells out the full ACP-77 "RegisterL1Validator" dance step by
//  step using the SDK's *isolated* primitives (`initiateValidatorRegistration`,
//  `completeValidatorRegistration`, and the warp-message builders) instead of
//  the `registerL1Validator` orchestrator — so every EVM and P-Chain
//  transaction is visible right here in the example:
//
//    1. Spawn a fresh avalanchego node tracking the L1's subnet.
//    2. Read its NodeID + BLS pubkey + PoP via /ext/info.
//    3. EVM     initiateValidatorRegistration(...) → emits an unsigned
//               RegisterL1ValidatorMessage via the warp precompile + validationID.
//    4. Sigagg  aggregate L1 BLS sigs over that message.
//    5. P-Chain RegisterL1ValidatorTx with the signed warp message + BLS PoP.
//    6. Roll the L1 forward one epoch so the registration is visible to signers.
//    7. Build   L1ValidatorRegistrationMessage(validationID, true) ACK and
//               aggregate L1 BLS sigs over it (justification = register payload).
//    8. EVM     completeValidatorRegistration(0) with the signed ACK packed into
//               the warp precompile's access list.  ← the final EVM tx.
//
//  `registerL1Validator` bundles steps 3-8 behind three callbacks; here we make
//  each call ourselves. The SDK still owns the two EVM calls (initiate/complete)
//  and the warp-message encoding; we own the P-Chain wallet and the signature
//  aggregation, because the interchain package is EVM-only by design.
//
//  Run: pnpm exec tsx add-validator.ts
//  Spawned node stays running after the script exits; the script prints its
//  PID and log path at the end so you can stop it with `kill <PID>` without
//  affecting the tmpnet primary nodes.
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import * as path from "node:path";

import {
  loadNetwork,
  pickL1,
  makeClients,
  findAvalanchego,
  resolvePluginDir,
  findWorkDir,
  aggregateSignaturesAt,
} from "tmpnetjs";
import { utils } from "@avalabs/avalanchejs";
import { createAvalancheWalletClient } from "@avalanche-sdk/client";
import { privateKeyToAvalancheAccount } from "@avalanche-sdk/client/accounts";
import { avalancheLocal } from "@avalanche-sdk/client/chains";
import {
  initiateValidatorRegistration,
  completeValidatorRegistration,
  newL1ValidatorRegistrationMessage,
  newWarpMessage,
  P_CHAIN_BLOCKCHAIN_ID,
  ValidatorManagerAbi,
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
  const { apiURI, logFile, pid } = spawnValidatorNode({
    workDir: findWorkDir(),
    subnetId: l1.subnetId,
    httpPort: NEW_NODE_HTTP_PORT,
    stakingPort: NEW_NODE_STAKING_PORT,
  });
  console.log(`  pid:  ${pid}`);
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

  // The validator being registered. weight=1 keeps it well below the churn
  // limit relative to the bootstrap validator's weight of 100.
  const validator = {
    nodeId: identity.nodeID,
    blsPublicKey: identity.blsPublicKey,
    weight: 1n,
    remainingBalanceOwner: balanceOwner,
    disableOwner: balanceOwner,
  };
  const vmAddress = getAddress(l1.validatorManager);

  // Aggregate L1 BLS signatures over a warp message via the local
  // signature-aggregator. `justification` is "0x" for the outgoing register
  // message, and the register payload for the ACK (so each signer can look the
  // validationID up in its own P-Chain state before signing).
  const aggregate = async (unsignedMessageHex: Hex, justificationHex: Hex): Promise<Hex> =>
    (await aggregateSignaturesAt({
      message: unsignedMessageHex,
      justification: justificationHex,
      "signing-subnet-id": l1.subnetId,
    })) as Hex;

  // ---- 4. EVM: initiateValidatorRegistration. ----------------------------
  // First ValidatorManager EVM call. Emits an unsigned RegisterL1ValidatorMessage
  // (via the warp precompile) and assigns a validationID. Everything downstream
  // keys off this result: the unsigned warp message, its inner AddressedCall
  // payload (reused as the ACK justification), and the validationID.
  console.log("[1/5] EVM initiateValidatorRegistration...");
  const initiate = await initiateValidatorRegistration(walletClient as never, publicClient as never, {
    validatorManagerAddress: vmAddress,
    validator,
  });
  console.log(`  initiate tx:    ${initiate.txHash}`);
  console.log(`  validationID:   ${initiate.validationID}`);

  // ---- 5. Sigagg: L1 signatures over the RegisterL1ValidatorMessage. ------
  // Signed by the L1's own subnet validators; no justification needed here.
  console.log("[2/5] aggregating L1 signatures over RegisterL1ValidatorMessage...");
  const signedRegisterMsg = await aggregate(initiate.unsignedWarpMessageHex, "0x");

  // ---- 6. P-Chain: RegisterL1ValidatorTx. --------------------------------
  // The interchain SDK owns no P-Chain wallet, so we build + submit this
  // ourselves:
  //   a. Advance P-Chain a couple heights so the L1's proposerVM catches up
  //      past subnet conversion (warp recommendedPChainHeight lags tip).
  //   b. Submit RegisterL1ValidatorTx with the signed warp message + the
  //      validator's BLS PoP + 0.1 AVAX (in nAVAX) for the continuous fee.
  console.log("[3/5] P-Chain RegisterL1ValidatorTx...");
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
    // The new node already exposes its PoP via /ext/info. A real "BYO key" flow
    // would receive this out-of-band from the operator. It's verified on-chain
    // against the BLS pubkey in the register message — it is NOT a signature
    // over the warp payload.
    blsSignature: identity.blsProofOfPossession,
    message: signedRegisterMsg,
  });
  const { txHash: pChainTxId } = await pWallet.sendXPTransaction({
    tx: txnRequest.tx,
    chainAlias: "P",
  });
  await waitForPChainCommit(pWallet, pChainTxId);
  console.log(`  P-Chain tx:     ${pChainTxId}`);

  // ---- 7. Roll the L1 forward one epoch. ---------------------------------
  // The ACK below must verify at an epoch where the P-Chain registration is
  // already visible. Two empty self-transfers (~35s apart) push the L1 past an
  // epoch boundary. These are plain EVM txs — NOT ValidatorManager calls.
  console.log("[4/5] rolling L1 past epoch (2 self-transfers, ~35s)...");
  const epochAccount = walletClient.account;
  if (epochAccount) {
    for (let i = 0; i < 2; i++) {
      const tx = await walletClient.sendTransaction({
        to: epochAccount.address,
        value: 0n,
        chain: walletClient.chain,
        account: epochAccount,
      } as never);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      if (i === 0) await sleep(35_000);
    }
  }

  // ---- 8. Build + sign the ACK, then complete on the EVM. ----------------
  // L1ValidatorRegistrationMessage(validationID, registered=true), wrapped as a
  // P-Chain-sourced warp message (system source, no sender address). The
  // justification for aggregation is the original register payload bytes — each
  // L1 validator hashes those (sha256 == validationID) to confirm the validator
  // is registered on the P-Chain before it will sign the ACK.
  //
  // Then the SECOND (and final) ValidatorManager EVM call:
  // completeValidatorRegistration(0), with the signed ACK packed into the warp
  // precompile's access list.
  console.log("[5/5] ACK → aggregate → EVM completeValidatorRegistration...");
  const validationIdB58 = utils.base58check.encode(utils.hexToBuffer(initiate.validationID));
  const ackPayloadHex = newL1ValidatorRegistrationMessage(validationIdB58, true).toHex();
  const ackUnsignedHex = newWarpMessage(
    LOCAL_NETWORK_ID,
    P_CHAIN_BLOCKCHAIN_ID,
    "", // system source — no sender address
    ackPayloadHex,
  ).toHex() as Hex;
  const signedAckMsg = await aggregate(ackUnsignedHex, initiate.addressedCallPayloadHex);

  const complete = await completeValidatorRegistration(walletClient as never, publicClient as never, {
    validatorManagerAddress: vmAddress,
    signedAckMessageHex: signedAckMsg,
    onProgress: (m) => console.log(`  [complete] ${m}`),
  });

  console.log(`\nRegistered. validationID=${initiate.validationID}`);
  console.log(`  initiate tx (L1):   ${initiate.txHash}`);
  console.log(`  P-Chain tx:         ${pChainTxId}`);
  console.log(`  complete tx (L1):   ${complete.txHash}\n`);

  // ---- 9. Verify on both sides. ------------------------------------------
  const vm = { address: vmAddress as Address, abi: ValidatorManagerAbi };
  const onChain = (await publicClient.readContract({
    ...vm,
    functionName: "getValidator",
    args: [initiate.validationID],
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

  console.log(
    `\nDone. Spawned validator node still running. Stop it with: kill ${pid}  (PID=${pid})`,
  );
  console.log(`  log: ${logFile}`);
}

// ---------------------------------------------------------------------------
// Spawn the extra node. Lifted to a helper here (vs. tmpnetjs.Network.spawn…)
// to keep the actual avalanchego flags visible in the example. The binary and
// subnet-evm plugin dir are resolved via tmpnetjs (`resolvePluginDir` honors
// $AVALANCHEGO_PLUGIN_DIR and the auto-installed versioned-binary layout —
// hand-rolling `<binary dir>/plugins` breaks on that layout).
// ---------------------------------------------------------------------------

interface SpawnOpts {
  workDir: string;
  subnetId: string;
  httpPort: number;
  stakingPort: number;
}

function spawnValidatorNode(opts: SpawnOpts): { apiURI: string; logFile: string; pid: number } {
  const avalanchego = findAvalanchego(opts.workDir);
  const pluginDir = resolvePluginDir(avalanchego);

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

  return { apiURI: `http://127.0.0.1:${opts.httpPort}`, logFile, pid: child.pid };
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
