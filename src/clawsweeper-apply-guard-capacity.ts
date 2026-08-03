import {
  AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS,
  DAY_MS,
  OBSOLETE_FIX_PR_MAX_CHANGED_FILES,
  OBSOLETE_FIX_PR_MIN_INACTIVE_DAYS,
} from "./clawsweeper-policy.js";
import type { AuthorPrBudgetApplyGate, Item } from "./clawsweeper-types.js";
import type { ApplyGuardDependencies } from "./clawsweeper-apply-guard-dependencies.js";
import type { createApplyGuardActivity } from "./clawsweeper-apply-guard-activity.js";
import type { createApplyGuardPolicy } from "./clawsweeper-apply-guard-policy.js";
import type { createApplyGuardProof } from "./clawsweeper-apply-guard-proof.js";

export function createApplyGuardCapacity(
  dependencies: ApplyGuardDependencies &
    ReturnType<typeof createApplyGuardActivity> &
    ReturnType<typeof createApplyGuardPolicy> &
    ReturnType<typeof createApplyGuardProof>,
) {
  const {
    asRecord,
    authorPrBudget,
    authorPrBudgetAgeSkipReason,
    authorPrBudgetCloseEnabled,
    ghJson,
    isMaintainerAuthored,
    labelNames,
    obsoleteFixPrAgeSkipReason,
    obsoleteFixPrCloseEnabled,
    protectedLabels,
    stringOrUndefined,
    targetRepo,
    pullRequestHumanEngagementBlockReason,
    pullRequestLiveActivity,
    prAutoCloseExemptLabel,
    isWorkflowOrCiPath,
    defaultBranchPathMissing,
    authorPrBudgetSignalBlockReason,
    authorOpenPullRequestCount,
  } = dependencies;

  function obsoleteFixPrApplyBlockReason(
    number: number,
    item: Pick<Item, "createdAt">,
  ): string | null {
    if (!obsoleteFixPrCloseEnabled()) return "obsolete-fix PR apply policy is disabled";
    const storedAgeBlock = obsoleteFixPrAgeSkipReason(item);
    if (storedAgeBlock) return storedAgeBlock;

    const activity = pullRequestLiveActivity(number);
    if (activity.state !== "open") return "live PR is not open";
    const liveAgeBlock = obsoleteFixPrAgeSkipReason({ createdAt: activity.createdAt });
    if (liveAgeBlock) return liveAgeBlock;
    if (!activity.headSha) return "obsolete_fix_pr requires a live PR head SHA";
    if (
      activity.changedFiles === null ||
      activity.changedFiles < 1 ||
      activity.changedFiles > OBSOLETE_FIX_PR_MAX_CHANGED_FILES
    ) {
      return `obsolete_fix_pr requires between 1 and ${OBSOLETE_FIX_PR_MAX_CHANGED_FILES} live changed files`;
    }

    const commit = ghJson<{ commit?: { committer?: { date?: string } } }>([
      "api",
      `repos/${targetRepo()}/commits/${activity.headSha}`,
    ]);
    const committedAt = commit.commit?.committer?.date ?? "";
    const committedAtMs = Date.parse(committedAt);
    if (!Number.isFinite(committedAtMs)) {
      return "obsolete_fix_pr requires a dated current-head committer timestamp";
    }
    const latestActivityAtMs = Math.max(
      committedAtMs,
      activity.headActivityAtMs ?? Number.NEGATIVE_INFINITY,
      activity.headStatusActivityAtMs ?? Number.NEGATIVE_INFINITY,
    );
    if (Date.now() - latestActivityAtMs <= OBSOLETE_FIX_PR_MIN_INACTIVE_DAYS * DAY_MS) {
      return `obsolete_fix_pr requires ${OBSOLETE_FIX_PR_MIN_INACTIVE_DAYS} days without current-head commit, status, or check-run activity`;
    }

    const issue = ghJson<{ assignees?: unknown[]; labels?: unknown[] }>([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
    ]);
    const protectedLabel = protectedLabels(labelNames(issue.labels))[0];
    if (protectedLabel) return `protected label: ${protectedLabel}`;
    const engagementBlock = pullRequestHumanEngagementBlockReason(number, {
      assignees: issue.assignees ?? [],
      requestedReviewers: activity.requestedReviewers,
      requestedTeams: activity.requestedTeams,
    });
    if (engagementBlock) return engagementBlock;

    const repository = ghJson<{ default_branch?: string }>(["api", `repos/${targetRepo()}`]);
    const defaultBranch = repository.default_branch?.trim() ?? "";
    if (!defaultBranch) return "obsolete_fix_pr requires the repository default branch";
    const files = ghJson<unknown[]>([
      "api",
      `repos/${targetRepo()}/pulls/${number}/files?per_page=${OBSOLETE_FIX_PR_MAX_CHANGED_FILES}`,
    ]);
    if (files.length !== activity.changedFiles) {
      return "obsolete_fix_pr live changed-file list is incomplete";
    }
    const changedEntries = files.map((file) => ({
      path: stringOrUndefined(asRecord(file).filename)?.trim() ?? "",
      status: stringOrUndefined(asRecord(file).status)?.trim() ?? "",
    }));
    const paths = changedEntries.map((entry) => entry.path);
    if (paths.some((path) => !path) || new Set(paths).size !== paths.length) {
      return "obsolete_fix_pr live changed-file paths are incomplete";
    }

    const since = new Date(committedAtMs + 1).toISOString();
    for (const { path, status } of changedEntries) {
      const commits = ghJson<unknown[]>([
        "api",
        `repos/${targetRepo()}/commits?sha=${encodeURIComponent(defaultBranch)}&path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}&per_page=1`,
      ]);
      if (commits.length === 0) {
        // A missing path only signals deletion when `filename` names a path that
        // pre-existed on main. Added files never lived there, and renamed/copied
        // entries carry the NEW path in `filename`, so absence proves nothing.
        if (
          (status === "modified" || status === "removed" || status === "changed") &&
          isWorkflowOrCiPath(path) &&
          defaultBranchPathMissing(path, defaultBranch)
        ) {
          continue;
        }
        return `touched path unchanged on main; fix may still be relevant: ${path}`;
      }
      const changedAt = asRecord(asRecord(commits[0]).commit).committer;
      const changedDate = stringOrUndefined(asRecord(changedAt).date) ?? "";
      if (!Number.isFinite(Date.parse(changedDate)) || Date.parse(changedDate) <= committedAtMs) {
        return `post-PR main-side change date is unavailable for touched path: ${path}`;
      }
    }
    return null;
  }
  function obsoleteFixPrApplyBlockReasonSafe(
    number: number,
    item: Pick<Item, "createdAt">,
  ): string | null {
    try {
      return obsoleteFixPrApplyBlockReason(number, item);
    } catch (error) {
      return `obsolete-fix PR live check failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  function authorPrBudgetApplyGate(
    number: number,
    item: Pick<Item, "author" | "authorAssociation" | "createdAt" | "kind" | "labels">,
    markdown: string,
  ): AuthorPrBudgetApplyGate {
    if (!authorPrBudgetCloseEnabled()) {
      return { allowed: false, reason: "author PR-budget apply policy is disabled" };
    }
    if (item.kind !== "pull_request") {
      return {
        allowed: false,
        reason: "author_pr_budget_exceeded is allowed only for pull requests",
      };
    }
    if (isMaintainerAuthored(item)) {
      return {
        allowed: false,
        reason: "author_pr_budget_exceeded cannot close maintainer-authored pull requests",
      };
    }
    const exemptLabel = prAutoCloseExemptLabel(item.labels);
    if (exemptLabel) {
      return {
        allowed: false,
        reason: `${exemptLabel} exempts this PR from author-budget auto-close`,
      };
    }
    const ageBlock = authorPrBudgetAgeSkipReason(item);
    if (ageBlock) return { allowed: false, reason: ageBlock };
    const signalBlock = authorPrBudgetSignalBlockReason(markdown);
    if (signalBlock) return { allowed: false, reason: signalBlock };
    if (!item.author.trim()) {
      return { allowed: false, reason: "author_pr_budget_exceeded requires a known PR author" };
    }

    const activity = pullRequestLiveActivity(number);
    if (!activity.headSha) {
      return { allowed: false, reason: "author_pr_budget_exceeded requires a live PR head SHA" };
    }
    const commit = ghJson<{ commit?: { committer?: { date?: string } } }>([
      "api",
      `repos/${targetRepo()}/commits/${activity.headSha}`,
    ]);
    const committedAtMs = Date.parse(commit.commit?.committer?.date ?? "");
    if (!Number.isFinite(committedAtMs)) {
      return {
        allowed: false,
        reason: "author_pr_budget_exceeded requires a dated current-head committer timestamp",
      };
    }
    const latestActivityAtMs = Math.max(
      committedAtMs,
      activity.headActivityAtMs ?? Number.NEGATIVE_INFINITY,
      activity.headStatusActivityAtMs ?? Number.NEGATIVE_INFINITY,
    );
    if (Date.now() - latestActivityAtMs <= AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS * DAY_MS) {
      return {
        allowed: false,
        reason: `author_pr_budget_exceeded requires ${AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS} days without current-head commit, status, or check-run activity`,
      };
    }

    const engagementBlock = pullRequestHumanEngagementBlockReason(number);
    if (engagementBlock) return { allowed: false, reason: engagementBlock };

    const budget = authorPrBudget();
    const openPrCount = authorOpenPullRequestCount(item.author);
    if (openPrCount <= budget) {
      return {
        allowed: false,
        reason: `author has ${openPrCount} open PRs; author PR budget is ${budget}`,
      };
    }
    return { allowed: true, state: { author: item.author, openPrCount, budget } };
  }
  function authorPrBudgetApplyGateSafe(
    number: number,
    item: Pick<Item, "author" | "authorAssociation" | "createdAt" | "kind" | "labels">,
    markdown: string,
  ): AuthorPrBudgetApplyGate {
    try {
      return authorPrBudgetApplyGate(number, item, markdown);
    } catch (error) {
      return {
        allowed: false,
        reason: `author PR-budget live check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    obsoleteFixPrApplyBlockReason,
    obsoleteFixPrApplyBlockReasonSafe,
    authorPrBudgetApplyGate,
    authorPrBudgetApplyGateSafe,
  };
}
