import type { ContextHydration } from "./clawsweeper-types.js";

export const PR_HYDRATION_SNAPSHOT_VERSION = 1;
// Canonical publication caps the complete report at 2 MiB; leave half for the
// review itself and skip caching unusually large review discussions.
export const MAX_PR_HYDRATION_SNAPSHOT_BYTES = 1 * 1024 * 1024;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface PrHydrationSnapshot {
  version: 1;
  repo: string;
  number: number;
  pullUpdatedAt: string;
  headSha: string;
  commitCount: number;
  reviewCommentCount: number;
  hydratedAt: string;
  commits: ContextHydration<unknown>;
  reviewComments: ContextHydration<unknown>;
  completeReviewComments: unknown[];
}

export interface PrHydrationResult {
  commits: ContextHydration<unknown>;
  reviewComments: ContextHydration<unknown>;
  completeReviewComments: unknown[];
  snapshot: PrHydrationSnapshot | null;
  commitsReused: boolean;
  reviewCommentsReused: boolean;
  reviewCommentsIncremental: boolean;
  reviewCommentsFullFallback: boolean;
}

interface HydratePrListsOptions {
  repo: string;
  number: number;
  pullUpdatedAt: string;
  headSha: string;
  commitCount: number;
  reviewCommentCount: number;
  prior: PrHydrationSnapshot | null;
  fetchCommits: () => ContextHydration<unknown>;
  fetchReviewComments: () => ContextHydration<unknown>;
  fetchCompleteReviewComments: () => unknown[];
  fetchReviewCommentsSince: (since: string) => unknown[];
  now?: () => string;
}

export function hydratePrLists(options: HydratePrListsOptions): PrHydrationResult {
  const hydrationStartedAt = options.now?.() ?? new Date().toISOString();
  const prior = snapshotMatchesPull(options.prior, options) ? options.prior : null;
  const forceFull = prior !== null && prior.headSha.toLowerCase() !== options.headSha.toLowerCase();

  const commitsReused = prior !== null && !forceFull && prior.commitCount === options.commitCount;
  const commits = commitsReused ? prior.commits : options.fetchCommits();

  let reviewComments: ContextHydration<unknown>;
  let completeReviewComments: unknown[];
  let reviewCommentsReused = false;
  let reviewCommentsIncremental = false;
  let reviewCommentsFullFallback = false;

  const unchanged =
    prior !== null &&
    !forceFull &&
    prior.pullUpdatedAt === options.pullUpdatedAt &&
    prior.reviewCommentCount === options.reviewCommentCount;
  if (unchanged) {
    reviewComments = prior.reviewComments;
    completeReviewComments = prior.completeReviewComments;
    reviewCommentsReused = true;
  } else if (prior !== null && !forceFull && options.reviewCommentCount === 0) {
    reviewComments = emptyHydration();
    completeReviewComments = [];
    reviewCommentsReused = prior.reviewCommentCount === 0;
  } else if (
    prior !== null &&
    !forceFull &&
    options.reviewCommentCount >= prior.reviewCommentCount
  ) {
    const since = incrementalSince(prior);
    const delta = options.fetchReviewCommentsSince(since);
    const merged = mergeReviewComments(prior.completeReviewComments, delta);
    if (merged !== null && merged.length === options.reviewCommentCount) {
      completeReviewComments = merged;
      reviewComments = hydrationWindow(merged, options.reviewCommentCount, 40);
      reviewCommentsIncremental = true;
    } else {
      ({ reviewComments, completeReviewComments } = fullReviewCommentHydration(options));
      reviewCommentsFullFallback = true;
    }
  } else {
    ({ reviewComments, completeReviewComments } = fullReviewCommentHydration(options));
    reviewCommentsFullFallback = prior !== null;
  }

  const snapshot = createPrHydrationSnapshot({
    repo: options.repo,
    number: options.number,
    pullUpdatedAt: options.pullUpdatedAt,
    headSha: options.headSha,
    commitCount: options.commitCount,
    reviewCommentCount: options.reviewCommentCount,
    hydratedAt: hydrationStartedAt,
    commits,
    reviewComments,
    completeReviewComments,
  });
  return {
    commits,
    reviewComments,
    completeReviewComments,
    snapshot,
    commitsReused,
    reviewCommentsReused,
    reviewCommentsIncremental,
    reviewCommentsFullFallback,
  };
}

export function serializePrHydrationSnapshot(snapshot: PrHydrationSnapshot | undefined): string {
  return snapshot ? JSON.stringify(snapshot) : "unknown";
}

export function parsePrHydrationSnapshot(value: string | undefined): PrHydrationSnapshot | null {
  if (!value || value === "unknown") return null;
  if (Buffer.byteLength(value, "utf8") > MAX_PR_HYDRATION_SNAPSHOT_BYTES) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return validPrHydrationSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fullReviewCommentHydration(options: HydratePrListsOptions): {
  reviewComments: ContextHydration<unknown>;
  completeReviewComments: unknown[];
} {
  const reviewComments = options.fetchReviewComments();
  const completeReviewComments = reviewComments.truncated
    ? options.fetchCompleteReviewComments()
    : reviewComments.items;
  return { reviewComments, completeReviewComments };
}

function createPrHydrationSnapshot(
  snapshot: Omit<PrHydrationSnapshot, "version">,
): PrHydrationSnapshot | null {
  const candidate: PrHydrationSnapshot = {
    version: PR_HYDRATION_SNAPSHOT_VERSION,
    ...snapshot,
    commits: minimizeHydration(snapshot.commits, minimizeCommit),
    reviewComments: minimizeHydration(snapshot.reviewComments, minimizeReviewComment),
    completeReviewComments: snapshot.completeReviewComments.map(minimizeReviewComment),
  };
  if (!validPrHydrationSnapshot(candidate)) return null;
  return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_PR_HYDRATION_SNAPSHOT_BYTES
    ? candidate
    : null;
}

function validPrHydrationSnapshot(value: unknown): value is PrHydrationSnapshot {
  const snapshot = record(value);
  return (
    exactKeys(snapshot, [
      "commitCount",
      "commits",
      "completeReviewComments",
      "headSha",
      "hydratedAt",
      "number",
      "pullUpdatedAt",
      "repo",
      "reviewCommentCount",
      "reviewComments",
      "version",
    ]) &&
    snapshot.version === PR_HYDRATION_SNAPSHOT_VERSION &&
    typeof snapshot.repo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.repo) &&
    positiveInteger(snapshot.number) &&
    validTimestamp(snapshot.pullUpdatedAt) &&
    typeof snapshot.headSha === "string" &&
    SHA_PATTERN.test(snapshot.headSha) &&
    nonnegativeInteger(snapshot.commitCount) &&
    nonnegativeInteger(snapshot.reviewCommentCount) &&
    validTimestamp(snapshot.hydratedAt) &&
    validHydration(snapshot.commits, validMinimizedCommit) &&
    validHydration(snapshot.reviewComments, validMinimizedReviewComment) &&
    Array.isArray(snapshot.completeReviewComments) &&
    snapshot.completeReviewComments.length === snapshot.reviewCommentCount &&
    snapshot.completeReviewComments.every(validMinimizedReviewComment)
  );
}

function snapshotMatchesPull(
  snapshot: PrHydrationSnapshot | null,
  options: Pick<HydratePrListsOptions, "repo" | "number">,
): boolean {
  return snapshot?.repo === options.repo && snapshot.number === options.number;
}

function validHydration(
  value: unknown,
  validItem: (value: unknown) => boolean,
): value is ContextHydration<unknown> {
  const hydration = record(value);
  return (
    exactKeys(hydration, ["hydrated", "items", "total", "truncated"]) &&
    Array.isArray(hydration.items) &&
    hydration.items.every(validItem) &&
    nonnegativeInteger(hydration.total) &&
    nonnegativeInteger(hydration.hydrated) &&
    typeof hydration.truncated === "boolean" &&
    hydration.items.length === hydration.hydrated &&
    hydration.total >= hydration.hydrated &&
    hydration.truncated === hydration.total > hydration.hydrated
  );
}

function minimizeHydration(
  hydration: ContextHydration<unknown>,
  minimize: (value: unknown) => unknown,
): ContextHydration<unknown> {
  return { ...hydration, items: hydration.items.map(minimize) };
}

function minimizeCommit(value: unknown): unknown {
  const source = record(value);
  const commit = record(source.commit);
  const author = record(source.author);
  const commitAuthor = record(commit.author);
  return {
    sha: typeof source.sha === "string" ? source.sha : null,
    author: typeof author.login === "string" ? { login: author.login } : null,
    commit: {
      message: typeof commit.message === "string" ? commit.message : null,
      author: typeof commitAuthor.name === "string" ? { name: commitAuthor.name } : null,
    },
  };
}

function minimizeReviewComment(value: unknown): unknown {
  const source = record(value);
  const user = record(source.user);
  return {
    id: source.id ?? null,
    user: typeof user.login === "string" ? { login: user.login } : null,
    author_association: source.author_association ?? null,
    html_url: source.html_url ?? null,
    created_at: source.created_at ?? null,
    updated_at: source.updated_at ?? null,
    body: source.body ?? null,
    pull_request_review_id: source.pull_request_review_id ?? null,
    in_reply_to_id: source.in_reply_to_id ?? null,
    path: source.path ?? null,
    line: source.line ?? null,
    side: source.side ?? null,
    start_line: source.start_line ?? null,
    start_side: source.start_side ?? null,
    original_line: source.original_line ?? null,
    original_commit_id: source.original_commit_id ?? null,
    commit_id: source.commit_id ?? null,
  };
}

function validMinimizedCommit(value: unknown): boolean {
  const source = record(value);
  const author = source.author === null ? null : record(source.author);
  const commit = record(source.commit);
  const commitAuthor = commit.author === null ? null : record(commit.author);
  return (
    exactKeys(source, ["author", "commit", "sha"]) &&
    typeof source.sha === "string" &&
    SHA_PATTERN.test(source.sha) &&
    (author === null || (exactKeys(author, ["login"]) && typeof author.login === "string")) &&
    exactKeys(commit, ["author", "message"]) &&
    typeof commit.message === "string" &&
    (commitAuthor === null ||
      (exactKeys(commitAuthor, ["name"]) && typeof commitAuthor.name === "string"))
  );
}

function validMinimizedReviewComment(value: unknown): boolean {
  const source = record(value);
  const user = source.user === null ? null : record(source.user);
  return (
    exactKeys(source, [
      "author_association",
      "body",
      "commit_id",
      "created_at",
      "html_url",
      "id",
      "in_reply_to_id",
      "line",
      "original_commit_id",
      "original_line",
      "path",
      "pull_request_review_id",
      "side",
      "start_line",
      "start_side",
      "updated_at",
      "user",
    ]) &&
    reviewCommentId(source) !== null &&
    (user === null || (exactKeys(user, ["login"]) && typeof user.login === "string")) &&
    nullableString(source.author_association) &&
    nullableString(source.body) &&
    nullableString(source.commit_id) &&
    nullableString(source.created_at) &&
    nullableString(source.html_url) &&
    nullableInteger(source.in_reply_to_id) &&
    nullableInteger(source.line) &&
    nullableString(source.original_commit_id) &&
    nullableInteger(source.original_line) &&
    nullableString(source.path) &&
    nullableInteger(source.pull_request_review_id) &&
    nullableString(source.side) &&
    nullableInteger(source.start_line) &&
    nullableString(source.start_side) &&
    nullableString(source.updated_at)
  );
}

function incrementalSince(snapshot: PrHydrationSnapshot): string {
  let latest = Date.parse(snapshot.hydratedAt);
  for (const value of snapshot.completeReviewComments) {
    const comment = record(value);
    for (const timestamp of [comment.updated_at, comment.created_at]) {
      if (typeof timestamp !== "string") continue;
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
    }
  }
  return new Date(Math.max(0, latest - 1_000)).toISOString();
}

function mergeReviewComments(
  prior: readonly unknown[],
  delta: readonly unknown[],
): unknown[] | null {
  const merged = [...prior];
  const indexes = new Map<string, number>();
  for (const [index, value] of prior.entries()) {
    const id = reviewCommentId(value);
    if (id === null) return null;
    if (indexes.has(id)) return null;
    indexes.set(id, index);
  }
  for (const value of delta) {
    const id = reviewCommentId(value);
    if (id === null) return null;
    const index = indexes.get(id);
    if (index === undefined) {
      indexes.set(id, merged.length);
      merged.push(value);
    } else {
      merged[index] = value;
    }
  }
  return merged;
}

function hydrationWindow(
  items: readonly unknown[],
  total: number,
  limit: number,
): ContextHydration<unknown> {
  if (total === 0 || limit === 0) return { items: [], total, hydrated: 0, truncated: total > 0 };
  if (total <= limit) {
    const hydrated = items.slice(0, total);
    return { items: hydrated, total, hydrated: hydrated.length, truncated: false };
  }
  const keepStart = Math.floor(limit / 2);
  const keepEnd = limit - keepStart;
  const window = [
    ...items.slice(0, keepStart),
    ...items.slice(Math.max(keepStart, total - keepEnd)),
  ];
  return { items: window, total, hydrated: window.length, truncated: true };
}

function emptyHydration(): ContextHydration<unknown> {
  return { items: [], total: 0, hydrated: 0, truncated: false };
}

function reviewCommentId(value: unknown): string | null {
  const id = record(value).id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
  return typeof id === "string" && id.length > 0 ? id : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}
