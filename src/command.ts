import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";

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

function explainSpawnFailure(error: unknown, command: string, cwd?: string): unknown {
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
  const candidates = [command, ...extensions.map((extension) => `${command}${extension}`)];
  for (const directory of (windowsEnvironmentValue(env, "PATH") || "")
    .split(delimiter)
    .filter(Boolean)) {
    for (const candidate of candidates) {
      const parent = resolve(cwd, directory);
      const filePath = resolve(parent, candidate);
      const actualPath = actualCasePath(parent, candidate);
      if (actualPath || existsSync(filePath)) return actualPath ?? filePath;
    }
  }
  return undefined;
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
