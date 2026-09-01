import {
  BULK_FILED_LABEL,
  BULK_FILER_SEARCH_TIMEOUT_MS,
  DAY_MS,
  DEFAULT_AUTHOR_PR_BUDGET,
  DEFAULT_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
  DEFAULT_BULK_FILER_THRESHOLD,
  DEFAULT_BULK_FILER_WINDOW_DAYS,
  GOOD_FIRST_ISSUE_LABEL,
} from "./clawsweeper-policy.js";
import { createRelatedContext } from "./clawsweeper-related-context.js";
import {
  ensurePullRequestReviewHead,
  ensureReviewTreeCommit,
  githubReviewBlobSizes,
  hydratePullRequestReviewBlobs,
  hydratePullRequestReviewHistory,
  materializePullRequestReviewTree,
  removePullRequestReviewTree,
} from "./clawsweeper-review-blobs.js";
import {
  filterReviewComments,
  latestClawSweeperReview,
  latestClawSweeperReviewFromHydration,
  previousClawSweeperReviewFromComment,
  previousClawSweeperReviewDigest,
  timestampValueMs,
} from "./clawsweeper-review-comments.js";
import { truncateText } from "./clawsweeper-text.js";
import type {
  BulkFilerDetectionOptions,
  BulkFilerDetectionResult,
  BulkFilerRepositoryPermissionCache,
  ClosingPullRequestReference,
  ContextHydration,
  GoodFirstIssueHumanLabelState,
  Item,
  ItemKind,
  PreviousClawSweeperReview,
} from "./clawsweeper-types.js";
import { isGitHubNotFoundError } from "./github-retry.js";
import { type RepositoryProfile } from "./repository-profiles.js";
import { compareCodeUnits, stableJson } from "./stable-json.js";

interface CreateContextHydrationDependencies {
  asRecord: (value: unknown) => Record<string, unknown>;
  CLAWSWEEPER_BOT_AUTHORS: Set<string>;
  defaultClosedDir: (profile?: RepositoryProfile) => string;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  displayTitle: (title: string) => string;
  effectiveReviewStatus: (markdown: string) => string;
  fetchIssueReviewComments: (number: number) => Record<string, unknown>[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  ghJson: <T>(args: string[]) => T;
  ghJsonOnce: <T>(args: string[], timeoutMs: number) => T;
  githubCount: (value: unknown) => number | null;
  GitHubRuntimeBudgetError: new (reason: string) => Error & { readonly reason: string };
  isAutomationReportAuthor: (author: string | undefined) => boolean;
  isBulkFilerExemptAuthorAssociation: (value: unknown) => boolean;
  isMarkdownForActiveRepo: (markdown: string, file?: string) => boolean;
  isSafeGitBranchName: (branch: string) => boolean;
  labelNames: (value: unknown) => string[];
  login: (value: unknown) => string | undefined;
  markdownFiles: (dir: string) => string[];
  normalizeAuthorAssociation: (value: unknown) => string;
  normalizeLabelName: (label: string) => string;
  numberForMarkdownFile: (file: string) => number;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  repoRelativePath: (path: string) => string;
  reportUrl: (path?: string) => string;
  reviewCommentBodyDigest: (body: string) => string;
  reviewSectionValue: (
    markdown: string,
    section:
      | "summary"
      | "changeSummary"
      | "systemContext"
      | "architectureDiagram"
      | "bestSolution"
      | "maintainerDecision"
      | "reproductionAssessment"
      | "solutionAssessment"
      | "visionFit"
      | "rootCauseCluster"
      | "reviewFindings"
      | "securityReview"
      | "realBehaviorProof"
      | "prRating"
      | "telegramVisibleProof"
      | "mantisRecommendation"
      | "featureShowcase"
      | "agentsPolicyStatus"
      | "workCandidate"
      | "repairWorkPrompt"
      | "evidence"
      | "likelyOwners"
      | "risks"
      | "closeComment",
  ) => string;
  ROOT: string;
  stringOrUndefined: (value: unknown) => string | undefined;
  targetRepo: () => string;
}

export function createContextHydration(dependencies: CreateContextHydrationDependencies) {
  const {
    asRecord,
    CLAWSWEEPER_BOT_AUTHORS,
    defaultClosedDir,
    defaultItemsDir,
    displayTitle,
    effectiveReviewStatus,
    fetchIssueReviewComments,
    frontMatterValue,
    ghJson,
    ghJsonOnce,
    githubCount,
    GitHubRuntimeBudgetError,
    isAutomationReportAuthor,
    isBulkFilerExemptAuthorAssociation,
    isMarkdownForActiveRepo,
    isSafeGitBranchName,
    labelNames,
    login,
    markdownFiles,
    normalizeAuthorAssociation,
    normalizeLabelName,
    numberForMarkdownFile,
    replaceFrontMatterValue,
    repoRelativePath,
    reportUrl,
    reviewCommentBodyDigest,
    reviewSectionValue,
    ROOT,
    stringOrUndefined,
    targetRepo,
  } = dependencies;

  function compactMappedSlice<T>(
    items: readonly T[],
    limit: number,
    mapper: (item: T) => unknown,
  ): unknown[] {
    return compactMappedWindow(items, items.length, limit, mapper);
  }

  function compactMappedWindow<T>(
    items: readonly T[],
    total: number,
    limit: number,
    mapper: (item: T) => unknown,
  ): unknown[] {
    const boundedLimit = Math.max(0, Math.floor(limit));
    const boundedTotal = Math.max(0, Math.floor(total));
    if (boundedTotal <= boundedLimit && items.length <= boundedLimit) return items.map(mapper);
    if (boundedLimit === 0) {
      return boundedTotal > 0
        ? [{ omitted: boundedTotal, note: "middle entries omitted from prompt context" }]
        : [];
    }
    const keepStart = Math.floor(boundedLimit / 2);
    const keepEnd = Math.max(0, boundedLimit - keepStart);
    const retained =
      items.length > boundedLimit && boundedTotal === items.length
        ? items
        : items.slice(0, boundedLimit);
    const retainedStart = retained.slice(0, keepStart);
    const retainedEnd =
      keepEnd > 0 ? retained.slice(Math.max(keepStart, retained.length - keepEnd)) : [];
    const omitted = Math.max(0, boundedTotal - retainedStart.length - retainedEnd.length);
    return [
      ...retainedStart.map(mapper),
      ...(omitted > 0 ? [{ omitted, note: "middle entries omitted from prompt context" }] : []),
      ...retainedEnd.map(mapper),
    ];
  }

  function compactIssue(value: unknown): unknown {
    const issue = asRecord(value);
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      author: login(issue.user),
      authorAssociation: normalizeAuthorAssociation(issue.author_association),
      labels: labelNames(issue.labels),
      comments: issue.comments,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      body: truncateText(issue.body, 12000),
    };
  }

  function compactComment(value: unknown): unknown {
    const comment = asRecord(value);
    return {
      id: comment.id,
      author: login(comment.user),
      authorAssociation: normalizeAuthorAssociation(comment.author_association),
      url: comment.html_url,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      body: truncateText(comment.body, 6000),
    };
  }

  function isClawSweeperComment(value: unknown): boolean {
    return CLAWSWEEPER_BOT_AUTHORS.has((login(asRecord(value).user) ?? "").toLowerCase());
  }

  const reviewCommentContext = {
    isClawSweeperComment,
    reviewCommentBodyDigest,
  };

  function filterReviewContextComments(
    comments: readonly unknown[],
    number: number,
  ): { included: unknown[]; filtered: number } {
    return filterReviewComments(comments, number, reviewCommentContext);
  }

  function extractLatestClawSweeperReview(
    comments: readonly unknown[],
    number: number,
  ): PreviousClawSweeperReview | null {
    return latestClawSweeperReview(comments, number, reviewCommentContext);
  }

  function extractClawSweeperReviewCommentBody(body: string): PreviousClawSweeperReview {
    return previousClawSweeperReviewFromComment({ body }, reviewCommentContext);
  }

  function filterReviewContextCommentsForTest(
    comments: readonly unknown[],
    number: number,
  ): { included: unknown[]; filtered: number } {
    return filterReviewContextComments(comments, number);
  }

  function extractLatestClawSweeperReviewForTest(
    comments: readonly unknown[],
    number: number,
  ): PreviousClawSweeperReview | null {
    return extractLatestClawSweeperReview(comments, number);
  }

  function extractLatestClawSweeperReviewFromHydration(
    commentsWindow: ContextHydration<unknown>,
    completeComments: readonly unknown[],
    number: number,
  ): PreviousClawSweeperReview | null {
    return latestClawSweeperReviewFromHydration(
      commentsWindow,
      completeComments,
      number,
      reviewCommentContext,
    );
  }

  function extractLatestClawSweeperReviewFromHydrationForTest(
    commentsWindow: ContextHydration<unknown>,
    completeComments: readonly unknown[],
    number: number,
  ): PreviousClawSweeperReview | null {
    return extractLatestClawSweeperReviewFromHydration(commentsWindow, completeComments, number);
  }

  function previousClawSweeperReviewDigestFromReport(markdown: string): string | null {
    const digest = frontMatterValue(markdown, "review_comment_sha256")?.trim().toLowerCase();
    return digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
  }

  function liveClawSweeperReviewDigest(number: number): string | null {
    return previousClawSweeperReviewDigest(
      extractLatestClawSweeperReview(fetchIssueReviewComments(number), number),
    );
  }

  function previousClawSweeperReviewDigestFromReportForTest(
    markdown: string,
    _number: number,
  ): string | null {
    return previousClawSweeperReviewDigestFromReport(markdown);
  }

  function compactTimelineEvent(value: unknown): unknown {
    const event = asRecord(value);
    const sourceIssue = asRecord(asRecord(event.source).issue);
    return {
      id: event.id,
      event: event.event,
      createdAt: event.created_at,
      actor: login(event.actor),
      commitId: event.commit_id,
      label: asRecord(event.label).name,
      rename: event.rename,
      sourceIssue:
        Object.keys(sourceIssue).length > 0
          ? {
              number: sourceIssue.number,
              title: sourceIssue.title,
              url: sourceIssue.html_url,
              state: sourceIssue.state,
            }
          : undefined,
    };
  }

  function goodFirstIssueHumanLabelState(
    timeline: readonly unknown[],
  ): GoodFirstIssueHumanLabelState {
    const events = timeline
      .map((value) => {
        const event = asRecord(value);
        const labelValue = event.label;
        const label =
          typeof labelValue === "string"
            ? labelValue
            : (stringOrUndefined(asRecord(labelValue).name) ?? "");
        const actorValue = event.actor;
        const actor = typeof actorValue === "string" ? actorValue : (login(actorValue) ?? "");
        return {
          event: stringOrUndefined(event.event) ?? "",
          label: normalizeLabelName(label),
          actor: actor.toLowerCase(),
          createdAt:
            stringOrUndefined(event.createdAt) ?? stringOrUndefined(event.created_at) ?? "",
          id: Number(event.id ?? 0),
        };
      })
      .filter((event) => event.label === GOOD_FIRST_ISSUE_LABEL)
      .filter(
        (event) =>
          !isAutomationReportAuthor(event.actor) && !CLAWSWEEPER_BOT_AUTHORS.has(event.actor),
      )
      .sort(
        (left, right) =>
          timestampValueMs(left.createdAt) - timestampValueMs(right.createdAt) ||
          left.id - right.id,
      );
    const latest = events.at(-1);
    if (latest?.event === "unlabeled") return "removed";
    if (latest?.event === "labeled") return "added";
    return "unknown";
  }

  function goodFirstIssueLabelOptedOutForTest(timeline: readonly unknown[]): boolean {
    return goodFirstIssueHumanLabelState(timeline) === "removed";
  }

  function compactPullRequest(value: unknown): unknown {
    const pull = asRecord(value);
    const head = asRecord(pull.head);
    const base = asRecord(pull.base);
    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft,
      merged: pull.merged,
      mergedAt: pull.merged_at,
      mergeCommitSha: pull.merge_commit_sha,
      mergeable: pull.mergeable,
      mergeableState: pull.mergeable_state,
      author: login(pull.user),
      head: {
        ref: head.ref,
        sha: head.sha,
      },
      base: {
        ref: base.ref,
        sha: base.sha,
      },
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      body: truncateText(pull.body, 12000),
    };
  }

  function compactPullRequestForTest(value: unknown): unknown {
    return compactPullRequest(value);
  }

  function compactCheckRun(value: unknown): unknown {
    const check = asRecord(value);
    return {
      name: check.name ?? null,
      status: check.status ?? null,
      conclusion: check.conclusion ?? null,
      app: asRecord(check.app).slug ?? null,
    };
  }

  function compactCommitStatus(value: unknown): unknown {
    const status = asRecord(value);
    return {
      context: status.context ?? null,
      state: status.state ?? null,
      description: status.description ?? null,
    };
  }

  function pullChecksContext(number: number, headSha: string): unknown {
    try {
      const checkResponse = asRecord(
        ghJson<unknown>([
          "api",
          `repos/${targetRepo()}/commits/${headSha}/check-runs?per_page=100`,
        ]),
      );
      const statusResponse = asRecord(
        ghJson<unknown>([`api`, `repos/${targetRepo()}/commits/${headSha}/status?per_page=100`]),
      );
      const rawCheckRuns = Array.isArray(checkResponse.check_runs)
        ? checkResponse.check_runs
        : null;
      const rawStatuses = Array.isArray(statusResponse.statuses) ? statusResponse.statuses : null;
      const checkRunsTotal = githubCount(checkResponse.total_count);
      const statusesTotal = githubCount(statusResponse.total_count);
      if (!rawCheckRuns || !rawStatuses || checkRunsTotal === null || statusesTotal === null) {
        return {
          complete: false,
          checkRuns: [],
          checkRunsTruncated: true,
          statuses: [],
          statusesTruncated: true,
        };
      }
      const checkRunsTruncated = checkRunsTotal > rawCheckRuns.length || rawCheckRuns.length > 100;
      const statusesTruncated = statusesTotal > rawStatuses.length || rawStatuses.length > 100;
      // Order by code unit, not locale collation: these feed pullChecksDigest, and
      // localeCompare returns 0 for distinct strings, which would leave GitHub's
      // arbitrary response order in the digest.
      const checkRuns = rawCheckRuns
        .slice(0, 100)
        .map(compactCheckRun)
        .sort((left, right) => compareCodeUnits(stableJson(left), stableJson(right)));
      const statuses = rawStatuses
        .slice(0, 100)
        .map(compactCommitStatus)
        .sort((left, right) => compareCodeUnits(stableJson(left), stableJson(right)));
      return {
        complete: !checkRunsTruncated && !statusesTruncated,
        checkRuns,
        checkRunsTruncated,
        statuses,
        statusesTruncated,
      };
    } catch (error) {
      console.error(
        `[review] ${new Date().toISOString()} check-state=unavailable #${number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        complete: false,
        checkRuns: [],
        checkRunsTruncated: true,
        statuses: [],
        statusesTruncated: true,
      };
    }
  }

  function completePullChecksContext(value: unknown): boolean {
    const checks = asRecord(value);
    return (
      checks.complete === true &&
      checks.checkRunsTruncated !== true &&
      checks.statusesTruncated !== true &&
      Array.isArray(checks.checkRuns) &&
      Array.isArray(checks.statuses)
    );
  }

  function closingPullRequestReferenceTarget(
    reference: unknown,
    fallbackRepo = targetRepo(),
  ): ClosingPullRequestReference | null {
    const record = asRecord(reference);
    const number = record.number;
    if (typeof number !== "number" || !Number.isInteger(number)) return null;

    const repository = asRecord(record.repository);
    const owner = asRecord(repository.owner).login;
    const name = repository.name;
    const repo =
      typeof owner === "string" && typeof name === "string" ? `${owner}/${name}` : fallbackRepo;
    return { repo, number };
  }

  function closingPullRequestReferencesForIssue(number: number): ClosingPullRequestReference[] {
    const issue = ghJson<unknown>([
      "issue",
      "view",
      String(number),
      "--repo",
      targetRepo(),
      "--json",
      "closedByPullRequestsReferences",
    ]);
    const references = asRecord(issue).closedByPullRequestsReferences;
    if (!Array.isArray(references)) return [];
    return references
      .map((reference) => closingPullRequestReferenceTarget(reference))
      .filter((reference): reference is ClosingPullRequestReference => reference !== null);
  }

  function closingPullRequestsForIssue(number: number): unknown[] {
    const pullRequests: unknown[] = [];
    for (const reference of closingPullRequestReferencesForIssue(number)) {
      try {
        const pull = asRecord(
          ghJson<unknown>([
            "api",
            `repos/${reference.repo}/pulls/${reference.number}`,
            "--jq",
            "{number,title,state,html_url,body,user:{login:.user.login},merged:.merged,merged_at:.merged_at,merge_commit_sha:.merge_commit_sha,head:{ref:.head.ref,sha:.head.sha},base:{ref:.base.ref,sha:.base.sha}}",
          ]),
        );
        pullRequests.push({ ...pull, repo: reference.repo });
      } catch (error) {
        if (!isGitHubNotFoundError(error)) throw error;
        console.error(
          `Skipping missing closing PR ${reference.repo}#${reference.number} for #${number}`,
        );
      }
    }
    return pullRequests;
  }

  function openClosingPullRequestApplyReason(
    pullRequests: readonly unknown[],
    canPairClose?: (number: number, repo?: string) => boolean,
  ): string | null {
    const openPulls = pullRequests
      .map(asRecord)
      .filter((pull) => typeof pull.state === "string" && pull.state.toLowerCase() === "open")
      .map((pull) => ({
        number: typeof pull.number === "number" ? pull.number : null,
        repo: typeof pull.repo === "string" ? pull.repo : undefined,
        title: typeof pull.title === "string" ? pull.title : "",
      }))
      .filter(
        (pull): pull is { number: number; repo: string | undefined; title: string } =>
          pull.number !== null,
      )
      .filter((pull) => !canPairClose?.(pull.number, pull.repo));
    const first = openPulls[0];
    if (!first) return null;
    const suffix = openPulls.length > 1 ? ` and ${openPulls.length - 1} other open PR(s)` : "";
    return `open PR #${first.number}${first.title ? ` (${first.title})` : ""} is a closing reference${suffix}`;
  }

  const relatedContext = createRelatedContext({
    root: ROOT,
    targetRepo,
    reportUrl,
    defaultItemsDir,
    defaultClosedDir,
    isMarkdownForActiveRepo,
    gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
    ghJson,
    ghJsonOnce,
    asRecord,
    login,
    compactIssue,
    compactPullRequest,
    envFlagEnabled,
    envFlagDisabled,
    frontMatterValue,
    reviewSectionValue,
    effectiveReviewStatus,
    displayTitle: (title) => displayTitle(title),
    markdownFiles,
    numberForMarkdownFile,
    repoRelativePath,
  });

  const {
    compactReferencingMergedPullRequestForTest,
    referencingMergedPullRequestCandidatesForTest,
    referencingMergedPullRequestsForIssueForTest,
    relatedGitHubIssueSearchQueryForTest,
    relatedTitleSearchTerms,
  } = relatedContext;

  const {
    isDigitsOnly,
    quoteGitHubSearchTerm,
    referencingMergedPullRequestsForIssue,
    relatedItemsContext,
    structuralExternalRelationSensitivity,
  } = relatedContext;

  function envFlagEnabled(value: string | undefined): boolean {
    if (!value) return false;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  function envFlagDisabled(value: string | undefined): boolean {
    if (!value) return false;
    return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
  }

  function unconfirmedProductDirectionCloseEnabled(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return envFlagEnabled(env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED);
  }

  function unsponsoredFeatureCloseEnabled(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return envFlagEnabled(env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED);
  }

  function authorPrBudgetCloseEnabled(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return envFlagEnabled(env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED);
  }

  function staleVersionBugCloseEnabled(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return envFlagEnabled(env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED);
  }

  function obsoleteFixPrCloseEnabled(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return envFlagEnabled(env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED);
  }

  function positiveIntegerEnv(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function authorPrBudget(env: Record<string, string | undefined> = process.env): number {
    return positiveIntegerEnv(env.CLAWSWEEPER_AUTHOR_PR_BUDGET, DEFAULT_AUTHOR_PR_BUDGET);
  }

  function authorPrBudgetMaxClosesPerRun(
    env: Record<string, string | undefined> = process.env,
  ): number {
    return positiveIntegerEnv(
      env.CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
      DEFAULT_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN,
    );
  }

  function bulkFilerThreshold(env: Record<string, string | undefined> = process.env): number {
    return positiveIntegerEnv(env.CLAWSWEEPER_BULK_FILER_THRESHOLD, DEFAULT_BULK_FILER_THRESHOLD);
  }

  function bulkFilerWindowDays(env: Record<string, string | undefined> = process.env): number {
    return positiveIntegerEnv(
      env.CLAWSWEEPER_BULK_FILER_WINDOW_DAYS,
      DEFAULT_BULK_FILER_WINDOW_DAYS,
    );
  }

  function detectBulkFiler(options: BulkFilerDetectionOptions): BulkFilerDetectionResult {
    if (options.item.kind !== "issue" || !options.item.author.trim()) {
      return { context: null, labelPending: false, labelApplied: false };
    }
    if (isBulkFilerExemptAuthorAssociation(options.item.authorAssociation)) {
      return { context: null, labelPending: false, labelApplied: false };
    }
    const windowDays = bulkFilerWindowDays(options.env);
    const windowStartMs = options.now - windowDays * DAY_MS;
    const itemCreatedAtMs = Date.parse(options.item.createdAt);
    if (!Number.isFinite(itemCreatedAtMs) || itemCreatedAtMs <= windowStartMs) {
      return { context: null, labelPending: false, labelApplied: false };
    }
    const threshold = bulkFilerThreshold(options.env);
    const windowStart = new Date(windowStartMs).toISOString();
    const cacheKey = options.item.author.trim().toLowerCase();
    let issueCount = options.cache.get(cacheKey);
    if (!options.cache.has(cacheKey)) {
      try {
        const searchedCount = options.searchCount({
          author: options.item.author,
          windowStart,
        });
        if (!Number.isInteger(searchedCount) || searchedCount < 0) {
          throw new Error("GitHub bulk-filer search omitted a valid total_count");
        }
        issueCount = searchedCount;
      } catch (error) {
        issueCount = null;
        options.onSearchError?.(error);
      }
      options.cache.set(cacheKey, issueCount ?? null);
    }
    if (issueCount === undefined || issueCount === null || issueCount < threshold) {
      return { context: null, labelPending: false, labelApplied: false };
    }
    const alreadyLabeled = options.item.labels.some(
      (label) => label.toLowerCase() === BULK_FILED_LABEL,
    );
    return {
      context: {
        detected: true,
        issueCount,
        threshold,
        windowDays,
        windowStart,
        label: BULK_FILED_LABEL,
      },
      labelPending: !alreadyLabeled,
      labelApplied: false,
    };
  }

  function detectBulkFilerForTest(options: BulkFilerDetectionOptions): BulkFilerDetectionResult {
    return detectBulkFiler(options);
  }

  function updateBulkFilerDetectedFrontMatter(
    markdown: string,
    detection: BulkFilerDetectionResult,
  ): string {
    return replaceFrontMatterValue(
      markdown,
      "bulk_filer_detected",
      String(detection.context?.detected === true),
    );
  }

  function updateBulkFilerDetectedFrontMatterForTest(
    markdown: string,
    detection: BulkFilerDetectionResult,
  ): string {
    return updateBulkFilerDetectedFrontMatter(markdown, detection);
  }

  function bulkFilerPolicyInvalidatesCachedReview(
    markdown: string | null,
    exemptionApplied: boolean,
  ): boolean {
    if (!exemptionApplied || markdown === null) return false;
    // Legacy reports predate this field. Refresh them once rather than preserving
    // a possibly bulk-filer-suppressed cached verdict under the new exemption.
    return !/^false$/i.test(
      frontMatterValue(markdown, "last_full_review_bulk_filer_detected") ?? "",
    );
  }

  function bulkFilerPolicyInvalidatesCachedReviewForTest(
    markdown: string | null,
    exemptionApplied: boolean,
  ): boolean {
    return bulkFilerPolicyInvalidatesCachedReview(markdown, exemptionApplied);
  }

  function authorIssueCountInBulkFilerWindow(author: string, windowStart: string): number {
    const query = [
      `repo:${targetRepo()}`,
      "type:issue",
      `author:${quoteGitHubSearchTerm(author)}`,
      `created:>${windowStart}`,
    ].join(" ");
    const result = ghJsonOnce<{ total_count?: number; incomplete_results?: boolean }>(
      ["api", "search/issues", "--method", "GET", "-f", `q=${query}`, "-f", "per_page=1"],
      BULK_FILER_SEARCH_TIMEOUT_MS,
    );
    if (result.incomplete_results === true) {
      throw new Error("GitHub bulk-filer search returned incomplete results");
    }
    if (!Number.isInteger(result.total_count) || Number(result.total_count) < 0) {
      throw new Error("GitHub bulk-filer search omitted a valid total_count");
    }
    return Number(result.total_count);
  }

  function bulkFilerRepositoryPermission(
    author: string,
    cache: BulkFilerRepositoryPermissionCache,
  ): string | null {
    const normalizedAuthor = author.trim().toLowerCase();
    if (!normalizedAuthor) return null;
    if (cache.has(normalizedAuthor)) return cache.get(normalizedAuthor) ?? null;
    let permission: string | null = null;
    try {
      const result = ghJson<{
        permission?: unknown;
        role_name?: unknown;
        user?: { role_name?: unknown };
      }>([
        "api",
        `repos/${targetRepo()}/collaborators/${encodeURIComponent(normalizedAuthor)}/permission`,
      ]);
      const roleName = result.role_name ?? result.user?.role_name;
      permission =
        typeof roleName === "string"
          ? roleName.toLowerCase()
          : typeof result.permission === "string"
            ? result.permission.toLowerCase()
            : null;
    } catch {
      // A read-token lookup failure must not broaden the exemption.
      permission = null;
    }
    cache.set(normalizedAuthor, permission);
    return permission;
  }

  function normalizeAuthorLogin(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
  }

  function relatedCounterpartInfo(value: unknown): {
    number: number | null;
    kind: ItemKind | null;
    author: string | null;
    state: string;
    title: string;
  } {
    const record = asRecord(value);
    const localReport = asRecord(record.localReport);
    if (Object.keys(localReport).length > 0) {
      const kind =
        localReport.kind === "issue" || localReport.kind === "pull_request"
          ? localReport.kind
          : null;
      return {
        number: typeof localReport.number === "number" ? localReport.number : null,
        kind,
        author: normalizeAuthorLogin(localReport.author),
        state: localReport.location === "items" ? "open" : "closed",
        title: typeof localReport.title === "string" ? localReport.title : "",
      };
    }

    const issue = asRecord(record.issue);
    const pullRequest = asRecord(record.pullRequest);
    const isPullRequest = Object.keys(pullRequest).length > 0;
    const state = isPullRequest ? pullRequest.state : issue.state;
    return {
      number: typeof issue.number === "number" ? issue.number : null,
      kind: isPullRequest ? "pull_request" : "issue",
      author: normalizeAuthorLogin(isPullRequest ? pullRequest.author : issue.author),
      state: typeof state === "string" ? state.toLowerCase() : "",
      title: typeof issue.title === "string" ? issue.title : "",
    };
  }

  function itemKindLabel(kind: ItemKind): string {
    return kind === "pull_request" ? "PR" : "issue";
  }

  function pairCloseKey(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  function sameAuthorCounterpartApplyReason(
    item: Pick<Item, "number" | "kind" | "author">,
    relatedItems: readonly unknown[],
    canPairClose?: (number: number, kind: ItemKind) => boolean,
  ): string | null {
    const itemAuthor = normalizeAuthorLogin(item.author);
    if (!itemAuthor) return null;
    for (const relatedItem of relatedItems) {
      const related = relatedCounterpartInfo(relatedItem);
      if (related.number === null || related.number === item.number) continue;
      if (!related.kind || related.kind === item.kind) continue;
      if (related.state !== "open") continue;
      if (related.author !== itemAuthor) continue;
      if (canPairClose?.(related.number, related.kind)) continue;
      return `open ${itemKindLabel(related.kind)} #${related.number}${related.title ? ` (${related.title})` : ""} by the same author is paired with this ${itemKindLabel(item.kind)}`;
    }
    return null;
  }

  function compactPullFile(value: unknown): unknown {
    const file = asRecord(value);
    return {
      filename: file.filename,
      previous_filename: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: truncateText(file.patch, 2000),
    };
  }

  function hydratePullRequestReviewSource(options: {
    files: readonly unknown[];
    itemNumber: number;
    pullRequest: unknown;
    targetDir: string;
  }): void {
    const pull = asRecord(options.pullRequest);
    const base = asRecord(pull.base);
    const head = asRecord(pull.head);
    const baseSha = stringOrUndefined(base.sha) ?? "";
    const headSha = stringOrUndefined(head.sha) ?? "";
    const baseRef = stringOrUndefined(base.ref) ?? "";
    const commitsAvailable =
      isSafeGitBranchName(baseRef) &&
      ensureReviewTreeCommit({
        targetDir: options.targetDir,
        sha: baseSha,
        sourceRef: `refs/heads/${baseRef}`,
        destinationRef: `refs/clawsweeper/review-cache/base-${options.itemNumber}`,
      }) &&
      ensurePullRequestReviewHead({
        targetDir: options.targetDir,
        itemNumber: options.itemNumber,
        headSha,
      });

    if (commitsAvailable) {
      const testMergeSha =
        pull.merged === false && pull.state === "open"
          ? stringOrUndefined(pull.merge_commit_sha)
          : undefined;
      const mergeBaseSha = hydratePullRequestReviewHistory({
        targetDir: options.targetDir,
        baseSha,
        headSha,
        itemNumber: options.itemNumber,
        ...(testMergeSha ? { testMergeSha } : {}),
      });
      for (const revision of new Set([mergeBaseSha ?? baseSha, baseSha])) {
        const hydration = hydratePullRequestReviewBlobs({
          targetDir: options.targetDir,
          baseSha: revision,
          headSha,
          files: options.files,
          resolveBlobSizes: (objectIds) =>
            githubReviewBlobSizes({
              repository: targetRepo(),
              objectIds,
              request: (query) => ghJson(["api", "graphql", "-f", `query=${query}`]),
            }),
        });
        if (!hydration.hydrated) {
          console.warn("pull-request review blobs could not be hydrated before restricted review");
        }
      }
    }
  }

  function compactPullFilePaths(value: unknown): string[] {
    const file = asRecord(value);
    return [file.filename, file.previous_filename].filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
  }

  function compactPullCommit(value: unknown): unknown {
    const commit = asRecord(value);
    const commitInfo = asRecord(commit.commit);
    return {
      sha: commit.sha,
      author: login(commit.author),
      message: truncateText(commitInfo.message, 1000),
    };
  }

  return {
    authorIssueCountInBulkFilerWindow,
    authorPrBudget,
    authorPrBudgetCloseEnabled,
    authorPrBudgetMaxClosesPerRun,
    bulkFilerPolicyInvalidatesCachedReview,
    bulkFilerPolicyInvalidatesCachedReviewForTest,
    bulkFilerRepositoryPermission,
    bulkFilerThreshold,
    bulkFilerWindowDays,
    closingPullRequestReferenceTarget,
    closingPullRequestsForIssue,
    compactComment,
    compactIssue,
    compactMappedSlice,
    compactMappedWindow,
    compactPullCommit,
    compactPullFile,
    compactPullFilePaths,
    compactPullRequest,
    compactPullRequestForTest,
    compactReferencingMergedPullRequestForTest,
    compactTimelineEvent,
    completePullChecksContext,
    detectBulkFiler,
    detectBulkFilerForTest,
    extractLatestClawSweeperReview,
    extractClawSweeperReviewCommentBody,
    extractLatestClawSweeperReviewForTest,
    extractLatestClawSweeperReviewFromHydration,
    extractLatestClawSweeperReviewFromHydrationForTest,
    filterReviewContextComments,
    filterReviewContextCommentsForTest,
    goodFirstIssueHumanLabelState,
    goodFirstIssueLabelOptedOutForTest,
    isClawSweeperComment,
    isDigitsOnly,
    liveClawSweeperReviewDigest,
    obsoleteFixPrCloseEnabled,
    openClosingPullRequestApplyReason,
    pairCloseKey,
    previousClawSweeperReviewDigestFromReport,
    previousClawSweeperReviewDigestFromReportForTest,
    pullChecksContext,
    quoteGitHubSearchTerm,
    referencingMergedPullRequestCandidatesForTest,
    referencingMergedPullRequestsForIssue,
    referencingMergedPullRequestsForIssueForTest,
    relatedGitHubIssueSearchQueryForTest,
    relatedItemsContext,
    relatedTitleSearchTerms,
    sameAuthorCounterpartApplyReason,
    hydratePullRequestReviewSource,
    ensurePullRequestReviewHead,
    materializePullRequestReviewTree,
    removePullRequestReviewTree,
    staleVersionBugCloseEnabled,
    structuralExternalRelationSensitivity,
    unconfirmedProductDirectionCloseEnabled,
    unsponsoredFeatureCloseEnabled,
    updateBulkFilerDetectedFrontMatter,
    updateBulkFilerDetectedFrontMatterForTest,
  };
}
