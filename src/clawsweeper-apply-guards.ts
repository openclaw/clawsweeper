import { isGitHubNotFoundError } from "./github-retry.js";
import { ideaRevivalReactionThreshold, positiveReactionCount } from "./idea-archive-revival.js";
import {
  ABANDONED_PR_MIN_AGE_DAYS,
  ABANDONED_PR_MIN_INACTIVE_DAYS,
  AUTHOR_PR_BUDGET_MIN_INACTIVE_DAYS,
  DAY_MS,
  LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS,
  OBSOLETE_FIX_PR_MAX_CHANGED_FILES,
  OBSOLETE_FIX_PR_MIN_INACTIVE_DAYS,
  PROOF_NUDGE_MARKER_PREFIX,
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
  PR_AUTO_CLOSE_EXEMPT_LABELS,
  STALE_VERSION_BUG_MIN_INACTIVE_DAYS,
  STALLED_UNPROVEN_PR_MIN_AGE_DAYS,
  STALLED_UNPROVEN_PR_MIN_INACTIVE_DAYS,
  UNSPONSORED_FEATURE_MIN_INACTIVE_DAYS,
  WAITING_ON_AUTHOR_LABEL,
} from "./clawsweeper-policy.js";
import type {
  AuthorPrBudgetApplyGate,
  CloseReason,
  GitHubUser,
  Item,
  PrRating,
  PullRequestLiveActivity,
  RealBehaviorProof,
} from "./clawsweeper-types.js";

export const STALLED_UNPROVEN_PROOF_STATUSES = new Set(["missing", "mock_only", "insufficient"]);

interface ApplyGuardDependencies {
  asRecord: (value: unknown) => Record<string, unknown>;
  authorPrBudget: () => number;
  authorPrBudgetAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  authorPrBudgetCloseEnabled: () => boolean;
  ghJson: <T>(args: string[]) => T;
  ghPaged: <T>(path: string) => T[];
  isMaintainerAuthorAssociation: (value: unknown) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isOlderThanDays: (isoTimestamp: string, days: number, now?: number) => boolean;
  labelNames: (value: unknown) => string[];
  login: (value: unknown) => string | undefined;
  normalizeLabelName: (label: string) => string;
  obsoleteFixPrAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  obsoleteFixPrCloseEnabled: () => boolean;
  protectedLabels: (labels: readonly string[]) => string[];
  quoteGitHubSearchTerm: (term: string) => string;
  reportPrRating: (markdown: string) => PrRating;
  reportRealBehaviorProof: (markdown: string) => RealBehaviorProof;
  staleVersionBugAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  staleVersionBugCloseEnabled: () => boolean;
  stringOrUndefined: (value: unknown) => string | undefined;
  targetRepo: () => string;
  unconfirmedProductDirectionAgeSkipReason: (
    item: Pick<Item, "createdAt">,
    reviewedUpdatedAt: string | undefined,
    reviewedAt: string | undefined,
    now?: number,
  ) => string | null;
  unconfirmedProductDirectionCloseEnabled: () => boolean;
  unsponsoredFeatureAgeSkipReason: (item: Pick<Item, "createdAt">, now?: number) => string | null;
  unsponsoredFeatureCloseEnabled: () => boolean;
}

export function createApplyGuards({
  asRecord,
  authorPrBudget,
  authorPrBudgetAgeSkipReason,
  authorPrBudgetCloseEnabled,
  ghJson,
  ghPaged,
  isMaintainerAuthorAssociation,
  isMaintainerAuthored,
  isOlderThanDays,
  labelNames,
  login,
  normalizeLabelName,
  obsoleteFixPrAgeSkipReason,
  obsoleteFixPrCloseEnabled,
  protectedLabels,
  quoteGitHubSearchTerm,
  reportPrRating,
  reportRealBehaviorProof,
  staleVersionBugAgeSkipReason,
  staleVersionBugCloseEnabled,
  stringOrUndefined,
  targetRepo,
  unconfirmedProductDirectionAgeSkipReason,
  unconfirmedProductDirectionCloseEnabled,
  unsponsoredFeatureAgeSkipReason,
  unsponsoredFeatureCloseEnabled,
}: ApplyGuardDependencies) {
  function maintainerAssociatedEntries(entries: readonly unknown[]): unknown[] {
    return entries.filter((entry) =>
      isMaintainerAuthorAssociation(asRecord(entry).author_association),
    );
  }

  function lowSignalUnmergeablePrConflictBlockReason(pullValue: unknown): string | null {
    const pull = asRecord(pullValue);
    const mergeableState = (
      stringOrUndefined(pull.mergeableState) ??
      stringOrUndefined(pull.mergeable_state) ??
      "unknown"
    ).toLowerCase();
    if (pull.mergeable === false && mergeableState === "dirty") return null;
    const mergeable = typeof pull.mergeable === "boolean" ? String(pull.mergeable) : "unknown";
    return `low_signal_unmergeable_pr requires a live merge conflict; GitHub reports mergeable=${mergeable}, mergeable_state=${mergeableState}`;
  }

  function githubActivityTimestampMs(value: unknown): number | null {
    const record = asRecord(value);
    for (const candidate of [
      record.updatedAt,
      record.updated_at,
      record.submitted_at,
      record.createdAt,
      record.created_at,
    ]) {
      const timestamp = Date.parse(typeof candidate === "string" ? candidate : "");
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return null;
  }

  function githubActivityLogin(value: unknown): string {
    const record = asRecord(value);
    return (
      stringOrUndefined(record.author) ??
      login(record.user) ??
      stringOrUndefined(record.actor) ??
      login(record.actor) ??
      ""
    )
      .trim()
      .toLowerCase();
  }

  function latestPullRequestAuthorActivityAtMs(options: {
    author: string;
    createdAt: string;
    comments?: readonly unknown[];
    reviews?: readonly unknown[];
    inlineComments?: readonly unknown[];
    timeline?: readonly unknown[];
    headActivityAtMs?: number | null;
  }): number | null {
    const author = options.author.trim().toLowerCase();
    if (!author) return null;
    let latest = Date.parse(options.createdAt);
    if (!Number.isFinite(latest)) latest = Number.NEGATIVE_INFINITY;
    const observe = (value: unknown): void => {
      if (githubActivityLogin(value) !== author) return;
      const timestamp = githubActivityTimestampMs(value);
      if (timestamp !== null && timestamp > latest) latest = timestamp;
    };
    options.comments?.forEach(observe);
    options.reviews?.forEach(observe);
    options.inlineComments?.forEach(observe);
    for (const event of options.timeline ?? []) {
      const record = asRecord(event);
      const eventName = stringOrUndefined(record.event) ?? "";
      const commitId = stringOrUndefined(record.commitId) ?? stringOrUndefined(record.commit_id);
      if (
        eventName === "commented" ||
        eventName === "committed" ||
        eventName === "head_ref_force_pushed" ||
        eventName === "head_ref_restored" ||
        Boolean(commitId)
      ) {
        observe(event);
      }
    }
    if (options.headActivityAtMs !== null && options.headActivityAtMs !== undefined) {
      latest = Math.max(latest, options.headActivityAtMs);
    }
    return Number.isFinite(latest) ? latest : null;
  }

  function lowSignalUnmergeablePrAuthorActivityBlockReason(options: {
    author: string;
    createdAt: string;
    comments?: readonly unknown[];
    reviews?: readonly unknown[];
    inlineComments?: readonly unknown[];
    timeline?: readonly unknown[];
    headActivityAtMs?: number | null;
    staleMinAgeDays: number;
    requireHeadActivityEvidence?: boolean;
    now?: number;
  }): string | null {
    if (
      options.requireHeadActivityEvidence &&
      (options.headActivityAtMs === null || options.headActivityAtMs === undefined)
    ) {
      return "low_signal_unmergeable_pr requires dated activity evidence for the current head";
    }
    const latestActivityAtMs = latestPullRequestAuthorActivityAtMs(options);
    if (latestActivityAtMs === null) {
      return "low_signal_unmergeable_pr requires dated author and current-head activity evidence";
    }
    const now = options.now ?? Date.now();
    const configuredInactiveDays = Number.isFinite(options.staleMinAgeDays)
      ? Math.max(0, options.staleMinAgeDays)
      : LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS;
    const minimumInactiveDays = Math.max(
      LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS,
      configuredInactiveDays,
    );
    if (now - latestActivityAtMs <= minimumInactiveDays * DAY_MS) {
      return `low_signal_unmergeable_pr requires ${minimumInactiveDays} days without author comments or head activity`;
    }
    return null;
  }

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

  function issueRecentHumanCommentBlockReasonFromComments(
    comments: readonly unknown[],
    days: number,
    now = Date.now(),
  ): string | null {
    for (const comment of comments) {
      const record = asRecord(comment);
      if (asRecord(record.user).type === "Bot") continue;
      const createdAt = typeof record.created_at === "string" ? record.created_at : "";
      if (!isOlderThanDays(createdAt, days, now)) {
        return `issue has a non-bot comment within the last ${days} days`;
      }
    }
    return null;
  }

  function issueRecentHumanCommentBlockReason(number: number, days: number): string | null {
    return issueRecentHumanCommentBlockReasonFromComments(
      ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments`),
      days,
    );
  }

  function issueRecentHumanCommentBlockReasonSafe(number: number, days: number): string | null {
    try {
      return issueRecentHumanCommentBlockReason(number, days);
    } catch (error) {
      return `issue comment activity check failed: ${
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

  function pullRequestHumanEngagementBlockReason(
    number: number,
    known?: {
      assignees?: unknown[];
      requestedReviewers?: unknown[];
      requestedTeams?: unknown[];
    },
  ): string | null {
    const issue = known
      ? { assignees: known.assignees }
      : ghJson<{ assignees?: unknown[] }>([
          "api",
          `repos/${targetRepo()}/issues/${number}`,
          "--jq",
          "{assignees:[.assignees[]? | {login:.login}]}",
        ]);
    if ((issue.assignees ?? []).length > 0) return "assigned PR has active human signal";

    const pull = known
      ? {
          requested_reviewers: known.requestedReviewers,
          requested_teams: known.requestedTeams,
        }
      : ghJson<{ requested_reviewers?: unknown[]; requested_teams?: unknown[] }>([
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
      return "maintainer issue comment blocks inactivity auto-close";

    const maintainerReviews = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/reviews`),
    );
    if (maintainerReviews.length > 0) return "maintainer PR review blocks inactivity auto-close";

    const maintainerInlineComments = maintainerAssociatedEntries(
      ghPaged<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`),
    );
    if (maintainerInlineComments.length > 0) {
      return "maintainer inline review comment blocks inactivity auto-close";
    }
    return null;
  }

  const FAILING_CHECK_RUN_CONCLUSIONS = new Set(["failure", "timed_out"]);

  // Commit dates are author-controlled and a force-push can reuse an old SHA.
  // A pull_request workflow run associated with this PR is tied to source
  // activity, while rerunning its checks leaves created_at unchanged. Missing
  // source-run data keeps the PR open.

  function pullRequestHeadActivity(
    number: number,
    pull: {
      created_at?: string;
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    },
    timeline = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/timeline`),
  ): Pick<PullRequestLiveActivity, "headSha" | "headActivityAtMs"> {
    const headSha = typeof pull.head?.sha === "string" ? pull.head.sha : "";
    let headActivityAtMs: number | null = null;
    const observe = (value: unknown): void => {
      const ms = Date.parse(typeof value === "string" ? value : "");
      if (Number.isFinite(ms) && (headActivityAtMs === null || ms > headActivityAtMs)) {
        headActivityAtMs = ms;
      }
    };
    if (headSha) {
      const sourceRuns = ghJson<{ workflow_runs?: unknown[] }>([
        "api",
        `repos/${targetRepo()}/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=pull_request&per_page=100`,
      ]);
      for (const run of sourceRuns.workflow_runs ?? []) {
        const record = asRecord(run);
        const directlyAssociated = Array.isArray(record.pull_requests)
          ? record.pull_requests.some((pull) => Number(asRecord(pull).number) === number)
          : false;
        const runRepo = asRecord(record.head_repository);
        const pullCreatedAtMs = Date.parse(pull.created_at ?? "");
        const runCreatedAtMs = Date.parse(
          typeof record.created_at === "string" ? record.created_at : "",
        );
        const sameSourceBranch =
          typeof pull.head?.ref === "string" &&
          record.head_branch === pull.head.ref &&
          ((Number.isFinite(Number(pull.head.repo?.id)) &&
            Number(pull.head.repo?.id) === Number(runRepo.id)) ||
            (typeof pull.head.repo?.full_name === "string" &&
              runRepo.full_name === pull.head.repo.full_name)) &&
          Number.isFinite(pullCreatedAtMs) &&
          Number.isFinite(runCreatedAtMs) &&
          runCreatedAtMs >= pullCreatedAtMs;
        if (record.event === "pull_request" && (directlyAssociated || sameSourceBranch)) {
          observe(record.created_at);
        }
      }
      for (const event of timeline) {
        const record = asRecord(event);
        const commitId = stringOrUndefined(record.commitId) ?? stringOrUndefined(record.commit_id);
        if (record.event === "head_ref_force_pushed" && commitId === headSha) {
          observe(stringOrUndefined(record.createdAt) ?? record.created_at);
        }
      }
    }
    return { headSha, headActivityAtMs };
  }

  function pullRequestLiveActivity(number: number): PullRequestLiveActivity {
    const pull = ghJson<{
      created_at?: string;
      draft?: boolean;
      state?: string;
      changed_files?: number;
      mergeable?: boolean | null;
      mergeable_state?: string | null;
      requested_reviewers?: unknown[];
      requested_teams?: unknown[];
      head?: { ref?: string; repo?: { full_name?: string; id?: unknown }; sha?: string };
    }>(["api", `repos/${targetRepo()}/pulls/${number}`]);
    const { headSha, headActivityAtMs } = pullRequestHeadActivity(number, pull);
    let headChecksFailing = false;
    let headStatusActivityAtMs: number | null = null;
    const observeStatusActivity = (value: unknown): void => {
      const record = asRecord(value);
      for (const candidate of [
        record.completed_at,
        record.started_at,
        record.updated_at,
        record.created_at,
      ]) {
        const timestamp = Date.parse(typeof candidate === "string" ? candidate : "");
        if (
          Number.isFinite(timestamp) &&
          (headStatusActivityAtMs === null || timestamp > headStatusActivityAtMs)
        ) {
          headStatusActivityAtMs = timestamp;
        }
      }
    };
    if (headSha) {
      const combined = ghJson<{ state?: string; statuses?: unknown[] }>([
        "api",
        `repos/${targetRepo()}/commits/${headSha}/status`,
      ]);
      if (combined.state === "failure" || combined.state === "error") headChecksFailing = true;
      for (const status of combined.statuses ?? []) observeStatusActivity(status);
      const checks = ghJson<{ check_runs?: unknown[] }>([
        "api",
        `repos/${targetRepo()}/commits/${headSha}/check-runs?per_page=100`,
      ]);
      for (const run of checks.check_runs ?? []) {
        const record = asRecord(run);
        observeStatusActivity(record);
        if (
          typeof record.conclusion === "string" &&
          FAILING_CHECK_RUN_CONCLUSIONS.has(record.conclusion)
        ) {
          headChecksFailing = true;
        }
      }
    }
    const headConflicted = pull.mergeable === false || pull.mergeable_state === "dirty";
    return {
      state: pull.state ?? "",
      createdAt: pull.created_at ?? "",
      draft: pull.draft === true,
      headSha,
      changedFiles: Number.isInteger(pull.changed_files) ? Number(pull.changed_files) : null,
      requestedReviewers: pull.requested_reviewers ?? [],
      requestedTeams: pull.requested_teams ?? [],
      headActivityAtMs,
      headStatusActivityAtMs,
      headChecksFailing,
      headConflicted,
    };
  }

  function prAutoCloseExemptLabel(labels: readonly string[]): string | undefined {
    return labels.map(normalizeLabelName).find((label) => PR_AUTO_CLOSE_EXEMPT_LABELS.has(label));
  }

  function prAutoCloseExemptDecisionReason(
    item: Pick<Item, "kind" | "labels">,
    closeReason: CloseReason | undefined,
  ): string | null {
    if (item.kind !== "pull_request") return null;
    const exemptLabel = prAutoCloseExemptLabel(item.labels);
    if (!exemptLabel) return null;
    if (closeReason === "unconfirmed_product_direction") {
      return `${exemptLabel} exempts this PR from product-direction auto-close`;
    }
    if (closeReason === "stalled_unproven_pr") {
      return `${exemptLabel} exempts this PR from stalled-unproven auto-close`;
    }
    if (closeReason === "abandoned_pr") {
      return `${exemptLabel} exempts this PR from abandoned-PR auto-close`;
    }
    if (closeReason === "author_pr_budget_exceeded") {
      return `${exemptLabel} exempts this PR from author-budget auto-close`;
    }
    if (closeReason === "obsolete_fix_pr") {
      return `${exemptLabel} exempts this PR from obsolete-fix auto-close`;
    }
    return null;
  }

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

  // The durable review comment is edited in place, so its created_at cannot
  // date the proof ask. Only immutable signals count: needs-proof label
  // timeline events and proof-nudge comment creation times.

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

  function isWorkflowOrCiPath(path: string): boolean {
    const normalized = path.toLowerCase();
    return (
      normalized.startsWith(".github/workflows/") ||
      normalized.startsWith(".github/actions/") ||
      normalized.startsWith(".circleci/") ||
      normalized.startsWith(".buildkite/") ||
      normalized.startsWith("ci/") ||
      normalized === ".gitlab-ci.yml" ||
      normalized === "azure-pipelines.yml" ||
      normalized === "jenkinsfile"
    );
  }

  function githubContentsPath(path: string): string {
    return path
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
  }

  function defaultBranchPathMissing(path: string, defaultBranch: string): boolean {
    try {
      ghJson<unknown>([
        "api",
        `repos/${targetRepo()}/contents/${githubContentsPath(path)}?ref=${encodeURIComponent(defaultBranch)}`,
      ]);
      return false;
    } catch (error) {
      if (isGitHubNotFoundError(error)) return true;
      throw error;
    }
  }

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

  function authorPrBudgetSignalBlockReason(markdown: string): string | null {
    const proof = reportRealBehaviorProof(markdown);
    const rating = reportPrRating(markdown);
    if (
      ["S", "A", "B"].includes(rating.overallTier) &&
      ["sufficient", "override"].includes(proof.status)
    ) {
      return "author_pr_budget_exceeded cannot close a high-quality proven pull request";
    }
    if (
      !["D", "F"].includes(rating.overallTier) &&
      !STALLED_UNPROVEN_PROOF_STATUSES.has(proof.status)
    ) {
      return "author_pr_budget_exceeded requires a D/F rating or missing, mock-only, or insufficient real behavior proof";
    }
    return null;
  }

  function authorOpenPullRequestCount(author: string): number {
    const query = [
      `repo:${targetRepo()}`,
      "is:pr",
      "is:open",
      `author:${quoteGitHubSearchTerm(author)}`,
    ].join(" ");
    const result = ghJson<{ total_count?: number; incomplete_results?: boolean }>([
      "api",
      "search/issues",
      "--method",
      "GET",
      "-f",
      `q=${query}`,
      "-f",
      "per_page=1",
    ]);
    if (result.incomplete_results === true) {
      throw new Error("GitHub author open-PR search returned incomplete results");
    }
    if (!Number.isInteger(result.total_count) || Number(result.total_count) < 0) {
      throw new Error("GitHub author open-PR search omitted a valid total_count");
    }
    return Number(result.total_count);
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
    abandonedPrAgeSkipReason,
    abandonedPrApplyBlockReasonSafe,
    authorPrBudgetApplyGateSafe,
    authorPrBudgetSignalBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReasonSafe,
    lowSignalUnmergeablePrApplyBlockReasonSafe,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    lowSignalUnmergeablePrConflictBlockReason,
    obsoleteFixPrApplyBlockReasonSafe,
    prAutoCloseExemptDecisionReason,
    prAutoCloseExemptLabel,
    pullRequestHeadActivity,
    staleVersionBugApplyBlockReasonSafe,
    stalledUnprovenPrAgeSkipReason,
    stalledUnprovenPrApplyBlockReasonSafe,
    stalledUnprovenProofRequestBlockReason,
    unconfirmedProductDirectionApplyBlockReasonSafe,
    unsponsoredFeatureApplyBlockReasonSafe,
  };
}
