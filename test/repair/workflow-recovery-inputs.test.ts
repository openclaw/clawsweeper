import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  boundedRecoveryTimeoutMs,
  isRepairWorkflowArtifactUnavailable,
  parseRepairWorkflowRecoveryInputs,
  readNewestRepairLegacyRecoveryInputs,
  readNewestRepairWorkflowRecoveryInputs,
  resolveRepairWorkflowRetryMode,
} from "../../dist/repair/workflow-recovery-inputs.js";

const base = {
  schema_version: 1,
  source_job: "jobs/openclaw/inbox/cluster-42.md",
  source_dispatch_key: "command-42",
  requested_mode: "autonomous",
  effective_mode: "plan",
  runner: "blacksmith-4vcpu-ubuntu-2404",
  execution_runner: "blacksmith-16vcpu-ubuntu-2404",
  planner_sandbox: "read-only",
  model: "internal",
  dry_run: false,
  requeue: false,
  requeue_depth: 0,
} as const;
const legacyBase = {
  schema_version: 1,
  source_job: base.source_job,
  state_revision: "a".repeat(40),
  job_sha256: "b".repeat(64),
  requested_mode: "autonomous",
  effective_mode: "plan",
} as const;

test("recovery timeouts cannot exceed the shared deadline", () => {
  assert.equal(
    boundedRecoveryTimeoutMs({
      deadlineMs: 10_000,
      nowMs: 2_000,
      maxTimeoutMs: 3_000,
    }),
    3_000,
  );
  assert.equal(
    boundedRecoveryTimeoutMs({
      deadlineMs: 10_000,
      nowMs: 9_500,
      maxTimeoutMs: 3_000,
    }),
    500,
  );
  assert.equal(
    boundedRecoveryTimeoutMs({
      deadlineMs: 10_000,
      nowMs: 10_001,
      maxTimeoutMs: 3_000,
    }),
    0,
  );
});

test("immutable workflow inputs accept only the exact bounded replay contract", () => {
  assert.deepEqual(parseRepairWorkflowRecoveryInputs(base), base);
  assert.deepEqual(parseRepairWorkflowRecoveryInputs(legacyBase), legacyBase);
  assert.throws(
    () => parseRepairWorkflowRecoveryInputs({ ...base, extra: true }),
    /unexpected fields/,
  );
  assert.throws(
    () => parseRepairWorkflowRecoveryInputs({ ...base, source_job: "jobs/../private.md" }),
    /invalid source job/,
  );
  assert.throws(
    () =>
      parseRepairWorkflowRecoveryInputs({
        ...base,
        requested_mode: "plan",
        effective_mode: "execute",
      }),
    /invalid effective mode/,
  );
  assert.throws(
    () => parseRepairWorkflowRecoveryInputs({ ...base, requeue: true }),
    /invalid bounded requeue state/,
  );
});

test("immutable workflow input recovery selects the newest complete attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-inputs-"));
  try {
    writeInputs(root, "910001", 1, base);
    writeInputs(root, "910001", 2, {
      ...base,
      runner: "new-runner",
      requeue: true,
      requeue_depth: 1,
    });

    const recovered = readNewestRepairWorkflowRecoveryInputs(root, "910001");
    assert.equal(recovered?.runner, "new-runner");
    assert.equal(recovered?.requeue_depth, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable workflow input recovery accepts direct single-artifact extraction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-direct-"));
  try {
    const inputRoot = path.join(root, "recovery-inputs");
    fs.mkdirSync(inputRoot);
    fs.writeFileSync(path.join(inputRoot, "workflow-inputs.json"), `${JSON.stringify(base)}\n`);

    assert.deepEqual(readNewestRepairWorkflowRecoveryInputs(root, "910005"), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable workflow input recovery fails closed on an ambiguous newest attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-ambiguous-"));
  try {
    const attemptRoot = writeInputs(root, "910002", 2, base);
    const duplicate = path.join(attemptRoot, "duplicate");
    fs.mkdirSync(duplicate);
    fs.writeFileSync(path.join(duplicate, "workflow-inputs.json"), `${JSON.stringify(base)}\n`);

    assert.throws(
      () => readNewestRepairWorkflowRecoveryInputs(root, "910002"),
      /exactly one immutable input snapshot/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable workflow input fallback distinguishes absence from transient failure", () => {
  assert.equal(
    isRepairWorkflowArtifactUnavailable("no valid artifacts found to download", ""),
    true,
  );
  assert.equal(isRepairWorkflowArtifactUnavailable("HTTP 404", ""), true);
  assert.equal(isRepairWorkflowArtifactUnavailable("secondary rate limit", ""), false);
  assert.equal(isRepairWorkflowArtifactUnavailable("authentication failed", ""), false);
});

test("legacy recovery selects one newest complete producer attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-legacy-recovery-"));
  try {
    writeLegacyCohort(root, "910003", 1, "plan");
    writeLegacyCohort(root, "910003", 2, "autonomous");

    assert.deepEqual(readNewestRepairLegacyRecoveryInputs(root, "910003"), {
      source_job: base.source_job,
      mode: "autonomous",
      producer_attempt: 2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy recovery never combines plan and result from different attempts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-legacy-split-"));
  try {
    const planRoot = legacyRunRoot(root, "910004", 1);
    const resultRoot = legacyRunRoot(root, "910004", 2);
    fs.mkdirSync(planRoot, { recursive: true });
    fs.mkdirSync(resultRoot, { recursive: true });
    fs.writeFileSync(
      path.join(planRoot, "cluster-plan.json"),
      `${JSON.stringify({ source_job: base.source_job, mode: "autonomous" })}\n`,
    );
    fs.writeFileSync(path.join(resultRoot, "result.json"), '{"mode":"autonomous"}\n');

    assert.equal(readNewestRepairLegacyRecoveryInputs(root, "910004"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable retry mode never promotes a recovered plan downgrade", () => {
  assert.equal(
    resolveRepairWorkflowRetryMode({
      requestedMode: "autonomous",
      recoveredMode: "plan",
      fallbackMode: "autonomous",
    }),
    "plan",
  );
  assert.equal(
    resolveRepairWorkflowRetryMode({
      requestedMode: "plan",
      recoveredMode: "autonomous",
      fallbackMode: "autonomous",
    }),
    "plan",
  );
});

test("repair retries reuse immutable Action inputs without restoring lifecycle machinery", () => {
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const selfHealWorkflow = readText(".github/workflows/repair-self-heal.yml");
  const requeue = readText("src/repair/requeue-job.ts");
  const selfHeal = readText("src/repair/self-heal-failed-runs.ts");
  const persistIndex = workflow.indexOf("- name: Persist immutable recovery inputs");
  const uploadIndex = workflow.indexOf("- name: Upload immutable recovery inputs");
  const tokenIndex = workflow.indexOf("- name: Create GitHub App token");
  const setupIndex = workflow.indexOf("- uses: ./.github/actions/setup-pnpm");

  assert.ok(persistIndex >= 0);
  assert.ok(uploadIndex > persistIndex);
  assert.ok(tokenIndex > uploadIndex);
  assert.ok(setupIndex > uploadIndex);
  assert.match(workflow.slice(uploadIndex, tokenIndex), /include-hidden-files: true/);
  for (const field of [
    "source_job",
    "source_dispatch_key",
    "requested_mode",
    "effective_mode",
    "runner",
    "execution_runner",
    "planner_sandbox",
    "model",
    "dry_run",
    "requeue",
    "requeue_depth",
  ]) {
    assert.match(workflow, new RegExp(`${field}:`));
  }
  assert.match(
    workflow,
    /effective_mode: \$\{\{ steps\.recovery_inputs\.outputs\.effective_mode \}\}/,
  );
  assert.match(workflow, /needs\.cluster\.outputs\.effective_mode == 'execute'/);
  assert.match(
    workflow,
    /args=\("\$\{\{ inputs\.job \}\}" --mode "\$worker_mode" --model "\$\{\{ inputs\.model \}\}"\)/,
  );
  assert.match(requeue, /readNewestRepairWorkflowRecoveryInputs\(recoveryDir, runId\)/);
  assert.match(requeue, /recoveredInputs\?\.requeue_depth \?\? 0/);
  assert.match(requeue, /timeout: WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS/);
  assert.match(
    requeue,
    /if \(!dryRun && openExecuteWindow && \["execute", "autonomous"\]\.includes\(mode\)\)/,
  );
  assert.match(requeue, /assertGateOpenIfNeeded\(mode, dryRun\)/);
  assert.match(requeue, /function assertGateOpenIfNeeded\(mode: string, isDryRun: boolean\)/);
  assert.match(requeue, /if \(isDryRun\) return/);
  assert.match(requeue, /`planner_sandbox=\$\{dispatchInput\.planner_sandbox\}`/);
  assert.match(requeue, /`dry_run=\$\{dispatchInput\.dry_run\}`/);
  assert.match(requeue, /identity: dispatchInput/);
  assert.match(
    selfHeal,
    /const boundedEligible = eligible\.slice\(0, MAX_RECOVERY_CANDIDATE_SCANS\)/,
  );
  assert.match(selfHeal, /const recoveryDeadlineMs = Date\.now\(\) \+ RECOVERY_SCAN_BUDGET_MS/);
  assert.match(selfHeal, /boundedRecoveryTimeoutMs\(\{/);
  assert.match(selfHeal, /reason: "recovery_budget_exhausted"/);
  assert.match(selfHeal, /recoverWorkflowInputs\(record, recoveryTimeoutMs\)/);
  assert.match(selfHeal, /for \(const record of boundedEligible\)/);
  assert.match(selfHeal, /if \(selected\.length >= maxJobs\) break/);
  assert.match(selfHeal, /timeout: timeoutMs/);
  assert.match(selfHeal, /"--pattern",\s*`clawsweeper-repair-inputs-\$\{runId\}-\*`/);
  assert.match(requeue, /`clawsweeper-repair-inputs-\$\{runId\}-\*`/);
  assert.match(requeue, /`clawsweeper-repair-\$\{runId\}-\*`/);
  assert.match(requeue, /`clawsweeper-repair-worker-\$\{runId\}-\*`/);
  assert.match(selfHeal, /recordSortKey === currentSortKey && record\.live_run_record === true/);
  assert.match(selfHeal, /candidate\.dry_run !== true/);
  assert.match(selfHeal, /`planner_sandbox=\$\{candidate\.planner_sandbox\}`/);
  assert.match(selfHeal, /`requeue_depth=\$\{candidate\.requeue_depth\}`/);
  assert.match(
    selfHealWorkflow,
    /if \[ "\$\{\{ github\.event_name \}\}" = "workflow_dispatch" \]; then[\s\S]*args\+=\(--runner/,
  );
});

function writeInputs(
  root: string,
  runId: string,
  attempt: number,
  value: Record<string, unknown>,
): string {
  const attemptRoot = path.join(root, `clawsweeper-repair-inputs-${runId}-${attempt}`);
  const inputRoot = path.join(attemptRoot, "recovery-inputs");
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.writeFileSync(
    path.join(inputRoot, "workflow-inputs.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  return attemptRoot;
}

function writeLegacyCohort(
  root: string,
  runId: string,
  attempt: number,
  mode: "plan" | "autonomous",
) {
  const runRoot = legacyRunRoot(root, runId, attempt);
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(
    path.join(runRoot, "cluster-plan.json"),
    `${JSON.stringify({ source_job: base.source_job, mode })}\n`,
  );
  fs.writeFileSync(path.join(runRoot, "result.json"), `${JSON.stringify({ mode })}\n`);
}

function legacyRunRoot(root: string, runId: string, attempt: number) {
  return path.join(root, `clawsweeper-repair-${runId}-${attempt}`, "run");
}

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}
