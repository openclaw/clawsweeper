import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readAllSpooledActionEvents } from "../../dist/action-ledger.js";
import { runExecuteFixAttempt } from "../../dist/repair/execute-fix-attempt.js";
import type { ParsedJob } from "../../dist/repair/lib.js";

test("execute-fix attempt wrapper forwards the exact command exit with bounded receipts", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execute-fix-attempt-")));
  const env = workflowEnv();
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const jobPath = "jobs/openclaw/inbox/cluster-42.md";
  const argv = [jobPath, "--latest", "--defer-publication"];

  try {
    const result = runExecuteFixAttempt(argv, {
      root,
      env,
      executorPath: "/public/repo/dist/repair/execute-fix-artifact.js",
      loadJob: () => repairJob(jobPath),
      execute(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 23, signal: null };
      },
    });

    assert.deepEqual(result, { exitCode: 23, signal: null });
    assert.deepEqual(calls, [
      {
        command: process.execPath,
        args: ["/public/repo/dist/repair/execute-fix-artifact.js", ...argv],
        cwd: root,
      },
    ]);

    const events = readAllSpooledActionEvents(root);
    assert.equal(events.length, 4);
    const [attemptStart, mutationStart, mutationOutcome, attemptOutcome] = events.sort(
      (left, right) => left.phase_seq - right.phase_seq,
    );
    assert.equal(attemptStart?.event_type, "workflow.attempt");
    assert.equal(attemptStart?.action.status, "started");
    assert.equal(mutationStart?.event_type, "repair.execute");
    assert.equal(mutationStart?.attributes?.completion_reason, "mutation_attempted");
    assert.equal(mutationOutcome?.event_type, "repair.execute");
    assert.equal(mutationOutcome?.attributes?.completion_reason, "mutation_outcome_unknown");
    assert.equal(mutationOutcome?.action.retryable, false);
    assert.equal(mutationOutcome?.idempotency_key_sha256, mutationStart?.idempotency_key_sha256);
    assert.equal(attemptOutcome?.event_type, "workflow.attempt");
    assert.equal(attemptOutcome?.parent_event_id, mutationOutcome?.event_id);
    assert.equal(attemptOutcome?.attributes?.completion_reason, "mutation_outcome_unknown");
    assert.equal(attemptOutcome?.action.retryable, false);

    const persisted = JSON.stringify(events);
    assert.doesNotMatch(persisted, /secret repair instructions/);
    assert.doesNotMatch(persisted, /\/private\/|\/Users\//);
    assert.doesNotMatch(persisted, /execute-fix-artifact\.js/);
    assert.match(persisted, /jobs\/openclaw\/inbox\/cluster-42\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execute-fix attempt wrapper records observed success without changing exit zero", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execute-fix-success-")));
  const jobPath = "jobs/openclaw/inbox/cluster-42.md";

  try {
    const result = runExecuteFixAttempt([jobPath, "--latest"], {
      root,
      env: workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "success" }),
      loadJob: () => repairJob(jobPath),
      execute: () => ({ status: 0, signal: null }),
    });

    assert.deepEqual(result, { exitCode: 0, signal: null });
    const events = readAllSpooledActionEvents(root).sort(
      (left, right) => left.phase_seq - right.phase_seq,
    );
    assert.deepEqual(
      events.map((event) => [
        event.event_type,
        event.action.status,
        event.attributes?.completion_reason,
      ]),
      [
        ["workflow.attempt", "started", "workflow_started"],
        ["repair.execute", "started", "mutation_attempted"],
        ["repair.execute", "executed", "mutation_observed"],
        ["workflow.attempt", "completed", "workflow_completed"],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execute-fix attempt wrapper marks a spawn failure as a retryable rejection", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execute-fix-spawn-")));
  const jobPath = "jobs/openclaw/inbox/cluster-42.md";

  try {
    const result = runExecuteFixAttempt([jobPath, "--latest"], {
      root,
      env: workflowEnv({ CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "spawn-failure" }),
      loadJob: () => repairJob(jobPath),
      execute: () => ({
        status: null,
        signal: null,
        error: new Error("spawn failed"),
      }),
    });

    assert.deepEqual(result, { exitCode: 1, signal: null });
    const events = readAllSpooledActionEvents(root).sort(
      (left, right) => left.phase_seq - right.phase_seq,
    );
    assert.equal(events[2]?.attributes?.completion_reason, "mutation_rejected");
    assert.equal(events[2]?.action.mutation, false);
    assert.equal(events[3]?.attributes?.completion_reason, "workflow_failed");
    assert.equal(events[3]?.action.retryable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function repairJob(relativePath: string): ParsedJob {
  return {
    path: `/public/repo/${relativePath}`,
    relativePath,
    raw: [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: cluster-42",
      "mode: execute",
      "---",
      "secret repair instructions",
      "",
    ].join("\n"),
    body: "secret repair instructions",
    frontmatter: {
      repo: "openclaw/openclaw",
      cluster_id: "cluster-42",
      mode: "execute",
      allowed_actions: ["fix"],
      candidates: [],
    },
  };
}

function workflowEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "execute-fix",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-14",
    GITHUB_ACTION: "__run_8",
    GITHUB_JOB: "execute",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "552",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    ...overrides,
  };
}
