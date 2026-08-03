import type {
  DashboardActivityBucket,
  DashboardActivityStats,
  DashboardCadenceBucket,
  DashboardKindStats,
  FailedReviewRetryState,
} from "./clawsweeper-types.js";
import type { ReviewPlanningDependencies } from "./clawsweeper-review-planning-dependencies.js";
import type { createReviewPlanningInventory } from "./clawsweeper-review-planning-inventory.js";
import type { createReviewPlanningHotIntake } from "./clawsweeper-review-planning-hot-intake.js";

export function createReviewPlanningDashboard(
  dependencies: ReviewPlanningDependencies &
    ReturnType<typeof createReviewPlanningInventory> &
    ReturnType<typeof createReviewPlanningHotIntake>,
) {
  const {
    frontMatterValue,
    effectiveReviewStatus,
    failedReviewRetryStatePath,
    readFailedReviewRetryState,
    failedReviewRetryMarkdownWithState,
    repoRelativePath,
    dashboardClosedAt,
  } = dependencies;

  function emptyDashboardKindStats(): DashboardKindStats {
    return {
      total: 0,
      fresh: 0,
      proposedClose: 0,
    };
  }
  function emptyDashboardCadenceBucket(): DashboardCadenceBucket {
    return {
      total: 0,
      current: 0,
      proposedClose: 0,
    };
  }
  function emptyDashboardActivityBucket(): DashboardActivityBucket {
    return {
      reviews: 0,
      closeDecisions: 0,
      keepOpenDecisions: 0,
      failedOrStaleReviews: 0,
      closes: 0,
      commentSyncs: 0,
      applySkips: 0,
      inheritedLabelCleanups: 0,
      selfHealConflictRepairs: 0,
      failedReviewRetries: 0,
      failedReviewRetryExhaustions: 0,
      botOwnedProofDecisionsRequested: 0,
      botOwnedProofDispatches: 0,
    };
  }
  function emptyDashboardActivityStats(): DashboardActivityStats {
    return {
      last15Minutes: emptyDashboardActivityBucket(),
      lastHour: emptyDashboardActivityBucket(),
      last24Hours: emptyDashboardActivityBucket(),
      latestReviewAt: undefined,
      latestCloseAt: undefined,
      latestCommentSyncAt: undefined,
    };
  }
  function addDashboardCadenceBucket(
    target: DashboardCadenceBucket,
    source: DashboardCadenceBucket,
  ): void {
    target.total += source.total;
    target.current += source.current;
    target.proposedClose += source.proposedClose;
  }
  function capDashboardCadenceBucket(
    bucket: DashboardCadenceBucket,
    totalLimit: number,
  ): DashboardCadenceBucket {
    const total = Math.min(bucket.total, totalLimit);
    return {
      total,
      current: Math.min(bucket.current, total),
      proposedClose: Math.min(bucket.proposedClose, total),
    };
  }
  function formatPercent(numerator: number, denominator: number): string {
    if (denominator <= 0) return "-";
    return `${((numerator / denominator) * 100).toFixed(1).replace(/\.0$/, "")}%`;
  }
  function formatCadenceBucket(bucket: DashboardCadenceBucket): string {
    const due = bucket.total - bucket.current;
    return `${bucket.current}/${bucket.total} current (${due} due, ${formatPercent(bucket.current, bucket.total)})`;
  }
  function timestampMs(iso: string | undefined): number | null {
    if (!iso) return null;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function isWithinWindow(timestamp: number | null, now: number, windowMs: number): boolean {
    return timestamp !== null && timestamp <= now && now - timestamp <= windowMs;
  }
  function latestTimestamp(
    current: string | undefined,
    candidate: string | undefined,
  ): string | undefined {
    const candidateMs = timestampMs(candidate);
    if (candidateMs === null) return current;
    const currentMs = timestampMs(current);
    return currentMs === null || candidateMs > currentMs ? candidate : current;
  }
  function recordDashboardActivity(
    markdown: string,
    activity: DashboardActivityStats,
    now: number,
  ): void {
    const reviewedAt = frontMatterValue(markdown, "reviewed_at");
    const reviewedAtMs = timestampMs(reviewedAt);
    const closedAt = dashboardClosedAt(markdown);
    const closedAtMs = timestampMs(closedAt);
    const commentSyncedAt = frontMatterValue(markdown, "review_comment_synced_at");
    const commentSyncedAtMs = timestampMs(commentSyncedAt);
    const applyCheckedAt = frontMatterValue(markdown, "apply_checked_at");
    const applyCheckedAtMs = timestampMs(applyCheckedAt);
    const decision = frontMatterValue(markdown, "decision") ?? "unknown";
    const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
    const failedReviewRetryStatus = frontMatterValue(markdown, "failed_review_retry_status");
    const failedReviewRetryLastAt = frontMatterValue(markdown, "failed_review_retry_last_at");
    const failedReviewRetryLastAtMs = timestampMs(failedReviewRetryLastAt);
    const reviewStatus = effectiveReviewStatus(markdown);

    activity.latestReviewAt = latestTimestamp(activity.latestReviewAt, reviewedAt);
    activity.latestCloseAt = latestTimestamp(activity.latestCloseAt, closedAt);
    activity.latestCommentSyncAt = latestTimestamp(activity.latestCommentSyncAt, commentSyncedAt);

    const buckets: Array<[DashboardActivityBucket, number]> = [
      [activity.last15Minutes, 15 * 60 * 1000],
      [activity.lastHour, 60 * 60 * 1000],
      [activity.last24Hours, 24 * 60 * 60 * 1000],
    ];
    for (const [bucket, windowMs] of buckets) {
      if (isWithinWindow(reviewedAtMs, now, windowMs)) {
        bucket.reviews += 1;
        if (decision === "close") bucket.closeDecisions += 1;
        if (decision === "keep_open") bucket.keepOpenDecisions += 1;
        if (reviewStatus === "failed" || reviewStatus.startsWith("stale_")) {
          bucket.failedOrStaleReviews += 1;
        }
      }
      if (isWithinWindow(closedAtMs, now, windowMs)) bucket.closes += 1;
      if (isWithinWindow(commentSyncedAtMs, now, windowMs)) bucket.commentSyncs += 1;
      if (isWithinWindow(applyCheckedAtMs, now, windowMs) && action.startsWith("skipped_")) {
        bucket.applySkips += 1;
      }
      if (isWithinWindow(applyCheckedAtMs ?? reviewedAtMs, now, windowMs)) {
        recordOperationActivity(action, bucket);
      }
      if (
        failedReviewRetryStatus &&
        !normalizedOperationText(action).includes("failed_review_retry") &&
        isWithinWindow(failedReviewRetryLastAtMs, now, windowMs)
      ) {
        recordFailedReviewRetryStatus(failedReviewRetryStatus, bucket);
      }
    }
  }
  function dashboardMarkdownWithFailedReviewRetryState(
    markdown: string,
    number: number,
    stateDir: string,
  ): string {
    const statePath = failedReviewRetryStatePath(stateDir, number);
    let state: FailedReviewRetryState | null;
    try {
      state = readFailedReviewRetryState(statePath);
    } catch (error) {
      console.error(
        `[dashboard] ignoring invalid failed-review retry state ${repoRelativePath(statePath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      state = null;
    }
    return failedReviewRetryMarkdownWithState(markdown, state);
  }
  function dashboardFailedReviewRetryActivityForTest(options: {
    markdown: string;
    number: number;
    stateDir: string;
    now: number;
  }): DashboardActivityStats {
    const activity = emptyDashboardActivityStats();
    recordDashboardActivity(
      dashboardMarkdownWithFailedReviewRetryState(
        options.markdown,
        options.number,
        options.stateDir,
      ),
      activity,
      options.now,
    );
    return activity;
  }
  function formatActivityRow(label: string, bucket: DashboardActivityBucket): string {
    return `| ${label} | ${bucket.reviews} | ${bucket.closeDecisions} | ${bucket.keepOpenDecisions} | ${bucket.failedOrStaleReviews} | ${bucket.closes} | ${bucket.commentSyncs} | ${bucket.applySkips} |`;
  }
  function recordOperationActivity(action: string, bucket: DashboardActivityBucket): void {
    const normalized = normalizedOperationText(action);
    if (
      normalized.includes("inherited_label_cleanup") ||
      normalized.includes("replacement_label_cleanup") ||
      normalized.includes("removed_inherited_labels")
    ) {
      bucket.inheritedLabelCleanups += 1;
    }
    if (
      normalized.includes("self_heal_conflict") ||
      normalized.includes("conflict_self_heal") ||
      normalized.includes("clawsweeper_self_rebase")
    ) {
      bucket.selfHealConflictRepairs += 1;
    }
    if (
      normalized.includes("failed_review_retry_exhausted") ||
      normalized.includes("failed_review_retries_exhausted")
    ) {
      bucket.failedReviewRetryExhaustions += 1;
    } else if (normalized.includes("failed_review_retry")) {
      bucket.failedReviewRetries += 1;
    }
    if (
      normalized.includes("bot_owned_proof_decision_requested") ||
      normalized.includes("maintainer_proof_decision_requested") ||
      normalized.includes("needs_maintainer_proof_decision") ||
      normalized.includes("bot_proof_decision_planned") ||
      normalized.includes("bot_proof_decision_posted")
    ) {
      bucket.botOwnedProofDecisionsRequested += 1;
    }
    if (
      normalized.includes("bot_owned_proof_dispatched") ||
      normalized.includes("bot_owned_proof_capture_dispatched") ||
      normalized.includes("bot_proof_mantis_request_planned") ||
      normalized.includes("bot_proof_mantis_request_posted")
    ) {
      bucket.botOwnedProofDispatches += 1;
    }
  }
  function normalizedOperationText(value: string): string {
    return value.toLowerCase().replaceAll("-", "_");
  }
  function recordFailedReviewRetryStatus(status: string, bucket: DashboardActivityBucket): void {
    const normalized = normalizedOperationText(status);
    if (normalized === "exhausted") {
      bucket.failedReviewRetryExhaustions += 1;
    } else if (normalized === "dispatched") {
      bucket.failedReviewRetries += 1;
    }
  }
  function formatOperationActivityRow(label: string, bucket: DashboardActivityBucket): string {
    return `| ${label} | ${bucket.inheritedLabelCleanups} | ${bucket.selfHealConflictRepairs} | ${bucket.failedReviewRetries} | ${bucket.failedReviewRetryExhaustions} | ${bucket.botOwnedProofDecisionsRequested} | ${bucket.botOwnedProofDispatches} |`;
  }

  return {
    emptyDashboardKindStats,
    emptyDashboardCadenceBucket,
    emptyDashboardActivityBucket,
    emptyDashboardActivityStats,
    addDashboardCadenceBucket,
    capDashboardCadenceBucket,
    formatPercent,
    formatCadenceBucket,
    timestampMs,
    isWithinWindow,
    latestTimestamp,
    recordDashboardActivity,
    dashboardMarkdownWithFailedReviewRetryState,
    dashboardFailedReviewRetryActivityForTest,
    formatActivityRow,
    recordOperationActivity,
    normalizedOperationText,
    recordFailedReviewRetryStatus,
    formatOperationActivityRow,
  };
}
