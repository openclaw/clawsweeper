import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { escapeRegExp, truncateText } from "./clawsweeper-text.js";
import { querySqliteRows, querySqliteScalar } from "./sqlite-readonly.js";
import type {
  GitcrawlClusterSource,
  Item,
  ItemKind,
  LocalRelatedTitleEntry,
} from "./clawsweeper-types.js";

interface RelatedContextDependencies {
  root: string;
  targetRepo: () => string;
  reportUrl: (reportPath: string) => string;
  defaultItemsDir: () => string;
  defaultClosedDir: () => string;
  isMarkdownForActiveRepo: (markdown: string, file?: string) => boolean;
  gitHubRuntimeBudgetError: new (reason: string) => Error;
  ghJson: <T>(args: string[]) => T;
  ghJsonOnce: <T>(args: string[], timeoutMs: number) => T;
  asRecord: (value: unknown) => Record<string, unknown>;
  login: (value: unknown) => string | undefined;
  compactIssue: (value: unknown) => unknown;
  compactPullRequest: (value: unknown) => unknown;
  envFlagEnabled: (value: string | undefined) => boolean;
  envFlagDisabled: (value: string | undefined) => boolean;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  reviewSectionValue: (markdown: string, section: "summary") => string;
  effectiveReviewStatus: (markdown: string) => string;
  displayTitle: (title: string) => string;
  markdownFiles: (dir: string) => string[];
  numberForMarkdownFile: (file: string) => number;
  repoRelativePath: (filePath: string) => string;
}

export function createRelatedContext({
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
  displayTitle,
  markdownFiles,
  numberForMarkdownFile,
  repoRelativePath,
}: RelatedContextDependencies) {
  function collectRelatedMentions(options: {
    item: Item;
    issue: unknown;
    comments: unknown[];
    timeline: unknown[];
    pullRequest?: unknown;
    pullReviewComments?: unknown[];
  }): Map<number, string[]> {
    const mentions = new Map<number, string[]>();
    const add = (number: number, source: string): void => {
      if (!Number.isInteger(number) || number <= 0 || number === options.item.number) return;
      const current = mentions.get(number) ?? [];
      if (!current.includes(source)) current.push(source);
      mentions.set(number, current);
    };
    const scanText = (value: unknown, source: string): void => {
      if (typeof value !== "string" || !value.trim()) return;
      const [owner, repo] = targetRepo().split("/");
      const escapedRepo = `${escapeRegExp(owner ?? "")}\\/${escapeRegExp(repo ?? "")}`;
      const linked = value.matchAll(
        new RegExp(
          `github\\.com\\/${escapedRepo}\\/(?:issues|pull)\\/(\\d+)|(?<![\\w/])#(\\d+)\\b`,
          "g",
        ),
      );
      for (const match of linked) add(Number(match[1] ?? match[2]), source);
    };

    const issue = asRecord(options.issue);
    scanText(issue.body, "item body");

    options.comments.forEach((comment, index) => {
      scanText(asRecord(comment).body, `comment ${index + 1}`);
    });

    options.pullReviewComments?.forEach((comment, index) => {
      scanText(asRecord(comment).body, `pull review comment ${index + 1}`);
    });

    if (options.pullRequest) {
      scanText(asRecord(options.pullRequest).body, "pull request body");
    }

    options.timeline.forEach((event, index) => {
      const record = asRecord(event);
      scanText(record.body, `timeline ${index + 1}`);
      const sourceIssue = asRecord(asRecord(record.source).issue);
      const number = sourceIssue.number;
      if (typeof number === "number") add(number, `timeline ${index + 1} source issue`);
    });

    return mentions;
  }

  function compactRelatedItem(
    number: number,
    mentionedIn: string[],
  ): Record<string, unknown> | null {
    try {
      const issue = ghJson<unknown>(["api", `repos/${targetRepo()}/issues/${number}`]);
      const issueRecord = asRecord(issue);
      const related: Record<string, unknown> = {
        mentionedIn: mentionedIn.slice(0, 6),
        issue: compactIssue(issue),
        commentCount: issueRecord.comments,
      };

      if (issueRecord.pull_request) {
        try {
          related.pullRequest = compactPullRequest(
            ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]),
          );
        } catch (error) {
          related.pullRequestError = error instanceof Error ? error.message : String(error);
        }
      }

      return related;
    } catch (error) {
      return {
        number,
        mentionedIn: mentionedIn.slice(0, 6),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const RELATED_TITLE_STOP_WORDS = new Set([
    "about",
    "after",
    "allow",
    "already",
    "also",
    "and",
    "are",
    "because",
    "being",
    "bug",
    "cannot",
    "claw",
    "clawhub",
    "claws",
    "codex",
    "does",
    "doesn",
    "don",
    "error",
    "fails",
    "feat",
    "feature",
    "fix",
    "for",
    "from",
    "has",
    "have",
    "into",
    "issue",
    "main",
    "not",
    "openclaw",
    "pr",
    "request",
    "should",
    "that",
    "the",
    "this",
    "through",
    "using",
    "when",
    "with",
    "without",
  ]);

  let localRelatedTitleIndexCache: { repo: string; entries: LocalRelatedTitleEntry[] } | null =
    null;
  let gitcrawlClusterSourceCache: { dbPath: string; source: GitcrawlClusterSource | null } | null =
    null;
  const RELATED_ITEMS_LIMIT = 12;
  const RELATED_GITHUB_SEARCH_LIMIT = 5;
  const RELATED_GITCRAWL_LIMIT = 6;
  const RELATED_GITHUB_SEARCH_TIMEOUT_MS = 15_000;
  // 10 referencing PRs × this limit = 20 KB worst case vs 12 closing PRs × 12 000 = 144 KB
  const REFERENCING_PR_BODY_CHARS = 2000;

  function compactReferencingMergedPullRequest(candidate: Record<string, unknown>): unknown {
    const pullRequest = asRecord(candidate.pull_request ?? {});
    return {
      number: candidate.number,
      title: candidate.title,
      url: candidate.html_url,
      author: login(candidate.user),
      mergedAt: pullRequest.merged_at,
      body: truncateText(
        typeof candidate.body === "string" ? candidate.body : "",
        REFERENCING_PR_BODY_CHARS,
      ),
    };
  }

  // Filters and compacts raw search/issues API items to merged-PR shape only.
  // Drops rows whose pull_request.merged_at is null — serves as both PR-type and merge-timestamp guard.
  function referencingMergedPullRequestCandidatesForTest(items: unknown[]): unknown[] {
    return referencingMergedPullRequestCandidates(items);
  }

  function referencingMergedPullRequestCandidates(items: unknown[]): unknown[] {
    return items
      .map(asRecord)
      .filter((candidate) => Boolean(asRecord(candidate.pull_request ?? {}).merged_at))
      .map(compactReferencingMergedPullRequest);
  }

  function referencingMergedPullRequestsForIssue(number: number): unknown[] {
    if (envFlagDisabled(process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH)) return [];
    const query = `repo:${targetRepo()} is:pr is:merged #${number}`;
    try {
      const response = asRecord(
        ghJsonOnce<unknown>(
          ["api", `search/issues?q=${encodeURIComponent(query)}&per_page=10`],
          RELATED_GITHUB_SEARCH_TIMEOUT_MS,
        ),
      );
      const items = Array.isArray(response.items) ? response.items : [];
      return referencingMergedPullRequestCandidates(items);
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      console.error(
        `[referencingMergedPullRequestsForIssue] number=${number} status=failed reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  function referencingMergedPullRequestsForIssueForTest(number: number): unknown[] {
    return referencingMergedPullRequestsForIssue(number);
  }

  function compactReferencingMergedPullRequestForTest(candidate: unknown): unknown {
    return compactReferencingMergedPullRequest(asRecord(candidate));
  }

  function relatedTitleSearchTerms(title: string, limit = 6): string[] {
    const seen = new Set<string>();
    return relatedTitleCandidateTerms(title)
      .filter((term) => {
        const normalized = trimEdgeChar(term, "_");
        if (RELATED_TITLE_STOP_WORDS.has(normalized)) return false;
        if (isDigitsOnly(normalized)) return false;
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .slice(0, limit);
  }

  function relatedTitleCandidateTerms(title: string): string[] {
    const lowerTitle = title.toLowerCase();
    const terms: string[] = [];
    let index = 0;

    while (index < lowerTitle.length) {
      if (!isAsciiAlphaNumeric(lowerTitle[index])) {
        index += 1;
        continue;
      }

      const start = index;
      index += 1;
      while (index < lowerTitle.length && isRelatedTitleTermChar(lowerTitle[index])) {
        index += 1;
      }

      if (index - start >= 3) {
        terms.push(lowerTitle.slice(start, index));
      }
    }

    return terms;
  }

  function isRelatedTitleTermChar(char: string | undefined): boolean {
    return isAsciiAlphaNumeric(char) || char === "_" || char === "-";
  }

  function isAsciiAlphaNumeric(char: string | undefined): boolean {
    if (!char) return false;
    const code = char.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
  }

  function trimEdgeChar(value: string, char: string): string {
    let start = 0;
    let end = value.length;
    while (start < end && value[start] === char) start += 1;
    while (end > start && value[end - 1] === char) end -= 1;
    return value.slice(start, end);
  }

  function isDigitsOnly(value: string): boolean {
    if (!value) return false;
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (code < 48 || code > 57) return false;
    }
    return true;
  }

  function localRelatedTitleIndex(): LocalRelatedTitleEntry[] {
    if (localRelatedTitleIndexCache?.repo === targetRepo())
      return localRelatedTitleIndexCache.entries;
    const entries: LocalRelatedTitleEntry[] = [];
    for (const [location, dir] of [
      ["items", defaultItemsDir()],
      ["closed", defaultClosedDir()],
    ] as const) {
      for (const file of markdownFiles(dir)) {
        const path = join(dir, file);
        const markdown = readFileSync(path, "utf8");
        if (!isMarkdownForActiveRepo(markdown, file)) continue;
        entries.push({
          number: numberForMarkdownFile(file),
          kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
          title: displayTitle(frontMatterValue(markdown, "title") ?? ""),
          url: frontMatterValue(markdown, "url"),
          author: frontMatterValue(markdown, "author"),
          location,
          path: repoRelativePath(path),
          decision: frontMatterValue(markdown, "decision"),
          closeReason: frontMatterValue(markdown, "close_reason"),
          action: frontMatterValue(markdown, "action_taken"),
          reviewStatus: effectiveReviewStatus(markdown),
          summary: reviewSectionValue(markdown, "summary"),
        });
      }
    }
    localRelatedTitleIndexCache = { repo: targetRepo(), entries };
    return entries;
  }

  function compactLocalRelatedTitleItems(item: Item, seen: ReadonlySet<number>): unknown[] {
    const terms = relatedTitleSearchTerms(item.title);
    if (terms.length < 2) return [];
    return localRelatedTitleIndex()
      .flatMap((entry) => {
        if (seen.has(entry.number)) return [];
        const candidateTerms = new Set(relatedTitleSearchTerms(entry.title, 12));
        const overlap = terms.filter((term) => candidateTerms.has(term)).length;
        if (overlap < 2) return [];
        return [{ entry, overlap }];
      })
      .sort((left, right) => right.overlap - left.overlap || left.entry.number - right.entry.number)
      .slice(0, 5)
      .map(({ entry, overlap }) => ({
        mentionedIn: ["local title search"],
        titleSearchOverlap: overlap,
        localReport: {
          ...entry,
          reportUrl: reportUrl(`/blob/main/${entry.path}`),
        },
      }));
  }

  function quoteGitHubSearchTerm(term: string): string {
    return /^[a-z0-9_]+$/i.test(term) ? term : `"${term.replaceAll('"', "")}"`;
  }

  function relatedGitHubIssueSearchQuery(repo: string, title: string): string | null {
    const terms = relatedTitleSearchTerms(title, 4);
    if (terms.length < 2) return null;
    return [`repo:${repo}`, "is:issue", "in:title,body", ...terms.map(quoteGitHubSearchTerm)].join(
      " ",
    );
  }

  function relatedGitHubIssueSearchQueryForTest(repo: string, title: string): string | null {
    return relatedGitHubIssueSearchQuery(repo, title);
  }

  function compactRelatedGitHubIssueSearchItems(item: Item, seen: ReadonlySet<number>): unknown[] {
    if (item.kind !== "issue") return [];
    if (!envFlagEnabled(process.env.CLAWSWEEPER_RELATED_GITHUB_SEARCH)) return [];
    const query = relatedGitHubIssueSearchQuery(targetRepo(), item.title);
    if (!query) return [];

    try {
      const response = asRecord(
        ghJsonOnce<unknown>(
          [
            "api",
            `search/issues?q=${encodeURIComponent(query)}&per_page=${RELATED_GITHUB_SEARCH_LIMIT}`,
          ],
          RELATED_GITHUB_SEARCH_TIMEOUT_MS,
        ),
      );
      const items = Array.isArray(response.items) ? response.items : [];
      return items
        .map(asRecord)
        .filter((candidate) => {
          const number = candidate.number;
          if (typeof number !== "number" || seen.has(number) || number === item.number)
            return false;
          return !candidate.pull_request;
        })
        .slice(0, RELATED_GITHUB_SEARCH_LIMIT)
        .map((candidate) => ({
          mentionedIn: ["GitHub issue search"],
          searchQuery: query,
          searchScore: candidate.score,
          issue: compactIssue(candidate),
          commentCount: candidate.comments,
        }));
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      console.error(
        `Best-effort related issue GitHub search failed for #${item.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  function parseJsonArrayBestEffort(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function sqlSafeInteger(value: number): string {
    if (!Number.isSafeInteger(value)) throw new Error(`unsafe SQL integer: ${value}`);
    return String(value);
  }

  function sqlStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  function sqliteScalarBestEffort(dbPath: string, sql: string): string | null {
    try {
      return querySqliteScalar(dbPath, sql);
    } catch {
      return null;
    }
  }

  function sqliteJsonBestEffort(dbPath: string, sql: string): unknown[] {
    return sqliteJsonProbe(dbPath, sql) ?? [];
  }

  function sqliteJsonProbe(dbPath: string, sql: string): unknown[] | null {
    try {
      return querySqliteRows(dbPath, sql);
    } catch {
      return null;
    }
  }

  function gitcrawlStoreDbFileName(repo: string): string {
    return `${repo
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "__")}.sync.db`;
  }

  function gitcrawlDbPath(repo = targetRepo()): string | null {
    const configured = process.env.CLAWSWEEPER_GITCRAWL_DB?.trim();
    if (configured) {
      const configuredPath = resolve(ROOT, configured);
      return existsSync(configuredPath) ? configuredPath : null;
    }
    const storeDbFileName = gitcrawlStoreDbFileName(repo);
    const candidates = [
      join(ROOT, "..", "gitcrawl-store", "data", storeDbFileName),
      join(homedir(), ".config", "gitcrawl", "stores", "gitcrawl-store", "data", storeDbFileName),
      join(homedir(), ".config", "gitcrawl", "gitcrawl.db"),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  function gitcrawlTableRows(dbPath: string, table: "clusters" | "cluster_groups"): number {
    const countSql =
      table === "clusters"
        ? "select count(*) from clusters;"
        : "select count(*) from cluster_groups;";
    const exists =
      sqliteScalarBestEffort(
        dbPath,
        `select count(*) from sqlite_master where type = 'table' and name = '${table}';`,
      ) ?? "0";
    if (Number(exists) <= 0) return 0;
    return Number(sqliteScalarBestEffort(dbPath, countSql) ?? "0");
  }

  function detectGitcrawlClusterSource(dbPath: string): GitcrawlClusterSource | null {
    if (gitcrawlClusterSourceCache?.dbPath === dbPath) return gitcrawlClusterSourceCache.source;
    let source: GitcrawlClusterSource | null = null;
    if (gitcrawlTableRows(dbPath, "clusters") > 0) {
      source = "legacy";
    } else if (gitcrawlTableRows(dbPath, "cluster_groups") > 0) {
      source = "portable";
    }
    gitcrawlClusterSourceCache = { dbPath, source };
    return source;
  }

  function gitcrawlRelatedIssueSql(
    source: GitcrawlClusterSource,
    itemNumber: number,
    limit: number,
    repo: string,
  ): string {
    const number = sqlSafeInteger(itemNumber);
    const cappedLimit = sqlSafeInteger(Math.max(1, Math.min(limit, RELATED_ITEMS_LIMIT)));
    const repoFullName = sqlStringLiteral(repo);
    if (source === "portable") {
      return `
      select
        cg.id as cluster_id,
        (
          select count(*)
          from cluster_memberships cm_count
          where cm_count.cluster_id = cg.id
            and cm_count.state = 'active'
        ) as member_count,
        rt.number as representative_number,
        rt.kind as representative_kind,
        rt.state as representative_state,
        rt.title as representative_title,
        t.number,
        t.kind,
        t.state,
        t.title,
        t.body_excerpt as body,
        t.labels_json,
        t.updated_at
      from cluster_groups cg
      join cluster_memberships cm_self on cm_self.cluster_id = cg.id and cm_self.state = 'active'
      join threads self on self.id = cm_self.thread_id
      join repositories self_repo on self_repo.id = self.repo_id
      join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
      join threads t on t.id = cm.thread_id
      join repositories thread_repo on thread_repo.id = t.repo_id
      left join threads rt on rt.id = cg.representative_thread_id
      where cg.status = 'active'
        and cg.repo_id = self.repo_id
        and self_repo.full_name = ${repoFullName}
        and self.number = ${number}
        and self.kind = 'issue'
        and thread_repo.full_name = ${repoFullName}
        and t.number != ${number}
        and t.kind = 'issue'
      order by case when t.state = 'open' then 0 else 1 end, t.updated_at desc, t.number desc
      limit ${cappedLimit};
    `;
    }
    return `
    select
      c.id as cluster_id,
      c.member_count,
      rt.number as representative_number,
      rt.kind as representative_kind,
      rt.state as representative_state,
      rt.title as representative_title,
      t.number,
      t.kind,
      t.state,
      t.title,
      t.body,
      t.labels_json,
      t.updated_at
    from clusters c
    join cluster_members cm_self on cm_self.cluster_id = c.id
    join threads self on self.id = cm_self.thread_id
    join repositories self_repo on self_repo.id = self.repo_id
    join cluster_members cm on cm.cluster_id = c.id
    join threads t on t.id = cm.thread_id
    join repositories thread_repo on thread_repo.id = t.repo_id
    left join threads rt on rt.id = c.representative_thread_id
    where c.closed_at_local is null
      and c.repo_id = self.repo_id
      and self_repo.full_name = ${repoFullName}
      and self.number = ${number}
      and self.kind = 'issue'
      and thread_repo.full_name = ${repoFullName}
      and t.number != ${number}
      and t.kind = 'issue'
    order by case when t.state = 'open' then 0 else 1 end, t.updated_at desc, t.number desc
    limit ${cappedLimit};
  `;
  }

  function compactRelatedGitcrawlItems(item: Item, seen: ReadonlySet<number>): unknown[] {
    if (item.kind !== "issue") return [];
    const repo = targetRepo();
    const dbPath = gitcrawlDbPath(repo);
    if (!dbPath) return [];
    const source = detectGitcrawlClusterSource(dbPath);
    if (!source) return [];

    return sqliteJsonBestEffort(
      dbPath,
      gitcrawlRelatedIssueSql(source, item.number, RELATED_GITCRAWL_LIMIT, repo),
    )
      .map(asRecord)
      .filter((row) => typeof row.number === "number" && !seen.has(row.number))
      .map((row) => ({
        mentionedIn: ["gitcrawl cluster"],
        gitcrawlCluster: {
          id: row.cluster_id,
          source,
          memberCount: row.member_count,
          representative: {
            number: row.representative_number,
            kind: row.representative_kind,
            state: row.representative_state,
            title: row.representative_title,
          },
        },
        gitcrawlThread: {
          number: row.number,
          kind: row.kind,
          state: row.state,
          title: row.title,
          updatedAt: row.updated_at,
          labels: parseJsonArrayBestEffort(row.labels_json),
          body: truncateText(typeof row.body === "string" ? row.body : "", 800),
        },
      }));
  }

  function structuralExternalRelationSensitivity(item: Item): boolean | null {
    const seen = new Set<number>([item.number]);
    if (compactLocalRelatedTitleItems(item, seen).length > 0) return true;
    if (item.kind !== "issue") return false;

    const repo = targetRepo();
    const dbPath = gitcrawlDbPath(repo);
    if (dbPath) {
      const source = detectGitcrawlClusterSource(dbPath);
      if (!source) return null;
      const rows = sqliteJsonProbe(
        dbPath,
        gitcrawlRelatedIssueSql(source, item.number, RELATED_GITCRAWL_LIMIT, repo),
      );
      if (!rows) return null;
      if (
        rows.some((entry) => {
          const number = asRecord(entry).number;
          return typeof number === "number" && number !== item.number;
        })
      ) {
        return true;
      }
    }

    if (!envFlagEnabled(process.env.CLAWSWEEPER_RELATED_GITHUB_SEARCH)) return false;
    const query = relatedGitHubIssueSearchQuery(repo, item.title);
    if (!query) return false;
    try {
      const response = asRecord(
        ghJsonOnce<unknown>(
          [
            "api",
            `search/issues?q=${encodeURIComponent(query)}&per_page=${RELATED_GITHUB_SEARCH_LIMIT}`,
          ],
          RELATED_GITHUB_SEARCH_TIMEOUT_MS,
        ),
      );
      if (!Array.isArray(response.items)) return null;
      return response.items.map(asRecord).some((candidate) => {
        const number = candidate.number;
        return typeof number === "number" && number !== item.number && !candidate.pull_request;
      });
    } catch (error) {
      if (error instanceof GitHubRuntimeBudgetError) throw error;
      return null;
    }
  }

  function relatedItemNumber(value: unknown): number | null {
    const record = asRecord(value);
    const issueNumber = asRecord(record.issue).number;
    if (typeof issueNumber === "number") return issueNumber;
    const localNumber = asRecord(record.localReport).number;
    if (typeof localNumber === "number") return localNumber;
    const gitcrawlNumber = asRecord(record.gitcrawlThread).number;
    if (typeof gitcrawlNumber === "number") return gitcrawlNumber;
    const directNumber = record.number;
    return typeof directNumber === "number" ? directNumber : null;
  }

  function appendUniqueRelatedItems(
    target: unknown[],
    seen: Set<number>,
    candidates: readonly unknown[],
  ): void {
    for (const candidate of candidates) {
      const number = relatedItemNumber(candidate);
      if (number !== null) {
        if (seen.has(number)) continue;
        seen.add(number);
      }
      target.push(candidate);
      if (target.length >= RELATED_ITEMS_LIMIT) return;
    }
  }

  function relatedItemsContext(options: {
    item: Item;
    issue: unknown;
    comments: unknown[];
    timeline: unknown[];
    pullRequest?: unknown;
    pullReviewComments?: unknown[];
  }): unknown[] {
    const mentions = collectRelatedMentions(options);
    const explicitRelated = [...mentions.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, 10)
      .map(([number, mentionedIn]) => compactRelatedItem(number, mentionedIn))
      .filter((entry) => entry !== null);
    const seen = new Set<number>([options.item.number]);
    const related: unknown[] = [];
    appendUniqueRelatedItems(related, seen, explicitRelated);
    if (related.length < RELATED_ITEMS_LIMIT) {
      appendUniqueRelatedItems(related, seen, compactLocalRelatedTitleItems(options.item, seen));
    }
    if (related.length < RELATED_ITEMS_LIMIT) {
      appendUniqueRelatedItems(related, seen, compactRelatedGitcrawlItems(options.item, seen));
    }
    if (related.length < RELATED_ITEMS_LIMIT) {
      appendUniqueRelatedItems(
        related,
        seen,
        compactRelatedGitHubIssueSearchItems(options.item, seen),
      );
    }
    return related.slice(0, RELATED_ITEMS_LIMIT);
  }

  return {
    compactReferencingMergedPullRequestForTest,
    referencingMergedPullRequestCandidatesForTest,
    referencingMergedPullRequestsForIssueForTest,
    relatedGitHubIssueSearchQueryForTest,
    relatedTitleSearchTerms,
    isDigitsOnly,
    quoteGitHubSearchTerm,
    referencingMergedPullRequestsForIssue,
    relatedItemsContext,
    structuralExternalRelationSensitivity,
  };
}
