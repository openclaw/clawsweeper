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
  proposedItemQualitySummary,
  proposedItemNumbers,
  proposedPrCloseCoverageItemNumbers,
  summarizeApplyReport,
  writeApplyCursor,
  writeCommentSyncCursor,
} from "../../dist/repair/workflow-utils.js";
import {
  AUTOMATION_LIMITS,
  WORKER_CONFIG,
  readWorkerConfig,
  workerLimit,
} from "../../dist/repair/limits.js";

const APPLY_RUN_PATH = ".github/workflows/sweep.yml";
const DEFAULT_APPLY_TITLE = "Apply default ClawSweeper closures for openclaw/openclaw";

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
  assert.equal(workerLimit("commit_review"), AUTOMATION_LIMITS.commit_review.page_size_default);
  assert.equal(workerLimit("commit_review", { activeCritical: quietBackgroundCapacity }), 1);
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
    candidateCount: 12,
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
    apply_ready_count: 12,
    window_size: 4,
    estimated_full_cycle_windows: 3,
    estimated_full_cycle_minutes: 45,
    scheduled_interval_minutes: 15,
    label:
      "12 close candidates (confirmed proposals plus live promotion probes) at 4 records per latest cursor advance: about 3 windows; scheduled cadence alone would take roughly 45 min at 15-minute intervals, while successful windows can continue sooner.",
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
    maintainer_review: 2,
    report_quality_repair: 2,
    stable_skip: 1,
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
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-5.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-9.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: stale_insufficient_info",
      `item_created_at: ${oldDate}`,
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
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: mostly_implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-13.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: mostly_implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-14.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: mostly_implemented_on_main",
      `item_created_at: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-15.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: low_signal_unmergeable_pr",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-16.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: low_signal_unmergeable_pr",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-17.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: retry_pr_close_coverage_proof",
      "close_reason: duplicate_or_superseded",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-18.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: kept_open",
      "close_reason: duplicate_or_superseded",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-19.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_pr_close_coverage_proof",
      "close_reason: duplicate_or_superseded",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-20.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-21.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      `work_cluster_refs: ${JSON.stringify(["Superseded by https://github.com/openclaw/openclaw/pull/400"])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-22.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      "pr_rating_overall: F",
      "pr_rating_proof: F",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-24.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      `work_cluster_refs: ${JSON.stringify(["Superseded by openclaw/openclaw#400"])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-25.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      `item_created_at: ${oldDate}`,
      `work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-23.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      "pr_rating_overall: F",
      `item_created_at: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-26.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_same_author_pair",
      "close_reason: duplicate_or_superseded",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-27.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_open_closing_pr",
      "close_reason: implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-28.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_invalid_decision",
      "close_reason: duplicate_or_superseded",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-29.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_maintainer_authored",
      "close_reason: duplicate_or_superseded",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-30.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_invalid_decision",
      "close_reason: implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-31.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: skipped_maintainer_authored",
      "close_reason: implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-32.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      "pr_rating_overall: F",
      "pr_rating_proof: F",
      `item_created_at: ${oldDate}`,
      `work_cluster_refs: ${JSON.stringify(["Superseded by #400"])}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-33.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      "pr_rating_overall: B",
      "pr_rating_proof: F",
      "real_behavior_proof_status: missing",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-34.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      "pr_rating_overall: F",
      "pr_rating_proof: A",
      "real_behavior_proof_status: sufficient",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-35.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: keep_open",
      "review_status: complete",
      "local_checkout_access: verified",
      "action_taken: kept_open",
      "close_reason: none",
      "pr_rating_overall: F",
      "pr_rating_proof: A",
      "real_behavior_proof_status: insufficient",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
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

  assert.deepEqual(selected, [5, 12, 15, 17, 18, 21, 22, 24, 25, 26, 27, 30, 31, 32, 35]);
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
    [15, 22, 32, 35],
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

  assert.equal(summary.total, 8);
  assert.deepEqual(selected, [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(
    summary.summary,
    "1 implemented-on-main, 1 duplicate/superseded, 1 needs PR close proof, 3 aging/low-signal, 1 policy-sensitive, 1 retry after guard skip",
  );
  assert.deepEqual(
    summary.buckets.map((bucket) => [bucket.bucket, bucket.count]),
    [
      ["ready_implemented", 1],
      ["duplicate_or_superseded", 1],
      ["needs_pr_close_coverage", 1],
      ["aging_or_low_signal", 3],
      ["policy_sensitive", 1],
      ["retry_after_guard_skip", 1],
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

test("workflow utilities bound coverage proofs with an independent cursor", () => {
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
  writeProposedRecord(
    root,
    50,
    "pull_request",
    "proposed_close",
    "duplicate_or_superseded",
    oldDate,
    { applyCheckedAt: "2026-01-02T00:00:00Z" },
  );
  const options = {
    targetRepo: "openclaw/openclaw",
    applyKind: "all",
    applyCloseReasons: "all",
    staleMinAgeDays: 60,
    minAgeDays: 0,
    minAgeMinutes: null,
    batchSize: 4,
    coverageProofLimit: 1,
    cursorPath,
  };

  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [10, 40, 20, 30],
  );
  write(
    cursorPath,
    JSON.stringify({
      next_after_number: 20,
      next_after_apply_checked_at: "2026-01-02T00:00:00Z",
      coverage_proof_cursor: {
        next_after_number: 40,
        next_after_apply_checked_at: "2026-01-01T00:00:00Z",
      },
    }),
  );
  assert.deepEqual(
    withCwd(root, () => proposedItemNumbers(options)),
    [30, 50, 10, 20],
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
    writeApplyCursor(cursorPath, reportPath, "openclaw/openclaw", "10,20,30", "30", tracePath),
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
  assert.equal(applyCursorAdvanceCount(reportPath, "10,20,30", tracePath), 2);

  write(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [20] }));
  withCwd(root, () =>
    writeApplyCursor(cursorPath, reportPath, "openclaw/openclaw", "20,40", "40", tracePath),
  );
  cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.equal(cursor.next_after_number, 20);
  assert.equal(cursor.coverage_proof_cursor.next_after_number, 30);
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
        batchSize: 2,
        cursorPath,
      }),
    ),
    {
      item_numbers: "30",
      count: "1",
      cursor: "20",
      next_cursor: "30",
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

function writeCommentSyncRecord(root, number, type, actionTaken) {
  write(
    path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
    [
      "---",
      "repository: openclaw/openclaw",
      `type: ${type}`,
      "review_status: complete",
      "item_snapshot_hash: abc123",
      `action_taken: ${actionTaken}`,
      "---",
      "",
    ].join("\n"),
  );
}
