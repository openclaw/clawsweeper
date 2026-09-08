import type { MaintainerDecision } from "./decision-packets.js";
import type { PrCloseCoverageProofModelResult } from "./pr-close-coverage-proof.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import type {
  ReviewHistoryCycle,
  ReviewItemCoverage,
  reviewHistoryForReviewer,
} from "./review-history.js";
import type { ReviewStructuralRecord } from "./review-structural-cache.js";
import type { PrHydrationSnapshot } from "./pr-hydration-snapshot.js";
import type { SchedulerDueCandidate } from "./scheduler-policy.js";

/** Shared ClawSweeper domain, review, scheduling, and dashboard shapes. */
export const completeActivityContextSymbol = Symbol("completeActivityContext");

export type ItemKind = "issue" | "pull_request";
export type ApplyKind = ItemKind | "all";
export type DecisionKind = "close" | "keep_open";
export type WorkCandidateKind = "none" | "manual_review" | "queue_fix_pr";
export type NextStepAssessment = { kind: "none" | "required"; text: string };
export type FailedReviewRetryRevisionKind = "pull_head_sha" | "item_source_revision";
export interface FailedReviewRetryRevision {
  kind: FailedReviewRetryRevisionKind;
  value: string;
}
export type FailedReviewRetryStatus =
  | "dispatching"
  | "dispatched"
  | "dispatch_failed"
  | "exhausted";
export type FailedReviewRetryAction =
  | "dispatched_failed_review_retry"
  | "planned_failed_review_retry"
  | "marked_failed_review_retry_exhausted"
  | "skipped_retry_already_exhausted"
  | "skipped_not_failed_review"
  | "skipped_not_open"
  | "skipped_locked_conversation"
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
  | "skipped_retry_dispatch_uncertain"
  | "skipped_runtime_budget";
export type TriagePriority = "P0" | "P1" | "P2" | "P3" | "none";
export type ImpactLabelName =
  | "impact:data-loss"
  | "impact:security"
  | "impact:crash-loop"
  | "impact:message-loss"
  | "impact:session-state"
  | "impact:auth-provider"
  | "impact:ux-release-blocker"
  | "impact:ux-friction"
  | "impact:other";
export type MergeRiskLabelName =
  | "merge-risk: 🚨 compatibility"
  | "merge-risk: 🚨 message-delivery"
  | "merge-risk: 🚨 session-state"
  | "merge-risk: 🚨 auth-provider"
  | "merge-risk: 🚨 security-boundary"
  | "merge-risk: 🚨 availability"
  | "merge-risk: 🚨 automation"
  | "merge-risk: 🚨 other";
export type MaturityLabelName = "maturity:stable";
export type MergeRiskOptionCategory = "fix_before_merge" | "accept_risk" | "pause_or_close";
export type ReviewLabelName =
  | Exclude<TriagePriority, "none">
  | ImpactLabelName
  | MergeRiskLabelName
  | MaturityLabelName;
export type ItemCategory =
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
export type ReproductionStatus =
  | "reproduced"
  | "source_reproducible"
  | "not_reproduced"
  | "unclear"
  | "not_applicable";
export type OverallCorrectness = "patch is correct" | "patch is incorrect" | "not a patch";
export type AgentsPolicyStatusKind =
  | "found_applied"
  | "found_not_applicable"
  | "not_found"
  | "conflict_not_applied"
  | "unreadable_or_unclear";
export type SecurityReviewStatus = "cleared" | "needs_attention" | "not_applicable";
export type SecurityConcernSeverity = "high" | "medium" | "low";
export type RealBehaviorProofStatus =
  | "sufficient"
  | "missing"
  | "mock_only"
  | "insufficient"
  | "not_applicable"
  | "override";
export type RealBehaviorProofEvidenceKind =
  | "screenshot"
  | "recording"
  | "terminal"
  | "logs"
  | "live_output"
  | "linked_artifact"
  | "none"
  | "not_applicable";
export type PrRatingTier = "S" | "A" | "B" | "C" | "D" | "F" | "NA";
export type PrStatusLabelKind =
  | "automerge_armed"
  | "re_review_loop"
  | "actively_grinding"
  | "needs_proof"
  | "needs_maintainer_proof_decision"
  | "waiting_on_author"
  | "ready_for_maintainer_look";
export type FeatureShowcaseStatus = "showcase" | "none";
export type TelegramVisibleProofStatus = "needed" | "not_needed";
export type LiveProofPlanStatus = "recommended" | "not_applicable" | "declined_suspicious";
export type LiveProofSurface = "browser" | "terminal" | "none";
export type LiveProofTerminalCompletion = "exit_zero" | "ready_while_running" | "not_applicable";
export type LiveProofPayoffKind =
  | "progressive_output"
  | "ui_interaction"
  | "tui_or_color"
  | "animation"
  | "static_text";
export type LiveProofBrowserStep =
  | { action: "goto"; path: string }
  | { action: "click"; target: string }
  | { action: "fill"; target: string; value: string }
  | { action: "press"; key: string }
  | { action: "wait_for"; target: string }
  | { action: "wait"; seconds: number }
  | { action: "expect_text"; text: string };
export type LiveProofTerminalStep =
  | { action: "run"; command: string }
  | { action: "wait"; seconds: number }
  | { action: "expect_output"; text: string };
export type LiveProofStep = LiveProofBrowserStep | LiveProofTerminalStep;
export type MantisRecommendationStatus = "recommended" | "not_recommended";
export type MantisRecommendationScenario =
  | "none"
  | "discord_status_reactions"
  | "discord_thread_attachment"
  | "web_ui_chat_proof"
  | "slack_desktop_smoke"
  | "visual_task";
export type VisionFitStatus = "aligned" | "rejected" | "unclear" | "not_applicable";
export type ImplementationComplexity = "small" | "medium" | "large" | "unclear" | "not_applicable";
export type AutoImplementationCandidate = "none" | "strict_bug" | "vision_fit";
export type RootCauseRelationship =
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
export type CloseReason =
  | "implemented_on_main"
  | "mostly_implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
  | "low_signal_unmergeable_pr"
  | "stalled_unproven_pr"
  | "abandoned_pr"
  | "unconfirmed_product_direction"
  | "unsponsored_feature_request"
  | "author_pr_budget_exceeded"
  | "stale_version_bug"
  | "obsolete_fix_pr"
  | "not_actionable_in_repo"
  | "incoherent"
  | "stale_insufficient_info"
  | "none";
export type Confidence = "high" | "medium" | "low";
export type ActionTaken =
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
  | "skipped_low_signal_live_guard"
  | "skipped_pr_close_coverage_proof"
  | "retry_pr_close_coverage_proof"
  | "retry_stale_canonical_comment_sync"
  | "skipped_invalid_decision"
  | "skipped_missing_record"
  | "skipped_runtime_budget";

export interface GitHubUser {
  login?: string;
}

export interface GitHubIssueListItem {
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

export interface Item {
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

export interface BulkFilerReviewContext {
  detected: true;
  issueCount: number;
  threshold: number;
  windowDays: number;
  windowStart: string;
  label: "clawsweeper:bulk-filed";
}

export interface BulkFilerDetectionResult {
  context: BulkFilerReviewContext | null;
  labelPending: boolean;
  labelApplied: boolean;
}

export type BulkFilerCountCache = Map<string, number | null>;
export type BulkFilerRepositoryPermissionCache = Map<string, string | null>;

export interface BulkFilerDetectionOptions {
  item: Pick<Item, "author" | "authorAssociation" | "createdAt" | "kind" | "labels" | "number">;
  cache: BulkFilerCountCache;
  now: number;
  env?: Record<string, string | undefined>;
  searchCount: (options: { author: string; windowStart: string }) => number;
  onSearchError?: (error: unknown) => void;
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

export type AcquiredReviewStartLease = {
  owner: string;
  commentId: number;
  headSha: string;
  comment?: Record<string, unknown>;
};

export type ExactReviewQueueAuthority = {
  queueUrl: string;
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
  sourceHeadSha: string | null;
};

export type ReviewStartStatusCommentResult =
  | { status: "posted"; lease: AcquiredReviewStartLease; didMutate: true }
  | { status: "held"; lease: null; retryAt: string; didMutate: boolean };

export interface ExistingReview {
  path: string;
  markdown: string;
  reviewedAt: string | undefined;
  itemUpdatedAt: string | undefined;
  automationItemUpdatedAt?: string | undefined;
  reviewCommentSyncedAt: string | undefined;
  labelsSyncedAt: string | undefined;
  decision: string | undefined;
  reviewStatus: string | undefined;
  reviewPolicy: string | undefined;
  reviewModel: string | undefined;
  itemSourceRevision: string | undefined;
  contentDigest: string | undefined;
  lastFullReviewAt: string | undefined;
  lastFullReviewDecision: string | undefined;
  structuralRecord: ReviewStructuralRecord | null;
}

export interface LatestRelease {
  tagName?: string;
  name?: string;
  publishedAt?: string;
  isLatest?: boolean;
  targetCommitish?: string;
  sha?: string | null;
}

export interface GitInfo {
  mainSha: string;
  targetBranch?: string;
  releaseStateComplete: boolean;
  latestRelease: LatestRelease | null;
}

export interface Evidence {
  repo: string | null;
  label: string;
  detail: string;
  file: string | null;
  line: number | null;
  command: string | null;
  sha: string | null;
}

export interface LikelyOwnerHistory {
  commitSha: string;
  sourcePath: string;
  sourceLine: number;
  actor: "author" | "committer";
}

export interface LikelyOwner {
  person: string;
  role: string;
  reason: string;
  commits: string[];
  files: string[];
  confidence: Confidence;
  history?: LikelyOwnerHistory | null;
  /** Host-owned projection; never accepted from model output. */
  attributionSource?: "raw_parent_line_v1";
}

export interface ReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidenceScore: number;
  file: string;
  lineStart: number;
  lineEnd: number;
  lateFinding?: boolean;
}

export interface SecurityConcern {
  title: string;
  body: string;
  severity: SecurityConcernSeverity;
  confidenceScore: number;
  file: string | null;
  line: number | null;
}

export interface SecurityReview {
  status: SecurityReviewStatus;
  summary: string;
  concerns: SecurityConcern[];
}

export interface RealBehaviorProof {
  status: RealBehaviorProofStatus;
  summary: string;
  evidenceKind: RealBehaviorProofEvidenceKind;
  needsContributorAction: boolean;
}

export interface PrRating {
  proofTier: PrRatingTier;
  patchTier: PrRatingTier;
  overallTier: PrRatingTier;
  summary: string;
  nextSteps: string[];
}

export interface TelegramVisibleProof {
  status: TelegramVisibleProofStatus;
  summary: string;
}

export interface LiveProofPlan {
  status: LiveProofPlanStatus;
  surface: LiveProofSurface;
  terminalCompletion: LiveProofTerminalCompletion;
  invalid?: true;
  reason: string;
  payoff: {
    kind: LiveProofPayoffKind;
    justification: string;
  };
  entry: string;
  steps: LiveProofStep[];
}

export interface MantisRecommendation {
  status: MantisRecommendationStatus;
  scenario: MantisRecommendationScenario;
  reason: string;
  maintainerComment: string;
}

export interface FeatureShowcase {
  status: FeatureShowcaseStatus;
  reason: string;
}

export interface RootCauseClusterMember {
  ref: string;
  relationship: RootCauseRelationship;
  reason: string;
}

export interface RootCauseClusterAssessment {
  confidence: Confidence;
  canonicalRef: string | null;
  currentItemRelationship: RootCauseRelationship;
  summary: string;
  members: RootCauseClusterMember[];
}

export interface FixedPullRequest {
  repo: string;
  number: number;
  url: string;
  title: string;
  mergedAt: string | null;
  sha: string | null;
  confidence: Confidence;
  source: string;
}

/**
 * An untrusted, model-supplied pointer to one source line. It becomes public
 * provenance only after the runtime independently checks it.
 */
export interface RegressionProvenanceCandidate {
  repo: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  mergeCommitSha: string;
  sourcePath: string;
  sourceLine: number;
}

export interface VerifiedRegressionProvenance extends RegressionProvenanceCandidate {
  verificationSource: "raw_parent_line_v1";
  evidenceType: "blame_to_merge_commit";
  mergedAt: string;
  reviewedCommitSha: string;
  sourceCommitSha?: string;
  sourceAuthor?: string;
}

export interface SuspectedRegressionProvenance {
  verificationSource: "raw_parent_line_v1";
  evidenceType: "source_line" | "rewrite_equivalent";
  sourceCommitSha: string;
  sourceAuthor: string;
  sourcePath: string;
  sourceLine: number;
  relatedPullRequestNumber: number | null;
  relatedPullRequestUrl: string | null;
  relatedRepo: string | null;
}
export type PublicRegressionProvenance =
  | VerifiedRegressionProvenance
  | SuspectedRegressionProvenance;

/**
 * A non-blaming, preliminary regression signal. It intentionally cannot name
 * a predecessor; that requires VerifiedRegressionProvenance instead.
 */
export interface RegressionAssessment {
  confidence: "suspected" | "probable";
  supportingEvidence: RegressionSupportingEvidence[];
}

export type RegressionSupportingEvidence =
  | "reproduction"
  | "reviewed_change"
  | "failure_trace"
  | "known_regression_link";

export interface MergeRiskOption {
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

export interface LabelTransitionJustification {
  action: "add" | "remove";
  label: string;
  reason: string;
}

export interface ReviewMetric {
  label: string;
  value: string;
  reason: string;
}

export interface ReviewCommentRenderOptions {
  prStatusKind?: PrStatusLabelKind | null;
  previousLabels?: readonly string[];
  publishedLabels?: readonly string[];
  hasOpenLinkedPullRequest?: boolean;
  previousReviewCommentBody?: string;
  suppressAutomationMarkers?: boolean;
}

export interface Decision {
  decision: DecisionKind;
  closeReason: CloseReason;
  confidence: Confidence;
  summary: string;
  changeSummary: string;
  systemContext: string;
  architectureDiagram: string;
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
  liveProofPlan: LiveProofPlan;
  mantisRecommendation: MantisRecommendation;
  featureShowcase: FeatureShowcase;
  overallCorrectness: OverallCorrectness;
  overallConfidenceScore: number;
  /** Runner-owned repository inspection result. Never populated from model output. */
  localCheckoutAccess?: "verified" | "unverified";
  /** Runner-owned failure classification for scheduled infrastructure retries. */
  checkoutInspectionFailed?: boolean;
  codexTerminalFailure?: boolean;
  fixedRelease?: string | null;
  fixedSha?: string | null;
  fixedAt?: string | null;
  fixedPullRequest?: FixedPullRequest | null;
  regressionAssessment?: RegressionAssessment | null;
  regressionProvenance?:
    | RegressionProvenanceCandidate
    | VerifiedRegressionProvenance
    | SuspectedRegressionProvenance
    | null;
  closeComment: string;
  workCandidate: WorkCandidateKind;
  workConfidence: Confidence;
  workPriority: Confidence;
  workReason: string;
  nextStep?: NextStepAssessment;
  workPrompt: string;
  workClusterRefs: string[];
  workValidation: string[];
  workLikelyFiles: string[];
}

export interface AgentsPolicyStatus {
  found: boolean;
  readFully: boolean;
  applied: boolean;
  status: AgentsPolicyStatusKind;
  summary: string;
}

export type GoodFirstIssueHumanLabelState = "removed" | "added" | "unknown";

export interface CompleteActivityContext {
  comments: unknown[];
  timeline: unknown[];
  pullReviewComments: unknown[];
}

export interface ItemContext {
  [completeActivityContextSymbol]?: CompleteActivityContext;
  issue: unknown;
  comments: unknown[];
  timeline: unknown[];
  structuralItemStateDigest?: string;
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
  pullCommitsRevision?: string;
  pullReviewComments?: unknown[];
  pullReviewCommentsRevision?: string;
  pullReviewActivityCursor?: string;
  prHydrationSnapshot?: PrHydrationSnapshot;
  pullChecks?: unknown;
  bulkFiler?: BulkFilerReviewContext;
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

export interface LocalRelatedTitleEntry {
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

export interface Action {
  actionTaken: ActionTaken;
  closeComment: string;
}

export interface ReviewRuntime {
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

export interface ReviewPromptTelemetry {
  promptChars: number;
  staticPromptChars: number;
  contextChars: number;
  schemaChars: number;
  additionalPromptChars: number;
}

export interface ReviewPromptBuild {
  text: string;
  telemetry: ReviewPromptTelemetry;
}

export interface PreparedMediaProofArtifact {
  kind: "image" | "video" | "attachment";
  url: string;
  downloadedPath: string | null;
  metadataPath: string | null;
  contactSheetPath: string | null;
  status: "prepared" | "failed";
  detail: string;
}

export interface PreparedMediaProof {
  manifestPath: string | null;
  summaryPath: string | null;
  artifacts: PreparedMediaProofArtifact[];
}

export interface ReviewContextLedgerEntry {
  section: string;
  label: string;
  entries: number;
  chars: number;
  total?: number;
  hydrated?: number;
  truncated?: boolean;
}

export interface ReviewPromptRuntimeHints {
  networkCapability?: "allowlisted-proxy" | "unrestricted" | "none";
  hasGitHubToken?: boolean;
  targetDir?: string;
  proofScratchDir?: string;
  mediaProofManifestPath?: string;
  mediaProofSummary?: string;
}

export interface DashboardItem {
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

export interface DashboardClosedItem {
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  closedAt?: string | undefined;
  appliedAt: string | undefined;
  closeReason: string | undefined;
  reportPath: string;
}

export interface RepoOpenCountsQuery {
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

export interface OpenItemCounts {
  issues: number;
  pullRequests: number;
  total: number;
}

export interface DashboardKindStats {
  total: number;
  fresh: number;
  proposedClose: number;
}

export interface DashboardCadenceBucket {
  total: number;
  current: number;
  proposedClose: number;
}

export interface DashboardCadenceStats {
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

export interface DashboardActivityBucket {
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

export interface DashboardActivityStats {
  last15Minutes: DashboardActivityBucket;
  lastHour: DashboardActivityBucket;
  last24Hours: DashboardActivityBucket;
  latestReviewAt: string | undefined;
  latestCloseAt: string | undefined;
  latestCommentSyncAt: string | undefined;
}

export interface DashboardStats {
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

export interface WorkflowStatusSummary {
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

export interface RepoDashboardSnapshot {
  profile: RepositoryProfile;
  stats: DashboardStats;
  status: string;
  statusSummary: WorkflowStatusSummary;
  auditHealth: string;
}

export interface PlanShard {
  shard: number;
  itemNumbers: number[];
}

export interface PlanCandidateResult {
  shards: PlanShard[];
  scannedPages: number;
  candidates: Item[];
  capacity: number;
  dueBacklog: number;
  activeCodexTarget: number;
  oldestUnreviewedAt: string | undefined;
  capacityReason: string;
  floorBackfill: number;
  selection: PlanSelectionTelemetry[];
}

export interface PlanSelectionTelemetry {
  itemNumber: number;
  bucket: SchedulerDueCandidate["bucket"];
  coverageTracked: boolean;
  lastReviewedAt: string | null;
  ageMs: number;
  nextDueAt: string;
}

export type DueCandidate = SchedulerDueCandidate<Item, ExistingReview>;

export interface ApplyResult {
  repo?: string;
  number: number;
  action: ActionTaken;
  reason: string;
  mutationOccurred?: boolean;
  commentMutationOccurred?: boolean;
  durableReviewSynced?: boolean;
  terminalMissingVerified?: boolean;
  terminalStateVerified?: boolean;
  guardedOpenStateVerified?: boolean;
  activeReviewLeaseVerified?: boolean;
  activeReviewLeaseExpiresAt?: string;
  terminalPolicyNoopVerified?: boolean;
  sourceDriftVerified?: boolean;
  newerReviewTupleVerified?: boolean;
}

export interface FailedReviewRetryResult {
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

export interface FailedReviewRetryState {
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

export interface ReconcileResult {
  openItemsSeen: number;
  pagesScanned: number;
  movedToClosed: number;
  movedToItems: number;
  removedStaleClosedCopies: number;
  fetchedClosedAt: number;
  changedItemNumbers: number[];
  changedRecordFiles: string[];
  deferred?: { reason: "github_rate_limited"; retryAt: string };
}

export type AuditRecordLocation = "items" | "closed";
export type MissingOpenReason =
  | "eligible"
  | "maintainer_authored"
  | "protected_label"
  | "recently_created";

export interface AuditRecord {
  repo: string;
  number: number;
  location: AuditRecordLocation;
  path: string;
  kind: ItemKind | undefined;
  title: string;
  labels: string[];
  decision: string | undefined;
  closeReason: string | undefined;
  confidence?: string | undefined;
  reviewedAt?: string | undefined;
  action: string | undefined;
  reviewStatus: string;
  currentState: string | undefined;
}

export interface AuditFinding {
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
  confidence?: string;
  reviewedAt?: string;
  reviewStatus?: string;
  currentState?: string;
}

export interface AuditResult {
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
    autoCloseOpen: number;
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
    autoCloseOpen: AuditFinding[];
    staleReviews: AuditFinding[];
  };
}

export type ReviewArtifactDestination = "items" | "closed" | "skip_closed";

export interface GitHubRuntimeBudget {
  startedAtMs: number;
  maxRuntimeMs: number;
  limitReason?: string;
  onYield?: (reason: string, resumeCurrent?: boolean) => void;
  onFailure?: (error: unknown) => void;
  yieldReason?: string;
}

export type GitHubRetryOptions = {
  request?: ((args: string[], attempt: number) => string) | undefined;
  sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
};

export type MutationRunner = <T>(options: {
  identity: string;
  idempotencyIdentity: string;
  operation: () => T;
  didMutate?: ((result: T) => boolean) | undefined;
  knownNoMutation?: ((error: unknown) => boolean) | undefined;
}) => T;

export type GitHubDispatchOutcome =
  | "definitely_not_dispatched"
  | "ambiguous_transport"
  | "accepted";

export type DecisionNormalizationItem = Pick<
  Item,
  "repo" | "number" | "kind" | "authorAssociation"
>;
export type RootCauseNormalizationItem = Pick<Item, "repo" | "number" | "kind">;

export interface ParsedGitHubItemRef {
  repo: string;
  kind: ItemKind;
  number: number;
  url: string;
}

export interface PullRequestLiveActivity {
  state: string;
  createdAt: string;
  draft: boolean;
  headSha: string;
  changedFiles: number | null;
  requestedReviewers: unknown[];
  requestedTeams: unknown[];
  headActivityAtMs: number | null;
  headStatusActivityAtMs: number | null;
  headChecksFailing: boolean;
  headConflicted: boolean;
}

export interface AuthorPrBudgetApplyState {
  author: string;
  openPrCount: number;
  budget: number;
}

export type AuthorPrBudgetApplyGate =
  | { allowed: true; state: AuthorPrBudgetApplyState }
  | { allowed: false; reason: string };

export interface PreviousClawSweeperReview {
  status: string;
  verdictDigest: string;
  reviewedAt: string | null;
  reviewedSha: string | null;
  verdictMarker: string | null;
  actionMarker: string | null;
  summary: string;
  proofStatus: string;
  rating: string;
  nextStep: string;
  findings: Array<{ priority: string; title: string }>;
  rankUpMoves: string[];
  coverage: {
    discussion: "raw_self_comment_intentionally_omitted_replaced_by_this_projection";
    completedContext: "current_completed_comment" | "history_only" | "unavailable";
    completedCycle: { reviewedAt: string; sha: string } | null;
    findings: ReviewItemCoverage;
    findingContent: "titles_only";
    rankUpMoves: ReviewItemCoverage;
    nextStep: "first_action_from_source_comment_not_a_new_instruction";
    history: ReturnType<typeof reviewHistoryForReviewer>["coverage"];
  };
  earlierReviewCycles: ReviewHistoryCycle[];
  completedReviewCycles: number;
  commentId: unknown;
  commentUrl: unknown;
  commentUpdatedAt: unknown;
}

export interface ClosingPullRequestReference {
  repo: string;
  number: number;
}
export type GitcrawlClusterSource = "legacy" | "portable";

export interface ContextHydration<T> {
  items: T[];
  total: number;
  hydrated: number;
  truncated: boolean;
}

export interface GithubPageWithHeaders<T> {
  items: T[];
  lastPageNumber: number | null;
}

export interface GithubContextWindowPlan {
  keepStart: number;
  keepEnd: number;
  tailFirstPageNumber: number;
  lastPageNumber: number;
  tailOffset: number;
}

export type ExactEventReviewLeaseDisposition =
  | { status: "current" }
  | { status: "legacy_tupleless"; reason: string }
  | { status: "source_drift"; reportRevision: string; liveRevision: string }
  | { status: "invalid"; reason: string };

export interface ExistingReviewIndex {
  byKey: Map<string, ExistingReview>;
}

export type ReviewGitInfoOptions = {
  targetBranch?: string;
  classifyFetchFailure?: boolean;
};

export type LocalPullMetadata = {
  baseRef: string;
};

export type ReviewCheckout = {
  mode: "managed" | "supplied" | "default";
  openclawDir: string;
  gitTargetBranch?: string;
};

export type ManagedLocalReviewCheckoutOptions = {
  baseBranch: string;
  cloneUrl?: string;
  itemNumber: number;
  targetDir: string;
  targetRepo: string;
  verbose?: boolean | undefined;
};

export type MediaProofCommandRunner = (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    killSignal?: NodeJS.Signals;
  },
) => {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

export interface FileModeSnapshot {
  path: string;
  mode: number;
}

export type PublicPriority = "P0" | "P1" | "P2";

export interface ConfigSurfaceChange {
  change: boolean;
  keys: string[];
}

export interface DataModelChange {
  change: boolean;
  surfaces: string[];
}

export interface SqliteSchemaChange {
  change: boolean;
  files: string[];
}

export interface IssueAdvisoryLabelState {
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

export interface PullRequestClosePromotion {
  closeReason: CloseReason;
  summary: string;
  bestSolution: string;
  evidence: string;
  closeComment: string;
  coverageProofFallbackRefs: boolean;
}

export interface LinkedPullRequestSupersession {
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

export interface LinkedPullRequestSupersessionResolution {
  candidate: LinkedPullRequestSupersession | null;
  unsafeReason: string | null;
}

export type PullRequestRefKind = "pull_url" | "same_repo_shorthand" | "bare";

export interface PullRequestRef {
  number: number;
  kind: PullRequestRefKind;
}

export interface CanonicalPullRequestCommentSyncBlock {
  kind: "closed_unmerged" | "unreadable";
  number: number;
  reason: string;
}

export interface PrCloseCoverageProofGateBlock {
  actionTaken: ActionTaken;
  reason: string;
}

export interface PrCloseCoverageProofCoveringWitness {
  number: number;
  provedAtMs: number;
  snapshotSha256: string;
  updatedAt: string | null;
  url: string;
  proof: PrCloseCoverageProofModelResult;
}

export type PrCloseCoverageProofGateResult =
  | { status: "allowed"; covering: PrCloseCoverageProofCoveringWitness }
  | { status: "blocked"; block: PrCloseCoverageProofGateBlock }
  | null;

export interface PrCloseCoverageRuntimeBudget {
  startedAtMs: number;
  maxRuntimeMs: number;
}

export type PullRequestReviewState = "ready" | "blocked" | "needs-changes";

export interface PublicBeforeMergeItem {
  label: string;
  detail: string;
  state: Exclude<PullRequestReviewState, "ready">;
}

export interface PullRequestReviewReadiness {
  headSha: string | null;
  state: PullRequestReviewState;
  items: PublicBeforeMergeItem[];
  normalizationFailed: boolean;
}

export type StalePullRequestReviewHead = {
  reportHeadSha: string;
  liveHeadSha: string;
  reason: string;
};

export type ReviewLedgerItem = {
  item: Item;
  index: number;
  started: boolean;
  startedAtMs: number | null;
  startEventId: string | null;
  lastEventId: string | null;
  logPublication: boolean;
  mutationAttemptCount: number;
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
  terminal: boolean;
};

export type ReviewActionLedger = {
  operationIdentity: {
    repository: string;
    reviewPolicy: string;
    shardIndex: number;
    shardCount: number;
    candidateSnapshots: Array<{
      repository: string;
      number: number;
      kind: ItemKind;
      updatedAt: string;
    }>;
  };
  batchStartEventId: string | null;
  items: Map<string, ReviewLedgerItem>;
  nextPhaseSeq: number;
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
  startedAtMs: number;
  terminal: boolean;
};

export type ReviewMutationAttempt = {
  state: ReviewLedgerItem;
  eventId: string | null;
  idempotencyIdentity: {
    operation: "review";
    slot: "coordination_mutation";
    repository: string;
    number: number;
    itemUpdatedAt: string;
    mutationIdentitySha256: string;
  };
  mutationIndex: number;
  receiptIdentitySha256: string;
};

export interface ExpectedIssueSourceRevisionOptions {
  expectedSourceRevision: string;
  itemKind: "issue" | "pull_request";
  repo: string;
  number: number;
  sourceRevision: string | undefined;
  artifactDir: string;
}

export type ReviewRetryActionLedger = {
  operationIdentity: {
    repository: string;
    requestedItemNumbers: number[];
    reportPath: string;
  };
  batchStartEventId: string | null;
  dispatchAttempts: Map<
    string,
    {
      eventId: string | null;
      phaseSeq: number;
    }
  >;
  nextDispatchPhaseSeq: number;
  startedAtMs: number;
  terminal: boolean;
};

export type ApplyItemBusinessIdempotencyIdentity = {
  operation: "apply";
  slot: "apply_item" | "apply_mutation" | "review_comment";
  repository: string;
  number: number;
  sourceRevision: string;
  reviewContentDigest: string;
  decisionPacketSha256: string;
};

export type ApplyMutationBusinessIdempotencyIdentity = ApplyItemBusinessIdempotencyIdentity & {
  slot: "apply_mutation";
  mutationIdentitySha256: string;
};

export type ApplyLedgerItem = {
  entry: ReportEntry;
  index: number;
  started: boolean;
  startEventId: string | null;
  lastEventId: string | null;
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
  mutationEventId: string | null;
  mutationAttemptCount: number;
  terminal: boolean;
  businessIdentity: Omit<ApplyItemBusinessIdempotencyIdentity, "slot">;
};

export type ApplyActionLedger = {
  operationIdentity: {
    repository: string;
    applyKind: ApplyKind;
    closeReasons: string[];
    dryRun: boolean;
    syncCommentsOnly: boolean;
    requestedItemNumbers: number[];
    reportPath: string;
    checkpoint: string;
    candidateRevisions: Array<{
      repository: string;
      number: number;
      sourceRevision: string;
      reviewContentDigest: string;
      decisionPacketSha256: string;
    }>;
  };
  batchStartEventId: string | null;
  items: Map<string, ApplyLedgerItem>;
  startedAtMs: number;
  nextPhaseSeq: number;
  terminal: boolean;
};

export type ApplyPhaseCursor = {
  nextPhaseSeq: number;
};

export type ApplyMutationAttempt = {
  state: ApplyLedgerItem;
  eventId: string | null;
  idempotencyIdentity: ApplyMutationBusinessIdempotencyIdentity;
  mutationIndex: number;
  receiptIdentitySha256: string;
};

export interface ReportEntry {
  name: string;
  number: number;
  path: string;
  repo: string;
  markdown: string;
}

export interface AssistSourceCommentSnapshot {
  id: string;
  issueUrl: string;
  htmlUrl: string;
  author: string;
  body: string;
  updatedAt: string;
}

export interface LiveAssistBinding {
  item: Item;
  context: ItemContext;
  sourceComment: AssistSourceCommentSnapshot | null;
}
