import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { renderWorkPlanFromReport } from "../dist/clawsweeper.js";
import { tmpPrefix, workPlanCandidateReport } from "./helpers.ts";

test("renderWorkPlanFromReport renders dashboard plan artifacts for fresh queue_fix_pr candidates", () => {
  const plan = renderWorkPlanFromReport(workPlanCandidateReport(), {
    reportPath: "records/openclaw-clawsweeper/items/321.md",
  });
  assert.ok(plan);
  assert.match(plan, /# Coding Plan for openclaw\/clawsweeper#321: Render work plans/);
  assert.match(plan, /Render generated plan markdown from existing report fields\./);
  assert.match(plan, /- `src\/clawsweeper\.ts`/);
  assert.match(plan, /- `pnpm run check`/);
  assert.match(plan, /openclaw\/clawsweeper#26/);
});

test("renderWorkPlanFromReport returns null for stale, reclassified, or non-candidate reports", () => {
  assert.equal(renderWorkPlanFromReport(workPlanCandidateReport({ work_candidate: "none" })), null);
  assert.equal(
    renderWorkPlanFromReport(workPlanCandidateReport({ work_status: "manual_review" })),
    null,
  );
  assert.equal(renderWorkPlanFromReport(workPlanCandidateReport({ action_taken: "closed" })), null);
  assert.equal(
    renderWorkPlanFromReport(workPlanCandidateReport({ reviewed_at: "2026-01-01T00:00:00.000Z" })),
    null,
  );
});

test("apply-artifacts writes and removes generated work plans", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "321.md"), workPlanCandidateReport(), "utf8");
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-artifacts",
      "--target-repo",
      "openclaw/clawsweeper",
      "--artifact-dir",
      artifactDir,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--replay-closed-artifacts",
      "--skip-reconcile",
    ]);
    const planPath = join(plansDir, "321.md");
    assert.ok(existsSync(planPath));
    assert.match(readFileSync(planPath, "utf8"), /## Plan\n\nRender generated plan markdown/);

    writeFileSync(
      join(artifactDir, "321.md"),
      workPlanCandidateReport({ work_candidate: "none", work_status: "none" }),
      "utf8",
    );
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-artifacts",
      "--target-repo",
      "openclaw/clawsweeper",
      "--artifact-dir",
      artifactDir,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--replay-closed-artifacts",
      "--skip-reconcile",
    ]);
    assert.equal(existsSync(planPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions removes archived work plans from the scoped plans directory", () => {
  const root = mkdtempSync(tmpPrefix);
  const originalGhBin = process.env.GH_BIN;
  const originalGhBinArgs = process.env.GH_BIN_ARGS;
  const defaultPlanDir = join(process.cwd(), "records", "openclaw-clawsweeper", "plans");
  const defaultPlanPath = join(defaultPlanDir, "321.md");
  try {
    const binDir = join(root, "bin");
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    mkdirSync(defaultPlanDir, { recursive: true });
    const ghMock = `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.includes("/comments")) {
  console.log(JSON.stringify([[]]));
} else {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: "2026-05-02T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
}
`;
    writeFileSync(join(binDir, "gh.js"), ghMock, { mode: 0o755 });
    writeFileSync(
      join(itemsDir, "321.md"),
      workPlanCandidateReport({
        item_snapshot_hash: "reviewed-snapshot",
        item_updated_at: "2026-05-01T00:00:00Z",
      }),
      "utf8",
    );
    writeFileSync(join(plansDir, "321.md"), "scoped generated plan\n", "utf8");
    writeFileSync(defaultPlanPath, "default generated plan\n", "utf8");

    process.env.GH_BIN = process.execPath;
    process.env.GH_BIN_ARGS = JSON.stringify([join(binDir, "gh.js")]);
    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-decisions",
      "--target-repo",
      "openclaw/clawsweeper",
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--limit",
      "1",
      "--processed-limit",
      "1",
      "--close-delay-ms",
      "0",
    ]);

    assert.equal(existsSync(join(plansDir, "321.md")), false);
    assert.ok(existsSync(defaultPlanPath));
    assert.ok(existsSync(join(closedDir, "321.md")));
  } finally {
    if (originalGhBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = originalGhBin;
    if (originalGhBinArgs === undefined) delete process.env.GH_BIN_ARGS;
    else process.env.GH_BIN_ARGS = originalGhBinArgs;
    rmSync(root, { recursive: true, force: true });
    rmSync(defaultPlanPath, { force: true });
  }
});
