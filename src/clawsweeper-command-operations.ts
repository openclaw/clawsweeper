import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { recordWorkflowPhaseEvent } from "./action-ledger-runtime.js";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEvent,
  type ActionEventEvidence,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEventSubject,
} from "./action-ledger.js";
import { createApplyActionLedger } from "./clawsweeper-apply-ledger.js";
import { boolArg, numberArg, stringArg, type Args } from "./clawsweeper-args.js";
import { createFailedReviewRetryWorkflow } from "./clawsweeper-failed-review-retry.js";
import { expireReviewStartStatusLease } from "./clawsweeper-review-comment-state.js";
import type {
  ExactReviewQueueAuthority,
  ExpectedIssueSourceRevisionOptions,
  FailedReviewRetryResult,
  FailedReviewRetryRevision,
  FailedReviewRetryRevisionKind,
  GitHubDispatchOutcome,
  GitHubRetryOptions,
  GitHubRuntimeBudget,
  Item,
  ItemKind,
  MutationRunner,
  ReconcileResult,
  ReviewActionLedger,
  ReviewArtifactDestination,
  ReviewStartStatusCommentResult,
} from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import { GitHubRateLimitError } from "./github-retry.js";
import { syncDecisionPacketRecord } from "./decision-packets.js";
import { captureCanonicalRecordBaseline } from "./repair/canonical-record-baseline.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import {
  generationReadKey,
  type LiveReadGeneration,
  type LiveReadOptions,
} from "./live-read-generation.js";

interface CreateCommandOperationsDependencies {
  actionLedgerFailureDisposition: (error: unknown) => {
    status: ActionEventStatus;
    reasonCode: ActionEventReasonCode;
    completionReason: string;
  };
  actionLedgerPrivacy: () => {
    classification: "internal";
    redactionVersion: string;
    fieldsDropped: readonly ["body", "comments", "diff", "logs", "patch", "prompt"];
  };
  appendSectionValue: (markdown: string, heading: string, value: string) => string;
  applyDecisionsCommandInner: (args: Args, runtimeBudget: GitHubRuntimeBudget) => void;
  artifactTargetIsOpen: (number: number, openNumbers: Set<number> | null) => boolean;
  codexFailureReason: (detail: string, errorCode?: string | null) => string;
  currentReviewRevision: (item: Item) => string;
  decisionPacketsDirFromArgs: (args: Args, itemsDir: string, closedDir: string) => string;
  defaultClosedDir: (profile?: RepositoryProfile) => string;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  defaultPlansDir: (profile?: RepositoryProfile) => string;
  effectiveReviewStatus: (markdown: string) => string;
  ensureDir: (path: string) => void;
  ensureGitHubRuntimeAvailable: (phase: string) => void;
  exactReviewQueueAuthorityFromEnv: (env?: NodeJS.ProcessEnv) => ExactReviewQueueAuthority | null;
  failedReviewFailureDetail: (markdown: string) => string;
  failedReviewRetryEligibility: (options: {
    markdown: string;
    liveState: string;
    liveLocked?: boolean;
    liveActiveLockReason?: string | null;
    liveHeadSha?: string | null;
    liveSourceRevision?: string | null;
    now: number;
    maxAttempts: number;
    cooldownMs: number;
  }) => FailedReviewRetryResult;
  failedReviewRetryResultRevision: (revision: FailedReviewRetryRevision) => {
    headSha?: string;
    revisionKind: FailedReviewRetryRevisionKind;
    revision: string;
  };
  failedReviewRetryRevisionForReport: (markdown: string) => FailedReviewRetryRevision | null;
  fetchItem: (number: number) => { item: Item; state: string };
  fetchOpenItemNumbers: (maxPages: number) => { numbers: Set<number>; pagesScanned: number };
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  ghJson: <T>(args: string[]) => T;
  ghPaged: <T>(path: string) => T[];
  ghRawOnceWithCheckpoint: (
    args: string[],
    onBeforeRun: () => void,
  ) => { outcome: "accepted"; output: string };
  ghWithRetry: (args: string[], attempts?: number, options?: GitHubRetryOptions) => string;
  GitHubDispatchError: new (
    outcome: Exclude<GitHubDispatchOutcome, "accepted">,
    cause: unknown,
  ) => Error & {
    readonly outcome: Exclude<GitHubDispatchOutcome, "accepted">;
    readonly cause: unknown;
  };
  GitHubRuntimeBudgetError: new (reason: string) => Error & { readonly reason: string };
  isFailedReviewRetryAlreadyExhausted: (
    markdown: string,
    revision: FailedReviewRetryRevision,
  ) => boolean;
  isMarkdownForActiveRepo: (markdown: string, file?: string) => boolean;
  itemSourceRevisionSha256: (issue: unknown, comments?: unknown[]) => string;
  lockedConversationApplyReason: (item: Pick<Item, "activeLockReason" | "locked">) => string | null;
  markdownFiles: (dir: string) => string[];
  markdownRepository: (markdown: string, file?: string) => string;
  numberForMarkdownFile: (file: string) => number;
  parseReportFileName: (file: string) => { repo: string | undefined; number: number } | null;
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
  reconcileFolders: (options: {
    itemsDir: string;
    closedDir: string;
    plansDir?: string;
    decisionPacketsDir?: string;
    canonicalBaselineDir?: string;
    repositorySlug?: string;
    maxPages?: number;
    dryRun?: boolean;
    fetchClosedAt?: boolean;
    preserveItemNumbers?: readonly number[];
  }) => ReconcileResult;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  replaceSectionValue: (markdown: string, heading: string, value: string) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  repoRelativePath: (path: string) => string;
  reportFileName: (repo: string, number: number) => string;
  reportItemKind: (markdown: string) => ItemKind | undefined;
  reviewActionLedger: {
    actionLedgerFailureDisposition: (error: unknown) => {
      status: ActionEventStatus;
      reasonCode: ActionEventReasonCode;
      completionReason: string;
    };
    actionLedgerFileDigestEvidence: (kind: string, filePath: string) => ActionEventEvidence | null;
    actionLedgerFileEvidence: (kind: string, filePath: string) => ActionEventEvidence | null;
    actionLedgerItemKey: (item: Pick<Item, "repo" | "number">) => string;
    actionLedgerItemSubject: (
      item: Item,
      options?: { sourceRevision?: string; recordPath?: string },
    ) => ActionEventSubject;
    actionLedgerPrivacy: () => {
      classification: "internal";
      redactionVersion: string;
      fieldsDropped: readonly ["body", "comments", "diff", "logs", "patch", "prompt"];
    };
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
    recordReviewLogPublication: (options: {
      ledger: ReviewActionLedger;
      item: Item;
      codexWorkDir?: string;
      cached: boolean;
      missingStatus?: ActionEventStatus;
      missingReasonCode?: ActionEventReasonCode;
      retryable?: boolean;
    }) => ActionEvent | null;
    reviewMutationRunner: (ledger: ReviewActionLedger, item: Item) => MutationRunner;
    startReviewActionLedger: (options: {
      candidates: readonly Item[];
      reviewPolicy: string;
      shardIndex: number;
      shardCount: number;
      batchSize: number;
    }) => ReviewActionLedger;
    startReviewActionLedgerItem: (ledger: ReviewActionLedger, item: Item) => ActionEvent | null;
    workflowRunEvidence: () => ActionEventEvidence[];
  };
  reviewArtifactDestination: (
    action: string | undefined,
    itemIsOpen: boolean,
  ) => ReviewArtifactDestination;
  reviewLeaseRevisionFromReport: (markdown: string) => string | null;
  ROOT: string;
  sameFailedReviewRetryRevision: (
    left: FailedReviewRetryRevision,
    right: FailedReviewRetryRevision,
  ) => boolean;
  sectionValue: (markdown: string, heading: string) => string;
  sha256: (text: string) => string;
  storedFailedReviewRetryRevision: (markdown: string) => FailedReviewRetryRevision | null;
  syncWorkPlanFromReport: (options: {
    markdown: string;
    reportPath: string;
    plansDir: string;
    dryRun?: boolean;
  }) => boolean;
  targetRepo: () => string;
  withGitHubRuntimeBudget: <T>(runtimeBudget: GitHubRuntimeBudget, operation: () => T) => T;
  workflowRunEvidence: () => ActionEventEvidence[];
  workPlanPathForReport: (file: string, plansDir?: string) => string;
}

export function createCommandOperations(dependencies: CreateCommandOperationsDependencies) {
  const {
    actionLedgerFailureDisposition,
    actionLedgerPrivacy,
    appendSectionValue,
    applyDecisionsCommandInner,
    artifactTargetIsOpen,
    codexFailureReason,
    currentReviewRevision,
    decisionPacketsDirFromArgs,
    defaultClosedDir,
    defaultItemsDir,
    defaultPlansDir,
    effectiveReviewStatus,
    ensureDir,
    ensureGitHubRuntimeAvailable,
    exactReviewQueueAuthorityFromEnv,
    failedReviewFailureDetail,
    failedReviewRetryEligibility,
    failedReviewRetryResultRevision,
    failedReviewRetryRevisionForReport,
    fetchItem,
    fetchOpenItemNumbers,
    frontMatterValue,
    ghJson,
    ghPaged,
    ghRawOnceWithCheckpoint,
    ghWithRetry,
    GitHubDispatchError,
    GitHubRuntimeBudgetError,
    isFailedReviewRetryAlreadyExhausted,
    isMarkdownForActiveRepo,
    itemSourceRevisionSha256,
    lockedConversationApplyReason,
    markdownFiles,
    markdownRepository,
    numberForMarkdownFile,
    parseReportFileName,
    postReviewStartStatusComment,
    reconcileFolders,
    replaceFrontMatterValue,
    replaceSectionValue,
    repoFromArgs,
    repoRelativePath,
    reportFileName,
    reportItemKind,
    reviewActionLedger,
    reviewArtifactDestination,
    reviewLeaseRevisionFromReport,
    ROOT,
    sameFailedReviewRetryRevision,
    sectionValue,
    sha256,
    storedFailedReviewRetryRevision,
    syncWorkPlanFromReport,
    targetRepo,
    withGitHubRuntimeBudget,
    workflowRunEvidence,
    workPlanPathForReport,
  } = dependencies;

  function expireReviewLeaseCommand(args: Args): void {
    repoFromArgs(args.repo === undefined ? args : { ...args, target_repo: args.repo });
    const itemNumber = numberArg(args.item_number, 0);
    const commentId = numberArg(args.comment_id, 0);
    if (![itemNumber, commentId].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new UserFacingCommandError("--item-number and --comment-id must be positive integers.");
    }
    const path = `repos/${targetRepo()}/issues/comments/${commentId}`;
    const comment = ghJson<{ body?: string; user?: { login?: string } }>(["api", path]);
    const body = comment.body ?? "";
    if (
      !["clawsweeper", "clawsweeper[bot]", "openclaw-clawsweeper[bot]"].includes(
        comment.user?.login ?? "",
      )
    )
      return;
    const expired = expireReviewStartStatusLease(body, new Date().toISOString(), itemNumber);
    if (expired !== body) {
      ghWithRetry(["api", path, "--method", "PATCH", "-f", `body=${expired}`]);
    }
  }

  function reserveReviewLeaseCommand(args: Args): void {
    repoFromArgs(args);
    const itemNumber = numberArg(args.item_number, 0);
    const reviewTimeoutMs = numberArg(args.review_timeout_ms, 0);
    if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
      throw new UserFacingCommandError("--item-number must be a positive integer.");
    }
    if (!Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs <= 0) {
      throw new UserFacingCommandError("--review-timeout-ms must be a positive integer.");
    }
    const { item, state } = fetchItem(itemNumber);
    if (state !== "open") {
      // The item was closed between enqueue and review (typically by the apply
      // lane or its author). The stale entry completes as a superseded no-op
      // rather than burning the item's review-failure budget.
      console.error(
        `Item #${itemNumber} is ${state}; completing the reservation as a superseded no-op.`,
      );
      console.log(JSON.stringify({ status: "superseded", reason: "item_not_open", state }));
      return;
    }
    const queueAuthority = exactReviewQueueAuthorityFromEnv();
    const expectedItemKey = `${targetRepo()}#${itemNumber}`.toLowerCase();
    if (queueAuthority && queueAuthority.itemKey.toLowerCase() !== expectedItemKey) {
      throw new UserFacingCommandError("Exact-review queue authority item does not match target.");
    }
    const currentRevision = currentReviewRevision(item);
    if (!currentRevision || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(currentRevision)) {
      throw new UserFacingCommandError(
        `Could not resolve the current review revision for #${itemNumber}.`,
      );
    }
    if (
      queueAuthority?.sourceHeadSha &&
      item.kind === "pull_request" &&
      queueAuthority.sourceHeadSha !== currentRevision
    ) {
      // The PR moved past the queued head. The push that moved it enqueues its
      // own exact-head event (and the scheduled sweep backstops a lost webhook),
      // so this stale entry completes as a superseded no-op instead of burning
      // the item's review-failure budget.
      console.error(
        `Exact-review queue authority source head ${queueAuthority.sourceHeadSha} does not match the current pull request head ${currentRevision}; completing as superseded.`,
      );
      console.log(JSON.stringify({ status: "superseded", reason: "source_head_drift" }));
      return;
    }
    const reservationAuthority =
      queueAuthority && item.kind === "pull_request" && !queueAuthority.sourceHeadSha
        ? { ...queueAuthority, sourceHeadSha: currentRevision }
        : queueAuthority;
    const result = postReviewStartStatusComment({
      item,
      headSha: currentRevision,
      reviewTimeoutMs,
      position: 1,
      total: 1,
      shardIndex: 0,
      shardCount: 1,
      queueAuthority: reservationAuthority,
      allowSupersededLeaseCleanup:
        item.kind !== "pull_request" || Boolean(queueAuthority?.sourceHeadSha),
    });
    if (result.status === "held") {
      console.log(JSON.stringify({ status: "held", retryAt: result.retryAt }));
      return;
    }
    console.log(
      JSON.stringify({
        status: "posted",
        owner: result.lease.owner,
        commentId: result.lease.commentId,
        headSha: result.lease.headSha,
      }),
    );
  }

  const SOURCE_REVISION_MISMATCH_MARKER = "source-revision-mismatch.json";

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

  function enforceExpectedIssueSourceRevisionForTest(
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

  function liveIssueSourceRevision(
    number: number,
    options: LiveReadOptions & { liveReadGeneration?: LiveReadGeneration } = {},
  ): string {
    const issueArgs = ["api", `repos/${targetRepo()}/issues/${number}`];
    const commentsPath = `repos/${targetRepo()}/issues/${number}/comments`;
    const issue = options.liveReadGeneration
      ? options.liveReadGeneration.read(
          generationReadKey("json", issueArgs),
          () => ghJson<unknown>(issueArgs),
          options,
        )
      : ghJson<unknown>(issueArgs);
    const comments = options.liveReadGeneration
      ? options.liveReadGeneration.read(
          generationReadKey("paged", [commentsPath]),
          () => ghPaged<unknown>(commentsPath),
          options,
        )
      : ghPaged<unknown>(commentsPath);
    return itemSourceRevisionSha256(issue, comments);
  }

  const failedReviewRetryWorkflow = createFailedReviewRetryWorkflow({
    root: ROOT,
    appendSectionValue,
    codexFailureReason,
    defaultItemsDir,
    effectiveReviewStatus,
    ensureDir,
    ensureGitHubRuntimeAvailable,
    failedReviewFailureDetail,
    failedReviewRetryEligibility,
    failedReviewRetryResultRevision,
    failedReviewRetryRevisionForReport,
    fetchItem,
    frontMatterValue,
    ghRawOnceWithCheckpoint,
    ghWithRetry,
    isDispatchError: (
      error,
    ): error is InstanceType<CreateCommandOperationsDependencies["GitHubDispatchError"]> =>
      error instanceof GitHubDispatchError,
    isFailedReviewRetryAlreadyExhausted,
    isMarkdownForActiveRepo,
    isRuntimeBudgetError: (
      error,
    ): error is InstanceType<CreateCommandOperationsDependencies["GitHubRuntimeBudgetError"]> =>
      error instanceof GitHubRuntimeBudgetError,
    liveIssueSourceRevision,
    livePullHeadSha,
    lockedConversationApplyReason,
    markdownFiles,
    numberForMarkdownFile,
    replaceFrontMatterValue,
    replaceSectionValue,
    repoFromArgs,
    repoRelativePath,
    reportItemKind,
    reviewLeaseRevisionFromReport,
    reviewLedger: reviewActionLedger,
    sameFailedReviewRetryRevision,
    sectionValue,
    storedFailedReviewRetryRevision,
    targetRepo,
    withGitHubRuntimeBudget,
  });

  const {
    preserveFailedReviewRetryMetadataForTest,
    reviewRetryActionDisposition,
    reviewRetryActionNeedsItemEventForTest,
    reviewRetryBatchEventDisposition,
    reviewRetryBusinessIdempotencyIdentityForTest,
  } = failedReviewRetryWorkflow;

  const {
    failedReviewRetryMarkdownWithState,
    failedReviewRetryStatePath,
    preserveFailedReviewRetryMetadata,
    readFailedReviewRetryState,
    retryFailedReviewsCommand,
  } = failedReviewRetryWorkflow;

  const applyActionLedger = createApplyActionLedger({
    root: ROOT,
    targetRepo,
    repoRelativePath,
    sha256,
    frontMatterValue,
    reviewLeaseRevisionFromReport,
    reportItemKind,
    reviewLedger: reviewActionLedger,
  });

  const {
    applyActionEventDisposition,
    applyItemBusinessIdempotencyIdentityForTest,
    applyMutationBusinessIdempotencyIdentityForTest,
    applyPhaseSequenceForTest,
    applyRuntimeBudgetYieldResultsForTest,
    reviewCommentPublicationEventDisposition,
  } = applyActionLedger;

  const {
    applyRuntimeBudgetYieldResults,
    finishApplyMutationAttempt,
    recordApplyActionEvents,
    recordApplyActionLedgerItemResults,
    recordApplyMutationBoundary,
    startApplyActionLedger,
    startApplyActionLedgerItem,
    startApplyMutationAttempt,
  } = applyActionLedger;

  function applyRuntimeBudget(
    configuredMaxRuntimeMs: number,
    tokenDeadlineText: string | undefined,
    nowMs = Date.now(),
  ): GitHubRuntimeBudget {
    if (!tokenDeadlineText) {
      return { startedAtMs: nowMs, maxRuntimeMs: configuredMaxRuntimeMs };
    }
    if (!/^\d+$/.test(tokenDeadlineText)) {
      throw new Error(
        "CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS must be a Unix timestamp in milliseconds",
      );
    }
    const tokenDeadlineMs = Number(tokenDeadlineText);
    if (!Number.isSafeInteger(tokenDeadlineMs)) {
      throw new Error("CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS is outside the safe integer range");
    }
    const remainingMs = tokenDeadlineMs - nowMs;
    if (remainingMs <= 0) {
      return {
        startedAtMs: nowMs - 1,
        maxRuntimeMs: 1,
        limitReason: `apply token budget reached at ${tokenDeadlineMs}ms since epoch`,
      };
    }
    if (configuredMaxRuntimeMs > 0 && configuredMaxRuntimeMs <= remainingMs) {
      return { startedAtMs: nowMs, maxRuntimeMs: configuredMaxRuntimeMs };
    }
    return {
      startedAtMs: nowMs,
      maxRuntimeMs: remainingMs,
      limitReason: `apply token budget reached at ${tokenDeadlineMs}ms since epoch`,
    };
  }

  function applyRuntimeBudgetForTest(options: {
    configuredMaxRuntimeMs: number;
    tokenDeadlineMs?: number;
    nowMs: number;
  }): Pick<GitHubRuntimeBudget, "startedAtMs" | "maxRuntimeMs" | "limitReason"> {
    return applyRuntimeBudget(
      options.configuredMaxRuntimeMs,
      options.tokenDeadlineMs === undefined ? undefined : String(options.tokenDeadlineMs),
      options.nowMs,
    );
  }

  function applyDecisionsCommand(args: Args): void {
    const runtimeBudget = applyRuntimeBudget(
      numberArg(args.max_runtime_ms, 0),
      process.env.CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS,
    );
    withGitHubRuntimeBudget(runtimeBudget, () => {
      try {
        applyDecisionsCommandInner(args, runtimeBudget);
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError && runtimeBudget.onYield) {
          runtimeBudget.onYield(error.reason);
          return;
        }
        if (error instanceof GitHubRateLimitError && runtimeBudget.onYield) {
          // Quota exhaustion is the same "out of resource, resume next cycle"
          // situation as a runtime-budget stop: closes are per-item verified
          // and checkpointed, comment sync is idempotent, and the cursor trace
          // returns the interrupted item to the next scheduled window. Failing
          // loudly here only discarded the rest of the scan window.
          runtimeBudget.onYield(
            `GitHub rate limited until ${error.retryAt}; credential scope ${error.scope}; reset source ${error.provenance}; apply resumes next cycle`,
          );
          return;
        }
        runtimeBudget.onFailure?.(error);
        throw error;
      }
    });
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

  function applyArtifactsCommand(args: Args): void {
    const profile = repoFromArgs(args);
    const artifactDir = resolve(stringArg(args.artifact_dir, "artifacts"));
    const recordRoot = resolve(stringArg(args.record_root, ROOT));
    const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
    const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
    const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
    const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
    const canonicalBaselineDir = stringArg(
      args.canonical_record_baseline_dir,
      process.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR ?? "",
    ).trim();
    const skipReconcile = boolArg(args.skip_reconcile);
    const replayClosedArtifacts = boolArg(args.replay_closed_artifacts);
    const maxPages = numberArg(args.max_pages, 250);
    let appliedArtifacts = 0;
    let skippedClosedArtifacts = 0;
    const operationIdentity = {
      repository: targetRepo(),
      artifactDir: repoRelativePath(artifactDir),
      itemsDir: repoRelativePath(itemsDir),
      closedDir: repoRelativePath(closedDir),
    };
    const publicationStart = recordWorkflowPhaseEvent(ROOT, {
      phase: ACTION_EVENT_TYPES.reviewLogPublication,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "review_publication_start" },
      operation: "review_publication",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "review_publication_start" },
      component: "apply_artifacts",
      subject: {
        repository: targetRepo(),
        kind: "publication",
      },
      evidence: workflowRunEvidence(),
      attributes: {
        publication_kind: "review_record",
      },
      privacy: actionLedgerPrivacy(),
    });
    let publicationIndex = 0;
    let publicationTerminal = false;
    let activePublication: {
      markdown: string;
      reportPath: string;
      number: number;
      destination: string;
      mutation: boolean;
    } | null = null;
    const recordPublication = (options: {
      markdown: string;
      reportPath: string;
      number: number;
      status: ActionEventStatus;
      reasonCode: ActionEventReasonCode;
      mutation: boolean;
      destination: string;
    }): void => {
      const kind = reportItemKind(options.markdown);
      if (!kind) return;
      const sourceRevision = reviewLeaseRevisionFromReport(options.markdown);
      const recordPath = repoRelativePath(options.reportPath);
      recordWorkflowPhaseEvent(ROOT, {
        phase: ACTION_EVENT_TYPES.reviewLogPublication,
        status: options.status,
        reasonCode: options.reasonCode,
        retryable:
          options.status === ACTION_EVENT_STATUSES.failed ||
          options.status === ACTION_EVENT_STATUSES.yielded ||
          options.status === ACTION_EVENT_STATUSES.cancelled,
        mutation: options.mutation,
        identity: {
          slot: "review_publication",
          index: publicationIndex,
          number: options.number,
        },
        operation: "review_publication",
        operationIdentity,
        parentEventId: publicationStart?.event_id ?? null,
        phaseSeq: 10 + publicationIndex,
        idempotencyIdentity: {
          operationIdentity,
          slot: "review_publication",
          index: publicationIndex,
          number: options.number,
        },
        component: "apply_artifacts",
        subject: {
          repository: targetRepo(),
          kind,
          number: options.number,
          ...(sourceRevision ? { sourceRevision } : {}),
          ...(recordPath.startsWith("../") ? {} : { recordPath }),
        },
        evidence: [
          ...workflowRunEvidence(),
          {
            kind: "review_record",
            sha256: sha256(options.markdown),
            ...(recordPath.startsWith("../") ? {} : { reportPath: recordPath }),
          },
        ],
        attributes: {
          publication_kind: "review_record",
          log_kind: "review",
          log_count: 1,
          state: options.destination,
        },
        privacy: actionLedgerPrivacy(),
      });
      publicationIndex += 1;
    };
    const finishPublication = (error?: unknown, interruptedMutation = false): void => {
      if (publicationTerminal) return;
      const failure = error === undefined ? null : actionLedgerFailureDisposition(error);
      recordWorkflowPhaseEvent(ROOT, {
        phase: ACTION_EVENT_TYPES.reviewLogPublication,
        status: failure
          ? failure.status
          : appliedArtifacts === 0 && skippedClosedArtifacts > 0
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.completed,
        reasonCode: failure
          ? failure.reasonCode
          : appliedArtifacts === 0
            ? ACTION_EVENT_REASON_CODES.noChanges
            : ACTION_EVENT_REASON_CODES.completed,
        retryable: failure !== null,
        mutation: appliedArtifacts > 0 || interruptedMutation,
        identity: { slot: "review_publication_terminal" },
        operation: "review_publication",
        operationIdentity,
        parentEventId: publicationStart?.event_id ?? null,
        phaseSeq: 1_000_000,
        idempotencyIdentity: { operationIdentity, slot: "review_publication_terminal" },
        component: "apply_artifacts",
        subject: {
          repository: targetRepo(),
          kind: "publication",
        },
        evidence: workflowRunEvidence(),
        attributes: {
          action_count: appliedArtifacts,
          skipped_count: skippedClosedArtifacts,
          failed_count: failure ? 1 : 0,
          publication_kind: "state_worktree",
          partial:
            failure !== null
              ? appliedArtifacts > 0 || interruptedMutation
              : skippedClosedArtifacts > 0 && appliedArtifacts > 0,
          completion_reason: failure
            ? failure.completionReason
            : appliedArtifacts === 0
              ? "no_changes"
              : "completed",
        },
        privacy: actionLedgerPrivacy(),
      });
      publicationTerminal = true;
    };
    try {
      ensureDir(itemsDir);
      ensureDir(closedDir);
      const openNumbers = skipReconcile ? null : fetchOpenItemNumbers(maxPages).numbers;
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
            recordPublication({
              markdown,
              reportPath: source,
              number,
              status: ACTION_EVENT_STATUSES.skipped,
              reasonCode: ACTION_EVENT_REASON_CODES.stateChanged,
              mutation: false,
              destination,
            });
            skippedClosedArtifacts += 1;
            continue;
          }
          const destinationDir = destination === "closed" ? closedDir : itemsDir;
          const reportPath = join(destinationDir, destinationFile);
          activePublication = {
            markdown,
            reportPath,
            number,
            destination,
            mutation: false,
          };
          if (canonicalBaselineDir) {
            const packetName = `${number}.json`;
            captureCanonicalRecordBaseline({
              baselineRoot: canonicalBaselineDir,
              repositorySlug: profile.slug,
              itemNumber: number,
              sources: [
                { section: "items", name: destinationFile, path: join(itemsDir, destinationFile) },
                {
                  section: "closed",
                  name: destinationFile,
                  path: join(closedDir, destinationFile),
                },
                { section: "plans", name: destinationFile, path: join(plansDir, destinationFile) },
                {
                  section: "decision-packets",
                  name: packetName,
                  path: join(decisionPacketsDir, packetName),
                },
              ],
            });
          }
          const stalePath = join(
            destinationDir === itemsDir ? closedDir : itemsDir,
            destinationFile,
          );
          if (existsSync(stalePath)) {
            unlinkSync(stalePath);
            activePublication.mutation = true;
          }
          if (existsSync(reportPath)) {
            markdown = preserveFailedReviewRetryMetadata(
              readFileSync(reportPath, "utf8"),
              markdown,
            );
          }
          activePublication.mutation = true;
          const syncedMarkdown = syncDecisionPacketRecord({
            markdown,
            reportPath,
            packetsDir: decisionPacketsDir,
            repoRoot: recordRoot,
            subjectState: destination === "closed" ? "closed" : "open",
          }).markdown;
          activePublication.markdown = syncedMarkdown;
          writeFileSync(reportPath, syncedMarkdown, "utf8");
          if (destination === "closed") {
            const planPath = workPlanPathForReport(reportPath, plansDir);
            if (existsSync(planPath)) unlinkSync(planPath);
          } else {
            syncWorkPlanFromReport({ markdown: syncedMarkdown, reportPath, plansDir });
          }
          recordPublication({
            markdown: syncedMarkdown,
            reportPath,
            number,
            status: ACTION_EVENT_STATUSES.completed,
            reasonCode: ACTION_EVENT_REASON_CODES.completed,
            mutation: true,
            destination,
          });
          activePublication = null;
          appliedArtifacts += 1;
        }
      }
      console.error(
        `[apply-artifacts] applied=${appliedArtifacts} skipped_closed=${skippedClosedArtifacts}`,
      );
      if (!skipReconcile)
        reconcileFolders({
          itemsDir,
          closedDir,
          plansDir,
          decisionPacketsDir,
          ...(canonicalBaselineDir ? { canonicalBaselineDir, repositorySlug: profile.slug } : {}),
        });
      finishPublication();
    } catch (error) {
      const interruptedMutation = activePublication?.mutation ?? false;
      if (activePublication) {
        recordPublication({
          markdown: activePublication.markdown,
          reportPath: activePublication.reportPath,
          number: activePublication.number,
          status: actionLedgerFailureDisposition(error).status,
          reasonCode: actionLedgerFailureDisposition(error).reasonCode,
          mutation: interruptedMutation,
          destination: activePublication.destination,
        });
        activePublication = null;
      }
      finishPublication(error, interruptedMutation);
      throw error;
    }
  }

  return {
    applyActionEventDisposition,
    applyArtifactsCommand,
    applyDecisionsCommand,
    applyItemBusinessIdempotencyIdentityForTest,
    applyMutationBusinessIdempotencyIdentityForTest,
    applyPhaseSequenceForTest,
    applyRuntimeBudgetForTest,
    applyRuntimeBudgetYieldResults,
    applyRuntimeBudgetYieldResultsForTest,
    enforceExpectedIssueSourceRevision,
    enforceExpectedIssueSourceRevisionForTest,
    failedReviewRetryMarkdownWithState,
    failedReviewRetryStatePath,
    finishApplyMutationAttempt,
    liveIssueSourceRevision,
    orderedApplyItemNumbers,
    preserveFailedReviewRetryMetadataForTest,
    readFailedReviewRetryState,
    recordApplyActionEvents,
    recordApplyActionLedgerItemResults,
    recordApplyMutationBoundary,
    reserveReviewLeaseCommand,
    expireReviewLeaseCommand,
    retryFailedReviewsCommand,
    reviewCommentPublicationEventDisposition,
    reviewRetryActionDisposition,
    reviewRetryActionNeedsItemEventForTest,
    reviewRetryBatchEventDisposition,
    reviewRetryBusinessIdempotencyIdentityForTest,
    startApplyActionLedger,
    startApplyActionLedgerItem,
    startApplyMutationAttempt,
  };
}
