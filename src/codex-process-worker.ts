import { readFileSync, writeFileSync } from "node:fs";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "./codex-output-capture.js";
import { spawnCodex, terminateCodexProcessTree } from "./codex-spawn.js";

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
process.env.CODEX_BIN = options.command;
const child = spawnCodex(options.args, { cwd: process.cwd(), env: process.env });
let spawnError: Error | undefined;
let timeoutError: Error | undefined;
let terminating = false;
let forceKillTimer: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`Codex process timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  forceKillTimer = terminateCodexProcessTree(child);
}, options.timeoutMs);

child.stdout.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stdout, chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stderr, chunk);
});
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);

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

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    if (terminating) return;
    terminating = true;
    process.stdin.unpipe(child.stdin);
    child.stdin.end();
    forceKillTimer = terminateCodexProcessTree(child, signal);
  });
}

function serializedError(error: Error): { message: string; code?: string } {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}
