import { ideaRevivalReactionThreshold, positiveReactionCount } from "./idea-archive-revival.js";
import {
  PR_AUTO_CLOSE_EXEMPT_LABELS,
  STALE_VERSION_BUG_MIN_INACTIVE_DAYS,
  UNSPONSORED_FEATURE_MIN_INACTIVE_DAYS,
} from "./clawsweeper-policy.js";
import type { GitHubUser, Item } from "./clawsweeper-types.js";
import type { ApplyGuardDependencies } from "./clawsweeper-apply-guard-dependencies.js";
import type { createApplyGuardActivity } from "./clawsweeper-apply-guard-activity.js";

export function createApplyGuardPolicy(
  dependencies: ApplyGuardDependencies & ReturnType<typeof createApplyGuardActivity>,
) {
  const {
    asRecord,
    ghJson,
    ghPaged,
    labelNames,
    normalizeLabelName,
    protectedLabels,
    staleVersionBugAgeSkipReason,
    staleVersionBugCloseEnabled,
    targetRepo,
    unconfirmedProductDirectionAgeSkipReason,
    unconfirmedProductDirectionCloseEnabled,
    unsponsoredFeatureAgeSkipReason,
    unsponsoredFeatureCloseEnabled,
    maintainerAssociatedEntries,
    lowSignalUnmergeablePrConflictBlockReason,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    pullRequestHeadActivity,
    prAutoCloseExemptLabel,
  } = dependencies;

  function lowSignalUnmergeablePrApplyBlockReason(
    number: number,
    staleMinAgeDays: number,
  ): string | null {
    const issue = ghJson<{ assignees?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
      "--jq",
      "{assignees:[.assignees[]? | {login:.login}]}",
    ]);
    if ((issue.assignees ?? []).length > 0) return "assigned PR has maintainer/human signal";

    const pull = ghJson<{
      created_at?: string;
      mergeable?: boolean | null;
      mergeable_state?: string | null;
      requested_reviewers?: unknown[];
      requested_teams?: unknown[];
      user?: GitHubUser;
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    }>(["api", `repos/${targetRepo()}/pulls/${number}`]);
    if ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0) {
      return "requested reviewers or teams indicate active review signal";
    }

    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
    const maintainerComments = maintainerAssociatedEntries(comments);
    if (maintainerComments.length > 0)
      return "maintainer issue comment blocks low-signal auto-close";

    const reviews = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`);
    const maintainerReviews = maintainerAssociatedEntries(reviews);
    if (maintainerReviews.length > 0) return "maintainer PR review blocks low-signal auto-close";

    const inlineComments = ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`);
    const maintainerInlineComments = maintainerAssociatedEntries(inlineComments);
    if (maintainerInlineComments.length > 0) {
      return "maintainer inline review comment blocks low-signal auto-close";
    }

    const conflictBlock = lowSignalUnmergeablePrConflictBlockReason(pull);
    if (conflictBlock) return conflictBlock;

    const timeline = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`);
    const headActivity = pullRequestHeadActivity(number, pull, timeline);
    return lowSignalUnmergeablePrAuthorActivityBlockReason({
      author: pull.user?.login ?? "",
      createdAt: pull.created_at ?? "",
      comments,
      reviews,
      inlineComments,
      timeline,
      headActivityAtMs: headActivity.headActivityAtMs,
      staleMinAgeDays,
      requireHeadActivityEvidence: true,
    });
  }
  function lowSignalUnmergeablePrApplyBlockReasonSafe(
    number: number,
    staleMinAgeDays: number,
  ): string | null {
    try {
      return lowSignalUnmergeablePrApplyBlockReason(number, staleMinAgeDays);
    } catch (error) {
      return `low-signal conflict/activity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  function unconfirmedProductDirectionApplyBlockReason(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
  ): string | null {
    if (!unconfirmedProductDirectionCloseEnabled()) {
      return "unconfirmed product-direction apply policy is disabled";
    }
    const ageBlock = unconfirmedProductDirectionAgeSkipReason(item, reviewedUpdatedAt, reviewedAt);
    if (ageBlock) return ageBlock;
    const exemptLabel = item.labels
      .map(normalizeLabelName)
      .find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
    if (exemptLabel) return `${exemptLabel} exempts this PR from product-direction auto-close`;

    const issue = ghJson<{ assignees?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
      "--jq",
      "{assignees:[.assignees[]? | {login:.login}]}",
    ]);
    if ((issue.assignees ?? []).length > 0) return "assigned PR has active human signal";

    const pull = ghJson<{ requested_reviewers?: unknown[]; requested_teams?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/pulls/${number}`,
      "--jq",
      "{requested_reviewers:[.requested_reviewers[]? | {login:.login}],requested_teams:[.requested_teams[]? | {slug:.slug}]}",
    ]);
    if ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0) {
      return "requested reviewers or teams indicate active review signal";
    }

    const maintainerComments = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`),
    );
    if (maintainerComments.length > 0)
      return "maintainer issue comment calibrates product direction";

    const maintainerReviews = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`),
    );
    if (maintainerReviews.length > 0) return "maintainer PR review calibrates product direction";

    const maintainerInlineComments = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`),
    );
    if (maintainerInlineComments.length > 0) {
      return "maintainer inline review comment calibrates product direction";
    }
    return null;
  }
  function unconfirmedProductDirectionApplyBlockReasonSafe(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
  ): string | null {
    try {
      return unconfirmedProductDirectionApplyBlockReason(
        number,
        item,
        reviewedUpdatedAt,
        reviewedAt,
      );
    } catch (error) {
      return `product-direction calibration check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  function unsponsoredFeatureApplyBlockReason(
    number: number,
    item: Pick<Item, "createdAt">,
  ): string | null {
    if (!unsponsoredFeatureCloseEnabled()) {
      return "unsponsored feature-request apply policy is disabled";
    }
    const ageBlock = unsponsoredFeatureAgeSkipReason(item);
    if (ageBlock) return ageBlock;

    const issue = ghJson<{
      assignees?: unknown[];
      labels?: unknown[];
      milestone?: unknown;
      reactions?: unknown;
      state?: string;
    }>(["api", `repos/${targetRepo()}/issues/${number}`]);
    if (issue.state !== "open") return "live issue is not open";
    if (
      labelNames(issue.labels)
        .map(normalizeLabelName)
        .some((label) => label.includes("security"))
    ) {
      return "security-labeled issue requires human triage";
    }
    if ((issue.assignees ?? []).length > 0) return "assigned issue has maintainer engagement";
    if (issue.milestone) return "milestoned issue has maintainer engagement";
    if (positiveReactionCount(issue.reactions) >= ideaRevivalReactionThreshold()) {
      return "issue already meets the idea-revival reaction threshold";
    }
    const totalReactions = asRecord(issue.reactions).total_count;
    if (typeof totalReactions === "number" && totalReactions >= 20) {
      return "issue has strong community traction (20 or more reactions)";
    }
    if (labelNames(issue.labels).map(normalizeLabelName).includes("clawsweeper:linked-pr-open")) {
      return "clawsweeper:linked-pr-open blocks unsponsored feature auto-close";
    }

    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
    if (maintainerAssociatedEntries(comments).length > 0) {
      return "maintainer issue comment confirms engagement";
    }
    return issueRecentHumanCommentBlockReasonFromComments(
      comments,
      UNSPONSORED_FEATURE_MIN_INACTIVE_DAYS,
    );
  }
  function unsponsoredFeatureApplyBlockReasonSafe(
    number: number,
    item: Pick<Item, "createdAt">,
  ): string | null {
    try {
      return unsponsoredFeatureApplyBlockReason(number, item);
    } catch (error) {
      return `unsponsored feature-request liveness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  function staleVersionBugApplyBlockReason(
    number: number,
    item: Pick<Item, "createdAt">,
  ): string | null {
    if (!staleVersionBugCloseEnabled()) return "stale-version bug apply policy is disabled";
    const ageBlock = staleVersionBugAgeSkipReason(item);
    if (ageBlock) return ageBlock;

    const issue = ghJson<{
      assignees?: unknown[];
      created_at?: string;
      labels?: unknown[];
      milestone?: unknown;
      reactions?: unknown;
      state?: string;
    }>(["api", `repos/${targetRepo()}/issues/${number}`]);
    if (issue.state !== "open") return "live issue is not open";
    // Stored records can carry stale timestamps; the age floor must hold live.
    if (!Number.isFinite(Date.parse(issue.created_at ?? ""))) {
      return "live issue creation date is unavailable";
    }
    const liveAgeBlock = staleVersionBugAgeSkipReason({ createdAt: issue.created_at ?? "" });
    if (liveAgeBlock) return liveAgeBlock;
    const labels = labelNames(issue.labels).map(normalizeLabelName);
    const protectedLabel =
      protectedLabels(labelNames(issue.labels))[0] ??
      prAutoCloseExemptLabel(labelNames(issue.labels));
    if (protectedLabel) return `protected label: ${protectedLabel}`;
    if (labels.some((label) => label.includes("security"))) {
      return "security-labeled issue requires human triage";
    }
    if ((issue.assignees ?? []).length > 0) return "assigned issue has maintainer engagement";
    if (issue.milestone) return "milestoned issue has maintainer engagement";
    const totalReactions = asRecord(issue.reactions).total_count;
    if (!Number.isInteger(totalReactions) || Number(totalReactions) < 0) {
      return "live issue reaction count is unavailable";
    }
    if (Number(totalReactions) >= 20)
      return "issue has strong community traction (20 or more reactions)";
    if (labels.includes("clawsweeper:linked-pr-open")) {
      return "clawsweeper:linked-pr-open blocks stale-version bug auto-close";
    }

    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
    if (maintainerAssociatedEntries(comments).length > 0) {
      return "maintainer issue comment confirms engagement";
    }
    return issueRecentHumanCommentBlockReasonFromComments(
      comments,
      STALE_VERSION_BUG_MIN_INACTIVE_DAYS,
    );
  }
  function staleVersionBugApplyBlockReasonSafe(
    number: number,
    item: Pick<Item, "createdAt">,
  ): string | null {
    try {
      return staleVersionBugApplyBlockReason(number, item);
    } catch (error) {
      return `stale-version bug liveness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  return {
    lowSignalUnmergeablePrApplyBlockReason,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    unconfirmedProductDirectionApplyBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReason,
    unsponsoredFeatureApplyBlockReasonSafe,
    staleVersionBugApplyBlockReason,
    staleVersionBugApplyBlockReasonSafe,
  };
}
