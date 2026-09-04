import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  recentReconciliation,
  RECONCILE_COOLDOWN_MS,
} from "../../scripts/exact-review-reconcile-guard.mjs";

const now = Date.parse("2026-09-04T01:00:00Z");
const updatedAt = new Date(now - 60_000).toISOString();
const runs = [{ databaseId: 42, updatedAt }];
const job = {
  name: "Reconcile leases / Reconcile terminal run",
  status: "completed",
  conclusion: "success",
  completedAt: updatedAt,
};

test("event reconciliation coalesces the complete reusable job while preserving observations", () => {
  const workflow = parse(readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8"));
  const child = parse(readFileSync(".github/workflows/exact-review-reconcile-run.yml", "utf8"));
  assert.deepEqual(workflow.jobs.reconcile.concurrency, {
    group: "exact-review-reconcile-workflow-run",
    "cancel-in-progress": false,
  });
  assert.equal(workflow.jobs.reconcile.uses, "./.github/workflows/exact-review-reconcile-run.yml");
  assert.match(workflow.jobs.reconcile.if, /github.event_name == 'workflow_run'/);
  assert.equal(child.jobs.reconcile.needs, "cooldown");
  assert.equal(child.jobs.reconcile.if, "${{ needs.cooldown.outputs.reconcile == 'true' }}");
  assert.equal(child.jobs.cooldown.outputs.reconcile, "${{ steps.history.outputs.reconcile }}");
  assert.equal(child.jobs.cooldown.steps[1].run, "node scripts/exact-review-reconcile-guard.mjs");
  assert.deepEqual(workflow.on.schedule, [{ cron: "*/15 * * * *" }]);
  assert.equal(workflow.jobs.sweep.needs, undefined);
  assert.equal(workflow.jobs.sweep.concurrency.group, "exact-review-reconcile-sweep");
  assert.equal(workflow.jobs.observe.needs, undefined);
  assert.match(workflow.jobs.observe.concurrency.group, /workflow_run.id/);
  assert.ok(
    workflow.jobs.observe.steps.some((step: any) =>
      String(step.run).includes("review-run-observer.mjs"),
    ),
  );
});

test("cooldown requires a real successful reconciliation within five minutes", () => {
  assert.equal(RECONCILE_COOLDOWN_MS, 300_000);
  assert.equal(
    recentReconciliation(runs, () => [job], { now }),
    "42",
  );
  assert.equal(
    recentReconciliation(runs, () => [{ ...job, name: "Sweep terminal exact-review runs" }], {
      now,
    }),
    "42",
  );
  for (const changed of [
    { conclusion: "skipped" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { name: "Check recent lease reconciliation" },
    { name: "Observe terminal review run" },
    { completedAt: new Date(now - 300_000).toISOString() },
    { completedAt: "invalid" },
    { completedAt: new Date(now + 1).toISOString() },
  ])
    assert.equal(
      recentReconciliation(runs, () => [{ ...job, ...changed }], { now }),
      null,
    );
});

test("observer-only runs do not hide older successful repairs or extend their completion time", () => {
  const candidates = [{ databaseId: 99, updatedAt }, ...runs];
  assert.equal(
    recentReconciliation(candidates, (id: string) => (id === "99" ? [] : [job]), { now }),
    "42",
  );
  let lookups = 0;
  assert.equal(
    recentReconciliation(
      runs,
      () => {
        lookups++;
        return [job];
      },
      { now, currentRunId: "42" },
    ),
    null,
  );
  for (const timestamp of [
    "invalid",
    new Date(now - 300_000).toISOString(),
    new Date(now + 1).toISOString(),
  ]) {
    assert.equal(
      recentReconciliation(
        [{ databaseId: 42, updatedAt: timestamp }],
        () => {
          lookups++;
          return [job];
        },
        { now },
      ),
      null,
    );
  }
  assert.equal(lookups, 0);
});
