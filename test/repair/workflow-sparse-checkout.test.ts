import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import { readText } from "../helpers.ts";
import {
  buildScriptEmitsMainBundle,
  buildScriptEmitsRepairBundle,
  sourceSparseCheckoutEntries,
  sparseEntriesCover,
  workflowBuildScripts,
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

const MAIN_BUNDLE = "dist/clawsweeper.js";
const RUNTIME_DIST_ARTIFACT = "clawsweeper-runtime-dist";

test("sparse repair build workflows include runtime dependencies", () => {
  for (const workflowPath of SPARSE_REPAIR_BUILD_WORKFLOWS) {
    const buildScripts = workflowBuildScripts(workflowPath);
    assert.ok(
      buildScripts.some(buildScriptEmitsRepairBundle),
      `${workflowPath} must build the repair bundle, got ${JSON.stringify(buildScripts)}`,
    );

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

test("every workflow job that runs the main bundle directly obtains it", () => {
  const audited: string[] = [];
  for (const workflowPath of fs.globSync(".github/workflows/*.yml").sort()) {
    const text = fs.readFileSync(workflowPath, "utf8");
    if (!text.includes(MAIN_BUNDLE)) continue;
    const workflow = parse(text) as {
      jobs?: Record<
        string,
        { steps?: { uses?: unknown; run?: unknown; with?: Record<string, unknown> }[] }
      >;
    };
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      // Direct invocations only. A job that reaches the bundle through a package
      // script is not audited here, because build-script values can be GitHub
      // expressions that only a live run resolves.
      if (!steps.some((step) => String(step.run ?? "").includes(MAIN_BUNDLE))) continue;
      const site = `${workflowPath}:${jobName}`;
      audited.push(site);

      // A job may restore the compiled runtime instead of building it, as sweep's
      // review shard does. Only that exact artifact counts: other jobs download
      // unrelated artifacts and still have to build the bundle themselves.
      const restoresRuntime = steps.some(
        (step) =>
          String(step.uses ?? "").startsWith("actions/download-artifact@") &&
          String(step.with?.["name"] ?? "") === RUNTIME_DIST_ARTIFACT,
      );
      if (restoresRuntime) continue;

      const buildScripts = steps
        .filter((step) => String(step.uses ?? "").includes("actions/setup-pnpm"))
        .map((step) => String(step.with?.["build-script"] ?? ""));
      assert.ok(
        buildScripts.some(buildScriptEmitsMainBundle),
        `${site} runs ${MAIN_BUNDLE} but no build-script emits it: ${JSON.stringify(buildScripts)}`,
      );

      // The main build reads tsconfig.json, so a curated checkout has to carry it.
      const checkout = steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );
      const sparseCheckout = checkout?.with?.["sparse-checkout"];
      if (typeof sparseCheckout === "string") {
        const entries = sparseCheckout
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean);
        assert.ok(
          sparseEntriesCover(entries, "tsconfig.json"),
          `${site} builds ${MAIN_BUNDLE} from a sparse checkout that omits tsconfig.json`,
        );
      }
    }
  }
  assert.ok(audited.length > 0, `no job invoking ${MAIN_BUNDLE} was audited`);
});

test("state-hydrating sparse repair workflows keep hydration dependencies", () => {
  for (const workflowPath of [
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/spam-scanner.yml",
  ]) {
    const entries = sourceSparseCheckoutEntries(workflowPath);
    for (const requiredPath of [
      "scripts/hydrate-state.ts",
      "scripts/prepare-worker-record-cache.ts",
      "scripts/worker-blobs.ts",
      "scripts/worker-records.ts",
    ]) {
      assert.ok(
        sparseEntriesCover(entries, requiredPath),
        `${workflowPath} missing ${requiredPath}`,
      );
    }
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
