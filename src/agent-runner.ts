import { randomInt } from "node:crypto";
import { UserFacingCommandError } from "./command.js";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { codexModelArgs, redactInternalCodexModel } from "./codex-env.js";
import { codexProcessCommand, runCodexProcess, type CodexProcessResult } from "./codex-process.js";
import { runOpenclawProcess } from "./openclaw-process.js";
import { AgentInputScanError, scanAgentInput, type AgentScanSource } from "./agent-input-scan.js";
import type { DecisionRepairOptions } from "./review-decision-repair.js";
import type { RepositoryReviewConfig } from "./repository-review-config.js";

export type AgentRunner = "codex" | "openclaw";

export class ReviewPromptBudgetError extends UserFacingCommandError {
  constructor(bytes: number) {
    super(`Review prompt exceeded its ${bytes}-byte output budget.`);
    this.name = "ReviewPromptBudgetError";
  }
}

export interface RunAgentProcessOptions {
  label: string;
  prompt: string;
  // Generated diagnostic copy only; never an original input or requested export.
  diagnosticPromptPath?: string;
  promptFileBytes?: number;
  scanSource: AgentScanSource;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  outputLastMessageBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  codexExtraArgs?: readonly string[];
  // Codex only: one repair turn on the same thread when the final decision fails validation.
  decisionRepair?: DecisionRepairOptions;
  repositoryReview?: RepositoryReviewConfig;
  selection?: import("./repository-review-config.js").ReviewModelSelection;
  reviewPhase?: "independent" | "consolidation";
  nativeReadRoots?: string[];
}

export function agentRunner(env: NodeJS.ProcessEnv = process.env): AgentRunner {
  const value = env.CLAWSWEEPER_RUNNER?.trim() || "codex";
  if (value === "codex" || value === "openclaw") return value;
  throw new Error(`Invalid CLAWSWEEPER_RUNNER: ${value}. Expected "codex" or "openclaw".`);
}

export function reviewNetworkCapability(
  sandboxMode: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  networkCapability: "allowlisted-proxy" | "unrestricted" | "none";
  hasGitHubToken: boolean;
} {
  const runner = agentRunner(env);
  return {
    networkCapability:
      runner === "openclaw"
        ? "unrestricted"
        : sandboxMode === "clawsweeper-review"
          ? "allowlisted-proxy"
          : "none",
    // OpenClaw's final child allowlist strips workflow credentials, including GH_TOKEN.
    hasGitHubToken: runner === "codex" && Boolean(env.GH_TOKEN?.trim()),
  };
}

export function runAgentProcess(options: RunAgentProcessOptions): CodexProcessResult {
  if (options.diagnosticPromptPath) rmSync(options.diagnosticPromptPath, { force: true });
  if (options.selection) {
    const selection = options.selection;
    if (selection.contextTier === "long_context")
      throw new Error("Explicit long_context is unsupported.");
    options = {
      ...options,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
      env: {
        ...options.env,
        CLAWSWEEPER_RUNNER: selection.runner,
        ...(selection.runner === "openclaw" ? { CLAWSWEEPER_OPENCLAW_MODEL: selection.model } : {}),
      },
    };
  }
  const runner = agentRunner(options.env);
  if (runner === "openclaw") openclawModel(options.env);
  const startedAt = Date.now();
  const outputPath = codexOutputLastMessagePath(options.codexExtraArgs);
  if (
    options.outputLastMessageBytes !== undefined &&
    (!Number.isSafeInteger(options.outputLastMessageBytes) || options.outputLastMessageBytes <= 0)
  ) {
    throw new Error("outputLastMessageBytes must be a positive safe integer.");
  }
  if (options.outputLastMessageBytes !== undefined && !outputPath) {
    throw new Error("outputLastMessageBytes requires --output-last-message.");
  }
  if (outputPath) rmSync(outputPath, { force: true });
  const schemaIndex = options.codexExtraArgs?.lastIndexOf("--output-schema") ?? -1;
  const schemaPath = schemaIndex >= 0 ? options.codexExtraArgs?.[schemaIndex + 1] : undefined;
  scanAgentInput({
    cwd: options.cwd,
    prompt: options.prompt,
    source: options.scanSource,
    timeoutMs: options.timeoutMs,
    ...(schemaPath ? { schemaPath } : {}),
    ...(options.repositoryReview
      ? {
          additionalBytes: [
            Buffer.from(options.repositoryReview.configText),
            Buffer.from(options.repositoryReview.additionalPrompt),
          ],
        }
      : {}),
  });
  if (options.repositoryReview?.additionalPrompt) {
    options = {
      ...options,
      prompt:
        options.prompt +
        "\n\n## Repository additional instructions (subordinate to the review contract)\n" +
        options.repositoryReview.additionalPrompt,
    };
  }
  if (options.reviewPhase)
    options = {
      ...options,
      prompt:
        options.prompt +
        "\n\n## Host review role\nPhase: " +
        options.reviewPhase +
        ". The host schedules all reviewers. Produce one full ordinary Decision for this phase. Do not start another model, pair, agent, or nested review; native repository skills supply analysis guidance, not orchestration authority. Configured role tools have no network access: use the admitted source and its native skills; unavailable external verification is a limit, not evidence against the PR.",
    };

  // OpenClaw has no structured-output option, so it reads the same schema file that Codex
  // receives through --output-schema as a prompt section.
  const prompt =
    runner === "openclaw" && schemaPath
      ? `${options.prompt.trimEnd()}\n\n## Output schema\n\nReturn one JSON object that matches this JSON Schema. The field descriptions are part of the review contract.\n\n\`\`\`json\n${readFileSync(schemaPath, "utf8").trim()}\n\`\`\`\n`
      : options.prompt;
  options = { ...options, timeoutMs: options.timeoutMs - (Date.now() - startedAt) };
  if (options.timeoutMs <= 0) {
    if (options.diagnosticPromptPath) rmSync(options.diagnosticPromptPath, { force: true });
    throw new AgentInputScanError("deadline");
  }
  if (runner === "codex") {
    retainDiagnosticPrompt(options, options.prompt);
    const ordinaryArgs = codexAgentArgs(options);
    const args = options.reviewPhase
      ? isolatedCodexRoleArgs(options, ordinaryArgs, [
          options.cwd,
          ...(options.nativeReadRoots ?? []),
        ])
      : ordinaryArgs;
    const managedOutput = options.outputLastMessageBytes !== undefined && outputPath !== undefined;
    return runCodexProcess({
      args: managedOutput ? managedCodexStdoutArgs(args) : args,
      cwd: options.cwd,
      env: options.reviewPhase
        ? { ...options.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined }
        : options.env,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
      ...(options.outputFileBytes === undefined
        ? {}
        : { outputFileBytes: options.outputFileBytes }),
      ...(managedOutput
        ? {
            outputLastMessagePath: outputPath,
            outputLastMessageBytes: options.outputLastMessageBytes,
          }
        : {}),
      ...(options.stdoutPath ? { stdoutPath: options.stdoutPath } : {}),
      ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
      ...(options.decisionRepair ? { decisionRepair: options.decisionRepair } : {}),
    });
  }

  retainDiagnosticPrompt(options, prompt);
  const model = openclawModel(options.env);
  const rawResult = runOpenclawProcess({
    label: options.label,
    prompt,
    model,
    ...(options.reasoningEffort?.trim() ? { reasoningEffort: options.reasoningEffort.trim() } : {}),
    cwd: options.cwd,
    ...(options.reviewPhase
      ? {
          roleIsolation: {
            readRoots: [options.cwd, ...(options.nativeReadRoots ?? [])],
            ...(options.env.CLAWSWEEPER_PROOF_SCRATCH_DIR
              ? { proofScratchDir: options.env.CLAWSWEEPER_PROOF_SCRATCH_DIR }
              : {}),
          },
        }
      : {}),
    env: options.env,
    timeoutMs: options.timeoutMs,
    ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
    ...(options.outputFileBytes === undefined ? {} : { outputFileBytes: options.outputFileBytes }),
    ...(options.stdoutPath ? { stdoutPath: options.stdoutPath } : {}),
    ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
  });
  const result = redactOpenclawFailure(rawResult, model);
  if (!result.error && result.status === 0 && outputPath) {
    if (
      options.outputLastMessageBytes !== undefined &&
      Buffer.byteLength(result.stdout) > options.outputLastMessageBytes
    ) {
      return {
        ...result,
        error: new Error(
          `OpenClaw result exceeded its ${options.outputLastMessageBytes}-byte limit.`,
        ),
      };
    }
    writeFileSync(
      outputPath,
      result.stdout,
      options.outputLastMessageBytes === undefined
        ? "utf8"
        : { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  return result;
}

function isolatedCodexRoleArgs(
  options: RunAgentProcessOptions,
  args: readonly string[],
  roots: readonly string[],
): string[] {
  const command = codexProcessCommand(options.env, process.platform, options.cwd);
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes("/") || command.includes("\\")
      ? [resolve(options.cwd, command)]
      : (options.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .map((root) => join(root, command));
  const executable = candidates.flatMap((candidate) => {
    try {
      const actual = realpathSync(candidate);
      return lstatSync(actual).isFile() ? [actual] : [];
    } catch {
      return [];
    }
  })[0];
  if (!executable || (!options.env.CODEX_BIN && /\.[cm]?js$/i.test(executable)))
    throw new Error(
      "Configured Codex roles require CODEX_BIN to name the trusted native CLI executable, not an npm launcher; restricted tool roots cannot expose a provider home to find it.",
    );
  const access = new Map([...roots, executable].map((root) => [realpathSync(root), "read"]));
  const scratch = options.env.CLAWSWEEPER_PROOF_SCRATCH_DIR;
  if (scratch) access.set(realpathSync(scratch), "write");
  const providerHome =
    options.env.CODEX_HOME ?? join(options.env.HOME ?? options.env.USERPROFILE ?? "", ".codex");
  const privateParents = [
    providerHome,
    tmpdir(),
    options.env.TMPDIR,
    options.env.TMP,
    options.env.TEMP,
  ]
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(options.cwd, path));
  if (
    [...access.keys()].some((root) =>
      privateParents.some((parent) => {
        const path = relative(root, parent);
        return (
          !path ||
          (path !== ".." &&
            !path.startsWith("../") &&
            !path.startsWith("..\\") &&
            !isAbsolute(path))
        );
      }),
    )
  )
    throw new Error("Codex provider state must remain outside every configured role tool root.");
  const filesystem =
    '":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},' +
    [...access].map(([root, mode]) => JSON.stringify(root) + "=" + JSON.stringify(mode)).join(",");
  const profile = "clawsweeper-configured-review";
  const config =
    "permissions={" +
    JSON.stringify(profile) +
    '={extends=":read-only",filesystem={' +
    filesystem +
    "},network={enabled=false}}}";
  const isolated: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["--sandbox", "-s", "--permission-profile", "-P"].includes(args[i]!)) {
      i++;
      continue;
    }
    isolated.push(args[i]!);
  }
  // CLI profiles are host-owned. Repository model/skill configuration cannot
  // select another profile or widen tool roots. Ordinary single reviews retain
  // their existing managed proxy and permissions unchanged.
  const stdin = isolated.at(-1) === "-" ? isolated.pop() : undefined;
  isolated.push(
    "-c",
    config,
    "-c",
    "default_permissions=" + JSON.stringify(profile),
    "--permission-profile",
    profile,
  );
  if (stdin) isolated.push(stdin);
  return isolated;
}

function retainDiagnosticPrompt(options: RunAgentProcessOptions, prompt: string): void {
  if (
    options.promptFileBytes !== undefined &&
    options.promptFileBytes > 0 &&
    Buffer.byteLength(prompt) > options.promptFileBytes
  )
    throw new ReviewPromptBudgetError(options.promptFileBytes);
  if (options.diagnosticPromptPath)
    writeFileSync(options.diagnosticPromptPath, prompt, { mode: 0o600, flag: "wx" });
}

export function runAgentCheckoutInspection(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  scanSource: AgentScanSource;
  initialPrompt: string;
  schemaPath?: string;
  reviewPhase?: "independent" | "consolidation";
  nativeReadRoots?: string[];
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
    const challengePath = options.reviewPhase
      ? resolve(options.cwd, challenge.path)
      : challenge.path;
    const prompt = [
      options.reviewPhase
        ? "Use the read tool to inspect the exact admitted read-only file below."
        : "Use the read tool to inspect the workspace-relative file below.",
      `Path: ${JSON.stringify(challengePath)}`,
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
      ...(options.reviewPhase
        ? {
            roleIsolation: {
              readRoots: [options.cwd, ...(options.nativeReadRoots ?? [])],
            },
          }
        : {}),
      env,
      // Configured roles already share one bounded review deadline. Native CLI
      // startup, the challenged read, and its export consume that remainder.
      // Preserve the ordinary single-review inspection cap.
      timeoutMs: options.reviewPhase ? remainingMs() : Math.min(remainingMs(), 30_000),
      checkoutInspection: { expectedText: challenge.text, expectedPath: challengePath },
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
    ...(hasOrderedModelArgs
      ? []
      : options.selection
        ? ["--model", options.selection.model]
        : codexModelArgs(options.model)),
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
  if (!/^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/.test(model)) {
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

function managedCodexStdoutArgs(args: readonly string[]): string[] {
  const index = args.lastIndexOf("--output-last-message");
  const withoutFile = index < 0 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
  return withoutFile.filter((arg) => arg !== "--json" && arg !== "--experimental-json");
}
