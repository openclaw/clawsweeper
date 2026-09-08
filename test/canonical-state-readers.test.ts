import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("hydrate-state has no records or ledger git fallback", () => {
  const source = readFileSync("scripts/hydrate-state.ts", "utf8");
  assert.match(source, /discoverWorkerRecordRepoSlugs/);
  assert.match(source, /materializeWorkerRecords/);
  assert.match(source, /materializeStateBlobs/);
  assert.doesNotMatch(
    source,
    /parseRecordsSource|CLAWSWEEPER_RECORDS_SOURCE|CLAWSWEEPER_LEDGER_SOURCE|FALLING BACK TO GIT/,
  );
  assert.doesNotMatch(source, /copyGeneratedPath\([^\n]+"records"/);
  assert.doesNotMatch(source, /copyGeneratedPath\([^\n]+"ledger"/);
  assert.doesNotMatch(source, /copyGeneratedPath\([^\n]+"assets"/);
});

test("setup-state checks out only remaining git-backed operational paths", () => {
  const source = readFileSync(".github/actions/setup-state/action.yml", "utf8");
  const action = parse(source) as {
    inputs?: Record<string, unknown>;
    runs?: { steps?: Array<{ name?: string; uses?: string; with?: Record<string, unknown> }> };
  };
  assert.equal(action.inputs?.["records-source"], undefined);
  assert.equal(action.inputs?.["ledger-source"], undefined);
  assert.ok(action.inputs?.["hydrate-git-state"]);
  const checkout = action.runs?.steps?.find((step) => step.name === "Check out operational state");
  assert.equal(checkout?.uses, "actions/checkout@v7");
  const sparse = String(checkout?.with?.["sparse-checkout"] ?? "");
  for (const path of ["/jobs/", "/results/", "/notifications/", "/apply-report.json"]) {
    assert.match(sparse, new RegExp(path.replaceAll("/", "\\/")));
  }
  for (const retired of ["records", "ledger", "assets"]) {
    assert.doesNotMatch(sparse, new RegExp(`/${retired}/`));
  }
});

test("canonical record operations retain snapshot only", () => {
  const workflow = parse(readFileSync(".github/workflows/worker-records-ops.yml", "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    jobs?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(workflow.jobs ?? {}), ["snapshot"]);
  assert.equal(workflow.on?.workflow_dispatch?.inputs?.action, undefined);
  assert.equal("verify" in (workflow.jobs ?? {}), false);
  assert.equal("reconcile" in (workflow.jobs ?? {}), false);
  for (const retiredWorkflow of [
    ".github/workflows/backfill-worker-records.yml",
    ".github/workflows/migrate-state-blobs.yml",
  ]) {
    assert.throws(() => readFileSync(retiredWorkflow, "utf8"));
  }
});

test("canonical record snapshots run every six hours without cancelling an active snapshot", () => {
  const workflow = parse(readFileSync(".github/workflows/worker-records-ops.yml", "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "9 */6 * * *" }]);
  assert.ok(workflow.on.workflow_dispatch.inputs.target_repo);
  assert.deepEqual(workflow.concurrency, {
    group: "worker-records-snapshot",
    "cancel-in-progress": false,
  });
});

test("scheduled and manual canonical snapshots run the runner upload command", () => {
  const workflow = parse(readFileSync(".github/workflows/worker-records-ops.yml", "utf8"));
  const job = workflow.jobs.snapshot;
  assert.equal(job.if, undefined);
  const target = job.steps.find((step: { id?: string }) => step.id === "target");
  assert.equal(
    target.env.TARGET_REPO,
    "${{ github.event_name == 'schedule' && 'openclaw/openclaw' || inputs.target_repo }}",
  );
  const trigger = job.steps.find(
    (step: { name?: string }) => step.name === "Build and upload canonical records snapshot",
  );
  assert.ok(trigger, "runner snapshot step must exist");
  assert.equal(trigger.if, undefined);
  assert.equal(trigger.env.TARGET_SLUG, "${{ steps.target.outputs.slug }}");
  assert.match(trigger.run, /node scripts\/worker-records\.ts snapshot-upload/);
  assert.match(trigger.run, /--repo-slug "\$TARGET_SLUG"/);
  assert.doesNotMatch(trigger.run, /snapshots\/trigger/);
  assert.doesNotMatch(trigger.run, /dry.run|inputs\./i);
});
