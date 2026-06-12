// Unit tests for sdk/load.ts — loadArtifact({ dir }) and linkLibraries.
// Run via `pnpm --filter tmpnetjs test` (node:test through tsx).

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

import { loadArtifact, linkLibraries } from "../src/sdk/load.js";

const dir = mkdtempSync(join(tmpdir(), "tmpnetjs-load-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// 34 hex chars between __$ ... $__, exactly how solc emits placeholders.
const PLACEHOLDER = "__$1234567890abcdef1234567890abcdef12$__";
const LIB_ADDRESS = "0x00000000000000000000000000000000000000aa" as const;

function writeArtifact(path: string, bytecode: string, linkReferences = {}) {
  writeFileSync(
    path,
    JSON.stringify({
      abi: [],
      bytecode: { object: bytecode, linkReferences },
    }),
  );
}

test("loadArtifact reads a flat <dir>/<name>.json layout", () => {
  writeArtifact(join(dir, "Flat.json"), "0x6001");
  const a = loadArtifact("Flat", { dir });
  assert.equal(a.bytecode, "0x6001");
  assert.equal(a.linkReferences, undefined);
});

test("loadArtifact reads a forge <dir>/<name>.sol/<name>.json layout", () => {
  mkdirSync(join(dir, "Nested.sol"), { recursive: true });
  writeArtifact(join(dir, "Nested.sol", "Nested.json"), "0x6002");
  const a = loadArtifact("Nested", { dir });
  assert.equal(a.bytecode, "0x6002");
});

test("loadArtifact throws a path-specific error when missing", () => {
  assert.throws(() => loadArtifact("Nope", { dir }), /Nope not found under/);
});

test("loadArtifact surfaces linkReferences", () => {
  writeArtifact(join(dir, "Linked.json"), `0x60${PLACEHOLDER}60`, {
    "src/Lib.sol": { Lib: [{ start: 1, length: 20 }] },
  });
  const a = loadArtifact("Linked", { dir });
  assert.ok(a.linkReferences);
  assert.deepEqual(a.linkReferences["src/Lib.sol"]!.Lib, [{ start: 1, length: 20 }]);
});

test("linkLibraries splices the address at every site", () => {
  // bytecode: 1 byte, then a 20-byte placeholder, then 1 byte.
  const artifact = {
    bytecode: `0x60${PLACEHOLDER}60` as `0x${string}`,
    linkReferences: { "src/Lib.sol": { Lib: [{ start: 1, length: 20 }] } },
  };
  const linked = linkLibraries(artifact, { Lib: LIB_ADDRESS });
  assert.equal(linked, `0x60${LIB_ADDRESS.slice(2)}60`);
});

test("linkLibraries accepts file-qualified library keys", () => {
  const artifact = {
    bytecode: `0x${PLACEHOLDER}` as `0x${string}`,
    linkReferences: { "src/Lib.sol": { Lib: [{ start: 0, length: 20 }] } },
  };
  const linked = linkLibraries(artifact, { "src/Lib.sol:Lib": LIB_ADDRESS });
  assert.equal(linked, `0x${LIB_ADDRESS.slice(2)}`);
});

test("linkLibraries throws when a library address is missing", () => {
  const artifact = {
    bytecode: `0x${PLACEHOLDER}` as `0x${string}`,
    linkReferences: { "src/Lib.sol": { Lib: [{ start: 0, length: 20 }] } },
  };
  assert.throws(() => linkLibraries(artifact, {}), /no address provided for library src\/Lib.sol:Lib/);
});

test("linkLibraries throws when placeholders survive (missing linkReferences)", () => {
  const artifact = {
    bytecode: `0x${PLACEHOLDER}` as `0x${string}`,
    linkReferences: {},
  };
  assert.throws(() => linkLibraries(artifact, {}), /unresolved library placeholders/);
});
