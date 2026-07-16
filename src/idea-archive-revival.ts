#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IDEA_ARCHIVE_LABEL = "clawsweeper:idea-archive";
export const DEFAULT_IDEA_REVIVAL_REACTIONS = 5;
export const DEFAULT_IDEA_REVIVAL_MAX_PER_RUN = 10;
const DEFAULT_IDEA_ARCHIVE_SCAN_PAGES = 5;
const DEFAULT_IDEA_ARCHIVE_COMMENT_PAGES = 5;
const SPONSORSHIP_DISCOVERY_PAGES = 2;
const PAGE_SIZE = 100;

const MAINTAINER_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);

export type IdeaArchiveComment = {
  author_association?: unknown;
  body?: unknown;
  created_at?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
};

export type IdeaArchiveIssue = {
  closed_at?: unknown;
  number?: unknown;
  pull_request?: unknown;
  reactions?: unknown;
  updated_at?: unknown;
};

export function ideaArchiveLabelSettled(issue: IdeaArchiveIssue, now = Date.now()): boolean {
  const updatedAtMs =
    typeof issue.updated_at === "string" ? Date.parse(issue.updated_at) : Number.NaN;
  // Unknown age fails closed: skip this run, reconcile once the timestamp is readable.
  return Number.isFinite(updatedAtMs) && now - updatedAtMs >= RECONCILE_MIN_AGE_MS;
}

export type IdeaArchiveRevivalReason =
  | { kind: "community_traction"; reactionCount: number }
  | { kind: "maintainer_sponsorship"; author: string };

type GitHubRequestOptions = {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
  tolerateNotFound?: boolean;
};

export type IdeaArchiveRevivalSummary = {
  eligible: number;
  errors: number;
  revived: number;
  scanned: number;
};

type IdeaArchiveRevivalRunOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
};

const SPONSORSHIP_COMMAND_PATTERN = /^@clawsweeper\s+(?:revive|sponsor)\b/i;
// An open issue still carrying the archive label is usually a failed close, but it
// can also be an apply run mid-flight (label added seconds before the close call).
// Only reconcile labels that have had time to settle.
const RECONCILE_MIN_AGE_MS = 30 * 60 * 1000;

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum = 1_000,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function ideaRevivalReactionThreshold(env: NodeJS.ProcessEnv = process.env): number {
  return boundedPositiveInteger(
    env.CLAWSWEEPER_IDEA_REVIVAL_REACTIONS,
    DEFAULT_IDEA_REVIVAL_REACTIONS,
  );
}

export function positiveReactionCount(reactions: unknown): number {
  if (!reactions || typeof reactions !== "object" || Array.isArray(reactions)) return 0;
  const record = reactions as Record<string, unknown>;
  return ["+1", "heart", "hooray"].reduce((total, name) => {
    const value = record[name];
    return total + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function isBotComment(comment: IdeaArchiveComment): boolean {
  const type = typeof comment.user?.type === "string" ? comment.user.type : "";
  const login = typeof comment.user?.login === "string" ? comment.user.login : "";
  return type.toLowerCase() === "bot" || /\[bot\]$/i.test(login);
}

export function commentSignalsIdeaSponsorship(body: unknown): boolean {
  if (typeof body !== "string") return false;
  // The command must be a standalone line: prose like "do not use @clawsweeper
  // revive here", quoted lines, and fenced code must never count as sponsorship.
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith(">")) continue;
    if (SPONSORSHIP_COMMAND_PATTERN.test(line)) return true;
  }
  return false;
}

export function hasBotIdeaArchiveRevivalComment(comments: readonly IdeaArchiveComment[]): boolean {
  return comments.some(
    (comment) =>
      isBotComment(comment) &&
      typeof comment.body === "string" &&
      /\breviving from the idea archive:/i.test(comment.body),
  );
}

export function maintainerLoginAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.CLAWSWEEPER_MAINTAINER_LOGINS ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function maintainerSponsorshipAfterClose(
  comments: readonly IdeaArchiveComment[],
  closedAt: unknown,
  loginAllowlist: ReadonlySet<string> = maintainerLoginAllowlist(),
): string | null {
  const closedAtMs = typeof closedAt === "string" ? Date.parse(closedAt) : Number.NaN;
  if (!Number.isFinite(closedAtMs)) return null;
  let sponsorship: { author: string; createdAtMs: number } | null = null;
  for (const comment of comments) {
    if (isBotComment(comment) || !commentSignalsIdeaSponsorship(comment.body)) continue;
    const association =
      typeof comment.author_association === "string"
        ? comment.author_association.toUpperCase()
        : "";
    const login = typeof comment.user?.login === "string" ? comment.user.login.trim() : "";
    // GitHub reports some org owners as CONTRIBUTOR on repos they operate via
    // apps, so an explicit login allowlist supplements the association check.
    if (
      !MAINTAINER_ASSOCIATIONS.has(association) &&
      !(login && loginAllowlist.has(login.toLowerCase()))
    ) {
      continue;
    }
    const createdAtMs =
      typeof comment.created_at === "string" ? Date.parse(comment.created_at) : Number.NaN;
    if (!login || !Number.isFinite(createdAtMs) || createdAtMs < closedAtMs) continue;
    if (!sponsorship || createdAtMs < sponsorship.createdAtMs) {
      sponsorship = { author: login, createdAtMs };
    }
  }
  return sponsorship?.author ?? null;
}

export function ideaArchiveRevivalReason(
  issue: IdeaArchiveIssue,
  comments: readonly IdeaArchiveComment[],
  reactionThreshold = DEFAULT_IDEA_REVIVAL_REACTIONS,
  loginAllowlist: ReadonlySet<string> = maintainerLoginAllowlist(),
): IdeaArchiveRevivalReason | null {
  const reactionCount = positiveReactionCount(issue.reactions);
  if (reactionCount >= reactionThreshold) {
    return { kind: "community_traction", reactionCount };
  }
  const author = maintainerSponsorshipAfterClose(comments, issue.closed_at, loginAllowlist);
  return author ? { kind: "maintainer_sponsorship", author } : null;
}

export function ideaArchiveRevivalCapReached(revived: number, maximum: number): boolean {
  return revived >= Math.max(0, Math.floor(maximum));
}

export function ideaArchiveScanDirection(now = new Date()): "asc" | "desc" {
  const hour = now.getUTCHours();
  if (!Number.isInteger(hour)) return "desc";
  return Math.floor(hour / 6) % 2 === 1 ? "asc" : "desc";
}

export function renderIdeaArchiveRevivalComment(reason: IdeaArchiveRevivalReason): string {
  return reason.kind === "community_traction"
    ? `reviving from the idea archive: community traction (${reason.reactionCount} positive reactions).`
    : `reviving from the idea archive: maintainer sponsorship by @${reason.author}.`;
}

export async function runIdeaArchiveRevival(
  options: IdeaArchiveRevivalRunOptions = {},
): Promise<IdeaArchiveRevivalSummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  const repo = env.TARGET_REPO ?? "openclaw/openclaw";
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const threshold = ideaRevivalReactionThreshold(env);
  const loginAllowlist = maintainerLoginAllowlist(env);
  const maximumRevivals = boundedPositiveInteger(
    env.CLAWSWEEPER_IDEA_REVIVAL_MAX_PER_RUN,
    DEFAULT_IDEA_REVIVAL_MAX_PER_RUN,
    100,
  );
  const scanPages = boundedPositiveInteger(
    env.CLAWSWEEPER_IDEA_ARCHIVE_SCAN_PAGES,
    DEFAULT_IDEA_ARCHIVE_SCAN_PAGES,
    10,
  );
  const commentPages = boundedPositiveInteger(
    env.CLAWSWEEPER_IDEA_ARCHIVE_COMMENT_PAGES,
    DEFAULT_IDEA_ARCHIVE_COMMENT_PAGES,
    10,
  );
  const scanDirection = ideaArchiveScanDirection(options.now ?? new Date());
  let scanned = 0;
  let eligible = 0;
  let revived = 0;
  let skippedErrors = 0;

  const summary = (): IdeaArchiveRevivalSummary => {
    console.log(
      `idea-archive revival: repo=${repo} scanned=${scanned} eligible=${eligible} revived=${revived} errors=${skippedErrors} threshold=${threshold} cap=${maximumRevivals} direction=${scanDirection}`,
    );
    return { scanned, eligible, revived, errors: skippedErrors };
  };
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    console.warn("idea-archive revival skipped: missing token or invalid target repository");
    return summary();
  }

  const github = async <T>(path: string, request: GitHubRequestOptions = {}): Promise<T> => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: request.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    if (request.tolerateNotFound && response.status === 404) return undefined as T;
    if (!response.ok) {
      throw new Error(`${request.method ?? "GET"} ${path} returned ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  const issueNumber = (issue: IdeaArchiveIssue): number | null =>
    typeof issue.number === "number" && Number.isInteger(issue.number) && issue.number > 0
      ? issue.number
      : null;
  const closedAt = (issue: IdeaArchiveIssue): string | null =>
    typeof issue.closed_at === "string" && Number.isFinite(Date.parse(issue.closed_at))
      ? issue.closed_at
      : null;
  const fetchPostCloseComments = async (
    number: number,
    issueClosedAt: unknown,
    stopAfterSponsorship: boolean,
  ): Promise<{ comments: IdeaArchiveComment[]; complete: boolean }> => {
    const since = typeof issueClosedAt === "string" ? issueClosedAt : "";
    if (!since || !Number.isFinite(Date.parse(since))) return { comments: [], complete: false };
    // GitHub's `since` filter is strictly after at second precision. Back up one
    // second, then retain the local >= closed-at check for the close-second command.
    const sinceBoundary = new Date(Date.parse(since) - 1_000).toISOString();
    const comments: IdeaArchiveComment[] = [];
    for (let page = 1; page <= commentPages; page += 1) {
      const pageComments = await github<IdeaArchiveComment[]>(
        `/repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(sinceBoundary)}&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
      );
      comments.push(...pageComments);
      if (pageComments.length < PAGE_SIZE) return { comments, complete: true };
      if (
        stopAfterSponsorship &&
        maintainerSponsorshipAfterClose(comments, since, loginAllowlist)
      ) {
        return { comments, complete: false };
      }
    }
    return { comments, complete: false };
  };
  const removeArchiveLabel = async (number: number): Promise<void> => {
    await github(
      `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(IDEA_ARCHIVE_LABEL)}`,
      {
        method: "DELETE",
        tolerateNotFound: true,
      },
    );
  };
  const ensureRevivalComment = async (
    number: number,
    issueClosedAt: unknown,
    reason: IdeaArchiveRevivalReason,
  ): Promise<"existing" | "posted" | "uncertain"> => {
    const result = await fetchPostCloseComments(number, issueClosedAt, false);
    if (!result.complete) {
      console.warn(`#${number} revival comment skipped: post-close comment history is incomplete`);
      return "uncertain";
    }
    if (hasBotIdeaArchiveRevivalComment(result.comments)) return "existing";
    await github(`/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: { body: renderIdeaArchiveRevivalComment(reason) },
    });
    return "posted";
  };

  const archivedByNumber = new Map<number, IdeaArchiveIssue>();
  const addArchivedIssues = (issues: readonly IdeaArchiveIssue[]): void => {
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const number = issueNumber(issue);
      if (number !== null && !archivedByNumber.has(number)) archivedByNumber.set(number, issue);
    }
  };
  // A sponsorship command updates the issue, so this small newest-updated pass
  // discovers command revivals regardless of where an issue sits by creation date.
  for (let page = 1; page <= SPONSORSHIP_DISCOVERY_PAGES; page += 1) {
    try {
      const issues = await github<IdeaArchiveIssue[]>(
        `/repos/${repo}/issues?state=closed&labels=${encodeURIComponent(IDEA_ARCHIVE_LABEL)}&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
      );
      addArchivedIssues(issues);
      if (issues.length < PAGE_SIZE) break;
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `idea-archive sponsorship scan page ${page} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }

  // Six-hour runs alternate created-desc and created-asc so the bounded scan
  // covers both ends for reaction-only revivals without keeping cursor state.
  for (let page = 1; page <= scanPages; page += 1) {
    try {
      const issues = await github<IdeaArchiveIssue[]>(
        `/repos/${repo}/issues?state=closed&labels=${encodeURIComponent(IDEA_ARCHIVE_LABEL)}&sort=created&direction=${scanDirection}&per_page=${PAGE_SIZE}&page=${page}`,
      );
      addArchivedIssues(issues);
      if (issues.length < PAGE_SIZE) break;
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `idea-archive scan page ${page} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }
  const archived = [...archivedByNumber.values()];

  const reopenedThisRun = new Map<
    number,
    { closedAt: string | null; reason: IdeaArchiveRevivalReason }
  >();
  const commentedThisRun = new Set<number>();
  for (const issue of archived) {
    if (ideaArchiveRevivalCapReached(revived, maximumRevivals)) break;
    const number = issueNumber(issue);
    if (number === null) continue;
    scanned += 1;
    let comments: IdeaArchiveComment[] = [];
    try {
      if (positiveReactionCount(issue.reactions) < threshold) {
        comments = (await fetchPostCloseComments(number, issue.closed_at, true)).comments;
      }
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `#${number} revival check skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const reason = ideaArchiveRevivalReason(issue, comments, threshold, loginAllowlist);
    if (!reason) continue;
    eligible += 1;
    try {
      await github(`/repos/${repo}/issues/${number}`, {
        method: "PATCH",
        body: { state: "open" },
      });
      revived += 1;
      reopenedThisRun.set(number, { closedAt: closedAt(issue), reason });
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `#${number} reopen skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    try {
      await removeArchiveLabel(number);
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `#${number} archive-label removal skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if ((await ensureRevivalComment(number, issue.closed_at, reason)) === "posted") {
        commentedThisRun.add(number);
      }
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `#${number} revival comment skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(`#${number} revived: ${renderIdeaArchiveRevivalComment(reason)}`);
  }

  const reconciliationCandidates = new Map<
    number,
    { closedAt: string | null; reason?: IdeaArchiveRevivalReason }
  >(reopenedThisRun);
  try {
    const openArchived = await github<IdeaArchiveIssue[]>(
      `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(IDEA_ARCHIVE_LABEL)}&per_page=${PAGE_SIZE}&page=1`,
    );
    for (const issue of openArchived.filter((candidate) => !candidate.pull_request)) {
      const number = issueNumber(issue);
      // Skip fresh labels: an apply run may be between add-label and close right
      // now; issues we reopened ourselves this run are already in the map.
      if (number !== null && !reconciliationCandidates.has(number)) {
        if (!ideaArchiveLabelSettled(issue)) continue;
        reconciliationCandidates.set(number, {
          closedAt: closedAt(issue),
        });
      }
    }
  } catch (error) {
    skippedErrors += 1;
    console.warn(
      `idea-archive open reconciliation scan skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const [number, candidate] of reconciliationCandidates) {
    try {
      await removeArchiveLabel(number);
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `#${number} reconciliation label removal skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (commentedThisRun.has(number) || !candidate.closedAt || !candidate.reason) continue;
    try {
      if ((await ensureRevivalComment(number, candidate.closedAt, candidate.reason)) === "posted") {
        commentedThisRun.add(number);
      }
    } catch (error) {
      skippedErrors += 1;
      console.warn(
        `#${number} reconciliation comment skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return summary();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runIdeaArchiveRevival().catch((error) => {
    console.warn(
      `idea-archive revival skipped after unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
