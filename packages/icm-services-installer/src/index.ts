// @interchain-kit/icm-services-installer
//
// Pulls pinned prebuilt binaries from github.com/ava-labs/icm-services releases.
// Caches under <cacheDir>/<binary>-<version>/.
//
// Public API:
//   installBinary(binary, opts?) → absolute path to the cached binary
//   binaryPath(binary, opts?)    → the path it WOULD be cached at (no fetch)

import { access, mkdir, readdir, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import {
  detectPlatform,
  assetFilename,
  checksumsFilename,
} from "./platform.ts";
import {
  downloadTo,
  extractTarGz,
  findChecksum,
  readMaybe,
  removeQuietly,
  verifySha256,
} from "./download.ts";

// --- Pinned versions (do NOT change without auditing release assets) -------

export const ICM_RELAYER_VERSION = "v1.7.5";
export const SIGNATURE_AGGREGATOR_VERSION = "v0.5.4";

export const RELEASES_BASE =
  "https://github.com/ava-labs/icm-services/releases/download";

export type BinaryName = "icm-relayer" | "signature-aggregator";

export interface InstallOptions {
  /** Directory to cache extracted binaries. Defaults to `<cwd>/.interchain-kit/bin`. */
  cacheDir?: string;
}

/** Release tag format used by icm-services: "<binary>-<version>". */
export function releaseTag(binary: BinaryName): string {
  return `${binary}-${versionFor(binary)}`;
}

/** Version string ("v1.7.5") for a given binary. */
export function versionFor(binary: BinaryName): string {
  return binary === "icm-relayer"
    ? ICM_RELAYER_VERSION
    : SIGNATURE_AGGREGATOR_VERSION;
}

function bareVersion(binary: BinaryName): string {
  // Release asset filenames use the version without the "v" prefix.
  return versionFor(binary).replace(/^v/, "");
}

function defaultCacheDir(): string {
  return path.join(process.cwd(), ".interchain-kit", "bin");
}

function cacheSubdir(binary: BinaryName, cacheDir: string): string {
  return path.join(cacheDir, `${binary}-${versionFor(binary)}`);
}

/**
 * Return the absolute path where `binary` would be cached. Does NOT download
 * or verify that the file exists.
 */
export function binaryPath(binary: BinaryName, opts: InstallOptions = {}): string {
  const dir = opts.cacheDir ?? defaultCacheDir();
  return path.join(cacheSubdir(binary, dir), binary);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Build the release download URL for an asset. */
function assetUrl(binary: BinaryName, fileName: string): string {
  return `${RELEASES_BASE}/${releaseTag(binary)}/${fileName}`;
}

/**
 * Install (download, verify, extract, cache) the pinned binary. Returns the
 * absolute path to the extracted executable. If the binary is already cached
 * at the expected location, returns immediately without touching the network.
 */
export async function installBinary(
  binary: BinaryName,
  opts: InstallOptions = {},
): Promise<string> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const destDir = cacheSubdir(binary, cacheDir);
  const binPath = path.join(destDir, binary);

  // Cache hit — done.
  if (await exists(binPath)) {
    return binPath;
  }

  const plat = detectPlatform();
  const tarballName = assetFilename(binary, bareVersion(binary), plat);
  const sumsName = checksumsFilename(binary, bareVersion(binary));

  // Stage to a sibling directory so a partial download/extract never pollutes
  // the final cache path. Rename into place atomically when done.
  await mkdir(cacheDir, { recursive: true });
  const stagingDir = await mkTempStaging(cacheDir, binary);
  try {
    const tarballPath = path.join(stagingDir, tarballName);
    const sumsPath = path.join(stagingDir, sumsName);

    await downloadTo(assetUrl(binary, tarballName), tarballPath);

    // Checksum verification is best-effort but should succeed for these releases.
    try {
      await downloadTo(assetUrl(binary, sumsName), sumsPath);
      const sums = await readMaybe(sumsPath);
      if (sums) {
        const expected = findChecksum(sums, tarballName);
        if (expected) {
          await verifySha256(tarballPath, expected);
        }
      }
    } catch {
      // No checksums asset? Continue without verification (per spec).
    }

    const extractDir = path.join(stagingDir, "extract");
    await mkdir(extractDir, { recursive: true });
    await extractTarGz(tarballPath, extractDir);

    // Sanity-check that the expected binary is present inside the tarball.
    const entries = await readdir(extractDir);
    if (!entries.includes(binary)) {
      throw new Error(
        `extracted tarball ${tarballName} did not contain expected binary "${binary}" ` +
          `(found: ${entries.join(", ")})`,
      );
    }

    // Move into the final cache directory. If something else got there first
    // (concurrent install), prefer the existing copy.
    if (!(await exists(destDir))) {
      try {
        await rename(extractDir, destDir);
      } catch (err) {
        if (!(await exists(destDir))) throw err;
      }
    }
  } finally {
    await removeQuietly(stagingDir);
  }

  if (!(await exists(binPath))) {
    throw new Error(
      `install completed but binary not found at ${binPath}. ` +
        `This indicates the release tarball layout changed.`,
    );
  }

  return binPath;
}

async function mkTempStaging(cacheDir: string, binary: BinaryName): Promise<string> {
  const dir = path.join(
    cacheDir,
    `.${binary}-${versionFor(binary)}.staging-${process.pid}-${Date.now()}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

// Re-exports for downstream packages that want the lower-level helpers.
export { detectPlatform } from "./platform.ts";
export type { PlatformInfo, SupportedOS, SupportedArch } from "./platform.ts";
