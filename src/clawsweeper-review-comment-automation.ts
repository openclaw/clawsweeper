import { maintainerDecisionFromReport } from "./decision-packets.js";
import { AUTOFIX_LABEL, AUTOMERGE_LABEL } from "./repair/exact-review-guard-labels.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import type { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";

export function createReviewCommentAutomation(
  dependencies: ReviewCommentWorkflowDependencies & ReturnType<typeof createReviewCommentIdentity>,
) {
  const {
    reportSecurityReview,
    reportReviewFindings,
    reportOverallCorrectness,
    frontMatterValue,
    frontMatterStringArray,
    configSurfaceReviewRequired,
    dataModelSurfaceReviewRequired,
    realBehaviorProofBlocksMerge,
    pullHeadShaFromReport,
    markerAttributeValue,
  } = dependencies;

  function reviewVersionMarkerFromReport(markdown: string): string {
    const number = frontMatterValue(markdown, "number") ?? "unknown";
    const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
    const headSha = pullHeadShaFromReport(markdown) ?? "na";
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

  function reviewAutomationMarkersFromReport(markdown: string): string {
    const itemKind = frontMatterValue(markdown, "type");
    if (itemKind === "issue") {
      const decision = frontMatterValue(markdown, "decision");
      const closeReason = frontMatterValue(markdown, "close_reason");
      if (decision !== "close" || closeReason !== "unsponsored_feature_request") return "";
      const attrs = [
        `item=${markerAttributeValue(frontMatterValue(markdown, "number") ?? "unknown")}`,
        `confidence=${markerAttributeValue(frontMatterValue(markdown, "confidence") ?? "unknown")}`,
        `updated_at=${markerAttributeValue(frontMatterValue(markdown, "item_updated_at") ?? "unknown")}`,
        `reviewed_at=${markerAttributeValue(frontMatterValue(markdown, "reviewed_at") ?? "unknown")}`,
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
    const decision = frontMatterValue(markdown, "decision");
    const confidence = frontMatterValue(markdown, "confidence") ?? "unknown";
    const headSha = pullHeadShaFromReport(markdown) ?? "unknown";
    const itemUpdatedAt = frontMatterValue(markdown, "item_updated_at") ?? "unknown";
    const reviewedAt = frontMatterValue(markdown, "reviewed_at") ?? "unknown";
    const reviewLeaseOwner = frontMatterValue(markdown, "review_lease_owner") ?? "unknown";
    const reviewLeaseCommentId = frontMatterValue(markdown, "review_lease_comment_id") ?? "unknown";
    const sourceRevision = frontMatterValue(markdown, "item_source_revision") ?? "unknown";
    const baseAttrs = [
      `item=${markerAttributeValue(number)}`,
      `sha=${markerAttributeValue(headSha)}`,
      `confidence=${markerAttributeValue(confidence)}`,
      `updated_at=${markerAttributeValue(itemUpdatedAt)}`,
      `reviewed_at=${markerAttributeValue(reviewedAt)}`,
      `lease_owner=${markerAttributeValue(reviewLeaseOwner)}`,
      `lease_comment_id=${markerAttributeValue(reviewLeaseCommentId)}`,
      `source_revision=${markerAttributeValue(sourceRevision)}`,
    ].join(" ");
    const securityNeedsAttention = reportSecurityReview(markdown).status === "needs_attention";
    const humanReviewMarkers = (): string => {
      const markers = [];
      if (securityNeedsAttention) {
        markers.push(`<!-- clawsweeper-security:security-sensitive ${baseAttrs} -->`);
      }
      markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
      return markers.join("\n");
    };

    if (maintainerDecisionFromReport(markdown)?.required) {
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
      if (!hasRealBehaviorProofBlocker && securitySensitiveRepairAllowed(markdown)) {
        markers.push(
          `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
          `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=security-review -->`,
        );
      } else {
        markers.push(`<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`);
      }
      return markers.join("\n");
    }
    if (hasRealBehaviorProofBlocker) {
      return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
    }
    if (decision === "keep_open") {
      if (repairLoopPassModeFromReport(markdown)) {
        return `<!-- clawsweeper-verdict:pass ${baseAttrs} -->`;
      }
      if (repairLoopFindingRepairAllowed(markdown)) {
        return [
          `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
          `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
        ].join("\n");
      }
      if (frontMatterValue(markdown, "work_candidate") !== "queue_fix_pr") {
        return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
      }
      return [
        `<!-- clawsweeper-verdict:needs-changes ${baseAttrs} -->`,
        `<!-- clawsweeper-action:fix-required ${baseAttrs} finding=review-feedback -->`,
      ].join("\n");
    }
    if (decision === "close") {
      const closeReason = frontMatterValue(markdown, "close_reason") ?? "unknown";
      const actionTaken = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const closeAttrs = `${baseAttrs} action_taken=${markerAttributeValue(actionTaken)} reason=${markerAttributeValue(closeReason)}`;
      return [
        `<!-- clawsweeper-verdict:close ${closeAttrs} -->`,
        `<!-- clawsweeper-action:close-required ${closeAttrs} -->`,
      ].join("\n");
    }
    return `<!-- clawsweeper-verdict:needs-human ${baseAttrs} -->`;
  }

  function repairLoopPassModeFromReport(markdown: string): "" | "autofix" | "automerge" {
    if (!isRepairLoopPassReport(markdown)) return "";
    return frontMatterStringArray(markdown, "labels").includes(AUTOFIX_LABEL)
      ? "autofix"
      : "automerge";
  }

  function securitySensitiveRepairAllowed(markdown: string): boolean {
    const labels = frontMatterStringArray(markdown, "labels");
    return (
      frontMatterValue(markdown, "decision") === "keep_open" &&
      (labels.includes(AUTOFIX_LABEL) || labels.includes(AUTOMERGE_LABEL))
    );
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
      frontMatterValue(markdown, "review_status") === "complete" &&
      frontMatterValue(markdown, "confidence") === "high" &&
      frontMatterValue(markdown, "decision") === "keep_open" &&
      !configSurfaceReviewRequired(markdown) &&
      !dataModelSurfaceReviewRequired(markdown) &&
      !realBehaviorProofBlocksMerge(markdown) &&
      reportOverallCorrectness(markdown) === "patch is correct" &&
      reportReviewFindings(markdown).length === 0
    );
  }

  return {
    reviewVersionMarkerFromReport,
    reviewAutomationMarkersFromReport,
    repairLoopPassModeFromReport,
    securitySensitiveRepairAllowed,
    repairLoopFindingRepairAllowed,
    isRepairLoopPassReport,
  };
}
