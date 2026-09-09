import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const processError =
    timeoutError ??
    spawnError ??
    (outputLastMessage && (terminating || signal)
      ? new Error(`Codex process interrupted by ${signal ?? "signal"}`)
      : undefined) ??
    (status === 0 && (stdinError as NodeJS.ErrnoException | undefined)?.code === "EPIPE"
      ? undefined
      : stdinError);
  const finalMessage = outputLastMessage?.finish();
  let outputLastMessageError = finalMessage?.error;
  if (
    !processError &&
    !outputLastMessageError &&
    finalMessage?.text !== undefined &&
    options.outputLastMessagePath
  ) {
    try {
      writeManagedResult(options.outputLastMessagePath, finalMessage.text);
    } catch (error) {
      outputLastMessageError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const error = processError ?? outputLastMessageError;
  writeFileSync(
    options.resultPath,
    JSON.stringify({
      status,
      signal,
      // A native failure can also omit the final stdout frame. Preserve whether
      // the process itself failed so callers cannot trust interrupted stderr.
      ...(error ? { error: serializedError(error), processError: Boolean(processError) } : {}),
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

function writeManagedResult(path: string, text: string): void {
  const file = openSync(path, "wx", 0o600);
  const owned = fstatSync(file);
  try {
    writeFileSync(file, text, "utf8");
    const metadata = fstatSync(file);
    if (!metadata.isFile() || metadata.size !== Buffer.byteLength(text)) {
      throw new Error("managed Codex result is not an exact regular file");
    }
  } catch (error) {
    // A failed exclusive write may leave a partial file. Remove only that inode,
    // never a pre-existing collision or a path replaced by another writer.
    try {
      const current = lstatSync(path);
      if (current.dev === owned.dev && current.ino === owned.ino) rmSync(path);
    } catch {}
    throw error;
  } finally {
    closeSync(file);
  }
}

function serializedError(error: Error): { message: string; code?: string } {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}
