import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_OUTPUT_FILE_BYTES,
  DEFAULT_CODEX_OUTPUT_TAIL_BYTES,
} from "./codex-output-capture.js";
import type { CodexProcessResult } from "./codex-process.js";

const OPENCLAW_PROCESS_WORKER_PATH = fileURLToPath(
  new URL("./openclaw-process-worker.js", import.meta.url),
);
const STDERR_FAILURE_TAIL_BYTES = 8 * 1024;

interface SerializedProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: { message: string; code?: string };
  stdout: string;
  stderr: string;
}

export interface OpenClawProcessOptions {
  label: string;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
}

export function runOpenclawProcess(options: OpenClawProcessOptions): CodexProcessResult {
  const stateDir = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-process-"));
  const configPath = join(stateDir, "openclaw.json");
  const promptPath = join(stateDir, "prompt.md");
  const workerOptionsPath = join(stateDir, "worker-options.json");
  const resultPath = join(stateDir, "result.json");
  const stdoutPath = options.stdoutPath ?? join(stateDir, "stdout.log");
  const stderrPath = options.stderrPath ?? join(stateDir, "stderr.log");
  try {
    const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1_000));
    writeFileSync(configPath, `${JSON.stringify(openclawConfig(options.env, timeoutSeconds))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(promptPath, options.prompt, { encoding: "utf8", mode: 0o600 });
    const args = [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      openclawSessionId(options.label),
      "--model",
      options.model,
      "--message-file",
      promptPath,
      "--timeout",
      String(timeoutSeconds),
      "--json",
    ];
    const thinking = options.reasoningEffort?.trim();
    if (thinking) args.splice(args.length - 1, 0, "--thinking", thinking);
    // Deny-by-default: the embedded agent runs untrusted repository content
    // with full exec, so it must never inherit workflow credentials (GitHub
    // App tokens, state tokens, webhook secrets). Only the base OS surface,
    // OpenClaw controls, and the provider API keys inference needs pass
    // through — mirroring the codex lane, which keeps OPENAI_API_KEY out of
    // subprocesses via its proxy auth mode.
    const childEnv: NodeJS.ProcessEnv = {
      ...pickEnv(options.env, OPENCLAW_CHILD_ENV_ALLOWLIST),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: options.cwd,
    };
    if (!childEnv.OPENAI_API_KEY && options.env.CLAWSWEEPER_OPENCLAW_OPENAI_KEY) {
      childEnv.OPENAI_API_KEY = options.env.CLAWSWEEPER_OPENCLAW_OPENAI_KEY;
    }
    writeFileSync(
      workerOptionsPath,
      JSON.stringify({
        args,
        command: options.env.CLAWSWEEPER_OPENCLAW_BIN?.trim() || "openclaw",
        timeoutMs: options.timeoutMs,
        resultPath,
        stdoutPath,
        stderrPath,
        tailBytes: normalizedTailBytes(options.tailBytes),
        maxOutputFileBytes: normalizedOutputFileBytes(options.outputFileBytes),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const worker = spawnSync(process.execPath, [OPENCLAW_PROCESS_WORKER_PATH, workerOptionsPath], {
      cwd: options.cwd,
      env: childEnv,
      stdio: "ignore",
      timeout: options.timeoutMs + 10_000,
    });
    if (!existsSync(resultPath)) {
      if (worker.error) return failedResult(worker.error, worker.status, worker.signal);
      return failedResult(
        new Error(
          `OpenClaw process worker failed with exit ${worker.status ?? "unknown"} and did not write a result.`,
        ),
        worker.status,
        worker.signal,
      );
    }
    const processResult = deserializeResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (worker.error) return { ...processResult, error: worker.error };
    return normalizeOpenclawResult(processResult, readFileSync(stdoutPath, "utf8"));
  } catch (error) {
    return failedResult(error instanceof Error ? error : new Error(String(error)));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

export function parseOpenclawJsonEnvelope(
  stdout: string,
  stderr = "",
): { text: string; failure?: Error } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {
      text: "",
      failure: new Error(
        `OpenClaw exited successfully but produced invalid JSON.${boundedStderrDetail(stderr)}`,
      ),
    };
  }
  if (!isRecord(envelope)) {
    return { text: "", failure: new Error("OpenClaw JSON output must be an object.") };
  }
  const result = isRecord(envelope.result) ? envelope.result : envelope;
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const text = payloads
    .filter(isRecord)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .filter(Boolean)
    .join("\n");
  const failureDetail = openclawFailureDetail(envelope, result, payloads);
  return {
    text,
    ...(failureDetail ? { failure: new Error(`OpenClaw agent failed: ${failureDetail}`) } : {}),
  };
}

function openclawConfig(env: NodeJS.ProcessEnv, timeoutSeconds: number): Record<string, unknown> {
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: { mode: "off" },
        timeoutSeconds,
      },
    },
    tools: {
      profile: "coding",
      fs: { workspaceOnly: true },
      exec: { host: "gateway", mode: "full" },
    },
  };
  const providersJson = env.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON?.trim();
  if (!providersJson) {
    const builtin = builtinProviderBlock(env.CLAWSWEEPER_OPENCLAW_MODEL?.trim() || "");
    if (builtin) config.models = { mode: "merge", providers: builtin };
    return config;
  }
  let providers: unknown;
  try {
    providers = JSON.parse(providersJson);
  } catch {
    throw new Error("CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON must be valid JSON.");
  }
  if (!isRecord(providers)) {
    throw new Error("CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON must be a JSON object.");
  }
  // OpenClaw config validation requires models[].name; default it to the id so
  // provider blocks stay minimal.
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (isRecord(model) && typeof model.id === "string" && model.name === undefined) {
        model.name = model.id;
      }
    }
  }
  config.models = { mode: "merge", providers };
  return config;
}

function normalizeOpenclawResult(
  processResult: CodexProcessResult,
  completeStdout: string,
): CodexProcessResult {
  if (processResult.error || processResult.status !== 0) return processResult;
  const parsed = parseOpenclawJsonEnvelope(completeStdout, processResult.stderr);
  if (!parsed.failure) return { ...processResult, stdout: parsed.text };
  if (/\btimeout\b/i.test(parsed.failure.message)) {
    (parsed.failure as NodeJS.ErrnoException).code = "ETIMEDOUT";
  }
  return { ...processResult, status: 1, error: parsed.failure, stdout: parsed.text };
}

function openclawFailureDetail(
  envelope: Record<string, unknown>,
  result: Record<string, unknown>,
  payloads: unknown[],
): string {
  const meta = isRecord(result.meta) ? result.meta : {};
  const errors = [
    detailText(meta.error),
    detailText(result.error),
    detailText(envelope.error),
  ].filter(Boolean);
  if (errors.length > 0) return errors.join("; ");
  const errorPayload = payloads.filter(isRecord).find((payload) => payload.isError === true);
  if (errorPayload) {
    return detailText(errorPayload.text) || detailText(errorPayload.error) || "error payload";
  }
  const stopReason = [meta.stopReason, result.stopReason, envelope.stopReason]
    .find((value) => typeof value === "string")
    ?.toString()
    .trim();
  if (stopReason && /^(?:timeout|timed_out|error|aborted)$/i.test(stopReason)) {
    return `stop reason ${stopReason}`;
  }
  if (meta.aborted === true) return "agent run was aborted";
  const executionTrace = isRecord(meta.executionTrace) ? meta.executionTrace : {};
  if (
    executionTrace.exhausted === true ||
    meta.fallbackExhaustedFailure === true ||
    result.fallbackExhaustedFailure === true
  ) {
    const attempts = Array.isArray(executionTrace.attempts) ? executionTrace.attempts : [];
    const lastAttempt = attempts.filter(isRecord).at(-1);
    return lastAttempt
      ? `all model fallbacks were exhausted: ${detailText(lastAttempt)}`
      : "all model fallbacks were exhausted";
  }
  if (
    typeof envelope.status === "string" &&
    !["ok", "completed", "success"].includes(envelope.status)
  ) {
    return detailText(envelope.summary) || `status ${envelope.status}`;
  }
  return "";
}

function detailText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 2_000);
  if (value === true) return "reported an error";
  if (!isRecord(value)) return "";
  for (const key of ["message", "errorMessage", "detail", "reason"]) {
    const nested = value[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 2_000);
  }
  return "reported an error";
}

const OPENCLAW_CHILD_ENV_ALLOWLIST = [
  // Base OS/tooling surface the CLI needs to run.
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Provider API keys the embedded agent needs for direct inference. These
  // are the credentials this lane intentionally trades for provider choice;
  // everything else in the step environment stays out.
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MINIMAX_API_KEY",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "MOONSHOT_API_KEY",
  "CEREBRAS_API_KEY",
  "ZAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
] as const;

function pickEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // OPENCLAW_* carries operational controls (log level, test hooks), never
    // workflow credentials; everything else must be explicitly allowlisted.
    if (value !== undefined && (names.includes(name) || name.startsWith("OPENCLAW_"))) {
      picked[name] = value;
    }
  }
  return picked;
}

// Kimi Code (api.kimi.com/coding) works with released openclaw versions that
// predate the bundled kimi provider plugin, but only via explicit provider
// config. Ship those defaults so `kimi/...` models run without extra setup.
// Verified 2026-07-25: kimi-for-coding needs maxTokens above the runtime
// default or reasoning-heavy turns die on the output cap; k3 limits are from
// the Kimi Code catalog (1M context, 131072 max output).
const BUILTIN_PROVIDERS = {
  kimi: {
    baseUrl: "https://api.kimi.com/coding/",
    apiKey: "${KIMI_API_KEY}",
    api: "anthropic-messages",
    models: [
      { id: "kimi-for-coding", name: "Kimi Code", contextWindow: 262144, maxTokens: 65536 },
      { id: "k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 131072 },
    ],
  },
  // Cerebras Code plans serve the GLM coding model at ~1000 tok/s; validated
  // live 2026-07-25 (474 tok/s wall including network, E2E tool run in 5s).
  // zai-glm-4.7 deprecates 2026-08-17 — update the id when Cerebras swaps in
  // its successor.
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: "${CEREBRAS_API_KEY}",
    api: "openai-completions",
    models: [{ id: "zai-glm-4.7", name: "Z.ai GLM 4.7", contextWindow: 128000, maxTokens: 8192 }],
  },
  // Z.AI GLM Coding Plan keys only authorize the coding endpoint — the general
  // paas endpoint rejects them with error 1113. Validated live 2026-07-25
  // (~51 tok/s, E2E tool run in 16s).
  zai: {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "${ZAI_API_KEY}",
    api: "openai-completions",
    models: [{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 131072 }],
  },
} as const;

function builtinProviderBlock(model: string): Record<string, unknown> | undefined {
  const provider = model.split("/", 1)[0] as keyof typeof BUILTIN_PROVIDERS;
  const block = BUILTIN_PROVIDERS[provider];
  if (!block) return undefined;
  return structuredClone({ [provider]: block }) as unknown as Record<string, unknown>;
}

function boundedStderrDetail(stderr: string): string {
  const tail = Buffer.from(stderr).subarray(-STDERR_FAILURE_TAIL_BYTES).toString("utf8").trim();
  return tail ? ` OpenClaw stderr: ${tail}` : "";
}

function openclawSessionId(label: string): string {
  const safeLabel = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 48);
  return `${safeLabel || "clawsweeper"}-${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedTailBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_TAIL_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_TAIL_BYTES);
}

function normalizedOutputFileBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_FILE_BYTES);
}

function failedResult(
  error: Error,
  status: number | null = null,
  signal: NodeJS.Signals | null = null,
): CodexProcessResult {
  return { status, signal, error, stdout: "", stderr: "" };
}

function deserializeResult(value: SerializedProcessResult): CodexProcessResult {
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
