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
  allowedSelfMutationUpdatedAts: Set<string>;
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
  }: {
    reason: string;
    currentUpdatedAt?: string | undefined;
    currentSnapshotHash?: string | undefined;
  }): boolean => {
    let markdown = replaceFrontMatterValue(
      options.getMarkdown(),
      "action_taken",
      "skipped_changed_since_review",
    );
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
): { reason: string; currentUpdatedAt?: string; currentSnapshotHash?: string } {
  return options.storedUpdatedAt
    ? { reason: "updated_at changed", currentUpdatedAt: options.item.updatedAt }
    : {
        reason: "snapshot changed",
        currentSnapshotHash: itemSnapshotHash(options.item, options.currentItemContext()),
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
    allowedSelfMutationUpdatedAts,
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
    requiresApplyMutationLease,
    storedHash,
  } = options;
  const existingReviewCommentUpdatedAt = commentUpdatedAt(existingReviewComment);
  if (existingReviewCommentUpdatedAt) {
    allowedSelfMutationUpdatedAts.add(existingReviewCommentUpdatedAt);
  }
  const reportOwnedLeaseComments = requiresApplyMutationLease
    ? leaseComments.filter(
        (comment) =>
          commentId(comment) === reportReviewLeaseCommentId &&
          reviewStartLeaseOwner(comment) === reportReviewLeaseOwner,
      )
    : [];
  for (const updatedAt of reportOwnedLeaseComments
    .map(commentUpdatedAt)
    .filter((value): value is string => timestampMs(value) !== null)) {
    allowedSelfMutationUpdatedAts.add(updatedAt);
  }
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
    !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs, {
      truncationCountsAsActivity: true,
    }),
  );
  const ownedIssueReviewLeaseOnlyUpdate = Boolean(
    item.kind === "issue" &&
    updatedSinceReview &&
    storedUpdatedAtMs !== null &&
    reportOwnedLeaseComments.some((comment) => commentUpdatedAt(comment) === item.updatedAt) &&
    !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs, {
      truncationCountsAsActivity: true,
    }),
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
      !contextHasNonAutomationActivityAfter(candidateContext, storedUpdatedAtMs, {
        truncationCountsAsActivity: true,
        ignoreTrustedTimelineComment: { authors: CLAWSWEEPER_BOT_AUTHORS, createdAt },
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
  const reviewedSourceFresh = (): boolean =>
    storedUpdatedAt
      ? !updatedSinceReview || automationOnlyUpdate
      : reviewCommentOnlyUpdate || itemSnapshotHash(item, currentItemContext()) === storedHash;
  const labelSyncFreshEnough = (): boolean => {
    const { isCloseProposal, markdown, storedUpdatedAt } = currentState();
    if (!storedUpdatedAt) return false;
    if (!updatedSinceReview || automationOnlyUpdate) return true;
    const completeFreshHeadReview =
      !isCloseProposal &&
      item.kind === "pull_request" &&
      frontMatterValue(markdown, "review_status") === "complete" &&
      freshPullRequestReviewHead(markdown, currentItemContext());
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
    updatedSinceReview,
  };
}
