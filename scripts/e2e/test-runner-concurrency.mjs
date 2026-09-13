import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runner = resolve("scripts/run-node-tests.mjs");
const fixture = mkdtempSync(join(tmpdir(), "test-runner-concurrency-proof-"));
const observations = [];
try {
  mkdirSync(join(fixture, "test"));
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(fixture, "test", "fixture.test.ts"),
    'import test from "node:test"; test("fixture", () => console.log("FIXTURE_EXECUTED"));\n',
  );
  for (const [label, value, args, concurrency, exitCode] of [
    ["environment", "8", [], 8, 0],
    ["cli-precedence", "invalid", ["--test-concurrency", "2"], 2, 0],
    ["invalid-environment", "0", [], null, 1],
  ]) {
    const result = spawnSync(process.execPath, [runner, "unit", ...args], {
      cwd: fixture,
      env: { ...process.env, CLAWSWEEPER_TEST_CONCURRENCY: value },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, exitCode, result.stderr);
    if (concurrency !== null) {
      assert.match(result.stderr, new RegExp(`target=unit concurrency=${concurrency} files=1`));
      assert.match(result.stdout, /FIXTURE_EXECUTED/);
    } else {
      assert.match(result.stderr, /CLAWSWEEPER_TEST_CONCURRENCY must be a positive integer/);
      assert.doesNotMatch(result.stdout, /FIXTURE_EXECUTED/);
    }
    observations.push({ label, concurrency, exit_code: result.status });
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        source_sha256: createHash("sha256").update(readFileSync(runner)).digest("hex"),
        observations,
        result: "passed",
        limits:
          "Real CLI and native Node test child processes on synthetic files; full-suite performance is measured separately.",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
