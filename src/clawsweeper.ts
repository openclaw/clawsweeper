#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { homedir } from "node:os";
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
import {
  codexEnv,
  codexLoginConfig,
  codexModelArgs,
  PUBLIC_CODEX_MODEL,
  redactInternalCodexModel,
} from "./codex-env.js";
import { codexProcessErrorCode, runCodexProcess } from "./codex-process.js";
import {
  codexJsonlFailureDetail,
  codexRetryDelayMs,
  codexTerminalErrorDetail,
  isRetryableCodexErrorMessage,
  isRetryableCodexTransportError,
  isTerminalCodexErrorMessage,
} from "./codex-transient.js";
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
import {
  appendFloorBackfillCandidates,
  compareDueCandidates,
  compareHotIntakeDueCandidates,
  hasReviewPolicyMismatch,
  nextReviewDueAtMs,
  reviewContentCacheHit,
  reviewedAtMs,
  reviewPriority,
  schedulerBucket,
  selectDueCandidates,
  shouldReviewItem,
  shouldStopSaturatedPlanScan,
  type SchedulerDueCandidate,
} from "./scheduler-policy.js";
import {
  isUserFacingCommandError,
  resolveCommand,
  runText,
  UserFacingCommandError,
} from "./command.js";
import {
  commitMetadata,
  dirtyWorktree,
  isolateGitHubConfigDir,
  localReviewAdditionalPrompt,
  scrubGitHubCredentialEnv,
  LOCAL_REVIEW_WEB_SEARCH_CONFIG,
} from "./commit-sweeper.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import { freshExactHeadReviewStartLease } from "./repair/comment-router-core.js";
import {
  AUTOMERGE_LABEL,
  AUTOFIX_LABEL,
  CLOSE_PROTECTED_LABEL_NAMES,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
  PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES,
} from "./repair/exact-review-guard-labels.js";
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
  type PrCloseCoverageProofModelResult,
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
import { escapeRegExp, safeOutputTail, trimMiddle, truncateText } from "./clawsweeper-text.js";
import {
  emptyMaintainerDecision,
  maintainerDecisionBlocksClose,
  maintainerDecisionFromReport,
  parseMaintainerDecision,
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
  type ReviewHistoryCycle,
  type ReviewHistoryLedger,
} from "./review-history.js";
import { trailingHtmlComments } from "./review-comment-markers.js";

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
type ItemKind = "issue" | "pull_request";
type ApplyKind = ItemKind | "all";
type DecisionKind = "close" | "keep_open";
type WorkCandidateKind = "none" | "manual_review" | "queue_fix_pr";
type FailedReviewRetryRevisionKind = "pull_head_sha" | "item_source_revision";
interface FailedReviewRetryRevision {
  kind: FailedReviewRetryRevisionKind;
  value: string;
}
type FailedReviewRetryStatus = "dispatching" | "dispatched" | "dispatch_failed" | "exhausted";
type FailedReviewRetryAction =
  | "dispatched_failed_review_retry"
  | "planned_failed_review_retry"
  | "marked_failed_review_retry_exhausted"
  | "skipped_retry_already_exhausted"
  | "skipped_not_failed_review"
  | "skipped_not_open"
  | "skipped_not_pull_request"
  | "skipped_missing_report_head"
  | "skipped_missing_live_head"
  | "skipped_stale_head"
  | "skipped_missing_report_revision"
  | "skipped_missing_live_revision"
  | "skipped_stale_revision"
  | "skipped_non_infrastructure_failure"
  | "skipped_retry_cooldown"
  | "skipped_retry_exhausted"
  | "skipped_live_fetch_failed"
  | "skipped_dispatch_failed"
  | "skipped_runtime_budget";
type TriagePriority = "P0" | "P1" | "P2" | "P3" | "none";
type ImpactLabelName =
  | "impact:data-loss"
  | "impact:security"
  | "impact:crash-loop"
  | "impact:message-loss"
  | "impact:session-state"
  | "impact:auth-provider"
  | "impact:ux-release-blocker"
  | "impact:ux-friction"
  | "impact:other";
type MergeRiskLabelName =
  | "merge-risk: 🚨 compatibility"
  | "merge-risk: 🚨 message-delivery"
  | "merge-risk: 🚨 session-state"
  | "merge-risk: 🚨 auth-provider"
  | "merge-risk: 🚨 security-boundary"
  | "merge-risk: 🚨 availability"
  | "merge-risk: 🚨 automation"
  | "merge-risk: 🚨 other";
type MaturityLabelName = "maturity:stable";
type MergeRiskOptionCategory = "fix_before_merge" | "accept_risk" | "pause_or_close";
type ReviewLabelName =
  | Exclude<TriagePriority, "none">
  | ImpactLabelName
  | MergeRiskLabelName
  | MaturityLabelName;
type ItemCategory =
  | "bug"
  | "regression"
  | "feature"
  | "skill"
  | "docs"
  | "cleanup"
  | "support"
  | "admin"
  | "security"
  | "unclear";
type ReproductionStatus =
  | "reproduced"
  | "source_reproducible"
  | "not_reproduced"
  | "unclear"
  | "not_applicable";
type OverallCorrectness = "patch is correct" | "patch is incorrect" | "not a patch";
type AgentsPolicyStatusKind =
  | "found_applied"
  | "found_not_applicable"
  | "not_found"
  | "conflict_not_applied"
  | "unreadable_or_unclear";
type SecurityReviewStatus = "cleared" | "needs_attention" | "not_applicable";
type SecurityConcernSeverity = "high" | "medium" | "low";
type RealBehaviorProofStatus =
  | "sufficient"
  | "missing"
  | "mock_only"
  | "insufficient"
  | "not_applicable"
  | "override";
type RealBehaviorProofEvidenceKind =
  | "screenshot"
  | "recording"
  | "terminal"
  | "logs"
  | "live_output"
  | "linked_artifact"
  | "none"
  | "not_applicable";
type PrRatingTier = "S" | "A" | "B" | "C" | "D" | "F" | "NA";
type PrStatusLabelKind =
  | "automerge_armed"
  | "re_review_loop"
  | "actively_grinding"
  | "needs_proof"
  | "needs_maintainer_proof_decision"
  | "waiting_on_author"
  | "ready_for_maintainer_look";
type FeatureShowcaseStatus = "showcase" | "none";
type TelegramVisibleProofStatus = "needed" | "not_needed";
type MantisRecommendationStatus = "recommended" | "not_recommended";
type MantisRecommendationScenario =
  | "none"
  | "telegram_live"
  | "telegram_desktop_proof"
  | "discord_status_reactions"
  | "discord_thread_attachment"
  | "web_ui_chat_proof"
  | "slack_desktop_smoke"
  | "visual_task";
type VisionFitStatus = "aligned" | "rejected" | "unclear" | "not_applicable";
type ImplementationComplexity = "small" | "medium" | "large" | "unclear" | "not_applicable";
type AutoImplementationCandidate = "none" | "strict_bug" | "vision_fit";
type RootCauseRelationship =
  | "canonical"
  | "duplicate"
  | "same_root_cause"
  | "partial_overlap"
  | "adjacent_distinct"
  | "superseded"
  | "fixed_by_candidate"
  | "independent"
  | "security_route"
  | "needs_human";
type CloseReason =
  | "implemented_on_main"
  | "mostly_implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
  | "low_signal_unmergeable_pr"
  | "stalled_unproven_pr"
  | "abandoned_pr"
  | "unconfirmed_product_direction"
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
  | "corrected_stale_canonical_comment"
  | "skipped_comment_auth"
  | "skipped_locked_conversation"
  | "skipped_changed_since_review"
  | "skipped_stale_review_comment_sync"
  | "skipped_open_closing_pr"
  | "skipped_same_author_pair"
  | "skipped_already_closed"
  | "skipped_maintainer_authored"
  | "skipped_protected_label"
  | "skipped_close_exempt_label"
  | "skipped_pr_close_coverage_proof"
  | "retry_pr_close_coverage_proof"
  | "retry_stale_canonical_comment_sync"
  | "skipped_invalid_decision"
  | "skipped_missing_record"
  | "skipped_runtime_budget";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface GitHubUser {
  login?: string;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  author_association?: string;
  user?: GitHubUser;
  labels?: string[];
  pull_request?: unknown;
}

interface Item {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null | undefined;
  author: string;
  authorAssociation: string;
  labels: string[];
  locked?: boolean;
  activeLockReason?: string | null;
}

export interface ReviewStartStatusCommentOptions {
  number: number;
  kind: string;
  title: string;
  headSha?: string;
  startedAt?: string;
  leaseExpiresAt?: string;
  leaseOwner?: string;
  position?: number;
  total?: number;
  shardIndex?: number;
  shardCount?: number;
  purpose?: "review" | "apply";
}

type AcquiredReviewStartLease = {
  owner: string;
  commentId: number;
  headSha: string;
};

type ReviewStartStatusCommentResult =
  | { status: "posted"; lease: AcquiredReviewStartLease }
  | { status: "held"; lease: null };

interface ExistingReview {
  path: string;
  markdown: string;
  reviewedAt: string | undefined;
  itemUpdatedAt: string | undefined;
  reviewCommentSyncedAt: string | undefined;
  labelsSyncedAt: string | undefined;
  decision: string | undefined;
  reviewStatus: string | undefined;
  reviewPolicy: string | undefined;
  contentDigest: string | undefined;
  lastFullReviewAt: string | undefined;
  lastFullReviewDecision: string | undefined;
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

interface LikelyOwner {
  person: string;
  role: string;
  reason: string;
  commits: string[];
  files: string[];
  confidence: Confidence;
}

interface ReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidenceScore: number;
  file: string;
  lineStart: number;
  lineEnd: number;
  lateFinding?: boolean;
}

interface SecurityConcern {
  title: string;
  body: string;
  severity: SecurityConcernSeverity;
  confidenceScore: number;
  file: string | null;
  line: number | null;
}

interface SecurityReview {
  status: SecurityReviewStatus;
  summary: string;
  concerns: SecurityConcern[];
}

interface RealBehaviorProof {
  status: RealBehaviorProofStatus;
  summary: string;
  evidenceKind: RealBehaviorProofEvidenceKind;
  needsContributorAction: boolean;
}

interface PrRating {
  proofTier: PrRatingTier;
  patchTier: PrRatingTier;
  overallTier: PrRatingTier;
  summary: string;
  nextSteps: string[];
}

interface TelegramVisibleProof {
  status: TelegramVisibleProofStatus;
  summary: string;
}

interface MantisRecommendation {
  status: MantisRecommendationStatus;
  scenario: MantisRecommendationScenario;
  reason: string;
  maintainerComment: string;
}

interface FeatureShowcase {
  status: FeatureShowcaseStatus;
  reason: string;
}

interface RootCauseClusterMember {
  ref: string;
  relationship: RootCauseRelationship;
  reason: string;
}

interface RootCauseClusterAssessment {
  confidence: Confidence;
  canonicalRef: string | null;
  currentItemRelationship: RootCauseRelationship;
  summary: string;
  members: RootCauseClusterMember[];
}

interface FixedPullRequest {
  repo: string;
  number: number;
  url: string;
  title: string;
  mergedAt: string | null;
  sha: string | null;
  confidence: Confidence;
  source: string;
}

interface MergeRiskOption {
  title: string;
  body: string;
  category: MergeRiskOptionCategory;
  recommended: boolean;
  automergeInstruction: string;
}

export interface LabelJustification {
  label: string;
  reason: string;
}

interface LabelTransitionJustification {
  action: "add" | "remove";
  label: string;
  reason: string;
}

interface ReviewMetric {
  label: string;
  value: string;
  reason: string;
}

interface ReviewCommentRenderOptions {
  prStatusKind?: PrStatusLabelKind | null;
  previousLabels?: readonly string[];
  hasOpenLinkedPullRequest?: boolean;
  previousReviewCommentBody?: string;
}

interface Decision {
  decision: DecisionKind;
  closeReason: CloseReason;
  confidence: Confidence;
  summary: string;
  changeSummary: string;
  evidence: Evidence[];
  likelyOwners: LikelyOwner[];
  risks: string[];
  bestSolution: string;
  maintainerDecision: MaintainerDecision;
  triagePriority: TriagePriority;
  impactLabels: ImpactLabelName[];
  mergeRiskLabels: MergeRiskLabelName[];
  maturityLabels: MaturityLabelName[];
  mergeRiskOptions: MergeRiskOption[];
  reviewMetrics: ReviewMetric[];
  labelJustifications: LabelJustification[];
  itemCategory: ItemCategory;
  reproductionStatus: ReproductionStatus;
  reproductionConfidence: Confidence;
  requiresNewFeature: boolean;
  requiresNewConfigOption: boolean;
  requiresProductDecision: boolean;
  reproductionAssessment: string;
  solutionAssessment: string;
  visionFit: VisionFitStatus;
  visionFitReason: string;
  visionFitEvidence: string[];
  implementationComplexity: ImplementationComplexity;
  autoImplementationCandidate: AutoImplementationCandidate;
  rootCauseCluster: RootCauseClusterAssessment;
  agentsPolicyStatus: AgentsPolicyStatus;
  reviewFindings: ReviewFinding[];
  securityReview: SecurityReview;
  realBehaviorProof: RealBehaviorProof;
  prRating: PrRating;
  telegramVisibleProof: TelegramVisibleProof;
  mantisRecommendation: MantisRecommendation;
  featureShowcase: FeatureShowcase;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
  codexTerminalFailure?: boolean;
  fixedRelease?: string | null;
  fixedSha?: string | null;
  fixedAt?: string | null;
  fixedPullRequest?: FixedPullRequest | null;
  closeComment: string;
  workCandidate: WorkCandidateKind;
  workConfidence: Confidence;
  workPriority: Confidence;
  workReason: string;
  workPrompt: string;
  workClusterRefs: string[];
  workValidation: string[];
  workLikelyFiles: string[];
}

interface AgentsPolicyStatus {
  found: boolean;
  readFully: boolean;
  applied: boolean;
  status: AgentsPolicyStatusKind;
  summary: string;
}

type GoodFirstIssueHumanLabelState = "removed" | "added" | "unknown";

interface ItemContext {
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  goodFirstIssueHumanLabelState?: GoodFirstIssueHumanLabelState;
  sourceRevision?: string;
  timelineRevision?: string;
  previousClawSweeperReview?: unknown;
  closingPullRequests?: unknown[];
  referencingMergedPullRequests?: unknown[];
  relatedItems?: unknown[];
  pullRequest?: unknown;
  pullFiles?: unknown[];
  pullCommits?: unknown[];
  pullReviewComments?: unknown[];
  pullReviewCommentsRevision?: string;
  counts?: {
    comments: number;
    commentsHydrated?: number;
    commentsTruncated?: boolean;
    commentsIncluded?: number;
    commentsFiltered?: number;
    timeline: number;
    timelineHydrated?: number;
    timelineTruncated?: boolean;
    closingPullRequests?: number;
    referencingMergedPullRequests?: number;
    relatedItems?: number;
    pullFiles?: number;
    pullFilesHydrated?: number;
    pullFilesTruncated?: boolean;
    pullCommits?: number;
    pullCommitsHydrated?: number;
    pullCommitsTruncated?: boolean;
    pullReviewComments?: number;
    pullReviewCommentsHydrated?: number;
    pullReviewCommentsTruncated?: boolean;
    pullReviewCommentsIncluded?: number;
    pullReviewCommentsFiltered?: number;
  };
}

interface LocalRelatedTitleEntry {
  number: number;
  kind: ItemKind | undefined;
  title: string;
  url: string | undefined;
  author: string | undefined;
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
  promptChars?: number;
  staticPromptChars?: number;
  contextChars?: number;
  schemaChars?: number;
  additionalPromptChars?: number;
  contextElapsedMs?: number;
  codexElapsedMs?: number;
}

interface ReviewPromptTelemetry {
  promptChars: number;
  staticPromptChars: number;
  contextChars: number;
  schemaChars: number;
  additionalPromptChars: number;
}

interface ReviewPromptBuild {
  text: string;
  telemetry: ReviewPromptTelemetry;
}

interface PreparedMediaProofArtifact {
  url: string;
  downloadedPath: string | null;
  metadataPath: string | null;
  contactSheetPath: string | null;
  status: "prepared" | "failed";
  detail: string;
}

interface PreparedMediaProof {
  manifestPath: string | null;
  summaryPath: string | null;
  artifacts: PreparedMediaProofArtifact[];
}

interface ReviewContextLedgerEntry {
  section: string;
  label: string;
  entries: number;
  chars: number;
  total?: number;
  hydrated?: number;
  truncated?: boolean;
}

interface ReviewPromptRuntimeHints {
  proofScratchDir?: string;
  mediaProofManifestPath?: string;
  mediaProofSummary?: string;
}

interface DashboardItem {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  reviewedAt: string | undefined;
  decision: string;
  action: string;
  reviewStatus: string;
  reportPath: string;
  planPath?: string | undefined;
  workCandidate: string;
  workPriority: string;
  workStatus: string;
}

interface DashboardClosedItem {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  closedAt?: string | undefined;
  appliedAt: string | undefined;
  closeReason: string | undefined;
  reportPath: string;
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
  inheritedLabelCleanups: number;
  selfHealConflictRepairs: number;
  failedReviewRetries: number;
  failedReviewRetryExhaustions: number;
  botOwnedProofDecisionsRequested: number;
  botOwnedProofDispatches: number;
}

interface DashboardActivityStats {
  last15Minutes: DashboardActivityBucket;
  lastHour: DashboardActivityBucket;
  last24Hours: DashboardActivityBucket;
  latestReviewAt: string | undefined;
  latestCloseAt: string | undefined;
  latestCommentSyncAt: string | undefined;
}

interface DashboardStats {
  open: OpenItemCounts;
  fresh: number;
  todo: number;
  files: number;
  proposedClose: number;
  closed: number;
  archivedFiles: number;
  failed: number;
  stale: number;
  workCandidates: number;
  byKind: Record<ItemKind, DashboardKindStats>;
  cadence: DashboardCadenceStats;
  activity: DashboardActivityStats;
  recent: DashboardItem[];
  workQueue: DashboardItem[];
  recentClosed: DashboardClosedItem[];
}

interface WorkflowStatusSummary {
  updatedAt: string | undefined;
  state: string;
  detail: string;
  runUrl: string | undefined;
  applyHealth: Record<string, unknown> | undefined;
  lastCloseApplyHealth: Record<string, unknown> | undefined;
  plannedCount: number | undefined;
  plannedCapacity: number | undefined;
  plannedShards: number | undefined;
  activeCodex: number | undefined;
  dueBacklog: number | undefined;
  oldestUnreviewedAt: string | undefined;
  capacityReason: string | undefined;
  inheritedLabelCleanups: number | undefined;
  selfHealConflictRepairs: number | undefined;
  failedReviewRetries: number | undefined;
  failedReviewRetryExhaustions: number | undefined;
  botOwnedProofDecisionsRequested: number | undefined;
  botOwnedProofDispatches: number | undefined;
}

interface RepoDashboardSnapshot {
  profile: RepositoryProfile;
  stats: DashboardStats;
  status: string;
  statusSummary: WorkflowStatusSummary;
  auditHealth: string;
}

interface PlanShard {
  shard: number;
  itemNumbers: number[];
}

interface PlanCandidateResult {
  shards: PlanShard[];
  scannedPages: number;
  candidates: Item[];
  capacity: number;
  dueBacklog: number;
  activeCodexTarget: number;
  oldestUnreviewedAt: string | undefined;
  capacityReason: string;
  floorBackfill: number;
}

const DEFAULT_PLAN_BATCH_SIZE = 3;
const DEFAULT_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.normal_default;
const MAX_PLAN_SHARD_COUNT = AUTOMATION_LIMITS.review_shards.hard_cap;

type DueCandidate = SchedulerDueCandidate<Item, ExistingReview>;

interface ApplyResult {
  repo?: string;
  number: number;
  action: ActionTaken;
  reason: string;
  durableReviewSynced?: boolean;
  terminalMissingVerified?: boolean;
  terminalStateVerified?: boolean;
  guardedOpenStateVerified?: boolean;
}

interface FailedReviewRetryResult {
  repo?: string | undefined;
  number: number;
  action: FailedReviewRetryAction;
  reason: string;
  headSha?: string | undefined;
  revisionKind?: FailedReviewRetryRevisionKind | undefined;
  revision?: string | undefined;
  attempts?: number | undefined;
  reportPath?: string | undefined;
  dispatchUrl?: string | undefined;
}

interface FailedReviewRetryState {
  schema_version: 1;
  repo: string;
  number: number;
  status: FailedReviewRetryStatus;
  revision_kind: FailedReviewRetryRevisionKind;
  revision: string;
  attempts: number;
  max_attempts: number;
  last_at: string;
  reason: string;
  dispatch_url?: string | undefined;
}

type ProofNudgeAction =
  | "proof_nudge_posted"
  | "proof_nudge_planned"
  | "skipped_not_pull_request"
  | "skipped_not_open"
  | "skipped_policy_exempt"
  | "skipped_stale_report_head"
  | "skipped_recent_author_activity"
  | "skipped_recent_review"
  | "skipped_recent_nudge"
  | "skipped_maintainer_authored"
  | "skipped_bot_authored"
  | "skipped_protected_label"
  | "skipped_locked_conversation"
  | "skipped_no_live_head"
  | "skipped_live_fetch_failed"
  | "skipped_runtime_budget";

type BotProofAction =
  | "bot_proof_mantis_request_posted"
  | "bot_proof_mantis_request_planned"
  | "bot_proof_decision_posted"
  | "bot_proof_decision_planned"
  | "skipped_not_pull_request"
  | "skipped_not_open"
  | "skipped_not_bot_authored"
  | "skipped_draft"
  | "skipped_policy_exempt"
  | "skipped_stale_report_head"
  | "skipped_no_live_head"
  | "skipped_locked_conversation"
  | "skipped_live_fetch_failed"
  | "skipped_runtime_budget";

interface ProofNudgeResult {
  repo?: string | undefined;
  number: number;
  action: ProofNudgeAction;
  reason: string;
  url?: string | undefined;
  headSha?: string | undefined;
  reviewedAt?: string | undefined;
}

interface BotProofResult {
  repo?: string | undefined;
  number: number;
  action: BotProofAction;
  reason: string;
  url?: string | undefined;
  headSha?: string | undefined;
  reviewedAt?: string | undefined;
}

interface ProofLaneCandidate {
  file: string;
  markdown: string;
  number: number;
  likely: boolean;
  reviewedAt?: string | undefined;
  sortAt: number;
}

interface ProofLaneCursor {
  likely: boolean;
  number: number;
  sortAt: number;
}

interface ProofNudgeComment {
  author?: string | undefined;
  body?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

interface ProofNudgeMarker {
  item?: number;
  sha?: string;
  at?: string;
  v?: string;
}

interface ProofNudgeEligibilityOptions {
  item: Pick<
    Item,
    | "kind"
    | "number"
    | "title"
    | "author"
    | "authorAssociation"
    | "updatedAt"
    | "labels"
    | "locked"
    | "activeLockReason"
  >;
  markdown: string;
  comments?: readonly ProofNudgeComment[];
  headSha?: string | undefined;
  headCommittedAt?: string | undefined;
  authorEditedAt?: string | undefined;
  authorReviewActivityAt?: string | undefined;
  now?: number;
  minAgeDays?: number;
  cooldownDays?: number;
}

interface ProofNudgeEligibility {
  eligible: boolean;
  action: Exclude<
    ProofNudgeAction,
    "proof_nudge_posted" | "skipped_not_open" | "skipped_runtime_budget"
  >;
  reason: string;
  latestActivityAt?: string | undefined;
  latestNudgeAt?: string | undefined;
}

interface BotProofEligibilityOptions {
  item: Pick<
    Item,
    "kind" | "number" | "title" | "author" | "labels" | "locked" | "activeLockReason"
  >;
  markdown: string;
  headSha?: string | undefined;
  draft?: boolean | undefined;
}

interface BotProofEligibility {
  eligible: boolean;
  action: Exclude<
    BotProofAction,
    | "bot_proof_mantis_request_posted"
    | "bot_proof_decision_posted"
    | "skipped_not_open"
    | "skipped_runtime_budget"
    | "skipped_live_fetch_failed"
  >;
  reason: string;
  mantisRecommendation?: MantisRecommendation | undefined;
}

interface ProofNudgePullRequestDetails {
  headSha?: string | undefined;
  headRepo?: string | undefined;
  headCommittedAt?: string | undefined;
  draft?: boolean;
}

interface ReconcileResult {
  openItemsSeen: number;
  pagesScanned: number;
  movedToClosed: number;
  movedToItems: number;
  removedStaleClosedCopies: number;
  fetchedClosedAt: number;
  changedItemNumbers: number[];
  changedRecordFiles: string[];
}

type AuditRecordLocation = "items" | "closed";
type MissingOpenReason =
  | "eligible"
  | "maintainer_authored"
  | "protected_label"
  | "recently_created";

interface AuditRecord {
  repo: string;
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
const REPORT_REPO = "openclaw/clawsweeper";
const RECORDS_ROOT = join(ROOT, "records");
let activeRepositoryProfile = repositoryProfileFor(
  process.env.CLAWSWEEPER_TARGET_REPO ?? DEFAULT_TARGET_REPO,
);
const FRESH_DAYS = 7;
const HOT_REVIEW_DAYS = 7;
const RECENT_ISSUE_DAYS = 30;
const DEFAULT_BACKFILL_REVIEW_AGE_MINUTES = 360;
const DAILY_REVIEW_DAYS = 1;
const WEEKLY_REVIEW_DAYS = 7;
const STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS = 60;
const UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS = 14;
const UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS = 7;
const STALLED_UNPROVEN_PR_MIN_AGE_DAYS = 14;
const STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS = 14;
const ABANDONED_PR_MIN_AGE_DAYS = 30;
const ABANDONED_PR_MIN_INACTIVE_DAYS = 30;
const LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MISSING_OPEN_MS = DAY_MS;
const DEFAULT_CODEX_MODEL = PUBLIC_CODEX_MODEL;
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_SERVICE_TIER = "";
const DEFAULT_REVIEW_CODEX_TIMEOUT_MS = 1_200_000;
const DEFAULT_CODEX_FALLBACK_MIN_BUDGET_MS = 120_000;
const REVIEW_POLICY_VERSION = "2026-07-09-policy-v24";
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
const REVIEW_COMMENT_MARKER_PREFIX = "<!-- clawsweeper-review";
const REVIEW_START_STATUS_MARKER_PREFIX = "<!-- clawsweeper-review-status";
const MERGE_READY_LABEL = "clawsweeper:merge-ready";
const PR_AUTO_CLOSE_EXEMPT_LABELS = new Set<string>(PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES);
const WAITING_ON_AUTHOR_LABEL = "status: ⏳ waiting on author";
const PROOF_OVERRIDE_LABEL = "proof: override";
const PROOF_SUFFICIENT_LABEL = "proof: sufficient";
const PROOF_NUDGE_MARKER_PREFIX = "<!-- clawsweeper-proof-nudge";
const PROOF_NUDGE_MARKER_VERSION = "1";
const BOT_PROOF_DECISION_MARKER_PREFIX = "<!-- clawsweeper-bot-proof-decision";
const BOT_PROOF_DECISION_MARKER_VERSION = "1";
const DEFAULT_PROOF_NUDGE_LIMIT = 10;
const DEFAULT_PROOF_NUDGE_MIN_AGE_DAYS = 5;
const DEFAULT_PROOF_NUDGE_COOLDOWN_DAYS = 7;
const PROOF_SUFFICIENT_LABEL_COLOR = "1A7F37";
const PROOF_SUFFICIENT_LABEL_DESCRIPTION = "Contributor real behavior proof is sufficient.";
const FEATURE_SHOWCASE_LABEL = "feature: ✨ showcase";
const FEATURE_SHOWCASE_LABEL_COLOR = "A371F7";
const FEATURE_SHOWCASE_LABEL_DESCRIPTION =
  "ClawSweeper spotlight: unusually compelling feature idea for maintainer attention.";
const PROOF_MEDIA_LABELS = [
  {
    evidenceKind: "screenshot",
    name: "proof: 📸 screenshot",
    color: "0969DA",
    description: "Contributor real behavior proof includes screenshot evidence.",
  },
  {
    evidenceKind: "recording",
    name: "proof: 🎥 video",
    color: "8250DF",
    description: "Contributor real behavior proof includes video or recording evidence.",
  },
] as const satisfies readonly {
  evidenceKind: RealBehaviorProofEvidenceKind;
  name: string;
  color: string;
  description: string;
}[];
const PROOF_MEDIA_LABEL_NAMES = new Set<string>(PROOF_MEDIA_LABELS.map((label) => label.name));
const PR_RATING_LABELS = [
  {
    tier: "S",
    name: "rating: 🦀 challenger crab",
    color: "1F883D",
    description: "Exceptional PR readiness: strong proof, clean patch, and convincing validation.",
  },
  {
    tier: "A",
    name: "rating: 🦞 diamond lobster",
    color: "0969DA",
    description: "Very strong PR readiness with only minor maintainer review expected.",
  },
  {
    tier: "B",
    name: "rating: 🐚 platinum hermit",
    color: "0F766E",
    description: "Good normal PR readiness with ordinary maintainer review expected.",
  },
  {
    tier: "C",
    name: "rating: 🦐 gold shrimp",
    color: "B7791F",
    description: "Decent PR readiness signal, but merge confidence is limited.",
  },
  {
    tier: "D",
    name: "rating: 🦪 silver shellfish",
    color: "7A828E",
    description: "Thin PR readiness signal; proof, validation, or implementation needs work.",
  },
  {
    tier: "F",
    name: "rating: 🧂 unranked krab",
    color: "8C2F39",
    description: "Not merge-ready due to missing proof or serious correctness/safety concerns.",
  },
  {
    tier: "NA",
    name: "rating: 🌊 off-meta tidepool",
    color: "6E7781",
    description: "PR readiness rating does not apply to this item.",
  },
] as const satisfies readonly {
  tier: PrRatingTier;
  name: string;
  color: string;
  description: string;
}[];
const PR_RATING_LABEL_NAMES = new Set<string>(PR_RATING_LABELS.map((label) => label.name));
const PR_STATUS_LABELS = [
  {
    kind: "automerge_armed",
    name: "status: 🚀 automerge armed",
    color: "0E8A16",
    description: "This PR is in ClawSweeper's automerge lane.",
  },
  {
    kind: "re_review_loop",
    name: "status: 🔁 re-review loop",
    color: "8250DF",
    description: "A fresh ClawSweeper review was explicitly requested after the latest review.",
  },
  {
    kind: "actively_grinding",
    name: "status: 🛠️ actively grinding",
    color: "0969DA",
    description: "The PR author has acted after the latest ClawSweeper review and work remains.",
  },
  {
    kind: "needs_proof",
    name: "status: 📣 needs proof",
    color: "D93F0B",
    description:
      "The PR needs real behavior proof before ClawSweeper can clear the contributor ask.",
  },
  {
    kind: "needs_maintainer_proof_decision",
    name: "status: needs maintainer proof decision",
    color: "D93F0B",
    description: "A ClawSweeper-authored PR needs a maintainer proof capture or override decision.",
  },
  {
    kind: "waiting_on_author",
    name: "status: ⏳ waiting on author",
    color: "FBCA04",
    description: "ClawSweeper has contributor-facing work open and is waiting for author action.",
  },
  {
    kind: "ready_for_maintainer_look",
    name: "status: 👀 ready for maintainer look",
    color: "2DA44E",
    description: "ClawSweeper has no concrete contributor-facing blocker left for this PR.",
  },
] as const satisfies readonly {
  kind: PrStatusLabelKind;
  name: string;
  color: string;
  description: string;
}[];
const PR_STATUS_LABEL_NAMES = new Set<string>(PR_STATUS_LABELS.map((label) => label.name));
const TELEGRAM_VISIBLE_PROOF_LABEL = "mantis: telegram-visible-proof";
const TELEGRAM_VISIBLE_PROOF_LABEL_COLOR = "57606A";
const TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION = "Mantis should capture Telegram visible proof.";
const PRIORITY_LABELS = [
  {
    priority: 0,
    triagePriority: "P0",
    name: "P0",
    color: "B60205",
    description: "Emergency: data loss, security bypass, crash loop, or unusable core runtime.",
  },
  {
    priority: 1,
    triagePriority: "P1",
    name: "P1",
    color: "D93F0B",
    description: "Urgent regression or broken agent/channel workflow affecting real users now.",
  },
  {
    priority: 2,
    triagePriority: "P2",
    name: "P2",
    color: "FBCA04",
    description: "Normal priority bug or improvement with limited blast radius.",
  },
  {
    priority: 3,
    triagePriority: "P3",
    name: "P3",
    color: "8C959F",
    description: "Low-risk cleanup, docs, polish, ergonomics, or speculative feature.",
  },
] as const;
const PRIORITY_LABEL_NAMES: ReadonlySet<string> = new Set(
  PRIORITY_LABELS.map((label) => label.name),
);
const IMPACT_LABELS = [
  {
    name: "impact:data-loss",
    color: "B60205",
    description:
      "This issue is about lost, corrupted, or silently dropped user/session/config data.",
  },
  {
    name: "impact:security",
    color: "B60205",
    description:
      "This issue is about security boundaries, credentials, authz, sandboxing, or sensitive data.",
  },
  {
    name: "impact:crash-loop",
    color: "D93F0B",
    description:
      "This issue is about crashes, hangs, restart loops, or process-level availability.",
  },
  {
    name: "impact:message-loss",
    color: "D93F0B",
    description: "This issue is about lost, duplicated, misrouted, or suppressed channel messages.",
  },
  {
    name: "impact:session-state",
    color: "F9D65C",
    description: "This issue is about session, memory, transcript, context, or agent state drift.",
  },
  {
    name: "impact:auth-provider",
    color: "F9D65C",
    description:
      "This issue is about auth, provider routing, model choice, or SecretRef resolution.",
  },
  {
    name: "impact:ux-release-blocker",
    color: "B60205",
    description: "A non-technical user is blocked without terminal, logs, config, or support.",
  },
  {
    name: "impact:ux-friction",
    color: "FBCA04",
    description:
      "User-facing flow adds avoidable confusion or support burden without fully blocking progress.",
  },
  {
    name: "impact:other",
    color: "C5DEF5",
    description: "This issue has meaningful maintainer-visible impact outside the owned taxonomy.",
  },
] as const satisfies readonly {
  name: ImpactLabelName;
  color: string;
  description: string;
}[];
const IMPACT_LABEL_NAMES: ReadonlySet<string> = new Set(IMPACT_LABELS.map((label) => label.name));
const MERGE_RISK_LABELS = [
  {
    name: "merge-risk: 🚨 compatibility",
    color: "D1242F",
    description:
      "🚨 Merging this PR could break existing users, config, migrations, defaults, or upgrades.",
  },
  {
    name: "merge-risk: 🚨 message-delivery",
    color: "D1242F",
    description:
      "🚨 Merging this PR could drop, duplicate, misroute, suppress, or wrongly target messages.",
  },
  {
    name: "merge-risk: 🚨 session-state",
    color: "F97316",
    description:
      "🚨 Merging this PR could lose, corrupt, stale, or mis-associate session or agent state.",
  },
  {
    name: "merge-risk: 🚨 auth-provider",
    color: "F97316",
    description:
      "🚨 Merging this PR could break OAuth, tokens, provider routing, model choice, or credentials.",
  },
  {
    name: "merge-risk: 🚨 security-boundary",
    color: "B60205",
    description:
      "🚨 Merging this PR could weaken sandboxing, authorization, credentials, or sensitive data.",
  },
  {
    name: "merge-risk: 🚨 availability",
    color: "D93F0B",
    description:
      "🚨 Merging this PR could cause crashes, hangs, restart loops, stalls, or process outages.",
  },
  {
    name: "merge-risk: 🚨 automation",
    color: "FBCA04",
    description:
      "🚨 Merging this PR could break CI, automerge, proof capture, label sync, or automation.",
  },
  {
    name: "merge-risk: 🚨 other",
    color: "C5DEF5",
    description: "🚨 Merging this PR has meaningful risk outside the owned taxonomy.",
  },
] as const satisfies readonly {
  name: MergeRiskLabelName;
  color: string;
  description: string;
}[];
const MERGE_RISK_LABEL_NAMES: ReadonlySet<string> = new Set(
  MERGE_RISK_LABELS.map((label) => label.name),
);
const MATURITY_LABELS = [
  {
    name: "maturity:stable",
    color: "1F883D",
    description: "Issue affects a taxonomy feature currently scored M4/M5.",
  },
] as const satisfies readonly {
  name: MaturityLabelName;
  color: string;
  description: string;
}[];
const MATURITY_LABEL_NAMES: ReadonlySet<string> = new Set(
  MATURITY_LABELS.map((label) => label.name),
);
const GOOD_FIRST_ISSUE_LABEL = "good first issue";
const GOOD_FIRST_ISSUE_LABEL_DEFINITION = {
  name: GOOD_FIRST_ISSUE_LABEL,
  color: "7057FF",
  description: "Good for newcomers",
} as const;
const ISSUE_ADVISORY_LABELS = [
  {
    name: "issue-rating: 🦀 challenger crab",
    color: "1F883D",
    description:
      "Exceptional issue quality: high-confidence current-main reproduction and actionable evidence.",
  },
  {
    name: "issue-rating: 🦞 diamond lobster",
    color: "0969DA",
    description:
      "Very strong issue quality with high-confidence source-level or clear reproduction.",
  },
  {
    name: "issue-rating: 🐚 platinum hermit",
    color: "0F766E",
    description: "Good issue quality with a plausible reproduction path needing some confirmation.",
  },
  {
    name: "issue-rating: 🦐 gold shrimp",
    color: "B7791F",
    description: "Decent issue quality, but reproduction details are still incomplete.",
  },
  {
    name: "issue-rating: 🦪 silver shellfish",
    color: "7A828E",
    description: "Thin issue quality; more reproduction proof or environment detail is needed.",
  },
  {
    name: "issue-rating: 🧂 unranked krab",
    color: "8C2F39",
    description: "Issue quality is currently too unclear to act on safely.",
  },
  {
    name: "issue-rating: 🌊 off-meta tidepool",
    color: "6E7781",
    description: "Issue quality rating does not apply to this item.",
  },
  {
    name: "clawsweeper:current-main-repro",
    color: "0A3069",
    description: "ClawSweeper found a high-confidence current-main issue reproduction.",
  },
  {
    name: "clawsweeper:source-repro",
    color: "0A3069",
    description: "ClawSweeper found a high-confidence source-level issue reproduction.",
  },
  {
    name: "clawsweeper:not-repro-on-main",
    color: "2DA44E",
    description:
      "ClawSweeper found high-confidence evidence that this issue no longer reproduces on main.",
  },
  {
    name: "clawsweeper:needs-live-repro",
    color: "FBCA04",
    description:
      "ClawSweeper needs live local, crabbox, or manual validation to confirm this issue.",
  },
  {
    name: "clawsweeper:needs-info",
    color: "6E7781",
    description: "ClawSweeper needs more reporter information before it can verify this issue.",
  },
  {
    name: "clawsweeper:linked-pr-open",
    color: "57606A",
    description: "ClawSweeper found an open linked pull request for this issue.",
  },
  {
    name: "clawsweeper:no-new-fix-pr",
    color: "8C959F",
    description: "ClawSweeper does not recommend queueing a new automated fix PR for this issue.",
  },
  {
    name: "clawsweeper:queueable-fix",
    color: "0E8A16",
    description: "ClawSweeper marked this issue as an existing queue_fix_pr work candidate.",
  },
  {
    name: "clawsweeper:fix-shape-clear",
    color: "1A7F37",
    description: "ClawSweeper found a clear likely implementation shape for this issue.",
  },
  {
    name: "clawsweeper:needs-maintainer-review",
    color: "FBCA04",
    description: "ClawSweeper marked this issue as needing maintainer review before automation.",
  },
  {
    name: "clawsweeper:needs-product-decision",
    color: "FBCA04",
    description: "ClawSweeper marked this issue as needing a product or behavior decision.",
  },
  {
    name: "clawsweeper:needs-security-review",
    color: "B60205",
    description: "ClawSweeper marked this issue as needing security-sensitive review.",
  },
] as const;
const ISSUE_ADVISORY_LABEL_NAMES = new Set(
  ISSUE_ADVISORY_LABELS.map((label) => label.name.toLowerCase()),
);
const STALE_LABEL = "stale";
const NO_STALE_LABEL = "no-stale";
const QUEUEABLE_FIX_LABEL = "clawsweeper:queueable-fix";
const ISSUE_STALE_PROTECTION_LABEL = {
  name: NO_STALE_LABEL,
  color: "6E7781",
  description: "Exempts this issue from stale automation.",
} as const;
const PROTECTED_LABELS = new Set<string>(CLOSE_PROTECTED_LABEL_NAMES);
const ALLOWED_REASONS = new Set<CloseReason>([
  "implemented_on_main",
  "mostly_implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "low_signal_unmergeable_pr",
  "stalled_unproven_pr",
  "abandoned_pr",
  "unconfirmed_product_direction",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
]);
const ALL_REASONS = new Set<CloseReason>([...ALLOWED_REASONS, "none"]);
const DECISIONS = new Set<DecisionKind>(["close", "keep_open"]);
const WORK_CANDIDATES = new Set<WorkCandidateKind>(["none", "manual_review", "queue_fix_pr"]);
const VISION_FIT_STATUSES = new Set<VisionFitStatus>([
  "aligned",
  "rejected",
  "unclear",
  "not_applicable",
]);
const IMPLEMENTATION_COMPLEXITIES = new Set<ImplementationComplexity>([
  "small",
  "medium",
  "large",
  "unclear",
  "not_applicable",
]);
const AUTO_IMPLEMENTATION_CANDIDATES = new Set<AutoImplementationCandidate>([
  "none",
  "strict_bug",
  "vision_fit",
]);
const TRIAGE_PRIORITIES = new Set<TriagePriority>(["P0", "P1", "P2", "P3", "none"]);
const ITEM_CATEGORIES = new Set<ItemCategory>([
  "bug",
  "regression",
  "feature",
  "skill",
  "docs",
  "cleanup",
  "support",
  "admin",
  "security",
  "unclear",
]);
const RETRYABLE_CLOSE_SKIP_ACTIONS = new Set<string>([
  "skipped_maintainer_authored",
  "skipped_invalid_decision",
]);
const PAIR_BLOCKED_CLOSE_ACTIONS = new Set<string>([
  "skipped_open_closing_pr",
  "skipped_same_author_pair",
]);
const CLOSED_STATE_PROBE_ACTIONS = new Set<string>([
  "skipped_already_closed",
  "skipped_changed_since_review",
  "skipped_maintainer_authored",
  "skipped_protected_label",
  "skipped_close_exempt_label",
  "skipped_pr_close_coverage_proof",
  "skipped_invalid_decision",
  "skipped_open_closing_pr",
  "skipped_same_author_pair",
  "skipped_locked_conversation",
  "retry_stale_canonical_comment_sync",
]);
const EVENT_GUARDED_OPEN_ACTIONS = new Set<string>([
  "skipped_locked_conversation",
  "skipped_maintainer_authored",
  "skipped_open_closing_pr",
  "skipped_protected_label",
  "skipped_close_exempt_label",
  "skipped_same_author_pair",
]);

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
const REPRODUCTION_STATUSES = new Set<ReproductionStatus>([
  "reproduced",
  "source_reproducible",
  "not_reproduced",
  "unclear",
  "not_applicable",
]);
const SECURITY_REVIEW_STATUSES = new Set<SecurityReviewStatus>([
  "cleared",
  "needs_attention",
  "not_applicable",
]);
const SECURITY_CONCERN_SEVERITIES = new Set<SecurityConcernSeverity>(["high", "medium", "low"]);
const IMPACT_LABEL_VALUES = new Set<ImpactLabelName>(IMPACT_LABELS.map((label) => label.name));
const MERGE_RISK_LABEL_VALUES = new Set<MergeRiskLabelName>(
  MERGE_RISK_LABELS.map((label) => label.name),
);
const MATURITY_LABEL_VALUES = new Set<MaturityLabelName>(
  MATURITY_LABELS.map((label) => label.name),
);
const REVIEW_LABEL_VALUES = new Set<ReviewLabelName>([
  "P0",
  "P1",
  "P2",
  "P3",
  ...IMPACT_LABELS.map((label) => label.name),
  ...MERGE_RISK_LABELS.map((label) => label.name),
  ...MATURITY_LABELS.map((label) => label.name),
]);
const REAL_BEHAVIOR_PROOF_STATUSES = new Set<RealBehaviorProofStatus>([
  "sufficient",
  "missing",
  "mock_only",
  "insufficient",
  "not_applicable",
  "override",
]);
const PR_RATING_TIERS = new Set<PrRatingTier>(["S", "A", "B", "C", "D", "F", "NA"]);
const REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS = new Set<RealBehaviorProofEvidenceKind>([
  "screenshot",
  "recording",
  "terminal",
  "logs",
  "live_output",
  "linked_artifact",
  "none",
  "not_applicable",
]);
const TELEGRAM_VISIBLE_PROOF_STATUSES = new Set<TelegramVisibleProofStatus>([
  "needed",
  "not_needed",
]);
const MANTIS_RECOMMENDATION_STATUSES = new Set<MantisRecommendationStatus>([
  "recommended",
  "not_recommended",
]);
const MANTIS_RECOMMENDATION_SCENARIOS = new Set<MantisRecommendationScenario>([
  "none",
  "telegram_live",
  "telegram_desktop_proof",
  "discord_status_reactions",
  "discord_thread_attachment",
  "web_ui_chat_proof",
  "slack_desktop_smoke",
  "visual_task",
]);
const FEATURE_SHOWCASE_STATUSES = new Set<FeatureShowcaseStatus>(["showcase", "none"]);
const OVERALL_CORRECTNESS_VALUES = new Set<OverallCorrectness>([
  "patch is correct",
  "patch is incorrect",
  "not a patch",
]);

type ReviewArtifactDestination = "items" | "closed" | "skip_closed";
const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);
const AGENTS_POLICY_STATUSES = new Set<AgentsPolicyStatusKind>([
  "found_applied",
  "found_not_applicable",
  "not_found",
  "conflict_not_applied",
  "unreadable_or_unclear",
]);
const MERGE_RISK_OPTION_CATEGORIES = new Set<MergeRiskOptionCategory>([
  "fix_before_merge",
  "accept_risk",
  "pause_or_close",
]);
const ROOT_CAUSE_RELATIONSHIPS = new Set<RootCauseRelationship>([
  "canonical",
  "duplicate",
  "same_root_cause",
  "partial_overlap",
  "adjacent_distinct",
  "superseded",
  "fixed_by_candidate",
  "independent",
  "security_route",
  "needs_human",
]);
const DECISION_SCHEMA_KEYS = new Set([
  "decision",
  "closeReason",
  "confidence",
  "summary",
  "changeSummary",
  "evidence",
  "likelyOwners",
  "risks",
  "bestSolution",
  "maintainerDecision",
  "triagePriority",
  "impactLabels",
  "mergeRiskLabels",
  "maturityLabels",
  "mergeRiskOptions",
  "reviewMetrics",
  "labelJustifications",
  "itemCategory",
  "reproductionStatus",
  "reproductionConfidence",
  "requiresNewFeature",
  "requiresNewConfigOption",
  "requiresProductDecision",
  "reproductionAssessment",
  "solutionAssessment",
  "visionFit",
  "visionFitReason",
  "visionFitEvidence",
  "implementationComplexity",
  "autoImplementationCandidate",
  "rootCauseCluster",
  "agentsPolicyStatus",
  "reviewFindings",
  "securityReview",
  "realBehaviorProof",
  "prRating",
  "telegramVisibleProof",
  "mantisRecommendation",
  "featureShowcase",
  "overallCorrectness",
  "overallConfidenceScore",
  "fixedRelease",
  "fixedSha",
  "fixedAt",
  "closeComment",
  "workCandidate",
  "workConfidence",
  "workPriority",
  "workReason",
  "workPrompt",
  "workClusterRefs",
  "workValidation",
  "workLikelyFiles",
]);
const EVIDENCE_SCHEMA_KEYS = new Set(["label", "detail", "file", "line", "command", "sha"]);
const SECURITY_REVIEW_SCHEMA_KEYS = new Set(["status", "summary", "concerns"]);
const REAL_BEHAVIOR_PROOF_SCHEMA_KEYS = new Set([
  "status",
  "summary",
  "evidenceKind",
  "needsContributorAction",
]);
const PR_RATING_SCHEMA_KEYS = new Set([
  "proofTier",
  "patchTier",
  "overallTier",
  "summary",
  "nextSteps",
]);
const TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS = new Set(["status", "summary"]);
const MANTIS_RECOMMENDATION_SCHEMA_KEYS = new Set([
  "status",
  "scenario",
  "reason",
  "maintainerComment",
]);
const FEATURE_SHOWCASE_SCHEMA_KEYS = new Set(["status", "reason"]);
const ROOT_CAUSE_CLUSTER_SCHEMA_KEYS = new Set([
  "confidence",
  "canonicalRef",
  "currentItemRelationship",
  "summary",
  "members",
]);
const ROOT_CAUSE_CLUSTER_MEMBER_SCHEMA_KEYS = new Set(["ref", "relationship", "reason"]);
const AGENTS_POLICY_STATUS_SCHEMA_KEYS = new Set([
  "found",
  "readFully",
  "applied",
  "status",
  "summary",
]);
const MERGE_RISK_OPTION_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "category",
  "recommended",
  "automergeInstruction",
]);
const REVIEW_METRIC_SCHEMA_KEYS = new Set(["label", "value", "reason"]);
const LABEL_JUSTIFICATION_SCHEMA_KEYS = new Set(["label", "reason"]);
const SECURITY_CONCERN_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "severity",
  "confidenceScore",
  "file",
  "line",
]);
const REVIEW_FINDING_SCHEMA_KEYS = new Set([
  "title",
  "body",
  "priority",
  "confidenceScore",
  "file",
  "lineStart",
  "lineEnd",
  "lateFinding",
]);
const LIKELY_OWNER_SCHEMA_KEYS = new Set([
  "person",
  "role",
  "reason",
  "commits",
  "files",
  "confidence",
]);
const REVIEW_SECTIONS = {
  summary: "Summary",
  changeSummary: "What This Changes",
  bestSolution: "Best Possible Solution",
  maintainerDecision: "Maintainer Decision",
  reproductionAssessment: "Reproduction Assessment",
  solutionAssessment: "Solution Assessment",
  visionFit: "Vision Fit",
  rootCauseCluster: "Root-Cause Cluster",
  reviewFindings: "Review Findings",
  securityReview: "Security Review",
  realBehaviorProof: "Real Behavior Proof",
  prRating: "PR Rating",
  telegramVisibleProof: "Telegram Visible Proof",
  mantisRecommendation: "Mantis Recommendation",
  featureShowcase: "Feature Showcase",
  agentsPolicyStatus: "AGENTS.md Policy Status",
  workCandidate: "Work Candidate",
  repairWorkPrompt: "Repair Work Prompt",
  evidence: "Evidence",
  likelyOwners: "Likely Related People",
  risks: "Risks / Open Questions",
  closeComment: "Close Comment",
} as const;
const PR_CLOSE_COVERAGE_PROOF_SECTION = "PR Close Coverage Proof";

type ReviewSection = keyof typeof REVIEW_SECTIONS;

function targetProfile(): RepositoryProfile {
  return activeRepositoryProfile;
}

function targetRepo(): string {
  return activeRepositoryProfile.targetRepo;
}

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

interface GitHubRuntimeBudget {
  startedAtMs: number;
  maxRuntimeMs: number;
  onYield?: (reason: string, resumeCurrent?: boolean) => void;
  yieldReason?: string;
}

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
    budget?.yieldReason ?? `max runtime ${budget?.maxRuntimeMs ?? 0}ms reached ${phase}`;
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

function gh(args: string[]): string {
  const timeoutMs = githubCommandTimeoutMs();
  if (args[0] === "api") return run("gh", args, { timeoutMs });
  return run("gh", ["--repo", targetRepo(), ...args], { timeoutMs });
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

function ghWithRetry(args: string[], attempts = 12): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return gh(args);
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
      sleepBeforeGitHubRetry(waitMs);
    }
  }
  throw lastError;
}

function ghRawOnceWithCheckpoint(args: string[], onBeforeRun: () => void): string {
  const env = { ...process.env };
  const command = resolveCommand("gh", args, env);
  const timeoutMs = githubCommandTimeoutMs();
  onBeforeRun();
  const result = spawnSync(command.command, command.args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) {
    if (timeoutMs !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw githubRuntimeBudgetError("during GitHub dispatch");
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error([`Command failed: gh ${args.join(" ")}`, stderr].filter(Boolean).join("\n"));
  }
  return (result.stdout ?? "").trim();
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

let reviewPromptTemplateCache: string | undefined;
let reviewDecisionSchemaCache: string | undefined;
let prCloseCoverageProofPromptTemplateCache: string | undefined;

function itemSnapshotHash(item: Item, context: ItemContext): string {
  const snapshotItem = {
    repo: item.repo,
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

function itemSourceRevisionSha256(issue: unknown, comments: unknown[] = []): string {
  const source = asRecord(issue);
  const snapshot = {
    title: sourceRevisionScalar(source.title),
    body: sourceRevisionScalar(source.body),
    labels: revisionLabels(source.labels),
    comments: comments
      .map(asRecord)
      .filter((comment) => !isClawSweeperComment(comment))
      .map((comment) => ({
        id: sourceRevisionScalar(comment.id),
        author: sourceRevisionScalar(login(comment.user) ?? comment.author),
        body: sourceRevisionScalar(comment.body),
        updated_at: sourceRevisionScalar(
          comment.updated_at ?? comment.updatedAt ?? comment.created_at,
        ),
      }))
      .sort((left, right) =>
        `${left.id}:${left.updated_at}`.localeCompare(`${right.id}:${right.updated_at}`),
      ),
  };
  return sha256(JSON.stringify(snapshot));
}

function sourceRevisionScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function revisionLabels(labels: unknown): string[] {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => normalizeLabelName(String(asRecord(label).name ?? label)))
    .filter(Boolean)
    .filter((label) => !isIgnorableSourceRevisionLabel(label))
    .sort();
}

function isIgnorableSourceRevisionLabel(label: string) {
  return (
    isClawSweeperAdvisorySourceRevisionLabel(label) ||
    (label.startsWith("clawsweeper:") &&
      !["clawsweeper:human-review", "clawsweeper:manual-only"].includes(label)) ||
    label === "no-stale" ||
    label === "stale"
  );
}

function isClawSweeperAdvisorySourceRevisionLabel(label: string): boolean {
  return (
    /^(?:status|rating|proof|merge-risk|impact|issue-rating):/.test(label) ||
    /^p[0-3]$/.test(label) ||
    label === "feature: ✨ showcase" ||
    label === GOOD_FIRST_ISSUE_LABEL ||
    label === "mantis: telegram-visible-proof" ||
    label === "triage: needs-real-behavior-proof"
  );
}

export function itemSourceRevisionSha256ForTest(issue: unknown, comments: unknown[] = []): string {
  return itemSourceRevisionSha256(issue, comments);
}

function reviewCommentDigestParts(entries: unknown): unknown {
  if (!Array.isArray(entries)) return null;
  return entries
    .map(asRecord)
    .filter(
      (entry) =>
        typeof entry.author !== "string" ||
        !CLAWSWEEPER_BOT_AUTHORS.has(entry.author.toLowerCase()),
    )
    .map((entry) => {
      const omitted = githubCount(entry.omitted);
      if (omitted !== null) return { omitted };
      return {
        id: entry.id ?? null,
        author: entry.author ?? null,
        authorAssociation: entry.authorAssociation ?? null,
        body: entry.body ?? null,
      };
    });
}

function reviewCommentContentRevision(entries: readonly unknown[]): string {
  return sha256(stableJson(reviewCommentDigestParts(entries)));
}

export function reviewCommentContentRevisionForTest(entries: readonly unknown[]): string {
  return reviewCommentContentRevision(entries);
}

function reviewTimelineDigestParts(entries: unknown): unknown {
  if (!Array.isArray(entries)) return null;
  return entries
    .map(asRecord)
    .filter((entry) => {
      const actor = typeof entry.actor === "string" ? entry.actor.toLowerCase() : "";
      if (actor && CLAWSWEEPER_BOT_AUTHORS.has(actor)) return false;
      const label = typeof entry.label === "string" ? normalizeLabelName(entry.label) : "";
      return !label || !isIgnorableSourceRevisionLabel(label);
    })
    .map((entry) => ({
      id: entry.id ?? null,
      event: entry.event ?? null,
      actor: entry.actor ?? null,
      commitId: entry.commitId ?? null,
      label: entry.label ?? null,
      rename: entry.rename ?? null,
      sourceIssue: entry.sourceIssue ?? null,
    }));
}

function itemContentDigest(item: Item, context: ItemContext, git?: GitInfo): string {
  const isPull = item.kind === "pull_request";
  const pull = asRecord(context.pullRequest);
  const base = asRecord(pull.base);
  const baseSha = typeof base.sha === "string" ? base.sha : null;
  return sha256(
    stableJson({
      kind: item.kind,
      source: context.sourceRevision ?? null,
      timeline: context.timelineRevision ?? reviewTimelineDigestParts(context.timeline),
      relations: {
        closingPullRequests: context.closingPullRequests ?? null,
        referencingMergedPullRequests: context.referencingMergedPullRequests ?? null,
        relatedItems: context.relatedItems ?? null,
      },
      latestRelease: git?.latestRelease
        ? { tagName: git.latestRelease.tagName ?? null, sha: git.latestRelease.sha ?? null }
        : null,
      targetMainSha: isPull ? null : (git?.mainSha ?? null),
      headSha: isPull ? pullHeadShaFromContext(context) : null,
      baseSha: isPull ? baseSha : null,
      pullState: isPull
        ? {
            draft: pull.draft ?? null,
            mergeable: pull.mergeable ?? null,
            mergeableState: pull.mergeableState ?? null,
            additions: pull.additions ?? null,
            deletions: pull.deletions ?? null,
            changedFiles: pull.changedFiles ?? null,
          }
        : null,
      diff: isPull ? (context.pullFiles ?? null) : null,
      commits: isPull ? (context.pullCommits ?? null) : null,
      reviewComments: isPull
        ? (context.pullReviewCommentsRevision ??
          reviewCommentDigestParts(context.pullReviewComments))
        : null,
    }),
  );
}

export function itemContentDigestForTest(item: Item, context: ItemContext, git?: GitInfo): string {
  return itemContentDigest(item, context, git);
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
      targetRepo: targetRepo(),
      repositoryProfile: targetProfile(),
      prompt: reviewPromptTemplate(),
      schema: reviewDecisionSchemaText(),
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

function requireInteger(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Error(`${path} must be an integer`);
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} must be a finite number`);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${path} must be a boolean`);
}

function requireConfidenceScore(value: unknown, path: string): number {
  const score = requireNumber(value, path);
  if (score < 0 || score > 1) throw new Error(`${path} must be between 0 and 1`);
  return score;
}

function requirePriority(value: unknown, path: string): ReviewFinding["priority"] {
  const priority = requireInteger(value, path);
  if (priority === 0 || priority === 1 || priority === 2 || priority === 3) return priority;
  throw new Error(`${path} must be 0, 1, 2, or 3`);
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function requireEnumArray<T extends string>(value: unknown, allowed: Set<T>, path: string): T[] {
  return requireStringArray(value, path).map((entry, index) =>
    requireEnum(entry, allowed, `${path}[${index}]`),
  );
}

function requireImpactLabels(value: unknown): ImpactLabelName[] {
  const labels = requireEnumArray(value, IMPACT_LABEL_VALUES, "decision.impactLabels");
  if (labels.length > 3) throw new Error("decision.impactLabels must contain at most 3 labels");
  if (new Set(labels).size !== labels.length) {
    throw new Error("decision.impactLabels must not contain duplicates");
  }
  return labels;
}

function requireMergeRiskLabels(value: unknown): MergeRiskLabelName[] {
  const labels = requireEnumArray(value, MERGE_RISK_LABEL_VALUES, "decision.mergeRiskLabels");
  if (labels.length > 3) throw new Error("decision.mergeRiskLabels must contain at most 3 labels");
  if (new Set(labels).size !== labels.length) {
    throw new Error("decision.mergeRiskLabels must not contain duplicates");
  }
  return labels;
}

function requireMaturityLabels(value: unknown): MaturityLabelName[] {
  const labels = requireEnumArray(value, MATURITY_LABEL_VALUES, "decision.maturityLabels");
  if (labels.length > 1) throw new Error("decision.maturityLabels must contain at most 1 label");
  return labels;
}

function parseMergeRiskOption(value: unknown, path: string): MergeRiskOption {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, MERGE_RISK_OPTION_SCHEMA_KEYS, path);
  return {
    title: requireString(record.title, `${path}.title`).trim(),
    body: requireString(record.body, `${path}.body`).trim(),
    category: requireEnum(record.category, MERGE_RISK_OPTION_CATEGORIES, `${path}.category`),
    recommended: requireBoolean(record.recommended, `${path}.recommended`),
    automergeInstruction: requireString(
      record.automergeInstruction,
      `${path}.automergeInstruction`,
    ).trim(),
  };
}

function requireMergeRiskOptions(value: unknown): MergeRiskOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("decision.mergeRiskOptions must be an array");
  const options = value.map((entry, index) =>
    parseMergeRiskOption(entry, `decision.mergeRiskOptions[${index}]`),
  );
  if (options.length > 3)
    throw new Error("decision.mergeRiskOptions must contain at most 3 options");
  const recommended = options.filter((option) => option.recommended);
  if (recommended.length > 1) {
    throw new Error("decision.mergeRiskOptions must not contain more than one recommended option");
  }
  for (const [index, option] of options.entries()) {
    if (!option.title)
      throw new Error(`decision.mergeRiskOptions[${index}].title must not be empty`);
    if (!option.body) throw new Error(`decision.mergeRiskOptions[${index}].body must not be empty`);
    if (option.automergeInstruction && option.category !== "fix_before_merge") {
      throw new Error(
        `decision.mergeRiskOptions[${index}].automergeInstruction requires fix_before_merge category`,
      );
    }
    if (option.automergeInstruction && !option.recommended) {
      throw new Error(
        `decision.mergeRiskOptions[${index}].automergeInstruction requires a recommended option`,
      );
    }
  }
  return options;
}

function parseReviewMetric(value: unknown, path: string): ReviewMetric {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, REVIEW_METRIC_SCHEMA_KEYS, path);
  const metric = {
    label: requireString(record.label, `${path}.label`).trim(),
    value: requireString(record.value, `${path}.value`).trim(),
    reason: requireString(record.reason, `${path}.reason`).trim(),
  };
  if (!metric.label) throw new Error(`${path}.label must not be empty`);
  if (!metric.value) throw new Error(`${path}.value must not be empty`);
  if (!metric.reason) throw new Error(`${path}.reason must not be empty`);
  return metric;
}

function requireReviewMetrics(value: unknown): ReviewMetric[] {
  if (!Array.isArray(value)) throw new Error("decision.reviewMetrics must be an array");
  return value.map((entry, index) => parseReviewMetric(entry, `decision.reviewMetrics[${index}]`));
}

function validateMergeRiskOptions(
  decision: Pick<Decision, "mergeRiskLabels" | "mergeRiskOptions">,
): void {
  if (decision.mergeRiskLabels.length === 0 && decision.mergeRiskOptions.length > 0) {
    throw new Error("decision.mergeRiskOptions must be empty when mergeRiskLabels is empty");
  }
  if (decision.mergeRiskLabels.length > 0 && decision.mergeRiskOptions.length === 0) {
    throw new Error(
      "decision.mergeRiskOptions must include 1-3 options when mergeRiskLabels is not empty",
    );
  }
}

function validateMaintainerDecisionOwner(
  decision: Pick<Decision, "maintainerDecision" | "likelyOwners">,
): void {
  if (!decision.maintainerDecision.required) return;
  const selected = decision.maintainerDecision.likelyOwner.person;
  if (!decision.likelyOwners.some((owner) => owner.person === selected)) {
    throw new Error(
      "decision.maintainerDecision.likelyOwner.person must match decision.likelyOwners",
    );
  }
}

function parseLabelJustification(value: unknown, path: string): LabelJustification {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, LABEL_JUSTIFICATION_SCHEMA_KEYS, path);
  const label = requireEnum(record.label, REVIEW_LABEL_VALUES, `${path}.label`);
  const reason = requireString(record.reason, `${path}.reason`).trim();
  if (!reason) throw new Error(`${path}.reason must not be empty`);
  return { label, reason };
}

function requireLabelJustifications(value: unknown): LabelJustification[] {
  if (!Array.isArray(value)) throw new Error("decision.labelJustifications must be an array");
  const justifications = value.map((entry, index) =>
    parseLabelJustification(entry, `decision.labelJustifications[${index}]`),
  );
  const labels = justifications.map((entry) => entry.label);
  if (new Set(labels).size !== labels.length) {
    throw new Error("decision.labelJustifications must not contain duplicate labels");
  }
  return justifications;
}

function selectedReviewLabels(
  decision: Pick<
    Decision,
    "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels"
  >,
): ReviewLabelName[] {
  return [
    ...(decision.triagePriority === "none" ? [] : [decision.triagePriority]),
    ...decision.impactLabels,
    ...decision.mergeRiskLabels,
    ...decision.maturityLabels,
  ];
}

function validateLabelJustifications(
  decision: Pick<
    Decision,
    "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels" | "labelJustifications"
  >,
): void {
  const selected = new Set<string>(selectedReviewLabels(decision));
  const justified = new Set(decision.labelJustifications.map((entry) => entry.label));
  const missing = [...selected].filter((label) => !justified.has(label));
  if (missing.length) {
    throw new Error(`decision.labelJustifications missing selected labels: ${missing.join(", ")}`);
  }
  const extra = [...justified].filter((label) => !selected.has(label));
  if (extra.length) {
    throw new Error(`decision.labelJustifications contains unselected labels: ${extra.join(", ")}`);
  }
}

function isEnvironmentAccessCaveat(value: string): boolean {
  return /(?:GH_TOKEN|GITHUB_TOKEN|authenticated gh|gh (?:was |is )?unavailable|unauthenticated gh|shallow clone|GitHub auth(?:entication)? (?:was |is )?unavailable|could not use authenticated GitHub)/i.test(
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

function parseLikelyOwner(value: unknown, path: string): LikelyOwner {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, LIKELY_OWNER_SCHEMA_KEYS, path);
  return {
    person: requireString(record.person, `${path}.person`),
    role: requireString(record.role, `${path}.role`),
    reason: requireString(record.reason, `${path}.reason`),
    commits: requireStringArray(record.commits, `${path}.commits`),
    files: requireStringArray(record.files, `${path}.files`),
    confidence: requireEnum(record.confidence, CONFIDENCES, `${path}.confidence`),
  };
}

function parseReviewFinding(value: unknown, path: string): ReviewFinding {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, REVIEW_FINDING_SCHEMA_KEYS, path);
  const lineStart = requireInteger(record.lineStart, `${path}.lineStart`);
  const lineEnd = requireInteger(record.lineEnd, `${path}.lineEnd`);
  if (lineStart <= 0) throw new Error(`${path}.lineStart must be positive`);
  if (lineEnd < lineStart) throw new Error(`${path}.lineEnd must be >= lineStart`);
  const finding: ReviewFinding = {
    title: requireString(record.title, `${path}.title`),
    body: requireString(record.body, `${path}.body`),
    priority: requirePriority(record.priority, `${path}.priority`),
    confidenceScore: requireConfidenceScore(record.confidenceScore, `${path}.confidenceScore`),
    file: requireString(record.file, `${path}.file`),
    lineStart,
    lineEnd,
  };
  if (record.lateFinding !== undefined) {
    finding.lateFinding = requireBoolean(record.lateFinding, `${path}.lateFinding`);
  }
  return finding;
}

type DecisionNormalizationItem = Pick<Item, "repo" | "number" | "kind" | "authorAssociation">;
type RootCauseNormalizationItem = Pick<Item, "repo" | "number" | "kind">;

function defaultRootCauseCluster(): RootCauseClusterAssessment {
  return {
    confidence: "low",
    canonicalRef: null,
    currentItemRelationship: "independent",
    summary: "No evidence-backed root-cause cluster was established.",
    members: [],
  };
}

const CHANGELOG_ENTRY_REVIEW_PATTERN = /\b(?:changelog\.md|changelog\s+entry|release[- ]?note)\b/i;
const MISSING_CHANGELOG_ACTION_PATTERN =
  /\b(?:add|include|missing|no|lacks?|needs?|requires?|required|without)\b/i;
const CHANGELOG_TOOLING_PATTERN =
  /\b(?:coverage|duplicate|generator|malformed|parser|validation|validator|wrong\s+section)\b/i;

function isOpenClawContributorPullRequest(item: DecisionNormalizationItem | undefined): boolean {
  return (
    item !== undefined &&
    normalizeRepo(item.repo) === DEFAULT_TARGET_REPO &&
    item.kind === "pull_request" &&
    !isMaintainerAuthorAssociation(item.authorAssociation)
  );
}

function isContributorChangelogEntryFinding(
  item: DecisionNormalizationItem | undefined,
  finding: ReviewFinding,
): boolean {
  const text = `${finding.title}\n${finding.body}`;
  return (
    isOpenClawContributorPullRequest(item) &&
    CHANGELOG_ENTRY_REVIEW_PATTERN.test(text) &&
    MISSING_CHANGELOG_ACTION_PATTERN.test(text) &&
    !CHANGELOG_TOOLING_PATTERN.test(text)
  );
}

const CLEAN_OPENCLAW_PR_REVIEW_NEXT_STEP =
  "Continue normal maintainer review; ClawSweeper found no patch-correctness issue.";

function normalizeDecisionForItem(
  decision: Decision,
  item: DecisionNormalizationItem | undefined,
): Decision {
  const reviewFindings = decision.reviewFindings.filter(
    (finding) => !isContributorChangelogEntryFinding(item, finding),
  );
  if (reviewFindings.length === decision.reviewFindings.length) return decision;
  if (reviewFindings.length > 0) return { ...decision, reviewFindings };
  const overallCorrectness =
    decision.overallCorrectness === "patch is incorrect"
      ? "patch is correct"
      : decision.overallCorrectness;

  return {
    ...decision,
    reviewFindings,
    bestSolution: CLEAN_OPENCLAW_PR_REVIEW_NEXT_STEP,
    triagePriority: decision.triagePriority,
    mergeRiskOptions: decision.mergeRiskOptions,
    labelJustifications: decision.labelJustifications,
    overallCorrectness,
    prRating: derivedPrRating({
      isPullRequest: item?.kind === "pull_request",
      proof: decision.realBehaviorProof,
      findings: reviewFindings,
      securityReview: decision.securityReview,
      overallCorrectness,
      overallConfidenceScore: decision.overallConfidenceScore,
    }),
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: "",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
  };
}

function parseSecurityConcern(value: unknown, path: string): SecurityConcern {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, SECURITY_CONCERN_SCHEMA_KEYS, path);
  const line = requireNullableInteger(record.line, `${path}.line`);
  if (line !== null && line <= 0) throw new Error(`${path}.line must be positive`);
  return {
    title: requireString(record.title, `${path}.title`),
    body: requireString(record.body, `${path}.body`),
    severity: requireEnum(record.severity, SECURITY_CONCERN_SEVERITIES, `${path}.severity`),
    confidenceScore: requireConfidenceScore(record.confidenceScore, `${path}.confidenceScore`),
    file: requireNullableString(record.file, `${path}.file`),
    line,
  };
}

function parseSecurityReview(value: unknown, path: string): SecurityReview {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, SECURITY_REVIEW_SCHEMA_KEYS, path);
  const concerns = Array.isArray(record.concerns)
    ? record.concerns.map((entry, index) =>
        parseSecurityConcern(entry, `${path}.concerns[${index}]`),
      )
    : (() => {
        throw new Error(`${path}.concerns must be an array`);
      })();
  return {
    status: requireEnum(record.status, SECURITY_REVIEW_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
    concerns,
  };
}

function parseRealBehaviorProof(value: unknown, path: string): RealBehaviorProof {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, REAL_BEHAVIOR_PROOF_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, REAL_BEHAVIOR_PROOF_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
    evidenceKind: requireEnum(
      record.evidenceKind,
      REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS,
      `${path}.evidenceKind`,
    ),
    needsContributorAction: requireBoolean(
      record.needsContributorAction,
      `${path}.needsContributorAction`,
    ),
  };
}

function parsePrRating(value: unknown, path: string): PrRating {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, PR_RATING_SCHEMA_KEYS, path);
  return normalizePrRating({
    proofTier: requireEnum(record.proofTier, PR_RATING_TIERS, `${path}.proofTier`),
    patchTier: requireEnum(record.patchTier, PR_RATING_TIERS, `${path}.patchTier`),
    overallTier: requireEnum(record.overallTier, PR_RATING_TIERS, `${path}.overallTier`),
    summary: requireString(record.summary, `${path}.summary`),
    nextSteps: requireStringArray(record.nextSteps, `${path}.nextSteps`).slice(0, 3),
  });
}

function parseTelegramVisibleProof(value: unknown, path: string): TelegramVisibleProof {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, TELEGRAM_VISIBLE_PROOF_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, TELEGRAM_VISIBLE_PROOF_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
  };
}

function parseMantisRecommendation(value: unknown, path: string): MantisRecommendation {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, MANTIS_RECOMMENDATION_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, MANTIS_RECOMMENDATION_STATUSES, `${path}.status`),
    scenario: requireEnum(record.scenario, MANTIS_RECOMMENDATION_SCENARIOS, `${path}.scenario`),
    reason: requireString(record.reason, `${path}.reason`),
    maintainerComment: requireString(record.maintainerComment, `${path}.maintainerComment`),
  };
}

function parseFeatureShowcase(value: unknown, path: string): FeatureShowcase {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, FEATURE_SHOWCASE_SCHEMA_KEYS, path);
  return {
    status: requireEnum(record.status, FEATURE_SHOWCASE_STATUSES, `${path}.status`),
    reason: requireString(record.reason, `${path}.reason`),
  };
}

interface ParsedGitHubItemRef {
  repo: string;
  kind: ItemKind;
  number: number;
  url: string;
}

function parseGitHubItemRef(value: string, path: string): ParsedGitHubItemRef {
  const match = value.match(
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/([1-9][0-9]*)$/,
  );
  if (!match) throw new Error(`${path} must be a full GitHub issue or pull request URL`);
  const repo = normalizeRepo(`${match[1]}/${match[2]}`);
  const kind = match[3] === "pull" ? "pull_request" : "issue";
  const number = Number(match[4]);
  return {
    repo,
    kind,
    number,
    url: `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
  };
}

function decisionItemUrl(item: RootCauseNormalizationItem): string {
  const segment = item.kind === "pull_request" ? "pull" : "issues";
  return `https://github.com/${normalizeRepo(item.repo)}/${segment}/${item.number}`;
}

function parseRootCauseClusterMember(value: unknown, path: string): RootCauseClusterMember {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, ROOT_CAUSE_CLUSTER_MEMBER_SCHEMA_KEYS, path);
  const reason = requireString(record.reason, `${path}.reason`).trim();
  if (!reason) throw new Error(`${path}.reason must not be empty`);
  if (reason.length > 300) throw new Error(`${path}.reason must be at most 300 characters`);
  const ref = parseGitHubItemRef(requireString(record.ref, `${path}.ref`), `${path}.ref`).url;
  return {
    ref,
    relationship: requireEnum(
      record.relationship,
      ROOT_CAUSE_RELATIONSHIPS,
      `${path}.relationship`,
    ),
    reason,
  };
}

function parseRootCauseCluster(
  value: unknown,
  path: string,
  item?: RootCauseNormalizationItem,
): RootCauseClusterAssessment {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, ROOT_CAUSE_CLUSTER_SCHEMA_KEYS, path);
  const summary = requireString(record.summary, `${path}.summary`).trim();
  if (!summary) throw new Error(`${path}.summary must not be empty`);
  if (summary.length > 500) throw new Error(`${path}.summary must be at most 500 characters`);
  if (!Array.isArray(record.members)) throw new Error(`${path}.members must be an array`);
  if (record.members.length > 12) throw new Error(`${path}.members must contain at most 12 items`);

  const members = record.members.map((entry, index) =>
    parseRootCauseClusterMember(entry, `${path}.members[${index}]`),
  );
  const parsedMembers = members.map((member, index) => ({
    member,
    parsed: parseGitHubItemRef(member.ref, `${path}.members[${index}].ref`),
  }));
  const seenRefs = new Set<string>();
  for (const { member, parsed } of parsedMembers) {
    if (seenRefs.has(member.ref)) throw new Error(`${path}.members contains duplicate refs`);
    seenRefs.add(member.ref);
    if (item && normalizeRepo(parsed.repo) !== normalizeRepo(item.repo)) {
      throw new Error(`${path}.members must stay within ${item.repo}`);
    }
    if (item && member.ref === decisionItemUrl(item)) {
      throw new Error(`${path}.members must not repeat the current item`);
    }
  }

  const rawCanonicalRef = requireNullableString(record.canonicalRef, `${path}.canonicalRef`);
  const parsedCanonical = rawCanonicalRef
    ? parseGitHubItemRef(rawCanonicalRef, `${path}.canonicalRef`)
    : null;
  const canonicalRef = parsedCanonical?.url ?? null;
  if (item && parsedCanonical && normalizeRepo(parsedCanonical.repo) !== normalizeRepo(item.repo)) {
    throw new Error(`${path}.canonicalRef must stay within ${item.repo}`);
  }
  const currentItemRelationship = requireEnum(
    record.currentItemRelationship,
    ROOT_CAUSE_RELATIONSHIPS,
    `${path}.currentItemRelationship`,
  );
  const canonicalMembers = members.filter((member) => member.relationship === "canonical");
  if (canonicalMembers.length > 1)
    throw new Error(`${path} must have at most one canonical member`);

  const currentUrl = item ? decisionItemUrl(item) : null;
  if (!canonicalRef) {
    if (currentItemRelationship === "canonical" || canonicalMembers.length > 0) {
      throw new Error(`${path}.canonicalRef is required for canonical relationships`);
    }
  } else if (currentItemRelationship === "canonical") {
    if (currentUrl && canonicalRef !== currentUrl) {
      throw new Error(`${path}.canonicalRef must identify the canonical current item`);
    }
    if (canonicalMembers.length > 0) {
      throw new Error(`${path} cannot mark both the current item and a member canonical`);
    }
  } else if (canonicalMembers.length !== 1 || canonicalMembers[0]?.ref !== canonicalRef) {
    throw new Error(`${path}.canonicalRef must identify exactly one canonical member`);
  }

  const requiresCanonical = new Set<RootCauseRelationship>([
    "duplicate",
    "same_root_cause",
    "superseded",
    "fixed_by_candidate",
  ]);
  if (requiresCanonical.has(currentItemRelationship) && !canonicalRef) {
    throw new Error(`${path}.currentItemRelationship requires a canonical ref`);
  }
  if (
    ["independent", "security_route", "needs_human"].includes(currentItemRelationship) &&
    canonicalRef
  ) {
    throw new Error(`${path}.currentItemRelationship cannot claim a canonical ref`);
  }
  for (const { member, parsed } of parsedMembers) {
    if (requiresCanonical.has(member.relationship) && !canonicalRef) {
      throw new Error(`${path} relationship ${member.relationship} requires a canonical ref`);
    }
    if (
      member.relationship === "fixed_by_candidate" &&
      parsed.kind !== "pull_request" &&
      parsedCanonical?.kind !== "pull_request"
    ) {
      throw new Error(`${path} fixed_by_candidate requires the member or canonical ref to be a PR`);
    }
  }
  if (
    currentItemRelationship === "fixed_by_candidate" &&
    item?.kind !== "pull_request" &&
    parsedCanonical?.kind !== "pull_request"
  ) {
    throw new Error(
      `${path}.currentItemRelationship fixed_by_candidate requires the current item or canonical ref to be a PR`,
    );
  }

  return {
    confidence: requireEnum(record.confidence, CONFIDENCES, `${path}.confidence`),
    canonicalRef,
    currentItemRelationship,
    summary,
    members,
  };
}

function parseRootCauseClusterOrDefault(
  value: unknown,
  path: string,
  item?: RootCauseNormalizationItem,
): RootCauseClusterAssessment {
  try {
    return parseRootCauseCluster(value, path, item);
  } catch {
    return defaultRootCauseCluster();
  }
}

function parseAgentsPolicyStatus(value: unknown, path: string): AgentsPolicyStatus {
  const record = requireRecord(value, path);
  rejectUnexpectedKeys(record, AGENTS_POLICY_STATUS_SCHEMA_KEYS, path);
  return {
    found: requireBoolean(record.found, `${path}.found`),
    readFully: requireBoolean(record.readFully, `${path}.readFully`),
    applied: requireBoolean(record.applied, `${path}.applied`),
    status: requireEnum(record.status, AGENTS_POLICY_STATUSES, `${path}.status`),
    summary: requireString(record.summary, `${path}.summary`),
  };
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  throw new Error(`${path} has invalid value`);
}

export function parseDecision(value: unknown, item?: DecisionNormalizationItem): Decision {
  const record = requireRecord(value, "decision");
  rejectUnexpectedKeys(record, DECISION_SCHEMA_KEYS, "decision");
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((entry, index) => parseEvidence(entry, `decision.evidence[${index}]`))
    : (() => {
        throw new Error("decision.evidence must be an array");
      })();
  const likelyOwners = Array.isArray(record.likelyOwners)
    ? record.likelyOwners.map((entry, index) =>
        parseLikelyOwner(entry, `decision.likelyOwners[${index}]`),
      )
    : (() => {
        throw new Error("decision.likelyOwners must be an array");
      })();
  if (likelyOwners.length === 0) throw new Error("decision.likelyOwners must not be empty");
  const reviewFindings = Array.isArray(record.reviewFindings)
    ? record.reviewFindings.map((entry, index) =>
        parseReviewFinding(entry, `decision.reviewFindings[${index}]`),
      )
    : (() => {
        throw new Error("decision.reviewFindings must be an array");
      })();
  const decision: Decision = {
    decision: requireEnum(record.decision, DECISIONS, "decision.decision"),
    closeReason: requireEnum(record.closeReason, ALL_REASONS, "decision.closeReason"),
    confidence: requireEnum(record.confidence, CONFIDENCES, "decision.confidence"),
    summary: requireString(record.summary, "decision.summary"),
    changeSummary: requireString(record.changeSummary, "decision.changeSummary"),
    evidence,
    likelyOwners,
    risks: requireStringArray(record.risks, "decision.risks").filter(
      (risk) => !isEnvironmentAccessCaveat(risk),
    ),
    bestSolution: requireString(record.bestSolution, "decision.bestSolution"),
    maintainerDecision: parseMaintainerDecision(
      record.maintainerDecision,
      "decision.maintainerDecision",
    ),
    triagePriority: requireEnum(
      record.triagePriority,
      TRIAGE_PRIORITIES,
      "decision.triagePriority",
    ),
    impactLabels: requireImpactLabels(record.impactLabels),
    mergeRiskLabels: requireMergeRiskLabels(record.mergeRiskLabels),
    maturityLabels: requireMaturityLabels(record.maturityLabels),
    mergeRiskOptions: requireMergeRiskOptions(record.mergeRiskOptions),
    reviewMetrics: requireReviewMetrics(record.reviewMetrics),
    labelJustifications: requireLabelJustifications(record.labelJustifications),
    itemCategory: requireEnum(record.itemCategory, ITEM_CATEGORIES, "decision.itemCategory"),
    reproductionStatus: requireEnum(
      record.reproductionStatus,
      REPRODUCTION_STATUSES,
      "decision.reproductionStatus",
    ),
    reproductionConfidence: requireEnum(
      record.reproductionConfidence,
      CONFIDENCES,
      "decision.reproductionConfidence",
    ),
    requiresNewFeature: requireBoolean(record.requiresNewFeature, "decision.requiresNewFeature"),
    requiresNewConfigOption: requireBoolean(
      record.requiresNewConfigOption,
      "decision.requiresNewConfigOption",
    ),
    requiresProductDecision: requireBoolean(
      record.requiresProductDecision,
      "decision.requiresProductDecision",
    ),
    reproductionAssessment: requireString(
      record.reproductionAssessment,
      "decision.reproductionAssessment",
    ),
    solutionAssessment: requireString(record.solutionAssessment, "decision.solutionAssessment"),
    visionFit: requireEnum(record.visionFit, VISION_FIT_STATUSES, "decision.visionFit"),
    visionFitReason: requireString(record.visionFitReason, "decision.visionFitReason"),
    visionFitEvidence: requireStringArray(record.visionFitEvidence, "decision.visionFitEvidence"),
    implementationComplexity: requireEnum(
      record.implementationComplexity,
      IMPLEMENTATION_COMPLEXITIES,
      "decision.implementationComplexity",
    ),
    autoImplementationCandidate: requireEnum(
      record.autoImplementationCandidate,
      AUTO_IMPLEMENTATION_CANDIDATES,
      "decision.autoImplementationCandidate",
    ),
    rootCauseCluster: parseRootCauseClusterOrDefault(
      record.rootCauseCluster,
      "decision.rootCauseCluster",
      item,
    ),
    agentsPolicyStatus: parseAgentsPolicyStatus(
      record.agentsPolicyStatus,
      "decision.agentsPolicyStatus",
    ),
    reviewFindings,
    securityReview: parseSecurityReview(record.securityReview, "decision.securityReview"),
    realBehaviorProof: parseRealBehaviorProof(
      record.realBehaviorProof,
      "decision.realBehaviorProof",
    ),
    prRating: parsePrRating(record.prRating, "decision.prRating"),
    telegramVisibleProof: parseTelegramVisibleProof(
      record.telegramVisibleProof,
      "decision.telegramVisibleProof",
    ),
    mantisRecommendation: parseMantisRecommendation(
      record.mantisRecommendation,
      "decision.mantisRecommendation",
    ),
    featureShowcase: parseFeatureShowcase(record.featureShowcase, "decision.featureShowcase"),
    overallCorrectness: requireEnum(
      record.overallCorrectness,
      OVERALL_CORRECTNESS_VALUES,
      "decision.overallCorrectness",
    ),
    overallConfidenceScore: requireConfidenceScore(
      record.overallConfidenceScore,
      "decision.overallConfidenceScore",
    ),
    fixedRelease: requireNullableString(record.fixedRelease, "decision.fixedRelease"),
    fixedSha: requireNullableString(record.fixedSha, "decision.fixedSha"),
    fixedAt: requireNullableString(record.fixedAt, "decision.fixedAt"),
    closeComment: requireString(record.closeComment, "decision.closeComment"),
    workCandidate: requireEnum(record.workCandidate, WORK_CANDIDATES, "decision.workCandidate"),
    workConfidence: requireEnum(record.workConfidence, CONFIDENCES, "decision.workConfidence"),
    workPriority: requireEnum(record.workPriority, CONFIDENCES, "decision.workPriority"),
    workReason: requireString(record.workReason, "decision.workReason"),
    workPrompt: requireString(record.workPrompt, "decision.workPrompt"),
    workClusterRefs: requireStringArray(record.workClusterRefs, "decision.workClusterRefs"),
    workValidation: requireStringArray(record.workValidation, "decision.workValidation"),
    workLikelyFiles: requireStringArray(record.workLikelyFiles, "decision.workLikelyFiles"),
  };
  validateMergeRiskOptions(decision);
  validateMaintainerDecisionOwner(decision);
  validateLabelJustifications(decision);
  return normalizeDecisionForItem(decision, item);
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
  const blocked = protectedLabels(labels);
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

function maintainerAssociatedEntries(entries: readonly unknown[]): unknown[] {
  return entries.filter((entry) =>
    isMaintainerAuthorAssociation(asRecord(entry).author_association),
  );
}

function lowSignalUnmergeablePrConflictBlockReason(pullValue: unknown): string | null {
  const pull = asRecord(pullValue);
  const mergeableState = (
    stringOrUndefined(pull.mergeableState) ??
    stringOrUndefined(pull.mergeable_state) ??
    "unknown"
  ).toLowerCase();
  if (pull.mergeable === false && mergeableState === "dirty") return null;
  const mergeable = typeof pull.mergeable === "boolean" ? String(pull.mergeable) : "unknown";
  return `low_signal_unmergeable_pr requires a live merge conflict; GitHub reports mergeable=${mergeable}, mergeable_state=${mergeableState}`;
}

function githubActivityTimestampMs(value: unknown): number | null {
  const record = asRecord(value);
  for (const candidate of [
    record.updatedAt,
    record.updated_at,
    record.submitted_at,
    record.createdAt,
    record.created_at,
  ]) {
    const timestamp = Date.parse(typeof candidate === "string" ? candidate : "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function githubActivityLogin(value: unknown): string {
  const record = asRecord(value);
  return (
    stringOrUndefined(record.author) ??
    login(record.user) ??
    stringOrUndefined(record.actor) ??
    login(record.actor) ??
    ""
  )
    .trim()
    .toLowerCase();
}

function latestPullRequestAuthorActivityAtMs(options: {
  author: string;
  createdAt: string;
  comments?: readonly unknown[];
  reviews?: readonly unknown[];
  inlineComments?: readonly unknown[];
  timeline?: readonly unknown[];
  headActivityAtMs?: number | null;
}): number | null {
  const author = options.author.trim().toLowerCase();
  if (!author) return null;
  let latest = Date.parse(options.createdAt);
  if (!Number.isFinite(latest)) latest = Number.NEGATIVE_INFINITY;
  const observe = (value: unknown): void => {
    if (githubActivityLogin(value) !== author) return;
    const timestamp = githubActivityTimestampMs(value);
    if (timestamp !== null && timestamp > latest) latest = timestamp;
  };
  options.comments?.forEach(observe);
  options.reviews?.forEach(observe);
  options.inlineComments?.forEach(observe);
  for (const event of options.timeline ?? []) {
    const record = asRecord(event);
    const eventName = stringOrUndefined(record.event) ?? "";
    const commitId = stringOrUndefined(record.commitId) ?? stringOrUndefined(record.commit_id);
    if (
      eventName === "commented" ||
      eventName === "committed" ||
      eventName === "head_ref_force_pushed" ||
      eventName === "head_ref_restored" ||
      Boolean(commitId)
    ) {
      observe(event);
    }
  }
  if (options.headActivityAtMs !== null && options.headActivityAtMs !== undefined) {
    latest = Math.max(latest, options.headActivityAtMs);
  }
  return Number.isFinite(latest) ? latest : null;
}

function lowSignalUnmergeablePrAuthorActivityBlockReason(options: {
  author: string;
  createdAt: string;
  comments?: readonly unknown[];
  reviews?: readonly unknown[];
  inlineComments?: readonly unknown[];
  timeline?: readonly unknown[];
  headActivityAtMs?: number | null;
  staleMinAgeDays: number;
  requireHeadActivityEvidence?: boolean;
  now?: number;
}): string | null {
  if (
    options.requireHeadActivityEvidence &&
    (options.headActivityAtMs === null || options.headActivityAtMs === undefined)
  ) {
    return "low_signal_unmergeable_pr requires dated activity evidence for the current head";
  }
  const latestActivityAtMs = latestPullRequestAuthorActivityAtMs(options);
  if (latestActivityAtMs === null) {
    return "low_signal_unmergeable_pr requires dated author and current-head activity evidence";
  }
  const now = options.now ?? Date.now();
  const configuredInactiveDays = Number.isFinite(options.staleMinAgeDays)
    ? Math.max(0, options.staleMinAgeDays)
    : LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS;
  const minimumInactiveDays = Math.max(
    LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS,
    configuredInactiveDays,
  );
  if (now - latestActivityAtMs <= minimumInactiveDays * DAY_MS) {
    return `low_signal_unmergeable_pr requires ${minimumInactiveDays} days without author comments or head activity`;
  }
  return null;
}

function lowSignalUnmergeablePrApplyBlockReason(
  number: number,
  staleMinAgeDays: number,
): string | null {
  const issue = ghJson<{ assignees?: unknown[] }>([
    "api",
    `repos/${targetRepo()}/issues/${number}`,
    "--jq",
    "{assignees:[.assignees[]? | {login:.login}]}",
  ]);
  if ((issue.assignees ?? []).length > 0) return "assigned PR has maintainer/human signal";

  const pull = ghJson<{
    created_at?: string;
    mergeable?: boolean | null;
    mergeable_state?: string | null;
    requested_reviewers?: unknown[];
    requested_teams?: unknown[];
    user?: GitHubUser;
    head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
  }>(["api", `repos/${targetRepo()}/pulls/${number}`]);
  if ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0) {
    return "requested reviewers or teams indicate active review signal";
  }

  const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
  const maintainerComments = maintainerAssociatedEntries(comments);
  if (maintainerComments.length > 0) return "maintainer issue comment blocks low-signal auto-close";

  const reviews = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`);
  const maintainerReviews = maintainerAssociatedEntries(reviews);
  if (maintainerReviews.length > 0) return "maintainer PR review blocks low-signal auto-close";

  const inlineComments = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`);
  const maintainerInlineComments = maintainerAssociatedEntries(inlineComments);
  if (maintainerInlineComments.length > 0) {
    return "maintainer inline review comment blocks low-signal auto-close";
  }

  const conflictBlock = lowSignalUnmergeablePrConflictBlockReason(pull);
  if (conflictBlock) return conflictBlock;

  const timeline = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`);
  const headActivity = pullRequestHeadActivity(number, pull, timeline);
  return lowSignalUnmergeablePrAuthorActivityBlockReason({
    author: pull.user?.login ?? "",
    createdAt: pull.created_at ?? "",
    comments,
    reviews,
    inlineComments,
    timeline,
    headActivityAtMs: headActivity.headActivityAtMs,
    staleMinAgeDays,
    requireHeadActivityEvidence: true,
  });
}

function lowSignalUnmergeablePrApplyBlockReasonSafe(
  number: number,
  staleMinAgeDays: number,
): string | null {
  try {
    return lowSignalUnmergeablePrApplyBlockReason(number, staleMinAgeDays);
  } catch (error) {
    return `low-signal conflict/activity check failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function unconfirmedProductDirectionApplyBlockReason(
  number: number,
  item: Pick<Item, "createdAt" | "labels">,
  reviewedUpdatedAt: string | undefined,
  reviewedAt: string | undefined,
): string | null {
  if (!unconfirmedProductDirectionCloseEnabled()) {
    return "unconfirmed product-direction apply policy is disabled";
  }
  const ageBlock = unconfirmedProductDirectionAgeSkipReason(item, reviewedUpdatedAt, reviewedAt);
  if (ageBlock) return ageBlock;
  const exemptLabel = item.labels
    .map(normalizeLabelName)
    .find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
  if (exemptLabel) return `${exemptLabel} exempts this PR from product-direction auto-close`;

  const issue = ghJson<{ assignees?: unknown[] }>([
    "api",
    `repos/${targetRepo()}/issues/${number}`,
    "--jq",
    "{assignees:[.assignees[]? | {login:.login}]}",
  ]);
  if ((issue.assignees ?? []).length > 0) return "assigned PR has active human signal";

  const pull = ghJson<{ requested_reviewers?: unknown[]; requested_teams?: unknown[] }>([
    "api",
    `repos/${targetRepo()}/pulls/${number}`,
    "--jq",
    "{requested_reviewers:[.requested_reviewers[]? | {login:.login}],requested_teams:[.requested_teams[]? | {slug:.slug}]}",
  ]);
  if ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0) {
    return "requested reviewers or teams indicate active review signal";
  }

  const maintainerComments = maintainerAssociatedEntries(
    ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`),
  );
  if (maintainerComments.length > 0) return "maintainer issue comment calibrates product direction";

  const maintainerReviews = maintainerAssociatedEntries(
    ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`),
  );
  if (maintainerReviews.length > 0) return "maintainer PR review calibrates product direction";

  const maintainerInlineComments = maintainerAssociatedEntries(
    ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`),
  );
  if (maintainerInlineComments.length > 0) {
    return "maintainer inline review comment calibrates product direction";
  }
  return null;
}

function unconfirmedProductDirectionApplyBlockReasonSafe(
  number: number,
  item: Pick<Item, "createdAt" | "labels">,
  reviewedUpdatedAt: string | undefined,
  reviewedAt: string | undefined,
): string | null {
  try {
    return unconfirmedProductDirectionApplyBlockReason(number, item, reviewedUpdatedAt, reviewedAt);
  } catch (error) {
    return `product-direction calibration check failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function pullRequestHumanEngagementBlockReason(number: number): string | null {
  const issue = ghJson<{ assignees?: unknown[] }>([
    "api",
    `repos/${targetRepo()}/issues/${number}`,
    "--jq",
    "{assignees:[.assignees[]? | {login:.login}]}",
  ]);
  if ((issue.assignees ?? []).length > 0) return "assigned PR has active human signal";

  const pull = ghJson<{ requested_reviewers?: unknown[]; requested_teams?: unknown[] }>([
    "api",
    `repos/${targetRepo()}/pulls/${number}`,
    "--jq",
    "{requested_reviewers:[.requested_reviewers[]? | {login:.login}],requested_teams:[.requested_teams[]? | {slug:.slug}]}",
  ]);
  if ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0) {
    return "requested reviewers or teams indicate active review signal";
  }

  const maintainerComments = maintainerAssociatedEntries(
    ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`),
  );
  if (maintainerComments.length > 0) return "maintainer issue comment blocks inactivity auto-close";

  const maintainerReviews = maintainerAssociatedEntries(
    ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`),
  );
  if (maintainerReviews.length > 0) return "maintainer PR review blocks inactivity auto-close";

  const maintainerInlineComments = maintainerAssociatedEntries(
    ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`),
  );
  if (maintainerInlineComments.length > 0) {
    return "maintainer inline review comment blocks inactivity auto-close";
  }
  return null;
}

interface PullRequestLiveActivity {
  draft: boolean;
  headSha: string;
  headActivityAtMs: number | null;
  headChecksFailing: boolean;
}

const FAILING_CHECK_RUN_CONCLUSIONS = new Set(["failure", "timed_out"]);

// Commit dates are author-controlled and a force-push can reuse an old SHA.
// A pull_request workflow run associated with this PR is tied to source
// activity, while rerunning its checks leaves created_at unchanged. Missing
// source-run data keeps the PR open.
function pullRequestHeadActivity(
  number: number,
  pull: {
    created_at?: string;
    head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
  },
  timeline = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`),
): Pick<PullRequestLiveActivity, "headSha" | "headActivityAtMs"> {
  const headSha = typeof pull.head?.sha === "string" ? pull.head.sha : "";
  let headActivityAtMs: number | null = null;
  const observe = (value: unknown): void => {
    const ms = Date.parse(typeof value === "string" ? value : "");
    if (Number.isFinite(ms) && (headActivityAtMs === null || ms > headActivityAtMs)) {
      headActivityAtMs = ms;
    }
  };
  if (headSha) {
    const sourceRuns = ghJson<{ workflow_runs?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=pull_request&per_page=100`,
    ]);
    for (const run of sourceRuns.workflow_runs ?? []) {
      const record = asRecord(run);
      const directlyAssociated = Array.isArray(record.pull_requests)
        ? record.pull_requests.some((pull) => Number(asRecord(pull).number) === number)
        : false;
      const runRepo = asRecord(record.head_repository);
      const pullCreatedAtMs = Date.parse(pull.created_at ?? "");
      const runCreatedAtMs = Date.parse(
        typeof record.created_at === "string" ? record.created_at : "",
      );
      const sameSourceBranch =
        typeof pull.head?.ref === "string" &&
        record.head_branch === pull.head.ref &&
        ((Number.isFinite(Number(pull.head.repo?.id)) &&
          Number(pull.head.repo?.id) === Number(runRepo.id)) ||
          (typeof pull.head.repo?.full_name === "string" &&
            runRepo.full_name === pull.head.repo.full_name)) &&
        Number.isFinite(pullCreatedAtMs) &&
        Number.isFinite(runCreatedAtMs) &&
        runCreatedAtMs >= pullCreatedAtMs;
      if (record.event === "pull_request" && (directlyAssociated || sameSourceBranch)) {
        observe(record.created_at);
      }
    }
    for (const event of timeline) {
      const record = asRecord(event);
      const commitId = stringOrUndefined(record.commitId) ?? stringOrUndefined(record.commit_id);
      if (record.event === "head_ref_force_pushed" && commitId === headSha) {
        observe(stringOrUndefined(record.createdAt) ?? record.created_at);
      }
    }
  }
  return { headSha, headActivityAtMs };
}

function pullRequestLiveActivity(number: number): PullRequestLiveActivity {
  const pull = ghJson<{
    created_at?: string;
    draft?: boolean;
    head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
  }>(["api", `repos/${targetRepo()}/pulls/${number}`]);
  const { headSha, headActivityAtMs } = pullRequestHeadActivity(number, pull);
  let headChecksFailing = false;
  if (headSha) {
    const combined = ghJson<{ state?: string }>([
      "api",
      `repos/${targetRepo()}/commits/${headSha}/status`,
    ]);
    if (combined.state === "failure" || combined.state === "error") headChecksFailing = true;
    const checks = ghJson<{ check_runs?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/commits/${headSha}/check-runs?per_page=100`,
    ]);
    for (const run of checks.check_runs ?? []) {
      const record = asRecord(run);
      if (
        typeof record.conclusion === "string" &&
        FAILING_CHECK_RUN_CONCLUSIONS.has(record.conclusion)
      ) {
        headChecksFailing = true;
      }
    }
  }
  return { draft: pull.draft === true, headSha, headActivityAtMs, headChecksFailing };
}

function prAutoCloseExemptLabel(labels: readonly string[]): string | undefined {
  return labels.map(normalizeLabelName).find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
}

function prAutoCloseExemptDecisionReason(
  item: Pick<Item, "kind" | "labels">,
  closeReason: CloseReason | undefined,
): string | null {
  if (item.kind !== "pull_request") return null;
  const exemptLabel = prAutoCloseExemptLabel(item.labels);
  if (!exemptLabel) return null;
  if (closeReason === "unconfirmed_product_direction") {
    return `${exemptLabel} exempts this PR from product-direction auto-close`;
  }
  if (closeReason === "stalled_unproven_pr") {
    return `${exemptLabel} exempts this PR from stalled-unproven auto-close`;
  }
  if (closeReason === "abandoned_pr") {
    return `${exemptLabel} exempts this PR from abandoned-PR auto-close`;
  }
  return null;
}

export function stalledUnprovenPrAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, STALLED_UNPROVEN_PR_MIN_AGE_DAYS, now)) {
    return `stalled_unproven_pr requires PR older than ${STALLED_UNPROVEN_PR_MIN_AGE_DAYS} days`;
  }
  return null;
}

const STALLED_PROOF_REQUEST_LABELS = new Set([
  "triage: needs-real-behavior-proof",
  "status: 📣 needs proof",
]);

// The durable review comment is edited in place, so its created_at cannot
// date the proof ask. Only immutable signals count: needs-proof label
// timeline events and proof-nudge comment creation times.
export function stalledUnprovenProofRequestBlockReason(
  number: number,
  now = Date.now(),
): string | null {
  let earliestRequestAtMs: number | null = null;
  const observe = (value: unknown): void => {
    const ms = Date.parse(typeof value === "string" ? value : "");
    if (Number.isFinite(ms) && (earliestRequestAtMs === null || ms < earliestRequestAtMs)) {
      earliestRequestAtMs = ms;
    }
  };
  for (const event of ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`)) {
    const record = asRecord(event);
    if (record.event !== "labeled") continue;
    const labelName = asRecord(record.label).name;
    if (typeof labelName !== "string") continue;
    if (!STALLED_PROOF_REQUEST_LABELS.has(normalizeLabelName(labelName))) continue;
    observe(record.created_at);
  }
  for (const comment of ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`)) {
    const record = asRecord(comment);
    const body = typeof record.body === "string" ? record.body : "";
    if (!body.includes(PROOF_NUDGE_MARKER_PREFIX)) continue;
    observe(record.created_at);
  }
  if (earliestRequestAtMs === null) {
    return "no visible dated proof request (needs-proof label event or proof nudge) on the live PR";
  }
  if (now - earliestRequestAtMs <= STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS * DAY_MS) {
    return `stalled_unproven_pr requires the proof request to be visible for ${STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS} days`;
  }
  return null;
}

export function abandonedPrAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, ABANDONED_PR_MIN_AGE_DAYS, now)) {
    return `abandoned_pr requires PR older than ${ABANDONED_PR_MIN_AGE_DAYS} days`;
  }
  return null;
}

function stalledUnprovenPrApplyBlockReason(
  number: number,
  item: Pick<Item, "createdAt" | "labels">,
): string | null {
  const ageBlock = stalledUnprovenPrAgeSkipReason(item);
  if (ageBlock) return ageBlock;
  const exemptLabel = prAutoCloseExemptLabel(item.labels);
  if (exemptLabel) return `${exemptLabel} exempts this PR from stalled-unproven auto-close`;
  const proofLabel = item.labels
    .map(normalizeLabelName)
    .find(
      (label) =>
        label === normalizeLabelName(PROOF_SUFFICIENT_LABEL) ||
        label === normalizeLabelName(PROOF_OVERRIDE_LABEL),
    );
  if (proofLabel) return `${proofLabel} marks the requested proof as resolved`;
  const proofRequestBlock = stalledUnprovenProofRequestBlockReason(number);
  if (proofRequestBlock) return proofRequestBlock;
  const activity = pullRequestLiveActivity(number);
  if (activity.draft) return "draft PR is handled by the abandoned-PR policy, not stalled-unproven";
  if (
    activity.headActivityAtMs === null ||
    Date.now() - activity.headActivityAtMs <= STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS * DAY_MS
  ) {
    return `stalled_unproven_pr requires ${STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS} days without source activity on the current head`;
  }
  return pullRequestHumanEngagementBlockReason(number);
}

function stalledUnprovenPrApplyBlockReasonSafe(
  number: number,
  item: Pick<Item, "createdAt" | "labels">,
): string | null {
  try {
    return stalledUnprovenPrApplyBlockReason(number, item);
  } catch (error) {
    return `stalled-unproven liveness check failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function abandonedPrApplyBlockReason(
  number: number,
  item: Pick<Item, "createdAt" | "labels">,
): string | null {
  const ageBlock = abandonedPrAgeSkipReason(item);
  if (ageBlock) return ageBlock;
  const exemptLabel = prAutoCloseExemptLabel(item.labels);
  if (exemptLabel) return `${exemptLabel} exempts this PR from abandoned-PR auto-close`;
  const activity = pullRequestLiveActivity(number);
  if (
    activity.headActivityAtMs === null ||
    Date.now() - activity.headActivityAtMs <= ABANDONED_PR_MIN_INACTIVE_DAYS * DAY_MS
  ) {
    return `abandoned_pr requires ${ABANDONED_PR_MIN_INACTIVE_DAYS} days without source activity on the current head`;
  }
  const waitingOnAuthor = item.labels
    .map(normalizeLabelName)
    .includes(normalizeLabelName(WAITING_ON_AUTHOR_LABEL));
  const stalledState = activity.draft || waitingOnAuthor || activity.headChecksFailing;
  if (!stalledState) {
    return "live PR is not draft, waiting-on-author, or failing checks; abandonment is not confirmed";
  }
  return pullRequestHumanEngagementBlockReason(number);
}

function abandonedPrApplyBlockReasonSafe(
  number: number,
  item: Pick<Item, "createdAt" | "labels">,
): string | null {
  try {
    return abandonedPrApplyBlockReason(number, item);
  } catch (error) {
    return `abandoned-PR liveness check failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

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

const CLAWSWEEPER_BOT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ].filter((login): login is string => typeof login === "string" && login.length > 0),
);
const CLAWSWEEPER_COMMAND_ONLY_PATTERN = /^@clawsweeper\s+(?:re-review|re-run|review)\s*$/i;

interface PreviousClawSweeperReview {
  status: string;
  reviewedAt: string | null;
  reviewedSha: string | null;
  verdictMarker: string | null;
  actionMarker: string | null;
  summary: string;
  proofStatus: string;
  rating: string;
  nextStep: string;
  findings: Array<{ priority: string; title: string }>;
  earlierReviewCycles: ReviewHistoryCycle[];
  completedReviewCycles: number;
  commentId: unknown;
  commentUrl: unknown;
  commentUpdatedAt: unknown;
}

function rawCommentBody(value: unknown): string {
  const body = asRecord(value).body;
  return typeof body === "string" ? body : "";
}

function timestampValueMs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

function commentTimestampMs(value: unknown): number {
  const comment = asRecord(value);
  return timestampValueMs(comment.updated_at) || timestampValueMs(comment.created_at);
}

function isClawSweeperComment(value: unknown): boolean {
  return CLAWSWEEPER_BOT_AUTHORS.has((login(asRecord(value).user) ?? "").toLowerCase());
}

function isClawSweeperDurableReviewComment(value: unknown, number: number): boolean {
  return (
    isClawSweeperComment(value) &&
    rawCommentBody(value).includes(`${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`)
  );
}

function isClawSweeperNoiseComment(value: unknown, number: number): boolean {
  const body = rawCommentBody(value);
  if (!body.trim() || !isClawSweeperComment(value)) return false;
  if (isClawSweeperDurableReviewComment(value, number)) return true;
  if (/clawsweeper-pr-egg-hatch:/i.test(body)) return true;
  if (/clawsweeper-visual\s+item=/i.test(body)) return true;
  if (/clawsweeper-command(?:-status|-ack)?:/i.test(body)) return true;
  if (/clawsweeper-review-status:/i.test(body)) return true;
  if (/clawsweeper-close-applied\s+item=/i.test(body)) return true;
  if (/clawsweeper-repair:close:/i.test(body)) return true;
  if (/^ClawSweeper status: review started\./i.test(body)) return true;
  return false;
}

function isClawSweeperCommandOnlyComment(value: unknown): boolean {
  return CLAWSWEEPER_COMMAND_ONLY_PATTERN.test(rawCommentBody(value).trim());
}

function shouldIncludeReviewContextComment(value: unknown, number: number): boolean {
  if (isClawSweeperNoiseComment(value, number)) return false;
  if (isClawSweeperCommandOnlyComment(value)) return false;
  return true;
}

function filterReviewContextComments(
  comments: readonly unknown[],
  number: number,
): { included: unknown[]; filtered: number } {
  const included = comments.filter((comment) => shouldIncludeReviewContextComment(comment, number));
  return { included, filtered: comments.length - included.length };
}

function minNonNegative(values: number[]): number {
  const candidates = values.filter((value) => value >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

function markdownSection(body: string, heading: string): string {
  const marker = `**${heading.toLowerCase()}**`;
  const lowerBody = body.toLowerCase();
  const markerIndex = lowerBody.indexOf(marker);
  if (markerIndex < 0) return "";
  const sectionStart = body.indexOf("\n", markerIndex + marker.length);
  if (sectionStart < 0) return "";
  const contentStart = sectionStart + 1;
  const relative = body.slice(contentStart);
  const end = minNonNegative([
    relative.indexOf("\n**"),
    relative.indexOf("\n<details"),
    relative.indexOf("\n<!--"),
  ]);
  return (end < 0 ? relative : relative.slice(0, end)).trim();
}

function firstLineAfterPrefix(body: string, prefix: string): string {
  const lowerBody = body.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  const index = lowerBody.indexOf(lowerPrefix);
  if (index < 0) return "";
  const start = index + prefix.length;
  const end = body.indexOf("\n", start);
  return body.slice(start, end < 0 ? undefined : end).trim();
}

function htmlMarkerWithPrefix(body: string, prefix: string): string | null {
  const lowerPrefix = prefix.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const start = body.indexOf("<!--", searchFrom);
    if (start < 0) return null;
    const end = body.indexOf("-->", start + 4);
    if (end < 0) return null;
    const marker = body.slice(start, end + 3);
    const inner = body
      .slice(start + 4, end)
      .trim()
      .toLowerCase();
    if (inner.startsWith(lowerPrefix)) return marker;
    searchFrom = end + 3;
  }
  return null;
}

function markerAttribute(marker: string | null, name: string): string | null {
  if (!marker) return null;
  const inner = marker.slice(4, -3).trim();
  for (const part of inner.split(/\s+/)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).toLowerCase() === name.toLowerCase()) {
      return part.slice(separator + 1) || null;
    }
  }
  return null;
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function previousReviewStatus(body: string): string {
  const status = firstLineAfterPrefix(body, "Codex review:");
  const reviewedIndex = status.toLowerCase().indexOf("_reviewed ");
  return (reviewedIndex < 0 ? status : status.slice(0, reviewedIndex)).trim();
}

function previousReviewReviewedAt(body: string): string | null {
  const value = firstLineAfterPrefix(body, "**Latest ClawSweeper review:**");
  if (value) return value.replace(/\.$/, "").trim();
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const lowerFirstLine = firstLine.toLowerCase();
  const prefix = "_reviewed ";
  const start = lowerFirstLine.indexOf(prefix);
  if (start < 0) return null;
  const valueStart = start + prefix.length;
  const end = firstLine.indexOf("._", valueStart);
  const inline = firstLine.slice(valueStart, end < 0 ? undefined : end).trim();
  return inline || null;
}

function firstMergeReadinessLine(body: string, prefix: string): string {
  const readiness = markdownSection(body, "Merge readiness");
  if (!readiness) return "";
  const lowerPrefix = prefix.toLowerCase();
  return (
    readiness
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().startsWith(lowerPrefix)) ?? ""
  );
}

function previousReviewRating(body: string): string {
  return (
    firstNonEmptyLine(markdownSection(body, "PR rating")) ||
    firstMergeReadinessLine(body, "Overall:")
  );
}

function previousReviewProofStatus(body: string): string {
  const oldProofStatus = firstNonEmptyLine(markdownSection(body, "Real behavior proof"));
  if (oldProofStatus) return oldProofStatus;
  const readiness = markdownSection(body, "Merge readiness");
  if (!readiness) return "";
  const lines = readiness.split(/\r?\n/);
  const proofGuidanceIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === "proof guidance:",
  );
  if (proofGuidanceIndex >= 0) {
    const guidance = lines
      .slice(proofGuidanceIndex + 1)
      .map((line) => line.trim())
      .find(Boolean);
    if (guidance) return guidance;
  }
  return firstMergeReadinessLine(body, "Proof:");
}

function reviewHistoryFindings(
  cycle: ReviewHistoryCycle | undefined,
): Array<{ priority: string; title: string }> {
  if (!cycle) return [];
  return cycle.findings.flatMap((finding) => {
    const match = finding.match(/^\[(P[0-3])\]\s+(.+)$/);
    return match?.[1] && match[2] ? [{ priority: match[1], title: match[2] }] : [];
  });
}

function extractLatestClawSweeperReview(
  comments: readonly unknown[],
  number: number,
): PreviousClawSweeperReview | null {
  const latest = comments
    .filter((comment) => isClawSweeperDurableReviewComment(comment, number))
    .sort((left, right) => commentTimestampMs(right) - commentTimestampMs(left))[0];
  if (!latest) return null;
  const comment = asRecord(latest);
  const body = rawCommentBody(latest);
  const verdictMarker = htmlMarkerWithPrefix(body, "clawsweeper-verdict:");
  const actionMarker = htmlMarkerWithPrefix(body, "clawsweeper-action:");
  const history = parseReviewHistory(body);
  const currentCycle = reviewHistoryCycleFromCommentBody(body);
  const latestCompletedCycle = currentCycle ?? history.cycles.at(-1);
  const earlierReviewCycles = currentCycle ? history.cycles : history.cycles.slice(0, -1);
  return {
    status: previousReviewStatus(body),
    reviewedAt: previousReviewReviewedAt(body) ?? latestCompletedCycle?.reviewedAt ?? null,
    reviewedSha:
      markerAttribute(verdictMarker, "sha") ??
      markerAttribute(actionMarker, "sha") ??
      latestCompletedCycle?.sha ??
      null,
    verdictMarker,
    actionMarker,
    summary: firstNonEmptyLine(markdownSection(body, "Summary")),
    proofStatus: previousReviewProofStatus(body),
    rating: previousReviewRating(body),
    nextStep:
      firstNonEmptyLine(markdownSection(body, "Next step before merge")) ||
      firstNonEmptyLine(markdownSection(body, "Next step")),
    findings: reviewHistoryFindings(latestCompletedCycle),
    earlierReviewCycles,
    completedReviewCycles: history.totalCompletedCycles + (currentCycle ? 1 : 0),
    commentId: comment.id,
    commentUrl: comment.html_url,
    commentUpdatedAt: comment.updated_at,
  };
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

interface ClosingPullRequestReference {
  repo: string;
  number: number;
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
    const [owner, repo] = targetRepo().split("/");
    const escapedRepo = `${escapeRegExp(owner ?? "")}\\/${escapeRegExp(repo ?? "")}`;
    const linked = value.matchAll(
      new RegExp(
        `github\\.com\\/${escapedRepo}\\/(?:issues|pull)\\/(\\d+)|(?<![\\w/])#(\\d+)\\b`,
        "g",
      ),
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

function compactRelatedItem(number: number, mentionedIn: string[]): Record<string, unknown> | null {
  try {
    const issue = ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]);
    const issueRecord = asRecord(issue);
    const related: Record<string, unknown> = {
      mentionedIn: mentionedIn.slice(0, 6),
      issue: compactIssue(issue),
      commentCount: issueRecord.comments,
    };

    if (issueRecord.pull_request) {
      try {
        related.pullRequest = compactPullRequest(
          ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]),
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

let localRelatedTitleIndexCache: { repo: string; entries: LocalRelatedTitleEntry[] } | null = null;
type GitcrawlClusterSource = "legacy" | "portable";
let gitcrawlClusterSourceCache: { dbPath: string; source: GitcrawlClusterSource | null } | null =
  null;
const RELATED_ITEMS_LIMIT = 12;
const RELATED_GITHUB_SEARCH_LIMIT = 5;
const RELATED_GITCRAWL_LIMIT = 6;
const RELATED_GITHUB_SEARCH_TIMEOUT_MS = 15_000;
// 10 referencing PRs × this limit = 20 KB worst case vs 12 closing PRs × 12 000 = 144 KB
const REFERENCING_PR_BODY_CHARS = 2000;

function compactReferencingMergedPullRequest(candidate: Record<string, unknown>): unknown {
  const pullRequest = asRecord(candidate.pull_request ?? {});
  return {
    number: candidate.number,
    title: candidate.title,
    url: candidate.html_url,
    author: login(candidate.user),
    mergedAt: pullRequest.merged_at,
    body: truncateText(
      typeof candidate.body === "string" ? candidate.body : "",
      REFERENCING_PR_BODY_CHARS,
    ),
  };
}

// Filters and compacts raw search/issues API items to merged-PR shape only.
// Drops rows whose pull_request.merged_at is null — serves as both PR-type and merge-timestamp guard.
export function referencingMergedPullRequestCandidatesForTest(items: unknown[]): unknown[] {
  return referencingMergedPullRequestCandidates(items);
}

function referencingMergedPullRequestCandidates(items: unknown[]): unknown[] {
  return items
    .map(asRecord)
    .filter((candidate) => Boolean(asRecord(candidate.pull_request ?? {}).merged_at))
    .map(compactReferencingMergedPullRequest);
}

function referencingMergedPullRequestsForIssue(number: number): unknown[] {
  if (envFlagDisabled(process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH)) return [];
  const query = `repo:${targetRepo()} is:pr is:merged #${number}`;
  try {
    const response = asRecord(
      ghJsonOnce<unknown>(
        ["api", `search/issues?q=${encodeURIComponent(query)}&per_page=10`],
        RELATED_GITHUB_SEARCH_TIMEOUT_MS,
      ),
    );
    const items = Array.isArray(response.items) ? response.items : [];
    return referencingMergedPullRequestCandidates(items);
  } catch (error) {
    if (error instanceof GitHubRuntimeBudgetError) throw error;
    console.error(
      `[referencingMergedPullRequestsForIssue] number=${number} status=failed reason=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

export function referencingMergedPullRequestsForIssueForTest(number: number): unknown[] {
  return referencingMergedPullRequestsForIssue(number);
}

export function compactReferencingMergedPullRequestForTest(candidate: unknown): unknown {
  return compactReferencingMergedPullRequest(asRecord(candidate));
}

export function relatedTitleSearchTerms(title: string, limit = 6): string[] {
  const seen = new Set<string>();
  return relatedTitleCandidateTerms(title)
    .filter((term) => {
      const normalized = trimEdgeChar(term, "_");
      if (RELATED_TITLE_STOP_WORDS.has(normalized)) return false;
      if (isDigitsOnly(normalized)) return false;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, limit);
}

function relatedTitleCandidateTerms(title: string): string[] {
  const lowerTitle = title.toLowerCase();
  const terms: string[] = [];
  let index = 0;

  while (index < lowerTitle.length) {
    if (!isAsciiAlphaNumeric(lowerTitle[index])) {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < lowerTitle.length && isRelatedTitleTermChar(lowerTitle[index])) {
      index += 1;
    }

    if (index - start >= 3) {
      terms.push(lowerTitle.slice(start, index));
    }
  }

  return terms;
}

function isRelatedTitleTermChar(char: string | undefined): boolean {
  return isAsciiAlphaNumeric(char) || char === "_" || char === "-";
}

function isAsciiAlphaNumeric(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function trimEdgeChar(value: string, char: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === char) start += 1;
  while (end > start && value[end - 1] === char) end -= 1;
  return value.slice(start, end);
}

function isDigitsOnly(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function localRelatedTitleIndex(): LocalRelatedTitleEntry[] {
  if (localRelatedTitleIndexCache?.repo === targetRepo())
    return localRelatedTitleIndexCache.entries;
  const entries: LocalRelatedTitleEntry[] = [];
  for (const [location, dir] of [
    ["items", defaultItemsDir()],
    ["closed", defaultClosedDir()],
  ] as const) {
    for (const file of markdownFiles(dir)) {
      const path = join(dir, file);
      const markdown = readFileSync(path, "utf8");
      if (!isMarkdownForActiveRepo(markdown, file)) continue;
      entries.push({
        number: numberForMarkdownFile(file),
        kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
        title: displayTitle(frontMatterValue(markdown, "title") ?? ""),
        url: frontMatterValue(markdown, "url"),
        author: frontMatterValue(markdown, "author"),
        location,
        path: repoRelativePath(path),
        decision: frontMatterValue(markdown, "decision"),
        closeReason: frontMatterValue(markdown, "close_reason"),
        action: frontMatterValue(markdown, "action_taken"),
        reviewStatus: effectiveReviewStatus(markdown),
        summary: reviewSectionValue(markdown, "summary"),
      });
    }
  }
  localRelatedTitleIndexCache = { repo: targetRepo(), entries };
  return entries;
}

function compactLocalRelatedTitleItems(item: Item, seen: ReadonlySet<number>): unknown[] {
  const terms = relatedTitleSearchTerms(item.title);
  if (terms.length < 2) return [];
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

function quoteGitHubSearchTerm(term: string): string {
  return /^[a-z0-9_]+$/i.test(term) ? term : `"${term.replaceAll('"', "")}"`;
}

function relatedGitHubIssueSearchQuery(repo: string, title: string): string | null {
  const terms = relatedTitleSearchTerms(title, 4);
  if (terms.length < 2) return null;
  return [`repo:${repo}`, "is:issue", "in:title,body", ...terms.map(quoteGitHubSearchTerm)].join(
    " ",
  );
}

export function relatedGitHubIssueSearchQueryForTest(repo: string, title: string): string | null {
  return relatedGitHubIssueSearchQuery(repo, title);
}

function compactRelatedGitHubIssueSearchItems(item: Item, seen: ReadonlySet<number>): unknown[] {
  if (item.kind !== "issue") return [];
  if (!envFlagEnabled(process.env.CLAWSWEEPER_RELATED_GITHUB_SEARCH)) return [];
  const query = relatedGitHubIssueSearchQuery(targetRepo(), item.title);
  if (!query) return [];

  try {
    const response = asRecord(
      ghJsonOnce<unknown>(
        [
          "api",
          `search/issues?q=${encodeURIComponent(query)}&per_page=${RELATED_GITHUB_SEARCH_LIMIT}`,
        ],
        RELATED_GITHUB_SEARCH_TIMEOUT_MS,
      ),
    );
    const items = Array.isArray(response.items) ? response.items : [];
    return items
      .map(asRecord)
      .filter((candidate) => {
        const number = candidate.number;
        if (typeof number !== "number" || seen.has(number) || number === item.number) return false;
        return !candidate.pull_request;
      })
      .slice(0, RELATED_GITHUB_SEARCH_LIMIT)
      .map((candidate) => ({
        mentionedIn: ["GitHub issue search"],
        searchQuery: query,
        searchScore: candidate.score,
        issue: compactIssue(candidate),
        commentCount: candidate.comments,
      }));
  } catch (error) {
    if (error instanceof GitHubRuntimeBudgetError) throw error;
    console.error(
      `Best-effort related issue GitHub search failed for #${item.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function parseJsonArrayBestEffort(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sqlSafeInteger(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error(`unsafe SQL integer: ${value}`);
  return String(value);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqliteScalarBestEffort(dbPath: string, sql: string): string | null {
  const result = spawnSync("sqlite3", [dbPath, sql], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function sqliteJsonBestEffort(dbPath: string, sql: string): unknown[] {
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function gitcrawlStoreDbFileName(repo: string): string {
  return `${repo
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "__")}.sync.db`;
}

function gitcrawlDbPath(repo = targetRepo()): string | null {
  const configured = process.env.CLAWSWEEPER_GITCRAWL_DB?.trim();
  if (configured) {
    const configuredPath = resolve(ROOT, configured);
    return existsSync(configuredPath) ? configuredPath : null;
  }
  const storeDbFileName = gitcrawlStoreDbFileName(repo);
  const candidates = [
    join(ROOT, "..", "gitcrawl-store", "data", storeDbFileName),
    join(homedir(), ".config", "gitcrawl", "stores", "gitcrawl-store", "data", storeDbFileName),
    join(homedir(), ".config", "gitcrawl", "gitcrawl.db"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function gitcrawlTableRows(dbPath: string, table: "clusters" | "cluster_groups"): number {
  const countSql =
    table === "clusters"
      ? "select count(*) from clusters;"
      : "select count(*) from cluster_groups;";
  const exists =
    sqliteScalarBestEffort(
      dbPath,
      `select count(*) from sqlite_master where type = 'table' and name = '${table}';`,
    ) ?? "0";
  if (Number(exists) <= 0) return 0;
  return Number(sqliteScalarBestEffort(dbPath, countSql) ?? "0");
}

function detectGitcrawlClusterSource(dbPath: string): GitcrawlClusterSource | null {
  if (gitcrawlClusterSourceCache?.dbPath === dbPath) return gitcrawlClusterSourceCache.source;
  let source: GitcrawlClusterSource | null = null;
  if (gitcrawlTableRows(dbPath, "clusters") > 0) {
    source = "legacy";
  } else if (gitcrawlTableRows(dbPath, "cluster_groups") > 0) {
    source = "portable";
  }
  gitcrawlClusterSourceCache = { dbPath, source };
  return source;
}

function gitcrawlRelatedIssueSql(
  source: GitcrawlClusterSource,
  itemNumber: number,
  limit: number,
  repo: string,
): string {
  const number = sqlSafeInteger(itemNumber);
  const cappedLimit = sqlSafeInteger(Math.max(1, Math.min(limit, RELATED_ITEMS_LIMIT)));
  const repoFullName = sqlStringLiteral(repo);
  if (source === "portable") {
    return `
      select
        cg.id as cluster_id,
        (
          select count(*)
          from cluster_memberships cm_count
          where cm_count.cluster_id = cg.id
            and cm_count.state = 'active'
        ) as member_count,
        rt.number as representative_number,
        rt.kind as representative_kind,
        rt.state as representative_state,
        rt.title as representative_title,
        t.number,
        t.kind,
        t.state,
        t.title,
        t.body_excerpt as body,
        t.labels_json,
        t.updated_at
      from cluster_groups cg
      join cluster_memberships cm_self on cm_self.cluster_id = cg.id and cm_self.state = 'active'
      join threads self on self.id = cm_self.thread_id
      join repositories self_repo on self_repo.id = self.repo_id
      join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
      join threads t on t.id = cm.thread_id
      join repositories thread_repo on thread_repo.id = t.repo_id
      left join threads rt on rt.id = cg.representative_thread_id
      where cg.status = 'active'
        and cg.repo_id = self.repo_id
        and self_repo.full_name = ${repoFullName}
        and self.number = ${number}
        and self.kind = 'issue'
        and thread_repo.full_name = ${repoFullName}
        and t.number != ${number}
        and t.kind = 'issue'
      order by case when t.state = 'open' then 0 else 1 end, t.updated_at desc, t.number desc
      limit ${cappedLimit};
    `;
  }
  return `
    select
      c.id as cluster_id,
      c.member_count,
      rt.number as representative_number,
      rt.kind as representative_kind,
      rt.state as representative_state,
      rt.title as representative_title,
      t.number,
      t.kind,
      t.state,
      t.title,
      t.body,
      t.labels_json,
      t.updated_at
    from clusters c
    join cluster_members cm_self on cm_self.cluster_id = c.id
    join threads self on self.id = cm_self.thread_id
    join repositories self_repo on self_repo.id = self.repo_id
    join cluster_members cm on cm.cluster_id = c.id
    join threads t on t.id = cm.thread_id
    join repositories thread_repo on thread_repo.id = t.repo_id
    left join threads rt on rt.id = c.representative_thread_id
    where c.closed_at_local is null
      and c.repo_id = self.repo_id
      and self_repo.full_name = ${repoFullName}
      and self.number = ${number}
      and self.kind = 'issue'
      and thread_repo.full_name = ${repoFullName}
      and t.number != ${number}
      and t.kind = 'issue'
    order by case when t.state = 'open' then 0 else 1 end, t.updated_at desc, t.number desc
    limit ${cappedLimit};
  `;
}

function compactRelatedGitcrawlItems(item: Item, seen: ReadonlySet<number>): unknown[] {
  if (item.kind !== "issue") return [];
  const repo = targetRepo();
  const dbPath = gitcrawlDbPath(repo);
  if (!dbPath) return [];
  const source = detectGitcrawlClusterSource(dbPath);
  if (!source) return [];

  return sqliteJsonBestEffort(
    dbPath,
    gitcrawlRelatedIssueSql(source, item.number, RELATED_GITCRAWL_LIMIT, repo),
  )
    .map(asRecord)
    .filter((row) => typeof row.number === "number" && !seen.has(row.number))
    .map((row) => ({
      mentionedIn: ["gitcrawl cluster"],
      gitcrawlCluster: {
        id: row.cluster_id,
        source,
        memberCount: row.member_count,
        representative: {
          number: row.representative_number,
          kind: row.representative_kind,
          state: row.representative_state,
          title: row.representative_title,
        },
      },
      gitcrawlThread: {
        number: row.number,
        kind: row.kind,
        state: row.state,
        title: row.title,
        updatedAt: row.updated_at,
        labels: parseJsonArrayBestEffort(row.labels_json),
        body: truncateText(typeof row.body === "string" ? row.body : "", 800),
      },
    }));
}

function relatedItemNumber(value: unknown): number | null {
  const record = asRecord(value);
  const issueNumber = asRecord(record.issue).number;
  if (typeof issueNumber === "number") return issueNumber;
  const localNumber = asRecord(record.localReport).number;
  if (typeof localNumber === "number") return localNumber;
  const gitcrawlNumber = asRecord(record.gitcrawlThread).number;
  if (typeof gitcrawlNumber === "number") return gitcrawlNumber;
  const directNumber = record.number;
  return typeof directNumber === "number" ? directNumber : null;
}

function appendUniqueRelatedItems(
  target: unknown[],
  seen: Set<number>,
  candidates: readonly unknown[],
): void {
  for (const candidate of candidates) {
    const number = relatedItemNumber(candidate);
    if (number !== null) {
      if (seen.has(number)) continue;
      seen.add(number);
    }
    target.push(candidate);
    if (target.length >= RELATED_ITEMS_LIMIT) return;
  }
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
  const seen = new Set<number>([options.item.number]);
  const related: unknown[] = [];
  appendUniqueRelatedItems(related, seen, explicitRelated);
  if (related.length < RELATED_ITEMS_LIMIT) {
    appendUniqueRelatedItems(related, seen, compactLocalRelatedTitleItems(options.item, seen));
  }
  if (related.length < RELATED_ITEMS_LIMIT) {
    appendUniqueRelatedItems(related, seen, compactRelatedGitcrawlItems(options.item, seen));
  }
  if (related.length < RELATED_ITEMS_LIMIT) {
    appendUniqueRelatedItems(
      related,
      seen,
      compactRelatedGitHubIssueSearchItems(options.item, seen),
    );
  }
  return related.slice(0, RELATED_ITEMS_LIMIT);
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

export function githubPaginatedPath(path: string): string {
  const [basePart, query = ""] = path.split("?", 2);
  const base = basePart ?? path;
  const params = new URLSearchParams(query);
  if (!params.has("per_page")) params.set("per_page", "100");
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function githubPagePath(path: string, page: number, perPage = 100): string {
  const [basePart, query = ""] = path.split("?", 2);
  const base = basePart ?? path;
  const params = new URLSearchParams(query);
  params.set("per_page", String(Math.max(1, Math.floor(perPage))));
  params.set("page", String(Math.max(1, Math.floor(page))));
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function ghPaged<T>(path: string): T[] {
  const pages = ghJson<unknown[]>(["api", githubPaginatedPath(path), "--paginate", "--slurp"]);
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => (Array.isArray(page) ? (page as T[]) : []));
}

export interface ContextHydration<T> {
  items: T[];
  total: number;
  hydrated: number;
  truncated: boolean;
}

function ghPage<T>(path: string, page: number): T[] {
  const items = ghJson<unknown[]>(["api", githubPagePath(path, page)]);
  return Array.isArray(items) ? (items as T[]) : [];
}

export interface GithubPageWithHeaders<T> {
  items: T[];
  lastPageNumber: number | null;
}

export function githubLinkLastPageNumber(header: string | undefined): number | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!part.includes('rel="last"')) continue;
    const page = part.match(/[?&]page=(\d+)/)?.[1];
    if (!page) continue;
    const value = Number(page);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function ghPageWithHeaders<T>(path: string, page: number, perPage = 100): GithubPageWithHeaders<T> {
  const apiPath = githubPagePath(path, page, perPage);
  const output = ghWithRetry(["api", "-i", apiPath]);
  const normalized = output.replace(/\r\n/g, "\n");
  const separator = normalized.lastIndexOf("\n\n");
  const headerText = separator >= 0 ? normalized.slice(0, separator) : "";
  const bodyText = separator >= 0 ? normalized.slice(separator + 2) : normalized;
  let linkHeader: string | undefined;
  for (const line of headerText.split("\n")) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    if (line.slice(0, delimiter).trim().toLowerCase() === "link") {
      linkHeader = line.slice(delimiter + 1).trim();
    }
  }
  const parsed = parseGhJson<unknown>(bodyText, ["api", "-i", apiPath]);
  return {
    items: Array.isArray(parsed) ? (parsed as T[]) : [],
    lastPageNumber: githubLinkLastPageNumber(linkHeader),
  };
}

function githubCount(value: unknown): number | null {
  const count =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.floor(count);
}

interface GithubContextWindowPlan {
  keepStart: number;
  keepEnd: number;
  tailFirstPageNumber: number;
  lastPageNumber: number;
  tailOffset: number;
}

export function githubContextWindowPlan(
  total: number,
  promptLimit: number,
  perPage = 100,
): GithubContextWindowPlan {
  const boundedTotal = Math.max(0, Math.floor(total));
  const boundedLimit = Math.max(0, Math.floor(promptLimit));
  const boundedPerPage = Math.max(1, Math.floor(perPage));
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const tailStartIndex = Math.max(0, boundedTotal - keepEnd);
  const tailFirstPageNumber = Math.floor(tailStartIndex / boundedPerPage) + 1;
  return {
    keepStart,
    keepEnd,
    tailFirstPageNumber,
    lastPageNumber: Math.max(1, Math.ceil(boundedTotal / boundedPerPage)),
    tailOffset: tailStartIndex - (tailFirstPageNumber - 1) * boundedPerPage,
  };
}

export function ghPagedContextWindow<T>(
  path: string,
  totalCount: unknown,
  promptLimit: number,
  fetchers: {
    page?: (path: string, page: number) => T[];
    paged?: (path: string) => T[];
  } = {},
): ContextHydration<T> {
  const fetchPage = fetchers.page ?? ghPage<T>;
  const fetchPaged = fetchers.paged ?? ghPaged<T>;
  const total = githubCount(totalCount);
  const boundedLimit = Math.max(0, Math.floor(promptLimit));
  if (total === null) {
    const items = fetchPaged(path);
    return { items, total: items.length, hydrated: items.length, truncated: false };
  }
  if (total === 0 || boundedLimit === 0) {
    return { items: [], total, hydrated: 0, truncated: total > 0 };
  }
  if (total <= boundedLimit) {
    const items = total <= 100 ? fetchPage(path, 1) : fetchPaged(path);
    return {
      items,
      total: Math.max(total, items.length),
      hydrated: items.length,
      truncated: false,
    };
  }

  const plan = githubContextWindowPlan(total, boundedLimit);
  const firstPage = plan.keepStart > 0 ? fetchPage(path, 1) : [];
  const headItems = firstPage.slice(0, plan.keepStart);
  const tailPages: T[] = [];
  if (plan.keepEnd > 0) {
    for (let page = plan.tailFirstPageNumber; page <= plan.lastPageNumber; page += 1) {
      tailPages.push(...(page === 1 && plan.keepStart > 0 ? firstPage : fetchPage(path, page)));
    }
  }
  const tailItems = tailPages.slice(plan.tailOffset, plan.tailOffset + plan.keepEnd);
  const items = [...headItems, ...tailItems];
  return {
    items,
    total,
    hydrated: items.length,
    truncated: total > items.length,
  };
}

export function ghPagedLinkHeaderContextWindow<T>(
  path: string,
  promptLimit: number,
  fetchers: {
    pageWithHeaders?: (path: string, page: number, perPage: number) => GithubPageWithHeaders<T>;
    paged?: (path: string) => T[];
  } = {},
): ContextHydration<T> {
  const fetchPage = fetchers.pageWithHeaders ?? ghPageWithHeaders<T>;
  const fetchPaged = fetchers.paged ?? ghPaged<T>;
  const boundedLimit = Math.max(0, Math.floor(promptLimit));
  const perPage = 100;
  const pages = new Map<number, T[]>();
  const readPage = (page: number): GithubPageWithHeaders<T> => {
    const cached = pages.get(page);
    if (cached) return { items: cached, lastPageNumber: null };
    const result = fetchPage(path, page, perPage);
    pages.set(page, result.items);
    return result;
  };

  const first = readPage(1);
  const lastPageNumber = first.lastPageNumber ?? (first.items.length < perPage ? 1 : null);
  if (lastPageNumber === null) {
    const items = fetchPaged(path);
    return { items, total: items.length, hydrated: items.length, truncated: false };
  }

  const lastPage = Math.max(1, lastPageNumber);
  const lastItems = lastPage === 1 ? first.items : readPage(lastPage).items;
  const total = Math.max(0, (lastPage - 1) * perPage + lastItems.length);
  if (total === 0 || boundedLimit === 0) {
    return { items: [], total, hydrated: 0, truncated: total > 0 };
  }

  if (total <= boundedLimit) {
    const items: T[] = [];
    for (let page = 1; page <= lastPage; page += 1) {
      items.push(...(page === 1 ? first.items : readPage(page).items));
    }
    return {
      items,
      total: Math.max(total, items.length),
      hydrated: items.length,
      truncated: false,
    };
  }

  const plan = githubContextWindowPlan(total, boundedLimit, perPage);
  const headItems = first.items.slice(0, plan.keepStart);
  const tailPages: T[] = [];
  if (plan.keepEnd > 0) {
    for (let page = plan.tailFirstPageNumber; page <= plan.lastPageNumber; page += 1) {
      tailPages.push(...(page === 1 ? first.items : readPage(page).items));
    }
  }
  const tailItems = tailPages.slice(plan.tailOffset, plan.tailOffset + plan.keepEnd);
  const items = [...headItems, ...tailItems];
  return {
    items,
    total,
    hydrated: items.length,
    truncated: total > items.length,
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  const value = match?.[1]?.trim();
  return value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function reportCloseReason(markdown: string): CloseReason | undefined {
  const closeReason = frontMatterValue(markdown, "close_reason");
  return closeReason && ALLOWED_REASONS.has(closeReason as CloseReason)
    ? (closeReason as CloseReason)
    : undefined;
}

function reportItemKind(markdown: string): ItemKind | undefined {
  const itemKind = frontMatterValue(markdown, "type");
  return itemKind === "issue" || itemKind === "pull_request" ? itemKind : undefined;
}

function hasHighConfidenceAllowedCloseMetadata(markdown: string): boolean {
  const closeReason = reportCloseReason(markdown);
  const itemKind = reportItemKind(markdown);
  return !(
    frontMatterValue(markdown, "decision") !== "close" ||
    frontMatterValue(markdown, "confidence") !== "high" ||
    !closeReason ||
    !itemKind
  );
}

function hasAutoCloseAllowedMetadata(markdown: string): boolean {
  const closeReason = reportCloseReason(markdown);
  const itemKind = reportItemKind(markdown);
  if (!closeReason || !itemKind || !hasHighConfidenceAllowedCloseMetadata(markdown)) return false;
  const profile = repositoryProfileFor(markdownRepository(markdown));
  return isAutoCloseAllowed(profile, itemKind, closeReason);
}

function isRetryableCloseSkipReport(markdown: string): boolean {
  const action = frontMatterValue(markdown, "action_taken");
  const closeReason = reportCloseReason(markdown);
  return (
    Boolean(action && RETRYABLE_CLOSE_SKIP_ACTIONS.has(action)) &&
    isVerifiedFixedCloseReason(closeReason) &&
    hasHighConfidenceAllowedCloseMetadata(markdown)
  );
}

function isRetryableKeptOpenCloseReport(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "action_taken") === "kept_open" &&
    hasHighConfidenceAllowedCloseMetadata(markdown)
  );
}

function isRetryablePrCloseCoverageProofReport(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "action_taken") === "retry_pr_close_coverage_proof" &&
    hasHighConfidenceAllowedCloseMetadata(markdown)
  );
}

function isPairBlockedCloseReport(markdown: string): boolean {
  const action = frontMatterValue(markdown, "action_taken");
  return (
    Boolean(action && PAIR_BLOCKED_CLOSE_ACTIONS.has(action)) &&
    hasHighConfidenceAllowedCloseMetadata(markdown)
  );
}

function isApplyCloseCandidateReport(markdown: string): boolean {
  const action = frontMatterValue(markdown, "action_taken");
  return (
    hasHighConfidenceAllowedCloseMetadata(markdown) &&
    (action === "proposed_close" ||
      isRetryableCloseSkipReport(markdown) ||
      isRetryablePrCloseCoverageProofReport(markdown) ||
      isRetryableKeptOpenCloseReport(markdown) ||
      isPairBlockedCloseReport(markdown))
  );
}

function shouldProbeClosedStateReport(markdown: string): boolean {
  const action = frontMatterValue(markdown, "action_taken");
  return action === "proposed_close" || Boolean(action && CLOSED_STATE_PROBE_ACTIONS.has(action));
}

export function applyDecisionPriority(markdown: string, applyKind: ApplyKind): number {
  const itemKind = reportItemKind(markdown);
  const isCloseProposal =
    isApplyCloseCandidateReport(markdown) && hasAutoCloseAllowedMetadata(markdown);
  if (!isCloseProposal) return 2;
  if (
    frontMatterValue(markdown, "action_taken") === "skipped_same_author_pair" &&
    itemKind === "pull_request" &&
    (applyKind === "all" || applyKind === "pull_request")
  ) {
    return 0;
  }
  if (isPairBlockedCloseReport(markdown)) return 1;
  if (applyKind === "all" || itemKind === applyKind || !itemKind) return 0;
  return 1;
}

function applyQueueSortFields(markdown: string, syncCommentsOnly: boolean, applyKind: ApplyKind) {
  const checkedAt = Date.parse(frontMatterValue(markdown, "apply_checked_at") ?? "");
  return {
    priority: syncCommentsOnly ? 0 : applyDecisionPriority(markdown, applyKind),
    applyCheckedAt: Number.isFinite(checkedAt) ? checkedAt : 0,
  };
}

export function shouldSyncReviewComment(options: {
  syncCommentsOnly: boolean;
  isCloseProposal: boolean;
  commentSyncMinAgeDays: number;
  reviewCommentSyncedAt: string | undefined;
  hasExistingReviewComment: boolean;
  needsReviewCommentBodySync: boolean;
  needsReviewCommentHashSync: boolean;
  needsReviewCommentReferenceSync: boolean;
  forceReviewCommentBodySync?: boolean;
  now?: number;
}): boolean {
  if (
    !options.needsReviewCommentBodySync &&
    !options.needsReviewCommentHashSync &&
    !options.needsReviewCommentReferenceSync
  ) {
    return false;
  }
  if (!options.syncCommentsOnly || options.isCloseProposal) return true;
  if (options.forceReviewCommentBodySync && options.needsReviewCommentBodySync) return true;
  if (!options.hasExistingReviewComment || options.needsReviewCommentReferenceSync) return true;
  if (options.commentSyncMinAgeDays <= 0) return true;
  if (!options.reviewCommentSyncedAt) return true;
  return isOlderThanDays(options.reviewCommentSyncedAt, options.commentSyncMinAgeDays, options.now);
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

function reviewSectionValue(markdown: string, section: ReviewSection): string {
  return sectionValue(markdown, REVIEW_SECTIONS[section]);
}

function replaceSectionValue(markdown: string, heading: string, value: string): string {
  const pattern = new RegExp(`((?:^|\\n)## ${heading}\\n\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`);
  if (pattern.test(markdown)) return markdown.replace(pattern, `$1${value.trim()}\n`);
  return `${markdown.trimEnd()}\n\n## ${heading}\n\n${value.trim()}\n`;
}

function appendSectionValue(markdown: string, heading: string, value: string): string {
  const existing = sectionValue(markdown, heading);
  const nextValue = existing ? `${existing.trimEnd()}\n\n${value.trim()}` : value.trim();
  return replaceSectionValue(markdown, heading, nextValue);
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

function frontMatterJsonArray(markdown: string, key: string): unknown[] {
  const value = frontMatterValue(markdown, key);
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function frontMatterBoolean(markdown: string, key: string): boolean {
  return /^true$/i.test(frontMatterValue(markdown, key) ?? "");
}

function reviewReportCanPromoteToClose(markdown: string): boolean {
  return !frontMatterBoolean(markdown, "review_cache_hit");
}

export function reviewReportCanPromoteToCloseForTest(markdown: string): boolean {
  return reviewReportCanPromoteToClose(markdown);
}

function existingReview(
  item: Pick<Item, "number" | "repo">,
  itemsDir: string,
): ExistingReview | null {
  const candidates = [join(itemsDir, reportFileName(item.repo, item.number))];
  const path = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    const markdown = readFileSync(candidate, "utf8");
    return markdownRepository(markdown, candidate) === item.repo;
  });
  if (!path) return null;
  const markdown = readFileSync(path, "utf8");
  return {
    path,
    markdown,
    reviewedAt: frontMatterValue(markdown, "reviewed_at"),
    itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
    reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
    labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
    decision: frontMatterValue(markdown, "decision"),
    reviewStatus: effectiveReviewStatus(markdown),
    reviewPolicy: frontMatterValue(markdown, "review_policy"),
    contentDigest: frontMatterValue(markdown, "review_content_digest"),
    lastFullReviewAt: frontMatterValue(markdown, "last_full_review_at"),
    lastFullReviewDecision: frontMatterValue(markdown, "last_full_review_decision"),
  };
}

interface ExistingReviewIndex {
  byKey: Map<string, ExistingReview>;
}

function existingReviewKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function buildExistingReviewIndex(itemsDir: string): ExistingReviewIndex {
  const byKey = new Map<string, ExistingReview>();
  for (const file of markdownFiles(itemsDir)) {
    const path = join(itemsDir, file);
    const markdown = readFileSync(path, "utf8");
    const repo = markdownRepository(markdown, path);
    const number = numberForMarkdownFile(file);
    byKey.set(existingReviewKey(repo, number), {
      path,
      markdown,
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      itemUpdatedAt: frontMatterValue(markdown, "item_updated_at"),
      reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
      labelsSyncedAt: frontMatterValue(markdown, "labels_synced_at"),
      decision: frontMatterValue(markdown, "decision"),
      reviewStatus: effectiveReviewStatus(markdown),
      reviewPolicy: frontMatterValue(markdown, "review_policy"),
      contentDigest: frontMatterValue(markdown, "review_content_digest"),
      lastFullReviewAt: frontMatterValue(markdown, "last_full_review_at"),
      lastFullReviewDecision: frontMatterValue(markdown, "last_full_review_decision"),
    });
  }
  return { byKey };
}

function indexedExistingReview(
  item: Pick<Item, "number" | "repo">,
  itemsDir: string,
  reviewIndex?: ExistingReviewIndex,
): ExistingReview | null {
  return (
    reviewIndex?.byKey.get(existingReviewKey(item.repo, item.number)) ??
    existingReview(item, itemsDir)
  );
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

function failedReviewRetryRevisionForReport(markdown: string): FailedReviewRetryRevision | null {
  const kind = frontMatterValue(markdown, "type");
  if (kind === "pull_request") {
    const value = pullHeadShaFromReport(markdown);
    return value ? { kind: "pull_head_sha", value } : null;
  }
  if (kind === "issue") {
    const value = frontMatterValue(markdown, "item_source_revision");
    return value && value !== "unknown" ? { kind: "item_source_revision", value } : null;
  }
  return null;
}

function storedFailedReviewRetryRevision(markdown: string): FailedReviewRetryRevision | null {
  const kind = frontMatterValue(markdown, "failed_review_retry_revision_kind");
  const value = frontMatterValue(markdown, "failed_review_retry_revision");
  if ((kind === "pull_head_sha" || kind === "item_source_revision") && value) {
    return { kind, value };
  }
  const legacyHead = frontMatterValue(markdown, "failed_review_retry_head_sha");
  return legacyHead ? { kind: "pull_head_sha", value: legacyHead } : null;
}

function sameFailedReviewRetryRevision(
  left: FailedReviewRetryRevision,
  right: FailedReviewRetryRevision,
): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function failedReviewRetryResultRevision(revision: FailedReviewRetryRevision): {
  headSha?: string;
  revisionKind: FailedReviewRetryRevisionKind;
  revision: string;
} {
  return {
    ...(revision.kind === "pull_head_sha" ? { headSha: revision.value } : {}),
    revisionKind: revision.kind,
    revision: revision.value,
  };
}

function failedReviewRetryCount(markdown: string, revision: FailedReviewRetryRevision): number {
  const storedRevision = storedFailedReviewRetryRevision(markdown);
  if (storedRevision && !sameFailedReviewRetryRevision(storedRevision, revision)) return 0;
  const value = frontMatterValue(markdown, "failed_review_retry_count");
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function failedReviewRetryLastAtMs(
  markdown: string,
  revision: FailedReviewRetryRevision,
): number | null {
  const storedRevision = storedFailedReviewRetryRevision(markdown);
  if (storedRevision && !sameFailedReviewRetryRevision(storedRevision, revision)) return null;
  return timestampMs(frontMatterValue(markdown, "failed_review_retry_last_at"));
}

function isFailedReviewRetryAlreadyExhausted(
  markdown: string,
  revision: FailedReviewRetryRevision,
): boolean {
  const storedRevision = storedFailedReviewRetryRevision(markdown);
  return (
    frontMatterValue(markdown, "failed_review_retry_status") === "exhausted" &&
    storedRevision !== null &&
    sameFailedReviewRetryRevision(storedRevision, revision)
  );
}

function failedReviewFailureDetail(markdown: string): string {
  return [
    frontMatterValue(markdown, "review_status") ?? "",
    frontMatterValue(markdown, "decision") ?? "",
    reviewSectionValue(markdown, "summary"),
    reviewSectionValue(markdown, "evidence"),
    sectionValue(markdown, "Summary"),
    sectionValue(markdown, "Evidence"),
    markdown.slice(0, 8000),
  ].join("\n");
}

export function isInfrastructureFailedReviewForTest(markdown: string): boolean {
  return isInfrastructureFailedReview(markdown);
}

function isInfrastructureFailedReview(markdown: string): boolean {
  const detail = failedReviewFailureDetail(markdown);
  if (frontMatterBoolean(markdown, "review_terminal_failure")) return false;
  return (
    isRetryableCodexTransportError(detail) ||
    /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|transport failure|codex transport|Codex worker timed out|Codex review failed: timeout|timed out after|shard timeout|workflow timeout|cancelledByParent)\b/i.test(
      detail,
    )
  );
}

export function failedReviewRetryEligibilityForTest(options: {
  markdown: string;
  liveState: string;
  liveHeadSha?: string | null;
  liveSourceRevision?: string | null;
  now: number;
  maxAttempts: number;
  cooldownMs: number;
}): FailedReviewRetryResult {
  return failedReviewRetryEligibility(options);
}

function failedReviewRetryEligibility(options: {
  markdown: string;
  liveState: string;
  liveHeadSha?: string | null;
  liveSourceRevision?: string | null;
  now: number;
  maxAttempts: number;
  cooldownMs: number;
}): FailedReviewRetryResult {
  const number = Number(frontMatterValue(options.markdown, "number") ?? 0);
  const repo = markdownRepository(options.markdown);
  if (effectiveReviewStatus(options.markdown) !== "failed") {
    return { repo, number, action: "skipped_not_failed_review", reason: "review is not failed" };
  }
  if (options.liveState !== "open") {
    return { repo, number, action: "skipped_not_open", reason: `state is ${options.liveState}` };
  }
  const itemKind = frontMatterValue(options.markdown, "type");
  if (itemKind !== "pull_request" && itemKind !== "issue") {
    return {
      repo,
      number,
      action: "skipped_not_pull_request",
      reason: "failed-review retry requires an issue or pull request report",
    };
  }
  const reportRevision = failedReviewRetryRevisionForReport(options.markdown);
  if (!reportRevision) {
    return {
      repo,
      number,
      action:
        itemKind === "pull_request"
          ? "skipped_missing_report_head"
          : "skipped_missing_report_revision",
      reason:
        itemKind === "pull_request"
          ? "report does not record a pull_head_sha"
          : "report does not record an item_source_revision",
    };
  }
  const liveRevisionValue =
    (reportRevision.kind === "pull_head_sha"
      ? options.liveHeadSha
      : options.liveSourceRevision
    )?.trim() || null;
  if (!liveRevisionValue) {
    return {
      repo,
      number,
      action:
        reportRevision.kind === "pull_head_sha"
          ? "skipped_missing_live_head"
          : "skipped_missing_live_revision",
      reason:
        reportRevision.kind === "pull_head_sha"
          ? "live pull request head SHA is unavailable"
          : "live issue source revision is unavailable",
      ...failedReviewRetryResultRevision(reportRevision),
    };
  }
  if (liveRevisionValue !== reportRevision.value) {
    return {
      repo,
      number,
      action:
        reportRevision.kind === "pull_head_sha" ? "skipped_stale_head" : "skipped_stale_revision",
      reason:
        reportRevision.kind === "pull_head_sha"
          ? `live head ${liveRevisionValue} does not match failed report head ${reportRevision.value}`
          : `live source revision ${liveRevisionValue} does not match failed report source revision ${reportRevision.value}`,
      ...failedReviewRetryResultRevision(reportRevision),
    };
  }
  if (!isInfrastructureFailedReview(options.markdown)) {
    return {
      repo,
      number,
      action: "skipped_non_infrastructure_failure",
      reason: "failed review does not look like a Codex timeout or infrastructure failure",
      ...failedReviewRetryResultRevision(reportRevision),
    };
  }
  const attempts = failedReviewRetryCount(options.markdown, reportRevision);
  const revisionDescription =
    reportRevision.kind === "pull_head_sha"
      ? `head ${reportRevision.value}`
      : `source revision ${reportRevision.value}`;
  if (attempts >= options.maxAttempts) {
    return {
      repo,
      number,
      action: "skipped_retry_exhausted",
      reason: `retry attempts exhausted for ${revisionDescription}: ${attempts}/${options.maxAttempts}`,
      ...failedReviewRetryResultRevision(reportRevision),
      attempts,
    };
  }
  const lastAtMs = failedReviewRetryLastAtMs(options.markdown, reportRevision);
  if (lastAtMs !== null && options.now - lastAtMs < options.cooldownMs) {
    const remainingMs = Math.max(0, options.cooldownMs - (options.now - lastAtMs));
    return {
      repo,
      number,
      action: "skipped_retry_cooldown",
      reason: `retry cooldown has ${Math.ceil(remainingMs / 60000)} minute(s) remaining`,
      ...failedReviewRetryResultRevision(reportRevision),
      attempts,
    };
  }
  return {
    repo,
    number,
    action: "planned_failed_review_retry",
    reason: `eligible infrastructure failed review at ${revisionDescription}`,
    ...failedReviewRetryResultRevision(reportRevision),
    attempts,
  };
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

function dueCandidate(
  item: Item,
  itemsDir: string,
  now = Date.now(),
  reviewPolicy?: string,
  reviewIndex?: ExistingReviewIndex,
): DueCandidate | null {
  const review = indexedExistingReview(item, itemsDir, reviewIndex);
  if (!shouldReviewItem(item, review, now, reviewPolicy)) return null;
  return {
    item,
    review,
    priority: reviewPriority(item, review, now, reviewPolicy),
    reviewedAt: reviewedAtMs(review) ?? 0,
    nextDueAt: nextReviewDueAtMs(item, review, now, reviewPolicy),
    bucket: schedulerBucket(item, review, now),
  };
}

function reviewBackfillCandidate(
  item: Item,
  itemsDir: string,
  now = Date.now(),
  reviewPolicy?: string,
  minReviewAgeMs = 0,
  reviewIndex?: ExistingReviewIndex,
): DueCandidate | null {
  const review = indexedExistingReview(item, itemsDir, reviewIndex);
  if (!review || hasReviewPolicyMismatch(review, reviewPolicy)) return null;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return null;
  if (now - reviewedAt < minReviewAgeMs) return null;
  if (shouldReviewItem(item, review, now, reviewPolicy)) return null;
  return {
    item,
    review,
    priority: reviewPriority(item, review, now, reviewPolicy),
    reviewedAt,
    nextDueAt: nextReviewDueAtMs(item, review, now, reviewPolicy),
    bucket: schedulerBucket(item, review, now),
  };
}

function fetchOpenItemPage(
  page: number,
  sort: "created" | "updated" = "created",
  direction: "asc" | "desc" = "asc",
): Item[] {
  const items = ghJsonLines<GitHubIssueListItem>([
    "api",
    `repos/${targetRepo()}/issues?state=open&sort=${sort}&direction=${direction}&per_page=100&page=${page}`,
    "--jq",
    ".[] | {number,title,html_url,created_at,updated_at,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
  ]);
  return items
    .map((item) => ({
      repo: targetRepo(),
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
  const issue = ghJson<
    GitHubIssueListItem & {
      active_lock_reason?: string | null;
      locked?: boolean;
      state?: string;
    }
  >([
    "api",
    `repos/${targetRepo()}/issues/${number}`,
    "--jq",
    "{number,title,html_url,created_at,updated_at,closed_at,state,locked,active_lock_reason,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
  ]);
  return {
    item: {
      repo: targetRepo(),
      number: issue.number,
      kind: issue.pull_request ? "pull_request" : "issue",
      title: issue.title,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      author: issue.user?.login ?? "unknown",
      authorAssociation: normalizeAuthorAssociation(issue.author_association),
      labels: issue.labels ?? [],
      locked: issue.locked === true,
      activeLockReason: issue.active_lock_reason ?? null,
    },
    state: issue.state ?? "unknown",
  };
}

function fetchOpenItemCounts(): OpenItemCounts {
  const [owner, name] = targetRepo().split("/");
  if (!owner || !name) throw new Error(`Invalid target repo: ${targetRepo()}`);
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
    inheritedLabelCleanups: 0,
    selfHealConflictRepairs: 0,
    failedReviewRetries: 0,
    failedReviewRetryExhaustions: 0,
    botOwnedProofDecisionsRequested: 0,
    botOwnedProofDispatches: 0,
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
  const closedAt = dashboardClosedAt(markdown);
  const closedAtMs = timestampMs(closedAt);
  const commentSyncedAt = frontMatterValue(markdown, "review_comment_synced_at");
  const commentSyncedAtMs = timestampMs(commentSyncedAt);
  const applyCheckedAt = frontMatterValue(markdown, "apply_checked_at");
  const applyCheckedAtMs = timestampMs(applyCheckedAt);
  const decision = frontMatterValue(markdown, "decision") ?? "unknown";
  const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
  const failedReviewRetryStatus = frontMatterValue(markdown, "failed_review_retry_status");
  const failedReviewRetryLastAt = frontMatterValue(markdown, "failed_review_retry_last_at");
  const failedReviewRetryLastAtMs = timestampMs(failedReviewRetryLastAt);
  const reviewStatus = effectiveReviewStatus(markdown);

  activity.latestReviewAt = latestTimestamp(activity.latestReviewAt, reviewedAt);
  activity.latestCloseAt = latestTimestamp(activity.latestCloseAt, closedAt);
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
    if (isWithinWindow(closedAtMs, now, windowMs)) bucket.closes += 1;
    if (isWithinWindow(commentSyncedAtMs, now, windowMs)) bucket.commentSyncs += 1;
    if (isWithinWindow(applyCheckedAtMs, now, windowMs) && action.startsWith("skipped_")) {
      bucket.applySkips += 1;
    }
    if (isWithinWindow(applyCheckedAtMs ?? reviewedAtMs, now, windowMs)) {
      recordOperationActivity(action, bucket);
    }
    if (
      failedReviewRetryStatus &&
      !normalizedOperationText(action).includes("failed_review_retry") &&
      isWithinWindow(failedReviewRetryLastAtMs, now, windowMs)
    ) {
      recordFailedReviewRetryStatus(failedReviewRetryStatus, bucket);
    }
  }
}

function dashboardMarkdownWithFailedReviewRetryState(
  markdown: string,
  number: number,
  stateDir: string,
): string {
  const statePath = failedReviewRetryStatePath(stateDir, number);
  let state: FailedReviewRetryState | null;
  try {
    state = readFailedReviewRetryState(statePath);
  } catch (error) {
    console.error(
      `[dashboard] ignoring invalid failed-review retry state ${repoRelativePath(statePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    state = null;
  }
  return failedReviewRetryMarkdownWithState(markdown, state);
}

export function dashboardFailedReviewRetryActivityForTest(options: {
  markdown: string;
  number: number;
  stateDir: string;
  now: number;
}): DashboardActivityStats {
  const activity = emptyDashboardActivityStats();
  recordDashboardActivity(
    dashboardMarkdownWithFailedReviewRetryState(options.markdown, options.number, options.stateDir),
    activity,
    options.now,
  );
  return activity;
}

function formatActivityRow(label: string, bucket: DashboardActivityBucket): string {
  return `| ${label} | ${bucket.reviews} | ${bucket.closeDecisions} | ${bucket.keepOpenDecisions} | ${bucket.failedOrStaleReviews} | ${bucket.closes} | ${bucket.commentSyncs} | ${bucket.applySkips} |`;
}

function recordOperationActivity(action: string, bucket: DashboardActivityBucket): void {
  const normalized = normalizedOperationText(action);
  if (
    normalized.includes("inherited_label_cleanup") ||
    normalized.includes("replacement_label_cleanup") ||
    normalized.includes("removed_inherited_labels")
  ) {
    bucket.inheritedLabelCleanups += 1;
  }
  if (
    normalized.includes("self_heal_conflict") ||
    normalized.includes("conflict_self_heal") ||
    normalized.includes("clawsweeper_self_rebase")
  ) {
    bucket.selfHealConflictRepairs += 1;
  }
  if (
    normalized.includes("failed_review_retry_exhausted") ||
    normalized.includes("failed_review_retries_exhausted")
  ) {
    bucket.failedReviewRetryExhaustions += 1;
  } else if (normalized.includes("failed_review_retry")) {
    bucket.failedReviewRetries += 1;
  }
  if (
    normalized.includes("bot_owned_proof_decision_requested") ||
    normalized.includes("maintainer_proof_decision_requested") ||
    normalized.includes("needs_maintainer_proof_decision") ||
    normalized.includes("bot_proof_decision_planned") ||
    normalized.includes("bot_proof_decision_posted")
  ) {
    bucket.botOwnedProofDecisionsRequested += 1;
  }
  if (
    normalized.includes("bot_owned_proof_dispatched") ||
    normalized.includes("bot_owned_proof_capture_dispatched") ||
    normalized.includes("bot_proof_mantis_request_planned") ||
    normalized.includes("bot_proof_mantis_request_posted")
  ) {
    bucket.botOwnedProofDispatches += 1;
  }
}

function normalizedOperationText(value: string): string {
  return value.toLowerCase().replaceAll("-", "_");
}

function recordFailedReviewRetryStatus(status: string, bucket: DashboardActivityBucket): void {
  const normalized = normalizedOperationText(status);
  if (normalized === "exhausted") {
    bucket.failedReviewRetryExhaustions += 1;
  } else if (normalized === "dispatched") {
    bucket.failedReviewRetries += 1;
  }
}

function formatOperationActivityRow(label: string, bucket: DashboardActivityBucket): string {
  return `| ${label} | ${bucket.inheritedLabelCleanups} | ${bucket.selfHealConflictRepairs} | ${bucket.failedReviewRetries} | ${bucket.failedReviewRetryExhaustions} | ${bucket.botOwnedProofDecisionsRequested} | ${bucket.botOwnedProofDispatches} |`;
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
  // Local-review extension: review closed/merged items too (fixtures, hypothetical
  // re-review). Default false preserves the open-only rule for normal operation.
  allowClosed?: boolean;
}): { candidates: Item[]; scannedPages: number } {
  if (options.itemNumbers) {
    const candidates = options.itemNumbers.flatMap((number) => {
      const { item, state } = fetchItem(number);
      return state === "open" || options.allowClosed ? [item] : [];
    });
    return { candidates, scannedPages: 0 };
  }
  if (options.itemNumber) {
    if (options.shardIndex !== 0) return { candidates: [], scannedPages: 0 };
    const { item, state } = fetchItem(options.itemNumber);
    if (state !== "open" && !options.allowClosed) return { candidates: [], scannedPages: 0 };
    return { candidates: [item], scannedPages: 0 };
  }
  const due: DueCandidate[] = [];
  const now = Date.now();
  const reviewIndex = buildExistingReviewIndex(options.itemsDir);
  if (options.hotIntake) {
    const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
    for (const item of items) {
      if (item.number % options.shardCount !== options.shardIndex) continue;
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(
        item,
        options.itemsDir,
        now,
        options.reviewPolicy,
        reviewIndex,
      );
      if (candidate) due.push(candidate);
    }
    const candidates = selectDueCandidates(
      due,
      options.batchSize,
      compareHotIntakeDueCandidates,
    ).map(({ item }) => item);
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
      const candidate = dueCandidate(
        item,
        options.itemsDir,
        now,
        options.reviewPolicy,
        reviewIndex,
      );
      if (candidate) due.push(candidate);
    }
  }
  const candidates = selectDueCandidates(due, options.batchSize)
    .slice(0, options.batchSize)
    .map(({ item }) => item);
  return { candidates, scannedPages };
}

function exactLocalReviewNoCandidateError(
  itemNumber: number | undefined,
  shardIndex: number,
): UserFacingCommandError {
  if (itemNumber === undefined) {
    return new UserFacingCommandError("No review was run because no item number was provided.");
  }
  if (shardIndex !== 0) {
    return new UserFacingCommandError(
      `No review was run for ${targetRepo()}#${itemNumber} because exact item reviews only run on shard 0. Remove --shard-index for local reviews.`,
    );
  }
  try {
    const { item, state } = fetchItem(itemNumber);
    if (state !== "open") {
      return new UserFacingCommandError(
        `No review was run for ${targetRepo()}#${itemNumber} because GitHub reports this ${item.kind === "pull_request" ? "PR" : "issue"} is ${state}. Local exact review only reviews open items.`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return new UserFacingCommandError(
      `No review was run for ${targetRepo()}#${itemNumber} because the item could not be loaded from GitHub. If this is a different repository, pass --target-repo owner/name. ${reason}`,
    );
  }
  return new UserFacingCommandError(
    `No review was run for ${targetRepo()}#${itemNumber}. The item was not selected for review.`,
  );
}

function openExplicitItems(itemNumbers: readonly number[]): Item[] {
  const seen = new Set<number>();
  const candidates: Item[] = [];
  for (const number of itemNumbers) {
    if (seen.has(number)) continue;
    seen.add(number);
    const { item, state } = fetchItem(number);
    if (state === "open") candidates.push(item);
  }
  return candidates;
}

function planShardCount(shardCount: number): number {
  if (!Number.isFinite(shardCount)) return 1;
  return Math.max(1, Math.min(MAX_PLAN_SHARD_COUNT, Math.floor(shardCount)));
}

export function shardItemNumbers(itemNumbers: readonly number[], shardCount: number): PlanShard[] {
  const count = Math.max(1, Math.min(planShardCount(shardCount), itemNumbers.length || 1));
  const shards = Array.from({ length: count }, (_, shard) => ({
    shard,
    itemNumbers: [] as number[],
  }));
  itemNumbers.forEach((number, index) => {
    shards[index % shards.length]?.itemNumbers.push(number);
  });
  return shards;
}

function activeCodexTarget(shards: readonly PlanShard[]): number {
  return shards.filter((shard) => shard.itemNumbers.length > 0).length;
}

function oldestUnreviewedAt(candidates: readonly DueCandidate[]): string | undefined {
  let oldest: string | undefined;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.review) continue;
    const createdAtMs = Date.parse(candidate.item.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs >= oldestMs) continue;
    oldestMs = createdAtMs;
    oldest = candidate.item.createdAt;
  }
  return oldest;
}

function planCapacityReason(options: {
  selectedCount: number;
  dueBacklog: number;
  capacity: number;
  exact?: boolean;
  activeFloor?: number;
  floorBackfill?: number;
}): string {
  if (options.exact) {
    return options.selectedCount === 0
      ? "idle: no requested open items found"
      : "exact: requested item selection";
  }
  if ((options.floorBackfill ?? 0) > 0) {
    return `floor: due backlog below active floor; filled ${options.floorBackfill} stale current item(s)`;
  }
  if ((options.activeFloor ?? 0) > 0 && options.selectedCount < (options.activeFloor ?? 0)) {
    return `under floor: only ${options.selectedCount} eligible item(s) found for active floor ${options.activeFloor}`;
  }
  if (options.selectedCount === 0) return "idle: no due candidates found";
  if (options.dueBacklog >= options.capacity)
    return "saturated: due backlog filled planned capacity";
  return "under capacity: due backlog below planned capacity";
}

function planCandidates(options: {
  batchSize: number;
  maxPages: number;
  shardCount: number;
  itemsDir: string;
  itemNumber?: number;
  itemNumbers?: number[];
  reviewPolicy: string;
  hotIntake?: boolean;
  minimumActiveShards?: number;
  minimumBackfillReviewAgeMs?: number;
}): PlanCandidateResult {
  const shardCount = planShardCount(options.shardCount);
  const batchSize = Math.max(1, options.batchSize);
  const capacity = batchSize * shardCount;
  const activeFloor =
    options.hotIntake || options.itemNumber || options.itemNumbers
      ? 0
      : Math.max(0, Math.min(capacity, Math.floor(options.minimumActiveShards ?? 0)));
  const minimumBackfillReviewAgeMs = Math.max(0, options.minimumBackfillReviewAgeMs ?? 0);
  if (options.itemNumbers) {
    const candidates = openExplicitItems(options.itemNumbers);
    const shards = shardItemNumbers(
      candidates.map((item) => item.number),
      shardCount,
    );
    return {
      shards,
      scannedPages: 0,
      candidates,
      capacity,
      dueBacklog: candidates.length,
      activeCodexTarget: activeCodexTarget(shards),
      oldestUnreviewedAt: undefined,
      floorBackfill: 0,
      capacityReason: planCapacityReason({
        selectedCount: candidates.length,
        dueBacklog: candidates.length,
        capacity,
        exact: true,
      }),
    };
  }
  if (options.itemNumber) {
    const { item, state } = fetchItem(options.itemNumber);
    const shouldReview = state === "open";
    const candidates = shouldReview ? [item] : [];
    const shards = [{ shard: 0, itemNumbers: shouldReview ? [item.number] : [] }];
    return {
      shards,
      scannedPages: 0,
      candidates,
      capacity,
      dueBacklog: candidates.length,
      activeCodexTarget: activeCodexTarget(shards),
      oldestUnreviewedAt: undefined,
      floorBackfill: 0,
      capacityReason: planCapacityReason({
        selectedCount: candidates.length,
        dueBacklog: candidates.length,
        capacity,
        exact: true,
      }),
    };
  }

  const due: DueCandidate[] = [];
  const now = Date.now();
  const reviewIndex = buildExistingReviewIndex(options.itemsDir);
  if (options.hotIntake) {
    const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
    for (const item of items) {
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(
        item,
        options.itemsDir,
        now,
        options.reviewPolicy,
        reviewIndex,
      );
      if (candidate) due.push(candidate);
    }
    const candidates = selectDueCandidates(due, capacity, compareHotIntakeDueCandidates, now).map(
      ({ item }) => item,
    );
    const shards = Array.from(
      { length: Math.max(1, Math.min(shardCount, candidates.length || 1)) },
      (_, shard) => ({ shard, itemNumbers: [] as number[] }),
    );
    candidates.forEach((item, index) => {
      shards[index % shards.length]?.itemNumbers.push(item.number);
    });
    return {
      shards,
      scannedPages: pagesScanned,
      candidates,
      capacity,
      dueBacklog: due.length,
      activeCodexTarget: activeCodexTarget(shards),
      oldestUnreviewedAt: oldestUnreviewedAt(due),
      floorBackfill: 0,
      capacityReason: planCapacityReason({
        selectedCount: candidates.length,
        dueBacklog: due.length,
        capacity,
      }),
    };
  }
  let scannedPages = 0;
  const backfill: DueCandidate[] = [];
  for (let page = 1; page <= options.maxPages; page += 1) {
    const items = fetchOpenItemPage(page);
    scannedPages = page;
    if (items.length === 0) break;
    for (const item of items) {
      if (!shouldPlanItem(item)) continue;
      const candidate = dueCandidate(
        item,
        options.itemsDir,
        now,
        options.reviewPolicy,
        reviewIndex,
      );
      if (candidate) {
        due.push(candidate);
        continue;
      }
      if (activeFloor <= 0) continue;
      const fallback = reviewBackfillCandidate(
        item,
        options.itemsDir,
        now,
        options.reviewPolicy,
        minimumBackfillReviewAgeMs,
        reviewIndex,
      );
      if (fallback) backfill.push(fallback);
    }
    if (shouldStopSaturatedPlanScan({ dueCount: due.length, capacity })) break;
  }
  const selected = appendFloorBackfillCandidates(
    selectDueCandidates(due, capacity, compareDueCandidates, now),
    backfill,
    {
      activeFloor,
      capacity,
    },
  );
  const floorBackfill = selected.filter((candidate) => !due.includes(candidate)).length;
  const candidates = selected.map(({ item }) => item);
  const shards = shardItemNumbers(
    candidates.map((item) => item.number),
    shardCount,
  );

  return {
    shards,
    scannedPages,
    candidates,
    capacity,
    dueBacklog: due.length,
    activeCodexTarget: activeCodexTarget(shards),
    oldestUnreviewedAt: oldestUnreviewedAt(due),
    floorBackfill,
    capacityReason: planCapacityReason({
      selectedCount: candidates.length,
      dueBacklog: due.length,
      capacity,
      activeFloor,
      floorBackfill,
    }),
  };
}

function collectItemContext(
  item: Item,
  options: { fullTimelineForRelations?: boolean; reviewCacheDigest?: boolean } = {},
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
  const previousClawSweeperReview = extractLatestClawSweeperReview(comments, item.number);
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
      options.reviewCacheDigest && pullReviewCommentsWindow.truncated
        ? ghPaged<unknown>(`repos/${targetRepo()}/pulls/${item.number}/comments`)
        : pullReviewComments;
    digestPullReviewComments =
      fullPullReviewComments === pullReviewComments
        ? filteredPullReviewComments
        : filterReviewContextComments(fullPullReviewComments, item.number);
    context.pullRequest = compactPullRequest(pullRequest);
    context.pullFiles = compactMappedWindow(pullFiles, pullFilesWindow.total, 80, compactPullFile);
    context.pullCommits = compactMappedWindow(
      pullCommits,
      pullCommitsWindow.total,
      80,
      compactPullCommit,
    );
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
  return context;
}

type ReviewGitInfoOptions = {
  targetBranch?: string;
};

function gitInfo(openclawDir: string, options: ReviewGitInfoOptions = {}): GitInfo {
  const targetBranch = options.targetBranch ?? reviewTargetBranch(openclawDir);
  requireSafeGitBranchName(targetBranch, "target branch");
  run(
    "git",
    ["fetch", "origin", `${targetBranch}:refs/remotes/origin/${targetBranch}`, "--depth=50"],
    {
      cwd: openclawDir,
    },
  );
  const mainSha = run("git", ["rev-parse", `refs/remotes/origin/${targetBranch}`], {
    cwd: openclawDir,
  });
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

function reviewTargetBranch(openclawDir: string): string {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: openclawDir });
  if (isSafeGitBranchName(branch) && branch !== "HEAD") return branch;
  return "main";
}

function isSafeGitBranchName(branch: string): boolean {
  return /^[A-Za-z0-9_./-]+$/.test(branch) && !branch.startsWith("-");
}

function requireSafeGitBranchName(branch: string, label: string): string {
  if (isSafeGitBranchName(branch) && branch !== "HEAD") return branch;
  throw new UserFacingCommandError(`Invalid ${label}: ${branch}`);
}

type LocalPullMetadata = {
  baseRef: string;
};

function localPullMetadata(itemNumber: number): LocalPullMetadata {
  try {
    const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${itemNumber}`]));
    const baseRef = stringOrUndefined(asRecord(pull.base).ref);
    if (!baseRef) throw new Error("pull request base ref was missing");
    return { baseRef: requireSafeGitBranchName(baseRef, "pull request base branch") };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UserFacingCommandError(
      `Could not load pull request #${itemNumber} from ${targetRepo()} for managed local checkout. ` +
        `Pass --target-dir to review an existing checkout. ${reason}`,
    );
  }
}

function tryLocalPullBaseBranch(itemNumber: number): string | undefined {
  try {
    return localPullMetadata(itemNumber).baseRef;
  } catch {
    return undefined;
  }
}

type ReviewCheckout = {
  mode: "managed" | "supplied" | "default";
  openclawDir: string;
  gitTargetBranch?: string;
};

function hasExplicitReviewTargetDir(args: Args): boolean {
  return typeof args.target_dir === "string" || typeof args.openclaw_dir === "string";
}

function localExactReviewItem(
  localOnly: boolean,
  itemNumber: number | undefined,
  itemNumbers: number[] | undefined,
): itemNumber is number {
  return localOnly && itemNumber !== undefined && itemNumbers === undefined;
}

function defaultReviewArtifactDir(
  localOnly: boolean,
  itemNumber: number | undefined,
  itemNumbers: number[] | undefined,
): string {
  if (localExactReviewItem(localOnly, itemNumber, itemNumbers)) {
    return `artifacts/local-review-${itemNumber}`;
  }
  return "artifacts/reviews";
}

function defaultLocalRangeArtifactDir(targetDir: string): string {
  const gitArtifactRoot = run("git", ["rev-parse", "--git-path", "clawsweeper/reviews"], {
    cwd: targetDir,
  }).trim();
  return resolve(targetDir, gitArtifactRoot, `local-range-${Date.now()}-${process.pid}`);
}

function resolveReviewCheckout(options: {
  args: Args;
  artifactDir: string;
  humanLocalReview?: boolean;
  itemNumber: number | undefined;
  itemNumbers: number[] | undefined;
  localRange?: boolean;
  localOnly: boolean;
  profile: RepositoryProfile;
  verbose?: boolean;
}): ReviewCheckout {
  const {
    args,
    artifactDir,
    humanLocalReview,
    itemNumber,
    itemNumbers,
    localOnly,
    localRange,
    profile,
  } = options;
  const explicitTargetDir = hasExplicitReviewTargetDir(args);
  if (localExactReviewItem(localOnly, itemNumber, itemNumbers) && !explicitTargetDir) {
    const pull = localPullMetadata(itemNumber);
    const openclawDir = join(artifactDir, "target");
    if (humanLocalReview) {
      console.error("  mode: managed PR checkout");
      console.error(`  path: ${displayPath(openclawDir)}`);
      console.error(`  base: ${pull.baseRef}`);
    }
    prepareManagedLocalReviewCheckout({
      baseBranch: pull.baseRef,
      itemNumber,
      targetDir: openclawDir,
      targetRepo: targetRepo(),
      verbose: options.verbose,
    });
    return { mode: "managed", openclawDir, gitTargetBranch: pull.baseRef };
  }

  const openclawDir = resolve(
    stringArg(
      args.target_dir,
      stringArg(args.openclaw_dir, localRange ? process.cwd() : `../${profile.checkoutDir}`),
    ),
  );
  if (humanLocalReview) {
    console.error(`  mode: ${explicitTargetDir ? "supplied checkout" : "default checkout"}`);
    console.error(`  path: ${displayPath(openclawDir)}`);
  }
  if (localExactReviewItem(localOnly, itemNumber, itemNumbers)) {
    const baseBranch = tryLocalPullBaseBranch(itemNumber);
    if (baseBranch) {
      if (humanLocalReview) console.error(`  base: ${baseBranch}`);
      return {
        mode: explicitTargetDir ? "supplied" : "default",
        openclawDir,
        gitTargetBranch: baseBranch,
      };
    }
  }
  return { mode: explicitTargetDir ? "supplied" : "default", openclawDir };
}

type ManagedLocalReviewCheckoutOptions = {
  baseBranch: string;
  cloneUrl?: string;
  itemNumber: number;
  targetDir: string;
  targetRepo: string;
  verbose?: boolean | undefined;
};

function prepareManagedLocalReviewCheckout(options: ManagedLocalReviewCheckoutOptions): void {
  const { baseBranch, cloneUrl, itemNumber, targetDir, targetRepo, verbose } = options;
  const remoteUrl = cloneUrl ?? githubCloneUrl(targetRepo);
  ensureDir(dirname(targetDir));
  const targetExists = existsSync(targetDir);
  if (targetExists && !isGitWorkTree(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      throw new UserFacingCommandError(
        `Managed local checkout target already exists and is not a git checkout: ${targetDir}. ` +
          "Pass --target-dir to use an existing checkout or choose a different --artifact-dir.",
      );
    }
  }
  if (!targetExists || !isGitWorkTree(targetDir)) {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", remoteUrl, targetDir]);
  } else {
    ensureGitOriginRemote(targetDir, remoteUrl);
  }

  const branch = `clawsweeper/pr-${itemNumber}`;
  if (verbose) {
    console.error(
      `[review] ${new Date().toISOString()} local-checkout=managed target=${targetDir} pr=#${itemNumber} base=${baseBranch}`,
    );
  }
  run("git", ["fetch", "--force", "origin", `refs/pull/${itemNumber}/head`, "--depth=50"], {
    cwd: targetDir,
  });
  run("git", ["checkout", "-f", "-B", branch, "FETCH_HEAD"], { cwd: targetDir });
}

function isGitWorkTree(dir: string): boolean {
  try {
    return run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }) === "true";
  } catch {
    return false;
  }
}

function githubCloneUrl(targetRepo: string): string {
  return `https://github.com/${targetRepo}.git`;
}

function ensureGitOriginRemote(dir: string, remoteUrl: string): void {
  try {
    run("git", ["remote", "set-url", "origin", remoteUrl], { cwd: dir });
  } catch {
    run("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  }
}

function displayPath(path: string): string {
  const relativePath = relative(process.cwd(), path);
  if (!relativePath) return ".";
  return relativePath.startsWith("..") ? path : relativePath;
}

function displayDurationMs(ms: number): string {
  const boundedMs = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(boundedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

export function defaultReviewArtifactDirForTest(
  localOnly: boolean,
  itemNumber: number | undefined,
  itemNumbers: number[] | undefined,
): string {
  return defaultReviewArtifactDir(localOnly, itemNumber, itemNumbers);
}

export function prepareManagedLocalReviewCheckoutForTest(
  options: ManagedLocalReviewCheckoutOptions,
): void {
  prepareManagedLocalReviewCheckout(options);
}

export function reviewPromptTemplate(): string {
  reviewPromptTemplateCache ??= readFileSync(REVIEW_ITEM_PROMPT_PATH, "utf8");
  return reviewPromptTemplateCache;
}

function prCloseCoverageProofPromptTemplate(): string {
  prCloseCoverageProofPromptTemplateCache ??= readFileSync(
    PR_CLOSE_COVERAGE_PROOF_PROMPT_PATH,
    "utf8",
  );
  return prCloseCoverageProofPromptTemplateCache;
}

export function reviewDecisionSchemaText(): string {
  reviewDecisionSchemaCache ??= readFileSync(CLAWSWEEPER_DECISION_SCHEMA_PATH, "utf8");
  return reviewDecisionSchemaCache;
}

function contextJsonForPrompt(context: ItemContext): string {
  return JSON.stringify(context, null, 2);
}

type MediaProofCommandRunner = (
  command: string,
  args: readonly string[],
) => {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

const VIDEO_PROOF_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm", ".avi", ".mkv"]);
const MEDIA_PROOF_MANIFEST_FILE = "media-proof-manifest.json";
const MEDIA_PROOF_SUMMARY_FILE = "media-proof-summary.md";
const MAX_MEDIA_PROOF_URLS = 4;

function mediaProofCommandRunner(command: string, args: readonly string[]) {
  return spawnSync(command, [...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function trimTrailingUrlPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const char = raw.charCodeAt(end - 1);
    if (char !== 44 && char !== 46 && char !== 58 && char !== 59) break;
    end -= 1;
  }
  return raw.slice(0, end);
}

function proofVideoUrlsFromContext(context: ItemContext): string[] {
  const text = JSON.stringify(context);
  const matches = text.match(/https?:\/\/[^\s<>"'\\)]+/g) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const cleaned = trimTrailingUrlPunctuation(raw);
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    const pathname = parsed.pathname.toLowerCase();
    const isVideo = [...VIDEO_PROOF_EXTENSIONS].some((extension) => pathname.endsWith(extension));
    if (!isVideo || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
    if (urls.length >= MAX_MEDIA_PROOF_URLS) break;
  }
  return urls;
}

function mediaProofFileExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const extension = [...VIDEO_PROOF_EXTENSIONS].find((candidate) => pathname.endsWith(candidate));
    return extension ?? ".video";
  } catch {
    return ".video";
  }
}

function mediaProofSpawnDetail(result: ReturnType<MediaProofCommandRunner>): string {
  if (result.status === 0) return "ok";
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const error = result.error?.message ?? "";
  const detail = stderr || stdout || error || "command failed without output";
  return trimMiddle(detail, 1000);
}

function prepareMediaProofArtifacts(
  context: ItemContext,
  proofScratchDir: string,
  runner: MediaProofCommandRunner = mediaProofCommandRunner,
): PreparedMediaProof {
  const urls = proofVideoUrlsFromContext(context);
  if (urls.length === 0) return { manifestPath: null, summaryPath: null, artifacts: [] };
  ensureDir(proofScratchDir);
  const artifacts: PreparedMediaProofArtifact[] = [];
  for (const [index, url] of urls.entries()) {
    const ordinal = index + 1;
    const downloadedPath = join(
      proofScratchDir,
      `proof-video-${ordinal}${mediaProofFileExtension(url)}`,
    );
    const metadataPath = join(proofScratchDir, `proof-video-${ordinal}.ffprobe.json`);
    const contactSheetPath = join(proofScratchDir, `proof-video-${ordinal}.contact-sheet.jpg`);
    const download = runner("curl", [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "90",
      "--output",
      downloadedPath,
      url,
    ]);
    if (download.status !== 0) {
      artifacts.push({
        url,
        downloadedPath: null,
        metadataPath: null,
        contactSheetPath: null,
        status: "failed",
        detail: `download failed: ${mediaProofSpawnDetail(download)}`,
      });
      continue;
    }
    const metadata = runner("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      downloadedPath,
    ]);
    if (metadata.status !== 0) {
      artifacts.push({
        url,
        downloadedPath,
        metadataPath: null,
        contactSheetPath: null,
        status: "failed",
        detail: `ffprobe failed: ${mediaProofSpawnDetail(metadata)}`,
      });
      continue;
    }
    writeFileSync(metadataPath, String(metadata.stdout ?? "{}"), "utf8");
    const contactSheet = runner("ffmpeg", [
      "-hide_banner",
      "-y",
      "-i",
      downloadedPath,
      "-vf",
      "fps=1/5,scale=640:-1,tile=5x4",
      "-frames:v",
      "1",
      contactSheetPath,
    ]);
    if (contactSheet.status !== 0) {
      artifacts.push({
        url,
        downloadedPath,
        metadataPath,
        contactSheetPath: null,
        status: "failed",
        detail: `ffmpeg contact sheet failed: ${mediaProofSpawnDetail(contactSheet)}`,
      });
      continue;
    }
    artifacts.push({
      url,
      downloadedPath,
      metadataPath,
      contactSheetPath,
      status: "prepared",
      detail: "downloaded, probed, and converted to a contact sheet with ffmpeg",
    });
  }
  const manifestPath = join(proofScratchDir, MEDIA_PROOF_MANIFEST_FILE);
  const summaryPath = join(proofScratchDir, MEDIA_PROOF_SUMMARY_FILE);
  const prepared: PreparedMediaProof = { manifestPath, summaryPath, artifacts };
  writeFileSync(manifestPath, JSON.stringify(prepared, null, 2), "utf8");
  writeFileSync(summaryPath, mediaProofSummaryMarkdown(prepared), "utf8");
  return prepared;
}

function mediaProofSummaryMarkdown(prepared: PreparedMediaProof): string {
  const lines = ["# Prepared Media Proof", ""];
  for (const artifact of prepared.artifacts) {
    lines.push(`- ${artifact.status}: ${artifact.url}`);
    if (artifact.downloadedPath) lines.push(`  - downloaded: ${artifact.downloadedPath}`);
    if (artifact.metadataPath) lines.push(`  - ffprobe metadata: ${artifact.metadataPath}`);
    if (artifact.contactSheetPath) lines.push(`  - contact sheet: ${artifact.contactSheetPath}`);
    lines.push(`  - detail: ${artifact.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function mediaProofRuntimePrompt(summary: string | undefined, manifestPath: string | undefined) {
  const trimmed = summary?.trim();
  if (!trimmed || !manifestPath) return "";
  return `
- ClawSweeper preprocessed linked video proof with ffprobe/ffmpeg before this review. Read \`${manifestPath}\` and inspect any generated contact-sheet image paths before trying browser playback.
- If browser playback fails but ffprobe metadata and ffmpeg contact sheets are readable, assess the proof from those generated artifacts instead of treating the video as uninspectable.
- Only fall back to browser playback after checking the prepared ffmpeg artifacts. If both ffmpeg extraction and browser playback fail, report the exact failure from the manifest.
`;
}

function mediaProofRuntimeHints(
  proofScratchDir: string,
  preparedMediaProof: PreparedMediaProof,
): ReviewPromptRuntimeHints {
  const hints: ReviewPromptRuntimeHints = { proofScratchDir };
  if (preparedMediaProof.manifestPath)
    hints.mediaProofManifestPath = preparedMediaProof.manifestPath;
  if (preparedMediaProof.summaryPath && preparedMediaProof.artifacts.length) {
    hints.mediaProofSummary = mediaProofSummaryMarkdown(preparedMediaProof);
  }
  return hints;
}

export function proofVideoUrlsFromContextForTest(context: ItemContext): string[] {
  return proofVideoUrlsFromContext(context);
}

export function prepareMediaProofArtifactsForTest(
  context: ItemContext,
  proofScratchDir: string,
  runner: MediaProofCommandRunner,
): PreparedMediaProof {
  return prepareMediaProofArtifacts(context, proofScratchDir, runner);
}

function buildReviewPrompt(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
  runtimeHints: ReviewPromptRuntimeHints = {},
): ReviewPromptBuild {
  const prompt = reviewPromptTemplate();
  const contextJson = contextJsonForPrompt(context);
  const schema = reviewDecisionSchemaText();
  const proofScratchDir = runtimeHints.proofScratchDir?.trim();
  const maturityHelperPath = proofScratchDir
    ? `\`${proofScratchDir}/maturity-stable-shortlist.mjs\``
    : "the scratch directory as `maturity-stable-shortlist.mjs`";
  const mediaProofPrompt = mediaProofRuntimePrompt(
    runtimeHints.mediaProofSummary,
    runtimeHints.mediaProofManifestPath,
  );
  const extra = additionalPrompt.trim()
    ? `

## Maintainer Request

${additionalPrompt.trim()}
`
    : "";
  const text = `${prompt}

## Repository State

- Target repo: ${item.repo}
- Repository policy: ${repositoryProfileFor(item.repo).promptNote}
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

## Runtime Capabilities

- You may use the available network and read-only GitHub token to inspect PR body links, comments, screenshots, videos, logs, terminal output, and target-repo artifacts.
- Download proof artifacts into ${proofScratchDir ? `\`${proofScratchDir}\`` : "a temporary scratch directory"} before inspecting them.
- The target checkout is read-only for review. Do not modify repository files; use the scratch directory or /tmp for downloaded evidence and generated video stills/contact sheets.
- A token-light maturity helper is available at ${maturityHelperPath}. For issue maturity labels, first run \`node "$CLAWSWEEPER_PROOF_SCRATCH_DIR/maturity-stable-shortlist.mjs"\` from the target checkout and compare the issue against that shortlist; read the full scorecard or taxonomy only if the shortlist is ambiguous.
${mediaProofPrompt}

## GitHub Context

\`\`\`json
${contextJson}
\`\`\`
${extra}
`;
  return {
    text,
    telemetry: {
      promptChars: text.length,
      staticPromptChars: prompt.length,
      contextChars: contextJson.length,
      schemaChars: schema.length,
      additionalPromptChars: additionalPrompt.trim().length,
    },
  };
}

function prepareMaturityStableShortlistScript(proofScratchDir: string, openclawDir: string): void {
  const scorecardPath = join(openclawDir, "qa", "maturity-scores.yaml");
  const shortlist = maturityStableShortlist(scorecardPath);
  writeFileSync(
    join(proofScratchDir, "maturity-stable-shortlist.mjs"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(shortlist)});\n`,
    "utf8",
  );
}

function maturityStableShortlist(scorecardPath: string): string {
  const result = spawnSync(
    process.execPath,
    [MATURITY_STABLE_SHORTLIST_SCRIPT_PATH, scorecardPath],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status === 0) return result.stdout.trim();
  const detail =
    result.stderr?.trim() || result.error?.message || "maturity shortlist script failed";
  return `Unable to read maturity shortlist: ${detail}`;
}

function reviewPromptTelemetry(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
): ReviewPromptTelemetry {
  return buildReviewPrompt(item, context, git, additionalPrompt).telemetry;
}

export function reviewPromptTelemetryForTest(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
): ReviewPromptTelemetry {
  return reviewPromptTelemetry(item, context, git, additionalPrompt);
}

export function reviewPromptForTest(
  item: Item,
  context: ItemContext,
  git: GitInfo,
  additionalPrompt = "",
  runtimeHints: ReviewPromptRuntimeHints = {},
): string {
  return buildReviewPrompt(item, context, git, additionalPrompt, runtimeHints).text;
}

function codexFailureReason(detail: string, errorCode?: string | null): string {
  if (detail.includes("Codex dirtied the OpenClaw checkout")) return "dirty checkout";
  if (detail.includes("did not produce output")) return "missing structured output";
  if (detail.includes("invalid JSON")) return "invalid structured output";
  if (errorCode === "ENOBUFS") return "output buffer overflow";
  if (isTerminalCodexErrorMessage(detail)) return "model unavailable or access denied";
  if (detail.includes("timed out") || detail.includes("ETIMEDOUT")) return "timeout";
  if (
    /rate limit reached|tokens per min|\bTPM\b|requests per min|\b429\b|temporarily unavailable|overloaded|please try again in \d+(?:ms|s)/i.test(
      detail,
    )
  ) {
    return "retryable codex transport failure (capacity)";
  }
  if (
    /ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|transport failure/i.test(detail)
  ) {
    return "retryable codex transport failure (network)";
  }
  return "codex execution failed";
}

function codexFallbackMinBudgetMs(): number {
  const configured = Number(process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS?.trim());
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CODEX_FALLBACK_MIN_BUDGET_MS;
}

function codexFailureDecision(
  status: number | null,
  detail: string,
  stdout = "",
  stderr = "",
  processResult: { errorCode?: string | null; signal?: NodeJS.Signals | null } = {},
): Decision {
  const failureDetail = redactInternalCodexModel(detail || "No failure detail.");
  const safeStdout = redactedOutputTail(stdout || "No stdout captured.");
  const safeStderr = redactedOutputTail(stderr || "No stderr captured.");
  const structuredError = redactInternalCodexModel(codexJsonlFailureDetail(stdout));
  const terminalError =
    codexTerminalErrorDetail(structuredError) ||
    (!structuredError ? codexTerminalErrorDetail(safeStderr) : "");
  const processFailureDetail = [failureDetail, structuredError, terminalError]
    .filter(Boolean)
    .join("\n");
  const reason = codexFailureReason(processFailureDetail, processResult.errorCode);
  return {
    decision: "keep_open",
    closeReason: "none",
    confidence: "low",
    summary: `Codex review failed: ${reason}${status === null ? "" : ` (exit ${status})`}.`,
    changeSummary: "Review failed before ClawSweeper could summarize the requested change.",
    evidence: [
      evidenceEntry({ label: "failure reason", detail: reason }),
      evidenceEntry({ label: "codex failure detail", detail: trimMiddle(failureDetail, 4000) }),
      evidenceEntry({
        label: "codex stderr",
        detail: trimMiddle(safeStderr, 3000),
      }),
      evidenceEntry({
        label: "codex stdout",
        detail: trimMiddle(safeStdout, 2000),
      }),
      ...(terminalError
        ? [evidenceEntry({ label: "codex terminal error", detail: terminalError })]
        : []),
      ...(processResult.errorCode
        ? [evidenceEntry({ label: "process error code", detail: processResult.errorCode })]
        : []),
      ...(processResult.signal
        ? [evidenceEntry({ label: "process signal", detail: processResult.signal })]
        : []),
    ],
    likelyOwners: [
      {
        person: "unknown",
        role: "review did not complete",
        reason: "Codex failed before it could trace repository history.",
        commits: [],
        files: [],
        confidence: "low",
      },
    ],
    risks: ["No close action taken because the review did not complete."],
    bestSolution: "Retry the Codex review after fixing the execution failure.",
    maintainerDecision: emptyMaintainerDecision(),
    triagePriority: "none",
    impactLabels: [],
    mergeRiskLabels: [],
    maturityLabels: [],
    mergeRiskOptions: [],
    reviewMetrics: [],
    labelJustifications: [],
    itemCategory: "unclear",
    reproductionStatus: "unclear",
    reproductionConfidence: "low",
    requiresNewFeature: false,
    requiresNewConfigOption: false,
    requiresProductDecision: false,
    reproductionAssessment:
      "Unclear. The review failed before ClawSweeper could establish a reproduction path.",
    solutionAssessment:
      "Unclear. Retry the review first so ClawSweeper can evaluate the actual issue and fix direction.",
    visionFit: "not_applicable",
    visionFitReason: "Vision-fit assessment did not run because the Codex review failed.",
    visionFitEvidence: [],
    implementationComplexity: "not_applicable",
    autoImplementationCandidate: "none",
    rootCauseCluster: defaultRootCauseCluster(),
    agentsPolicyStatus: {
      found: false,
      readFully: false,
      applied: false,
      status: "unreadable_or_unclear",
      summary: "AGENTS.md policy status was not assessed because the Codex review failed.",
    },
    reviewFindings: [],
    securityReview: {
      status: "not_applicable",
      summary: "Security review did not run because the Codex review failed before completion.",
      concerns: [],
    },
    realBehaviorProof: {
      status: "not_applicable",
      summary: "Real behavior proof was not assessed because the Codex review failed.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    },
    prRating: {
      proofTier: "NA",
      patchTier: "NA",
      overallTier: "NA",
      summary: "PR readiness rating was not assessed because the Codex review failed.",
      nextSteps: [],
    },
    telegramVisibleProof: {
      status: "not_needed",
      summary: "Telegram visible proof was not assessed because the Codex review failed.",
    },
    mantisRecommendation: {
      status: "not_recommended",
      scenario: "none",
      reason: "Mantis was not assessed because the Codex review failed.",
      maintainerComment: "",
    },
    featureShowcase: {
      status: "none",
      reason: "Feature showcase was not assessed because the Codex review failed.",
    },
    overallCorrectness: "not a patch",
    overallConfidenceScore: 0,
    codexTerminalFailure: Boolean(terminalError),
    fixedRelease: null,
    fixedSha: null,
    fixedAt: null,
    fixedPullRequest: null,
    closeComment: "",
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: "Review did not complete, so no work-lane recommendation was made.",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
  };
}

export function codexFailureDecisionForTest(
  status: number | null,
  detail: string,
  stdout = "",
  stderr = "",
  processResult: { errorCode?: string | null; signal?: NodeJS.Signals | null } = {},
): Decision {
  return codexFailureDecision(status, detail, stdout, stderr, processResult);
}

function redactedOutputTail(value: string | Buffer | null | undefined, maxLength = 6000): string {
  return redactInternalCodexModel(
    safeOutputTail(value, maxLength)
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(
        /\b(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|GH_TOKEN|GITHUB_TOKEN)=([^\s"']+)/g,
        "$1=[REDACTED]",
      )
      .replace(
        /"((?:OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|GH_TOKEN|GITHUB_TOKEN))"\s*:\s*"[^"]*"/g,
        '"$1":"[REDACTED]"',
      ),
  );
}

class CodexReviewError extends Error {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode: string | null;
  readonly signal: NodeJS.Signals | null;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    status: number | null;
    stdout?: string;
    stderr?: string;
    errorCode?: string | null;
    signal?: NodeJS.Signals | null;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "CodexReviewError";
    this.status = options.status;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.errorCode = options.errorCode ?? null;
    this.signal = options.signal ?? null;
    this.retryable = options.retryable ?? false;
  }
}

function openclawDirtyStatus(openclawDir: string): string {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: openclawDir,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
}

interface FileModeSnapshot {
  path: string;
  mode: number;
}

function makeTreeReadOnly(path: string, snapshots: FileModeSnapshot[] = []): FileModeSnapshot[] {
  const stat = statSync(path);
  snapshots.push({ path, mode: stat.mode });
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.name === ".git" && entry.isDirectory()) continue;
    if (entry.isDirectory()) makeTreeReadOnly(child, snapshots);
    else {
      const childStat = statSync(child);
      snapshots.push({ path: child, mode: childStat.mode });
      chmodSync(child, childStat.mode & 0o111 ? 0o555 : 0o444);
    }
  }
  chmodSync(path, 0o555);
  return snapshots;
}

function restoreTreeModes(snapshots: readonly FileModeSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    try {
      chmodSync(snapshot.path, snapshot.mode);
    } catch {
      // Best-effort cleanup after review; missing temp files should not hide the review result.
    }
  }
}

export function makeTreeReadOnlyForTest(path: string): FileModeSnapshot[] {
  return makeTreeReadOnly(path);
}

export function restoreTreeModesForTest(snapshots: readonly FileModeSnapshot[]): void {
  restoreTreeModes(snapshots);
}

export function runCodexForTest(options: Parameters<typeof runCodex>[0]): Decision {
  return runCodex(options);
}

export function reviewCodexForcedLoginMethodForTest(args: Args): string {
  return reviewCodexForcedLoginMethod(args);
}

function reviewCodexForcedLoginMethod(args: Args): string {
  return stringArg(args.codex_forced_login_method, "");
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
  forcedLoginMethod?: string;
  preserveCodexAuth?: boolean;
  preferWindowsAppBinary?: boolean;
  timeoutMs: number;
  workDir: string;
  additionalPrompt?: string;
  proofScratchDir?: string;
  prompt?: string;
  quietLogs?: boolean;
  extraCodexConfig?: string[];
}): Decision {
  ensureDir(options.workDir);
  const proofScratchDir =
    options.proofScratchDir ?? join(options.workDir, "proof-scratch", String(options.item.number));
  ensureDir(proofScratchDir);
  prepareMaturityStableShortlistScript(proofScratchDir, options.openclawDir);
  const preparedMediaProof = options.prompt
    ? { manifestPath: null, summaryPath: null, artifacts: [] }
    : prepareMediaProofArtifacts(options.context, proofScratchDir);
  const promptPath = join(options.workDir, `${options.item.number}.prompt.md`);
  const outputPath = join(options.workDir, `${options.item.number}.json`);
  const prompt =
    options.prompt ??
    buildReviewPrompt(
      options.item,
      options.context,
      options.git,
      options.additionalPrompt,
      mediaProofRuntimeHints(proofScratchDir, preparedMediaProof),
    ).text;
  writeFileSync(promptPath, prompt, "utf8");
  const dirtyBefore = openclawDirtyStatus(options.openclawDir);
  if (dirtyBefore) {
    throw new Error(
      `OpenClaw checkout is dirty before reviewing #${options.item.number}:\n${dirtyBefore}`,
    );
  }
  const configuredAttempts = Number(process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS ?? 3);
  const maxAttempts = Math.min(
    5,
    Math.max(1, Number.isFinite(configuredAttempts) ? Math.floor(configuredAttempts) : 3),
  );
  const startedAt = Date.now();
  const runReviewPass = (reasoningEffort: string, passAttempts: number): Decision => {
    const codexConfig = [`model_reasoning_effort="${reasoningEffort}"`, 'approval_policy="never"'];
    if (options.forcedLoginMethod) {
      codexConfig.splice(1, 0, `forced_login_method="${options.forcedLoginMethod}"`);
    } else if (!options.preserveCodexAuth) {
      codexConfig.splice(1, 0, codexLoginConfig());
    }
    if (options.serviceTier) codexConfig.splice(1, 0, `service_tier="${options.serviceTier}"`);
    if (options.extraCodexConfig) codexConfig.push(...options.extraCodexConfig);
    for (let attempt = 1; attempt <= passAttempts; attempt += 1) {
      if (existsSync(outputPath)) unlinkSync(outputPath);
      const remainingMs = options.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new CodexReviewError({
          message: `Codex review timed out for #${options.item.number} after ${options.timeoutMs}ms.`,
          status: null,
          retryable: false,
        });
      }
      const result = runCodexProcess({
        args: [
          "exec",
          ...codexModelArgs(options.model),
          ...codexConfig.flatMap((config) => ["-c", config]),
          "-C",
          options.openclawDir,
          "--output-schema",
          CLAWSWEEPER_DECISION_SCHEMA_PATH,
          "--output-last-message",
          outputPath,
          "--json",
          "--sandbox",
          options.sandboxMode,
          "--add-dir",
          proofScratchDir,
          "-",
        ],
        cwd: options.openclawDir,
        env: {
          ...codexEnv({
            ghToken: process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
            preserveCodexAuth: options.preserveCodexAuth,
          }),
          CLAWSWEEPER_PROOF_SCRATCH_DIR: proofScratchDir,
          ...(options.preferWindowsAppBinary ? { CLAWSWEEPER_PREFER_WINDOWS_CODEX_APP: "1" } : {}),
        },
        input: prompt,
        stderrPath: join(options.workDir, `${options.item.number}.${attempt}.codex.stderr.log`),
        stdoutPath: join(options.workDir, `${options.item.number}.${attempt}.codex.stdout.log`),
        timeoutMs: remainingMs,
      });
      const dirtyAfter = openclawDirtyStatus(options.openclawDir);
      if (dirtyAfter) {
        throw new Error(
          `Codex dirtied the OpenClaw checkout while reviewing #${options.item.number}:\n${dirtyAfter}`,
        );
      }
      const stderr = redactedOutputTail(result.stderr);
      const stdout = redactedOutputTail(result.stdout);
      const errorCode = codexProcessErrorCode(result.error);
      let failureDetail = "";
      if (result.error) {
        failureDetail = `Codex review failed for #${options.item.number}: ${redactInternalCodexModel(result.error.message)}`;
      }
      const hasOutput = existsSync(outputPath);
      if (!result.error && hasOutput) {
        try {
          const decision = parseDecision(
            JSON.parse(readFileSync(outputPath, "utf8").trim()),
            options.item,
          );
          if (result.status !== 0) {
            if (!options.quietLogs) {
              console.error(
                `[review] ${new Date().toISOString()} codex-exit-nonzero-output-accepted #${
                  options.item.number
                } status=${result.status ?? "unknown"} stderr=${JSON.stringify(stderr)}`,
              );
            }
          }
          return decision;
        } catch (error) {
          failureDetail = `Codex review failed for #${options.item.number} with exit ${
            result.status ?? "unknown"
          } and wrote invalid JSON or schema-invalid output to ${outputPath}: ${
            error instanceof Error ? error.message : String(error)
          }.`;
        }
      } else if (!result.error) {
        failureDetail =
          result.status === 0
            ? `Codex review did not produce output for #${options.item.number}: Codex exited successfully but did not write ${outputPath}.\n${stdout || "No stdout."}`
            : `Codex review failed for #${options.item.number} with exit ${result.status ?? "unknown"}.`;
      }
      const structuredError = redactInternalCodexModel(codexJsonlFailureDetail(result.stdout));
      const trustedProcessError = structuredError || stderr;
      const processFailureDetail = [failureDetail, trustedProcessError].filter(Boolean).join("\n");
      const terminalFailure = isTerminalCodexErrorMessage(processFailureDetail);
      const retryable =
        !terminalFailure &&
        (result.signal !== null ||
          (result.status === 0 && !hasOutput) ||
          isRetryableCodexErrorMessage(processFailureDetail) ||
          /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|transport failure)\b/i.test(
            processFailureDetail,
          ));
      if (retryable && attempt < passAttempts) {
        const delayMs = codexRetryDelayMs(processFailureDetail, attempt);
        if (Date.now() - startedAt + delayMs < options.timeoutMs) {
          if (!options.quietLogs) {
            console.error(
              `[review] ${new Date().toISOString()} codex-retry #${options.item.number} attempt=${
                attempt + 1
              }/${passAttempts} delay_ms=${delayMs} reason=transient_transport`,
            );
          }
          sleepMs(delayMs);
          continue;
        }
      }
      throw new CodexReviewError({
        message: processFailureDetail || `Codex review failed for #${options.item.number}.`,
        status: result.status,
        stdout,
        stderr,
        errorCode,
        signal: result.signal,
        retryable,
      });
    }
    throw new CodexReviewError({
      message: `Codex review failed for #${options.item.number}.`,
      status: null,
      retryable: false,
    });
  };

  try {
    return runReviewPass(options.reasoningEffort, maxAttempts);
  } catch (error) {
    if (!(error instanceof CodexReviewError) || !error.retryable) throw error;
    const retryDetail = [error.message, error.stderr, error.stdout].filter(Boolean).join("\n");
    const delayMs = codexRetryDelayMs(retryDetail, maxAttempts);
    const remainingMs = options.timeoutMs - (Date.now() - startedAt);
    if (remainingMs < delayMs + codexFallbackMinBudgetMs()) throw error;
    if (!options.quietLogs) {
      console.error(
        `[review] ${new Date().toISOString()} codex-final-retry #${options.item.number} reason=transient_transport reasoning_effort=${options.reasoningEffort} delay_ms=${delayMs} remaining_ms=${remainingMs}`,
      );
    }
    sleepMs(delayMs);
    try {
      return runReviewPass(options.reasoningEffort, 1);
    } catch (retryError) {
      if (!(retryError instanceof CodexReviewError)) throw retryError;
      throw new CodexReviewError({
        message: `${error.message}\nFinal ${options.reasoningEffort}-reasoning retry also failed: ${retryError.message}`,
        status: retryError.status ?? error.status,
        stdout: retryError.stdout || error.stdout,
        stderr: error.stderr || retryError.stderr,
        errorCode: error.errorCode ?? retryError.errorCode,
        signal: error.signal ?? retryError.signal,
        retryable: error.retryable,
      });
    }
  }
}

function stripTextFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? (match[1]?.trim() ?? trimmed) : trimmed;
}

function buildAssistPrompt(options: {
  item: Item;
  context: ItemContext;
  question: string;
  sourceCommentUrl: string;
  author: string;
  mode?: string;
  lens?: string;
}): string {
  if (options.mode === "visual")
    return buildVisualPrompt({
      item: options.item,
      context: options.context,
      question: options.question,
      sourceCommentUrl: options.sourceCommentUrl,
      author: options.author,
      ...(options.lens === undefined ? {} : { lens: options.lens }),
    });
  return [
    "You are ClawSweeper assist, a lightweight read-only maintainer Q&A helper for GitHub issues and pull requests.",
    "",
    "Hard safety contract:",
    "- Answer the maintainer's question concisely from the supplied context.",
    "- Do not recommend closing, merging, labeling, pushing, rebasing, or repairing as an executed action.",
    "- Do not emit hidden ClawSweeper verdict, action, security, or review markers.",
    "- If the question needs a full correctness review, say that and suggest `@clawsweeper review`.",
    "- If the question needs branch edits or CI repair, say that and suggest the existing repair command.",
    "- Prefer concrete evidence: check names, comments, files, commit SHAs, timestamps, and URLs present in context.",
    "",
    "Response format:",
    "- Start with `ClawSweeper assist:` followed by the direct answer.",
    "- Include short `Evidence:` bullets when evidence exists.",
    "- Include one `Suggested next action:` line.",
    "",
    "Request metadata:",
    `- Repository: ${options.item.repo}`,
    `- Item: #${options.item.number}`,
    `- Type: ${options.item.kind}`,
    `- Title: ${options.item.title}`,
    `- URL: ${options.item.url}`,
    `- Request author: ${options.author || "unknown"}`,
    `- Source comment: ${options.sourceCommentUrl || "unknown"}`,
    "",
    "Maintainer question:",
    options.question,
    "",
    "GitHub context JSON:",
    "```json",
    JSON.stringify(options.context, null, 2),
    "```",
  ].join("\n");
}

function buildVisualPrompt(options: {
  item: Item;
  context: ItemContext;
  question: string;
  sourceCommentUrl: string;
  author: string;
  lens?: string;
}): string {
  const requestedLens = normalizeVisualLens(options.lens);
  return [
    "You are ClawSweeper visual brief, a read-only maintainer judgment helper for GitHub issues and pull requests.",
    "",
    "Hard safety contract:",
    "- Create a compact GitHub-comment-friendly ASCII/text visual brief only from supplied context.",
    "- Advisory only: maintainers remain the final judges.",
    "- Do not recommend closing, merging, labeling, pushing, rebasing, or repairing as an executed action.",
    "- Do not emit hidden ClawSweeper verdict, action, security, or review markers.",
    "- Avoid Mermaid and generated images. Use ASCII boxes, arrows, split screens, state tables, and checklists.",
    "- Use glyphs only in public markdown when they clarify states or transitions; include a legend when more than three glyphs appear.",
    "- Standard glyph meanings: ✅ expected/preserved/working/proven; ❌ broken/dropped/failing/rejected path; ⚠️ maintainer risk/unresolved concern/tradeoff; 🐛 confirmed bug path or pre-fix broken behavior; 🔒 credential/security/privacy/trust boundary; 💾 persisted disk state/storage/file output; 🧠 runtime/in-memory/session/active process state; 🧑‍⚖️ maintainer judgment point.",
    "- Do not decorate every noun. Prefer glyphs on important states, transitions, risks, proof markers, and maintainer judgment points.",
    "",
    "Lens guidance:",
    "- ux: user/operator visible behavior.",
    "- flow: routing, delivery, queues, providers, tools, or pipelines.",
    "- state: sessions, locks, auth, config, identity, lifecycle, flags, or modes.",
    "- data: payloads, protocol responses, redaction, projection, storage, schemas, or migrations.",
    "- proof: missing, stale, disputed, or confusing behavior proof.",
    "- risk: compatibility, operator impact, security boundary, availability, automation, or session-state tradeoff.",
    "- maintainer: product, policy, API, UX, or architecture judgment.",
    "",
    "Response format:",
    "- Start with `# Visual brief`.",
    `- Requested lens: ${requestedLens}. If it is auto, choose the strongest lens and name it near the top.`,
    "- Prefer compact visuals over long prose.",
    "- Show before/after or current/proposed behavior when applicable.",
    "- Show remaining risk or maintainer judgment when applicable.",
    "- Clearly state that this is advisory and maintainers remain the final judges.",
    "- End with this footer only when it has concrete content. Omit empty fields.",
    "",
    "## Maintainer ruling",
    "",
    "Benefit:",
    "Risk:",
    "Proof needed:",
    "Recommended next action:",
    "Question presented:",
    "",
    "Request metadata:",
    `- Repository: ${options.item.repo}`,
    `- Item: #${options.item.number}`,
    `- Type: ${options.item.kind}`,
    `- Title: ${options.item.title}`,
    `- URL: ${options.item.url}`,
    `- Request author: ${options.author || "unknown"}`,
    `- Source comment: ${options.sourceCommentUrl || "unknown"}`,
    `- Maintainer request: ${options.question || `visualize ${requestedLens}`}`,
    "",
    "GitHub context JSON:",
    "```json",
    JSON.stringify(options.context, null, 2),
    "```",
  ].join("\n");
}

function runCodexAssist(options: {
  item: Item;
  context: ItemContext;
  question: string;
  sourceCommentUrl: string;
  author: string;
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
  timeoutMs: number;
  workDir: string;
  mode?: string;
  lens?: string;
}): string {
  ensureDir(options.workDir);
  const promptPath = join(options.workDir, `${options.item.number}.assist.prompt.md`);
  const outputPath = join(options.workDir, `${options.item.number}.assist.md`);
  const prompt = buildAssistPrompt({
    item: options.item,
    context: options.context,
    question: options.question,
    sourceCommentUrl: options.sourceCommentUrl,
    author: options.author,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.lens === undefined ? {} : { lens: options.lens }),
  });
  writeFileSync(promptPath, prompt, "utf8");
  const codexConfig = [
    `model_reasoning_effort="${options.reasoningEffort}"`,
    codexLoginConfig(),
    'approval_policy="never"',
  ];
  const result = runCodexProcess({
    args: [
      "exec",
      ...codexModelArgs(options.model),
      ...codexConfig.flatMap((config) => ["-c", config]),
      "--output-last-message",
      outputPath,
      "--sandbox",
      options.sandboxMode,
      "-",
    ],
    cwd: ROOT,
    env: codexEnv(),
    input: prompt,
    timeoutMs: options.timeoutMs,
  });
  if (result.error || result.status !== 0 || !existsSync(outputPath)) {
    const detail =
      result.error instanceof Error
        ? result.error.message
        : `exit ${result.status ?? "unknown"}: ${
            safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."
          }`;
    throw new Error(`Codex assist failed for #${options.item.number}: ${detail}`);
  }
  return stripTextFence(readFileSync(outputPath, "utf8"));
}

function assistCommentMarker(commentId: string): string {
  return `<!-- clawsweeper-assist:${commentId || "unknown"} -->`;
}

const VISUAL_LENSES = new Set(["ux", "flow", "state", "data", "proof", "risk", "maintainer"]);

function normalizeVisualLens(value: unknown): string {
  const lens = typeof value === "string" ? value.trim().toLowerCase() : "auto";
  return VISUAL_LENSES.has(lens) ? lens : "auto";
}

function visualCommentMarker(number: number, lens: string, headSha: string): string {
  return `<!-- clawsweeper-visual item=${number} lens=${normalizeVisualLens(lens)} sha=${headSha || "na"} -->`;
}

const MAINTAINER_RULING_FIELDS = new Set([
  "Benefit",
  "Risk",
  "Proof needed",
  "Recommended next action",
  "Question presented",
]);

export function stripEmptyMaintainerRulingFieldsForTest(body: string): string {
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Maintainer ruling\s*$/i.test(line.trim()));
  if (headingIndex === -1) return body;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/.test(lines[index]?.trim() ?? "")) {
      endIndex = index;
      break;
    }
  }

  const sectionLines = lines.slice(headingIndex + 1, endIndex);
  const keptSectionLines = sectionLines.filter((line) => {
    const match = line.trim().match(/^([^:]+):\s*$/);
    return !match || !MAINTAINER_RULING_FIELDS.has(match[1]?.trim() ?? "");
  });
  const hasConcreteContent = keptSectionLines.some((line) => line.trim().length > 0);
  const replacement = hasConcreteContent ? [lines[headingIndex]!, ...keptSectionLines] : [];

  return [...lines.slice(0, headingIndex), ...replacement, ...lines.slice(endIndex)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderAssistComment(options: {
  body: string;
  model: string;
  reasoningEffort: string;
  sourceCommentUrl: string;
  sourceCommentId: string;
}): string {
  const body = options.body.trim() || "ClawSweeper assist: I could not produce an answer.";
  const sourceLine = options.sourceCommentUrl
    ? `Source: ${options.sourceCommentUrl}`
    : `Source comment: ${options.sourceCommentId || "unknown"}`;
  return [
    body,
    "",
    "---",
    `${sourceLine}`,
    `Assist reasoning: ${options.reasoningEffort}.`,
    assistCommentMarker(options.sourceCommentId),
  ].join("\n");
}

function renderVisualComment(options: {
  body: string;
  item: Item;
  context: ItemContext;
  lens: string;
  model: string;
  reasoningEffort: string;
  sourceCommentUrl: string;
  sourceCommentId: string;
}): string {
  const body =
    stripEmptyMaintainerRulingFieldsForTest(options.body).trim() ||
    "# Visual brief\n\nNo visual brief could be produced.";
  const headSha = itemHeadSha(options.item, options.context);
  const sourceLine = options.sourceCommentUrl
    ? `Source: ${options.sourceCommentUrl}`
    : `Source comment: ${options.sourceCommentId || "unknown"}`;
  return [
    visualCommentMarker(options.item.number, options.lens, headSha),
    `${sourceLine}`,
    `Visual reasoning: ${options.reasoningEffort}.`,
    "",
    body,
  ].join("\n");
}

function postAssistComment(number: number, body: string): void {
  const payload = writeCommentPayload(number, body);
  ghWithRetry([
    "api",
    `repos/${targetRepo()}/issues/${number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
  ]);
}

function itemHeadSha(item: Item, context: ItemContext): string {
  if (item.kind !== "pull_request") return "na";
  const pull = asRecord(context.pullRequest);
  const head = asRecord(pull.head);
  return typeof head.sha === "string" ? head.sha.trim() || "na" : "na";
}

function postOrUpdateVisualComment(
  number: number,
  lens: string,
  headSha: string,
  body: string,
): void {
  const marker = visualCommentMarker(number, lens, headSha);
  const existing = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments?per_page=100`)
    .map(asRecord)
    .find((comment) => typeof comment.body === "string" && comment.body.includes(marker));
  const payload = writeCommentPayload(number, body);
  const existingId =
    typeof existing?.id === "number" || typeof existing?.id === "string" ? existing.id : null;
  if (existingId) {
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/comments/${existingId}`,
      "--method",
      "PATCH",
      "--input",
      payload,
    ]);
    return;
  }
  ghWithRetry([
    "api",
    `repos/${targetRepo()}/issues/${number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
  ]);
}

function closeReasonText(reason: CloseReason): string {
  switch (reason) {
    case "implemented_on_main":
      return "already implemented on main";
    case "mostly_implemented_on_main":
      return "mostly implemented on main";
    case "cannot_reproduce":
      return "cannot reproduce on current main";
    case "clawhub":
      return "belongs on ClawHub";
    case "duplicate_or_superseded":
      return "duplicate or superseded";
    case "low_signal_unmergeable_pr":
      return "low-signal unmergeable PR";
    case "stalled_unproven_pr":
      return "stalled PR without requested real-behavior proof";
    case "abandoned_pr":
      return "abandoned inactive PR";
    case "unconfirmed_product_direction":
      return "feature-like PR without confirmed product direction";
    case "not_actionable_in_repo":
      return "not actionable in this repository";
    case "incoherent":
      return "too unclear to act on";
    case "stale_insufficient_info":
      return "stale with insufficient information";
    case "none":
      return "kept open";
  }
}

function repoUrlFor(repo: string, path = ""): string {
  return `https://github.com/${normalizeRepo(repo)}${path}`;
}

function repoUrl(path = ""): string {
  return repoUrlFor(targetRepo(), path);
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

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function releaseUrl(tag: string): string {
  return repoUrl(`/releases/tag/${encodeURIComponent(tag)}`);
}

function itemUrlFor(repo: string, number: number, kind: ItemKind = "issue"): string {
  return repoUrlFor(repo, `/${kind === "pull_request" ? "pull" : "issues"}/${number}`);
}

function reportFileUrl(
  number: number,
  path = `records/${targetProfile().slug}/items/${number}.md`,
): string {
  return reportUrl(`/blob/main/${githubPath(path)}`);
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
  const docsUrl = targetProfile().docsUrl;
  if (!docsUrl || !file.startsWith("docs/")) return null;
  const page = file
    .replace(/^docs\//, "")
    .replace(/\/index\.mdx?$/, "")
    .replace(/\.mdx?$/, "");
  return `${docsUrl}/${page}`;
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

function formatReviewFreshnessTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const utcTime = date.toISOString().slice(11, 16);
  const eastern = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  })
    .format(date)
    .replace(" at ", ", ");
  const easternDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(date);
  const utcDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  const utc = easternDate === utcDate ? utcTime : `${utcDate}, ${utcTime}`;
  return `${eastern} ET / ${utc} UTC`;
}

function workflowStatusBlock(options?: {
  state?: string | undefined;
  detail?: string | undefined;
  runUrl?: string | undefined;
  updatedAt?: string | undefined;
  profile?: RepositoryProfile | undefined;
  plannedCount?: number | undefined;
  plannedCapacity?: number | undefined;
  plannedShards?: number | undefined;
  activeCodex?: number | undefined;
  dueBacklog?: number | undefined;
  oldestUnreviewedAt?: string | undefined;
  capacityReason?: string | undefined;
  inheritedLabelCleanups?: number | undefined;
  selfHealConflictRepairs?: number | undefined;
  failedReviewRetries?: number | undefined;
  failedReviewRetryExhaustions?: number | undefined;
  botOwnedProofDecisionsRequested?: number | undefined;
  botOwnedProofDispatches?: number | undefined;
}): string {
  const profile = options?.profile ?? targetProfile();
  const updatedAt = formatTimestamp(options?.updatedAt ?? new Date().toISOString());
  const state = options?.state ?? "Idle";
  const detail = options?.detail ?? "No workflow status has been published yet.";
  const metrics = workflowStatusMetricLines(options ?? {});
  const metricBlock = metrics.length > 0 ? `\n\n${metrics.join("\n")}` : "";
  const runLine = options?.runUrl ? `\nRun: ${markdownLink(options.runUrl, options.runUrl)}` : "";
  return `${profileStatusStart(profile)}
**Workflow status**

Repository: ${markdownLink(profile.targetRepo, repoUrlFor(profile.targetRepo))}

Updated: ${updatedAt}

State: ${state}

${detail}${metricBlock}${runLine}
${profileStatusEnd(profile)}`;
}

function workflowStatusMetricLines(options: {
  plannedCount?: number | undefined;
  plannedCapacity?: number | undefined;
  plannedShards?: number | undefined;
  activeCodex?: number | undefined;
  dueBacklog?: number | undefined;
  oldestUnreviewedAt?: string | undefined;
  capacityReason?: string | undefined;
  inheritedLabelCleanups?: number | undefined;
  selfHealConflictRepairs?: number | undefined;
  failedReviewRetries?: number | undefined;
  failedReviewRetryExhaustions?: number | undefined;
  botOwnedProofDecisionsRequested?: number | undefined;
  botOwnedProofDispatches?: number | undefined;
}): string[] {
  const lines: string[] = [];
  if (
    options.plannedCount !== undefined ||
    options.plannedShards !== undefined ||
    options.plannedCapacity !== undefined
  ) {
    lines.push(
      `Plan: ${formatStatusNumber(options.plannedCount)} items across ${formatStatusNumber(
        options.plannedShards,
      )} shards (capacity ${formatStatusNumber(options.plannedCapacity)}).`,
    );
  }
  if (options.activeCodex !== undefined) {
    lines.push(`Active Codex target: ${formatStatusNumber(options.activeCodex)}.`);
  }
  if (options.dueBacklog !== undefined) {
    lines.push(`Due backlog scanned: ${formatStatusNumber(options.dueBacklog)}.`);
  }
  if (options.oldestUnreviewedAt) {
    lines.push(`Oldest unreviewed: ${formatTimestamp(options.oldestUnreviewedAt)}.`);
  }
  if (options.capacityReason) {
    lines.push(`Capacity reason: ${options.capacityReason}.`);
  }
  if (options.inheritedLabelCleanups !== undefined) {
    lines.push(`Inherited label cleanups: ${formatStatusNumber(options.inheritedLabelCleanups)}.`);
  }
  if (options.selfHealConflictRepairs !== undefined) {
    lines.push(
      `Self-heal conflict repairs: ${formatStatusNumber(options.selfHealConflictRepairs)}.`,
    );
  }
  if (options.failedReviewRetries !== undefined) {
    lines.push(`Failed-review retries: ${formatStatusNumber(options.failedReviewRetries)}.`);
  }
  if (options.failedReviewRetryExhaustions !== undefined) {
    lines.push(
      `Failed-review retry exhaustions: ${formatStatusNumber(options.failedReviewRetryExhaustions)}.`,
    );
  }
  if (options.botOwnedProofDecisionsRequested !== undefined) {
    lines.push(
      `Bot-owned proof decisions requested: ${formatStatusNumber(options.botOwnedProofDecisionsRequested)}.`,
    );
  }
  if (options.botOwnedProofDispatches !== undefined) {
    lines.push(
      `Bot-owned proof dispatches: ${formatStatusNumber(options.botOwnedProofDispatches)}.`,
    );
  }
  return lines;
}

function formatStatusNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unknown" : String(value);
}

function readSweepStatusSummary(profile = targetProfile()): WorkflowStatusSummary | null {
  const path = sweepStatusPath(profile);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      updatedAt: stringOrUndefined(parsed.updated_at),
      state: stringOrUndefined(parsed.state) ?? "Idle",
      detail: stringOrUndefined(parsed.detail) ?? "No workflow status has been published yet.",
      runUrl: stringOrUndefined(parsed.run_url),
      applyHealth: recordOrUndefined(parsed.apply_health),
      lastCloseApplyHealth: recordOrUndefined(parsed.last_close_apply_health),
      plannedCount: numberOrUndefined(parsed.planned_count),
      plannedCapacity: numberOrUndefined(parsed.planned_capacity),
      plannedShards: numberOrUndefined(parsed.planned_shards),
      activeCodex: numberOrUndefined(parsed.active_codex),
      dueBacklog: numberOrUndefined(parsed.due_backlog),
      oldestUnreviewedAt: stringOrUndefined(parsed.oldest_unreviewed_at),
      capacityReason: stringOrUndefined(parsed.capacity_reason),
      inheritedLabelCleanups: numberOrUndefined(parsed.inherited_label_cleanups),
      selfHealConflictRepairs: numberOrUndefined(parsed.self_heal_conflict_repairs),
      failedReviewRetries: numberOrUndefined(parsed.failed_review_retries),
      failedReviewRetryExhaustions: numberOrUndefined(parsed.failed_review_retry_exhaustions),
      botOwnedProofDecisionsRequested: numberOrUndefined(
        parsed.bot_owned_proof_decisions_requested,
      ),
      botOwnedProofDispatches: numberOrUndefined(parsed.bot_owned_proof_dispatches),
    };
  } catch {
    return null;
  }
}

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

function currentWorkflowStatusBlock(readme: string, profile = targetProfile()): string {
  const statusSummary = readSweepStatusSummary(profile);
  if (statusSummary) return workflowStatusBlock({ ...statusSummary, profile });
  const profilePattern = new RegExp(
    `${escapeRegExp(profileStatusStart(profile))}[\\s\\S]*?${escapeRegExp(profileStatusEnd(profile))}`,
  );
  const profileMatch = readme.match(profilePattern)?.[0];
  if (profileMatch) {
    const summary = workflowStatusSummary(profileMatch);
    if (
      summary.state === "Idle" &&
      summary.detail === "No workflow status has been published yet." &&
      !summary.runUrl
    ) {
      return workflowStatusBlock({ profile, updatedAt: "unknown" });
    }
    return profileMatch;
  }
  return workflowStatusBlock({ profile, updatedAt: "unknown" });
}

function workflowStatusSummary(block: string): WorkflowStatusSummary {
  const updatedAt = block.match(/^Updated: (.+)$/m)?.[1];
  const state = block.match(/^State: (.+)$/m)?.[1] ?? "Idle";
  const runUrl = block.match(/^Run: \[([^\]]+)\]\([^)]+\)$/m)?.[1];
  const detailMatch = block.match(
    /^State: .+\n\n([\s\S]*?)(?:\n\nPlan: |\n\nActive Codex target: |\n\nDue backlog scanned: |\n\nOldest unreviewed: |\n\nCapacity reason: |\n\nInherited label cleanups: |\n\nSelf-heal conflict repairs: |\n\nFailed-review retries: |\n\nFailed-review retry exhaustions: |\n\nBot-owned proof decisions requested: |\n\nBot-owned proof dispatches: |\nRun: |\n<!-- clawsweeper-status)/m,
  );
  const detail = detailMatch?.[1]?.trim() || "No workflow status has been published yet.";
  const planMatch = block.match(/^Plan: (\d+) items across (\d+) shards \(capacity (\d+)\)\.$/m);
  const activeCodex = numberOrUndefined(block.match(/^Active Codex target: (\d+)\.$/m)?.[1]);
  const dueBacklog = numberOrUndefined(block.match(/^Due backlog scanned: (\d+)\.$/m)?.[1]);
  const oldestUnreviewedAt = block.match(/^Oldest unreviewed: (.+)\.$/m)?.[1];
  const capacityReason = block.match(/^Capacity reason: (.+)\.$/m)?.[1];
  const inheritedLabelCleanups = numberOrUndefined(
    block.match(/^Inherited label cleanups: (\d+)\.$/m)?.[1],
  );
  const selfHealConflictRepairs = numberOrUndefined(
    block.match(/^Self-heal conflict repairs: (\d+)\.$/m)?.[1],
  );
  const failedReviewRetries = numberOrUndefined(
    block.match(/^Failed-review retries: (\d+)\.$/m)?.[1],
  );
  const failedReviewRetryExhaustions = numberOrUndefined(
    block.match(/^Failed-review retry exhaustions: (\d+)\.$/m)?.[1],
  );
  const botOwnedProofDecisionsRequested = numberOrUndefined(
    block.match(/^Bot-owned proof decisions requested: (\d+)\.$/m)?.[1],
  );
  const botOwnedProofDispatches = numberOrUndefined(
    block.match(/^Bot-owned proof dispatches: (\d+)\.$/m)?.[1],
  );
  return {
    updatedAt,
    state,
    detail,
    runUrl,
    applyHealth: undefined,
    lastCloseApplyHealth: undefined,
    plannedCount: numberOrUndefined(planMatch?.[1]),
    plannedShards: numberOrUndefined(planMatch?.[2]),
    plannedCapacity: numberOrUndefined(planMatch?.[3]),
    activeCodex,
    dueBacklog,
    oldestUnreviewedAt,
    capacityReason,
    inheritedLabelCleanups,
    selfHealConflictRepairs,
    failedReviewRetries,
    failedReviewRetryExhaustions,
    botOwnedProofDecisionsRequested,
    botOwnedProofDispatches,
  };
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
  if (decision.fixedPullRequest?.confidence === "high")
    parts.push(`merged PR ${linkedPullRequest(decision.fixedPullRequest)}`);
  if (decision.fixedRelease) parts.push(`release ${linkedRelease(decision.fixedRelease)}`);
  if (decision.fixedSha) parts.push(`commit ${linkedSha(decision.fixedSha)}`);
  if (!decision.fixedRelease && decision.fixedAt)
    parts.push(`main fix timestamp ${decision.fixedAt}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function fixedPullRequestFromUnknown(value: unknown, source: string): FixedPullRequest | null {
  const pull = asRecord(value);
  const number = pull.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  const url = typeof pull.url === "string" ? pull.url : pull.html_url;
  if (typeof url !== "string" || !url) return null;
  const title = typeof pull.title === "string" ? pull.title : `#${number}`;
  const mergedAt = typeof pull.mergedAt === "string" ? pull.mergedAt : pull.merged_at;
  const merged = pull.merged === true || typeof mergedAt === "string";
  if (!merged) return null;
  const head = asRecord(pull.head);
  const sha =
    typeof pull.mergeCommitSha === "string"
      ? pull.mergeCommitSha
      : typeof pull.merge_commit_sha === "string"
        ? pull.merge_commit_sha
        : typeof head.sha === "string"
          ? head.sha
          : null;
  return {
    repo: targetRepo(),
    number,
    url,
    title,
    mergedAt: typeof mergedAt === "string" ? mergedAt : null,
    sha,
    confidence: "high",
    source,
  };
}

function fixedPullRequestFromContext(
  item: Item,
  context: ItemContext,
  decision: Decision,
): FixedPullRequest | null {
  if (item.kind !== "issue") return null;
  if (decision.decision !== "close" || decision.confidence !== "high") return null;
  if (!Array.isArray(context.closingPullRequests)) return null;
  const candidates = context.closingPullRequests
    .map((pull) => fixedPullRequestFromUnknown(pull, "GitHub closing PR reference"))
    .filter((pull): pull is FixedPullRequest => pull !== null)
    .sort((left, right) => {
      const leftTime = left.mergedAt ? Date.parse(left.mergedAt) : 0;
      const rightTime = right.mergedAt ? Date.parse(right.mergedAt) : 0;
      return rightTime - leftTime;
    });
  return candidates[0] ?? null;
}

function fixedPullRequestFromCommitPulls(
  pulls: readonly unknown[],
  source: string,
  issueNumber: number,
  commitMessage = "",
  defaultBranch = "main",
): FixedPullRequest | null {
  const commitClosesIssue = textExplicitlyClosesIssue(commitMessage, issueNumber);
  const candidates = pulls
    .filter(
      (pull) =>
        pullTargetsBranch(pull, defaultBranch) &&
        (commitClosesIssue || pullExplicitlyClosesIssue(pull, issueNumber)),
    )
    .map((pull) => fixedPullRequestFromUnknown(pull, source))
    .filter((pull): pull is FixedPullRequest => pull !== null)
    .sort((left, right) => {
      const leftTime = left.mergedAt ? Date.parse(left.mergedAt) : 0;
      const rightTime = right.mergedAt ? Date.parse(right.mergedAt) : 0;
      return rightTime - leftTime;
    });
  return candidates[0] ?? null;
}

export function fixedPullRequestFromCommitPullsForTest(
  pulls: readonly unknown[],
  issueNumber: number,
  commitMessage = "",
  defaultBranch = "main",
): FixedPullRequest | null {
  return fixedPullRequestFromCommitPulls(
    pulls,
    "GitHub commit PR lookup",
    issueNumber,
    commitMessage,
    defaultBranch,
  );
}

function pullTargetsBranch(value: unknown, branch: string): boolean {
  return asRecord(asRecord(value).base).ref === branch;
}

function pullExplicitlyClosesIssue(value: unknown, issueNumber: number): boolean {
  const body = asRecord(value).body;
  if (typeof body !== "string" || !body.trim()) return false;
  return textExplicitlyClosesIssue(body, issueNumber);
}

function textExplicitlyClosesIssue(text: string, issueNumber: number): boolean {
  const issue = escapeRegExp(String(issueNumber));
  const repo = escapeRegExp(targetRepo());
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b[\\t ]*(?::[\\t ]*)?` +
      `(?:#${issue}\\b|${repo}#${issue}\\b|https?:\\/\\/github\\.com\\/${repo}\\/issues\\/${issue}\\b)`,
    "i",
  );
  return text.split(/\r?\n/).some((line) => closingReference.test(line));
}

function fixedPullRequestFromCommitSha(
  decision: Decision,
  issueNumber: number,
): FixedPullRequest | null {
  if (decision.decision !== "close" || decision.confidence !== "high") return null;
  const fixedSha = decision.fixedSha?.trim();
  if (!fixedSha || fixedSha === "unknown") return null;
  try {
    const pulls = ghJson<unknown[]>([
      "api",
      `repos/${targetRepo()}/commits/${fixedSha}/pulls`,
      "-H",
      "Accept: application/vnd.github+json",
    ]);
    const repository = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}`]));
    const defaultBranch = repository.default_branch;
    if (typeof defaultBranch !== "string" || !defaultBranch.trim()) return null;
    const bodyMatch = fixedPullRequestFromCommitPulls(
      pulls,
      "GitHub commit PR lookup",
      issueNumber,
      "",
      defaultBranch,
    );
    if (bodyMatch) return bodyMatch;
    const commit = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/commits/${fixedSha}`]));
    const commitMessage = asRecord(commit.commit).message;
    return fixedPullRequestFromCommitPulls(
      pulls,
      "GitHub commit PR lookup",
      issueNumber,
      typeof commitMessage === "string" ? commitMessage : "",
      defaultBranch,
    );
  } catch (error) {
    if (isGitHubNotFoundError(error)) return null;
    throw error;
  }
}

function attachFixedPullRequest(decision: Decision, item: Item, context: ItemContext): Decision {
  if (decision.fixedPullRequest) return decision;
  const fixedPullRequest =
    fixedPullRequestFromContext(item, context, decision) ??
    (item.kind === "issue" ? fixedPullRequestFromCommitSha(decision, item.number) : null);
  return fixedPullRequest ? { ...decision, fixedPullRequest } : decision;
}

function linkedPullRequest(pull: FixedPullRequest): string {
  return markdownLink(`#${pull.number}`, pull.url);
}

function fixedInReportText(markdown: string): string {
  const parts: string[] = [];
  const fixedPullRequest = fixedPullRequestFromReport(markdown);
  const fixedRelease = frontMatterValue(markdown, "fixed_release");
  const fixedSha = frontMatterValue(markdown, "fixed_sha");
  const fixedAt = frontMatterValue(markdown, "fixed_at");
  if (fixedPullRequest?.confidence === "high")
    parts.push(`merged PR ${linkedPullRequest(fixedPullRequest)}`);
  if (fixedRelease && fixedRelease !== "unknown")
    parts.push(`release ${linkedRelease(fixedRelease)}`);
  if (fixedSha && fixedSha !== "unknown") parts.push(`commit ${linkedSha(fixedSha)}`);
  if ((!fixedRelease || fixedRelease === "unknown") && fixedAt && fixedAt !== "unknown")
    parts.push(`main fix timestamp ${fixedAt}`);
  return parts.length ? parts.join(", ") : "not determined";
}

function fixedPullRequestFromReport(markdown: string): FixedPullRequest | null {
  const url = frontMatterValue(markdown, "fixed_pr_url");
  const rawNumber = frontMatterValue(markdown, "fixed_pr_number");
  const number = rawNumber ? Number(rawNumber) : NaN;
  if (!url || url === "unknown" || !Number.isInteger(number) || number <= 0) return null;
  const confidence = frontMatterValue(markdown, "fixed_pr_confidence") as Confidence | undefined;
  return {
    repo: markdownRepository(markdown),
    number,
    url,
    title: displayTitle(frontMatterValue(markdown, "fixed_pr_title") ?? `#${number}`),
    mergedAt: nonUnknownFrontMatter(markdown, "fixed_pr_merged_at"),
    sha: nonUnknownFrontMatter(markdown, "fixed_pr_sha"),
    confidence: confidence && CONFIDENCES.has(confidence) ? confidence : "low",
    source: nonUnknownFrontMatter(markdown, "fixed_pr_source") ?? "report metadata",
  };
}

function nonUnknownFrontMatter(markdown: string, key: string): string | null {
  const value = frontMatterValue(markdown, key);
  return value && value !== "unknown" ? value : null;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function normalizePublicReviewText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_~#[\]()>.,:;!?'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function publicReviewTextDiffers(left: string, right: string): boolean {
  const normalizedLeft = normalizePublicReviewText(left);
  const normalizedRight = normalizePublicReviewText(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft !== normalizedRight;
  return (
    normalizedLeft !== normalizedRight &&
    !normalizedLeft.includes(normalizedRight) &&
    !normalizedRight.includes(normalizedLeft)
  );
}

function publicReviewTextIsSame(left: string, right: string): boolean {
  const normalizedLeft = normalizePublicReviewText(left);
  const normalizedRight = normalizePublicReviewText(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

function isReportNoneList(value: string): boolean {
  return !value.trim() || value.trim() === "- none";
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

function publicLikelyOwnerRole(role: string): string {
  return role
    .trim()
    .replace(/\brecent workflow maintainers\b/gi, "recent workflow contributors")
    .replace(/\brecent workflow maintainer\b/gi, "recent workflow contributor")
    .replace(/\brecent adjacent maintainers\b/gi, "recent adjacent contributors")
    .replace(/\brecent adjacent maintainer\b/gi, "recent adjacent contributor")
    .replace(/\brecent maintainers\b/gi, "recent area contributors")
    .replace(/\brecent maintainer\b/gi, "recent area contributor");
}

function likelyOwnerLine(owner: LikelyOwner): string {
  const person = owner.person.trim() || "unknown";
  const role = publicLikelyOwnerRole(owner.role);
  const reason = sentence(owner.reason.trim() || "Related by repository history.");
  const commits = owner.commits
    .map((commit) => commit.trim())
    .filter(isCommitSha)
    .slice(0, 3)
    .map((commit) => linkedSha(commit))
    .join(", ");
  const files = owner.files
    .filter(Boolean)
    .slice(0, 3)
    .map((file) => `\`${file}\``)
    .join(", ");
  const suffix = [
    role ? `role: ${role}` : "",
    `confidence: ${owner.confidence}`,
    commits ? `commits: ${commits}` : "",
    files ? `files: ${files}` : "",
  ].filter(Boolean);
  return `- **${person}:** ${reason}${suffix.length ? ` (${suffix.join("; ")})` : ""}`;
}

function priorityLabel(priority: ReviewFinding["priority"]): string {
  return `P${priority}`;
}

type PublicPriority = "P0" | "P1" | "P2";

function publicPriorityFromText(text: string, fallback: PublicPriority): PublicPriority {
  if (/\b(?:outage|data loss|security exposure|release blocker|widespread)\b/i.test(text)) {
    return "P0";
  }
  if (
    /\b(?:major regression|blocked workflow|compatibility(?:\s+|-)?break|fail(?:\s+|-)?closed|lifecycle break)\b/i.test(
      text,
    )
  ) {
    return "P1";
  }
  if (/\b(?:localized|non-blocking|nonblocking|recoverable|fallback|timeout)\b/i.test(text)) {
    return "P2";
  }
  return fallback;
}

function stripPriorityPrefix(text: string): string {
  return text
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^(?:\*\*)?\[P[0-2]\](?:\*\*)?\s*/i, "")
    .trim();
}

function publicPriorityBullet(priority: PublicPriority, text: string): string {
  return `- [${priority}] ${stripPriorityPrefix(sentence(text))}`;
}

function publicPriorityBulletFromText(text: string, fallback: PublicPriority): string {
  return publicPriorityBullet(publicPriorityFromText(text, fallback), text);
}

function publicPlainBullet(text: string): string {
  return `- ${stripPriorityPrefix(sentence(text))}`;
}

function isActionablePriorityText(text: string): boolean {
  const body = stripPriorityPrefix(text);
  if (!body || isReportNoneList(body)) return false;
  if (isRoutineCiOrReviewText(body)) {
    return false;
  }
  return /\b(?:add|block|blocked|break|fail(?:\s+|-)?closed|fix|implement|missing|must|need(?:s|ed)?|prove|reject|repair|required|validate|before merge)\b/i.test(
    body,
  );
}

function isRoutineCiOrReviewText(text: string): boolean {
  const body = stripPriorityPrefix(text);
  const mentionsCheckState =
    /\b(?:ci|status|required(?: status)?)(?:\/status)? checks?(?:(?:\s+(?:are|were|is|was|remain|remains))?\s+(?:green|passing|pass(?:es|ed|ing)?)|\s+(?:have|has)\s+passed|\s+to\s+pass)\b/i.test(
      body,
    );
  const hasCheckStateContrast = /\b(?:although|but|despite|even though|even when|while)\b/i.test(
    body,
  );
  const checkContrastRemainder = body
    .replace(
      /\b(?:ci|status|required(?: status)?)(?:\/status)? checks?(?:(?:\s+(?:are|were|is|was|remain|remains))?\s+(?:green|passing|pass(?:es|ed|ing)?)|\s+(?:have|has)\s+passed|\s+to\s+pass)?\b/gi,
      "",
    )
    .replace(/\b(?:no|without) (?:any )?(?:test )?failures?\b/gi, "")
    .replace(
      /\b(?:maintainer review is still required|required approvals? (?:are )?complete)\b/gi,
      "",
    );
  const hasSeparateContrastBlocker =
    /\b(?:add|before merge|block(?:s|ed|ing)?|blocker|break(?:s|ing)?|broken|cover(?:s|ed|ing)?|coverage|crash(?:es|ed|ing)?|data loss|exposure|fail(?:s|ed|ing)?|fix|gap|implement|low|missing|must|need(?:s|ed)?|quality|required|risk|security|test-gap|unsafe|untested|validate|vulnerab(?:le|ility))\b/i.test(
      checkContrastRemainder,
    );
  const isRoutineReviewOrApprovalGate =
    !hasSeparateContrastBlocker &&
    /\b(?:maintainer review is still required|required approvals? (?:are )?complete)\b/i.test(body);
  if (
    mentionsCheckState &&
    (/\b(?:break(?:s|ing)?|broken|bypass(?:es|ed|ing)?|incorrect(?:ly)?|unsafe)\b/i.test(body) ||
      /\b(?:disabled|did not run|do not run|not run(?:ning)?|skipp(?:ed|ing))\b/i.test(body) ||
      /\bno\b.*\b(?:test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b.*\bruns?\b/i.test(body) ||
      /\bwithout\b(?!\s+(?:any\s+)?(?:test\s+)?failures?\b)/i.test(body) ||
      /\bwith (?:only )?(?:insufficient|limited|mock(?:ed)?|stub(?:bed)?|weak)\b.*\b(?:coverage|test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b/i.test(
        body,
      ) ||
      /\bwith no\b.*\b(?:coverage|test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b/i.test(body) ||
      /\bbecause\b.*\b(?:mock(?:ed|-only)?|stub(?:bed)?|test(?:s|ing)?|validat(?:e|ed|es|ing|ion))\b/i.test(
        body,
      ) ||
      hasSeparateContrastBlocker ||
      (hasCheckStateContrast &&
        !isRoutineReviewOrApprovalGate &&
        (!/\b(?:no|without) (?:any )?(?:test )?failures?\b/i.test(body) ||
          hasSeparateContrastBlocker)))
  ) {
    return false;
  }
  if (mentionsCheckState && isRoutineReviewOrApprovalGate) {
    return true;
  }
  return /\b(?:no automated repair|no clawsweeper repair|normal maintainer review|maintainer review and ci|ready for maintainer review|flaky ci|red ci|unrelated (?:ci|status checks?)|(?:ci|status|required(?: status)?)(?:\/status)? checks?(?:(?=\s*(?:and (?:maintainer review|required approvals?)|[.!?;,)]|$))| (?:(?:are|were|is|was|remain|remains) (?:green|passing|pass|red|failing|pending|missing|flaky|unrelated)|pass(?:es|ed)?|(?:have|has) passed|to pass)))\b/i.test(
    body,
  );
}

function publicPriorityBulletIfActionable(text: string, fallback: PublicPriority): string {
  return isActionablePriorityText(text)
    ? publicPriorityBulletFromText(text, fallback)
    : publicPlainBullet(text);
}

function publicRiskBulletsFromText(text: string, fallback: PublicPriority): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
  if (!bulletLines.length) {
    return isRoutineCiOrReviewText(text)
      ? publicPlainBullet(text)
      : publicPriorityBulletFromText(text, fallback);
  }
  return bulletLines
    .map((line) =>
      isRoutineCiOrReviewText(line)
        ? publicPlainBullet(line)
        : publicPriorityBulletFromText(line, fallback),
    )
    .join("\n");
}

function confidenceText(score: number): string {
  return score.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function reviewFindingLocation(
  finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">,
): string {
  const line =
    finding.lineStart === finding.lineEnd
      ? `${finding.lineStart}`
      : `${finding.lineStart}-${finding.lineEnd}`;
  return `${finding.file}:${line}`;
}

function reviewFindingSummaryLine(finding: ReviewFinding): string {
  return `- [${priorityLabel(finding.priority)}] ${finding.title.trim()} — \`${reviewFindingLocation(
    finding,
  )}\``;
}

function reviewFindingDetailedLine(finding: ReviewFinding): string {
  return [
    reviewFindingSummaryLine(finding),
    `  ${sentence(finding.body)}`,
    `  Confidence: ${confidenceText(finding.confidenceScore)}`,
    ...(finding.lateFinding
      ? ["  Late finding: first raised on code an earlier review cycle already covered."]
      : []),
  ].join("\n");
}

function securityConcernSummaryLine(concern: SecurityConcern): string {
  const location = securityConcernLocation(concern);
  const suffix = location === "not tied to a single file" ? "" : ` — \`${location}\``;
  return `- [${concern.severity}] ${concern.title.trim()}${suffix}`;
}

function securityConcernDetailedLine(concern: SecurityConcern): string {
  return [
    securityConcernSummaryLine(concern),
    `  ${sentence(concern.body)}`,
    `  Confidence: ${confidenceText(concern.confidenceScore)}`,
  ].join("\n");
}

function securityReviewLine(review: SecurityReview): string {
  const prefix =
    review.status === "needs_attention"
      ? "Security review needs attention"
      : review.status === "cleared"
        ? "Security review cleared"
        : "Security review";
  return `${prefix}: ${sentence(review.summary)}`;
}

function publicSecurityReviewLine(review: SecurityReview): string {
  if (review.status === "not_applicable" && review.concerns.length === 0) return "";
  const prefix =
    review.status === "needs_attention"
      ? "Needs attention"
      : review.status === "cleared"
        ? "Cleared"
        : "Not applicable";
  return `${prefix}: ${sentence(review.summary)}`;
}

function realBehaviorProofReReviewGuidance(): string {
  return "After adding proof, update the PR body; ClawSweeper should re-review automatically. If it does not, the PR author or someone with repository write access can comment `@clawsweeper re-review`.";
}

function realBehaviorProofBlockerSummary(summary: string, fallback: string): string {
  const body = sentence(summary) || fallback;
  if (/\b(?:@clawsweeper re-review|re-review automatically|update the PR body)\b/i.test(body)) {
    return body;
  }
  return `${body} ${realBehaviorProofReReviewGuidance()}`;
}

function publicRealBehaviorProofLine(proof: RealBehaviorProof): string {
  const summary = sentence(proof.summary);
  switch (proof.status) {
    case "sufficient":
      return `Sufficient (${proof.evidenceKind}): ${summary}`;
    case "override":
      return `Override: ${summary || "A maintainer applied proof: override."}`;
    case "missing":
      return `Needs real behavior proof before merge: ${realBehaviorProofBlockerSummary(
        summary,
        "The PR must include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
      )}`;
    case "mock_only":
      return `Needs real behavior proof before merge: ${realBehaviorProofBlockerSummary(
        summary,
        "Tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
      )}`;
    case "insufficient":
      return `Needs stronger real behavior proof before merge: ${realBehaviorProofBlockerSummary(
        summary,
        "Include after-fix evidence from a real setup. Screenshots or videos are preferred when they can show the behavior; terminal screenshots, console output, copied live output, linked artifacts, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
      )}`;
    case "not_applicable":
      return summary ? `Not applicable: ${summary}` : "";
  }
}

function publicRankDetailsBlock(): string {
  return collapsedDetailsBlock("What the crustacean ranks mean", [
    "- 🦀 challenger crab: rare, exceptional readiness with strong proof, clean implementation, and convincing validation.",
    "- 🦞 diamond lobster: very strong readiness with only minor maintainer review expected.",
    "- 🐚 platinum hermit: good normal PR, likely mergeable with ordinary maintainer review.",
    "- 🦐 gold shrimp: useful signal, but proof or patch confidence is still limited.",
    "- 🦪 silver shellfish: thin signal; proof, validation, or implementation needs work.",
    "- 🧂 unranked krab: not merge-ready because proof is missing/unusable or there are serious correctness or safety concerns.",
    "- 🌊 off-meta tidepool: rating does not apply to this item.",
    "",
    "Shiny media proof means a screenshot, video, or linked artifact directly shows the changed behavior. Runtime, network, CSP, and security claims still need visible diagnostics.",
  ]);
}

function publicMergeReadinessResult(rating: PrRating, proof: RealBehaviorProof): string {
  if (rating.overallTier === "NA") return "rating does not apply to this item.";
  switch (proof.status) {
    case "missing":
      return "blocked until real behavior proof is added.";
    case "mock_only":
      return "blocked until real behavior proof from a real setup is added.";
    case "insufficient":
      return "blocked until stronger real behavior proof is added.";
    case "sufficient":
    case "override":
      if (rating.patchTier === "F" || rating.patchTier === "D") {
        return "blocked by patch quality or review findings.";
      }
      if (rating.overallTier === "S" || rating.overallTier === "A" || rating.overallTier === "B") {
        return "ready for maintainer review.";
      }
      return "needs maintainer review before merge.";
    case "not_applicable":
      return rating.patchTier === "F" || rating.patchTier === "D"
        ? "blocked by patch quality or review findings."
        : "ready for maintainer review.";
  }
}

function publicMergeReadinessBlock(rating: PrRating, proof: RealBehaviorProof): string {
  const shiny = hasShinyProof(proof) ? " ✨ media proof bonus" : "";
  const proofGuidance =
    proof.status === "missing" || proof.status === "mock_only" || proof.status === "insufficient"
      ? publicPriorityBullet("P1", publicRealBehaviorProofLine(proof))
      : "";
  const lines = [
    `Overall: ${themedRatingName(rating.overallTier)}`,
    `Proof: ${themedRatingName(rating.proofTier)}${shiny}`,
    `Patch quality: ${themedRatingName(rating.patchTier)}`,
    `Result: ${publicMergeReadinessResult(rating, proof)}`,
    "",
    "Overall follows the weaker of proof and patch quality, so missing proof can cap an otherwise strong patch.",
  ];
  if (rating.nextSteps.length) {
    const nextSteps = rating.nextSteps
      .slice(0, 3)
      .filter((step) => !isReportNoneList(stripPriorityPrefix(step)));
    lines.push(
      "",
      "Rank-up moves:",
      ...(nextSteps.length
        ? nextSteps.map((step) =>
            publicPriorityBulletIfActionable(step, proofGuidance ? "P1" : "P2"),
          )
        : ["- none"]),
    );
  }
  if (proofGuidance) {
    lines.push("", "Proof guidance:", proofGuidance);
  }
  return lines.join("\n");
}

function publicFailedReviewReadinessBlock(markdown: string): string {
  const reason =
    reportEvidence(markdown)
      .find((entry) => entry.label === "failure reason")
      ?.detail.trim() || "Codex review failed before completion.";
  return [
    "Not assessed.",
    `Failure reason: ${sentence(reason)}`,
    "",
    "This is a ClawSweeper/Codex infrastructure failure, not a PR readiness or patch-quality verdict.",
    "Keep any merge decision on the normal maintainer review path until ClawSweeper can complete a fresh review.",
  ].join("\n");
}

function prStatusLabelKindFromLabels(labels: readonly string[]): PrStatusLabelKind | null {
  for (const label of PR_STATUS_LABELS) {
    if (labels.includes(label.name)) return label.kind;
  }
  return null;
}

function prStatusLabelKindFromReportLabels(markdown: string): PrStatusLabelKind | null {
  const parsedLabels = frontMatterStringArray(markdown, "labels");
  if (hasRepairLoopPauseLabel(parsedLabels)) return null;
  const fromParsedLabels = prStatusLabelKindFromLabels(parsedLabels);
  if (fromParsedLabels) return fromParsedLabels;
  if (parsedLabels.includes(AUTOMERGE_LABEL)) return "automerge_armed";
  const rawLabels = frontMatterValue(markdown, "labels") ?? "";
  if (
    rawLabels.includes(HUMAN_REVIEW_LABEL) ||
    rawLabels.includes(MANUAL_ONLY_LABEL) ||
    rawLabels.includes(MERGE_READY_LABEL)
  )
    return null;
  if (rawLabels.includes(AUTOMERGE_LABEL)) return "automerge_armed";
  return PR_STATUS_LABELS.find((label) => rawLabels.includes(label.name))?.kind ?? null;
}

function mantisMaintainerCommentRequestsMutation(comment: string): boolean {
  const commandBody = comment.replace(/^@openclaw-mantis\s+/i, "").trim();
  const mutationVerb = String.raw`(?:add|apply|approve|assign|cancel|change|close|comment|commit|create|delete|disable|edit|enable|file|fix|implement|label|land|lock|make|mark|merge|modify|open|post|publish|push|rebase|remove|reopen|repair|request|resolve|restart|resume|re-?run|retry|re-?trigger|review|rewrite|run|set|submit|triage|trigger|unlock|update|write)`;
  const mutationObject = String.raw`(?:automerge|branch(?:es)?|change(?:s)?|check(?:s)?|CI|code(?!\s+(?:block|snippet|sample|example)\b)|commit(?:s)?|GitHub(?:\s+state)?|issue(?:s)?|item(?:s)?|label(?:s)?|comment(?:s)?|patch(?:es)?|pull\s+request(?:s)?|PRs?|ready\s+for\s+review|repositor(?:y|ies)|repo(?:s)?|review(?:s|\s+request(?:s)?)?|workflow(?:s)?)`;
  const scopedMutation = new RegExp(
    `\\b${mutationVerb}\\b(?:\\s+\\S+){0,12}\\s+\\b${mutationObject}\\b`,
    "i",
  );
  const explicitToolMutation = new RegExp(
    `\\b(?:gh|git|GitHub)\\b(?:\\s+\\S+){0,12}\\s+\\b${mutationVerb}\\b`,
    "i",
  );
  const maintenanceVerb = String.raw`(?:apply|approve|assign|close|comment|commit|create|file|fix|implement|label|land|lock|make|merge|modify|publish|push|rebase|reopen|repair|resolve|review|rewrite|submit|triage|unlock)`;
  const bareMutationImperative = new RegExp(
    `(?:^|[,.!?:;]\\s*|\\b(?:and|then|also)\\s+)(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+)*${maintenanceVerb}\\b`,
    "i",
  );
  return (
    scopedMutation.test(commandBody) ||
    explicitToolMutation.test(commandBody) ||
    bareMutationImperative.test(commandBody) ||
    new RegExp(`\\b${mutationVerb}\\b\\s+(?:it|this|that|them|these|those)\\b`, "i").test(
      commandBody,
    ) ||
    /\b(?:gh\s+workflow|workflow_dispatch|dispatch|trigger\s+the\s+workflow)\b/i.test(commandBody)
  );
}

function mantisMaintainerCommentHasProofIntent(comment: string): boolean {
  const commandBody = comment.replace(/^@openclaw-mantis\s+/i, "").trim();
  return /\b(?:proof|verify|reproduce|capture|inspect|record|test|check|confirm|compare|exercise|demonstrate|show)\b/i.test(
    commandBody,
  );
}

function validMantisMaintainerComment(recommendation: MantisRecommendation): string {
  if (recommendation.status !== "recommended" || recommendation.scenario === "none") return "";
  const comment = recommendation.maintainerComment.trim();
  const accountMention = "@openclaw-mantis";
  const ambiguousMantisMention = new RegExp(`@${"mantis"}\\b`, "i");
  if (
    !comment.startsWith(`${accountMention} `) ||
    ambiguousMantisMention.test(comment) ||
    !mantisMaintainerCommentHasProofIntent(comment) ||
    mantisMaintainerCommentRequestsMutation(comment) ||
    comment.length > 500 ||
    comment.includes("\n")
  ) {
    return "";
  }
  const commandBody = comment.slice(accountMention.length).trim();
  if (!commandBody) return "";
  return `${accountMention} ${commandBody}`;
}

function isSupportedMantisScenario(scenario: MantisRecommendationScenario): boolean {
  return (
    scenario === "telegram_live" ||
    scenario === "telegram_desktop_proof" ||
    scenario === "discord_status_reactions" ||
    scenario === "discord_thread_attachment" ||
    scenario === "web_ui_chat_proof"
  );
}

function publicMantisRecommendationBlock(recommendation: MantisRecommendation): string {
  if (!hasDispatchableMantisScenario(recommendation)) return "";
  const comment = validMantisMaintainerComment(recommendation);
  if (!comment) return "";
  const reason = sentence(recommendation.reason);
  const intro = reason
    ? `${reason} A maintainer can ask Mantis to capture proof by posting this exact PR comment:`
    : "A maintainer can ask Mantis to capture proof by posting this exact PR comment:";
  return [intro, "", "```text", comment, "```"].join("\n");
}

function publicNonDispatchableMantisRecommendationBlock(
  recommendation: MantisRecommendation,
): string {
  if (recommendation.status !== "recommended" || recommendation.scenario === "none") return "";
  const mutationRequest = mantisMaintainerCommentRequestsMutation(
    recommendation.maintainerComment.trim(),
  );
  const missingProofIntent = !mantisMaintainerCommentHasProofIntent(
    recommendation.maintainerComment.trim(),
  );
  if (
    isSupportedMantisScenario(recommendation.scenario) &&
    !mutationRequest &&
    !missingProofIntent
  ) {
    return "";
  }
  const reason = sentence(recommendation.reason);
  if (mutationRequest || missingProofIntent) {
    const intro = reason
      ? `${reason} Mantis is proof-only, so it must not be asked to change code or mutate GitHub state.`
      : "Mantis is proof-only, so it must not be asked to change code or mutate GitHub state.";
    return [
      intro,
      "Use ClawSweeper's repair, apply, or automerge lanes for code changes, branch updates, labels, comments, PR repair, closes, or merges.",
    ].join("\n");
  }
  const intro = reason
    ? `${reason} Mantis is currently scoped to Telegram, Discord, and web UI chat proof, so it is not the right proof path for this surface.`
    : "Mantis is currently scoped to Telegram, Discord, and web UI chat proof, so it is not the right proof path for this surface.";
  return [
    intro,
    "Use maintainer screenshot/manual proof, browser or Playwright proof, Crabbox where appropriate, or normal local artifact proof instead.",
  ].join("\n");
}

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

function reportEvidence(markdown: string): Evidence[] {
  const evidence = reviewSectionValue(markdown, "evidence");
  const entries: Evidence[] = [];
  let current: Evidence | null = null;
  for (const line of evidence.split("\n")) {
    const heading = parseBoldListHeading(line);
    if (heading) {
      if (current) entries.push(current);
      current = evidenceEntry({
        label: heading.label,
        detail: heading.detail,
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

function reportLikelyOwners(markdown: string): LikelyOwner[] {
  const section = reviewSectionValue(markdown, "likelyOwners");
  const owners: LikelyOwner[] = [];
  let current: LikelyOwner | null = null;
  for (const line of section.split("\n")) {
    const heading = parseBoldListHeading(line);
    if (heading) {
      if (current) owners.push(current);
      current = {
        person: heading.label,
        role: heading.detail,
        reason: "",
        commits: [],
        files: [],
        confidence: "low",
      };
      continue;
    }
    if (!current) continue;
    const reason = line.match(/^\s+- reason: (.*)$/);
    if (reason?.[1]) {
      current.reason = reason[1];
      continue;
    }
    const commits = line.match(/^\s+- commits: (.*)$/);
    if (commits?.[1]) {
      current.commits = commits[1]
        .split(",")
        .map((commit) => commit.trim())
        .filter(Boolean);
      continue;
    }
    const files = line.match(/^\s+- files: (.*)$/);
    if (files?.[1]) {
      current.files = files[1]
        .split(",")
        .map((file) => file.trim())
        .filter(Boolean);
      continue;
    }
    const confidence = line.match(/^\s+- confidence: (high|medium|low)$/);
    if (confidence?.[1]) current.confidence = confidence[1] as Confidence;
  }
  if (current) owners.push(current);
  return owners;
}

function reportOverallCorrectness(markdown: string): OverallCorrectness {
  const section = reviewSectionValue(markdown, "reviewFindings");
  const value = sectionLineValue(section, "Overall correctness");
  return value && OVERALL_CORRECTNESS_VALUES.has(value as OverallCorrectness)
    ? (value as OverallCorrectness)
    : "not a patch";
}

function reportOverallConfidenceScore(markdown: string): number {
  const section = reviewSectionValue(markdown, "reviewFindings");
  const raw = sectionLineValue(section, "Overall confidence");
  const score = raw ? Number(raw) : 0;
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0;
}

function triagePriorityFromReport(markdown: string): TriagePriority {
  const value = frontMatterValue(markdown, "triage_priority");
  return TRIAGE_PRIORITIES.has(value as TriagePriority) ? (value as TriagePriority) : "none";
}

function impactLabelsFromReport(markdown: string): ImpactLabelName[] {
  return frontMatterStringArray(markdown, "impact_labels").filter(
    (label): label is ImpactLabelName => IMPACT_LABEL_NAMES.has(label),
  );
}

function mergeRiskLabelsFromReport(markdown: string): MergeRiskLabelName[] {
  return frontMatterStringArray(markdown, "merge_risk_labels").filter(
    (label): label is MergeRiskLabelName => MERGE_RISK_LABEL_NAMES.has(label),
  );
}

function maturityLabelsFromReport(markdown: string): MaturityLabelName[] {
  return frontMatterStringArray(markdown, "maturity_labels").filter(
    (label): label is MaturityLabelName => MATURITY_LABEL_NAMES.has(label),
  );
}

function mergeRiskOptionsFromReport(markdown: string): MergeRiskOption[] {
  return frontMatterJsonArray(markdown, "merge_risk_options")
    .map((entry, index) => {
      try {
        return parseMergeRiskOption(entry, `merge_risk_options[${index}]`);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is MergeRiskOption => Boolean(entry));
}

function labelJustificationsFromReport(
  markdown: string,
  labels: Pick<Decision, "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels">,
): LabelJustification[] {
  const selected = new Set<string>(selectedReviewLabels(labels));
  const fromFrontMatter = frontMatterJsonArray(markdown, "label_justifications")
    .map((entry, index) => {
      try {
        return parseLabelJustification(entry, `label_justifications[${index}]`);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is LabelJustification => Boolean(entry))
    .filter((entry) => selected.has(entry.label));
  const byLabel = new Map(fromFrontMatter.map((entry) => [entry.label, entry]));
  return selectedReviewLabels(labels).map((label) => ({
    label,
    reason:
      byLabel.get(label)?.reason ??
      "Older review report did not store a label-specific justification.",
  }));
}

function reportReviewFindings(markdown: string): ReviewFinding[] {
  const section = reviewSectionValue(markdown, "reviewFindings");
  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | null = null;
  for (const line of section.split("\n")) {
    const heading = parseReviewFindingHeading(line);
    if (heading) {
      if (current) findings.push(current);
      current = {
        title: heading.title,
        body: "",
        priority: heading.priority,
        confidenceScore: 0,
        file: heading.file,
        lineStart: heading.lineStart,
        lineEnd: heading.lineEnd,
      };
      continue;
    }
    if (!current) continue;
    const body = line.match(/^\s+- body: (.*)$/);
    if (body?.[1]) {
      current.body = body[1];
      continue;
    }
    const late = line.match(/^\s+- late: (true|false)$/);
    if (late?.[1]) {
      current.lateFinding = late[1] === "true";
      continue;
    }
    const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
    if (confidence?.[1]) {
      const score = Number(confidence[1]);
      current.confidenceScore = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
    }
  }
  if (current) findings.push(current);
  return findings;
}

function defaultSecurityReview(markdown: string): SecurityReview {
  const type = frontMatterValue(markdown, "type");
  return {
    status: type === "pull_request" ? "not_applicable" : "not_applicable",
    summary:
      type === "pull_request"
        ? "No dedicated security review was recorded in this older report."
        : "No patch security review is needed for this non-PR item.",
    concerns: [],
  };
}

function reportSecurityReview(markdown: string): SecurityReview {
  const section = reviewSectionValue(markdown, "securityReview");
  if (!section.trim()) return defaultSecurityReview(markdown);
  const statusValue = sectionLineValue(section, "Status");
  const status = SECURITY_REVIEW_STATUSES.has(statusValue as SecurityReviewStatus)
    ? (statusValue as SecurityReviewStatus)
    : undefined;
  const summary = sectionLineValue(section, "Summary");
  if (!status || !summary) return defaultSecurityReview(markdown);
  const concerns: SecurityConcern[] = [];
  let current: SecurityConcern | null = null;
  for (const line of section.split("\n")) {
    const heading = parseSecurityConcernHeading(line);
    if (heading) {
      if (current) concerns.push(current);
      current = {
        title: heading.title,
        body: "",
        severity: heading.severity,
        confidenceScore: 0,
        file: heading.file,
        line: heading.line,
      };
      continue;
    }
    if (!current) continue;
    const body = line.match(/^\s+- body: (.*)$/);
    if (body?.[1]) {
      current.body = body[1];
      continue;
    }
    const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
    if (confidence?.[1]) {
      const score = Number(confidence[1]);
      current.confidenceScore = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
    }
  }
  if (current) concerns.push(current);
  return { status, summary, concerns };
}

function defaultRealBehaviorProof(markdown: string): RealBehaviorProof {
  const type = frontMatterValue(markdown, "type");
  if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) {
    return {
      status: "override",
      summary: "A maintainer applied proof: override for this PR.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }
  if (isDocsOnlyPullRequestReport(markdown)) {
    return {
      status: "not_applicable",
      summary:
        "Real behavior proof is not required because this PR only changes files under docs/.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    };
  }
  return {
    status: "not_applicable",
    summary:
      type === "pull_request"
        ? "No real behavior proof assessment was recorded in this older report."
        : "Real behavior proof is not required for non-PR issue triage.",
    evidenceKind: "not_applicable",
    needsContributorAction: false,
  };
}

function reportRealBehaviorProof(markdown: string): RealBehaviorProof {
  const defaultProof = defaultRealBehaviorProof(markdown);
  if (defaultProof.status === "override" || isDocsOnlyPullRequestReport(markdown)) {
    return defaultProof;
  }
  const section = reviewSectionValue(markdown, "realBehaviorProof");
  if (!section.trim()) {
    if (isExternalPullRequestReport(markdown)) {
      return {
        status: "missing",
        summary:
          "No after-fix real behavior proof was recorded for this external PR; screenshots or videos are preferred when they can show the behavior, and terminal screenshots, console output, copied live output, linked artifacts, recordings, and redacted logs count. Redact private information like IP addresses, API keys, phone numbers, non-public endpoints, and other private details before posting evidence.",
        evidenceKind: "none",
        needsContributorAction: true,
      };
    }
    return defaultProof;
  }
  const statusValue = sectionLineValue(section, "Status");
  const evidenceKindValue = sectionLineValue(section, "Evidence kind");
  const summary = sectionLineValue(section, "Summary");
  const needsContributorActionValue = sectionLineValue(section, "Needs contributor action");
  const status = REAL_BEHAVIOR_PROOF_STATUSES.has(statusValue as RealBehaviorProofStatus)
    ? (statusValue as RealBehaviorProofStatus)
    : undefined;
  const evidenceKind = REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS.has(
    evidenceKindValue as RealBehaviorProofEvidenceKind,
  )
    ? (evidenceKindValue as RealBehaviorProofEvidenceKind)
    : undefined;
  if (!status || !evidenceKind || !summary) return defaultRealBehaviorProof(markdown);
  return normalizeRealBehaviorProof({
    status,
    summary,
    evidenceKind,
    needsContributorAction: /^true$/i.test(needsContributorActionValue ?? ""),
  });
}

function reportTelegramVisibleProof(markdown: string): TelegramVisibleProof {
  const section = reviewSectionValue(markdown, "telegramVisibleProof");
  const statusValue = sectionLineValue(section, "Status");
  const status = TELEGRAM_VISIBLE_PROOF_STATUSES.has(statusValue as TelegramVisibleProofStatus)
    ? (statusValue as TelegramVisibleProofStatus)
    : "not_needed";
  return {
    status,
    summary:
      sectionLineValue(section, "Summary") ??
      "No Telegram visible-proof assessment was recorded in this report.",
  };
}

function reportPrRating(markdown: string): PrRating {
  const section = reviewSectionValue(markdown, "prRating");
  const proofTierValue =
    sectionLineValue(section, "Proof tier") ?? frontMatterValue(markdown, "pr_rating_proof");
  const patchTierValue =
    sectionLineValue(section, "Patch tier") ?? frontMatterValue(markdown, "pr_rating_patch");
  const overallTierValue =
    sectionLineValue(section, "Overall tier") ?? frontMatterValue(markdown, "pr_rating_overall");
  const summary = sectionLineValue(section, "Summary");
  const nextSteps = sectionList(section, "Next rank-up steps").slice(0, 3);
  if (
    PR_RATING_TIERS.has(proofTierValue as PrRatingTier) &&
    PR_RATING_TIERS.has(patchTierValue as PrRatingTier) &&
    PR_RATING_TIERS.has(overallTierValue as PrRatingTier) &&
    summary
  ) {
    return normalizePrRating({
      proofTier: proofTierValue as PrRatingTier,
      patchTier: patchTierValue as PrRatingTier,
      overallTier: overallTierValue as PrRatingTier,
      summary,
      nextSteps,
    });
  }
  const proof = reportRealBehaviorProof(markdown);
  return derivedPrRating({
    isPullRequest: frontMatterValue(markdown, "type") === "pull_request",
    proof,
    findings: reportReviewFindings(markdown),
    securityReview: reportSecurityReview(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    overallConfidenceScore: reportOverallConfidenceScore(markdown),
  });
}

function reportMantisRecommendation(markdown: string): MantisRecommendation {
  const section = reviewSectionValue(markdown, "mantisRecommendation");
  const statusValue = sectionLineValue(section, "Status");
  const scenarioValue = sectionLineValue(section, "Scenario");
  const status = MANTIS_RECOMMENDATION_STATUSES.has(statusValue as MantisRecommendationStatus)
    ? (statusValue as MantisRecommendationStatus)
    : "not_recommended";
  const scenario = MANTIS_RECOMMENDATION_SCENARIOS.has(
    scenarioValue as MantisRecommendationScenario,
  )
    ? (scenarioValue as MantisRecommendationScenario)
    : "none";
  return {
    status,
    scenario,
    reason:
      sectionLineValue(section, "Reason") ??
      "No Mantis recommendation was recorded in this report.",
    maintainerComment: sectionLineValue(section, "Maintainer comment") ?? "",
  };
}

function reportFeatureShowcase(markdown: string): FeatureShowcase {
  const section = reviewSectionValue(markdown, "featureShowcase");
  const statusValue =
    sectionLineValue(section, "Status") ?? frontMatterValue(markdown, "feature_showcase_status");
  const status = FEATURE_SHOWCASE_STATUSES.has(statusValue as FeatureShowcaseStatus)
    ? (statusValue as FeatureShowcaseStatus)
    : "none";
  return {
    status,
    reason:
      sectionLineValue(section, "Reason") ??
      (status === "showcase"
        ? "This report predates the structured feature showcase reason."
        : "No feature showcase assessment was recorded in this report."),
  };
}

function reportRootCauseCluster(markdown: string): RootCauseClusterAssessment {
  const raw = frontMatterValue(markdown, "root_cause_cluster");
  if (!raw) return defaultRootCauseCluster();
  try {
    return parseRootCauseCluster(JSON.parse(raw), "root_cause_cluster", {
      repo: markdownRepository(markdown),
      number: Number(frontMatterValue(markdown, "number")),
      kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
    });
  } catch {
    return defaultRootCauseCluster();
  }
}

export function rootCauseClusterFromReportForTest(markdown: string): RootCauseClusterAssessment {
  return reportRootCauseCluster(markdown);
}

function reportAgentsPolicyStatus(markdown: string): AgentsPolicyStatus | undefined {
  const section = reviewSectionValue(markdown, "agentsPolicyStatus");
  const statusValue =
    sectionLineValue(section, "Status") ?? frontMatterValue(markdown, "agents_policy_status");
  if (!AGENTS_POLICY_STATUSES.has(statusValue as AgentsPolicyStatusKind)) return undefined;
  const status = statusValue as AgentsPolicyStatusKind;
  return {
    found: /^true$/i.test(sectionLineValue(section, "Found") ?? ""),
    readFully: /^true$/i.test(sectionLineValue(section, "Read fully") ?? ""),
    applied: /^true$/i.test(sectionLineValue(section, "Applied") ?? ""),
    status,
    summary:
      sectionLineValue(section, "Summary") ??
      agentsPolicyStatusLine({
        found: false,
        readFully: false,
        applied: false,
        status,
        summary: "",
      }),
  };
}

function defaultAgentsPolicyStatus(): AgentsPolicyStatus {
  return {
    found: false,
    readFully: false,
    applied: false,
    status: "unreadable_or_unclear",
    summary: "AGENTS.md policy status was not recorded in this report.",
  };
}

function reportVisionFit(markdown: string): {
  visionFit: VisionFitStatus;
  visionFitReason: string;
  visionFitEvidence: string[];
  implementationComplexity: ImplementationComplexity;
  autoImplementationCandidate: AutoImplementationCandidate;
} {
  const section = reviewSectionValue(markdown, "visionFit");
  const visionValue =
    sectionLineValue(section, "Status") ?? frontMatterValue(markdown, "vision_fit");
  const complexityValue =
    sectionLineValue(section, "Implementation complexity") ??
    frontMatterValue(markdown, "implementation_complexity");
  const candidateValue =
    sectionLineValue(section, "Auto implementation candidate") ??
    frontMatterValue(markdown, "auto_implementation_candidate");
  const visionFit = VISION_FIT_STATUSES.has(visionValue as VisionFitStatus)
    ? (visionValue as VisionFitStatus)
    : "not_applicable";
  const implementationComplexity = IMPLEMENTATION_COMPLEXITIES.has(
    complexityValue as ImplementationComplexity,
  )
    ? (complexityValue as ImplementationComplexity)
    : "not_applicable";
  const autoImplementationCandidate = AUTO_IMPLEMENTATION_CANDIDATES.has(
    candidateValue as AutoImplementationCandidate,
  )
    ? (candidateValue as AutoImplementationCandidate)
    : "none";
  return {
    visionFit,
    visionFitReason:
      sectionLineValue(section, "Reason") ??
      (visionFit === "not_applicable"
        ? "Vision-fit assessment is not applicable to this older report."
        : "No vision-fit reason was recorded in this report."),
    visionFitEvidence:
      sectionList(section, "Vision evidence").length > 0
        ? sectionList(section, "Vision evidence")
        : frontMatterStringArray(markdown, "vision_fit_evidence"),
    implementationComplexity,
    autoImplementationCandidate,
  };
}

function screenshotProofNeedsRuntimeOutput(summary: string): boolean {
  if (
    /\b(?:no|without|absence of|zero|none)\b[^.]{0,120}\b(?:visible\s+)?(?:console|network|error|warning|violation|csp|cors)\b/i.test(
      summary,
    )
  ) {
    return true;
  }
  if (
    !/\b(?:csp|content[- ]security[- ]policy|connect-src|script-src|style-src|img-src|cors)\b/i.test(
      summary,
    )
  ) {
    return false;
  }
  return !/\b(?:devtools|developer tools|console output|console panel|network trace|network panel|network tab|terminal|logs?|live output|request|response|status code|har)\b/i.test(
    summary,
  );
}

function normalizeRealBehaviorProof(proof: RealBehaviorProof): RealBehaviorProof {
  if (
    proof.status === "sufficient" &&
    proof.evidenceKind === "screenshot" &&
    screenshotProofNeedsRuntimeOutput(proof.summary)
  ) {
    return {
      status: "insufficient",
      summary:
        "The screenshot proof is not enough for browser runtime or security behavior; include console, network, terminal, live output, or logs showing the changed behavior after the fix.",
      evidenceKind: "screenshot",
      needsContributorAction: true,
    };
  }
  return proof;
}

function ratingIndex(tier: PrRatingTier): number {
  return ["S", "A", "B", "C", "D", "F", "NA"].indexOf(tier);
}

function lowerRatingTier(a: PrRatingTier, b: PrRatingTier): PrRatingTier {
  if (a === "NA") return b;
  if (b === "NA") return a;
  return ratingIndex(a) >= ratingIndex(b) ? a : b;
}

function proofTierFromRealBehaviorProof(proof: RealBehaviorProof): PrRatingTier {
  switch (proof.status) {
    case "sufficient":
      if (
        proof.evidenceKind === "recording" ||
        proof.evidenceKind === "screenshot" ||
        proof.evidenceKind === "linked_artifact"
      ) {
        return "S";
      }
      return "A";
    case "override":
      return "A";
    case "insufficient":
    case "mock_only":
      return "D";
    case "missing":
      return "F";
    case "not_applicable":
      return "NA";
  }
}

function patchTierFromReview(options: {
  isPullRequest: boolean;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
}): PrRatingTier {
  if (!options.isPullRequest || options.overallCorrectness === "not a patch") return "NA";
  if (options.securityReview.status === "needs_attention") return "F";
  const highestPriority = Math.min(...options.findings.map((finding) => finding.priority), 4);
  if (options.overallCorrectness === "patch is incorrect") {
    if (highestPriority <= 1) return "F";
    if (highestPriority === 2) return "D";
    return "C";
  }
  if (highestPriority <= 1) return "D";
  if (highestPriority === 2) return "C";
  if (highestPriority === 3) return "B";
  if (options.overallConfidenceScore >= 0.95) return "S";
  if (options.overallConfidenceScore >= 0.8) return "A";
  if (options.overallConfidenceScore >= 0.6) return "B";
  return "C";
}

function ratingLabelForTier(tier: PrRatingTier): (typeof PR_RATING_LABELS)[number] {
  const label = PR_RATING_LABELS.find((candidate) => candidate.tier === tier);
  if (label) return label;
  return PR_RATING_LABELS[6];
}

function themedRatingName(tier: PrRatingTier): string {
  return ratingLabelForTier(tier).name.replace(/^rating:\s*/, "");
}

function hasShinyProof(proof: Pick<RealBehaviorProof, "status" | "evidenceKind">): boolean {
  return (
    proof.status === "sufficient" &&
    (proof.evidenceKind === "recording" ||
      proof.evidenceKind === "screenshot" ||
      proof.evidenceKind === "linked_artifact")
  );
}

function defaultRatingNextSteps(options: {
  proof: RealBehaviorProof;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallTier: PrRatingTier;
}): string[] {
  if (options.overallTier === "S" || options.overallTier === "A" || options.overallTier === "NA") {
    return [];
  }
  const steps: string[] = [];
  if (
    options.proof.status === "missing" ||
    options.proof.status === "mock_only" ||
    options.proof.status === "insufficient"
  ) {
    steps.push(
      "Add after-fix proof from a real setup, such as a short recording, terminal output, linked artifact, or redacted logs.",
    );
  }
  if (options.securityReview.status === "needs_attention") {
    steps.push("Resolve the security review concern or explain why the changed path is safe.");
  }
  const highestPriority = Math.min(...options.findings.map((finding) => finding.priority), 4);
  if (options.overallCorrectness === "patch is incorrect" || highestPriority <= 2) {
    steps.push(
      "Address the highest-priority review finding and re-run the changed-surface validation.",
    );
  }
  if (!steps.length) {
    steps.push(
      "Tighten the PR description with what changed, how it was validated, and any remaining risk.",
    );
  }
  return steps.slice(0, 3);
}

function normalizePrRating(rating: PrRating): PrRating {
  if (rating.overallTier === "S" || rating.overallTier === "A" || rating.overallTier === "NA") {
    return { ...rating, nextSteps: [] };
  }
  return { ...rating, nextSteps: rating.nextSteps.slice(0, 3) };
}

function derivedPrRating(options: {
  isPullRequest: boolean;
  proof: RealBehaviorProof;
  findings: readonly ReviewFinding[];
  securityReview: SecurityReview;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
}): PrRating {
  const proofTier = proofTierFromRealBehaviorProof(options.proof);
  const patchTier = patchTierFromReview(options);
  const overallTier =
    proofTier === "NA" && patchTier === "NA" ? "NA" : lowerRatingTier(proofTier, patchTier);
  return normalizePrRating({
    proofTier,
    patchTier,
    overallTier,
    summary:
      overallTier === "NA"
        ? "PR readiness rating is not applicable to this item."
        : "PR readiness rating was derived from proof quality, review findings, security review, and reviewer confidence.",
    nextSteps: defaultRatingNextSteps({ ...options, overallTier }),
  });
}

function nextPrRatingLabels(
  labels: readonly string[],
  rating: Pick<PrRating, "overallTier">,
  reviewFailed = false,
): string[] {
  const nextLabels = labels.filter((label) => !PR_RATING_LABEL_NAMES.has(label));
  if (reviewFailed) return nextLabels;
  nextLabels.push(ratingLabelForTier(rating.overallTier).name);
  return nextLabels;
}

function shouldApplyFeatureShowcaseLabel(options: {
  isPullRequest: boolean;
  itemCategory: string | undefined;
  requiresNewFeature: boolean;
  showcase: FeatureShowcase;
  securityReview: Pick<SecurityReview, "status">;
  overallCorrectness: OverallCorrectness;
}): boolean {
  return (
    options.isPullRequest &&
    options.showcase.status === "showcase" &&
    (options.itemCategory === "feature" || options.requiresNewFeature) &&
    options.securityReview.status !== "needs_attention" &&
    options.overallCorrectness !== "patch is incorrect"
  );
}

function nextFeatureShowcaseLabels(
  labels: readonly string[],
  options: {
    isPullRequest: boolean;
    itemCategory: string | undefined;
    requiresNewFeature: boolean;
    showcase: FeatureShowcase;
    securityReview: Pick<SecurityReview, "status">;
    overallCorrectness: OverallCorrectness;
  },
): string[] {
  if (labels.includes(FEATURE_SHOWCASE_LABEL)) return [...labels];
  return shouldApplyFeatureShowcaseLabel(options)
    ? [...labels, FEATURE_SHOWCASE_LABEL]
    : [...labels];
}

export function featureShowcaseLabelsForTest(
  labels: readonly string[],
  options: {
    isPullRequest?: boolean;
    itemCategory?: string;
    requiresNewFeature?: boolean;
    status?: string;
    securityReviewStatus?: string;
    overallCorrectness?: string;
  },
): string[] {
  const status = FEATURE_SHOWCASE_STATUSES.has(options.status as FeatureShowcaseStatus)
    ? (options.status as FeatureShowcaseStatus)
    : "none";
  const securityReviewStatus = SECURITY_REVIEW_STATUSES.has(
    options.securityReviewStatus as SecurityReviewStatus,
  )
    ? (options.securityReviewStatus as SecurityReviewStatus)
    : "not_applicable";
  const overallCorrectness = OVERALL_CORRECTNESS_VALUES.has(
    options.overallCorrectness as OverallCorrectness,
  )
    ? (options.overallCorrectness as OverallCorrectness)
    : "not a patch";
  return nextFeatureShowcaseLabels(labels, {
    isPullRequest: options.isPullRequest ?? true,
    itemCategory: options.itemCategory,
    requiresNewFeature: options.requiresNewFeature ?? false,
    showcase: {
      status,
      reason: status === "showcase" ? "This is a high-signal feature idea." : "",
    },
    securityReview: { status: securityReviewStatus },
    overallCorrectness,
  });
}

function proofNeedsContributorAction(proof: Pick<RealBehaviorProof, "status">): boolean {
  return (
    proof.status === "missing" || proof.status === "mock_only" || proof.status === "insufficient"
  );
}

function hasBlockingReviewFindings(findings: readonly Pick<ReviewFinding, "priority">[]): boolean {
  return findings.some((finding) => finding.priority <= 2);
}

function recommendedMergeRiskOptionCategory(
  options: readonly Pick<MergeRiskOption, "category" | "recommended">[],
): MergeRiskOptionCategory | null {
  return options.find((option) => option.recommended)?.category ?? null;
}

function securityReviewNeedsContributorWork(options: {
  securityReview: Pick<SecurityReview, "status">;
  mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
}): boolean {
  if (options.securityReview.status !== "needs_attention") return false;
  return recommendedMergeRiskOptionCategory(options.mergeRiskOptions) !== "accept_risk";
}

function hasUnresolvedContributorWork(options: {
  realBehaviorProof: Pick<RealBehaviorProof, "status">;
  reviewFindings: readonly Pick<ReviewFinding, "priority">[];
  securityReview: Pick<SecurityReview, "status">;
  mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
  overallCorrectness: OverallCorrectness;
}): boolean {
  return (
    proofNeedsContributorAction(options.realBehaviorProof) ||
    hasBlockingReviewFindings(options.reviewFindings) ||
    securityReviewNeedsContributorWork(options) ||
    options.overallCorrectness === "patch is incorrect"
  );
}

function isReadyForMaintainerLook(options: {
  realBehaviorProof: Pick<RealBehaviorProof, "status">;
  reviewFindings: readonly Pick<ReviewFinding, "priority">[];
  securityReview: Pick<SecurityReview, "status">;
  mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
  overallCorrectness: OverallCorrectness;
}): boolean {
  return (
    !hasBlockingReviewFindings(options.reviewFindings) &&
    !securityReviewNeedsContributorWork(options) &&
    (options.realBehaviorProof.status === "sufficient" ||
      options.realBehaviorProof.status === "override" ||
      options.realBehaviorProof.status === "not_applicable") &&
    options.overallCorrectness === "patch is correct"
  );
}

function prStatusLabelKind(options: {
  realBehaviorProof: Pick<RealBehaviorProof, "status">;
  reviewFindings: readonly Pick<ReviewFinding, "priority">[];
  securityReview: Pick<SecurityReview, "status">;
  mergeRiskOptions: readonly Pick<MergeRiskOption, "category" | "recommended">[];
  overallCorrectness: OverallCorrectness;
  hasAutomergeLabel: boolean;
  hasRepairLoopPauseLabel: boolean;
  hasRecentReReviewRequest: boolean;
  hasRecentAuthorActivity: boolean;
}): PrStatusLabelKind | null {
  const unresolvedWork = hasUnresolvedContributorWork(options);
  if (options.hasRepairLoopPauseLabel) return null;
  if (options.hasAutomergeLabel) return "automerge_armed";
  if (options.hasRecentReReviewRequest) return "re_review_loop";
  if (options.hasRecentAuthorActivity && unresolvedWork) return "actively_grinding";
  if (proofNeedsContributorAction(options.realBehaviorProof)) return "needs_proof";
  if (unresolvedWork) return "waiting_on_author";
  if (isReadyForMaintainerLook(options)) return "ready_for_maintainer_look";
  return null;
}

function prStatusLabelForKind(kind: PrStatusLabelKind): (typeof PR_STATUS_LABELS)[number] {
  const label = PR_STATUS_LABELS.find((candidate) => candidate.kind === kind);
  if (!label) throw new Error(`unknown PR status label kind: ${kind}`);
  return label;
}

function nextPrStatusLabels(
  labels: readonly string[],
  statusKind: PrStatusLabelKind | null,
): string[] {
  const nextLabels = labels.filter((label) => !PR_STATUS_LABEL_NAMES.has(label));
  if (statusKind) nextLabels.push(prStatusLabelForKind(statusKind).name);
  return nextLabels;
}

function hasRepairLoopPauseLabel(labels: readonly string[]): boolean {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  return (
    normalized.has(HUMAN_REVIEW_LABEL) ||
    normalized.has(MANUAL_ONLY_LABEL) ||
    normalized.has(MERGE_READY_LABEL)
  );
}

function eventTimestampMs(value: unknown): number | null {
  const record = asRecord(value);
  return timestampMs(stringOrUndefined(record.updatedAt) ?? stringOrUndefined(record.createdAt));
}

function isAfterReview(value: unknown, reviewedAtMs: number | null): boolean {
  if (reviewedAtMs === null) return false;
  const eventMs = eventTimestampMs(value);
  return eventMs !== null && eventMs > reviewedAtMs;
}

function isReReviewRequestText(text: unknown): boolean {
  const body = stringOrUndefined(text)?.trim() ?? "";
  if (!body) return false;
  return (
    /^\s*\/review(?:\s|$)/im.test(body) ||
    /^\s*\/clawsweeper\s+(?:re-?review|rerun|re-run|run\s+review|review)(?:\s|$)/im.test(body) ||
    /(?:^|\s)@clawsweeper(?:\[bot\])?\s+(?:re-?review|rerun|re-run|run\s+review|review)(?:\s|$)/im.test(
      body,
    )
  );
}

function hasRecentReReviewRequest(
  context: Pick<ItemContext, "comments">,
  reviewedAt: string | undefined,
): boolean {
  const reviewedAtMs = timestampMs(reviewedAt);
  return context.comments.some((comment) => {
    const record = asRecord(comment);
    if (isAutomationReportAuthor(stringOrUndefined(record.author))) return false;
    return isAfterReview(comment, reviewedAtMs) && isReReviewRequestText(record.body);
  });
}

function hasRecentAuthorActivity(
  context: Pick<ItemContext, "comments" | "timeline">,
  options: { reviewedAt: string | undefined; author: string | undefined },
): boolean {
  const author = String(options.author ?? "")
    .trim()
    .toLowerCase();
  if (!author) return false;
  const reviewedAtMs = timestampMs(options.reviewedAt);
  return (
    context.comments.some((comment) => {
      const record = asRecord(comment);
      return (
        isAfterReview(comment, reviewedAtMs) &&
        stringOrUndefined(record.author)?.toLowerCase() === author
      );
    }) ||
    context.timeline.some((event) => {
      const record = asRecord(event);
      return (
        isAfterReview(event, reviewedAtMs) &&
        stringOrUndefined(record.actor)?.toLowerCase() === author &&
        typeof record.commitId === "string" &&
        record.commitId.length > 0
      );
    })
  );
}

function prStatusLabelKindFromReport(
  markdown: string,
  context: ItemContext,
  currentLabels: readonly string[],
): PrStatusLabelKind | null {
  if (frontMatterValue(markdown, "type") !== "pull_request") return null;
  return prStatusLabelKind({
    realBehaviorProof: reportRealBehaviorProof(markdown),
    reviewFindings: reportReviewFindings(markdown),
    securityReview: reportSecurityReview(markdown),
    mergeRiskOptions: mergeRiskOptionsFromReport(markdown),
    overallCorrectness: reportOverallCorrectness(markdown),
    hasAutomergeLabel: currentLabels.includes(AUTOMERGE_LABEL),
    hasRepairLoopPauseLabel: hasRepairLoopPauseLabel(currentLabels),
    hasRecentReReviewRequest: hasRecentReReviewRequest(
      context,
      frontMatterValue(markdown, "reviewed_at"),
    ),
    hasRecentAuthorActivity: hasRecentAuthorActivity(context, {
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      author: frontMatterValue(markdown, "author"),
    }),
  });
}

export function prStatusLabelsForTest(
  labels: readonly string[],
  options: {
    isPullRequest?: boolean;
    nextSteps?: readonly string[];
    proofStatus?: string;
    findingPriorities?: readonly number[];
    securityStatus?: string;
    mergeRiskOptions?: readonly Pick<MergeRiskOption, "category" | "recommended">[];
    overallCorrectness?: string;
    hasAutomergeLabel?: boolean;
    hasRecentReReviewRequest?: boolean;
    hasRecentAuthorActivity?: boolean;
    reviewedAt?: string;
    comments?: readonly {
      author?: string;
      body?: string;
      createdAt?: string;
      updatedAt?: string;
    }[];
  },
): string[] {
  if (options.isPullRequest === false) return nextPrStatusLabels(labels, null);
  const hasRecentReReviewRequestValue =
    options.hasRecentReReviewRequest ??
    hasRecentReReviewRequest(
      { comments: [...(options.comments ?? [])] },
      options.reviewedAt ?? "2026-01-01T00:00:00Z",
    );
  const statusKind = prStatusLabelKind({
    realBehaviorProof: {
      status: REAL_BEHAVIOR_PROOF_STATUSES.has(options.proofStatus as RealBehaviorProofStatus)
        ? (options.proofStatus as RealBehaviorProofStatus)
        : "not_applicable",
    },
    reviewFindings: (options.findingPriorities ?? [])
      .filter((priority): priority is 0 | 1 | 2 | 3 => [0, 1, 2, 3].includes(priority))
      .map((priority) => ({ priority })),
    securityReview: {
      status: SECURITY_REVIEW_STATUSES.has(options.securityStatus as SecurityReviewStatus)
        ? (options.securityStatus as SecurityReviewStatus)
        : "cleared",
    },
    mergeRiskOptions: options.mergeRiskOptions ?? [],
    overallCorrectness: OVERALL_CORRECTNESS_VALUES.has(
      options.overallCorrectness as OverallCorrectness,
    )
      ? (options.overallCorrectness as OverallCorrectness)
      : "patch is correct",
    hasAutomergeLabel: options.hasAutomergeLabel ?? labels.includes(AUTOMERGE_LABEL),
    hasRepairLoopPauseLabel: hasRepairLoopPauseLabel(labels),
    hasRecentReReviewRequest: hasRecentReReviewRequestValue,
    hasRecentAuthorActivity: options.hasRecentAuthorActivity === true,
  });
  return nextPrStatusLabels(labels, statusKind);
}

export function prStatusLabelSchemeForTest(): {
  kind: PrStatusLabelKind;
  name: string;
  color: string;
  description: string;
}[] {
  return PR_STATUS_LABELS.map(({ kind, name, color, description }) => ({
    kind,
    name,
    color,
    description,
  }));
}

function pullRequestFilePathsFromReport(markdown: string): string[] {
  return frontMatterStringArray(markdown, "pull_files");
}

interface ConfigSurfaceChange {
  change: boolean;
  keys: string[];
}

function configSurfaceChangeFromContext(repo: string, context: ItemContext): ConfigSurfaceChange {
  if (repo !== "openclaw/openclaw") {
    return { change: false, keys: [] };
  }

  const keys = new Set<string>();
  for (const entry of context.pullFiles ?? []) {
    const file = asRecord(entry);
    const path = typeof file.filename === "string" ? file.filename.trim() : "";
    const previousPath =
      typeof file.previous_filename === "string" ? file.previous_filename.trim() : "";
    const configSurfacePath = [path, previousPath].find(isOpenClawConfigSurfacePath);
    if (!configSurfacePath) continue;
    const patch = typeof file.patch === "string" ? file.patch : null;
    if (patch !== null && configSurfacePatchIsTruncated(patch)) {
      keys.add("unknown-config-surface-change");
    }
    const lines = patch === null ? [] : changedPatchLines(patch);
    if (patch === null || lines.length === 0) {
      keys.add("unknown-config-surface-change");
    }
    for (const line of lines) {
      const lineKeys = configSurfaceKeysFromPatchLine(configSurfacePath, line);
      if (
        lineKeys.length === 0 &&
        !isMarkdownConfigSurfacePath(configSurfacePath) &&
        configSurfaceLineNeedsUnknownMarker(line)
      ) {
        keys.add("unknown-config-surface-change");
      }
      for (const key of lineKeys) {
        keys.add(key);
      }
    }
  }

  if (context.counts?.pullFilesTruncated) {
    keys.add("unknown-truncated-pull-files");
  }

  return { change: keys.size > 0, keys: [...keys].sort() };
}

export function configSurfaceChangeFromPullFilesForTest(options: {
  repo?: string;
  pullFiles?: unknown[];
  pullFilesTruncated?: boolean;
}): ConfigSurfaceChange {
  const counts: ItemContext["counts"] = { comments: 0, timeline: 0 };
  if (options.pullFilesTruncated !== undefined)
    counts.pullFilesTruncated = options.pullFilesTruncated;
  const context: ItemContext = {
    issue: {},
    comments: [],
    timeline: [],
    counts,
  };
  if (options.pullFiles !== undefined) context.pullFiles = options.pullFiles;
  return configSurfaceChangeFromContext(options.repo ?? "openclaw/openclaw", context);
}

interface DataModelChange {
  change: boolean;
  surfaces: string[];
}

function dataModelChangeFromContext(repo: string, context: ItemContext): DataModelChange {
  if (repo !== "openclaw/openclaw") {
    return { change: false, surfaces: [] };
  }

  const surfaces = new Set<string>();
  for (const entry of context.pullFiles ?? []) {
    const file = asRecord(entry);
    const path = typeof file.filename === "string" ? file.filename.trim() : "";
    const previousPath =
      typeof file.previous_filename === "string" ? file.previous_filename.trim() : "";
    const candidates = [path, previousPath].filter(Boolean);
    const likelyPath = candidates.find(isLikelyOpenClawDataModelPath) ?? "";
    const patch = typeof file.patch === "string" ? file.patch : null;
    const lines = patch === null ? [] : changedPatchLines(patch);

    if (
      likelyPath &&
      (patch === null || lines.length === 0 || configSurfacePatchIsTruncated(patch))
    ) {
      surfaces.add(dataModelSurfaceLabel(likelyPath, "unknown-data-model-change"));
    }

    for (const candidate of candidates) {
      if (isDocsPath(candidate)) {
        if (patch !== null && !configSurfacePatchIsTruncated(patch)) {
          dataModelSurfacesFromPatch(candidate, lines, { docsOnly: true }).forEach((surface) =>
            surfaces.add(surface),
          );
        }
        continue;
      }
      dataModelSurfacesFromPatch(candidate, lines, { docsOnly: false }).forEach((surface) =>
        surfaces.add(surface),
      );
    }
  }

  if (context.counts?.pullFilesTruncated) {
    surfaces.add("unknown-truncated-pull-files");
  }

  return { change: surfaces.size > 0, surfaces: [...surfaces].sort() };
}

export function dataModelChangeFromPullFilesForTest(options: {
  repo?: string;
  pullFiles?: unknown[];
  pullFilesTruncated?: boolean;
}): DataModelChange {
  const counts: ItemContext["counts"] = { comments: 0, timeline: 0 };
  if (options.pullFilesTruncated !== undefined)
    counts.pullFilesTruncated = options.pullFilesTruncated;
  const context: ItemContext = {
    issue: {},
    comments: [],
    timeline: [],
    counts,
  };
  if (options.pullFiles !== undefined) context.pullFiles = options.pullFiles;
  return dataModelChangeFromContext(options.repo ?? "openclaw/openclaw", context);
}

function isOpenClawConfigSurfacePath(path: string): boolean {
  return (
    /^src\/config\/(?:zod-schema[^/]*|types[^/]*|schema(?:[-.][^/]*)?)\.ts$/.test(path) ||
    /^src\/plugins\/manifest(?:-registry)?\.ts$/.test(path) ||
    /^docs\/gateway\/configuration[^/]*\.md$/.test(path) ||
    path === "docs/plugins/manifest.md"
  );
}

function changedPatchLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1).trim());
}

function configSurfaceLineNeedsUnknownMarker(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && !/^\/\/|^\/\*|^\*/.test(trimmed);
}

function configSurfacePatchIsTruncated(patch: string): boolean {
  return /\n\n\[truncated \d+ chars\]$/.test(patch);
}

function configSurfaceKeysFromPatchLine(path: string, line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || /^\/\/|^\/\*|^\*|^<!--/.test(trimmed)) return [];

  const keys = new Set<string>();
  for (const match of trimmed.matchAll(/`([^`]+)`/g)) {
    const token = match[1]?.trim();
    if (token && markdownConfigSurfaceTokenLooksSemantic(path, trimmed, token)) keys.add(token);
  }

  if (!isMarkdownConfigSurfacePath(path)) {
    const property = trimmed.match(
      /^(?:readonly\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$.-]*))\??\s*:/,
    );
    const key = property?.[1] ?? property?.[2] ?? property?.[3];
    if (key && isConfigSurfaceToken(key)) {
      keys.add(pluginManifestConfigSurfaceKey(path, key));
    }

    if (/\b(?:z\.enum|Type\.Literal|enum)\b/.test(trimmed)) {
      for (const match of trimmed.matchAll(/["']([A-Za-z0-9_.-]+)["']/g)) {
        const token = match[1]?.trim();
        if (token && isConfigSurfaceToken(token)) keys.add(token);
      }
    }
  }

  return [...keys];
}

function isMarkdownConfigSurfacePath(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function markdownConfigSurfaceTokenLooksSemantic(
  path: string,
  line: string,
  token: string,
): boolean {
  if (!isConfigSurfaceToken(token)) return false;
  if (!isMarkdownConfigSurfacePath(path)) return true;
  return /[.[\]]/.test(token) || /^[A-Z0-9_]{3,}$/.test(token) || /^\s*(?:\||[-*]\s+`)/.test(line);
}

function isConfigSurfaceToken(token: string): boolean {
  return (
    token.length >= 2 &&
    token.length <= 120 &&
    /^[A-Za-z0-9_.[\]-]+$/.test(token) &&
    /[A-Za-z]/.test(token)
  );
}

function pluginManifestConfigSurfaceKey(path: string, key: string): string {
  if (!path.startsWith("src/plugins/manifest") || key.includes(".") || key === "contracts") {
    return key;
  }
  return `contracts.${key}`;
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
  const text = [
    reviewSectionValue(markdown, "realBehaviorProof"),
    reviewSectionValue(markdown, "solutionAssessment"),
    reviewSectionValue(markdown, "evidence"),
  ].join("\n");
  const noMigrationRequiredPattern =
    /\bno\s+(?:data\s+)?migrations?\s+(?:(?:is|are)\s+)?(?:required|needed|necessary)\b/i;
  const negativeProofText = text.replace(
    new RegExp(noMigrationRequiredPattern.source, "gi"),
    "migration unnecessary",
  );
  if (
    /\b(?:missing|lacks?|without|no)\b[^.]{0,120}\b(?:migration|upgrade|backfill|compatibility)\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b[^.]{0,120}\b(?:required|needed|missing|todo|before merge)\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:must|should|needs?|requires?|required|needed|todo)\b[^.]{0,120}\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b[^.]{0,180}\b(?:not|never)\b[^.]{0,80}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es)|migrat(?:e|ed|es)|backfill(?:ed|s)?)\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:not|never)\b[^.]{0,80}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es))\b[^.]{0,180}\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:should|would|will|expected|intend(?:ed)?|designed|aims?|plans?|promises?)\b[^.]{0,120}\b(?:preserv(?:e|ed|es)|remain(?:s)? compatible|compatib(?:le|ility)|migration|upgrade|backfill)\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:migration|upgrade|backfill|existing data|existing database|existing cache|existing state)\b[^.]{0,120}\b(?:should|would|will|expected|intend(?:ed)?|designed|aims?|plans?|promises?|planned|pending|unimplemented)\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b[^.]{0,120}\b(?:is|are|remains?)?\s*(?:planned|pending|future|unimplemented|incomplete|todo|not yet|to be (?:added|done|implemented|verified|tested))\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:planned|pending|future|unimplemented|incomplete|todo|not yet|to be (?:added|done|implemented|verified|tested))\b[^.]{0,120}\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    noMigrationRequiredPattern.test(text) &&
    /\b(?:existing data|existing database|existing cache|existing state|upgrade compatibility|compatibility)\b[^.]{0,160}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es))\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return (
    /\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b[^.]{0,180}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es)|migrat(?:e|ed|es)|backfill(?:ed|s)?)\b/i.test(
      text,
    ) ||
    /\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|preserv(?:e|ed|es))\b[^.]{0,180}\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b/i.test(
      text,
    )
  );
}

function dataModelSurfacesFromPatch(
  path: string,
  lines: readonly string[],
  options: { docsOnly: boolean },
): string[] {
  const text = lines.filter((line) => dataModelLineLooksSemantic(line, options)).join("\n");
  if (!text) return [];

  const surfaces = new Set<string>();
  const add = (surface: string) => surfaces.add(dataModelSurfaceLabel(path, surface));
  const pathHint = dataModelPathHint(path);
  if (pathHint && dataModelTextMatchesPathHint(text, pathHint)) add(pathHint);
  if (pathHint && dataModelTextLooksLikePersistedShapeField(text, pathHint)) add(pathHint);
  if (
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|COLUMN)\b|\bADD\s+COLUMN\b|\bPRAGMA\s+user_version\b|\bschema[_-]?version\b/i.test(
      text,
    )
  ) {
    add("database schema");
  }
  if (/\b(?:migration|migrate|upgrade|backfill|doctor|repair|reindex|rehydrat\w*)\b/i.test(text)) {
    add("migration/backfill/repair");
  }
  if (
    /\b(?:DurableObject|state\.storage|storage\.(?:get|put|delete|list)|blockConcurrencyWhile)\b/i.test(
      text,
    )
  ) {
    add("durable storage schema");
  }
  if (
    /\b(?:JSON\.(?:parse|stringify)|readFile|writeFile|localStorage|sessionStorage|workspaceState|globalState|serialized|persisted?|statePath)\b/i.test(
      text,
    )
  ) {
    add("serialized state");
  }
  if (
    /\b(?:cache(?:Key|Version|Schema|Namespace)?|cache[_-]?(?:key|version|schema|namespace)|ttl)\b/i.test(
      text,
    )
  ) {
    add("persistent cache schema");
  }
  if (
    /\b(?:embedding|vector|collection|dimension|metadata|row[_-]?id|document[_-]?id|chunk[_-]?id|similarity[_-]?index)\b/i.test(
      text,
    )
  ) {
    add("vector/embedding metadata");
  }
  return [...surfaces];
}

function dataModelLineLooksSemantic(line: string, options: { docsOnly: boolean }): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^\/\/|^\/\*|^\*|^<!--/.test(trimmed)) return false;
  if (!options.docsOnly) return true;
  return /\b(?:schema|migration|migrate|upgrade|backfill|database|sqlite|postgres|durable object|storage|cache|serialized|json state|embedding|vector|metadata|doctor|repair)\b/i.test(
    trimmed,
  );
}

function isLikelyOpenClawDataModelPath(path: string): boolean {
  if (!path || isDocsPath(path)) return false;
  return Boolean(dataModelPathHint(path)) || /\.(?:sql|sqlite|db|prisma)$/.test(path);
}

function dataModelPathHint(path: string): string {
  if (
    /(^|\/)(?:durable-?objects?|workers?|storage)(?:\/|[-_.])|durable-?object|state-storage/i.test(
      path,
    )
  ) {
    return "durable storage schema";
  }
  if (/(^|\/)(?:cache|caches)(?:\/|[-_.])|cache[-_.]schema/i.test(path)) {
    return "persistent cache schema";
  }
  if (
    /(^|\/)(?:state|sessions?|history|persistence)(?:\/|[-_.])|(?:serialized|persisted?)[-_.]?(?:state|json)/i.test(
      path,
    )
  ) {
    return "serialized state";
  }
  if (
    /(^|\/)(?:vector|embedding|embeddings|memory)(?:\/|[-_.])|(?:vector|embedding|metadata|row-id|document-id|chunk-id)/i.test(
      path,
    )
  ) {
    return "vector/embedding metadata";
  }
  if (
    /(^|\/)(?:migrations?|backfill|doctor|repair|upgrade)(?:\/|[-_.])|(?:migration|backfill|doctor|repair|upgrade)\.(?:ts|js)$/i.test(
      path,
    )
  ) {
    return "migration/backfill/repair";
  }
  if (
    /\.sql$|(^|\/)(?:migrations?|schema|database|db|sql)(?:\/|[-_.])|(?:schema|migration|ddl|prisma)\.(?:ts|js|sql|prisma)$/i.test(
      path,
    )
  ) {
    return "database schema";
  }
  return "";
}

function dataModelTextMatchesPathHint(text: string, pathHint: string): boolean {
  switch (pathHint) {
    case "database schema":
      return (
        /\b(?:migration|migrate|schema[_-]?version|user_version|CREATE|ALTER|DROP)\b/i.test(text) ||
        /\b(?:sqliteTable|pgTable|mysqlTable|defineTable|createTable|createIndex|table|column|index|primaryKey|foreignKey|uniqueIndex)\b/i.test(
          text,
        )
      );
    case "durable storage schema":
      return /\b(?:DurableObject|storage|schema|migration|state)\b/i.test(text);
    case "persistent cache schema":
      return /\b(?:cache|schema|key|version|namespace|ttl)\b/i.test(text);
    case "serialized state":
      return /\b(?:JSON|serialized|persisted?|state|session|history|schema|version)\b/i.test(text);
    case "vector/embedding metadata":
      return /\b(?:embedding|vector|collection|dimension|metadata|row[_-]?id|document[_-]?id|chunk[_-]?id|schema|version)\b/i.test(
        text,
      );
    case "migration/backfill/repair":
      return /\b(?:migration|migrate|upgrade|backfill\w*|doctor|repair|schema|version|existing data|INSERT|UPDATE|DELETE)\b/i.test(
        text,
      );
    default:
      return false;
  }
}

function dataModelTextLooksLikePersistedShapeField(text: string, pathHint: string): boolean {
  if (pathHint === "database schema") {
    return (
      /\b[$A-Z_a-z][$\w]*\??\s*:\s*(?:bigint|blob|boolean|bool|datetime|integer|int|jsonb?|numeric|real|serial|sqliteTable|text|timestamp|uuid|varchar)\s*\(/i.test(
        text,
      ) ||
      /\b(?:bigint|blob|boolean|bool|datetime|integer|int|jsonb?|numeric|real|serial|text|timestamp|uuid|varchar)\s*\(\s*["'`][^"'`]+["'`]/i.test(
        text,
      )
    );
  }

  return /\b[$A-Z_a-z][$\w]*\??\s*:\s*(?:Array|Map|ReadonlyArray|Record|Set|boolean|number|string|unknown|[$A-Z_a-z][$\w]*)(?:\b|[<[\]])/i.test(
    text,
  );
}

function dataModelSurfaceLabel(path: string, surface: string): string {
  return `${surface}: ${path}`;
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
  if (metrics.length === 0) return "**Review metrics:** none identified.";
  const noun = metrics.length === 1 ? "metric" : "metrics";
  return [
    `**Review metrics:** ${metrics.length} noteworthy ${noun}.`,
    ...metrics.map((metric) => `- **${metric.label}:** ${metric.value}. ${metric.reason}`),
  ].join("\n");
}

function isDocsPath(file: string): boolean {
  return file.startsWith("docs/");
}

function isDocsOnlyPullRequestReport(markdown: string): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  if (frontMatterBoolean(markdown, "pull_files_truncated")) return false;
  const files = pullRequestFilePathsFromReport(markdown);
  return files.length > 0 && files.every(isDocsPath);
}

function nextRealBehaviorProofSufficientLabels(
  labels: readonly string[],
  proof: Pick<RealBehaviorProof, "status">,
): string[] {
  const nextLabels = labels.filter((label) => label !== PROOF_SUFFICIENT_LABEL);
  if (proof.status === "sufficient") nextLabels.push(PROOF_SUFFICIENT_LABEL);
  return nextLabels;
}

function nextRealBehaviorProofMediaLabels(
  labels: readonly string[],
  proof: Pick<RealBehaviorProof, "evidenceKind">,
): string[] {
  const nextLabels = labels.filter((label) => !PROOF_MEDIA_LABEL_NAMES.has(label));
  const mediaLabel = PROOF_MEDIA_LABELS.find((label) => label.evidenceKind === proof.evidenceKind);
  if (mediaLabel) nextLabels.push(mediaLabel.name);
  return nextLabels;
}

export function realBehaviorProofSufficientLabelsForTest(
  labels: readonly string[],
  status: string,
): string[] {
  const proofStatus = REAL_BEHAVIOR_PROOF_STATUSES.has(status as RealBehaviorProofStatus)
    ? (status as RealBehaviorProofStatus)
    : "not_applicable";
  return nextRealBehaviorProofSufficientLabels(labels, { status: proofStatus });
}

export function realBehaviorProofMediaLabelsForTest(
  labels: readonly string[],
  evidenceKind: string,
): string[] {
  const proofEvidenceKind = REAL_BEHAVIOR_PROOF_EVIDENCE_KINDS.has(
    evidenceKind as RealBehaviorProofEvidenceKind,
  )
    ? (evidenceKind as RealBehaviorProofEvidenceKind)
    : "not_applicable";
  return nextRealBehaviorProofMediaLabels(labels, { evidenceKind: proofEvidenceKind });
}

export function prRatingLabelsForTest(
  labels: readonly string[],
  tier: string,
  reviewFailed = false,
): string[] {
  const overallTier = PR_RATING_TIERS.has(tier as PrRatingTier) ? (tier as PrRatingTier) : "NA";
  return nextPrRatingLabels(labels, { overallTier }, reviewFailed);
}

export function prRatingLabelSchemeForTest(): {
  tier: PrRatingTier;
  name: string;
  color: string;
  description: string;
}[] {
  return PR_RATING_LABELS.map(({ tier, name, color, description }) => ({
    tier,
    name,
    color,
    description,
  }));
}

function nextTelegramVisibleProofLabels(
  labels: readonly string[],
  proof: Pick<TelegramVisibleProof, "status">,
): string[] {
  const nextLabels = labels.filter((label) => label !== TELEGRAM_VISIBLE_PROOF_LABEL);
  if (proof.status === "needed") nextLabels.push(TELEGRAM_VISIBLE_PROOF_LABEL);
  return nextLabels;
}

export function telegramVisibleProofLabelsForTest(
  labels: readonly string[],
  status: string,
): string[] {
  const proofStatus = TELEGRAM_VISIBLE_PROOF_STATUSES.has(status as TelegramVisibleProofStatus)
    ? (status as TelegramVisibleProofStatus)
    : "not_needed";
  return nextTelegramVisibleProofLabels(labels, { status: proofStatus });
}

type PriorityLabelSpec = (typeof PRIORITY_LABELS)[number];

function priorityLabelForTriage(priority: TriagePriority): PriorityLabelSpec | null {
  return PRIORITY_LABELS.find((label) => label.triagePriority === priority) ?? null;
}

function nextPriorityLabels(labels: readonly string[], triagePriority: TriagePriority): string[] {
  const nextLabels = labels.filter((label) => !PRIORITY_LABEL_NAMES.has(label));
  const priorityLabel = priorityLabelForTriage(triagePriority);
  if (priorityLabel) nextLabels.push(priorityLabel.name);
  return nextLabels;
}

export function priorityLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return PRIORITY_LABELS.map(({ name, color, description }) => ({ name, color, description }));
}

export function priorityLabelsForTest(labels: readonly string[], triagePriority: string): string[] {
  const priority = TRIAGE_PRIORITIES.has(triagePriority as TriagePriority)
    ? (triagePriority as TriagePriority)
    : "none";
  return nextPriorityLabels(labels, priority);
}

function nextImpactLabels(
  labels: readonly string[],
  impactLabels: readonly ImpactLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !IMPACT_LABEL_NAMES.has(label));
  const uniqueImpactLabels = new Set(impactLabels);
  for (const label of IMPACT_LABELS) {
    if (uniqueImpactLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}

export function impactLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return IMPACT_LABELS.map(({ name, color, description }) => ({ name, color, description }));
}

export function impactLabelsForTest(
  labels: readonly string[],
  impactLabels: readonly string[],
): string[] {
  return nextImpactLabels(
    labels,
    impactLabels.filter((label): label is ImpactLabelName => IMPACT_LABEL_NAMES.has(label)),
  );
}

function nextMaturityLabels(
  labels: readonly string[],
  maturityLabels: readonly MaturityLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !MATURITY_LABEL_NAMES.has(label));
  const uniqueMaturityLabels = new Set(maturityLabels);
  for (const label of MATURITY_LABELS) {
    if (uniqueMaturityLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}

export function maturityLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return MATURITY_LABELS.map(({ name, color, description }) => ({ name, color, description }));
}

export function maturityLabelsForTest(
  labels: readonly string[],
  maturityLabels: readonly string[],
): string[] {
  return nextMaturityLabels(
    labels,
    maturityLabels.filter((label): label is MaturityLabelName => MATURITY_LABEL_NAMES.has(label)),
  );
}

function nextMergeRiskLabels(
  labels: readonly string[],
  mergeRiskLabels: readonly MergeRiskLabelName[],
): string[] {
  const nextLabels = labels.filter((label) => !MERGE_RISK_LABEL_NAMES.has(label));
  const uniqueMergeRiskLabels = new Set(mergeRiskLabels);
  for (const label of MERGE_RISK_LABELS) {
    if (uniqueMergeRiskLabels.has(label.name)) nextLabels.push(label.name);
  }
  return nextLabels;
}

export function mergeRiskLabelSchemeForTest(): {
  name: string;
  color: string;
  description: string;
}[] {
  return MERGE_RISK_LABELS.map(({ name, color, description }) => ({
    name,
    color,
    description,
  }));
}

export function mergeRiskLabelsForTest(
  labels: readonly string[],
  mergeRiskLabels: readonly string[],
): string[] {
  return nextMergeRiskLabels(
    labels,
    mergeRiskLabels.filter((label): label is MergeRiskLabelName =>
      MERGE_RISK_LABEL_NAMES.has(label),
    ),
  );
}

function ensurePriorityLabel(label: PriorityLabelSpec): void {
  try {
    ghWithRetry(
      ["label", "create", label.name, "--color", label.color, "--description", label.description],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensureImpactLabel(name: ImpactLabelName): void {
  const definition = IMPACT_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensureMergeRiskLabel(name: MergeRiskLabelName): void {
  const definition = MERGE_RISK_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

interface IssueAdvisoryLabelState {
  type: string | undefined;
  itemCategory: string | undefined;
  reproductionStatus: string | undefined;
  reproductionConfidence: string | undefined;
  requiresNewFeature: boolean;
  requiresNewConfigOption: boolean;
  requiresProductDecision: boolean;
  implementationComplexity: string | undefined;
  autoImplementationCandidate: string | undefined;
  securityReviewStatus: string | undefined;
  workCandidate: string | undefined;
  workStatus: string | undefined;
  workConfidence: string | undefined;
  hasWorkShape: boolean;
  hasWorkPrompt: boolean;
  hasWorkValidation: boolean;
  goodFirstIssueOptedOut: boolean;
  locked: boolean;
  hasOpenLinkedPullRequest: boolean;
}

function isIssueAdvisoryLabel(label: string): boolean {
  return ISSUE_ADVISORY_LABEL_NAMES.has(label.toLowerCase());
}

function isSecuritySensitiveLabel(label: string): boolean {
  const normalized = normalizeLabelName(label);
  return (
    normalized === "impact:security" ||
    normalized === "security" ||
    normalized === "security-sensitive" ||
    normalized === "security sensitive" ||
    normalized === "type: security" ||
    normalized === "type:security" ||
    normalized === "kind: security" ||
    normalized === "kind:security" ||
    normalized.startsWith("security:") ||
    normalized.startsWith("security/")
  );
}

function isGoodFirstIssue(
  state: IssueAdvisoryLabelState,
  currentLabels: readonly string[],
): boolean {
  return (
    state.type === "issue" &&
    state.itemCategory === "bug" &&
    state.reproductionStatus === "reproduced" &&
    state.reproductionConfidence === "high" &&
    !state.requiresNewFeature &&
    !state.requiresNewConfigOption &&
    !state.requiresProductDecision &&
    state.implementationComplexity === "small" &&
    state.autoImplementationCandidate === "strict_bug" &&
    state.securityReviewStatus !== "needs_attention" &&
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high" &&
    state.hasWorkPrompt &&
    state.hasWorkValidation &&
    !state.goodFirstIssueOptedOut &&
    !state.locked &&
    !currentLabels.some(isSecuritySensitiveLabel) &&
    protectedLabels(currentLabels).length === 0 &&
    !state.hasOpenLinkedPullRequest
  );
}

function issueRatingLabelForState(state: IssueAdvisoryLabelState): string {
  if (state.type !== "issue") return "";
  if (state.reproductionStatus === "not_applicable") {
    return "issue-rating: 🌊 off-meta tidepool";
  }
  if (state.reproductionStatus === "reproduced" && state.reproductionConfidence === "high") {
    return "issue-rating: 🦀 challenger crab";
  }
  if (
    (state.reproductionStatus === "source_reproducible" ||
      state.reproductionStatus === "reproduced") &&
    state.reproductionConfidence === "high"
  ) {
    return "issue-rating: 🦞 diamond lobster";
  }
  if (
    (state.reproductionStatus === "source_reproducible" ||
      state.reproductionStatus === "reproduced") &&
    state.reproductionConfidence === "medium"
  ) {
    return "issue-rating: 🐚 platinum hermit";
  }
  if (state.reproductionStatus === "unclear" && state.reproductionConfidence === "medium") {
    return "issue-rating: 🦐 gold shrimp";
  }
  if (
    state.reproductionStatus === "not_reproduced" ||
    (state.reproductionStatus === "unclear" && state.reproductionConfidence === "low")
  ) {
    return "issue-rating: 🦪 silver shellfish";
  }
  return "issue-rating: 🧂 unranked krab";
}

function wantedIssueAdvisoryLabels(
  state: IssueAdvisoryLabelState,
  currentLabels: readonly string[],
): Set<string> {
  const labels = new Set<string>();
  if (state.type !== "issue") return labels;
  const issueRatingLabel = issueRatingLabelForState(state);
  if (issueRatingLabel) labels.add(issueRatingLabel);
  if (state.reproductionConfidence === "high") {
    if (state.reproductionStatus === "reproduced") labels.add("clawsweeper:current-main-repro");
    if (state.reproductionStatus === "source_reproducible") labels.add("clawsweeper:source-repro");
    if (state.reproductionStatus === "not_reproduced") labels.add("clawsweeper:not-repro-on-main");
  }
  if (
    state.reproductionStatus === "source_reproducible" &&
    state.reproductionConfidence !== "high"
  ) {
    labels.add("clawsweeper:needs-live-repro");
  }
  if (state.reproductionStatus === "unclear" && state.reproductionConfidence !== "high") {
    labels.add("clawsweeper:needs-info");
  }
  if (state.hasOpenLinkedPullRequest) {
    labels.add("clawsweeper:linked-pr-open");
  }
  if (
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high"
  ) {
    labels.add(QUEUEABLE_FIX_LABEL);
  }
  if (isGoodFirstIssue(state, currentLabels)) {
    labels.add(GOOD_FIRST_ISSUE_LABEL);
  }
  if (
    state.workConfidence === "high" &&
    state.hasWorkShape &&
    (state.workCandidate === "queue_fix_pr" || state.workCandidate === "manual_review")
  ) {
    labels.add("clawsweeper:fix-shape-clear");
  }
  if (state.workCandidate === "manual_review" || state.workStatus === "manual_review") {
    labels.add("clawsweeper:needs-maintainer-review");
  }
  if (state.requiresProductDecision) {
    labels.add("clawsweeper:needs-product-decision");
  }
  if (state.itemCategory === "security" || state.securityReviewStatus === "needs_attention") {
    labels.add("clawsweeper:needs-security-review");
  }
  if (
    state.hasOpenLinkedPullRequest ||
    state.workCandidate === "manual_review" ||
    state.workStatus === "manual_review" ||
    state.requiresProductDecision ||
    state.itemCategory === "security" ||
    state.securityReviewStatus === "needs_attention"
  ) {
    labels.add("clawsweeper:no-new-fix-pr");
  }
  return labels;
}

function issueAdvisoryStateNeedsStaleProtection(state: IssueAdvisoryLabelState): boolean {
  return (
    state.type === "issue" &&
    state.workCandidate === "queue_fix_pr" &&
    state.workStatus === "candidate" &&
    state.workConfidence === "high"
  );
}

function issueAdvisoryLabelsHadQueueableProtection(labels: readonly string[]): boolean {
  return labels.some((label) => label.toLowerCase() === QUEUEABLE_FIX_LABEL);
}

function nextIssueAdvisoryLabels(
  labels: readonly string[],
  state: IssueAdvisoryLabelState,
): string[] {
  const wantedLabels = wantedIssueAdvisoryLabels(state, labels);
  const needsStaleProtection = issueAdvisoryStateNeedsStaleProtection(state);
  const hadQueueableProtection = issueAdvisoryLabelsHadQueueableProtection(labels);
  const nextLabels = labels.filter(
    (label) =>
      !isIssueAdvisoryLabel(label) &&
      !(needsStaleProtection && label.toLowerCase() === STALE_LABEL) &&
      !(!needsStaleProtection && hadQueueableProtection && label.toLowerCase() === NO_STALE_LABEL),
  );
  if (needsStaleProtection && !nextLabels.some((label) => label.toLowerCase() === NO_STALE_LABEL)) {
    nextLabels.push(NO_STALE_LABEL);
  }
  for (const label of ISSUE_ADVISORY_LABELS) {
    if (wantedLabels.has(label.name)) nextLabels.push(label.name);
  }
  if (
    wantedLabels.has(GOOD_FIRST_ISSUE_LABEL) &&
    !nextLabels.some((label) => label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL)
  ) {
    nextLabels.push(GOOD_FIRST_ISSUE_LABEL);
  }
  return nextLabels;
}

export function issueAdvisoryLabelsForTest(
  labels: readonly string[],
  state: Partial<IssueAdvisoryLabelState>,
): string[] {
  return nextIssueAdvisoryLabels(labels, {
    type: state.type,
    itemCategory: state.itemCategory,
    reproductionStatus: state.reproductionStatus,
    reproductionConfidence: state.reproductionConfidence,
    requiresNewFeature: state.requiresNewFeature ?? false,
    requiresNewConfigOption: state.requiresNewConfigOption ?? false,
    requiresProductDecision: state.requiresProductDecision ?? false,
    implementationComplexity: state.implementationComplexity,
    autoImplementationCandidate: state.autoImplementationCandidate,
    securityReviewStatus: state.securityReviewStatus,
    workCandidate: state.workCandidate,
    workStatus: state.workStatus,
    workConfidence: state.workConfidence,
    hasWorkShape: state.hasWorkShape ?? false,
    hasWorkPrompt: state.hasWorkPrompt ?? false,
    hasWorkValidation: state.hasWorkValidation ?? false,
    goodFirstIssueOptedOut: state.goodFirstIssueOptedOut ?? false,
    locked: state.locked ?? false,
    hasOpenLinkedPullRequest: state.hasOpenLinkedPullRequest ?? false,
  });
}

function issueAdvisoryLabelStateFromReport(
  markdown: string,
  options: {
    goodFirstIssueOptedOut?: boolean;
    hasOpenLinkedPullRequest?: boolean;
    locked?: boolean;
  } = {},
): IssueAdvisoryLabelState {
  const workLikelyFiles = frontMatterStringArray(markdown, "work_likely_files");
  const workValidation = frontMatterStringArray(markdown, "work_validation");
  const workPrompt = reviewSectionValue(markdown, "repairWorkPrompt").trim();
  return {
    type: frontMatterValue(markdown, "type"),
    itemCategory: frontMatterValue(markdown, "item_category"),
    reproductionStatus: frontMatterValue(markdown, "reproduction_status"),
    reproductionConfidence: frontMatterValue(markdown, "reproduction_confidence"),
    requiresNewFeature: frontMatterValue(markdown, "requires_new_feature") === "true",
    requiresNewConfigOption: frontMatterValue(markdown, "requires_new_config_option") === "true",
    requiresProductDecision: frontMatterValue(markdown, "requires_product_decision") === "true",
    implementationComplexity: frontMatterValue(markdown, "implementation_complexity"),
    autoImplementationCandidate: frontMatterValue(markdown, "auto_implementation_candidate"),
    securityReviewStatus: reportSecurityReview(markdown).status,
    workCandidate: frontMatterValue(markdown, "work_candidate"),
    workStatus: frontMatterValue(markdown, "work_status"),
    workConfidence: frontMatterValue(markdown, "work_confidence"),
    hasWorkShape: Boolean(workPrompt || workLikelyFiles.length || workValidation.length),
    hasWorkPrompt: Boolean(workPrompt),
    hasWorkValidation: workValidation.length > 0,
    goodFirstIssueOptedOut: options.goodFirstIssueOptedOut === true,
    locked: options.locked === true,
    hasOpenLinkedPullRequest: options.hasOpenLinkedPullRequest === true,
  };
}

function ensureIssueAdvisorySyncLabel(name: string): void {
  const definition =
    ISSUE_ADVISORY_LABELS.find((label) => label.name === name) ??
    (name.toLowerCase() === GOOD_FIRST_ISSUE_LABEL
      ? GOOD_FIRST_ISSUE_LABEL_DEFINITION
      : undefined) ??
    (name.toLowerCase() === ISSUE_STALE_PROTECTION_LABEL.name
      ? ISSUE_STALE_PROTECTION_LABEL
      : undefined);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensureMaturityLabel(name: MaturityLabelName): void {
  const definition = MATURITY_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function syncPriorityLabel(options: {
  number: number;
  labels: readonly string[];
  triagePriority: TriagePriority;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextPriorityLabels(options.labels, options.triagePriority);
  const labelsToRemove = options.labels.filter(
    (label) => PRIORITY_LABEL_NAMES.has(label) && !nextLabels.includes(label),
  );
  const labelToAdd = nextLabels.find(
    (label) => PRIORITY_LABEL_NAMES.has(label) && !options.labels.includes(label),
  );
  const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  if (labelToAdd) {
    const priorityLabel = PRIORITY_LABELS.find((label) => label.name === labelToAdd);
    if (priorityLabel) ensurePriorityLabel(priorityLabel);
  }
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  const added =
    labelToAdd !== undefined &&
    tryAddOptionalLabel({
      number: options.number,
      label: labelToAdd,
      currentLabels: syncedLabels,
    });
  if (added) syncedLabels.push(labelToAdd);
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function syncImpactLabels(options: {
  number: number;
  labels: readonly string[];
  impactLabels: readonly ImpactLabelName[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextImpactLabels(options.labels, options.impactLabels);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label): label is ImpactLabelName =>
      IMPACT_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => IMPACT_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  let added = false;
  for (const label of labelsToAdd) {
    ensureImpactLabel(label);
    if (tryAddOptionalLabel({ number: options.number, label, currentLabels: syncedLabels })) {
      syncedLabels.push(label);
      added = true;
    }
  }
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function syncMaturityLabels(options: {
  number: number;
  labels: readonly string[];
  maturityLabels: readonly MaturityLabelName[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextMaturityLabels(options.labels, options.maturityLabels);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label): label is MaturityLabelName =>
      MATURITY_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => MATURITY_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  let added = false;
  for (const label of labelsToAdd) {
    ensureMaturityLabel(label);
    if (tryAddOptionalLabel({ number: options.number, label, currentLabels: syncedLabels })) {
      syncedLabels.push(label);
      added = true;
    }
  }
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function syncMergeRiskLabels(options: {
  number: number;
  labels: readonly string[];
  mergeRiskLabels: readonly MergeRiskLabelName[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextMergeRiskLabels(options.labels, options.mergeRiskLabels);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label): label is MergeRiskLabelName =>
      MERGE_RISK_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => MERGE_RISK_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  let added = false;
  for (const label of labelsToAdd) {
    ensureMergeRiskLabel(label);
    if (tryAddOptionalLabel({ number: options.number, label, currentLabels: syncedLabels })) {
      syncedLabels.push(label);
      added = true;
    }
  }
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function syncIssueAdvisoryLabels(options: {
  number: number;
  labels: readonly string[];
  state: IssueAdvisoryLabelState;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextIssueAdvisoryLabels(options.labels, options.state);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label) =>
      (isIssueAdvisoryLabel(label) ||
        label.toLowerCase() === GOOD_FIRST_ISSUE_LABEL ||
        label.toLowerCase() === NO_STALE_LABEL) &&
      !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) =>
      (isIssueAdvisoryLabel(label) ||
        label.toLowerCase() === STALE_LABEL ||
        label.toLowerCase() === NO_STALE_LABEL) &&
      !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  let added = false;
  for (const label of labelsToAdd) {
    ensureIssueAdvisorySyncLabel(label);
    if (tryAddOptionalLabel({ number: options.number, label, currentLabels: syncedLabels })) {
      syncedLabels.push(label);
      added = true;
    }
  }
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function syncTelegramVisibleProofLabel(options: {
  number: number;
  labels: readonly string[];
  proof: Pick<TelegramVisibleProof, "status">;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextTelegramVisibleProofLabels(options.labels, options.proof);
  const hadLabel = options.labels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
  const wantsLabel = nextLabels.includes(TELEGRAM_VISIBLE_PROOF_LABEL);
  const changed = hadLabel !== wantsLabel;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  if (wantsLabel) ensureTelegramVisibleProofLabel();
  if (wantsLabel) {
    if (
      !tryAddOptionalLabel({
        number: options.number,
        label: TELEGRAM_VISIBLE_PROOF_LABEL,
        currentLabels: options.labels,
      })
    ) {
      return { labels: [...options.labels], changed: false };
    }
  } else {
    ghWithRetry([
      "issue",
      "edit",
      String(options.number),
      "--remove-label",
      TELEGRAM_VISIBLE_PROOF_LABEL,
    ]);
  }
  return { labels: nextLabels, changed };
}

function ensurePrRatingLabel(tier: PrRatingTier): void {
  const definition = ratingLabelForTier(tier);
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensureFeatureShowcaseLabel(): void {
  try {
    ghWithRetry(
      [
        "label",
        "create",
        FEATURE_SHOWCASE_LABEL,
        "--color",
        FEATURE_SHOWCASE_LABEL_COLOR,
        "--description",
        FEATURE_SHOWCASE_LABEL_DESCRIPTION,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function ensurePrStatusLabel(kind: PrStatusLabelKind): void {
  const definition = prStatusLabelForKind(kind);
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function syncFeatureShowcaseLabel(options: {
  number: number;
  labels: readonly string[];
  isPullRequest: boolean;
  itemCategory: string | undefined;
  requiresNewFeature: boolean;
  showcase: FeatureShowcase;
  securityReview: Pick<SecurityReview, "status">;
  overallCorrectness: OverallCorrectness;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextFeatureShowcaseLabels(options.labels, options);
  const changed =
    nextLabels.includes(FEATURE_SHOWCASE_LABEL) && !options.labels.includes(FEATURE_SHOWCASE_LABEL);
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  ensureFeatureShowcaseLabel();
  if (
    !tryAddOptionalLabel({
      number: options.number,
      label: FEATURE_SHOWCASE_LABEL,
      currentLabels: options.labels,
    })
  ) {
    return { labels: [...options.labels], changed: false };
  }
  return { labels: nextLabels, changed };
}

function syncPrRatingLabel(options: {
  number: number;
  labels: readonly string[];
  rating: Pick<PrRating, "overallTier">;
  reviewFailed?: boolean;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextPrRatingLabels(options.labels, options.rating, options.reviewFailed);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToRemove = options.labels.filter(
    (label) => PR_RATING_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const labelToAdd = nextLabels.find(
    (label) => PR_RATING_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  if (labelToAdd) ensurePrRatingLabel(options.rating.overallTier);
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  const added =
    labelToAdd !== undefined &&
    tryAddOptionalLabel({
      number: options.number,
      label: labelToAdd,
      currentLabels: syncedLabels,
    });
  if (added) syncedLabels.push(labelToAdd);
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function syncPrStatusLabel(options: {
  number: number;
  labels: readonly string[];
  statusKind: PrStatusLabelKind | null;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextPrStatusLabels(options.labels, options.statusKind);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToRemove = options.labels.filter(
    (label) => PR_STATUS_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const labelToAdd = nextLabels.find(
    (label) => PR_STATUS_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToRemove.length > 0 || Boolean(labelToAdd);
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  if (options.statusKind && labelToAdd) ensurePrStatusLabel(options.statusKind);
  for (const label of labelsToRemove) {
    ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
  }
  const syncedLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  const added =
    labelToAdd !== undefined &&
    tryAddOptionalLabel({
      number: options.number,
      label: labelToAdd,
      currentLabels: syncedLabels,
    });
  if (added) syncedLabels.push(labelToAdd);
  return { labels: syncedLabels, changed: labelsToRemove.length > 0 || added };
}

function ensureTelegramVisibleProofLabel(): void {
  try {
    ghWithRetry(
      [
        "label",
        "create",
        TELEGRAM_VISIBLE_PROOF_LABEL,
        "--color",
        TELEGRAM_VISIBLE_PROOF_LABEL_COLOR,
        "--description",
        TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
      ],
      2,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }
}

function missingLabelError(error: unknown, label: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`'${label}' not found`) || message.includes(`"${label}" not found`);
}

function labelCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /labels can have a maximum of 100 labels/i.test(message);
}

function tryAddOptionalLabel(options: {
  number: number;
  label: string;
  currentLabels: readonly string[];
}): boolean {
  if (options.currentLabels.length >= 100) {
    console.warn(
      `Skipping optional label sync for ${options.label}: item ${options.number} already has 100 labels`,
    );
    return false;
  }
  try {
    ghWithRetry(["issue", "edit", String(options.number), "--add-label", options.label]);
    return true;
  } catch (error) {
    if (!missingLabelError(error, options.label) && !labelCapacityError(error)) throw error;
    console.warn(
      `Skipping optional label sync for ${options.label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export function isMissingGitHubLabelErrorForTest(message: string, label: string): boolean {
  return missingLabelError(new Error(message), label);
}

export function isGitHubLabelCapacityErrorForTest(message: string): boolean {
  return labelCapacityError(new Error(message));
}

function ensureRealBehaviorProofSufficientLabel(): boolean {
  try {
    ghWithRetry(
      [
        "label",
        "create",
        PROOF_SUFFICIENT_LABEL,
        "--color",
        PROOF_SUFFICIENT_LABEL_COLOR,
        "--description",
        PROOF_SUFFICIENT_LABEL_DESCRIPTION,
      ],
      2,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) return true;
    console.warn(`Skipping optional label sync for ${PROOF_SUFFICIENT_LABEL}: ${message}`);
    return false;
  }
}

function ensureRealBehaviorProofMediaLabel(name: string): boolean {
  const definition = PROOF_MEDIA_LABELS.find((label) => label.name === name);
  if (!definition) return false;
  try {
    ghWithRetry(
      [
        "label",
        "create",
        definition.name,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ],
      2,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) return true;
    console.warn(`Skipping optional label sync for ${definition.name}: ${message}`);
    return false;
  }
}

function syncRealBehaviorProofSufficientLabel(options: {
  number: number;
  labels: readonly string[];
  proof: Pick<RealBehaviorProof, "status">;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextRealBehaviorProofSufficientLabels(options.labels, options.proof);
  const hadLabel = options.labels.includes(PROOF_SUFFICIENT_LABEL);
  const wantsLabel = nextLabels.includes(PROOF_SUFFICIENT_LABEL);
  const changed = hadLabel !== wantsLabel;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  if (wantsLabel && !ensureRealBehaviorProofSufficientLabel()) {
    return { labels: [...options.labels], changed: false };
  }
  if (wantsLabel) {
    if (
      !tryAddOptionalLabel({
        number: options.number,
        label: PROOF_SUFFICIENT_LABEL,
        currentLabels: options.labels,
      })
    ) {
      return { labels: [...options.labels], changed: false };
    }
  } else {
    try {
      ghWithRetry([
        "issue",
        "edit",
        String(options.number),
        "--remove-label",
        PROOF_SUFFICIENT_LABEL,
      ]);
    } catch (error) {
      if (!missingLabelError(error, PROOF_SUFFICIENT_LABEL)) throw error;
      console.warn(
        `Skipping optional label sync for ${PROOF_SUFFICIENT_LABEL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { labels: nextLabels, changed };
}

function syncRealBehaviorProofMediaLabels(options: {
  number: number;
  labels: readonly string[];
  proof: Pick<RealBehaviorProof, "evidenceKind">;
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const nextLabels = nextRealBehaviorProofMediaLabels(options.labels, options.proof);
  const currentLabelKeys = new Set(options.labels.map((label) => label.toLowerCase()));
  const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()));
  const labelsToAdd = nextLabels.filter(
    (label) => PROOF_MEDIA_LABEL_NAMES.has(label) && !currentLabelKeys.has(label.toLowerCase()),
  );
  const labelsToRemove = options.labels.filter(
    (label) => PROOF_MEDIA_LABEL_NAMES.has(label) && !nextLabelKeys.has(label.toLowerCase()),
  );
  const changed = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  if (!changed) return { labels: nextLabels, changed };
  if (options.dryRun) return { labels: nextLabels, changed };
  const syncedLabels = [...options.labels];
  for (const label of labelsToRemove) {
    try {
      ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
      const index = syncedLabels.indexOf(label);
      if (index >= 0) syncedLabels.splice(index, 1);
    } catch (error) {
      if (!missingLabelError(error, label)) throw error;
      console.warn(
        `Skipping optional label sync for ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  for (const label of labelsToAdd) {
    if (!ensureRealBehaviorProofMediaLabel(label)) continue;
    if (tryAddOptionalLabel({ number: options.number, label, currentLabels: syncedLabels })) {
      syncedLabels.push(label);
    }
  }
  return {
    labels: syncedLabels,
    changed:
      syncedLabels.length !== options.labels.length ||
      syncedLabels.some((label, index) => label !== options.labels[index]),
  };
}

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

function realBehaviorProofNeedsContributorNudge(markdown: string): boolean {
  if (frontMatterValue(markdown, "review_status") !== "complete") return false;
  if (!isExternalPullRequestReport(markdown)) return false;
  if (frontMatterStringArray(markdown, "labels").includes(PROOF_OVERRIDE_LABEL)) return false;
  if (isDocsOnlyPullRequestReport(markdown)) return false;
  const proof = reportRealBehaviorProof(markdown);
  return (
    proof.needsContributorAction ||
    proof.status === "missing" ||
    proof.status === "mock_only" ||
    proof.status === "insufficient"
  );
}

function realBehaviorProofBlocksBotOwnedMerge(markdown: string): boolean {
  if (frontMatterValue(markdown, "review_status") !== "complete") return false;
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
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

function proofNudgeProtectedLabels(labels: readonly string[]): string[] {
  return labels.map(normalizeLabelName).filter((label, index, normalized) => {
    if (normalized.indexOf(label) !== index) return false;
    return (
      label === "maintainer" ||
      label === "security" ||
      label === "beta-blocker" ||
      label === "release-blocker" ||
      label === "clawsweeper:needs-security-review" ||
      label.startsWith("release") ||
      label.includes("security")
    );
  });
}

function isReleaseTitle(title: string | undefined): boolean {
  return /^(?:release|chore\(release\)|version bump)(?=\b|:)/i.test(title?.trim() ?? "");
}

function proofNudgeReportProtectedReason(markdown: string): string | undefined {
  if (frontMatterValue(markdown, "item_category") === "security") {
    return "latest report item category is security";
  }
  if (reportSecurityReview(markdown).status === "needs_attention") {
    return "latest report security review needs attention";
  }
  return undefined;
}

function proofNudgeMarker(options: { number: number; headSha: string; timestamp: string }): string {
  return `${PROOF_NUDGE_MARKER_PREFIX} item="${options.number}" sha="${options.headSha}" at="${options.timestamp}" v="${PROOF_NUDGE_MARKER_VERSION}" -->`;
}

function isProofNudgeMarkerWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f";
}

function parseProofNudgeMarkerAttributes(text: string): ProofNudgeMarker {
  const marker: ProofNudgeMarker = {};
  const attributes = text.slice(0, 512);
  let index = 0;
  while (index < attributes.length) {
    while (index < attributes.length && isProofNudgeMarkerWhitespace(attributes[index])) index += 1;
    const keyStart = index;
    const first = attributes.charCodeAt(index);
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) {
      index += 1;
      continue;
    }
    index += 1;
    while (index < attributes.length) {
      const char = attributes.charCodeAt(index);
      const isAttributeKeyChar =
        (char >= 65 && char <= 90) ||
        (char >= 97 && char <= 122) ||
        (char >= 48 && char <= 57) ||
        char === 45 ||
        char === 95;
      if (!isAttributeKeyChar) break;
      index += 1;
    }
    const key = attributes.slice(keyStart, index).toLowerCase();
    while (index < attributes.length && isProofNudgeMarkerWhitespace(attributes[index])) index += 1;
    if (attributes[index] !== "=") continue;
    index += 1;
    while (index < attributes.length && isProofNudgeMarkerWhitespace(attributes[index])) index += 1;
    let value = "";
    if (attributes[index] === '"') {
      index += 1;
      const valueStart = index;
      while (index < attributes.length && attributes[index] !== '"') index += 1;
      value = attributes.slice(valueStart, index);
      if (attributes[index] === '"') index += 1;
    } else {
      const valueStart = index;
      while (
        index < attributes.length &&
        attributes[index] !== ">" &&
        !isProofNudgeMarkerWhitespace(attributes[index])
      ) {
        index += 1;
      }
      value = attributes.slice(valueStart, index);
    }
    if (key === "item") {
      const item = Number(value);
      if (Number.isInteger(item) && item > 0) marker.item = item;
    } else if (key === "sha") {
      marker.sha = value;
    } else if (key === "at") {
      marker.at = value;
    } else if (key === "v") {
      marker.v = value;
    }
  }
  return marker;
}

function proofNudgeMarkersFromCommentBody(body: string | undefined): ProofNudgeMarker[] {
  if (!body?.includes(PROOF_NUDGE_MARKER_PREFIX)) return [];
  const markers: ProofNudgeMarker[] = [];
  let index = 0;
  while (index < body.length && markers.length < 20) {
    const markerStart = body.indexOf(PROOF_NUDGE_MARKER_PREFIX, index);
    if (markerStart < 0) break;
    const attributesStart = markerStart + PROOF_NUDGE_MARKER_PREFIX.length;
    const markerEnd = body.indexOf("-->", attributesStart);
    if (markerEnd < 0) break;
    markers.push(parseProofNudgeMarkerAttributes(body.slice(attributesStart, markerEnd)));
    index = markerEnd + 3;
  }
  return markers;
}

function isProofNudgeMarkerCommentAuthor(author: string | undefined): boolean {
  const login = author?.trim();
  return Boolean(login && PATCHABLE_REVIEW_COMMENT_AUTHORS.has(login));
}

function proofNudgeMarkersFromComments(comments: readonly ProofNudgeComment[]): ProofNudgeMarker[] {
  return comments
    .filter((comment) => isProofNudgeMarkerCommentAuthor(comment.author))
    .flatMap((comment) => proofNudgeMarkersFromCommentBody(comment.body));
}

function latestIsoTimestamp(values: readonly (string | undefined)[]): string | undefined {
  let latest: string | undefined;
  for (const value of values) latest = latestTimestamp(latest, value);
  return latest;
}

function latestAuthorCommentAt(
  comments: readonly ProofNudgeComment[],
  author: string | undefined,
): string | undefined {
  const normalizedAuthor = author?.trim().toLowerCase();
  if (!normalizedAuthor) return undefined;
  return latestIsoTimestamp(
    comments
      .filter((comment) => comment.author?.toLowerCase() === normalizedAuthor)
      .map((comment) => comment.updatedAt ?? comment.createdAt),
  );
}

function latestAuthorPullRequestEditAt(
  number: number,
  author: string | undefined,
): string | undefined {
  const normalizedAuthor = author?.trim().toLowerCase();
  if (!normalizedAuthor) return undefined;
  return latestIsoTimestamp(
    ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`)
      .filter((event) => {
        const record = asRecord(event);
        return record.event === "edited" && login(record.actor)?.toLowerCase() === normalizedAuthor;
      })
      .map((event) => stringOrUndefined(asRecord(event).created_at)),
  );
}

function latestAuthorPullRequestReviewActivityAt(
  number: number,
  author: string | undefined,
): string | undefined {
  const normalizedAuthor = author?.trim().toLowerCase();
  if (!normalizedAuthor) return undefined;
  const reviewCommentActivity = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`)
    .filter((comment) => login(asRecord(comment).user)?.toLowerCase() === normalizedAuthor)
    .map((comment) => {
      const record = asRecord(comment);
      return stringOrUndefined(record.updated_at) ?? stringOrUndefined(record.created_at);
    });
  const submittedReviewActivity = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`)
    .filter((review) => login(asRecord(review).user)?.toLowerCase() === normalizedAuthor)
    .map((review) => {
      const record = asRecord(review);
      return stringOrUndefined(record.submitted_at) ?? stringOrUndefined(record.submittedAt);
    });
  return latestIsoTimestamp([...reviewCommentActivity, ...submittedReviewActivity]);
}

function latestProofNudgeAt(
  comments: readonly ProofNudgeComment[],
  options: { number: number; headSha: string },
): string | undefined {
  return latestIsoTimestamp(
    proofNudgeMarkersFromComments(comments)
      .filter(
        (marker) =>
          marker.item === options.number &&
          marker.sha === options.headSha &&
          timestampMs(marker.at) !== null,
      )
      .map((marker) => marker.at),
  );
}

function staleProofNudgeReportHead(markdown: string, headSha: string | undefined): boolean {
  if (!headSha) return false;
  const reportHeadSha = frontMatterValue(markdown, "pull_head_sha");
  const normalizedReportHeadSha = reportHeadSha?.trim() ?? "";
  if (!normalizedReportHeadSha || normalizedReportHeadSha.toLowerCase() === "unknown") return true;
  return normalizedReportHeadSha !== headSha.trim();
}

function proofNudgeEligibility(options: ProofNudgeEligibilityOptions): ProofNudgeEligibility {
  const now = options.now ?? Date.now();
  const minAgeMs = Math.max(0, options.minAgeDays ?? DEFAULT_PROOF_NUDGE_MIN_AGE_DAYS) * DAY_MS;
  const cooldownMs =
    Math.max(0, options.cooldownDays ?? DEFAULT_PROOF_NUDGE_COOLDOWN_DAYS) * DAY_MS;
  const comments = options.comments ?? [];
  if (options.item.kind !== "pull_request") {
    return {
      eligible: false,
      action: "skipped_not_pull_request",
      reason: `type is ${options.item.kind}`,
    };
  }
  const lockedReason = lockedConversationApplyReason(options.item);
  if (lockedReason) {
    return {
      eligible: false,
      action: "skipped_locked_conversation",
      reason: lockedReason,
    };
  }
  if (
    hasNormalizedLabel(options.item.labels, PROOF_OVERRIDE_LABEL) ||
    hasNormalizedLabel(options.item.labels, PROOF_SUFFICIENT_LABEL)
  ) {
    return {
      eligible: false,
      action: "skipped_policy_exempt",
      reason: "proof is already sufficient or overridden",
    };
  }
  if (isMaintainerAuthored(options.item)) {
    return {
      eligible: false,
      action: "skipped_maintainer_authored",
      reason: `author association is ${normalizeAuthorAssociation(options.item.authorAssociation)}`,
    };
  }
  if (isAutomationReportAuthor(options.item.author)) {
    return {
      eligible: false,
      action: "skipped_bot_authored",
      reason: `author is ${options.item.author}`,
    };
  }
  const protectedLabelsForNudge = proofNudgeProtectedLabels(options.item.labels);
  if (protectedLabelsForNudge.length > 0 || isReleaseTitle(options.item.title)) {
    const reason = protectedLabelsForNudge.length
      ? `protected label: ${protectedLabelsForNudge.join(", ")}`
      : "release-style PR title";
    return { eligible: false, action: "skipped_protected_label", reason };
  }
  const reportProtectedReason = proofNudgeReportProtectedReason(options.markdown);
  if (reportProtectedReason) {
    return { eligible: false, action: "skipped_protected_label", reason: reportProtectedReason };
  }
  if (!realBehaviorProofNeedsContributorNudge(options.markdown)) {
    return {
      eligible: false,
      action: "skipped_policy_exempt",
      reason: "latest ClawSweeper proof policy does not require contributor action",
    };
  }
  if (!options.headSha) {
    return {
      eligible: false,
      action: "skipped_no_live_head",
      reason: "live PR head SHA could not be inspected",
    };
  }
  if (staleProofNudgeReportHead(options.markdown, options.headSha)) {
    return {
      eligible: false,
      action: "skipped_stale_report_head",
      reason: "live PR head SHA differs from the reviewed report",
    };
  }
  const reviewedAt = frontMatterValue(options.markdown, "reviewed_at");
  if (reviewedAt && !isOlderThanMs(reviewedAt, minAgeMs, now)) {
    return {
      eligible: false,
      action: "skipped_recent_review",
      reason: `latest ClawSweeper review is newer than ${options.minAgeDays ?? DEFAULT_PROOF_NUDGE_MIN_AGE_DAYS} day(s)`,
      latestActivityAt: reviewedAt,
    };
  }
  const latestActivityAt = latestIsoTimestamp([
    latestAuthorCommentAt(comments, options.item.author),
    options.authorEditedAt,
    options.authorReviewActivityAt,
    options.headCommittedAt,
  ]);
  if (latestActivityAt && !isOlderThanMs(latestActivityAt, minAgeMs, now)) {
    return {
      eligible: false,
      action: "skipped_recent_author_activity",
      reason: `author comment, PR review activity, PR body edit, or head commit is newer than ${options.minAgeDays ?? DEFAULT_PROOF_NUDGE_MIN_AGE_DAYS} day(s)`,
      latestActivityAt,
    };
  }
  const latestNudgeAt = latestProofNudgeAt(comments, {
    number: options.item.number,
    headSha: options.headSha,
  });
  if (latestNudgeAt && !isOlderThanMs(latestNudgeAt, cooldownMs, now)) {
    return {
      eligible: false,
      action: "skipped_recent_nudge",
      reason: `same-head nudge is inside the ${options.cooldownDays ?? DEFAULT_PROOF_NUDGE_COOLDOWN_DAYS} day cooldown`,
      latestNudgeAt,
    };
  }
  return {
    eligible: true,
    action: "proof_nudge_planned",
    reason: "needs real behavior proof and is past the nudge age/cooldown gates",
    latestActivityAt,
    latestNudgeAt,
  };
}

export function proofNudgeEligibilityForTest(
  options: ProofNudgeEligibilityOptions,
): ProofNudgeEligibility {
  return proofNudgeEligibility(options);
}

function renderProofNudgeComment(options: {
  item: Pick<Item, "number" | "author">;
  headSha: string;
  timestamp: string;
}): string {
  const mention =
    options.item.author && !isAutomationReportAuthor(options.item.author)
      ? `@${options.item.author} `
      : "";
  return [
    `${mention}thanks for the PR. ClawSweeper is still waiting on real behavior proof before this can move forward.`,
    "",
    "Useful proof can be a screenshot, short video, terminal output, copied live output, linked artifact, or redacted logs that show the changed behavior after the fix. Please redact private tokens, phone numbers, private endpoints, customer data, and anything else sensitive.",
    "",
    "Once proof is added to the PR body or a comment, ClawSweeper or a maintainer can re-check it.",
    "",
    proofNudgeMarker({
      number: options.item.number,
      headSha: options.headSha,
      timestamp: options.timestamp,
    }),
  ].join("\n");
}

export function renderProofNudgeCommentForTest(options: {
  number: number;
  author?: string;
  headSha?: string;
  timestamp?: string;
}): string {
  return renderProofNudgeComment({
    item: {
      number: options.number,
      author: options.author ?? "contributor",
    },
    headSha: options.headSha ?? "abc123def456",
    timestamp: options.timestamp ?? "2026-01-10T00:00:00.000Z",
  });
}

function botProofDecisionMarker(options: { number: number; headSha: string }): string {
  return `${BOT_PROOF_DECISION_MARKER_PREFIX} item="${options.number}" sha="${options.headSha}" v="${BOT_PROOF_DECISION_MARKER_VERSION}" -->`;
}

function isClawSweeperAppAuthor(author: string | undefined): boolean {
  const normalized = author?.trim().toLowerCase();
  return (
    normalized === "app/clawsweeper" ||
    normalized === "clawsweeper[bot]" ||
    normalized === "openclaw-clawsweeper[bot]"
  );
}

function hasDispatchableMantisScenario(recommendation: MantisRecommendation): boolean {
  return (
    recommendation.status === "recommended" &&
    isSupportedMantisScenario(recommendation.scenario) &&
    Boolean(validMantisMaintainerComment(recommendation))
  );
}

function botProofEligibility(options: BotProofEligibilityOptions): BotProofEligibility {
  if (options.item.kind !== "pull_request") {
    return {
      eligible: false,
      action: "skipped_not_pull_request",
      reason: `type is ${options.item.kind}`,
    };
  }
  if (!isClawSweeperAppAuthor(options.item.author)) {
    return {
      eligible: false,
      action: "skipped_not_bot_authored",
      reason: `author is ${options.item.author ?? "unknown"}`,
    };
  }
  if (options.draft) {
    return { eligible: false, action: "skipped_draft", reason: "pull request is draft" };
  }
  const lockedReason = lockedConversationApplyReason(options.item);
  if (lockedReason) {
    return { eligible: false, action: "skipped_locked_conversation", reason: lockedReason };
  }
  if (
    hasNormalizedLabel(options.item.labels, PROOF_OVERRIDE_LABEL) ||
    hasNormalizedLabel(options.item.labels, PROOF_SUFFICIENT_LABEL)
  ) {
    return {
      eligible: false,
      action: "skipped_policy_exempt",
      reason: "proof is already sufficient or overridden",
    };
  }
  if (!realBehaviorProofBlocksBotOwnedMerge(options.markdown)) {
    return {
      eligible: false,
      action: "skipped_policy_exempt",
      reason: "latest ClawSweeper review does not block merge on real behavior proof",
    };
  }
  if (!options.headSha) {
    return {
      eligible: false,
      action: "skipped_no_live_head",
      reason: "live PR head SHA could not be inspected",
    };
  }
  if (staleProofNudgeReportHead(options.markdown, options.headSha)) {
    return {
      eligible: false,
      action: "skipped_stale_report_head",
      reason: "live PR head SHA differs from the reviewed report",
    };
  }
  const mantisRecommendation = reportMantisRecommendation(options.markdown);
  if (hasDispatchableMantisScenario(mantisRecommendation)) {
    return {
      eligible: true,
      action: "bot_proof_mantis_request_planned",
      reason: "bot-authored PR is blocked on real behavior proof and has a Mantis proof suggestion",
      mantisRecommendation,
    };
  }
  return {
    eligible: true,
    action: "bot_proof_decision_planned",
    reason: "bot-authored PR is blocked on real behavior proof and needs a maintainer decision",
    mantisRecommendation,
  };
}

export function botProofEligibilityForTest(
  options: BotProofEligibilityOptions,
): BotProofEligibility {
  return botProofEligibility(options);
}

function renderBotProofDecisionComment(options: {
  item: Pick<Item, "number" | "title">;
  headSha: string;
  markdown: string;
  timestamp: string;
  mantisRecommendation?: MantisRecommendation | undefined;
}): string {
  const marker = botProofDecisionMarker({ number: options.item.number, headSha: options.headSha });
  const proof = reportRealBehaviorProof(options.markdown);
  const lines = [
    "ClawSweeper status: this ClawSweeper-authored replacement PR is blocked on real behavior proof.",
    "",
    `Reviewed head: \`${options.headSha}\``,
    `Proof status: \`${proof.status}\``,
    `Updated: ${options.timestamp}`,
    "",
    "Maintainer decision needed:",
    "- capture real behavior proof for this head",
    "- apply `proof: override` if the proof requirement should be waived",
    "- pause or close the replacement if proof should not be pursued",
  ];
  const recommendation = options.mantisRecommendation;
  if (
    recommendation?.status === "recommended" &&
    recommendation.scenario !== "none" &&
    recommendation.maintainerComment.trim()
  ) {
    if (hasDispatchableMantisScenario(recommendation)) {
      const comment = validMantisMaintainerComment(recommendation);
      if (comment) lines.push("", "Mantis proof suggestion:", "", "```text", comment, "```");
    } else {
      const scopeText = publicNonDispatchableMantisRecommendationBlock(recommendation);
      if (scopeText) lines.push("", "Proof path suggestion:", "", scopeText);
    }
  }
  lines.push("", marker);
  return lines.join("\n");
}

export function renderBotProofDecisionCommentForTest(options: {
  number: number;
  title?: string;
  headSha?: string;
  timestamp?: string;
  markdown?: string;
}): string {
  return renderBotProofDecisionComment({
    item: { number: options.number, title: options.title ?? "Bot proof sample" },
    headSha: options.headSha ?? "abc123def456",
    timestamp: options.timestamp ?? "2026-01-10T00:00:00.000Z",
    markdown: options.markdown ?? "",
    mantisRecommendation: options.markdown
      ? reportMantisRecommendation(options.markdown)
      : undefined,
  });
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

interface PullRequestClosePromotion {
  closeReason: CloseReason;
  summary: string;
  bestSolution: string;
  evidence: string;
  closeComment: string;
  coverageProofFallbackRefs: boolean;
}

interface LinkedPullRequestSupersession {
  number: number;
  title: string;
  url: string;
  state: string;
  mergedAt: string | null;
  mergeableState: string | null;
  draft: boolean;
  labels: string[];
  files: string[];
  filesKnown: boolean;
}

interface LinkedPullRequestSupersessionResolution {
  candidate: LinkedPullRequestSupersession | null;
  unsafeReason: string | null;
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
    ignoreTimelineCommentsThroughMs?: number;
  } = {},
): boolean {
  const truncationCountsAsActivity = options.truncationCountsAsActivity ?? true;
  if (
    truncationCountsAsActivity &&
    (context.counts?.commentsTruncated ||
      context.counts?.timelineTruncated ||
      context.counts?.pullReviewCommentsTruncated)
  ) {
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
    context.comments.some(hasNonAutomationComment) ||
    (context.pullReviewComments ?? []).some(hasNonAutomationComment) ||
    context.timeline.some(hasNonAutomationEvent)
  );
}

export function contextHasNonAutomationActivityAfterForTest(options: {
  comments?: unknown[];
  timeline?: unknown[];
  activityAfterMs: number;
  ignoreTimelineCommentsThroughMs?: number;
}): boolean {
  return contextHasNonAutomationActivityAfter(
    {
      issue: {},
      comments: options.comments ?? [],
      timeline: options.timeline ?? [],
    },
    options.activityAfterMs,
    options.ignoreTimelineCommentsThroughMs === undefined
      ? {}
      : { ignoreTimelineCommentsThroughMs: options.ignoreTimelineCommentsThroughMs },
  );
}

function pullRequestUrlForNumber(number: number): string {
  return repoUrlFor(targetRepo(), `/pull/${number}`);
}

function sameRepoPullRequestRefRegex(): RegExp | null {
  const [owner, repo] = targetRepo().split("/");
  if (!owner || !repo) return null;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
  return new RegExp(
    [
      `https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/(\\d+)\\b`,
      `(?:^|[^\\w/.-])${escapedRepo}#(\\d+)\\b`,
      "(?:^|[^\\w/#-])#(\\d+)\\b",
    ].join("|"),
    "gi",
  );
}

function sameRepoPullRequestUrlRegex(): RegExp | null {
  const [owner, repo] = targetRepo().split("/");
  if (!owner || !repo) return null;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(repo)}`;
  return new RegExp(`^https:\\/\\/github\\.com\\/${escapedRepo}\\/pull\\/\\d+\\b`, "i");
}

function markdownLinkRegex(): RegExp {
  return /\[([^\]\n]{1,200})\]\(([^\s)]{1,1000})\)/gi;
}

const PULL_REQUEST_LINK_LABEL_START = "__clawsweeper_pr_link_label_start__";
const PULL_REQUEST_LINK_LABEL_END = "__clawsweeper_pr_link_label_end__";

function pullRequestLinkLabel(label: string): string {
  const refRegex = sameRepoPullRequestRefRegex();
  const trimmed = (refRegex ? label.replace(refRegex, " ") : label).trim();
  return trimmed
    ? `${PULL_REQUEST_LINK_LABEL_START} ${trimmed} ${PULL_REQUEST_LINK_LABEL_END} `
    : "";
}

function stripLeadingPullRequestLinkLabels(value: string): string {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(PULL_REQUEST_LINK_LABEL_START)}[\\s\\S]*?${escapeRegExp(
      PULL_REQUEST_LINK_LABEL_END,
    )}\\s*`,
  );
  let remaining = value;
  while (pattern.test(remaining)) {
    remaining = remaining.replace(pattern, "");
  }
  return remaining;
}

function normalizePullRequestMarkdownLinks(value: string): string {
  const sameRepoPullRequestUrl = sameRepoPullRequestUrlRegex();
  if (!sameRepoPullRequestUrl) return value;
  return value.replace(markdownLinkRegex(), (_link: string, label: string, target: string) =>
    sameRepoPullRequestUrl.test(target) ? `${pullRequestLinkLabel(label)}${target}` : " ",
  );
}

type PullRequestRefKind = "pull_url" | "same_repo_shorthand" | "bare";

interface PullRequestRef {
  number: number;
  kind: PullRequestRefKind;
}

function pullRequestRefFromMatch(match: RegExpMatchArray): PullRequestRef | null {
  const number = Number(match[1] ?? match[2] ?? match[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  if (match[1]) return { number, kind: "pull_url" };
  if (match[2]) return { number, kind: "same_repo_shorthand" };
  return { number, kind: "bare" };
}

function pullRequestRefKindRank(kind: PullRequestRefKind): number {
  if (kind === "pull_url") return 3;
  if (kind === "same_repo_shorthand") return 2;
  return 1;
}

function setStrongestPullRequestRef(refs: Map<number, PullRequestRef>, ref: PullRequestRef): void {
  const existing = refs.get(ref.number);
  if (!existing || pullRequestRefKindRank(ref.kind) > pullRequestRefKindRank(existing.kind)) {
    refs.set(ref.number, ref);
  }
}

function pullRequestRefMatchIndex(match: RegExpMatchArray): number {
  const matchStart = match.index ?? 0;
  const matchedText = match[0] ?? "";
  if (match[1]) return matchStart;
  if (match[2]) {
    const needle = `${targetRepo()}#${match[2]}`;
    const offset = matchedText.toLowerCase().indexOf(needle.toLowerCase());
    return matchStart + (offset >= 0 ? offset : Math.max(0, matchedText.length - needle.length));
  }
  if (match[3]) {
    const needle = `#${match[3]}`;
    const offset = matchedText.indexOf(needle);
    return matchStart + (offset >= 0 ? offset : Math.max(0, matchedText.length - needle.length));
  }
  return matchStart;
}

function linkedPullRequestRefsFromText(text: string, currentNumber: number): PullRequestRef[] {
  const regex = sameRepoPullRequestRefRegex();
  if (!regex) return [];
  const normalizedText = normalizePullRequestMarkdownLinks(text);
  const refs = new Map<number, PullRequestRef>();
  for (const match of normalizedText.matchAll(regex)) {
    const ref = pullRequestRefFromMatch(match);
    if (ref && ref.number !== currentNumber) setStrongestPullRequestRef(refs, ref);
  }
  return [...refs.values()];
}

function relationshipClauseContainingIndex(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const relativeIndex = Math.max(0, index - lineStart);
  let start = 0;
  let end = line.length;
  const boundary = /[;,|]|\.(?=\s|$)|\s+(?:and|but|while)\s+/gi;

  for (const match of line.matchAll(boundary)) {
    const boundaryStart = match.index ?? 0;
    const boundaryEnd = boundaryStart + match[0].length;
    if (relationshipBoundaryContinuesPullRequestRefList(line, boundaryStart, boundaryEnd)) {
      continue;
    }
    if (boundaryEnd <= relativeIndex) {
      start = boundaryEnd;
      continue;
    }
    if (boundaryStart > relativeIndex) {
      end = boundaryStart;
      break;
    }
  }

  return line.slice(start, end).trim();
}

function relationshipBoundaryContinuesPullRequestRefList(
  line: string,
  boundaryStart: number,
  boundaryEnd: number,
): boolean {
  const boundaryText = line.slice(boundaryStart, boundaryEnd).trim().toLowerCase();
  if (!["and", ",", ";"].includes(boundaryText)) return false;
  if (!textEndsWithPullRequestRef(line.slice(0, boundaryStart))) return false;
  return textStartsWithStandalonePullRequestRef(line.slice(boundaryEnd));
}

function textEndsWithPullRequestRef(value: string): boolean {
  const regex = sameRepoPullRequestRefRegex();
  if (!regex) return false;
  const normalized = normalizePullRequestMarkdownLinks(value);
  let lastRefEnd = -1;
  for (const match of normalized.matchAll(regex)) {
    lastRefEnd = (match.index ?? 0) + (match[0]?.length ?? 0);
  }
  return lastRefEnd >= 0 && /^[\s,;]*$/.test(normalized.slice(lastRefEnd));
}

function textStartsWithStandalonePullRequestRef(value: string): boolean {
  const regex = sameRepoPullRequestRefRegex();
  if (!regex) return false;
  let remaining = stripLeadingPullRequestLinkLabels(
    normalizePullRequestMarkdownLinks(value)
      .trimStart()
      .replace(/^and\s+/i, ""),
  );
  let sawRef = false;
  while (remaining) {
    regex.lastIndex = 0;
    const match = regex.exec(remaining);
    if (!match || pullRequestRefMatchIndex(match) !== 0) return false;
    sawRef = true;
    remaining = stripLeadingPullRequestLinkLabels(
      remaining.slice((match.index ?? 0) + (match[0]?.length ?? 0)).trimStart(),
    );
    if (!remaining || /^[\s,;.)\]]+$/.test(remaining)) return true;
    const separator = remaining.match(/^(?:[,;]\s*(?:and\s+)?|and\s+)/i);
    if (!separator) return false;
    remaining = stripLeadingPullRequestLinkLabels(remaining.slice(separator[0].length).trimStart());
  }
  return sawRef;
}

function linkedPullRequestSignalContextsFromText(
  text: string,
  currentNumber: number,
  linkedNumber: number,
): string[] {
  const regex = sameRepoPullRequestRefRegex();
  if (!regex) return [];
  const normalizedText = normalizePullRequestMarkdownLinks(text);
  const contexts: string[] = [];
  for (const match of normalizedText.matchAll(regex)) {
    const ref = pullRequestRefFromMatch(match);
    if (!ref || ref.number !== linkedNumber || ref.number === currentNumber) continue;
    contexts.push(
      relationshipClauseContainingIndex(normalizedText, pullRequestRefMatchIndex(match)),
    );
  }
  return contexts;
}

function linkedPullRequestRefsFromReport(
  markdown: string,
  currentNumber: number,
): PullRequestRef[] {
  const texts = [
    ...frontMatterStringArray(markdown, "work_cluster_refs"),
    ...mergeRiskOptionsFromReport(markdown).flatMap((option) => [option.title, option.body]),
    reviewSectionValue(markdown, "bestSolution"),
    reviewSectionValue(markdown, "evidence"),
    reviewSectionValue(markdown, "closeComment"),
  ];
  const refs = new Map<number, PullRequestRef>();
  for (const text of texts) {
    for (const ref of linkedPullRequestRefsFromText(text, currentNumber)) {
      setStrongestPullRequestRef(refs, ref);
    }
  }
  return [...refs.values()];
}

function linkedPullRequestNumbersFromReport(markdown: string, currentNumber: number): number[] {
  return linkedPullRequestRefsFromReport(markdown, currentNumber).map((ref) => ref.number);
}

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
    } catch {
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

interface CanonicalPullRequestCommentSyncBlock {
  kind: "closed_unmerged" | "unreadable";
  number: number;
  reason: string;
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

interface PrCloseCoverageProofGateBlock {
  actionTaken: ActionTaken;
  reason: string;
}

interface PrCloseCoverageProofCoveringWitness {
  number: number;
  provedAtMs: number;
  updatedAt: string | null;
  url: string;
  proof: PrCloseCoverageProofModelResult;
}

type PrCloseCoverageProofGateResult =
  | { status: "allowed"; covering: PrCloseCoverageProofCoveringWitness }
  | { status: "blocked"; block: PrCloseCoverageProofGateBlock }
  | null;

interface PrCloseCoverageRuntimeBudget {
  startedAtMs: number;
  maxRuntimeMs: number;
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

function publicPrSummaryBody(
  summaryLine: string,
  reproductionAssessment: string,
  prSurfaceSummary: string,
): string {
  return [
    summaryLine,
    prSurfaceSummary ? `PR surface: ${prSurfaceSummary}` : "",
    publicReproducibilityLine(reproductionAssessment),
  ]
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
  return [
    publicRiskBulletsFromText(risks, "P1"),
    choices.length ? ["", "**Maintainer options:**", ...choices].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
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

function reviewWorkflowCallout(): string[] {
  return [
    collapsedDetailsBlock("How this review workflow works", [
      "- ClawSweeper keeps one durable marker-backed review comment per issue or PR.",
      "- Re-runs edit this comment so the latest verdict, findings, and automation markers stay together instead of adding duplicate bot comments.",
      "- A fresh review can be triggered by eligible `@clawsweeper re-review` comments, exact-item GitHub events, scheduled/background review runs, or manual workflow dispatch.",
      "- PR/issue authors and users with repository write access can comment `@clawsweeper re-review` or `@clawsweeper re-run` on an open PR or issue to request a fresh review only.",
      "- Maintainers can also comment `@clawsweeper review` to request a fresh review only.",
      "- Fresh-review commands do not start repair, autofix, rebase, CI repair, or automerge.",
      "- Maintainer-only repair and merge flows require explicit commands such as `@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper fix ci`, or `@clawsweeper address review`.",
      "- Maintainers can comment `@clawsweeper explain` to ask for more context, or `@clawsweeper stop` to stop active automation.",
    ]),
    "",
  ];
}

function reviewFreshnessText(markdown: string): string {
  const timestamp = formatReviewFreshnessTimestamp(frontMatterValue(markdown, "reviewed_at"));
  return timestamp ? ` _Reviewed ${timestamp}._` : "";
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
  const evidence = reportEvidence(markdown).slice(0, 6).map(closeEvidenceLine);
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
  const summaryLine = sentence(summary) || "_No summary provided._";
  const changeSummaryLine = sentence(changeSummary || summary) || "_No change summary provided._";
  const fallbackNextStep =
    "Continue tracking this item until the missing behavior is implemented or a maintainer decides the product direction.";
  const nextStepLine = sentence(workReason || bestSolution || fallbackNextStep);
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
  const prSurfaceSummary = prSurface.split("\n\n", 1)[0]?.trim() ?? "";
  if (prSurface) evidenceDetails.push("PR surface:", "", prSurface);
  if (isPullRequest) {
    appendPublicSection(
      lines,
      "Summary",
      publicPrSummaryBody(changeSummaryLine, reproductionAssessment, prSurfaceSummary),
    );
    lines.push(renderReviewMetricsDigest(reviewMetrics), "");
    const dataModelWarning = renderDataModelWarningFromReport(markdown);
    if (dataModelWarning) appendPublicSection(lines, "Stored data model", dataModelWarning);
  } else {
    appendPublicSection(lines, "Summary", publicSummaryBody(summaryLine, reproductionAssessment));
  }
  const rootCauseClusterBlock = publicRootCauseClusterBlock(rootCauseCluster);
  if (rootCauseClusterBlock) {
    appendPublicSection(lines, "Root-cause cluster", rootCauseClusterBlock);
  }
  if (!isPullRequest) {
    const reproductionHelp = issueReproductionHelpSuggestions(markdown);
    if (reproductionHelp.length) {
      appendPublicSection(
        lines,
        "Ways to help us reproduce this",
        reproductionHelp.map((suggestion) => `- ${suggestion}`).join("\n"),
      );
    }
  }
  if (isPullRequest) {
    appendPublicSection(
      lines,
      "Merge readiness",
      reviewFailed
        ? publicFailedReviewReadinessBlock(markdown)
        : publicMergeReadinessBlock(prRating, realBehaviorProof),
    );
  }
  const mantisSuggestion = isPullRequest
    ? publicMantisRecommendationBlock(mantisRecommendation)
    : "";
  if (mantisSuggestion) appendPublicSection(lines, "Mantis proof suggestion", mantisSuggestion);
  const unsupportedMantisSuggestion = isPullRequest
    ? publicNonDispatchableMantisRecommendationBlock(mantisRecommendation)
    : "";
  if (unsupportedMantisSuggestion) {
    appendPublicSection(lines, "Proof path suggestion", unsupportedMantisSuggestion);
  }
  if (mergeRiskLine) appendPublicSection(lines, "Risk before merge", mergeRiskLine);
  appendPublicSection(
    lines,
    isPullRequest ? "Next step before merge" : "Next step",
    publicNextStepLine,
  );
  const decisionPacketBlock = renderDecisionPacketPublicBlock(markdown);
  if (decisionPacketBlock) {
    appendPublicSection(lines, "Maintainer decision needed", decisionPacketBlock);
  }
  const securityLine = publicSecurityReviewLine(securityReview);
  if (securityLine) appendPublicSection(lines, "Security", securityLine);
  if (isPullRequest && reviewFindings.length) {
    lines.push("**Review findings**", ...reviewFindings.slice(0, 3).map(reviewFindingSummaryLine));
  }
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
  const detailsBlock = collapsedDetailsBlock("Review details", reviewDetails);
  if (detailsBlock) lines.push("", detailsBlock);
  const labelDetailsBlock = collapsedDetailsBlock("Label changes", labelDetails);
  if (labelDetailsBlock) lines.push("", labelDetailsBlock);
  const evidenceDetailsBlock = collapsedDetailsBlock("Evidence reviewed", evidenceDetails);
  if (evidenceDetailsBlock) lines.push("", evidenceDetailsBlock);
  const reviewHistoryBlock = renderReviewHistorySection(
    reviewHistoryForRender(markdown, options.previousReviewCommentBody),
  );
  if (isPullRequest && !reviewFailed) lines.push("", publicRankDetailsBlock());
  lines.push("", ...reviewWorkflowCallout());
  const publicBody = neutralizeReviewControlMarkers(
    sanitizePublicSelfReferences(
      lines.join("\n"),
      Number(frontMatterValue(markdown, "number")),
      (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
    ),
  );
  return reviewHistoryBlock ? `${publicBody.trimEnd()}\n\n${reviewHistoryBlock}\n` : publicBody;
}

export function renderReviewCommentFromReport(
  markdown: string,
  reason: CloseReason,
  options: ReviewCommentRenderOptions = {},
): string {
  const decision = frontMatterValue(markdown, "decision");
  const requiresMaintainerDecision = maintainerDecisionFromReport(markdown)?.required === true;
  const body =
    decision === "close" && reason !== "none" && !requiresMaintainerDecision
      ? renderCloseCommentFromReport(markdown, reason)
      : renderKeepOpenCommentFromReport(markdown, options);
  const markers = reviewAutomationMarkersFromReport(markdown);
  return [body.trimEnd(), markers, reviewVersionMarkerFromReport(markdown)]
    .filter(Boolean)
    .join("\n\n");
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

function evidenceText(entry: Evidence): string {
  return [entry.label, entry.detail, entry.command ?? ""].join("\n");
}

function hasImplementationHistoryEvidence(decision: Decision): boolean {
  return decision.evidence.some((entry) =>
    evidenceText(entry).match(/\b(?:git (?:blame|show|log)|blame)\b/i),
  );
}

function hasImplementationReleaseStateEvidence(decision: Decision): boolean {
  return decision.evidence.some((entry) =>
    evidenceText(entry).match(
      /\b(?:release|tag|changelog|CHANGELOG|git (?:tag|describe|branch)|gh release|main-only|unreleased|published)\b/i,
    ),
  );
}

function hasValidFixedAt(decision: Decision): boolean {
  const value = decision.fixedAt?.trim();
  return Boolean(
    value &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
  );
}

function canClose(decision: Decision): boolean {
  return (
    decision.decision === "close" &&
    decision.confidence === "high" &&
    ALLOWED_REASONS.has(decision.closeReason)
  );
}

function closeDecisionHasKeepOpenContradiction(decision: Decision): boolean {
  return [decision.summary, decision.bestSolution, decision.closeComment].some((text) =>
    /^\s*Keep open\s*:/im.test(text),
  );
}

function unconfirmedProductDirectionDecisionBlockReason(
  item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
  decision: Decision,
): string | null {
  if (item.kind !== "pull_request") {
    return "unconfirmed_product_direction is allowed only for pull requests";
  }
  if (!item.authorAssociation) return "unconfirmed_product_direction requires author association";
  if (isMaintainerAuthorAssociation(item.authorAssociation)) {
    return "unconfirmed_product_direction cannot close maintainer-authored pull requests";
  }
  const exemptLabel = item.labels
    .map(normalizeLabelName)
    .find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
  if (exemptLabel) return `${exemptLabel} exempts this PR from product-direction auto-close`;
  if (decision.itemCategory !== "feature") {
    return "unconfirmed_product_direction requires feature item category";
  }
  if (!decision.requiresProductDecision) {
    return "unconfirmed_product_direction requires a product decision";
  }
  if (!decision.requiresNewFeature && !decision.requiresNewConfigOption) {
    return "unconfirmed_product_direction requires new feature or config surface";
  }
  if (decision.securityReview.status !== "cleared" || decision.securityReview.concerns.length > 0) {
    return "unconfirmed_product_direction requires a cleared security review";
  }
  if (decision.overallCorrectness !== "patch is correct" || decision.reviewFindings.length > 0) {
    return "unconfirmed_product_direction requires a correct patch with no review findings";
  }
  if (!["sufficient", "override"].includes(decision.realBehaviorProof.status)) {
    return "unconfirmed_product_direction requires sufficient real behavior proof";
  }
  if (!["S", "A", "B", "C"].includes(decision.prRating.overallTier)) {
    return "unconfirmed_product_direction requires a quality-ready PR rating";
  }
  return null;
}

const STALLED_UNPROVEN_PROOF_STATUSES = new Set(["missing", "mock_only", "insufficient"]);
const STALLED_UNPROVEN_RATING_TIERS = new Set(["D", "F"]);

function externalPrCloseDecisionBlockReason(
  item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
  closeReason: CloseReason,
  exemptText: string,
): string | null {
  if (item.kind !== "pull_request") {
    return `${closeReason} is allowed only for pull requests`;
  }
  if (!item.authorAssociation) return `${closeReason} requires author association`;
  if (isMaintainerAuthorAssociation(item.authorAssociation)) {
    return `${closeReason} cannot close maintainer-authored pull requests`;
  }
  const exemptLabel = prAutoCloseExemptLabel(item.labels);
  if (exemptLabel) return `${exemptLabel} exempts this PR from ${exemptText}`;
  return null;
}

function stalledUnprovenPrDecisionBlockReason(
  item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
  decision: Decision,
): string | null {
  const externalBlock = externalPrCloseDecisionBlockReason(
    item,
    "stalled_unproven_pr",
    "stalled-unproven auto-close",
  );
  if (externalBlock) return externalBlock;
  if (!STALLED_UNPROVEN_PROOF_STATUSES.has(decision.realBehaviorProof.status)) {
    return "stalled_unproven_pr requires missing, mock-only, or insufficient real behavior proof";
  }
  if (!STALLED_UNPROVEN_RATING_TIERS.has(decision.prRating.overallTier)) {
    return "stalled_unproven_pr requires a D or F overall PR rating";
  }
  return null;
}

function abandonedPrDecisionBlockReason(
  item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "authorAssociation">>,
  decision: Decision,
): string | null {
  const externalBlock = externalPrCloseDecisionBlockReason(
    item,
    "abandoned_pr",
    "abandoned-PR auto-close",
  );
  if (externalBlock) return externalBlock;
  if (
    ["S", "A", "B"].includes(decision.prRating.overallTier) &&
    ["sufficient", "override"].includes(decision.realBehaviorProof.status)
  ) {
    return "abandoned_pr cannot close a high-quality proven pull request";
  }
  return null;
}

export function validateCloseDecision(
  item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
  decision: Decision,
  options: { requireCloseComment?: boolean } = {},
): { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string } {
  const requireCloseComment = options.requireCloseComment !== false;
  const profile = repositoryProfileFor(item.repo ?? targetRepo());
  if (decision.decision !== "close") {
    return {
      ok: false,
      actionTaken: "kept_open",
      reason: "not a close decision",
    };
  }
  if (applyBlockingProtectedLabels(item.labels, decision.closeReason).length > 0) {
    return {
      ok: false,
      actionTaken: "skipped_protected_label",
      reason: applyProtectedLabelReason(item.labels, decision.closeReason),
    };
  }
  if (!canClose(decision)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "close decision is not high-confidence with an allowed close reason",
    };
  }
  if (!isAutoCloseAllowed(profile, item.kind, decision.closeReason)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} is not allowed for ${profile.targetRepo} ${item.kind} apply policy`,
    };
  }
  if (item.kind !== "pull_request" && decision.closeReason === "mostly_implemented_on_main") {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "mostly_implemented_on_main is allowed only for pull requests",
    };
  }
  if (item.kind !== "pull_request" && decision.closeReason === "low_signal_unmergeable_pr") {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "low_signal_unmergeable_pr is allowed only for pull requests",
    };
  }
  const closeExemptReason = prAutoCloseExemptDecisionReason(item, decision.closeReason);
  if (closeExemptReason) {
    return {
      ok: false,
      actionTaken: "skipped_close_exempt_label",
      reason: closeExemptReason,
    };
  }
  if (decision.closeReason === "unconfirmed_product_direction") {
    const productDirectionBlock = unconfirmedProductDirectionDecisionBlockReason(item, decision);
    if (productDirectionBlock) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: productDirectionBlock,
      };
    }
  }
  if (decision.closeReason === "stalled_unproven_pr") {
    const stalledUnprovenBlock = stalledUnprovenPrDecisionBlockReason(item, decision);
    if (stalledUnprovenBlock) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: stalledUnprovenBlock,
      };
    }
  }
  if (decision.closeReason === "abandoned_pr") {
    const abandonedBlock = abandonedPrDecisionBlockReason(item, decision);
    if (abandonedBlock) {
      return {
        ok: false,
        actionTaken: "skipped_invalid_decision",
        reason: abandonedBlock,
      };
    }
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
  if (closeDecisionHasKeepOpenContradiction(decision)) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: "close decision contains Keep open guidance",
    };
  }
  if (requireCloseComment && !hasUsableCloseComment(decision.closeComment)) {
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
    isImplementationCloseReason(decision.closeReason) &&
    !hasImplementationSourceEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires evidence with file and sha`,
    };
  }
  if (isImplementationCloseReason(decision.closeReason) && !decision.fixedSha?.trim()) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires fixedSha`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    decision.fixedAt &&
    !hasValidFixedAt(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} fixedAt must be an ISO timestamp`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !decision.fixedRelease?.trim() &&
    !hasValidFixedAt(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires fixedRelease or fixedAt`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !hasImplementationHistoryEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires git history provenance evidence`,
    };
  }
  if (
    isImplementationCloseReason(decision.closeReason) &&
    !hasImplementationReleaseStateEvidence(decision)
  ) {
    return {
      ok: false,
      actionTaken: "skipped_invalid_decision",
      reason: `${decision.closeReason} requires release or main-only provenance evidence`,
    };
  }
  return { ok: true };
}

function isImplementationCloseReason(reason: CloseReason): boolean {
  return reason === "implemented_on_main" || reason === "mostly_implemented_on_main";
}

function reviewCommentMarker(number: number): string {
  return `${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`;
}

function closeAppliedCommentMarker(number: number): string {
  return `<!-- clawsweeper-close-applied item=${number} -->`;
}

function pullHeadShaFromContext(context: ItemContext): string | null {
  const pull = asRecord(context.pullRequest);
  const head = asRecord(pull.head);
  const sha = head.sha;
  return typeof sha === "string" && sha.trim() ? sha.trim() : null;
}

function pullHeadShaFromReport(markdown: string): string | null {
  const value = frontMatterValue(markdown, "pull_head_sha");
  return value && value !== "unknown" ? value : null;
}

function reviewLeaseRevisionFromReport(markdown: string): string | null {
  if (frontMatterValue(markdown, "type") === "pull_request") {
    return pullHeadShaFromReport(markdown);
  }
  const value = frontMatterValue(markdown, "item_source_revision");
  return value && value !== "unknown" ? value : null;
}

type StalePullRequestReviewHead = {
  reportHeadSha: string;
  liveHeadSha: string;
  reason: string;
};

function stalePullRequestReviewHead(
  markdown: string,
  context: ItemContext,
): StalePullRequestReviewHead | null {
  if (frontMatterValue(markdown, "type") !== "pull_request") return null;
  const reportHeadSha = pullHeadShaFromReport(markdown);
  const liveHeadSha = pullHeadShaFromContext(context);
  if (!reportHeadSha || !liveHeadSha || reportHeadSha === liveHeadSha) return null;
  return {
    reportHeadSha,
    liveHeadSha,
    reason: `live PR head ${liveHeadSha} differs from reviewed head ${reportHeadSha}`,
  };
}

function freshPullRequestReviewHead(markdown: string, context: ItemContext): boolean {
  if (frontMatterValue(markdown, "type") !== "pull_request") return false;
  const reportHeadSha = pullHeadShaFromReport(markdown);
  const liveHeadSha = pullHeadShaFromContext(context);
  return Boolean(reportHeadSha && liveHeadSha && reportHeadSha === liveHeadSha);
}

function isStalePullRequestReviewLabel(label: string): boolean {
  return (
    isClawSweeperOwnedLabel(label) &&
    !PRIORITY_LABEL_NAMES.has(label) &&
    !IMPACT_LABEL_NAMES.has(label) &&
    !MATURITY_LABEL_NAMES.has(label) &&
    !isIssueAdvisoryLabel(label)
  );
}

function syncStalePullRequestReviewLabels(options: {
  number: number;
  labels: readonly string[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean } {
  const labelsToRemove = options.labels.filter(isStalePullRequestReviewLabel);
  if (labelsToRemove.length === 0) return { labels: [...options.labels], changed: false };
  const nextLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
  if (!options.dryRun) {
    for (const label of labelsToRemove) {
      ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
    }
  }
  return { labels: nextLabels, changed: true };
}

function stalePullRequestReviewComment(options: {
  number: number;
  stale: StalePullRequestReviewHead;
  previousReviewCommentBody?: string;
}): string {
  const attrs = [
    `item=${markerAttributeValue(String(options.number))}`,
    `reviewed_sha=${markerAttributeValue(options.stale.reportHeadSha)}`,
    `current_sha=${markerAttributeValue(options.stale.liveHeadSha)}`,
    "reason=stale_head",
  ].join(" ");
  const history = renderReviewHistorySection(
    reviewHistoryForStaleComment(options.previousReviewCommentBody),
  );
  return [
    "Codex review: stale review; fresh review needed.",
    "",
    "**Summary**",
    `The latest durable ClawSweeper review was for head \`${options.stale.reportHeadSha}\`, but the PR head is now \`${options.stale.liveHeadSha}\`. Its old verdict and PR readiness labels are no longer current.`,
    "",
    "**Next step**",
    "Run or wait for a fresh ClawSweeper review on the current PR head.",
    ...(history ? ["", history] : []),
    "",
    `<!-- clawsweeper-review-status:stale ${attrs} -->`,
  ].join("\n");
}

function markerAttributeValue(value: string): string {
  return value.trim().replace(/[^\w./:@-]/g, "_") || "unknown";
}

function reviewVersionMarkerFromReport(markdown: string): string {
  const number = frontMatterValue(markdown, "number") ?? "unknown";
  const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
  const headSha = pullHeadShaFromReport(markdown) ?? "na";
  const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
  const leaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
  const leaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
  const attrs = [
    `item=${markerAttributeValue(number)}`,
    `reviewed_at=${markerAttributeValue(reviewedAt)}`,
    `sha=${markerAttributeValue(headSha)}`,
    `source_revision=${markerAttributeValue(sourceRevision)}`,
    `lease_owner=${markerAttributeValue(leaseOwner)}`,
    `lease_comment_id=${markerAttributeValue(leaseCommentId)}`,
    "v=1",
  ].join(" ");
  return `<!-- clawsweeper-review-version ${attrs} -->`;
}

export function reviewAutomationMarkersFromReport(markdown: string): string {
  const itemKind = frontMatterValue(markdown, "type");
  if (itemKind !== "pull_request") return "";
  const number = frontMatterValue(markdown, "number") ?? "unknown";
  const decision = frontMatterValue(markdown, "decision");
  const confidence = frontMatterValue(markdown, "confidence") ?? "unknown";
  const headSha = pullHeadShaFromReport(markdown) ?? "unknown";
  const itemUpdatedAt = frontMatterValue(markdown, "item_updated_at") ?? "unknown";
  const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
  const reviewLeaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
  const reviewLeaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
  const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
  const baseAttrs = [
    `item=${markerAttributeValue(number)}`,
    `sha=${markerAttributeValue(headSha)}`,
    `confidence=${markerAttributeValue(confidence)}`,
    `updated_at=${markerAttributeValue(itemUpdatedAt)}`,
    `reviewed_at=${markerAttributeValue(reviewedAt)}`,
    `lease_owner=${markerAttributeValue(reviewLeaseOwner)}`,
    `lease_comment_id=${markerAttributeValue(reviewLeaseCommentId)}`,
    `source_revision=${markerAttributeValue(sourceRevision)}`,
  ].join(" ");
  const securityNeedsAttention = reportSecurityReview(markdown).status === "needs_attention";
  const humanReviewMarkers = (): string => {
    const markers = [];
    if (securityNeedsAttention) {
      markers.push(`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`);
    }
    markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
    return markers.join("\n");
  };

  if (maintainerDecisionFromReport(markdown)?.required) {
    return humanReviewMarkers();
  }
  if (frontMatterValue(markdown, "review_status") === "failed") {
    return humanReviewMarkers();
  }
  if (configSurfaceReviewRequired(markdown)) {
    return humanReviewMarkers();
  }
  if (dataModelSurfaceReviewRequired(markdown)) {
    return humanReviewMarkers();
  }
  if (frontMatterValue(markdown, "action_taken") === "skipped_pr_close_coverage_proof") {
    return humanReviewMarkers();
  }
  const hasRealBehaviorProofBlocker = realBehaviorProofBlocksMerge(markdown);
  if (securityNeedsAttention) {
    const markers = [`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`];
    if (!hasRealBehaviorProofBlocker && securitySensitiveRepairAllowed(markdown)) {
      markers.push(
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=security-review -->`,
      );
    } else {
      markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
    }
    return markers.join("\n");
  }
  if (hasRealBehaviorProofBlocker) {
    return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
  }
  if (decision === "keep_open") {
    if (repairLoopPassModeFromReport(markdown)) {
      return `<!-- clawsweeper-verdict:pass ${baseAttrs} -->`;
    }
    if (repairLoopFindingRepairAllowed(markdown)) {
      return [
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
      ].join("\n");
    }
    if (frontMatterValue(markdown, "work_candidate") !== "queue_fix_pr") {
      return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
    }
    return [
      `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
      `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
    ].join("\n");
  }
  if (decision === "close") {
    const closeReason = frontMatterValue(markdown, "close_reason") ?? "unknown";
    const actionTaken = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const closeAttrs = `${baseAttrs} action_taken=${markerAttributeValue(actionTaken)} reason=${markerAttributeValue(closeReason)}`;
    return [
      `<!-- clawsweeper-verdict:close ${closeAttrs} -->`,
      `<!-- clawsweeper-action:close-required ${closeAttrs} -->`,
    ].join("\n");
  }
  return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
}

function repairLoopPassModeFromReport(markdown: string): "" | "autofix" | "automerge" {
  if (!isRepairLoopPassReport(markdown)) return "";
  return frontMatterStringArray(markdown, "labels").includes(AUTOFIX_LABEL)
    ? "autofix"
    : "automerge";
}

function securitySensitiveRepairAllowed(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    frontMatterValue(markdown, "decision") === "keep_open" &&
    (labels.includes(AUTOFIX_LABEL) || labels.includes(AUTOMERGE_LABEL))
  );
}

function repairLoopFindingRepairAllowed(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
    !realBehaviorProofBlocksMerge(markdown) &&
    reportReviewFindings(markdown).length > 0
  );
}

function isRepairLoopPassReport(markdown: string): boolean {
  const labels = frontMatterStringArray(markdown, "labels");
  return (
    (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
    frontMatterValue(markdown, "review_status") === "complete" &&
    frontMatterValue(markdown, "confidence") === "high" &&
    frontMatterValue(markdown, "decision") === "keep_open" &&
    !configSurfaceReviewRequired(markdown) &&
    !dataModelSurfaceReviewRequired(markdown) &&
    !realBehaviorProofBlocksMerge(markdown) &&
    reportOverallCorrectness(markdown) === "patch is correct" &&
    reportReviewFindings(markdown).length === 0
  );
}

function markedReviewCommentBody(number: number, body: string): string {
  return body.includes(reviewCommentMarker(number))
    ? body
    : `${body.trimEnd()}\n\n${reviewCommentMarker(number)}`;
}

function reviewStartLeaseCommentMarker(number: number): string {
  return `<!-- clawsweeper-review-lease item=${number} -->`;
}

function markedReviewStartLeaseCommentBody(number: number, body: string): string {
  const marker = reviewStartLeaseCommentMarker(number);
  return body.includes(marker) ? body : `${body.trimEnd()}\n\n${marker}`;
}

function reviewStartStatusCommentMarker(options: ReviewStartStatusCommentOptions): string {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const leaseExpiresAt =
    options.leaseExpiresAt ??
    new Date(
      (Number.isFinite(startedAtMs) ? startedAtMs : Date.now()) +
        DEFAULT_REVIEW_CODEX_TIMEOUT_MS +
        10 * 60 * 1000,
    ).toISOString();
  const attrs = [
    `item=${markerAttributeValue(String(options.number))}`,
    `sha=${markerAttributeValue(options.headSha ?? "na")}`,
    `started_at=${markerAttributeValue(startedAt)}`,
    `lease_expires_at=${markerAttributeValue(leaseExpiresAt)}`,
    ...(options.leaseOwner ? [`owner=${markerAttributeValue(options.leaseOwner)}`] : []),
    "v=1",
  ].join(" ");
  return `${REVIEW_START_STATUS_MARKER_PREFIX}:started ${attrs} -->`;
}

export function withReviewStartStatusLease(
  body: string,
  options: ReviewStartStatusCommentOptions,
): string {
  return withReviewStartStatusLeaseIdentity(body, options, reviewCommentMarker(options.number));
}

function withReviewStartStatusLeaseIdentity(
  body: string,
  options: ReviewStartStatusCommentOptions,
  reviewMarker: string,
): string {
  const reviewMarkerIndex = body.lastIndexOf(reviewMarker);
  const hasTrailingReviewMarker =
    reviewMarkerIndex >= 0 && !body.slice(reviewMarkerIndex + reviewMarker.length).trim();
  const prefix = (hasTrailingReviewMarker ? body.slice(0, reviewMarkerIndex) : body)
    .trimEnd()
    .replace(/\n*<!--\s*clawsweeper-review-status:started\b[^>]*-->\s*$/i, "")
    .trimEnd();
  return [prefix, reviewStartStatusCommentMarker(options), reviewMarker]
    .filter(Boolean)
    .join("\n\n");
}

export function shouldPreserveReviewStartLease(options: {
  currentHeadSha: string;
  reportHeadSha: string | undefined;
  reportLeaseOwner: string | undefined;
  reportLeaseCommentId: string | undefined;
  leaseOwner: string | null;
  leaseCommentId: number | null;
}): boolean {
  const currentHeadSha = options.currentHeadSha.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(currentHeadSha)) return true;
  const reportHeadSha = options.reportHeadSha?.trim().toLowerCase();
  if (reportHeadSha !== currentHeadSha) return true;
  const reportLeaseOwner = options.reportLeaseOwner?.trim();
  if (!options.leaseOwner || !reportLeaseOwner || reportLeaseOwner !== options.leaseOwner) {
    return true;
  }
  if (options.leaseCommentId === null) return true;
  const reportLeaseCommentId = Number(options.reportLeaseCommentId);
  return !Number.isInteger(reportLeaseCommentId) || reportLeaseCommentId !== options.leaseCommentId;
}

export function renderReviewStartStatusComment(options: ReviewStartStatusCommentOptions): string {
  const purpose = options.purpose ?? "review";
  const subject = options.kind === "pull_request" ? "pull request" : "issue";
  const progress =
    Number.isInteger(options.position) && Number.isInteger(options.total)
      ? ` This is item ${options.position}/${options.total} in the current shard.`
      : "";
  const shard =
    Number.isInteger(options.shardIndex) && Number.isInteger(options.shardCount)
      ? ` Shard ${options.shardIndex}/${options.shardCount}.`
      : "";
  const title = neutralizeReviewControlMarkers(options.title.trim());
  const heading =
    purpose === "apply"
      ? title
        ? `I am applying the reviewed decision for this ${subject}: ${title}`
        : `I am applying the reviewed decision for this ${subject}.`
      : title
        ? `I am starting a fresh review of this ${subject}: ${title}`
        : `I am starting a fresh review of this ${subject}.`;
  const body = [
    purpose === "apply"
      ? "ClawSweeper status: applying reviewed decision."
      : "ClawSweeper status: review started.",
    "",
    `${heading}${progress}${shard}`,
    "",
    purpose === "apply"
      ? "This transient lease prevents a newer review from overlapping label, comment, or close mutations."
      : "This placeholder means the worker is alive and reading the current context. I will edit this same comment with the actual review when the claws are done clicking.",
    "",
    "Crustacean status: shell secured, claws on keyboard, evidence pebbles being sorted.",
    "",
    reviewStartStatusCommentMarker(options),
  ].join("\n");
  return markedReviewStartLeaseCommentBody(options.number, body);
}

export function isCodexReviewCommentBody(body: string): boolean {
  return (
    body.includes("Codex review:") ||
    body.includes("Codex review notes:") ||
    body.includes("Codex Review notes:") ||
    body.includes("Codex automated review:") ||
    body.includes("after Codex review.") ||
    body.includes("after Codex automated review.")
  );
}

function fetchIssueReviewComments(number: number): Record<string, unknown>[] {
  return ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(asRecord);
}

function selectIssueReviewComment(
  number: number,
  comments: Record<string, unknown>[],
  fallbackBodies: readonly string[] = [],
): Record<string, unknown> | undefined {
  const marker = reviewCommentMarker(number);
  const markedComments = comments.filter((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && body.includes(marker);
  });
  const patchableMarked = markedComments.find(canPatchReviewComment);
  if (patchableMarked) return patchableMarked;
  const marked = markedComments[0];
  if (marked) return marked;
  const exactBodies = new Set(fallbackBodies.map((body) => body.trim()).filter(Boolean));
  const exactComments = comments.filter((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && exactBodies.has(body.trim());
  });
  const patchableExact = exactComments.find(canPatchReviewComment);
  if (patchableExact) return patchableExact;
  const exact = exactComments[0];
  if (exact) return exact;
  const codexComments = comments.filter((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && isCodexReviewCommentBody(body);
  });
  return codexComments.find(canPatchReviewComment) ?? codexComments[0];
}

function selectDedicatedReviewStartLeaseComment(
  number: number,
  comments: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return selectDedicatedReviewStartLeaseComments(number, comments)[0];
}

function selectDedicatedReviewStartLeaseComments(
  number: number,
  comments: Record<string, unknown>[],
): Record<string, unknown>[] {
  const marker = reviewStartLeaseCommentMarker(number);
  return comments.filter(
    (candidate) => canPatchReviewComment(candidate) && commentBody(candidate)?.includes(marker),
  );
}

function issueReviewCommentState(
  number: number,
  fallbackBodies: readonly string[] = [],
): {
  reviewComment: Record<string, unknown> | undefined;
  leaseComment: Record<string, unknown> | undefined;
  leaseComments: Record<string, unknown>[];
  dedicatedLeaseComment: Record<string, unknown> | undefined;
  dedicatedLeaseComments: Record<string, unknown>[];
} {
  const comments = fetchIssueReviewComments(number);
  const reviewComment = selectIssueReviewComment(number, comments, fallbackBodies);
  const dedicatedLeaseComments = selectDedicatedReviewStartLeaseComments(number, comments);
  const dedicatedLeaseComment = selectDedicatedReviewStartLeaseComment(number, comments);
  const legacyLeaseComment = commentBody(reviewComment)?.includes(
    "clawsweeper-review-status:started",
  )
    ? reviewComment
    : undefined;
  const leaseComments = [
    ...dedicatedLeaseComments,
    ...(legacyLeaseComment && !dedicatedLeaseComments.includes(legacyLeaseComment)
      ? [legacyLeaseComment]
      : []),
  ];
  return {
    reviewComment,
    leaseComment: leaseComments[0],
    leaseComments,
    dedicatedLeaseComment,
    dedicatedLeaseComments,
  };
}

function issueReviewComment(
  number: number,
  fallbackBodies: readonly string[] = [],
): Record<string, unknown> | undefined {
  return issueReviewCommentState(number, fallbackBodies).reviewComment;
}

function issueReviewCommentWithBody(
  number: number,
  body: string,
): Record<string, unknown> | undefined {
  const expected = body.trim();
  if (!expected) return undefined;
  const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
    asRecord,
  );
  const exactComments = comments.filter((candidate) => commentBody(candidate)?.trim() === expected);
  return exactComments.find(canPatchReviewComment) ?? exactComments[0];
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

function commentBody(comment: Record<string, unknown> | undefined): string | undefined {
  const body = comment?.body;
  return typeof body === "string" ? body : undefined;
}

function newestReviewMarkerAttribute(
  comment: Record<string, unknown> | undefined,
  number: number,
  attribute: "reviewed_at" | "sha",
): string | undefined {
  if (!canPatchReviewComment(comment)) return undefined;
  const body = commentBody(comment);
  if (!body) return undefined;
  const reviewMarker = reviewCommentMarker(number);
  const reviewMarkerIndex = body.lastIndexOf(reviewMarker);
  if (reviewMarkerIndex < 0) return undefined;
  if (body.slice(reviewMarkerIndex + reviewMarker.length).trim() !== "") return undefined;
  const markerComments = trailingHtmlComments(body.slice(0, reviewMarkerIndex));
  const markerPattern = /^<!--\s+clawsweeper-verdict:[^\s>]+\b([^>]*)-->$/;
  let lastValue: string | undefined;
  for (const markerComment of markerComments) {
    const match = markerComment.match(markerPattern);
    if (!match) continue;
    const attributes = match[1] ?? "";
    if (!new RegExp(`\\bitem=${number}\\b`).test(attributes)) continue;
    const value = attributes.match(new RegExp(`\\b${attribute}=([^\\s>]+)`))?.[1];
    if (!value || value === "unknown") continue;
    lastValue = value;
  }
  return lastValue;
}

function durableReviewVersion(
  comment: Record<string, unknown> | undefined,
  number: number,
): {
  reviewedAt: string;
  headSha: string | null;
  sourceRevision: string | null;
  leaseOwner: string | null;
  leaseCommentId: string | null;
} | null {
  if (!canPatchReviewComment(comment)) return null;
  const body = commentBody(comment);
  if (!body) return null;
  const identity = reviewCommentMarker(number);
  const identityIndex = body.lastIndexOf(identity);
  if (identityIndex < 0 || body.slice(identityIndex + identity.length).trim()) return null;
  for (const markerComment of trailingHtmlComments(body.slice(0, identityIndex)).reverse()) {
    const match = markerComment.match(/^<!--\s+clawsweeper-review-version\b([^>]*)-->$/);
    if (!match) continue;
    const attributes = match[1] ?? "";
    const attribute = (name: string) =>
      attributes.match(new RegExp(`\\b${name}=([^\\s>]+)`))?.[1] ?? null;
    if (Number(attribute("item")) !== number || attribute("v") !== "1") continue;
    const reviewedAt = attribute("reviewed_at");
    if (!reviewedAt || timestampMs(reviewedAt) === null) continue;
    const headSha = attribute("sha");
    const sourceRevision = attribute("source_revision");
    return {
      reviewedAt,
      headSha: headSha && headSha !== "na" && headSha !== "unknown" ? headSha : null,
      sourceRevision: sourceRevision && sourceRevision !== "unknown" ? sourceRevision : null,
      leaseOwner: attribute("lease_owner"),
      leaseCommentId: attribute("lease_comment_id"),
    };
  }
  return null;
}

function reviewCommentHasCloseVerdictForCanonical(
  comment: Record<string, unknown> | undefined,
  number: number,
  reason: CloseReason,
  canonicalNumber: number,
): boolean {
  if (!canPatchReviewComment(comment)) return false;
  const body = commentBody(comment);
  if (!body) return false;
  const reviewMarker = reviewCommentMarker(number);
  const reviewMarkerIndex = body.lastIndexOf(reviewMarker);
  if (reviewMarkerIndex < 0) return false;
  if (body.slice(reviewMarkerIndex + reviewMarker.length).trim() !== "") return false;
  const markerComments = trailingHtmlComments(body.slice(0, reviewMarkerIndex));
  const verdictPattern = /^<!--\s+clawsweeper-verdict:([^\s>]+)\b([^>]*)-->$/;
  let latestVerdict: { verdict: string; reason: string | undefined } | undefined;
  for (const markerComment of markerComments) {
    const match = markerComment.match(verdictPattern);
    if (!match) continue;
    const attributes = match[2] ?? "";
    if (!new RegExp(`\\bitem=${number}\\b`).test(attributes)) continue;
    latestVerdict = {
      verdict: match[1] ?? "",
      reason: attributes.match(/\breason=([^\s>]+)/)?.[1],
    };
  }
  const supersessionSignal =
    /\b(supersed(?:e|ed|es|ing)|replace(?:s|d|ment)?|duplicate|duplicated|canonical|covered by|landed in)\b/i;
  const signaledRefs = linkedPullRequestRefsFromText(body, number).filter((ref) =>
    linkedPullRequestSignalContextsFromText(body, number, ref.number).some((context) =>
      supersessionSignal.test(context),
    ),
  );
  const explicitCanonicalRefs = [...body.matchAll(/^Canonical:\s+(\S+)\s*$/gm)];
  let commentCanonicalNumber: number | undefined;
  if (explicitCanonicalRefs.length > 0) {
    const canonicalNumbers = new Set<number>();
    for (const match of explicitCanonicalRefs) {
      try {
        const parsed = parseGitHubItemRef(
          match[1] ?? "",
          "durable review comment root-cause canonical",
        );
        // The explicit public canonical is authoritative; never reinterpret a member PR as it.
        if (parsed.kind !== "pull_request") return false;
        if (normalizeRepo(parsed.repo) !== normalizeRepo(targetRepo())) return false;
        canonicalNumbers.add(parsed.number);
      } catch {
        return false;
      }
    }
    if (canonicalNumbers.size !== 1) return false;
    commentCanonicalNumber = [...canonicalNumbers][0];
  }
  if (explicitCanonicalRefs.length === 0) {
    const signaledCanonicalNumbers = new Set(signaledRefs.map((ref) => ref.number));
    if (signaledCanonicalNumbers.size !== 1) return false;
    commentCanonicalNumber = [...signaledCanonicalNumbers][0];
  }
  return (
    latestVerdict?.verdict === "close" &&
    latestVerdict.reason === reason &&
    commentCanonicalNumber === canonicalNumber
  );
}

function staleReviewCommentSyncReason(
  markdown: string,
  existingReviewComment: Record<string, unknown> | undefined,
  number: number,
  context?: ItemContext,
): string | null {
  // Comment updated_at can move for command/status edits; only review markers prove verdict freshness.
  const liveVersion = durableReviewVersion(existingReviewComment, number);
  const itemKind = frontMatterValue(markdown, "type");
  const liveReviewedAt =
    liveVersion?.reviewedAt ??
    (itemKind === "pull_request"
      ? newestReviewMarkerAttribute(existingReviewComment, number, "reviewed_at")
      : undefined);
  const liveReviewedSha =
    liveVersion?.headSha ??
    (itemKind === "pull_request"
      ? newestReviewMarkerAttribute(existingReviewComment, number, "sha")
      : undefined);
  const reportReviewedAt = frontMatterValue(markdown, "reviewed_at");
  const liveReviewedAtMs = timestampMs(liveReviewedAt);
  const reportReviewedAtMs = timestampMs(reportReviewedAt);
  if (liveReviewedAtMs === null) return null;
  const reportLeaseOwner = frontMatterValue(markdown, "review_lease_owner");
  const reportLeaseCommentId = frontMatterValue(markdown, "review_lease_comment_id");
  if (
    liveVersion?.leaseOwner &&
    liveVersion.leaseOwner !== "unknown" &&
    liveVersion.leaseOwner === reportLeaseOwner &&
    liveVersion.leaseCommentId === reportLeaseCommentId
  ) {
    return null;
  }
  const liveLeaseCommentId = Number(liveVersion?.leaseCommentId);
  const reportLeaseCommentIdNumber = Number(reportLeaseCommentId);
  const reportRevision = reviewLeaseRevisionFromReport(markdown);
  const liveRevision =
    itemKind === "pull_request" ? liveVersion?.headSha : liveVersion?.sourceRevision;
  if (
    liveRevision &&
    reportRevision &&
    liveRevision === reportRevision &&
    Number.isInteger(liveLeaseCommentId) &&
    liveLeaseCommentId > 0
  ) {
    if (!Number.isInteger(reportLeaseCommentIdNumber) || reportLeaseCommentIdNumber <= 0) {
      return `live durable review tuple has lease comment ${liveLeaseCommentId}, but the local report has no durable lease identity`;
    }
    if (liveLeaseCommentId >= reportLeaseCommentIdNumber) {
      return `live durable review tuple is newer than the local report: comment lease=${liveLeaseCommentId}, report lease=${reportLeaseCommentIdNumber}`;
    }
    // GitHub comment ids are monotonic. A report from a later lease may replace an older durable
    // marker even when worker clocks make reviewed_at ordering ambiguous.
    return null;
  }
  if (itemKind !== "pull_request") {
    if (reportReviewedAtMs !== null && liveReviewedAtMs > reportReviewedAtMs) {
      return `live durable review comment is newer than the local report: comment reviewed_at=${liveReviewedAt}, report reviewed_at=${reportReviewedAt}`;
    }
    const liveCommentUpdatedAtMs = timestampMs(commentUpdatedAt(existingReviewComment));
    if (
      reportReviewedAtMs !== null &&
      liveCommentUpdatedAtMs !== null &&
      liveCommentUpdatedAtMs > reportReviewedAtMs &&
      liveReviewedAt !== reportReviewedAt
    ) {
      return `live durable review comment was published after the local report: comment updated_at=${commentUpdatedAt(existingReviewComment)}, report reviewed_at=${reportReviewedAt}`;
    }
    return null;
  }
  const currentHeadSha = context ? pullHeadShaFromContext(context) : null;
  const reportHeadSha = pullHeadShaFromReport(markdown);
  if (!liveReviewedSha || !currentHeadSha) return null;
  // Trust a newer comment when it matches the live head, or when the live API still reports the
  // report's head and may be lagging the comment. Otherwise the newer comment is stale too.
  if (liveReviewedSha !== currentHeadSha && currentHeadSha !== reportHeadSha) return null;
  if (
    liveReviewedSha === currentHeadSha &&
    (!reportHeadSha || reportHeadSha !== liveReviewedSha || reportReviewedAtMs === null)
  ) {
    return `live durable review comment is newer than the local report: comment reviewed_at=${liveReviewedAt}, report reviewed_at=${reportReviewedAt ?? "missing"}; comment head=${liveReviewedSha}, report head=${reportHeadSha ?? "missing"}`;
  }
  if (reportReviewedAtMs === null) return null;
  if (liveReviewedAtMs <= reportReviewedAtMs) return null;
  return `live durable review comment is newer than the local report: comment reviewed_at=${liveReviewedAt}, report reviewed_at=${reportReviewedAt}`;
}

const APPLY_SYNC_EQUIVALENT_CLOSE_MARKER_ACTIONS = new Set([
  "proposed_close",
  "kept_open",
  "skipped_pr_close_coverage_proof",
  "retry_pr_close_coverage_proof",
  ...RETRYABLE_CLOSE_SKIP_ACTIONS,
  ...PAIR_BLOCKED_CLOSE_ACTIONS,
]);

function normalizeApplySyncCloseMarkerAction(body: string): string {
  return body.replace(
    /(<!-- clawsweeper-(?:verdict:close|action:close-required)\b[^>]*\s)action_taken=([^\s>]+)(?=\s|-->)/g,
    (match, prefix: string, action: string) =>
      APPLY_SYNC_EQUIVALENT_CLOSE_MARKER_ACTIONS.has(action)
        ? `${prefix}action_taken=proposed_close`
        : match,
  );
}

function commentBodyMatches(
  comment: Record<string, unknown> | undefined,
  body: string,
  options: { allowApplyCloseActionUpgrade?: boolean } = {},
): boolean {
  const actual = commentBody(comment)?.trim();
  const expected = body.trim();
  if (actual === expected) return true;
  if (!actual || !options.allowApplyCloseActionUpgrade) return false;
  return (
    normalizeApplySyncCloseMarkerAction(actual) === normalizeApplySyncCloseMarkerAction(expected)
  );
}

function reviewCommentHashMatches(
  comment: Record<string, unknown> | undefined,
  body: string,
  storedHash: string | undefined,
  expectedHash: string,
  options: { allowApplyCloseActionUpgrade?: boolean } = {},
): boolean {
  if (storedHash === expectedHash) return true;
  if (!storedHash || !options.allowApplyCloseActionUpgrade) return false;
  const actual = commentBody(comment)?.trim();
  if (!actual) return false;
  if (
    normalizeApplySyncCloseMarkerAction(actual) !== normalizeApplySyncCloseMarkerAction(body.trim())
  ) {
    return false;
  }
  return storedHash === sha256(actual);
}

const PATCHABLE_REVIEW_COMMENT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ].filter((login): login is string => typeof login === "string" && login.length > 0),
);

function commentAuthorLogin(comment: Record<string, unknown> | undefined): string | undefined {
  const user = comment?.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return undefined;
  const login = (user as Record<string, unknown>).login;
  return typeof login === "string" ? login : undefined;
}

export function canPatchReviewComment(comment: Record<string, unknown> | undefined): boolean {
  const login = commentAuthorLogin(comment);
  return Boolean(login && PATCHABLE_REVIEW_COMMENT_AUTHORS.has(login));
}

export function lockedConversationApplyReason(
  item: Pick<Item, "activeLockReason" | "locked">,
): string | null {
  if (!item.locked) return null;
  return `conversation is locked${item.activeLockReason ? ` (${item.activeLockReason})` : ""}`;
}

export function reviewArtifactDestination(
  action: string | undefined,
  itemIsOpen: boolean,
): ReviewArtifactDestination {
  if (!itemIsOpen) return "skip_closed";
  return action === "closed" || action === "skipped_already_closed" ? "closed" : "items";
}

export function runtimeBudgetExceeded(
  startedAtMs: number,
  maxRuntimeMs: number,
  nowMs: number,
): boolean {
  return maxRuntimeMs > 0 && nowMs - startedAtMs >= maxRuntimeMs;
}

export function removeCurrentCursorTraceItem(
  examinedItemNumbers: number[],
  currentNumber: number,
): void {
  if (examinedItemNumbers.at(-1) === currentNumber) examinedItemNumbers.pop();
}

export function timeoutWithinRuntimeBudget(
  startedAtMs: number,
  maxRuntimeMs: number,
  requestedTimeoutMs: number,
  nowMs: number,
): number | null {
  if (maxRuntimeMs <= 0) return requestedTimeoutMs;
  const remainingMs = maxRuntimeMs - (nowMs - startedAtMs);
  return remainingMs > 0 ? Math.min(requestedTimeoutMs, remainingMs) : null;
}

export function coverageProofRetryExhaustedRuntimeBudget(
  startedAtMs: number,
  maxRuntimeMs: number,
  actionTaken: string,
  nowMs: number,
): boolean {
  return (
    actionTaken === "retry_pr_close_coverage_proof" &&
    runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, nowMs)
  );
}

export function recordedLabelSyncCoversUpdate(options: {
  itemUpdatedAt: string;
  labelsSyncedAt: string | undefined;
  liveLabels: readonly string[];
  recordedLabels: readonly string[];
  hasNonAutomationActivity: boolean;
}): boolean {
  const itemUpdatedAtMs = timestampMs(options.itemUpdatedAt);
  const labelsSyncedAtMs = timestampMs(options.labelsSyncedAt);
  if (
    itemUpdatedAtMs === null ||
    labelsSyncedAtMs === null ||
    itemUpdatedAtMs > labelsSyncedAtMs ||
    options.hasNonAutomationActivity
  ) {
    return false;
  }
  const liveLabelSet = normalizedLabelSet(options.liveLabels);
  const recordedLabelSet = normalizedLabelSet(options.recordedLabels);
  return (
    liveLabelSet.size === recordedLabelSet.size &&
    [...liveLabelSet].every((label) => recordedLabelSet.has(label))
  );
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
  let args: string[];
  if (id !== null && canPatchReviewComment(existing)) {
    args = [
      "api",
      `repos/${targetRepo()}/issues/comments/${id}`,
      "--method",
      "PATCH",
      "--input",
      payload,
    ];
  } else {
    args = [
      "api",
      `repos/${targetRepo()}/issues/${number}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ];
  }
  const response = ghWithRetry(args);
  const written = reviewCommentFromMutationResponse(response, args);
  if (written) return written;
  const fallback = issueReviewCommentWithBody(number, markedBody);
  if (fallback) return fallback;
  throw new Error(
    `GitHub comment mutation for #${number} did not return or expose the synced review comment`,
  );
}

function reviewCommentFromMutationResponse(
  response: string,
  args: readonly string[],
): Record<string, unknown> | undefined {
  if (!response.trim()) return undefined;
  try {
    const comment = asRecord(parseGhJson<unknown>(response, args));
    if (commentId(comment) !== null || commentUrl(comment)) {
      return comment;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function issueCommentWithMarker(
  number: number,
  marker: string,
): Record<string, unknown> | undefined {
  const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map(
    asRecord,
  );
  return comments.find((candidate) => {
    const body = candidate.body;
    return typeof body === "string" && body.includes(marker);
  });
}

function closeAppliedEvidenceLink(markdown: string, itemUrl: string): string {
  const reviewCommentUrl = frontMatterValue(markdown, "review_comment_url");
  if (reviewCommentUrl && reviewCommentUrl !== "unknown") {
    return markdownLink("durable ClawSweeper review", reviewCommentUrl);
  }
  const fixedPrUrl = frontMatterValue(markdown, "fixed_pr_url");
  const fixedPrNumber = frontMatterValue(markdown, "fixed_pr_number");
  if (fixedPrUrl && fixedPrUrl !== "unknown") {
    const label =
      fixedPrNumber && fixedPrNumber !== "unknown" ? `fix PR #${fixedPrNumber}` : "fix PR";
    return markdownLink(label, fixedPrUrl);
  }
  return markdownLink("closed PR", itemUrl);
}

function renderCloseAppliedComment(options: {
  number: number;
  closeReason: CloseReason;
  markdown: string;
  itemUrl: string;
}): string {
  const coverageProofLine = closeAppliedCoverageProofLine(options.markdown);
  return [
    "ClawSweeper applied the proposed close for this PR.",
    "",
    "- Action: closed this PR.",
    `- Close reason: ${closeReasonText(options.closeReason)}.`,
    `- Evidence: ${closeAppliedEvidenceLink(options.markdown, options.itemUrl)}.`,
    coverageProofLine,
    "",
    closeAppliedCommentMarker(options.number),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function closeAppliedCoverageProofLine(markdown: string): string | null {
  const proof = sectionValue(markdown, PR_CLOSE_COVERAGE_PROOF_SECTION);
  if (!proof) return null;
  const reason = sectionLineValue(proof, "Reason");
  if (!reason) return null;
  const covering = sectionLineValue(proof, "Covering PR");
  return [`- Coverage proof: ${sentence(reason)}`, covering ? ` Covering PR: ${covering}.` : ""]
    .join("")
    .trim();
}

function ensureCloseAppliedComment(options: {
  number: number;
  closeReason: CloseReason;
  markdown: string;
  itemUrl: string;
  dryRun: boolean;
}): string {
  const marker = closeAppliedCommentMarker(options.number);
  if (issueCommentWithMarker(options.number, marker)) {
    return "matching ClawSweeper close-applied comment already exists";
  }
  const body = renderCloseAppliedComment(options);
  if (options.dryRun) return "dry-run: would post close-applied comment";
  const payload = writeCommentPayload(options.number, body);
  ghWithRetry([
    "api",
    `repos/${targetRepo()}/issues/${options.number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
  ]);
  return "posted close-applied comment";
}

function reviewStartLeaseOwner(comment: Record<string, unknown> | undefined): string | null {
  const body = commentBody(comment) ?? "";
  const match = body.match(/<!--\s*clawsweeper-review-status:started\b([^>]*)-->/i);
  return match?.[1]?.match(/\bowner=([^\s>]+)/i)?.[1] ?? null;
}

function freshDedicatedReviewStartLeases(options: {
  comments: Record<string, unknown>[];
  itemNumber: number;
  headSha: string;
  nowMs: number;
}): Array<{
  comment: Record<string, unknown>;
  startedAt: string;
  expiresAt: string;
  owner: string | null;
  commentId: number | null;
}> {
  const trustedAuthors = new Set(
    [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
  );
  return (
    options.comments
      .map((comment) => {
        const lease = freshExactHeadReviewStartLease({
          comments: [comment],
          itemNumber: options.itemNumber,
          headSha: options.headSha,
          trustedAuthors,
          nowMs: options.nowMs,
        });
        return lease ? { comment, ...lease } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      // GitHub comment ids are server-assigned and monotonic. A client timestamp cannot elect the
      // winner: a delayed worker could publish an earlier timestamp after another worker acquired
      // the lease, retroactively displacing it and allowing both reviews to run.
      .sort(
        (left, right) =>
          (commentId(left.comment) ?? Number.MAX_SAFE_INTEGER) -
          (commentId(right.comment) ?? Number.MAX_SAFE_INTEGER),
      )
  );
}

export function reviewStartLeaseWinnerCommentIdForTest(options: {
  comments: Record<string, unknown>[];
  itemNumber: number;
  headSha: string;
  nowMs: number;
}): number | null {
  return commentId(freshDedicatedReviewStartLeases(options)[0]?.comment);
}

function postReviewStartStatusComment(options: {
  item: Item;
  headSha?: string;
  reviewTimeoutMs: number;
  position: number;
  total: number;
  shardIndex: number;
  shardCount: number;
  purpose?: "review" | "apply";
}): ReviewStartStatusCommentResult {
  const startedAtMs = Date.now();
  const leaseOwner = randomUUID();
  const leaseOptions: ReviewStartStatusCommentOptions = {
    number: options.item.number,
    kind: options.item.kind,
    title: options.item.title,
    ...(options.headSha ? { headSha: options.headSha } : {}),
    startedAt: new Date(startedAtMs).toISOString(),
    leaseExpiresAt: new Date(startedAtMs + options.reviewTimeoutMs + 10 * 60 * 1000).toISOString(),
    leaseOwner,
    position: options.position,
    total: options.total,
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
    purpose: options.purpose ?? "review",
  };
  const normalizedHead = String(options.headSha ?? "")
    .trim()
    .toLowerCase();
  const initialState = issueReviewCommentState(options.item.number);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedHead)) {
    throw new Error(
      `cannot acquire a review lease without the current item revision for #${options.item.number}`,
    );
  }
  if (
    freshDedicatedReviewStartLeases({
      comments: initialState.leaseComments,
      itemNumber: options.item.number,
      headSha: normalizedHead,
      nowMs: startedAtMs,
    }).length > 0
  ) {
    return { status: "held", lease: null };
  }
  const body = renderReviewStartStatusComment(leaseOptions);
  const payload = writeCommentPayload(options.item.number, body);
  const createArgs = [
    "api",
    `repos/${targetRepo()}/issues/${options.item.number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
  ];
  const created = reviewCommentFromMutationResponse(ghWithRetry(createArgs), createArgs);
  const createdCommentId = commentId(created);
  if (createdCommentId === null) {
    throw new Error(
      `could not identify the created review lease comment for #${options.item.number}; retry required`,
    );
  }
  const acquired = { owner: leaseOwner, commentId: createdCommentId, headSha: normalizedHead };
  const confirmed = freshDedicatedReviewStartLeases({
    comments: issueReviewCommentState(options.item.number).leaseComments,
    itemNumber: options.item.number,
    headSha: normalizedHead,
    nowMs: Date.now(),
  });
  if (confirmed.length === 0) {
    deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
    throw new Error(
      `could not confirm the review lease comment for #${options.item.number}; retry required`,
    );
  }
  const winner = confirmed[0];
  if (
    commentId(winner?.comment) !== createdCommentId ||
    reviewStartLeaseOwner(winner?.comment) !== leaseOwner
  ) {
    deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
    return { status: "held", lease: null };
  }
  return { status: "posted", lease: acquired };
}

function deleteOwnedDedicatedReviewStartLease(
  itemNumber: number,
  lease: AcquiredReviewStartLease,
): boolean {
  try {
    const matching = issueReviewCommentState(itemNumber).dedicatedLeaseComments.find(
      (comment) =>
        commentId(comment) === lease.commentId &&
        reviewStartLeaseOwner(comment) === lease.owner &&
        (commentBody(comment) ?? "").includes(`sha=${lease.headSha}`),
    );
    if (!matching) return false;
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
      "--method",
      "DELETE",
    ]);
    return true;
  } catch (error) {
    console.error(
      `[review] could not delete owned review lease comment ${lease.commentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

function pullRequestHeadSha(number: number): string {
  const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
  const sha = asRecord(pull.head).sha;
  return typeof sha === "string" ? sha.trim().toLowerCase() : "";
}

function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
  if (options.kind === "pull_request") {
    ghWithRetry(["pr", "close", String(options.number)]);
  } else {
    const reason = isImplementationCloseReason(options.reason) ? "completed" : "not_planned";
    const closePayloadFile = join(ROOT, ".artifacts", `close-${options.number}.json`);
    writeFileSync(
      closePayloadFile,
      JSON.stringify({ state: "closed", state_reason: reason }),
      "utf8",
    );
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/${options.number}`,
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
reviewed_at: ${reviewedAt}
review_lease_owner: ${options.reviewLeaseOwner ?? "unknown"}
review_lease_comment_id: ${options.reviewLeaseCommentId ?? "unknown"}
main_sha: ${options.git.mainSha}
pull_head_sha: ${pullHeadShaFromContext(options.context) ?? "unknown"}
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
review_cache_hit: false
item_source_revision: ${options.context.sourceRevision ?? "unknown"}
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
  const planOptions: Parameters<typeof planCandidates>[0] = {
    batchSize,
    maxPages,
    shardCount,
    itemsDir,
    reviewPolicy,
    minimumActiveShards,
    minimumBackfillReviewAgeMs,
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
function buildLocalRangeReview(
  targetDir: string,
  repo: string,
  baseRef: string,
): { item: Item; context: ItemContext; baseSha: string; headSha: string } {
  const base = baseRef || "origin/main";
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const baseSha = run("git", ["merge-base", base, "HEAD"], { cwd: targetDir }).trim();
  if (!baseSha || baseSha === headSha) {
    throw new UserFacingCommandError(
      `No local-range review: HEAD has no commits beyond ${base} in ${targetDir}.`,
    );
  }
  // Reuse #298's committed-range contract: this offline review covers COMMITTED work,
  // so a dirty tree (staged/untracked changes the review can't see) is rejected.
  const dirtyTree = dirtyWorktree(targetDir);
  if (dirtyTree) {
    throw new UserFacingCommandError(
      `No local-range review: working tree not clean — commit or stash first:\n${dirtyTree}`,
    );
  }
  // Reuse #298's offline commit metadata (offline=true skips all gh-api hydration).
  const meta = commitMetadata(targetDir, repo, headSha, true);
  const bodyText = run("git", ["log", "-1", "--format=%b", headSha], { cwd: targetDir }).trim();
  const title = meta.subject || `local range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`;
  const author = meta.authorName || "local";
  const committedAt = meta.committedAt || "1970-01-01T00:00:00Z";
  const nameStatus = run("git", ["diff", "--name-status", `${baseSha}..${headSha}`], {
    cwd: targetDir,
  }).trim();
  const pullFiles = nameStatus
    ? nameStatus.split("\n").map((line) => {
        // name-status rows are tab-separated: "A\tfile", "M\tfile", or for rename/copy
        // "R100\told\tnew". The reviewable path is always the LAST field (the new path);
        // the status is the first. Splitting on the first tab only would feed the literal
        // "old\tnew" to `git diff -- <path>` and yield an empty patch for renames/copies.
        const parts = line.split("\t");
        const status = parts[0] ?? line;
        const filename = parts[parts.length - 1] ?? line;
        const patch = run("git", ["diff", `${baseSha}..${headSha}`, "--", filename], {
          cwd: targetDir,
        });
        return { filename, status, patch: truncateText(patch, 8000) };
      })
    : [];
  const item: Item = {
    repo,
    number: 0,
    kind: "pull_request",
    title,
    url: `local:${headSha}`,
    createdAt: committedAt,
    updatedAt: committedAt,
    author,
    // A pre-submission self-review is the CONTRIBUTOR case — the proof gate treats OWNER
    // (maintainer) PRs more leniently, which would undercut exercising the real proof path.
    authorAssociation: "CONTRIBUTOR",
    labels: [],
  };
  const context: ItemContext = {
    issue: {
      number: 0,
      title,
      body: bodyText,
      state: "open",
      user: { login: author },
      html_url: item.url,
    },
    comments: [],
    timeline: [],
    pullFiles,
    counts: { comments: 0, timeline: 0, pullFiles: pullFiles.length },
  };
  return { item, context, baseSha, headSha };
}

export function buildLocalRangeReviewForTest(
  targetDir: string,
  repo: string,
  baseRef: string,
): { item: Item; context: ItemContext; baseSha: string; headSha: string } {
  return buildLocalRangeReview(targetDir, repo, baseRef);
}

function reviewCommand(args: Args): void {
  const profile = repoFromArgs(args);
  // `--local-range` is inherently a local, offline operation, so it implies `--local-only`
  // (no GitHub writes, and the local Codex auth / Windows-launcher path in runCodex below).
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
  const forcedLoginMethod = reviewCodexForcedLoginMethod(args);
  const git: GitInfo = localRangeData
    ? { mainSha: localRangeData.baseSha, latestRelease: null }
    : checkout.gitTargetBranch
      ? gitInfo(openclawDir, { targetBranch: checkout.gitTargetBranch })
      : gitInfo(openclawDir);
  const reviewPolicy = reviewPolicyHash({ model, reasoningEffort, sandboxMode, serviceTier });
  // Planned background shards receive exact item numbers from the planner, but they are not
  // user-requested exact reviews. Only the workflow may opt those batches into cache reuse.
  const plannedAutomaticReview = boolArg(args.planned_automatic_review);
  const explicitDispatch =
    !plannedAutomaticReview && (itemNumber !== undefined || itemNumbers !== undefined);
  const maintainerRequest = additionalPrompt.trim().length > 0;
  const readonlyModeSnapshots = readonlyOpenclaw ? makeTreeReadOnly(openclawDir) : [];
  const acquiredReviewLeases: Array<{ itemNumber: number; lease: AcquiredReviewStartLease }> = [];
  let retainReviewLeasesForPublish = false;
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
    let completed = 0;
    let codexFailures = 0;
    let leaseAcquisitionFailures = 0;
    let cacheHits = 0;
    const codexFailureReports: string[] = [];
    const leaseAcquisitionFailureDetails: string[] = [];
    for (const item of candidates) {
      if (humanLocalReview) {
        console.error("");
        console.error("Collecting GitHub context");
      } else {
        console.error(
          `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start #${item.number} (${completed + 1}/${candidates.length})`,
        );
      }
      let acquiredReviewLease: AcquiredReviewStartLease | null = null;
      if (!skipStartComment && item.kind === "pull_request") {
        try {
          const startComment = postReviewStartStatusComment({
            item,
            headSha: pullRequestHeadSha(item.number),
            reviewTimeoutMs: timeoutMs,
            position: completed + 1,
            total: candidates.length,
            shardIndex,
            shardCount,
          });
          console.error(
            `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} start-comment=${startComment.status} #${item.number}`,
          );
          if (startComment.status === "held") continue;
          acquiredReviewLease = startComment.lease;
          if (!acquiredReviewLease) {
            throw new Error(`review lease acquisition returned no identity for PR #${item.number}`);
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
      const context = localRangeData
        ? localRangeData.context
        : collectItemContext(item, {
            fullTimelineForRelations: true,
            reviewCacheDigest: true,
          });
      const contextElapsedMs = Date.now() - contextStartedAt;
      const contextItemUpdatedAt = stringOrUndefined(asRecord(context.issue).updatedAt);
      if (contextItemUpdatedAt) item.updatedAt = contextItemUpdatedAt;
      if (
        acquiredReviewLease &&
        pullHeadShaFromContext(context)?.trim().toLowerCase() !== acquiredReviewLease.headSha
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
          if (startComment.status === "held") continue;
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
      const contentDigest = itemContentDigest(item, context, git);
      const priorReview =
        explicitDispatch || maintainerRequest ? null : existingReview(item, itemsDir);
      if (
        reviewContentCacheHit({
          review: priorReview,
          reviewPolicy,
          contentDigest,
          now: Date.now(),
          explicitDispatch,
          maintainerRequest,
        })
      ) {
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
        writeFileSync(reportPath, carried, "utf8");
        completed += 1;
        cacheHits += 1;
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
      // capture, and prepareMediaProofArtifacts would host-side `curl` + `ffmpeg` any media URL
      // in the synthetic body (commit message / --body-file). Skip it entirely for local-range:
      // no host download, no transcode of body-supplied URLs.
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
          preferWindowsAppBinary: localOnly,
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
        if (error instanceof CodexReviewError) {
          decision = codexFailureDecision(error.status, error.message, error.stdout, error.stderr, {
            errorCode: error.errorCode,
            signal: error.signal,
          });
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
          ...(acquiredReviewLease
            ? {
                reviewLeaseOwner: acquiredReviewLease.owner,
                reviewLeaseCommentId: acquiredReviewLease.commentId,
              }
            : {}),
        }),
        "utf8",
      );
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
    }
    if (!humanLocalReview) {
      console.error(
        `[review] ${new Date().toISOString()} shard=${shardIndex}/${shardCount} complete reviewed=${completed} cache_hits=${cacheHits}`,
      );
    }
    if (leaseAcquisitionFailures > 0) {
      throw new Error(
        `Could not acquire durable review coordination for ${leaseAcquisitionFailures} item${
          leaseAcquisitionFailures === 1 ? "" : "s"
        }; the workflow recovery lane can requeue the planned set. ${leaseAcquisitionFailureDetails.join("; ")}`,
      );
    }
    if (codexFailures > 0) {
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
    retainReviewLeasesForPublish = true;
  } finally {
    if (!retainReviewLeasesForPublish) {
      for (const acquired of acquiredReviewLeases) {
        deleteOwnedDedicatedReviewStartLease(acquired.itemNumber, acquired.lease);
      }
    }
    restoreTreeModes(readonlyModeSnapshots);
  }
}

const SOURCE_REVISION_MISMATCH_MARKER = "source-revision-mismatch.json";

interface ExpectedIssueSourceRevisionOptions {
  expectedSourceRevision: string;
  itemKind: "issue" | "pull_request";
  repo: string;
  number: number;
  sourceRevision: string | undefined;
  artifactDir: string;
}

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

function failedReviewRetryRevisionLabel(revision: FailedReviewRetryRevision): string {
  return revision.kind === "pull_head_sha" ? "head SHA" : "issue source revision";
}

function failedReviewRetryPrompt(options: {
  number: number;
  revision: FailedReviewRetryRevision;
  reason: string;
  attempts: number;
  maxAttempts: number;
}): string {
  return [
    "[clawsweeper-failed-review-retry=1]",
    "",
    "This is a bounded exact-item retry for a prior Codex timeout or infrastructure failure.",
    `Retry item: #${options.number}`,
    `Failed report ${failedReviewRetryRevisionLabel(options.revision)}: ${options.revision.value}`,
    `Prior failure: ${options.reason}`,
    `Retry attempt: ${options.attempts + 1}/${options.maxAttempts}`,
    "",
    "Produce a normal fresh review from the live item and checkout context.",
    "Do not infer any verdict from the failed review artifact; use it only as retry context.",
  ].join("\n");
}

function failedReviewRetrySection(options: {
  status: FailedReviewRetryStatus;
  at: string;
  revision: FailedReviewRetryRevision;
  attempts: number;
  maxAttempts: number;
  reason: string;
  dispatchUrl?: string;
}): string {
  const lines = [
    `- status: ${options.status}`,
    `- recorded at: ${options.at}`,
    `- ${failedReviewRetryRevisionLabel(options.revision)}: ${options.revision.value}`,
    `- attempts: ${options.attempts}/${options.maxAttempts}`,
    `- reason: ${options.reason}`,
  ];
  if (options.dispatchUrl) lines.push(`- retry run: ${options.dispatchUrl}`);
  if (options.status === "exhausted") {
    lines.push(
      "- next step: needs human review; retry attempts for this exact revision are exhausted.",
    );
  } else if (options.status === "dispatching") {
    lines.push("- next step: dispatch attempt checkpointed; wait for the retry cooldown.");
  } else if (options.status === "dispatch_failed") {
    lines.push("- next step: dispatch command failed; retry after the cooldown if still eligible.");
  }
  return lines.join("\n");
}

function checkpointFailedReviewRetry(options: {
  markdown: string;
  status: FailedReviewRetryStatus;
  at: string;
  revision: FailedReviewRetryRevision;
  attempts: number;
  maxAttempts: number;
  reason: string;
  dispatchUrl?: string;
}): string {
  let next = options.markdown;
  next = replaceFrontMatterValue(next, "failed_review_retry_status", options.status);
  next = replaceFrontMatterValue(next, "failed_review_retry_count", String(options.attempts));
  next = replaceFrontMatterValue(next, "failed_review_retry_last_at", options.at);
  next = replaceFrontMatterValue(next, "failed_review_retry_revision_kind", options.revision.kind);
  next = replaceFrontMatterValue(next, "failed_review_retry_revision", options.revision.value);
  if (options.revision.kind === "pull_head_sha") {
    next = replaceFrontMatterValue(next, "failed_review_retry_head_sha", options.revision.value);
  }
  next = replaceFrontMatterValue(
    next,
    "failed_review_retry_reason",
    JSON.stringify(options.reason),
  );
  if (options.dispatchUrl) {
    next = replaceFrontMatterValue(next, "failed_review_retry_dispatch_url", options.dispatchUrl);
  }
  return next;
}

function markFailedReviewRetry(options: {
  markdown: string;
  status: FailedReviewRetryStatus;
  at: string;
  revision: FailedReviewRetryRevision;
  attempts: number;
  maxAttempts: number;
  reason: string;
  dispatchUrl?: string;
}): string {
  const next = checkpointFailedReviewRetry(options);
  return appendSectionValue(next, "Failed Review Retry", failedReviewRetrySection(options));
}

function failedReviewRetryStatePath(stateDir: string, number: number): string {
  return join(stateDir, `${number}.json`);
}

function readFailedReviewRetryState(path: string): FailedReviewRetryState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FailedReviewRetryState>;
  const validStatus =
    parsed.status === "dispatching" ||
    parsed.status === "dispatched" ||
    parsed.status === "dispatch_failed" ||
    parsed.status === "exhausted";
  if (
    parsed.schema_version !== 1 ||
    typeof parsed.repo !== "string" ||
    !Number.isInteger(parsed.number) ||
    !validStatus ||
    (parsed.revision_kind !== "pull_head_sha" && parsed.revision_kind !== "item_source_revision") ||
    typeof parsed.revision !== "string" ||
    !Number.isInteger(parsed.attempts) ||
    !Number.isInteger(parsed.max_attempts) ||
    typeof parsed.last_at !== "string" ||
    typeof parsed.reason !== "string"
  ) {
    throw new Error(`Invalid failed-review retry state: ${path}`);
  }
  return parsed as FailedReviewRetryState;
}

function failedReviewRetryMarkdownWithState(
  markdown: string,
  state: FailedReviewRetryState | null,
): string {
  const reportNumber = Number(frontMatterValue(markdown, "number") ?? 0);
  if (!state || state.repo !== targetRepo() || state.number !== reportNumber) return markdown;
  const reportRevision = failedReviewRetryRevisionForReport(markdown);
  const stateRevision: FailedReviewRetryRevision = {
    kind: state.revision_kind,
    value: state.revision,
  };
  if (!reportRevision || !sameFailedReviewRetryRevision(reportRevision, stateRevision)) {
    return markdown;
  }
  return checkpointFailedReviewRetry({
    markdown,
    status: state.status,
    at: state.last_at,
    revision: stateRevision,
    attempts: state.attempts,
    maxAttempts: state.max_attempts,
    reason: state.reason,
    ...(state.dispatch_url ? { dispatchUrl: state.dispatch_url } : {}),
  });
}

function writeFailedReviewRetryState(
  path: string,
  options: {
    number: number;
    status: FailedReviewRetryStatus;
    at: string;
    revision: FailedReviewRetryRevision;
    attempts: number;
    maxAttempts: number;
    reason: string;
    dispatchUrl?: string;
  },
): void {
  const state: FailedReviewRetryState = {
    schema_version: 1,
    repo: targetRepo(),
    number: options.number,
    status: options.status,
    revision_kind: options.revision.kind,
    revision: options.revision.value,
    attempts: options.attempts,
    max_attempts: options.maxAttempts,
    last_at: options.at,
    reason: options.reason,
    ...(options.dispatchUrl ? { dispatch_url: options.dispatchUrl } : {}),
  };
  ensureDir(dirname(path));
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

const FAILED_REVIEW_RETRY_METADATA_KEYS = [
  "failed_review_retry_status",
  "failed_review_retry_count",
  "failed_review_retry_last_at",
  "failed_review_retry_revision_kind",
  "failed_review_retry_revision",
  "failed_review_retry_head_sha",
  "failed_review_retry_reason",
  "failed_review_retry_dispatch_url",
] as const;

export function preserveFailedReviewRetryMetadataForTest(
  previousMarkdown: string,
  incomingMarkdown: string,
): string {
  return preserveFailedReviewRetryMetadata(previousMarkdown, incomingMarkdown);
}

function preserveFailedReviewRetryMetadata(
  previousMarkdown: string,
  incomingMarkdown: string,
): string {
  if (effectiveReviewStatus(incomingMarkdown) !== "failed") return incomingMarkdown;
  const previousRevision = storedFailedReviewRetryRevision(previousMarkdown);
  const incomingRevision = failedReviewRetryRevisionForReport(incomingMarkdown);
  if (
    !previousRevision ||
    !incomingRevision ||
    !sameFailedReviewRetryRevision(previousRevision, incomingRevision)
  ) {
    return incomingMarkdown;
  }

  let next = incomingMarkdown;
  for (const key of FAILED_REVIEW_RETRY_METADATA_KEYS) {
    const value = frontMatterValue(previousMarkdown, key);
    if (value) next = replaceFrontMatterValue(next, key, value);
  }
  const retrySection = sectionValue(previousMarkdown, "Failed Review Retry");
  if (retrySection) next = replaceSectionValue(next, "Failed Review Retry", retrySection);
  return next;
}

function dispatchFailedReviewRetry(options: {
  workflowRepo: string;
  workflowRef: string;
  targetRepo: string;
  number: number;
  revision: FailedReviewRetryRevision;
  reason: string;
  attempts: number;
  maxAttempts: number;
  codexTimeoutMs: number;
  onBeforeDispatch?: (dispatchUrl: string) => void;
}): string {
  const prompt = failedReviewRetryPrompt({
    number: options.number,
    revision: options.revision,
    reason: options.reason,
    attempts: options.attempts,
    maxAttempts: options.maxAttempts,
  });
  if (options.revision.kind === "item_source_revision") {
    const workflowDefaultBranch = ghWithRetry([
      "api",
      `repos/${options.workflowRepo}`,
      "--jq",
      ".default_branch // empty",
    ]).trim();
    if (!workflowDefaultBranch) {
      throw new UserFacingCommandError(
        `Could not resolve the default branch for ${options.workflowRepo}.`,
      );
    }
    if (options.workflowRef !== workflowDefaultBranch) {
      throw new UserFacingCommandError(
        `Issue retry repository dispatch requires the workflow repository default branch (${workflowDefaultBranch}); got --workflow-ref ${options.workflowRef}.`,
      );
    }
    const dispatchUrl = `https://github.com/${options.workflowRepo}/actions/workflows/sweep.yml`;
    ghRawOnceWithCheckpoint(
      [
        "api",
        "--method",
        "POST",
        `repos/${options.workflowRepo}/dispatches`,
        "-f",
        "event_type=clawsweeper_target_sweep",
        "-f",
        `client_payload[target_repo]=${options.targetRepo}`,
        "-f",
        "client_payload[target_branch]=main",
        "-f",
        "client_payload[batch_size]=1",
        "-f",
        "client_payload[shard_count]=1",
        "-f",
        "client_payload[hot_intake]=false",
        "-f",
        `client_payload[codex_timeout_ms]=${options.codexTimeoutMs}`,
        "-f",
        `client_payload[item_number]=${options.number}`,
        "-f",
        `client_payload[additional_prompt]=${prompt}`,
        "-f",
        `client_payload[expected_source_revision]=${options.revision.value}`,
        "-f",
        "client_payload[source_revision_requeue_count]=0",
      ],
      () => options.onBeforeDispatch?.(dispatchUrl),
    );
    return dispatchUrl;
  }
  const dispatchUrl = `https://github.com/${options.workflowRepo}/actions/workflows/sweep.yml`;
  ghRawOnceWithCheckpoint(
    [
      "workflow",
      "run",
      "sweep.yml",
      "--repo",
      options.workflowRepo,
      "--ref",
      options.workflowRef,
      "-f",
      "apply_existing=false",
      "-f",
      "hot_intake=false",
      "-f",
      `target_repo=${options.targetRepo}`,
      "-f",
      "batch_size=1",
      "-f",
      "shard_count=1",
      "-f",
      `codex_timeout_ms=${options.codexTimeoutMs}`,
      "-f",
      `item_number=${options.number}`,
      "-f",
      `additional_prompt=${prompt}`,
    ],
    () => options.onBeforeDispatch?.(dispatchUrl),
  );
  return dispatchUrl;
}

function retryFailedReviewsCommand(args: Args): void {
  const runtimeBudget: GitHubRuntimeBudget = {
    startedAtMs: Date.now(),
    maxRuntimeMs: numberArg(args.max_runtime_ms, 0),
  };
  withGitHubRuntimeBudget(runtimeBudget, () => retryFailedReviewsCommandInner(args));
}

function retryFailedReviewsCommandInner(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const reportPath = resolve(
    stringArg(args.report_path, join(ROOT, "artifacts", "failed-review-retry-report.json")),
  );
  const stateDir = resolve(
    stringArg(args.state_dir, join(dirname(reportPath), "failed-review-retry-state")),
  );
  const limit = numberArg(args.limit, 5);
  const maxAttempts = Math.max(1, numberArg(args.max_attempts, 2));
  const cooldownMs = Math.max(0, numberArg(args.cooldown_minutes, 45) * 60 * 1000);
  const dryRun = boolArg(args.dry_run);
  const workflowRepo = stringArg(
    args.workflow_repo,
    process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper",
  );
  const workflowRef = stringArg(args.workflow_ref, "main");
  const codexTimeoutMs = numberArg(args.codex_timeout_ms, DEFAULT_REVIEW_CODEX_TIMEOUT_MS);
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const requested = new Set(requestedItemNumbers);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const results: FailedReviewRetryResult[] = [];
  let attempted = 0;
  let dispatched = 0;
  ensureDir(dirname(reportPath));
  try {
    for (const file of markdownFiles(itemsDir)) {
      ensureGitHubRuntimeAvailable("before failed-review retry item");
      const path = join(itemsDir, file);
      let markdown = readFileSync(path, "utf8");
      if (!isMarkdownForActiveRepo(markdown, path)) continue;
      const number = numberForMarkdownFile(file);
      const statePath = failedReviewRetryStatePath(stateDir, number);
      markdown = failedReviewRetryMarkdownWithState(
        markdown,
        readFailedReviewRetryState(statePath),
      );
      if (requested.size > 0 && !requested.has(number)) continue;
      if (results.some((result) => result.number === number)) continue;
      if (effectiveReviewStatus(markdown) !== "failed") {
        results.push({
          repo: targetRepo(),
          number,
          action: "skipped_not_failed_review",
          reason: "review is not failed",
          reportPath: path,
        });
        continue;
      }
      let item: Item;
      let state: string;
      let liveHeadSha: string | null = null;
      let liveSourceRevision: string | null = null;
      try {
        ({ item, state } = fetchItem(number));
        if (item.kind === "pull_request") liveHeadSha = livePullHeadSha(number);
        else liveSourceRevision = liveIssueSourceRevision(number);
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        results.push({
          repo: targetRepo(),
          number,
          action: "skipped_live_fetch_failed",
          reason: error instanceof Error ? error.message : String(error),
          reportPath: path,
        });
        continue;
      }
      const eligibility = failedReviewRetryEligibility({
        markdown,
        liveState: state,
        liveHeadSha,
        liveSourceRevision,
        now,
        maxAttempts,
        cooldownMs,
      });
      const retryRevision =
        eligibility.revisionKind && eligibility.revision
          ? { kind: eligibility.revisionKind, value: eligibility.revision }
          : null;
      if (eligibility.action === "skipped_retry_exhausted" && retryRevision) {
        if (isFailedReviewRetryAlreadyExhausted(markdown, retryRevision)) {
          results.push({
            ...eligibility,
            action: "skipped_retry_already_exhausted",
            reportPath: path,
          });
          continue;
        }
        const attempts = eligibility.attempts ?? maxAttempts;
        markdown = markFailedReviewRetry({
          markdown,
          status: "exhausted",
          at: nowIso,
          revision: retryRevision,
          attempts,
          maxAttempts,
          reason: eligibility.reason,
        });
        if (!dryRun) {
          writeFileSync(path, markdown, "utf8");
          writeFailedReviewRetryState(statePath, {
            number,
            status: "exhausted",
            at: nowIso,
            revision: retryRevision,
            attempts,
            maxAttempts,
            reason: eligibility.reason,
          });
        }
        results.push({
          ...eligibility,
          action: "marked_failed_review_retry_exhausted",
          reportPath: path,
        });
        continue;
      }
      if (eligibility.action !== "planned_failed_review_retry" || !retryRevision) {
        results.push({ ...eligibility, reportPath: path });
        continue;
      }
      if (attempted >= limit) break;
      const retryReason = codexFailureReason(failedReviewFailureDetail(markdown));
      if (dryRun) {
        results.push({ ...eligibility, reason: retryReason, reportPath: path });
        attempted += 1;
        dispatched += 1;
        continue;
      }
      const attempts = (eligibility.attempts ?? 0) + 1;
      let dispatchCheckpointed = false;
      let checkpointDispatchUrl: string | undefined;
      try {
        const dispatchUrl = dispatchFailedReviewRetry({
          workflowRepo,
          workflowRef,
          targetRepo: targetRepo(),
          number,
          revision: retryRevision,
          reason: retryReason,
          attempts: eligibility.attempts ?? 0,
          maxAttempts,
          codexTimeoutMs,
          onBeforeDispatch: (nextDispatchUrl) => {
            dispatchCheckpointed = true;
            checkpointDispatchUrl = nextDispatchUrl;
            markdown = checkpointFailedReviewRetry({
              markdown,
              status: "dispatching",
              at: nowIso,
              revision: retryRevision,
              attempts,
              maxAttempts,
              reason: retryReason,
              dispatchUrl: nextDispatchUrl,
            });
            writeFileSync(path, markdown, "utf8");
            writeFailedReviewRetryState(statePath, {
              number,
              status: "dispatching",
              at: nowIso,
              revision: retryRevision,
              attempts,
              maxAttempts,
              reason: retryReason,
              dispatchUrl: nextDispatchUrl,
            });
            attempted += 1;
          },
        });
        markdown = markFailedReviewRetry({
          markdown,
          status: "dispatched",
          at: nowIso,
          revision: retryRevision,
          attempts,
          maxAttempts,
          reason: retryReason,
          dispatchUrl,
        });
        writeFileSync(path, markdown, "utf8");
        writeFailedReviewRetryState(statePath, {
          number,
          status: "dispatched",
          at: nowIso,
          revision: retryRevision,
          attempts,
          maxAttempts,
          reason: retryReason,
          dispatchUrl,
        });
        results.push({
          repo: targetRepo(),
          number,
          action: "dispatched_failed_review_retry",
          reason: retryReason,
          ...failedReviewRetryResultRevision(retryRevision),
          attempts,
          reportPath: path,
          dispatchUrl,
        });
        dispatched += 1;
      } catch (error) {
        if (dispatchCheckpointed) {
          markdown = markFailedReviewRetry({
            markdown,
            status: "dispatch_failed",
            at: nowIso,
            revision: retryRevision,
            attempts,
            maxAttempts,
            reason: error instanceof Error ? error.message : String(error),
            ...(checkpointDispatchUrl ? { dispatchUrl: checkpointDispatchUrl } : {}),
          });
          writeFileSync(path, markdown, "utf8");
          writeFailedReviewRetryState(statePath, {
            number,
            status: "dispatch_failed",
            at: nowIso,
            revision: retryRevision,
            attempts,
            maxAttempts,
            reason: error instanceof Error ? error.message : String(error),
            ...(checkpointDispatchUrl ? { dispatchUrl: checkpointDispatchUrl } : {}),
          });
        }
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        results.push({
          repo: targetRepo(),
          number,
          action: "skipped_dispatch_failed",
          reason: error instanceof Error ? error.message : String(error),
          ...failedReviewRetryResultRevision(retryRevision),
          attempts: dispatchCheckpointed ? attempts : eligibility.attempts,
          reportPath: path,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof GitHubRuntimeBudgetError)) throw error;
    results.push({
      number: 0,
      action: "skipped_runtime_budget",
      reason: error.reason,
    });
  }
  writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ results, dryRun, attempted, dispatched }, null, 2));
}

function applyDecisionsCommand(args: Args): void {
  const runtimeBudget: GitHubRuntimeBudget = {
    startedAtMs: Date.now(),
    maxRuntimeMs: numberArg(args.max_runtime_ms, 0),
  };
  withGitHubRuntimeBudget(runtimeBudget, () => {
    try {
      applyDecisionsCommandInner(args, runtimeBudget);
    } catch (error) {
      if (!(error instanceof GitHubRuntimeBudgetError) || !runtimeBudget.onYield) throw error;
      runtimeBudget.onYield(error.reason);
    }
  });
}

function applyDecisionsCommandInner(args: Args, runtimeBudget: GitHubRuntimeBudget): void {
  repoFromArgs(args);
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
  const requirePrecomputedPrCloseCoverageProof = boolArg(
    args.require_precomputed_pr_close_coverage_proof,
  );
  const syncCommentsOnly = boolArg(args.sync_comments_only);
  const emitEventApplyProof = boolArg(args.event_apply_proof);
  const commentSyncMinAgeDays = numberArg(args.comment_sync_min_age_days, 0);
  const maxRuntimeMs = numberArg(args.max_runtime_ms, 0);
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
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const requestedItemNumberSet = new Set(requestedItemNumbers);
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
    reportEntriesForDir(dir)
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
  const syncDecisionPacketMarkdown = (
    reportPath: string,
    nextMarkdown: string,
    subjectState: DecisionPacketSubjectState = "open",
  ): string =>
    syncDecisionPacketRecord({
      markdown: nextMarkdown,
      reportPath,
      packetsDir: decisionPacketsDir,
      repoRoot: ROOT,
      subjectState,
    }).markdown;
  const writeReportMarkdown = (
    reportPath: string,
    nextMarkdown: string,
    subjectState: DecisionPacketSubjectState = "open",
  ): void => {
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
  const allOpenFileEntries = applyReportEntriesForDir(itemsDir, "items", false);
  const openFileEntryByNumber = new Map(allOpenFileEntries.map((entry) => [entry.number, entry]));
  const closedThisRun = new Set<string>();
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
  const finishApply = (): void => {
    ensureDir(dirname(reportPath));
    writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
    writeCursorTrace();
    logProgress("finished apply");
    console.log(JSON.stringify(results, null, 2));
  };
  let activeApplyMutationLease: {
    itemNumber: number;
    lease: AcquiredReviewStartLease;
  } | null = null;
  const releaseActiveApplyMutationLease = (): void => {
    const active = activeApplyMutationLease;
    activeApplyMutationLease = null;
    if (active) deleteOwnedDedicatedReviewStartLease(active.itemNumber, active.lease);
  };
  runtimeBudget.onYield = (reason: string, resumeCurrent = true): void => {
    releaseActiveApplyMutationLease();
    const currentNumber = examinedItemNumbers.at(-1);
    if (resumeCurrent && currentNumber !== undefined) {
      removeCurrentCursorTraceItem(examinedItemNumbers, currentNumber);
    }
    results.push({ number: 0, action: "skipped_runtime_budget", reason });
    logProgress(`stopping apply: ${reason}`);
    finishApply();
  };
  if (fileEntries.length === 0 && !existsSync(itemsDir)) {
    console.log("No items directory.");
    ensureDir(dirname(reportPath));
    writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
    writeCursorTrace();
    return;
  }
  logProgress(
    `starting apply: files=${files.length} dry_run=${dryRun} apply_kind=${applyKind} min_age=${minAgeDescription} apply_close_reasons=${closeReasonFilterText(applyCloseReasons)} stale_min_age_days=${staleMinAgeDays} close_delay_ms=${closeDelayMs} sync_comments_only=${syncCommentsOnly} comment_sync_min_age_days=${commentSyncMinAgeDays} max_runtime_ms=${maxRuntimeMs} item_numbers=${requestedItemNumbers.join(",") || "all"}`,
  );
  for (const entry of fileEntries) {
    releaseActiveApplyMutationLease();
    const file = entry.name;
    const path = entry.path;
    if (runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, Date.now())) {
      results.push({
        number: 0,
        action: "skipped_runtime_budget",
        reason: `max runtime ${maxRuntimeMs}ms reached`,
      });
      logProgress(`stopping apply: max runtime ${maxRuntimeMs}ms reached`);
      break;
    }
    let markdown = entry.markdown;
    const repo = entry.repo;
    const number = entry.number;
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
    const isUpgradedCloseCandidate =
      isRetryableSkippedClose ||
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
      if (!dryRun) writeFileSync(path, markdown, "utf8");
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
            leaseComments: refreshed.leaseComments,
            headSha: headAfter,
            lease: null,
            preserve: false,
            blockReason: `live issue source revision ${headAfter} differs from reviewed revision ${reportReviewRevision}`,
          };
        }
        return reviewStartLeaseStateForComments(
          refreshed.leaseComments,
          refreshed.reviewComment,
          headAfter,
        );
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        const detail = trimMiddle(
          (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
          180,
        );
        return {
          comment: undefined,
          leaseComments: [],
          headSha: "",
          lease: null,
          preserve: false,
          blockReason: `apply-time review lease check failed; next apply will retry: ${detail}`,
        };
      }
    };
    const ownedApplyMutationLeaseBlockReason = (lease: AcquiredReviewStartLease): string | null => {
      try {
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
      if (dryRun || !requiresApplyMutationLease) return null;
      const active = activeApplyMutationLease;
      if (!active || active.itemNumber !== number) return "apply mutation lease is not held";
      return ownedApplyMutationLeaseBlockReason(active.lease);
    };
    const recordReviewGuardSkip = (
      action: "kept_open" | "skipped_stale_review_comment_sync",
      reason: string,
      restoreOriginal = true,
    ): boolean => {
      markdown = replaceFrontMatterValue(
        restoreOriginal ? markdownBeforeApplyDecisionMutations : markdown,
        "apply_checked_at",
        new Date().toISOString(),
      );
      if (!dryRun) writeReportMarkdown(path, markdown);
      results.push({ number, action, reason });
      processedCount += 1;
      maybeLogProgress(`skipped #${number}: ${reason}`);
      return processedCount >= processedLimit;
    };
    const recordReviewLeaseSkip = (reason: string, restoreOriginal = true): boolean =>
      staleCanonicalCommentSyncPending
        ? markApplySkipped(
            "retry_stale_canonical_comment_sync",
            `${reason}; stale canonical comment correction remains pending`,
          )
        : recordReviewGuardSkip("kept_open", reason, restoreOriginal);
    const recordActiveReviewLeaseSkip = (expiresAt: string): boolean =>
      recordReviewLeaseSkip(
        `${item.kind === "pull_request" ? "same-head" : "same-revision"} ClawSweeper review is active until ${expiresAt}`,
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
        markdown = replaceFrontMatterValue(markdown, "labels_synced_at", new Date().toISOString());
        writeReportMarkdown(path, markdown);
      }
      removeCurrentCursorTraceItem(examinedItemNumbers, number);
      results.push({ number: 0, action: "skipped_runtime_budget", reason });
      logProgress(`stopping apply: ${reason}`);
    };
    const sameAuthorPairStartCloseable = new Map<string, boolean>();
    const currentCloseGatesPassed = (): boolean => {
      if (requiredMaintainerDecision?.required) return false;
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
            const { item: counterpartItem, state: counterpartState } = fetchItem(counterpartNumber);
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
            const counterpartMarkedReviewCommentHash = sha256(counterpartMarkedReviewComment);
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
      if (emitEventApplyProof && guardedOpenProof) {
        if (recordApplySkipped(guardedOpenProof.action, guardedOpenProof.reason, true)) break;
      }
      continue;
    }
    const earlyLeaseState = refreshReviewStartLeaseState();
    existingReviewComment = earlyLeaseState.comment;
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
      const promotion = pullRequestClosePromotion(
        markdown,
        item,
        promotionContext,
        staleMinAgeDays,
        { reportDirs: [itemsDir, closedDir] },
      );
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
          recordApplySkipped("kept_open", "unconfirmed product-direction apply policy is disabled")
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
        if (markApplySkipped("kept_open", lowSignalBlockReason)) break;
        continue;
      }
    }
    existingReviewComment ??= issueReviewComment(number, [
      renderReviewCommentFromReport(markdown, closeReason ?? "none", { previousLabels }),
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
    const automationOnlyUpdate =
      reviewCommentOnlyUpdate || labelSyncOnlyUpdate || ownedIssueReviewLeaseOnlyUpdate;
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
        reviewedAtMs === null ? {} : { ignoreTimelineCommentsThroughMs: reviewedAtMs },
      );
    };
    const stalePrReviewHead =
      state === "open" && item.kind === "pull_request"
        ? stalePullRequestReviewHead(markdown, currentItemContext())
        : null;
    let currentPrStatusKind: PrStatusLabelKind | null = null;
    if (state === "open") {
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
        });
        item.labels = proofSufficientSyncResult.labels;
        clawSweeperLabelsChanged ||= proofSufficientSyncResult.changed;
        const proofMediaSyncResult = syncRealBehaviorProofMediaLabels({
          number,
          labels: item.labels,
          proof: realBehaviorProof,
          dryRun,
        });
        item.labels = proofMediaSyncResult.labels;
        clawSweeperLabelsChanged ||= proofMediaSyncResult.changed;
        const prRatingSyncResult = syncPrRatingLabel({
          number,
          labels: item.labels,
          rating: reportPrRating(markdown),
          reviewFailed: frontMatterValue(markdown, "review_status") === "failed",
          dryRun,
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
        });
        item.labels = prStatusSyncResult.labels;
        clawSweeperLabelsChanged ||= prStatusSyncResult.changed;
        const telegramVisibleProofSyncResult = syncTelegramVisibleProofLabel({
          number,
          labels: item.labels,
          proof: reportTelegramVisibleProof(markdown),
          dryRun,
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
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_changed_since_review");
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
      const refreshedSelfMutationOnlyUpdate = allowedSelfMutationUpdatedAts.has(
        refreshed.item.updatedAt,
      );
      let refreshedContext: ItemContext | null = null;
      const selfMutationMaskedNonAutomationActivity = (): boolean => {
        if (prCloseCoverageProofStartedAtMs === null) return true;
        refreshedContext ??= collectItemContext(refreshed.item, { fullTimelineForRelations: true });
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
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
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
      markdown = replaceFrontMatterValue(markdown, "action_taken", "skipped_changed_since_review");
      markdown = replaceFrontMatterValue(markdown, "current_item_updated_at", item.updatedAt);
      markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
      if (!dryRun) writeReportMarkdown(path, markdown);
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
    if (isCloseProposal && !storedUpdatedAt) {
      const currentHash = itemSnapshotHash(item, currentItemContext());
      if (currentHash !== storedHash && !reviewCommentOnlyUpdate) {
        markdown = replaceFrontMatterValue(
          markdown,
          "action_taken",
          "skipped_changed_since_review",
        );
        markdown = replaceFrontMatterValue(markdown, "current_item_snapshot_hash", currentHash);
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        if (!dryRun) writeReportMarkdown(path, markdown);
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
    const isCurrentCompleteReport =
      frontMatterValue(markdown, "review_status") === "complete" &&
      !stalePrReviewHead &&
      labelSyncFreshEnough();
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
        });
        item.labels = syncResult.labels;
        clawSweeperLabelsChanged ||= syncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        const impactSyncResult = syncImpactLabels({
          number,
          labels: item.labels,
          impactLabels: item.kind === "pull_request" ? [] : impactLabelsFromReport(markdown),
          dryRun,
        });
        item.labels = impactSyncResult.labels;
        clawSweeperLabelsChanged ||= impactSyncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        const maturitySyncResult = syncMaturityLabels({
          number,
          labels: item.labels,
          maturityLabels: item.kind === "pull_request" ? [] : maturityLabelsFromReport(markdown),
          dryRun,
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
    if (state === "open" && item.kind === "issue" && !isCloseProposal && isCurrentCompleteReport) {
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
        });
        item.labels = syncResult.labels;
        issueAdvisoryLabelsChanged = syncResult.changed;
        clawSweeperLabelsChanged ||= syncResult.changed;
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        if (syncResult.changed) rememberSelfMutationUpdatedAt();
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
        if (markApplySkipped("skipped_open_closing_pr", openClosingPullRequestReason, true)) break;
        continue;
      }
    }
    let reviewCommentHash = sha256(markedReviewComment);
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
          reviewCommentHash = sha256(markedReviewComment);
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
        if (markApplySkipped("skipped_same_author_pair", sameAuthorCounterpartReason, true)) break;
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
    if (needsReviewCommentSync && needsReviewCommentBodySync && shouldCheckCanonicalCommentSync()) {
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
        reviewCommentHash = sha256(markedReviewComment);
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
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
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
      const lockedReason = needsReviewCommentBodySync ? lockedConversationApplyReason(item) : null;
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
            if (markApplySkipped("kept_open", lowSignalCommentSyncBlockReason)) break;
            continue;
          }
          try {
            syncedComment = upsertReviewComment(number, markedReviewComment, existingReviewComment);
            const syncedCommentUpdatedAt = commentUpdatedAt(syncedComment);
            if (syncedCommentUpdatedAt) {
              allowedSelfMutationUpdatedAts.add(syncedCommentUpdatedAt);
            }
            syncReasons.push("updated durable Codex review comment");
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
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
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
    if (requiredMaintainerDecision?.required) {
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
      if (markApplySkipped("kept_open", lowSignalBlockReason)) break;
      continue;
    }
    const inactivityCloseBlockReason =
      closeReason === "stalled_unproven_pr"
        ? stalledUnprovenPrApplyBlockReasonSafe(number, item)
        : closeReason === "abandoned_pr"
          ? abandonedPrApplyBlockReasonSafe(number, item)
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
    closeItem({ number, kind: item.kind, reason: closeReason });
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
      reason: [closeReasonText(closeReason), closeAppliedCommentReason].filter(Boolean).join("; "),
      ...(emitEventApplyProof ? { terminalStateVerified: true } : {}),
    });
    logProgress(`closed #${number}`);
    closedThisRun.add(pairCloseKey(repo, number));
    if (postCloseRuntimeYieldReason) {
      runtimeBudget.onYield?.(postCloseRuntimeYieldReason, false);
      return;
    }
    if (processedCount >= processedLimit) break;
  }
  releaseActiveApplyMutationLease();
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

function proofNudgeComments(number: number): ProofNudgeComment[] {
  return ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`).map((comment) => {
    const record = asRecord(comment);
    return {
      author: login(record.user),
      body: stringOrUndefined(record.body),
      createdAt: stringOrUndefined(record.created_at),
      updatedAt: stringOrUndefined(record.updated_at),
    };
  });
}

function fetchPullRequestProofNudgeDetails(number: number): ProofNudgePullRequestDetails {
  const pull = ghJson<Record<string, unknown>>([
    "api",
    `repos/${targetRepo()}/pulls/${number}`,
    "--jq",
    "{draft,head:{sha:.head.sha,repo:{full_name:(.head.repo.full_name // null)}}}",
  ]);
  const head = asRecord(pull.head);
  const headRepo = stringOrUndefined(asRecord(head.repo).full_name);
  const headSha = stringOrUndefined(head.sha);
  const details: ProofNudgePullRequestDetails = {
    headSha,
    headRepo,
    draft: pull.draft === true,
  };
  if (!headRepo || !headSha) return details;
  try {
    const commit = ghJson<Record<string, unknown>>([
      "api",
      `repos/${headRepo}/commits/${headSha}`,
      "--jq",
      "{authorDate:.commit.author.date,committerDate:.commit.committer.date}",
    ]);
    details.headCommittedAt = latestIsoTimestamp([
      stringOrUndefined(commit.authorDate),
      stringOrUndefined(commit.committerDate),
    ]);
  } catch (error) {
    console.warn(
      `Skipping head commit date for #${number}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return details;
}

function postProofNudgeComment(number: number, body: string): Record<string, unknown> {
  const payload = writeCommentPayload(number, body);
  return ghJson<Record<string, unknown>>([
    "api",
    `repos/${targetRepo()}/issues/${number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
    "--jq",
    "{id,html_url}",
  ]);
}

function upsertBotProofDecisionComment(
  number: number,
  headSha: string,
  body: string,
): Record<string, unknown> {
  const marker = botProofDecisionMarker({ number, headSha });
  const existing = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments?per_page=100`)
    .map(asRecord)
    .find((comment) => typeof comment.body === "string" && comment.body.includes(marker));
  const payload = writeCommentPayload(number, body);
  const existingId = commentId(existing);
  if (existingId !== null && canPatchReviewComment(existing)) {
    return ghJson<Record<string, unknown>>([
      "api",
      `repos/${targetRepo()}/issues/comments/${existingId}`,
      "--method",
      "PATCH",
      "--input",
      payload,
      "--jq",
      "{id,html_url}",
    ]);
  }
  return ghJson<Record<string, unknown>>([
    "api",
    `repos/${targetRepo()}/issues/${number}/comments`,
    "--method",
    "POST",
    "--input",
    payload,
    "--jq",
    "{id,html_url}",
  ]);
}

function syncBotProofDecisionLabels(options: {
  number: number;
  labels: readonly string[];
  dryRun: boolean;
}): { labels: string[]; changed: boolean; reason: string } {
  const statusResult = syncPrStatusLabel({
    number: options.number,
    labels: options.labels,
    statusKind: "needs_maintainer_proof_decision",
    dryRun: options.dryRun,
  });
  const staleLabels = statusResult.labels.filter((label) => normalizeLabelName(label) === "stale");
  const nextLabels = statusResult.labels.filter((label) => normalizeLabelName(label) !== "stale");
  if (!options.dryRun) {
    for (const label of staleLabels) {
      ghWithRetry(["issue", "edit", String(options.number), "--remove-label", label]);
    }
  }
  const changed = statusResult.changed || staleLabels.length > 0;
  const reasons = [
    statusResult.changed
      ? options.dryRun
        ? "would set maintainer proof decision status"
        : "set maintainer proof decision status"
      : null,
    staleLabels.length > 0
      ? options.dryRun
        ? "would remove inherited stale label"
        : "removed inherited stale label"
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return { labels: nextLabels, changed, reason: reasons.join("; ") };
}

function proofLaneCandidateRecords(
  itemsDir: string,
  requestedItemNumbers: readonly number[],
  likely: (markdown: string) => boolean,
): ProofLaneCandidate[] {
  const requested = new Set(requestedItemNumbers);
  return markdownFiles(itemsDir)
    .map((file) => {
      const path = join(itemsDir, file);
      const markdown = readFileSync(path, "utf8");
      const number = numberForMarkdownFile(file);
      const reviewedAt = frontMatterValue(markdown, "reviewed_at");
      const sortAt =
        timestampMs(reviewedAt) ??
        timestampMs(frontMatterValue(markdown, "item_updated_at")) ??
        Number.NEGATIVE_INFINITY;
      return { file, markdown, number, likely: likely(markdown), reviewedAt, sortAt };
    })
    .filter(({ file, markdown, number }) => {
      if (requested.size > 0 && !requested.has(number)) return false;
      if (!isMarkdownForActiveRepo(markdown, join(itemsDir, file))) return false;
      if (frontMatterValue(markdown, "type") !== "pull_request") return false;
      return true;
    })
    .sort((left, right) => compareProofLaneSortKey(left, right));
}

function proofLaneSortAt(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function compareProofLaneSortKey(
  left: Pick<ProofLaneCursor, "likely" | "number" | "sortAt">,
  right: Pick<ProofLaneCursor, "likely" | "number" | "sortAt">,
): number {
  if (left.likely !== right.likely) return left.likely ? -1 : 1;
  return proofLaneSortAt(left.sortAt) - proofLaneSortAt(right.sortAt) || left.number - right.number;
}

function rotateProofLaneCandidates<T extends ProofLaneCandidate>(
  candidates: readonly T[],
  cursor: ProofLaneCursor | null,
): T[] {
  if (!cursor) return [...candidates];
  return [
    ...candidates.filter((candidate) => compareProofLaneSortKey(candidate, cursor) > 0),
    ...candidates.filter((candidate) => compareProofLaneSortKey(candidate, cursor) <= 0),
  ];
}

function proofLaneCursorPath(args: Args, requestedItemNumbers: readonly number[]): string | null {
  if (requestedItemNumbers.length > 0) return null;
  const rawPath = stringArg(args.cursor_path, "").trim();
  return rawPath ? resolve(rawPath) : null;
}

function proofLaneProcessedLimit(args: Args, fallback: number): number {
  const value = numberArg(args.processed_limit, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new UserFacingCommandError("--processed-limit must be a positive integer");
  }
  return value;
}

function readProofLaneCursor(path: string): ProofLaneCursor | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
    const number = Number(parsed.next_cursor_number);
    if (!Number.isInteger(number) || number <= 0) return null;
    return {
      likely: parsed.next_cursor_likely === true,
      number,
      sortAt:
        typeof parsed.next_cursor_sort_at_ms === "number" &&
        Number.isFinite(parsed.next_cursor_sort_at_ms)
          ? parsed.next_cursor_sort_at_ms
          : Number.NEGATIVE_INFINITY,
    };
  } catch (error) {
    console.warn(
      `Ignoring invalid proof lane cursor ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function writeProofLaneCursor(path: string, lane: string, candidate: ProofLaneCandidate): void {
  ensureDir(dirname(path));
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        repository: targetRepo(),
        lane,
        next_cursor_number: candidate.number,
        next_cursor_likely: candidate.likely,
        next_cursor_sort_at_ms: Number.isFinite(candidate.sortAt) ? candidate.sortAt : null,
        reviewed_at: candidate.reviewedAt ?? null,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function proofNudgeCandidateRecords(
  itemsDir: string,
  requestedItemNumbers: readonly number[],
): ProofLaneCandidate[] {
  return proofLaneCandidateRecords(
    itemsDir,
    requestedItemNumbers,
    realBehaviorProofNeedsContributorNudge,
  );
}

function botProofCandidateRecords(
  itemsDir: string,
  requestedItemNumbers: readonly number[],
): ProofLaneCandidate[] {
  return proofLaneCandidateRecords(itemsDir, requestedItemNumbers, (markdown) => {
    return (
      frontMatterValue(markdown, "review_status") === "complete" &&
      frontMatterValue(markdown, "type") === "pull_request" &&
      isClawSweeperAppAuthor(frontMatterValue(markdown, "author")) &&
      realBehaviorProofBlocksBotOwnedMerge(markdown)
    );
  });
}

function proofNudgeLiveFetchFailureReason(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail =
    lines.find((line) => !line.startsWith("Command failed:")) ?? lines[0] ?? "unknown error";
  return `live GitHub state could not be fetched: ${detail.slice(0, 300)}`;
}

export function proofNudgeCandidateRecordsForTest(
  itemsDir: string,
  requestedItemNumbers: readonly number[] = [],
): ReturnType<typeof proofNudgeCandidateRecords> {
  return proofNudgeCandidateRecords(itemsDir, requestedItemNumbers);
}

export function rotateProofLaneCandidatesForTest<T extends ProofLaneCandidate>(
  candidates: readonly T[],
  cursor: ProofLaneCursor | null,
): T[] {
  return rotateProofLaneCandidates(candidates, cursor);
}

export function botProofCandidateRecordsForTest(
  itemsDir: string,
  requestedItemNumbers: readonly number[] = [],
): ReturnType<typeof botProofCandidateRecords> {
  return botProofCandidateRecords(itemsDir, requestedItemNumbers);
}

function proofNudgesCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const limit = Math.max(0, numberArg(args.limit, DEFAULT_PROOF_NUDGE_LIMIT));
  const processedLimit = proofLaneProcessedLimit(args, Math.max(limit * 20, 50));
  const minAgeDays = Math.max(0, numberArg(args.min_age_days, DEFAULT_PROOF_NUDGE_MIN_AGE_DAYS));
  const cooldownDays = Math.max(
    0,
    numberArg(args.cooldown_days, DEFAULT_PROOF_NUDGE_COOLDOWN_DAYS),
  );
  const execute = boolArg(args.execute);
  const dryRun = !execute;
  const maxRuntimeMs = numberArg(args.max_runtime_ms, 0);
  const reportPath = resolve(stringArg(args.report_path, join(ROOT, "proof-nudge-report.json")));
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const cursorPath = proofLaneCursorPath(args, requestedItemNumbers);

  if (!existsSync(itemsDir)) {
    const results: ProofNudgeResult[] = [];
    ensureDir(dirname(reportPath));
    writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const allCandidates = proofNudgeCandidateRecords(itemsDir, requestedItemNumbers);
  const cursor = cursorPath ? readProofLaneCursor(cursorPath) : null;
  const candidates = rotateProofLaneCandidates(allCandidates, cursor);
  const startedAtMs = Date.now();
  const results: ProofNudgeResult[] = [];
  let processedCount = 0;
  let nudgeCount = 0;
  let lastProcessedCandidate: ProofLaneCandidate | null = null;
  const markProcessed = (candidate: ProofLaneCandidate): void => {
    processedCount += 1;
    lastProcessedCandidate = candidate;
  };
  const logProgress = (message: string): void => {
    const counts = results.reduce<Record<string, number>>((accumulator, result) => {
      accumulator[result.action] = (accumulator[result.action] ?? 0) + 1;
      return accumulator;
    }, {});
    console.error(
      [
        `[proof-nudges] ${new Date().toISOString()} ${message}`,
        `nudges=${nudgeCount}/${limit}`,
        `processed=${processedCount}/${processedLimit}`,
        `dry_run=${dryRun}`,
        `counts=${JSON.stringify(counts)}`,
      ].join(" "),
    );
  };

  logProgress(
    `starting proof nudges: candidates=${allCandidates.length} min_age_days=${minAgeDays} cooldown_days=${cooldownDays} item_numbers=${requestedItemNumbers.join(",") || "all"} cursor_path=${cursorPath ?? "none"}`,
  );
  for (const candidate of candidates) {
    if (nudgeCount >= limit) break;
    if (processedCount >= processedLimit) break;
    if (runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, Date.now())) {
      results.push({
        repo: targetRepo(),
        number: 0,
        action: "skipped_runtime_budget",
        reason: `max runtime ${maxRuntimeMs}ms reached`,
      });
      logProgress(`stopping proof nudges: max runtime ${maxRuntimeMs}ms reached`);
      break;
    }

    const resultBase = {
      repo: markdownRepository(candidate.markdown, join(itemsDir, candidate.file)),
      number: candidate.number,
      reviewedAt: candidate.reviewedAt,
    };
    let item: Item;
    let state: string;
    try {
      const fetched = fetchItem(candidate.number);
      item = fetched.item;
      state = fetched.state;
    } catch (error) {
      results.push({
        ...resultBase,
        action: "skipped_live_fetch_failed",
        reason: proofNudgeLiveFetchFailureReason(error),
      });
      markProcessed(candidate);
      continue;
    }
    if (state !== "open") {
      results.push({
        ...resultBase,
        action: "skipped_not_open",
        reason: `state is ${state}`,
      });
      markProcessed(candidate);
      continue;
    }
    let pullDetails: Partial<ProofNudgePullRequestDetails> = {};
    let comments: ProofNudgeComment[] = [];
    let authorEditedAt: string | undefined;
    let authorReviewActivityAt: string | undefined;
    try {
      pullDetails =
        item.kind === "pull_request" ? fetchPullRequestProofNudgeDetails(candidate.number) : {};
      comments = item.kind === "pull_request" ? proofNudgeComments(candidate.number) : [];
      authorEditedAt =
        item.kind === "pull_request"
          ? latestAuthorPullRequestEditAt(candidate.number, item.author)
          : undefined;
      authorReviewActivityAt =
        item.kind === "pull_request"
          ? latestAuthorPullRequestReviewActivityAt(candidate.number, item.author)
          : undefined;
    } catch (error) {
      results.push({
        ...resultBase,
        action: "skipped_live_fetch_failed",
        reason: proofNudgeLiveFetchFailureReason(error),
      });
      markProcessed(candidate);
      continue;
    }
    const eligibility = proofNudgeEligibility({
      item,
      markdown: candidate.markdown,
      comments,
      headSha: pullDetails.headSha,
      headCommittedAt: pullDetails.headCommittedAt,
      authorEditedAt,
      authorReviewActivityAt,
      minAgeDays,
      cooldownDays,
    });
    if (!eligibility.eligible) {
      results.push({
        ...resultBase,
        action: eligibility.action,
        reason: eligibility.reason,
        headSha: pullDetails.headSha,
      });
      markProcessed(candidate);
      continue;
    }

    const timestamp = new Date().toISOString();
    const headSha = pullDetails.headSha;
    if (!headSha) {
      results.push({
        ...resultBase,
        action: "skipped_no_live_head",
        reason: "live PR head SHA could not be inspected",
      });
      markProcessed(candidate);
      continue;
    }
    const body = renderProofNudgeComment({ item, headSha, timestamp });
    if (dryRun) {
      results.push({
        ...resultBase,
        action: "proof_nudge_planned",
        reason: eligibility.reason,
        headSha,
      });
    } else {
      const comment = postProofNudgeComment(candidate.number, body);
      results.push({
        ...resultBase,
        action: "proof_nudge_posted",
        reason: eligibility.reason,
        url: commentUrl(comment) ?? undefined,
        headSha,
      });
    }
    markProcessed(candidate);
    nudgeCount += 1;
    logProgress(`${dryRun ? "planned" : "posted"} proof nudge #${candidate.number}`);
  }
  if (!dryRun && cursorPath && lastProcessedCandidate) {
    writeProofLaneCursor(cursorPath, "proof_nudges", lastProcessedCandidate);
  }
  ensureDir(dirname(reportPath));
  writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  logProgress("finished proof nudges");
  console.log(JSON.stringify(results, null, 2));
}

function botProofCommand(args: Args): void {
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const limit = Math.max(0, numberArg(args.limit, DEFAULT_PROOF_NUDGE_LIMIT));
  const processedLimit = proofLaneProcessedLimit(args, Math.max(limit * 20, 50));
  const execute = boolArg(args.execute);
  const dryRun = !execute;
  const maxRuntimeMs = numberArg(args.max_runtime_ms, 0);
  const reportPath = resolve(stringArg(args.report_path, join(ROOT, "bot-proof-report.json")));
  const requestedItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const cursorPath = proofLaneCursorPath(args, requestedItemNumbers);

  if (!existsSync(itemsDir)) {
    const results: BotProofResult[] = [];
    ensureDir(dirname(reportPath));
    writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const allCandidates = botProofCandidateRecords(itemsDir, requestedItemNumbers);
  const cursor = cursorPath ? readProofLaneCursor(cursorPath) : null;
  const candidates = rotateProofLaneCandidates(allCandidates, cursor);
  const startedAtMs = Date.now();
  const results: BotProofResult[] = [];
  let processedCount = 0;
  let actionCount = 0;
  let lastProcessedCandidate: ProofLaneCandidate | null = null;
  const markProcessed = (candidate: ProofLaneCandidate): void => {
    processedCount += 1;
    lastProcessedCandidate = candidate;
  };
  const logProgress = (message: string): void => {
    const counts = results.reduce<Record<string, number>>((accumulator, result) => {
      accumulator[result.action] = (accumulator[result.action] ?? 0) + 1;
      return accumulator;
    }, {});
    console.error(
      [
        `[bot-proof] ${new Date().toISOString()} ${message}`,
        `actions=${actionCount}/${limit}`,
        `processed=${processedCount}/${processedLimit}`,
        `dry_run=${dryRun}`,
        `counts=${JSON.stringify(counts)}`,
      ].join(" "),
    );
  };

  logProgress(
    `starting bot proof handling: candidates=${allCandidates.length} item_numbers=${requestedItemNumbers.join(",") || "all"} cursor_path=${cursorPath ?? "none"}`,
  );
  for (const candidate of candidates) {
    if (actionCount >= limit) break;
    if (processedCount >= processedLimit) break;
    if (runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, Date.now())) {
      results.push({
        repo: targetRepo(),
        number: 0,
        action: "skipped_runtime_budget",
        reason: `max runtime ${maxRuntimeMs}ms reached`,
      });
      logProgress(`stopping bot proof handling: max runtime ${maxRuntimeMs}ms reached`);
      break;
    }

    const resultBase = {
      repo: markdownRepository(candidate.markdown, join(itemsDir, candidate.file)),
      number: candidate.number,
      reviewedAt: candidate.reviewedAt,
    };
    let item: Item;
    let state: string;
    let pullDetails: Partial<ProofNudgePullRequestDetails> = {};
    try {
      const fetched = fetchItem(candidate.number);
      item = fetched.item;
      state = fetched.state;
      pullDetails =
        item.kind === "pull_request" ? fetchPullRequestProofNudgeDetails(candidate.number) : {};
    } catch (error) {
      results.push({
        ...resultBase,
        action: "skipped_live_fetch_failed",
        reason: proofNudgeLiveFetchFailureReason(error),
      });
      markProcessed(candidate);
      continue;
    }
    if (state !== "open") {
      results.push({
        ...resultBase,
        action: "skipped_not_open",
        reason: `state is ${state}`,
      });
      markProcessed(candidate);
      continue;
    }
    const eligibility = botProofEligibility({
      item,
      markdown: candidate.markdown,
      headSha: pullDetails.headSha,
      draft: pullDetails.draft,
    });
    if (!eligibility.eligible) {
      results.push({
        ...resultBase,
        action: eligibility.action,
        reason: eligibility.reason,
        headSha: pullDetails.headSha,
      });
      markProcessed(candidate);
      continue;
    }
    const headSha = pullDetails.headSha;
    if (!headSha) {
      results.push({
        ...resultBase,
        action: "skipped_no_live_head",
        reason: "live PR head SHA could not be inspected",
      });
      markProcessed(candidate);
      continue;
    }
    const commentBody = renderBotProofDecisionComment({
      item,
      headSha,
      markdown: candidate.markdown,
      timestamp: new Date().toISOString(),
      mantisRecommendation: eligibility.mantisRecommendation,
    });
    const labelResult = syncBotProofDecisionLabels({
      number: candidate.number,
      labels: item.labels,
      dryRun,
    });
    if (dryRun) {
      results.push({
        ...resultBase,
        action: eligibility.action,
        reason: [eligibility.reason, labelResult.reason].filter(Boolean).join("; "),
        headSha,
      });
    } else {
      const comment = upsertBotProofDecisionComment(candidate.number, headSha, commentBody);
      results.push({
        ...resultBase,
        action:
          eligibility.action === "bot_proof_mantis_request_planned"
            ? "bot_proof_mantis_request_posted"
            : "bot_proof_decision_posted",
        reason: [eligibility.reason, labelResult.reason].filter(Boolean).join("; "),
        url: commentUrl(comment) ?? undefined,
        headSha,
      });
    }
    markProcessed(candidate);
    actionCount += 1;
    logProgress(`${dryRun ? "planned" : "posted"} bot proof handling #${candidate.number}`);
  }
  if (!dryRun && cursorPath && lastProcessedCandidate) {
    writeProofLaneCursor(cursorPath, "bot_proof", lastProcessedCandidate);
  }
  ensureDir(dirname(reportPath));
  writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  logProgress("finished bot proof handling");
  console.log(JSON.stringify(results, null, 2));
}

function applyArtifactsCommand(args: Args): void {
  repoFromArgs(args);
  const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts"));
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
  const skipReconcile = boolArg(args.skip_reconcile);
  const replayClosedArtifacts = boolArg(args.replay_closed_artifacts);
  const maxPages = numberArg(args.max_pages, 250);
  const openNumbers = skipReconcile ? null : fetchOpenItemNumbers(maxPages).numbers;
  let appliedArtifacts = 0;
  let skippedClosedArtifacts = 0;
  ensureDir(itemsDir);
  ensureDir(closedDir);
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
        skippedClosedArtifacts += 1;
        continue;
      }
      const destinationDir = destination === "closed" ? closedDir : itemsDir;
      const stalePath = join(destinationDir === itemsDir ? closedDir : itemsDir, destinationFile);
      if (existsSync(stalePath)) unlinkSync(stalePath);
      const reportPath = join(destinationDir, destinationFile);
      if (existsSync(reportPath)) {
        markdown = preserveFailedReviewRetryMetadata(readFileSync(reportPath, "utf8"), markdown);
      }
      const syncedMarkdown = syncDecisionPacketRecord({
        markdown,
        reportPath,
        packetsDir: decisionPacketsDir,
        repoRoot: ROOT,
        subjectState: destination === "closed" ? "closed" : "open",
      }).markdown;
      writeFileSync(reportPath, syncedMarkdown, "utf8");
      if (destination === "closed") {
        const planPath = workPlanPathForReport(reportPath, plansDir);
        if (existsSync(planPath)) unlinkSync(planPath);
      } else {
        syncWorkPlanFromReport({ markdown: syncedMarkdown, reportPath, plansDir });
      }
      appliedArtifacts += 1;
    }
  }
  console.error(
    `[apply-artifacts] applied=${appliedArtifacts} skipped_closed=${skippedClosedArtifacts}`,
  );
  if (!skipReconcile) reconcileFolders({ itemsDir, closedDir, plansDir, decisionPacketsDir });
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

interface ReportEntry {
  name: string;
  number: number;
  path: string;
  repo: string;
  markdown: string;
}

function reportEntriesForDir(dir: string): ReportEntry[] {
  return markdownFiles(dir).map((name) => {
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
  if (!shouldPlanItem(item)) {
    if (isProtectedItem(item)) return "protected_label";
    if (isMaintainerAuthored(item)) return "maintainer_authored";
  }
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
  const protectedProposed = options.itemRecords
    .filter(
      (record) =>
        record.action === "proposed_close" &&
        applyBlockingProtectedLabels(record.labels, record.closeReason).length > 0,
    )
    .map((record) => recordFinding(record));
  const staleReviews = options.itemRecords
    .filter((record) => record.reviewStatus.startsWith("stale_"))
    .map((record) => recordFinding(record));

  return {
    generatedAt,
    targetRepo: targetRepo(),
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

function auditReviewTargetNumbers(result: AuditResult, limit = 10): number[] {
  const categories: (keyof AuditResult["findings"])[] = [
    "missingEligibleOpen",
    "openArchived",
    "staleReviews",
  ];
  const numbers = new Set<number>();
  for (const category of categories) {
    for (const finding of result.findings[category]) {
      if (category === "staleReviews" && finding.currentState === "closed") continue;
      numbers.add(finding.number);
      if (numbers.size >= limit) return [...numbers];
    }
  }
  return [...numbers];
}

function auditReviewTargets(result: AuditResult): string {
  const numbers = auditReviewTargetNumbers(result);
  if (numbers.length === 0) return "Targeted review input: _none_";
  return `Targeted review input: \`${numbers.join(",")}\``;
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
        `| ${markdownLink(`#${finding.number}`, itemUrlFor(result.targetRepo, finding.number, finding.kind ?? "issue"))} | ${auditFindingCategory(category)} | ${displayTitle(finding.title ?? "").replaceAll("|", "\\|")} | ${auditFindingDetail(finding).replaceAll("|", "\\|")} |`,
      );
      if (rows.length >= limit) return rows.join("\n");
    }
  }
  return "| _None_ |  |  |  |";
}

export function auditHealthSection(result: AuditResult | null): string {
  const profile = result ? repositoryProfileFor(result.targetRepo) : targetProfile();
  if (!result) {
    return `### Audit Health

${profileAuditStart(profile)}
No audit has been published yet. Run \`npm run audit -- --update-dashboard\` to refresh audit state.
${profileAuditEnd(profile)}`;
  }
  return `### Audit Health

${profileAuditStart(profile)}
Repository: ${markdownLink(result.targetRepo, repoUrlFor(result.targetRepo))}

Last audit: ${formatTimestamp(result.generatedAt)}

Status: **${auditHealthStatus(result)}**

${auditReviewTargets(result)}

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
${profileAuditEnd(profile)}`;
}

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
  maxPages?: number;
  dryRun?: boolean;
  fetchClosedAt?: boolean;
  preserveItemNumbers?: readonly number[];
}): ReconcileResult {
  const maxPages = options.maxPages ?? 250;
  const dryRun = options.dryRun ?? false;
  const fetchClosedAt = options.fetchClosedAt ?? true;
  const plansDir = options.plansDir ?? defaultPlansDir();
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
    if (!dryRun && existsSync(planPath)) unlinkSync(planPath);

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
  repoFromArgs(args);
  const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
  const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
  const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
  const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
  const maxPages = numberArg(args.max_pages, 250);
  const dryRun = boolArg(args.dry_run);
  const fetchClosedAt = !boolArg(args.skip_closed_at);
  const preserveItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
  const result = reconcileFolders({
    itemsDir,
    closedDir,
    plansDir,
    decisionPacketsDir,
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

  return { bucket: "weeklyOlderIssues", cadenceMs: WEEKLY_REVIEW_DAYS * DAY_MS };
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

function workPriorityScore(priority: string): number {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  if (priority === "low") return 1;
  return 0;
}

function markdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function jsonFrontMatterValue(value: readonly unknown[]): string {
  return JSON.stringify(value);
}

function workStatusForDecision(decision: Decision): string {
  if (decision.workCandidate === "queue_fix_pr") return "candidate";
  if (decision.workCandidate === "manual_review") return "manual_review";
  return "none";
}

function displayCloseReason(reason: string | undefined): string {
  if (reason && ALL_REASONS.has(reason as CloseReason))
    return closeReasonText(reason as CloseReason);
  return reason || "unknown";
}

export function dashboardClosedAt(markdown: string): string | undefined {
  const appliedAt = frontMatterValue(markdown, "applied_at");
  if (appliedAt) return appliedAt;
  const currentItemClosedAt = frontMatterValue(markdown, "current_item_closed_at");
  if (currentItemClosedAt) return currentItemClosedAt;
  const currentState = frontMatterValue(markdown, "current_state");
  const action = frontMatterValue(markdown, "action_taken");
  if (currentState === "closed") return frontMatterValue(markdown, "reconciled_at");
  if (action === "skipped_already_closed") return frontMatterValue(markdown, "apply_checked_at");
  return undefined;
}

function dashboardCloseReason(markdown: string): string | undefined {
  const closeReason = frontMatterValue(markdown, "close_reason");
  const action = frontMatterValue(markdown, "action_taken");
  if (action === "closed") return closeReason;
  if (action === "skipped_already_closed") return "already closed before apply";
  if (frontMatterValue(markdown, "current_state") === "closed") {
    if (action === "kept_open") return "closed externally after review";
    if (action === "skipped_changed_since_review") return "closed externally after item changed";
    return action ? `closed externally after ${action}` : "closed externally";
  }
  return closeReason;
}

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

export function formatRecentClosedRows(items: readonly DashboardClosedItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const reason = markdownTableCell(displayCloseReason(item.closeReason));
        return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${reason} | ${formatTimestamp(item.closedAt ?? item.appliedAt)} | ${markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath))} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |"
  );
}

function formatRecentReviewedRows(items: readonly DashboardItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const outcome = markdownLink(
          `${item.decision} / ${item.action}`,
          reportFileUrl(item.number, item.reportPath),
        );
        return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |"
  );
}

function formatWorkQueueRows(items: readonly DashboardItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const report = markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath));
        const plan = item.planPath
          ? markdownLink(item.planPath, reportFileUrl(item.number, item.planPath))
          : "_pending_";
        return `| ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${item.workPriority} | ${item.workStatus} | ${formatTimestamp(item.reviewedAt)} | ${plan} | ${report} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |  |"
  );
}

function formatFleetRecentClosedRows(items: readonly DashboardClosedItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const reason = markdownTableCell(displayCloseReason(item.closeReason));
        return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${reason} | ${formatTimestamp(item.closedAt ?? item.appliedAt)} | ${markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath))} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |"
  );
}

function formatFleetRecentReviewedRows(items: readonly DashboardItem[], limit = 10): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const outcome = markdownLink(
          `${item.decision} / ${item.action}`,
          reportFileUrl(item.number, item.reportPath),
        );
        return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${outcome} | ${item.reviewStatus} | ${formatTimestamp(item.reviewedAt)} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |"
  );
}

function formatFleetWorkQueueRows(items: readonly DashboardItem[], limit = 15): string {
  return (
    items
      .slice(0, limit)
      .map((item) => {
        const repo = item.repo ?? targetRepo();
        const title = markdownTableCell(displayTitle(item.title));
        const report = markdownLink(item.reportPath, reportFileUrl(item.number, item.reportPath));
        const plan = item.planPath
          ? markdownLink(item.planPath, reportFileUrl(item.number, item.planPath))
          : "_pending_";
        return `| ${markdownLink(repo, repoUrlFor(repo))} | ${markdownLink(`#${item.number}`, itemUrlFor(repo, item.number, item.kind))} | ${title} | ${item.workPriority} | ${item.workStatus} | ${formatTimestamp(item.reviewedAt)} | ${plan} | ${report} |`;
      })
      .join("\n") || "| _None_ |  |  |  |  |  |  |  |"
  );
}

function addActivityBucket(target: DashboardActivityBucket, source: DashboardActivityBucket): void {
  target.reviews += source.reviews;
  target.closeDecisions += source.closeDecisions;
  target.keepOpenDecisions += source.keepOpenDecisions;
  target.failedOrStaleReviews += source.failedOrStaleReviews;
  target.closes += source.closes;
  target.commentSyncs += source.commentSyncs;
  target.applySkips += source.applySkips;
  target.inheritedLabelCleanups += source.inheritedLabelCleanups;
  target.selfHealConflictRepairs += source.selfHealConflictRepairs;
  target.failedReviewRetries += source.failedReviewRetries;
  target.failedReviewRetryExhaustions += source.failedReviewRetryExhaustions;
  target.botOwnedProofDecisionsRequested += source.botOwnedProofDecisionsRequested;
  target.botOwnedProofDispatches += source.botOwnedProofDispatches;
}

function aggregateActivity(snapshots: readonly RepoDashboardSnapshot[]): DashboardActivityStats {
  const activity = emptyDashboardActivityStats();
  for (const snapshot of snapshots) {
    addActivityBucket(activity.last15Minutes, snapshot.stats.activity.last15Minutes);
    addActivityBucket(activity.lastHour, snapshot.stats.activity.lastHour);
    addActivityBucket(activity.last24Hours, snapshot.stats.activity.last24Hours);
    activity.latestReviewAt = latestTimestamp(
      activity.latestReviewAt,
      snapshot.stats.activity.latestReviewAt,
    );
    activity.latestCloseAt = latestTimestamp(
      activity.latestCloseAt,
      snapshot.stats.activity.latestCloseAt,
    );
    activity.latestCommentSyncAt = latestTimestamp(
      activity.latestCommentSyncAt,
      snapshot.stats.activity.latestCommentSyncAt,
    );
  }
  return activity;
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

function formatRepositoryOverviewRow(snapshot: RepoDashboardSnapshot): string {
  const stats = snapshot.stats;
  return `| ${markdownLink(snapshot.profile.displayName, repoUrlFor(snapshot.profile.targetRepo))} | ${stats.open.total} | ${stats.files} | ${stats.cadence.unreviewedOpen} | ${stats.cadence.due} | ${stats.proposedClose} | ${stats.workCandidates} | ${stats.closed} | ${formatTimestamp(stats.activity.latestReviewAt)} | ${formatTimestamp(stats.activity.latestCloseAt)} | ${stats.activity.lastHour.commentSyncs} |`;
}

function formatWorkflowStatusRow(snapshot: RepoDashboardSnapshot): string {
  const run = snapshot.statusSummary.runUrl
    ? markdownLink("run", snapshot.statusSummary.runUrl)
    : "_none_";
  const plan =
    snapshot.statusSummary.plannedCount === undefined &&
    snapshot.statusSummary.plannedCapacity === undefined &&
    snapshot.statusSummary.plannedShards === undefined
      ? "unknown"
      : `${formatStatusNumber(snapshot.statusSummary.plannedCount)}/${formatStatusNumber(
          snapshot.statusSummary.plannedCapacity,
        )} items, ${formatStatusNumber(snapshot.statusSummary.plannedShards)} shards`;
  return `| ${markdownLink(snapshot.profile.displayName, repoUrlFor(snapshot.profile.targetRepo))} | ${markdownTableCell(snapshot.statusSummary.state)} | ${formatStatusNumber(snapshot.statusSummary.activeCodex)} | ${plan} | ${formatStatusNumber(snapshot.statusSummary.dueBacklog)} | ${formatTimestamp(snapshot.statusSummary.oldestUnreviewedAt)} | ${markdownTableCell(snapshot.statusSummary.capacityReason ?? "unknown")} | ${formatTimestamp(snapshot.statusSummary.updatedAt)} | ${run} |`;
}

function renderRepoDashboardDetails(snapshot: RepoDashboardSnapshot): string {
  const stats = snapshot.stats;
  return `<details>
<summary>${snapshot.profile.displayName} (${snapshot.profile.targetRepo})</summary>

<br>

#### Current Run

${snapshot.status}

#### Queue

| Metric | Count |
| --- | ---: |
| Target repository | ${markdownLink(snapshot.profile.targetRepo, repoUrlFor(snapshot.profile.targetRepo))} |
| Open issues | ${stats.open.issues} |
| Open PRs | ${stats.open.pullRequests} |
| Open items total | ${stats.open.total} |
| Reviewed files | ${stats.files} |
| Unreviewed open items | ${stats.cadence.unreviewedOpen} |
| Active Codex target | ${formatStatusNumber(snapshot.statusSummary.activeCodex)} |
| Planned review items | ${formatStatusNumber(snapshot.statusSummary.plannedCount)} |
| Planned review shards | ${formatStatusNumber(snapshot.statusSummary.plannedShards)} |
| Planned review capacity | ${formatStatusNumber(snapshot.statusSummary.plannedCapacity)} |
| Due backlog scanned | ${formatStatusNumber(snapshot.statusSummary.dueBacklog)} |
| Oldest unreviewed scanned | ${formatTimestamp(snapshot.statusSummary.oldestUnreviewedAt)} |
| Capacity reason | ${markdownTableCell(snapshot.statusSummary.capacityReason ?? "unknown")} |
| Archived closed files | ${stats.archivedFiles} |

#### Review Outcomes

| Metric | Count |
| --- | ---: |
| Fresh reviewed issues in the last ${FRESH_DAYS} days | ${stats.byKind.issue.fresh} |
| Proposed issue closes | ${stats.byKind.issue.proposedClose} (${formatPercent(stats.byKind.issue.proposedClose, stats.byKind.issue.fresh)} of reviewed issues) |
| Fresh reviewed PRs in the last ${FRESH_DAYS} days | ${stats.byKind.pull_request.fresh} |
| Proposed PR closes | ${stats.byKind.pull_request.proposedClose} (${formatPercent(stats.byKind.pull_request.proposedClose, stats.byKind.pull_request.fresh)} of reviewed PRs) |
| Fresh verified reviews in the last ${FRESH_DAYS} days | ${stats.fresh} |
| Proposed closes awaiting apply | ${stats.proposedClose} (${formatPercent(stats.proposedClose, stats.fresh)} of fresh reviews) |
| Work candidates awaiting promotion | ${stats.workCandidates} |
| Closed by Codex apply | ${stats.closed} |
| Failed or stale reviews | ${stats.failed + stats.stale} |

#### Cadence

| Metric | Coverage |
| --- | ---: |
| First-week item cadence (<${HOT_REVIEW_DAYS}d) | ${formatCadenceBucket(stats.cadence.hourlyHotItems)} |
| Daily cadence coverage | ${formatCadenceBucket(stats.cadence.daily)} |
| Daily PR cadence | ${formatCadenceBucket(stats.cadence.dailyPullRequests)} |
| Daily new issue cadence (<${RECENT_ISSUE_DAYS}d) | ${formatCadenceBucket(stats.cadence.dailyNewIssues)} |
| Weekly older issue cadence | ${formatCadenceBucket(stats.cadence.weekly)} |
| Due now by cadence | ${stats.cadence.due} |

${snapshot.auditHealth}

#### Latest Run Activity

Latest review: ${formatTimestamp(stats.activity.latestReviewAt)}. Latest close: ${formatTimestamp(stats.activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(stats.activity.latestCommentSyncAt)}.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${formatActivityRow("Last 15 minutes", stats.activity.last15Minutes)}
${formatActivityRow("Last hour", stats.activity.lastHour)}
${formatActivityRow("Last 24 hours", stats.activity.last24Hours)}

#### Operation Counters

| Window | Inherited-label cleanups | Self-heal conflict repairs | Failed-review retries | Exhausted review retries | Bot proof decisions | Bot proof dispatches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${formatOperationActivityRow("Last 15 minutes", stats.activity.last15Minutes)}
${formatOperationActivityRow("Last hour", stats.activity.lastHour)}
${formatOperationActivityRow("Last 24 hours", stats.activity.last24Hours)}

#### Recently Closed

| Item | Title | Reason | Closed | Report |
| --- | --- | --- | --- | --- |
${formatRecentClosedRows(stats.recentClosed)}

#### Work Candidates

| Item | Title | Priority | Status | Reviewed | Plan | Report |
| --- | --- | --- | --- | --- | --- | --- |
${formatWorkQueueRows(stats.workQueue)}

#### Recently Reviewed

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
${formatRecentReviewedRows(stats.recent)}

</details>`;
}

function updateDashboard(itemsDir = defaultItemsDir(), closedDir = defaultClosedDir()): void {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const snapshots = dashboardSnapshots(readme, itemsDir, closedDir);
  const activity = aggregateActivity(snapshots);
  const recent = snapshots
    .flatMap((snapshot) => snapshot.stats.recent)
    .sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
  const workQueue = snapshots
    .flatMap((snapshot) => snapshot.stats.workQueue)
    .sort(
      (a, b) =>
        workPriorityScore(b.workPriority) - workPriorityScore(a.workPriority) ||
        Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""),
    );
  const recentClosed = snapshots
    .flatMap((snapshot) => snapshot.stats.recentClosed)
    .sort(
      (a, b) =>
        (timestampMs(b.closedAt ?? b.appliedAt) ?? Number.NEGATIVE_INFINITY) -
          (timestampMs(a.closedAt ?? a.appliedAt) ?? Number.NEGATIVE_INFINITY) ||
        b.number - a.number,
    );
  const totals = snapshots.reduce(
    (accumulator, snapshot) => {
      const stats = snapshot.stats;
      accumulator.openIssues += stats.open.issues;
      accumulator.openPullRequests += stats.open.pullRequests;
      accumulator.reviewedFiles += stats.files;
      accumulator.unreviewedOpen += stats.cadence.unreviewedOpen;
      accumulator.due += stats.cadence.due;
      accumulator.activeCodex += snapshot.statusSummary.activeCodex ?? 0;
      accumulator.plannedShards += snapshot.statusSummary.plannedShards ?? 0;
      accumulator.plannedCapacity += snapshot.statusSummary.plannedCapacity ?? 0;
      accumulator.dueBacklog += snapshot.statusSummary.dueBacklog ?? 0;
      accumulator.proposedClose += stats.proposedClose;
      accumulator.workCandidates += stats.workCandidates;
      accumulator.closed += stats.closed;
      accumulator.failedOrStale += stats.failed + stats.stale;
      accumulator.archivedFiles += stats.archivedFiles;
      return accumulator;
    },
    {
      openIssues: 0,
      openPullRequests: 0,
      reviewedFiles: 0,
      unreviewedOpen: 0,
      due: 0,
      activeCodex: 0,
      plannedShards: 0,
      plannedCapacity: 0,
      dueBacklog: 0,
      proposedClose: 0,
      workCandidates: 0,
      closed: 0,
      failedOrStale: 0,
      archivedFiles: 0,
    },
  );
  const dashboard = `## Dashboard

Last dashboard update: ${formatTimestamp(new Date().toISOString())}

### Fleet

| Metric | Count |
| --- | ---: |
| Covered repositories | ${snapshots.length} |
| Open issues | ${totals.openIssues} |
| Open PRs | ${totals.openPullRequests} |
| Open items total | ${totals.openIssues + totals.openPullRequests} |
| Reviewed files | ${totals.reviewedFiles} |
| Unreviewed open items | ${totals.unreviewedOpen} |
| Due now by cadence | ${totals.due} |
| Active Codex target | ${totals.activeCodex} |
| Planned review shards | ${totals.plannedShards} |
| Planned review capacity | ${totals.plannedCapacity} |
| Due backlog scanned | ${totals.dueBacklog} |
| Proposed closes awaiting apply | ${totals.proposedClose} |
| Work candidates awaiting promotion | ${totals.workCandidates} |
| Closed by Codex apply | ${totals.closed} |
| Failed or stale reviews | ${totals.failedOrStale} |
| Archived closed files | ${totals.archivedFiles} |

### Repositories

| Repository | Open | Reviewed | Unreviewed | Due | Proposed closes | Work candidates | Closed | Latest review | Latest close | Comments synced, 1h |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
${snapshots.map(formatRepositoryOverviewRow).join("\n")}

### Current Runs

| Repository | State | Active Codex | Plan | Due backlog | Oldest unreviewed | Capacity reason | Updated | Run |
| --- | --- | ---: | --- | ---: | --- | --- | --- | --- |
${snapshots.map(formatWorkflowStatusRow).join("\n")}

### Fleet Activity

Latest review: ${formatTimestamp(activity.latestReviewAt)}. Latest close: ${formatTimestamp(activity.latestCloseAt)}. Latest comment sync: ${formatTimestamp(activity.latestCommentSyncAt)}.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${formatActivityRow("Last 15 minutes", activity.last15Minutes)}
${formatActivityRow("Last hour", activity.lastHour)}
${formatActivityRow("Last 24 hours", activity.last24Hours)}

### Fleet Operation Counters

| Window | Inherited-label cleanups | Self-heal conflict repairs | Failed-review retries | Exhausted review retries | Bot proof decisions | Bot proof dispatches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${formatOperationActivityRow("Last 15 minutes", activity.last15Minutes)}
${formatOperationActivityRow("Last hour", activity.lastHour)}
${formatOperationActivityRow("Last 24 hours", activity.last24Hours)}

### Recently Closed Across Repos

| Repository | Item | Title | Reason | Closed | Report |
| --- | --- | --- | --- | --- | --- |
${formatFleetRecentClosedRows(recentClosed)}

### Work Candidates Across Repos

| Repository | Item | Title | Priority | Status | Reviewed | Plan | Report |
| --- | --- | --- | --- | --- | --- | --- | --- |
${formatFleetWorkQueueRows(workQueue)}

<details>
<summary>Recently Reviewed Across Repos</summary>

<br>

| Repository | Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- | --- |
${formatFleetRecentReviewedRows(recent)}

</details>

### Repository Details

${snapshots.map(renderRepoDashboardDetails).join("\n\n")}`;
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

function assistCommand(args: Args): void {
  repoFromArgs(args);
  const itemNumber = numberArg(args.item_number, 0);
  if (!itemNumber) throw new Error("--item-number is required for assist");
  const question = stringArg(args.question, "").trim();
  if (!question) throw new Error("--question is required for assist");
  const model = stringArg(args.codex_model, PUBLIC_CODEX_MODEL);
  const reasoningEffort = stringArg(args.codex_reasoning_effort, "high");
  const sandboxMode = stringArg(args.codex_sandbox, "read-only");
  const timeoutMs = numberArg(args.codex_timeout_ms, 120_000);
  const workDir = resolve(stringArg(args.work_dir, join(ROOT, ".artifacts", "assist-codex")));
  const sourceCommentId = stringArg(args.comment_id, "");
  const sourceCommentUrl = stringArg(args.comment_url, "");
  const author = stringArg(args.author, "");
  const mode = stringArg(args.mode, "assist") === "visual" ? "visual" : "assist";
  const lens = normalizeVisualLens(stringArg(args.lens, "auto"));
  const { item, state } = fetchItem(itemNumber);
  if (state.toLowerCase() !== "open") {
    throw new Error(`assist requires an open issue or PR; #${itemNumber} is ${state}`);
  }
  const context = collectItemContext(item);
  const answer = runCodexAssist({
    item,
    context,
    question,
    sourceCommentUrl,
    author,
    model,
    reasoningEffort,
    sandboxMode,
    timeoutMs,
    workDir,
    mode,
    lens,
  });
  if (mode === "visual") {
    const comment = renderVisualComment({
      body: answer,
      item,
      context,
      lens,
      model: PUBLIC_CODEX_MODEL,
      reasoningEffort,
      sourceCommentUrl,
      sourceCommentId,
    });
    postOrUpdateVisualComment(item.number, lens, itemHeadSha(item, context), comment);
    console.log(
      JSON.stringify({
        posted: true,
        mode,
        item: item.number,
        lens,
        model: PUBLIC_CODEX_MODEL,
        reasoningEffort,
      }),
    );
    return;
  }
  const comment = renderAssistComment({
    body: answer,
    model: PUBLIC_CODEX_MODEL,
    reasoningEffort,
    sourceCommentUrl,
    sourceCommentId,
  });
  postAssistComment(item.number, comment);
  console.log(
    JSON.stringify({
      posted: true,
      mode,
      item: item.number,
      model: PUBLIC_CODEX_MODEL,
      reasoningEffort,
    }),
  );
}

function checkCommand(): void {
  JSON.parse(reviewDecisionSchemaText());
  if (!existsSync(join(ROOT, ".github", "workflows", "sweep.yml")))
    throw new Error("Missing workflow");
  console.log("ok");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const command = args._[0] ?? "review";
  if (command === "plan") planCommand(args);
  else if (command === "review") reviewCommand(args);
  else if (command === "retry-failed-reviews") retryFailedReviewsCommand(args);
  else if (command === "apply-artifacts") applyArtifactsCommand(args);
  else if (command === "apply-decisions") applyDecisionsCommand(args);
  else if (command === "proof-nudges") proofNudgesCommand(args);
  else if (command === "bot-proof") botProofCommand(args);
  else if (command === "audit") auditCommand(args);
  else if (command === "reconcile") reconcileCommand(args);
  else if (command === "dashboard") {
    repoFromArgs(args);
    updateDashboard(
      resolve(stringArg(args.items_dir, defaultItemsDir())),
      resolve(stringArg(args.closed_dir, defaultClosedDir())),
    );
  } else if (command === "status") statusCommand(args);
  else if (command === "assist") assistCommand(args);
  else if (command === "check") checkCommand();
  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
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
