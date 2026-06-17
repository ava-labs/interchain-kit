// @interchain-kit/icm-services-installer
//
// Pulls pinned prebuilt binaries from GitHub releases and caches them under
// <cacheDir>/<binary>-<version>/. Despite the package name, it provisions the
// whole local-network binary set:
//
//   - icm-relayer / signature-aggregator  (github.com/ava-labs/icm-services)
//   - avalanchego                         (github.com/ava-labs/avalanchego)
//   - subnet-evm                          (github.com/ava-labs/subnet-evm)
//
// Public API:
//   installBinary(binary, opts?) → absolute path to the cached binary
//   binaryPath(binary, opts?)    → the path it WOULD be cached at (no fetch)

import { access, chmod, mkdir, readdir, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import {
  detectPlatform,
  assetFilename,
  checksumsFilename,
  type PlatformInfo,
} from "./platform.ts";
import {
  downloadTo,
  extractArchive,
  findChecksum,
  findExecutable,
  readMaybe,
  removeQuietly,
  verifySha256,
  type ArchiveKind,
} from "./download.ts";

/**
 * Env-var escape hatch. If set to "1", checksum verification becomes
 * best-effort (download attempts continue if checksums.txt is missing
 * or doesn't contain an entry for the tarball). Only affects checksums.txt
 * binaries — pinned-hash binaries (avalanchego) are always verified, since
 * the hash ships in this source and needs no network. Strongly discouraged.
 */
export const SKIP_CHECKSUM_ENV = "INTERCHAIN_KIT_SKIP_CHECKSUM";

// --- Pinned versions (do NOT change without auditing release assets) -------

export const ICM_RELAYER_VERSION = "v1.7.5";
export const SIGNATURE_AGGREGATOR_VERSION = "v0.5.4";
/** Paired so their RPCChainVM protocol versions match (both proto 44). */
export const AVALANCHEGO_VERSION = "v1.14.0";
export const SUBNET_EVM_VERSION = "v0.8.0";

export const RELEASES_BASE =
  "https://github.com/ava-labs/icm-services/releases/download";
const AVALANCHEGO_RELEASES_BASE =
  "https://github.com/ava-labs/avalanchego/releases/download";
const SUBNET_EVM_RELEASES_BASE =
  "https://github.com/ava-labs/subnet-evm/releases/download";

/**
 * SHA-256 of each avalanchego v1.14.0 release asset, as published by GitHub's
 * release-asset digest. avalanchego ships no checksums.txt (only GPG .sig),
 * so we pin the hashes here. Pinning in source is stronger than fetching a
 * checksums file alongside the asset — an attacker who can swap the asset
 * can't also rewrite this repo.
 */
const AVALANCHEGO_SHA256: Record<string, string> = {
  // macOS ships a single .zip (no per-arch asset).
  darwin: "6c1f57a288823c711f76168b9fa66988e930cf93df22ae2ff8072e66637db5aa",
  "linux-amd64":
    "4eee551a15f29c0e665ff80f234f23afe68bce6982d18f8d76d0a0b5e54af055",
  "linux-arm64":
    "0697a3e2aabb8ab413dcef4160afefaaa49c38c082d1a2939a64fe05abe6dabe",
};

export type BinaryName =
  | "icm-relayer"
  | "signature-aggregator"
  | "avalanchego"
  | "subnet-evm";

/**
 * Pluggable downloader. Used to fetch the release tarball and checksums.txt.
 * Exposed so tests can stub network IO without a real fetch; production code
 * should not pass this and instead use the default (real HTTPS download).
 */
export type Downloader = (url: string, destPath: string) => Promise<void>;

export interface InstallOptions {
  /** Directory to cache extracted binaries. Defaults to `<cwd>/.interchain-kit/bin`. */
  cacheDir?: string;
  /**
   * Override the download function. Internal/testing use only. Defaults to
   * the real `downloadTo` from `./download.ts`.
   */
  download?: Downloader;
}

/** How a release asset's integrity is verified. */
type Integrity =
  | { kind: "checksums-txt"; url: string; entry: string }
  | { kind: "pinned"; sha256: string };

/** Everything needed to fetch + extract one binary on one platform. */
interface AssetPlan {
  url: string;
  file: string;
  archive: ArchiveKind;
  integrity: Integrity;
}

/** A release source: its version, the executable name, and a per-platform plan. */
interface Source {
  version: string;
  /** Name of the executable inside the archive (and the cached filename). */
  exe: string;
  plan(plat: PlatformInfo): AssetPlan;
}

/**
 * GoReleaser-style source: `<base>/<tag>/<bin>_<bare>_<os>_<arch>.tar.gz` plus
 * a `<bin>_<bare>_checksums.txt`. Used by icm-services and subnet-evm.
 */
function goreleaser(opts: {
  base: string;
  bin: string;
  version: string;
  tag: string;
}): Source {
  const bare = opts.version.replace(/^v/, "");
  return {
    version: opts.version,
    exe: opts.bin,
    plan(plat) {
      const file = assetFilename(opts.bin, bare, plat);
      const sums = checksumsFilename(opts.bin, bare);
      return {
        url: `${opts.base}/${opts.tag}/${file}`,
        file,
        archive: "tar.gz",
        integrity: {
          kind: "checksums-txt",
          url: `${opts.base}/${opts.tag}/${sums}`,
          entry: file,
        },
      };
    },
  };
}

/**
 * avalanchego source: release tag is just the version. macOS is a single
 * `.zip`; linux is a per-arch `.tar.gz`. Integrity is a pinned hash.
 */
const avalanchegoSource: Source = {
  version: AVALANCHEGO_VERSION,
  exe: "avalanchego",
  plan(plat) {
    const v = AVALANCHEGO_VERSION;
    if (plat.os === "darwin") {
      const sha = AVALANCHEGO_SHA256["darwin"];
      if (!sha) throw new Error("no pinned avalanchego sha256 for darwin");
      const file = `avalanchego-macos-${v}.zip`;
      return {
        url: `${AVALANCHEGO_RELEASES_BASE}/${v}/${file}`,
        file,
        archive: "zip",
        integrity: { kind: "pinned", sha256: sha },
      };
    }
    const key = `linux-${plat.arch}`;
    const sha = AVALANCHEGO_SHA256[key];
    if (!sha) throw new Error(`no pinned avalanchego sha256 for ${key}`);
    const file = `avalanchego-linux-${plat.arch}-${v}.tar.gz`;
    return {
      url: `${AVALANCHEGO_RELEASES_BASE}/${v}/${file}`,
      file,
      archive: "tar.gz",
      integrity: { kind: "pinned", sha256: sha },
    };
  },
};

const SOURCES: Record<BinaryName, Source> = {
  "icm-relayer": goreleaser({
    base: RELEASES_BASE,
    bin: "icm-relayer",
    version: ICM_RELAYER_VERSION,
    tag: `icm-relayer-${ICM_RELAYER_VERSION}`,
  }),
  "signature-aggregator": goreleaser({
    base: RELEASES_BASE,
    bin: "signature-aggregator",
    version: SIGNATURE_AGGREGATOR_VERSION,
    tag: `signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}`,
  }),
  "subnet-evm": goreleaser({
    base: SUBNET_EVM_RELEASES_BASE,
    bin: "subnet-evm",
    version: SUBNET_EVM_VERSION,
    tag: SUBNET_EVM_VERSION,
  }),
  avalanchego: avalanchegoSource,
};

/** Release tag format used by icm-services: "<binary>-<version>". */
export function releaseTag(binary: BinaryName): string {
  return `${binary}-${versionFor(binary)}`;
}

/** Pinned version string ("v1.7.5") for a given binary. */
export function versionFor(binary: BinaryName): string {
  return SOURCES[binary].version;
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
  return path.join(cacheSubdir(binary, dir), SOURCES[binary].exe);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
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
  const download: Downloader = opts.download ?? downloadTo;
  const source = SOURCES[binary];
  const plan = source.plan(detectPlatform());
  const destDir = cacheSubdir(binary, cacheDir);
  const binPath = path.join(destDir, source.exe);

  // Cache hit — done.
  if (await exists(binPath)) {
    return binPath;
  }

  // Stage to a sibling directory so a partial download/extract never pollutes
  // the final cache path. Rename into place atomically when done.
  await mkdir(cacheDir, { recursive: true });
  const stagingDir = await mkTempStaging(cacheDir, binary);
  try {
    const archivePath = path.join(stagingDir, plan.file);
    await download(plan.url, archivePath);
    await verifyIntegrity(binary, plan, archivePath, stagingDir, download);

    const extractDir = path.join(stagingDir, "extract");
    await mkdir(extractDir, { recursive: true });
    await extractArchive(plan.archive, archivePath, extractDir);

    // Release archives place the binary at varying depths; locate it.
    const found = await findExecutable(extractDir, source.exe);
    if (!found) {
      const entries = await readdir(extractDir);
      throw new Error(
        `extracted ${plan.file} did not contain executable "${source.exe}" ` +
          `(top-level entries: ${entries.join(", ")})`,
      );
    }

    // Promote the directory CONTAINING the exe to the final cache path. This
    // keeps sibling assets next to the binary (icm-services config samples,
    // avalanchego's bundled plugins/) and yields a predictable <destDir>/<exe>.
    const exeDir = path.dirname(found);
    if (!(await exists(destDir))) {
      try {
        await rename(exeDir, destDir);
      } catch (err) {
        if (!(await exists(destDir))) throw err;
      }
    }
    // Archives normally preserve the +x bit; re-assert it defensively.
    await chmod(binPath, 0o755).catch(() => undefined);
  } finally {
    await removeQuietly(stagingDir);
  }

  if (!(await exists(binPath))) {
    throw new Error(
      `install completed but binary not found at ${binPath}. ` +
        `This indicates the release asset layout changed.`,
    );
  }

  return binPath;
}

/**
 * Verify a downloaded asset. Pinned-hash binaries are always checked against
 * the in-source hash. checksums.txt binaries fetch the sidecar file and verify
 * against it, refusing to proceed if it's missing/incomplete (unless the
 * SKIP_CHECKSUM_ENV escape hatch downgrades to best-effort).
 */
async function verifyIntegrity(
  binary: BinaryName,
  plan: AssetPlan,
  archivePath: string,
  stagingDir: string,
  download: Downloader,
): Promise<void> {
  if (plan.integrity.kind === "pinned") {
    await verifySha256(archivePath, plan.integrity.sha256);
    return;
  }

  const { url, entry } = plan.integrity;
  const sumsPath = path.join(stagingDir, "checksums.txt");
  const skipChecksum = process.env[SKIP_CHECKSUM_ENV] === "1";

  if (skipChecksum) {
    console.warn(
      `[icm-services-installer] WARNING: ${SKIP_CHECKSUM_ENV}=1 is set; ` +
        `checksum verification is DISABLED for ${plan.file}. ` +
        `You are downloading and executing a binary without integrity checks.`,
    );
    try {
      await download(url, sumsPath);
      const sums = await readMaybe(sumsPath);
      if (sums) {
        const expected = findChecksum(sums, entry);
        if (expected) await verifySha256(archivePath, expected);
      }
    } catch {
      // Best-effort path: swallow checksum fetch/parse errors. The warning
      // above already told the user the integrity story is degraded.
    }
    return;
  }

  try {
    await download(url, sumsPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `checksums.txt missing for ${binary} release ${plan.file} (${url}): ${reason}. ` +
        `Refusing to use unverified binary. ` +
        `Set ${SKIP_CHECKSUM_ENV}=1 to override (NOT recommended).`,
    );
  }
  const sums = await readMaybe(sumsPath);
  if (sums === null) {
    throw new Error(
      `checksums.txt for ${binary} was downloaded but could not be read at ${sumsPath}. ` +
        `Set ${SKIP_CHECKSUM_ENV}=1 to override (NOT recommended).`,
    );
  }
  const expected = findChecksum(sums, entry);
  if (!expected) {
    throw new Error(
      `checksums.txt for ${binary} has no entry for "${entry}". ` +
        `The release asset layout may have changed. ` +
        `Set ${SKIP_CHECKSUM_ENV}=1 to override (NOT recommended).`,
    );
  }
  await verifySha256(archivePath, expected);
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
