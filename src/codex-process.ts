import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_OUTPUT_FILE_BYTES,
  DEFAULT_CODEX_OUTPUT_TAIL_BYTES,
} from "./codex-output-capture.js";

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
        resultPath,
        stdoutPath,
        stderrPath,
        tailBytes: normalizedTailBytes(options.tailBytes),
        maxOutputFileBytes: normalizedOutputFileBytes(options.outputFileBytes),
      }),
      "utf8",
    );
    const worker = spawnSync(process.execPath, [CODEX_PROCESS_WORKER_PATH, optionsPath], {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: options.timeoutMs,
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
