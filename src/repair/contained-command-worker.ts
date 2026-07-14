#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";

import { windowsSystemExecutable } from "../command.js";
import { ProcessTreeTracker } from "./process-tree-containment.js";

type WorkerInput = {
  args: string[];
  command: string;
  cwd?: string;
  input?: string;
  maxBuffer: number;
  timeoutMs?: number;
  windowsVerbatimArguments: boolean;
};

type WorkerResult = {
  backgroundProcesses: number;
  error?: { code: string | undefined; message: string };
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

const input = JSON.parse(await readStdin()) as WorkerInput;
const result = await runContained(input);
process.stdout.write(JSON.stringify(result));

async function runContained(input: WorkerInput): Promise<WorkerResult> {
  const invocation =
    process.platform === "win32"
      ? { command: input.command, args: input.args }
      : {
          command: "/bin/sh",
          args: [
            "-c",
            'kill -STOP "$$"; exec "$@"',
            "clawsweeper-validation",
            input.command,
            ...input.args,
          ],
        };
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    ...(input.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const tracker = child.pid ? new ProcessTreeTracker(child.pid) : null;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const spawnFailure: {
    value: { code: string | undefined; message: string } | null;
  } = { value: null };
  let timedOut = false;
  let overflow = false;
  let forcedTermination: NodeJS.Timeout | undefined;
  const requestTermination = () => {
    terminateProcessTree(child.pid);
    if (process.platform !== "win32" && child.pid && !forcedTermination) {
      forcedTermination = setTimeout(() => signalProcessGroup(child.pid!, "SIGKILL"), 250);
      forcedTermination.unref();
    }
  };
  child.on("error", (error) => {
    spawnFailure.value = {
      code: (error as NodeJS.ErrnoException).code,
      message: error.message,
    };
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (overflow) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > input.maxBuffer) {
      overflow = true;
      requestTermination();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (overflow) return;
    stderrBytes += chunk.length;
    if (stderrBytes > input.maxBuffer) {
      overflow = true;
      requestTermination();
      return;
    }
    stderr.push(chunk);
  });
  if (process.platform !== "win32" && child.pid) {
    await waitForStoppedProcess(child.pid);
  }
  try {
    tracker?.start();
  } catch (error) {
    if (process.platform === "win32" && child.pid) terminateWindowsProcessTree(child.pid);
    else if (child.pid) signalProcessGroup(child.pid, "SIGKILL");
    throw error;
  }
  if (process.platform !== "win32" && child.pid) {
    signalProcessGroup(child.pid, "SIGCONT");
  }
  if (input.input !== undefined) child.stdin.end(input.input);
  else child.stdin.end();
  const timeout =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          requestTermination();
        }, input.timeoutMs);
  timeout?.unref();
  const exit = await new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
    (resolve) => {
      child.once("close", (status, signal) => resolve({ signal, status }));
    },
  );
  if (timeout) clearTimeout(timeout);
  if (forcedTermination) clearTimeout(forcedTermination);
  let trackingError: Error | null = null;
  let backgroundPids: number[] = [];
  try {
    backgroundPids = tracker?.stop() ?? [];
  } catch (error) {
    trackingError = error as Error;
    backgroundPids = liveProcessIds(
      (tracker?.trackedPids() ?? []).filter((trackedPid) => trackedPid !== child.pid),
    );
  }
  const backgroundProcesses = await reapProcessTree(child.pid, backgroundPids);
  if (trackingError) throw trackingError;
  const error = spawnFailure.value
    ? { code: spawnFailure.value.code, message: spawnFailure.value.message }
    : timedOut
      ? { code: "ETIMEDOUT", message: "validation command timed out" }
      : overflow
        ? { code: "ENOBUFS", message: "validation command output exceeded the buffer limit" }
        : undefined;
  return {
    backgroundProcesses,
    ...(error ? { error } : {}),
    signal: exit.signal,
    status: exit.status,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function reapProcessTree(pid: number | undefined, backgroundPids: readonly number[]) {
  if (!pid) return 0;
  if (process.platform === "win32") {
    for (const trackedPid of new Set([pid, ...backgroundPids])) {
      terminateWindowsProcessTree(trackedPid);
    }
    return backgroundPids.length;
  }

  let found = signalProcessGroup(pid, "SIGTERM");
  found ||= backgroundPids.length > 0;
  signalProcesses(backgroundPids, "SIGTERM");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(25);
    signalProcessGroup(pid, "SIGKILL");
    const livePids = liveProcessIds(backgroundPids);
    if (livePids.length === 0) return found ? 1 : 0;
    signalProcesses(livePids, "SIGKILL");
  }
  const livePids = liveProcessIds(backgroundPids);
  if (livePids.length > 0) {
    throw new Error(`could not reap validation process tree: ${livePids.join(", ")}`);
  }
  return found ? 1 : 0;
}

function terminateProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    terminateWindowsProcessTree(pid);
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
}

function terminateWindowsProcessTree(pid: number) {
  spawnSync(
    windowsSystemExecutable("taskkill.exe", process.env),
    ["/pid", String(pid), "/t", "/f"],
    { stdio: "ignore", windowsHide: true },
  );
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalProcesses(pids: readonly number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function liveProcessIds(pids: readonly number[]) {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  });
}

async function waitForStoppedProcess(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error(
        `could not establish validation process containment: ${result.error?.message || result.stderr || result.status}`,
      );
    }
    const state = String(result.stdout ?? "").trim();
    if (state.startsWith("T")) return;
    if (!state) {
      throw new Error("validation command exited before process containment was established");
    }
    await sleep(5);
  }
  throw new Error("timed out establishing validation process containment");
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
