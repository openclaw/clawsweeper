import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const harness = path.resolve("scripts/proof-scheduled-budget.mjs");
const marker = ".proof-scheduled-budget-output";

// Runs the harness in a scratch checkout with a tool prefix that cannot load,
// so an accepted output directory fails at tool loading, before any deletion.
function runHarness(cwd: string, output: string) {
  return spawnSync(process.execPath, [harness, "HEAD", path.join(cwd, "no-tools"), output], {
    cwd,
    encoding: "utf8",
  });
}

test("scheduled budget proof refuses output directories it could not safely replace", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "proof-scheduled-budget-"));
  try {
    writeFileSync(path.join(cwd, "sentinel"), "keep");
    mkdirSync(path.join(cwd, ".artifacts", "foreign"), { recursive: true });
    writeFileSync(path.join(cwd, ".artifacts", "foreign", "data.json"), "{}");
    for (const output of [".", ".artifacts", "..", "../outside", tmpdir(), ".artifacts/../x"]) {
      const result = runHarness(cwd, output);
      assert.notEqual(result.status, 0, output);
      assert.match(result.stderr, /output directory must be inside/, output);
    }
    const foreign = runHarness(cwd, ".artifacts/foreign");
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /refusing to replace non-empty/);
    assert.ok(existsSync(path.join(cwd, "sentinel")));
    assert.ok(existsSync(path.join(cwd, ".artifacts", "foreign", "data.json")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scheduled budget proof accepts fresh or harness-owned .artifacts subdirectories", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "proof-scheduled-budget-"));
  try {
    mkdirSync(path.join(cwd, ".artifacts", "owned"), { recursive: true });
    writeFileSync(path.join(cwd, ".artifacts", "owned", marker), "");
    writeFileSync(path.join(cwd, ".artifacts", "owned", "result.json"), "{}");
    for (const output of [".artifacts/fresh", ".artifacts/owned"]) {
      const result = runHarness(cwd, output);
      assert.notEqual(result.status, 0, output);
      assert.doesNotMatch(result.stderr, /output directory must be inside|refusing to replace/);
      assert.match(result.stderr, /Cannot find module/, output);
    }
    assert.ok(existsSync(path.join(cwd, ".artifacts", "owned", "result.json")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
