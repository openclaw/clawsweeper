#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isActionEventPublishPath } from "./action-ledger-paths.js";
import {
  ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS,
  flushWorkflowActionEvents,
  importActionEventShards,
  interruptOpenWorkflowActionEvents,
  workflowActionProducer,
} from "./action-ledger-runtime.js";
import { ACTION_EVENT_REASON_CODES } from "./action-ledger.js";
import {
  boolArg,
  itemNumbersArg,
  numberArg,
  optionalNumberArg,
  parseArgs,
  stringArg,
  type Args,
} from "./clawsweeper-args.js";
import { dispatchCommand, type CommandHandler } from "./clawsweeper-command-dispatch.js";
import { createDecisionParser } from "./clawsweeper-decision-parser.js";
import { codexEnv } from "./codex-env.js";
import {
  isUserFacingCommandError,
  resolveCommand,
  runText,
  UserFacingCommandError,
} from "./command.js";
import { parseGhJson, parseGhJsonLinesWithRetry, parseGhJsonWithRetry } from "./github-json.js";
import { ghRetryKind, ghRetryWaitMs, summarizeGhArgs } from "./github-retry.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import {
  DEFAULT_TARGET_REPO,
  normalizeRepo,
  repositoryProfileFor,
  repositoryProfileForSlug,
  type RepositoryProfile,
} from "./repository-profiles.js";
import { reviewPullChecksDigestParts } from "./review-checks-digest.js";
import { coverageTrackedItemIdsFromManifest } from "./review-coverage-manifest.js";
import {
  reviewStructuralQuery,
  reviewStructuralRecordFromGraphql,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import { stableJson } from "./stable-json.js";
import { publishStateBlob } from "./state-blob-client.js";

import { createApplyDecisionWorkflow } from "./clawsweeper-apply-decision-workflow.js";
import { createApplyGuards } from "./clawsweeper-apply-guards.js";
import { createAssistWorkflow } from "./clawsweeper-assist.js";
import { isDocsPath } from "./clawsweeper-change-detection.js";
import { createCloseDecisionWorkflow } from "./clawsweeper-close-decision.js";
import { createCommandOperations } from "./clawsweeper-command-operations.js";
import { createContextHydration } from "./clawsweeper-context-hydration.js";
import { createDashboardAudit } from "./clawsweeper-dashboard-audit.js";
import { createGitHubContext } from "./clawsweeper-github-context.js";
import { createItemContext } from "./clawsweeper-item-context.js";
import { createLabelPolicy } from "./clawsweeper-label-policy.js";
import { createRepositoryLinks } from "./clawsweeper-links.js";
import { createLocalRangeReviewer } from "./clawsweeper-local-review.js";
import {
  ALLOWED_REASONS,
  APPLY_PROTECTED_LABELS,
  AUTHOR_PR_BUDGET_MIN_AGE_DAYS,
  DAY_MS,
  DEFAULT_BACKFILL_REVIEW_AGE_MINUTES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SERVICE_TIER,
  EVENT_GUARDED_OPEN_ACTIONS,
  FRESH_DAYS,
  OBSOLETE_FIX_PR_MIN_AGE_DAYS,
  PROTECTED_LABELS,
  REVIEW_POLICY_VERSION,
  STALE_VERSION_BUG_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS,
  UNSPONSORED_FEATURE_MIN_AGE_DAYS,
} from "./clawsweeper-policy.js";
import { createRecordMetadata } from "./clawsweeper-record-metadata.js";
import { createReportHelpers } from "./clawsweeper-report-helpers.js";
import { createReportOrchestration } from "./clawsweeper-report-orchestration.js";
import { createReportParser } from "./clawsweeper-report-parser.js";
import { createReviewCommandWorkflow } from "./clawsweeper-review-command-workflow.js";
import { createReviewCommentWorkflow } from "./clawsweeper-review-comments-workflow.js";
import { createReviewActionLedger } from "./clawsweeper-review-ledger.js";
import { createReviewPlanning } from "./clawsweeper-review-planning.js";
import { createReviewPresentation } from "./clawsweeper-review-presentation.js";
import { createReviewRuntime } from "./clawsweeper-review-runtime.js";
import { createSourceRevisionTools } from "./clawsweeper-source-revision.js";
import { createStatusContext } from "./clawsweeper-status-context.js";
import type {
  AcquiredReviewStartLease,
  ApplyKind,
  CloseReason,
  Decision,
  DecisionNormalizationItem,
  Evidence,
  GitHubDispatchOutcome,
  GitHubRetryOptions,
  GitHubRuntimeBudget,
  GitInfo,
  Item,
  ItemContext,
  MantisRecommendation,
  MutationRunner,
  ReportEntry,
  ReviewStartStatusCommentResult,
  SecurityConcern,
} from "./clawsweeper-types.js";
export type {
  BulkFilerDetectionResult,
  BulkFilerReviewContext,
  ContextHydration,
  GitHubDispatchOutcome,
  GithubPageWithHeaders,
  LabelJustification,
  ReviewStartStatusCommentOptions,
} from "./clawsweeper-types.js";

export { itemNumbersArg } from "./clawsweeper-args.js";
export {
  configSurfaceChangeFromPullFilesForTest,
  dataModelChangeFromPullFilesForTest,
} from "./clawsweeper-change-detection.js";
export {
  prepareMediaProofArtifactsForTest,
  proofMediaUrlsFromContextForTest,
  proofVideoUrlsFromContextForTest,
} from "./clawsweeper-media-proof.js";
export { safeOutputTail } from "./clawsweeper-text.js";
export {
  codexEnv,
  codexLoginConfig,
  codexLoginMethod,
  redactInternalCodexModel,
} from "./codex-env.js";
export {
  buildDecisionPacketFromReport,
  renderDecisionPacketPublicBlock,
} from "./decision-packets.js";
export {
  parseGhJson,
  parseGhJsonLines,
  parseGhJsonLinesWithRetry,
  parseGhJsonWithRetry,
  parseGhJsonWithRetryAsync,
} from "./github-json.js";
export {
  ghRetryKind,
  ghRetryWaitMs,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  shouldRetryGh,
} from "./github-retry.js";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// The bulk-filer policy is intentionally narrower than the general maintainer
// policy: repository owners and members can legitimately create high volumes
// of coordinated issues, while outside collaborators remain in scope.
const BULK_FILER_EXEMPT_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER"]);
// GitHub can redact an organization member's issue author_association to
// CONTRIBUTOR for an App installation token. Elevated repository roles are a
// narrow, independently readable fallback for that case; ordinary write
// collaborators remain subject to the bulk-filer policy.
const BULK_FILER_EXEMPT_REPOSITORY_PERMISSIONS = new Set(["admin", "maintain"]);

function suppliedReviewStartLeaseFromArgs(
  args: Args,
): Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null {
  const owner = stringArg(args.review_lease_owner, "").trim();
  const commentId = numberArg(args.review_lease_comment_id, 0);
  if (!owner && commentId === 0) return null;
  if (!owner || !Number.isInteger(commentId) || commentId <= 0) {
    throw new UserFacingCommandError(
      "--review-lease-owner and --review-lease-comment-id must be supplied together.",
    );
  }
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(owner)) {
    throw new UserFacingCommandError("--review-lease-owner contains unsupported characters.");
  }
  return { owner, commentId };
}

function isSuppliedReviewStartLease(
  supplied: Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null,
  lease: Pick<AcquiredReviewStartLease, "owner" | "commentId">,
): boolean {
  return supplied?.owner === lease.owner && supplied.commentId === lease.commentId;
}

export function isSuppliedReviewStartLeaseForTest(
  supplied: Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null,
  lease: Pick<AcquiredReviewStartLease, "owner" | "commentId">,
): boolean {
  return isSuppliedReviewStartLease(supplied, lease);
}

function reviewLeaseStillMatchesContext(
  itemKind: "issue" | "pull_request",
  contextPullHeadSha: string | null,
  leaseHeadSha: string,
): boolean {
  return itemKind !== "pull_request" || contextPullHeadSha?.trim().toLowerCase() === leaseHeadSha;
}

export function reviewLeaseStillMatchesContextForTest(
  itemKind: "issue" | "pull_request",
  contextPullHeadSha: string | null,
  leaseHeadSha: string,
): boolean {
  return reviewLeaseStillMatchesContext(itemKind, contextPullHeadSha, leaseHeadSha);
}

function heldReviewStartStatusCommentResult(
  retryAt: string,
  didMutate: boolean,
): ReviewStartStatusCommentResult {
  return { status: "held", lease: null, retryAt, didMutate };
}

export function heldReviewStartStatusCommentResultForTest(
  retryAt: string,
  didMutate: boolean,
): ReviewStartStatusCommentResult {
  return heldReviewStartStatusCommentResult(retryAt, didMutate);
}

const DEFAULT_PLAN_BATCH_SIZE = 3;
const DEFAULT_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.normal_default;
const MAX_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.hard_cap;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_REPO = "openclaw/clawsweeper";
const RECORDS_ROOT = join(ROOT, "records");
let activeRepositoryProfile = repositoryProfileFor(
  process.env.CLAWSWEEPER_TARGET_REPO ?? DEFAULT_TARGET_REPO,
);
const REVIEW_ITEM_PROMPT_PATH = join(ROOT, "prompts", "review-item.md");
const CLAWSWEEPER_DECISION_SCHEMA_PATH = join(ROOT, "schema", "clawsweeper-decision.schema.json");
const MATURITY_STABLE_SHORTLIST_SCRIPT_PATH = join(
  ROOT,
  "scripts",
  "maturity-stable-shortlist.mjs",
);
const PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH = join(ROOT, "prompts", "pr-close-coverage-proof.md");
const PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH = join(
  ROOT,
  "schema",
  "clawsweeper-pr-close-coverage-proof.schema.json",
);

export function guardedOpenApplyProofFields(
  actionTaken: string,
  options: { emitEventApplyProof: boolean; liveGuardVerified: boolean },
): { guardedOpenStateVerified?: true } {
  return options.emitEventApplyProof &&
    options.liveGuardVerified &&
    EVENT_GUARDED_OPEN_ACTIONS.has(actionTaken)
    ? { guardedOpenStateVerified: true }
    : {};
}

function targetProfile(): RepositoryProfile {
  return activeRepositoryProfile;
}

function targetRepo(): string {
  return activeRepositoryProfile.targetRepo;
}

const repositoryLinks = createRepositoryLinks({
  reportRepo: REPORT_REPO,
  normalizeRepo,
  targetProfile,
  targetRepo,
});
const {
  docsPageUrl,
  fileUrl,
  isCommitSha,
  itemUrlFor,
  latestFileUrl,
  linkedRelease,
  linkedSha,
  markdownLink,
  repoUrlFor,
  reportFileUrl,
  reportUrl,
  splitFileAndLine,
} = repositoryLinks;

function setTargetRepo(targetRepoName: string): RepositoryProfile {
  activeRepositoryProfile = repositoryProfileFor(targetRepoName);
  return activeRepositoryProfile;
}

function targetRepoInput(args: Args): string {
  return stringArg(
    args.target_repo,
    process.env.CLAWSWEEPER_TARGET_REPO ?? process.env.TARGET_REPO ?? DEFAULT_TARGET_REPO,
  );
}

function repoFromArgs(args: Args): RepositoryProfile {
  return setTargetRepo(targetRepoInput(args));
}

function withTargetProfile<T>(profile: RepositoryProfile, fn: () => T): T {
  const previousProfile = activeRepositoryProfile;
  activeRepositoryProfile = profile;
  try {
    return fn();
  } finally {
    activeRepositoryProfile = previousProfile;
  }
}

function profileStatusStart(profile = targetProfile()): string {
  return `<!-- clawsweeper-status:${profile.slug}:start -->`;
}

function profileStatusEnd(profile = targetProfile()): string {
  return `<!-- clawsweeper-status:${profile.slug}:end -->`;
}

function profileAuditStart(profile = targetProfile()): string {
  return `<!-- clawsweeper-audit:${profile.slug}:start -->`;
}

function profileAuditEnd(profile = targetProfile()): string {
  return `<!-- clawsweeper-audit:${profile.slug}:end -->`;
}

function sweepStatusPath(profile = targetProfile()): string {
  return join(ROOT, "results", "sweep-status", `${profile.slug}.json`);
}

function sweepStatusRelativePath(profile = targetProfile()): string {
  return join("results", "sweep-status", `${profile.slug}.json`);
}

function auditStatePath(profile = targetProfile()): string {
  return join(ROOT, "results", "audit", `${profile.slug}.json`);
}

function sweepStatusApplyHealth(options: {
  previousApplyHealth?: Record<string, unknown> | undefined;
  requestedApplyHealth?: Record<string, unknown> | null | undefined;
  runUrl?: string | undefined;
}): Record<string, unknown> | null | undefined {
  const applyHealth =
    options.requestedApplyHealth === undefined
      ? options.previousApplyHealth
      : options.requestedApplyHealth;
  return options.requestedApplyHealth !== undefined && applyHealth && options.runUrl
    ? { ...applyHealth, run_url: options.runUrl }
    : applyHealth;
}

export function sweepStatusApplyHealthForTest(options: {
  previousApplyHealth?: Record<string, unknown> | undefined;
  requestedApplyHealth?: Record<string, unknown> | null | undefined;
  runUrl?: string | undefined;
}): Record<string, unknown> | null | undefined {
  return sweepStatusApplyHealth(options);
}

function writeSweepStatus(options: {
  state: string;
  detail: string;
  runUrl?: string;
  profile?: RepositoryProfile;
  plannedCount?: number;
  plannedCapacity?: number;
  plannedShards?: number;
  activeCodex?: number;
  dueBacklog?: number;
  oldestUnreviewedAt?: string;
  capacityReason?: string;
  inheritedLabelCleanups?: number;
  selfHealConflictRepairs?: number;
  failedReviewRetries?: number;
  failedReviewRetryExhaustions?: number;
  botOwnedProofDecisionsRequested?: number;
  botOwnedProofDispatches?: number;
  applyHealth?: Record<string, unknown> | null;
}): void {
  const profile = options.profile ?? targetProfile();
  const updatedAt = new Date().toISOString();
  const previousStatus = readSweepStatusSummary(profile);
  const applyHealth = sweepStatusApplyHealth({
    previousApplyHealth: previousStatus?.applyHealth,
    requestedApplyHealth: options.applyHealth,
    runUrl: options.runUrl,
  });
  const previousCloseApplyHealth =
    previousStatus?.lastCloseApplyHealth ??
    (previousStatus?.applyHealth?.mode === "close" ? previousStatus.applyHealth : undefined);
  const lastCloseApplyHealth =
    applyHealth && applyHealth.mode === "close" ? applyHealth : previousCloseApplyHealth;
  const payload = {
    schema_version: 1,
    slug: profile.slug,
    display_name: profile.displayName,
    target_repo: profile.targetRepo,
    state: options.state,
    detail: options.detail,
    run_url: options.runUrl ?? null,
    planned_count: options.plannedCount ?? null,
    planned_capacity: options.plannedCapacity ?? null,
    planned_shards: options.plannedShards ?? null,
    active_codex: options.activeCodex ?? null,
    due_backlog: options.dueBacklog ?? null,
    oldest_unreviewed_at: options.oldestUnreviewedAt ?? null,
    capacity_reason: options.capacityReason ?? null,
    inherited_label_cleanups: options.inheritedLabelCleanups ?? null,
    self_heal_conflict_repairs: options.selfHealConflictRepairs ?? null,
    failed_review_retries: options.failedReviewRetries ?? null,
    failed_review_retry_exhaustions: options.failedReviewRetryExhaustions ?? null,
    bot_owned_proof_decisions_requested: options.botOwnedProofDecisionsRequested ?? null,
    bot_owned_proof_dispatches: options.botOwnedProofDispatches ?? null,
    apply_health: applyHealth ?? null,
    last_close_apply_health: lastCloseApplyHealth ?? null,
    updated_at: updatedAt,
  };
  const outputPath = sweepStatusPath(profile);
  ensureDir(dirname(outputPath));
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function repoRecordsDir(profile = targetProfile()): string {
  return join(RECORDS_ROOT, profile.slug);
}

function defaultItemsDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "items");
}

function defaultClosedDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "closed");
}

function defaultPlansDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "plans");
}

function defaultFailedReviewRetryStateDir(profile = targetProfile()): string {
  return join(ROOT, "results", "failed-review-retries", profile.slug);
}

function defaultDecisionPacketsDir(profile = targetProfile()): string {
  return join(repoRecordsDir(profile), "decision-packets");
}

function siblingDecisionPacketsDir(
  recordDir: string,
  recordDirName: "items" | "closed",
): string | undefined {
  return basename(recordDir) === recordDirName
    ? join(dirname(recordDir), "decision-packets")
    : undefined;
}

function defaultDecisionPacketsDirForRecordDirs(
  itemsDir: string,
  closedDir: string,
  profile = targetProfile(),
): string {
  const itemsPacketsDir = siblingDecisionPacketsDir(itemsDir, "items");
  const closedPacketsDir = siblingDecisionPacketsDir(closedDir, "closed");
  if (itemsPacketsDir && (!closedPacketsDir || itemsPacketsDir === closedPacketsDir)) {
    return itemsPacketsDir;
  }
  if (closedPacketsDir && !itemsPacketsDir) return closedPacketsDir;
  return defaultDecisionPacketsDir(profile);
}

function decisionPacketsDirFromArgs(args: Args, itemsDir: string, closedDir: string): string {
  const explicitDecisionPacketsDir = stringArg(args.decision_packets_dir, "");
  if (explicitDecisionPacketsDir) return resolve(explicitDecisionPacketsDir);
  if (typeof args.items_dir === "string") {
    const itemsPacketsDir = siblingDecisionPacketsDir(itemsDir, "items");
    if (itemsPacketsDir) return resolve(itemsPacketsDir);
  }
  if (typeof args.closed_dir === "string") {
    const closedPacketsDir = siblingDecisionPacketsDir(closedDir, "closed");
    if (closedPacketsDir) return resolve(closedPacketsDir);
  }
  return resolve(defaultDecisionPacketsDirForRecordDirs(itemsDir, closedDir));
}

function reportFileName(repo: string, number: number): string {
  repositoryProfileFor(repo);
  return `${number}.md`;
}

function parseReportFileName(file: string): { repo: string | undefined; number: number } | null {
  const numeric = file.match(/^(\d+)\.md$/);
  if (numeric?.[1]) return { repo: undefined, number: Number(numeric[1]) };
  const prefixed = file.match(/^([a-z0-9][a-z0-9-]*)-(\d+)\.md$/);
  if (!prefixed?.[1] || !prefixed[2]) return null;
  return { repo: repositoryProfileForSlug(prefixed[1])?.targetRepo, number: Number(prefixed[2]) };
}

function markdownRepository(markdown: string, file?: string): string {
  const fromMarkdown = frontMatterValue(markdown, "repository");
  if (fromMarkdown) return normalizeRepo(fromMarkdown);
  if (file) {
    const normalizedPath = repoRelativePath(file);
    const recordsMatch = normalizedPath.match(/^records\/([^/]+)\//);
    if (recordsMatch?.[1]) {
      const profile = repositoryProfileForSlug(recordsMatch[1]);
      if (profile) return profile.targetRepo;
    }
    const parsed = parseReportFileName(basename(file));
    if (parsed?.repo) return parsed.repo;
  }
  return DEFAULT_TARGET_REPO;
}

function isMarkdownForActiveRepo(markdown: string, file?: string): boolean {
  return markdownRepository(markdown, file) === targetRepo();
}

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

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number | undefined } = {},
): string {
  return runText(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: options.timeoutMs,
    trim: "both",
  });
}

const GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS = 1_000;

class GitHubRuntimeBudgetError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "GitHubRuntimeBudgetError";
  }
}

let activeGitHubRuntimeBudget: GitHubRuntimeBudget | null = null;

function withGitHubRuntimeBudget<T>(runtimeBudget: GitHubRuntimeBudget, operation: () => T): T {
  const previousRuntimeBudget = activeGitHubRuntimeBudget;
  activeGitHubRuntimeBudget = runtimeBudget;
  try {
    return operation();
  } finally {
    activeGitHubRuntimeBudget = previousRuntimeBudget;
  }
}

function githubRuntimeRemainingMs(nowMs = Date.now()): number | null {
  const budget = activeGitHubRuntimeBudget;
  if (!budget || budget.maxRuntimeMs <= 0) return null;
  return (
    budget.maxRuntimeMs - (nowMs - budget.startedAtMs) - GITHUB_RUNTIME_REPORT_FLUSH_RESERVE_MS
  );
}

function githubRuntimeBudgetError(phase: string): GitHubRuntimeBudgetError {
  const budget = activeGitHubRuntimeBudget;
  const reason =
    budget?.yieldReason ??
    budget?.limitReason ??
    `max runtime ${budget?.maxRuntimeMs ?? 0}ms reached ${phase}`;
  if (budget) budget.yieldReason = reason;
  return new GitHubRuntimeBudgetError(reason);
}

function pendingGitHubRuntimeBudgetError(): GitHubRuntimeBudgetError | null {
  const reason = activeGitHubRuntimeBudget?.yieldReason;
  return reason ? new GitHubRuntimeBudgetError(reason) : null;
}

function githubCommandTimeoutMs(requestedTimeoutMs?: number): number | undefined {
  const pendingError = pendingGitHubRuntimeBudgetError();
  if (pendingError) throw pendingError;
  const remainingMs = githubRuntimeRemainingMs();
  if (remainingMs === null) return requestedTimeoutMs;
  if (remainingMs <= 0) throw githubRuntimeBudgetError("before GitHub operation");
  return Math.max(
    1,
    requestedTimeoutMs === undefined ? remainingMs : Math.min(requestedTimeoutMs, remainingMs),
  );
}

function ensureGitHubRuntimeAvailable(phase: string): void {
  const pendingError = pendingGitHubRuntimeBudgetError();
  if (pendingError) throw pendingError;
  const remainingMs = githubRuntimeRemainingMs();
  if (remainingMs !== null && remainingMs <= 0) throw githubRuntimeBudgetError(phase);
}

function ensureRuntimeDelayFits(waitMs: number, phase: string): void {
  const pendingError = pendingGitHubRuntimeBudgetError();
  if (pendingError) throw pendingError;
  const remainingMs = githubRuntimeRemainingMs();
  if (remainingMs !== null && remainingMs <= waitMs) {
    throw githubRuntimeBudgetError(phase);
  }
}

function ensureGitHubRetryFits(waitMs: number): void {
  ensureRuntimeDelayFits(waitMs, "before GitHub retry");
}

function sleepBeforeGitHubRetry(waitMs: number): void {
  ensureGitHubRetryFits(waitMs);
  sleepMs(waitMs);
}

function ghWithPreparedTimeout(args: string[], timeoutMs: number | undefined): string {
  if (args[0] === "api") return run("gh", args, { timeoutMs });
  return run("gh", ["--repo", targetRepo(), ...args], { timeoutMs });
}

function gh(args: string[]): string {
  return ghWithPreparedTimeout(args, githubCommandTimeoutMs());
}

function ghOnce(args: string[], timeoutMs: number): string {
  const resolvedArgs = args[0] === "api" ? args : ["--repo", targetRepo(), ...args];
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const command = resolveCommand("gh", resolvedArgs, env);
  const commandTimeoutMs = githubCommandTimeoutMs(timeoutMs) ?? timeoutMs;
  const runtimeLimitedTimeout = commandTimeoutMs < timeoutMs;
  const result = spawnSync(command.command, command.args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: commandTimeoutMs,
  });
  if (result.error) {
    if (runtimeLimitedTimeout && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw githubRuntimeBudgetError("during GitHub operation");
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      [`Command failed: gh ${resolvedArgs.join(" ")}`, stderr].filter(Boolean).join("\n"),
    );
  }
  return (result.stdout ?? "").trim();
}

function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function untrustedCodexEnv(
  options: {
    ghToken?: string | undefined;
    preserveCodexAuth?: boolean | undefined;
  } = {},
): NodeJS.ProcessEnv {
  const env = codexEnv(options);
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAWSWEEPER_ACTION_LEDGER_")) delete env[key];
  }
  return env;
}

export function untrustedCodexEnvForTest(
  env: NodeJS.ProcessEnv,
  options: {
    ghToken?: string | undefined;
    preserveCodexAuth?: boolean | undefined;
  } = {},
): NodeJS.ProcessEnv {
  const previousEnv = process.env;
  try {
    process.env = { ...env };
    return untrustedCodexEnv(options);
  } finally {
    process.env = previousEnv;
  }
}

let lastThrottleHeartbeatAt = 0;
let throttleHeartbeatContext: (() => string) | null = null;

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
    writeSweepStatus(statusOptions);
    run("git", ["add", sweepStatusRelativePath()]);
    const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
    if (diff.status === 0) return;
    run("git", ["commit", "-m", "chore: update sweep apply throttle status"]);
    try {
      run("git", ["push"], { timeoutMs: githubCommandTimeoutMs() });
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      console.error(
        `Best-effort throttle status push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    if (error instanceof GitHubRuntimeBudgetError) throw error;
    console.error(
      `Best-effort throttle status update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function ghWithRetry(args: string[], attempts = 12, options: GitHubRetryOptions = {}): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return options.request?.(args, attempt) ?? gh(args);
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      lastError = error;
      ensureGitHubRuntimeAvailable("after GitHub operation");
      const retryKind = ghRetryKind(error);
      if (retryKind === "none" || attempt === attempts - 1) throw error;
      const waitMs = ghRetryWaitMs(retryKind, attempt);
      ensureGitHubRetryFits(waitMs);
      const retryLabel =
        retryKind === "throttle" ? "GitHub throttled" : "Transient GitHub API failure";
      console.error(
        `${retryLabel}; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      if (retryKind === "throttle") {
        maybePublishThrottleHeartbeat({ args, attempt, attempts, waitMs });
      }
      if (options.sleepBeforeRetry) options.sleepBeforeRetry(waitMs);
      else sleepBeforeGitHubRetry(waitMs);
    }
  }
  throw lastError;
}

class ApplyMutationReviewGuardError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ApplyMutationReviewGuardError";
  }
}

let activeApplyMutationRunner: MutationRunner | null = null;
let activeReviewMutationRunner: MutationRunner | null = null;

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runObservedApplyMutation<T>(options: {
  identity: string;
  idempotencyIdentity?: string | undefined;
  operation: () => T;
  onMutation?: (() => void) | undefined;
  didMutate?: ((result: T) => boolean) | undefined;
  knownNoMutation?: ((error: unknown) => boolean) | undefined;
}): T {
  const runner = activeApplyMutationRunner ?? activeReviewMutationRunner;
  if (runner) {
    return runner({
      identity: options.identity,
      idempotencyIdentity: options.idempotencyIdentity ?? options.identity,
      operation: options.operation,
      ...(options.didMutate ? { didMutate: options.didMutate } : {}),
      ...(options.knownNoMutation ? { knownNoMutation: options.knownNoMutation } : {}),
    });
  }
  const result = options.operation();
  if (options.didMutate?.(result) ?? true) options.onMutation?.();
  return result;
}

function ghObservedMutationCommand(options: {
  identity: string;
  args: string[];
  attempts?: number | undefined;
  onMutation?: (() => void) | undefined;
  didMutate?: ((result: string) => boolean) | undefined;
  knownNoMutation?: ((error: unknown) => boolean) | undefined;
  request?: ((args: string[], attempt: number) => string) | undefined;
  prepareRequest?: ((args: string[], attempt: number) => () => string) | undefined;
  sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
}): string {
  return ghWithRetry(options.args, options.attempts ?? 12, {
    request: (args, attempt) => {
      let operation: () => string;
      if (options.prepareRequest) {
        operation = options.prepareRequest(args, attempt);
      } else if (options.request) {
        const request = options.request;
        operation = () => request(args, attempt);
      } else {
        const timeoutMs = githubCommandTimeoutMs();
        operation = () => ghWithPreparedTimeout(args, timeoutMs);
      }
      return runObservedApplyMutation({
        identity: `${options.identity}:request_attempt:${attempt + 1}`,
        idempotencyIdentity: options.identity,
        operation,
        ...(options.onMutation ? { onMutation: options.onMutation } : {}),
        ...(options.didMutate ? { didMutate: options.didMutate } : {}),
        ...(options.knownNoMutation ? { knownNoMutation: options.knownNoMutation } : {}),
      });
    },
    ...(options.sleepBeforeRetry ? { sleepBeforeRetry: options.sleepBeforeRetry } : {}),
  });
}

export function observedGitHubMutationAttemptsForTest(
  outcomes: readonly ("not_started" | "transient" | "accepted" | "already_exists")[],
): Array<{
  identity: string;
  idempotencyIdentity: string;
  outcome: "accepted" | "rejected" | "unknown";
}> {
  const receipts: Array<{
    identity: string;
    idempotencyIdentity: string;
    outcome: "accepted" | "rejected" | "unknown";
  }> = [];
  const previousRunner = activeApplyMutationRunner;
  activeApplyMutationRunner = <T>(options: {
    identity: string;
    idempotencyIdentity: string;
    operation: () => T;
    didMutate?: ((result: T) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
  }): T => {
    try {
      const result = options.operation();
      receipts.push({
        identity: options.identity,
        idempotencyIdentity: options.idempotencyIdentity,
        outcome: options.didMutate?.(result) === false ? "rejected" : "accepted",
      });
      return result;
    } catch (error) {
      receipts.push({
        identity: options.identity,
        idempotencyIdentity: options.idempotencyIdentity,
        outcome: options.knownNoMutation?.(error) === true ? "rejected" : "unknown",
      });
      throw error;
    }
  };
  try {
    ghObservedMutationCommand({
      identity: "test_mutation",
      args: ["api", "test"],
      attempts: outcomes.length,
      knownNoMutation: labelAlreadyExistsError,
      prepareRequest: (_args, attempt) => {
        const outcome = outcomes[attempt];
        if (outcome === "not_started") {
          throw new GitHubRuntimeBudgetError("max runtime reached before GitHub operation");
        }
        return () => {
          if (outcome === "accepted") return "ok";
          if (outcome === "already_exists") throw new Error("label already exists");
          throw new Error("HTTP 502: transient upstream failure");
        };
      },
      sleepBeforeRetry: () => {},
    });
  } catch {
    // The receipts are the assertion surface for rejected terminal attempts.
  } finally {
    activeApplyMutationRunner = previousRunner;
  }
  return receipts;
}

class GitHubDispatchError extends Error {
  readonly outcome: Exclude<GitHubDispatchOutcome, "accepted">;
  readonly cause: unknown;

  constructor(outcome: Exclude<GitHubDispatchOutcome, "accepted">, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "GitHubDispatchError";
    this.outcome = outcome;
    this.cause = cause;
  }
}

function classifyGitHubDispatchResult(options: {
  status: number | null;
  signal?: NodeJS.Signals | null | undefined;
  errorCode?: string | undefined;
  stderr?: string | undefined;
}): GitHubDispatchOutcome {
  if (options.signal) return "ambiguous_transport";
  if (options.errorCode) {
    return options.errorCode === "ETIMEDOUT" || options.errorCode === "ENOBUFS"
      ? "ambiguous_transport"
      : "definitely_not_dispatched";
  }
  if (options.status === 0) return "accepted";
  if (options.status === null) return "ambiguous_transport";
  const error = new Error(options.stderr?.trim() || `GitHub dispatch exited ${options.status}`);
  return ghRetryKind(error) === "none" ? "definitely_not_dispatched" : "ambiguous_transport";
}

export function classifyGitHubDispatchResultForTest(options: {
  status: number | null;
  signal?: NodeJS.Signals | null | undefined;
  errorCode?: string | undefined;
  stderr?: string | undefined;
}): GitHubDispatchOutcome {
  return classifyGitHubDispatchResult(options);
}

function ghRawOnceWithCheckpoint(
  args: string[],
  onBeforeRun: () => void,
): { outcome: "accepted"; output: string } {
  const env = { ...process.env };
  const command = resolveCommand("gh", args, env);
  const timeoutMs = githubCommandTimeoutMs();
  try {
    onBeforeRun();
  } catch (error) {
    throw new GitHubDispatchError("definitely_not_dispatched", error);
  }
  const result = spawnSync(command.command, command.args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (timeoutMs !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new GitHubDispatchError(
        "ambiguous_transport",
        githubRuntimeBudgetError("during GitHub dispatch"),
      );
    }
    throw new GitHubDispatchError(
      classifyGitHubDispatchResult({
        status: result.status,
        signal: result.signal,
        ...(errorCode ? { errorCode } : {}),
      }) as Exclude<GitHubDispatchOutcome, "accepted">,
      result.error,
    );
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const error = new Error(
      [`Command failed: gh ${args.join(" ")}`, stderr].filter(Boolean).join("\n"),
    );
    throw new GitHubDispatchError(
      classifyGitHubDispatchResult({
        status: result.status,
        signal: result.signal,
        stderr,
      }) as Exclude<GitHubDispatchOutcome, "accepted">,
      error,
    );
  }
  return { outcome: "accepted", output: (result.stdout ?? "").trim() };
}

function ghJson<T>(args: string[]): T {
  return parseGhJsonWithRetry<T>(() => ghWithRetry(args), args, {
    onRetry: (_error, attempt) => {
      const waitMs = ghRetryWaitMs("transient", attempt - 1);
      console.error(
        `Malformed GitHub JSON response; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      sleepBeforeGitHubRetry(waitMs);
    },
  });
}

function ghJsonOnce<T>(args: string[], timeoutMs: number): T {
  return parseGhJson<T>(ghOnce(args, timeoutMs), args);
}

function ghJsonLines<T>(args: string[]): T[] {
  return parseGhJsonLinesWithRetry<T>(() => ghWithRetry(args), args, {
    onRetry: (_error, attempt) => {
      const waitMs = ghRetryWaitMs("transient", attempt - 1);
      console.error(
        `Malformed GitHub JSON-lines response; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      sleepBeforeGitHubRetry(waitMs);
    },
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const CLAWSWEEPER_BOT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ]
    .filter((login): login is string => typeof login === "string" && login.length > 0)
    .map((login) => login.toLowerCase()),
);

const githubContext = createGitHubContext({ ghJson, ghWithRetry, targetRepo });
export const {
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  githubContextWindowPlan,
  githubLinkLastPageNumber,
  githubPaginatedPath,
} = githubContext;
const { fetchReviewedPrActivityCursor, ghPaged, githubCount } = githubContext;

const sourceRevisionTools = createSourceRevisionTools({
  asRecord,
  clawsweeperBotAuthors: CLAWSWEEPER_BOT_AUTHORS,
  githubCount,
  isClawSweeperComment: (value) => isClawSweeperComment(value),
  login,
  normalizeAuthorAssociation,
  normalizeLabelName,
  pullHeadShaFromContext: (context) => pullHeadShaFromContext(context),
  sha256,
  stringOrUndefined,
});
export const {
  isExactEventSourceRevisionChange,
  itemContentDigestForTest,
  itemSourceRevisionSha256ForTest,
  reviewCommentContentRevisionForTest,
} = sourceRevisionTools;
const {
  hydratedReviewStructuralItemStateDigest,
  isIgnorableSourceRevisionLabel,
  itemContentDigest,
  itemSnapshotHash,
  itemSourceRevisionSha256,
  pullCommitContentRevision,
  reviewCommentBodyDigest,
  reviewCommentContentRevision,
  reviewTimelineDigestParts,
} = sourceRevisionTools;

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
      // Maintainer decision 2026-07-17: the model is deliberately NOT part of
      // review-policy identity. Baking it in made every model change invalidate
      // all stored reviews (a fleet-wide re-review wave), which makes model
      // swaps untestable in production. Model changes now roll through the
      // normal review cadence instead; bump REVIEW_POLICY_VERSION explicitly
      // when a full re-review is actually wanted. The sentinel migrates all
      // hashes once, riding the 2026-07 prompt-change wave already in flight.
      model: "model-excluded-2026-07",
      reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      sandboxMode: options.sandboxMode ?? "read-only",
      // Service tier changes latency, never decisions. Pinned to the historical
      // hash value so tier changes cannot mark every stored review policy-stale
      // and trigger a fleet-wide re-review wave.
      serviceTier: "",
      targetRepo: targetRepo(),
      repositoryProfile: targetProfile(),
      prompt: reviewPromptTemplate(),
      schema: reviewDecisionSchemaText(),
    }),
  ).slice(0, 16);
}

export function reviewPolicyHashForTest(
  options: {
    model?: string;
    reasoningEffort?: string;
    sandboxMode?: string;
    serviceTier?: string;
  } = {},
): string {
  return reviewPolicyHash(options);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
const decisionParser = createDecisionParser({
  isMaintainerAuthorAssociation,
  neutralizeOwnedSectionSpoofing: (...args) => neutralizeOwnedSectionSpoofing(...args),
  sanitizeArchitectureDiagram: (...args) => sanitizeArchitectureDiagram(...args),
});
const {
  defaultRootCauseCluster,
  parseGitHubItemRef,
  parseLabelJustification,
  parseMergeRiskOption,
  parseRootCauseCluster,
  selectedReviewLabels,
} = decisionParser;

export function parseDecision(value: unknown, item?: DecisionNormalizationItem): Decision {
  return decisionParser.parseDecision(value, item);
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

function isBulkFilerExemptAuthorAssociation(value: unknown): boolean {
  return BULK_FILER_EXEMPT_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

function isBulkFilerExemptRepositoryPermission(value: unknown): boolean {
  return (
    typeof value === "string" &&
    BULK_FILER_EXEMPT_REPOSITORY_PERMISSIONS.has(value.trim().toLowerCase())
  );
}

function isMaintainerAuthored(item: Pick<Item, "authorAssociation">): boolean {
  return isMaintainerAuthorAssociation(item.authorAssociation);
}

function isVerifiedFixedCloseReason(reason: unknown): boolean {
  return reason === "implemented_on_main";
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

function applyBlockingProtectedLabels(labels: readonly string[], closeReason: unknown): string[] {
  const blocked = labels
    .map((label) => normalizeLabelName(label))
    .filter(
      (label, index, normalized) =>
        APPLY_PROTECTED_LABELS.has(label) && normalized.indexOf(label) === index,
    );
  if (!isVerifiedFixedCloseReason(closeReason)) return blocked;
  return blocked.filter((label) => label !== "maintainer");
}

function applyProtectedLabelReason(labels: readonly string[], closeReason: unknown): string {
  return `protected label: ${applyBlockingProtectedLabels(labels, closeReason).join(", ")}`;
}

export function shouldPlanItem(item: Pick<Item, "authorAssociation" | "labels">): boolean {
  return protectedLabels(item.labels).every((label) => label === "maintainer");
}

function isOlderThanDays(isoTimestamp: string, days: number, now = Date.now()): boolean {
  return isOlderThanMs(isoTimestamp, days * DAY_MS, now);
}

function isOlderThanMs(isoTimestamp: string, milliseconds: number, now = Date.now()): boolean {
  if (milliseconds <= 0) return true;
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > milliseconds;
}

function applyKindArg(value: string | boolean | string[] | undefined): ApplyKind {
  const kind = stringArg(value, "issue");
  if (kind === "issue" || kind === "pull_request" || kind === "all") return kind;
  throw new Error(`Invalid apply kind: ${kind}`);
}

export function closeReasonsArg(
  value: string | boolean | string[] | undefined,
): Set<CloseReason> | null {
  const raw = stringArg(value, "all").trim();
  if (!raw || raw === "all") return null;
  const reasons = new Set<CloseReason>();
  for (const part of raw.split(",")) {
    const reason = part.trim();
    if (!reason) continue;
    if (!ALLOWED_REASONS.has(reason as CloseReason)) {
      throw new Error(`Invalid apply close reason: ${reason}`);
    }
    reasons.add(reason as CloseReason);
  }
  return reasons.size ? reasons : null;
}

function closeReasonFilterText(filter: ReadonlySet<CloseReason> | null): string {
  return filter ? [...filter].sort().join(",") : "all";
}

function closeReasonEnabled(
  closeReason: CloseReason,
  filter: ReadonlySet<CloseReason> | null,
): boolean {
  return filter === null || filter.has(closeReason);
}

export function closeReasonApplyAgeSkipReason(
  item: Pick<Item, "createdAt">,
  closeReason: CloseReason,
  options: {
    minAgeMs: number;
    minAgeDescription: string;
    staleMinAgeDays: number;
    now?: number;
  },
): string | null {
  const now = options.now ?? Date.now();
  if (
    (closeReason === "stale_insufficient_info" || closeReason === "mostly_implemented_on_main") &&
    !isOlderThanDays(item.createdAt, options.staleMinAgeDays, now)
  ) {
    return `${closeReason} requires item older than ${options.staleMinAgeDays} days`;
  }
  if (!isOlderThanMs(item.createdAt, options.minAgeMs, now)) {
    return `created less than or equal to ${options.minAgeDescription} ago`;
  }
  return null;
}

export function unconfirmedProductDirectionAgeSkipReason(
  item: Pick<Item, "createdAt">,
  reviewedUpdatedAt: string | undefined,
  reviewedAt: string | undefined,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS, now)) {
    return `unconfirmed_product_direction requires PR older than ${UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS} days`;
  }
  const sourceUpdatedAtMs = Date.parse(reviewedUpdatedAt ?? "");
  const reviewedAtMs = Date.parse(reviewedAt ?? "");
  if (
    !Number.isFinite(sourceUpdatedAtMs) ||
    !Number.isFinite(reviewedAtMs) ||
    reviewedAtMs - sourceUpdatedAtMs <= UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS * DAY_MS
  ) {
    return `unconfirmed_product_direction requires ${UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS} days without source activity before review`;
  }
  return null;
}

export function unsponsoredFeatureAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, UNSPONSORED_FEATURE_MIN_AGE_DAYS, now)) {
    return `unsponsored_feature_request requires issue older than ${UNSPONSORED_FEATURE_MIN_AGE_DAYS} days`;
  }
  return null;
}

export function authorPrBudgetAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, AUTHOR_PR_BUDGET_MIN_AGE_DAYS, now)) {
    return `author_pr_budget_exceeded requires PR older than ${AUTHOR_PR_BUDGET_MIN_AGE_DAYS} days`;
  }
  return null;
}

export function staleVersionBugAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, STALE_VERSION_BUG_MIN_AGE_DAYS, now)) {
    return `stale_version_bug requires issue older than ${STALE_VERSION_BUG_MIN_AGE_DAYS} days`;
  }
  return null;
}

export function obsoleteFixPrAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, OBSOLETE_FIX_PR_MIN_AGE_DAYS, now)) {
    return `obsolete_fix_pr requires PR older than ${OBSOLETE_FIX_PR_MIN_AGE_DAYS} days`;
  }
  return null;
}

const recordMetadata = createRecordMetadata({
  reportFileName,
  markdownRepository,
  isVerifiedFixedCloseReason,
  isOlderThanDays,
  timestampMs: (timestamp) => timestampMs(timestamp),
  pullHeadShaFromReport: (markdown) => pullHeadShaFromReport(markdown),
  reviewLeaseRevisionFromReport: (markdown) => reviewLeaseRevisionFromReport(markdown),
  lockedConversationApplyReason: (item) => lockedConversationApplyReason(item),
  markdownFiles,
  numberForMarkdownFile,
});
export const {
  applyDecisionPriority,
  exactEventReviewLeaseDispositionForTest,
  failedReviewRetryEligibilityForTest,
  isInfrastructureFailedReviewForTest,
  reviewReportCanPromoteToCloseForTest,
  shouldSyncReviewComment,
} = recordMetadata;
const {
  appendSectionValue,
  applyQueueSortFields,
  buildExistingReviewIndex,
  effectiveReviewStatus,
  exactEventReviewLeaseDisposition,
  existingReview,
  failedReviewFailureDetail,
  failedReviewRetryEligibility,
  failedReviewRetryResultRevision,
  failedReviewRetryRevisionForReport,
  frontMatterBoolean,
  frontMatterJsonArray,
  frontMatterStringArray,
  frontMatterValue,
  hasAutoCloseAllowedMetadata,
  hasVerifiedLocalCheckoutAccess,
  indexedExistingReview,
  isApplyCloseCandidateReport,
  isFailedReviewRetryAlreadyExhausted,
  isLiveRecheckCloseGuardReport,
  isPairBlockedCloseReport,
  isRetryableCloseSkipReport,
  isRetryableKeptOpenCloseReport,
  isRetryablePrCloseCoverageProofReport,
  replaceFrontMatterValue,
  replaceSectionValue,
  reportCloseReason,
  reportItemKind,
  reviewReportCanPromoteToClose,
  reviewSectionValue,
  sameFailedReviewRetryRevision,
  sectionValue,
  shouldProbeClosedStateReport,
  storedFailedReviewRetryRevision,
} = recordMetadata;

const reportParser = createReportParser({
  agentsPolicyStatusLine: (...args) => agentsPolicyStatusLine(...args),
  defaultRootCauseCluster,
  evidenceEntry,
  frontMatterJsonArray,
  frontMatterStringArray,
  frontMatterValue,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  markdownRepository,
  parseBoldListHeading: (...args) => parseBoldListHeading(...args),
  parseLabelJustification,
  parseMergeRiskOption,
  parseReviewFindingHeading: (...args) => parseReviewFindingHeading(...args),
  parseRootCauseCluster,
  parseSecurityConcernHeading: (...args) => parseSecurityConcernHeading(...args),
  reviewSectionValue,
  sectionLineValue: (...args) => sectionLineValue(...args),
  sectionList: (...args) => sectionList(...args),
  selectedReviewLabels,
  splitFileAndLine,
});
export const { rootCauseClusterFromReportForTest } = reportParser;
const {
  reportEvidence,
  reportLikelyOwners,
  reportOverallCorrectness,
  reportOverallConfidenceScore,
  triagePriorityFromReport,
  impactLabelsFromReport,
  mergeRiskLabelsFromReport,
  maturityLabelsFromReport,
  mergeRiskOptionsFromReport,
  labelJustificationsFromReport,
  reportReviewFindings,
  reportSecurityReview,
  reportRealBehaviorProof,
  reportTelegramVisibleProof,
  reportPrRating,
  reportMantisRecommendation,
  reportFeatureShowcase,
  reportRootCauseCluster,
  reportAgentsPolicyStatus,
  defaultAgentsPolicyStatus,
  reportVisionFit,
} = reportParser;

const labelPolicy = createLabelPolicy({
  asRecord,
  frontMatterValue,
  isAutomationReportAuthor,
  mergeRiskOptionsFromReport,
  reportOverallCorrectness,
  reportRealBehaviorProof,
  reportReviewFindings,
  reportSecurityReview,
  stringOrUndefined,
  timestampMs: (value) => timestampMs(value),
});
export const { featureShowcaseLabelsForTest, prStatusLabelsForTest, prStatusLabelSchemeForTest } =
  labelPolicy;
const {
  eventTimestampMs,
  hasRepairLoopPauseLabel,
  isAfterReview,
  nextFeatureShowcaseLabels,
  nextPrStatusLabels,
  prStatusLabelForKind,
  prStatusLabelKindFromReport,
  shouldApplyFeatureShowcaseLabel,
} = labelPolicy;

const applyGuards = createApplyGuards({
  asRecord,
  authorPrBudget: () => authorPrBudget(),
  authorPrBudgetAgeSkipReason,
  authorPrBudgetCloseEnabled: () => authorPrBudgetCloseEnabled(),
  ghJson,
  ghPaged,
  isMaintainerAuthorAssociation,
  isMaintainerAuthored,
  isOlderThanDays,
  labelNames,
  login,
  normalizeLabelName,
  obsoleteFixPrAgeSkipReason,
  obsoleteFixPrCloseEnabled: () => obsoleteFixPrCloseEnabled(),
  protectedLabels,
  quoteGitHubSearchTerm: (term) => quoteGitHubSearchTerm(term),
  reportPrRating,
  reportRealBehaviorProof,
  staleVersionBugAgeSkipReason,
  staleVersionBugCloseEnabled: () => staleVersionBugCloseEnabled(),
  stringOrUndefined,
  targetRepo,
  unconfirmedProductDirectionAgeSkipReason,
  unconfirmedProductDirectionCloseEnabled: () => unconfirmedProductDirectionCloseEnabled(),
  unsponsoredFeatureAgeSkipReason,
  unsponsoredFeatureCloseEnabled: () => unsponsoredFeatureCloseEnabled(),
});
export const {
  abandonedPrAgeSkipReason,
  issueRecentHumanCommentBlockReasonFromComments,
  stalledUnprovenPrAgeSkipReason,
  stalledUnprovenProofRequestBlockReason,
} = applyGuards;
const {
  abandonedPrApplyBlockReasonSafe,
  authorPrBudgetApplyGateSafe,
  authorPrBudgetSignalBlockReason,
  issueRecentHumanCommentBlockReasonSafe,
  lowSignalUnmergeablePrApplyBlockReasonSafe,
  lowSignalUnmergeablePrAuthorActivityBlockReason,
  lowSignalUnmergeablePrConflictBlockReason,
  obsoleteFixPrApplyBlockReasonSafe,
  prAutoCloseExemptDecisionReason,
  prAutoCloseExemptLabel,
  pullRequestHeadActivity,
  staleVersionBugApplyBlockReasonSafe,
  stalledUnprovenPrApplyBlockReasonSafe,
  unconfirmedProductDirectionApplyBlockReasonSafe,
  unsponsoredFeatureApplyBlockReasonSafe,
} = applyGuards;

const contextHydration = createContextHydration({
  asRecord,
  CLAWSWEEPER_BOT_AUTHORS,
  defaultClosedDir,
  defaultItemsDir,
  displayTitle: (title) => displayTitle(title),
  effectiveReviewStatus,
  fetchIssueReviewComments: (number) => fetchIssueReviewComments(number),
  frontMatterValue,
  ghJson,
  ghJsonOnce,
  githubCount,
  GitHubRuntimeBudgetError,
  isAutomationReportAuthor,
  isBulkFilerExemptAuthorAssociation,
  isMarkdownForActiveRepo,
  isSafeGitBranchName: (branch) => isSafeGitBranchName(branch),
  labelNames,
  login,
  markdownFiles,
  normalizeAuthorAssociation,
  normalizeLabelName,
  numberForMarkdownFile,
  replaceFrontMatterValue,
  repoRelativePath,
  reportUrl,
  reviewCommentBodyDigest,
  reviewSectionValue,
  ROOT,
  run,
  stringOrUndefined,
  targetRepo,
});
export const {
  authorPrBudget,
  authorPrBudgetCloseEnabled,
  authorPrBudgetMaxClosesPerRun,
  bulkFilerPolicyInvalidatesCachedReviewForTest,
  bulkFilerThreshold,
  bulkFilerWindowDays,
  closingPullRequestReferenceTarget,
  compactMappedSlice,
  compactMappedWindow,
  compactPullRequestForTest,
  compactReferencingMergedPullRequestForTest,
  detectBulkFilerForTest,
  extractLatestClawSweeperReviewForTest,
  extractLatestClawSweeperReviewFromHydrationForTest,
  filterReviewContextCommentsForTest,
  goodFirstIssueLabelOptedOutForTest,
  obsoleteFixPrCloseEnabled,
  openClosingPullRequestApplyReason,
  previousClawSweeperReviewDigestFromReportForTest,
  referencingMergedPullRequestCandidatesForTest,
  referencingMergedPullRequestsForIssueForTest,
  relatedGitHubIssueSearchQueryForTest,
  relatedTitleSearchTerms,
  sameAuthorCounterpartApplyReason,
  staleVersionBugCloseEnabled,
  unconfirmedProductDirectionCloseEnabled,
  unsponsoredFeatureCloseEnabled,
  updateBulkFilerDetectedFrontMatterForTest,
} = contextHydration;
const {
  authorIssueCountInBulkFilerWindow,
  bulkFilerPolicyInvalidatesCachedReview,
  bulkFilerRepositoryPermission,
  closingPullRequestsForIssue,
  compactComment,
  compactIssue,
  compactPullCommit,
  compactPullFile,
  compactPullFilePaths,
  compactPullRequest,
  compactSemanticPullFile,
  compactTimelineEvent,
  completePullChecksContext,
  detectBulkFiler,
  extractLatestClawSweeperReview,
  extractLatestClawSweeperReviewFromHydration,
  filterReviewContextComments,
  goodFirstIssueHumanLabelState,
  isClawSweeperComment,
  isDigitsOnly,
  liveClawSweeperReviewDigest,
  pairCloseKey,
  previousClawSweeperReviewDigestFromReport,
  pullChecksContext,
  pullFileTreeIdentity,
  quoteGitHubSearchTerm,
  referencingMergedPullRequestsForIssue,
  refreshRelatedItemsContext,
  relatedItemsContext,
  semanticPullFilesWithTreeIdentity,
  structuralExternalRelationSensitivity,
  updateBulkFilerDetectedFrontMatter,
} = contextHydration;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

const reviewPlanning = createReviewPlanning({
  maxPlanShardCount: MAX_PLAN_SHARD_COUNT,
  targetRepo,
  ghJson,
  ghJsonLines,
  fetchReviewedPrActivityCursor,
  ghPaged,
  githubCount,
  itemSourceRevisionSha256,
  asRecord,
  normalizeAuthorAssociation,
  shouldPlanItem,
  frontMatterValue,
  buildExistingReviewIndex,
  indexedExistingReview,
  effectiveReviewStatus,
  stringOrUndefined,
  pullHeadShaFromReport: (markdown) => pullHeadShaFromReport(markdown),
  failedReviewRetryStatePath: (stateDir, number) => failedReviewRetryStatePath(stateDir, number),
  readFailedReviewRetryState: (statePath) => readFailedReviewRetryState(statePath),
  failedReviewRetryMarkdownWithState: (markdown, state) =>
    failedReviewRetryMarkdownWithState(markdown, state),
  repoRelativePath,
  dashboardClosedAt: (markdown) => dashboardClosedAt(markdown),
});
export const {
  dashboardFailedReviewRetryActivityForTest,
  shardItemNumbers,
  shouldSkipScheduledHotIntakeExactReviewForTest,
} = reviewPlanning;
const {
  addDashboardCadenceBucket,
  capDashboardCadenceBucket,
  dashboardMarkdownWithFailedReviewRetryState,
  emptyDashboardActivityStats,
  emptyDashboardCadenceBucket,
  emptyDashboardKindStats,
  exactLocalReviewNoCandidateError,
  fetchItem,
  fetchOpenItemCounts,
  fetchOpenItemNumbers,
  fetchOpenItems,
  formatActivityRow,
  formatCadenceBucket,
  formatOperationActivityRow,
  formatPercent,
  isCurrentForCadence,
  isFresh,
  latestTimestamp,
  planCandidates,
  recordDashboardActivity,
  selectCandidates,
  timestampMs,
} = reviewPlanning;

function fetchReviewStructuralRecord(options: {
  item: Item;
  git: GitInfo;
  reviewPolicy: string;
  reviewModel: string;
}): ReviewStructuralRecord | null {
  if (!options.git.releaseStateComplete) return null;
  const [owner, name] = options.item.repo.split("/");
  if (!owner || !name) return null;
  const externalRelationSensitive = structuralExternalRelationSensitivity(options.item);
  if (externalRelationSensitive === null) {
    throw new Error(`structural relation probe failed for #${options.item.number}`);
  }
  const response = ghJson<unknown>([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${options.item.number}`,
    "-f",
    `query=${reviewStructuralQuery(options.item.kind)}`,
  ]);
  let pullChecksDigest: string | null = null;
  if (options.item.kind === "pull_request") {
    const pull = asRecord(asRecord(asRecord(response).data).repository).pullRequest;
    const headSha = stringOrUndefined(asRecord(pull).headRefOid)?.trim().toLowerCase();
    if (!headSha) return null;
    const pullChecks = pullChecksContext(options.item.number, headSha);
    if (!completePullChecksContext(pullChecks)) return null;
    pullChecksDigest = sha256(stableJson(reviewPullChecksDigestParts(pullChecks)));
  }
  return reviewStructuralRecordFromGraphql({
    response,
    repo: options.item.repo,
    number: options.item.number,
    kind: options.item.kind,
    targetHeadSha: options.git.mainSha.trim().toLowerCase(),
    latestReleaseTag: options.git.latestRelease?.tagName ?? null,
    latestReleaseSha: options.git.latestRelease?.sha?.trim().toLowerCase() ?? null,
    pullChecksDigest,
    reviewPolicy: options.reviewPolicy,
    reviewModel: options.reviewModel,
    ignoreAuthor: (author) => CLAWSWEEPER_BOT_AUTHORS.has(author.toLowerCase()),
    ignoreLabel: (label) => isIgnorableSourceRevisionLabel(normalizeLabelName(label)),
    externalRelationSensitive,
  });
}

const { collectItemContext } = createItemContext({
  asRecord,
  closingPullRequestsForIssue,
  compactComment,
  compactIssue,
  compactMappedSlice,
  compactMappedWindow,
  compactPullCommit,
  compactPullFile,
  compactPullRequest,
  compactSemanticPullFile,
  compactTimelineEvent,
  extractLatestClawSweeperReviewFromHydration,
  fetchReviewedPrActivityCursor,
  filterReviewContextComments,
  ghJson,
  ghPaged,
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  goodFirstIssueHumanLabelState,
  hydratedReviewStructuralItemStateDigest,
  itemSourceRevisionSha256,
  pullChecksContext,
  pullCommitContentRevision,
  referencingMergedPullRequestsForIssue,
  relatedItemsContext,
  reviewCommentContentRevision,
  reviewTimelineDigestParts,
  semanticPullFilesWithTreeIdentity,
  sha256,
  stringOrUndefined,
  targetRepo,
});

const reviewRuntime = createReviewRuntime({
  reviewItemPromptPath: REVIEW_ITEM_PROMPT_PATH,
  decisionSchemaPath: CLAWSWEEPER_DECISION_SCHEMA_PATH,
  maturityStableShortlistScriptPath: MATURITY_STABLE_SHORTLIST_SCRIPT_PATH,
  prCloseCoverageProofPromptPath: PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
  targetRepo,
  evidenceEntry,
  run,
  sleepMs,
  untrustedCodexEnv,
  ghJson,
  asRecord,
  defaultRootCauseCluster,
  parseDecision,
  ensureDir,
  stringOrUndefined,
});
export const {
  combinedCodexReviewRetryableForTest,
  codexFailureDecisionForTest,
  codexFailureLogKindForTest,
  codexReviewFailureRetryableForTest,
  defaultReviewArtifactDirForTest,
  makeTreeReadOnlyForTest,
  prepareManagedLocalReviewCheckoutForTest,
  restoreTreeModesForTest,
  reviewCodexForcedLoginMethodForTest,
  reviewDecisionSchemaText,
  reviewPromptForTest,
  reviewPromptTelemetryForTest,
  reviewPromptTemplate,
  runCodexForTest,
} = reviewRuntime;
const {
  CodexReviewError,
  buildReviewPrompt,
  codexFailureDecision,
  codexFailureLogKind,
  codexFailureReason,
  codexReviewFailureRetryable,
  defaultLocalRangeArtifactDir,
  defaultReviewArtifactDir,
  displayDurationMs,
  displayPath,
  gitInfo,
  isSafeGitBranchName,
  localExactReviewItem,
  makeTreeReadOnly,
  prCloseCoverageProofPromptTemplate,
  resolveReviewCheckout,
  restoreTreeModes,
  reviewCodexForcedLoginMethod,
  runCodex,
} = reviewRuntime;

const assistWorkflow = createAssistWorkflow({
  root: ROOT,
  asRecord,
  canPatchReviewComment: (comment) => canPatchReviewComment(comment),
  collectItemContext,
  ensureDir,
  fetchItem,
  ghJson,
  ghPaged,
  ghWithRetry,
  repoFromArgs,
  sha256,
  targetRepo,
  untrustedCodexEnv,
  writeCommentPayload: (number, body) => writeCommentPayload(number, body),
});
export const {
  assistIssueUrlMatchesForTest,
  assistPromptContextForTest,
  stripEmptyMaintainerRulingFieldsForTest,
} = assistWorkflow;
const {
  assistGenerateCommand,
  assistPublishCommand,
  assistResolveTargetCommand,
  assistValidateArtifactCommand,
} = assistWorkflow;

const statusContext = createStatusContext({
  targetProfile,
  targetRepo,
  markdownLink,
  repoUrlFor,
  linkedRelease,
  linkedSha,
  profileStatusStart,
  profileStatusEnd,
  sweepStatusPath,
  markdownRepository,
  ghJson,
  asRecord,
  frontMatterValue,
  stringOrUndefined,
  numberOrUndefined,
  recordOrUndefined,
});
export const { fixedPullRequestFromCommitPullsForTest } = statusContext;
const {
  attachFixedPullRequest,
  currentWorkflowStatusBlock,
  displayTitle,
  fixedInReportText,
  fixedInText,
  fixedPullRequestFromReport,
  formatReviewFreshnessTimestamp,
  formatStatusNumber,
  formatTimestamp,
  readSweepStatusSummary,
  workflowStatusSummary,
} = statusContext;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const reviewPresentation = createReviewPresentation({
  docsPageUrl,
  fileUrl,
  frontMatterStringArray,
  frontMatterValue,
  hasDispatchableMantisScenario,
  hasRepairLoopPauseLabel,
  isCommitSha,
  latestFileUrl,
  linkedSha,
  markdownLink,
  publicTableCell: (...args) => publicTableCell(...args),
  reportEvidence,
  securityConcernLocation,
  splitFileAndLine,
});
const {
  closeEvidenceLine,
  confidenceText,
  isActionablePriorityText,
  isReportNoneList,
  isRoutineCiOrReviewText,
  isSupportedMantisScenario,
  likelyOwnerLine,
  normalizePublicReviewText,
  prStatusLabelKindFromReportLabels,
  priorityLabel,
  publicFailedReviewReadinessBlock,
  publicLikelyOwnerRole,
  publicMantisRecommendationBlock,
  publicMergeReadinessBlock,
  publicNonDispatchableMantisRecommendationBlock,
  publicPriorityBulletFromText,
  publicPriorityBulletIfActionable,
  publicPriorityFromText,
  publicRankDetailsBlock,
  publicRealBehaviorProofLine,
  publicReviewScoresBlock,
  publicReviewTextDiffers,
  publicReviewTextIsSame,
  publicRiskBulletsFromText,
  publicSecurityReviewLine,
  publicVerificationBlock,
  reviewFindingDetailedLine,
  reviewFindingLocation,
  reviewFindingSummaryLine,
  securityConcernDetailedLine,
  securityConcernSummaryLine,
  securityReviewLine,
  sentence,
  stripPriorityPrefix,
  validMantisMaintainerComment,
} = reviewPresentation;

const reportOrchestration = createReportOrchestration({
  agentsPolicyStatusLine: (...args) => agentsPolicyStatusLine(...args),
  asRecord,
  closeEvidenceLine,
  collectItemContext,
  compactPullFilePaths,
  confidenceText,
  defaultAgentsPolicyStatus,
  defaultPlansDir,
  defaultRootCauseCluster,
  effectiveReviewStatus,
  ensureDir,
  eventTimestampMs,
  fileUrl,
  filterReviewContextComments,
  fixedInReportText,
  fixedInText,
  fixedPullRequestFromReport,
  formatReviewFreshnessTimestamp,
  formatTimestamp,
  frontMatterBoolean,
  frontMatterJsonArray,
  frontMatterStringArray,
  frontMatterValue,
  ghJson,
  ghObservedMutationCommand,
  ghPaged,
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  GitHubRuntimeBudgetError,
  hasUsableCloseComment: (...args) => hasUsableCloseComment(...args),
  impactLabelsFromReport,
  isActionablePriorityText,
  isAfterReview,
  isAutomationReportAuthor,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  isDigitsOnly,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  isFresh,
  isImplementationCloseReason: (...args) => isImplementationCloseReason(...args),
  isIssueAdvisoryLabel: (...args) => isIssueAdvisoryLabel(...args),
  isMaintainerAuthored,
  isOlderThanDays,
  isReportNoneList,
  isRoutineCiOrReviewText,
  issueAdvisoryLabelStateFromReport: (...args) => issueAdvisoryLabelStateFromReport(...args),
  isVerifiedFixedCloseReason,
  itemSnapshotHash,
  jsonFrontMatterValue: (...args) => jsonFrontMatterValue(...args),
  labelJustificationsFromReport,
  labelNames,
  labelPolicy,
  likelyOwnerLine,
  linkedRelease,
  linkedSha,
  lowSignalUnmergeablePrAuthorActivityBlockReason,
  lowSignalUnmergeablePrConflictBlockReason,
  markdownLink,
  markdownRepository,
  maturityLabelsFromReport,
  mergeRiskLabelsFromReport,
  mergeRiskOptionsFromReport,
  neutralizeOwnedSectionSpoofing: (...args) => neutralizeOwnedSectionSpoofing(...args),
  nextFeatureShowcaseLabels,
  nextImpactLabels: (...args) => nextImpactLabels(...args),
  nextIssueAdvisoryLabels: (...args) => nextIssueAdvisoryLabels(...args),
  nextMaturityLabels: (...args) => nextMaturityLabels(...args),
  nextMergeRiskLabels: (...args) => nextMergeRiskLabels(...args),
  nextPriorityLabels: (...args) => nextPriorityLabels(...args),
  nextPrStatusLabels,
  nextRealBehaviorProofMediaLabels: (...args) => nextRealBehaviorProofMediaLabels(...args),
  nextRealBehaviorProofSufficientLabels: (...args) =>
    nextRealBehaviorProofSufficientLabels(...args),
  nextTelegramVisibleProofLabels: (...args) => nextTelegramVisibleProofLabels(...args),
  normalizeLabelName,
  normalizePublicReviewText,
  numberOrUndefined,
  parseGitHubItemRef,
  priorityLabel,
  protectedLabels,
  prStatusLabelForKind,
  prStatusLabelKindFromReportLabels,
  publicFailedReviewReadinessBlock,
  publicLikelyOwnerRole,
  publicMantisRecommendationBlock,
  publicMergeReadinessBlock,
  publicNonDispatchableMantisRecommendationBlock,
  publicPriorityBulletFromText,
  publicPriorityBulletIfActionable,
  publicPriorityFromText,
  publicRankDetailsBlock,
  publicRealBehaviorProofLine,
  publicReviewScoresBlock,
  publicReviewTextDiffers,
  publicReviewTextIsSame,
  publicRiskBulletsFromText,
  publicSecurityReviewLine,
  publicTableCell: (...args) => publicTableCell(...args),
  publicVerificationBlock,
  pullHeadShaFromContext: (...args) => pullHeadShaFromContext(...args),
  pullHeadShaFromReport: (...args) => pullHeadShaFromReport(...args),
  pullRequestHeadActivity,
  repairLoopPassModeFromReport: (...args) => repairLoopPassModeFromReport(...args),
  replaceFrontMatterValue,
  replaceSectionValue,
  repoRelativePath,
  reportAgentsPolicyStatus,
  reportEvidence,
  reportFeatureShowcase,
  reportFileName,
  reportLikelyOwners,
  reportMantisRecommendation,
  reportOverallConfidenceScore,
  reportOverallCorrectness,
  reportPrRating,
  reportRealBehaviorProof,
  reportReviewFindings,
  reportRootCauseCluster,
  reportSecurityReview,
  reportTelegramVisibleProof,
  reportVisionFit,
  repoUrlFor,
  reviewAutomationMarkersFromReport: (...args) => reviewAutomationMarkersFromReport(...args),
  reviewFindingDetailedLine,
  reviewFindingLocation,
  reviewFindingSummaryLine,
  reviewReportCanPromoteToClose,
  reviewSectionValue,
  reviewStructuralPullStateFromContext: (...args) => reviewStructuralPullStateFromContext(...args),
  reviewVersionMarkerFromReport: (...args) => reviewVersionMarkerFromReport(...args),
  ROOT,
  runtimeBudgetExceeded: (...args) => runtimeBudgetExceeded(...args),
  sanitizeArchitectureDiagram: (...args) => sanitizeArchitectureDiagram(...args),
  sectionLineValue: (...args) => sectionLineValue(...args),
  sectionValue,
  securityConcernDetailedLine,
  securityConcernLocation,
  securityConcernSummaryLine,
  securityReviewLine,
  sentence,
  sha256,
  shouldApplyFeatureShowcaseLabel,
  splitFileAndLine,
  stringOrUndefined,
  stripPriorityPrefix,
  targetProfile,
  targetRepo,
  timeoutWithinRuntimeBudget: (...args) => timeoutWithinRuntimeBudget(...args),
  timestampMs,
  triagePriorityFromReport,
  validateCloseDecision: (...args) => validateCloseDecision(...args),
  workStatusForDecision: (...args) => workStatusForDecision(...args),
});
export const {
  contextHasNonAutomationActivityAfterForTest,
  impactLabelSchemeForTest,
  impactLabelsForTest,
  isGitHubLabelAlreadyExistsErrorForTest,
  isGitHubLabelCapacityErrorForTest,
  isMissingGitHubLabelErrorForTest,
  issueAdvisoryLabelsForTest,
  labelJustificationsMarkdownForTest,
  maturityLabelSchemeForTest,
  maturityLabelsForTest,
  mergeRiskLabelSchemeForTest,
  mergeRiskLabelsForTest,
  prRatingLabelSchemeForTest,
  prRatingLabelsForTest,
  priorityLabelSchemeForTest,
  priorityLabelsForTest,
  pullRequestFilePathsFromContextForTest,
  realBehaviorProofMediaLabelsForTest,
  realBehaviorProofSufficientLabelsForTest,
  renderReviewCommentFromReport,
  renderReviewContextBudgetForTest,
  renderWorkPlanFromReport,
  reviewActionForDecision,
  reviewContextLedgerForTest,
  sanitizePublicSelfReferences,
  syncBulkFilerLabelForTest,
  telegramVisibleProofLabelsForTest,
} = reportOrchestration;
const {
  OWNED_REVIEW_SECTION_HEADINGS,
  applyAuthorPrBudgetStateToReport,
  applyClosedUnmergedCanonicalBlockedReport,
  applyPrCloseCoverageProofBlockedReport,
  applyPrCloseCoverageProofReportSection,
  authorPrBudgetPromotion,
  canonicalPullRequestCommentSyncBlock,
  closeItem,
  completeStaleCanonicalCommentSyncReport,
  configSurfaceReviewRequired,
  contextHasNonAutomationActivityAfter,
  coveringPrCloseCoveragePullRequestUpdatedAt,
  currentReviewRevision,
  dataModelSurfaceReviewRequired,
  duplicateCanonicalPullRequestBlockReason,
  hasNormalizedLabel,
  isClawSweeperOwnedLabel,
  labelSynchronization,
  linkedPullRequestRefsFromText,
  linkedPullRequestSignalContextsFromText,
  livePullRequestHasNoDiff,
  markdownFor,
  normalizedLabelSet,
  parseBacktickLocation,
  prCloseCoverageProofGateResult,
  pullRequestClosePromotion,
  pullRequestFilePathsFromReport,
  pullRequestHeadSha,
  realBehaviorProofBlocksMerge,
  reportDecision,
  reviewHistoryForStaleComment,
  staleCanonicalCommentSyncPendingReason,
  staleCanonicalPullRequestNumber,
  syncWorkPlanFromReport,
  updateReviewSemanticFrontMatter,
  updateReviewStructuralFrontMatter,
  upgradeNoDiffPullRequestReport,
  upgradePullRequestClosePromotionReport,
  workPlanPathForReport,
} = reportOrchestration;

function isDocsOnlyPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  if (frontMatterBoolean(markdown, "pull_files_truncated")) return false;
  const files = pullRequestFilePathsFromReport(markdown);
  return files.length > 0 && files.every(isDocsPath);
}

const {
  addIssueLabel,
  ensureIdeaArchiveLabel,
  isGoodFirstIssue,
  isIssueAdvisoryLabel,
  issueAdvisoryLabelStateFromReport,
  labelAlreadyExistsError,
  nextImpactLabels,
  nextIssueAdvisoryLabels,
  nextMaturityLabels,
  nextMergeRiskLabels,
  nextPriorityLabels,
  nextRealBehaviorProofMediaLabels,
  nextRealBehaviorProofSufficientLabels,
  nextTelegramVisibleProofLabels,
  removeIssueLabel,
  syncBulkFilerLabel,
  syncFeatureShowcaseLabel,
  syncImpactLabels,
  syncIssueAdvisoryLabels,
  syncMaturityLabels,
  syncMergeRiskLabels,
  syncPriorityLabel,
  syncPrRatingLabel,
  syncPrStatusLabel,
  syncRealBehaviorProofMediaLabels,
  syncRealBehaviorProofSufficientLabel,
  syncTelegramVisibleProofLabel,
} = labelSynchronization;

function isAutomationReportAuthor(author: string | undefined): boolean {
  return Boolean(author && (/\[bot\]$/i.test(author) || author.startsWith("app/")));
}

function isExternalPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  const authorAssociation = frontMatterValue(markdown, "author_association");
  if (!authorAssociation) return false;
  if (isMaintainerAuthorAssociation(authorAssociation)) return false;
  return !isAutomationReportAuthor(frontMatterValue(markdown, "author"));
}

function hasDispatchableMantisScenario(recommendation: MantisRecommendation): boolean {
  return (
    recommendation.status === "recommended" &&
    isSupportedMantisScenario(recommendation.scenario) &&
    Boolean(validMantisMaintainerComment(recommendation))
  );
}

const reportHelpers = createReportHelpers({
  OWNED_REVIEW_SECTION_HEADINGS,
  parseBacktickLocation,
});
const {
  agentsPolicyStatusLine,
  neutralizeOwnedSectionSpoofing,
  parseBoldListHeading,
  parseReviewFindingHeading,
  parseSecurityConcernHeading,
  publicTableCell,
  sanitizeArchitectureDiagram,
  sectionLineValue,
  sectionList,
} = reportHelpers;

// A routine phrase inside a larger actionable or negated sentence ("Do not merge
// after required checks are green; rotate the token first") must not suppress the
// step, so require the routine phrase, reject negation, and re-check actionability.

// Checklist entries are list items, not table cells; only flatten newlines so
// downstream consumers of the checklist see command/path text unaltered.

// Labels are wrapped in renderer-owned bold markers, so Markdown delimiters inside
// report-provided titles must be escaped or they would break the bold span and the
// downstream label-stripping parsers.

// Model-generated text is rendered above renderer-owned sections such as
// "## Before merge", and downstream routing extracts those sections from the first
// matching Markdown heading. Escape heading-shaped lines in model text so injected
// content can never spoof a renderer-owned section boundary.

// The review prompt and schema require Mermaid flowchart source with no code fences,
// click directives, URLs, HTML, or initialization/styling directives. The diagram is
// model output that crosses into a trusted bot comment, so enforce that allowlist
// here and drop the diagram entirely when it does not comply.

const closeDecisionWorkflow = createCloseDecisionWorkflow({
  targetRepo,
  isMaintainerAuthorAssociation,
  normalizeLabelName,
  applyBlockingProtectedLabels,
  applyProtectedLabelReason,
  prAutoCloseExemptLabel,
  prAutoCloseExemptDecisionReason,
});
export const {
  staleVersionBugDecisionBlockReason,
  unsponsoredFeatureDecisionBlockReason,
  validateCloseDecision,
} = closeDecisionWorkflow;
const { hasUsableCloseComment, isImplementationCloseReason } = closeDecisionWorkflow;

const reviewCommentWorkflow = createReviewCommentWorkflow({
  root: ROOT,
  targetRepo,
  heldReviewStartStatusCommentResult,
  gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
  ghObservedMutationCommand,
  sha256,
  githubCount,
  ghPaged,
  reviewCommentBodyDigest,
  asRecord,
  parseGitHubItemRef,
  reportSecurityReview,
  reportReviewFindings,
  reportOverallCorrectness,
  ensureDir,
  frontMatterValue,
  replaceFrontMatterValue,
  sectionValue,
  frontMatterStringArray,
  timestampMs,
  stringOrUndefined,
  sentence,
  configSurfaceReviewRequired,
  dataModelSurfaceReviewRequired,
  isIssueAdvisoryLabel,
  removeIssueLabel,
  realBehaviorProofBlocksMerge,
  normalizedLabelSet,
  sectionLineValue,
  linkedPullRequestRefsFromText,
  linkedPullRequestSignalContextsFromText,
  isClawSweeperOwnedLabel,
  reviewHistoryForStaleComment,
  currentReviewRevision,
  pullRequestHeadSha,
  markdownLink,
});
export const {
  canPatchReviewComment,
  coverageProofRetryExhaustedRuntimeBudget,
  isCodexReviewCommentBody,
  lockedConversationApplyReason,
  newReviewStartLeaseOwnerForTest,
  recordedLabelSyncCoversUpdate,
  removeCurrentCursorTraceItem,
  renderReviewStartStatusComment,
  reviewArtifactDestination,
  reviewAutomationMarkersFromReport,
  reviewStartLeaseWinnerCommentIdForTest,
  runtimeBudgetExceeded,
  shouldPreserveReviewStartLease,
  supersededReviewPlaceholderCommentIds,
  timeoutWithinRuntimeBudget,
  withReviewStartStatusLease,
} = reviewCommentWorkflow;
const {
  commentId,
  pullHeadShaFromContext,
  fetchIssueReviewComments,
  reviewLeaseRevisionFromReport,
  pullHeadShaFromReport,
  writeCommentPayload,
  repairLoopPassModeFromReport,
  reviewVersionMarkerFromReport,
  reviewStructuralPullStateFromContext,
  exactReviewQueueAuthorityFromEnv,
  postReviewStartStatusComment,
  deleteOwnedDedicatedReviewStartLease,
  freshDedicatedReviewStartLeases,
  issueReviewCommentState,
  PATCHABLE_REVIEW_COMMENT_AUTHORS,
  staleReviewCommentSyncReason,
  reviewCommentHasCloseVerdictForCanonical,
  issueReviewComment,
  markedReviewCommentBody,
  commentBodyMatches,
  reviewCommentHashMatches,
  commentUpdatedAt,
  cleanupSupersededReviewPlaceholderComments,
  reviewStartLeaseOwner,
  commentBody,
  freshPullRequestReviewHead,
  stalePullRequestReviewHead,
  syncStalePullRequestReviewLabels,
  stalePullRequestReviewComment,
  updateReviewCommentMetadata,
  upsertReviewComment,
  ensureCloseAppliedComment,
} = reviewCommentWorkflow;

function securityConcernLocation(concern: SecurityConcern): string {
  if (!concern.file) return "not tied to a single file";
  return `${concern.file}${concern.line ? `:${concern.line}` : ""}`;
}

function planCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const batchSize = numberArg(args.batch_size, DEFAULT_PLAN_BATCH_SIZE);
  const maxPages = numberArg(args.max_pages, 250);
  const shardCount = numberArg(args.shard_count, DEFAULT_PLAN_SHARD_COUNT);
  const minimumActiveShards = numberArg(args.min_active_shards, 0);
  const minimumBackfillReviewAgeMs =
    numberArg(args.min_backfill_review_age_minutes, DEFAULT_BACKFILL_REVIEW_AGE_MINUTES) *
    60 *
    1000;
  const itemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const hasItemNumbersInput = typeof args.item_numbers === "string" && args.item_numbers.trim();
  const hotIntake = boolArg(args.hot_intake);
  const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const serviceTier = stringArg(args.codex_service_tier, DEFAULT_SERVICE_TIER);
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  const coverageManifest = stringArg(args.coverage_tracked_items_manifest, "").trim();
  const coverageTrackedItemIds = coverageManifest
    ? coverageTrackedItemIdsFromManifest(resolve(coverageManifest), targetProfile().slug)
    : undefined;
  const planOptions: Parameters<typeof planCandidates>[0] = {
    batchSize,
    maxPages,
    shardCount,
    itemsDir,
    reviewPolicy,
    minimumActiveShards,
    minimumBackfillReviewAgeMs,
    ...(coverageTrackedItemIds ? { coverageTrackedItemIds } : {}),
  };
  if (hasItemNumbersInput || itemNumbers.length > 0) planOptions.itemNumbers = itemNumbers;
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

// Offline local-range review: synthesize the Item + ItemContext from the local
// git range (merge-base(base, HEAD)..HEAD) so the FULL review (real-behavior
// proof + mantis decision) can run BEFORE a PR exists — the "advisory review
// before submission" #357 describes but gates behind an already-open PR. No
// GitHub fetch: the diff comes from `git diff`, the body from the commit message
// (or --body-file), so it works offline on a fork checkout.
const buildLocalRangeReview = createLocalRangeReviewer({
  run,
  pullCommitContentRevision,
  pullFileTreeIdentity,
  reviewCommentContentRevision,
});

export function buildLocalRangeReviewForTest(
  targetDir: string,
  repo: string,
  baseRef: string,
): { item: Item; context: ItemContext; baseSha: string; headSha: string } {
  return buildLocalRangeReview(targetDir, repo, baseRef);
}

const reviewActionLedger = createReviewActionLedger({
  root: ROOT,
  targetRepo,
  repoRelativePath,
  sha256,
  isRuntimeBudgetError: (error) => error instanceof GitHubRuntimeBudgetError,
});
export const { actionLedgerFailureDisposition } = reviewActionLedger;
const {
  actionLedgerItemKey,
  actionLedgerPrivacy,
  finishReviewActionLedger,
  finishReviewActionLedgerItem,
  recordReviewLogPublication,
  reviewMutationRunner,
  startReviewActionLedger,
  startReviewActionLedgerItem,
  workflowRunEvidence,
} = reviewActionLedger;

const commandOperations = createCommandOperations({
  actionLedgerFailureDisposition,
  actionLedgerPrivacy,
  appendSectionValue,
  applyDecisionsCommandInner: (...args) => applyDecisionsCommandInner(...args),
  artifactTargetIsOpen,
  codexFailureReason,
  currentReviewRevision,
  decisionPacketsDirFromArgs,
  defaultClosedDir,
  defaultItemsDir,
  defaultPlansDir,
  effectiveReviewStatus,
  ensureDir,
  ensureGitHubRuntimeAvailable,
  exactReviewQueueAuthorityFromEnv,
  failedReviewFailureDetail,
  failedReviewRetryEligibility,
  failedReviewRetryResultRevision,
  failedReviewRetryRevisionForReport,
  fetchItem,
  fetchOpenItemNumbers,
  frontMatterValue,
  ghJson,
  ghPaged,
  ghRawOnceWithCheckpoint,
  ghWithRetry,
  GitHubDispatchError,
  GitHubRuntimeBudgetError,
  isFailedReviewRetryAlreadyExhausted,
  isMarkdownForActiveRepo,
  itemSourceRevisionSha256,
  lockedConversationApplyReason,
  markdownFiles,
  markdownRepository,
  numberForMarkdownFile,
  parseReportFileName,
  postReviewStartStatusComment,
  reconcileFolders: (...args) => reconcileFolders(...args),
  replaceFrontMatterValue,
  replaceSectionValue,
  repoFromArgs,
  repoRelativePath,
  reportFileName,
  reportItemKind,
  reviewActionLedger,
  reviewArtifactDestination,
  reviewLeaseRevisionFromReport,
  ROOT,
  sameFailedReviewRetryRevision,
  sectionValue,
  sha256,
  storedFailedReviewRetryRevision,
  syncWorkPlanFromReport,
  targetRepo,
  withGitHubRuntimeBudget,
  workflowRunEvidence,
  workPlanPathForReport,
});
export const {
  applyActionEventDisposition,
  applyItemBusinessIdempotencyIdentityForTest,
  applyMutationBusinessIdempotencyIdentityForTest,
  applyPhaseSequenceForTest,
  applyRuntimeBudgetForTest,
  applyRuntimeBudgetYieldResultsForTest,
  enforceExpectedIssueSourceRevisionForTest,
  preserveFailedReviewRetryMetadataForTest,
  reviewCommentPublicationEventDisposition,
  reviewRetryActionDisposition,
  reviewRetryActionNeedsItemEventForTest,
  reviewRetryBatchEventDisposition,
  reviewRetryBusinessIdempotencyIdentityForTest,
} = commandOperations;
const {
  applyArtifactsCommand,
  applyDecisionsCommand,
  applyRuntimeBudgetYieldResults,
  enforceExpectedIssueSourceRevision,
  failedReviewRetryMarkdownWithState,
  failedReviewRetryStatePath,
  finishApplyMutationAttempt,
  liveIssueSourceRevision,
  orderedApplyItemNumbers,
  readFailedReviewRetryState,
  recordApplyActionEvents,
  recordApplyActionLedgerItemResults,
  recordApplyMutationBoundary,
  reserveReviewLeaseCommand,
  retryFailedReviewsCommand,
  startApplyActionLedger,
  startApplyActionLedgerItem,
  startApplyMutationAttempt,
} = commandOperations;

const { reviewCommand } = createReviewCommandWorkflow({
  actionLedgerFailureDisposition,
  actionLedgerItemKey,
  get activeReviewMutationRunner() {
    return activeReviewMutationRunner;
  },
  set activeReviewMutationRunner(value: MutationRunner | null) {
    activeReviewMutationRunner = value;
  },
  asRecord,
  attachFixedPullRequest,
  authorIssueCountInBulkFilerWindow,
  buildLocalRangeReview,
  buildReviewPrompt,
  bulkFilerPolicyInvalidatesCachedReview,
  bulkFilerRepositoryPermission,
  codexFailureDecision,
  codexFailureLogKind,
  CodexReviewError,
  codexReviewFailureRetryable,
  collectItemContext,
  commentId,
  completePullChecksContext,
  DEFAULT_PLAN_BATCH_SIZE,
  defaultItemsDir,
  defaultLocalRangeArtifactDir,
  defaultReviewArtifactDir,
  deleteOwnedDedicatedReviewStartLease,
  detectBulkFiler,
  displayDurationMs,
  displayPath,
  enforceExpectedIssueSourceRevision,
  ensureDir,
  exactLocalReviewNoCandidateError,
  existingReview,
  extractLatestClawSweeperReview,
  fetchIssueReviewComments,
  fetchReviewStructuralRecord,
  finishReviewActionLedger,
  finishReviewActionLedgerItem,
  freshDedicatedReviewStartLeases,
  frontMatterValue,
  gitInfo,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  issueReviewCommentState,
  isSuppliedReviewStartLease,
  itemContentDigest,
  itemSnapshotHash,
  liveClawSweeperReviewDigest,
  localExactReviewItem,
  makeTreeReadOnly,
  markdownFor,
  postReviewStartStatusComment,
  previousClawSweeperReviewDigestFromReport,
  pullChecksContext,
  pullHeadShaFromContext,
  pullRequestHeadSha,
  recordReviewLogPublication,
  refreshRelatedItemsContext,
  replaceFrontMatterValue,
  repoFromArgs,
  reportFileName,
  reportReviewFindings,
  resolveReviewCheckout,
  restoreTreeModes,
  reviewActionForDecision,
  reviewCodexForcedLoginMethod,
  reviewLeaseStillMatchesContext,
  reviewMutationRunner,
  reviewPolicyHash,
  reviewStructuralPullStateFromContext,
  runCodex,
  selectCandidates,
  startReviewActionLedger,
  startReviewActionLedgerItem,
  stringOrUndefined,
  suppliedReviewStartLeaseFromArgs,
  targetRepo,
  updateBulkFilerDetectedFrontMatter,
  updateReviewSemanticFrontMatter,
  updateReviewStructuralFrontMatter,
});

const { applyDecisionsCommandInner } = createApplyDecisionWorkflow({
  abandonedPrApplyBlockReasonSafe,
  actionLedgerItemKey,
  get activeApplyMutationRunner() {
    return activeApplyMutationRunner;
  },
  set activeApplyMutationRunner(value: MutationRunner | null) {
    activeApplyMutationRunner = value;
  },
  addIssueLabel,
  applyAuthorPrBudgetStateToReport,
  applyBlockingProtectedLabels,
  applyClosedUnmergedCanonicalBlockedReport,
  applyKindArg,
  ApplyMutationReviewGuardError,
  applyPrCloseCoverageProofBlockedReport,
  applyPrCloseCoverageProofReportSection,
  applyProtectedLabelReason,
  applyQueueSortFields,
  applyRuntimeBudgetYieldResults,
  asRecord,
  authorPrBudgetAgeSkipReason,
  authorPrBudgetApplyGateSafe,
  authorPrBudgetCloseEnabled,
  authorPrBudgetMaxClosesPerRun,
  authorPrBudgetPromotion,
  authorPrBudgetSignalBlockReason,
  bulkFilerRepositoryPermission,
  canonicalPullRequestCommentSyncBlock,
  CLAWSWEEPER_BOT_AUTHORS,
  cleanupSupersededReviewPlaceholderComments,
  closeItem,
  closeReasonApplyAgeSkipReason,
  closeReasonEnabled,
  closeReasonFilterText,
  closeReasonsArg,
  closingPullRequestsForIssue,
  collectItemContext,
  commentBody,
  commentBodyMatches,
  commentId,
  commentUpdatedAt,
  completeStaleCanonicalCommentSyncReport,
  contextHasNonAutomationActivityAfter,
  coverageProofRetryExhaustedRuntimeBudget,
  coveringPrCloseCoveragePullRequestUpdatedAt,
  decisionPacketsDirFromArgs,
  defaultClosedDir,
  defaultItemsDir,
  defaultPlansDir,
  deleteOwnedDedicatedReviewStartLease,
  duplicateCanonicalPullRequestBlockReason,
  ensureCloseAppliedComment,
  ensureDir,
  ensureIdeaArchiveLabel,
  ensureRuntimeDelayFits,
  exactEventReviewLeaseDisposition,
  fetchIssueReviewComments,
  fetchItem,
  fetchReviewedPrActivityCursor,
  finishApplyMutationAttempt,
  freshPullRequestReviewHead,
  frontMatterBoolean,
  frontMatterStringArray,
  frontMatterValue,
  ghJson,
  GitHubRuntimeBudgetError,
  guardedOpenApplyProofFields,
  hasAutoCloseAllowedMetadata,
  hasNormalizedLabel,
  hasVerifiedLocalCheckoutAccess,
  impactLabelsFromReport,
  isApplyCloseCandidateReport,
  isBulkFilerExemptAuthorAssociation,
  isExactEventSourceRevisionChange,
  isGoodFirstIssue,
  isLiveRecheckCloseGuardReport,
  isMaintainerAuthorAssociation,
  isPairBlockedCloseReport,
  isRetryableCloseSkipReport,
  isRetryableKeptOpenCloseReport,
  isRetryablePrCloseCoverageProofReport,
  issueAdvisoryLabelStateFromReport,
  issueRecentHumanCommentBlockReasonSafe,
  issueReviewComment,
  issueReviewCommentState,
  isVerifiedFixedCloseReason,
  itemSnapshotHash,
  liveIssueSourceRevision,
  livePullRequestHasNoDiff,
  lockedConversationApplyReason,
  login,
  lowSignalUnmergeablePrApplyBlockReasonSafe,
  markdownRepository,
  markedReviewCommentBody,
  maturityLabelsFromReport,
  mergeRiskLabelsFromReport,
  mutationErrorMessage,
  normalizeAuthorAssociation,
  normalizeLabelName,
  numberForMarkdownFile,
  obsoleteFixPrApplyBlockReasonSafe,
  openClosingPullRequestApplyReason,
  orderedApplyItemNumbers,
  pairCloseKey,
  PATCHABLE_REVIEW_COMMENT_AUTHORS,
  postReviewStartStatusComment,
  PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH,
  prAutoCloseExemptDecisionReason,
  prCloseCoverageProofGateResult,
  prCloseCoverageProofPromptTemplate,
  prStatusLabelKindFromReport,
  pullHeadShaFromContext,
  pullRequestClosePromotion,
  recordApplyActionEvents,
  recordApplyActionLedgerItemResults,
  recordApplyMutationBoundary,
  recordedLabelSyncCoversUpdate,
  removeCurrentCursorTraceItem,
  renderReviewCommentFromReport,
  replaceFrontMatterValue,
  replaceSectionValue,
  repoFromArgs,
  reportCloseReason,
  reportDecision,
  reportEntriesForDir,
  reportFeatureShowcase,
  reportItemKind,
  reportOverallCorrectness,
  reportPrRating,
  reportRealBehaviorProof,
  reportSecurityReview,
  reportTelegramVisibleProof,
  reviewCommentBodyDigest,
  reviewCommentHasCloseVerdictForCanonical,
  reviewCommentHashMatches,
  reviewLeaseRevisionFromReport,
  reviewReportCanPromoteToClose,
  reviewSectionValue,
  reviewStartLeaseOwner,
  ROOT,
  runtimeBudgetExceeded,
  sameAuthorCounterpartApplyReason,
  sha256,
  shouldPreserveReviewStartLease,
  shouldProbeClosedStateReport,
  shouldSyncReviewComment,
  sleepMs,
  staleCanonicalCommentSyncPendingReason,
  staleCanonicalPullRequestNumber,
  stalePullRequestReviewComment,
  stalePullRequestReviewHead,
  staleReviewCommentSyncReason,
  staleVersionBugApplyBlockReasonSafe,
  stalledUnprovenPrApplyBlockReasonSafe,
  startApplyActionLedger,
  startApplyActionLedgerItem,
  startApplyMutationAttempt,
  stringOrUndefined,
  syncBulkFilerLabel,
  syncFeatureShowcaseLabel,
  syncImpactLabels,
  syncIssueAdvisoryLabels,
  syncMaturityLabels,
  syncMergeRiskLabels,
  syncPriorityLabel,
  syncPrRatingLabel,
  syncPrStatusLabel,
  syncRealBehaviorProofMediaLabels,
  syncRealBehaviorProofSufficientLabel,
  syncStalePullRequestReviewLabels,
  syncTelegramVisibleProofLabel,
  syncWorkPlanFromReport,
  targetRepo,
  get throttleHeartbeatContext() {
    return throttleHeartbeatContext;
  },
  set throttleHeartbeatContext(value: (() => string) | null) {
    throttleHeartbeatContext = value;
  },
  timeoutWithinRuntimeBudget,
  timestampMs,
  triagePriorityFromReport,
  unconfirmedProductDirectionApplyBlockReasonSafe,
  unconfirmedProductDirectionCloseEnabled,
  unsponsoredFeatureApplyBlockReasonSafe,
  unsponsoredFeatureCloseEnabled,
  updateReviewCommentMetadata,
  upgradeNoDiffPullRequestReport,
  upgradePullRequestClosePromotionReport,
  upsertReviewComment,
  validateCloseDecision,
});

function artifactTargetIsOpen(number: number, openNumbers: Set<number> | null): boolean {
  if (openNumbers) return openNumbers.has(number);
  return fetchItem(number).state === "open";
}

function markdownFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => parseReportFileName(name) !== null)
        .sort((left, right) => {
          const leftParsed = parseReportFileName(left);
          const rightParsed = parseReportFileName(right);
          return (
            (leftParsed?.repo ?? DEFAULT_TARGET_REPO).localeCompare(
              rightParsed?.repo ?? DEFAULT_TARGET_REPO,
            ) || (leftParsed?.number ?? 0) - (rightParsed?.number ?? 0)
          );
        })
    : [];
}

function reportEntriesForDir(dir: string, itemNumbers?: ReadonlySet<number>): ReportEntry[] {
  return markdownFiles(dir)
    .filter((name) => !itemNumbers || itemNumbers.has(numberForMarkdownFile(name)))
    .map((name) => {
      const path = join(dir, name);
      const markdown = readFileSync(path, "utf8");
      return {
        name,
        number: numberForMarkdownFile(name),
        path,
        repo: markdownRepository(markdown, path),
        markdown,
      };
    });
}

function numberForMarkdownFile(file: string): number {
  const parsed = parseReportFileName(file);
  if (!parsed) throw new Error(`Invalid report filename: ${file}`);
  return parsed.number;
}

function repoRelativePath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

const dashboardAudit = createDashboardAudit({
  addDashboardCadenceBucket,
  applyBlockingProtectedLabels,
  applyHealthStatusArg,
  auditStatePath,
  capDashboardCadenceBucket,
  currentWorkflowStatusBlock,
  dashboardMarkdownWithFailedReviewRetryState,
  decisionPacketsDirFromArgs,
  defaultClosedDir,
  defaultFailedReviewRetryStateDir,
  defaultItemsDir,
  defaultPlansDir,
  displayTitle,
  effectiveReviewStatus,
  emptyDashboardActivityStats,
  emptyDashboardCadenceBucket,
  emptyDashboardKindStats,
  ensureDir,
  fetchItem,
  fetchOpenItemCounts,
  fetchOpenItemNumbers,
  fetchOpenItems,
  formatActivityRow,
  formatCadenceBucket,
  formatOperationActivityRow,
  formatPercent,
  formatStatusNumber,
  formatTimestamp,
  frontMatterStringArray,
  frontMatterValue,
  isCurrentForCadence,
  isFresh,
  isMaintainerAuthored,
  isMarkdownForActiveRepo,
  isProtectedItem,
  itemUrlFor,
  latestTimestamp,
  markdownFiles,
  markdownLink,
  markdownRepository,
  numberForMarkdownFile,
  profileAuditEnd,
  profileAuditStart,
  recordDashboardActivity,
  replaceFrontMatterValue,
  repoFromArgs,
  repoRelativePath,
  reportEntriesForDir,
  reportFileUrl,
  repoUrlFor,
  ROOT,
  shouldPlanItem,
  sweepStatusRelativePath,
  syncWorkPlanFromReport,
  targetProfile,
  targetRepo,
  timestampMs,
  withTargetProfile,
  workflowStatusSummary,
  workPlanPathForReport,
  writeSweepStatus,
});
export const {
  auditFromSnapshot,
  auditHasStrictFailures,
  auditHealthSection,
  dashboardClosedAt,
  formatRecentClosedRows,
} = dashboardAudit;
const {
  auditCommand,
  jsonFrontMatterValue,
  reconcileCommand,
  reconcileFolders,
  statusCommand,
  updateDashboard,
  workStatusForDecision,
} = dashboardAudit;

function applyHealthStatusArg(args: Args): Record<string, unknown> | undefined {
  const filePath = stringArg(args.apply_health_file, "");
  const jsonText = stringArg(args.apply_health_json, "");
  if (filePath && jsonText) {
    throw new Error("--apply-health-file and --apply-health-json are mutually exclusive");
  }
  const text = filePath ? readFileSync(resolve(filePath), "utf8") : jsonText;
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("apply health status must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function checkCommand(): void {
  JSON.parse(reviewDecisionSchemaText());
  if (!existsSync(join(ROOT, ".github", "workflows", "sweep.yml")))
    throw new Error("Missing workflow");
  console.log("ok");
}

function publishActionEventsCommand(args: Args): void {
  const sourceRoot = resolve(
    stringArg(args.source_root, join(ROOT, ".clawsweeper-repair", "action-ledger-download")),
  );
  const stateRoot = resolve(stringArg(args.state_root, ROOT));
  const expectedProducerJob = stringArg(args.expected_producer_job, "");
  if (!expectedProducerJob) {
    throw new UserFacingCommandError("--expected-producer-job is required");
  }
  const expectedProducerRunAttempt = optionalNumberArg(args.expected_producer_run_attempt);
  if (
    expectedProducerRunAttempt !== undefined &&
    (!Number.isInteger(expectedProducerRunAttempt) || expectedProducerRunAttempt < 1)
  ) {
    throw new UserFacingCommandError("--expected-producer-run-attempt must be a positive integer");
  }
  const expectedProducerRunId = stringArg(args.expected_producer_run_id, "");
  if (expectedProducerRunId && !/^\d{1,30}$/.test(expectedProducerRunId)) {
    throw new UserFacingCommandError(
      "--expected-producer-run-id must be a numeric workflow run ID",
    );
  }
  const expectedProducerSha = stringArg(args.expected_producer_sha, "");
  if (expectedProducerSha && !/^[0-9a-f]{40}$/.test(expectedProducerSha)) {
    throw new UserFacingCommandError("--expected-producer-sha must be a lowercase commit SHA");
  }
  const currentProducer = workflowActionProducer("action_event_publisher");
  const result = importActionEventShards(sourceRoot, stateRoot, {
    expectedProducer: {
      repository: currentProducer.repository,
      sha: expectedProducerSha || currentProducer.sha,
      workflow: currentProducer.workflow,
      job: expectedProducerJob,
      runId: expectedProducerRunId || currentProducer.runId,
      runAttempt: expectedProducerRunAttempt ?? currentProducer.runAttempt,
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

const ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES = ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS * 512;

export function actionEventPublishPathsForTest(content: string): string[] {
  if (Buffer.byteLength(content, "utf8") > ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES) {
    throw new Error(
      `action event publish path manifest exceeds ${ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES} bytes`,
    );
  }
  const paths = content.split("\n").filter(Boolean);
  if (paths.length === 0) throw new Error("action event publish path manifest is empty");
  if (paths.length > ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS) {
    throw new Error(
      `action event publish path manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS} paths`,
    );
  }
  let previous = "";
  for (const path of paths) {
    if (!isActionEventPublishPath(path)) {
      throw new Error(`invalid action event publish path: ${path}`);
    }
    if (previous && path <= previous) {
      throw new Error("action event publish paths must be sorted and unique");
    }
    previous = path;
  }
  return paths;
}

async function publishActionEventPathsCommand(args: Args): Promise<void> {
  const pathsFile = resolve(stringArg(args.paths_file, ""));
  if (!pathsFile || pathsFile === ROOT) {
    throw new UserFacingCommandError("--paths-file is required");
  }
  const stat = statSync(pathsFile);
  if (!stat.isFile())
    throw new Error(`action event publish path manifest is not a file: ${pathsFile}`);
  if (stat.size > ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES) {
    throw new Error(
      `action event publish path manifest exceeds ${ACTION_EVENT_PUBLISH_PATH_FILE_MAX_BYTES} bytes`,
    );
  }
  const paths = actionEventPublishPathsForTest(readFileSync(pathsFile, "utf8"));
  for (const path of paths) {
    const source = resolve(ROOT, path);
    const rootRelativeSource = relative(ROOT, source);
    if (
      rootRelativeSource.startsWith("..") ||
      resolve(ROOT, rootRelativeSource) !== source ||
      !statSync(source).isFile()
    ) {
      throw new Error(`action event publish path is not a regular file: ${path}`);
    }
  }
  const baseUrl = process.env.QUEUE_URL ?? process.env.CLAWSWEEPER_RECORDS_URL ?? "";
  const webhookSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  let uploaded = 0;
  let unchanged = 0;
  for (const path of paths) {
    const result = await publishStateBlob({
      baseUrl,
      webhookSecret,
      path,
      content: readFileSync(resolve(ROOT, path)),
    });
    if (result.unchanged) unchanged += 1;
    else uploaded += 1;
  }
  console.log(
    JSON.stringify({ result: "published", path_count: paths.length, uploaded, unchanged }),
  );
}

function isExplicitActionLedgerCommand(command: string): boolean {
  return (
    command === "finalize-action-events" ||
    command === "publish-action-events" ||
    command === "publish-action-event-paths"
  );
}

function dashboardCommand(args: Args): void {
  repoFromArgs(args);
  updateDashboard(
    resolve(stringArg(args.items_dir, defaultItemsDir())),
    resolve(stringArg(args.closed_dir, defaultClosedDir())),
  );
}

function finalizeActionEventsCommand(args: Args): void {
  if (!boolArg(args.interrupt_open_attempts)) return;
  const reason = stringArg(args.reason, ACTION_EVENT_REASON_CODES.timeout);
  if (
    reason !== ACTION_EVENT_REASON_CODES.timeout &&
    reason !== ACTION_EVENT_REASON_CODES.cancelled &&
    reason !== ACTION_EVENT_REASON_CODES.workflowFailed
  ) {
    throw new UserFacingCommandError(
      `Unsupported --reason for interrupted action events: ${reason}`,
    );
  }
  const interrupted = interruptOpenWorkflowActionEvents(ROOT, { reasonCode: reason });
  if (interrupted > 0) {
    console.error(
      `[action-ledger] recorded ${interrupted} ${reason} terminal event${
        interrupted === 1 ? "" : "s"
      }`,
    );
  }
}

const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler<Args>>> = {
  plan: planCommand,
  "reserve-review-lease": reserveReviewLeaseCommand,
  review: reviewCommand,
  "retry-failed-reviews": retryFailedReviewsCommand,
  "apply-artifacts": applyArtifactsCommand,
  "apply-decisions": applyDecisionsCommand,
  "publish-action-events": publishActionEventsCommand,
  "publish-action-event-paths": publishActionEventPathsCommand,
  audit: auditCommand,
  reconcile: reconcileCommand,
  dashboard: dashboardCommand,
  status: statusCommand,
  "assist-target": assistResolveTargetCommand,
  assist: assistGenerateCommand,
  "assist-generate": assistGenerateCommand,
  "assist-validate": assistValidateArtifactCommand,
  "assist-publish": assistPublishCommand,
  check: checkCommand,
  "finalize-action-events": finalizeActionEventsCommand,
};

export async function main(
  argv = process.argv.slice(2),
  dependencies: {
    flushWorkflowActionEvents?: typeof flushWorkflowActionEvents;
  } = {},
): Promise<void> {
  const args = parseArgs(argv);
  const command = args._[0] ?? "review";
  const flushActionEvents = dependencies.flushWorkflowActionEvents ?? flushWorkflowActionEvents;
  if (!process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION) {
    process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = sha256(stableJson({ command, args })).slice(
      0,
      16,
    );
  }
  let commandFailed = false;
  let commandError: unknown;
  try {
    await dispatchCommand(command, args, COMMAND_HANDLERS);
  } catch (error) {
    commandFailed = true;
    commandError = error;
  }
  try {
    const shardPaths = await flushActionEvents(ROOT);
    if (shardPaths.length > 0) {
      console.error(
        `[action-ledger] finalized ${shardPaths.length} immutable workflow shard${
          shardPaths.length === 1 ? "" : "s"
        }`,
      );
    }
  } catch (error) {
    if (commandFailed) {
      console.error(
        `[action-ledger] best-effort finalization failed after command failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } else if (isExplicitActionLedgerCommand(command)) {
      commandFailed = true;
      commandError = error;
    } else {
      console.error(
        `[action-ledger] best-effort finalization failed after successful ${command}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (commandFailed) throw commandError;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(formatFatalError(error));
    process.exit(1);
  });
}

function formatFatalError(error: unknown): string {
  if (isUserFacingCommandError(error)) return `Error: ${error.message}`;
  return error instanceof Error ? error.stack || error.message : String(error);
}
