import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { pipeline, Readable } from "node:stream";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "./codex-output-capture.js";
import { OutputLastMessageParser } from "./codex-output-last-message.js";
import { spawnCodex, terminateCodexProcessTree } from "./codex-spawn.js";
import {
  decisionOutputError,
  decisionRepairPrompt,
  type DecisionRepairOptions,
} from "./review-decision-repair.js";

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
  decisionRepair?: DecisionRepairOptions;
}

interface TurnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  processError?: Error;
  text?: string;
  outputLastMessageError?: Error;
}

// `codex exec` prints its config header, including the session id, before the prompt echo.
const SESSION_HEADER_MAX_BYTES = 64 * 1024;

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
let child: ChildProcessWithoutNullStreams | undefined;
let input: Readable = process.stdin;
let sessionHeader = options.decisionRepair ? Buffer.alloc(0) : undefined;
let timeoutError: Error | undefined;
let terminating = false;
let forceKillTimer: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`Codex process timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  if (child) forceKillTimer = terminateCodexProcessTree(child);
}, options.timeoutMs);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    if (!child) return;
    input.unpipe(child.stdin);
    child.stdin.end();
    forceKillTimer = terminateCodexProcessTree(child, signal);
  });
}

let turn = await runTurn(options.args);
let decisionRepairError: string | undefined;
const repairError =
  options.decisionRepair &&
  !turn.processError &&
  !turn.outputLastMessageError &&
  turn.text !== undefined
    ? decisionOutputError(turn.text, options.decisionRepair.item)
    : undefined;
const repairThreadId = repairError ? codexExecSessionId(sessionHeader) : undefined;
sessionHeader = undefined;
if (repairError && repairThreadId && options.args.at(-1) === "-" && !terminating && !timeoutError) {
  // One repair turn on the same thread, with the same sandbox, schema, and timeout budget.
  decisionRepairError = repairError;
  appendCodexOutputCapture(stderr, Buffer.from("\n[clawsweeper] decision repair turn\n"));
  // The log files keep both turns; the returned tails classify only the repair turn's outcome.
  stdout.tail = Buffer.alloc(0);
  stderr.tail = Buffer.alloc(0);
  input = Readable.from([decisionRepairPrompt(repairError)]);
  turn = await runTurn([...options.args.slice(0, -1), "resume", repairThreadId, "-"]);
}
clearTimeout(timeout);
closeCodexOutputCapture(stdout);
closeCodexOutputCapture(stderr);
let outputLastMessageError = turn.outputLastMessageError;
if (
  !turn.processError &&
  !outputLastMessageError &&
  turn.text !== undefined &&
  options.outputLastMessagePath
) {
  try {
    writeManagedResult(options.outputLastMessagePath, turn.text);
  } catch (error) {
    outputLastMessageError = error instanceof Error ? error : new Error(String(error));
  }
}
const error = turn.processError ?? outputLastMessageError;
writeFileSync(
  options.resultPath,
  JSON.stringify({
    status: turn.status,
    signal: turn.signal,
    // A native failure can also omit the final stdout frame. Preserve whether
    // the process itself failed so callers cannot trust interrupted stderr.
    ...(error ? { error: serializedError(error), processError: Boolean(turn.processError) } : {}),
    ...(decisionRepairError ? { decisionRepairError } : {}),
    stdout: codexOutputTail(stdout),
    stderr: codexOutputTail(stderr),
  }),
  "utf8",
);
process.exit(0);

function runTurn(args: readonly string[]): Promise<TurnResult> {
  const outputLastMessage = options.outputLastMessageBytes
    ? new OutputLastMessageParser(options.outputLastMessageBytes)
    : null;
  const current = spawnCodex(args, { cwd: process.cwd(), env: process.env });
  child = current;
  let spawnError: Error | undefined;
  let stdinError: Error | undefined;
  const { promise, resolve } = Promise.withResolvers<TurnResult>();
  current.stdout.on("data", (chunk: Buffer) => {
    outputLastMessage?.append(chunk);
    appendCodexOutputCapture(stdout, chunk);
  });
  current.stderr.on("data", (chunk: Buffer) => {
    if (sessionHeader && sessionHeader.length < SESSION_HEADER_MAX_BYTES) {
      sessionHeader = Buffer.concat([
        sessionHeader,
        chunk.subarray(0, SESSION_HEADER_MAX_BYTES - sessionHeader.length),
      ]);
    }
    appendCodexOutputCapture(stderr, chunk);
  });
  current.stdin.on("error", () => {});
  pipeline(input, current.stdin, (error) => {
    if (error && !terminating && !spawnError) stdinError = error;
  });
  current.once("error", (error) => {
    spawnError = error;
  });
  current.once("close", (status, signal) => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      // The direct child can exit before its signal-ignoring descendants.
      terminateCodexProcessTree(current, "SIGKILL");
    }
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
    resolve({
      status,
      signal,
      ...(processError ? { processError } : {}),
      ...(finalMessage?.text === undefined ? {} : { text: finalMessage.text }),
      ...(finalMessage?.error ? { outputLastMessageError: finalMessage.error } : {}),
    });
  });
  return promise;
}

function codexExecSessionId(header: Buffer | undefined): string | undefined {
  if (!header) return undefined;
  const lines = header.toString("utf8").split(/\r?\n/);
  const start = lines.findIndex(
    (line, index) => line.startsWith("OpenAI Codex v") && lines[index + 1] === "--------",
  );
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 2)) {
    if (line === "--------") return undefined;
    const match =
      /^session id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(line);
    if (match) return match[1];
  }
  return undefined;
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
