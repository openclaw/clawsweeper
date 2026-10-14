import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forceTerminateProcessTree } from "./repair/contained-command-worker.js";
import { signalProcessGroup } from "./process-group.js";
import { ValidationRecoveryRequiredError } from "./validation-recovery.js";
import { parseWorkerResult, serializedWorkerMaxBuffer } from "./command-worker-result.js";

/** Trusted Git transport; validation commands must use the contained entrypoint. */
export function runGitAcquisitionResult(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string | undefined;
    maxBuffer: number;
    timeoutMs: number;
  },
): SpawnSyncReturns<string> {
  const deadlineAt = Date.now() + options.timeoutMs;
  const cwd = resolve(options.cwd);
  // Reserve startup, graceful termination, escalation and settlement inside the
  // caller's attempt. An outer timeout never grants another cleanup budget.
  const graceMs = Math.max(1, Math.floor(Math.min(1_000, options.timeoutMs / 2) / 4));
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./git-acquisition-worker.js", import.meta.url))],
    {
      cwd,
      env: options.env,
      input: JSON.stringify({
        args,
        cwd,
        input: options.input,
        maxBuffer: options.maxBuffer,
        timeoutMs: options.timeoutMs,
        deadlineAt: deadlineAt - graceMs,
        graceMs,
      }),
      encoding: "utf8",
      maxBuffer: serializedWorkerMaxBuffer(options.maxBuffer),
      timeout: Math.max(1, deadlineAt - Date.now() - graceMs),
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  let pid: number | null | undefined;
  try {
    const separator = worker.stdout.indexOf("\n");
    if (separator < 0 || separator > 128) throw new Error("missing ownership header");
    const header = JSON.parse(worker.stdout.slice(0, separator)) as { pid: unknown };
    if (header.pid !== null && (!Number.isSafeInteger(header.pid) || Number(header.pid) <= 1))
      throw new Error("invalid ownership header");
    pid = header.pid as number | null;
    if (worker.error || worker.status !== 0) throw new Error("supervisor did not complete");
    const result = parseWorkerResult(worker.stdout.slice(separator + 1));
    return {
      ...worker,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.error
        ? { error: Object.assign(new Error(result.error.message), { code: result.error.code }) }
        : {}),
    };
  } catch {
    // Only a supervisor-written PID proves ownership. Missing/invalid receipts
    // are terminal, including when cleanup cannot prove the group has settled.
    if (pid) {
      try {
        forceTerminateProcessTree(pid, deadlineAt);
        while (process.platform !== "win32" && signalProcessGroup(pid, 0, deadlineAt)) {
          if (Date.now() >= deadlineAt) break;
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            Math.min(10, deadlineAt - Date.now()),
          );
        }
      } catch {
        /* Completion stays unverified; never retry this workspace. */
      }
    }
    return {
      ...worker,
      status: null,
      stdout: "",
      stderr:
        "Git acquisition process completion could not be verified; do not retry this workspace",
      error: Object.assign(
        new ValidationRecoveryRequiredError(
          "Git acquisition process completion could not be verified",
          worker.error,
          [cwd],
        ),
        { code: "EPROCESSSETTLEMENT" },
      ),
    };
  }
}
