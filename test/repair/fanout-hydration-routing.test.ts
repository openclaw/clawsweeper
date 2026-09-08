import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("only normal-review fanout uses identities; hot intake skips preflight and audit retains hydration", () => {
  const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
  const fanout = workflow.jobs["target-fanout"];
  const full = fanout.steps.find(
    (step: { uses?: string }) => step.uses === "./.github/actions/setup-state",
  );
  const identity = fanout.steps.find(
    (step: { name?: string }) => step.name === "Prepare canonical coverage identities",
  );
  const dispatch = fanout.steps.find(
    (step: { name?: string }) => step.name === "Dispatch selected targets",
  );
  assert.equal(full.if, "${{ github.event.schedule == '37 */6 * * *' }}");
  assert.equal(identity.if, "${{ github.event.schedule == '41 * * * *' }}");
  const nodeSetup = fanout.steps.find(
    (step: { uses?: string }) => step.uses === "actions/setup-node@v6",
  );
  assert.equal(nodeSetup.if, identity.if);
  for (const schedule of ["41 * * * *", "4/20 * * * *", "37 */6 * * *"]) {
    const matches = (condition: string) =>
      condition === "${{ github.event.schedule == '" + schedule + "' }}";
    assert.equal(matches(identity.if), schedule === "41 * * * *");
    assert.equal(matches(full.if), schedule === "37 */6 * * *");
  }
  assert.equal(identity.run, "node scripts/prepare-worker-coverage-manifest.ts");
  assert.equal(identity["continue-on-error"], undefined);
  assert.equal(dispatch.if, undefined); // ordinary success() dependency, not always()
  assert.ok(fanout.steps.indexOf(identity) < fanout.steps.indexOf(dispatch));
  assert.equal(
    fanout["timeout-minutes"],
    "${{ github.event.schedule == '37 */6 * * *' && 240 || 30 }}",
  );
  assert.equal(full.with["hydrate-git-state"], "false");
  assert.equal(full.with["hydrate-state-blobs"], "false");
  assert.equal(
    dispatch.env.COVERAGE_MANIFEST,
    "${{ github.event.schedule == '37 */6 * * *' && '.artifacts/worker-records-manifest.json' || '.artifacts/worker-coverage-manifest.json' }}",
  );
  assert.match(dispatch.run, /--coverage-tracked-items-manifest "\$COVERAGE_MANIFEST"/);
  const otherHydrations = Object.entries(workflow.jobs).flatMap(([name, job]) =>
    name === "target-fanout"
      ? []
      : ((job as { steps?: Array<{ uses?: string; name?: string }> }).steps ?? []).filter((step) =>
          step.uses?.endsWith("/.github/actions/setup-state"),
        ),
  );
  assert.ok(otherHydrations.length >= 5);
  assert.ok(otherHydrations.every((step) => step.name !== "Prepare canonical coverage identities"));
});
