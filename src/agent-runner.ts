import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexModelArgs, redactInternalCodexModel } from "./codex-env.js";
import {
  runCodexProcess,
  type CodexAppServerProcessOptions,
  type CodexProcessResult,
} from "./codex-process.js";
import { runOpenclawProcess } from "./openclaw-process.js";
import { AgentInputScanError, scanAgentInput, type AgentScanSource } from "./agent-input-scan.js";

export type AgentRunner = "codex" | "openclaw";

export interface RunAgentProcessOptions {
  label: string;
  prompt: string;
  // Generated diagnostic copy only; never an original input or requested export.
  diagnosticPromptPath?: string;
  scanSource: AgentScanSource;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  appServer?: CodexAppServerProcessOptions;
  codexExtraArgs?: readonly string[];
}

export function agentRunner(env: NodeJS.ProcessEnv = process.env): AgentRunner {
  const value = env.CLAWSWEEPER_RUNNER?.trim() || "codex";
  if (value === "codex" || value === "openclaw") return value;
  throw new Error(`Invalid CLAWSWEEPER_RUNNER: ${value}. Expected "codex" or "openclaw".`);
}

export function reviewNetworkCapability(
  sandboxMode: string,
  env: NodeJS.ProcessEnv = process.env,
): "allowlisted-proxy" | "unrestricted" | "none" {
  if (agentRunner(env) === "openclaw") return "unrestricted";
  return sandboxMode === "clawsweeper-review" ? "allowlisted-proxy" : "none";
}

export function runAgentProcess(options: RunAgentProcessOptions): CodexProcessResult {
  if (options.diagnosticPromptPath) rmSync(options.diagnosticPromptPath, { force: true });
  const runner = agentRunner(options.env);
  if (runner === "openclaw") openclawModel(options.env);
  const startedAt = Date.now();
  const outputPath = codexOutputLastMessagePath(options.codexExtraArgs);
  if (outputPath) rmSync(outputPath, { force: true });
  const schemaIndex = options.codexExtraArgs?.lastIndexOf("--output-schema") ?? -1;
  const schemaPath = schemaIndex >= 0 ? options.codexExtraArgs?.[schemaIndex + 1] : undefined;
  scanAgentInput({
    cwd: options.cwd,
    prompt: options.prompt,
    source: options.scanSource,
    timeoutMs: options.timeoutMs,
    ...(schemaPath ? { schemaPath } : {}),
  });
  if (options.diagnosticPromptPath) {
    writeFileSync(options.diagnosticPromptPath, options.prompt, { mode: 0o600, flag: "wx" });
  }
  options = { ...options, timeoutMs: options.timeoutMs - (Date.now() - startedAt) };
  if (options.timeoutMs <= 0) {
    if (options.diagnosticPromptPath) rmSync(options.diagnosticPromptPath, { force: true });
    throw new AgentInputScanError("deadline");
  }
  if (runner === "codex") {
    return runCodexProcess({
      args: codexAgentArgs(options),
      cwd: options.cwd,
      env: options.env,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
      ...(options.outputFileBytes === undefined
        ? {}
        : { outputFileBytes: options.outputFileBytes }),
      ...(options.stdoutPath ? { stdoutPath: options.stdoutPath } : {}),
      ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
      ...(options.appServer ? { appServer: options.appServer } : {}),
    });
  }

  const model = openclawModel(options.env);
  const rawResult = runOpenclawProcess({
    label: options.label,
    prompt: options.prompt,
    model,
    ...(options.reasoningEffort?.trim() ? { reasoningEffort: options.reasoningEffort.trim() } : {}),
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
    ...(options.outputFileBytes === undefined ? {} : { outputFileBytes: options.outputFileBytes }),
    ...(options.stdoutPath ? { stdoutPath: options.stdoutPath } : {}),
    ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
  });
  const result = redactOpenclawFailure(rawResult, model);
  if (!result.error && result.status === 0 && outputPath) {
    writeFileSync(outputPath, result.stdout, "utf8");
  }
  if (!options.appServer) return result;
  const note =
    "[clawsweeper] CLAWSWEEPER_STEERABLE_CODEX is Codex-specific; OpenClaw used a plain run.";
  return { ...result, stderr: [result.stderr.trimEnd(), note].filter(Boolean).join("\n") };
}

export function runAgentCheckoutInspection(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  scanSource: AgentScanSource;
  initialPrompt: string;
  schemaPath?: string;
}): CodexProcessResult {
  const deadlineAt = Date.now() + options.timeoutMs;
  const remainingMs = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new AgentInputScanError("deadline");
    return remaining;
  };
  const env = { ...options.env, GIT_OPTIONAL_LOCKS: "0" };
  // Large repositories list tens of thousands of tracked paths (openclaw/openclaw
  // exceeds 3 MB); the 1 MB spawnSync default returns ENOBUFS and fails inspection.
  const trackedFiles = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
    timeout: Math.min(remainingMs(), 30_000),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (trackedFiles.error || trackedFiles.status !== 0) return spawnResult(trackedFiles);
  const candidates = (trackedFiles.stdout ?? "").split("\0").flatMap((entry) => {
    const separator = entry.indexOf("\t");
    if (separator < 0) return [];
    const metadata = entry.slice(0, separator);
    const path = entry.slice(separator + 1);
    return /^(?:100644|100755) [0-9a-f]{40,64} 0$/.test(metadata) && path ? [path] : [];
  });
  const start = candidates.length > 0 ? randomInt(candidates.length) : 0;
  const orderedCandidates = [...candidates.slice(start), ...candidates.slice(0, start)];
  if (agentRunner(env) === "openclaw") {
    const challenge = selectOpenclawCheckoutChallenge(options.cwd, orderedCandidates);
    if (!challenge) {
      return failedCheckoutInspection(
        new Error("Checkout inspection could not select a tracked text line."),
      );
    }
    const prompt = [
      "Use the read tool to inspect the workspace-relative file below.",
      `Path: ${JSON.stringify(challenge.path)}`,
      `Return exactly line ${challenge.lineNumber} with surrounding whitespace removed.`,
      "Do not add quotes, code fences, or commentary.",
    ].join("\n");
    scanAgentInput({
      cwd: options.cwd,
      prompt: options.initialPrompt,
      source: options.scanSource,
      timeoutMs: remainingMs(),
      ...(options.schemaPath ? { schemaPath: options.schemaPath } : {}),
      additionalBytes: [Buffer.from(prompt), readFileSync(join(options.cwd, challenge.path))],
    });
    return runOpenclawProcess({
      label: "checkout-inspection",
      prompt,
      model: openclawModel(env),
      cwd: options.cwd,
      env,
      timeoutMs: Math.min(remainingMs(), 30_000),
      checkoutInspection: { expectedText: challenge.text, expectedPath: challenge.path },
    });
  }
  scanAgentInput({
    cwd: options.cwd,
    prompt: options.initialPrompt,
    source: options.scanSource,
    timeoutMs: remainingMs(),
    ...(options.schemaPath ? { schemaPath: options.schemaPath } : {}),
  });
  let fingerprintPath = "";
  let fingerprint = "";
  for (const candidate of orderedCandidates) {
    const hashed = spawnSync("git", ["hash-object", "--no-filters", "--", candidate], {
      cwd: options.cwd,
      encoding: "utf8",
      env,
      timeout: Math.min(remainingMs(), 30_000),
    });
    const value = (hashed.stdout ?? "").trim();
    if (!hashed.error && hashed.status === 0 && /^[0-9a-f]{40,64}$/.test(value)) {
      fingerprintPath = candidate;
      fingerprint = value;
      break;
    }
  }
  if (!fingerprintPath) {
    return {
      status: 1,
      signal: null,
      error: new Error("Checkout inspection could not select a tracked file."),
      stdout: "",
      stderr: "",
    };
  }
  return verifyCheckoutChallenge(
    runCodexProcess({
      args: [
        "sandbox",
        "--permission-profile",
        ":read-only",
        "-C",
        options.cwd,
        "--",
        "git",
        "hash-object",
        "--no-filters",
        "--",
        fingerprintPath,
      ],
      cwd: options.cwd,
      env,
      input: "",
      timeoutMs: Math.min(remainingMs(), 30_000),
    }),
    fingerprint,
  );
}

function selectOpenclawCheckoutChallenge(
  cwd: string,
  candidates: readonly string[],
): { path: string; lineNumber: number; text: string } | undefined {
  for (const path of candidates) {
    try {
      const absolutePath = join(cwd, path);
      const stat = lstatSync(absolutePath);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolutePath));
      const lines = contents.split(/\r?\n/);
      const start = lines.length > 0 ? randomInt(lines.length) : 0;
      for (let offset = 0; offset < lines.length; offset += 1) {
        const lineNumber = ((start + offset) % lines.length) + 1;
        const text = lines[lineNumber - 1]?.trim() ?? "";
        if (text.length >= 16 && text.length <= 512 && !hasDisallowedControlCharacter(text)) {
          return { path, lineNumber, text };
        }
      }
    } catch {
      // Unreadable candidates cannot prove checkout access; try another tracked text file.
    }
  }
  return undefined;
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) return true;
  }
  return false;
}

function failedCheckoutInspection(error: unknown): CodexProcessResult {
  return {
    status: 1,
    signal: null,
    error: error instanceof Error ? error : new Error(String(error)),
    stdout: "",
    stderr: "",
  };
}

function verifyCheckoutChallenge(
  result: CodexProcessResult,
  fingerprint: string,
): CodexProcessResult {
  if (result.error || result.status !== 0) return result;
  if (result.stdout.trim() !== fingerprint) {
    return {
      status: 1,
      signal: result.signal,
      error: new Error("Codex checkout inspection did not return the runner challenge."),
      stdout: "",
      stderr: result.stderr,
    };
  }
  return {
    ...result,
    stdout: "",
  };
}

function spawnResult(result: ReturnType<typeof spawnSync>): CodexProcessResult {
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function redactOpenclawFailure(result: CodexProcessResult, model: string): CodexProcessResult {
  const redact = (value: string): string =>
    redactInternalCodexModel(value).replaceAll(model, "[REDACTED_INTERNAL_MODEL]");
  const failed = Boolean(result.error) || result.status !== 0;
  return {
    ...result,
    ...(result.error ? { error: copyError(result.error, redact(result.error.message)) } : {}),
    stdout: failed ? redact(result.stdout) : result.stdout,
    stderr: redact(result.stderr),
  };
}

function copyError(error: Error, message: string): Error {
  const copy = new Error(message);
  copy.name = error.name;
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") (copy as NodeJS.ErrnoException).code = code;
  return copy;
}

export function codexAgentArgs(options: RunAgentProcessOptions): string[] {
  const extraArgs = [...(options.codexExtraArgs ?? [])];
  const hasOrderedModelArgs = extraArgs.includes("--model");
  const hasOrderedReasoningConfig = extraArgs.some((value) =>
    /^model_reasoning_effort\s*=/.test(value),
  );
  const reasoningEffort = options.reasoningEffort?.trim();
  return [
    "exec",
    ...(hasOrderedModelArgs ? [] : codexModelArgs(options.model)),
    ...(reasoningEffort && !hasOrderedReasoningConfig
      ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
      : []),
    ...extraArgs,
  ];
}

function openclawModel(env: NodeJS.ProcessEnv): string {
  const model = env.CLAWSWEEPER_OPENCLAW_MODEL?.trim();
  if (!model) {
    throw new Error("CLAWSWEEPER_OPENCLAW_MODEL is required when CLAWSWEEPER_RUNNER=openclaw.");
  }
  if (!/^[^\s/]+\/[^\s/]+$/.test(model)) {
    throw new Error(
      "CLAWSWEEPER_OPENCLAW_MODEL must use provider/model form when CLAWSWEEPER_RUNNER=openclaw.",
    );
  }
  return model;
}

function codexOutputLastMessagePath(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  const index = args.lastIndexOf("--output-last-message");
  const value = index === -1 ? undefined : args[index + 1];
  return value?.trim() || undefined;
}
