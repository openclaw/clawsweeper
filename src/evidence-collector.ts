// Slice 5: pre-collected evidence for the Claude review path.
//
// Codex runs in a sandbox with mid-flight `gh`/`git`/shell access, so it can
// fetch source excerpts, history, and release provenance on demand. Claude
// has no such loop — the prompt template tells Claude to treat the
// `GitHub Context` block as the complete evidence pool. This module fills
// that pool: it parses the issue/PR body for file refs and SHAs, then asks
// caller-supplied fetchers to materialise the evidence.
//
// All public helpers are pure — they take fetcher callbacks instead of
// reaching for `git`/`gh` directly. That keeps the integration in
// `clawsweeper.ts` thin and gives tests deterministic surfaces without
// monkey-patching subprocess calls.

import { truncateText } from "./clawsweeper-text.js";

export interface SourceRef {
  /** Repo-relative path, e.g. `src/foo.ts`. */
  path: string;
  /** Single line reference, e.g. `src/foo.ts:42`. */
  line?: number;
  /** Inclusive line range, e.g. `src/foo.ts:10-25`. */
  range?: [number, number];
}

export interface SourceExcerpt {
  path: string;
  sha: string;
  startLine: number;
  endLine: number;
  body: string;
}

export interface HistorySnippetCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

export interface HistorySnippet {
  path: string;
  commits: HistorySnippetCommit[];
}

export interface ReleaseContainingTag {
  sha: string;
  tagName: string;
}

export interface ReleaseProvenance {
  tagName: string;
  sha: string;
  publishedAt: string | null;
  containingReleases?: ReleaseContainingTag[];
}

export interface RelatedItemBody {
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  url: string;
  bodyExcerpt: string;
}

// --- text parsing ---------------------------------------------------------

const PATH_REF_REGEX =
  /\b([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+){1,8}\.[A-Za-z0-9]{1,6})(?::(\d+)(?:[-:](\d+))?)?\b/g;

const SHA_REF_REGEX = /\b([0-9a-f]{7,40})\b/g;

// Markdown fence opens/closes; we skip refs that live inside fenced code
// blocks because they are usually example snippets, not real source refs.
const FENCE_REGEX = /^```/;

// Stoplist for path-shaped strings that are obviously not source refs.
const PATH_STOPLIST = new Set<string>([
  "github.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
]);

/**
 * Extract source-file references (`path/like/this.ts`, `path:line`,
 * `path:start-end`) from arbitrary text. Skips refs inside fenced code
 * blocks and URL-like strings (`https://github.com/...`).
 */
export function extractSourceRefsFromText(text: string): SourceRef[] {
  if (!text) return [];
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_REGEX.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Strip URL-host fragments so `github.com/foo/bar.ts` is not parsed as
    // a path ref. We only want repo-relative paths.
    const cleaned = line.replace(/https?:\/\/\S+/g, " ");
    PATH_REF_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PATH_REF_REGEX.exec(cleaned)) !== null) {
      const path = match[1];
      if (!path || PATH_STOPLIST.has(path.toLowerCase())) continue;
      // Reject obvious non-source extensions and bare numeric paths.
      if (/^\d+\.\d+(\.\d+)?$/.test(path)) continue;
      const lineNumStr = match[2];
      const lineEndStr = match[3];
      const key = `${path}|${lineNumStr ?? ""}|${lineEndStr ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ref: SourceRef = { path };
      if (lineNumStr) {
        const start = Number(lineNumStr);
        if (lineEndStr) {
          const end = Number(lineEndStr);
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            ref.range = [start, end];
          } else if (Number.isFinite(start)) {
            ref.line = start;
          }
        } else if (Number.isFinite(start)) {
          ref.line = start;
        }
      }
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * Extract candidate Git SHAs (7-40 lowercase hex) from text. Deduplicated.
 * SHAs inside fenced blocks are kept — they often appear in pasted logs.
 */
export function extractShasFromText(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  SHA_REF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SHA_REF_REGEX.exec(text)) !== null) {
    const sha = match[1];
    if (!sha) continue;
    // 7-40 hex is the GitHub short SHA range; require at least one digit
    // and one letter to reduce false positives like `aaaaaaa` or `1234567`.
    if (!/[a-f]/.test(sha) || !/[0-9]/.test(sha)) continue;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}

// --- source excerpt assembly ---------------------------------------------

export interface BuildSourceExcerptsOptions {
  refs: SourceRef[];
  mainSha: string;
  /** Return file contents at the given path, or null when the file is missing. */
  fetchBlob: (path: string) => string | null;
  /** Lines of context around a single-line ref. Default 20. */
  contextLines?: number;
  /** Head-of-file line cap when no line number is supplied. Default 200. */
  defaultHeadLines?: number;
  /** Hard cap on total bytes returned across all excerpts. Default ~30 kB. */
  maxTotalBytes?: number;
  /** Hard cap on number of excerpts returned. Default 12. */
  maxExcerpts?: number;
}

/**
 * Materialise source excerpts for a set of `SourceRef`s. Pure: callers
 * supply the blob fetcher (typically `git show <sha>:<path>`).
 */
export function buildSourceExcerpts(opts: BuildSourceExcerptsOptions): SourceExcerpt[] {
  const contextLines = opts.contextLines ?? 20;
  const defaultHeadLines = opts.defaultHeadLines ?? 200;
  const maxTotalBytes = opts.maxTotalBytes ?? 30_000;
  const maxExcerpts = opts.maxExcerpts ?? 12;
  const excerpts: SourceExcerpt[] = [];
  let usedBytes = 0;
  const seen = new Set<string>();
  for (const ref of opts.refs) {
    if (excerpts.length >= maxExcerpts) break;
    if (usedBytes >= maxTotalBytes) break;
    const key = `${ref.path}|${ref.line ?? ""}|${ref.range?.[0] ?? ""}|${ref.range?.[1] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let blob: string | null;
    try {
      blob = opts.fetchBlob(ref.path);
    } catch {
      blob = null;
    }
    if (blob == null) continue;
    const lines = blob.split(/\r?\n/);
    let startLine = 1;
    let endLine = Math.min(lines.length, defaultHeadLines);
    if (ref.range) {
      startLine = Math.max(1, ref.range[0] - contextLines);
      endLine = Math.min(lines.length, ref.range[1] + contextLines);
    } else if (ref.line !== undefined) {
      startLine = Math.max(1, ref.line - contextLines);
      endLine = Math.min(lines.length, ref.line + contextLines);
    }
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const remaining = Math.max(0, maxTotalBytes - usedBytes);
    if (remaining === 0) break;
    const trimmedBody = body.length > remaining ? body.slice(0, remaining) : body;
    usedBytes += trimmedBody.length;
    excerpts.push({
      path: ref.path,
      sha: opts.mainSha,
      startLine,
      endLine,
      body: trimmedBody,
    });
  }
  return excerpts;
}

// --- history snippets -----------------------------------------------------

export interface BuildHistorySnippetsOptions {
  paths: string[];
  /** Return up to N commits for the given path. */
  fetchLog: (path: string, limit: number) => HistorySnippetCommit[];
  /** Max commits per file. Default 10. */
  maxCommits?: number;
  /** Cap on number of files reported. Default 10. */
  maxFiles?: number;
}

export function buildHistorySnippets(opts: BuildHistorySnippetsOptions): HistorySnippet[] {
  const maxCommits = opts.maxCommits ?? 10;
  const maxFiles = opts.maxFiles ?? 10;
  const out: HistorySnippet[] = [];
  const seen = new Set<string>();
  for (const path of opts.paths) {
    if (out.length >= maxFiles) break;
    if (seen.has(path)) continue;
    seen.add(path);
    let commits: HistorySnippetCommit[];
    try {
      commits = opts.fetchLog(path, maxCommits);
    } catch {
      continue;
    }
    if (commits.length === 0) continue;
    out.push({ path, commits: commits.slice(0, maxCommits) });
  }
  return out;
}

/**
 * Parse `git log --format=%H%x09%aI%x09%an%x09%s` output into commit
 * records. Robust to trailing blank lines.
 */
export function parseGitLogTabular(text: string): HistorySnippetCommit[] {
  const out: HistorySnippetCommit[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [sha, date, author, ...subjectParts] = line.split("\t");
    if (!sha || !date) continue;
    out.push({
      sha,
      date,
      author: author ?? "",
      subject: subjectParts.join("\t"),
    });
  }
  return out;
}

// --- related-item bodies --------------------------------------------------

export interface BuildRelatedItemBodiesOptions {
  related: ReadonlyArray<{
    number: number;
    kind?: "issue" | "pull_request";
    title?: string;
    url?: string;
    body?: string | null;
  }>;
  /** Max bytes per related-item body. Default ~2 kB. */
  maxBodyBytes?: number;
  /** Cap on number of related items reported. Default 10. */
  maxItems?: number;
}

export function buildRelatedItemBodies(opts: BuildRelatedItemBodiesOptions): RelatedItemBody[] {
  const maxBodyBytes = opts.maxBodyBytes ?? 2_048;
  const maxItems = opts.maxItems ?? 10;
  const out: RelatedItemBody[] = [];
  for (const entry of opts.related) {
    if (out.length >= maxItems) break;
    if (typeof entry.number !== "number") continue;
    const body = typeof entry.body === "string" ? entry.body : "";
    if (!body.trim()) continue;
    out.push({
      number: entry.number,
      kind: entry.kind ?? "issue",
      title: entry.title ?? "",
      url: entry.url ?? "",
      bodyExcerpt: truncateText(body, maxBodyBytes),
    });
  }
  return out;
}
