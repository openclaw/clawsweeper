import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createApplyCandidateGuards } from "./clawsweeper-apply-candidate-guards.js";
import { executeApplyClose } from "./clawsweeper-apply-close-execution.js";
import { createApplyCloseGuards } from "./clawsweeper-apply-close-guards.js";
import { evaluateApplyClosePolicy } from "./clawsweeper-apply-close-policies.js";
import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { createApplyLeaseGuards } from "./clawsweeper-apply-lease-guards.js";
import { createApplyProofFreshnessGuards } from "./clawsweeper-apply-proof-freshness.js";
import { syncApplyPullRequestLabels } from "./clawsweeper-apply-pull-request-labels.js";
import { promoteApplyPullRequest } from "./clawsweeper-apply-pull-request-promotion.js";
import { syncApplyReportLabels } from "./clawsweeper-apply-report-labels.js";
import { createApplyReviewActivityGuard } from "./clawsweeper-apply-review-activity.js";
import { createApplyReviewGuards } from "./clawsweeper-apply-review-guards.js";
import { createApplySourceFreshness } from "./clawsweeper-apply-source-freshness.js";
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
  isGitHubNotFoundError,
  isGitHubRequiresAuthenticationError,
  isLockedConversationCommentError,
} from "./github-retry.js";
import { type PrCloseCoverageProofRuntime } from "./pr-close-coverage-proof.js";
import { isAutoCloseAllowed, repositoryProfileFor } from "./repository-profiles.js";

export function createApplyDecisionWorkflow(dependencies: CreateApplyDecisionWorkflowDependencies) {
  const {
    actionLedgerItemKey,
    applyBlockingProtectedLabels,
    applyKindArg,
    ApplyMutationReviewGuardError,
    applyPrCloseCoverageProofBlockedReport,
    applyProtectedLabelReason,
    applyRuntimeBudgetYieldResults,
    cleanupSupersededReviewPlaceholderComments,
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
    decisionPacketsDirFromArgs,
    defaultClosedDir,
    defaultItemsDir,
    defaultPlansDir,
    deleteOwnedDedicatedReviewStartLease,
    duplicateCanonicalPullRequestBlockReason,
    ensureDir,
    exactEventReviewLeaseDisposition,
    fetchItem,
    finishApplyMutationAttempt,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
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
    itemSnapshotHash,
    liveIssueSourceRevision,
    lockedConversationApplyReason,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    markedReviewCommentBody,
    mutationErrorMessage,
    normalizeAuthorAssociation,
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
    removeCurrentCursorTraceItem,
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
    const {
      applyReportEntriesForDir,
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
      const currentItemContext = (): ItemContext => {
        currentContext ??= collectItemContext(item, { fullTimelineForRelations: true });
        return currentContext;
      };
      const markdownBeforeApplyDecisionMutations = markdown;
      const currentReviewActivityBlock = createApplyReviewActivityGuard(dependencies, {
        expectedCursor: frontMatterValue(markdownBeforeApplyDecisionMutations, "review_activity_cursor"),
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
      let canonicalBoundStaleReviewReason: (
        sourceMarkdown: string,
        comment: Record<string, unknown> | undefined,
      ) => string | null;
      const {
        acquireApplyMutationLease,
        currentApplyMutationLeaseBlockReason,
        refreshReviewStartLeaseState,
      } = createApplyLeaseGuards({
        ...dependencies,
        canonicalBoundStaleReviewReason: (...args) => canonicalBoundStaleReviewReason(...args),
        closeDelayMs,
        currentReviewActivityBlock,
        dryRun,
        getActiveApplyMutationLease: () => activeApplyMutationLease,
        initialReviewHeadSha,
        item,
        markdownBeforeApplyDecisionMutations,
        number,
        reportReviewRevision,
        requiresApplyMutationLease,
        setActiveApplyMutationLease: (lease) => {
          activeApplyMutationLease = lease;
        },
      });





      currentApplyMutationGuard = currentApplyMutationLeaseBlockReason;
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
        writeReportMarkdown,
      });
      const {
        applyCanonicalCommentSyncGuard,
        recordActiveReviewLeaseSkip,
        recordRefreshedReviewStaleReason,
        recordReviewLeaseSkip,
        refreshedReviewStaleReason,
        shouldCheckCanonicalCommentSync,
      } = reviewGuards;
      canonicalBoundStaleReviewReason = reviewGuards.canonicalBoundStaleReviewReason;
      recordApplyMutationGuardReason = (reason) => recordReviewLeaseSkip(reason, false);
      const initialCanonicalCommentSyncGuard = applyCanonicalCommentSyncGuard();
      if (initialCanonicalCommentSyncGuard.stopApply) break;
      if (initialCanonicalCommentSyncGuard.skipCurrentItem) continue;
      const rememberSelfMutationUpdatedAt = (): void => {
        if (!dryRun) allowedSelfMutationUpdatedAts.add(fetchItem(number).item.updatedAt);
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
      const { canStartSameAuthorPairCloseInThisRun } = createApplyCloseGuards(dependencies, {
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
        openFileEntryByNumber,
        processedLimit,
        repo,
        requiredMaintainerDecision,
        staleMinAgeDays,
      });


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
        });
        processedCount += 1;
        maybeLogProgress(`skipped stale review comment sync #${number}`);
        if (processedCount >= processedLimit) break;
        continue;
      }
      const {
        automationOnlyUpdate,
        labelSyncFreshEnough,
        retryCloseCoverageCommandStatusOnlyUpdate,
        reviewCommentOnlyUpdate,
        updatedSinceReview,
      } = createApplySourceFreshness(dependencies, {
        action,
        allowedSelfMutationUpdatedAts,
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
        requiresApplyMutationLease,
      });
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
        const pullRequestLabels = syncApplyPullRequestLabels(dependencies, {
          currentItemContext,
          dryRun,
          item,
          labelSyncFreshEnough,
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
      const { postProofCoveringPrFreshnessBlock, postProofFreshnessBlock } =
        createApplyProofFreshnessGuards({
          ...dependencies,
          action,
          allowedSelfMutationUpdatedAts,
          currentProofState: () => ({
            ...coverageProofState,
            storedHash,
            storedUpdatedAt,
          }),
          number,
          retryCloseCoverageCommandStatusOnlyUpdate,
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
      const reportLabelSync = syncApplyReportLabels(dependencies, {
        bulkFilerRepositoryPermissionCache,
        clawSweeperLabelsChanged,
        currentApplyMutationLeaseBlockReason,
        currentClosingPullRequests,
        currentItemContext,
        dryRun,
        isCloseProposal,
        isCurrentCompleteReport,
        isCurrentLabelSyncReport,
        item,
        markLabelSyncAuthSkipped,
        markdown,
        number,
        onMutation: recordMutation,
        recordReviewLeaseSkip,
        rememberSelfMutationUpdatedAt,
        renderOptions,
        reportLabelsBeforeApply,
        setMarkdown: (value) => { markdown = value; },
        state,
      });
      clawSweeperLabelsChanged = reportLabelSync.clawSweeperLabelsChanged;
      currentClosingPullRequests = reportLabelSync.currentClosingPullRequests;
      issueAdvisoryLabelsChanged = reportLabelSync.issueAdvisoryLabelsChanged;
      markdown = reportLabelSync.markdown;
      if (reportLabelSync.stopApply) break;
      if (reportLabelSync.skipCurrentItem) continue;
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
      const appliedCloseReason = closeReason;
      const closeFlow = executeApplyClose(dependencies, {
        applyCloseReasons,
        applyKind,
        archiveClosed,
        closeDelayMs,
        closeLimitReached: closedCount >= limit,
        closeReason: appliedCloseReason,
        closedDir,
        currentApplyMutationLeaseBlockReason,
        currentAuthorPrBudgetApplyGate,
        currentObsoleteFixPrBlockReason,
        currentPrCloseCoverageProofGateBlock,
        currentStaleVersionBugBlockReason,
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
        postProofCoveringPrFreshnessBlock,
        postProofFreshnessBlock,
        proofResult: () => coverageProofState.cachedPrCloseCoverageProofGateResult,
        recordApplySkipped,
        recordMutation,
        recordReviewLeaseSkip,
        recordRuntimeBudgetYield,
        repo,
        requiredMaintainerDecision,
        reviewComment,
        runtimeBudget,
        setMarkdown: (value) => { markdown = value; },
        staleMinAgeDays,
      });
      if (closeFlow === "yield") return;
      if (closeFlow === "stop") break;
      continue;
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
