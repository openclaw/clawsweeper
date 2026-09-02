import { spawnSync } from "node:child_process";
import { SWEEPER_COMMAND_MAX_BUFFER_BYTES, UserFacingCommandError } from "./command.js";
import { commitMetadata, dirtyWorktree } from "./commit-sweeper.js";
import { readReviewGit, type ReviewGitReadOptions } from "./pr-review-evidence.js";
import { truncateText } from "./clawsweeper-text.js";
import type { Item, ItemContext } from "./clawsweeper-types.js";

interface LocalRangeReviewDependencies {
  run: (command: string, args: string[], options?: { cwd?: string }) => string;
  pullCommitContentRevision: (entries: readonly unknown[]) => string | null;
  reviewCommentContentRevision: (entries: readonly unknown[]) => string;
}

function localRangeFiles(targetDir: string, diffArgs: string[]) {
  const invalid = () =>
    new UserFacingCommandError("Could not read complete local-range Git file list.");
  function fields(format: string, options: ReviewGitReadOptions = {}): string[] | null {
    const raw = readReviewGit(targetDir, [...diffArgs, format, "-z", "--"], options);
    if (raw === null) return null;
    const text = raw.toString("utf8");
    // Refuse lossy path decoding and incomplete reads rather than join different identities.
    if (!Buffer.from(text, "utf8").equals(raw) || (text && !text.endsWith("\0"))) {
      return null;
    }
    return text ? text.slice(0, -1).split("\0") : [];
  }
  // Required enumeration retains runtime run()'s capture budget and absence of a deadline.
  const names = fields("--name-status", {
    maxBytes: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
    deadlineAt: null,
  });
  if (names === null) throw invalid();
  const files: Array<{ filename: string; previous_filename?: string; status: string }> = [];
  const filenames = new Set<string>();
  for (let index = 0; index < names.length;) {
    const status = names[index++];
    if (!status || !/^(?:[ADMTUXB]|[RC](?:100|0[0-9]{2}))$/.test(status)) throw invalid();
    const first = names[index++];
    const renamed = /^[RC]/.test(status);
    const filename = renamed ? names[index++] : first;
    if (!first || !filename || filenames.has(filename)) throw invalid();
    filenames.add(filename);
    files.push({ filename, ...(renamed ? { previous_filename: first } : {}), status });
  }
  const identity = (filename: string, previous?: string) => JSON.stringify([previous, filename]);
  function readStatistics() {
    const statistics = new Map<string, { additions: number | null; deletions: number | null }>();
    const counts = fields("--numstat");
    if (counts === null) return null;
    for (let index = 0; index < counts.length;) {
      const record = counts[index++];
      if (!record) return null;
      const firstTab = record.indexOf("\t");
      const secondTab = record.indexOf("\t", firstTab + 1);
      if (firstTab < 1 || secondTab <= firstTab + 1) return null;
      const added = record.slice(0, firstTab);
      const removed = record.slice(firstTab + 1, secondTab);
      let filename = record.slice(secondTab + 1);
      let previous: string | undefined;
      // Rename/copy numstat records frame old and new paths separately after an empty path.
      if (!filename) {
        previous = counts[index++];
        filename = counts[index++] ?? "";
        if (!previous) return null;
      }
      if (!filename) return null;
      const binary = added === "-" && removed === "-";
      if (
        !binary &&
        (![added, removed].every((value) => /^[0-9]+$/.test(value)) ||
          ![added, removed].every((value) => Number.isSafeInteger(Number(value))))
      ) {
        return null;
      }
      const key = identity(filename, previous);
      if (statistics.has(key)) return null;
      statistics.set(key, {
        additions: binary ? null : Number(added),
        deletions: binary ? null : Number(removed),
      });
    }
    if (
      statistics.size !== files.length ||
      files.some((file) => !statistics.has(identity(file.filename, file.previous_filename)))
    ) {
      return null;
    }
    return statistics;
  }
  // Optional bounded metadata is all-or-nothing; never publish a partially validated map.
  const statistics = readStatistics();
  return files.map((file) => ({
    ...file,
    ...(statistics?.get(identity(file.filename, file.previous_filename)) ?? {
      additions: null,
      deletions: null,
    }),
  }));
}

export function createLocalRangeReviewer({
  run,
  pullCommitContentRevision,
  reviewCommentContentRevision,
}: LocalRangeReviewDependencies) {
  // Offline local-range review synthesizes a complete PR review from committed
  // local git history. It never contacts GitHub, so contributors can review a
  // fork checkout before opening a pull request.
  function buildLocalRangeReview(
    targetDir: string,
    repo: string,
    baseRef: string,
  ): { item: Item; context: ItemContext; baseSha: string; headSha: string } {
    const base = baseRef || "origin/main";
    const headSha = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
    const baseSha = run("git", ["merge-base", base, "HEAD"], { cwd: targetDir }).trim();
    if (!baseSha || baseSha === headSha) {
      throw new UserFacingCommandError(
        `No local-range review: HEAD has no commits beyond ${base} in ${targetDir}.`,
      );
    }
    // Reuse #298's committed-range contract: this offline review covers COMMITTED work,
    // so a dirty tree (staged/untracked changes the review can't see) is rejected.
    const dirtyTree = dirtyWorktree(targetDir);
    if (dirtyTree) {
      throw new UserFacingCommandError(
        `No local-range review: working tree not clean — commit or stash first:\n${dirtyTree}`,
      );
    }
    // Reuse #298's offline commit metadata (offline=true skips all gh-api hydration).
    const meta = commitMetadata(targetDir, repo, headSha, true);
    const bodyText = run("git", ["log", "-1", "--format=%b", headSha], { cwd: targetDir }).trim();
    const title = meta.subject || `local range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`;
    const author = meta.authorName || "local";
    const committedAt = meta.committedAt || "1970-01-01T00:00:00Z";
    const localCommitShas = run("git", ["rev-list", "--reverse", `${baseSha}..${headSha}`], {
      cwd: targetDir,
    })
      .split("\n")
      .filter(Boolean);
    const localCommitIdentities = localCommitShas.map((sha) => {
      const result = spawnSync("git", ["cat-file", "commit", sha], {
        cwd: targetDir,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        throw new UserFacingCommandError(`Could not read local commit ${sha} for range review.`);
      }
      const separator = result.stdout.indexOf("\n\n");
      if (separator < 0) {
        throw new UserFacingCommandError(`Local commit ${sha} has malformed commit data.`);
      }
      const headers = result.stdout.slice(0, separator);
      const message = result.stdout.slice(separator + 2);
      const authorHeader = headers.split("\n").find((line) => line.startsWith("author "));
      const commitAuthor =
        authorHeader?.slice("author ".length).replace(/\s+<[^>]*>\s+\d+\s+[+-]\d{4}$/, "") ??
        "local";
      return { sha, author: commitAuthor, message };
    });
    const localCommitRevision = pullCommitContentRevision(localCommitIdentities);
    if (!localCommitRevision) {
      throw new UserFacingCommandError("Could not fingerprint local range commit messages.");
    }
    const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", `${baseSha}..${headSha}`];
    const rangeFiles = localRangeFiles(targetDir, diffArgs);
    const pullFiles = rangeFiles.map((metadata) => {
      const paths = metadata.previous_filename
        ? [metadata.previous_filename, metadata.filename]
        : [metadata.filename];
      const patch = run("git", ["--literal-pathspecs", ...diffArgs, "--", ...paths], {
        cwd: targetDir,
      });
      return { ...metadata, patch: truncateText(patch, 8000) };
    });
    const item: Item = {
      repo,
      number: 0,
      kind: "pull_request",
      title,
      url: `local:${headSha}`,
      createdAt: committedAt,
      updatedAt: committedAt,
      author,
      // A pre-submission self-review is the CONTRIBUTOR case — the proof gate treats OWNER
      // (maintainer) PRs more leniently, which would undercut exercising the real proof path.
      authorAssociation: "CONTRIBUTOR",
      labels: [],
    };
    const context: ItemContext = {
      issue: {
        number: 0,
        title,
        body: bodyText,
        state: "open",
        user: { login: author },
        html_url: item.url,
      },
      comments: [],
      timeline: [],
      pullRequest: {
        number: 0,
        state: "open",
        draft: false,
        merged: false,
        head: { ref: "HEAD", sha: headSha },
        base: { ref: base, sha: baseSha },
      },
      pullFiles,
      pullCommits: localCommitIdentities.map((commit) => ({
        sha: commit.sha,
        author: commit.author,
        message: truncateText(commit.message, 1000),
      })),
      pullCommitsRevision: localCommitRevision,
      pullReviewComments: [],
      pullReviewCommentsRevision: reviewCommentContentRevision([]),
      pullChecks: {
        complete: true,
        checkRuns: [],
        checkRunsTruncated: false,
        statuses: [],
        statusesTruncated: false,
      },
      counts: {
        comments: 0,
        timeline: 0,
        pullFiles: pullFiles.length,
        pullFilesHydrated: pullFiles.length,
        pullFilesTruncated: false,
        pullCommits: localCommitIdentities.length,
        pullCommitsHydrated: localCommitIdentities.length,
        pullCommitsTruncated: false,
        pullReviewComments: 0,
        pullReviewCommentsHydrated: 0,
        pullReviewCommentsTruncated: false,
      },
    };
    return { item, context, baseSha, headSha };
  }

  return buildLocalRangeReview;
}
