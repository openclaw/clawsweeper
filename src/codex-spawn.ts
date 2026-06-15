import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, normalize, resolve } from "node:path";

export interface CodexSpawnInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const windowsExecutablePattern = /\.(?:com|exe)$/i;
const windowsCommandShimPattern = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
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
  const doubleEscapeMetaCharacters = windowsCommandShimPattern.test(normalizedCommand);
  const shellCommand = [
    escapeWindowsCommand(normalizedCommand),
    ...args.map((arg) => escapeWindowsArgument(arg, doubleEscapeMetaCharacters)),
  ].join(" ");
  return {
    command: env.ComSpec?.trim() || env.comspec?.trim() || "cmd.exe",
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
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    return undefined;
  }

  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), forceAfterMs);
  timer.unref();
  return timer;
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
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    return command;
  }
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const candidates = extensions.includes("")
    ? [command]
    : [command, ...extensions.map((extension) => `${command}${extension}`)];
  for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const filePath = resolve(cwd, directory, candidate);
      if (existsSync(filePath)) return filePath;
    }
  }
  return command;
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
