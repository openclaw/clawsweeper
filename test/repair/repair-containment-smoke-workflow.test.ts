import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(".github/workflows/repair-containment-smoke.yml", "utf8");

test("containment smoke uses two production-class runner samples", () => {
  assert.match(workflow, /runs-on: blacksmith-16vcpu-ubuntu-2404/);
  assert.match(workflow, /max-parallel: 2/);
  assert.match(workflow, /sample: \[1, 2\]/);
  assert.match(workflow, /run: pnpm run repair:containment-smoke/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test("containment smoke is read-only and excludes untrusted fork pull requests", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|create-github-app-token|GH_TOKEN:/);
  assert.doesNotMatch(
    workflow,
    /repair:dispatch|repair:worker|repair:execute-fix|repair:apply-result|git push|gh pr/,
  );
});

test("containment changes trigger the smoke workflow", () => {
  for (const changedPath of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-containment-smoke.yml",
    "src/repair/contained-command-worker.ts",
    "src/repair/containment-preflight.ts",
    "src/repair/process-tree-containment.ts",
    "test/repair/containment-preflight.test.ts",
  ]) {
    assert.equal(workflow.match(new RegExp(escapeRegExp(`- "${changedPath}"`), "g"))?.length, 2);
  }
  assert.match(workflow, /workflow_dispatch:/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
