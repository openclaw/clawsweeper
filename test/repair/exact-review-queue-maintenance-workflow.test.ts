import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const path = ".github/workflows/exact-review-queue-maintenance.yml";
const source = readFileSync(path, "utf8");
const workflow = YAML.parse(source) as {
  on: { schedule?: unknown; workflow_dispatch: { inputs: Record<string, unknown> } };
  concurrency: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if: string;
      env: Record<string, string>;
      steps: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
    }
  >;
};

test("queue maintenance is explicit, bounded, and non-cancelling", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["execute", "passes"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.jobs.reconcile!.if, /inputs\.execute/);
  const maintenance = workflow.jobs.reconcile!.steps.find(
    (step) => step.name === "Reconcile superseded publication items",
  );
  assert.equal(maintenance?.env?.PASSES, "${{ inputs.passes }}");
  const run = maintenance?.run || "";
  assert.match(run, /repair:exact-review-queue-maintenance/);
  assert.match(run, /--max-items 100/);
  assert.match(run, /--passes "\$PASSES"/);
  assert.doesNotMatch(run, /inputs\.passes/);
  assert.doesNotMatch(source, /schedule:/);
});
