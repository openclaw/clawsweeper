import { mkdirSync } from "node:fs";
import { ROOT } from "./clawsweeper-repository-paths.js";
import { runText, SWEEPER_COMMAND_MAX_BUFFER_BYTES } from "./command.js";

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

function runTextOptions(options: RunOptions) {
  return {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    trim: "both" as const,
  };
}

export function run(
  command: string,
  args: string[],
  options: RunOptions & { timeoutMs?: number | undefined } = {},
): string {
  return runText(command, args, { ...runTextOptions(options), timeoutMs: options.timeoutMs });
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
