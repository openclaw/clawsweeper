#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const REPAIR_WORKFLOW = "repair-cluster-worker.yml";
const REPAIR_REQUEUE_DISPATCH_STEP = "Requeue source-head repair races";
const DEFAULT_WORKFLOW_REPOSITORY = "openclaw/clawsweeper";
const REPAIR_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);

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
  sessionId?: string | null;
  runUrl?: string | null;
  runConclusion?: string | null;
};

type Terminal = {
  outcome: "merged" | "pr_closed" | "repair_failed";
  occurredAt: string;
  reason: string;
  runUrl?: string | null;
};

export async function reconcileAutomergeProductMetrics({
  env = process.env,
  fetcher = fetch,
  now = new Date().toISOString(),
  sessionId = null,
  runUrl = null,
  runConclusion = null,
}: ReconcileOptions = {}) {
  const normalizedSessionId = nullableText(sessionId);
  const normalizedRunUrl = nullableText(runUrl);
  const normalizedRunConclusion = nullableText(runConclusion)?.toLowerCase() ?? null;
  if (normalizedSessionId && !parseSessionId(normalizedSessionId)) {
    return skippedResult("invalid_session_id", 0);
  }
  if (normalizedRunUrl && !parseRunUrl(normalizedRunUrl)) {
    return skippedResult("invalid_run_url", 0);
  }
  if (normalizedRunConclusion && !REPAIR_FAILURE_CONCLUSIONS.has(normalizedRunConclusion)) {
    return skippedResult("invalid_run_conclusion", 0);
  }

  const ingestToken = String(env.CLAWSWEEPER_STATUS_INGEST_TOKEN ?? "").trim();
  if (!ingestToken) return skippedResult("ingest_token_missing", 0);

  const statusUrl = trimTrailingSlash(
    env.CLAWSWEEPER_STATUS_URL || "https://clawsweeper.openclaw.ai",
  );
  const ingestUrl = env.CLAWSWEEPER_STATUS_INGEST_URL || `${statusUrl}/api/events`;
  const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const workflowRepository =
    nullableText(env.CLAWSWEEPER_AUTOMERGE_WORKFLOW_REPOSITORY) ?? DEFAULT_WORKFLOW_REPOSITORY;
  if (!repositoryName(workflowRepository)) return skippedResult("invalid_workflow_repository", 0);
  const limit = normalizedSessionId
    ? 1
    : boundedInt(env.CLAWSWEEPER_AUTOMERGE_RECONCILE_LIMIT, DEFAULT_LIMIT, MAX_LIMIT);
  const timeoutMs = boundedInt(
    env.CLAWSWEEPER_AUTOMERGE_RECONCILE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return skippedResult("invalid_now", 0);
  const deadline = AbortSignal.timeout(timeoutMs);

  try {
    const metricsUrl = new URL("/api/automerge-metrics", `${statusUrl}/`);
    metricsUrl.searchParams.set("range", "7d");
    metricsUrl.searchParams.set("active_only", "true");
    metricsUrl.searchParams.set("session_limit", String(limit));
    if (normalizedSessionId) metricsUrl.searchParams.set("session_id", normalizedSessionId);
    const metrics = await fetchJson(metricsUrl, fetcher, deadline);
    const candidates = activeSessions(metrics, nowMs)
      .filter((session) => !normalizedSessionId || session.session_id === normalizedSessionId)
      .slice(0, limit);
    if (normalizedSessionId && candidates.length === 0) {
      return skippedResult("session_not_active", 0);
    }

    // Durable active sessions form the retry queue. PR state remains authoritative;
    // only an open PR permits the lower-priority repair-run failure observation.
    const results = await Promise.all(
      candidates.map((session) =>
        reconcileSession({
          session,
          runUrlOverride: normalizedRunUrl,
          runConclusionOverride: normalizedRunConclusion,
          observedAt: new Date(nowMs).toISOString(),
          workflowRepository,
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
      github_reads: results.reduce((total, result) => total + result.githubReads, 0),
      terminal: results.filter((result) => result.terminal).length,
      delivered: results.filter((result) => result.delivered).length,
      failed: results.filter((result) => result.error).length,
      skipped: results.filter((result) => result.skipped).length,
      results,
    };
  } catch (error) {
    return {
      ok: false,
      candidates: 0,
      github_reads: 0,
      terminal: 0,
      delivered: 0,
      failed: 1,
      error: errorMessage(error),
    };
  }
}

async function reconcileSession({
  session,
  runUrlOverride,
  runConclusionOverride,
  observedAt,
  workflowRepository,
  ingestUrl,
  ingestToken,
  githubToken,
  fetcher,
  signal,
}: {
  session: ActiveSession;
  runUrlOverride: string | null;
  runConclusionOverride: string | null;
  observedAt: string;
  workflowRepository: string;
  ingestUrl: string;
  ingestToken: string;
  githubToken: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
}) {
  let githubReads = 0;
  try {
    const pr = await fetchJson(
      githubApiUrl(session.repository, `/pulls/${session.item_number}`),
      fetcher,
      signal,
      githubHeaders(githubToken),
    );
    githubReads += 1;
    let terminal = authoritativePrTerminal(pr);
    if (!terminal) {
      const associatedRunUrl = runUrlOverride ?? nullableText(session.run_url);
      const runIdentity = associatedRunUrl ? parseRunUrl(associatedRunUrl) : null;
      if (!runIdentity || runIdentity.repository !== workflowRepository) {
        return sessionSkip(
          session,
          githubReads,
          runIdentity ? "external_run_repository" : "run_url_missing_or_invalid",
        );
      }
      const run = await fetchJson(
        githubApiUrl(runIdentity.repository, `/actions/runs/${runIdentity.runId}`),
        fetcher,
        signal,
        githubHeaders(githubToken),
      );
      githubReads += 1;
      terminal = authoritativeRepairFailure(
        run,
        runIdentity,
        workflowRepository,
        runConclusionOverride,
        observedAt,
      );
      if (!terminal) return sessionSkip(session, githubReads, "repair_run_not_failed");
      if (!runConclusionOverride) {
        // repair-cluster-worker dispatches one non-matrix execute job for one
        // automerge_session_id. Its receipt/cluster/execute jobs fit one 100-row
        // page, so this run-wide step is session-specific. Revisit this contract
        // before adding a matrix or multiple automerge sessions to that workflow.
        // The matched step is requeue_dispatch, not the preceding count detector;
        // its workflow condition requires a nonzero count before it can succeed.
        const jobs = await fetchJson(
          githubApiUrl(
            runIdentity.repository,
            `/actions/runs/${runIdentity.runId}/jobs?filter=latest&per_page=100`,
          ),
          fetcher,
          signal,
          githubHeaders(githubToken),
        );
        githubReads += 1;
        const requeued = repairRunSuccessfullyRequeued(jobs);
        if (requeued === null) return sessionSkip(session, githubReads, "repair_run_jobs_invalid");
        if (requeued) return sessionSkip(session, githubReads, "repair_run_successfully_requeued");
      }
    }

    const response = await fetcher(ingestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(terminalEvent(session, terminal)),
      signal,
    });
    return {
      session_id: session.session_id,
      githubReads,
      terminal: true,
      delivered: response.ok,
      skipped: null,
      error: response.ok ? null : `ingest returned ${response.status}`,
    };
  } catch (error) {
    return {
      session_id: session.session_id,
      githubReads,
      terminal: false,
      delivered: false,
      skipped: "github_or_network_error",
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
    const identity = parseSessionId(String(session.session_id ?? ""));
    const lastEventAt = Date.parse(String(session.last_event_at ?? ""));
    return (
      !session.terminal_at &&
      identity?.repository === session.repository &&
      identity?.itemNumber === session.item_number &&
      Number.isFinite(lastEventAt) &&
      lastEventAt >= nowMs - LOOKBACK_MS &&
      lastEventAt <= nowMs
    );
  });
}

function authoritativePrTerminal(value: unknown): Terminal | null {
  if (!value || typeof value !== "object") return null;
  const pr = value as { merged_at?: unknown; closed_at?: unknown; state?: unknown };
  const mergedAt = isoTimestamp(pr.merged_at);
  if (mergedAt) {
    return {
      outcome: "merged",
      occurredAt: mergedAt,
      reason: "reconciled from authoritative GitHub PR merged_at",
    };
  }
  const closedAt = isoTimestamp(pr.closed_at);
  if (String(pr.state ?? "").toLowerCase() === "closed" && closedAt) {
    return {
      outcome: "pr_closed",
      occurredAt: closedAt,
      reason: "reconciled from authoritative GitHub PR closed_at",
    };
  }
  return null;
}

function authoritativeRepairFailure(
  value: unknown,
  identity: { repository: string; runId: number; url: string },
  workflowRepository: string,
  reportedConclusion: string | null,
  observedAt: string,
): Terminal | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  const repository = repositoryName((run.repository as Record<string, unknown> | null)?.full_name);
  const workflowPath = String(run.path ?? "").split("@")[0];
  const apiConclusion = String(run.conclusion ?? "").toLowerCase();
  const status = String(run.status ?? "").toLowerCase();
  // The workflow knows an earlier step has irreversibly failed while GitHub still
  // reports the current run as in progress. Once GitHub exposes a terminal result,
  // that authoritative conclusion must win over the early best-effort report.
  const useReportedConclusion =
    status === "in_progress" && !apiConclusion && reportedConclusion !== null;
  const conclusion = useReportedConclusion ? reportedConclusion : apiConclusion;
  const completedAt = useReportedConclusion
    ? observedAt
    : status === "completed"
      ? isoTimestamp(run.updated_at)
      : null;
  if (
    Number(run.id) !== identity.runId ||
    repository !== workflowRepository ||
    workflowPath !== `.github/workflows/${REPAIR_WORKFLOW}` ||
    !(status === "completed" || useReportedConclusion) ||
    !REPAIR_FAILURE_CONCLUSIONS.has(conclusion) ||
    !completedAt
  ) {
    return null;
  }
  return {
    outcome: "repair_failed",
    occurredAt: completedAt,
    reason: `reconciled from ${REPAIR_WORKFLOW} conclusion ${conclusion}`,
    runUrl: identity.url,
  };
}

function terminalEvent(session: ActiveSession, terminal: Terminal) {
  return {
    event_type: "clawsweeper.automerge_metric",
    // Reporters for the same outcome share an identity, while competing terminal
    // observations stay distinct so event-level dedupe cannot choose the winner.
    event_id: `${session.session_id}:terminal:reconcile:${terminal.outcome}`,
    session_id: session.session_id,
    phase: "terminal",
    occurred_at: terminal.occurredAt,
    repository: session.repository,
    item_number: session.item_number,
    policy_version: session.policy_version || "immediate-v1",
    state: null,
    outcome: terminal.outcome,
    reason: terminal.reason,
    pr_url:
      session.pr_url || `https://github.com/${session.repository}/pull/${session.item_number}`,
    run_url: terminal.runUrl ?? session.run_url ?? null,
  };
}

function repairRunSuccessfullyRequeued(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const payload = value as { total_count?: unknown; jobs?: unknown };
  if (!Array.isArray(payload.jobs)) return null;
  const totalCount = Number(payload.total_count);
  if (!Number.isInteger(totalCount) || totalCount < 0 || totalCount > payload.jobs.length) {
    return null;
  }
  return payload.jobs.some((job) => {
    if (!job || typeof job !== "object") return false;
    const steps = (job as { steps?: unknown }).steps;
    return (
      Array.isArray(steps) &&
      steps.some(
        (step) =>
          step &&
          typeof step === "object" &&
          String((step as Record<string, unknown>).name ?? "") === REPAIR_REQUEUE_DISPATCH_STEP &&
          String((step as Record<string, unknown>).conclusion ?? "").toLowerCase() === "success",
      )
    );
  });
}

function parseSessionId(value: string) {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*):([^:]+):(.+)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(match[4]!))) return null;
  return { repository: match[1]!, itemNumber: Number(match[2]!) };
}

function parseRunUrl(value: string) {
  try {
    const url = new URL(value);
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)\/?$/.exec(
      url.pathname,
    );
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) return null;
    return {
      repository: `${match[1]}/${match[2]}`,
      runId: Number(match[3]),
      url: `https://github.com/${match[1]}/${match[2]}/actions/runs/${match[3]}`,
    };
  } catch {
    return null;
  }
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

function githubApiUrl(repository: string, path: string) {
  const [owner, name] = repository.split("/");
  return new URL(
    `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}${path}`,
    "https://api.github.com",
  );
}

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openclaw-clawsweeper-automerge-reconciler",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function sessionSkip(session: ActiveSession, githubReads: number, skipped: string) {
  return {
    session_id: session.session_id,
    githubReads,
    terminal: false,
    delivered: false,
    skipped,
    error: null,
  };
}

function skippedResult(skipped: string, candidates: number) {
  return {
    ok: true,
    skipped,
    candidates,
    github_reads: 0,
    terminal: 0,
    delivered: 0,
    failed: 0,
  };
}

function repositoryName(value: unknown) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : null;
}

function isoTimestamp(value: unknown) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function boundedInt(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function nullableText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function trimTrailingSlash(value: string) {
  return String(value).replace(/\/+$/, "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return `Usage: node scripts/dashboard-reconcile-automerge.ts [options]

Reconcile active automerge sessions against authoritative PR and repair workflow state.

Options:
  --session-id <id>  Reconcile one active automerge session
  --run-url <url>    Override that session's associated GitHub Actions run URL
  --run-conclusion <conclusion>
                     Report a failure already established by the current workflow
  --help             Show this help

Output is one JSON object. Exit codes: 0 completed/skipped safely, 1 operational
failure, 2 invalid CLI arguments.`;
}

function parseCliArgs(argv: string[]) {
  let sessionId: string | null = null;
  let runUrl: string | null = null;
  let runConclusion: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true, sessionId, runUrl, runConclusion };
    if (arg !== "--session-id" && arg !== "--run-url" && arg !== "--run-conclusion") {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--session-id") sessionId = value;
    else if (arg === "--run-url") runUrl = value;
    else runConclusion = value;
    index += 1;
  }
  if (runUrl && !sessionId) throw new Error("--run-url requires --session-id");
  if (runConclusion && (!sessionId || !runUrl)) {
    throw new Error("--run-conclusion requires --session-id and --run-url");
  }
  return { help: false, sessionId, runUrl, runConclusion };
}

export function automergeReconcileExitCode(result: { ok?: unknown; failed?: unknown }) {
  return result.ok === true && Number(result.failed ?? 0) === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      const result = await reconcileAutomergeProductMetrics(args);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = automergeReconcileExitCode(result);
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2));
    process.exitCode = 2;
  }
}
