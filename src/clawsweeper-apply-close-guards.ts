import { readFileSync } from "node:fs";
import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS } from "./clawsweeper-policy.js";
import type {
  ActionTaken,
  ApplyKind,
  AuthorPrBudgetApplyGate,
  CloseReason,
  Item,
  ItemKind,
  PrCloseCoverageProofGateBlock,
  ReportEntry,
} from "./clawsweeper-types.js";
import { maintainerDecisionBlocksClose, type MaintainerDecision } from "./decision-packets.js";

export function markLockedConversationApplySkipped(
  reason: string | null,
  staleCanonicalCommentSyncPending: boolean,
  markApplySkipped: (action: ActionTaken, reason: string, liveGuardVerified?: boolean) => boolean,
): boolean | null {
  if (!reason) return null;
  const action = staleCanonicalCommentSyncPending
    ? "retry_stale_canonical_comment_sync"
    : "skipped_locked_conversation";
  return markApplySkipped(
    action,
    staleCanonicalCommentSyncPending
      ? `${reason}; stale canonical comment correction remains pending`
      : reason,
    !staleCanonicalCommentSyncPending,
  );
}

export function isGuardedApplyReviewAction(
  action: string | undefined,
  isLiveRecheckGuardClose: boolean,
): boolean {
  return (
    isLiveRecheckGuardClose ||
    action === "skipped_protected_label" ||
    action === "skipped_close_exempt_label" ||
    action === "skipped_maintainer_authored" ||
    action === "skipped_invalid_decision"
  );
}

export function requiresLockedReviewCommentMutation(
  {
    commentBody,
    commentBodyMatches,
    frontMatterValue,
    markedReviewCommentBody,
    renderReviewCommentFromReport,
    shouldSyncReviewComment,
  }: Pick<
    CreateApplyDecisionWorkflowDependencies,
    | "commentBody"
    | "commentBodyMatches"
    | "frontMatterValue"
    | "markedReviewCommentBody"
    | "renderReviewCommentFromReport"
    | "shouldSyncReviewComment"
  >,
  options: {
    action: string | undefined;
    closeReason: CloseReason;
    commentSyncMinAgeDays: number;
    existingReviewComment: Record<string, unknown> | undefined;
    hasOpenLinkedPullRequest?: boolean;
    isCloseProposal: boolean;
    isLiveRecheckGuardClose: boolean;
    markdown: string;
    number: number;
    previousLabels: string[];
    reviewedSourceFresh: boolean;
    staleCanonicalCommentSyncPending: boolean;
    suppressAutomationMarkers: boolean;
  },
): boolean {
  const previousReviewCommentBody = commentBody(options.existingReviewComment);
  const expectedReviewComment = markedReviewCommentBody(
    options.number,
    renderReviewCommentFromReport(options.markdown, options.closeReason, {
      previousLabels: options.previousLabels,
      suppressAutomationMarkers: options.suppressAutomationMarkers,
      ...(options.hasOpenLinkedPullRequest === undefined
        ? {}
        : { hasOpenLinkedPullRequest: options.hasOpenLinkedPullRequest }),
      ...(previousReviewCommentBody?.trim() ? { previousReviewCommentBody } : {}),
    }),
  );
  if (
    !options.staleCanonicalCommentSyncPending &&
    commentBodyMatches(options.existingReviewComment, expectedReviewComment)
  ) {
    return false;
  }
  const guarded =
    options.reviewedSourceFresh &&
    isGuardedApplyReviewAction(options.action, options.isLiveRecheckGuardClose);
  return shouldSyncReviewComment({
    syncCommentsOnly: true,
    isCloseProposal: options.isCloseProposal,
    commentSyncMinAgeDays: options.commentSyncMinAgeDays,
    reviewCommentSyncedAt: frontMatterValue(options.markdown, "review_comment_synced_at"),
    reviewCommentVerifiedAt: frontMatterValue(options.markdown, "review_comment_checked_at"),
    reviewedAt: frontMatterValue(options.markdown, "reviewed_at"),
    lastFullReviewAt: frontMatterValue(options.markdown, "last_full_review_at"),
    guardedReviewedAt: guarded ? frontMatterValue(options.markdown, "apply_checked_at") : undefined,
    hasExistingReviewComment: Boolean(options.existingReviewComment),
    needsReviewCommentBodySync: true,
    needsReviewCommentHashSync: false,
    needsReviewCommentReferenceSync:
      /^(?:none|unknown)?$/.test(frontMatterValue(options.markdown, "review_comment_id") ?? "") ||
      /^(?:none|unknown)?$/.test(frontMatterValue(options.markdown, "review_comment_url") ?? ""),
    forceReviewCommentBodySync: options.staleCanonicalCommentSyncPending || guarded,
  });
}

interface ApplyCloseGuardContext {
  applyCloseReasons: ReadonlySet<CloseReason> | null;
  applyKind: ApplyKind;
  canClosePairCounterpartInThisRun: (number: number, repo?: string) => boolean;
  closedDir: string;
  commentSyncMinAgeDays: number;
  currentAuthorPrBudgetApplyGate: () => AuthorPrBudgetApplyGate;
  currentCloseState: () => {
    closedCount: number;
    closeReason: CloseReason | undefined;
    markdown: string;
    needsReviewCommentSync: boolean;
    processedCount: number;
    storedUpdatedAt: string | undefined;
  };
  currentObsoleteFixPrBlockReason: () => string | null;
  currentPrCloseCoverageProofGateBlock: () => PrCloseCoverageProofGateBlock | null;
  currentStaleVersionBugBlockReason: () => string | null;
  fileEntries: ReportEntry[];
  isRetryableSkippedClose: boolean;
  item: Item;
  itemsDir: string;
  limit: number;
  minAgeDescription: string;
  minAgeMs: number;
  number: number;
  openReportEntry: (number: number) => ReportEntry | undefined;
  processedLimit: number;
  repo: string;
  requiredMaintainerDecision: MaintainerDecision | null;
  staleMinAgeDays: number;
}

export function createApplyCloseGuards(
  dependencies: CreateApplyDecisionWorkflowDependencies,
  {
    applyCloseReasons,
    applyKind,
    canClosePairCounterpartInThisRun,
    closedDir,
    commentSyncMinAgeDays,
    currentAuthorPrBudgetApplyGate,
    currentCloseState,
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
  }: ApplyCloseGuardContext,
) {
  const {
    abandonedPrApplyBlockReasonSafe,
    applyBlockingProtectedLabels,
    closeReasonApplyAgeSkipReason,
    closeReasonEnabled,
    closingPullRequestsForIssue,
    collectItemContext,
    commentBodyMatches,
    commentUpdatedAt,
    duplicateCanonicalPullRequestBlockReason,
    fetchItem,
    frontMatterValue,
    hasAutoCloseAllowedMetadata,
    hasVerifiedLocalCheckoutAccess,
    isApplyCloseCandidateReport,
    isMaintainerAuthorAssociation,
    isRetryableCloseSkipReport,
    issueRecentHumanCommentBlockReasonSafe,
    issueReviewComment,
    isVerifiedFixedCloseReason,
    itemSnapshotHash,
    markdownRepository,
    markedReviewCommentBody,
    normalizeAuthorAssociation,
    openClosingPullRequestApplyReason,
    renderReviewCommentFromReport,
    reportCloseReason,
    reportDecision,
    reportItemKind,
    reviewCommentBodyDigest,
    reviewCommentHashMatches,
    reviewSectionValue,
    sameAuthorCounterpartApplyReason,
    shouldSyncReviewComment,
    stalledUnprovenPrApplyBlockReasonSafe,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
    validateCloseDecision,
  } = dependencies;

  const sameAuthorPairStartCloseable = new Map<string, boolean>();

  const currentCloseGatesPassed = (): boolean => {
    const { closeReason, markdown, needsReviewCommentSync, storedUpdatedAt } = currentCloseState();
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
    if (closeReason === "stale_version_bug" && currentStaleVersionBugBlockReason()) {
      return false;
    }
    if (closeReason === "obsolete_fix_pr" && currentObsoleteFixPrBlockReason()) {
      return false;
    }
    if (closeReason === "author_pr_budget_exceeded" && !currentAuthorPrBudgetApplyGate().allowed) {
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
    const { closedCount, processedCount } = currentCloseState();
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
      const counterpartEntry = openReportEntry(counterpartNumber);
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
          const { item: counterpartItem, state: counterpartState } = fetchItem(counterpartNumber);
          const counterpartReviewedAuthorAssociation = normalizeAuthorAssociation(
            frontMatterValue(counterpartMarkdown, "author_association"),
          );
          const counterpartStoredUpdatedAt = frontMatterValue(
            counterpartMarkdown,
            "item_updated_at",
          );
          const counterpartStoredHash = frontMatterValue(counterpartMarkdown, "item_snapshot_hash");
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
              /^(?:none|unknown)?$/.test(
                frontMatterValue(counterpartMarkdown, "review_comment_id") ?? "",
              ) ||
              /^(?:none|unknown)?$/.test(
                frontMatterValue(counterpartMarkdown, "review_comment_url") ?? "",
              ),
            forceReviewCommentBodySync: false,
          });
          const counterpartReviewCommentOnlyUpdate =
            counterpartItem.updatedAt === commentUpdatedAt(counterpartReviewComment);
          const counterpartUpdatedSinceReview = Boolean(
            counterpartStoredUpdatedAt && counterpartItem.updatedAt !== counterpartStoredUpdatedAt,
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
            applyBlockingProtectedLabels(counterpartItem.labels, counterpartReason).length === 0 &&
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

  return { canStartSameAuthorPairCloseInThisRun };
}
