#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

type ActiveSession = {
  session_id: string;
  repository: string;
  item_number: number;
  policy_version?: string | null;
  pr_url?: string | null;
  run_url?: string | null;
  last_event_at: string;
  terminal_at?: string | null;
};

type ReconcileOptions = {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: string;
};

export async function reconcileAutomergeProductMetrics({
  env = process.env,
  fetcher = fetch,
  now = new Date().toISOString(),
}: ReconcileOptions = {}) {
  const ingestToken = String(env.CLAWSWEEPER_STATUS_INGEST_TOKEN ?? "").trim();
  if (!ingestToken) return { ok: true, skipped: "ingest_token_missing", candidates: 0 };

  const statusUrl = trimTrailingSlash(
    env.CLAWSWEEPER_STATUS_URL || "https://clawsweeper.openclaw.ai",
  );
  const ingestUrl = env.CLAWSWEEPER_STATUS_INGEST_URL || `${statusUrl}/api/events`;
  const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const limit = boundedInt(env.CLAWSWEEPER_AUTOMERGE_RECONCILE_LIMIT, DEFAULT_LIMIT, MAX_LIMIT);
  const timeoutMs = boundedInt(
    env.CLAWSWEEPER_AUTOMERGE_RECONCILE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const nowMs = Date.parse(now);
  const deadline = AbortSignal.timeout(timeoutMs);

  try {
    const metricsUrl = new URL("/api/automerge-metrics", `${statusUrl}/`);
    metricsUrl.searchParams.set("range", "24h");
    metricsUrl.searchParams.set("active_only", "true");
    metricsUrl.searchParams.set("session_limit", String(limit));
    const metrics = await fetchJson(metricsUrl, fetcher, deadline);
    const candidates = activeSessions(metrics, nowMs).slice(0, limit);

    // Durable active sessions already form the retry queue. Re-reading authoritative
    // PR state closes both past and future delivery gaps without a second outbox.
    const results = await Promise.all(
      candidates.map((session) =>
        reconcileSession({
          session,
          ingestUrl,
          ingestToken,
          githubToken,
          fetcher,
          signal: deadline,
        }),
      ),
    );
    return {
      ok: true,
      candidates: candidates.length,
      github_reads: results.filter((result) => result.githubRead).length,
      terminal: results.filter((result) => result.terminal).length,
      delivered: results.filter((result) => result.delivered).length,
      failed: results.filter((result) => result.error).length,
    };
  } catch (error) {
    return {
      ok: false,
      candidates: 0,
      error: errorMessage(error),
    };
  }
}

async function reconcileSession({
  session,
  ingestUrl,
  ingestToken,
  githubToken,
  fetcher,
  signal,
}: {
  session: ActiveSession;
  ingestUrl: string;
  ingestToken: string;
  githubToken: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
}) {
  try {
    const pr = await fetchJson(
      new URL(
        `/repos/${encodeURIComponent(session.repository.split("/")[0]!)}/${encodeURIComponent(
          session.repository.split("/")[1]!,
        )}/pulls/${session.item_number}`,
        "https://api.github.com",
      ),
      fetcher,
      signal,
      {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "openclaw-clawsweeper-automerge-reconciler",
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
    );
    const terminal = authoritativeTerminal(pr);
    if (!terminal) return { githubRead: true, terminal: false, delivered: false };
    const event = terminalEvent(session, terminal);
    const response = await fetcher(ingestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
      signal,
    });
    return {
      githubRead: true,
      terminal: true,
      delivered: response.ok,
      error: response.ok ? null : `ingest returned ${response.status}`,
    };
  } catch (error) {
    return {
      githubRead: true,
      terminal: false,
      delivered: false,
      error: errorMessage(error),
    };
  }
}

function activeSessions(value: unknown, nowMs: number): ActiveSession[] {
  if (!value || typeof value !== "object") return [];
  const sessions = Array.isArray((value as { sessions?: unknown }).sessions)
    ? (value as { sessions: unknown[] }).sessions
    : [];
  return sessions.filter((value): value is ActiveSession => {
    if (!value || typeof value !== "object") return false;
    const session = value as Partial<ActiveSession>;
    const lastEventAt = Date.parse(String(session.last_event_at ?? ""));
    return (
      !session.terminal_at &&
      typeof session.session_id === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(session.repository ?? "")) &&
      Number.isInteger(session.item_number) &&
      Number(session.item_number) > 0 &&
      Number.isFinite(lastEventAt) &&
      lastEventAt >= nowMs - LOOKBACK_MS &&
      lastEventAt <= nowMs
    );
  });
}

function authoritativeTerminal(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const pr = value as { merged_at?: unknown; closed_at?: unknown; state?: unknown };
  const mergedAt = isoTimestamp(pr.merged_at);
  if (mergedAt) return { outcome: "merged", occurredAt: mergedAt } as const;
  const closedAt = isoTimestamp(pr.closed_at);
  if (String(pr.state ?? "").toLowerCase() === "closed" && closedAt) {
    return { outcome: "pr_closed", occurredAt: closedAt } as const;
  }
  return null;
}

function terminalEvent(
  session: ActiveSession,
  terminal: { outcome: "merged" | "pr_closed"; occurredAt: string },
) {
  return {
    event_type: "clawsweeper.automerge_metric",
    event_id: `${session.session_id}:terminal:github-pr:${terminal.outcome}:${terminal.occurredAt}`,
    session_id: session.session_id,
    phase: "terminal",
    occurred_at: terminal.occurredAt,
    repository: session.repository,
    item_number: session.item_number,
    policy_version: session.policy_version || "immediate-v1",
    state: null,
    outcome: terminal.outcome,
    reason: `reconciled from authoritative GitHub PR ${terminal.outcome === "merged" ? "merged_at" : "closed_at"}`,
    pr_url:
      session.pr_url || `https://github.com/${session.repository}/pull/${session.item_number}`,
    run_url: session.run_url || null,
  };
}

async function fetchJson(
  url: URL,
  fetcher: typeof fetch,
  signal: AbortSignal,
  headers: HeadersInit = {},
) {
  const response = await fetcher(url, { headers, signal });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

function isoTimestamp(value: unknown) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function boundedInt(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function trimTrailingSlash(value: string) {
  return String(value).replace(/\/+$/, "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const result = await reconcileAutomergeProductMetrics();
  console.log(JSON.stringify(result, null, 2));
}
