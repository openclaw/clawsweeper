import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  githubEgressCommandDescriptor,
  githubEgressOperation,
  githubEgressRouteTemplate,
} from "./github-egress-descriptor.js";
import {
  GITHUB_EGRESS_METHODS,
  GITHUB_EGRESS_POOL_CLASSES,
  GITHUB_EGRESS_STAGES,
  GITHUB_EGRESS_TELEMETRY_VERSION,
  githubEgressClaimGenerationBucket,
  githubEgressFiveMinuteBucket,
  githubEgressLatencyBucket,
  githubEgressPageBucket,
  githubEgressSourceAction,
  githubEgressStatusBucket,
  type GitHubEgressMethod,
  type GitHubEgressMetricV2,
  type GitHubEgressOutcome,
  type GitHubEgressPageBucket,
  type GitHubEgressPoolClass,
  type GitHubEgressRouteTemplate,
  type GitHubEgressStage,
  type GitHubRateLimitHeadersV2,
  type GitHubRateLimitObservationV2,
} from "./github-egress-telemetry-contract.js";

type ParsedWireAttempt = {
  method: GitHubEgressMethod;
  routeTemplate: GitHubEgressRouteTemplate;
  pageBucket: GitHubEgressPageBucket;
  status: number | null;
  latencyMs: number | null;
  receivedAtMs: number | null;
  headers: GitHubRateLimitHeadersV2;
  complete: boolean;
};

type GitHubEgressContext = {
  deploymentRevision: string;
  configRevision: string;
  poolClass: GitHubEgressPoolClass;
  poolIdentity: string;
  poolIdentityComplete: boolean;
  stage: GitHubEgressStage;
  sourceAction: ReturnType<typeof githubEgressSourceAction>;
  claimGeneration: number | null;
  firstRepeat: "first" | "repeat" | "unknown";
  descriptor: ReturnType<typeof githubEgressCommandDescriptor>;
  complete: boolean;
};

const SAFE_RATE_LIMIT_RESOURCES = new Set(["core", "graphql", "search", "integration_manifest"]);
const CONFIG_KEYS = [
  "CLAWSWEEPER_GH_RETRY_ATTEMPTS",
  "EXACT_REVIEW_BATCH_MAX_ITEMS",
  "EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY",
  "EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED",
] as const;
const MAX_RATE_LIMIT_INTEGER = 10_000_000_000;

export function observeGitHubDebugStderr(
  stderr: Buffer,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Buffer {
  try {
    const context = githubEgressContext(args, env);
    const parsed = parseGitHubDebugStderr(stderr, githubEgressAllowedHosts(env));
    const complete = context.complete && parsed.complete;
    for (const [index, attempt] of parsed.attempts.entries()) {
      const routeTemplate = attempt.routeTemplate;
      const observedAtMs = attempt.receivedAtMs ?? nowMs;
      const pageBucket =
        attempt.pageBucket === "none" && parsed.attempts.length > 1
          ? githubEgressPageBucket(index + 1)
          : attempt.pageBucket;
      const operation =
        routeTemplate === "unknown"
          ? context.descriptor.operation
          : githubEgressOperation(routeTemplate);
      const attemptComplete =
        complete &&
        attempt.complete &&
        attempt.receivedAtMs !== null &&
        routeTemplate !== "unknown";
      appendGithubEgressMetric(env, {
        ...metricBase(context, observedAtMs),
        operation,
        method: attempt.method,
        routeTemplate,
        pageBucket,
        unit: "wire_attempt",
        outcome: wireOutcome(attempt.status, attempt.headers),
        statusBucket: githubEgressStatusBucket(attempt.status),
        latencyBucket: githubEgressLatencyBucket(attempt.latencyMs),
        attempted: true,
        telemetryComplete: attemptComplete,
        count: 1,
      });
      if (attempt.status === 403 || attempt.status === 429) {
        appendRateLimitObservation(env, {
          version: GITHUB_EGRESS_TELEMETRY_VERSION,
          observedAt: new Date(observedAtMs).toISOString(),
          deploymentRevision: context.deploymentRevision,
          configRevision: context.configRevision,
          poolClass: context.poolClass,
          poolIdentity: context.poolIdentity,
          stage: context.stage,
          sourceAction: context.sourceAction,
          operation,
          method: attempt.method,
          routeTemplate,
          pageBucket,
          status: attempt.status,
          headers: attempt.headers,
          resetAuthorityCandidate: resetAuthorityCandidate(attempt.headers),
          telemetryComplete: attemptComplete,
        });
      }
    }
    const last = parsed.attempts.at(-1);
    const invocationDescriptor = observedInvocationDescriptor(context, parsed.attempts);
    appendGithubEgressMetric(env, {
      ...metricBase(context, nowMs),
      operation: invocationDescriptor.operation,
      method: invocationDescriptor.method,
      routeTemplate: invocationDescriptor.routeTemplate,
      pageBucket: "none",
      unit: "invocation",
      outcome:
        parsed.attempts.length === 0
          ? "pre_wire_failure"
          : wireOutcome(last?.status ?? null, last?.headers ?? emptyRateLimitHeaders()),
      statusBucket: githubEgressStatusBucket(last?.status ?? null),
      latencyBucket: "unknown",
      attempted: parsed.attempts.length > 0,
      telemetryComplete: complete && parsed.attempts.length > 0 && invocationDescriptor.complete,
      count: 1,
    });
    return parsed.cleanStderr;
  } catch {
    // Observation is deliberately fail-open for command behavior. Never put a
    // raw diagnostic frame back on stderr: it may contain response bodies,
    // query strings, ETags, URLs, or request identifiers.
    return conservativeStripGitHubDebug(stderr);
  }
}

function observedInvocationDescriptor(
  context: GitHubEgressContext,
  attempts: readonly ParsedWireAttempt[],
): {
  operation: GitHubEgressMetricV2["operation"];
  method: GitHubEgressMethod;
  routeTemplate: GitHubEgressRouteTemplate;
  complete: boolean;
} {
  if (context.descriptor.routeTemplate !== "unknown") {
    return { ...context.descriptor, complete: context.descriptor.operation !== "other" };
  }
  const completeAttempts = attempts.filter((attempt) => attempt.complete);
  if (completeAttempts.length !== attempts.length || completeAttempts.length === 0) {
    return { operation: "other", method: "UNKNOWN", routeTemplate: "unknown", complete: false };
  }
  const routes = new Set(completeAttempts.map((attempt) => attempt.routeTemplate));
  const methods = new Set(completeAttempts.map((attempt) => attempt.method));
  if (routes.size === 1) {
    const routeTemplate = completeAttempts[0]!.routeTemplate;
    return {
      operation: githubEgressOperation(routeTemplate),
      method: methods.size === 1 ? completeAttempts[0]!.method : "UNKNOWN",
      routeTemplate,
      complete: true,
    };
  }
  return { operation: "other", method: "UNKNOWN", routeTemplate: "multiple", complete: true };
}

export function recordUnobservedGitHubInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): void {
  try {
    const context = githubEgressContext(args, env);
    appendGithubEgressMetric(env, {
      ...metricBase(context, nowMs),
      operation: context.descriptor.operation,
      method: context.descriptor.method,
      routeTemplate: context.descriptor.routeTemplate,
      pageBucket: "none",
      unit: "invocation",
      outcome: "ambiguous",
      statusBucket: "none",
      latencyBucket: "unknown",
      attempted: true,
      telemetryComplete: false,
      count: 1,
    });
  } catch {
    // A missing or unwritable telemetry sink must not affect GitHub egress.
  }
}

export function appendLegacyAvoidedGithubEgressMember(options: {
  env?: NodeJS.ProcessEnv;
  poolClass: GitHubEgressPoolClass;
  stage: GitHubEgressStage;
  sourceAction?: string;
  operation: GitHubEgressMetricV2["operation"];
  claimGeneration: number;
  repeatRevision: boolean;
  nowMs?: number;
}): void {
  recordGithubEgressMember({
    ...options,
    attempted: false,
    outcome: "legacy_avoided",
  });
}

export function recordGithubEgressMember(
  options: {
    env?: NodeJS.ProcessEnv;
    poolClass?: GitHubEgressPoolClass;
    stage?: GitHubEgressStage;
    sourceAction?: string;
    operation?: GitHubEgressMetricV2["operation"];
    claimGeneration?: number;
    repeatRevision?: boolean;
    attempted?: boolean;
    outcome?: GitHubEgressOutcome;
    nowMs?: number;
  } = {},
): void {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  try {
    const context = githubEgressContext([], {
      ...env,
      ...(options.poolClass ? { CLAWSWEEPER_GITHUB_POOL_CLASS: options.poolClass } : {}),
      ...(options.stage ? { CLAWSWEEPER_GITHUB_STAGE: options.stage } : {}),
      ...(options.sourceAction !== undefined
        ? { CLAWSWEEPER_GITHUB_SOURCE_ACTION: options.sourceAction }
        : {}),
      ...(options.claimGeneration
        ? { CLAWSWEEPER_GITHUB_CLAIM_GENERATION: String(options.claimGeneration) }
        : {}),
      ...(typeof options.repeatRevision === "boolean"
        ? { CLAWSWEEPER_GITHUB_REQUEST_REPEAT: String(options.repeatRevision) }
        : {}),
    });
    const operation = options.operation ?? "other";
    appendGithubEgressMetric(env, {
      ...metricBase(context, nowMs),
      operation,
      method: "UNKNOWN",
      routeTemplate: operation === "artifact_download" ? "actions_run_artifacts" : "unknown",
      pageBucket: "none",
      unit: "member",
      outcome: options.outcome ?? "attempted",
      statusBucket: "none",
      latencyBucket: "unknown",
      attempted: options.attempted ?? true,
      telemetryComplete:
        context.poolClass !== "other" &&
        context.poolIdentityComplete &&
        context.stage !== "unknown" &&
        context.sourceAction !== "unknown" &&
        context.claimGeneration !== null &&
        context.firstRepeat !== "unknown",
      count: 1,
    });
  } catch {
    // Observation remains fail-open.
  }
}

export function parseGitHubDebugStderr(
  stderr: Buffer,
  allowedHosts: ReadonlySet<string> = new Set(["api.github.com", "github.com"]),
): {
  cleanStderr: Buffer;
  attempts: ParsedWireAttempt[];
  complete: boolean;
} {
  const text = stderr.toString("latin1");
  const attempts: ParsedWireAttempt[] = [];
  const clean: string[] = [];
  let cursor = 0;
  let complete = true;
  const startPattern = /^\* Request at [^\r\n]*(?:\r?\n|$)/gm;
  while (true) {
    startPattern.lastIndex = cursor;
    const start = startPattern.exec(text);
    if (!start) {
      clean.push(text.slice(cursor));
      break;
    }
    clean.push(text.slice(cursor, start.index));
    const endPattern = /^\* Request (?:took|failed after) [^\r\n]*(?:\r?\n|$)/gm;
    endPattern.lastIndex = start.index + start[0].length;
    const end = endPattern.exec(text);
    if (!end) {
      complete = false;
      // Never forward a partial diagnostic block: it can contain response
      // bodies, query strings, ETags, or request identifiers.
      cursor = text.length;
      break;
    }
    const blockEnd = end.index + end[0].length;
    attempts.push(parseDebugBlock(text.slice(start.index, blockEnd), allowedHosts));
    cursor = blockEnd;
  }
  return {
    cleanStderr: Buffer.from(clean.join(""), "latin1"),
    attempts,
    complete,
  };
}

function conservativeStripGitHubDebug(stderr: Buffer): Buffer {
  const text = stderr.toString("latin1");
  const first = text.search(/^\* Request at [^\r\n]*(?:\r?\n|$)/m);
  return first < 0 ? stderr : Buffer.from(text.slice(0, first), "latin1");
}

function parseDebugBlock(block: string, allowedHosts: ReadonlySet<string>): ParsedWireAttempt {
  const request = /^> (GET|POST|PATCH|PUT|DELETE|HEAD) ([^\s]+) HTTP\/[^\r\n]+$/m.exec(block);
  const response = /^< HTTP\/[^\s]+ (\d{3})(?:\s|$)/m.exec(block);
  const requestTo = /^\* Request to (\S+)$/m.exec(block)?.[1] || "";
  const method = request?.[1] as GitHubEgressMethod | undefined;
  const requestTarget = request?.[2] || "";
  let routeTemplate: GitHubEgressRouteTemplate = "unknown";
  let page: number | null = null;
  try {
    const url = new URL(requestTarget, requestTo || "https://api.github.invalid");
    const host = url.hostname.toLowerCase();
    if (allowedHosts.has(host)) {
      routeTemplate = githubEgressRouteTemplate(url.pathname);
    } else if (host.endsWith(".blob.core.windows.net")) {
      routeTemplate = "external_artifact_blob";
    }
    const rawPage = url.searchParams.get("page");
    page = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : null;
  } catch {
    routeTemplate = "unknown";
  }
  const status = response ? Number(response[1]) : null;
  const latencyMs = parseLatency(block);
  const requestedAt = /^\* Request at ([^\r\n]+)$/m.exec(block)?.[1]?.trim() || "";
  const requestedAtMs = Date.parse(requestedAt.replace(/\s+m=[+-][^\s]+$/, ""));
  const receivedAtMs =
    Number.isFinite(requestedAtMs) && latencyMs !== null ? requestedAtMs + latencyMs : null;
  const headers = responseHeaders(block);
  return {
    method: method && GITHUB_EGRESS_METHODS.includes(method) ? method : "UNKNOWN",
    routeTemplate,
    pageBucket: githubEgressPageBucket(page),
    status: Number.isSafeInteger(status) ? status : null,
    latencyMs,
    receivedAtMs,
    headers,
    complete: Boolean(
      request && response && method && routeTemplate !== "unknown" && receivedAtMs !== null,
    ),
  };
}

function githubEgressAllowedHosts(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const hosts = new Set(["api.github.com", "github.com"]);
  const configured = String(env.GH_HOST || "").trim();
  if (configured) {
    try {
      hosts.add(new URL(`https://${configured}`).hostname.toLowerCase());
    } catch {
      // An invalid GH_HOST cannot expand the safe parser boundary.
    }
  }
  return hosts;
}

function responseHeaders(block: string): GitHubRateLimitHeadersV2 {
  const values = new Map<string, string>();
  for (const match of block.matchAll(/^< ([^:\r\n]+):\s*([^\r\n]*)$/gm)) {
    values.set(String(match[1]).toLowerCase(), String(match[2]).trim());
  }
  const numeric = (name: string) => boundedIntegerHeader(values.get(name));
  const retryAfter = numeric("retry-after");
  const limit = numeric("x-ratelimit-limit");
  const remaining = numeric("x-ratelimit-remaining");
  const used = numeric("x-ratelimit-used");
  const reset = numeric("x-ratelimit-reset");
  const rawResource = values.get("x-ratelimit-resource");
  const resource = rawResource
    ? SAFE_RATE_LIMIT_RESOURCES.has(rawResource.toLowerCase())
      ? (rawResource.toLowerCase() as NonNullable<GitHubRateLimitHeadersV2["resource"]>)
      : "unknown"
    : null;
  return {
    retryAfterPresent: values.has("retry-after"),
    retryAfterSeconds: retryAfter,
    limitPresent: values.has("x-ratelimit-limit"),
    limit,
    remainingPresent: values.has("x-ratelimit-remaining"),
    remaining,
    usedPresent: values.has("x-ratelimit-used"),
    used,
    resetPresent: values.has("x-ratelimit-reset"),
    resetEpochSeconds: reset,
    resourcePresent: values.has("x-ratelimit-resource"),
    resource,
  };
}

function githubEgressContext(args: readonly string[], env: NodeJS.ProcessEnv): GitHubEgressContext {
  const rawPool = String(env.CLAWSWEEPER_GITHUB_POOL_CLASS || "");
  const poolClass = GITHUB_EGRESS_POOL_CLASSES.includes(rawPool as GitHubEgressPoolClass)
    ? (rawPool as GitHubEgressPoolClass)
    : "other";
  const rawStage = String(env.CLAWSWEEPER_GITHUB_STAGE || "");
  const stage = GITHUB_EGRESS_STAGES.includes(rawStage as GitHubEgressStage)
    ? (rawStage as GitHubEgressStage)
    : "unknown";
  const claimGenerationText =
    env.CLAWSWEEPER_GITHUB_CLAIM_GENERATION ||
    env.EXACT_REVIEW_BATCH_CLAIM_GENERATION ||
    env.EXACT_REVIEW_CLAIM_GENERATION ||
    "";
  const claimGeneration = /^\d+$/.test(claimGenerationText) ? Number(claimGenerationText) : null;
  const repeat = env.CLAWSWEEPER_GITHUB_REQUEST_REPEAT;
  const firstRepeat = repeat === "true" ? "repeat" : repeat === "false" ? "first" : "unknown";
  const deploymentSource =
    env.CLAWSWEEPER_DEPLOYMENT_REVISION || env.GITHUB_SHA || "unknown-deployment";
  const deploymentRevision = digest(`deployment:v1:${deploymentSource}`, 16);
  const configRevision = digest(
    JSON.stringify({
      version: 1,
      values: Object.fromEntries(CONFIG_KEYS.map((key) => [key, env[key] || ""])),
    }),
    16,
  );
  const targetOwner = /^([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+$/.exec(
    String(env.TARGET_REPO || ""),
  )?.[1];
  const repository = String(env.GITHUB_REPOSITORY || "").toLowerCase();
  const poolIdentityComplete =
    poolClass === "target_app"
      ? Boolean(targetOwner)
      : poolClass === "repository_actions" || poolClass === "public_read_fallback"
        ? /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)
        : false;
  const poolSource =
    poolClass === "target_app"
      ? `target_app:${targetOwner?.toLowerCase() || "unknown"}`
      : poolClass === "repository_actions" || poolClass === "public_read_fallback"
        ? `repository_actions:${repository || "unknown"}`
        : "other";
  const descriptor = githubEgressCommandDescriptor(args);
  return {
    deploymentRevision,
    configRevision,
    poolClass,
    poolIdentity: digest(`pool:v1:${poolSource}`, 24),
    poolIdentityComplete,
    stage,
    sourceAction: githubEgressSourceAction(env.CLAWSWEEPER_GITHUB_SOURCE_ACTION),
    claimGeneration,
    firstRepeat,
    descriptor,
    complete:
      poolClass !== "other" &&
      poolIdentityComplete &&
      stage !== "unknown" &&
      githubEgressSourceAction(env.CLAWSWEEPER_GITHUB_SOURCE_ACTION) !== "unknown" &&
      firstRepeat !== "unknown" &&
      claimGeneration !== null &&
      githubEgressClaimGenerationBucket(claimGeneration) !== "unknown",
  };
}

function metricBase(context: GitHubEgressContext, nowMs: number) {
  return {
    version: GITHUB_EGRESS_TELEMETRY_VERSION,
    bucketStart: githubEgressFiveMinuteBucket(nowMs),
    deploymentRevision: context.deploymentRevision,
    configRevision: context.configRevision,
    poolClass: context.poolClass,
    poolIdentity: context.poolIdentity,
    stage: context.stage,
    sourceAction: context.sourceAction,
    claimGenerationBucket: githubEgressClaimGenerationBucket(context.claimGeneration),
    firstRepeat: context.firstRepeat,
  } as const;
}

function appendGithubEgressMetric(env: NodeJS.ProcessEnv, metric: GitHubEgressMetricV2): void {
  const path = githubEgressMetricsPath(env);
  if (!path) return;
  appendJsonLine(path, metric);
}

function appendRateLimitObservation(
  env: NodeJS.ProcessEnv,
  observation: GitHubRateLimitObservationV2,
): void {
  const path = env.CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH?.trim();
  if (!path) return;
  appendJsonLine(path, observation);
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function githubEgressMetricsPath(env: NodeJS.ProcessEnv): string | null {
  return env.CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH?.trim() || null;
}

function wireOutcome(
  status: number | null,
  headers: GitHubRateLimitHeadersV2,
): GitHubEgressOutcome {
  if (status === null) return "ambiguous";
  if (
    status === 429 ||
    (status === 403 && (headers.remaining === 0 || headers.retryAfterPresent))
  ) {
    return "throttle";
  }
  if (status >= 200 && status < 400) return "success";
  if (status >= 500) return "transient";
  return "error";
}

function resetAuthorityCandidate(
  headers: GitHubRateLimitHeadersV2,
): GitHubRateLimitObservationV2["resetAuthorityCandidate"] {
  if (headers.retryAfterPresent) {
    return headers.retryAfterSeconds === null ? "invalid" : "retry_after";
  }
  if (headers.resetPresent) {
    return headers.resetEpochSeconds === null ? "invalid" : "rate_limit_reset";
  }
  return "absent";
}

function boundedIntegerHeader(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_RATE_LIMIT_INTEGER
    ? parsed
    : null;
}

function parseLatency(block: string): number | null {
  const match = /^\* Request took ([\d.]+)(Â?µs|ms|s)$/m.exec(block);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  if (match[2]?.endsWith("µs")) return value / 1_000;
  if (match[2] === "s") return value * 1_000;
  return value;
}

function emptyRateLimitHeaders(): GitHubRateLimitHeadersV2 {
  return {
    retryAfterPresent: false,
    retryAfterSeconds: null,
    limitPresent: false,
    limit: null,
    remainingPresent: false,
    remaining: null,
    usedPresent: false,
    used: null,
    resetPresent: false,
    resetEpochSeconds: null,
    resourcePresent: false,
    resource: null,
  };
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
