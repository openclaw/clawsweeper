import { UserFacingCommandError } from "./command.js";
import { DAY_MS, FRESH_DAYS } from "./clawsweeper-policy.js";
import type {
  DashboardActivityBucket,
  DashboardActivityStats,
  DashboardCadenceBucket,
  DashboardKindStats,
  DueCandidate,
  ExistingReview,
  ExistingReviewIndex,
  FailedReviewRetryState,
  GitHubIssueListItem,
  Item,
  OpenItemCounts,
  PlanCandidateResult,
  PlanSelectionTelemetry,
  PlanShard,
  RepoOpenCountsQuery,
} from "./clawsweeper-types.js";
import {
  isReviewedPrActivityCursor,
  readStableReviewedPrActivityCursor,
} from "./review-activity-cursor.js";
import { reviewStructuralPullStateDigest } from "./review-structural-cache.js";
import {
  HOT_INTAKE_FRESHNESS_MS,
  appendFloorBackfillCandidates,
  compareDueCandidates,
  compareHotIntakeDueCandidates,
  hasReviewPolicyMismatch,
  nextReviewDueAtMs,
  reviewPriority,
  reviewedAtMs,
  schedulerBucket,
  selectDueCandidates,
  shouldReviewItem,
} from "./scheduler-policy.js";

interface ReviewPlanningDependencies {
  maxPlanShardCount: number;
  targetRepo: () => string;
  ghJson: <T>(args: string[]) => T;
  ghJsonLines: <T>(args: string[]) => T[];
  fetchReviewedPrActivityCursor: (
    number: number,
    prefetchedInlineComments?: unknown[],
  ) => string | null;
  ghPaged: <T>(path: string) => T[];
  githubCount: (value: unknown) => number | null;
  itemSourceRevisionSha256: (issue: unknown, comments?: unknown[]) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
  normalizeAuthorAssociation: (value: unknown) => string;
  shouldPlanItem: (item: Pick<Item, "authorAssociation" | "labels">) => boolean;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  buildExistingReviewIndex: (itemsDir: string) => ExistingReviewIndex;
  indexedExistingReview: (
    item: Pick<Item, "number" | "repo">,
    itemsDir: string,
    reviewIndex?: ExistingReviewIndex,
  ) => ExistingReview | null;
  effectiveReviewStatus: (markdown: string) => string;
  stringOrUndefined: (value: unknown) => string | undefined;
  pullHeadShaFromReport: (markdown: string) => string | null;
  failedReviewRetryStatePath: (stateDir: string, number: number) => string;
  readFailedReviewRetryState: (statePath: string) => FailedReviewRetryState | null;
  failedReviewRetryMarkdownWithState: (
    markdown: string,
    state: FailedReviewRetryState | null,
  ) => string;
  repoRelativePath: (filePath: string) => string;
  dashboardClosedAt: (markdown: string) => string | undefined;
}

export function createReviewPlanning({
  maxPlanShardCount: MAX_PLAN_SHARD_COUNT,
  targetRepo,
  ghJson,
  ghJsonLines,
  fetchReviewedPrActivityCursor,
  ghPaged,
  githubCount,
  itemSourceRevisionSha256,
  asRecord,
  normalizeAuthorAssociation,
  shouldPlanItem,
  frontMatterValue,
  buildExistingReviewIndex,
  indexedExistingReview,
  effectiveReviewStatus,
  stringOrUndefined,
  pullHeadShaFromReport,
  failedReviewRetryStatePath,
  readFailedReviewRetryState,
  failedReviewRetryMarkdownWithState,
  repoRelativePath,
  dashboardClosedAt,
}: ReviewPlanningDependencies) {
  function isFresh(
    review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
  ): boolean {
    if (review?.reviewStatus !== "complete") return false;
    if (!review?.reviewedAt) return false;
    const reviewedAt = Date.parse(review.reviewedAt);
    if (!Number.isFinite(reviewedAt)) return false;
    return Date.now() - reviewedAt < FRESH_DAYS * DAY_MS;
  }

  function isCurrentForCadence(options: {
    reviewedAt: string | undefined;
    reviewStatus: string | undefined;
    cadenceMs: number;
    now: number;
  }): boolean {
    if (options.reviewStatus !== "complete") return false;
    if (!options.reviewedAt) return false;
    const reviewedAt = Date.parse(options.reviewedAt);
    if (!Number.isFinite(reviewedAt)) return false;
    return options.now - reviewedAt < options.cadenceMs;
  }

  function dueCandidate(
    item: Item,
    itemsDir: string,
    now = Date.now(),
    reviewPolicy?: string,
    reviewIndex?: ExistingReviewIndex,
    coverageTrackedItemIds?: ReadonlySet<number>,
  ): DueCandidate | null {
    const review = indexedExistingReview(item, itemsDir, reviewIndex);
    const coverageTracked = coverageTrackedItemIds
      ? coverageTrackedItemIds.has(item.number)
      : review !== null;
    if (coverageTracked && !shouldReviewItem(item, review, now, reviewPolicy)) return null;
    return {
      item,
      review,
      coverageTracked,
      priority: reviewPriority(item, review, now, reviewPolicy),
      reviewedAt: reviewedAtMs(review) ?? 0,
      nextDueAt: coverageTracked ? nextReviewDueAtMs(item, review, now, reviewPolicy) : 0,
      bucket: schedulerBucket(item, review, now),
    };
  }

  type HotIntakeExactReviewSnapshot = {
    headSha: string;
    sourceRevision: string;
    pullStateDigest: string;
    reviewActivityCursor: string;
    itemUpdatedAt: string;
  };

  function hotIntakeExactReviewSnapshotFromReport(
    review: ExistingReview | null,
    now: number,
  ): HotIntakeExactReviewSnapshot | null {
    if (review?.reviewStatus !== "complete" || !review.reviewedAt) return null;
    const reviewedAt = Date.parse(review.reviewedAt);
    if (
      !Number.isFinite(reviewedAt) ||
      now < reviewedAt ||
      now - reviewedAt >= HOT_INTAKE_FRESHNESS_MS
    ) {
      return null;
    }
    const headSha = pullHeadShaFromReport(review.markdown)?.toLowerCase();
    const sourceRevision = review.itemSourceRevision?.trim();
    const pullStateDigest = frontMatterValue(review.markdown, "reviewed_pull_state_digest");
    const reviewActivityCursor = frontMatterValue(review.markdown, "review_activity_cursor");
    const itemUpdatedAt = review.itemUpdatedAt?.trim();
    if (
      !headSha ||
      !sourceRevision ||
      sourceRevision === "unknown" ||
      !pullStateDigest ||
      pullStateDigest === "unknown" ||
      pullStateDigest === "none" ||
      !isReviewedPrActivityCursor(reviewActivityCursor) ||
      !itemUpdatedAt
    ) {
      return null;
    }
    return { headSha, sourceRevision, pullStateDigest, reviewActivityCursor, itemUpdatedAt };
  }

  function currentHotIntakePullReviewSnapshot(item: Item): HotIntakeExactReviewSnapshot | null {
    try {
      const reviewActivityCursor = readStableReviewedPrActivityCursor(() =>
        fetchReviewedPrActivityCursor(item.number),
      );
      if (!reviewActivityCursor) return null;
      const comments = ghPaged<unknown>(`repos/${item.repo}/issues/${item.number}/comments`);
      const pull = ghJson<unknown>(["api", `repos/${item.repo}/pulls/${item.number}`]);
      const source = asRecord(pull);
      const headSha = stringOrUndefined(asRecord(source.head).sha)?.trim().toLowerCase();
      if (!headSha) return null;
      const itemUpdatedAt = stringOrUndefined(source.updated_at)?.trim();
      if (!itemUpdatedAt) return null;
      const baseSha = stringOrUndefined(asRecord(source.base).sha)?.trim().toLowerCase();
      const draft = source.draft;
      const mergeable = source.mergeable;
      const mergeStateStatus = stringOrUndefined(source.mergeable_state);
      const additions = githubCount(source.additions);
      const deletions = githubCount(source.deletions);
      const changedFiles = githubCount(source.changed_files);
      const commitCount = githubCount(source.commits);
      if (
        !baseSha ||
        typeof draft !== "boolean" ||
        (mergeable !== null && typeof mergeable !== "boolean" && typeof mergeable !== "string") ||
        !mergeStateStatus ||
        additions === null ||
        deletions === null ||
        changedFiles === null ||
        commitCount === null
      ) {
        return null;
      }
      const pullStateDigest = reviewStructuralPullStateDigest({
        headSha,
        baseSha,
        draft,
        mergeable,
        mergeStateStatus,
        additions,
        deletions,
        changedFiles,
        commitCount,
      });
      if (!pullStateDigest) return null;
      const revalidatedReviewActivityCursor = readStableReviewedPrActivityCursor(() =>
        fetchReviewedPrActivityCursor(item.number),
      );
      if (revalidatedReviewActivityCursor !== reviewActivityCursor) return null;
      return {
        headSha,
        sourceRevision: itemSourceRevisionSha256(pull, comments),
        pullStateDigest,
        reviewActivityCursor,
        itemUpdatedAt,
      };
    } catch (error) {
      console.error(
        `[plan] unable to verify fresh exact-review snapshot for ${item.repo}#${item.number}; leaving it eligible: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  function hasUncapturedActivitySinceExactReview(item: Item, review: ExistingReview): boolean {
    const updatedAt = Date.parse(item.updatedAt);
    const reviewedAt = review.reviewedAt ? Date.parse(review.reviewedAt) : Number.NaN;
    if (!Number.isFinite(updatedAt) || !Number.isFinite(reviewedAt)) return true;
    if (review.itemUpdatedAt && item.updatedAt === review.itemUpdatedAt) return false;
    if (updatedAt <= reviewedAt) return false;
    const reviewCommentSyncedAt = review.reviewCommentSyncedAt
      ? Date.parse(review.reviewCommentSyncedAt)
      : Number.NaN;
    const labelsSyncedAt = review.labelsSyncedAt ? Date.parse(review.labelsSyncedAt) : Number.NaN;
    const botOwnedSyncedAt = Math.max(
      Number.isFinite(reviewCommentSyncedAt) ? reviewCommentSyncedAt : -Infinity,
      Number.isFinite(labelsSyncedAt) ? labelsSyncedAt : -Infinity,
    );
    return !Number.isFinite(botOwnedSyncedAt) || updatedAt > botOwnedSyncedAt;
  }

  function shouldSkipScheduledHotIntakeExactReview(
    item: Item,
    review: ExistingReview | null,
    now: number,
    reviewPolicy: string,
  ): boolean {
    if (item.kind !== "pull_request") return false;
    if (hasReviewPolicyMismatch(review, reviewPolicy)) return false;
    if (!review || hasUncapturedActivitySinceExactReview(item, review)) return false;
    const reviewed = hotIntakeExactReviewSnapshotFromReport(review, now);
    if (!reviewed) return false;
    const current = currentHotIntakePullReviewSnapshot(item);
    return (
      current !== null &&
      (current.itemUpdatedAt === reviewed.itemUpdatedAt ||
        !hasUncapturedActivitySinceExactReview(
          { ...item, updatedAt: current.itemUpdatedAt },
          review,
        )) &&
      current.headSha === reviewed.headSha &&
      current.sourceRevision === reviewed.sourceRevision &&
      current.pullStateDigest === reviewed.pullStateDigest &&
      current.reviewActivityCursor === reviewed.reviewActivityCursor
    );
  }

  function shouldSkipScheduledHotIntakeExactReviewForTest(options: {
    reviewStatus?: string;
    reviewedAt?: string;
    reviewHeadSha?: string;
    reviewSourceRevision?: string;
    reviewPullStateDigest?: string;
    reviewActivityCursor?: string;
    currentHeadSha?: string;
    currentSourceRevision?: string;
    currentPullStateDigest?: string;
    currentReviewActivityCursor?: string;
    currentItemUpdatedAt?: string;
    itemUpdatedAt?: string;
    reviewItemUpdatedAt?: string;
    reviewCommentSyncedAt?: string;
    labelsSyncedAt?: string;
    reviewPolicy?: string;
    currentReviewPolicy?: string;
    now: number;
  }): boolean {
    const review = {
      reviewStatus: options.reviewStatus,
      reviewedAt: options.reviewedAt,
      markdown: `---\npull_head_sha: ${options.reviewHeadSha ?? "unknown"}\nreviewed_pull_state_digest: ${options.reviewPullStateDigest ?? "unknown"}\nreview_activity_cursor: ${options.reviewActivityCursor ?? "unknown"}\n---\n`,
      itemSourceRevision: options.reviewSourceRevision,
      reviewPolicy: options.reviewPolicy,
      itemUpdatedAt: options.reviewItemUpdatedAt,
      reviewCommentSyncedAt: options.reviewCommentSyncedAt,
      labelsSyncedAt: options.labelsSyncedAt,
    } as ExistingReview;
    if (hasReviewPolicyMismatch(review, options.currentReviewPolicy)) return false;
    const item = {
      kind: "pull_request",
      updatedAt: options.itemUpdatedAt ?? options.reviewedAt ?? "",
    } as Item;
    if (hasUncapturedActivitySinceExactReview(item, review)) return false;
    const reviewed = hotIntakeExactReviewSnapshotFromReport(review, options.now);
    if (
      !reviewed ||
      !options.currentHeadSha ||
      !options.currentSourceRevision ||
      !options.currentPullStateDigest ||
      !options.currentReviewActivityCursor ||
      !options.currentItemUpdatedAt
    ) {
      return false;
    }
    return (
      (options.currentItemUpdatedAt === reviewed.itemUpdatedAt ||
        !hasUncapturedActivitySinceExactReview(
          { kind: "pull_request", updatedAt: options.currentItemUpdatedAt } as Item,
          review,
        )) &&
      reviewed.headSha === options.currentHeadSha.trim().toLowerCase() &&
      reviewed.sourceRevision === options.currentSourceRevision.trim() &&
      reviewed.pullStateDigest === options.currentPullStateDigest.trim() &&
      reviewed.reviewActivityCursor === options.currentReviewActivityCursor.trim()
    );
  }

  function reviewBackfillCandidate(
    item: Item,
    itemsDir: string,
    now = Date.now(),
    reviewPolicy?: string,
    minReviewAgeMs = 0,
    reviewIndex?: ExistingReviewIndex,
  ): DueCandidate | null {
    const review = indexedExistingReview(item, itemsDir, reviewIndex);
    if (!review || hasReviewPolicyMismatch(review, reviewPolicy)) return null;
    const reviewedAt = reviewedAtMs(review);
    if (reviewedAt === null) return null;
    if (now - reviewedAt < minReviewAgeMs) return null;
    if (shouldReviewItem(item, review, now, reviewPolicy)) return null;
    return {
      item,
      review,
      priority: reviewPriority(item, review, now, reviewPolicy),
      reviewedAt,
      nextDueAt: nextReviewDueAtMs(item, review, now, reviewPolicy),
      bucket: schedulerBucket(item, review, now),
    };
  }

  function fetchOpenItemPage(
    page: number,
    sort: "created" | "updated" = "created",
    direction: "asc" | "desc" = "asc",
  ): Item[] {
    const items = ghJsonLines<GitHubIssueListItem>([
      "api",
      `repos/${targetRepo()}/issues?state=open&sort=${sort}&direction=${direction}&per_page=100&page=${page}`,
      "--jq",
      ".[] | {number,title,html_url,created_at,updated_at,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
    ]);
    return items
      .map((item) => ({
        repo: targetRepo(),
        number: item.number,
        kind: item.pull_request ? ("pull_request" as const) : ("issue" as const),
        title: item.title,
        url: item.html_url,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        author: item.user?.login ?? "unknown",
        authorAssociation: normalizeAuthorAssociation(item.author_association),
        labels: item.labels ?? [],
      }))
      .sort((a, b) => a.number - b.number);
  }

  function fetchOpenItems(maxPages: number): {
    items: Item[];
    pagesScanned: number;
    complete: boolean;
  } {
    const items: Item[] = [];
    let pagesScanned = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const pageItems = fetchOpenItemPage(page);
      pagesScanned = page;
      items.push(...pageItems);
      if (pageItems.length === 0 || pageItems.length < 100) {
        return { items, pagesScanned, complete: true };
      }
    }
    return { items, pagesScanned, complete: false };
  }

  function fetchHotIntakeItems(maxPages: number): { items: Item[]; pagesScanned: number } {
    const byNumber = new Map<number, Item>();
    let pagesScanned = 0;
    for (const sort of ["created", "updated"] as const) {
      for (let page = 1; page <= maxPages; page += 1) {
        const pageItems = fetchOpenItemPage(page, sort, "desc");
        pagesScanned = Math.max(pagesScanned, page);
        for (const item of pageItems) byNumber.set(item.number, item);
        if (pageItems.length === 0 || pageItems.length < 100) break;
      }
    }
    return {
      items: [...byNumber.values()].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.number - left.number,
      ),
      pagesScanned,
    };
  }

  function fetchOpenItemNumbers(maxPages: number): { numbers: Set<number>; pagesScanned: number } {
    const result = fetchOpenItems(maxPages);
    if (!result.complete) {
      throw new Error(
        `Open item scan reached max_pages=${maxPages} before the final page; refusing to reconcile folders from a partial scan.`,
      );
    }
    return {
      numbers: new Set(result.items.map((item) => item.number)),
      pagesScanned: result.pagesScanned,
    };
  }

  function fetchItem(number: number): { item: Item; state: string } {
    const issue = ghJson<
      GitHubIssueListItem & {
        active_lock_reason?: string | null;
        locked?: boolean;
        state?: string;
      }
    >([
      "api",
      `repos/${targetRepo()}/issues/${number}`,
      "--jq",
      "{number,title,html_url,created_at,updated_at,closed_at,state,locked,active_lock_reason,author_association,user:{login:.user.login},labels:[.labels[].name],pull_request:(.pull_request // null)}",
    ]);
    return {
      item: {
        repo: targetRepo(),
        number: issue.number,
        kind: issue.pull_request ? "pull_request" : "issue",
        title: issue.title,
        url: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at,
        author: issue.user?.login ?? "unknown",
        authorAssociation: normalizeAuthorAssociation(issue.author_association),
        labels: issue.labels ?? [],
        locked: issue.locked === true,
        activeLockReason: issue.active_lock_reason ?? null,
      },
      state: issue.state ?? "unknown",
    };
  }

  function fetchOpenItemCounts(): OpenItemCounts {
    const [owner, name] = targetRepo().split("/");
    if (!owner || !name) throw new Error(`Invalid target repo: ${targetRepo()}`);
    const result = ghJson<RepoOpenCountsQuery>([
      "api",
      "graphql",
      "-f",
      `query=query { repository(owner: "${owner}", name: "${name}") { issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } } }`,
    ]);
    const repository = result.data?.repository;
    const issues = repository?.issues?.totalCount ?? 0;
    const pullRequests = repository?.pullRequests?.totalCount ?? 0;
    return {
      issues,
      pullRequests,
      total: issues + pullRequests,
    };
  }

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

  function selectCandidates(options: {
    batchSize: number;
    maxPages: number;
    shardIndex: number;
    shardCount: number;
    itemsDir: string;
    itemNumber?: number;
    itemNumbers?: number[];
    reviewPolicy?: string;
    hotIntake?: boolean;
    // Local-review extension: review closed/merged items too (fixtures, hypothetical
    // re-review). Default false preserves the open-only rule for normal operation.
    allowClosed?: boolean;
  }): { candidates: Item[]; scannedPages: number } {
    if (options.itemNumbers) {
      const candidates = options.itemNumbers.flatMap((number) => {
        const { item, state } = fetchItem(number);
        return state === "open" || options.allowClosed ? [item] : [];
      });
      return { candidates, scannedPages: 0 };
    }
    if (options.itemNumber) {
      if (options.shardIndex !== 0) return { candidates: [], scannedPages: 0 };
      const { item, state } = fetchItem(options.itemNumber);
      if (state !== "open" && !options.allowClosed) return { candidates: [], scannedPages: 0 };
      return { candidates: [item], scannedPages: 0 };
    }
    const due: DueCandidate[] = [];
    const now = Date.now();
    const reviewIndex = buildExistingReviewIndex(options.itemsDir);
    if (options.hotIntake) {
      const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
      for (const item of items) {
        if (item.number % options.shardCount !== options.shardIndex) continue;
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
        );
        if (candidate) due.push(candidate);
      }
      const candidates = selectDueCandidates(
        due,
        options.batchSize,
        compareHotIntakeDueCandidates,
      ).map(({ item }) => item);
      return { candidates, scannedPages: pagesScanned };
    }
    let scannedPages = 0;
    for (let page = 1; page <= options.maxPages; page += 1) {
      const items = fetchOpenItemPage(page);
      scannedPages = page;
      if (items.length === 0) break;
      for (const item of items) {
        if (item.number % options.shardCount !== options.shardIndex) continue;
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
        );
        if (candidate) due.push(candidate);
      }
    }
    const candidates = selectDueCandidates(due, options.batchSize)
      .slice(0, options.batchSize)
      .map(({ item }) => item);
    return { candidates, scannedPages };
  }

  function exactLocalReviewNoCandidateError(
    itemNumber: number | undefined,
    shardIndex: number,
  ): UserFacingCommandError {
    if (itemNumber === undefined) {
      return new UserFacingCommandError("No review was run because no item number was provided.");
    }
    if (shardIndex !== 0) {
      return new UserFacingCommandError(
        `No review was run for ${targetRepo()}#${itemNumber} because exact item reviews only run on shard 0. Remove --shard-index for local reviews.`,
      );
    }
    try {
      const { item, state } = fetchItem(itemNumber);
      if (state !== "open") {
        return new UserFacingCommandError(
          `No review was run for ${targetRepo()}#${itemNumber} because GitHub reports this ${item.kind === "pull_request" ? "PR" : "issue"} is ${state}. Local exact review only reviews open items.`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new UserFacingCommandError(
        `No review was run for ${targetRepo()}#${itemNumber} because the item could not be loaded from GitHub. If this is a different repository, pass --target-repo owner/name. ${reason}`,
      );
    }
    return new UserFacingCommandError(
      `No review was run for ${targetRepo()}#${itemNumber}. The item was not selected for review.`,
    );
  }

  function openExplicitItems(itemNumbers: readonly number[]): Item[] {
    const seen = new Set<number>();
    const candidates: Item[] = [];
    for (const number of itemNumbers) {
      if (seen.has(number)) continue;
      seen.add(number);
      const { item, state } = fetchItem(number);
      if (state === "open") candidates.push(item);
    }
    return candidates;
  }

  function planShardCount(shardCount: number): number {
    if (!Number.isFinite(shardCount)) return 1;
    return Math.max(1, Math.min(MAX_PLAN_SHARD_COUNT, Math.floor(shardCount)));
  }

  function shardItemNumbers(itemNumbers: readonly number[], shardCount: number): PlanShard[] {
    const count = Math.max(1, Math.min(planShardCount(shardCount), itemNumbers.length || 1));
    const shards = Array.from({ length: count }, (_, shard) => ({
      shard,
      itemNumbers: [] as number[],
    }));
    itemNumbers.forEach((number, index) => {
      shards[index % shards.length]?.itemNumbers.push(number);
    });
    return shards;
  }

  function activeCodexTarget(shards: readonly PlanShard[]): number {
    return shards.filter((shard) => shard.itemNumbers.length > 0).length;
  }

  function oldestUnreviewedAt(candidates: readonly DueCandidate[]): string | undefined {
    let oldest: string | undefined;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const coverageTracked =
        candidate.coverageTracked === undefined
          ? candidate.review !== null
          : candidate.coverageTracked;
      if (coverageTracked) continue;
      const createdAtMs = Date.parse(candidate.item.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs >= oldestMs) continue;
      oldestMs = createdAtMs;
      oldest = candidate.item.createdAt;
    }
    return oldest;
  }

  function planCapacityReason(options: {
    selectedCount: number;
    dueBacklog: number;
    capacity: number;
    exact?: boolean;
    activeFloor?: number;
    floorBackfill?: number;
  }): string {
    if (options.exact) {
      return options.selectedCount === 0
        ? "idle: no requested open items found"
        : "exact: requested item selection";
    }
    if ((options.floorBackfill ?? 0) > 0) {
      return `floor: due backlog below active floor; filled ${options.floorBackfill} stale current item(s)`;
    }
    if ((options.activeFloor ?? 0) > 0 && options.selectedCount < (options.activeFloor ?? 0)) {
      return `under floor: only ${options.selectedCount} eligible item(s) found for active floor ${options.activeFloor}`;
    }
    if (options.selectedCount === 0) return "idle: no due candidates found";
    if (options.dueBacklog >= options.capacity)
      return "saturated: due backlog filled planned capacity";
    return "under capacity: due backlog below planned capacity";
  }

  function planSelectionTelemetry(
    selected: readonly DueCandidate[],
    now: number,
  ): PlanSelectionTelemetry[] {
    return selected.map((candidate) => {
      const createdAt = Date.parse(candidate.item.createdAt);
      const referenceAt = candidate.reviewedAt > 0 ? candidate.reviewedAt : createdAt;
      return {
        itemNumber: candidate.item.number,
        bucket: candidate.bucket,
        coverageTracked:
          candidate.coverageTracked === undefined
            ? candidate.review !== null
            : candidate.coverageTracked,
        lastReviewedAt: candidate.review?.reviewedAt ?? null,
        ageMs: Number.isFinite(referenceAt) ? Math.max(0, now - referenceAt) : 0,
        nextDueAt: new Date(candidate.nextDueAt).toISOString(),
      };
    });
  }

  function planCandidates(options: {
    batchSize: number;
    maxPages: number;
    shardCount: number;
    itemsDir: string;
    itemNumber?: number;
    itemNumbers?: number[];
    reviewPolicy: string;
    hotIntake?: boolean;
    minimumActiveShards?: number;
    minimumBackfillReviewAgeMs?: number;
    coverageTrackedItemIds?: ReadonlySet<number>;
  }): PlanCandidateResult {
    const shardCount = planShardCount(options.shardCount);
    const batchSize = Math.max(1, options.batchSize);
    const capacity = batchSize * shardCount;
    const activeFloor =
      options.hotIntake || options.itemNumber || options.itemNumbers
        ? 0
        : Math.max(0, Math.min(capacity, Math.floor(options.minimumActiveShards ?? 0)));
    const minimumBackfillReviewAgeMs = Math.max(0, options.minimumBackfillReviewAgeMs ?? 0);
    if (options.itemNumbers) {
      const candidates = openExplicitItems(options.itemNumbers);
      const shards = shardItemNumbers(
        candidates.map((item) => item.number),
        shardCount,
      );
      return {
        shards,
        scannedPages: 0,
        candidates,
        capacity,
        dueBacklog: candidates.length,
        activeCodexTarget: activeCodexTarget(shards),
        oldestUnreviewedAt: undefined,
        floorBackfill: 0,
        selection: [],
        capacityReason: planCapacityReason({
          selectedCount: candidates.length,
          dueBacklog: candidates.length,
          capacity,
          exact: true,
        }),
      };
    }
    if (options.itemNumber) {
      const { item, state } = fetchItem(options.itemNumber);
      const shouldReview = state === "open";
      const candidates = shouldReview ? [item] : [];
      const shards = [{ shard: 0, itemNumbers: shouldReview ? [item.number] : [] }];
      return {
        shards,
        scannedPages: 0,
        candidates,
        capacity,
        dueBacklog: candidates.length,
        activeCodexTarget: activeCodexTarget(shards),
        oldestUnreviewedAt: undefined,
        floorBackfill: 0,
        selection: [],
        capacityReason: planCapacityReason({
          selectedCount: candidates.length,
          dueBacklog: candidates.length,
          capacity,
          exact: true,
        }),
      };
    }

    const due: DueCandidate[] = [];
    const now = Date.now();
    const reviewIndex = buildExistingReviewIndex(options.itemsDir);
    if (options.hotIntake) {
      const { items, pagesScanned } = fetchHotIntakeItems(options.maxPages);
      for (const item of items) {
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
          options.coverageTrackedItemIds,
        );
        if (
          candidate &&
          !shouldSkipScheduledHotIntakeExactReview(
            item,
            candidate.review,
            now,
            options.reviewPolicy,
          )
        ) {
          due.push(candidate);
        }
      }
      const selected = selectDueCandidates(due, capacity, compareHotIntakeDueCandidates, now);
      const candidates = selected.map(({ item }) => item);
      const shards = Array.from(
        { length: Math.max(1, Math.min(shardCount, candidates.length || 1)) },
        (_, shard) => ({ shard, itemNumbers: [] as number[] }),
      );
      candidates.forEach((item, index) => {
        shards[index % shards.length]?.itemNumbers.push(item.number);
      });
      return {
        shards,
        scannedPages: pagesScanned,
        candidates,
        capacity,
        dueBacklog: due.length,
        activeCodexTarget: activeCodexTarget(shards),
        oldestUnreviewedAt: oldestUnreviewedAt(due),
        floorBackfill: 0,
        selection: planSelectionTelemetry(selected, now),
        capacityReason: planCapacityReason({
          selectedCount: candidates.length,
          dueBacklog: due.length,
          capacity,
        }),
      };
    }
    let scannedPages = 0;
    const backfill: DueCandidate[] = [];
    for (let page = 1; page <= options.maxPages; page += 1) {
      const items = fetchOpenItemPage(page);
      scannedPages = page;
      if (items.length === 0) break;
      for (const item of items) {
        if (!shouldPlanItem(item)) continue;
        const candidate = dueCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          reviewIndex,
          options.coverageTrackedItemIds,
        );
        if (candidate) {
          due.push(candidate);
          continue;
        }
        if (activeFloor <= 0) continue;
        const fallback = reviewBackfillCandidate(
          item,
          options.itemsDir,
          now,
          options.reviewPolicy,
          minimumBackfillReviewAgeMs,
          reviewIndex,
        );
        if (fallback) backfill.push(fallback);
      }
    }
    const selected = appendFloorBackfillCandidates(
      selectDueCandidates(due, capacity, compareDueCandidates, now),
      backfill,
      {
        activeFloor,
        capacity,
      },
    );
    const floorBackfill = selected.filter((candidate) => !due.includes(candidate)).length;
    const candidates = selected.map(({ item }) => item);
    const shards = shardItemNumbers(
      candidates.map((item) => item.number),
      shardCount,
    );

    return {
      shards,
      scannedPages,
      candidates,
      capacity,
      dueBacklog: due.length,
      activeCodexTarget: activeCodexTarget(shards),
      oldestUnreviewedAt: oldestUnreviewedAt(due),
      floorBackfill,
      selection: planSelectionTelemetry(selected, now),
      capacityReason: planCapacityReason({
        selectedCount: candidates.length,
        dueBacklog: due.length,
        capacity,
        activeFloor,
        floorBackfill,
      }),
    };
  }

  return {
    dashboardFailedReviewRetryActivityForTest,
    shardItemNumbers,
    shouldSkipScheduledHotIntakeExactReviewForTest,
    addDashboardCadenceBucket,
    capDashboardCadenceBucket,
    dashboardMarkdownWithFailedReviewRetryState,
    emptyDashboardActivityStats,
    emptyDashboardCadenceBucket,
    emptyDashboardKindStats,
    exactLocalReviewNoCandidateError,
    fetchItem,
    fetchOpenItemCounts,
    fetchOpenItemNumbers,
    fetchOpenItems,
    formatActivityRow,
    formatCadenceBucket,
    formatOperationActivityRow,
    formatPercent,
    isCurrentForCadence,
    isFresh,
    latestTimestamp,
    planCandidates,
    recordDashboardActivity,
    selectCandidates,
    timestampMs,
  };
}
