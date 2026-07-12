import { createHash } from "node:crypto";

import {
  isExpensivePnpmValidation,
  looksLikePathArgument,
  packageManagerInvocation,
  packageScriptArguments,
  packageScriptRequirement,
  stripEnvPrefix,
  vitestPathFilterIndexes,
} from "./validation-command-utils.js";

export const STAGED_PROOF_SCHEMA_VERSION = 2;
export const MAX_STAGED_PROOF_COMMANDS = 32;

export type StagedProofStage =
  | "repository_integrity"
  | "static"
  | "focused_tests"
  | "canonical_changed_surface"
  | "broad_live_or_e2e";

const STAGED_PROOF_STAGES = new Set<string>([
  "repository_integrity",
  "static",
  "focused_tests",
  "canonical_changed_surface",
  "broad_live_or_e2e",
]);

const STAGED_PROOF_TRACE_STATUSES = new Set<string>([
  "passed",
  "failed",
  "skipped_prerequisite",
  "skipped_subsumed",
]);

const STAGED_PROOF_COMMAND_SOURCES = new Set<string>([
  "artifact",
  "configured",
  "repository_profile",
  "changed_gate",
]);

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
  displayParts?: readonly string[];
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
  display_parts: string[];
  stage: StagedProofStage;
  source: StagedProofCommandSource;
  required: boolean;
  reason: string;
  prerequisite: string | null;
  subsumed_by: string | null;
  subsumption_contract_digest: string | null;
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
  command_id: string;
  stage: StagedProofStage;
  command_digest: string;
  command_kind: string;
  source: StagedProofCommandSource;
  status: StagedProofTraceStatus;
  duration_ms: number;
  reason: string;
  prerequisite: string | null;
  subsumed_by: string | null;
  subsumption_contract_digest: string | null;
};

export type StagedProofTrace = {
  schema_version: typeof STAGED_PROOF_SCHEMA_VERSION;
  plan_id: string;
  validated_head_sha: string;
  validated_base_sha: string;
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
        displayParts: [...(command.displayParts ?? command.parts)],
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
    const subsumptionContractDigest = subsumedBy
      ? subsumptionDigest(subsumedBy.command_digest, entry.digest)
      : null;
    commandsOut.push({
      id: `proof-${commandsOut.length + 1}-${entry.digest.slice(0, 12)}`,
      command_digest: entry.digest,
      command_kind: commandKind(entry.command.parts),
      parts: [...entry.command.parts],
      display_parts: [...(entry.command.displayParts ?? entry.command.parts)],
      stage: entry.classification.stage,
      source: entry.command.source,
      required: entry.command.required,
      reason: entry.classification.reason,
      prerequisite: previous?.id ?? null,
      subsumed_by: subsumedBy?.id ?? null,
      subsumption_contract_digest: subsumptionContractDigest,
      original_index: entry.command.originalIndex,
    });
  }

  const planIdentity = commandsOut.map((command) => ({
    digest: command.command_digest,
    stage: command.stage,
    source: command.source,
    prerequisite: command.prerequisite,
    subsumed_by: command.subsumed_by,
    subsumption_contract_digest: command.subsumption_contract_digest,
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
    validatedHeadSha,
    validatedBaseSha,
    nowMs = Date.now,
  }: {
    runCommand: (command: StagedProofPlanCommand, timeoutMs: number) => StagedProofRunResult;
    commandTimeoutMs: number;
    budgetMs: number;
    validatedHeadSha: string;
    validatedBaseSha: string;
    nowMs?: () => number;
  },
): StagedProofExecutionResult {
  validateProofCommitIdentity("validated head", validatedHeadSha);
  validateProofCommitIdentity("validated base", validatedBaseSha);
  const startedAt = nowMs();
  const entries: StagedProofTraceEntry[] = [];
  const statusById = new Map<string, StagedProofTraceStatus>();
  const executedCommands: string[] = [];

  for (const [index, command] of plan.commands.entries()) {
    if (command.subsumed_by && statusById.get(command.subsumed_by) === "passed") {
      entries.push({
        command_id: command.id,
        stage: command.stage,
        command_digest: command.command_digest,
        command_kind: command.command_kind,
        source: command.source,
        status: "skipped_subsumed",
        duration_ms: 0,
        reason: `explicit toolchain contract: ${command.subsumed_by} subsumes this command`,
        prerequisite: command.prerequisite,
        subsumed_by: command.subsumed_by,
        subsumption_contract_digest: command.subsumption_contract_digest,
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
        validatedHeadSha,
        validatedBaseSha,
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
      const commandCompletedAt = nowMs();
      const durationMs = Math.max(0, commandCompletedAt - commandStartedAt);
      const totalElapsed = Math.max(0, commandCompletedAt - startedAt);
      if (totalElapsed > budgetMs) {
        const error = new Error(
          `validation command failed (${command.command_kind}): staged proof runtime budget exhausted after ${command.id}`,
        );
        return failProofPlan({
          plan,
          validatedHeadSha,
          validatedBaseSha,
          command,
          index,
          entries,
          statusById,
          executedCommands,
          startedAt,
          nowMs,
          error,
          durationMs,
          reason: "runtime_budget_exhausted_after_command",
        });
      }
      entries.push({
        command_id: command.id,
        stage: command.stage,
        command_digest: command.command_digest,
        command_kind: command.command_kind,
        source: command.source,
        status: "passed",
        duration_ms: durationMs,
        reason: result.reason || "passed",
        prerequisite: command.prerequisite,
        subsumed_by: command.subsumed_by,
        subsumption_contract_digest: command.subsumption_contract_digest,
      });
      statusById.set(command.id, "passed");
    } catch (error) {
      if (error instanceof StagedProofExecutionError) throw error;
      const durationMs = Math.max(0, nowMs() - commandStartedAt);
      return failProofPlan({
        plan,
        validatedHeadSha,
        validatedBaseSha,
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
    trace: buildTrace(
      plan,
      validatedHeadSha,
      validatedBaseSha,
      "passed",
      entries,
      Math.max(0, nowMs() - startedAt),
    ),
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
      command_id: command.id,
      stage: command.stage,
      command_digest: command.command_digest,
      command_kind: command.command_kind,
      source: command.source,
      required: command.required,
      reason: command.reason,
      prerequisite: command.prerequisite,
      subsumed_by: command.subsumed_by,
      subsumption_contract_digest: command.subsumption_contract_digest,
    })),
  };
}

export function stagedProofBundle(traces: readonly StagedProofTrace[]) {
  const bounded = traces.slice(-8);
  const latest = bounded.at(-1) ?? null;
  return {
    schema_version: STAGED_PROOF_SCHEMA_VERSION,
    status: latest?.status ?? "failed",
    validated_head_sha: latest?.validated_head_sha ?? null,
    validated_base_sha: latest?.validated_base_sha ?? null,
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
    !isProofCommitIdentity(bundle.validated_head_sha) ||
    !isProofCommitIdentity(bundle.validated_base_sha) ||
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
  const runs = bundle.runs as StagedProofTrace[];
  const latest = runs.at(-1);
  if (!latest || latest.status !== "passed") return false;
  if (
    bundle.validated_head_sha !== latest.validated_head_sha ||
    bundle.validated_base_sha !== latest.validated_base_sha
  ) {
    return false;
  }
  const summary = bundle.summary as Record<string, unknown>;
  return (
    summary.runs === runs.length &&
    summary.failed_runs === runs.filter((run) => run.status === "failed").length &&
    summary.passed === runs.reduce((sum, run) => sum + run.summary.passed, 0) &&
    summary.failed === runs.reduce((sum, run) => sum + run.summary.failed, 0) &&
    summary.skipped === runs.reduce((sum, run) => sum + run.summary.skipped, 0) &&
    summary.total_duration_ms === runs.reduce((sum, run) => sum + run.summary.total_duration_ms, 0)
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
  validatedHeadSha,
  validatedBaseSha,
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
  validatedHeadSha: string;
  validatedBaseSha: string;
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
    command_id: command.id,
    stage: command.stage,
    command_digest: command.command_digest,
    command_kind: command.command_kind,
    source: command.source,
    status: "failed",
    duration_ms: durationMs,
    reason,
    prerequisite: command.prerequisite,
    subsumed_by: command.subsumed_by,
    subsumption_contract_digest: command.subsumption_contract_digest,
  });
  statusById.set(command.id, "failed");
  for (const later of plan.commands.slice(index + 1)) {
    entries.push({
      command_id: later.id,
      stage: later.stage,
      command_digest: later.command_digest,
      command_kind: later.command_kind,
      source: later.source,
      status: "skipped_prerequisite",
      duration_ms: 0,
      reason: `prerequisite ${later.prerequisite ?? command.id} did not pass after ${command.id} failed`,
      prerequisite: later.prerequisite,
      subsumed_by: later.subsumed_by,
      subsumption_contract_digest: later.subsumption_contract_digest,
    });
    statusById.set(later.id, "skipped_prerequisite");
  }
  const trace = buildTrace(
    plan,
    validatedHeadSha,
    validatedBaseSha,
    "failed",
    entries,
    Math.max(0, nowMs() - startedAt),
  );
  const detail = String((error as Error)?.message ?? error);
  throw new StagedProofExecutionError(detail, trace, executedCommands, error);
}

function buildTrace(
  plan: StagedProofPlan,
  validatedHeadSha: string,
  validatedBaseSha: string,
  status: "passed" | "failed",
  commands: StagedProofTraceEntry[],
  totalDurationMs: number,
): StagedProofTrace {
  return {
    schema_version: STAGED_PROOF_SCHEMA_VERSION,
    plan_id: plan.plan_id,
    validated_head_sha: validatedHeadSha,
    validated_base_sha: validatedBaseSha,
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
    !isProofCommitIdentity(trace.validated_head_sha) ||
    !isProofCommitIdentity(trace.validated_base_sha) ||
    !["passed", "failed"].includes(String(trace.status ?? "")) ||
    !Array.isArray(trace.commands) ||
    trace.commands.length === 0 ||
    trace.commands.length > MAX_STAGED_PROOF_COMMANDS ||
    !isStagedProofRisk(trace.risk)
  ) {
    return false;
  }
  const statuses: string[] = [];
  const commandIds = new Map<string, { index: number; status: string }>();
  const traceCommands = trace.commands as Record<string, unknown>[];
  let commandDurationMs = 0;
  const commandsValid = traceCommands.every((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const command = entry as Record<string, unknown>;
    const commandId = String(command.command_id ?? "");
    const commandDigest = String(command.command_digest ?? "");
    const status = String(command.status ?? "");
    const commandIdMatch = commandId.match(/^proof-(\d+)-([a-f0-9]{12})$/);
    if (
      !commandIdMatch ||
      Number(commandIdMatch[1]) !== index + 1 ||
      commandIdMatch[2] !== commandDigest.slice(0, 12) ||
      commandIds.has(commandId)
    ) {
      return false;
    }
    commandIds.set(commandId, { index, status });
    statuses.push(status);
    commandDurationMs += Number(command.duration_ms);
    return (
      STAGED_PROOF_STAGES.has(String(command.stage ?? "")) &&
      /^[a-f0-9]{64}$/.test(commandDigest) &&
      typeof command.command_kind === "string" &&
      command.command_kind.length > 0 &&
      command.command_kind.length <= 96 &&
      STAGED_PROOF_COMMAND_SOURCES.has(String(command.source ?? "")) &&
      STAGED_PROOF_TRACE_STATUSES.has(status) &&
      isNonNegativeInteger(command.duration_ms) &&
      typeof command.reason === "string" &&
      command.reason.length > 0 &&
      command.reason.length <= 256 &&
      isProofCommandReference(command.prerequisite) &&
      isProofCommandReference(command.subsumed_by) &&
      (command.subsumption_contract_digest === null ||
        /^[a-f0-9]{64}$/.test(String(command.subsumption_contract_digest ?? "")))
    );
  });
  if (!commandsValid) return false;
  const expectedPlanId = createHash("sha256")
    .update(
      JSON.stringify({
        risk: trace.risk,
        commands: traceCommands.map((command) => ({
          digest: command.command_digest,
          stage: command.stage,
          source: command.source,
          prerequisite: command.prerequisite,
          subsumed_by: command.subsumed_by,
          subsumption_contract_digest: command.subsumption_contract_digest,
        })),
      }),
    )
    .digest("hex");
  if (trace.plan_id !== expectedPlanId) return false;
  for (const [index, command] of traceCommands.entries()) {
    const commandId = String(command.command_id);
    const prerequisite = command.prerequisite;
    const subsumedBy = command.subsumed_by;
    const contractDigest = command.subsumption_contract_digest;
    if (!isEarlierProofCommandReference(prerequisite, index, commandIds)) return false;
    if (!isEarlierProofCommandReference(subsumedBy, index, commandIds)) return false;
    const subsumingCommand =
      typeof subsumedBy === "string"
        ? traceCommands[commandIds.get(subsumedBy)?.index ?? -1]
        : undefined;
    if (
      (subsumedBy === null && contractDigest !== null) ||
      (typeof subsumedBy === "string" &&
        (typeof contractDigest !== "string" ||
          !subsumingCommand ||
          contractDigest !==
            subsumptionDigest(
              String(subsumingCommand.command_digest),
              String(command.command_digest),
            )))
    ) {
      return false;
    }
    if (
      command.status === "skipped_subsumed" &&
      (typeof subsumedBy !== "string" || commandIds.get(subsumedBy)?.status !== "passed")
    ) {
      return false;
    }
    if (
      command.status === "skipped_prerequisite" &&
      (typeof prerequisite !== "string" ||
        !["failed", "skipped_prerequisite"].includes(
          String(commandIds.get(prerequisite)?.status ?? ""),
        ))
    ) {
      return false;
    }
    if (
      trace.status === "passed" &&
      prerequisite !== (index === 0 ? null : String(traceCommands[index - 1]?.command_id))
    ) {
      return false;
    }
    if (commandIds.get(commandId)?.index !== index) return false;
  }
  const summary = trace.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const summaryRecord = summary as Record<string, unknown>;
  const passed = statuses.filter((status) => status === "passed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const skipped = statuses.filter((status) => status.startsWith("skipped_")).length;
  if (
    summaryRecord.passed !== passed ||
    summaryRecord.failed !== failed ||
    summaryRecord.skipped !== skipped ||
    !isNonNegativeInteger(summaryRecord.total_duration_ms) ||
    Number(summaryRecord.total_duration_ms) < commandDurationMs
  ) {
    return false;
  }
  if (trace.status === "passed") {
    return (
      passed > 0 && statuses.every((status) => status === "passed" || status === "skipped_subsumed")
    );
  }
  const failedIndex = statuses.indexOf("failed");
  return (
    failed === 1 &&
    failedIndex >= 0 &&
    statuses.slice(0, failedIndex).every((status) => status !== "skipped_prerequisite") &&
    statuses.slice(failedIndex + 1).every((status) => status === "skipped_prerequisite")
  );
}

function isStagedProofRisk(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const risk = value as Record<string, unknown>;
  if (
    !["narrow", "elevated"].includes(String(risk.level ?? "")) ||
    !Array.isArray(risk.signals) ||
    !risk.signals.every((signal) => typeof signal === "string" && signal.length > 0) ||
    new Set(risk.signals).size !== risk.signals.length ||
    !isNonNegativeInteger(risk.changed_file_count)
  ) {
    return false;
  }
  return risk.level === "narrow" ? risk.signals.length === 0 : risk.signals.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isProofCommitIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function validateProofCommitIdentity(label: string, value: string) {
  if (!isProofCommitIdentity(value)) {
    throw new Error(`staged proof ${label} must be a full lowercase commit SHA`);
  }
}

function isProofCommandReference(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^proof-\d+-[a-f0-9]{12}$/.test(value));
}

function isEarlierProofCommandReference(
  value: unknown,
  index: number,
  commandIds: ReadonlyMap<string, { index: number }>,
): boolean {
  return (
    value === null || (typeof value === "string" && (commandIds.get(value)?.index ?? index) < index)
  );
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
    reason: isBroadOrLiveStagedProofCommand(parts)
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
    return packageScriptArguments(parts).some(looksLikePathArgument);
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

export function isBroadOrLiveStagedProofCommand(parts: readonly string[]): boolean {
  const packageInvocation = packageManagerInvocation(parts);
  if (packageInvocation?.executable === "pnpm") {
    if (isExpensivePnpmValidation(parts, packageInvocation.commandIndex, false)) return true;
  }
  const script = packageScriptRequirement(parts)?.name ?? "";
  if (
    /^(?:test(?::(?:all|serial|e2e|live|docker|integration|install:e2e|parallels))?|qa(?::e2e)?|check|android:test:integration)$/.test(
      script,
    )
  ) {
    return true;
  }
  if (parts[0] === "node" && parts[1] === "--test") {
    return !isFocusedStagedProofCommand(parts);
  }
  if (parts[0] === "pytest" && !isFocusedStagedProofCommand(parts)) return true;
  if (
    ["python", "python3"].includes(parts[0] ?? "") &&
    parts[1] === "-m" &&
    parts[2] === "pytest"
  ) {
    return !isFocusedStagedProofCommand(parts);
  }
  if (parts[0] === "go" && parts[1] === "test" && parts.includes("./...")) return true;
  if (parts[0] === "cargo" && parts[1] === "test" && !isFocusedStagedProofCommand(parts)) {
    return true;
  }
  if (directPlaywrightArgsStart(parts) >= 0) return true;
  return directVitestArgsStart(parts) >= 0 && !isFocusedStagedProofCommand(parts);
}

function isLiveProofCommand(parts: readonly string[]): boolean {
  const script = packageScriptRequirement(parts)?.name ?? "";
  if (script === "qa" || script === "qa:e2e") return true;
  if (script === "openclaw" && packageScriptArguments(parts)[0] === "qa") return true;
  return (
    directPlaywrightArgsStart(parts) >= 0 ||
    /(?:^|:)(?:e2e|live|docker|integration|install:e2e|parallels)(?::|$)/.test(script)
  );
}

function directVitestArgsStart(parts: readonly string[]): number {
  const invocation = packageManagerInvocation(parts);
  if (
    invocation?.executable === "pnpm" &&
    invocation.command === "exec" &&
    invocation.args[0] === "vitest" &&
    invocation.args[1] === "run"
  ) {
    return invocation.commandIndex + 3;
  }
  if (
    invocation?.executable === "bun" &&
    invocation.command === "run" &&
    invocation.args[0] === "vitest"
  ) {
    return invocation.commandIndex + 2;
  }
  return -1;
}

function directPlaywrightArgsStart(parts: readonly string[]): number {
  const invocation = packageManagerInvocation(parts);
  if (
    invocation?.executable === "pnpm" &&
    invocation.command === "exec" &&
    invocation.args[0] === "playwright" &&
    invocation.args[1] === "test"
  ) {
    return invocation.commandIndex + 3;
  }
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

function subsumptionDigest(subsumingCommandDigest: string, subsumedCommandDigest: string): string {
  return createHash("sha256")
    .update(JSON.stringify([subsumingCommandDigest, subsumedCommandDigest]))
    .digest("hex");
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
