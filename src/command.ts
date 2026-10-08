import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const SWEEPER_COMMAND_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

export type RunTextOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxBuffer?: number;
  stdio?: ["ignore", "pipe", "pipe"] | ["ignore", "pipe", "ignore"];
  timeoutMs?: number | undefined;
  trim?: "both" | "end" | "none";
};

export interface CommandInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export type ResolveSpawnCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  missingCommandMessage?: string;
  platform?: NodeJS.Platform;
};

const windowsExecutablePattern = /\.(?:com|exe)$/i;
const windowsBatchLauncherPattern = /\.(?:bat|cmd)$/i;
const windowsMetaCharacterPattern = /([()\][%!^"`<>&|;, *?])/g;

export class UserFacingCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingCommandError";
  }
}

export function isUserFacingCommandError(error: unknown): error is UserFacingCommandError {
  return error instanceof UserFacingCommandError;
}

export function runText(
  command: string,
  args: string[],
  {
    cwd,
    env,
    maxBuffer = 64 * 1024 * 1024,
    stdio = ["ignore", "pipe", "pipe"],
    timeoutMs,
    trim = "end",
  }: RunTextOptions = {},
): string {
  const childEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env };
  const resolved = resolveCommand(command, args, childEnv);
  let text: string;
  try {
    text = execFileSync(resolved.command, resolved.args, {
      cwd,
      encoding: "utf8",
      env: childEnv,
      maxBuffer,
      stdio,
      timeout: timeoutMs,
    });
  } catch (error) {
    throw explainSpawnFailure(error, resolved.command, cwd);
  }
  if (trim === "both") return text.trim();
  if (trim === "end") return text.trimEnd();
  return text;
}

/** A command that reached its deadline while queued never starts (`expired`). */
export type ConcurrentRunResult = { output: string } | { error: unknown } | { expired: true };

/** `runText` options, with an absolute deadline in place of a relative timeout. */
export type ConcurrentRunOptions = Omit<RunTextOptions, "timeoutMs"> & {
  deadlineAt?: number | undefined;
};

type SpawnedCommandResult =
  | { expired: true }
  | {
      expired?: undefined;
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      errorCode?: string;
    };

// Runs in a short-lived Node child: starts at most `concurrency` commands at a
// time, each with the time left before its deadline when it starts, and reports
// spawnSync-style results (timeout ETIMEDOUT, output limit ENOBUFS, spawn
// failures by code) in input order.
const CONCURRENT_RUN_SCRIPT = `
const { spawn } = require("node:child_process");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const { concurrency, commands } = JSON.parse(input);
  const results = new Array(commands.length);
  let started = 0;
  let finished = 0;
  const startNext = () => {
    // An expired command completes synchronously and may already have started the rest.
    if (started >= commands.length) return;
    const index = started++;
    run(commands[index], (result) => {
      results[index] = result;
      finished += 1;
      if (finished === commands.length) process.stdout.write(JSON.stringify(results));
      else if (started < commands.length) startNext();
    });
  };
  if (commands.length === 0) process.stdout.write("[]");
  for (let slot = 0; slot < Math.min(concurrency, commands.length); slot += 1) startNext();
});
function run(command, done) {
  const timeoutMs = command.deadlineAt === undefined ? undefined : command.deadlineAt - Date.now();
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    done({ expired: true });
    return;
  }
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let errorCode;
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["ignore", "pipe", command.stderr],
  });
  const fail = (code) => {
    if (errorCode) return;
    errorCode = code;
    child.kill("SIGTERM");
  };
  const collect = (chunks) => (chunk) => {
    bytes += chunk.length;
    if (bytes > command.maxBuffer) fail("ENOBUFS");
    else chunks.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  if (child.stderr) child.stderr.on("data", collect(stderr));
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => fail("ETIMEDOUT"), timeoutMs);
  child.on("error", (error) => { errorCode ??= error.code ?? "EUNKNOWN"; });
  child.on("close", (status, signal) => {
    clearTimeout(timer);
    done({
      status: errorCode ? null : status,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      errorCode,
    });
  });
}
`;

/**
 * `runText` for independent commands, at most `concurrency` running at once.
 * Blocks until all finish; each result has `runText`'s output trimming, the
 * error `runText` would have thrown, or `expired` when the command's deadline
 * passed before a slot was free.
 */
export function runTextConcurrently(
  commands: ReadonlyArray<{ command: string; args: string[]; options?: ConcurrentRunOptions }>,
  concurrency: number,
): ConcurrentRunResult[] {
  const prepared = commands.map(({ command, args, options = {} }) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env };
    return { resolved: resolveCommand(command, args, env), env, options };
  });
  const outputLimit = prepared.reduce(
    (total, { options }) => total + (options.maxBuffer ?? 64 * 1024 * 1024),
    0,
  );
  const batch = spawnSync(process.execPath, ["-e", CONCURRENT_RUN_SCRIPT], {
    encoding: "utf8",
    input: JSON.stringify({
      concurrency: Math.max(1, Math.floor(concurrency)),
      commands: prepared.map(({ resolved, env, options }) => ({
        file: resolved.command,
        args: resolved.args,
        cwd: options.cwd,
        env,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        stderr: options.stdio?.[2] ?? "pipe",
        deadlineAt: options.deadlineAt,
      })),
    }),
    // JSON escaping can double the commands' combined output; stay under one string's limit.
    maxBuffer: Math.min(outputLimit * 2 + 1024 * 1024, 1024 * 1024 * 1024),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (batch.error || batch.status !== 0) {
    const failure =
      batch.error ?? new Error(`Concurrent command runner failed: ${String(batch.stderr).trim()}`);
    return commands.map(() => ({ error: failure }));
  }
  const results = JSON.parse(batch.stdout) as SpawnedCommandResult[];
  return results.map((result, index): ConcurrentRunResult => {
    if (result.expired) return { expired: true };
    const { resolved, options } = prepared[index]!;
    const details = {
      status: result.status,
      signal: result.signal,
      output: [null, result.stdout, result.stderr],
      stdout: result.stdout,
      stderr: result.stderr,
    };
    // Same messages execFileSync produces, so failure classification is shared.
    if (result.errorCode) {
      const error = Object.assign(new Error(`spawnSync ${resolved.command} ${result.errorCode}`), {
        code: result.errorCode,
        ...details,
      });
      return { error: explainSpawnFailure(error, resolved.command, options.cwd) };
    }
    if (result.status !== 0) {
      const message = `Command failed: ${[resolved.command, ...resolved.args].join(" ")}${
        result.stderr ? `\n${result.stderr}` : ""
      }`;
      return { error: Object.assign(new Error(message), details) };
    }
    const trim = options.trim ?? "end";
    if (trim === "both") return { output: result.stdout.trim() };
    if (trim === "end") return { output: result.stdout.trimEnd() };
    return { output: result.stdout };
  });
}

export function explainSpawnFailure(error: unknown, command: string, cwd?: string): unknown {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    if (cwd && !existsSync(cwd)) {
      return new UserFacingCommandError(
        `Working directory not found while running ${command}: ${cwd}. Check --target-dir or create the checkout first.`,
      );
    }
    return new UserFacingCommandError(
      `Command not found while running ${command}. Ensure ${command} is installed and available on PATH, or set the appropriate *_BIN override.`,
    );
  }
  return error;
}

export function resolveCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CommandInvocation {
  const key = commandBinKey(command);
  const configured = env[`${key}_BIN`]?.trim();
  if (configured) {
    return {
      command: configured,
      args: [...envArgs(`${key}_BIN_ARGS`, env), ...args],
    };
  }
  return { command, args: [...args] };
}

export function resolveSpawnCommand(
  command: string,
  args: readonly string[],
  {
    cwd = process.cwd(),
    env = process.env,
    missingCommandMessage,
    platform = process.platform,
  }: ResolveSpawnCommandOptions = {},
): CommandInvocation {
  const resolved = resolveCommand(command, args, env);
  if (platform !== "win32") return resolved;

  const windowsCommand = resolveWindowsCommand(resolved.command, env, cwd);
  if (!windowsCommand) {
    if (missingCommandMessage) throw new Error(missingCommandMessage);
    return resolved;
  }
  if (nodeShebangScript(windowsCommand)) {
    return { command: process.execPath, args: [windowsCommand, ...resolved.args] };
  }
  if (windowsExecutablePattern.test(windowsCommand)) {
    return { command: windowsCommand, args: resolved.args };
  }
  if (!windowsBatchLauncherPattern.test(windowsCommand)) {
    return { command: windowsCommand, args: resolved.args };
  }

  const shellCommand = [
    escapeWindowsCommand(normalize(windowsCommand)),
    ...resolved.args.map(escapeWindowsArgument),
  ].join(" ");
  return {
    command: windowsSystemExecutable("cmd.exe", env),
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

function commandBinKey(command: string): string {
  return command.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

export function envArgs(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env[name];
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | undefined {
  if (isAbsolute(command) || /[\\/]/.test(command)) return resolve(cwd, command);
  const extensions = (windowsEnvironmentValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  let unsupportedExtensionlessCommand: string | undefined;
  for (const directory of (windowsEnvironmentValue(env, "PATH") || "")
    .split(delimiter)
    .filter(Boolean)) {
    const parent = resolve(cwd, directory);
    for (const candidate of extensions.map((extension) => `${command}${extension}`)) {
      const filePath = resolve(parent, candidate);
      const actualPath = actualCasePath(parent, candidate);
      if (actualPath || existsSync(filePath)) return actualPath ?? filePath;
    }
    const extensionlessCommand = actualCasePath(parent, command) ?? resolve(parent, command);
    if (existsSync(extensionlessCommand)) {
      if (nodeShebangScript(extensionlessCommand)) return extensionlessCommand;
      unsupportedExtensionlessCommand ??= extensionlessCommand;
    }
  }
  return unsupportedExtensionlessCommand;
}

function actualCasePath(parent: string, candidate: string): string | undefined {
  try {
    const lowerCandidate = candidate.toLowerCase();
    const entry = readdirSync(parent).find((name) => name.toLowerCase() === lowerCandidate);
    return entry ? resolve(parent, entry) : undefined;
  } catch {
    return undefined;
  }
}

export function windowsSystemExecutable(name: string, env: NodeJS.ProcessEnv): string {
  const systemRoot =
    windowsEnvironmentValue(env, "SystemRoot") || windowsEnvironmentValue(env, "windir");
  if (systemRoot) return join(systemRoot, "System32", name);
  const comSpec = windowsEnvironmentValue(env, "ComSpec");
  if (comSpec && isAbsolute(comSpec)) return join(dirname(comSpec), name);
  throw new Error(`Unable to resolve Windows system executable: ${name}`);
}

export function windowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1]?.trim() || undefined;
}

function nodeShebangScript(filePath: string): boolean {
  if (windowsExecutablePattern.test(filePath) || windowsBatchLauncherPattern.test(filePath)) {
    return false;
  }
  try {
    const firstLine = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    return /^#!.*\bnode\b/i.test(firstLine);
  } catch {
    return false;
  }
}

function escapeWindowsCommand(value: string): string {
  return value.replace(windowsMetaCharacterPattern, "^$1");
}

function escapeWindowsArgument(value: string): string {
  let escaped = quoteWindowsArgument(value);
  escaped = escaped.replace(windowsMetaCharacterPattern, "^$1");
  return escaped.replace(windowsMetaCharacterPattern, "^$1");
}

function quoteWindowsArgument(value: string): string {
  let escaped = '"';
  let backslashes = 0;

  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      escaped += "\\".repeat(backslashes * 2 + 1);
      escaped += char;
      backslashes = 0;
      continue;
    }
    escaped += "\\".repeat(backslashes);
    escaped += char;
    backslashes = 0;
  }

  escaped += "\\".repeat(backslashes * 2);
  escaped += '"';
  return escaped;
}
