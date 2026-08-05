import { parseGhJson } from "./github-json.js";
import { exactPublicationPublicReadToken } from "./github-public-read.js";
import {
  MAX_REVIEWED_PR_ACTIVITY,
  REVIEWED_PR_ACTIVITY_THREADS_QUERY,
  createReviewedPrActivityCursor,
  reviewedPrActivityThreadsPageFromGraphql,
} from "./review-activity-cursor.js";
import type {
  ContextHydration,
  GithubContextWindowPlan,
  GithubPageWithHeaders,
} from "./clawsweeper-types.js";

interface GitHubContextDependencies {
  ghJson: <T>(args: string[]) => T;
  ghWithRetry: (args: string[]) => string;
  targetRepo: () => string;
}

export function createGitHubContext({
  ghJson,
  ghWithRetry,
  targetRepo,
}: GitHubContextDependencies) {
  function githubPaginatedPath(path: string): string {
    const [basePart, query = ""] = path.split("?", 2);
    const base = basePart ?? path;
    const params = new URLSearchParams(query);
    if (!params.has("per_page")) params.set("per_page", "100");
    const serialized = params.toString();
    return serialized ? `${base}?${serialized}` : base;
  }

  function githubPagePath(path: string, page: number, perPage = 100): string {
    const [basePart, query = ""] = path.split("?", 2);
    const base = basePart ?? path;
    const params = new URLSearchParams(query);
    params.set("per_page", String(Math.max(1, Math.floor(perPage))));
    params.set("page", String(Math.max(1, Math.floor(page))));
    const serialized = params.toString();
    return serialized ? `${base}?${serialized}` : base;
  }

  function ghPaged<T>(path: string, options: { requireApp?: boolean } = {}): T[] {
    const args = ["api", githubPaginatedPath(path), "--paginate", "--slurp"];
    if (options.requireApp && exactPublicationPublicReadToken(args, targetRepo())) {
      args.push("--method", "GET");
    }
    const pages = ghJson<unknown[]>(args);
    if (!Array.isArray(pages)) return [];
    return pages.flatMap((page) => (Array.isArray(page) ? (page as T[]) : []));
  }

  function ghPagedLimit<T>(path: string, limit: number): T[] {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (max === 0) return [];
    const entries: T[] = [];
    for (let page = 1; entries.length < max; page += 1) {
      const current = normalizeLimitedPage(ghPage<T>(path, page));
      entries.push(...current);
      if (current.length < 100) break;
    }
    return entries.slice(0, max);
  }

  function normalizeLimitedPage<T>(entries: T[]): T[] {
    return entries.length === 1 && Array.isArray(entries[0]) ? (entries[0] as T[]) : entries;
  }

  function reviewedPrActivityThreads(number: number, limit: number): unknown[] {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (max === 0) return [];
    const [owner, name] = targetRepo().split("/");
    if (!owner || !name) throw new Error(`invalid target repository: ${targetRepo()}`);
    const threads: unknown[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    while (threads.length < max) {
      const args = [
        "api",
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${number}`,
        "-f",
        `query=${REVIEWED_PR_ACTIVITY_THREADS_QUERY}`,
      ];
      if (after) args.push("-f", `after=${after}`);
      const page = reviewedPrActivityThreadsPageFromGraphql(ghJson<unknown>(args));
      if (!page) throw new Error(`malformed review thread response for PR #${number}`);
      threads.push(...page.threads);
      if (!page.hasNextPage) break;
      if (!page.endCursor || seenCursors.has(page.endCursor) || page.threads.length === 0) {
        throw new Error(`review thread pagination did not advance for PR #${number}`);
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }
    return threads.slice(0, max);
  }

  function fetchReviewedPrActivityCursor(
    number: number,
    prefetchedInlineComments?: unknown[],
  ): string | null {
    let remaining = MAX_REVIEWED_PR_ACTIVITY;
    const reviews = ghPagedLimit<unknown>(
      `repos/${targetRepo()}/pulls/${number}/reviews`,
      remaining + 1,
    );
    if (reviews.length > remaining) return null;
    remaining -= reviews.length;
    const inlineComments =
      prefetchedInlineComments ??
      ghPagedLimit<unknown>(`repos/${targetRepo()}/pulls/${number}/comments`, remaining + 1);
    if (inlineComments.length > remaining) return null;
    remaining -= inlineComments.length;
    const reviewThreads =
      inlineComments.length === 0 ? [] : reviewedPrActivityThreads(number, remaining + 1);
    if (reviewThreads.length > remaining) return null;
    return createReviewedPrActivityCursor({ reviews, inlineComments, reviewThreads });
  }

  function ghPage<T>(path: string, page: number): T[] {
    const items = ghJson<unknown[]>(["api", githubPagePath(path, page)]);
    return Array.isArray(items) ? (items as T[]) : [];
  }

  function githubLinkLastPageNumber(header: string | undefined): number | null {
    if (!header) return null;
    for (const part of header.split(",")) {
      if (!part.includes('rel="last"')) continue;
      const page = part.match(/[?&]page=(\d+)/)?.[1];
      if (!page) continue;
      const value = Number(page);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
    return null;
  }

  function ghPageWithHeaders<T>(
    path: string,
    page: number,
    perPage = 100,
  ): GithubPageWithHeaders<T> {
    const apiPath = githubPagePath(path, page, perPage);
    const output = ghWithRetry(["api", "-i", apiPath]);
    const normalized = output.replace(/\r\n/g, "\n");
    const separator = normalized.lastIndexOf("\n\n");
    const headerText = separator >= 0 ? normalized.slice(0, separator) : "";
    const bodyText = separator >= 0 ? normalized.slice(separator + 2) : normalized;
    let linkHeader: string | undefined;
    for (const line of headerText.split("\n")) {
      const delimiter = line.indexOf(":");
      if (delimiter <= 0) continue;
      if (line.slice(0, delimiter).trim().toLowerCase() === "link") {
        linkHeader = line.slice(delimiter + 1).trim();
      }
    }
    const parsed = parseGhJson<unknown>(bodyText, ["api", "-i", apiPath]);
    return {
      items: Array.isArray(parsed) ? (parsed as T[]) : [],
      lastPageNumber: githubLinkLastPageNumber(linkHeader),
    };
  }

  function githubCount(value: unknown): number | null {
    const count =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isFinite(count) || count < 0) return null;
    return Math.floor(count);
  }

  function githubContextWindowPlan(
    total: number,
    promptLimit: number,
    perPage = 100,
  ): GithubContextWindowPlan {
    const boundedTotal = Math.max(0, Math.floor(total));
    const boundedLimit = Math.max(0, Math.floor(promptLimit));
    const boundedPerPage = Math.max(1, Math.floor(perPage));
    const keepStart = Math.floor(boundedLimit / 2);
    const keepEnd = Math.max(0, boundedLimit - keepStart);
    const tailStartIndex = Math.max(0, boundedTotal - keepEnd);
    const tailFirstPageNumber = Math.floor(tailStartIndex / boundedPerPage) + 1;
    return {
      keepStart,
      keepEnd,
      tailFirstPageNumber,
      lastPageNumber: Math.max(1, Math.ceil(boundedTotal / boundedPerPage)),
      tailOffset: tailStartIndex - (tailFirstPageNumber - 1) * boundedPerPage,
    };
  }

  function ghPagedContextWindow<T>(
    path: string,
    totalCount: unknown,
    promptLimit: number,
    fetchers: {
      page?: (path: string, page: number) => T[];
      paged?: (path: string) => T[];
    } = {},
  ): ContextHydration<T> {
    const fetchPage = fetchers.page ?? ghPage<T>;
    const fetchPaged = fetchers.paged ?? ghPaged<T>;
    const total = githubCount(totalCount);
    const boundedLimit = Math.max(0, Math.floor(promptLimit));
    if (total === null) {
      const items = fetchPaged(path);
      return { items, total: items.length, hydrated: items.length, truncated: false };
    }
    if (total === 0 || boundedLimit === 0) {
      return { items: [], total, hydrated: 0, truncated: total > 0 };
    }
    if (total <= boundedLimit) {
      const items = total <= 100 ? fetchPage(path, 1) : fetchPaged(path);
      return {
        items,
        total: Math.max(total, items.length),
        hydrated: items.length,
        truncated: false,
      };
    }

    const plan = githubContextWindowPlan(total, boundedLimit);
    const firstPage = plan.keepStart > 0 ? fetchPage(path, 1) : [];
    const headItems = firstPage.slice(0, plan.keepStart);
    const tailPages: T[] = [];
    if (plan.keepEnd > 0) {
      for (let page = plan.tailFirstPageNumber; page <= plan.lastPageNumber; page += 1) {
        tailPages.push(...(page === 1 && plan.keepStart > 0 ? firstPage : fetchPage(path, page)));
      }
    }
    const tailItems = tailPages.slice(plan.tailOffset, plan.tailOffset + plan.keepEnd);
    const items = [...headItems, ...tailItems];
    return {
      items,
      total,
      hydrated: items.length,
      truncated: total > items.length,
    };
  }

  function ghPagedLinkHeaderContextWindow<T>(
    path: string,
    promptLimit: number,
    fetchers: {
      pageWithHeaders?: (path: string, page: number, perPage: number) => GithubPageWithHeaders<T>;
      paged?: (path: string) => T[];
    } = {},
  ): ContextHydration<T> {
    const fetchPage = fetchers.pageWithHeaders ?? ghPageWithHeaders<T>;
    const fetchPaged = fetchers.paged ?? ghPaged<T>;
    const boundedLimit = Math.max(0, Math.floor(promptLimit));
    const perPage = 100;
    const pages = new Map<number, T[]>();
    const readPage = (page: number): GithubPageWithHeaders<T> => {
      const cached = pages.get(page);
      if (cached) return { items: cached, lastPageNumber: null };
      const result = fetchPage(path, page, perPage);
      pages.set(page, result.items);
      return result;
    };

    const first = readPage(1);
    const lastPageNumber = first.lastPageNumber ?? (first.items.length < perPage ? 1 : null);
    if (lastPageNumber === null) {
      const items = fetchPaged(path);
      return { items, total: items.length, hydrated: items.length, truncated: false };
    }

    const lastPage = Math.max(1, lastPageNumber);
    const lastItems = lastPage === 1 ? first.items : readPage(lastPage).items;
    const total = Math.max(0, (lastPage - 1) * perPage + lastItems.length);
    if (total === 0 || boundedLimit === 0) {
      return { items: [], total, hydrated: 0, truncated: total > 0 };
    }

    if (total <= boundedLimit) {
      const items: T[] = [];
      for (let page = 1; page <= lastPage; page += 1) {
        items.push(...(page === 1 ? first.items : readPage(page).items));
      }
      return {
        items,
        total: Math.max(total, items.length),
        hydrated: items.length,
        truncated: false,
      };
    }

    const plan = githubContextWindowPlan(total, boundedLimit, perPage);
    const headItems = first.items.slice(0, plan.keepStart);
    const tailPages: T[] = [];
    if (plan.keepEnd > 0) {
      for (let page = plan.tailFirstPageNumber; page <= plan.lastPageNumber; page += 1) {
        tailPages.push(...(page === 1 ? first.items : readPage(page).items));
      }
    }
    const tailItems = tailPages.slice(plan.tailOffset, plan.tailOffset + plan.keepEnd);
    const items = [...headItems, ...tailItems];
    return {
      items,
      total,
      hydrated: items.length,
      truncated: total > items.length,
    };
  }

  return {
    fetchReviewedPrActivityCursor,
    ghPaged,
    ghPagedContextWindow,
    ghPagedLimit,
    ghPagedLinkHeaderContextWindow,
    githubContextWindowPlan,
    githubCount,
    githubLinkLastPageNumber,
    githubPaginatedPath,
  };
}
