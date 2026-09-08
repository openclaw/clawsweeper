import { DAY_MS, FRESH_DAYS } from "./clawsweeper-policy.js";
import type {
  DueCandidate,
  ExistingReviewIndex,
  GitHubIssueListItem,
  Item,
  OpenItemCounts,
  RepoOpenCountsQuery,
} from "./clawsweeper-types.js";
import {
  hasReviewPolicyMismatch,
  nextReviewDueAtMs,
  reviewPriority,
  reviewedAtMs,
  schedulerBucket,
  shouldReviewItem,
} from "./scheduler-policy.js";
import type { ReviewPlanningDependencies } from "./clawsweeper-review-planning-dependencies.js";
import {
  prCommentActivityRevision,
  prCommentActivityRevisionQuery,
  PR_ACTIVITY_REVISION_CONNECTION_LIMIT,
  PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE,
} from "./pr-comment-activity-revision.js";
import {
  generationReadKey,
  type LiveReadGeneration,
  type LiveReadOptions,
} from "./live-read-generation.js";
import {
  githubReadModelItemObject,
  githubReadModelRequestSync,
  usableGithubReadModelResponse,
} from "./github-webhook-read-model-client.js";
import { recordOrEmpty as jsonRecord } from "./value-coerce.js";

export {
  PR_ACTIVITY_REVISION_CONNECTION_LIMIT,
  PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE,
} from "./pr-comment-activity-revision.js";

export interface PlannedPrActivityRevisions {
  revisions: Record<string, string | null>;
  requestCount: number;
  pageSize: number;
  connectionLimit: number;
}

export function createReviewPlanningInventory(dependencies: ReviewPlanningDependencies) {
  const { targetRepo, ghJson, ghJsonLines, normalizeAuthorAssociation, indexedExistingReview } =
    dependencies;
  const readModelRequest = dependencies.githubReadModelRequestSync ?? githubReadModelRequestSync;

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
  function fetchItem(
    number: number,
    options: LiveReadOptions & { liveReadGeneration?: LiveReadGeneration } = {},
  ): { item: Item; state: string } {
    const args = ["api", `repos/${targetRepo()}/issues/${number}`];
    const readIssue = () =>
      ghJson<
        GitHubIssueListItem & {
          active_lock_reason?: string | null;
          locked?: boolean;
          state?: string;
        }
      >(args);
    const issue = (() => {
      if (options.liveReadGeneration) {
        return options.liveReadGeneration.read(generationReadKey("json", args), readIssue, options);
      }
      if (!options.bypassGenerationCache) {
        const snapshot = readModelRequest("item", {
          repository: targetRepo(),
          number,
        });
        if (
          usableGithubReadModelResponse(snapshot, "review_planning_item", "issues_or_pull_requests")
        ) {
          const value = snapshot.item;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            return value as GitHubIssueListItem & {
              active_lock_reason?: string | null;
              locked?: boolean;
              state?: string;
            };
          }
        }
      }
      const live = readIssue();
      if (!options.bypassGenerationCache) {
        const object = githubReadModelItemObject(
          targetRepo(),
          live as unknown as Record<string, unknown>,
        );
        if (object) {
          readModelRequest("repair", {
            repository: targetRepo(),
            repair_kind: "items",
            objects: [object],
          });
        }
      }
      return live;
    })();
    const labels = (issue.labels ?? []).flatMap((label: unknown) => {
      if (typeof label === "string") return [label];
      if (!label || typeof label !== "object" || Array.isArray(label)) return [];
      const name = (label as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    });
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
        labels,
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

  function fetchPlannedPrActivityRevisions(
    items: readonly Pick<Item, "kind" | "number">[],
  ): PlannedPrActivityRevisions {
    const numbers = [
      ...new Set(
        items
          .filter((item) => item.kind === "pull_request")
          .map((item) => item.number)
          .filter((number) => Number.isSafeInteger(number) && number > 0),
      ),
    ].sort((left, right) => left - right);
    const revisions: Record<string, string | null> = Object.fromEntries(
      numbers.map((number) => [String(number), null]),
    );
    if (numbers.length === 0) {
      return {
        revisions,
        requestCount: 0,
        pageSize: PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE,
        connectionLimit: PR_ACTIVITY_REVISION_CONNECTION_LIMIT,
      };
    }
    const [owner, name] = targetRepo().split("/");
    if (!validGraphQlName(owner) || !validGraphQlName(name)) {
      console.error(
        `[plan] unable to validate PR comment activity revisions for invalid repo ${targetRepo()}; hydration cache validation will fail closed`,
      );
      return {
        revisions,
        requestCount: 0,
        pageSize: PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE,
        connectionLimit: PR_ACTIVITY_REVISION_CONNECTION_LIMIT,
      };
    }

    let requestCount = 0;
    for (let offset = 0; offset < numbers.length; offset += PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE) {
      const page = numbers.slice(offset, offset + PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE);
      requestCount += 1;
      try {
        const response = ghJson<unknown>([
          "api",
          "graphql",
          "-f",
          `query=${prCommentActivityRevisionQuery(owner, name, page)}`,
        ]);
        const root = jsonRecord(response);
        if (Array.isArray(root.errors) && root.errors.length > 0) {
          throw new Error("GitHub GraphQL returned errors");
        }
        const repository = jsonRecord(jsonRecord(root.data).repository);
        for (const number of page) {
          revisions[String(number)] = prCommentActivityRevision(repository[`pr_${number}`]);
        }
      } catch (error) {
        console.error(
          `[plan] unable to validate PR comment activity revisions for ${targetRepo()} items ${page[0]}-${page.at(-1)}; hydration cache validation will fail closed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      revisions,
      requestCount,
      pageSize: PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE,
      connectionLimit: PR_ACTIVITY_REVISION_CONNECTION_LIMIT,
    };
  }

  return {
    isFresh,
    isCurrentForCadence,
    dueCandidate,
    reviewBackfillCandidate,
    fetchOpenItemPage,
    fetchOpenItems,
    fetchHotIntakeItems,
    fetchOpenItemNumbers,
    fetchItem,
    fetchOpenItemCounts,
    fetchPlannedPrActivityRevisions,
  };
}

function validGraphQlName(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value);
}
