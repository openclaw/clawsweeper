import type { ActionEvent } from "./action-ledger.js";
import type { ActionEventReasonCode, ActionEventStatus } from "./action-ledger.js";
import type { Args } from "./clawsweeper-args.js";
import type { AgentScanSource } from "./agent-input-scan.js";
import type {
  AcquiredReviewStartLease,
  Action,
  BulkFilerDetectionOptions,
  BulkFilerDetectionResult,
  BulkFilerRepositoryPermissionCache,
  Decision,
  ExactReviewQueueAuthority,
  ExistingReview,
  ExpectedIssueSourceRevisionOptions,
  FileModeSnapshot,
  GitInfo,
  Item,
  ItemContext,
  MutationRunner,
  PreviousClawSweeperReview,
  ReviewActionLedger,
  ReviewCheckout,
  ReviewFinding,
  ReviewGitInfoOptions,
  ReviewPromptBuild,
  ReviewPromptRuntimeHints,
  ReviewRuntime,
  ReviewStartStatusCommentResult,
} from "./clawsweeper-types.js";
import type { UserFacingCommandError } from "./command.js";
import type { CodexProcessResult } from "./codex-process.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import type { ReviewStructuralPullState } from "./review-structural-cache.js";
import type { ReviewStructuralRecord } from "./review-structural-cache.js";
import type { PrHydrationSnapshot } from "./pr-hydration-snapshot.js";

export interface CreateReviewCommandWorkflowDependencies {
  actionLedgerFailureDisposition: (error: unknown) => {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    completionReason: string;
  };
  actionLedgerItemKey: (item: Pick<Item, "repo" | "number">) => string;
  activeReviewMutationRunner: MutationRunner | null;
  asRecord: (value: unknown) => Record<string, unknown>;
  attachFixedPullRequest: (
    decision: Decision,
    item: Item,
    context: ItemContext,
    priorReviewMarkdown?: string,
  ) => Decision;
  verifyRegressionProvenance: (
    decision: Decision,
    item: Item,
    context: ItemContext,
    checkoutDir: string,
    git: GitInfo,
  ) => Decision;
  authorIssueCountInBulkFilerWindow: (author: string, windowStart: string) => number;
  buildLocalRangeReview: (
    targetDir: string,
    repo: string,
    baseRef: string,
  ) => { item: Item; context: ItemContext; baseSha: string; headSha: string };
  buildReviewPrompt: (
    item: Item,
    context: ItemContext,
    git: GitInfo,
    additionalPrompt?: string,
    runtimeHints?: ReviewPromptRuntimeHints,
  ) => ReviewPromptBuild;
  bulkFilerPolicyInvalidatesCachedReview: (
    markdown: string | null,
    exemptionApplied: boolean,
  ) => boolean;
  bulkFilerRepositoryPermission: (
    author: string,
    cache: BulkFilerRepositoryPermissionCache,
  ) => string | null;
  codexFailureDecision: (
    status: number | null,
    detail: string,
    stdout?: string,
    stderr?: string,
    processResult?: { errorCode?: string | null; signal?: NodeJS.Signals | null },
  ) => Decision;
  codexFailureLogKind: (markdown: string) => string;
  CodexReviewError: new (options: {
    message: string;
    status: number | null;
    stdout?: string;
    stderr?: string;
    errorCode?: string | null;
    signal?: NodeJS.Signals | null;
    retryable?: boolean;
  }) => Error & {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly errorCode: string | null;
    readonly signal: NodeJS.Signals | null;
    readonly retryable: boolean;
  };
  codexReviewFailureRetryable: (error: unknown) => boolean;
  collectItemContext: (
    item: Item,
    options?: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
      prHydrationSnapshot?: PrHydrationSnapshot | null;
      prCommentActivityRevision?: string | null;
    },
  ) => ItemContext;
  commentId: (comment: Record<string, unknown> | undefined) => number | null;
  completePullChecksContext: (value: unknown) => boolean;
  DEFAULT_PLAN_BATCH_SIZE: 3;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  defaultLocalRangeArtifactDir: (targetDir: string) => string;
  defaultLocalRangeHistoryPath: (targetDir: string, repo: string, baseSha: string) => string;
  defaultReviewArtifactDir: (
    localOnly: boolean,
    itemNumber: number | undefined,
    itemNumbers: number[] | undefined,
  ) => string;
  deleteOwnedDedicatedReviewStartLease: (
    itemNumber: number,
    lease: AcquiredReviewStartLease,
    options?: { throwOnError?: boolean },
  ) => boolean;
  detectBulkFiler: (options: BulkFilerDetectionOptions) => BulkFilerDetectionResult;
  displayDurationMs: (ms: number) => string;
  displayPath: (path: string) => string;
  enforceExpectedIssueSourceRevision: (options: ExpectedIssueSourceRevisionOptions) => void;
  ensurePullRequestReviewHead: (options: {
    targetDir: string;
    itemNumber: number;
    headSha: string;
  }) => boolean;
  ensureDir: (path: string) => void;
  exactLocalReviewNoCandidateError: (
    itemNumber: number | undefined,
    shardIndex: number,
  ) => UserFacingCommandError;
  extractClawSweeperReviewCommentBody: (body: string) => PreviousClawSweeperReview;
  existingReview: (item: Pick<Item, "number" | "repo">, itemsDir: string) => ExistingReview | null;
  extractLatestClawSweeperReview: (
    comments: readonly unknown[],
    number: number,
  ) => PreviousClawSweeperReview | null;
  fetchIssueReviewComments: (number: number) => Record<string, unknown>[];
  fetchReviewStructuralRecord: (options: {
    onPullIdentity?: (identity: { baseSha: string; headSha: string }) => void;
    item: Item;
    git: GitInfo;
    reviewPolicy: string;
    reviewModel: string;
  }) => ReviewStructuralRecord | null;
  finishReviewActionLedger: (options: {
    ledger: ReviewActionLedger;
    error?: unknown;
    activeItem?: Item | null;
    completedCount: number;
    cacheHits: number;
  }) => void;
  finishReviewActionLedgerItem: (options: {
    ledger: ReviewActionLedger;
    item: Item;
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    retryable: boolean;
    cached: boolean;
    startedAtMs: number;
    sourceRevision?: string;
    reportPath?: string;
    findingCount?: number;
    completionReason?: string;
  }) => ActionEvent | null;
  freshDedicatedReviewStartLeases: (options: {
    comments: Record<string, unknown>[];
    itemNumber: number;
    headSha: string;
    nowMs: number;
  }) => Array<{
    comment: Record<string, unknown>;
    startedAt: string;
    expiresAt: string;
    owner: string | null;
    commentId: number | null;
  }>;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  gitInfo: (openclawDir: string, options?: ReviewGitInfoOptions) => GitInfo;
  isBulkFilerExemptAuthorAssociation: (value: unknown) => boolean;
  isBulkFilerExemptRepositoryPermission: (value: unknown) => boolean;
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
  isSuppliedReviewStartLease: (
    supplied: Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null,
    lease: Pick<AcquiredReviewStartLease, "owner" | "commentId">,
  ) => boolean;
  itemContentDigest: (item: Item, context: ItemContext, git?: GitInfo) => string;
  itemSnapshotHash: (item: Item, context: ItemContext) => string;
  liveClawSweeperReviewDigest: (number: number) => string | null;
  localExactReviewItem: (
    localOnly: boolean,
    itemNumber: number | undefined,
    itemNumbers: number[] | undefined,
  ) => itemNumber is number;
  localRangeHistoryApplies: (
    targetDir: string,
    reviewedSha: string | null,
    headSha: string,
  ) => boolean;
  localExactReviewHistoryPath: (artifactDir: string, repo: string, itemNumber: number) => string;
  makeTreeReadOnly: (path: string, snapshots?: FileModeSnapshot[]) => FileModeSnapshot[];
  materializePullRequestReviewTree: (options: {
    targetDir: string;
    worktreeDir: string;
    itemNumber: number;
    headSha: string;
  }) => boolean;
  markdownFor: (options: {
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
    reviewLeaseOwner?: string;
    reviewLeaseCommentId?: number;
  }) => string;
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
  previousClawSweeperReviewDigestFromReport: (markdown: string) => string | null;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  pullRequestHeadSha: (number: number) => string;
  recordReviewLogPublication: (options: {
    ledger: ReviewActionLedger;
    item: Item;
    codexWorkDir?: string;
    cached: boolean;
    missingStatus?: ActionEventStatus;
    missingReasonCode?: ActionEventReasonCode;
    retryable?: boolean;
  }) => ActionEvent | null;
  removePullRequestReviewTree: (options: { targetDir: string; worktreeDir: string }) => boolean;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  renderReviewCommentFromReport: (
    markdown: string,
    reason: "none",
    options?: { previousReviewCommentBody?: string },
  ) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  reportFileName: (repo: string, number: number) => string;
  reportReviewFindings: (markdown: string) => ReviewFinding[];
  resolveReviewCheckout: (options: {
    args: Args;
    artifactDir: string;
    humanLocalReview?: boolean;
    itemNumber: number | undefined;
    itemNumbers: number[] | undefined;
    localRange?: boolean;
    localOnly: boolean;
    profile: RepositoryProfile;
    verbose?: boolean;
  }) => ReviewCheckout;
  restoreTreeModes: (snapshots: readonly FileModeSnapshot[]) => void;
  reviewActionForDecision: (options: {
    item: Item;
    decision: Decision;
    git: GitInfo;
    runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
  }) => Action;
  reviewCodexForcedLoginMethod: (args: Args) => string;
  reviewLeaseStillMatchesContext: (
    itemKind: "issue" | "pull_request",
    contextPullHeadSha: string | null,
    leaseHeadSha: string,
  ) => boolean;
  reviewMutationRunner: (ledger: ReviewActionLedger, item: Item) => MutationRunner;
  reviewPolicyHash: (options: {
    model?: string;
    reasoningEffort?: string;
    sandboxMode?: string;
    serviceTier?: string;
  }) => string;
  reviewStructuralPullStateFromContext: (context: ItemContext) => ReviewStructuralPullState | null;
  runReviewCheckoutInspection: (options: {
    scanSource: AgentScanSource;
    initialPrompt: string;
    itemNumber: number;
    openclawDir: string;
    preserveCodexAuth?: boolean;
    timeoutMs: number;
  }) => CodexProcessResult;
  runCodex: (options: {
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
    timeoutMs: number;
    workDir: string;
    additionalPrompt?: string;
    proofScratchDir?: string;
    prompt?: string;
    quietLogs?: boolean;
    extraCodexConfig?: string[];
  }) => Decision;
  selectCandidates: (options: {
    batchSize: number;
    maxPages: number;
    shardIndex: number;
    shardCount: number;
    itemsDir: string;
    itemNumber?: number;
    itemNumbers?: number[];
    reviewPolicy?: string;
    hotIntake?: boolean;
    allowClosed?: boolean;
  }) => { candidates: Item[]; scannedPages: number };
  startReviewActionLedger: (options: {
    candidates: readonly Item[];
    reviewPolicy: string;
    shardIndex: number;
    shardCount: number;
    batchSize: number;
  }) => ReviewActionLedger;
  startReviewActionLedgerItem: (ledger: ReviewActionLedger, item: Item) => ActionEvent | null;
  stringOrUndefined: (value: unknown) => string | undefined;
  suppliedReviewStartLeaseFromArgs: (
    args: Args,
  ) => Pick<AcquiredReviewStartLease, "owner" | "commentId"> | null;
  targetRepo: () => string;
  updateBulkFilerDetectedFrontMatter: (
    markdown: string,
    detection: BulkFilerDetectionResult,
  ) => string;
  updateReviewStructuralFrontMatter: (
    markdown: string,
    record: ReviewStructuralRecord | null,
    cacheHit: boolean,
  ) => string;
}
