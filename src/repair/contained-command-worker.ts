#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

import { windowsSystemExecutable } from "../command.js";

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
  const marker = `CS_VALIDATION_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, [marker]: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    ...(input.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const spawnFailure: {
    value: { code: string | undefined; message: string } | null;
  } = { value: null };
  let timedOut = false;
  let overflow = false;
  child.on("error", (error) => {
    spawnFailure.value = {
      code: (error as NodeJS.ErrnoException).code,
      message: error.message,
    };
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > input.maxBuffer) {
      overflow = true;
      terminateProcessTree(child.pid);
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > input.maxBuffer) {
      overflow = true;
      terminateProcessTree(child.pid);
      return;
    }
    stderr.push(chunk);
  });
  if (input.input !== undefined) child.stdin.end(input.input);
  else child.stdin.end();
  let forcedTermination: NodeJS.Timeout | undefined;
  const timeout =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child.pid);
          if (process.platform !== "win32" && child.pid) {
            forcedTermination = setTimeout(() => signalProcessGroup(child.pid!, "SIGKILL"), 250);
            forcedTermination.unref();
          }
        }, input.timeoutMs);
  timeout?.unref();
  const exit = await new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
    (resolve) => {
      child.once("close", (status, signal) => resolve({ signal, status }));
    },
  );
  if (timeout) clearTimeout(timeout);
  if (forcedTermination) clearTimeout(forcedTermination);
  const backgroundProcesses = await reapProcessTree(child.pid, marker);
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

async function reapProcessTree(pid: number | undefined, marker: string) {
  if (!pid) return 0;
  if (process.platform === "win32") {
    const result = spawnSync(
      windowsSystemExecutable("taskkill.exe", process.env),
      ["/pid", String(pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    return result.status === 0 ? 1 : 0;
  }

  let found = signalProcessGroup(pid, "SIGTERM");
  let marked = markedProcessIds(marker);
  found ||= marked.length > 0;
  signalProcesses(marked, "SIGTERM");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(25);
    signalProcessGroup(pid, "SIGKILL");
    marked = markedProcessIds(marker);
    if (marked.length === 0) return found ? 1 : 0;
    signalProcesses(marked, "SIGKILL");
  }
  marked = markedProcessIds(marker);
  if (marked.length > 0) {
    throw new Error(`could not reap validation process tree: ${marked.join(", ")}`);
  }
  return found ? 1 : 0;
}

function terminateProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync(
      windowsSystemExecutable("taskkill.exe", process.env),
      ["/pid", String(pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
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

function markedProcessIds(marker: string) {
  const result = spawnSync(
    "/bin/ps",
    process.platform === "darwin" ? ["eww", "-axo", "pid=,command="] : ["eww", "-eo", "pid=,args="],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not inspect validation process tree: ${result.error?.message || result.stderr || result.status}`,
    );
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.includes(`${marker}=1`))
    .map((line) => Number.parseInt(line.trimStart().split(/\s+/, 1)[0] ?? "", 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
