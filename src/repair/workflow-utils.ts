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
};

const args = parseArgs(process.argv.slice(2));

if (isCliEntrypoint()) runCli();

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
    "exact_item",
    "assist",
    "assist_visual",
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

export function countCommandActions(reportPath: string, action: string, status = ""): number {
  const report = readJsonObject(reportPath);
  const commands: JsonValue[] = Array.isArray(report.commands) ? report.commands : [];
  return commands
    .flatMap((command: JsonValue): JsonValue[] =>
      isJsonObject(command) && Array.isArray(command.actions) ? command.actions : [],
    )
    .filter((entry: JsonValue): entry is LooseRecord => isJsonObject(entry))
    .filter((entry: LooseRecord) => entry.action === action)
    .filter((entry: LooseRecord) => !status || entry.status === status).length;
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
};

type CommentSyncBatchOptions = {
  targetRepo: string;
  applyKind: string;
  batchSize: number;
  cursorPath: string;
};

export function proposedItemNumbers(options: ProposedItemOptions): number[] {
  const targetSlug = options.targetRepo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const itemsDir = path.join("records", targetSlug, "items");
  if (!fs.existsSync(itemsDir)) return [];

  const allowedReasons = new Set([
    "cannot_reproduce",
    "clawhub",
    "duplicate_or_superseded",
    "incoherent",
    "implemented_on_main",
    "mostly_implemented_on_main",
    "not_actionable_in_repo",
    "stale_insufficient_info",
  ]);
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
    .flatMap((name) => {
      const markdown = fs.readFileSync(path.join(itemsDir, name), "utf8");
      if (repoFor(markdown, name) !== options.targetRepo) return [];
      const type = frontMatterValue(markdown, "type");
      if (options.applyKind !== "all" && type && type !== options.applyKind) return [];
      if (frontMatterValue(markdown, "decision") !== "close") return [];
      if (frontMatterValue(markdown, "confidence") !== "high") return [];
      if (frontMatterValue(markdown, "action_taken") !== "proposed_close") return [];
      const reason = frontMatterValue(markdown, "close_reason");
      if (!allowedForTarget(options.targetRepo, type, reason, allowedReasons)) return [];
      if (allowedCloseReasons && !allowedCloseReasons.has(reason)) return [];
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
      return [numberFor(name)];
    })
    .sort((left, right) => left - right);
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

function proposedItemOptions(): ProposedItemOptions {
  return {
    targetRepo: requiredString("target-repo"),
    applyKind: optionalString("apply-kind") || "all",
    applyCloseReasons: optionalString("apply-close-reasons") || "all",
    staleMinAgeDays: numberArg("stale-min-age-days", 60),
    minAgeDays: numberArg("min-age-days", 0),
    minAgeMinutes: optionalString("min-age-minutes") ? numberArg("min-age-minutes", 0) : null,
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
      if (actionTaken !== "kept_open" && actionTaken !== "proposed_close") return [];
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
    return { action: entry.action };
  });
}

function resultFiles(reportDir: string): string[] {
  if (!fs.existsSync(reportDir)) return [];
  return fs
    .readdirSync(reportDir, { recursive: true })
    .map((entry) => path.join(reportDir, String(entry)))
    .filter((candidate) => path.basename(candidate) === "result.json")
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

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArray(value: JsonValue): string[] {
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

function repoFor(markdown: string, name: string): string {
  return (
    frontMatterValue(markdown, "repository") || (/^\d+\.md$/.test(name) ? "openclaw/openclaw" : "")
  );
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
      type === "pull_request" &&
      (reason === "implemented_on_main" || reason === "mostly_implemented_on_main")
    );
  if (type === "pull_request" && reason === "stale_insufficient_info") return false;
  if (type !== "pull_request" && reason === "mostly_implemented_on_main") return false;
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
