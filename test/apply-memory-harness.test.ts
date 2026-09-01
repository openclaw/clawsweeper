import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertMemoryProcessOutcome } from "../scripts/e2e/apply-memory.mjs";

const harness = new URL("../scripts/e2e/apply-memory.mjs", import.meta.url);

test("memory proof subprocess rejects candidate OOM and only accepts explicitly expected baseline OOM", () => {
  const oom = { status: null, signal: "SIGABRT", stderr: "FATAL ERROR: heap out of memory" };
  for (const expectBaselineOom of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `import { assertMemoryProcessOutcome } from ${JSON.stringify(harness.href)};`,
          `assertMemoryProcessOutcome(${JSON.stringify(oom)}, ${JSON.stringify({ expectBaselineOom })});`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectBaselineOom ? 0 : 1, result.stderr);
    if (!expectBaselineOom) assert.match(result.stderr, /candidate process failed: SIGABRT/);
  }
});

test("baseline OOM mode rejects success, other failures, and timeouts", () => {
  for (const result of [
    { status: 0, signal: null, stderr: "" },
    { status: 1, signal: null, stderr: "heap out of memory" },
    { status: null, signal: "SIGABRT", stderr: "ordinary abort" },
    { status: null, signal: "SIGTERM", stderr: "heap out of memory" },
    { status: null, signal: "SIGABRT", stderr: "heap out of memory", error: new Error("timeout") },
  ]) {
    assert.throws(() => assertMemoryProcessOutcome(result, { expectBaselineOom: true }));
  }
  assert.equal(assertMemoryProcessOutcome({ status: 0, signal: null }), false);
  assert.equal(
    assertMemoryProcessOutcome({ status: 1, signal: null }, { expectedStatus: 1 }),
    false,
  );
  assert.throws(() => assertMemoryProcessOutcome({ status: 1, signal: null }));
});

test("memory proof refuses unowned corpus without changing numeric or unrelated sentinels", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-memory-sentinel-"));
  try {
    const corpus = join(root, "corpus");
    mkdirSync(join(corpus, "items"), { recursive: true });
    const numericSentinel = join(corpus, "items", "100000.md");
    const otherSentinel = join(corpus, "keep.txt");
    writeFileSync(numericSentinel, "unowned numeric record\n");
    writeFileSync(otherSentinel, "unrelated artifact\n");
    for (const manifest of [
      undefined,
      "not json",
      JSON.stringify({ open: 5500, archived: 12000, bytesPerRecord: 32768 }),
    ]) {
      if (manifest !== undefined) writeFileSync(join(corpus, "manifest.json"), manifest);
      const before = readdirSync(corpus, { recursive: true });
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(harness), root, ".", "sentinel", "empty"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /refusing unowned corpus|invalid manifest|SyntaxError/);
      assert.deepEqual(readdirSync(corpus, { recursive: true }), before);
      assert.equal(readFileSync(numericSentinel, "utf8"), "unowned numeric record\n");
      assert.equal(readFileSync(otherSentinel, "utf8"), "unrelated artifact\n");
      if (manifest !== undefined)
        assert.equal(readFileSync(join(corpus, "manifest.json"), "utf8"), manifest);
      assert.deepEqual(readdirSync(root), ["corpus"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "memory proof refuses a dangling corpus symlink before creating its target",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-memory-symlink-"));
    try {
      symlinkSync(join(root, "missing"), join(root, "corpus"), "dir");
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(harness), root, ".", "symlink", "empty"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /refusing unowned corpus path/);
      assert.deepEqual(readdirSync(root), ["corpus"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
