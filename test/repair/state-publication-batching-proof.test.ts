import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = "scripts/state-publication-batching-proof.mjs";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

test("state publication batching proof exposes its safety contract", () => {
  const output = execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.match(output, /The source repository is cloned read-only/);
  assert.match(output, /preventing accidental hydration of the live state object store/);
  assert.match(output, /--mode <all\|performance\|e2e>/);
  assert.match(output, /Outputs:/);
  assert.match(output, /Examples:/);
});

test("synthetic batching proof isolates poison items and disables batch admission", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-batching-proof-test-"));
  const output = path.join(root, "report.json");
  try {
    execFileSync(process.execPath, [script, "--mode", "e2e", "--diagnostic", "--output", output], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.passed, true);
    assert.equal(report.runKind, "diagnostic");
    assert.equal(report.e2e.commitCount, 1);
    assert.equal(report.e2e.githubEffects.length, 2);
    assert.deepEqual(
      report.e2e.retryable.map((item: { reason: string }) => item.reason),
      ["invalid_artifact_fixture"],
    );
    assert.deepEqual(report.e2e.disabledFallback, {
      batchClaimed: false,
      legacyReadyItems: ["synthetic/example#3"],
      legacyConsumedItems: ["synthetic/example#3"],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("performance proof anchors a relative local state source before using temp workdirs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-batching-relative-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const output = path.join(root, "report.json");
  try {
    git(root, "init", "--bare", origin);
    git(root, "clone", origin, work);
    git(work, "config", "user.name", "ClawSweeper Proof Test");
    git(work, "config", "user.email", "proof-test@example.com");
    fs.writeFileSync(path.join(work, "fixture.md"), "fixture\n");
    git(work, "add", "fixture.md");
    git(work, "commit", "-m", "fixture");
    git(work, "push", "origin", "HEAD:state");

    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          path.resolve(script),
          "--mode",
          "performance",
          "--state-source",
          "origin.git",
          "--iterations",
          "1",
          "--diagnostic",
          "--output",
          output,
        ],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const rejected = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(rejected.passed, false);
    assert.equal(rejected.performance.realisticTreePassed, false);

    execFileSync(
      process.execPath,
      [
        path.resolve(script),
        "--mode",
        "performance",
        "--state-source",
        "origin.git",
        "--iterations",
        "1",
        "--diagnostic",
        "--minimum-source-paths",
        "1",
        "--output",
        output,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.passed, true);
    assert.equal(report.performance.source, origin);
    assert.equal(report.performance.sourceTreePaths, 1);
    assert.equal(report.performance.minimumSourcePaths, 1);
    assert.equal(report.performance.realisticTreePassed, true);
    assert.equal(report.performance.rolloutFixture.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
