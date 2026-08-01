import { spawnSync } from "node:child_process";
import { UserFacingCommandError } from "./command.js";
import { commitMetadata, dirtyWorktree } from "./commit-sweeper.js";
import { truncateText } from "./clawsweeper-text.js";
import type { Item, ItemContext } from "./clawsweeper-types.js";

interface LocalRangeReviewDependencies {
  run: (command: string, args: string[], options?: { cwd?: string }) => string;
  pullCommitContentRevision: (entries: readonly unknown[]) => string | null;
  pullFileTreeIdentity: (options: {
    file: unknown;
    targetDir: string;
    baseSha: string;
    headSha: string;
  }) => Record<string, unknown>;
  reviewCommentContentRevision: (entries: readonly unknown[]) => string;
}

export function createLocalRangeReviewer({
  run,
  pullCommitContentRevision,
  pullFileTreeIdentity,
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
    const nameStatus = run("git", ["diff", "--name-status", `${baseSha}..${headSha}`], {
      cwd: targetDir,
    }).trim();
    const semanticPullFiles: unknown[] = [];
    const pullFiles = nameStatus
      ? nameStatus.split("\n").map((line) => {
          // name-status rows are tab-separated: "A\tfile", "M\tfile", or for rename/copy
          // "R100\told\tnew". The reviewable path is always the LAST field (the new path);
          // the status is the first. Splitting on the first tab only would feed the literal
          // "old\tnew" to `git diff -- <path>` and yield an empty patch for renames/copies.
          const parts = line.split("\t");
          const status = parts[0] ?? line;
          const filename = parts[parts.length - 1] ?? line;
          const previousFilename = parts.length > 2 ? parts[parts.length - 2] : undefined;
          const patch = run("git", ["diff", `${baseSha}..${headSha}`, "--", filename], {
            cwd: targetDir,
          });
          const file = {
            filename,
            ...(previousFilename ? { previous_filename: previousFilename } : {}),
            status,
            patch: truncateText(patch, 512 * 1024),
          };
          semanticPullFiles.push({
            ...file,
            ...pullFileTreeIdentity({ file, targetDir, baseSha, headSha }),
          });
          return {
            filename,
            ...(previousFilename ? { previous_filename: previousFilename } : {}),
            status,
            patch: truncateText(patch, 8000),
          };
        })
      : [];
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
      semanticPullFiles,
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
