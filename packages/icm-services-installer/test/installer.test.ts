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

import {
  ICM_RELAYER_VERSION,
  SIGNATURE_AGGREGATOR_VERSION,
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
import { findChecksum } from "../src/download.ts";

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

test("binaryPath is pure and reflects cacheDir", () => {
  const p = binaryPath("icm-relayer", { cacheDir: "/tmp/foo" });
  assert.equal(p, "/tmp/foo/icm-relayer-v1.7.5/icm-relayer");
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
