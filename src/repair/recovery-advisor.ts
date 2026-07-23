import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import { recordWorkflowActionEvent } from "../action-ledger-runtime.js";
import { codexEnv, codexModelArgs } from "../codex-env.js";
import { runCodexProcess } from "../codex-process.js";
import { repoRoot } from "./paths.js";

const RECOVERY_MODEL_TIMEOUT_MS = 30_000;
const RECOVERY_OUTPUT_MAX_BYTES = 64 * 1024;
const RECOVERY_TEXT_MAX_CHARS = 8_000;
const RECOVERY_ATTEMPT_HISTORY_LIMIT = 8;
const RECOVERY_ACTION_LIMIT = 8;
const PUBLIC_DIAGNOSIS_TERMS = new Set([
  "authentication",
  "authorization",
  "branch",
  "conflict",
  "deepen",
  "depth",
  "fetch",
  "history",
  "merge",
  "missing",
  "nonfastforward",
  "object",
  "push",
  "race",
  "rebuild",
  "refetch",
  "remote",
  "retry",
  "shallow",
  "timeout",
  "unavailable",
  "unshallow",
]);

export const RECOVERY_ACTION_NAMES = [
  "fetch_object",
  "refetch_depth1",
  "deepen",
  "unshallow",
  "rebuild_on_remote_head",
  "reset_to_remote",
  "retry_push",
  "defer_to_next_run",
  "give_up",
] as const;

export type RecoveryActionName = (typeof RECOVERY_ACTION_NAMES)[number];

export type RecoveryAction =
  | { name: "fetch_object"; sha: string }
  | { name: "deepen"; depth: number }
  | {
      name:
        | "refetch_depth1"
        | "unshallow"
        | "rebuild_on_remote_head"
        | "reset_to_remote"
        | "retry_push"
        | "defer_to_next_run"
        | "give_up";
    };

export type RecoveryFailureContext = {
  phase: string;
  git_error: string;
  shallow: boolean;
  remote: string;
  branch: string;
  recent_attempts: string[];
  available_actions: string[];
};

export type RecoveryPlan = {
  diagnosis: string;
  actions: RecoveryAction[];
  confidence: number;
};

export type RecoveryAdvice = {
  context: RecoveryFailureContext;
  contextHash: string;
  plan: RecoveryPlan;
};

export type RecoveryExecution = {
  actions: string[];
  directive:
    | "continue"
    | "rebuild_on_remote_head"
    | "reset_to_remote"
    | "retry_push"
    | "defer_to_next_run"
    | "give_up";
};

export type RecoveryActionHandlers = Partial<{
  fetchObject: (sha: string) => void;
  refetchDepth1: () => void;
  deepen: (depth: number) => void;
  unshallow: () => void;
  rebuildOnRemoteHead: () => void;
  resetToRemote: () => void;
  retryPush: () => void;
  deferToNextRun: () => void;
  giveUp: () => void;
}>;

export type RecoveryModelRunner = (input: {
  context: RecoveryFailureContext;
  contextHash: string;
  prompt: string;
  timeoutMs: number;
}) => string;

export function modelRecoveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CLAWSWEEPER_MODEL_RECOVERY_ENABLED === "1" &&
    Boolean(env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim())
  );
}

export function buildRecoveryFailureContext(input: {
  phase: string;
  gitError: unknown;
  shallow: boolean;
  remote: string;
  branch: string;
  recentAttempts?: readonly string[];
  availableActions?: readonly RecoveryActionName[];
  env?: NodeJS.ProcessEnv;
}): RecoveryFailureContext {
  const env = input.env ?? process.env;
  return {
    phase: machineToken(input.phase, "recovery phase"),
    git_error: redactRecoverySecrets(errorText(input.gitError), env).slice(
      0,
      RECOVERY_TEXT_MAX_CHARS,
    ),
    shallow: input.shallow,
    remote: redactRecoverySecrets(input.remote, env).slice(0, 256),
    branch: redactRecoverySecrets(input.branch, env).slice(0, 256),
    recent_attempts: (input.recentAttempts ?? [])
      .slice(-RECOVERY_ATTEMPT_HISTORY_LIMIT)
      .map((attempt) =>
        redactRecoverySecrets(String(attempt), env).slice(0, RECOVERY_TEXT_MAX_CHARS),
      ),
    available_actions: (input.availableActions ?? RECOVERY_ACTION_NAMES).map(String),
  };
}

export function recoveryContextHash(context: RecoveryFailureContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

export function requestRecoveryAdvice(
  context: RecoveryFailureContext,
  options: {
    env?: NodeJS.ProcessEnv;
    modelRunner?: RecoveryModelRunner;
    timeoutMs?: number;
  } = {},
): RecoveryAdvice | null {
  const env = options.env ?? process.env;
  if (!modelRecoveryConfigured(env)) return null;
  const contextHash = recoveryContextHash(context);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  try {
    const prompt = recoveryPrompt(context, contextHash);
    const raw = (options.modelRunner ?? defaultRecoveryModelRunner)({
      context,
      contextHash,
      prompt,
      timeoutMs,
    });
    const plan = parseRecoveryPlan(raw, context);
    plan.diagnosis = redactRecoverySecrets(plan.diagnosis, env);
    return { context, contextHash, plan };
  } catch (error) {
    console.warn(
      `Model-guided Git recovery unavailable; using deterministic fallback: ${safeReason(error)}`,
    );
    return null;
  }
}

export function parseRecoveryPlan(raw: string, context: RecoveryFailureContext): RecoveryPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("recovery plan is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("recovery plan must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify(["actions", "confidence", "diagnosis"])
  ) {
    throw new Error("recovery plan keys are invalid");
  }
  if (
    typeof record.diagnosis !== "string" ||
    !record.diagnosis.trim() ||
    record.diagnosis.length > 2_000
  ) {
    throw new Error("recovery diagnosis is invalid");
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error("recovery confidence must be between 0 and 1");
  }
  if (
    !Array.isArray(record.actions) ||
    record.actions.length === 0 ||
    record.actions.length > RECOVERY_ACTION_LIMIT ||
    !record.actions.every((action) => typeof action === "string")
  ) {
    throw new Error("recovery actions are invalid");
  }
  const actions = record.actions.map((action) => parseRecoveryAction(action as string, context));
  const formatted = actions.map(formatRecoveryAction);
  if (new Set(formatted).size !== formatted.length) {
    throw new Error("recovery plan contains duplicate actions");
  }
  const terminalIndex = actions.findIndex((action) => terminalRecoveryAction(action.name));
  if (terminalIndex >= 0 && terminalIndex !== actions.length - 1) {
    throw new Error("terminal recovery action must be last");
  }
  const unshallowIndex = actions.findIndex((action) => action.name === "unshallow");
  if (
    unshallowIndex >= 0 &&
    actions.slice(unshallowIndex + 1).some((action) => !terminalRecoveryAction(action.name))
  ) {
    throw new Error("unshallow must be the last history-changing recovery action");
  }
  return { diagnosis: record.diagnosis.trim(), actions, confidence: record.confidence };
}

export function executeRecoveryActions(
  actions: readonly RecoveryAction[],
  handlers: RecoveryActionHandlers,
): RecoveryExecution {
  let directive: RecoveryExecution["directive"] = "continue";
  const executed: string[] = [];
  for (const action of actions) {
    const formatted = formatRecoveryAction(action);
    switch (action.name) {
      case "fetch_object":
        requiredHandler(handlers.fetchObject, action.name)(action.sha);
        break;
      case "refetch_depth1":
        requiredHandler(handlers.refetchDepth1, action.name)();
        break;
      case "deepen":
        requiredHandler(handlers.deepen, action.name)(action.depth);
        break;
      case "unshallow":
        requiredHandler(handlers.unshallow, action.name)();
        break;
      case "rebuild_on_remote_head":
        requiredHandler(handlers.rebuildOnRemoteHead, action.name)();
        directive = action.name;
        break;
      case "reset_to_remote":
        requiredHandler(handlers.resetToRemote, action.name)();
        directive = action.name;
        break;
      case "retry_push":
        requiredHandler(handlers.retryPush, action.name)();
        directive = action.name;
        break;
      case "defer_to_next_run":
        requiredHandler(handlers.deferToNextRun, action.name)();
        directive = action.name;
        break;
      case "give_up":
        requiredHandler(handlers.giveUp, action.name)();
        directive = action.name;
        break;
    }
    executed.push(formatted);
  }
  return { actions: executed, directive };
}

export function recordRecoveryOutcome(
  advice: RecoveryAdvice,
  outcome: string,
  options: { env?: NodeJS.ProcessEnv; root?: string; error?: unknown } = {},
): void {
  const env = options.env ?? process.env;
  const normalizedOutcome = machineToken(outcome, "recovery outcome");
  const failed = normalizedOutcome.includes("failed") || normalizedOutcome === "give_up";
  const gaveUp = normalizedOutcome === "give_up";
  const deferred = normalizedOutcome === "defer_to_next_run";
  const selected = normalizedOutcome.endsWith("_selected");
  const plan = advice.plan.actions.map(formatRecoveryAction).join("+");
  const diagnosis = publicDiagnosisSummary(advice.plan.diagnosis);
  try {
    recordWorkflowActionEvent(
      options.root ?? env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() ?? repoRoot(),
      {
        scope: "publication.git_recovery",
        identity: {
          context_sha256: advice.contextHash,
          diagnosis,
          plan,
          outcome: normalizedOutcome,
        },
        operation: "git_recovery",
        operationIdentity: { context_sha256: advice.contextHash },
        attemptIdentity: { context_sha256: advice.contextHash, plan },
        type: ACTION_EVENT_TYPES.publicationLifecycle,
        component: "git_recovery",
        subject: {
          repository: env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper",
          kind: "publication",
          subjectId: "git_recovery",
          sourceRevision: advice.contextHash,
        },
        action: {
          name: "git.recovery",
          status: failed
            ? ACTION_EVENT_STATUSES.failed
            : deferred
              ? ACTION_EVENT_STATUSES.yielded
              : selected
                ? ACTION_EVENT_STATUSES.planned
                : ACTION_EVENT_STATUSES.recovered,
          reasonCode: failed
            ? ACTION_EVENT_REASON_CODES.exception
            : deferred
              ? ACTION_EVENT_REASON_CODES.retryScheduled
              : selected
                ? ACTION_EVENT_REASON_CODES.selected
                : ACTION_EVENT_REASON_CODES.completed,
          retryable: deferred || selected || (failed && !gaveUp),
          mutation: false,
        },
        learning: {
          category: "model_guided_git_recovery",
          signal: diagnosis,
          ruleId: ledgerText(plan),
          confidence: advice.plan.confidence,
        },
        attributes: {
          action_count: advice.plan.actions.length,
          phase: advice.context.phase,
          state: normalizedOutcome,
          validation_kind: "allowlisted_plan",
        },
        privacy: {
          classification: "public",
          redactionVersion: "git_recovery_v1",
          fieldsDropped: ["git_error", ...(options.error === undefined ? [] : ["execution_error"])],
        },
      },
      { env },
    );
  } catch (error) {
    console.warn(`Failed to record model-guided Git recovery outcome: ${safeReason(error)}`);
  }
}

export function redactRecoverySecrets(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = value;
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CLAWSWEEPER_STATE_REPO_TOKEN",
    "CLAWSWEEPER_WEBHOOK_SECRET",
    "CLAWSWEEPER_APP_PRIVATE_KEY",
  ]) {
    const secret = env[key]?.trim();
    if (secret && secret.length >= 8) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(
      /\b(OPENAI_API_KEY|CODEX_API_KEY|GH_TOKEN|GITHUB_TOKEN|CLAWSWEEPER_STATE_REPO_TOKEN)=([^\s"']+)/g,
      "$1=[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[REDACTED_URL]")
    .replace(/\b[^\s/@:]+@[^\s]+:[^\s]+/g, "[REDACTED_GIT_REMOTE]");
}

export function formatRecoveryAction(action: RecoveryAction): string {
  if (action.name === "fetch_object") return `${action.name} ${action.sha}`;
  if (action.name === "deepen") return `${action.name} ${action.depth}`;
  return action.name;
}

function parseRecoveryAction(value: string, context: RecoveryFailureContext): RecoveryAction {
  const normalized = value.trim();
  const fetchMatch = /^fetch_object ([a-fA-F0-9]{40,64})$/.exec(normalized);
  if (fetchMatch?.[1]) {
    if (!context.available_actions.includes("fetch_object")) {
      throw new Error(`fetch_object is not available during ${context.phase}`);
    }
    const sha = fetchMatch[1].toLowerCase();
    const knownObjects = new Set(
      [
        ...`${context.git_error}\n${context.recent_attempts.join("\n")}`.matchAll(
          /\b[a-f0-9]{40,64}\b/gi,
        ),
      ].map((match) => match[0].toLowerCase()),
    );
    if (!knownObjects.has(sha))
      throw new Error("fetch_object must target an object from the failure context");
    return { name: "fetch_object", sha };
  }
  const deepenMatch = /^deepen ([0-9]+)$/.exec(normalized);
  if (deepenMatch?.[1]) {
    if (!context.available_actions.includes("deepen")) {
      throw new Error(`deepen is not available during ${context.phase}`);
    }
    const depth = Number(deepenMatch[1]);
    if (!Number.isInteger(depth) || depth < 1 || depth > 64) {
      throw new Error("deepen must be between 1 and 64");
    }
    if (!context.shallow) throw new Error("deepen requires a shallow repository");
    return { name: "deepen", depth };
  }
  if (normalized === "fetch_object" || normalized === "deepen") {
    throw new Error(`${normalized} requires an argument`);
  }
  if (!RECOVERY_ACTION_NAMES.includes(normalized as RecoveryActionName)) {
    throw new Error(`unknown recovery action: ${normalized || "<empty>"}`);
  }
  const name = normalized as Exclude<RecoveryActionName, "fetch_object" | "deepen">;
  if ((name === "refetch_depth1" || name === "unshallow") && !context.shallow) {
    throw new Error(`${name} requires a shallow repository`);
  }
  if (!context.available_actions.includes(name)) {
    throw new Error(`${name} is not available during ${context.phase}`);
  }
  return { name };
}

function defaultRecoveryModelRunner(input: { prompt: string; timeoutMs: number }): string {
  const workDir = mkdtempSync(join(tmpdir(), "clawsweeper-recovery-advisor-"));
  const outputPath = join(workDir, "recovery-plan.json");
  try {
    const result = runCodexProcess({
      args: [
        "exec",
        ...codexModelArgs(process.env.CLAWSWEEPER_MODEL_RECOVERY_MODEL ?? "internal"),
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        'approval_policy="never"',
        "-c",
        'shell_environment_policy.inherit="none"',
        "-c",
        'web_search="disabled"',
        "--sandbox",
        "read-only",
        "--disable",
        "shell_tool",
        "--disable",
        "apps",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--ephemeral",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--output-schema",
        join(repoRoot(), "schema", "repair", "recovery-advisor.schema.json"),
        "--output-last-message",
        outputPath,
        "-",
      ],
      cwd: workDir,
      env: recoveryCodexEnv(),
      input: input.prompt,
      timeoutMs: input.timeoutMs,
      tailBytes: 8 * 1024,
      outputFileBytes: RECOVERY_OUTPUT_MAX_BYTES,
    });
    if (result.error || result.status !== 0 || !existsSync(outputPath)) {
      throw new Error(
        result.error?.message || `Codex recovery advisor exited ${result.status ?? "unknown"}`,
      );
    }
    if (statSync(outputPath).size > RECOVERY_OUTPUT_MAX_BYTES) {
      throw new Error("Codex recovery plan exceeded the output limit");
    }
    return readFileSync(outputPath, "utf8");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function recoveryCodexEnv(): NodeJS.ProcessEnv {
  const env = codexEnv({ preserveCodexAuth: true });
  const allowedSecrets = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]);
  for (const key of Object.keys(env)) {
    if (
      !allowedSecrets.has(key) &&
      /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)$/i.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

function recoveryPrompt(context: RecoveryFailureContext, contextHash: string): string {
  return [
    "Diagnose this Git publication failure and choose the smallest safe recovery plan.",
    "Return only JSON matching the supplied schema.",
    "Use only actions listed in available_actions, with these exact forms:",
    "fetch_object <sha>, refetch_depth1, deepen <n>, unshallow, rebuild_on_remote_head, reset_to_remote, retry_push, defer_to_next_run, give_up.",
    "Never propose shell commands. deepen must be an integer from 1 through 64. fetch_object must use a SHA present in the context.",
    "Prefer defer_to_next_run or give_up when the safe recovery is unclear.",
    `Failure context hash: ${contextHash}`,
    JSON.stringify(context, null, 2),
  ].join("\n\n");
}

function terminalRecoveryAction(name: RecoveryActionName): boolean {
  return [
    "rebuild_on_remote_head",
    "reset_to_remote",
    "retry_push",
    "defer_to_next_run",
    "give_up",
  ].includes(name);
}

function requiredHandler<T extends (...args: never[]) => void>(
  handler: T | undefined,
  action: RecoveryActionName,
): T {
  if (!handler) throw new Error(`recovery action is not executable in this phase: ${action}`);
  return handler;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const combined = [record.stderr, record.stdout]
      .filter((part) => typeof part === "string")
      .join("\n");
    if (combined) return combined;
  }
  return String(value);
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return RECOVERY_MODEL_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(value), RECOVERY_MODEL_TIMEOUT_MS));
}

function machineToken(value: string, label: string): string {
  const token = value
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!token) throw new Error(`${label} is empty`);
  return token.slice(0, 240);
}

function ledgerText(value: string): string {
  return machineToken(value, "recovery ledger text");
}

export function publicDiagnosisSummary(value: string): string {
  const terms = value
    .toLowerCase()
    .replace(/non[- ]fast[- ]forward/g, "nonfastforward")
    .match(/[a-z]+/g)
    ?.filter((term) => PUBLIC_DIAGNOSIS_TERMS.has(term));
  return [...new Set(terms?.slice(0, 12) ?? [])].join("_") || "unclassified_git_failure";
}

function safeReason(error: unknown): string {
  return redactRecoverySecrets(errorText(error))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}
