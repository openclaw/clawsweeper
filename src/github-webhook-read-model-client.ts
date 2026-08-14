import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

type JsonRecord = Record<string, unknown>;

export type GithubReadModelEnvironment = {
  readonly EXACT_REVIEW_QUEUE_URL?: string;
  readonly QUEUE_URL?: string;
  readonly CLAWSWEEPER_WEBHOOK_SECRET?: string;
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
  const config = githubReadModelConfig(env);
  if (!config) return null;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`;
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
      "--header",
      `x-clawsweeper-exact-review-signature: ${signature}`,
      "--data-binary",
      "@-",
      `${config.baseUrl}/internal/state/github-read-model/${operation}`,
    ],
    {
      encoding: "utf8",
      input: body,
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
  const raw = String(env.EXACT_REVIEW_QUEUE_URL || env.QUEUE_URL || "").trim();
  const secret = String(env.CLAWSWEEPER_WEBHOOK_SECRET || "").trim();
  if (!raw || !secret) return null;
  try {
    const url = new URL(raw);
    const loopback =
      url.protocol === "http:" && new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password) return null;
    return { baseUrl: url.toString().replace(/\/$/, ""), secret };
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

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
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
