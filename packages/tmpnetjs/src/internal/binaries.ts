// Auto-provision the avalanchego + subnet-evm binaries a local network needs,
// the same way the icm-relayer / signature-aggregator binaries are already
// provisioned (pinned release, checksum-verified, cached under <workDir>/bin).
//
// Before this, those two were the only binaries left to the user — supplied via
// AVALANCHEGO_PATH / AVALANCHEGO_PLUGIN_DIR env vars and path-guessing. That was
// the source of the boot gauntlet (wrong binary, devnet build, missing plugin).
//
// Strategy: install what's missing, then PIN the resolved locations into
// process.env (only the vars the user left unset). Every downstream resolver
// (findAvalanchego, resolvePluginDir, the snapshot fingerprinter) is already
// env-var-first, so pinning makes them all agree without threading paths through
// a dozen call sites. The env override is preserved — set AVALANCHEGO_PATH to run
// your own avalanchego build, and the RPCChainVM preflight still guards the pair.

import { mkdir, rm, symlink } from "node:fs/promises";
import * as path from "node:path";

import {
  installBinary,
  AVALANCHEGO_VERSION,
  SUBNET_EVM_VERSION,
} from "@interchain-kit/icm-services-installer";

import type { paths as Paths } from "./config.js";
import { PreflightError } from "./preflight.js";
import { SUBNET_EVM_VM_ID } from "../l1/create.js";

/** Replace any existing entry at `linkPath` with a symlink to `target`. */
async function forceSymlink(target: string, linkPath: string): Promise<void> {
  await rm(linkPath, { force: true });
  await symlink(target, linkPath);
}

/**
 * Ensure avalanchego + subnet-evm are available, downloading pinned releases on
 * first use. Pins the resolved paths into AVALANCHEGO_PATH / AVALANCHEGO_PLUGIN_DIR
 * (when unset) so the rest of the boot resolves the exact installed binaries.
 *
 * @param p   - Resolved workspace paths (uses `p.bin` as the cache dir).
 * @param log - Progress sink (defaults to no-op).
 */
export async function ensureBinariesInstalled(
  p: ReturnType<typeof Paths>,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  // --- avalanchego ---------------------------------------------------------
  const avagoOverride = process.env.AVALANCHEGO_PATH?.trim();
  if (avagoOverride) {
    log(
      `using AVALANCHEGO_PATH override: ${avagoOverride} ` +
        `(skipping auto-install of avalanchego ${AVALANCHEGO_VERSION} — ` +
        `ensure it's a release build; devnet/SAE C-Chains are unsupported)`,
    );
  } else {
    log(`ensuring avalanchego ${AVALANCHEGO_VERSION} is installed (first run downloads it)...`);
    let bin: string;
    try {
      bin = await installBinary("avalanchego", { cacheDir: p.bin });
    } catch (err) {
      throw new PreflightError(
        `Failed to install avalanchego ${AVALANCHEGO_VERSION}: ${(err as Error).message}\n` +
          `Set AVALANCHEGO_PATH to a local release binary to bypass the download.`,
      );
    }
    // Pin so findAvalanchego + the snapshot fingerprinter resolve this exact one.
    process.env.AVALANCHEGO_PATH = bin;
    log(`avalanchego ${AVALANCHEGO_VERSION} ready: ${bin}`);
  }

  // --- subnet-evm (as a VM-ID-named plugin) --------------------------------
  const pluginOverride = process.env.AVALANCHEGO_PLUGIN_DIR?.trim();
  if (pluginOverride) {
    log(
      `using AVALANCHEGO_PLUGIN_DIR override: ${pluginOverride} ` +
        `(skipping auto-install of subnet-evm ${SUBNET_EVM_VERSION})`,
    );
  } else {
    log(`ensuring subnet-evm ${SUBNET_EVM_VERSION} plugin is installed...`);
    let bin: string;
    try {
      bin = await installBinary("subnet-evm", { cacheDir: p.bin });
    } catch (err) {
      throw new PreflightError(
        `Failed to install subnet-evm ${SUBNET_EVM_VERSION}: ${(err as Error).message}\n` +
          `Set AVALANCHEGO_PLUGIN_DIR to a directory containing a file named ` +
          `"${SUBNET_EVM_VM_ID}" to bypass the download.`,
      );
    }
    // avalanchego loads VMs from --plugin-dir by a file named after the VM ID.
    // Symlink the cached subnet-evm under that name and point the env at the dir.
    const pluginDir = path.join(p.bin, "plugins");
    await mkdir(pluginDir, { recursive: true });
    await forceSymlink(bin, path.join(pluginDir, SUBNET_EVM_VM_ID));
    process.env.AVALANCHEGO_PLUGIN_DIR = pluginDir;
    log(`subnet-evm ${SUBNET_EVM_VERSION} ready: ${bin} (plugin dir: ${pluginDir})`);
  }
}
