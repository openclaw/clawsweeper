import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveSpawnCommand } from "../command.js";

const DEFAULT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

export type CommandRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  timeoutMs?: number;
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
  options: CommandRunOptions = {},
): string {
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
        maxBuffer,
        timeoutMs: options.timeoutMs,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      }),
      encoding: "utf8",
      maxBuffer: serializedWorkerMaxBuffer(maxBuffer),
      timeout: options.timeoutMs === undefined ? undefined : options.timeoutMs + 5_000,
      windowsHide: true,
    },
  );
  if (worker.error) throw worker.error;
  if (worker.status !== 0) {
    throw new Error(worker.stderr?.trim() || `validation supervisor exited ${worker.status}`);
  }
  const child = JSON.parse(worker.stdout) as {
    backgroundProcesses: number;
    error?: { code: string | undefined; message: string };
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string;
    stdout: string;
  };
  const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
  if (child.error) {
    if (child.error.code === "ETIMEDOUT") {
      const rendered = [command, ...commandArgs].join(" ");
      const message = `command timed out after ${options.timeoutMs}ms: ${rendered}`;
      throw new Error(detail ? `${message}\n${detail}` : message);
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
  return child.stdout;
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
