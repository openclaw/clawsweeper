import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("scheduled terminal census remains independent of telemetry", () => {
  const workflow = parse(readFileSync(".github/workflows/exact-review-reconcile.yml", "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "*/15 * * * *" }]);
  assert.equal(workflow.jobs.sweep.needs, undefined);
  assert.equal(workflow.jobs.sweep.concurrency.group, "exact-review-reconcile-sweep");
  assert.match(workflow.jobs.sweep.steps[0].run, /exact-review-queue-reconcile\.mts" sweep/);
});

test("audit coverage refreshes inventory tokens after dispatching the waves", () => {
  const workflow = parse(readFileSync(".github/workflows/target-fanout.yml", "utf8"));
  const steps = workflow.jobs["target-fanout"].steps;
  const dispatch = steps.findIndex((step: any) => step.name === "Dispatch selected targets");
  const coverage = steps.findIndex(
    (step: any) => step.name === "Summarize trailing weekly review coverage",
  );
  assert.equal(steps[coverage].if, "${{ github.event.schedule == '37 */6 * * *' }}");
  for (const owner of ["openclaw", "steipete"]) {
    const refresh = steps.findIndex((step: any) => step.id === `${owner}-coverage-token`);
    assert.ok(refresh > dispatch && refresh < coverage);
    assert.equal(
      steps[refresh].uses,
      steps.find((step: any) => step.id === `${owner}-inventory-token`).uses,
    );
    assert.equal(steps[refresh].with.owner, owner);
    assert.equal(steps[refresh].with["permission-metadata"], "read");
    assert.equal(
      steps[coverage].env[`CLAWSWEEPER_INVENTORY_TOKEN_${owner.toUpperCase()}`],
      `\${{ steps.${owner}-coverage-token.outputs.token || '__public__' }}`,
    );
  }
});
