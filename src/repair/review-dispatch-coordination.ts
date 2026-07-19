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
};

export function decideReviewDispatchCoordination({
  stateBefore,
  stateAfter,
  headBefore,
  headAfter,
  activeLeaseExpiresAt,
  completedReviewAt,
  completedReviewCommentId,
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
  // At-least-once command delivery makes an active exact-head lease a normal
  // coordination result. Reuse its eventual verdict instead of creating more work.
  if (activeLeaseExpiresAt) {
    return {
      action: "wait_for_active_review",
      reason: `same-head ClawSweeper review is active until ${activeLeaseExpiresAt}`,
    };
  }
  if (completedReviewAt && completedReviewCommentId) {
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
