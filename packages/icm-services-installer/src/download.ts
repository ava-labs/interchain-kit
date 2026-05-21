// HTTPS download + checksum verification + tar.gz extraction.
//
// Uses only Node built-ins: node:https for download (follows redirects to the
// CDN), node:crypto for SHA-256, and spawns `tar -xzf` for extraction since
// tar is universally available on the supported platforms (macOS/Linux).

import { createHash } from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

/**
 * Download a URL to a local file. Follows HTTP redirects (GitHub releases
 * redirect to the objects.githubusercontent.com CDN).
 */
export async function downloadTo(url: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const get = (target: string, hops: number): void => {
      if (hops > 10) {
        reject(new Error(`too many redirects for ${url}`));
        return;
      }
      const req = https.get(
        target,
        { headers: { "user-agent": "interchain-kit-installer" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, target).toString();
            get(next, hops + 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`GET ${target} returned status ${status}`));
            return;
          }
          const out = createWriteStream(destPath);
          pipeline(res, out).then(resolve, reject);
        },
      );
      req.on("error", reject);
    };
    get(url, 0);
  });
}

/** Compute the hex-encoded SHA-256 of a file. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/**
 * Parse a GoReleaser-style checksums.txt where each line is "<hex>  <filename>".
 * Returns the hex sum for `targetFilename`, or null if not present.
 */
export function findChecksum(
  checksumsContent: string,
  targetFilename: string,
): string | null {
  for (const rawLine of checksumsContent.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on whitespace; first token is the hash, last token is the filename.
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const hash = parts[0];
    const file = parts[parts.length - 1];
    if (hash && file === targetFilename) return hash.toLowerCase();
  }
  return null;
}

/**
 * Verify `filePath` against an expected hex sha256. Throws on mismatch.
 */
export async function verifySha256(
  filePath: string,
  expectedHex: string,
): Promise<void> {
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(
      `checksum mismatch for ${path.basename(filePath)}: ` +
        `expected ${expectedHex}, got ${actual}`,
    );
  }
}

/**
 * Extract a tar.gz archive into a directory using the system `tar` binary.
 * The destination directory must already exist.
 */
export async function extractTarGz(
  archivePath: string,
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/** Best-effort recursive remove; never throws if the path doesn't exist. */
export async function removeQuietly(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Read a file as utf-8, or return null if it doesn't exist. */
export async function readMaybe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}
