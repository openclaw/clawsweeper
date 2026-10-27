import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  buildScriptEmitsMainBundle,
  buildScriptEmitsRepairBundle,
} from "./repair/workflow-sparse-checkout-helpers.ts";

const jobs = [
  ["audit.yml", "audit-dashboard"],
  ["sweep.yml", "event-review-apply"],
  ["sweep.yml", "event-review-publish"],
  ["sweep.yml", "apply-proof"],
  ["sweep.yml", "publish-apply-proof-action-ledger"],
  ["sweep.yml", "apply-existing"],
  ["failed-review-retry.yml", "retry-failed-reviews"],
] as const;

for (const [workflow, job] of jobs) {
  test(`${workflow}/${job} builds both Node runtime profiles without dashboard checks`, () => {
    const definition = parse(readFileSync(`.github/workflows/${workflow}`, "utf8"));
    const setup = definition.jobs[job].steps.filter(
      (step: { uses?: string }) => step.uses === "./.github/actions/setup-pnpm",
    );
    assert.equal(setup.length, 1);
    const script = setup[0].with["build-script"];
    assert.equal(script, "build:node");
    assert.ok(buildScriptEmitsMainBundle(script));
    assert.ok(buildScriptEmitsRepairBundle(script));
  });
}

test("required CI retains the dashboard compiler that emits no Node files", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.scripts["build:node"], "pnpm run build && pnpm run build:repair");
  assert.equal(
    manifest.scripts["build:all"],
    "pnpm run build && pnpm run build:repair && pnpm run build:dashboard",
  );
  assert.match(manifest.scripts["check:fast"], /pnpm run build:all/);
  assert.equal(
    JSON.parse(readFileSync("tsconfig.dashboard.json", "utf8")).compilerOptions.noEmit,
    true,
  );
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.ok(
    ci.jobs["check-fast"].steps.some(
      (step: { run?: string }) => step.run === "pnpm run check:fast",
    ),
  );
});
