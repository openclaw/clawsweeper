import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  "continue-on-error"?: boolean;
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

  assert.equal(setups.length, 20, "setup-state site count is an audited invariant");
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
      ".github/workflows/exact-review-batch-publish.yml:publish",
      ".github/workflows/sweep.yml:event-review-apply",
      ".github/workflows/sweep.yml:event-review-publish",
      ".github/workflows/sweep.yml:target-fanout",
    ],
  );
});

test("per-target state hydration is slug-scoped while fleet lanes retain discovery", () => {
  const setups: Array<{ site: string; step: WorkflowStep }> = [];
  for (const { file, workflow } of workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (isSetupState(step)) setups.push({ site: `${file}:${jobName}`, step });
      }
    }
  }

  assert.deepEqual(
    setups
      .filter(({ step }) => step.with?.["records-repo-slugs"] !== undefined)
      .map(({ site }) => site),
    [
      ".github/workflows/exact-review-batch-publish.yml:publish",
      ".github/workflows/repair-cluster-intake.yml:intake",
      ".github/workflows/repair-cluster-worker.yml:cluster",
      ".github/workflows/repair-cluster-worker.yml:execute",
      ".github/workflows/repair-comment-router.yml:route-comments",
      ".github/workflows/repair-conflict-self-heal.yml:self-heal",
      ".github/workflows/repair-issue-implementation-backfill.yml:backfill",
      ".github/workflows/repair-issue-implementation-intake.yml:intake",
      ".github/workflows/spam-scanner.yml:scan",
      ".github/workflows/sweep.yml:event-review-apply",
      ".github/workflows/sweep.yml:event-review-publish",
      ".github/workflows/sweep.yml:plan",
      ".github/workflows/sweep.yml:publish",
      ".github/workflows/sweep.yml:retry-failed-reviews",
      ".github/workflows/sweep.yml:apply-proof",
      ".github/workflows/sweep.yml:apply-existing",
    ],
  );
  assert.deepEqual(
    setups
      .filter(({ step }) => step.with?.["records-repo-slugs"] === undefined)
      .map(({ site }) => site),
    [
      ".github/workflows/repair-publish-results.yml:publish",
      ".github/workflows/repair-self-heal.yml:self-heal",
      ".github/workflows/sweep.yml:target-fanout",
      ".github/workflows/sweep.yml:audit-dashboard",
    ],
  );

  for (const { site, step } of setups) {
    assert.equal(step.with?.["hydrate-state-blobs"], "false", site);
  }
});

test("automatic issue implementation joins the priority intake state-writer lane", () => {
  const source = readFileSync(".github/workflows/repair-issue-implementation-intake.yml", "utf8");
  const workflow = parse(source) as WorkflowDocument;
  const stateSetup = workflow.jobs?.intake?.steps?.find(isSetupState);

  assert.equal(stateSetup?.with?.["coordinator-class"], "cluster_intake");
  assert.equal(
    stateSetup?.with?.["records-item-number"],
    "${{ github.event.inputs.item_number || github.event.client_payload.item_number }}",
  );
  assert.equal(source.match(/for attempt in 1 2 3; do/g)?.length, 2);
  assert.match(source, /sleep "\$\(\(attempt \* 3\)\)"/);
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
  assert.ok(action.inputs?.["records-item-number"]);
  const snapshot = action.runs?.steps?.find(
    (step) => step.name === "Resolve canonical record snapshot cache key",
  );
  assert.equal(
    (snapshot as WorkflowStep & { if?: string })?.if,
    "${{ inputs.records-item-number == '' }}",
  );
  assert.match(source, /--records-item-number "\$RECORDS_ITEM_NUMBER"/);
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
  assert.equal(publishers, 20, "git publisher count is an audited invariant");
});

test("post-side-effect git bookkeeping is non-fatal while durability fences stay strict", () => {
  const documents = new Map(workflows().map(({ file, workflow }) => [file, workflow]));
  const step = (file: string, job: string, name: string) => {
    const found = documents
      .get(file)
      ?.jobs?.[job]?.steps?.find((candidate) => candidate.name === name);
    assert.ok(found, `${file}:${job}:${name}`);
    return found;
  };

  for (const [file, job, name] of [
    [".github/workflows/spam-scanner.yml", "scan", "Commit spam scanner audit"],
    [
      ".github/workflows/repair-conflict-self-heal.yml",
      "self-heal",
      "Commit conflict self-heal ledger",
    ],
    [".github/workflows/repair-self-heal.yml", "self-heal", "Commit self-heal ledger"],
    [".github/workflows/sweep.yml", "retry-failed-reviews", "Publish failed-review retry state"],
    [".github/workflows/sweep.yml", "apply-existing", "Retry final apply status publication"],
  ]) {
    assert.equal(step(file, job, name)["continue-on-error"], true, `${file}:${job}:${name}`);
  }

  for (const [file, job, name] of [
    [
      ".github/workflows/repair-comment-router.yml",
      "route-comments",
      "Commit comment router ledger",
    ],
    [".github/workflows/repair-issue-implementation-intake.yml", "intake", "Commit intake ledger"],
    [".github/workflows/repair-publish-results.yml", "publish", "Commit result ledger"],
  ]) {
    assert.notEqual(step(file, job, name)["continue-on-error"], true, `${file}:${job}:${name}`);
  }

  assert.match(
    readFileSync("scripts/apply-workflow-helpers.sh", "utf8"),
    /Operational state publish failed.*Canonical work remains valid/,
  );
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
    ".github/workflows/commit-review.yml",
    ".github/workflows/deploy-crawl-remote.yml",
    ".github/workflows/proof-nudges.yml",
    ".github/workflows/repair-commit-finding-intake.yml",
    ".github/workflows/repair-finalize-open-prs.yml",
    ".github/workflows/state-compaction.yml",
    ".github/workflows/state-materializer.yml",
    "src/repair/state-publication-batch.ts",
    "src/repair/state-materializer.ts",
    "src/repair/state-compaction.ts",
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
