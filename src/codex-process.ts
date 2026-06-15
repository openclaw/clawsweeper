import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_OUTPUT_FILE_BYTES,
  DEFAULT_CODEX_OUTPUT_TAIL_BYTES,
} from "./codex-output-capture.js";
import { codexProcessCommand } from "./codex-spawn.js";

export { codexProcessCommand, codexSpawnInvocation } from "./codex-spawn.js";

export interface CodexProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

interface SerializedCodexProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: {
    message: string;
    code?: string;
  };
  stdout: string;
  stderr: string;
}

const CODEX_PROCESS_WORKER_PATH = fileURLToPath(
  new URL("./codex-process-worker.js", import.meta.url),
);
const CODEX_APP_SERVER_WORKER_PATH = fileURLToPath(
  new URL("./codex-app-server-worker.js", import.meta.url),
);

export interface CodexAppServerProcessOptions {
  statePath: string;
  label?: string;
  runnerPtyUrl?: string;
  workStateUrl?: string;
  agentToken?: string;
}

export function codexAppServerProcessOptionsFromEnv(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexAppServerProcessOptions | undefined {
  if (env.CLAWSWEEPER_STEERABLE_CODEX !== "1") return undefined;
  const statePath =
    env.CLAWSWEEPER_CODEX_THREAD_STATE?.trim() ||
    join(env.CODEX_HOME?.trim() || tmpdir(), "clawsweeper-thread-state.json");
  return {
    statePath,
    label,
    ...(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL?.trim()
      ? { runnerPtyUrl: env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL.trim() }
      : {}),
    ...(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL?.trim()
      ? { workStateUrl: env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL.trim() }
      : {}),
    ...(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN?.trim()
      ? { agentToken: env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN.trim() }
      : {}),
  };
}

export function runCodexProcess(options: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  appServer?: CodexAppServerProcessOptions;
}): CodexProcessResult {
  const workDir = mkdtempSync(join(tmpdir(), "clawsweeper-codex-process-"));
  const optionsPath = join(workDir, "options.json");
  const resultPath = join(workDir, "result.json");
  const stdoutPath = options.stdoutPath ?? join(workDir, "stdout.log");
  const stderrPath = options.stderrPath ?? join(workDir, "stderr.log");
  try {
    writeFileSync(
      optionsPath,
      JSON.stringify({
        args: [...options.args],
        command: codexProcessCommand(options.env),
        timeoutMs: options.timeoutMs,
        resultPath,
        stdoutPath,
        stderrPath,
        tailBytes: normalizedTailBytes(options.tailBytes),
        maxOutputFileBytes: normalizedOutputFileBytes(options.outputFileBytes),
        ...(options.appServer ? { appServer: options.appServer } : {}),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const workerPath = options.appServer ? CODEX_APP_SERVER_WORKER_PATH : CODEX_PROCESS_WORKER_PATH;
    const worker = spawnSync(process.execPath, [workerPath, optionsPath], {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: options.timeoutMs + 10_000,
    });
    if (existsSync(resultPath)) {
      const result = deserializeProcessResult(JSON.parse(readFileSync(resultPath, "utf8")));
      return worker.error ? { ...result, error: worker.error } : result;
    }
    if (worker.error) return failedProcessResult(worker.error, worker.status, worker.signal);
    return failedProcessResult(
      new Error(
        `Codex process worker failed with exit ${worker.status ?? "unknown"} and did not write a result.`,
      ),
      worker.status,
      worker.signal,
    );
  } catch (error) {
    return failedProcessResult(error instanceof Error ? error : new Error(String(error)));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function codexProcessErrorCode(error: Error | undefined): string | null {
  if (!error || !("code" in error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : null;
}

function normalizedTailBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_TAIL_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_TAIL_BYTES);
}

function normalizedOutputFileBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_FILE_BYTES);
}

function failedProcessResult(
  error: Error,
  status: number | null = null,
  signal: NodeJS.Signals | null = null,
): CodexProcessResult {
  return { status, signal, error, stdout: "", stderr: "" };
}

function deserializeProcessResult(value: SerializedCodexProcessResult): CodexProcessResult {
  return {
    status: value.status,
    signal: value.signal,
    ...(value.error ? { error: deserializeError(value.error) } : {}),
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function deserializeError(value: { message: string; code?: string }): Error {
  const error = new Error(value.message);
  if (value.code) (error as NodeJS.ErrnoException).code = value.code;
  return error;
}
