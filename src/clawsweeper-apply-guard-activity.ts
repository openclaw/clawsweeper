import { isGitHubNotFoundError } from "./github-retry.js";
import {
  DAY_MS,
  LOW_SIGNAL_UNMERGEABLE_PR_MIN_INACTIVE_DAYS,
  PR_AUTO_CLOSE_EXEMPT_LABELS,
} from "./clawsweeper-policy.js";
import type { CloseReason, Item, PullRequestLiveActivity } from "./clawsweeper-types.js";
import {
  STALLED_UNPROVEN_PROOF_STATUSES,
  type ApplyGuardDependencies,
} from "./clawsweeper-apply-guard-dependencies.js";

export function createApplyGuardActivity(dependencies: ApplyGuardDependencies) {
  const {
    asRecord,
    ghJson,
    ghPaged,
    isMaintainerAuthorAssociation,
    isOlderThanDays,
    login,
    normalizeLabelName,
    quoteGitHubSearchTerm,
    reportPrRating,
    reportRealBehaviorProof,
    stringOrUndefined,
    targetRepo,
  } = dependencies;

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

  return {
    maintainerAssociatedEntries,
    lowSignalUnmergeablePrConflictBlockReason,
    githubActivityTimestampMs,
    githubActivityLogin,
    latestPullRequestAuthorActivityAtMs,
    lowSignalUnmergeablePrAuthorActivityBlockReason,
    issueRecentHumanCommentBlockReasonFromComments,
    issueRecentHumanCommentBlockReason,
    issueRecentHumanCommentBlockReasonSafe,
    pullRequestHumanEngagementBlockReason,
    FAILING_CHECK_RUN_CONCLUSIONS,
    pullRequestHeadActivity,
    pullRequestLiveActivity,
    prAutoCloseExemptLabel,
    prAutoCloseExemptDecisionReason,
    isWorkflowOrCiPath,
    githubContentsPath,
    defaultBranchPathMissing,
    authorPrBudgetSignalBlockReason,
    authorOpenPullRequestCount,
  };
}
