import type {
  ContextHydration,
  GithubPageWithHeaders,
  GoodFirstIssueHumanLabelState,
  Item,
  ItemContext,
  PreviousClawSweeperReview,
} from "./clawsweeper-types.js";
import { completeActivityContextSymbol } from "./clawsweeper-types.js";
import { stableJson } from "./stable-json.js";
import { compactPrimaryBody } from "./clawsweeper-primary-body.js";
import { fetchPrCommentActivityRevision } from "./pr-comment-activity-revision.js";
import {
  hydratePrLists,
  type PrHydrationSnapshot,
  type PrHydrationResult,
} from "./pr-hydration-snapshot.js";
import {
  generationReadKey,
  type LiveReadGeneration,
  type LiveReadOptions,
} from "./live-read-generation.js";

interface CreateItemContextDependencies {
  asRecord: (value: unknown) => Record<string, unknown>;
  closingPullRequestsForIssue: (number: number) => unknown[];
  compactComment: (value: unknown) => unknown;
  compactIssue: (value: unknown) => unknown;
  compactMappedSlice: <T>(
    items: readonly T[],
    limit: number,
    mapper: (item: T) => unknown,
  ) => unknown[];
  compactMappedWindow: <T>(
    items: readonly T[],
    total: number,
    limit: number,
    mapper: (item: T) => unknown,
  ) => unknown[];
  compactPullCommit: (value: unknown) => unknown;
  compactPullFile: (value: unknown) => unknown;
  compactPullRequest: (value: unknown) => unknown;
  compactTimelineEvent: (value: unknown) => unknown;
  extractLatestClawSweeperReviewFromHydration: (
    commentsWindow: ContextHydration<unknown>,
    completeComments: readonly unknown[],
    number: number,
  ) => PreviousClawSweeperReview | null;
  fetchReviewedPrActivityCursor: (
    number: number,
    prefetchedInlineComments?: unknown[],
  ) => string | null;
  filterReviewContextComments: (
    comments: readonly unknown[],
    number: number,
  ) => { included: unknown[]; filtered: number };
  ghJson: <T>(args: string[]) => T;
  ghPaged: <T>(path: string) => T[];
  ghPagedContextWindow: <T>(
    path: string,
    totalCount: unknown,
    promptLimit: number,
    fetchers?: { page?: (path: string, page: number) => T[]; paged?: (path: string) => T[] },
  ) => ContextHydration<T>;
  ghPagedLinkHeaderContextWindow: <T>(
    path: string,
    promptLimit: number,
    fetchers?: {
      pageWithHeaders?: (path: string, page: number, perPage: number) => GithubPageWithHeaders<T>;
      paged?: (path: string) => T[];
    },
  ) => ContextHydration<T>;
  goodFirstIssueHumanLabelState: (timeline: readonly unknown[]) => GoodFirstIssueHumanLabelState;
  hydratedReviewStructuralItemStateDigest: (
    issue: unknown,
    comments: readonly unknown[],
  ) => string | undefined;
  itemSourceRevisionSha256: (issue: unknown, comments?: unknown[]) => string;
  pullChecksContext: (number: number, headSha: string) => unknown;
  pullCommitContentRevision: (entries: readonly unknown[]) => string | null;
  referencingMergedPullRequestsForIssue: (number: number) => unknown[];
  relatedItemsContext: (options: {
    item: Item;
    issue: unknown;
    comments: unknown[];
    timeline: unknown[];
    pullRequest?: unknown;
    pullReviewComments?: unknown[];
  }) => unknown[];
  reviewCommentContentRevision: (entries: readonly unknown[]) => string;
  reviewTimelineDigestParts: (entries: unknown) => unknown;
  hydratePullRequestReviewSource: (options: {
    files: readonly unknown[];
    itemNumber: number;
    pullRequest: unknown;
    targetDir: string;
  }) => void;
  sha256: (text: string) => string;
  stringOrUndefined: (value: unknown) => string | undefined;
  targetRepo: () => string;
}

export function createItemContext(dependencies: CreateItemContextDependencies) {
  const {
    asRecord,
    closingPullRequestsForIssue,
    compactComment,
    compactIssue,
    compactMappedSlice,
    compactMappedWindow,
    compactPullCommit,
    compactPullFile,
    compactPullRequest,
    compactTimelineEvent,
    extractLatestClawSweeperReviewFromHydration,
    fetchReviewedPrActivityCursor,
    filterReviewContextComments,
    ghJson,
    ghPaged,
    ghPagedContextWindow,
    ghPagedLinkHeaderContextWindow,
    goodFirstIssueHumanLabelState,
    hydratedReviewStructuralItemStateDigest,
    itemSourceRevisionSha256,
    pullChecksContext,
    pullCommitContentRevision,
    referencingMergedPullRequestsForIssue,
    relatedItemsContext,
    reviewCommentContentRevision,
    reviewTimelineDigestParts,
    hydratePullRequestReviewSource,
    sha256,
    stringOrUndefined,
    targetRepo,
  } = dependencies;

  function collectItemContext(
    item: Item,
    options: {
      fullTimelineForRelations?: boolean;
      reviewCacheDigest?: boolean;
      reviewCacheGitDir?: string;
      prHydrationSnapshot?: PrHydrationSnapshot | null;
      prCommentActivityRevision?: string | null;
      requireFullyValidatedPrHydrationSnapshot?: boolean;
      liveReadGeneration?: LiveReadGeneration;
      bypassGenerationCache?: boolean;
    } = {},
  ): ItemContext {
    const generationOptions: LiveReadOptions = options.bypassGenerationCache
      ? { bypassGenerationCache: true }
      : {};
    const readJson = <T>(args: string[], readOptions = generationOptions): T =>
      options.liveReadGeneration
        ? options.liveReadGeneration.read(
            generationReadKey("json", args),
            () => ghJson<T>(args),
            readOptions,
          )
        : ghJson<T>(args);
    const readPaged = <T>(path: string): T[] =>
      options.liveReadGeneration
        ? options.liveReadGeneration.read(
            generationReadKey("paged", [path]),
            () => ghPaged<T>(path),
            generationOptions,
          )
        : ghPaged<T>(path);
    const readContextWindow = <T>(path: string, total: unknown, limit: number) =>
      options.liveReadGeneration
        ? options.liveReadGeneration.read(
            generationReadKey("context-window", [path, total, limit]),
            () => ghPagedContextWindow<T>(path, total, limit, { paged: readPaged }),
            generationOptions,
          )
        : ghPagedContextWindow<T>(path, total, limit);
    const readLinkHeaderContextWindow = <T>(path: string, limit: number) =>
      options.liveReadGeneration
        ? options.liveReadGeneration.read(
            generationReadKey("link-context-window", [path, limit]),
            () => ghPagedLinkHeaderContextWindow<T>(path, limit, { paged: readPaged }),
            generationOptions,
          )
        : ghPagedLinkHeaderContextWindow<T>(path, limit);

    const issue = readJson<unknown>(["api", `repos/${targetRepo()}/issues/${item.number}`]);
    const issueRecord = asRecord(issue);
    const commentsWindow = readContextWindow<unknown>(
      `repos/${targetRepo()}/issues/${item.number}/comments`,
      issueRecord.comments,
      24,
    );
    const comments = commentsWindow.items;
    const sourceRevisionComments = commentsWindow.truncated
      ? readPaged<unknown>(`repos/${targetRepo()}/issues/${item.number}/comments`)
      : comments;
    const filteredComments = filterReviewContextComments(comments, item.number);
    const previousClawSweeperReview = extractLatestClawSweeperReviewFromHydration(
      commentsWindow,
      sourceRevisionComments,
      item.number,
    );
    const timelineWindow = readLinkHeaderContextWindow<unknown>(
      `repos/${targetRepo()}/issues/${item.number}/timeline`,
      80,
    );
    const timeline = timelineWindow.items;
    const fullTimeline =
      timelineWindow.truncated && (options.fullTimelineForRelations || options.reviewCacheDigest)
        ? readPaged<unknown>(`repos/${targetRepo()}/issues/${item.number}/timeline`)
        : null;
    const context: ItemContext = {
      issue: { ...asRecord(compactIssue(issue)), ...compactPrimaryBody(issueRecord.body) },
      sourceRevision: itemSourceRevisionSha256(issue, sourceRevisionComments),
      comments: compactMappedWindow(
        filteredComments.included,
        filteredComments.included.length,
        24,
        compactComment,
      ),
      timeline: compactMappedWindow(timeline, timelineWindow.total, 80, compactTimelineEvent),
      goodFirstIssueHumanLabelState: goodFirstIssueHumanLabelState(fullTimeline ?? timeline),
      counts: {
        comments: commentsWindow.total,
        commentsHydrated: commentsWindow.hydrated,
        commentsTruncated: commentsWindow.truncated,
        commentsIncluded: filteredComments.included.length,
        commentsFiltered: filteredComments.filtered,
        timeline: timelineWindow.total,
        timelineHydrated: timelineWindow.hydrated,
        timelineTruncated: timelineWindow.truncated,
      },
    };
    const structuralItemStateDigest = hydratedReviewStructuralItemStateDigest(
      issue,
      sourceRevisionComments,
    );
    if (structuralItemStateDigest) {
      context.structuralItemStateDigest = structuralItemStateDigest;
    }
    if (options.reviewCacheDigest) {
      context.timelineRevision = sha256(
        stableJson(reviewTimelineDigestParts((fullTimeline ?? timeline).map(compactTimelineEvent))),
      );
    }
    if (previousClawSweeperReview) context.previousClawSweeperReview = previousClawSweeperReview;
    let pullRequest: unknown = null;
    let pullReviewComments: unknown[] | null = null;
    let filteredPullReviewComments: { included: unknown[]; filtered: number } | null = null;
    let digestPullReviewComments: { included: unknown[]; filtered: number } | null = null;
    let completePullReviewComments: { included: unknown[]; filtered: number } | null = null;
    let completePullReviewCommentsHydrated = item.kind !== "pull_request";
    if (item.kind === "issue") {
      const closingPullRequests = closingPullRequestsForIssue(item.number);
      if (closingPullRequests.length > 0) {
        context.closingPullRequests = compactMappedSlice(
          closingPullRequests,
          12,
          compactPullRequest,
        );
        context.counts = {
          ...context.counts,
          comments: commentsWindow.total,
          commentsHydrated: commentsWindow.hydrated,
          commentsTruncated: commentsWindow.truncated,
          commentsIncluded: filteredComments.included.length,
          commentsFiltered: filteredComments.filtered,
          timeline: timelineWindow.total,
          timelineHydrated: timelineWindow.hydrated,
          timelineTruncated: timelineWindow.truncated,
          closingPullRequests: closingPullRequests.length,
        };
      } else {
        const referencingPRs = referencingMergedPullRequestsForIssue(item.number);
        if (referencingPRs.length > 0) {
          context.referencingMergedPullRequests = referencingPRs.slice(0, 10);
          context.counts = {
            ...context.counts!,
            referencingMergedPullRequests: referencingPRs.length,
          };
        }
      }
    }
    if (item.kind === "pull_request") {
      pullRequest = readJson<unknown>(["api", `repos/${targetRepo()}/pulls/${item.number}`]);
      const pullRecord = asRecord(pullRequest);
      const pullUpdatedAt = stringOrUndefined(pullRecord.updated_at);
      const pullHeadSha = stringOrUndefined(asRecord(pullRecord.head).sha);
      const pullChangedFileCount = nonnegativeCount(pullRecord.changed_files);
      const pullCommitCount = nonnegativeCount(pullRecord.commits);
      const pullReviewCommentCount = nonnegativeCount(pullRecord.review_comments);
      const hydration =
        pullUpdatedAt &&
        pullHeadSha &&
        pullChangedFileCount !== null &&
        pullCommitCount !== null &&
        pullReviewCommentCount !== null
          ? hydratePrLists({
              repo: targetRepo(),
              number: item.number,
              pullUpdatedAt,
              headSha: pullHeadSha,
              changedFileCount: pullChangedFileCount,
              commitCount: pullCommitCount,
              reviewCommentCount: pullReviewCommentCount,
              commentActivityRevision: options.prCommentActivityRevision ?? null,
              prior: options.prHydrationSnapshot ?? null,
              ...(options.requireFullyValidatedPrHydrationSnapshot
                ? { requireFullyValidatedSnapshot: true }
                : {}),
              revalidateCommentActivityRevision: () =>
                fetchPrCommentActivityRevision({
                  repo: targetRepo(),
                  number: item.number,
                  ghJson: <T>(args: string[]) => readJson<T>(args, { bypassGenerationCache: true }),
                }),
              fetchFiles: () =>
                readContextWindow<unknown>(
                  `repos/${targetRepo()}/pulls/${item.number}/files`,
                  pullRecord.changed_files,
                  80,
                ),
              fetchCommits: () =>
                readContextWindow<unknown>(
                  `repos/${targetRepo()}/pulls/${item.number}/commits`,
                  pullRecord.commits,
                  80,
                ),
              fetchReviewComments: () =>
                readContextWindow<unknown>(
                  `repos/${targetRepo()}/pulls/${item.number}/comments`,
                  pullRecord.review_comments,
                  40,
                ),
              fetchCompleteReviewComments: () =>
                readPaged<unknown>(`repos/${targetRepo()}/pulls/${item.number}/comments`),
              fetchReviewCommentsSince: (since) =>
                readPaged<unknown>(
                  `repos/${targetRepo()}/pulls/${item.number}/comments?since=${encodeURIComponent(since)}`,
                ),
            })
          : legacyPrHydration({
              pullRecord,
              itemNumber: item.number,
              targetRepo: targetRepo(),
              ghPaged: readPaged,
              ghPagedContextWindow: readContextWindow,
            });
      const pullFilesWindow = hydration.files;
      const pullFiles = pullFilesWindow.items;
      const pullCommitsWindow = hydration.commits;
      const pullCommits = pullCommitsWindow.items;
      const pullReviewCommentsWindow = hydration.reviewComments;
      pullReviewComments = pullReviewCommentsWindow.items;
      filteredPullReviewComments = filterReviewContextComments(pullReviewComments, item.number);
      const fullPullReviewComments =
        options.reviewCacheDigest || options.fullTimelineForRelations
          ? hydration.completeReviewComments
          : pullReviewComments;
      digestPullReviewComments =
        !options.reviewCacheDigest || fullPullReviewComments === pullReviewComments
          ? filteredPullReviewComments
          : filterReviewContextComments(fullPullReviewComments, item.number);
      completePullReviewComments =
        fullPullReviewComments === pullReviewComments
          ? filteredPullReviewComments
          : filterReviewContextComments(fullPullReviewComments, item.number);
      completePullReviewCommentsHydrated =
        fullPullReviewComments.length >= pullReviewCommentsWindow.total;
      if (hydration.snapshot) context.prHydrationSnapshot = hydration.snapshot;
      context.pullRequest = {
        ...asRecord(compactPullRequest(pullRequest)),
        ...compactPrimaryBody(pullRecord.body),
      };
      context.pullFiles = compactMappedWindow(
        pullFiles,
        pullFilesWindow.total,
        80,
        compactPullFile,
      );
      if (
        options.reviewCacheDigest &&
        options.reviewCacheGitDir &&
        !pullFilesWindow.truncated &&
        pullFilesWindow.total === pullFiles.length
      ) {
        hydratePullRequestReviewSource({
          files: pullFiles,
          itemNumber: item.number,
          pullRequest,
          targetDir: options.reviewCacheGitDir,
        });
      }
      context.pullCommits = compactMappedWindow(
        pullCommits,
        pullCommitsWindow.total,
        80,
        compactPullCommit,
      );
      if (
        options.reviewCacheDigest &&
        !pullCommitsWindow.truncated &&
        pullCommitsWindow.total === pullCommits.length
      ) {
        const pullCommitsRevision = pullCommitContentRevision(pullCommits);
        if (pullCommitsRevision) context.pullCommitsRevision = pullCommitsRevision;
      }
      context.pullReviewComments = compactMappedWindow(
        filteredPullReviewComments.included,
        filteredPullReviewComments.included.length,
        40,
        compactComment,
      );
      if (options.reviewCacheDigest) {
        context.pullReviewCommentsRevision = reviewCommentContentRevision(
          digestPullReviewComments.included.map(compactComment),
        );
        const pullReviewActivityCursor = fetchReviewedPrActivityCursor(
          item.number,
          fullPullReviewComments,
        );
        if (pullReviewActivityCursor) context.pullReviewActivityCursor = pullReviewActivityCursor;
        const headSha = stringOrUndefined(asRecord(pullRecord.head).sha);
        context.pullChecks = headSha
          ? pullChecksContext(item.number, headSha)
          : {
              complete: false,
              checkRuns: [],
              checkRunsTruncated: true,
              statuses: [],
              statusesTruncated: true,
            };
      }
      context.counts = {
        ...context.counts,
        comments: commentsWindow.total,
        commentsHydrated: commentsWindow.hydrated,
        commentsTruncated: commentsWindow.truncated,
        commentsIncluded: filteredComments.included.length,
        commentsFiltered: filteredComments.filtered,
        timeline: timelineWindow.total,
        timelineHydrated: timelineWindow.hydrated,
        timelineTruncated: timelineWindow.truncated,
        pullFiles: pullFilesWindow.total,
        pullFilesHydrated: pullFilesWindow.hydrated,
        pullFilesTruncated: pullFilesWindow.truncated,
        pullCommits: pullCommitsWindow.total,
        pullCommitsHydrated: pullCommitsWindow.hydrated,
        pullCommitsTruncated: pullCommitsWindow.truncated,
        pullReviewComments: pullReviewCommentsWindow.total,
        pullReviewCommentsHydrated: pullReviewCommentsWindow.hydrated,
        pullReviewCommentsTruncated: pullReviewCommentsWindow.truncated,
        pullReviewCommentsIncluded: filteredPullReviewComments.included.length,
        pullReviewCommentsFiltered: filteredPullReviewComments.filtered,
      };
    }
    const relationTimeline = fullTimeline ?? timeline;
    const relatedOptions: Parameters<typeof relatedItemsContext>[0] = {
      item,
      issue,
      comments: filteredComments.included,
      timeline: relationTimeline,
    };
    if (pullRequest) relatedOptions.pullRequest = pullRequest;
    const relatedPullReviewComments = digestPullReviewComments ?? filteredPullReviewComments;
    if (relatedPullReviewComments)
      relatedOptions.pullReviewComments = relatedPullReviewComments.included;
    const relatedItems = relatedItemsContext(relatedOptions);
    if (relatedItems.length) {
      context.relatedItems = relatedItems;
      const counts: NonNullable<ItemContext["counts"]> = {
        comments: context.counts?.comments ?? commentsWindow.total,
        commentsHydrated: context.counts?.commentsHydrated ?? commentsWindow.hydrated,
        commentsTruncated: context.counts?.commentsTruncated ?? commentsWindow.truncated,
        commentsIncluded: filteredComments.included.length,
        commentsFiltered: filteredComments.filtered,
        timeline: context.counts?.timeline ?? timeline.length,
        relatedItems: relatedItems.length,
      };
      if (context.counts?.timelineHydrated !== undefined)
        counts.timelineHydrated = context.counts.timelineHydrated;
      if (context.counts?.timelineTruncated !== undefined)
        counts.timelineTruncated = context.counts.timelineTruncated;
      if (context.counts?.pullFiles !== undefined) counts.pullFiles = context.counts.pullFiles;
      if (context.counts?.pullFilesHydrated !== undefined)
        counts.pullFilesHydrated = context.counts.pullFilesHydrated;
      if (context.counts?.pullFilesTruncated !== undefined)
        counts.pullFilesTruncated = context.counts.pullFilesTruncated;
      if (context.counts?.pullCommits !== undefined)
        counts.pullCommits = context.counts.pullCommits;
      if (context.counts?.pullCommitsHydrated !== undefined)
        counts.pullCommitsHydrated = context.counts.pullCommitsHydrated;
      if (context.counts?.pullCommitsTruncated !== undefined)
        counts.pullCommitsTruncated = context.counts.pullCommitsTruncated;
      if (context.counts?.pullReviewComments !== undefined)
        counts.pullReviewComments = context.counts.pullReviewComments;
      if (context.counts?.pullReviewCommentsHydrated !== undefined)
        counts.pullReviewCommentsHydrated = context.counts.pullReviewCommentsHydrated;
      if (context.counts?.pullReviewCommentsTruncated !== undefined)
        counts.pullReviewCommentsTruncated = context.counts.pullReviewCommentsTruncated;
      if (context.counts?.pullReviewCommentsIncluded !== undefined)
        counts.pullReviewCommentsIncluded = context.counts.pullReviewCommentsIncluded;
      if (context.counts?.pullReviewCommentsFiltered !== undefined)
        counts.pullReviewCommentsFiltered = context.counts.pullReviewCommentsFiltered;
      if (context.counts?.closingPullRequests !== undefined)
        counts.closingPullRequests = context.counts.closingPullRequests;
      context.counts = counts;
    }
    const completeActivityHydrated =
      sourceRevisionComments.length >= commentsWindow.total &&
      (fullTimeline ?? timeline).length >= timelineWindow.total &&
      completePullReviewCommentsHydrated;
    if (options.fullTimelineForRelations && completeActivityHydrated) {
      context[completeActivityContextSymbol] = {
        comments: filterReviewContextComments(sourceRevisionComments, item.number).included.map(
          compactComment,
        ),
        timeline: (fullTimeline ?? timeline).map(compactTimelineEvent),
        pullReviewComments: (completePullReviewComments?.included ?? []).map(compactComment),
      };
    }
    return context;
  }

  return { collectItemContext };
}

function nonnegativeCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function legacyPrHydration(options: {
  pullRecord: Record<string, unknown>;
  itemNumber: number;
  targetRepo: string;
  ghPaged: <T>(path: string) => T[];
  ghPagedContextWindow: <T>(
    path: string,
    totalCount: unknown,
    promptLimit: number,
  ) => ContextHydration<T>;
}): PrHydrationResult {
  const files = options.ghPagedContextWindow<unknown>(
    `repos/${options.targetRepo}/pulls/${options.itemNumber}/files`,
    options.pullRecord.changed_files,
    80,
  );
  const commits = options.ghPagedContextWindow<unknown>(
    `repos/${options.targetRepo}/pulls/${options.itemNumber}/commits`,
    options.pullRecord.commits,
    80,
  );
  const reviewComments = options.ghPagedContextWindow<unknown>(
    `repos/${options.targetRepo}/pulls/${options.itemNumber}/comments`,
    options.pullRecord.review_comments,
    40,
  );
  const completeReviewComments = reviewComments.truncated
    ? options.ghPaged<unknown>(`repos/${options.targetRepo}/pulls/${options.itemNumber}/comments`)
    : reviewComments.items;
  return {
    files,
    commits,
    reviewComments,
    completeReviewComments,
    snapshot: null,
    commitsReused: false,
    reviewCommentsReused: false,
    reviewCommentsIncremental: false,
    reviewCommentsFullFallback: false,
    filesReused: false,
  };
}
