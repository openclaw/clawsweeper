import { writeFileSync } from "node:fs";
import { codexModelArgs, redactInternalCodexModel } from "./codex-env.js";
import {
  runCodexProcess,
  type CodexAppServerProcessOptions,
  type CodexProcessResult,
} from "./codex-process.js";
import { runOpenclawProcess } from "./openclaw-process.js";

export type AgentRunner = "codex" | "openclaw";

export interface RunAgentProcessOptions {
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
  appServer?: CodexAppServerProcessOptions;
  codexExtraArgs?: readonly string[];
}

export function agentRunner(env: NodeJS.ProcessEnv = process.env): AgentRunner {
  const value = env.CLAWSWEEPER_RUNNER?.trim() || "codex";
  if (value === "codex" || value === "openclaw") return value;
  throw new Error(`Invalid CLAWSWEEPER_RUNNER: ${value}. Expected "codex" or "openclaw".`);
}

export function runAgentProcess(options: RunAgentProcessOptions): CodexProcessResult {
  if (agentRunner(options.env) === "codex") {
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
  const outputPath = codexOutputLastMessagePath(options.codexExtraArgs);
  if (!result.error && result.status === 0 && outputPath) {
    writeFileSync(outputPath, result.stdout, "utf8");
  }
  if (!options.appServer) return result;
  const note =
    "[clawsweeper] CLAWSWEEPER_STEERABLE_CODEX is Codex-specific; OpenClaw used a plain run.";
  return { ...result, stderr: [result.stderr.trimEnd(), note].filter(Boolean).join("\n") };
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
