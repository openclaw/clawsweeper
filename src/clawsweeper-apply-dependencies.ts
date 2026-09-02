import { type Args } from "./clawsweeper-args.js";
import type {
  AcquiredReviewStartLease,
  ActionTaken,
  ApplyActionLedger,
  ApplyKind,
  ApplyLedgerItem,
  ApplyMutationAttempt,
  ApplyResult,
  AuthorPrBudgetApplyGate,
  AuthorPrBudgetApplyState,
  BulkFilerRepositoryPermissionCache,
  CanonicalPullRequestCommentSyncBlock,
  CloseReason,
  Decision,
  ExactEventReviewLeaseDisposition,
  ExactReviewQueueAuthority,
  FeatureShowcase,
  ImpactLabelName,
  IssueAdvisoryLabelState,
  Item,
  ItemContext,
  ItemKind,
  MaturityLabelName,
  MergeRiskLabelName,
  MutationRunner,
  OverallCorrectness,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
  PrCloseCoverageRuntimeBudget,
  PrRating,
  PrStatusLabelKind,
  PullRequestClosePromotion,
  RealBehaviorProof,
  ReportEntry,
  ReviewCommentRenderOptions,
  ReviewStartStatusCommentResult,
  SecurityReview,
  StalePullRequestReviewHead,
  TelegramVisibleProof,
  TriagePriority,
} from "./clawsweeper-types.js";
import { type PrCloseCoverageProofRuntime } from "./pr-close-coverage-proof.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import type { LiveReadGeneration, LiveReadOptions } from "./live-read-generation.js";
import type { PrHydrationSnapshot } from "./pr-hydration-snapshot.js";

export interface CreateApplyDecisionWorkflowDependencies {
  abandonedPrApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ) => string | null;
  actionLedgerItemKey: (item: Pick<Item, "repo" | "number">) => string;
  activeApplyMutationRunner: MutationRunner | null;
  addIssueLabel: (number: number, label: string, onMutation?: () => void) => void;
  beginIssueLabelMutationBatch: (number: number) => void;
  applyAuthorPrBudgetStateToReport: (markdown: string, state: AuthorPrBudgetApplyState) => string;
  applyBlockingProtectedLabels: (labels: readonly string[], closeReason: unknown) => string[];
  applyClosedUnmergedCanonicalBlockedReport: (
    markdown: string,
    block: PrCloseCoverageProofGateBlock,
    canonicalNumber: number,
  ) => string;
  applyKindArg: (value: string | boolean | string[] | undefined) => ApplyKind;
  ApplyMutationReviewGuardError: new (reason: string) => Error;
  applyPrCloseCoverageProofBlockedReport: (
    markdown: string,
    block: PrCloseCoverageProofGateBlock,
  ) => string;
  applyPrCloseCoverageProofReportSection: (
    markdown: string,
    gateResult: PrCloseCoverageProofGateResult | undefined,
  ) => string;
  applyProtectedLabelReason: (labels: readonly string[], closeReason: unknown) => string;
  applyQueueSortFields: (
    markdown: string,
    syncCommentsOnly: boolean,
    applyKind: ApplyKind,
  ) => { priority: number; applyCheckedAt: number };
  applyRuntimeBudgetYieldResults: (number: number, reason: string) => ApplyResult[];
  asRecord: (value: unknown) => Record<string, unknown>;
  authorPrBudgetAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  authorPrBudgetApplyGateSafe: (
    number: number,
    item: Pick<Item, "author" | "authorAssociation" | "createdAt" | "kind" | "labels">,
    markdown: string,
  ) => AuthorPrBudgetApplyGate;
  authorPrBudgetCloseEnabled: (env?: Record<string, string | undefined>) => boolean;
  authorPrBudgetMaxClosesPerRun: (env?: Record<string, string | undefined>) => number;
  authorPrBudgetPromotion: (
    markdown: string,
    state: AuthorPrBudgetApplyState,
  ) => PullRequestClosePromotion;
  authorPrBudgetSignalBlockReason: (markdown: string) => string | null;
  bulkFilerRepositoryPermission: (
    author: string,
    cache: BulkFilerRepositoryPermissionCache,
  ) => string | null;
  canonicalPullRequestCommentSyncBlock: (
    markdown: string,
    item: Item,
  ) => CanonicalPullRequestCommentSyncBlock | null;
  CLAWSWEEPER_BOT_AUTHORS: Set<string>;
  closeItem: (options: { number: number; kind: ItemKind; reason: CloseReason }) => void;
  closeReasonApplyAgeSkipReason: (
    item: Pick<Item, "createdAt">,
    closeReason: CloseReason,
    options: { minAgeMs: number; minAgeDescription: string; staleMinAgeDays: number; now?: number },
  ) => string | null;
  closeReasonEnabled: (
    closeReason: CloseReason,
    filter: ReadonlySet<CloseReason> | null,
  ) => boolean;
  closeReasonFilterText: (filter: ReadonlySet<CloseReason> | null) => string;
  closeReasonsArg: (value: string | boolean | string[] | undefined) => Set<CloseReason> | null;
  closingPullRequestsForIssue: (number: number) => unknown[];
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
      prHydrationSnapshot?: PrHydrationSnapshot | null;
      prCommentActivityRevision?: string | null;
      requireFullyValidatedPrHydrationSnapshot?: boolean;
      liveReadGeneration?: LiveReadGeneration;
      bypassGenerationCache?: boolean;
    },
  ) => ItemContext;
  commentBody: (comment: Record<string, unknown> | undefined) => string | undefined;
  commentBodyMatches: (
    comment: Record<string, unknown> | undefined,
    body: string,
    options?: { allowApplyCloseActionUpgrade?: boolean },
  ) => boolean;
  commentId: (comment: Record<string, unknown> | undefined) => number | null;
  commentUpdatedAt: (comment: Record<string, unknown> | undefined) => string | undefined;
  completeStaleCanonicalCommentSyncReport: (markdown: string) => string;
  contextHasNonAutomationActivityAfter: (
    context: ItemContext,
    reviewedAtMs: number,
    options?: {
      truncationCountsAsActivity?: boolean;
      useCompleteActivityContext?: boolean;
      ignoreTimelineCommentsThroughMs?: number;
      ignoreTrustedTimelineComment?: { authors: ReadonlySet<string>; createdAt: string };
    },
  ) => boolean;
  coverageProofRetryExhaustedRuntimeBudget: (
    startedAtMs: number,
    maxRuntimeMs: number,
    actionTaken: string,
    nowMs: number,
  ) => boolean;
  coveringPrCloseCoveragePullRequestSnapshotSha256: (number: number) => string;
  decisionPacketsDirFromArgs: (args: Args, itemsDir: string, closedDir: string) => string;
  discardIssueLabelMutationBatch: (number: number) => void;
  defaultClosedDir: (profile?: RepositoryProfile) => string;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  defaultPlansDir: (profile?: RepositoryProfile) => string;
  deleteOwnedDedicatedReviewStartLease: (
    itemNumber: number,
    lease: AcquiredReviewStartLease,
    options?: { throwOnError?: boolean },
  ) => boolean;
  duplicateCanonicalPullRequestBlockReason: (
    markdown: string,
    item: Item,
    options?: { reportDirs?: readonly string[] },
  ) => string | null;
  ensureCloseAppliedComment: (options: {
    number: number;
    closeReason: CloseReason;
    markdown: string;
    itemUrl: string;
    dryRun: boolean;
  }) => string;
  ensureDir: (path: string) => void;
  ensureIdeaArchiveLabel: (onMutation?: () => void) => void;
  ensureRuntimeDelayFits: (waitMs: number, phase: string) => void;
  exactEventReviewLeaseDisposition: (
    markdown: string,
    liveRevision: string,
  ) => ExactEventReviewLeaseDisposition;
  fetchIssueReviewComments: (number: number) => Record<string, unknown>[];
  fetchItem: (
    number: number,
    options?: LiveReadOptions & { liveReadGeneration?: LiveReadGeneration },
  ) => { item: Item; state: string };
  fetchReviewedPrActivityCursor: (
    number: number,
    prefetchedInlineComments?: unknown[],
  ) => string | null;
  finishApplyMutationAttempt: (options: {
    ledger: ApplyActionLedger;
    entry: ReportEntry;
    attempt: ApplyMutationAttempt;
    outcome: "accepted" | "rejected" | "unknown";
  }) => string | null;
  flushIssueLabelMutationBatch: (
    number: number,
    beforeItemMutation?: () => void,
    afterItemMutation?: (confirmed: boolean) => void,
  ) => {
    itemMutationPublished: boolean;
    repositoryDefinitionMutated: boolean;
    skippedAdditions: string[];
  };
  freshPullRequestReviewHead: (markdown: string, context: ItemContext) => boolean;
  frontMatterBoolean: (markdown: string, key: string) => boolean;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  ghJson: <T>(args: string[]) => T;
  GitHubRuntimeBudgetError: new (reason: string) => Error & { readonly reason: string };
  guardedOpenApplyProofFields: (
    actionTaken: string,
    options: { emitEventApplyProof: boolean; liveGuardVerified: boolean },
  ) => { guardedOpenStateVerified?: true };
  hasAutoCloseAllowedMetadata: (markdown: string) => boolean;
  hasNormalizedLabel: (labels: readonly string[], label: string) => boolean;
  hasVerifiedLocalCheckoutAccess: (markdown: string) => boolean;
  impactLabelsFromReport: (markdown: string) => ImpactLabelName[];
  isApplyCloseCandidateReport: (markdown: string) => boolean;
  implementedOnMainPullRequestProvenanceApplyBlock: (
    markdown: string,
    item: Item,
    closeReason: Decision["closeReason"],
    expectedLinkedIssueNumber?: number,
  ) => string | null;
  isBulkFilerExemptAuthorAssociation: (value: unknown) => boolean;
  isExactEventSourceRevisionChange: (itemKind: Item["kind"], reason: string) => boolean;
  isGoodFirstIssue: (state: IssueAdvisoryLabelState, currentLabels: readonly string[]) => boolean;
  isLiveRecheckCloseGuardReport: (markdown: string) => boolean;
  isMaintainerAuthorAssociation: (value: unknown) => boolean;
  isPairBlockedCloseReport: (markdown: string) => boolean;
  isRetryableCloseSkipReport: (markdown: string) => boolean;
  isRetryableKeptOpenCloseReport: (markdown: string) => boolean;
  isRetryablePrCloseCoverageProofReport: (markdown: string) => boolean;
  issueAdvisoryLabelStateFromReport: (
    markdown: string,
    options?: {
      goodFirstIssueOptedOut?: boolean;
      hasOpenLinkedPullRequest?: boolean;
      locked?: boolean;
    },
  ) => IssueAdvisoryLabelState;
  issueRecentHumanCommentBlockReasonSafe: (number: number, days: number) => string | null;
  issueReviewComment: (
    number: number,
    fallbackBodies?: readonly string[],
  ) => Record<string, unknown> | undefined;
  issueReviewCommentState: (
    number: number,
    fallbackBodies?: readonly string[],
    options?: LiveReadOptions & { liveReadGeneration?: LiveReadGeneration },
  ) => {
    comments: Record<string, unknown>[];
    reviewComment: Record<string, unknown> | undefined;
    leaseComment: Record<string, unknown> | undefined;
    leaseComments: Record<string, unknown>[];
    dedicatedLeaseComment: Record<string, unknown> | undefined;
    dedicatedLeaseComments: Record<string, unknown>[];
  };
  isVerifiedFixedCloseReason: (reason: unknown) => boolean;
  itemSnapshotHash: (item: Item, context: ItemContext) => string;
  liveIssueSourceRevision: (
    number: number,
    options?: LiveReadOptions & { liveReadGeneration?: LiveReadGeneration },
  ) => string;
  livePullRequestHasNoDiff: (context: ItemContext) => boolean;
  lockedConversationApplyReason: (item: Pick<Item, "activeLockReason" | "locked">) => string | null;
  login: (value: unknown) => string | undefined;
  lowSignalUnmergeablePrApplyBlockReasonSafe: (
    number: number,
    staleMinAgeDays: number,
  ) => string | null;
  markdownRepository: (markdown: string, file?: string) => string;
  markedReviewCommentBody: (number: number, body: string) => string;
  maturityLabelsFromReport: (markdown: string) => MaturityLabelName[];
  mergeRiskLabelsFromReport: (markdown: string) => MergeRiskLabelName[];
  mutationErrorMessage: (error: unknown) => string;
  normalizeAuthorAssociation: (value: unknown) => string;
  normalizeLabelName: (label: string) => string;
  numberForMarkdownFile: (file: string) => number;
  obsoleteFixPrApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt">,
  ) => string | null;
  openClosingPullRequestApplyReason: (
    pullRequests: readonly unknown[],
    canPairClose?: (number: number, repo?: string) => boolean,
  ) => string | null;
  orderedApplyItemNumbers: (
    itemNumbers: string | boolean | string[] | undefined,
    itemNumber: string | boolean | string[] | undefined,
  ) => number[];
  pairCloseKey: (repo: string, number: number) => string;
  PATCHABLE_REVIEW_COMMENT_AUTHORS: Set<string>;
  postReviewStartStatusComment: (options: {
    item: Item;
    headSha?: string;
    reviewTimeoutMs: number;
    position: number;
    total: number;
    shardIndex: number;
    shardCount: number;
    purpose?: "review" | "apply";
    queueAuthority?: ExactReviewQueueAuthority | null;
    allowSupersededLeaseCleanup?: boolean;
  }) => ReviewStartStatusCommentResult;
  PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH: string;
  prAutoCloseExemptDecisionReason: (
    item: Pick<Item, "kind" | "labels">,
    closeReason: CloseReason | undefined,
  ) => string | null;
  prCloseCoverageProofGateResult: (options: {
    markdown: string;
    item: Item;
    context: ItemContext;
    runtime: PrCloseCoverageProofRuntime;
    requirePrecomputedProof?: boolean;
    runtimeBudget?: PrCloseCoverageRuntimeBudget;
  }) => PrCloseCoverageProofGateResult;
  prCloseCoverageProofPromptTemplate: () => string;
  prStatusLabelKindFromReport: (
    markdown: string,
    context: ItemContext,
    currentLabels: readonly string[],
  ) => PrStatusLabelKind | null;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  pullRequestClosePromotion: (
    markdown: string,
    item: Item,
    context: ItemContext,
    staleMinAgeDays: number,
    options?: { reportDirs?: readonly string[] },
  ) => PullRequestClosePromotion | null;
  recordApplyActionEvents: (options: {
    ledger: ApplyActionLedger;
    results: readonly ApplyResult[];
    entries: ReadonlyMap<number, ReportEntry>;
    mutationByItem: ReadonlyMap<string, boolean>;
    dryRun: boolean;
    reportPath: string;
    failed?: boolean;
    failure?: unknown;
    inFlightItem?: { repo: string; number: number; mutationOccurred: boolean };
  }) => void;
  recordApplyActionLedgerItemResults: (options: {
    ledger: ApplyActionLedger;
    state: ApplyLedgerItem;
    results: readonly ApplyResult[];
    entry: ReportEntry;
    mutationOccurred: boolean;
    dryRun: boolean;
  }) => void;
  recordApplyMutationBoundary: (
    ledger: ApplyActionLedger,
    entry: ReportEntry,
    parentEventId?: string | null,
  ) => void;
  recordedLabelSyncCoversUpdate: (options: {
    itemUpdatedAt: string;
    labelsSyncedAt: string | undefined;
    liveLabels: readonly string[];
    recordedLabels: readonly string[];
    hasNonAutomationActivity: boolean;
  }) => boolean;
  removeCurrentCursorTraceItem: (examinedItemNumbers: number[], currentNumber: number) => void;
  removeIssueLabel: (number: number, label: string, onMutation?: () => void) => void;
  renderReviewCommentFromReport: (
    markdown: string,
    reason: CloseReason,
    options?: ReviewCommentRenderOptions,
  ) => string;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  replaceSectionValue: (markdown: string, heading: string, value: string) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  reportCloseReason: (markdown: string) => CloseReason | undefined;
  reportDecision: (markdown: string, closeReason: CloseReason) => Decision;
  reportEntriesForDir: (dir: string, itemNumbers?: ReadonlySet<number>) => ReportEntry[];
  reportFeatureShowcase: (markdown: string) => FeatureShowcase;
  reportItemKind: (markdown: string) => ItemKind | undefined;
  reportOverallCorrectness: (markdown: string) => OverallCorrectness;
  reportPrRating: (markdown: string) => PrRating;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  reportSecurityReview: (markdown: string) => SecurityReview;
  reportTelegramVisibleProof: (markdown: string) => TelegramVisibleProof;
  resetGuardReadCache: () => void;
  setGuardReadGeneration: (generation: LiveReadGeneration | null) => void;
  withGuardReadOptions: <T>(options: LiveReadOptions, read: () => T) => T;
  reviewCommentBodyDigest: (body: string) => string;
  reviewCommentHasCloseVerdictForCanonical: (
    comment: Record<string, unknown> | undefined,
    number: number,
    reason: CloseReason,
    canonicalNumber: number,
  ) => boolean;
  reviewCommentHashMatches: (
    comment: Record<string, unknown> | undefined,
    body: string,
    storedHash: string | undefined,
    expectedHash: string,
    options?: { allowApplyCloseActionUpgrade?: boolean },
  ) => boolean;
  reviewLeaseRevisionFromReport: (markdown: string) => string | null;
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
  reviewStartLeaseOwner: (comment: Record<string, unknown> | undefined) => string | null;
  ROOT: string;
  runtimeBudgetExceeded: (startedAtMs: number, maxRuntimeMs: number, nowMs: number) => boolean;
  sameAuthorCounterpartApplyReason: (
    item: Pick<Item, "number" | "kind" | "author">,
    relatedItems: readonly unknown[],
    canPairClose?: (number: number, kind: ItemKind) => boolean,
  ) => string | null;
  sha256: (text: string) => string;
  shouldPreserveReviewStartLease: (options: {
    currentHeadSha: string;
    reportHeadSha: string | undefined;
    reportLeaseOwner: string | undefined;
    reportLeaseCommentId: string | undefined;
    leaseOwner: string | null;
    leaseCommentId: number | null;
  }) => boolean;
  shouldProbeClosedStateReport: (markdown: string) => boolean;
  shouldSyncReviewComment: (options: {
    syncCommentsOnly: boolean;
    isCloseProposal: boolean;
    commentSyncMinAgeDays: number;
    reviewCommentSyncedAt: string | undefined;
    reviewCommentVerifiedAt?: string | undefined;
    reviewedAt?: string | undefined;
    lastFullReviewAt?: string | undefined;
    guardedReviewedAt?: string | undefined;
    hasExistingReviewComment: boolean;
    needsReviewCommentBodySync: boolean;
    needsReviewCommentHashSync: boolean;
    needsReviewCommentReferenceSync: boolean;
    forceReviewCommentBodySync?: boolean;
    now?: number;
  }) => boolean;
  sleepMs: (milliseconds: number) => void;
  staleCanonicalCommentSyncPendingReason: (markdown: string) => string | null;
  staleCanonicalPullRequestNumber: (markdown: string) => number | null;
  stalePullRequestReviewComment: (options: {
    number: number;
    stale: StalePullRequestReviewHead;
    previousReviewCommentBody?: string;
  }) => string;
  stalePullRequestReviewHead: (
    markdown: string,
    context: ItemContext,
  ) => StalePullRequestReviewHead | null;
  staleReviewCommentSyncReason: (
    markdown: string,
    existingReviewComment: Record<string, unknown> | undefined,
    number: number,
    context?: ItemContext,
  ) => string | null;
  newerDurableReviewTupleVerified: (
    markdown: string,
    existingReviewComment: Record<string, unknown> | undefined,
    number: number,
  ) => boolean;
  staleVersionBugApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt">,
  ) => string | null;
  stalledUnprovenPrApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ) => string | null;
  startApplyActionLedger: (options: {
    applyKind: ApplyKind;
    closeReasons: ReadonlySet<CloseReason> | null;
    dryRun: boolean;
    syncCommentsOnly: boolean;
    requestedItemNumbers: readonly number[];
    reportPath: string;
    candidates: readonly ReportEntry[];
  }) => ApplyActionLedger;
  startApplyActionLedgerItem: (
    ledger: ApplyActionLedger,
    entry: ReportEntry,
  ) => ApplyLedgerItem | null;
  startApplyMutationAttempt: (
    ledger: ApplyActionLedger,
    entry: ReportEntry,
    receiptIdentity: string,
    idempotencyIdentity: string,
  ) => ApplyMutationAttempt | null;
  stringOrUndefined: (value: unknown) => string | undefined;
  syncBulkFilerLabel: (options: {
    number: number;
    labels: readonly string[];
    bulkFilerDetected: boolean;
    authorAssociation: string;
    repositoryPermission?: string | null;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncFeatureShowcaseLabel: (options: {
    number: number;
    labels: readonly string[];
    isPullRequest: boolean;
    itemCategory: string | undefined;
    requiresNewFeature: boolean;
    showcase: FeatureShowcase;
    securityReview: Pick<SecurityReview, "status">;
    overallCorrectness: OverallCorrectness;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncImpactLabels: (options: {
    number: number;
    labels: readonly string[];
    impactLabels: readonly ImpactLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncIssueAdvisoryLabels: (options: {
    number: number;
    labels: readonly string[];
    state: IssueAdvisoryLabelState;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncMaturityLabels: (options: {
    number: number;
    labels: readonly string[];
    maturityLabels: readonly MaturityLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncMergeRiskLabels: (options: {
    number: number;
    labels: readonly string[];
    mergeRiskLabels: readonly MergeRiskLabelName[];
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncPriorityLabel: (options: {
    number: number;
    labels: readonly string[];
    triagePriority: TriagePriority;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncPrRatingLabel: (options: {
    number: number;
    labels: readonly string[];
    rating: Pick<PrRating, "overallTier">;
    reviewFailed?: boolean;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncPrStatusLabel: (options: {
    number: number;
    labels: readonly string[];
    statusKind: PrStatusLabelKind | null;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncRealBehaviorProofMediaLabels: (options: {
    number: number;
    labels: readonly string[];
    proof: Pick<RealBehaviorProof, "evidenceKind">;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncRealBehaviorProofSufficientLabel: (options: {
    number: number;
    labels: readonly string[];
    proof: Pick<RealBehaviorProof, "status">;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncStalePullRequestReviewLabels: (options: {
    number: number;
    labels: readonly string[];
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncTelegramVisibleProofLabel: (options: {
    number: number;
    labels: readonly string[];
    proof: Pick<TelegramVisibleProof, "status">;
    dryRun: boolean;
    onMutation?: () => void;
  }) => { labels: string[]; changed: boolean };
  syncWorkPlanFromReport: (options: {
    markdown: string;
    reportPath: string;
    plansDir: string;
    dryRun?: boolean;
  }) => boolean;
  targetRepo: () => string;
  timeoutWithinRuntimeBudget: (
    startedAtMs: number,
    maxRuntimeMs: number,
    requestedTimeoutMs: number,
    nowMs: number,
  ) => number | null;
  timestampMs: (iso: string | undefined) => number | null;
  triagePriorityFromReport: (markdown: string) => TriagePriority;
  unconfirmedProductDirectionApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
  ) => string | null;
  unconfirmedProductDirectionCloseEnabled: (env?: Record<string, string | undefined>) => boolean;
  unsponsoredFeatureApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt">,
  ) => string | null;
  unsponsoredFeatureCloseEnabled: (env?: Record<string, string | undefined>) => boolean;
  updateReviewCommentMetadata: (
    markdown: string,
    comment: Record<string, unknown> | undefined,
    body: string,
  ) => string;
  upgradeNoDiffPullRequestReport: (markdown: string, item: Item) => string;
  upgradePullRequestClosePromotionReport: (
    markdown: string,
    item: Item,
    context: ItemContext,
    promotion: PullRequestClosePromotion,
  ) => string;
  upsertReviewComment: (
    number: number,
    body: string,
    existing?: Record<string, unknown>,
    mutationIdentity?: string,
  ) => Record<string, unknown>;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
}
