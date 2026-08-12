import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS,
  GITHUB_EGRESS_LATENCY_BUCKETS,
  GITHUB_EGRESS_METHODS,
  GITHUB_EGRESS_OPERATIONS,
  GITHUB_EGRESS_OUTCOMES,
  GITHUB_EGRESS_PAGE_BUCKETS,
  GITHUB_EGRESS_POOL_CLASSES,
  GITHUB_EGRESS_ROUTE_TEMPLATES,
  GITHUB_EGRESS_SOURCE_ACTIONS,
  GITHUB_EGRESS_STAGES,
  GITHUB_EGRESS_STATUS_BUCKETS,
  GITHUB_EGRESS_TELEMETRY_VERSION,
  GITHUB_EGRESS_UNITS,
  githubEgressFiveMinuteBucket,
  type GitHubEgressMetricV2,
  type GitHubRateLimitObservationV2,
} from "../github-egress-telemetry-contract.js";

const MAX_METRICS_PER_SUBMISSION = 128;
const MAX_RATE_LIMITS_PER_SUBMISSION = 16;
const MAX_INPUT_LINES = 2_000;
const MAX_COUNT = 1_000_000;
const MAX_RATE_LIMIT_INTEGER = 10_000_000_000;

export type GitHubEgressTelemetrySubmission = {
  receiptId: string;
  metrics: GitHubEgressMetricV2[];
  rateLimitObservations: GitHubRateLimitObservationV2[];
};

export function githubEgressTelemetrySubmissions(options: {
  metricsPath: string;
  rateLimitPath: string;
  receiptScope?: string;
}): GitHubEgressTelemetrySubmission[] {
  const metricInput = readJsonLines(options.metricsPath);
  const rateLimitInput = readJsonLines(options.rateLimitPath);
  const metricResult = aggregateMetrics(metricInput.values);
  const metrics = metricResult.metrics;
  const rateLimitObservations: GitHubRateLimitObservationV2[] = [];
  let invalidRateLimits = 0;
  for (const value of rateLimitInput.values) {
    const observation = githubRateLimitObservation(value);
    if (observation) rateLimitObservations.push(observation);
    else invalidRateLimits += 1;
  }
  const invalid =
    metricInput.invalid + metricResult.invalid + rateLimitInput.invalid + invalidRateLimits;
  if (invalid > 0) {
    const exemplar = metrics[0] ?? incompleteMetric();
    metrics.push({
      ...exemplar,
      operation: "other",
      method: "UNKNOWN",
      routeTemplate: "unknown",
      pageBucket: "unknown",
      unit: "invocation",
      outcome: "ambiguous",
      statusBucket: "none",
      latencyBucket: "unknown",
      attempted: false,
      telemetryComplete: false,
      count: Math.min(MAX_COUNT, invalid),
    });
  }
  const submissions: GitHubEgressTelemetrySubmission[] = [];
  const receiptScope =
    options.receiptScope ||
    [
      process.env.GITHUB_RUN_ID || "local",
      process.env.GITHUB_RUN_ATTEMPT || "1",
      process.env.GITHUB_JOB || "unknown-job",
      createHash("sha256")
        .update(`${options.metricsPath}\0${options.rateLimitPath}`)
        .digest("hex")
        .slice(0, 16),
    ].join(":");
  const chunks = Math.max(
    Math.ceil(metrics.length / MAX_METRICS_PER_SUBMISSION),
    Math.ceil(rateLimitObservations.length / MAX_RATE_LIMITS_PER_SUBMISSION),
  );
  for (let index = 0; index < chunks; index += 1) {
    const metricChunk = metrics.slice(
      index * MAX_METRICS_PER_SUBMISSION,
      (index + 1) * MAX_METRICS_PER_SUBMISSION,
    );
    const rateChunk = rateLimitObservations.slice(
      index * MAX_RATE_LIMITS_PER_SUBMISSION,
      (index + 1) * MAX_RATE_LIMITS_PER_SUBMISSION,
    );
    const body = JSON.stringify({
      version: 2,
      metrics: metricChunk,
      rateLimitObservations: rateChunk,
    });
    submissions.push({
      receiptId: createHash("sha256")
        .update(`github-egress-v2:${receiptScope}:${index}:${body}`)
        .digest("hex"),
      metrics: metricChunk,
      rateLimitObservations: rateChunk,
    });
  }
  return submissions;
}

export async function submitGitHubEgressTelemetry(options: {
  baseUrl: string;
  webhookSecret: string;
  submission: GitHubEgressTelemetrySubmission;
  fetch?: typeof globalThis.fetch;
}): Promise<{ accepted: boolean; deduped: boolean }> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://"))
    throw new Error("GitHub egress telemetry URL must use HTTPS");
  if (!options.webhookSecret) throw new Error("GitHub egress telemetry secret is required");
  const body = JSON.stringify({
    version: GITHUB_EGRESS_TELEMETRY_VERSION,
    receipt_id: options.submission.receiptId,
    metrics: options.submission.metrics.map(metricPayload),
    rate_limit_observations: options.submission.rateLimitObservations.map(rateLimitPayload),
  });
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
  const response = await (options.fetch ?? globalThis.fetch)(
    `${baseUrl}/internal/exact-review/github-egress-telemetry`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await response.text();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`GitHub egress telemetry returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || result.ok !== true) {
    throw new Error(
      `GitHub egress telemetry failed (HTTP ${response.status}): ${String(result.error || "unknown")}`,
    );
  }
  return { accepted: result.accepted === true, deduped: result.deduped === true };
}

function readJsonLines(path: string): { values: unknown[]; invalid: number } {
  if (!existsSync(path)) return { values: [], invalid: 0 };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const values: unknown[] = [];
  let invalid = 0;
  for (const line of lines.slice(0, MAX_INPUT_LINES)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      invalid += 1;
    }
  }
  if (lines.length > MAX_INPUT_LINES) invalid += lines.length - MAX_INPUT_LINES;
  return { values, invalid };
}

function aggregateMetrics(values: readonly unknown[]): {
  metrics: GitHubEgressMetricV2[];
  invalid: number;
} {
  const metrics = new Map<string, GitHubEgressMetricV2>();
  let invalid = 0;
  for (const value of values) {
    const metric = githubEgressMetric(value);
    if (!metric) {
      invalid += 1;
      continue;
    }
    const key = JSON.stringify({ ...metric, count: 0 });
    const prior = metrics.get(key);
    metrics.set(key, { ...metric, count: Math.min(MAX_COUNT, (prior?.count || 0) + metric.count) });
  }
  return { metrics: [...metrics.values()], invalid };
}

function incompleteMetric(nowMs = Date.now()): GitHubEgressMetricV2 {
  const digest = (value: string, length: number) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  return {
    version: GITHUB_EGRESS_TELEMETRY_VERSION,
    bucketStart: githubEgressFiveMinuteBucket(nowMs),
    deploymentRevision: digest(
      `deployment:v1:${process.env.CLAWSWEEPER_DEPLOYMENT_REVISION || process.env.GITHUB_SHA || "unknown"}`,
      16,
    ),
    configRevision: digest("config:v1:invalid-input", 16),
    poolClass: "other",
    poolIdentity: digest("pool:v1:other", 24),
    stage: "unknown",
    sourceAction: "unknown",
    operation: "other",
    method: "UNKNOWN",
    routeTemplate: "unknown",
    pageBucket: "unknown",
    unit: "invocation",
    outcome: "ambiguous",
    statusBucket: "none",
    latencyBucket: "unknown",
    claimGenerationBucket: "unknown",
    firstRepeat: "unknown",
    attempted: false,
    telemetryComplete: false,
    count: 1,
  };
}

function githubEgressMetric(value: unknown): GitHubEgressMetricV2 | null {
  const item = objectValue(value);
  if (!item || item.version !== GITHUB_EGRESS_TELEMETRY_VERSION) return null;
  const bucketStart = safeTimestamp(item.bucketStart);
  const deploymentRevision = safeDigest(item.deploymentRevision, 16);
  const configRevision = safeDigest(item.configRevision, 16);
  const poolIdentity = safeDigest(item.poolIdentity, 24);
  const count = Number(item.count);
  if (
    !bucketStart ||
    !deploymentRevision ||
    !configRevision ||
    !poolIdentity ||
    !member(GITHUB_EGRESS_POOL_CLASSES, item.poolClass) ||
    !member(GITHUB_EGRESS_STAGES, item.stage) ||
    !member(GITHUB_EGRESS_SOURCE_ACTIONS, item.sourceAction) ||
    !member(GITHUB_EGRESS_OPERATIONS, item.operation) ||
    !member(GITHUB_EGRESS_METHODS, item.method) ||
    !member(GITHUB_EGRESS_ROUTE_TEMPLATES, item.routeTemplate) ||
    !member(GITHUB_EGRESS_PAGE_BUCKETS, item.pageBucket) ||
    !member(GITHUB_EGRESS_UNITS, item.unit) ||
    !member(GITHUB_EGRESS_OUTCOMES, item.outcome) ||
    !member(GITHUB_EGRESS_STATUS_BUCKETS, item.statusBucket) ||
    !member(GITHUB_EGRESS_LATENCY_BUCKETS, item.latencyBucket) ||
    !member(GITHUB_EGRESS_CLAIM_GENERATION_BUCKETS, item.claimGenerationBucket) ||
    !member(["first", "repeat", "unknown"] as const, item.firstRepeat) ||
    typeof item.attempted !== "boolean" ||
    typeof item.telemetryComplete !== "boolean" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_COUNT
  ) {
    return null;
  }
  return {
    version: GITHUB_EGRESS_TELEMETRY_VERSION,
    bucketStart,
    deploymentRevision,
    configRevision,
    poolClass: item.poolClass,
    poolIdentity,
    stage: item.stage,
    sourceAction: item.sourceAction,
    operation: item.operation,
    method: item.method,
    routeTemplate: item.routeTemplate,
    pageBucket: item.pageBucket,
    unit: item.unit,
    outcome: item.outcome,
    statusBucket: item.statusBucket,
    latencyBucket: item.latencyBucket,
    claimGenerationBucket: item.claimGenerationBucket,
    firstRepeat: item.firstRepeat,
    attempted: item.attempted,
    telemetryComplete: item.telemetryComplete,
    count,
  };
}

function githubRateLimitObservation(value: unknown): GitHubRateLimitObservationV2 | null {
  const item = objectValue(value);
  const headers = objectValue(item?.headers);
  if (!item || !headers || item.version !== GITHUB_EGRESS_TELEMETRY_VERSION) return null;
  const observedAt = safeTimestamp(item.observedAt);
  const deploymentRevision = safeDigest(item.deploymentRevision, 16);
  const configRevision = safeDigest(item.configRevision, 16);
  const poolIdentity = safeDigest(item.poolIdentity, 24);
  if (
    !observedAt ||
    !deploymentRevision ||
    !configRevision ||
    !poolIdentity ||
    !member(GITHUB_EGRESS_POOL_CLASSES, item.poolClass) ||
    !member(GITHUB_EGRESS_STAGES, item.stage) ||
    !member(GITHUB_EGRESS_SOURCE_ACTIONS, item.sourceAction) ||
    !member(GITHUB_EGRESS_OPERATIONS, item.operation) ||
    !member(GITHUB_EGRESS_METHODS, item.method) ||
    !member(GITHUB_EGRESS_ROUTE_TEMPLATES, item.routeTemplate) ||
    !member(GITHUB_EGRESS_PAGE_BUCKETS, item.pageBucket) ||
    (item.status !== 403 && item.status !== 429) ||
    !member(
      ["retry_after", "rate_limit_reset", "absent", "invalid"] as const,
      item.resetAuthorityCandidate,
    ) ||
    typeof item.telemetryComplete !== "boolean"
  ) {
    return null;
  }
  const parsedHeaders = rateLimitHeaders(headers);
  if (!parsedHeaders) return null;
  if (item.resetAuthorityCandidate !== resetAuthorityCandidate(parsedHeaders)) return null;
  return {
    version: GITHUB_EGRESS_TELEMETRY_VERSION,
    observedAt,
    deploymentRevision,
    configRevision,
    poolClass: item.poolClass,
    poolIdentity,
    stage: item.stage,
    sourceAction: item.sourceAction,
    operation: item.operation,
    method: item.method,
    routeTemplate: item.routeTemplate,
    pageBucket: item.pageBucket,
    status: item.status,
    headers: parsedHeaders,
    resetAuthorityCandidate: item.resetAuthorityCandidate,
    telemetryComplete: item.telemetryComplete,
  };
}

function rateLimitHeaders(
  value: Record<string, unknown>,
): GitHubRateLimitObservationV2["headers"] | null {
  const numeric = (name: string) => {
    const candidate = value[name];
    return candidate === null ||
      (Number.isSafeInteger(candidate) &&
        Number(candidate) >= 0 &&
        Number(candidate) <= MAX_RATE_LIMIT_INTEGER)
      ? (candidate as number | null)
      : undefined;
  };
  const retryAfterSeconds = numeric("retryAfterSeconds");
  const limit = numeric("limit");
  const remaining = numeric("remaining");
  const used = numeric("used");
  const resetEpochSeconds = numeric("resetEpochSeconds");
  const resource = value.resource;
  if (
    [
      "retryAfterPresent",
      "limitPresent",
      "remainingPresent",
      "usedPresent",
      "resetPresent",
      "resourcePresent",
    ].some((name) => typeof value[name] !== "boolean") ||
    [retryAfterSeconds, limit, remaining, used, resetEpochSeconds].includes(undefined) ||
    !(
      resource === null ||
      member(["core", "graphql", "search", "integration_manifest", "unknown"] as const, resource)
    )
  ) {
    return null;
  }
  if (
    (!value.retryAfterPresent && retryAfterSeconds !== null) ||
    (!value.limitPresent && limit !== null) ||
    (!value.remainingPresent && remaining !== null) ||
    (!value.usedPresent && used !== null) ||
    (!value.resetPresent && resetEpochSeconds !== null) ||
    (!value.resourcePresent && resource !== null) ||
    (value.resourcePresent && resource === null)
  ) {
    return null;
  }
  return {
    retryAfterPresent: value.retryAfterPresent as boolean,
    retryAfterSeconds: retryAfterSeconds!,
    limitPresent: value.limitPresent as boolean,
    limit: limit!,
    remainingPresent: value.remainingPresent as boolean,
    remaining: remaining!,
    usedPresent: value.usedPresent as boolean,
    used: used!,
    resetPresent: value.resetPresent as boolean,
    resetEpochSeconds: resetEpochSeconds!,
    resourcePresent: value.resourcePresent as boolean,
    resource: resource as GitHubRateLimitObservationV2["headers"]["resource"],
  };
}

function resetAuthorityCandidate(
  headers: GitHubRateLimitObservationV2["headers"],
): GitHubRateLimitObservationV2["resetAuthorityCandidate"] {
  if (headers.retryAfterPresent) {
    return headers.retryAfterSeconds === null ? "invalid" : "retry_after";
  }
  if (headers.resetPresent) {
    return headers.resetEpochSeconds === null ? "invalid" : "rate_limit_reset";
  }
  return "absent";
}

function metricPayload(metric: GitHubEgressMetricV2) {
  return {
    bucket_start: metric.bucketStart,
    deployment_revision: metric.deploymentRevision,
    config_revision: metric.configRevision,
    pool_class: metric.poolClass,
    pool_identity: metric.poolIdentity,
    stage: metric.stage,
    source_action: metric.sourceAction,
    operation: metric.operation,
    method: metric.method,
    route_template: metric.routeTemplate,
    page_bucket: metric.pageBucket,
    unit: metric.unit,
    outcome: metric.outcome,
    status_bucket: metric.statusBucket,
    latency_bucket: metric.latencyBucket,
    claim_generation_bucket: metric.claimGenerationBucket,
    first_repeat: metric.firstRepeat,
    attempted: metric.attempted,
    telemetry_complete: metric.telemetryComplete,
    count: metric.count,
  };
}

function rateLimitPayload(observation: GitHubRateLimitObservationV2) {
  return {
    observed_at: observation.observedAt,
    deployment_revision: observation.deploymentRevision,
    config_revision: observation.configRevision,
    pool_class: observation.poolClass,
    pool_identity: observation.poolIdentity,
    stage: observation.stage,
    source_action: observation.sourceAction,
    operation: observation.operation,
    method: observation.method,
    route_template: observation.routeTemplate,
    page_bucket: observation.pageBucket,
    status: observation.status,
    headers: observation.headers,
    reset_authority_candidate: observation.resetAuthorityCandidate,
    telemetry_complete: observation.telemetryComplete,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeDigest(value: unknown, length: number): string | null {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
    ? value
    : null;
}

function member<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
