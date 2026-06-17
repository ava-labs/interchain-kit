// Tests for @interchain-kit/icm-services-installer.
//
// Run with:
//   node --test test/
//
// Requires Node >= 22.6 (native TypeScript stripping). The "real download"
// test is gated behind a single cache miss followed by a cache hit; both
// resolve to the same on-disk path. To skip the network portion, set
// ICM_INSTALLER_SKIP_NETWORK=1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  ICM_RELAYER_VERSION,
  SIGNATURE_AGGREGATOR_VERSION,
  AVALANCHEGO_VERSION,
  SUBNET_EVM_VERSION,
  SKIP_CHECKSUM_ENV,
  releaseTag,
  versionFor,
  binaryPath,
  installBinary,
  detectPlatform,
} from "../src/index.ts";
import {
  assetFilename,
  checksumsFilename,
} from "../src/platform.ts";
import { findChecksum, sha256File, verifySha256 } from "../src/download.ts";

const skipNetwork = process.env.ICM_INSTALLER_SKIP_NETWORK === "1";

test("pinned versions are locked", () => {
  assert.equal(ICM_RELAYER_VERSION, "v1.7.5");
  assert.equal(SIGNATURE_AGGREGATOR_VERSION, "v0.5.4");
});

test("releaseTag composes binary + version", () => {
  assert.equal(releaseTag("icm-relayer"), "icm-relayer-v1.7.5");
  assert.equal(releaseTag("signature-aggregator"), "signature-aggregator-v0.5.4");
});

test("versionFor returns the right version per binary", () => {
  assert.equal(versionFor("icm-relayer"), "v1.7.5");
  assert.equal(versionFor("signature-aggregator"), "v0.5.4");
});

test("detectPlatform maps current host", () => {
  const p = detectPlatform();
  assert.ok(p.os === "darwin" || p.os === "linux");
  assert.ok(p.arch === "amd64" || p.arch === "arm64");
});

test("detectPlatform throws on windows", () => {
  assert.throws(() => detectPlatform("win32" as NodeJS.Platform, "x64"));
});

test("detectPlatform throws on weird arch", () => {
  assert.throws(() => detectPlatform("linux", "mips"));
});

test("assetFilename matches the real release naming convention", () => {
  assert.equal(
    assetFilename("icm-relayer", "1.7.5", { os: "darwin", arch: "arm64" }),
    "icm-relayer_1.7.5_darwin_arm64.tar.gz",
  );
  assert.equal(
    assetFilename("signature-aggregator", "0.5.4", { os: "linux", arch: "amd64" }),
    "signature-aggregator_0.5.4_linux_amd64.tar.gz",
  );
});

test("checksumsFilename uses underscore + _checksums.txt", () => {
  assert.equal(
    checksumsFilename("icm-relayer", "1.7.5"),
    "icm-relayer_1.7.5_checksums.txt",
  );
});

test("findChecksum parses GoReleaser-style checksums.txt", () => {
  const sample = [
    "abc123  icm-relayer_1.7.5_darwin_arm64.tar.gz",
    "def456  icm-relayer_1.7.5_linux_amd64.tar.gz",
    "",
    "# a comment that should be ignored gracefully",
    "deadbeef icm-relayer_1.7.5_darwin_amd64.tar.gz",
  ].join("\n");
  assert.equal(
    findChecksum(sample, "icm-relayer_1.7.5_darwin_arm64.tar.gz"),
    "abc123",
  );
  assert.equal(
    findChecksum(sample, "icm-relayer_1.7.5_darwin_amd64.tar.gz"),
    "deadbeef",
  );
  assert.equal(findChecksum(sample, "nope.tar.gz"), null);
});

test("findChecksum: present and valid returns lowercased hash", () => {
  const sample = "ABCDEF1234567890  icm-relayer_1.7.5_darwin_arm64.tar.gz\n";
  assert.equal(
    findChecksum(sample, "icm-relayer_1.7.5_darwin_arm64.tar.gz"),
    "abcdef1234567890",
  );
});

test("findChecksum: filename case mismatch is treated as absent", () => {
  // Defense-in-depth: we must NOT accept the hash for "...Darwin..." when
  // asked for "...darwin...". If GoReleaser ever changes casing, fail loud.
  const sample = "abc123  icm-relayer_1.7.5_Darwin_arm64.tar.gz\n";
  assert.equal(
    findChecksum(sample, "icm-relayer_1.7.5_darwin_arm64.tar.gz"),
    null,
  );
});

test("findChecksum: absent target returns null", () => {
  const sample = [
    "abc123  some-other-file.tar.gz",
    "def456  yet-another.tar.gz",
  ].join("\n");
  assert.equal(findChecksum(sample, "icm-relayer_1.7.5_darwin_arm64.tar.gz"), null);
});

test("findChecksum: tolerates malformed and blank lines", () => {
  const sample = [
    "",
    "    ",
    "single-token-no-filename",
    "# comment",
    "abc123  icm-relayer_1.7.5_darwin_arm64.tar.gz",
    "junk-junk-junk-no-spaces-anywhere",
  ].join("\n");
  // Despite the noise, the well-formed line is still picked up.
  assert.equal(
    findChecksum(sample, "icm-relayer_1.7.5_darwin_arm64.tar.gz"),
    "abc123",
  );
  // A single-token "filename" line where token == filename happens to satisfy
  // the parser's "first==last token" path — that's documented but undesired
  // for security. Pin behaviour so future refactors don't regress.
  assert.equal(findChecksum("# comment\nzzz\n", "zzz"), null);
});

test("verifySha256: happy path accepts matching hex (any case)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icm-vsha-"));
  try {
    const file = path.join(dir, "blob.bin");
    const body = "the quick brown fox jumps over the lazy dog";
    await writeFile(file, body);
    const expected = createHash("sha256").update(body).digest("hex");
    // Computed hex is lowercase; verifySha256 must also accept uppercase.
    await verifySha256(file, expected);
    await verifySha256(file, expected.toUpperCase());
    // And sha256File returns the same hex.
    assert.equal(await sha256File(file), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifySha256: mismatch throws with clear message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icm-vsha-mm-"));
  try {
    const file = path.join(dir, "blob.bin");
    await writeFile(file, "actual content");
    const wrong = "0".repeat(64);
    await assert.rejects(
      verifySha256(file, wrong),
      (err) => err instanceof Error && /checksum mismatch/i.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("binaryPath is pure and reflects cacheDir", () => {
  const p = binaryPath("icm-relayer", { cacheDir: "/tmp/foo" });
  assert.equal(p, "/tmp/foo/icm-relayer-v1.7.5/icm-relayer");
});

test("avalanchego + subnet-evm versions are locked as a matched (proto 44) pair", () => {
  assert.equal(AVALANCHEGO_VERSION, "v1.14.0");
  assert.equal(SUBNET_EVM_VERSION, "v0.8.0");
});

test("versionFor + binaryPath cover avalanchego and subnet-evm", () => {
  assert.equal(versionFor("avalanchego"), "v1.14.0");
  assert.equal(versionFor("subnet-evm"), "v0.8.0");
  assert.equal(
    binaryPath("avalanchego", { cacheDir: "/tmp/foo" }),
    "/tmp/foo/avalanchego-v1.14.0/avalanchego",
  );
  assert.equal(
    binaryPath("subnet-evm", { cacheDir: "/tmp/foo" }),
    "/tmp/foo/subnet-evm-v0.8.0/subnet-evm",
  );
});

test(
  "installBinary downloads, verifies (pinned sha256), and caches avalanchego (real network)",
  { skip: skipNetwork ? "ICM_INSTALLER_SKIP_NETWORK=1" : false, timeout: 180_000 },
  async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "avago-cache-"));
    try {
      // Exercises the new code paths: pinned-hash verification, .zip extraction
      // on macOS, and locating the nested avalanchego binary inside the archive.
      const installed = await installBinary("avalanchego", { cacheDir });
      assert.equal(
        installed,
        path.join(cacheDir, "avalanchego-v1.14.0", "avalanchego"),
      );
      const s = await stat(installed);
      assert.ok(s.isFile(), "installed avalanchego must be a regular file");
      assert.ok(s.size > 10_000_000, `binary suspiciously small: ${s.size} bytes`);

      const run = spawnSync(installed, ["--version"], { encoding: "utf8" });
      assert.equal(run.status, 0, `avalanchego --version failed: ${run.stderr}`);
      // Must be the pinned release (proto 44), not a devnet build.
      assert.match(run.stdout + run.stderr, /1\.14\.0/);
      assert.match(run.stdout + run.stderr, /rpcchainvm=44/);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);

/**
 * Build a minimal tar.gz containing a single executable named `binary`.
 * Returns the path to the archive.
 */
async function makeFakeTarball(
  cwd: string,
  binary: string,
  archiveName: string,
): Promise<string> {
  const stageDir = path.join(cwd, "stage");
  await mkdir(stageDir, { recursive: true });
  await writeFile(path.join(stageDir, binary), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  const archivePath = path.join(cwd, archiveName);
  const tar = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", stageDir, binary],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr}`);
  }
  return archivePath;
}

test("installBinary throws when checksums.txt is unreachable (fake network)", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "icm-no-sums-"));
  const stage = await mkdtemp(path.join(tmpdir(), "icm-no-sums-stage-"));
  // Ensure escape hatch is OFF for this test.
  const prev = process.env[SKIP_CHECKSUM_ENV];
  delete process.env[SKIP_CHECKSUM_ENV];
  try {
    const plat = detectPlatform();
    const tarballName = assetFilename("icm-relayer", "1.7.5", plat);
    const realTarball = await makeFakeTarball(stage, "icm-relayer", tarballName);
    const tarballBytes = await (await import("node:fs/promises")).readFile(realTarball);

    const download = async (url: string, destPath: string): Promise<void> => {
      if (url.endsWith(tarballName)) {
        await (await import("node:fs/promises")).writeFile(destPath, tarballBytes);
        return;
      }
      // Simulate 404 for checksums.txt.
      throw new Error(`GET ${url} returned status 404`);
    };

    await assert.rejects(
      installBinary("icm-relayer", { cacheDir, download }),
      (err) =>
        err instanceof Error &&
        /checksums\.txt missing/i.test(err.message) &&
        err.message.includes(SKIP_CHECKSUM_ENV),
    );
  } finally {
    if (prev !== undefined) process.env[SKIP_CHECKSUM_ENV] = prev;
    await rm(cacheDir, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
});

test("installBinary throws when checksums.txt has no entry for tarball", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "icm-no-entry-"));
  const stage = await mkdtemp(path.join(tmpdir(), "icm-no-entry-stage-"));
  const prev = process.env[SKIP_CHECKSUM_ENV];
  delete process.env[SKIP_CHECKSUM_ENV];
  try {
    const plat = detectPlatform();
    const tarballName = assetFilename("icm-relayer", "1.7.5", plat);
    const realTarball = await makeFakeTarball(stage, "icm-relayer", tarballName);
    const fs = await import("node:fs/promises");
    const tarballBytes = await fs.readFile(realTarball);

    const download = async (url: string, destPath: string): Promise<void> => {
      if (url.endsWith(tarballName)) {
        await fs.writeFile(destPath, tarballBytes);
        return;
      }
      if (url.endsWith("_checksums.txt")) {
        // Looks like a real checksums.txt but doesn't mention our tarball.
        await fs.writeFile(destPath, "deadbeef  some-other-file.tar.gz\n");
        return;
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    await assert.rejects(
      installBinary("icm-relayer", { cacheDir, download }),
      (err) =>
        err instanceof Error &&
        /no entry for/i.test(err.message) &&
        err.message.includes(tarballName),
    );
  } finally {
    if (prev !== undefined) process.env[SKIP_CHECKSUM_ENV] = prev;
    await rm(cacheDir, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
});

test(`installBinary skips verification when ${SKIP_CHECKSUM_ENV}=1 (fake network)`, async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "icm-skip-sums-"));
  const stage = await mkdtemp(path.join(tmpdir(), "icm-skip-sums-stage-"));
  const prev = process.env[SKIP_CHECKSUM_ENV];
  process.env[SKIP_CHECKSUM_ENV] = "1";
  // Capture console.warn to assert the loud warning fires.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const plat = detectPlatform();
    const tarballName = assetFilename("icm-relayer", "1.7.5", plat);
    const realTarball = await makeFakeTarball(stage, "icm-relayer", tarballName);
    const fs = await import("node:fs/promises");
    const tarballBytes = await fs.readFile(realTarball);

    const download = async (url: string, destPath: string): Promise<void> => {
      if (url.endsWith(tarballName)) {
        await fs.writeFile(destPath, tarballBytes);
        return;
      }
      // Even checksums fails — best-effort mode swallows it.
      throw new Error(`GET ${url} returned status 404`);
    };

    const installed = await installBinary("icm-relayer", { cacheDir, download });
    assert.equal(
      installed,
      path.join(cacheDir, "icm-relayer-v1.7.5", "icm-relayer"),
    );
    assert.ok((await stat(installed)).isFile(), "expected installed binary file");
    assert.ok(
      warnings.some((w) => w.includes(SKIP_CHECKSUM_ENV)),
      `expected a console.warn mentioning ${SKIP_CHECKSUM_ENV}, got: ${warnings.join(" | ")}`,
    );
  } finally {
    console.warn = originalWarn;
    if (prev === undefined) delete process.env[SKIP_CHECKSUM_ENV];
    else process.env[SKIP_CHECKSUM_ENV] = prev;
    await rm(cacheDir, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
});

test("installBinary short-circuits on cache hit (no network)", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "icm-cache-hit-"));
  try {
    const fakeBinDir = path.join(cacheDir, "icm-relayer-v1.7.5");
    await mkdir(fakeBinDir, { recursive: true });
    const fakeBin = path.join(fakeBinDir, "icm-relayer");
    await writeFile(fakeBin, "#!/bin/sh\necho fake\n", { mode: 0o755 });

    // Should resolve to the pre-existing file without doing any IO over the
    // network. We assert that by checking the mtime is unchanged after.
    const before = (await stat(fakeBin)).mtimeMs;
    const result = await installBinary("icm-relayer", { cacheDir });
    const after = (await stat(fakeBin)).mtimeMs;

    assert.equal(result, fakeBin);
    assert.equal(before, after, "cache hit must not rewrite the binary");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test(
  "installBinary downloads, verifies, and caches icm-relayer (real network)",
  { skip: skipNetwork ? "ICM_INSTALLER_SKIP_NETWORK=1" : false, timeout: 120_000 },
  async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "icm-cache-miss-"));
    try {
      // Cache miss: full download path.
      const t0 = Date.now();
      const installed = await installBinary("icm-relayer", { cacheDir });
      const tMiss = Date.now() - t0;

      assert.equal(
        installed,
        path.join(cacheDir, "icm-relayer-v1.7.5", "icm-relayer"),
      );

      const s = await stat(installed);
      assert.ok(s.isFile(), "installed path must be a regular file");
      assert.ok(s.size > 1_000_000, `binary suspiciously small: ${s.size} bytes`);

      // The extracted directory should also contain at least a config sample
      // alongside the binary (per ava-labs/icm-services release tarballs).
      const entries = await readdir(path.join(cacheDir, "icm-relayer-v1.7.5"));
      assert.ok(entries.includes("icm-relayer"), `missing binary in: ${entries.join(",")}`);

      // Cache hit: must be substantially faster than the miss and return the
      // same path without touching the network.
      const t1 = Date.now();
      const installed2 = await installBinary("icm-relayer", { cacheDir });
      const tHit = Date.now() - t1;
      assert.equal(installed2, installed);
      assert.ok(tHit < tMiss, `cache hit (${tHit}ms) was not faster than miss (${tMiss}ms)`);

      // Smoke test: --version exits 0.
      const run = spawnSync(installed, ["--version"], { encoding: "utf8" });
      assert.equal(run.status, 0, `icm-relayer --version failed: ${run.stderr}`);
      assert.match(run.stdout + run.stderr, /1\.7\.5/);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
