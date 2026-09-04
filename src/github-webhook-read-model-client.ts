import { recordOrEmpty as record } from "./value-coerce.js";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

type JsonRecord = Record<string, unknown>;

export type GithubReadModelEnvironment = {
  readonly EXACT_REVIEW_QUEUE_URL?: string;
  readonly QUEUE_URL?: string;
  readonly CLAWSWEEPER_WEBHOOK_SECRET?: string;
  readonly EXACT_REVIEW_ITEM_KEY?: string;
  readonly EXACT_REVIEW_LEASE_ID?: string;
  readonly EXACT_REVIEW_LEASE_REVISION?: string;
  readonly EXACT_REVIEW_CLAIM_GENERATION?: string;
  readonly EXACT_REVIEW_SOURCE_HEAD_SHA?: string;
  readonly GITHUB_RUN_ID?: string;
  readonly GITHUB_RUN_ATTEMPT?: string;
};

export type GithubReadModelResponse = JsonRecord & {
  usable?: boolean;
  hit?: boolean;
  watermark?: number;
  class_state?: {
    event_class?: string;
    available?: boolean;
    reason?: string;
    probe_window_elapsed?: boolean;
  };
};

const reportedDegradations = new Set<string>();

export function githubReadModelRequestSync(
  operation: "item" | "comments" | "activity" | "workflows" | "placeholders" | "repair",
  payload: JsonRecord,
  env: GithubReadModelEnvironment = process.env,
): GithubReadModelResponse | null {
  const request = githubReadModelSyncRequest(operation, payload, env);
  if (!request) return null;
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      ...request.headers.flatMap(([name, value]) => ["--header", `${name}: ${value}`]),
      "--data-binary",
      "@-",
      request.url,
    ],
    {
      encoding: "utf8",
      input: request.body,
      timeout: 6_000,
      maxBuffer: 4 * 1_024 * 1_024,
      env: process.env,
    },
  );
  if (result.error || result.status !== 0) return null;
  return parseResponse(result.stdout);
}

export async function githubReadModelRequest(
  operation: "item" | "comments" | "activity" | "workflows" | "placeholders" | "repair",
  payload: JsonRecord,
  options: {
    env?: GithubReadModelEnvironment;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GithubReadModelResponse | null> {
  const config = githubReadModelConfig(options.env ?? process.env);
  if (!config) return null;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`;
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${config.baseUrl}/internal/state/github-read-model/${operation}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return null;
    return parseResponse(await response.text());
  } catch {
    return null;
  }
}

export function githubReadModelLeaseItemRequest(
  payload: JsonRecord,
  env: GithubReadModelEnvironment,
): { url: string; body: string } | null {
  const baseUrl = githubReadModelBaseUrl(env);
  const repository = typeof payload.repository === "string" ? payload.repository.toLowerCase() : "";
  const number = positiveInteger(payload.number);
  const itemKey = String(env.EXACT_REVIEW_ITEM_KEY || "").trim();
  const leaseId = String(env.EXACT_REVIEW_LEASE_ID || "").trim();
  const leaseRevision = positiveInteger(env.EXACT_REVIEW_LEASE_REVISION);
  const claimGeneration = positiveInteger(env.EXACT_REVIEW_CLAIM_GENERATION);
  const runId = positiveInteger(env.GITHUB_RUN_ID);
  const runAttempt = positiveInteger(env.GITHUB_RUN_ATTEMPT);
  const sourceHeadSha = String(env.EXACT_REVIEW_SOURCE_HEAD_SHA || "")
    .trim()
    .toLowerCase();
  if (
    !baseUrl ||
    !validRepository(repository) ||
    !number ||
    itemKey.toLowerCase() !== `${repository}#${number}` ||
    !leaseId ||
    !leaseRevision ||
    !claimGeneration ||
    !runId ||
    !runAttempt ||
    (sourceHeadSha && !/^[0-9a-f]{40}$/.test(sourceHeadSha))
  ) {
    return null;
  }
  return {
    url: `${baseUrl}/internal/exact-review/github-read-model/item`,
    body: JSON.stringify({
      repository,
      number,
      item_key: itemKey,
      lease_id: leaseId,
      lease_revision: leaseRevision,
      claim_generation: claimGeneration,
      run_id: String(runId),
      run_attempt: runAttempt,
      ...(sourceHeadSha ? { source_head_sha: sourceHeadSha } : {}),
    }),
  };
}

export function usableGithubReadModelResponse(
  response: GithubReadModelResponse | null,
  consumer: string,
  expectedClass: string,
): response is GithubReadModelResponse & { usable: true } {
  if (response?.usable === true) return true;
  const state = record(response?.class_state);
  const reason =
    typeof state.reason === "string"
      ? state.reason
      : response
        ? response.hit === false
          ? "snapshot_miss"
          : "snapshot_stale_or_gap"
        : "read_model_unavailable";
  const key = `${consumer}:${expectedClass}:${reason}`;
  if (!reportedDegradations.has(key)) {
    reportedDegradations.add(key);
    console.warn(
      JSON.stringify({
        event: "github_read_model_degraded",
        consumer,
        event_class: expectedClass,
        reason,
        probe_window_elapsed: state.probe_window_elapsed === true,
        fallback: "live_poll",
      }),
    );
  }
  return false;
}

export function githubReadModelItemObject(
  repository: string,
  issue: JsonRecord,
): JsonRecord | null {
  const number = positiveInteger(issue.number);
  const updatedAt = timestamp(issue.updated_at);
  if (!validRepository(repository) || !number || !updatedAt) return null;
  return {
    kind: "item",
    repository: repository.toLowerCase(),
    number,
    itemKind: issue.pull_request ? "pull_request" : "issue",
    sourceUpdatedAt: updatedAt,
    snapshot: issue,
  };
}

export function githubReadModelCommentObject(
  repository: string,
  numberValue: unknown,
  comment: JsonRecord,
): JsonRecord | null {
  const number = positiveInteger(numberValue);
  const id = positiveInteger(comment.id);
  const updatedAt = timestamp(comment.updated_at) ?? timestamp(comment.created_at);
  if (!validRepository(repository) || !number || !id || !updatedAt) return null;
  return {
    kind: "comment",
    repository: repository.toLowerCase(),
    number,
    id,
    sourceUpdatedAt: updatedAt,
    tombstone: false,
    snapshot: comment,
  };
}

export function githubReadModelWorkflowObject(
  repository: string,
  kind: "workflow_run" | "workflow_job" | "check_run" | "check_suite",
  value: JsonRecord,
): JsonRecord | null {
  const id = positiveInteger(value.id);
  const updatedAt =
    timestamp(value.updated_at) ??
    timestamp(value.completed_at) ??
    timestamp(value.started_at) ??
    timestamp(value.created_at);
  if (!validRepository(repository) || !id || !updatedAt) return null;
  return {
    kind,
    repository: repository.toLowerCase(),
    id,
    runId: kind === "workflow_run" ? id : positiveInteger(value.run_id),
    sourceUpdatedAt: updatedAt,
    snapshot: value,
  };
}

function githubReadModelConfig(env: GithubReadModelEnvironment): {
  baseUrl: string;
  secret: string;
} | null {
  const baseUrl = githubReadModelBaseUrl(env);
  const secret = String(env.CLAWSWEEPER_WEBHOOK_SECRET || "").trim();
  return baseUrl && secret ? { baseUrl, secret } : null;
}

function githubReadModelSyncRequest(
  operation: "item" | "comments" | "activity" | "workflows" | "placeholders" | "repair",
  payload: JsonRecord,
  env: GithubReadModelEnvironment,
): { url: string; body: string; headers: Array<readonly [string, string]> } | null {
  const config = githubReadModelConfig(env);
  if (config) {
    const body = JSON.stringify(payload);
    return {
      url: `${config.baseUrl}/internal/state/github-read-model/${operation}`,
      body,
      headers: [
        [
          "x-clawsweeper-exact-review-signature",
          `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`,
        ],
      ],
    };
  }
  if (operation !== "item") return null;
  const lease = githubReadModelLeaseItemRequest(payload, env);
  return lease ? { ...lease, headers: [] } : null;
}

function githubReadModelBaseUrl(env: GithubReadModelEnvironment): string | null {
  const raw = String(env.EXACT_REVIEW_QUEUE_URL || env.QUEUE_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback =
      url.protocol === "http:" && new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseResponse(value: string): GithubReadModelResponse | null {
  try {
    const parsed: unknown = JSON.parse(value || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as GithubReadModelResponse)
      : null;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function timestamp(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && Number.isFinite(Date.parse(text))
    ? new Date(Date.parse(text)).toISOString()
    : null;
}

function validRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
