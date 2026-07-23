import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readText } from "../helpers.ts";
import {
  sourceSparseCheckoutEntries,
  sparseEntriesCover,
  SPARSE_REPAIR_BUILD_WORKFLOWS,
} from "./workflow-sparse-checkout-helpers.ts";

const REPAIR_RUNTIME_PATHS = [
  ".github/actions/setup-pnpm",
  "config/automation-limits.json",
  "prompts/pr-close-coverage-proof.md",
  "schema/clawsweeper-pr-close-coverage-proof.schema.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.repair.json",
] as const;

test("sparse repair build workflows include runtime dependencies", () => {
  for (const workflowPath of SPARSE_REPAIR_BUILD_WORKFLOWS) {
    const workflow = readText(workflowPath);
    assert.match(workflow, /build-script: build:repair/);

    const entries = sourceSparseCheckoutEntries(workflowPath);
    assert.ok(entries.includes("src"), `${workflowPath} must checkout the complete src tree`);
    assert.equal(
      entries.filter((entry) => entry.startsWith("src/")).length,
      0,
      `${workflowPath} must not maintain individual src entries`,
    );
    for (const requiredPath of REPAIR_RUNTIME_PATHS) {
      assert.ok(
        sparseEntriesCover(entries, requiredPath),
        `${workflowPath} missing ${requiredPath}`,
      );
    }
  }
});

test("state-hydrating sparse repair workflows keep their hydration script", () => {
  for (const workflowPath of [
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/spam-scanner.yml",
  ]) {
    assert.ok(
      sparseEntriesCover(sourceSparseCheckoutEntries(workflowPath), "scripts/hydrate-state.ts"),
      `${workflowPath} missing scripts/hydrate-state.ts`,
    );
  }
});

test("sparse CI checkout includes pnpm workspace policy", () => {
  const entries = sourceSparseCheckoutEntries(".github/workflows/ci.yml");

  assert.ok(entries.includes("pnpm-workspace.yaml"));
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
  const entries = sourceSparseCheckoutEntries(".github/workflows/repair-comment-router.yml");

  for (const requiredPath of [
    "src/action-ledger-files.ts",
    "src/action-ledger-runtime.ts",
    "src/action-ledger.ts",
  ]) {
    assert.ok(
      sparseEntriesCover(entries, requiredPath),
      `repair comment router missing ${requiredPath}`,
    );
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
