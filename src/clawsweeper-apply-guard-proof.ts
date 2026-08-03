import {
  ABANDONED_PR_MIN_AGE_DAYS,
  ABANDONED_PR_MIN_INACTIVE_DAYS,
  DAY_MS,
  PROOF_NUDGE_MARKER_PREFIX,
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
  STALLED_UNPROVEN_PR_MIN_AGE_DAYS,
  STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS,
  WAITING_ON_AUTHOR_LABEL,
} from "./clawsweeper-policy.js";
import type { Item } from "./clawsweeper-types.js";
import type { ApplyGuardDependencies } from "./clawsweeper-apply-guard-dependencies.js";
import type { createApplyGuardActivity } from "./clawsweeper-apply-guard-activity.js";
import type { createApplyGuardPolicy } from "./clawsweeper-apply-guard-policy.js";

export function createApplyGuardProof(
  dependencies: ApplyGuardDependencies &
    ReturnType<typeof createApplyGuardActivity> &
    ReturnType<typeof createApplyGuardPolicy>,
) {
  const {
    asRecord,
    ghPaged,
    isOlderThanDays,
    normalizeLabelName,
    targetRepo,
    pullRequestHumanEngagementBlockReason,
    pullRequestLiveActivity,
    prAutoCloseExemptLabel,
  } = dependencies;

  function stalledUnprovenPrAgeSkipReason(
    item: Pick<Item, "createdAt">,
    now = Date.now(),
  ): string | null {
    if (!isOlderThanDays(item.createdAt, STALLED_UNPROVEN_PR_MIN_AGE_DAYS, now)) {
      return `stalled_unproven_pr requires PR older than ${STALLED_UNPROVEN_PR_MIN_AGE_DAYS} days`;
    }
    return null;
  }
  const STALLED_PROOF_REQUEST_LABELS = new Set([
    "triage: needs-real-behavior-proof",
    "status: 📣 needs proof",
  ]);
  function stalledUnprovenProofRequestBlockReason(number: number, now = Date.now()): string | null {
    let earliestRequestAtMs: number | null = null;
    const observe = (value: unknown): void => {
      const ms = Date.parse(typeof value === "string" ? value : "");
      if (Number.isFinite(ms) && (earliestRequestAtMs === null || ms < earliestRequestAtMs)) {
        earliestRequestAtMs = ms;
      }
    };
    for (const event of ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`)) {
      const record = asRecord(event);
      if (record.event !== "labeled") continue;
      const labelName = asRecord(record.label).name;
      if (typeof labelName !== "string") continue;
      if (!STALLED_PROOF_REQUEST_LABELS.has(normalizeLabelName(labelName))) continue;
      observe(record.created_at);
    }
    for (const comment of ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`)) {
      const record = asRecord(comment);
      const body = typeof record.body === "string" ? record.body : "";
      if (!body.includes(PROOF_NUDGE_MARKER_PREFIX)) continue;
      observe(record.created_at);
    }
    if (earliestRequestAtMs === null) {
      return "no visible dated proof request (needs-proof label event or proof nudge) on the live PR";
    }
    if (now - earliestRequestAtMs <= STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS * DAY_MS) {
      return `stalled_unproven_pr requires the proof request to be visible for ${STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS} days`;
    }
    return null;
  }
  function abandonedPrAgeSkipReason(
    item: Pick<Item, "createdAt">,
    now = Date.now(),
  ): string | null {
    if (!isOlderThanDays(item.createdAt, ABANDONED_PR_MIN_AGE_DAYS, now)) {
      return `abandoned_pr requires PR older than ${ABANDONED_PR_MIN_AGE_DAYS} days`;
    }
    return null;
  }
  function stalledUnprovenPrApplyBlockReason(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ): string | null {
    const ageBlock = stalledUnprovenPrAgeSkipReason(item);
    if (ageBlock) return ageBlock;
    const exemptLabel = prAutoCloseExemptLabel(item.labels);
    if (exemptLabel) return `${exemptLabel} exempts this PR from stalled-unproven auto-close`;
    const proofLabel = item.labels
      .map(normalizeLabelName)
      .find(
        (label) =>
          label === normalizeLabelName(PROOF_SUFFICIENT_LABEL) ||
          label === normalizeLabelName(PROOF_OVERRIDE_LABEL),
      );
    if (proofLabel) return `${proofLabel} marks the requested proof as resolved`;
    const proofRequestBlock = stalledUnprovenProofRequestBlockReason(number);
    if (proofRequestBlock) return proofRequestBlock;
    const activity = pullRequestLiveActivity(number);
    if (activity.draft)
      return "draft PR is handled by the abandoned-PR policy, not stalled-unproven";
    if (
      activity.headActivityAtMs === null ||
      Date.now() - activity.headActivityAtMs <= STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS * DAY_MS
    ) {
      return `stalled_unproven_pr requires ${STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS} days without source activity on the current head`;
    }
    return pullRequestHumanEngagementBlockReason(number);
  }
  function stalledUnprovenPrApplyBlockReasonSafe(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ): string | null {
    try {
      return stalledUnprovenPrApplyBlockReason(number, item);
    } catch (error) {
      return `stalled-unproven liveness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  function abandonedPrApplyBlockReason(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ): string | null {
    const ageBlock = abandonedPrAgeSkipReason(item);
    if (ageBlock) return ageBlock;
    const exemptLabel = prAutoCloseExemptLabel(item.labels);
    if (exemptLabel) return `${exemptLabel} exempts this PR from abandoned-PR auto-close`;
    const activity = pullRequestLiveActivity(number);
    if (
      activity.headActivityAtMs === null ||
      Date.now() - activity.headActivityAtMs <= ABANDONED_PR_MIN_INACTIVE_DAYS * DAY_MS
    ) {
      return `abandoned_pr requires ${ABANDONED_PR_MIN_INACTIVE_DAYS} days without source activity on the current head`;
    }
    const waitingOnAuthor = item.labels
      .map(normalizeLabelName)
      .includes(normalizeLabelName(WAITING_ON_AUTHOR_LABEL));
    const stalledState =
      activity.draft || waitingOnAuthor || activity.headChecksFailing || activity.headConflicted;
    if (!stalledState) {
      return "live PR is not draft, waiting-on-author, failing checks, or merge-conflicted; abandonment is not confirmed";
    }
    return pullRequestHumanEngagementBlockReason(number);
  }
  function abandonedPrApplyBlockReasonSafe(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
  ): string | null {
    try {
      return abandonedPrApplyBlockReason(number, item);
    } catch (error) {
      return `abandoned-PR liveness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  return {
    stalledUnprovenPrAgeSkipReason,
    STALLED_PROOF_REQUEST_LABELS,
    stalledUnprovenProofRequestBlockReason,
    abandonedPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReason,
    stalledUnprovenPrApplyBlockReasonSafe,
    abandonedPrApplyBlockReason,
    abandonedPrApplyBlockReasonSafe,
  };
}
