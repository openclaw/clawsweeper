import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  renderWorkPlanFromReport,
  syncWorkPlanFromReport,
} from "../dist/clawsweeper-report-context.js";
import { capturedCanonicalRecordBaselineKeys } from "../dist/repair/canonical-record-baseline.js";
import { readText, tmpPrefix, withReviewRecord, workPlanCandidateReport } from "./helpers.ts";
import { ReviewRecordFormatError } from "../dist/review-record.js";

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

test("work plans use the recorded decision and retain host publication gates", () => {
  const typed = withReviewRecord(workPlanCandidateReport({ work_candidate: "none" }), {
    decision: "keep_open",
    closeReason: "none",
    workCandidate: "queue_fix_pr",
    workPriority: "high",
    workConfidence: "high",
    workPrompt: "Implement the recorded repair.",
    workLikelyFiles: ["src/recorded.ts"],
    workValidation: ["recorded validation"],
    workClusterRefs: ["recorded cluster"],
    summary: "Recorded plan summary.",
  });
  const plan = renderWorkPlanFromReport(typed);
  assert.ok(plan);
  assert.match(plan, /Recorded plan summary\./);
  assert.match(plan, /Implement the recorded repair\./);
  assert.match(plan, /work_priority: high/);
  assert.match(plan, /src\/recorded\.ts/);
  assert.match(plan, /recorded validation/);
  assert.match(plan, /recorded cluster/);
  assert.doesNotMatch(plan, /existing report fields|src\/clawsweeper\.ts/);
  assert.equal(
    renderWorkPlanFromReport(typed.replace("work_status: candidate", "work_status: none")),
    null,
  );
  assert.equal(
    renderWorkPlanFromReport(typed.replace("action_taken: kept_open", "action_taken: closed")),
    null,
  );
  assert.equal(
    renderWorkPlanFromReport(
      withReviewRecord(workPlanCandidateReport(), {
        decision: "keep_open",
        closeReason: "none",
        workCandidate: "none",
      }),
    ),
    null,
  );
  assert.throws(
    () => renderWorkPlanFromReport(typed.replace(/^review_record: \{/m, "review_record: {broken")),
    ReviewRecordFormatError,
  );
});

test("work plan sync removes a corrupt record's stale plan and continues with valid reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const plansDir = join(root, "plans");
    const reportPath = join(root, "321.md");
    const markdown = withReviewRecord(workPlanCandidateReport(), {
      decision: "keep_open",
      closeReason: "none",
      workCandidate: "queue_fix_pr",
      workPrompt: "Implement the recorded repair.",
    }).replace(/^review_record: \{/m, "review_record: {broken");
    mkdirSync(plansDir);
    writeFileSync(reportPath, markdown);
    const planPath = join(plansDir, "321.md");
    writeFileSync(planPath, "Stale runnable plan");
    assert.equal(syncWorkPlanFromReport({ markdown, reportPath, plansDir, dryRun: true }), false);
    assert.equal(readFileSync(planPath, "utf8"), "Stale runnable plan");
    assert.equal(syncWorkPlanFromReport({ markdown, reportPath, plansDir }), false);
    assert.equal(existsSync(planPath), false);
    assert.equal(readFileSync(reportPath, "utf8"), markdown);
    assert.equal(
      syncWorkPlanFromReport({
        markdown: workPlanCandidateReport({ number: 322 }),
        reportPath: join(root, "322.md"),
        plansDir,
      }),
      true,
    );
    assert.match(readFileSync(join(plansDir, "322.md"), "utf8"), /Render generated plan markdown/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("apply-artifacts captures the hydrated tuple before replacing a review record", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const baselineDir = join(root, "canonical-baseline");
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(itemsDir, { recursive: true });
    const before = workPlanCandidateReport({ reviewed_at: "2026-05-20T00:00:00.000Z" });
    const after = workPlanCandidateReport({ reviewed_at: "2026-05-21T00:00:00.000Z" });
    writeFileSync(join(itemsDir, "321.md"), before, "utf8");
    writeFileSync(join(artifactDir, "321.md"), after, "utf8");

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
      "--canonical-record-baseline-dir",
      baselineDir,
      "--replay-closed-artifacts",
      "--skip-reconcile",
    ]);

    assert.equal(
      readFileSync(join(baselineDir, "records/openclaw-clawsweeper/items/321.md"), "utf8"),
      before,
    );
    assert.deepEqual(
      [...capturedCanonicalRecordBaselineKeys(baselineDir)],
      ["openclaw-clawsweeper/321"],
    );
    assert.match(readFileSync(join(itemsDir, "321.md"), "utf8"), /reviewed_at: 2026-05-21/);
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

test("apply-artifacts records an interrupted publication before it rethrows", () => {
  // A failed publication must leave a terminal ledger receipt for the item in flight.
  assert.match(
    readText("src/clawsweeper-command-operations.ts"),
    /if \(activePublication\) \{\s*recordPublication\(\{[^]*?finishPublication\(error, interruptedMutation\);\s*throw error;/,
  );
});
