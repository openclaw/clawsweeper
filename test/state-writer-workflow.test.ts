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

type WorkflowJob = { env?: Record<string, unknown>; steps?: WorkflowStep[] };
type WorkflowDocument = { jobs?: Record<string, WorkflowJob> };

const workflowDirectory = ".github/workflows";
const workerUrl =
  "${{ vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai' }}";
const workerSecret = "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}";

test("every state hydration uses the canonical Worker with an explicit git-state decision", () => {
  const setups: Array<{ site: string; step: WorkflowStep }> = [];
  for (const { file, workflow } of workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (isSetupState(step)) setups.push({ site: `${file}:${jobName}`, step });
      }
    }
  }

  assert.equal(setups.length, 25, "setup-state site count is an audited invariant");
  for (const { site, step } of setups) {
    assert.equal(step.with?.["records-url"], workerUrl, site);
    assert.equal(step.with?.["records-secret"], workerSecret, site);
    assert.equal(step.with?.["records-source"], undefined, site);
    assert.equal(step.with?.["ledger-source"], undefined, site);
    assert.equal(step.with?.["coordinator-enabled"], undefined, site);
  }
  assert.deepEqual(
    setups
      .filter(({ step }) => step.with?.["hydrate-git-state"] === "false")
      .map(({ site }) => site),
    [
      ".github/workflows/commit-review.yml:plan",
      ".github/workflows/commit-review.yml:review",
      ".github/workflows/commit-review.yml:publish",
      ".github/workflows/exact-review-batch-publish.yml:publish",
      ".github/workflows/sweep.yml:event-review-apply",
      ".github/workflows/sweep.yml:event-review-publish",
    ],
  );
});

test("setup-state checks out only the remaining operational git tree", () => {
  const source = readFileSync(".github/actions/setup-state/action.yml", "utf8");
  const action = parse(source) as {
    inputs?: Record<string, unknown>;
    runs?: { steps?: WorkflowStep[] };
  };
  assert.equal(action.inputs?.["records-source"], undefined);
  assert.equal(action.inputs?.["ledger-source"], undefined);
  assert.equal(action.inputs?.["coordinator-enabled"], undefined);
  assert.ok(action.inputs?.["hydrate-git-state"]);
  assert.match(source, /CLAWSWEEPER_STATE_COORDINATOR_ENABLED=1/);
  const checkout = action.runs?.steps?.find((step) => step.name === "Check out operational state");
  const sparse = String(checkout?.with?.["sparse-checkout"] ?? "");
  for (const retained of ["/jobs/", "/results/", "/notifications/", "/apply-report.json"]) {
    assert.match(sparse, new RegExp(retained.replaceAll("/", "\\/")));
  }
  for (const canonical of ["records", "ledger", "assets"]) {
    assert.doesNotMatch(sparse, new RegExp(`/${canonical}/`));
  }
  assert.match(source, /--skip-git-state/);
});

test("all remaining git publishers join setup-state and receive a step-scoped coordinator secret", () => {
  const patterns = [
    /repair:publish-main\b/,
    /repair:publish-cluster-intake\b/,
    /repair:conflict-self-heal\b(?![^\n]*--verify-job-head)/,
    /\b(?:persist_reconciliation|publish_changes|publish_status)\b/,
  ];
  let publishers = 0;
  for (const { file, workflow } of workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const setupIndex = (job.steps ?? []).findIndex(isSetupState);
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!patterns.some((pattern) => pattern.test(String(step.run ?? "")))) continue;
        publishers += 1;
        assert.ok(setupIndex >= 0 && setupIndex < index, `${file}:${jobName}:${step.name}`);
        assert.equal(
          step.env?.CLAWSWEEPER_WEBHOOK_SECRET ?? step.env?.CLAWSWEEPER_STATE_COORDINATOR_SECRET,
          workerSecret,
          `${file}:${jobName}:${step.name}`,
        );
      }
    }
  }
  assert.equal(publishers, 24, "git publisher count is an audited invariant");
});

test("every immutable action-event publisher targets R2 without a state-repo token", () => {
  const publishers: string[] = [];
  for (const { file, workflow } of workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!String(step.run ?? "").includes("publish-action-event-paths")) continue;
        publishers.push(`${file}:${jobName}:${step.name}`);
        assert.equal(step.env?.CLAWSWEEPER_WEBHOOK_SECRET, workerSecret);
        assert.equal(step.env?.QUEUE_URL, workerUrl);
        assert.doesNotMatch(
          String(step.run),
          /repair:publish-main|CLAWSWEEPER_STATE_DIR|--message/,
        );
      }
    }
  }
  assert.equal(publishers.length, 8);
});

test("the materializer is a bounded window compactor with no git output", () => {
  const source = readFileSync(".github/workflows/state-materializer.yml", "utf8");
  const implementation = readFileSync("src/repair/state-materializer.ts", "utf8");
  assert.match(source, /name: Compact queued state/);
  assert.match(source, /Compact queued state/);
  assert.doesNotMatch(source, /setup-state|create-state-token|state-token|setup-codex/);
  assert.doesNotMatch(source, /git push|publish-action-event|CLAWSWEEPER_STATE_LEASE/);
  assert.match(implementation, /\/internal\/state\/drain/);
  assert.match(implementation, /\/internal\/state\/ack/);
  assert.doesNotMatch(implementation, /git-publish|publishMainCommit|writeFileSync|records\//);
});

test("retired migration and Git recovery surfaces stay deleted", () => {
  const allSource = [
    readFileSync("src/repair/git-publish.ts", "utf8"),
    readFileSync(".github/actions/setup-state/action.yml", "utf8"),
    ...workflows().map(({ file }) => readFileSync(file, "utf8")),
  ].join("\n");
  assert.doesNotMatch(allSource, /clawsweeper-publish-lease|CLAWSWEEPER_STATE_LEASE/);
  assert.doesNotMatch(allSource, /CLAWSWEEPER_RECORDS_SOURCE|CLAWSWEEPER_LEDGER_SOURCE/);
  for (const retired of [
    ".github/workflows/backfill-worker-records.yml",
    ".github/workflows/migrate-state-blobs.yml",
    "src/repair/state-publication-batch.ts",
    "src/repair/recovery-advisor.ts",
  ]) {
    assert.throws(() => readFileSync(retired, "utf8"));
  }
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
