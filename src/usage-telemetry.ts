import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type CodexTokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

export type UsageTokens = {
  input: number;
  cache_read: number;
  output: number;
  reasoning_output: number;
  total: number;
};

export type CodexTokenUsageParseResult = {
  totalTokenUsage: CodexTokenUsage;
  tokens: UsageTokens;
  lastTokenUsage?: CodexTokenUsage;
};

export type UsageStatus =
  | "success"
  | "failed"
  | "timeout"
  | "buffer_exceeded"
  | "missing_result"
  | "result_repair"
  | "schema_invalid";

export type UsageEventMetadata = {
  workflow?: string;
  mode?: string;
  phase?: string;
  target_repo?: string;
  cluster_id?: string;
  item_number?: number;
  commit_sha?: string;
  job_path?: string;
  model?: string;
  reasoning_effort?: string;
  service_tier?: string;
  sandbox?: string;
  timeout_ms?: number;
  elapsed_ms?: number;
  transcript_path?: string;
  stderr_path?: string;
  output_path?: string;
  status: UsageStatus;
  tokens?: UsageTokens | null;
};

export type UsageGitHubMetadata = {
  github_repository?: string;
  github_run_id?: string;
  github_run_attempt?: string;
  github_job?: string;
  runner_name?: string;
};

export type UsageTelemetryEvent = UsageGitHubMetadata &
  UsageEventMetadata & {
    surface: "clawsweeper";
    emitted_at: string;
    tokens: UsageTokens | null;
  };

export type UsageTelemetryEmitter = {
  emit(event: UsageTelemetryEvent): void | Promise<void>;
};

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTokenUsage(value: unknown): CodexTokenUsage | null {
  if (!isRecord(value)) return null;

  const usage: CodexTokenUsage = {};
  if (typeof value.input_tokens === "number") usage.input_tokens = value.input_tokens;
  if (typeof value.cached_input_tokens === "number")
    usage.cached_input_tokens = value.cached_input_tokens;
  if (typeof value.output_tokens === "number") usage.output_tokens = value.output_tokens;
  if (typeof value.reasoning_output_tokens === "number") {
    usage.reasoning_output_tokens = value.reasoning_output_tokens;
  }
  if (typeof value.total_tokens === "number") usage.total_tokens = value.total_tokens;

  return Object.keys(usage).length > 0 ? usage : null;
}

export function normalizeCodexTokenUsage(
  usage: CodexTokenUsage | null | undefined,
): UsageTokens | null {
  if (!usage) return null;

  const input = safeNumber(usage.input_tokens);
  const cacheRead = safeNumber(usage.cached_input_tokens);
  const output = safeNumber(usage.output_tokens);
  const reasoningOutput = safeNumber(usage.reasoning_output_tokens);
  const explicitTotal = safeNumber(usage.total_tokens);
  const total = explicitTotal || input + cacheRead + output + reasoningOutput;

  return {
    input,
    cache_read: cacheRead,
    output,
    reasoning_output: reasoningOutput,
    total,
  };
}

export function parseCodexTokenUsageFromJsonl(stdout: string): CodexTokenUsageParseResult | null {
  let latestTotalUsage: CodexTokenUsage | null = null;
  let latestLastUsage: CodexTokenUsage | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || parsed.type !== "token_count") continue;
    const payload = isRecord(parsed.payload) ? parsed.payload : null;
    const info = payload && isRecord(payload.info) ? payload.info : null;
    if (!info) continue;

    const totalUsage = readTokenUsage(info.total_token_usage);
    const lastUsage = readTokenUsage(info.last_token_usage);
    if (lastUsage) latestLastUsage = lastUsage;
    if (totalUsage) latestTotalUsage = totalUsage;
  }

  const tokens = normalizeCodexTokenUsage(latestTotalUsage);
  if (!latestTotalUsage || !tokens) return null;

  const result: CodexTokenUsageParseResult = {
    totalTokenUsage: latestTotalUsage,
    tokens,
  };
  if (latestLastUsage) result.lastTokenUsage = latestLastUsage;
  return result;
}

export function githubUsageMetadataFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): UsageGitHubMetadata {
  const metadata: UsageGitHubMetadata = {};
  if (env.GITHUB_REPOSITORY) metadata.github_repository = env.GITHUB_REPOSITORY;
  if (env.GITHUB_RUN_ID) metadata.github_run_id = env.GITHUB_RUN_ID;
  if (env.GITHUB_RUN_ATTEMPT) metadata.github_run_attempt = env.GITHUB_RUN_ATTEMPT;
  if (env.GITHUB_JOB) metadata.github_job = env.GITHUB_JOB;
  if (env.RUNNER_NAME) metadata.runner_name = env.RUNNER_NAME;
  return metadata;
}

export function buildUsageTelemetryEvent(
  metadata: UsageEventMetadata,
  options: { env?: NodeJS.ProcessEnv; emittedAt?: Date } = {},
): UsageTelemetryEvent {
  return {
    surface: "clawsweeper",
    emitted_at: (options.emittedAt ?? new Date()).toISOString(),
    ...githubUsageMetadataFromEnv(options.env),
    ...(metadata.workflow ? { workflow: metadata.workflow } : {}),
    ...(metadata.mode ? { mode: metadata.mode } : {}),
    ...(metadata.phase ? { phase: metadata.phase } : {}),
    ...(metadata.target_repo ? { target_repo: metadata.target_repo } : {}),
    ...(metadata.cluster_id ? { cluster_id: metadata.cluster_id } : {}),
    ...(typeof metadata.item_number === "number" ? { item_number: metadata.item_number } : {}),
    ...(metadata.commit_sha ? { commit_sha: metadata.commit_sha } : {}),
    ...(metadata.job_path ? { job_path: metadata.job_path } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.reasoning_effort ? { reasoning_effort: metadata.reasoning_effort } : {}),
    ...(metadata.service_tier ? { service_tier: metadata.service_tier } : {}),
    ...(metadata.sandbox ? { sandbox: metadata.sandbox } : {}),
    ...(typeof metadata.timeout_ms === "number" ? { timeout_ms: metadata.timeout_ms } : {}),
    ...(typeof metadata.elapsed_ms === "number" ? { elapsed_ms: metadata.elapsed_ms } : {}),
    ...(metadata.transcript_path ? { transcript_path: metadata.transcript_path } : {}),
    ...(metadata.stderr_path ? { stderr_path: metadata.stderr_path } : {}),
    ...(metadata.output_path ? { output_path: metadata.output_path } : {}),
    status: metadata.status,
    tokens: metadata.tokens ?? null,
  };
}

export function appendUsageEventJsonl(path: string, event: UsageTelemetryEvent): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function emitUsageTelemetry(
  event: UsageTelemetryEvent,
  emitters: readonly UsageTelemetryEmitter[] = [],
): Promise<void> {
  for (const emitter of emitters) {
    try {
      await emitter.emit(event);
    } catch {
      // Telemetry must never fail the ClawSweeper run.
    }
  }
}
