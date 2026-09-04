import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const path = ".github/workflows/exact-review-queue-maintenance.yml";
const source = readFileSync(path, "utf8");
const cliSource = readFileSync("src/repair/exact-review-queue-maintenance.ts", "utf8");
const workflow = YAML.parse(source) as {
  on: { schedule?: unknown; workflow_dispatch: { inputs: Record<string, unknown> } };
  concurrency: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      env: Record<string, string>;
      steps: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
    }
  >;
};

test("queue maintenance is explicit, bounded, and non-cancelling", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "execute",
    "passes",
    "max_items",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.max_items, {
    description: "Maximum reconciliation candidates to inspect",
    required: true,
    type: "number",
    default: 1,
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const maintenance = workflow.jobs.reconcile!.steps.find(
    (step) => step.name === "Preview or reconcile historical publication lineages",
  );
  assert.equal(maintenance?.env?.EXECUTE, "${{ inputs.execute }}");
  assert.equal(maintenance?.env?.PASSES, "${{ inputs.passes }}");
  assert.equal(maintenance?.env?.MAX_ITEMS, "${{ inputs.max_items }}");
  const run = maintenance?.run || "";
  assert.match(run, /repair:exact-review-queue-maintenance/);
  assert.match(run, /--max-items "\$MAX_ITEMS"/);
  assert.match(run, /args\+=\(--apply\)/);
  assert.match(run, /--passes "\$PASSES"/);
  assert.match(cliSource, /requestedPasses = integerArg\("--passes", 1, 1, 100\)/);
  assert.match(cliSource, /effectivePasses: 1/);
  assert.doesNotMatch(cliSource, /for \(let pass/);
  assert.doesNotMatch(source, /schedule:/);
});
