import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { STATE_PUBLISH_TIMING_DEFAULTS } from "../dist/repair/git-publish.js";

interface CheckoutStep {
  "continue-on-error"?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  env?: Record<string, unknown>;
  if?: string;
  steps?: CheckoutStep[];
  "timeout-minutes"?: number;
}

interface WorkflowDocument {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: { inputs?: Record<string, unknown> };
    workflow_run?: { types?: string[]; workflows?: string[] };
  };
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

const actionFiles = yamlFiles(".github");
const workflowFiles = readdirSync(".github/workflows", { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
  .map((entry) => join(".github/workflows", entry.name));
const checkoutReferences = actionFiles.flatMap((path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes("actions/checkout@"))
    .map((line) => ({
      path,
      reference: line
        .trim()
        .replace(/^-?\s*uses:\s*/, "")
        .replace(/\s+#.*$/, ""),
    })),
);
const checkoutV7Commit = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const statePublisherPattern =
  /\b(?:pnpm run repair:publish-main|node dist\/repair\/publish-action-event-paths\.js)\b/g;
const statePublishTimingEnv = {
  acquisitionDeadlineMs: "CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS",
  commandTimeoutMs: "CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS",
  operationDeadlineMs: "CLAWSWEEPER_PUBLISH_DEADLINE_MS",
} as const;

test("every checkout uses v7 without disabling its fork-PR guard", () => {
  assert.ok(checkoutReferences.length > 0, "expected checkout action references");
  for (const { path, reference } of checkoutReferences) {
    assert.ok(
      reference === "actions/checkout@v7" || reference === `actions/checkout@${checkoutV7Commit}`,
      `${path}: ${reference}`,
    );
  }

  const sources = actionFiles.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /allow-unsafe-pr-checkout:\s*true/);
});

test("production crawl-remote checkout is pinned to the audited v7 commit", () => {
  const workflow = parse(
    readFileSync(".github/workflows/deploy-crawl-remote.yml", "utf8"),
  ) as WorkflowDocument;
  const preflightCheckout = workflow.jobs?.preflight?.steps?.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  const deployCheckout = workflow.jobs?.deploy?.steps?.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(preflightCheckout?.uses, `actions/checkout@${checkoutV7Commit}`);
  assert.equal(preflightCheckout?.with?.repository, "openclaw/crawl-remote");
  assert.equal(deployCheckout?.uses, `actions/checkout@${checkoutV7Commit}`);
  assert.equal(deployCheckout?.with?.repository, "openclaw/clawsweeper");
  assert.equal(deployCheckout?.with?.ref, "${{ github.sha }}");
  assert.equal(deployCheckout?.with?.["sparse-checkout"], ".github/deploy/crawl-remote-toolchain");
  assert.equal(deployCheckout?.with?.["persist-credentials"], false);
});

test("trusted-event workflows explicitly checkout the default branch", () => {
  for (const path of [
    ".github/workflows/dashboard-ci.yml",
    ".github/workflows/repair-publish-results.yml",
  ]) {
    const workflow = parse(readFileSync(path, "utf8")) as WorkflowDocument;
    const checkoutSteps = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses === "actions/checkout@v7");
    assert.equal(checkoutSteps.length, 1, path);
    assert.equal(
      checkoutSteps[0]?.with?.ref,
      "${{ github.event.repository.default_branch }}",
      path,
    );
  }

  for (const path of [
    ".github/workflows/github-activity.yml",
    ".github/workflows/github-activity-receipt-replay.yml",
  ]) {
    const workflow = parse(readFileSync(path, "utf8")) as WorkflowDocument;
    const checkoutSteps = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses === "actions/checkout@v7");
    assert.equal(checkoutSteps.length, 1, path);
    assert.equal(
      checkoutSteps[0]?.with?.ref,
      "${{ github.event.repository.default_branch }}",
      path,
    );
  }
});

test("GitHub activity replay builds trusted code before downloading receipts", () => {
  const workflow = parse(
    readFileSync(".github/workflows/github-activity-receipt-replay.yml", "utf8"),
  ) as WorkflowDocument;
  const steps = workflow.jobs?.["replay-dispatch-receipts"]?.steps ?? [];
  const checkoutIndex = steps.findIndex((step) => step.uses === "actions/checkout@v7");
  const setupIndex = steps.findIndex((step) => step.uses === "./.github/actions/setup-pnpm");
  const selectIndex = steps.findIndex((step) => step.id === "select-activity-dispatch-ledger");
  const downloadIndex = steps.findIndex((step) => step.uses === "actions/download-artifact@v8");

  assert.ok(checkoutIndex >= 0, "replay job must checkout trusted source");
  assert.ok(setupIndex > checkoutIndex, "replay job must setup after trusted checkout");
  assert.equal(steps[setupIndex]?.with?.["build-script"], "build:repair");
  assert.ok(selectIndex > setupIndex, "replay job must select receipts after the trusted build");
  assert.ok(downloadIndex > selectIndex, "replay job must select receipts before downloading");
});

test("every state publisher job composes all calls within its timeout", () => {
  assert.ok(
    STATE_PUBLISH_TIMING_DEFAULTS.workflowMarginMs >= 5 * 60 * 1000,
    "publisher jobs must reserve at least five minutes for checkout, build, and non-publish work",
  );
  const publisherJobs = workflowFiles.flatMap((workflowPath) => {
    const workflow = parse(readFileSync(workflowPath, "utf8")) as WorkflowDocument;
    return Object.entries(workflow.jobs ?? {})
      .map(([jobName, job]) => {
        const calls = (job.steps ?? []).flatMap((step) => {
          const callCount = step.run?.match(statePublisherPattern)?.length ?? 0;
          const env = { ...workflow.env, ...job.env, ...step.env };
          return Array.from({ length: callCount }, () => ({
            acquisitionDeadlineMs: statePublishTimingMs(
              env,
              statePublishTimingEnv.acquisitionDeadlineMs,
              STATE_PUBLISH_TIMING_DEFAULTS.acquisitionDeadlineMs,
              workflowPath,
              jobName,
            ),
            commandTimeoutMs: statePublishTimingMs(
              env,
              statePublishTimingEnv.commandTimeoutMs,
              STATE_PUBLISH_TIMING_DEFAULTS.commandTimeoutMs,
              workflowPath,
              jobName,
            ),
            operationDeadlineMs: statePublishTimingMs(
              env,
              statePublishTimingEnv.operationDeadlineMs,
              STATE_PUBLISH_TIMING_DEFAULTS.operationDeadlineMs,
              workflowPath,
              jobName,
            ),
          }));
        });
        return { calls, job, jobName, workflowPath };
      })
      .filter(({ calls }) => calls.length > 0);
  });

  assert.equal(new Set(publisherJobs.map(({ workflowPath }) => workflowPath)).size, 16);
  assert.equal(
    publisherJobs.reduce((total, { calls }) => total + calls.length, 0),
    42,
  );
  for (const { calls, job, jobName, workflowPath } of publisherJobs) {
    const timeoutMinutes = job["timeout-minutes"];
    assert.equal(
      typeof timeoutMinutes,
      "number",
      `${workflowPath}:${jobName} publisher job must set timeout-minutes`,
    );
    const requiredMs =
      STATE_PUBLISH_TIMING_DEFAULTS.workflowMarginMs +
      calls.reduce(
        (total, call) =>
          total + call.acquisitionDeadlineMs + call.operationDeadlineMs + call.commandTimeoutMs,
        0,
      );
    assert.ok(
      timeoutMinutes * 60 * 1000 >= requiredMs,
      `${workflowPath}:${jobName} publisher calls require ${requiredMs}ms plus prework margin but the job timeout is ${timeoutMinutes}m`,
    );
  }
});

test("GitHub activity publishers use the exact default lease recovery budget", () => {
  const jobs = [
    [".github/workflows/github-activity.yml", "notify"],
    [".github/workflows/github-activity-receipt-replay.yml", "replay-dispatch-receipts"],
  ];
  const timing = STATE_PUBLISH_TIMING_DEFAULTS;
  const requiredMs =
    timing.acquisitionDeadlineMs +
    timing.operationDeadlineMs +
    timing.commandTimeoutMs +
    timing.workflowMarginMs;

  for (const [workflowPath, jobName] of jobs) {
    const workflow = parse(readFileSync(workflowPath, "utf8")) as WorkflowDocument;
    const timeoutMs = (workflow.jobs?.[jobName]?.["timeout-minutes"] ?? 0) * 60 * 1000;
    assert.equal(timeoutMs, timing.workflowTimeoutMs, workflowPath);
    assert.ok(requiredMs <= timeoutMs, workflowPath);
  }
});

test("GitHub activity rerun attempt two replays attempt one without redispatch", () => {
  const workflowPath = ".github/workflows/github-activity-receipt-replay.yml";
  const workflowSource = readFileSync(workflowPath, "utf8");
  const workflow = parse(workflowSource) as WorkflowDocument;
  const steps = workflow.jobs?.["replay-dispatch-receipts"]?.steps ?? [];
  const selector = steps.find((step) => step.id === "select-activity-dispatch-ledger");
  const download = steps.find((step) => step.id === "download-activity-dispatch-ledger");
  assert.ok(selector?.run, "replay job must select an artifact from the stable workflow run");

  const runId = "991234";
  const artifact = (attempt: number, id: number, expired = false) => ({
    expired,
    id,
    name: `github-activity-dispatch-receipts-${runId}-${attempt}`,
  });
  assert.deepEqual(
    runReplayArtifactSelection(selector.run, runId, 2, [
      artifact(1, 101),
      artifact(2, 102, true),
      artifact(3, 103),
      { expired: false, id: 104, name: `unrelated-${runId}-2` },
    ]),
    {
      artifact_id: "101",
      artifact_name: `github-activity-dispatch-receipts-${runId}-1`,
      producer_attempt: "1",
      source_run_id: runId,
      source_sha: "a".repeat(40),
    },
  );
  assert.equal(
    runReplayArtifactSelection(selector.run, runId, 2, [artifact(1, 101), artifact(2, 102)])
      .artifact_id,
    "102",
    "a rerun that uploaded a current-attempt bundle must prefer it",
  );
  assert.equal(
    runReplayArtifactSelection(selector.run, runId, 4, [artifact(1, 101), artifact(3, 103)])
      .artifact_id,
    "103",
    "multiple replay-only reruns must select the latest prior producer attempt",
  );

  assert.match(selector.run, /actions\/runs\/\$\{SOURCE_RUN_ID\}\/artifacts/);
  assert.match(
    selector.run,
    /actions\/runs\/\$\{SOURCE_RUN_ID\}\/attempts\/\$\{SOURCE_RUN_ATTEMPT\}/,
  );
  assert.doesNotMatch(selector.run, /SOURCE_RUN_ATTEMPT\s*-\s*1/);
  assert.equal(
    download?.with?.["artifact-ids"],
    "${{ steps.select-activity-dispatch-ledger.outputs.artifact_id }}",
  );
  assert.equal(download?.with?.["github-token"], "${{ github.token }}");
  assert.equal(
    download?.with?.["run-id"],
    "${{ steps.select-activity-dispatch-ledger.outputs.source_run_id }}",
  );
  assert.match(workflowSource, /\.workflow == "github-activity\.yml"/);
  assert.doesNotMatch(workflowSource, /\.workflow == "github activity to openclaw"/);
  assert.deepEqual(workflow.on?.workflow_run, {
    workflows: ["github activity to openclaw"],
    types: ["completed"],
  });
  assert.deepEqual(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}).sort(), [
    "source_run_attempt",
    "source_run_id",
  ]);
  const replayCondition = workflow.jobs?.["replay-dispatch-receipts"]?.if ?? "";
  const automaticConclusions = JSON.parse(
    /fromJSON\('([^']+)'\)/.exec(replayCondition)?.[1] ?? "[]",
  ) as string[];
  assert.deepEqual(automaticConclusions, ["failure", "cancelled", "timed_out"]);
  for (const conclusion of ["success", "neutral", "skipped"]) {
    assert.equal(automaticConclusions.includes(conclusion), false);
  }
  const replay = workflowSource.slice(workflowSource.indexOf("replay-dispatch-receipts:"));
  assert.doesNotMatch(
    replay,
    /continue-on-error|repair:spam-comment-intake|repair:notify-github-activity|Dispatch spam scan candidate/,
  );
  assert.doesNotMatch(
    readFileSync(".github/workflows/github-activity.yml", "utf8"),
    /replay-dispatch-receipts/,
  );
});

test("trusted-event state checkout remains pinned to the state repository branch", () => {
  const action = parse(readFileSync(".github/actions/setup-state/action.yml", "utf8")) as {
    runs?: { steps?: CheckoutStep[] };
  };
  const checkout = action.runs?.steps?.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout?.with?.repository, "openclaw/clawsweeper-state");
  assert.equal(checkout?.with?.ref, "state");
});

function statePublishTimingMs(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  workflowPath: string,
  jobName: string,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  assert.ok(
    Number.isSafeInteger(parsed) && parsed > 0,
    `${workflowPath}:${jobName} ${name} must be a positive integer`,
  );
  return parsed;
}

function runReplayArtifactSelection(
  script: string,
  runId: string,
  runAttempt: number,
  artifacts: unknown[],
): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-replay-artifact-"));
  try {
    const bin = join(root, "bin");
    const output = join(root, "github-output");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
case "$*" in
  *"/artifacts"*) printf '%s\\n' "$GH_ARTIFACT_RESPONSE" ;;
  *) printf '%s\\n' "$GH_RUN_RESPONSE" ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GH_ARTIFACT_RESPONSE: JSON.stringify([{ artifacts }]),
        GH_RUN_RESPONSE: JSON.stringify({
          head_sha: "a".repeat(40),
          id: Number(runId),
          path: ".github/workflows/github-activity.yml",
          run_attempt: runAttempt,
          status: "completed",
        }),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        SOURCE_RUN_ATTEMPT: String(runAttempt),
        SOURCE_RUN_ID: runId,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          assert.ok(separator > 0, `invalid workflow output: ${line}`);
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
