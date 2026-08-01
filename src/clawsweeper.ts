#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import {
  DEFAULT_TARGET_REPO,
  REPOSITORY_PROFILES,
  isAutoCloseAllowed,
  normalizeRepo,
  repositoryProfileFor,
  repositoryProfileForSlug,
  type RepositoryProfile,
} from "./repository-profiles.js";
import { codexEnv, PUBLIC_CODEX_MODEL } from "./codex-env.js";
import {
  ghRetryKind,
  ghRetryWaitMs,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
  summarizeGhArgs,
} from "./github-retry.js";
import { parseGhJson, parseGhJsonLinesWithRetry, parseGhJsonWithRetry } from "./github-json.js";
import { stableJson } from "./stable-json.js";
import { reviewPullChecksDigestParts } from "./review-checks-digest.js";
import {
  githubReviewBlobSizes,
  hydratePullRequestReviewBlobs,
} from "./clawsweeper-review-blobs.js";
import { coverageTrackedItemIdsFromManifest } from "./review-coverage-manifest.js";
import {
  reviewStructuralRecordAtLeastAsFresh,
  reviewStructuralRecordMatchesHydratedItem,
  reviewStructuralRecordMatchesHydratedPull,
  reviewStructuralRecordMatchesObservedUpdate,
  reviewStructuralRecordsDescribeSameVerdictInput,
  reviewStructuralPullStateDigest,
  reviewStructuralQuery,
  reviewStructuralRecordFromGraphql,
  reviewStructuralCacheDecision,
  reviewStructuralCacheProbeDecision,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import {
  createReviewSemanticRecord,
  reviewSemanticCacheDecision,
  reviewSemanticPriorReviewDigest,
  reviewSemanticRevalidationDecision,
  type ReviewSemanticRecord,
} from "./review-semantic-cache.js";
import { reviewContentCacheHit, WEEKLY_COVERAGE_REVIEW_DAYS } from "./scheduler-policy.js";
import {
  isUserFacingCommandError,
  resolveCommand,
  runText,
  UserFacingCommandError,
} from "./command.js";
import {
  isolateGitHubConfigDir,
  localReviewAdditionalPrompt,
  scrubGitHubCredentialEnv,
  LOCAL_REVIEW_WEB_SEARCH_CONFIG,
} from "./commit-sweeper.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import { IDEA_ARCHIVE_LABEL, ideaRevivalReactionThreshold } from "./idea-archive-revival.js";
import { freshExactHeadReviewStartLease } from "./repair/comment-router-core.js";
import { captureCanonicalRecordBaseline } from "./repair/canonical-record-baseline.js";
import {
  buildOpenClawPrSurfaceStats,
  renderOpenClawPrSurfaceSummary,
  renderOpenClawPrSurfaceTable,
  type PrSurfaceFile,
} from "./pr-surface-stats.js";
import {
  compactPrCloseCoverageProofComment,
  compactPrCloseCoverageProofText,
  formatPrCloseCoverageProofDetailList,
  prCloseCoverageProofCandidateCanClose,
  prCloseCoverageProofCloseDecision,
  prCloseCoverageProofEnvelopePath,
  prCloseCoverageProofPromptSha256,
  readPrCloseCoverageProofEnvelope,
  runPrCloseCoverageProofModel,
  validatePrCloseCoverageProofEnvelopeBinding,
  writePrCloseCoverageProofEnvelope,
  type PrCloseCoverageProofPullRequestView,
  type PrCloseCoverageProofRuntime,
} from "./pr-close-coverage-proof.js";
import {
  boolArg,
  itemNumbersArg,
  numberArg,
  optionalNumberArg,
  parseArgs,
  stringArg,
  type Args,
} from "./clawsweeper-args.js";
import { escapeRegExp, trimMiddle, truncateText } from "./clawsweeper-text.js";
import {
  emptyMaintainerDecision,
  maintainerDecisionBlocksClose,
  maintainerDecisionFromReport,
  renderDecisionPacketPublicBlock,
  syncDecisionPacketRecord,
  type DecisionPacketSubjectState,
  type MaintainerDecision,
} from "./decision-packets.js";
import {
  appendReviewHistoryCycle,
  neutralizeReviewControlMarkers,
  parseReviewHistory,
  renderReviewHistorySection,
  reviewHistoryCycleFromCommentBody,
  type ReviewHistoryLedger,
} from "./review-history.js";
import {
  ReviewedPrActivityChangedDuringReadError,
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
} from "./review-activity-cursor.js";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "./action-ledger.js";
import {
  ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS,
  flushWorkflowActionEvents,
  importActionEventShards,
  interruptOpenWorkflowActionEvents,
  recordWorkflowPhaseEvent,
  workflowActionProducer,
} from "./action-ledger-runtime.js";
import { isActionEventPublishPath } from "./action-ledger-paths.js";
import { publishStateBlob } from "./state-blob-client.js";
import { dispatchCommand, type CommandHandler } from "./clawsweeper-command-dispatch.js";
import { createDecisionParser } from "./clawsweeper-decision-parser.js";
import { createPullRequestReferenceParser } from "./clawsweeper-pr-references.js";
import {
  hasShinyProof,
  nextPrRatingLabels,
  ratingLabelForTier,
  themedRatingName,
} from "./clawsweeper-rating.js";

import { createApplyGuards } from "./clawsweeper-apply-guards.js";
import { createApplyActionLedger } from "./clawsweeper-apply-ledger.js";
import { createAssistWorkflow } from "./clawsweeper-assist.js";
import { createAuditEngine } from "./clawsweeper-audit.js";
import {
  configSurfaceChangeFromContext,
  dataModelChangeFromContext,
  hasDataModelUpgradeProof,
  isDocsPath,
} from "./clawsweeper-change-detection.js";
import { createCloseDecisionWorkflow } from "./clawsweeper-close-decision.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { createDashboardPresentation } from "./clawsweeper-dashboard.js";
import { createFailedReviewRetryWorkflow } from "./clawsweeper-failed-review-retry.js";
import { createGitHubContext } from "./clawsweeper-github-context.js";
import { createLabelPolicy } from "./clawsweeper-label-policy.js";
import { createLabelSynchronization } from "./clawsweeper-label-sync.js";
import { createRepositoryLinks } from "./clawsweeper-links.js";
import { createLocalRangeReviewer } from "./clawsweeper-local-review.js";
import { mediaProofRuntimeHints, prepareMediaProofArtifacts } from "./clawsweeper-media-proof.js";
import { createRelatedContext } from "./clawsweeper-related-context.js";
import { createRecordMetadata } from "./clawsweeper-record-metadata.js";
import { createReportParser } from "./clawsweeper-report-parser.js";
import { createReviewCommentWorkflow } from "./clawsweeper-review-comments-workflow.js";
import { createReviewPlanning } from "./clawsweeper-review-planning.js";
import { createReviewPresentation } from "./clawsweeper-review-presentation.js";
import { createReviewRuntime } from "./clawsweeper-review-runtime.js";
import { createReviewActionLedger } from "./clawsweeper-review-ledger.js";
import { createSourceRevisionTools } from "./clawsweeper-source-revision.js";
import { createStatusContext } from "./clawsweeper-status-context.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import type {
  AcquiredReviewStartLease,
  Action,
  ActionTaken,
  AgentsPolicyStatus,
  ApplyKind,
  ApplyResult,
  AuditRecord,
  AuditRecordLocation,
  AuditResult,
  AuthorPrBudgetApplyGate,
  AuthorPrBudgetApplyState,
  BulkFilerCountCache,
  BulkFilerDetectionOptions,
  BulkFilerDetectionResult,
  BulkFilerRepositoryPermissionCache,
  CanonicalPullRequestCommentSyncBlock,
  CloseReason,
  ClosingPullRequestReference,
  CompleteActivityContext,
  Confidence,
  ContextHydration,
  DashboardClosedItem,
  DashboardItem,
  DashboardKindStats,
  DashboardStats,
  Decision,
  DecisionNormalizationItem,
  Evidence,
  ExpectedIssueSourceRevisionOptions,
  FixedPullRequest,
  GitHubDispatchOutcome,
  GitHubRetryOptions,
  GitHubRuntimeBudget,
  GitHubUser,
  GitInfo,
  GitTreeEntry,
  GoodFirstIssueHumanLabelState,
  Item,
  ItemCategory,
  ItemContext,
  ItemKind,
  LabelJustification,
  LabelTransitionJustification,
  LikelyOwner,
  LinkedPullRequestSupersession,
  LinkedPullRequestSupersessionResolution,
  MantisRecommendation,
  MergeRiskOption,
  MutationRunner,
  OpenItemCounts,
  PrCloseCoverageProofCoveringWitness,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
  PrCloseCoverageRuntimeBudget,
  PreparedMediaProof,
  PreviousClawSweeperReview,
  PrRating,
  PrStatusLabelKind,
  PublicBeforeMergeItem,
  PublicPriority,
  PullRequestClosePromotion,
  PullRequestRef,
  RealBehaviorProof,
  ReconcileResult,
  RepoDashboardSnapshot,
  ReportEntry,
  ReproductionStatus,
  ReviewActionLedger,
  ReviewCommentRenderOptions,
  ReviewContextLedgerEntry,
  ReviewFinding,
  ReviewMetric,
  ReviewRuntime,
  ReviewStartStatusCommentResult,
  RootCauseClusterAssessment,
  SecurityConcern,
  SecurityConcernSeverity,
  SecurityReview,
  WorkCandidateKind,
} from "./clawsweeper-types.js";
import {
  ALLOWED_REASONS,
  APPLY_PROTECTED_LABELS,
  AUTHOR_PR_BUDGET_MIN_AGE_DAYS,
  AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS,
  BULK_FILED_LABEL,
  BULK_FILER_SEARCH_TIMEOUT_MS,
  DAILY_REVIEW_DAYS,
  DAY_MS,
  DEFAULT_AUTHOR_PR_BUDGET,
  DEFAULT_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
  DEFAULT_BACKFILL_REVIEW_AGE_MINUTES,
  DEFAULT_BULK_FILER_THRESHOLD,
  DEFAULT_BULK_FILER_WINDOW_DAYS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW_CODEX_TIMEOUT_MS,
  DEFAULT_SERVICE_TIER,
  EVENT_GUARDED_OPEN_ACTIONS,
  FEATURE_SHOWCASE_LABEL,
  FEATURE_SHOWCASE_LABEL_DESCRIPTION,
  FRESH_DAYS,
  GOOD_FIRST_ISSUE_LABEL,
  HOT_REVIEW_DAYS,
  IMPACT_LABEL_NAMES,
  MATURITY_LABEL_NAMES,
  MERGE_RISK_LABEL_NAMES,
  OBSOLETE_FIX_PR_MIN_AGE_DAYS,
  PR_CLOSE_COVERAGE_PROOF_SECTION,
  PR_RATING_LABEL_NAMES,
  PR_STATUS_LABEL_NAMES,
  PRIORITY_LABEL_NAMES,
  PROOF_MEDIA_LABEL_NAMES,
  PROOF_MEDIA_LABELS,
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
  PROOF_SUFFICIENT_LABEL_DESCRIPTION,
  PROTECTED_LABELS,
  RECENT_ISSUE_DAYS,
  REVIEW_POLICY_VERSION,
  REVIEW_SECTIONS,
  SECURITY_CONCERN_SEVERITIES,
  STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
  STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
  STALE_VERSION_BUG_MIN_AGE_DAYS,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS,
  UNSPONSORED_FEATURE_MIN_AGE_DAYS,
} from "./clawsweeper-policy.js";
import {
  filterReviewComments,
  latestClawSweeperReview,
  latestClawSweeperReviewFromHydration,
  rawCommentBody,
  timestampValueMs,
} from "./clawsweeper-review-comments.js";
export type {
  BulkFilerDetectionResult,
  BulkFilerReviewContext,
  ContextHydration,
  GitHubDispatchOutcome,
  GithubPageWithHeaders,
  LabelJustification,
  ReviewStartStatusCommentOptions,
} from "./clawsweeper-types.js";

export {
  codexEnv,
  codexLoginConfig,
  codexLoginMethod,
  redactInternalCodexModel,
} from "./codex-env.js";
export {
  parseGhJson,
  parseGhJsonLines,
  parseGhJsonLinesWithRetry,
  parseGhJsonWithRetry,
  parseGhJsonWithRetryAsync,
} from "./github-json.js";
export { itemNumbersArg } from "./clawsweeper-args.js";
export {
  prepareMediaProofArtifactsForTest,
  proofMediaUrlsFromContextForTest,
  proofVideoUrlsFromContextForTest,
} from "./clawsweeper-media-proof.js";
export {
  configSurfaceChangeFromPullFilesForTest,
  dataModelChangeFromPullFilesForTest,
} from "./clawsweeper-change-detection.js";
export {
  buildDecisionPacketFromReport,
  renderDecisionPacketPublicBlock,
} from "./decision-packets.js";
export { safeOutputTail } from "./clawsweeper-text.js";
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
  isClawSweeperComment,
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
  neutralizeOwnedSectionSpoofing,
  sanitizeArchitectureDiagram,
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
  agentsPolicyStatusLine,
  defaultRootCauseCluster,
  evidenceEntry,
  frontMatterJsonArray,
  frontMatterStringArray,
  frontMatterValue,
  isDocsOnlyPullRequestReport,
  isExternalPullRequestReport,
  markdownRepository,
  parseBoldListHeading,
  parseLabelJustification,
  parseMergeRiskOption,
  parseReviewFindingHeading,
  parseRootCauseCluster,
  parseSecurityConcernHeading,
  reviewSectionValue,
  sectionLineValue,
  sectionList,
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
  authorPrBudget,
  authorPrBudgetAgeSkipReason,
  authorPrBudgetCloseEnabled,
  ghJson,
  ghPaged,
  isMaintainerAuthorAssociation,
  isMaintainerAuthored,
  isOlderThanDays,
  labelNames,
  login,
  normalizeLabelName,
  obsoleteFixPrAgeSkipReason,
  obsoleteFixPrCloseEnabled,
  protectedLabels,
  quoteGitHubSearchTerm: (term) => quoteGitHubSearchTerm(term),
  reportPrRating,
  reportRealBehaviorProof,
  staleVersionBugAgeSkipReason,
  staleVersionBugCloseEnabled,
  stringOrUndefined,
  targetRepo,
  unconfirmedProductDirectionAgeSkipReason,
  unconfirmedProductDirectionCloseEnabled,
  unsponsoredFeatureAgeSkipReason,
  unsponsoredFeatureCloseEnabled,
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

export function compactMappedSlice<T>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => unknown,
): unknown[] {
  return compactMappedWindow(items, items.length, limit, mapper);
}

export function compactMappedWindow<T>(
  items: readonly T[],
  total: number,
  limit: number,
  mapper: (item: T) => unknown,
): unknown[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const boundedTotal = Math.max(0, Math.floor(total));
  if (boundedTotal <= boundedLimit && items.length <= boundedLimit) return items.map(mapper);
  if (boundedLimit === 0) {
    return boundedTotal > 0
      ? [{ omitted: boundedTotal, note: "middle entries omitted from prompt context" }]
      : [];
  }
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const retained =
    items.length > boundedLimit && boundedTotal === items.length
      ? items
      : items.slice(0, boundedLimit);
  const retainedStart = retained.slice(0, keepStart);
  const retainedEnd =
    keepEnd > 0 ? retained.slice(Math.max(keepStart, retained.length - keepEnd)) : [];
  const omitted = Math.max(0, boundedTotal - retainedStart.length - retainedEnd.length);
  return [
    ...retainedStart.map(mapper),
    ...(omitted > 0 ? [{ omitted, note: "middle entries omitted from prompt context" }] : []),
    ...retainedEnd.map(mapper),
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
    authorAssociation: normalizeAuthorAssociation(comment.author_association),
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    body: truncateText(comment.body, 6000),
  };
}

function isClawSweeperComment(value: unknown): boolean {
  return CLAWSWEEPER_BOT_AUTHORS.has((login(asRecord(value).user) ?? "").toLowerCase());
}

const reviewCommentContext = {
  isClawSweeperComment,
  reviewCommentBodyDigest,
};

function filterReviewContextComments(
  comments: readonly unknown[],
  number: number,
): { included: unknown[]; filtered: number } {
  return filterReviewComments(comments, number, reviewCommentContext);
}

function extractLatestClawSweeperReview(
  comments: readonly unknown[],
  number: number,
): PreviousClawSweeperReview | null {
  return latestClawSweeperReview(comments, number, reviewCommentContext);
}

export function filterReviewContextCommentsForTest(
  comments: readonly unknown[],
  number: number,
): { included: unknown[]; filtered: number } {
  return filterReviewContextComments(comments, number);
}

export function extractLatestClawSweeperReviewForTest(
  comments: readonly unknown[],
  number: number,
): PreviousClawSweeperReview | null {
  return extractLatestClawSweeperReview(comments, number);
}

function extractLatestClawSweeperReviewFromHydration(
  commentsWindow: ContextHydration<unknown>,
  completeComments: readonly unknown[],
  number: number,
): PreviousClawSweeperReview | null {
  return latestClawSweeperReviewFromHydration(
    commentsWindow,
    completeComments,
    number,
    reviewCommentContext,
  );
}

export function extractLatestClawSweeperReviewFromHydrationForTest(
  commentsWindow: ContextHydration<unknown>,
  completeComments: readonly unknown[],
  number: number,
): PreviousClawSweeperReview | null {
  return extractLatestClawSweeperReviewFromHydration(commentsWindow, completeComments, number);
}

function previousClawSweeperReviewDigestFromReport(markdown: string): string | null {
  const digest = frontMatterValue(markdown, "review_comment_sha256")?.trim().toLowerCase();
  return digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function liveClawSweeperReviewDigest(number: number): string | null {
  return reviewSemanticPriorReviewDigest(
    extractLatestClawSweeperReview(fetchIssueReviewComments(number), number),
  );
}

export function previousClawSweeperReviewDigestFromReportForTest(
  markdown: string,
  _number: number,
): string | null {
  return previousClawSweeperReviewDigestFromReport(markdown);
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

function goodFirstIssueHumanLabelState(
  timeline: readonly unknown[],
): GoodFirstIssueHumanLabelState {
  const events = timeline
    .map((value) => {
      const event = asRecord(value);
      const labelValue = event.label;
      const label =
        typeof labelValue === "string"
          ? labelValue
          : (stringOrUndefined(asRecord(labelValue).name) ?? "");
      const actorValue = event.actor;
      const actor = typeof actorValue === "string" ? actorValue : (login(actorValue) ?? "");
      return {
        event: stringOrUndefined(event.event) ?? "",
        label: normalizeLabelName(label),
        actor: actor.toLowerCase(),
        createdAt: stringOrUndefined(event.createdAt) ?? stringOrUndefined(event.created_at) ?? "",
        id: Number(event.id ?? 0),
      };
    })
    .filter((event) => event.label === GOOD_FIRST_ISSUE_LABEL)
    .filter(
      (event) =>
        !isAutomationReportAuthor(event.actor) && !CLAWSWEEPER_BOT_AUTHORS.has(event.actor),
    )
    .sort(
      (left, right) =>
        timestampValueMs(left.createdAt) - timestampValueMs(right.createdAt) || left.id - right.id,
    );
  const latest = events.at(-1);
  if (latest?.event === "unlabeled") return "removed";
  if (latest?.event === "labeled") return "added";
  return "unknown";
}

export function goodFirstIssueLabelOptedOutForTest(timeline: readonly unknown[]): boolean {
  return goodFirstIssueHumanLabelState(timeline) === "removed";
}

function compactPullRequest(value: unknown): unknown {
  const pull = asRecord(value);
  const head = asRecord(pull.head);
  const base = asRecord(pull.base);
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state,
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

export function compactPullRequestForTest(value: unknown): unknown {
  return compactPullRequest(value);
}

function compactCheckRun(value: unknown): unknown {
  const check = asRecord(value);
  return {
    name: check.name ?? null,
    status: check.status ?? null,
    conclusion: check.conclusion ?? null,
    app: asRecord(check.app).slug ?? null,
  };
}

function compactCommitStatus(value: unknown): unknown {
  const status = asRecord(value);
  return {
    context: status.context ?? null,
    state: status.state ?? null,
    description: status.description ?? null,
  };
}

function pullChecksContext(number: number, headSha: string): unknown {
  try {
    const checkResponse = asRecord(
      ghJson<unknown>(["api", `repos/${targetRepo()}/commits/${headSha}/check-runs?per_page=100`]),
    );
    const statusResponse = asRecord(
      ghJson<unknown>([`api`, `repos/${targetRepo()}/commits/${headSha}/status?per_page=100`]),
    );
    const rawCheckRuns = Array.isArray(checkResponse.check_runs) ? checkResponse.check_runs : null;
    const rawStatuses = Array.isArray(statusResponse.statuses) ? statusResponse.statuses : null;
    const checkRunsTotal = githubCount(checkResponse.total_count);
    const statusesTotal = githubCount(statusResponse.total_count);
    if (!rawCheckRuns || !rawStatuses || checkRunsTotal === null || statusesTotal === null) {
      return {
        complete: false,
        checkRuns: [],
        checkRunsTruncated: true,
        statuses: [],
        statusesTruncated: true,
      };
    }
    const checkRunsTruncated = checkRunsTotal > rawCheckRuns.length || rawCheckRuns.length > 100;
    const statusesTruncated = statusesTotal > rawStatuses.length || rawStatuses.length > 100;
    const checkRuns = rawCheckRuns
      .slice(0, 100)
      .map(compactCheckRun)
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    const statuses = rawStatuses
      .slice(0, 100)
      .map(compactCommitStatus)
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    return {
      complete: !checkRunsTruncated && !statusesTruncated,
      checkRuns,
      checkRunsTruncated,
      statuses,
      statusesTruncated,
    };
  } catch (error) {
    console.error(
      `[review] ${new Date().toISOString()} check-state=unavailable #${number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      complete: false,
      checkRuns: [],
      checkRunsTruncated: true,
      statuses: [],
      statusesTruncated: true,
    };
  }
}

function completePullChecksContext(value: unknown): boolean {
  const checks = asRecord(value);
  return (
    checks.complete === true &&
    checks.checkRunsTruncated !== true &&
    checks.statusesTruncated !== true &&
    Array.isArray(checks.checkRuns) &&
    Array.isArray(checks.statuses)
  );
}

export function closingPullRequestReferenceTarget(
  reference: unknown,
  fallbackRepo = targetRepo(),
): ClosingPullRequestReference | null {
  const record = asRecord(reference);
  const number = record.number;
  if (typeof number !== "number" || !Number.isInteger(number)) return null;

  const repository = asRecord(record.repository);
  const owner = asRecord(repository.owner).login;
  const name = repository.name;
  const repo =
    typeof owner === "string" && typeof name === "string" ? `${owner}/${name}` : fallbackRepo;
  return { repo, number };
}

function closingPullRequestReferencesForIssue(number: number): ClosingPullRequestReference[] {
  const issue = ghJson<unknown>([
    "issue",
    "view",
    String(number),
    "--repo",
    targetRepo(),
    "--json",
    "closedByPullRequestsReferences",
  ]);
  const references = asRecord(issue).closedByPullRequestsReferences;
  if (!Array.isArray(references)) return [];
  return references
    .map((reference) => closingPullRequestReferenceTarget(reference))
    .filter((reference): reference is ClosingPullRequestReference => reference !== null);
}

function closingPullRequestsForIssue(number: number): unknown[] {
  const pullRequests: unknown[] = [];
  for (const reference of closingPullRequestReferencesForIssue(number)) {
    try {
      const pull = asRecord(
        ghJson<unknown>([
          "api",
          `repos/${reference.repo}/pulls/${reference.number}`,
          "--jq",
          "{number,title,state,html_url,body,user:{login:.user.login},merged:.merged,merged_at:.merged_at,merge_commit_sha:.merge_commit_sha,head:{ref:.head.ref,sha:.head.sha},base:{ref:.base.ref,sha:.base.sha}}",
        ]),
      );
      pullRequests.push({ ...pull, repo: reference.repo });
    } catch (error) {
      if (!isGitHubNotFoundError(error)) throw error;
      console.error(
        `Skipping missing closing PR ${reference.repo}#${reference.number} for #${number}`,
      );
    }
  }
  return pullRequests;
}

export function openClosingPullRequestApplyReason(
  pullRequests: readonly unknown[],
  canPairClose?: (number: number, repo?: string) => boolean,
): string | null {
  const openPulls = pullRequests
    .map(asRecord)
    .filter((pull) => typeof pull.state === "string" && pull.state.toLowerCase() === "open")
    .map((pull) => ({
      number: typeof pull.number === "number" ? pull.number : null,
      repo: typeof pull.repo === "string" ? pull.repo : undefined,
      title: typeof pull.title === "string" ? pull.title : "",
    }))
    .filter(
      (pull): pull is { number: number; repo: string | undefined; title: string } =>
        pull.number !== null,
    )
    .filter((pull) => !canPairClose?.(pull.number, pull.repo));
  const first = openPulls[0];
  if (!first) return null;
  const suffix = openPulls.length > 1 ? ` and ${openPulls.length - 1} other open PR(s)` : "";
  return `open PR #${first.number}${first.title ? ` (${first.title})` : ""} is a closing reference${suffix}`;
}

const relatedContext = createRelatedContext({
  root: ROOT,
  targetRepo,
  reportUrl,
  defaultItemsDir,
  defaultClosedDir,
  isMarkdownForActiveRepo,
  gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
  ghJson,
  ghJsonOnce,
  asRecord,
  login,
  compactIssue,
  compactPullRequest,
  envFlagEnabled,
  envFlagDisabled,
  frontMatterValue,
  reviewSectionValue,
  effectiveReviewStatus,
  displayTitle: (title) => displayTitle(title),
  markdownFiles,
  numberForMarkdownFile,
  repoRelativePath,
});
export const {
  compactReferencingMergedPullRequestForTest,
  referencingMergedPullRequestCandidatesForTest,
  referencingMergedPullRequestsForIssueForTest,
  relatedGitHubIssueSearchQueryForTest,
  relatedTitleSearchTerms,
} = relatedContext;
const {
  isDigitsOnly,
  quoteGitHubSearchTerm,
  referencingMergedPullRequestsForIssue,
  refreshRelatedItemsContext,
  relatedItemsContext,
  structuralExternalRelationSensitivity,
} = relatedContext;

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envFlagDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

export function unconfirmedProductDirectionCloseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED);
}

export function unsponsoredFeatureCloseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED);
}

export function authorPrBudgetCloseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED);
}

export function staleVersionBugCloseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED);
}

export function obsoleteFixPrCloseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED);
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function authorPrBudget(env: Record<string, string | undefined> = process.env): number {
  return positiveIntegerEnv(env.CLAWSWEEPER_AUTHOR_PR_BUDGET, DEFAULT_AUTHOR_PR_BUDGET);
}

export function authorPrBudgetMaxClosesPerRun(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntegerEnv(
    env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
    DEFAULT_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
  );
}

export function bulkFilerThreshold(env: Record<string, string | undefined> = process.env): number {
  return positiveIntegerEnv(env.CLAWSWEEPER_BULK_FILER_THRESHOLD, DEFAULT_BULK_FILER_THRESHOLD);
}

export function bulkFilerWindowDays(env: Record<string, string | undefined> = process.env): number {
  return positiveIntegerEnv(env.CLAWSWEEPER_BULK_FILER_WINDOW_DAYS, DEFAULT_BULK_FILER_WINDOW_DAYS);
}

function detectBulkFiler(options: BulkFilerDetectionOptions): BulkFilerDetectionResult {
  if (options.item.kind !== "issue" || !options.item.author.trim()) {
    return { context: null, labelPending: false, labelApplied: false };
  }
  if (isBulkFilerExemptAuthorAssociation(options.item.authorAssociation)) {
    return { context: null, labelPending: false, labelApplied: false };
  }
  const windowDays = bulkFilerWindowDays(options.env);
  const windowStartMs = options.now - windowDays * DAY_MS;
  const itemCreatedAtMs = Date.parse(options.item.createdAt);
  if (!Number.isFinite(itemCreatedAtMs) || itemCreatedAtMs <= windowStartMs) {
    return { context: null, labelPending: false, labelApplied: false };
  }
  const threshold = bulkFilerThreshold(options.env);
  const windowStart = new Date(windowStartMs).toISOString();
  const cacheKey = options.item.author.trim().toLowerCase();
  let issueCount = options.cache.get(cacheKey);
  if (!options.cache.has(cacheKey)) {
    try {
      const searchedCount = options.searchCount({
        author: options.item.author,
        windowStart,
      });
      if (!Number.isInteger(searchedCount) || searchedCount < 0) {
        throw new Error("GitHub bulk-filer search omitted a valid total_count");
      }
      issueCount = searchedCount;
    } catch (error) {
      issueCount = null;
      options.onSearchError?.(error);
    }
    options.cache.set(cacheKey, issueCount ?? null);
  }
  if (issueCount === undefined || issueCount === null || issueCount < threshold) {
    return { context: null, labelPending: false, labelApplied: false };
  }
  const alreadyLabeled = options.item.labels.some(
    (label) => label.toLowerCase() === BULK_FILED_LABEL,
  );
  return {
    context: {
      detected: true,
      issueCount,
      threshold,
      windowDays,
      windowStart,
      label: BULK_FILED_LABEL,
    },
    labelPending: !alreadyLabeled,
    labelApplied: false,
  };
}

export function detectBulkFilerForTest(
  options: BulkFilerDetectionOptions,
): BulkFilerDetectionResult {
  return detectBulkFiler(options);
}

function updateBulkFilerDetectedFrontMatter(
  markdown: string,
  detection: BulkFilerDetectionResult,
): string {
  return replaceFrontMatterValue(
    markdown,
    "bulk_filer_detected",
    String(detection.context?.detected === true),
  );
}

export function updateBulkFilerDetectedFrontMatterForTest(
  markdown: string,
  detection: BulkFilerDetectionResult,
): string {
  return updateBulkFilerDetectedFrontMatter(markdown, detection);
}

function bulkFilerPolicyInvalidatesCachedReview(
  markdown: string | null,
  exemptionApplied: boolean,
): boolean {
  if (!exemptionApplied || markdown === null) return false;
  // Legacy reports predate this field. Refresh them once rather than preserving
  // a possibly bulk-filer-suppressed cached verdict under the new exemption.
  return !/^false$/i.test(frontMatterValue(markdown, "last_full_review_bulk_filer_detected") ?? "");
}

export function bulkFilerPolicyInvalidatesCachedReviewForTest(
  markdown: string | null,
  exemptionApplied: boolean,
): boolean {
  return bulkFilerPolicyInvalidatesCachedReview(markdown, exemptionApplied);
}

function authorIssueCountInBulkFilerWindow(author: string, windowStart: string): number {
  const query = [
    `repo:${targetRepo()}`,
    "type:issue",
    `author:${quoteGitHubSearchTerm(author)}`,
    `created:>${windowStart}`,
  ].join(" ");
  const result = ghJsonOnce<{ total_count?: number; incomplete_results?: boolean }>(
    ["api", "search/issues", "--method", "GET", "-f", `q=${query}`, "-f", "per_page=1"],
    BULK_FILER_SEARCH_TIMEOUT_MS,
  );
  if (result.incomplete_results === true) {
    throw new Error("GitHub bulk-filer search returned incomplete results");
  }
  if (!Number.isInteger(result.total_count) || Number(result.total_count) < 0) {
    throw new Error("GitHub bulk-filer search omitted a valid total_count");
  }
  return Number(result.total_count);
}

function bulkFilerRepositoryPermission(
  author: string,
  cache: BulkFilerRepositoryPermissionCache,
): string | null {
  const normalizedAuthor = author.trim().toLowerCase();
  if (!normalizedAuthor) return null;
  if (cache.has(normalizedAuthor)) return cache.get(normalizedAuthor) ?? null;
  let permission: string | null = null;
  try {
    const result = ghJson<{
      permission?: unknown;
      role_name?: unknown;
      user?: { role_name?: unknown };
    }>([
      "api",
      `repos/${targetRepo()}/collaborators/${encodeURIComponent(normalizedAuthor)}/permission`,
    ]);
    const roleName = result.role_name ?? result.user?.role_name;
    permission =
      typeof roleName === "string"
        ? roleName.toLowerCase()
        : typeof result.permission === "string"
          ? result.permission.toLowerCase()
          : null;
  } catch {
    // A read-token lookup failure must not broaden the exemption.
    permission = null;
  }
  cache.set(normalizedAuthor, permission);
  return permission;
}

function normalizeAuthorLogin(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function relatedCounterpartInfo(value: unknown): {
  number: number | null;
  kind: ItemKind | null;
  author: string | null;
  state: string;
  title: string;
} {
  const record = asRecord(value);
  const localReport = asRecord(record.localReport);
  if (Object.keys(localReport).length > 0) {
    const kind =
      localReport.kind === "issue" || localReport.kind === "pull_request" ? localReport.kind : null;
    return {
      number: typeof localReport.number === "number" ? localReport.number : null,
      kind,
      author: normalizeAuthorLogin(localReport.author),
      state: localReport.location === "items" ? "open" : "closed",
      title: typeof localReport.title === "string" ? localReport.title : "",
    };
  }

  const issue = asRecord(record.issue);
  const pullRequest = asRecord(record.pullRequest);
  const isPullRequest = Object.keys(pullRequest).length > 0;
  const state = isPullRequest ? pullRequest.state : issue.state;
  return {
    number: typeof issue.number === "number" ? issue.number : null,
    kind: isPullRequest ? "pull_request" : "issue",
    author: normalizeAuthorLogin(isPullRequest ? pullRequest.author : issue.author),
    state: typeof state === "string" ? state.toLowerCase() : "",
    title: typeof issue.title === "string" ? issue.title : "",
  };
}

function itemKindLabel(kind: ItemKind): string {
  return kind === "pull_request" ? "PR" : "issue";
}

function pairCloseKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function sameAuthorCounterpartApplyReason(
  item: Pick<Item, "number" | "kind" | "author">,
  relatedItems: readonly unknown[],
  canPairClose?: (number: number, kind: ItemKind) => boolean,
): string | null {
  const itemAuthor = normalizeAuthorLogin(item.author);
  if (!itemAuthor) return null;
  for (const relatedItem of relatedItems) {
    const related = relatedCounterpartInfo(relatedItem);
    if (related.number === null || related.number === item.number) continue;
    if (!related.kind || related.kind === item.kind) continue;
    if (related.state !== "open") continue;
    if (related.author !== itemAuthor) continue;
    if (canPairClose?.(related.number, related.kind)) continue;
    return `open ${itemKindLabel(related.kind)} #${related.number}${related.title ? ` (${related.title})` : ""} by the same author is paired with this ${itemKindLabel(item.kind)}`;
  }
  return null;
}

function compactPullFile(value: unknown): unknown {
  const file = asRecord(value);
  return {
    filename: file.filename,
    previous_filename: file.previous_filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: truncateText(file.patch, 2000),
  };
}

function compactSemanticPullFile(value: unknown): unknown {
  const file = asRecord(value);
  return {
    filename: file.filename,
    previous_filename: file.previous_filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: truncateText(file.patch, 512 * 1024),
  };
}

function normalizedPullFileStatus(value: unknown): string {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "m" || status === "modified" || status === "changed") return "modified";
  if (status === "a" || status === "added") return "added";
  if (status === "d" || status === "deleted" || status === "removed") return "deleted";
  if (status.startsWith("r") || status === "renamed") return "renamed";
  if (status.startsWith("c") || status === "copied") return "copied";
  return status;
}

function gitCommitExists(targetDir: string, sha: string): boolean {
  try {
    run("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: targetDir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

function ensureReviewTreeCommit(options: {
  targetDir: string;
  sha: string;
  sourceRef: string;
  destinationRef: string;
}): boolean {
  if (!/^[0-9a-f]{40}$/i.test(options.sha)) return false;
  if (gitCommitExists(options.targetDir, options.sha)) return true;
  try {
    run(
      "git",
      [
        "fetch",
        "--force",
        "--filter=blob:none",
        "origin",
        `${options.sourceRef}:${options.destinationRef}`,
        "--depth=1",
      ],
      { cwd: options.targetDir },
    );
  } catch {
    return false;
  }
  return gitCommitExists(options.targetDir, options.sha);
}

function gitTreeEntry(
  targetDir: string,
  sha: string,
  path: string,
): GitTreeEntry | null | undefined {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r")) return undefined;
  const result = spawnSync("git", ["ls-tree", "-z", sha, "--", path], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  if (!result.stdout) return null;
  if (!result.stdout.endsWith("\0")) return undefined;
  const entry = result.stdout.slice(0, -1);
  if (entry.includes("\0")) return undefined;
  const match = entry.match(/^([0-7]{6}) (blob|tree|commit) [0-9a-f]{40,64}\t(.*)$/s);
  if (!match || match[3] !== path) return undefined;
  return { mode: match[1]!, type: match[2]! };
}

function pullFileTreeIdentity(options: {
  file: unknown;
  targetDir: string;
  baseSha: string;
  headSha: string;
}): Record<string, unknown> {
  const file = asRecord(options.file);
  const filename = stringOrUndefined(file.filename) ?? "";
  const previousFilename = stringOrUndefined(file.previous_filename) ?? "";
  const status = normalizedPullFileStatus(file.status);
  if (!filename) return { treeModesComplete: false };
  const basePath = status === "added" ? null : previousFilename || filename;
  const headPath = status === "deleted" ? null : filename;
  const baseEntry = basePath ? gitTreeEntry(options.targetDir, options.baseSha, basePath) : null;
  const headEntry = headPath ? gitTreeEntry(options.targetDir, options.headSha, headPath) : null;
  const treeModesComplete =
    baseEntry !== undefined &&
    headEntry !== undefined &&
    ((status === "added" && baseEntry === null && headEntry !== null) ||
      (status === "deleted" && baseEntry !== null && headEntry === null) ||
      ((status === "modified" || status === "renamed" || status === "copied") &&
        baseEntry !== null &&
        headEntry !== null));
  return {
    baseMode: baseEntry?.mode ?? null,
    baseType: baseEntry?.type ?? null,
    headMode: headEntry?.mode ?? null,
    headType: headEntry?.type ?? null,
    treeModesComplete,
  };
}

function semanticPullFilesWithTreeIdentity(options: {
  files: readonly unknown[];
  itemNumber: number;
  pullRequest: unknown;
  targetDir: string;
}): unknown[] {
  const pull = asRecord(options.pullRequest);
  const base = asRecord(pull.base);
  const head = asRecord(pull.head);
  const baseSha = stringOrUndefined(base.sha) ?? "";
  const headSha = stringOrUndefined(head.sha) ?? "";
  const baseRef = stringOrUndefined(base.ref) ?? "";
  const commitsAvailable =
    isSafeGitBranchName(baseRef) &&
    ensureReviewTreeCommit({
      targetDir: options.targetDir,
      sha: baseSha,
      sourceRef: `refs/heads/${baseRef}`,
      destinationRef: `refs/clawsweeper/review-cache/base-${options.itemNumber}`,
    }) &&
    ensureReviewTreeCommit({
      targetDir: options.targetDir,
      sha: headSha,
      sourceRef: `refs/pull/${options.itemNumber}/head`,
      destinationRef: `refs/clawsweeper/review-cache/head-${options.itemNumber}`,
    });

  if (commitsAvailable) {
    const hydration = hydratePullRequestReviewBlobs({
      targetDir: options.targetDir,
      baseSha,
      headSha,
      files: options.files,
      resolveBlobSizes: (objectIds) =>
        githubReviewBlobSizes({
          repository: targetRepo(),
          objectIds,
          request: (query) => ghJson(["api", "graphql", "-f", `query=${query}`]),
        }),
    });
    if (!hydration.hydrated) {
      console.warn("pull-request review blobs could not be hydrated before restricted review");
    }
  }

  return options.files.map((value) => {
    const compact = asRecord(compactSemanticPullFile(value));
    if (!commitsAvailable) return { ...compact, treeModesComplete: false };
    return {
      ...compact,
      ...pullFileTreeIdentity({
        file: value,
        targetDir: options.targetDir,
        baseSha,
        headSha,
      }),
    };
  });
}

function compactPullFilePaths(value: unknown): string[] {
  const file = asRecord(value);
  return [file.filename, file.previous_filename].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
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

function collectItemContext(
  item: Item,
  options: {
    fullTimelineForRelations?: boolean;
    reviewCacheDigest?: boolean;
    reviewCacheGitDir?: string;
  } = {},
): ItemContext {
  const issue = ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${item.number}`]);
  const issueRecord = asRecord(issue);
  const commentsWindow = ghPagedContextWindow<unknown>(
    `repos/${targetRepo()}/issues/${item.number}/comments`,
    issueRecord.comments,
    24,
  );
  const comments = commentsWindow.items;
  const sourceRevisionComments = commentsWindow.truncated
    ? ghPaged<unknown>(`repos/${targetRepo()}/issues/${item.number}/comments`)
    : comments;
  const filteredComments = filterReviewContextComments(comments, item.number);
  const previousClawSweeperReview = extractLatestClawSweeperReviewFromHydration(
    commentsWindow,
    sourceRevisionComments,
    item.number,
  );
  const timelineWindow = ghPagedLinkHeaderContextWindow<unknown>(
    `repos/${targetRepo()}/issues/${item.number}/timeline`,
    80,
  );
  const timeline = timelineWindow.items;
  const fullTimeline =
    timelineWindow.truncated && (options.fullTimelineForRelations || options.reviewCacheDigest)
      ? ghPaged<unknown>(`repos/${targetRepo()}/issues/${item.number}/timeline`)
      : null;
  const context: ItemContext = {
    issue: compactIssue(issue),
    sourceRevision: itemSourceRevisionSha256(issue, sourceRevisionComments),
    comments: compactMappedWindow(
      filteredComments.included,
      filteredComments.included.length,
      24,
      compactComment,
    ),
    timeline: compactMappedWindow(timeline, timelineWindow.total, 80, compactTimelineEvent),
    goodFirstIssueHumanLabelState: goodFirstIssueHumanLabelState(fullTimeline ?? timeline),
    counts: {
      comments: commentsWindow.total,
      commentsHydrated: commentsWindow.hydrated,
      commentsTruncated: commentsWindow.truncated,
      commentsIncluded: filteredComments.included.length,
      commentsFiltered: filteredComments.filtered,
      timeline: timelineWindow.total,
      timelineHydrated: timelineWindow.hydrated,
      timelineTruncated: timelineWindow.truncated,
    },
  };
  const structuralItemStateDigest = hydratedReviewStructuralItemStateDigest(
    issue,
    sourceRevisionComments,
  );
  if (structuralItemStateDigest) {
    context.structuralItemStateDigest = structuralItemStateDigest;
  }
  if (options.reviewCacheDigest) {
    context.timelineRevision = sha256(
      stableJson(reviewTimelineDigestParts((fullTimeline ?? timeline).map(compactTimelineEvent))),
    );
  }
  if (previousClawSweeperReview) context.previousClawSweeperReview = previousClawSweeperReview;
  let pullRequest: unknown = null;
  let pullReviewComments: unknown[] | null = null;
  let filteredPullReviewComments: { included: unknown[]; filtered: number } | null = null;
  let digestPullReviewComments: { included: unknown[]; filtered: number } | null = null;
  let completePullReviewComments: { included: unknown[]; filtered: number } | null = null;
  let completePullReviewCommentsHydrated = item.kind !== "pull_request";
  if (item.kind === "issue") {
    const closingPullRequests = closingPullRequestsForIssue(item.number);
    if (closingPullRequests.length > 0) {
      context.closingPullRequests = compactMappedSlice(closingPullRequests, 12, compactPullRequest);
      context.counts = {
        ...context.counts,
        comments: commentsWindow.total,
        commentsHydrated: commentsWindow.hydrated,
        commentsTruncated: commentsWindow.truncated,
        commentsIncluded: filteredComments.included.length,
        commentsFiltered: filteredComments.filtered,
        timeline: timelineWindow.total,
        timelineHydrated: timelineWindow.hydrated,
        timelineTruncated: timelineWindow.truncated,
        closingPullRequests: closingPullRequests.length,
      };
    } else {
      const referencingPRs = referencingMergedPullRequestsForIssue(item.number);
      if (referencingPRs.length > 0) {
        context.referencingMergedPullRequests = referencingPRs.slice(0, 10);
        context.counts = {
          ...context.counts!,
          referencingMergedPullRequests: referencingPRs.length,
        };
      }
    }
  }
  if (item.kind === "pull_request") {
    pullRequest = ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${item.number}`]);
    const pullRecord = asRecord(pullRequest);
    const pullFilesWindow = ghPagedContextWindow<unknown>(
      `repos/${targetRepo()}/pulls/${item.number}/files`,
      pullRecord.changed_files,
      80,
    );
    const pullFiles = pullFilesWindow.items;
    const pullCommitsWindow = ghPagedContextWindow<unknown>(
      `repos/${targetRepo()}/pulls/${item.number}/commits`,
      pullRecord.commits,
      80,
    );
    const pullCommits = pullCommitsWindow.items;
    const pullReviewCommentsWindow = ghPagedContextWindow<unknown>(
      `repos/${targetRepo()}/pulls/${item.number}/comments`,
      pullRecord.review_comments,
      40,
    );
    pullReviewComments = pullReviewCommentsWindow.items;
    filteredPullReviewComments = filterReviewContextComments(pullReviewComments, item.number);
    const fullPullReviewComments =
      (options.reviewCacheDigest || options.fullTimelineForRelations) &&
      pullReviewCommentsWindow.truncated
        ? ghPaged<unknown>(`repos/${targetRepo()}/pulls/${item.number}/comments`)
        : pullReviewComments;
    digestPullReviewComments =
      !options.reviewCacheDigest || fullPullReviewComments === pullReviewComments
        ? filteredPullReviewComments
        : filterReviewContextComments(fullPullReviewComments, item.number);
    completePullReviewComments =
      fullPullReviewComments === pullReviewComments
        ? filteredPullReviewComments
        : filterReviewContextComments(fullPullReviewComments, item.number);
    completePullReviewCommentsHydrated =
      fullPullReviewComments.length >= pullReviewCommentsWindow.total;
    context.pullRequest = compactPullRequest(pullRequest);
    context.pullFiles = compactMappedWindow(pullFiles, pullFilesWindow.total, 80, compactPullFile);
    context.semanticPullFiles =
      options.reviewCacheDigest &&
      options.reviewCacheGitDir &&
      !pullFilesWindow.truncated &&
      pullFilesWindow.total === pullFiles.length
        ? semanticPullFilesWithTreeIdentity({
            files: pullFiles,
            itemNumber: item.number,
            pullRequest,
            targetDir: options.reviewCacheGitDir,
          })
        : compactMappedWindow(pullFiles, pullFilesWindow.total, 80, (file) => ({
            ...asRecord(compactSemanticPullFile(file)),
            treeModesComplete: false,
          }));
    context.pullCommits = compactMappedWindow(
      pullCommits,
      pullCommitsWindow.total,
      80,
      compactPullCommit,
    );
    if (
      options.reviewCacheDigest &&
      !pullCommitsWindow.truncated &&
      pullCommitsWindow.total === pullCommits.length
    ) {
      const pullCommitsRevision = pullCommitContentRevision(pullCommits);
      if (pullCommitsRevision) context.pullCommitsRevision = pullCommitsRevision;
    }
    context.pullReviewComments = compactMappedWindow(
      filteredPullReviewComments.included,
      filteredPullReviewComments.included.length,
      40,
      compactComment,
    );
    if (options.reviewCacheDigest) {
      context.pullReviewCommentsRevision = reviewCommentContentRevision(
        digestPullReviewComments.included.map(compactComment),
      );
      const pullReviewActivityCursor = fetchReviewedPrActivityCursor(
        item.number,
        fullPullReviewComments,
      );
      if (pullReviewActivityCursor) context.pullReviewActivityCursor = pullReviewActivityCursor;
      const headSha = stringOrUndefined(asRecord(pullRecord.head).sha);
      context.pullChecks = headSha
        ? pullChecksContext(item.number, headSha)
        : {
            complete: false,
            checkRuns: [],
            checkRunsTruncated: true,
            statuses: [],
            statusesTruncated: true,
          };
    }
    context.counts = {
      ...context.counts,
      comments: commentsWindow.total,
      commentsHydrated: commentsWindow.hydrated,
      commentsTruncated: commentsWindow.truncated,
      commentsIncluded: filteredComments.included.length,
      commentsFiltered: filteredComments.filtered,
      timeline: timelineWindow.total,
      timelineHydrated: timelineWindow.hydrated,
      timelineTruncated: timelineWindow.truncated,
      pullFiles: pullFilesWindow.total,
      pullFilesHydrated: pullFilesWindow.hydrated,
      pullFilesTruncated: pullFilesWindow.truncated,
      pullCommits: pullCommitsWindow.total,
      pullCommitsHydrated: pullCommitsWindow.hydrated,
      pullCommitsTruncated: pullCommitsWindow.truncated,
      pullReviewComments: pullReviewCommentsWindow.total,
      pullReviewCommentsHydrated: pullReviewCommentsWindow.hydrated,
      pullReviewCommentsTruncated: pullReviewCommentsWindow.truncated,
      pullReviewCommentsIncluded: filteredPullReviewComments.included.length,
      pullReviewCommentsFiltered: filteredPullReviewComments.filtered,
    };
  }
  const relationTimeline = fullTimeline ?? timeline;
  const relatedOptions: Parameters<typeof relatedItemsContext>[0] = {
    item,
    issue,
    comments: filteredComments.included,
    timeline: relationTimeline,
  };
  if (pullRequest) relatedOptions.pullRequest = pullRequest;
  const relatedPullReviewComments = digestPullReviewComments ?? filteredPullReviewComments;
  if (relatedPullReviewComments)
    relatedOptions.pullReviewComments = relatedPullReviewComments.included;
  const relatedItems = relatedItemsContext(relatedOptions);
  if (relatedItems.length) {
    context.relatedItems = relatedItems;
    const counts: NonNullable<ItemContext["counts"]> = {
      comments: context.counts?.comments ?? commentsWindow.total,
      commentsHydrated: context.counts?.commentsHydrated ?? commentsWindow.hydrated,
      commentsTruncated: context.counts?.commentsTruncated ?? commentsWindow.truncated,
      commentsIncluded: filteredComments.included.length,
      commentsFiltered: filteredComments.filtered,
      timeline: context.counts?.timeline ?? timeline.length,
      relatedItems: relatedItems.length,
    };
    if (context.counts?.timelineHydrated !== undefined)
      counts.timelineHydrated = context.counts.timelineHydrated;
    if (context.counts?.timelineTruncated !== undefined)
      counts.timelineTruncated = context.counts.timelineTruncated;
    if (context.counts?.pullFiles !== undefined) counts.pullFiles = context.counts.pullFiles;
    if (context.counts?.pullFilesHydrated !== undefined)
      counts.pullFilesHydrated = context.counts.pullFilesHydrated;
    if (context.counts?.pullFilesTruncated !== undefined)
      counts.pullFilesTruncated = context.counts.pullFilesTruncated;
    if (context.counts?.pullCommits !== undefined) counts.pullCommits = context.counts.pullCommits;
    if (context.counts?.pullCommitsHydrated !== undefined)
      counts.pullCommitsHydrated = context.counts.pullCommitsHydrated;
    if (context.counts?.pullCommitsTruncated !== undefined)
      counts.pullCommitsTruncated = context.counts.pullCommitsTruncated;
    if (context.counts?.pullReviewComments !== undefined)
      counts.pullReviewComments = context.counts.pullReviewComments;
    if (context.counts?.pullReviewCommentsHydrated !== undefined)
      counts.pullReviewCommentsHydrated = context.counts.pullReviewCommentsHydrated;
    if (context.counts?.pullReviewCommentsTruncated !== undefined)
      counts.pullReviewCommentsTruncated = context.counts.pullReviewCommentsTruncated;
    if (context.counts?.pullReviewCommentsIncluded !== undefined)
      counts.pullReviewCommentsIncluded = context.counts.pullReviewCommentsIncluded;
    if (context.counts?.pullReviewCommentsFiltered !== undefined)
      counts.pullReviewCommentsFiltered = context.counts.pullReviewCommentsFiltered;
    if (context.counts?.closingPullRequests !== undefined)
      counts.closingPullRequests = context.counts.closingPullRequests;
    context.counts = counts;
  }
  const completeActivityHydrated =
    sourceRevisionComments.length >= commentsWindow.total &&
    (fullTimeline ?? timeline).length >= timelineWindow.total &&
    completePullReviewCommentsHydrated;
  if (options.fullTimelineForRelations && completeActivityHydrated) {
    context[completeActivityContextSymbol] = {
      comments: filterReviewContextComments(sourceRevisionComments, item.number).included.map(
        compactComment,
      ),
      timeline: (fullTimeline ?? timeline).map(compactTimelineEvent),
      pullReviewComments: (completePullReviewComments?.included ?? []).map(compactComment),
    };
  }
  return context;
}

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
  publicTableCell,
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

function closeIntro(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "Thanks for the context here. I did a careful shell check against current `main`, and this is already implemented.";
    case "mostly_implemented_on_main":
      return "Thanks for the context here. I did a careful shell check against current `main`, and the useful part of this older PR is already implemented there.";
    case "cannot_reproduce":
      return "Thanks for the report. I gave this a fresh shell check against current `main`, and I could not reproduce it anymore.";
    case "clawhub":
      return `Thanks for the idea. I checked the current extension path, and this is a better fit for ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} than OpenClaw core.`;
    case "duplicate_or_superseded":
      return "Thanks for the context here. I swept through the related work, and this is now duplicate or superseded.";
    case "low_signal_unmergeable_pr":
      return "Thanks for the contribution. I reviewed the branch, and this PR is not a good landing base for OpenClaw.";
    case "stalled_unproven_pr":
      return "Thanks for the contribution. This PR still needs the requested real-behavior proof, and the branch has been idle since that ask.";
    case "abandoned_pr":
      return "Thanks for the contribution. This PR has been inactive for a while and still is not in a landable state.";
    case "unconfirmed_product_direction":
      return "Thanks for the contribution. ClawSweeper proposes closing this for now: the implementation may be reasonable, but passing review and proof does not establish that OpenClaw should add this product surface.";
    case "unsponsored_feature_request":
      return "Thanks for sharing this idea. ClawSweeper is parking it in the idea archive because no maintainer has confirmed this product direction yet.";
    case "author_pr_budget_exceeded":
      return "Thanks for the contribution. ClawSweeper is trimming this lowest-signal PR because the author is over the repository's open-PR budget.";
    case "stale_version_bug":
      return "Thanks for the report. This was filed against an older version, and the relevant code has changed substantially since then.";
    case "obsolete_fix_pr":
      return "Thanks for the contribution. The target code has since been rewritten or removed on `main`, so this fix no longer applies in its original form.";
    case "not_actionable_in_repo":
      return "Thanks for writing this up. I checked the repo boundary, and this lives outside the OpenClaw source shell.";
    case "incoherent":
      return "Thanks for the note. I could not crack enough detail here to turn it into a concrete OpenClaw code or docs action.";
    case "stale_insufficient_info":
      return "Thanks for the report. I checked current `main`, but this shell is missing enough reproduction detail to verify a current bug.";
    case "none":
      return "Thanks for the context here. I checked this with Codex and am closing it based on the evidence below.";
  }
}

function closeOutro(reason: CloseReason, canonicalLinks: string[] = []): string {
  switch (reason) {
    case "implemented_on_main":
      return "So I’m closing this as already implemented rather than keeping a duplicate issue open.";
    case "mostly_implemented_on_main":
      return "So I’m closing this older PR as already covered on `main` rather than keeping a mostly-duplicated branch open.";
    case "clawhub":
      return `So I’m closing this as a scope-fit item for the plugin/community path. Please upload or publish it through ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} so it can live as an installable ClawHub package instead of a bundled OpenClaw core change.`;
    case "duplicate_or_superseded":
      return canonicalLinks.length
        ? `So I’m closing this here and keeping the remaining discussion on ${formatCanonicalLinks(canonicalLinks)}.`
        : "So I’m closing this here because the remaining work is already tracked in the canonical issue.";
    case "low_signal_unmergeable_pr":
      return "So I’m closing this PR rather than keeping an unmergeable branch open. A new narrow PR that carries only the useful part is welcome.";
    case "stalled_unproven_pr":
      return "So I’m closing this for now to keep the review queue honest. Please reopen or open a fresh PR with real-behavior proof (a live run, logs, or a reproducible validation transcript) and it will be reviewed again.";
    case "abandoned_pr":
      return "So I’m closing this as inactive for now. If you pick the work back up, push a rebased branch with green checks and reopen (or open a fresh PR) and it will be reviewed again.";
    case "unconfirmed_product_direction":
      return "This is a proposal only until the separate default-off apply policy is enabled and all live maintainer-signal checks pass. A maintainer can sponsor the direction, request a narrower version, or apply `clawsweeper:human-review` to keep it open.";
    case "unsponsored_feature_request":
      return `This idea is parked, not rejected. A maintainer can comment \`@clawsweeper revive\` on this closed issue to bring it back automatically. It will also reopen when it reaches at least ${ideaRevivalReactionThreshold()} positive reactions (thumbs-up, heart, or hooray). When the idea fits an extension, ${markdownLink("ClawHub.com", targetProfile().communityUrl ?? "https://clawhub.ai/")} remains the self-serve path.`;
    case "author_pr_budget_exceeded":
      return "Closing or finishing other open PRs frees review budget. This PR can be reopened once the author is under budget, or sooner when real behavior proof is added.";
    case "stale_version_bug":
      return "Please retest on the current release. If the problem still reproduces, add a fresh reproduction with the current version and this issue will be reopened.";
    case "obsolete_fix_pr":
      return "If the original problem still reproduces on current `main`, a fresh PR against the current code is very welcome.";
    case "not_actionable_in_repo":
      return "So I’m closing this as outside the OpenClaw source repository rather than keeping it open as core work.";
    default:
      return "";
  }
}

function closeClawHubHandoffBlock(reason: CloseReason): string {
  if (reason !== "clawhub") return "";
  return [
    "If you want to carry this forward, package it as a self-serve ClawHub item rather than a core patch:",
    "",
    "- Scope: choose the smallest skill, plugin, provider, channel, bundle, or MCP integration that matches the requested capability.",
    "- Checklist: include package metadata/manifest, entrypoint, required permissions, secrets/config notes, install/update docs, example usage, and a smoke test or proof command.",
    "- Boundary: ClawSweeper will not open a ClawHub issue or PR, create a tracking issue, or publish the package automatically; the contributor should create that ClawHub work separately.",
  ].join("\n");
}

function issueOrPullReferenceNumbers(value: string): string[] {
  return [
    ...value.matchAll(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/(\d+)|#(\d+)\b/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? "");
}

function issueOrPullReferenceUrls(value: string): string[] {
  return [
    ...value.matchAll(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+/g,
    ),
  ].map((match) => match[0]);
}

function itemPublicUrl(item?: { repo?: string; kind?: ItemKind; number?: number }): string {
  if (!item?.number || !Number.isInteger(item.number) || item.number <= 0) return "";
  return repoUrlFor(
    item.repo ?? targetRepo(),
    `/${item.kind === "pull_request" ? "pull" : "issues"}/${item.number}`,
  );
}

function addsIssueOrPullReference(candidate: string, summaryLine: string): boolean {
  const summaryRefs = new Set(issueOrPullReferenceNumbers(summaryLine));
  return issueOrPullReferenceNumbers(candidate).some((ref) => ref && !summaryRefs.has(ref));
}

function duplicateCanonicalTexts(options: {
  reason: CloseReason;
  bestSolutionLine: string;
  evidence: Evidence[];
}): string[] {
  if (options.reason !== "duplicate_or_superseded") return [];
  return [
    options.bestSolutionLine,
    ...options.evidence
      .filter((entry) => /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label))
      .map((entry) => sentence(entry.detail)),
  ];
}

function duplicateCanonicalLinkTexts(options: {
  reason: CloseReason;
  bestSolutionLine: string;
  evidence: Evidence[];
}): string[] {
  if (options.reason !== "duplicate_or_superseded") return [];
  return [
    options.bestSolutionLine,
    ...options.evidence
      .filter((entry) => /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label))
      .map((entry) => sentence(entry.detail)),
  ];
}

function duplicateCanonicalLinks(options: {
  reason: CloseReason;
  bestSolutionLine: string;
  evidence: Evidence[];
  currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
}): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const currentItemUrl = itemPublicUrl(options.currentItem);
  for (const text of duplicateCanonicalLinkTexts(options)) {
    for (const link of issueOrPullReferenceUrls(text)) {
      if (link === currentItemUrl) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      links.push(link);
    }
  }
  return links;
}

function duplicateCanonicalPathLine(options: {
  reason: CloseReason;
  summaryLine: string;
  bestSolutionLine: string;
  evidence: Evidence[];
}): string {
  const candidates = duplicateCanonicalTexts(options);
  const canonical =
    candidates.find(
      (candidate) => candidate && addsIssueOrPullReference(candidate, options.summaryLine),
    ) ??
    candidates.find(
      (candidate) => candidate && publicReviewTextDiffers(candidate, options.summaryLine),
    );
  return canonical ? `Canonical path: ${canonical}` : "";
}

function formatCanonicalLinks(links: string[]): string {
  if (links.length <= 1) return links[0] ?? "the canonical issue";
  if (links.length === 2) return `${links[0]} and ${links[1]}`;
  return `${links.slice(0, -1).join(", ")}, and ${links[links.length - 1]}`;
}

function pullRequestFilePathsFromReport(markdown: string): string[] {
  return frontMatterStringArray(markdown, "pull_files");
}

function configSurfaceReviewRequired(markdown: string): boolean {
  return (
    frontMatterBoolean(markdown, "config_surface_change") ||
    frontMatterStringArray(markdown, "config_surface_keys").length > 0
  );
}

function dataModelSurfaceReviewRequired(markdown: string): boolean {
  return dataModelSurfaceChangeFromReport(markdown) && !dataModelUpgradeProofFromReport(markdown);
}

function dataModelSurfaceChangeFromReport(markdown: string): boolean {
  return (
    frontMatterBoolean(markdown, "data_model_change") ||
    frontMatterStringArray(markdown, "data_model_surfaces").length > 0
  );
}

function dataModelUpgradeProofFromReport(markdown: string): boolean {
  if (!dataModelSurfaceChangeFromReport(markdown)) return false;
  return hasDataModelUpgradeProof(
    [
      reviewSectionValue(markdown, "realBehaviorProof"),
      reviewSectionValue(markdown, "solutionAssessment"),
      reviewSectionValue(markdown, "evidence"),
    ].join("\n"),
  );
}

function prSurfaceFilesFromContext(context: ItemContext): PrSurfaceFile[] {
  if (context.counts?.pullFilesTruncated) return [];
  return (context.pullFiles ?? [])
    .map((entry) => {
      const file = asRecord(entry);
      const path = typeof file.filename === "string" ? file.filename.trim() : "";
      if (!path) return null;
      return {
        path,
        additions: nonNegativeInteger(file.additions),
        deletions: nonNegativeInteger(file.deletions),
      };
    })
    .filter((entry): entry is PrSurfaceFile => Boolean(entry));
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function prSurfaceFilesFromReport(markdown: string): PrSurfaceFile[] {
  if (frontMatterBoolean(markdown, "pr_surface_files_truncated")) return [];
  return frontMatterJsonArray(markdown, "pr_surface_files")
    .map((entry) => {
      const file = asRecord(entry);
      const path = typeof file.path === "string" ? file.path.trim() : "";
      if (!path) return null;
      return {
        path,
        additions: nonNegativeInteger(file.additions),
        deletions: nonNegativeInteger(file.deletions),
      };
    })
    .filter((entry): entry is PrSurfaceFile => Boolean(entry));
}

function shouldRenderOpenClawPrSurface(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "type") === "pull_request" &&
    normalizeRepo(markdownRepository(markdown)) === "openclaw/openclaw"
  );
}

function renderOpenClawPrSurfaceFromReport(markdown: string): string {
  if (!shouldRenderOpenClawPrSurface(markdown)) return "";
  const files = prSurfaceFilesFromReport(markdown);
  if (files.length === 0) return "";
  const stats = buildOpenClawPrSurfaceStats(files);
  const summary = renderOpenClawPrSurfaceSummary(stats);
  if (!summary) return "";
  const details = collapsedDetailsBlock("View PR surface stats", [
    renderOpenClawPrSurfaceTable(stats),
  ]);
  return details ? `${summary}\n\n${details}` : summary;
}

function renderDataModelWarningFromReport(markdown: string): string {
  if (
    frontMatterValue(markdown, "type") !== "pull_request" ||
    normalizeRepo(markdownRepository(markdown)) !== "openclaw/openclaw" ||
    !dataModelSurfaceChangeFromReport(markdown)
  ) {
    return "";
  }
  const surfaces = frontMatterStringArray(markdown, "data_model_surfaces");
  const surfaceText = surfaces.length
    ? surfaces
        .slice(0, 6)
        .map((surface) => trustedCommentCodeSpan(surface))
        .join(", ")
    : "an unknown persistent surface";
  const overflow = surfaces.length > 6 ? `, and ${surfaces.length - 6} more` : "";
  const proofLine = dataModelUpgradeProofFromReport(markdown)
    ? "Migration or upgrade compatibility proof is recorded; maintainers should verify it before merge."
    : "Confirm migration or upgrade compatibility proof before merge.";
  return `Persistent data-model change detected: ${surfaceText}${overflow}. ${proofLine}`;
}

function trustedCommentCodeSpan(value: string): string {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n|\r/g, " ");
  const longestBacktickRun = Math.max(0, ...(escaped.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${fence}${padding}${escaped}${padding}${fence}`;
}

function reviewMetricsFromReport(markdown: string): ReviewMetric[] {
  return frontMatterJsonArray(markdown, "review_metrics")
    .map((entry) => {
      const metric = asRecord(entry);
      const label = typeof metric.label === "string" ? metric.label.trim() : "";
      const value = typeof metric.value === "string" ? metric.value.trim() : "";
      const reason = typeof metric.reason === "string" ? metric.reason.trim() : "";
      if (!label || !value || !reason) return null;
      return { label, value, reason };
    })
    .filter((entry): entry is ReviewMetric => Boolean(entry));
}

function renderReviewMetricsDigest(metrics: readonly ReviewMetric[]): string {
  if (metrics.length === 0) return "None.";
  return [
    "| Metric | Value | Why it matters |",
    "|---|---|---|",
    ...metrics.map(
      (metric) =>
        `| **${publicTableCell(metric.label)}** | ${publicTableCell(metric.value)} | ${publicTableCell(sentence(metric.reason))} |`,
    ),
  ].join("\n");
}

function isDocsOnlyPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  if (frontMatterBoolean(markdown, "pull_files_truncated")) return false;
  const files = pullRequestFilePathsFromReport(markdown);
  return files.length > 0 && files.every(isDocsPath);
}

const labelSynchronization = createLabelSynchronization({
  ghObservedMutationCommand,
  hasNormalizedLabel,
  normalizeLabelName,
  protectedLabels,
  isBulkFilerExemptAuthorAssociation,
  isBulkFilerExemptRepositoryPermission,
  frontMatterValue,
  frontMatterStringArray,
  reportSecurityReview,
  reviewSectionValue,
  labelPolicy,
});
export const {
  impactLabelSchemeForTest,
  impactLabelsForTest,
  isGitHubLabelAlreadyExistsErrorForTest,
  isGitHubLabelCapacityErrorForTest,
  isMissingGitHubLabelErrorForTest,
  issueAdvisoryLabelsForTest,
  maturityLabelSchemeForTest,
  maturityLabelsForTest,
  mergeRiskLabelSchemeForTest,
  mergeRiskLabelsForTest,
  priorityLabelSchemeForTest,
  priorityLabelsForTest,
  prRatingLabelSchemeForTest,
  prRatingLabelsForTest,
  realBehaviorProofMediaLabelsForTest,
  realBehaviorProofSufficientLabelsForTest,
  syncBulkFilerLabelForTest,
  telegramVisibleProofLabelsForTest,
} = labelSynchronization;
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

function realBehaviorProofBlocksMerge(markdown: string): boolean {
  if (frontMatterValue(markdown, "review_status") === "failed") return false;
  if (!isExternalPullRequestReport(markdown)) return false;
  if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) return false;
  if (isDocsOnlyPullRequestReport(markdown)) return false;
  const proof = reportRealBehaviorProof(markdown);
  return (
    proof.needsContributorAction ||
    proof.status === "missing" ||
    proof.status === "mock_only" ||
    proof.status === "insufficient" ||
    (proof.status !== "sufficient" && proof.status !== "override")
  );
}

function normalizedLabelSet(labels: readonly string[]): Set<string> {
  return new Set(labels.map(normalizeLabelName));
}

function hasNormalizedLabel(labels: readonly string[], label: string): boolean {
  return normalizedLabelSet(labels).has(normalizeLabelName(label));
}

function hasDispatchableMantisScenario(recommendation: MantisRecommendation): boolean {
  return (
    recommendation.status === "recommended" &&
    isSupportedMantisScenario(recommendation.scenario) &&
    Boolean(validMantisMaintainerComment(recommendation))
  );
}

function parseBoldListHeading(line: string): { label: string; detail: string } | null {
  const prefix = "- **";
  if (!line.startsWith(prefix)) return null;
  const delimiter = ":**";
  const delimiterIndex = line.indexOf(delimiter, prefix.length);
  if (delimiterIndex === -1) return null;
  return {
    label: line.slice(prefix.length, delimiterIndex),
    detail: line.slice(delimiterIndex + delimiter.length).trimStart(),
  };
}

function parseReviewFindingHeading(line: string): {
  priority: ReviewFinding["priority"];
  title: string;
  file: string;
  lineStart: number;
  lineEnd: number;
} | null {
  const prefix = "- **[P";
  if (!line.startsWith(prefix)) return null;
  const priority = Number(line[prefix.length]);
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) return null;
  const titleStart = prefix.length + 3;
  if (line.slice(prefix.length + 1, titleStart) !== "] ") return null;
  const titleEnd = line.indexOf(":**", titleStart);
  if (titleEnd === -1) return null;

  const location = parseBacktickLocation(line.slice(titleEnd + 3).trim());
  if (!location) return null;
  return {
    priority: priority as ReviewFinding["priority"],
    title: line.slice(titleStart, titleEnd),
    ...location,
  };
}

function parseSecurityConcernHeading(line: string): {
  severity: SecurityConcernSeverity;
  title: string;
  file: string | null;
  line: number | null;
} | null {
  const prefix = "- **[";
  if (!line.startsWith(prefix)) return null;
  const severityEnd = line.indexOf("] ", prefix.length);
  if (severityEnd === -1) return null;
  const severity = line.slice(prefix.length, severityEnd);
  if (!SECURITY_CONCERN_SEVERITIES.has(severity as SecurityConcernSeverity)) return null;
  const titleStart = severityEnd + 2;
  const titleEnd = line.indexOf(":**", titleStart);
  if (titleEnd === -1) return null;

  const locationText = line.slice(titleEnd + 3).trim();
  const location = locationText ? parseBacktickLocation(locationText) : null;
  return {
    severity: severity as SecurityConcernSeverity,
    title: line.slice(titleStart, titleEnd),
    file: location?.file ?? null,
    line: location?.lineStart ?? null,
  };
}

function parseBacktickLocation(value: string): {
  file: string;
  lineStart: number;
  lineEnd: number;
} | null {
  if (!value.startsWith("`") || !value.endsWith("`")) return null;
  const location = value.slice(1, -1);
  const separator = location.lastIndexOf(":");
  if (separator <= 0) return null;
  const file = location.slice(0, separator);
  const range = parseLineRange(location.slice(separator + 1));
  return range ? { file, ...range } : null;
}

function parseLineRange(value: string): { lineStart: number; lineEnd: number } | null {
  const separator = value.indexOf("-");
  const lineStartText = separator === -1 ? value : value.slice(0, separator);
  const lineEndText = separator === -1 ? value : value.slice(separator + 1);
  if (!isDigitsOnly(lineStartText) || !isDigitsOnly(lineEndText)) return null;
  const lineStart = Number(lineStartText);
  const lineEnd = Number(lineEndText);
  return lineStart > 0 && lineEnd >= lineStart ? { lineStart, lineEnd } : null;
}

function sectionLineValue(section: string, label: string): string | undefined {
  const prefix = `${label}:`;
  for (const line of section.split("\n")) {
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value || undefined;
    }
  }
  return undefined;
}

function sectionList(section: string, label: string): string[] {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${label}:`);
  if (start === -1) return [];
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^[A-Z][A-Za-z -]+:/.test(line)) break;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const item = trimmed.slice(2).trim();
    if (item) values.push(item);
  }
  return values;
}

function workCandidateReasonText(section: string): string {
  const lines = section.split("\n");
  const reasonStart = lines.findIndex((line) => line.startsWith("Reason:"));
  if (reasonStart === -1) return "";

  const reasonLines = [lines[reasonStart]!.slice("Reason:".length).trimStart()];
  for (let index = reasonStart + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextLine = lines[index + 1] ?? "";
    if (
      line.trim() === "" &&
      (nextLine.startsWith("Cluster refs:") ||
        nextLine.startsWith("Likely files:") ||
        nextLine.startsWith("Validation:"))
    ) {
      break;
    }
    reasonLines.push(line);
  }

  return reasonLines.join("\n").trim();
}

function reportDecision(markdown: string, closeReason: CloseReason): Decision {
  const fixedRelease = frontMatterValue(markdown, "fixed_release");
  const fixedSha = frontMatterValue(markdown, "fixed_sha");
  const fixedAt = frontMatterValue(markdown, "fixed_at");
  const kind = frontMatterValue(markdown, "type");
  const triagePriority = triagePriorityFromReport(markdown);
  const impactLabels = kind === "pull_request" ? [] : impactLabelsFromReport(markdown);
  const mergeRiskLabels = mergeRiskLabelsFromReport(markdown);
  const maturityLabels = kind === "pull_request" ? [] : maturityLabelsFromReport(markdown);
  const visionFit = reportVisionFit(markdown);
  return {
    decision: "close",
    closeReason,
    confidence: "high",
    summary: reviewSectionValue(markdown, "summary"),
    changeSummary: reviewSectionValue(markdown, "changeSummary"),
    systemContext: reviewSectionValue(markdown, "systemContext"),
    architectureDiagram: reviewSectionValue(markdown, "architectureDiagram"),
    evidence: reportEvidence(markdown),
    likelyOwners: reportLikelyOwners(markdown),
    risks: [],
    bestSolution: reviewSectionValue(markdown, "bestSolution"),
    maintainerDecision: maintainerDecisionFromReport(markdown) ?? emptyMaintainerDecision(),
    triagePriority,
    impactLabels,
    mergeRiskLabels,
    maturityLabels,
    mergeRiskOptions: mergeRiskOptionsFromReport(markdown),
    reviewMetrics: reviewMetricsFromReport(markdown),
    labelJustifications: labelJustificationsFromReport(markdown, {
      triagePriority,
      impactLabels,
      mergeRiskLabels,
      maturityLabels,
    }),
    itemCategory:
      (frontMatterValue(markdown, "item_category") as ItemCategory | undefined) ?? "unclear",
    reproductionStatus:
      (frontMatterValue(markdown, "reproduction_status") as ReproductionStatus | undefined) ??
      "unclear",
    reproductionConfidence:
      (frontMatterValue(markdown, "reproduction_confidence") as Confidence | undefined) ?? "low",
    requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
    requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
    requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
    reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
    solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
    ...visionFit,
    rootCauseCluster: reportRootCauseCluster(markdown),
    agentsPolicyStatus: reportAgentsPolicyStatus(markdown) ?? defaultAgentsPolicyStatus(),
    reviewFindings: reportReviewFindings(markdown),
    securityReview: reportSecurityReview(markdown),
    realBehaviorProof: reportRealBehaviorProof(markdown),
    prRating: reportPrRating(markdown),
    telegramVisibleProof: reportTelegramVisibleProof(markdown),
    mantisRecommendation: reportMantisRecommendation(markdown),
    featureShowcase: reportFeatureShowcase(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    overallConfidenceScore: reportOverallConfidenceScore(markdown),
    fixedRelease: fixedRelease && fixedRelease !== "unknown" ? fixedRelease : null,
    fixedSha: fixedSha && fixedSha !== "unknown" ? fixedSha : null,
    fixedAt: fixedAt && fixedAt !== "unknown" ? fixedAt : null,
    fixedPullRequest: fixedPullRequestFromReport(markdown),
    closeComment: reviewSectionValue(markdown, "closeComment"),
    workCandidate:
      (frontMatterValue(markdown, "work_candidate") as WorkCandidateKind | undefined) ?? "none",
    workConfidence:
      (frontMatterValue(markdown, "work_confidence") as Confidence | undefined) ?? "low",
    workPriority: (frontMatterValue(markdown, "work_priority") as Confidence | undefined) ?? "low",
    workReason: reviewSectionValue(markdown, "workCandidate"),
    workPrompt: reviewSectionValue(markdown, "repairWorkPrompt"),
    workClusterRefs: frontMatterStringArray(markdown, "work_cluster_refs"),
    workValidation: frontMatterStringArray(markdown, "work_validation"),
    workLikelyFiles: frontMatterStringArray(markdown, "work_likely_files"),
  };
}

function livePullRequestHasNoDiff(context: ItemContext): boolean {
  const pull = asRecord(context.pullRequest);
  return (
    pull.changedFiles === 0 &&
    context.counts?.pullFilesTruncated !== true &&
    (context.pullFiles?.length ?? 0) === 0
  );
}

function upgradeNoDiffPullRequestReport(markdown: string, item: Item): string {
  const command = `gh api repos/${item.repo}/pulls/${item.number} --jq '{state:.state,changed_files:.changed_files,base:.base.ref,head:.head.sha}'`;
  let upgraded = markdown;
  upgraded = replaceFrontMatterValue(upgraded, "decision", "close");
  upgraded = replaceFrontMatterValue(upgraded, "close_reason", "duplicate_or_superseded");
  upgraded = replaceFrontMatterValue(upgraded, "confidence", "high");
  upgraded = replaceFrontMatterValue(upgraded, "action_taken", "proposed_close");
  upgraded = replaceFrontMatterValue(upgraded, "pr_close_coverage_proof_fallback_refs", "false");
  upgraded = replaceFrontMatterValue(upgraded, "work_cluster_refs", "[]");
  upgraded = replaceFrontMatterValue(upgraded, "merge_risk_options", "[]");
  upgraded = replaceFrontMatterValue(upgraded, "work_candidate", "none");
  upgraded = replaceFrontMatterValue(upgraded, "work_status", "none");
  upgraded = replaceSectionValue(
    upgraded,
    REVIEW_SECTIONS.summary,
    "Close this PR: GitHub reports no changed files against the current base branch.",
  );
  upgraded = replaceSectionValue(
    upgraded,
    REVIEW_SECTIONS.bestSolution,
    "Close this PR: GitHub reports no changed files against the current base branch, so the branch is already empty or superseded by `main`.",
  );
  upgraded = replaceSectionValue(
    upgraded,
    REVIEW_SECTIONS.evidence,
    `- **live no-diff PR:** GitHub reports \`changed_files: 0\` for this open PR, so there is no remaining branch diff to merge.\n  - command: \`${command}\``,
  );
  upgraded = replaceSectionValue(
    upgraded,
    REVIEW_SECTIONS.closeComment,
    renderCloseCommentFromReport(upgraded, "duplicate_or_superseded"),
  );
  return upgraded;
}

function upgradePullRequestClosePromotionReport(
  markdown: string,
  item: Item,
  context: ItemContext,
  promotion: PullRequestClosePromotion,
): string {
  let upgraded = markdown;
  upgraded = replaceFrontMatterValue(upgraded, "decision", "close");
  upgraded = replaceFrontMatterValue(upgraded, "close_reason", promotion.closeReason);
  upgraded = replaceFrontMatterValue(upgraded, "confidence", "high");
  upgraded = replaceFrontMatterValue(upgraded, "action_taken", "proposed_close");
  upgraded = replaceFrontMatterValue(
    upgraded,
    "pr_close_coverage_proof_fallback_refs",
    promotion.coverageProofFallbackRefs ? "true" : "false",
  );
  upgraded = replaceFrontMatterValue(upgraded, "work_candidate", "none");
  upgraded = replaceFrontMatterValue(upgraded, "work_status", "none");
  upgraded = replaceFrontMatterValue(upgraded, "item_updated_at", item.updatedAt);
  upgraded = replaceFrontMatterValue(
    upgraded,
    "item_snapshot_hash",
    itemSnapshotHash(item, context),
  );
  upgraded = replaceFrontMatterValue(
    upgraded,
    "item_source_revision",
    context.sourceRevision ?? "unknown",
  );
  upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.summary, promotion.summary);
  upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.bestSolution, promotion.bestSolution);
  upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.evidence, promotion.evidence);
  upgraded = replaceSectionValue(upgraded, REVIEW_SECTIONS.closeComment, promotion.closeComment);
  return upgraded;
}

function authorPrBudgetPromotion(
  markdown: string,
  state: AuthorPrBudgetApplyState,
): PullRequestClosePromotion {
  const proof = reportRealBehaviorProof(markdown);
  const rating = reportPrRating(markdown);
  const author = `@${state.author.replace(/^@/, "")}`;
  const summary = `${author} currently has ${state.openPrCount} open PRs in this repository, above the budget of ${state.budget}. ClawSweeper is closing this PR as one of the author's lowest-signal submissions under that budget: its overall rating is ${rating.overallTier} and its real behavior proof is ${proof.status}. Closing or finishing other PRs frees review budget, and this PR can be reopened once the author is under budget or when real proof is added.`;
  return {
    closeReason: "author_pr_budget_exceeded",
    summary,
    coverageProofFallbackRefs: false,
    bestSolution:
      "Close this lowest-signal PR for now. Finish or close other open PRs to free review budget, then reopen this PR once the author is under budget; adding real behavior proof also makes it eligible for reconsideration.",
    evidence: [
      `- **live author budget:** ${author} has ${state.openPrCount} open PRs in this repository; the configured budget is ${state.budget}.`,
      `- **lowest-signal classification:** overall PR rating is \`${rating.overallTier}\` and real behavior proof is \`${proof.status}\`.`,
      `- **inactivity floor:** the PR and its current-head commit, status, and check-run activity are all older than ${AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS} days.`,
    ].join("\n"),
    closeComment: `Thanks for the contribution. ${summary}`,
  };
}

function applyAuthorPrBudgetStateToReport(
  markdown: string,
  state: AuthorPrBudgetApplyState,
): string {
  const promotion = authorPrBudgetPromotion(markdown, state);
  let next = replaceSectionValue(markdown, REVIEW_SECTIONS.summary, promotion.summary);
  next = replaceSectionValue(next, REVIEW_SECTIONS.bestSolution, promotion.bestSolution);
  next = replaceSectionValue(next, REVIEW_SECTIONS.evidence, promotion.evidence);
  return replaceSectionValue(next, REVIEW_SECTIONS.closeComment, promotion.closeComment);
}

function closePromotionHasNonAutomationActivityAfterReview(
  markdown: string,
  context: ItemContext,
): boolean {
  const reviewedAtMs = timestampMs(frontMatterValue(markdown, "reviewed_at"));
  if (reviewedAtMs === null) return true;
  return contextHasNonAutomationActivityAfter(context, reviewedAtMs);
}

function contextHasNonAutomationActivityAfter(
  context: ItemContext,
  reviewedAtMs: number,
  options: {
    truncationCountsAsActivity?: boolean;
    useCompleteActivityContext?: boolean;
    ignoreTimelineCommentsThroughMs?: number;
    ignoreTrustedTimelineComment?: {
      authors: ReadonlySet<string>;
      createdAt: string;
    };
  } = {},
): boolean {
  const truncationCountsAsActivity = options.truncationCountsAsActivity ?? true;
  const activityContextTruncated = Boolean(
    context.counts?.commentsTruncated ||
    context.counts?.timelineTruncated ||
    context.counts?.pullReviewCommentsTruncated,
  );
  const completeActivityContext = options.useCompleteActivityContext
    ? context[completeActivityContextSymbol]
    : undefined;
  if (truncationCountsAsActivity && activityContextTruncated && !completeActivityContext) {
    return true;
  }
  const hasNonAutomationComment = (comment: unknown): boolean => {
    const record = asRecord(comment);
    return (
      isAfterReview(comment, reviewedAtMs) &&
      !isAutomationReportAuthor(stringOrUndefined(record.author))
    );
  };
  const hasNonAutomationEvent = (event: unknown): boolean => {
    const record = asRecord(event);
    const eventActor = (stringOrUndefined(record.actor) ?? "").trim().toLowerCase();
    const trustedTimelineComment = options.ignoreTrustedTimelineComment;
    if (
      stringOrUndefined(record.event) === "commented" &&
      trustedTimelineComment &&
      eventTimestampMs(event) === timestampMs(trustedTimelineComment.createdAt) &&
      trustedTimelineComment.authors.has(eventActor)
    ) {
      return false;
    }
    // Issue comments are checked above with their bodies. Ignore timeline
    // duplicates only through the completed review; later commands are fresh
    // activity and must keep stale labels from being restored.
    if (
      stringOrUndefined(record.event) === "commented" &&
      options.ignoreTimelineCommentsThroughMs !== undefined
    ) {
      const eventMs = eventTimestampMs(event);
      if (eventMs !== null && eventMs <= options.ignoreTimelineCommentsThroughMs) return false;
    }
    return (
      isAfterReview(event, reviewedAtMs) &&
      !isAutomationReportAuthor(stringOrUndefined(record.actor))
    );
  };
  return (
    (completeActivityContext?.comments ?? context.comments).some(hasNonAutomationComment) ||
    (completeActivityContext?.pullReviewComments ?? context.pullReviewComments ?? []).some(
      hasNonAutomationComment,
    ) ||
    (completeActivityContext?.timeline ?? context.timeline).some(hasNonAutomationEvent)
  );
}

export function contextHasNonAutomationActivityAfterForTest(options: {
  comments?: unknown[];
  timeline?: unknown[];
  pullReviewComments?: unknown[];
  truncated?: {
    comments?: boolean;
    timeline?: boolean;
    pullReviewComments?: boolean;
  };
  completeActivityContext?: Partial<CompleteActivityContext>;
  activityAfterMs: number;
  ignoreTimelineCommentsThroughMs?: number;
}): boolean {
  const context: ItemContext = {
    issue: {},
    comments: options.comments ?? [],
    timeline: options.timeline ?? [],
    pullReviewComments: options.pullReviewComments ?? [],
    counts: {
      comments: options.comments?.length ?? 0,
      commentsTruncated: options.truncated?.comments ?? false,
      timeline: options.timeline?.length ?? 0,
      timelineTruncated: options.truncated?.timeline ?? false,
      pullReviewCommentsTruncated: options.truncated?.pullReviewComments ?? false,
    },
  };
  if (options.completeActivityContext) {
    context[completeActivityContextSymbol] = {
      comments: options.completeActivityContext.comments ?? [],
      timeline: options.completeActivityContext.timeline ?? [],
      pullReviewComments: options.completeActivityContext.pullReviewComments ?? [],
    };
  }
  return contextHasNonAutomationActivityAfter(context, options.activityAfterMs, {
    ...(options.completeActivityContext ? { useCompleteActivityContext: true } : {}),
    ...(options.ignoreTimelineCommentsThroughMs === undefined
      ? {}
      : { ignoreTimelineCommentsThroughMs: options.ignoreTimelineCommentsThroughMs }),
  });
}
const pullRequestReferenceParser = createPullRequestReferenceParser({
  targetRepo,
  repoUrlFor,
  reportReferenceTexts(markdown) {
    return [
      ...frontMatterStringArray(markdown, "work_cluster_refs"),
      ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
      reviewSectionValue(markdown, "bestSolution"),
      reviewSectionValue(markdown, "evidence"),
      reviewSectionValue(markdown, "closeComment"),
    ];
  },
});
const {
  linkedPullRequestNumbersFromReport,
  linkedPullRequestRefsFromReport,
  linkedPullRequestRefsFromText,
  linkedPullRequestSignalContextsFromText,
  pullRequestUrlForNumber,
} = pullRequestReferenceParser;

function linkedPullRequestHasSupersessionSignal(
  markdown: string,
  currentNumber: number,
  linkedNumber: number,
): boolean {
  const signal =
    /\b(supersed(?:e|ed|es|ing)|replace(?:s|d|ment)?|duplicate|duplicated|canonical|covered by|landed in)\b/i;
  const texts = [
    ...frontMatterStringArray(markdown, "work_cluster_refs"),
    ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
    reviewSectionValue(markdown, "bestSolution"),
    reviewSectionValue(markdown, "evidence"),
    reviewSectionValue(markdown, "closeComment"),
  ];
  return texts.some((text) =>
    linkedPullRequestSignalContextsFromText(text, currentNumber, linkedNumber).some((context) =>
      signal.test(context),
    ),
  );
}

function linkedPullRequestSupersession(
  markdown: string,
  item: Item,
  options: { reportDirs?: readonly string[] } = {},
): LinkedPullRequestSupersessionResolution {
  let unsafeReason: string | null = null;
  for (const number of linkedPullRequestNumbersFromReport(markdown, item.number)) {
    try {
      const hasSupersessionSignal = linkedPullRequestHasSupersessionSignal(
        markdown,
        item.number,
        number,
      );
      const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
      const state = stringOrUndefined(pull.state)?.toLowerCase() ?? "";
      const mergedAt = stringOrUndefined(pull.merged_at) ?? null;
      if (!hasSupersessionSignal) continue;
      const linkedFiles = linkedPullRequestFiles(number);
      const linkedPull: LinkedPullRequestSupersession = {
        number,
        title: stringOrUndefined(pull.title) ?? `PR #${number}`,
        url: stringOrUndefined(pull.html_url) ?? pullRequestUrlForNumber(number),
        state,
        mergedAt,
        mergeableState: stringOrUndefined(pull.mergeable_state)?.toLowerCase() ?? null,
        draft: pull.draft === true,
        labels: linkedPullRequestLabels(number, pull),
        files: linkedFiles.files,
        filesKnown: linkedFiles.known,
      };
      if (linkedPullCannotSupersedeDocsOnlySource(markdown, linkedPull)) continue;
      const candidateUnsafeReason = unsafeCanonicalPullRequestReason(linkedPull, options);
      if (candidateUnsafeReason !== null) {
        unsafeReason ??= candidateUnsafeReason;
        continue;
      }
      return { candidate: linkedPull, unsafeReason: null };
    } catch {
      // Missing or cross-repo stale references are not close evidence.
    }
  }
  return { candidate: null, unsafeReason };
}

function linkedPullRequestLabels(number: number, pull: Record<string, unknown>): string[] {
  const labels = labelNames(pull.labels);
  if (labels.length) return labels;
  try {
    return ghJson<string[]>([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
      "--jq",
      "[.labels[].name]",
    ]);
  } catch {
    return [];
  }
}

function linkedPullRequestFiles(number: number): { files: string[]; known: boolean } {
  try {
    const files = ghJson<unknown[]>([
      "api",
      `repos/${targetRepo()}/pulls/${number}/files?per_page=100`,
      "--jq",
      "[.[].filename]",
    ]);
    return { files: files.filter((file): file is string => typeof file === "string"), known: true };
  } catch {
    return { files: [], known: false };
  }
}

function linkedPullCannotSupersedeDocsOnlySource(
  sourceMarkdown: string,
  linkedPull: LinkedPullRequestSupersession,
): boolean {
  if (!isDocsOnlyPullRequestReport(sourceMarkdown)) return false;
  if (!linkedPull.filesKnown) return true;
  return linkedPull.files.length === 0 || !linkedPull.files.every(isDocsPath);
}

function linkedPullRequestReportMarkdown(
  number: number,
  reportDirs: readonly string[] | undefined,
): string | null {
  if (!reportDirs?.length) return null;
  const file = reportFileName(targetRepo(), number);
  for (const dir of reportDirs) {
    const path = join(dir, file);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

function proofPassedInReport(markdown: string | null): boolean {
  if (!markdown) return false;
  const proof = reportRealBehaviorProof(markdown);
  return proof.status === "sufficient" || proof.status === "override";
}

function proofPassedInLabels(labels: readonly string[]): boolean {
  return labels.some((label) => /^proof:\s*(sufficient|override)\b/i.test(label));
}

function unsafeCanonicalPullRequestReason(
  linkedPull: LinkedPullRequestSupersession,
  options: { reportDirs?: readonly string[] } = {},
): string | null {
  if (linkedPull.mergedAt) return null;
  if (linkedPull.state !== "open") {
    return `linked canonical PR #${linkedPull.number} is ${linkedPull.state || "not open"} and unmerged`;
  }
  if (linkedPull.draft) {
    return `linked canonical PR #${linkedPull.number} is still draft`;
  }
  if (!linkedPull.mergeableState || linkedPull.mergeableState === "unknown") {
    return `linked canonical PR #${linkedPull.number} mergeability is not known`;
  }
  if (linkedPull.mergeableState === "dirty") {
    return `linked canonical PR #${linkedPull.number} has merge conflicts`;
  }
  // GitHub reports "behind" for a conflict-free PR that only needs a base update.
  if (linkedPull.mergeableState !== "clean" && linkedPull.mergeableState !== "behind") {
    return `linked canonical PR #${linkedPull.number} is not cleanly mergeable (${linkedPull.mergeableState})`;
  }

  const report = linkedPullRequestReportMarkdown(linkedPull.number, options.reportDirs);
  const labels = linkedPull.labels.map(normalizeLabelName);
  const labelProofPassed = proofPassedInLabels(linkedPull.labels);
  const liveNeedsProof = labels.some(
    (label) =>
      label === "triage: needs-real-behavior-proof" ||
      (label.startsWith("status:") && label.includes("needs proof")),
  );
  const reportProofPassed = proofPassedInReport(report);
  const proofPassed = reportProofPassed || labelProofPassed;

  if (labels.some((label) => label.startsWith("rating:") && label.includes("unranked"))) {
    return `linked canonical PR #${linkedPull.number} is F-rated`;
  }
  if (liveNeedsProof && !labelProofPassed) {
    return `linked canonical PR #${linkedPull.number} is still waiting for real behavior proof`;
  }

  if (report) {
    if (
      frontMatterValue(report, "decision") === "close" &&
      frontMatterValue(report, "confidence") === "high"
    ) {
      return `linked canonical PR #${linkedPull.number} is itself proposed for close`;
    }
    const proof = reportRealBehaviorProof(report);
    if (
      !proofPassed &&
      (proof.status === "missing" ||
        proof.status === "mock_only" ||
        proof.status === "insufficient")
    ) {
      return `linked canonical PR #${linkedPull.number} is still waiting for real behavior proof`;
    }
    const rating = reportPrRating(report);
    if (rating.overallTier === "F" || rating.proofTier === "F" || rating.patchTier === "F") {
      return `linked canonical PR #${linkedPull.number} is F-rated`;
    }
  }
  if (!proofPassed) {
    return `linked canonical PR #${linkedPull.number} has no positive real behavior proof`;
  }

  return null;
}

function duplicateCanonicalPullRequestBlockReason(
  markdown: string,
  item: Item,
  options: { reportDirs?: readonly string[] } = {},
): string | null {
  if (item.kind !== "pull_request") return null;
  for (const ref of prCloseCoverageProofCandidateRefs(markdown, item)) {
    const { number } = ref;
    try {
      const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
      const linkedFiles = linkedPullRequestFiles(number);
      const linkedPull: LinkedPullRequestSupersession = {
        number,
        title: stringOrUndefined(pull.title) ?? `PR #${number}`,
        url: stringOrUndefined(pull.html_url) ?? pullRequestUrlForNumber(number),
        state: stringOrUndefined(pull.state)?.toLowerCase() ?? "",
        mergedAt: stringOrUndefined(pull.merged_at) ?? null,
        mergeableState: stringOrUndefined(pull.mergeable_state)?.toLowerCase() ?? null,
        draft: pull.draft === true,
        labels: linkedPullRequestLabels(number, pull),
        files: linkedFiles.files,
        filesKnown: linkedFiles.known,
      };
      if (linkedPullCannotSupersedeDocsOnlySource(markdown, linkedPull)) {
        return `linked canonical PR #${number} does not cover the docs-only source diff; refusing duplicate/superseded auto-close`;
      }
      const reason = unsafeCanonicalPullRequestReason(linkedPull, options);
      if (reason) return `${reason}; refusing duplicate/superseded auto-close`;
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      if (ref.kind !== "pull_url" && shorthandRefIsIssue(number)) continue;
      return `linked canonical PR #${number} could not be read; refusing duplicate/superseded auto-close`;
    }
  }
  return null;
}

function shorthandRefIsIssue(number: number): boolean {
  try {
    const issue = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]));
    return !issue.pull_request;
  } catch {
    return false;
  }
}

function linkedRefCanBePullRequest(ref: PullRequestRef): boolean {
  if (ref.kind === "pull_url") return true;
  try {
    ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${ref.number}`]);
    return true;
  } catch {
    return !shorthandRefIsIssue(ref.number);
  }
}

const PR_CLOSE_COVERAGE_PROOF_MAX_CANDIDATES_PER_ITEM = 4;

function prCloseCoverageProofCandidateRefs(markdown: string, item: Item): PullRequestRef[] {
  if (item.kind !== "pull_request") return [];
  const linkedRefs = linkedPullRequestRefsFromReport(markdown, item.number);
  const canonicalRefs = linkedRefs
    .filter((ref) => linkedPullRequestHasSupersessionSignal(markdown, item.number, ref.number))
    .filter(linkedRefCanBePullRequest);
  if (canonicalRefs.length > 0) {
    return canonicalRefs.slice(0, PR_CLOSE_COVERAGE_PROOF_MAX_CANDIDATES_PER_ITEM);
  }
  if (frontMatterValue(markdown, "pr_close_coverage_proof_fallback_refs") === "false") return [];
  const possiblePullRequestRefs = linkedRefs.filter(linkedRefCanBePullRequest);
  return possiblePullRequestRefs.length === 1 ? possiblePullRequestRefs : [];
}

function possibleCanonicalPullRequestRefsFromReport(
  markdown: string,
  item: Item,
): PullRequestRef[] {
  if (item.kind !== "pull_request") return [];
  const pendingCanonicalNumber = staleCanonicalPullRequestNumber(markdown);
  if (pendingCanonicalNumber) {
    return [{ number: pendingCanonicalNumber, kind: "pull_url" }];
  }
  const structuredCanonicalRef = reportRootCauseCluster(markdown).canonicalRef;
  if (structuredCanonicalRef) {
    const parsed = parseGitHubItemRef(structuredCanonicalRef, "root_cause_cluster.canonicalRef");
    if (parsed.kind === "pull_request" && parsed.number !== item.number) {
      return [{ number: parsed.number, kind: "pull_url" }];
    }
  }
  const linkedRefs = linkedPullRequestRefsFromReport(markdown, item.number);
  const canonicalRefs = linkedRefs
    .filter((ref) => linkedPullRequestHasSupersessionSignal(markdown, item.number, ref.number))
    .filter(linkedRefCanBePullRequest);
  if (canonicalRefs.length > 0) return canonicalRefs;
  if (frontMatterValue(markdown, "pr_close_coverage_proof_fallback_refs") === "false") return [];
  const possiblePullRequestRefs = linkedRefs.filter(linkedRefCanBePullRequest);
  return possiblePullRequestRefs.length === 1 ? possiblePullRequestRefs : [];
}

function canonicalPullRequestCommentSyncBlock(
  markdown: string,
  item: Item,
): CanonicalPullRequestCommentSyncBlock | null {
  for (const ref of possibleCanonicalPullRequestRefsFromReport(markdown, item)) {
    const { number } = ref;
    try {
      const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
      const state = stringOrUndefined(pull.state)?.toLowerCase() ?? "";
      const mergedAt = stringOrUndefined(pull.merged_at) ?? null;
      if (state === "closed" && !mergedAt) {
        return {
          kind: "closed_unmerged",
          number,
          reason: `linked canonical PR #${number} is closed and unmerged; refusing duplicate/superseded auto-close`,
        };
      }
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      if (ref.kind !== "pull_url" && shorthandRefIsIssue(number)) continue;
      return {
        kind: "unreadable",
        number,
        reason: `linked canonical PR #${number} could not be read; refusing duplicate/superseded comment sync`,
      };
    }
  }
  return null;
}

function prCloseCoverageRuntimeBudgetBlock(
  runtimeBudget: PrCloseCoverageRuntimeBudget | undefined,
  phase: string,
): PrCloseCoverageProofGateResult {
  if (
    !runtimeBudget ||
    !runtimeBudgetExceeded(runtimeBudget.startedAtMs, runtimeBudget.maxRuntimeMs, Date.now())
  ) {
    return null;
  }
  return {
    status: "blocked",
    block: {
      actionTaken: "skipped_runtime_budget",
      reason: `max runtime ${runtimeBudget.maxRuntimeMs}ms reached ${phase} PR close coverage proof`,
    },
  };
}

function prCloseCoverageRuntime(
  runtime: PrCloseCoverageProofRuntime,
  runtimeBudget: PrCloseCoverageRuntimeBudget | undefined,
): PrCloseCoverageProofRuntime | null {
  if (!runtimeBudget) return runtime;
  const timeoutMs = timeoutWithinRuntimeBudget(
    runtimeBudget.startedAtMs,
    runtimeBudget.maxRuntimeMs,
    runtime.timeoutMs,
    Date.now(),
  );
  return timeoutMs === null ? null : { ...runtime, timeoutMs };
}

function sourcePrCloseCoveragePullRequestView(
  item: Item,
  context: ItemContext,
): PrCloseCoverageProofPullRequestView {
  const issue = asRecord(context.issue);
  const pull = asRecord(context.pullRequest);
  return {
    number: item.number,
    title: stringOrUndefined(pull.title) ?? stringOrUndefined(issue.title) ?? item.title,
    url: item.url,
    state: "open",
    mergedAt: null,
    body: compactPrCloseCoverageProofText(
      stringOrUndefined(pull.body) ?? stringOrUndefined(issue.body) ?? "",
    ),
    updatedAt: item.updatedAt,
    headSha: pullHeadShaFromContext(context) ?? null,
    comments: (context.comments ?? []).map(compactPrCloseCoverageProofComment),
    commentsTruncated: Boolean(context.counts?.commentsTruncated),
  };
}

function coveringPrCloseCoveragePullRequestView(
  number: number,
): PrCloseCoverageProofPullRequestView {
  const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
  const issue = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]));
  const commentsPath = `repos/${targetRepo()}/issues/${number}/comments`;
  const commentsCount = numberOrUndefined(issue.comments);
  const commentsWindow =
    commentsCount === undefined
      ? ghPagedLinkHeaderContextWindow<unknown>(commentsPath, 40)
      : ghPagedContextWindow<unknown>(commentsPath, commentsCount, 40);
  const filteredComments = filterReviewContextComments(commentsWindow.items, number);
  return {
    number,
    title: stringOrUndefined(pull.title) ?? stringOrUndefined(issue.title) ?? `PR #${number}`,
    url:
      stringOrUndefined(pull.html_url) ??
      stringOrUndefined(issue.html_url) ??
      pullRequestUrlForNumber(number),
    state: stringOrUndefined(pull.state)?.toLowerCase() ?? "",
    mergedAt: stringOrUndefined(pull.merged_at) ?? null,
    body: compactPrCloseCoverageProofText(
      stringOrUndefined(pull.body) ?? stringOrUndefined(issue.body) ?? "",
    ),
    updatedAt: stringOrUndefined(pull.updated_at) ?? stringOrUndefined(issue.updated_at) ?? null,
    headSha: stringOrUndefined(asRecord(pull.head).sha) ?? null,
    comments: filteredComments.included.map(compactPrCloseCoverageProofComment),
    commentsTruncated: commentsWindow.truncated,
  };
}

function coveringPrCloseCoveragePullRequestUpdatedAt(number: number): string | null {
  const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
  const pullUpdatedAt = stringOrUndefined(pull.updated_at);
  if (pullUpdatedAt) return pullUpdatedAt;
  const issue = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]));
  return stringOrUndefined(issue.updated_at) ?? null;
}

function prCloseCoverageProofSignalSnippets(
  markdown: string,
  currentNumber: number,
  linkedNumber: number,
): string[] {
  const texts = [
    ...frontMatterStringArray(markdown, "work_cluster_refs"),
    ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
    reviewSectionValue(markdown, "bestSolution"),
    reviewSectionValue(markdown, "evidence"),
    reviewSectionValue(markdown, "closeComment"),
  ];
  return texts
    .flatMap((text) => linkedPullRequestSignalContextsFromText(text, currentNumber, linkedNumber))
    .map((text) => compactPrCloseCoverageProofText(text, 500))
    .filter(Boolean)
    .slice(0, 4);
}

function prCloseCoverageProofGateResult(options: {
  markdown: string;
  item: Item;
  context: ItemContext;
  runtime: PrCloseCoverageProofRuntime;
  requirePrecomputedProof?: boolean;
  runtimeBudget?: PrCloseCoverageRuntimeBudget;
}): PrCloseCoverageProofGateResult {
  // This trusted timestamp precedes mutation-side hydration and validation. The
  // proof artifact's own timestamp is audit metadata, not a freshness authority.
  const proofBindingStartedAtMs = Date.now();
  const beforeCandidateResolution = prCloseCoverageRuntimeBudgetBlock(
    options.runtimeBudget,
    "before resolving",
  );
  if (beforeCandidateResolution) return beforeCandidateResolution;
  const candidateRefs = prCloseCoverageProofCandidateRefs(options.markdown, options.item);
  const afterCandidateResolution = prCloseCoverageRuntimeBudgetBlock(
    options.runtimeBudget,
    "while resolving",
  );
  if (afterCandidateResolution) return afterCandidateResolution;
  if (candidateRefs.length === 0) return null;

  const source = sourcePrCloseCoveragePullRequestView(options.item, options.context);
  const coveringViews = new Map<number, PrCloseCoverageProofPullRequestView>();
  const coveringView = (number: number): PrCloseCoverageProofPullRequestView => {
    const cached = coveringViews.get(number);
    if (cached) return cached;
    const view = coveringPrCloseCoveragePullRequestView(number);
    coveringViews.set(number, view);
    return view;
  };
  let firstKeepOpenBlock: PrCloseCoverageProofGateBlock | null = null;
  let checkedPullRequestCandidate = false;
  for (const candidateRef of candidateRefs) {
    const linkedNumber = candidateRef.number;
    const beforeHydration = prCloseCoverageRuntimeBudgetBlock(
      options.runtimeBudget,
      "before hydrating",
    );
    if (beforeHydration) return beforeHydration;
    let covering: PrCloseCoverageProofPullRequestView;
    try {
      covering = coveringView(linkedNumber);
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      const hydrationBudgetBlock = prCloseCoverageRuntimeBudgetBlock(
        options.runtimeBudget,
        "while hydrating",
      );
      if (hydrationBudgetBlock) return hydrationBudgetBlock;
      if (candidateRef.kind !== "pull_url" && shorthandRefIsIssue(linkedNumber)) continue;
      return {
        status: "blocked",
        block: {
          actionTaken: "retry_pr_close_coverage_proof",
          reason: `PR close coverage proof could not hydrate linked canonical PR #${linkedNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
    const afterHydration = prCloseCoverageRuntimeBudgetBlock(
      options.runtimeBudget,
      "while hydrating",
    );
    if (afterHydration) return afterHydration;
    checkedPullRequestCandidate = true;
    if (!prCloseCoverageProofCandidateCanClose(covering)) {
      return {
        status: "blocked",
        block: {
          actionTaken: "kept_open",
          reason: `linked canonical PR #${linkedNumber} is ${covering.state || "not open"} and unmerged; refusing duplicate/superseded auto-close`,
        },
      };
    }
    try {
      const relationshipSignalSnippets = prCloseCoverageProofSignalSnippets(
        options.markdown,
        options.item.number,
        linkedNumber,
      );
      const promptSha256 = prCloseCoverageProofPromptSha256({
        source,
        covering,
        reportMarkdown: options.markdown,
        relationshipSignalSnippets,
        promptTemplate: options.runtime.promptTemplate,
      });
      let proofStartedAtMs = proofBindingStartedAtMs;
      const envelope = options.requirePrecomputedProof
        ? readPrCloseCoverageProofEnvelope(
            prCloseCoverageProofEnvelopePath(
              options.runtime.workDir,
              source.number,
              covering.number,
            ),
          )
        : (() => {
            const proofRuntime = prCloseCoverageRuntime(options.runtime, options.runtimeBudget);
            if (!proofRuntime) {
              throw new Error("runtime budget reached before running PR close coverage proof");
            }
            proofStartedAtMs = Date.now();
            const proof = runPrCloseCoverageProofModel({
              source,
              covering,
              markdown: options.markdown,
              relationshipSignalSnippets,
              runtime: proofRuntime,
            });
            return writePrCloseCoverageProofEnvelope({
              workDir: options.runtime.workDir,
              targetRepo: targetRepo(),
              promptSha256,
              source,
              covering,
              proof,
            });
          })();
      validatePrCloseCoverageProofEnvelopeBinding(envelope, {
        targetRepo: targetRepo(),
        promptSha256,
        source,
        covering,
      });
      const proof = envelope.proof;
      const closeDecision = prCloseCoverageProofCloseDecision(proof);
      if (closeDecision.close) {
        return {
          status: "allowed",
          covering: {
            number: covering.number,
            provedAtMs: proofStartedAtMs,
            updatedAt: covering.updatedAt,
            url: covering.url,
            proof: closeDecision.proof,
          },
        };
      }
      firstKeepOpenBlock ??= {
        actionTaken: "skipped_pr_close_coverage_proof",
        reason: `PR close coverage proof kept this PR open against ${covering.url}: ${closeDecision.reason}`,
      };
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      const proofBudgetBlock = prCloseCoverageRuntimeBudgetBlock(
        options.runtimeBudget,
        "while running",
      );
      if (proofBudgetBlock) return proofBudgetBlock;
      return {
        status: "blocked",
        block: {
          actionTaken: "retry_pr_close_coverage_proof",
          reason: `PR close coverage proof ${
            options.requirePrecomputedProof ? "artifact validation" : "generation"
          } failed for linked canonical PR #${linkedNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }
  if (!checkedPullRequestCandidate) return null;
  return {
    status: "blocked",
    block: firstKeepOpenBlock ?? {
      actionTaken: "skipped_pr_close_coverage_proof",
      reason: "PR close coverage proof did not allow close",
    },
  };
}

function renderPrCloseCoverageProofReportSection(
  covering: PrCloseCoverageProofCoveringWitness,
): string {
  return [
    "Decision: covered",
    `Covering PR: ${covering.url}`,
    `Reason: ${covering.proof.reason}`,
    "",
    "Covered work:",
    formatPrCloseCoverageProofDetailList(covering.proof.coveredWork),
    "",
    "Unique source work:",
    formatPrCloseCoverageProofDetailList(covering.proof.uniqueSourceWork),
  ].join("\n");
}

function applyPrCloseCoverageProofReportSection(
  markdown: string,
  gateResult: PrCloseCoverageProofGateResult | undefined,
): string {
  if (gateResult?.status !== "allowed") return markdown;
  return replaceSectionValue(
    markdown,
    PR_CLOSE_COVERAGE_PROOF_SECTION,
    renderPrCloseCoverageProofReportSection(gateResult.covering),
  );
}

function applyPrCloseCoverageProofBlockedReport(
  markdown: string,
  block: PrCloseCoverageProofGateBlock,
): string {
  const previousEvidence = reviewSectionValue(markdown, "evidence");
  let next = replaceFrontMatterValue(markdown, "decision", "keep_open");
  next = replaceFrontMatterValue(next, "close_reason", "none");
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.summary,
    `Keep this PR open. ${sentence(block.reason)}`,
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.bestSolution,
    "Keep this PR open until a linked canonical PR proves it covers this PR's unique work, or a maintainer confirms closure.",
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.evidence,
    [`- **PR close coverage proof:** ${block.reason}`, previousEvidence.trim()]
      .filter(Boolean)
      .join("\n"),
  );
  next = replaceSectionValue(next, REVIEW_SECTIONS.closeComment, "_No close comment posted._");
  return replaceSectionValue(
    next,
    PR_CLOSE_COVERAGE_PROOF_SECTION,
    ["Decision: keep_open", `Reason: ${block.reason}`].join("\n"),
  );
}

function applyClosedUnmergedCanonicalBlockedReport(
  markdown: string,
  block: PrCloseCoverageProofGateBlock,
  canonicalNumber: number,
): string {
  const rootCauseCluster = defaultRootCauseCluster();
  const nextStep =
    "Run a fresh review against current main and the current related PR state before choosing a landing or close path.";
  const rating: PrRating = {
    ...reportPrRating(markdown),
    summary:
      "The prior duplicate or superseded close path is no longer valid; retain the existing readiness tiers until a fresh review.",
    nextSteps: [nextStep],
  };
  let next = replaceFrontMatterValue(markdown, "decision", "keep_open");
  next = replaceFrontMatterValue(next, "close_reason", "none");
  next = replaceFrontMatterValue(next, "confidence", "low");
  next = replaceFrontMatterValue(next, "action_taken", "retry_stale_canonical_comment_sync");
  next = replaceFrontMatterValue(
    next,
    "stale_canonical_pull_request_number",
    String(canonicalNumber),
  );
  next = replaceFrontMatterValue(next, "close_comment_sha256", "none");
  next = replaceFrontMatterValue(next, "work_candidate", "none");
  next = replaceFrontMatterValue(next, "work_confidence", "low");
  next = replaceFrontMatterValue(next, "work_priority", "low");
  next = replaceFrontMatterValue(next, "work_status", "none");
  next = replaceFrontMatterValue(next, "work_reason_sha256", sha256(nextStep));
  next = replaceFrontMatterValue(next, "work_cluster_refs", "[]");
  next = replaceFrontMatterValue(next, "work_validation", "[]");
  next = replaceFrontMatterValue(next, "work_likely_files", "[]");
  next = replaceFrontMatterValue(next, "merge_risk_options", "[]");
  next = replaceFrontMatterValue(next, "label_justifications", "[]");
  next = replaceFrontMatterValue(next, "review_metrics", "[]");
  next = replaceFrontMatterValue(next, "root_cause_cluster", JSON.stringify(rootCauseCluster));
  next = replaceSectionValue(
    next,
    "Decision",
    [
      "Keep open: none",
      "",
      "Confidence: low",
      "",
      "Action taken: retry_stale_canonical_comment_sync",
    ].join("\n"),
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.summary,
    `Keep this PR open. ${sentence(block.reason)}`,
  );
  next = replaceSectionValue(next, REVIEW_SECTIONS.bestSolution, nextStep);
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.solutionAssessment,
    "Needs a fresh assessment because the prior canonical PR is closed without merge.",
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.rootCauseCluster,
    renderRootCauseClusterAssessmentReportSection(rootCauseCluster),
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.prRating,
    renderPrRatingAssessmentReportSection(rating, reportRealBehaviorProof(markdown)),
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.workCandidate,
    [
      "Candidate: none",
      "",
      "Confidence: low",
      "",
      "Priority: low",
      "",
      "Status: none",
      "",
      `Reason: ${nextStep}`,
    ].join("\n"),
  );
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.evidence,
    `- **live canonical state:** ${block.reason}`,
  );
  next = replaceSectionValue(next, REVIEW_SECTIONS.likelyOwners, "- none");
  next = replaceSectionValue(
    next,
    REVIEW_SECTIONS.risks,
    "- The current branch and related work need a fresh review before merge or closure.",
  );
  next = replaceSectionValue(next, REVIEW_SECTIONS.closeComment, "_No close comment posted._");
  return replaceSectionValue(
    next,
    PR_CLOSE_COVERAGE_PROOF_SECTION,
    ["Decision: keep_open", `Reason: ${block.reason}`].join("\n"),
  );
}

function staleCanonicalCommentSyncPendingReason(markdown: string): string | null {
  if (frontMatterValue(markdown, "action_taken") !== "retry_stale_canonical_comment_sync") {
    return null;
  }
  return (
    sectionLineValue(sectionValue(markdown, PR_CLOSE_COVERAGE_PROOF_SECTION), "Reason") ??
    "stale canonical close comment correction remains pending"
  );
}

function staleCanonicalPullRequestNumber(markdown: string): number | null {
  const number = Number(frontMatterValue(markdown, "stale_canonical_pull_request_number"));
  return Number.isInteger(number) && number > 0 ? number : null;
}

function completeStaleCanonicalCommentSyncReport(markdown: string): string {
  let next = replaceFrontMatterValue(markdown, "action_taken", "corrected_stale_canonical_comment");
  next = replaceFrontMatterValue(next, "stale_canonical_pull_request_number", "none");
  const decision = sectionValue(next, "Decision");
  if (!decision) return next;
  return replaceSectionValue(
    next,
    "Decision",
    decision.replace(/^Action taken: .*$/m, "Action taken: corrected_stale_canonical_comment"),
  );
}

function recommendedPauseOrCloseOption(markdown: string): MergeRiskOption | null {
  return (
    mergeRiskOptionsFromReport(markdown).find(
      (option) => option.category === "pause_or_close" && option.recommended,
    ) ?? null
  );
}

function staleFRatedPullRequestPromotion(
  markdown: string,
  item: Item,
  context: ItemContext,
  staleMinAgeDays: number,
): PullRequestClosePromotion | null {
  const proof = reportRealBehaviorProof(markdown);
  const rating = reportPrRating(markdown);
  if (rating.overallTier !== "F") return null;
  if (!isOlderThanDays(item.createdAt, staleMinAgeDays)) return null;
  if (
    proof.status !== "missing" &&
    proof.status !== "mock_only" &&
    proof.status !== "insufficient" &&
    rating.proofTier !== "F"
  ) {
    return null;
  }
  if (
    context.counts?.commentsTruncated ||
    context.counts?.timelineTruncated ||
    context.counts?.pullReviewCommentsTruncated
  ) {
    return null;
  }
  let livePull: {
    created_at?: string;
    mergeable?: boolean | null;
    mergeable_state?: string | null;
    user?: GitHubUser;
    head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
  };
  let reviews: unknown[];
  let headActivityAtMs: number | null;
  try {
    livePull = ghJson(["api", `repos/${targetRepo()}/pulls/${item.number}`]);
    if (lowSignalUnmergeablePrConflictBlockReason(livePull)) return null;
    reviews = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${item.number}/reviews`);
    headActivityAtMs = pullRequestHeadActivity(
      item.number,
      livePull,
      context.timeline,
    ).headActivityAtMs;
  } catch {
    return null;
  }
  if (
    lowSignalUnmergeablePrAuthorActivityBlockReason({
      author: livePull.user?.login ?? item.author,
      createdAt: livePull.created_at ?? item.createdAt,
      comments: context.comments,
      reviews,
      inlineComments: context.pullReviewComments ?? [],
      timeline: context.timeline,
      headActivityAtMs,
      staleMinAgeDays,
      requireHeadActivityEvidence: true,
    })
  ) {
    return null;
  }
  return {
    closeReason: "low_signal_unmergeable_pr",
    summary:
      "Close this stale PR: the latest review rated it F, it still lacks merge-ready proof, and there has been no human follow-up after the durable review.",
    coverageProofFallbackRefs: false,
    bestSolution:
      "Close this stale PR. The latest review rated it F, the branch still lacks merge-ready proof, and there has been no human follow-up after the durable review.",
    evidence: [
      `- **stale F-rated PR:** PR was opened ${item.createdAt}, is older than ${staleMinAgeDays} days, and the latest review rated it \`F\`.`,
      `- **proof blocker:** real behavior proof is \`${proof.status}\` and proof tier is \`${rating.proofTier}\`, so this branch is not merge-ready without contributor follow-up.`,
      "- **no human follow-up:** live comments and timeline hydrated by apply contain no non-automation activity after the ClawSweeper review.",
    ].join("\n"),
    closeComment:
      "Thanks for the contribution. I’m closing this stale PR because the latest ClawSweeper review rated it F, it still lacks the proof or branch shape needed for merge, and there has been no human follow-up after the review. A fresh PR against current `main` with the requested proof is the right next step.",
  };
}

function pauseOrClosePromotion(
  markdown: string,
  item: Item,
  staleMinAgeDays: number,
): PullRequestClosePromotion | null {
  const option = recommendedPauseOrCloseOption(markdown);
  if (!option || !isOlderThanDays(item.createdAt, staleMinAgeDays)) return null;
  return {
    closeReason: "duplicate_or_superseded",
    summary: `Close this stale PR as superseded: ${option.title}.`,
    coverageProofFallbackRefs: false,
    bestSolution: `Close this stale PR as superseded: ${option.title}. ${option.body}`,
    evidence: [
      `- **recommended close path:** the latest review's recommended merge-risk option is \`${option.title}\`, categorized as \`pause_or_close\`.`,
      `- **stale PR:** PR was opened ${item.createdAt}, which is older than the ${staleMinAgeDays}-day stale promotion threshold.`,
      "- **no human follow-up:** live comments and timeline hydrated by apply contain no non-automation activity after the ClawSweeper review.",
    ].join("\n"),
    closeComment: `Thanks for the contribution. I’m closing this stale PR because the latest ClawSweeper review recommended the pause/close path: ${option.title}. ${option.body}`,
  };
}

function linkedPullRequestSupersessionPromotion(
  linkedPull: LinkedPullRequestSupersession,
): PullRequestClosePromotion {
  const stateText = linkedPull.mergedAt
    ? `merged at ${linkedPull.mergedAt}`
    : "still open as the canonical replacement";
  return {
    closeReason: "duplicate_or_superseded",
    summary: `Close this PR as superseded by ${linkedPull.url}.`,
    coverageProofFallbackRefs: true,
    bestSolution: `Close this PR as superseded by ${linkedPull.url}.`,
    evidence: [
      `- **linked superseding PR:** ${linkedPull.url} (${linkedPull.title}) is ${stateText}.`,
      "- **cluster evidence:** the durable review links that PR in the work cluster or recommended risk path.",
      "- **no human follow-up:** live comments and timeline hydrated by apply contain no non-automation activity after the ClawSweeper review.",
    ].join("\n"),
    closeComment: `Thanks for the contribution. I’m closing this PR as superseded by ${linkedPull.url}, which is ${stateText}.`,
  };
}

function pullRequestClosePromotion(
  markdown: string,
  item: Item,
  context: ItemContext,
  staleMinAgeDays: number,
  options: { reportDirs?: readonly string[] } = {},
): PullRequestClosePromotion | null {
  if (item.kind !== "pull_request") return null;
  if (!reviewReportCanPromoteToClose(markdown)) return null;
  if (frontMatterValue(markdown, "decision") !== "keep_open") return null;
  if (frontMatterValue(markdown, "action_taken") !== "kept_open") return null;
  if (frontMatterValue(markdown, "review_status") !== "complete") return null;
  if (closePromotionHasNonAutomationActivityAfterReview(markdown, context)) return null;
  const linkedSupersession = linkedPullRequestSupersession(markdown, item, options);
  if (linkedSupersession.candidate) {
    return linkedPullRequestSupersessionPromotion(linkedSupersession.candidate);
  }
  const pauseOrClose = pauseOrClosePromotion(markdown, item, staleMinAgeDays);
  if (pauseOrClose) return pauseOrClose;
  // A live canonical candidate that is itself unsafe cannot justify treating the
  // source as generic low-signal work. Missing or non-covering references can.
  if (linkedSupersession.unsafeReason) return null;
  return staleFRatedPullRequestPromotion(markdown, item, context, staleMinAgeDays);
}

function workPlanPathForReport(file: string, plansDir = defaultPlansDir()): string {
  return join(plansDir, basename(file));
}

function shouldRenderWorkPlanFromReport(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "decision") === "keep_open" &&
    frontMatterValue(markdown, "action_taken") === "kept_open" &&
    frontMatterValue(markdown, "work_candidate") === "queue_fix_pr" &&
    frontMatterValue(markdown, "work_status") === "candidate" &&
    isFresh({
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      reviewStatus: effectiveReviewStatus(markdown),
    })
  );
}

function formattedMarkdownList(
  values: readonly string[],
  formatter: (value: string) => string,
): string {
  return values.length ? values.map((value) => `- ${formatter(value)}`).join("\n") : "- none";
}

function labelJustificationsMarkdown(justifications: readonly LabelJustification[]): string {
  if (!justifications.length) return "- none";
  return justifications.map((entry) => `- ${inlineCode(entry.label)}: ${entry.reason}`).join("\n");
}

function labelTransitionJustificationsMarkdown(
  justifications: readonly LabelTransitionJustification[],
): string {
  if (!justifications.length) return "- none";
  return justifications
    .map((entry) => `- ${entry.action} ${inlineCode(entry.label)}: ${entry.reason}`)
    .join("\n");
}

export function labelJustificationsMarkdownForTest(
  justifications: readonly LabelJustification[],
): string {
  return labelJustificationsMarkdown(justifications);
}

function isClawSweeperOwnedLabel(label: string): boolean {
  return (
    PRIORITY_LABEL_NAMES.has(label) ||
    IMPACT_LABEL_NAMES.has(label) ||
    MERGE_RISK_LABEL_NAMES.has(label) ||
    MATURITY_LABEL_NAMES.has(label) ||
    PR_RATING_LABEL_NAMES.has(label) ||
    PR_STATUS_LABEL_NAMES.has(label) ||
    label === FEATURE_SHOWCASE_LABEL ||
    label === PROOF_SUFFICIENT_LABEL ||
    PROOF_MEDIA_LABEL_NAMES.has(label) ||
    label === TELEGRAM_VISIBLE_PROOF_LABEL ||
    isIssueAdvisoryLabel(label)
  );
}

function desiredClawSweeperLabelsFromPublicReport(
  markdown: string,
  currentLabels: readonly string[],
  options: ReviewCommentRenderOptions = {},
): string[] {
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
  let labels = nextPriorityLabels(currentLabels, triagePriorityFromReport(markdown));
  labels = nextImpactLabels(labels, isPullRequest ? [] : impactLabelsFromReport(markdown));
  labels = nextMaturityLabels(labels, isPullRequest ? [] : maturityLabelsFromReport(markdown));
  if (isPullRequest) {
    const realBehaviorProof = reportRealBehaviorProof(markdown);
    labels = nextMergeRiskLabels(labels, mergeRiskLabelsFromReport(markdown));
    labels = nextRealBehaviorProofSufficientLabels(labels, realBehaviorProof);
    labels = nextRealBehaviorProofMediaLabels(labels, realBehaviorProof);
    labels = nextPrRatingLabels(labels, reportPrRating(markdown), reviewFailed);
    labels = nextFeatureShowcaseLabels(labels, {
      isPullRequest,
      itemCategory: frontMatterValue(markdown, "item_category"),
      requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
      showcase: reportFeatureShowcase(markdown),
      securityReview: reportSecurityReview(markdown),
      overallCorrectness: reportOverallCorrectness(markdown),
    });
    labels = nextPrStatusLabels(
      labels,
      options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown),
    );
    labels = nextTelegramVisibleProofLabels(labels, reportTelegramVisibleProof(markdown));
  } else {
    const issueOptions: { hasOpenLinkedPullRequest?: boolean } = {};
    if (options.hasOpenLinkedPullRequest !== undefined) {
      issueOptions.hasOpenLinkedPullRequest = options.hasOpenLinkedPullRequest;
    }
    labels = nextIssueAdvisoryLabels(
      labels,
      issueAdvisoryLabelStateFromReport(markdown, issueOptions),
    );
  }
  return labels;
}

function labelTransitionReason(
  markdown: string,
  label: string,
  action: LabelTransitionJustification["action"],
  finalJustifications: ReadonlyMap<string, string>,
  options: ReviewCommentRenderOptions = {},
): string {
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const realBehaviorProof = reportRealBehaviorProof(markdown);
  if (action === "add") {
    const finalReason = finalJustifications.get(label);
    if (finalReason) return finalReason;
  }
  if (PRIORITY_LABEL_NAMES.has(label)) {
    const priority = triagePriorityFromReport(markdown);
    return action === "add"
      ? `Current review triage priority is ${priority}.`
      : priority === "none"
        ? "Current review triage priority is none."
        : `Current review triage priority is ${priority}, so this older priority label is no longer current.`;
  }
  if (IMPACT_LABEL_NAMES.has(label)) {
    const labels = impactLabelsFromReport(markdown);
    return action === "add"
      ? "Current review selected this impact label."
      : labels.length
        ? `Current review impact labels are ${labels.map(inlineCode).join(", ")}.`
        : "Current review selected no impact labels.";
  }
  if (MERGE_RISK_LABEL_NAMES.has(label)) {
    const labels = mergeRiskLabelsFromReport(markdown);
    return action === "add"
      ? "Current PR review selected this merge-risk label."
      : labels.length
        ? `Current PR review merge-risk labels are ${labels.map(inlineCode).join(", ")}.`
        : "Current PR review selected no merge-risk labels.";
  }
  if (MATURITY_LABEL_NAMES.has(label)) {
    const labels = maturityLabelsFromReport(markdown);
    return action === "add"
      ? "Current issue review matched this item to a stable maturity scorecard feature."
      : labels.length
        ? `Current issue maturity labels are ${labels.map(inlineCode).join(", ")}.`
        : "Current issue review selected no maturity labels.";
  }
  if (PR_RATING_LABEL_NAMES.has(label)) {
    if (frontMatterValue(markdown, "review_status") === "failed") {
      return action === "add"
        ? "Failed reviews do not select PR readiness rating labels."
        : "Current review failed before PR readiness was assessed, so no rating label should remain.";
    }
    const rating = reportPrRating(markdown);
    const current = ratingLabelForTier(rating.overallTier).name;
    return action === "add"
      ? `Overall readiness is ${themedRatingName(rating.overallTier)}.`
      : `Current PR rating is ${inlineCode(current)}, so this older rating label is no longer current.`;
  }
  if (PR_STATUS_LABEL_NAMES.has(label)) {
    const statusKind = options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown);
    return action === "add" && statusKind
      ? prStatusLabelForKind(statusKind).description
      : statusKind
        ? `Current PR status label is ${inlineCode(prStatusLabelForKind(statusKind).name)}.`
        : "Current PR status no longer selects a status label.";
  }
  if (label === FEATURE_SHOWCASE_LABEL) {
    const showcase = reportFeatureShowcase(markdown);
    return action === "add"
      ? `${FEATURE_SHOWCASE_LABEL_DESCRIPTION} ${sentence(showcase.reason)}`
      : "Feature showcase labels are add-only; this label is no longer selected by the current review.";
  }
  if (label === PROOF_SUFFICIENT_LABEL) {
    return action === "add"
      ? `${PROOF_SUFFICIENT_LABEL_DESCRIPTION} ${sentence(realBehaviorProof.summary)}`
      : `Current real behavior proof status is ${realBehaviorProof.status}, not sufficient.`;
  }
  if (PROOF_MEDIA_LABEL_NAMES.has(label)) {
    const mediaLabel = PROOF_MEDIA_LABELS.find(
      (candidate) => candidate.evidenceKind === realBehaviorProof.evidenceKind,
    );
    return action === "add" && mediaLabel
      ? `${mediaLabel.description} ${sentence(realBehaviorProof.summary)}`
      : `Current real behavior proof evidence kind is ${realBehaviorProof.evidenceKind}.`;
  }
  if (label === TELEGRAM_VISIBLE_PROOF_LABEL) {
    const proof = reportTelegramVisibleProof(markdown);
    return action === "add"
      ? `${TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION} ${sentence(proof.summary)}`
      : `Current Telegram visible-proof status is ${proof.status}.`;
  }
  if (isIssueAdvisoryLabel(label)) {
    return isPullRequest
      ? "This advisory label applies only to issues, not pull requests."
      : action === "add"
        ? "Current issue advisory state selects this label."
        : "Current issue advisory state no longer selects this label.";
  }
  return action === "add"
    ? "Current ClawSweeper review state selects this label."
    : "Current ClawSweeper review state no longer selects this label.";
}

function labelTransitionJustificationsFromPublicReport(
  markdown: string,
  finalJustifications: readonly LabelJustification[],
  options: ReviewCommentRenderOptions = {},
): LabelTransitionJustification[] {
  const currentLabels = options.previousLabels ?? frontMatterStringArray(markdown, "labels");
  const desiredLabels = desiredClawSweeperLabelsFromPublicReport(markdown, currentLabels, options);
  const currentKeys = new Set(currentLabels.map((label) => label.toLowerCase()));
  const desiredKeys = new Set(desiredLabels.map((label) => label.toLowerCase()));
  const finalByLabel = new Map(finalJustifications.map((entry) => [entry.label, entry.reason]));
  const transitions: LabelTransitionJustification[] = [];
  for (const label of desiredLabels) {
    if (!isClawSweeperOwnedLabel(label) || currentKeys.has(label.toLowerCase())) continue;
    transitions.push({
      action: "add",
      label,
      reason: labelTransitionReason(markdown, label, "add", finalByLabel, options),
    });
  }
  for (const label of currentLabels) {
    if (!isClawSweeperOwnedLabel(label) || desiredKeys.has(label.toLowerCase())) continue;
    transitions.push({
      action: "remove",
      label,
      reason: labelTransitionReason(markdown, label, "remove", finalByLabel, options),
    });
  }
  return transitions;
}

function labelJustificationsFromPublicReport(
  markdown: string,
  options: ReviewCommentRenderOptions = {},
): LabelJustification[] {
  const justifications = labelJustificationsFromReport(markdown, {
    triagePriority: triagePriorityFromReport(markdown),
    impactLabels: impactLabelsFromReport(markdown),
    mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
    maturityLabels: maturityLabelsFromReport(markdown),
  });
  const byLabel = new Map(justifications.map((entry) => [entry.label, entry]));
  const add = (label: string | null | undefined, reason: string): void => {
    if (!label || byLabel.has(label)) return;
    byLabel.set(label, { label, reason });
  };
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const realBehaviorProof = reportRealBehaviorProof(markdown);
  if (isPullRequest && frontMatterValue(markdown, "review_status") !== "failed") {
    const rating = reportPrRating(markdown);
    const ratingLabel = ratingLabelForTier(rating.overallTier).name;
    const previousRatingLabel = frontMatterStringArray(markdown, "labels").find(
      (label) => PR_RATING_LABEL_NAMES.has(label) && label !== ratingLabel,
    );
    const changed = previousRatingLabel
      ? ` Replaced prior ${inlineCode(previousRatingLabel)}.`
      : "";
    add(
      ratingLabel,
      `Overall readiness is ${themedRatingName(rating.overallTier)}; proof is ${themedRatingName(
        rating.proofTier,
      )} and patch quality is ${themedRatingName(rating.patchTier)}.${changed}`,
    );
    const featureShowcase = reportFeatureShowcase(markdown);
    if (
      shouldApplyFeatureShowcaseLabel({
        isPullRequest,
        itemCategory: frontMatterValue(markdown, "item_category"),
        requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
        showcase: featureShowcase,
        securityReview: reportSecurityReview(markdown),
        overallCorrectness: reportOverallCorrectness(markdown),
      })
    ) {
      add(
        FEATURE_SHOWCASE_LABEL,
        `${FEATURE_SHOWCASE_LABEL_DESCRIPTION} ${sentence(featureShowcase.reason)}`,
      );
    }
    const statusKind = options.prStatusKind ?? prStatusLabelKindFromReportLabels(markdown);
    if (statusKind) {
      add(
        prStatusLabelForKind(statusKind).name,
        `${prStatusLabelForKind(statusKind).description} ${publicRealBehaviorProofLine(
          realBehaviorProof,
        )}`,
      );
    }
    if (realBehaviorProof.status === "sufficient") {
      add(
        PROOF_SUFFICIENT_LABEL,
        `${PROOF_SUFFICIENT_LABEL_DESCRIPTION} ${sentence(realBehaviorProof.summary)}`,
      );
    }
    const proofMediaLabel = PROOF_MEDIA_LABELS.find(
      (label) => label.evidenceKind === realBehaviorProof.evidenceKind,
    );
    if (proofMediaLabel) {
      add(
        proofMediaLabel.name,
        `${proofMediaLabel.description} ${sentence(realBehaviorProof.summary)}`,
      );
    }
    const telegramProof = reportTelegramVisibleProof(markdown);
    if (telegramProof.status === "needed") {
      add(
        TELEGRAM_VISIBLE_PROOF_LABEL,
        `${TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION} ${sentence(telegramProof.summary)}`,
      );
    }
  }
  return [...byLabel.values()];
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

export function renderWorkPlanFromReport(
  markdown: string,
  options: { reportPath?: string } = {},
): string | null {
  if (!shouldRenderWorkPlanFromReport(markdown)) return null;
  const repo = markdownRepository(markdown);
  const number = frontMatterValue(markdown, "number") ?? "unknown";
  const title = frontMatterValue(markdown, "title") ?? "Untitled";
  const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
  const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt").trim();
  const likelyFiles = frontMatterStringArray(markdown, "work_likely_files");
  const validation = frontMatterStringArray(markdown, "work_validation");
  const clusterRefs = frontMatterStringArray(markdown, "work_cluster_refs");
  const reportPath = options.reportPath ?? "unknown";
  return `---
number: ${number}
repository: ${repo}
title: ${JSON.stringify(title)}
source_report: ${reportPath}
reviewed_at: ${reviewedAt}
work_candidate: ${frontMatterValue(markdown, "work_candidate") ?? "none"}
work_priority: ${frontMatterValue(markdown, "work_priority") ?? "low"}
work_confidence: ${frontMatterValue(markdown, "work_confidence") ?? "low"}
---

# Coding Plan for ${repo}#${number}: ${title}

Source report: ${reportPath === "unknown" ? "unknown" : markdownLink(reportPath, reportPath)}

## Summary

${reviewSectionValue(markdown, "summary") || "No summary provided."}

## Plan

${workPrompt || "No repair work prompt provided."}

## Likely Files

${formattedMarkdownList(likelyFiles, inlineCode)}

## Validation

${formattedMarkdownList(validation, inlineCode)}

## Cluster References

${formattedMarkdownList(clusterRefs, (value) => value)}

## Notes

- This file is generated dashboard state from the durable review report.
- Regenerate it from the source report instead of editing it by hand.
`;
}

function syncWorkPlanFromReport(options: {
  markdown: string;
  reportPath: string;
  plansDir: string;
  dryRun?: boolean;
}): boolean {
  const planPath = workPlanPathForReport(options.reportPath, options.plansDir);
  const plan = renderWorkPlanFromReport(options.markdown, {
    reportPath: repoRelativePath(options.reportPath),
  });
  if (!plan) {
    if (!options.dryRun && existsSync(planPath)) unlinkSync(planPath);
    return false;
  }
  if (!options.dryRun) {
    ensureDir(dirname(planPath));
    writeFileSync(planPath, plan, "utf8");
  }
  return true;
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

function reviewTelemetryNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return String(Math.max(0, Math.round(value)));
}

function contextCountText(
  total: number | undefined,
  fallback: number,
  hydrated?: number,
  truncated?: boolean,
): string {
  const displayTotal =
    total === undefined || !Number.isFinite(total) ? Math.max(0, fallback) : Math.max(0, total);
  if (hydrated === undefined || !Number.isFinite(hydrated)) return String(displayTotal);
  const displayHydrated = Math.max(0, Math.round(hydrated));
  if (!truncated && displayHydrated >= displayTotal) return String(displayTotal);
  return `${displayTotal} (hydrated ${displayHydrated}${truncated ? ", truncated" : ""})`;
}

function promptJsonChars(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

function reviewContextLedgerEntry(options: {
  section: string;
  label: string;
  value: unknown;
  entries: number;
  total?: number | undefined;
  hydrated?: number | undefined;
  truncated?: boolean | undefined;
}): ReviewContextLedgerEntry {
  const entry: ReviewContextLedgerEntry = {
    section: options.section,
    label: options.label,
    entries: Math.max(0, Math.round(options.entries)),
    chars: promptJsonChars(options.value),
  };
  if (options.total !== undefined && Number.isFinite(options.total)) {
    entry.total = Math.max(0, Math.round(options.total));
  }
  if (options.hydrated !== undefined && Number.isFinite(options.hydrated)) {
    entry.hydrated = Math.max(0, Math.round(options.hydrated));
  }
  if (options.truncated !== undefined) entry.truncated = options.truncated;
  return entry;
}

function arrayEntries(value: unknown[] | undefined): number {
  return value?.length ?? 0;
}

function reviewContextLedger(context: ItemContext): ReviewContextLedgerEntry[] {
  const counts = context.counts;
  const entries = [
    reviewContextLedgerEntry({
      section: "issue",
      label: "issue",
      value: context.issue,
      entries: 1,
    }),
    reviewContextLedgerEntry({
      section: "comments",
      label: "comments",
      value: context.comments,
      entries: context.comments.length,
      total: counts?.comments,
      hydrated: counts?.commentsHydrated,
      truncated: counts?.commentsTruncated,
    }),
    reviewContextLedgerEntry({
      section: "timeline",
      label: "timeline events",
      value: context.timeline,
      entries: context.timeline.length,
      total: counts?.timeline,
      hydrated: counts?.timelineHydrated,
      truncated: counts?.timelineTruncated,
    }),
    reviewContextLedgerEntry({
      section: "previousClawSweeperReview",
      label: "previous ClawSweeper review",
      value: context.previousClawSweeperReview ?? null,
      entries: context.previousClawSweeperReview === undefined ? 0 : 1,
    }),
    reviewContextLedgerEntry({
      section: "closingPullRequests",
      label: "closing PRs",
      value: context.closingPullRequests ?? [],
      entries: arrayEntries(context.closingPullRequests),
      total: counts?.closingPullRequests,
    }),
    reviewContextLedgerEntry({
      section: "relatedItems",
      label: "related items",
      value: context.relatedItems ?? [],
      entries: arrayEntries(context.relatedItems),
      total: counts?.relatedItems,
    }),
    reviewContextLedgerEntry({
      section: "pullRequest",
      label: "pull request",
      value: context.pullRequest ?? null,
      entries: context.pullRequest === undefined ? 0 : 1,
    }),
    reviewContextLedgerEntry({
      section: "pullFiles",
      label: "PR files",
      value: context.pullFiles ?? [],
      entries: arrayEntries(context.pullFiles),
      total: counts?.pullFiles,
      hydrated: counts?.pullFilesHydrated,
      truncated: counts?.pullFilesTruncated,
    }),
    reviewContextLedgerEntry({
      section: "pullCommits",
      label: "PR commits",
      value: context.pullCommits ?? [],
      entries: arrayEntries(context.pullCommits),
      total: counts?.pullCommits,
      hydrated: counts?.pullCommitsHydrated,
      truncated: counts?.pullCommitsTruncated,
    }),
    reviewContextLedgerEntry({
      section: "pullReviewComments",
      label: "PR review comments",
      value: context.pullReviewComments ?? [],
      entries: arrayEntries(context.pullReviewComments),
      total: counts?.pullReviewComments,
      hydrated: counts?.pullReviewCommentsHydrated,
      truncated: counts?.pullReviewCommentsTruncated,
    }),
    reviewContextLedgerEntry({
      section: "pullChecks",
      label: "PR checks",
      value: context.pullChecks ?? null,
      entries: context.pullChecks === undefined ? 0 : 1,
    }),
    reviewContextLedgerEntry({
      section: "counts",
      label: "context counts",
      value: counts ?? {},
      entries: Object.keys(counts ?? {}).length,
    }),
  ];
  return entries.filter((entry) => entry.entries > 0 || (entry.total ?? 0) > 0);
}

export function reviewContextLedgerForTest(context: ItemContext): ReviewContextLedgerEntry[] {
  return reviewContextLedger(context);
}

function reviewContextLedgerCountText(entry: ReviewContextLedgerEntry): string {
  if (entry.total !== undefined || entry.hydrated !== undefined) {
    const total = entry.total ?? entry.entries;
    const hydrated = entry.hydrated ?? entry.entries;
    const suffix = entry.truncated ? ", truncated" : "";
    return `${hydrated}/${total} hydrated${suffix}`;
  }
  return `${entry.entries} ${entry.entries === 1 ? "entry" : "entries"}`;
}

function renderReviewContextBudget(context: ItemContext): string {
  return reviewContextLedger(context)
    .map(
      (entry) => `- ${entry.label}: ${reviewContextLedgerCountText(entry)}, ${entry.chars} chars`,
    )
    .join("\n");
}

export function renderReviewContextBudgetForTest(context: ItemContext): string {
  return renderReviewContextBudget(context);
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
  return `Codex review notes: ${parts.join("; ")}.`;
}

function closeReviewLineFromReport(markdown: string): string {
  const mainSha = frontMatterValue(markdown, "main_sha");
  const fixed = fixedInReportText(markdown);
  const parts: string[] = [runtimeReviewTextFromReport(markdown)].filter(Boolean);
  if (mainSha && mainSha !== "unknown") parts.push(`reviewed against ${linkedSha(mainSha)}`);
  if (fixed !== "not determined") parts.push(`fix evidence: ${fixed}`);
  return parts.length ? `Codex review notes: ${parts.join("; ")}.` : "";
}

function renderCloseComment(options: {
  reason: CloseReason;
  summary: string;
  bestSolution?: string;
  reproductionAssessment?: string;
  solutionAssessment?: string;
  agentsPolicyStatus?: AgentsPolicyStatus | undefined;
  evidence: Evidence[];
  likelyOwners?: LikelyOwner[];
  fixedPullRequest?: FixedPullRequest | null;
  securityReview?: SecurityReview;
  rootCauseCluster?: RootCauseClusterAssessment;
  reviewLine: string;
  currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
}): string {
  const evidence = options.evidence.slice(0, 6).map(closeEvidenceLine);
  const likelyOwners = (options.likelyOwners ?? []).slice(0, 5).map(likelyOwnerLine);
  const summaryLine = sentence(options.summary);
  const lines = [closeIntro(options.reason), "", summaryLine];
  if (options.fixedPullRequest?.confidence === "high") {
    lines.push(
      "",
      `I found the merged PR that appears to have closed this: ${markdownLink(
        `#${options.fixedPullRequest.number}: ${options.fixedPullRequest.title}`,
        options.fixedPullRequest.url,
      )}.`,
    );
  }
  const rootCauseCluster = publicRootCauseClusterBlock(options.rootCauseCluster);
  if (rootCauseCluster) lines.push("", "**Root-cause cluster**", rootCauseCluster);
  const bestSolutionLine = sentence(options.bestSolution ?? "");
  const canonicalLinks = duplicateCanonicalLinks({
    reason: options.reason,
    bestSolutionLine,
    evidence: options.evidence,
    currentItem: options.currentItem,
  });
  const canonicalPathLine = duplicateCanonicalPathLine({
    reason: options.reason,
    summaryLine,
    bestSolutionLine,
    evidence: options.evidence,
  });
  if (canonicalPathLine) lines.push("", canonicalPathLine);
  const details: string[] = [];
  if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, summaryLine)) {
    details.push("Best possible solution:", "", bestSolutionLine);
  }
  appendReviewQuestionDetails(details, options.reproductionAssessment, options.solutionAssessment);
  if (options.securityReview) {
    details.push("", "Security review:", "", securityReviewLine(options.securityReview));
    if (options.securityReview.concerns.length) {
      details.push("", ...options.securityReview.concerns.map(securityConcernDetailedLine));
    }
  }
  const agentsPolicyLine = agentsPolicyStatusLine(options.agentsPolicyStatus);
  if (agentsPolicyLine) details.push("", agentsPolicyLine);
  if (evidence.length) details.push("", "What I checked:", "", ...evidence);
  if (likelyOwners.length) details.push("", "Likely related people:", "", ...likelyOwners);

  const clawhubHandoff = closeClawHubHandoffBlock(options.reason);
  if (clawhubHandoff) lines.push("", "**ClawHub handoff**", clawhubHandoff);
  const outro = closeOutro(options.reason, canonicalLinks);
  if (outro) lines.push("", outro);
  if (options.reviewLine) details.push("", options.reviewLine);
  const detailsBlock = collapsedDetailsBlock("Review details", details);
  if (detailsBlock) lines.push("", detailsBlock);

  return lines.join("\n");
}

function renderCloseCommentFromReport(markdown: string, reason: CloseReason): string {
  return neutralizeReviewControlMarkers(
    sanitizePublicSelfReferences(
      renderCloseComment({
        reason,
        summary: reviewSectionValue(markdown, "summary"),
        bestSolution: reviewSectionValue(markdown, "bestSolution"),
        reproductionAssessment: reviewSectionValue(markdown, "reproductionAssessment"),
        solutionAssessment: reviewSectionValue(markdown, "solutionAssessment"),
        agentsPolicyStatus: reportAgentsPolicyStatus(markdown),
        evidence: reportEvidence(markdown),
        likelyOwners: reportLikelyOwners(markdown),
        fixedPullRequest: fixedPullRequestFromReport(markdown),
        securityReview: reportSecurityReview(markdown),
        rootCauseCluster: reportRootCauseCluster(markdown),
        reviewLine: closeReviewLineFromReport(markdown),
        currentItem: {
          repo: markdownRepository(markdown),
          number: Number(frontMatterValue(markdown, "number")),
          kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
        },
      }),
      Number(frontMatterValue(markdown, "number")),
      (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
    ),
  );
}

export function sanitizePublicSelfReferences(text: string, number: number, kind: ItemKind): string {
  if (!Number.isInteger(number) || number <= 0) return text;
  const noun = kind === "pull_request" ? "this PR" : "this issue";
  const escapedNumber = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selfRefSource = `#${escapedNumber}\\b`;
  const typedSelfRef = new RegExp(
    `\\b(?:Issue|issue|PR|pr|Pull request|pull request)\\s+${selfRefSource}`,
    "g",
  );
  const closingVerbSelfRef = new RegExp(
    `\\b(Fixes|fixes|Fix|fix|Closes|closes|Resolves|resolves)\\s+${selfRefSource}`,
    "g",
  );
  const selfRef = new RegExp(selfRefSource, "g");
  return text
    .replace(closingVerbSelfRef, (_match, verb: string) => `${verb} ${noun}`)
    .replace(typedSelfRef, noun)
    .replace(selfRef, noun)
    .replace(
      /(^|[.!?]\s+)(this issue|this PR)/g,
      (_match, prefix: string, value: string) =>
        `${prefix}${value[0]?.toUpperCase()}${value.slice(1)}`,
    );
}

function normalizeComment(
  decision: Decision,
  git: GitInfo,
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">,
  item?: { repo?: string; kind?: ItemKind; number?: number },
): string {
  return renderCloseComment({
    reason: decision.closeReason,
    summary: decision.summary,
    bestSolution: decision.bestSolution,
    reproductionAssessment: decision.reproductionAssessment,
    solutionAssessment: decision.solutionAssessment,
    agentsPolicyStatus: decision.agentsPolicyStatus,
    evidence: decision.evidence,
    likelyOwners: decision.likelyOwners,
    fixedPullRequest: decision.fixedPullRequest ?? null,
    securityReview: decision.securityReview,
    rootCauseCluster: decision.rootCauseCluster,
    reviewLine: closeReviewLineFromDecision(decision, git, runtime),
    currentItem: item,
  });
}

function reportWorkCandidateReason(markdown: string): string {
  const workCandidate = reviewSectionValue(markdown, "workCandidate");
  const reason = workCandidateReasonText(workCandidate);
  if (!reason || reason.startsWith("_No work-lane recommendation")) return "";
  return reason;
}

function collapsedDetailsBlock(summary: string, lines: readonly string[]): string {
  const body = lines.join("\n").trim();
  if (!body) return "";
  return ["<details>", `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
}

function agentsPolicyStatusLine(status: AgentsPolicyStatus | undefined): string {
  switch (status?.status) {
    case "found_applied":
      return "AGENTS.md: found and applied where relevant.";
    case "found_not_applicable":
      return "AGENTS.md: found, but no applicable review policy affected this item.";
    case "not_found":
      return "AGENTS.md: not found in the target repository.";
    case "conflict_not_applied":
      return "AGENTS.md: found but not applied because it conflicted with ClawSweeper's review contract.";
    case "unreadable_or_unclear":
      return "AGENTS.md: unclear because the file could not be read completely.";
    default:
      return "";
  }
}

function appendPublicSection(lines: string[], heading: string, body: string): void {
  lines.push(`**${heading}**`, body, "");
}

function appendHeadingSection(lines: string[], heading: string, body: string): void {
  lines.push(`## ${heading}`, "", body, "");
}

function publicTableCell(value: string): string {
  // Escape report-provided HTML (tags and comment openers) before inserting the
  // renderer-owned <br> tags; &lt; renders identically to a literal <.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/<(?=[a-z/!?])/gi, "&lt;")
    .replace(/\r?\n|\r/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

// A routine phrase inside a larger actionable or negated sentence ("Do not merge
// after required checks are green; rotate the token first") must not suppress the
// step, so require the routine phrase, reject negation, and re-check actionability.
function isRoutineBeforeMergeStep(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (
    !/\b(?:merge after (?:required )?checks are green|merge after maintainer review|normal (?:ci|maintainer review)|routine (?:ci|maintainer review)|ordinary (?:ci|maintainer review)|wait for (?:required |status )?(?:ci|checks|status checks)|no further action)\b/i.test(
      text,
    ) &&
    !/^(?:land|merge|ship|proceed|continue|wait)\b[^\n]{0,120}\bafter (?:normal |ordinary |routine )?maintainer review\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (/\b(?:do not|don['’]t|must not|never|not merge|except|unless|until)\b/i.test(text)) {
    return false;
  }
  return !isActionablePriorityText(text);
}

function publicBeforeMergeItems(options: {
  reviewFailed: boolean;
  proof: RealBehaviorProof;
  proofBlocked: boolean;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  risks: string;
  nextStep: string;
  decisionPending: boolean;
  patchQualityBlocked: boolean;
  requiredRatingSteps: readonly string[];
}): PublicBeforeMergeItem[] {
  const items: PublicBeforeMergeItem[] = [];
  const seen = new Set<string>();
  const add = (label: string, detail: string, identity?: { distinctKey: string }) => {
    const rawDetail = stripPriorityPrefix(detail);
    const cleanDetail = sentence(stripPriorityPrefix(detail));
    // Typed findings pass a distinct key (title and location) so independent
    // findings that share remediation wording are all kept; free-form guidance
    // still de-duplicates on the detail text across sections.
    const key = normalizePublicReviewText(
      identity ? `${identity.distinctKey} ${cleanDetail}` : cleanDetail,
    );
    if (
      !cleanDetail ||
      /^none[.!]?$/i.test(rawDetail) ||
      isReportNoneList(cleanDetail) ||
      seen.has(key) ||
      (!identity && items.some((item) => !publicReviewTextDiffers(item.detail, cleanDetail)))
    ) {
      return;
    }
    seen.add(key);
    items.push({ label, detail: cleanDetail });
  };
  const addPrioritized = (text: string, fallback: PublicPriority, label: string) => {
    for (const line of publicRiskBulletsFromText(text, fallback).split("\n")) {
      const match = line.match(/^-[ \t]+\[(P[0-2])\][ \t]+(\S.*)$/);
      // Unprioritized bullets are the ones classified as routine CI or ordinary
      // maintainer review; they are not remaining merge work.
      if (match?.[1] && match[2]) {
        add(`${label} (${match[1]})`, match[2]);
      }
    }
  };

  if (options.reviewFailed) {
    add(
      "Retry ClawSweeper review",
      "ClawSweeper must complete a fresh review before readiness is known.",
    );
  }
  if (options.proofBlocked) {
    add("Add real behavior proof", publicRealBehaviorProofLine(options.proof));
  }
  for (const finding of options.findings) {
    add(`${finding.title.trim()} (${priorityLabel(finding.priority)})`, finding.body, {
      distinctKey: `${finding.title} ${reviewFindingLocation(finding)}`,
    });
  }
  for (const concern of options.securityReview.concerns) {
    add(`Resolve security concern: ${concern.title.trim()}`, concern.body, {
      distinctKey: `security ${concern.title}`,
    });
  }
  if (
    options.securityReview.status === "needs_attention" &&
    options.securityReview.concerns.length === 0
  ) {
    add("Resolve security review attention item", options.securityReview.summary);
  }
  if (!isReportNoneList(options.risks)) addPrioritized(options.risks, "P1", "Resolve merge risk");
  // Only actionable next-step text enters the checklist: routing rationale or other
  // explanatory prose is not remaining merge work, and decision questions are
  // already represented by the decision packet.
  if (
    !isRoutineBeforeMergeStep(options.nextStep) &&
    !isRoutineCiOrReviewText(options.nextStep) &&
    isActionablePriorityText(options.nextStep) &&
    !(options.decisionPending && /\bdecision\b/i.test(options.nextStep))
  ) {
    add(`Complete next step (${publicPriorityFromText(options.nextStep, "P2")})`, options.nextStep);
  }
  // Routine advice never becomes a merge blocker; a step that deduplicates against
  // an existing item still counts as represented remediation.
  let ratingRemediationRepresented = false;
  for (const step of options.requiredRatingSteps) {
    if (isRoutineBeforeMergeStep(step) || isRoutineCiOrReviewText(step)) continue;
    const cleanStep = sentence(stripPriorityPrefix(step));
    if (!cleanStep || /^none[.!]?$/i.test(cleanStep) || isReportNoneList(cleanStep)) continue;
    ratingRemediationRepresented = true;
    add("Improve patch quality", step);
  }
  // A blocked patch rating must always leave a concrete follow-up, even when the
  // rating supplied no usable next steps and no typed findings explain the block.
  if (
    options.patchQualityBlocked &&
    !ratingRemediationRepresented &&
    options.findings.length === 0 &&
    options.securityReview.concerns.length === 0
  ) {
    add(
      "Improve patch quality",
      "Address the low patch-quality rating before merge; see the review scores for what is holding it back.",
    );
  }

  return items;
}

// Checklist entries are list items, not table cells; only flatten newlines so
// downstream consumers of the checklist see command/path text unaltered.
function publicChecklistText(value: string): string {
  // Flatten line breaks (with their surrounding layout indentation) only; interior
  // runs of spaces inside commands, quoted arguments, and paths stay exact.
  return value
    .replace(/<(?=[a-z/!?])/gi, "&lt;")
    .replace(/[ \t]*(?:\r?\n|\r)+[ \t]*/g, " ")
    .trim();
}

// Labels are wrapped in renderer-owned bold markers, so Markdown delimiters inside
// report-provided titles must be escaped or they would break the bold span and the
// downstream label-stripping parsers.
function publicChecklistLabel(value: string): string {
  return publicChecklistText(value)
    .replace(/\\/g, "\\\\")
    .replace(/([*_`[\]])/g, "\\$1");
}

function publicBeforeMergeBlock(items: readonly PublicBeforeMergeItem[]): string {
  if (items.length === 0) return "None.";
  return items
    .map(
      (item) =>
        `- [ ] **${publicChecklistLabel(item.label)}** - ${publicChecklistText(item.detail)}`,
    )
    .join("\n");
}

function publicRootCauseClusterBlock(cluster: RootCauseClusterAssessment | undefined): string {
  if (
    !cluster ||
    cluster.confidence !== "high" ||
    !cluster.canonicalRef ||
    cluster.members.length === 0 ||
    ["independent", "security_route", "needs_human"].includes(cluster.currentItemRelationship)
  ) {
    return "";
  }
  const visibleMembers = cluster.members.slice(0, 5);
  const memberLines = visibleMembers.map(
    (member) => `- \`${member.relationship}\`: ${member.ref} - ${sentence(member.reason)}`,
  );
  if (cluster.members.length > visibleMembers.length) {
    memberLines.push(`- ${cluster.members.length - visibleMembers.length} more in the report.`);
  }
  return [
    `Relationship: \`${cluster.currentItemRelationship}\``,
    `Canonical: ${cluster.canonicalRef}`,
    `Summary: ${sentence(cluster.summary)}`,
    "",
    "Members:",
    ...memberLines,
    "",
    "Proposal only: this assessment does not dispatch repair, suppress jobs, mutate sibling items, close, or merge anything.",
  ].join("\n");
}

function publicReproducibilityLine(reproductionAssessment: string): string {
  const assessmentLine = sentence(reproductionAssessment);
  if (!assessmentLine) return "";
  const match = assessmentLine.match(/^(yes|no|unclear|not applicable)\b/i);
  if (!match) return `Reproducibility: ${assessmentLine}`;
  const status = match[1]?.toLowerCase() ?? "";
  const detail = sentence(assessmentLine.slice(match[0].length).replace(/^[\s,.:;-]+/, ""));
  return `Reproducibility: ${status}.${detail ? ` ${detail}` : ""}`;
}

function publicSummaryBody(summaryLine: string, reproductionAssessment: string): string {
  return [summaryLine, publicReproducibilityLine(reproductionAssessment)]
    .filter(Boolean)
    .join("\n\n");
}

function publicMergeRiskLine(
  risks: string,
  nextStepLine: string,
  bestSolutionLine: string,
  options: readonly MergeRiskOption[],
): string {
  if (isReportNoneList(risks)) return "";
  if (publicReviewTextIsSame(risks, nextStepLine)) return "";
  if (bestSolutionLine && publicReviewTextIsSame(risks, bestSolutionLine)) return "";
  const choices = options.length
    ? mergeRiskOptionsLines(options)
    : mergeRiskFallbackOptionsLines(bestSolutionLine, nextStepLine);
  return choices.length ? ["**Maintainer options:**", ...choices].join("\n") : "";
}

function mergeRiskFallbackOptionsLines(bestSolutionLine: string, nextStepLine: string): string[] {
  const recommended = sentence(bestSolutionLine) || sentence(nextStepLine);
  const instruction = recommended || "Decide whether the merge risk is acceptable before merging.";
  return mergeRiskOptionsLines([
    {
      title: "Decide the mitigation before merge",
      body: instruction,
      category: "fix_before_merge",
      recommended: false,
      automergeInstruction: "",
    },
    {
      title: "Pause or close",
      body: "Do not merge this PR until maintainers decide whether the risk is worth taking.",
      category: "pause_or_close",
      recommended: false,
      automergeInstruction: "",
    },
  ]);
}

function mergeRiskOptionsLines(options: readonly MergeRiskOption[]): string[] {
  const lines = options.flatMap((option, index) => [
    `${index + 1}. **${option.title}${option.recommended ? " (recommended)" : ""}**  `,
    `   ${option.body}`,
  ]);
  const recommendedRepair = options.find(
    (option) =>
      option.recommended &&
      option.category === "fix_before_merge" &&
      option.automergeInstruction.trim(),
  );
  if (recommendedRepair) {
    lines.push("", mergeRiskAutomergeInstructionBlock(recommendedRepair.automergeInstruction));
  }
  return lines;
}

function mergeRiskAutomergeInstructionBlock(instruction: string): string {
  const specialInstructions = normalizeMergeRiskAutomergeInstruction(instruction);
  if (!specialInstructions) return "";
  return [
    "<details>",
    "<summary>Copy recommended automerge instruction</summary>",
    "",
    "```text",
    "@clawsweeper automerge",
    "",
    "Special instructions:",
    specialInstructions,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function normalizeMergeRiskAutomergeInstruction(instruction: string): string {
  return instruction
    .trim()
    .replace(/^@clawsweeper\s+(?:automerge|autofix)\b[:\s-]*/i, "")
    .replace(/^special instructions:\s*/i, "")
    .replace(/^this PR:\s*/i, "")
    .trim();
}

function issueReproductionHelpSuggestions(markdown: string): string[] {
  if (frontMatterValue(markdown, "type") !== "issue") return [];
  const reproductionStatus = frontMatterValue(markdown, "reproduction_status");
  const reproductionConfidence = frontMatterValue(markdown, "reproduction_confidence");
  if (reproductionStatus === "reproduced" && reproductionConfidence === "high") return [];
  const reproductionAssessment = sentence(reviewSectionValue(markdown, "reproductionAssessment"));
  if (/^yes\b/i.test(reproductionAssessment)) return [];
  const sections = [
    reviewSectionValue(markdown, "summary"),
    reproductionAssessment,
    reviewSectionValue(markdown, "solutionAssessment"),
    reviewSectionValue(markdown, "evidence"),
    reviewSectionValue(markdown, "risks"),
  ];
  const text = sections.join("\n").toLowerCase();
  const suggestions: string[] = [];
  const hasMedia = /\b(?:screenshot|screen shot|video|recording|gif|image)\b/i.test(text);
  const hasSteps = /\b(?:step|steps|command|run|click|launch|workflow)\b/i.test(text);
  const hasExpectedActual = /\bexpected\b/i.test(text) && /\bactual\b/i.test(text);
  const hasLogs = /\b(?:log|logs|terminal|console|stack trace|traceback|output|error)\b/i.test(
    text,
  );
  const hasVersionContext =
    /\b(?:version|platform|os|macos|windows|linux|browser|provider|channel|config|settings)\b/i.test(
      text,
    );
  if (!hasMedia) {
    suggestions.push("Add a screenshot or short recording showing the behavior.");
  }
  if (!hasSteps) {
    suggestions.push("Include the exact command, prompt, or workflow that triggered it.");
  }
  if (!hasExpectedActual) {
    suggestions.push("Add expected vs actual behavior.");
  }
  if (!hasLogs) {
    suggestions.push("Include redacted logs or terminal output.");
  }
  if (!hasVersionContext) {
    suggestions.push("Share version, platform, channel/provider, and relevant config details.");
  }
  return suggestions.slice(0, 3);
}

function appendReviewQuestionDetails(
  details: string[],
  reproductionAssessment: string | undefined,
  solutionAssessment: string | undefined,
): void {
  const append = (heading: string, body: string) => {
    if (details.length) details.push("");
    details.push(heading, "", body);
  };
  const reproductionLine = sentence(reproductionAssessment ?? "");
  if (reproductionLine) {
    append("Do we have a high-confidence way to reproduce the issue?", reproductionLine);
  }
  const solutionLine = sentence(solutionAssessment ?? "");
  if (solutionLine) {
    append("Is this the best way to solve the issue?", solutionLine);
  }
}

function reviewWorkflowLines(): string[] {
  return [
    "- ClawSweeper keeps one durable marker-backed review comment per issue or PR.",
    "- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments.",
    "- A fresh review can be triggered by eligible `@clawsweeper re-review` comments, exact-item GitHub events, scheduled/background review runs, or manual workflow dispatch.",
    "- PR/issue authors and users with repository write access can comment `@clawsweeper re-review` or `@clawsweeper re-run` on an open PR or issue to request a fresh review only.",
    "- Maintainers can also comment `@clawsweeper review` to request a fresh review only.",
    "- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge.",
    "- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`.",
    "- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation.",
  ];
}

function reviewWorkflowCallout(): string[] {
  return [collapsedDetailsBlock("How this review workflow works", reviewWorkflowLines()), ""];
}

function reviewFreshnessText(markdown: string): string {
  const timestamp = formatReviewFreshnessTimestamp(frontMatterValue(markdown, "reviewed_at"));
  return timestamp ? ` _Reviewed ${timestamp}._` : "";
}

const REVIEW_HISTORY_RENDER_SLOT = "CLAWSWEEPER_REVIEW_HISTORY_RENDER_SLOT";

const OWNED_REVIEW_SECTION_HEADINGS = new Set([
  "summary",
  "what this changes",
  "merge readiness",
  "review scores",
  "verification",
  "how this fits together",
  "decision needed",
  "before merge",
  "next step",
  "next step before merge",
  "automerge follow-up",
  "autofix follow-up",
  "findings",
  "review findings",
  "security",
  "label changes",
]);

// Model-generated text is rendered above renderer-owned sections such as
// "## Before merge", and downstream routing extracts those sections from the first
// matching Markdown heading. Escape heading-shaped lines in model text so injected
// content can never spoof a renderer-owned section boundary.
function neutralizeOwnedSectionSpoofing(value: string): string {
  // GitHub normalizes CRLF and bare CR to line endings, so normalize first or a
  // bare-CR line break could smuggle a heading past the per-line checks.
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      // Strip blockquote/list container prefixes so nested heading constructs are
      // neutralized too.
      // CommonMark accepts blockquotes without a following space and ordered lists
      // with either "1." or "1)".
      const containerPrefix =
        line.match(/^[ \t]*(?:(?:>|(?:[-*+]|\d+[.)])[ \t])[ \t]*)*/)?.[0] ?? "";
      // Escape every raw HTML delimiter (renderer-emitted <br> excepted) so inline
      // tags and comment openers cannot restructure or hide trusted sections;
      // &lt; renders identically to a literal <.
      const content = line.slice(containerPrefix.length).replace(/<(?!br\s*\/?>)/gi, "&lt;");
      const trimmed = content.trim();
      if (/^#{1,6}\s+\S/.test(trimmed)) {
        return `${containerPrefix}${content.replace("#", "\\#")}`;
      }
      if (/^\*\*[^*\n]+\*\*:?\s*$/.test(trimmed)) {
        return `${containerPrefix}${content.replace("**", "\\*\\*")}`;
      }
      if (/^(?:```|~~~)/.test(trimmed)) {
        return `${containerPrefix}${content.replace(/[`~]/, "\\$&")}`;
      }
      // A run of = or - alone on a line is a Setext underline that would promote the
      // previous line to a heading.
      if (/^(?:=+|-+)[ \t]*$/.test(trimmed)) {
        return `${containerPrefix}${content.replace(/[=-]/, "\\$&")}`;
      }
      if (
        trimmed.endsWith(":") &&
        OWNED_REVIEW_SECTION_HEADINGS.has(trimmed.slice(0, -1).trim().toLowerCase())
      ) {
        return `${containerPrefix}${content.trimEnd().slice(0, -1)}&#58;`;
      }
      return `${containerPrefix}${content}`;
    })
    .join("\n");
}

// The review prompt and schema require Mermaid flowchart source with no code fences,
// click directives, URLs, HTML, or initialization/styling directives. The diagram is
// model output that crosses into a trusted bot comment, so enforce that allowlist
// here and drop the diagram entirely when it does not comply.
function sanitizeArchitectureDiagram(value: string): string {
  const diagram = value.trim();
  if (!diagram || diagram.length > 4000) return "";
  if (!/^flowchart\b/i.test(diagram)) return "";
  // No fence-breaking backticks, node metadata (image/icon nodes), HTML tags, init
  // directives, or URLs of any form, including scheme-relative and data: URLs.
  if (diagram.includes("`") || diagram.includes("~~~") || diagram.includes("@{")) return "";
  if (/<[a-z!/]/i.test(diagram)) return "";
  // Heading-shaped lines could terminate the report section the diagram is
  // serialized into; Mermaid flowcharts never need a leading #.
  if (/^[ \t]*#/m.test(diagram)) return "";
  if (/%%\{/.test(diagram)) return "";
  if (diagram.includes("//")) return "";
  // Require a non-space after the colon so human-readable labels such as
  // "Data: PR input" are not mistaken for data:/file: URLs.
  if (/\b(?:data|javascript|vbscript|https?|ftp|file|blob|mailto):\S/i.test(diagram)) return "";
  // The declaration line must be exactly "flowchart <direction>" so no further
  // statement can hide after it on the same line.
  const declarationLine = diagram.split(/\r?\n/, 1)[0] ?? "";
  if (!/^flowchart[ \t]+(?:LR|RL|TB|BT|TD)[ \t]*;?[ \t]*$/i.test(declarationLine)) return "";
  // Interaction and styling directives start a statement (newline- or
  // semicolon-separated); the same words are fine inside human-readable node labels.
  for (const statement of diagram.split(/[;\r\n]+/)) {
    if (/^\s*(?:click|style|classDef|class|linkStyle)\b/i.test(statement)) return "";
  }
  // Directive shapes are also rejected mid-line, where Mermaid can begin a new
  // statement without a separator.
  if (/\bclick[ \t]+[\w-]+[ \t]+(?:href|call)\b/i.test(diagram)) return "";
  if (/\b(?:style|linkStyle)[ \t]+[\w-]+[ \t]+[\w-]+[ \t]*:/i.test(diagram)) return "";
  if (/\bclassDef[ \t]+[\w-]+[ \t]+[\w-]+[ \t]*:/i.test(diagram)) return "";
  return diagram;
}

function reviewHistoryForRender(
  markdown: string,
  previousReviewCommentBody: string | undefined,
): ReviewHistoryLedger {
  if (frontMatterValue(markdown, "type") !== "pull_request") {
    return { cycles: [], totalCompletedCycles: 0 };
  }
  const body = previousReviewCommentBody ?? "";
  if (!body.trim()) return { cycles: [], totalCompletedCycles: 0 };
  const history = parseReviewHistory(body);
  const previousCycle = reviewHistoryCycleFromCommentBody(body);
  if (!previousCycle) return history;
  const reviewedAt = frontMatterValue(markdown, "reviewed_at");
  if (reviewedAt && previousCycle.reviewedAt === reviewedAt) return history;
  return appendReviewHistoryCycle(history, previousCycle);
}

function reviewHistoryForStaleComment(
  previousReviewCommentBody: string | undefined,
): ReviewHistoryLedger {
  const body = previousReviewCommentBody ?? "";
  const history = parseReviewHistory(body);
  return appendReviewHistoryCycle(history, reviewHistoryCycleFromCommentBody(body));
}

function renderKeepOpenCommentFromReport(
  markdown: string,
  options: ReviewCommentRenderOptions = {},
): string {
  // Keep the full list for verification counts; only the rendered evidence list is
  // abbreviated.
  const allEvidenceEntries = reportEvidence(markdown);
  const evidenceEntries = allEvidenceEntries.slice(0, 6);
  const evidence = evidenceEntries.map(closeEvidenceLine);
  const likelyOwners = reportLikelyOwners(markdown).slice(0, 5).map(likelyOwnerLine);
  const reviewFindings = reportReviewFindings(markdown);
  const securityReview = reportSecurityReview(markdown);
  const realBehaviorProof = reportRealBehaviorProof(markdown);
  const prRating = reportPrRating(markdown);
  const mantisRecommendation = reportMantisRecommendation(markdown);
  const agentsPolicyStatus = reportAgentsPolicyStatus(markdown);
  const rootCauseCluster = reportRootCauseCluster(markdown);
  const summary = reviewSectionValue(markdown, "summary");
  const changeSummary = reviewSectionValue(markdown, "changeSummary");
  const systemContext = neutralizeOwnedSectionSpoofing(
    reviewSectionValue(markdown, "systemContext"),
  );
  const architectureDiagram = sanitizeArchitectureDiagram(
    reviewSectionValue(markdown, "architectureDiagram"),
  );
  const bestSolution = reviewSectionValue(markdown, "bestSolution");
  const reproductionAssessment = reviewSectionValue(markdown, "reproductionAssessment");
  const solutionAssessment = reviewSectionValue(markdown, "solutionAssessment");
  const risks = reviewSectionValue(markdown, "risks");
  const mergeRiskOptions = mergeRiskOptionsFromReport(markdown);
  const reviewMetrics = reviewMetricsFromReport(markdown);
  const workReason = reportWorkCandidateReason(markdown);
  const workCandidate = frontMatterValue(markdown, "work_candidate");
  const isPullRequest = frontMatterValue(markdown, "type") === "pull_request";
  const reviewFailed = frontMatterValue(markdown, "review_status") === "failed";
  const validation = frontMatterStringArray(markdown, "work_validation")
    .slice(0, 5)
    .map((step) =>
      isPullRequest ? publicPriorityBulletFromText(step, "P1") : `- ${stripPriorityPrefix(step)}`,
    );
  const isRepairCandidate = workCandidate === "queue_fix_pr";
  const isRepairLoopPass = isPullRequest && Boolean(repairLoopPassModeFromReport(markdown));
  const hasRealBehaviorProofBlocker =
    isPullRequest && !reviewFailed && realBehaviorProofBlocksMerge(markdown);
  const summaryLine = neutralizeOwnedSectionSpoofing(sentence(summary)) || "_No summary provided._";
  const changeSummaryLine =
    neutralizeOwnedSectionSpoofing(sentence(changeSummary || summary)) ||
    "_No change summary provided._";
  const fallbackNextStep =
    "Continue tracking this item until the missing behavior is implemented or a maintainer decides the product direction.";
  const nextStepLine = sentence(
    workReason || bestSolution || (isPullRequest ? "" : fallbackNextStep),
  );
  const publicNextStepLine = isPullRequest
    ? hasRealBehaviorProofBlocker
      ? publicPriorityBulletFromText(nextStepLine, "P1")
      : publicPriorityBulletIfActionable(nextStepLine, "P2")
    : nextStepLine;
  const bestSolutionLine = sentence(bestSolution);
  const mergeRiskLine = isPullRequest
    ? publicMergeRiskLine(risks, nextStepLine, bestSolutionLine, mergeRiskOptions)
    : "";
  const reviewDetails: string[] = [];
  const labelDetails: string[] = [];
  const evidenceDetails: string[] = [];
  const triagePriority = triagePriorityFromReport(markdown);
  const hasReviewFindings = isPullRequest && reviewFindings.length > 0;
  const verdictLine = reviewFailed
    ? "ClawSweeper review: did not complete due to Codex infrastructure failure."
    : hasRealBehaviorProofBlocker
      ? "Codex review: needs real behavior proof before merge."
      : isRepairLoopPass
        ? "Codex review: passed."
        : isPullRequest && isRepairCandidate
          ? "Codex review: needs changes before merge."
          : hasReviewFindings
            ? "Codex review: found issues before merge."
            : isPullRequest
              ? "Codex review: needs maintainer review before merge."
              : "Codex review: keeping this open for maintainer follow-up; there is still a little grit to resolve.";
  const lines = [`${verdictLine}${reviewFreshnessText(markdown)}`, ""];
  const prSurface = renderOpenClawPrSurfaceFromReport(markdown);
  const dataModelWarning = renderDataModelWarningFromReport(markdown);
  const rootCauseClusterBlock = publicRootCauseClusterBlock(rootCauseCluster);
  const mantisSuggestion = isPullRequest
    ? publicMantisRecommendationBlock(mantisRecommendation)
    : "";
  const unsupportedMantisSuggestion = isPullRequest
    ? publicNonDispatchableMantisRecommendationBlock(mantisRecommendation)
    : "";
  // The decision rationale is model text rendered above owned sections; escape
  // heading-shaped lines so it cannot spoof them.
  const decisionPacketBlock = neutralizeOwnedSectionSpoofing(
    renderDecisionPacketPublicBlock(markdown),
  );
  const securityLine = publicSecurityReviewLine(securityReview);
  if (bestSolutionLine && publicReviewTextDiffers(bestSolutionLine, nextStepLine)) {
    reviewDetails.push("Best possible solution:", "", bestSolutionLine);
  }
  appendReviewQuestionDetails(reviewDetails, reproductionAssessment, solutionAssessment);
  const labelJustifications = labelJustificationsFromPublicReport(markdown, options);
  const labelTransitionJustifications = labelTransitionJustificationsFromPublicReport(
    markdown,
    labelJustifications,
    options,
  );
  if (labelTransitionJustifications.length) {
    labelDetails.push(
      "Label changes:",
      "",
      labelTransitionJustificationsMarkdown(labelTransitionJustifications),
    );
  }
  if (labelJustifications.length) {
    if (labelDetails.length) labelDetails.push("");
    labelDetails.push(
      "Label justifications:",
      "",
      labelJustificationsMarkdown(labelJustifications),
    );
  }
  if (isPullRequest && reviewFindings.length) {
    reviewDetails.push(
      ...(reviewDetails.length ? [""] : []),
      "Full review comments:",
      "",
      ...reviewFindings.map(reviewFindingDetailedLine),
      "",
      `Overall correctness: ${reportOverallCorrectness(markdown)}`,
      `Overall confidence: ${confidenceText(reportOverallConfidenceScore(markdown))}`,
    );
  }
  if (securityReview.concerns.length) {
    evidenceDetails.push(
      ...(evidenceDetails.length ? [""] : []),
      "Security concerns:",
      "",
      ...securityReview.concerns.map(securityConcernDetailedLine),
    );
  }
  const agentsPolicyLine = agentsPolicyStatusLine(agentsPolicyStatus);
  if (agentsPolicyLine) {
    reviewDetails.push(...(reviewDetails.length ? [""] : []), agentsPolicyLine);
  }
  if (validation.length) {
    evidenceDetails.push(
      ...(evidenceDetails.length ? [""] : []),
      "Acceptance criteria:",
      "",
      ...validation,
    );
  }
  if (evidence.length) {
    evidenceDetails.push(
      ...(evidenceDetails.length ? [""] : []),
      "What I checked:",
      "",
      ...evidence,
    );
  }
  if (likelyOwners.length) {
    evidenceDetails.push(
      ...(evidenceDetails.length ? [""] : []),
      "Likely related people:",
      "",
      ...likelyOwners,
    );
  }
  if (
    !isReportNoneList(risks) &&
    !mergeRiskLine &&
    publicReviewTextDiffers(risks, nextStepLine) &&
    (!bestSolutionLine || publicReviewTextDiffers(risks, bestSolutionLine))
  ) {
    reviewDetails.push(
      ...(reviewDetails.length ? [""] : []),
      "Remaining risk / open question:",
      "",
      isPullRequest ? publicRiskBulletsFromText(risks, "P2") : risks,
    );
  }
  const reviewLine = closeReviewLineFromReport(markdown);
  if (reviewLine) reviewDetails.push(...(reviewDetails.length ? [""] : []), reviewLine);
  const reviewHistoryBlock = renderReviewHistorySection(
    reviewHistoryForRender(markdown, options.previousReviewCommentBody),
  );

  if (isPullRequest) {
    // When patch quality itself blocks readiness, the rating's remediation steps are
    // required work, not optional rank-up advice.
    const patchQualityBlocked =
      !reviewFailed && (prRating.patchTier === "F" || prRating.patchTier === "D");
    const beforeMergeItems = publicBeforeMergeItems({
      reviewFailed,
      proof: realBehaviorProof,
      proofBlocked: hasRealBehaviorProofBlocker,
      findings: reviewFindings,
      securityReview,
      risks,
      nextStep: nextStepLine,
      decisionPending: Boolean(decisionPacketBlock),
      patchQualityBlocked,
      requiredRatingSteps: patchQualityBlocked ? prRating.nextSteps : [],
    });
    lines.push("# ClawSweeper review", "");
    appendHeadingSection(lines, "What this changes", changeSummaryLine);
    appendHeadingSection(
      lines,
      "Merge readiness",
      reviewFailed
        ? publicFailedReviewReadinessBlock(markdown)
        : publicMergeReadinessBlock(
            prRating,
            realBehaviorProof,
            triagePriority,
            summaryLine,
            // An outstanding maintainer decision is remaining work even though it
            // lives outside the checklist.
            beforeMergeItems.length + (decisionPacketBlock ? 1 : 0),
            Boolean(decisionPacketBlock),
            pullHeadShaFromReport(markdown) ?? "",
          ),
    );
    if (!reviewFailed) {
      appendHeadingSection(
        lines,
        "Review scores",
        publicReviewScoresBlock(prRating, realBehaviorProof, reviewFindings, securityReview),
      );
      appendHeadingSection(
        lines,
        "Verification",
        publicVerificationBlock(
          realBehaviorProof,
          allEvidenceEntries,
          reviewFindings,
          securityReview,
        ),
      );
    }
    if (systemContext && architectureDiagram) {
      appendHeadingSection(
        lines,
        "How this fits together",
        `${systemContext}\n\n\`\`\`mermaid\n${architectureDiagram}\n\`\`\``,
      );
    }
    if (decisionPacketBlock) {
      appendHeadingSection(lines, "Decision needed", decisionPacketBlock);
    }
    appendHeadingSection(lines, "Before merge", publicBeforeMergeBlock(beforeMergeItems));
    if (reviewFindings.length || securityReview.concerns.length) {
      appendHeadingSection(
        lines,
        "Findings",
        [
          ...reviewFindings.slice(0, 3).map(reviewFindingSummaryLine),
          ...securityReview.concerns.slice(0, 3).map(securityConcernSummaryLine),
        ].join("\n"),
      );
    }

    const agentDetails: string[] = ["### Security", "", securityLine || "None."];
    if (prSurface) agentDetails.push("", "### PR surface", "", prSurface);
    agentDetails.push("", "### Review metrics", "", renderReviewMetricsDigest(reviewMetrics));
    if (dataModelWarning) {
      agentDetails.push("", "### Stored data model", "", dataModelWarning);
    }
    if (rootCauseClusterBlock) {
      agentDetails.push("", "### Root-cause cluster", "", rootCauseClusterBlock);
    }
    if (mantisSuggestion) {
      agentDetails.push("", "### Mantis proof suggestion", "", mantisSuggestion);
    }
    if (unsupportedMantisSuggestion) {
      agentDetails.push("", "### Proof path suggestion", "", unsupportedMantisSuggestion);
    }
    if (mergeRiskLine) {
      // Routine risks are not counted as Before-merge work, so keep their text
      // visible next to the maintainer options even when actionable risks coexist.
      const riskBullets = !isReportNoneList(risks) ? publicRiskBulletsFromText(risks, "P1") : "";
      const routineRiskContext = riskBullets
        .split("\n")
        .filter((line) => line.startsWith("- ") && !/^- \[P[0-2]\]/.test(line))
        .join("\n");
      agentDetails.push(
        "",
        "### Merge-risk options",
        "",
        ...(routineRiskContext ? [routineRiskContext, ""] : []),
        mergeRiskLine,
      );
    }
    if (reviewDetails.length) {
      agentDetails.push("", "### Technical review", "", ...reviewDetails);
    }
    if (labelDetails.length) {
      agentDetails.push("", "### Labels", "", ...labelDetails);
    }
    if (evidenceDetails.length) {
      agentDetails.push("", "### Evidence", "", ...evidenceDetails);
    }
    const rankUpMoves = prRating.nextSteps
      .map((step) => sentence(step))
      .filter((step) => step && !isReportNoneList(step) && !/^none[.!]?$/i.test(step));
    if (!reviewFailed && !patchQualityBlocked && rankUpMoves.length) {
      agentDetails.push(
        "",
        "### Rank-up moves",
        "",
        "Optional improvements that raise the rating; they are not merge blockers.",
        "",
        rankUpMoves.map((step) => `- ${publicChecklistText(step)}`).join("\n"),
      );
    }
    if (!reviewFailed) {
      agentDetails.push("", "### Rating scale", "", publicRankDetailsBlock());
    }
    agentDetails.push("", "### Workflow", "", ...reviewWorkflowLines());
    if (reviewHistoryBlock) {
      agentDetails.push("", "### History", "", REVIEW_HISTORY_RENDER_SLOT);
    }
    lines.push("", collapsedDetailsBlock("<strong>Agent review details</strong>", agentDetails));
  } else {
    appendPublicSection(lines, "Summary", publicSummaryBody(summaryLine, reproductionAssessment));
    if (rootCauseClusterBlock) {
      appendPublicSection(lines, "Root-cause cluster", rootCauseClusterBlock);
    }
    const reproductionHelp = issueReproductionHelpSuggestions(markdown);
    if (reproductionHelp.length) {
      appendPublicSection(
        lines,
        "Ways to help us reproduce this",
        reproductionHelp.map((suggestion) => `- ${suggestion}`).join("\n"),
      );
    }
    if (decisionPacketBlock) {
      appendPublicSection(lines, "Maintainer decision needed", decisionPacketBlock);
    }
    appendPublicSection(lines, "Next step", publicNextStepLine);
    if (securityReview.status !== "not_applicable" || securityReview.concerns.length > 0) {
      appendPublicSection(lines, "Security", securityLine);
    }
    const detailsBlock = collapsedDetailsBlock("Review details", reviewDetails);
    if (detailsBlock) lines.push("", detailsBlock);
    const labelDetailsBlock = collapsedDetailsBlock("Label changes", labelDetails);
    if (labelDetailsBlock) lines.push("", labelDetailsBlock);
    const evidenceDetailsBlock = collapsedDetailsBlock("Evidence reviewed", evidenceDetails);
    if (evidenceDetailsBlock) lines.push("", evidenceDetailsBlock);
    lines.push("", ...reviewWorkflowCallout());
  }
  const publicBody = neutralizeReviewControlMarkers(
    sanitizePublicSelfReferences(
      lines.join("\n"),
      Number(frontMatterValue(markdown, "number")),
      (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
    ),
  );
  if (!reviewHistoryBlock) return publicBody;
  // Issues keep the pre-redesign trailing history block; only PRs moved it into the
  // collapsed details slot.
  if (!isPullRequest) return `${publicBody.trimEnd()}\n\n${reviewHistoryBlock}\n`;
  // The slot is always the renderer-appended last occurrence; report text earlier in
  // the body could mention the sentinel, and a plain replace would expand $-sequences.
  const slotIndex = publicBody.lastIndexOf(REVIEW_HISTORY_RENDER_SLOT);
  if (slotIndex < 0) return publicBody;
  return (
    publicBody.slice(0, slotIndex) +
    reviewHistoryBlock +
    publicBody.slice(slotIndex + REVIEW_HISTORY_RENDER_SLOT.length)
  );
}

export function renderReviewCommentFromReport(
  markdown: string,
  reason: CloseReason,
  options: ReviewCommentRenderOptions = {},
): string {
  const decision = frontMatterValue(markdown, "decision");
  const requiresMaintainerDecision = maintainerDecisionFromReport(markdown)?.required === true;
  const body =
    decision === "close" &&
    reason !== "none" &&
    (!requiresMaintainerDecision ||
      reason === "unsponsored_feature_request" ||
      reason === "author_pr_budget_exceeded")
      ? renderCloseCommentFromReport(markdown, reason)
      : renderKeepOpenCommentFromReport(markdown, options);
  const markers = options.suppressAutomationMarkers
    ? ""
    : reviewAutomationMarkersFromReport(markdown);
  return [body.trimEnd(), markers, reviewVersionMarkerFromReport(markdown)]
    .filter(Boolean)
    .join("\n\n");
}

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

function pullRequestHeadSha(number: number): string {
  const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
  const sha = asRecord(pull.head).sha;
  return typeof sha === "string" ? sha.trim().toLowerCase() : "";
}

function currentReviewRevision(item: Item): string {
  if (item.kind === "pull_request") return pullRequestHeadSha(item.number);
  const revision = collectItemContext(item, { fullTimelineForRelations: true }).sourceRevision;
  return typeof revision === "string" ? revision : "";
}

function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
  if (options.kind === "pull_request") {
    ghObservedMutationCommand({
      identity: `item_close:${options.number}:${options.kind}:${options.reason}`,
      args: ["pr", "close", String(options.number)],
    });
  } else {
    const reason = isImplementationCloseReason(options.reason) ? "completed" : "not_planned";
    const closePayloadFile = join(ROOT, ".artifacts", `close-${options.number}.json`);
    writeFileSync(
      closePayloadFile,
      JSON.stringify({ state: "closed", state_reason: reason }),
      "utf8",
    );
    ghObservedMutationCommand({
      identity: `item_close:${options.number}:${options.kind}:${options.reason}`,
      args: [
        "api",
        `repos/${targetRepo()}/issues/${options.number}`,
        "--method",
        "PATCH",
        "--input",
        closePayloadFile,
      ],
    });
  }
}

export function reviewActionForDecision(options: {
  item: Item;
  decision: Decision;
  git: GitInfo;
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
}): Action {
  if (options.decision.decision !== "close") return { actionTaken: "kept_open", closeComment: "" };
  if (
    isMaintainerAuthored(options.item) &&
    !isVerifiedFixedCloseReason(options.decision.closeReason)
  ) {
    return { actionTaken: "skipped_maintainer_authored", closeComment: "" };
  }
  const validation = validateCloseDecision(options.item, options.decision, {
    requireCloseComment: false,
  });
  if (!validation.ok) return { actionTaken: validation.actionTaken, closeComment: "" };
  const closeComment = normalizeComment(
    options.decision,
    options.git,
    options.runtime,
    options.item,
  );
  if (!hasUsableCloseComment(closeComment)) {
    return { actionTaken: "skipped_invalid_decision", closeComment: "" };
  }
  return { actionTaken: "proposed_close", closeComment };
}

function markdownList(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
}

function renderWorkCandidateReportSection(decision: Decision): string {
  const lines = [
    `Candidate: ${decision.workCandidate}`,
    "",
    `Confidence: ${decision.workConfidence}`,
    "",
    `Priority: ${decision.workPriority}`,
    "",
    `Status: ${workStatusForDecision(decision)}`,
  ];
  const workReason = decision.workReason.trim();
  if (workReason) lines.push("", `Reason: ${workReason}`);

  const includeDetails =
    decision.workCandidate !== "none" ||
    decision.workClusterRefs.length > 0 ||
    decision.workLikelyFiles.length > 0 ||
    decision.workValidation.length > 0;
  if (includeDetails) {
    lines.push("", "Cluster refs:", "", markdownList(decision.workClusterRefs));
    lines.push("", "Likely files:", "", markdownList(decision.workLikelyFiles));
    lines.push("", "Validation:", "", markdownList(decision.workValidation));
  }
  return lines.join("\n");
}

function renderRepairWorkPromptReportSection(decision: Decision): string {
  const workPrompt = decision.workPrompt.trim();
  return workPrompt ? `\n\n## ${REVIEW_SECTIONS.repairWorkPrompt}\n\n${workPrompt}` : "";
}

function renderMaintainerDecisionReportSection(decision: Decision): string {
  const maintainerDecision = decision.maintainerDecision;
  if (!maintainerDecision.required) return "Required: false";
  const options = maintainerDecision.options
    .map(
      (option) =>
        `- **${option.title}${option.recommended ? " (recommended)" : ""}:** ${option.body}`,
    )
    .join("\n");
  return [
    "Required: true",
    "",
    `Kind: ${maintainerDecision.kind}`,
    "",
    `Question: ${maintainerDecision.question}`,
    "",
    `Rationale: ${maintainerDecision.rationale}`,
    "",
    `Likely owner: ${maintainerDecision.likelyOwner.person}`,
    "",
    `Owner reason: ${maintainerDecision.likelyOwner.reason}`,
    "",
    `Owner confidence: ${maintainerDecision.likelyOwner.confidence}`,
    "",
    "Options:",
    "",
    options,
  ].join("\n");
}

function renderVisionFitReportSection(decision: Decision): string {
  return [
    `Status: ${decision.visionFit}`,
    "",
    `Implementation complexity: ${decision.implementationComplexity}`,
    "",
    `Auto implementation candidate: ${decision.autoImplementationCandidate}`,
    "",
    `Reason: ${sentence(decision.visionFitReason)}`,
    "",
    "Vision evidence:",
    "",
    markdownList(decision.visionFitEvidence),
  ].join("\n");
}

function renderReviewFindingsReportSection(decision: Decision): string {
  const lines = [
    `Overall correctness: ${decision.overallCorrectness}`,
    "",
    `Overall confidence: ${confidenceText(decision.overallConfidenceScore)}`,
    "",
    "Full review comments:",
    "",
  ];
  if (!decision.reviewFindings.length) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(
    decision.reviewFindings
      .map((finding) =>
        [
          `- **[${priorityLabel(finding.priority)}] ${finding.title}:** \`${reviewFindingLocation(
            finding,
          )}\``,
          `  - body: ${sentence(finding.body)}`,
          ...(finding.lateFinding ? ["  - late: true"] : []),
          `  - confidence: ${confidenceText(finding.confidenceScore)}`,
        ].join("\n"),
      )
      .join("\n"),
  );
  return lines.join("\n");
}

function securityConcernLocation(concern: SecurityConcern): string {
  if (!concern.file) return "not tied to a single file";
  return `${concern.file}${concern.line ? `:${concern.line}` : ""}`;
}

function renderSecurityReviewReportSection(decision: Decision): string {
  const lines = [
    `Status: ${decision.securityReview.status}`,
    "",
    `Summary: ${sentence(decision.securityReview.summary)}`,
    "",
    "Concerns:",
    "",
  ];
  if (!decision.securityReview.concerns.length) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(
    decision.securityReview.concerns
      .map((concern) => {
        const location = securityConcernLocation(concern);
        const heading =
          location === "not tied to a single file"
            ? `- **[${concern.severity}] ${concern.title}:**`
            : `- **[${concern.severity}] ${concern.title}:** \`${location}\``;
        return [
          heading,
          `  - body: ${sentence(concern.body)}`,
          `  - confidence: ${confidenceText(concern.confidenceScore)}`,
        ].join("\n");
      })
      .join("\n"),
  );
  return lines.join("\n");
}

function renderRealBehaviorProofReportSection(decision: Decision): string {
  return [
    `Status: ${decision.realBehaviorProof.status}`,
    "",
    `Evidence kind: ${decision.realBehaviorProof.evidenceKind}`,
    "",
    `Needs contributor action: ${decision.realBehaviorProof.needsContributorAction}`,
    "",
    `Summary: ${sentence(decision.realBehaviorProof.summary)}`,
  ].join("\n");
}

function renderPrRatingAssessmentReportSection(
  rating: PrRating,
  realBehaviorProof: RealBehaviorProof,
): string {
  const nextSteps = rating.nextSteps.length
    ? rating.nextSteps.map((step) => `- ${step}`).join("\n")
    : "- none";
  const shiny = hasShinyProof(realBehaviorProof) ? " ✨" : "";
  return [
    `Overall tier: ${rating.overallTier}`,
    "",
    `Proof tier: ${rating.proofTier}`,
    "",
    `Patch tier: ${rating.patchTier}`,
    "",
    `Overall label: ${themedRatingName(rating.overallTier)}`,
    "",
    `Proof label: ${themedRatingName(rating.proofTier)}${shiny}`,
    "",
    `Patch label: ${themedRatingName(rating.patchTier)}`,
    "",
    `Summary: ${sentence(rating.summary)}`,
    "",
    "Next rank-up steps:",
    "",
    nextSteps,
  ].join("\n");
}

function renderPrRatingReportSection(decision: Decision): string {
  return renderPrRatingAssessmentReportSection(decision.prRating, decision.realBehaviorProof);
}

function renderTelegramVisibleProofReportSection(decision: Decision): string {
  return [
    `Status: ${decision.telegramVisibleProof.status}`,
    "",
    `Summary: ${sentence(decision.telegramVisibleProof.summary)}`,
  ].join("\n");
}

function renderMantisRecommendationReportSection(decision: Decision): string {
  return [
    `Status: ${decision.mantisRecommendation.status}`,
    "",
    `Scenario: ${decision.mantisRecommendation.scenario}`,
    "",
    `Reason: ${sentence(decision.mantisRecommendation.reason)}`,
    "",
    `Maintainer comment: ${decision.mantisRecommendation.maintainerComment.trim()}`,
  ].join("\n");
}

function renderFeatureShowcaseReportSection(decision: Decision): string {
  return [
    `Status: ${decision.featureShowcase.status}`,
    "",
    `Reason: ${sentence(decision.featureShowcase.reason)}`,
  ].join("\n");
}

function renderRootCauseClusterAssessmentReportSection(
  rootCauseCluster: RootCauseClusterAssessment,
): string {
  const members = rootCauseCluster.members.length
    ? rootCauseCluster.members
        .map(
          (member) => `- **${member.relationship}:** ${member.ref}\n  - reason: ${member.reason}`,
        )
        .join("\n")
    : "- none";
  return [
    `Current item relationship: ${rootCauseCluster.currentItemRelationship}`,
    "",
    `Confidence: ${rootCauseCluster.confidence}`,
    "",
    `Canonical ref: ${rootCauseCluster.canonicalRef ?? "none"}`,
    "",
    `Summary: ${sentence(rootCauseCluster.summary)}`,
    "",
    "Members:",
    members,
  ].join("\n");
}

function renderRootCauseClusterReportSection(decision: Decision): string {
  return renderRootCauseClusterAssessmentReportSection(decision.rootCauseCluster);
}

function renderAgentsPolicyStatusReportSection(decision: Decision): string {
  return [
    `Status: ${decision.agentsPolicyStatus.status}`,
    "",
    `Found: ${decision.agentsPolicyStatus.found}`,
    "",
    `Read fully: ${decision.agentsPolicyStatus.readFully}`,
    "",
    `Applied: ${decision.agentsPolicyStatus.applied}`,
    "",
    `Summary: ${sentence(decision.agentsPolicyStatus.summary)}`,
  ].join("\n");
}

export function pullRequestFilePathsFromContextForTest(context: {
  pullFiles?: unknown[];
}): string[] {
  return (context.pullFiles ?? []).flatMap(compactPullFilePaths);
}

function pullRequestFilePathsFromContext(context: ItemContext): string[] {
  return pullRequestFilePathsFromContextForTest(context);
}

function updateReviewStructuralFrontMatter(
  markdown: string,
  record: ReviewStructuralRecord | null,
  cacheHit: boolean,
): string {
  let next = replaceFrontMatterValue(
    markdown,
    "review_structural_cache_version",
    record ? String(record.version) : "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_fingerprint",
    record?.fingerprint ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_source_revision",
    record?.sourceRevision ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_item_state_digest",
    record?.itemStateDigest ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_context_revision",
    record?.contextRevision ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_activity_updated_at",
    record?.activityUpdatedAt ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_relation_sensitive",
    record ? String(record.relationSensitive) : "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_target_head_sha",
    record?.targetHeadSha ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_pull_head_sha",
    record ? (record.pullHeadSha ?? "none") : "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_structural_pull_state_digest",
    record ? (record.pullStateDigest ?? "none") : "unknown",
  );
  return replaceFrontMatterValue(next, "review_structural_cache_hit", cacheHit ? "true" : "false");
}

function updateReviewSemanticFrontMatter(
  markdown: string,
  record: ReviewSemanticRecord | null,
  cacheHit: boolean,
): string {
  let next = replaceFrontMatterValue(
    markdown,
    "review_semantic_cache_version",
    record ? String(record.version) : "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_semantic_fingerprint",
    record?.fingerprint ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_semantic_code_digest",
    record?.codeDigest ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_semantic_exact_digest",
    record?.exactDigest ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_semantic_context_digest",
    record?.contextDigest ?? "unknown",
  );
  next = replaceFrontMatterValue(
    next,
    "review_semantic_eligible",
    record ? String(record.eligible) : "false",
  );
  next = replaceFrontMatterValue(
    next,
    "review_semantic_eligibility_reason",
    record?.eligibilityReason ?? "unknown",
  );
  return replaceFrontMatterValue(next, "review_semantic_cache_hit", cacheHit ? "true" : "false");
}

function markdownFor(options: {
  item: Item;
  context: ItemContext;
  decision: Decision;
  git: GitInfo;
  action: Action;
  reviewMode: "propose" | "apply";
  snapshotHash: string;
  contentDigest: string;
  reviewPolicy: string;
  runtime: ReviewRuntime;
  structuralRecord?: ReviewStructuralRecord | null;
  semanticRecord?: ReviewSemanticRecord | null;
  reviewLeaseOwner?: string;
  reviewLeaseCommentId?: number;
}): string {
  const labels = options.item.labels.length ? options.item.labels.join(", ") : "none";
  const reviewedAt = new Date().toISOString();
  const fixedPullRequest = options.decision.fixedPullRequest;
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
  const likelyOwners = options.decision.likelyOwners.length
    ? options.decision.likelyOwners
        .map((owner) => {
          const bits = [`- **${owner.person}:** ${publicLikelyOwnerRole(owner.role)}`];
          bits.push(`  - reason: ${owner.reason}`);
          bits.push(`  - confidence: ${owner.confidence}`);
          if (owner.commits.length) bits.push(`  - commits: ${owner.commits.join(", ")}`);
          if (owner.files.length) bits.push(`  - files: ${owner.files.join(", ")}`);
          return bits.join("\n");
        })
        .join("\n")
    : "- none";
  const bestSolution = options.decision.bestSolution.trim() || "_Not provided._";
  const maintainerDecision = renderMaintainerDecisionReportSection(options.decision);
  const reproductionAssessment =
    options.decision.reproductionAssessment.trim() || "_Not provided._";
  const solutionAssessment = options.decision.solutionAssessment.trim() || "_Not provided._";
  const visionFit = renderVisionFitReportSection(options.decision);
  const rootCauseCluster = renderRootCauseClusterReportSection(options.decision);
  const reviewFindings = renderReviewFindingsReportSection(options.decision);
  const securityReview = renderSecurityReviewReportSection(options.decision);
  const realBehaviorProof = renderRealBehaviorProofReportSection(options.decision);
  const prRating = renderPrRatingReportSection(options.decision);
  const telegramVisibleProof = renderTelegramVisibleProofReportSection(options.decision);
  const mantisRecommendation = renderMantisRecommendationReportSection(options.decision);
  const featureShowcase = renderFeatureShowcaseReportSection(options.decision);
  const agentsPolicyStatus = renderAgentsPolicyStatusReportSection(options.decision);
  const workCandidateSection = renderWorkCandidateReportSection(options.decision);
  const repairWorkPromptSection = renderRepairWorkPromptReportSection(options.decision);
  const pullFiles = pullRequestFilePathsFromContext(options.context);
  const pullFilesTruncated = Boolean(options.context.counts?.pullFilesTruncated);
  const configSurfaceChange = configSurfaceChangeFromContext(options.item.repo, options.context);
  const dataModelChange = dataModelChangeFromContext(options.item.repo, options.context);
  const prSurfaceFiles = prSurfaceFilesFromContext(options.context);
  const reviewedPullStateDigest = reviewStructuralPullStateFromContext(options.context);
  return `---
number: ${options.item.number}
repository: ${options.item.repo}
type: ${options.item.kind}
title: ${JSON.stringify(options.item.title)}
url: ${options.item.url}
state_at_review: open
item_created_at: ${options.item.createdAt}
item_updated_at: ${options.item.updatedAt}
author: ${options.item.author}
author_association: ${options.item.authorAssociation}
labels: ${JSON.stringify(options.item.labels)}
bulk_filer_detected: ${options.context.bulkFiler?.detected === true}
reviewed_at: ${reviewedAt}
review_lease_owner: ${options.reviewLeaseOwner ?? "unknown"}
review_lease_comment_id: ${options.reviewLeaseCommentId ?? "unknown"}
main_sha: ${options.git.mainSha}
pull_head_sha: ${pullHeadShaFromContext(options.context) ?? "unknown"}
reviewed_pull_state_digest: ${
    reviewedPullStateDigest
      ? (reviewStructuralPullStateDigest(reviewedPullStateDigest) ?? "unknown")
      : "unknown"
  }
latest_release: ${options.git.latestRelease?.tagName ?? "unknown"}
latest_release_sha: ${options.git.latestRelease?.sha ?? "unknown"}
fixed_release: ${options.decision.fixedRelease ?? "unknown"}
fixed_sha: ${options.decision.fixedSha ?? "unknown"}
fixed_at: ${options.decision.fixedAt ?? "unknown"}
fixed_pr_url: ${fixedPullRequest?.url ?? "unknown"}
fixed_pr_number: ${fixedPullRequest?.number ?? "unknown"}
fixed_pr_title: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.title) : "unknown"}
fixed_pr_merged_at: ${fixedPullRequest?.mergedAt ?? "unknown"}
fixed_pr_sha: ${fixedPullRequest?.sha ?? "unknown"}
fixed_pr_confidence: ${fixedPullRequest?.confidence ?? "unknown"}
fixed_pr_source: ${fixedPullRequest ? JSON.stringify(fixedPullRequest.source) : "unknown"}
review_policy: ${options.reviewPolicy}
review_model: ${options.runtime.model}
review_reasoning_effort: ${options.runtime.reasoningEffort}
review_sandbox: ${options.runtime.sandboxMode ?? "unknown"}
review_service_tier: ${options.runtime.serviceTier || "default"}
review_prompt_chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
review_static_prompt_chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
review_context_chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
review_schema_chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
review_additional_prompt_chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
review_context_elapsed_ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
review_codex_elapsed_ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
review_mode: ${options.reviewMode}
review_status: ${options.decision.summary.startsWith("Codex review failed") ? "failed" : "complete"}
review_terminal_failure: ${options.decision.codexTerminalFailure === true}
local_checkout_access: verified
item_snapshot_hash: ${options.snapshotHash}
review_content_digest: ${options.contentDigest}
last_full_review_at: ${reviewedAt}
last_full_review_decision: ${options.decision.decision}
last_full_review_bulk_filer_detected: ${options.context.bulkFiler?.detected === true}
review_cache_hit: false
review_structural_cache_version: ${options.structuralRecord?.version ?? "unknown"}
review_structural_fingerprint: ${options.structuralRecord?.fingerprint ?? "unknown"}
review_structural_source_revision: ${options.structuralRecord?.sourceRevision ?? "unknown"}
review_structural_item_state_digest: ${options.structuralRecord?.itemStateDigest ?? "unknown"}
review_structural_context_revision: ${options.structuralRecord?.contextRevision ?? "unknown"}
review_structural_activity_updated_at: ${options.structuralRecord?.activityUpdatedAt ?? "unknown"}
review_structural_relation_sensitive: ${
    options.structuralRecord ? options.structuralRecord.relationSensitive : "unknown"
  }
review_structural_target_head_sha: ${options.structuralRecord?.targetHeadSha ?? "unknown"}
review_structural_pull_head_sha: ${
    options.structuralRecord ? (options.structuralRecord.pullHeadSha ?? "none") : "unknown"
  }
review_structural_pull_state_digest: ${
    options.structuralRecord ? (options.structuralRecord.pullStateDigest ?? "none") : "unknown"
  }
review_structural_cache_hit: false
review_semantic_cache_version: ${options.semanticRecord?.version ?? "unknown"}
review_semantic_fingerprint: ${options.semanticRecord?.fingerprint ?? "unknown"}
review_semantic_code_digest: ${options.semanticRecord?.codeDigest ?? "unknown"}
review_semantic_exact_digest: ${options.semanticRecord?.exactDigest ?? "unknown"}
review_semantic_context_digest: ${options.semanticRecord?.contextDigest ?? "unknown"}
review_semantic_eligible: ${options.semanticRecord?.eligible ?? false}
review_semantic_eligibility_reason: ${options.semanticRecord?.eligibilityReason ?? "unknown"}
review_semantic_cache_hit: false
item_source_revision: ${options.context.sourceRevision ?? "unknown"}
review_activity_cursor: ${options.context.pullReviewActivityCursor ?? "unknown"}
close_comment_sha256: ${options.action.closeComment ? sha256(options.action.closeComment) : "none"}
review_comment_sha256: none
review_comment_id: unknown
review_comment_url: unknown
decision: ${options.decision.decision}
close_reason: ${options.decision.closeReason}
confidence: ${options.decision.confidence}
action_taken: ${options.action.actionTaken}
work_candidate: ${options.decision.workCandidate}
work_confidence: ${options.decision.workConfidence}
work_priority: ${options.decision.workPriority}
work_status: ${workStatusForDecision(options.decision)}
work_reason_sha256: ${options.decision.workReason ? sha256(options.decision.workReason) : "none"}
work_prompt_sha256: ${options.decision.workPrompt ? sha256(options.decision.workPrompt) : "none"}
work_cluster_refs: ${jsonFrontMatterValue(options.decision.workClusterRefs)}
root_cause_cluster: ${JSON.stringify(options.decision.rootCauseCluster)}
work_validation: ${jsonFrontMatterValue(options.decision.workValidation)}
work_likely_files: ${jsonFrontMatterValue(options.decision.workLikelyFiles)}
maintainer_decision: ${JSON.stringify(options.decision.maintainerDecision)}
triage_priority: ${options.decision.triagePriority}
impact_labels: ${jsonFrontMatterValue(options.decision.impactLabels)}
merge_risk_labels: ${jsonFrontMatterValue(options.decision.mergeRiskLabels)}
maturity_labels: ${jsonFrontMatterValue(options.decision.maturityLabels)}
merge_risk_options: ${JSON.stringify(options.decision.mergeRiskOptions)}
review_metrics: ${JSON.stringify(options.decision.reviewMetrics)}
label_justifications: ${JSON.stringify(options.decision.labelJustifications)}
pull_files: ${jsonFrontMatterValue(pullFiles)}
pull_files_truncated: ${pullFilesTruncated}
config_surface_change: ${configSurfaceChange.change}
config_surface_keys: ${jsonFrontMatterValue(configSurfaceChange.keys)}
data_model_change: ${dataModelChange.change}
data_model_surfaces: ${jsonFrontMatterValue(dataModelChange.surfaces)}
pr_surface_files: ${jsonFrontMatterValue(prSurfaceFiles)}
pr_surface_files_truncated: ${pullFilesTruncated}
item_category: ${options.decision.itemCategory}
reproduction_status: ${options.decision.reproductionStatus}
reproduction_confidence: ${options.decision.reproductionConfidence}
requires_new_feature: ${options.decision.requiresNewFeature}
requires_new_config_option: ${options.decision.requiresNewConfigOption}
requires_product_decision: ${options.decision.requiresProductDecision}
vision_fit: ${options.decision.visionFit}
vision_fit_evidence: ${jsonFrontMatterValue(options.decision.visionFitEvidence)}
implementation_complexity: ${options.decision.implementationComplexity}
auto_implementation_candidate: ${options.decision.autoImplementationCandidate}
real_behavior_proof_status: ${options.decision.realBehaviorProof.status}
real_behavior_proof_evidence_kind: ${options.decision.realBehaviorProof.evidenceKind}
real_behavior_proof_needs_contributor_action: ${options.decision.realBehaviorProof.needsContributorAction}
pr_rating_overall: ${options.decision.prRating.overallTier}
pr_rating_proof: ${options.decision.prRating.proofTier}
pr_rating_patch: ${options.decision.prRating.patchTier}
telegram_visible_proof_status: ${options.decision.telegramVisibleProof.status}
mantis_recommendation_status: ${options.decision.mantisRecommendation.status}
mantis_recommendation_scenario: ${options.decision.mantisRecommendation.scenario}
feature_showcase_status: ${options.decision.featureShowcase.status}
agents_policy_status: ${options.decision.agentsPolicyStatus.status}
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

## Label Justifications

${labelJustificationsMarkdown(options.decision.labelJustifications)}

## ${REVIEW_SECTIONS.summary}

${options.decision.summary}

## ${REVIEW_SECTIONS.changeSummary}

${options.decision.changeSummary}

## ${REVIEW_SECTIONS.systemContext}

${options.decision.systemContext}

## ${REVIEW_SECTIONS.architectureDiagram}

${options.decision.architectureDiagram}

## ${REVIEW_SECTIONS.bestSolution}

${bestSolution}

## ${REVIEW_SECTIONS.maintainerDecision}

${maintainerDecision}

## ${REVIEW_SECTIONS.reproductionAssessment}

${reproductionAssessment}

## ${REVIEW_SECTIONS.solutionAssessment}

${solutionAssessment}

## ${REVIEW_SECTIONS.visionFit}

${visionFit}

## ${REVIEW_SECTIONS.rootCauseCluster}

${rootCauseCluster}

## ${REVIEW_SECTIONS.reviewFindings}

${reviewFindings}

## ${REVIEW_SECTIONS.securityReview}

${securityReview}

## ${REVIEW_SECTIONS.realBehaviorProof}

${realBehaviorProof}

## ${REVIEW_SECTIONS.prRating}

${prRating}

## ${REVIEW_SECTIONS.telegramVisibleProof}

${telegramVisibleProof}

## ${REVIEW_SECTIONS.mantisRecommendation}

${mantisRecommendation}

## ${REVIEW_SECTIONS.featureShowcase}

${featureShowcase}

## ${REVIEW_SECTIONS.agentsPolicyStatus}

${agentsPolicyStatus}

## ${REVIEW_SECTIONS.workCandidate}

${workCandidateSection}${repairWorkPromptSection}

## ${REVIEW_SECTIONS.evidence}

${evidence}

## ${REVIEW_SECTIONS.likelyOwners}

${likelyOwners}

## ${REVIEW_SECTIONS.risks}

${risks}

## ${REVIEW_SECTIONS.closeComment}

${options.action.closeComment ? options.action.closeComment : "_No close comment posted._"}

## GitHub Snapshot

- comments: ${contextCountText(
    options.context.counts?.comments,
    options.context.comments.length,
    options.context.counts?.commentsHydrated,
    options.context.counts?.commentsTruncated,
  )}
- timeline events: ${contextCountText(
    options.context.counts?.timeline,
    options.context.timeline.length,
    options.context.counts?.timelineHydrated,
    options.context.counts?.timelineTruncated,
  )}
- related items: ${options.context.counts?.relatedItems ?? options.context.relatedItems?.length ?? 0}
- PR files: ${contextCountText(
    options.context.counts?.pullFiles,
    options.context.pullFiles?.length ?? 0,
    options.context.counts?.pullFilesHydrated,
    options.context.counts?.pullFilesTruncated,
  )}
- PR commits: ${contextCountText(
    options.context.counts?.pullCommits,
    options.context.pullCommits?.length ?? 0,
    options.context.counts?.pullCommitsHydrated,
    options.context.counts?.pullCommitsTruncated,
  )}
- PR review comments: ${contextCountText(
    options.context.counts?.pullReviewComments,
    options.context.pullReviewComments?.length ?? 0,
    options.context.counts?.pullReviewCommentsHydrated,
    options.context.counts?.pullReviewCommentsTruncated,
  )}

## Review Context Budget

${renderReviewContextBudget(options.context)}

## Review Telemetry

- prompt chars: ${reviewTelemetryNumber(options.runtime.promptChars)}
- static prompt chars: ${reviewTelemetryNumber(options.runtime.staticPromptChars)}
- context chars: ${reviewTelemetryNumber(options.runtime.contextChars)}
- schema chars: ${reviewTelemetryNumber(options.runtime.schemaChars)}
- additional prompt chars: ${reviewTelemetryNumber(options.runtime.additionalPromptChars)}
- context collection ms: ${reviewTelemetryNumber(options.runtime.contextElapsedMs)}
- Codex review ms: ${reviewTelemetryNumber(options.runtime.codexElapsedMs)}
  `;
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

function reserveReviewLeaseCommand(args: Args): void {
  repoFromArgs(args);
  const itemNumber = numberArg(args.item_number, 0);
  const reviewTimeoutMs = numberArg(args.review_timeout_ms, 0);
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
    throw new UserFacingCommandError("--item-number must be a positive integer.");
  }
  if (!Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs <= 0) {
    throw new UserFacingCommandError("--review-timeout-ms must be a positive integer.");
  }
  const { item, state } = fetchItem(itemNumber);
  if (state !== "open") {
    // The item was closed between enqueue and review (typically by the apply
    // lane or its author). The stale entry completes as a superseded no-op
    // rather than burning the item's review-failure budget.
    console.error(
      `Item #${itemNumber} is ${state}; completing the reservation as a superseded no-op.`,
    );
    console.log(JSON.stringify({ status: "superseded", reason: "item_not_open", state }));
    return;
  }
  const queueAuthority = exactReviewQueueAuthorityFromEnv();
  const expectedItemKey = `${targetRepo()}#${itemNumber}`.toLowerCase();
  if (queueAuthority && queueAuthority.itemKey.toLowerCase() !== expectedItemKey) {
    throw new UserFacingCommandError("Exact-review queue authority item does not match target.");
  }
  const currentRevision = currentReviewRevision(item);
  if (!currentRevision || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(currentRevision)) {
    throw new UserFacingCommandError(
      `Could not resolve the current review revision for #${itemNumber}.`,
    );
  }
  if (
    queueAuthority?.sourceHeadSha &&
    item.kind === "pull_request" &&
    queueAuthority.sourceHeadSha !== currentRevision
  ) {
    // The PR moved past the queued head. The push that moved it enqueues its
    // own exact-head event (and the scheduled sweep backstops a lost webhook),
    // so this stale entry completes as a superseded no-op instead of burning
    // the item's review-failure budget.
    console.error(
      `Exact-review queue authority source head ${queueAuthority.sourceHeadSha} does not match the current pull request head ${currentRevision}; completing as superseded.`,
    );
    console.log(JSON.stringify({ status: "superseded", reason: "source_head_drift" }));
    return;
  }
  const reservationAuthority =
    queueAuthority && item.kind === "pull_request" && !queueAuthority.sourceHeadSha
      ? { ...queueAuthority, sourceHeadSha: currentRevision }
      : queueAuthority;
  const result = postReviewStartStatusComment({
    item,
    headSha: currentRevision,
    reviewTimeoutMs,
    position: 1,
    total: 1,
    shardIndex: 0,
    shardCount: 1,
    queueAuthority: reservationAuthority,
    allowSupersededLeaseCleanup:
      item.kind !== "pull_request" || Boolean(queueAuthority?.sourceHeadSha),
  });
  if (result.status === "held") {
    console.log(JSON.stringify({ status: "held", retryAt: result.retryAt }));
    return;
  }
  console.log(
    JSON.stringify({
      status: "posted",
      owner: result.lease.owner,
      commentId: result.lease.commentId,
      headSha: result.lease.headSha,
    }),
  );
}

function reviewCommand(args: Args): void {
  const profile = repoFromArgs(args);
  // `--local-range` is inherently a local, offline operation, so it implies `--local-only`
  // (no GitHub writes, and the local Codex auth path in runCodex below).
  const localRange = boolArg(args.local_range);
  const localOnly = boolArg(args.local_only) || localRange;
  const verbose = boolArg(args.verbose);
  const itemNumber = numberArg(args.item_number, 0) || undefined;
  const hasItemNumbersInput = typeof args.item_numbers === "string" && args.item_numbers.trim();
  const itemNumbers = hasItemNumbersInput
    ? itemNumbersArg(args.item_numbers, undefined)
    : undefined;
  // --local-range synthesizes the review item from the local git range and never fetches a GitHub
  // item, so an item number is meaningless here and could otherwise route into a managed GitHub
  // checkout — reject the combination outright rather than silently ignore it.
  if (localRange && (itemNumber !== undefined || itemNumbers !== undefined)) {
    throw new UserFacingCommandError(
      "--item-number / --item-numbers cannot be combined with --local-range (local-range reviews " +
        "the local git range and never fetches a GitHub item).",
    );
  }
  const localExactItem = localExactReviewItem(localOnly, itemNumber, itemNumbers);
  const humanLocalReview = localExactItem && !verbose;
  // Every --local-range review is synthesized as item #0, so its item-numbered artifacts
  // (0.md, codex/0.json, proof-scratch/0, logs) would collide across repeated/concurrent
  // pre-PR runs under one default dir. Give each run a unique per-run dir (mirrors #298's
  // run-<ts>-<pid> identity). An explicit --artifact-dir is still honored as-is.
  const defaultArtifactDir = defaultReviewArtifactDir(localOnly, itemNumber, itemNumbers);
  const requestedArtifactDir = stringArg(args.artifact_dir, "");
  const checkoutArtifactDir = resolve(requestedArtifactDir || defaultArtifactDir);
  if (humanLocalReview) {
    console.error(`Local ClawSweeper review for ${targetRepo()}#${itemNumber}`);
    console.error("");
    console.error("Preparing target checkout");
  }
  const checkout = resolveReviewCheckout({
    args,
    artifactDir: checkoutArtifactDir,
    humanLocalReview,
    itemNumber,
    itemNumbers,
    localRange,
    localOnly,
    profile,
    verbose,
  });
  const openclawDir = checkout.openclawDir;
  const artifactDir = requestedArtifactDir
    ? resolve(requestedArtifactDir)
    : localRange
      ? defaultLocalRangeArtifactDir(openclawDir)
      : checkoutArtifactDir;
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const batchSize = numberArg(args.batch_size, DEFAULT_PLAN_BATCH_SIZE);
  const maxPages = numberArg(args.max_pages, 250);
  const model = stringArg(args.codex_model, DEFAULT_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT);
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const serviceTier = stringArg(args.codex_service_tier, localOnly ? "fast" : DEFAULT_SERVICE_TIER);
  const timeoutMs = numberArg(args.codex_timeout_ms, DEFAULT_REVIEW_CODEX_TIMEOUT_MS);
  const expectedSourceRevision = stringArg(args.expected_source_revision, "").trim();
  if (expectedSourceRevision && !/^[0-9a-f]{64}$/.test(expectedSourceRevision)) {
    throw new UserFacingCommandError(
      "--expected-source-revision must be a lowercase SHA-256 digest.",
    );
  }
  let additionalPrompt = stringArg(
    args.additional_prompt,
    process.env.CLAWSWEEPER_ADDITIONAL_PROMPT ?? "",
  );
  // Local-review extensions (spirit of the standalone local-review lane, folded in):
  // layer a repo-specific policy file, and/or substitute a hypothetical PR body (e.g.
  // to test the real-behavior-proof / mantis decision, or to give engines that cannot
  // fetch the live body — the gh-token-scrubbed ones — the body in the prompt).
  const additionalPolicyFile = stringArg(args.additional_policy, "");
  if (additionalPolicyFile) {
    const policy = readFileSync(additionalPolicyFile, "utf8");
    additionalPrompt = additionalPrompt
      ? `${additionalPrompt}\n\n## Additional review policy (layered on the repo's own policy)\n${policy}`
      : policy;
  }
  const allowClosed = boolArg(args.allow_closed);
  const bodyFile = stringArg(args.body_file, "");
  if (bodyFile) {
    const providedBody = readFileSync(bodyFile, "utf8");
    additionalPrompt = `${additionalPrompt}\n\n## AUTHORITATIVE PR BODY (review THIS exact body)\nTreat the text below as the pull request's current body/description and review it as such — assess its real-behavior proof, telegram-visible-proof, and mantis recommendation against it. Do NOT fetch, prefer, or assume any other version of the body from the GitHub API. The diff, code, and comments are still the live PR.\n\n----- BEGIN PROVIDED PR BODY -----\n${providedBody}\n----- END PROVIDED PR BODY -----`;
  }
  const localRangeData = localRange
    ? buildLocalRangeReview(openclawDir, targetRepo(), stringArg(args.base, ""))
    : undefined;
  ensureDir(artifactDir);
  const coordinationHeldPath = join(artifactDir, "coordination-held.json");
  if (existsSync(coordinationHeldPath)) unlinkSync(coordinationHeldPath);
  if (localRangeData) {
    // Reuse #298's FULL offline envelope (not just token-scrub): withhold every GitHub
    // credential AND point gh at an empty config dir — token deletion alone can't stop
    // gh's own cached auth — and prepend the no-network local-review prompt.
    scrubGitHubCredentialEnv();
    isolateGitHubConfigDir(artifactDir);
    additionalPrompt = [
      localReviewAdditionalPrompt(
        localRangeData.baseSha,
        localRangeData.headSha,
        stringArg(args.base, "") || "origin/main",
      ),
      additionalPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const shardIndex = numberArg(args.shard_index, 0);
  const shardCount = numberArg(args.shard_count, 1);
  const hotIntake = boolArg(args.hot_intake);
  const readonlyOpenclaw = boolArg(args.readonly_openclaw);
  const skipStartComment = boolArg(args.skip_start_comment) || localOnly || localRange;
  const suppliedReviewLease = suppliedReviewStartLeaseFromArgs(args);
  if (suppliedReviewLease && !skipStartComment) {
    throw new UserFacingCommandError(
      "A supplied review lease requires --skip-start-comment to prevent a second lease from being created.",
    );
  }
  if (suppliedReviewLease && localOnly) {
    throw new UserFacingCommandError(
      "A supplied review lease cannot be used with local-only review.",
    );
  }
  const forcedLoginMethod = reviewCodexForcedLoginMethod(args);
  const loadReviewGitInfo = (): GitInfo =>
    checkout.gitTargetBranch
      ? gitInfo(openclawDir, { targetBranch: checkout.gitTargetBranch })
      : gitInfo(openclawDir);
  let git: GitInfo = localRangeData
    ? { mainSha: localRangeData.baseSha, releaseStateComplete: true, latestRelease: null }
    : loadReviewGitInfo();
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  // Planned background shards receive exact item numbers from the planner, but they are not
  // user-requested exact reviews. Only the workflow may opt those batches into cache reuse.
  const plannedAutomaticReview = boolArg(args.planned_automatic_review);
  const explicitDispatch =
    !plannedAutomaticReview && (itemNumber !== undefined || itemNumbers !== undefined);
  const maintainerRequest = additionalPrompt.trim().length > 0;
  const readonlyModeSnapshots = readonlyOpenclaw ? makeTreeReadOnly(openclawDir) : [];
  const acquiredReviewLeases: Array<{ itemNumber: number; lease: AcquiredReviewStartLease }> = [];
  const releaseOwnedReviewLease = (itemNumber: number, lease: AcquiredReviewStartLease): boolean =>
    // The exact-event workflow reserves a supplied lease in its write-token
    // step and owns cleanup outside this read-token review. Every lease this
    // command creates itself must still be deleted, even for a read-only checkout.
    isSuppliedReviewStartLease(suppliedReviewLease, lease) ||
    deleteOwnedDedicatedReviewStartLease(itemNumber, lease);
  let reviewLedger: ReviewActionLedger | null = null;
  let activeReviewItem: Item | null = null;
  let completed = 0;
  let cacheHits = 0;
  try {
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
    if (allowClosed) selectionOptions.allowClosed = true;
    if (hotIntake) selectionOptions.hotIntake = true;
    if (humanLocalReview) {
      console.error("");
      console.error("Loading review item");
    }
    const { candidates, scannedPages } = localRangeData
      ? { candidates: [localRangeData.item], scannedPages: 0 }
      : selectCandidates(selectionOptions);
    if (suppliedReviewLease && candidates.length !== 1) {
      throw new UserFacingCommandError(
        "A supplied review lease requires exactly one selected item.",
      );
    }
    if (expectedSourceRevision && candidates.length !== 1) {
      throw new UserFacingCommandError(
        `--expected-source-revision requires exactly one selected issue; selected ${candidates.length}.`,
      );
    }
    if (humanLocalReview) {
      if (candidates.length === 0) throw exactLocalReviewNoCandidateError(itemNumber, shardIndex);
      const item = candidates[0]!;
      console.error(`  item: ${item.kind === "pull_request" ? "PR" : "issue"} #${item.number}`);
      console.error(`  title: ${item.title}`);
      console.error("  state: open");
    } else {
      console.error(
        `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} selected=${candidates.length} scanned_pages=${scannedPages}`,
      );
    }
    writeFileSync(
      join(artifactDir, "selection.json"),
      JSON.stringify({ shardIndex, shardCount, scannedPages, candidates, reviewPolicy }, null, 2),
    );
    reviewLedger = startReviewActionLedger({
      candidates,
      reviewPolicy,
      shardIndex,
      shardCount,
      batchSize,
    });
    let coordinationHeldRetryAt: string | null = null;
    let codexFailures = 0;
    let leaseAcquisitionFailures = 0;
    let contentCacheHits = 0;
    let structuralCacheChecks = 0;
    let structuralCacheHits = 0;
    let structuralCacheProbeFailures = 0;
    let structuralCacheProbeMs = 0;
    let structuralCacheRevalidations = 0;
    let structuralCacheRevalidationFailures = 0;
    let structuralCacheRevalidationMs = 0;
    let semanticCacheChecks = 0;
    let semanticCacheHits = 0;
    let semanticCacheIneligible = 0;
    let semanticCacheMs = 0;
    let semanticCacheRevalidations = 0;
    let semanticCacheRevalidationFailures = 0;
    let semanticCacheRevalidationMs = 0;
    let hydrationRuns = 0;
    const bulkFilerCountCache: BulkFilerCountCache = new Map();
    const bulkFilerRepositoryPermissionCache: BulkFilerRepositoryPermissionCache = new Map();
    const bulkFilerWindowNow = Date.now();
    const structuralCacheReasons = new Map<string, number>();
    const structuralCacheRevalidationReasons = new Map<string, number>();
    const semanticCacheReasons = new Map<string, number>();
    const semanticCacheEligibilityReasons = new Map<string, number>();
    const semanticCacheRevalidationReasons = new Map<string, number>();
    const codexFailureReports: string[] = [];
    const leaseAcquisitionFailureDetails: string[] = [];
    // oxfmt-ignore
    for (const item of candidates) {
      activeReviewItem = item;
      let reviewItemFailed = false;
      const previousReviewMutationRunner = activeReviewMutationRunner;
      try {
      startReviewActionLedgerItem(reviewLedger, item);
      activeReviewMutationRunner = reviewMutationRunner(reviewLedger, item);
      const bulkFilerDetection =
        !localOnly && item.kind === "issue"
          ? detectBulkFiler({
              item,
              cache: bulkFilerCountCache,
              now: bulkFilerWindowNow,
              searchCount: ({ author, windowStart }) =>
                authorIssueCountInBulkFilerWindow(author, windowStart),
              onSearchError: (error) => {
                console.error(
                  `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} bulk-filer-search=failed #${item.number}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              },
            })
          : { context: null, labelPending: false, labelApplied: false };
      if (humanLocalReview) {
        console.error("");
        console.error("Collecting GitHub context");
      } else {
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start #${item.number} (${completed + 1}/${candidates.length})`,
        );
      }
      const existingPriorReview = localRangeData ? null : existingReview(item, itemsDir);
      const lastFullReviewBulkFilerState = frontMatterValue(
        existingPriorReview?.markdown ?? "",
        "last_full_review_bulk_filer_detected",
      );
      const lastFullReviewBulkFilerStateMayNeedRecheck =
        existingPriorReview !== null && !/^false$/i.test(lastFullReviewBulkFilerState ?? "");
      const needsBulkFilerPermissionLookup =
        !localOnly &&
        item.kind === "issue" &&
        !isBulkFilerExemptAuthorAssociation(item.authorAssociation) &&
        (bulkFilerDetection.context?.detected || lastFullReviewBulkFilerStateMayNeedRecheck);
      const bulkFilerExemptionApplied =
        item.kind === "issue" &&
        (isBulkFilerExemptAuthorAssociation(item.authorAssociation) ||
          (needsBulkFilerPermissionLookup &&
            isBulkFilerExemptRepositoryPermission(
              bulkFilerRepositoryPermission(item.author, bulkFilerRepositoryPermissionCache),
            )));
      if (bulkFilerDetection.context?.detected && bulkFilerExemptionApplied) {
        bulkFilerDetection.context = null;
        bulkFilerDetection.labelPending = false;
        bulkFilerDetection.labelApplied = false;
      }
      let priorReview =
        item.kind === "pull_request" &&
        existingPriorReview &&
        !isReviewedPrActivityCursor(
          frontMatterValue(existingPriorReview.markdown, "review_activity_cursor"),
        )
          ? null
          : existingPriorReview;
      if (bulkFilerPolicyInvalidatesCachedReview(priorReview?.markdown ?? null, bulkFilerExemptionApplied)) {
        // A prior full review was made under a now-inapplicable bulk-filer policy.
        // Re-run it instead of refreshing its cached suppression fields.
        priorReview = null;
      }
      const expectedPreviousReviewDigest = priorReview
        ? previousClawSweeperReviewDigestFromReport(priorReview.markdown)
        : null;
      let acquiredReviewLease: AcquiredReviewStartLease | null = null;
      let structuralRecord: ReviewStructuralRecord | null = null;
      let preHydrationStructuralRecord: ReviewStructuralRecord | null = null;
      let hydratedStructuralAnchor: ReviewStructuralRecord | null = null;
      let semanticRecord: ReviewSemanticRecord | null = null;
      if (!localRangeData) {
        structuralCacheChecks += 1;
        const structuralProbeDecision = reviewStructuralCacheProbeDecision({
          review: priorReview,
          reviewPolicy,
          reviewModel: PUBLIC_CODEX_MODEL,
          explicitDispatch,
          maintainerRequest,
          coordinationEnabled: !skipStartComment,
        });
        if (!structuralProbeDecision.hit) {
          structuralCacheReasons.set(
            structuralProbeDecision.reason,
            (structuralCacheReasons.get(structuralProbeDecision.reason) ?? 0) + 1,
          );
        } else {
          const structuralProbeStartedAt = Date.now();
          try {
            git = loadReviewGitInfo();
            structuralRecord = fetchReviewStructuralRecord({
              item,
              git,
              reviewPolicy,
              reviewModel: PUBLIC_CODEX_MODEL,
            });
            if (!reviewStructuralRecordAtLeastAsFresh(structuralRecord, item.updatedAt)) {
              structuralRecord = null;
            }
          } catch (error) {
            structuralCacheProbeFailures += 1;
            console.error(
              `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=probe-failed #${item.number}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } finally {
            structuralCacheProbeMs += Date.now() - structuralProbeStartedAt;
          }
          preHydrationStructuralRecord = structuralRecord;
          if (structuralRecord) item.updatedAt = structuralRecord.activityUpdatedAt;
          const structuralDecision = reviewStructuralCacheDecision({
            review: priorReview,
            priorRecord: priorReview?.structuralRecord ?? null,
            currentRecord: structuralRecord,
            reviewPolicy,
            reviewModel: PUBLIC_CODEX_MODEL,
            explicitDispatch,
            maintainerRequest,
            coordinationEnabled: !skipStartComment,
          });
          structuralCacheReasons.set(
            structuralDecision.reason,
            (structuralCacheReasons.get(structuralDecision.reason) ?? 0) + 1,
          );
          if (structuralDecision.hit) {
            const initialStructuralRecord = structuralRecord;
            try {
              const leaseRevision =
                item.kind === "pull_request"
                  ? structuralRecord?.pullHeadSha
                  : priorReview?.itemSourceRevision;
              const startComment = postReviewStartStatusComment({
                item,
                headSha: leaseRevision ?? "",
                reviewTimeoutMs: timeoutMs,
                position: completed + 1,
                total: candidates.length,
                shardIndex,
                shardCount,
              });
              console.error(
                `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache-start-comment=${startComment.status} #${item.number}`,
              );
              if (startComment.status === "held") {
                coordinationHeldRetryAt = startComment.retryAt;
                continue;
              }
              acquiredReviewLease = startComment.lease;
              if (!acquiredReviewLease) {
                throw new Error(
                  `structural cache lease acquisition returned no identity for #${item.number}`,
                );
              }
              acquiredReviewLeases.push({ itemNumber: item.number, lease: acquiredReviewLease });
            } catch (error) {
              leaseAcquisitionFailures += 1;
              leaseAcquisitionFailureDetails.push(
                `#${item.number}: ${error instanceof Error ? error.message : String(error)}`,
              );
              console.error(
                `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache-start-comment=failed #${item.number}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              continue;
            }
            structuralCacheRevalidations += 1;
            const structuralRevalidationStartedAt = Date.now();
            let revalidatedStructuralRecord: ReviewStructuralRecord | null = null;
            let revalidatedPreviousReviewDigest: string | null = null;
            try {
              git = loadReviewGitInfo();
              revalidatedStructuralRecord = fetchReviewStructuralRecord({
                item,
                git,
                reviewPolicy,
                reviewModel: PUBLIC_CODEX_MODEL,
              });
              if (
                !reviewStructuralRecordAtLeastAsFresh(revalidatedStructuralRecord, item.updatedAt)
              ) {
                revalidatedStructuralRecord = null;
              }
              revalidatedPreviousReviewDigest = liveClawSweeperReviewDigest(item.number);
            } catch (error) {
              structuralCacheRevalidationFailures += 1;
              console.error(
                `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=revalidation-probe-failed #${item.number}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            } finally {
              structuralCacheRevalidationMs += Date.now() - structuralRevalidationStartedAt;
            }
            const revalidationDecision = reviewStructuralCacheDecision({
              review: priorReview
                ? {
                    ...priorReview,
                    reviewCommentSyncedAt: new Date().toISOString(),
                  }
                : null,
              priorRecord: initialStructuralRecord,
              currentRecord: revalidatedStructuralRecord,
              reviewPolicy,
              reviewModel: PUBLIC_CODEX_MODEL,
              explicitDispatch,
              maintainerRequest,
              coordinationEnabled: true,
            });
            const previousReviewIdentityMatches =
              expectedPreviousReviewDigest !== null &&
              revalidatedPreviousReviewDigest !== null &&
              expectedPreviousReviewDigest === revalidatedPreviousReviewDigest;
            const revalidationReason = previousReviewIdentityMatches
              ? revalidationDecision.reason
              : "previous_review_changed";
            structuralCacheRevalidationReasons.set(
              revalidationReason,
              (structuralCacheRevalidationReasons.get(revalidationReason) ?? 0) + 1,
            );
            if (!revalidationDecision.hit || !previousReviewIdentityMatches) {
              const leaseToRelease = acquiredReviewLease!;
              if (!releaseOwnedReviewLease(item.number, leaseToRelease)) {
                leaseAcquisitionFailures += 1;
                leaseAcquisitionFailureDetails.push(
                  `#${item.number}: could not release structural cache lease after ${revalidationReason}`,
                );
                continue;
              }
              const acquiredIndex = acquiredReviewLeases.findIndex(
                (entry) =>
                  entry.itemNumber === item.number &&
                  entry.lease.commentId === leaseToRelease.commentId &&
                  entry.lease.owner === leaseToRelease.owner,
              );
              if (acquiredIndex >= 0) acquiredReviewLeases.splice(acquiredIndex, 1);
              acquiredReviewLease = null;
              structuralRecord = revalidatedStructuralRecord;
              preHydrationStructuralRecord = revalidatedStructuralRecord;
              if (structuralRecord) item.updatedAt = structuralRecord.activityUpdatedAt;
              console.error(
                `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=revalidation-miss reason=${revalidationReason} hydrate #${item.number}`,
              );
            } else {
              const confirmedStructuralRecord = revalidatedStructuralRecord!;
              structuralRecord = confirmedStructuralRecord;
              item.updatedAt = confirmedStructuralRecord.activityUpdatedAt;
              const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
              let carried = priorReview!.markdown;
              carried = replaceFrontMatterValue(carried, "reviewed_at", new Date().toISOString());
              carried = replaceFrontMatterValue(carried, "item_updated_at", item.updatedAt);
              carried = replaceFrontMatterValue(
                carried,
                "review_lease_owner",
                acquiredReviewLease.owner,
              );
              carried = replaceFrontMatterValue(
                carried,
                "review_lease_comment_id",
                String(acquiredReviewLease.commentId),
              );
              carried = replaceFrontMatterValue(carried, "review_cache_hit", "true");
              carried = updateBulkFilerDetectedFrontMatter(carried, bulkFilerDetection);
              carried = updateReviewStructuralFrontMatter(carried, structuralRecord, true);
              writeFileSync(reportPath, carried, "utf8");
              finishReviewActionLedgerItem({
                ledger: reviewLedger,
                item,
                status: ACTION_EVENT_STATUSES.cached,
                reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
                retryable: false,
                cached: true,
                startedAtMs: reviewLedger.startedAtMs,
                ...((
                  item.kind === "pull_request"
                    ? confirmedStructuralRecord.pullHeadSha
                    : priorReview?.itemSourceRevision
                )
                  ? {
                      sourceRevision: (item.kind === "pull_request"
                        ? confirmedStructuralRecord.pullHeadSha
                        : priorReview?.itemSourceRevision)!,
                    }
                  : {}),
                reportPath,
                findingCount: reportReviewFindings(carried).length,
                completionReason: "structural_cache",
              });
              completed += 1;
              cacheHits += 1;
              structuralCacheHits += 1;
              if (humanLocalReview) {
                console.error("");
                console.error("Structural review cache hit; GitHub context unchanged");
                console.error(`  report: ${displayPath(reportPath)}`);
              } else {
                console.error(
                  `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} cache-hit structural-unchanged skip-hydration-model #${item.number} (${completed}/${candidates.length})`,
                );
              }
              continue;
            }
          }
        }
      }
      if (!skipStartComment && item.kind === "pull_request") {
        try {
          const startComment = postReviewStartStatusComment({
            item,
            headSha: structuralRecord?.pullHeadSha ?? pullRequestHeadSha(item.number),
            reviewTimeoutMs: timeoutMs,
            position: completed + 1,
            total: candidates.length,
            shardIndex,
            shardCount,
          });
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=${startComment.status} #${item.number}`,
          );
          if (startComment.status === "held") {
            coordinationHeldRetryAt = startComment.retryAt;
            continue;
          }
          acquiredReviewLease = startComment.lease;
          if (!acquiredReviewLease) {
            throw new Error(
              `review lease acquisition returned no identity for PR #${item.number}`,
            );
          }
          acquiredReviewLeases.push({ itemNumber: item.number, lease: acquiredReviewLease });
        } catch (error) {
          leaseAcquisitionFailures += 1;
          leaseAcquisitionFailureDetails.push(
            `#${item.number}: ${error instanceof Error ? error.message : String(error)}`,
          );
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }
      const contextStartedAt = Date.now();
      if (!localRangeData) hydrationRuns += 1;
      const context = localRangeData
        ? localRangeData.context
        : collectItemContext(item, {
            fullTimelineForRelations: true,
            reviewCacheDigest: true,
            reviewCacheGitDir: openclawDir,
          });
      if (bulkFilerDetection.context) context.bulkFiler = bulkFilerDetection.context;
      const contextElapsedMs = Date.now() - contextStartedAt;
      const contextItemUpdatedAt = stringOrUndefined(asRecord(context.issue).updatedAt);
      if (contextItemUpdatedAt) item.updatedAt = contextItemUpdatedAt;
      if (suppliedReviewLease) {
        const currentRevision =
          item.kind === "pull_request"
            ? pullHeadShaFromContext(context)
            : context.sourceRevision ?? null;
        if (!currentRevision) {
          coordinationHeldRetryAt = new Date(Date.now() + 60_000).toISOString();
          leaseAcquisitionFailures += 1;
          leaseAcquisitionFailureDetails.push(
            `#${item.number}: current revision could not be resolved for the reserved review lease`,
          );
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=stale-reservation #${item.number}`,
          );
          continue;
        }
        const freshLeases = freshDedicatedReviewStartLeases({
          comments: issueReviewCommentState(item.number).leaseComments,
          itemNumber: item.number,
          headSha: currentRevision,
          nowMs: Date.now(),
        });
        const winner = freshLeases[0];
        const supplied = freshLeases.find(
          (lease) =>
            commentId(lease.comment) === suppliedReviewLease.commentId &&
            lease.owner === suppliedReviewLease.owner,
        );
        if (!supplied || !winner) {
          coordinationHeldRetryAt = new Date(Date.now() + 60_000).toISOString();
          leaseAcquisitionFailures += 1;
          leaseAcquisitionFailureDetails.push(
            `#${item.number}: reserved review lease is no longer fresh for the current revision`,
          );
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=stale-reservation #${item.number}`,
          );
          continue;
        }
        if (
          commentId(winner.comment) !== suppliedReviewLease.commentId ||
          winner.owner !== suppliedReviewLease.owner
        ) {
          coordinationHeldRetryAt = winner.expiresAt;
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=held #${item.number}`,
          );
          continue;
        }
        const claimedLease: AcquiredReviewStartLease = {
          owner: suppliedReviewLease.owner,
          commentId: suppliedReviewLease.commentId,
          headSha: currentRevision,
          comment: supplied.comment,
        };
        acquiredReviewLease = claimedLease;
        acquiredReviewLeases.push({ itemNumber: item.number, lease: claimedLease });
      }
      if (!localRangeData && contextItemUpdatedAt && preHydrationStructuralRecord) {
        structuralCacheRevalidations += 1;
        const structuralRevalidationStartedAt = Date.now();
        try {
          git = loadReviewGitInfo();
          const candidate = fetchReviewStructuralRecord({
            item,
            git,
            reviewPolicy,
            reviewModel: PUBLIC_CODEX_MODEL,
          });
          if (
            reviewStructuralRecordsDescribeSameVerdictInput(
              preHydrationStructuralRecord,
              candidate,
            ) &&
            reviewStructuralRecordMatchesObservedUpdate(candidate, contextItemUpdatedAt) &&
            reviewStructuralRecordMatchesHydratedItem(
              candidate,
              context.structuralItemStateDigest,
            ) &&
            (item.kind !== "pull_request" ||
              reviewStructuralRecordMatchesHydratedPull(
                candidate,
                reviewStructuralPullStateFromContext(context),
              ))
          ) {
            hydratedStructuralAnchor = candidate;
          }
        } catch (error) {
          structuralCacheRevalidationFailures += 1;
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=hydrated-anchor-probe-failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          structuralCacheRevalidationMs += Date.now() - structuralRevalidationStartedAt;
        }
        const anchorReason = hydratedStructuralAnchor
          ? "hydrated_anchor_match"
          : "hydrated_anchor_miss";
        structuralCacheRevalidationReasons.set(
          anchorReason,
          (structuralCacheRevalidationReasons.get(anchorReason) ?? 0) + 1,
        );
      }
      const refreshStructuralRecordForVerdict = (): ReviewStructuralRecord | null => {
        if (!hydratedStructuralAnchor) return null;
        structuralCacheRevalidations += 1;
        const structuralRevalidationStartedAt = Date.now();
        let candidate: ReviewStructuralRecord | null = null;
        try {
          const refreshedGit = loadReviewGitInfo();
          candidate = fetchReviewStructuralRecord({
            item,
            git: refreshedGit,
            reviewPolicy,
            reviewModel: PUBLIC_CODEX_MODEL,
          });
        } catch (error) {
          structuralCacheRevalidationFailures += 1;
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} structural-cache=verdict-probe-failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          structuralCacheRevalidationMs += Date.now() - structuralRevalidationStartedAt;
        }
        const matched = reviewStructuralRecordsDescribeSameVerdictInput(
          hydratedStructuralAnchor,
          candidate,
        );
        const reason = matched ? "verdict_input_match" : "verdict_input_changed";
        structuralCacheRevalidationReasons.set(
          reason,
          (structuralCacheRevalidationReasons.get(reason) ?? 0) + 1,
        );
        return matched ? candidate : null;
      };
      if (
        acquiredReviewLease &&
        !reviewLeaseStillMatchesContext(
          item.kind,
          pullHeadShaFromContext(context),
          acquiredReviewLease.headSha,
        )
      ) {
        leaseAcquisitionFailures += 1;
        leaseAcquisitionFailureDetails.push(
          `#${item.number}: PR head changed after acquiring review lease`,
        );
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=stale-head #${item.number}`,
        );
        continue;
      }
      if (expectedSourceRevision) {
        enforceExpectedIssueSourceRevision({
          expectedSourceRevision,
          itemKind: item.kind,
          repo: item.repo,
          number: item.number,
          sourceRevision: context.sourceRevision,
          artifactDir,
        });
      }
      if (skipStartComment) {
        if (!humanLocalReview) {
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=skipped #${item.number}`,
          );
        }
      } else if (item.kind !== "pull_request") {
        try {
          const startComment = postReviewStartStatusComment({
            item,
            headSha: context.sourceRevision ?? "",
            reviewTimeoutMs: timeoutMs,
            position: completed + 1,
            total: candidates.length,
            shardIndex,
            shardCount,
          });
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=${startComment.status} #${item.number}`,
          );
          if (startComment.status === "held") {
            coordinationHeldRetryAt = startComment.retryAt;
            continue;
          }
          acquiredReviewLease = startComment.lease;
          if (!acquiredReviewLease) {
            throw new Error(
              `review lease acquisition returned no identity for issue #${item.number}`,
            );
          }
          acquiredReviewLeases.push({ itemNumber: item.number, lease: acquiredReviewLease });
        } catch (error) {
          leaseAcquisitionFailures += 1;
          leaseAcquisitionFailureDetails.push(
            `#${item.number}: ${error instanceof Error ? error.message : String(error)}`,
          );
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=failed #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }
      if (!localRangeData && item.kind === "issue" && acquiredReviewLease) {
        try {
          const revalidatedPreviousReview = extractLatestClawSweeperReview(
            fetchIssueReviewComments(item.number),
            item.number,
          );
          if (revalidatedPreviousReview) {
            context.previousClawSweeperReview = revalidatedPreviousReview;
          } else {
            delete context.previousClawSweeperReview;
          }
        } catch (error) {
          const leaseToRelease = acquiredReviewLease;
          leaseAcquisitionFailures += 1;
          leaseAcquisitionFailureDetails.push(
            `#${item.number}: could not refresh durable review after acquiring issue lease: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (!releaseOwnedReviewLease(item.number, leaseToRelease)) {
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: could not release issue review lease after durable review refresh failed`,
            );
            continue;
          }
          const acquiredIndex = acquiredReviewLeases.findIndex(
            (entry) =>
              entry.itemNumber === item.number &&
              entry.lease.commentId === leaseToRelease.commentId &&
              entry.lease.owner === leaseToRelease.owner,
          );
          if (acquiredIndex >= 0) acquiredReviewLeases.splice(acquiredIndex, 1);
          acquiredReviewLease = null;
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} durable-review=revalidation-failed defer #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }
      const contentDigest = itemContentDigest(item, context, git);
      let currentPreviousReviewDigest: string | null = null;
      let previousReviewIdentityChanged = false;
      let semanticDecision: ReturnType<typeof reviewSemanticCacheDecision> | null = null;
      if (!localRangeData) {
        const semanticCacheStartedAt = Date.now();
        semanticCacheChecks += 1;
        semanticRecord = createReviewSemanticRecord({
          item,
          context,
          git,
          structuralContextRevision: hydratedStructuralAnchor?.contextRevision ?? null,
          reviewPolicy,
          reviewModel: PUBLIC_CODEX_MODEL,
        });
        semanticCacheMs += Date.now() - semanticCacheStartedAt;
        semanticCacheEligibilityReasons.set(
          semanticRecord.eligibilityReason,
          (semanticCacheEligibilityReasons.get(semanticRecord.eligibilityReason) ?? 0) + 1,
        );
        if (!semanticRecord.eligible) semanticCacheIneligible += 1;
        currentPreviousReviewDigest = reviewSemanticPriorReviewDigest(
          context.previousClawSweeperReview,
        );
        previousReviewIdentityChanged =
          !expectedPreviousReviewDigest ||
          !currentPreviousReviewDigest ||
          expectedPreviousReviewDigest !== currentPreviousReviewDigest;
        semanticDecision = reviewSemanticCacheDecision({
          review: priorReview,
          priorRecord: priorReview?.semanticRecord ?? null,
          currentRecord: semanticRecord,
          expectedPreviousReviewDigest,
          currentPreviousReviewDigest,
          reviewPolicy,
          reviewModel: PUBLIC_CODEX_MODEL,
          explicitDispatch,
          maintainerRequest,
          coordinationEnabled: Boolean(acquiredReviewLease),
        });
        semanticCacheReasons.set(
          semanticDecision.reason,
          (semanticCacheReasons.get(semanticDecision.reason) ?? 0) + 1,
        );
      }
      if (semanticDecision?.hit) {
        semanticCacheRevalidations += 1;
        const initialSemanticRecord = semanticRecord;
        const semanticRevalidationStartedAt = Date.now();
        const revalidatedStructuralRecord = refreshStructuralRecordForVerdict();
        const revalidatedChecks =
          revalidatedStructuralRecord?.pullHeadSha &&
          revalidatedStructuralRecord.pullHeadSha === pullHeadShaFromContext(context)
            ? pullChecksContext(item.number, revalidatedStructuralRecord.pullHeadSha)
            : {
                complete: false,
                checkRuns: [],
                checkRunsTruncated: true,
                statuses: [],
                statusesTruncated: true,
              };
        if (!completePullChecksContext(revalidatedChecks)) {
          semanticCacheRevalidationFailures += 1;
        }
        const revalidatedContext: ItemContext = {
          ...context,
          pullChecks: revalidatedChecks,
        };
        let revalidatedPreviousReview: PreviousClawSweeperReview | null;
        try {
          revalidatedPreviousReview = extractLatestClawSweeperReview(
            fetchIssueReviewComments(item.number),
            item.number,
          );
        } catch (error) {
          const revalidationReason = "durable_review_refresh_failed";
          semanticCacheRevalidationFailures += 1;
          semanticCacheRevalidationMs += Date.now() - semanticRevalidationStartedAt;
          semanticCacheRevalidationReasons.set(
            revalidationReason,
            (semanticCacheRevalidationReasons.get(revalidationReason) ?? 0) + 1,
          );
          const leaseToRelease = acquiredReviewLease!;
          if (!releaseOwnedReviewLease(item.number, leaseToRelease)) {
            leaseAcquisitionFailures += 1;
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: could not release semantic cache lease after ${revalidationReason}`,
            );
            continue;
          }
          const acquiredIndex = acquiredReviewLeases.findIndex(
            (entry) =>
              entry.itemNumber === item.number &&
              entry.lease.commentId === leaseToRelease.commentId &&
              entry.lease.owner === leaseToRelease.owner,
          );
          if (acquiredIndex >= 0) acquiredReviewLeases.splice(acquiredIndex, 1);
          acquiredReviewLease = null;
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} semantic-cache=revalidation-failed reason=${revalidationReason} defer #${item.number}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        if (revalidatedPreviousReview) {
          revalidatedContext.previousClawSweeperReview = revalidatedPreviousReview;
        } else {
          delete revalidatedContext.previousClawSweeperReview;
        }
        const revalidatedRelatedItems = refreshRelatedItemsContext(item, context);
        if (revalidatedRelatedItems.length > 0) {
          revalidatedContext.relatedItems = revalidatedRelatedItems;
        } else {
          delete revalidatedContext.relatedItems;
        }
        if (
          revalidatedContext.counts &&
          (context.counts?.relatedItems !== undefined || revalidatedRelatedItems.length > 0)
        ) {
          revalidatedContext.counts = {
            ...revalidatedContext.counts,
            relatedItems: revalidatedRelatedItems.length,
          };
        }
        const revalidatedSemanticRecord = createReviewSemanticRecord({
          item,
          context: revalidatedContext,
          git,
          structuralContextRevision: revalidatedStructuralRecord?.contextRevision ?? null,
          reviewPolicy,
          reviewModel: PUBLIC_CODEX_MODEL,
        });
        const semanticRevalidationDecision = reviewSemanticRevalidationDecision({
          initialRecord: initialSemanticRecord,
          currentRecord: revalidatedSemanticRecord,
          initialPreviousReviewDigest: currentPreviousReviewDigest,
          currentPreviousReviewDigest: reviewSemanticPriorReviewDigest(
            revalidatedContext.previousClawSweeperReview,
          ),
          reviewPolicy,
          reviewModel: PUBLIC_CODEX_MODEL,
        });
        semanticCacheRevalidationMs += Date.now() - semanticRevalidationStartedAt;
        const revalidationReason = revalidatedStructuralRecord
          ? semanticRevalidationDecision.reason
          : "structural_verdict_input_changed";
        semanticCacheRevalidationReasons.set(
          revalidationReason,
          (semanticCacheRevalidationReasons.get(revalidationReason) ?? 0) + 1,
        );
        if (!revalidatedStructuralRecord || !semanticRevalidationDecision.hit) {
          const leaseToRelease = acquiredReviewLease!;
          if (!releaseOwnedReviewLease(item.number, leaseToRelease)) {
            leaseAcquisitionFailures += 1;
            leaseAcquisitionFailureDetails.push(
              `#${item.number}: could not release semantic cache lease after ${revalidationReason}`,
            );
            continue;
          }
          const acquiredIndex = acquiredReviewLeases.findIndex(
            (entry) =>
              entry.itemNumber === item.number &&
              entry.lease.commentId === leaseToRelease.commentId &&
              entry.lease.owner === leaseToRelease.owner,
          );
          if (acquiredIndex >= 0) acquiredReviewLeases.splice(acquiredIndex, 1);
          acquiredReviewLease = null;
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} semantic-cache=revalidation-miss reason=${revalidationReason} defer #${item.number}`,
          );
          continue;
        }
        structuralRecord = revalidatedStructuralRecord;
        semanticRecord = revalidatedSemanticRecord;
        if (structuralRecord) item.updatedAt = structuralRecord.activityUpdatedAt;
        const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
        let carried = priorReview!.markdown;
        carried = replaceFrontMatterValue(carried, "reviewed_at", new Date().toISOString());
        carried = replaceFrontMatterValue(carried, "item_updated_at", item.updatedAt);
        carried = replaceFrontMatterValue(
          carried,
          "review_lease_owner",
          acquiredReviewLease!.owner,
        );
        carried = replaceFrontMatterValue(
          carried,
          "review_lease_comment_id",
          String(acquiredReviewLease!.commentId),
        );
        carried = replaceFrontMatterValue(
          carried,
          "item_snapshot_hash",
          itemSnapshotHash(item, context),
        );
        carried = replaceFrontMatterValue(carried, "review_content_digest", contentDigest);
        carried = replaceFrontMatterValue(
          carried,
          "item_source_revision",
          context.sourceRevision ?? "unknown",
        );
        carried = replaceFrontMatterValue(
          carried,
          "pull_head_sha",
          pullHeadShaFromContext(context) ?? "unknown",
        );
        carried = replaceFrontMatterValue(carried, "main_sha", git.mainSha);
        carried = replaceFrontMatterValue(carried, "review_cache_hit", "true");
        carried = updateBulkFilerDetectedFrontMatter(carried, bulkFilerDetection);
        carried = updateReviewStructuralFrontMatter(carried, structuralRecord, false);
        carried = updateReviewSemanticFrontMatter(carried, semanticRecord, true);
        writeFileSync(reportPath, carried, "utf8");
        finishReviewActionLedgerItem({
          ledger: reviewLedger,
          item,
          status: ACTION_EVENT_STATUSES.cached,
          reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
          retryable: false,
          cached: true,
          startedAtMs: contextStartedAt,
          ...(context.sourceRevision ? { sourceRevision: context.sourceRevision } : {}),
          reportPath,
          findingCount: reportReviewFindings(carried).length,
          completionReason: "semantic_cache",
        });
        activeReviewItem = null;
        completed += 1;
        cacheHits += 1;
        semanticCacheHits += 1;
        if (humanLocalReview) {
          console.error("");
          console.error("Semantic review cache hit; code and review context unchanged");
          console.error(`  report: ${displayPath(reportPath)}`);
        } else {
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} cache-hit semantic-unchanged skip-model #${item.number} (${completed}/${candidates.length})`,
          );
        }
        continue;
      }
      const contentCacheReview =
        explicitDispatch ||
        maintainerRequest ||
        previousReviewIdentityChanged ||
        !git.releaseStateComplete ||
        (item.kind === "pull_request" && !completePullChecksContext(context.pullChecks))
          ? null
          : priorReview;
      if (
        reviewContentCacheHit({
          review: contentCacheReview,
          reviewPolicy,
          contentDigest,
          now: Date.now(),
          explicitDispatch,
          maintainerRequest,
        })
      ) {
        structuralRecord = refreshStructuralRecordForVerdict();
        const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
        let carried = priorReview!.markdown;
        carried = replaceFrontMatterValue(carried, "reviewed_at", new Date().toISOString());
        carried = replaceFrontMatterValue(carried, "item_updated_at", item.updatedAt);
        carried = replaceFrontMatterValue(
          carried,
          "review_lease_owner",
          acquiredReviewLease?.owner ?? "unknown",
        );
        carried = replaceFrontMatterValue(
          carried,
          "review_lease_comment_id",
          String(acquiredReviewLease?.commentId ?? "unknown"),
        );
        carried = replaceFrontMatterValue(
          carried,
          "item_snapshot_hash",
          itemSnapshotHash(item, context),
        );
        carried = replaceFrontMatterValue(carried, "review_cache_hit", "true");
        carried = updateBulkFilerDetectedFrontMatter(carried, bulkFilerDetection);
        carried = structuralRecord
          ? updateReviewStructuralFrontMatter(carried, structuralRecord, false)
          : replaceFrontMatterValue(carried, "review_structural_cache_hit", "false");
        carried = updateReviewSemanticFrontMatter(carried, semanticRecord, false);
        writeFileSync(reportPath, carried, "utf8");
        finishReviewActionLedgerItem({
          ledger: reviewLedger,
          item,
          status: ACTION_EVENT_STATUSES.cached,
          reasonCode: ACTION_EVENT_REASON_CODES.contentUnchanged,
          retryable: false,
          cached: true,
          startedAtMs: contextStartedAt,
          ...(context.sourceRevision ? { sourceRevision: context.sourceRevision } : {}),
          reportPath,
          findingCount: reportReviewFindings(carried).length,
          completionReason: "content_cache",
        });
        activeReviewItem = null;
        completed += 1;
        cacheHits += 1;
        contentCacheHits += 1;
        if (humanLocalReview) {
          console.error("");
          console.error("Review cache hit; content unchanged since the last review");
          console.error(`  report: ${displayPath(reportPath)}`);
        } else {
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} cache-hit content-unchanged skip-model #${item.number} (${completed}/${candidates.length})`,
          );
        }
        continue;
      }
      const codexWorkDir = join(artifactDir, "codex");
      const proofScratchDir = join(codexWorkDir, "proof-scratch", String(item.number));
      // --local-range is a pre-PR LOCAL code review — it has no telegram-visible-proof to
      // capture, and prepareMediaProofArtifacts would host-side download media URLs and transcode
      // videos in the synthetic body (commit message / --body-file). Skip it entirely for
      // local-range: no host download or transcode of body-supplied URLs.
      const preparedMediaProof: PreparedMediaProof = localRangeData
        ? { manifestPath: null, summaryPath: null, artifacts: [] }
        : prepareMediaProofArtifacts(context, proofScratchDir);
      const prompt = buildReviewPrompt(
        item,
        context,
        git,
        additionalPrompt,
        mediaProofRuntimeHints(proofScratchDir, preparedMediaProof),
      );
      const snapshotHash = itemSnapshotHash(item, context);
      let decision: Decision;
      let codexElapsedMs = 0;
      let codexFailed = false;
      let codexFailureRetryable = false;
      let codexFailureDisposition: ReturnType<typeof actionLedgerFailureDisposition> | null =
        null;
      const codexStartedAt = Date.now();
      try {
        if (humanLocalReview) {
          console.error("");
          console.error("Running Codex review");
          console.error(`  timeout: ${displayDurationMs(timeoutMs)}`);
          console.error(
            `  stdout: ${displayPath(join(codexWorkDir, `${item.number}.1.codex.stdout.log`))}`,
          );
          console.error(
            `  stderr: ${displayPath(join(codexWorkDir, `${item.number}.1.codex.stderr.log`))}`,
          );
        }
        decision = runCodex({
          item,
          context,
          git,
          model,
          openclawDir,
          reasoningEffort,
          sandboxMode,
          serviceTier,
          forcedLoginMethod,
          preserveCodexAuth: localOnly,
          timeoutMs,
          workDir: codexWorkDir,
          additionalPrompt,
          proofScratchDir,
          prompt: prompt.text,
          quietLogs: humanLocalReview,
          ...(localRange ? { extraCodexConfig: [LOCAL_REVIEW_WEB_SEARCH_CONFIG] } : {}),
        });
      } catch (error) {
        codexFailures += 1;
        codexFailed = true;
        codexFailureRetryable = codexReviewFailureRetryable(error);
        codexFailureDisposition = actionLedgerFailureDisposition(error);
        if (error instanceof CodexReviewError) {
          decision = codexFailureDecision(
            error.status,
            error.message,
            error.stdout,
            error.stderr,
            {
              errorCode: error.errorCode,
              signal: error.signal,
            },
          );
        } else {
          decision = codexFailureDecision(
            null,
            error instanceof Error ? error.message : String(error),
            "Per-item Codex failure; continuing with the rest of the shard.",
          );
        }
      } finally {
        codexElapsedMs = Date.now() - codexStartedAt;
      }
      decision = attachFixedPullRequest(decision, item, context);
      const runtime = {
        model: PUBLIC_CODEX_MODEL,
        reasoningEffort,
        sandboxMode,
        serviceTier,
        ...prompt.telemetry,
        contextElapsedMs,
        codexElapsedMs,
      };
      const action = reviewActionForDecision({ item, decision, git, runtime });
      structuralRecord = refreshStructuralRecordForVerdict();
      const reportPath = join(artifactDir, reportFileName(item.repo, item.number));
      writeFileSync(
        reportPath,
        markdownFor({
          item,
          context,
          decision,
          git,
          action,
          reviewMode: "propose",
          snapshotHash,
          contentDigest,
          reviewPolicy,
          runtime,
          structuralRecord,
          semanticRecord,
          ...(acquiredReviewLease
            ? {
                reviewLeaseOwner: acquiredReviewLease.owner,
                reviewLeaseCommentId: acquiredReviewLease.commentId,
              }
            : {}),
        }),
        "utf8",
      );
      recordReviewLogPublication({
        ledger: reviewLedger,
        item,
        codexWorkDir,
        cached: false,
      });
      finishReviewActionLedgerItem({
        ledger: reviewLedger,
        item,
        status: codexFailureDisposition?.status ?? ACTION_EVENT_STATUSES.completed,
        reasonCode: codexFailureDisposition?.reasonCode ?? ACTION_EVENT_REASON_CODES.completed,
        retryable: codexFailed && codexFailureRetryable,
        cached: false,
        startedAtMs: contextStartedAt,
        ...(context.sourceRevision ? { sourceRevision: context.sourceRevision } : {}),
        reportPath,
        findingCount: decision.reviewFindings.length,
        completionReason: codexFailureDisposition?.completionReason ?? decision.decision,
      });
      activeReviewItem = null;
      completed += 1;
      if (codexFailed) codexFailureReports.push(reportPath);
      if (humanLocalReview) {
        console.error("");
        console.error(codexFailed ? "Codex review failed" : "Review complete");
        console.error(`  elapsed: ${displayDurationMs(codexElapsedMs)}`);
        console.error(`  decision: ${decision.decision}`);
        console.error(`  confidence: ${decision.confidence}`);
        console.error(`  action: ${action.actionTaken}`);
        console.error(`  report: ${displayPath(reportPath)}`);
      } else {
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} done #${item.number} (${completed}/${candidates.length}) decision=${decision.decision} confidence=${decision.confidence} action=${action.actionTaken}`,
        );
      }
      } catch (error) {
        reviewItemFailed = true;
        throw error;
      } finally {
        try {
          if (
            !reviewItemFailed &&
            activeReviewItem &&
            actionLedgerItemKey(activeReviewItem) === actionLedgerItemKey(item)
          ) {
            finishReviewActionLedgerItem({
              ledger: reviewLedger,
              item,
              status: ACTION_EVENT_STATUSES.blocked,
              reasonCode: ACTION_EVENT_REASON_CODES.leaseActive,
              retryable: true,
              cached: false,
              startedAtMs:
                reviewLedger.items.get(actionLedgerItemKey(item))?.startedAtMs ??
                reviewLedger.startedAtMs,
              completionReason: "coordination_deferred",
            });
            activeReviewItem = null;
          }
        } finally {
          activeReviewMutationRunner = previousReviewMutationRunner;
        }
      }
    }
    if (coordinationHeldRetryAt) {
      writeFileSync(
        coordinationHeldPath,
        JSON.stringify({ retry_at: coordinationHeldRetryAt }, null, 2) + "\n",
        "utf8",
      );
    }
    if (!humanLocalReview) {
      console.error(
        `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} complete reviewed=${completed} cache_hits=${cacheHits} structural_cache_checks=${structuralCacheChecks} structural_cache_hits=${structuralCacheHits} structural_cache_revalidations=${structuralCacheRevalidations} semantic_cache_checks=${semanticCacheChecks} semantic_cache_hits=${semanticCacheHits} semantic_cache_ineligible=${semanticCacheIneligible} semantic_cache_revalidations=${semanticCacheRevalidations} content_cache_hits=${contentCacheHits} hydrations=${hydrationRuns}`,
      );
    }
    writeFileSync(
      join(artifactDir, "review-cache-metrics.json"),
      JSON.stringify(
        {
          candidates: candidates.length,
          completed,
          cache_hits: cacheHits,
          structural_cache_checks: structuralCacheChecks,
          structural_cache_hits: structuralCacheHits,
          structural_cache_probe_failures: structuralCacheProbeFailures,
          structural_cache_probe_ms: structuralCacheProbeMs,
          structural_cache_revalidations: structuralCacheRevalidations,
          structural_cache_revalidation_failures: structuralCacheRevalidationFailures,
          structural_cache_revalidation_ms: structuralCacheRevalidationMs,
          structural_cache_reasons: Object.fromEntries(
            [...structuralCacheReasons.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
          structural_cache_revalidation_reasons: Object.fromEntries(
            [...structuralCacheRevalidationReasons.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
          semantic_cache_checks: semanticCacheChecks,
          semantic_cache_hits: semanticCacheHits,
          semantic_cache_ineligible: semanticCacheIneligible,
          semantic_cache_ms: semanticCacheMs,
          semantic_cache_revalidations: semanticCacheRevalidations,
          semantic_cache_revalidation_failures: semanticCacheRevalidationFailures,
          semantic_cache_revalidation_ms: semanticCacheRevalidationMs,
          semantic_cache_reasons: Object.fromEntries(
            [...semanticCacheReasons.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
          semantic_cache_eligibility_reasons: Object.fromEntries(
            [...semanticCacheEligibilityReasons.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
          semantic_cache_revalidation_reasons: Object.fromEntries(
            [...semanticCacheRevalidationReasons.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
          content_cache_hits: contentCacheHits,
          hydrations: hydrationRuns,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    if (leaseAcquisitionFailures > 0) {
      throw new Error(
        `Could not acquire durable review coordination for ${leaseAcquisitionFailures} item${
          leaseAcquisitionFailures === 1 ? "" : "s"
        }; the workflow recovery lane can requeue the planned set. ${leaseAcquisitionFailureDetails.join("; ")}`,
      );
    }
    if (codexFailures > 0) {
      for (const reportPath of codexFailureReports) {
        const failureKind = codexFailureLogKind(readFileSync(reportPath, "utf8"));
        console.error(
          `[review] ${new Date().toISOString()} codex-failure classification=${failureKind} report=${displayPath(reportPath)}`,
        );
      }
      const message = `Codex failed for ${codexFailures} item${
        codexFailures === 1 ? "" : "s"
      }; review artifacts were written and the workflow recovery lane can requeue the planned set.${
        codexFailureReports.length > 0
          ? ` Report${codexFailureReports.length === 1 ? "" : "s"}: ${codexFailureReports
              .map(displayPath)
              .join(", ")}`
          : ""
      }`;
      if (humanLocalReview) throw new UserFacingCommandError(message);
      throw new Error(message);
    }
    finishReviewActionLedger({
      ledger: reviewLedger,
      completedCount: completed,
      cacheHits,
    });
  } catch (error) {
    if (reviewLedger) {
      for (const acquired of acquiredReviewLeases) {
        const state = [...reviewLedger.items.values()].find(
          (candidate) => candidate.item.number === acquired.itemNumber,
        );
        if (!state) continue;
        const previousReviewMutationRunner = activeReviewMutationRunner;
        activeReviewMutationRunner = reviewMutationRunner(reviewLedger, state.item);
        try {
          releaseOwnedReviewLease(acquired.itemNumber, acquired.lease);
        } finally {
          activeReviewMutationRunner = previousReviewMutationRunner;
        }
      }
      finishReviewActionLedger({
        ledger: reviewLedger,
        error,
        activeItem: activeReviewItem,
        completedCount: completed,
        cacheHits,
      });
    }
    throw error;
  } finally {
    restoreTreeModes(readonlyModeSnapshots);
  }
}

const SOURCE_REVISION_MISMATCH_MARKER = "source-revision-mismatch.json";

function enforceExpectedIssueSourceRevision(options: ExpectedIssueSourceRevisionOptions): void {
  if (options.itemKind !== "issue") {
    throw new UserFacingCommandError(
      "--expected-source-revision can only bind an exact issue review.",
    );
  }
  const actualSourceRevision = options.sourceRevision ?? "";
  if (!/^[0-9a-f]{64}$/.test(actualSourceRevision)) {
    throw new UserFacingCommandError(
      `Could not compute the live source revision for ${options.repo}#${options.number}.`,
    );
  }
  if (actualSourceRevision === options.expectedSourceRevision) return;

  writeFileSync(
    join(options.artifactDir, SOURCE_REVISION_MISMATCH_MARKER),
    `${JSON.stringify(
      {
        schema_version: 1,
        target_repo: options.repo,
        item_number: options.number,
        expected_source_revision: options.expectedSourceRevision,
        actual_source_revision: actualSourceRevision,
        detected_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  throw new UserFacingCommandError(
    `${options.repo}#${options.number} changed before review: expected source revision ${options.expectedSourceRevision}, found ${actualSourceRevision}.`,
  );
}

export function enforceExpectedIssueSourceRevisionForTest(
  options: ExpectedIssueSourceRevisionOptions,
): void {
  enforceExpectedIssueSourceRevision(options);
}

function livePullHeadSha(number: number): string | null {
  const sha = ghWithRetry([
    "api",
    `repos/${targetRepo()}/pulls/${number}`,
    "--jq",
    ".head.sha // empty",
  ]);
  return sha.trim() || null;
}

function liveIssueSourceRevision(number: number): string {
  const issue = ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]);
  const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
  return itemSourceRevisionSha256(issue, comments);
}

const failedReviewRetryWorkflow = createFailedReviewRetryWorkflow({
  root: ROOT,
  appendSectionValue,
  codexFailureReason,
  defaultItemsDir,
  effectiveReviewStatus,
  ensureDir,
  ensureGitHubRuntimeAvailable,
  failedReviewFailureDetail,
  failedReviewRetryEligibility,
  failedReviewRetryResultRevision,
  failedReviewRetryRevisionForReport,
  fetchItem,
  frontMatterValue,
  ghRawOnceWithCheckpoint,
  ghWithRetry,
  isDispatchError: (error): error is GitHubDispatchError => error instanceof GitHubDispatchError,
  isFailedReviewRetryAlreadyExhausted,
  isMarkdownForActiveRepo,
  isRuntimeBudgetError: (error): error is GitHubRuntimeBudgetError =>
    error instanceof GitHubRuntimeBudgetError,
  liveIssueSourceRevision,
  livePullHeadSha,
  lockedConversationApplyReason,
  markdownFiles,
  numberForMarkdownFile,
  replaceFrontMatterValue,
  replaceSectionValue,
  repoFromArgs,
  repoRelativePath,
  reportItemKind,
  reviewLeaseRevisionFromReport,
  reviewLedger: reviewActionLedger,
  sameFailedReviewRetryRevision,
  sectionValue,
  storedFailedReviewRetryRevision,
  targetRepo,
  withGitHubRuntimeBudget,
});
export const {
  preserveFailedReviewRetryMetadataForTest,
  reviewRetryActionDisposition,
  reviewRetryActionNeedsItemEventForTest,
  reviewRetryBatchEventDisposition,
  reviewRetryBusinessIdempotencyIdentityForTest,
} = failedReviewRetryWorkflow;
const {
  failedReviewRetryMarkdownWithState,
  failedReviewRetryStatePath,
  preserveFailedReviewRetryMetadata,
  readFailedReviewRetryState,
  retryFailedReviewsCommand,
} = failedReviewRetryWorkflow;

const applyActionLedger = createApplyActionLedger({
  root: ROOT,
  targetRepo,
  repoRelativePath,
  sha256,
  frontMatterValue,
  reviewLeaseRevisionFromReport,
  reportItemKind,
  reviewLedger: reviewActionLedger,
});
export const {
  applyActionEventDisposition,
  applyItemBusinessIdempotencyIdentityForTest,
  applyMutationBusinessIdempotencyIdentityForTest,
  applyPhaseSequenceForTest,
  applyRuntimeBudgetYieldResultsForTest,
  reviewCommentPublicationEventDisposition,
} = applyActionLedger;
const {
  applyRuntimeBudgetYieldResults,
  finishApplyMutationAttempt,
  recordApplyActionEvents,
  recordApplyActionLedgerItemResults,
  recordApplyMutationBoundary,
  startApplyActionLedger,
  startApplyActionLedgerItem,
  startApplyMutationAttempt,
} = applyActionLedger;

function applyRuntimeBudget(
  configuredMaxRuntimeMs: number,
  tokenDeadlineText: string | undefined,
  nowMs = Date.now(),
): GitHubRuntimeBudget {
  if (!tokenDeadlineText) {
    return { startedAtMs: nowMs, maxRuntimeMs: configuredMaxRuntimeMs };
  }
  if (!/^\d+$/.test(tokenDeadlineText)) {
    throw new Error("CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS must be a Unix timestamp in milliseconds");
  }
  const tokenDeadlineMs = Number(tokenDeadlineText);
  if (!Number.isSafeInteger(tokenDeadlineMs)) {
    throw new Error("CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS is outside the safe integer range");
  }
  const remainingMs = tokenDeadlineMs - nowMs;
  if (remainingMs <= 0) {
    return {
      startedAtMs: nowMs - 1,
      maxRuntimeMs: 1,
      limitReason: `apply token budget reached at ${tokenDeadlineMs}ms since epoch`,
    };
  }
  if (configuredMaxRuntimeMs > 0 && configuredMaxRuntimeMs <= remainingMs) {
    return { startedAtMs: nowMs, maxRuntimeMs: configuredMaxRuntimeMs };
  }
  return {
    startedAtMs: nowMs,
    maxRuntimeMs: remainingMs,
    limitReason: `apply token budget reached at ${tokenDeadlineMs}ms since epoch`,
  };
}

export function applyRuntimeBudgetForTest(options: {
  configuredMaxRuntimeMs: number;
  tokenDeadlineMs?: number;
  nowMs: number;
}): Pick<GitHubRuntimeBudget, "startedAtMs" | "maxRuntimeMs" | "limitReason"> {
  return applyRuntimeBudget(
    options.configuredMaxRuntimeMs,
    options.tokenDeadlineMs === undefined ? undefined : String(options.tokenDeadlineMs),
    options.nowMs,
  );
}

function applyDecisionsCommand(args: Args): void {
  const runtimeBudget = applyRuntimeBudget(
    numberArg(args.max_runtime_ms, 0),
    process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS,
  );
  withGitHubRuntimeBudget(runtimeBudget, () => {
    try {
      applyDecisionsCommandInner(args, runtimeBudget);
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError && runtimeBudget.onYield) {
        runtimeBudget.onYield(error.reason);
        return;
      }
      runtimeBudget.onFailure?.(error);
      throw error;
    }
  });
}

function applyDecisionsCommandInner(args: Args, runtimeBudget: GitHubRuntimeBudget): void {
  const profile = repoFromArgs(args);
  const recordRoot = resolve(stringArg(args.record_root, ROOT));
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
  const limit = numberArg(args.limit, 20);
  const processedLimit = numberArg(args.processed_limit, Math.max(limit * 2, 50));
  const minAgeDays = numberArg(args.min_age_days, 0);
  const minAgeMinutes = optionalNumberArg(args.min_age_minutes);
  const minAgeMs = minAgeMinutes === undefined ? minAgeDays * DAY_MS : minAgeMinutes * 60 * 1000;
  const minAgeDescription =
    minAgeMinutes === undefined ? `${minAgeDays} days` : `${minAgeMinutes} minutes`;
  const applyKind = applyKindArg(args.apply_kind);
  const applyCloseReasons = closeReasonsArg(args.apply_close_reasons);
  const staleMinAgeDays = numberArg(args.stale_min_age_days, STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS);
  const closeDelayMs = numberArg(args.close_delay_ms, 2_000);
  const progressEvery = Math.max(1, numberArg(args.progress_every, 10));
  const dryRun = boolArg(args.dry_run);
  const canonicalBaselineDir = stringArg(
    args.canonical_record_baseline_dir,
    process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR ?? "",
  ).trim();
  const requirePrecomputedPrCloseCoverageProof = boolArg(
    args.require_precomputed_pr_close_coverage_proof,
  );
  const syncCommentsOnly = boolArg(args.sync_comments_only);
  const suppressAutomationMarkers = boolArg(args.suppress_automation_markers);
  const emitEventApplyProof = boolArg(args.event_apply_proof);
  const exactEventPublication = boolArg(args.exact_event_publication);
  const commentSyncMinAgeDays = numberArg(args.comment_sync_min_age_days, 0);
  const reportPath = resolve(stringArg(args.report_path, join(ROOT, "apply-report.json")));
  const artifactDir = resolve(stringArg(args.artifact_dir, join(ROOT, "artifacts", "apply")));
  const cursorTraceArg = stringArg(args.cursor_trace, "").trim();
  const cursorTracePath = cursorTraceArg ? resolve(cursorTraceArg) : null;
  const prCloseCoverageProofRuntime: PrCloseCoverageProofRuntime = {
    model: stringArg(args.codex_model, DEFAULT_CODEX_MODEL),
    reasoningEffort: stringArg(args.codex_reasoning_effort, DEFAULT_REASONING_EFFORT),
    sandboxMode: stringArg(args.codex_sandbox, "read-only"),
    serviceTier: stringArg(args.codex_service_tier, DEFAULT_SERVICE_TIER),
    timeoutMs: numberArg(args.codex_timeout_ms, 600_000),
    workDir: join(artifactDir, "pr-close-coverage-proof"),
    rootDir: ROOT,
    schemaPath: PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH,
    promptTemplate: prCloseCoverageProofPromptTemplate(),
    ...(process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN
      ? { ghToken: process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN }
      : {}),
  };
  const startedAtMs = Date.now();
  const { maxRuntimeMs } = runtimeBudget;
  const bulkFilerRepositoryPermissionCache: BulkFilerRepositoryPermissionCache = new Map();
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const requestedItemNumberSet = new Set(requestedItemNumbers);
  const reconciliationDeferredItemNumbers = new Set(
    itemNumbersArg(
      args.deferred_item_numbers ?? process.env.CLAWSWEEPER_RECONCILIATION_DEFERRED_ITEM_NUMBERS,
      undefined,
    ),
  );
  const requestedItemOrder = orderedApplyItemNumbers(args.item_numbers, args.item_number);
  const requestedItemOrderIndex = new Map(
    requestedItemOrder.map((number, index) => [number, index]),
  );
  const results: ApplyResult[] = [];
  const examinedItemNumbers: number[] = [];
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
  const applyReportEntriesForDir = (
    dir: string,
    location: "items" | "closed",
    filterRequested = true,
  ): Array<
    ReportEntry & {
      location: "items" | "closed";
      priority: number;
      applyCheckedAt: number;
    }
  > =>
    reportEntriesForDir(
      dir,
      filterRequested && requestedItemNumberSet.size > 0 ? requestedItemNumberSet : undefined,
    )
      .filter(
        (entry) =>
          entry.repo === targetRepo() &&
          (!filterRequested ||
            requestedItemNumberSet.size === 0 ||
            requestedItemNumberSet.has(entry.number)),
      )
      .map((entry) => ({
        ...entry,
        location,
        ...applyQueueSortFields(entry.markdown, syncCommentsOnly, applyKind),
      }));
  const captureApplyCanonicalBaseline = (reportPath: string): void => {
    if (dryRun || !canonicalBaselineDir) return;
    const file = basename(reportPath);
    const number = numberForMarkdownFile(file);
    const packetName = `${number}.json`;
    captureCanonicalRecordBaseline({
      baselineRoot: canonicalBaselineDir,
      repositorySlug: profile.slug,
      itemNumber: number,
      sources: [
        { section: "items", name: file, path: join(itemsDir, file) },
        { section: "closed", name: file, path: join(closedDir, file) },
        { section: "plans", name: file, path: join(plansDir, file) },
        {
          section: "decision-packets",
          name: packetName,
          path: join(decisionPacketsDir, packetName),
        },
      ],
    });
  };
  const syncDecisionPacketMarkdown = (
    reportPath: string,
    nextMarkdown: string,
    subjectState: DecisionPacketSubjectState = "open",
  ): string =>
    syncDecisionPacketRecord({
      markdown: nextMarkdown,
      reportPath,
      packetsDir: decisionPacketsDir,
      repoRoot: recordRoot,
      subjectState,
    }).markdown;
  const writeReportMarkdown = (
    reportPath: string,
    nextMarkdown: string,
    subjectState: DecisionPacketSubjectState = "open",
  ): void => {
    captureApplyCanonicalBaseline(reportPath);
    writeFileSync(
      reportPath,
      syncDecisionPacketMarkdown(reportPath, nextMarkdown, subjectState),
      "utf8",
    );
  };
  const fileEntries = applyReportEntriesForDir(itemsDir, "items").sort(
    cursorTracePath
      ? (left, right) =>
          (requestedItemOrderIndex.get(left.number) ?? Number.MAX_SAFE_INTEGER) -
            (requestedItemOrderIndex.get(right.number) ?? Number.MAX_SAFE_INTEGER) ||
          left.number - right.number
      : (left, right) =>
          left.priority - right.priority ||
          left.applyCheckedAt - right.applyCheckedAt ||
          left.number - right.number,
  );
  const files = fileEntries.map((entry) => entry.name);
  const boundedExactSelection = exactEventPublication && requestedItemNumberSet.size > 0;
  // Exact-event publication handles one leased item and cannot pair-close with
  // limit=1. Keep unrelated canonical records out of this memory-bounded path.
  const allOpenFileEntries = boundedExactSelection
    ? fileEntries
    : applyReportEntriesForDir(itemsDir, "items", false);
  const openFileEntryByNumber = new Map(allOpenFileEntries.map((entry) => [entry.number, entry]));
  const closedThisRun = new Set<string>();
  const authorPrBudgetClosesThisRun = new Map<string, number>();
  // Counts every same-author PR closed this run regardless of reason: the budget
  // projection must see closes GitHub Search has not indexed yet, whatever closed them.
  const authorPrClosesThisRun = new Map<string, number>();
  const recordAuthorPrClose = (author: string, closeReason: CloseReason | "none" | null): void => {
    const authorKey = author.trim().toLowerCase();
    if (!authorKey) return;
    authorPrClosesThisRun.set(authorKey, (authorPrClosesThisRun.get(authorKey) ?? 0) + 1);
    if (closeReason === "author_pr_budget_exceeded") {
      authorPrBudgetClosesThisRun.set(
        authorKey,
        (authorPrBudgetClosesThisRun.get(authorKey) ?? 0) + 1,
      );
    }
  };
  const applyLedger = startApplyActionLedger({
    applyKind,
    closeReasons: applyCloseReasons,
    dryRun,
    syncCommentsOnly,
    requestedItemNumbers,
    reportPath,
    candidates: fileEntries,
  });
  const mutationByItem = new Map<string, boolean>();
  let activeApplyItem: { repo: string; number: number; mutationOccurred: boolean } | null = null;
  let applyEventsFinalized = false;
  const writeCursorTrace = (): void => {
    if (!cursorTracePath) return;
    ensureDir(dirname(cursorTracePath));
    writeFileSync(
      cursorTracePath,
      `${JSON.stringify(
        { schema_version: 1, examined_item_numbers: examinedItemNumbers },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };
  const finishApply = (failed = false, failure?: unknown): void => {
    if (applyEventsFinalized) return;
    const publicResults = results.map(
      ({
        mutationOccurred: _mutationOccurred,
        commentMutationOccurred: _commentMutationOccurred,
        ...result
      }) => result,
    );
    let publicationError: unknown = null;
    try {
      ensureDir(dirname(reportPath));
      writeFileSync(reportPath, JSON.stringify(publicResults, null, 2), "utf8");
      writeCursorTrace();
    } catch (error) {
      publicationError = error;
    }
    const finalEntryNumbers = boundedExactSelection
      ? new Set([
          ...requestedItemNumberSet,
          ...results.flatMap((result) => (result.number > 0 ? [result.number] : [])),
        ])
      : undefined;
    const finalEntries = new Map<number, ReportEntry>();
    for (const finalEntry of [
      ...reportEntriesForDir(itemsDir, finalEntryNumbers),
      ...reportEntriesForDir(closedDir, finalEntryNumbers),
    ].filter((candidate) => candidate.repo === targetRepo())) {
      finalEntries.set(finalEntry.number, finalEntry);
    }
    recordApplyActionEvents({
      ledger: applyLedger,
      results,
      entries: finalEntries,
      mutationByItem,
      dryRun,
      reportPath,
      failed: failed || publicationError !== null,
      failure: failure ?? publicationError,
      ...(activeApplyItem ? { inFlightItem: activeApplyItem } : {}),
    });
    applyEventsFinalized = true;
    if (publicationError) throw publicationError;
    logProgress(failed ? "failed apply" : "finished apply");
    console.log(JSON.stringify(publicResults, null, 2));
  };
  let activeApplyMutationLease: {
    itemNumber: number;
    lease: AcquiredReviewStartLease;
  } | null = null;
  const releaseActiveApplyMutationLease = (): void => {
    const active = activeApplyMutationLease;
    activeApplyMutationLease = null;
    if (!active) return;
    try {
      deleteOwnedDedicatedReviewStartLease(active.itemNumber, active.lease, {
        throwOnError: true,
      });
    } catch (error) {
      console.error(
        `[apply] could not delete owned review lease comment ${active.lease.commentId}: ${mutationErrorMessage(error)}`,
      );
    }
  };
  runtimeBudget.onFailure = (error: unknown): void => {
    releaseActiveApplyMutationLease();
    if (applyEventsFinalized) return;
    try {
      finishApply(true, error);
    } catch (finalizationError) {
      console.error(
        `[action-ledger] failed to finalize partial apply events: ${
          finalizationError instanceof Error ? finalizationError.message : String(finalizationError)
        }`,
      );
    }
  };
  runtimeBudget.onYield = (reason: string, resumeCurrent = true): void => {
    releaseActiveApplyMutationLease();
    const interruptedItem = resumeCurrent ? activeApplyItem : null;
    if (interruptedItem) {
      removeCurrentCursorTraceItem(examinedItemNumbers, interruptedItem.number);
    }
    for (const result of interruptedItem
      ? applyRuntimeBudgetYieldResults(interruptedItem.number, reason)
      : [{ number: 0, action: "skipped_runtime_budget" as const, reason }]) {
      if (
        !results.some(
          (existing) =>
            existing.number === result.number && existing.action === "skipped_runtime_budget",
        )
      ) {
        results.push(result);
      }
    }
    logProgress(`budget stop, resume next cycle: ${reason}`);
    finishApply();
  };
  if (fileEntries.length === 0 && !existsSync(itemsDir)) {
    console.log("No items directory.");
    finishApply();
    return;
  }
  logProgress(
    `starting apply: files=${files.length} dry_run=${dryRun} apply_kind=${applyKind} min_age=${minAgeDescription} apply_close_reasons=${closeReasonFilterText(applyCloseReasons)} stale_min_age_days=${staleMinAgeDays} close_delay_ms=${closeDelayMs} sync_comments_only=${syncCommentsOnly} suppress_automation_markers=${suppressAutomationMarkers} comment_sync_min_age_days=${commentSyncMinAgeDays} max_runtime_ms=${maxRuntimeMs} item_numbers=${requestedItemNumbers.join(",") || "all"} reconciliation_deferred=${[...reconciliationDeferredItemNumbers].join(",") || "none"}`,
  );
  // oxfmt-ignore
  for (const entry of fileEntries) {
    releaseActiveApplyMutationLease();
    const file = entry.name;
    const path = entry.path;
    if (runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, Date.now())) {
      const reason =
        runtimeBudget.limitReason ?? `max runtime ${maxRuntimeMs}ms reached`;
      runtimeBudget.onYield?.(reason, false);
      return;
    }
    let markdown = entry.markdown;
    const repo = entry.repo;
    const number = entry.number;
    activeApplyItem = { repo, number, mutationOccurred: false };
    startApplyActionLedgerItem(applyLedger, entry);
    const applyItemResultStart = results.length;
    let applyItemFailed = false;
    let currentApplyMutationGuard: (() => string | null) | null = null;
    let recordApplyMutationGuardReason: ((reason: string) => boolean) | null = null;
    const previousApplyMutationRunner = activeApplyMutationRunner;
    try {
    const markMutationObserved = (): void => {
      if (dryRun) return;
      activeApplyItem = { repo, number, mutationOccurred: true };
      mutationByItem.set(`${repo}#${number}`, true);
    };
    const recordMutation = (parentEventId?: string | null): void => {
      markMutationObserved();
      recordApplyMutationBoundary(applyLedger, entry, parentEventId);
    };
    activeApplyMutationRunner = <T>(options: {
      identity: string;
      idempotencyIdentity: string;
      operation: () => T;
      didMutate?: ((result: T) => boolean) | undefined;
      knownNoMutation?: ((error: unknown) => boolean) | undefined;
    }): T => {
      if (dryRun) return options.operation();
      const attempt = startApplyMutationAttempt(
        applyLedger,
        entry,
        options.identity,
        options.idempotencyIdentity,
      );
      if (!attempt) return options.operation();
      try {
        if (!options.identity.startsWith("review_lease_")) {
          const mutationGuardReason = currentApplyMutationGuard?.();
          if (mutationGuardReason) {
            throw new ApplyMutationReviewGuardError(mutationGuardReason);
          }
        }
        const result = options.operation();
        const mutated = options.didMutate?.(result) ?? true;
        const outcomeEventId = finishApplyMutationAttempt({
          ledger: applyLedger,
          entry,
          attempt,
          outcome: mutated ? "accepted" : "rejected",
        });
        if (mutated) recordMutation(outcomeEventId);
        return result;
      } catch (error) {
        const rejected =
          error instanceof ApplyMutationReviewGuardError ||
          options.knownNoMutation?.(error) === true;
        finishApplyMutationAttempt({
          ledger: applyLedger,
          entry,
          attempt,
          outcome: rejected ? "rejected" : "unknown",
        });
        if (!rejected) markMutationObserved();
        throw error;
      }
    };
    examinedItemNumbers.push(number);
    const decision = frontMatterValue(markdown, "decision");
    let closeReason = frontMatterValue(markdown, "close_reason") as CloseReason | undefined;
    const action = frontMatterValue(markdown, "action_taken");
    const changedSinceReviewDuplicateCommentRepair =
      action === "skipped_changed_since_review" &&
      decision === "close" &&
      closeReason === "duplicate_or_superseded";
    let staleCanonicalCommentSyncPending = action === "retry_stale_canonical_comment_sync";
    let storedHash = frontMatterValue(markdown, "item_snapshot_hash");
    let storedUpdatedAt = frontMatterValue(markdown, "item_updated_at");
    const storedAuthorAssociation = frontMatterValue(markdown, "author_association");
    let requiredMaintainerDecision: MaintainerDecision | null;
    const shouldProbeClosedState = shouldProbeClosedStateReport(markdown);
    const isRetryableSkippedClose = isRetryableCloseSkipReport(markdown);
    const isLiveRecheckGuardClose = isLiveRecheckCloseGuardReport(markdown);
    const isUpgradedCloseCandidate =
      isRetryableSkippedClose ||
      isLiveRecheckGuardClose ||
      isRetryablePrCloseCoverageProofReport(markdown) ||
      isRetryableKeptOpenCloseReport(markdown) ||
      isPairBlockedCloseReport(markdown);
    const verifiedLocalCheckout = hasVerifiedLocalCheckoutAccess(markdown);
    const canClosePairCounterpartInThisRun = (
      counterpartNumber: number,
      counterpartRepo = repo,
    ): boolean =>
      counterpartRepo === repo && closedThisRun.has(pairCloseKey(repo, counterpartNumber));
    const archiveClosed = (nextMarkdown: string): void => {
      if (dryRun) return;
      captureApplyCanonicalBaseline(path);
      ensureDir(closedDir);
      const closedPath = join(closedDir, file);
      const syncedMarkdown = syncDecisionPacketMarkdown(closedPath, nextMarkdown, "closed");
      writeFileSync(path, syncedMarkdown, "utf8");
      syncWorkPlanFromReport({
        markdown: syncedMarkdown,
        reportPath: path,
        plansDir,
      });
      renameSync(path, closedPath);
    };
    const markApplyChecked = (subjectState: DecisionPacketSubjectState = "open"): void => {
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown, subjectState);
    };
    const eventApplyDispositionProof = (actionTaken: ActionTaken): Partial<ApplyResult> => {
      if (!emitEventApplyProof) return {};
      if (actionTaken === "skipped_same_author_pair") {
        return { terminalPolicyNoopVerified: true };
      }
      if (actionTaken === "skipped_changed_since_review") {
        return { sourceDriftVerified: true };
      }
      return {};
    };
    const recordApplySkipped = (
      actionTaken: ActionTaken,
      reason: string,
      liveGuardVerified = false,
    ): boolean => {
      markApplyChecked();
      results.push({
        number,
        action: actionTaken,
        reason,
        ...guardedOpenApplyProofFields(actionTaken, {
          emitEventApplyProof,
          liveGuardVerified,
        }),
        ...eventApplyDispositionProof(actionTaken),
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${reason}`);
      return processedCount >= processedLimit;
    };
    const markApplySkipped = (
      actionTaken: ActionTaken,
      reason: string,
      liveGuardVerified = false,
    ): boolean => {
      markdown = replaceFrontMatterValue(markdown, "action_taken", actionTaken);
      return recordApplySkipped(actionTaken, reason, liveGuardVerified);
    };
    if (reconciliationDeferredItemNumbers.has(number)) {
      if (
        markApplySkipped(
          "skipped_changed_since_review",
          "canonical record changed during reconciliation; fresh review required",
        )
      ) {
        break;
      }
      continue;
    }
    const markLabelSyncAuthSkipped = (labelKind: string): boolean => {
      const reason = `GitHub rejected ${labelKind} label sync with Requires authentication`;
      return staleCanonicalCommentSyncPending
        ? markApplySkipped(
            "retry_stale_canonical_comment_sync",
            `${reason}; stale canonical comment correction remains pending`,
          )
        : markApplySkipped("kept_open", reason);
    };
    try {
      requiredMaintainerDecision = maintainerDecisionFromReport(markdown);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `invalid maintainer_decision: ${detail}`;
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) {
        captureApplyCanonicalBaseline(path);
        writeFileSync(path, markdown, "utf8");
      }
      results.push({ number, action: "kept_open", reason });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${reason}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (!verifiedLocalCheckout && !shouldProbeClosedState) {
      if (markApplySkipped("kept_open", "review lacks verified local checkout access")) break;
      continue;
    }
    if (
      !storedHash ||
      (action !== "proposed_close" &&
        action !== "kept_open" &&
        action !== "skipped_pr_close_coverage_proof" &&
        action !== "retry_pr_close_coverage_proof" &&
        !shouldProbeClosedState)
    ) {
      if (
        !storedHash &&
        requestedItemNumberSet.has(number) &&
        recordApplySkipped("kept_open", "review lacks an item snapshot hash")
      ) {
        break;
      }
      continue;
    }
    let isCloseProposal = isApplyCloseCandidateReport(markdown);
    if (decision === "close" && !isCloseProposal && !shouldProbeClosedState) {
      continue;
    }
    let liveItem: ReturnType<typeof fetchItem>;
    try {
      liveItem = fetchItem(number);
    } catch (error) {
      if (!isGitHubNotFoundError(error)) throw error;
      // A repository lookup can return the same 404 when the repo is missing or
      // inaccessible. Confirm repo access before treating this as an item miss.
      ghJson<unknown>(["api", `repos/${targetRepo()}`]);
      if (syncCommentsOnly) {
        markApplyChecked("closed");
        results.push({
          number,
          action: "skipped_already_closed",
          reason: "item not found on GitHub",
          ...(emitEventApplyProof ? { terminalMissingVerified: true } : {}),
        });
        processedCount += 1;
        maybeLogProgress(`skipped comment sync #${number}: item not found on GitHub`);
        if (processedCount >= processedLimit) break;
        continue;
      }
      // Items can be deleted after review but before apply. Treat that terminal
      // state like an already-closed item instead of failing the whole apply run.
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_already_closed");
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      archiveClosed(markdown);
      results.push({
        number,
        action: "skipped_already_closed",
        reason: "item not found on GitHub",
        ...(emitEventApplyProof ? { terminalMissingVerified: true } : {}),
      });
      processedCount += 1;
      maybeLogProgress(`archived #${number}: item not found on GitHub`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    const { item, state } = liveItem;
    if (
      state === "open" &&
      decision === "close" &&
      closeReason &&
      applyBlockingProtectedLabels(item.labels, closeReason).length === 0 &&
      !prAutoCloseExemptDecisionReason(item, closeReason) &&
      !isAutoCloseAllowed(repositoryProfileFor(repo), item.kind, closeReason)
    ) {
      if (
        markApplySkipped(
          "skipped_invalid_decision",
          `${closeReason} is not allowed for ${repo} ${item.kind} apply policy`,
        )
      ) {
        break;
      }
      continue;
    }
    const previousLabels = [...item.labels];
    const reportLabelsBeforeApply = frontMatterStringArray(markdown, "labels");
    let currentContext: ItemContext | undefined;
    let currentClosingPullRequests: unknown[] | undefined;
    let clawSweeperLabelsChanged = false;
    let issueAdvisoryLabelsChanged = false;
    const allowedSelfMutationUpdatedAts = new Set<string>();
    let staleCanonicalClosedUnmergedValidated = false;
    const currentItemContext = (): ItemContext => {
      currentContext ??= collectItemContext(item, { fullTimelineForRelations: true });
      return currentContext;
    };
    const markdownBeforeApplyDecisionMutations = markdown;
    const expectedReviewActivityCursor = frontMatterValue(
      markdownBeforeApplyDecisionMutations,
      "review_activity_cursor",
    );
    const currentReviewActivityBlock = (): string | null => {
      if (item.kind !== "pull_request") return null;
      if (!isReviewedPrActivityCursor(expectedReviewActivityCursor)) {
        return "stored pull request review activity cursor is missing or invalid; fresh review required";
      }
      try {
        const currentReviewActivityCursor = readStableReviewedPrActivityCursor(() =>
          fetchReviewedPrActivityCursor(number),
        );
        if (!currentReviewActivityCursor) {
          return "pull request review activity exceeds the bounded reviewed cursor";
        }
        if (currentReviewActivityCursor !== expectedReviewActivityCursor) {
          return "pull request review activity changed since review";
        }
        return null;
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        if (error instanceof ReviewedPrActivityChangedDuringReadError) {
          return "pull request review activity changed since review";
        }
        const detail = trimMiddle(
          (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
          180,
        );
        return `pull request review activity could not be refreshed; next apply will retry: ${detail}`;
      }
    };
    const reportReviewRevision = reviewLeaseRevisionFromReport(
      markdownBeforeApplyDecisionMutations,
    );
    const reportReviewLeaseOwner = frontMatterValue(
      markdownBeforeApplyDecisionMutations,
      "review_lease_owner",
    );
    const reportReviewLeaseCommentId = Number(
      frontMatterValue(markdownBeforeApplyDecisionMutations, "review_lease_comment_id"),
    );
    // Current reviews carry this complete tuple. Tuple-less backlog reports keep their legacy
    // apply path, while the active-lease and newer-verdict guards still fail them closed.
    const requiresApplyMutationLease = Boolean(
      reportReviewRevision &&
      reportReviewLeaseOwner &&
      reportReviewLeaseOwner !== "unknown" &&
      Number.isInteger(reportReviewLeaseCommentId) &&
      reportReviewLeaseCommentId > 0,
    );
    const initialReviewHeadSha =
      item.kind === "pull_request"
        ? (pullHeadShaFromContext(currentItemContext()) ?? "")
        : liveIssueSourceRevision(number);
    if (state === "open" && exactEventPublication) {
      const exactLeaseDisposition = exactEventReviewLeaseDisposition(
        markdownBeforeApplyDecisionMutations,
        initialReviewHeadSha,
      );
      if (exactLeaseDisposition.status === "source_drift") {
        const reason =
          item.kind === "pull_request"
            ? `live PR head ${exactLeaseDisposition.liveRevision || "unknown"} differs from reviewed head ${exactLeaseDisposition.reportRevision}`
            : `live issue source revision ${exactLeaseDisposition.liveRevision || "unknown"} differs from reviewed revision ${exactLeaseDisposition.reportRevision}`;
        if (markApplySkipped("skipped_changed_since_review", reason)) break;
        continue;
      }
      if (exactLeaseDisposition.status === "legacy_tupleless") {
        if (
          markApplySkipped(
            "skipped_stale_review_comment_sync",
            exactLeaseDisposition.reason,
          )
        ) {
          break;
        }
        continue;
      }
      if (exactLeaseDisposition.status === "invalid") {
        if (markApplySkipped("kept_open", exactLeaseDisposition.reason)) break;
        continue;
      }
    }
    const reviewStartLeaseStateForComments = (
      leaseComments: Record<string, unknown>[],
      reviewComment: Record<string, unknown> | undefined,
      headSha: string,
    ) => {
      const lease = freshExactHeadReviewStartLease({
        comments: leaseComments,
        itemNumber: number,
        headSha,
        trustedAuthors: new Set(
          [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
        ),
      });
      const preserve = Boolean(
        lease &&
        shouldPreserveReviewStartLease({
          currentHeadSha: headSha,
          reportHeadSha:
            reviewLeaseRevisionFromReport(markdownBeforeApplyDecisionMutations) ?? undefined,
          reportLeaseOwner: frontMatterValue(
            markdownBeforeApplyDecisionMutations,
            "review_lease_owner",
          ),
          reportLeaseCommentId: frontMatterValue(
            markdownBeforeApplyDecisionMutations,
            "review_lease_comment_id",
          ),
          leaseOwner: lease.owner,
          leaseCommentId: lease.commentId,
        }),
      );
      // A matching report tuple deliberately returns `preserve: false`: the exact publisher
      // adopts that completed review lease as its mutation lock. Any different or incomplete
      // live lease remains preserved and blocks the older artifact.
      return {
        comment: reviewComment,
        leaseComments,
        headSha,
        lease,
        preserve,
        blockReason: null as string | null,
      };
    };
    const fetchLiveReviewHeadSha = (): string => {
      if (item.kind !== "pull_request") return liveIssueSourceRevision(number);
      const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
      const sha = asRecord(pull.head).sha;
      return typeof sha === "string" ? sha.trim().toLowerCase() : "";
    };
    const refreshReviewStartLeaseState = () => {
      try {
        const headBefore = fetchLiveReviewHeadSha();
        const refreshed = issueReviewCommentState(number);
        const headAfter = fetchLiveReviewHeadSha();
        if (!headBefore || headBefore !== headAfter || headAfter !== initialReviewHeadSha) {
          return {
            comment: refreshed.reviewComment,
            comments: refreshed.comments,
            leaseComments: refreshed.leaseComments,
            headSha: headAfter,
            lease: null,
            preserve: false,
            blockReason: `${item.kind === "pull_request" ? "PR head" : "issue source revision"} changed since context capture or during the apply-time review lease check; next apply will retry`,
          };
        }
        if (item.kind === "issue" && reportReviewRevision && headAfter !== reportReviewRevision) {
          return {
            comment: refreshed.reviewComment,
            comments: refreshed.comments,
            leaseComments: refreshed.leaseComments,
            headSha: headAfter,
            lease: null,
            preserve: false,
            blockReason: `live issue source revision ${headAfter} differs from reviewed revision ${reportReviewRevision}`,
          };
        }
        return {
          ...reviewStartLeaseStateForComments(
            refreshed.leaseComments,
            refreshed.reviewComment,
            headAfter,
          ),
          comments: refreshed.comments,
        };
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        const detail = trimMiddle(
          (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
          180,
        );
        return {
          comment: undefined,
          comments: [] as Record<string, unknown>[],
          leaseComments: [],
          headSha: "",
          lease: null,
          preserve: false,
          blockReason: `apply-time review lease check failed; next apply will retry: ${detail}`,
        };
      }
    };
    const ownedApplyMutationLeaseBlockReason = (
      lease: AcquiredReviewStartLease,
    ): string | null => {
      try {
        const reviewActivityBlock = currentReviewActivityBlock();
        if (reviewActivityBlock) return reviewActivityBlock;
        const revisionBefore = fetchLiveReviewHeadSha();
        const refreshed = issueReviewCommentState(number);
        const revisionAfter = fetchLiveReviewHeadSha();
        if (
          !revisionBefore ||
          revisionBefore !== revisionAfter ||
          revisionAfter !== initialReviewHeadSha ||
          (item.kind === "issue" &&
            reportReviewRevision !== null &&
            revisionAfter !== reportReviewRevision)
        ) {
          return `${item.kind === "pull_request" ? "PR head" : "issue source revision"} changed while holding the apply mutation lease`;
        }
        const winner = freshExactHeadReviewStartLease({
          comments: refreshed.leaseComments,
          itemNumber: number,
          headSha: revisionAfter,
          trustedAuthors: new Set(
            [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
          ),
        });
        if (
          winner?.owner !== lease.owner ||
          winner.commentId !== lease.commentId ||
          lease.headSha !== revisionAfter
        ) {
          return `apply mutation lease ${lease.commentId} is no longer the elected ${item.kind === "pull_request" ? "same-head" : "same-revision"} lease`;
        }
        return canonicalBoundStaleReviewReason(
          markdownBeforeApplyDecisionMutations,
          refreshed.reviewComment,
        );
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        const detail = trimMiddle(
          (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
          180,
        );
        return `apply mutation lease verification failed; next apply will retry: ${detail}`;
      }
    };
    const acquireApplyMutationLease = (
      leaseState: ReturnType<typeof refreshReviewStartLeaseState>,
    ): string | null => {
      if (dryRun || !requiresApplyMutationLease) return null;
      let lease: AcquiredReviewStartLease | null = null;
      if (leaseState.lease && !leaseState.preserve) {
        if (!leaseState.lease.owner || leaseState.lease.commentId === null) {
          return "matching review lease lacks a server-confirmed owner and comment id";
        }
        lease = {
          owner: leaseState.lease.owner,
          commentId: leaseState.lease.commentId,
          headSha: leaseState.headSha,
        };
      } else {
        const posted = postReviewStartStatusComment({
          item,
          headSha: leaseState.headSha,
          reviewTimeoutMs: Math.max(5 * 60 * 1000, closeDelayMs + 60 * 1000),
          position: 1,
          total: 1,
          shardIndex: 1,
          shardCount: 1,
          purpose: "apply",
        });
        if (posted.status !== "posted") {
          return `${item.kind === "pull_request" ? "same-head" : "same-revision"} ClawSweeper lease was acquired concurrently`;
        }
        lease = posted.lease;
      }
      activeApplyMutationLease = { itemNumber: number, lease };
      return ownedApplyMutationLeaseBlockReason(lease);
    };
    const currentApplyMutationLeaseBlockReason = (): string | null => {
      const reviewActivityBlock = currentReviewActivityBlock();
      if (reviewActivityBlock) return reviewActivityBlock;
      if (dryRun || !requiresApplyMutationLease) return null;
      const active = activeApplyMutationLease;
      if (!active || active.itemNumber !== number) return "apply mutation lease is not held";
      return ownedApplyMutationLeaseBlockReason(active.lease);
    };
    currentApplyMutationGuard = currentApplyMutationLeaseBlockReason;
    const recordReviewGuardSkip = (
      action: "kept_open" | "skipped_stale_review_comment_sync",
      reason: string,
      restoreOriginal = true,
      activeReviewLeaseExpiresAt?: string,
    ): boolean => {
      markdown = replaceFrontMatterValue(
        restoreOriginal ? markdownBeforeApplyDecisionMutations : markdown,
        "apply_checked_at",
        new Date().toISOString(),
      );
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({
        number,
        action,
        reason,
        ...(emitEventApplyProof && action === "kept_open" && activeReviewLeaseExpiresAt
          ? {
              activeReviewLeaseVerified: true,
              activeReviewLeaseExpiresAt,
            }
          : {}),
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${reason}`);
      return processedCount >= processedLimit;
    };
    const reviewActivitySourceChanged = (reason: string): boolean =>
      reason === "pull request review activity changed since review" ||
      reason === "pull request review activity exceeds the bounded reviewed cursor";
    const exactEventSourceRevisionChanged = (reason: string): boolean =>
      exactEventPublication && isExactEventSourceRevisionChange(item.kind, reason);
    const recordReviewLeaseSkip = (
      reason: string,
      restoreOriginal = true,
      activeReviewLeaseExpiresAt?: string,
    ): boolean =>
      reviewActivitySourceChanged(reason) || exactEventSourceRevisionChanged(reason)
        ? markApplySkipped("skipped_changed_since_review", reason)
        : staleCanonicalCommentSyncPending
        ? markApplySkipped(
            "retry_stale_canonical_comment_sync",
            `${reason}; stale canonical comment correction remains pending`,
          )
        : recordReviewGuardSkip("kept_open", reason, restoreOriginal, activeReviewLeaseExpiresAt);
    recordApplyMutationGuardReason = (reason) => recordReviewLeaseSkip(reason, false);
    const recordActiveReviewLeaseSkip = (expiresAt: string): boolean =>
      recordReviewLeaseSkip(
        `${item.kind === "pull_request" ? "same-head" : "same-revision"} ClawSweeper review is active until ${expiresAt}`,
        true,
        expiresAt,
      );
    let existingReviewComment: Record<string, unknown> | undefined;
    const pendingStaleCanonicalCommentReason = staleCanonicalCommentSyncPending
      ? staleCanonicalCommentSyncPendingReason(markdown)
      : null;
    let closeBlockedForCommentSync: PrCloseCoverageProofGateBlock | null =
      pendingStaleCanonicalCommentReason
        ? { actionTaken: "kept_open", reason: pendingStaleCanonicalCommentReason }
        : null;
    let canonicalCommentSyncChecked = false;
    const shouldCheckCanonicalCommentSync = (): boolean =>
      state === "open" &&
      (staleCanonicalCommentSyncPending ||
        (closeReason === "duplicate_or_superseded" &&
          (isCloseProposal || (decision === "close" && shouldProbeClosedState))));
    const applyCanonicalCommentSyncGuard = (
      forceRecheck = false,
    ): {
      skipCurrentItem: boolean;
      stopApply: boolean;
    } => {
      if ((canonicalCommentSyncChecked && !forceRecheck) || !shouldCheckCanonicalCommentSync()) {
        return { skipCurrentItem: false, stopApply: false };
      }
      canonicalCommentSyncChecked = true;
      staleCanonicalClosedUnmergedValidated = false;
      const pendingCanonicalNumber = staleCanonicalCommentSyncPending
        ? staleCanonicalPullRequestNumber(markdown)
        : null;
      if (staleCanonicalCommentSyncPending && pendingCanonicalNumber === null) {
        const reason =
          "pending stale canonical comment correction lacks its canonical PR identity; fresh review required";
        return {
          skipCurrentItem: true,
          stopApply: markApplySkipped("retry_stale_canonical_comment_sync", reason),
        };
      }
      const block = canonicalPullRequestCommentSyncBlock(markdown, item);
      if (block?.kind === "unreadable") {
        const actionTaken: ActionTaken = staleCanonicalCommentSyncPending
          ? "retry_stale_canonical_comment_sync"
          : "retry_pr_close_coverage_proof";
        return {
          skipCurrentItem: true,
          stopApply: staleCanonicalCommentSyncPending
            ? markApplySkipped(actionTaken, block.reason)
            : recordApplySkipped(actionTaken, block.reason),
        };
      }
      if (block?.kind === "closed_unmerged") {
        staleCanonicalClosedUnmergedValidated = true;
        closeBlockedForCommentSync = {
          actionTaken: "kept_open",
          reason: block.reason,
        };
        markdown = applyClosedUnmergedCanonicalBlockedReport(
          markdown,
          closeBlockedForCommentSync,
          block.number,
        );
        staleCanonicalCommentSyncPending = true;
        closeReason = "none";
        isCloseProposal = false;
      } else if (staleCanonicalCommentSyncPending && pendingCanonicalNumber !== null) {
        const reason = `linked canonical PR #${pendingCanonicalNumber} is no longer closed and unmerged; fresh review required before stale comment correction`;
        return {
          skipCurrentItem: true,
          stopApply: markApplySkipped("retry_stale_canonical_comment_sync", reason),
        };
      }
      return { skipCurrentItem: false, stopApply: false };
    };
    const initialCanonicalCommentSyncGuard = applyCanonicalCommentSyncGuard();
    if (initialCanonicalCommentSyncGuard.stopApply) break;
    if (initialCanonicalCommentSyncGuard.skipCurrentItem) continue;
    const canonicalBoundStaleReviewReason = (
      sourceMarkdown: string,
      comment: Record<string, unknown> | undefined,
    ): string | null => {
      const staleReason = staleReviewCommentSyncReason(
        sourceMarkdown,
        comment,
        number,
        item.kind === "pull_request" ? currentItemContext() : undefined,
      );
      const pendingCanonicalNumber = staleCanonicalPullRequestNumber(markdown);
      if (staleCanonicalClosedUnmergedValidated && pendingCanonicalNumber !== null) {
        if (
          reviewCommentHasCloseVerdictForCanonical(
            comment,
            number,
            "duplicate_or_superseded",
            pendingCanonicalNumber,
          )
        ) {
          return null;
        }
        return (
          staleReason ??
          `live durable review comment is not bound to stored canonical PR #${pendingCanonicalNumber}; fresh review required before stale comment correction`
        );
      }
      return staleReason;
    };
    const refreshedReviewStaleReason = (comment: Record<string, unknown> | undefined) =>
      canonicalBoundStaleReviewReason(markdownBeforeApplyDecisionMutations, comment);
    const recordRefreshedReviewStaleReason = (reason: string): boolean =>
      staleCanonicalCommentSyncPending
        ? markApplySkipped(
            "retry_stale_canonical_comment_sync",
            `${reason}; stale canonical comment correction remains pending`,
          )
        : recordReviewGuardSkip("skipped_stale_review_comment_sync", reason);
    const rememberSelfMutationUpdatedAt = (): void => {
      if (!dryRun) allowedSelfMutationUpdatedAts.add(fetchItem(number).item.updatedAt);
    };
    let cachedPrCloseCoverageProofGateResult: PrCloseCoverageProofGateResult | undefined;
    let cachedAuthorPrBudgetApplyGate: AuthorPrBudgetApplyGate | undefined;
    let cachedStaleVersionBugBlockReason: string | null | undefined;
    let cachedObsoleteFixPrBlockReason: string | null | undefined;
    const currentStaleVersionBugBlockReason = (): string | null => {
      if (cachedStaleVersionBugBlockReason === undefined) {
        cachedStaleVersionBugBlockReason = staleVersionBugApplyBlockReasonSafe(number, item);
      }
      return cachedStaleVersionBugBlockReason;
    };
    const currentObsoleteFixPrBlockReason = (): string | null => {
      if (cachedObsoleteFixPrBlockReason === undefined) {
        cachedObsoleteFixPrBlockReason = obsoleteFixPrApplyBlockReasonSafe(number, item);
      }
      return cachedObsoleteFixPrBlockReason;
    };
    const currentAuthorPrBudgetApplyGate = (): AuthorPrBudgetApplyGate => {
      const authorKey = item.author.trim().toLowerCase();
      const closedForAuthor = authorPrBudgetClosesThisRun.get(authorKey) ?? 0;
      const maxCloses = authorPrBudgetMaxClosesPerRun();
      if (closedForAuthor >= maxCloses) {
        return {
          allowed: false,
          reason: `author PR-budget per-run close cap of ${maxCloses} reached for @${item.author.replace(/^@/, "")}`,
        };
      }
      cachedAuthorPrBudgetApplyGate ??= authorPrBudgetApplyGateSafe(number, item, markdown);
      if (!cachedAuthorPrBudgetApplyGate.allowed) return cachedAuthorPrBudgetApplyGate;
      // GitHub Search may not reflect this run's own closes yet, so project them
      // onto the live count: one run must never trim an author below the budget.
      // Uses the all-reasons counter — a same-author PR closed as abandoned or
      // duplicate earlier in this run stales the search count just the same.
      const projectedOpenPrCount =
        cachedAuthorPrBudgetApplyGate.state.openPrCount -
        (authorPrClosesThisRun.get(authorKey) ?? 0);
      if (projectedOpenPrCount <= cachedAuthorPrBudgetApplyGate.state.budget) {
        return {
          allowed: false,
          reason: `author is projected at ${projectedOpenPrCount} open PRs after this run's closes; author PR budget is ${cachedAuthorPrBudgetApplyGate.state.budget}`,
        };
      }
      return cachedAuthorPrBudgetApplyGate;
    };
    let prCloseCoverageProofGateChecked = false;
    let prCloseCoverageProofStartedAtMs: number | null = null;
    const runtimeBudgetProofBlock = (phase = "before"): PrCloseCoverageProofGateResult => ({
      status: "blocked",
      block: {
        actionTaken: "skipped_runtime_budget",
        reason: `max runtime ${maxRuntimeMs}ms reached ${phase} PR close coverage proof`,
      },
    });
    const currentPrCloseCoverageProofGateBlock = (): PrCloseCoverageProofGateBlock | null => {
      if (cachedPrCloseCoverageProofGateResult === undefined) {
        prCloseCoverageProofGateChecked = true;
        if (
          frontMatterValue(markdown, "decision") === "close" &&
          closeReason === "duplicate_or_superseded"
        ) {
          let proofTimeoutMs = timeoutWithinRuntimeBudget(
            startedAtMs,
            maxRuntimeMs,
            prCloseCoverageProofRuntime.timeoutMs,
            Date.now(),
          );
          if (proofTimeoutMs === null) {
            cachedPrCloseCoverageProofGateResult = runtimeBudgetProofBlock();
          } else {
            const context = currentItemContext();
            proofTimeoutMs = timeoutWithinRuntimeBudget(
              startedAtMs,
              maxRuntimeMs,
              prCloseCoverageProofRuntime.timeoutMs,
              Date.now(),
            );
            if (proofTimeoutMs === null) {
              cachedPrCloseCoverageProofGateResult = runtimeBudgetProofBlock();
            } else {
              const proofGateResult = prCloseCoverageProofGateResult({
                markdown,
                item,
                context,
                runtime: { ...prCloseCoverageProofRuntime, timeoutMs: proofTimeoutMs },
                requirePrecomputedProof: requirePrecomputedPrCloseCoverageProof,
                runtimeBudget: { startedAtMs, maxRuntimeMs },
              });
              cachedPrCloseCoverageProofGateResult =
                proofGateResult?.status === "blocked" &&
                coverageProofRetryExhaustedRuntimeBudget(
                  startedAtMs,
                  maxRuntimeMs,
                  proofGateResult.block.actionTaken,
                  Date.now(),
                )
                  ? runtimeBudgetProofBlock("during")
                  : proofGateResult;
              if (cachedPrCloseCoverageProofGateResult?.status === "allowed") {
                prCloseCoverageProofStartedAtMs =
                  cachedPrCloseCoverageProofGateResult.covering.provedAtMs;
              }
            }
          }
        } else {
          cachedPrCloseCoverageProofGateResult = null;
        }
      }
      return cachedPrCloseCoverageProofGateResult?.status === "blocked"
        ? cachedPrCloseCoverageProofGateResult.block
        : null;
    };
    const recordRuntimeBudgetYield = (reason: string): void => {
      if (clawSweeperLabelsChanged && !dryRun) {
        markdown = replaceFrontMatterValue(
          markdown,
          "labels_synced_at",
          new Date().toISOString(),
        );
        writeReportMarkdown(path, markdown);
      }
      removeCurrentCursorTraceItem(examinedItemNumbers, number);
      results.push(...applyRuntimeBudgetYieldResults(number, reason));
      logProgress(`budget stop, resume next cycle: ${reason}`);
    };
    const sameAuthorPairStartCloseable = new Map<string, boolean>();
    const currentCloseGatesPassed = (): boolean => {
      if (
        requiredMaintainerDecision?.required &&
        closeReason !== "unsponsored_feature_request" &&
        closeReason !== "author_pr_budget_exceeded"
      )
        return false;
      if (!closeReason || !closeReasonEnabled(closeReason, applyCloseReasons)) return false;
      if (needsReviewCommentSync) return false;
      if (
        !validateCloseDecision(
          {
            repo,
            kind: item.kind,
            labels: item.labels,
            authorAssociation: item.authorAssociation,
          },
          reportDecision(markdown, closeReason),
          {
            requireCloseComment: !isRetryableSkippedClose,
          },
        ).ok
      ) {
        return false;
      }
      if (
        closeReason === "duplicate_or_superseded" &&
        duplicateCanonicalPullRequestBlockReason(markdown, item, {
          reportDirs: [itemsDir, closedDir],
        })
      ) {
        return false;
      }
      if (
        closeReasonApplyAgeSkipReason(item, closeReason, {
          minAgeMs,
          minAgeDescription,
          staleMinAgeDays,
        })
      ) {
        return false;
      }
      if (
        closeReason === "unconfirmed_product_direction" &&
        unconfirmedProductDirectionApplyBlockReasonSafe(
          number,
          item,
          storedUpdatedAt,
          frontMatterValue(markdown, "reviewed_at"),
        )
      ) {
        return false;
      }
      if (
        closeReason === "unsponsored_feature_request" &&
        unsponsoredFeatureApplyBlockReasonSafe(number, item)
      ) {
        return false;
      }
      if (
        closeReason === "stale_version_bug" &&
        currentStaleVersionBugBlockReason()
      ) {
        return false;
      }
      if (
        closeReason === "obsolete_fix_pr" &&
        currentObsoleteFixPrBlockReason()
      ) {
        return false;
      }
      if (
        closeReason === "author_pr_budget_exceeded" &&
        !currentAuthorPrBudgetApplyGate().allowed
      ) {
        return false;
      }
      if (
        closeReason === "stale_insufficient_info" &&
        issueRecentHumanCommentBlockReasonSafe(number, STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS)
      ) {
        return false;
      }
      if (
        closeReason === "stalled_unproven_pr" &&
        stalledUnprovenPrApplyBlockReasonSafe(number, item)
      ) {
        return false;
      }
      if (closeReason === "abandoned_pr" && abandonedPrApplyBlockReasonSafe(number, item)) {
        return false;
      }
      if (currentPrCloseCoverageProofGateBlock()) return false;
      return true;
    };
    const canStartSameAuthorPairCloseInThisRun = (
      counterpartNumber: number,
      counterpartKind: ItemKind,
    ): boolean => {
      const cacheKey = `${counterpartNumber}:${counterpartKind}`;
      const cached = sameAuthorPairStartCloseable.get(cacheKey);
      if (cached !== undefined) return cached;

      let result = false;
      if (
        item.kind === "pull_request" &&
        counterpartKind === "issue" &&
        applyKind === "all" &&
        closedCount + 2 <= limit &&
        processedCount + 2 <= processedLimit &&
        currentCloseGatesPassed()
      ) {
        const counterpartEntry = openFileEntryByNumber.get(counterpartNumber);
        if (counterpartEntry) {
          const counterpartMarkdown = readFileSync(counterpartEntry.path, "utf8");
          const counterpartMaintainerDecisionBlocked =
            maintainerDecisionBlocksClose(counterpartMarkdown);
          const counterpartRepo = markdownRepository(counterpartMarkdown, counterpartEntry.path);
          const counterpartReason = reportCloseReason(counterpartMarkdown);
          if (
            counterpartRepo === repo &&
            reportItemKind(counterpartMarkdown) === counterpartKind &&
            counterpartReason &&
            !counterpartMaintainerDecisionBlocked &&
            closeReasonEnabled(counterpartReason, applyCloseReasons) &&
            isApplyCloseCandidateReport(counterpartMarkdown) &&
            hasAutoCloseAllowedMetadata(counterpartMarkdown) &&
            hasVerifiedLocalCheckoutAccess(counterpartMarkdown)
          ) {
            const { item: counterpartItem, state: counterpartState } =
              fetchItem(counterpartNumber);
            const counterpartReviewedAuthorAssociation = normalizeAuthorAssociation(
              frontMatterValue(counterpartMarkdown, "author_association"),
            );
            const counterpartStoredUpdatedAt = frontMatterValue(
              counterpartMarkdown,
              "item_updated_at",
            );
            const counterpartStoredHash = frontMatterValue(
              counterpartMarkdown,
              "item_snapshot_hash",
            );
            const counterpartReviewCommentBody = renderReviewCommentFromReport(
              counterpartMarkdown,
              counterpartReason,
            );
            const counterpartReviewComment = issueReviewComment(counterpartNumber, [
              counterpartReviewCommentBody,
              reviewSectionValue(counterpartMarkdown, "closeComment"),
            ]);
            const counterpartMarkedReviewComment = markedReviewCommentBody(
              counterpartNumber,
              counterpartReviewCommentBody,
            );
            const counterpartAllowApplyCloseActionUpgrade =
              isApplyCloseCandidateReport(counterpartMarkdown);
            const counterpartMarkedReviewCommentHash = reviewCommentBodyDigest(
              counterpartMarkedReviewComment,
            );
            const counterpartNeedsReviewCommentSync = shouldSyncReviewComment({
              syncCommentsOnly: false,
              isCloseProposal: true,
              commentSyncMinAgeDays,
              reviewCommentSyncedAt: frontMatterValue(
                counterpartMarkdown,
                "review_comment_synced_at",
              ),
              hasExistingReviewComment: Boolean(counterpartReviewComment),
              needsReviewCommentBodySync: !commentBodyMatches(
                counterpartReviewComment,
                counterpartMarkedReviewComment,
                { allowApplyCloseActionUpgrade: counterpartAllowApplyCloseActionUpgrade },
              ),
              needsReviewCommentHashSync: !reviewCommentHashMatches(
                counterpartReviewComment,
                counterpartMarkedReviewComment,
                frontMatterValue(counterpartMarkdown, "review_comment_sha256"),
                counterpartMarkedReviewCommentHash,
                { allowApplyCloseActionUpgrade: counterpartAllowApplyCloseActionUpgrade },
              ),
              needsReviewCommentReferenceSync:
                frontMatterValue(counterpartMarkdown, "review_comment_id") === "unknown" ||
                frontMatterValue(counterpartMarkdown, "review_comment_url") === "unknown",
              forceReviewCommentBodySync: false,
            });
            const counterpartReviewCommentOnlyUpdate =
              counterpartItem.updatedAt === commentUpdatedAt(counterpartReviewComment);
            const counterpartUpdatedSinceReview = Boolean(
              counterpartStoredUpdatedAt &&
              counterpartItem.updatedAt !== counterpartStoredUpdatedAt,
            );
            const counterpartContext = collectItemContext(counterpartItem, {
              fullTimelineForRelations: true,
            });
            const counterpartSnapshotChanged =
              !counterpartStoredUpdatedAt &&
              counterpartStoredHash &&
              itemSnapshotHash(counterpartItem, counterpartContext) !== counterpartStoredHash &&
              !counterpartReviewCommentOnlyUpdate;
            const counterpartOpenClosingPullRequestReason = openClosingPullRequestApplyReason(
              closingPullRequestsForIssue(counterpartNumber),
              (pullNumber, pullRepo) =>
                canClosePairCounterpartInThisRun(pullNumber, pullRepo) ||
                (pullNumber === number && (pullRepo === undefined || pullRepo === repo)),
            );
            const counterpartSameAuthorReason = sameAuthorCounterpartApplyReason(
              counterpartItem,
              counterpartContext.relatedItems ?? [],
              (relatedNumber, relatedKind) =>
                canClosePairCounterpartInThisRun(relatedNumber) ||
                (relatedNumber === number && relatedKind === item.kind),
            );
            result =
              counterpartState === "open" &&
              counterpartItem.kind === counterpartKind &&
              applyBlockingProtectedLabels(counterpartItem.labels, counterpartReason).length ===
                0 &&
              (isVerifiedFixedCloseReason(counterpartReason) ||
                (!isMaintainerAuthorAssociation(
                  normalizeAuthorAssociation(counterpartItem.authorAssociation),
                ) &&
                  !isMaintainerAuthorAssociation(counterpartReviewedAuthorAssociation))) &&
              (!counterpartUpdatedSinceReview || counterpartReviewCommentOnlyUpdate) &&
              !counterpartSnapshotChanged &&
              !counterpartNeedsReviewCommentSync &&
              validateCloseDecision(
                {
                  repo: counterpartRepo,
                  kind: counterpartItem.kind,
                  labels: counterpartItem.labels,
                  authorAssociation: counterpartItem.authorAssociation,
                },
                reportDecision(counterpartMarkdown, counterpartReason),
                { requireCloseComment: !isRetryableCloseSkipReport(counterpartMarkdown) },
              ).ok &&
              closeReasonApplyAgeSkipReason(counterpartItem, counterpartReason, {
                minAgeMs,
                minAgeDescription,
                staleMinAgeDays,
              }) === null &&
              counterpartOpenClosingPullRequestReason === null &&
              counterpartSameAuthorReason === null;
            if (result && !fileEntries.some((entry) => entry.number === counterpartNumber)) {
              fileEntries.push(counterpartEntry);
            }
          }
        }
      }

      sameAuthorPairStartCloseable.set(cacheKey, result);
      return result;
    };
    if (syncCommentsOnly && state !== "open") {
      markApplyChecked("closed");
      results.push({
        number,
        action: "skipped_already_closed",
        reason: `state is ${state}`,
        ...(emitEventApplyProof ? { terminalStateVerified: true } : {}),
      });
      processedCount += 1;
      maybeLogProgress(`skipped comment sync #${number}: already ${state}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (state === "open" && !verifiedLocalCheckout && !staleCanonicalCommentSyncPending) {
      if (isCloseProposal) {
        if (markApplySkipped("kept_open", "review lacks verified local checkout access")) break;
      }
      continue;
    }
    if (
      state === "open" &&
      shouldProbeClosedState &&
      !isCloseProposal &&
      !syncCommentsOnly &&
      !staleCanonicalCommentSyncPending
    ) {
      const protectedReason =
        action === "skipped_protected_label" &&
        applyBlockingProtectedLabels(item.labels, closeReason).length > 0
          ? applyProtectedLabelReason(item.labels, closeReason)
          : null;
      const closeExemptReason =
        action === "skipped_close_exempt_label"
          ? prAutoCloseExemptDecisionReason(item, closeReason)
          : null;
      const currentAuthorAssociation = normalizeAuthorAssociation(item.authorAssociation);
      const reviewedAuthorAssociation = normalizeAuthorAssociation(storedAuthorAssociation);
      const maintainerReason =
        action === "skipped_maintainer_authored" &&
        !isVerifiedFixedCloseReason(closeReason) &&
        (isMaintainerAuthorAssociation(currentAuthorAssociation) ||
          isMaintainerAuthorAssociation(reviewedAuthorAssociation))
          ? `author association is ${
              isMaintainerAuthorAssociation(currentAuthorAssociation)
                ? currentAuthorAssociation
                : reviewedAuthorAssociation
            }`
          : null;
      const lockedReason =
        action === "skipped_locked_conversation" ? lockedConversationApplyReason(item) : null;
      const guardedOpenProof: { action: ActionTaken; reason: string } | null = protectedReason
        ? { action: "skipped_protected_label", reason: protectedReason }
        : closeExemptReason
          ? { action: "skipped_close_exempt_label", reason: closeExemptReason }
          : maintainerReason
            ? { action: "skipped_maintainer_authored", reason: maintainerReason }
            : lockedReason
              ? { action: "skipped_locked_conversation", reason: lockedReason }
              : null;
      if (guardedOpenProof) {
        if (
          emitEventApplyProof &&
          recordApplySkipped(guardedOpenProof.action, guardedOpenProof.reason, true)
        ) {
          break;
        }
        continue;
      }
      if (isLiveRecheckGuardClose) {
        markdown = replaceFrontMatterValue(markdown, "action_taken", "proposed_close");
        isCloseProposal = isApplyCloseCandidateReport(markdown);
      }
      if (!isCloseProposal) {
        continue;
      }
    }
    const earlyLeaseState = refreshReviewStartLeaseState();
    existingReviewComment = earlyLeaseState.comment;
    if (!dryRun && existingReviewComment) {
      const durableCommentId = commentId(existingReviewComment);
      cleanupSupersededReviewPlaceholderComments({
        number,
        comments: earlyLeaseState.comments,
        keepCommentIds:
          durableCommentId === null ? new Set<number>() : new Set([durableCommentId]),
      });
    }
    if (state === "open" && earlyLeaseState.blockReason) {
      if (recordReviewLeaseSkip(earlyLeaseState.blockReason)) break;
      continue;
    }
    if (state === "open" && earlyLeaseState.preserve && earlyLeaseState.lease) {
      if (recordActiveReviewLeaseSkip(earlyLeaseState.lease.expiresAt)) break;
      continue;
    }
    const earlyStaleReason = refreshedReviewStaleReason(existingReviewComment);
    if (state === "open" && earlyStaleReason) {
      if (recordRefreshedReviewStaleReason(earlyStaleReason)) break;
      continue;
    }
    if (isUpgradedCloseCandidate) {
      markdown = replaceFrontMatterValue(markdown, "action_taken", "proposed_close");
    }
    const hasLiveNoDiffPullRequestPromotion =
      state === "open" &&
      !isCloseProposal &&
      item.kind === "pull_request" &&
      decision === "keep_open" &&
      action === "kept_open" &&
      storedUpdatedAt &&
      item.updatedAt === storedUpdatedAt &&
      livePullRequestHasNoDiff(currentItemContext()) &&
      reviewReportCanPromoteToClose(markdown);
    if (
      hasLiveNoDiffPullRequestPromotion &&
      closeReasonEnabled("duplicate_or_superseded", applyCloseReasons)
    ) {
      markdown = upgradeNoDiffPullRequestReport(markdown, item);
      closeReason = "duplicate_or_superseded";
      isCloseProposal = true;
      cachedPrCloseCoverageProofGateResult = undefined;
    }
    let attemptedPullRequestClosePromotion = hasLiveNoDiffPullRequestPromotion;
    if (
      state === "open" &&
      !isCloseProposal &&
      !hasLiveNoDiffPullRequestPromotion &&
      item.kind === "pull_request" &&
      decision === "keep_open" &&
      action === "kept_open"
    ) {
      attemptedPullRequestClosePromotion = true;
      const promotionContext = currentItemContext();
      let promotion: PullRequestClosePromotion | null = null;
      if (
        authorPrBudgetCloseEnabled() &&
        closeReasonEnabled("author_pr_budget_exceeded", applyCloseReasons) &&
        !authorPrBudgetAgeSkipReason(item) &&
        !authorPrBudgetSignalBlockReason(markdown)
      ) {
        const authorBudgetGate = currentAuthorPrBudgetApplyGate();
        if (authorBudgetGate.allowed) {
          promotion = authorPrBudgetPromotion(markdown, authorBudgetGate.state);
        }
      }
      promotion ??= pullRequestClosePromotion(markdown, item, promotionContext, staleMinAgeDays, {
        reportDirs: [itemsDir, closedDir],
      });
      if (promotion && closeReasonEnabled(promotion.closeReason, applyCloseReasons)) {
        markdown = upgradePullRequestClosePromotionReport(
          markdown,
          item,
          promotionContext,
          promotion,
        );
        storedUpdatedAt = item.updatedAt;
        storedHash = itemSnapshotHash(item, promotionContext);
        closeReason = promotion.closeReason;
        isCloseProposal = true;
        cachedPrCloseCoverageProofGateResult = undefined;
      }
    }
    if (
      state === "open" &&
      isCloseProposal &&
      closeReason === "author_pr_budget_exceeded" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      const authorBudgetGate = currentAuthorPrBudgetApplyGate();
      if (!authorBudgetGate.allowed) {
        if (markApplySkipped("kept_open", authorBudgetGate.reason)) break;
        continue;
      }
      markdown = applyAuthorPrBudgetStateToReport(markdown, authorBudgetGate.state);
    }
    if (
      state === "open" &&
      isCloseProposal &&
      closeReason === "unsponsored_feature_request" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      if (!unsponsoredFeatureCloseEnabled()) {
        if (
          recordApplySkipped("kept_open", "unsponsored feature-request apply policy is disabled")
        ) {
          break;
        }
        continue;
      }
      const unsponsoredFeatureBlockReason = unsponsoredFeatureApplyBlockReasonSafe(number, item);
      if (unsponsoredFeatureBlockReason) {
        if (markApplySkipped("kept_open", unsponsoredFeatureBlockReason)) break;
        continue;
      }
    }
    if (
      state === "open" &&
      isCloseProposal &&
      closeReason === "stale_version_bug" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      const staleVersionBlockReason = currentStaleVersionBugBlockReason();
      if (staleVersionBlockReason) {
        if (markApplySkipped("kept_open", staleVersionBlockReason)) break;
        continue;
      }
    }
    if (
      state === "open" &&
      isCloseProposal &&
      closeReason === "obsolete_fix_pr" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      const obsoleteFixBlockReason = currentObsoleteFixPrBlockReason();
      if (obsoleteFixBlockReason) {
        if (markApplySkipped("kept_open", obsoleteFixBlockReason)) break;
        continue;
      }
    }
    if (
      state === "open" &&
      isCloseProposal &&
      closeReason === "stale_insufficient_info" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      const staleCommentBlockReason = issueRecentHumanCommentBlockReasonSafe(
        number,
        STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
      );
      if (staleCommentBlockReason) {
        if (markApplySkipped("kept_open", staleCommentBlockReason)) break;
        continue;
      }
    }
    const promotedCanonicalCommentSyncGuard = applyCanonicalCommentSyncGuard();
    if (promotedCanonicalCommentSyncGuard.stopApply) break;
    if (promotedCanonicalCommentSyncGuard.skipCurrentItem) continue;
    if (
      state === "open" &&
      isCloseProposal &&
      closeReason === "unconfirmed_product_direction" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      if (!unconfirmedProductDirectionCloseEnabled()) {
        if (
          recordApplySkipped(
            "kept_open",
            "unconfirmed product-direction apply policy is disabled",
          )
        ) {
          break;
        }
        continue;
      }
      const productDirectionBlockReason = unconfirmedProductDirectionApplyBlockReasonSafe(
        number,
        item,
        storedUpdatedAt,
        frontMatterValue(markdown, "reviewed_at"),
      );
      if (productDirectionBlockReason) {
        if (markApplySkipped("kept_open", productDirectionBlockReason)) break;
        continue;
      }
    }
    if (
      state === "open" &&
      isCloseProposal &&
      (closeReason === "stalled_unproven_pr" || closeReason === "abandoned_pr") &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      const inactivityBlockReason =
        closeReason === "stalled_unproven_pr"
          ? stalledUnprovenPrApplyBlockReasonSafe(number, item)
          : abandonedPrApplyBlockReasonSafe(number, item);
      if (inactivityBlockReason) {
        if (markApplySkipped("kept_open", inactivityBlockReason)) break;
        continue;
      }
    }
    if (state === "open" && isCloseProposal && closeReason === "low_signal_unmergeable_pr") {
      // Reject stale low-signal verdicts before they can become durable public comments. The
      // final close gate repeats this live check to catch activity arriving after comment sync.
      const lowSignalBlockReason = lowSignalUnmergeablePrApplyBlockReasonSafe(
        number,
        staleMinAgeDays,
      );
      if (lowSignalBlockReason) {
        if (markApplySkipped("skipped_low_signal_live_guard", lowSignalBlockReason, true)) break;
        continue;
      }
    }
    existingReviewComment ??= issueReviewComment(number, [
      renderReviewCommentFromReport(markdown, closeReason ?? "none", {
        previousLabels,
        suppressAutomationMarkers,
      }),
      reviewSectionValue(markdown, "closeComment"),
    ]);
    const markedReviewCommentForApply = (body: string): string =>
      markedReviewCommentBody(number, body);
    const existingReviewCommentUpdatedAt = commentUpdatedAt(existingReviewComment);
    if (existingReviewCommentUpdatedAt) {
      allowedSelfMutationUpdatedAts.add(existingReviewCommentUpdatedAt);
    }
    const reportOwnedLeaseComments = requiresApplyMutationLease
      ? earlyLeaseState.leaseComments.filter(
          (leaseComment) =>
            commentId(leaseComment) === reportReviewLeaseCommentId &&
            reviewStartLeaseOwner(leaseComment) === reportReviewLeaseOwner,
        )
      : [];
    const reportOwnedLeaseUpdatedAts = reportOwnedLeaseComments
      .map(commentUpdatedAt)
      .filter((updatedAt): updatedAt is string => timestampMs(updatedAt) !== null);
    for (const updatedAt of reportOwnedLeaseUpdatedAts) {
      allowedSelfMutationUpdatedAts.add(updatedAt);
    }
    const latestLabelFreshnessAutomationUpdatedAt = [
      existingReviewComment,
      ...reportOwnedLeaseComments,
    ]
      .map(commentUpdatedAt)
      .filter((updatedAt): updatedAt is string => timestampMs(updatedAt) !== null)
      .sort((left, right) => (timestampMs(left) ?? 0) - (timestampMs(right) ?? 0))
      .at(-1);
    const staleReviewCommentReason = canonicalBoundStaleReviewReason(
      markdown,
      existingReviewComment,
    );
    if (state === "open" && staleReviewCommentReason) {
      if (staleCanonicalCommentSyncPending) {
        if (
          markApplySkipped(
            "retry_stale_canonical_comment_sync",
            `${staleReviewCommentReason}; stale canonical comment correction remains pending`,
          )
        ) {
          break;
        }
        continue;
      }
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({
        number,
        action: "skipped_stale_review_comment_sync",
        reason: staleReviewCommentReason,
      });
      processedCount += 1;
      maybeLogProgress(`skipped stale review comment sync #${number}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    const updatedSinceReview = Boolean(storedUpdatedAt && item.updatedAt !== storedUpdatedAt);
    const reviewCommentOnlyUpdate = item.updatedAt === existingReviewCommentUpdatedAt;
    const storedUpdatedAtMs = timestampMs(storedUpdatedAt);
    const recordedLabelSyncMatches =
      updatedSinceReview &&
      recordedLabelSyncCoversUpdate({
        itemUpdatedAt: item.updatedAt,
        labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
        liveLabels: item.labels,
        recordedLabels: reportLabelsBeforeApply,
        hasNonAutomationActivity: false,
      });
    const labelSyncOnlyUpdate = Boolean(
      recordedLabelSyncMatches &&
      storedUpdatedAtMs !== null &&
      !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs, {
        truncationCountsAsActivity: true,
      }),
    );
    // Exact issue reviews acquire their same-revision lease after context capture. GitHub then
    // advances issue.updated_at to the bot-owned lease comment even though the reviewed source is
    // unchanged. The lease/source CAS above already proved this exact report tuple is still live;
    // only admit its server timestamp when no human activity followed the reviewed timestamp.
    const ownedIssueReviewLeaseOnlyUpdate = Boolean(
      item.kind === "issue" &&
      updatedSinceReview &&
      storedUpdatedAtMs !== null &&
      reportOwnedLeaseComments.some(
        (leaseComment) => commentUpdatedAt(leaseComment) === item.updatedAt,
      ) &&
      !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs, {
        truncationCountsAsActivity: true,
      }),
    );
    // A deferred duplicate/superseded close is not eligible to mutate until
    // apply-proof has produced a new read-only coverage proof. Its publisher
    // updates the command acknowledgement to make that handoff visible, which
    // advances issue.updated_at without changing the reviewed source. Admit
    // only that exact configured ClawSweeper status-comment churn; any human activity still
    // forces a fresh review before proof or close work proceeds.
    let retryCloseCoverageCommandStatusComments: Record<string, unknown>[] | undefined;
    const reviewedSourceRevision = frontMatterValue(
      markdownBeforeApplyDecisionMutations,
      "item_source_revision",
    );
    const retryCloseCoverageCommandStatusOnlyUpdate = (
      candidate: typeof item,
      candidateContext: ItemContext,
    ): boolean => {
      if (
        action !== "retry_pr_close_coverage_proof" ||
        candidate.updatedAt === storedUpdatedAt ||
        storedUpdatedAtMs === null ||
        !reviewedSourceRevision ||
        reviewedSourceRevision === "unknown" ||
        candidateContext.sourceRevision !== reviewedSourceRevision
      ) {
        return false;
      }
      // Command-status comments are deliberately excluded from review context as bot noise.
      // Read raw comments only for this narrow, trusted handoff and reuse them through the
      // post-proof freshness check. The source-revision match prevents a human title/body
      // edit made before this bot comment from being masked; ordinary drift remains fail-closed.
      const rawComments =
        retryCloseCoverageCommandStatusComments ??= fetchIssueReviewComments(number);
      const statusComment = rawComments.find(
        (comment) =>
          commentUpdatedAt(comment) === candidate.updatedAt &&
          CLAWSWEEPER_BOT_AUTHORS.has(
            (login(asRecord(comment).user) ?? "").trim().toLowerCase(),
          ) &&
          (commentBody(comment) ?? "").includes("<!-- clawsweeper-command-status:"),
      );
      const statusCreatedAt = statusComment
        ? stringOrUndefined(statusComment.created_at)
        : undefined;
      return Boolean(
        statusCreatedAt &&
          !contextHasNonAutomationActivityAfter(candidateContext, storedUpdatedAtMs, {
            truncationCountsAsActivity: true,
            ignoreTrustedTimelineComment: {
              authors: CLAWSWEEPER_BOT_AUTHORS,
              createdAt: statusCreatedAt,
            },
          }),
      );
    };
    const commandStatusOnlyUpdate =
      action === "retry_pr_close_coverage_proof" &&
      retryCloseCoverageCommandStatusOnlyUpdate(item, currentItemContext());
    const automationOnlyUpdate =
      reviewCommentOnlyUpdate ||
      labelSyncOnlyUpdate ||
      ownedIssueReviewLeaseOnlyUpdate ||
      commandStatusOnlyUpdate;
    const labelSyncFreshEnough = (): boolean => {
      if (!storedUpdatedAt) return false;
      if (!updatedSinceReview || automationOnlyUpdate) return true;
      const completeFreshHeadReview =
        !isCloseProposal &&
        item.kind === "pull_request" &&
        frontMatterValue(markdown, "review_status") === "complete" &&
        freshPullRequestReviewHead(markdown, currentItemContext());
      if (!completeFreshHeadReview) {
        const existingReviewCommentUpdatedAtMs = timestampMs(
          latestLabelFreshnessAutomationUpdatedAt,
        );
        const itemUpdatedAtMs = timestampMs(item.updatedAt);
        if (existingReviewCommentUpdatedAtMs === null || itemUpdatedAtMs === null) return false;
        if (Math.abs(itemUpdatedAtMs - existingReviewCommentUpdatedAtMs) > 5 * 60 * 1000) {
          return false;
        }
      }
      const storedUpdatedAtMs = timestampMs(storedUpdatedAt);
      if (storedUpdatedAtMs === null) return false;
      const reviewedAtMs = timestampMs(frontMatterValue(markdown, "reviewed_at"));
      return !contextHasNonAutomationActivityAfter(
        currentItemContext(),
        storedUpdatedAtMs,
        {
          useCompleteActivityContext: true,
          ...(reviewedAtMs === null ? {} : { ignoreTimelineCommentsThroughMs: reviewedAtMs }),
        },
      );
    };
    const stalePrReviewHead =
      state === "open" && item.kind === "pull_request"
        ? stalePullRequestReviewHead(markdown, currentItemContext())
        : null;
    let currentPrStatusKind: PrStatusLabelKind | null = null;
    if (state === "open") {
      const reviewActivityBlock = currentReviewActivityBlock();
      if (reviewActivityBlock) {
        if (recordReviewLeaseSkip(reviewActivityBlock)) break;
        continue;
      }
      const lateLeaseState = refreshReviewStartLeaseState();
      if (lateLeaseState.blockReason) {
        if (recordReviewLeaseSkip(lateLeaseState.blockReason)) break;
        continue;
      }
      const lateStaleReason = refreshedReviewStaleReason(lateLeaseState.comment);
      if (lateStaleReason) {
        if (recordRefreshedReviewStaleReason(lateStaleReason)) break;
        continue;
      }
      if (lateLeaseState.preserve && lateLeaseState.lease) {
        if (recordActiveReviewLeaseSkip(lateLeaseState.lease.expiresAt)) break;
        continue;
      }
      const mutationLeaseBlockReason = acquireApplyMutationLease(lateLeaseState);
      if (mutationLeaseBlockReason) {
        if (recordReviewLeaseSkip(mutationLeaseBlockReason)) break;
        continue;
      }
    }
    if (state === "open" && item.kind === "pull_request") {
      if (stalePrReviewHead) {
        const staleLabelSyncResult = syncStalePullRequestReviewLabels({
          number,
          labels: item.labels,
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = staleLabelSyncResult.labels;
        clawSweeperLabelsChanged ||= staleLabelSyncResult.changed;
        markdown = replaceFrontMatterValue(
          markdown,
          "current_pull_head_sha",
          stalePrReviewHead.liveHeadSha,
        );
      } else if (labelSyncFreshEnough()) {
        const realBehaviorProof = reportRealBehaviorProof(markdown);
        const proofSufficientSyncResult = syncRealBehaviorProofSufficientLabel({
          number,
          labels: item.labels,
          proof: realBehaviorProof,
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = proofSufficientSyncResult.labels;
        clawSweeperLabelsChanged ||= proofSufficientSyncResult.changed;
        const proofMediaSyncResult = syncRealBehaviorProofMediaLabels({
          number,
          labels: item.labels,
          proof: realBehaviorProof,
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = proofMediaSyncResult.labels;
        clawSweeperLabelsChanged ||= proofMediaSyncResult.changed;
        const prRatingSyncResult = syncPrRatingLabel({
          number,
          labels: item.labels,
          rating: reportPrRating(markdown),
          reviewFailed: frontMatterValue(markdown, "review_status") === "failed",
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = prRatingSyncResult.labels;
        clawSweeperLabelsChanged ||= prRatingSyncResult.changed;
        const featureShowcaseSyncResult = syncFeatureShowcaseLabel({
          number,
          labels: item.labels,
          isPullRequest: true,
          itemCategory: frontMatterValue(markdown, "item_category"),
          requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
          showcase: reportFeatureShowcase(markdown),
          securityReview: reportSecurityReview(markdown),
          overallCorrectness: reportOverallCorrectness(markdown),
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = featureShowcaseSyncResult.labels;
        clawSweeperLabelsChanged ||= featureShowcaseSyncResult.changed;
        currentPrStatusKind = prStatusLabelKindFromReport(
          markdown,
          currentItemContext(),
          item.labels,
        );
        const prStatusSyncResult = syncPrStatusLabel({
          number,
          labels: item.labels,
          statusKind: currentPrStatusKind,
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = prStatusSyncResult.labels;
        clawSweeperLabelsChanged ||= prStatusSyncResult.changed;
        const telegramVisibleProofSyncResult = syncTelegramVisibleProofLabel({
          number,
          labels: item.labels,
          proof: reportTelegramVisibleProof(markdown),
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = telegramVisibleProofSyncResult.labels;
        clawSweeperLabelsChanged ||= telegramVisibleProofSyncResult.changed;
      }
    }
    markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
    if (clawSweeperLabelsChanged && !dryRun) {
      rememberSelfMutationUpdatedAt();
    }
    const renderOptions: ReviewCommentRenderOptions = {
      prStatusKind: currentPrStatusKind,
      previousLabels,
      suppressAutomationMarkers,
    };
    if (item.kind === "issue" && currentClosingPullRequests) {
      renderOptions.hasOpenLinkedPullRequest =
        openClosingPullRequestApplyReason(currentClosingPullRequests) !== null;
    }
    const renderCurrentReviewComment = (): string =>
      stalePrReviewHead
        ? stalePullRequestReviewComment({
            number,
            stale: stalePrReviewHead,
            ...(renderOptions.previousReviewCommentBody
              ? { previousReviewCommentBody: renderOptions.previousReviewCommentBody }
              : {}),
          })
        : renderReviewCommentFromReport(markdown, closeReason ?? "none", renderOptions);
    let reviewComment = renderCurrentReviewComment();
    const existingReviewCommentBody = rawCommentBody(existingReviewComment);
    if (existingReviewCommentBody.trim()) {
      renderOptions.previousReviewCommentBody = existingReviewCommentBody;
      reviewComment = renderCurrentReviewComment();
    }
    let markedReviewComment = markedReviewCommentForApply(reviewComment);
    const protectedApplyReason = applyProtectedLabelReason(item.labels, closeReason);
    if (applyBlockingProtectedLabels(item.labels, closeReason).length > 0) {
      if (isCloseProposal) {
        if (markApplySkipped("skipped_protected_label", protectedApplyReason, true)) break;
      }
      if (isCloseProposal) continue;
    }
    const currentAuthorAssociation = normalizeAuthorAssociation(item.authorAssociation);
    const reviewedAuthorAssociation = normalizeAuthorAssociation(storedAuthorAssociation);
    if (
      isCloseProposal &&
      !isVerifiedFixedCloseReason(closeReason) &&
      (isMaintainerAuthorAssociation(currentAuthorAssociation) ||
        isMaintainerAuthorAssociation(reviewedAuthorAssociation))
    ) {
      const authorAssociation = isMaintainerAuthorAssociation(currentAuthorAssociation)
        ? currentAuthorAssociation
        : reviewedAuthorAssociation;
      markdown = replaceFrontMatterValue(markdown, "author_association", authorAssociation);
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_maintainer_authored");
      if (
        recordApplySkipped(
          "skipped_maintainer_authored",
          `author association is ${authorAssociation}`,
          true,
        )
      )
        break;
      continue;
    }
    const markChangedSinceReview = (options: {
      reason: string;
      currentUpdatedAt?: string | undefined;
      currentSnapshotHash?: string | undefined;
    }): boolean => {
      markdown = replaceFrontMatterValue(
        markdown,
        "action_taken",
        "skipped_changed_since_review",
      );
      if (options.currentUpdatedAt) {
        markdown = replaceFrontMatterValue(
          markdown,
          "current_item_updated_at",
          options.currentUpdatedAt,
        );
      }
      if (options.currentSnapshotHash) {
        markdown = replaceFrontMatterValue(
          markdown,
          "current_item_snapshot_hash",
          options.currentSnapshotHash,
        );
      }
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({
        number,
        action: "skipped_changed_since_review",
        reason: options.reason,
        ...eventApplyDispositionProof("skipped_changed_since_review"),
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${options.reason}`);
      return processedCount >= processedLimit;
    };
    const postProofFreshnessBlock = (): {
      reason: string;
      currentUpdatedAt?: string;
      currentSnapshotHash?: string;
    } | null => {
      if (
        !prCloseCoverageProofGateChecked ||
        cachedPrCloseCoverageProofGateResult?.status !== "allowed"
      ) {
        return null;
      }
      const refreshed = fetchItem(number);
      if (refreshed.state !== "open") {
        return {
          reason: `state changed to ${refreshed.state}`,
          currentUpdatedAt: refreshed.item.updatedAt,
        };
      }
      let refreshedContext: ItemContext | null = null;
      const refreshedCommandStatusOnlyUpdate =
        action === "retry_pr_close_coverage_proof" &&
        retryCloseCoverageCommandStatusOnlyUpdate(
          refreshed.item,
          (refreshedContext ??= collectItemContext(refreshed.item, {
            fullTimelineForRelations: true,
          })),
        );
      const refreshedSelfMutationOnlyUpdate =
        allowedSelfMutationUpdatedAts.has(refreshed.item.updatedAt) ||
        refreshedCommandStatusOnlyUpdate;
      const selfMutationMaskedNonAutomationActivity = (): boolean => {
        if (prCloseCoverageProofStartedAtMs === null) return true;
        refreshedContext ??= collectItemContext(refreshed.item, {
          fullTimelineForRelations: true,
        });
        return contextHasNonAutomationActivityAfter(
          refreshedContext,
          prCloseCoverageProofStartedAtMs,
          { truncationCountsAsActivity: false },
        );
      };
      if (storedUpdatedAt && refreshed.item.updatedAt !== storedUpdatedAt) {
        if (refreshedSelfMutationOnlyUpdate) {
          if (!selfMutationMaskedNonAutomationActivity()) return null;
          return {
            reason: "non-automation activity after coverage proof",
            currentUpdatedAt: refreshed.item.updatedAt,
          };
        }
        return {
          reason: "updated_at changed",
          currentUpdatedAt: refreshed.item.updatedAt,
        };
      }
      if (!storedUpdatedAt && storedHash) {
        const refreshedHash = itemSnapshotHash(
          refreshed.item,
          (refreshedContext ??= collectItemContext(refreshed.item, {
            fullTimelineForRelations: true,
          })),
        );
        if (refreshedHash !== storedHash) {
          if (refreshedSelfMutationOnlyUpdate && !selfMutationMaskedNonAutomationActivity()) {
            return null;
          }
          return {
            reason: refreshedSelfMutationOnlyUpdate
              ? "non-automation activity after coverage proof"
              : "snapshot changed",
            currentSnapshotHash: refreshedHash,
          };
        }
      }
      return null;
    };
    const postProofCoveringPrFreshnessBlock = (): PrCloseCoverageProofGateBlock | null => {
      if (
        !prCloseCoverageProofGateChecked ||
        cachedPrCloseCoverageProofGateResult?.status !== "allowed"
      ) {
        return null;
      }
      const { covering } = cachedPrCloseCoverageProofGateResult;
      if (!covering.updatedAt) return null;
      try {
        const currentUpdatedAt = coveringPrCloseCoveragePullRequestUpdatedAt(covering.number);
        if (currentUpdatedAt === covering.updatedAt) return null;
        return {
          actionTaken: "retry_pr_close_coverage_proof",
          reason: `linked canonical PR #${covering.number} changed after coverage proof`,
        };
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        return {
          actionTaken: "retry_pr_close_coverage_proof",
          reason: `PR close coverage proof could not recheck linked canonical PR #${covering.number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    };
    if (state !== "open") {
      if (item.closedAt) {
        markdown = replaceFrontMatterValue(markdown, "current_item_closed_at", item.closedAt);
      }
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
        markdown = replaceFrontMatterValue(
          markdown,
          "apply_checked_at",
          new Date().toISOString(),
        );
        archiveClosed(markdown);
        closedCount += 1;
        processedCount += 1;
        results.push({
          number,
          action: "closed",
          reason: "matching ClawSweeper review comment already exists",
          ...(emitEventApplyProof
            ? { durableReviewSynced: true, terminalStateVerified: true }
            : {}),
        });
        maybeLogProgress(`archived #${number}: already ${state} with matching review comment`);
        if (processedCount >= processedLimit || closedCount >= limit) break;
        continue;
      }
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_already_closed");
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      archiveClosed(markdown);
      results.push({
        number,
        action: "skipped_already_closed",
        reason: `state is ${state}`,
        ...(emitEventApplyProof ? { terminalStateVerified: true } : {}),
      });
      processedCount += 1;
      maybeLogProgress(`archived #${number}: already ${state}`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (isCloseProposal && stalePrReviewHead) {
      if (
        markChangedSinceReview({
          reason: stalePrReviewHead.reason,
          currentUpdatedAt: item.updatedAt,
        })
      )
        break;
      continue;
    }
    if (isCloseProposal && updatedSinceReview && !automationOnlyUpdate) {
      markdown = replaceFrontMatterValue(
        markdown,
        "action_taken",
        "skipped_changed_since_review",
      );
      markdown = replaceFrontMatterValue(markdown, "current_item_updated_at", item.updatedAt);
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({
        number,
        action: "skipped_changed_since_review",
        reason: "updated_at changed",
        ...eventApplyDispositionProof("skipped_changed_since_review"),
      });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: changed since review`);
      if (processedCount >= processedLimit) break;
      continue;
    }
    if (isCloseProposal && !storedUpdatedAt) {
      const currentHash = itemSnapshotHash(item, currentItemContext());
      if (currentHash !== storedHash && !reviewCommentOnlyUpdate) {
        markdown = replaceFrontMatterValue(
          markdown,
          "action_taken",
          "skipped_changed_since_review",
        );
        markdown = replaceFrontMatterValue(markdown, "current_item_snapshot_hash", currentHash);
        markdown = replaceFrontMatterValue(
          markdown,
          "apply_checked_at",
          new Date().toISOString(),
        );
        if (!dryRun) writeReportMarkdown(path, markdown);
        results.push({
          number,
          action: "skipped_changed_since_review",
          reason: "snapshot changed",
          ...eventApplyDispositionProof("skipped_changed_since_review"),
        });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: snapshot changed`);
        if (processedCount >= processedLimit) break;
        continue;
      }
    }
    const isCurrentLabelSyncReport = !stalePrReviewHead && labelSyncFreshEnough();
    const isCurrentCompleteReport =
      frontMatterValue(markdown, "review_status") === "complete" && isCurrentLabelSyncReport;
    if (state === "open" && isCurrentLabelSyncReport) {
      const mutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
      if (mutationLeaseBlockReason) {
        if (recordReviewLeaseSkip(mutationLeaseBlockReason, false)) break;
        continue;
      }
      try {
        const bulkFilerDetected = frontMatterBoolean(markdown, "bulk_filer_detected");
        const needsBulkFilerPermissionLookup =
          item.kind === "issue" &&
          !isBulkFilerExemptAuthorAssociation(item.authorAssociation) &&
          (bulkFilerDetected || hasNormalizedLabel(item.labels, BULK_FILED_LABEL));
        const bulkFilerSyncResult = syncBulkFilerLabel({
          number,
          labels: item.labels,
          bulkFilerDetected,
          authorAssociation: item.authorAssociation,
          repositoryPermission: needsBulkFilerPermissionLookup
            ? bulkFilerRepositoryPermission(item.author, bulkFilerRepositoryPermissionCache)
            : null,
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = bulkFilerSyncResult.labels;
        clawSweeperLabelsChanged ||= bulkFilerSyncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        if (bulkFilerSyncResult.changed) rememberSelfMutationUpdatedAt();
      } catch (error) {
        if (!isGitHubRequiresAuthenticationError(error)) throw error;
        if (markLabelSyncAuthSkipped("ClawSweeper bulk-filer")) break;
        continue;
      }
    }
    if (state === "open" && isCurrentCompleteReport) {
      const mutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
      if (mutationLeaseBlockReason) {
        if (recordReviewLeaseSkip(mutationLeaseBlockReason, false)) break;
        continue;
      }
      try {
        const syncResult = syncPriorityLabel({
          number,
          labels: item.labels,
          triagePriority: triagePriorityFromReport(markdown),
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = syncResult.labels;
        clawSweeperLabelsChanged ||= syncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        const impactSyncResult = syncImpactLabels({
          number,
          labels: item.labels,
          impactLabels: item.kind === "pull_request" ? [] : impactLabelsFromReport(markdown),
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = impactSyncResult.labels;
        clawSweeperLabelsChanged ||= impactSyncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        const maturitySyncResult = syncMaturityLabels({
          number,
          labels: item.labels,
          maturityLabels: item.kind === "pull_request" ? [] : maturityLabelsFromReport(markdown),
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = maturitySyncResult.labels;
        clawSweeperLabelsChanged ||= maturitySyncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        let mergeRiskLabelsChanged = false;
        if (item.kind === "pull_request") {
          const mergeRiskSyncResult = syncMergeRiskLabels({
            number,
            labels: item.labels,
            mergeRiskLabels: mergeRiskLabelsFromReport(markdown),
            dryRun,
            onMutation: recordMutation,
          });
          item.labels = mergeRiskSyncResult.labels;
          mergeRiskLabelsChanged = mergeRiskSyncResult.changed;
          clawSweeperLabelsChanged ||= mergeRiskSyncResult.changed;
          markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        }
        if (
          syncResult.changed ||
          impactSyncResult.changed ||
          maturitySyncResult.changed ||
          mergeRiskLabelsChanged
        ) {
          rememberSelfMutationUpdatedAt();
        }
      } catch (error) {
        if (!isGitHubRequiresAuthenticationError(error)) throw error;
        if (markLabelSyncAuthSkipped("ClawSweeper")) break;
        continue;
      }
    }
    if (
      state === "open" &&
      item.kind === "issue" &&
      !isCloseProposal &&
      isCurrentCompleteReport
    ) {
      const mutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
      if (mutationLeaseBlockReason) {
        if (recordReviewLeaseSkip(mutationLeaseBlockReason, false)) break;
        continue;
      }
      currentClosingPullRequests = closingPullRequestsForIssue(number);
      try {
        const hasOpenLinkedPullRequest =
          openClosingPullRequestApplyReason(currentClosingPullRequests) !== null;
        renderOptions.hasOpenLinkedPullRequest = hasOpenLinkedPullRequest;
        const advisoryState = issueAdvisoryLabelStateFromReport(markdown, {
          hasOpenLinkedPullRequest,
          locked: item.locked === true,
        });
        const currentHasGoodFirstIssue = item.labels.some(
          (label) => label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL,
        );
        if (!currentHasGoodFirstIssue && isGoodFirstIssue(advisoryState, item.labels)) {
          const reportHadGoodFirstIssue = reportLabelsBeforeApply.some(
            (label) => label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL,
          );
          const humanLabelState = currentItemContext().goodFirstIssueHumanLabelState ?? "unknown";
          advisoryState.goodFirstIssueOptedOut =
            humanLabelState === "removed" ||
            (humanLabelState === "unknown" && reportHadGoodFirstIssue);
        }
        const syncResult = syncIssueAdvisoryLabels({
          number,
          labels: item.labels,
          state: advisoryState,
          dryRun,
          onMutation: recordMutation,
        });
        item.labels = syncResult.labels;
        issueAdvisoryLabelsChanged = syncResult.changed;
        clawSweeperLabelsChanged ||= syncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        if (syncResult.changed) {
          rememberSelfMutationUpdatedAt();
        }
      } catch (error) {
        if (!isGitHubRequiresAuthenticationError(error)) throw error;
        if (markLabelSyncAuthSkipped("advisory issue")) break;
        continue;
      }
    }
    reviewComment = renderCurrentReviewComment();
    markedReviewComment = markedReviewCommentForApply(reviewComment);
    if (isCloseProposal && item.kind === "issue") {
      currentClosingPullRequests ??= closingPullRequestsForIssue(number);
      const openClosingPullRequestReason = openClosingPullRequestApplyReason(
        currentClosingPullRequests,
        (pullNumber, pullRepo) => canClosePairCounterpartInThisRun(pullNumber, pullRepo),
      );
      if (openClosingPullRequestReason) {
        if (markApplySkipped("skipped_open_closing_pr", openClosingPullRequestReason, true))
          break;
        continue;
      }
    }
    let reviewCommentHash = reviewCommentBodyDigest(markedReviewComment);
    const allowApplyCloseActionUpgrade = isUpgradedCloseCandidate;
    let existingReviewCommentMatches = commentBodyMatches(
      existingReviewComment,
      markedReviewComment,
      { allowApplyCloseActionUpgrade },
    );
    let needsReviewCommentBodySync = !existingReviewComment || !existingReviewCommentMatches;
    let needsReviewCommentHashSync = !reviewCommentHashMatches(
      existingReviewComment,
      markedReviewComment,
      frontMatterValue(markdown, "review_comment_sha256"),
      reviewCommentHash,
      { allowApplyCloseActionUpgrade },
    );
    let needsReviewCommentReferenceSync =
      frontMatterValue(markdown, "review_comment_id") === "unknown" ||
      frontMatterValue(markdown, "review_comment_url") === "unknown";
    let needsReviewCommentSync = shouldSyncReviewComment({
      syncCommentsOnly,
      isCloseProposal,
      commentSyncMinAgeDays,
      reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
      hasExistingReviewComment: Boolean(existingReviewComment),
      needsReviewCommentBodySync,
      needsReviewCommentHashSync,
      needsReviewCommentReferenceSync,
      forceReviewCommentBodySync: clawSweeperLabelsChanged || Boolean(closeBlockedForCommentSync),
    });
    if (
      isCloseProposal &&
      closeReason === "duplicate_or_superseded" &&
      !syncCommentsOnly &&
      (applyKind === "all" || item.kind === applyKind) &&
      closeReasonEnabled(closeReason, applyCloseReasons)
    ) {
      const preSyncReportValidation = validateCloseDecision(
        {
          repo,
          kind: item.kind,
          labels: item.labels,
          authorAssociation: item.authorAssociation,
        },
        reportDecision(markdown, closeReason),
        { requireCloseComment: !isRetryableSkippedClose },
      );
      const preSyncValidationPassed =
        preSyncReportValidation.ok || preSyncReportValidation.actionTaken === "kept_open";
      if (
        preSyncValidationPassed &&
        !duplicateCanonicalPullRequestBlockReason(markdown, item, {
          reportDirs: [itemsDir, closedDir],
        }) &&
        !closeReasonApplyAgeSkipReason(item, closeReason, {
          minAgeMs,
          minAgeDescription,
          staleMinAgeDays,
        })
      ) {
        const prCloseCoverageBlock = currentPrCloseCoverageProofGateBlock();
        if (prCloseCoverageBlock) {
          if (prCloseCoverageBlock.actionTaken === "skipped_runtime_budget") {
            recordRuntimeBudgetYield(prCloseCoverageBlock.reason);
            break;
          }
          if (prCloseCoverageBlock.actionTaken !== "skipped_pr_close_coverage_proof") {
            if (markApplySkipped(prCloseCoverageBlock.actionTaken, prCloseCoverageBlock.reason))
              break;
            continue;
          }
          closeBlockedForCommentSync = prCloseCoverageBlock;
          markdown = applyPrCloseCoverageProofBlockedReport(markdown, prCloseCoverageBlock);
          markdown = replaceFrontMatterValue(
            markdown,
            "action_taken",
            prCloseCoverageBlock.actionTaken,
          );
          markdown = replaceFrontMatterValue(
            markdown,
            "apply_checked_at",
            new Date().toISOString(),
          );
          closeReason = "none";
          isCloseProposal = false;
          reviewComment = renderReviewCommentFromReport(markdown, closeReason, renderOptions);
          markedReviewComment = markedReviewCommentForApply(reviewComment);
          reviewCommentHash = reviewCommentBodyDigest(markedReviewComment);
          existingReviewCommentMatches = commentBodyMatches(
            existingReviewComment,
            markedReviewComment,
          );
          needsReviewCommentBodySync = !existingReviewComment || !existingReviewCommentMatches;
          needsReviewCommentHashSync =
            frontMatterValue(markdown, "review_comment_sha256") !== reviewCommentHash;
          needsReviewCommentReferenceSync =
            frontMatterValue(markdown, "review_comment_id") === "unknown" ||
            frontMatterValue(markdown, "review_comment_url") === "unknown";
          needsReviewCommentSync = shouldSyncReviewComment({
            syncCommentsOnly,
            isCloseProposal,
            commentSyncMinAgeDays,
            reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
            hasExistingReviewComment: Boolean(existingReviewComment),
            needsReviewCommentBodySync,
            needsReviewCommentHashSync,
            needsReviewCommentReferenceSync,
            forceReviewCommentBodySync: true,
          });
        }
        const coveringFreshnessBlock = postProofCoveringPrFreshnessBlock();
        if (coveringFreshnessBlock) {
          if (markApplySkipped(coveringFreshnessBlock.actionTaken, coveringFreshnessBlock.reason))
            break;
          continue;
        }
        const freshnessBlock = postProofFreshnessBlock();
        if (freshnessBlock) {
          if (markChangedSinceReview(freshnessBlock)) break;
          continue;
        }
      }
    }
    if (isCloseProposal) {
      const sameAuthorCounterpartReason = sameAuthorCounterpartApplyReason(
        item,
        currentItemContext().relatedItems ?? [],
        (counterpartNumber, counterpartKind) =>
          canClosePairCounterpartInThisRun(counterpartNumber) ||
          canStartSameAuthorPairCloseInThisRun(counterpartNumber, counterpartKind),
      );
      if (sameAuthorCounterpartReason) {
        if (markApplySkipped("skipped_same_author_pair", sameAuthorCounterpartReason, true))
          break;
        continue;
      }
    }
    if (clawSweeperLabelsChanged && !dryRun) {
      markdown = replaceFrontMatterValue(markdown, "labels_synced_at", new Date().toISOString());
    }
    const labelSyncReason = issueAdvisoryLabelsChanged
      ? dryRun
        ? "dry-run: would sync advisory issue labels"
        : "synced advisory issue labels"
      : dryRun
        ? "dry-run: would sync ClawSweeper labels"
        : "synced ClawSweeper labels";
    const labelSyncProgressMessage = issueAdvisoryLabelsChanged
      ? `synced advisory issue labels #${number}`
      : `synced ClawSweeper labels #${number}`;
    if (
      needsReviewCommentSync &&
      needsReviewCommentBodySync &&
      shouldCheckCanonicalCommentSync()
    ) {
      const wasStaleCanonicalCommentSyncPending = staleCanonicalCommentSyncPending;
      const mutationBoundaryGuard = applyCanonicalCommentSyncGuard(true);
      if (mutationBoundaryGuard.stopApply) break;
      if (mutationBoundaryGuard.skipCurrentItem) continue;
      if (changedSinceReviewDuplicateCommentRepair && !staleCanonicalCommentSyncPending) {
        needsReviewCommentSync = false;
      }
      if (!wasStaleCanonicalCommentSyncPending && staleCanonicalCommentSyncPending) {
        reviewComment = renderCurrentReviewComment();
        markedReviewComment = markedReviewCommentForApply(reviewComment);
        reviewCommentHash = reviewCommentBodyDigest(markedReviewComment);
        existingReviewCommentMatches = commentBodyMatches(
          existingReviewComment,
          markedReviewComment,
        );
        needsReviewCommentBodySync = !existingReviewComment || !existingReviewCommentMatches;
        needsReviewCommentHashSync =
          frontMatterValue(markdown, "review_comment_sha256") !== reviewCommentHash;
        needsReviewCommentReferenceSync =
          frontMatterValue(markdown, "review_comment_id") === "unknown" ||
          frontMatterValue(markdown, "review_comment_url") === "unknown";
        needsReviewCommentSync = shouldSyncReviewComment({
          syncCommentsOnly,
          isCloseProposal,
          commentSyncMinAgeDays,
          reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
          hasExistingReviewComment: Boolean(existingReviewComment),
          needsReviewCommentBodySync,
          needsReviewCommentHashSync,
          needsReviewCommentReferenceSync,
          forceReviewCommentBodySync: true,
        });
      }
    }
    if (needsReviewCommentSync) {
      const staleSyncReason = needsReviewCommentBodySync ? staleReviewCommentReason : null;
      if (staleSyncReason) {
        markdown = replaceFrontMatterValue(
          markdown,
          "apply_checked_at",
          new Date().toISOString(),
        );
        if (!dryRun) writeReportMarkdown(path, markdown);
        results.push({
          number,
          action: "skipped_stale_review_comment_sync",
          reason: staleSyncReason,
        });
        processedCount += 1;
        maybeLogProgress(`skipped stale review comment sync #${number}`);
        if (processedCount >= processedLimit) break;
        continue;
      }
      const lockedReason = needsReviewCommentBodySync
        ? lockedConversationApplyReason(item)
        : null;
      if (lockedReason) {
        const actionTaken: ActionTaken = staleCanonicalCommentSyncPending
          ? "retry_stale_canonical_comment_sync"
          : "skipped_locked_conversation";
        const reason = staleCanonicalCommentSyncPending
          ? `${lockedReason}; stale canonical comment correction remains pending`
          : lockedReason;
        if (markApplySkipped(actionTaken, reason, actionTaken === "skipped_locked_conversation"))
          break;
        continue;
      }
      let syncedComment = existingReviewComment;
      const syncReasons: string[] = [];
      if (needsReviewCommentBodySync) {
        if (dryRun) {
          syncReasons.push(
            existingReviewComment
              ? "would update durable Codex review comment"
              : "would create durable Codex review comment",
          );
        } else {
          const preLeaseCanonicalGuard = applyCanonicalCommentSyncGuard(true);
          if (preLeaseCanonicalGuard.stopApply) break;
          if (preLeaseCanonicalGuard.skipCurrentItem) continue;
          const mutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
          if (mutationLeaseBlockReason) {
            if (recordReviewLeaseSkip(mutationLeaseBlockReason, false)) break;
            continue;
          }
          const latestLeaseState = refreshReviewStartLeaseState();
          if (latestLeaseState.blockReason) {
            if (recordReviewLeaseSkip(latestLeaseState.blockReason, false)) break;
            continue;
          }
          const finalCanonicalGuard = applyCanonicalCommentSyncGuard(true);
          if (finalCanonicalGuard.stopApply) break;
          if (finalCanonicalGuard.skipCurrentItem) continue;
          existingReviewComment = latestLeaseState.comment;
          if (staleCanonicalCommentSyncPending) {
            const latestReviewCommentBody = rawCommentBody(existingReviewComment);
            if (latestReviewCommentBody.trim()) {
              renderOptions.previousReviewCommentBody = latestReviewCommentBody;
            }
            reviewComment = renderCurrentReviewComment();
            markedReviewComment = markedReviewCommentForApply(reviewComment);
          }
          const latestStaleSyncReason = canonicalBoundStaleReviewReason(
            markdown,
            existingReviewComment,
          );
          if (latestStaleSyncReason) {
            markdown = replaceFrontMatterValue(
              markdown,
              "apply_checked_at",
              new Date().toISOString(),
            );
            writeReportMarkdown(path, markdown);
            results.push({
              number,
              action: "skipped_stale_review_comment_sync",
              reason: latestStaleSyncReason,
            });
            processedCount += 1;
            maybeLogProgress(`skipped stale review comment sync #${number}`);
            if (processedCount >= processedLimit) break;
            continue;
          }
          const lowSignalCommentSyncBlockReason =
            closeReason === "low_signal_unmergeable_pr"
              ? lowSignalUnmergeablePrApplyBlockReasonSafe(number, staleMinAgeDays)
              : null;
          if (lowSignalCommentSyncBlockReason) {
            if (
              markApplySkipped(
                "skipped_low_signal_live_guard",
                lowSignalCommentSyncBlockReason,
                true,
              )
            )
              break;
            continue;
          }
          try {
            syncedComment = upsertReviewComment(
              number,
              markedReviewComment,
              existingReviewComment,
            );
            const syncedCommentUpdatedAt = commentUpdatedAt(syncedComment);
            if (syncedCommentUpdatedAt) {
              allowedSelfMutationUpdatedAts.add(syncedCommentUpdatedAt);
            }
            syncReasons.push("updated durable Codex review comment");
            // The durable review comment is now published, so stale "review
            // started" placeholders from failed earlier attempts are clutter.
            const placeholderKeepCommentIds = new Set<number>();
            const syncedCommentId = commentId(syncedComment);
            if (syncedCommentId !== null) placeholderKeepCommentIds.add(syncedCommentId);
            // Closures assign the active lease, so read it through a cast to
            // defeat TypeScript's stale null narrowing at this use site.
            const heldMutationLease = activeApplyMutationLease as {
              itemNumber: number;
              lease: AcquiredReviewStartLease;
            } | null;
            if (heldMutationLease?.itemNumber === number) {
              placeholderKeepCommentIds.add(heldMutationLease.lease.commentId);
            }
            cleanupSupersededReviewPlaceholderComments({
              number,
              comments: latestLeaseState.comments,
              keepCommentIds: placeholderKeepCommentIds,
            });
          } catch (error) {
            const commentAuthError = isGitHubRequiresAuthenticationError(error);
            if (!commentAuthError && !isLockedConversationCommentError(error)) throw error;
            const fallbackActionTaken: ActionTaken = commentAuthError
              ? "skipped_comment_auth"
              : "skipped_locked_conversation";
            const fallbackReason = commentAuthError
              ? "GitHub rejected durable review comment write with Requires authentication"
              : "conversation was locked while syncing review comment";
            const actionTaken: ActionTaken = staleCanonicalCommentSyncPending
              ? "retry_stale_canonical_comment_sync"
              : fallbackActionTaken;
            const reason = staleCanonicalCommentSyncPending
              ? `${fallbackReason}; stale canonical comment correction remains pending`
              : fallbackReason;
            if (
              markApplySkipped(actionTaken, reason, actionTaken === "skipped_locked_conversation")
            )
              break;
            continue;
          }
        }
      } else {
        syncReasons.push("recorded existing durable comment metadata");
      }
      markdown = updateReviewCommentMetadata(markdown, syncedComment, markedReviewComment);
      if (staleCanonicalCommentSyncPending) {
        markdown = completeStaleCanonicalCommentSyncReport(markdown);
      }
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({
        number,
        action: closeBlockedForCommentSync?.actionTaken ?? "review_comment_synced",
        reason: closeBlockedForCommentSync
          ? [closeBlockedForCommentSync.reason, ...syncReasons].join("; ")
          : syncReasons.join("; "),
        commentMutationOccurred: !dryRun && needsReviewCommentBodySync,
        ...(emitEventApplyProof ? { durableReviewSynced: true } : {}),
      });
      processedCount += 1;
      maybeLogProgress(`synced review comment #${number}`);
      if (processedCount >= processedLimit) break;
    }
    if (closeBlockedForCommentSync) {
      if (!needsReviewCommentSync) {
        if (staleCanonicalCommentSyncPending) {
          markdown = completeStaleCanonicalCommentSyncReport(markdown);
        }
        markdown = replaceFrontMatterValue(
          markdown,
          "apply_checked_at",
          new Date().toISOString(),
        );
        if (!dryRun) writeReportMarkdown(path, markdown);
        results.push({
          number,
          action: closeBlockedForCommentSync.actionTaken,
          reason: closeBlockedForCommentSync.reason,
        });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: ${closeBlockedForCommentSync.reason}`);
        if (processedCount >= processedLimit) break;
      }
      continue;
    }
    if (
      clawSweeperLabelsChanged &&
      !needsReviewCommentSync &&
      (!isCloseProposal || syncCommentsOnly)
    ) {
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({
        number,
        action: "kept_open",
        reason: labelSyncReason,
      });
      processedCount += 1;
      maybeLogProgress(labelSyncProgressMessage);
      if (processedCount >= processedLimit) break;
    }
    if (syncCommentsOnly) continue;
    if (!isCloseProposal || !closeReason) {
      if (!isCloseProposal && attemptedPullRequestClosePromotion) markApplyChecked();
      continue;
    }
    if (
      requiredMaintainerDecision?.required &&
      closeReason !== "unsponsored_feature_request" &&
      closeReason !== "author_pr_budget_exceeded"
    ) {
      if (
        markApplySkipped(
          "kept_open",
          `maintainer decision required: ${requiredMaintainerDecision.question}`,
        )
      )
        break;
      continue;
    }
    if (closedCount >= limit) {
      removeCurrentCursorTraceItem(examinedItemNumbers, number);
      break;
    }
    if (applyKind !== "all" && item.kind !== applyKind) {
      if (recordApplySkipped("kept_open", `type is ${item.kind}; apply kind is ${applyKind}`))
        break;
      continue;
    }
    if (!closeReasonEnabled(closeReason, applyCloseReasons)) {
      if (
        recordApplySkipped(
          "kept_open",
          `close reason ${closeReason} is not enabled for this apply run`,
        )
      )
        break;
      continue;
    }
    const currentReportValidation = validateCloseDecision(
      {
        repo,
        kind: item.kind,
        labels: item.labels,
        authorAssociation: item.authorAssociation,
      },
      reportDecision(markdown, closeReason),
      { requireCloseComment: !isRetryableSkippedClose },
    );
    if (!currentReportValidation.ok && currentReportValidation.actionTaken !== "kept_open") {
      if (
        markApplySkipped(
          currentReportValidation.actionTaken,
          currentReportValidation.reason,
          EVENT_GUARDED_OPEN_ACTIONS.has(currentReportValidation.actionTaken),
        )
      )
        break;
      continue;
    }
    const duplicateCanonicalBlockReason =
      closeReason === "duplicate_or_superseded"
        ? duplicateCanonicalPullRequestBlockReason(markdown, item, {
            reportDirs: [itemsDir, closedDir],
          })
        : null;
    if (duplicateCanonicalBlockReason) {
      if (markApplySkipped("kept_open", duplicateCanonicalBlockReason)) break;
      continue;
    }
    const ageSkipReason = closeReasonApplyAgeSkipReason(item, closeReason, {
      minAgeMs,
      minAgeDescription,
      staleMinAgeDays,
    });
    if (ageSkipReason) {
      if (recordApplySkipped("kept_open", ageSkipReason)) break;
      continue;
    }
    const prCloseCoverageBlock =
      closeReason === "duplicate_or_superseded" ? currentPrCloseCoverageProofGateBlock() : null;
    if (prCloseCoverageBlock) {
      if (prCloseCoverageBlock.actionTaken === "skipped_runtime_budget") {
        recordRuntimeBudgetYield(prCloseCoverageBlock.reason);
        break;
      }
      if (markApplySkipped(prCloseCoverageBlock.actionTaken, prCloseCoverageBlock.reason)) break;
      continue;
    }
    const postProofDuplicateCanonicalBlockReason =
      closeReason === "duplicate_or_superseded"
        ? duplicateCanonicalPullRequestBlockReason(markdown, item, {
            reportDirs: [itemsDir, closedDir],
          })
        : null;
    if (postProofDuplicateCanonicalBlockReason) {
      if (markApplySkipped("kept_open", postProofDuplicateCanonicalBlockReason)) break;
      continue;
    }
    const coveringFreshnessBlock = postProofCoveringPrFreshnessBlock();
    if (coveringFreshnessBlock) {
      if (markApplySkipped(coveringFreshnessBlock.actionTaken, coveringFreshnessBlock.reason))
        break;
      continue;
    }
    const freshnessBlock = postProofFreshnessBlock();
    if (freshnessBlock) {
      if (markChangedSinceReview(freshnessBlock)) break;
      continue;
    }
    if (closeReason === "duplicate_or_superseded") {
      markdown = applyPrCloseCoverageProofReportSection(
        markdown,
        cachedPrCloseCoverageProofGateResult,
      );
    }
    const lowSignalBlockReason =
      closeReason === "low_signal_unmergeable_pr"
        ? lowSignalUnmergeablePrApplyBlockReasonSafe(number, staleMinAgeDays)
        : null;
    if (lowSignalBlockReason) {
      if (markApplySkipped("skipped_low_signal_live_guard", lowSignalBlockReason, true)) break;
      continue;
    }
    const inactivityCloseBlockReason =
      closeReason === "stalled_unproven_pr"
        ? stalledUnprovenPrApplyBlockReasonSafe(number, item)
        : closeReason === "abandoned_pr"
          ? abandonedPrApplyBlockReasonSafe(number, item)
        : closeReason === "unsponsored_feature_request"
          ? unsponsoredFeatureApplyBlockReasonSafe(number, item)
          : closeReason === "author_pr_budget_exceeded"
            ? (() => {
                const gate = currentAuthorPrBudgetApplyGate();
                return gate.allowed ? null : gate.reason;
              })()
          : closeReason === "stale_version_bug"
            ? currentStaleVersionBugBlockReason()
            : closeReason === "obsolete_fix_pr"
              ? currentObsoleteFixPrBlockReason()
          : closeReason === "stale_insufficient_info"
              ? issueRecentHumanCommentBlockReasonSafe(
                  number,
                  STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
                )
              : null;
    if (inactivityCloseBlockReason) {
      if (markApplySkipped("kept_open", inactivityCloseBlockReason)) break;
      continue;
    }
    const closeMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
    if (closeMutationLeaseBlockReason) {
      if (recordReviewLeaseSkip(closeMutationLeaseBlockReason, false)) break;
      continue;
    }
    logProgress(`closing #${number}`);
    if (dryRun) {
      const closeAppliedCommentReason =
        item.kind === "pull_request"
          ? ensureCloseAppliedComment({
              number,
              closeReason,
              markdown,
              itemUrl: item.url,
              dryRun,
            })
          : null;
      closedCount += 1;
      processedCount += 1;
      results.push({
        number,
        action: "closed",
        reason: [
          `dry-run: would close as ${closeReasonText(closeReason)}`,
          closeAppliedCommentReason,
        ]
          .filter(Boolean)
          .join("; "),
      });
      logProgress(`would close #${number}`);
      closedThisRun.add(pairCloseKey(repo, number));
      if (item.kind === "pull_request") recordAuthorPrClose(item.author, closeReason);
      if (processedCount >= processedLimit) break;
      continue;
    }
    const closeAppliedCommentReason =
      item.kind === "pull_request"
        ? ensureCloseAppliedComment({
            number,
            closeReason,
            markdown,
            itemUrl: item.url,
            dryRun,
          })
        : null;
    const preCloseMutationLeaseBlockReason = currentApplyMutationLeaseBlockReason();
    if (preCloseMutationLeaseBlockReason) {
      if (recordReviewLeaseSkip(preCloseMutationLeaseBlockReason, false)) break;
      continue;
    }
    ensureRuntimeDelayFits(closeDelayMs, "before close");
    const appliedCloseReason = closeReason;
    const needsIdeaArchiveLabel =
      appliedCloseReason === "unsponsored_feature_request" &&
      !item.labels.map(normalizeLabelName).includes(IDEA_ARCHIVE_LABEL);
    if (appliedCloseReason === "unsponsored_feature_request") {
      ensureIdeaArchiveLabel(recordMutation);
      if (needsIdeaArchiveLabel) {
        addIssueLabel(number, IDEA_ARCHIVE_LABEL, recordMutation);
        item.labels.push(IDEA_ARCHIVE_LABEL);
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
      }
    }
    // On a failed/uncertain close the archive label deliberately stays: the
    // revival watcher removes it if the issue is still open, and if the close
    // actually landed the issue stays discoverable in the archive.
    closeItem({ number, kind: item.kind, reason: appliedCloseReason });
    let postCloseRuntimeYieldReason: string | null = null;
    try {
      ensureRuntimeDelayFits(closeDelayMs, "before close delay");
      sleepMs(closeDelayMs);
    } catch (error) {
      if (!(error instanceof GitHubRuntimeBudgetError)) throw error;
      postCloseRuntimeYieldReason = error.reason;
    }
    markdown = replaceSectionValue(markdown, REVIEW_SECTIONS.closeComment, reviewComment);
    markdown = replaceFrontMatterValue(markdown, "close_comment_sha256", sha256(reviewComment));
    markdown = replaceFrontMatterValue(markdown, "action_taken", "closed");
    markdown = replaceFrontMatterValue(markdown, "applied_at", new Date().toISOString());
    markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
    archiveClosed(markdown);
    closedCount += 1;
    processedCount += 1;
    results.push({
      number,
      action: "closed",
      reason: [closeReasonText(closeReason), closeAppliedCommentReason]
        .filter(Boolean)
        .join("; "),
      ...(emitEventApplyProof ? { terminalStateVerified: true } : {}),
    });
    logProgress(`closed #${number}`);
    closedThisRun.add(pairCloseKey(repo, number));
    if (item.kind === "pull_request") recordAuthorPrClose(item.author, closeReason);
    if (postCloseRuntimeYieldReason) {
      runtimeBudget.onYield?.(postCloseRuntimeYieldReason, false);
      return;
    }
    if (processedCount >= processedLimit) break;
    } catch (error) {
      if (error instanceof ApplyMutationReviewGuardError && recordApplyMutationGuardReason) {
        if (recordApplyMutationGuardReason(error.message)) break;
        continue;
      }
      applyItemFailed = true;
      throw error;
    } finally {
      releaseActiveApplyMutationLease();
      activeApplyMutationRunner = previousApplyMutationRunner;
      if (!applyItemFailed) {
        const state = applyLedger.items.get(actionLedgerItemKey(entry));
        if (!applyLedger.terminal && state?.started && !state.terminal) {
          const closedEntryPath = join(closedDir, file);
          const currentEntryPath = existsSync(path)
            ? path
            : existsSync(closedEntryPath)
              ? closedEntryPath
              : entry.path;
          const currentEntry = existsSync(currentEntryPath)
            ? {
                ...entry,
                path: currentEntryPath,
                markdown: readFileSync(currentEntryPath, "utf8"),
              }
            : entry;
          recordApplyActionLedgerItemResults({
            ledger: applyLedger,
            state,
            results: results
              .slice(applyItemResultStart)
              .filter(
                (result) => (result.repo ?? targetRepo()) === repo && result.number === number,
              ),
            entry: currentEntry,
            mutationOccurred: mutationByItem.get(`${repo}#${number}`) === true,
            dryRun,
          });
        }
        activeApplyItem = null;
      }
    }
  }
  releaseActiveApplyMutationLease();
  activeApplyItem = null;
  if (runtimeBudget.yieldReason) {
    runtimeBudget.onYield?.(runtimeBudget.yieldReason);
    return;
  }
  finishApply();
}

function orderedApplyItemNumbers(
  itemNumbers: string | boolean | string[] | undefined,
  itemNumber: string | boolean | string[] | undefined,
): number[] {
  const ordered: number[] = [];
  const seen = new Set<number>();
  const add = (value: string): void => {
    for (const part of value.split(",")) {
      const parsed = Number(part.trim());
      if (!Number.isInteger(parsed) || parsed <= 0 || seen.has(parsed)) continue;
      seen.add(parsed);
      ordered.push(parsed);
    }
  };
  if (typeof itemNumbers === "string") add(itemNumbers);
  if (typeof itemNumber === "string") add(itemNumber);
  return ordered;
}

function applyArtifactsCommand(args: Args): void {
  const profile = repoFromArgs(args);
  const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts"));
  const recordRoot = resolve(stringArg(args.record_root, ROOT));
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
  const canonicalBaselineDir = stringArg(
    args.canonical_record_baseline_dir,
    process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR ?? "",
  ).trim();
  const skipReconcile = boolArg(args.skip_reconcile);
  const replayClosedArtifacts = boolArg(args.replay_closed_artifacts);
  const maxPages = numberArg(args.max_pages, 250);
  let appliedArtifacts = 0;
  let skippedClosedArtifacts = 0;
  const operationIdentity = {
    repository: targetRepo(),
    artifactDir: repoRelativePath(artifactDir),
    itemsDir: repoRelativePath(itemsDir),
    closedDir: repoRelativePath(closedDir),
  };
  const publicationStart = recordWorkflowPhaseEvent(ROOT, {
    phase: ACTION_EVENT_TYPES.reviewLogPublication,
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    retryable: false,
    mutation: false,
    identity: { slot: "review_publication_start" },
    operation: "review_publication",
    operationIdentity,
    phaseSeq: 1,
    idempotencyIdentity: { operationIdentity, slot: "review_publication_start" },
    component: "apply_artifacts",
    subject: {
      repository: targetRepo(),
      kind: "publication",
    },
    evidence: workflowRunEvidence(),
    attributes: {
      publication_kind: "review_record",
    },
    privacy: actionLedgerPrivacy(),
  });
  let publicationIndex = 0;
  let publicationTerminal = false;
  let activePublication: {
    markdown: string;
    reportPath: string;
    number: number;
    destination: string;
    mutation: boolean;
  } | null = null;
  const recordPublication = (options: {
    markdown: string;
    reportPath: string;
    number: number;
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    mutation: boolean;
    destination: string;
  }): void => {
    const kind = reportItemKind(options.markdown);
    if (!kind) return;
    const sourceRevision = reviewLeaseRevisionFromReport(options.markdown);
    const recordPath = repoRelativePath(options.reportPath);
    recordWorkflowPhaseEvent(ROOT, {
      phase: ACTION_EVENT_TYPES.reviewLogPublication,
      status: options.status,
      reasonCode: options.reasonCode,
      retryable:
        options.status === ACTION_EVENT_STATUSES.failed ||
        options.status === ACTION_EVENT_STATUSES.yielded ||
        options.status === ACTION_EVENT_STATUSES.cancelled,
      mutation: options.mutation,
      identity: {
        slot: "review_publication",
        index: publicationIndex,
        number: options.number,
      },
      operation: "review_publication",
      operationIdentity,
      parentEventId: publicationStart?.event_id ?? null,
      phaseSeq: 10 + publicationIndex,
      idempotencyIdentity: {
        operationIdentity,
        slot: "review_publication",
        index: publicationIndex,
        number: options.number,
      },
      component: "apply_artifacts",
      subject: {
        repository: targetRepo(),
        kind,
        number: options.number,
        ...(sourceRevision ? { sourceRevision } : {}),
        ...(recordPath.startsWith("../") ? {} : { recordPath }),
      },
      evidence: [
        ...workflowRunEvidence(),
        {
          kind: "review_record",
          sha256: sha256(options.markdown),
          ...(recordPath.startsWith("../") ? {} : { reportPath: recordPath }),
        },
      ],
      attributes: {
        publication_kind: "review_record",
        log_kind: "review",
        log_count: 1,
        state: options.destination,
      },
      privacy: actionLedgerPrivacy(),
    });
    publicationIndex += 1;
  };
  const finishPublication = (error?: unknown, interruptedMutation = false): void => {
    if (publicationTerminal) return;
    const failure = error === undefined ? null : actionLedgerFailureDisposition(error);
    recordWorkflowPhaseEvent(ROOT, {
      phase: ACTION_EVENT_TYPES.reviewLogPublication,
      status: failure
        ? failure.status
        : appliedArtifacts === 0 && skippedClosedArtifacts > 0
          ? ACTION_EVENT_STATUSES.skipped
          : ACTION_EVENT_STATUSES.completed,
      reasonCode: failure
        ? failure.reasonCode
        : appliedArtifacts === 0
          ? ACTION_EVENT_REASON_CODES.noChanges
          : ACTION_EVENT_REASON_CODES.completed,
      retryable: failure !== null,
      mutation: appliedArtifacts > 0 || interruptedMutation,
      identity: { slot: "review_publication_terminal" },
      operation: "review_publication",
      operationIdentity,
      parentEventId: publicationStart?.event_id ?? null,
      phaseSeq: 1_000_000,
      idempotencyIdentity: { operationIdentity, slot: "review_publication_terminal" },
      component: "apply_artifacts",
      subject: {
        repository: targetRepo(),
        kind: "publication",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        action_count: appliedArtifacts,
        skipped_count: skippedClosedArtifacts,
        failed_count: failure ? 1 : 0,
        publication_kind: "state_worktree",
        partial:
          failure !== null
            ? appliedArtifacts > 0 || interruptedMutation
            : skippedClosedArtifacts > 0 && appliedArtifacts > 0,
        completion_reason: failure
          ? failure.completionReason
          : appliedArtifacts === 0
            ? "no_changes"
            : "completed",
      },
      privacy: actionLedgerPrivacy(),
    });
    publicationTerminal = true;
  };
  try {
    ensureDir(itemsDir);
    ensureDir(closedDir);
    const openNumbers = skipReconcile ? null : fetchOpenItemNumbers(maxPages).numbers;
    if (existsSync(artifactDir)) {
      for (const entry of readdirSync(artifactDir, { recursive: true })) {
        const name = String(entry);
        if (!name.endsWith(".md")) continue;
        const source = join(artifactDir, name);
        if (!parseReportFileName(basename(source))) continue;
        const number = numberForMarkdownFile(basename(source));
        let markdown = readFileSync(source, "utf8");
        if (!isMarkdownForActiveRepo(markdown, basename(source))) continue;
        const destinationFile = reportFileName(
          markdownRepository(markdown, basename(source)),
          number,
        );
        const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
        const destination = reviewArtifactDestination(
          action,
          replayClosedArtifacts || artifactTargetIsOpen(number, openNumbers),
        );
        if (destination === "skip_closed") {
          recordPublication({
            markdown,
            reportPath: source,
            number,
            status: ACTION_EVENT_STATUSES.skipped,
            reasonCode: ACTION_EVENT_REASON_CODES.stateChanged,
            mutation: false,
            destination,
          });
          skippedClosedArtifacts += 1;
          continue;
        }
        const destinationDir = destination === "closed" ? closedDir : itemsDir;
        const reportPath = join(destinationDir, destinationFile);
        activePublication = {
          markdown,
          reportPath,
          number,
          destination,
          mutation: false,
        };
        if (canonicalBaselineDir) {
          const packetName = `${number}.json`;
          captureCanonicalRecordBaseline({
            baselineRoot: canonicalBaselineDir,
            repositorySlug: profile.slug,
            itemNumber: number,
            sources: [
              { section: "items", name: destinationFile, path: join(itemsDir, destinationFile) },
              { section: "closed", name: destinationFile, path: join(closedDir, destinationFile) },
              { section: "plans", name: destinationFile, path: join(plansDir, destinationFile) },
              {
                section: "decision-packets",
                name: packetName,
                path: join(decisionPacketsDir, packetName),
              },
            ],
          });
        }
        const stalePath = join(destinationDir === itemsDir ? closedDir : itemsDir, destinationFile);
        if (existsSync(stalePath)) {
          unlinkSync(stalePath);
          activePublication.mutation = true;
        }
        if (existsSync(reportPath)) {
          markdown = preserveFailedReviewRetryMetadata(readFileSync(reportPath, "utf8"), markdown);
        }
        activePublication.mutation = true;
        const syncedMarkdown = syncDecisionPacketRecord({
          markdown,
          reportPath,
          packetsDir: decisionPacketsDir,
          repoRoot: recordRoot,
          subjectState: destination === "closed" ? "closed" : "open",
        }).markdown;
        activePublication.markdown = syncedMarkdown;
        writeFileSync(reportPath, syncedMarkdown, "utf8");
        if (destination === "closed") {
          const planPath = workPlanPathForReport(reportPath, plansDir);
          if (existsSync(planPath)) unlinkSync(planPath);
        } else {
          syncWorkPlanFromReport({ markdown: syncedMarkdown, reportPath, plansDir });
        }
        recordPublication({
          markdown: syncedMarkdown,
          reportPath,
          number,
          status: ACTION_EVENT_STATUSES.completed,
          reasonCode: ACTION_EVENT_REASON_CODES.completed,
          mutation: true,
          destination,
        });
        activePublication = null;
        appliedArtifacts += 1;
      }
    }
    console.error(
      `[apply-artifacts] applied=${appliedArtifacts} skipped_closed=${skippedClosedArtifacts}`,
    );
    if (!skipReconcile)
      reconcileFolders({
        itemsDir,
        closedDir,
        plansDir,
        decisionPacketsDir,
        ...(canonicalBaselineDir ? { canonicalBaselineDir, repositorySlug: profile.slug } : {}),
      });
    finishPublication();
  } catch (error) {
    const interruptedMutation = activePublication?.mutation ?? false;
    if (activePublication) {
      recordPublication({
        markdown: activePublication.markdown,
        reportPath: activePublication.reportPath,
        number: activePublication.number,
        status: actionLedgerFailureDisposition(error).status,
        reasonCode: actionLedgerFailureDisposition(error).reasonCode,
        mutation: interruptedMutation,
        destination: activePublication.destination,
      });
      activePublication = null;
    }
    finishPublication(error, interruptedMutation);
    throw error;
  }
}

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

function markdownAuditRecord(
  location: AuditRecordLocation,
  dir: string,
  file: string,
): AuditRecord {
  const path = join(dir, file);
  const markdown = readFileSync(path, "utf8");
  const repo = markdownRepository(markdown, file);
  return {
    repo,
    number: numberForMarkdownFile(file),
    location,
    path: repoRelativePath(path),
    kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
    title: frontMatterValue(markdown, "title") ?? "",
    labels: frontMatterStringArray(markdown, "labels"),
    decision: frontMatterValue(markdown, "decision"),
    closeReason: frontMatterValue(markdown, "close_reason"),
    confidence: frontMatterValue(markdown, "confidence"),
    reviewedAt: frontMatterValue(markdown, "reviewed_at"),
    action: frontMatterValue(markdown, "action_taken"),
    reviewStatus: effectiveReviewStatus(markdown),
    currentState: frontMatterValue(markdown, "current_state"),
  };
}

function auditRecords(location: AuditRecordLocation, dir: string): AuditRecord[] {
  return markdownFiles(dir)
    .map((file) => markdownAuditRecord(location, dir, file))
    .filter((record) => record.repo === targetRepo());
}

const auditEngine = createAuditEngine({
  applyBlockingProtectedLabels,
  displayTitle,
  formatTimestamp,
  isMaintainerAuthored,
  isProtectedItem,
  itemUrlFor,
  markdownLink,
  profileAuditEnd,
  profileAuditStart,
  repoUrlFor,
  shouldPlanItem,
  targetProfile,
  targetRepo,
});
export const { auditFromSnapshot, auditHasStrictFailures, auditHealthSection } = auditEngine;
const { limitAuditFindings } = auditEngine;

function currentAuditHealthSection(readme: string, profile = targetProfile()): string {
  const profileMatch = readme.match(
    new RegExp(
      `### Audit Health\\n\\n${escapeRegExp(profileAuditStart(profile))}[\\s\\S]*?${escapeRegExp(profileAuditEnd(profile))}`,
    ),
  );
  if (profileMatch?.[0]) return profileMatch[0];
  return withTargetProfile(profile, () => auditHealthSection(null));
}

function updateAuditHealthDashboard(result: AuditResult): void {
  const profile = repositoryProfileFor(result.targetRepo);
  const outputPath = auditStatePath(profile);
  ensureDir(dirname(outputPath));
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function markReconciledState(
  markdown: string,
  state: "open" | "closed",
  options: { closedAt?: string | null | undefined } = {},
): string {
  let nextMarkdown = replaceFrontMatterValue(markdown, "current_state", state);
  nextMarkdown = replaceFrontMatterValue(nextMarkdown, "reconciled_at", new Date().toISOString());
  if (state === "closed" && options.closedAt) {
    nextMarkdown = replaceFrontMatterValue(
      nextMarkdown,
      "current_item_closed_at",
      options.closedAt,
    );
  }
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
  plansDir?: string;
  decisionPacketsDir?: string;
  canonicalBaselineDir?: string;
  repositorySlug?: string;
  maxPages?: number;
  dryRun?: boolean;
  fetchClosedAt?: boolean;
  preserveItemNumbers?: readonly number[];
}): ReconcileResult {
  const maxPages = options.maxPages ?? 250;
  const dryRun = options.dryRun ?? false;
  const fetchClosedAt = options.fetchClosedAt ?? true;
  const plansDir = options.plansDir ?? defaultPlansDir();
  if (options.canonicalBaselineDir && !options.repositorySlug) {
    throw new Error("canonical reconciliation baseline requires a repository slug");
  }
  const capturedBaselines = new Set<number>();
  const captureCanonicalBaseline = (number: number, file: string): void => {
    if (
      dryRun ||
      !options.canonicalBaselineDir ||
      !options.repositorySlug ||
      capturedBaselines.has(number)
    ) {
      return;
    }
    const packetName = `${number}.json`;
    captureCanonicalRecordBaseline({
      baselineRoot: options.canonicalBaselineDir,
      repositorySlug: options.repositorySlug,
      itemNumber: number,
      sources: [
        { section: "items" as const, name: file, path: join(options.itemsDir, file) },
        { section: "closed" as const, name: file, path: join(options.closedDir, file) },
        { section: "plans" as const, name: file, path: join(plansDir, file) },
        ...(options.decisionPacketsDir
          ? [
              {
                section: "decision-packets" as const,
                name: packetName,
                path: join(options.decisionPacketsDir, packetName),
              },
            ]
          : []),
      ],
    });
    capturedBaselines.add(number);
  };
  const syncReconciledDecisionPacket = (
    markdown: string,
    reportPath: string,
    subjectState: DecisionPacketSubjectState,
  ): string => {
    if (dryRun || !options.decisionPacketsDir) return markdown;
    return syncDecisionPacketRecord({
      markdown,
      reportPath,
      packetsDir: options.decisionPacketsDir,
      repoRoot: ROOT,
      subjectState,
    }).markdown;
  };
  ensureDir(options.itemsDir);
  ensureDir(options.closedDir);
  const { numbers: openNumbers, pagesScanned } = fetchOpenItemNumbers(maxPages);
  for (const number of options.preserveItemNumbers ?? []) {
    const { state } = fetchItem(number);
    if (state === "open") openNumbers.add(number);
  }
  let movedToClosed = 0;
  let movedToItems = 0;
  let removedStaleClosedCopies = 0;
  let fetchedClosedAt = 0;
  const changedItemNumbers = new Set<number>();
  const changedRecordFiles = new Set<string>();
  const markRecordChanged = (number: number, file: string): void => {
    changedItemNumbers.add(number);
    changedRecordFiles.add(file);
  };

  const cleanAlreadyClosedSidecars = (
    number: number,
    file: string,
    reportPath: string,
    markdown: string,
  ): void => {
    const planPath = workPlanPathForReport(reportPath, plansDir);
    let changed = existsSync(planPath);
    let nextMarkdown = markdown;

    const packetPath = options.decisionPacketsDir
      ? join(options.decisionPacketsDir, `${number}.json`)
      : undefined;
    const packetReference = frontMatterValue(markdown, "decision_packet_path");
    const packetSha = frontMatterValue(markdown, "decision_packet_sha256");
    const hasPacketReference = (value: string | undefined): boolean =>
      Boolean(value && value !== "none" && value !== "unknown");
    const shouldSyncPacket = Boolean(
      packetPath &&
      (existsSync(packetPath) ||
        hasPacketReference(packetReference) ||
        hasPacketReference(packetSha)),
    );
    if (changed || shouldSyncPacket) captureCanonicalBaseline(number, file);
    if (!dryRun && existsSync(planPath)) unlinkSync(planPath);
    if (shouldSyncPacket && packetPath) {
      if (dryRun) {
        changed = true;
      } else {
        const packetBefore = existsSync(packetPath) ? readFileSync(packetPath, "utf8") : null;
        nextMarkdown = syncReconciledDecisionPacket(markdown, reportPath, "closed");
        const packetAfter = existsSync(packetPath) ? readFileSync(packetPath, "utf8") : null;
        changed ||= nextMarkdown !== markdown || packetAfter !== packetBefore;
      }
    }

    if (changed) {
      if (!dryRun) {
        // Sidecar cleanup is an atomic tuple mutation. Stamp the primary so
        // tuple publication can order this deterministic repair against the
        // hydrated state instead of rejecting equal version vectors.
        writeFileSync(reportPath, markReconciledState(nextMarkdown, "closed"), "utf8");
      }
      markRecordChanged(number, file);
    }
  };

  for (const file of markdownFiles(options.itemsDir)) {
    const number = numberForMarkdownFile(file);
    const sourcePath = join(options.itemsDir, file);
    const sourceMarkdown = readFileSync(sourcePath, "utf8");
    if (!isMarkdownForActiveRepo(sourceMarkdown, file)) continue;
    if (openNumbers.has(number)) continue;
    const destinationPath = join(options.closedDir, file);
    let closedAt: string | null | undefined;
    if (fetchClosedAt) {
      try {
        const fetched = fetchItem(number);
        if (fetched.state !== "open") closedAt = fetched.item.closedAt;
        fetchedClosedAt += 1;
      } catch (error) {
        console.error(
          `[reconcile] failed to fetch closed_at for #${number}; using reconciled_at fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    captureCanonicalBaseline(number, file);
    const markdown = syncReconciledDecisionPacket(
      markReconciledState(sourceMarkdown, "closed", { closedAt }),
      destinationPath,
      "closed",
    );
    moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
    if (!dryRun) {
      const planPath = workPlanPathForReport(sourcePath, plansDir);
      if (existsSync(planPath)) unlinkSync(planPath);
    }
    markRecordChanged(number, file);
    movedToClosed += 1;
  }

  for (const file of markdownFiles(options.closedDir)) {
    const number = numberForMarkdownFile(file);
    const sourcePath = join(options.closedDir, file);
    const sourceMarkdown = readFileSync(sourcePath, "utf8");
    if (!isMarkdownForActiveRepo(sourceMarkdown, file)) continue;
    if (!openNumbers.has(number)) {
      cleanAlreadyClosedSidecars(number, file, sourcePath, sourceMarkdown);
      continue;
    }
    captureCanonicalBaseline(number, file);
    const destinationPath = join(options.itemsDir, file);
    if (existsSync(destinationPath)) {
      if (!dryRun) {
        const destinationMarkdown = readFileSync(destinationPath, "utf8");
        const syncedDestinationMarkdown = syncReconciledDecisionPacket(
          destinationMarkdown,
          destinationPath,
          "open",
        );
        if (syncedDestinationMarkdown !== destinationMarkdown) {
          writeFileSync(destinationPath, syncedDestinationMarkdown, "utf8");
        }
        unlinkSync(sourcePath);
      }
      markRecordChanged(number, file);
      removedStaleClosedCopies += 1;
      continue;
    }
    const markdown = syncReconciledDecisionPacket(
      markReconciledState(sourceMarkdown, "open"),
      destinationPath,
      "open",
    );
    moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
    syncWorkPlanFromReport({ markdown, reportPath: destinationPath, plansDir, dryRun });
    markRecordChanged(number, file);
    movedToItems += 1;
  }

  return {
    openItemsSeen: openNumbers.size,
    pagesScanned,
    movedToClosed,
    movedToItems,
    removedStaleClosedCopies,
    fetchedClosedAt,
    changedItemNumbers: [...changedItemNumbers].sort((left, right) => left - right),
    changedRecordFiles: [...changedRecordFiles].sort(),
  };
}

function reconcileCommand(args: Args): void {
  const profile = repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
  const maxPages = numberArg(args.max_pages, 250);
  const dryRun = boolArg(args.dry_run);
  const fetchClosedAt = !boolArg(args.skip_closed_at);
  const preserveItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const canonicalBaselineDir = stringArg(args.canonical_record_baseline_dir, "").trim();
  const result = reconcileFolders({
    itemsDir,
    closedDir,
    plansDir,
    decisionPacketsDir,
    ...(canonicalBaselineDir
      ? { canonicalBaselineDir: resolve(canonicalBaselineDir), repositorySlug: profile.slug }
      : {}),
    maxPages,
    dryRun,
    fetchClosedAt,
    preserveItemNumbers,
  });
  console.log(JSON.stringify(result, null, 2));
}

function auditCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
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
    return { bucket: "hourlyHotItems", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }
  if (kind === "pull_request") {
    return { bucket: "dailyPullRequests", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }

  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return { bucket: "dailyNewIssues", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
  }

  return {
    bucket: "weeklyOlderIssues",
    cadenceMs: WEEKLY_COVERAGE_REVIEW_DAYS * DAY_MS,
  };
}

function dashboardStats(
  itemsDir: string,
  closedDir = defaultClosedDir(),
  profile = targetProfile(),
): DashboardStats {
  const entries = reportEntriesForDir(itemsDir).filter(
    (entry) => entry.repo === profile.targetRepo,
  );
  const closedEntries = reportEntriesForDir(closedDir).filter(
    (entry) => entry.repo === profile.targetRepo,
  );
  const plansDir = defaultPlansDir(profile);
  const now = Date.now();
  let fresh = 0;
  let proposedClose = 0;
  let closed = 0;
  let failed = 0;
  let stale = 0;
  let workCandidates = 0;
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
  const workQueue: DashboardItem[] = [];
  const recentClosed: DashboardClosedItem[] = [];
  const failedReviewRetryStateDir = defaultFailedReviewRetryStateDir(profile);
  for (const entry of entries) {
    const markdown = dashboardMarkdownWithFailedReviewRetryState(
      entry.markdown,
      entry.number,
      failedReviewRetryStateDir,
    );
    const repo = entry.repo;
    const number = entry.number;
    const reviewedAt = frontMatterValue(markdown, "reviewed_at");
    const reviewStatus = effectiveReviewStatus(markdown);
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const decision = frontMatterValue(markdown, "decision") ?? "unknown";
    const workCandidate = frontMatterValue(markdown, "work_candidate") ?? "none";
    const workPriority = frontMatterValue(markdown, "work_priority") ?? "low";
    const workStatus = frontMatterValue(markdown, "work_status") ?? "none";
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
    if (freshReview && workCandidate === "queue_fix_pr" && workStatus === "candidate") {
      workCandidates += 1;
    }
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
    const dashboardItem = {
      repo,
      number,
      kind,
      title: frontMatterValue(markdown, "title") ?? "",
      reviewedAt,
      decision,
      action,
      reviewStatus,
      reportPath: repoRelativePath(entry.path),
      planPath: existsSync(join(plansDir, entry.name))
        ? repoRelativePath(join(plansDir, entry.name))
        : undefined,
      workCandidate,
      workPriority,
      workStatus,
    };
    recent.push(dashboardItem);
    if (freshReview && workCandidate === "queue_fix_pr" && workStatus === "candidate") {
      workQueue.push(dashboardItem);
    }
  }
  for (const entry of closedEntries) {
    const markdown = dashboardMarkdownWithFailedReviewRetryState(
      entry.markdown,
      entry.number,
      failedReviewRetryStateDir,
    );
    const repo = entry.repo;
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const closedAt = dashboardClosedAt(markdown);
    if (action === "closed") {
      closed += 1;
    }
    if (closedAt) {
      recentClosed.push({
        repo,
        number: entry.number,
        kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
        title: frontMatterValue(markdown, "title") ?? "",
        closedAt,
        appliedAt: frontMatterValue(markdown, "applied_at"),
        closeReason: dashboardCloseReason(markdown),
        reportPath: repoRelativePath(entry.path),
      });
    }
    recordDashboardActivity(markdown, activity, now);
  }
  recent.sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
  workQueue.sort(
    (a, b) =>
      workPriorityScore(b.workPriority) - workPriorityScore(a.workPriority) ||
      Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""),
  );
  recentClosed.sort(
    (a, b) =>
      (timestampMs(b.closedAt ?? b.appliedAt) ?? Number.NEGATIVE_INFINITY) -
        (timestampMs(a.closedAt ?? a.appliedAt) ?? Number.NEGATIVE_INFINITY) || b.number - a.number,
  );
  const open = fetchDashboardOpenItemCounts(profile, {
    issues: byKind.issue.total,
    pullRequests: byKind.pull_request.total,
    total: byKind.issue.total + byKind.pull_request.total,
  });
  const hourly = emptyDashboardCadenceBucket();
  const daily = emptyDashboardCadenceBucket();
  addDashboardCadenceBucket(daily, hourlyHotItems);
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
    files: entries.length,
    proposedClose,
    closed,
    archivedFiles: closedEntries.length,
    failed,
    stale,
    workCandidates,
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
    workQueue,
    recentClosed,
  };
}

const dashboardPresentation = createDashboardPresentation({
  closeReasonText,
  displayTitle,
  emptyDashboardActivityStats,
  formatActivityRow,
  formatCadenceBucket,
  formatOperationActivityRow,
  formatPercent,
  formatStatusNumber,
  formatTimestamp,
  frontMatterValue,
  itemUrlFor,
  latestTimestamp,
  markdownLink,
  repoUrlFor,
  reportFileUrl,
  targetRepo,
  timestampMs,
});
export const { dashboardClosedAt, formatRecentClosedRows } = dashboardPresentation;
const {
  dashboardCloseReason,
  jsonFrontMatterValue,
  renderDashboard,
  workPriorityScore,
  workStatusForDecision,
} = dashboardPresentation;

function fetchDashboardOpenItemCounts(
  profile: RepositoryProfile,
  fallback: OpenItemCounts,
): OpenItemCounts {
  try {
    return withTargetProfile(profile, () => fetchOpenItemCounts());
  } catch (error) {
    console.error(
      `[dashboard] failed to fetch open item counts for ${profile.targetRepo}; using local record counts: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

function buildRepoDashboardSnapshot(
  profile: RepositoryProfile,
  readme: string,
  options: { itemsDir?: string; closedDir?: string } = {},
): RepoDashboardSnapshot {
  const stats = withTargetProfile(profile, () =>
    dashboardStats(
      options.itemsDir ?? defaultItemsDir(profile),
      options.closedDir ?? defaultClosedDir(profile),
      profile,
    ),
  );
  const status = currentWorkflowStatusBlock(readme, profile);
  return {
    profile,
    stats,
    status,
    statusSummary: workflowStatusSummary(status),
    auditHealth: currentAuditHealthSection(readme, profile),
  };
}

function dashboardSnapshots(
  readme: string,
  itemsDir: string,
  closedDir: string,
): RepoDashboardSnapshot[] {
  const scopedDirs = itemsDir !== defaultItemsDir() || closedDir !== defaultClosedDir();
  if (scopedDirs) {
    return [buildRepoDashboardSnapshot(targetProfile(), readme, { itemsDir, closedDir })];
  }
  return REPOSITORY_PROFILES.map((profile) => buildRepoDashboardSnapshot(profile, readme));
}

function updateDashboard(itemsDir = defaultItemsDir(), closedDir = defaultClosedDir()): void {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const dashboard = renderDashboard(dashboardSnapshots(readme, itemsDir, closedDir));
  const updated = readme.replace(
    /## Dashboard[\s\S]*?## How It Works/,
    `${dashboard}\n\n## How It Works`,
  );
  writeFileSync(readmePath, updated, "utf8");
}

function statusCommand(args: Args): void {
  const profile = repoFromArgs(args);
  const state = stringArg(args.state, "Working");
  const detail = stringArg(args.detail, "Workflow is running.");
  const runUrl = stringArg(args.run_url, "");
  const plannedCount = optionalNumberArg(args.planned_count);
  const plannedCapacity = optionalNumberArg(args.planned_capacity);
  const plannedShards = optionalNumberArg(args.planned_shards);
  const activeCodex = optionalNumberArg(args.active_codex);
  const dueBacklog = optionalNumberArg(args.due_backlog);
  const oldestUnreviewedAt = stringArg(args.oldest_unreviewed_at, "");
  const capacityReason = stringArg(args.capacity_reason, "");
  const inheritedLabelCleanups = optionalNumberArg(args.inherited_label_cleanups);
  const selfHealConflictRepairs = optionalNumberArg(args.self_heal_conflict_repairs);
  const failedReviewRetries = optionalNumberArg(args.failed_review_retries);
  const failedReviewRetryExhaustions = optionalNumberArg(args.failed_review_retry_exhaustions);
  const botOwnedProofDecisionsRequested = optionalNumberArg(
    args.bot_owned_proof_decisions_requested,
  );
  const botOwnedProofDispatches = optionalNumberArg(args.bot_owned_proof_dispatches);
  const applyHealthArg = applyHealthStatusArg(args);
  const applyHealth =
    applyHealthArg === undefined && state.startsWith("Apply ") ? null : applyHealthArg;
  const statusOptions: Parameters<typeof writeSweepStatus>[0] = {
    state,
    detail,
    profile,
  };
  if (runUrl) statusOptions.runUrl = runUrl;
  if (plannedCount !== undefined) statusOptions.plannedCount = plannedCount;
  if (plannedCapacity !== undefined) statusOptions.plannedCapacity = plannedCapacity;
  if (plannedShards !== undefined) statusOptions.plannedShards = plannedShards;
  if (activeCodex !== undefined) statusOptions.activeCodex = activeCodex;
  if (dueBacklog !== undefined) statusOptions.dueBacklog = dueBacklog;
  if (oldestUnreviewedAt) statusOptions.oldestUnreviewedAt = oldestUnreviewedAt;
  if (capacityReason) statusOptions.capacityReason = capacityReason;
  if (inheritedLabelCleanups !== undefined)
    statusOptions.inheritedLabelCleanups = inheritedLabelCleanups;
  if (selfHealConflictRepairs !== undefined)
    statusOptions.selfHealConflictRepairs = selfHealConflictRepairs;
  if (failedReviewRetries !== undefined) statusOptions.failedReviewRetries = failedReviewRetries;
  if (failedReviewRetryExhaustions !== undefined)
    statusOptions.failedReviewRetryExhaustions = failedReviewRetryExhaustions;
  if (botOwnedProofDecisionsRequested !== undefined)
    statusOptions.botOwnedProofDecisionsRequested = botOwnedProofDecisionsRequested;
  if (botOwnedProofDispatches !== undefined)
    statusOptions.botOwnedProofDispatches = botOwnedProofDispatches;
  if (applyHealth !== undefined) statusOptions.applyHealth = applyHealth;
  writeSweepStatus(statusOptions);
  console.log(JSON.stringify({ status_path: sweepStatusRelativePath(profile), state, detail }));
}

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
