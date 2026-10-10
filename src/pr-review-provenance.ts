import type { ItemContext } from "./clawsweeper-types.js";
import { ReviewGitError } from "./clawsweeper-review-blobs.js";
import {
  readReviewGit,
  reviewMergeBase,
  reviewRecord as record,
  type ReviewGitReadOptions,
} from "./pr-review-evidence.js";

// Host-side provenance facts for the reviewer. The model keeps the judgement;
// this step only reports which commits and pull requests introduced the base
// lines that a pull request modifies or deletes.
const MAX_FILES = 12;
const MAX_HUNKS_PER_FILE = 4;
const MAX_COMMITS_PER_AREA = 5;
const MAX_RESOLVED_COMMITS = 15;
const DEADLINE_MS = 45_000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_BLAME_BYTES = 1024 * 1024;
const MAX_BODY_EXCERPT_CHARS = 1_200;
const MAX_SUMMARY_CHARS = 200;
const MAX_REASON_DETAIL_CHARS = 200;
const ZERO_OBJECT_ID = /^0+$/;

export type ProvenancePullRequest = {
  number: number;
  url: string;
  title: string;
  mergedAt: string | null;
  bodyExcerpt: string;
};

export type ProvenanceCommit = {
  sha: string;
  date: string;
  summary: string;
  pr?: ProvenancePullRequest;
};

export type ProvenanceChange = "modified" | "insertion_context";

export type ProvenanceArea = {
  path: string;
  baseLines: string;
  // `insertion_context` blames unchanged base lines around a pure insertion.
  change: ProvenanceChange;
  commits: ProvenanceCommit[];
};

export type ProvenanceEvidence = {
  status: "complete" | "partial" | "unavailable";
  reason?: string;
  areas: ProvenanceArea[];
};

export type ProvenanceHunk = { path: string; start: number; end: number; change: ProvenanceChange };

export type BlameCommit = { sha: string; date: string; summary: string; lines: number };

export type ProvenanceGitRead = (args: string[], options: ReviewGitReadOptions) => string | null;

export type CommitPullResolver = (
  repo: string,
  sha: string,
  deadlineAt: number,
) => ProvenancePullRequest | null;

export const PROVENANCE_NOT_RUN: ProvenanceEvidence = {
  status: "unavailable",
  reason: "The host provenance step did not run for this review.",
  areas: [],
};

function collapse(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * Base-side line ranges from a zero-context diff, on files that existed on the
 * merge base: modified or deleted lines, and up to three unchanged lines around
 * each pure insertion. Files and hunks rank by modified or deleted base lines,
 * then by inserted lines.
 */
export function selectProvenanceHunks(patch: string): {
  hunks: ProvenanceHunk[];
  omitted: number;
} {
  type Ranked = Omit<ProvenanceHunk, "path"> & { removed: number; added: number };
  const files = new Map<string, Ranked[]>();
  const lines = patch.split("\n");
  let path: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) {
      path = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      // `/dev/null` marks a new file; quoted paths are skipped rather than decoded.
      const side = line.slice(4);
      path = side.startsWith("a/") ? side.slice(2) : null;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!header) continue;
    const start = Number(header[1]);
    const removed = Number(header[2] ?? 1);
    const added = Number(header[3] ?? 1);
    // Skip the hunk body by its counted lines so `--- ` content is not a header.
    let remaining = removed + added;
    while (index + 1 < lines.length && (remaining > 0 || lines[index + 1]!.startsWith("\\"))) {
      index += 1;
      if (!lines[index]!.startsWith("\\")) remaining -= 1;
    }
    if (!path || (removed > 0 && start < 1)) continue;
    const hunks = files.get(path) ?? [];
    // `-N,0` inserts after base line N; blame N-1..N+1. Blame clips the end to the file.
    hunks.push(
      removed > 0
        ? { start, end: start + removed - 1, change: "modified", removed, added }
        : {
            start: Math.max(1, start - 1),
            end: Math.max(1, start + 1),
            change: "insertion_context",
            removed,
            added,
          },
    );
    files.set(path, hunks);
  }
  const ranked = [...files]
    .map(([file, hunks]) => ({
      file,
      hunks,
      removed: hunks.reduce((total, hunk) => total + hunk.removed, 0),
      added: hunks.reduce((total, hunk) => total + hunk.added, 0),
    }))
    .sort(
      (a, b) =>
        b.removed - a.removed ||
        b.added - a.added ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    );
  const total = ranked.reduce((count, file) => count + file.hunks.length, 0);
  const hunks = ranked.slice(0, MAX_FILES).flatMap(({ file, hunks: fileHunks }) =>
    [...fileHunks]
      .sort((a, b) => b.removed - a.removed || b.added - a.added || a.start - b.start)
      .slice(0, MAX_HUNKS_PER_FILE)
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, change }) => ({ path: file, start, end, change })),
  );
  return { hunks, omitted: total - hunks.length };
}

/** Introducing commits from `git blame --porcelain`, most attributed lines first. */
export function parseBlamePorcelain(output: string): BlameCommit[] {
  type Entry = {
    sha: string;
    time: number | null;
    summary: string;
    boundary: boolean;
    lines: number;
  };
  const commits = new Map<string, Entry>();
  let current: Entry | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("\t")) {
      if (current) current.lines += 1;
      continue;
    }
    const header = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+ \d+(?: \d+)?$/.exec(line);
    if (header) {
      const sha = header[1]!;
      current = commits.get(sha) ?? { sha, time: null, summary: "", boundary: false, lines: 0 };
      commits.set(sha, current);
      continue;
    }
    if (!current) continue;
    if (line === "boundary") current.boundary = true;
    else if (line.startsWith("author-time ")) {
      const time = Number(line.slice(12));
      current.time = Number.isSafeInteger(time) ? time : null;
    } else if (line.startsWith("summary "))
      current.summary = collapse(line.slice(8), MAX_SUMMARY_CHARS);
  }
  return [...commits.values()]
    .filter((commit) => !commit.boundary && !ZERO_OBJECT_ID.test(commit.sha) && commit.lines > 0)
    .sort((a, b) => b.lines - a.lines)
    .map(({ sha, time, summary, lines }) => ({
      sha,
      date: time === null ? "" : new Date(time * 1000).toISOString(),
      summary,
      lines,
    }));
}

/** The pull request a commit landed through, from `GET /repos/{repo}/commits/{sha}/pulls`. */
export function commitPullRequest(pulls: unknown): ProvenancePullRequest | null {
  if (!Array.isArray(pulls)) return null;
  const candidates = pulls
    .map(record)
    .filter(
      (pull) =>
        Number.isSafeInteger(pull.number) &&
        typeof pull.html_url === "string" &&
        typeof pull.title === "string",
    );
  const pull =
    candidates.find((candidate) => typeof candidate.merged_at === "string") ?? candidates[0];
  if (!pull) return null;
  return {
    number: pull.number as number,
    url: pull.html_url as string,
    title: collapse(pull.title as string, MAX_SUMMARY_CHARS),
    mergedAt: typeof pull.merged_at === "string" ? pull.merged_at : null,
    bodyExcerpt: typeof pull.body === "string" ? collapse(pull.body, MAX_BODY_EXCERPT_CHARS) : "",
  };
}

/** Caches lookups by repository and commit for one review run; failures are not cached. */
export function createCommitPullResolver(
  fetchPulls: (repo: string, sha: string, deadlineAt: number) => unknown,
): CommitPullResolver {
  const cache = new Map<string, ProvenancePullRequest | null>();
  return (repo, sha, deadlineAt) => {
    const key = `${repo}@${sha}`;
    if (cache.has(key)) return cache.get(key)!;
    const pull = commitPullRequest(fetchPulls(repo, sha, deadlineAt));
    cache.set(key, pull);
    return pull;
  };
}

export function buildProvenanceEvidence(options: {
  repo: string;
  mergeBaseSha: string;
  headSha: string;
  git: ProvenanceGitRead;
  resolvePull: CommitPullResolver;
  now?: () => number;
}): ProvenanceEvidence {
  const now = options.now ?? Date.now;
  const deadlineAt = now() + DEADLINE_MS;
  const reasons: string[] = [];
  try {
    const patch = options.git(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--ignore-submodules=all",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=0",
        options.mergeBaseSha,
        options.headSha,
        "--",
      ],
      { deadlineAt, maxBytes: MAX_DIFF_BYTES },
    );
    if (patch === null)
      return {
        status: "unavailable",
        reason: "The merge-base to head diff failed or exceeded its host bounds.",
        areas: [],
      };
    const { hunks, omitted } = selectProvenanceHunks(patch);
    if (omitted > 0)
      reasons.push(
        `${omitted} base hunks omitted by the ${MAX_FILES}-file and ${MAX_HUNKS_PER_FILE}-hunk-per-file caps.`,
      );
    const blamed: Array<{ hunk: ProvenanceHunk; commits: BlameCommit[] }> = [];
    const failed: string[] = [];
    let unblamed = 0;
    for (const hunk of hunks) {
      if (now() >= deadlineAt) {
        unblamed += 1;
        continue;
      }
      const output = options.git(
        [
          "blame",
          "--porcelain",
          "--no-textconv",
          // Configured ignore lists would attribute lines to older commits.
          "--ignore-revs-file",
          "",
          "-L",
          `${hunk.start},${hunk.end}`,
          options.mergeBaseSha,
          "--",
          hunk.path,
        ],
        { deadlineAt, maxBytes: MAX_BLAME_BYTES },
      );
      if (output === null) failed.push(`${hunk.path}:${hunk.start}-${hunk.end}`);
      else
        blamed.push({ hunk, commits: parseBlamePorcelain(output).slice(0, MAX_COMMITS_PER_AREA) });
    }
    if (unblamed > 0) reasons.push(`Host deadline reached; ${unblamed} areas were not blamed.`);
    if (failed.length > 0)
      reasons.push(
        `git blame failed or exceeded its bounds for ${failed.length} areas: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", ..." : ""}.`,
      );

    const weight = new Map<string, number>();
    for (const { commits } of blamed)
      for (const commit of commits)
        weight.set(commit.sha, (weight.get(commit.sha) ?? 0) + commit.lines);
    const ranked = [...weight].sort((a, b) => b[1] - a[1]).map(([sha]) => sha);
    const pulls = new Map<string, ProvenancePullRequest | null>();
    let lookupFailure: string | null = null;
    for (const sha of ranked.slice(0, MAX_RESOLVED_COMMITS)) {
      if (now() >= deadlineAt) {
        lookupFailure = "Host deadline reached before every commit was resolved to a pull request.";
        break;
      }
      try {
        pulls.set(sha, options.resolvePull(options.repo, sha, deadlineAt));
      } catch (error) {
        // Stop on the first API failure; later lookups would spend the same budget.
        lookupFailure = `GitHub pull request lookup failed: ${collapse(error instanceof Error ? error.message : String(error), MAX_REASON_DETAIL_CHARS)}`;
        break;
      }
    }
    if (lookupFailure) reasons.push(lookupFailure);
    if (ranked.length > MAX_RESOLVED_COMMITS)
      reasons.push(
        `${ranked.length - MAX_RESOLVED_COMMITS} commits not resolved to pull requests (cap ${MAX_RESOLVED_COMMITS}).`,
      );

    const areas = blamed.map(({ hunk, commits }) => ({
      path: hunk.path,
      baseLines: `${hunk.start}-${hunk.end}`,
      change: hunk.change,
      commits: commits.map(({ sha, date, summary }) => {
        const pr = pulls.get(sha);
        return pr ? { sha, date, summary, pr } : { sha, date, summary };
      }),
    }));
    return reasons.length
      ? { status: "partial", reason: reasons.join(" "), areas }
      : { status: "complete", areas };
  } catch (error) {
    if (error instanceof ReviewGitError && error.errorCode === "EPROCESSSETTLEMENT") throw error;
    return {
      status: "unavailable",
      reason: `Host provenance step failed: ${collapse(error instanceof Error ? error.message : String(error), MAX_REASON_DETAIL_CHARS)}`,
      areas: [],
    };
  }
}

export function pullRequestProvenanceEvidence(options: {
  targetDir: string | undefined;
  repo: string;
  context: ItemContext;
  resolvePull: CommitPullResolver;
}): ProvenanceEvidence {
  const { targetDir } = options;
  if (!targetDir)
    return { status: "unavailable", reason: "No host target checkout is available.", areas: [] };
  const pull = record(options.context.pullRequest);
  // reviewMergeBase rejects missing or malformed object identities.
  const baseSha = record(pull.base).sha;
  const headSha = record(pull.head).sha;
  const mergeBase = reviewMergeBase(
    targetDir,
    typeof baseSha === "string" ? baseSha : null,
    typeof headSha === "string" ? headSha : null,
  );
  if (mergeBase.status !== "verified" || typeof headSha !== "string")
    return {
      status: "unavailable",
      reason: mergeBase.status === "verified" ? "Missing pinned head identity." : mergeBase.reason,
      areas: [],
    };
  return buildProvenanceEvidence({
    repo: options.repo,
    mergeBaseSha: mergeBase.sha,
    headSha,
    git: (args, readOptions) =>
      readReviewGit(targetDir, args, { lazyFetch: true, ...readOptions })?.toString("utf8") ?? null,
    resolvePull: options.resolvePull,
  });
}
