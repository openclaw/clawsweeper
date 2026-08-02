import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type {
  ActionTaken,
  ApplyResult,
  CloseReason,
  Item,
  ItemContext,
  PrCloseCoverageProofGateBlock,
} from "./clawsweeper-types.js";

type ApplyReviewGuardDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "applyClosedUnmergedCanonicalBlockedReport"
  | "canonicalPullRequestCommentSyncBlock"
  | "isExactEventSourceRevisionChange"
  | "replaceFrontMatterValue"
  | "reviewCommentHasCloseVerdictForCanonical"
  | "staleCanonicalPullRequestNumber"
  | "staleReviewCommentSyncReason"
>;

export interface ApplyReviewGuardState {
  closeBlockedForCommentSync: PrCloseCoverageProofGateBlock | null;
  closeReason: CloseReason | undefined;
  isCloseProposal: boolean;
  markdown: string;
  staleCanonicalCommentSyncPending: boolean;
}

interface ApplyReviewGuardOptions {
  currentItemContext: () => ItemContext;
  decision: string | undefined;
  dryRun: boolean;
  emitEventApplyProof: boolean;
  exactEventPublication: boolean;
  getProcessedCount: () => number;
  getState: () => ApplyReviewGuardState;
  item: Item;
  liveState: string;
  markApplySkipped: (action: ActionTaken, reason: string, liveGuardVerified?: boolean) => boolean;
  markdownBeforeApplyDecisionMutations: string;
  maybeLogProgress: (message: string) => void;
  number: number;
  path: string;
  processedLimit: number;
  recordApplySkipped: (action: ActionTaken, reason: string, liveGuardVerified?: boolean) => boolean;
  results: ApplyResult[];
  setProcessedCount: (value: number) => void;
  setState: (state: ApplyReviewGuardState) => void;
  shouldProbeClosedState: boolean;
  writeReportMarkdown: (path: string, markdown: string) => void;
}

export function createApplyReviewGuards(
  dependencies: ApplyReviewGuardDependencies,
  options: ApplyReviewGuardOptions,
) {
  const {
    applyClosedUnmergedCanonicalBlockedReport,
    canonicalPullRequestCommentSyncBlock,
    isExactEventSourceRevisionChange,
    replaceFrontMatterValue,
    reviewCommentHasCloseVerdictForCanonical,
    staleCanonicalPullRequestNumber,
    staleReviewCommentSyncReason,
  } = dependencies;
  const {
    currentItemContext,
    decision,
    dryRun,
    emitEventApplyProof,
    exactEventPublication,
    getProcessedCount,
    getState,
    item,
    liveState,
    markApplySkipped,
    markdownBeforeApplyDecisionMutations,
    maybeLogProgress,
    number,
    path,
    processedLimit,
    recordApplySkipped,
    results,
    setProcessedCount,
    setState,
    shouldProbeClosedState,
    writeReportMarkdown,
  } = options;
  let canonicalCommentSyncChecked = false;
  let staleCanonicalClosedUnmergedValidated = false;

  const recordReviewGuardSkip = (
    action: "kept_open" | "skipped_stale_review_comment_sync",
    reason: string,
    restoreOriginal = true,
    activeReviewLeaseExpiresAt?: string,
  ): boolean => {
    const state = getState();
    const markdown = replaceFrontMatterValue(
      restoreOriginal ? markdownBeforeApplyDecisionMutations : state.markdown,
      "apply_checked_at",
      new Date().toISOString(),
    );
    setState({ ...state, markdown });
    if (!dryRun) writeReportMarkdown(path, markdown);
    results.push({
      number,
      action,
      reason,
      ...(emitEventApplyProof && action === "kept_open" && activeReviewLeaseExpiresAt
        ? { activeReviewLeaseVerified: true, activeReviewLeaseExpiresAt }
        : {}),
    });
    const processedCount = getProcessedCount() + 1;
    setProcessedCount(processedCount);
    maybeLogProgress(`skipped #${number}: ${reason}`);
    return processedCount >= processedLimit;
  };
  const recordReviewLeaseSkip = (
    reason: string,
    restoreOriginal = true,
    activeReviewLeaseExpiresAt?: string,
  ): boolean => {
    const sourceChanged =
      reason === "pull request review activity changed since review" ||
      reason === "pull request review activity exceeds the bounded reviewed cursor" ||
      (exactEventPublication && isExactEventSourceRevisionChange(item.kind, reason));
    if (sourceChanged) return markApplySkipped("skipped_changed_since_review", reason);
    if (getState().staleCanonicalCommentSyncPending) {
      return markApplySkipped(
        "retry_stale_canonical_comment_sync",
        `${reason}; stale canonical comment correction remains pending`,
      );
    }
    return recordReviewGuardSkip("kept_open", reason, restoreOriginal, activeReviewLeaseExpiresAt);
  };
  const recordActiveReviewLeaseSkip = (expiresAt: string): boolean =>
    recordReviewLeaseSkip(
      `${item.kind === "pull_request" ? "same-head" : "same-revision"} ClawSweeper review is active until ${expiresAt}`,
      true,
      expiresAt,
    );
  const shouldCheckCanonicalCommentSync = (): boolean => {
    const state = getState();
    return (
      liveState === "open" &&
      (state.staleCanonicalCommentSyncPending ||
        (state.closeReason === "duplicate_or_superseded" &&
          (state.isCloseProposal || (decision === "close" && shouldProbeClosedState))))
    );
  };
  const applyCanonicalCommentSyncGuard = (
    forceRecheck = false,
  ): { skipCurrentItem: boolean; stopApply: boolean } => {
    if ((canonicalCommentSyncChecked && !forceRecheck) || !shouldCheckCanonicalCommentSync()) {
      return { skipCurrentItem: false, stopApply: false };
    }
    canonicalCommentSyncChecked = true;
    staleCanonicalClosedUnmergedValidated = false;
    const state = getState();
    const pendingCanonicalNumber = state.staleCanonicalCommentSyncPending
      ? staleCanonicalPullRequestNumber(state.markdown)
      : null;
    if (state.staleCanonicalCommentSyncPending && pendingCanonicalNumber === null) {
      const reason =
        "pending stale canonical comment correction lacks its canonical PR identity; fresh review required";
      return {
        skipCurrentItem: true,
        stopApply: markApplySkipped("retry_stale_canonical_comment_sync", reason),
      };
    }
    const block = canonicalPullRequestCommentSyncBlock(state.markdown, item);
    if (block?.kind === "unreadable") {
      const action: ActionTaken = state.staleCanonicalCommentSyncPending
        ? "retry_stale_canonical_comment_sync"
        : "retry_pr_close_coverage_proof";
      return {
        skipCurrentItem: true,
        stopApply: state.staleCanonicalCommentSyncPending
          ? markApplySkipped(action, block.reason)
          : recordApplySkipped(action, block.reason),
      };
    }
    if (block?.kind === "closed_unmerged") {
      staleCanonicalClosedUnmergedValidated = true;
      const closeBlockedForCommentSync: PrCloseCoverageProofGateBlock = {
        actionTaken: "kept_open",
        reason: block.reason,
      };
      setState({
        ...state,
        closeBlockedForCommentSync,
        closeReason: "none",
        isCloseProposal: false,
        markdown: applyClosedUnmergedCanonicalBlockedReport(
          state.markdown,
          closeBlockedForCommentSync,
          block.number,
        ),
        staleCanonicalCommentSyncPending: true,
      });
      return { skipCurrentItem: false, stopApply: false };
    }
    if (state.staleCanonicalCommentSyncPending && pendingCanonicalNumber !== null) {
      const reason = `linked canonical PR #${pendingCanonicalNumber} is no longer closed and unmerged; fresh review required before stale comment correction`;
      return {
        skipCurrentItem: true,
        stopApply: markApplySkipped("retry_stale_canonical_comment_sync", reason),
      };
    }
    return { skipCurrentItem: false, stopApply: false };
  };
  const canonicalBoundStaleReviewReason = (
    sourceMarkdown: string,
    comment: Record<string, unknown> | undefined,
  ): string | null => {
    const staleReason = staleReviewCommentSyncReason(
      sourceMarkdown,
      comment,
      number,
      item.kind === "pull_request" ? currentItemContext() : undefined,
    );
    const pendingCanonicalNumber = staleCanonicalPullRequestNumber(getState().markdown);
    if (!staleCanonicalClosedUnmergedValidated || pendingCanonicalNumber === null)
      return staleReason;
    if (
      reviewCommentHasCloseVerdictForCanonical(
        comment,
        number,
        "duplicate_or_superseded",
        pendingCanonicalNumber,
      )
    ) {
      return null;
    }
    return (
      staleReason ??
      `live durable review comment is not bound to stored canonical PR #${pendingCanonicalNumber}; fresh review required before stale comment correction`
    );
  };
  const refreshedReviewStaleReason = (comment: Record<string, unknown> | undefined) =>
    canonicalBoundStaleReviewReason(markdownBeforeApplyDecisionMutations, comment);
  const recordRefreshedReviewStaleReason = (reason: string): boolean =>
    getState().staleCanonicalCommentSyncPending
      ? markApplySkipped(
          "retry_stale_canonical_comment_sync",
          `${reason}; stale canonical comment correction remains pending`,
        )
      : recordReviewGuardSkip("skipped_stale_review_comment_sync", reason);

  return {
    applyCanonicalCommentSyncGuard,
    canonicalBoundStaleReviewReason,
    recordActiveReviewLeaseSkip,
    recordRefreshedReviewStaleReason,
    recordReviewGuardSkip,
    recordReviewLeaseSkip,
    refreshedReviewStaleReason,
    shouldCheckCanonicalCommentSync,
  };
}
