import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
} from "./codex-output-capture.js";
import { spawnCodex, terminateCodexProcessTree, waitForCodexProcessExit } from "./codex-spawn.js";

interface AppServerOptions {
  statePath: string;
  label?: string;
  runnerPtyUrl?: string;
  workStateUrl?: string;
  agentToken?: string;
}

interface WorkerOptions {
  args: string[];
  command: string;
  timeoutMs: number;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  tailBytes: number;
  maxOutputFileBytes: number;
  appServer: AppServerOptions;
}

interface ExecOptions {
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  networkAccess: boolean;
  model?: string;
  effort?: string;
  serviceTier?: string;
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
}

interface ThreadState {
  threadId: string;
  sessionId?: string;
  updatedAt: string;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerOptions;
const execOptions = parseExecOptions(options.args, process.cwd());
const prompt = await readStdin();
const stdout = openCodexOutputCapture(options.stdoutPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
});
const stderr = openCodexOutputCapture(options.stderrPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
});
process.env.CODEX_BIN = options.command;
const child = spawnCodex(["app-server", "--listen", "stdio://"], {
  cwd: execOptions.cwd,
  env: process.env,
});
const pending = new Map<
  number,
  {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }
>();
let requestId = 0;
let spawnError: Error | undefined;
let timeoutError: Error | undefined;
let threadId = "";
let sessionId = "";
let turnId = "";
let finalMessage = "";
let turnStatus = "";
let settled = false;
let forceKillTimer: NodeJS.Timeout | undefined;
let terminal: WebSocket | null = null;
let terminalInput = "";
let heartbeat: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`Codex app-server timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  forceKillTimer = terminateCodexProcessTree(child);
}, options.timeoutMs);

child.stderr.on("data", (chunk: Buffer) => appendCodexOutputCapture(stderr, chunk));
child.once("error", (error) => {
  spawnError = error;
  void finish(1, null, error);
});
child.once("close", (status, signal) => {
  if (!settled) {
    void finish(
      status ?? 1,
      signal,
      timeoutError ?? spawnError ?? new Error("Codex app-server exited early."),
    );
  }
});

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  appendCodexOutputCapture(stdout, Buffer.from(`${line}\n`));
  const message = parseRpcMessage(line);
  if (message) void handleRpcMessage(message);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    if (settled) return;
    forceKillTimer = terminateCodexProcessTree(child, signal);
  });
}

try {
  await request("initialize", {
    clientInfo: {
      name: "clawsweeper",
      title: "ClawSweeper GitHub Actions",
      version: "1",
    },
  });
  notify("initialized");
  const previous = readThreadState(options.appServer.statePath);
  const thread = previous ? await resumeThread(previous.threadId) : await startThread();
  threadId = stringAt(thread, ["thread", "id"]);
  sessionId = stringAt(thread, ["thread", "sessionId"]);
  if (!threadId) throw new Error("Codex app-server did not return a thread id.");
  writeThreadState(options.appServer.statePath, {
    threadId,
    ...(sessionId ? { sessionId } : {}),
    updatedAt: new Date().toISOString(),
  });
  connectTerminal();
  startHeartbeat();
  await updateWorkState("running", "codex", "Codex turn starting");
  const turn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: execOptions.cwd,
    approvalPolicy: "never",
    sandboxPolicy: sandboxPolicy(execOptions.sandbox, execOptions.cwd, execOptions.networkAccess),
    ...(execOptions.model ? { model: execOptions.model } : {}),
    ...(execOptions.effort ? { effort: execOptions.effort } : {}),
    ...(execOptions.serviceTier ? { serviceTier: execOptions.serviceTier } : {}),
    ...(execOptions.outputSchemaPath
      ? { outputSchema: JSON.parse(readFileSync(execOptions.outputSchemaPath, "utf8")) }
      : {}),
  });
  turnId = stringAt(turn, ["turn", "id"]);
  await updateWorkState("running", "codex", "Codex turn active");
  terminalWrite(
    `\r\n[ClawSweeper] ${options.appServer.label ?? "Codex"} active` +
      `${turnId ? ` (${turnId})` : ""}. Type a message and press Enter to steer.\r\n\r\n`,
  );
} catch (error) {
  await finish(1, null, error instanceof Error ? error : new Error(String(error)));
}

async function startThread(): Promise<Record<string, unknown>> {
  return request("thread/start", {
    cwd: execOptions.cwd,
    approvalPolicy: "never",
    sandbox: execOptions.sandbox,
    ephemeral: false,
    serviceName: "clawsweeper",
    personality: "pragmatic",
    ...(execOptions.model ? { model: execOptions.model } : {}),
    ...(execOptions.serviceTier ? { serviceTier: execOptions.serviceTier } : {}),
    ...(execOptions.effort ? { config: { model_reasoning_effort: execOptions.effort } } : {}),
  });
}

async function resumeThread(previousThreadId: string): Promise<Record<string, unknown>> {
  try {
    return await request("thread/resume", {
      threadId: previousThreadId,
      cwd: execOptions.cwd,
      approvalPolicy: "never",
      sandbox: execOptions.sandbox,
      personality: "pragmatic",
      ...(execOptions.model ? { model: execOptions.model } : {}),
      ...(execOptions.serviceTier ? { serviceTier: execOptions.serviceTier } : {}),
      ...(execOptions.effort ? { config: { model_reasoning_effort: execOptions.effort } } : {}),
    });
  } catch (error) {
    terminalWrite(
      `\r\n[ClawSweeper] Stored Codex thread unavailable; starting a new thread: ${errorMessage(error)}\r\n`,
    );
    return startThread();
  }
}

async function handleRpcMessage(message: RpcMessage): Promise<void> {
  if (typeof message.id === "number") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`),
      );
    } else {
      waiter.resolve(message.result ?? {});
    }
    return;
  }
  if (message.method === "item/agentMessage/delta") {
    const delta = typeof message.params?.delta === "string" ? message.params.delta : "";
    terminalWrite(delta);
    return;
  }
  if (message.method === "item/completed") {
    const item = recordAt(message.params, ["item"]);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      finalMessage = item.text;
    }
    return;
  }
  if (message.method !== "turn/completed") return;
  const turn = recordAt(message.params, ["turn"]);
  if (turnId && turn?.id !== turnId) return;
  turnStatus = typeof turn?.status === "string" ? turn.status : "";
  const failed = turnStatus !== "completed";
  if (execOptions.outputLastMessagePath && finalMessage) {
    mkdirSync(dirname(execOptions.outputLastMessagePath), { recursive: true });
    writeFileSync(execOptions.outputLastMessagePath, finalMessage, "utf8");
  }
  terminalWrite(
    `\r\n\r\n[ClawSweeper] Codex turn ${turnStatus || "finished"}. Deterministic repair gates continue in GitHub Actions.\r\n`,
  );
  clearTimeout(timeout);
  await updateWorkState(
    failed ? "blocked" : "running",
    failed ? "codex_failed" : "validating",
    failed ? `Codex turn ${turnStatus || "failed"}` : "Codex turn complete; validating result",
  );
  await finish(failed ? 1 : 0, null);
}

function request(
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = ++requestId;
  child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method: string): void {
  child.stdin.write(`${JSON.stringify({ method })}\n`);
}

function connectTerminal(): void {
  const url = options.appServer.runnerPtyUrl?.trim();
  if (!url) return;
  try {
    terminal = new WebSocket(url);
    terminal.binaryType = "arraybuffer";
    terminal.addEventListener("open", () => {
      terminalWrite(`\r\n[ClawSweeper] GitHub Actions session connected. Thread ${threadId}.\r\n`);
    });
    terminal.addEventListener("message", (event) => void handleTerminalInput(event.data));
    terminal.addEventListener("error", () => {
      appendCodexOutputCapture(stderr, Buffer.from("CrabFleet terminal bridge error.\n"));
    });
  } catch (error) {
    appendCodexOutputCapture(
      stderr,
      Buffer.from(`CrabFleet terminal bridge failed: ${errorMessage(error)}\n`),
    );
  }
}

async function handleTerminalInput(data: string | ArrayBuffer | Blob): Promise<void> {
  const text =
    typeof data === "string"
      ? data
      : data instanceof Blob
        ? await data.text()
        : new TextDecoder().decode(data);
  for (const char of text) {
    if (char === "\u0003") {
      if (threadId && turnId) {
        await request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      continue;
    }
    if (char === "\r" || char === "\n") {
      const instruction = terminalInput.trim();
      terminalInput = "";
      if (!instruction) continue;
      if (!threadId || !turnId || turnStatus) {
        terminalWrite("\r\n[ClawSweeper] No active steerable Codex turn.\r\n");
        continue;
      }
      terminalWrite(`\r\n[steer] ${instruction}\r\n`);
      await request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: instruction }],
      }).catch((error) => {
        terminalWrite(`\r\n[ClawSweeper] Steering rejected: ${errorMessage(error)}\r\n`);
      });
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      terminalInput = terminalInput.slice(0, -1);
      continue;
    }
    if (char >= " " && terminalInput.length < 8_000) terminalInput += char;
  }
}

function startHeartbeat(): void {
  heartbeat = setInterval(() => {
    void updateWorkState("running", "codex", "Codex turn active");
    terminalWrite(
      `\r\n[ClawSweeper] ${new Date().toISOString()} still running; thread ${threadId}, turn ${turnId || "starting"}.\r\n`,
    );
  }, 60_000);
  heartbeat.unref();
}

async function updateWorkState(state: string, phase: string, summary: string): Promise<void> {
  const url = options.appServer.workStateUrl?.trim();
  const token = options.appServer.agentToken?.trim();
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state,
        phase,
        summary,
        codexThreadId: threadId || undefined,
        codexTurnId: turnId || undefined,
      }),
    });
  } catch (error) {
    appendCodexOutputCapture(
      stderr,
      Buffer.from(`CrabFleet work-state update failed: ${errorMessage(error)}\n`),
    );
  }
}

function terminalWrite(value: string): void {
  if (terminal?.readyState === WebSocket.OPEN) terminal.send(value);
}

async function finish(status: number, signal: NodeJS.Signals | null, error?: Error): Promise<void> {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (heartbeat) clearInterval(heartbeat);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  for (const waiter of pending.values())
    waiter.reject(error ?? new Error("Codex app-server closed."));
  pending.clear();
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    forceKillTimer = terminateCodexProcessTree(child);
    await waitForCodexProcessExit(child);
  }
  terminal?.close(1000, "turn complete");
  closeCodexOutputCapture(stdout);
  closeCodexOutputCapture(stderr);
  writeFileSync(
    options.resultPath,
    JSON.stringify({
      status,
      signal,
      ...(error ? { error: serializedError(error) } : {}),
      stdout: codexOutputTail(stdout),
      stderr: codexOutputTail(stderr),
    }),
    "utf8",
  );
  process.exit(0);
}

function parseExecOptions(args: string[], fallbackCwd: string): ExecOptions {
  let cwd = fallbackCwd;
  let sandbox: ExecOptions["sandbox"] = "read-only";
  let networkAccess = false;
  let model: string | undefined;
  let effort: string | undefined;
  let serviceTier: string | undefined;
  let outputSchemaPath: string | undefined;
  let outputLastMessagePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if ((arg === "--cd" || arg === "-C") && value) cwd = value;
    if (arg === "--sandbox" && isSandbox(value)) sandbox = value;
    if ((arg === "--model" || arg === "-m") && value) model = value;
    if (arg === "--output-schema" && value) outputSchemaPath = value;
    if (arg === "--output-last-message" && value) outputLastMessagePath = value;
    if (arg === "-c" && value) {
      const parsed = parseConfig(value);
      if (parsed.key === "model_reasoning_effort") effort = parsed.value;
      if (parsed.key === "service_tier") serviceTier = parsed.value;
      if (parsed.key === "sandbox_workspace_write.network_access") {
        networkAccess = parsed.value === "true";
      }
    }
  }
  return {
    cwd,
    sandbox,
    networkAccess,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(outputSchemaPath ? { outputSchemaPath } : {}),
    ...(outputLastMessagePath ? { outputLastMessagePath } : {}),
  };
}

function parseConfig(value: string): { key: string; value: string } {
  const separator = value.indexOf("=");
  if (separator < 1) return { key: "", value: "" };
  const key = value.slice(0, separator).trim();
  const raw = value.slice(separator + 1).trim();
  try {
    return { key, value: String(JSON.parse(raw)) };
  } catch {
    return { key, value: raw };
  }
}

function sandboxPolicy(
  mode: ExecOptions["sandbox"],
  cwd: string,
  networkAccess: boolean,
): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "workspace-write") {
    return { type: "workspaceWrite", writableRoots: [cwd], networkAccess };
  }
  return { type: "readOnly", networkAccess: false };
}

function isSandbox(value: string | undefined): value is ExecOptions["sandbox"] {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function readThreadState(path: string): ThreadState | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ThreadState>;
    return typeof value.threadId === "string" && value.threadId
      ? {
          threadId: value.threadId,
          ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
        }
      : null;
  } catch {
    return null;
  }
}

function writeThreadState(path: string, state: ThreadState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function parseRpcMessage(line: string): RpcMessage | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as RpcMessage) : null;
  } catch {
    return null;
  }
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function stringAt(value: unknown, path: string[]): string {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return "";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "";
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", reject);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializedError(error: Error): { message: string; code?: string } {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}
