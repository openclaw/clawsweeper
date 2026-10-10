// Deliberate structural guards. Each guard keeps a safety boundary that a behavior test cannot
// reach (workflow YAML or a forbidden raw API). Keep each guard small and give its reason.
import assert from "node:assert/strict";
import { globSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { readText } from "./helpers.ts";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Workflow = {
  env?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  on: { workflow_dispatch?: { inputs: Record<string, { default?: string }> } };
  jobs: Record<string, { if?: string; env?: Record<string, string>; steps?: Step[] }>;
};

function workflow(name: string): Workflow {
  return parseYaml(readText(`.github/workflows/${name}`)) as Workflow;
}

function steps(document: Workflow): Step[] {
  return Object.values(document.jobs).flatMap((job) => job.steps ?? []);
}

// test/repair source-text guards

// Cluster intake makes state durable and recovers pending dispatches before it selects new work.
test("cluster intake publishes jobs durably before dispatch", () => {
  const intake = workflow("repair-cluster-intake.yml").jobs.intake?.steps ?? [];
  const order = [
    intake.findIndex((step) => step.uses === "./.github/actions/create-state-token"),
    intake.findIndex((step) => step.uses === "./.github/actions/setup-state"),
    intake.findIndex((step) => step.name === "Recover pending cluster dispatches"),
    intake.findIndex((step) => step.name === "Prepare unprocessed cluster candidates"),
    intake.findIndex((step) => step.name === "Durably accept cluster intake"),
  ];
  assert.ok(order[0]! >= 0, "missing state token step");
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
});

// The selector model judges cluster quality. Code never ranks clusters with word lists or scores.
test("cluster selection has no semantic word lists, thresholds, or scores", () => {
  const sources = [
    "src/repair/select-cluster-candidate.ts",
    "src/repair/import-gitcrawl-clusters.ts",
  ]
    .map(readText)
    .join("\n");
  assert.doesNotMatch(sources, /_WORDS\b|DECISION_LABELS|FEATURE_LABELS|BUG_LABELS/);
  assert.doesNotMatch(sources, /selection score|title cohesion|closedPercent|maxAgeDays/);
});

// Repair target read tokens cover only the validated target, never a fixed repository.
test("repair target read tokens are scoped to the resolved target", () => {
  const intake = steps(workflow("repair-cluster-intake.yml")).find(
    (step) => step.name === "Create target read token",
  );
  assert.equal(intake?.with?.owner, "${{ steps.target.outputs.owner }}");
  assert.equal(intake?.with?.repositories, "${{ steps.target.outputs.name }}");
  const publish = steps(workflow("repair-publish-results.yml"));
  const reader = publish.find((step) => step.name === "Create target read token");
  assert.equal(reader?.with?.owner, "${{ steps.result-targets.outputs.owner }}");
  assert.equal(reader?.with?.repositories, "${{ steps.result-targets.outputs.repositories }}");
  // Result publication writes state with the state credential, never with an app token.
  for (const step of publish) assert.notEqual(step.with?.["permission-contents"], "write");
});

// review-prompt-context.test.ts guards

// Product-direction closes act on contributor items. The workflow must keep them off unless a
// maintainer sets the repository variable.
test("sweep workflow keeps the product-direction close gate off by default", () => {
  type Env = Record<string, string> | undefined;
  const workflow = parseYaml(readText(".github/workflows/sweep.yml")) as {
    env?: Env;
    jobs: Record<string, { env?: Env; steps?: Array<{ env?: Env }> }>;
  };
  const values = [
    workflow.env,
    ...Object.values(workflow.jobs).flatMap((job) => [
      job.env,
      ...(job.steps ?? []).map((step) => step.env),
    ]),
  ].flatMap((env) => env?.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED ?? []);
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.equal(
      value,
      "${{ vars.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED || 'false' }}",
    );
  }
});

// clawsweeper.test.ts workflow and source guards

// Duplicate deliveries of one comment cancel each other; other comments never do.
test("spam comment intake cancels only duplicate deliveries of the same comment", () => {
  const concurrency = workflow("spam-comment-intake.yml").concurrency;
  assert.equal(concurrency?.["cancel-in-progress"], true);
  for (const key of ["comment_id", "review_comment_id", "activity.comment.id"]) {
    assert.ok(concurrency?.group.includes(`client_payload.${key}`), key);
  }
});

// Exact spam scans run per comment and never cancel one another.
test("spam scanner exact dispatches never cancel other scans", () => {
  const concurrency = workflow("spam-scanner.yml").concurrency;
  assert.equal(concurrency?.["cancel-in-progress"], false);
  assert.ok(concurrency?.group.includes("spam-scanner-{0}-issue-comment-{1}"));
  assert.ok(concurrency?.group.includes("spam-scanner-{0}-review-comment-{1}"));
});

// A requeue dispatch needs a durable ledger, and session reports follow the dispatch outcome.
test("repair worker requeue dispatch waits for its durable ledger", () => {
  const all = steps(workflow("repair-cluster-worker.yml"));
  const dispatch = all.find((step) => step.id === "requeue_dispatch");
  assert.match(dispatch?.if ?? "", /steps\.repair-requeue-ledger\.outcome == 'success'/);
  const failure = all.find((step) => step.name === "Record work failure");
  assert.match(failure?.if ?? "", /steps\.requeue_dispatch\.outcome != 'success'/);
});

// Agent CLIs install exact releases, never a moving tag; OpenClaw source builds stay opt-in.
test("agent CLI setup actions install exact pinned releases", () => {
  const exact = /^\d+\.\d+\.\d+$/;
  for (const [action, inputs] of [
    ["setup-codex", ["codex-version", "proxy-version"]],
    ["setup-openclaw", ["openclaw-version"]],
  ] as const) {
    const document = parseYaml(readText(`.github/actions/${action}/action.yml`)) as {
      inputs: Record<string, { default?: string }>;
      runs: { steps: Step[] };
    };
    for (const input of inputs) assert.match(document.inputs[input]?.default ?? "", exact, input);
    for (const step of document.runs.steps) assert.doesNotMatch(step.run ?? "", /@latest/);
    if (action === "setup-openclaw") {
      assert.equal(document.inputs["openclaw-source-ref"]?.default, "");
      for (const step of document.runs.steps) {
        assert.match(step.if ?? "", /env\.CLAWSWEEPER_RUNNER == 'openclaw'/);
      }
    }
  }
});

// Model credentials stay in step env, so setup steps and other steps never inherit them.
test("workflows never expose model credentials at workflow or job scope", () => {
  for (const name of readdirSync(".github/workflows").filter((file) => file.endsWith(".yml"))) {
    const document = workflow(name);
    for (const env of [document.env, ...Object.values(document.jobs).map((job) => job.env)]) {
      for (const secret of ["OPENAI_API_KEY", "CLAWSWEEPER_INTERNAL_MODEL"]) {
        assert.equal(Object.hasOwn(env ?? {}, secret), false, `${name}: ${secret}`);
      }
    }
  }
});

// Repair planning stays read-only unless an operator picks the trusted-runner fallback.
test("repair worker planner sandbox defaults to read-only", () => {
  const input = workflow("repair-cluster-worker.yml").on.workflow_dispatch?.inputs.planner_sandbox;
  assert.equal(input?.default, "read-only");
});

// Scheduled cluster intake is gated at job level, before any credential is created.
test("scheduled cluster intake is gated before it creates credentials", () => {
  const intake = workflow("repair-cluster-intake.yml").jobs.intake;
  assert.equal(
    intake?.if,
    "${{ github.event_name != 'schedule' || vars.CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED == '1' }}",
  );
});

// Cluster intake dispatches workers only through the durable intake publisher.
test("cluster intake never dispatches workers before durable acceptance", () => {
  for (const step of steps(workflow("repair-cluster-intake.yml"))) {
    assert.doesNotMatch(step.run ?? "", /repair:dispatch\b|state-materializer\.yml/, step.name);
  }
});

// Terminal acknowledgements write comments and labels only, never repository content.
test("terminal finalization target token cannot write repository content", () => {
  const tokens = workflow("sweep.yml").jobs["event-review-terminal-finalization"]?.steps?.filter(
    (step) => step.id === "target-write-token",
  );
  assert.equal(tokens?.length, 1);
  assert.notEqual(tokens?.[0]?.with?.["permission-contents"], "write");
});

// Automatic failed-review recovery and record-only manual reviews publish review comments only.
test("automatic retry publication remains review-only", () => {
  const reviewOnly = steps(workflow("sweep.yml")).find(
    (step) => step.id === "prepare-direct-exact-review-publication",
  )?.env?.REVIEW_ONLY;
  assert.equal(typeof reviewOnly, "string");
  for (const [sourceAction, publicationPolicy, expected] of [
    ["failed_review_shard_recovery", "", "true"],
    ["manual_explicit_review", "record_comment_only", "true"],
    ["command_proof_result", "", "false"],
    ["opened", "", "false"],
    ["source_drift_requeue", "", "false"],
  ]) {
    const expression = reviewOnly!
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replace(
        "fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceAction",
        JSON.stringify(sourceAction),
      )
      .replace(
        "fromJSON(steps.claim-exact-review-queue.outputs.decision).publicationPolicy",
        JSON.stringify(publicationPolicy),
      );
    const contains = (values: string[], value: string) => values.includes(value);
    assert.equal(
      Function("contains", "fromJSON", `return (${expression});`)(contains, JSON.parse),
      expected,
      sourceAction,
    );
  }
});

// Failed-review retries plan only until an operator enables live dispatch, and a ledger setup
// failure never blocks the retry plan.
test("failed-review retries default to dry-run", () => {
  const steps = workflow("failed-review-retry.yml").jobs["retry-failed-reviews"]?.steps ?? [];
  const retry = steps.find((step) => step.env?.DRY_RUN !== undefined);
  assert.equal(
    retry?.env?.DRY_RUN,
    "${{ vars.CLAWSWEEPER_FAILED_REVIEW_RETRY_ENABLED == '1' && 'false' || 'true' }}",
  );
  const ledger = steps.find((step) => step.uses?.endsWith("/setup-action-ledger")) as
    | (Step & { "continue-on-error"?: boolean })
    | undefined;
  assert.equal(ledger?.["continue-on-error"], true);
});

// Status publication names its target repository, so it never writes another repository.
test("sweep status writes are scoped to the target repository", () => {
  const statusSteps = steps(workflow("sweep.yml")).filter((step) =>
    step.run?.includes("pnpm run status --"),
  );
  assert.ok(statusSteps.length > 0);
  for (const step of statusSteps) assert.match(step.run ?? "", /--target-repo /, step.name);
});

// execute-fix-artifact-source.test.ts guards

// A direct Codex launch skips the agent runner sandbox, input scan, timeout and file capture.
// This guard also replaces the clawsweeper.test.ts review-surface check.
test("production code launches Codex only through the agent runner", () => {
  const directLaunch = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*["'`]codex["'`]/;
  const offenders = globSync("src/**/*.ts").filter((file) => {
    const source = readText(file);
    const runnerFile =
      file === join("src", "agent-runner.ts") || file === join("src", "codex-process.ts");
    return directLaunch.test(source) || (!runnerFile && /\brunCodexProcess\b/.test(source));
  });
  assert.deepEqual(offenders, []);
});
