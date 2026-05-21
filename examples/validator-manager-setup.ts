// =============================================================================
//  validator-manager-setup.ts — wire up the L1's ValidatorManager.
// -----------------------------------------------------------------------------
//  Why this script exists:
//
//    ACP-77 requires that every L1's `ConvertSubnetToL1Tx` reference a known
//    EVM address as the *validator manager*. That address has to exist *at
//    conversion time* — i.e. before any EVM tx can be sent against the L1.
//    The chicken-and-egg is solved with a TransparentUpgradeableProxy
//    pre-deployed in the subnet-evm genesis at the well-known address
//    `0xfacade…`. At genesis the proxy's `implementation` slot points at
//    a placeholder (`0x12121212…`) — there is NO real ValidatorManager
//    bytecode yet. So calls on the proxy succeed at the EVM level but
//    delegatecall into nothing.
//
//    This script finishes the bring-up the orchestrator started:
//
//        1. Deploy a fresh ValidatorManager implementation (+ its
//           ValidatorMessages library) on the L1.
//        2. Tell the ProxyAdmin to upgrade the genesis proxy at the new
//           implementation AND atomically call `initialize(settings)` on
//           the proxy's storage so the manager has its admin, subnetID,
//           and churn parameters set.
//        3. Call `initializeValidatorSet(...)` so the bootstrap validators
//           the L1 was converted with appear in the contract's storage.
//           This involves aggregating BLS signatures from the L1's own
//           validators over a `SubnetToL1Conversion` warp message — the
//           signature-aggregator (already running on port 8090 from
//           `pnpm up`) does that for us.
//        4. Read + print the resulting on-chain state: was the validator
//           set initialized?, total weight, list of validators.
//
//  Run with:  pnpm exec tsx validator-manager-setup.ts
//             (or: `pnpm validator-manager-setup` from this directory)
//
//  Prereq:  the local network must be up (`pnpm up` from repo root).
// =============================================================================

import { loadNetwork, makeClients, pickDestination, type Address } from "./lib.js";
import {
  initializeValidatorSet,
  upgradeProxyToValidatorManager,
  ValidatorManagerAbi,
  type AggregateSignaturesFn,
} from "@avalanche-sdk/interchain";
import { getAddress, type Hex } from "viem";

// The local-network ID baked into avalanchego's `--network-id=local` mode.
// `initializeValidatorSet` uses this to scope the warp message it builds.
const LOCAL_NETWORK_ID = 12345;

// The signature-aggregator that `pnpm up` boots listens here. It's the
// HTTP service that walks the L1's validator peers and collects BLS sigs.
const SIGAGG_URL = "http://127.0.0.1:8090";

async function main() {
  const network = loadNetwork();
  const l1 = pickDestination(network);
  console.log(`L1:        ${l1.name}  (subnetId=${l1.subnetId})`);
  console.log(`L1 RPC:    ${l1.rpcUrl}`);
  console.log(`Proxy:     ${l1.validatorManager}`);
  console.log(`Funded:    ${network.funded.address}\n`);

  // viem clients for the L1 — wallet for writes, public for reads. The
  // funded EWOQ key owns the ProxyAdmin at genesis, so it's also the only
  // address that's allowed to upgrade the proxy in step 1.
  const { walletClient, publicClient } = makeClients(l1, network.funded.privateKey);

  // ---- 0. Look up the bootstrap validator on the L1 RPC node. -----------
  // The orchestrator gave the L1 one validator at ConvertSubnetToL1 time;
  // its NodeID + BLS public key are needed for `initializeValidatorSet`.
  // `info.getNodeID` against the L1 validator's API gives both.
  const l1ApiBase = new URL(l1.rpcUrl).origin;
  console.log(`Fetching bootstrap validator identity from ${l1ApiBase}/ext/info...`);
  const { nodeId, blsPublicKey } = await fetchNodeIdentity(l1ApiBase);
  console.log(`  NodeID:    ${nodeId}`);
  console.log(`  BLS pubkey ${blsPublicKey.slice(0, 18)}...\n`);

  // ---- 1. Deploy the real impl + upgrade the proxy at it. ---------------
  // `upgradeProxyToValidatorManager` is a one-shot helper that:
  //   - deploys the ValidatorMessages library
  //   - links it into ValidatorManager bytecode
  //   - deploys ValidatorManager with ICMInitializable.Disallowed (so the
  //     impl can't be initialized directly — only via the proxy's storage)
  //   - calls ProxyAdmin.upgradeAndCall(proxy, impl, initCalldata) which
  //     atomically points the proxy at the impl AND runs `initialize(settings)`
  //     in one transaction
  //
  // subnetID is the L1's 32-byte subnet ID in hex (not cb58).
  console.log("Deploying real ValidatorManager + upgrading the proxy...");
  const subnetIdHex = cb58ToHex(l1.subnetId);
  const upgrade = await upgradeProxyToValidatorManager(
    walletClient as never,
    publicClient as never,
    {
      // Use the proxy that's already pre-deployed in genesis. The default is
      // VALIDATOR_MANAGER_PROXY_ADDRESS, but l1.validatorManager has the same
      // value — we pass it explicitly to make the link obvious.
      proxyAddress: getAddress(l1.validatorManager) as Address,
      initSettings: {
        admin: getAddress(network.funded.address),
        subnetID: subnetIdHex,
        // Local-dev: disable churn limiting (churnPeriodSeconds=0). Production
        // L1s would set this to something like 3600 + maximumChurnPercentage=5
        // so weight changes can't drain the validator set instantly.
        churnPeriodSeconds: 0n,
        maximumChurnPercentage: 20,
      },
    },
  );
  console.log(`  implementation: ${upgrade.implementationAddress}`);
  console.log(`  ValidatorMessages lib: ${upgrade.libraryAddress}`);
  console.log(`  upgradeAndCall tx: ${upgrade.upgradeTxHash}\n`);

  // ---- 2. Initialize the validator set with the bootstrap validator. ----
  // `initializeValidatorSet` builds a SubnetToL1Conversion warp message,
  // hands it to our `aggregateSignatures` callback (which proxies to
  // signature-aggregator), packs the signed message into the EVM warp
  // precompile's access list, and calls the contract's
  // `initializeValidatorSet(conversionData, messageIndex=0)`.
  //
  // The contract recomputes sha256 over the canonical conversion bytes and
  // compares against what's signed by the warp message. If they match, it
  // writes one Validator entry per `validators[]` into storage and flips
  // `isValidatorSetInitialized` to true.
  console.log("Calling initializeValidatorSet (this drives sig-aggregator)...");
  const initSetResult = await initializeValidatorSet(
    walletClient as never,
    publicClient as never,
    {
      onProgress: (m) => console.log(`  [init] ${m}`),
      contractAddress: getAddress(l1.validatorManager) as Address,
      networkId: LOCAL_NETWORK_ID,
      subnetId: l1.subnetId,
      blockchainId: l1.blockchainId,
      validators: [
        // The L1 was converted with a single validator at weight 100.
        { nodeId, weight: 100n, blsPublicKey },
      ],
      aggregateSignatures: makeAggregator(SIGAGG_URL, l1.subnetId),
    },
  );
  console.log(`  initializeValidatorSet tx: ${initSetResult.txHash}\n`);

  // ---- 3. Read the state we just set up. --------------------------------
  // These are the three readers downstream tools (governance dashboards,
  // explorer UIs, ICM clients) rely on to surface the L1's validator set.
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

  // Walk the P-Chain validator list to find each subnet validator's
  // validationID, then ask the EVM contract for its on-chain record. We
  // could read validation IDs from the contract's emitted events, but
  // grabbing them from the P-Chain is a 1-roundtrip shortcut.
  const subnetValidators = await fetchPChainValidators(network.cChain.rpcUrl, l1.subnetId);
  console.log(`\nValidators (${subnetValidators.length}):`);
  for (const v of subnetValidators) {
    const validationIdHex = cb58ToHex(v.validationID);
    const onChain = (await publicClient.readContract({
      ...vm,
      functionName: "getValidator",
      args: [validationIdHex],
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

/**
 * Build the `aggregateSignatures` callback expected by `initializeValidatorSet`
 * and `registerL1Validator`. We POST to the running signature-aggregator's
 * HTTP API and convert the response shape.
 *
 * `signingSubnetId` and `justification` are forwarded verbatim — the SDK
 * picks the right values for each warp message type. We retry on transient
 * "no signatures collected yet" responses while peer connections warm up.
 */
function makeAggregator(sigaggUrl: string, _subnetId: string): AggregateSignaturesFn {
  void _subnetId;
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
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error(`sig-aggregator timed out: ${lastErr}`);
  };
}

/**
 * `info.getNodeID` on an avalanchego node returns its NodeID and BLS PoP.
 * For a node tracking the L1 subnet, this is exactly what
 * `initializeValidatorSet` wants — no signer-key-on-disk parsing needed.
 */
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
  // P-Chain JSON-RPC lives at /ext/bc/P off the same node URI.
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

/**
 * Convert an Avalanche cb58 32-byte ID (subnetId, validationID, ...) to
 * 0x-prefixed hex without re-validating the cb58 checksum. Quick + dirty
 * inline — `lib.ts:blockchainIdToBytes32` does the validating version for
 * blockchain IDs.
 */
function cb58ToHex(s: string): Hex {
  const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw new Error(`bad cb58 char "${ch}"`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  // strip the trailing 4-byte cb58 checksum
  const payload = bytes.slice(0, -4);
  return ("0x" + Buffer.from(payload).toString("hex")) as Hex;
}

main().catch((err) => {
  console.error("\nvalidator-manager-setup failed:", err.message ?? err);
  process.exit(1);
});
