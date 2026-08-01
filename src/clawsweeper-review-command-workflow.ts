import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ActionEvent } from "./action-ledger.js";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "./action-ledger.js";
import { boolArg, itemNumbersArg, numberArg, stringArg, type Args } from "./clawsweeper-args.js";
import { mediaProofRuntimeHints, prepareMediaProofArtifacts } from "./clawsweeper-media-proof.js";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW_CODEX_TIMEOUT_MS,
  DEFAULT_SERVICE_TIER,
} from "./clawsweeper-policy.js";
import type {
  AcquiredReviewStartLease,
  Action,
  BulkFilerCountCache,
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
  PreparedMediaProof,
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
import { PUBLIC_CODEX_MODEL } from "./codex-env.js";
import { UserFacingCommandError } from "./command.js";
import {
  isolateGitHubConfigDir,
  LOCAL_REVIEW_WEB_SEARCH_CONFIG,
  localReviewAdditionalPrompt,
  scrubGitHubCredentialEnv,
} from "./commit-sweeper.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import { isReviewedPrActivityCursor } from "./review-activity-cursor.js";
import {
  createReviewSemanticRecord,
  reviewSemanticCacheDecision,
  reviewSemanticPriorReviewDigest,
  reviewSemanticRevalidationDecision,
  type ReviewSemanticRecord,
} from "./review-semantic-cache.js";
import type { ReviewStructuralPullState } from "./review-structural-cache.js";
import {
  reviewStructuralCacheDecision,
  reviewStructuralCacheProbeDecision,
  reviewStructuralRecordAtLeastAsFresh,
  reviewStructuralRecordMatchesHydratedItem,
  reviewStructuralRecordMatchesHydratedPull,
  reviewStructuralRecordMatchesObservedUpdate,
  reviewStructuralRecordsDescribeSameVerdictInput,
  type ReviewStructuralRecord,
} from "./review-structural-cache.js";
import { reviewContentCacheHit } from "./scheduler-policy.js";

interface CreateReviewCommandWorkflowDependencies {
  actionLedgerFailureDisposition: (error: unknown) => {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    completionReason: string;
  };
  actionLedgerItemKey: (item: Pick<Item, "repo" | "number">) => string;
  activeReviewMutationRunner: MutationRunner | null;
  asRecord: (value: unknown) => Record<string, unknown>;
  attachFixedPullRequest: (decision: Decision, item: Item, context: ItemContext) => Decision;
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
    },
  ) => ItemContext;
  commentId: (comment: Record<string, unknown> | undefined) => number | null;
  completePullChecksContext: (value: unknown) => boolean;
  DEFAULT_PLAN_BATCH_SIZE: 3;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  defaultLocalRangeArtifactDir: (targetDir: string) => string;
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
  ensureDir: (path: string) => void;
  exactLocalReviewNoCandidateError: (
    itemNumber: number | undefined,
    shardIndex: number,
  ) => UserFacingCommandError;
  existingReview: (item: Pick<Item, "number" | "repo">, itemsDir: string) => ExistingReview | null;
  extractLatestClawSweeperReview: (
    comments: readonly unknown[],
    number: number,
  ) => PreviousClawSweeperReview | null;
  fetchIssueReviewComments: (number: number) => Record<string, unknown>[];
  fetchReviewStructuralRecord: (options: {
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
  makeTreeReadOnly: (path: string, snapshots?: FileModeSnapshot[]) => FileModeSnapshot[];
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
    semanticRecord?: ReviewSemanticRecord | null;
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
  pullChecksContext: (number: number, headSha: string) => unknown;
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
  refreshRelatedItemsContext: (item: Item, context: ItemContext) => unknown[];
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
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
  updateReviewSemanticFrontMatter: (
    markdown: string,
    record: ReviewSemanticRecord | null,
    cacheHit: boolean,
  ) => string;
  updateReviewStructuralFrontMatter: (
    markdown: string,
    record: ReviewStructuralRecord | null,
    cacheHit: boolean,
  ) => string;
}

export function createReviewCommandWorkflow(dependencies: CreateReviewCommandWorkflowDependencies) {
  const {
    actionLedgerFailureDisposition,
    actionLedgerItemKey,
    asRecord,
    attachFixedPullRequest,
    authorIssueCountInBulkFilerWindow,
    buildLocalRangeReview,
    buildReviewPrompt,
    bulkFilerPolicyInvalidatesCachedReview,
    bulkFilerRepositoryPermission,
    codexFailureDecision,
    codexFailureLogKind,
    CodexReviewError,
    codexReviewFailureRetryable,
    collectItemContext,
    commentId,
    completePullChecksContext,
    DEFAULT_PLAN_BATCH_SIZE,
    defaultItemsDir,
    defaultLocalRangeArtifactDir,
    defaultReviewArtifactDir,
    deleteOwnedDedicatedReviewStartLease,
    detectBulkFiler,
    displayDurationMs,
    displayPath,
    enforceExpectedIssueSourceRevision,
    ensureDir,
    exactLocalReviewNoCandidateError,
    existingReview,
    extractLatestClawSweeperReview,
    fetchIssueReviewComments,
    fetchReviewStructuralRecord,
    finishReviewActionLedger,
    finishReviewActionLedgerItem,
    freshDedicatedReviewStartLeases,
    frontMatterValue,
    gitInfo,
    isBulkFilerExemptAuthorAssociation,
    isBulkFilerExemptRepositoryPermission,
    issueReviewCommentState,
    isSuppliedReviewStartLease,
    itemContentDigest,
    itemSnapshotHash,
    liveClawSweeperReviewDigest,
    localExactReviewItem,
    makeTreeReadOnly,
    markdownFor,
    postReviewStartStatusComment,
    previousClawSweeperReviewDigestFromReport,
    pullChecksContext,
    pullHeadShaFromContext,
    pullRequestHeadSha,
    recordReviewLogPublication,
    refreshRelatedItemsContext,
    replaceFrontMatterValue,
    repoFromArgs,
    reportFileName,
    reportReviewFindings,
    resolveReviewCheckout,
    restoreTreeModes,
    reviewActionForDecision,
    reviewCodexForcedLoginMethod,
    reviewLeaseStillMatchesContext,
    reviewMutationRunner,
    reviewPolicyHash,
    reviewStructuralPullStateFromContext,
    runCodex,
    selectCandidates,
    startReviewActionLedger,
    startReviewActionLedgerItem,
    stringOrUndefined,
    suppliedReviewStartLeaseFromArgs,
    targetRepo,
    updateBulkFilerDetectedFrontMatter,
    updateReviewSemanticFrontMatter,
    updateReviewStructuralFrontMatter,
  } = dependencies;

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
    const serviceTier = stringArg(
      args.codex_service_tier,
      localOnly ? "fast" : DEFAULT_SERVICE_TIER,
    );
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
    const releaseOwnedReviewLease = (
      itemNumber: number,
      lease: AcquiredReviewStartLease,
    ): boolean =>
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
        const previousReviewMutationRunner = dependencies.activeReviewMutationRunner;
        try {
        startReviewActionLedgerItem(reviewLedger, item);
        dependencies.activeReviewMutationRunner = reviewMutationRunner(reviewLedger, item);
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
            dependencies.activeReviewMutationRunner = previousReviewMutationRunner;
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
          const previousReviewMutationRunner = dependencies.activeReviewMutationRunner;
          dependencies.activeReviewMutationRunner = reviewMutationRunner(reviewLedger, state.item);
          try {
            releaseOwnedReviewLease(acquired.itemNumber, acquired.lease);
          } finally {
            dependencies.activeReviewMutationRunner = previousReviewMutationRunner;
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

  return { reviewCommand };
}
