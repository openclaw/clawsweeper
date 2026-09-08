import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  classifyReviewRun,
  REVIEW_RUN_OBSERVER_TITLE_LANES,
} from "../scripts/review-run-observer.mjs";

test("review reliability telemetry shares the terminal reconciler workflow", () => {
  assert.equal(existsSync(".github/workflows/review-reliability-observer.yml"), false);
  const source = readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8");
  const workflow = parse(source) as Record<string, any>;
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["ClawSweeper"],
    types: ["completed"],
  });
  assert.deepEqual(workflow.permissions, {});
  const reconcileIf = String(workflow.jobs.observe.if);
  assert.match(reconcileIf, /github\.event_name == 'workflow_run'/);
  const gatedPrefixes = [
    ...reconcileIf.matchAll(/startsWith\(github\.event\.workflow_run\.display_title, '([^']+)'\)/g),
  ].map((match) => match[1]);
  assert.deepEqual(gatedPrefixes, Object.keys(REVIEW_RUN_OBSERVER_TITLE_LANES));
  for (const [prefix, lane] of Object.entries(REVIEW_RUN_OBSERVER_TITLE_LANES)) {
    assert.equal(
      classifyReviewRun({
        display_title: `${prefix}openclaw/openclaw#1`,
        event: "repository_dispatch",
      })?.trigger_lane,
      lane,
      prefix,
    );
  }
  assert.doesNotMatch(reconcileIf, /Review exact item/);
  assert.deepEqual(workflow.jobs.observe.permissions, { actions: "read", contents: "read" });
  const checkout = workflow.jobs.observe.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.uses || "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout.if, "${{ always() }}");
  assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const step = workflow.jobs.observe.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.run || "").includes("review-run-observer.mjs"),
  );
  assert.ok(step);
  assert.equal(step.if, "${{ always() }}");
  assert.match(step.run, /--event-file/);
  assert.ok(step.env.CLAWSWEEPER_WEBHOOK_SECRET);
  assert.ok(step.env.GH_TOKEN);
  assert.ok(step.env.QUEUE_URL);
  assert.match(
    workflow.jobs.observe.concurrency.group,
    /exact-review-observe-.*github\.event\.workflow_run\.id.*github\.event\.workflow_run\.run_attempt/,
  );
  assert.equal(workflow.jobs.observe.concurrency["cancel-in-progress"], false);
});

test("queued workflow remediation shares the guarded dead-letter cadence", () => {
  assert.equal(existsSync(".github/workflows/queued-run-janitor.yml"), false);
  const workflow = parse(
    readFileSync(".github/workflows/exact-review-dead-letter-reconcile.yml", "utf8"),
  ) as Record<string, any>;
  assert.equal(workflow.on.schedule[0].cron, "*/5 * * * *");
  assert.equal(workflow.concurrency.group, "exact-review-dead-letter-operator");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.permissions.actions, "write");
  const restore = workflow.jobs.reconcile.steps.find(
    (step: Record<string, unknown>) => step.name === "Restore permanent queued-run zombie state",
  );
  assert.match(String(restore.run), /actions\/artifacts/);
  assert.match(String(restore.run), /stuck-queued-zombies\.json/);
  const remediate = workflow.jobs.reconcile.steps.find(
    (step: Record<string, unknown>) => step.name === "Remediate demonstrably stuck queued runs",
  );
  assert.equal(remediate.id, "remediate");
  assert.equal(remediate["continue-on-error"], true);
  assert.equal(remediate.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(
    remediate.env.EXECUTE,
    "${{ github.event_name == 'schedule' && 'true' || github.event.inputs.execute }}",
  );
  assert.match(String(remediate.run), /stuck-queued-run-remediation\.mjs/);
  assert.match(String(remediate.run), /--execute/);
  const steps = workflow.jobs.reconcile.steps as Array<Record<string, unknown>>;
  const reconcileIndex = steps.findIndex(
    (step) => step.name === "Reconcile closed, duplicate, and recoverable dead letters",
  );
  const parkedIndex = steps.findIndex(
    (step) => step.name === "Reconcile terminal and open parked reviews",
  );
  const remediationFailureIndex = steps.findIndex(
    (step) => step.name === "Fail if queued-run remediation failed",
  );
  assert.ok(reconcileIndex > steps.indexOf(remediate));
  assert.ok(parkedIndex > reconcileIndex);
  assert.ok(remediationFailureIndex > parkedIndex);
  assert.match(
    String(steps[remediationFailureIndex]?.if),
    /steps\.remediate\.outcome == 'failure'/,
  );
  const upload = workflow.jobs.reconcile.steps.find(
    (step: Record<string, unknown>) => step.name === "Upload sanitized inventory",
  );
  assert.match(String(upload.with.path), /stuck-queued-runs\.json/);
  assert.match(String(upload.with.path), /stuck-queued-zombies\.json/);
  assert.equal(upload.with["if-no-files-found"], "ignore");
});

test("exact review generation enters finalization before state hydration", () => {
  const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8")) as Record<
    string,
    any
  >;
  const steps = workflow.jobs["event-review-apply"].steps as Array<Record<string, unknown>>;
  const review = steps.find((step) => step.name === "Review exact event item");
  const setupStateIndex = steps.findIndex((step) => step.uses === "./.github/actions/setup-state");
  const reviewIndex = steps.indexOf(review!);

  assert.ok(review);
  assert.ok(reviewIndex >= 0 && reviewIndex < setupStateIndex);
  assert.match(String(review.run), /phase: "finalizing"/);
  assert.match(String(review.run), /mark_finalizing \|\| review_exit_code=1/);
});
