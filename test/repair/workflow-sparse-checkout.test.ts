import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readText } from "../helpers.ts";

const REPAIR_RUNTIME_PATHS = [
  "prompts/pr-close-coverage-proof.md",
  "schema/clawsweeper-pr-close-coverage-proof.schema.json",
  "src/clawsweeper-text.ts",
  "src/codex-env.ts",
  "src/codex-output-capture.ts",
  "src/codex-process-worker.ts",
  "src/codex-process.ts",
  "src/codex-spawn.ts",
  "src/codex-transient.ts",
  "src/github-json.ts",
  "src/pr-close-coverage-proof.ts",
] as const;

const SPARSE_REPAIR_BUILD_WORKFLOWS = [
  ".github/workflows/repair-comment-router.yml",
  ".github/workflows/spam-comment-intake.yml",
  ".github/workflows/spam-scanner.yml",
] as const;

test("sparse repair build workflows include runtime dependencies", () => {
  for (const workflowPath of SPARSE_REPAIR_BUILD_WORKFLOWS) {
    const workflow = readText(workflowPath);
    assert.match(workflow, /build-script: build:repair/);

    const entries = sparseCheckoutEntries(workflow);
    for (const requiredPath of REPAIR_RUNTIME_PATHS) {
      assert.ok(entries.has(requiredPath), `${workflowPath} missing ${requiredPath}`);
    }
  }
});

test("sparse CI checkout includes pnpm workspace policy", () => {
  const workflow = readText(".github/workflows/ci.yml");
  const entries = sparseCheckoutEntries(workflow);

  assert.ok(entries.has("pnpm-workspace.yaml"));
});

test("repair build emits the bounded Codex process worker", () => {
  const config = JSON.parse(fs.readFileSync("tsconfig.repair.json", "utf8")) as {
    include?: string[];
  };
  assert.ok(config.include?.includes("src/codex-output-capture.ts"));
  assert.ok(config.include?.includes("src/codex-process-worker.ts"));
});

test("repair comment router workflow preserves repository dispatch target branch", () => {
  const workflow = readText(".github/workflows/repair-comment-router.yml");

  assert.match(workflow, /target_branch:\n\s+description:/);
  assert.match(
    workflow,
    /target_branch="\$\{\{ github\.event\.client_payload\.target_branch \|\| '' \}\}"/,
  );
  assert.equal(
    [
      ...workflow.matchAll(
        /if \[ -n "\$target_branch" \]; then\n\s+args\+=\(--target-branch "\$target_branch"\)\n\s+fi/g,
      ),
    ].length,
    2,
  );
});

test("repair comment router sparse checkout includes action ledger runtime", () => {
  const workflow = readText(".github/workflows/repair-comment-router.yml");
  const entries = sparseCheckoutEntries(workflow);

  for (const requiredPath of [
    "src/action-ledger-files.ts",
    "src/action-ledger-runtime.ts",
    "src/action-ledger.ts",
  ]) {
    assert.ok(entries.has(requiredPath), `repair comment router missing ${requiredPath}`);
  }
});

test("sweep workflow preserves one claimed target branch through exact review", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const dispatchTargetBranchResolver =
    /target_branch="\$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.target_branch \|\| github\.event\.client_payload\.target_branch \|\| 'main' \}\}"/g;
  const continuationTargetBranch =
    /-f target_branch="\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/g;
  const recoveryTargetBranch =
    /--arg target_branch "\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/g;

  assert.match(workflow, /target_branch:\n\s+description: "Target repository branch to review"/);
  assert.equal([...workflow.matchAll(dispatchTargetBranchResolver)].length, 1);
  assert.equal([...workflow.matchAll(continuationTargetBranch)].length, 1);
  assert.equal([...workflow.matchAll(recoveryTargetBranch)].length, 1);
  assert.match(
    workflow,
    /CLAIM_TARGET_BRANCH: \$\{\{ fromJSON\(steps\.claim-exact-review-queue\.outputs\.decision\)\.targetBranch \}\}/,
  );
  assert.match(workflow, /target_branch="\$CLAIM_TARGET_BRANCH"/);
  assert.match(workflow, /target_branch="\$\{\{ steps\.live-item\.outputs\.target_branch \}\}"/);
});

function sparseCheckoutEntries(workflow: string): Set<string> {
  const entries = new Set<string>();
  const lines = workflow.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s+sparse-checkout:\s*\|/.test(line)) continue;

    const blockIndent = leadingSpaces(line);
    for (index += 1; index < lines.length; index += 1) {
      const entryLine = lines[index] ?? "";
      if (!entryLine.trim()) continue;
      if (leadingSpaces(entryLine) <= blockIndent) {
        index -= 1;
        break;
      }
      entries.add(entryLine.trim());
    }
  }

  return entries;
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}
