import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("review reliability observer listens only to terminal ClawSweeper runs with read permissions", () => {
  const source = readFileSync(".github/workflows/review-reliability-observer.yml", "utf8");
  const workflow = parse(source) as Record<string, any>;
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["ClawSweeper"],
    types: ["completed"],
  });
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  const checkout = workflow.jobs.observe.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.uses || "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const step = workflow.jobs.observe.steps.find((candidate: Record<string, unknown>) =>
    String(candidate.run || "").includes("review-run-observer.mjs"),
  );
  assert.ok(step);
  assert.match(step.run, /--event-file/);
  assert.ok(step.env.CLAWSWEEPER_WEBHOOK_SECRET);
  assert.ok(step.env.GH_TOKEN);
  assert.ok(step.env.QUEUE_URL);
  assert.doesNotMatch(source, /workflow_dispatch|schedule|apply-existing|apply-decisions/);
});
