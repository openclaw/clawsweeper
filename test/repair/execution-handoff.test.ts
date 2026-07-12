import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareExecutionAuthorization,
  sealExecutionHandoff,
  verifyExecutionHandoff,
  verifyValidationReceipt,
} from "../../dist/repair/execution-handoff.js";

test("execution authorization selects one explicit run and seals its immutable identity", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    assert.equal(authorization.target_repo, "openclaw/example");
    assert.equal(fs.existsSync(path.join(fixture.outputRoot, "run", "result.json")), true);

    fs.writeFileSync(
      path.join(fixture.outputRoot, "run", "fix-execution-report.json"),
      `${JSON.stringify({
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/example/pull/42",
          },
        ],
      })}\n`,
    );
    const manifest = sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "success",
    });
    assert.equal(manifest.mutation_ready, true);
    assert.equal(
      verifyExecutionHandoff(fixture.outputRoot, authorization.identity_sha256).tree_sha256,
      manifest.tree_sha256,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects extra run directories", () => {
  const fixture = handoffFixture();
  try {
    fs.mkdirSync(path.join(fixture.runsRoot, "attacker-run"));
    fs.writeFileSync(path.join(fixture.runsRoot, "attacker-run", "result.json"), "{}\n");
    assert.throws(
      () => prepareAuthorization(fixture),
      /must contain exactly one run directory; found 2/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects a worker result for another repository", () => {
  const fixture = handoffFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.runsRoot, "trusted-run", "result.json"),
      `${JSON.stringify({
        repo: "openclaw/attacker-selected",
        cluster_id: "handoff-test",
        mode: "autonomous",
        actions: [],
      })}\n`,
    );
    assert.throws(
      () => prepareAuthorization(fixture),
      /worker result repo does not match the immutable job/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects symlinked handoff content", () => {
  const fixture = handoffFixture();
  try {
    fs.symlinkSync(
      path.join(fixture.runsRoot, "trusted-run", "result.json"),
      path.join(fixture.runsRoot, "trusted-run", "linked-result.json"),
    );
    assert.throws(() => prepareAuthorization(fixture), /handoff contains symlink/);
  } finally {
    fixture.cleanup();
  }
});

test("sealed execution rejects an unexpected top-level run path", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "success",
    });
    fs.mkdirSync(path.join(fixture.outputRoot, "attacker-run"));
    assert.throws(
      () => verifyExecutionHandoff(fixture.outputRoot, authorization.identity_sha256),
      /unexpected top-level entries: attacker-run/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("sealed execution rejects post-seal result and report tampering", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "success",
    });
    fs.appendFileSync(path.join(fixture.outputRoot, "run", "result.json"), "\n");
    assert.throws(
      () => verifyExecutionHandoff(fixture.outputRoot, authorization.identity_sha256),
      /job or result digest changed/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("sealed execution rejects a digest from another pre-execution identity", () => {
  const fixture = handoffFixture();
  try {
    prepareAuthorization(fixture);
    assert.throws(
      () =>
        sealExecutionHandoff({
          root: fixture.outputRoot,
          expectedAuthorizationSha256: "b".repeat(64),
          executeOutcome: "success",
        }),
      /digest does not match trusted pre-execution identity/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("report-only execution cannot become mutation-ready", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    fs.writeFileSync(
      path.join(fixture.outputRoot, "run", "fix-execution-report.json"),
      `${JSON.stringify({
        actions: [{ action: "open_fix_pr", status: "opened" }],
      })}\n`,
    );
    const manifest = sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "failure",
    });
    assert.equal(manifest.mutation_ready, false);
    assert.throws(
      () =>
        verifyValidationReceipt({
          root: fixture.outputRoot,
          receiptPath: path.join(fixture.outputRoot, "attacker-receipt.json"),
          expectedAuthorizationSha256: authorization.identity_sha256,
          expectedReceiptSha256: "c".repeat(64),
        }),
      /report-only execution cannot authorize privileged mutation/,
    );
  } finally {
    fixture.cleanup();
  }
});

function prepareAuthorization(fixture: ReturnType<typeof handoffFixture>) {
  return prepareExecutionAuthorization({
    jobPath: fixture.jobPath,
    runsRoot: fixture.runsRoot,
    outputRoot: fixture.outputRoot,
    workflowRunId: "123456",
    workflowRunAttempt: "2",
    workflowRepository: "openclaw/clawsweeper",
    workflowSha: "a".repeat(40),
    allowedOwner: "openclaw",
  });
}

function handoffFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-handoff-"));
  const jobPath = path.join(
    process.cwd(),
    "jobs",
    "openclaw",
    "inbox",
    `handoff-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const runsRoot = path.join(root, "runs");
  const runDir = path.join(runsRoot, "trusted-run");
  const outputRoot = path.join(root, "authorized");
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/example",
      "cluster_id: handoff-test",
      "mode: autonomous",
      "allowed_actions: [comment, fix, raise_pr]",
      "candidates: [#42]",
      "allow_fix_pr: true",
      "---",
      "fixture",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify({
      repo: "openclaw/example",
      cluster_id: "handoff-test",
      mode: "autonomous",
      actions: [],
    })}\n`,
  );
  return {
    jobPath,
    outputRoot,
    runsRoot,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(jobPath, { force: true });
    },
  };
}
