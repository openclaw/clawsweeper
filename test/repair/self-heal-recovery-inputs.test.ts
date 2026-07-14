import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("self-heal replays recovered runners and preserves a plan-only downgrade", () => {
  const fixture = createRecoveryFixture("self-heal");
  try {
    const result = runFixture(fixture, [
      "self-heal-failed-runs.js",
      "--max-age-hours",
      "24",
      "--mode",
      "autonomous",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.candidates.length, 1);
    assert.deepEqual(
      {
        mode: summary.candidates[0].mode,
        runner: summary.candidates[0].runner,
        execution_runner: summary.candidates[0].execution_runner,
        planner_sandbox: summary.candidates[0].planner_sandbox,
        model: summary.candidates[0].model,
        dry_run: summary.candidates[0].dry_run,
      },
      {
        mode: "plan",
        runner: "original-runner",
        execution_runner: "original-execution-runner",
        planner_sandbox: "read-only",
        model: "original-model",
        dry_run: false,
      },
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("direct requeue cannot promote a recovered plan-only run", () => {
  const fixture = createRecoveryFixture("requeue");
  try {
    const result = runFixture(fixture, ["requeue-job.js", fixture.runId, "--mode", "autonomous"]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(
      {
        mode: summary.mode,
        runner: summary.runner,
        execution_runner: summary.execution_runner,
        planner_sandbox: summary.planner_sandbox,
        model: summary.model,
        dry_run: summary.dry_run,
      },
      {
        mode: "plan",
        runner: "original-runner",
        execution_runner: "original-execution-runner",
        planner_sandbox: "read-only",
        model: "original-model",
        dry_run: false,
      },
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("snapshot-less self-heal remains plan-only", () => {
  const fixture = createRecoveryFixture("snapshot-less", { snapshot: false });
  try {
    const result = runFixture(fixture, [
      "self-heal-failed-runs.js",
      "--max-age-hours",
      "24",
      "--mode",
      "autonomous",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].mode, "plan");
    assert.equal(summary.candidates[0].dry_run, true);
  } finally {
    cleanupFixture(fixture);
  }
});

test("snapshot-less direct requeue remains dry", () => {
  const fixture = createRecoveryFixture("snapshot-less-requeue", { snapshot: false });
  try {
    const result = runFixture(fixture, ["requeue-job.js", fixture.runId, "--mode", "autonomous"]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, "plan");
    assert.equal(summary.dry_run, true);
  } finally {
    cleanupFixture(fixture);
  }
});

test("direct requeue recovers historical worker-only artifact cohorts", () => {
  const fixture = createRecoveryFixture("legacy-worker", {
    snapshot: false,
    runRecord: false,
    legacyWorker: true,
  });
  try {
    const result = runFixture(fixture, ["requeue-job.js", fixture.runId, "--mode", "autonomous"]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_job, "jobs/test/inbox/recovery.md");
    assert.equal(summary.mode, "plan");
    assert.equal(summary.dry_run, true);
  } finally {
    cleanupFixture(fixture);
  }
});

test("self-heal backfills quota after a newer invalid candidate", () => {
  const fixture = createRecoveryFixture("quota-backfill");
  try {
    fs.writeFileSync(
      path.join(fixture.root, "results", "runs", "910002.json"),
      `${JSON.stringify({
        run_id: "910002",
        source_job: "jobs/test/inbox/missing.md",
        workflow_conclusion: "failure",
        workflow_updated_at: new Date().toISOString(),
        mode: "autonomous",
      })}\n`,
    );

    const result = runFixture(fixture, [
      "self-heal-failed-runs.js",
      "--max-age-hours",
      "24",
      "--max-jobs",
      "1",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_run_id, fixture.runId);
    assert.equal(summary.skipped_candidates[0].reason, "missing_job_file");
  } finally {
    cleanupFixture(fixture);
  }
});

test("self-heal writes and publishes dispatch attempts before legacy summaries", () => {
  const source = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");
  const setupAction = fs.readFileSync(".github/actions/setup-action-ledger/action.yml", "utf8");
  const workflow = fs.readFileSync(".github/workflows/repair-self-heal.yml", "utf8");
  const dispatchStart = source.indexOf("function dispatchCandidate(");
  const dispatchEnd = source.indexOf("function waitForStartedRuns(", dispatchStart);
  const dispatchFunction = source.slice(dispatchStart, dispatchEnd);

  assert.ok(dispatchStart >= 0);
  assert.ok(dispatchEnd > dispatchStart);
  assert.match(dispatchFunction, /runDispatchWithReceiptSync\(\{/);
  assert.match(dispatchFunction, /operation: \(\) =>\s+spawnSync\(/);
  assert.match(dispatchFunction, /outcome: dispatchProcessOutcome/);
  assert.match(dispatchFunction, /operationKey: `self-heal:/);
  assert.match(dispatchFunction, /dispatchInput: \{[\s\S]*?requeue_depth:/);
  assert.match(
    source,
    /await flushDispatchActionEvents\(dispatchReceiptContext\.root,[\s\S]*?outputRoot: dispatchReceiptContext\.outputRoot/,
  );
  assert.match(source, /appendAttempts\(ledger, attempts\)/);
  assert.match(setupAction, /ACTION_LEDGER_WORKTREE_PATH: \$\{\{ inputs\.worktree-path \}\}/);
  assert.match(setupAction, /worktree path must be workspace-relative/);
  assert.match(setupAction, /workspace_root="\$\(pwd -P\)"/);
  assert.match(setupAction, /ledger_root="\$\(cd "\$worktree_path" && pwd -P\)"/);
  assert.match(setupAction, /"\$workspace_root"\|"\$workspace_root"\/\*/);
  assert.match(setupAction, /worktree path escapes the workspace/);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_ROOT=\$ledger_root/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /--lane self-heal-dispatch/);
  assert.match(workflow, /--message "chore: append self-heal dispatch action ledger"/);
});

test("executing self-heal uses durable local dispatch receipts outside Actions", () => {
  const fixture = createRecoveryFixture("local-execute");
  try {
    const result = runFixture(fixture, [
      "self-heal-failed-runs.js",
      "--max-age-hours",
      "24",
      "--max-jobs",
      "1",
      "--execute",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const ghCalls = fs.readFileSync(fixture.ghLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(ghCalls.some((line) => line.startsWith("workflow run repair-cluster-worker.yml")));
    const receiptPaths = fs
      .readdirSync(fixture.localReceiptRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"));
    assert.ok(receiptPaths.length > 0);
    const receipts = receiptPaths.flatMap((entry) =>
      fs
        .readFileSync(path.join(fixture.localReceiptRoot, entry), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    assert.deepEqual(
      receipts.map((event) => event.attributes.completion_reason),
      ["dispatch_attempted", "dispatch_accepted"],
    );
    assert.equal(receipts[0]?.producer.workflow, "local-dispatch");
  } finally {
    cleanupFixture(fixture);
  }
});

test("executing self-heal accepts canonical setup-action-ledger Actions context", () => {
  const fixture = createRecoveryFixture("actions-execute");
  const outputRoot = path.join(fixture.root, "actions-ledger-output");
  fs.mkdirSync(outputRoot);
  try {
    const result = runFixture(
      fixture,
      ["self-heal-failed-runs.js", "--max-age-hours", "24", "--max-jobs", "1", "--execute"],
      {
        GITHUB_ACTIONS: "true",
        CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
        CLAWSWEEPER_ACTION_LEDGER_ROOT: fs.realpathSync(fixture.root),
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: fs.realpathSync(outputRoot),
        CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "actions-self-heal",
        GITHUB_WORKFLOW: "repair self-heal failed clusters",
        GITHUB_WORKFLOW_REF:
          "openclaw/clawsweeper/.github/workflows/repair-self-heal.yml@refs/heads/main",
        GITHUB_JOB: "self-heal",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_STARTED_AT: "2026-07-14T12:00:00Z",
        GITHUB_ACTION: "self-heal-failed-runs",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receiptPaths = fs
      .readdirSync(outputRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"));
    assert.ok(receiptPaths.length > 0);
    const receipts = receiptPaths.flatMap((entry) =>
      fs
        .readFileSync(path.join(outputRoot, entry), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    assert.deepEqual(
      receipts.map((event) => event.attributes.completion_reason),
      ["dispatch_attempted", "dispatch_accepted"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

function createRecoveryFixture(
  label: string,
  options: { snapshot?: boolean; runRecord?: boolean; legacyWorker?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-${label}-recovery-`));
  fs.cpSync("dist", path.join(root, "dist"), { recursive: true });
  fs.cpSync("config", path.join(root, "config"), { recursive: true });

  const sourceJob = "jobs/test/inbox/recovery.md";
  const jobPath = path.join(root, sourceJob);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(
    jobPath,
    `---
repo: openclaw/openclaw
cluster_id: recovery
mode: autonomous
allowed_actions:
  - fix
candidates:
  - "#1"
---

# recovery fixture
`,
  );

  const runId = "910001";
  const runsDir = path.join(root, "results", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  if (options.runRecord !== false) {
    fs.writeFileSync(
      path.join(runsDir, `${runId}.json`),
      `${JSON.stringify({
        run_id: runId,
        source_job: sourceJob,
        workflow_conclusion: "failure",
        workflow_updated_at: new Date().toISOString(),
        mode: "autonomous",
      })}\n`,
    );
  }

  const recoveredInputs = {
    schema_version: 1,
    source_job: sourceJob,
    source_dispatch_key: "original-dispatch",
    requested_mode: "autonomous",
    effective_mode: "plan",
    runner: "original-runner",
    execution_runner: "original-execution-runner",
    planner_sandbox: "read-only",
    model: "original-model",
    dry_run: false,
    requeue: false,
    requeue_depth: 0,
  };
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  const ghLog = path.join(root, "gh.log");
  const localReceiptRoot = path.join(root, "local-dispatch-receipts");
  writeFakeGh(binDir, {
    recoveredInputs: options.snapshot === false ? null : recoveredInputs,
    legacyWorker: options.legacyWorker === true ? { runId, sourceJob } : null,
  });
  writeFakeGit(binDir);
  return { root, binDir, runId, ghLog, localReceiptRoot };
}

function runFixture(
  fixture: ReturnType<typeof createRecoveryFixture>,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  const [script, ...scriptArgs] = args;
  const env = {
    ...process.env,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAWSWEEPER_REPO: "openclaw/clawsweeper",
    CLAWSWEEPER_WORKER_RUNNER: "current-default-runner",
    CLAWSWEEPER_EXECUTION_RUNNER: "current-default-execution-runner",
    CLAWSWEEPER_ACTION_LEDGER_LOCAL_ROOT: fixture.localReceiptRoot,
    CLAWSWEEPER_TEST_GH_LOG: fixture.ghLog,
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_SHA: "d".repeat(40),
  };
  for (const name of [
    "GITHUB_ACTIONS",
    "CLAWSWEEPER_ACTION_LEDGER_FORCE",
    "CLAWSWEEPER_ACTION_LEDGER_ROOT",
    "CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT",
    "CLAWSWEEPER_ACTION_LEDGER_INVOCATION",
    "CLAWSWEEPER_ACTION_LEDGER_DISABLED",
  ]) {
    delete env[name];
  }
  Object.assign(env, envOverrides);
  return spawnSync(
    process.execPath,
    [path.join(fixture.root, "dist", "repair", script!), ...scriptArgs],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env,
    },
  );
}

function cleanupFixture(fixture: ReturnType<typeof createRecoveryFixture>) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function writeFakeGh(
  binDir: string,
  {
    recoveredInputs,
    legacyWorker,
  }: {
    recoveredInputs: Record<string, unknown> | null;
    legacyWorker: { runId: string; sourceJob: string } | null;
  },
) {
  const file = path.join(binDir, "gh");
  fs.writeFileSync(
    file,
    `#!/bin/sh
set -eu
if [ -n "\${CLAWSWEEPER_TEST_GH_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$CLAWSWEEPER_TEST_GH_LOG"
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  output_dir=""
  pattern=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--dir" ]; then
      output_dir="$argument"
    fi
    if [ "$previous" = "--pattern" ]; then
      pattern="$argument"
    fi
    previous="$argument"
  done
  ${
    recoveredInputs
      ? `case "$pattern" in
    clawsweeper-repair-inputs-*)
      artifact_dir="$output_dir/recovery-inputs"
      mkdir -p "$artifact_dir"
      cat > "$artifact_dir/workflow-inputs.json" <<'JSON'
${JSON.stringify(recoveredInputs)}
JSON
      exit 0
      ;;
  esac`
      : ""
  }
  ${
    legacyWorker
      ? `if [ "$pattern" = "clawsweeper-repair-worker-${legacyWorker.runId}-*" ]; then
    artifact_dir="$output_dir/clawsweeper-repair-worker-${legacyWorker.runId}-2/run"
    mkdir -p "$artifact_dir"
    cat > "$artifact_dir/cluster-plan.json" <<'JSON'
${JSON.stringify({ source_job: legacyWorker.sourceJob, mode: "autonomous" })}
JSON
    cat > "$artifact_dir/result.json" <<'JSON'
${JSON.stringify({ mode: "autonomous" })}
JSON
    exit 0
  fi`
      : ""
  }
  echo "no valid artifacts found to download" >&2
  exit 1
fi
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  exit 0
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`,
  );
  fs.chmodSync(file, 0o755);
}

function writeFakeGit(binDir: string) {
  const file = path.join(binDir, "git");
  fs.writeFileSync(
    file,
    `#!/bin/sh
set -eu
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' '${"d".repeat(40)}'
  exit 0
fi
echo "unsupported git invocation: $*" >&2
exit 1
`,
  );
  fs.chmodSync(file, 0o755);
}
