import type { SpawnSyncReturns } from "node:child_process";
import { runCommand, runCommandResult } from "./command-runner.js";

export type GitOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  timeoutMs?: number;
};

/** Run git. A spawn failure or a timeout throws. A non-zero exit returns the result. */
export function runGitResult(args: string[], options: GitOptions): SpawnSyncReturns<string> {
  return runCommandResult("git", args, options);
}

/** Run git and return stdout. A non-zero exit throws with the git output. */
export function runGit(args: string[], options: GitOptions): string {
  return runCommand("git", args, options);
}
