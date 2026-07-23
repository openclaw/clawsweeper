export type ReviewDispatchCoordinationDecision =
  | { action: "dispatch" }
  | { action: "wait_for_active_review"; reason: string }
  | { action: "reuse_completed_review"; commentId: number; reason: string }
  | { action: "retry"; reason: string }
  | { action: "stop"; reason: string };

export type ReviewDispatchCoordinationInput = {
  stateBefore: string;
  stateAfter: string;
  headBefore: string;
  headAfter: string;
  activeLeaseExpiresAt: string | null;
  completedReviewAt: string | null;
  completedReviewCommentId: number | null;
  completedReviewSourceRevision: string | null;
  sourceRevisionBefore: string;
  sourceRevisionAfter: string;
};

export function decideReviewDispatchCoordination({
  stateBefore,
  stateAfter,
  headBefore,
  headAfter,
  activeLeaseExpiresAt,
  completedReviewAt,
  completedReviewCommentId,
  completedReviewSourceRevision,
  sourceRevisionBefore,
  sourceRevisionAfter,
}: ReviewDispatchCoordinationInput): ReviewDispatchCoordinationDecision {
  if (!isOpen(stateBefore) || !isOpen(stateAfter)) {
    return { action: "stop", reason: "target is no longer an open PR" };
  }
  if (!headBefore || !headAfter || headBefore !== headAfter) {
    return {
      action: "retry",
      reason: "PR head changed during the dispatch-time review check; next router pass will retry",
    };
  }
  if (
    !sourceRevisionBefore ||
    !sourceRevisionAfter ||
    sourceRevisionBefore !== sourceRevisionAfter
  ) {
    return {
      action: "retry",
      reason:
        "PR source changed during the dispatch-time review check; next router pass will retry",
    };
  }
  // At-least-once command delivery makes an active exact-head lease a normal
  // coordination result. Reuse its eventual verdict instead of creating more work.
  if (activeLeaseExpiresAt) {
    return {
      action: "wait_for_active_review",
      reason: `same-head ClawSweeper review is active until ${activeLeaseExpiresAt}`,
    };
  }
  if (completedReviewAt && completedReviewCommentId) {
    const reviewedRevision = String(completedReviewSourceRevision ?? "")
      .trim()
      .toLowerCase();
    // Only a truly missing revision belongs to the legacy compatibility path.
    // Any present but unverifiable marker needs a new review.
    if (
      reviewedRevision &&
      (!/^[0-9a-f]{64}$/.test(reviewedRevision) || reviewedRevision !== sourceRevisionAfter)
    ) {
      return { action: "dispatch" };
    }
    return {
      action: "reuse_completed_review",
      commentId: completedReviewCommentId,
      reason: `same-head ClawSweeper review completed at ${completedReviewAt}; its result will be reused`,
    };
  }
  return { action: "dispatch" };
}

function isOpen(state: string) {
  return (
    String(state ?? "")
      .trim()
      .toUpperCase() === "OPEN"
  );
}
