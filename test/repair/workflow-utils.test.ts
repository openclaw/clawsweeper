import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactItemNumbers,
  automationLimit,
  commentSyncBatchOutput,
  countActions,
  countCommandActions,
  countRequeueRequired,
  mergeApplyReports,
  planOutputFields,
  plannedItemNumberCsv,
  proposedItemNumbers,
  writeCommentSyncCursor,
} from "../../dist/repair/workflow-utils.js";
import { AUTOMATION_LIMITS, WORKER_CONFIG, workerLimit } from "../../dist/repair/limits.js";

test("workflow utilities expose automation limits", () => {
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

test("worker scheduler lets background lanes yield to active work", () => {
  const quietBackgroundCapacity =
    WORKER_CONFIG.workers.max -
    WORKER_CONFIG.workers.reserve_for_interactive -
    WORKER_CONFIG.workers.expansion_reserve;
  assert.equal(
    workerLimit("normal_review"),
    Math.min(AUTOMATION_LIMITS.review_shards.normal_default, quietBackgroundCapacity),
  );
  assert.equal(workerLimit("normal_review", { activeCritical: 21, activeBackground: 13 }), 1);
  assert.equal(workerLimit("commit_review"), AUTOMATION_LIMITS.commit_review.page_size_default);
  assert.equal(workerLimit("commit_review", { activeCritical: 49 }), 1);
  assert.equal(workerLimit("repair"), AUTOMATION_LIMITS.repair_live_runs.default);
  assert.equal(AUTOMATION_LIMITS.assist.default, 5);
  assert.equal(AUTOMATION_LIMITS.assist_visual.default, 2);
  assert.equal(workerLimit("assist"), 5);
  assert.equal(workerLimit("assist_visual"), 2);
  assert.equal(workerLimit("assist", { activeCritical: 55 }), 2);
  assert.equal(workerLimit("assist_visual", { activeCritical: 56 }), 1);
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
            { action: "dispatch_repair", status: "executed" },
          ],
        },
        {
          actions: [{ action: "dispatch_clawsweeper", status: "waiting" }],
        },
      ],
    }),
  );

  assert.equal(countCommandActions(report, "dispatch_repair"), 2);
  assert.equal(countCommandActions(report, "dispatch_repair", "waiting"), 1);
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

  assert.equal(countRequeueRequired(path.join(root, "runs")), 1);
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

  assert.deepEqual(selected, [5, 12]);
});

test("workflow utilities select cursor-based PR comment sync batches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  writeCommentSyncRecord(root, 10, "pull_request", "kept_open");
  writeCommentSyncRecord(root, 20, "pull_request", "proposed_close");
  writeCommentSyncRecord(root, 30, "pull_request", "kept_open");
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
