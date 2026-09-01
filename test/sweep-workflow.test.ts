import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";

import { makeTreeReadOnlyForTest, restoreTreeModesForTest } from "../dist/clawsweeper.js";
import {
  readText,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";
import { scheduledReviewSemanticSourceRevision } from "../scripts/classify-scheduled-review-noop.ts";

test("exact review failure annotation follows logical generation and preserves the failure gate", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const failure = workflow.jobs["event-review-apply"].steps.find(
    (entry: { name?: string }) => entry.name === "Fail unsuccessful exact review generation",
  );
  const evaluate = (template: string, values: Record<string, string>) => {
    const expression = template
      .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
      .replace(/\balways\(\)/g, "true")
      .replace(
        /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
        (_match, stepId: string, access: string, output?: string) =>
          JSON.stringify(values[`${stepId}.${output ?? access}`] ?? ""),
      );
    return Function(`"use strict"; return (${expression});`)();
  };
  // Exhaust the independent gate facts; raw process outcome must not override
  // typed deferrals or content failures reported after an exit-zero process.
  for (let mask = 0; mask < 256; mask += 1) {
    const [claimed, accepted, completed, superseded, held, itemSuperseded, generated, deferred] =
      Array.from({ length: 8 }, (_, bit) => Boolean(mask & (1 << bit)));
    if (superseded && held) continue;
    const values = {
      "claim-exact-review-queue.claimed": String(claimed),
      "direct-exact-review-publication.accepted": String(accepted),
      "complete-exact-review-queue.outcome": completed ? "success" : "failure",
      "reserve-exact-review-lease.status": superseded ? "superseded" : held ? "held" : "posted",
      "review-exact-event-item.superseded": String(itemSuperseded),
      "exact-review-generation-result.outcome": generated ? "success" : "failure",
      "exact-review-generation-result.retry_kind": deferred ? "throttle" : "",
    };
    const generationFailed = !generated && !deferred && !held && !superseded;
    const expected =
      claimed && ((!accepted && !completed && !superseded && !itemSuperseded) || generationFailed);
    assert.equal(evaluate(failure.if, values), expected, JSON.stringify(values));
    assert.equal(
      evaluate(failure.env.CLASSIFICATION, values),
      generationFailed ? "codex_or_content_failure" : "queue_completion_failure",
    );
  }
  for (const scenario of [
    {
      name: "completion only",
      generation: "success",
      process: "success",
      retry: "",
      reservation: "posted",
      completion: "failure",
      expected: "queue_completion_failure",
    },
    {
      name: "held deferral",
      generation: "failure",
      process: "skipped",
      retry: "coordination",
      reservation: "held",
      completion: "failure",
      expected: "queue_completion_failure",
    },
    {
      name: "throttle process failure",
      generation: "failure",
      process: "failure",
      retry: "throttle",
      reservation: "posted",
      completion: "failure",
      expected: "queue_completion_failure",
    },
    {
      name: "exit-zero content failure",
      generation: "failure",
      process: "success",
      retry: "",
      reservation: "posted",
      completion: "success",
      expected: "codex_or_content_failure",
    },
    {
      name: "simultaneous failures",
      generation: "failure",
      process: "failure",
      retry: "",
      reservation: "posted",
      completion: "failure",
      expected: "codex_or_content_failure",
    },
  ]) {
    const values = {
      "claim-exact-review-queue.claimed": "true",
      "direct-exact-review-publication.accepted": "false",
      "exact-review-generation-result.outcome": scenario.generation,
      "exact-review-generation-result.retry_kind": scenario.retry,
      "review-exact-event-item.outcome": scenario.process,
      "review-exact-event-item.exit_code": scenario.process === "failure" ? "1" : "0",
      "complete-exact-review-queue.outcome": scenario.completion,
      "reserve-exact-review-lease.status": scenario.reservation,
    };
    assert.equal(evaluate(failure.if, values), true, scenario.name);
    const env = Object.fromEntries(
      Object.entries(failure.env).map(([key, value]) => [
        key,
        String(evaluate(String(value), values)),
      ]),
    );
    const result = spawnSync("bash", ["-c", failure.run], { env, encoding: "utf8" });
    assert.equal(result.status, 1, scenario.name);
    assert.match(result.stdout, new RegExp(`classification=${scenario.expected} `), scenario.name);
    assert.match(
      result.stdout,
      new RegExp(`queue_completion=${scenario.completion}`),
      scenario.name,
    );
  }
});

test("sweep keeps optional media tooling out of review startup", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.doesNotMatch(workflow, /setup-media-proof-tools/);
});

test("exact event review exposes the token-only signal before runtime setup", () => {
  type Step = {
    name?: string;
    uses?: string;
    id?: string;
    "continue-on-error"?: boolean;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["event-review-apply"]!.steps;
  const index = (predicate: (step: Step) => boolean, label: string) => {
    const value = steps.findIndex(predicate);
    assert.notEqual(value, -1, label);
    return value;
  };
  const ordered = [
    [
      "claim-time no-op revalidation",
      index((step) => step.name === "Check live target item state", "live item"),
    ],
    [
      "target write token",
      index((step) => step.name === "Create target write token", "write token"),
    ],
    [
      "eyes reaction",
      index((step) => step.name === "React to target item review start", "reaction"),
    ],
    ["pnpm build", index((step) => step.uses === "./.github/actions/setup-pnpm", "pnpm")],
    [
      "target checkout",
      index((step) => step.name === "Check out target repository", "target checkout"),
    ],
    ["Codex setup", index((step) => step.uses === "./.github/actions/setup-codex", "Codex setup")],
    [
      "OpenClaw setup",
      index((step) => step.uses === "./.github/actions/setup-openclaw", "OpenClaw setup"),
    ],
    [
      "review lease reservation",
      index((step) => step.name === "Reserve exact review lease", "lease"),
    ],
  ] as const;
  for (let position = 1; position < ordered.length; position += 1) {
    assert.ok(
      ordered[position - 1]![1] < ordered[position]![1],
      `${ordered[position - 1]![0]} must precede ${ordered[position]![0]}`,
    );
  }
  assert.equal(steps[ordered[2][1]]!["continue-on-error"], true);
  assert.equal(steps[ordered[7][1]]!.id, "reserve-exact-review-lease");
});

test("OpenClaw review jobs provision the pinned sibling Codex source before review", () => {
  type Step = {
    name?: string;
    uses?: string;
    with?: Record<string, string>;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  for (const scenario of [
    {
      job: "event-review-apply",
      action: "./.github/actions/setup-openclaw-codex-source",
      targetRepo: "${{ steps.target.outputs.target_repo }}",
      targetDir: "${{ steps.target.outputs.target_checkout_dir }}",
      artifactDir: "${{ github.workspace }}/artifacts/event",
      reviewStep: "Review exact event item",
    },
    {
      job: "review",
      action: "./clawsweeper/.github/actions/setup-openclaw-codex-source",
      targetRepo: "${{ needs.plan.outputs.target_repo }}",
      targetDir: "${{ needs.plan.outputs.target_checkout_dir }}",
      artifactDir: "${{ github.workspace }}/review-artifacts/shard-${{ matrix.shard }}",
      reviewStep: "Review shard",
    },
  ] as const) {
    const steps = workflow.jobs[scenario.job]!.steps;
    const targetCheckout = steps.findIndex((step) => step.name === "Check out target repository");
    const sourceCheckout = steps.findIndex((step) => step.uses === scenario.action);
    const review = steps.findIndex((step) => step.name === scenario.reviewStep);

    assert.notEqual(targetCheckout, -1, `${scenario.job}: target checkout`);
    assert.notEqual(sourceCheckout, -1, `${scenario.job}: Codex source checkout`);
    assert.notEqual(review, -1, `${scenario.job}: review`);
    assert.ok(targetCheckout < sourceCheckout, `${scenario.job}: source follows target checkout`);
    assert.ok(sourceCheckout < review, `${scenario.job}: source precedes review`);
    assert.deepEqual(steps[sourceCheckout]!.with, {
      "target-repo": scenario.targetRepo,
      "target-dir": scenario.targetDir,
      "review-artifact-dir": scenario.artifactDir,
    });
  }
});

test("Codex source setup normalizes OpenClaw casing and stays out of the OpenClaw runner", () => {
  const action = YAML.parse(readText(".github/actions/setup-openclaw-codex-source/action.yml")) as {
    runs: { steps: Array<{ id?: string; if?: string; uses?: string }> };
  };
  const normalize = action.runs.steps.find((step) => step.id === "target");
  const cache = action.runs.steps.find((step) => step.uses === "actions/cache@v6");
  assert.ok(normalize);
  assert.match(cache?.if ?? "", /steps\.target\.outputs\.repository == 'openclaw\/openclaw'/u);
  assert.match(cache?.if ?? "", /env\.CLAWSWEEPER_RUNNER != 'openclaw'/u);
  const setup = action.runs.steps.at(-1);
  assert.match(setup?.if ?? "", /env\.CLAWSWEEPER_RUNNER != 'openclaw'/u);
});

test("automatic OpenClaw bug dispatch uses one gate across direct and deferred publication", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }> }
    >;
  };
  for (const [jobName, stepName] of [
    ["event-review-apply", "Dispatch exact high-confidence bug implementation"],
    ["event-review-publish", "Dispatch deferred high-confidence bug implementation"],
    ["publish", "Dispatch high-confidence bug implementation candidates"],
  ]) {
    const step = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `${jobName}: ${stepName}`);
    assert.match(step.if ?? "", /vars\.CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES == '1'/);
    assert.doesNotMatch(step.if ?? "", /CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS/);
    assert.match(step.run ?? "", /dispatch-issue-implementation-candidates\.mjs/);
    assert.equal(
      step.env?.MAX_DISPATCH,
      "${{ vars.CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP || '' }}",
    );
  }
});

test("issue implementation dispatches omit the deleted model input", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const dispatches = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter((step) => step.run?.includes("repair-issue-implementation-intake.yml"))
      .map((step) => ({ jobName, step })),
  );

  assert.ok(dispatches.length > 0);
  for (const { jobName, step } of dispatches) {
    assert.doesNotMatch(step.run ?? "", /-f\s+model=/, `${jobName}: ${step.name}`);
  }
});

test("automatic bug backfill runs independently of queue-fed scheduled sweeps", () => {
  const workflow = YAML.parse(
    readText(".github/workflows/repair-issue-implementation-backfill.yml"),
  ) as {
    on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        if: string;
        steps: Array<{ uses?: string; name?: string; run?: string; with?: Record<string, string> }>;
      }
    >;
  };
  assert.deepEqual(workflow.on.schedule, [{ cron: "7/10 * * * *" }]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
  assert.match(workflow.jobs.backfill!.if, /CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES == '1'/);
  const checkout = workflow.jobs.backfill!.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout?.uses, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
  assert.equal(checkout?.with?.["persist-credentials"], false);
  const state = workflow.jobs.backfill!.steps.find((step) => step.uses?.endsWith("/setup-state"));
  assert.equal(state?.with?.["coordinator-class"], "cluster_intake");
  assert.equal(state?.with?.["records-repo-slugs"], "openclaw-openclaw");
  const dispatch = workflow.jobs.backfill!.steps.find(
    (step) => step.name === "Dispatch bounded high-confidence bug candidates",
  );
  assert.match(dispatch?.run ?? "", /dispatch-issue-implementation-candidates\.mjs/);
  assert.match(dispatch?.run ?? "", /--report-dir records\/openclaw-openclaw\/items/);
});

test("audit uploads its canonical close-verdict inventory before state publication", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const auditStart = workflow.indexOf("\n  audit-dashboard:");
  const auditEnd = workflow.indexOf("\n  apply-proof:", auditStart);
  assert.notEqual(auditStart, -1);
  assert.notEqual(auditEnd, -1);
  const auditJob = workflow.slice(auditStart, auditEnd);
  const refresh = auditJob.indexOf("- name: Refresh Audit Health");
  const upload = auditJob.indexOf("- name: Upload canonical close-verdict audit");
  const publish = auditJob.indexOf("- name: Commit Audit Health");

  assert.ok(refresh < upload && upload < publish);
  assert.match(auditJob, /--output \.artifacts\/clawsweeper-audit\.json/);
  assert.match(auditJob, /name: close-verdict-audit-\$\{\{ github\.run_id \}\}/);
  assert.match(auditJob, /retention-days: 14/);
});

test("exact publication forwards state writer telemetry through the Node payload builder", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  assert.match(
    workflow,
    /STATE_WRITER_JSON: \$\{\{ steps\.exact-review-publication-result\.outputs\.state_writer_json \}\}/,
  );
  assert.match(workflow, /const parsed = JSON\.parse\(process\.env\.STATE_WRITER_JSON \|\| ""\)/);
  assert.match(workflow, /\.\.\.\(stateWriter \? \{ state_writer: stateWriter \} : \{\}\)/);
  assert.doesNotMatch(workflow, /--data .*STATE_WRITER_JSON/);
});

test("ledger-producing jobs initialize immutable workflow context", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  for (const jobName of [
    "event-review-apply",
    "event-review-publish",
    "review",
    "publish",
    "retry-failed-reviews",
    "apply-proof",
    "apply-existing",
  ]) {
    const start = workflow.indexOf(`\n  ${jobName}:`);
    assert.notEqual(start, -1, `missing ${jobName} job`);
    const remaining = workflow.slice(start + 1);
    const nextJob = remaining.match(/\n  [a-z0-9_-]+:\n/);
    const end = nextJob?.index === undefined ? workflow.length : start + 1 + nextJob.index;
    const job = workflow.slice(start, end);
    assert.match(
      job,
      /uses: \.\/(?:clawsweeper\/)?\.github\/actions\/setup-action-ledger/,
      `${jobName} must initialize the action ledger`,
    );
  }

  const action = readText(".github/actions/setup-action-ledger/action.yml");
  assert.match(action, /actions\/runs\/\$\{GITHUB_RUN_ID\}/);
  assert.match(
    action,
    /RUNNER_TEMP\/clawsweeper-action-ledger\/\$\{GITHUB_RUN_ID\}\/\$\{GITHUB_RUN_ATTEMPT\}\/\$\{GITHUB_JOB\}/,
  );
  assert.doesNotMatch(action, /GITHUB_WORKSPACE/);
  assert.match(action, /CLAWSWEEPER_ACTION_LEDGER_FORCE=1/);
  assert.match(action, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(action, /GITHUB_RUN_STARTED_AT=\$run_started_at/);
});

test("review and apply primary boundaries ignore ledger-only failures", () => {
  type WorkflowStep = {
    name?: string;
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | boolean>;
    "continue-on-error"?: boolean;
  };
  type WorkflowJob = {
    if?: string;
    needs?: string | string[];
    outputs?: Record<string, string>;
    steps: WorkflowStep[];
  };

  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const job = (name: string): WorkflowJob => {
    const value = workflow.jobs[name];
    assert.ok(value, `missing ${name} job`);
    return value;
  };
  const step = (jobName: string, name: string): WorkflowStep => {
    const value = job(jobName).steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing ${jobName} step ${name}`);
    return value;
  };
  const setupLedger = (jobName: string): WorkflowStep => {
    const value = job(jobName).steps.find((candidate) =>
      candidate.uses?.endsWith("/setup-action-ledger"),
    );
    assert.ok(value, `missing ${jobName} ledger setup`);
    return value;
  };

  for (const jobName of [
    "event-review-apply",
    "event-review-publish",
    "review",
    "publish",
    "retry-failed-reviews",
    "apply-proof",
    "apply-existing",
  ]) {
    assert.equal(
      setupLedger(jobName)["continue-on-error"],
      true,
      `${jobName} ledger setup must fail open`,
    );
  }
  for (const [jobName, stepName] of [
    ["event-review-apply", "Finalize exact event action ledger"],
    ["review", "Finalize review action ledger"],
  ] as const) {
    assert.equal(
      step(jobName, stepName)["continue-on-error"],
      true,
      `${stepName} must not poison primary review publication`,
    );
  }

  const exactBundle = step("event-review-apply", "Create exact review artifact bundle");
  assert.match(exactBundle.if ?? "", /review-exact-event-item\.outcome == 'success'/);
  assert.doesNotMatch(exactBundle.if ?? "", /action-ledger/);
  const exactPrimary = step("event-review-apply", "Export exact review generation result");
  const exactQueue = step("event-review-apply", "Complete exact-review queue lease");
  const exactUpload = step("event-review-apply", "Upload exact review artifact bundle");
  const exactPublicationQueue = step(
    "event-review-apply",
    "Queue durable exact review publication",
  );
  const exactSteps = job("event-review-apply").steps;
  assert.match(exactPrimary.run ?? "", /outcome=(?:failure|cancelled|success)/);
  assert.match(exactPrimary.run ?? "", /REVIEW_OUTCOME.*cancelled/);
  assert.match(exactPrimary.run ?? "", /PUBLICATION_QUEUE_OUTCOME.*success/);
  assert.match(exactQueue.env?.PRIMARY_OUTCOME ?? "", /exact-review-generation-result/);
  assert.doesNotMatch(exactQueue.run ?? "", /JOB_STATUS|job\.status/);
  assert.ok(exactSteps.indexOf(exactUpload) < exactSteps.indexOf(exactQueue));
  assert.ok(exactSteps.indexOf(exactUpload) < exactSteps.indexOf(exactPublicationQueue));
  assert.ok(exactSteps.indexOf(exactPublicationQueue) < exactSteps.indexOf(exactQueue));
  assert.ok(exactSteps.indexOf(exactQueue) > exactSteps.indexOf(exactPrimary));
  assert.equal(
    job("event-review-publish").steps.some(
      (candidate) => candidate.name === "Publish exact review action ledger",
    ),
    false,
  );

  const ledgerDownload = job("publish").steps.find(
    (candidate) => candidate.id === "download-review-action-ledger",
  );
  assert.ok(ledgerDownload);
  assert.equal(ledgerDownload["continue-on-error"], true);
  for (const name of [
    "Import immutable review action events",
    "Publish immutable review action ledger",
  ]) {
    assert.equal(step("publish", name)["continue-on-error"], true, `${name} must fail open`);
  }
  const artifactApply = step("publish", "Apply review artifacts");
  assert.match(artifactApply.if ?? "", /setup-publish-state\.outcome == 'success'/);
  assert.match(artifactApply.if ?? "", /download-review-artifacts\.outcome == 'success'/);
  assert.doesNotMatch(artifactApply.if ?? "", /action-ledger/);
  assert.match(artifactApply.run ?? "", /review_batch_succeeded=/);
  assert.match(artifactApply.run ?? "", /artifacts_applied=true/);
  const artifactLedger = step("publish", "Publish review artifact action ledger");
  assert.match(artifactLedger.if ?? "", /apply-review-artifacts\.outputs\.artifacts_applied/);
  const recordPublish = step("publish", "Commit review records");
  assert.match(recordPublish.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.match(recordPublish.if ?? "", /apply-review-artifacts\.outputs\.artifacts_applied/);
  assert.match(recordPublish.run ?? "", /records_published=true/);

  for (const name of [
    "Dispatch high-confidence bug implementation candidates",
    "Dispatch vision-fit implementation candidates",
    "Backfill viable open issue implementation candidates",
    "Sync selected review comments",
  ]) {
    const condition = step("publish", name).if ?? "";
    assert.match(condition, /always\(\) && !cancelled\(\)/, name);
    assert.match(condition, /commit-review-records\.outputs\.records_published == 'true'/, name);
    assert.doesNotMatch(condition, /success\(\)|action-ledger/, name);
  }
  const selectedApply = step("publish", "Dispatch selected safe close proposals to isolated apply");
  assert.match(selectedApply.if ?? "", /sync-selected-review-comments\.outputs\.sync_succeeded/);
  assert.doesNotMatch(selectedApply.if ?? "", /success\(\)|action-ledger/);
  const reviewContinuation = step("publish", "Continue sweep");
  assert.match(
    reviewContinuation.if ?? "",
    /apply-review-artifacts\.outputs\.review_batch_succeeded/,
  );
  assert.match(reviewContinuation.if ?? "", /commit-review-records\.outputs\.records_published/);
  assert.doesNotMatch(reviewContinuation.if ?? "", /success\(\)|action-ledger/);

  const proofMarker = step("apply-proof", "Export primary apply proof result");
  assert.match(proofMarker.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.match(proofMarker.if ?? "", /proof-select\.outcome == 'success'/);
  assert.match(proofMarker.if ?? "", /generate-apply-proofs\.outcome == 'success'/);
  assert.doesNotMatch(proofMarker.if ?? "", /success\(\)|action-ledger/);
  assert.match(job("apply-existing").if ?? "", /needs\.apply-proof\.outputs\.proof_ready/);
  assert.doesNotMatch(
    job("apply-existing").if ?? "",
    /needs\.apply-proof\.result|publish-apply-proof-action-ledger/,
  );

  const applySteps = job("apply-existing").steps;
  const applyMarkerIndex = applySteps.findIndex(
    (candidate) => candidate.name === "Export primary apply result",
  );
  const applyFinalizerIndex = applySteps.findIndex(
    (candidate) => candidate.name === "Finalize apply action ledger",
  );
  assert.ok(applyMarkerIndex >= 0);
  assert.ok(applyFinalizerIndex > applyMarkerIndex);
  const applyMarker = applySteps[applyMarkerIndex]!;
  assert.match(applyMarker.if ?? "", /apply-existing-run\.outcome == 'success'/);
  for (const name of [
    "Retry final apply status publication",
    "Continue apply sweep",
    "Queue review backstops",
  ]) {
    const condition = step("apply-existing", name).if ?? "";
    assert.match(condition, /always\(\) && !cancelled\(\)/, name);
    assert.match(condition, /primary-apply-result\.outputs\.succeeded == 'true'/, name);
    assert.doesNotMatch(condition, /success\(\)|action-ledger/, name);
  }

  const telemetryJob = job("publish-apply-observability");
  assert.deepEqual(telemetryJob.needs, [
    "apply-proof",
    "publish-apply-proof-action-ledger",
    "apply-existing",
  ]);
  assert.match(telemetryJob.if ?? "", /always\(\)/);
  assert.doesNotMatch(telemetryJob.if ?? "", /!cancelled\(\)/);
  assert.match(telemetryJob.if ?? "", /needs\.apply-proof\.result == 'failure'/);
  assert.match(
    telemetryJob.if ?? "",
    /needs\.publish-apply-proof-action-ledger\.result == 'failure'/,
  );
  assert.match(telemetryJob.if ?? "", /needs\.apply-existing\.result == 'failure'/);
  assert.match(telemetryJob.if ?? "", /needs\.apply-existing\.result == 'cancelled'/);
  const telemetryStep = step("publish-apply-observability", "Publish apply telemetry");
  assert.match(telemetryStep.env?.APPLY_OUTCOME ?? "", /needs\.apply-proof\.result == 'failure'/);
  assert.match(
    telemetryStep.env?.APPLY_OUTCOME ?? "",
    /needs\.apply-existing\.result == 'success'/,
  );
  assert.doesNotMatch(telemetryStep.env?.APPLY_OUTCOME ?? "", /publish-apply-proof-action-ledger/);
  assert.match(
    telemetryStep.env?.ACTION_LEDGER_OUTCOME ?? "",
    /needs\.publish-apply-proof-action-ledger\.result == 'failure'/,
  );
  assert.match(telemetryStep.env?.TARGET_REPO ?? "", /openclaw\/clawhub/);
  assert.match(
    telemetryStep.env?.APPLY_STARTED_AT ?? "",
    /needs\.apply-existing\.outputs\.observability_started_at/,
  );
  const applyExisting = job("apply-existing");
  assert.match(
    applyExisting.outputs?.observability_started_at ?? "",
    /steps\.apply-telemetry-start\.outputs\.started_at/,
  );
  const telemetryContext = step("apply-existing", "Save apply telemetry context");
  assert.equal(telemetryContext["continue-on-error"], true);
  assert.match(telemetryContext.run ?? "", /apply-observability-context\.json/);
  const telemetryArtifact = step("apply-existing", "Upload apply telemetry health");
  assert.equal(telemetryArtifact["continue-on-error"], true);
  assert.equal(telemetryArtifact.with?.["include-hidden-files"], true);
  const telemetryStart = step("apply-existing", "Publish apply telemetry start");
  assert.equal(telemetryStart["continue-on-error"], true);
  assert.equal(telemetryStart.env?.APPLY_OUTCOME, "in_progress");
  assert.match(telemetryStart.run ?? "", /publish-apply-observability\.mjs/);
  assert.match(telemetryStart.run ?? "", /apply-observability-context\.json/);
  assert.match(telemetryContext.run ?? "", /apply-telemetry-start\.outputs\.started_at/);
});

test("review workflow gives Codex a read-only inspection token", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewJobStart = workflow.indexOf("\n  event-review-apply:");
  const planJobStart = workflow.indexOf("\n  plan:", eventReviewJobStart);
  const eventReviewJob = workflow.slice(eventReviewJobStart, planJobStart);
  const reviewJobStart = workflow.indexOf("\n  review:");
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);
  const exactReviewStart = eventReviewJob.indexOf("- name: Review exact event item");
  const stateTokenStart = eventReviewJob.indexOf("- name: Create state token", exactReviewStart);
  const exactReviewStep = eventReviewJob.slice(exactReviewStart, stateTokenStart);

  assert.match(
    eventReviewJob,
    /runs-on: \$\{\{ vars\.CLAWSWEEPER_REVIEW_RUNNER \|\| 'ubuntu-latest' \}\}/,
  );
  assert.match(
    reviewJob,
    /runs-on: \$\{\{ vars\.CLAWSWEEPER_REVIEW_RUNNER \|\| 'ubuntu-latest' \}\}/,
  );
  assert.match(workflow, /id: codex-inspection-token/);
  assert.match(workflow, /permission-issues: read/);
  assert.match(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
  assert.match(
    exactReviewStep,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \}\}/,
  );
  assert.doesNotMatch(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN:.*github\.token/);
  assert.match(
    exactReviewStep,
    /report_path="artifacts\/event\/\$\{\{ steps\.target\.outputs\.item_number \}\}\.md"/,
  );
  assert.match(exactReviewStep, /coordination-held\.json/);
  assert.match(exactReviewStep, /echo "retry_kind=coordination" >> "\$GITHUB_OUTPUT"/);
  assert.match(exactReviewStep, /echo "retry_at=\$retry_at" >> "\$GITHUB_OUTPUT"/);
  assert.match(exactReviewStep, /Exact review produced no artifact for open item/);
  assert.match(reviewJob, /uses: \.\/clawsweeper\/\.github\/actions\/setup-codex/);
  assert.doesNotMatch(reviewJob, /uses: \.\/\.github\/actions\/setup-codex/);
  assert.match(exactReviewStep, /--codex-sandbox read-only/);
  assert.match(exactReviewStep, /--skip-start-comment/);
  assert.match(reviewJob, /--codex-sandbox read-only/);
  assert.doesNotMatch(workflow, /--codex-sandbox danger-full-access/);
});

test("review execution tokens can read check runs and commit statuses", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewStart = workflow.indexOf("\n  event-review-apply:");
  const planStart = workflow.indexOf("\n  plan:", eventReviewStart);
  const reviewStart = workflow.indexOf("\n  review:", planStart);
  const publishStart = workflow.indexOf("\n  publish:", reviewStart);
  const eventReviewJob = workflow.slice(eventReviewStart, planStart);
  const scheduledReviewJob = workflow.slice(reviewStart, publishStart);

  for (const [job, tokenId] of [
    [eventReviewJob, "target-read-token"],
    [scheduledReviewJob, "target-read-token"],
  ] as const) {
    const permissions = job.slice(job.indexOf("\n    permissions:"), job.indexOf("\n    steps:"));
    const targetTokenStart = job.indexOf(`id: ${tokenId}`);
    const targetTokenEnd = job.indexOf("\n      - ", targetTokenStart);
    const targetToken = job.slice(targetTokenStart, targetTokenEnd);

    assert.match(permissions, /checks: read/);
    assert.match(permissions, /statuses: read/);
    assert.match(targetToken, /permission-checks: read/);
    assert.match(targetToken, /permission-statuses: read/);
  }
  assert.match(
    eventReviewJob,
    /Review exact event item[\s\S]*GH_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \}\}/,
  );
});

test("comment router target token can inspect checks without widening dispatch authority", () => {
  type TokenStep = {
    id?: string;
    with?: Record<string, string>;
  };
  const workflow = YAML.parse(readText(".github/workflows/repair-comment-router.yml")) as {
    jobs: Record<string, { steps: TokenStep[] }>;
  };
  const steps = workflow.jobs["route-comments"]!.steps;
  const targetToken = steps.find((step) => step.id === "app_token");
  const dispatchToken = steps.find((step) => step.id === "dispatch-token");

  assert.ok(targetToken?.with);
  assert.equal(targetToken.with["permission-checks"], "read");
  assert.equal(targetToken.with["permission-statuses"], "read");
  assert.ok(dispatchToken?.with);
  assert.equal("permission-checks" in dispatchToken.with, false);
  assert.equal("permission-statuses" in dispatchToken.with, false);
});

test("exact event branch guard resolves empty and numeric claims to the repository default", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const run = workflow.jobs["event-review-apply"]?.steps.find(
    (candidate) => candidate.name === "Check live target item state",
  )?.run;
  assert.ok(run);

  const temporary = mkdtempSync(tmpPrefix);
  try {
    const fakeBin = join(temporary, "bin");
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${2:-}" in
  repos/openclaw/openclaw)
    printf 'trunk\\n'
    ;;
  repos/openclaw/openclaw/issues/42)
    printf '{"state":"closed","locked":false}\\n'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);

    for (const branch of ["", "0"]) {
      const outputPath = join(temporary, branch ? `output-${branch}` : "output-empty");
      execFileSync("bash", ["-c", run], {
        env: {
          ...process.env,
          CLAIM_DECISION: JSON.stringify({ targetBranch: branch }),
          CLAIM_TARGET_BRANCH: branch,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          ITEM_NUMBER: "42",
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          TARGET_REPO: "openclaw/openclaw",
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      assert.equal(outputs.target_branch, "trunk");
      assert.equal(outputs.admission_retry, "false");
      assert.equal(outputs.terminal_noop, "true");
      assert.equal(JSON.parse(outputs.decision ?? "{}").targetBranch, "trunk");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("scheduled claim-time no-op completes before target checkout with zero GitHub writes", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const run = workflow.jobs["event-review-apply"]?.steps.find(
    (candidate) => candidate.name === "Check live target item state",
  )?.run;
  assert.ok(run);
  const temporary = mkdtempSync(tmpPrefix);
  try {
    const fakeBin = join(temporary, "bin");
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    const outputPath = join(temporary, "output");
    const logPath = join(temporary, "gh.log");
    const issue = {
      number: 41,
      title: "Unchanged issue",
      body: "Original body",
      state: "open",
      locked: false,
      updated_at: "2026-08-09T21:12:38Z",
      labels: [],
    };
    const human = {
      id: 1,
      user: { login: "reporter" },
      body: "Existing evidence",
      created_at: "2026-08-09T19:00:00Z",
      updated_at: "2026-08-09T19:00:00Z",
    };
    const revision = scheduledReviewSemanticSourceRevision(issue, [human]);
    const comments = [
      human,
      {
        id: 2,
        user: { login: "clawsweeper[bot]" },
        body: `Unchanged review\n\n<!-- clawsweeper-review-version item=41 reviewed_at=2026-08-09T21:12:33Z sha=na source_revision=${revision} lease_owner=old lease_comment_id=2 v=1 -->`,
        created_at: "2026-08-09T20:00:00Z",
        updated_at: "2026-08-09T21:12:33Z",
      },
    ];
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ " $* " == *" --method "* ]] || [[ " $* " == *" -X "* ]]; then exit 97; fi
if [[ "$*" == *"repos/openclaw/libterminal/issues/41/comments"* ]]; then
  printf '%s\\n' '${JSON.stringify([comments])}'
elif [[ "$*" == *"repos/openclaw/libterminal/issues/41"* ]]; then
  printf '%s\\n' '${JSON.stringify(issue)}'
else
  exit 1
fi
`,
    );
    chmodSync(fakeGh, 0o755);
    execFileSync("bash", ["-c", run], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAIM_DECISION: JSON.stringify({
          targetBranch: "main",
          sourceAction: "scheduled_hot_intake",
          sourceUpdatedAt: issue.updated_at,
        }),
        CLAIM_TARGET_BRANCH: "main",
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        ITEM_NUMBER: "41",
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        TARGET_REPO: "openclaw/libterminal",
      },
    });
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /^scheduled_noop=true$/m);
    assert.match(output, /^proceed=false$/m);
    assert.match(output, /^terminal_noop=false$/m);
    assert.match(output, /^scheduled_semantic_noop=true$/m);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /--method|-X/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("manual review shards receive a ready-to-run artifact", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const planJobStart = workflow.indexOf("\n  plan:");
  const reviewJobStart = workflow.indexOf("\n  review:", planJobStart);
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const planJob = workflow.slice(planJobStart, reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);

  assert.match(
    planJob,
    /node scripts\/prepare-review-runtime\.mjs[\s\S]*--output \.artifacts\/review-runtime[\s\S]*--plan plan\.json[\s\S]*--state-root \.[\s\S]*--records-path "records\/\$\{target_slug\}\/items"/,
  );
  assert.ok(
    planJob.indexOf("id: select") < planJob.indexOf("name: Prepare review runtime artifact"),
  );
  assert.match(
    planJob,
    /tar -czf \.artifacts\/review-runtime\.tar\.gz -C \.artifacts\/review-runtime \./,
  );
  assert.match(
    planJob,
    /name: clawsweeper-runtime-dist\s+path: clawsweeper\/\.artifacts\/review-runtime\.tar\.gz\s+include-hidden-files: true/,
  );
  assert.match(planJob, /if: \$\{\{ steps\.mode\.outputs\.queue_feed != 'true' \}\}/);
  assert.match(reviewJob, /if: \$\{\{ needs\.plan\.outputs\.queue_feed != 'true' \}\}/);
  assert.match(reviewJob, /name: clawsweeper-runtime-dist\s+path: clawsweeper\/\.artifacts/);
  assert.doesNotMatch(reviewJob, /name: clawsweeper-runtime-dist\s+path: clawsweeper\/dist/);
  assert.match(reviewJob, /tar -xzf \.artifacts\/review-runtime\.tar\.gz/);
  assert.doesNotMatch(reviewJob, /install-review-native-compiler|npm pack "@typescript/);
});

test("exact event review publishes directly with a queue-bounded canonical fallback", () => {
  type Step = {
    "continue-on-error"?: boolean;
    name?: string;
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number | boolean>;
  };
  type Job = {
    needs?: string | string[];
    if?: string;
    "timeout-minutes"?: number;
    permissions?: Record<string, string>;
    concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
    steps: Step[];
  };
  const source = readText(".github/workflows/sweep.yml");
  const workflow = YAML.parse(source) as { jobs: Record<string, Job> };
  const reviewer = workflow.jobs["event-review-apply"]!;
  const publisher = workflow.jobs["event-review-publish"]!;
  const batchPublisher = workflow.jobs.publish!;
  const step = (job: Job, name: string) => {
    const value = job.steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing step: ${name}`);
    return value;
  };

  assert.equal(reviewer.permissions?.contents, "read");
  assert.equal(reviewer["timeout-minutes"], 150);
  assert.equal(reviewer.permissions?.issues, "read");
  assert.equal(
    reviewer.steps.some((candidate) => candidate.uses?.endsWith("/setup-state")),
    true,
  );
  assert.equal(
    reviewer.steps.some(
      (candidate) => candidate.name === "Publish event result and apply safe close",
    ),
    false,
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.GH_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.equal(step(reviewer, "Review exact event item").env?.REPO_TOKEN, undefined);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--skip-start-comment/);
  for (const name of [
    "Inspect exact review live proof",
    "Resolve exact live-proof Go version",
    "Set up exact live-proof Go toolchain",
    "Enable exact live-proof automatic Go fallback",
    "Install exact live-proof terminal tools",
    "Install exact live-proof recording tools",
    "Execute exact review live proof",
  ]) {
    assert.equal(
      reviewer.steps.some((candidate) => candidate.name === name),
      false,
      `retired automatic live-proof step remains: ${name}`,
    );
  }

  const reserveLease = step(reviewer, "Reserve exact review lease");
  assert.equal(reserveLease.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
  assert.match(reserveLease.run ?? "", /pnpm run --silent reserve-review-lease/);
  assert.match(reserveLease.run ?? "", /review-timeout-ms/);
  assert.match(reserveLease.run ?? "", /for attempt in 1 2 3 4 5/);
  assert.match(reserveLease.run ?? "", /RANDOM % 4/);
  assert.match(reserveLease.run ?? "", /status.*superseded/);
  assert.match(reserveLease.run ?? "", /successful no-op/);
  assert.match(
    reserveLease.run ?? "",
    /rate limit exceeded\|secondary rate limit\|HTTP 429/,
    "throttled reservations must defer as held instead of failing",
  );
  assert.match(
    reserveLease.run ?? "",
    /\\"status\\":\\"held\\",\\"retryAt\\":\\"\$retry_at\\",\\"retryKind\\":\\"throttle\\"/,
  );
  assert.match(reserveLease.run ?? "", /reservation\.retryKind === "throttle"/);
  assert.match(reserveLease.run ?? "", /append\("retry_kind", retryKind\)/);
  assert.match(source, /Review exact item \{0\} rev \{1\} head \{2\}/);
  assert.equal(
    reserveLease.env?.EXACT_REVIEW_ITEM_KEY,
    "${{ steps.claim-exact-review-queue.outputs.item_key }}",
  );
  assert.equal(
    reserveLease.env?.EXACT_REVIEW_CLAIM_GENERATION,
    "${{ steps.claim-exact-review-queue.outputs.claim_generation }}",
  );
  assert.equal(
    reserveLease.env?.EXACT_REVIEW_SOURCE_HEAD_SHA,
    "${{ fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceHeadSha || '' }}",
  );
  const resolvePayload = step(reviewer, "Resolve event payload");
  const liveItem = step(reviewer, "Check live target item state");
  assert.match(resolvePayload.run ?? "", /maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(
    resolvePayload.run ?? "",
    /Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)/,
  );
  assert.match(
    resolvePayload.run ?? "",
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs/,
  );
  assert.equal(
    liveItem.env?.CLAIM_DECISION,
    "${{ steps.claim-exact-review-queue.outputs.decision }}",
  );
  assert.equal(
    liveItem.env?.GH_TOKEN,
    "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || steps.target-read-token.outputs.token }}",
  );
  assert.match(liveItem.run ?? "", /grep -Eq '\^\[0-9\]\+\$'/);
  assert.match(
    liveItem.run ?? "",
    /gh api "repos\/\$TARGET_REPO" --jq '\.default_branch \/\/ empty'/,
  );
  assert.match(liveItem.run ?? "", /Resolved invalid queued target branch/);
  assert.match(liveItem.run ?? "", /admission_retry=true/);
  assert.match(liveItem.run ?? "", /echo "retry_kind=throttle"/);
  assert.match(
    liveItem.run ?? "",
    /rate limit exceeded\|secondary rate limit\|HTTP 429/,
    "a throttled live-item check must release the claim for retry instead of failing",
  );
  assert.match(liveItem.run ?? "", /throttled the live-item check/);
  assert.match(liveItem.run ?? "", /decision\.targetBranch = process\.env\.TARGET_BRANCH/);
  assert.match(liveItem.run ?? "", /scripts\/classify-scheduled-review-noop\.ts/);
  const targetToken = reviewer.steps.find((step) => step.id === "target-write-token");
  assert.match(targetToken?.if ?? "", /scheduled_semantic_noop != 'true'/);
  assert.doesNotMatch(targetToken?.if ?? "", /outputs\.proceed == 'true'/);
  const setupPnpm = reviewer.steps.find((step) => step.id === "setup-pnpm");
  assert.match(setupPnpm?.if ?? "", /scheduled_semantic_noop != 'true'/);
  const bundle = reviewer.steps.find((step) => step.id === "create-exact-review-bundle");
  assert.match(bundle?.if ?? "", /scheduled_semantic_noop != 'true'/);
  const semanticNoopResult = reviewer.steps.find(
    (step) => step.id === "exact-review-generation-result",
  );
  assert.match(semanticNoopResult?.run ?? "", /SCHEDULED_SEMANTIC_NOOP.*outcome=success/s);
  assert.match(liveItem.run ?? "", /scheduled_noop=true/);
  assert.match(liveItem.run ?? "", /Completing .* as a scheduled no-op before target checkout/);
  assert.match(
    step(reviewer, "Review exact event item").if ?? "",
    /reserve-exact-review-lease\.outputs\.status == 'posted'/,
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--review-lease-owner/);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--review-lease-comment-id/);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /claim_generation/);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /run_attempt/);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /source_head_sha/);
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /review_exit_code.*-eq 78[\s\S]*failure_reason=incomplete_source/,
  );
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /kill -TERM -- "-\$review_pgid"/,
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /sleep 60/);

  const create = step(reviewer, "Create exact review artifact bundle");
  const directSetupState = reviewer.steps.find(
    (candidate) => candidate.id === "direct-setup-state",
  );
  assert.ok(directSetupState);
  assert.equal(
    directSetupState.with?.["records-item-number"],
    "${{ steps.target.outputs.item_number }}",
  );
  const prepareDirect = step(reviewer, "Deliver GitHub effects and prepare direct state mutation");
  const postDirect = step(reviewer, "Post direct exact review publication result");
  const finalizeDirect = step(reviewer, "Finalize direct exact review lifecycle");
  const directImplementationDispatch = step(
    reviewer,
    "Dispatch exact high-confidence bug implementation",
  );
  const upload = step(reviewer, "Upload exact review artifact bundle");
  const failureDiagnostics = step(reviewer, "Upload exact review failure diagnostics");
  const queuePublication = step(reviewer, "Queue durable exact review publication");
  const complete = step(reviewer, "Complete exact-review queue lease");
  const generationResult = step(reviewer, "Export exact review generation result");
  const deferHeldReview = step(reviewer, "Defer exact review while same-head lease is held");
  const failGeneration = step(reviewer, "Fail unsuccessful exact review generation");
  const releaseGeneration = step(reviewer, "Release unsuccessful workflow-owned review lease");
  const markUnsuccessful = step(reviewer, "Mark unsuccessful re-review");
  assert.match(create.if ?? "", /review-exact-event-item\.outcome == 'success'/);
  assert.match(create.if ?? "", /review-exact-event-item\.outputs\.retry_at == ''/);
  assert.match(create.if ?? "", /review-exact-event-item\.outputs\.superseded != 'true'/);
  assert.doesNotMatch(create.if ?? "", /live-proof|live_proof|inspect-exact|execute-exact/);
  assert.equal(create.env?.EXACT_REVIEW_PRODUCER_JOB, "event-review-apply");
  assert.equal(create.env?.EXACT_REVIEW_DECISION, "${{ steps.live-item.outputs.decision }}");
  assert.equal(create.env?.EXACT_REVIEW_LIVE_PROOF_DIR, undefined);
  assert.doesNotMatch(directSetupState.if ?? "", /live-proof|live_proof|execute-exact/);
  assert.match(create.run ?? "", /mkdir -p \.artifacts/);
  assert.ok(
    (create.run ?? "").indexOf("mkdir -p .artifacts") <
      (create.run ?? "").indexOf("exact-review-bundle create"),
  );
  assert.equal(upload.uses, "actions/upload-artifact@v7");
  assert.equal(failureDiagnostics.uses, "actions/upload-artifact@v7");
  assert.equal(failureDiagnostics["continue-on-error"], true);
  assert.match(
    failureDiagnostics.if ?? "",
    /review-exact-event-item\.outputs\.failure_diagnostics == 'true'/,
  );
  assert.match(failureDiagnostics.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.equal(
    failureDiagnostics.with?.name,
    "exact-review-failure-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(failureDiagnostics.with?.path, "artifacts/event/failure-diagnostics/");
  assert.equal(failureDiagnostics.with?.["retention-days"], 14);
  assert.equal(failureDiagnostics.with?.["include-hidden-files"], false);
  assert.equal(failureDiagnostics.with?.["if-no-files-found"], "error");
  assert.ok(reviewer.steps.indexOf(failureDiagnostics) > reviewer.steps.indexOf(queuePublication));
  assert.ok(reviewer.steps.indexOf(failureDiagnostics) > reviewer.steps.indexOf(complete));
  assert.ok(reviewer.steps.indexOf(failureDiagnostics) < reviewer.steps.indexOf(failGeneration));
  assert.doesNotMatch(queuePublication.if ?? "", /failure-diagnostics/);
  assert.doesNotMatch(JSON.stringify(queuePublication), /failure-diagnostics/);
  assert.match(prepareDirect.run ?? "", /repair:publish-event-result/);
  assert.equal(prepareDirect.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
  assert.equal(prepareDirect.env?.REPO_TOKEN, "${{ github.token }}");
  assert.equal(
    prepareDirect.env?.EXACT_REVIEW_BATCH_MUTATION_OUTPUT,
    ".artifacts/direct-publication-outcome.json",
  );
  assert.match(postDirect.run ?? "", /repair:exact-review-direct-publication/);
  assert.equal(
    postDirect.env?.EXACT_REVIEW_DIRECT_SOURCE_ACTION,
    "${{ fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceAction }}",
  );
  assert.match(
    finalizeDirect.if ?? "",
    /direct-exact-review-publication\.outputs\.accepted == 'true'/,
  );
  assert.equal(finalizeDirect.id, "finalize-direct-exact-review-lifecycle");
  assert.equal(
    finalizeDirect.env?.DIRECT_PUBLICATION_SUPERSEDED,
    "${{ steps.direct-exact-review-publication.outputs.superseded }}",
  );
  assert.match(finalizeDirect.run ?? "", /direct_lifecycle_requeue=false/);
  assert.match(finalizeDirect.run ?? "", /direct_lifecycle_requeue=true/);
  assert.doesNotMatch(finalizeDirect.run ?? "", /internal\/exact-review\/enqueue/);
  assert.match(finalizeDirect.run ?? "", /lifecycle\/router-receipt/);
  assert.match(finalizeDirect.run ?? "", /lifecycle\/terminal-disposition/);
  assert.match(finalizeDirect.run ?? "", /router-direct-proof/);
  assert.match(finalizeDirect.run ?? "", /lifecycle_deferred_coverage="true"/);
  const directLifecycleHandoff = Math.max(
    (finalizeDirect.run ?? "").indexOf("lifecycle/router-receipt"),
    (finalizeDirect.run ?? "").indexOf("lifecycle/terminal-disposition"),
  );
  assert.ok(directLifecycleHandoff >= 0);
  assert.match(
    directImplementationDispatch.run ?? "",
    /dispatch-issue-implementation-candidates\.mjs/,
  );
  assert.match(
    directImplementationDispatch.if ?? "",
    /finalize-direct-exact-review-lifecycle\.outcome == 'success'/,
  );
  assert.ok(
    reviewer.steps.indexOf(finalizeDirect) < reviewer.steps.indexOf(directImplementationDispatch),
  );
  assert.ok(reviewer.steps.indexOf(directImplementationDispatch) < reviewer.steps.indexOf(upload));
  assert.doesNotMatch(finalizeDirect.run ?? "", /lifecycle\/command-ack\/attempt/);
  assert.doesNotMatch(finalizeDirect.run ?? "", /repair:update-command-status/);
  assert.match(reviewer.if ?? "", /source_action != 'exact_review_command_acknowledgement'/);
  assert.match(
    upload.if ?? "",
    /direct-exact-review-publication\.outputs\.accepted != 'true' \|\| steps\.finalize-direct-exact-review-lifecycle\.outcome != 'success'/,
  );
  assert.equal(upload.with?.["retention-days"], 90);
  assert.match(queuePublication.run ?? "", /for attempt in 1 2 3/);
  assert.match(queuePublication.run ?? "", /\.queued == true or \.deduped == true/);
  assert.equal(queuePublication.env?.CLAIM_DECISION, "${{ steps.live-item.outputs.decision }}");
  assert.equal(
    generationResult.env?.ADMISSION_RETRY,
    "${{ steps.live-item.outputs.admission_retry }}",
  );
  assert.match(generationResult.env?.RETRY_KIND ?? "", /live-item\.outputs\.retry_kind/);
  assert.match(generationResult.env?.RETRY_AT ?? "", /live-item\.outputs\.retry_at/);
  assert.equal(
    generationResult.env?.DIRECT_PUBLICATION_FAILURE_KIND,
    "${{ steps.prepare-direct-exact-review-publication.outputs.failure_kind }}",
  );
  assert.equal(
    generationResult.env?.DIRECT_PUBLICATION_RETRY_AT,
    "${{ steps.prepare-direct-exact-review-publication.outputs.retry_at }}",
  );
  assert.match(
    generationResult.run ?? "",
    /DIRECT_PUBLICATION_FAILURE_KIND.*github_rate_limit.*PUBLICATION_QUEUE_OUTCOME.*!=.*success[\s\S]*retry_kind=throttle[\s\S]*retry_at="\$DIRECT_PUBLICATION_RETRY_AT"/,
  );
  assert.match(generationResult.run ?? "", /ADMISSION_RETRY.*true.*-z.*retry_kind/s);
  assert.match(generationResult.run ?? "", /ADMISSION_RETRY.*true[\s\S]*outcome=success/);
  assert.match(generationResult.run ?? "", /requeue_latest=true/);
  assert.match(generationResult.run ?? "", /echo "retry_kind=\$retry_kind"/);
  assert.match(generationResult.run ?? "", /echo "retry_at=\$retry_at"/);
  const runGenerationResult = (overrides: Record<string, string>) => {
    const root = mkdtempSync(`${tmpPrefix}exact-review-generation-result-`);
    const outputPath = join(root, "github-output");
    try {
      execFileSync("bash", ["-c", generationResult.run ?? ""], {
        env: {
          ...process.env,
          ADMISSION_RETRY: "false",
          RETRY_KIND: "",
          RETRY_AT: "",
          DIRECT_PUBLICATION_FAILURE_KIND: "",
          DIRECT_PUBLICATION_RETRY_AT: "",
          TARGET_ENABLED: "true",
          LIVE_OUTCOME: "success",
          REVIEW_OUTCOME: "success",
          REVIEW_SUPERSEDED: "false",
          RESERVATION_STATUS: "",
          PUBLICATION_QUEUE_OUTCOME: "failure",
          DIRECT_PUBLICATION_ACCEPTED: "false",
          DIRECT_PUBLICATION_SUPERSEDED: "false",
          DIRECT_LIFECYCLE_OUTCOME: "failure",
          DIRECT_LIFECYCLE_REQUEUE: "false",
          GITHUB_OUTPUT: outputPath,
          ...overrides,
        },
      });
      return Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const directRetryAt = "2026-08-06T00:00:00.000Z";
  assert.deepEqual(
    runGenerationResult({
      DIRECT_PUBLICATION_FAILURE_KIND: "github_rate_limit",
      DIRECT_PUBLICATION_RETRY_AT: directRetryAt,
      PUBLICATION_QUEUE_OUTCOME: "success",
    }),
    {
      outcome: "success",
      requeue_latest: "false",
      direct_lifecycle_requeue: "false",
      retry_kind: "",
      retry_at: "",
    },
  );
  assert.deepEqual(
    runGenerationResult({
      DIRECT_PUBLICATION_FAILURE_KIND: "github_rate_limit",
      DIRECT_PUBLICATION_RETRY_AT: directRetryAt,
      PUBLICATION_QUEUE_OUTCOME: "failure",
    }),
    {
      outcome: "failure",
      requeue_latest: "false",
      direct_lifecycle_requeue: "false",
      retry_kind: "throttle",
      retry_at: directRetryAt,
    },
  );
  assert.equal(
    step(reviewer, "Export exact review generation result").env?.DIRECT_LIFECYCLE_OUTCOME,
    "${{ steps.finalize-direct-exact-review-lifecycle.outcome }}",
  );
  assert.equal(
    generationResult.env?.DIRECT_LIFECYCLE_REQUEUE,
    "${{ steps.finalize-direct-exact-review-lifecycle.outputs.direct_lifecycle_requeue || 'false' }}",
  );
  assert.match(
    step(reviewer, "Export exact review generation result").run ?? "",
    /DIRECT_LIFECYCLE_OUTCOME.*success/s,
  );
  assert.match(generationResult.run ?? "", /direct_lifecycle_requeue=\$DIRECT_LIFECYCLE_REQUEUE/);
  assert.match(complete.if ?? "", /finalize-direct-exact-review-lifecycle\.outcome == 'success'/);
  assert.equal(
    complete.env?.DIRECT_PUBLICATION_ACCEPTED,
    "${{ steps.direct-exact-review-publication.outputs.accepted }}",
  );
  assert.equal(
    complete.env?.DIRECT_PUBLICATION_SUPERSEDED,
    "${{ steps.direct-exact-review-publication.outputs.superseded }}",
  );
  assert.equal(
    complete.env?.DIRECT_LIFECYCLE_OUTCOME,
    "${{ steps.finalize-direct-exact-review-lifecycle.outcome }}",
  );
  assert.equal(
    complete.env?.DIRECT_LIFECYCLE_REQUEUE,
    "${{ steps.exact-review-generation-result.outputs.direct_lifecycle_requeue }}",
  );
  assert.match(complete.run ?? "", /directPublicationCompleted/);
  assert.match(complete.run ?? "", /directPublicationSuperseded/);
  assert.match(complete.run ?? "", /directLifecycleRequeue/);
  assert.match(complete.run ?? "", /direct_lifecycle_requeue: true/);
  assert.match(complete.run ?? "", /requeueLatest && directLifecycleRequeue/);
  assert.match(complete.run ?? "", /completion_kind: "published"/);
  assert.match(complete.run ?? "", /completion_kind: "superseded"/);
  assert.match(complete.env?.PRIMARY_OUTCOME ?? "", /exact-review-generation-result/);
  assert.match(complete.env?.REQUEUE_LATEST ?? "", /exact-review-generation-result/);
  assert.equal(
    complete.env?.RETRY_AT,
    "${{ steps.exact-review-generation-result.outputs.retry_at }}",
  );
  assert.equal(
    complete.env?.RETRY_KIND,
    "${{ steps.exact-review-generation-result.outputs.retry_kind }}",
  );
  assert.equal(
    complete.env?.REVIEW_FAILURE_REASON,
    "${{ steps.review-exact-event-item.outputs.failure_reason || '' }}",
  );
  assert.match(complete.run ?? "", /retry_kind: retryKind/);
  assert.match(complete.run ?? "", /review_failure_reason: process\.env\.REVIEW_FAILURE_REASON/);
  assert.match(complete.run ?? "", /requeue_latest: true/);
  assert.match(deferHeldReview.if ?? "", /reserve-exact-review-lease\.outputs\.status == 'held'/);
  assert.match(deferHeldReview.run ?? "", /retry deferred/);
  assert.match(failGeneration.if ?? "", /reserve-exact-review-lease\.outputs\.status != 'held'/);
  assert.match(
    failGeneration.if ?? "",
    /reserve-exact-review-lease\.outputs\.status != 'superseded'/,
  );
  assert.match(failGeneration.if ?? "", /review-exact-event-item\.outputs\.superseded != 'true'/);
  assert.match(failGeneration.if ?? "", /complete-exact-review-queue\.outcome != 'success'/);
  assert.equal(
    markUnsuccessful.env?.REVIEW_FAILURE_REASON,
    "${{ steps.review-exact-event-item.outputs.failure_reason || '' }}",
  );
  assert.match(
    markUnsuccessful.run ?? "",
    /incomplete_source[\s\S]*will not retry this unchanged revision/,
  );
  assert.match(
    failGeneration.if ?? "",
    /exact-review-generation-result\.outputs\.retry_kind == ''/,
  );
  const evaluateFailureGate = (values: Record<string, string>): boolean => {
    const expression = (failGeneration.if ?? "")
      .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
      .replace(/\balways\(\)/g, "true")
      .replace(
        /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
        (_match, stepId: string, access: string, outputName?: string) =>
          JSON.stringify(values[`${stepId}.${outputName ?? access}`] ?? ""),
      );
    return Boolean(Function(`"use strict"; return (${expression});`)());
  };
  const failureGateCases = [
    {
      name: "typed throttle with durable completion",
      values: {
        "claim-exact-review-queue.claimed": "true",
        "direct-exact-review-publication.accepted": "false",
        "complete-exact-review-queue.outcome": "success",
        "reserve-exact-review-lease.status": "",
        "review-exact-event-item.superseded": "false",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "throttle",
      },
      expected: false,
    },
    {
      name: "typed coordination with durable completion",
      values: {
        "claim-exact-review-queue.claimed": "true",
        "direct-exact-review-publication.accepted": "false",
        "complete-exact-review-queue.outcome": "success",
        "reserve-exact-review-lease.status": "held",
        "review-exact-event-item.superseded": "false",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "coordination",
      },
      expected: false,
    },
    {
      name: "typed throttle with failed completion",
      values: {
        "claim-exact-review-queue.claimed": "true",
        "direct-exact-review-publication.accepted": "false",
        "complete-exact-review-queue.outcome": "failure",
        "reserve-exact-review-lease.status": "",
        "review-exact-event-item.superseded": "false",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "throttle",
      },
      expected: true,
    },
    {
      name: "ordinary failure after durable completion",
      values: {
        "claim-exact-review-queue.claimed": "true",
        "direct-exact-review-publication.accepted": "false",
        "complete-exact-review-queue.outcome": "success",
        "reserve-exact-review-lease.status": "",
        "review-exact-event-item.superseded": "false",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "",
      },
      expected: true,
    },
    {
      name: "superseded reservation",
      values: {
        "claim-exact-review-queue.claimed": "true",
        "direct-exact-review-publication.accepted": "false",
        "complete-exact-review-queue.outcome": "success",
        "reserve-exact-review-lease.status": "superseded",
        "review-exact-event-item.superseded": "false",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "",
      },
      expected: false,
    },
  ] as const;
  for (const failureGateCase of failureGateCases) {
    assert.equal(
      evaluateFailureGate(failureGateCase.values),
      failureGateCase.expected,
      failureGateCase.name,
    );
  }
  const evaluateClassification = (values: Record<string, string>): string => {
    const expression = (failGeneration.env?.CLASSIFICATION ?? "")
      .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
      .replace(
        /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
        (_match, stepId: string, access: string, outputName?: string) =>
          JSON.stringify(values[`${stepId}.${outputName ?? access}`] ?? ""),
      );
    return String(Function(`"use strict"; return (${expression});`)());
  };
  const classificationCases = [
    {
      name: "completion failure after a successful review",
      values: {
        "complete-exact-review-queue.outcome": "failure",
        "reserve-exact-review-lease.status": "posted",
        "exact-review-generation-result.outcome": "success",
        "exact-review-generation-result.retry_kind": "",
      },
      expected: "queue_completion_failure",
    },
    {
      name: "completion failure after a held deferral",
      values: {
        "complete-exact-review-queue.outcome": "failure",
        "reserve-exact-review-lease.status": "held",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "coordination",
      },
      expected: "queue_completion_failure",
    },
    {
      name: "review lane failure after a durable completion",
      values: {
        "complete-exact-review-queue.outcome": "success",
        "reserve-exact-review-lease.status": "posted",
        "exact-review-generation-result.outcome": "failure",
        "exact-review-generation-result.retry_kind": "",
      },
      expected: "codex_or_content_failure",
    },
  ] as const;
  for (const classificationCase of classificationCases) {
    assert.equal(
      evaluateClassification(classificationCase.values),
      classificationCase.expected,
      classificationCase.name,
    );
  }
  assert.match(releaseGeneration.if ?? "", /reserve-exact-review-lease\.outputs\.status != 'held'/);
  assert.match(releaseGeneration.run ?? "", /content == "eyes"/);
  for (const cleanup of [releaseGeneration, step(reviewer, "Mark unsuccessful re-review")]) {
    for (const kind of ["github_rate_limit", "github_transient"]) {
      assert.match(
        cleanup.if ?? "",
        new RegExp(`prepare-direct-exact-review-publication\\.outputs\\.failure_kind != '${kind}'`),
      );
    }
  }
  assert.ok(reviewer.steps.indexOf(upload) < reviewer.steps.indexOf(complete));

  assert.equal(publisher.needs, undefined);
  assert.match(publisher.if ?? "", /source_action == 'exact_review_artifact_publish'/);
  assert.match(
    step(publisher, "Claim durable exact review publication").run ?? "",
    /internal\/exact-review\/claim/,
  );
  assert.equal(publisher.concurrency, undefined);
  assert.equal(publisher.permissions?.actions, "write");
  assert.equal(
    batchPublisher.concurrency?.group,
    "clawsweeper-target-review-publish-${{ needs.plan.outputs.target_repo }}",
  );
  const publicationContext = step(publisher, "Claim durable exact review publication");
  assert.match(
    publicationContext.run ?? "",
    /producerDecision\.commandStatusMarker \|\| producerDecision\.statusCommentId/,
  );
  assert.match(publicationContext.run ?? "", /directLifecycleRecovery/);
  assert.match(publicationContext.run ?? "", /directLifecycleRecoveryReady/);
  assert.match(
    publicationContext.run ?? "",
    /const publicationLeaseRevision = Number\(publication\?\.leaseRevision\);/,
  );
  assert.match(publicationContext.run ?? "", /publicationLeaseRevision === leaseRevision/);
  assert.match(publicationContext.run ?? "", /direct_lifecycle_plan/);
  assert.match(publicationContext.run ?? "", /direct_lifecycle_receipt_outcome/);
  assert.match(publicationContext.run ?? "", /deferredPublication/);
  assert.match(
    publicationContext.run ?? "",
    /response\.item_key === directItemKey\s*&&\s*publication\?\.itemKey === directItemKey/,
  );

  const download = step(publisher, "Download exact review artifact bundle");
  const validate = step(publisher, "Validate exact review artifact bundle");
  const foldLiveProof = step(publisher, "Fold exact live proof into the review artifact");
  const legacyArtifact = step(publisher, "Identify legacy tuple-less exact artifact");
  const targetWriteStep = step(publisher, "Create target write token");
  const stateSetup = publisher.steps.find((candidate) => candidate.uses?.endsWith("/setup-state"));
  assert.ok(stateSetup);
  assert.equal(
    stateSetup.with?.["records-item-number"],
    "${{ steps.publication-context.outputs.item_number }}",
  );
  const publisherCheckout = publisher.steps.find(
    (candidate) => candidate.uses === "actions/checkout@v7",
  );
  assert.ok(publisherCheckout);
  assert.equal(publisherCheckout.with?.ref, "main");
  assert.match(publisherCheckout.if ?? "", /direct_lifecycle_recovery != 'true'/);
  assert.equal(download.uses, "actions/download-artifact@v8");
  assert.match(download.if ?? "", /direct_lifecycle_recovery != 'true'/);
  assert.equal(download["continue-on-error"], true);
  assert.equal(download.with?.name, "${{ steps.publication-context.outputs.artifact_name }}");
  assert.equal(
    download.with?.["run-id"],
    "${{ steps.publication-context.outputs.producer_run_id }}",
  );
  assert.match(validate.run ?? "", /repair:exact-review-bundle validate/);
  assert.match(validate.if ?? "", /direct_lifecycle_recovery != 'true'/);
  assert.equal(validate["continue-on-error"], true);
  assert.equal(foldLiveProof.id, "fold-exact-live-proof");
  assert.equal(foldLiveProof["continue-on-error"], true);
  assert.match(foldLiveProof.run ?? "", /jq -r/);
  assert.match(foldLiveProof.run ?? "", /\.status == "invalid_artifact"/);
  assert.match(foldLiveProof.run ?? "", /GITHUB_OUTPUT/);
  const foldFixtureRoot = mkdtempSync(`${tmpPrefix}exact-live-proof-fold-`);
  const fakeBin = join(foldFixtureRoot, "bin");
  mkdirSync(fakeBin);
  const fakeNode = join(fakeBin, "node");
  writeFileSync(
    fakeNode,
    '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_NODE_STDOUT"\nexit "${FAKE_NODE_STATUS:-0}"\n',
    "utf8",
  );
  chmodSync(fakeNode, 0o755);
  try {
    for (const [index, scenario] of [
      {
        name: "published success",
        stdout: '{"status":"published","results":[]}',
        commandStatus: 0,
        expectedStatus: 0,
        expectedResult: "published",
      },
      {
        name: "invalid artifact",
        stdout: '{"status":"invalid_artifact"}',
        commandStatus: 1,
        expectedStatus: 1,
        expectedResult: "invalid_artifact",
      },
      {
        name: "retryable failure",
        stdout: '{"status":"retryable_failure"}',
        commandStatus: 1,
        expectedStatus: 1,
        expectedResult: "retryable_failure",
      },
      {
        name: "nonzero junk",
        stdout: "not-json",
        commandStatus: 1,
        expectedStatus: 1,
        expectedResult: "retryable_failure",
      },
      {
        name: "zero-exit junk",
        stdout: "not-json",
        commandStatus: 0,
        expectedStatus: 1,
        expectedResult: "retryable_failure",
      },
    ].entries()) {
      const outputPath = join(foldFixtureRoot, `github-output-${index}`);
      const execution = spawnSync("bash", ["-c", foldLiveProof.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_NODE_STATUS: String(scenario.commandStatus),
          FAKE_NODE_STDOUT: scenario.stdout,
          GITHUB_OUTPUT: outputPath,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      assert.equal(execution.status, scenario.expectedStatus, scenario.name);
      assert.equal(
        readFileSync(outputPath, "utf8").trim(),
        `result=${scenario.expectedResult}`,
        scenario.name,
      );
    }
  } finally {
    rmSync(foldFixtureRoot, { recursive: true, force: true });
  }
  assert.match(legacyArtifact.run ?? "", /review_lease_owner/);
  assert.match(legacyArtifact.run ?? "", /review_lease_comment_id/);
  assert.doesNotMatch(create.run ?? "", /repair:exact-review-bundle -- create/);
  assert.doesNotMatch(validate.run ?? "", /repair:exact-review-bundle -- validate/);
  assert.ok(publisher.steps.indexOf(validate) < publisher.steps.indexOf(targetWriteStep));
  assert.ok(publisher.steps.indexOf(validate) < publisher.steps.indexOf(stateSetup));
  for (const guardedStep of [
    legacyArtifact,
    step(publisher, "Stage validated exact review artifact"),
    targetWriteStep,
    stateSetup,
    step(publisher, "Publish event result and apply safe close"),
  ]) {
    assert.match(guardedStep.if ?? "", /fold-exact-live-proof\.outcome == 'success'/);
    assert.doesNotMatch(guardedStep.if ?? "", /validate-exact-review-bundle/);
  }
  assert.match(stateSetup.if ?? "", /legacy-exact-artifact\.outputs\.legacy_tupleless != 'true'/);
  assert.match(stateSetup.if ?? "", /direct_lifecycle_recovery != 'true'/);

  const replayDirect = step(publisher, "Replay committed direct lifecycle handoff");
  assert.match(replayDirect.if ?? "", /direct_lifecycle_recovery == 'true'/);
  assert.match(replayDirect.run ?? "", /router_deferred_coverage/);
  assert.match(replayDirect.run ?? "", /router_not_required/);
  assert.match(replayDirect.run ?? "", /repair-comment-router\.yml/);
  assert.match(replayDirect.run ?? "", /lifecycle\/router-receipt/);
  assert.match(replayDirect.run ?? "", /lifecycle\/terminal-disposition/);
  assert.match(replayDirect.run ?? "", /direct_requeue=true/);
  assert.doesNotMatch(replayDirect.run ?? "", /internal\/exact-review\/enqueue/);
  assert.doesNotMatch(replayDirect.run ?? "", /repair:publish-event-result/);
  assert.doesNotMatch(replayDirect.run ?? "", /repair:update-command-status/);
  assert.doesNotMatch(replayDirect.run ?? "", /lifecycle\/command-ack/);

  const publish = step(publisher, "Publish event result and apply safe close");
  assert.match(publish.run ?? "", /live_state=.*gh api/);
  assert.match(publish.run ?? "", /LIVE_TERMINAL_NOOP.*LIVE_TERMINAL_MISSING/);
  assert.match(publish.run ?? "", /LIVE_GUARDED_OPEN/);
  assert.match(publish.run ?? "", /live_locked=.*jq -r '\.locked == true'/);
  assert.match(publish.run ?? "", /live_locked.*true[\s\S]*guarded_open=true/);
  assert.match(publish.run ?? "", /open\)[\s\S]*?requeue_latest=true/);
  assert.match(publish.run ?? "", /test -f "artifacts\/event\/\$ITEM_NUMBER\.md"/);
  assert.match(publish.run ?? "", /repair:publish-event-result/);
  assert.match(publish.run ?? "", /failure_kind=github_rate_limit/);
  assert.match(publish.run ?? "", /failure_kind=github_transient/);
  assert.match(publish.run ?? "", /HTTP 429/);
  assert.doesNotMatch(publish.run ?? "", /HTTP \(403\|429\)/);
  assert.match(publish.run ?? "", /PIPESTATUS\[0\]/);
  assert.equal(publish.env?.EXACT_EVENT_PUBLICATION, "true");
  assert.equal(
    publisher.steps.some((candidate) => candidate.name === "Route synced ClawSweeper verdict"),
    false,
  );
  const deferredRoute = step(publisher, "Queue deferred exact verdict router");
  assert.match(deferredRoute.if ?? "", /publish-event-result\.outcome == 'success'/);
  assert.match(deferredRoute.if ?? "", /routing_deferred == 'true'/);
  assert.match(deferredRoute.run ?? "", /repair-comment-router\.yml/);
  assert.equal(
    deferredRoute.env?.ITEM_NUMBER,
    "${{ steps.publication-context.outputs.item_number }}",
  );
  assert.match(deferredRoute.run ?? "", /-f item_numbers="\$ITEM_NUMBER"/);
  const drift = step(publisher, "Queue fresh review after source drift");
  assert.match(drift.if ?? "", /requeue_latest == 'true'/);
  assert.match(drift.if ?? "", /legacy-exact-artifact\.outputs\.legacy_tupleless == 'true'/);
  assert.match(drift.run ?? "", /x-clawsweeper-exact-review-signature/);
  assert.match(drift.run ?? "", /internal\/exact-review\/enqueue/);
  assert.match(drift.run ?? "", /decision\.sourceAction === "failed_review_shard_recovery"/);
  assert.match(drift.run ?? "", /\.queued == true or \.deduped == true or \.shed == true/);
  assert.match(drift.run ?? "", /Source-drift recovery shed by exact-review queue backpressure/);
  const reaction = step(publisher, "React to target item completion");
  assert.match(reaction.if ?? "", /requeue_latest != 'true'/);
  assert.doesNotMatch(reaction.if ?? "", /publication-context.*live_guarded_open/);
  assert.equal(
    publisher.steps.some((candidate) => candidate.name === "Publish exact review action ledger"),
    false,
  );
  const publishResult = step(publisher, "Export exact review publication result");
  const publishComplete = step(publisher, "Complete durable exact review publication");
  const activeLeaseWaiting = step(publisher, "Mark active lease retry waiting");
  assert.equal(
    publisher.steps.some(
      (candidate) => candidate.name === "Probe GitHub pressure after publication failure",
    ),
    false,
  );
  const releaseTerminal = step(publisher, "Release terminal review leases");
  const releaseUnsuccessful = step(
    publisher,
    "Release superseded or unsuccessful publisher-owned review lease",
  );
  assert.doesNotMatch(releaseTerminal.if ?? "", /publication-context.*live_terminal_noop/);
  assert.match(releaseTerminal.if ?? "", /publish-event-result.*terminal_noop/);
  assert.match(releaseUnsuccessful.run ?? "", /\.user\.login == \\"clawsweeper\[bot\]\\"/);
  assert.match(releaseUnsuccessful.run ?? "", /content == "eyes"/);
  assert.match(releaseUnsuccessful.if ?? "", /completion_kind == 'superseded'/);
  assert.doesNotMatch(releaseUnsuccessful.if ?? "", /completion_kind == 'deferred'/);
  for (const kind of ["github_rate_limit", "github_transient"]) {
    assert.match(
      releaseUnsuccessful.if ?? "",
      new RegExp(`publish-event-result\\.outputs\\.failure_kind != '${kind}'`),
    );
  }
  assert.match(publishResult.env?.PRIOR_JOB_STATUS ?? "", /job\.status/);
  assert.match(publishResult.env?.LEGACY_TUPLELESS ?? "", /legacy-exact-artifact/);
  assert.match(publishResult.env?.FAILURE_KIND ?? "", /publish-event-result/);
  assert.doesNotMatch(publishResult.env?.FAILURE_KIND ?? "", /publication-pressure/);
  assert.match(publishResult.env?.DOWNLOAD_OUTCOME ?? "", /download-exact-review-bundle/);
  assert.match(publishResult.env?.VALIDATE_OUTCOME ?? "", /validate-exact-review-bundle/);
  assert.match(publishResult.env?.LIVE_PROOF_RESULT ?? "", /fold-exact-live-proof/);
  assert.match(publishResult.env?.PUBLISH_COMPLETION_KIND ?? "", /publish-event-result/);
  assert.match(publishResult.env?.PUBLISH_RETRY_AT ?? "", /publish-event-result/);
  assert.match(publishResult.env?.DIRECT_RECOVERY_OUTCOME ?? "", /replay-direct-lifecycle/);
  assert.match(publishResult.env?.DIRECT_RECOVERY_DIRECT_REQUEUE ?? "", /replay-direct-lifecycle/);
  assert.match(publishResult.run ?? "", /DIRECT_RECOVERY_OUTCOME/);
  assert.match(publishResult.run ?? "", /direct_requeue=/);
  assert.match(publishResult.run ?? "", /REQUEUE_LATEST.*SOURCE_DRIFT_OUTCOME/);
  assert.match(publishResult.run ?? "", /LEGACY_TUPLELESS.*SOURCE_DRIFT_OUTCOME/);
  assert.match(publishResult.run ?? "", /completion_kind=superseded/);
  assert.match(publishResult.run ?? "", /completion_kind=deferred/);
  assert.match(publishResult.run ?? "", /completion_kind=refresh_required/);
  assert.match(publishResult.run ?? "", /reason_code=close_coverage_retry/);
  assert.match(publishResult.run ?? "", /reason_code=close_coverage_deferred/);
  assert.match(publishResult.run ?? "", /reason_code=review_lease_active/);
  assert.match(publishResult.run ?? "", /reason_code=review_lease_active[\s\S]*?outcome=success/);
  assert.match(publishResult.run ?? "", /retry_at="\$PUBLISH_RETRY_AT"/);
  assert.match(
    publishResult.run ?? "",
    /reason_code="\$FAILURE_KIND"\s+retry_at="\$PUBLISH_RETRY_AT"/,
  );
  assert.match(
    publishResult.run ?? "",
    /completion_kind" != "superseded".*completion_kind" != "deferred".*completion_kind" != "refresh_required".*completion_kind" != "retryable_failure"/,
  );
  assert.match(publishResult.run ?? "", /reason_code=artifact_unavailable/);
  assert.match(publishResult.run ?? "", /reason_code=invalid_artifact/);
  assert.match(
    publishResult.run ?? "",
    /LIVE_PROOF_RESULT.*invalid_artifact[\s\S]*completion_kind=refresh_required[\s\S]*reason_code=invalid_artifact/,
  );
  const runPublicationResult = (liveProofResult: string) => {
    const publicationResultRoot = mkdtempSync(`${tmpPrefix}live-proof-result-`);
    const publicationResultOutput = join(publicationResultRoot, "github-output");
    try {
      execFileSync("bash", ["-c", publishResult.run ?? ""], {
        env: {
          ...process.env,
          PRIOR_JOB_STATUS: "failure",
          PUBLISH_OUTCOME: "",
          TERMINAL_NOOP: "",
          TERMINAL_MISSING: "",
          TERMINAL_CLOSED: "",
          GUARDED_OPEN: "",
          POLICY_NOOP: "",
          REQUEUE_LATEST: "",
          LEGACY_TUPLELESS: "",
          SOURCE_DRIFT_OUTCOME: "",
          DEFERRED_ROUTE_OUTCOME: "",
          FAILURE_KIND: "",
          DOWNLOAD_OUTCOME: "success",
          VALIDATE_OUTCOME: "success",
          LIVE_PROOF_RESULT: liveProofResult,
          PUBLISH_COMPLETION_KIND: "",
          PUBLISH_REASON_CODE: "",
          PUBLISH_RETRY_AT: "",
          ERROR_FINGERPRINT: "",
          STATE_WRITER_JSON: "",
          DIRECT_RECOVERY_OUTCOME: "",
          DIRECT_RECOVERY_COMPLETION_KIND: "",
          DIRECT_RECOVERY_REASON_CODE: "",
          DIRECT_RECOVERY_REQUEUE_LATEST: "",
          DIRECT_RECOVERY_DIRECT_REQUEUE: "",
          REVIEW_ONLY: "false",
          GITHUB_OUTPUT: publicationResultOutput,
        },
      });
      return Object.fromEntries(
        readFileSync(publicationResultOutput, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    } finally {
      rmSync(publicationResultRoot, { recursive: true, force: true });
    }
  };
  assert.deepEqual(runPublicationResult("invalid_artifact"), {
    outcome: "success",
    completion_kind: "refresh_required",
    reason_code: "invalid_artifact",
    requeue_latest: "",
    direct_requeue: "false",
  });
  assert.deepEqual(runPublicationResult("retryable_failure"), {
    outcome: "failure",
    completion_kind: "retryable_failure",
    reason_code: "unknown_failure",
    requeue_latest: "",
    direct_requeue: "false",
  });
  assert.doesNotMatch(publishResult.run ?? "", /LIVE_TERMINAL_NOOP/);
  assert.match(publishComplete.run ?? "", /internal\/exact-review\/complete/);
  assert.match(publishComplete.env?.FAILURE_KIND ?? "", /exact-review-publication-result/);
  assert.match(publishComplete.env?.RETRY_AT ?? "", /exact-review-publication-result/);
  assert.match(publishComplete.run ?? "", /failure_kind: failureKind/);
  assert.match(publishComplete.run ?? "", /completion_kind: completionKind/);
  assert.match(publishComplete.run ?? "", /reason_code: reasonCode/);
  assert.match(publishComplete.run ?? "", /retry_at: retryAt/);
  assert.match(
    publishComplete.env?.DIRECT_LIFECYCLE_REQUEUE ?? "",
    /exact-review-publication-result/,
  );
  assert.match(publishComplete.run ?? "", /direct_lifecycle_requeue/);
  assert.ok(publisher.steps.indexOf(publishResult) < publisher.steps.indexOf(publishComplete));
  assert.ok(publisher.steps.indexOf(publishComplete) < publisher.steps.indexOf(activeLeaseWaiting));
  assert.match(activeLeaseWaiting.if ?? "", /reason_code == 'review_lease_active'/);
  assert.match(
    activeLeaseWaiting.if ?? "",
    /complete-exact-review-publication\.outcome == 'success'/,
  );
  assert.match(activeLeaseWaiting.run ?? "", /--state "Waiting"/);

  const publisherSource = readText("src/repair/publish-event-result.ts");
  assert.match(
    publisherSource,
    /exactEventPublication: process\.env\.EXACT_EVENT_PUBLICATION === "true"/,
  );
  assert.match(publisherSource, /"--exact-event-publication"/);
  assert.match(publisherSource, /legacyTuplelessReviewLease/);
  assert.match(publisherSource, /activeReviewLeaseRetryAt/);
  assert.match(publisherSource, /review_lease_active/);
  assert.match(publisherSource, /applyDisposition === "close_coverage_deferred"/);
  assert.match(publisherSource, /EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED/);
  assert.match(publisherSource, /writeLegacyRefreshRequiredOutputs/);
  assert.match(publisherSource, /read-only apply-proof lane/);
  assert.match(publisherSource, /deferredCloseCoverageExpected/);
  assert.match(publisherSource, /deferredCloseCoverageExpected && !candidateMatchesCurrentTuple/);
  assert.match(publisherSource, /prepareTupleMutationPlan/);
  assert.match(publisherSource, /\}\) && !deferredCloseCoverage/);
  assert.match(publisherSource, /writePublicationCompletionOutputs\(\s*"superseded"/);
  assert.match(publisherSource, /completionKind: completionSupersededReason/);
  const reviewSource = [
    readText("src/clawsweeper-runtime.ts"),
    readText("src/clawsweeper-command-operations.ts"),
    readText("src/clawsweeper-apply-decision-workflow.ts"),
    readText("src/clawsweeper-apply-source-freshness.ts"),
  ].join("\n");
  assert.match(reviewSource, /reserveReviewLeaseCommand/);
  assert.match(reviewSource, /suppliedReviewStartLeaseFromArgs/);
  assert.match(reviewSource, /exactEventReviewLeaseDisposition/);
  assert.match(reviewSource, /retryCloseCoverageCommandStatusOnlyUpdate/);
  assert.match(reviewSource, /clawsweeper-command-status:/);
  assert.match(reviewSource, /CLAWSWEEPER_BOT_AUTHORS\.has/);
  const completeStart = publisherSource.indexOf("const complete =");
  assert.ok(completeStart >= 0);
  assert.match(publisherSource, /await postDirectPublicationResult/);
  assert.match(publisherSource, /\/internal\/exact-review\/publication-batch-results/);
  assert.doesNotMatch(publisherSource, /\bstagePaths\b|\bpushSingleRecordTupleCommit\b/);
  assert.doesNotMatch(publisherSource, /GitCommandTimeoutError|publishRoot|hardResetToRemoteMain/);
  assert.match(publisherSource, /const retryableFailure =/);
  assert.match(publisherSource, /error instanceof GitHubRateLimitError/);
  assert.match(publisherSource, /error\.retryAt : undefined/);
  assert.match(publisherSource, /failure_kind=\$\{reasonCode\}/);
  assert.match(publisherSource, /publication\.status === 429/);
  assert.match(publisherSource, /\? "state_contention"\s*: "policy_invariant"/);
  assert.doesNotMatch(publisherSource, /attempt <= 20|Event publish attempt/);
  assert.doesNotMatch(publisherSource, /retryableFailure \? "github_transient" : undefined/);
  const directPublisherSource = readText("src/repair/exact-review-direct-publication.ts");
  assert.match(directPublisherSource, /invalid_direct_source_action/);
  assert.match(directPublisherSource, /router_deferred_coverage/);
  assert.match(directPublisherSource, /failed_review_shard_recovery/);
  assert.match(publishComplete.run ?? "", /"state_contention"/);
  assert.ok(
    publisherSource.indexOf("eventSnapshotMatchesCurrent(paths)", completeStart) > completeStart,
  );
});

test("scheduled review shards retire automatic live proof without removing historical publication", () => {
  type Step = {
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number | boolean>;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const reviewSteps = workflow.jobs.review!.steps;
  for (const name of [
    "Inspect review-shard live proofs",
    "Resolve review-shard live-proof Go version",
    "Set up review-shard live-proof Go toolchain",
    "Enable review-shard live-proof automatic Go fallback",
    "Install review-shard terminal tools",
    "Install review-shard recording tools",
    "Execute review-shard live proofs",
  ]) {
    assert.equal(
      reviewSteps.some((candidate) => candidate.name === name),
      false,
      `retired automatic live-proof step remains: ${name}`,
    );
  }

  const metrics = reviewSteps.find((candidate) => candidate.name === "Record shard metrics");
  assert.ok(metrics);
  assert.doesNotMatch(JSON.stringify(metrics), /live[_-]proof/i);
  const upload = reviewSteps.find(
    (candidate) => candidate.with?.name === "review-shard-${{ matrix.shard }}",
  );
  assert.ok(upload);
  assert.match(upload.if ?? "", /review-shard\.outcome/);
  assert.match(String(upload.with?.path), /review-artifacts\/shard-/);
  assert.doesNotMatch(String(upload.with?.path), /live-proof/);

  assert.ok(
    workflow.jobs.publish!.steps.some(
      (candidate) => candidate.name === "Fold live proofs into review artifacts",
    ),
  );
  assert.ok(
    workflow.jobs["event-review-publish"]!.steps.some(
      (candidate) => candidate.name === "Fold exact live proof into the review artifact",
    ),
  );
});

test("exact event publication derives lifecycle receipt and final command acknowledgement from the projection", () => {
  type Step = {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    with?: Record<string, string | number | boolean>;
    env?: Record<string, string>;
    run?: string;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { if?: string; steps: Step[] }>;
  };
  const steps = workflow.jobs["event-review-publish"]!.steps;
  const step = (name: string) => {
    const value = steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing step: ${name}`);
    return value;
  };
  const router = step("Queue deferred exact verdict router");
  const canonical = step("Record fallback canonical exact review lifecycle receipt");
  assert.match(canonical.if ?? "", /remote_tuple_verified == 'true'/);
  assert.match(canonical.run ?? "", /outcome: "accepted"/);
  assert.match(canonical.run ?? "", /fallback:/);
  assert.match(canonical.run ?? "", /internal\/exact-review\/lifecycle\/canonical-receipt/);
  assert.ok(steps.indexOf(canonical) < steps.indexOf(router));
  assert.equal(
    router.env?.FENCE_KEY,
    "${{ steps.publication-context.outputs.publisher_item_key }}",
  );
  assert.equal(
    router.env?.REVISION,
    "${{ steps.publication-context.outputs.publisher_lease_revision }}",
  );
  assert.match(router.run ?? "", /internal\/exact-review\/lifecycle\/router-receipt/);
  assert.match(router.run ?? "", /canonical_target_key/);
  assert.match(router.run ?? "", /receipt_id: `router:\$\{process\.env\.GITHUB_RUN_ID\}/);

  const deferredCloseProof = step("Record deferred close-proof exact review lifecycle receipt");
  assert.match(deferredCloseProof.if ?? "", /completion_kind == 'deferred'/);
  assert.match(deferredCloseProof.if ?? "", /reason_code == 'close_coverage_deferred'/);
  assert.match(deferredCloseProof.run ?? "", /outcome: "durable"/);
  assert.match(deferredCloseProof.run ?? "", /router-proof:/);
  assert.match(deferredCloseProof.run ?? "", /internal\/exact-review\/lifecycle\/router-receipt/);

  const noRouter = step("Record no-router exact review lifecycle receipt");
  assert.match(noRouter.if ?? "", /failed_review_shard_recovery/);
  assert.match(noRouter.run ?? "", /outcome: "not_required"/);
  assert.match(noRouter.run ?? "", /internal\/exact-review\/lifecycle\/router-receipt/);

  const deferredDispatch = step("Dispatch deferred high-confidence bug implementation");
  assert.match(deferredDispatch.run ?? "", /dispatch-issue-implementation-candidates\.mjs/);
  assert.ok(steps.indexOf(canonical) < steps.indexOf(deferredDispatch));
  assert.ok(steps.indexOf(router) < steps.indexOf(deferredDispatch));
  assert.ok(steps.indexOf(noRouter) < steps.indexOf(deferredDispatch));

  const complete = step("Complete durable exact review publication");
  assert.match(
    complete.run ?? "",
    /\["retryable_failure", "refresh_required"\]\.includes\(completionKind\)/,
  );
  assert.doesNotMatch(complete.run ?? "", /outcome !== "success"\s*\?\s*"failure"/);
  assert.match(complete.run ?? "", /completionKind === "permanent_failure"\s*\? "failure"/);
  const finalizer = workflow.jobs["event-review-terminal-finalization"]!;
  const finalizationCheckout = finalizer.steps.find((candidate) =>
    candidate.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(finalizationCheckout?.with?.filter, undefined);
  assert.equal(finalizationCheckout?.with?.["fetch-depth"], 1);
  const finalizationClaim = finalizer.steps.find(
    (candidate) => candidate.name === "Claim committed terminal finalization",
  );
  const acknowledgement = finalizer.steps.find(
    (candidate) => candidate.name === "Begin fenced terminal acknowledgement",
  );
  const statusEdit = finalizer.steps.find(
    (candidate) => candidate.name === "Update final command status once",
  );
  const observedReceipt = finalizer.steps.find(
    (candidate) => candidate.name === "Record verified terminal acknowledgement receipt",
  );
  const retry = finalizer.steps.find(
    (candidate) => candidate.name === "Requeue unobserved terminal acknowledgement",
  );
  const lockedSkip = finalizer.steps.find(
    (candidate) => candidate.name === "Complete locked terminal acknowledgement skip",
  );
  assert.ok(
    finalizationClaim && acknowledgement && statusEdit && observedReceipt && lockedSkip && retry,
  );
  assert.match(finalizer.if ?? "", /exact_review_command_acknowledgement/);
  assert.match(finalizationClaim.run ?? "", /terminal_finalization/);
  assert.match(finalizationClaim.run ?? "", /lifecycle_projection/);
  assert.match(finalizationClaim.run ?? "", /lifecycle_fence_key/);
  assert.match(finalizationClaim.run ?? "", /lifecycle_revision/);
  assert.match(finalizationClaim.run ?? "", /response\.item_key !== process\.env\.ITEM_KEY/);
  assert.doesNotMatch(finalizationClaim.run ?? "", /expectedItemKey/);
  assert.match(finalizationClaim.run ?? "", /lease_not_active/);
  assert.match(finalizationClaim.run ?? "", /lease_already_claimed/);
  assert.match(
    finalizationClaim.run ?? "",
    /Skipping terminal finalization because lease claim lost safely/,
  );
  assert.match(acknowledgement.run ?? "", /terminal-finalization\/attempt/);
  assert.match(statusEdit.if ?? "", /terminal-acknowledgement\.outputs\.allowed == 'true'/);
  assert.match(statusEdit.run ?? "", /--require-mutation/);
  assert.match(statusEdit.run ?? "", /--locked-conversation-terminal-skip/);
  assert.match(statusEdit.run ?? "", /--verify-terminal-status-receipt/);
  assert.match(statusEdit.run ?? "", /command-ack\/failed/);
  assert.equal(
    statusEdit.env?.FENCE_KEY,
    "${{ steps.finalization-context.outputs.lifecycle_fence_key }}",
  );
  assert.equal(
    statusEdit.env?.REVISION,
    "${{ steps.finalization-context.outputs.lifecycle_revision }}",
  );
  assert.match(observedReceipt.if ?? "", /terminal_status_verified == 'true'/);
  assert.equal(
    observedReceipt.env?.FENCE_KEY,
    "${{ steps.finalization-context.outputs.lifecycle_fence_key }}",
  );
  assert.equal(
    observedReceipt.env?.REVISION,
    "${{ steps.finalization-context.outputs.lifecycle_revision }}",
  );
  assert.equal(
    observedReceipt.env?.STATUS_COMMENT_ID,
    "${{ steps.finalization-context.outputs.status_comment_id }}",
  );
  assert.match(observedReceipt.run ?? "", /lifecycle\/command-ack\/observed/);
  assert.match(
    observedReceipt.run ?? "",
    /const statusMarker = process\.env\.STATUS_MARKER \|\| null/,
  );
  assert.match(
    observedReceipt.run ?? "",
    /const statusCommentId = process\.env\.STATUS_COMMENT_ID/,
  );
  assert.match(observedReceipt.run ?? "", /fence_key: fenceKey/);
  assert.match(observedReceipt.run ?? "", /revision,/);
  assert.match(
    observedReceipt.run ?? "",
    /\.\.\.\(statusMarker \? \{ status_marker: statusMarker \} : \{\}\)/,
  );
  assert.match(observedReceipt.run ?? "", /command_comment_id: commandCommentId/);
  assert.match(
    observedReceipt.run ?? "",
    /\.\.\.\(statusCommentId === null \? \{\} : \{ status_comment_id: statusCommentId \}\)/,
  );
  assert.match(observedReceipt.run ?? "", /completion_comment_id: completionCommentId/);
  assert.match(observedReceipt.run ?? "", /completed_at: completedAt/);
  assert.equal(
    observedReceipt.env?.COMPLETION_COMPLETED_AT,
    "${{ steps.update-final-command-status.outputs.completion_completed_at }}",
  );
  assert.match(observedReceipt.run ?? "", /acknowledgement_state == "observed"/);
  assert.match(lockedSkip.if ?? "", /locked_conversation == 'true'/);
  assert.match(lockedSkip.if ?? "", /missing_status_comment == 'true'/);
  assert.match(lockedSkip.run ?? "", /terminal-finalization\/skip/);
  assert.match(lockedSkip.run ?? "", /locked_conversation/);
  assert.match(lockedSkip.run ?? "", /skip_reason="missing_status_comment"/);
  assert.match(lockedSkip.run ?? "", /expected_state="skipped_missing_comment"/);
  assert.match(lockedSkip.run ?? "", /acknowledgement_state == \$state/);
  assert.equal(
    lockedSkip.env?.MISSING_STATUS_COMMENT,
    "${{ steps.update-final-command-status.outputs.missing_status_comment }}",
  );
  assert.match(retry.run ?? "", /terminal-finalization\/retry/);
  assert.match(retry.if ?? "", /observe-verified-terminal-acknowledgement\.outcome != 'success'/);
  assert.match(
    retry.if ?? "",
    /!\(\(steps\.update-final-command-status\.outputs\.locked_conversation == 'true' \|\| steps\.update-final-command-status\.outputs\.missing_status_comment == 'true'\) && steps\.complete-locked-terminal-acknowledgement\.outcome == 'success'\)/,
  );
  assert.match(retry.run ?? "", /response_status/);
  assert.match(retry.run ?? "", /lease_not_active/);
  assert.match(
    statusEdit?.run ?? "",
    /rate limit exceeded\|secondary rate limit\|HTTP 429/,
    "throttled terminal status updates must be marked for the failure sentinel",
  );
  assert.match(statusEdit?.run ?? "", /throttled=true/);
  const failSentinel = finalizer.steps.find(
    (candidate) => candidate.name === "Fail failed terminal acknowledgement",
  );
  assert.match(
    failSentinel?.if ?? "",
    /update-final-command-status\.outcome == 'failure' && steps\.update-final-command-status\.outputs\.throttled != 'true'/,
    "a throttled update must not red the run — the requeue step already re-arms the driver",
  );
  const workflowSource = readText(".github/workflows/sweep.yml");
  assert.ok(
    workflowSource.indexOf("Complete durable exact review publication") <
      workflowSource.indexOf("Claim committed terminal finalization"),
  );
});

test("exact event workflow binds all work to the canonical queue claim", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventStart = workflow.indexOf("\n  event-review-apply:");
  const eventEnd = workflow.indexOf("\n  event-review-publish:", eventStart);
  const eventJob = workflow.slice(eventStart, eventEnd);
  const claimStart = eventJob.indexOf("- name: Claim exact-review queue lease");
  const checkoutStart = eventJob.indexOf("- uses: actions/checkout@v7", claimStart);
  const claimStep = eventJob.slice(claimStart, checkoutStart);
  const claimedWork = eventJob.slice(checkoutStart);

  assert.match(
    claimStep,
    /ITEM_KEY: \$\{\{ github\.event\.client_payload\.queue_claim\.item_key \|\| github\.event\.client_payload\.item_key \}\}/,
  );
  assert.match(
    claimStep,
    /QUEUE_LEASE_REVISION: \$\{\{ github\.event\.client_payload\.queue_claim\.lease_revision \|\| github\.event\.client_payload\.lease_revision \}\}/,
  );
  assert.match(
    claimStep,
    /hasTuple \? \{ item_key: itemKey, lease_revision: leaseRevision \} : \{\}/,
  );
  assert.match(claimStep, /response\.item_key !== requestedItemKey/);
  assert.match(claimStep, /response\.lease_revision !== requestedLeaseRevision/);
  assert.match(claimStep, /const itemKey = `\$\{targetRepo\}#\$\{itemNumber\}`/);
  assert.match(claimStep, /claim_generation=\$\{responseProtocol === 2 \? claimGeneration : ""\}/);
  assert.match(claimStep, /protocol_version=\$\{responseProtocol\}/);
  assert.match(claimStep, /decision=\$\{JSON\.stringify\(decision\)\}/);
  assert.doesNotMatch(claimedWork, /github\.event\.client_payload/);
  assert.match(
    claimedWork,
    /CLAIM_TARGET_BRANCH: \$\{\{ fromJSON\(steps\.claim-exact-review-queue\.outputs\.decision\)\.targetBranch \}\}/,
  );
  assert.match(claimedWork, /target_branch="\$CLAIM_TARGET_BRANCH"/);
  assert.match(claimedWork, /if \.pull_request then "pull_request" else "issue" end/);
  assert.match(claimedWork, /steps\.live-item\.outputs\.target_branch/);
  assert.match(
    claimedWork,
    /CLAIM_DECISION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.decision \}\}/,
  );
  assert.match(
    claimedWork,
    /const decision = JSON\.parse\(process\.env\.CLAIM_DECISION \|\| "\{\}"\)/,
  );
  assert.match(
    claimedWork,
    /targetRepo !== "openclaw\/clawhub" \|\| process\.env\.CLAWHUB_ENABLED === "1"/,
  );
  assert.match(
    claimedWork,
    /Create target read token[\s\S]*steps\.target\.outputs\.target_enabled == 'true'/,
  );
  assert.match(
    claimedWork,
    /Check live target item state[\s\S]*steps\.target\.outputs\.target_enabled == 'true'/,
  );
  assert.match(
    claimedWork,
    /Create exact review artifact bundle[\s\S]*steps\.target\.outputs\.target_enabled == 'true'/,
  );
  assert.match(
    claimedWork,
    /CLAIM_GENERATION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.claim_generation \}\}/,
  );
  assert.match(
    claimedWork,
    /PROTOCOL_VERSION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.protocol_version \}\}/,
  );
  assert.match(claimedWork, /item_key: process\.env\.ITEM_KEY/);
  assert.match(claimedWork, /lease_revision: leaseRevision/);
  assert.match(claimedWork, /claim_generation: claimGeneration/);
});

test("exact event review heartbeats its queue lease while Codex runs", () => {
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const review = workflow.jobs["event-review-apply"]!.steps.find(
    (candidate) => candidate.name === "Review exact event item",
  );
  assert.ok(review);
  assert.match(review.env?.EXACT_REVIEW_ITEM_KEY ?? "", /claim-exact-review-queue/);
  assert.match(review.env?.EXACT_REVIEW_LEASE_ID ?? "", /claim-exact-review-queue/);
  assert.match(review.env?.EXACT_REVIEW_LEASE_REVISION ?? "", /claim-exact-review-queue/);
  // The Codex-adjacent review step must never receive the shared webhook secret;
  // the heartbeat authenticates by lease tuple like /claim and /complete.
  assert.equal(review.env?.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  assert.match(review.run ?? "", /item_key: process\.env\.EXACT_REVIEW_ITEM_KEY/);
  assert.match(review.run ?? "", /lease_id: process\.env\.EXACT_REVIEW_LEASE_ID/);
  assert.match(review.run ?? "", /lease_revision: leaseRevision/);
  assert.match(review.run ?? "", /run_id: process\.env\.GITHUB_RUN_ID/);
  assert.doesNotMatch(review.run ?? "", /x-clawsweeper-exact-review-signature/);
  assert.doesNotMatch(review.run ?? "", /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(review.run ?? "", /internal\/exact-review\/heartbeat/);
  assert.match(review.run ?? "", /^\s*sleep 60\s*$/m);
  assert.match(review.run ?? "", /heartbeat_payload=.*\|\| return 0/s);
  assert.doesNotMatch(review.run ?? "", /test -n "\$CLAWSWEEPER_WEBHOOK_SECRET"/);
  assert.match(review.run ?? "", /trap cleanup_heartbeat EXIT/);
  assert.match(review.run ?? "", /kill "\$heartbeat_pid" 2>\/dev\/null \|\| true/);
  assert.match(review.run ?? "", /setsid timeout --kill-after=30s/);
  assert.match(review.run ?? "", /review_pgid=\$review_pid/);
  assert.match(review.run ?? "", /kill -TERM -- "-\$review_pgid"/);
  assert.match(review.run ?? "", /kill -KILL -- "-\$review_pgid"/);
  assert.match(review.run ?? "", /wait_for_review_group/);

  const publisher = workflow.jobs["event-review-publish"]!;
  assert.equal(
    publisher.steps.some((step) => step.run?.includes("internal/exact-review/heartbeat")),
    false,
  );
});

test("exact-review lease competition skips only known conflicts and gates both owners", () => {
  type Step = { name?: string; uses?: string; if?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };

  for (const [jobName, claimId] of [
    ["event-review-apply", "claim-exact-review-queue"],
    ["event-review-publish", "publication-context"],
  ]) {
    const steps = workflow.jobs[jobName]!.steps;
    const claim = steps[0]!;
    const claimRun = claim.run ?? "";
    const gate = `steps.${claimId}.outputs.claimed == 'true'`;

    assert.match(claimRun, /printf 'claimed=false\\ndecision=\{\}\\n'/, jobName);
    assert.match(claimRun, /--write-out '%\{http_code\}'/, jobName);
    assert.match(claimRun, /if \[ "\$status" = "409" \]/, jobName);
    for (const reason of [
      "lease_not_active",
      "lease_already_claimed",
      "lease_decision_unavailable",
      "stale_run_attempt",
    ]) {
      assert.match(claimRun, new RegExp(`"${reason}"`), `${jobName}: ${reason}`);
    }
    assert.match(claimRun, /if \(!safeConflicts\.has\(response\.error\)\) process\.exit\(1\)/);
    assert.match(claimRun, /if \[ "\$status" != "200" \]/, jobName);
    assert.match(claimRun, /if \[\[ "\$status" != 5\* \]\]/, jobName);
    assert.match(claimRun, /returned an invalid success payload/, jobName);
    assert.doesNotMatch(claimRun, /curl --fail/, jobName);

    for (const step of steps.slice(1).filter((candidate) => candidate.if !== "${{ false }}")) {
      assert.match(step.if ?? "", new RegExp(gate.replaceAll(".", "\\.")), step.name ?? step.uses);
    }
  }
});

test("exact event workflow keeps both queue protocol versions live during rolling deploys", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventStart = workflow.indexOf("\n  event-review-apply:");
  const eventEnd = workflow.indexOf("\n  target-fanout:", eventStart);
  const eventJob = workflow.slice(eventStart, eventEnd);
  const claimStart = eventJob.indexOf("- name: Claim exact-review queue lease");
  const checkoutStart = eventJob.indexOf("- uses: actions/checkout@v7", claimStart);
  const claimStep = eventJob.slice(claimStart, checkoutStart);
  const completeStart = eventJob.indexOf("- name: Complete exact-review queue lease");
  const completeEnd = eventJob.indexOf("\n      - ", completeStart + 1);
  const completeStep = eventJob.slice(completeStart, completeEnd);

  assert.match(claimStep, /DISPATCH_PAYLOAD: \$\{\{ toJSON\(github\.event\.client_payload\) \}\}/);
  assert.match(claimStep, /const responseProtocol = Number\(response\.protocol_version \|\| 1\)/);
  assert.match(claimStep, /const legacyDecision = \{/);
  assert.match(claimStep, /response\.decision && typeof response\.decision === "object"/);
  assert.match(claimStep, /reviewOptions\.command_status_marker/);
  assert.match(claimStep, /responseProtocol === 2/);
  assert.match(completeStep, /protocolVersion !== 1 && protocolVersion !== 2/);
  assert.match(completeStep, /protocolVersion === 2/);
  assert.match(completeStep, /: \{\}\),/);
});

test("dashboard syncs Worker secrets with durable lifecycle storage", () => {
  const workflow = readText(".github/workflows/dashboard.yml");
  const smoke = readText("scripts/dashboard-smoke.mjs");
  const config = readText("dashboard/wrangler.toml");

  assert.doesNotMatch(workflow, /storage\/kv\/namespaces/);
  assert.match(config, /\[\[durable_objects\.bindings\]\]/);
  assert.match(config, /name = "STATUS_STORE"/);
  assert.match(config, /class_name = "StatusStore"/);
  assert.match(config, /new_sqlite_classes = \["StatusStore"\]/);
  assert.match(workflow, /workers\/scripts\/\$CLOUDFLARE_WORKER_NAME\/secrets-bulk/);
  assert.match(workflow, /Content-Type: application\/merge-patch\+json/);
  assert.match(workflow, /jq -e '\.success == true'/);
  assert.doesNotMatch(workflow, /wrangler@[^\s]+ secret bulk/);
  assert.match(workflow, /CLAWSWEEPER_EXPECTED_DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /CLAWSWEEPER_DEPLOY_SHA = "%s"/);
  assert.match(workflow, /"\$GITHUB_SHA"/);
  assert.match(smoke, /waitForDashboardDeployment/);
  assert.match(smoke, /\/internal\/exact-review\/reconcile/);
  assert.match(smoke, /method: "POST"/);
  assert.match(smoke, /reconcileResponse\.status !== 401/);
});

test("dashboard CI refreshes on cadence without completion-trigger storms", () => {
  const workflow = readText(".github/workflows/dashboard-ci.yml");
  const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("\npermissions:"));
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("\njobs:"));

  assert.match(triggers, /workflow_dispatch:/);
  assert.match(triggers, /schedule:\s+- cron: "\*\/5 \* \* \* \*"/);
  assert.doesNotMatch(triggers, /workflow_run:/);
  assert.match(concurrency, /group: clawsweeper-live-dashboard-ci/);
  assert.match(concurrency, /cancel-in-progress: true/);
});

test("terminal exact-review runs reconcile through a signed isolated backstop", () => {
  const workflow = readText(".github/workflows/exact-review-reconcile.yml");
  const eventJob = workflow.slice(
    workflow.indexOf("\n  reconcile:"),
    workflow.indexOf("\n  sweep:"),
  );

  assert.match(workflow, /name: Reconcile exact-review leases/);
  assert.match(workflow, /workflow_run:\s+workflows: \[ClawSweeper\]\s+types: \[completed\]/);
  assert.match(workflow, /schedule:\s+- cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(
    workflow,
    /group: exact-review-reconcile-\$\{\{ github\.event_name == 'workflow_run' && format\('\{0\}-\{1\}', github\.event\.workflow_run\.id, github\.event\.workflow_run\.run_attempt\) \|\| 'sweep' \}\}/,
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(eventJob, /if: >-\s+\$\{\{\s+github\.event_name == 'workflow_run' &&/);
  assert.match(eventJob, /permissions:\s+actions: read\s+contents: read/);
  assert.match(eventJob, /github\.event\.workflow_run\.event == 'repository_dispatch'/);
  assert.match(
    eventJob,
    /startsWith\(github\.event\.workflow_run\.display_title, 'Review event item '\)/,
  );
  for (const prefix of [
    "Review manual item",
    "Review manual batch ",
    "Review manual hot target",
    "Review manual target",
  ]) {
    assert.match(
      eventJob,
      new RegExp(`startsWith\\(github\\.event\\.workflow_run\\.display_title, '${prefix}'\\)`),
      prefix,
    );
  }
  assert.match(
    eventJob,
    /SOURCE_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/,
  );
  assert.match(eventJob, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(eventJob, /run_id: process\.env\.SOURCE_RUN_ID/);
  assert.match(eventJob, /run_attempt: runAttempt/);
  assert.match(eventJob, /include_all_claimed: true/);
  assert.match(eventJob, /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(eventJob, /x-clawsweeper-exact-review-signature: \$signature/);
  assert.match(eventJob, /--max-time 120/);
  assert.match(eventJob, /--data-binary "\$payload"/);
  assert.match(eventJob, /\/internal\/exact-review\/reconcile/);
  assert.match(eventJob, /actions\/checkout@v7/);
  assert.match(eventJob, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(eventJob, /persist-credentials: false/);
  assert.match(eventJob, /node scripts\/review-run-observer\.mjs --event-file/);
  assert.match(eventJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);

  const sweepJob = workflow.slice(workflow.indexOf("\n  sweep:"));
  assert.match(sweepJob, /timeout-minutes: 10/);
  assert.match(
    sweepJob,
    /permissions:\s+actions: read\s+contents: read\s+issues: read\s+pull-requests: read/,
  );
  assert.match(sweepJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(sweepJob, /\/internal\/exact-review\/claimed-runs/);
  assert.match(sweepJob, /include_all_claimed: true/);
  assert.match(sweepJob, /actions\/runs\/\$\{runId\}\$\{suffix\}/);
  assert.match(sweepJob, /terminal_runs: terminalRuns/);
  assert.match(sweepJob, /\/internal\/exact-review\/reconcile/);
  assert.match(sweepJob, /x-clawsweeper-exact-review-signature/);
  assert.match(sweepJob, /actions\/checkout@v7/);
  assert.match(sweepJob, /build-script: build/);
  assert.match(sweepJob, /name: Create target write token/);
  // GitHub's label endpoint lives under /issues but needs pull-requests write
  // when the item is a pull request; issues write alone 403s every
  // pull-request escalation.
  assert.match(
    sweepJob,
    /owner: openclaw\s+repositories: openclaw\s+permission-issues: write\s+permission-pull-requests: write/,
  );
  assert.match(sweepJob, /name: Recover orphaned review placeholders/);
  assert.match(sweepJob, /run: node dist\/review-placeholder-recovery\.js/);
  assert.match(
    sweepJob,
    /TARGET_WRITE_TOKEN: \$\{\{ steps\.target-write-token\.outputs\.token \}\}/,
  );
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_MAX_CHECKS: \$\{\{ vars\.REVIEW_PLACEHOLDER_MAX_CHECKS \|\| '20' \}\}/,
  );
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_CURSOR_STORE_URL: \$\{\{ vars\.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL \|\| 'https:\/\/clawsweeper\.openclaw\.ai' \}\}/,
  );
  assert.doesNotMatch(sweepJob, /REVIEW_PLACEHOLDER_BACKLOG_ALERT/);
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_MAX_RECOVERIES: \$\{\{ vars\.REVIEW_PLACEHOLDER_MAX_RECOVERIES \|\| '5' \}\}/,
  );
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_MIN_AGE_HOURS: \$\{\{ vars\.REVIEW_PLACEHOLDER_MIN_AGE_HOURS \|\| '2' \}\}/,
  );
  assert.match(sweepJob, /TARGET_REPO: openclaw\/openclaw/);
});

test("publish workflow dispatches immediate apply through the isolated lane", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publishJobStart = workflow.indexOf("\n  publish:");
  const recoverJobStart = workflow.indexOf("\n  recover-review-failures:", publishJobStart);
  const publishJob = workflow.slice(publishJobStart, recoverJobStart);
  const dispatchStart = publishJob.indexOf(
    "- name: Dispatch selected safe close proposals to isolated apply",
  );
  const dispatchEnd = publishJob.indexOf("\n      - ", dispatchStart + 1);
  const dispatchStep = publishJob.slice(dispatchStart, dispatchEnd);
  const dispatchCondition = dispatchStep.match(/^\s+if: (.+)$/m)?.[1] ?? "";

  assert.doesNotMatch(publishJob, /setup-codex/);
  assert.match(publishJob, /name: Dispatch selected safe close proposals to isolated apply/);
  assert.doesNotMatch(dispatchStep, /pnpm run apply-decisions/);
  assert.match(
    dispatchCondition,
    /^\$\{\{ always\(\) && !cancelled\(\) && steps\.sync-selected-review-comments\.outputs\.sync_succeeded == 'true'/,
  );
  assert.doesNotMatch(dispatchCondition, /sync-selected-review-comments\.outcome/);
  assert.doesNotMatch(dispatchCondition, /finalize-selected-review-comment-action-ledger/);
  assert.doesNotMatch(dispatchCondition, /publish-selected-review-comment-action-ledger/);
  assert.match(dispatchStep, /gh workflow run sweep\.yml/);
  assert.match(dispatchStep, /-f apply_existing=true/);
  assert.match(dispatchStep, /-f apply_item_numbers="\$item_numbers"/);
  assert.match(
    publishJob,
    /group: clawsweeper-target-review-publish-\$\{\{ needs\.plan\.outputs\.target_repo \}\}/,
  );
  assert.match(publishJob, /cancel-in-progress: false/);
  assert.match(publishJob, /queue: max/);
});

test("selected comment sync finalizes interrupted receipts before publication", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publishJobStart = workflow.indexOf("\n  publish:");
  const recoverJobStart = workflow.indexOf("\n  recover-review-failures:", publishJobStart);
  const publishJob = workflow.slice(publishJobStart, recoverJobStart);
  const syncStart = publishJob.indexOf("- name: Sync selected review comments");
  const finalizerStart = publishJob.indexOf(
    "- name: Finalize selected review comment action ledger",
  );
  const publicationStart = publishJob.indexOf(
    "- name: Publish selected review comment action ledger",
  );
  const primarySyncSuccess = publishJob.indexOf(
    'echo "sync_succeeded=true" >> "$GITHUB_OUTPUT"',
    syncStart,
  );
  const statusPublishStart = publishJob.indexOf("pnpm run status --", syncStart);

  assert.ok(syncStart >= 0);
  assert.ok(primarySyncSuccess > syncStart);
  assert.ok(statusPublishStart > primarySyncSuccess);
  assert.ok(finalizerStart > syncStart);
  assert.ok(publicationStart > finalizerStart);
  assert.match(
    publishJob.slice(syncStart, finalizerStart),
    /timeout --kill-after=30s 840s pnpm run apply-decisions[\s\S]*echo "exit_code=\$selected_comment_exit_code" >> "\$GITHUB_OUTPUT"[\s\S]*exit "\$selected_comment_exit_code"/,
  );
  assert.match(
    publishJob.slice(finalizerStart, publicationStart),
    /if: \$\{\{ always\(\)[\s\S]*SELECTED_COMMENT_EXIT_CODE:[\s\S]*--interrupt-open-attempts --reason cancelled[\s\S]*--interrupt-open-attempts --reason timeout[\s\S]*--interrupt-open-attempts --reason workflow_failed[\s\S]*finalize-action-events/,
  );
  assert.match(
    publishJob.slice(publicationStart, publicationStart + 400),
    /steps\.finalize-selected-review-comment-action-ledger\.outcome == 'success'/,
  );
});

test("failed-review retry cleanup restores the captured command failure", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const retryJobStart = workflow.indexOf("\n  retry-failed-reviews:");
  const auditJobStart = workflow.indexOf("\n  audit-dashboard:", retryJobStart);
  const retryJob = workflow.slice(retryJobStart, auditJobStart);
  const commandStart = retryJob.indexOf("- name: Plan or dispatch failed-review retries");
  const finalizerStart = retryJob.indexOf("- name: Finalize failed-review retry action ledger");
  const publicationStart = retryJob.indexOf("- name: Publish failed-review retry action ledger");
  const artifactStart = retryJob.indexOf("uses: actions/upload-artifact@v7", publicationStart);
  const restoreStart = retryJob.indexOf("- name: Restore failed-review retry outcome");

  assert.ok(commandStart >= 0);
  assert.ok(finalizerStart > commandStart);
  assert.ok(publicationStart > finalizerStart);
  assert.ok(artifactStart > publicationStart);
  assert.ok(restoreStart > artifactStart);
  assert.match(
    retryJob.slice(commandStart, finalizerStart),
    /continue-on-error: true[\s\S]*echo "exit_code=\$retry_exit_code" >> "\$GITHUB_OUTPUT"[\s\S]*exit "\$retry_exit_code"/,
  );
  assert.match(
    retryJob.slice(restoreStart),
    /steps\.retry-failed-reviews-run\.outcome != 'success'[\s\S]*RETRY_EXIT_CODE:[\s\S]*exit "\$retry_exit_code"/,
  );
});

test("broad record publishers isolate tuple reconciliation from status and auxiliary state", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  for (const stepName of [
    "Commit review records",
    "Sync selected review comments",
    "Commit Audit Health",
  ]) {
    const start = workflow.indexOf(`- name: ${stepName}`);
    assert.notEqual(start, -1, stepName);
    const nextStep = workflow.indexOf("\n      - ", start + 1);
    const block = workflow.slice(start, nextStep === -1 ? undefined : nextStep);
    const recordsPath = block.indexOf('--path "records/${target_slug}"');
    const tupleStrategy = block.indexOf("--rebase-strategy normal", recordsPath);
    const secondPublish = block.indexOf("pnpm run repair:publish-main", tupleStrategy);
    const statusPath = block.indexOf("results/sweep-status/${target_slug}.json", secondPublish);
    const statusStrategy = block.indexOf("--rebase-strategy theirs", statusPath);

    assert.ok(recordsPath !== -1, `${stepName} records path`);
    assert.ok(tupleStrategy > recordsPath, `${stepName} tuple strategy`);
    assert.ok(secondPublish > tupleStrategy, `${stepName} split publish`);
    assert.equal(
      block.slice(recordsPath, tupleStrategy).includes("results/sweep-status"),
      false,
      `${stepName} must not mix status into tuple reconciliation`,
    );
    assert.ok(statusPath > secondPublish, `${stepName} status path`);
    assert.ok(statusStrategy > statusPath, `${stepName} status strategy`);
    assert.equal(
      block.slice(secondPublish).includes('--path "records/${target_slug}"'),
      false,
      `${stepName} auxiliary publish must not replay records`,
    );
  }
});

test("every sweep tuple mutator hands publish-main a captured canonical baseline", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const stepBlock = (name: string): string => {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, name);
    const end = workflow.indexOf("\n      - ", start + 1);
    return workflow.slice(start, end === -1 ? undefined : end);
  };

  const applyArtifacts = stepBlock("Apply review artifacts");
  assert.match(
    applyArtifacts,
    /CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: \.artifacts\/review-canonical-baseline/,
  );
  const commitReview = stepBlock("Commit review records");
  assert.match(
    commitReview,
    /CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: \.artifacts\/review-canonical-baseline/,
  );

  const selectedComments = stepBlock("Sync selected review comments");
  assert.ok(
    selectedComments.indexOf("begin_canonical_record_mutation") <
      selectedComments.indexOf("pnpm run apply-decisions"),
  );
  assert.ok(
    selectedComments.indexOf("pnpm run apply-decisions") <
      selectedComments.indexOf("chore: sync selected review comments"),
  );

  const refreshAudit = stepBlock("Refresh Audit Health");
  const commitAudit = stepBlock("Commit Audit Health");
  assert.match(
    refreshAudit,
    /CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: \.artifacts\/audit-canonical-baseline/,
  );
  assert.match(refreshAudit, /--canonical-record-baseline-dir/);
  assert.match(
    commitAudit,
    /CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: \.artifacts\/audit-canonical-baseline/,
  );
});

test("apply workflow isolates proof Codex and keeps mutation free of Git recovery Codex", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const workflowConcurrency = workflow.slice(
    workflow.indexOf("\nconcurrency:"),
    workflow.indexOf("\njobs:"),
  );
  const proofJobStart = workflow.indexOf("\n  apply-proof:");
  const proofPublisherStart = workflow.indexOf("\n  publish-apply-proof-action-ledger:");
  const applyJobStart = workflow.indexOf("\n  apply-existing:");
  assert.notEqual(proofJobStart, -1);
  assert.notEqual(proofPublisherStart, -1);
  assert.notEqual(applyJobStart, -1);
  assert.doesNotMatch(workflowConcurrency, /queue: max/);
  assert.match(workflowConcurrency, /cancel-in-progress: false/);
  const proofJob = workflow.slice(proofJobStart, proofPublisherStart);
  const proofPublisherJob = workflow.slice(proofPublisherStart, applyJobStart);
  const applyJob = workflow.slice(applyJobStart);
  const applyCondition = applyJob.match(/^\s+if: (.+)$/m)?.[1] ?? "";
  const proofGenerationStart = proofJob.indexOf("- name: Generate bound close coverage proofs");
  const proofManifestStart = proofJob.indexOf("- name: Create bound close coverage proof manifest");
  const primaryProofResultStart = proofJob.indexOf("- name: Export primary apply proof result");
  const proofFinalizerStart = proofJob.indexOf("- name: Finalize apply proof action ledger");

  assert.match(
    proofJob,
    /permissions:\s+actions: read\s+contents: read\s+issues: read\s+pull-requests: read/,
  );
  assert.match(proofJob, /persist-credentials: false/);
  assert.match(proofJob, /persist-credentials: "false"/);
  assert.match(proofJob, /hydrate-state-blobs: "false"/);
  assert.doesNotMatch(proofJob, /Create target write token|Create state token/);
  assert.match(proofJob, /proposed-pr-close-coverage-item-numbers/);
  assert.match(proofJob, /--batch-size 2/);
  assert.match(proofJob, /--coverage-proof-limit 2/);
  assert.match(proofJob, /uses: \.\/\.github\/actions\/setup-codex/);
  assert.match(proofJob, /--dry-run/);
  assert.match(proofJob, /--codex-model internal/);
  assert.match(proofJob, /--codex-reasoning-effort high/);
  assert.match(proofJob, /write_coverage_proof_manifest/);
  assert.match(proofJob, /pr-close-coverage-proof\/\*/);
  assert.match(proofJob, /artifact_name: \$\{\{ steps\.proof-artifact\.outputs\.name \}\}/);
  assert.match(
    proofJob,
    /action_ledger_artifact_name: \$\{\{ steps\.publishable-action-ledger\.outputs\.name \}\}/,
  );
  assert.match(proofJob, /proof_ready: \$\{\{ steps\.primary-proof-result\.outputs\.ready \}\}/);
  assert.match(
    proofJob,
    /name=apply-coverage-proofs-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(proofJob, /name: \$\{\{ steps\.proof-artifact\.outputs\.name \}\}/);
  assert.match(
    proofJob,
    /action_ledger_name=action-ledger-apply-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(proofJob, /id: upload-action-events/);
  assert.match(proofJob, /name: \$\{\{ steps\.proof-artifact\.outputs\.action_ledger_name \}\}/);
  assert.match(
    proofJob,
    /path: \$\{\{ runner\.temp \}\}\/clawsweeper-action-ledger\/\$\{\{ github\.run_id \}\}\/\$\{\{ github\.run_attempt \}\}\/\$\{\{ github\.job \}\}\/\*\*/,
  );
  assert.match(proofJob, /include-hidden-files: true/);
  assert.match(proofJob, /if-no-files-found: error/);
  assert.ok(proofGenerationStart >= 0);
  assert.ok(proofManifestStart > proofGenerationStart);
  assert.ok(primaryProofResultStart > proofManifestStart);
  assert.ok(proofFinalizerStart > primaryProofResultStart);
  assert.match(
    proofJob,
    /id: primary-proof-result[\s\S]*if: \$\{\{ always\(\) && !cancelled\(\) && steps\.proof-select\.outcome == 'success' && \(steps\.proof-select\.outputs\.item_numbers == '' \|\| steps\.generate-apply-proofs\.outcome == 'success'\) && steps\.proof-manifest\.outcome == 'success' \}\}[\s\S]*echo "ready=true" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    proofJob,
    /if: \$\{\{ always\(\) && steps\.upload-action-events\.outputs\.artifact-id != '' \}\}/,
  );

  assert.match(proofPublisherJob, /needs: apply-proof/);
  assert.match(
    proofPublisherJob,
    /if: \$\{\{ always\(\) && needs\.apply-proof\.result != 'skipped' \}\}/,
  );
  assert.match(
    proofPublisherJob,
    /name: \$\{\{ needs\.apply-proof\.outputs\.action_ledger_artifact_name \}\}/,
  );
  assert.match(proofPublisherJob, /path: \.clawsweeper-repair\/action-ledger-proof/);
  assert.match(proofPublisherJob, /Publish apply proof action events/);
  assert.doesNotMatch(proofPublisherJob, /setup-state|create-state-token|CLAWSWEEPER_STATE_DIR/);
  assert.doesNotMatch(proofPublisherJob, /github\.run_attempt/);

  assert.match(applyJob, /needs: \[apply-proof, publish-apply-proof-action-ledger\]/);
  assert.match(
    applyCondition,
    /^\$\{\{ always\(\) && !cancelled\(\) && needs\.apply-proof\.outputs\.proof_ready == 'true' &&/,
  );
  assert.doesNotMatch(applyCondition, /needs\.apply-proof\.result/);
  assert.doesNotMatch(applyCondition, /needs\.publish-apply-proof-action-ledger/);
  assert.doesNotMatch(applyJob, /CLAWSWEEPER_MODEL_RECOVERY_ENABLED|OPENAI_API_KEY/);
  assert.doesNotMatch(applyJob, /uses: \.\/\.github\/actions\/setup-codex/);
  assert.doesNotMatch(applyJob, /--codex-model|--codex-reasoning-effort/);
  assert.match(applyJob, /Create target write token/);
  assert.match(applyJob, /Create state token/);
  assert.match(applyJob, /hydrate-state-blobs: "false"/);
  assert.match(applyJob, /actions\/download-artifact@v8/);
  assert.doesNotMatch(
    applyJob.slice(
      applyJob.indexOf("uses: actions/download-artifact@v8"),
      applyJob.indexOf("uses: actions/download-artifact@v8") + 300,
    ),
    /continue-on-error/,
  );
  assert.match(applyJob, /name: \$\{\{ needs\.apply-proof\.outputs\.artifact_name \}\}/);
  assert.doesNotMatch(applyJob, /action-ledger-proof/);
  assert.match(applyJob, /validate_coverage_proof_tree .* 8 262144 2097152/);
  assert.doesNotMatch(applyJob, /COVERAGE_PROOF_TRUSTED_STARTED_AT|proof-trust/);
  assert.match(applyJob, /target_repo.*PROOF_TARGET_REPO/);
  assert.match(applyJob, /--require-precomputed-pr-close-coverage-proof/);
  assert.match(applyJob, /--artifact-dir \.artifacts\/apply-proof/);
  assert.match(
    applyJob,
    /group: clawsweeper-target-apply-\$\{\{ needs\.apply-proof\.outputs\.target_repo \}\}/,
  );
  assert.match(applyJob, /cancel-in-progress: false/);
  assert.match(applyJob, /queue: max/);
});

test("comment-only apply preparation never scans the full target repository", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }>;
  };
  const steps = workflow.jobs["apply-proof"]!.steps;
  const reconcile = steps.find((step) => step.name === "Reconcile read-only proof inputs");
  const applyReconcile = workflow.jobs["apply-existing"]!.steps.find(
    (step) => step.name === "Reconcile before apply preselect",
  );
  const select = steps.find((step) => step.name === "Select bounded coverage proof work");
  assert.ok(reconcile?.if, "proof reconciliation must explicitly exclude comment-only runs");
  assert.equal(applyReconcile?.if, reconcile.if, "apply preselect must use the same skip gate");
  assert.ok(select?.run, "proof selection must recognize scheduled comment-only maintenance");

  const expression = reconcile.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const shouldReconcile = new Function("github", `return (${expression});`) as (
    github: Record<string, unknown>,
  ) => boolean;
  const dispatch = (syncCommentsOnly: string, itemNumbers = "") => ({
    event_name: "workflow_dispatch",
    event: {
      schedule: "",
      inputs: { apply_sync_comments_only: syncCommentsOnly, apply_item_numbers: itemNumbers },
    },
  });
  const schedule = (cron: string) => ({
    event_name: "schedule",
    event: { schedule: cron, inputs: {} },
  });

  assert.equal(shouldReconcile(dispatch("true", "__cursor__")), false);
  assert.equal(shouldReconcile(dispatch("true", "10,20")), false);
  assert.equal(shouldReconcile(dispatch("false", "__cursor__")), false);
  assert.equal(shouldReconcile(schedule("6,21,36,51 * * * *")), false);
  assert.equal(shouldReconcile(dispatch("false")), true);
  assert.equal(shouldReconcile(schedule("3 * * * *")), true);
  assert.match(select.run, /github\.event\.schedule \|\| ''/);
  assert.match(select.run, /6,21,36,51 \* \* \* \*/);
  assert.match(select.run, /sync_comments_only="true"/);
});

test("comment-only apply reconciliation scopes only selected items", () => {
  const reconcileArgs = (itemNumbers: string, syncCommentsOnly: boolean) =>
    execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          'TARGET_REPO="openclaw/openclaw"',
          `item_numbers="${itemNumbers}"`,
          `sync_comments_only=${syncCommentsOnly}`,
          "sync_open_pr_batch=false",
          "prepare_apply_reconciliation_args",
          'printf "%s\\n" "${reconcile_args[@]}"',
        ].join("\n"),
      ],
      { encoding: "utf8" },
    )
      .trimEnd()
      .split("\n");
  const baseArgs = ["--target-repo", "openclaw/openclaw", "--skip-closed-at"];

  assert.deepEqual(reconcileArgs("119890", true), [
    ...baseArgs,
    "--item-numbers",
    "119890",
    "--only-item-numbers",
  ]);
  assert.deepEqual(reconcileArgs("119890", false), [...baseArgs, "--item-numbers", "119890"]);
  assert.deepEqual(reconcileArgs("", true), baseArgs);
});

test("apply workflow scopes cursor reconciliation and publishes close reconciliation before idle", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const preselectReconcile = applyJob.indexOf('persist_reconciliation "${reconcile_args[@]}"');
  const applyStart = applyJob.indexOf(
    "- name: Apply unchanged proposed decisions with checkpoints",
  );
  const policyNoop = applyJob.indexOf("APPLY_NOOP=true", applyStart);
  const applyReconcile = applyJob.indexOf(
    'persist_reconciliation "${reconcile_args[@]}"',
    applyStart,
  );
  const commentIdle = applyJob.indexOf('--state "Apply comments idle"', applyStart);
  const closeIdle = applyJob.indexOf("publish_automatic_apply_idle", applyStart);

  assert.ok(preselectReconcile !== -1);
  assert.ok(preselectReconcile < applyStart);
  assert.ok(policyNoop > preselectReconcile);
  assert.ok(applyReconcile > policyNoop);
  assert.ok(commentIdle < applyReconcile);
  assert.ok(closeIdle > applyReconcile);
});

test("reconcile publication expands only exact changed record tuples", () => {
  const reconcileJson = JSON.stringify({
    changedItemNumbers: [7, 42],
    changedRecordFiles: ["7.md", "openclaw-openclaw-42.md"],
  });
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$@"; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_reconciled_records "persist reconciliation" "$RECONCILE_JSON"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, RECONCILE_JSON: reconcileJson } },
  );
  assert.deepEqual(output.trim().split("\n"), [
    "normal",
    "persist reconciliation",
    "records/openclaw-openclaw/items/7.md",
    "records/openclaw-openclaw/closed/7.md",
    "records/openclaw-openclaw/plans/7.md",
    "records/openclaw-openclaw/decision-packets/7.json",
    "records/openclaw-openclaw/items/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/closed/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/plans/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/decision-packets/42.json",
  ]);

  const emptyOutput = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "unexpected publish\\n"; return 1; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_reconciled_records "persist reconciliation" \'{"changedItemNumbers":[],"changedRecordFiles":[]}\'',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(emptyOutput.trim(), "Reconcile changed no durable record tuples.");
});

test("persist reconciliation publishes against its exact captured canonical baseline", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "pnpm() {",
        "  local previous='' baseline='' argument",
        '  for argument in "$@"; do',
        '    if [ "$previous" = "--canonical-record-baseline-dir" ]; then baseline="$argument"; fi',
        '    previous="$argument"',
        "  done",
        '  test -n "$baseline"',
        '  mkdir -p "$baseline/records/openclaw-openclaw/items"',
        '  printf "before\\n" > "$baseline/records/openclaw-openclaw/items/42.md"',
        '  printf \'{"changedItemNumbers":[42],"changedRecordFiles":["42.md"]}\\n\'',
        "}",
        "publish_reconciled_records() {",
        '  test -f "$CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR/records/openclaw-openclaw/items/42.md"',
        '  printf "baseline=%s\\n" "$CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR"',
        "}",
        "load_reconciliation_deferred_items() { :; }",
        'TARGET_REPO="openclaw/openclaw"',
        'persist_reconciliation --target-repo "$TARGET_REPO"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  const baseline = /^baseline=(.+)$/m.exec(output)?.[1];
  assert.ok(baseline);
  assert.equal(existsSync(baseline), false);
});

test("reconcile publication batches large corrected tuple sets below exec argument limits", () => {
  const changedRecordFiles = Array.from({ length: 128 }, (_, index) => `${index + 1}.md`);
  const reconcileJson = JSON.stringify({ changedItemNumbers: [], changedRecordFiles });
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "call=%s kind=%s deferred=%s\\n" "$#" "$CLAWSWEEPER_CANONICAL_PUBLICATION_KIND" "$CLAWSWEEPER_RECONCILE_DEFERRED_PATH"; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_reconciled_records "persist reconciliation" "$RECONCILE_JSON"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, RECONCILE_JSON: reconcileJson } },
  );

  assert.deepEqual(output.trim().split("\n"), [
    "call=202 kind=reconcile deferred=.artifacts/apply-reconcile-deferred.jsonl",
    "call=202 kind=reconcile deferred=.artifacts/apply-reconcile-deferred.jsonl",
    "call=114 kind=reconcile deferred=.artifacts/apply-reconcile-deferred.jsonl",
  ]);
});

test("apply checkpoints split record tuples from auxiliary state", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$@"; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_changes "apply checkpoint" records apply-report.json results/sweep-status results/apply-cursors',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(output.trim().split("\n"), [
    "normal",
    "apply checkpoint",
    "records/openclaw-openclaw",
    "theirs",
    "apply checkpoint",
    "apply-report.json",
    "results/sweep-status",
    "results/apply-cursors",
  ]);

  const failedOutput = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$1"; [ "$1" != normal ]; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_changes "apply checkpoint" records apply-report.json || true',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(failedOutput.trim(), "normal");

  const auxiliaryFailure = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$1"; [ "$1" != theirs ]; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_changes "apply checkpoint" records apply-report.json results/apply-cursors 2>&1',
        'printf "exit=%s\\n" "$?"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(auxiliaryFailure.trim().split("\n"), [
    "normal",
    "theirs",
    "::warning title=Operational state publish failed::Canonical work remains valid; continuing after best-effort Git bookkeeping failed: apply checkpoint",
    "exit=0",
  ]);
});

test("best-effort apply status publishes one sparse-safe file without noisy restore", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes() { printf "publish=%s\\npath=%s\\n" "$1" "$2"; return 1; }',
        'git() { if [ "$1" = restore ]; then printf "unexpected restore\\n"; fi; return 1; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_status "apply status"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.deepEqual(output.trim().split("\n"), [
    "publish=apply status",
    "path=results/sweep-status/openclaw-openclaw.json",
    "Best-effort status update failed: apply status",
  ]);
});

test("apply workflow rejects malformed or oversized coverage proof artifact trees", () => {
  const root = mkdtempSync(tmpPrefix);
  const validate = (maxFiles = 2, maxFileBytes = 64, maxTotalBytes = 128) =>
    execFileSync(
      "bash",
      [
        "-lc",
        `source scripts/apply-workflow-helpers.sh\nvalidate_coverage_proof_tree "$PROOF_DIR" ${maxFiles} ${maxFileBytes} ${maxTotalBytes}`,
      ],
      { encoding: "utf8", env: { ...process.env, PROOF_DIR: root } },
    );
  const writeManifest = (selectedItems = "10,30") =>
    execFileSync(
      "bash",
      [
        "-lc",
        'source scripts/apply-workflow-helpers.sh\nwrite_coverage_proof_manifest "$PROOF_DIR" openclaw/openclaw "$SELECTED_ITEMS"',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PROOF_DIR: root, SELECTED_ITEMS: selectedItems },
      },
    );

  try {
    writeFileSync(join(root, "10-20.proof.json"), "{}\n");
    writeFileSync(join(root, "30-40.proof.json"), "{}\n");
    writeManifest();
    assert.equal(validate(), "");

    writeFileSync(join(root, "50-60.proof.json"), "{}\n");
    writeManifest("10,30,50");
    assert.throws(() => validate(), /maximum is 2/);
    rmSync(join(root, "50-60.proof.json"));
    writeManifest();

    writeFileSync(join(root, "unexpected.json"), "{}\n");
    assert.throws(() => validate(3), /Unexpected coverage proof filename/);
    rmSync(join(root, "unexpected.json"));

    mkdirSync(join(root, "nested"));
    assert.throws(() => validate(), /Unexpected non-file coverage proof artifact/);
    rmSync(join(root, "nested"), { recursive: true });

    writeFileSync(join(root, "10-20.proof.json"), "x".repeat(65));
    assert.throws(() => validate(), /exceeds 64 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage proof manifest preserves an empty reduced-hydration artifact", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          'write_coverage_proof_manifest "$PROOF_DIR" openclaw/openclaw "107006,109946"',
          'validate_coverage_proof_tree "$PROOF_DIR" 8 262144 2097152',
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, PROOF_DIR: root } },
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")), {
      schemaVersion: 1,
      targetRepo: "openclaw/openclaw",
      selectedItems: [107006, 109946],
      proofCount: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow target token can inspect source workflow runs", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const action = readText(".github/actions/create-target-write-token/action.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const tokenStart = applyJob.indexOf("- name: Create target write token");
  const stateTokenStart = applyJob.indexOf("- name: Create state token", tokenStart);

  assert.ok(tokenStart !== -1);
  assert.ok(stateTokenStart > tokenStart);
  assert.match(
    applyJob.slice(tokenStart, stateTokenStart),
    /uses: \.\/\.github\/actions\/create-target-write-token/,
  );
  assert.match(action, /permission-actions: read/);
  assert.match(action, /minted-at-ms:[\s\S]*steps\.minted-at\.outputs\.milliseconds/);
});

test("targeted apply dispatches keep apply names ahead of exact-review names", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const runName = workflow.slice(workflow.indexOf("run-name:"), workflow.indexOf("\non:"));
  const firstExactDispatchName = runName.indexOf("'Review manual item'");

  assert.ok(firstExactDispatchName > -1);
  for (const applyName of [
    "format('Sync Codex review comments for {0}'",
    "format('Apply custom ClawSweeper closures for {0}'",
    "format('Apply default ClawSweeper closures for {0}'",
  ]) {
    assert.ok(
      runName.indexOf(applyName) < firstExactDispatchName,
      `${applyName} must win when apply_existing also carries item_number or item_numbers`,
    );
  }
  assert.match(
    workflow,
    /item_numbers="\$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.item_number \|\| github\.event\.inputs\.apply_item_numbers \|\| '' \}\}"/,
  );
});

test("apply workflow bounds checkpoints and requeues with a fresh token", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyHelper = readText("scripts/apply-workflow-helpers.sh");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const applyStep = applyJob.slice(
    applyJob.indexOf("- name: Apply unchanged proposed decisions with checkpoints"),
    applyJob.indexOf("- name: Retry final apply status publication"),
  );
  const continueStep = applyJob.slice(
    applyJob.indexOf("- name: Continue apply sweep"),
    applyJob.indexOf("- name: Queue review backstops"),
  );
  const runMarker = "        run: |\n";
  const runBodyStart = applyStep.indexOf(runMarker);
  assert.notEqual(runBodyStart, -1);
  const runBody = applyStep
    .slice(runBodyStart + runMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");

  assert.match(workflow, /format\('Apply default ClawSweeper closures for \{0\}'/);
  assert.match(workflow, /format\('Apply custom ClawSweeper closures for \{0\}'/);
  assert.match(
    workflow,
    /github\.event\.schedule == '8,23,38,53 \* \* \* \*'\) && 'openclaw\/clawhub'/,
  );
  assert.match(inputBlock, /apply_limit:[\s\S]*default: "40"/);
  assert.match(inputBlock, /apply_checkpoint_size:[\s\S]*default: "40"/);
  assert.match(workflow, /github\.event\.inputs\.apply_limit != '40'/);
  assert.match(workflow, /github\.event\.inputs\.apply_checkpoint_size != '40'/);
  assert.match(applyStep, /Capping apply checkpoint size at 40/);
  assert.match(applyStep, /base_close_processed_limit=600/);
  assert.match(applyHelper, /coverage_proof_limit=2/);
  assert.match(applyHelper, /apply_token_budget_ms=3300000/);
  assert.match(applyHelper, /max_runtime_arg=\(--max-runtime-ms 1200000\)/);
  assert.match(applyHelper, /max_close_processed_limit=1800/);
  assert.match(applyStep, /close_processed_limit="\$base_close_processed_limit"/);
  assert.match(applyStep, /source scripts\/apply-workflow-helpers\.sh/);
  assert.match(
    workflow,
    /action_ledger_outcome: \$\{\{ steps\.finalize-apply\.outcome \|\| 'not_started' \}\}/,
  );
  assert.match(
    workflow,
    /ACTION_LEDGER_OUTCOME: \$\{\{ \(needs\.publish-apply-proof-action-ledger\.result == 'failure'/,
  );
  assert.match(applyStep, /timeout-minutes: 70/);
  assert.match(
    applyStep,
    /CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS: \$\{\{ steps\.target-write-token\.outputs\.minted-at-ms \}\}/,
  );
  assert.match(applyStep, /initialize_apply_token_budget/);
  assert.match(applyStep, /select_adaptive_apply_batch/);
  assert.match(applyHelper, /adaptive-apply-batch-size/);
  assert.match(applyHelper, /--status-path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.ok(
    runBody.length < 20_000,
    `apply run expression is ${runBody.length} characters; keep margin below GitHub's 21,000-character limit`,
  );
  assert.match(applyStep, /processed-limit "\$close_processed_limit"/);
  assert.match(applyStep, /comment_sync_processed_limit=40/);
  assert.match(applyStep, /--processed-limit "\$comment_sync_processed_limit"/);
  assert.match(applyStep, /prepare_comment_sync_batch/);
  const commentSyncBranch = applyStep.slice(
    applyStep.indexOf('if [ "$sync_comments_only" = "true" ]; then\n            checkpoint=1'),
    applyStep.indexOf('\n          while [ "$closed_total" -lt "$limit" ]; do'),
  );
  assert.match(commentSyncBranch, /--max-runtime-ms 300000/);
  assert.match(commentSyncBranch, /complete_comment_sync_batch/);
  assert.match(
    commentSyncBranch,
    /--cursor-trace "\.artifacts\/comment-sync-trace-\$checkpoint\.json"/,
  );
  assert.match(commentSyncBranch, /"\$\{comment_sync_cursor_arg\[@\]\}"/);
  assert.match(
    applyHelper,
    /comment_sync_cursor_arg=\(--comment-sync-cursor "\$\{comment_sync_initial_cursor:-0\}"\)/,
  );
  assert.match(commentSyncBranch, /write_comment_sync_health/);
  assert.match(applyHelper, /"\$comment_sync_cursor_advance_count"/);
  const applyFlagInit = applyStep.indexOf('explicit_item_numbers="$item_numbers"');
  assert.ok(applyFlagInit > applyStep.indexOf('item_numbers="${{'));
  assert.ok(applyFlagInit < applyStep.indexOf("auto_selected_apply_batch=true"));
  assert.match(applyStep, /apply_cursor_path="results\/apply-cursors\/\$\{target_slug\}\.json"/);
  assert.match(applyHelper, /write_apply_health\(\)/);
  assert.match(applyStep, /select_apply_candidate_inventory/);
  assert.match(applyHelper, /proposed-item-inventory/);
  assert.match(
    applyHelper,
    /candidate_inventory_env="\.artifacts\/apply-candidate-inventory\.env"/,
  );
  assert.match(applyHelper, /update_item_numbers="\$\{1:-true\}"/);
  assert.match(applyHelper, /item_numbers="\$\(awk -F=/);
  assert.match(applyHelper, /apply_ready_count="\$\(awk -F=/);
  assert.match(applyHelper, /candidate_counts_json="\$\(awk -F=/);
  assert.match(applyHelper, /--batch-size "\$close_processed_limit"/);
  assert.match(applyHelper, /--coverage-proof-limit "\$coverage_proof_limit"/);
  assert.match(applyHelper, /--cursor-path "\$apply_cursor_path"/);
  assert.match(applyStep, /apply-cursor-advance-count/);
  assert.match(applyStep, /examined_count="\$\(apply_checkpoint_examined_count\)"/);
  assert.match(applyHelper, /apply_checkpoint_examined_count\(\)/);
  assert.match(applyHelper, /printf '%s\\n' "unavailable"/);
  assert.match(applyStep, /Candidates examined: \$examined_count\. Action records: \$result_count/);
  assert.match(applyHelper, /--candidate-count "\$health_candidate_count"/);
  assert.match(applyHelper, /--candidate-counts-json "\$health_candidate_counts_json"/);
  assert.match(applyHelper, /--cursor-advance-count "\$health_cursor_advance_count"/);
  assert.match(applyHelper, /--scheduled-interval-minutes "\$health_scheduled_interval_minutes"/);
  assert.match(applyHelper, /pnpm run --silent workflow -- summarize-apply-report/);
  assert.match(applyHelper, /health_cursor_path="\$\{5:-\}"/);
  assert.match(applyStep, /comment_sync_health_cursor_path="\$cursor_path"/);
  assert.match(applyStep, /comment_sync_health_cursor_required="true"/);
  assert.match(applyStep, /comment_sync_health_processed_limit="\$sync_batch_size"/);
  assert.match(applyStep, /close_health_cursor_path="\$apply_cursor_path"/);
  assert.match(applyStep, /--apply-health-file "\.artifacts\/apply-health-\$checkpoint\.json"/);
  assert.match(applyStep, /--apply-health-file "\.artifacts\/apply-health-final\.json"/);
  assert.match(applyStep, /publish_automatic_apply_idle/);
  assert.match(applyHelper, /--apply-health-file "\.artifacts\/apply-health-idle\.json"/);
  assert.match(applyHelper, /apply-report-idle\.json/);
  assert.match(applyHelper, /--state "Apply idle"/);
  assert.match(applyHelper, /proposed-item-quality-summary/);
  assert.match(applyHelper, /candidate_quality_summary="\$\(awk -F=/);
  assert.match(
    applyHelper,
    /candidate_quality_detail=" Close candidate mix: \$candidate_quality_summary\."/,
  );
  assert.match(applyHelper, /awaiting apply\.\$candidate_quality_detail Scheduled apply/);
  assert.match(
    applyStep,
    /\$apply_close_reasons\.\$candidate_quality_detail Scan window: \$close_processed_limit/,
  );
  const applyReconcileIndex = applyStep.indexOf('persist_reconciliation "${reconcile_args[@]}"');
  const qualitySummaryIndex = applyStep.indexOf("summarize_apply_candidate_quality");
  const candidateInventoryIndex = applyStep.indexOf("select_apply_candidate_inventory");
  const selectedItemsBranchIndex = applyStep.indexOf(
    'if [ -n "$item_numbers" ]',
    candidateInventoryIndex,
  );
  const checkpointPublishIndex = applyStep.indexOf(
    'publish_changes "chore: apply sweep decisions checkpoint $checkpoint"',
  );
  const refreshedInventoryIndex = applyStep.indexOf(
    "select_apply_candidate_inventory",
    candidateInventoryIndex + 1,
  );
  assert.notEqual(applyReconcileIndex, -1);
  assert.ok(qualitySummaryIndex > applyReconcileIndex);
  assert.ok(candidateInventoryIndex > qualitySummaryIndex);
  assert.ok(selectedItemsBranchIndex > candidateInventoryIndex);
  assert.ok(refreshedInventoryIndex > checkpointPublishIndex);
  assert.match(applyStep, /select_apply_candidate_inventory false/);
  assert.doesNotMatch(applyStep, /proposed-item-numbers/);
  assert.match(applyHelper, /--batch-size "\$close_processed_limit"/);
  assert.match(
    applyHelper,
    /--close-limit "\$\(\(limit < checkpoint_size \? limit : checkpoint_size\)\)"/,
  );
  assert.match(applyHelper, /--coverage-proof-limit "\$coverage_proof_limit"/);
  assert.match(applyStep, /select_bounded_coverage_proof_tail/);
  assert.match(applyHelper, /select_bounded_coverage_proof_tail\(\)/);
  assert.match(applyHelper, /proposed-pr-close-coverage-item-numbers/);
  assert.match(applyHelper, /drop_bounded_coverage_proof_tail\(\)/);
  assert.match(applyStep, /drop_bounded_coverage_proof_tail "\$cursor_trace_path"/);
  assert.match(
    applyStep,
    /Scan window: \$close_processed_limit records \(\$adaptive_apply_scan_reason\)/,
  );
  assert.match(applyStep, /Selected \$proposed_count from \$close_processed_limit/);
  assert.match(applyStep, /--cursor-path "\$apply_cursor_path"/);
  assert.match(applyStep, /write-apply-cursor/);
  assert.match(applyStep, /--item-numbers "\$item_numbers"/);
  assert.match(applyStep, /--coverage-proof-item-numbers "\$coverage_proof_item_numbers"/);
  assert.match(applyStep, /--cursor-trace "\$cursor_trace_path"/);
  assert.match(applyStep, /cursor_trace_arg=\(--cursor-trace "\$cursor_trace_path"\)/);
  assert.match(applyStep, /select_automatic_apply_runtime/);
  assert.match(applyStep, /"\$\{max_runtime_arg\[@\]\}"/);
  assert.match(applyStep, /results\/apply-cursors/);
  assert.match(applyStep, /reached its \$close_processed_limit-record budget/);
  assert.match(applyStep, /next scheduled apply run will advance the next window/);
  assert.match(applyStep, /apply_close_reasons="\$\(printf '%s\\n' "\$apply_close_reasons"/);
  assert.match(applyStep, /No enabled close reasons remain after policy filtering/);
  assert.match(applyStep, /true\|1\|yes\|on\) product_direction_enabled=true/);
  assert.match(applyStep, /if \[ "\$result_count" -ge "\$close_processed_limit" \]; then/);
  assert.match(applyHelper, /--action skipped_runtime_budget/);
  assert.match(applyStep, /if apply_checkpoint_runtime_reached/);
  assert.match(applyStep, /report_apply_token_budget_stop .*"\$result_count"/);
  assert.match(applyStep, /apply_checkpoint_runtime_reached .*"\$result_count"/);
  assert.match(applyHelper, /runtime budget before cursor progress/);
  assert.match(applyHelper, /fresh-token continuation will resume the lane/);
  assert.doesNotMatch(
    applyStep,
    /if \[ "\$result_count" -ge "\$close_processed_limit" \] && \[ "\$closed_in_chunk" -gt 0 \]/,
  );
  assert.match(applyStep, /sync_comments_only" != "true" .*apply_close_reasons/);
  assert.match(applyStep, /continue_apply=true/);
  assert.match(applyStep, /break\n\s+done/);
  assert.match(applyStep, /next_apply_item_numbers="\$item_numbers"/);
  assert.match(applyStep, /next_apply_item_numbers=""/);
  assert.match(applyStep, /echo "APPLY_CONTINUE=\$continue_apply"/);
  assert.match(applyStep, /echo "APPLY_AUTO_SELECTED_BATCH=\$auto_selected_apply_batch"/);
  assert.match(applyStep, /echo "APPLY_CANDIDATE_QUALITY_SUMMARY=\$candidate_quality_summary"/);
  assert.match(continueStep, /APPLY_CONTINUE:-false/);
  assert.match(continueStep, /can_share_apply_continuation=false/);
  assert.match(continueStep, /\[ "\$\{APPLY_AUTO_SELECTED_BATCH:-false\}" = "true" \]/);
  assert.match(continueStep, /\[ -z "\$\{APPLY_ITEM_NUMBERS:-\}" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_LIMIT:-40\}" = "40" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_CHECKPOINT_SIZE:-40\}" = "40" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_COMMENT_SYNC_MIN_AGE_DAYS:-7\}" = "7" \]/);
  assert.match(continueStep, /preserving exact continuation dispatch/);
  assert.match(
    continueStep,
    /gh api --paginate "repos\/\$\{\{ github\.repository \}\}\/actions\/runs\?per_page=100&status=\$\{run_status\}"/,
  );
  assert.match(continueStep, /workflowPath:\.path/);
  assert.doesNotMatch(continueStep, /workflowName:\.name/);
  assert.doesNotMatch(continueStep, /gh run list/);
  assert.match(continueStep, /pnpm run --silent workflow -- apply-continuation-blocker/);
  assert.match(continueStep, /--current-run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(continueStep, /--target-repo "\$\{APPLY_TARGET_REPO:-openclaw\/openclaw\}"/);
  assert.match(continueStep, /APPLY_CONTINUATION_BLOCKED/);
  assert.match(continueStep, /existing default cursor run will continue the lane/);
  assert.match(continueStep, /already covered by \$/);
  assert.match(continueStep, /-f apply_item_numbers="\$APPLY_ITEM_NUMBERS"/);
  assert.doesNotMatch(continueStep, /-f item_numbers=/);
  assert.doesNotMatch(continueStep, /APPLY_CLOSED_TOTAL:-0.*APPLY_LIMIT:-0/);
});

test("apply workflow finalization retries only target status after checkpointed state", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const applyStart = applyJob.indexOf(
    "- name: Apply unchanged proposed decisions with checkpoints",
  );
  const finalStatusStart = applyJob.indexOf("- name: Retry final apply status publication");
  const actionLedgerStart = applyJob.indexOf("- name: Publish apply action events");
  const continueStart = applyJob.indexOf("- name: Continue apply sweep");
  assert.ok(applyStart !== -1);
  assert.ok(finalStatusStart > applyStart);
  assert.ok(actionLedgerStart > finalStatusStart);
  assert.ok(continueStart > actionLedgerStart);
  const applyStep = applyJob.slice(applyStart, finalStatusStart);
  const finalStatusStep = applyJob.slice(finalStatusStart, actionLedgerStart);
  const actionLedgerStep = applyJob.slice(actionLedgerStart, continueStart);

  const commentCheckpoint = applyStep.indexOf(
    'publish_changes "chore: sync sweep review comments checkpoint $checkpoint" records apply-report.json results/comment-sync-cursors',
  );
  const closePaths = applyStep.indexOf("apply_publish_paths=(records apply-report.json)");
  const cursorPath = applyStep.indexOf("apply_publish_paths+=(results/apply-cursors)");
  const closeCheckpoint = applyStep.indexOf(
    'publish_changes "chore: apply sweep decisions checkpoint $checkpoint" "${apply_publish_paths[@]}"',
  );
  assert.ok(commentCheckpoint !== -1);
  assert.ok(closePaths !== -1);
  assert.ok(cursorPath > closePaths);
  assert.ok(closeCheckpoint > cursorPath);
  for (const laterBranch of [
    'if apply_checkpoint_runtime_reached ".artifacts/apply-reports/apply-report-$checkpoint.json"',
    'if [ "$result_count" -ge "$close_processed_limit" ]; then',
    'if [ "$result_count" -eq 0 ]; then',
    'if [ "$closed_in_chunk" -eq 0 ]; then',
  ]) {
    assert.ok(applyStep.indexOf(laterBranch) > closeCheckpoint);
  }
  assert.match(applyStep, /publish_status "chore: mark sweep apply in progress"/);
  assert.match(applyStep, /publish_status "chore: mark sweep apply finished"/);
  assert.doesNotMatch(
    applyStep,
    /publish_changes "chore: mark sweep apply in progress"[^\n]*records/,
  );
  assert.equal(
    [...applyStep.matchAll(/begin_canonical_record_mutation/g)].length,
    2,
    "comment-sync and close checkpoints each need a fresh pre-mutation tuple baseline",
  );

  assert.match(finalStatusStep, /APPLY_NOOP:-false/);
  assert.match(finalStatusStep, /--message "chore: mark sweep apply finished"/);
  assert.deepEqual(
    [...finalStatusStep.matchAll(/--path\s+("?[^\\\s]+"?)/g)].map((match) => match[1]),
    ['"results/sweep-status/${target_slug}.json"'],
  );
  assert.match(finalStatusStep, /--rebase-strategy theirs/);
  assert.doesNotMatch(finalStatusStep, /--path\s+"?records(?:\/|\s)/);
  assert.doesNotMatch(finalStatusStep, /apply-report\.json/);
  assert.doesNotMatch(finalStatusStep, /results\/(?:apply|comment-sync)-cursors/);
  assert.match(actionLedgerStep, /publish-action-events/);
  assert.doesNotMatch(actionLedgerStep, /action-ledger-proof/);
  assert.match(actionLedgerStep, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT/);
  assert.match(actionLedgerStep, /--state-root \./);
  assert.match(actionLedgerStep, /--expected-producer-job "\$GITHUB_JOB"/);
  assert.doesNotMatch(actionLedgerStep, /durable_event_path|--message|CLAWSWEEPER_STATE_DIR/);
  assert.match(actionLedgerStep, /publish-action-event-paths/);
  assert.match(actionLedgerStep, /--paths-file "\$event_paths_file"/);
  assert.doesNotMatch(actionLedgerStep, /repair:publish-main/);
  assert.doesNotMatch(actionLedgerStep, /continue-on-error: true/);
  assert.match(actionLedgerStep, /no paths were imported[\s\S]*exit 1/i);
});

test("comment synchronization splits oversized explicit requests into durable checkpoints", () => {
  const oversizedItems = Array.from({ length: 41 }, (_, index) => index + 1).join(",");
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_batch_size=75",
        "sync_comments_only=false",
        "item_numbers=",
        "prepare_comment_sync_batch",
        'printf "close_batch=%s\\n" "$sync_batch_size"',
        "sync_comments_only=true",
        "item_numbers=1",
        "sync_open_pr_batch=false",
        "prepare_comment_sync_batch",
        'printf "comment_batch=%s\\n" "$sync_batch_size"',
        'item_numbers="$OVERSIZED_ITEMS"',
        "prepare_comment_sync_batch",
        'printf "selected=%s\\n" "$item_numbers"',
        'printf "remaining=%s\\n" "$comment_sync_pending_items"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, OVERSIZED_ITEMS: oversizedItems } },
  );

  assert.match(output, /^close_batch=75$/m);
  assert.match(output, /^comment_batch=40$/m);
  assert.match(output, /^selected=1,2,3,4,5,6,7,8,9,10,/m);
  assert.match(output, /^selected=.*39,40$/m);
  assert.match(output, /^remaining=41$/m);
});

test("comment synchronization normalizes only valid positive explicit item numbers", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_batch_size=40",
        "sync_comments_only=true",
        "sync_open_pr_batch=false",
        'item_numbers="3, 0, 02, -4, 2, 1.5, invalid, 001,,"',
        "prepare_comment_sync_batch",
        'printf "selected=%s\\n" "$item_numbers"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^selected=1,2,3$/m);
});

test("comment synchronization rejects explicit requests without valid item numbers", () => {
  assert.throws(
    () =>
      execFileSync(
        "bash",
        [
          "-lc",
          [
            "set -euo pipefail",
            "source scripts/apply-workflow-helpers.sh",
            "comment_sync_processed_limit=40",
            "sync_batch_size=40",
            "sync_comments_only=true",
            "sync_open_pr_batch=false",
            'item_numbers="0,-4,1.5,invalid,,"',
            "prepare_comment_sync_batch",
          ].join("\n"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error: Error & { stderr?: Buffer | string }) =>
      /contains no valid positive item numbers/.test(String(error.stderr)),
  );
});

test("scheduled comment sync broadens only its own maintenance filters", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "sync_open_pr_batch=true",
        "sync_comments_only=true",
        "scheduled_comment_sync=false",
        "apply_kind=issue",
        "comment_sync_min_age_days=9",
        "normalize_comment_sync_mode",
        'printf "manual=%s|%s\\n" "$apply_kind" "$comment_sync_min_age_days"',
        "scheduled_comment_sync=true",
        "normalize_comment_sync_mode",
        'printf "scheduled=%s|%s\\n" "$apply_kind" "$comment_sync_min_age_days"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^manual=issue\|9$/m);
  assert.match(output, /^scheduled=all\|0$/m);
});

test("custom all-item sync never overwrites the shared automatic cursor", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_comments_only=true",
        "sync_open_pr_batch=true",
        "scheduled_comment_sync=false",
        "target_slug=openclaw-openclaw",
        "apply_kind=all",
        "comment_sync_min_age_days=0",
        "item_numbers=",
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "sync_batch_size=1",
        "min_age_days=30",
        "prepare_comment_sync_batch",
        'printf "custom=%s|%s\\n" "$cursor_path" "$sync_batch_size"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "sync_batch_size=40",
        "min_age_days=0",
        "min_age_minutes=30",
        "prepare_comment_sync_batch",
        'printf "minute=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_minutes=15",
        "prepare_comment_sync_batch",
        'printf "minute-fifteen=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_minutes=",
        "min_age_days=30",
        "prepare_comment_sync_batch",
        'printf "day-thirty=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_days=60",
        "prepare_comment_sync_batch",
        'printf "day-sixty=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_days=0",
        "apply_close_reasons=duplicate_or_superseded",
        "stale_min_age_days=1",
        "close_delay_ms=500",
        "checkpoint_size=10",
        "limit=40",
        "prepare_comment_sync_batch",
        'printf "policy=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "apply_close_reasons=all",
        "stale_min_age_days=60",
        "close_delay_ms=2000",
        "checkpoint_size=40",
        "apply_kind=pull_request",
        "prepare_comment_sync_batch",
        'printf "pull-request=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "apply_kind=all",
        "prepare_comment_sync_batch",
        'printf "automatic=%s\\n" "$cursor_path"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(
    output,
    /^custom=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json\|1$/m,
  );
  assert.match(
    output,
    /^minute=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json$/m,
  );
  const policyPath = (label: string) => output.match(new RegExp(`^${label}=(.+)$`, "m"))?.[1];
  assert.notEqual(policyPath("minute"), policyPath("minute-fifteen"));
  assert.notEqual(policyPath("day-thirty"), policyPath("day-sixty"));
  assert.match(
    output,
    /^policy=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json$/m,
  );
  assert.match(
    output,
    /^pull-request=results\/comment-sync-cursors\/openclaw-openclaw-pull_request-age0\.json$/m,
  );
  assert.match(output, /^automatic=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m);
});

test("cursor synchronization replaces a zero-item operator limit with its bounded default", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_batch_size=0",
        "sync_comments_only=true",
        "sync_open_pr_batch=true",
        "item_numbers=10",
        "prepare_comment_sync_batch",
        'printf "batch=%s\\n" "$sync_batch_size"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^batch=40$/m);
});

test("scheduled all-item comment sync remains bounded to one cursor window", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: issue\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=true",
          "continue_apply=false",
          'TARGET_REPO="openclaw/openclaw"',
          "target_slug=openclaw-openclaw",
          "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
          "apply_kind=pull_request",
          "comment_sync_min_age_days=7",
          "item_numbers=",
          "normalize_comment_sync_mode",
          "prepare_comment_sync_batch",
          'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
          'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\nkind=%s\\ncursor=%s\\n" "$continue_apply" "$apply_kind" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^continue=false$/m);
    assert.match(output, /^kind=all$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background and scheduled maintenance advance the same immediate all-item cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: issue\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/openclaw"',
          "target_slug=openclaw-openclaw",
          "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
          'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
          'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
          'printf "background-cursor=%s\\nbackground-selected=%s\\n" "$cursor_path" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "background-continue=%s\\n" "$continue_apply"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=true",
          "continue_apply=false",
          "item_numbers=",
          "normalize_comment_sync_mode",
          "prepare_comment_sync_batch",
          'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
          'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
          'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
          'printf "scheduled-cursor=%s\\nscheduled-selected=%s\\nscheduled-age=%s\\n" "$cursor_path" "$item_numbers" "$comment_sync_min_age_days"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "complete_comment_sync_batch report.json trace.json",
          'printf "scheduled-continue=%s\\nfinal-cursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(
      output,
      /^background-cursor=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m,
    );
    assert.match(output, /^background-selected=1,2,3,/m);
    assert.match(output, /^background-continue=false$/m);
    assert.match(
      output,
      /^scheduled-cursor=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m,
    );
    assert.match(output, /^scheduled-selected=41$/m);
    assert.match(output, /^scheduled-age=0$/m);
    assert.match(output, /^scheduled-continue=false$/m);
    assert.match(output, /^final-cursor=41$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncursored default comment sync preserves the same cross-repository continuation cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    for (const targetRepo of ["openclaw/openclaw", "openclaw/clawhub"]) {
      const targetSlug = targetRepo.replace("/", "-");
      const records = join(root, "records", targetSlug, "items");
      mkdirSync(records, { recursive: true });
      for (let number = 1; number <= 41; number += 1) {
        writeFileSync(
          join(records, `${targetSlug}-${number}.md`),
          `---\nrepository: ${targetRepo}\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
        );
      }
    }

    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "for TARGET_REPO in openclaw/openclaw openclaw/clawhub; do",
          '  target_slug="$(printf "%s" "$TARGET_REPO" | tr / -)"',
          "  comment_sync_processed_limit=40",
          "  sync_batch_size=40",
          "  sync_comments_only=true",
          "  sync_open_pr_batch=false",
          "  scheduled_comment_sync=false",
          "  continue_apply=false",
          "  apply_kind=all",
          "  comment_sync_min_age_days=0",
          "  min_age_days=0",
          "  min_age_minutes=",
          "  apply_close_reasons=all",
          "  stale_min_age_days=60",
          "  close_delay_ms=2000",
          "  checkpoint_size=80",
          '  if [ "$checkpoint_size" -gt 40 ]; then checkpoint_size=40; fi',
          "  limit=40",
          "  item_numbers=",
          '  cursor_path="results/comment-sync-cursors/${target_slug}.json"',
          "  prepare_comment_sync_batch",
          '  printf "%s initial=%s\\n" "$TARGET_REPO" "$cursor_path"',
          '  jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "  printf '[]' > report.json",
          "  complete_comment_sync_batch report.json trace.json",
          '  printf "%s continue=%s cursor=%s\\n" "$TARGET_REPO" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
          '  if [ "$continue_apply" = "true" ]; then',
          "    item_numbers=",
          "    sync_open_pr_batch=true",
          '    cursor_path="results/comment-sync-cursors/${target_slug}.json"',
          "    prepare_comment_sync_batch",
          '    batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
          '    printf "%s resumed=%s initial-cursor=%s next=%s\\n" "$TARGET_REPO" "$cursor_path" "$comment_sync_initial_cursor" "$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")"',
          "  fi",
          "done",
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(
      output,
      /^openclaw\/openclaw initial=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m,
    );
    assert.match(output, /^openclaw\/openclaw continue=false cursor=40$/m);
    assert.match(
      output,
      /^openclaw\/clawhub initial=results\/comment-sync-cursors\/openclaw-clawhub\.json$/m,
    );
    assert.match(output, /^openclaw\/clawhub continue=true cursor=40$/m);
    assert.match(
      output,
      /^openclaw\/clawhub resumed=results\/comment-sync-cursors\/openclaw-clawhub\.json initial-cursor=40 next=41$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom mutation-policy comment sync retains its own cursor and continuation", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "mkdir -p .artifacts",
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/openclaw"',
          "target_slug=openclaw-openclaw",
          "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          "apply_close_reasons=duplicate_or_superseded",
          "stale_min_age_days=1",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
          'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
          'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "custom-cursor=%s\\ncontinue=%s\\nnext=%s\\npersisted=%s\\n" "$cursor_path" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(
      output,
      /^custom-cursor=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json$/m,
    );
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^persisted=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("urgent records do not falsely wrap a customized comment-sync cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  const cursors = join(root, "results", "comment-sync-cursors");
  const now = new Date().toISOString();
  mkdirSync(records, { recursive: true });
  mkdirSync(cursors, { recursive: true });
  writeFileSync(join(cursors, "openclaw-clawhub.json"), '{"next_after_number":20}\n');
  writeFileSync(
    join(records, "5.md"),
    `---\nrepository: openclaw/clawhub\ntype: issue\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nitem_snapshot_hash: abc123\naction_taken: kept_open\nreviewed_at: ${now}\n---\n`,
  );
  for (let number = 21; number <= 61; number += 1) {
    writeFileSync(
      join(records, `${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\nreviewed_at: 2025-01-01T00:00:00Z\nreview_comment_id: 9000\nreview_comment_url: https://github.com/openclaw/clawhub/pull/${number}#issuecomment-9000\nreview_comment_sha256: ${"a".repeat(64)}\nreview_comment_synced_at: ${now}\n---\n`,
    );
  }
  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "mkdir -p .artifacts",
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "cursor_path=results/comment-sync-cursors/openclaw-clawhub.json",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
          'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
          'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\nnext=%s\\npersisted=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=21,5,22,/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^persisted=59$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncursored synchronization continues repositories without scheduled maintenance", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\nnext=%s\\ncursor=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^continue=true$/m);
    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual OpenClaw issue synchronization continues beyond scheduled PR coverage", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: issue\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const sharedCursor = join(root, "results", "comment-sync-cursors", "openclaw-openclaw.json");
  mkdirSync(dirname(sharedCursor), { recursive: true });
  writeFileSync(sharedCursor, '{"next_after_number":50}\n');

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/openclaw"',
          "target_slug=openclaw-openclaw",
          "apply_kind=issue",
          "comment_sync_min_age_days=9",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\nnext=%s\\ncursor=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^continue=true$/m);
    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled cursor synchronization continues lower-numbered records after wraparound", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (const number of [5, 21]) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const scopedCursor = join(root, "results", "comment-sync-cursors", "openclaw-clawhub.json");
  mkdirSync(dirname(scopedCursor), { recursive: true });
  writeFileSync(scopedCursor, '{"next_after_number":20}\n');

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\nnext=%s\\ncursor=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=21$/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^cursor=21$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled wrapped synchronization drains every bounded window and then stops", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 7; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const policyFingerprint = createHash("sha256")
    .update(`${["all", "60", "2000", "40", "40", "2", "0", ""].join("\n")}\n`)
    .digest("hex")
    .slice(0, 16);
  const scopedCursor = join(
    root,
    "results",
    "comment-sync-cursors",
    `openclaw-clawhub-all-age0-policy-${policyFingerprint}.json`,
  );
  mkdirSync(dirname(scopedCursor), { recursive: true });
  writeFileSync(scopedCursor, '{"next_after_number":5}\n');

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=2",
          "sync_batch_size=2",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          "item_numbers=",
          "prepare_comment_sync_batch",
          "while :; do",
          '  printf "window=%s\\n" "$item_numbers"',
          '  jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "  printf '[]' > report.json",
          "  continue_apply=false",
          "  complete_comment_sync_batch report.json trace.json",
          '  if [ "$continue_apply" != "true" ]; then break; fi',
          "  item_numbers=",
          "  sync_open_pr_batch=true",
          "  prepare_comment_sync_batch",
          '  pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path" > next.env',
          "  item_numbers=$(awk -F= '$1 == \"item_numbers\" { print $2 }' next.env)",
          "  next_cursor=$(awk -F= '$1 == \"next_cursor\" { print $2 }' next.env)",
          "  trim_comment_sync_cycle_batch",
          "done",
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^window=6,7$/m);
    assert.match(output, /^window=1,2$/m);
    assert.match(output, /^window=3,4$/m);
    assert.match(output, /^window=5$/m);
    assert.doesNotMatch(output, /^window=5,6$/m);
    assert.match(output, /^continue=false$/m);
    assert.match(output, /^cursor=5$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped cursor synchronization continues past newer out-of-cycle urgent records", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  const cursorPath = join(root, "results", "comment-sync-cursors", "openclaw-clawhub.json");
  mkdirSync(records, { recursive: true });
  mkdirSync(dirname(cursorPath), { recursive: true });
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  const syncedAt = "2026-08-01T00:00:00Z";
  for (let number = 41; number <= 100; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      [
        "---",
        "repository: openclaw/clawhub",
        "type: pull_request",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "item_snapshot_hash: abc123",
        "action_taken: kept_open",
        `review_comment_id: ${9_000 + number}`,
        `review_comment_url: https://github.com/openclaw/clawhub/pull/${number}#issuecomment-${9_000 + number}`,
        `review_comment_sha256: ${"a".repeat(64)}`,
        `reviewed_at: ${syncedAt}`,
        `review_comment_synced_at: ${syncedAt}`,
        "---",
        "",
      ].join("\n"),
    );
  }
  writeFileSync(
    join(records, "openclaw-clawhub-150.md"),
    [
      "---",
      "repository: openclaw/clawhub",
      "type: pull_request",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "item_snapshot_hash: abc123",
      "action_taken: kept_open",
      "reviewed_at: 2026-08-02T00:00:00Z",
      "---",
      "",
    ].join("\n"),
  );
  writeFileSync(
    cursorPath,
    JSON.stringify({ next_after_number: 40, cycle_start_after_number: 100, cycle_wrapped: true }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          "TARGET_REPO=openclaw/clawhub",
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          'cursor_path="$CURSOR_PATH"',
          "item_numbers=",
          "prepare_comment_sync_batch",
          'pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path" > batch.env',
          "item_numbers=$(awk -F= '$1 == \"item_numbers\" { print $2 }' batch.env)",
          "next_cursor=$(awk -F= '$1 == \"next_cursor\" { print $2 }' batch.env)",
          "trim_comment_sync_cycle_batch",
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          CURSOR_PATH: cursorPath,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=41,42,/m);
    assert.match(output, /^selected=.*78,79$/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^cursor=79$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped cursor state never widens an explicit comment-sync selection", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursor = join(root, "cursor.json");
  writeFileSync(
    cursor,
    '{"next_after_number":2,"cycle_start_after_number":5,"cycle_wrapped":true}\n',
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          'cursor_path="$CURSOR_PATH"',
          "item_numbers=99",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\n" "$item_numbers"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CURSOR_PATH: cursor,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
        },
      },
    );

    assert.match(output, /^selected=99$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped cursor resets when every remaining boundary record disappears", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursor = join(root, "cursor.json");
  writeFileSync(
    cursor,
    '{"next_after_number":2,"cycle_start_after_number":5,"cycle_wrapped":true}\n',
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          'cursor_path="$CURSOR_PATH"',
          "item_numbers=6,7",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\nwrapped=%s\\nhas_cycle=%s\\n" "$item_numbers" "$comment_sync_cycle_wrapped" "$(jq -r \'has("cycle_wrapped")\' "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CURSOR_PATH: cursor,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
        },
      },
    );

    assert.match(output, /^selected=6,7$/m);
    assert.match(output, /^wrapped=false$/m);
    assert.match(output, /^has_cycle=false$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled cursor synchronization stops after its final full batch", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 40; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^continue=false$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncursored comment synchronization selects and continues the full eligible inventory", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 1002; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: ${number === 1002 ? "retry_pr_close_coverage_proof" : "kept_open"}\n---\n`,
    );
  }
  writeFileSync(
    join(records, "openclaw-openclaw-1003.md"),
    "---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: failed\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n",
  );
  writeFileSync(
    join(records, "openclaw-openclaw-1004.md"),
    "---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: complete\naction_taken: kept_open\n---\n",
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          'TARGET_REPO="openclaw/openclaw"',
          "target_slug=openclaw-openclaw",
          "apply_kind=all",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\ncursor_path=%s\\n" "$item_numbers" "$cursor_path"',
          'mkdir -p "$(dirname "$cursor_path")"',
          'printf \'{"next_after_number":980}\\n\' > "$cursor_path"',
          "item_numbers=",
          "sync_open_pr_batch=false",
          "prepare_comment_sync_batch",
          'printf "resumed=%s\\n" "$item_numbers"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^selected=.*39,40$/m);
    assert.match(output, /^resumed=981,982,/m);
    assert.match(output, /^resumed=.*1001,1002,1003$/m);
    assert.doesNotMatch(output, /^resumed=.*1004/m);
    assert.match(output, /results\/comment-sync-cursors\/openclaw-openclaw\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment synchronization checkpoints only completed records after a runtime yield", () => {
  const root = mkdtempSync(tmpPrefix);
  const completeReport = join(root, "complete.json");
  const partialReport = join(root, "partial.json");
  const untouchedReport = join(root, "untouched.json");
  const completeTrace = join(root, "complete-trace.json");
  const partialTrace = join(root, "partial-trace.json");
  const untouchedTrace = join(root, "untouched-trace.json");
  const invalidTrace = join(root, "invalid-trace.json");
  const cursorPath = join(root, "comment-sync-cursor.json");
  writeFileSync(completeReport, JSON.stringify([{ number: 50, action: "review_comment_synced" }]));
  writeFileSync(
    partialReport,
    JSON.stringify([
      { number: 10, action: "review_comment_synced" },
      { number: 20, action: "skipped_stale_review_comment_sync" },
      { number: 30, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(
    untouchedReport,
    JSON.stringify([
      { number: 10, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(
    completeTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20, 30, 40, 50] }),
  );
  writeFileSync(
    partialTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }),
  );
  writeFileSync(untouchedTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [] }));
  writeFileSync(invalidTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [30] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          'TARGET_REPO="openclaw/openclaw"',
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=10,20,30,40,50",
          "next_cursor=50",
          'complete_comment_sync_batch "$COMPLETE_REPORT" "$COMPLETE_TRACE"',
          'printf "complete=%s|count=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count"',
          "next_cursor=50",
          'complete_comment_sync_batch "$PARTIAL_REPORT" "$PARTIAL_TRACE"',
          'printf "partial=%s|count=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count"',
          "next_cursor=50",
          'complete_comment_sync_batch "$UNTOUCHED_REPORT" "$UNTOUCHED_TRACE"',
          'printf "untouched=%s|next=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$next_cursor"',
          'if complete_comment_sync_batch "$PARTIAL_REPORT" "$INVALID_TRACE" 2>/dev/null; then echo missing_prefix_published; else echo missing_prefix_rejected; fi',
          'printf "missing_prefix_cursor=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          COMPLETE_REPORT: completeReport,
          PARTIAL_REPORT: partialReport,
          UNTOUCHED_REPORT: untouchedReport,
          COMPLETE_TRACE: completeTrace,
          PARTIAL_TRACE: partialTrace,
          UNTOUCHED_TRACE: untouchedTrace,
          INVALID_TRACE: invalidTrace,
          CURSOR_PATH: cursorPath,
        },
      },
    );

    assert.match(output, /^complete=50\|count=5$/m);
    assert.match(output, /^partial=20\|count=2$/m);
    assert.match(output, /^untouched=20\|next=$/m);
    assert.match(output, /^missing_prefix_published$/m);
    assert.match(output, /^missing_prefix_cursor=20$/m);
    assert.doesNotMatch(output, /^missing_prefix_rejected$/m);
    assert.doesNotMatch(output, /^partial=30$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment sync advances a completed frontier before a budget-clipped urgent tail", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursorPath = join(root, "comment-sync-cursor.json");
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  writeFileSync(cursorPath, JSON.stringify({ next_after_number: 105854 }));
  writeFileSync(
    reportPath,
    JSON.stringify([
      { number: 105870, action: "kept_open" },
      { number: 87267, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(
    tracePath,
    JSON.stringify({
      schema_version: 1,
      examined_item_numbers: [105870],
    }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          'TARGET_REPO="openclaw/openclaw"',
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=true",
          "comment_sync_initial_cursor=105854",
          "item_numbers=87267,95788,97566,105342,105870",
          "next_cursor=105870",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "advanced=%s|count=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count"',
          'pnpm run workflow -- write-comment-sync-cursor --cursor-path "$cursor_path" --next-cursor 105854 --target-repo "$TARGET_REPO"',
          "item_numbers=87267,95788,97566,105342,105870",
          "next_cursor=105870",
          'printf \'{"schema_version":1,"examined_item_numbers":[]}\' > clipped-trace.json',
          'complete_comment_sync_batch "$REPORT_PATH" clipped-trace.json',
          'printf "clipped=%s|count=%s|next=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count" "$next_cursor"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          CURSOR_PATH: cursorPath,
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
        },
      },
    );

    assert.match(output, /^advanced=105870\|count=1$/m);
    assert.match(output, /^clipped=105854\|count=0\|next=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment synchronization advances past records archived during scoped reconciliation", () => {
  const root = mkdtempSync(tmpPrefix);
  const targetSlug = "openclaw-clawhub";
  const recordsDir = join(root, "records", targetSlug);
  const cursorPath = join(root, "results", "comment-sync-cursors", `${targetSlug}.json`);
  const tracePath = join(root, "trace.json");
  const reportPath = join(root, "report.json");
  mkdirSync(join(recordsDir, "items"), { recursive: true });
  mkdirSync(join(recordsDir, "closed"), { recursive: true });
  mkdirSync(dirname(cursorPath), { recursive: true });
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  writeFileSync(join(recordsDir, "closed", `${targetSlug}-10.md`), "closed\n");
  for (const number of [20, 30]) {
    writeFileSync(
      join(recordsDir, "items", `${targetSlug}-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [20] }));
  writeFileSync(reportPath, JSON.stringify([{ number: 20, action: "review_comment_synced" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "TARGET_REPO=openclaw/clawhub",
          "target_slug=openclaw-clawhub",
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "sync_batch_size=40",
          "apply_kind=all",
          "comment_sync_initial_cursor=0",
          "continue_apply=false",
          "item_numbers=10,20",
          "next_cursor=20",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "cursor=%s\\ncount=%s\\ncontinue=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count" "$continue_apply"',
          "continue_apply=false",
          "item_numbers=5,20",
          "next_cursor=20",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "unknown_count=%s\\nunknown_next=%s\\n" "$comment_sync_cursor_advance_count" "$next_cursor"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          CURSOR_PATH: cursorPath,
          TRACE_PATH: tracePath,
          REPORT_PATH: reportPath,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^cursor=20$/m);
    assert.match(output, /^count=2$/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^unknown_count=0$/m);
    assert.match(output, /^unknown_next=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("urgent synchronization never advances past unfinished lower-numbered records", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursorPath = join(root, "comment-sync-cursor.json");
  const urgentTrace = join(root, "urgent-trace.json");
  const partialTrace = join(root, "partial-trace.json");
  const reorderedUrgentTrace = join(root, "reordered-urgent-trace.json");
  const reorderedCompleteTrace = join(root, "reordered-complete-trace.json");
  const reportPath = join(root, "report.json");
  writeFileSync(cursorPath, JSON.stringify({ next_after_number: 100 }));
  writeFileSync(urgentTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [1000] }));
  writeFileSync(
    partialTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [1000, 110] }),
  );
  writeFileSync(
    reorderedUrgentTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [120] }),
  );
  writeFileSync(
    reorderedCompleteTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [120, 110] }),
  );
  writeFileSync(reportPath, JSON.stringify([{ number: 1000, action: "review_comment_synced" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          "TARGET_REPO=openclaw/openclaw",
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=true",
          "comment_sync_initial_cursor=100",
          "item_numbers=1000,110,120",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$URGENT_TRACE"',
          'printf "urgent-only=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
          "item_numbers=1000,110,120",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$PARTIAL_TRACE"',
          'printf "urgent-and-first=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
          'pnpm run workflow -- write-comment-sync-cursor --cursor-path "$cursor_path" --next-cursor 100 --target-repo "$TARGET_REPO"',
          "item_numbers=120,110",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$REORDERED_URGENT_TRACE"',
          'printf "reordered-urgent-only=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
          "item_numbers=120,110",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$REORDERED_COMPLETE_TRACE"',
          'printf "reordered-complete=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          CURSOR_PATH: cursorPath,
          REPORT_PATH: reportPath,
          URGENT_TRACE: urgentTrace,
          PARTIAL_TRACE: partialTrace,
          REORDERED_URGENT_TRACE: reorderedUrgentTrace,
          REORDERED_COMPLETE_TRACE: reorderedCompleteTrace,
        },
      },
    );

    assert.match(output, /^urgent-only=100$/m);
    assert.match(output, /^urgent-and-first=110$/m);
    assert.match(output, /^reordered-urgent-only=100$/m);
    assert.match(output, /^reordered-complete=120$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit comment synchronization stops an unproductive continuation before it can loop", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "sync_open_pr_batch=false",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=42",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "continue=%s\\nremaining=%s\\n" "$continue_apply" "$item_numbers"',
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, REPORT_PATH: reportPath, TRACE_PATH: tracePath } },
    );

    assert.match(output, /^continue=false$/m);
    assert.match(output, /^remaining=42$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor-based comment synchronization never continues after operational publication fails", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  const cursorPath = join(root, "comment-sync-cursor.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 10, action: "review_comment_synced" }]));
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [10] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          'TARGET_REPO="openclaw/openclaw"',
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=10,20",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'publish_changes_with_strategy() { [ "$1" = normal ]; }',
          'publish_changes "test cursor publication" records results/comment-sync-cursors',
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
          CURSOR_PATH: cursorPath,
        },
      },
    );

    assert.match(output, /^continue=false$/m);
    assert.match(output, /^cursor=10$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled cursor synchronization never continues after cursor publication fails", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (const number of [10, 20]) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 10, action: "review_comment_synced" }]));
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [10] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          'cursor_path="results/comment-sync-cursors/openclaw-clawhub.json"',
          "sync_open_pr_batch=true",
          "sync_batch_size=1",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=10",
          "mkdir -p .artifacts",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "before=%s\\n" "$continue_apply"',
          'publish_changes_with_strategy() { [ "$1" = normal ]; }',
          'publish_changes "test cursor publication" records results/comment-sync-cursors',
          'printf "after=%s\\n" "$continue_apply"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
        },
      },
    );

    assert.match(output, /^before=true$/m);
    assert.match(output, /^after=false$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit item continuation survives unrelated cursor bookkeeping failure", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'TARGET_REPO="openclaw/clawhub"',
        "sync_open_pr_batch=false",
        "continue_apply=true",
        'publish_changes_with_strategy() { [ "$1" = normal ]; }',
        'publish_changes "test cursor publication" records results/comment-sync-cursors',
        'printf "continue=%s\\n" "$continue_apply"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^continue=true$/m);
});

test("explicit comment synchronization preserves all unfinished items after a runtime yield", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  const selected = Array.from({ length: 43 }, (_, index) => index + 1).join(",");
  writeFileSync(
    reportPath,
    JSON.stringify([
      { number: 1, action: "review_comment_synced" },
      { number: 2, action: "review_comment_synced" },
      { number: 3, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [1, 2] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "comment_sync_processed_limit=40",
          "sync_batch_size=43",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "continue_apply=false",
          'item_numbers="$SELECTED_ITEMS"',
          "prepare_comment_sync_batch",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "continue=%s\\nremaining=%s\\ncount=%s\\n" "$continue_apply" "$item_numbers" "$comment_sync_cursor_advance_count"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SELECTED_ITEMS: selected,
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
        },
      },
    );

    assert.match(output, /^continue=true$/m);
    assert.match(output, /^remaining=3,4,5,/m);
    assert.match(output, /^remaining=.*40,41,42,43$/m);
    assert.match(output, /^count=2$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow does not queue runtime-yield continuation without cursor progress", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "apply-report.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "pnpm() { printf '1\\n'; }",
          "source scripts/apply-workflow-helpers.sh",
          "continue_apply=false",
          "auto_selected_apply_batch=true",
          "cursor_advance_count=0",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
          "continue_apply=false",
          "cursor_advance_count=1",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          REPORT_PATH: reportPath,
        },
      },
    );

    assert.deepEqual(
      output
        .trim()
        .split("\n")
        .filter((line) => line.includes("|")),
      ["yielded|false", "yielded|true"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply checkpoint publishes a clean token-budget stop and a later run resumes", () => {
  const root = mkdtempSync(tmpPrefix);
  const stoppedReport = join(root, "stopped.json");
  const resumedReport = join(root, "resumed.json");
  writeFileSync(
    stoppedReport,
    JSON.stringify([
      {
        number: 0,
        action: "skipped_runtime_budget",
        reason: "apply token budget reached at 4300000ms since epoch",
      },
    ]),
  );
  writeFileSync(resumedReport, JSON.stringify([{ number: 42, action: "closed" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS=1000000",
          "initialize_apply_token_budget",
          'printf "deadline=%s\\n" "$CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS"',
          'if apply_token_budget_reached "$STOPPED_REPORT"; then apply_token_budget_stop_summary 7 12; fi',
          'if apply_token_budget_reached "$RESUMED_REPORT"; then echo stopped-again; else echo resumed; fi',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, STOPPED_REPORT: stoppedReport, RESUMED_REPORT: resumedReport },
      },
    );
    assert.match(output, /deadline=4300000/);
    assert.match(
      output,
      /apply stopped at token budget: processed=7 remaining=~12; next run continues/,
    );
    assert.match(output, /resumed/);
    assert.doesNotMatch(output, /stopped-again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow drops a coverage-proof tail only after exact trace examination", () => {
  const root = mkdtempSync(tmpPrefix);
  const fastOnlyTrace = join(root, "fast-only.json");
  const firstProofTrace = join(root, "proof-first.json");
  const secondProofTrace = join(root, "proof-second.json");
  writeFileSync(
    fastOnlyTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }),
  );
  writeFileSync(
    firstProofTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [30] }),
  );
  writeFileSync(
    secondProofTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [40] }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node dist/repair/workflow-utils.js "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          "auto_selected_apply_batch=true",
          "item_numbers=10,20,30,40",
          "coverage_proof_item_numbers=30,40",
          'item_numbers_arg=(--item-numbers "$item_numbers")',
          'drop_bounded_coverage_proof_tail "$FAST_ONLY_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$FIRST_PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$SECOND_PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAST_ONLY_TRACE: fastOnlyTrace,
          FIRST_PROOF_TRACE: firstProofTrace,
          SECOND_PROOF_TRACE: secondProofTrace,
          NODE_BIN_DIR: dirname(process.execPath),
        },
      },
    );
    assert.deepEqual(output.trim().split("\n"), [
      "10,20,30,40|30,40|--item-numbers 10,20,30,40",
      "10,20,40|40|--item-numbers 10,20,40",
      "10,20||--item-numbers 10,20",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply proof and mutation start from fresh non-persisted source checkouts", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const proofJobStart = workflow.indexOf("\n  apply-proof:");
  const proofPublisherStart = workflow.indexOf("\n  publish-apply-proof-action-ledger:");
  const applyJobStart = workflow.indexOf("\n  apply-existing:");
  assert.notEqual(proofJobStart, -1);
  assert.notEqual(proofPublisherStart, -1);
  assert.notEqual(applyJobStart, -1);
  const proofJob = workflow.slice(proofJobStart, proofPublisherStart);
  const applyJob = workflow.slice(applyJobStart);

  assert.match(proofJob, /actions\/checkout@v7[\s\S]*?persist-credentials: false/);
  assert.match(
    proofJob,
    /uses: \.\/\.github\/actions\/setup-state[\s\S]*?persist-credentials: "false"/,
  );
  assert.match(applyJob, /actions\/checkout@v7[\s\S]*?persist-credentials: false/);
  assert.doesNotMatch(proofJob, /git pull --rebase/);
  assert.doesNotMatch(applyJob, /git pull --rebase/);
});

test("sweep target fanout uses owner inventory and central hosted-target tokens", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const stepBlocks = (name: string) =>
    workflow
      .split(`- name: ${name}`)
      .slice(1)
      .map((block) => block.split("\n      - ")[0]);

  const inventoryTargets = [
    ["openclaw", "openclaw"],
    ["steipete", "steipete"],
  ] as const;
  for (const [label, owner] of inventoryTargets) {
    const blocks = stepBlocks(`Create ${label} inventory token`);
    assert.equal(blocks.length, 1, `missing owner inventory token for ${label}`);
    assert.match(blocks[0] ?? "", /continue-on-error: true/);
    assert.match(blocks[0] ?? "", new RegExp(`owner: ${owner}`));
    assert.doesNotMatch(blocks[0] ?? "", /repositories:/);
    assert.match(blocks[0] ?? "", /permission-metadata: read/);
  }
  const hostedMetadataBlocks = stepBlocks("Create hosted target metadata token");
  assert.equal(hostedMetadataBlocks.length, 1);
  assert.match(hostedMetadataBlocks[0] ?? "", /continue-on-error: true/);
  assert.match(hostedMetadataBlocks[0] ?? "", /owner: openclaw/);
  assert.match(hostedMetadataBlocks[0] ?? "", /repositories: clawsweeper/);
  assert.match(hostedMetadataBlocks[0] ?? "", /permission-metadata: read/);
  assert.match(workflow, /CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW/);
  assert.match(workflow, /CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE/);
  assert.match(workflow, /CLAWSWEEPER_HOSTED_TARGET_METADATA_TOKEN/);
  assert.doesNotMatch(workflow, /CLAWSWEEPER_TARGET_METADATA_TOKEN_/);
  for (const name of [
    "Create target read token",
    "Create target write token",
    "Create target review token",
    "Create target Codex inspection token",
    "Create target proof inspection token",
  ]) {
    const blocks = stepBlocks(name);
    assert.ok(blocks.length > 0, `missing workflow step: ${name}`);
    for (const block of blocks) {
      assert.match(block, /continue-on-error: true/);
    }
  }
  assert.match(
    workflow,
    /GH_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.match(
    workflow,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.codex-inspection-token\.outputs\.token \}\}/,
  );
  assert.doesNotMatch(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN:.*\|\| github\.token/);
  assert.ok(
    workflow.includes(
      "if: ${{ always() && !cancelled() && steps.sync-selected-review-comments.outputs.sync_succeeded == 'true' && steps.target-write-token.outputs.token != '' && github.event.inputs.apply_after_review == 'true' }}",
    ),
  );
  assert.doesNotMatch(workflow, new RegExp("OPENCLAW_" + "GH_TOKEN"));
});

test("public OpenClaw reads use workflow tokens without moving mutation identity", () => {
  type Step = {
    name?: string;
    id?: string;
    env?: Record<string, string>;
    run?: string;
    with?: Record<string, string>;
  };
  type Workflow = { jobs: Record<string, { steps: Step[] }> };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as Workflow;
  const find = (job: string, name: string) => {
    const selected = workflow.jobs[job]?.steps.find(
      (candidate) => candidate.name === name || candidate.id === name,
    );
    assert.ok(selected, `${job}: ${name}`);
    return selected;
  };

  const exactReview = find("event-review-apply", "Review exact event item");
  assert.equal(exactReview.env?.GH_TOKEN, "${{ steps.target-read-token.outputs.token }}");
  assert.equal(
    find("event-review-publish", "Confirm terminal item remains closed").env?.GH_TOKEN,
    "${{ steps.publication-context.outputs.target_repo == 'openclaw/openclaw' && github.token || steps.target-write-token.outputs.token }}",
  );
  assert.equal(
    find("apply-existing", "Reconcile before apply preselect").env?.GH_TOKEN,
    "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || steps.target-write-token.outputs.token }}",
  );

  const auditSelection = find("audit-dashboard", "Select target read token");
  assert.equal(auditSelection.env?.PRIMARY_TOKEN, "${{ github.token }}");
  assert.equal(
    auditSelection.env?.APP_FALLBACK_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.match(auditSelection.run ?? "", /Using workflow token for public audit reads/);
  assert.match(auditSelection.run ?? "", /Using ClawSweeper App token fallback for audit reads/);

  for (const [job, name, expression] of [
    [
      "event-review-apply",
      "Deliver GitHub effects and prepare direct state mutation",
      "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
    [
      "event-review-publish",
      "Publish event result and apply safe close",
      "${{ steps.publication-context.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
    [
      "publish",
      "Sync selected review comments",
      "${{ needs.plan.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
    [
      "apply-existing",
      "Apply unchanged proposed decisions with checkpoints",
      "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
  ] as const) {
    const selected = find(job, name);
    assert.equal(selected.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
    assert.equal(selected.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN, expression);
  }

  const reviewShard = find("review", "Review shard");
  const applyProof = find("apply-proof", "Generate bound close coverage proofs");
  assert.equal(
    reviewShard.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN,
    "${{ needs.plan.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
  );
  assert.equal(
    exactReview.env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.equal(
    reviewShard.env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.codex-inspection-token.outputs.token }}",
  );
  assert.equal(
    applyProof.env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.proof-inspection-token.outputs.token }}",
  );
  assert.equal(applyProof.env?.GH_TOKEN, "${{ github.token }}");
  const proofInspectionToken = find("apply-proof", "Create target proof inspection token");
  assert.equal(proofInspectionToken.with?.["permission-contents"], "read");
  assert.equal(proofInspectionToken.with?.["permission-issues"], "read");
  assert.equal(proofInspectionToken.with?.["permission-pull-requests"], "read");
});

test("sweep target review token can post pull request review leases", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const targetReviewTokenBlocks = workflow
    .split("- name: Create target review token")
    .slice(1)
    .map((block) => block.split("\n      - ")[0]);

  assert.equal(targetReviewTokenBlocks.length, 1);
  const [targetReviewToken] = targetReviewTokenBlocks;
  assert.match(targetReviewToken ?? "", /permission-issues: write/);
  assert.match(targetReviewToken ?? "", /permission-pull-requests: write/);
});

test(
  "read-only checkout mode restores file modes and leaves git metadata writable",
  {
    skip:
      process.platform === "win32" ? "exact POSIX mode bits are not portable on Windows" : false,
  },
  () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const target = join(root, "target");
      const nested = join(target, "src");
      const gitDir = join(target, ".git");
      mkdirSync(nested, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      const sourceFile = join(nested, "app.ts");
      const executableFile = join(target, "tool.sh");
      const gitConfig = join(gitDir, "config");
      writeFileSync(sourceFile, "export const value = 1;\n");
      writeFileSync(executableFile, "#!/bin/sh\n");
      writeFileSync(gitConfig, "[core]\n");
      chmodSync(target, 0o755);
      chmodSync(nested, 0o750);
      chmodSync(sourceFile, 0o640);
      chmodSync(executableFile, 0o755);
      chmodSync(gitDir, 0o700);
      chmodSync(gitConfig, 0o600);

      const snapshots = makeTreeReadOnlyForTest(target);
      assert.equal(statSync(target).mode & 0o777, 0o555);
      assert.equal(statSync(nested).mode & 0o777, 0o555);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o444);
      assert.equal(statSync(executableFile).mode & 0o777, 0o555);
      assert.equal(statSync(gitDir).mode & 0o777, 0o700);
      assert.equal(statSync(gitConfig).mode & 0o777, 0o600);

      restoreTreeModesForTest(snapshots);
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.equal(statSync(nested).mode & 0o777, 0o750);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o640);
      assert.equal(statSync(executableFile).mode & 0o777, 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("event review completion removes ClawSweeper eyes reaction", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: React to target item completion"),
    workflow.indexOf("\n\n  plan:"),
  );

  assert.match(block, /-f content="\+1"/);
  assert.match(block, /-f content="eyes"/);
  assert.match(block, /repos\/\$TARGET_REPO\/issues\/\$ITEM_NUMBER\/reactions\/\$reaction_id/);
  assert.match(block, /"openclaw-clawsweeper\[bot\]"/);
  assert.doesNotMatch(block, /issues\/comments\/\$ITEM_NUMBER\/reactions/);
});

test("event re-review status distinguishes lease deferral from interruptions", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Mark unsuccessful re-review"),
    workflow.indexOf("- name: Export exact review generation result"),
  );

  assert.match(block, /\[ "\$REVIEW_OUTCOME" = "cancelled" \]/);
  assert.match(block, /\[ "\$RESERVATION_STATUS" = "held" \]/);
  assert.match(block, /state="Waiting"/);
  assert.match(block, /Another exact-head review is already active/);
  assert.match(block, /state="Interrupted"/);
  assert.match(block, /The durable queue will retry it/);
  assert.doesNotMatch(block, /CAPACITY_OUTCOME/);
  assert.doesNotMatch(block, /state="Superseded"/);
});

test("trusted comment router owns command ledger capacity retries", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const routerWorkflow = readText(".github/workflows/repair-comment-router.yml");
  const eventStart = sweepWorkflow.indexOf("\n  event-review-apply:");
  const eventEnd = sweepWorkflow.indexOf("\n  target-fanout:", eventStart);
  const eventJob = sweepWorkflow.slice(eventStart, eventEnd);

  assert.doesNotMatch(eventJob, /publish-action-events/);
  assert.doesNotMatch(eventJob, /publish-action-event-paths/);
  assert.doesNotMatch(eventJob, /count-command-actions/);
  assert.doesNotMatch(eventJob, /--wait-for-capacity/);
  assert.match(routerWorkflow, /Commit comment router ledger/);
  assert.match(routerWorkflow, /Detect waiting repair dispatches/);
  assert.match(routerWorkflow, /--status waiting,active/);
  assert.match(routerWorkflow, /--wait-for-capacity/);
});

test("comment router publishes only durable ledger mutations and changed jobs", () => {
  const workflow = readText(".github/workflows/repair-comment-router.yml");
  const initialStart = workflow.indexOf("- name: Commit comment router ledger");
  const initialEnd = workflow.indexOf("- name: Detect waiting repair dispatches", initialStart);
  const retryStart = workflow.indexOf("- name: Commit comment router retry ledger");
  const retryEnd = workflow.indexOf("- name: Finalize command action ledger", retryStart);
  const publishSteps = [
    workflow.slice(initialStart, initialEnd),
    workflow.slice(retryStart, retryEnd),
  ];

  for (const step of publishSteps) {
    assert.match(step, /git diff --no-index --quiet -- "\$CLAWSWEEPER_STATE_DIR\/jobs" jobs/);
    assert.match(step, /\[ "\$jobs_changed" = "0" \] &&/);
    assert.match(step, /\(\(\.ledger_claimed \/\/ 0\) \+ \(\.ledger_changed \/\/ 0\)\) == 0/);
    assert.match(step, /No durable router(?: retry)? state changed; skipping state publication\./);
    assert.match(step, /--path results\/comment-router\.json/);
    assert.doesNotMatch(step, /--path results\/comment-router-latest\.json/);
    assert.match(step, /\[ "\$jobs_changed" = "1" \]/);
    assert.match(step, /publish_args\+=\(--path jobs\)/);
    assert.doesNotMatch(step, /--path jobs \\/);
  }
});

test("deferred exact verdict routers cannot replace each other's pending runs", () => {
  const workflow = readText(".github/workflows/repair-comment-router.yml");
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("\njobs:"));

  // GitHub keeps only one pending run per group even when cancel-in-progress is false.
  // Binding exact workflow dispatches to their item preserves both handoffs under load.
  assert.match(concurrency, /github\.event_name == 'workflow_dispatch'/);
  assert.match(concurrency, /github\.event\.inputs\.item_numbers != ''/);
  assert.match(
    concurrency,
    /format\('repair-comment-router-\{0\}-items-\{1\}'[\s\S]*github\.event\.inputs\.item_numbers/,
  );
  assert.match(concurrency, /cancel-in-progress: false/);
});

test("comment commands keep the router-to-sweep dispatch contract", () => {
  const routerWorkflow = readText(".github/workflows/repair-comment-router.yml");
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const routerSource = readText("src/repair/comment-router.ts");

  assert.match(routerWorkflow, /types:\s*\[clawsweeper_comment\]/);
  assert.match(routerWorkflow, /pnpm run repair:comment-router/);
  assert.match(
    routerWorkflow,
    /status_comment_id="\$\{\{ github\.event\.client_payload\.status_comment_id \|\| '' \}\}"/,
  );
  assert.match(routerWorkflow, /--status-comment-id "\$status_comment_id"/);
  assert.match(
    routerWorkflow,
    /source_delivery_id="\$\{\{ github\.event\.client_payload\.source_delivery_id \|\| '' \}\}"/,
  );
  assert.match(routerWorkflow, /--source-delivery-id "\$source_delivery_id"/);
  assert.match(routerWorkflow, /dispatch_actor="\$\{\{ github\.actor \}\}"/);
  assert.match(routerWorkflow, /--dispatch-actor "\$dispatch_actor"/);
  assert.match(routerWorkflow, /--comment-event-auth "\$comment_event_auth"/);
  assert.match(routerWorkflow, /--comment-updated-at "\$comment_updated_at"/);
  assert.match(routerWorkflow, /--comment-body-sha256 "\$comment_body_sha256"/);
  assert.match(routerWorkflow, /\.short_circuited == true/);
  assert.match(
    routerSource,
    /if \(claimed\) return \{ \.\.\.claimed, workflow: reviewWorkflow, repo: reviewRepo \};\s*if \(requiresCommandStatus\) \{\s*const retainedStatusComment = findExistingCommandStatusComment\(command\);\s*if \(retainedStatusComment\?\.id\) command\.status_comment_id = Number\(retainedStatusComment\.id\);\s*\}/,
  );
  assert.match(routerSource, /event_type:\s*"clawsweeper_item"/);
  assert.match(routerSource, /adaptiveReviewBudgetForPullRequest\(command\.target\)/);
  assert.match(routerSource, /review_options:\s*\{/);
  assert.match(routerSource, /media_proof_timeout_ms: reviewBudget\.mediaProofTimeoutMs/);
  assert.match(routerSource, /dispatch_key:\s*dispatchKey/);
  assert.match(routerSource, /source_delivery_id:\s*String\(command\.source_delivery_id\)/);
  assert.match(routerSource, /`item_numbers=\$\{dispatchKey\}`/);
  assert.match(routerSource, /event:\s*"workflow_dispatch"/);
  assert.match(sweepWorkflow, /types:\s*\[clawsweeper_item,\s*clawsweeper_target_sweep\]/);
  assert.match(sweepWorkflow, /Review event item \{0\}#\{1\} \[\{2\}\]/);
  assert.match(sweepWorkflow, /startsWith\(github\.event\.inputs\.item_numbers, 'router-'\)/);
  assert.match(sweepWorkflow, /sourceDeliveryId:\s*payload\.source_delivery_id/);
  assert.match(sweepWorkflow, /reviewOptions\.codex_timeout_ms/);
  assert.match(sweepWorkflow, /reviewOptions\.media_proof_timeout_ms/);
  assert.doesNotMatch(sweepWorkflow, /types:\s*\[[^\]]*clawsweeper_comment/);
});

test("comment router prunes bare ack comments after updating shared automerge status", () => {
  const routerSource = readText("src/repair/comment-router.ts");
  const postComment = routerSource.slice(
    routerSource.indexOf("function postComment("),
    routerSource.indexOf("\nfunction findExistingCommandStatusComment"),
  );

  assert.match(postComment, /const existingStatus = findExistingCommandStatusComment\(command\);/);
  assert.match(postComment, /const precreated = findPrecreatedCommandStatusComment\(command\);/);
  assert.match(postComment, /const existing = existingStatus \?\? precreated;/);
  assert.match(
    postComment,
    /if \(existingStatus && precreatedId > 0 && precreatedId !== existingId\)/,
  );
  assert.match(postComment, /issues\/comments\/\$\{precreatedId\}/);
  assert.match(postComment, /"DELETE"/);
  assert.match(postComment, /pruned_ack_comment_id: String\(precreatedId\)/);
});

test("exact queue and manual item dispatches reserve their live shard capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const runName = workflow.slice(workflow.indexOf("run-name:"), workflow.indexOf("\non:"));
  const exactCapacityBlock = workflow.slice(
    workflow.indexOf("active_sweep_exact_workers()"),
    workflow.indexOf("active_sweep_background_workers()"),
  );
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );

  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
  assert.doesNotMatch(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.hot_intake == 'true' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
  assert.match(runName, /format\('Review manual item \[\{0\}\]'/);
  assert.match(runName, /'Review manual item'/);
  assert.match(runName, /format\('Review manual batch \[shards=\{0\}\]'/);
  assert.doesNotMatch(runName, /github\.event\.inputs\.item_count/);
  assert.match(runName, /'Review manual target'/);
  assert.ok(
    runName.indexOf("'Review manual item'") < runName.lastIndexOf("'Review ClawSweeper items'"),
  );
  assert.match(exactCapacityBlock, /\.displayTitle \| startswith\("Review manual item"\)/);
  assert.match(exactCapacityBlock, /\.displayTitle \| startswith\("Review manual batch "\)/);
  assert.match(exactCapacityBlock, /\.displayTitle \| startswith\("Review exact item "\)/);
  assert.match(exactCapacityBlock, /\.displayTitle \| startswith\("Review scheduled hot item "\)/);
  assert.match(
    exactCapacityBlock,
    /\.displayTitle \| startswith\("Review scheduled normal item "\)/,
  );
  const singularFastPath = exactCapacityBlock.slice(
    exactCapacityBlock.indexOf('if [[ "$title" == Review\\ exact\\ item\\ * ]]'),
    exactCapacityBlock.indexOf('if [ "$status" = "in_progress" ]'),
  );
  assert.match(singularFastPath, /active_shards=1/);
  assert.match(singularFastPath, /continue/);
  assert.doesNotMatch(singularFastPath, /gh run view/);
  assert.match(exactCapacityBlock, /gh run view "\$id".*--json jobs/);
  assert.match(exactCapacityBlock, /limit review_shards\.hard_cap/);
  assert.match(exactCapacityBlock, /reserved_shards="\$hard_cap"/);
  assert.match(exactCapacityBlock, /\[shards=\(\[0-9\]\+\)/);
  assert.match(exactCapacityBlock, /reserved_shards="\$requested_shards"/);
  assert.doesNotMatch(exactCapacityBlock, /reserved_shards="\$item_count"/);
  for (const [requested, cap, expected] of [
    [9, 89, 9],
    [4, 89, 4],
    [120, 89, 89],
  ]) {
    assert.equal(Math.min(requested, cap), expected);
  }
  const manualNames = runName.slice(
    runName.indexOf("'Review manual item'"),
    runName.indexOf("'Audit ClawSweeper state'"),
  );
  assert.doesNotMatch(manualNames, /github\.event\.inputs\.target_repo/);
  assert.doesNotMatch(manualNames, /github\.event\.inputs\.item_number,/);
  assert.match(modeBlock, /active_run_count .* \+ \$\(active_sweep_exact_workers\)/);
});

test("sweep workflow publishes target-scoped state paths", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.match(workflow, /target_slug="\$TARGET_REPO"/);
  assert.match(workflow, /--path "records\/\$\{target_slug\}"/);
  assert.match(workflow, /--path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.doesNotMatch(workflow, /--path records\s*\\/);
  assert.doesNotMatch(workflow, /--path results\/sweep-status\s*\\/);
});

test("sweep workflow coalesces durable issue and PR comment sync batches", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyHelper = readText("scripts/apply-workflow-helpers.sh");

  assert.match(workflow, /cron: "6,21,36,51 \* \* \* \*"/);
  assert.doesNotMatch(workflow, /apply_sync_open_pr_batch:/);
  assert.match(
    workflow,
    /sync_batch_size="\$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.apply_limit \|\| '40' \}\}"/,
  );
  assert.match(workflow, /\$item_numbers" = "__cursor__"/);
  assert.match(workflow, /comment-sync-batch/);
  assert.match(workflow, /complete_comment_sync_batch/);
  assert.match(applyHelper, /write-comment-sync-cursor/);
  assert.match(workflow, /results\/comment-sync-cursors\/\$\{target_slug\}\.json/);
  assert.match(workflow, /normalize_comment_sync_mode/);
  const checkpointCap = workflow.indexOf('if [ "$checkpoint_size" -gt 40 ]; then');
  assert.ok(checkpointCap >= 0);
  assert.ok(checkpointCap < workflow.indexOf("          prepare_comment_sync_batch"));
  assert.match(applyHelper, /sync_open_pr_batch:-false.*[\s\S]*?apply_kind="all"/);
  assert.match(workflow, /APPLY_SYNC_OPEN_PR_BATCH/);
  assert.match(workflow, /github\.event\.schedule == '6,21,36,51 \* \* \* \*'/);
  assert.match(
    applyHelper,
    /if \[ "\$\{scheduled_comment_sync:-false\}" = "true" \]; then\s+apply_kind="all"\s+comment_sync_min_age_days=0\s+fi/,
  );
  const cursorPreselectStart = workflow.indexOf("- name: Reconcile before apply preselect");
  const cursorApplyStart = workflow.indexOf(
    "- name: Apply unchanged proposed decisions with checkpoints",
    cursorPreselectStart,
  );
  const cursorPreselect = workflow.slice(cursorPreselectStart, cursorApplyStart);
  const cursorExecution = workflow.slice(cursorApplyStart);
  assert.match(
    cursorPreselect,
    /if: \$\{\{ .*github\.event\.inputs\.apply_sync_comments_only == 'true' \|\| github\.event\.inputs\.apply_item_numbers == '__cursor__'.*\}\}/,
  );
  assert.doesNotMatch(cursorPreselect, /Deferring reconciliation/);
  assert.ok(
    cursorExecution.indexOf(
      `sync_comments_only="\${{ github.event_name == 'workflow_dispatch' && github.event.inputs.apply_sync_comments_only || 'false' }}"`,
    ) < cursorExecution.indexOf("prepare_apply_reconciliation_args"),
    "comment-only mode must be known before execution reconciliation is prepared",
  );
  assert.ok(
    cursorExecution.indexOf('echo "Selected cursor-based comment sync batch: $item_numbers"') <
      cursorExecution.indexOf('persist_reconciliation "${reconcile_args[@]}"'),
    "cursor-based synchronization must select its exact items before reconciliation",
  );
  assert.match(cursorExecution, /prepare_apply_reconciliation_args/);
  assert.match(
    readText("scripts/apply-workflow-helpers.sh"),
    /if \[ "\$\{sync_comments_only:-false\}" = "true" \]; then\s+reconcile_args\+=\(--only-item-numbers\)/,
    "comment-only reconciliation must not archive or rewrite unrelated durable records",
  );
});

test("sweep target checkouts retry without cached references", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const checkoutBlocks =
    workflow.match(/- name: Check out target repository[\s\S]*?rev-parse --short HEAD/g) ?? [];

  assert.equal(checkoutBlocks.length, 2);
  for (const block of checkoutBlocks) {
    assert.match(block, /Cached target repository fetch failed; rebuilding cache/);
    assert.match(block, /Cached target checkout failed; retrying without cache reference/);
    assert.match(block, /rm -rf "\$checkout_dir" "\$cache_dir"/);
    assert.match(
      block,
      /git clone --filter=blob:none --branch "\$target_branch" --single-branch "\$url" "\$checkout_dir"/,
    );
  }
});

test("target sweep runs count as background review capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const capacityBlock = workflow.slice(
    workflow.indexOf("active_sweep_background_workers()"),
    workflow.indexOf(
      'active_critical_workers="$',
      workflow.indexOf("active_sweep_background_workers()"),
    ),
  );

  assert.match(workflow, /Review hot target repo/);
  assert.match(capacityBlock, /startswith\("Review target repo "\)/);
  assert.match(capacityBlock, /startswith\("Review hot target repo "\)/);
  assert.match(capacityBlock, /Review\\ hot\\ target\\ repo/);
});

test("target hot sweep dispatches honor shard cap payload", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("\n      - id: select"),
  );

  assert.match(modeBlock, /elif \[ "\$hot_intake" = "true" \]; then/);
  assert.match(
    modeBlock,
    /shard_count="\$\{\{ github\.event\.client_payload\.shard_count \|\| '' \}\}"/,
  );
  assert.match(modeBlock, /shard_count="\$hot_intake_shards"/);
});

test("batch publication updates the durable comment once across replay", () => {
  type PublishStep = { name?: string; if?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: PublishStep[] }>;
  };
  const publishSteps = workflow.jobs.publish!.steps;
  const step = (name: string) => {
    const value = publishSteps.find((candidate) => candidate.name === name);
    assert.ok(value, name);
    return value;
  };
  const selected = step("Sync selected review comments");

  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const statePath = join(root, "comments.json");
    const logPath = join(root, "gh.log");
    const number = 125204;
    const reviewedAt = "2026-08-17T10:30:00.000Z";
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const review = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        repository: "openclaw/openclaw",
        number,
        title: "Hot intake publication regression",
        reviewed_at: reviewedAt,
        item_created_at: "2026-08-17T10:08:36.000Z",
        item_updated_at: reviewedAt,
        item_snapshot_hash: "reviewed-snapshot-125204",
        labels: JSON.stringify([]),
      }),
      number,
    );
    writeFileSync(
      join(itemsDir, `${number}.md`),
      review.report.replaceAll(
        `https://github.com/openclaw/clawsweeper/issues/${number}`,
        `https://github.com/openclaw/openclaw/issues/${number}`,
      ),
      "utf8",
    );
    writeFileSync(
      statePath,
      JSON.stringify([
        {
          id: 9000 + number,
          html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9000 + number}`,
          created_at: "2026-08-17T10:31:00.000Z",
          updated_at: "2026-08-17T10:31:00.000Z",
          user: { login: "clawsweeper[bot]" },
          body: review.comment.replace("queue_fix_pr", "stale_publication"),
        },
      ]),
      "utf8",
    );
    writeFileSync(logPath, "", "utf8");

    const ghMock = `
const { appendFileSync, readFileSync, writeFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const comments = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] === "api" && /\\/issues\\/${number}$/.test(path)) {
  console.log(JSON.stringify({
    number: ${number},
    title: "Hot intake publication regression",
    body: "A recently created issue needs a review.",
    html_url: "https://github.com/openclaw/openclaw/issues/${number}",
    created_at: "2026-08-17T10:08:36.000Z",
    updated_at: ${JSON.stringify(reviewedAt)},
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: comments.length,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    const body = JSON.parse(readFileSync(input, "utf8")).body;
    const comment = {
      id: 5315045852,
      html_url: "https://github.com/openclaw/openclaw/issues/${number}#issuecomment-5315045852",
      created_at: "2026-08-17T10:47:02.000Z",
      updated_at: "2026-08-17T10:47:02.000Z",
      user: { login: "clawsweeper[bot]" },
      body
    };
    writeFileSync(statePath, JSON.stringify([comment]), "utf8");
    console.log(JSON.stringify(comment));
  } else {
    console.log(JSON.stringify(args.includes("--slurp") ? [comments] : comments));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/${9000 + number}$/.test(path) && args.includes("PATCH")) {
  const input = args[args.indexOf("--input") + 1];
  const body = JSON.parse(readFileSync(input, "utf8")).body;
  const comment = { ...comments[0], body, updated_at: "2026-08-17T10:47:02.000Z" };
  writeFileSync(statePath, JSON.stringify([comment]), "utf8");
  console.log(JSON.stringify(comment));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/collaborators\\/reporter\\/permission$/.test(path)) {
  console.log(JSON.stringify({ permission: "read", role_name: "read" }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--sync-comments-only", "--item-numbers", String(number)],
        });
      }
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const publications = calls.filter(
      (args) => args[0] === "api" && (args.includes("POST") || args.includes("PATCH")),
    );
    assert.equal(
      publications.length,
      1,
      `selected sync publishes once across a replay: ${readFileSync(reportPath, "utf8")}`,
    );
    const [published] = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ body: string }>;
    assert.match(published?.body ?? "", /clawsweeper-review item=125204/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Selected publication keeps using the existing exact artifact set and
  // canonical mutation path, so the fix does not bypass its lease/fencing and
  // idempotent comment-update behavior or its immutable action ledger.
  assert.match(selected.run ?? "", /begin_canonical_record_mutation/);
  assert.match(selected.run ?? "", /artifact-item-numbers --artifact-dir artifacts/);
  assert.match(selected.run ?? "", /--item-numbers "\$item_numbers"/);
  assert.match(selected.run ?? "", /--sync-comments-only/);
  assert.match(
    step("Finalize selected review comment action ledger").if ?? "",
    /steps\.sync-selected-review-comments\.outcome != 'skipped'/,
  );
  assert.match(
    step("Publish selected review comment action ledger").run ?? "",
    /publish-action-events/,
  );
});

test("scheduled reviews feed the durable queue instead of one-item matrix workers", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("\n      - id: select"),
  );
  const enqueueBlock = workflow.slice(
    workflow.indexOf("- name: Enqueue scheduled review candidates"),
    workflow.indexOf("\n      - name: Prepare review runtime artifact"),
  );
  const selectBlock = workflow.slice(
    workflow.indexOf("- id: select"),
    workflow.indexOf("- name: Enqueue scheduled review candidates"),
  );

  assert.match(modeBlock, /queue_feed=.*clawsweeper_target_sweep/);
  assert.match(modeBlock, /requested_batch_size=.*client_payload\.batch_size/);
  assert.match(modeBlock, /requested_batch_size="\$queue_candidate_capacity"/);
  assert.match(modeBlock, /batch_size="\$requested_batch_size"[\s\S]*shard_count="1"/);
  assert.match(enqueueBlock, /repair:scheduled-review-enqueue/);
  assert.match(enqueueBlock, /gh api "repos\/\$target_repo" --jq '\.default_branch \/\/ empty'/);
  assert.match(enqueueBlock, /--target-branch "\$target_branch"/);
  assert.doesNotMatch(
    enqueueBlock,
    /--target-branch "\$\{\{ steps\.target\.outputs\.target_branch \}\}"/,
  );
  assert.match(
    selectBlock,
    /--coverage-tracked-items-manifest \.artifacts\/worker-records-manifest\.json/,
  );
  assert.match(enqueueBlock, /Scheduled review funnel/);
  assert.match(workflow, /Review scheduled hot item/);
  assert.match(workflow, /Review scheduled normal item/);
  assert.match(workflow, /needs\.plan\.outputs\.queue_feed != 'true'/);
});

test("fleet coverage publishes live open inventory to the dashboard worker", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const coverageStep = workflow.slice(
    workflow.indexOf("- name: Summarize trailing weekly review coverage"),
    workflow.indexOf("\n  plan:"),
  );
  assert.match(coverageStep, /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(coverageStep, /--publish-url "\$REVIEW_COVERAGE_URL"/);
});

test("target fanout uses the canonical cursor store without a git publisher", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const fanoutBlock = workflow.slice(
    workflow.indexOf("\n  target-fanout:"),
    workflow.indexOf("\n  plan:"),
  );

  assert.match(fanoutBlock, /hydrate-git-state: "false"/);
  assert.match(fanoutBlock, /--cursor-store-url "\$REVIEW_COVERAGE_URL"/);
  assert.match(
    fanoutBlock,
    /--coverage-tracked-items-manifest \.artifacts\/worker-records-manifest\.json/,
  );
  assert.doesNotMatch(fanoutBlock, /Create state token/);
  assert.doesNotMatch(fanoutBlock, /repair:publish-main/);
  assert.doesNotMatch(fanoutBlock, /results\/target-fanout-cursors/);
  assert.doesNotMatch(workflow, /Publish fanout cursor/);
});

test("hot fleet fanout runs every 20 minutes without changing other schedules", () => {
  const workflowText = readText(".github/workflows/sweep.yml");
  const workflow = YAML.parse(workflowText) as {
    on: { schedule: Array<{ cron: string }> };
  };
  const schedules = workflow.on.schedule.map(({ cron }) => cron);
  const fanoutBlock = workflowText.slice(
    workflowText.indexOf("\n  target-fanout:"),
    workflowText.indexOf("\n  plan:"),
  );

  assert.ok(schedules.includes("4/20 * * * *"));
  assert.ok(!schedules.includes("4/5 * * * *"));
  assert.ok(schedules.includes("*/5 * * * *"));
  assert.ok(schedules.includes("2/5 * * * *"));
  assert.ok(schedules.includes("41/10 * * * *"));
  assert.ok(schedules.includes("37 */6 * * *"));
  assert.match(fanoutBlock, /github\.event\.schedule == '4\/20 \* \* \* \*'/);
  assert.match(
    fanoutBlock,
    /FANOUT_MODE: \$\{\{ github\.event\.schedule == '41\/10 \* \* \* \*' && 'normal-review' \|\| \(github\.event\.schedule == '37 \*\/6 \* \* \*' && 'audit' \|\| 'hot-intake'\) \}\}/,
  );
  assert.match(
    fanoutBlock,
    /FANOUT_LIMIT: \$\{\{ github\.event\.schedule == '41\/10 \* \* \* \*' && '12' \|\| \(github\.event\.schedule == '37 \*\/6 \* \* \*' && '12' \|\| '20'\) \}\}/,
  );
});

test("review git info follows checked-out target branch", () => {
  const source = readText("src/clawsweeper-review-runtime.ts");

  assert.match(source, /function reviewTargetBranch/);
  assert.match(source, /rev-parse", "--abbrev-ref", "HEAD"/);
  assert.match(source, /refs\/remotes\/origin\/\$\{targetBranch\}/);
});

test("sweep workflow_dispatch input count stays under GitHub limit", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const inputNames = [...inputBlock.matchAll(/^      [A-Za-z0-9_]+:/gm)];

  assert.ok(inputNames.length <= 25, `workflow_dispatch has ${inputNames.length} inputs`);
});

test("manual review docs name only declared sweep inputs", () => {
  const readme = readText("README.md");
  const scheduler = readText("docs/scheduler.md");
  const guidanceSections = [
    readme.slice(
      readme.indexOf("- Manual runs can pass"),
      readme.indexOf("- Each shard checks out"),
    ),
    scheduler.slice(
      scheduler.indexOf("can override `target_repo`"),
      scheduler.indexOf("Exact item dispatches use"),
    ),
  ];
  const requiredInputs = ["item_number", "item_numbers", "shard_count", "batch_size"];
  const schedulerInputs = ["target_repo", "hot_intake"];
  const workflow = readText(".github/workflows/sweep.yml");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const declaredInputs = new Set(
    [...inputBlock.matchAll(/^      ([A-Za-z0-9_]+):/gm)].map((match) => match[1]),
  );

  for (const guidance of guidanceSections) {
    assert.doesNotMatch(guidance, /`item_count`/);
    for (const input of requiredInputs) {
      assert.match(guidance, new RegExp(`\`${input}\``));
    }
    for (const [, documentedInput] of guidance.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
      assert.equal(
        declaredInputs.has(documentedInput),
        true,
        `${documentedInput} must remain a declared workflow input`,
      );
    }
  }
  for (const input of schedulerInputs) {
    assert.match(guidanceSections[1] ?? "", new RegExp(`\`${input}\``));
  }
});

test("sweep review continuations stay workflow-dispatch compatible", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const continueBlock = workflow.slice(
    workflow.indexOf("- name: Continue sweep"),
    workflow.indexOf("\n\n  recover-review-failures:"),
  );

  assert.match(continueBlock, /-f target_repo="\$\{\{ needs\.plan\.outputs\.target_repo \}\}"/);
  assert.match(continueBlock, /-f target_branch="\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/);
});

test("failed review recovery waits for durable exact-review queue acknowledgement", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publisher = readText("src/repair/publish-event-result.ts");
  const recoveryBlock = workflow.slice(
    workflow.indexOf("\n  recover-review-failures:"),
    workflow.indexOf("\n\n  retry-failed-reviews:"),
  );

  assert.match(recoveryBlock, /--arg target_repo "\$\{\{ needs\.plan\.outputs\.target_repo \}\}"/);
  assert.match(
    recoveryBlock,
    /--arg target_branch "\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/,
  );
  assert.match(recoveryBlock, /sourceAction: "failed_review_shard_recovery"/);
  assert.match(recoveryBlock, /delivery_id: \("router:" \+ \$dispatch_key\)/);
  assert.match(recoveryBlock, /\/internal\/exact-review\/enqueue/);
  assert.match(
    publisher,
    /options\.reviewOnly \? \["--sync-comments-only", "--suppress-automation-markers"\] : \[\]/,
  );
  assert.match(
    recoveryBlock,
    /\.ok == true and \(\.queued == true or \.deduped == true or \.shed == true or \.accepted == false\)/,
  );
  assert.match(recoveryBlock, /Recovery shed by exact-review queue backpressure/);
  assert.doesNotMatch(recoveryBlock, /workflow run sweep\.yml/);
  assert.doesNotMatch(recoveryBlock, /repos\/\$GITHUB_REPOSITORY\/dispatches/);
  assert.match(recoveryBlock, /for attempt in 1 2 3/);
});

test("target sweep dispatches preserve disabled ClawHub guard", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    runs-on:", workflow.indexOf("\n  plan:")),
  );

  assert.match(planHeader, /github\.event\.action == 'clawsweeper_target_sweep'/);
  assert.match(
    planHeader,
    /github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.target_repo == 'openclaw\/clawhub' && vars\.CLAWSWEEPER_ENABLE_CLAWHUB != '1'/,
  );
});

test("sweep planning-started status publish is bounded", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Publish planning-started status"),
    workflow.indexOf("- id: mode"),
  );

  assert.match(block, /timeout 20s pnpm run repair:publish-main/);
  assert.match(block, /Skipped slow planning-started dashboard publish/);
});

test("review capacity probes use REST actions run listing", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const sweepBlock = sweepWorkflow.slice(
    sweepWorkflow.indexOf("- id: mode"),
    sweepWorkflow.indexOf("- id: select"),
  );
  for (const block of [sweepBlock]) {
    assert.match(block, /active_runs_json\(\)/);
    assert.match(block, /actions\/runs\?per_page=100/);
    assert.match(block, /--paginate/);
    assert.match(block, /status=\$\{run_status\}/);
    assert.match(block, /workflowPath:\.path/);
    assert.doesNotMatch(block, /workflowName:\.name/);
    assert.match(block, /displayTitle:\.display_title/);
    assert.match(block, /createdAt:\.created_at/);
    assert.match(block, /updatedAt:\.updated_at/);
    assert.match(block, /STALE_QUEUED_CUTOFF/);
    assert.doesNotMatch(block, /gh run list/);
    assert.match(block, /gh run view/);
  }
});

test("background review capacity reserves expanding matrices and caps broad manual input", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );
  assert.match(modeBlock, /limit review_shards\.hot_intake_default/);
  assert.match(modeBlock, /limit review_shards\.normal_default/);
  assert.match(modeBlock, /STALE_QUEUED_CUTOFF/);
  assert.match(modeBlock, /updatedAt:\.updated_at/);
  assert.match(modeBlock, /workflowPath == "\.github\/workflows\/sweep\.yml"/);
  assert.match(modeBlock, /WORKFLOW_PATH="\$1"/);
  assert.doesNotMatch(modeBlock, /workflowName == "ClawSweeper"/);
  assert.doesNotMatch(modeBlock, /WORKFLOW_NAME="\$1"/);
  assert.match(modeBlock, /total_shards/);
  assert.match(modeBlock, /completed shard jobs are publishing and consume no/);
  assert.match(modeBlock, /\[ "\$active_shards" -lt 1 \] && \[ "\$total_shards" -lt 1 \]/);
  assert.match(modeBlock, /lane_shard_cap="\$normal_shards"/);
  assert.match(modeBlock, /lane_shard_cap="\$hot_intake_shards"/);
  assert.match(modeBlock, /Capping broad background review shards/);
});

test("background planners fetch exact-review queue pressure once and pass its level", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const sweepBlock = sweepWorkflow.slice(
    sweepWorkflow.indexOf("- id: mode"),
    sweepWorkflow.indexOf("- id: select"),
  );
  for (const block of [sweepBlock]) {
    assert.match(
      block,
      /QUEUE_URL: \$\{\{ vars\.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL \|\| 'https:\/\/clawsweeper\.openclaw\.ai' \}\}/,
    );
    assert.equal(block.match(/queue-pressure --queue-url/g)?.length, 1);
    assert.match(block, /--pressure-level "\$pressure_level"/);
    assert.match(block, /queue pressure: \$pressure_level/);
    assert.match(block, /if ! pressure_json=/);
    assert.match(block, /"level":"unknown"/);
    assert.match(block, /select\(. == "none" or . == "soft" or . == "hard" or . == "unknown"\)/);
    assert.doesNotMatch(block, /"level":"none"/);
    assert.match(block, /CLAWSWEEPER_QUEUE_PRESSURE_SOFT_PENDING/);
    assert.match(block, /CLAWSWEEPER_QUEUE_PRESSURE_HARD_AGE_MS/);
  }
  assert.match(sweepBlock, /if \[ -z "\$exact_item" \]; then/);
  assert.ok(
    sweepBlock.indexOf('if [ -z "$exact_item" ]; then') <
      sweepBlock.indexOf("queue-pressure --queue-url"),
    "only background planning may probe and apply queue-pressure admission",
  );
  assert.match(sweepBlock, /hot_intake \$hot_intake_unpressured->\$hot_intake_shards/);
  assert.match(sweepBlock, /normal_review \$normal_unpressured->\$normal_shards/);
});

test("review backstops identify sweep runs by stable workflow path", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(workflow.indexOf("- name: Queue review backstops"));

  assert.match(block, /actions\/runs\?per_page=100/);
  assert.match(block, /workflowPath:\.path/);
  assert.match(block, /run\.workflowPath !== "\.github\/workflows\/sweep\.yml"/);
  assert.doesNotMatch(block, /gh run list/);
  assert.doesNotMatch(block, /run\.workflowName/);
});

test("target review queues coalesce background work without delaying exact planners", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const concurrencyBlock = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:"),
  );
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    outputs:", workflow.indexOf("\n  plan:")),
  );

  assert.match(concurrencyBlock, /&& 'clawsweeper-intake-v2'/);
  assert.match(concurrencyBlock, /\|\| 'clawsweeper-review'/);
  assert.doesNotMatch(
    concurrencyBlock,
    /format\('clawsweeper-(?:intake-v2|review)-\{0\}', github\.run_id\)/,
  );
  assert.match(
    concurrencyBlock,
    /github\.event\.client_payload\.queue_lease_id \|\| github\.event\.client_payload\.item_number/,
  );
  assert.match(concurrencyBlock, /format\('clawsweeper-comment-sync-\{0\}', github\.run_id\)/);
  assert.match(concurrencyBlock, /apply_item_numbers == '__cursor__'/);
  assert.match(concurrencyBlock, /apply_kind == 'all'/);
  assert.match(concurrencyBlock, /apply_comment_sync_min_age_days == '0'/);
  assert.match(concurrencyBlock, /apply_limit == '40'/);
  assert.match(concurrencyBlock, /apply_min_age_days == '0'/);
  assert.match(concurrencyBlock, /apply_min_age_minutes == ''/);
  assert.match(concurrencyBlock, /format\('clawsweeper-apply-\{0\}', github\.run_id\)/);
  assert.match(
    concurrencyBlock,
    /github\.event_name == 'workflow_dispatch'.*format\('clawsweeper-operator-dispatch-\{0\}', github\.run_id\)/,
  );
  assert.doesNotMatch(concurrencyBlock, /queue: max/);
  assert.match(planHeader, /group: \$\{\{ format\('clawsweeper-planner-\{0\}'/);
  assert.match(
    planHeader,
    /github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(planHeader, /github\.event\.inputs\.item_number == ''/);
  assert.match(planHeader, /github\.event\.inputs\.item_numbers == ''/);
  assert.match(planHeader, /\|\| github\.run_id/);
  assert.doesNotMatch(planHeader, /queue: max/);
  assert.match(planHeader, /cancel-in-progress: false/);
});

test("durable cursor sync coalesces safely without discarding targeted batches", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    concurrency: { group: string };
    jobs: Record<string, { concurrency: { group: string; "cancel-in-progress": boolean } }>;
  };
  const applyJob = workflow.jobs["apply-existing"]!;
  const expression = workflow.concurrency.group.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const format = (template: string, ...values: string[]) =>
    template.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? "");
  const evaluateExpression = new Function(
    "github",
    "format",
    "vars",
    `return (${expression});`,
  ) as (
    github: Record<string, unknown>,
    formatter: typeof format,
    variables: Record<string, string>,
  ) => string;
  const evaluate = (
    github: Record<string, unknown>,
    formatter: typeof format,
    variables: Record<string, string> = { CLAWSWEEPER_AUTO_CLOSE_REASONS: "all" },
  ) => evaluateExpression(github, formatter, variables);
  const event = (
    runId: number,
    itemNumbers: string,
    scheduled = false,
    kind = "all",
    minimumAge = "0",
    applyLimit = "40",
    minimumItemAge = "0",
    minimumItemAgeMinutes = "",
    closeReasons = "",
    staleMinimumAge = "60",
    closeDelay = "2000",
    checkpointSize = "40",
  ) => ({
    event_name: scheduled ? "schedule" : "workflow_dispatch",
    run_id: runId,
    event: {
      schedule: scheduled ? "6,21,36,51 * * * *" : "",
      inputs: {
        target_repo: "openclaw/openclaw",
        apply_existing: scheduled ? "" : "true",
        apply_sync_comments_only: scheduled ? "" : "true",
        apply_item_numbers: itemNumbers,
        apply_kind: kind,
        apply_comment_sync_min_age_days: minimumAge,
        apply_limit: applyLimit,
        apply_min_age_days: minimumItemAge,
        apply_min_age_minutes: minimumItemAgeMinutes,
        apply_close_reasons: closeReasons,
        apply_stale_min_age_days: staleMinimumAge,
        apply_close_delay_ms: closeDelay,
        apply_checkpoint_size: checkpointSize,
        item_number: "",
        item_numbers: "",
        hot_intake: "",
        audit_dashboard: "",
      },
      client_payload: { target_repo: "", queue_lease_id: "", item_number: "" },
    },
  });

  assert.equal(
    evaluate(event(1, "__cursor__"), format),
    evaluate(event(2, "__cursor__"), format),
    "durable background cursors must coalesce",
  );
  assert.equal(
    evaluate(event(1, "__cursor__"), format),
    evaluate(event(3, "", true), format),
    "scheduled maintenance must share the durable background cursor",
  );
  for (const targetRepo of ["openclaw/openclaw", "openclaw/clawhub"]) {
    const initial = event(22, "__cursor__");
    const continuation = event(23, "__cursor__", false, "all", "0", "40", "0", "", "all");
    initial.event.inputs.target_repo = targetRepo;
    continuation.event.inputs.target_repo = targetRepo;
    assert.equal(
      evaluate(initial, format),
      evaluate(continuation, format),
      `automatic ${targetRepo} continuations must normalize the default close policy`,
    );
  }
  const customDefault = { CLAWSWEEPER_AUTO_CLOSE_REASONS: "duplicate_or_superseded" };
  assert.equal(
    evaluate(event(24, "__cursor__"), format, customDefault),
    evaluate(
      event(25, "__cursor__", false, "all", "0", "40", "0", "", "duplicate_or_superseded"),
      format,
      customDefault,
    ),
    "configured default close reasons must share their continuation group",
  );
  assert.notEqual(
    evaluate(event(26, "__cursor__"), format, customDefault),
    evaluate(
      event(27, "__cursor__", false, "all", "0", "40", "0", "", "all"),
      format,
      customDefault,
    ),
    "explicit all must remain independent when the configured default is narrower",
  );
  assert.notEqual(
    evaluate(event(4, "101,102"), format),
    evaluate(event(5, "103"), format),
    "explicit issue and PR batches must never cancel each other",
  );
  assert.notEqual(
    evaluate(event(6, "", false, "issue", "9"), format),
    evaluate(event(7, "", false, "pull_request", "0"), format),
    "custom manual selections must never cancel each other",
  );
  assert.notEqual(
    evaluate(event(8, "__cursor__", false, "all", "0", "1"), format),
    evaluate(event(9, "__cursor__"), format),
    "an operator-selected batch limit must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(10, "__cursor__", false, "all", "0", "40", "30"), format),
    evaluate(event(11, "__cursor__"), format),
    "an operator-selected item age must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(12, "__cursor__", false, "all", "0", "40", "0", "30"), format),
    evaluate(event(13, "__cursor__"), format),
    "an operator-selected minute-level item age must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(
      event(14, "__cursor__", false, "all", "0", "40", "0", "", "duplicate_or_superseded"),
      format,
    ),
    evaluate(event(15, "__cursor__"), format),
    "an operator-selected close reason must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(16, "__cursor__", false, "all", "0", "40", "0", "", "", "1"), format),
    evaluate(event(17, "__cursor__"), format),
    "an operator-selected stale-item age must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(18, "__cursor__", false, "all", "0", "40", "0", "", "", "60", "0"), format),
    evaluate(event(19, "__cursor__"), format),
    "an operator-selected close delay must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(
      event(20, "__cursor__", false, "all", "0", "40", "0", "", "", "60", "2000", "5"),
      format,
    ),
    evaluate(event(21, "__cursor__"), format),
    "an operator-selected checkpoint size must not share the automatic cursor group",
  );
  assert.match(applyJob.concurrency.group, /^clawsweeper-target-apply-/);
  assert.equal(applyJob.concurrency["cancel-in-progress"], false);
});

test("scheduled normal review sizes one planner shard to live candidate capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );

  assert.match(modeBlock, /if \[ "\$queue_feed" = "true" \] && \[ -z "\$exact_item" \]; then/);
  assert.match(modeBlock, /availableCandidateCapacity/);
  assert.match(modeBlock, /requested_batch_size=.*client_payload\.batch_size/);
  assert.match(modeBlock, /if \[ "\$requested_batch_size" -gt "\$queue_candidate_capacity" \]/);
  assert.match(modeBlock, /batch_size="\$requested_batch_size"[\s\S]*shard_count="1"/);
  assert.match(modeBlock, /min_active_shards="0"/);
});

test("planned background reviews allow safe content-cache reuse without weakening exact reviews", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewJobStart = workflow.indexOf("\n  event-review-apply:");
  const planJobStart = workflow.indexOf("\n  plan:", eventReviewJobStart);
  const eventReviewJob = workflow.slice(eventReviewJobStart, planJobStart);
  const reviewJobStart = workflow.indexOf("\n  review:");
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);

  assert.match(
    reviewJob,
    /EXACT_ITEM: \$\{\{ github\.event\.client_payload\.item_number \|\| github\.event\.inputs\.item_number \|\| github\.event\.inputs\.item_numbers \|\| '' \}\}/,
  );
  assert.match(reviewJob, /if \[ -z "\$EXACT_ITEM" \]; then/);
  assert.match(reviewJob, /planned_automatic_review_arg=\(--planned-automatic-review\)/);
  assert.match(
    reviewJob,
    /PR_COMMENT_ACTIVITY_REVISIONS: \$\{\{ matrix\.pr_comment_activity_revisions \}\}/,
  );
  assert.match(
    reviewJob,
    /pr_comment_activity_arg=\(--pr-comment-activity-revisions "\$PR_COMMENT_ACTIVITY_REVISIONS"\)/,
  );
  assert.match(
    reviewJob,
    /--item-numbers "\$\{\{ matrix\.item_numbers \}\}" \\\n+\s+"\$\{pr_comment_activity_arg\[@\]\}" \\\n+\s+"\$\{planned_automatic_review_arg\[@\]\}"/,
  );
  assert.match(
    eventReviewJob,
    /SOURCE_ACTION: \$\{\{ fromJSON\(steps\.claim-exact-review-queue\.outputs\.decision\)\.sourceAction \|\| '' \}\}/,
  );
  assert.match(eventReviewJob, /--review-source-action "\$SOURCE_ACTION"/);
  assert.doesNotMatch(eventReviewJob, /--planned-automatic-review/);
});

test("legacy event field serializer preserves branchless issue and PR intake", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const run = workflow.jobs["legacy-event-queue-intake"]?.steps.find(
    (step) => step.name === "Enqueue legacy event through the durable control plane",
  )?.run;
  assert.ok(run);
  const scripts = [...run.matchAll(/node <<'NODE'\n([\s\S]*?)\nNODE\n/g)].map((match) => match[1]);
  const script = scripts[0];
  assert.ok(script);
  assert.equal(scripts.length, 2);

  const serialize = (payload: Record<string, unknown>): string[] => {
    const output = execFileSync(process.execPath, ["-"], {
      encoding: "utf8",
      env: { ...process.env, CLIENT_PAYLOAD: JSON.stringify(payload) },
      input: script,
    });
    const fields = output.split("\0");
    assert.equal(fields.pop(), "");
    return fields;
  };

  assert.deepEqual(
    serialize({
      item_kind: "issue",
      target_repo: "openclaw/openclaw",
      source_event: "issues",
      source_action: "opened",
    }),
    ["openclaw/openclaw", "", "0"],
  );
  assert.deepEqual(
    serialize({
      item_kind: "pull_request",
      target_repo: "openclaw/clawhub",
      item_number: 3273,
      source_event: "pull_request_target",
      source_action: "opened",
      supersedes_in_progress: false,
    }),
    ["openclaw/clawhub", "", "0"],
  );
  assert.deepEqual(
    serialize({
      item_kind: "pull_request",
      target_repo: "openclaw/clawhub",
      source_event: "pull_request",
      source_action: "edited",
      queue_claim: {
        installation_id: 1,
        source_head_sha: "a".repeat(40),
        source_base_sha: "b".repeat(40),
        source_is_draft: false,
        source_content_revision: "c".repeat(64),
      },
    }),
    ["openclaw/clawhub", "", "1"],
  );
  assert.deepEqual(
    serialize({
      item_kind: "pull_request",
      target_repo: "openclaw/clawhub",
      target_branch: "main",
      source_event: "issue_comment",
      source_action: "created",
    }),
    ["openclaw/clawhub", "main", "0"],
  );

  const reviewDecision = JSON.parse(
    execFileSync(process.execPath, ["-"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLIENT_PAYLOAD: JSON.stringify({
          target_repo: "openclaw/openclaw",
          item_number: 117838,
          item_kind: "pull_request",
          source_delivery_id: "original-review-delivery",
          review_options: {
            codex_timeout_ms: 1_200_000,
            media_proof_timeout_ms: 480_000,
          },
        }),
        TARGET_REPO: "openclaw/openclaw",
        TARGET_BRANCH: "main",
      },
      input: scripts[1],
    }),
  );
  assert.equal(reviewDecision.decision.codexTimeoutMs, 1_200_000);
  assert.equal(reviewDecision.decision.mediaProofTimeoutMs, 480_000);
  assert.equal(reviewDecision.decision.sourceDeliveryId, "original-review-delivery");

  const branchlessDecision = JSON.parse(
    execFileSync(process.execPath, ["-"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLIENT_PAYLOAD: JSON.stringify({
          target_repo: "openclaw/openclaw",
          item_number: 117839,
          item_kind: "issue",
          installation_id: 123,
        }),
        TARGET_REPO: "openclaw/openclaw",
        TARGET_BRANCH: "",
        USE_SOURCE_AUTHORITY: "0",
      },
      input: scripts[1],
    }),
  );
  assert.equal(Object.hasOwn(branchlessDecision.decision, "targetBranch"), false);
  assert.equal(branchlessDecision.installation_id, 123);
  assert.equal(Object.hasOwn(branchlessDecision, "source_authority_required"), false);
});

test("sweep issue and PR event reviews and target fanout avoid storm amplification", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const legacyIntakeBlock = workflow.slice(
    workflow.indexOf("legacy-event-queue-intake:"),
    workflow.indexOf("event-review-apply:"),
  );
  const eventBlock = workflow.slice(
    workflow.indexOf("event-review-apply:"),
    workflow.indexOf("target-fanout:"),
  );
  const fanoutBlock = workflow.slice(
    workflow.indexOf("\n  target-fanout:"),
    workflow.indexOf("\n  plan:"),
  );

  assert.match(eventBlock, /concurrency:/);
  assert.match(
    eventBlock,
    /group: clawsweeper-event-review-\$\{\{ github\.event\.client_payload\.queue_claim\.item_key \|\| github\.event\.client_payload\.item_key \|\| github\.run_id \}\}/,
  );
  assert.match(eventBlock, /queue_lease_id != ''/);
  assert.match(eventBlock, /item_key: process\.env\.ITEM_KEY/);
  assert.match(eventBlock, /lease_revision: leaseRevision/);
  assert.match(eventBlock, /claim_generation: claimGeneration/);
  assert.match(eventBlock, /decision=\$\{JSON\.stringify\(decision\)\}/);
  assert.match(eventBlock, /cancel-in-progress: false/);
  assert.match(legacyIntakeBlock, /legacy-event-queue-intake:/);
  assert.match(legacyIntakeBlock, /\/internal\/exact-review\/enqueue/);
  assert.match(legacyIntakeBlock, /\/internal\/exact-review\/source-authority/);
  assert.match(legacyIntakeBlock, /\/internal\/exact-review\/branch-authority/);
  assert.doesNotMatch(legacyIntakeBlock, /gh api "repos\/\$target_repo" --jq \.default_branch/);
  assert.match(legacyIntakeBlock, /targetBranch \? \{ targetBranch \} : \{\}/);
  assert.doesNotMatch(legacyIntakeBlock, /targetBranch: payload\.target_branch \|\| "main"/);
  assert.match(legacyIntakeBlock, /mapfile -d '' -t legacy_intake_fields/);
  assert.match(legacyIntakeBlock, /\.trim\(\)\}\\0\$\{String\(payload\.target_branch/);
  assert.match(legacyIntakeBlock, /target_branch="\$\{legacy_intake_fields\[1\]\}"/);
  assert.doesNotMatch(
    legacyIntakeBlock,
    /IFS=\$'\\t' read -r target_repo target_branch use_source_authority/,
  );
  assert.match(legacyIntakeBlock, /sourceBaseSha/);
  assert.match(legacyIntakeBlock, /sourceIsDraft/);
  assert.match(legacyIntakeBlock, /sourceContentRevision/);
  assert.match(legacyIntakeBlock, /sourceUpdatedAt/);
  assert.match(legacyIntakeBlock, /queueClaim\.installation_id \?\? payload\.installation_id/);
  assert.match(legacyIntakeBlock, /payload\.source_action === "edited"/);
  assert.match(legacyIntakeBlock, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(legacyIntakeBlock, /typeof sourceIsDraft === "boolean"/);
  assert.match(legacyIntakeBlock, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(legacyIntakeBlock, /commandStatusMarker: payload\.command_status_marker/);
  assert.match(legacyIntakeBlock, /statusCommentId: payload\.status_comment_id/);
  assert.match(legacyIntakeBlock, /additionalPrompt: payload\.additional_prompt/);
  assert.match(
    fanoutBlock,
    /FANOUT_LIMIT: \$\{\{ github\.event\.schedule == '41\/10 \* \* \* \*' && '12' \|\| \(github\.event\.schedule == '37 \*\/6 \* \* \*' && '12' \|\| '20'\) \}\}/,
  );
  assert.match(fanoutBlock, /Summarize trailing weekly review coverage/);
  assert.match(fanoutBlock, /--cursor-store-url "\$REVIEW_COVERAGE_URL"/);
  assert.match(fanoutBlock, /--publish-url "\$REVIEW_COVERAGE_URL"/);
  assert.match(fanoutBlock, /target-fanout -- coverage --window-days 7/);
  assert.match(fanoutBlock, /GITHUB_STEP_SUMMARY/);
});

test("batch publication accepts empty artifacts and isolates comment credentials", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const steps = workflow.jobs.publish.steps;
  const find = (id: string) => steps.find((step: { id?: string }) => step.id === id);
  const resolveItems = find("reviewed-items");
  assert.equal(find("target-write-token")["continue-on-error"], true);
  assert.equal(
    find("setup-publish-state").if,
    "${{ steps.reviewed-items.outputs.item_numbers != '' }}",
  );
  assert.doesNotMatch(find("commit-review-records").if, /target-write-token/);
  assert.match(find("sync-selected-review-comments").if, /target-write-token.outputs.token != ''/);
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifacts = join(root, "artifacts");
    const output = join(root, "output");
    mkdirSync(artifacts);
    writeFileSync(join(artifacts, "metrics.json"), "{}");
    const run = resolveItems.run.replace(
      "--artifact-dir artifacts",
      '--artifact-dir "$TEST_ARTIFACT_DIR"',
    );
    execFileSync("bash", ["-e", "-c", run], {
      env: { ...process.env, TEST_ARTIFACT_DIR: artifacts, GITHUB_OUTPUT: output },
    });
    assert.equal(readFileSync(output, "utf8").trim(), "item_numbers=");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch publication reconciles only reviewed tuples before canonical writes", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const publish = workflow.jobs.publish.steps.find(
    (step: { id?: string }) => step.id === "commit-review-records",
  );
  assert.equal(publish.env.ITEM_NUMBERS, "${{ steps.reviewed-items.outputs.item_numbers }}");
  assert.match(publish.run, /--item-numbers "\$ITEM_NUMBERS"/);
  assert.match(publish.run, /--only-item-numbers/);
  assert.ok(
    publish.run.indexOf("pnpm run reconcile") < publish.run.indexOf("pnpm run repair:publish-main"),
  );
});

test("explicit-item planning hydrates exactly the items selected for review", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const steps = workflow.jobs.plan.steps;
  const setup = steps.findIndex((step: { uses?: string }) => step.uses?.endsWith("/setup-pnpm"));
  const parser = steps.findIndex((step: { id?: string }) => step.id === "requested-items");
  const hydration = steps.findIndex((step: { uses?: string }) =>
    step.uses?.endsWith("/setup-state"),
  );
  assert.ok(setup >= 0 && setup < parser && parser < hydration);
  assert.equal(
    YAML.parse(readText(".github/actions/setup-pnpm/action.yml")).inputs["node-version"].default,
    "24",
  );
  const requested = steps.find((step: { id?: string }) => step.id === "requested-items");
  const hydrate = steps.find((step: { uses?: string }) => step.uses?.endsWith("/setup-state"));
  const select = steps.find((step: { id?: string }) => step.id === "select");
  assert.equal(
    hydrate.with["records-item-number"],
    "${{ steps.requested-items.outputs.item_numbers }}",
  );
  assert.equal(select.env.ITEM_NUMBERS, hydrate.with["records-item-number"]);
  const root = mkdtempSync(tmpPrefix);
  try {
    for (const [single, multiple, expected] of [
      ["", "", ""],
      ["133034", "", "133034"],
      ["", "133035,133034,133035", "133034,133035"],
      ["133034", "133035", "133034,133035"],
      ["133034", "router-receipt-123", "133034"],
    ]) {
      const output = join(root, "output");
      writeFileSync(output, "");
      execFileSync("bash", ["-e", "-c", requested.run], {
        env: { ...process.env, ITEM_NUMBER: single, ITEM_NUMBERS: multiple, GITHUB_OUTPUT: output },
      });
      assert.equal(readFileSync(output, "utf8").trim(), `item_numbers=${expected}`);
    }
    const invalid = spawnSync("bash", ["-e", "-c", requested.run], {
      env: {
        ...process.env,
        ITEM_NUMBER: "",
        ITEM_NUMBERS: "none",
        GITHUB_OUTPUT: join(root, "invalid"),
      },
      encoding: "utf8",
    });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /no valid item numbers/);
    assert.equal(existsSync(join(root, "invalid")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup-state defaults to an auth-safe shallow checkout", () => {
  const action = readText(".github/actions/setup-state/action.yml");
  assert.doesNotMatch(action, /CLAWSWEEPER_STATE_REPOSITORY=/);
  assert.doesNotMatch(action, /CLAWSWEEPER_STATE_TOKEN/);
  const filterBlock = action.slice(action.indexOf("filter:"), action.indexOf("fetch-depth:"));
  const fetchDepthBlock = action.slice(action.indexOf("fetch-depth:"), action.indexOf("runs:"));

  assert.match(filterBlock, /default: blob:none/);
  assert.match(action, /filter: \$\{\{ inputs\.filter \}\}/);
  assert.match(fetchDepthBlock, /default: "1"/);
  assert.doesNotMatch(fetchDepthBlock, /default: "0"/);
  assert.match(action, /fetch-depth: \$\{\{ inputs\.fetch-depth \}\}/);
  assert.match(action, /sparse-checkout: \$\{\{ inputs\.sparse-checkout \}\}/);
  assert.doesNotMatch(action, /state-repository:/);
  assert.doesNotMatch(action, /state-ref:/);
  assert.match(action, /repository: openclaw\/clawsweeper-state/);
  assert.match(action, /ref: state/);
});

test("sweep exact event reviews consume only the immutable claimed decision", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const resolveBlock = workflow.slice(
    workflow.indexOf("- name: Resolve event payload"),
    workflow.indexOf("- name: Create target read token"),
  );
  const reviewBlock = workflow.slice(
    workflow.indexOf("- name: Review exact event item"),
    workflow.indexOf("- name: Create state token"),
  );

  assert.match(
    resolveBlock,
    /CLAIM_DECISION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.decision \}\}/,
  );
  assert.match(
    resolveBlock,
    /CONFIGURED_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_CODEX_TIMEOUT_MS \|\| '1200000' \}\}/,
  );
  assert.match(resolveBlock, /const decision = JSON\.parse\(process\.env\.CLAIM_DECISION/);
  assert.match(resolveBlock, /const maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(resolveBlock, /Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)/);
  assert.match(resolveBlock, /Math\.min\(1_800_000, Math\.max\(600_000, adaptiveValue\)\)/);
  assert.match(resolveBlock, /Math\.min\(480_000, mediaValue\)/);
  assert.match(
    resolveBlock,
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs,\s*Math\.max\(configuredTimeout, adaptiveTimeout\)/,
  );
  assert.match(resolveBlock, /media_proof_timeout_ms: mediaTimeout/);
  assert.doesNotMatch(resolveBlock, /github\.event\.client_payload/);
  assert.match(
    reviewBlock,
    /codex_timeout_ms="\$\{\{ steps\.target\.outputs\.codex_timeout_ms \}\}"/,
  );
  assert.match(reviewBlock, /media_preprocessing_reserve_seconds=480/);
  assert.match(
    reviewBlock,
    /review_timeout_seconds=\$\(\(codex_timeout_seconds \+ media_preprocessing_reserve_seconds \+ 180\)\)/,
  );
  assert.match(reviewBlock, /detected media allowance \$\{media_proof_timeout_seconds\}s/);
  assert.doesNotMatch(reviewBlock, /review_timeout_seconds=.*media_proof_timeout_seconds/);
  assert.match(reviewBlock, /timeout --kill-after=30s "\$\{review_timeout_seconds\}s"/);
  assert.match(reviewBlock, /echo "exit_code=\$review_exit_code" >> "\$GITHUB_OUTPUT"/);
  assert.match(reviewBlock, /--codex-timeout-ms "\$codex_timeout_ms"/);
  assert.doesNotMatch(reviewBlock, /timeout --kill-after=30s 12m/);
  assert.doesNotMatch(reviewBlock, /--codex-timeout-ms 600000/);
});

test("review finalizers recover start-only ledger attempts after hard timeout", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  for (const finalizerName of [
    "Finalize exact event action ledger",
    "Finalize review action ledger",
  ]) {
    const start = workflow.indexOf(`- name: ${finalizerName}`);
    assert.ok(start >= 0, `missing ${finalizerName}`);
    const block = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));
    assert.match(block, /REVIEW_EXIT_CODE:/);
    assert.match(block, /"124"/);
    assert.match(block, /"137"/);
    assert.match(block, /--interrupt-open-attempts --reason timeout/);
    assert.match(block, /--interrupt-open-attempts --reason cancelled/);
    assert.match(block, /--interrupt-open-attempts --reason workflow_failed/);
    assert.ok(
      block.indexOf("--reason cancelled") < block.indexOf("--reason timeout"),
      "explicit cancellation must outrank timeout-like signal exits",
    );
  }
});

test("every action-ledger publication authenticates the expected producer job", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps?: Array<{ run?: string }> }>;
  };
  const invocation = "publish-action-events";
  const commandStart = `pnpm run --silent ${invocation} -- \\`;
  const isCanonicalValue = (value: string): boolean => {
    const quote = value[0] === "'" || value[0] === '"' ? value[0] : null;
    if (quote && (value.length < 3 || value.at(-1) !== quote)) return false;
    const word = quote ? value.slice(1, -1) : value;
    return (
      word.length > 0 &&
      word
        .split("")
        .every(
          (character) =>
            (character >= "a" && character <= "z") ||
            (character >= "A" && character <= "Z") ||
            (character >= "0" && character <= "9") ||
            character === "." ||
            character === "/" ||
            character === "_" ||
            character === "-" ||
            (quote !== null && (character === "$" || character === "{" || character === "}")),
        )
    );
  };
  const countOccurrences = (line: string): number => {
    let count = 0;
    let offset = 0;
    while (true) {
      const index = line.indexOf(invocation, offset);
      if (index === -1) return count;
      count += 1;
      offset = index + invocation.length;
    }
  };
  const commandsFromScript = (script: string): Array<Map<string, string>> => {
    const lines = script.split("\n");
    const commands: Array<Map<string, string>> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const occurrences = countOccurrences(line);
      if (occurrences === 0) continue;
      assert.equal(occurrences, 1, "publisher lines must contain one invocation");
      assert.equal(
        line.trimStart(),
        commandStart,
        "publisher invocations must use the standalone canonical command form",
      );

      const args = new Map<string, string>();
      let continued = true;
      while (continued) {
        index += 1;
        assert.ok(index < lines.length, "publisher command must terminate");
        const argumentLine = lines[index]!.trimStart();
        assert.equal(
          countOccurrences(argumentLine),
          0,
          "publisher commands must not be nested in argument values",
        );
        const terminator = argumentLine.at(-1);
        assert.ok(
          terminator === "\\" || terminator === "|",
          "publisher arguments must end in a continuation or pipeline",
        );
        const argument = argumentLine.slice(0, -1).trimEnd();
        const separator = argument.indexOf(" ");
        assert.ok(separator > 2, "publisher arguments must use --name value");
        const name = argument.slice(0, separator);
        const value = argument.slice(separator + 1).trim();
        assert.ok(
          name.startsWith("--") &&
            name
              .slice(2)
              .split("")
              .every(
                (character) =>
                  (character >= "a" && character <= "z") ||
                  (character >= "0" && character <= "9") ||
                  character === "-",
              ),
          "publisher argument names must be canonical",
        );
        assert.ok(value && isCanonicalValue(value), `${name} must have one shell-safe line value`);
        assert.equal(args.has(name), false, `${name} must not be repeated`);
        args.set(name, value);
        continued = terminator === "\\";
      }
      commands.push(args);
    }
    return commands;
  };
  const commands = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => commandsFromScript(step.run ?? "")),
  );

  const validCommand = `${commandStart}\n  --state-root . \\\n  --expected-producer-job review |`;
  assert.equal(commandsFromScript(validCommand)[0]!.get("--expected-producer-job"), "review");
  for (const malformed of [
    `# ${validCommand}`,
    `echo ${validCommand}`,
    `timeout 20s ${validCommand}`,
    `${commandStart} \n  --expected-producer-job review |`,
    `${commandStart}\n  --state-root first \\\\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --state-root . # \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --source-root "$SOURCE_ROOT\\\n  --expected-producer-job fake" \\\n  --state-root . |`,
    `${commandStart}\n  --expected-producer-job review \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --expected-producer-job "$GITHUB_JOB" --expected-producer-job fake |`,
    `${commandStart}\n  --expected-producer-job # missing |`,
    `${commandStart}\n  --state-root first && \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --state-root . > \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --expected-producer-job review \\\n  --state-root .\${IFS}--expected-producer-job\${IFS}fake |`,
    `${commandStart}\n  --source-root "$(pnpm run --silent publish-action-events --)" \\\n  --expected-producer-job review |`,
    `pnpm run --silent publish-action-events \\\n  -- \\\n  --state-root . |`,
  ]) {
    assert.throws(() => commandsFromScript(malformed));
  }
  assert.equal(commands.length, 7);
  const expectedProducerJobs = new Set(['"$GITHUB_JOB"', "apply-proof", "review"]);
  assert.ok(
    commands.every((command) =>
      expectedProducerJobs.has(command.get("--expected-producer-job") ?? ""),
    ),
  );
  assert.ok(
    commands.some(
      (command) =>
        command.get("--expected-producer-job") === "review" &&
        command.get("--expected-producer-max-run-attempt") === '"$GITHUB_RUN_ATTEMPT"',
    ),
  );
  assert.ok(commands.some((command) => command.get("--expected-producer-job") === "apply-proof"));
});

test("sweep exact event reviews cap the configured fallback within the lease and job budgets", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const resolveBlock = workflow.slice(
    workflow.indexOf("- name: Resolve event payload"),
    workflow.indexOf("- name: Create target read token"),
  );

  assert.match(
    resolveBlock,
    /CONFIGURED_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_CODEX_TIMEOUT_MS \|\| '1200000' \}\}/,
  );
  assert.match(resolveBlock, /const maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(
    resolveBlock,
    /Number\.isInteger\(configuredValue\) && configuredValue > 0\s*\? Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)\s*: 1_200_000/,
  );
  assert.match(
    resolveBlock,
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs,\s*Math\.max\(configuredTimeout, adaptiveTimeout\)/,
  );
});

test("github activity workflow scopes cancellation to matching item activity", () => {
  const workflow = readText(".github/workflows/github-activity.yml");
  const concurrencyBlock = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:"),
  );

  assert.match(concurrencyBlock, /group: >-/);
  assert.match(
    concurrencyBlock,
    /github-activity-\$\{\{ github\.event\.client_payload\.activity\.repo/,
  );
  assert.match(concurrencyBlock, /github\.event\.client_payload\.target_repo/);
  assert.match(concurrencyBlock, /github\.event\.repository\.full_name/);
  assert.match(concurrencyBlock, /github\.event_name == 'workflow_run'/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.event_name/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.type/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.action/);
  assert.match(concurrencyBlock, /github\.event\.action/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.comment_id/);
  assert.match(concurrencyBlock, /github\.event\.comment\.id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.review\.id/);
  assert.match(concurrencyBlock, /github\.event\.review\.id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.pull_request\.number/);
  assert.match(concurrencyBlock, /github\.event\.pull_request\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.issue\.number/);
  assert.match(concurrencyBlock, /github\.event\.issue\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.subject\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.label\.name/);
  assert.match(concurrencyBlock, /github\.event\.label\.name/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.assignee\.login/);
  assert.match(concurrencyBlock, /github\.event\.assignee\.login/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.delivery_id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.idempotency_key/);
  assert.match(workflow, /Check core API budget/);
  assert.match(workflow, /CLAWSWEEPER_MIN_CORE_REMAINING/);
  assert.match(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /Dispatch spam comment intake candidates/);
  assert.match(workflow, /Dispatch spam scan candidate/);
  assert.match(workflow, /repair:spam-comment-intake -- --write-report/);
  assert.doesNotMatch(workflow, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/dispatches"/);
  assert.match(concurrencyBlock, /cancel-in-progress: true/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /runs-on: blacksmith-/);
  assert.doesNotMatch(
    concurrencyBlock,
    /group: github-activity-\$\{\{ github\.event_name \}\}-\$\{\{ github\.run_id \}\}/,
  );
  assert.doesNotMatch(concurrencyBlock, /workflow-run' \|\| 'activity'/);
});

test("exact review publication enqueue accepts a superseded acknowledgement", () => {
  type WorkflowStep = { name?: string; id?: string; run?: string };
  type WorkflowJob = { steps: WorkflowStep[] };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const publicationEnqueue = workflow.jobs["event-review-apply"]?.steps.find(
    (candidate) => candidate.id === "queue-exact-review-publication",
  );
  assert.ok(publicationEnqueue, "missing queue-exact-review-publication step");
  const run = publicationEnqueue.run ?? "";
  assert.match(run, /\.ok == true and \(\.queued == true or \.deduped == true\)/);
  assert.match(run, /jq -e '\.superseded == true'/);
  assert.match(run, /the newer publisher owns final delivery/);
});

test("apply drift requeue selects source-drift skips before unverified-checkout keeps", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const reportPath = join(root, "apply-report.json");
    writeFileSync(
      reportPath,
      JSON.stringify([
        { number: 101, action: "skipped_changed_since_review", reason: "updated_at changed" },
        { number: 102, action: "kept_open", reason: "review lacks verified local checkout access" },
        { number: 103, action: "kept_open", reason: "no close proposal" },
        { number: 104, action: "skipped_changed_since_review", reason: "snapshot changed" },
        { number: 101, action: "skipped_changed_since_review", reason: "updated_at changed" },
        { number: 105, action: "kept_open", reason: "review lacks verified local checkout access" },
        { number: 0, action: "skipped_runtime_budget", reason: "budget" },
        { number: 106, action: "closed", reason: "implemented on main" },
      ]),
      "utf8",
    );

    const selected = execFileSync(
      process.execPath,
      [
        "dist/repair/workflow-utils.js",
        "apply-requeue-review-item-numbers",
        "--report",
        reportPath,
        "--limit",
        "3",
      ],
      { encoding: "utf8" },
    );
    assert.equal(selected, "101,104,102");

    const unlimited = execFileSync(
      process.execPath,
      [
        "dist/repair/workflow-utils.js",
        "apply-requeue-review-item-numbers",
        "--report",
        reportPath,
        "--limit",
        "10",
      ],
      { encoding: "utf8" },
    );
    assert.equal(unlimited, "101,104,102,105");

    const disabled = execFileSync(
      process.execPath,
      [
        "dist/repair/workflow-utils.js",
        "apply-requeue-review-item-numbers",
        "--report",
        reportPath,
        "--limit",
        "0",
      ],
      { encoding: "utf8" },
    );
    assert.equal(disabled, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply job requeues drift-blocked close reviews only for default cursor runs", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const step = workflow.slice(workflow.indexOf("Requeue drift-blocked close reviews"));

  assert.match(step, /apply-requeue-review-item-numbers --report apply-report\.json --limit 5/);
  assert.match(step, /APPLY_SYNC_COMMENTS_ONLY:-false.*=.*"true"/s);
  assert.match(step, /APPLY_AUTO_SELECTED_BATCH:-false.*!=.*"true"/s);
  assert.match(step, /event_type: "clawsweeper_item"/);
  assert.match(step, /source_action: "source_drift_requeue"/);
  assert.match(step, /supersedes_in_progress: false/);
});
