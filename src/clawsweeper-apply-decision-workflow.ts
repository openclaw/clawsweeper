import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { reportPublicationPolicy } from "./manual-publication-policy.js";
import { assertManualPublicationAuthority } from "./manual-publication-authority.js";
import { createApplyCandidateGuards } from "./clawsweeper-apply-candidate-guards.js";
import { executeApplyClose } from "./clawsweeper-apply-close-execution.js";
import {
  createApplyCloseGuards,
  isGuardedApplyReviewAction,
  markLockedConversationApplySkipped,
  requiresLockedReviewCommentMutation,
} from "./clawsweeper-apply-close-guards.js";
import { evaluateApplyClosePolicy } from "./clawsweeper-apply-close-policies.js";
import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { createApplyLeaseGuards } from "./clawsweeper-apply-lease-guards.js";
import {
  type ApplySelfMutationItemReceipt,
  createApplyProofFreshnessGuards,
} from "./clawsweeper-apply-proof-freshness.js";
import { syncApplyPullRequestLabels } from "./clawsweeper-apply-pull-request-labels.js";
import { promoteApplyPullRequest } from "./clawsweeper-apply-pull-request-promotion.js";
import { syncApplyReportLabels } from "./clawsweeper-apply-report-labels.js";
import { createApplyReviewActivityGuard } from "./clawsweeper-apply-review-activity.js";
import { createApplyReviewGuards } from "./clawsweeper-apply-review-guards.js";
import {
  applyReviewedSourceDriftEvidence,
  createApplyChangedSinceReviewMarker,
  createApplySourceFreshness,
} from "./clawsweeper-apply-source-freshness.js";
import { createApplyRecordOperations } from "./clawsweeper-apply-records.js";
import {
  boolArg,
  itemNumbersArg,
  numberArg,
  optionalNumberArg,
  stringArg,
  type Args,
} from "./clawsweeper-args.js";
import {
  DAY_MS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SERVICE_TIER,
  STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
} from "./clawsweeper-policy.js";
import { rawCommentBody } from "./clawsweeper-review-comments.js";
import { DurableReviewPublicationBlockedError } from "./clawsweeper-review-comment-publication.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import type {
  AcquiredReviewStartLease,
  ActionTaken,
  ApplyResult,
  BulkFilerRepositoryPermissionCache,
  CloseReason,
  GitHubRuntimeBudget,
  ItemContext,
  PrCloseCoverageProofGateBlock,
  PrStatusLabelKind,
  ReportEntry,
  ReviewCommentRenderOptions,
} from "./clawsweeper-types.js";
import {
  maintainerDecisionFromReport,
  type DecisionPacketSubjectState,
  type MaintainerDecision,
} from "./decision-packets.js";
import {
  GitHubRateLimitError,
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";
import { type PrCloseCoverageProofRuntime } from "./pr-close-coverage-proof.js";
import {
  compareReviewedPrActivityCursors,
  isReviewedPrActivityCursor,
} from "./review-activity-cursor.js";
import {
  clearResolvedReviewRecoveryLabel,
  REVIEW_RECOVERY_STUCK_LABEL,
} from "./review-recovery-label-backfill.js";
import { isAutoCloseAllowed, repositoryProfileFor } from "./repository-profiles.js";
import { stableJson } from "./stable-json.js";
import { LiveReadGeneration, type GenerationBoundValue } from "./live-read-generation.js";
import { parsePrHydrationSnapshot } from "./pr-hydration-snapshot.js";

export function createApplyDecisionWorkflow(dependencies: CreateApplyDecisionWorkflowDependencies) {
  const {
    actionLedgerItemKey,
    applyBlockingProtectedLabels,
    applyKindArg,
    ApplyMutationReviewGuardError,
    CLAWSWEEPER_BOT_AUTHORS,
    applyPrCloseCoverageProofBlockedReport,
    applyProtectedLabelReason,
    applyRuntimeBudgetYieldResults,
    beginIssueLabelMutationBatch,
    closeReasonApplyAgeSkipReason,
    closeReasonEnabled,
    closeReasonFilterText,
    closeReasonsArg,
    closingPullRequestsForIssue,
    collectItemContext,
    commentBodyMatches,
    commentId,
    commentUpdatedAt,
    completeStaleCanonicalCommentSyncReport,
    contextHasNonAutomationActivityAfter,
    decisionPacketsDirFromArgs,
    defaultClosedDir,
    defaultItemsDir,
    defaultPlansDir,
    deleteOwnedDedicatedReviewStartLease,
    discardIssueLabelMutationBatch,
    duplicateCanonicalPullRequestBlockReason,
    ensureDir,
    exactEventReviewLeaseDisposition,
    fetchItem,
    fetchReviewedPrActivityCursor,
    finishApplyMutationAttempt,
    flushIssueLabelMutationBatch,
    freshPullRequestReviewHead,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
    GitHubRuntimeBudgetError,
    guardedOpenApplyProofFields,
    hasVerifiedLocalCheckoutAccess,
    isApplyCloseCandidateReport,
    isLiveRecheckCloseGuardReport,
    isMaintainerAuthorAssociation,
    isPairBlockedCloseReport,
    isRetryableCloseSkipReport,
    isRetryableKeptOpenCloseReport,
    isRetryablePrCloseCoverageProofReport,
    issueReviewComment,
    isVerifiedFixedCloseReason,
    liveIssueSourceRevision,
    login,
    lockedConversationApplyReason,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    markedReviewCommentBody,
    mutationErrorMessage,
    normalizeAuthorAssociation,
    normalizeLabelName,
    openClosingPullRequestApplyReason,
    orderedApplyItemNumbers,
    pairCloseKey,
    PR_CLOSE_COVERAGE_PROOF_SCHEMA_PATH,
    prAutoCloseExemptDecisionReason,
    prCloseCoverageProofPromptTemplate,
    pullHeadShaFromContext,
    recordApplyActionEvents,
    recordApplyActionLedgerItemResults,
    recordApplyMutationBoundary,
    resetGuardReadCache,
    setGuardReadGeneration,
    removeCurrentCursorTraceItem,
    removeIssueLabel,
    renderReviewCommentFromReport,
    replaceFrontMatterValue,
    repoFromArgs,
    reportDecision,
    reportEntriesForDir,
    reviewCommentBodyDigest,
    reviewCommentHashMatches,
    reviewLeaseRevisionFromReport,
    reviewSectionValue,
    ROOT,
    runtimeBudgetExceeded,
    sameAuthorCounterpartApplyReason,
    shouldProbeClosedStateReport,
    shouldSyncReviewComment,
    staleCanonicalCommentSyncPendingReason,
    stalePullRequestReviewComment,
    stalePullRequestReviewHead,
    startApplyActionLedger,
    startApplyActionLedgerItem,
    startApplyMutationAttempt,
    syncWorkPlanFromReport,
    targetRepo,
    updateReviewCommentMetadata,
    upsertReviewComment,
    validateCloseDecision,
    withGuardReadOptions,
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
    const requestedSyncCommentsOnly = syncCommentsOnly;
    const requestedSuppressAutomationMarkers = suppressAutomationMarkers;
    const emitEventApplyProof = boolArg(args.event_apply_proof);
    const exactEventPublication = boolArg(args.exact_event_publication);
    const commentSyncMinAgeDays = numberArg(args.comment_sync_min_age_days, 0);
    const reportPath = resolve(stringArg(args.report_path, join(ROOT, "apply-report.json")));
    const artifactDir = resolve(stringArg(args.artifact_dir, join(ROOT, "artifacts", "apply")));
    const cursorTraceArg = stringArg(args.cursor_trace, "").trim();
    const cursorTracePath = cursorTraceArg ? resolve(cursorTraceArg) : null;
    const commentSyncCursor = optionalNumberArg(args.comment_sync_cursor);
    if (
      commentSyncCursor !== undefined &&
      (!Number.isSafeInteger(commentSyncCursor) || commentSyncCursor < 0)
    ) {
      throw new Error("Invalid --comment-sync-cursor");
    }
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
    const advancingCommentSyncNumbers =
      commentSyncCursor === undefined
        ? []
        : requestedItemNumbers.filter((number) => number > commentSyncCursor);
    const commentSyncFrontier =
      commentSyncCursor === undefined || requestedItemNumbers.length === 0
        ? undefined
        : Math.min(
            ...(advancingCommentSyncNumbers.length > 0
              ? advancingCommentSyncNumbers
              : requestedItemNumbers),
          );
    const results: ApplyResult[] = [];
    const examinedItemNumbers: number[] = [];
    let closedCount = 0;
    let processedCount = 0;
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
    const {
      applyReportEntriesForDir,
      createOpenReportLookup,
      captureApplyCanonicalBaseline,
      syncDecisionPacketMarkdown,
      writeReportMarkdown,
    } = createApplyRecordOperations({
      ...dependencies,
      applyKind,
      canonicalBaselineDir,
      closedDir,
      decisionPacketsDir,
      dryRun,
      itemsDir,
      plansDir,
      profile,
      recordRoot,
      requestedItemNumberSet,
      syncCommentsOnly,
    });

    const fileEntries = applyReportEntriesForDir(itemsDir, "items").sort(
      commentSyncFrontier !== undefined
        ? (left, right) =>
            Number(right.number === commentSyncFrontier) -
              Number(left.number === commentSyncFrontier) ||
            (requestedItemOrderIndex.get(left.number) ?? Number.MAX_SAFE_INTEGER) -
              (requestedItemOrderIndex.get(right.number) ?? Number.MAX_SAFE_INTEGER) ||
            left.number - right.number
        : cursorTracePath
          ? (left, right) =>
              (requestedItemOrderIndex.get(left.number) ?? Number.MAX_SAFE_INTEGER) -
                (requestedItemOrderIndex.get(right.number) ?? Number.MAX_SAFE_INTEGER) ||
              left.number - right.number
          : (left, right) =>
              left.priority - right.priority ||
              left.applyCheckedAt - right.applyCheckedAt ||
              left.number - right.number,
    );
    const boundedExactSelection = exactEventPublication && requestedItemNumberSet.size > 0;
    const openReportEntry = createOpenReportLookup(fileEntries, boundedExactSelection);
    const pairedIssueCloseoutReportKeys = new Set<string>();
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
        ({ mutationOccurred: _mutationOccurred, commentMutationOccurred, ...result }) => ({
          ...result,
          ...(emitEventApplyProof &&
          result.action === "kept_open" &&
          commentMutationOccurred === true
            ? { commentMutationOccurred: true }
            : {}),
        }),
      );
      let publicationError: unknown = null;
      try {
        ensureDir(dirname(reportPath));
        writeFileSync(reportPath, JSON.stringify(publicResults, null, 2), "utf8");
        writeCursorTrace();
      } catch (error) {
        publicationError = error;
      }
      // Reload current run evidence, including interrupted paired mutations, without
      // retaining unrelated open records or the full archived history.
      const finalEntryNumbers = new Set([
        ...requestedItemNumberSet,
        ...results.flatMap((result) => (result.number > 0 ? [result.number] : [])),
        ...[...applyLedger.items.values()]
          .filter((state) => state.started && !state.terminal)
          .map((state) => state.entry.number),
        ...(activeApplyItem ? [activeApplyItem.number] : []),
      ]);
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
        if (error instanceof GitHubRateLimitError) throw error;
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
      `starting apply: files=${fileEntries.length} dry_run=${dryRun} apply_kind=${applyKind} min_age=${minAgeDescription} apply_close_reasons=${closeReasonFilterText(applyCloseReasons)} stale_min_age_days=${staleMinAgeDays} close_delay_ms=${closeDelayMs} sync_comments_only=${syncCommentsOnly} suppress_automation_markers=${suppressAutomationMarkers} comment_sync_min_age_days=${commentSyncMinAgeDays} comment_sync_cursor=${commentSyncCursor ?? "none"} max_runtime_ms=${maxRuntimeMs} item_numbers=${requestedItemNumbers.join(",") || "all"} reconciliation_deferred=${[...reconciliationDeferredItemNumbers].join(",") || "none"}`,
    );
    // oxfmt-ignore
    for (const entry of fileEntries) {
      if (pairedIssueCloseoutReportKeys.has(pairCloseKey(entry.repo, entry.number))) continue;
      releaseActiveApplyMutationLease();
      resetGuardReadCache();
      const file = entry.name;
      const path = entry.path;
      if (runtimeBudgetExceeded(startedAtMs, maxRuntimeMs, Date.now())) {
        const reason =
          runtimeBudget.limitReason ?? `max runtime ${maxRuntimeMs}ms reached`;
        runtimeBudget.onYield?.(reason, false);
        return;
      }
      let markdown = entry.markdown;
      const restrictedPublication = Boolean(reportPublicationPolicy(markdown));
      // Background apply has no publication claim. Canonical restrictions outlive
      // queue completion, so only the exact publisher can sync this report.
      if (restrictedPublication && !exactEventPublication) continue;
      if (restrictedPublication) assertManualPublicationAuthority(markdown, entry.repo, entry.number);
      const syncCommentsOnly = restrictedPublication || requestedSyncCommentsOnly;
      const suppressAutomationMarkers = restrictedPublication || requestedSuppressAutomationMarkers;
      const repo = entry.repo;
      const number = entry.number;
      let mutationLedgerEntry: ReportEntry = entry;
      const liveReadGeneration = new LiveReadGeneration();
      setGuardReadGeneration(liveReadGeneration);
      const fetchApplyItem = (
        itemNumber: number,
        options: { bypassGenerationCache?: boolean } = {},
      ) => fetchItem(itemNumber, { ...options, liveReadGeneration });
      const collectApplyItemContext = (
        contextItem: Parameters<typeof collectItemContext>[0],
        options: NonNullable<Parameters<typeof collectItemContext>[1]> = {},
      ) => collectItemContext(contextItem, { ...options, liveReadGeneration });
      const applyReadDependencies: CreateApplyDecisionWorkflowDependencies = {
        ...dependencies,
        fetchItem: fetchApplyItem,
        collectItemContext: collectApplyItemContext,
      };
      activeApplyItem = { repo, number, mutationOccurred: false };
      startApplyActionLedgerItem(applyLedger, entry);
      const applyItemResultStart = results.length;
      let applyItemFailed = false;
      let currentApplyMutationGuard: (() => string | null) | null = null;
      let recordApplyMutationGuardReason: ((reason: string) => boolean) | null = null;
      let issueLabelBatchActive = false;
      let preserveGuardReadCacheAfterMutation = false;
      let mutationGuardBoundaryCached = false;
      let mutationGuardBoundaryReason: string | null = null;
      let currentApplyMutationBoundaryBlockReason = (): string | null => null;
      let deferredSelfMutationReceipt = false;
      let publishedIssueLabelMutation = false;
      let rememberSelfMutationUpdatedAt = (
        _options: {
          postReviewActivityStartedAtMs?: number;
          requiresReviewedPrActivityCursor?: boolean;
        } = {},
      ): boolean => false;
      let reconcileSkippedIssueLabelAdditions = (_labels: readonly string[]): void => {};
      let refreshRenderedReviewComment = (): void => {};
      let restoreDiscardedIssueLabelState = (): void => {};
      let resetGenerationBoundReads = (): void => {};
      const rememberPublishedLabelSync = (): void => {
        if (dryRun) return;
        publishedIssueLabelMutation = true;
        markdown = replaceFrontMatterValue(markdown, "labels_synced_at", new Date().toISOString());
      };
      const rememberLabelMutationUpdatedAt = (): void => {
        if (issueLabelBatchActive) deferredSelfMutationReceipt = true;
        else {
          rememberPublishedLabelSync();
          rememberSelfMutationUpdatedAt();
        }
      };
      const previousApplyMutationRunner = dependencies.activeApplyMutationRunner;
      const resetMutationGuardBoundary = (): void => {
        mutationGuardBoundaryCached = false;
        mutationGuardBoundaryReason = null;
        resetGuardReadCache();
      };
      const rememberLabelMutationResult = (confirmed: boolean): void => {
        if (confirmed) rememberPublishedLabelSync();
        rememberSelfMutationUpdatedAt();
        deferredSelfMutationReceipt = false;
        resetMutationGuardBoundary();
      };
      const flushIssueLabelBatch = (rememberMutation = true): boolean => {
        if (!issueLabelBatchActive) return false;
        try {
          resetMutationGuardBoundary();
          const result = flushIssueLabelMutationBatch(
            number,
            resetMutationGuardBoundary,
            rememberLabelMutationResult,
          );
          if (result.skippedAdditions.length > 0) {
            reconcileSkippedIssueLabelAdditions(result.skippedAdditions);
            refreshRenderedReviewComment();
          }
          if (result.itemMutationPublished && rememberMutation && deferredSelfMutationReceipt) {
            rememberSelfMutationUpdatedAt();
            deferredSelfMutationReceipt = false;
          }
          return result.itemMutationPublished;
        } catch (error) {
          if (error instanceof ApplyMutationReviewGuardError) {
            restoreDiscardedIssueLabelState();
          }
          throw error;
        } finally {
          issueLabelBatchActive = false;
        }
      };
      const discardIssueLabelBatch = (): void => {
        if (!issueLabelBatchActive) return;
        try {
          discardIssueLabelMutationBatch(number);
          restoreDiscardedIssueLabelState();
        } finally {
          issueLabelBatchActive = false;
        }
      };
      const writeReportAfterDiscardingIssueLabelBatch = (
        reportPath: string,
        nextMarkdown: string,
      ): void => {
        markdown = nextMarkdown;
        discardIssueLabelBatch();
        writeReportMarkdown(reportPath, markdown);
      };
      try {
      const markMutationObserved = (mutationEntry = mutationLedgerEntry): void => {
        if (dryRun) return;
        liveReadGeneration.invalidate();
        resetGenerationBoundReads();
        if (!preserveGuardReadCacheAfterMutation) resetMutationGuardBoundary();
        activeApplyItem = {
          repo: mutationEntry.repo,
          number: mutationEntry.number,
          mutationOccurred: true,
        };
        mutationByItem.set(`${mutationEntry.repo}#${mutationEntry.number}`, true);
      };
      const recordMutation = (parentEventId?: string | null): void => {
        markMutationObserved();
        recordApplyMutationBoundary(applyLedger, mutationLedgerEntry, parentEventId);
      };
      dependencies.activeApplyMutationRunner = <T>(options: {
        identity: string;
        idempotencyIdentity: string;
        operation: () => T;
        didMutate?: ((result: T) => boolean) | undefined;
        knownNoMutation?: ((error: unknown) => boolean) | undefined;
      }): T => {
        if (restrictedPublication) {
          if (!options.identity.startsWith(`review_comment_upsert:${number}:`) && !options.identity.startsWith("review_lease_")) {
            throw new Error("manual publication forbids this mutation");
          }
          assertManualPublicationAuthority(markdown, repo, number);
        }
        if (dryRun) return options.operation();
        const attempt = startApplyMutationAttempt(
          applyLedger,
          mutationLedgerEntry,
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
            entry: mutationLedgerEntry,
            attempt,
            outcome: mutated ? "accepted" : "rejected",
          });
          if (mutated) {
            recordMutation(outcomeEventId);
            if (
              preserveGuardReadCacheAfterMutation &&
              /^(?:label_create|label_upsert):/.test(options.identity)
            ) {
              // Repository label-definition writes do not change the item. Do
              // not let their earlier item-freshness read cover the later
              // combined issue-label publication.
              resetMutationGuardBoundary();
            }
          }
          return result;
        } catch (error) {
          const rejected =
            error instanceof ApplyMutationReviewGuardError ||
            options.knownNoMutation?.(error) === true;
          finishApplyMutationAttempt({
            ledger: applyLedger,
            entry: mutationLedgerEntry,
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
      const archivePairedIssue = (issueNumber: number): void => {
        const pairedEntry = openReportEntry(issueNumber);
        if (!pairedEntry) {
          throw new Error(`missing independently reviewed linked issue report #${issueNumber}`);
        }
        if (dryRun) {
          pairedIssueCloseoutReportKeys.add(pairCloseKey(pairedEntry.repo, issueNumber));
          return;
        }
        captureApplyCanonicalBaseline(pairedEntry.path);
        ensureDir(closedDir);
        let pairedMarkdown = readFileSync(pairedEntry.path, "utf8");
        pairedMarkdown = replaceFrontMatterValue(pairedMarkdown, "action_taken", "closed");
        pairedMarkdown = replaceFrontMatterValue(
          pairedMarkdown,
          "applied_at",
          new Date().toISOString(),
        );
        pairedMarkdown = replaceFrontMatterValue(
          pairedMarkdown,
          "apply_checked_at",
          new Date().toISOString(),
        );
        const pairedClosedPath = join(closedDir, pairedEntry.name);
        const syncedMarkdown = syncDecisionPacketMarkdown(pairedClosedPath, pairedMarkdown, "closed");
        writeFileSync(pairedEntry.path, syncedMarkdown, "utf8");
        syncWorkPlanFromReport({
          markdown: syncedMarkdown,
          reportPath: pairedEntry.path,
          plansDir,
        });
        renameSync(pairedEntry.path, pairedClosedPath);
        pairedIssueCloseoutReportKeys.add(pairCloseKey(pairedEntry.repo, issueNumber));
      };
      const pairedIssueCanonicalProvenanceBlock = (issueNumber: number): string | null => {
        const pairedEntry = openReportEntry(issueNumber);
        if (!pairedEntry) return "implemented-on-main paired closeout requires an independently reviewed linked issue report";
        if (reportPublicationPolicy(pairedEntry.markdown)) return "linked issue publication policy forbids paired closeout";
        const parentFixedPrNumber = frontMatterValue(markdown, "fixed_pr_number");
        const parentFixedPrUrl = frontMatterValue(markdown, "fixed_pr_url");
        const pairedFixedPrNumber = frontMatterValue(pairedEntry.markdown, "fixed_pr_number");
        const pairedFixedPrUrl = frontMatterValue(pairedEntry.markdown, "fixed_pr_url");
        const pairedFixedPrConfidence = frontMatterValue(pairedEntry.markdown, "fixed_pr_confidence");
        const pairedFixedPrSource = frontMatterValue(pairedEntry.markdown, "fixed_pr_source");
        const pairedFixedPrMergedAt = frontMatterValue(pairedEntry.markdown, "fixed_pr_merged_at");
        if (
          !parentFixedPrNumber ||
          parentFixedPrNumber !== pairedFixedPrNumber ||
          !parentFixedPrUrl ||
          parentFixedPrUrl !== pairedFixedPrUrl ||
          pairedFixedPrConfidence !== "high" ||
          !pairedFixedPrSource?.includes("GitHub ") ||
          !pairedFixedPrMergedAt ||
          pairedFixedPrMergedAt === "unknown"
        ) {
          return "implemented-on-main paired closeout requires the linked issue's independent review to cite the same GitHub-verified fixing pull request";
        }
        return null;
      };
      const withPairedIssueMutationLedger = <T>(issueNumber: number, operation: () => T): T => {
        const pairedEntry = openReportEntry(issueNumber);
        if (!pairedEntry) throw new Error(`missing independently reviewed linked issue report #${issueNumber}`);
        const previousMutationLedgerEntry = mutationLedgerEntry;
        const previousActiveApplyItem = activeApplyItem;
        mutationLedgerEntry = pairedEntry;
        activeApplyItem = { repo: pairedEntry.repo, number: pairedEntry.number, mutationOccurred: false };
        startApplyActionLedgerItem(applyLedger, pairedEntry);
        let completed = false;
        try {
          const result = operation();
          completed = true;
          return result;
        } catch (error) {
          if (error instanceof ApplyMutationReviewGuardError) activeApplyItem = previousActiveApplyItem;
          throw error;
        } finally {
          mutationLedgerEntry = previousMutationLedgerEntry;
          if (completed) activeApplyItem = previousActiveApplyItem;
        }
      };
      const markApplyChecked = (subjectState: DecisionPacketSubjectState = "open"): void => {
        discardIssueLabelBatch();
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
        publicationProof: Pick<ApplyResult, "commentMutationOccurred" | "guardedOpenStateVerified"> = {},
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
          ...publicationProof,
        });
        processedCount += 1;
        maybeLogProgress(`skipped #${number}: ${reason}`);
        return processedCount >= processedLimit;
      };
      const markApplySkipped = (
        actionTaken: ActionTaken,
        reason: string,
        liveGuardVerified = false,
        publicationProof: Pick<ApplyResult, "commentMutationOccurred" | "guardedOpenStateVerified"> = {},
      ): boolean => {
        markdown = replaceFrontMatterValue(markdown, "action_taken", actionTaken);
        return recordApplySkipped(actionTaken, reason, liveGuardVerified, publicationProof);
      };
      const skipLockedConversation = (reason: string | null): boolean | null =>
        markLockedConversationApplySkipped(reason, staleCanonicalCommentSyncPending, markApplySkipped);
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
        liveItem = fetchApplyItem(number);
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
      const markdownBeforeApplyDecisionMutations = markdown;
      const persistedPrHydrationSnapshot = parsePrHydrationSnapshot(
        frontMatterValue(markdownBeforeApplyDecisionMutations, "pr_hydration_snapshot"),
      );
      let currentContext: GenerationBoundValue<ItemContext> | undefined;
      let currentClosingPullRequests: unknown[] | undefined;
      let clawSweeperLabelsChanged = false;
      let issueAdvisoryLabelsChanged = false;
      const selfMutationItemReceipts: ApplySelfMutationItemReceipt[] = [];
      reconcileSkippedIssueLabelAdditions = (labels): void => {
        const skipped = new Set(labels.map((label) => normalizeLabelName(label)));
        item.labels = item.labels.filter((label) => !skipped.has(normalizeLabelName(label)));
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
        const before = new Set(reportLabelsBeforeApply.map((label) => normalizeLabelName(label)));
        const after = new Set(item.labels.map((label) => normalizeLabelName(label)));
        const changedKeys = new Set(
          [...before, ...after].filter((key) => before.has(key) !== after.has(key)),
        );
        clawSweeperLabelsChanged = changedKeys.size > 0;
        if (!clawSweeperLabelsChanged) issueAdvisoryLabelsChanged = false;
      };
      restoreDiscardedIssueLabelState = (): void => {
        item.labels = [...previousLabels];
        markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(reportLabelsBeforeApply));
        clawSweeperLabelsChanged = false;
        issueAdvisoryLabelsChanged = false;
        deferredSelfMutationReceipt = false;
      };
      const currentItemContext = (): ItemContext => {
        currentContext ??= liveReadGeneration.bind(
          collectApplyItemContext(item, {
            fullTimelineForRelations: true,
            reviewCacheDigest: true,
            prHydrationSnapshot: persistedPrHydrationSnapshot,
            prCommentActivityRevision:
              persistedPrHydrationSnapshot?.commentActivityRevision ?? null,
            requireFullyValidatedPrHydrationSnapshot: true,
          }),
        );
        return liveReadGeneration.value(currentContext);
      };
      resetGenerationBoundReads = (): void => {
        currentContext = undefined;
      };
      const expectedReviewActivityCursor = frontMatterValue(
        markdownBeforeApplyDecisionMutations,
        "review_activity_cursor",
      );
      const reviewedSourceRevision = frontMatterValue(
        markdownBeforeApplyDecisionMutations,
        "item_source_revision",
      );
      const reviewedTimelineRevision = frontMatterValue(
        markdownBeforeApplyDecisionMutations,
        "review_timeline_revision",
      );
      const reviewHasCompleteActivityIdentity = Boolean(
        reviewedSourceRevision &&
          reviewedSourceRevision !== "unknown" &&
          reviewedTimelineRevision &&
          /^[0-9a-f]{64}$/.test(reviewedTimelineRevision) &&
          (item.kind !== "pull_request" ||
            (frontMatterValue(markdownBeforeApplyDecisionMutations, "pull_head_sha") &&
              isReviewedPrActivityCursor(expectedReviewActivityCursor))),
      );
      const completeReviewActivityReceiptMatches = (context: ItemContext): boolean => {
        if (!reviewHasCompleteActivityIdentity || !context[completeActivityContextSymbol]) {
          return false;
        }
        if (
          context.sourceRevision !== reviewedSourceRevision ||
          context.timelineRevision !== reviewedTimelineRevision
        ) {
          return false;
        }
        return (
          item.kind !== "pull_request" ||
          (freshPullRequestReviewHead(markdownBeforeApplyDecisionMutations, context) &&
            compareReviewedPrActivityCursors(
              context.pullReviewActivityCursor,
              expectedReviewActivityCursor,
            ) === "equal")
        );
      };
      const currentReviewActivityBlock = createApplyReviewActivityGuard(dependencies, {
        expectedCursor: expectedReviewActivityCursor,
        itemKind: item.kind,
        number,
      });
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
          : liveIssueSourceRevision(number, { liveReadGeneration });
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
      let canonicalBoundStaleReviewReason: (
        sourceMarkdown: string,
        comment: Record<string, unknown> | undefined,
      ) => string | null;
      const {
        acquireApplyMutationLease,
        currentApplyMutationLeaseBlockReason,
        refreshReviewStartLeaseState,
      } = createApplyLeaseGuards({
        ...applyReadDependencies,
        canonicalBoundStaleReviewReason: (...args) => canonicalBoundStaleReviewReason(...args),
        closeDelayMs,
        currentReviewActivityBlock,
        dryRun,
        getActiveApplyMutationLease: () => activeApplyMutationLease,
        initialReviewHeadSha,
        item,
        liveReadGeneration,
        markdownBeforeApplyDecisionMutations,
        number,
        reportReviewRevision,
        requiresApplyMutationLease,
        setActiveApplyMutationLease: (lease) => {
          activeApplyMutationLease = lease;
        },
      });
      currentApplyMutationBoundaryBlockReason = (): string | null => {
        if (preserveGuardReadCacheAfterMutation && mutationGuardBoundaryCached) {
          return mutationGuardBoundaryReason;
        }
        const reason = currentApplyMutationLeaseBlockReason();
        if (preserveGuardReadCacheAfterMutation) {
          mutationGuardBoundaryCached = true;
          mutationGuardBoundaryReason = reason;
        }
        return reason;
      };
      currentApplyMutationGuard = currentApplyMutationBoundaryBlockReason;
      let existingReviewComment: Record<string, unknown> | undefined;
      const pendingStaleCanonicalCommentReason = staleCanonicalCommentSyncPending
        ? staleCanonicalCommentSyncPendingReason(markdown)
        : null;
      let closeBlockedForCommentSync: PrCloseCoverageProofGateBlock | null =
        pendingStaleCanonicalCommentReason
          ? { actionTaken: "kept_open", reason: pendingStaleCanonicalCommentReason }
          : null;
      const reviewGuards = createApplyReviewGuards(dependencies, {
        currentItemContext,
        decision,
        dryRun,
        emitEventApplyProof,
        exactEventPublication,
        getProcessedCount: () => processedCount,
        getState: () => ({
          closeBlockedForCommentSync,
          closeReason,
          isCloseProposal,
          markdown,
          staleCanonicalCommentSyncPending,
        }),
        item,
        liveState: state,
        markApplySkipped,
        markdownBeforeApplyDecisionMutations,
        maybeLogProgress,
        number,
        path,
        processedLimit,
        recordApplySkipped,
        results,
        setProcessedCount: (next) => {
          processedCount = next;
        },
        setState: (next) => {
          closeBlockedForCommentSync = next.closeBlockedForCommentSync;
          closeReason = next.closeReason;
          isCloseProposal = next.isCloseProposal;
          markdown = next.markdown;
          staleCanonicalCommentSyncPending = next.staleCanonicalCommentSyncPending;
        },
        shouldProbeClosedState,
        writeReportMarkdown: writeReportAfterDiscardingIssueLabelBatch,
      });
      const {
        applyCanonicalCommentSyncGuard,
        recordActiveReviewLeaseSkip,
        recordRefreshedReviewStaleReason,
        recordReviewLeaseSkip,
        refreshedReviewStaleReason,
        verifiedNewerReviewTuple,
        shouldCheckCanonicalCommentSync,
      } = reviewGuards;
      canonicalBoundStaleReviewReason = reviewGuards.canonicalBoundStaleReviewReason;
      recordApplyMutationGuardReason = (reason) => recordReviewLeaseSkip(reason, false);
      const initialCanonicalCommentSyncGuard = applyCanonicalCommentSyncGuard();
      if (initialCanonicalCommentSyncGuard.stopApply) break;
      if (initialCanonicalCommentSyncGuard.skipCurrentItem) continue;
      rememberSelfMutationUpdatedAt = (
        options?: {
          postReviewActivityStartedAtMs?: number;
          requiresReviewedPrActivityCursor?: boolean;
        },
      ): boolean => {
        if (dryRun) return false;
        const automationItem = fetchApplyItem(number).item;
        const automationItemUpdatedAt = automationItem.updatedAt;
        markdown = replaceFrontMatterValue(
          markdown,
          "automation_item_updated_at",
          automationItemUpdatedAt,
        );
        // A post-mutation item timestamp is not operation-specific. Admit it
        // into this apply run only when an immediate structural receipt still
        // matches the reviewed source, PR head, and review-activity cursor. The
        // final close gate repeats those checks and verifies that no target-side
        // activity landed after proof.
        const receiptContext = collectApplyItemContext(automationItem, {
          fullTimelineForRelations: true,
          reviewCacheDigest: true,
          prHydrationSnapshot: persistedPrHydrationSnapshot,
          prCommentActivityRevision:
            persistedPrHydrationSnapshot?.commentActivityRevision ?? null,
          requireFullyValidatedPrHydrationSnapshot: true,
        });
        const allowsPostReviewAutomationActivity =
          options?.postReviewActivityStartedAtMs !== undefined;
        const requiresReviewedPrActivityCursor =
          options?.requiresReviewedPrActivityCursor === true;
        if (
          requiresReviewedPrActivityCursor &&
          (!reviewedSourceRevision || reviewedSourceRevision === "unknown")
        )
          return false;
        if (
          !allowsPostReviewAutomationActivity &&
          !completeReviewActivityReceiptMatches(receiptContext)
        )
          return false;
        if (
          allowsPostReviewAutomationActivity &&
          ((requiresReviewedPrActivityCursor &&
            receiptContext.sourceRevision !== reviewedSourceRevision) ||
            (item.kind === "pull_request" &&
              (!freshPullRequestReviewHead(markdownBeforeApplyDecisionMutations, receiptContext) ||
                (requiresReviewedPrActivityCursor &&
                  (!isReviewedPrActivityCursor(expectedReviewActivityCursor) ||
                    compareReviewedPrActivityCursors(
                      receiptContext.pullReviewActivityCursor,
                      expectedReviewActivityCursor,
                    ) !== "equal")))) ||
            contextHasNonAutomationActivityAfter(
              receiptContext,
              options!.postReviewActivityStartedAtMs! - 1,
              { truncationCountsAsActivity: true, useCompleteActivityContext: true },
            ))
        )
          return false;
        const completeActivityContext = receiptContext[completeActivityContextSymbol];
        if (!completeActivityContext) return false;
        selfMutationItemReceipts.push({
          updatedAt: automationItemUpdatedAt,
          sourceRevision: receiptContext.sourceRevision ?? "",
          activityReceipt: stableJson(completeActivityContext),
          allowsPostReviewAutomationActivity,
          ...(options?.postReviewActivityStartedAtMs === undefined
            ? {}
            : { postReviewActivityStartedAtMs: options.postReviewActivityStartedAtMs }),
          requiresReviewedPrActivityCursor,
          prHeadSha: contextPullHeadSha(receiptContext),
          prHeadMatches:
            item.kind !== "pull_request" ||
            freshPullRequestReviewHead(markdownBeforeApplyDecisionMutations, receiptContext),
          reviewActivityCursor:
            item.kind === "pull_request" ? fetchReviewedPrActivityCursor(number) : null,
        });
        return true;
      };
      const candidateGuards = createApplyCandidateGuards(dependencies, {
        authorPrBudgetClosesThisRun,
        authorPrClosesThisRun,
        currentDecisionState: () => ({ closeReason, markdown }),
        currentItemContext,
        item,
        maxRuntimeMs,
        number,
        prCloseCoverageProofRuntime,
        requirePrecomputedPrCloseCoverageProof,
        startedAtMs,
      });
      const {
        coverageProofState,
        currentAuthorPrBudgetApplyGate,
        currentObsoleteFixPrBlockReason,
        currentPrCloseCoverageProofGateBlock,
        currentStaleVersionBugBlockReason,
      } = candidateGuards;
      const recordRuntimeBudgetYield = (reason: string): void => {
        discardIssueLabelBatch();
        if (clawSweeperLabelsChanged && !dryRun && !issueLabelBatchActive) {
          writeReportMarkdown(path, markdown);
        }
        removeCurrentCursorTraceItem(examinedItemNumbers, number);
        results.push(...applyRuntimeBudgetYieldResults(number, reason));
        logProgress(`budget stop, resume next cycle: ${reason}`);
      };
      const { canStartSameAuthorPairCloseInThisRun } = createApplyCloseGuards(
        applyReadDependencies,
        {
        applyCloseReasons,
        applyKind,
        canClosePairCounterpartInThisRun,
        closedDir,
        commentSyncMinAgeDays,
        currentAuthorPrBudgetApplyGate,
        currentCloseState: () => ({
          closedCount,
          closeReason,
          markdown,
          needsReviewCommentSync,
          processedCount,
          storedUpdatedAt,
        }),
        currentObsoleteFixPrBlockReason,
        currentPrCloseCoverageProofGateBlock,
        currentStaleVersionBugBlockReason,
        fileEntries,
        isRetryableSkippedClose,
        item,
        itemsDir,
        limit,
        minAgeDescription,
        minAgeMs,
        number,
        openReportEntry,
        processedLimit,
        repo,
        requiredMaintainerDecision,
        staleMinAgeDays,
        },
      );
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
        if (recordRefreshedReviewStaleReason(earlyStaleReason, existingReviewComment)) break;
        continue;
      }
      if (isUpgradedCloseCandidate && !syncCommentsOnly) {
        markdown = replaceFrontMatterValue(markdown, "action_taken", "proposed_close");
      }
      const promotion = promoteApplyPullRequest(dependencies, {
        action,
        applyCloseReasons,
        closedDir,
        closeReason,
        currentAuthorPrBudgetApplyGate,
        currentItemContext,
        decision,
        isCloseProposal,
        item,
        itemsDir,
        markdown,
        resetCoverageProof: candidateGuards.resetCoverageProof,
        staleMinAgeDays,
        state,
        storedHash,
        storedUpdatedAt,
      });
      ({ closeReason, isCloseProposal, markdown, storedHash, storedUpdatedAt } = promotion);
      const attemptedPullRequestClosePromotion = promotion.attempted;
      const applyClosePolicy = (phase: "before-canonical" | "after-canonical") =>
        evaluateApplyClosePolicy(dependencies, {
          applyCloseReasons,
          applyKind,
          closeReason,
          currentAuthorPrBudgetApplyGate,
          currentObsoleteFixPrBlockReason,
          currentStaleVersionBugBlockReason,
          isCloseProposal,
          item,
          markdown,
          number,
          phase,
          state,
          storedUpdatedAt,
          syncCommentsOnly,
        });
      const earlyClosePolicy = applyClosePolicy("before-canonical");
      markdown = earlyClosePolicy.markdown;
      if (earlyClosePolicy.block) {
        const stopped = earlyClosePolicy.block.preserveOriginalAction
          ? recordApplySkipped("kept_open", earlyClosePolicy.block.reason)
          : markApplySkipped("kept_open", earlyClosePolicy.block.reason);
        if (stopped) break;
        continue;
      }
      const promotedCanonicalCommentSyncGuard = applyCanonicalCommentSyncGuard();
      if (promotedCanonicalCommentSyncGuard.stopApply) break;
      if (promotedCanonicalCommentSyncGuard.skipCurrentItem) continue;
      const lateClosePolicy = applyClosePolicy("after-canonical");
      markdown = lateClosePolicy.markdown;
      if (lateClosePolicy.block) {
        const stopped = lateClosePolicy.block.preserveOriginalAction
          ? recordApplySkipped("kept_open", lateClosePolicy.block.reason)
          : markApplySkipped("kept_open", lateClosePolicy.block.reason);
        if (stopped) break;
        continue;
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
          ...(emitEventApplyProof &&
          verifiedNewerReviewTuple(markdown, existingReviewComment, staleReviewCommentReason)
            ? { newerReviewTupleVerified: true }
            : {}),
        });
        processedCount += 1;
        maybeLogProgress(`skipped stale review comment sync #${number}`);
        if (processedCount >= processedLimit) break;
        continue;
      }
      const {
        labelSyncFreshEnough,
        reviewedSourceFresh,
        retryCloseCoverageCommandStatusOnlyUpdate,
        sameSecondCloseActivityIsAmbiguous,
      } = createApplySourceFreshness(dependencies, {
        action,
        completeReviewActivityReceiptMatches,
        currentItemContext,
        currentState: () => ({ isCloseProposal, markdown, storedUpdatedAt }),
        existingReviewComment,
        item,
        leaseComments: earlyLeaseState.leaseComments,
        markdownBeforeApplyDecisionMutations,
        number,
        reportLabelsBeforeApply,
        reportReviewLeaseCommentId,
        reportReviewLeaseOwner,
        reviewHasCompleteActivityIdentity,
        requiresApplyMutationLease,
        storedHash,
      });
      const markChangedSinceReview = createApplyChangedSinceReviewMarker(dependencies, {
        dryRun,
        emitEventApplyProof,
        getMarkdown: () => markdown,
        getProcessedCount: () => processedCount,
        maybeLogProgress,
        number,
        path,
        processedLimit,
        results,
        setMarkdown: (next) => { markdown = next; },
        setProcessedCount: (next) => { processedCount = next; },
        writeReportMarkdown: writeReportAfterDiscardingIssueLabelBatch,
      });
      const stalePrReviewHead =
        state === "open" && item.kind === "pull_request"
          ? stalePullRequestReviewHead(markdown, currentItemContext())
          : null;
      const guardedReviewAction = isGuardedApplyReviewAction(action, isLiveRecheckGuardClose);
      const markReviewedSourceDrift = () =>
        markChangedSinceReview({
          ...applyReviewedSourceDriftEvidence(dependencies, {
            currentItemContext,
            item,
            storedUpdatedAt,
          }),
          preserveAction: guardedReviewAction ? action : undefined,
        });
      let currentPrStatusKind: PrStatusLabelKind | null = null;
      let lockedMetadataOnly = false;
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
          if (recordRefreshedReviewStaleReason(lateStaleReason, lateLeaseState.comment)) break;
          continue;
        }
        if (lateLeaseState.preserve && lateLeaseState.lease) {
          if (recordActiveReviewLeaseSkip(lateLeaseState.lease.expiresAt)) break;
          continue;
        }
        const isLockable = syncCommentsOnly && requiresApplyMutationLease && item.kind === "issue";
        const lockedIssueReason = isLockable ? lockedConversationApplyReason(item) : null;
        if (lockedIssueReason && previousLabels.includes("clawsweeper:linked-pr-open")) {
          currentClosingPullRequests ??= closingPullRequestsForIssue(number);
        }
        const needsLockedCommentMutation =
          lockedIssueReason &&
          requiresLockedReviewCommentMutation(dependencies, {
            action,
            closeReason: closeReason ?? "none",
            commentSyncMinAgeDays,
            existingReviewComment,
            ...(currentClosingPullRequests
              ? {
                  hasOpenLinkedPullRequest:
                    openClosingPullRequestApplyReason(currentClosingPullRequests) !== null,
                }
              : {}),
            isCloseProposal,
            isLiveRecheckGuardClose,
            markdown,
            number,
            previousLabels,
            reviewedSourceFresh: reviewedSourceFresh(),
            staleCanonicalCommentSyncPending,
            suppressAutomationMarkers,
          });
        lockedMetadataOnly = Boolean(lockedIssueReason && !lateLeaseState.lease);
        if (!lockedMetadataOnly) {
          const mutationLeaseBlockReason = acquireApplyMutationLease(lateLeaseState);
          if (mutationLeaseBlockReason) {
            if (recordReviewLeaseSkip(mutationLeaseBlockReason)) break;
            continue;
          }
        }
        if (
          lockedIssueReason &&
          (isCloseProposal || guardedReviewAction) &&
          !reviewedSourceFresh()
        ) {
          if (markReviewedSourceDrift()) break;
          continue;
        }
        if (needsLockedCommentMutation) {
          if (skipLockedConversation(lockedIssueReason)) break;
          continue;
        }
      }
      if (!restrictedPublication && state === "open" && exactEventPublication && !dryRun) {
        beginIssueLabelMutationBatch(number);
        issueLabelBatchActive = true;
        preserveGuardReadCacheAfterMutation = true;
        resetMutationGuardBoundary();
      }
      if (!restrictedPublication && state === "open" && item.kind === "pull_request") {
        const pullRequestLabels = syncApplyPullRequestLabels(dependencies, {
          currentItemContext,
          dryRun,
          item,
          labelSyncFreshEnough: () =>
            labelSyncFreshEnough() && (!guardedReviewAction || reviewedSourceFresh()),
          markdown,
          number,
          onMutation: recordMutation,
          staleReviewHead: stalePrReviewHead,
        });
        item.labels = pullRequestLabels.labels;
        markdown = pullRequestLabels.markdown;
        currentPrStatusKind = pullRequestLabels.currentPrStatusKind;
        clawSweeperLabelsChanged ||= pullRequestLabels.changed;
      }
      markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
      if (clawSweeperLabelsChanged && !dryRun) {
        rememberLabelMutationUpdatedAt();
      }
      if (
        state === "open" &&
        isCloseProposal &&
        applyBlockingProtectedLabels(item.labels, closeReason).length > 0
      ) {
        if (
          markApplySkipped(
            "skipped_protected_label",
            applyProtectedLabelReason(item.labels, closeReason),
            true,
          )
        )
          break;
        continue;
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
      if (
        state === "open" &&
        (isCloseProposal || guardedReviewAction) &&
        !stalePrReviewHead &&
        !reviewedSourceFresh()
      ) {
        if (markReviewedSourceDrift()) break;
        continue;
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
      const { postProofCoveringPrFreshnessBlock, postProofFreshnessBlock } =
        createApplyProofFreshnessGuards({
          ...applyReadDependencies,
          action,
          automationItemUpdatedAt: frontMatterValue(
            markdownBeforeApplyDecisionMutations,
            "automation_item_updated_at",
          ),
          completeReviewActivityReceiptMatches,
          currentProofState: () => ({
            ...coverageProofState,
            storedHash,
            storedUpdatedAt,
          }),
          expectedReviewActivityCursor,
          itemKind: item.kind,
          number,
          reviewHasCompleteActivityIdentity,
          reviewMarkdown: markdownBeforeApplyDecisionMutations,
          retryCloseCoverageCommandStatusOnlyUpdate,
          selfMutationItemReceipts,
        });
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
      if (sameSecondCloseActivityIsAmbiguous) {
        if (
          markChangedSinceReview({
            reason: "same-second activity requires a fresh review",
            currentUpdatedAt: item.updatedAt,
          })
        )
          break;
        continue;
      }
      const labelsCanSync = !restrictedPublication && !lockedMetadataOnly && !stalePrReviewHead && labelSyncFreshEnough();
      const complete = frontMatterValue(markdown, "review_status") === "complete" && labelsCanSync;
      const reportLabelSync = syncApplyReportLabels(dependencies, {
        bulkFilerRepositoryPermissionCache,
        clawSweeperLabelsChanged,
        currentApplyMutationLeaseBlockReason,
        currentClosingPullRequests,
        currentItemContext,
        dryRun,
        isCloseProposal,
        isCurrentCompleteReport: complete,
        isCurrentLabelSyncReport: labelsCanSync,
        item,
        markLabelSyncAuthSkipped,
        markdown,
        number,
        onMutation: recordMutation,
        recordReviewLeaseSkip,
        rememberSelfMutationUpdatedAt: rememberLabelMutationUpdatedAt,
        renderOptions,
        reportLabelsBeforeApply,
        setMarkdown: (value) => { markdown = value; },
        state,
      });
      clawSweeperLabelsChanged = reportLabelSync.clawSweeperLabelsChanged;
      currentClosingPullRequests = reportLabelSync.currentClosingPullRequests;
      issueAdvisoryLabelsChanged = reportLabelSync.issueAdvisoryLabelsChanged;
      markdown = reportLabelSync.markdown;
      if (publishedIssueLabelMutation && !issueLabelBatchActive && !dryRun) {
        markdown = replaceFrontMatterValue(markdown, "labels_synced_at", new Date().toISOString());
      }
      if (reportLabelSync.stopApply) break;
      if (reportLabelSync.skipCurrentItem) continue;
      reviewComment = renderCurrentReviewComment();
      markedReviewComment = markedReviewCommentForApply(reviewComment);
      refreshRenderedReviewComment = (): void => {
        renderOptions.publishedLabels = [...item.labels];
        reviewComment = renderCurrentReviewComment();
        markedReviewComment = markedReviewCommentForApply(reviewComment);
      };
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
      const allowApplyCloseActionUpgrade = isUpgradedCloseCandidate && !syncCommentsOnly;
      const guarded =
        guardedReviewAction &&
        reviewedSourceFresh() &&
        !stalePrReviewHead;
      const reviewCommentSyncState = (mode: "current" | "rewritten", forceBodySync = true) => {
        const reviewCommentHash = reviewCommentBodyDigest(markedReviewComment);
        const matchOptions = mode === "current" ? { allowApplyCloseActionUpgrade } : undefined;
        const existingReviewCommentMatches = commentBodyMatches(
          existingReviewComment,
          markedReviewComment,
          matchOptions,
        );
        const needsReviewCommentBodySync = !existingReviewComment || !existingReviewCommentMatches;
        const needsReviewCommentHashSync = mode === "current"
          ? !reviewCommentHashMatches(
              existingReviewComment,
              markedReviewComment,
              frontMatterValue(markdown, "review_comment_sha256"),
              reviewCommentHash,
              matchOptions,
            )
          : frontMatterValue(markdown, "review_comment_sha256") !== reviewCommentHash;
        const needsReviewCommentReferenceSync =
          /^(?:none|unknown)?$/.test(frontMatterValue(markdown, "review_comment_id") ?? "") ||
          /^(?:none|unknown)?$/.test(frontMatterValue(markdown, "review_comment_url") ?? "");
        return {
          needsReviewCommentBodySync,
          needsReviewCommentSync: shouldSyncReviewComment({
            syncCommentsOnly,
            isCloseProposal,
            commentSyncMinAgeDays,
            reviewCommentSyncedAt: frontMatterValue(markdown, "review_comment_synced_at"),
            reviewedAt: frontMatterValue(markdown, "reviewed_at"),
            lastFullReviewAt: frontMatterValue(markdown, "last_full_review_at"),
            // Rewritten reports cannot reuse the prior verification or guarded-review receipt.
            ...(mode === "current" ? {
              reviewCommentVerifiedAt: frontMatterValue(markdown, "review_comment_checked_at"),
              guardedReviewedAt: guarded ? frontMatterValue(markdown, "apply_checked_at") : undefined,
            } : {}),
            hasExistingReviewComment: Boolean(existingReviewComment),
            needsReviewCommentBodySync,
            needsReviewCommentHashSync,
            needsReviewCommentReferenceSync,
            forceReviewCommentBodySync: forceBodySync,
          }),
        };
      };
      let { needsReviewCommentBodySync, needsReviewCommentSync } = reviewCommentSyncState(
        "current",
        clawSweeperLabelsChanged || Boolean(closeBlockedForCommentSync) || guarded ||
          Boolean(stalePrReviewHead),
      );
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
            ({ needsReviewCommentBodySync, needsReviewCommentSync } = reviewCommentSyncState("rewritten"));
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
          ({ needsReviewCommentBodySync, needsReviewCommentSync } = reviewCommentSyncState("rewritten"));
        }
      }
      if (
        !closeBlockedForCommentSync &&
        !needsReviewCommentBodySync &&
        (!isCloseProposal || syncCommentsOnly)
      ) {
        const markedReviewCommentBeforeLabelFlush = markedReviewComment;
        flushIssueLabelBatch();
        if (markedReviewComment !== markedReviewCommentBeforeLabelFlush) {
          ({ needsReviewCommentBodySync, needsReviewCommentSync } = reviewCommentSyncState("current"));
        }
      }
      if (needsReviewCommentSync) {
        const lockedCommentSkip = skipLockedConversation(
          needsReviewCommentBodySync ? lockedConversationApplyReason(item) : null,
        );
        if (lockedCommentSkip !== null) {
          if (lockedCommentSkip) break;
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
            const mutationLeaseBlockReason = currentApplyMutationBoundaryBlockReason();
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
              writeReportAfterDiscardingIssueLabelBatch(path, markdown);
              results.push({
                number,
                action: "skipped_stale_review_comment_sync",
                reason: latestStaleSyncReason,
                ...(emitEventApplyProof &&
                verifiedNewerReviewTuple(markdown, existingReviewComment, latestStaleSyncReason)
                  ? { newerReviewTupleVerified: true }
                  : {}),
              });
              processedCount += 1;
              maybeLogProgress(`skipped stale review comment sync #${number}`);
              if (processedCount >= processedLimit) break;
              continue;
            }
            const lowSignalCommentSyncBlockReason =
              closeReason === "low_signal_unmergeable_pr"
                ? withGuardReadOptions({ bypassGenerationCache: true }, () =>
                    lowSignalUnmergeablePrApplyBlockReasonSafe(number, staleMinAgeDays),
                  )
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
            const delayIssueLabelBatchForRecoveryCleanup = Boolean(
              exactEventPublication &&
              complete &&
              item.labels.includes(REVIEW_RECOVERY_STUCK_LABEL),
            );
            const flushIssueLabelBatchForDurableComment = (): void => {
              const labelMutationPublished = flushIssueLabelBatch(false);
              preserveGuardReadCacheAfterMutation = false;
              resetMutationGuardBoundary();
              if (labelMutationPublished && deferredSelfMutationReceipt) {
                rememberSelfMutationUpdatedAt();
                deferredSelfMutationReceipt = false;
                resetMutationGuardBoundary();
              }
            };
            if (!delayIssueLabelBatchForRecoveryCleanup) {
              flushIssueLabelBatchForDurableComment();
            }
            try {
              syncedComment = upsertReviewComment(
                number,
                markedReviewComment,
                existingReviewComment,
                undefined,
                { suppressAutomationMarkers },
              );
              rememberSelfMutationUpdatedAt();
              deferredSelfMutationReceipt = false;
              syncReasons.push("updated durable Codex review comment");
              if (complete && item.labels.includes(REVIEW_RECOVERY_STUCK_LABEL)) {
                try {
                  clearResolvedReviewRecoveryLabel({
                    number,
                    labels: item.labels,
                    complete,
                    removeLabel: removeIssueLabel,
                    onMutation: recordMutation,
                  });
                  markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
                  if (issueLabelBatchActive) {
                    clawSweeperLabelsChanged = true;
                    rememberLabelMutationUpdatedAt();
                  } else {
                    markdown = replaceFrontMatterValue(
                      markdown,
                      "labels_synced_at",
                      new Date().toISOString(),
                    );
                    rememberSelfMutationUpdatedAt();
                  }
                  syncReasons.push("cleared resolved review recovery label");
                } catch (error) {
                  if (error instanceof GitHubRuntimeBudgetError || error instanceof GitHubRateLimitError)
                    throw error;
                  console.error(
                    `[apply] could not clear resolved review recovery label for #${number}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
              if (delayIssueLabelBatchForRecoveryCleanup) {
                flushIssueLabelBatchForDurableComment();
              }
            } catch (error) {
              if (error instanceof DurableReviewPublicationBlockedError) {
                rememberSelfMutationUpdatedAt();
                deferredSelfMutationReceipt = false;
                markdown = updateReviewCommentMetadata(markdown, error.syncedComment, error.publishedBody);
                if (markApplySkipped("kept_open", error.message, false, {
                  commentMutationOccurred: true,
                  guardedOpenStateVerified: state === "open",
                })) break;
                continue;
              }
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
        markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
        markdown = updateReviewCommentMetadata(markdown, syncedComment, markedReviewComment);
        if (staleCanonicalCommentSyncPending) {
          markdown = completeStaleCanonicalCommentSyncReport(markdown);
        }
        if (!isCloseProposal || syncCommentsOnly) flushIssueLabelBatch();
        if (!dryRun && !issueLabelBatchActive) writeReportMarkdown(path, markdown);
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
          discardIssueLabelBatch();
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
      flushIssueLabelBatch();
      preserveGuardReadCacheAfterMutation = false;
      resetMutationGuardBoundary();
      const appliedCloseReason = closeReason;
      const withPairedIssueMutationLease = <T>(
        pairedNumber: number,
        operation: () => T,
        options: { onOperationCompleted?: () => void } = {},
      ): T =>
        withPairedIssueMutationLedger(pairedNumber, () => {
        const pairedEntry = openReportEntry(pairedNumber);
        if (!pairedEntry) {
          throw new ApplyMutationReviewGuardError(
            `missing independently reviewed linked issue report #${pairedNumber}`,
          );
        }
        const pairedItem = fetchApplyItem(pairedNumber, { bypassGenerationCache: true }).item;
        if (pairedItem.kind !== "issue") {
          throw new ApplyMutationReviewGuardError(
            `linked item #${pairedNumber} is no longer an issue`,
          );
        }
        const pairedInitialRevision = liveIssueSourceRevision(pairedNumber, {
          liveReadGeneration,
          bypassGenerationCache: true,
        });
        if (!pairedInitialRevision) {
          throw new ApplyMutationReviewGuardError(
            `linked issue #${pairedNumber} source revision could not be read`,
          );
        }
        const pairedMarkdown = pairedEntry.markdown;
        let pairedActiveMutationLease: {
          itemNumber: number;
          lease: AcquiredReviewStartLease;
        } | null = null;
        const createPairedLeaseGuards = (initialRevision: string, leaseMarkdown: string) =>
          createApplyLeaseGuards({
            ...applyReadDependencies,
            // The paired-close path separately revalidates the linked report,
            // immutable source snapshot, and all post-review activity. Do not
            // reinterpret a newer trusted linked-issue review as stale here:
            // that review is explicitly permitted by the paired activity guard.
            canonicalBoundStaleReviewReason: () => null,
            closeDelayMs,
            currentReviewActivityBlock: () => null,
            dryRun,
            getActiveApplyMutationLease: () => pairedActiveMutationLease,
            initialReviewHeadSha: initialRevision,
            item: pairedItem,
            liveReadGeneration,
            markdownBeforeApplyDecisionMutations: leaseMarkdown,
            number: pairedNumber,
            reportReviewRevision: reviewLeaseRevisionFromReport(leaseMarkdown),
            // A paired closeout is an independent mutation target. Even a legacy
            // report must obtain its own live lease rather than borrow the parent
            // pull request's lease.
            requiresApplyMutationLease: true,
            setActiveApplyMutationLease: (lease) => {
              pairedActiveMutationLease = lease;
            },
          });
        let pairedLeaseGuards = createPairedLeaseGuards(pairedInitialRevision, pairedMarkdown);
        const previousApplyMutationGuard = currentApplyMutationGuard;
        let pairedOperationCompleted = false;
        const cleanupPairedLease = (operationError?: unknown): void => {
          // The lease setter runs through a closure, so avoid stale control-flow
          // narrowing when reading the nested lease for deterministic cleanup.
          const pairedLease = pairedActiveMutationLease as {
            itemNumber: number;
            lease: AcquiredReviewStartLease;
          } | null;
          pairedActiveMutationLease = null;
          if (!pairedLease) return;
          if (pairedOperationCompleted && options.onOperationCompleted) {
            try {
              deleteOwnedDedicatedReviewStartLease(pairedLease.itemNumber, pairedLease.lease, {
                throwOnError: true,
              });
            } catch (error) {
              console.error(
                `[apply] linked issue #${pairedNumber} closed and archived but could not delete owned review lease ${pairedLease.lease.commentId}: ${mutationErrorMessage(error)}`,
              );
            }
            return;
          }
          try {
            deleteOwnedDedicatedReviewStartLease(pairedLease.itemNumber, pairedLease.lease, {
              throwOnError: true,
            });
          } catch (error) {
            if (!operationError || !isLockedConversationCommentError(error)) throw error;
            console.error(
              `[apply] linked issue #${pairedNumber} became locked and owned review lease ${pairedLease.lease.commentId} could not be deleted: ${mutationErrorMessage(error)}`,
            );
          }
        };
        try {
          let leaseBlock = pairedLeaseGuards.acquireApplyMutationLease(
            pairedLeaseGuards.refreshReviewStartLeaseState(),
          );
          // Posting a dedicated lease is an owned issue-comment mutation. Rebase
          // that new owned lease on its post-comment revision before the guarded
          // operation. Existing report leases and any other source drift still
          // fail closed.
          const acquiredLease = pairedActiveMutationLease as {
            itemNumber: number;
            lease: AcquiredReviewStartLease;
          } | null;
          if (
            leaseBlock?.includes("changed while holding the apply mutation lease") &&
            acquiredLease
          ) {
            const postLeaseRevision = liveIssueSourceRevision(pairedNumber, {
              liveReadGeneration,
              bypassGenerationCache: true,
            });
            if (postLeaseRevision) {
              const rebasedLeaseMarkdown = replaceFrontMatterValue(
                replaceFrontMatterValue(
                  replaceFrontMatterValue(
                    pairedMarkdown,
                    "review_lease_owner",
                    acquiredLease.lease.owner,
                  ),
                  "review_lease_comment_id",
                  String(acquiredLease.lease.commentId),
                ),
                "item_source_revision",
                postLeaseRevision,
              );
              pairedLeaseGuards = createPairedLeaseGuards(postLeaseRevision, rebasedLeaseMarkdown);
              leaseBlock = pairedLeaseGuards.acquireApplyMutationLease(
                pairedLeaseGuards.refreshReviewStartLeaseState(),
              );
            }
          }
          if (leaseBlock) throw new ApplyMutationReviewGuardError(leaseBlock);
          currentApplyMutationGuard = pairedLeaseGuards.currentApplyMutationLeaseBlockReason;
          const result = operation();
          options.onOperationCompleted?.();
          pairedOperationCompleted = true;
          cleanupPairedLease();
          return result;
        } catch (error) {
          if (error instanceof ApplyMutationReviewGuardError) {
            pairedIssueCloseoutReportKeys.add(pairCloseKey(repo, pairedNumber));
          }
          cleanupPairedLease(error);
          throw error;
        } finally {
          currentApplyMutationGuard = previousApplyMutationGuard;
          pairedActiveMutationLease = null;
        }
        });
      const durableReviewCommentUpdatedAt = (
        reviewMarkdown: string,
        reviewNumber: number,
        reviewCloseReason: CloseReason,
      ): string | null => {
        const storedHash = frontMatterValue(reviewMarkdown, "review_comment_sha256");
        const storedId = Number(frontMatterValue(reviewMarkdown, "review_comment_id"));
        const storedUrl = frontMatterValue(reviewMarkdown, "review_comment_url");
        if (!storedHash || !Number.isSafeInteger(storedId) || storedId <= 0 || !storedUrl) {
          return null;
        }
        const reviewComment = issueReviewComment(reviewNumber, [
          renderReviewCommentFromReport(reviewMarkdown, reviewCloseReason),
          reviewSectionValue(reviewMarkdown, "closeComment"),
        ]);
        if (
          commentId(reviewComment) !== storedId ||
          reviewComment?.html_url !== storedUrl ||
          reviewCommentBodyDigest(rawCommentBody(reviewComment)) !== storedHash
        ) {
          return null;
        }
        const author = login(reviewComment?.user)?.trim().toLowerCase();
        return author && CLAWSWEEPER_BOT_AUTHORS.has(author)
          ? commentUpdatedAt(reviewComment) ?? null
          : null;
      };
      const closeFlow = executeApplyClose(
        {
          ...applyReadDependencies,
          implementedOnMainPullRequestProvenanceApplyBlock: (...args) =>
            withGuardReadOptions({ bypassGenerationCache: true }, () =>
              applyReadDependencies.implementedOnMainPullRequestProvenanceApplyBlock(...args),
            ),
          lowSignalUnmergeablePrApplyBlockReasonSafe: (...args) =>
            withGuardReadOptions({ bypassGenerationCache: true }, () =>
              lowSignalUnmergeablePrApplyBlockReasonSafe(...args),
            ),
        },
        {
        applyCloseReasons,
        applyKind,
        archiveClosed,
        archivePairedIssue,
        canStartPairedIssueClose: (pairedNumber, pairedKind) =>
          applyLedger.items.has(pairCloseKey(repo, pairedNumber)) &&
          canStartSameAuthorPairCloseInThisRun(pairedNumber, pairedKind),
        pairedIssueMarkdown: (pairedNumber) => openReportEntry(pairedNumber)?.markdown ?? null,
        pairedIssueReviewUpdatedAt: (pairedNumber) => {
          const pairedMarkdown = openReportEntry(pairedNumber)?.markdown;
          return pairedMarkdown ? frontMatterValue(pairedMarkdown, "item_updated_at") ?? null : null;
        },
        pairedIssueDurableReviewCommentUpdatedAt: (pairedNumber) => {
          const pairedMarkdown = openReportEntry(pairedNumber)?.markdown;
          if (!pairedMarkdown) return null;
          const pairedCloseReason = reportDecision(
            pairedMarkdown,
            "implemented_on_main",
          ).closeReason;
          return durableReviewCommentUpdatedAt(
            pairedMarkdown,
            pairedNumber,
            pairedCloseReason,
          );
        },
        closeDelayMs,
        closeLimitReached: closedCount >= limit,
        closeReason: appliedCloseReason,
        closedDir,
        currentApplyMutationLeaseBlockReason: currentApplyMutationBoundaryBlockReason,
        currentAuthorPrBudgetApplyGate,
        currentObsoleteFixPrBlockReason,
        currentPrCloseCoverageProofGateBlock,
        currentStaleVersionBugBlockReason,
        currentDurableReviewCommentUpdatedAt: () =>
          durableReviewCommentUpdatedAt(markdown, number, appliedCloseReason),
        deferPairedIssueForThisRun: (pairedNumber) => {
          pairedIssueCloseoutReportKeys.add(pairCloseKey(repo, pairedNumber));
        },
        dryRun,
        emitEventApplyProof,
        examinedItemNumbers,
        getMarkdown: () => markdown,
        isRetryableSkippedClose,
        item,
        itemsDir,
        logProgress,
        markApplySkipped,
        markChangedSinceReview,
        minAgeDescription,
        minAgeMs,
        number,
        onClosed: (result, simulated) => {
          closedCount += 1;
          processedCount += 1;
          results.push(result);
          logProgress(`${simulated ? "would close" : "closed"} #${number}`);
          closedThisRun.add(pairCloseKey(repo, number));
          if (item.kind === "pull_request") recordAuthorPrClose(item.author, appliedCloseReason);
          return processedCount >= processedLimit;
        },
        onPairedIssueClosed: (result, simulated) => {
          closedCount += 1;
          processedCount += 1;
          results.push(result);
          logProgress(`${simulated ? "would close" : "closed"} linked issue #${result.number}`);
          closedThisRun.add(pairCloseKey(repo, result.number));
          const pairedEntry = openReportEntry(result.number);
          const pairedState = pairedEntry
            ? startApplyActionLedgerItem(applyLedger, pairedEntry)
            : null;
          if (pairedEntry && pairedState) {
            const pairedClosedPath = join(closedDir, pairedEntry.name);
            const pairedLedgerEntry = existsSync(pairedClosedPath)
              ? { ...pairedEntry, path: pairedClosedPath, markdown: readFileSync(pairedClosedPath, "utf8") }
              : pairedEntry;
            recordApplyActionLedgerItemResults({
              ledger: applyLedger,
              state: pairedState,
              results: [result],
              entry: pairedLedgerEntry,
              mutationOccurred: mutationByItem.get(`${pairedEntry.repo}#${pairedEntry.number}`) === true,
              dryRun,
            });
          }
          return processedCount >= processedLimit;
        },
        pairedIssueCanonicalProvenanceBlock,
        pairedIssueCloseCapacityAvailable:
          closedCount + 2 <= limit && processedCount + 2 <= processedLimit,
        postProofCoveringPrFreshnessBlock,
        postProofFreshnessBlock,
        proofResult: () => coverageProofState.cachedPrCloseCoverageProofGateResult,
        recordApplySkipped,
        recordMutation,
        rememberSelfMutationUpdatedAt,
        recordReviewLeaseSkip,
        recordRuntimeBudgetYield,
        repo,
        requiredMaintainerDecision,
        reviewComment,
        runtimeBudget,
        setMarkdown: (value) => { markdown = value; },
        staleMinAgeDays,
        withPairedIssueMutationLease,
        },
      );
      if (closeFlow === "yield") return;
      if (closeFlow === "stop") break;
      continue;
      } catch (error) {
        if (error instanceof ApplyMutationReviewGuardError && recordApplyMutationGuardReason) {
          discardIssueLabelBatch();
          if (recordApplyMutationGuardReason(error.message)) break;
          continue;
        }
        applyItemFailed = true;
        if (error instanceof GitHubRateLimitError) {
          // Keep the durable lease until expiry; releasing it would spend the exhausted quota.
          activeApplyMutationLease = null;
        }
        throw error;
      } finally {
        discardIssueLabelBatch();
        releaseActiveApplyMutationLease();
        setGuardReadGeneration(null);
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

function contextPullHeadSha(context: ItemContext): string | null {
  const pullRequest = context.pullRequest;
  if (!pullRequest || typeof pullRequest !== "object") return null;
  const head = (pullRequest as { head?: unknown }).head;
  if (!head || typeof head !== "object") return null;
  const sha = (head as { sha?: unknown }).sha;
  return typeof sha === "string" && sha ? sha : null;
}
