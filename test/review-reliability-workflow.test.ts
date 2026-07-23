import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("review reliability telemetry shares the terminal reconciler workflow", () => {
  assert.equal(existsSync(".github/workflows/review-reliability-observer.yml"), false);
  const source = readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8");
  const workflow = parse(source) as Record<string, any>;
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["ClawSweeper"],
    types: ["completed"],
  });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.jobs.reconcile.if, "${{ github.event_name == 'workflow_run' }}");
  assert.deepEqual(workflow.jobs.reconcile.permissions, { actions: "read", contents: "read" });
  const checkout = workflow.jobs.reconcile.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.uses || "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout.if, "${{ always() }}");
  assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const step = workflow.jobs.reconcile.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.run || "").includes("review-run-observer.mjs"),
  );
  assert.ok(step);
  assert.equal(step.if, "${{ always() }}");
  assert.match(step.run, /--event-file/);
  assert.ok(step.env.CLAWSWEEPER_WEBHOOK_SECRET);
  assert.ok(step.env.GH_TOKEN);
  assert.ok(step.env.QUEUE_URL);
  assert.match(
    workflow.concurrency.group,
    /format\('\{0\}-\{1\}', github\.event\.workflow_run\.id, github\.event\.workflow_run\.run_attempt\)/,
  );
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});
