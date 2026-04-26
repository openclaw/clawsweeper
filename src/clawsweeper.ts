#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ItemKind = "issue" | "pull_request";
type ApplyKind = ItemKind | "all";
type DecisionKind = "close" | "keep_open";
type CloseReason =
  | "implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
  | "not_actionable_in_repo"
  | "incoherent"
  | "stale_insufficient_info"
  | "none";
type Confidence = "high" | "medium" | "low";
type ActionTaken =
  | "closed"
  | "kept_open"
  | "proposed_close"
  | "review_comment_synced"
  | "skipped_changed_since_review"
  | "skipped_already_closed"
  | "skipped_maintainer_authored"
  | "skipped_protected_label"
  | "skipped_invalid_decision";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

interface GitHubUser {
  login?: string;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  author_association?: string;
  user?: GitHubUser;
  labels?: string[];
  pull_request?: unknown;
}

interface Item {
  number: number;
  kind: ItemKind;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: string;
  authorAssociation: string;
  labels: string[];
}

interface ExistingReview {
  path: string;
  markdown: string;
  reviewedAt: string | undefined;
  itemUpdatedAt: string | undefined;
  decision: string | undefined;
  reviewStatus: string | undefined;
  reviewPolicy: string | undefined;
}

interface LatestRelease {
  tagName?: string;
  name?: string;
  publishedAt?: string;
  targetCommitish?: string;
  sha?: string | null;
}

interface GitInfo {
  mainSha: string;
  latestRelease: LatestRelease | null;
}

interface Evidence {
  label: string;
  detail: string;
  file: string | null;
  line: number | null;
  command: string | null;
  sha: string | null;
}

interface Decision {
  decision: DecisionKind;
  closeReason: CloseReason;
  confidence: Confidence;
  summary: string;
  evidence: Evidence[];
  risks: string[];
  bestSolution: string;
  fixedRelease?: string | null;
  fixedSha?: string | null;
  closeComment: string;
}

interface ItemContext {
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  relatedItems?: unknown[];
  pullRequest?: unknown;
  pullFiles?: unknown[];
  pullCommits?: unknown[];
  pullReviewComments?: unknown[];
  counts?: {
    comments: number;
    timeline: number;
    relatedItems?: number;
    pullFiles?: number;
    pullCommits?: number;
    pullReviewComments?: number;
  };
}

interface LocalRelatedTitleEntry {
  number: number;
  kind: ItemKind | undefined;
  title: string;
  url: string | undefined;
  location: AuditRecordLocation;
  path: string;
  decision: string | undefined;
  closeReason: string | undefined;
  action: string | undefined;
  reviewStatus: string;
  summary: string;
}

interface Action {
  actionTaken: ActionTaken;
  closeComment: string;
}

interface ReviewRuntime {
  model: string;
  reasoningEffort: string;
  sandboxMode?: string;
  serviceTier?: string;
}

interface DashboardItem {
  number: number;
  kind: ItemKind;
  title: string;
  reviewedAt: string | undefined;
  decision: string;
  action: string;
  reviewStatus: string;
}

interface RepoOpenCountsQuery {
  data?: {
    repository?: {
      issues?: {
        totalCount?: number;
      };
      pullRequests?: {
        totalCount?: number;
      };
    };
  };
}

interface OpenItemCounts {
  issues: number;
  pullRequests: number;
  total: number;
}

interface DashboardKindStats {
  total: number;
  fresh: number;
  proposedClose: number;
}

interface DashboardCadenceBucket {
  total: number;
  current: number;
  proposedClose: number;
}

interface DashboardCadenceStats {
  hourlyHotItems: DashboardCadenceBucket;
  dailyPullRequests: DashboardCadenceBucket;
  dailyNewIssues: DashboardCadenceBucket;
  weeklyOlderIssues: DashboardCadenceBucket;
  hourly: DashboardCadenceBucket;
  daily: DashboardCadenceBucket;
  weekly: DashboardCadenceBucket;
  unreviewedOpen: number;
  due: number;
}

interface DashboardActivityBucket {
  reviews: number;
  closeDecisions: number;
  keepOpenDecisions: number;
  failedOrStaleReviews: number;
  closes: number;
  commentSyncs: number;
  applySkips: number;
}

interface DashboardActivityStats {
  last15Minutes: DashboardActivityBucket;
  lastHour: DashboardActivityBucket;
  last24Hours: DashboardActivityBucket;
  latestReviewAt: string | undefined;
  latestCloseAt: string | undefined;
  latestCommentSyncAt: string | undefined;
}

interface PlanShard {
  shard: number;
  itemNumbers: number[];
}

interface DueCandidate {
  item: Item;
  review: ExistingReview | null;
  priority: number;
  reviewedAt: number;
}

interface ApplyResult {
  number: number;
  action: ActionTaken;
  reason: string;
}

interface ReconcileResult {
  openItemsSeen: number;
  pagesScanned: number;
  movedToClosed: number;
  movedToItems: number;
  removedStaleClosedCopies: number;
}

type AuditRecordLocation = "items" | "closed";
type MissingOpenReason =
  | "eligible"
  | "maintainer_authored"
  | "protected_label"
  | "recently_created";

interface AuditRecord {
  number: number;
  location: AuditRecordLocation;
  path: string;
  kind: ItemKind | undefined;
  title: string;
  labels: string[];
  decision: string | undefined;
  closeReason: string | undefined;
  action: string | undefined;
  reviewStatus: string;
  currentState: string | undefined;
}

interface AuditFinding {
  number: number;
  kind?: ItemKind;
  title?: string;
  labels?: string[];
  authorAssociation?: string;
  createdAt?: string;
  updatedAt?: string;
  missingReason?: MissingOpenReason;
  itemPath?: string;
  closedPath?: string;
  action?: string;
  decision?: string;
  closeReason?: string;
  reviewStatus?: string;
  currentState?: string;
}

interface AuditResult {
  generatedAt: string;
  targetRepo: string;
  scan: {
    complete: boolean;
    pagesScanned: number;
    openItemsSeen: number;
  };
  counts: {
    itemRecords: number;
    closedRecords: number;
    missingOpen: number;
    missingEligibleOpen: number;
    missingMaintainerOpen: number;
    missingProtectedOpen: number;
    missingRecentOpen: number;
    openArchived: number;
    staleItemRecords: number;
    duplicateRecords: number;
    protectedProposed: number;
    staleReviews: number;
  };
  findings: {
    missingOpen: AuditFinding[];
    missingEligibleOpen: AuditFinding[];
    missingMaintainerOpen: AuditFinding[];
    missingProtectedOpen: AuditFinding[];
    missingRecentOpen: AuditFinding[];
    openArchived: AuditFinding[];
    staleItemRecords: AuditFinding[];
    duplicateRecords: AuditFinding[];
    protectedProposed: AuditFinding[];
    staleReviews: AuditFinding[];
  };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_REPO = "openclaw/openclaw";
const REPORT_REPO = "openclaw/clawsweeper";
const CLAWHUB_URL = "https://clawhub.ai/";
const DOCS_URL = "https://docs.openclaw.ai";
const FRESH_DAYS = 7;
const HOT_REVIEW_DAYS = 7;
const RECENT_ISSUE_DAYS = 30;
const HOURLY_REVIEW_MS = 60 * 60 * 1000;
const DAILY_REVIEW_DAYS = 1;
const WEEKLY_REVIEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MISSING_OPEN_MS = DAY_MS;
const STATUS_START = "<!-- clawsweeper-status:start -->";
const STATUS_END = "<!-- clawsweeper-status:end -->";
const AUDIT_HEALTH_START = "<!-- clawsweeper-audit:start -->";
const AUDIT_HEALTH_END = "<!-- clawsweeper-audit:end -->";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_SERVICE_TIER = "fast";
const REVIEW_POLICY_VERSION = "2026-04-26-policy-v5";
const REVIEW_COMMENT_MARKER_PREFIX = "<!-- clawsweeper-review";
const PROTECTED_LABELS = new Set(["security", "beta-blocker", "release-blocker", "maintainer"]);
const ALLOWED_REASONS = new Set<CloseReason>([
  "implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
]);
const ALL_REASONS = new Set<CloseReason>([...ALLOWED_REASONS, "none"]);
const DECISIONS = new Set<DecisionKind>(["close", "keep_open"]);
const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);
const DECISION_SCHEMA_KEYS = new Set([
  "decision",
  "closeReason",
  "confidence",
  "summary",
  "evidence",
  "risks",
  "bestSolution",
  "fixedRelease",
  "fixedSha",
  "closeComment",
]);
const EVIDENCE_SCHEMA_KEYS = new Set(["label", "detail", "file", "line", "command", "sha"]);

function evidenceEntry(options: Partial<Evidence> & Pick<Evidence, "label" | "detail">): Evidence {
  return {
    label: options.label,
    detail: options.detail,
    file: options.file ?? null,
    line: options.line ?? null,
    command: options.command ?? null,
    sha: options.sha ?? null,
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2).replaceAll("-", "_");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function stringArg(value: string | boolean | string[] | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberArg(value: string | boolean | string[] | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolArg(value: string | boolean | string[] | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return value === "1" || value === "true" || value === "yes";
}

export function itemNumbersArg(
  itemNumbers: string | boolean | string[] | undefined,
  itemNumber: string | boolean | string[] | undefined,
): number[] {
  const numbers = new Set<number>();
  const add = (value: string): void => {
    for (const part of value.split(",")) {
      const parsed = Number(part.trim());
      if (Number.isInteger(parsed) && parsed > 0) numbers.add(parsed);
    }
  };
  if (typeof itemNumbers === "string") add(itemNumbers);
  if (typeof itemNumber === "string") add(itemNumber);
  return [...numbers].sort((left, right) => left - right);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gh(args: string[]): string {
  if (args[0] === "api") return run("gh", args);
  return run("gh", ["--repo", TARGET_REPO, ...args]);
}

function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

let lastThrottleHeartbeatAt = 0;
let throttleHeartbeatContext: (() => string) | null = null;

type GhRetryKind = "none" | "throttle" | "transient";

const GH_THROTTLE_PATTERNS = [
  /was submitted too quickly/i,
  /secondary rate/i,
  /API rate limit exceeded/i,
];

const GH_TRANSIENT_PATTERNS = [
  /unexpected EOF/i,
  /connection reset by peer/i,
  /error connecting to api\.github\.com/i,
  /\b(?:HTTP|status(?: code)?)\s*:?\s*(?:502|503|504)\b/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /TLS handshake timeout/i,
  /\bi\/o timeout\b/i,
  /Client\.Timeout exceeded/i,
  /temporary failure/i,
];

function errorField(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function ghErrorText(error: unknown): string {
  return [
    error instanceof Error ? error.message : String(error),
    errorField(error, "stdout"),
    errorField(error, "stderr"),
  ].join("\n");
}

export function ghRetryKind(error: unknown): GhRetryKind {
  const message = ghErrorText(error);
  if (GH_THROTTLE_PATTERNS.some((pattern) => pattern.test(message))) return "throttle";
  if (GH_TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "none";
}

export function shouldRetryGh(error: unknown): boolean {
  return ghRetryKind(error) !== "none";
}

function ghRetryWaitMs(kind: GhRetryKind, attempt: number): number {
  if (kind === "throttle") return Math.min(600_000, 30_000 * 2 ** attempt);
  if (kind === "transient") return Math.min(60_000, 2_000 * 2 ** attempt);
  return 0;
}

function summarizeGhArgs(args: string[]): string {
  if (args[0] === "api" && args[1]) return `gh api ${args[1]}`;
  return `gh ${args.slice(0, 3).join(" ")}`;
}

function maybePublishThrottleHeartbeat(options: {
  args: string[];
  attempt: number;
  attempts: number;
  waitMs: number;
}): void {
  if (process.env.CLAWSWEEPER_PUBLISH_THROTTLE_STATUS !== "true") return;
  const minWaitMs = Number(process.env.CLAWSWEEPER_THROTTLE_STATUS_MIN_WAIT_MS ?? 60_000);
  if (options.waitMs < minWaitMs) return;
  const minIntervalMs = Number(process.env.CLAWSWEEPER_THROTTLE_STATUS_MIN_INTERVAL_MS ?? 120_000);
  const now = Date.now();
  if (now - lastThrottleHeartbeatAt < minIntervalMs) return;
  lastThrottleHeartbeatAt = now;

  try {
    const readmePath = join(ROOT, "README.md");
    if (!existsSync(readmePath)) return;
    const context = throttleHeartbeatContext?.();
    const checkpoint = process.env.CLAWSWEEPER_APPLY_CHECKPOINT;
    const checkpointText = checkpoint ? `Checkpoint ${checkpoint}. ` : "";
    const detail = [
      `${checkpointText}GitHub throttled while applying close decisions.`,
      context,
      `Last throttled command: \`${summarizeGhArgs(options.args)}\`.`,
      `Retry ${options.attempt + 1}/${Math.max(1, options.attempts - 1)} in ${Math.round(options.waitMs / 1000)}s.`,
    ]
      .filter(Boolean)
      .join(" ");
    const statusOptions: {
      state: string;
      detail: string;
      runUrl?: string;
    } = {
      state: "Apply throttled",
      detail,
    };
    if (process.env.CLAWSWEEPER_RUN_URL) {
      statusOptions.runUrl = process.env.CLAWSWEEPER_RUN_URL;
    }
    const block = workflowStatusBlock(statusOptions);
    const readme = readFileSync(readmePath, "utf8");
    const pattern = new RegExp(`${STATUS_START}[\\s\\S]*?${STATUS_END}`);
    const updated = pattern.test(readme)
      ? readme.replace(pattern, block)
      : readme.replace(/Last dashboard update: .+/, `$&\n\n${block}`);
    writeFileSync(readmePath, updated, "utf8");
    run("git", ["add", "README.md"]);
    const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
    if (diff.status === 0) return;
    run("git", ["commit", "-m", "chore: update sweep apply throttle status"]);
    try {
      run("git", ["push"]);
    } catch (error) {
      console.error(
        `Best-effort throttle status push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    console.error(
      `Best-effort throttle status update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function ghWithRetry(args: string[], attempts = 12): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return gh(args);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (retryKind === "none" || attempt === attempts - 1) throw error;
      const waitMs = ghRetryWaitMs(retryKind, attempt);
      const retryLabel =
        retryKind === "throttle" ? "GitHub throttled" : "Transient GitHub API failure";
      console.error(
        `${retryLabel}; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      if (retryKind === "throttle") {
        maybePublishThrottleHeartbeat({ args, attempt, attempts, waitMs });
      }
      sleepMs(waitMs);
    }
  }
  throw lastError;
}

function ghJson<T>(args: string[]): T {
  const text = ghWithRetry(args);
  return JSON.parse(text) as T;
}

function ghJsonLines<T>(args: string[]): T[] {
  const text = ghWithRetry(args);
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortStable(item)]),
  );
}

function itemSnapshotHash(item: Item, context: ItemContext): string {
  const snapshotItem = {
    number: item.number,
    kind: item.kind,
    title: item.title,
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    author: item.author,
    labels: item.labels,
  };
  return sha256(stableJson({ item: snapshotItem, context }));
}

function reviewPolicyHash(options: {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: string;
  serviceTier?: string;
}): string {
  return sha256(
    stableJson({
      version: REVIEW_POLICY_VERSION,
      freshDays: FRESH_DAYS,
      model: options.model ?? DEFAULT_CODEX_MODEL,
      reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      sandboxMode: options.sandboxMode ?? "read-only",
      serviceTier: options.serviceTier ?? DEFAULT_SERVICE_TIER,
      prompt: readFileSync(join(ROOT, "prompts", "review-item.md"), "utf8"),
      schema: readFileSync(join(ROOT, "schema", "clawsweeper-decision.schema.json"), "utf8"),
    }),
  ).slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  record: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) throw new Error(`${path} has unexpected keys: ${unexpected.join(", ")}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error(`${path} must be a string or null`);
}

function requireNullableInteger(value: unknown, path: string): number | null {
  if (value === null) return value;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Error(`${path} must be an integer or null`);
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function isEnvironmentAccessCaveat(value: string): boolean {
  return /(?:GH_TOKEN|GITHUB_TOKEN|OPENCLAW_GH_TOKEN|authenticated gh|gh (?:was |is )?unavailable|unauthenticated gh|shallow clone|GitHub auth(?:entication)? (?:was |is )?unavailable|could not use authenticated GitHub)/i.test(
    value,
  );
}

function parseEvidence(value: unknown, path: string): Evidence {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, EVIDENCE_SCHEMA_KEYS, path);
  return {
    label: requireString(record.label, `${path}.label`),
    detail: requireString(record.detail, `${path}.detail`),
    file: requireNullableString(record.file, `${path}.file`),
    line: requireNullableInteger(record.line, `${path}.line`),
    command: requireNullableString(record.command, `${path}.command`),
    sha: requireNullableString(record.sha, `${path}.sha`),
  };
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  throw new Error(`${path} has invalid value`);
}

export function parseDecision(value: unknown): Decision {
  const record = requireRecord(value, "decision");
  rejectUnexpectedKeys(record, DECISION_SCHEMA_KEYS, "decision");
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((entry, index) => parseEvidence(entry, `decision.evidence[${index}]`))
    : (() => {
        throw new Error("decision.evidence must be an array");
      })();
  return {
    decision: requireEnum(record.decision, DECISIONS, "decision.decision"),
    closeReason: requireEnum(record.closeReason, ALL_REASONS, "decision.closeReason"),
    confidence: requireEnum(record.confidence, CONFIDENCES, "decision.confidence"),
    summary: requireString(record.summary, "decision.summary"),
    evidence,
    risks: requireStringArray(record.risks, "decision.risks").filter(
      (risk) => !isEnvironmentAccessCaveat(risk),
    ),
    bestSolution: requireString(record.bestSolution, "decision.bestSolution"),
    fixedRelease: requireNullableString(record.fixedRelease, "decision.fixedRelease"),
    fixedSha: requireNullableString(record.fixedSha, "decision.fixedSha"),
    closeComment: requireString(record.closeComment, "decision.closeComment"),
  };
}

function truncateText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

function login(value: unknown): string | undefined {
  const user = asRecord(value);
  const name = user.login;
  return typeof name === "string" ? name : undefined;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return label;
      const name = asRecord(label).name;
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => Boolean(name));
}

function normalizeAuthorAssociation(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

function isMaintainerAuthorAssociation(value: unknown): boolean {
  return MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

function isMaintainerAuthored(item: Pick<Item, "authorAssociation">): boolean {
  return isMaintainerAuthorAssociation(item.authorAssociation);
}

function normalizeLabelName(label: string): string {
  return label.trim().toLowerCase();
}

export function protectedLabels(labels: readonly string[]): string[] {
  return labels
    .map((label) => normalizeLabelName(label))
    .filter(
      (label, index, normalized) =>
        PROTECTED_LABELS.has(label) && normalized.indexOf(label) === index,
    );
}

export function isProtectedItem(item: Pick<Item, "labels">): boolean {
  return protectedLabels(item.labels).length > 0;
}

function protectedLabelReason(labels: readonly string[]): string {
  return `protected label: ${protectedLabels(labels).join(", ")}`;
}

export function shouldPlanItem(item: Pick<Item, "authorAssociation" | "labels">): boolean {
  return !isMaintainerAuthored(item) && !isProtectedItem(item);
}

function isOlderThanDays(isoTimestamp: string, days: number, now = Date.now()): boolean {
  if (days <= 0) return true;
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > days * 24 * 60 * 60 * 1000;
}

function applyKindArg(value: string | boolean | string[] | undefined): ApplyKind {
  const kind = stringArg(value, "issue");
  if (kind === "issue" || kind === "pull_request" || kind === "all") return kind;
  throw new Error(`Invalid apply kind: ${kind}`);
}

function compactSlice<T>(items: T[], limit: number): unknown[] {
  if (items.length <= limit) return items as unknown[];
  const keepStart = Math.floor(limit / 2);
  const keepEnd = Math.max(0, limit - keepStart);
  return [
    ...items.slice(0, keepStart),
    { omitted: items.length - limit, note: "middle entries omitted from prompt context" },
    ...items.slice(items.length - keepEnd),
  ];
}

function compactIssue(value: unknown): unknown {
  const issue = asRecord(value);
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    author: login(issue.user),
    authorAssociation: normalizeAuthorAssociation(issue.author_association),
    labels: labelNames(issue.labels),
    comments: issue.comments,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    body: truncateText(issue.body, 12000),
  };
}

function compactComment(value: unknown): unknown {
  const comment = asRecord(value);
  return {
    id: comment.id,
    author: login(comment.user),
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    body: truncateText(comment.body, 6000),
  };
}

function compactTimelineEvent(value: unknown): unknown {
  const event = asRecord(value);
  const sourceIssue = asRecord(asRecord(event.source).issue);
  return {
    id: event.id,
    event: event.event,
    createdAt: event.created_at,
    actor: login(event.actor),
    commitId: event.commit_id,
    label: asRecord(event.label).name,
    rename: event.rename,
    sourceIssue:
      Object.keys(sourceIssue).length > 0
        ? {
            number: sourceIssue.number,
            title: sourceIssue.title,
            url: sourceIssue.html_url,
            state: sourceIssue.state,
          }
        : undefined,
  };
}

function compactPullRequest(value: unknown): unknown {
  const pull = asRecord(value);
  const head = asRecord(pull.head);
  const base = asRecord(pull.base);
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    mergeable: pull.mergeable,
    author: login(pull.user),
    head: {
      ref: head.ref,
      sha: head.sha,
    },
    base: {
      ref: base.ref,
      sha: base.sha,
    },
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    body: truncateText(pull.body, 12000),
  };
}

function collectRelatedMentions(options: {
  item: Item;
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  pullRequest?: unknown;
  pullReviewComments?: unknown[];
}): Map<number, string[]> {
  const mentions = new Map<number, string[]>();
  const add = (number: number, source: string): void => {
    if (!Number.isInteger(number) || number <= 0 || number === options.item.number) return;
    const current = mentions.get(number) ?? [];
    if (!current.includes(source)) current.push(source);
    mentions.set(number, current);
  };
  const scanText = (value: unknown, source: string): void => {
    if (typeof value !== "string" || !value.trim()) return;
    const linked = value.matchAll(
      /github\.com\/openclaw\/openclaw\/(?:issues|pull)\/(\d+)|(?<![\w/])#(\d+)\b/g,
    );
    for (const match of linked) add(Number(match[1] ?? match[2]), source);
  };

  const issue = asRecord(options.issue);
  scanText(issue.body, "item body");

  options.comments.forEach((comment, index) => {
    scanText(asRecord(comment).body, `comment ${index + 1}`);
  });

  options.pullReviewComments?.forEach((comment, index) => {
    scanText(asRecord(comment).body, `pull review comment ${index + 1}`);
  });

  if (options.pullRequest) {
    scanText(asRecord(options.pullRequest).body, "pull request body");
  }

  options.timeline.forEach((event, index) => {
    const record = asRecord(event);
    scanText(record.body, `timeline ${index + 1}`);
    const sourceIssue = asRecord(asRecord(record.source).issue);
    const number = sourceIssue.number;
    if (typeof number === "number") add(number, `timeline ${index + 1} source issue`);
  });

  return mentions;
}

function compactRelatedItem(number: number, mentionedIn: string[]): unknown | null {
  try {
    const issue = ghJson<unknown>(["api", `repos/${TARGET_REPO}/issues/${number}`]);
    const issueRecord = asRecord(issue);
    const related: Record<string, unknown> = {
      mentionedIn: mentionedIn.slice(0, 6),
      issue: compactIssue(issue),
      commentCount: issueRecord.comments,
    };

    if (issueRecord.pull_request) {
      try {
        related.pullRequest = compactPullRequest(
          ghJson<unknown>(["api", `repos/${TARGET_REPO}/pulls/${number}`]),
        );
      } catch (error) {
        related.pullRequestError = error instanceof Error ? error.message : String(error);
      }
    }

    return related;
  } catch (error) {
    return {
      number,
      mentionedIn: mentionedIn.slice(0, 6),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const RELATED_TITLE_STOP_WORDS = new Set([
  "about",
  "after",
  "allow",
  "already",
  "also",
  "and",
  "are",
  "because",
  "being",
  "bug",
  "cannot",
  "claw",
  "clawhub",
  "claws",
  "codex",
  "does",
  "doesn",
  "don",
  "error",
  "fails",
  "feat",
  "feature",
  "fix",
  "for",
  "from",
  "has",
  "have",
  "into",
  "issue",
  "main",
  "not",
  "openclaw",
  "pr",
  "request",
  "should",
  "that",
  "the",
  "this",
  "through",
  "using",
  "when",
  "with",
  "without",
]);

let localRelatedTitleIndexCache: LocalRelatedTitleEntry[] | null = null;

export function relatedTitleSearchTerms(title: string, limit = 6): string[] {
  const seen = new Set<string>();
  return (
    title
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g)
      ?.filter((term) => {
        const normalized = term.replace(/^_+|_+$/g, "");
        if (RELATED_TITLE_STOP_WORDS.has(normalized)) return false;
        if (/^\d+$/.test(normalized)) return false;
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .slice(0, limit) ?? []
  );
}

function localRelatedTitleIndex(): LocalRelatedTitleEntry[] {
  if (localRelatedTitleIndexCache) return localRelatedTitleIndexCache;
  const entries: LocalRelatedTitleEntry[] = [];
  for (const [location, dir] of [
    ["items", join(ROOT, "items")],
    ["closed", join(ROOT, "closed")],
  ] as const) {
    for (const file of markdownFiles(dir)) {
      const path = join(dir, file);
      const markdown = readFileSync(path, "utf8");
      entries.push({
        number: numberForMarkdownFile(file),
        kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
        title: displayTitle(frontMatterValue(markdown, "title") ?? ""),
        url: frontMatterValue(markdown, "url"),
        location,
        path: repoRelativePath(path),
        decision: frontMatterValue(markdown, "decision"),
        closeReason: frontMatterValue(markdown, "close_reason"),
        action: frontMatterValue(markdown, "action_taken"),
        reviewStatus: effectiveReviewStatus(markdown),
        summary: sectionValue(markdown, "Summary"),
      });
    }
  }
  localRelatedTitleIndexCache = entries;
  return entries;
}

function compactRelatedSearchItems(item: Item, mentioned: Set<number>): unknown[] {
  const terms = relatedTitleSearchTerms(item.title);
  if (terms.length < 2) return [];
  const seen = new Set<number>([item.number, ...mentioned]);
  return localRelatedTitleIndex()
    .flatMap((entry) => {
      if (seen.has(entry.number)) return [];
      const candidateTerms = new Set(relatedTitleSearchTerms(entry.title, 12));
      const overlap = terms.filter((term) => candidateTerms.has(term)).length;
      if (overlap < 2) return [];
      return [{ entry, overlap }];
    })
    .sort((left, right) => right.overlap - left.overlap || left.entry.number - right.entry.number)
    .slice(0, 5)
    .map(({ entry, overlap }) => ({
      mentionedIn: ["local title search"],
      titleSearchOverlap: overlap,
      localReport: {
        ...entry,
        reportUrl: reportUrl(`/blob/main/${entry.path}`),
      },
    }));
}

function relatedItemsContext(options: {
  item: Item;
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  pullRequest?: unknown;
  pullReviewComments?: unknown[];
}): unknown[] {
  const mentions = collectRelatedMentions(options);
  const explicitRelated = [...mentions.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, 10)
    .map(([number, mentionedIn]) => compactRelatedItem(number, mentionedIn))
    .filter((entry) => entry !== null);
  const searchedRelated = compactRelatedSearchItems(options.item, new Set(mentions.keys()));
  return [...explicitRelated, ...searchedRelated].slice(0, 12);
}

function compactPullFile(value: unknown): unknown {
  const file = asRecord(value);
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: truncateText(file.patch, 2000),
  };
}

function compactPullCommit(value: unknown): unknown {
  const commit = asRecord(value);
  const commitInfo = asRecord(commit.commit);
  return {
    sha: commit.sha,
    author: login(commit.author),
    message: truncateText(commitInfo.message, 1000),
  };
}

function ghPaged<T>(path: string): T[] {
  const pages = ghJson<unknown[]>(["api", path, "--paginate", "--slurp"]);
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => (Array.isArray(page) ? (page as T[]) : []));
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^"|"$/g, "");
}

export function applyDecisionPriority(markdown: string, applyKind: ApplyKind): number {
  const closeReason = frontMatterValue(markdown, "close_reason") as CloseReason | undefined;
  const itemKind = frontMatterValue(markdown, "type");
  const isCloseProposal =
    frontMatterValue(markdown, "decision") === "close" &&
    frontMatterValue(markdown, "confidence") === "high" &&
    frontMatterValue(markdown, "action_taken") === "proposed_close" &&
    Boolean(closeReason && ALLOWED_REASONS.has(closeReason));
  if (!isCloseProposal) return 2;
  if (applyKind === "all" || itemKind === applyKind || !itemKind) return 0;
  return 1;
}

function replaceFrontMatterValue(markdown: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:\\s*.*$`, "m");
  if (pattern.test(markdown)) return markdown.replace(pattern, line);
  return markdown.replace(/^---\n/, `---\n${line}\n`);
}

function sectionValue(markdown: string, heading: string): string {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`),
  );
  return match?.[1]?.trim() ?? "";
}

function replaceSectionValue(markdown: string, heading: string, value: string): string {
  const pattern = new RegExp(`((?:^|\\n)## ${heading}\\n\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`);
  if (pattern.test(markdown)) return markdown.replace(pattern, `$1${value.trim()}\n`);
  return `${markdown.trimEnd()}\n\n## ${heading}\n\n${value.trim()}\n`;
}

function frontMatterStringArray(markdown: string, key: string): string[] {
  const value = frontMatterValue(markdown, key);
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Older reports used plain comma-separated labels.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function existingReview(number: number, itemsDir: string): ExistingReview | null {
  const path = join(itemsDir, `${number}.md`);
  if (!existsSync(path)) return null;
  const markdown = readFileSync(path, "utf8");
  return {
    path,
    markdown,
    reviewedAt: frontMatterValue(markdown, "reviewed_at"),
    itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
    decision: frontMatterValue(markdown, "decision"),
    reviewStatus: effectiveReviewStatus(markdown),
    reviewPolicy: frontMatterValue(markdown, "review_policy"),
  };
}

function inferReviewStatus(markdown: string): string {
  return markdown.includes("Codex review failed") ? "failed" : "complete";
}

function hasBlockedLocalCheckoutAccess(markdown: string): boolean {
  return /bwrap: loopback|sandbox wrapper|sandbox startup failed|sandboxed shell failed|local shell (?:access|commands|inspection).*unavailable|local shell .*blocked|local terminal commands were unavailable|could not run local shell/i.test(
    markdown,
  );
}

function hasVerifiedLocalCheckoutAccess(markdown: string): boolean {
  return frontMatterValue(markdown, "local_checkout_access") === "verified";
}

function effectiveReviewStatus(markdown: string): string {
  const status = frontMatterValue(markdown, "review_status") ?? inferReviewStatus(markdown);
  if (status === "complete") {
    if (hasBlockedLocalCheckoutAccess(markdown)) return "stale_local_checkout_blocked";
    if (!hasVerifiedLocalCheckoutAccess(markdown)) return "stale_local_checkout_unverified";
  }
  return status;
}

function isFresh(
  review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
): boolean {
  if (review?.reviewStatus !== "complete") return false;
  if (!review?.reviewedAt) return false;
  const reviewedAt = Date.parse(review.reviewedAt);
  if (!Number.isFinite(reviewedAt)) return false;
  return Date.now() - reviewedAt < FRESH_DAYS * DAY_MS;
}

function isCurrentForCadence(options: {
  reviewedAt: string | undefined;
  reviewStatus: string | undefined;
  cadenceMs: number;
  now: number;
}): boolean {
  if (options.reviewStatus !== "complete") return false;
  if (!options.reviewedAt) return false;
  const reviewedAt = Date.parse(options.reviewedAt);
  if (!Number.isFinite(reviewedAt)) return false;
  return options.now - reviewedAt < options.cadenceMs;
}

function reviewedAtMs(review: ExistingReview | null): number | null {
  if (review?.reviewStatus !== "complete") return null;
  if (!review.reviewedAt) return null;
  const reviewedAt = Date.parse(review.reviewedAt);
  return Number.isFinite(reviewedAt) ? reviewedAt : null;
}

function hasActivitySinceReview(item: Item, review: ExistingReview | null): boolean {
  if (!review) return false;
  if (review.itemUpdatedAt) return item.updatedAt !== review.itemUpdatedAt;
  const reviewedAt = reviewedAtMs(review);
  const updatedAt = Date.parse(item.updatedAt);
  return reviewedAt !== null && Number.isFinite(updatedAt) && updatedAt > reviewedAt;
}

function isCreatedWithinDays(
  item: Pick<Item, "createdAt">,
  days: number,
  now = Date.now(),
): boolean {
  const createdAt = Date.parse(item.createdAt);
  return Number.isFinite(createdAt) && now - createdAt < days * DAY_MS;
}

function reviewCadenceMs(item: Item, review: ExistingReview | null, now = Date.now()): number {
  if (hasActivitySinceReview(item, review)) return HOURLY_REVIEW_MS;
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) return HOURLY_REVIEW_MS;
  if (item.kind === "pull_request") return DAILY_REVIEW_DAYS * DAY_MS;
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return DAILY_REVIEW_DAYS * DAY_MS;
  }
  return WEEKLY_REVIEW_DAYS * DAY_MS;
}

function hasReviewPolicyMismatch(review: ExistingReview | null, reviewPolicy?: string): boolean {
  return Boolean(review && reviewPolicy && review.reviewPolicy !== reviewPolicy);
}

export function shouldReviewItem(
  item: Item,
  review: ExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): boolean {
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return true;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return true;
  return now - reviewedAt >= reviewCadenceMs(item, review, now);
}

function reviewPriority(
  item: Item,
  review: ExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): number {
  if (hasActivitySinceReview(item, review)) return 0;
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return 1;
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) return 2;
  if (item.kind === "pull_request") return 3;
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) return 4;
  return 5;
}

function dueCandidate(
  item: Item,
  itemsDir: string,
  now = Date.now(),
  reviewPolicy?: string,
): DueCandidate | null {
  const review = existingReview(item.number, itemsDir);
  if (!shouldReviewItem(item, review, now, reviewPolicy)) return null;
  return {
    item,
    review,
    priority: reviewPriority(item, review, now, reviewPolicy),
    reviewedAt: reviewedAtMs(review) ?? 0,
  };
}

function compareDueCandidates(left: DueCandidate, right: DueCandidate): number {
  return (
    left.priority - right.priority ||
    left.reviewedAt - right.reviewedAt ||
    left.item.number - right.item.number
  );
}

function fetchOpenItemPage(
  page: number,
  sort: "created" | "updated" = "created",
  direction: "asc" | "desc" = "asc",
): Item[] {
  const items = ghJsonLines<GitHubIssueListItem>([
    "api",
    `repos/${TARGET_REPO}/issues?state=open&sort=${sort}&direction=${direction}&per_page=100&page=${page}`,
    "--jq",
    ".[] | {number,title,html_url,created_at,updated_at,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
  ]);
  return items
    .map((item) => ({
      number: item.number,
      kind: item.pull_request ? ("pull_request" as const) : ("issue" as const),
      title: item.title,
      url: item.html_url,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      author: item.user?.login ?? "unknown",
      authorAssociation: normalizeAuthorAssociation(item.author_association),
      labels: item.labels ?? [],
    }))
    .sort((a, b) => a.number - b.number);
}

function fetchOpenItems(maxPages: number): {
  items: Item[];
  pagesScanned: number;
  complete: boolean;
} {
  const items: Item[] = [];
  let pagesScanned = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = fetchOpenItemPage(page);
    pagesScanned = page;
    items.push(...pageItems);
    if (pageItems.length === 0 || pageItems.length < 100) {
      return { items, pagesScanned, complete: true };
    }
  }
  return { items, pagesScanned, complete: false };
}

function fetchHotIntakeItems(maxPages: number): { items: Item[]; pagesScanned: number } {
  const byNumber = new Map<number, Item>();
  let pagesScanned = 0;
  for (const sort of ["created", "updated"] as const) {
    for (let page = 1; page <= maxPages; page += 1) {
      const pageItems = fetchOpenItemPage(page, sort, "desc");
      pagesScanned = Math.max(pagesScanned, page);
      for (const item of pageItems) byNumber.set(item.number, item);
      if (pageItems.length === 0 || pageItems.length < 100) break;
    }
  }
  return {
    items: [...byNumber.values()].sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.number - left.number,
    ),
    pagesScanned,
  };
}

function fetchOpenItemNumbers(maxPages: number): { numbers: Set<number>; pagesScanned: number } {
  const result = fetchOpenItems(maxPages);
  if (!result.complete) {
    throw new Error(
      `Open item scan reached max_pages=${maxPages} before the final page; refusing to reconcile folders from a partial scan.`,
    );
  }
  return {
    numbers: new Set(result.items.map((item) => item.number)),
    pagesScanned: result.pagesScanned,
  };
}

function fetchItem(number: number): { item: Item; state: string } {
  const issue = ghJson<GitHubIssueListItem & { state?: string }>([
    "api",
    `repos/${TARGET_REPO}/issues/${number}`,
    "--jq",
    "{number,title,html_url,created_at,updated_at,state,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
  ]);
  return {
    item: {
      number: issue.number,
      kind: issue.pull_request ? "pull_request" : "issue",
      title: issue.title,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      author: issue.user?.login ?? "unknown",
      authorAssociation: normalizeAuthorAssociation(issue.author_association),
      labels: issue.labels ?? [],
    },
    state: issue.state ?? "unknown",
  };
}

function fetchOpenItemCounts(): OpenItemCounts {
  const [owner, name] = TARGET_REPO.split("/");
  if (!owner || !name) throw new Error(`Invalid target repo: ${TARGET_REPO}`);
  const result = ghJson<RepoOpenCountsQuery>([
    "api",
    "graphql",
    "-f",
    `query=query { repository(owner: "${owner}", name: "${name}") { issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } } }`,
  ]);
  const repository = result.data?.repository;
  const issues = repository?.issues?.totalCount ?? 0;
  const pullRequests = repository?.pullRequests?.totalCount ?? 0;
  return {
    issues,
    pullRequests,
    total: issues + pullRequests,
  };
}

function emptyDashboardKindStats(): DashboardKindStats {
  return {
    total: 0,
    fresh: 0,
    proposedClose: 0,
  };
}

function emptyDashboardCadenceBucket(): DashboardCadenceBucket {
  return {
    total: 0,
    current: 0,
    proposedClose: 0,
  };
}

function emptyDashboardActivityBucket(): DashboardActivityBucket {
  return {
    reviews: 0,
    closeDecisions: 0,
    keepOpenDecisions: 0,
    failedOrStaleReviews: 0,
    closes: 0,
    commentSyncs: 0,
    applySkips: 0,
  };
}

function emptyDashboardActivityStats(): DashboardActivityStats {
  return {
    last15Minutes: emptyDashboardActivityBucket(),
    lastHour: emptyDashboardActivityBucket(),
    last24Hours: emptyDashboardActivityBucket(),
    latestReviewAt: undefined,
    latestCloseAt: undefined,
    latestCommentSyncAt: undefined,
  };
}

function addDashboardCadenceBucket(
  target: DashboardCadenceBucket,
  source: DashboardCadenceBucket,
): void {
  target.total += source.total;
  target.current += source.current;
  target.proposedClose += source.proposedClose;
}

function capDashboardCadenceBucket(
  bucket: DashboardCadenceBucket,
  totalLimit: number,
): DashboardCadenceBucket {
  const total = Math.min(bucket.total, totalLimit);
  return {
    total,
    current: Math.min(bucket.current, total),
    proposedClose: Math.min(bucket.proposedClose, total),
  };
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "-";
  return `${((numerator / denominator) * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function formatCadenceBucket(bucket: DashboardCadenceBucket): string {
  const due = bucket.total - bucket.current;
  return `${bucket.current}/${bucket.total} current (${due} due, ${formatPercent(bucket.current, bucket.total)})`;
}

function timestampMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinWindow(timestamp: number | null, now: number, windowMs: number): boolean {
  return timestamp !== null && timestamp <= now && now - timestamp <= windowMs;
}

function latestTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  const candidateMs = timestampMs(candidate);
  if (candidateMs === null) return current;
  const currentMs = timestampMs(current);
  return currentMs === null || candidateMs > currentMs ? candidate : current;
}

function recordDashboardActivity(
  markdown: string,
  activity: DashboardActivityStats,
  now: number,
): void {
  const reviewedAt = frontMatterValue(markdown, "reviewed_at");
  const reviewedAtMs = timestampMs(reviewedAt);
  const appliedAt = frontMatterValue(markdown, "applied_at");
  const appliedAtMs = timestampMs(appliedAt);
  const commentSyncedAt = frontMatterValue(markdown, "review_comment_synced_at");
  const commentSyncedAtMs = timestampMs(commentSyncedAt);
  const applyCheckedAt = frontMatterValue(markdown, "apply_checked_at");
  const applyCheckedAtMs = timestampMs(applyCheckedAt);
  const decision = frontMatterValue(markdown, "decision") ?? "unknown";
  const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
  const reviewStatus = effectiveReviewStatus(markdown);

  activity.latestReviewAt = latestTimestamp(activity.latestReviewAt, reviewedAt);
  activity.latestCloseAt = latestTimestamp(activity.latestCloseAt, appliedAt);
  activity.latestCommentSyncAt = latestTimestamp(activity.latestCommentSyncAt, commentSyncedAt);

  const buckets: Array<[DashboardActivityBucket, number]> = [
    [activity.last15Minutes, 15 * 60 * 1000],
    [activity.lastHour, 60 * 60 * 1000],
    [activity.last24Hours, 24 * 60 * 60 * 1000],
  ];
  for (const [bucket, windowMs] of buckets) {
    if (isWithinWindow(reviewedAtMs, now, windowMs)) {
      bucket.reviews += 1;
      if (decision === "close") bucket.closeDecisions += 1;
      if (decision === "keep_open") bucket.keepOpenDecisions += 1;
      if (reviewStatus === "failed" || reviewStatus.startsWith("stale_")) {
        bucket.failedOrStaleReviews += 1;
      }
    }
    if (isWithinWindow(appliedAtMs, now, windowMs)) bucket.closes += 1;
    if (isWithinWindow(commentSyncedAtMs, now, windowMs)) bucket.commentSyncs += 1;
    if (isWithinWindow(applyCheckedAtMs, now, windowMs) && action.startsWith("skipped_")) {
      bucket.applySkips += 1;
    }
  }
}

function formatActivityRow(label: string, bucket: DashboardActivityBucket): string {
  return `| ${label} | ${bucket.reviews} | ${bucket.closeDecisions} | ${bucket.keepOpenDecisions} | ${bucket.failedOrStaleReviews} | ${bucket.closes} | ${bucket.commentSyncs} | ${bucket.applySkips} |`;
}

function selectCandidates(options: {
  batchSize: number;
  maxPages: number;
  shardIndex: number;
  shardCount: number;
  itemsDir: string;
  itemNumber?: number;
  itemNumbers?: number[];
  reviewPolicy?: string;
  hotIntake?: boolean;
}): { candidates: Item[]; scannedPages: number } {
  if (options.itemNumbers) {
    const candidates = options.itemNumbers.flatMap((number) => {
      const { item, state } = fetchItem(number);
      return state === "open" ? [item] : [];
    });
    return { candidates, scannedPages: 0 };
  }
  if (options.itemNumber) {
    if (options.shardIndex !== 0) return { candidates: [], scannedPages: 0 };
    const { item, state } = fetchItem(options.itemNumber);
    if (state !== "open") return { candidates: [], scannedPages: 0 };
    return { candidates: [item], scannedPages: 0 };
  }
  const due: DueCandidate[] = [];
  const now = Date.now();
  if (options.hotIntake) {
    const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
    for (const item of items) {
      if (item.number % options.shardCount !== options.shardIndex) continue;
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(item, options.itemsDir, now, options.reviewPolicy);
      if (candidate) due.push(candidate);
    }
    const candidates = due
      .sort(compareDueCandidates)
      .slice(0, options.batchSize)
      .map(({ item }) => item);
    return { candidates, scannedPages: pagesScanned };
  }
  let scannedPages = 0;
  for (let page = 1; page <= options.maxPages; page += 1) {
    const items = fetchOpenItemPage(page);
    scannedPages = page;
    if (items.length === 0) break;
    for (const item of items) {
      if (item.number % options.shardCount !== options.shardIndex) continue;
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(item, options.itemsDir, now, options.reviewPolicy);
      if (candidate) due.push(candidate);
    }
  }
  const candidates = due
    .sort(compareDueCandidates)
    .slice(0, options.batchSize)
    .map(({ item }) => item);
  return { candidates, scannedPages };
}

function planCandidates(options: {
  batchSize: number;
  maxPages: number;
  shardCount: number;
  itemsDir: string;
  itemNumber?: number;
  reviewPolicy: string;
  hotIntake?: boolean;
}): { shards: PlanShard[]; scannedPages: number; candidates: Item[] } {
  if (options.itemNumber) {
    const { item, state } = fetchItem(options.itemNumber);
    const shouldReview = state === "open";
    return {
      shards: [{ shard: 0, itemNumbers: shouldReview ? [item.number] : [] }],
      scannedPages: 0,
      candidates: shouldReview ? [item] : [],
    };
  }

  const due: DueCandidate[] = [];
  const limit = Math.max(1, options.batchSize) * Math.max(1, options.shardCount);
  const now = Date.now();
  if (options.hotIntake) {
    const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
    for (const item of items) {
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(item, options.itemsDir, now, options.reviewPolicy);
      if (candidate) due.push(candidate);
    }
    const candidates = due
      .sort(compareDueCandidates)
      .slice(0, limit)
      .map(({ item }) => item);
    const shards = Array.from(
      { length: Math.max(1, Math.min(options.shardCount, candidates.length || 1)) },
      (_, shard) => ({ shard, itemNumbers: [] as number[] }),
    );
    candidates.forEach((item, index) => {
      shards[index % shards.length]?.itemNumbers.push(item.number);
    });
    return { shards, scannedPages: pagesScanned, candidates };
  }
  let scannedPages = 0;
  for (let page = 1; page <= options.maxPages; page += 1) {
    const items = fetchOpenItemPage(page);
    scannedPages = page;
    if (items.length === 0) break;
    for (const item of items) {
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(item, options.itemsDir, now, options.reviewPolicy);
      if (candidate) due.push(candidate);
    }
  }
  const candidates = due
    .sort(compareDueCandidates)
    .slice(0, limit)
    .map(({ item }) => item);

  const shards = Array.from(
    { length: Math.max(1, Math.min(options.shardCount, candidates.length || 1)) },
    (_, shard) => ({ shard, itemNumbers: [] as number[] }),
  );
  candidates.forEach((item, index) => {
    shards[index % shards.length]?.itemNumbers.push(item.number);
  });
  return { shards, scannedPages, candidates };
}

function collectItemContext(item: Item): ItemContext {
  const issue = ghJson<unknown>(["api", `repos/${TARGET_REPO}/issues/${item.number}`]);
  const comments = ghPaged<unknown>(`repos/${TARGET_REPO}/issues/${item.number}/comments`);
  const timeline = ghPaged<unknown>(`repos/${TARGET_REPO}/issues/${item.number}/timeline`);
  const context: ItemContext = {
    issue: compactIssue(issue),
    comments: compactSlice(comments.map(compactComment), 24),
    timeline: compactSlice(timeline.map(compactTimelineEvent), 80),
    counts: {
      comments: comments.length,
      timeline: timeline.length,
    },
  };
  let pullRequest: unknown | undefined;
  let pullReviewComments: unknown[] | undefined;
  if (item.kind === "pull_request") {
    pullRequest = ghJson<unknown>(["api", `repos/${TARGET_REPO}/pulls/${item.number}`]);
    const pullFiles = ghPaged<unknown>(`repos/${TARGET_REPO}/pulls/${item.number}/files`);
    const pullCommits = ghPaged<unknown>(`repos/${TARGET_REPO}/pulls/${item.number}/commits`);
    pullReviewComments = ghPaged<unknown>(`repos/${TARGET_REPO}/pulls/${item.number}/comments`);
    context.pullRequest = compactPullRequest(pullRequest);
    context.pullFiles = compactSlice(pullFiles.map(compactPullFile), 80);
    context.pullCommits = compactSlice(pullCommits.map(compactPullCommit), 80);
    context.pullReviewComments = compactSlice(pullReviewComments.map(compactComment), 40);
    context.counts = {
      ...context.counts,
      comments: comments.length,
      timeline: timeline.length,
      pullFiles: pullFiles.length,
      pullCommits: pullCommits.length,
      pullReviewComments: pullReviewComments.length,
    };
  }
  const relatedOptions: Parameters<typeof relatedItemsContext>[0] = {
    item,
    issue,
    comments,
    timeline,
  };
  if (pullRequest) relatedOptions.pullRequest = pullRequest;
  if (pullReviewComments) relatedOptions.pullReviewComments = pullReviewComments;
  const relatedItems = relatedItemsContext(relatedOptions);
  if (relatedItems.length) {
    context.relatedItems = relatedItems;
    const counts: NonNullable<ItemContext["counts"]> = {
      comments: context.counts?.comments ?? comments.length,
      timeline: context.counts?.timeline ?? timeline.length,
      relatedItems: relatedItems.length,
    };
    if (context.counts?.pullFiles !== undefined) counts.pullFiles = context.counts.pullFiles;
    if (context.counts?.pullCommits !== undefined) counts.pullCommits = context.counts.pullCommits;
    if (context.counts?.pullReviewComments !== undefined)
      counts.pullReviewComments = context.counts.pullReviewComments;
    context.counts = counts;
  }
  return context;
}

function gitInfo(openclawDir: string): GitInfo {
  run("git", ["fetch", "origin", "main", "--depth=50"], { cwd: openclawDir });
  const mainSha = run("git", ["rev-parse", "origin/main"], { cwd: openclawDir });
  let latestRelease: LatestRelease | null = null;
  try {
    latestRelease = ghJson<LatestRelease>([
      "release",
      "view",
      "--json",
      "tagName,name,publishedAt,targetCommitish",
    ]);
  } catch {
    latestRelease = null;
  }
  if (latestRelease?.tagName) {
    try {
      run("git", ["fetch", "--force", "origin", "tag", latestRelease.tagName, "--depth=1"], {
        cwd: openclawDir,
      });
      latestRelease.sha = run("git", ["rev-list", "-n", "1", latestRelease.tagName], {
        cwd: openclawDir,
      });
    } catch {
      latestRelease.sha = null;
    }
  }
  return { mainSha, latestRelease };
}

function promptFor(item: Item, context: ItemContext, git: GitInfo): string {
  const prompt = readFileSync(join(ROOT, "prompts", "review-item.md"), "utf8");
  return `${prompt}

## Repository State

- Target repo: ${TARGET_REPO}
- Item: #${item.number}
- Type: ${item.kind}
- Title: ${item.title}
- URL: ${item.url}
- Author: ${item.author}
- Author association: ${item.authorAssociation}
- Created at: ${item.createdAt}
- Updated at: ${item.updatedAt}
- Current main SHA: ${git.mainSha}
- Latest release: ${git.latestRelease?.tagName ?? "unknown"} (${git.latestRelease?.sha ?? "unknown sha"})

## GitHub Context

\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`
`;
}

function trimMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const edge = Math.floor((maxLength - 120) / 2);
  return `${text.slice(0, edge)}\n\n... truncated ${text.length - edge * 2} chars ...\n\n${text.slice(-edge)}`;
}

export function safeOutputTail(
  value: string | Buffer | null | undefined,
  maxLength = 6000,
): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : value.toString("utf8");
  return text.slice(-maxLength);
}

function codexFailureReason(detail: string): string {
  if (detail.includes("Codex dirtied the OpenClaw checkout")) return "dirty checkout";
  if (detail.includes("did not produce output")) return "missing structured output";
  if (detail.includes("invalid JSON")) return "invalid structured output";
  if (detail.includes("ENOBUFS") || detail.includes("maxBuffer")) return "output buffer overflow";
  if (detail.includes("timed out") || detail.includes("ETIMEDOUT")) return "timeout";
  return "codex execution failed";
}

function codexFailureDecision(status: number | null, stderr: string, stdout = ""): Decision {
  const detail = stderr || "No stderr.";
  const reason = codexFailureReason(detail);
  return {
    decision: "keep_open",
    closeReason: "none",
    confidence: "low",
    summary: `Codex review failed: ${reason}${status === null ? "" : ` (exit ${status})`}.`,
    evidence: [
      evidenceEntry({ label: "failure reason", detail: reason }),
      evidenceEntry({ label: "codex failure detail", detail: trimMiddle(detail, 4000) }),
      evidenceEntry({ label: "codex stdout", detail: trimMiddle(stdout || "No stdout.", 2000) }),
    ],
    risks: ["No close action taken because the review did not complete."],
    bestSolution: "Retry the Codex review after fixing the execution failure.",
    fixedRelease: null,
    fixedSha: null,
    closeComment: "",
  };
}

function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.OPENCLAW_GH_TOKEN;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function openclawDirtyStatus(openclawDir: string): string {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: openclawDir,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
}

function makeTreeReadOnly(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeTreeReadOnly(child);
    else chmodSync(child, statSync(child).mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(path, 0o555);
}

function runCodex(options: {
  item: Item;
  context: ItemContext;
  git: GitInfo;
  model: string;
  openclawDir: string;
  reasoningEffort: string;
  sandboxMode: string;
  serviceTier: string;
  timeoutMs: number;
  workDir: string;
}): Decision {
  ensureDir(options.workDir);
  const promptPath = join(options.workDir, `${options.item.number}.prompt.md`);
  const outputPath = join(options.workDir, `${options.item.number}.json`);
  writeFileSync(promptPath, promptFor(options.item, options.context, options.git), "utf8");
  const dirtyBefore = openclawDirtyStatus(options.openclawDir);
  if (dirtyBefore) {
    throw new Error(
      `OpenClaw checkout is dirty before reviewing #${options.item.number}:\n${dirtyBefore}`,
    );
  }
  const result = spawnSync(
    "codex",
    [
      "exec",
      "-m",
      options.model,
      "-c",
      `model_reasoning_effort="${options.reasoningEffort}"`,
      "-c",
      `service_tier="${options.serviceTier}"`,
      "-c",
      'forced_login_method="api"',
      "-c",
      'approval_policy="never"',
      "-C",
      options.openclawDir,
      "--output-schema",
      join(ROOT, "schema", "clawsweeper-decision.schema.json"),
      "--output-last-message",
      outputPath,
      "--sandbox",
      options.sandboxMode,
      "-",
    ],
    {
      cwd: options.openclawDir,
      encoding: "utf8",
      env: codexEnv(),
      input: readFileSync(promptPath, "utf8"),
      maxBuffer: 128 * 1024 * 1024,
      timeout: options.timeoutMs,
    },
  );
  const dirtyAfter = openclawDirtyStatus(options.openclawDir);
  if (dirtyAfter) {
    throw new Error(
      `Codex dirtied the OpenClaw checkout while reviewing #${options.item.number}:\n${dirtyAfter}`,
    );
  }
  if (result.error) {
    throw new Error(
      `Codex review failed for #${options.item.number}: ${result.error.message}\n${
        safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."
      }`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Codex review failed for #${options.item.number} with exit ${
        result.status ?? "unknown"
      }.\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."}`,
    );
  }
  if (!existsSync(outputPath)) {
    const decision = codexFailureDecision(
      result.status,
      `Codex exited successfully but did not write ${outputPath}.`,
      result.stdout,
    );
    throw new Error(
      `Codex review did not produce output for #${options.item.number}: ${decision.evidence
        .map((entry) => entry.detail)
        .join("\n")}`,
    );
  }
  try {
    return parseDecision(JSON.parse(readFileSync(outputPath, "utf8").trim()));
  } catch (error) {
    const decision = codexFailureDecision(
      result.status,
      `Codex wrote invalid JSON or schema-invalid output to ${outputPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      result.stdout,
    );
    throw new Error(
      `Codex review wrote invalid JSON for #${options.item.number}: ${decision.evidence
        .map((entry) => entry.detail)
        .join("\n")}`,
    );
  }
}

function closeReasonText(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "already implemented on main";
    case "cannot_reproduce":
      return "cannot reproduce on current main";
    case "clawhub":
      return "belongs on ClawHub";
    case "duplicate_or_superseded":
      return "duplicate or superseded";
    case "not_actionable_in_repo":
      return "not actionable in this repository";
    case "incoherent":
      return "not actionable";
    case "stale_insufficient_info":
      return "stale with insufficient information";
    case "none":
      return "kept open";
  }
}

function repoUrl(path = ""): string {
  return `https://github.com/${TARGET_REPO}${path}`;
}

function reportUrl(path = ""): string {
  return `https://github.com/${REPORT_REPO}${path}`;
}

function commitUrl(sha: string): string {
  return repoUrl(`/commit/${sha}`);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function releaseUrl(tag: string): string {
  return repoUrl(`/releases/tag/${encodeURIComponent(tag)}`);
}

function itemUrl(number: number, kind: ItemKind = "issue"): string {
  return repoUrl(`/${kind === "pull_request" ? "pull" : "issues"}/${number}`);
}

function reportFileUrl(number: number): string {
  return reportUrl(`/blob/main/items/${number}.md`);
}

function githubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function splitFileAndLine(
  file: string,
  explicitLine?: number | null,
): { file: string; line?: number } {
  const match = file.match(/^(.*?):(\d+)$/);
  if (match?.[1] && match[2]) return { file: match[1], line: Number(match[2]) };
  if (explicitLine) return { file, line: explicitLine };
  return { file };
}

function fileUrl(file: string, sha: string, line?: number): string {
  return repoUrl(`/blob/${sha}/${githubPath(file)}${line ? `#L${line}` : ""}`);
}

function latestFileUrl(file: string): string {
  return repoUrl(`/blob/main/${githubPath(file)}`);
}

function docsPageUrl(file: string): string | null {
  if (!file.startsWith("docs/")) return null;
  const page = file
    .replace(/^docs\//, "")
    .replace(/\/index\.mdx?$/, "")
    .replace(/\.mdx?$/, "");
  return `${DOCS_URL}/${page}`;
}

function markdownLink(label: string, url: string): string {
  return `[${label.replaceAll("|", "\\|")}](${url})`;
}

function linkedSha(sha: string): string {
  return markdownLink(shortSha(sha), commitUrl(sha));
}

function linkedRelease(tag: string): string {
  return markdownLink(tag, releaseUrl(tag));
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function workflowStatusBlock(options?: {
  state?: string;
  detail?: string;
  runUrl?: string;
  updatedAt?: string;
}): string {
  const updatedAt = formatTimestamp(options?.updatedAt ?? new Date().toISOString());
  const state = options?.state ?? "Idle";
  const detail = options?.detail ?? "No workflow status has been published yet.";
  const runLine = options?.runUrl ? `\nRun: ${markdownLink(options.runUrl, options.runUrl)}` : "";
  return `${STATUS_START}
**Workflow status**

Updated: ${updatedAt}

State: ${state}

${detail}${runLine}
${STATUS_END}`;
}

function currentWorkflowStatusBlock(readme: string): string {
  const pattern = new RegExp(`${STATUS_START}[\\s\\S]*?${STATUS_END}`);
  return readme.match(pattern)?.[0] ?? workflowStatusBlock();
}

function displayTitle(title: string): string {
  try {
    const parsed = JSON.parse(title) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // Front matter from older files may be a plain string.
  }
  return title.replace(/^"|"$/g, "");
}

function fixedInText(decision: Decision): string {
  const parts: string[] = [];
  if (decision.fixedRelease) parts.push(`release ${linkedRelease(decision.fixedRelease)}`);
  if (decision.fixedSha) parts.push(`commit ${linkedSha(decision.fixedSha)}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function fixedInReportText(markdown: string): string {
  const parts: string[] = [];
  const fixedRelease = frontMatterValue(markdown, "fixed_release");
  const fixedSha = frontMatterValue(markdown, "fixed_sha");
  if (fixedRelease && fixedRelease !== "unknown")
    parts.push(`release ${linkedRelease(fixedRelease)}`);
  if (fixedSha && fixedSha !== "unknown") parts.push(`commit ${linkedSha(fixedSha)}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function isLinkableSourceRef(file: string): boolean {
  if (file.includes("/")) return true;
  return ["AGENTS.md", "CHANGELOG.md", "README.md", "VISION.md"].includes(file);
}

function linkInlineSourceRefs(value: string, sha?: string | null): string {
  if (!sha) return value;
  return value.replace(
    /`([^`]+\.(?:css|js|json|jsx|md|mdx|mjs|sh|ts|tsx|yaml|yml)(?::\d+)?)`/g,
    (match, ref: string) => {
      const { file, line } = splitFileAndLine(ref);
      if (!isLinkableSourceRef(file)) return match;
      const docsUrl = docsPageUrl(file);
      const url =
        docsUrl ?? (file === "VISION.md" && !line ? latestFileUrl(file) : fileUrl(file, sha, line));
      return markdownLink(`\`${ref}\``, url);
    },
  );
}

function linkPrimaryEvidenceFile(value: string, evidence: Evidence): string {
  if (!evidence.file || !evidence.sha) return value;
  const docsUrl = docsPageUrl(evidence.file);
  if (docsUrl && !value.includes(docsUrl)) {
    return `${value} Public docs: ${markdownLink(`\`${evidence.file}\``, docsUrl)}.`;
  }
  if (evidence.file !== "VISION.md" || value.includes("VISION.md")) return value;
  const link = markdownLink("`VISION.md`", latestFileUrl(evidence.file));
  const linked = value
    .replace(/\b(?:the project vision|project vision|the vision|VISION)\b/i, link)
    .replace(/^Current main says\b/, `${link} says`)
    .replace(/^The roadmap guardrails explicitly list\b/, `${link} guardrails explicitly list`);
  return linked === value ? `${link}: ${value}` : linked;
}

function evidenceLocation(evidence: Evidence): string {
  const parts: string[] = [];
  if (evidence.file) {
    const location = evidence.line ? `${evidence.file}:${evidence.line}` : evidence.file;
    const docsUrl = docsPageUrl(evidence.file);
    const sourceUrl = evidence.sha
      ? fileUrl(evidence.file, evidence.sha, evidence.line ?? undefined)
      : null;
    const url = docsUrl ?? sourceUrl;
    parts.push(url ? markdownLink(`\`${location}\``, url) : `\`${location}\``);
  }
  if (evidence.sha) parts.push(linkedSha(evidence.sha));
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function closeEvidenceLine(evidence: Evidence): string {
  const label = evidence.label.trim();
  const detail = linkPrimaryEvidenceFile(
    linkInlineSourceRefs(sentence(evidence.detail), evidence.sha),
    evidence,
  );
  const prefix = label ? `**${label}:** ` : "";
  return `- ${prefix}${detail}${evidenceLocation(evidence)}`;
}

function closeIntro(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "Closing this as implemented after Codex automated review.";
    case "cannot_reproduce":
      return "Closing this as not reproducible on current `main` after Codex automated review.";
    case "clawhub":
      return `Closing this as better suited for ${markdownLink("ClawHub", CLAWHUB_URL)}/community plugin work after Codex automated review.`;
    case "duplicate_or_superseded":
      return "Closing this as duplicate or superseded after Codex automated review.";
    case "not_actionable_in_repo":
      return "Closing this as not actionable in this repository after Codex automated review.";
    case "incoherent":
      return "Closing this as not actionable after Codex automated review.";
    case "stale_insufficient_info":
      return "Closing this as stale with insufficient information after Codex automated review.";
    case "none":
      return "Closing this after Codex automated review.";
  }
}

function closeOutro(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "So I’m closing this as already implemented rather than keeping a duplicate issue open.";
    case "clawhub":
      return "So I’m closing this as a scope-fit item for the plugin/community path rather than keeping it open as an OpenClaw core request.";
    case "duplicate_or_superseded":
      return "So I’m closing this here and keeping the remaining discussion on the canonical linked item.";
    case "not_actionable_in_repo":
      return "So I’m closing this as outside the OpenClaw source repository rather than keeping it open as core work.";
    default:
      return "";
  }
}

function reportEvidence(markdown: string): Evidence[] {
  const evidence = sectionValue(markdown, "Evidence");
  const entries: Evidence[] = [];
  let current: Evidence | null = null;
  for (const line of evidence.split("\n")) {
    const heading = line.match(/^- \*\*(.*?):\*\*\s*(.*)$/);
    if (heading) {
      if (current) entries.push(current);
      current = evidenceEntry({
        label: heading[1] ?? "",
        detail: heading[2] ?? "",
      });
      continue;
    }
    if (!current) continue;
    const file = line.match(/^\s+- file: \[([^\]]+)\]/);
    if (file?.[1]) {
      const location = splitFileAndLine(file[1]);
      current.file = location.file;
      current.line = location.line ?? null;
      continue;
    }
    const sha = line.match(/^\s+- sha: \[([^\]]+)\]/);
    if (sha?.[1]) current.sha = sha[1];
    const command = line.match(/^\s+- command: `([\s\S]+)`$/);
    if (command?.[1]) current.command = command[1];
  }
  if (current) entries.push(current);
  return entries;
}

function reportDecision(markdown: string, closeReason: CloseReason): Decision {
  const fixedRelease = frontMatterValue(markdown, "fixed_release");
  const fixedSha = frontMatterValue(markdown, "fixed_sha");
  return {
    decision: "close",
    closeReason,
    confidence: "high",
    summary: sectionValue(markdown, "Summary"),
    evidence: reportEvidence(markdown),
    risks: [],
    bestSolution: sectionValue(markdown, "Best Possible Solution"),
    fixedRelease: fixedRelease && fixedRelease !== "unknown" ? fixedRelease : null,
    fixedSha: fixedSha && fixedSha !== "unknown" ? fixedSha : null,
    closeComment: sectionValue(markdown, "Close Comment"),
  };
}

function runtimeReviewText(runtime?: {
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}): string {
  const model = runtime?.model?.trim();
  const reasoningEffort = runtime?.reasoningEffort?.trim();
  if (model && reasoningEffort) return `model ${model}, reasoning ${reasoningEffort}`;
  if (model) return `model ${model}`;
  if (reasoningEffort) return `reasoning ${reasoningEffort}`;
  return "";
}

function runtimeReviewTextFromReport(markdown: string): string {
  return runtimeReviewText({
    model: frontMatterValue(markdown, "review_model") ?? "",
    reasoningEffort: frontMatterValue(markdown, "review_reasoning_effort") ?? "",
  });
}

function closeReviewLineFromDecision(
  decision: Decision,
  git: GitInfo,
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
): string {
  const fixed = fixedInText(decision);
  const parts = [runtimeReviewText(runtime), `reviewed against ${linkedSha(git.mainSha)}`].filter(
    Boolean,
  );
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return `Codex Review notes: ${parts.join("; ")}.`;
}

function closeReviewLineFromReport(markdown: string): string {
  const mainSha = frontMatterValue(markdown, "main_sha");
  const fixed = fixedInReportText(markdown);
  const parts: string[] = [runtimeReviewTextFromReport(markdown)].filter(Boolean);
  if (mainSha && mainSha !== "unknown") parts.push(`reviewed against ${linkedSha(mainSha)}`);
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return parts.length ? `Codex Review notes: ${parts.join("; ")}.` : "";
}

function renderCloseComment(options: {
  reason: CloseReason;
  summary: string;
  bestSolution?: string;
  evidence: Evidence[];
  reviewLine: string;
}): string {
  const evidence = options.evidence.slice(0, 6).map(closeEvidenceLine);
  const lines = [closeIntro(options.reason), "", sentence(options.summary)];
  const bestSolution = options.bestSolution?.trim();
  if (bestSolution) lines.push("", "Best possible solution:", "", sentence(bestSolution));
  if (evidence.length) lines.push("", "What I checked:", "", ...evidence);

  const outro = closeOutro(options.reason);
  if (outro) lines.push("", outro);
  if (options.reviewLine) lines.push("", options.reviewLine);

  return lines.join("\n");
}

function renderCloseCommentFromReport(markdown: string, reason: CloseReason): string {
  return renderCloseComment({
    reason,
    summary: sectionValue(markdown, "Summary"),
    bestSolution: sectionValue(markdown, "Best Possible Solution"),
    evidence: reportEvidence(markdown),
    reviewLine: closeReviewLineFromReport(markdown),
  });
}

function normalizeComment(
  decision: Decision,
  git: GitInfo,
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
): string {
  return renderCloseComment({
    reason: decision.closeReason,
    summary: decision.summary,
    bestSolution: decision.bestSolution,
    evidence: decision.evidence,
    reviewLine: closeReviewLineFromDecision(decision, git, runtime),
  });
}

function renderKeepOpenCommentFromReport(markdown: string): string {
  const evidence = reportEvidence(markdown).slice(0, 6).map(closeEvidenceLine);
  const summary = sectionValue(markdown, "Summary");
  const bestSolution = sectionValue(markdown, "Best Possible Solution");
  const risks = sectionValue(markdown, "Risks / Open Questions");
  const lines = [
    "Codex automated review: keeping this open.",
    "",
    sentence(summary),
    "",
    "Best possible solution:",
    "",
    sentence(
      bestSolution ||
        "Continue tracking this item until the missing behavior is implemented or a maintainer decides the product direction.",
    ),
  ];
  if (evidence.length) lines.push("", "What I checked:", "", ...evidence);
  if (risks && risks !== "- none") lines.push("", "Remaining risk / open question:", "", risks);
  const reviewLine = closeReviewLineFromReport(markdown);
  if (reviewLine) lines.push("", reviewLine);
  return lines.join("\n");
}

function renderReviewCommentFromReport(markdown: string, reason: CloseReason): string {
  const decision = frontMatterValue(markdown, "decision");
  if (decision === "close" && reason !== "none")
    return renderCloseCommentFromReport(markdown, reason);
  return renderKeepOpenCommentFromReport(markdown);
}

function hasUsableCloseComment(closeComment: string): boolean {
  const trimmed = closeComment.trim();
  return Boolean(trimmed) && trimmed !== "_No close comment posted._";
}

function hasImplementationSourceEvidence(decision: Decision): boolean {
  return decision.evidence.some(
    (entry) => Boolean(entry.file?.trim()) && Boolean(entry.sha?.trim()),
  );
}

function canClose(decision: Decision): boolean {
  return (
    decision.decision === "close" &&
    decision.confidence === "high" &&
    ALLOWED_REASONS.has(decision.closeReason)
  );
}

export function validateCloseDecision(
  item: Pick<Item, "kind" | "labels">,
  decision: Decision,
): { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string } {
  if (decision.decision !== "close") {
    return {
      ok: false,
      actionTaken: "kept_open",
      reason: "not a close decision",
    };
  }
  if (isProtectedItem(item)) {
    return {
      ok: false,
      actionTaken: "skipped_protected_label",
      reason: protectedLabelReason(item.labels),
    };
  }
  if (!canClose(decision)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "close decision is not high-confidence with an allowed close reason",
    };
  }
  if (item.kind === "pull_request" && decision.closeReason === "stale_insufficient_info") {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "stale_insufficient_info is not allowed for pull requests",
    };
  }
  if (!decision.summary.trim()) {
    return { ok: false, actionTaken: "skipped_invalid_decision", reason: "missing summary" };
  }
  if (!hasUsableCloseComment(decision.closeComment)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "missing close comment",
    };
  }
  if (decision.evidence.length === 0) {
    return { ok: false, actionTaken: "skipped_invalid_decision", reason: "missing evidence" };
  }
  if (
    decision.closeReason === "implemented_on_main" &&
    !hasImplementationSourceEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "implemented_on_main requires evidence with file and sha",
    };
  }
  return { ok: true };
}

function reviewCommentMarker(number: number): string {
  return `${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`;
}

function markedReviewCommentBody(number: number, body: string): string {
  return body.includes(reviewCommentMarker(number))
    ? body
    : `${body.trimEnd()}\n\n${reviewCommentMarker(number)}`;
}

export function isCodexReviewCommentBody(body: string): boolean {
  return (
    body.includes("Codex Review notes:") ||
    body.includes("Codex automated review:") ||
    body.includes("after Codex review.") ||
    body.includes("after Codex automated review.")
  );
}

function issueReviewComment(
  number: number,
  fallbackBodies: readonly string[] = [],
): Record<string, unknown> | undefined {
  const marker = reviewCommentMarker(number);
  const comments = ghPaged<unknown>(`repos/${TARGET_REPO}/issues/${number}/comments`).map(asRecord);
  const marked = comments.find((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && body.includes(marker);
  });
  if (marked) return marked;
  const exactBodies = new Set(fallbackBodies.map((body) => body.trim()).filter(Boolean));
  const exact = comments.find((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && exactBodies.has(body.trim());
  });
  if (exact) return exact;
  return comments.find((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && isCodexReviewCommentBody(body);
  });
}

function commentUpdatedAt(comment: Record<string, unknown> | undefined): string | undefined {
  const updatedAt = comment?.updated_at;
  if (typeof updatedAt === "string") return updatedAt;
  const createdAt = comment?.created_at;
  return typeof createdAt === "string" ? createdAt : undefined;
}

function commentId(comment: Record<string, unknown> | undefined): number | null {
  const id = comment?.id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

function commentUrl(comment: Record<string, unknown> | undefined): string | null {
  const url = comment?.html_url;
  return typeof url === "string" ? url : null;
}

function updateReviewCommentMetadata(
  markdown: string,
  comment: Record<string, unknown> | undefined,
  body: string,
): string {
  let next = replaceFrontMatterValue(markdown, "review_comment_sha256", sha256(body));
  const id = commentId(comment);
  const url = commentUrl(comment);
  if (id !== null) next = replaceFrontMatterValue(next, "review_comment_id", String(id));
  if (url) next = replaceFrontMatterValue(next, "review_comment_url", url);
  next = replaceFrontMatterValue(next, "review_comment_synced_at", new Date().toISOString());
  return next;
}

function writeCommentPayload(number: number, body: string): string {
  const commentFile = join(ROOT, ".artifacts", `comment-${number}.md`);
  ensureDir(dirname(commentFile));
  writeFileSync(commentFile, body, "utf8");
  const commentPayloadFile = join(ROOT, ".artifacts", `comment-${number}.json`);
  writeFileSync(commentPayloadFile, JSON.stringify({ body }), "utf8");
  return commentPayloadFile;
}

function upsertReviewComment(
  number: number,
  body: string,
  existing = issueReviewComment(number, [body]),
): Record<string, unknown> | undefined {
  const markedBody = markedReviewCommentBody(number, body);
  const id = commentId(existing);
  const payload = writeCommentPayload(number, markedBody);
  if (id !== null) {
    ghWithRetry([
      "api",
      `repos/${TARGET_REPO}/issues/comments/${id}`,
      "--method",
      "PATCH",
      "--input",
      payload,
    ]);
  } else {
    ghWithRetry([
      "api",
      `repos/${TARGET_REPO}/issues/${number}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ]);
  }
  return issueReviewComment(number, [markedBody]);
}

function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
  if (options.kind === "pull_request") {
    ghWithRetry(["pr", "close", String(options.number)]);
  } else {
    const reason = options.reason === "implemented_on_main" ? "completed" : "not_planned";
    const closePayloadFile = join(ROOT, ".artifacts", `close-${options.number}.json`);
    writeFileSync(
      closePayloadFile,
      JSON.stringify({ state: "closed", state_reason: reason }),
      "utf8",
    );
    ghWithRetry([
      "api",
      `repos/${TARGET_REPO}/issues/${options.number}`,
      "--method",
      "PATCH",
      "--input",
      closePayloadFile,
    ]);
  }
}

export function reviewActionForDecision(options: {
  item: Item;
  decision: Decision;
  git: GitInfo;
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
}): Action {
  if (options.decision.decision !== "close") return { actionTaken: "kept_open", closeComment: "" };
  if (isMaintainerAuthored(options.item)) {
    return { actionTaken: "skipped_maintainer_authored", closeComment: "" };
  }
  const validation = validateCloseDecision(options.item, options.decision);
  if (!validation.ok) return { actionTaken: validation.actionTaken, closeComment: "" };
  const closeComment = normalizeComment(options.decision, options.git, options.runtime);
  return { actionTaken: "proposed_close", closeComment };
}

function markdownFor(options: {
  item: Item;
  context: ItemContext;
  decision: Decision;
  git: GitInfo;
  action: Action;
  reviewMode: "propose" | "apply";
  snapshotHash: string;
  reviewPolicy: string;
  runtime: ReviewRuntime;
}): string {
  const labels = options.item.labels.length ? options.item.labels.join(", ") : "none";
  const evidence = options.decision.evidence.length
    ? options.decision.evidence
        .map((entry) => {
          const bits = [`- **${entry.label}:** ${entry.detail}`];
          if (entry.file) {
            const parsed = splitFileAndLine(entry.file, entry.line);
            const label = `${parsed.file}${parsed.line ? `:${parsed.line}` : ""}`;
            bits.push(
              `  - file: ${markdownLink(label, fileUrl(parsed.file, entry.sha ?? options.git.mainSha, parsed.line))}`,
            );
          }
          if (entry.command) bits.push(`  - command: \`${entry.command}\``);
          if (entry.sha) bits.push(`  - sha: ${linkedSha(entry.sha)}`);
          return bits.join("\n");
        })
        .join("\n")
    : "- none";
  const risks = options.decision.risks.length
    ? options.decision.risks.map((risk) => `- ${risk}`).join("\n")
    : "- none";
  const bestSolution = options.decision.bestSolution.trim() || "_Not provided._";
  return `---
number: ${options.item.number}
type: ${options.item.kind}
title: ${JSON.stringify(options.item.title)}
url: ${options.item.url}
state_at_review: open
item_created_at: ${options.item.createdAt}
item_updated_at: ${options.item.updatedAt}
author: ${options.item.author}
author_association: ${options.item.authorAssociation}
labels: ${JSON.stringify(options.item.labels)}
reviewed_at: ${new Date().toISOString()}
main_sha: ${options.git.mainSha}
latest_release: ${options.git.latestRelease?.tagName ?? "unknown"}
latest_release_sha: ${options.git.latestRelease?.sha ?? "unknown"}
fixed_release: ${options.decision.fixedRelease ?? "unknown"}
fixed_sha: ${options.decision.fixedSha ?? "unknown"}
review_policy: ${options.reviewPolicy}
review_model: ${options.runtime.model}
review_reasoning_effort: ${options.runtime.reasoningEffort}
review_sandbox: ${options.runtime.sandboxMode ?? "unknown"}
review_service_tier: ${options.runtime.serviceTier ?? "unknown"}
review_mode: ${options.reviewMode}
review_status: ${options.decision.summary.startsWith("Codex review failed") ? "failed" : "complete"}
local_checkout_access: verified
item_snapshot_hash: ${options.snapshotHash}
close_comment_sha256: ${options.action.closeComment ? sha256(options.action.closeComment) : "none"}
review_comment_sha256: none
review_comment_id: unknown
review_comment_url: unknown
decision: ${options.decision.decision}
close_reason: ${options.decision.closeReason}
confidence: ${options.decision.confidence}
action_taken: ${options.action.actionTaken}
---

# ${markdownLink(`#${options.item.number}: ${options.item.title}`, options.item.url)}

Type: ${options.item.kind}

URL: ${markdownLink(options.item.url, options.item.url)}

Author: ${options.item.author}

Author association: ${options.item.authorAssociation}

Labels: ${labels}

Created at: ${formatTimestamp(options.item.createdAt)}

Updated at: ${formatTimestamp(options.item.updatedAt)}

Reviewed against: ${linkedSha(options.git.mainSha)}

Codex review: ${runtimeReviewText(options.runtime)}

Latest release at review time: ${
    options.git.latestRelease?.tagName
      ? linkedRelease(options.git.latestRelease.tagName)
      : "unknown"
  }${options.git.latestRelease?.sha ? ` (${linkedSha(options.git.latestRelease.sha)})` : ""}

Fixed in: ${fixedInText(options.decision)}

## Decision

${options.decision.decision === "close" ? "Close" : "Keep open"}: ${closeReasonText(options.decision.closeReason)}

Confidence: ${options.decision.confidence}

Action taken: ${options.action.actionTaken}

## Summary

${options.decision.summary}

## Best Possible Solution

${bestSolution}

## Evidence

${evidence}

## Risks / Open Questions

${risks}

## Close Comment

${options.action.closeComment ? options.action.closeComment : "_No close comment posted._"}

## GitHub Snapshot

- comments: ${options.context.counts?.comments ?? options.context.comments.length}
- timeline events: ${options.context.counts?.timeline ?? options.context.timeline.length}
- related items: ${options.context.counts?.relatedItems ?? options.context.relatedItems?.length ?? 0}
- PR files: ${options.context.counts?.pullFiles ?? options.context.pullFiles?.length ?? 0}
- PR commits: ${options.context.counts?.pullCommits ?? options.context.pullCommits?.length ?? 0}
  `;
}

function planCommand(args: Args): void {
  const itemsDir = resolve(stringArg(args.items_dir, join(ROOT, "items")));
  const batchSize = numberArg(args.batch_size, 5);
  const maxPages = numberArg(args.max_pages, 250);
  const shardCount = numberArg(args.shard_count, 50);
  const itemNumber = numberArg(args.item_number, 0) || undefined;
  const hotIntake = boolArg(args.hot_intake);
  const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const serviceTier = stringArg(args.codex_service_tier, DEFAULT_SERVICE_TIER);
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  const planOptions: Parameters<typeof planCandidates>[0] = {
    batchSize,
    maxPages,
    shardCount,
    itemsDir,
    reviewPolicy,
  };
  if (itemNumber) planOptions.itemNumber = itemNumber;
  if (hotIntake) planOptions.hotIntake = true;
  const plan = planCandidates(planOptions);
  console.log(
    JSON.stringify(
      {
        ...plan,
        reviewPolicy,
        matrix: plan.shards.map((shard) => ({
          shard: shard.shard,
          item_numbers: shard.itemNumbers.join(",") || "none",
        })),
      },
      null,
      2,
    ),
  );
}

function reviewCommand(args: Args): void {
  const openclawDir = resolve(stringArg(args.openclaw_dir, "../openclaw"));
  const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts/reviews"));
  const itemsDir = resolve(stringArg(args.items_dir, join(ROOT, "items")));
  const batchSize = numberArg(args.batch_size, 5);
  const maxPages = numberArg(args.max_pages, 250);
  const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const serviceTier = stringArg(args.codex_service_tier, DEFAULT_SERVICE_TIER);
  const timeoutMs = numberArg(args.codex_timeout_ms, 600_000);
  const shardIndex = numberArg(args.shard_index, 0);
  const shardCount = numberArg(args.shard_count, 1);
  const itemNumber = numberArg(args.item_number, 0) || undefined;
  const hotIntake = boolArg(args.hot_intake);
  const itemNumbers =
    typeof args.item_numbers === "string" && args.item_numbers.trim()
      ? args.item_numbers
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value > 0)
      : undefined;
  const readonlyOpenclaw = boolArg(args.readonly_openclaw);
  const requestedApplyClosures =
    boolArg(args.apply_closures) || process.env.CLAWSWEEPER_APPLY_CLOSURES === "true";
  if (requestedApplyClosures) {
    console.error("[review] apply_closures is disabled; review shards are proposal-only");
  }
  ensureDir(artifactDir);
  const git = gitInfo(openclawDir);
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  if (readonlyOpenclaw) makeTreeReadOnly(openclawDir);
  const selectionOptions: Parameters<typeof selectCandidates>[0] = {
    batchSize,
    maxPages,
    shardIndex,
    shardCount,
    itemsDir,
    reviewPolicy,
  };
  if (itemNumber) selectionOptions.itemNumber = itemNumber;
  if (itemNumbers) selectionOptions.itemNumbers = itemNumbers;
  if (hotIntake) selectionOptions.hotIntake = true;
  const { candidates, scannedPages } = selectCandidates(selectionOptions);
  console.error(
    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} selected=${candidates.length} scanned_pages=${scannedPages}`,
  );
  writeFileSync(
    join(artifactDir, "selection.json"),
    JSON.stringify({ shardIndex, shardCount, scannedPages, candidates, reviewPolicy }, null, 2),
  );
  let completed = 0;
  for (const item of candidates) {
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start #${item.number} (${completed + 1}/${candidates.length})`,
    );
    const context = collectItemContext(item);
    const snapshotHash = itemSnapshotHash(item, context);
    let decision: Decision;
    try {
      decision = runCodex({
        item,
        context,
        git,
        model,
        openclawDir,
        reasoningEffort,
        sandboxMode,
        serviceTier,
        timeoutMs,
        workDir: join(artifactDir, "codex"),
      });
    } catch (error) {
      decision = codexFailureDecision(
        null,
        error instanceof Error ? error.message : String(error),
        "Per-item Codex failure; continuing with the rest of the shard.",
      );
    }
    const runtime = { model, reasoningEffort, sandboxMode, serviceTier };
    const action = reviewActionForDecision({ item, decision, git, runtime });
    writeFileSync(
      join(artifactDir, `${item.number}.md`),
      markdownFor({
        item,
        context,
        decision,
        git,
        action,
        reviewMode: "propose",
        snapshotHash,
        reviewPolicy,
        runtime,
      }),
      "utf8",
    );
    completed += 1;
    console.error(
      `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} done #${item.number} (${completed}/${candidates.length}) decision=${decision.decision} confidence=${decision.confidence} action=${action.actionTaken}`,
    );
  }
  console.error(
    `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} complete reviewed=${completed}`,
  );
}

function applyDecisionsCommand(args: Args): void {
  const itemsDir = resolve(stringArg(args.items_dir, join(ROOT, "items")));
  const closedDir = resolve(stringArg(args.closed_dir, join(ROOT, "closed")));
  const limit = numberArg(args.limit, 20);
  const processedLimit = numberArg(args.processed_limit, Math.max(limit * 2, 50));
  const minAgeDays = numberArg(args.min_age_days, 0);
  const applyKind = applyKindArg(args.apply_kind);
  const closeDelayMs = numberArg(args.close_delay_ms, 2_000);
  const progressEvery = Math.max(1, numberArg(args.progress_every, 10));
  const skipDashboard = boolArg(args.skip_dashboard);
  const syncCommentsOnly = boolArg(args.sync_comments_only);
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const requestedItemNumberSet = new Set(requestedItemNumbers);
  const results: ApplyResult[] = [];
  let closedCount = 0;
  let processedCount = 0;
  throttleHeartbeatContext = () =>
    `Progress: ${closedCount}/${limit} fresh closes, ${processedCount}/${processedLimit} processed records in this apply chunk.`;
  const logProgress = (message: string): void => {
    const counts = results.reduce<Record<string, number>>((accumulator, result) => {
      accumulator[result.action] = (accumulator[result.action] ?? 0) + 1;
      return accumulator;
    }, {});
    console.error(
      [
        `[apply] ${new Date().toISOString()} ${message}`,
        `closed=${closedCount}/${limit}`,
        `processed=${processedCount}/${processedLimit}`,
        `counts=${JSON.stringify(counts)}`,
      ].join(" "),
    );
  };
  const maybeLogProgress = (message: string): void => {
    if (processedCount % progressEvery === 0) logProgress(message);
  };
  if (!existsSync(itemsDir)) {
    console.log("No items directory.");
    return;
  }
  const files = readdirSync(itemsDir)
    .filter((name) => /^\d+\.md$/.test(name))
    .filter(
      (name) =>
        requestedItemNumberSet.size === 0 ||
        requestedItemNumberSet.has(Number(name.replace(".md", ""))),
    )
    .map((name) => ({
      name,
      number: Number(name.replace(".md", "")),
      priority: syncCommentsOnly
        ? 0
        : applyDecisionPriority(readFileSync(join(itemsDir, name), "utf8"), applyKind),
    }))
    .sort((left, right) => left.priority - right.priority || left.number - right.number)
    .map((entry) => entry.name);
  logProgress(
    `starting apply: files=${files.length} apply_kind=${applyKind} min_age_days=${minAgeDays} close_delay_ms=${closeDelayMs} sync_comments_only=${syncCommentsOnly} item_numbers=${requestedItemNumbers.join(",") || "all"}`,
  );
  for (const file of files) {
    const path = join(itemsDir, file);
    let markdown = readFileSync(path, "utf8");
    const number = Number(file.replace(/\.md$/, ""));
    const decision = frontMatterValue(markdown, "decision");
    const confidence = frontMatterValue(markdown, "confidence");
    const closeReason = frontMatterValue(markdown, "close_reason") as CloseReason | undefined;
    const action = frontMatterValue(markdown, "action_taken");
    const storedHash = frontMatterValue(markdown, "item_snapshot_hash");
    const storedUpdatedAt = frontMatterValue(markdown, "item_updated_at");
    const storedAuthorAssociation = frontMatterValue(markdown, "author_association");
    const archiveClosed = (nextMarkdown: string): void => {
      ensureDir(closedDir);
      writeFileSync(path, nextMarkdown, "utf8");
      renameSync(path, join(closedDir, file));
    };
    const markApplySkipped = (actionTaken: ActionTaken, reason: string): boolean => {
      markdown = replaceFrontMatterValue(markdown, "action_taken", actionTaken);
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      writeFileSync(path, markdown, "utf8");
      results.push({ number, action: actionTaken, reason });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${reason}`);
      return processedCount >= processedLimit;
    };
    if (!hasVerifiedLocalCheckoutAccess(markdown)) {
      results.push({
        number,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      });
      continue;
    }
    if (!storedHash || (action !== "proposed_close" && action !== "kept_open")) {
      continue;
    }
    const isCloseProposal =
      decision === "close" &&
      confidence === "high" &&
      Boolean(closeReason && ALLOWED_REASONS.has(closeReason)) &&
      action === "proposed_close";
    if (decision === "close" && !isCloseProposal) {
      continue;
    }
    const { item, state } = fetchItem(number);
    markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
    const reviewComment = renderReviewCommentFromReport(markdown, closeReason ?? "none");
    const existingReviewComment = issueReviewComment(number, [
      reviewComment,
      sectionValue(markdown, "Close Comment"),
    ]);
    const markedReviewComment = markedReviewCommentBody(number, reviewComment);
    if (isProtectedItem(item)) {
      if (isCloseProposal) {
        if (markApplySkipped("skipped_protected_label", protectedLabelReason(item.labels))) break;
      } else {
        results.push({ number, action: "kept_open", reason: protectedLabelReason(item.labels) });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: protected label`);
        if (processedCount >= processedLimit) break;
      }
      continue;
    }
    const currentAuthorAssociation = normalizeAuthorAssociation(item.authorAssociation);
    const reviewedAuthorAssociation = normalizeAuthorAssociation(storedAuthorAssociation);
    if (
      isMaintainerAuthorAssociation(currentAuthorAssociation) ||
      isMaintainerAuthorAssociation(reviewedAuthorAssociation)
    ) {
      const authorAssociation = isMaintainerAuthorAssociation(currentAuthorAssociation)
        ? currentAuthorAssociation
        : reviewedAuthorAssociation;
      if (isCloseProposal) {
        markdown = replaceFrontMatterValue(markdown, "author_association", authorAssociation);
        markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_maintainer_authored");
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        writeFileSync(path, markdown, "utf8");
      }
      results.push({
        number,
        action: isCloseProposal ? "skipped_maintainer_authored" : "kept_open",
        reason: `author association is ${authorAssociation}`,
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: maintainer authored`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    const updatedSinceReview = Boolean(storedUpdatedAt && item.updatedAt !== storedUpdatedAt);
    const reviewCommentOnlyUpdate = item.updatedAt === commentUpdatedAt(existingReviewComment);
    if (state !== "open") {
      if (existingReviewComment) {
        markdown = updateReviewCommentMetadata(
          markdown,
          existingReviewComment,
          markedReviewComment,
        );
        markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
        markdown = replaceFrontMatterValue(
          markdown,
          "applied_at",
          commentUpdatedAt(existingReviewComment) ?? new Date().toISOString(),
        );
        archiveClosed(markdown);
        closedCount += 1;
        processedCount += 1;
        results.push({
          number,
          action: "closed",
          reason: "matching ClawSweeper review comment already exists",
        });
        maybeLogProgress(`archived #${number}: already ${state} with matching review comment`);
        if (processedCount >= processedLimit || closedCount >= limit) break;
        continue;
      }
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_already_closed");
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      archiveClosed(markdown);
      results.push({ number, action: "skipped_already_closed", reason: `state is ${state}` });
      processedCount += 1;
      maybeLogProgress(`archived #${number}: already ${state}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (updatedSinceReview && !reviewCommentOnlyUpdate) {
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_changed_since_review");
      markdown = replaceFrontMatterValue(markdown, "current_item_updated_at", item.updatedAt);
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      writeFileSync(path, markdown, "utf8");
      results.push({
        number,
        action: "skipped_changed_since_review",
        reason: "updated_at changed",
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: changed since review`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (!storedUpdatedAt) {
      const currentContext = collectItemContext(item);
      const currentHash = itemSnapshotHash(item, currentContext);
      if (currentHash !== storedHash && !reviewCommentOnlyUpdate) {
        markdown = replaceFrontMatterValue(
          markdown,
          "action_taken",
          "skipped_changed_since_review",
        );
        markdown = replaceFrontMatterValue(markdown, "current_item_snapshot_hash", currentHash);
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        writeFileSync(path, markdown, "utf8");
        results.push({
          number,
          action: "skipped_changed_since_review",
          reason: "snapshot changed",
        });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: snapshot changed`);
        if (processedCount >= processedLimit) break;
        continue;
      }
    }
    if (
      frontMatterValue(markdown, "review_comment_sha256") !== sha256(markedReviewComment) ||
      !existingReviewComment ||
      frontMatterValue(markdown, "review_comment_id") === "unknown"
    ) {
      const syncedComment = upsertReviewComment(number, reviewComment, existingReviewComment);
      markdown = updateReviewCommentMetadata(markdown, syncedComment, markedReviewComment);
      writeFileSync(path, markdown, "utf8");
      results.push({
        number,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      });
      processedCount += 1;
      maybeLogProgress(`synced review comment #${number}`);
      if (processedCount >= processedLimit) break;
    }
    if (syncCommentsOnly) continue;
    if (!isCloseProposal || !closeReason) {
      continue;
    }
    if (closedCount >= limit) break;
    if (applyKind !== "all" && item.kind !== applyKind) {
      results.push({
        number,
        action: "kept_open",
        reason: `type is ${item.kind}; apply kind is ${applyKind}`,
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: type is ${item.kind}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    const currentReportValidation = validateCloseDecision(
      { kind: item.kind, labels: item.labels },
      reportDecision(markdown, closeReason),
    );
    if (!currentReportValidation.ok && currentReportValidation.actionTaken !== "kept_open") {
      if (markApplySkipped(currentReportValidation.actionTaken, currentReportValidation.reason))
        break;
      continue;
    }
    if (!isOlderThanDays(item.createdAt, minAgeDays)) {
      results.push({
        number,
        action: "kept_open",
        reason: `created less than or equal to ${minAgeDays} days ago`,
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: too new`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    logProgress(`closing #${number}`);
    closeItem({ number, kind: item.kind, reason: closeReason });
    sleepMs(closeDelayMs);
    markdown = replaceSectionValue(markdown, "Close Comment", reviewComment);
    markdown = replaceFrontMatterValue(markdown, "close_comment_sha256", sha256(reviewComment));
    markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
    markdown = replaceFrontMatterValue(markdown, "applied_at", new Date().toISOString());
    archiveClosed(markdown);
    closedCount += 1;
    processedCount += 1;
    results.push({ number, action: "closed", reason: closeReasonText(closeReason) });
    logProgress(`closed #${number}`);
    if (processedCount >= processedLimit) break;
  }
  writeFileSync(join(ROOT, "apply-report.json"), JSON.stringify(results, null, 2), "utf8");
  if (!skipDashboard) updateDashboard(itemsDir, closedDir);
  logProgress("finished apply");
  console.log(JSON.stringify(results, null, 2));
}

function applyArtifactsCommand(args: Args): void {
  const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts"));
  const itemsDir = resolve(stringArg(args.items_dir, join(ROOT, "items")));
  const closedDir = resolve(stringArg(args.closed_dir, join(ROOT, "closed")));
  const skipReconcile = boolArg(args.skip_reconcile);
  ensureDir(itemsDir);
  ensureDir(closedDir);
  if (existsSync(artifactDir)) {
    for (const entry of readdirSync(artifactDir, { recursive: true })) {
      const name = String(entry);
      if (!name.endsWith(".md")) continue;
      const source = join(artifactDir, name);
      if (!/^\d+\.md$/.test(basename(source))) continue;
      const markdown = readFileSync(source, "utf8");
      const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const destinationDir =
        action === "closed" || action === "skipped_already_closed" ? closedDir : itemsDir;
      const stalePath = join(destinationDir === itemsDir ? closedDir : itemsDir, basename(source));
      if (existsSync(stalePath)) unlinkSync(stalePath);
      writeFileSync(join(destinationDir, basename(source)), markdown, "utf8");
    }
  }
  if (!skipReconcile) reconcileFolders({ itemsDir, closedDir });
  updateDashboard(itemsDir, closedDir);
}

function markdownFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /^\d+\.md$/.test(name))
        .sort((left, right) => Number(left.replace(".md", "")) - Number(right.replace(".md", "")))
    : [];
}

function numberForMarkdownFile(file: string): number {
  return Number(file.replace(/\.md$/, ""));
}

function repoRelativePath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function markdownAuditRecord(
  location: AuditRecordLocation,
  dir: string,
  file: string,
): AuditRecord {
  const path = join(dir, file);
  const markdown = readFileSync(path, "utf8");
  return {
    number: numberForMarkdownFile(file),
    location,
    path: repoRelativePath(path),
    kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
    title: frontMatterValue(markdown, "title") ?? "",
    labels: frontMatterStringArray(markdown, "labels"),
    decision: frontMatterValue(markdown, "decision"),
    closeReason: frontMatterValue(markdown, "close_reason"),
    action: frontMatterValue(markdown, "action_taken"),
    reviewStatus: effectiveReviewStatus(markdown),
    currentState: frontMatterValue(markdown, "current_state"),
  };
}

function auditRecords(location: AuditRecordLocation, dir: string): AuditRecord[] {
  return markdownFiles(dir).map((file) => markdownAuditRecord(location, dir, file));
}

function openItemFinding(item: Item, extra: Partial<AuditFinding> = {}): AuditFinding {
  return {
    number: item.number,
    kind: item.kind,
    title: item.title,
    labels: item.labels,
    authorAssociation: item.authorAssociation,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...extra,
  };
}

function isRecentlyCreatedMissingOpen(item: Item, generatedAtMs: number): boolean {
  const createdAt = Date.parse(item.createdAt);
  return Number.isFinite(createdAt) && generatedAtMs - createdAt < RECENT_MISSING_OPEN_MS;
}

function missingOpenReason(item: Item, generatedAtMs: number): MissingOpenReason {
  if (isMaintainerAuthored(item)) return "maintainer_authored";
  if (isProtectedItem(item)) return "protected_label";
  if (isRecentlyCreatedMissingOpen(item, generatedAtMs)) return "recently_created";
  return "eligible";
}

function recordFinding(record: AuditRecord, extra: Partial<AuditFinding> = {}): AuditFinding {
  return {
    number: record.number,
    ...(record.kind ? { kind: record.kind } : {}),
    title: displayTitle(record.title),
    labels: record.labels,
    ...(record.action ? { action: record.action } : {}),
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.closeReason ? { closeReason: record.closeReason } : {}),
    reviewStatus: record.reviewStatus,
    ...(record.currentState ? { currentState: record.currentState } : {}),
    ...(record.location === "items" ? { itemPath: record.path } : { closedPath: record.path }),
    ...extra,
  };
}

function firstByNumber<T extends { number: number }>(records: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const record of records) {
    if (!map.has(record.number)) map.set(record.number, record);
  }
  return map;
}

export function auditFromSnapshot(options: {
  openItems: Item[];
  itemRecords: AuditRecord[];
  closedRecords: AuditRecord[];
  scanComplete: boolean;
  pagesScanned: number;
  generatedAt?: string;
}): AuditResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generatedAtMs = Date.parse(generatedAt);
  const openByNumber = firstByNumber(options.openItems);
  const itemByNumber = firstByNumber(options.itemRecords);
  const closedByNumber = firstByNumber(options.closedRecords);
  const missingOpen: AuditFinding[] = [];
  const missingEligibleOpen: AuditFinding[] = [];
  const missingMaintainerOpen: AuditFinding[] = [];
  const missingProtectedOpen: AuditFinding[] = [];
  const missingRecentOpen: AuditFinding[] = [];
  const openArchived: AuditFinding[] = [];

  for (const item of options.openItems) {
    if (itemByNumber.has(item.number)) continue;
    const closedRecord = closedByNumber.get(item.number);
    if (closedRecord) {
      openArchived.push(openItemFinding(item, { closedPath: closedRecord.path }));
    } else {
      const missingReason = missingOpenReason(item, generatedAtMs);
      const finding = openItemFinding(item, { missingReason });
      missingOpen.push(finding);
      if (missingReason === "maintainer_authored") missingMaintainerOpen.push(finding);
      else if (missingReason === "protected_label") missingProtectedOpen.push(finding);
      else if (missingReason === "recently_created") missingRecentOpen.push(finding);
      else missingEligibleOpen.push(finding);
    }
  }

  const staleItemRecords = options.scanComplete
    ? options.itemRecords
        .filter((record) => !openByNumber.has(record.number))
        .map((record) => recordFinding(record))
    : [];
  const duplicateRecords = options.itemRecords
    .filter((record) => closedByNumber.has(record.number))
    .map((record) => {
      const closedRecord = closedByNumber.get(record.number);
      return recordFinding(record, closedRecord ? { closedPath: closedRecord.path } : {});
    });
  const protectedProposed = [...options.itemRecords, ...options.closedRecords]
    .filter((record) => record.action === "proposed_close" && isProtectedItem(record))
    .map((record) => recordFinding(record));
  const staleReviews = options.itemRecords
    .filter((record) => record.reviewStatus.startsWith("stale_"))
    .map((record) => recordFinding(record));

  return {
    generatedAt,
    targetRepo: TARGET_REPO,
    scan: {
      complete: options.scanComplete,
      pagesScanned: options.pagesScanned,
      openItemsSeen: options.openItems.length,
    },
    counts: {
      itemRecords: options.itemRecords.length,
      closedRecords: options.closedRecords.length,
      missingOpen: missingOpen.length,
      missingEligibleOpen: missingEligibleOpen.length,
      missingMaintainerOpen: missingMaintainerOpen.length,
      missingProtectedOpen: missingProtectedOpen.length,
      missingRecentOpen: missingRecentOpen.length,
      openArchived: openArchived.length,
      staleItemRecords: staleItemRecords.length,
      duplicateRecords: duplicateRecords.length,
      protectedProposed: protectedProposed.length,
      staleReviews: staleReviews.length,
    },
    findings: {
      missingOpen,
      missingEligibleOpen,
      missingMaintainerOpen,
      missingProtectedOpen,
      missingRecentOpen,
      openArchived,
      staleItemRecords,
      duplicateRecords,
      protectedProposed,
      staleReviews,
    },
  };
}

function limitAuditFindings(result: AuditResult, limit: number): AuditResult {
  const boundedLimit = Math.max(0, limit);
  return {
    ...result,
    findings: Object.fromEntries(
      Object.entries(result.findings).map(([key, findings]) => [
        key,
        findings.slice(0, boundedLimit),
      ]),
    ) as AuditResult["findings"],
  };
}

export function auditHasStrictFailures(result: AuditResult): boolean {
  return (
    !result.scan.complete ||
    result.counts.missingEligibleOpen > 0 ||
    result.counts.openArchived > 0 ||
    result.counts.staleItemRecords > 0 ||
    result.counts.duplicateRecords > 0 ||
    result.counts.protectedProposed > 0
  );
}

function auditHealthStatus(result: AuditResult): string {
  return auditHasStrictFailures(result) ? "Action needed" : "Passing";
}

function auditFindingCategory(category: keyof AuditResult["findings"]): string {
  switch (category) {
    case "missingEligibleOpen":
      return "Missing eligible open";
    case "openArchived":
      return "Open archived";
    case "staleItemRecords":
      return "Stale item record";
    case "duplicateRecords":
      return "Duplicate record";
    case "protectedProposed":
      return "Protected proposed close";
    case "staleReviews":
      return "Stale review";
    case "missingOpen":
      return "Missing open";
    case "missingMaintainerOpen":
      return "Missing maintainer open";
    case "missingProtectedOpen":
      return "Missing protected open";
    case "missingRecentOpen":
      return "Missing recent open";
  }
}

function auditFindingDetail(finding: AuditFinding): string {
  if (finding.closedPath) return finding.closedPath;
  if (finding.itemPath) return finding.itemPath;
  if (finding.missingReason) return finding.missingReason;
  if (finding.action) return finding.action;
  return "-";
}

function actionableAuditFindings(result: AuditResult, limit = 3): string {
  const categories: (keyof AuditResult["findings"])[] = [
    "missingEligibleOpen",
    "protectedProposed",
    "openArchived",
    "duplicateRecords",
    "staleReviews",
    "staleItemRecords",
  ];
  const rows: string[] = [];
  for (const category of categories) {
    for (const finding of result.findings[category]) {
      rows.push(
        `| ${markdownLink(`#${finding.number}`, itemUrl(finding.number, finding.kind ?? "issue"))} | ${auditFindingCategory(category)} | ${displayTitle(finding.title ?? "").replaceAll("|", "\\|")} | ${auditFindingDetail(finding).replaceAll("|", "\\|")} |`,
      );
      if (rows.length >= limit) return rows.join("\n");
    }
  }
  return "| _None_ |  |  |  |";
}

export function auditHealthSection(result: AuditResult | null): string {
  if (!result) {
    return `### Audit Health

${AUDIT_HEALTH_START}
No audit has been published yet. Run \`npm run audit -- --update-dashboard\` to refresh this section.
${AUDIT_HEALTH_END}`;
  }
  return `### Audit Health

${AUDIT_HEALTH_START}
Last audit: ${formatTimestamp(result.generatedAt)}

Status: **${auditHealthStatus(result)}**

| Metric | Count |
| --- | ---: |
| Scan complete | ${result.scan.complete ? "yes" : "no"} |
| Open items seen | ${result.scan.openItemsSeen} |
| Missing eligible open records | ${result.counts.missingEligibleOpen} |
| Missing maintainer-authored open records | ${result.counts.missingMaintainerOpen} |
| Missing protected open records | ${result.counts.missingProtectedOpen} |
| Missing recently-created open records | ${result.counts.missingRecentOpen} |
| Archived records that are open again | ${result.counts.openArchived} |
| Stale item records | ${result.counts.staleItemRecords} |
| Duplicate records | ${result.counts.duplicateRecords} |
| Protected proposed closes | ${result.counts.protectedProposed} |
| Stale reviews | ${result.counts.staleReviews} |

| Item | Category | Title | Detail |
| --- | --- | --- | --- |
${actionableAuditFindings(result)}
${AUDIT_HEALTH_END}`;
}

function currentAuditHealthSection(readme: string): string {
  const match = readme.match(
    new RegExp(`### Audit Health\\n\\n${AUDIT_HEALTH_START}[\\s\\S]*?${AUDIT_HEALTH_END}`),
  );
  return match?.[0] ?? auditHealthSection(null);
}

function updateAuditHealthDashboard(result: AuditResult): void {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const section = auditHealthSection(result);
  const existingPattern = new RegExp(
    `### Audit Health\\n\\n${AUDIT_HEALTH_START}[\\s\\S]*?${AUDIT_HEALTH_END}`,
  );
  const updated = existingPattern.test(readme)
    ? readme.replace(existingPattern, section)
    : readme.replace(/\n### Latest Run Activity/, `\n${section}\n\n### Latest Run Activity`);
  writeFileSync(readmePath, updated, "utf8");
}

function markReconciledState(markdown: string, state: "open" | "closed"): string {
  let nextMarkdown = replaceFrontMatterValue(markdown, "current_state", state);
  nextMarkdown = replaceFrontMatterValue(nextMarkdown, "reconciled_at", new Date().toISOString());
  if (state === "open") {
    nextMarkdown = replaceFrontMatterValue(nextMarkdown, "review_status", "stale_reopened");
    nextMarkdown = replaceFrontMatterValue(nextMarkdown, "action_taken", "kept_open");
  }
  return nextMarkdown;
}

function moveMarkdownFile(options: {
  sourcePath: string;
  destinationPath: string;
  markdown: string;
  dryRun: boolean;
}): void {
  if (options.dryRun) return;
  ensureDir(dirname(options.destinationPath));
  writeFileSync(options.sourcePath, options.markdown, "utf8");
  if (existsSync(options.destinationPath)) unlinkSync(options.destinationPath);
  renameSync(options.sourcePath, options.destinationPath);
}

function reconcileFolders(options: {
  itemsDir: string;
  closedDir: string;
  maxPages?: number;
  dryRun?: boolean;
}): ReconcileResult {
  const maxPages = options.maxPages ?? 250;
  const dryRun = options.dryRun ?? false;
  ensureDir(options.itemsDir);
  ensureDir(options.closedDir);
  const { numbers: openNumbers, pagesScanned } = fetchOpenItemNumbers(maxPages);
  let movedToClosed = 0;
  let movedToItems = 0;
  let removedStaleClosedCopies = 0;

  for (const file of markdownFiles(options.itemsDir)) {
    const number = numberForMarkdownFile(file);
    if (openNumbers.has(number)) continue;
    const sourcePath = join(options.itemsDir, file);
    const destinationPath = join(options.closedDir, file);
    const markdown = markReconciledState(readFileSync(sourcePath, "utf8"), "closed");
    moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
    movedToClosed += 1;
  }

  for (const file of markdownFiles(options.closedDir)) {
    const number = numberForMarkdownFile(file);
    if (!openNumbers.has(number)) continue;
    const sourcePath = join(options.closedDir, file);
    const destinationPath = join(options.itemsDir, file);
    if (existsSync(destinationPath)) {
      if (!dryRun) unlinkSync(sourcePath);
      removedStaleClosedCopies += 1;
      continue;
    }
    const markdown = markReconciledState(readFileSync(sourcePath, "utf8"), "open");
    moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
    movedToItems += 1;
  }

  return {
    openItemsSeen: openNumbers.size,
    pagesScanned,
    movedToClosed,
    movedToItems,
    removedStaleClosedCopies,
  };
}

function reconcileCommand(args: Args): void {
  const itemsDir = resolve(stringArg(args.items_dir, join(ROOT, "items")));
  const closedDir = resolve(stringArg(args.closed_dir, join(ROOT, "closed")));
  const maxPages = numberArg(args.max_pages, 250);
  const dryRun = boolArg(args.dry_run);
  const result = reconcileFolders({ itemsDir, closedDir, maxPages, dryRun });
  console.log(JSON.stringify(result, null, 2));
}

function auditCommand(args: Args): void {
  const itemsDir = resolve(stringArg(args.items_dir, join(ROOT, "items")));
  const closedDir = resolve(stringArg(args.closed_dir, join(ROOT, "closed")));
  const maxPages = numberArg(args.max_pages, 250);
  const sampleLimit = numberArg(args.sample_limit, 25);
  const output = typeof args.output === "string" ? resolve(args.output) : undefined;
  const strict = boolArg(args.strict);
  const updateDashboard = boolArg(args.update_dashboard);
  const openItems = fetchOpenItems(maxPages);
  const result = auditFromSnapshot({
    openItems: openItems.items,
    itemRecords: auditRecords("items", itemsDir),
    closedRecords: auditRecords("closed", closedDir),
    scanComplete: openItems.complete,
    pagesScanned: openItems.pagesScanned,
  });
  if (output) {
    ensureDir(dirname(output));
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  if (updateDashboard) updateAuditHealthDashboard(result);
  console.log(JSON.stringify(limitAuditFindings(result, sampleLimit), null, 2));
  if (strict && auditHasStrictFailures(result)) process.exit(1);
}

function cadenceBucketForReview(
  markdown: string,
  now: number,
): {
  bucket: "hourlyHotItems" | "dailyPullRequests" | "dailyNewIssues" | "weeklyOlderIssues";
  cadenceMs: number;
} {
  const kind = (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue";
  const createdAt = Date.parse(frontMatterValue(markdown, "item_created_at") ?? "");
  if (Number.isFinite(createdAt) && now - createdAt < HOT_REVIEW_DAYS * DAY_MS) {
    return { bucket: "hourlyHotItems", cadenceMs: HOURLY_REVIEW_MS };
  }
  if (kind === "pull_request") {
    return { bucket: "dailyPullRequests", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }

  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return { bucket: "dailyNewIssues", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }

  return { bucket: "weeklyOlderIssues", cadenceMs: WEEKLY_REVIEW_DAYS * DAY_MS };
}

function dashboardStats(
  itemsDir: string,
  closedDir = join(ROOT, "closed"),
): {
  open: OpenItemCounts;
  fresh: number;
  todo: number;
  files: number;
  proposedClose: number;
  closed: number;
  archivedFiles: number;
  failed: number;
  stale: number;
  byKind: Record<ItemKind, DashboardKindStats>;
  cadence: DashboardCadenceStats;
  activity: DashboardActivityStats;
  recent: DashboardItem[];
} {
  const open = fetchOpenItemCounts();
  const files = markdownFiles(itemsDir);
  const closedFiles = markdownFiles(closedDir);
  const now = Date.now();
  let fresh = 0;
  let proposedClose = 0;
  let closed = 0;
  let failed = 0;
  let stale = 0;
  const byKind: Record<ItemKind, DashboardKindStats> = {
    issue: emptyDashboardKindStats(),
    pull_request: emptyDashboardKindStats(),
  };
  const hourlyHotItems = emptyDashboardCadenceBucket();
  const dailyPullRequests = emptyDashboardCadenceBucket();
  const dailyNewIssues = emptyDashboardCadenceBucket();
  const weeklyOlderIssues = emptyDashboardCadenceBucket();
  const activity = emptyDashboardActivityStats();
  const recent: DashboardItem[] = [];
  for (const file of files) {
    const markdown = readFileSync(join(itemsDir, file), "utf8");
    const number = Number(file.replace(/\.md$/, ""));
    const reviewedAt = frontMatterValue(markdown, "reviewed_at");
    const reviewStatus = effectiveReviewStatus(markdown);
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const decision = frontMatterValue(markdown, "decision") ?? "unknown";
    const kind = (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue";
    const freshReview = isFresh({ reviewedAt, reviewStatus });
    byKind[kind].total += 1;
    if (freshReview) fresh += 1;
    if (freshReview) byKind[kind].fresh += 1;
    if (freshReview && decision === "close" && action === "proposed_close") proposedClose += 1;
    if (freshReview && decision === "close" && action === "proposed_close")
      byKind[kind].proposedClose += 1;
    if (action === "closed") closed += 1;
    if (reviewStatus === "failed") failed += 1;
    if (reviewStatus.startsWith("stale_")) stale += 1;
    recordDashboardActivity(markdown, activity, now);
    const cadence = cadenceBucketForReview(markdown, now);
    const cadenceBucket =
      cadence.bucket === "hourlyHotItems"
        ? hourlyHotItems
        : cadence.bucket === "dailyPullRequests"
          ? dailyPullRequests
          : cadence.bucket === "dailyNewIssues"
            ? dailyNewIssues
            : weeklyOlderIssues;
    cadenceBucket.total += 1;
    if (isCurrentForCadence({ reviewedAt, reviewStatus, cadenceMs: cadence.cadenceMs, now })) {
      cadenceBucket.current += 1;
    }
    if (decision === "close" && action === "proposed_close") cadenceBucket.proposedClose += 1;
    recent.push({
      number,
      kind,
      title: frontMatterValue(markdown, "title") ?? "",
      reviewedAt,
      decision,
      action,
      reviewStatus,
    });
  }
  for (const file of closedFiles) {
    const markdown = readFileSync(join(closedDir, file), "utf8");
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    if (action === "closed") closed += 1;
    recordDashboardActivity(markdown, activity, now);
  }
  recent.sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
  const hourly = emptyDashboardCadenceBucket();
  addDashboardCadenceBucket(hourly, hourlyHotItems);
  const daily = emptyDashboardCadenceBucket();
  const cappedDailyPullRequests = capDashboardCadenceBucket(dailyPullRequests, open.pullRequests);
  addDashboardCadenceBucket(daily, cappedDailyPullRequests);
  addDashboardCadenceBucket(daily, dailyNewIssues);
  const weekly = emptyDashboardCadenceBucket();
  addDashboardCadenceBucket(weekly, weeklyOlderIssues);
  const unreviewedOpen =
    Math.max(0, open.issues - byKind.issue.total) +
    Math.max(0, open.pullRequests - byKind.pull_request.total);
  const cadenceDue =
    hourly.total -
    hourly.current +
    (daily.total - daily.current) +
    (weekly.total - weekly.current) +
    unreviewedOpen;
  return {
    open,
    fresh,
    todo: cadenceDue,
    files: files.length,
    proposedClose,
    closed,
    archivedFiles: closedFiles.length,
    failed,
    stale,
    byKind,
    cadence: {
      hourlyHotItems,
      dailyPullRequests: cappedDailyPullRequests,
      dailyNewIssues,
      weeklyOlderIssues,
      hourly,
      daily,
      weekly,
      unreviewedOpen,
      due: cadenceDue,
    },
    activity,
    recent,
  };
}

function updateDashboard(itemsDir = join(ROOT, "items"), closedDir = join(ROOT, "closed")): void {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const stats = dashboardStats(itemsDir, closedDir);
  const status = currentWorkflowStatusBlock(readme);
  const auditHealth = currentAuditHealthSection(readme);
  const recent =
    stats.recent
      .slice(0, 10)
      .map((item) => {
        const title = displayTitle(item.title);
        const outcome = markdownLink(
          `${item.decision} / ${item.action}`,
          reportFileUrl(item.number),
        );
        return `| ${markdownLink(`#${item.number}`, itemUrl(item.number, item.kind))} | ${title.replaceAll("|", "\\|")} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |";
  const dashboard = `## Dashboard

Last dashboard update: ${formatTimestamp(new Date().toISOString())}

### Current Run

${status}

### Queue

| Metric | Count |
| --- | ---: |
| Open issues in ${markdownLink(TARGET_REPO, repoUrl())} | ${stats.open.issues} |
| Open PRs in ${markdownLink(TARGET_REPO, repoUrl())} | ${stats.open.pullRequests} |
| Open items total | ${stats.open.total} |
| Reviewed files | ${stats.files} |
| Unreviewed open items | ${stats.cadence.unreviewedOpen} |
| Archived closed files | ${stats.archivedFiles} |

### Review Outcomes

| Metric | Count |
| --- | ---: |
| Fresh reviewed issues in the last ${FRESH_DAYS} days | ${stats.byKind.issue.fresh} |
| Proposed issue closes | ${stats.byKind.issue.proposedClose} (${formatPercent(stats.byKind.issue.proposedClose, stats.byKind.issue.fresh)} of reviewed issues) |
| Fresh reviewed PRs in the last ${FRESH_DAYS} days | ${stats.byKind.pull_request.fresh} |
| Proposed PR closes | ${stats.byKind.pull_request.proposedClose} (${formatPercent(stats.byKind.pull_request.proposedClose, stats.byKind.pull_request.fresh)} of reviewed PRs) |
| Fresh verified reviews in the last ${FRESH_DAYS} days | ${stats.fresh} |
| Proposed closes awaiting apply | ${stats.proposedClose} (${formatPercent(stats.proposedClose, stats.fresh)} of fresh reviews) |
| Closed by Codex apply | ${stats.closed} |
| Failed or stale reviews | ${stats.failed + stats.stale} |

### Cadence

| Metric | Coverage |
| --- | ---: |
| Hourly cadence coverage | ${formatCadenceBucket(stats.cadence.hourly)} |
| Hourly hot item cadence (<${HOT_REVIEW_DAYS}d) | ${formatCadenceBucket(stats.cadence.hourlyHotItems)} |
| Daily cadence coverage | ${formatCadenceBucket(stats.cadence.daily)} |
| Daily PR cadence | ${formatCadenceBucket(stats.cadence.dailyPullRequests)} |
| Daily new issue cadence (<${RECENT_ISSUE_DAYS}d) | ${formatCadenceBucket(stats.cadence.dailyNewIssues)} |
| Weekly older issue cadence | ${formatCadenceBucket(stats.cadence.weekly)} |
| Due now by cadence | ${stats.cadence.due} |

${auditHealth}

### Latest Run Activity

Latest review: ${formatTimestamp(stats.activity.latestReviewAt)}. Latest close: ${formatTimestamp(stats.activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(stats.activity.latestCommentSyncAt)}.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${formatActivityRow("Last 15 minutes", stats.activity.last15Minutes)}
${formatActivityRow("Last hour", stats.activity.lastHour)}
${formatActivityRow("Last 24 hours", stats.activity.last24Hours)}

<details>
<summary>Recently Reviewed (latest 10)</summary>

<br>

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
${recent}

</details>`;
  const updated = readme.replace(
    /## Dashboard[\s\S]*?## How It Works/,
    `${dashboard}\n\n## How It Works`,
  );
  writeFileSync(readmePath, updated, "utf8");
}

function statusCommand(args: Args): void {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const state = stringArg(args.state, "Working");
  const detail = stringArg(args.detail, "Workflow is running.");
  const runUrl = stringArg(args.run_url, "");
  const block = workflowStatusBlock(runUrl ? { state, detail, runUrl } : { state, detail });
  const pattern = new RegExp(`${STATUS_START}[\\s\\S]*?${STATUS_END}`);
  const updated = pattern.test(readme)
    ? readme.replace(pattern, block)
    : readme.replace(/Last dashboard update: .+/, `$&\n\n${block}`);
  writeFileSync(readmePath, updated, "utf8");
}

function checkCommand(): void {
  JSON.parse(readFileSync(join(ROOT, "schema", "clawsweeper-decision.schema.json"), "utf8"));
  if (!existsSync(join(ROOT, ".github", "workflows", "sweep.yml")))
    throw new Error("Missing workflow");
  console.log("ok");
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const command = args._[0] ?? "review";
  if (command === "plan") planCommand(args);
  else if (command === "review") reviewCommand(args);
  else if (command === "apply-artifacts") applyArtifactsCommand(args);
  else if (command === "apply-decisions") applyDecisionsCommand(args);
  else if (command === "audit") auditCommand(args);
  else if (command === "reconcile") reconcileCommand(args);
  else if (command === "dashboard")
    updateDashboard(
      resolve(stringArg(args.items_dir, join(ROOT, "items"))),
      resolve(stringArg(args.closed_dir, join(ROOT, "closed"))),
    );
  else if (command === "status") statusCommand(args);
  else if (command === "check") checkCommand();
  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
