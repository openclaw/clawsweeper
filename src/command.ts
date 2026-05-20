import { execFileSync } from "node:child_process";

export type RunTextOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxBuffer?: number;
  stdio?: ["ignore", "pipe", "pipe"] | ["ignore", "pipe", "ignore"];
  trim?: "both" | "end" | "none";
  /**
   * Hard wall-clock timeout (ms). Forwarded to execFileSync; the child is
   * killed with SIGTERM (or `killSignal`) on expiry and execFileSync throws.
   * Use when a probe must never wedge a review — slice 5 evidence helpers
   * pass 5_000 so a slow `git`/`gh` call skips the field instead of failing
   * the whole review.
   */
  timeout?: number;
};

export function runText(
  command: string,
  args: string[],
  {
    cwd,
    env,
    maxBuffer = 64 * 1024 * 1024,
    stdio = ["ignore", "pipe", "pipe"],
    trim = "end",
    timeout,
  }: RunTextOptions = {},
): string {
  const resolved = resolveCommand(command, args);
  const text = execFileSync(resolved.command, resolved.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    maxBuffer,
    stdio,
    ...(timeout !== undefined ? { timeout } : {}),
  });
  if (trim === "both") return text.trim();
  if (trim === "end") return text.trimEnd();
  return text;
}

function resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (command === "gh" && process.env.GH_BIN) {
    return {
      command: process.env.GH_BIN,
      args: [...envArgs("GH_BIN_ARGS"), ...args],
    };
  }
  return { command: resolveExecutable(command), args };
}

function resolveExecutable(command: string): string {
  return command === "git" ? (process.env.GIT_BIN ?? "/usr/bin/git") : command;
}

function envArgs(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}
