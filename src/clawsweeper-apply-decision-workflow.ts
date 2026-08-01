import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  boolArg,
  itemNumbersArg,
  numberArg,
  optionalNumberArg,
  stringArg,
  type Args,
} from "./clawsweeper-args.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import {
  BULK_FILED_LABEL,
  DAY_MS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SERVICE_TIER,
  EVENT_GUARDED_OPEN_ACTIONS,
  GOOD_FIRST_ISSUE_LABEL,
  REVIEW_SECTIONS,
  STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
  STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
} from "./clawsweeper-policy.js";
import { rawCommentBody } from "./clawsweeper-review-comments.js";
import { trimMiddle } from "./clawsweeper-text.js";
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
  GitHubRuntimeBudget,
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
import {
  maintainerDecisionBlocksClose,
  maintainerDecisionFromReport,
  syncDecisionPacketRecord,
  type DecisionPacketSubjectState,
  type MaintainerDecision,
} from "./decision-packets.js";
import {
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";
import { IDEA_ARCHIVE_LABEL } from "./idea-archive-revival.js";
import { type PrCloseCoverageProofRuntime } from "./pr-close-coverage-proof.js";
import { captureCanonicalRecordBaseline } from "./repair/canonical-record-baseline.js";
import { freshExactHeadReviewStartLease } from "./repair/comment-router-core.js";
import {
  isAutoCloseAllowed,
  repositoryProfileFor,
  type RepositoryProfile,
} from "./repository-profiles.js";
import {
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
  ReviewedPrActivityChangedDuringReadError,
} from "./review-activity-cursor.js";

interface CreateApplyDecisionWorkflowDependencies {
  abandonedPrApplyBlockReasonSafe: (
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ) => string | null;
  actionLedgerItemKey: (item: Pick<Item, "repo" | "number">) => string;
  activeApplyMutationRunner: MutationRunner | null;
  addIssueLabel: (number: number, label: string, onMutation?: () => void) => void;
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
  cleanupSupersededReviewPlaceholderComments: (options: {
    number: number;
    comments: readonly Record<string, unknown>[];
    keepCommentIds: ReadonlySet<number>;
  }) => void;
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
  coveringPrCloseCoveragePullRequestUpdatedAt: (number: number) => string | null;
  decisionPacketsDirFromArgs: (args: Args, itemsDir: string, closedDir: string) => string;
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
  fetchItem: (number: number) => { item: Item; state: string };
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
  liveIssueSourceRevision: (number: number) => string;
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
  throttleHeartbeatContext: (() => string) | null;
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
  ) => Record<string, unknown> | undefined;
  validateCloseDecision: (
    item: Pick<Item, "kind" | "labels"> & Partial<Pick<Item, "repo" | "authorAssociation">>,
    decision: Decision,
    options?: { requireCloseComment?: boolean },
  ) => { ok: true } | { ok: false; actionTaken: ActionTaken; reason: string };
}

export function createApplyDecisionWorkflow(dependencies: CreateApplyDecisionWorkflowDependencies) {
  const {
    abandonedPrApplyBlockReasonSafe,
    actionLedgerItemKey,
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
  } = dependencies;

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
    const staleMinAgeDays = numberArg(
      args.stale_min_age_days,
      STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
    );
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
    dependencies.throttleHeartbeatContext = () =>
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
    const recordAuthorPrClose = (
      author: string,
      closeReason: CloseReason | "none" | null,
    ): void => {
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
            finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError)
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
      const previousApplyMutationRunner = dependencies.activeApplyMutationRunner;
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
      dependencies.activeApplyMutationRunner = <T>(options: {
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
        dependencies.activeApplyMutationRunner = previousApplyMutationRunner;
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

  return { applyDecisionsCommandInner };
}
