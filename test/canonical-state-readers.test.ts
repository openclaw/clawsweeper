import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("canonical record operations retain snapshot only", () => {
  const workflow = parse(readFileSync(".github/workflows/worker-records-ops.yml", "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    jobs?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(workflow.jobs ?? {}), ["snapshot"]);
  assert.equal(workflow.on?.workflow_dispatch?.inputs?.action, undefined);
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
