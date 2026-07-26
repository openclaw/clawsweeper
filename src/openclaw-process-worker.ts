import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "./codex-output-capture.js";
import { resolveSpawnCommand, windowsSystemExecutable } from "./command.js";

interface WorkerOptions {
  args: string[];
  command: string;
  timeoutMs: number;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  tailBytes: number;
  maxOutputFileBytes: number;
}

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerOptions;
const stdout = openCodexOutputCapture(options.stdoutPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
});
const stderr = openCodexOutputCapture(options.stderrPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
});
const invocation = resolveSpawnCommand(options.command, options.args, {
  cwd: process.cwd(),
  env: process.env,
  missingCommandMessage: `Unable to resolve OpenClaw command: ${options.command}`,
});
const child = spawn(invocation.command, invocation.args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
  ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
});
let spawnError: Error | undefined;
let timeoutError: Error | undefined;
let forceKillTimer: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`OpenClaw process timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  forceKillTimer = terminateProcessTree(child);
}, options.timeoutMs);

child.stdout.on("data", (chunk: Buffer) => appendCodexOutputCapture(stdout, chunk));
child.stderr.on("data", (chunk: Buffer) => appendCodexOutputCapture(stderr, chunk));
child.once("error", (error) => {
  spawnError = error;
});
child.once("close", (status, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  clearTimeout(timeout);
  closeCodexOutputCapture(stdout);
  closeCodexOutputCapture(stderr);
  writeFileSync(
    options.resultPath,
    JSON.stringify({
      status,
      signal,
      ...(timeoutError || spawnError
        ? { error: serializedError(timeoutError ?? spawnError!) }
        : {}),
      stdout: codexOutputTail(stdout),
      stderr: codexOutputTail(stderr),
    }),
    "utf8",
  );
  process.exit(0);
});

function terminateProcessTree(childProcess: ChildProcess): NodeJS.Timeout | undefined {
  if (process.platform === "win32") {
    if (childProcess.pid) {
      spawnSync(
        windowsSystemExecutable("taskkill.exe", process.env),
        ["/pid", String(childProcess.pid), "/t", "/f"],
        { stdio: "ignore", windowsHide: true },
      );
    }
    return undefined;
  }
  signalProcessGroup(childProcess, "SIGTERM");
  const timer = setTimeout(() => signalProcessGroup(childProcess, "SIGKILL"), 1_000);
  timer.unref();
  return timer;
}

function signalProcessGroup(childProcess: ChildProcess, signal: NodeJS.Signals): void {
  if (!childProcess.pid) return;
  try {
    process.kill(-childProcess.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function serializedError(error: Error): { message: string; code?: string } {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}
