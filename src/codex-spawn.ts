import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { signalProcessGroup } from "./process-group.js";
import {
  resolveSpawnCommand,
  windowsEnvironmentValue,
  windowsSystemExecutable,
  type CommandInvocation,
} from "./command.js";

export type CodexSpawnInvocation = CommandInvocation;

const gracefulTerminations = new WeakSet<ChildProcess>();

export function codexProcessCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): string {
  const configured = env.CODEX_BIN?.trim();
  if (configured) return configured;
  if (platform === "win32") {
    try {
      const pathInvocation = resolveSpawnCommand("codex", [], {
        cwd,
        env,
        missingCommandMessage: "Unable to resolve Windows Codex command: codex",
        platform,
      });
      if (windowsInvocationIsSpawnable(pathInvocation)) return "codex";
    } catch {
      // Fall through to the Desktop app fallback below.
    }
    const appBinary = windowsCodexAppBinary(env);
    if (appBinary) return appBinary;
  }
  return "codex";
}

export function codexSpawnInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): CodexSpawnInvocation {
  const configuredCommand = codexProcessCommand(env, platform, cwd);
  return resolveSpawnCommand(configuredCommand, args, {
    cwd,
    env,
    missingCommandMessage: `Unable to resolve Windows Codex command: ${configuredCommand}`,
    platform,
  });
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

  if (signal !== "SIGKILL") gracefulTerminations.add(child);
  signalProcessGroup(child.pid, signal);
  if (signal === "SIGKILL") return undefined;
  const timer = setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), forceAfterMs);
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
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (process.platform !== "win32") {
    // Natural exits must not wait for descendant-held pipes; requested stops retain their grace.
    child.once("exit", () => {
      if (!gracefulTerminations.has(child)) signalProcessGroup(child.pid, "SIGKILL");
    });
  }
  return child;
}

function windowsCodexAppBinary(env: NodeJS.ProcessEnv): string | null {
  const localAppData =
    windowsEnvironmentValue(env, "LOCALAPPDATA") ||
    (windowsEnvironmentValue(env, "USERPROFILE")
      ? join(windowsEnvironmentValue(env, "USERPROFILE") as string, "AppData", "Local")
      : undefined);
  if (!localAppData) return null;
  const candidate = join(localAppData, "OpenAI", "Codex", "bin", "codex.exe");
  return existsSync(candidate) ? candidate : null;
}

function windowsInvocationIsSpawnable(invocation: CommandInvocation): boolean {
  return invocation.command === process.execPath || /\.(?:com|exe)$/i.test(invocation.command);
}
