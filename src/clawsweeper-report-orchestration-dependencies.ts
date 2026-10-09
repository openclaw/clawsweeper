import type { RealBehaviorProofPolicy } from "./clawsweeper-proof-policy.js";
import { PR_STATUS_LABELS, type MergeRiskLabelName } from "./clawsweeper-policy.js";
import type {
  ActionTaken,
  CloseReason,
  ContextHydration,
  Decision,
  Evidence,
  FeatureShowcase,
  FixedPullRequest,
  GithubPageWithHeaders,
  ImpactLabelName,
  IssueAdvisoryLabelState,
  Item,
  ItemContext,
  LikelyOwner,
  MaturityLabelName,
  MergeRiskOption,
  OverallCorrectness,
  ParsedGitHubItemRef,
  PrRating,
  PrStatusLabelKind,
  PublicBeforeMergeItem,
  PullRequestReviewState,
  RegressionAssessment,
  PullRequestLiveActivity,
  RealBehaviorProof,
  PublicRegressionProvenance,
  ReviewFinding,
  RootCauseClusterAssessment,
  SecurityConcern,
  SecurityReview,
  TelegramVisibleProof,
  TriagePriority,
} from "./clawsweeper-types.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import { type ReviewStructuralPullState } from "./review-structural-cache.js";

export interface CreateReportOrchestrationDependencies {
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
  defaultPlansDir: (profile?: RepositoryProfile) => string;
  defaultRootCauseCluster: () => RootCauseClusterAssessment;
  ensureDir: (path: string) => void;
  eventTimestampMs: (value: unknown) => number | null;
  fileUrl: (file: string, sha: string, line?: number, repo?: string) => string;
  filterReviewContextComments: (
    comments: readonly unknown[],
    number: number,
  ) => { included: unknown[]; filtered: number };
  fixedInReportText: (markdown: string) => string;
  fixedInText: (decision: Decision) => string;
  fixedPullRequestFromReport: (markdown: string) => FixedPullRequest | null;
  regressionAssessmentFromReport: (markdown: string) => RegressionAssessment | null;
  regressionProvenanceFromReport: (markdown: string) => PublicRegressionProvenance | null;
  formatReviewFreshnessTimestamp: (iso: string | undefined) => string;
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
  isAfterReview: (value: unknown, reviewedAtMs: number | null) => boolean;
  isBulkFilerExemptAuthorAssociation: (value: unknown) => boolean;
  isBulkFilerExemptRepositoryPermission: (value: unknown) => boolean;
  isFresh: (
    review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
  ) => boolean;
  isImplementationCloseReason: (reason: CloseReason) => boolean;
  isIssueAdvisoryLabel: (label: string) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isReportNoneList: (value: string) => boolean;
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
      context: Pick<ItemContext, "comments" | "timeline">,
      currentLabels: readonly string[],
    ) => PrStatusLabelKind | null;
    prStatusLabelsForTest: (
      labels: readonly string[],
      options: {
        isPullRequest?: boolean;
        proofStatus?: string;
        needsContributorAction?: boolean;
        beforeMergeItems?: readonly PublicBeforeMergeItem["state"][];
        securityStatus?: string;
        mergeRiskOptions?: readonly Pick<MergeRiskOption, "category" | "recommended">[];
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
  likelyOwnerLines: (owners: readonly LikelyOwner[]) => string[];
  linkedRelease: (tag: string) => string;
  linkedSha: (sha: string, repo?: string) => string;
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
  pullRequestHeadActivity: (
    number: number,
    pull: {
      created_at?: string;
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    },
    timeline?: unknown[],
  ) => Pick<PullRequestLiveActivity, "headSha" | "headActivityAtMs">;
  repairLoopPassModeFromReport: (markdown: string) => "" | "autofix" | "automerge";
  repoRelativePath: (path: string) => string;
  reportRealBehaviorProofPolicy: (markdown: string) => RealBehaviorProofPolicy;
  reportRiskEntries: (text: string) => string[];
  repoUrlFor: (repo: string, path?: string) => string;
  reviewAutomationMarkersFromReport: (markdown: string) => string;
  reviewFindingDetailedLine: (finding: ReviewFinding) => string;
  reviewFindingLocation: (finding: Pick<ReviewFinding, "file" | "lineStart" | "lineEnd">) => string;
  reviewFindingSummaryLine: (finding: ReviewFinding) => string;
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  reviewVersionMarkerFromReport: (markdown: string) => string;
  ROOT: string;
  runtimeBudgetExceeded: (startedAtMs: number, maxRuntimeMs: number, nowMs: number) => boolean;
  securityConcernDetailedLine: (concern: SecurityConcern) => string;
  securityConcernLocation: (concern: SecurityConcern) => string;
  securityConcernSummaryLine: (concern: SecurityConcern) => string;
  securityReviewLine: (review: SecurityReview) => string;
  sentence: (value: string) => string;
  shouldApplyFeatureShowcaseLabel: (options: {
    isPullRequest: boolean;
    itemCategory: string | undefined;
    requiresNewFeature: boolean;
    showcase: FeatureShowcase;
    securityReview: Pick<SecurityReview, "status">;
    overallCorrectness: OverallCorrectness;
  }) => boolean;
  stripListMarker: (text: string) => string;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  timeoutWithinRuntimeBudget: (
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ) => number | null;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
  workStatusForDecision: (decision: Decision) => string;
}
