import {
  IMPACT_LABEL_NAMES,
  MATURITY_LABEL_NAMES,
  PRIORITY_LABEL_NAMES,
  REVIEW_COMMENT_MARKER_PREFIX,
} from "./clawsweeper-policy.js";
import type { ItemContext, StalePullRequestReviewHead } from "./clawsweeper-types.js";
import { renderReviewHistorySection } from "./review-history.js";
import type { ReviewStructuralPullState } from "./review-structural-cache.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";

export function createReviewCommentIdentity(dependencies: ReviewCommentWorkflowDependencies) {
  const {
    githubCount,
    asRecord,
    frontMatterValue,
    stringOrUndefined,
    isIssueAdvisoryLabel,
    removeIssueLabel,
    isClawSweeperOwnedLabel,
    reviewHistoryForStaleComment,
  } = dependencies;

  function reviewCommentMarker(number: number): string {
    return `${REVIEW_COMMENT_MARKER_PREFIX} item=${number} -->`;
  }

  function closeAppliedCommentMarker(number: number): string {
    return `<!-- clawsweeper-close-applied item=${number} -->`;
  }

  function pullHeadShaFromContext(context: ItemContext): string | null {
    const pull = asRecord(context.pullRequest);
    const head = asRecord(pull.head);
    const sha = head.sha;
    return typeof sha === "string" && sha.trim() ? sha.trim() : null;
  }

  function reviewStructuralPullStateFromContext(
    context: ItemContext,
  ): ReviewStructuralPullState | null {
    const pull = asRecord(context.pullRequest);
    const head = asRecord(pull.head);
    const base = asRecord(pull.base);
    const headSha = stringOrUndefined(head.sha);
    const baseSha = stringOrUndefined(base.sha);
    const mergeStateStatus = stringOrUndefined(pull.mergeableState);
    const additions = githubCount(pull.additions);
    const deletions = githubCount(pull.deletions);
    const changedFiles = githubCount(pull.changedFiles);
    const commitCount = context.counts?.pullCommits;
    if (
      !headSha ||
      !baseSha ||
      typeof pull.draft !== "boolean" ||
      (pull.mergeable !== null &&
        typeof pull.mergeable !== "boolean" &&
        typeof pull.mergeable !== "string") ||
      !mergeStateStatus ||
      additions === null ||
      deletions === null ||
      changedFiles === null ||
      typeof commitCount !== "number" ||
      !Number.isSafeInteger(commitCount) ||
      commitCount < 0
    ) {
      return null;
    }
    return {
      headSha,
      baseSha,
      draft: pull.draft,
      mergeable: pull.mergeable,
      mergeStateStatus,
      additions,
      deletions,
      changedFiles,
      commitCount,
    };
  }

  function pullHeadShaFromReport(markdown: string): string | null {
    const value = frontMatterValue(markdown, "pull_head_sha");
    return value && value !== "unknown" ? value : null;
  }

  function reviewLeaseRevisionFromReport(markdown: string): string | null {
    if (frontMatterValue(markdown, "type") === "pull_request") {
      return pullHeadShaFromReport(markdown);
    }
    const value = frontMatterValue(markdown, "item_source_revision");
    return value && value !== "unknown" ? value : null;
  }

  function stalePullRequestReviewHead(
    markdown: string,
    context: ItemContext,
  ): StalePullRequestReviewHead | null {
    if (frontMatterValue(markdown, "type") !== "pull_request") return null;
    const reportHeadSha = pullHeadShaFromReport(markdown);
    const liveHeadSha = pullHeadShaFromContext(context);
    if (!reportHeadSha || !liveHeadSha || reportHeadSha === liveHeadSha) return null;
    return {
      reportHeadSha,
      liveHeadSha,
      reason: `live PR head ${liveHeadSha} differs from reviewed head ${reportHeadSha}`,
    };
  }

  function freshPullRequestReviewHead(markdown: string, context: ItemContext): boolean {
    if (frontMatterValue(markdown, "type") !== "pull_request") return false;
    const reportHeadSha = pullHeadShaFromReport(markdown);
    const liveHeadSha = pullHeadShaFromContext(context);
    return Boolean(reportHeadSha && liveHeadSha && reportHeadSha === liveHeadSha);
  }

  function isStalePullRequestReviewLabel(label: string): boolean {
    return (
      isClawSweeperOwnedLabel(label) &&
      !PRIORITY_LABEL_NAMES.has(label) &&
      !IMPACT_LABEL_NAMES.has(label) &&
      !MATURITY_LABEL_NAMES.has(label) &&
      !isIssueAdvisoryLabel(label)
    );
  }

  function syncStalePullRequestReviewLabels(options: {
    number: number;
    labels: readonly string[];
    dryRun: boolean;
    onMutation?: () => void;
  }): { labels: string[]; changed: boolean } {
    const labelsToRemove = options.labels.filter(isStalePullRequestReviewLabel);
    if (labelsToRemove.length === 0) return { labels: [...options.labels], changed: false };
    const nextLabels = options.labels.filter((label) => !labelsToRemove.includes(label));
    if (!options.dryRun) {
      for (const label of labelsToRemove) {
        removeIssueLabel(options.number, label, options.onMutation);
      }
    }
    return { labels: nextLabels, changed: true };
  }

  function stalePullRequestReviewComment(options: {
    number: number;
    stale: StalePullRequestReviewHead;
    previousReviewCommentBody?: string;
  }): string {
    const attrs = [
      `item=${markerAttributeValue(String(options.number))}`,
      `reviewed_sha=${markerAttributeValue(options.stale.reportHeadSha)}`,
      `current_sha=${markerAttributeValue(options.stale.liveHeadSha)}`,
      "reason=stale_head",
    ].join(" ");
    const history = renderReviewHistorySection(
      reviewHistoryForStaleComment(options.previousReviewCommentBody),
    );
    return [
      "Codex review: stale review; fresh review needed.",
      "",
      "**Summary**",
      `The latest durable ClawSweeper review was for head \`${options.stale.reportHeadSha}\`, but the PR head is now \`${options.stale.liveHeadSha}\`. Its old verdict and PR readiness labels are no longer current.`,
      "",
      "**Next step**",
      "Run or wait for a fresh ClawSweeper review on the current PR head.",
      ...(history ? ["", history] : []),
      "",
      `<!-- clawsweeper-review-status:stale ${attrs} -->`,
    ].join("\n");
  }

  function markerAttributeValue(value: string): string {
    return value.trim().replace(/[^\w./:@-]/g, "_") || "unknown";
  }

  return {
    reviewCommentMarker,
    closeAppliedCommentMarker,
    pullHeadShaFromContext,
    reviewStructuralPullStateFromContext,
    pullHeadShaFromReport,
    reviewLeaseRevisionFromReport,
    stalePullRequestReviewHead,
    freshPullRequestReviewHead,
    isStalePullRequestReviewLabel,
    syncStalePullRequestReviewLabels,
    stalePullRequestReviewComment,
    markerAttributeValue,
  };
}
