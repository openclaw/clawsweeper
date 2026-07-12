import { createHash } from "node:crypto";

import {
  looksLikePathArgument,
  packageScriptRequirement,
  stripEnvPrefix,
  vitestPathFilterIndexes,
} from "./validation-command-utils.js";

export const STAGED_PROOF_SCHEMA_VERSION = 1;
export const MAX_STAGED_PROOF_COMMANDS = 32;

export type StagedProofStage =
  | "repository_integrity"
  | "static"
  | "focused_tests"
  | "canonical_changed_surface"
  | "broad_live_or_e2e";

export type StagedProofRisk = {
  level: "narrow" | "elevated";
  signals: string[];
  changed_file_count: number;
};

export type StagedProofCommandSource =
  | "artifact"
  | "configured"
  | "repository_profile"
  | "changed_gate";

export type StagedProofCommandInput = {
  parts: readonly string[];
  source: StagedProofCommandSource;
  canonical: boolean;
  required: boolean;
  originalIndex: number;
};

export type StagedProofSubsumptionContract = {
  command: readonly string[];
  subsumes: readonly (readonly string[])[];
};

export type StagedProofPlanCommand = {
  id: string;
  command_digest: string;
  command_kind: string;
  parts: string[];
  stage: StagedProofStage;
  source: StagedProofCommandSource;
  required: boolean;
  reason: string;
  prerequisite: string | null;
  subsumed_by: string | null;
  original_index: number;
};

export type StagedProofPlan = {
  schema_version: typeof STAGED_PROOF_SCHEMA_VERSION;
  plan_id: string;
  risk: StagedProofRisk;
  commands: StagedProofPlanCommand[];
  deduplicated_commands: number;
};

export type StagedProofTraceStatus =
  | "passed"
  | "failed"
  | "skipped_prerequisite"
  | "skipped_subsumed";

export type StagedProofTraceEntry = {
  stage: StagedProofStage;
  command_digest: string;
  command_kind: string;
  status: StagedProofTraceStatus;
  duration_ms: number;
  reason: string;
  prerequisite: string | null;
};

export type StagedProofTrace = {
  schema_version: typeof STAGED_PROOF_SCHEMA_VERSION;
  plan_id: string;
  status: "passed" | "failed";
  risk: StagedProofRisk;
  commands: StagedProofTraceEntry[];
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    total_duration_ms: number;
  };
};

export type StagedProofRunResult = {
  executedCommands: string[];
  reason: string;
};

export type StagedProofExecutionResult = {
  commands: string[];
  trace: StagedProofTrace;
};

export class StagedProofExecutionError extends Error {
  readonly trace: StagedProofTrace;
  readonly executedCommands: string[];

  constructor(
    message: string,
    trace: StagedProofTrace,
    executedCommands: string[],
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "StagedProofExecutionError";
    this.trace = trace;
    this.executedCommands = executedCommands;
  }
}

export function buildStagedProofPlan({
  commands,
  changedFiles,
  surfaceHints = [],
  subsumptionContracts = [],
}: {
  commands: readonly StagedProofCommandInput[];
  changedFiles: readonly string[];
  surfaceHints?: readonly string[];
  subsumptionContracts?: readonly StagedProofSubsumptionContract[];
}): StagedProofPlan {
  const risk = stagedProofRiskForPaths([...changedFiles, ...surfaceHints]);
  const unique = new Map<string, StagedProofCommandInput>();
  let deduplicatedCommands = 0;

  for (const command of commands) {
    validateCommandShape(command.parts);
    const key = commandKey(command.parts);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, {
        ...command,
        parts: [...command.parts],
      });
      continue;
    }
    deduplicatedCommands += 1;
    unique.set(key, {
      ...previous,
      canonical: previous.canonical || command.canonical,
      required: previous.required || command.required,
      source: strongerSource(previous.source, command.source),
      originalIndex: Math.min(previous.originalIndex, command.originalIndex),
    });
  }

  if (unique.size === 0) throw new Error("staged proof plan has no validation commands");
  if (unique.size > MAX_STAGED_PROOF_COMMANDS) {
    throw new Error(
      `staged proof plan exceeds ${MAX_STAGED_PROOF_COMMANDS} commands (${unique.size})`,
    );
  }

  const ordered = [...unique.values()]
    .map((command) => {
      const classification = classifyStagedProofCommand(command, risk);
      const digest = commandDigest(command.parts);
      return {
        command,
        classification,
        digest,
      };
    })
    .sort(
      (left, right) =>
        stageRank(left.classification.stage, risk) - stageRank(right.classification.stage, risk) ||
        left.command.originalIndex - right.command.originalIndex ||
        commandKey(left.command.parts).localeCompare(commandKey(right.command.parts)),
    );

  const subsumption = normalizedSubsumptionContracts(subsumptionContracts);
  const commandsOut: StagedProofPlanCommand[] = [];
  for (const entry of ordered) {
    const previous = commandsOut.at(-1) ?? null;
    const subsumedBy = canApplySubsumption(entry.command, entry.classification.stage, risk)
      ? (commandsOut.find((candidate) =>
          subsumption.get(commandKey(candidate.parts))?.has(commandKey(entry.command.parts)),
        ) ?? null)
      : null;
    commandsOut.push({
      id: `proof-${commandsOut.length + 1}-${entry.digest.slice(0, 12)}`,
      command_digest: entry.digest,
      command_kind: commandKind(entry.command.parts),
      parts: [...entry.command.parts],
      stage: entry.classification.stage,
      source: entry.command.source,
      required: entry.command.required,
      reason: entry.classification.reason,
      prerequisite: previous?.id ?? null,
      subsumed_by: subsumedBy?.id ?? null,
      original_index: entry.command.originalIndex,
    });
  }

  const planIdentity = commandsOut.map((command) => ({
    digest: command.command_digest,
    stage: command.stage,
    source: command.source,
    prerequisite: command.prerequisite,
    subsumed_by: command.subsumed_by,
  }));
  return {
    schema_version: STAGED_PROOF_SCHEMA_VERSION,
    plan_id: createHash("sha256")
      .update(JSON.stringify({ risk, commands: planIdentity }))
      .digest("hex"),
    risk,
    commands: commandsOut,
    deduplicated_commands: deduplicatedCommands,
  };
}

export function executeStagedProofPlan(
  plan: StagedProofPlan,
  {
    runCommand,
    commandTimeoutMs,
    budgetMs,
    nowMs = Date.now,
  }: {
    runCommand: (command: StagedProofPlanCommand, timeoutMs: number) => StagedProofRunResult;
    commandTimeoutMs: number;
    budgetMs: number;
    nowMs?: () => number;
  },
): StagedProofExecutionResult {
  const startedAt = nowMs();
  const entries: StagedProofTraceEntry[] = [];
  const statusById = new Map<string, StagedProofTraceStatus>();
  const executedCommands: string[] = [];

  for (const [index, command] of plan.commands.entries()) {
    if (command.subsumed_by && statusById.get(command.subsumed_by) === "passed") {
      entries.push({
        stage: command.stage,
        command_digest: command.command_digest,
        command_kind: command.command_kind,
        status: "skipped_subsumed",
        duration_ms: 0,
        reason: `explicit toolchain contract: ${command.subsumed_by} subsumes this command`,
        prerequisite: command.subsumed_by,
      });
      statusById.set(command.id, "skipped_subsumed");
      continue;
    }

    const elapsed = Math.max(0, nowMs() - startedAt);
    const remainingBudget = Math.max(0, budgetMs - elapsed);
    if (remainingBudget <= 0) {
      const error = new Error(
        `validation command failed (${command.command_kind}): staged proof runtime budget exhausted before ${command.id}`,
      );
      return failProofPlan({
        plan,
        command,
        index,
        entries,
        statusById,
        executedCommands,
        startedAt,
        nowMs,
        error,
        durationMs: 0,
        reason: "runtime_budget_exhausted",
      });
    }

    const commandStartedAt = nowMs();
    try {
      const result = runCommand(command, Math.max(1, Math.min(commandTimeoutMs, remainingBudget)));
      executedCommands.push(...result.executedCommands);
      const durationMs = Math.max(0, nowMs() - commandStartedAt);
      entries.push({
        stage: command.stage,
        command_digest: command.command_digest,
        command_kind: command.command_kind,
        status: "passed",
        duration_ms: durationMs,
        reason: result.reason || "passed",
        prerequisite: command.prerequisite,
      });
      statusById.set(command.id, "passed");
    } catch (error) {
      const durationMs = Math.max(0, nowMs() - commandStartedAt);
      return failProofPlan({
        plan,
        command,
        index,
        entries,
        statusById,
        executedCommands,
        startedAt,
        nowMs,
        error,
        durationMs,
        reason: /timed out/i.test(String((error as Error)?.message ?? error))
          ? "command_timeout"
          : "command_failed",
      });
    }
  }

  return {
    commands: executedCommands,
    trace: buildTrace(plan, "passed", entries, Math.max(0, nowMs() - startedAt)),
  };
}

export function stagedProofTraceFromError(error: unknown): StagedProofTrace | null {
  return error instanceof StagedProofExecutionError ? error.trace : null;
}

export function stagedProofPlanArtifact(plan: StagedProofPlan) {
  return {
    schema_version: plan.schema_version,
    plan_id: plan.plan_id,
    risk: plan.risk,
    deduplicated_commands: plan.deduplicated_commands,
    commands: plan.commands.map((command) => ({
      stage: command.stage,
      command_digest: command.command_digest,
      command_kind: command.command_kind,
      source: command.source,
      required: command.required,
      reason: command.reason,
      prerequisite: command.prerequisite,
      subsumed_by: command.subsumed_by,
    })),
  };
}

export function stagedProofBundle(traces: readonly StagedProofTrace[]) {
  const bounded = traces.slice(-8);
  const latest = bounded.at(-1) ?? null;
  return {
    schema_version: STAGED_PROOF_SCHEMA_VERSION,
    status: latest?.status ?? "failed",
    runs: bounded,
    summary: {
      runs: bounded.length,
      failed_runs: bounded.filter((trace) => trace.status === "failed").length,
      passed: bounded.reduce((sum, trace) => sum + trace.summary.passed, 0),
      failed: bounded.reduce((sum, trace) => sum + trace.summary.failed, 0),
      skipped: bounded.reduce((sum, trace) => sum + trace.summary.skipped, 0),
      total_duration_ms: bounded.reduce((sum, trace) => sum + trace.summary.total_duration_ms, 0),
    },
  };
}

export function isPassedStagedProofBundle(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  if (
    bundle.schema_version !== STAGED_PROOF_SCHEMA_VERSION ||
    bundle.status !== "passed" ||
    !Array.isArray(bundle.runs) ||
    bundle.runs.length === 0 ||
    bundle.runs.length > 8 ||
    !bundle.runs.every(isStagedProofTrace)
  ) {
    return false;
  }
  if (!bundle.summary || typeof bundle.summary !== "object" || Array.isArray(bundle.summary)) {
    return false;
  }
  const latest = bundle.runs.at(-1);
  return (
    Boolean(latest) &&
    typeof latest === "object" &&
    !Array.isArray(latest) &&
    (latest as Record<string, unknown>).status === "passed"
  );
}

export function stagedProofSummary(value: {
  risk?: StagedProofRisk;
  commands?: readonly { stage: StagedProofStage }[];
  summary?: { passed?: number; failed?: number; skipped?: number; total_duration_ms?: number };
}) {
  if (value.summary) {
    return [
      `${value.summary.passed ?? 0} passed`,
      `${value.summary.failed ?? 0} failed`,
      `${value.summary.skipped ?? 0} skipped`,
      `${value.summary.total_duration_ms ?? 0}ms`,
    ].join(", ");
  }
  const commands = value.commands ?? [];
  const stages = [...new Set(commands.map((command) => command.stage))];
  return `${commands.length} command(s) across ${stages.length} stage(s), risk=${value.risk?.level ?? "unknown"}`;
}

function failProofPlan({
  plan,
  command,
  index,
  entries,
  statusById,
  executedCommands,
  startedAt,
  nowMs,
  error,
  durationMs,
  reason,
}: {
  plan: StagedProofPlan;
  command: StagedProofPlanCommand;
  index: number;
  entries: StagedProofTraceEntry[];
  statusById: Map<string, StagedProofTraceStatus>;
  executedCommands: string[];
  startedAt: number;
  nowMs: () => number;
  error: unknown;
  durationMs: number;
  reason: string;
}): never {
  entries.push({
    stage: command.stage,
    command_digest: command.command_digest,
    command_kind: command.command_kind,
    status: "failed",
    duration_ms: durationMs,
    reason,
    prerequisite: command.prerequisite,
  });
  statusById.set(command.id, "failed");
  for (const later of plan.commands.slice(index + 1)) {
    entries.push({
      stage: later.stage,
      command_digest: later.command_digest,
      command_kind: later.command_kind,
      status: "skipped_prerequisite",
      duration_ms: 0,
      reason: `prerequisite ${command.id} failed`,
      prerequisite: command.id,
    });
    statusById.set(later.id, "skipped_prerequisite");
  }
  const trace = buildTrace(plan, "failed", entries, Math.max(0, nowMs() - startedAt));
  const detail = String((error as Error)?.message ?? error);
  throw new StagedProofExecutionError(detail, trace, executedCommands, error);
}

function buildTrace(
  plan: StagedProofPlan,
  status: "passed" | "failed",
  commands: StagedProofTraceEntry[],
  totalDurationMs: number,
): StagedProofTrace {
  return {
    schema_version: STAGED_PROOF_SCHEMA_VERSION,
    plan_id: plan.plan_id,
    status,
    risk: plan.risk,
    commands,
    summary: {
      passed: commands.filter((command) => command.status === "passed").length,
      failed: commands.filter((command) => command.status === "failed").length,
      skipped: commands.filter((command) => command.status.startsWith("skipped_")).length,
      total_duration_ms: totalDurationMs,
    },
  };
}

function isStagedProofTrace(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trace = value as Record<string, unknown>;
  if (
    trace.schema_version !== STAGED_PROOF_SCHEMA_VERSION ||
    !/^[a-f0-9]{64}$/.test(String(trace.plan_id ?? "")) ||
    !["passed", "failed"].includes(String(trace.status ?? "")) ||
    !Array.isArray(trace.commands) ||
    trace.commands.length === 0 ||
    trace.commands.length > MAX_STAGED_PROOF_COMMANDS
  ) {
    return false;
  }
  const statuses: string[] = [];
  const commandsValid = trace.commands.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const command = entry as Record<string, unknown>;
    statuses.push(String(command.status ?? ""));
    return (
      typeof command.stage === "string" &&
      /^[a-f0-9]{64}$/.test(String(command.command_digest ?? "")) &&
      typeof command.command_kind === "string" &&
      ["passed", "failed", "skipped_prerequisite", "skipped_subsumed"].includes(
        String(command.status ?? ""),
      ) &&
      Number.isFinite(Number(command.duration_ms))
    );
  });
  if (!commandsValid) return false;
  return trace.status === "passed"
    ? statuses.includes("passed") && !statuses.includes("failed")
    : statuses.includes("failed");
}

export function stagedProofRiskForPaths(paths: readonly string[]): StagedProofRisk {
  const normalized = [
    ...new Set(
      paths
        .map((entry) =>
          String(entry ?? "")
            .trim()
            .replaceAll("\\", "/"),
        )
        .filter((entry) => entry && !entry.startsWith("/") && !entry.split("/").includes("..")),
    ),
  ];
  const signals = new Set<string>();
  for (const file of normalized) {
    const lower = file.toLowerCase();
    const basename = lower.split("/").at(-1) ?? lower;
    if (
      /(?:^|\/)(?:migrations?|schema|schemas)(?:\/|$)/.test(lower) ||
      /\.(?:sql|prisma)$/.test(lower)
    ) {
      signals.add("migration_or_schema");
    }
    if (
      /(?:^|\/)(?:security|auth|authentication|authorization|crypto)(?:\/|[-_.])/.test(lower) ||
      basename === "security.md"
    ) {
      signals.add("security");
    }
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(lower)) signals.add("workflow");
    if (isDependencyOrToolchainPath(basename)) signals.add("dependency_or_toolchain");
  }
  if (normalized.length > 24) signals.add("broad_changed_surface");
  return {
    level: signals.size > 0 ? "elevated" : "narrow",
    signals: [...signals].sort(),
    changed_file_count: normalized.length,
  };
}

function classifyStagedProofCommand(
  command: StagedProofCommandInput,
  risk: StagedProofRisk,
): { stage: StagedProofStage; reason: string } {
  const parts = stripEnvPrefix(command.parts);
  const executable = parts[0] ?? "";
  if (command.canonical) {
    return {
      stage: "canonical_changed_surface",
      reason: "repository profile declares this canonical changed-surface gate",
    };
  }
  if (
    executable === "git" &&
    ((parts[1] === "diff" && parts.includes("--check")) ||
      ["fsck", "status"].includes(parts[1] ?? ""))
  ) {
    return {
      stage: "repository_integrity",
      reason: "structured git integrity check",
    };
  }
  if (isFocusedStagedProofCommand(parts)) {
    return {
      stage: "focused_tests",
      reason:
        risk.level === "narrow"
          ? "path-scoped test runs before broader gates for a narrow changed surface"
          : "path-scoped test retained after static checks for an elevated-risk surface",
    };
  }
  if (isStaticCommand(parts)) {
    return {
      stage: "static",
      reason: "structured lint, type, build, format, or static-analysis command",
    };
  }
  return {
    stage: "broad_live_or_e2e",
    reason: isBroadOrLiveCommand(parts)
      ? "structured broad, integration, live, docker, or e2e command"
      : "unclassified allowlisted command retained as a late conservative proof gate",
  };
}

function stageRank(stage: StagedProofStage, risk: StagedProofRisk): number {
  const narrow: StagedProofStage[] = [
    "repository_integrity",
    "focused_tests",
    "static",
    "canonical_changed_surface",
    "broad_live_or_e2e",
  ];
  const elevated: StagedProofStage[] = [
    "repository_integrity",
    "static",
    "focused_tests",
    "canonical_changed_surface",
    "broad_live_or_e2e",
  ];
  return (risk.level === "narrow" ? narrow : elevated).indexOf(stage);
}

function canApplySubsumption(
  command: StagedProofCommandInput,
  stage: StagedProofStage,
  risk: StagedProofRisk,
) {
  if (risk.level === "elevated" || command.canonical) return false;
  if (stage === "repository_integrity") return false;
  return !isLiveProofCommand(stripEnvPrefix(command.parts));
}

export function isFocusedStagedProofCommand(parts: readonly string[]): boolean {
  const executable = parts[0];
  if (executable === "node" && parts[1] === "--test") {
    return parts.slice(2).some(looksLikePathArgument);
  }
  if (executable === "pytest") return parts.slice(1).some(looksLikePathArgument);
  if (executable === "python" || executable === "python3") {
    return parts[1] === "-m" && parts[2] === "pytest" && parts.slice(3).some(looksLikePathArgument);
  }
  if (executable === "go" && parts[1] === "test") {
    const targets = parts.slice(2).filter((part) => !part.startsWith("-"));
    return targets.length > 0 && !targets.includes("./...");
  }
  if (executable === "cargo" && parts[1] === "test") {
    return parts.slice(2).some((part) => !part.startsWith("-") && part !== "--");
  }

  const script = packageScriptRequirement(parts)?.name ?? "";
  if (/^(?:test(?::serial)?|vitest)$/.test(script)) {
    return packageCommandArgs(parts).some(looksLikePathArgument);
  }
  const vitestStart = directVitestArgsStart(parts);
  return vitestStart >= 0 && vitestPathFilterIndexes(parts.slice(vitestStart)).length > 0;
}

function isStaticCommand(parts: readonly string[]): boolean {
  const executable = parts[0] ?? "";
  if (
    ["ruff", "mypy", "rustc", "swiftc", "ansible-lint"].includes(executable) ||
    (executable === "go" && ["vet", "fmt"].includes(parts[1] ?? "")) ||
    (executable === "cargo" && ["check", "clippy", "fmt", "build"].includes(parts[1] ?? ""))
  ) {
    return true;
  }
  const script = packageScriptRequirement(parts)?.name ?? "";
  return /^(?:lint|format(?::check)?|typecheck|check:types|check:test-types|build)(?::|$)/.test(
    script,
  );
}

function isBroadOrLiveCommand(parts: readonly string[]): boolean {
  const script = packageScriptRequirement(parts)?.name ?? "";
  if (
    /^(?:test(?::(?:all|e2e|live|docker|integration|install:e2e|parallels))?|qa(?::e2e)?|check)$/.test(
      script,
    )
  ) {
    return true;
  }
  if (parts[0] === "pytest" && !isFocusedStagedProofCommand(parts)) return true;
  if (parts[0] === "go" && parts[1] === "test" && parts.includes("./...")) return true;
  if (parts[0] === "cargo" && parts[1] === "test" && !isFocusedStagedProofCommand(parts)) {
    return true;
  }
  return directVitestArgsStart(parts) >= 0 && !isFocusedStagedProofCommand(parts);
}

function isLiveProofCommand(parts: readonly string[]): boolean {
  const script = packageScriptRequirement(parts)?.name ?? "";
  return /(?:^|:)(?:e2e|live|docker|integration|install:e2e|parallels)(?::|$)/.test(script);
}

function packageCommandArgs(parts: readonly string[]): string[] {
  const executable = parts[0];
  if (!["pnpm", "npm", "bun"].includes(executable ?? "")) return [];
  let index = 1;
  if (executable === "pnpm" && ["-s", "--silent"].includes(parts[index] ?? "")) index += 1;
  if (parts[index] === "run") index += 1;
  return parts.slice(index + 1);
}

function directVitestArgsStart(parts: readonly string[]): number {
  if (parts[0] === "pnpm" && parts[1] === "exec" && parts[2] === "vitest" && parts[3] === "run") {
    return 4;
  }
  if (parts[0] === "bun" && parts[1] === "run" && parts[2] === "vitest") return 3;
  return -1;
}

function commandKind(parts: readonly string[]): string {
  const commandParts = stripEnvPrefix(parts);
  const script = packageScriptRequirement(commandParts);
  if (script) return `${commandParts[0]}:${script.name}`.slice(0, 96);
  if (commandParts[0] === "git" && commandParts[1] === "diff" && commandParts.includes("--check")) {
    return "git:diff-check";
  }
  if (directVitestArgsStart(commandParts) >= 0) return `${commandParts[0]}:vitest`;
  return String(commandParts.slice(0, 2).join(":") || "unknown").slice(0, 96);
}

function commandDigest(parts: readonly string[]): string {
  return createHash("sha256").update(commandKey(parts)).digest("hex");
}

function commandKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function validateCommandShape(parts: readonly string[]) {
  if (parts.length === 0) throw new Error("staged proof command cannot be empty");
  if (parts.length > 96) throw new Error("staged proof command exceeds 96 arguments");
  const encoded = commandKey(parts);
  if (encoded.length > 16_384) throw new Error("staged proof command exceeds 16384 characters");
}

function normalizedSubsumptionContracts(
  contracts: readonly StagedProofSubsumptionContract[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const contract of contracts) {
    validateCommandShape(contract.command);
    const subsumed = out.get(commandKey(contract.command)) ?? new Set<string>();
    for (const command of contract.subsumes) {
      validateCommandShape(command);
      subsumed.add(commandKey(command));
    }
    out.set(commandKey(contract.command), subsumed);
  }
  return out;
}

function strongerSource(
  left: StagedProofCommandSource,
  right: StagedProofCommandSource,
): StagedProofCommandSource {
  const order: StagedProofCommandSource[] = [
    "artifact",
    "configured",
    "repository_profile",
    "changed_gate",
  ];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function isDependencyOrToolchainPath(basename: string) {
  return /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|composer\.(?:json|lock)|requirements(?:-[^.]+)?\.txt|\.nvmrc|\.node-version|\.tool-versions|mise\.toml)$/i.test(
    basename,
  );
}
