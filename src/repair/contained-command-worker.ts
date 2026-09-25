#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSpawnCommand, windowsSystemExecutable } from "../command.js";
import { createTrustedSandboxRoot } from "./contained-command-sandbox.js";
import { LINUX_SUBREAPER_SCRIPT } from "./process-tree-containment.js";

type WorkerInput = {
  args: string[];
  command: string;
  cwd?: string;
  input?: string;
  isolateNetwork: boolean;
  maxBuffer: number;
  timeoutMs?: number;
  writableRoots: string[];
  windowsVerbatimArguments: boolean;
};

type WorkerResult = {
  backgroundProcesses: number;
  capabilitySummary?: ContainmentCapabilitySummary;
  error?: { code: string | undefined; message: string };
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

export type ContainmentCapabilitySummary = {
  landlock: string;
  mountReadonly: "legacy" | "native";
};

type ContainmentProtocol = {
  backgroundProcesses?: number;
  capabilitySummary?: {
    landlock?: unknown;
    mount_readonly?: unknown;
  };
  containmentError?: {
    errno?: unknown;
    stage?: unknown;
    syscall?: unknown;
  };
  signal?: NodeJS.Signals | null;
  status?: number | null;
};

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as WorkerInput;
  const result = await runContained(input);
  process.stdout.write(JSON.stringify(result));
}

// This entrypoint runs only trusted Git transport, not validation commands. The
// validation entrypoint never reads a containment selector from input or env.
export async function runTrustedGitAcquisitionWorker(): Promise<void> {
  const input = JSON.parse(await readStdin()) as {
    args: string[];
    cwd: string;
    input?: string;
    maxBuffer: number;
    deadlineAt: number;
    graceMs: number;
  };
  const invocation = resolveSpawnCommand("git", input.args, { cwd: input.cwd });
  const result = await runContained(
    {
      ...input,
      ...invocation,
      isolateNetwork: false,
      writableRoots: [],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    },
    { deadlineAt: input.deadlineAt, graceMs: input.graceMs },
  );
  process.stdout.write(JSON.stringify(result));
}

async function runContained(
  input: WorkerInput,
  acquisition?: { deadlineAt: number; graceMs: number },
): Promise<WorkerResult> {
  if (!acquisition && process.platform !== "linux" && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error("validation process containment requires Linux");
  }
  const useLinuxNamespace =
    !acquisition &&
    process.platform === "linux" &&
    (process.env.NODE_TEST_CONTEXT === undefined ||
      process.env.CLAWSWEEPER_TEST_FORCE_LINUX_CONTAINMENT === "1");
  if (useLinuxNamespace && input.writableRoots.length === 0) {
    throw new Error("validation filesystem isolation requires explicit writable roots");
  }
  const sandboxRoot = useLinuxNamespace ? createTrustedSandboxRoot(input.writableRoots) : undefined;
  const invocation = useLinuxNamespace
    ? {
        command: "/usr/bin/unshare",
        args: [
          "--user",
          "--map-root-user",
          "--mount",
          ...(input.isolateNetwork ? ["--net"] : []),
          "--pid",
          "--fork",
          "--mount-proc",
          "--kill-child=SIGKILL",
          "/usr/bin/python3",
          "-c",
          LINUX_SUBREAPER_SCRIPT,
          JSON.stringify(input.writableRoots),
          JSON.stringify(input.isolateNetwork),
          sandboxRoot!,
          input.command,
          ...input.args,
        ],
      }
    : process.platform === "win32"
      ? { command: input.command, args: input.args }
      : {
          command: "/bin/sh",
          args: ["-c", 'exec "$@"', "clawsweeper-validation", input.command, ...input.args],
        };
  if (acquisition && Date.now() + 2 * acquisition.graceMs >= acquisition.deadlineAt) {
    throw new Error("Git acquisition deadline expired before process admission");
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: process.env,
    stdio: useLinuxNamespace ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    ...(input.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  // Git output is captured below and cannot write this supervisor-only header.
  // The synchronous caller needs ownership evidence if this worker is killed.
  if (acquisition) fs.writeSync(1, `${JSON.stringify({ pid: child.pid ?? null })}\n`);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const protocol: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let protocolBytes = 0;
  let inputFailure: { code: string | undefined; message: string } | undefined;
  // Git can reject the request before consuming a full --stdin object list.
  // Settle its process and preserve that exit instead of crashing on EPIPE.
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    inputFailure = { code: error.code, message: error.message };
  });
  const spawnFailure: {
    value: { code: string | undefined; message: string } | null;
  } = { value: null };
  let timedOut = false;
  let overflow = false;
  let windowsTreeSettled = false;
  let forcedTermination: NodeJS.Timeout | undefined;
  const requestTermination = () => {
    terminateProcessTree(child.pid, acquisition?.deadlineAt);
    if (acquisition && process.platform === "win32") windowsTreeSettled = true;
    if (process.platform !== "win32" && child.pid && !forcedTermination) {
      // Linux init owns escalation and reaping, including detached descendants.
      // Give it time to publish completion before the outer fail-closed kill.
      forcedTermination = setTimeout(
        () => forceTerminateProcessTree(child.pid!, acquisition?.deadlineAt),
        acquisition?.graceMs ?? (useLinuxNamespace ? 3_000 : 250),
      );
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
  const protocolStream = useLinuxNamespace ? child.stdio[3] : null;
  protocolStream?.on("data", (chunk: Buffer) => {
    protocolBytes += chunk.length;
    if (protocolBytes > 64 * 1024) {
      overflow = true;
      requestTermination();
      return;
    }
    protocol.push(chunk);
  });
  if (input.input !== undefined) child.stdin.end(input.input);
  else child.stdin.end();
  const timeout =
    input.timeoutMs === undefined && !acquisition
      ? undefined
      : setTimeout(
          () => {
            timedOut = true;
            requestTermination();
          },
          acquisition
            ? Math.max(1, acquisition.deadlineAt - Date.now() - 2 * acquisition.graceMs)
            : input.timeoutMs,
        );
  timeout?.unref();
  const exit = await new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
    (resolve) => {
      child.once("close", (status, signal) => resolve({ signal, status }));
    },
  );
  if (timeout) clearTimeout(timeout);
  if (forcedTermination) clearTimeout(forcedTermination);
  if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true });

  let contained: {
    backgroundProcesses: number;
    capabilitySummary?: ContainmentCapabilitySummary;
    signal: NodeJS.Signals | null;
    status: number | null;
  };
  if (useLinuxNamespace) {
    try {
      contained = parseContainmentProtocol(protocol, exit);
    } catch (error) {
      await reapProcessGroup(child.pid);
      throw error;
    }
  } else if (acquisition && process.platform === "win32") {
    // taskkill must succeed while the parent still identifies its tree. A
    // second call after close cannot prove anything about orphaned descendants.
    if ((timedOut || overflow || exit.signal !== null) && !windowsTreeSettled)
      throw new Error("Git acquisition process-tree settlement could not be verified");
    contained = { backgroundProcesses: 0, ...exit };
  } else {
    contained = {
      backgroundProcesses: await reapProcessGroup(child.pid, acquisition?.deadlineAt),
      signal: exit.signal,
      status: exit.status,
    };
  }
  const error = spawnFailure.value
    ? { code: spawnFailure.value.code, message: spawnFailure.value.message }
    : timedOut
      ? {
          code: "ETIMEDOUT",
          message: acquisition ? "Git acquisition timed out" : "validation command timed out",
        }
      : overflow
        ? { code: "ENOBUFS", message: "validation command output exceeded the buffer limit" }
        : contained.status === 0
          ? inputFailure
          : undefined;
  return {
    backgroundProcesses: contained.backgroundProcesses,
    ...(contained.capabilitySummary ? { capabilitySummary: contained.capabilitySummary } : {}),
    ...(error ? { error } : {}),
    signal: contained.signal,
    status: contained.status,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

export function parseContainmentProtocol(
  chunks: readonly Buffer[],
  exit: { signal: NodeJS.Signals | null; status: number | null },
) {
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error(
      `validation process containment failed: stage=namespace_setup exit=${exit.status ?? exit.signal ?? "unknown"}`,
    );
  }
  let result: ContainmentProtocol;
  try {
    result = JSON.parse(raw) as ContainmentProtocol;
  } catch {
    throw new Error("validation subreaper returned an invalid result");
  }
  if (result.containmentError) {
    const stage = safeDiagnosticToken(result.containmentError.stage, "unknown");
    const syscall = safeDiagnosticInteger(result.containmentError.syscall);
    const errorNumber = safeDiagnosticInteger(result.containmentError.errno);
    throw new Error(
      [
        "validation process containment failed:",
        `stage=${stage}`,
        ...(syscall === undefined ? [] : [`syscall=${syscall}`]),
        ...(errorNumber === undefined ? [] : [`errno=${errorNumber}`]),
      ].join(" "),
    );
  }
  const mountReadonly = result.capabilitySummary?.mount_readonly;
  const landlock = result.capabilitySummary?.landlock;
  if (
    exit.status !== 0 ||
    !Number.isInteger(result.backgroundProcesses) ||
    result.backgroundProcesses! < 0 ||
    (result.status !== null && !Number.isInteger(result.status)) ||
    (result.signal !== null && typeof result.signal !== "string") ||
    (mountReadonly !== "native" && mountReadonly !== "legacy") ||
    typeof landlock !== "string" ||
    !/^(?:abi-[0-9]+|unavailable)$/.test(landlock)
  ) {
    throw new Error("validation subreaper returned an invalid result");
  }
  return {
    backgroundProcesses: result.backgroundProcesses!,
    capabilitySummary: {
      landlock: landlock as string,
      mountReadonly: mountReadonly as "legacy" | "native",
    },
    signal: result.signal ?? null,
    status: result.status ?? null,
  };
}

function safeDiagnosticInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function safeDiagnosticToken(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z_]+$/.test(value) ? value : fallback;
}

async function reapProcessGroup(pid: number | undefined, deadlineAt?: number) {
  if (!pid) return 0;
  if (process.platform === "win32") {
    terminateWindowsProcessTree(pid, deadlineAt);
    return 0;
  }
  const found = signalProcessGroup(pid, "SIGTERM");
  if (!found) return 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) break;
    await sleep(deadlineAt === undefined ? 25 : Math.min(25, Math.max(1, deadlineAt - Date.now())));
    if (!signalProcessGroup(pid, "SIGKILL")) return 1;
  }
  if (signalProcessGroup(pid, "SIGKILL")) {
    throw new Error("could not reap validation process group");
  }
  return 1;
}

function terminateProcessTree(pid: number | undefined, deadlineAt?: number) {
  if (!pid) return;
  if (process.platform === "linux") {
    signalProcessGroup(pid, "SIGTERM");
    return;
  }
  if (process.platform === "win32") {
    terminateWindowsProcessTree(pid, deadlineAt);
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
}

export function forceTerminateProcessTree(pid: number, deadlineAt?: number) {
  if (process.platform === "win32") {
    terminateWindowsProcessTree(pid, deadlineAt);
    return;
  }
  signalProcessGroup(pid, "SIGKILL");
}

function terminateWindowsProcessTree(pid: number, deadlineAt?: number) {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt)
    throw new Error("process-tree settlement deadline expired");
  const result = spawnSync(
    windowsSystemExecutable("taskkill.exe", process.env),
    ["/pid", String(pid), "/t", "/f"],
    {
      stdio: "ignore",
      windowsHide: true,
      ...(deadlineAt === undefined
        ? {}
        : { timeout: Math.max(1, deadlineAt - Date.now()), killSignal: "SIGKILL" as const }),
    },
  );
  if (deadlineAt !== undefined && (result.error || result.status !== 0))
    throw new Error("process-tree settlement could not be verified", { cause: result.error });
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    // The worker is a security boundary: return its validated diagnostic only,
    // never a stack trace containing runner paths or target command details.
    process.stderr.write(
      error instanceof Error ? error.message : "validation process containment failed",
    );
    process.exitCode = 1;
  }
}
