import fs from "node:fs";
import path from "node:path";

import type { LooseRecord } from "./json-types.js";

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_ARTIFACT_ENTRIES = 256;
const MAX_ARTIFACT_DEPTH = 4;
const REPAIR_MODES = new Set(["plan", "execute", "autonomous"]);
const PLANNER_SANDBOXES = new Set(["read-only", "danger-full-access"]);
const CURRENT_INPUT_KEYS = [
  "dry_run",
  "effective_mode",
  "execution_runner",
  "model",
  "planner_sandbox",
  "requested_mode",
  "requeue",
  "requeue_depth",
  "runner",
  "schema_version",
  "source_dispatch_key",
  "source_job",
].sort();
const LEGACY_INPUT_KEYS = [
  "effective_mode",
  "job_sha256",
  "requested_mode",
  "schema_version",
  "source_job",
  "state_revision",
].sort();

export const REPAIR_WORKFLOW_INPUTS_BASENAME = "workflow-inputs.json";

export type RepairWorkflowMode = "plan" | "execute" | "autonomous";

type CurrentRepairWorkflowRecoveryInputs = {
  schema_version: 1;
  source_job: string;
  source_dispatch_key: string;
  requested_mode: RepairWorkflowMode;
  effective_mode: RepairWorkflowMode;
  runner: string;
  execution_runner: string;
  planner_sandbox: "read-only" | "danger-full-access";
  model: string;
  dry_run: boolean;
  requeue: boolean;
  requeue_depth: number;
  state_revision?: never;
  job_sha256?: never;
};

type LegacyRepairWorkflowRecoveryInputs = {
  schema_version: 1;
  source_job: string;
  requested_mode: RepairWorkflowMode;
  effective_mode: RepairWorkflowMode;
  state_revision: string;
  job_sha256: string;
  source_dispatch_key?: never;
  runner?: never;
  execution_runner?: never;
  planner_sandbox?: never;
  model?: never;
  dry_run?: never;
  requeue?: never;
  requeue_depth?: never;
};

export type RepairWorkflowRecoveryInputs =
  | CurrentRepairWorkflowRecoveryInputs
  | LegacyRepairWorkflowRecoveryInputs;

export type RepairLegacyRecoveryInputs = {
  source_job: string;
  mode: RepairWorkflowMode;
  producer_attempt: number;
};

export function boundedRecoveryTimeoutMs({
  deadlineMs,
  nowMs,
  maxTimeoutMs,
}: {
  deadlineMs: number;
  nowMs: number;
  maxTimeoutMs: number;
}): number {
  if (![deadlineMs, nowMs, maxTimeoutMs].every(Number.isFinite) || maxTimeoutMs <= 0) {
    throw new Error("recovery timeout bounds must be finite positive values");
  }
  return Math.max(0, Math.min(maxTimeoutMs, deadlineMs - nowMs));
}

export function resolveRepairWorkflowRetryMode({
  requestedMode,
  recoveredMode,
  fallbackMode,
}: {
  requestedMode: unknown;
  recoveredMode: unknown;
  fallbackMode: unknown;
}): RepairWorkflowMode {
  const requested =
    requestedMode === null || requestedMode === undefined
      ? null
      : repairMode(requestedMode, "requested mode");
  const recovered =
    recoveredMode === null || recoveredMode === undefined
      ? null
      : repairMode(recoveredMode, "recovered mode");
  if (recovered === "plan") return "plan";
  return requested ?? recovered ?? repairMode(fallbackMode, "fallback mode");
}

export function parseRepairWorkflowRecoveryInputs(value: unknown): RepairWorkflowRecoveryInputs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("immutable workflow inputs must be a JSON object");
  }
  const input = value as LooseRecord;
  const keys = JSON.stringify(Object.keys(input).sort());
  const currentShape = keys === JSON.stringify(CURRENT_INPUT_KEYS);
  const legacyShape = keys === JSON.stringify(LEGACY_INPUT_KEYS);
  if (!currentShape && !legacyShape) {
    throw new Error("immutable workflow inputs have unexpected fields");
  }
  if (input.schema_version !== 1) {
    throw new Error("immutable workflow inputs use an unsupported schema version");
  }

  const sourceJob = normalizedSourceJob(input.source_job);
  const requestedMode = repairMode(input.requested_mode, "requested mode");
  const effectiveMode = repairMode(input.effective_mode, "effective mode");
  if (effectiveMode !== requestedMode && effectiveMode !== "plan") {
    throw new Error("immutable workflow inputs contain an invalid effective mode");
  }
  if (legacyShape) {
    const stateRevision = boundedString(input.state_revision, "state revision", 40);
    const jobSha256 = boundedString(input.job_sha256, "job SHA-256", 64);
    if (!/^[a-f0-9]{40}$/.test(stateRevision) || !/^[a-f0-9]{64}$/.test(jobSha256)) {
      throw new Error("immutable workflow inputs contain invalid legacy provenance");
    }
    return {
      schema_version: 1,
      source_job: sourceJob,
      state_revision: stateRevision,
      job_sha256: jobSha256,
      requested_mode: requestedMode,
      effective_mode: effectiveMode,
    };
  }
  const sourceDispatchKey = boundedString(input.source_dispatch_key, "source dispatch key", 256, {
    allowEmpty: true,
  });
  const runner = boundedString(input.runner, "runner", 256);
  const executionRunner = boundedString(input.execution_runner, "execution runner", 256);
  const plannerSandbox = boundedString(input.planner_sandbox, "planner sandbox", 64);
  if (!PLANNER_SANDBOXES.has(plannerSandbox)) {
    throw new Error("immutable workflow inputs contain an invalid planner sandbox");
  }
  const model = boundedString(input.model, "model", 128);
  const dryRun = booleanField(input.dry_run, "dry_run");
  const requeue = booleanField(input.requeue, "requeue");
  const requeueDepth = nonNegativeInteger(input.requeue_depth, "requeue_depth");
  if (requeueDepth > 1 || (requeue && requeueDepth !== 1) || (!requeue && requeueDepth !== 0)) {
    throw new Error("immutable workflow inputs contain an invalid bounded requeue state");
  }

  return {
    schema_version: 1,
    source_job: sourceJob,
    source_dispatch_key: sourceDispatchKey,
    requested_mode: requestedMode,
    effective_mode: effectiveMode,
    runner,
    execution_runner: executionRunner,
    planner_sandbox: plannerSandbox as "read-only" | "danger-full-access",
    model,
    dry_run: dryRun,
    requeue,
    requeue_depth: requeueDepth,
  };
}

export function readNewestRepairWorkflowRecoveryInputs(
  artifactRoot: string,
  runId: string,
): RepairWorkflowRecoveryInputs | null {
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("workflow run id must be a positive integer");
  }
  const prefix = `clawsweeper-repair-inputs-${runId}-`;
  const candidates = fs
    .readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => ({
      attempt: artifactAttempt(entry.name, runId),
      root: path.join(artifactRoot, entry.name),
    }))
    .filter(
      (candidate): candidate is { attempt: number; root: string } => candidate.attempt !== null,
    )
    .sort((left, right) => right.attempt - left.attempt);

  const newest = candidates[0];
  if (!newest) {
    const directMatches = findNamedFiles(artifactRoot, REPAIR_WORKFLOW_INPUTS_BASENAME);
    if (directMatches.length === 0) return null;
    if (directMatches.length !== 1) {
      throw new Error(
        `workflow run ${runId} direct artifact must contain exactly one immutable input snapshot`,
      );
    }
    return readRepairWorkflowRecoveryInputFile(directMatches[0]!);
  }
  const matches = findNamedFiles(newest.root, REPAIR_WORKFLOW_INPUTS_BASENAME);
  if (matches.length !== 1) {
    throw new Error(
      `workflow run ${runId} attempt ${newest.attempt} must contain exactly one immutable input snapshot`,
    );
  }
  return readRepairWorkflowRecoveryInputFile(matches[0]!);
}

function readRepairWorkflowRecoveryInputFile(file: string): RepairWorkflowRecoveryInputs {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
    throw new Error("immutable workflow inputs exceed the bounded file size");
  }
  return parseRepairWorkflowRecoveryInputs(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function readNewestRepairLegacyRecoveryInputs(
  artifactRoot: string,
  runId: string,
): RepairLegacyRecoveryInputs | null {
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("workflow run id must be a positive integer");
  }
  const candidatesByAttempt = new Map<number, RepairLegacyRecoveryInputs[]>();
  for (const entry of fs.readdirSync(artifactRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attempt = legacyArtifactAttempt(entry.name, runId);
    if (attempt === null) continue;
    const artifactDir = path.join(artifactRoot, entry.name);
    for (const planPath of findNamedFiles(artifactDir, "cluster-plan.json")) {
      const resultPath = path.join(path.dirname(planPath), "result.json");
      if (!fs.existsSync(resultPath)) continue;
      const plan = readBoundedJsonObject(planPath, "legacy cluster plan");
      const result = readBoundedJsonObject(resultPath, "legacy repair result");
      const candidate = {
        source_job: normalizedSourceJob(plan.source_job),
        mode: repairMode(result.mode ?? plan.mode, "legacy effective mode"),
        producer_attempt: attempt,
      };
      candidatesByAttempt.set(attempt, [...(candidatesByAttempt.get(attempt) ?? []), candidate]);
    }
  }

  for (const attempt of [...candidatesByAttempt.keys()].sort((left, right) => right - left)) {
    const unique = new Map(
      (candidatesByAttempt.get(attempt) ?? []).map(
        (candidate) => [JSON.stringify(candidate), candidate] as const,
      ),
    );
    if (unique.size > 1) {
      throw new Error(`workflow run ${runId} has an ambiguous legacy cohort at attempt ${attempt}`);
    }
    const selected = unique.values().next().value;
    if (selected) return selected;
  }
  return null;
}

export function isRepairWorkflowArtifactUnavailable(stderr: unknown, stdout: unknown): boolean {
  const detail = `${String(stderr ?? "")}\n${String(stdout ?? "")}`.toLowerCase();
  return [
    "artifact has expired",
    "artifacts expired",
    "no artifacts found",
    "no valid artifacts",
    "http 404",
  ].some((message) => detail.includes(message));
}

function artifactAttempt(name: string, runId: string): number | null {
  const match = name.match(new RegExp(`^clawsweeper-repair-inputs-${runId}-([1-9][0-9]*)$`));
  if (!match) return null;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) ? attempt : null;
}

function legacyArtifactAttempt(name: string, runId: string): number | null {
  if (!name.startsWith("clawsweeper-repair-")) return null;
  const match = name.match(new RegExp(`-${runId}-([1-9][0-9]*)$`));
  if (!match) return null;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) ? attempt : null;
}

function findNamedFiles(root: string, basename: string): string[] {
  const matches: string[] = [];
  const pending = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_ARTIFACT_ENTRIES) {
        throw new Error("immutable workflow input artifact exceeds the traversal bound");
      }
      const candidate = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_ARTIFACT_DEPTH) {
          pending.push({ directory: candidate, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && entry.name === basename) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort();
}

function normalizedSourceJob(value: unknown): string {
  const candidate = boundedString(value, "source job", 512);
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (
    candidate !== normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    !normalized.startsWith("jobs/") ||
    !normalized.endsWith(".md")
  ) {
    throw new Error("immutable workflow inputs contain an invalid source job");
  }
  return normalized;
}

function readBoundedJsonObject(file: string, label: string): LooseRecord {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} exceeds the bounded file size`);
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as LooseRecord;
}

function repairMode(value: unknown, label: string): RepairWorkflowMode {
  const mode = boundedString(value, label, 16);
  if (!REPAIR_MODES.has(mode)) {
    throw new Error(`immutable workflow inputs contain an invalid ${label}`);
  }
  return mode as RepairWorkflowMode;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > maxLength) {
    throw new Error(`immutable workflow inputs contain an invalid ${label}`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`immutable workflow inputs contain an invalid ${label}`);
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error(`immutable workflow inputs contain an invalid ${label}`);
  }
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`immutable workflow inputs contain an invalid ${label}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`immutable workflow inputs contain an invalid ${label}`);
  }
  return Number(value);
}
