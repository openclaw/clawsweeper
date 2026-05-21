import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type CodexTokenUsage = {
  input_tokens?: number;
  prompt_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

export type UsageTokens = {
  input: number;
  cache_read: number;
  cache_creation: number;
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
  provider?: string;
  session_id?: string;
  turn_id?: string;
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
  if (typeof value.prompt_tokens === "number") usage.prompt_tokens = value.prompt_tokens;
  if (typeof value.cached_input_tokens === "number") {
    usage.cached_input_tokens = value.cached_input_tokens;
  }
  if (typeof value.cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = value.cache_read_input_tokens;
  }
  if (typeof value.cache_creation_input_tokens === "number") {
    usage.cache_creation_input_tokens = value.cache_creation_input_tokens;
  }
  if (typeof value.cache_write_input_tokens === "number") {
    usage.cache_write_input_tokens = value.cache_write_input_tokens;
  }
  if (typeof value.output_tokens === "number") usage.output_tokens = value.output_tokens;
  if (typeof value.completion_tokens === "number")
    usage.completion_tokens = value.completion_tokens;
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

  const input = safeNumber(usage.input_tokens) || safeNumber(usage.prompt_tokens);
  const cacheRead =
    safeNumber(usage.cached_input_tokens) || safeNumber(usage.cache_read_input_tokens);
  const cacheCreation =
    safeNumber(usage.cache_creation_input_tokens) || safeNumber(usage.cache_write_input_tokens);
  const output = safeNumber(usage.output_tokens) || safeNumber(usage.completion_tokens);
  const reasoningOutput = safeNumber(usage.reasoning_output_tokens);
  const explicitTotal = safeNumber(usage.total_tokens);
  const total = explicitTotal || input + cacheRead + cacheCreation + output + reasoningOutput;

  return {
    input,
    cache_read: cacheRead,
    cache_creation: cacheCreation,
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

export function parseClaudeTokenUsageFromMessage(message: unknown): UsageTokens | null {
  const usage = isRecord(message) ? readTokenUsage(message.usage) : null;
  return normalizeCodexTokenUsage(usage);
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

function providerForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-")) return "openai-codex";
  return undefined;
}

function defaultSessionId(
  metadata: UsageEventMetadata,
  github: UsageGitHubMetadata,
): string | undefined {
  if (metadata.session_id) return metadata.session_id;
  if (github.github_run_id) {
    return `github:${github.github_repository ?? "unknown"}:${github.github_run_id}`;
  }
  return undefined;
}

function defaultTurnId(metadata: UsageEventMetadata): string | undefined {
  if (metadata.turn_id) return metadata.turn_id;
  const subject =
    typeof metadata.item_number === "number"
      ? `item:${metadata.item_number}`
      : metadata.commit_sha
        ? `commit:${metadata.commit_sha}`
        : metadata.job_path
          ? `job:${metadata.job_path}`
          : undefined;
  if (!subject) return undefined;
  return [metadata.workflow, metadata.phase, metadata.target_repo, subject]
    .filter(Boolean)
    .join(":");
}

export function buildUsageTelemetryEvent(
  metadata: UsageEventMetadata,
  options: { env?: NodeJS.ProcessEnv; emittedAt?: Date } = {},
): UsageTelemetryEvent {
  const github = githubUsageMetadataFromEnv(options.env);
  const provider = metadata.provider ?? providerForModel(metadata.model);
  const sessionId = defaultSessionId(metadata, github);
  const turnId = defaultTurnId(metadata);

  return {
    surface: "clawsweeper",
    emitted_at: (options.emittedAt ?? new Date()).toISOString(),
    ...github,
    ...(metadata.workflow ? { workflow: metadata.workflow } : {}),
    ...(metadata.mode ? { mode: metadata.mode } : {}),
    ...(metadata.phase ? { phase: metadata.phase } : {}),
    ...(provider ? { provider } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
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
    emitUsageEventOtlpHttp(event);
    return true;
  } catch {
    return false;
  }
}

type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

function otlpAttribute(
  key: string,
  value: unknown,
): { key: string; value: OtlpAttributeValue } | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "string") return { key, value: { stringValue: value } };
  return { key, value: { stringValue: JSON.stringify(value) } };
}

function compactAttributes(
  values: Record<string, unknown>,
): Array<{ key: string; value: OtlpAttributeValue }> {
  return Object.entries(values)
    .map(([key, value]) => otlpAttribute(key, value))
    .filter((value): value is { key: string; value: OtlpAttributeValue } => value !== null);
}

function parseResourceAttributes(value: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const part of String(value ?? "").split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const attributeValue = part.slice(index + 1).trim();
    if (key && attributeValue) attributes[key] = attributeValue;
  }
  return attributes;
}

function otlpTracesEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CLAWSWEEPER_USAGE_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (explicit) return explicit;

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return null;
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

function usageStatusCode(status: UsageStatus): number {
  return status === "success" || status === "result_repair" ? 1 : 2;
}

function cacheInputTokens(tokens: UsageTokens | null | undefined): number {
  if (!tokens) return 0;
  return tokens.input + tokens.cache_read + tokens.cache_creation;
}

function cacheReadRatio(tokens: UsageTokens | null | undefined): number | undefined {
  const input = cacheInputTokens(tokens);
  if (input <= 0) return undefined;
  return tokens ? tokens.cache_read / input : undefined;
}

function traceIdFor(event: UsageTelemetryEvent): string {
  const key =
    event.session_id ||
    [event.github_repository, event.github_run_id, event.workflow, event.target_repo]
      .filter(Boolean)
      .join(":") ||
    event.emitted_at;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function otlpPayloadForUsageEvent(
  event: UsageTelemetryEvent,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const resourceAttributes = {
    ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    "service.name": env.CLAWSWEEPER_USAGE_SERVICE_NAME || "clawsweeper-runner",
    "service.namespace":
      env.CLAWSWEEPER_USAGE_SERVICE_NAMESPACE ||
      parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES)["service.namespace"] ||
      "clawsweeper",
    "telemetry.source": "clawsweeper-usage",
    "agent.product": "clawsweeper",
    "agent.surface": "github-actions-runner",
  };
  const startedAtMs = Date.parse(event.emitted_at) - (event.elapsed_ms ?? 0);
  const endTimeUnixNano = `${BigInt(Date.parse(event.emitted_at)) * 1_000_000n}`;
  const startTimeUnixNano = `${BigInt(Number.isFinite(startedAtMs) ? startedAtMs : Date.parse(event.emitted_at)) * 1_000_000n}`;
  const phase = event.phase || "usage";
  const workflow = event.workflow || "clawsweeper";

  return {
    resourceSpans: [
      {
        resource: { attributes: compactAttributes(resourceAttributes) },
        scopeSpans: [
          {
            scope: { name: "clawsweeper.usage", version: "1" },
            spans: [
              {
                traceId: traceIdFor(event),
                spanId: randomBytes(8).toString("hex"),
                name: `clawsweeper.${workflow}.${phase}`,
                kind: 1,
                startTimeUnixNano,
                endTimeUnixNano,
                attributes: compactAttributes({
                  "gen_ai.system": event.provider || "openai-codex",
                  "gen_ai.operation.name": `clawsweeper.${event.mode || "model_call"}`,
                  "gen_ai.request.model": event.model,
                  "gen_ai.response.model": event.model,
                  "gen_ai.usage.input_tokens": event.tokens?.input,
                  "gen_ai.usage.output_tokens": event.tokens?.output,
                  "gen_ai.usage.cached_input_tokens": event.tokens?.cache_read,
                  "gen_ai.usage.cache_read_input_tokens": event.tokens?.cache_read,
                  "gen_ai.usage.cache_creation_input_tokens": event.tokens?.cache_creation,
                  "gen_ai.usage.reasoning_output_tokens": event.tokens?.reasoning_output,
                  "gen_ai.usage.total_tokens": event.tokens?.total,
                  "gen_ai.usage.cache_input_tokens": cacheInputTokens(event.tokens),
                  "gen_ai.usage.cache_read_ratio": cacheReadRatio(event.tokens),
                  "clawsweeper.surface": event.surface,
                  "clawsweeper.provider": event.provider,
                  "agent.session_id": event.session_id,
                  "agent.turn_id": event.turn_id,
                  "clawsweeper.session_id": event.session_id,
                  "clawsweeper.turn_id": event.turn_id,
                  "clawsweeper.workflow": event.workflow,
                  "clawsweeper.mode": event.mode,
                  "clawsweeper.phase": event.phase,
                  "clawsweeper.target_repo": event.target_repo,
                  "clawsweeper.cluster_id": event.cluster_id,
                  "clawsweeper.item_number": event.item_number,
                  "clawsweeper.commit_sha": event.commit_sha,
                  "clawsweeper.job_path": event.job_path,
                  "clawsweeper.status": event.status,
                  "clawsweeper.reasoning_effort": event.reasoning_effort,
                  "clawsweeper.service_tier": event.service_tier,
                  "clawsweeper.sandbox": event.sandbox,
                  "clawsweeper.timeout_ms": event.timeout_ms,
                  "clawsweeper.elapsed_ms": event.elapsed_ms,
                  "github.repository": event.github_repository,
                  "github.run_id": event.github_run_id,
                  "github.run_attempt": event.github_run_attempt,
                  "github.job": event.github_job,
                  "runner.name": event.runner_name,
                }),
                status: { code: usageStatusCode(event.status), message: event.status },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function emitUsageEventOtlpHttp(
  event: UsageTelemetryEvent,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CLAWSWEEPER_USAGE_TELEMETRY !== "1") return false;
  if (!event.tokens || event.tokens.total <= 0) return false;

  const endpoint = otlpTracesEndpoint(env);
  if (!endpoint) return false;

  try {
    const headers = ["Content-Type: application/json"];
    const authHeader = env.OTEL_EXPORTER_OTLP_HEADERS || env.CLAWSWEEPER_USAGE_OTLP_HEADERS;
    if (authHeader) {
      for (const header of authHeader.split(",")) {
        const trimmed = header.trim();
        if (trimmed) headers.push(trimmed.includes(":") ? trimmed : trimmed.replace("=", ": "));
      }
    }
    const result = spawnSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        String(env.CLAWSWEEPER_USAGE_OTLP_TIMEOUT_SECONDS || "5"),
        "-X",
        "POST",
        ...headers.flatMap((header) => ["-H", header]),
        "--data-binary",
        JSON.stringify(otlpPayloadForUsageEvent(event, env)),
        endpoint,
      ],
      { encoding: "utf8", env: { ...process.env, ...env }, stdio: "ignore" },
    );
    return result.status === 0;
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
