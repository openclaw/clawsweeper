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
};

type WorkflowJob = {
  env?: Record<string, unknown>;
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

test("only the exact-review batch publisher requests priority admission", () => {
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
  assert.deepEqual(prioritySetups, [".github/workflows/exact-review-batch-publish.yml:publish"]);
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
    35,
    "new or removed generated-state publication surfaces require an explicit credential audit",
  );
});

test("state compaction remains an explicitly separate main-branch writer", () => {
  const source = readFileSync(join(workflowDirectory, "state-compaction.yml"), "utf8");
  assert.match(source, /repository: openclaw\/clawsweeper-state/);
  assert.match(source, /ref: main/);
  assert.doesNotMatch(source, /\.github\/actions\/setup-state/);
});

test("the rollout remains frozen at exact-review publication batch size two", () => {
  const workflow = readFileSync(join(workflowDirectory, "exact-review-batch-publish.yml"), "utf8");
  const worker = readFileSync("dashboard/wrangler.toml", "utf8");
  assert.match(workflow, /EXACT_REVIEW_BATCH_MAX_ITEMS: "2"/);
  assert.match(worker, /EXACT_REVIEW_PUBLICATION_BATCH_SIZE = "2"/);
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
