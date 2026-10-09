import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import type {
  ActionTaken,
  CloseReason,
  Decision,
  Evidence,
  FixedPullRequest,
  Item,
  ItemContext,
  ItemKind,
  LabelJustification,
  LabelTransitionJustification,
  LikelyOwner,
  PrRating,
  PullRequestReviewReadiness,
  PullRequestReviewState,
  RegressionAssessment,
  PublicRegressionProvenance,
  ReviewCommentRenderOptions,
  ReviewFinding,
  ReviewMetric,
  SecurityConcern,
  SecurityReview,
  TriagePriority,
} from "./clawsweeper-types.js";
import { type PrSurfaceFile } from "./pr-surface-stats.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";

export interface CreateReportRenderingDependencies {
  closeClawHubHandoffBlock: (reason: CloseReason) => string;
  closeEvidenceLine: (evidence: Evidence) => string;
  closeIntro: (reason: CloseReason) => string;
  closeOutro: (reason: CloseReason, canonicalLinks?: string[]) => string;
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
    },
  ) => ItemContext;
  compactPullFilePaths: (value: unknown) => string[];
  confidenceText: (score: number) => string;
  duplicateCanonicalLinks: (options: {
    reason: CloseReason;
    bestSolutionLine: string;
    evidence: Evidence[];
    currentItem?: { repo?: string; kind?: ItemKind; number?: number } | undefined;
  }) => string[];
  duplicateCanonicalPathLine: (options: {
    reason: CloseReason;
    summaryLine: string;
    bestSolutionLine: string;
    evidence: Evidence[];
  }) => string;
  ensureDir: (path: string) => void;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  fixedInReportText: (markdown: string) => string;
  fixedInText: (decision: Decision) => string;
  fixedPullRequestFromReport: (markdown: string) => FixedPullRequest | null;
  regressionAssessmentFromReport: (markdown: string) => RegressionAssessment | null;
  regressionProvenanceFromReport: (markdown: string) => PublicRegressionProvenance | null;
  formatReviewFreshnessTimestamp: (iso: string | undefined) => string;
  formattedMarkdownList: (
    values: readonly string[],
    formatter: (value: string) => string,
  ) => string;
  formatTimestamp: (iso: string | undefined) => string;
  ghJson: <T>(args: string[]) => T;
  ghObservedMutationCommand: (options: {
    identity: string;
    args: string[];
    attempts?: number | undefined;
    onMutation?: (() => void) | undefined;
    didMutate?: ((result: string) => boolean) | undefined;
    knownNoMutation?: ((error: unknown) => boolean) | undefined;
    request?: ((args: string[], attempt: number) => string) | undefined;
    prepareRequest?: ((args: string[], attempt: number) => () => string) | undefined;
    sleepBeforeRetry?: ((waitMs: number) => void) | undefined;
  }) => string;
  hasUsableCloseComment: (closeComment: string) => boolean;
  inlineCode: (value: string) => string;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isReportNoneList: (value: string) => boolean;
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  jsonFrontMatterValue: (value: readonly unknown[]) => string;
  labelJustificationsFromPublicReport: (
    markdown: string,
    options?: ReviewCommentRenderOptions,
  ) => LabelJustification[];
  labelJustificationsMarkdown: (justifications: readonly LabelJustification[]) => string;
  labelTransitionJustificationsFromPublicReport: (
    markdown: string,
    finalJustifications: readonly LabelJustification[],
    options?: ReviewCommentRenderOptions,
  ) => LabelTransitionJustification[];
  labelTransitionJustificationsMarkdown: (
    justifications: readonly LabelTransitionJustification[],
  ) => string;
  likelyOwnerLines: (owners: readonly LikelyOwner[]) => string[];
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  normalizePublicReviewText: (value: string) => string;
  priorityLabel: (priority: ReviewFinding["priority"]) => string;
  prSurfaceFilesFromContext: (context: ItemContext) => PrSurfaceFile[] | null;
  publicFailedReviewReadinessBlock: (markdown: string) => string;
  publicHistoricalVerificationBlockerLine: () => string;
  publicMergeReadinessBlock: (
    reviewState: PullRequestReviewState,
    priority: TriagePriority,
    bottomLine: string,
    remainingItemCount: number,
    decisionNeeded: boolean,
    reviewedHeadSha: string,
  ) => string;
  publicRankScaleLine: () => string;
  publicRealBehaviorProofLine: (policy: RealBehaviorProofPolicy) => string;
  publicReviewScoresBlock: (
    rating: PrRating,
    policy: RealBehaviorProofPolicy,
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  publicReviewTextDiffers: (left: string, right: string) => boolean;
  publicReviewTextIsSame: (left: string, right: string) => boolean;
  publicRiskBullets: (text: string) => string;
  publicSecurityReviewLine: (review: SecurityReview) => string;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  renderOpenClawPrSurfaceFromReport: (markdown: string) => string;
  renderReviewMetricsDigest: (metrics: readonly ReviewMetric[]) => string;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  repoRelativePath: (path: string) => string;
  reportRealBehaviorProofPolicy: (markdown: string) => RealBehaviorProofPolicy;
  reportRiskEntries: (text: string) => string[];
  reviewAutomationMarkersFromReport: (
    markdown: string,
    readiness?: PullRequestReviewReadiness,
  ) => string;
  reviewFindingDetailedLine: (finding: ReviewFinding) => string;
  reviewFindingLocation: (finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">) => string;
  reviewFindingSummaryLine: (finding: ReviewFinding) => string;
  reviewMetricsFromReport: (markdown: string) => ReviewMetric[];
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  securityConcernDetailedLine: (concern: SecurityConcern) => string;
  securityConcernLocation: (concern: SecurityConcern) => string;
  securityConcernSummaryLine: (concern: SecurityConcern) => string;
  securityReviewLine: (review: SecurityReview) => string;
  sentence: (value: string) => string;
  shouldRenderWorkPlanFromReport: (markdown: string) => boolean;
  stripListMarker: (text: string) => string;
  targetRepo: () => string;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workCandidateReasonText: (section: string) => string;
  workPlanPathForReport: (file: string, plansDir?: string) => string;
  workStatusForDecision: (decision: Decision) => string;
}
