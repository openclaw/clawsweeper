import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyContinuationBlocker,
  applyCursorAdvanceCount,
  adaptiveApplyBatchSize,
  artifactItemNumbers,
  automationLimit,
  commentSyncBatchOutput,
  countActions,
  countCommandActions,
  countRequeueRequired,
  mergeApplyReports,
  planOutputFields,
  plannedItemNumberCsv,
  proposedItemCount,
  proposedItemInventory,
  proposedItemQualitySummary,
  proposedItemNumbers,
  proposedPrCloseCoverageItemNumbers,
  pullRequestClosePromotionSignalsForTest,
  summarizeApplyReport,
  writeApplyCursor,
  writeCommentSyncCursor,
} from "../../dist/repair/workflow-utils.js";
import {
  AUTOMATION_LIMITS,
  WORKER_CONFIG,
  readWorkerConfig,
  workerLimit,
} from "../../dist/limits.js";

const APPLY_RUN_PATH = ".github/workflows/sweep.yml";
const DEFAULT_APPLY_TITLE = "Apply default ClawSweeper closures for openclaw/openclaw";

test("repair close-promotion readers prefer durable proof and rating front matter", () => {
  const report = `---
pr_rating_overall: F
pr_rating_proof: F
real_behavior_proof_status: missing
---

## Summary

## PR Rating

Overall tier: A

Proof tier: A

## Real Behavior Proof

Status: sufficient

## PR Rating

Overall tier: F

Proof tier: F

## Real Behavior Proof

Status: missing
`;

  assert.deepEqual(pullRequestClosePromotionSignalsForTest(report), {
    authorBudget: true,
    lowSignal: true,
  });
});

test("repair close-promotion readers fail closed on body metadata after the leading block", () => {
  const report = `---
type: pull_request
---

## Summary

pr_rating_overall: A
pr_rating_proof: A
real_behavior_proof_status: sufficient

## PR Rating

Overall tier: F

Proof tier: F

## Real Behavior Proof

Status: missing
`;

  assert.deepEqual(pullRequestClosePromotionSignalsForTest(report), {
    authorBudget: false,
    lowSignal: false,
  });
});

test("repair close-promotion readers fail closed on duplicate front matter keys", () => {
  const report = `---
fixed_release: v1
pr_rating_overall: A
pr_rating_proof: A
real_behavior_proof_status: sufficient
pr_rating_overall: F
pr_rating_proof: F
real_behavior_proof_status: missing
---

## Summary

## PR Rating

Overall tier: F

Proof tier: F

## Real Behavior Proof

Status: missing

## PR Rating

Overall tier: A

Proof tier: A

## Real Behavior Proof

Status: sufficient
`;

  assert.deepEqual(pullRequestClosePromotionSignalsForTest(report), {
    authorBudget: false,
    lowSignal: false,
  });
});

test("repair close-promotion readers fail closed after an injected front matter terminator", () => {
  const report = `---
fixed_release: v1
pr_rating_overall: F
pr_rating_proof: F
real_behavior_proof_status: missing
---
pr_rating_overall: A
pr_rating_proof: A
real_behavior_proof_status: sufficient
---

## PR Rating

Overall tier: A

Proof tier: A

## Real Behavior Proof

Status: sufficient
`;

  assert.deepEqual(pullRequestClosePromotionSignalsForTest(report), {
    authorBudget: false,
    lowSignal: false,
  });
});

test("repair close-promotion readers preserve section fallback without front matter", () => {
  const report = `## PR Rating

Overall tier: F

Proof tier: F

## Real Behavior Proof

Status: missing
`;

  assert.deepEqual(pullRequestClosePromotionSignalsForTest(report), {
    authorBudget: true,
    lowSignal: true,
  });
});

for (const body of [
  "pr_rating_overall: A\npr_rating_proof: A\nreal_behavior_proof_status: sufficient\n",
  "```yaml\n---\npr_rating_overall: A\npr_rating_proof: A\nreal_behavior_proof_status: sufficient\n---\n```\n",
]) {
  test(`workflow promotion uses owned ratings through body quotes: ${JSON.stringify(body)}`, () => {
    const report = `---\npr_rating_overall: F\npr_rating_proof: F\nreal_behavior_proof_status: missing\n---\n\n## Summary\n\n${body}`;
    assert.deepEqual(pullRequestClosePromotionSignalsForTest(report), {
      authorBudget: true,
      lowSignal: true,
    });
    const missing = `---\ntype: pull_request\n---\n\n## Summary\n\n${body}\n## PR Rating\n\nOverall tier: F\n\nProof tier: F\n\n## Real Behavior Proof\n\nStatus: missing\n`;
    assert.deepEqual(pullRequestClosePromotionSignalsForTest(missing), {
      authorBudget: false,
      lowSignal: false,
    });
  });
}

test("workflow empty and quoted-empty ratings remain ambiguous and later records cannot promote", () => {
  const legacy =
    "\n## PR Rating\n\nOverall tier: F\n\nProof tier: F\n\n## Real Behavior Proof\n\nStatus: missing\n";
  for (const raw of ["", '""', "\t"]) {
    assert.deepEqual(
      pullRequestClosePromotionSignalsForTest(
        `---\npr_rating_overall: ${raw}\npr_rating_proof: F\n---\n${legacy}`,
      ),
      { authorBudget: false, lowSignal: false },
    );
  }
  assert.deepEqual(
    pullRequestClosePromotionSignalsForTest(`---\ntype: pull_request\n---\n${legacy}`),
    { authorBudget: true, lowSignal: true },
  );
  assert.deepEqual(
    pullRequestClosePromotionSignalsForTest(
      `---\npr_rating_overall: F\npr_rating_proof: F\nreal_behavior_proof_status: missing\n---\n${legacy}\n---\npr_rating_overall: A\nreal_behavior_proof_status: sufficient\n---\n`,
    ),
    { authorBudget: false, lowSignal: false },
  );
});

test("apply continuation blocker only shares the default cursor lane", () => {
  const blocker = applyContinuationBlocker(
    [
      {
        databaseId: "current",
        workflowPath: APPLY_RUN_PATH,
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "in_progress",
      },
      {
        databaseId: "custom",
        workflowPath: APPLY_RUN_PATH,
        displayTitle: "Apply custom ClawSweeper closures for openclaw/openclaw",
        status: "in_progress",
      },
      {
        databaseId: "default",
        workflowPath: APPLY_RUN_PATH,
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "in_progress",
      },
    ],
    { currentRunId: "current", targetRepo: "openclaw/openclaw" },
  );

  assert.deepEqual(blocker, { databaseId: "default", status: "in_progress" });
});

test("apply continuation blocker ignores stale queued and unrelated runs", () => {
  const nowMs = Date.parse("2026-07-04T12:00:00Z");
  const blocker = applyContinuationBlocker(
    [
      {
        databaseId: "wrong-path",
        workflowPath: ".github/workflows/other.yml",
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "in_progress",
      },
      {
        databaseId: "completed",
        workflowPath: APPLY_RUN_PATH,
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "completed",
      },
      {
        databaseId: "stale",
        workflowPath: APPLY_RUN_PATH,
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "queued",
        updatedAt: "2026-07-04T05:59:59Z",
      },
      {
        databaseId: "fresh",
        workflowPath: APPLY_RUN_PATH,
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "queued",
        updatedAt: "2026-07-04T06:00:01Z",
      },
    ],
    { currentRunId: "current", targetRepo: "openclaw/openclaw", nowMs },
  );

  assert.deepEqual(blocker, { databaseId: "fresh", status: "queued" });
});

test("apply continuation blocker CLI emits workflow fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-blocker-"));
  const runsPath = path.join(root, "runs.json");
  write(
    runsPath,
    JSON.stringify([
      {
        databaseId: 42,
        workflowPath: APPLY_RUN_PATH,
        displayTitle: DEFAULT_APPLY_TITLE,
        status: "waiting",
      },
    ]),
  );

  const output = execFileSync(
    process.execPath,
    [
      path.resolve("dist/repair/workflow-utils.js"),
      "apply-continuation-blocker",
      "--runs",
      runsPath,
      "--current-run-id",
      "99",
      "--target-repo",
      "openclaw/openclaw",
    ],
    { encoding: "utf8" },
  );

  assert.equal(
    output,
    [
      "APPLY_CONTINUATION_BLOCKED=true",
      "APPLY_CONTINUATION_BLOCKER_RUN_ID=42",
      "APPLY_CONTINUATION_BLOCKER_STATUS=waiting",
      "",
    ].join("\n"),
  );
});

test("workflow utilities expose automation limits", () => {
  assert.equal(
    automationLimit("exact_review.concurrent_max"),
    AUTOMATION_LIMITS.exact_review.concurrent_max,
  );
  assert.equal(
    automationLimit("review_shards.normal_default"),
    AUTOMATION_LIMITS.review_shards.normal_default,
  );
  assert.equal(
    automationLimit("repair_live_runs.default"),
    AUTOMATION_LIMITS.repair_live_runs.default,
  );
  assert.throws(() => automationLimit("missing.default"), /unknown automation limit/);
});

test("workflow utilities accept positional automation limit CLI paths", () => {
  const output = execFileSync(
    process.execPath,
    ["dist/repair/workflow-utils.js", "limit", "review_shards.normal_default"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(output, String(AUTOMATION_LIMITS.review_shards.normal_default));
});

test("workflow utility CLI initializes close-selection constants before preselecting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-cli-"));
  write(
    path.join(root, "records/openclaw-clawhub/items/openclaw-clawhub-7.md"),
    [
      "---",
      "repository: openclaw/clawhub",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_invalid_decision",
      "close_reason: implemented_on_main",
      "item_created_at: 2024-01-01T00:00:00Z",
      "---",
      "",
    ].join("\n"),
  );

  const output = execFileSync(
    process.execPath,
    [
      path.resolve("dist/repair/workflow-utils.js"),
      "proposed-pr-close-coverage-item-numbers",
      "--target-repo",
      "openclaw/clawhub",
      "--apply-kind",
      "all",
      "--apply-close-reasons",
      "all",
      "--stale-min-age-days",
      "60",
      "--min-age-days",
      "0",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(output, "");
});

test("worker scheduler lets background lanes yield to active work", () => {
  const quietBackgroundCapacity =
    WORKER_CONFIG.workers.max -
    WORKER_CONFIG.workers.reserve_for_interactive -
    WORKER_CONFIG.workers.expansion_reserve;
  assert.equal(
    workerLimit("normal_review"),
    Math.min(AUTOMATION_LIMITS.review_shards.normal_default, quietBackgroundCapacity),
  );
  assert.equal(
    workerLimit("normal_review", {
      activeCritical: Math.floor(quietBackgroundCapacity / 2),
      activeBackground: Math.ceil(quietBackgroundCapacity / 2),
    }),
    1,
  );
  assert.equal(workerLimit("repair"), AUTOMATION_LIMITS.repair_live_runs.default);
  assert.equal(
    workerLimit("automerge_repair"),
    AUTOMATION_LIMITS.repair_live_runs.automerge_default,
  );
  assert.equal(
    workerLimit("issue_implementation"),
    AUTOMATION_LIMITS.repair_live_runs.issue_implementation_default,
  );
  assert.equal(workerLimit("cluster_repair"), AUTOMATION_LIMITS.repair_live_runs.cluster_default);
  assert.equal(workerLimit("assist"), AUTOMATION_LIMITS.assist.default);
  assert.equal(workerLimit("assist", { activeCritical: WORKER_CONFIG.workers.max - 2 }), 2);
});

test("worker scheduler keeps 104 slots available for steady background work", () => {
  const quietBackgroundCapacity =
    WORKER_CONFIG.workers.max -
    WORKER_CONFIG.workers.reserve_for_interactive -
    WORKER_CONFIG.workers.expansion_reserve;
  assert.equal(quietBackgroundCapacity, 104);
  assert.ok(quietBackgroundCapacity >= Math.floor(WORKER_CONFIG.workers.max * 0.8));
});

test("workflow worker scheduler applies queue pressure only to background lanes", () => {
  for (const lane of ["normal_review", "hot_intake"] as const) {
    const normalBudget = workerLimit(lane);
    assert.equal(workerLimit(lane, { pressureLevel: "soft" }), Math.ceil(normalBudget * 0.5));
    assert.equal(
      workerLimit(lane, { pressureLevel: "hard" }),
      Math.max(1, Math.floor(normalBudget * 0.1)),
    );
  }
  for (const lane of [
    "repair",
    "automerge_repair",
    "issue_implementation",
    "cluster_repair",
    "exact_item",
    "assist",
  ] as const) {
    assert.equal(workerLimit(lane, { pressureLevel: "hard" }), workerLimit(lane));
  }
});

test("worker config defaults imported cluster repair capacity for older configs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-limits-"));
  const configPath = path.join(root, "automation-limits.json");
  write(
    configPath,
    JSON.stringify({
      workers: {
        max: 55,
        reserve_for_interactive: 8,
        expansion_reserve: 4,
        minimum_background: 1,
      },
      lanes: {
        exact_review: {
          max_concurrent: 16,
        },
        assist: {
          max: 5,
        },
      },
    }),
  );

  assert.equal(readWorkerConfig(configPath).lanes.repair.cluster_max_live_runs, 1);
  assert.equal(readWorkerConfig(configPath).lanes.exact_review.target_max_concurrent, 16);
});

test("workflow utilities derive artifact item numbers and action counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  write(path.join(root, "artifacts/shard-a/openclaw-openclaw-42.md"), "report\n");
  write(path.join(root, "artifacts/shard-b/7.md"), "report\n");
  write(
    path.join(root, "apply-report.json"),
    JSON.stringify([{ action: "closed" }, { action: "review_comment_synced" }]),
  );

  assert.deepEqual(artifactItemNumbers(path.join(root, "artifacts")), [7, 42]);
  assert.equal(countActions(path.join(root, "apply-report.json"), ""), 2);
  assert.equal(countActions(path.join(root, "apply-report.json"), "closed"), 1);
});

test("workflow utilities summarize apply health with skip buckets and cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "closed" },
      { number: 20, action: "review_comment_synced" },
      { number: 30, action: "skipped_changed_since_review" },
      { number: 40, action: "skipped_changed_since_review" },
      {
        number: 50,
        action: "skipped_comment_auth",
        reason: "GitHub rejected durable review comment write with Requires authentication",
      },
      {
        number: 60,
        action: "skipped_locked_conversation",
        reason: "conversation was locked while syncing review comment",
      },
    ]),
  );
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 40,
      next_after_apply_checked_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-03T10:00:00Z",
    }),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 5,
    cursorPath,
    cursorRequired: true,
    candidateCount: 7,
    candidateCounts: {
      confirmed_proposal: 4,
      guarded_retry: 2,
      proof_required: 3,
      promotion_total: 538,
      promotion_eligible: 1,
      promotion_cooldown_eligible: 420,
      cooldown_eligible_total: 427,
      inconsistent_or_stale: 1,
    },
    cursorAdvanceCount: 4,
    scheduledIntervalMinutes: 15,
  });

  assert.equal(summary.status, "ok");
  assert.equal(summary.examined, 4);
  assert.equal(summary.action_records, 6);
  assert.equal(summary.processed, 6);
  assert.match(summary.summary, /4 examined; 6\/300 action records/);
  assert.equal(summary.closed, 1);
  assert.equal(summary.comment_synced, 1);
  assert.deepEqual(summary.skip_reasons, {
    skipped_changed_since_review: 2,
    skipped_comment_auth: 1,
    skipped_locked_conversation: 1,
  });
  assert.deepEqual(summary.lanes.closure, {
    processed: 3,
    closed: 1,
    comment_synced: 0,
    skipped: 2,
    skip_reasons: { skipped_changed_since_review: 2 },
  });
  assert.deepEqual(summary.lanes.comment_sync, {
    processed: 3,
    closed: 0,
    comment_synced: 1,
    skipped: 2,
    skip_reasons: {
      skipped_comment_auth: 1,
      skipped_locked_conversation: 1,
    },
  });
  assert.deepEqual(summary.next_action_buckets, {
    conversation_unlock: 1,
    live_state_recovery: 1,
    review_refresh: 2,
  });
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_comment_auth")?.next_step,
    "Repair the GitHub App write token before retrying comment sync.",
  );
  assert.deepEqual(summary.cycle, {
    basis: "scheduled_close_cursor",
    apply_ready_count: 7,
    candidate_counts: {
      confirmed_proposal: 4,
      guarded_retry: 2,
      proof_required: 3,
      promotion_total: 538,
      promotion_eligible: 1,
      promotion_cooldown_eligible: 420,
      cooldown_eligible_total: 427,
      inconsistent_or_stale: 1,
    },
    window_size: 4,
    estimated_full_cycle_windows: 2,
    estimated_full_cycle_minutes: 30,
    scheduled_interval_minutes: 15,
    label:
      "7 currently actionable close candidates (4 confirmed proposals, 2 guarded retries, 1/538 promotion probes admitted; 3 require proof; 427 cooldown-eligible backlog (420 promotions); 1 inconsistent or stale record excluded) at 4 records per latest cursor advance: about 2 windows; scheduled cadence alone would take roughly 30 min at 15-minute intervals, while successful windows can continue sooner.",
  });
  assert.equal(summary.cursor?.next_after_number, 40);
});

test("workflow utilities distinguish examined promotion probes from action records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  write(reportPath, JSON.stringify([]));
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 79148,
      next_after_apply_checked_at: "2026-06-18T00:00:00Z",
      updated_at: "2026-07-09T00:03:00Z",
    }),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 20,
    cursorPath,
    cursorRequired: true,
    candidateCount: 565,
    cursorAdvanceCount: 40,
    scheduledIntervalMinutes: 15,
  });

  assert.equal(summary.status, "ok");
  assert.equal(summary.examined, 40);
  assert.equal(summary.action_records, 0);
  assert.equal(summary.processed, 0);
  assert.match(summary.summary, /^40 examined; 0\/300 action records;/);
  assert.equal(summary.cycle.window_size, 40);
  assert.equal(summary.cursor?.next_after_number, 79148);
});

test("workflow utilities preserve a zero-action inventory for cooling promotion backlogs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(reportPath, "[]\n");
  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 20,
    cursorPath: path.join(root, "results/apply-cursors/openclaw-openclaw.json"),
    cursorRequired: true,
    candidateCount: 0,
    candidateCounts: {
      confirmed_proposal: 0,
      guarded_retry: 0,
      proof_required: 0,
      promotion_total: 5,
      promotion_eligible: 0,
      promotion_cooldown_eligible: 0,
      cooldown_eligible_total: 0,
      inconsistent_or_stale: 1,
    },
    cursorAdvanceCount: 0,
    scheduledIntervalMinutes: 15,
  });

  assert.equal(summary.status, "idle");
  assert.equal(summary.cycle.basis, "no_apply_ready_candidates");
  assert.equal(summary.cycle.apply_ready_count, 0);
  assert.match(summary.cycle.label, /5 promotion probes are cooling down/);
});

test("workflow utilities summarize comment-sync apply reports separately from closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "review_comment_synced" },
      { number: 20, action: "skipped_stale_review_comment_sync" },
      { number: 30, action: "skipped_pr_close_coverage_proof" },
    ]),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "comment_sync",
    processedLimit: 25,
    closeLimit: null,
    cursorPath: path.join(root, "missing-cursor.json"),
    cursorRequired: false,
  });

  assert.equal(summary.mode, "comment_sync");
  assert.equal(summary.examined, null);
  assert.equal(summary.action_records, 3);
  assert.match(summary.summary, /examined count unavailable; 3\/25 action records/);
  assert.equal(summary.closed, 0);
  assert.equal(summary.comment_synced, 1);
  assert.deepEqual(summary.lanes.closure, {
    processed: 0,
    closed: 0,
    comment_synced: 0,
    skipped: 0,
    skip_reasons: {},
  });
  assert.deepEqual(summary.lanes.comment_sync, {
    processed: 3,
    closed: 0,
    comment_synced: 1,
    skipped: 2,
    skip_reasons: {
      skipped_pr_close_coverage_proof: 1,
      skipped_stale_review_comment_sync: 1,
    },
  });
  assert.deepEqual(summary.next_action_buckets, {
    close_coverage_proof: 1,
    review_refresh: 1,
  });
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_stale_review_comment_sync")
      ?.label,
    "Refresh review state",
  );
});

test("workflow utilities classify common apply skip reasons into next actions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "skipped_pr_close_coverage_proof" },
      { number: 20, action: "skipped_protected_label" },
      { number: 30, action: "skipped_same_author_pair" },
      { number: 40, action: "skipped_invalid_decision" },
      { number: 50, action: "skipped_open_closing_pr" },
      { number: 60, action: "skipped_maintainer_authored" },
      { number: 70, action: "retry_pr_close_coverage_proof" },
      { number: 80, action: "skipped_missing_record" },
      { number: 90, action: "skipped_close_exempt_label" },
      { number: 100, action: "skipped_low_signal_live_guard" },
    ]),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 5,
    cursorPath: path.join(root, "missing-cursor.json"),
    cursorRequired: false,
  });

  assert.deepEqual(summary.next_action_buckets, {
    close_coverage_proof: 2,
    defer_until_closing_pr: 1,
    maintainer_review: 3,
    report_quality_repair: 2,
    stable_skip: 2,
  });
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_pr_close_coverage_proof")
      ?.next_step,
    "Run or refresh close-coverage proof for the canonical and covered PR pair.",
  );
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_open_closing_pr")?.bucket,
    "defer_until_closing_pr",
  );
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_same_author_pair")?.retryable,
    false,
  );
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_low_signal_live_guard")?.label,
    "Live close guard",
  );
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_invalid_decision")?.owner,
    "clawsweeper",
  );
  assert.equal(
    summary.next_actions.find((action) => action.reason === "retry_pr_close_coverage_proof")?.label,
    "Retry close proof",
  );
  assert.equal(
    summary.next_actions.find((action) => action.reason === "skipped_missing_record")?.bucket,
    "report_quality_repair",
  );
});

test("workflow utilities flag full-window close scans without the required cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "skipped_changed_since_review" },
      { number: 20, action: "skipped_changed_since_review" },
    ]),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 2,
    closeLimit: 5,
    cursorPath: path.join(root, "missing-cursor.json"),
    cursorRequired: true,
    candidateCount: null,
    scheduledIntervalMinutes: null,
  });

  assert.equal(summary.status, "needs_attention");
  assert.equal(summary.examined, null);
  assert.deepEqual(summary.attention_reasons, [
    "cursor_required_but_missing_after_full_window",
    "skipped_changed_since_review",
  ]);
  assert.match(summary.summary, /Attention:/);
});

test("workflow utilities flag a missing cursor after a no-action full window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(reportPath, JSON.stringify([]));

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 2,
    closeLimit: 5,
    cursorPath: path.join(root, "missing-cursor.json"),
    cursorRequired: true,
    cursorAdvanceCount: 2,
  });

  assert.equal(summary.status, "needs_attention");
  assert.equal(summary.examined, 2);
  assert.equal(summary.action_records, 0);
  assert.deepEqual(summary.attention_reasons, ["cursor_required_but_missing_after_full_window"]);
});

test("workflow utilities keep a resumable runtime yield healthy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  const cursorPath = path.join(root, "apply-cursor.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "skipped_already_closed" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 10,
      next_after_apply_checked_at: "2026-07-05T18:00:00Z",
      updated_at: "2026-07-05T18:10:00Z",
    }),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 20,
    cursorPath,
    cursorRequired: true,
    cursorAdvanceCount: 1,
  });

  assert.equal(summary.status, "ok");
  assert.deepEqual(summary.attention_reasons, []);
  assert.equal(summary.next_action_buckets.run_budget, 1);
});

test("workflow utilities flag a runtime yield that made no cursor progress", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 20,
    cursorRequired: true,
    cursorAdvanceCount: 0,
  });

  assert.equal(summary.status, "needs_attention");
  assert.deepEqual(summary.attention_reasons, ["skipped_runtime_budget"]);
});

test("workflow utilities require the cursor after a full window that closed an item", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "closed" },
      { number: 20, action: "skipped_changed_since_review" },
    ]),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 2,
    closeLimit: 5,
    cursorPath: path.join(root, "missing-cursor.json"),
    cursorRequired: true,
  });

  assert.equal(summary.status, "needs_attention");
  assert.equal(summary.closed, 1);
  assert.deepEqual(summary.attention_reasons, ["cursor_required_but_missing_after_full_window"]);
});

test("workflow utilities flag operator-action skips when every result is blocked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "skipped_changed_since_review" },
      {
        number: 20,
        action: "skipped_pr_close_coverage_proof",
        reason: "close proof kept this open; updated durable Codex review comment",
      },
      { number: 30, action: "skipped_maintainer_authored" },
      { number: 40, action: "skipped_invalid_decision" },
      { number: 50, action: "skipped_open_closing_pr" },
      { number: 60, action: "skipped_same_author_pair" },
      { number: 70, action: "skipped_protected_label" },
      { number: 80, action: "skipped_already_closed" },
      {
        number: 90,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      },
      {
        number: 100,
        action: "retry_pr_close_coverage_proof",
        reason: "linked canonical PR changed after coverage proof",
      },
    ]),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 5,
    cursorRequired: false,
  });

  assert.equal(summary.status, "needs_attention");
  assert.equal(summary.comment_synced, 1);
  assert.deepEqual(summary.attention_reasons, [
    "kept_open",
    "retry_pr_close_coverage_proof",
    "skipped_changed_since_review",
    "skipped_invalid_decision",
    "skipped_maintainer_authored",
    "skipped_open_closing_pr",
    "skipped_pr_close_coverage_proof",
    "skipped_protected_label",
    "skipped_same_author_pair",
  ]);
  assert.equal(summary.lanes.closure.skipped, 10);
  assert.equal(summary.lanes.closure.comment_synced, 1);
  assert.equal(summary.lanes.closure.skip_reasons.kept_open, 1);
  assert.equal(summary.lanes.closure.skip_reasons.retry_pr_close_coverage_proof, 1);
  assert.equal(summary.lanes.closure.skip_reasons.skipped_pr_close_coverage_proof, 1);
});

test("workflow utilities keep all-benign skip windows quiet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");
  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "skipped_already_closed" },
      { number: 20, action: "skipped_not_open" },
      { number: 30, action: "kept_open", reason: "synced ClawSweeper labels" },
    ]),
  );

  const summary = summarizeApplyReport({
    reportPath,
    targetRepo: "openclaw/openclaw",
    mode: "close",
    processedLimit: 300,
    closeLimit: 5,
    cursorRequired: false,
  });

  assert.equal(summary.status, "ok");
  assert.equal(summary.skipped, 2);
  assert.deepEqual(summary.skip_reasons, {
    skipped_already_closed: 1,
    skipped_not_open: 1,
  });
  assert.equal(summary.lanes.closure.skipped, 2);
  assert.deepEqual(summary.lanes.closure.skip_reasons, {
    skipped_already_closed: 1,
    skipped_not_open: 1,
  });
  assert.deepEqual(summary.attention_reasons, []);
});

test("workflow utilities count nested command actions by status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const report = path.join(root, "comment-router-latest.json");
  write(
    report,
    JSON.stringify({
      commands: [
        {
          actions: [
            { action: "dispatch_repair", status: "waiting" },
            { action: "dispatch_repair", status: "active" },
            { action: "dispatch_repair", status: "executed" },
          ],
        },
        {
          actions: [{ action: "dispatch_clawsweeper", status: "waiting" }],
        },
      ],
    }),
  );

  assert.equal(countCommandActions(report, "dispatch_repair"), 3);
  assert.equal(countCommandActions(report, "dispatch_repair", "waiting"), 1);
  assert.equal(countCommandActions(report, "dispatch_repair", "waiting,active"), 2);
  assert.equal(countCommandActions(report, "dispatch_clawsweeper", "waiting"), 1);
});

test("workflow utilities count repair results that require requeue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  write(
    path.join(root, "runs/a/result.json"),
    JSON.stringify({
      actions: [
        { action: "repair_contributor_branch", status: "blocked", requeue_required: true },
        { action: "automerge_repair_outcome_comment", status: "updated" },
      ],
    }),
  );
  write(
    path.join(root, "runs/b/result.json"),
    JSON.stringify({ actions: [{ action: "repair_contributor_branch", status: "pushed" }] }),
  );
  write(
    path.join(root, "runs/c/apply-report.json"),
    JSON.stringify({
      actions: [{ action: "close_duplicate", status: "blocked", requeue_required: true }],
    }),
  );

  assert.equal(countRequeueRequired(path.join(root, "runs")), 2);
});

test("workflow utilities merge checkpoint reports in numeric order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reports = path.join(root, "reports");
  write(path.join(reports, "apply-report-10.json"), JSON.stringify([{ action: "tenth" }]));
  write(path.join(reports, "apply-report-2.json"), JSON.stringify([{ action: "second" }]));

  const output = path.join(root, "combined.json");
  mergeApplyReports(reports, output);

  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), [
    { action: "second" },
    { action: "tenth" },
  ]);
});

test("workflow utilities expose planned item numbers for recovery dispatches", () => {
  assert.equal(
    plannedItemNumberCsv({
      candidates: [{ number: 42 }, { number: "7" }, { number: 0 }, { title: "missing" }],
    }),
    "42,7",
  );
});

test("workflow utilities expose review capacity telemetry from plans", () => {
  assert.deepEqual(
    planOutputFields(
      {
        capacity: 300,
        candidates: [{ number: 42 }, { number: 43 }],
        matrix: [{ shard: 0, item_numbers: "42,43" }],
        activeCodexTarget: 1,
        dueBacklog: 17,
        oldestUnreviewedAt: "2026-01-01T00:00:00Z",
        capacityReason: "under capacity: due backlog below planned capacity",
      },
      { batchSize: 3, shardCount: 100 },
    ),
    {
      matrix: JSON.stringify([{ shard: 0, item_numbers: "42,43" }]),
      planned_count: "2",
      planned_capacity: "300",
      planned_item_numbers: "42,43",
      planned_shards: "1",
      active_codex_target: "1",
      due_backlog: "17",
      oldest_unreviewed_at: "2026-01-01T00:00:00Z",
      capacity_reason: "under capacity: due backlog below planned capacity",
    },
  );
});

test("workflow utilities expand automatic apply scan after a skip-heavy zero-close window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const statusPath = path.join(root, "results/sweep-status/openclaw-openclaw.json");
  write(
    statusPath,
    JSON.stringify({
      apply_health: {
        mode: "close",
        cursor_required: true,
        processed: 300,
        processed_limit: 300,
        closed: 0,
        skipped: 285,
        attention_reasons: ["skipped_changed_since_review"],
      },
    }),
  );

  const result = adaptiveApplyBatchSize({ statusPath, baseSize: 300, maxSize: 900 });

  assert.equal(result.closeProcessedLimit, 600);
  assert.equal(result.adaptive, true);
  assert.equal(result.reason, "previous_full_zero_close_skip_window");
  assert.equal(result.previousProcessed, 300);
  assert.equal(result.previousSkipped, 285);
});

test("workflow utilities use preserved close health after comment-sync status updates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const statusPath = path.join(root, "results/sweep-status/openclaw-openclaw.json");
  write(
    statusPath,
    JSON.stringify({
      apply_health: {
        mode: "comment_sync",
        cursor_required: true,
        processed: 25,
        processed_limit: 25,
        closed: 0,
        skipped: 0,
        attention_reasons: [],
      },
      last_close_apply_health: {
        mode: "close",
        cursor_required: true,
        processed: 300,
        processed_limit: 300,
        closed: 0,
        skipped: 300,
        attention_reasons: ["skipped_changed_since_review"],
      },
    }),
  );

  const result = adaptiveApplyBatchSize({ statusPath, baseSize: 300, maxSize: 900 });

  assert.equal(result.closeProcessedLimit, 600);
  assert.equal(result.adaptive, true);
  assert.equal(result.previousProcessed, 300);
});

test("workflow utilities cap adaptive apply scan and reset on productive or unsafe windows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const statusPath = path.join(root, "results/sweep-status/openclaw-openclaw.json");
  const size = () => adaptiveApplyBatchSize({ statusPath, baseSize: 300, maxSize: 900 });

  write(
    statusPath,
    JSON.stringify({
      apply_health: {
        mode: "close",
        cursor_required: true,
        processed: 600,
        processed_limit: 600,
        closed: 0,
        skipped: 600,
        attention_reasons: ["skipped_protected_label"],
      },
    }),
  );
  assert.equal(size().closeProcessedLimit, 900);

  write(
    statusPath,
    JSON.stringify({
      apply_health: {
        mode: "close",
        cursor_required: true,
        processed: 300,
        processed_limit: 300,
        closed: 1,
        skipped: 299,
        attention_reasons: [],
      },
    }),
  );
  assert.deepEqual(
    { limit: size().closeProcessedLimit, reason: size().reason, adaptive: size().adaptive },
    { limit: 300, reason: "base_window", adaptive: false },
  );

  write(
    statusPath,
    JSON.stringify({
      apply_health: {
        mode: "close",
        cursor_required: true,
        processed: 300,
        processed_limit: 300,
        closed: 0,
        skipped: 300,
        attention_reasons: ["skipped_live_fetch_failed"],
      },
    }),
  );
  assert.deepEqual(
    { limit: size().closeProcessedLimit, reason: size().reason, adaptive: size().adaptive },
    { limit: 300, reason: "base_window", adaptive: false },
  );

  assert.equal(
    adaptiveApplyBatchSize({
      statusPath: path.join(root, "missing.json"),
      baseSize: 300,
      maxSize: 900,
    }).closeProcessedLimit,
    300,
  );
});

test("workflow utilities select eligible proposed close records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  for (const [number, type, action, reason, createdAt = oldDate] of [
    [5, "issue", "proposed_close", "implemented_on_main"],
    [9, "pull_request", "proposed_close", "stale_insufficient_info"],
    [12, "pull_request", "proposed_close", "mostly_implemented_on_main"],
    [13, "issue", "proposed_close", "mostly_implemented_on_main"],
    [14, "pull_request", "proposed_close", "mostly_implemented_on_main", new Date().toISOString()],
    [15, "pull_request", "proposed_close", "low_signal_unmergeable_pr"],
    [16, "issue", "proposed_close", "low_signal_unmergeable_pr"],
    [17, "pull_request", "retry_pr_close_coverage_proof", "duplicate_or_superseded"],
    [18, "pull_request", "kept_open", "duplicate_or_superseded"],
    [19, "pull_request", "skipped_pr_close_coverage_proof", "duplicate_or_superseded"],
    [26, "pull_request", "skipped_same_author_pair", "duplicate_or_superseded"],
    [27, "issue", "skipped_open_closing_pr", "implemented_on_main"],
    [28, "pull_request", "skipped_invalid_decision", "duplicate_or_superseded"],
    [29, "pull_request", "skipped_maintainer_authored", "duplicate_or_superseded"],
    [30, "issue", "skipped_invalid_decision", "implemented_on_main"],
    [31, "issue", "skipped_maintainer_authored", "implemented_on_main"],
    [36, "pull_request", "skipped_low_signal_live_guard", "low_signal_unmergeable_pr"],
    [37, "issue", "skipped_protected_label", "implemented_on_main"],
    [38, "pull_request", "skipped_close_exempt_label", "stalled_unproven_pr"],
    [39, "issue", "skipped_locked_conversation", "clawhub"],
  ] satisfies [number, string, string, string, string?][]) {
    writeProposedRecord(root, number, type, action, reason, createdAt);
  }
  for (const [number, fields, createdAt = oldDate] of [
    [20, []],
    [
      21,
      [
        `work_cluster_refs: ${JSON.stringify(["Superseded by https://github.com/openclaw/openclaw/pull/400"])}`,
      ],
    ],
    [22, ["pr_rating_overall: F", "pr_rating_proof: F"]],
    [24, [`work_cluster_refs: ${JSON.stringify(["Superseded by openclaw/openclaw#400"])}`]],
    [25, [`work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`]],
    [23, ["pr_rating_overall: F"], new Date().toISOString()],
    [
      32,
      [
        "pr_rating_overall: F",
        "pr_rating_proof: F",
        `work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`,
      ],
    ],
    [33, ["pr_rating_overall: B", "pr_rating_proof: F", "real_behavior_proof_status: missing"]],
    [34, ["pr_rating_overall: F", "pr_rating_proof: A", "real_behavior_proof_status: sufficient"]],
    [
      35,
      ["pr_rating_overall: F", "pr_rating_proof: A", "real_behavior_proof_status: insufficient"],
    ],
  ] satisfies [number, string[], string?][]) {
    write(
      path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
      [
        "---",
        "repository: openclaw/openclaw",
        "type: pull_request",
        "decision: keep_open",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "action_taken: kept_open",
        "close_reason: none",
        `item_created_at: ${createdAt}`,
        ...fields,
        "---",
        "",
      ].join("\n"),
    );
  }

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.deepEqual(
    selected,
    [5, 12, 15, 17, 18, 21, 22, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
  );
  assert.deepEqual(
    withCwd(root, () =>
      proposedItemNumbers({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        applyCloseReasons: "low_signal_unmergeable_pr",
        staleMinAgeDays: 60,
        minAgeDays: 0,
        minAgeMinutes: null,
      }),
    ),
    [15, 22, 32, 35, 36],
  );
  assert.deepEqual(
    withCwd(root, () =>
      proposedItemNumbers({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        applyCloseReasons: "duplicate_or_superseded",
        staleMinAgeDays: 60,
        minAgeDays: 0,
        minAgeMinutes: null,
      }),
    ),
    [17, 18, 21, 24, 25, 26, 32],
  );
  assert.deepEqual(
    withCwd(root, () =>
      proposedPrCloseCoverageItemNumbers({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        applyCloseReasons: "low_signal_unmergeable_pr",
        staleMinAgeDays: 60,
        minAgeDays: 0,
        minAgeMinutes: null,
      }),
    ),
    [],
  );
});

test("workflow utilities allow ClawHub implemented-on-main issue proposals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  write(
    path.join(root, "records/openclaw-clawhub/items/openclaw-clawhub-7.md"),
    [
      "---",
      "repository: openclaw/clawhub",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: implemented_on_main",
      "item_created_at: 2024-01-01T00:00:00Z",
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-clawhub/items/openclaw-clawhub-8.md"),
    [
      "---",
      "repository: openclaw/clawhub",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: duplicate_or_superseded",
      "item_created_at: 2024-01-01T00:00:00Z",
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-clawhub/items/openclaw-clawhub-9.md"),
    [
      "---",
      "repository: openclaw/clawhub",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      "item_created_at: 2024-01-01T00:00:00Z",
      "---",
      "",
    ].join("\n"),
  );

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/clawhub",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.deepEqual(selected, [7]);
});

test("workflow utilities summarize proposed close candidate quality buckets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  writeProposedRecord(root, 5, "issue", "proposed_close", "implemented_on_main", oldDate);
  writeProposedRecord(root, 6, "issue", "proposed_close", "duplicate_or_superseded", oldDate);
  writeProposedRecord(
    root,
    7,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
  );
  writeProposedRecord(root, 8, "issue", "proposed_close", "stale_insufficient_info", oldDate);
  writeProposedRecord(
    root,
    9,
    "pull_request",
    "proposed_close",
    "unconfirmed_product_direction",
    oldDate,
  );
  writeProposedRecord(
    root,
    10,
    "issue",
    "skipped_invalid_decision",
    "implemented_on_main",
    oldDate,
  );
  writeProposedRecord(root, 11, "pull_request", "proposed_close", "stalled_unproven_pr", oldDate);
  writeProposedRecord(root, 12, "pull_request", "proposed_close", "abandoned_pr", oldDate);
  writeProposedRecord(root, 13, "issue", "proposed_close", "stalled_unproven_pr", oldDate);
  writeProposedRecord(root, 14, "issue", "proposed_close", "abandoned_pr", oldDate);
  writeProposedRecord(root, 15, "issue", "skipped_protected_label", "implemented_on_main", oldDate);
  writeProposedRecord(
    root,
    16,
    "pull_request",
    "skipped_close_exempt_label",
    "stalled_unproven_pr",
    oldDate,
  );
  writeProposedRecord(root, 17, "issue", "skipped_locked_conversation", "clawhub", oldDate);

  const summary = withCwd(root, () =>
    proposedItemQualitySummary({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.equal(summary.total, 11);
  assert.deepEqual(selected, [5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17]);
  assert.equal(
    summary.summary,
    "1 implemented-on-main, 1 duplicate/superseded, 1 needs PR close proof, 3 aging/low-signal, 1 policy-sensitive, 4 retry after guard skip",
  );
  assert.deepEqual(
    summary.buckets.map((bucket) => [bucket.bucket, bucket.count]),
    [
      ["ready_implemented", 1],
      ["duplicate_or_superseded", 1],
      ["needs_pr_close_coverage", 1],
      ["aging_or_low_signal", 3],
      ["policy_sensitive", 1],
      ["retry_after_guard_skip", 4],
    ],
  );
  assert.match(summary.buckets[2]?.next_step ?? "", /close-coverage proof/);
});

test("workflow utilities select proposed PR closes that can need coverage proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  writeProposedRecord(root, 5, "issue", "proposed_close", "implemented_on_main", oldDate);
  writeProposedRecord(
    root,
    6,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
  );
  writeProposedRecord(root, 7, "issue", "proposed_close", "duplicate_or_superseded", oldDate);
  writeProposedRecord(
    root,
    8,
    "pull_request",
    "retry_pr_close_coverage_proof",
    "duplicate_or_superseded",
    oldDate,
  );
  writeProposedRecord(
    root,
    9,
    "pull_request",
    "proposed_close",
    "low_signal_unmergeable_pr",
    oldDate,
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-10.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      `work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-11.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      `work_cluster_refs: ${JSON.stringify(["Superseded by [PR #400](https://github.com/other/repo/pull/400)"])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-12.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      `merge_risk_options: ${JSON.stringify([
        {
          category: "pause_or_close",
          recommended: true,
          title: "Pause or close",
          body: "No replacement PR is identified.",
        },
      ])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-13.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      "pr_rating_overall: F",
      "pr_rating_proof: F",
      "---",
      "",
    ].join("\n"),
  );

  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
  };

  assert.deepEqual(
    withCwd(root, () => proposedPrCloseCoverageItemNumbers(options)),
    [6, 8, 10],
  );
  assert.deepEqual(
    withCwd(root, () =>
      proposedPrCloseCoverageItemNumbers({
        ...options,
        itemNumbers: new Set([5, 6]),
      }),
    ),
    [6],
  );
  assert.deepEqual(
    withCwd(root, () =>
      proposedPrCloseCoverageItemNumbers({
        ...options,
        applyCloseReasons: "implemented_on_main",
      }),
    ),
    [],
  );
});

test("workflow utilities select gated product-direction PR close proposals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  writeProposedRecord(
    root,
    7,
    "pull_request",
    "proposed_close",
    "unconfirmed_product_direction",
    oldDate,
  );
  writeProposedRecord(root, 8, "issue", "proposed_close", "unconfirmed_product_direction", oldDate);

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.deepEqual(selected, [7]);
  assert.deepEqual(
    withCwd(root, () =>
      proposedPrCloseCoverageItemNumbers({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        applyCloseReasons: "all",
        staleMinAgeDays: 60,
        minAgeDays: 0,
        minAgeMinutes: null,
      }),
    ),
    [],
  );
});

test("workflow utilities select apply-side author-budget promotion probes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-15.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      "item_created_at: 2026-01-01T00:00:00Z",
      "pr_rating_overall: D",
      "real_behavior_proof_status: missing",
      "---",
      "",
    ].join("\n"),
  );

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/openclaw",
      applyKind: "pull_request",
      applyCloseReasons: "author_pr_budget_exceeded",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.deepEqual(selected, [15]);
});

test("workflow utilities rotate bounded apply candidate batches by apply cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  writeProposedRecord(root, 10, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-02T00:00:00Z",
  });
  writeProposedRecord(root, 20, "issue", "proposed_close", "implemented_on_main", oldDate);
  writeProposedRecord(root, 30, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-01T00:00:00Z",
  });
  writeProposedRecord(root, 40, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-03T00:00:00Z",
  });
  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 2,
    cursorPath,
  };

  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [20, 30],
  );
  write(
    cursorPath,
    JSON.stringify({ next_after_number: 30, next_after_apply_checked_at: "2026-01-01T00:00:00Z" }),
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [10, 40],
  );
  write(
    cursorPath,
    JSON.stringify({ next_after_number: 40, next_after_apply_checked_at: "2026-01-03T00:00:00Z" }),
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [20, 30],
  );
});

test("workflow utilities run a bounded confirmed prefix before proof and defer promotion probes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  writeProposedRecord(
    root,
    10,
    "pull_request",
    "proposed_close",
    "unconfirmed_product_direction",
    oldDate,
  );
  writeProposedRecord(root, 20, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-01T00:00:00Z",
  });
  writeProposedRecord(root, 30, "issue", "proposed_close", "duplicate_or_superseded", oldDate);
  writeProposedRecord(
    root,
    35,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
  );
  writeProposedRecord(root, 40, "pull_request", "proposed_close", "stalled_unproven_pr", oldDate);
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-50.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      "pr_rating_overall: F",
      "pr_rating_proof: F",
      "---",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    withCwd(root, () =>
      proposedItemNumbers({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        applyCloseReasons: "all",
        staleMinAgeDays: 60,
        minAgeDays: 0,
        minAgeMinutes: null,
        batchSize: 5,
        coverageProofLimit: 1,
      }),
    ),
    [20, 30, 35, 40, 10],
  );
  assert.deepEqual(
    withCwd(root, () =>
      proposedItemNumbers({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        applyCloseReasons: "all",
        staleMinAgeDays: 60,
        minAgeDays: 0,
        minAgeMinutes: null,
        batchSize: 6,
        closeLimit: 4,
        coverageProofLimit: 1,
      }),
    ),
    [20, 35, 30, 40, 10, 50],
  );
});

test("workflow utilities backfill promotion probes after confirmed close proposals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  writeProposedRecord(root, 30, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-01T00:00:00Z",
  });
  for (const [number, applyCheckedAt] of [
    [10, "2026-01-02T00:00:00Z"],
    [20, "2026-01-04T00:00:00Z"],
  ]) {
    write(
      path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
      [
        "---",
        "repository: openclaw/openclaw",
        "type: pull_request",
        "decision: keep_open",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "action_taken: kept_open",
        "close_reason: none",
        `item_created_at: ${oldDate}`,
        `apply_checked_at: ${applyCheckedAt}`,
        "pr_rating_overall: F",
        "pr_rating_proof: F",
        "---",
        "",
      ].join("\n"),
    );
  }
  write(
    cursorPath,
    JSON.stringify({ next_after_number: 10, next_after_apply_checked_at: "2026-01-02T00:00:00Z" }),
  );
  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 2,
    cursorPath,
  };

  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [30, 20],
  );
  const summary = withCwd(root, () => proposedItemQualitySummary(options));
  assert.deepEqual(
    summary.buckets.map((bucket) => [bucket.bucket, bucket.count]),
    [
      ["ready_implemented", 1],
      ["promotion_probe", 1],
    ],
  );
});

test("workflow utilities cool down recently examined promotion probes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const promotionRecord = (number, applyCheckedAt, coverageProof = false, reviewedAt = "") =>
    write(
      path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
      [
        "---",
        "repository: openclaw/openclaw",
        "type: pull_request",
        "decision: keep_open",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "action_taken: kept_open",
        "close_reason: none",
        `item_created_at: ${oldDate}`,
        `apply_checked_at: ${applyCheckedAt}`,
        ...(reviewedAt ? [`reviewed_at: ${reviewedAt}`] : []),
        ...(coverageProof
          ? [`work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`]
          : ["pr_rating_overall: F", "pr_rating_proof: F"]),
        "---",
        "",
      ].join("\n"),
    );
  promotionRecord(10, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  promotionRecord(20, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  promotionRecord(30, new Date(Date.now() - 60 * 60 * 1000).toISOString(), true);
  promotionRecord(40, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), true);
  promotionRecord(
    50,
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    false,
    new Date().toISOString(),
  );

  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 10,
    coverageProofLimit: 1,
  };

  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [40, 20, 50],
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers({ ...options, itemNumbers: new Set([10]) })),
    [10],
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemQualitySummary(options)).buckets.map((bucket) => [
      bucket.bucket,
      bucket.count,
    ]),
    [["promotion_probe", 3]],
  );
});

test("workflow utilities report truthful eligible inventory across cursor and promotion cooldown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  writeProposedRecord(root, 10, "issue", "proposed_close", "implemented_on_main", oldDate);
  writeProposedRecord(root, 20, "issue", "skipped_open_closing_pr", "implemented_on_main", oldDate);
  writeProposedRecord(
    root,
    30,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
  );
  const writePromotion = (number, applyCheckedAt) =>
    write(
      path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
      [
        "---",
        "repository: openclaw/openclaw",
        "type: pull_request",
        "decision: keep_open",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "action_taken: kept_open",
        "close_reason: none",
        `item_created_at: ${oldDate}`,
        `apply_checked_at: ${applyCheckedAt}`,
        "pr_rating_overall: F",
        "pr_rating_proof: F",
        "---",
        "",
      ].join("\n"),
    );
  writePromotion(40, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  writePromotion(50, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-60.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: keep_open",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 30,
      next_after_apply_checked_at: "2026-01-01T00:00:00Z",
    }),
  );
  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 10,
    closeLimit: 4,
    coverageProofLimit: 1,
    cursorPath,
  };

  const inventory = withCwd(root, () => proposedItemInventory(options));
  assert.deepEqual(inventory, {
    eligible_total: 4,
    confirmed_proposal: 2,
    guarded_retry: 1,
    proof_required: 1,
    promotion_total: 2,
    promotion_eligible: 1,
    promotion_cooldown_eligible: 1,
    cooldown_eligible_total: 4,
    inconsistent_or_stale: 1,
  });
  assert.equal(
    withCwd(root, () => proposedItemCount(options)),
    4,
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [10, 30, 20, 40],
  );
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 50,
      next_after_apply_checked_at: new Date().toISOString(),
    }),
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemInventory(options)),
    inventory,
    "cursor rotation changes ordering, not truthful eligible counts",
  );
});

test("workflow utilities do not call policy- or age-excluded proposals inconsistent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const youngDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const staleGateDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  writeProposedRecord(root, 10, "issue", "proposed_close", "implemented_on_main", oldDate);
  writeProposedRecord(root, 20, "issue", "proposed_close", "duplicate_or_superseded", oldDate);
  writeProposedRecord(root, 30, "issue", "proposed_close", "implemented_on_main", youngDate);
  writeProposedRecord(
    root,
    40,
    "issue",
    "proposed_close",
    "stale_insufficient_info",
    staleGateDate,
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-50.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: keep_open",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );

  const inventory = withCwd(root, () =>
    proposedItemInventory({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "implemented_on_main,stale_insufficient_info",
      staleMinAgeDays: 60,
      minAgeDays: 30,
      minAgeMinutes: null,
      batchSize: 20,
      closeLimit: 20,
      coverageProofLimit: 2,
    }),
  );

  assert.equal(inventory.eligible_total, 1);
  assert.equal(inventory.confirmed_proposal, 1);
  assert.equal(inventory.inconsistent_or_stale, 1);
});

test("workflow utilities use spare proof capacity to rotate promotion probes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  writeProposedRecord(root, 10, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-01T00:00:00Z",
  });
  writeProposedRecord(root, 20, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-02T00:00:00Z",
  });
  writeProposedRecord(root, 30, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-03T00:00:00Z",
  });
  writeProposedRecord(
    root,
    40,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
    { applyCheckedAt: "2026-01-01T00:00:00Z" },
  );
  for (const [number, applyCheckedAt] of [
    [50, "2026-01-02T00:00:00Z"],
    [60, "2026-01-03T00:00:00Z"],
    [70, "2026-01-04T00:00:00Z"],
  ]) {
    write(
      path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
      [
        "---",
        "repository: openclaw/openclaw",
        "type: pull_request",
        "decision: keep_open",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "action_taken: kept_open",
        "close_reason: none",
        `item_created_at: ${oldDate}`,
        `apply_checked_at: ${applyCheckedAt}`,
        `work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`,
        "---",
        "",
      ].join("\n"),
    );
  }
  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 4,
    coverageProofLimit: 2,
    cursorPath,
  };

  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [40, 50, 10, 20],
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers({ ...options, closeLimit: 1 })),
    [40, 10, 20, 30],
  );
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 20,
      next_after_apply_checked_at: "2026-01-02T00:00:00Z",
      coverage_proof_cursor: {
        next_after_number: 50,
        next_after_apply_checked_at: "2026-01-02T00:00:00Z",
      },
    }),
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [40, 60, 30, 10],
  );

  writeProposedRecord(
    root,
    45,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
    { applyCheckedAt: "2026-01-01T12:00:00Z" },
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [40, 45, 30, 10],
  );
});

test("workflow utilities persist apply cursor from processed or selected items", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  const reportPath = path.join(root, "apply-report.json");
  const oldDate = "2024-01-01T00:00:00Z";
  writeProposedRecord(root, 10, "issue", "proposed_close", "implemented_on_main", oldDate);
  writeProposedRecord(root, 20, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-02T00:00:00Z",
  });

  for (const [report, selected] of [
    [[{ number: 20, action: "kept_open" }], ""],
    [
      [
        { number: 20, action: "kept_open" },
        { number: 10, action: "closed" },
      ],
      "10,20",
    ],
    [[], "10,20"],
  ]) {
    write(reportPath, JSON.stringify(report));
    withCwd(root, () => writeApplyCursor(cursorPath, reportPath, "openclaw/openclaw", selected));
    const cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
    assert.deepEqual(
      [cursor.target_repo, cursor.next_after_number, cursor.next_after_apply_checked_at],
      ["openclaw/openclaw", 20, "2026-01-02T00:00:00Z"],
    );
  }
});

test("workflow utilities advance fast and coverage-proof cursors from the exact scan trace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  const reportPath = path.join(root, "apply-report.json");
  const tracePath = path.join(root, "apply-cursor-trace.json");
  const oldDate = "2024-01-01T00:00:00Z";
  writeProposedRecord(root, 10, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-01T00:00:00Z",
  });
  writeProposedRecord(root, 20, "issue", "proposed_close", "implemented_on_main", oldDate, {
    applyCheckedAt: "2026-01-02T00:00:00Z",
  });
  writeProposedRecord(
    root,
    30,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
    { applyCheckedAt: "2026-01-03T00:00:00Z" },
  );
  writeProposedRecord(
    root,
    40,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
    { applyCheckedAt: "2026-01-04T00:00:00Z" },
  );
  write(reportPath, JSON.stringify([{ number: 10, action: "kept_open" }]));
  write(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 30] }));

  withCwd(root, () =>
    writeApplyCursor(
      cursorPath,
      reportPath,
      "openclaw/openclaw",
      "10,20,30,40",
      "30,40",
      tracePath,
    ),
  );
  let cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.deepEqual(
    [
      cursor.next_after_number,
      cursor.next_after_apply_checked_at,
      cursor.coverage_proof_cursor.next_after_number,
      cursor.coverage_proof_cursor.next_after_apply_checked_at,
    ],
    [10, "2026-01-01T00:00:00Z", 30, "2026-01-03T00:00:00Z"],
  );
  assert.equal(applyCursorAdvanceCount(reportPath, "10,20,30,40", tracePath), 2);

  write(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [20] }));
  withCwd(root, () =>
    writeApplyCursor(cursorPath, reportPath, "openclaw/openclaw", "20,40", "40", tracePath),
  );
  cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.equal(cursor.next_after_number, 20);
  assert.equal(cursor.coverage_proof_cursor.next_after_number, 30);

  write(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [40] }));
  withCwd(root, () =>
    writeApplyCursor(cursorPath, reportPath, "openclaw/openclaw", "40", "40", tracePath),
  );
  cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.equal(cursor.next_after_number, 20);
  assert.equal(cursor.coverage_proof_cursor.next_after_number, 40);
});

test("runtime-budget cursor resumes the next candidate without rescanning the completed prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/apply-cursors/openclaw-openclaw.json");
  const reportPath = path.join(root, "apply-report.json");
  const tracePath = path.join(root, "apply-cursor-trace.json");
  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 5,
    cursorPath,
  };
  try {
    for (const [number, day] of [
      [10, "01"],
      [20, "02"],
      [30, "03"],
      [40, "04"],
      [50, "05"],
    ] as const) {
      writeProposedRecord(
        root,
        number,
        "issue",
        "proposed_close",
        "implemented_on_main",
        "2024-01-01T00:00:00Z",
        { applyCheckedAt: `2026-01-${day}T00:00:00Z` },
      );
    }
    assert.deepEqual(
      withCwd(root, () => proposedItemNumbers(options)),
      [10, 20, 30, 40, 50],
    );
    write(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));
    write(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }));

    withCwd(root, () =>
      writeApplyCursor(
        cursorPath,
        reportPath,
        "openclaw/openclaw",
        "10,20,30,40,50",
        "",
        tracePath,
      ),
    );

    assert.deepEqual(
      withCwd(root, () => proposedItemNumbers({ ...options, batchSize: 3 })),
      [30, 40, 50],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow utilities count records advanced by the apply cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reportPath = path.join(root, "apply-report.json");

  write(
    reportPath,
    JSON.stringify([
      { number: 10, action: "review_comment_synced" },
      { number: 10, action: "closed" },
      { number: 30, action: "skipped_changed_since_review" },
    ]),
  );
  assert.equal(applyCursorAdvanceCount(reportPath, "10,20,30,40"), 3);

  write(reportPath, "[]");
  assert.equal(applyCursorAdvanceCount(reportPath, "10,20,30,40"), 4);
});

test("workflow utilities select cursor-based PR comment sync batches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  writeCommentSyncRecord(root, 10, "pull_request", "kept_open");
  writeCommentSyncRecord(root, 20, "pull_request", "proposed_close");
  writeCommentSyncRecord(root, 30, "pull_request", "skipped_pr_close_coverage_proof");
  writeCommentSyncRecord(root, 34, "pull_request", "skipped_changed_since_review", {
    decision: "close",
    closeReason: "duplicate_or_superseded",
    reviewCommentId: "9034",
    reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/34#issuecomment-9034",
  });
  writeCommentSyncRecord(root, 35, "pull_request", "retry_stale_canonical_comment_sync");
  writeCommentSyncRecord(root, 39, "pull_request", "retry_pr_close_coverage_proof");
  writeCommentSyncRecord(root, 36, "pull_request", "corrected_stale_canonical_comment");
  writeCommentSyncRecord(root, 37, "pull_request", "skipped_changed_since_review", {
    decision: "close",
    closeReason: "low_signal_unmergeable_pr",
  });
  writeCommentSyncRecord(root, 38, "pull_request", "skipped_changed_since_review", {
    decision: "close",
    closeReason: "duplicate_or_superseded",
  });
  writeCommentSyncRecord(root, 40, "issue", "kept_open");
  writeCommentSyncRecord(root, 50, "pull_request", "reviewed");

  assert.deepEqual(
    withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "pull_request",
        batchSize: 2,
        cursorPath,
      }),
    ),
    {
      item_numbers: "10,20",
      count: "2",
      cursor: "0",
      next_cursor: "20",
      wrapped: "false",
    },
  );

  writeCommentSyncCursor(cursorPath, 20, "openclaw/openclaw");

  assert.deepEqual(
    withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "pull_request",
        batchSize: 10,
        cursorPath,
      }),
    ),
    {
      item_numbers: "30,34,35,39",
      count: "4",
      cursor: "20",
      next_cursor: "39",
      wrapped: "false",
    },
  );

  writeCommentSyncCursor(cursorPath, 99, "openclaw/openclaw");

  assert.deepEqual(
    withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "pull_request",
        batchSize: 2,
        cursorPath,
      }),
    ),
    {
      item_numbers: "10,20",
      count: "2",
      cursor: "99",
      next_cursor: "20",
      wrapped: "true",
    },
  );
});

test("durable all-item sync publishes guarded reviews without selecting terminal records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  try {
    writeCommentSyncRecord(root, 10, "issue", "kept_open");
    writeCommentSyncRecord(root, 20, "pull_request", "kept_open", {
      reviewCommentId: "9020",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/20#issuecomment-9020",
      reviewCommentHash: "a".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 30, "issue", "kept_open", {
      reviewCommentId: "9030",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/issues/30#issuecomment-9030",
      reviewCommentHash: "b".repeat(64),
      reviewedAt: fresh,
      reviewCommentSyncedAt: stale,
    });
    writeCommentSyncRecord(root, 40, "pull_request", "kept_open", {
      reviewCommentId: "9040",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/40#issuecomment-9040",
      reviewCommentHash: "c".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: stale,
    });
    writeCommentSyncRecord(root, 50, "pull_request", "retry_stale_canonical_comment_sync", {
      reviewCommentId: "9050",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/50#issuecomment-9050",
      reviewCommentHash: "d".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 60, "pull_request", "skipped_changed_since_review", {
      decision: "close",
      closeReason: "duplicate_or_superseded",
      reviewCommentId: "9060",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/60#issuecomment-9060",
      reviewCommentHash: "e".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 70, "pull_request", "kept_open", {
      reviewCommentId: "9070",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/70#issuecomment-9070",
      reviewCommentHash: "none",
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 80, "issue", "skipped_protected_label");
    writeCommentSyncRecord(root, 90, "pull_request", "skipped_maintainer_authored");
    writeCommentSyncRecord(root, 100, "pull_request", "skipped_close_exempt_label");
    writeCommentSyncRecord(root, 110, "issue", "skipped_invalid_decision");
    writeCommentSyncRecord(root, 120, "pull_request", "skipped_comment_auth");
    writeCommentSyncRecord(root, 130, "issue", "skipped_stale_review_comment_sync");
    writeCommentSyncRecord(root, 140, "issue", "skipped_low_signal_live_guard");
    writeCommentSyncRecord(root, 150, "pull_request", "kept_open", {
      reviewCommentId: "9150",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/150#issuecomment-9150",
      reviewCommentHash: "corrupt-comment-hash",
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 160, "issue", "kept_open", {
      reviewCommentId: "9160",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/issues/160#issuecomment-9160",
      reviewCommentHash: "f".repeat(64),
      reviewedAt: new Date(now - 30_000).toISOString(),
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 170, "pull_request", "kept_open", {
      reviewCommentId: "9170",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/170#issuecomment-9170",
      reviewCommentHash: "1".repeat(64),
      lastFullReviewAt: new Date(now - 30_000).toISOString(),
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 180, "pull_request", "kept_open", {
      reviewCommentId: "9180",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/180#issuecomment-9180",
      reviewCommentHash: "2".repeat(64),
      lastFullReviewAt: stale,
      reviewedAt: new Date(now - 30_000).toISOString(),
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 190, "pull_request", "kept_open", {
      reviewCommentId: "9190",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/190#issuecomment-9190",
      reviewCommentHash: "3".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
      pullHeadSha: "reviewed-head",
      currentPullHeadSha: "new-head",
    });
    writeCommentSyncRecord(root, 200, "issue", "skipped_protected_label", {
      reviewCommentId: "9200",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/issues/200#issuecomment-9200",
      reviewCommentHash: "4".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });
    writeCommentSyncRecord(root, 210, "pull_request", "skipped_maintainer_authored", {
      reviewCommentId: "9210",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/210#issuecomment-9210",
      reviewCommentHash: "5".repeat(64),
      reviewedAt: stale,
      reviewCommentSyncedAt: fresh,
    });

    assert.deepEqual(
      withCwd(root, () =>
        commentSyncBatchOutput({
          targetRepo: "openclaw/openclaw",
          applyKind: "all",
          batchSize: 20,
          cursorPath,
        }),
      ),
      {
        item_numbers: "10,160,170,180,30,70,150,20,40,50,60,80,90,100,110,190,210",
        count: "17",
        cursor: "0",
        next_cursor: "210",
        wrapped: "false",
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automatic comment sync publishes failed reviews and rechecks guarded PR heads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const now = Date.now();
  const reviewedAt = new Date(now - 30 * 60 * 1000).toISOString();
  const syncedAt = new Date(now - 60 * 60 * 1000).toISOString();
  try {
    writeCommentSyncRecord(root, 101, "pull_request", "kept_open", {
      reviewStatus: "failed",
      reviewCommentId: "9101",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/101#issuecomment-9101",
      reviewCommentHash: "a".repeat(64),
      reviewedAt,
      reviewCommentSyncedAt: syncedAt,
    });
    writeCommentSyncRecord(root, 102, "pull_request", "skipped_protected_label", {
      reviewCommentId: "9102",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/102#issuecomment-9102",
      reviewCommentHash: "b".repeat(64),
      reviewedAt,
      reviewCommentSyncedAt: syncedAt,
      pullHeadSha: "reviewed-head",
      currentPullHeadSha: "new-head",
    });
    writeCommentSyncRecord(root, 103, "issue", "skipped_protected_label", {
      reviewCommentId: "9103",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/issues/103#issuecomment-9103",
      reviewCommentHash: "c".repeat(64),
      reviewedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      reviewCommentSyncedAt: syncedAt,
    });
    const result = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      }),
    );
    assert.deepEqual(result.item_numbers.split(",").map(Number), [101, 102]);
    const failedRecord = path.join(
      root,
      "records/openclaw-openclaw/items/openclaw-openclaw-101.md",
    );
    fs.writeFileSync(
      failedRecord,
      fs
        .readFileSync(failedRecord, "utf8")
        .replace(/^---\n/, `---\nreview_comment_checked_at: ${new Date(now).toISOString()}\n`),
    );
    const afterPublication = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      }),
    );
    assert.deepEqual(afterPublication.item_numbers.split(",").map(Number), [102]);
    const overdue = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      failedRecord,
      fs
        .readFileSync(failedRecord, "utf8")
        .replace(/^review_comment_synced_at:.*$/m, `review_comment_synced_at: ${overdue}`)
        .replace(/^review_comment_checked_at:.*$/m, `review_comment_checked_at: ${overdue}`)
        .replace(/^reviewed_at:.*$/m, `reviewed_at: ${overdue}`),
    );
    for (const [number, action] of [
      [104, "skipped_protected_label"],
      [105, "skipped_maintainer_authored"],
    ] as const) {
      writeCommentSyncRecord(root, number, "issue", action, {
        reviewStatus: "failed",
        reviewCommentId: String(9_000 + number),
        reviewCommentUrl: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "d".repeat(64),
        reviewedAt: overdue,
        reviewCommentSyncedAt: overdue,
      });
    }
    const afterMaintenanceInterval = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      }),
    );
    assert.deepEqual(
      afterMaintenanceInterval.item_numbers
        .split(",")
        .map(Number)
        .sort((left, right) => left - right),
      [101, 102, 104, 105],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checked-only comments and failed durable repairs remain eligible until synchronized", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const checkedAt = new Date().toISOString();
  try {
    for (const [number, type, action, status] of [
      [201, "issue", "kept_open", "complete"],
      [202, "issue", "skipped_protected_label", "complete"],
      [203, "pull_request", "kept_open", "failed"],
      [204, "pull_request", "retry_stale_canonical_comment_sync", "failed"],
    ] as const) {
      writeCommentSyncRecord(root, number, type, action, {
        reviewStatus: status,
        reviewCommentId: String(9_000 + number),
        reviewCommentUrl: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt: "2020-01-01T00:00:00Z",
        ...(number === 204 ? { reviewCommentSyncedAt: checkedAt } : {}),
      });
      const reportPath = path.join(
        root,
        `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`,
      );
      fs.writeFileSync(
        reportPath,
        fs
          .readFileSync(reportPath, "utf8")
          .replace(/^---\n/, `---\nreview_comment_checked_at: ${checkedAt}\n`),
      );
    }
    writeCommentSyncRecord(root, 500, "pull_request", "kept_open", {
      reviewCommentId: "9500",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/500#issuecomment-9500",
      reviewCommentHash: "a".repeat(64),
      reviewedAt: "2020-01-01T00:00:00Z",
      reviewCommentSyncedAt: checkedAt,
    });
    writeCommentSyncCursor(cursorPath, 250, "openclaw/openclaw");
    assert.equal(
      withCwd(root, () =>
        commentSyncBatchOutput({
          targetRepo: "openclaw/openclaw",
          applyKind: "all",
          batchSize: 1,
          cursorPath,
        }),
      ).item_numbers,
      "201",
    );
    writeCommentSyncCursor(cursorPath, 0, "openclaw/openclaw");
    const select = () =>
      withCwd(root, () =>
        commentSyncBatchOutput({
          targetRepo: "openclaw/openclaw",
          applyKind: "all",
          batchSize: 40,
          cursorPath,
        }),
      )
        .item_numbers.split(",")
        .filter(Boolean)
        .map(Number);
    assert.deepEqual(select(), [204, 201, 202, 203, 500]);
    for (const number of [201, 202, 203]) {
      const reportPath = path.join(
        root,
        `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`,
      );
      fs.writeFileSync(
        reportPath,
        fs
          .readFileSync(reportPath, "utf8")
          .replace(/^---\n/, `---\nreview_comment_synced_at: ${checkedAt}\n`),
      );
    }
    assert.deepEqual(select(), [204, 500]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refreshed and timestamp-less guarded reviews cross an existing automatic cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const now = Date.now();
  const syncedAt = new Date(now - 60_000).toISOString();
  try {
    for (let number = 101; number <= 140; number += 1) {
      writeCommentSyncRecord(root, number, "pull_request", "kept_open", {
        reviewCommentId: `${9_000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt: syncedAt,
        reviewCommentSyncedAt: syncedAt,
      });
    }
    for (const { number, action, reviewedAt, reviewCommentSyncedAt } of [
      {
        number: 5,
        action: "skipped_protected_label",
        reviewedAt: new Date(now - 10_000).toISOString(),
        reviewCommentSyncedAt: syncedAt,
      },
      {
        number: 6,
        action: "skipped_maintainer_authored",
        reviewedAt: new Date(now - 30_000).toISOString(),
      },
      {
        number: 7,
        action: "skipped_close_exempt_label",
        reviewedAt: new Date(now - 20_000).toISOString(),
        reviewCommentSyncedAt: "not-a-timestamp",
      },
    ]) {
      writeCommentSyncRecord(root, number, "issue", action, {
        reviewCommentId: `${9_000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "b".repeat(64),
        reviewedAt,
        reviewCommentSyncedAt,
      });
    }
    writeCommentSyncCursor(cursorPath, 100, "openclaw/openclaw");

    const result = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      }),
    );
    const selected = result.item_numbers.split(",").map(Number);

    assert.deepEqual(selected.slice(0, 4), [101, 5, 7, 6]);
    assert.equal(selected.length, 40);
    assert.equal(result.next_cursor, "137");
    assert.equal(result.wrapped, "false");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-sync guarded action changes return to the durable comment queue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  try {
    for (const [number, actionTaken, applyCheckedAt] of [
      [10, "skipped_protected_label", "2026-08-02T00:00:00Z"],
      [20, "skipped_maintainer_authored", "2026-08-02T00:00:00Z"],
      [30, "skipped_close_exempt_label", "2026-08-02T00:00:00Z"],
      [40, "skipped_protected_label", "2026-08-01T00:30:00Z"],
    ] as const) {
      writeCommentSyncRecord(root, number, "pull_request", actionTaken, {
        reviewCommentId: String(9_000 + number),
        reviewCommentUrl: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt: "2026-08-01T00:00:00Z",
        reviewCommentSyncedAt: "2026-08-01T01:00:00Z",
        applyCheckedAt,
      });
    }

    const result = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      }),
    );

    assert.equal(result.item_numbers, "40,10,20,30");
    assert.equal(result.count, "4");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid decisions never enqueue close reasons forbidden by their target repository", () => {
  for (const { targetRepo, expected } of [
    { targetRepo: "openclaw/openclaw", expected: "1,2,3" },
    { targetRepo: "openclaw/clawhub", expected: "2,3" },
    { targetRepo: "openclaw/clawsweeper", expected: "2,3" },
    { targetRepo: "steipete/tool.v2_debug", expected: "3" },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
    const targetSlug = targetRepo.replace(/[^a-z0-9_.-]+/g, "-");
    const cursorPath = path.join(root, `results/comment-sync-cursors/${targetSlug}.json`);
    try {
      writeCommentSyncRecord(root, 1, "issue", "skipped_invalid_decision", {
        targetRepo,
        decision: "close",
        closeReason: "duplicate_or_superseded",
      });
      writeCommentSyncRecord(root, 2, "issue", "skipped_invalid_decision", {
        targetRepo,
        decision: "close",
        closeReason: "implemented_on_main",
      });
      writeCommentSyncRecord(root, 3, "issue", "skipped_invalid_decision", {
        targetRepo,
        decision: "keep_open",
      });

      const result = withCwd(root, () =>
        commentSyncBatchOutput({ targetRepo, applyKind: "all", batchSize: 40, cursorPath }),
      );
      assert.equal(result.item_numbers, expected, targetRepo);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unverified checkouts and timestamp-less comments never monopolize urgent sync", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const syncedAt = new Date().toISOString();
  try {
    for (let number = 1; number <= 45; number += 1) {
      writeCommentSyncRecord(root, number, "pull_request", "kept_open", {
        reviewCommentId: `${9_000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt: "2025-01-01T00:00:00Z",
        reviewCommentSyncedAt: syncedAt,
      });
    }
    for (let number = 1_001; number <= 1_040; number += 1) {
      writeCommentSyncRecord(root, number, "issue", "kept_open", {
        localCheckoutAccess: "unverified",
        reviewedAt: syncedAt,
      });
    }
    for (let number = 2_001; number <= 2_040; number += 1) {
      writeCommentSyncRecord(root, number, "issue", "kept_open", {
        reviewCommentId: `${9_000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9_000 + number}`,
        reviewCommentHash: "b".repeat(64),
        reviewedAt: "2025-01-01T00:00:00Z",
      });
    }

    const options = {
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      batchSize: 40,
      cursorPath,
    };
    const first = withCwd(root, () => commentSyncBatchOutput(options));
    assert.equal(first.item_numbers, Array.from({ length: 40 }, (_, index) => index + 1).join(","));
    assert.equal(first.next_cursor, "40");

    writeCommentSyncCursor(cursorPath, Number(first.next_cursor), options.targetRepo);
    const second = withCwd(root, () => commentSyncBatchOutput(options));
    assert.equal(second.item_numbers.startsWith("41,42,43,44,45,"), true);
    assert.equal(
      second.item_numbers.split(",").some((number) => Number(number) > 2_000),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("all-item sync reserves its first slot for cursor progress before urgent maintenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const fresh = new Date(Date.now() - 60_000).toISOString();
  try {
    for (let number = 1; number <= 45; number += 1) {
      writeCommentSyncRecord(root, number, "pull_request", "kept_open", {
        reviewCommentId: `${9000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt: fresh,
        reviewCommentSyncedAt: fresh,
      });
    }
    writeCommentSyncRecord(root, 9999, "issue", "kept_open");

    const result = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      }),
    );
    const selected = result.item_numbers.split(",").map(Number);

    assert.equal(selected.length, 40);
    assert.deepEqual(selected.slice(0, 2), [1, 9999]);
    assert.equal(selected.includes(40), false);
    assert.equal(result.next_cursor, "39");
    assert.equal(result.wrapped, "false");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("urgent all-item repair keeps the numeric cursor frontier first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const urgent = [97566, 95788, 105342, 87267, 106572];
  try {
    for (const [index, number] of urgent.entries()) {
      writeCommentSyncRecord(root, number, "issue", "kept_open", {
        reviewedAt: new Date(Date.UTC(2026, 7, 11, 22, index)).toISOString(),
      });
    }
    const confirmedAt = "2026-08-11T22:00:00.000Z";
    writeCommentSyncRecord(root, 105870, "pull_request", "kept_open", {
      reviewCommentId: "9105870",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/105870#issuecomment-9105870",
      reviewCommentHash: "a".repeat(64),
      reviewedAt: confirmedAt,
      reviewCommentSyncedAt: confirmedAt,
    });
    writeCommentSyncCursor(cursorPath, 105854, "openclaw/openclaw");

    const result = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 6,
        cursorPath,
      }),
    );

    assert.equal(result.cursor, "105854");
    assert.equal(result.next_cursor, "105870");
    assert.deepEqual(result.item_numbers.split(",").map(Number), [105870, ...urgent.toReversed()]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped urgent comment-sync batches reserve one advancing cursor record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  try {
    for (let number = 1; number <= 41; number += 1) {
      writeCommentSyncRecord(root, number, "issue", "kept_open", {
        reviewedAt: new Date(Date.now() + number * 1_000).toISOString(),
      });
    }
    writeCommentSyncCursor(cursorPath, 1_000, "openclaw/openclaw");
    const options = {
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      batchSize: 40,
      cursorPath,
    };

    const first = withCwd(root, () => commentSyncBatchOutput(options));
    assert.equal(first.count, "40");
    assert.equal(first.item_numbers.split(",").includes("1"), true);
    assert.equal(first.next_cursor, "1");
    assert.equal(first.wrapped, "true");

    writeCommentSyncCursor(cursorPath, Number(first.next_cursor), options.targetRepo);
    const second = withCwd(root, () => commentSyncBatchOutput(options));
    assert.equal(second.item_numbers.split(",").includes("2"), true);
    assert.equal(second.next_cursor, "41");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh proof retries cannot monopolize successive all-item cursor windows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const syncedAt = new Date().toISOString();
  try {
    for (let number = 1; number <= 45; number += 1) {
      writeCommentSyncRecord(root, number, "pull_request", "skipped_pr_close_coverage_proof", {
        reviewCommentId: `${9000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt: new Date(Date.now() - (46 - number) * 1000).toISOString(),
        reviewCommentSyncedAt: syncedAt,
      });
    }
    writeCommentSyncRecord(root, 999, "pull_request", "kept_open", {
      reviewCommentId: "9999",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/pull/999#issuecomment-9999",
      reviewCommentHash: "b".repeat(64),
      reviewedAt: syncedAt,
      reviewCommentSyncedAt: syncedAt,
    });
    const options = {
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      batchSize: 40,
      cursorPath,
    };
    const first = withCwd(root, () => commentSyncBatchOutput(options));
    writeCommentSyncCursor(cursorPath, Number(first.next_cursor), options.targetRepo);
    const second = withCwd(root, () => commentSyncBatchOutput(options));

    assert.equal(first.item_numbers.split(",").length, 40);
    assert.equal(second.item_numbers, "41,42,43,44,45,999");
    assert.equal(second.next_cursor, "999");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("synchronized stale-sync retries cannot pin the urgent cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  const syncedAt = new Date().toISOString();
  try {
    for (const [number, action] of [
      [10, "retry_stale_canonical_comment_sync"],
      [20, "kept_open"],
      [30, "kept_open"],
    ] as const) {
      writeCommentSyncRecord(root, number, "pull_request", action, {
        reviewCommentId: `${9000 + number}`,
        reviewCommentUrl: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9000 + number}`,
        reviewCommentHash: "a".repeat(64),
        reviewedAt:
          number === 10 ? new Date(Date.now() + 1000).toISOString() : "2026-01-01T00:00:00.000Z",
        reviewCommentSyncedAt: syncedAt,
      });
    }
    const options = {
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      batchSize: 1,
      cursorPath,
    };
    for (const expectedNumber of [10, 20, 30]) {
      const result = withCwd(root, () => commentSyncBatchOutput(options));
      assert.equal(result.item_numbers, String(expectedNumber));
      writeCommentSyncCursor(cursorPath, Number(result.next_cursor), options.targetRepo);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manual all-item cursors still include recently synchronized issues", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorDir = path.join(root, "results/comment-sync-cursors");
  const syncedAt = new Date().toISOString();
  try {
    writeCommentSyncRecord(root, 5, "issue", "kept_open", {
      reviewCommentId: "9005",
      reviewCommentUrl: "https://github.com/openclaw/openclaw/issues/5#issuecomment-9005",
      reviewCommentHash: "a".repeat(64),
      reviewedAt: "2026-01-01T00:00:00.000Z",
      reviewCommentSyncedAt: syncedAt,
    });
    const options = {
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      batchSize: 40,
    };
    const automatic = withCwd(root, () =>
      commentSyncBatchOutput({
        ...options,
        cursorPath: path.join(cursorDir, "openclaw-openclaw.json"),
      }),
    );
    const manual = withCwd(root, () =>
      commentSyncBatchOutput({
        ...options,
        cursorPath: path.join(cursorDir, "openclaw-openclaw-all-age0.json"),
      }),
    );

    assert.equal(automatic.count, "0");
    assert.equal(manual.item_numbers, "5");
    assert.equal(manual.count, "1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("comment synchronization preserves canonical dotted and underscored repository slugs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const targetRepo = "steipete/tool.v2_debug";
  const targetSlug = "steipete-tool.v2_debug";
  const cursorPath = path.join(root, `results/comment-sync-cursors/${targetSlug}.json`);
  const reportPath = path.join(root, `records/${targetSlug}/items/${targetSlug}-41.md`);
  try {
    write(
      reportPath,
      [
        "---",
        `repository: ${targetRepo}`,
        "type: issue",
        "review_status: complete",
        "item_snapshot_hash: abc123",
        "action_taken: kept_open",
        "---",
        "",
      ].join("\n"),
    );
    const result = withCwd(root, () =>
      commentSyncBatchOutput({ targetRepo, applyKind: "all", batchSize: 40, cursorPath }),
    );

    assert.equal(result.item_numbers, "41");
    assert.equal(result.next_cursor, "41");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh review priority crosses an existing maintenance cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  try {
    writeCommentSyncRecord(root, 5, "issue", "kept_open", {
      reviewedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    writeCommentSyncRecord(root, 30, "pull_request", "kept_open", {
      reviewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeCommentSyncCursor(cursorPath, 20, "openclaw/openclaw");

    const result = withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 1,
        cursorPath,
      }),
    );

    assert.equal(result.item_numbers, "5");
    assert.equal(result.count, "1");
    assert.equal(result.next_cursor, "20");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withCwd(cwd, callback) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeProposedRecord(
  root,
  number,
  type,
  actionTaken,
  closeReason,
  itemCreatedAt,
  options = {},
) {
  const lines = [
    "---",
    "repository: openclaw/openclaw",
    `type: ${type}`,
    "decision: close",
    "confidence: high",
    `action_taken: ${actionTaken}`,
    `close_reason: ${closeReason}`,
    `item_created_at: ${itemCreatedAt}`,
  ];
  if (options.applyCheckedAt) lines.push(`apply_checked_at: ${options.applyCheckedAt}`);
  lines.push("---", "");
  write(
    path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
    lines.join("\n"),
  );
}

function writeCommentSyncRecord(root, number, type, actionTaken, options = {}) {
  const targetRepo = options.targetRepo ?? "openclaw/openclaw";
  const targetSlug = targetRepo.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const lines = [
    "---",
    `repository: ${targetRepo}`,
    `type: ${type}`,
    `review_status: ${options.reviewStatus ?? "complete"}`,
    `local_checkout_access: ${options.localCheckoutAccess ?? "verified"}`,
    `local_checkout_access_source: ${options.localCheckoutAccessSource ?? "runner_preflight_v1"}`,
    "item_snapshot_hash: abc123",
    `action_taken: ${actionTaken}`,
  ];
  if (options.decision) lines.push(`decision: ${options.decision}`);
  if (options.closeReason) lines.push(`close_reason: ${options.closeReason}`);
  if (options.reviewCommentId) lines.push(`review_comment_id: ${options.reviewCommentId}`);
  if (options.reviewCommentUrl) lines.push(`review_comment_url: ${options.reviewCommentUrl}`);
  if (options.reviewCommentHash) lines.push(`review_comment_sha256: ${options.reviewCommentHash}`);
  if (options.pullHeadSha) lines.push(`pull_head_sha: ${options.pullHeadSha}`);
  if (options.currentPullHeadSha)
    lines.push(`current_pull_head_sha: ${options.currentPullHeadSha}`);
  if (options.lastFullReviewAt) lines.push(`last_full_review_at: ${options.lastFullReviewAt}`);
  if (options.reviewedAt) lines.push(`reviewed_at: ${options.reviewedAt}`);
  if (options.applyCheckedAt) lines.push(`apply_checked_at: ${options.applyCheckedAt}`);
  if (options.reviewCommentSyncedAt)
    lines.push(`review_comment_synced_at: ${options.reviewCommentSyncedAt}`);
  lines.push("---", "");
  write(
    path.join(root, `records/${targetSlug}/items/${targetSlug}-${number}.md`),
    lines.join("\n"),
  );
}
