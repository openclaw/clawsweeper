#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./lib.js";
import { isJsonObject } from "./json-types.js";
import { AUTOMATION_LIMITS, WORKER_CONFIG, workerLimit, type WorkerLane } from "./limits.js";

type ApplyAction = {
  action: string;
  number?: number;
  reason?: string;
};

type ApplyContinuationBlocker = {
  databaseId: string;
  status: string;
};

type ApplyContinuationBlockerOptions = {
  currentRunId: string;
  targetRepo: string;
  nowMs?: number;
};

type ApplyReportSummaryOptions = {
  reportPath: string;
  targetRepo: string;
  mode: string;
  processedLimit: number;
  closeLimit: number | null;
  cursorPath: string;
  cursorRequired: boolean;
  candidateCount?: number | null;
  candidateCounts?: ApplyCandidateCounts | null;
  cursorAdvanceCount?: number | null;
  scheduledIntervalMinutes?: number | null;
};

export type ApplyCandidateCounts = {
  confirmed_proposal: number;
  guarded_retry: number;
  proof_required: number;
  promotion_total: number;
  promotion_eligible: number;
  promotion_cooldown_eligible: number;
  cooldown_eligible_total: number;
  inconsistent_or_stale: number;
};

export type ProposedItemInventory = ApplyCandidateCounts & {
  eligible_total: number;
};

type ApplyReportSummary = {
  schema_version: 1;
  generated_at: string;
  target_repo: string;
  mode: string;
  status: "ok" | "idle" | "needs_attention";
  summary: string;
  examined: number | null;
  action_records: number;
  processed: number;
  processed_limit: number | null;
  close_limit: number | null;
  closed: number;
  comment_synced: number;
  skipped: number;
  skip_reasons: Record<string, number>;
  lanes: {
    closure: ApplyLaneSummary;
    comment_sync: ApplyLaneSummary;
  };
  next_actions: ApplySkipNextAction[];
  next_action_buckets: Record<string, number>;
  cycle: ApplyCycleSummary;
  attention_reasons: string[];
  cursor_required: boolean;
  cursor: {
    path: string;
    next_after_number: number;
    next_after_apply_checked_at: string | null;
    updated_at: string | null;
  } | null;
};

type ApplyLaneSummary = {
  processed: number;
  closed: number;
  comment_synced: number;
  skipped: number;
  skip_reasons: Record<string, number>;
};

type ApplySkipNextAction = {
  reason: string;
  count: number;
  bucket:
    | "review_refresh"
    | "close_coverage_proof"
    | "conversation_unlock"
    | "maintainer_review"
    | "stable_skip"
    | "report_quality_repair"
    | "defer_until_closing_pr"
    | "run_budget"
    | "live_state_recovery"
    | "already_resolved"
    | "inspect";
  owner: "clawsweeper" | "maintainer" | "github" | "none";
  retryable: boolean;
  label: string;
  summary: string;
  next_step: string;
};

type ApplySkipNextActionDetail = Omit<ApplySkipNextAction, "reason" | "count">;
type ApplyCycleSummary = {
  basis:
    | "scheduled_close_cursor"
    | "not_close_cursor"
    | "missing_candidate_count"
    | "missing_window_size"
    | "no_apply_ready_candidates";
  apply_ready_count: number | null;
  candidate_counts: ApplyCandidateCounts | null;
  window_size: number | null;
  estimated_full_cycle_windows: number | null;
  estimated_full_cycle_minutes: number | null;
  scheduled_interval_minutes: number | null;
  label: string;
};

type AdaptiveApplyBatchSizeOptions = {
  statusPath: string;
  baseSize: number;
  maxSize: number;
};

type AdaptiveApplyBatchSize = {
  closeProcessedLimit: number;
  baseCloseProcessedLimit: number;
  maxCloseProcessedLimit: number;
  adaptive: boolean;
  reason: string;
  previousProcessed: number | null;
  previousProcessedLimit: number | null;
  previousClosed: number | null;
  previousSkipped: number | null;
};

const args = parseArgs(process.argv.slice(2));

function runCli(): void {
  const command = args._[0];
  if (!command) throw new Error("workflow utility command is required");

  switch (command) {
    case "plan-output":
      printPlanOutput();
      break;
    case "classify-output":
      printClassifyOutput();
      break;
    case "artifact-item-numbers":
      process.stdout.write(artifactItemNumbers(requiredString("artifact-dir")).join(","));
      break;
    case "count-csv":
      console.log(csvItems(optionalString("items")).length);
      break;
    case "count-report":
      console.log(countActions(requiredString("report"), ""));
      break;
    case "count-actions":
      console.log(countActions(requiredString("report"), requiredString("action")));
      break;
    case "apply-cursor-advance-count":
      console.log(
        applyCursorAdvanceCount(
          requiredString("report"),
          optionalString("item-numbers"),
          optionalString("cursor-trace"),
        ),
      );
      break;
    case "apply-cursor-trace-item-numbers":
      process.stdout.write(readApplyCursorTrace(requiredString("cursor-trace")).join(","));
      break;
    case "apply-continuation-blocker": {
      const blocker = applyContinuationBlocker(readJsonArray(requiredString("runs")), {
        currentRunId: requiredString("current-run-id"),
        targetRepo: requiredString("target-repo"),
      });
      printOutput({
        APPLY_CONTINUATION_BLOCKED: blocker ? "true" : "false",
        APPLY_CONTINUATION_BLOCKER_RUN_ID: blocker?.databaseId ?? "",
        APPLY_CONTINUATION_BLOCKER_STATUS: blocker?.status ?? "",
      });
      break;
    }
    case "summarize-apply-report":
      process.stdout.write(
        `${JSON.stringify(
          summarizeApplyReport({
            reportPath: requiredString("report"),
            targetRepo: requiredString("target-repo"),
            mode: optionalString("mode") || "close",
            processedLimit: numberArg("processed-limit", 0),
            closeLimit: optionalString("close-limit") ? numberArg("close-limit", 0) : null,
            cursorPath: optionalString("cursor-path"),
            cursorRequired: booleanArg("cursor-required", false),
            candidateCount: optionalString("candidate-count")
              ? nonNegativeIntegerArg("candidate-count")
              : null,
            candidateCounts: applyCandidateCounts(optionalString("candidate-counts-json")),
            cursorAdvanceCount: optionalString("cursor-advance-count")
              ? nonNegativeIntegerArg("cursor-advance-count")
              : null,
            scheduledIntervalMinutes: optionalString("scheduled-interval-minutes")
              ? positiveIntegerArg("scheduled-interval-minutes")
              : null,
          }),
          null,
          2,
        )}\n`,
      );
      break;
    case "adaptive-apply-batch-size": {
      const result = adaptiveApplyBatchSize({
        statusPath: requiredString("status-path"),
        baseSize: numberArg("base-size", 300),
        maxSize: numberArg("max-size", 900),
      });
      printOutput({
        close_processed_limit: String(result.closeProcessedLimit),
        base_close_processed_limit: String(result.baseCloseProcessedLimit),
        max_close_processed_limit: String(result.maxCloseProcessedLimit),
        adaptive_apply_scan: result.adaptive ? "true" : "false",
        adaptive_apply_scan_reason: result.reason,
        previous_apply_processed: optionalNumberOutput(result.previousProcessed),
        previous_apply_processed_limit: optionalNumberOutput(result.previousProcessedLimit),
        previous_apply_closed: optionalNumberOutput(result.previousClosed),
        previous_apply_skipped: optionalNumberOutput(result.previousSkipped),
      });
      break;
    }
    case "count-command-actions":
      console.log(
        countCommandActions(
          requiredString("report"),
          requiredString("action"),
          optionalString("status"),
        ),
      );
      break;
    case "count-requeue-required":
      console.log(countRequeueRequired(requiredString("dir")));
      break;
    case "limit":
      process.stdout.write(String(automationLimit(optionalString("path") || positionalString(1))));
      break;
    case "worker-limit":
      process.stdout.write(
        String(
          workerLimit(requiredWorkerLane(optionalString("lane") || positionalString(1)), {
            activeCritical: numberArg("active-critical", 0),
            activeBackground: numberArg("active-background", 0),
          }),
        ),
      );
      break;
    case "worker-config":
      process.stdout.write(JSON.stringify(WORKER_CONFIG, null, 2));
      break;
    case "proposed-item-numbers":
      process.stdout.write(proposedItemNumbers(proposedItemOptions()).join(","));
      break;
    case "proposed-item-count":
      process.stdout.write(String(proposedItemCount(proposedItemOptions())));
      break;
    case "proposed-item-inventory":
      printProposedItemInventory(proposedItemOptions());
      break;
    case "proposed-item-quality-summary":
      printProposedItemQualitySummary(proposedItemOptions());
      break;
    case "proposed-pr-close-coverage-item-numbers":
      process.stdout.write(proposedPrCloseCoverageItemNumbers(proposedItemOptions()).join(","));
      break;
    case "comment-sync-batch":
      printOutput(commentSyncBatchOutput(commentSyncBatchOptions()));
      break;
    case "write-comment-sync-cursor":
      writeCommentSyncCursor(
        requiredString("cursor-path"),
        numberArg("next-cursor", 0),
        requiredString("target-repo"),
      );
      break;
    case "write-apply-cursor":
      writeApplyCursor(
        requiredString("cursor-path"),
        requiredString("report"),
        requiredString("target-repo"),
        optionalString("item-numbers"),
        optionalString("coverage-proof-item-numbers"),
        optionalString("cursor-trace"),
      );
      break;
    case "merge-apply-reports":
      mergeApplyReports(requiredString("dir"), requiredString("output"));
      break;
    default:
      throw new Error(`unknown workflow utility command: ${command}`);
  }
}

function requiredWorkerLane(value: string): WorkerLane {
  const allowed = new Set<WorkerLane>([
    "normal_review",
    "hot_intake",
    "commit_review",
    "repair",
    "automerge_repair",
    "issue_implementation",
    "cluster_repair",
    "exact_item",
    "assist",
  ]);
  if (allowed.has(value as WorkerLane)) return value as WorkerLane;
  throw new Error(`unknown worker lane: ${value}`);
}

export function automationLimit(limitPath: string): number {
  let cursor: unknown = AUTOMATION_LIMITS;
  for (const segment of limitPath.split(".")) {
    if (!segment) throw new Error(`invalid automation limit path: ${limitPath}`);
    if (!isJsonObject(cursor) || !(segment in cursor)) {
      throw new Error(`unknown automation limit: ${limitPath}`);
    }
    cursor = cursor[segment];
  }
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 1) {
    throw new Error(`automation limit ${limitPath} must resolve to a positive integer`);
  }
  return cursor;
}

function printPlanOutput(): void {
  const plan = readJsonObject(requiredString("plan"));
  const batchSize = positiveNumber(optionalString("batch-size"), 5);
  const shardCount = positiveNumber(
    optionalString("shard-count"),
    AUTOMATION_LIMITS.review_shards.normal_default,
  );
  printOutput(planOutputFields(plan, { batchSize, shardCount }));
}

export function planOutputFields(
  plan: LooseRecord,
  options: { batchSize: number; shardCount: number },
): Record<string, string> {
  const matrix = Array.isArray(plan.matrix) ? plan.matrix : [];
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const planCapacity = Number(plan.capacity);
  const capacity = Number.isFinite(planCapacity)
    ? planCapacity
    : options.batchSize * options.shardCount;
  return {
    matrix: JSON.stringify(matrix),
    planned_count: String(candidates.length),
    planned_capacity: String(capacity),
    planned_item_numbers: plannedItemNumberCsv(plan),
    planned_shards: String(matrix.length),
    active_codex_target: String(numberFromPlan(plan.activeCodexTarget, matrix.length)),
    due_backlog: String(numberFromPlan(plan.dueBacklog, candidates.length)),
    oldest_unreviewed_at:
      typeof plan.oldestUnreviewedAt === "string" ? plan.oldestUnreviewedAt : "",
    capacity_reason:
      typeof plan.capacityReason === "string" && plan.capacityReason.trim()
        ? plan.capacityReason
        : defaultCapacityReason(
            candidates.length,
            numberFromPlan(plan.dueBacklog, candidates.length),
            capacity,
          ),
  };
}

function numberFromPlan(value: JsonValue | undefined, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultCapacityReason(
  selectedCount: number,
  dueBacklog: number,
  capacity: number,
): string {
  if (selectedCount === 0) return "idle: no due candidates found";
  if (dueBacklog >= capacity) return "saturated: due backlog filled planned capacity";
  return "under capacity: due backlog below planned capacity";
}

export function adaptiveApplyBatchSize(
  options: AdaptiveApplyBatchSizeOptions,
): AdaptiveApplyBatchSize {
  const baseSize = positiveInteger(options.baseSize, "baseSize");
  const maxSize = Math.max(baseSize, positiveInteger(options.maxSize, "maxSize"));
  const base: AdaptiveApplyBatchSize = {
    closeProcessedLimit: baseSize,
    baseCloseProcessedLimit: baseSize,
    maxCloseProcessedLimit: maxSize,
    adaptive: false,
    reason: "base_window",
    previousProcessed: null,
    previousProcessedLimit: null,
    previousClosed: null,
    previousSkipped: null,
  };
  const status = readJsonObjectIfPresent(options.statusPath);
  if (!status) return base;
  const health = closeApplyHealthFromStatus(status);
  if (!health) return base;
  const previousProcessed = nonNegativeIntegerOrNull(health.processed);
  const previousProcessedLimit = nonNegativeIntegerOrNull(health.processed_limit);
  const previousClosed = nonNegativeIntegerOrNull(health.closed);
  const previousSkipped = nonNegativeIntegerOrNull(health.skipped);
  const withPrevious = {
    ...base,
    previousProcessed,
    previousProcessedLimit,
    previousClosed,
    previousSkipped,
  };
  if (health.cursor_required !== true) return withPrevious;
  if (
    previousProcessed === null ||
    previousProcessedLimit === null ||
    previousClosed === null ||
    previousSkipped === null
  ) {
    return withPrevious;
  }

  const fullWindow = previousProcessedLimit > 0 && previousProcessed >= previousProcessedLimit;
  const zeroClose = previousClosed === 0;
  const skipHeavy = previousProcessed > 0 && previousSkipped / previousProcessed >= 0.8;
  const attentionReasons = new Set(stringArray(health.attention_reasons));
  const unsafeAttention = [
    "cursor_required_but_missing_after_full_window",
    "skipped_live_fetch_failed",
    "skipped_runtime_budget",
  ].some((reason) => attentionReasons.has(reason));
  if (!fullWindow || !zeroClose || !skipHeavy || unsafeAttention) return withPrevious;

  const grown = Math.min(maxSize, Math.max(baseSize, previousProcessedLimit * 2));
  if (grown <= baseSize) return withPrevious;
  return {
    ...withPrevious,
    closeProcessedLimit: grown,
    adaptive: true,
    reason: "previous_full_zero_close_skip_window",
  };
}

function closeApplyHealthFromStatus(status: LooseRecord): LooseRecord | null {
  const current = recordOrNull(status.apply_health);
  if (current?.mode === "close") return current;
  const preserved = recordOrNull(status.last_close_apply_health);
  return preserved?.mode === "close" ? preserved : null;
}

function optionalNumberOutput(value: number | null): string {
  return value === null ? "" : String(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeIntegerOrNull(value: JsonValue | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function plannedItemNumberCsv(plan: LooseRecord): string {
  const candidates: JsonValue[] = Array.isArray(plan.candidates) ? plan.candidates : [];
  return candidates
    .map((candidate) => candidateItemNumber(candidate))
    .filter((number): number is number => typeof number === "number")
    .join(",");
}

function candidateItemNumber(candidate: JsonValue): number | null {
  if (!isJsonObject(candidate)) return null;
  const number = Number(candidate.number);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function printClassifyOutput(): void {
  const classified = readJsonObject(requiredString("classify"));
  const review = stringArray(classified.review);
  const skipped = Array.isArray(classified.skipped) ? classified.skipped : [];
  printOutput({
    matrix: JSON.stringify(review.map((sha) => ({ sha }))),
    planned_count: String(review.length),
    skipped_count: String(skipped.length),
    has_more: optionalString("has-more") || "false",
    next_offset: optionalString("next-offset") || "0",
  });
}

export function artifactItemNumbers(artifactDir: string): number[] {
  if (!fs.existsSync(artifactDir)) return [];
  return fs
    .readdirSync(artifactDir, { recursive: true })
    .map((name) => path.basename(String(name), ".md").match(/(\d+)$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

export function countActions(reportPath: string, action: string): number {
  if (!action) return readApplyActions(reportPath).length;
  return readApplyActions(reportPath).filter((entry) => entry.action === action).length;
}

export function applyContinuationBlocker(
  values: readonly unknown[],
  options: ApplyContinuationBlockerOptions,
): ApplyContinuationBlocker | null {
  const expectedTitle = `Apply default ClawSweeper closures for ${options.targetRepo}`;
  const activeStatuses = new Set(["in_progress", "pending", "queued", "waiting", "requested"]);
  const queuedStatuses = new Set(["pending", "queued", "waiting", "requested"]);
  const staleQueuedMs = 6 * 60 * 60 * 1000;
  const nowMs = options.nowMs ?? Date.now();
  const seen = new Set<string>();

  for (const value of values) {
    if (!isJsonObject(value)) continue;
    const databaseId = String(value.databaseId ?? "");
    if (!databaseId || seen.has(databaseId)) continue;
    seen.add(databaseId);
    if (databaseId === options.currentRunId) continue;
    if (value.workflowPath !== ".github/workflows/sweep.yml") continue;
    if (value.displayTitle !== expectedTitle) continue;
    const status = String(value.status ?? "");
    if (!activeStatuses.has(status)) continue;
    if (queuedStatuses.has(status)) {
      const updatedAt = String(value.updatedAt || value.createdAt || "");
      const lastChangedAt = Date.parse(updatedAt);
      if (Number.isFinite(lastChangedAt) && nowMs - lastChangedAt > staleQueuedMs) continue;
    }
    return { databaseId, status };
  }
  return null;
}

export function summarizeApplyReport(options: ApplyReportSummaryOptions): ApplyReportSummary {
  const actions = readApplyActions(options.reportPath);
  const examined =
    options.cursorRequired &&
    options.cursorAdvanceCount !== null &&
    options.cursorAdvanceCount !== undefined
      ? options.cursorAdvanceCount
      : null;
  const lanes = summarizeApplyLanes(actions, options.mode);
  const skipReasons: Record<string, number> = {};
  let closed = 0;
  let commentSynced = 0;
  let skipped = 0;
  for (const entry of actions) {
    if (entry.action === "closed") closed += 1;
    if (reportsReviewCommentSync(entry)) commentSynced += 1;
    if (!isProductiveApplyAction(entry)) {
      skipped += 1;
      skipReasons[entry.action] = (skipReasons[entry.action] || 0) + 1;
    }
  }

  const cursor = readApplyCursorForSummary(options.cursorPath);
  const processedLimit = options.processedLimit > 0 ? options.processedLimit : null;
  const cycle = applyCycleSummary({
    mode: options.mode,
    cursorRequired: options.cursorRequired,
    candidateCount: options.candidateCount ?? null,
    candidateCounts: options.candidateCounts ?? null,
    cursorAdvanceCount: options.cursorAdvanceCount ?? null,
    scheduledIntervalMinutes: options.scheduledIntervalMinutes ?? null,
  });
  const attentionReasons: string[] = [];
  if (
    options.cursorRequired &&
    processedLimit !== null &&
    (actions.length >= processedLimit || (examined !== null && examined >= processedLimit)) &&
    !cursor
  ) {
    attentionReasons.push("cursor_required_but_missing_after_full_window");
  }
  const resumableRuntimeBudget =
    options.cursorRequired && Boolean(cursor) && (options.cursorAdvanceCount ?? 0) > 0;
  if ((skipReasons.skipped_runtime_budget || 0) > 0 && !resumableRuntimeBudget) {
    attentionReasons.push("skipped_runtime_budget");
  }
  if ((skipReasons.skipped_live_fetch_failed || 0) > 0) {
    attentionReasons.push("skipped_live_fetch_failed");
  }
  if (actions.length > 0 && skipped === actions.length) {
    const benignSkipReasons = new Set([
      "skipped_already_closed",
      "skipped_closed",
      "skipped_not_open",
    ]);
    if (resumableRuntimeBudget) benignSkipReasons.add("skipped_runtime_budget");
    for (const reason of Object.keys(skipReasons).sort()) {
      if (!benignSkipReasons.has(reason) && !attentionReasons.includes(reason)) {
        attentionReasons.push(reason);
      }
    }
  }
  const nextActions = applySkipNextActions(skipReasons);

  const status =
    attentionReasons.length > 0
      ? "needs_attention"
      : actions.length === 0 && (examined === null || examined === 0)
        ? "idle"
        : "ok";
  const summary = applyReportHealthSummary({
    status,
    examined,
    actionRecords: actions.length,
    processedLimit,
    closed,
    commentSynced,
    skipped,
    cursor,
    attentionReasons,
  });

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    target_repo: options.targetRepo,
    mode: options.mode,
    status,
    summary,
    examined,
    action_records: actions.length,
    processed: actions.length,
    processed_limit: processedLimit,
    close_limit: options.closeLimit,
    closed,
    comment_synced: commentSynced,
    skipped,
    skip_reasons: Object.fromEntries(
      Object.entries(skipReasons).sort(([left], [right]) => left.localeCompare(right)),
    ),
    lanes,
    next_actions: nextActions,
    next_action_buckets: applyNextActionBuckets(nextActions),
    cycle,
    attention_reasons: attentionReasons,
    cursor_required: options.cursorRequired,
    cursor,
  };
}

function summarizeApplyLanes(
  actions: ApplyAction[],
  mode: string,
): { closure: ApplyLaneSummary; comment_sync: ApplyLaneSummary } {
  const lanes = {
    closure: emptyApplyLaneSummary(),
    comment_sync: emptyApplyLaneSummary(),
  };
  for (const entry of actions) {
    const laneName = applyActionLane(entry.action, mode);
    const lane = lanes[laneName];
    lane.processed += 1;
    if (entry.action === "closed") lane.closed += 1;
    if (reportsReviewCommentSync(entry)) lane.comment_synced += 1;
    if (!isProductiveApplyAction(entry)) {
      lane.skipped += 1;
      lane.skip_reasons[entry.action] = (lane.skip_reasons[entry.action] || 0) + 1;
    }
  }
  return {
    closure: sortApplyLaneSummary(lanes.closure),
    comment_sync: sortApplyLaneSummary(lanes.comment_sync),
  };
}

function emptyApplyLaneSummary(): ApplyLaneSummary {
  return {
    processed: 0,
    closed: 0,
    comment_synced: 0,
    skipped: 0,
    skip_reasons: {},
  };
}

function sortApplyLaneSummary(lane: ApplyLaneSummary): ApplyLaneSummary {
  return {
    ...lane,
    skip_reasons: Object.fromEntries(
      Object.entries(lane.skip_reasons).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function applyActionLane(action: string, mode: string): "closure" | "comment_sync" {
  if (
    String(mode || "").toLowerCase() === "comment_sync" ||
    action === "review_comment_synced" ||
    action === "skipped_comment_auth" ||
    action === "skipped_locked_conversation" ||
    action === "skipped_stale_review_comment_sync"
  ) {
    return "comment_sync";
  }
  return "closure";
}

function isProductiveApplyAction(entry: ApplyAction): boolean {
  return (
    entry.action === "closed" ||
    entry.action === "review_comment_synced" ||
    (entry.action === "kept_open" && isSuccessfulLabelSyncReason(entry.reason))
  );
}

function applySkipNextActions(skipReasons: Record<string, number>): ApplySkipNextAction[] {
  return Object.entries(skipReasons)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([reason, count]) => applySkipNextAction(reason, count))
    .sort(
      (left, right) =>
        right.count - left.count ||
        applyNextActionBucketRank(left.bucket) - applyNextActionBucketRank(right.bucket) ||
        left.reason.localeCompare(right.reason),
    );
}

function applyNextActionBuckets(actions: ApplySkipNextAction[]): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const action of actions) {
    buckets[action.bucket] = (buckets[action.bucket] || 0) + action.count;
  }
  return Object.fromEntries(
    Object.entries(buckets).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function applyNextActionBucketRank(bucket: ApplySkipNextAction["bucket"]): number {
  return [
    "live_state_recovery",
    "run_budget",
    "review_refresh",
    "close_coverage_proof",
    "report_quality_repair",
    "defer_until_closing_pr",
    "conversation_unlock",
    "maintainer_review",
    "stable_skip",
    "already_resolved",
    "inspect",
  ].indexOf(bucket);
}

const APPLY_SKIP_NEXT_ACTION_DETAILS: Record<string, ApplySkipNextActionDetail> = {
  skipped_changed_since_review: {
    bucket: "review_refresh",
    owner: "clawsweeper",
    retryable: true,
    label: "Refresh review",
    summary: "The item changed after the review that proposed closing it.",
    next_step: "Queue a fresh ClawSweeper review before any close retry.",
  },
  skipped_stale_review_comment_sync: {
    bucket: "review_refresh",
    owner: "clawsweeper",
    retryable: true,
    label: "Refresh review state",
    summary: "The durable review comment is newer than the local review report.",
    next_step: "Queue a fresh review instead of overwriting the newer durable comment.",
  },
  skipped_pr_close_coverage_proof: {
    bucket: "close_coverage_proof",
    owner: "clawsweeper",
    retryable: true,
    label: "Add close proof",
    summary: "The PR close proposal needs positive coverage proof before apply can close it.",
    next_step: "Run or refresh close-coverage proof for the canonical and covered PR pair.",
  },
  retry_pr_close_coverage_proof: {
    bucket: "close_coverage_proof",
    owner: "clawsweeper",
    retryable: true,
    label: "Retry close proof",
    summary: "The close-coverage proof check failed transiently before reaching a decision.",
    next_step: "Inspect the proof failure, then retry after model and GitHub access recover.",
  },
  retry_stale_canonical_comment_sync: {
    bucket: "review_refresh",
    owner: "clawsweeper",
    retryable: true,
    label: "Retry comment correction",
    summary: "A stale canonical close verdict still needs to be replaced on GitHub.",
    next_step: "Retry durable comment sync until the conservative keep-open correction succeeds.",
  },
  skipped_protected_label: maintainerDecisionAction(),
  skipped_close_exempt_label: maintainerDecisionAction(),
  skipped_policy_exempt: maintainerDecisionAction(),
  skipped_maintainer_authored: {
    bucket: "maintainer_review",
    owner: "maintainer",
    retryable: false,
    label: "Maintainer-authored",
    summary: "Automation does not close maintainer-authored items without human judgement.",
    next_step: "Route to maintainer review or close manually if the owner agrees.",
  },
  skipped_locked_conversation: {
    bucket: "conversation_unlock",
    owner: "maintainer",
    retryable: false,
    label: "Conversation locked",
    summary: "GitHub blocked the durable comment write because the conversation is locked.",
    next_step: "Unlock the conversation before retrying comment sync, or leave it unchanged.",
  },
  skipped_same_author_pair: {
    bucket: "stable_skip",
    owner: "none",
    retryable: false,
    label: "Stable skip",
    summary:
      "The source and canonical items have the same author, so automated duplicate close is intentionally conservative.",
    next_step: "Leave as a stable skip unless maintainers change the same-author close policy.",
  },
  skipped_invalid_decision: reportRepairAction(),
  skipped_missing_record: reportRepairAction(),
  skipped_open_closing_pr: {
    bucket: "defer_until_closing_pr",
    owner: "github",
    retryable: false,
    label: "Wait for closing PR",
    summary: "The item appears covered by a pull request that is still open.",
    next_step: "Defer until the linked closing PR merges, closes, or changes state.",
  },
  skipped_runtime_budget: {
    bucket: "run_budget",
    owner: "clawsweeper",
    retryable: true,
    label: "Runtime budget",
    summary: "The apply lane stopped because it reached its bounded runtime.",
    next_step: "Let the next scheduled run continue; tune runtime or batch size if this repeats.",
  },
  skipped_live_fetch_failed: {
    bucket: "live_state_recovery",
    owner: "github",
    retryable: true,
    label: "Recover live check",
    summary: "ClawSweeper could not confirm live GitHub state before mutating.",
    next_step: "Inspect auth, API, or rate-limit failures and retry after live checks recover.",
  },
  skipped_comment_auth: {
    bucket: "live_state_recovery",
    owner: "clawsweeper",
    retryable: true,
    label: "Repair comment auth",
    summary: "GitHub rejected the durable review comment write as unauthenticated.",
    next_step: "Repair the GitHub App write token before retrying comment sync.",
  },
  skipped_not_open: alreadyResolvedAction(),
  skipped_already_closed: alreadyResolvedAction(),
  skipped_closed: alreadyResolvedAction(),
};

function applySkipNextAction(reason: string, count: number): ApplySkipNextAction {
  const detail = APPLY_SKIP_NEXT_ACTION_DETAILS[reason] ?? {
    bucket: "inspect",
    owner: "maintainer",
    retryable: false,
    label: "Inspect skip",
    summary: "Apply reported an unmapped skip bucket.",
    next_step: "Inspect the workflow run and add a deterministic mapping if this repeats.",
  };
  return { reason, count, ...detail };
}

function maintainerDecisionAction(): ApplySkipNextActionDetail {
  return {
    bucket: "maintainer_review",
    owner: "maintainer",
    retryable: false,
    label: "Maintainer decision",
    summary: "A protected label or policy exemption blocks automated pruning.",
    next_step: "Confirm the policy should remain, or close manually if it should not.",
  };
}

function reportRepairAction(): ApplySkipNextActionDetail {
  return {
    bucket: "report_quality_repair",
    owner: "clawsweeper",
    retryable: true,
    label: "Repair review report",
    summary: "The durable review record is missing or invalid for apply.",
    next_step: "Queue a fresh review so apply receives a complete, valid decision.",
  };
}

function alreadyResolvedAction(): ApplySkipNextActionDetail {
  return {
    bucket: "already_resolved",
    owner: "none",
    retryable: false,
    label: "Already resolved",
    summary: "The item was not open by the time apply checked it.",
    next_step: "No action is needed unless this bucket dominates repeated runs.",
  };
}

function applyCycleSummary(options: {
  mode: string;
  cursorRequired: boolean;
  candidateCount: number | null;
  candidateCounts: ApplyCandidateCounts | null;
  cursorAdvanceCount: number | null;
  scheduledIntervalMinutes: number | null;
}): ApplyCycleSummary {
  const closeCursorMode =
    String(options.mode || "").toLowerCase() === "close" && options.cursorRequired;
  const windowSize =
    options.cursorAdvanceCount !== null && options.cursorAdvanceCount > 0
      ? options.cursorAdvanceCount
      : null;
  const cadence = options.scheduledIntervalMinutes;
  if (!closeCursorMode) {
    return {
      basis: "not_close_cursor",
      apply_ready_count: options.candidateCount,
      candidate_counts: options.candidateCounts,
      window_size: windowSize,
      estimated_full_cycle_windows: null,
      estimated_full_cycle_minutes: null,
      scheduled_interval_minutes: cadence,
      label: "Cycle estimate is only reported for scheduled close cursor windows.",
    };
  }
  if (options.candidateCount === null) {
    return {
      basis: "missing_candidate_count",
      apply_ready_count: null,
      candidate_counts: options.candidateCounts,
      window_size: windowSize,
      estimated_full_cycle_windows: null,
      estimated_full_cycle_minutes: null,
      scheduled_interval_minutes: cadence,
      label: "Cycle estimate is unavailable because the close-candidate count was not recorded.",
    };
  }
  if (options.candidateCount === 0) {
    return {
      basis: "no_apply_ready_candidates",
      apply_ready_count: 0,
      candidate_counts: options.candidateCounts,
      window_size: windowSize,
      estimated_full_cycle_windows: 0,
      estimated_full_cycle_minutes: 0,
      scheduled_interval_minutes: cadence,
      label: zeroCandidateCycleLabel(options.candidateCounts),
    };
  }
  if (!windowSize) {
    return {
      basis: "missing_window_size",
      apply_ready_count: options.candidateCount,
      candidate_counts: options.candidateCounts,
      window_size: null,
      estimated_full_cycle_windows: null,
      estimated_full_cycle_minutes: null,
      scheduled_interval_minutes: cadence,
      label: "Cycle estimate is unavailable because no scan window size was recorded.",
    };
  }
  const windows = Math.ceil(options.candidateCount / windowSize);
  const minutes = cadence && cadence > 0 ? windows * cadence : null;
  return {
    basis: "scheduled_close_cursor",
    apply_ready_count: options.candidateCount,
    candidate_counts: options.candidateCounts,
    window_size: windowSize,
    estimated_full_cycle_windows: windows,
    estimated_full_cycle_minutes: minutes,
    scheduled_interval_minutes: cadence,
    label: cycleLabel(
      options.candidateCount,
      windowSize,
      windows,
      minutes,
      cadence,
      options.candidateCounts,
    ),
  };
}

function cycleLabel(
  candidateCount: number,
  windowSize: number,
  windows: number,
  minutes: number | null,
  cadence: number | null,
  counts: ApplyCandidateCounts | null,
): string {
  const base = `${candidateCount} currently actionable close candidates${candidateCountBreakdown(counts)} at ${windowSize} records per latest cursor advance: about ${windows} window${windows === 1 ? "" : "s"}`;
  if (!minutes || !cadence) return `${base}.`;
  return `${base}; scheduled cadence alone would take roughly ${durationLabel(minutes)} at ${cadence}-minute intervals, while successful windows can continue sooner.`;
}

function zeroCandidateCycleLabel(counts: ApplyCandidateCounts | null): string {
  if (!counts) return "No currently actionable close candidates are waiting in this lane.";
  const coolingPromotions = Math.max(
    0,
    counts.promotion_total - counts.promotion_cooldown_eligible,
  );
  const eligibleBacklog = counts.cooldown_eligible_total
    ? ` ${counts.cooldown_eligible_total} candidate${counts.cooldown_eligible_total === 1 ? " meets" : "s meet"} cooldown rules but none were admitted by this scheduler window.`
    : "";
  const suffix = coolingPromotions
    ? ` ${coolingPromotions} promotion probe${coolingPromotions === 1 ? " is" : "s are"} cooling down.`
    : "";
  return `No currently actionable close candidates are waiting in this lane.${eligibleBacklog}${suffix}`;
}

function candidateCountBreakdown(counts: ApplyCandidateCounts | null): string {
  if (!counts) return "";
  const confirmed = `${counts.confirmed_proposal} confirmed proposal${counts.confirmed_proposal === 1 ? "" : "s"}`;
  const guarded = `${counts.guarded_retry} guarded ${counts.guarded_retry === 1 ? "retry" : "retries"}`;
  const promotions = `${counts.promotion_eligible}/${counts.promotion_total} promotion probe${counts.promotion_total === 1 ? "" : "s"} admitted`;
  const proof = `${counts.proof_required} ${counts.proof_required === 1 ? "requires" : "require"} proof`;
  const inconsistent = `${counts.inconsistent_or_stale} inconsistent or stale record${counts.inconsistent_or_stale === 1 ? "" : "s"} excluded`;
  const cooldownBacklog = `${counts.cooldown_eligible_total} cooldown-eligible backlog (${counts.promotion_cooldown_eligible} promotions)`;
  return ` (${confirmed}, ${guarded}, ${promotions}; ${proof}; ${cooldownBacklog}; ${inconsistent})`;
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
function applyReportHealthSummary(options: {
  status: ApplyReportSummary["status"];
  examined: number | null;
  actionRecords: number;
  processedLimit: number | null;
  closed: number;
  commentSynced: number;
  skipped: number;
  cursor: ApplyReportSummary["cursor"];
  attentionReasons: string[];
}): string {
  const actionRecords =
    options.processedLimit === null
      ? `${options.actionRecords} action records`
      : `${options.actionRecords}/${options.processedLimit} action records`;
  const examined =
    options.examined === null ? "examined count unavailable" : `${options.examined} examined`;
  if (options.status === "idle") {
    return `Apply produced no action records in this run; ${examined}.`;
  }
  const cursorText = options.cursor
    ? `cursor at #${options.cursor.next_after_number}`
    : "no cursor recorded";
  const base = `${examined}; ${actionRecords}; ${options.closed} closed, ${options.commentSynced} comments synced, ${options.skipped} skipped; ${cursorText}.`;
  if (options.attentionReasons.length === 0) return base;
  return `${base} Attention: ${options.attentionReasons.join(", ")}.`;
}

export function countCommandActions(reportPath: string, action: string, status = ""): number {
  const report = readJsonObject(reportPath);
  const commands: JsonValue[] = Array.isArray(report.commands) ? report.commands : [];
  const statuses = new Set(
    status
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return commands
    .flatMap((command: JsonValue): JsonValue[] =>
      isJsonObject(command) && Array.isArray(command.actions) ? command.actions : [],
    )
    .filter((entry: JsonValue): entry is LooseRecord => isJsonObject(entry))
    .filter((entry: LooseRecord) => entry.action === action)
    .filter((entry: LooseRecord) => statuses.size === 0 || statuses.has(String(entry.status)))
    .length;
}

export function countRequeueRequired(reportDir: string): number {
  return resultFiles(reportDir)
    .flatMap((file) => resultActions(file))
    .filter((action) => action.requeue_required === true).length;
}

export function mergeApplyReports(reportDir: string, outputPath: string): void {
  const reports = fs.existsSync(reportDir)
    ? fs
        .readdirSync(reportDir)
        .filter((name) => /^apply-report-\d+\.json$/.test(name))
        .sort((left, right) => checkpointNumber(left) - checkpointNumber(right))
    : [];
  const combined = reports.flatMap((name) => readApplyActions(path.join(reportDir, name)));
  fs.writeFileSync(outputPath, `${JSON.stringify(combined, null, 2)}\n`);
}

type ProposedItemOptions = {
  targetRepo: string;
  applyKind: string;
  applyCloseReasons: string;
  staleMinAgeDays: number;
  minAgeDays: number;
  minAgeMinutes: number | null;
  batchSize?: number | null;
  cursorPath?: string | null;
  coverageProofLimit?: number | null;
  closeLimit?: number | null;
  itemNumbers?: ReadonlySet<number> | null;
};

type CommentSyncBatchOptions = {
  targetRepo: string;
  applyKind: string;
  batchSize: number;
  cursorPath: string;
};

export function proposedItemNumbers(options: ProposedItemOptions): number[] {
  return selectedProposedItemCandidates(options, "all").map((candidate) => candidate.number);
}

export function proposedItemCount(options: ProposedItemOptions): number {
  return proposedItemInventory(options).eligible_total;
}

export function proposedItemInventory(options: ProposedItemOptions): ProposedItemInventory {
  return proposedItemInventorySelection(options).inventory;
}

function proposedItemInventorySelection(options: ProposedItemOptions): {
  inventory: ProposedItemInventory;
  itemNumbers: number[];
} {
  const nowMs = Date.now();
  const allCandidates = selectedProposedItemCandidates(
    { ...options, batchSize: null, cursorPath: null },
    "all",
  );
  const cooldownEligibleCandidates = allCandidates.filter(
    (candidate) =>
      candidate.stage !== "promotion_probe" || !promotionProbeCoolingDown(candidate, nowMs),
  );
  const eligibleCandidates =
    options.batchSize && options.batchSize > 0
      ? selectedProposedItemCandidates(options, "all", allCandidates, nowMs)
      : cooldownEligibleCandidates;
  const candidateNumbers = new Set(allCandidates.map((candidate) => candidate.number));
  const confirmedCandidates = eligibleCandidates.filter(
    (candidate) => candidate.stage === "confirmed_close",
  );
  return {
    itemNumbers: eligibleCandidates.map((candidate) => candidate.number),
    inventory: {
      eligible_total: eligibleCandidates.length,
      confirmed_proposal: confirmedCandidates.filter(
        (candidate) => candidate.action === "proposed_close",
      ).length,
      guarded_retry: confirmedCandidates.filter(
        (candidate) => candidate.action !== "proposed_close",
      ).length,
      proof_required: eligibleCandidates.filter((candidate) => candidate.coverageProof).length,
      promotion_total: allCandidates.filter((candidate) => candidate.stage === "promotion_probe")
        .length,
      promotion_eligible: eligibleCandidates.filter(
        (candidate) => candidate.stage === "promotion_probe",
      ).length,
      promotion_cooldown_eligible: cooldownEligibleCandidates.filter(
        (candidate) => candidate.stage === "promotion_probe",
      ).length,
      cooldown_eligible_total: cooldownEligibleCandidates.length,
      inconsistent_or_stale: inconsistentOrStaleProposedItemCount(options, candidateNumbers),
    },
  };
}

function printProposedItemInventory(options: ProposedItemOptions): void {
  const { inventory, itemNumbers } = proposedItemInventorySelection(options);
  const candidateCounts: ApplyCandidateCounts = {
    confirmed_proposal: inventory.confirmed_proposal,
    guarded_retry: inventory.guarded_retry,
    proof_required: inventory.proof_required,
    promotion_total: inventory.promotion_total,
    promotion_eligible: inventory.promotion_eligible,
    promotion_cooldown_eligible: inventory.promotion_cooldown_eligible,
    cooldown_eligible_total: inventory.cooldown_eligible_total,
    inconsistent_or_stale: inventory.inconsistent_or_stale,
  };
  printOutput({
    item_numbers: itemNumbers.join(","),
    apply_ready_count: String(inventory.eligible_total),
    confirmed_proposal: String(inventory.confirmed_proposal),
    guarded_retry: String(inventory.guarded_retry),
    proof_required: String(inventory.proof_required),
    promotion_total: String(inventory.promotion_total),
    promotion_eligible: String(inventory.promotion_eligible),
    promotion_cooldown_eligible: String(inventory.promotion_cooldown_eligible),
    cooldown_eligible_total: String(inventory.cooldown_eligible_total),
    inconsistent_or_stale: String(inventory.inconsistent_or_stale),
    candidate_counts_json: JSON.stringify(candidateCounts),
  });
}

export function proposedPrCloseCoverageItemNumbers(options: ProposedItemOptions): number[] {
  return selectedProposedItemCandidates(options, "pr-close-coverage-proof").map(
    (candidate) => candidate.number,
  );
}

type ProposedItemSelection = "all" | "pr-close-coverage-proof" | "quality-summary";

type ProposedItemCandidate = {
  number: number;
  applyCheckedAt: string;
  reviewedAt: string;
  kind: string;
  closeReason: string;
  action: string;
  stage: "confirmed_close" | "promotion_probe";
  coverageProof: boolean;
  qualityBucket: ProposedItemQualityBucket;
};

type ProposedItemQualityBucket =
  | "ready_implemented"
  | "duplicate_or_superseded"
  | "needs_pr_close_coverage"
  | "promotion_probe"
  | "aging_or_low_signal"
  | "policy_sensitive"
  | "retry_after_guard_skip"
  | "other";

type ProposedItemQualityBucketSummary = {
  bucket: ProposedItemQualityBucket;
  label: string;
  count: number;
  next_step: string;
};

type ProposedItemQualitySummary = {
  schema_version: 1;
  total: number;
  summary: string;
  buckets: ProposedItemQualityBucketSummary[];
};

const FAST_CLOSE_BUCKET_ORDER: ProposedItemQualityBucket[] = [
  "ready_implemented",
  "duplicate_or_superseded",
  "other",
  "aging_or_low_signal",
  "policy_sensitive",
  "retry_after_guard_skip",
  "needs_pr_close_coverage",
  "promotion_probe",
];

// Promotion probes hydrate related live graphs; a fresh review bypasses this daily backoff.
const APPLY_PROMOTION_PROBE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const ALLOWED_CLOSE_REASONS = new Set([
  "abandoned_pr",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "incoherent",
  "implemented_on_main",
  "low_signal_unmergeable_pr",
  "mostly_implemented_on_main",
  "not_actionable_in_repo",
  "stalled_unproven_pr",
  "stale_insufficient_info",
  "unconfirmed_product_direction",
]);

function prioritizeFastCloseCandidates(
  candidates: ProposedItemCandidate[],
): ProposedItemCandidate[] {
  const rank = new Map(FAST_CLOSE_BUCKET_ORDER.map((bucket, index) => [bucket, index]));
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        (rank.get(left.candidate.qualityBucket) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.candidate.qualityBucket) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}

function selectedProposedItemCandidates(
  options: ProposedItemOptions,
  selection: ProposedItemSelection,
  candidateSnapshot?: readonly ProposedItemCandidate[],
  nowMs = Date.now(),
): ProposedItemCandidate[] {
  const itemsDir = path.join("records", targetSlug(options.targetRepo), "items");
  if (!candidateSnapshot && !fs.existsSync(itemsDir)) return [];

  const allowedCloseReasons =
    options.applyCloseReasons === "all"
      ? null
      : new Set(
          options.applyCloseReasons
            .split(",")
            .map((reason) => reason.trim())
            .filter(Boolean),
        );
  const minAgeMs =
    options.minAgeMinutes === null
      ? options.minAgeDays * 24 * 60 * 60 * 1000
      : options.minAgeMinutes * 60 * 1000;

  const candidates: ProposedItemCandidate[] = candidateSnapshot
    ? [...candidateSnapshot]
    : fs
        .readdirSync(itemsDir)
        .filter((name) => /(?:^|[a-z0-9-]-)\d+\.md$/.test(name))
        .flatMap((name) => {
          const number = numberFor(name);
          if (options.itemNumbers && !options.itemNumbers.has(number)) return [];
          const markdown = fs.readFileSync(path.join(itemsDir, name), "utf8");
          if (repoFor(markdown, name) !== options.targetRepo) return [];
          const type = frontMatterValue(markdown, "type");
          if (options.applyKind !== "all" && type && type !== options.applyKind) return [];
          const decision = frontMatterValue(markdown, "decision");
          const action = frontMatterValue(markdown, "action_taken");
          const confidence = frontMatterValue(markdown, "confidence");
          const reason = frontMatterValue(markdown, "close_reason");
          const selectableClose =
            decision === "close" &&
            confidence === "high" &&
            isSelectableCloseAction(action, reason) &&
            allowedForTarget(options.targetRepo, type, reason, ALLOWED_CLOSE_REASONS) &&
            (!allowedCloseReasons || allowedCloseReasons.has(reason));
          const promotionCloseReasons = pullRequestClosePromotionReasons(
            markdown,
            options.targetRepo,
            {
              staleMinAgeMs: options.staleMinAgeDays * 24 * 60 * 60 * 1000,
            },
          );
          const selectedPromotionCloseReasons = promotionCloseReasons.filter(
            (promotionReason) =>
              allowedForTarget(options.targetRepo, type, promotionReason, ALLOWED_CLOSE_REASONS) &&
              (!allowedCloseReasons || allowedCloseReasons.has(promotionReason)),
          );
          const selectablePromotion =
            decision === "keep_open" &&
            action === "kept_open" &&
            type === "pull_request" &&
            frontMatterValue(markdown, "review_status") === "complete" &&
            frontMatterValue(markdown, "local_checkout_access") === "verified" &&
            hasPullRequestClosePromotionSignal(markdown, options.targetRepo, {
              staleMinAgeMs: options.staleMinAgeDays * 24 * 60 * 60 * 1000,
            }) &&
            selectedPromotionCloseReasons.length > 0;
          const selectableProofPromotion =
            selectablePromotion &&
            selectedPromotionCloseReasons.includes("duplicate_or_superseded") &&
            hasLinkedPullRequestSupersessionSignal(markdown, options.targetRepo);
          if (!selectableClose && !selectablePromotion) return [];
          const prCloseCoverageProofCanRun =
            type === "pull_request" &&
            ((selectableClose && reason === "duplicate_or_superseded") || selectableProofPromotion);
          if (selection === "pr-close-coverage-proof" && !prCloseCoverageProofCanRun) return [];
          if (
            (reason === "stale_insufficient_info" || reason === "mostly_implemented_on_main") &&
            !olderThan(
              frontMatterValue(markdown, "item_created_at"),
              options.staleMinAgeDays * 24 * 60 * 60 * 1000,
            )
          ) {
            return [];
          }
          if (!olderThan(frontMatterValue(markdown, "item_created_at"), minAgeMs)) return [];
          const candidateCloseReason = selectablePromotion
            ? selectedPromotionCloseReasons[0]!
            : reason;
          return [
            {
              number,
              applyCheckedAt: frontMatterValue(markdown, "apply_checked_at"),
              reviewedAt: frontMatterValue(markdown, "reviewed_at"),
              kind: type,
              closeReason: candidateCloseReason,
              action,
              stage: selectablePromotion
                ? ("promotion_probe" as const)
                : ("confirmed_close" as const),
              coverageProof: prCloseCoverageProofCanRun,
              qualityBucket: proposedItemQualityBucket({
                action,
                closeReason: candidateCloseReason,
                prCloseCoverageProofCanRun,
                promotionProbe: selectablePromotion,
              }),
            },
          ];
        })
        .sort((left, right) => left.number - right.number);
  const batchSize = options.batchSize ?? null;
  if (!batchSize || batchSize <= 0) return candidates;
  const coolDownPromotionProbes = !options.itemNumbers || options.itemNumbers.size === 0;
  const readyCandidates = candidates.filter(
    (candidate) =>
      candidate.stage !== "promotion_probe" ||
      !coolDownPromotionProbes ||
      !promotionProbeCoolingDown(candidate, nowMs),
  );
  const cursor = options.cursorPath ? readApplyCursor(options.cursorPath) : null;
  const rotate = (
    stage: ProposedItemCandidate["stage"],
    coverageProof: boolean | null,
    position: ApplyCursorPosition | null,
  ): ProposedItemCandidate[] => {
    const sorted = readyCandidates
      .filter(
        (candidate) =>
          candidate.stage === stage &&
          (coverageProof === null || candidate.coverageProof === coverageProof),
      )
      .sort(compareApplyCursorCandidate);
    if (!position) return sorted;
    const afterCursor = sorted.filter(
      (candidate) => compareCandidateToApplyCursor(candidate, position) > 0,
    );
    return [
      ...afterCursor,
      ...sorted.filter((candidate) => compareCandidateToApplyCursor(candidate, position) <= 0),
    ];
  };

  // Confirmed close proposals have already passed review eligibility. Keep
  // speculative keep-open promotions as bounded backfill so their live graph
  // hydration cannot consume an entire apply window ahead of real proposals.
  if (options.coverageProofLimit === null || options.coverageProofLimit === undefined) {
    return [
      ...prioritizeFastCloseCandidates(rotate("confirmed_close", null, cursor)),
      ...rotate("promotion_probe", null, cursor),
    ].slice(0, batchSize);
  }

  const closeLimit = Math.max(1, Math.min(options.closeLimit ?? batchSize, batchSize));
  const proofLimit = Math.max(0, Math.min(options.coverageProofLimit, batchSize, closeLimit));
  const fastConfirmedCandidates = prioritizeFastCloseCandidates(
    rotate("confirmed_close", false, cursor),
  );
  const proofCursor = cursor?.coverageProof ?? cursor;
  // Preserve confirmed proof work ahead of speculative promotions. Any reserve
  // left after confirmed proofs lets the promotion-proof pool rotate independently.
  const proofCandidates = [
    ...rotate("confirmed_close", true, proofCursor),
    ...rotate("promotion_probe", true, proofCursor),
  ];
  const selectedProof = proofCandidates.slice(0, proofLimit);
  const selectedFast = fastConfirmedCandidates.slice(0, batchSize - selectedProof.length);
  // Let ready closes run first, but place every reserved proof before those
  // closes could hit the mutation limit and stop the checkpoint. A candidate
  // can close both a PR and its same-author issue counterpart.
  const maxClosesPerCandidate = 2;
  const closesReservedBeforeLastProof = Math.max(0, selectedProof.length - 1) * 2;
  const candidatesBeforeProof = Math.floor(
    Math.max(0, closeLimit - 1 - closesReservedBeforeLastProof) / maxClosesPerCandidate,
  );
  const preProofFastCount = selectedProof.length
    ? Math.min(selectedFast.length, candidatesBeforeProof)
    : selectedFast.length;
  const selectedPromotions = rotate("promotion_probe", false, cursor).slice(
    0,
    batchSize - selectedFast.length - selectedProof.length,
  );
  return [
    ...selectedFast.slice(0, preProofFastCount),
    ...selectedProof,
    ...selectedFast.slice(preProofFastCount),
    ...selectedPromotions,
  ];
}

function inconsistentOrStaleProposedItemCount(
  options: ProposedItemOptions,
  candidateNumbers: ReadonlySet<number>,
): number {
  const itemsDir = path.join("records", targetSlug(options.targetRepo), "items");
  if (!fs.existsSync(itemsDir)) return 0;
  const allowedCloseReasons =
    options.applyCloseReasons === "all"
      ? null
      : new Set(
          options.applyCloseReasons
            .split(",")
            .map((reason) => reason.trim())
            .filter(Boolean),
        );
  const minAgeMs =
    options.minAgeMinutes === null
      ? options.minAgeDays * 24 * 60 * 60 * 1000
      : options.minAgeMinutes * 60 * 1000;
  return fs
    .readdirSync(itemsDir)
    .filter((name) => /(?:^|[a-z0-9-]-)\d+\.md$/.test(name))
    .filter((name) => {
      const number = numberFor(name);
      if (candidateNumbers.has(number)) return false;
      if (options.itemNumbers && !options.itemNumbers.has(number)) return false;
      const markdown = fs.readFileSync(path.join(itemsDir, name), "utf8");
      if (repoFor(markdown, name) !== options.targetRepo) return false;
      const type = frontMatterValue(markdown, "type");
      if (options.applyKind !== "all" && type && type !== options.applyKind) return false;
      const action = frontMatterValue(markdown, "action_taken");
      if (action !== "proposed_close" && action !== "retry_pr_close_coverage_proof") return false;
      const reason = frontMatterValue(markdown, "close_reason");
      if (allowedCloseReasons && !allowedCloseReasons.has(reason)) return false;
      if (
        ALLOWED_CLOSE_REASONS.has(reason) &&
        !allowedForTarget(options.targetRepo, type, reason, ALLOWED_CLOSE_REASONS)
      ) {
        return false;
      }
      const createdAt = frontMatterValue(markdown, "item_created_at");
      if (
        (reason === "stale_insufficient_info" || reason === "mostly_implemented_on_main") &&
        !olderThan(createdAt, options.staleMinAgeDays * 24 * 60 * 60 * 1000)
      ) {
        return false;
      }
      return olderThan(createdAt, minAgeMs);
    }).length;
}

function promotionProbeCoolingDown(candidate: ProposedItemCandidate, nowMs = Date.now()): boolean {
  const checkedAtMs = timestampValue(candidate.applyCheckedAt);
  if (checkedAtMs === 0 || timestampValue(candidate.reviewedAt) > checkedAtMs) return false;
  return nowMs - checkedAtMs < APPLY_PROMOTION_PROBE_COOLDOWN_MS;
}

export function proposedItemQualitySummary(
  options: ProposedItemOptions,
): ProposedItemQualitySummary {
  const candidates = selectedProposedItemCandidates(options, "quality-summary");
  const counts = new Map<ProposedItemQualityBucket, number>();
  for (const candidate of candidates) {
    counts.set(candidate.qualityBucket, (counts.get(candidate.qualityBucket) || 0) + 1);
  }
  const buckets = QUALITY_BUCKET_ORDER.flatMap((bucket) => {
    const count = counts.get(bucket) || 0;
    if (count === 0) return [];
    const metadata = QUALITY_BUCKET_METADATA[bucket];
    return [{ bucket, count, label: metadata.label, next_step: metadata.nextStep }];
  });
  return {
    schema_version: 1,
    total: candidates.length,
    summary: qualitySummaryText(buckets),
    buckets,
  };
}

function printProposedItemQualitySummary(options: ProposedItemOptions): void {
  const summary = proposedItemQualitySummary(options);
  printOutput({
    candidate_quality_total: String(summary.total),
    candidate_quality_summary: summary.summary,
    candidate_quality_buckets_json: JSON.stringify(summary.buckets),
  });
}

const QUALITY_BUCKET_ORDER: ProposedItemQualityBucket[] = [
  "ready_implemented",
  "duplicate_or_superseded",
  "needs_pr_close_coverage",
  "promotion_probe",
  "aging_or_low_signal",
  "policy_sensitive",
  "retry_after_guard_skip",
  "other",
];

const QUALITY_BUCKET_METADATA: Record<
  ProposedItemQualityBucket,
  { label: string; nextStep: string }
> = {
  ready_implemented: {
    label: "implemented-on-main",
    nextStep: "Live-state checks can close these if the item is still unchanged.",
  },
  duplicate_or_superseded: {
    label: "duplicate/superseded",
    nextStep: "Confirm the canonical or superseding item is still valid before close.",
  },
  needs_pr_close_coverage: {
    label: "needs PR close proof",
    nextStep: "Run or reuse close-coverage proof before closing the PR.",
  },
  promotion_probe: {
    label: "needs live promotion check",
    nextStep: "Backfill after confirmed closes and promote only if live safety checks still pass.",
  },
  aging_or_low_signal: {
    label: "aging/low-signal",
    nextStep: "Rely on stale-age and live-state checks; inspect if this bucket dominates.",
  },
  policy_sensitive: {
    label: "policy-sensitive",
    nextStep: "Close only when the explicit policy gate remains enabled.",
  },
  retry_after_guard_skip: {
    label: "retry after guard skip",
    nextStep: "Retry only after the previous guard condition has been rechecked.",
  },
  other: {
    label: "other close candidates",
    nextStep: "Inspect repeated entries and add a deterministic bucket if needed.",
  },
};

function proposedItemQualityBucket(options: {
  action: string;
  closeReason: string;
  prCloseCoverageProofCanRun: boolean;
  promotionProbe: boolean;
}): ProposedItemQualityBucket {
  if (options.promotionProbe) return "promotion_probe";
  if (options.prCloseCoverageProofCanRun) return "needs_pr_close_coverage";
  if (options.closeReason === "unconfirmed_product_direction") return "policy_sensitive";
  if (
    options.closeReason === "abandoned_pr" ||
    options.closeReason === "stale_insufficient_info" ||
    options.closeReason === "stalled_unproven_pr" ||
    options.closeReason === "mostly_implemented_on_main" ||
    options.closeReason === "low_signal_unmergeable_pr"
  ) {
    return "aging_or_low_signal";
  }
  if (
    options.action === "skipped_invalid_decision" ||
    options.action === "skipped_maintainer_authored"
  ) {
    return "retry_after_guard_skip";
  }
  if (options.closeReason === "duplicate_or_superseded") return "duplicate_or_superseded";
  if (options.closeReason === "implemented_on_main" || options.closeReason === "clawhub") {
    return "ready_implemented";
  }
  return "other";
}

function qualitySummaryText(buckets: ProposedItemQualityBucketSummary[]): string {
  if (buckets.length === 0) return "no close candidates";
  return buckets.map((bucket) => `${bucket.count} ${bucket.label}`).join(", ");
}

function compareApplyCursorCandidate(
  left: ProposedItemCandidate,
  right: ProposedItemCandidate,
): number {
  return (
    compareApplyCheckedAt(left.applyCheckedAt, right.applyCheckedAt) || left.number - right.number
  );
}

function compareCandidateToApplyCursor(
  candidate: ProposedItemCandidate,
  cursor: ApplyCursorPosition,
): number {
  return (
    compareApplyCheckedAt(candidate.applyCheckedAt, cursor.applyCheckedAt) ||
    candidate.number - cursor.number
  );
}

function compareApplyCheckedAt(left: string, right: string): number {
  const leftMs = timestampValue(left);
  const rightMs = timestampValue(right);
  return leftMs - rightMs;
}

function timestampValue(value: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const SELECTABLE_CLOSE_ACTIONS = new Set([
  "proposed_close",
  "retry_pr_close_coverage_proof",
  "kept_open",
  "skipped_open_closing_pr",
  "skipped_same_author_pair",
]);

const RETRYABLE_CLOSE_SKIP_ACTIONS = new Set([
  "skipped_maintainer_authored",
  "skipped_invalid_decision",
]);

function isSelectableCloseAction(action: string, reason: string): boolean {
  if (RETRYABLE_CLOSE_SKIP_ACTIONS.has(action)) return reason === "implemented_on_main";
  return SELECTABLE_CLOSE_ACTIONS.has(action);
}

function hasPullRequestClosePromotionSignal(
  markdown: string,
  targetRepo: string,
  options: { staleMinAgeMs: number },
): boolean {
  return (
    hasLinkedPullRequestSupersessionSignal(markdown, targetRepo) ||
    ((hasRecommendedPauseOrCloseOption(markdown) ||
      hasLowSignalPullRequestPromotionSignal(markdown)) &&
      olderThan(frontMatterValue(markdown, "item_created_at"), options.staleMinAgeMs))
  );
}

function pullRequestClosePromotionReasons(
  markdown: string,
  targetRepo: string,
  options: { staleMinAgeMs: number },
): Array<"duplicate_or_superseded" | "low_signal_unmergeable_pr"> {
  const linkedSupersession = hasLinkedPullRequestSupersessionSignal(markdown, targetRepo);
  const recommendedPauseOrClose = hasRecommendedPauseOrCloseOption(markdown);
  const reasons: Array<"duplicate_or_superseded" | "low_signal_unmergeable_pr"> = [];
  if (linkedSupersession || recommendedPauseOrClose) reasons.push("duplicate_or_superseded");
  // Pause-or-close is a deterministic duplicate promotion. A linked PR is only
  // speculative until live hydration, so an F-rated report can still fall back
  // to the low-signal promotion when that linked candidate does not cover it.
  if (
    !recommendedPauseOrClose &&
    hasLowSignalPullRequestPromotionSignal(markdown) &&
    olderThan(frontMatterValue(markdown, "item_created_at"), options.staleMinAgeMs)
  ) {
    reasons.push("low_signal_unmergeable_pr");
  }
  return reasons;
}

function hasLinkedPullRequestSupersessionSignal(markdown: string, targetRepo: string): boolean {
  const pullRef = sameRepoPullRequestRefRegex(targetRepo);
  if (!pullRef) return false;
  const signal =
    /\b(supersed(?:e|ed|es|ing)|replace(?:s|d|ment)?|duplicate|duplicated|canonical|covered by|landed in)\b/i;
  return closePromotionSignalTexts(markdown).some(
    (text) =>
      pullRef.test(normalizePullRequestMarkdownLinks(text, targetRepo)) && signal.test(text),
  );
}

function normalizePullRequestMarkdownLinks(value: string, targetRepo: string): string {
  const sameRepoPullRequestUrl = sameRepoPullRequestUrlRegex(targetRepo);
  if (!sameRepoPullRequestUrl) return value;
  return value.replace(markdownLinkRegex(), (_link, target: string) =>
    sameRepoPullRequestUrl.test(target) ? target : " ",
  );
}

function markdownLinkRegex(): RegExp {
  return /\[[^\]\n]{1,200}\]\(([^\s)]{1,1000})\)/gi;
}

function sameRepoPullRequestUrlRegex(targetRepo: string): RegExp | null {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) return null;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
  return new RegExp(`^https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/\\d+\\b`, "i");
}

function sameRepoPullRequestRefRegex(targetRepo: string): RegExp | null {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) return null;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
  return new RegExp(
    [
      `https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/\\d+\\b`,
      `(?:^|[^\\w/.-])${escapedRepo}#\\d+\\b`,
      "(?:^|[^\\w/#-])#\\d+\\b",
    ].join("|"),
    "i",
  );
}

function hasRecommendedPauseOrCloseOption(markdown: string): boolean {
  return jsonArrayFrontMatter(markdown, "merge_risk_options").some((entry) => {
    if (!isJsonObject(entry)) return false;
    return entry.category === "pause_or_close" && entry.recommended === true;
  });
}

function hasLowSignalPullRequestPromotionSignal(markdown: string): boolean {
  const ratingSection = sectionValue(markdown, "PR Rating");
  const proofSection = sectionValue(markdown, "Real Behavior Proof");
  const overallTier =
    sectionLineValue(ratingSection, "Overall tier") ||
    frontMatterValue(markdown, "pr_rating_overall");
  const proofTier =
    sectionLineValue(ratingSection, "Proof tier") || frontMatterValue(markdown, "pr_rating_proof");
  const proofStatus =
    sectionLineValue(proofSection, "Status") ||
    frontMatterValue(markdown, "real_behavior_proof_status");
  return (
    overallTier === "F" &&
    (proofTier === "F" || ["missing", "mock_only", "insufficient"].includes(proofStatus))
  );
}

function closePromotionSignalTexts(markdown: string): string[] {
  return [
    ...stringArrayFrontMatter(markdown, "work_cluster_refs"),
    ...jsonArrayFrontMatter(markdown, "merge_risk_options").flatMap((entry) =>
      isJsonObject(entry) ? [stringValue(entry.title), stringValue(entry.body)] : [],
    ),
    sectionValue(markdown, "Best Possible Solution"),
    sectionValue(markdown, "Evidence"),
    sectionValue(markdown, "Close Comment"),
  ].filter(Boolean);
}

export function commentSyncBatchOutput(options: CommentSyncBatchOptions): Record<string, string> {
  const candidates = commentSyncCandidates(options.targetRepo, options.applyKind);
  const cursor = readCommentSyncCursor(options.cursorPath);
  const afterCursor = candidates.filter((number) => number > cursor).slice(0, options.batchSize);
  const selected =
    afterCursor.length > 0
      ? afterCursor
      : candidates.filter((number) => number > 0).slice(0, options.batchSize);
  const nextCursor = selected.length > 0 ? selected[selected.length - 1] : cursor;
  return {
    item_numbers: selected.join(","),
    count: String(selected.length),
    cursor: String(cursor),
    next_cursor: String(nextCursor),
    wrapped: String(candidates.length > 0 && afterCursor.length === 0),
  };
}

export function writeCommentSyncCursor(
  cursorPath: string,
  nextCursor: number,
  targetRepo: string,
): void {
  if (!Number.isInteger(nextCursor) || nextCursor < 0) {
    throw new Error("--next-cursor must be a non-negative integer");
  }
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(
    cursorPath,
    `${JSON.stringify(
      {
        target_repo: targetRepo,
        next_after_number: nextCursor,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

type ApplyCursorPosition = {
  applyCheckedAt: string;
  number: number;
};

type ApplyCursor = ApplyCursorPosition & {
  updatedAt: string | null;
  coverageProof: ApplyCursorPosition | null;
};

function readApplyCursor(cursorPath: string): ApplyCursor | null {
  if (!fs.existsSync(cursorPath)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  if (!isJsonObject(parsed)) return null;
  const number = Number(parsed.next_after_number);
  if (!Number.isInteger(number) || number < 0) return null;
  const applyCheckedAt =
    typeof parsed.next_after_apply_checked_at === "string"
      ? parsed.next_after_apply_checked_at
      : "";
  const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : null;
  const coverageProof = applyCursorPosition(parsed.coverage_proof_cursor);
  return { number, applyCheckedAt, updatedAt, coverageProof };
}

function applyCursorPosition(value: unknown): ApplyCursorPosition | null {
  if (!isJsonObject(value)) return null;
  const number = Number(value.next_after_number);
  if (!Number.isInteger(number) || number < 0) return null;
  const applyCheckedAt =
    typeof value.next_after_apply_checked_at === "string" ? value.next_after_apply_checked_at : "";
  return { number, applyCheckedAt };
}

function readApplyCursorForSummary(cursorPath: string): ApplyReportSummary["cursor"] {
  if (!cursorPath) return null;
  const cursor = readApplyCursor(cursorPath);
  if (!cursor) return null;
  return {
    path: cursorPath,
    next_after_number: cursor.number,
    next_after_apply_checked_at: cursor.applyCheckedAt || null,
    updated_at: cursor.updatedAt,
  };
}

export function writeApplyCursor(
  cursorPath: string,
  reportPath: string,
  targetRepo: string,
  itemNumbers = "",
  coverageProofItemNumbers = "",
  cursorTracePath = "",
): void {
  const previous = readApplyCursor(cursorPath);
  const selected = positiveCsvNumbers(itemNumbers);
  const proofNumbers = new Set(positiveCsvNumbers(coverageProofItemNumbers));
  const examined = cursorTracePath
    ? readApplyCursorTrace(cursorTracePath)
    : readApplyActions(reportPath).flatMap((action) =>
        typeof action.number === "number" && action.number > 0 ? [action.number] : [],
      );
  const examinedSet = new Set(examined);
  const fastSelected = selected.filter((number) => !proofNumbers.has(number));
  const proofSelected = selected.filter((number) => proofNumbers.has(number));
  const legacyAdvance = !coverageProofItemNumbers && !cursorTracePath;
  const fastNumber = legacyAdvance
    ? applyCursorAdvance(reportPath, itemNumbers).number
    : (lastExaminedSelectedNumber(fastSelected, examinedSet) ?? previous?.number ?? 0);
  const previousProof = previous?.coverageProof ?? previous;
  const proofNumber =
    lastExaminedSelectedNumber(proofSelected, examinedSet) ?? previousProof?.number ?? 0;
  const applyCheckedAt = fastNumber > 0 ? applyCheckedAtForItem(targetRepo, fastNumber) : "";
  const proofApplyCheckedAt = proofNumber > 0 ? applyCheckedAtForItem(targetRepo, proofNumber) : "";
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(
    cursorPath,
    `${JSON.stringify(
      {
        target_repo: targetRepo,
        next_after_number: fastNumber,
        next_after_apply_checked_at: applyCheckedAt,
        ...(coverageProofItemNumbers || cursorTracePath
          ? {
              coverage_proof_cursor: {
                next_after_number: proofNumber,
                next_after_apply_checked_at: proofApplyCheckedAt,
              },
            }
          : {}),
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

export function applyCursorAdvanceCount(
  reportPath: string,
  itemNumbers = "",
  cursorTracePath = "",
): number {
  if (cursorTracePath) return new Set(readApplyCursorTrace(cursorTracePath)).size;
  return applyCursorAdvance(reportPath, itemNumbers).count;
}

function applyCursorAdvance(
  reportPath: string,
  itemNumbers: string,
): { number: number; count: number } {
  const processed = readApplyActions(reportPath).flatMap((action) =>
    typeof action.number === "number" ? [action.number] : [],
  );
  const selected = positiveCsvNumbers(itemNumbers);
  if (selected.length === 0) {
    return {
      number: processed.at(-1) ?? 0,
      count: new Set(processed).size,
    };
  }
  const processedSet = new Set(processed);
  const lastProcessedIndex = selected.findLastIndex((number) => processedSet.has(number));
  const cursorIndex = lastProcessedIndex >= 0 ? lastProcessedIndex : selected.length - 1;
  return {
    number: selected[cursorIndex] ?? 0,
    count: cursorIndex + 1,
  };
}

function positiveCsvNumbers(value: string): number[] {
  return csvItems(value)
    .map((item) => Number(item))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function lastExaminedSelectedNumber(
  selected: readonly number[],
  examined: ReadonlySet<number>,
): number | null {
  const index = selected.findLastIndex((number) => examined.has(number));
  return index >= 0 ? (selected[index] ?? null) : null;
}

function readApplyCursorTrace(tracePath: string): number[] {
  if (!fs.existsSync(tracePath)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  if (!isJsonObject(parsed) || !Array.isArray(parsed.examined_item_numbers)) return [];
  return parsed.examined_item_numbers
    .map((number) => Number(number))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function applyCheckedAtForItem(targetRepo: string, itemNumber: number): string {
  const baseDir = path.join("records", targetSlug(targetRepo));
  for (const stateDir of ["items", "closed"]) {
    const dir = path.join(baseDir, stateDir);
    if (!fs.existsSync(dir)) continue;
    const name = fs
      .readdirSync(dir)
      .find((entry) => /(?:^|[a-z0-9-]-)\d+\.md$/.test(entry) && numberFor(entry) === itemNumber);
    if (!name) continue;
    return frontMatterValue(fs.readFileSync(path.join(dir, name), "utf8"), "apply_checked_at");
  }
  return "";
}

function applyCandidateCounts(value: string): ApplyCandidateCounts | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("candidate-counts-json must be valid JSON");
  }
  if (!isJsonObject(parsed)) throw new Error("candidate-counts-json must be an object");
  const keys: Array<keyof ApplyCandidateCounts> = [
    "confirmed_proposal",
    "guarded_retry",
    "proof_required",
    "promotion_total",
    "promotion_eligible",
    "promotion_cooldown_eligible",
    "cooldown_eligible_total",
    "inconsistent_or_stale",
  ];
  const counts = {} as ApplyCandidateCounts;
  for (const key of keys) {
    const count = Number(parsed[key]);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`candidate-counts-json.${key} must be a non-negative integer`);
    }
    counts[key] = count;
  }
  if (counts.promotion_eligible > counts.promotion_total) {
    throw new Error("candidate-counts-json.promotion_eligible cannot exceed promotion_total");
  }
  if (counts.promotion_cooldown_eligible > counts.promotion_total) {
    throw new Error(
      "candidate-counts-json.promotion_cooldown_eligible cannot exceed promotion_total",
    );
  }
  if (counts.promotion_eligible > counts.promotion_cooldown_eligible) {
    throw new Error(
      "candidate-counts-json.promotion_eligible cannot exceed promotion_cooldown_eligible",
    );
  }
  return counts;
}

function proposedItemOptions(): ProposedItemOptions {
  const batchSizeText = optionalString("batch-size");
  const coverageProofLimitText = optionalString("coverage-proof-limit");
  const closeLimitText = optionalString("close-limit");
  return {
    targetRepo: requiredString("target-repo"),
    applyKind: optionalString("apply-kind") || "all",
    applyCloseReasons: optionalString("apply-close-reasons") || "all",
    staleMinAgeDays: numberArg("stale-min-age-days", 60),
    minAgeDays: numberArg("min-age-days", 0),
    minAgeMinutes: optionalString("min-age-minutes") ? numberArg("min-age-minutes", 0) : null,
    batchSize: batchSizeText ? numberArg("batch-size", 0) : null,
    cursorPath: optionalString("cursor-path") || null,
    coverageProofLimit: coverageProofLimitText ? numberArg("coverage-proof-limit", 0) : null,
    closeLimit: closeLimitText ? numberArg("close-limit", 1) : null,
    itemNumbers: itemNumberSet(optionalString("item-numbers")),
  };
}

function commentSyncBatchOptions(): CommentSyncBatchOptions {
  return {
    targetRepo: requiredString("target-repo"),
    applyKind: optionalString("apply-kind") || "pull_request",
    batchSize: numberArg("batch-size", 25),
    cursorPath: requiredString("cursor-path"),
  };
}

function commentSyncCandidates(targetRepo: string, applyKind: string): number[] {
  const targetSlug = targetRepo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const itemsDir = path.join("records", targetSlug, "items");
  if (!fs.existsSync(itemsDir)) return [];

  return fs
    .readdirSync(itemsDir)
    .filter((name) => /(?:^|[a-z0-9-]-)\d+\.md$/.test(name))
    .flatMap((name) => {
      const markdown = fs.readFileSync(path.join(itemsDir, name), "utf8");
      if (repoFor(markdown, name) !== targetRepo) return [];
      const type = frontMatterValue(markdown, "type");
      if (applyKind !== "all" && type !== applyKind) return [];
      if (frontMatterValue(markdown, "review_status") !== "complete") return [];
      if (!frontMatterValue(markdown, "item_snapshot_hash")) return [];
      const actionTaken = frontMatterValue(markdown, "action_taken");
      const storedReviewCommentId = frontMatterValue(markdown, "review_comment_id");
      const storedReviewCommentUrl = frontMatterValue(markdown, "review_comment_url");
      const hasStoredReviewComment =
        Boolean(storedReviewCommentId && !["none", "unknown"].includes(storedReviewCommentId)) &&
        Boolean(storedReviewCommentUrl && !["none", "unknown"].includes(storedReviewCommentUrl));
      const changedDuplicateClose =
        actionTaken === "skipped_changed_since_review" &&
        frontMatterValue(markdown, "decision") === "close" &&
        frontMatterValue(markdown, "close_reason") === "duplicate_or_superseded" &&
        hasStoredReviewComment;
      if (
        actionTaken !== "kept_open" &&
        actionTaken !== "proposed_close" &&
        actionTaken !== "skipped_pr_close_coverage_proof" &&
        actionTaken !== "retry_stale_canonical_comment_sync" &&
        !changedDuplicateClose
      ) {
        return [];
      }
      return [numberFor(name)];
    })
    .sort((left, right) => left - right);
}

function readCommentSyncCursor(cursorPath: string): number {
  if (!fs.existsSync(cursorPath)) return 0;
  const parsed: unknown = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  if (!isJsonObject(parsed)) return 0;
  const cursor = Number(parsed.next_after_number);
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function readApplyActions(reportPath: string): ApplyAction[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${reportPath} must contain an array`);
  return parsed.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.action !== "string") return { action: "" };
    const action: ApplyAction = { action: entry.action };
    if (typeof entry.reason === "string") action.reason = entry.reason;
    const number = Number(entry.number);
    if (Number.isInteger(number) && number > 0) action.number = number;
    return action;
  });
}

function isSuccessfulLabelSyncReason(reason: string | undefined): boolean {
  return /^(?:synced|dry-run: would sync) (?:advisory issue|ClawSweeper) labels$/.test(
    reason || "",
  );
}

function reportsReviewCommentSync(entry: ApplyAction): boolean {
  return (
    entry.action === "review_comment_synced" ||
    (entry.reason || "").split("; ").includes("updated durable Codex review comment")
  );
}

function resultFiles(reportDir: string): string[] {
  if (!fs.existsSync(reportDir)) return [];
  return fs
    .readdirSync(reportDir, { recursive: true })
    .map((entry) => path.join(reportDir, String(entry)))
    .filter((candidate) => ["apply-report.json", "result.json"].includes(path.basename(candidate)))
    .filter((candidate) => fs.statSync(candidate).isFile());
}

function resultActions(reportPath: string): LooseRecord[] {
  const parsed = readJsonObject(reportPath);
  const actions: JsonValue[] = Array.isArray(parsed.actions) ? parsed.actions : [];
  return actions.filter((action): action is LooseRecord => isJsonObject(action));
}

function readJsonObject(filePath: string): LooseRecord {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isJsonObject(parsed)) throw new Error(`${filePath} must contain a JSON object`);
  return parsed;
}

function readJsonObjectIfPresent(filePath: string): LooseRecord | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return readJsonObject(filePath);
  } catch {
    return null;
  }
}

function recordOrNull(value: JsonValue | undefined): LooseRecord | null {
  return isJsonObject(value) ? value : null;
}

function readJsonArray(filePath: string): unknown[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array`);
  return parsed;
}

function printOutput(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}

function requiredString(name: string): string {
  const value = optionalString(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function optionalString(name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function positionalString(index: number): string {
  const value = args._[index];
  return typeof value === "string" ? value : "";
}

function numberArg(name: string, fallback: number): number {
  const value = optionalString(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be numeric`);
  return parsed;
}

function nonNegativeIntegerArg(name: string): number {
  const parsed = numberArg(name, 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function positiveIntegerArg(name: string): number {
  const parsed = numberArg(name, 0);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function booleanArg(name: string, fallback: boolean): boolean {
  const value = optionalString(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`--${name} must be boolean`);
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function csvItems(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function itemNumberSet(value: string): ReadonlySet<number> | null {
  if (!value) return null;
  const numbers = csvItems(value).map((item) => Number(item));
  if (numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
    throw new Error("--item-numbers must be comma-separated positive integers");
  }
  return new Set(numbers);
}

function checkpointNumber(name: string): number {
  return Number(name.match(/\d+/)?.[0] ?? 0);
}

function frontMatterValue(markdown: string, key: string): string {
  return (
    markdown
      .match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
      ?.trim()
      .replace(/^"|"$/g, "") ?? ""
  );
}

function jsonArrayFrontMatter(markdown: string, key: string): JsonValue[] {
  const raw = frontMatterValue(markdown, key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArrayFrontMatter(markdown: string, key: string): string[] {
  return jsonArrayFrontMatter(markdown, key).filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function sectionValue(markdown: string, heading: string): string {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`),
  );
  return match?.[1]?.trim() ?? "";
}

function sectionLineValue(markdown: string, key: string): string {
  const match = markdown.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function stringValue(value: JsonValue): string {
  return typeof value === "string" ? value : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoFor(markdown: string, name: string): string {
  return (
    frontMatterValue(markdown, "repository") || (/^\d+\.md$/.test(name) ? "openclaw/openclaw" : "")
  );
}

function targetSlug(targetRepo: string): string {
  return targetRepo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function numberFor(name: string): number {
  return Number(name.match(/(\d+)\.md$/)?.[1] || 0);
}

function allowedForTarget(
  targetRepo: string,
  type: string,
  reason: string,
  allowedReasons: ReadonlySet<string>,
): boolean {
  if (targetRepo === "openclaw/clawhub")
    return (
      reason === "implemented_on_main" ||
      (type === "pull_request" && reason === "mostly_implemented_on_main")
    );
  if (type !== "pull_request" && reason === "unconfirmed_product_direction") return false;
  if (type === "pull_request" && reason === "stale_insufficient_info") return false;
  if (type !== "pull_request" && reason === "mostly_implemented_on_main") return false;
  if (type !== "pull_request" && reason === "low_signal_unmergeable_pr") return false;
  if (type !== "pull_request" && (reason === "abandoned_pr" || reason === "stalled_unproven_pr"))
    return false;
  return allowedReasons.has(reason);
}

function olderThan(iso: string, milliseconds: number): boolean {
  if (milliseconds <= 0) return true;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && Date.now() - parsed > milliseconds;
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isCliEntrypoint()) runCli();
