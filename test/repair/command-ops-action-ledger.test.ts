import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { readText } from "../helpers.ts";

type WorkflowStep = { name?: string; id?: string; uses?: string; if?: string; run?: string };
type Workflow = {
  jobs: Record<string, { permissions?: Record<string, string>; steps: WorkflowStep[] }>;
};

test("exact review publisher bypasses the legacy action ledger and finalizes through the fenced acknowledgement", () => {
  const workflow = parseYaml(readText(".github/workflows/sweep.yml")) as Workflow;
  const publisher = workflow.jobs["event-review-publish"]!.steps.map((step) => step.name);
  assert.ok(!publisher.includes("Mark re-review complete"));
  assert.ok(!publisher.includes("Publish exact review action ledger"));
  const finalizer = workflow.jobs["event-review-terminal-finalization"]!.steps;
  const acknowledgement = finalizer.findIndex(
    (step) => step.name === "Begin fenced terminal acknowledgement",
  );
  const statusMutation = finalizer.findIndex(
    (step) => step.name === "Update final command status once",
  );
  assert.ok(acknowledgement >= 0);
  assert.ok(statusMutation > acknowledgement);
  assert.equal(
    finalizer[statusMutation]!.if,
    "${{ steps.terminal-acknowledgement.outputs.allowed == 'true' && steps.target-write-token.outcome == 'success' }}",
  );
});
