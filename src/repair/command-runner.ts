import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSpawnCommand } from "../command.js";
import type { ContainmentCapabilitySummary } from "./contained-command-worker.js";
import { ValidationRecoveryRequiredError } from "./validation-recovery.js";

const DEFAULT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

/** Only emitted after the containment supervisor verifies command-tree completion. */
export class ContainedCommandTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
}

export type CommandRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  isolateNetwork?: boolean;
  maxBuffer?: number;
  timeoutMs?: number;
  writableRoots?: readonly string[];
};

type ContainedCommandOptions = CommandRunOptions & {
  /** Include successful stderr output for callers consuming diagnostic summaries. */
  includeStderr?: boolean;
};

export type ContainedCommandResult = {
  backgroundProcesses: number;
  capabilitySummary?: ContainmentCapabilitySummary;
  error?: { code: string | undefined; message: string };
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

export function runCommand(
  command: string,
  commandArgs: string[],
  options: CommandRunOptions = {},
): string {
  const child = runCommandResult(command, commandArgs, options);
  const detail = commandResultDetail(child);
  if (child.status !== 0) {
    throw new Error(detail || `${command} exited ${child.status ?? `with signal ${child.signal}`}`);
  }
  return child.stdout ?? "";
}

export function runContainedCommand(
  command: string,
  commandArgs: string[],
  options: ContainedCommandOptions = {},
): string {
  const child = runContainedCommandResult(command, commandArgs, options);
  const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
  if (child.error) {
    if (child.error.code === "ETIMEDOUT") {
      const rendered = [command, ...commandArgs].join(" ");
      const message = `command timed out after ${options.timeoutMs}ms: ${rendered}`;
      throw new ContainedCommandTimeoutError(detail ? `${message}\n${detail}` : message);
    }
    throw new Error(detail ? `${child.error.message}\n${detail}` : child.error.message);
  }
  if (child.status !== 0) {
    throw new Error(detail || `${command} exited ${child.status ?? `with signal ${child.signal}`}`);
  }
  if (child.backgroundProcesses > 0) {
    throw new Error(
      `validation command left ${child.backgroundProcesses} background process(es) after exit`,
    );
  }
  return options.includeStderr
    ? [child.stdout, child.stderr].filter(Boolean).join("\n")
    : child.stdout;
}

export function runContainedCommandResult(
  command: string,
  commandArgs: string[],
  options: CommandRunOptions = {},
): ContainedCommandResult {
  const env = options.env ?? process.env;
  const invocation = resolveSpawnCommand(command, commandArgs, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
  });
  const maxBuffer = options.maxBuffer ?? DEFAULT_COMMAND_MAX_BUFFER;
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./contained-command-worker.js", import.meta.url))],
    {
      cwd: options.cwd,
      env,
      input: JSON.stringify({
        command: invocation.command,
        args: invocation.args,
        cwd: options.cwd,
        input: options.input,
        isolateNetwork: options.isolateNetwork !== false,
        maxBuffer,
        timeoutMs: options.timeoutMs,
        writableRoots: options.writableRoots?.map((root) => fs.realpathSync(root)) ?? [],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      }),
      encoding: "utf8",
      maxBuffer: serializedWorkerMaxBuffer(maxBuffer),
      timeout: options.timeoutMs === undefined ? undefined : options.timeoutMs + 5_000,
      windowsHide: true,
    },
  );
  if (worker.error) {
    throw new ValidationRecoveryRequiredError(worker.error.message, worker.error);
  }
  if (worker.status !== 0) {
    throw new ValidationRecoveryRequiredError(
      worker.stderr?.trim() || `validation supervisor exited ${worker.status}`,
      new Error(`validation supervisor exited ${worker.status ?? worker.signal}`),
    );
  }
  try {
    const result = JSON.parse(worker.stdout) as ContainedCommandResult;
    if (
      !result ||
      !Number.isInteger(result.backgroundProcesses) ||
      result.backgroundProcesses < 0 ||
      (result.status !== null && !Number.isInteger(result.status)) ||
      (result.signal !== null && typeof result.signal !== "string") ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      (result.error !== undefined &&
        (!result.error ||
          typeof result.error.message !== "string" ||
          (result.error.code !== undefined && typeof result.error.code !== "string")))
    )
      throw new Error("invalid validation supervisor result");
    return result;
  } catch (error) {
    throw new ValidationRecoveryRequiredError(
      "validation supervisor completion could not be verified",
      error,
    );
  }
}

function serializedWorkerMaxBuffer(maxBuffer: number) {
  const overhead = 64 * 1024;
  const maximumExpandedBuffer = Math.floor((Number.MAX_SAFE_INTEGER - overhead) / 12);
  const expanded =
    maxBuffer > maximumExpandedBuffer ? Number.MAX_SAFE_INTEGER : maxBuffer * 12 + overhead;
  return Math.max(expanded, 1024 * 1024);
}

export function runCommandResult(
  command: string,
  commandArgs: string[],
  options: CommandRunOptions = {},
): SpawnSyncReturns<string> {
  const env = options.env ?? process.env;
  const invocation = resolveSpawnCommand(command, commandArgs, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
  });
  const child = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? DEFAULT_COMMAND_MAX_BUFFER,
    timeout: options.timeoutMs,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const detail = commandResultDetail(child);
  if (child.error) {
    if ((child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      const rendered = [command, ...commandArgs].join(" ");
      const message = `command timed out after ${options.timeoutMs}ms: ${rendered}`;
      throw new Error(detail ? `${message}\n${detail}` : message);
    }
    throw new Error(detail ? `${child.error.message}\n${detail}` : child.error.message);
  }
  return child;
}

function commandResultDetail(child: SpawnSyncReturns<string>): string {
  return [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
}
