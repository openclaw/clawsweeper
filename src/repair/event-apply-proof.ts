import type { LooseRecord } from "./json-types.js";

export type EventApplyAction = {
  number: number | null;
  action: string;
  reason: string;
  durableReviewSynced: boolean;
  terminalMissingVerified: boolean;
  terminalStateVerified: boolean;
  guardedOpenStateVerified: boolean;
  terminalPolicyNoopVerified: boolean;
  sourceDriftVerified: boolean;
};

export type ExactEventPublishDisposition = {
  guardedOpenAction: string | null;
  routableSyncVerified: boolean;
  terminalClosed: boolean;
  terminalMissing: boolean;
};

const GUARDED_OPEN_ACTIONS = new Set([
  "skipped_locked_conversation",
  "skipped_maintainer_authored",
  "skipped_open_closing_pr",
  "skipped_protected_label",
  "skipped_close_exempt_label",
  "skipped_low_signal_live_guard",
  "skipped_same_author_pair",
]);

const LEGACY_TUPLELESS_REVIEW_LEASE_REASON = "local report has no durable lease identity";

export function exactEventPublishDisposition({
  candidateMatchesCurrentTuple,
  candidateTupleState,
  terminalClosedExpected,
  terminalMissingExpected,
  guardedOpenAction,
  routableSyncExpected = false,
}: {
  candidateMatchesCurrentTuple: boolean;
  candidateTupleState: "closed" | "open" | "invalid";
  terminalClosedExpected: boolean;
  terminalMissingExpected: boolean;
  guardedOpenAction: string | null;
  routableSyncExpected?: boolean;
}): ExactEventPublishDisposition {
  const terminalTupleMatches = candidateMatchesCurrentTuple && candidateTupleState === "closed";
  const terminalMissing = terminalMissingExpected && terminalTupleMatches;
  const terminalClosed = !terminalMissing && terminalClosedExpected && terminalTupleMatches;
  return {
    terminalClosed,
    terminalMissing,
    routableSyncVerified:
      routableSyncExpected && candidateMatchesCurrentTuple && candidateTupleState === "open",
    guardedOpenAction:
      !terminalClosed &&
      !terminalMissing &&
      candidateMatchesCurrentTuple &&
      candidateTupleState === "open"
        ? guardedOpenAction
        : null,
  };
}

export type ExactEventApplyDisposition =
  | "applied"
  | "terminal_policy_noop"
  | "source_drift"
  | "unproven";

export function eventApplyRequeueLatestExpected({
  disposition,
  exactEventPublication,
  legacyTuplelessReviewLease,
}: {
  disposition: ExactEventApplyDisposition;
  exactEventPublication: boolean;
  legacyTuplelessReviewLease: boolean;
}): boolean {
  return disposition === "source_drift" || (exactEventPublication && legacyTuplelessReviewLease);
}

export function exactEventApplyProof(
  actions: readonly EventApplyAction[],
  itemNumber: number,
  snapshotActionTaken: string | null = null,
): {
  exactActions: EventApplyAction[];
  syncedCount: number;
  terminalMissingCount: number;
  terminalCount: number;
  guardedOpenAction: string | null;
  latestRevisionRequeueRequired: boolean;
  legacyTuplelessReviewLease: boolean;
  disposition: ExactEventApplyDisposition;
} {
  const exactActions = actions.filter((entry) => entry.number === itemNumber);
  const soleExactResult =
    actions.length === 1 && exactActions.length === 1 ? (exactActions[0] ?? null) : null;
  const soleExactAction = soleExactResult?.action ?? "";
  const syncedCount = exactActions.filter((entry) => entry.durableReviewSynced).length;
  const terminalCount = exactActions.filter((entry) => entry.terminalStateVerified).length;
  const terminalPolicyNoop =
    exactActions.length > 0 &&
    exactActions.every(
      (entry) => entry.action === "skipped_same_author_pair" && entry.terminalPolicyNoopVerified,
    );
  const sourceDriftActions = exactActions.filter(
    (entry) => entry.action === "skipped_changed_since_review",
  );
  const hasSourceDrift = sourceDriftActions.length > 0;
  const sourceDrift =
    hasSourceDrift &&
    sourceDriftActions.every((entry) => entry.sourceDriftVerified) &&
    exactActions.every(
      (entry) =>
        entry.action === "skipped_changed_since_review" ||
        entry.durableReviewSynced ||
        entry.terminalStateVerified,
    );
  return {
    exactActions,
    syncedCount,
    terminalMissingCount: exactActions.filter((entry) => entry.terminalMissingVerified).length,
    terminalCount,
    guardedOpenAction:
      snapshotActionTaken === soleExactAction &&
      soleExactResult?.guardedOpenStateVerified === true &&
      GUARDED_OPEN_ACTIONS.has(soleExactAction)
        ? soleExactAction
        : null,
    latestRevisionRequeueRequired:
      snapshotActionTaken === "skipped_changed_since_review" &&
      soleExactAction === "skipped_changed_since_review",
    legacyTuplelessReviewLease:
      soleExactAction === "skipped_stale_review_comment_sync" &&
      soleExactResult?.reason.includes(LEGACY_TUPLELESS_REVIEW_LEASE_REASON) === true,
    disposition: hasSourceDrift
      ? sourceDrift
        ? "source_drift"
        : "unproven"
      : terminalPolicyNoop
        ? "terminal_policy_noop"
        : syncedCount + terminalCount > 0
          ? "applied"
          : "unproven",
  };
}

export function eventRecordActionTaken(markdown: string | null): string | null {
  if (markdown === null) return null;
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return null;
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^action_taken:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function eventApplyAction(value: LooseRecord): EventApplyAction {
  return {
    number: typeof value.number === "number" ? value.number : null,
    action: typeof value.action === "string" ? value.action : "",
    reason: typeof value.reason === "string" ? value.reason : "",
    durableReviewSynced: value.durableReviewSynced === true,
    terminalMissingVerified: value.terminalMissingVerified === true,
    terminalStateVerified: value.terminalStateVerified === true,
    guardedOpenStateVerified: value.guardedOpenStateVerified === true,
    terminalPolicyNoopVerified: value.terminalPolicyNoopVerified === true,
    sourceDriftVerified: value.sourceDriftVerified === true,
  };
}
