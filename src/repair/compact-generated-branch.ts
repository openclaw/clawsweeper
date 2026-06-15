import { runCommand as run } from "./command-runner.js";
import { uniqueStrings } from "./validation-command-utils.js";

export type GeneratedBranchCompaction =
  | {
      status: "unchanged";
      commit: string;
      previous_commit_count: number;
    }
  | {
      status: "compacted";
      commit: string;
      previous_head: string;
      previous_commit_count: number;
    };

export function compactGeneratedBranchHistory({
  targetDir,
  baseRef,
  message,
  trailers = [],
}: {
  targetDir: string;
  baseRef: string;
  message: string;
  trailers?: readonly string[];
}): GeneratedBranchCompaction {
  const status = run("git", ["status", "--porcelain"], { cwd: targetDir }).trim();
  if (status) {
    throw new Error("cannot compact generated branch history with worktree changes");
  }

  const baseSha = run("git", ["rev-parse", baseRef], { cwd: targetDir }).trim();
  const previousHead = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const previousCommitCount = Number(
    run("git", ["rev-list", "--count", `${baseSha}..${previousHead}`], {
      cwd: targetDir,
    }).trim(),
  );
  if (!Number.isInteger(previousCommitCount) || previousCommitCount <= 1) {
    return {
      status: "unchanged",
      commit: previousHead,
      previous_commit_count: previousCommitCount,
    };
  }

  const changedFiles = run("git", ["diff", "--name-only", baseSha, previousHead], {
    cwd: targetDir,
  }).trim();
  if (!changedFiles) {
    return {
      status: "unchanged",
      commit: previousHead,
      previous_commit_count: previousCommitCount,
    };
  }

  const previousTree = run("git", ["rev-parse", `${previousHead}^{tree}`], {
    cwd: targetDir,
  }).trim();
  run("git", ["reset", "--soft", baseSha], { cwd: targetDir });
  const commitArgs = ["commit", "-m", message];
  for (const trailer of uniqueStrings([...trailers])) commitArgs.push("-m", trailer);
  run("git", commitArgs, { cwd: targetDir });

  const commit = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const compactedTree = run("git", ["rev-parse", `${commit}^{tree}`], {
    cwd: targetDir,
  }).trim();
  if (compactedTree !== previousTree) {
    throw new Error("generated branch compaction changed the reviewed tree");
  }
  if (run("git", ["status", "--porcelain"], { cwd: targetDir }).trim()) {
    throw new Error("generated branch compaction left worktree changes");
  }

  return {
    status: "compacted",
    commit,
    previous_head: previousHead,
    previous_commit_count: previousCommitCount,
  };
}
