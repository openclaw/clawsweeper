import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type { ApplyResult, Item, ItemContext } from "./clawsweeper-types.js";

type ApplySourceFreshnessDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "asRecord"
  | "CLAWSWEEPER_BOT_AUTHORS"
  | "commentBody"
  | "commentId"
  | "commentUpdatedAt"
  | "contextHasNonAutomationActivityAfter"
  | "fetchIssueReviewComments"
  | "freshPullRequestReviewHead"
  | "frontMatterValue"
  | "itemSnapshotHash"
  | "login"
  | "recordedLabelSyncCoversUpdate"
  | "reviewStartLeaseOwner"
  | "stringOrUndefined"
  | "timestampMs"
>;

interface ApplySourceFreshnessOptions {
  action: string | undefined;
  completeReviewActivityReceiptMatches: (context: ItemContext) => boolean;
  currentItemContext: () => ItemContext;
  currentState: () => {
    isCloseProposal: boolean;
    markdown: string;
    storedUpdatedAt: string | undefined;
  };
  existingReviewComment: Record<string, unknown> | undefined;
  item: Item;
  leaseComments: readonly Record<string, unknown>[];
  markdownBeforeApplyDecisionMutations: string;
  number: number;
  reportLabelsBeforeApply: readonly string[];
  reportReviewLeaseCommentId: number;
  reportReviewLeaseOwner: string | undefined;
  reviewHasCompleteActivityIdentity: boolean;
  requiresApplyMutationLease: boolean;
  storedHash: string | undefined;
}

interface ApplyChangedSinceReviewMarkerOptions {
  dryRun: boolean;
  emitEventApplyProof: boolean;
  getMarkdown: () => string;
  getProcessedCount: () => number;
  maybeLogProgress: (message: string) => void;
  number: number;
  path: string;
  processedLimit: number;
  results: ApplyResult[];
  setMarkdown: (markdown: string) => void;
  setProcessedCount: (count: number) => void;
  writeReportMarkdown: (path: string, markdown: string) => void;
}

export function createApplyChangedSinceReviewMarker(
  {
    replaceFrontMatterValue,
  }: Pick<CreateApplyDecisionWorkflowDependencies, "replaceFrontMatterValue">,
  options: ApplyChangedSinceReviewMarkerOptions,
) {
  return ({
    reason,
    currentUpdatedAt,
    currentSnapshotHash,
    currentLabels,
    preserveAction,
  }: {
    reason: string;
    currentUpdatedAt?: string | undefined;
    currentSnapshotHash?: string | undefined;
    currentLabels?: string[] | undefined;
    preserveAction?: string | undefined;
  }): boolean => {
    let markdown = replaceFrontMatterValue(
      options.getMarkdown(),
      "action_taken",
      preserveAction ?? "skipped_changed_since_review",
    );
    if (currentLabels) {
      markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(currentLabels));
    }
    if (currentUpdatedAt) {
      markdown = replaceFrontMatterValue(markdown, "current_item_updated_at", currentUpdatedAt);
    }
    if (currentSnapshotHash) {
      markdown = replaceFrontMatterValue(
        markdown,
        "current_item_snapshot_hash",
        currentSnapshotHash,
      );
    }
    markdown = replaceFrontMatterValue(markdown, "apply_checked_at", new Date().toISOString());
    options.setMarkdown(markdown);
    if (!options.dryRun) options.writeReportMarkdown(options.path, markdown);
    options.results.push({
      number: options.number,
      action: "skipped_changed_since_review",
      reason,
      ...(options.emitEventApplyProof ? { sourceDriftVerified: true } : {}),
    });
    const processedCount = options.getProcessedCount() + 1;
    options.setProcessedCount(processedCount);
    options.maybeLogProgress(`skipped #${options.number}: ${reason}`);
    return processedCount >= options.processedLimit;
  };
}

export function applyReviewedSourceDriftEvidence(
  { itemSnapshotHash }: Pick<CreateApplyDecisionWorkflowDependencies, "itemSnapshotHash">,
  options: {
    currentItemContext: () => ItemContext;
    item: Item;
    storedUpdatedAt: string | undefined;
  },
): {
  reason: string;
  currentUpdatedAt?: string;
  currentSnapshotHash?: string;
  currentLabels: string[];
} {
  return options.storedUpdatedAt
    ? {
        reason: "updated_at changed",
        currentUpdatedAt: options.item.updatedAt,
        currentLabels: options.item.labels,
      }
    : {
        reason: "snapshot changed",
        currentSnapshotHash: itemSnapshotHash(options.item, options.currentItemContext()),
        currentLabels: options.item.labels,
      };
}

export function createApplySourceFreshness(
  dependencies: ApplySourceFreshnessDependencies,
  options: ApplySourceFreshnessOptions,
) {
  const {
    asRecord,
    CLAWSWEEPER_BOT_AUTHORS,
    commentBody,
    commentId,
    commentUpdatedAt,
    contextHasNonAutomationActivityAfter,
    fetchIssueReviewComments,
    freshPullRequestReviewHead,
    frontMatterValue,
    itemSnapshotHash,
    login,
    recordedLabelSyncCoversUpdate,
    reviewStartLeaseOwner,
    stringOrUndefined,
    timestampMs,
  } = dependencies;
  const {
    action,
    completeReviewActivityReceiptMatches,
    currentItemContext,
    currentState,
    existingReviewComment,
    item,
    leaseComments,
    markdownBeforeApplyDecisionMutations,
    number,
    reportLabelsBeforeApply,
    reportReviewLeaseCommentId,
    reportReviewLeaseOwner,
    reviewHasCompleteActivityIdentity,
    requiresApplyMutationLease,
    storedHash,
  } = options;
  const existingReviewCommentUpdatedAt = commentUpdatedAt(existingReviewComment);
  const reportOwnedLeaseComments = requiresApplyMutationLease
    ? leaseComments.filter(
        (comment) =>
          commentId(comment) === reportReviewLeaseCommentId &&
          reviewStartLeaseOwner(comment) === reportReviewLeaseOwner,
      )
    : [];
  const latestAutomationUpdatedAt = [existingReviewComment, ...reportOwnedLeaseComments]
    .map(commentUpdatedAt)
    .filter((value): value is string => timestampMs(value) !== null)
    .sort((left, right) => (timestampMs(left) ?? 0) - (timestampMs(right) ?? 0))
    .at(-1);
  const { markdown, storedUpdatedAt } = currentState();
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
    (reviewHasCompleteActivityIdentity
      ? completeReviewActivityReceiptMatches(currentItemContext())
      : !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs - 1, {
          truncationCountsAsActivity: true,
          useCompleteActivityContext: true,
        })),
  );
  const ownedIssueReviewLeaseOnlyUpdate = Boolean(
    item.kind === "issue" &&
    updatedSinceReview &&
    storedUpdatedAtMs !== null &&
    reportOwnedLeaseComments.some((comment) => commentUpdatedAt(comment) === item.updatedAt) &&
    (reviewHasCompleteActivityIdentity
      ? completeReviewActivityReceiptMatches(currentItemContext())
      : !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs - 1, {
          truncationCountsAsActivity: true,
          useCompleteActivityContext: true,
        })),
  );
  let statusComments: Record<string, unknown>[] | undefined;
  const reviewedSourceRevision = frontMatterValue(
    markdownBeforeApplyDecisionMutations,
    "item_source_revision",
  );
  const retryCloseCoverageCommandStatusOnlyUpdate = (
    candidate: Item,
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
    // Excluded bot status comments can advance updated_at without changing reviewed source.
    const comment = (statusComments ??= fetchIssueReviewComments(number)).find(
      (entry) =>
        commentUpdatedAt(entry) === candidate.updatedAt &&
        CLAWSWEEPER_BOT_AUTHORS.has((login(asRecord(entry).user) ?? "").trim().toLowerCase()) &&
        (commentBody(entry) ?? "").includes("<!-- clawsweeper-command-status:"),
    );
    const createdAt = comment ? stringOrUndefined(comment.created_at) : undefined;
    return Boolean(
      createdAt &&
      (reviewHasCompleteActivityIdentity
        ? completeReviewActivityReceiptMatches(candidateContext)
        : !contextHasNonAutomationActivityAfter(candidateContext, storedUpdatedAtMs - 1, {
            truncationCountsAsActivity: true,
            useCompleteActivityContext: true,
            ignoreTrustedTimelineComment: { authors: CLAWSWEEPER_BOT_AUTHORS, createdAt },
          })),
    );
  };
  const commandStatusOnlyUpdate =
    action === "retry_pr_close_coverage_proof" &&
    retryCloseCoverageCommandStatusOnlyUpdate(item, currentItemContext());
  const completeAutomationReceiptMatchesReview = (): boolean =>
    completeReviewActivityReceiptMatches(currentItemContext());
  const { isCloseProposal } = currentState();
  const automationOnlyUpdate = Boolean(
    (reviewCommentOnlyUpdate ||
      labelSyncOnlyUpdate ||
      ownedIssueReviewLeaseOnlyUpdate ||
      commandStatusOnlyUpdate) &&
    (!isCloseProposal ||
      !reviewHasCompleteActivityIdentity ||
      completeAutomationReceiptMatchesReview()),
  );
  const sameSecondCloseActivityIsAmbiguous = Boolean(
    isCloseProposal &&
    reviewHasCompleteActivityIdentity &&
    storedUpdatedAt &&
    item.updatedAt === storedUpdatedAt &&
    !completeAutomationReceiptMatchesReview(),
  );
  const reviewedSourceFresh = (): boolean =>
    storedUpdatedAt
      ? !updatedSinceReview || automationOnlyUpdate
      : reviewCommentOnlyUpdate || itemSnapshotHash(item, currentItemContext()) === storedHash;
  const labelSyncFreshEnough = (): boolean => {
    const { isCloseProposal, markdown, storedUpdatedAt } = currentState();
    if (!storedUpdatedAt) return false;
    const completeFreshHeadReview =
      !isCloseProposal &&
      item.kind === "pull_request" &&
      frontMatterValue(markdown, "review_status") === "complete" &&
      freshPullRequestReviewHead(markdown, currentItemContext());
    if (completeFreshHeadReview && reviewHasCompleteActivityIdentity) {
      if (!completeReviewActivityReceiptMatches(currentItemContext())) return false;
      const reviewedAtMs = timestampMs(frontMatterValue(markdown, "reviewed_at"));
      if (reviewedAtMs === null) return false;
      // GitHub activity has second precision; that whole second is ambiguous.
      const reviewSecondStartMs = Math.floor(reviewedAtMs / 1000) * 1000;
      return !contextHasNonAutomationActivityAfter(currentItemContext(), reviewSecondStartMs - 1, {
        useCompleteActivityContext: true,
      });
    }
    if (!updatedSinceReview || automationOnlyUpdate) return true;
    if (!completeFreshHeadReview) {
      const latestAutomationMs = timestampMs(latestAutomationUpdatedAt);
      const itemUpdatedAtMs = timestampMs(item.updatedAt);
      if (latestAutomationMs === null || itemUpdatedAtMs === null) return false;
      if (Math.abs(itemUpdatedAtMs - latestAutomationMs) > 5 * 60 * 1000) return false;
    }
    const reviewedTimestampMs = timestampMs(storedUpdatedAt);
    if (reviewedTimestampMs === null) return false;
    const reviewedAtMs = timestampMs(frontMatterValue(markdown, "reviewed_at"));
    return !contextHasNonAutomationActivityAfter(currentItemContext(), reviewedTimestampMs, {
      useCompleteActivityContext: true,
      ...(reviewedAtMs === null ? {} : { ignoreTimelineCommentsThroughMs: reviewedAtMs }),
    });
  };

  return {
    automationOnlyUpdate,
    labelSyncFreshEnough,
    reviewedSourceFresh,
    retryCloseCoverageCommandStatusOnlyUpdate,
    reviewCommentOnlyUpdate,
    sameSecondCloseActivityIsAmbiguous,
    updatedSinceReview,
  };
}
