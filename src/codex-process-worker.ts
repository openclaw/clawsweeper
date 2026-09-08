import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "./codex-output-capture.js";
import { OutputLastMessageParser } from "./codex-output-last-message.js";
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
  outputLastMessageBytes?: number;
  outputLastMessagePath?: string;
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
const outputLastMessage = options.outputLastMessageBytes
  ? new OutputLastMessageParser(options.outputLastMessageBytes)
  : null;
process.env.CODEX_BIN = options.command;
const child = spawnCodex(options.args, { cwd: process.cwd(), env: process.env });
let spawnError: Error | undefined;
let stdinError: Error | undefined;
let timeoutError: Error | undefined;
let terminating = false;
let forceKillTimer: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`Codex process timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  forceKillTimer = terminateCodexProcessTree(child);
}, options.timeoutMs);

child.stdout.on("data", (chunk: Buffer) => {
  outputLastMessage?.append(chunk);
  appendCodexOutputCapture(stdout, chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stderr, chunk);
});
child.stdin.on("error", () => {});
pipeline(process.stdin, child.stdin, (error) => {
  if (error && !terminating && !spawnError) stdinError = error;
});

child.once("error", (error) => {
  spawnError = error;
});
child.once("close", (status, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  clearTimeout(timeout);
  closeCodexOutputCapture(stdout);
  closeCodexOutputCapture(stderr);
  const finalMessage = outputLastMessage?.finish();
  let outputLastMessageError = finalMessage?.error;
  if (
    !outputLastMessageError &&
    finalMessage?.text !== undefined &&
    options.outputLastMessagePath
  ) {
    try {
      const bytes = Buffer.byteLength(finalMessage.text);
      writeFileSync(options.outputLastMessagePath, finalMessage.text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const metadata = lstatSync(options.outputLastMessagePath);
      if (!metadata.isFile() || metadata.size !== bytes) {
        throw new Error("managed Codex result is not an exact regular file");
      }
    } catch (error) {
      outputLastMessageError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const processError =
    timeoutError ??
    spawnError ??
    (status === 0 && (stdinError as NodeJS.ErrnoException | undefined)?.code === "EPIPE"
      ? undefined
      : stdinError) ??
    outputLastMessageError;
  writeFileSync(
    options.resultPath,
    JSON.stringify({
      status,
      signal,
      ...(processError ? { error: serializedError(processError) } : {}),
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
