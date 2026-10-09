import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import type { ApplyResult, Item, ItemContext } from "./clawsweeper-types.js";
import { asRecord, login } from "./value-coerce.js";
import { parseIsoMs } from "./iso-time.js";

/**
 * A released review lease leaves no live timestamp. Its deletion must follow the review
 * generation's last recorded ClawSweeper write within the shortest apply-lease hold.
 */
export const OWNED_LEASE_RELEASE_RECEIPT_WINDOW_MS = 5 * 60 * 1000;

type ApplySourceFreshnessDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "CLAWSWEEPER_BOT_AUTHORS"
  | "commentBody"
  | "commentId"
  | "commentUpdatedAt"
  | "contextHasNonAutomationActivityAfter"
  | "fetchIssueReviewComments"
  | "freshPullRequestReviewHead"
  | "frontMatterValue"
  | "itemSnapshotHash"
  | "recordedLabelSyncCoversUpdate"
  | "reviewStartLeaseOwner"
  | "stringOrUndefined"
>;

interface ApplySourceFreshnessOptions {
  action: string | undefined;
  /** Live issue comments read after the apply fetched `item`. */
  comments: readonly Record<string, unknown>[];
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
    CLAWSWEEPER_BOT_AUTHORS,
    commentBody,
    commentId,
    commentUpdatedAt,
    contextHasNonAutomationActivityAfter,
    fetchIssueReviewComments,
    freshPullRequestReviewHead,
    frontMatterValue,
    itemSnapshotHash,
    recordedLabelSyncCoversUpdate,
    reviewStartLeaseOwner,
    stringOrUndefined,
  } = dependencies;
  const {
    action,
    comments,
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
    .filter((value): value is string => parseIsoMs(value) !== null)
    .sort((left, right) => (parseIsoMs(left) ?? 0) - (parseIsoMs(right) ?? 0))
    .at(-1);
  const { markdown, storedUpdatedAt } = currentState();
  const updatedSinceReview = Boolean(storedUpdatedAt && item.updatedAt !== storedUpdatedAt);
  const reviewCommentOnlyUpdate = item.updatedAt === existingReviewCommentUpdatedAt;
  const storedUpdatedAtMs = parseIsoMs(storedUpdatedAt);
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
  // ClawSweeper's own writes after the review snapshot (acknowledgement progress, durable review
  // sync, review/apply lease create and release, managed label edits) move updated_at without
  // changing the reviewed source. A later apply of the same review, such as the deferred batch
  // publisher, accepts such an update only when a receipt ClawSweeper recorded for this item
  // accounts for the latest updated_at and the review's complete activity receipt still matches.
  const itemUpdatedAtMs = parseIsoMs(item.updatedAt);
  const isClawSweeperLogin = (value: string | undefined): boolean =>
    CLAWSWEEPER_BOT_AUTHORS.has((value ?? "").trim().toLowerCase());
  const ownedItemMarker = new RegExp(
    `<!--\\s*clawsweeper-[\\w:-]+\\s[^>]*?\\bitem=${number}(?![0-9])`,
  );
  const ownedCommentWriteTimes = comments.flatMap((comment) => {
    const at = parseIsoMs(commentUpdatedAt(comment));
    return at !== null &&
      isClawSweeperLogin(login(asRecord(comment).user)) &&
      ownedItemMarker.test(commentBody(comment) ?? "")
      ? [at]
      : [];
  });
  // GitHub's timeline records ClawSweeper's label edits with their actor and time.
  const ownedTimelineWriteTimes = (): number[] =>
    (currentItemContext()[completeActivityContextSymbol]?.timeline ?? []).flatMap((event) => {
      const record = asRecord(event);
      const at = parseIsoMs(stringOrUndefined(record.createdAt));
      return at !== null && isClawSweeperLogin(stringOrUndefined(record.actor)) ? [at] : [];
    });
  const exactOwnedWriteAccountsForUpdate = (): boolean =>
    itemUpdatedAtMs !== null &&
    (ownedCommentWriteTimes.includes(itemUpdatedAtMs) ||
      ownedTimelineWriteTimes().includes(itemUpdatedAtMs));
  const reviewVersionAttribute = (marker: string, name: string): string | undefined =>
    marker.match(new RegExp(`\\b${name}=([^\\s>]+)`))?.[1];
  const durableCommentRecordsReviewGeneration = (): boolean => {
    if (!isClawSweeperLogin(login(asRecord(existingReviewComment).user))) return false;
    const marker = (commentBody(existingReviewComment) ?? "")
      .match(/<!--\s+clawsweeper-review-version\b[^>]*-->/g)
      ?.at(-1);
    if (!marker) return false;
    const reviewedAtMs = parseIsoMs(
      frontMatterValue(markdownBeforeApplyDecisionMutations, "reviewed_at"),
    );
    const sourceRevision = frontMatterValue(
      markdownBeforeApplyDecisionMutations,
      "item_source_revision",
    );
    return (
      Number(reviewVersionAttribute(marker, "item")) === number &&
      reviewVersionAttribute(marker, "v") === "1" &&
      reviewedAtMs !== null &&
      parseIsoMs(reviewVersionAttribute(marker, "reviewed_at")) === reviewedAtMs &&
      Boolean(sourceRevision) &&
      reviewVersionAttribute(marker, "source_revision") === sourceRevision &&
      reviewVersionAttribute(marker, "lease_owner") === reportReviewLeaseOwner &&
      Number(reviewVersionAttribute(marker, "lease_comment_id")) === reportReviewLeaseCommentId
    );
  };
  // Releasing the review generation's own lease deletes its comment and leaves no live timestamp.
  // The durable review comment names that generation and lease, so accept the deletion only when
  // it follows the generation's last recorded write within the apply-lease hold window.
  const releasedReviewLeaseAccountsForUpdate = (): boolean => {
    if (!requiresApplyMutationLease || itemUpdatedAtMs === null || storedUpdatedAtMs === null) {
      return false;
    }
    if (comments.some((comment) => commentId(comment) === reportReviewLeaseCommentId)) return false;
    if (!durableCommentRecordsReviewGeneration()) return false;
    const syncedAtMs = parseIsoMs(existingReviewCommentUpdatedAt);
    if (syncedAtMs === null || syncedAtMs < storedUpdatedAtMs) return false;
    const latestOwnedWriteMs = Math.max(
      syncedAtMs,
      ...ownedCommentWriteTimes,
      ...ownedTimelineWriteTimes(),
    );
    return (
      latestOwnedWriteMs <= itemUpdatedAtMs &&
      itemUpdatedAtMs - latestOwnedWriteMs <= OWNED_LEASE_RELEASE_RECEIPT_WINDOW_MS
    );
  };
  // Every receipt also requires that no non-automation comment, review comment, or timeline
  // event (including a human edit of a managed label) is visible after the review snapshot.
  const ownedAutomationReceiptOnlyUpdate = (): boolean =>
    updatedSinceReview &&
    reviewHasCompleteActivityIdentity &&
    storedUpdatedAtMs !== null &&
    (exactOwnedWriteAccountsForUpdate() || releasedReviewLeaseAccountsForUpdate()) &&
    completeAutomationReceiptMatchesReview() &&
    !contextHasNonAutomationActivityAfter(currentItemContext(), storedUpdatedAtMs - 1, {
      truncationCountsAsActivity: true,
      useCompleteActivityContext: true,
    });
  const { isCloseProposal } = currentState();
  const automationOnlyUpdate = Boolean(
    (reviewCommentOnlyUpdate ||
      labelSyncOnlyUpdate ||
      ownedIssueReviewLeaseOnlyUpdate ||
      commandStatusOnlyUpdate ||
      ownedAutomationReceiptOnlyUpdate()) &&
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
      const reviewedAtMs = parseIsoMs(frontMatterValue(markdown, "reviewed_at"));
      if (reviewedAtMs === null) return false;
      // GitHub activity has second precision; that whole second is ambiguous.
      const reviewSecondStartMs = Math.floor(reviewedAtMs / 1000) * 1000;
      return !contextHasNonAutomationActivityAfter(currentItemContext(), reviewSecondStartMs - 1, {
        useCompleteActivityContext: true,
      });
    }
    if (!updatedSinceReview || automationOnlyUpdate) return true;
    if (!completeFreshHeadReview) {
      const latestAutomationMs = parseIsoMs(latestAutomationUpdatedAt);
      const itemUpdatedAtMs = parseIsoMs(item.updatedAt);
      if (latestAutomationMs === null || itemUpdatedAtMs === null) return false;
      if (Math.abs(itemUpdatedAtMs - latestAutomationMs) > 5 * 60 * 1000) return false;
    }
    const reviewedTimestampMs = parseIsoMs(storedUpdatedAt);
    if (reviewedTimestampMs === null) return false;
    const reviewedAtMs = parseIsoMs(frontMatterValue(markdown, "reviewed_at"));
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
