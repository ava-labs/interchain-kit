// Platform detection: maps Node's process.platform / process.arch to the
// OS+arch slugs used in icm-services release asset filenames.
//
// Asset filenames look like:
//   icm-relayer_1.7.5_darwin_arm64.tar.gz
//   signature-aggregator_0.5.4_linux_amd64.tar.gz

export type SupportedOS = "darwin" | "linux";
export type SupportedArch = "amd64" | "arm64";

export interface PlatformInfo {
  os: SupportedOS;
  arch: SupportedArch;
}

/**
 * Detect the current OS/arch and map to icm-services release naming.
 * Throws a clear error for unsupported platforms (notably Windows).
 */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformInfo {
  let os: SupportedOS;
  switch (platform) {
    case "darwin":
      os = "darwin";
      break;
    case "linux":
      os = "linux";
      break;
    default:
      throw new Error(
        `icm-services-installer: unsupported OS "${platform}". ` +
          `Only darwin and linux release binaries are published by ava-labs/icm-services.`,
      );
  }

  let mappedArch: SupportedArch;
  switch (arch) {
    case "x64":
      mappedArch = "amd64";
      break;
    case "arm64":
      mappedArch = "arm64";
      break;
    default:
      throw new Error(
        `icm-services-installer: unsupported CPU architecture "${arch}". ` +
          `Only x64 (amd64) and arm64 release binaries are published.`,
      );
  }

  return { os, arch: mappedArch };
}

/**
 * Build the asset filename for a given binary + version + platform.
 * The version passed in must NOT include a leading "v" — release filenames
 * use the bare version (e.g. "1.7.5", "0.5.4").
 */
export function assetFilename(
  binary: "icm-relayer" | "signature-aggregator",
  bareVersion: string,
  plat: PlatformInfo,
): string {
  return `${binary}_${bareVersion}_${plat.os}_${plat.arch}.tar.gz`;
}

/** Filename of the checksums asset on the release page. */
export function checksumsFilename(
  binary: "icm-relayer" | "signature-aggregator",
  bareVersion: string,
): string {
  return `${binary}_${bareVersion}_checksums.txt`;
}
