// =============================================================================
//  validator-manager-setup.ts — wire up the L1's ValidatorManager.
// -----------------------------------------------------------------------------
//  ACP-77 requires every L1's `ConvertSubnetToL1Tx` to reference an EVM
//  address as the validator manager. That address has to exist *at conversion
//  time* — before any EVM tx can be sent against the L1. We solve the chicken-
//  and-egg with a TransparentUpgradeableProxy pre-deployed in subnet-evm
//  genesis at `VALIDATOR_MANAGER_PROXY_ADDRESS` (`0xfacade…`). At genesis the
//  proxy points at a placeholder `0x12121212…` — calls succeed at the EVM
//  level but delegatecall into nothing.
//
//  This script finishes the bring-up:
//    1. Deploy a real ValidatorManager + ValidatorMessages library.
//    2. Have the ProxyAdmin upgrade the genesis proxy *and* atomically call
//       `initialize(settings)` so the manager has its admin, subnetID, and
//       churn parameters set.
//    3. `initializeValidatorSet(...)` — aggregates BLS sigs over a
//       SubnetToL1Conversion warp message and writes the bootstrap validators
//       into contract storage.
//    4. Read + print the resulting state.
//
//  Run: pnpm exec tsx validator-manager-setup.ts
//  Prereq: `tmpnetjs up` from the repo root.
// =============================================================================

import {
  loadNetwork,
  pickL1,
  makeClients,
  blockchainIdToBytes32,
  aggregateSignaturesAt,
} from "tmpnetjs";
import {
  initializeValidatorSet,
  upgradeProxyToValidatorManager,
  ValidatorManagerAbi,
  type AggregateSignaturesFn,
} from "@avalanche-sdk/interchain";
import { getAddress, type Address, type Hex } from "viem";

// The local-network ID baked into avalanchego's `--network-id=local`.
const LOCAL_NETWORK_ID = 12345;

async function main() {
  const network = loadNetwork();
  const l1 = pickL1(network);
  console.log(`L1:        ${l1.name}  (subnetId=${l1.subnetId})`);
  console.log(`L1 RPC:    ${l1.rpcUrl}`);
  console.log(`Proxy:     ${l1.validatorManager}`);
  console.log(`Funded:    ${network.funded.address}\n`);

  const { walletClient, publicClient } = makeClients(l1, network.funded.privateKey);

  // ---- 0. Look up the bootstrap validator's NodeID + BLS public key. -----
  // The L1 has one validator at conversion time. `info.getNodeID` on the L1
  // RPC node returns both, no on-disk key parsing.
  const l1ApiBase = new URL(l1.rpcUrl).origin;
  const { nodeId, blsPublicKey } = await fetchNodeIdentity(l1ApiBase);
  console.log(`NodeID:     ${nodeId}`);
  console.log(`BLS pubkey: ${blsPublicKey.slice(0, 18)}...\n`);

  // ---- 1. Deploy real impl + upgrade proxy. ------------------------------
  // upgradeProxyToValidatorManager:
  //   - deploys ValidatorMessages, links it into ValidatorManager bytecode
  //   - deploys ValidatorManager with ICMInitializable.Disallowed
  //   - ProxyAdmin.upgradeAndCall(proxy, impl, initCalldata) — atomic point
  //     at impl + run `initialize(settings)` in proxy storage
  console.log("Deploying real ValidatorManager + upgrading the proxy...");
  const upgrade = await upgradeProxyToValidatorManager(
    walletClient as never,
    publicClient as never,
    {
      proxyAddress: getAddress(l1.validatorManager),
      initSettings: {
        admin: getAddress(network.funded.address),
        subnetID: blockchainIdToBytes32(l1.subnetId),
        // Local-dev: disable churn limiting (period=0). Production L1s set
        // ~3600s + ~5% so weight changes can't drain the set instantly.
        churnPeriodSeconds: 0n,
        maximumChurnPercentage: 20,
      },
    },
  );
  console.log(`  implementation:        ${upgrade.implementationAddress}`);
  console.log(`  ValidatorMessages lib: ${upgrade.libraryAddress}`);
  console.log(`  upgradeAndCall tx:     ${upgrade.upgradeTxHash}\n`);

  // ---- 2. initializeValidatorSet — drives sig-aggregator. ----------------
  // Builds a SubnetToL1Conversion warp message, hands it to our aggregator
  // callback, packs the signed message into the EVM warp precompile's access
  // list, and calls `initializeValidatorSet(conversionData, messageIndex=0)`.
  // The contract verifies sha256 over canonical conversion bytes matches
  // what's signed, then writes one Validator entry per validators[] and
  // flips isValidatorSetInitialized.
  console.log("Calling initializeValidatorSet (drives sig-aggregator)...");
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

  const initSetResult = await initializeValidatorSet(
    walletClient as never,
    publicClient as never,
    {
      onProgress: (m) => console.log(`  [init] ${m}`),
      contractAddress: getAddress(l1.validatorManager),
      networkId: LOCAL_NETWORK_ID,
      subnetId: l1.subnetId,
      blockchainId: l1.blockchainId,
      // L1 was converted with a single validator at weight 100.
      validators: [{ nodeId, weight: 100n, blsPublicKey }],
      aggregateSignatures: aggregate,
    },
  );
  console.log(`  initializeValidatorSet tx: ${initSetResult.txHash}\n`);

  // ---- 3. Read the resulting state. --------------------------------------
  const vm = { address: getAddress(l1.validatorManager) as Address, abi: ValidatorManagerAbi };

  const isInitialized = (await publicClient.readContract({
    ...vm,
    functionName: "isValidatorSetInitialized",
  })) as boolean;
  const totalWeight = (await publicClient.readContract({
    ...vm,
    functionName: "l1TotalWeight",
  })) as bigint;

  console.log(`isValidatorSetInitialized: ${isInitialized}`);
  console.log(`l1TotalWeight:             ${totalWeight}`);

  // Walk P-Chain validators to grab each validationID, then read each
  // Validator entry from the EVM contract.
  const subnetValidators = await fetchPChainValidators(network.cChain.rpcUrl, l1.subnetId);
  console.log(`\nValidators (${subnetValidators.length}):`);
  for (const v of subnetValidators) {
    const onChain = (await publicClient.readContract({
      ...vm,
      functionName: "getValidator",
      args: [blockchainIdToBytes32(v.validationID)],
    })) as { nodeID: Hex; weight: bigint; status: number };
    console.log(
      `  nodeId=${v.nodeID} validationID=${v.validationID.slice(0, 12)}... ` +
        `weight=${onChain.weight} status=${onChain.status}`,
    );
  }

  console.log("\nDone. ValidatorManager is live.");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fetchNodeIdentity(apiBase: string): Promise<{ nodeId: string; blsPublicKey: Hex }> {
  const res = await fetch(`${apiBase}/ext/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "info.getNodeID" }),
  });
  const json = (await res.json()) as {
    result?: { nodeID?: string; nodePOP?: { publicKey?: string } };
  };
  const nodeId = json.result?.nodeID;
  const publicKey = json.result?.nodePOP?.publicKey;
  if (!nodeId || !publicKey) {
    throw new Error(`info.getNodeID returned incomplete result: ${JSON.stringify(json)}`);
  }
  return { nodeId, blsPublicKey: publicKey as Hex };
}

interface PChainSubnetValidator {
  nodeID: string;
  validationID: string;
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

main().catch((err) => {
  console.error("\nvalidator-manager-setup failed:", err.message ?? err);
  process.exit(1);
});
