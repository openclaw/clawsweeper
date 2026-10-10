import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("label tagging is non-blocking in repair workers", () => {
  const workflow = parse(readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; "continue-on-error"?: boolean }> }>;
  };
  const steps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.name === "Tag ClawSweeper targets");

  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.["continue-on-error"], true);
});
