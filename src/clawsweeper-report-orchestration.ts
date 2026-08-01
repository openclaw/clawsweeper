import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hasDataModelUpgradeProof, isDocsPath } from "./clawsweeper-change-detection.js";
import { createLabelSynchronization } from "./clawsweeper-label-sync.js";
import {
  AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS,
  FEATURE_SHOWCASE_LABEL,
  FEATURE_SHOWCASE_LABEL_DESCRIPTION,
  IMPACT_LABEL_NAMES,
  MATURITY_LABEL_NAMES,
  MERGE_RISK_LABEL_NAMES,
  PR_CLOSE_COVERAGE_PROOF_SECTION,
  PR_RATING_LABEL_NAMES,
  PR_STATUS_LABEL_NAMES,
  PR_STATUS_LABELS,
  PRIORITY_LABEL_NAMES,
  PROOF_MEDIA_LABEL_NAMES,
  PROOF_MEDIA_LABELS,
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
  PROOF_SUFFICIENT_LABEL_DESCRIPTION,
  REVIEW_SECTIONS,
  TELEGRAM_VISIBLE_PROOF_LABEL,
  TELEGRAM_VISIBLE_PROOF_LABEL_DESCRIPTION,
} from "./clawsweeper-policy.js";
import { createPullRequestReferenceParser } from "./clawsweeper-pr-references.js";
import { nextPrRatingLabels, ratingLabelForTier, themedRatingName } from "./clawsweeper-rating.js";
import { createReportRendering } from "./clawsweeper-report-rendering.js";
import type {
  ActionTaken,
  AgentsPolicyStatus,
  AuthorPrBudgetApplyState,
  AutoImplementationCandidate,
  CanonicalPullRequestCommentSyncBlock,
  CloseReason,
  CompleteActivityContext,
  Confidence,
  ContextHydration,
  Decision,
  Evidence,
  FeatureShowcase,
  FixedPullRequest,
  GithubPageWithHeaders,
  GitHubUser,
  ImpactLabelName,
  ImplementationComplexity,
  IssueAdvisoryLabelState,
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
  MaturityLabelName,
  MergeRiskLabelName,
  MergeRiskOption,
  OverallCorrectness,
  ParsedGitHubItemRef,
  PrCloseCoverageProofCoveringWitness,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
  PrCloseCoverageRuntimeBudget,
  PrRating,
  PrStatusLabelKind,
  PublicPriority,
  PullRequestClosePromotion,
  PullRequestLiveActivity,
  PullRequestRef,
  RealBehaviorProof,
  ReproductionStatus,
  ReviewCommentRenderOptions,
  ReviewFinding,
  ReviewMetric,
  RootCauseClusterAssessment,
  SecurityConcern,
  SecurityReview,
  TelegramVisibleProof,
  TriagePriority,
  VisionFitStatus,
  WorkCandidateKind,
} from "./clawsweeper-types.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import { emptyMaintainerDecision, maintainerDecisionFromReport } from "./decision-packets.js";
import { ideaRevivalReactionThreshold } from "./idea-archive-revival.js";
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
  buildOpenClawPrSurfaceStats,
  renderOpenClawPrSurfaceSummary,
  renderOpenClawPrSurfaceTable,
  type PrSurfaceFile,
} from "./pr-surface-stats.js";
import { normalizeRepo, type RepositoryProfile } from "./repository-profiles.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";

interface CreateReportOrchestrationDependencies {
  agentsPolicyStatusLine: (status: AgentsPolicyStatus | undefined) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
  closeEvidenceLine: (evidence: Evidence) => string;
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
  defaultAgentsPolicyStatus: () => AgentsPolicyStatus;
  defaultPlansDir: (profile?: RepositoryProfile) => string;
  defaultRootCauseCluster: () => RootCauseClusterAssessment;
  effectiveReviewStatus: (markdown: string) => string;
  ensureDir: (path: string) => void;
  eventTimestampMs: (value: unknown) => number | null;
  fileUrl: (file: string, sha: string, line?: number) => string;
  filterReviewContextComments: (
    comments: readonly unknown[],
    number: number,
  ) => { included: unknown[]; filtered: number };
  fixedInReportText: (markdown: string) => string;
  fixedInText: (decision: Decision) => string;
  fixedPullRequestFromReport: (markdown: string) => FixedPullRequest | null;
  formatReviewFreshnessTimestamp: (iso: string | undefined) => string;
  formatTimestamp: (iso: string | undefined) => string;
  frontMatterBoolean: (markdown: string, key: string) => boolean;
  frontMatterJsonArray: (markdown: string, key: string) => unknown[];
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
  ghPaged: <T>(path: string) => T[];
  ghPagedContextWindow: <T>(
    path: string,
    totalCount: unknown,
    promptLimit: number,
    fetchers?: { page?: (path: string, page: number) => T[]; paged?: (path: string) => T[] },
  ) => ContextHydration<T>;
  ghPagedLinkHeaderContextWindow: <T>(
    path: string,
    promptLimit: number,
    fetchers?: {
      pageWithHeaders?: (path: string, page: number, perPage: number) => GithubPageWithHeaders<T>;
      paged?: (path: string) => T[];
    },
  ) => ContextHydration<T>;
  GitHubRuntimeBudgetError: new (reason: string) => Error & { readonly reason: string };
  hasUsableCloseComment: (closeComment: string) => boolean;
  impactLabelsFromReport: (markdown: string) => ImpactLabelName[];
  isActionablePriorityText: (text: string) => boolean;
  isAfterReview: (value: unknown, reviewedAtMs: number | null) => boolean;
  isAutomationReportAuthor: (author: string | undefined) => boolean;
  isBulkFilerExemptAuthorAssociation: (value: unknown) => boolean;
  isBulkFilerExemptRepositoryPermission: (value: unknown) => boolean;
  isDigitsOnly: (value: string) => boolean;
  isDocsOnlyPullRequestReport: (markdown: string) => boolean;
  isExternalPullRequestReport: (markdown: string) => boolean;
  isFresh: (
    review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
  ) => boolean;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isIssueAdvisoryLabel: (label: string) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isOlderThanDays: (isoTimestamp: string, days: number, now?: number) => boolean;
  isReportNoneList: (value: string) => boolean;
  isRoutineCiOrReviewText: (text: string) => boolean;
  issueAdvisoryLabelStateFromReport: (
    markdown: string,
    options?: {
      goodFirstIssueOptedOut?: boolean;
      hasOpenLinkedPullRequest?: boolean;
      locked?: boolean;
    },
  ) => IssueAdvisoryLabelState;
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  itemSnapshotHash: (item: Item, context: ItemContext) => string;
  jsonFrontMatterValue: (value: readonly unknown[]) => string;
  labelJustificationsFromReport: (
    markdown: string,
    labels: Pick<
      Decision,
      "triagePriority" | "impactLabels" | "mergeRiskLabels" | "maturityLabels"
    >,
  ) => LabelJustification[];
  labelNames: (value: unknown) => string[];
  labelPolicy: {
    eventTimestampMs: (value: unknown) => number | null;
    featureShowcaseLabelsForTest: (
      labels: readonly string[],
      options: {
        isPullRequest?: boolean;
        itemCategory?: string;
        requiresNewFeature?: boolean;
        status?: string;
        securityReviewStatus?: string;
        overallCorrectness?: string;
      },
    ) => string[];
    hasRepairLoopPauseLabel: (labels: readonly string[]) => boolean;
    isAfterReview: (value: unknown, reviewedAtMs: number | null) => boolean;
    nextFeatureShowcaseLabels: (
      labels: readonly string[],
      options: {
        isPullRequest: boolean;
        itemCategory: string | undefined;
        requiresNewFeature: boolean;
        showcase: FeatureShowcase;
        securityReview: Pick<SecurityReview, "status">;
        overallCorrectness: OverallCorrectness;
      },
    ) => string[];
    nextPrStatusLabels: (
      labels: readonly string[],
      statusKind: PrStatusLabelKind | null,
    ) => string[];
    prStatusLabelForKind: (kind: PrStatusLabelKind) => (typeof PR_STATUS_LABELS)[number];
    prStatusLabelKindFromReport: (
      markdown: string,
      context: ItemContext,
      currentLabels: readonly string[],
    ) => PrStatusLabelKind | null;
    prStatusLabelsForTest: (
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
    ) => string[];
    prStatusLabelSchemeForTest: () => {
      kind: PrStatusLabelKind;
      name: string;
      color: string;
      description: string;
    }[];
    shouldApplyFeatureShowcaseLabel: (options: {
      isPullRequest: boolean;
      itemCategory: string | undefined;
      requiresNewFeature: boolean;
      showcase: FeatureShowcase;
      securityReview: Pick<SecurityReview, "status">;
      overallCorrectness: OverallCorrectness;
    }) => boolean;
  };
  likelyOwnerLine: (owner: LikelyOwner) => string;
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string) => string;
  lowSignalUnmergeablePrAuthorActivityBlockReason: (options: {
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
  }) => string | null;
  lowSignalUnmergeablePrConflictBlockReason: (pullValue: unknown) => string | null;
  markdownLink: (label: string, url: string) => string;
  markdownRepository: (markdown: string, file?: string) => string;
  maturityLabelsFromReport: (markdown: string) => MaturityLabelName[];
  mergeRiskLabelsFromReport: (markdown: string) => MergeRiskLabelName[];
  mergeRiskOptionsFromReport: (markdown: string) => MergeRiskOption[];
  neutralizeOwnedSectionSpoofing: (value: string) => string;
  nextFeatureShowcaseLabels: (
    labels: readonly string[],
    options: {
      isPullRequest: boolean;
      itemCategory: string | undefined;
      requiresNewFeature: boolean;
      showcase: FeatureShowcase;
      securityReview: Pick<SecurityReview, "status">;
      overallCorrectness: OverallCorrectness;
    },
  ) => string[];
  nextImpactLabels: (
    labels: readonly string[],
    impactLabels: readonly ImpactLabelName[],
  ) => string[];
  nextIssueAdvisoryLabels: (labels: readonly string[], state: IssueAdvisoryLabelState) => string[];
  nextMaturityLabels: (
    labels: readonly string[],
    maturityLabels: readonly MaturityLabelName[],
  ) => string[];
  nextMergeRiskLabels: (
    labels: readonly string[],
    mergeRiskLabels: readonly MergeRiskLabelName[],
  ) => string[];
  nextPriorityLabels: (labels: readonly string[], triagePriority: TriagePriority) => string[];
  nextPrStatusLabels: (labels: readonly string[], statusKind: PrStatusLabelKind | null) => string[];
  nextRealBehaviorProofMediaLabels: (
    labels: readonly string[],
    proof: Pick<RealBehaviorProof, "evidenceKind">,
  ) => string[];
  nextRealBehaviorProofSufficientLabels: (
    labels: readonly string[],
    proof: Pick<RealBehaviorProof, "status">,
  ) => string[];
  nextTelegramVisibleProofLabels: (
    labels: readonly string[],
    proof: Pick<TelegramVisibleProof, "status">,
  ) => string[];
  normalizeLabelName: (label: string) => string;
  normalizePublicReviewText: (value: string) => string;
  numberOrUndefined: (value: unknown) => number | undefined;
  parseGitHubItemRef: (value: string, path: string) => ParsedGitHubItemRef;
  priorityLabel: (priority: ReviewFinding["priority"]) => string;
  protectedLabels: (labels: readonly string[]) => string[];
  prStatusLabelForKind: (kind: PrStatusLabelKind) => (typeof PR_STATUS_LABELS)[number];
  prStatusLabelKindFromReportLabels: (markdown: string) => PrStatusLabelKind | null;
  publicFailedReviewReadinessBlock: (markdown: string) => string;
  publicLikelyOwnerRole: (role: string) => string;
  publicMantisRecommendationBlock: (recommendation: MantisRecommendation) => string;
  publicMergeReadinessBlock: (
    rating: PrRating,
    proof: RealBehaviorProof,
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
  publicRealBehaviorProofLine: (proof: RealBehaviorProof) => string;
  publicReviewScoresBlock: (
    rating: PrRating,
    proof: RealBehaviorProof,
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  publicReviewTextDiffers: (left: string, right: string) => boolean;
  publicReviewTextIsSame: (left: string, right: string) => boolean;
  publicRiskBulletsFromText: (text: string, fallback: PublicPriority) => string;
  publicSecurityReviewLine: (review: SecurityReview) => string;
  publicTableCell: (value: string) => string;
  publicVerificationBlock: (
    proof: RealBehaviorProof,
    evidence: readonly Evidence[],
    findings: readonly ReviewFinding[],
    securityReview: SecurityReview,
  ) => string;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  pullHeadShaFromReport: (markdown: string) => string | null;
  pullRequestHeadActivity: (
    number: number,
    pull: {
      created_at?: string;
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    },
    timeline?: unknown[],
  ) => Pick<PullRequestLiveActivity, "headSha" | "headActivityAtMs">;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  replaceSectionValue: (markdown: string, heading: string, value: string) => string;
  repoRelativePath: (path: string) => string;
  reportAgentsPolicyStatus: (markdown: string) => AgentsPolicyStatus | undefined;
  reportEvidence: (markdown: string) => Evidence[];
  reportFeatureShowcase: (markdown: string) => FeatureShowcase;
  reportFileName: (repo: string, number: number) => string;
  reportLikelyOwners: (markdown: string) => LikelyOwner[];
  reportMantisRecommendation: (markdown: string) => MantisRecommendation;
  reportOverallConfidenceScore: (markdown: string) => number;
  reportOverallCorrectness: (markdown: string) => OverallCorrectness;
  reportPrRating: (markdown: string) => PrRating;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  reportReviewFindings: (markdown: string) => ReviewFinding[];
  reportRootCauseCluster: (markdown: string) => RootCauseClusterAssessment;
  reportSecurityReview: (markdown: string) => SecurityReview;
  reportTelegramVisibleProof: (markdown: string) => TelegramVisibleProof;
  reportVisionFit: (markdown: string) => {
    visionFit: VisionFitStatus;
    visionFitReason: string;
    visionFitEvidence: string[];
    implementationComplexity: ImplementationComplexity;
    autoImplementationCandidate: AutoImplementationCandidate;
  };
  repoUrlFor: (repo: string, path?: string) => string;
  reviewAutomationMarkersFromReport: (markdown: string) => string;
  reviewFindingDetailedLine: (finding: ReviewFinding) => string;
  reviewFindingLocation: (finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">) => string;
  reviewFindingSummaryLine: (finding: ReviewFinding) => string;
  reviewReportCanPromoteToClose: (markdown: string) => boolean;
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
  runtimeBudgetExceeded: (startedAtMs: number, maxRuntimeMs: number, nowMs: number) => boolean;
  sanitizeArchitectureDiagram: (value: string) => string;
  sectionLineValue: (section: string, label: string) => string | undefined;
  sectionValue: (markdown: string, heading: string) => string;
  securityConcernDetailedLine: (concern: SecurityConcern) => string;
  securityConcernLocation: (concern: SecurityConcern) => string;
  securityConcernSummaryLine: (concern: SecurityConcern) => string;
  securityReviewLine: (review: SecurityReview) => string;
  sentence: (value: string) => string;
  sha256: (text: string) => string;
  shouldApplyFeatureShowcaseLabel: (options: {
    isPullRequest: boolean;
    itemCategory: string | undefined;
    requiresNewFeature: boolean;
    showcase: FeatureShowcase;
    securityReview: Pick<SecurityReview, "status">;
    overallCorrectness: OverallCorrectness;
  }) => boolean;
  splitFileAndLine: (file: string, explicitLine?: number | null) => { file: string; line?: number };
  stringOrUndefined: (value: unknown) => string | undefined;
  stripPriorityPrefix: (text: string) => string;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  timeoutWithinRuntimeBudget: (
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ) => number | null;
  timestampMs: (iso: string | undefined) => number | null;
  triagePriorityFromReport: (markdown: string) => TriagePriority;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workStatusForDecision: (decision: Decision) => string;
}

export function createReportOrchestration(dependencies: CreateReportOrchestrationDependencies) {
  const {
    agentsPolicyStatusLine,
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
    hasUsableCloseComment,
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
    isImplementationCloseReason,
    isIssueAdvisoryLabel,
    isMaintainerAuthored,
    isOlderThanDays,
    isReportNoneList,
    isRoutineCiOrReviewText,
    issueAdvisoryLabelStateFromReport,
    isVerifiedFixedCloseReason,
    itemSnapshotHash,
    jsonFrontMatterValue,
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
    neutralizeOwnedSectionSpoofing,
    nextFeatureShowcaseLabels,
    nextImpactLabels,
    nextIssueAdvisoryLabels,
    nextMaturityLabels,
    nextMergeRiskLabels,
    nextPriorityLabels,
    nextPrStatusLabels,
    nextRealBehaviorProofMediaLabels,
    nextRealBehaviorProofSufficientLabels,
    nextTelegramVisibleProofLabels,
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
    publicTableCell,
    publicVerificationBlock,
    pullHeadShaFromContext,
    pullHeadShaFromReport,
    pullRequestHeadActivity,
    repairLoopPassModeFromReport,
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
    reviewAutomationMarkersFromReport,
    reviewFindingDetailedLine,
    reviewFindingLocation,
    reviewFindingSummaryLine,
    reviewReportCanPromoteToClose,
    reviewSectionValue,
    reviewStructuralPullStateFromContext,
    reviewVersionMarkerFromReport,
    ROOT,
    runtimeBudgetExceeded,
    sanitizeArchitectureDiagram,
    sectionLineValue,
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
    timeoutWithinRuntimeBudget,
    timestampMs,
    triagePriorityFromReport,
    validateCloseDecision,
    workStatusForDecision,
  } = dependencies;

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
        .filter((entry) =>
          /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label),
        )
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
        .filter((entry) =>
          /\b(?:canonical|duplicate|superseded|implementation)\b/i.test(entry.label),
        )
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
    const longestBacktickRun = Math.max(
      0,
      ...(escaped.match(/`+/g) ?? []).map((run) => run.length),
    );
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

  const {
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
      workPriority:
        (frontMatterValue(markdown, "work_priority") as Confidence | undefined) ?? "low",
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

  function contextHasNonAutomationActivityAfterForTest(options: {
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
      return {
        files: files.filter((file): file is string => typeof file === "string"),
        known: true,
      };
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
    let next = replaceFrontMatterValue(
      markdown,
      "action_taken",
      "corrected_stale_canonical_comment",
    );
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
    return justifications
      .map((entry) => `- ${inlineCode(entry.label)}: ${entry.reason}`)
      .join("\n");
  }

  function labelTransitionJustificationsMarkdown(
    justifications: readonly LabelTransitionJustification[],
  ): string {
    if (!justifications.length) return "- none";
    return justifications
      .map((entry) => `- ${entry.action} ${inlineCode(entry.label)}: ${entry.reason}`)
      .join("\n");
  }

  function labelJustificationsMarkdownForTest(
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
    const desiredLabels = desiredClawSweeperLabelsFromPublicReport(
      markdown,
      currentLabels,
      options,
    );
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

  const reportRendering = createReportRendering({
    agentsPolicyStatusLine,
    asRecord,
    closeClawHubHandoffBlock,
    closeEvidenceLine,
    closeIntro,
    closeOutro,
    collectItemContext,
    compactPullFilePaths,
    confidenceText,
    duplicateCanonicalLinks,
    duplicateCanonicalPathLine,
    ensureDir,
    fileUrl,
    fixedInReportText,
    fixedInText,
    fixedPullRequestFromReport,
    formatReviewFreshnessTimestamp,
    formattedMarkdownList,
    formatTimestamp,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
    ghObservedMutationCommand,
    hasUsableCloseComment,
    inlineCode,
    isActionablePriorityText,
    isImplementationCloseReason,
    isMaintainerAuthored,
    isReportNoneList,
    isRoutineCiOrReviewText,
    isVerifiedFixedCloseReason,
    jsonFrontMatterValue,
    labelJustificationsFromPublicReport,
    labelJustificationsMarkdown,
    labelTransitionJustificationsFromPublicReport,
    labelTransitionJustificationsMarkdown,
    likelyOwnerLine,
    linkedRelease,
    linkedSha,
    markdownLink,
    markdownRepository,
    mergeRiskOptionsFromReport,
    neutralizeOwnedSectionSpoofing,
    normalizePublicReviewText,
    priorityLabel,
    prSurfaceFilesFromContext,
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
    pullHeadShaFromContext,
    pullHeadShaFromReport,
    realBehaviorProofBlocksMerge,
    renderDataModelWarningFromReport,
    renderOpenClawPrSurfaceFromReport,
    renderReviewMetricsDigest,
    repairLoopPassModeFromReport,
    replaceFrontMatterValue,
    repoRelativePath,
    reportAgentsPolicyStatus,
    reportEvidence,
    reportLikelyOwners,
    reportMantisRecommendation,
    reportOverallConfidenceScore,
    reportOverallCorrectness,
    reportPrRating,
    reportRealBehaviorProof,
    reportReviewFindings,
    reportRootCauseCluster,
    reportSecurityReview,
    reviewAutomationMarkersFromReport,
    reviewFindingDetailedLine,
    reviewFindingLocation,
    reviewFindingSummaryLine,
    reviewMetricsFromReport,
    reviewSectionValue,
    reviewStructuralPullStateFromContext,
    reviewVersionMarkerFromReport,
    ROOT,
    sanitizeArchitectureDiagram,
    securityConcernDetailedLine,
    securityConcernLocation,
    securityConcernSummaryLine,
    securityReviewLine,
    sentence,
    sha256,
    shouldRenderWorkPlanFromReport,
    splitFileAndLine,
    stripPriorityPrefix,
    targetRepo,
    triagePriorityFromReport,
    validateCloseDecision,
    workCandidateReasonText,
    workPlanPathForReport,
    workStatusForDecision,
  });
  const {
    OWNED_REVIEW_SECTION_HEADINGS,
    closeItem,
    collapsedDetailsBlock,
    currentReviewRevision,
    markdownFor,
    pullRequestFilePathsFromContextForTest,
    pullRequestHeadSha,
    renderCloseCommentFromReport,
    renderPrRatingAssessmentReportSection,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderRootCauseClusterAssessmentReportSection,
    renderWorkPlanFromReport,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    reviewHistoryForStaleComment,
    sanitizePublicSelfReferences,
    syncWorkPlanFromReport,
    updateReviewSemanticFrontMatter,
    updateReviewStructuralFrontMatter,
  } = reportRendering;

  return {
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
    contextHasNonAutomationActivityAfterForTest,
    coveringPrCloseCoveragePullRequestUpdatedAt,
    currentReviewRevision,
    dataModelSurfaceReviewRequired,
    duplicateCanonicalPullRequestBlockReason,
    hasNormalizedLabel,
    impactLabelSchemeForTest,
    impactLabelsForTest,
    isClawSweeperOwnedLabel,
    isGitHubLabelAlreadyExistsErrorForTest,
    isGitHubLabelCapacityErrorForTest,
    isMissingGitHubLabelErrorForTest,
    issueAdvisoryLabelsForTest,
    labelJustificationsMarkdownForTest,
    labelSynchronization,
    linkedPullRequestRefsFromText,
    linkedPullRequestSignalContextsFromText,
    livePullRequestHasNoDiff,
    markdownFor,
    maturityLabelSchemeForTest,
    maturityLabelsForTest,
    mergeRiskLabelSchemeForTest,
    mergeRiskLabelsForTest,
    normalizedLabelSet,
    parseBacktickLocation,
    prCloseCoverageProofGateResult,
    prRatingLabelSchemeForTest,
    prRatingLabelsForTest,
    priorityLabelSchemeForTest,
    priorityLabelsForTest,
    pullRequestClosePromotion,
    pullRequestFilePathsFromContextForTest,
    pullRequestFilePathsFromReport,
    pullRequestHeadSha,
    realBehaviorProofBlocksMerge,
    realBehaviorProofMediaLabelsForTest,
    realBehaviorProofSufficientLabelsForTest,
    renderReviewCommentFromReport,
    renderReviewContextBudgetForTest,
    renderWorkPlanFromReport,
    reportDecision,
    reviewActionForDecision,
    reviewContextLedgerForTest,
    reviewHistoryForStaleComment,
    sanitizePublicSelfReferences,
    staleCanonicalCommentSyncPendingReason,
    staleCanonicalPullRequestNumber,
    syncBulkFilerLabelForTest,
    syncWorkPlanFromReport,
    telegramVisibleProofLabelsForTest,
    updateReviewSemanticFrontMatter,
    updateReviewStructuralFrontMatter,
    upgradeNoDiffPullRequestReport,
    upgradePullRequestClosePromotionReport,
    workPlanPathForReport,
  };
}
