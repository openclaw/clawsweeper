import {
  PR_AUTO_CLOSE_EXEMPT_LABELS,
  STALE_VERSION_BUG_MIN_INACTIVE_DAYS,
  UNSPONSORED_FEATURE_MIN_INACTIVE_DAYS,
} from "./clawsweeper-policy.js";
import type { ApplyCloseGuardBlock, GitHubUser, Item } from "./clawsweeper-types.js";
import {
  issueRecentHumanCommentBlockFromComments,
  lowSignalUnmergeablePrAuthorActivityBlockReason,
  lowSignalUnmergeablePrConflictBlockReason,
  maintainerAssociatedEntries,
  prAutoCloseExemptLabel,
  type ApplyGuardActivity,
  type GuardReads,
} from "./clawsweeper-apply-guard-activity.js";
import {
  labelNames,
  normalizeLabelName,
  protectedLabels,
  staleVersionBugAgeSkipReason,
  unconfirmedProductDirectionAgeBlock,
  unsponsoredFeatureAgeSkipReason,
} from "./clawsweeper-item-policy.js";
import {
  staleVersionBugCloseEnabled,
  unconfirmedProductDirectionCloseEnabled,
  unsponsoredFeatureCloseEnabled,
} from "./policy-flags.js";
import { asRecord } from "./value-coerce.js";

export function createApplyGuardPolicy(
  { ghJson, ghPaged, targetRepo }: GuardReads,
  { pullRequestHeadActivity }: ApplyGuardActivity,
) {
  function lowSignalUnmergeablePrApplyBlockReason(
    number: number,
    staleMinAgeDays: number,
  ): string | null {
    const issue = ghJson<{ assignees?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
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
  function unconfirmedProductDirectionApplyBlock(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
  ): ApplyCloseGuardBlock | null {
    if (!unconfirmedProductDirectionCloseEnabled()) {
      return { reason: "unconfirmed product-direction apply policy is disabled" };
    }
    const ageBlock = unconfirmedProductDirectionAgeBlock(item, reviewedUpdatedAt, reviewedAt);
    if (ageBlock) return ageBlock;
    const exemptLabel = item.labels
      .map(normalizeLabelName)
      .find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
    if (exemptLabel)
      return { reason: `${exemptLabel} exempts this PR from product-direction auto-close` };

    const issue = ghJson<{ assignees?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
    ]);
    if ((issue.assignees ?? []).length > 0)
      return { reason: "assigned PR has active human signal" };

    const pull = ghJson<{ requested_reviewers?: unknown[]; requested_teams?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/pulls/${number}`,
    ]);
    if ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0) {
      return { reason: "requested reviewers or teams indicate active review signal" };
    }

    const maintainerComments = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`),
    );
    if (maintainerComments.length > 0)
      return { reason: "maintainer issue comment calibrates product direction" };

    const maintainerReviews = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`),
    );
    if (maintainerReviews.length > 0)
      return { reason: "maintainer PR review calibrates product direction" };

    const maintainerInlineComments = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`),
    );
    if (maintainerInlineComments.length > 0) {
      return { reason: "maintainer inline review comment calibrates product direction" };
    }
    return null;
  }
  function unconfirmedProductDirectionApplyBlockSafe(
    number: number,
    item: Pick<Item, "createdAt" | "labels">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
  ): ApplyCloseGuardBlock | null {
    try {
      return unconfirmedProductDirectionApplyBlock(number, item, reviewedUpdatedAt, reviewedAt);
    } catch (error) {
      return {
        reason: `product-direction calibration check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  function unsponsoredFeatureApplyBlock(
    number: number,
    item: Pick<Item, "createdAt">,
  ): ApplyCloseGuardBlock | null {
    if (!unsponsoredFeatureCloseEnabled()) {
      return { reason: "unsponsored feature-request apply policy is disabled" };
    }
    const ageBlock = unsponsoredFeatureAgeSkipReason(item);
    if (ageBlock) return { reason: ageBlock };

    const issue = ghJson<{
      assignees?: unknown[];
      labels?: unknown[];
      milestone?: unknown;
      reactions?: unknown;
      state?: string;
    }>(["api", `repos/${targetRepo()}/issues/${number}`]);
    if (issue.state !== "open") return { reason: "live issue is not open" };
    if (protectedLabels(labelNames(issue.labels)).length > 0) {
      return { reason: "security-labeled issue requires human triage" };
    }
    if ((issue.assignees ?? []).length > 0)
      return { reason: "assigned issue has maintainer engagement" };
    if (issue.milestone) return { reason: "milestoned issue has maintainer engagement" };
    if (positiveReactionCount(issue.reactions) >= positiveReactionThreshold()) {
      return { reason: "issue has enough positive reactions for maintainer consideration" };
    }
    const totalReactions = asRecord(issue.reactions).total_count;
    if (typeof totalReactions === "number" && totalReactions >= 20) {
      return { reason: "issue has strong community traction (20 or more reactions)" };
    }
    if (labelNames(issue.labels).map(normalizeLabelName).includes("clawsweeper:linked-pr-open")) {
      return { reason: "clawsweeper:linked-pr-open blocks unsponsored feature auto-close" };
    }

    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
    if (maintainerAssociatedEntries(comments).length > 0) {
      return { reason: "maintainer issue comment confirms engagement" };
    }
    return issueRecentHumanCommentBlockFromComments(
      comments,
      UNSPONSORED_FEATURE_MIN_INACTIVE_DAYS,
    );
  }
  function unsponsoredFeatureApplyBlockSafe(
    number: number,
    item: Pick<Item, "createdAt">,
  ): ApplyCloseGuardBlock | null {
    try {
      return unsponsoredFeatureApplyBlock(number, item);
    } catch (error) {
      return {
        reason: `unsponsored feature-request liveness check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  function staleVersionBugApplyBlock(
    number: number,
    item: Pick<Item, "createdAt">,
  ): ApplyCloseGuardBlock | null {
    if (!staleVersionBugCloseEnabled())
      return { reason: "stale-version bug apply policy is disabled" };
    const ageBlock = staleVersionBugAgeSkipReason(item);
    if (ageBlock) return { reason: ageBlock };

    const issue = ghJson<{
      assignees?: unknown[];
      created_at?: string;
      labels?: unknown[];
      milestone?: unknown;
      reactions?: unknown;
      state?: string;
    }>(["api", `repos/${targetRepo()}/issues/${number}`]);
    if (issue.state !== "open") return { reason: "live issue is not open" };
    // Stored records can carry stale timestamps; the age floor must hold live.
    if (!Number.isFinite(Date.parse(issue.created_at ?? ""))) {
      return { reason: "live issue creation date is unavailable" };
    }
    const liveAgeBlock = staleVersionBugAgeSkipReason({ createdAt: issue.created_at ?? "" });
    if (liveAgeBlock) return { reason: liveAgeBlock };
    const labels = labelNames(issue.labels).map(normalizeLabelName);
    const protectedLabel =
      protectedLabels(labelNames(issue.labels))[0] ??
      prAutoCloseExemptLabel(labelNames(issue.labels));
    if (protectedLabel) return { reason: `protected label: ${protectedLabel}` };
    if ((issue.assignees ?? []).length > 0)
      return { reason: "assigned issue has maintainer engagement" };
    if (issue.milestone) return { reason: "milestoned issue has maintainer engagement" };
    const totalReactions = asRecord(issue.reactions).total_count;
    if (!Number.isInteger(totalReactions) || Number(totalReactions) < 0) {
      return { reason: "live issue reaction count is unavailable" };
    }
    if (Number(totalReactions) >= 20)
      return { reason: "issue has strong community traction (20 or more reactions)" };
    if (labels.includes("clawsweeper:linked-pr-open")) {
      return { reason: "clawsweeper:linked-pr-open blocks stale-version bug auto-close" };
    }

    const comments = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`);
    if (maintainerAssociatedEntries(comments).length > 0) {
      return { reason: "maintainer issue comment confirms engagement" };
    }
    return issueRecentHumanCommentBlockFromComments(comments, STALE_VERSION_BUG_MIN_INACTIVE_DAYS);
  }
  function staleVersionBugApplyBlockSafe(
    number: number,
    item: Pick<Item, "createdAt">,
  ): ApplyCloseGuardBlock | null {
    try {
      return staleVersionBugApplyBlock(number, item);
    } catch (error) {
      return {
        reason: `stale-version bug liveness check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    lowSignalUnmergeablePrApplyBlockReason,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    unconfirmedProductDirectionApplyBlock,
    unconfirmedProductDirectionApplyBlockSafe,
    unsponsoredFeatureApplyBlock,
    unsponsoredFeatureApplyBlockSafe,
    staleVersionBugApplyBlock,
    staleVersionBugApplyBlockSafe,
  };
}

function positiveReactionThreshold(): number {
  const configured = Number(process.env.CLAWSWEEPER_IDEA_REVIVAL_REACTIONS);
  return Number.isInteger(configured) && configured > 0 && configured <= 1_000 ? configured : 5;
}

function positiveReactionCount(reactions: unknown): number {
  if (!reactions || typeof reactions !== "object" || Array.isArray(reactions)) return 0;
  const record = reactions as Record<string, unknown>;
  return ["+1", "heart", "hooray"].reduce((total, name) => {
    const value = record[name];
    return total + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}
