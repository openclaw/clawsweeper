import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";

export interface CodexSpawnInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const windowsExecutablePattern = /\.(?:com|exe)$/i;
const windowsBatchLauncherPattern = /\.(?:bat|cmd)$/i;
const windowsMetaCharacterPattern = /([()\][%!^"`<>&|;, *?])/g;

export function codexProcessCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_BIN?.trim() || "codex";
}

export function codexSpawnInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): CodexSpawnInvocation {
  const configuredCommand = codexProcessCommand(env);
  const command =
    platform === "win32" ? resolveWindowsCommand(configuredCommand, env, cwd) : configuredCommand;
  if (platform !== "win32" || windowsExecutablePattern.test(command)) {
    return { command, args: [...args] };
  }

  const normalizedCommand = normalize(command);
  const doubleEscapeMetaCharacters = windowsBatchLauncherPattern.test(normalizedCommand);
  const shellCommand = [
    escapeWindowsCommand(normalizedCommand),
    ...args.map((arg) => escapeWindowsArgument(arg, doubleEscapeMetaCharacters)),
  ].join(" ");
  return {
    command: windowsSystemExecutable("cmd.exe", env),
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export function terminateCodexProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  forceAfterMs = 1_000,
): NodeJS.Timeout | undefined {
  if (process.platform === "win32") {
    if (child.pid) {
      spawnSync(
        windowsSystemExecutable("taskkill.exe", process.env),
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
    }
    return undefined;
  }

  signalPosixProcessGroup(child, signal);
  const timer = setTimeout(() => signalPosixProcessGroup(child, "SIGKILL"), forceAfterMs);
  timer.unref();
  return timer;
}

export function waitForCodexProcessExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, timeoutMs);
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

export function spawnCodex(
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): ChildProcessWithoutNullStreams {
  const invocation = codexSpawnInvocation(args, options.env, process.platform, options.cwd);
  return spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

function signalPosixProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    return resolve(cwd, command);
  }
  const extensions = (windowsEnvironmentValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const candidates = extensions.includes("")
    ? [command]
    : [command, ...extensions.map((extension) => `${command}${extension}`)];
  for (const directory of (windowsEnvironmentValue(env, "PATH") || "")
    .split(delimiter)
    .filter(Boolean)) {
    for (const candidate of candidates) {
      const filePath = resolve(cwd, directory, candidate);
      if (existsSync(filePath)) return filePath;
    }
  }
  throw new Error(`Unable to resolve Windows Codex command: ${command}`);
}

function windowsSystemExecutable(name: string, env: NodeJS.ProcessEnv): string {
  const systemRoot =
    windowsEnvironmentValue(env, "SystemRoot") || windowsEnvironmentValue(env, "windir");
  if (systemRoot) return join(systemRoot, "System32", name);
  const comSpec = windowsEnvironmentValue(env, "ComSpec");
  if (comSpec && isAbsolute(comSpec)) return join(dirname(comSpec), name);
  throw new Error(`Unable to resolve Windows system executable: ${name}`);
}

function windowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1]?.trim() || undefined;
}

function escapeWindowsCommand(value: string): string {
  return value.replace(windowsMetaCharacterPattern, "^$1");
}

function escapeWindowsArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(windowsMetaCharacterPattern, "^$1");
  if (doubleEscapeMetaCharacters) {
    escaped = escaped.replace(windowsMetaCharacterPattern, "^$1");
  }
  return escaped;
}
