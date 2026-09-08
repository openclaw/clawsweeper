import { maintainerDecisionFromReport } from "./decision-packets.js";
import { reportAllowsAutomation } from "./manual-publication-policy.js";
import { validReviewLeaseIdentity } from "./review-comment-markers.js";
import { AUTOFIX_LABEL, AUTOMERGE_LABEL } from "./repair/exact-review-guard-labels.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import type { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";
import type { PullRequestReviewReadiness } from "./clawsweeper-types.js";

export function createReviewCommentAutomation(
  dependencies: ReviewCommentWorkflowDependencies & ReturnType<typeof createReviewCommentIdentity>,
) {
  const {
    reportSecurityReview,
    reportReviewFindings,
    frontMatterValue,
    frontMatterStringArray,
    configSurfaceReviewRequired,
    dataModelSurfaceReviewRequired,
    realBehaviorProofBlocksMerge,
    reportAttachedLiveVerification,
    pullHeadShaFromReport,
    pullRequestReviewReadinessFromReport,
    securitySensitiveRepairAllowed,
    markerAttributeValue,
    timestampMs,
  } = dependencies;

  function canonicalReviewTimestamp(value: string | undefined): string | null {
    const parsed = timestampMs(value);
    return parsed === null ? null : new Date(parsed).toISOString();
  }

  function reviewVersionMarkerFromReport(markdown: string): string {
    const itemKind = frontMatterValue(markdown, "type");
    if (itemKind !== "issue" && itemKind !== "pull_request") return "";
    const number = frontMatterValue(markdown, "number") ?? "";
    const itemNumber = Number(number);
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(itemNumber) || itemNumber <= 0) {
      return "";
    }
    const reviewedAt = canonicalReviewTimestamp(frontMatterValue(markdown, "reviewed_at"));
    if (!reviewedAt) return "";
    const reportHeadSha = pullHeadShaFromReport(markdown);
    if (itemKind === "pull_request" && !/^[0-9a-f]{40}$/i.test(reportHeadSha ?? "")) return "";
    const headSha = reportHeadSha ?? "na";
    const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
    const leaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
    const leaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
    const attrs = [
      `item=${markerAttributeValue(number)}`,
      `reviewed_at=${markerAttributeValue(reviewedAt)}`,
      `sha=${markerAttributeValue(headSha)}`,
      `source_revision=${markerAttributeValue(sourceRevision)}`,
      `lease_owner=${markerAttributeValue(leaseOwner)}`,
      `lease_comment_id=${markerAttributeValue(leaseCommentId)}`,
      "v=1",
    ].join(" ");
    return `<!-- clawsweeper-review-version ${attrs} -->`;
  }

  function reviewAutomationMarkersFromReport(
    markdown: string,
    precomputedReadiness?: PullRequestReviewReadiness,
  ): string {
    if (!reportAllowsAutomation(markdown)) return "";
    const itemKind = frontMatterValue(markdown, "type");
    if (itemKind === "issue") {
      const decision = frontMatterValue(markdown, "decision");
      const closeReason = frontMatterValue(markdown, "close_reason");
      if (decision !== "close" || closeReason !== "unsponsored_feature_request") return "";
      const reportReviewedAt = frontMatterValue(markdown, "reviewed_at");
      const reviewedAt =
        canonicalReviewTimestamp(reportReviewedAt) ?? reportReviewedAt ?? "unknown";
      const attrs = [
        `item=${markerAttributeValue(frontMatterValue(markdown, "number") ?? "unknown")}`,
        `confidence=${markerAttributeValue(frontMatterValue(markdown, "confidence") ?? "unknown")}`,
        `updated_at=${markerAttributeValue(frontMatterValue(markdown, "item_updated_at") ?? "unknown")}`,
        `reviewed_at=${markerAttributeValue(reviewedAt)}`,
        `source_revision=${markerAttributeValue(frontMatterValue(markdown, "item_source_revision") ?? "unknown")}`,
        `action_taken=${markerAttributeValue(frontMatterValue(markdown, "action_taken") ?? "unknown")}`,
        `reason=${markerAttributeValue(closeReason)}`,
      ].join(" ");
      return [
        `<!-- clawsweeper-verdict:close ${attrs} -->`,
        `<!-- clawsweeper-action:close-required ${attrs} -->`,
      ].join("\n");
    }
    if (itemKind !== "pull_request") return "";
    const number = frontMatterValue(markdown, "number") ?? "unknown";
    const itemNumber = Number(number);
    const hasExactItemNumber =
      /^[1-9]\d*$/.test(number) && Number.isSafeInteger(itemNumber) && itemNumber > 0;
    const decision = frontMatterValue(markdown, "decision");
    const confidence = frontMatterValue(markdown, "confidence") ?? "unknown";
    const headSha = pullHeadShaFromReport(markdown) ?? "unknown";
    const itemUpdatedAt = frontMatterValue(markdown, "item_updated_at") ?? "unknown";
    const reportReviewedAt = frontMatterValue(markdown, "reviewed_at");
    const reviewedAt = canonicalReviewTimestamp(reportReviewedAt) ?? reportReviewedAt ?? "unknown";
    const reviewLeaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
    const reviewLeaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
    const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
    const liveVerification = reportAttachedLiveVerification(markdown).status;
    const baseAttrs = [
      `item=${markerAttributeValue(number)}`,
      `sha=${markerAttributeValue(headSha)}`,
      `confidence=${markerAttributeValue(confidence)}`,
      `updated_at=${markerAttributeValue(itemUpdatedAt)}`,
      `reviewed_at=${markerAttributeValue(reviewedAt)}`,
      `lease_owner=${markerAttributeValue(reviewLeaseOwner)}`,
      `lease_comment_id=${markerAttributeValue(reviewLeaseCommentId)}`,
      `source_revision=${markerAttributeValue(sourceRevision)}`,
      `live_verification=${liveVerification}`,
    ].join(" ");
    const reviewReadiness =
      precomputedReadiness?.headSha === headSha.toLowerCase()
        ? precomputedReadiness
        : pullRequestReviewReadinessFromReport(markdown);
    const hasDurableReviewIdentity =
      Boolean(reviewVersionMarkerFromReport(markdown)) &&
      validReviewLeaseIdentity(reviewLeaseOwner, reviewLeaseCommentId);
    const reviewStateMarker =
      hasDurableReviewIdentity && hasExactItemNumber && /^[0-9a-f]{40}$/i.test(headSha)
        ? `<!-- clawsweeper-review-state:${reviewReadiness.state} ` +
          `item=${markerAttributeValue(number)} sha=${markerAttributeValue(headSha)} v=1 -->`
        : "";
    const withReviewState = (...markers: string[]): string =>
      [...markers.filter(Boolean), reviewStateMarker].join("\n");
    if (reviewReadiness.normalizationFailed) {
      return withReviewState(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
    }
    const securityNeedsAttention = reportSecurityReview(markdown).status === "needs_attention";
    const humanReviewMarkers = (): string => {
      const markers = [];
      if (securityNeedsAttention) {
        markers.push(`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`);
      }
      markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
      return withReviewState(...markers);
    };

    if (!hasDurableReviewIdentity) return humanReviewMarkers();
    try {
      if (maintainerDecisionFromReport(markdown)?.required) return humanReviewMarkers();
    } catch {
      return humanReviewMarkers();
    }
    if (frontMatterValue(markdown, "review_status") === "failed") {
      return humanReviewMarkers();
    }
    if (configSurfaceReviewRequired(markdown)) {
      return humanReviewMarkers();
    }
    if (dataModelSurfaceReviewRequired(markdown)) {
      return humanReviewMarkers();
    }
    if (frontMatterValue(markdown, "action_taken") === "skipped_pr_close_coverage_proof") {
      return humanReviewMarkers();
    }
    const hasRealBehaviorProofBlocker = realBehaviorProofBlocksMerge(markdown);
    if (securityNeedsAttention) {
      const markers = [`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`];
      if (
        reviewReadiness.state === "needs-changes" &&
        !hasRealBehaviorProofBlocker &&
        securitySensitiveRepairAllowed(markdown)
      ) {
        return withReviewState(
          ...markers,
          `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
          `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=security-review -->`,
        );
      }
      return withReviewState(...markers, `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
    }
    if (hasRealBehaviorProofBlocker) {
      return withReviewState(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
    }
    if (decision === "keep_open") {
      if (reviewReadiness.state === "ready" && repairLoopPassModeFromReport(markdown)) {
        return withReviewState(`<!-- clawsweeper-verdict:pass ${baseAttrs} -->`);
      }
      if (reviewReadiness.state === "needs-changes" && repairLoopFindingRepairAllowed(markdown)) {
        return withReviewState(
          `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
          `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
        );
      }
      if (
        reviewReadiness.state !== "needs-changes" ||
        frontMatterValue(markdown, "work_candidate") !== "queue_fix_pr"
      ) {
        return withReviewState(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
      }
      return withReviewState(
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
      );
    }
    if (decision === "close") {
      const closeReason = frontMatterValue(markdown, "close_reason") ?? "unknown";
      const actionTaken = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const closeAttrs = `${baseAttrs} action_taken=${markerAttributeValue(actionTaken)} reason=${markerAttributeValue(closeReason)}`;
      return withReviewState(
        `<!-- clawsweeper-verdict:close ${closeAttrs} -->`,
        `<!-- clawsweeper-action:close-required ${closeAttrs} -->`,
      );
    }
    return withReviewState(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
  }

  function repairLoopPassModeFromReport(markdown: string): "" | "autofix" | "automerge" {
    if (!isRepairLoopPassReport(markdown)) return "";
    return frontMatterStringArray(markdown, "labels").includes(AUTOFIX_LABEL)
      ? "autofix"
      : "automerge";
  }

  function repairLoopFindingRepairAllowed(markdown: string): boolean {
    const labels = frontMatterStringArray(markdown, "labels");
    return (
      (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
      !realBehaviorProofBlocksMerge(markdown) &&
      reportReviewFindings(markdown).length > 0
    );
  }

  function isRepairLoopPassReport(markdown: string): boolean {
    const labels = frontMatterStringArray(markdown, "labels");
    return (
      (labels.includes(AUTOMERGE_LABEL) || labels.includes(AUTOFIX_LABEL)) &&
      pullRequestReviewReadinessFromReport(markdown).state === "ready"
    );
  }

  return {
    reviewVersionMarkerFromReport,
    reviewAutomationMarkersFromReport,
    repairLoopPassModeFromReport,
    repairLoopFindingRepairAllowed,
    isRepairLoopPassReport,
  };
}
