import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  "runs-on"?: unknown;
  steps?: WorkflowStep[];
};

type WorkflowDocument = {
  jobs?: Record<string, WorkflowJob>;
};

const workflowDirectory = ".github/workflows";
const coordinatorGate = "${{ vars.CLAWSWEEPER_STATE_COORDINATOR_ENABLED || 'false' }}";
const coordinatorUrl =
  "${{ vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai' }}";
const publicationEntryPoints = [
  /repair:publish-main\b/,
  /repair:publish-event-result\b/,
  /repair:exact-review-batch commit\b/,
  /scripts\/prepare-exact-review-batch\.mjs\b/,
  /dist\/repair\/state-materializer\.js\b/,
  /repair:conflict-self-heal\b(?![^\n]*--verify-job-head)/,
  /\bpublish-action-event-paths\b/,
  /\b(?:persist_reconciliation|publish_changes|publish_status)\b/,
];

test("every generated-state checkout receives the explicit coordinator migration gate", () => {
  const setups: Array<{ file: string; job: string; step: WorkflowStep }> = [];
  for (const { file, workflow } of workflows()) {
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      for (const step of definition.steps ?? []) {
        if (isSetupState(step)) setups.push({ file, job, step });
      }
    }
  }

  assert.equal(setups.length, 26, "new state checkouts must join the repo-wide boundary");
  for (const { file, job, step } of setups) {
    assert.equal(step.with?.["coordinator-enabled"], coordinatorGate, `${file}:${job}`);
    assert.equal(step.with?.["coordinator-url"], coordinatorUrl, `${file}:${job}`);
  }
});

test("the setup action exports no long-lived coordinator credential", () => {
  const actionPath = ".github/actions/setup-state/action.yml";
  const source = readFileSync(actionPath, "utf8");
  const action = parse(source) as {
    inputs?: Record<string, { default?: unknown }>;
  };

  assert.equal(action.inputs?.["coordinator-enabled"]?.default, "false");
  assert.equal(action.inputs?.["coordinator-url"]?.default, "https://clawsweeper.openclaw.ai");
  assert.equal(action.inputs?.["coordinator-class"]?.default, "ordinary");
  assert.doesNotMatch(source, /coordinator-secret|CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(source, /CLAWSWEEPER_STATE_COORDINATOR_ENABLED=\$coordinator_enabled/);
  assert.match(source, /CLAWSWEEPER_STATE_COORDINATOR_URL=\$STATE_COORDINATOR_URL/);
  assert.match(source, /CLAWSWEEPER_STATE_COORDINATOR_CLASS=\$\{\{ inputs\.coordinator-class \}\}/);
});

test("state materializer and apply publishers enable model-guided recovery with the existing Codex key", () => {
  const expectedKey = "${{ secrets.OPENAI_API_KEY }}";
  const expectedModel = "${{ secrets.CLAWSWEEPER_MODEL }}";
  const expectedJobs = [
    [".github/workflows/state-materializer.yml", "materialize", ["Materialize queued state"]],
    [".github/workflows/sweep.yml", "apply-proof", ["Generate bound close coverage proofs"]],
    [
      ".github/workflows/sweep.yml",
      "apply-existing",
      [
        "Reconcile before apply preselect",
        "Apply unchanged proposed decisions with checkpoints",
        "Retry final apply status publication",
      ],
    ],
  ] as const;
  const byFile = new Map(workflows().map(({ file, workflow }) => [file, workflow]));

  for (const [file, jobName, recoverySteps] of expectedJobs) {
    const job = byFile.get(file)?.jobs?.[jobName];
    assert.ok(job, `${file}:${jobName}`);
    assert.equal(job.env?.CLAWSWEEPER_MODEL_RECOVERY_ENABLED, "1", `${file}:${jobName}`);
    assert.equal(job.env?.OPENAI_API_KEY, undefined, `${file}:${jobName}: key must be step-scoped`);
    const setupCodex = job.steps?.find((step) =>
      step.uses?.endsWith("/.github/actions/setup-codex"),
    );
    assert.ok(setupCodex, `${file}:${jobName}: setup-codex`);
    assert.equal(setupCodex.env?.OPENAI_API_KEY, expectedKey, `${file}:${jobName}`);
    assert.equal(setupCodex.env?.CLAWSWEEPER_INTERNAL_MODEL, expectedModel, `${file}:${jobName}`);
    if (jobName !== "apply-proof") {
      assert.equal(setupCodex["continue-on-error"], true, `${file}:${jobName}: optional setup`);
    }
    for (const stepName of recoverySteps) {
      const step = job.steps?.find((candidate) => candidate.name === stepName);
      assert.ok(step, `${file}:${jobName}:${stepName}`);
      assert.equal(step.env?.OPENAI_API_KEY, expectedKey, `${file}:${jobName}:${stepName}`);
    }
  }
  const materializer = byFile.get(".github/workflows/state-materializer.yml")?.jobs?.materialize;
  const recoveryPublisher = materializer?.steps?.find(
    (step) => step.name === "Publish materializer recovery action events",
  );
  assert.equal(
    recoveryPublisher?.env?.CLAWSWEEPER_STATE_REPO_TOKEN,
    "${{ steps.state-token.outputs.token }}",
  );
  assert.equal(recoveryPublisher?.env?.CLAWSWEEPER_MODEL_RECOVERY_ENABLED, "0");
  assert.equal(recoveryPublisher?.env?.CLAWSWEEPER_STATE_APPEND_ENABLED, "1");
  assert.equal(recoveryPublisher?.env?.OPENAI_API_KEY, undefined);

  const sweep = byFile.get(".github/workflows/sweep.yml");
  const proofPublisher = sweep?.jobs?.["publish-apply-proof-action-ledger"];
  assert.equal(proofPublisher?.env?.CLAWSWEEPER_MODEL_RECOVERY_ENABLED, "0");
  const applyEventPublisher = sweep?.jobs?.["apply-existing"]?.steps?.find(
    (step) => step.name === "Publish apply action events",
  );
  assert.equal(applyEventPublisher?.env?.CLAWSWEEPER_MODEL_RECOVERY_ENABLED, "0");
  assert.equal(applyEventPublisher?.env?.OPENAI_API_KEY, undefined);
});

test("state materializer uses an available GitHub-hosted runner", () => {
  const byFile = new Map(workflows().map(({ file, workflow }) => [file, workflow]));
  const materializer = byFile.get(".github/workflows/state-materializer.yml")?.jobs?.materialize;
  assert.equal(materializer?.["runs-on"], "ubuntu-latest");
});

test("state materializer bounds its coordinator acquire below the job timeout", () => {
  const byFile = new Map(workflows().map(({ file, workflow }) => [file, workflow]));
  const materializer = byFile.get(".github/workflows/state-materializer.yml")?.jobs?.materialize;
  const budgetMs = Number(materializer?.env?.CLAWSWEEPER_STATE_COORDINATOR_ACQUIRE_TIMEOUT_MS);
  assert.equal(budgetMs, 2_100_000);
  // A late grant still needs room inside the job window to publish one batch
  // and run the finalize steps.
  assert.equal(budgetMs + 15 * 60_000 <= Number(materializer?.["timeout-minutes"]) * 60_000, true);
});

test("only the batch publisher and the state materializer request priority admission", () => {
  const prioritySetups: string[] = [];
  for (const { file, workflow } of workflows()) {
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      for (const step of definition.steps ?? []) {
        if (isSetupState(step) && step.with?.["coordinator-class"] === "publication_batch") {
          prioritySetups.push(`${file}:${job}`);
        }
      }
    }
  }
  assert.deepEqual(prioritySetups, [
    ".github/workflows/exact-review-batch-publish.yml:publish",
    ".github/workflows/state-materializer.yml:materialize",
  ]);
});

test("trusted generated-state mutation steps receive a step-scoped coordinator credential", () => {
  let publishers = 0;
  for (const { file, workflow } of workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const setupIndex = steps.findIndex(isSetupState);
      if (setupIndex >= 0) {
        assert.equal(
          job.env?.CLAWSWEEPER_WEBHOOK_SECRET,
          undefined,
          `${file}:${jobName}: coordinator credential must not be job-scoped`,
        );
      }
      for (const [index, step] of steps.entries()) {
        const command = String(step.run || "");
        if (!publicationEntryPoints.some((pattern) => pattern.test(command))) continue;
        publishers += 1;
        assert.ok(setupIndex >= 0 && setupIndex < index, `${file}:${jobName}:${step.name}`);
        assert.equal(
          step.env?.CLAWSWEEPER_WEBHOOK_SECRET,
          "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}",
          `${file}:${jobName}:${step.name}`,
        );
      }
    }
  }
  assert.equal(
    publishers,
    36,
    "new or removed generated-state publication surfaces require an explicit credential audit",
  );
});

test("every immutable action-event publisher uses the state append window", () => {
  const publishers: string[] = [];
  for (const { file, workflow } of workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!String(step.run || "").includes("publish-action-event-paths")) continue;
        publishers.push(`${file}:${jobName}:${step.name}`);
        assert.equal(
          step.env?.CLAWSWEEPER_STATE_APPEND_ENABLED ?? job.env?.CLAWSWEEPER_STATE_APPEND_ENABLED,
          "1",
          `${file}:${jobName}:${step.name}`,
        );
      }
    }
  }
  assert.equal(publishers.length, 7);
});

test("state compaction remains an explicitly separate main-branch writer", () => {
  const source = readFileSync(join(workflowDirectory, "state-compaction.yml"), "utf8");
  assert.match(source, /repository: openclaw\/clawsweeper-state/);
  assert.match(source, /ref: main/);
  assert.doesNotMatch(source, /\.github\/actions\/setup-state/);
});

test("the rollback scans 50 and grants 8 with bounded parallel preparation", () => {
  const workflow = readFileSync(join(workflowDirectory, "exact-review-batch-publish.yml"), "utf8");
  const worker = readFileSync("dashboard/wrangler.toml", "utf8");
  assert.match(workflow, /EXACT_REVIEW_BATCH_MAX_ITEMS: "50"/);
  assert.match(worker, /EXACT_REVIEW_PUBLICATION_BATCH_SIZE = "8"/);
  assert.match(worker, /EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS = "60000"/);
});

function workflows(): Array<{ file: string; workflow: WorkflowDocument }> {
  return readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => {
      const file = join(workflowDirectory, name);
      return { file, workflow: parse(readFileSync(file, "utf8")) as WorkflowDocument };
    });
}

function isSetupState(step: WorkflowStep): boolean {
  return (
    step.uses === "./.github/actions/setup-state" ||
    step.uses === "./clawsweeper/.github/actions/setup-state"
  );
}
