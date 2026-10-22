import { REVIEW_DIRECT_PROVIDER_ENV_KEYS } from "./codex-env.js";
import { projectOpenclawExecutionReceipt } from "./review-execution-receipt.js";
import { isRecord } from "./value-coerce.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { runTextConcurrently } from "./command.js";
import { ValidationRecoveryRequiredError } from "./validation-recovery.js";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizedOutputFileBytes, normalizedTailBytes } from "./codex-output-capture.js";
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
  checkoutInspection?: { expectedText: string; expectedPath: string };
  skillFilter?: string[];
  roleIsolation?: { readRoots: string[]; proofScratchDir?: string };
}

export function runOpenclawProcess(options: OpenClawProcessOptions): CodexProcessResult {
  const deadlineAt = Date.now() + options.timeoutMs;
  const stateDir = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-process-"));
  const configPath = join(stateDir, "openclaw.json");
  const promptPath = join(stateDir, "prompt.md");
  const workerOptionsPath = join(stateDir, "worker-options.json");
  const resultPath = join(stateDir, "result.json");
  const stdoutPath = options.stdoutPath ?? join(stateDir, "stdout.log");
  const stderrPath = options.stderrPath ?? join(stateDir, "stderr.log");
  let retainState = false;
  try {
    if (options.roleIsolation) {
      const roots = [
        ...options.roleIsolation.readRoots,
        ...(options.roleIsolation.proofScratchDir ? [options.roleIsolation.proofScratchDir] : []),
      ];
      if (
        roots.some((root) => {
          const path = relative(realpathSync(root), stateDir);
          return (
            !path ||
            (path !== ".." &&
              !path.startsWith("../") &&
              !path.startsWith("..\\") &&
              !isAbsolute(path))
          );
        })
      )
        throw new Error("Native provider state must be outside every configured role tool root.");
    }
    const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1_000));
    writeFileSync(
      configPath,
      `${JSON.stringify(openclawConfig({ ...options.env, CLAWSWEEPER_OPENCLAW_MODEL: options.model }, timeoutSeconds, Boolean(options.checkoutInspection), options.skillFilter, options.roleIsolation, options.cwd))}\n`,

      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    if (options.roleIsolation) {
      writeFileSync(join(stateDir, "role-isolation.json"), "1", { mode: 0o600, flag: "wx" });
      retainState = true;
    }
    writeFileSync(promptPath, options.prompt, { encoding: "utf8", mode: 0o600 });
    const sessionId = openclawSessionId(options.label);
    const args = [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      sessionId,
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
      ...(options.skillFilter?.length ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
    };
    if (options.roleIsolation) {
      delete childEnv.OPENCLAW_GATEWAY_TOKEN;
      delete childEnv.OPENCLAW_GATEWAY_PASSWORD;
    }
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
    const completeStdout = readFileSync(stdoutPath, "utf8");
    return normalizeOpenclawResult(processResult, completeStdout, options.checkoutInspection, {
      cwd: options.cwd,
      // OpenClaw persists an explicit local session under this agent-owned
      // path; inspect it before the isolated state directory is removed.
      entries:
        options.checkoutInspection &&
        processResult.status === 0 &&
        parseOpenclawJsonEnvelope(completeStdout).text.trim() ===
          options.checkoutInspection.expectedText
          ? readCheckoutReceipt({ stateDir, sessionId, options, childEnv, deadlineAt })
          : undefined,
    });
  } catch (error) {
    return failedResult(error instanceof Error ? error : new Error(String(error)));
  } finally {
    // A configured role's native container outlives its CLI process group. The
    // surviving assessment owner retires it before deleting this private state.
    if (!retainState) rmSync(stateDir, { recursive: true, force: true });
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

function openclawConfig(
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  checkoutInspection: boolean,
  skillFilter?: string[],
  isolation?: OpenClawProcessOptions["roleIsolation"],
  workspaceDir?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        skipBootstrap: true,
        ...(isolation ? { workspace: workspaceDir } : {}),
        ...(skillFilter === undefined ? {} : { skills: skillFilter }),
        sandbox: isolation ? isolatedRoleSandbox(env, isolation) : { mode: "off" },
        timeoutSeconds,
      },
    },
    tools: checkoutInspection
      ? {
          allow: ["read"],
          // The receipt binds the direct read call, not an opaque Code Mode program.
          codeMode: false,
          fs: { workspaceOnly: true },
          exec: { host: isolation ? "sandbox" : "gateway", mode: "deny" },
          ...(isolation ? { elevated: { enabled: false } } : {}),
        }
      : {
          profile: "coding",
          fs: { workspaceOnly: true },
          exec: { host: isolation ? "sandbox" : "gateway", mode: "full" },
          ...(isolation
            ? {
                allow: ["read", "ls", "exec", "process"],
                codeMode: false,
                elevated: { enabled: false },
                sandbox: { tools: { allow: ["read", "ls", "exec", "process"] } },
              }
            : {}),
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

function isolatedRoleSandbox(
  env: NodeJS.ProcessEnv,
  isolation: NonNullable<OpenClawProcessOptions["roleIsolation"]>,
): Record<string, unknown> {
  const image = env.CLAWSWEEPER_OPENCLAW_SANDBOX_IMAGE?.trim();
  if (!image || !/(?:^|@)sha256:[0-9a-f]{64}$/.test(image))
    throw new Error(
      "Configured OpenClaw roles require an operator-pinned CLAWSWEEPER_OPENCLAW_SANDBOX_IMAGE digest and native Podman sandbox support.",
    );
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0)
    throw new Error("Configured OpenClaw roles require a qualified non-root native sandbox host.");
  const mounts = new Map(isolation.readRoots.map((root) => [realpathSync(root), "ro"]));
  if (isolation.proofScratchDir) mounts.set(realpathSync(isolation.proofScratchDir), "rw");
  if (!mounts.size || [...mounts.keys()].some((root) => root.includes(":") || root.includes("\n")))
    throw new Error("Configured role source mounts require supported absolute native paths.");
  return {
    mode: "all",
    backend: "podman",
    scope: "session",
    workspaceAccess: "ro",
    docker: {
      image,
      user: String(uid) + ":" + String(gid),
      network: "none",
      readOnlyRoot: true,
      capDrop: ["ALL"],
      binds: [...mounts].map(([root, mode]) => root + ":" + root + ":" + mode),
      // Only the host source owner supplies these exact roots. Native blocked
      // system/credential/socket/symlink/reserved-target checks remain enabled.
      dangerouslyAllowExternalBindSources: true,
    },
  };
}

/** Called by the surviving host owner, including after a role worker was killed. */
export function retireOpenclawRoleStates(
  privateTemp: string,
  env: NodeJS.ProcessEnv,
  deadlineAt: number,
): void {
  const states = readdirSync(privateTemp).filter((name) => {
    const path = join(privateTemp, name);
    return (
      name.startsWith("clawsweeper-openclaw-process-") &&
      lstatSync(path).isDirectory() &&
      !lstatSync(path).isSymbolicLink() &&
      existsSync(join(path, "role-isolation.json"))
    );
  });
  const commands = states.map((name) => {
    const stateDir = join(privateTemp, name);
    const childEnv = pickEnv(env, OPENCLAW_CHILD_ENV_ALLOWLIST);
    for (const key of REVIEW_DIRECT_PROVIDER_ENV_KEYS) delete childEnv[key];
    delete childEnv.OPENCLAW_GATEWAY_TOKEN;
    delete childEnv.OPENCLAW_GATEWAY_PASSWORD;
    // Retirement needs the original sandbox/agent binding, not model credentials.
    // A provider env-reference must not make cleanup require rehydrating a key.
    const retirement = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8"));
    delete retirement.models;
    const configPath = join(stateDir, "retire-" + randomUUID() + ".json");
    writeFileSync(configPath, JSON.stringify(retirement), { flag: "wx", mode: 0o600 });
    return {
      command: env.CLAWSWEEPER_OPENCLAW_BIN?.trim() || "openclaw",
      args: ["sandbox", "recreate", "--agent", "main", "--force"],
      options: {
        env: { ...childEnv, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        inheritEnv: false,
        deadlineAt,
        managedProcessGroup: true,
        retainOnAbnormalExit: true,
        maxBuffer: 16 * 1024,
      },
    };
  });
  if (commands.length && runTextConcurrently(commands, 2).some((result) => !("output" in result)))
    throw new ValidationRecoveryRequiredError(
      "Configured native sandbox retirement is unverified",
      undefined,
      states.map((name) => join(privateTemp, name)),
    );
}

function normalizeOpenclawResult(
  processResult: CodexProcessResult,
  completeStdout: string,
  checkoutInspection?: { expectedText: string; expectedPath: string },
  receipt?: { cwd: string; entries?: unknown[] | undefined },
): CodexProcessResult {
  if (processResult.error || processResult.status !== 0) return processResult;
  const parsed = parseOpenclawJsonEnvelope(completeStdout, processResult.stderr);
  if (!parsed.failure) {
    if (!checkoutInspection) {
      const execution = projectOpenclawExecutionReceipt(JSON.parse(completeStdout));
      return { ...processResult, stdout: parsed.text, ...(execution ? { execution } : {}) };
    }
    if (parsed.text.trim() !== checkoutInspection.expectedText) {
      return failedInspectionResult(
        processResult,
        "OpenClaw checkout inspection did not return the runner challenge.",
      );
    }
    // The runtime-owned session receipt binds the successful read to the
    // host-selected tracked path, whose expected line never enters the prompt.
    if (
      !receipt ||
      !hasSuccessfulReadReceipt({
        ...receipt,
        expectedPath: checkoutInspection.expectedPath,
      })
    ) {
      return failedInspectionResult(
        processResult,
        "OpenClaw checkout inspection did not read the exact challenged path.",
      );
    }
    return { ...processResult, stdout: "" };
  }
  if (/\btimeout\b/i.test(parsed.failure.message)) {
    (parsed.failure as NodeJS.ErrnoException).code = "ETIMEDOUT";
  }
  return { ...processResult, status: 1, error: parsed.failure, stdout: parsed.text };
}

function readCheckoutReceipt(params: {
  stateDir: string;
  sessionId: string;
  options: OpenClawProcessOptions;
  childEnv: NodeJS.ProcessEnv;
  deadlineAt: number;
}): unknown[] | undefined {
  try {
    const legacy = join(params.stateDir, "agents", "main", "sessions", params.sessionId + ".jsonl");
    if (existsSync(legacy)) {
      if (statSync(legacy).size > 1024 * 1024) return undefined;
      return readFileSync(legacy, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    // Current OpenClaw owns transcripts in SQLite. Use its local, read-only
    // exporter, not a private database schema or another session's state.
    const remaining = params.deadlineAt - Date.now();
    if (remaining <= 0) return undefined;
    const timeoutMs = Math.min(10_000, remaining);
    const workerOptionsPath = join(params.stateDir, "receipt-worker.json");
    const resultPath = join(params.stateDir, "receipt-result.json");
    const stdoutPath = join(params.stateDir, "receipt-stdout.json");
    writeFileSync(
      workerOptionsPath,
      JSON.stringify({
        command: params.options.env.CLAWSWEEPER_OPENCLAW_BIN?.trim() || "openclaw",
        args: [
          "sessions",
          "export-trajectory",
          "--agent",
          "main",
          "--session-key",
          "agent:main:explicit:" + params.sessionId,
          "--workspace",
          params.stateDir,
          "--output",
          "checkout-receipt",
          "--json",
        ],
        timeoutMs,
        resultPath,
        stdoutPath,
        stderrPath: join(params.stateDir, "receipt-stderr.log"),
        tailBytes: 256 * 1024,
        maxOutputFileBytes: 256 * 1024,
      }),
      { mode: 0o600 },
    );
    // Reuse the same native worker's process-group forwarding and escalation.
    // Pass the filtered environment exactly, never merge ambient workflow secrets.
    const worker = spawnSync(process.execPath, [OPENCLAW_PROCESS_WORKER_PATH, workerOptionsPath], {
      cwd: params.options.cwd,
      env: params.childEnv,
      stdio: "ignore",
      timeout: timeoutMs + 10_000,
    });
    if (worker.error || !existsSync(resultPath)) return undefined;
    const exported = deserializeResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (exported.error || exported.status !== 0) return undefined;
    const summary: unknown = JSON.parse(readFileSync(stdoutPath, "utf8"));
    if (!isRecord(summary) || summary.sessionId !== params.sessionId) return undefined;
    const exportDir = join(params.stateDir, ".openclaw", "trajectory-exports", "checkout-receipt");
    const eventPath = join(exportDir, "events.jsonl");
    if (statSync(eventPath).size > 1024 * 1024) return undefined;
    const manifest = JSON.parse(readFileSync(join(exportDir, "manifest.json"), "utf8"));
    const events: unknown[] = readFileSync(eventPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      !isRecord(manifest) ||
      manifest.sessionId !== params.sessionId ||
      manifest.eventCount !== events.length ||
      (manifest.warnings !== undefined &&
        (!Array.isArray(manifest.warnings) || manifest.warnings.length > 0))
    )
      return undefined;
    const entries: unknown[] = [];
    for (const event of events) {
      if (
        !isRecord(event) ||
        event.traceSchema !== "openclaw-trajectory" ||
        event.schemaVersion !== 1 ||
        event.sessionId !== params.sessionId
      )
        return undefined;
      if (event.source !== "transcript") continue;
      if (!isRecord(event.data)) continue;
      if (event.type === "tool.call")
        entries.push({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: event.data.toolCallId,
                name: event.data.name,
                arguments: restoreExportedReadPath(event.data.arguments, params),
              },
            ],
          },
        });
      if (event.type === "tool.result") entries.push({ message: event.data.message });
    }
    return entries;
  } catch {
    return undefined;
  }
}

function restoreExportedReadPath(
  args: unknown,
  params: { stateDir: string; childEnv: NodeJS.ProcessEnv },
): unknown {
  if (!isRecord(args) || typeof args.path !== "string") return args;
  // The native exporter redacts absolute paths. Restore only its known prefixes
  // from this exact child environment; legacy JSONL receipts stay untouched.
  const prefix = /^(~|\$WORKSPACE_DIR|\$OPENCLAW_STATE_DIR)(?=$|[/\\])/.exec(args.path);
  if (!prefix) return args;
  const roots = new Set(
    (prefix[1] === "~" ? [params.childEnv.HOME, params.childEnv.USERPROFILE] : [params.stateDir])
      .filter((value): value is string => Boolean(value))
      .map((value) => resolve(value)),
  );
  // HOME and USERPROFILE share the same exported label. Never guess when the
  // redaction loses which of two different roots the successful read used.
  if (roots.size !== 1) return undefined;
  const root = [...roots][0]!;
  return { ...args, path: resolve(root + args.path.slice(prefix[0].length)) };
}

function hasSuccessfulReadReceipt(options: {
  cwd: string;
  entries?: unknown[] | undefined;
  expectedPath: string;
}): boolean {
  if (!options.entries) return false;
  const readCalls = new Map<string, { matchesExpectedPath: boolean; resolved: boolean }>();
  let challengedReadSucceeded = false;
  for (const entry of options.entries) {
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        if (
          block.name !== "read" ||
          typeof block.id !== "string" ||
          !isRecord(block.arguments) ||
          typeof block.arguments.path !== "string" ||
          readCalls.has(block.id)
        ) {
          return false;
        }
        readCalls.set(block.id, {
          matchesExpectedPath:
            resolve(options.cwd, block.arguments.path) ===
            resolve(options.cwd, options.expectedPath),
          resolved: false,
        });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    if (message.toolName !== "read" || typeof message.toolCallId !== "string") return false;
    const call = readCalls.get(message.toolCallId);
    if (!call || call.resolved || message.isError !== false) return false;
    call.resolved = true;
    if (call.matchesExpectedPath) challengedReadSucceeded = true;
  }
  return challengedReadSucceeded && [...readCalls.values()].every((call) => call.resolved);
}

function failedInspectionResult(
  processResult: CodexProcessResult,
  message: string,
): CodexProcessResult {
  return { ...processResult, status: 1, error: new Error(message), stdout: "" };
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
  "USERPROFILE",
  "USER",
  // Host-side rootless Podman discovery; never injected as a guest mount.
  "XDG_RUNTIME_DIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "NODE_OPTIONS",
  // Keep host-provided TLS roots for managed/corporate egress; verification stays enabled.
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Provider API keys the embedded agent needs for direct inference. These
  // are the credentials this lane intentionally trades for provider choice;
  // everything else in the step environment stays out.
  ...REVIEW_DIRECT_PROVIDER_ENV_KEYS,
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
