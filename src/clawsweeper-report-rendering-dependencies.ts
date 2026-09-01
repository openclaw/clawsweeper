import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import type {
  ActionTaken,
  AgentsPolicyStatus,
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
  MantisRecommendation,
  MergeRiskOption,
  OverallCorrectness,
  PrRating,
  PublicPriority,
  RegressionAssessment,
  PublicRegressionProvenance,
  ReviewCommentRenderOptions,
  ReviewFinding,
  ReviewMetric,
  RootCauseClusterAssessment,
  SecurityConcern,
  SecurityReview,
  TriagePriority,
} from "./clawsweeper-types.js";
import type { AttachedLiveVerification } from "./live-proof/verification.js";
import { type PrSurfaceFile } from "./pr-surface-stats.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";

export interface CreateReportRenderingDependencies {
  agentsPolicyStatusLine: (status: AgentsPolicyStatus | undefined) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
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
  normalizeEvidence: (entry: Evidence) => Evidence;
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
  frontMatterStringArray: (markdown: string, key: string) => string[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
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
  isActionablePriorityText: (text: string) => boolean;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isReportNoneList: (value: string) => boolean;
  isRoutineCiOrReviewText: (text: string) => boolean;
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
  likelyOwnerLine: (owner: LikelyOwner) => string;
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
  markdownLink: (label: string, url: string) => string;
  markdownRepository: (markdown: string, file?: string) => string;
  mergeRiskOptionsFromReport: (markdown: string) => MergeRiskOption[];
  neutralizeOwnedSectionSpoofing: (value: string) => string;
  normalizePublicReviewText: (value: string) => string;
  priorityLabel: (priority: ReviewFinding["priority"]) => string;
  prSurfaceFilesFromContext: (context: ItemContext) => PrSurfaceFile[] | null;
  publicFailedReviewReadinessBlock: (markdown: string) => string;
  publicHistoricalVerificationBlockerLine: () => string;
  publicLikelyOwnerRole: (role: string) => string;
  publicMantisRecommendationBlock: (recommendation: MantisRecommendation) => string;
  publicMergeReadinessBlock: (
    rating: PrRating,
    policy: RealBehaviorProofPolicy,
    priority: TriagePriority,
    bottomLine: string,
    remainingItemCount: number,
    decisionNeeded: boolean,
    reviewedHeadSha: string,
  ) => string;
  publicNonDispatchableMantisRecommendationBlock: (recommendation: MantisRecommendation) => string;
  publicPriorityBulletFromText: (text: string, fallback: PublicPriority) => string;
  publicPriorityBulletIfActionable: (text: string, fallback: PublicPriority) => string;
  publicPriorityFromText: (text: string, fallback: PublicPriority) => PublicPriority;
  publicRankDetailsBlock: () => string;
  publicRealBehaviorProofLine: (policy: RealBehaviorProofPolicy) => string;
  publicReviewScoresBlock: (
    rating: PrRating,
    policy: RealBehaviorProofPolicy,
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  publicReviewTextDiffers: (left: string, right: string) => boolean;
  publicReviewTextIsSame: (left: string, right: string) => boolean;
  publicRiskBulletsFromText: (text: string, fallback: PublicPriority) => string;
  publicSecurityReviewLine: (review: SecurityReview) => string;
  publicVerificationBlock: (
    policy: RealBehaviorProofPolicy,
    evidence: readonly Evidence[],
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  pullHeadShaFromReport: (markdown: string) => string | null;
  renderDataModelWarningFromReport: (markdown: string) => string;
  renderSqliteSchemaWarningFromReport: (markdown: string) => string;
  renderOpenClawPrSurfaceFromReport: (markdown: string) => string;
  renderReviewMetricsDigest: (metrics: readonly ReviewMetric[]) => string;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  repoRelativePath: (path: string) => string;
  reportAgentsPolicyStatus: (markdown: string) => AgentsPolicyStatus | undefined;
  reportEvidence: (markdown: string) => Evidence[];
  reportLikelyOwners: (markdown: string) => LikelyOwner[];
  reportLiveProofRecordingBlock: (markdown: string) => string;
  reportMantisRecommendation: (markdown: string) => MantisRecommendation;
  reportOverallConfidenceScore: (markdown: string) => number;
  reportOverallCorrectness: (markdown: string) => OverallCorrectness;
  reportPrRating: (markdown: string) => PrRating;
  reportRealBehaviorProofPolicy: (markdown: string) => RealBehaviorProofPolicy;
  reportAttachedLiveVerification: (markdown: string) => AttachedLiveVerification;
  reportReviewFindings: (markdown: string) => ReviewFinding[];
  reportRootCauseCluster: (markdown: string) => RootCauseClusterAssessment;
  reportSecurityReview: (markdown: string) => SecurityReview;
  reviewAutomationMarkersFromReport: (markdown: string) => string;
  reviewFindingDetailedLine: (finding: ReviewFinding) => string;
  reviewFindingLocation: (finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">) => string;
  reviewFindingSummaryLine: (finding: ReviewFinding) => string;
  reviewMetricsFromReport: (markdown: string) => ReviewMetric[];
  reviewSectionValue: (
    markdown: string,
    section:
      | "summary"
      | "changeSummary"
      | "systemContext"
      | "architectureDiagram"
      | "bestSolution"
      | "maintainerDecision"
      | "reproductionAssessment"
      | "solutionAssessment"
      | "visionFit"
      | "rootCauseCluster"
      | "reviewFindings"
      | "securityReview"
      | "realBehaviorProof"
      | "prRating"
      | "telegramVisibleProof"
      | "mantisRecommendation"
      | "featureShowcase"
      | "agentsPolicyStatus"
      | "workCandidate"
      | "repairWorkPrompt"
      | "evidence"
      | "likelyOwners"
      | "risks"
      | "closeComment",
  ) => string;
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  sanitizeArchitectureDiagram: (value: string) => string;
  securityConcernDetailedLine: (concern: SecurityConcern) => string;
  securityConcernLocation: (concern: SecurityConcern) => string;
  securityConcernSummaryLine: (concern: SecurityConcern) => string;
  securityReviewLine: (review: SecurityReview) => string;
  sentence: (value: string) => string;
  sha256: (text: string) => string;
  shouldRenderWorkPlanFromReport: (markdown: string) => boolean;
  splitFileAndLine: (file: string, explicitLine?: number | null) => { file: string; line?: number };
  stripPriorityPrefix: (text: string) => string;
  targetRepo: () => string;
  triagePriorityFromReport: (markdown: string) => TriagePriority;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workCandidateReasonText: (section: string) => string;
  workPlanPathForReport: (file: string, plansDir?: string) => string;
  workStatusForDecision: (decision: Decision) => string;
}
