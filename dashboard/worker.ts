import {
  commandTextForClawSweeperFastAck,
  isClawSweeperReReviewCommandText,
} from "../src/repair/comment-command-text.ts";
import { TRIAGE_ROUTING_GROUPS, triageRoutingGroupsForLabels } from "./triage-routing-groups.ts";

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const QUEUED_RUN_STATUSES = new Set(["queued", "waiting", "requested", "pending"]);
type DashboardEnv = Record<string, unknown>;
type DashboardContext = { waitUntil?: (promise: Promise<unknown>) => void };
type GithubAppJsonOptions = { method?: string; body?: BodyInit; errorLabel?: string };
type StoredValue = { value: string; expires_at?: number };
type WorkflowRunSummary = {
  id: number | string;
  name?: string;
  display_title?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
};
type ExactReviewDecision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  sourceAction: string;
  supersedesInProgress: boolean;
  codexTimeoutMs?: number;
  mediaProofTimeoutMs?: number;
};
type ExactReviewQueueItem = {
  key: string;
  decision: ExactReviewDecision;
  state: "pending" | "dispatching" | "leased";
  revision: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  attempts: number;
  leaseId?: string;
  leaseRevision?: number;
  leaseExpiresAt?: number;
  claimedRunId?: string;
};
type ExactReviewQueueState = {
  deliveries: Record<string, number>;
  items: Record<string, ExactReviewQueueItem>;
};
type DurableObjectStub = { fetch: (request: Request) => Promise<Response> };
type DurableObjectNamespace = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => DurableObjectStub;
};

declare global {
  interface CacheStorage {
    default: Cache;
  }
}
const ACTIVE_RUN_STATUS_FILTERS = ["in_progress", "queued", "waiting", "requested", "pending"];
const TERMINAL_BAD_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
const EVENT_LIMIT = 200;
const EVENT_STORE_TTL_SECONDS = 7 * 24 * 60 * 60;
const AVERAGE_LIMIT = 4;
const RECENT_CLOSED_LIMIT = 8;
const CLOSED_STATS_HOURS = 24;
const CLOSED_STATS_PAGE_LIMIT = 10;
const DEFAULT_CLAWSWEEPER_BOT_LOGINS = ["clawsweeper[bot]", "openclaw-clawsweeper[bot]"];
const GITHUB_TIMEOUT_MS = 4500;
const DEFAULT_STALE_QUEUED_WORKFLOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT = 12;
const DEFAULT_EXACT_REVIEW_TARGET_MAX_CONCURRENT = 8;
const DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS = 130 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_RETRY_MS = 30_000;
const EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_STATE_KEY = "exact-review-queue";
const EXACT_REVIEW_QUEUE_NAME = "global";
const CLAWSWEEPER_REVIEW_REPO = "openclaw/clawsweeper";
const CLAWSWEEPER_STATE_REPO = "openclaw/clawsweeper-state";
const CLAWSWEEPER_STATE_REF = "state";
const DEFAULT_CRABFLEET_URL = "https://crabfleet.openclaw.ai";
const CLUSTER_REPAIR_INTAKE_WORKFLOW = "repair-cluster-intake.yml";
const CLAWSWEEPER_ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CLAWSWEEPER_ISSUE_ITEM_ACTIONS = new Set(["opened", "reopened", "edited"]);
const CLAWSWEEPER_PULL_ITEM_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "edited",
]);
const DEFAULT_FAST_ACK_SETTLE_DELAYS_MS = [250, 1500, 10_000];
const inFlightFastAcks = new Map();
const CLAWSWEEPER_WEBHOOK_DENY_REPOS = new Set(["openclaw/clawsweeper-state", "openclaw/.github"]);
const OPTIONAL_SECTION_TIMEOUT_MS = 6000;
const STALE_CACHE_TTL_SECONDS = 900;
const CI_STATUS_TTL_SECONDS = 7200;
const WORKER_JOB_CACHE_TTL_SECONDS = 60;
const WORKER_JOB_IDLE_CACHE_TTL_SECONDS = 10;
const WORKER_JOB_PAGE_LIMIT = 3;
const DEFAULT_WORKER_JOB_FETCH_CONCURRENCY = 12;
const RECENT_WORKER_HEALTH_RUN_LIMIT = 20;
const WORKER_HEALTH_CACHE_TTL_SECONDS = 120;
const DEFAULT_WORKER_HEALTH_FETCH_CONCURRENCY = 10;
const WORKER_TARGET_CACHE_TTL_SECONDS = 900;
const WORKER_TARGET_BATCH_SIZE = 50;
const AUTOMERGE_CACHE_TTL_SECONDS = 300;
const RECENT_CLOSED_CACHE_TTL_SECONDS = 300;
const DEFAULT_WORKER_DETAIL_RUN_LIMIT = 32;
const SUPPORT_WORKFLOW_NAMES = new Set([
  "CI",
  "CodeQL",
  "ClawSweeper Live Dashboard",
  "ClawSweeper Live Dashboard CI Status",
  "github activity to openclaw",
  "spam comment intake",
]);
const TRIAGE_CACHE_TTL_SECONDS = 120;
const DEFAULT_TRIAGE_ITEMS_PER_VIEW = 500;
const DEFAULT_PR_PROOF_ITEMS_PER_VIEW = 500;
const MAX_TRIAGE_ITEMS_PER_VIEW = 1000;
const TRIAGE_SEARCH_PAGE_SIZE = 100;
const TRIAGE_FOCUSED_FALLBACK_ITEMS_PER_VIEW = 100;
const TRIAGE_LINKED_PR_ITEM_LIMIT = 240;
const TRIAGE_LINKED_PR_BATCH_SIZE = 25;
const TRIAGE_LABEL_PREFIX = "clawsweeper:";
const GITHUB_APP_TOKEN_REFRESH_SKEW_MS = 120_000;
const GITHUB_APP_TOKEN_DEFAULT_TTL_MS = 50 * 60_000;
const PR_PROOF_LABEL_NAMES = [
  "triage: needs-real-behavior-proof",
  "triage: mock-only-proof",
  "proof: sufficient",
  "proof: override",
  "mantis: telegram-visible-proof",
];
const TRIAGE_VIEWS = [
  {
    id: "clawsweeper",
    title: "ClawSweeper",
    description: "Open issues carrying any ClawSweeper label.",
    anyLabels: "discovered",
  },
  {
    id: "ready-candidates",
    title: "Ready candidates",
    description: "Queueable fixes without a no-new-fix-pr blocker.",
    allLabels: ["clawsweeper:queueable-fix"],
    withoutLabels: ["clawsweeper:no-new-fix-pr"],
  },
  {
    id: "queueable-blocked",
    title: "Queueable but blocked",
    description: "Queueable-looking fixes where ClawSweeper also recommends no new fix PR.",
    allLabels: ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"],
  },
  {
    id: "already-has-pr",
    title: "Already has PR",
    description: "Issues where ClawSweeper found an open linked pull request.",
    allLabels: ["clawsweeper:linked-pr-open"],
  },
  {
    id: "needs-info",
    title: "Needs info",
    description: "Issues needing reporter details before ClawSweeper can verify behavior.",
    allLabels: ["clawsweeper:needs-info"],
  },
  {
    id: "needs-maintainer-review",
    title: "Needs maintainer review",
    description: "Issues where a human maintainer decision is the next useful step.",
    allLabels: ["clawsweeper:needs-maintainer-review"],
  },
  {
    id: "product-security",
    title: "Product or security",
    description: "Issues needing product, behavior, or security-sensitive review.",
    anyLabels: ["clawsweeper:needs-product-decision", "clawsweeper:needs-security-review"],
  },
  {
    id: "needs-live-repro",
    title: "Needs live repro",
    description:
      "Issues where source evidence exists but live validation would improve confidence.",
    allLabels: ["clawsweeper:needs-live-repro"],
  },
];
const PR_PROOF_VIEWS = [
  {
    id: "proof-triage",
    title: "Proof triage",
    description: "Open pull requests carrying proof or proof-triage labels.",
    anyLabels: "proof",
    itemLimit: 100,
  },
  {
    id: "needs-proof",
    title: "Needs proof",
    description: "Open PRs where real behavior proof is still requested.",
    allLabels: ["triage: needs-real-behavior-proof"],
    itemLimit: 100,
  },
  {
    id: "missing-proof",
    title: "Needs proof review",
    description: "Proof is requested, but ClawSweeper has not marked it sufficient or overridden.",
    allLabels: ["triage: needs-real-behavior-proof"],
    withoutLabels: ["proof: sufficient", "proof: override"],
  },
  {
    id: "sufficient-proof",
    title: "Proof sufficient",
    description: "ClawSweeper judged the real behavior proof sufficient.",
    allLabels: ["proof: sufficient"],
    itemLimit: 100,
  },
  {
    id: "mock-only-proof",
    title: "Mock-only proof",
    description: "Proof appears to rely only on tests, mocks, snapshots, lint, typecheck, or CI.",
    allLabels: ["triage: mock-only-proof"],
    itemLimit: 100,
  },
  {
    id: "telegram-proof",
    title: "Telegram proof",
    description: "PRs where Mantis should capture Telegram visible proof.",
    allLabels: ["mantis: telegram-visible-proof"],
    itemLimit: 100,
  },
  {
    id: "sufficient-with-need-label",
    title: "Sufficient + needs label",
    description:
      "PRs that have sufficient proof but still carry the needs-real-behavior-proof label.",
    allLabels: ["triage: needs-real-behavior-proof", "proof: sufficient"],
    itemLimit: 100,
  },
];

let githubAppTokenCache = null;
let statusRefresh = null;

export class StatusStore {
  private storage;

  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key) return new Response("missing key", { status: 400 });

    if (request.method === "GET") {
      const stored = (await this.storage.get(key)) as StoredValue | undefined;
      if (!stored) return new Response(null, { status: 404 });
      if (stored.expires_at && stored.expires_at <= Date.now()) {
        await this.storage.delete(key);
        return new Response(null, { status: 404 });
      }
      return new Response(stored.value);
    }

    if (request.method === "PUT") {
      const stored = (await request.json()) as StoredValue;
      if (typeof stored?.value !== "string") return new Response("invalid value", { status: 400 });
      await this.storage.put(key, stored);
      if (stored.expires_at) await this.scheduleCleanup(stored.expires_at);
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && key === "events") {
      const body = await request.json();
      const current = (await this.storage.get("events")) as StoredValue | undefined;
      const currentValue =
        current?.value && (!current.expires_at || current.expires_at > Date.now())
          ? current.value
          : null;
      const parsed = currentValue ? JSON.parse(currentValue) : [];
      const events = [body.event, ...(Array.isArray(parsed) ? parsed : [])].slice(
        0,
        numberFrom(body.limit, EVENT_LIMIT),
      );
      const expiresAt = Date.now() + numberFrom(body.ttl_seconds, EVENT_STORE_TTL_SECONDS) * 1000;
      await this.storage.put("events", {
        value: JSON.stringify(events),
        expires_at: expiresAt,
      });
      await this.scheduleCleanup(expiresAt);
      return json({ ok: true });
    }

    return new Response("method not allowed", { status: 405 });
  }

  async alarm() {
    const now = Date.now();
    const entries = (await this.storage.list()) as Map<string, StoredValue>;
    const expired = [];
    let nextExpiration = Number.POSITIVE_INFINITY;
    for (const [key, stored] of entries) {
      if (!stored?.expires_at) continue;
      if (stored.expires_at <= now) expired.push(key);
      else nextExpiration = Math.min(nextExpiration, stored.expires_at);
    }
    await Promise.all(expired.map((key) => this.storage.delete(key)));
    await this.storage.deleteAlarm();
    if (Number.isFinite(nextExpiration)) await this.storage.setAlarm(nextExpiration);
  }

  private async scheduleCleanup(expiresAt: number) {
    const scheduled = await this.storage.getAlarm();
    if (scheduled === null || expiresAt < scheduled) await this.storage.setAlarm(expiresAt);
  }
}

export class ExactReviewQueue {
  private storage;
  private env;

  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/enqueue") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const decision = exactReviewDecisionFrom(body.decision);
      if (!deliveryId) return json({ error: "missing_delivery_id" }, 400);
      if (!decision) return json({ error: "invalid_exact_review_item" }, 400);
      if (!isExactReviewQueueTargetEnabled(decision, this.env)) {
        return json({ ok: true, accepted: false, reason: "target not enabled" }, 202);
      }

      const now = Date.now();
      const state = await this.readState();
      pruneExactReviewDeliveries(state, now);
      const existingDelivery = state.deliveries[deliveryId];
      if (existingDelivery) {
        return json({ ok: true, deduped: true, item_key: exactReviewItemKey(decision) }, 202);
      }

      state.deliveries[deliveryId] = now;
      const key = exactReviewItemKey(decision);
      const current = state.items[key];
      if (current) {
        current.decision = decision;
        current.revision += 1;
        current.updatedAt = now;
        current.nextAttemptAt = now;
        if (current.state === "pending") current.attempts = 0;
      } else {
        state.items[key] = {
          key,
          decision,
          state: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: now,
          attempts: 0,
        };
      }
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({ ok: true, queued: true, item_key: key }, 202);
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = objectValue(await request.json().catch(() => null));
      const leaseId = String(body.lease_id || "").trim();
      const runId = String(body.run_id || "").trim();
      if (!leaseId || !runId) return json({ error: "missing_lease_or_run" }, 400);

      const now = Date.now();
      const state = await this.readState();
      const item = exactReviewItemForLease(state, leaseId);
      if (!item || !isLiveExactReviewLease(item, now)) {
        return json({ error: "lease_not_active" }, 409);
      }
      if (item.claimedRunId && item.claimedRunId !== runId) {
        return json({ error: "lease_already_claimed" }, 409);
      }

      item.state = "leased";
      item.claimedRunId = runId;
      item.leaseExpiresAt = now + exactReviewExecutionLeaseMs(this.env);
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({
        ok: true,
        claimed: true,
        item_key: item.key,
        revision: item.leaseRevision,
      });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = objectValue(await request.json().catch(() => null));
      const leaseId = String(body.lease_id || "").trim();
      const runId = String(body.run_id || "").trim();
      if (!leaseId || !runId) return json({ error: "missing_lease_or_run" }, 400);

      const now = Date.now();
      const state = await this.readState();
      const item = exactReviewItemForLease(state, leaseId);
      if (!item || item.claimedRunId !== runId) return json({ error: "lease_not_claimed" }, 409);

      const requeued = item.revision > Number(item.leaseRevision || 0);
      if (requeued) {
        clearExactReviewLease(item);
        item.state = "pending";
        item.nextAttemptAt = now;
        item.attempts = 0;
        item.updatedAt = now;
      } else {
        delete state.items[item.key];
      }
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({ ok: true, requeued });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const now = Date.now();
      const state = await this.readState();
      // Dashboard reads are also the operational heartbeat. Reclaim leases and
      // restore the alarm here so a deploy or lost alarm cannot strand backlog.
      const changed = reclaimExpiredExactReviewLeases(state, now);
      if (changed) await this.writeState(state);
      await this.scheduleNext(state, now);
      return json(
        exactReviewQueueStats(
          state,
          now,
          exactReviewQueueCapacity(this.env),
          exactReviewTargetCapacity(this.env),
        ),
      );
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const now = Date.now();
    await this.storage.deleteAlarm();
    const state = await this.readState();
    let changed = reclaimExpiredExactReviewLeases(state, now);
    const capacity = exactReviewQueueCapacity(this.env);
    const targetCapacity = exactReviewTargetCapacity(this.env);
    const slots = Math.max(0, capacity - exactReviewQueueActiveCount(state));
    const activeTargets = new Map<string, number>();
    for (const item of Object.values(state.items)) {
      if (item.state !== "dispatching" && item.state !== "leased") continue;
      const target = item.decision.targetRepo;
      activeTargets.set(target, (activeTargets.get(target) || 0) + 1);
    }
    const admitted: ExactReviewQueueItem[] = [];
    const pending = Object.values(state.items)
      .filter((item) => item.state === "pending" && item.nextAttemptAt <= now)
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
    for (const item of pending) {
      if (admitted.length >= slots) break;
      const target = item.decision.targetRepo;
      const active = activeTargets.get(target) || 0;
      if (active >= targetCapacity) continue;
      activeTargets.set(target, active + 1);
      admitted.push(item);
    }

    for (const item of admitted) {
      item.state = "dispatching";
      item.leaseId = crypto.randomUUID();
      item.leaseRevision = item.revision;
      item.leaseExpiresAt = now + exactReviewDispatchLeaseMs(this.env);
      item.claimedRunId = undefined;
      changed = true;
    }
    if (changed) await this.writeState(state);

    if (admitted.length) {
      let token: string | null = null;
      try {
        token = await exactReviewDispatchToken(this.env);
      } catch {
        token = null;
      }
      for (const item of admitted) {
        try {
          if (!token) throw new Error("exact review dispatch token unavailable");
          await dispatchClawsweeperItem({ token, decision: item.decision, leaseId: item.leaseId });
        } catch {
          clearExactReviewLease(item);
          item.state = "pending";
          item.attempts += 1;
          item.nextAttemptAt = now + exactReviewRetryDelayMs(item.attempts);
          item.updatedAt = now;
          changed = true;
        }
      }
      if (changed) await this.writeState(state);
    }

    await this.scheduleNext(state, now);
  }

  private async readState(): Promise<ExactReviewQueueState> {
    const stored = (await this.storage.get(EXACT_REVIEW_QUEUE_STATE_KEY)) as
      | ExactReviewQueueState
      | undefined;
    return {
      deliveries:
        stored?.deliveries && typeof stored.deliveries === "object" ? stored.deliveries : {},
      items: stored?.items && typeof stored.items === "object" ? stored.items : {},
    };
  }

  private async writeState(state: ExactReviewQueueState) {
    await this.storage.put(EXACT_REVIEW_QUEUE_STATE_KEY, state);
  }

  private async scheduleNext(state: ExactReviewQueueState, now: number) {
    const next = exactReviewQueueNextWakeAt(
      state,
      now,
      exactReviewQueueCapacity(this.env),
      exactReviewTargetCapacity(this.env),
    );
    if (next === null) {
      await this.storage.deleteAlarm();
      return;
    }
    const scheduled = await this.storage.getAlarm();
    if (scheduled === null || next < scheduled) await this.storage.setAlarm(next);
  }
}

export default {
  async fetch(request: Request, env: DashboardEnv = {}, ctx?: DashboardContext) {
    const url = new URL(request.url);
    if (
      url.hostname.includes("-ingest.") &&
      url.pathname !== "/api/events" &&
      url.pathname !== "/api/health"
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/api/health") return json({ ok: true, service: "clawsweeper-status" });
    if (url.pathname === "/api/events" && request.method === "POST")
      return ingestEvent(request, env);
    if (url.pathname === "/github/webhook" && request.method === "GET")
      return json({ ok: true, service: "clawsweeper-github-webhook" });
    if (url.pathname === "/github/webhook" && request.method === "POST")
      return githubWebhook(request, env, ctx);
    if (url.pathname === "/internal/exact-review/enqueue" && request.method === "POST")
      return authenticatedExactReviewEnqueue(request, env);
    if (url.pathname === "/internal/exact-review/claim" && request.method === "POST")
      return exactReviewQueueRequest(env, "/claim", request);
    if (url.pathname === "/internal/exact-review/complete" && request.method === "POST")
      return exactReviewQueueRequest(env, "/complete", request);
    if (url.pathname === "/api/exact-review-queue" && request.method === "GET")
      return exactReviewQueueRequest(env, "/stats");
    if (url.pathname === "/api/status") return statusJson(request, env, ctx);
    if (url.pathname === "/api/triage") return triageJson(request, env, ctx);
    if (url.pathname === "/api/pr-proof-triage") return prProofTriageJson(request, env, ctx);
    if (url.pathname === "/" || url.pathname === "/index.html") return html(dashboardHtml(env));
    if (url.pathname === "/triage" || url.pathname === "/triage.html")
      return html(triageHtml(issueTriagePageConfig()));
    if (url.pathname === "/pr-proof-triage" || url.pathname === "/pr-proof-triage.html")
      return html(triageHtml(prProofTriagePageConfig()));
    return json({ error: "not_found" }, 404);
  },
};

async function statusJson(request, env, ctx) {
  const cache = caches.default;
  const cached = await cache.match(statusCacheRequest(request, "fresh"));
  if (cached) return cachedStatusResponse(cached, "fresh");

  const stale = await cache.match(statusCacheRequest(request, "stale"));
  if (stale && ctx?.waitUntil) {
    ctx.waitUntil(refreshStatus(request, env).catch(() => undefined));
    return cachedStatusResponse(stale, "stale");
  }

  const refreshed = await refreshStatus(request, env);
  if (refreshed.looksEmpty && stale) return cachedStatusResponse(stale, "stale");
  return cors(
    new Response(refreshed.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-clawsweeper-cache": "miss",
      },
    }),
  );
}

function cachedStatusResponse(cached, cacheState) {
  const headers = new Headers(cached.headers);
  headers.set("x-clawsweeper-cache", cacheState);
  if (cacheState === "stale") headers.set("cache-control", "no-store");
  return cors(new Response(cached.body, { status: cached.status, headers }));
}

function refreshStatus(request, env) {
  const key = [
    new URL(request.url).origin,
    env.CLAWSWEEPER_REPO || "openclaw/clawsweeper",
    env.TARGET_REPOS || "openclaw/openclaw",
    env.CLAWSWEEPER_STATE_REPO || CLAWSWEEPER_STATE_REPO,
    env.WORKER_BUDGET || "",
    env.WORKER_DETAIL_RUN_LIMIT || "",
    env.INCLUDE_CI_STATUS || "",
    env.CACHE_TTL_SECONDS || "",
    env.STALE_CACHE_TTL_SECONDS || "",
  ].join("|");
  if (statusRefresh?.key === key) return statusRefresh.promise;

  const promise = refreshStatusCaches(request, env);
  statusRefresh = { key, promise };
  promise
    .finally(() => {
      if (statusRefresh?.promise === promise) statusRefresh = null;
    })
    .catch(() => undefined);
  return promise;
}

async function refreshStatusCaches(request, env) {
  const ttl = numberFrom(env.CACHE_TTL_SECONDS, 20);
  const staleTtl = numberFrom(env.STALE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS);
  const snapshot = await statusSnapshot(env);
  const body = JSON.stringify(snapshot, null, 2);
  const hasErrors = Boolean(snapshot.diagnostics?.errors?.length);
  const looksEmpty =
    !snapshot.pipeline.length && snapshot.fleet.active_workflow_runs === 0 && hasErrors;
  if (!looksEmpty) {
    const writes = [
      caches.default.put(
        statusCacheRequest(request, "fresh"),
        new Response(body, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${ttl}`,
          },
        }),
      ),
      caches.default.put(
        statusCacheRequest(request, "stale"),
        new Response(body, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${staleTtl}`,
          },
        }),
      ),
    ];
    if (env.STATUS_STORE) writes.push(writeStatusStoreText(env.STATUS_STORE, "snapshot", body));
    await Promise.allSettled(writes);
  }
  return { snapshot, body, looksEmpty };
}

function statusCacheRequest(request, bucket) {
  return new Request(new URL(`/api/status-cache/${bucket}`, request.url).toString(), {
    method: "GET",
  });
}

async function triageJson(request, env, ctx) {
  const ttl = numberFrom(env.TRIAGE_CACHE_TTL_SECONDS, TRIAGE_CACHE_TTL_SECONDS);
  const staleTtl = numberFrom(env.STALE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS);
  const cache = caches.default;
  const cached = await cache.match(triageCacheRequest(request, "fresh"));
  if (cached) return cors(new Response(cached.body, cached));

  const snapshot = await triageSnapshot(env);
  const body = JSON.stringify(snapshot, null, 2);
  const looksEmpty = triageSnapshotLooksEmpty(snapshot);
  if (looksEmpty) {
    const stale = await cache.match(triageCacheRequest(request, "stale"));
    if (stale) return cors(new Response(stale.body, stale));
  }
  if (!looksEmpty) {
    const responseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
    };
    const staleResponseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${staleTtl}`,
    };
    ctx?.waitUntil?.(
      Promise.all([
        cache.put(
          triageCacheRequest(request, "fresh"),
          new Response(body, { headers: responseHeaders }),
        ),
        cache.put(
          triageCacheRequest(request, "stale"),
          new Response(body, { headers: staleResponseHeaders }),
        ),
      ]),
    );
  }
  return cors(
    new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function triageSnapshotLooksEmpty(snapshot) {
  const hasErrors = Boolean(snapshot.diagnostics?.errors?.length);
  const loadedItems = (snapshot.views || []).reduce(
    (total, view) => total + (Array.isArray(view.items) ? view.items.length : 0),
    0,
  );
  return !loadedItems && hasErrors;
}

function triageCacheRequest(request, bucket) {
  return new Request(new URL(`/api/triage-cache/v2/${bucket}`, request.url).toString(), {
    method: "GET",
  });
}

async function prProofTriageJson(request, env, ctx) {
  const ttl = numberFrom(env.PR_PROOF_TRIAGE_CACHE_TTL_SECONDS, TRIAGE_CACHE_TTL_SECONDS);
  const staleTtl = numberFrom(env.STALE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS);
  const cache = caches.default;
  const cached = await cache.match(prProofTriageCacheRequest(request, "fresh"));
  if (cached) return cors(new Response(cached.body, cached));

  const snapshot = await prProofTriageSnapshot(env);
  const body = JSON.stringify(snapshot, null, 2);
  const looksEmpty = triageSnapshotLooksEmpty(snapshot);
  if (looksEmpty) {
    const stale = await cache.match(prProofTriageCacheRequest(request, "stale"));
    if (stale) return cors(new Response(stale.body, stale));
  }
  if (!looksEmpty) {
    const responseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
    };
    const staleResponseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${staleTtl}`,
    };
    ctx?.waitUntil?.(
      Promise.all([
        cache.put(
          prProofTriageCacheRequest(request, "fresh"),
          new Response(body, { headers: responseHeaders }),
        ),
        cache.put(
          prProofTriageCacheRequest(request, "stale"),
          new Response(body, { headers: staleResponseHeaders }),
        ),
      ]),
    );
  }
  return cors(
    new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function prProofTriageCacheRequest(request, bucket) {
  return new Request(new URL(`/api/pr-proof-triage-cache/v1/${bucket}`, request.url).toString(), {
    method: "GET",
  });
}

async function ingestEvent(request, env) {
  const token = bearerToken(request);
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid_json" }, 400);
  const event = normalizeEvent(body);
  const writes = [
    prependStoredEvent(env, event),
    writeStoredJson(env, "latest-event", event, EVENT_STORE_TTL_SECONDS),
  ];
  const ci = normalizeCiStatus(body);
  if (ci) writes.push(writeCiStatus(env, ci));
  await Promise.all(writes);
  return json({ ok: true, event });
}

async function githubWebhook(request, env, ctx) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);

  const bodyText = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";
  const signatureOk = await verifyGithubWebhookSignature({ secret, signature, bodyText });
  if (!signatureOk) return json({ error: "invalid_signature" }, 401);

  const event = request.headers.get("x-github-event") || "";
  const payload = parseJsonObject(bodyText);
  if (!payload) return json({ error: "invalid_json" }, 400);
  if (event === "ping") {
    return json(
      {
        ok: true,
        event: "ping",
        delivery: request.headers.get("x-github-delivery") || null,
      },
      202,
    );
  }

  const decision = classifyGithubWebhook({ event, payload });
  if (!decision.accepted) {
    return json({ ok: true, accepted: false, reason: decision.reason }, 202);
  }

  if (decision.type === "item") {
    const deliveryId = request.headers.get("x-github-delivery") || "";
    const queued = await enqueueExactReview({
      env,
      deliveryId,
      decision: decision as ExactReviewDecision,
    });
    if (!queued) return json({ error: "exact_review_queue_not_configured" }, 503);
    return json({ ok: true, ...queued }, 202);
  }

  const credentials = githubAppCredentials(env);
  if (!credentials) return json({ error: "github_app_not_configured" }, 503);
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const dispatchToken = await createGithubAppTokenFor({
    appJwt,
    installationId: await githubAppInstallationId(appJwt, CLAWSWEEPER_REVIEW_REPO),
    label: CLAWSWEEPER_REVIEW_REPO,
    repositories: [repoName(CLAWSWEEPER_REVIEW_REPO)],
    permissions: { contents: "write" },
  });

  const commentDecision = decision as any;
  const targetToken = await createGithubAppTokenFor({
    appJwt,
    installationId: commentDecision.installationId,
    label: commentDecision.targetRepo,
    repositories: [repoName(commentDecision.targetRepo)],
    permissions: {
      issues: "write",
      pull_requests: "write",
    },
  });
  const statusCommentId = await createFastAckCommentOnce({
    token: targetToken,
    repo: commentDecision.targetRepo,
    itemNumber: commentDecision.itemNumber,
    sourceCommentId: commentDecision.commentId,
  });
  await addIssueCommentReaction({
    token: targetToken,
    repo: commentDecision.targetRepo,
    commentId: commentDecision.commentId,
    content: "eyes",
  });
  await dispatchClawsweeperComment({
    token: dispatchToken,
    decision: commentDecision,
    statusCommentId,
  });
  settleFastAckComments({
    token: targetToken,
    repo: commentDecision.targetRepo,
    itemNumber: commentDecision.itemNumber,
    sourceCommentId: commentDecision.commentId,
    delaysMs: fastAckSettleDelaysMs(env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS),
    waitUntil: ctx?.waitUntil?.bind(ctx),
  });
  return json({ ok: true, status_comment_id: statusCommentId }, 202);
}

function classifyGithubWebhook({ event, payload }) {
  const comment = classifyGithubIssueCommentWebhook({ event, payload });
  if (comment.accepted || comment.reason !== "not issue_comment") return comment;
  return classifyGithubItemWebhook({ event, payload });
}

function classifyGithubIssueCommentWebhook({ event, payload }) {
  if (event !== "issue_comment") return { accepted: false, reason: "not issue_comment" };
  const action = String(payload.action || "");
  if (!["created", "edited"].includes(action))
    return { accepted: false, reason: "unsupported action" };
  const comment = objectValue(payload.comment);
  const issue = objectValue(payload.issue);
  const repo = objectValue(payload.repository);
  const association = String(comment.author_association || "").toUpperCase();
  const commandText = commandTextForClawSweeperFastAck(String(comment.body || ""));
  if (!commandText) return { accepted: false, reason: "no routable ClawSweeper command" };
  if (
    !CLAWSWEEPER_ALLOWED_ASSOCIATIONS.has(association) &&
    !isAuthorReadOnlyGithubWebhookCommand({ comment, issue, commandText })
  ) {
    return {
      accepted: false,
      reason: `author association ${association || "unknown"} is not allowed`,
    };
  }
  const targetRepo = String(repo.full_name || "");
  const targetBranch = targetDefaultBranch(repo);
  if (!isEligibleGithubWebhookRepository(repo)) {
    return { accepted: false, reason: "repository not eligible" };
  }
  const itemNumber = Number(issue.number);
  const commentId = Number(comment.id);
  const installationId = Number(objectValue(payload.installation).id);
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
    return { accepted: false, reason: "missing issue number" };
  }
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return { accepted: false, reason: "missing comment id" };
  }
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return { accepted: false, reason: "missing installation id" };
  }
  return {
    accepted: true,
    type: "issue_comment",
    targetRepo,
    targetBranch,
    itemNumber,
    commentId,
    installationId,
    sourceAction: action,
  };
}

function classifyGithubItemWebhook({ event, payload }) {
  const action = String(payload.action || "");
  const repo = objectValue(payload.repository);
  if (!isEligibleGithubWebhookRepository(repo)) {
    return { accepted: false, reason: "repository not eligible" };
  }
  const targetRepo = String(repo.full_name || "");
  const targetBranch = targetDefaultBranch(repo);
  const installationId = Number(objectValue(payload.installation).id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return { accepted: false, reason: "missing installation id" };
  }

  if (event === "issues") {
    if (!CLAWSWEEPER_ISSUE_ITEM_ACTIONS.has(action)) {
      return { accepted: false, reason: "unsupported action" };
    }
    const itemNumber = Number(objectValue(payload.issue).number);
    if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
      return { accepted: false, reason: "missing issue number" };
    }
    return {
      accepted: true,
      type: "item",
      targetRepo,
      targetBranch,
      itemNumber,
      itemKind: "issue",
      installationId,
      sourceEvent: "issues",
      sourceAction: action,
      supersedesInProgress: action === "edited",
    };
  }

  if (event === "pull_request") {
    if (!CLAWSWEEPER_PULL_ITEM_ACTIONS.has(action)) {
      return { accepted: false, reason: "unsupported action" };
    }
    const itemNumber = Number(objectValue(payload.pull_request).number);
    if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
      return { accepted: false, reason: "missing pull request number" };
    }
    return {
      accepted: true,
      type: "item",
      targetRepo,
      targetBranch,
      itemNumber,
      itemKind: "pull_request",
      installationId,
      sourceEvent: "pull_request",
      sourceAction: action,
      supersedesInProgress: ["edited", "synchronize", "ready_for_review"].includes(action),
    };
  }

  return { accepted: false, reason: "unsupported event" };
}

function isEligibleGithubWebhookRepository(repo) {
  const targetRepo = String(repo.full_name || "").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(targetRepo)) return false;
  if (Boolean(repo.private) || Boolean(repo.archived) || Boolean(repo.fork)) return false;
  if (repo.has_issues === false) return false;
  if (CLAWSWEEPER_WEBHOOK_DENY_REPOS.has(targetRepo)) return false;
  const [owner] = targetRepo.split("/");
  return owner === "openclaw" || owner === "steipete";
}

function targetDefaultBranch(repo) {
  const branch = String(repo.default_branch || "main").trim() || "main";
  return /^[A-Za-z0-9_./-]+$/.test(branch) ? branch : "main";
}

function isClawsweeperGithubWebhookSender(sender) {
  const login = normalizedLogin(sender.login);
  return login === "clawsweeper[bot]" || login === "openclaw-clawsweeper[bot]";
}

function isAuthorReadOnlyGithubWebhookCommand({ comment, issue, commandText }) {
  if (!isClawSweeperReReviewCommandText(commandText)) return false;
  const commentAuthor = normalizedLogin(objectValue(comment.user).login);
  const issueAuthor = normalizedLogin(objectValue(issue.user).login);
  return Boolean(commentAuthor && issueAuthor && commentAuthor === issueAuthor);
}

function exactReviewQueueNamespace(env): DurableObjectNamespace | null {
  const namespace = env.EXACT_REVIEW_QUEUE as DurableObjectNamespace | undefined;
  if (
    !namespace ||
    typeof namespace.idFromName !== "function" ||
    typeof namespace.get !== "function"
  ) {
    return null;
  }
  return namespace;
}

function exactReviewQueueStub(env): DurableObjectStub | null {
  const namespace = exactReviewQueueNamespace(env);
  return namespace ? namespace.get(namespace.idFromName(EXACT_REVIEW_QUEUE_NAME)) : null;
}

async function exactReviewQueueRequest(env, path, request?: Request) {
  const queue = exactReviewQueueStub(env);
  if (!queue) return json({ error: "exact_review_queue_not_configured" }, 503);
  const body = request ? await request.text() : undefined;
  return queue.fetch(
    new Request(`https://clawsweeper-exact-review-queue${path}`, {
      method: request?.method || "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body,
    }),
  );
}

async function authenticatedExactReviewEnqueue(request, env) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  const body = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText: body }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  return exactReviewQueueRequest(
    env,
    "/enqueue",
    new Request("https://clawsweeper-exact-review-queue/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

async function enqueueExactReview({
  deliveryId,
  decision,
  env,
}: {
  deliveryId: string;
  decision: ExactReviewDecision;
  env: DashboardEnv;
}) {
  const queue = exactReviewQueueStub(env);
  if (!queue) return null;
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery_id: deliveryId, decision }),
    }),
  );
  const body = objectValue(await response.json().catch(() => null));
  if (!response.ok) throw new Error(String(body.error || "exact review queue rejected item"));
  return body;
}

function exactReviewDecisionFrom(value): ExactReviewDecision | null {
  const decision = objectValue(value);
  const targetRepo = String(decision.targetRepo || "").trim();
  const targetBranch = String(decision.targetBranch || "").trim();
  const itemNumber = Number(decision.itemNumber);
  const itemKind = String(decision.itemKind || "");
  const sourceEvent = String(decision.sourceEvent || "");
  const sourceAction = String(decision.sourceAction || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(targetBranch)) return null;
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  if (itemKind !== "issue" && itemKind !== "pull_request") return null;
  if (sourceEvent !== "issues" && sourceEvent !== "pull_request") return null;
  if (!sourceAction) return null;
  return {
    targetRepo,
    targetBranch,
    itemNumber,
    itemKind,
    sourceEvent,
    sourceAction,
    supersedesInProgress: Boolean(decision.supersedesInProgress),
    ...(Number.isFinite(Number(decision.codexTimeoutMs))
      ? { codexTimeoutMs: Number(decision.codexTimeoutMs) }
      : {}),
    ...(Number.isFinite(Number(decision.mediaProofTimeoutMs))
      ? { mediaProofTimeoutMs: Number(decision.mediaProofTimeoutMs) }
      : {}),
  };
}

function exactReviewItemKey(decision: ExactReviewDecision) {
  return `${decision.targetRepo}#${decision.itemNumber}`;
}

function isExactReviewQueueTargetEnabled(decision: ExactReviewDecision, env) {
  return (
    decision.targetRepo !== "openclaw/clawhub" ||
    String(env.CLAWSWEEPER_ENABLE_CLAWHUB || "") === "1"
  );
}

function exactReviewItemForLease(state: ExactReviewQueueState, leaseId: string) {
  return Object.values(state.items).find((item) => item.leaseId === leaseId) || null;
}

function clearExactReviewLease(item: ExactReviewQueueItem) {
  item.leaseId = undefined;
  item.leaseRevision = undefined;
  item.leaseExpiresAt = undefined;
  item.claimedRunId = undefined;
}

function isLiveExactReviewLease(item: ExactReviewQueueItem, now: number) {
  return Boolean(item.leaseId && item.leaseExpiresAt && item.leaseExpiresAt > now);
}

function reclaimExpiredExactReviewLeases(state: ExactReviewQueueState, now: number) {
  let changed = false;
  for (const item of Object.values(state.items)) {
    if (
      (item.state === "dispatching" || item.state === "leased") &&
      !isLiveExactReviewLease(item, now)
    ) {
      clearExactReviewLease(item);
      item.state = "pending";
      item.nextAttemptAt = now;
      item.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

function exactReviewQueueActiveCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) => item.state === "dispatching" || item.state === "leased",
  ).length;
}

function exactReviewQueueStats(
  state: ExactReviewQueueState,
  now = Date.now(),
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
) {
  const items = Object.values(state.items);
  const pending = items.filter((item) => item.state === "pending");
  const targets = new Map<
    string,
    {
      target_repo: string;
      pending: number;
      dispatching: number;
      leased: number;
      oldest_pending_at: number | null;
    }
  >();
  for (const item of items) {
    const targetRepo = item.decision.targetRepo;
    const current = targets.get(targetRepo) ?? {
      target_repo: targetRepo,
      pending: 0,
      dispatching: 0,
      leased: 0,
      oldest_pending_at: null,
    };
    if (item.state === "pending") {
      current.pending += 1;
      current.oldest_pending_at =
        current.oldest_pending_at === null
          ? item.createdAt
          : Math.min(current.oldest_pending_at, item.createdAt);
    } else if (item.state === "dispatching") {
      current.dispatching += 1;
    } else {
      current.leased += 1;
    }
    targets.set(targetRepo, current);
  }
  const targetStats = [...targets.values()]
    .map((target) => ({
      target_repo: target.target_repo,
      pending: target.pending,
      dispatching: target.dispatching,
      leased: target.leased,
      oldest_pending_at:
        target.oldest_pending_at === null ? null : new Date(target.oldest_pending_at).toISOString(),
    }))
    .sort(
      (left, right) =>
        right.pending - left.pending ||
        right.dispatching + right.leased - (left.dispatching + left.leased) ||
        left.target_repo.localeCompare(right.target_repo),
    );
  const nextWakeAt = exactReviewQueueNextWakeAt(state, now, capacity, targetCapacity);
  return {
    pending: pending.length,
    dispatching: items.filter((item) => item.state === "dispatching").length,
    leased: items.filter((item) => item.state === "leased").length,
    oldest_pending_at: pending.length
      ? new Date(Math.min(...pending.map((item) => item.createdAt))).toISOString()
      : null,
    oldest_pending_age_seconds: pending.length
      ? Math.max(0, Math.floor((now - Math.min(...pending.map((item) => item.createdAt))) / 1000))
      : null,
    next_wake_at: nextWakeAt === null ? null : new Date(nextWakeAt).toISOString(),
    target_stats: targetStats,
  };
}

function exactReviewQueueNextWakeAt(
  state: ExactReviewQueueState,
  now: number,
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
) {
  const items = Object.values(state.items);
  if (!items.length) return null;
  const activeItems = items.filter(
    (item) => item.state === "dispatching" || item.state === "leased",
  );
  const activeLeaseWakeAt = activeItems
    .map((item) => item.leaseExpiresAt)
    .filter((value): value is number => Boolean(value && value > now));
  if (activeItems.some((item) => !item.leaseExpiresAt || item.leaseExpiresAt <= now)) {
    return now + 1_000;
  }
  if (activeItems.length >= capacity && activeLeaseWakeAt.length) {
    return Math.max(now + 1_000, Math.min(...activeLeaseWakeAt));
  }
  const activeTargetWakeAt = new Map<string, number>();
  const activeTargetCounts = new Map<string, number>();
  for (const item of items) {
    if (
      (item.state === "dispatching" || item.state === "leased") &&
      item.leaseExpiresAt &&
      item.leaseExpiresAt > now
    ) {
      const target = item.decision.targetRepo;
      activeTargetCounts.set(target, (activeTargetCounts.get(target) || 0) + 1);
      const current = activeTargetWakeAt.get(item.decision.targetRepo);
      activeTargetWakeAt.set(
        target,
        current === undefined ? item.leaseExpiresAt : Math.min(current, item.leaseExpiresAt),
      );
    }
  }
  const times = items.flatMap((item) => {
    if (item.state === "pending") {
      const target = item.decision.targetRepo;
      const blockedUntil =
        (activeTargetCounts.get(target) || 0) >= targetCapacity
          ? activeTargetWakeAt.get(target)
          : undefined;
      return [blockedUntil ?? item.nextAttemptAt];
    }
    return item.leaseExpiresAt ? [item.leaseExpiresAt] : [];
  });
  if (!times.length) return now + DEFAULT_EXACT_REVIEW_RETRY_MS;
  return Math.max(now + 1_000, Math.min(...times));
}

function pruneExactReviewDeliveries(state: ExactReviewQueueState, now: number) {
  for (const [deliveryId, receivedAt] of Object.entries(state.deliveries)) {
    if (!Number.isFinite(receivedAt) || receivedAt + EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS <= now) {
      delete state.deliveries[deliveryId];
    }
  }
}

export function exactReviewQueueCapacity(env) {
  return Math.max(
    1,
    Math.min(
      32,
      numberFrom(env.EXACT_REVIEW_QUEUE_MAX_CONCURRENT, DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT),
    ),
  );
}

function exactReviewTargetCapacity(env) {
  return Math.max(
    1,
    Math.min(
      exactReviewQueueCapacity(env),
      numberFrom(
        env.EXACT_REVIEW_TARGET_MAX_CONCURRENT,
        DEFAULT_EXACT_REVIEW_TARGET_MAX_CONCURRENT,
      ),
    ),
  );
}

function exactReviewDispatchLeaseMs(env) {
  return Math.max(
    60_000,
    numberFrom(env.EXACT_REVIEW_DISPATCH_LEASE_MS, DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS),
  );
}

function exactReviewExecutionLeaseMs(env) {
  return Math.max(
    60_000,
    numberFrom(env.EXACT_REVIEW_EXECUTION_LEASE_MS, DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS),
  );
}

function exactReviewRetryDelayMs(attempt: number) {
  return Math.min(5 * 60_000, DEFAULT_EXACT_REVIEW_RETRY_MS * 2 ** Math.min(attempt - 1, 4));
}

async function exactReviewDispatchToken(env) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId = await githubAppInstallationId(appJwt, CLAWSWEEPER_REVIEW_REPO);
  return createGithubAppTokenFor({
    appJwt,
    installationId,
    label: CLAWSWEEPER_REVIEW_REPO,
    repositories: [repoName(CLAWSWEEPER_REVIEW_REPO)],
    permissions: { contents: "write" },
  });
}

async function createGithubAppTokenFor({
  appJwt,
  installationId,
  label,
  repositories,
  permissions,
}) {
  const payload = await githubAppJson(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: "POST",
      body: JSON.stringify({
        repository_names: repositories.filter(Boolean),
        permissions,
      }),
      errorLabel: `GitHub App token for ${label}`,
    },
  );
  const token = String(payload.token || "");
  if (!token) throw new Error(`GitHub App token response missing token for ${label}`);
  return token;
}

async function createFastAckComment({ token, repo, itemNumber, sourceCommentId }) {
  const existingId = await pruneFastAckComments({ token, repo, itemNumber, sourceCommentId });
  if (existingId) return existingId;
  const payload = await githubTokenJson({
    token,
    path: `/repos/${repo}/issues/${itemNumber}/comments`,
    method: "POST",
    body: { body: renderFastAckComment(sourceCommentId) },
    errorLabel: "ClawSweeper ack comment",
  });
  return (
    (await pruneFastAckComments({ token, repo, itemNumber, sourceCommentId })) ||
    Number(payload.id) ||
    null
  );
}

function settleFastAckComments({
  token,
  repo,
  itemNumber,
  sourceCommentId,
  delaysMs = DEFAULT_FAST_ACK_SETTLE_DELAYS_MS,
  waitUntil,
}) {
  const cleanup = async () => {
    for (const delayMs of delaysMs) {
      await sleep(delayMs);
      await pruneFastAckComments({ token, repo, itemNumber, sourceCommentId });
    }
  };
  const promise = cleanup().catch((error) => {
    console.error(`ClawSweeper fast ack cleanup failed: ${error?.message || error}`);
  });
  if (waitUntil) waitUntil(promise);
}

function fastAckSettleDelaysMs(value) {
  const delays = String(value || "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((delay) => Number.isFinite(delay) && delay >= 0);
  return delays.length > 0 ? delays : DEFAULT_FAST_ACK_SETTLE_DELAYS_MS;
}

async function createFastAckCommentOnce({ token, repo, itemNumber, sourceCommentId }) {
  const key = fastAckKey({ repo, itemNumber, sourceCommentId });
  const pending = inFlightFastAcks.get(key);
  if (pending) return pending;
  const next = createFastAckComment({ token, repo, itemNumber, sourceCommentId }).finally(() => {
    inFlightFastAcks.delete(key);
  });
  inFlightFastAcks.set(key, next);
  return next;
}

function fastAckKey({ repo, itemNumber, sourceCommentId }) {
  return `${String(repo).toLowerCase()}:${itemNumber}:${sourceCommentId}`;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function pruneFastAckComments({ token, repo, itemNumber, sourceCommentId }) {
  const comments = await listFastAckComments({ token, repo, itemNumber, sourceCommentId });
  if (!comments.length) return null;
  const hasStatusComment = comments.some(isStatusBearingFastAckComment);
  comments.sort(compareFastAckKeepPriority);
  const keepId = Number(objectValue(comments[0]).id) || null;
  for (const comment of comments) {
    const id = Number(objectValue(comment).id) || 0;
    if (id <= 0 || id === keepId) continue;
    if (hasStatusComment && isStatusBearingFastAckComment(comment)) continue;
    await githubTokenJson({
      token,
      path: `/repos/${repo}/issues/comments/${id}`,
      method: "DELETE",
      body: undefined,
      errorLabel: "ClawSweeper duplicate ack cleanup",
    }).catch((error) => {
      if (!String(error?.message || "").includes("404")) throw error;
      return null;
    });
  }
  return keepId;
}

function compareFastAckKeepPriority(left, right) {
  const leftStatus = isStatusBearingFastAckComment(left) ? 1 : 0;
  const rightStatus = isStatusBearingFastAckComment(right) ? 1 : 0;
  if (leftStatus !== rightStatus) return rightStatus - leftStatus;
  if (leftStatus > 0) return compareCommentsByUpdatedAtDesc(left, right);
  return compareCommentsByCreatedAt(left, right);
}

function isStatusBearingFastAckComment(comment) {
  const body = String(objectValue(comment).body || "");
  return (
    body.includes("clawsweeper-command-status:") ||
    body.includes("<!-- clawsweeper-command-progress:start -->")
  );
}

function compareCommentsByUpdatedAtDesc(left, right) {
  const leftUpdated = String(objectValue(left).updated_at || objectValue(left).created_at || "");
  const rightUpdated = String(objectValue(right).updated_at || objectValue(right).created_at || "");
  return (
    rightUpdated.localeCompare(leftUpdated) ||
    (Number(objectValue(right).id) || 0) - (Number(objectValue(left).id) || 0)
  );
}

function compareCommentsByCreatedAt(left, right) {
  const leftCreated = String(objectValue(left).created_at || "");
  const rightCreated = String(objectValue(right).created_at || "");
  return (
    leftCreated.localeCompare(rightCreated) ||
    (Number(objectValue(left).id) || 0) - (Number(objectValue(right).id) || 0)
  );
}

async function listFastAckComments({ token, repo, itemNumber, sourceCommentId }) {
  const comments = [];
  const marker = fastAckMarker(sourceCommentId);
  const since = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  for (let page = 1; page <= 5; page += 1) {
    const payload = await githubTokenJson({
      token,
      path: `/repos/${repo}/issues/${itemNumber}/comments?per_page=100&page=${page}&since=${since}`,
      method: "GET",
      body: undefined,
      errorLabel: "ClawSweeper ack comment lookup",
    });
    if (!Array.isArray(payload)) return comments;
    for (const comment of payload) {
      if (
        String(objectValue(comment).body || "").includes(marker) &&
        isClawsweeperGithubWebhookSender(objectValue(objectValue(comment).user))
      ) {
        comments.push(comment);
      }
    }
    if (payload.length < 100) return comments;
  }
  return comments;
}

function renderFastAckComment(sourceCommentId) {
  return [
    fastAckMarker(sourceCommentId),
    "🦞👀",
    "ClawSweeper picked this up.",
    "",
    "Command router queued. I will update this comment with the next step.",
  ].join("\n");
}

function fastAckMarker(sourceCommentId) {
  return `<!-- clawsweeper-command-ack:${sourceCommentId} -->`;
}

async function addIssueCommentReaction({ token, repo, commentId, content }) {
  await githubTokenJson({
    token,
    path: `/repos/${repo}/issues/comments/${commentId}/reactions`,
    method: "POST",
    body: { content },
    errorLabel: "ClawSweeper comment reaction",
  }).catch((error) => {
    if (!String(error.message || "").includes("422")) throw error;
    return null;
  });
}

async function dispatchClawsweeperItem({
  token,
  decision,
  leaseId,
}: {
  token: string;
  decision: ExactReviewDecision;
  leaseId?: string;
}) {
  await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/dispatches`,
    method: "POST",
    body: {
      event_type: "clawsweeper_item",
      client_payload: {
        target_repo: decision.targetRepo,
        target_branch: decision.targetBranch,
        item_number: decision.itemNumber,
        item_kind: decision.itemKind,
        source_event: decision.sourceEvent,
        source_action: decision.sourceAction,
        supersedes_in_progress: decision.supersedesInProgress,
        ...(leaseId ? { queue_lease_id: leaseId } : {}),
        ...(decision.codexTimeoutMs ? { codex_timeout_ms: decision.codexTimeoutMs } : {}),
        ...(decision.mediaProofTimeoutMs
          ? { media_proof_timeout_ms: decision.mediaProofTimeoutMs }
          : {}),
      },
    },
    errorLabel: "ClawSweeper item dispatch",
  });
}

async function dispatchClawsweeperComment({ token, decision, statusCommentId }) {
  await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/dispatches`,
    method: "POST",
    body: {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: decision.targetRepo,
        target_branch: decision.targetBranch,
        item_number: decision.itemNumber,
        comment_id: decision.commentId,
        status_comment_id: statusCommentId,
        source_event: "issue_comment",
        source_action: decision.sourceAction,
        max_comments: "1",
      },
    },
    errorLabel: "ClawSweeper comment dispatch",
  });
}

async function githubTokenJson({ token, path, method = "GET", body, errorLabel }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const init: RequestInit = {
    method,
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-webhook",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`https://api.github.com${path}`, init).finally(() =>
    clearTimeout(timeout),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${errorLabel || "GitHub"} ${response.status}${text ? `: ${text.slice(0, 240)}` : ""}`,
    );
  }
  if (response.status === 204) return {};
  return response.json();
}

async function verifyGithubWebhookSignature({ secret, signature, bodyText }) {
  const actual = String(signature || "");
  if (!actual.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const expected = `sha256=${hexEncode(new Uint8Array(digest))}`;
  return constantTimeEqual(expected, actual);
}

function parseJsonObject(text) {
  let value;
  try {
    value = JSON.parse(text || "null");
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedLogin(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function repoName(repo) {
  return String(repo || "").split("/")[1] || "";
}

function hexEncode(bytes) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    result += bytes[index].toString(16).padStart(2, "0");
  }
  return result;
}

function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(String(left));
  const rightBytes = new TextEncoder().encode(String(right));
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return diff === 0;
}

async function statusSnapshot(env) {
  const ttl = numberFrom(env.CACHE_TTL_SECONDS, 20);
  const cached = await readCachedSnapshot(env, ttl);
  if (cached) return cached;

  const generatedAt = new Date().toISOString();
  const errors = [];
  const repo = env.CLAWSWEEPER_REPO || "openclaw/clawsweeper";
  const targetRepos = String(env.TARGET_REPOS || "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const budget = numberFrom(env.WORKER_BUDGET, 32);
  const [runs, completedRuns, filteredActiveRuns] = await Promise.all([
    githubJson(env, `/repos/${repo}/actions/runs?per_page=100`).catch((error) => {
      errors.push(`workflow runs: ${error.message}`);
      return null;
    }),
    githubJson(env, `/repos/${repo}/actions/runs?status=completed&per_page=100`).catch((error) => {
      errors.push(`workflow runs completed: ${error.message}`);
      return null;
    }),
    activeWorkflowRuns(env, repo, errors),
  ]);
  const workflowRuns = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  const completedWorkflowRuns = uniqueWorkflowRuns([
    ...(Array.isArray(completedRuns?.workflow_runs) ? completedRuns.workflow_runs : []),
    ...workflowRuns.filter((run) => run.status === "completed"),
  ]).sort(newestWorkflowRunFirst);
  const activeRuns = uniqueWorkflowRuns([
    ...filteredActiveRuns,
    ...workflowRuns.filter((run) => isActiveWorkflowRun(run)),
  ]).sort(newestWorkflowRunFirst);
  const workerRuns = activeRuns.filter((run) => !isSupportWorkflowRun(run));
  const supportRuns = activeRuns.filter((run) => isSupportWorkflowRun(run));
  const failedRuns = completedWorkflowRuns.filter(
    (run) =>
      run.status === "completed" &&
      !isSupportWorkflowRun(run) &&
      codexJobName(`${run.name || ""} ${run.display_title || ""}`) &&
      TERMINAL_BAD_CONCLUSIONS.has(String(run.conclusion)),
  );
  const activeJobs = await activeWorkerSnapshot(env, repo, workerRuns);
  const [workerHealth, pipeline, clusterRepair, automerge, closed, storedEvents] =
    await Promise.all([
      withTimeout(
        recentWorkerHealth(env, repo, completedWorkflowRuns),
        OPTIONAL_SECTION_TIMEOUT_MS * 2,
        "worker health",
      ).catch((error) => {
        errors.push(error.message);
        return emptyWorkerHealth(generatedAt);
      }),
      withTimeout(
        pipelineItems(env, workerRuns.slice(0, 30)),
        OPTIONAL_SECTION_TIMEOUT_MS,
        "pipeline",
      ).catch((error) => {
        errors.push(error.message);
        return workerRuns.slice(0, 30).map((run) => classifyRun(run));
      }),
      withTimeout(
        clusterRepairStatus(env, repo, targetRepos, activeRuns),
        OPTIONAL_SECTION_TIMEOUT_MS,
        "cluster repair intake",
      ).catch((error) => {
        errors.push(error.message);
        return emptyClusterRepairStatus(targetRepos);
      }),
      withTimeout(
        recentAutomerge(env, targetRepos[0] || "openclaw/openclaw"),
        OPTIONAL_SECTION_TIMEOUT_MS,
        "automerge timing",
      ).catch((error) => {
        errors.push(error.message);
        return { average_ms: null, samples: 0, items: [] };
      }),
      withTimeout(
        recentClawsweeperClosed(env, targetRepos),
        OPTIONAL_SECTION_TIMEOUT_MS,
        "recent closed",
      ).catch((error) => {
        errors.push(error.message);
        return { items: [], stats: emptyClosedStats(generatedAt) };
      }),
      readEvents(env).catch((error) => {
        errors.push(`events: ${error.message}`);
        return [];
      }),
    ]);
  errors.push(...activeJobs.errors);
  errors.push(...workerHealth.errors);

  const snapshot = {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      clawsweeper_repo: repo,
      target_repositories: targetRepos,
    },
    fleet: {
      worker_budget: budget,
      active_workflow_runs: workerRuns.length,
      queued_workflow_runs: workerRuns.filter((run) => run.status !== "in_progress").length,
      support_workflow_runs: supportRuns.length,
      support_queued_workflow_runs: supportRuns.filter((run) => run.status !== "in_progress")
        .length,
      active_codex_jobs: activeJobs.count,
      failed_recent_runs: failedRuns.length,
      budget_used_percent: budget > 0 ? Math.round((activeJobs.count / budget) * 100) : 0,
      worker_detail_runs: activeJobs.detailRuns,
      worker_detail_fallbacks: activeJobs.fallbacks,
    },
    health: workerHealth,
    averages: {
      automerge_command_to_merge_ms: automerge.average_ms,
      automerge_samples: automerge.samples,
    },
    workers: activeJobs.workers,
    automatic_work: automaticIssueWork(storedEvents, activeJobs.workers),
    pipeline,
    recent: {
      cluster_repair: clusterRepair,
      automerge: automerge.items,
      closed_items: closed.items,
      closed_stats: closed.stats,
      operation_counts: operationEventCounts(storedEvents),
      events: recentActivityEvents(storedEvents, closed.items),
      failed_runs: failedRuns.slice(0, 10).map((run) => workflowRunSummary(run)),
    },
    diagnostics: {
      active_job_sample: activeJobs.sample,
      github_rate: activeJobs.rate,
      errors: errors.slice(0, 20),
    },
  };
  return snapshot;
}

async function triageSnapshot(env) {
  const generatedAt = new Date().toISOString();
  const errors = [];
  const repos = triageTargetRepos(env);
  const searchBudget = { remaining: triageSearchRequestBudget(env) };
  const itemLimit = triageItemsPerView(env, repos.length, searchBudget.remaining);
  const repoSnapshots = [];
  for (let index = 0; index < repos.length; index += 1) {
    const repo = repos[index];
    if (searchBudget.remaining < 1) {
      errors.push(`${repo} triage skipped: search budget exhausted before broad snapshot`);
      repoSnapshots.push(emptyTriageRepoSnapshot(repo));
      continue;
    }
    repoSnapshots.push(
      await triageSnapshotForRepo(
        env,
        repo,
        errors,
        itemLimit,
        searchBudget,
        repos.length - index - 1,
      ),
    );
  }
  const views = mergeTriageRepoViews(repoSnapshots, itemLimit);
  await attachTriageLinkedPullRequests(env, views, errors);
  attachTriageRoutingGroupCounts(views);
  const counts = Object.fromEntries(views.map((view) => [view.id, view.total_count]));
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      target_repositories: repos,
      label_prefix: TRIAGE_LABEL_PREFIX,
      item_limit_per_view: itemLimit,
      search_request_budget_remaining: searchBudget.remaining,
    },
    counts,
    routing_groups: TRIAGE_ROUTING_GROUPS,
    views,
    diagnostics: {
      errors: errors.slice(0, 20),
    },
  };
}

async function prProofTriageSnapshot(env) {
  const generatedAt = new Date().toISOString();
  const errors = [];
  const repos = prProofTargetRepos(env);
  const itemLimit = prProofItemsPerView(env);
  const repoSnapshots = await Promise.all(
    repos.map((repo) => prProofSnapshotForRepo(env, repo, errors, itemLimit)),
  );
  const views = mergePrProofRepoViews(repoSnapshots, itemLimit);
  const counts = Object.fromEntries(views.map((view) => [view.id, view.total_count]));
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      target_repositories: repos,
      labels: PR_PROOF_LABEL_NAMES,
      item_limit_per_view: itemLimit,
    },
    counts,
    views,
    diagnostics: {
      errors: errors.slice(0, 20),
    },
  };
}

function attachTriageRoutingGroupCounts(views) {
  for (const view of views) {
    view.loaded_routing_group_counts = Object.fromEntries(
      TRIAGE_ROUTING_GROUPS.map((group) => [
        group.id,
        (view.items || []).filter((item) =>
          (item.routing_groups || []).some((candidate) => candidate.id === group.id),
        ).length,
      ]),
    );
  }
}

async function attachTriageLinkedPullRequests(env, views, errors) {
  const allItems = allTriageItems(views);
  for (const item of allItems) item.linked_pull_requests = [];
  const items = uniqueTriageItems(views);
  if (!items.length) return;
  if (!hasGithubAuth(env)) {
    errors.push(
      "linked pull requests: GITHUB_TOKEN or ClawSweeper GitHub App credentials are required for GraphQL enrichment",
    );
    return;
  }
  const limitedItems = items.slice(0, TRIAGE_LINKED_PR_ITEM_LIMIT);
  if (items.length > limitedItems.length) {
    errors.push(
      `linked pull requests: limited to ${limitedItems.length} of ${items.length} loaded issues`,
    );
  }
  const byRepo = new Map();
  for (const item of limitedItems) {
    const bucket = byRepo.get(item.repository) || [];
    bucket.push(item);
    byRepo.set(item.repository, bucket);
  }
  await Promise.all(
    [...byRepo.entries()].map(async ([repo, repoItems]) => {
      for (let index = 0; index < repoItems.length; index += TRIAGE_LINKED_PR_BATCH_SIZE) {
        const batch = repoItems.slice(index, index + TRIAGE_LINKED_PR_BATCH_SIZE);
        await attachTriageLinkedPullRequestBatch(env, repo, batch).catch((error) => {
          errors.push(`${repo} linked pull requests: ${error.message}`);
        });
      }
    }),
  );
  syncLinkedPullRequestsToDuplicateItems(views, limitedItems);
}

function allTriageItems(views) {
  return views.flatMap((view) => view.items || []);
}

function syncLinkedPullRequestsToDuplicateItems(views, linkedItems) {
  const linkedByKey = new Map(
    linkedItems.map((item) => [triageItemKey(item), item.linked_pull_requests || []]),
  );
  for (const item of allTriageItems(views)) {
    if (triageItemHasLabel(item, "clawsweeper:linked-pr-open")) {
      item.linked_pull_requests = linkedByKey.get(triageItemKey(item)) || [];
    }
  }
}

function triageItemKey(item) {
  return `${item.repository}#${item.number}`;
}

function uniqueTriageItems(views) {
  const seen = new Map();
  for (const view of views) {
    for (const item of view.items || []) {
      const key = triageItemKey(item);
      if (!seen.has(key) && triageItemHasLabel(item, "clawsweeper:linked-pr-open")) {
        seen.set(key, item);
      }
    }
  }
  return [...seen.values()].sort(newestTriageCreatedFirst);
}

function triageItemHasLabel(item, labelName) {
  return (item.labels || []).some(
    (label) => String(label.name || "").toLowerCase() === labelName.toLowerCase(),
  );
}

async function attachTriageLinkedPullRequestBatch(env, repo, items) {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !items.length) return;
  const aliases = items
    .map(
      (item, index) => `
        issue${index}: issue(number: ${Number(item.number)}) {
          timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
            nodes {
              __typename
              ... on CrossReferencedEvent {
                willCloseTarget
                source {
                  __typename
                  ... on PullRequest {
                    number
                    title
                    url
                    state
                    repository { nameWithOwner }
                  }
                }
              }
              ... on ConnectedEvent {
                subject {
                  __typename
                  ... on PullRequest {
                    number
                    title
                    url
                    state
                    repository { nameWithOwner }
                  }
                }
              }
            }
          }
        }`,
    )
    .join("\n");
  const data = await githubGraphql(
    env,
    `query TriageLinkedPullRequests($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${aliases}
      }
    }`,
    { owner, name },
  );
  const repository = data?.repository || {};
  for (let index = 0; index < items.length; index += 1) {
    items[index].linked_pull_requests = linkedPullRequestsFromTimeline(
      repository[`issue${index}`]?.timelineItems?.nodes || [],
    );
  }
}

function linkedPullRequestsFromTimeline(nodes) {
  const prs = new Map();
  for (const node of nodes || []) {
    const source =
      node?.source?.__typename === "PullRequest"
        ? node.source
        : node?.subject?.__typename === "PullRequest"
          ? node.subject
          : null;
    if (!source?.url || !source?.number) continue;
    const repository = source.repository?.nameWithOwner || "";
    const key = `${repository}#${source.number}`;
    prs.set(key, {
      repository,
      number: source.number,
      title: source.title || "",
      url: source.url,
      state: normalizePullRequestState(source.state),
      will_close: Boolean(node.willCloseTarget),
    });
  }
  return [...prs.values()].sort(compareLinkedPullRequests);
}

function compareLinkedPullRequests(left, right) {
  const stateRank = { open: 0, merged: 1, closed: 2 };
  const leftRank = stateRank[left.state] ?? 9;
  const rightRank = stateRank[right.state] ?? 9;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Number(right.number || 0) - Number(left.number || 0);
}

function normalizePullRequestState(state) {
  const text = String(state || "").toLowerCase();
  if (text === "merged") return "merged";
  if (text === "closed") return "closed";
  if (text === "open") return "open";
  return "unknown";
}

function emptyTriageRepoSnapshot(repo) {
  return {
    repository: repo,
    labels: [],
    views: TRIAGE_VIEWS.map((view) => ({
      id: view.id,
      repository: repo,
      title: view.title,
      description: view.description,
      query: null,
      github_url: null,
      total_count: 0,
      items: [],
    })),
  };
}

async function triageSnapshotForRepo(
  env,
  repo,
  errors,
  itemLimit,
  searchBudget,
  remainingRepoCount,
) {
  const repoLabels = await repoClawsweeperLabels(env, repo).catch((error) => {
    errors.push(`${repo} labels: ${error.message}`);
    return [];
  });
  const discoveredLabels = repoLabels.map((label) => label.name);
  const rootView = await triageViewForRepo(
    env,
    repo,
    TRIAGE_VIEWS[0],
    discoveredLabels,
    errors,
    itemLimit,
  );
  if (rootView.query) {
    searchBudget.remaining -= rootView.search_failed
      ? triageSearchPageCount(itemLimit, itemLimit)
      : triageSearchPageCount(itemLimit, rootView.total_count);
  }
  const rootIsComplete = rootView.total_count <= rootView.items.length;
  const fallbackItemLimit = Math.min(itemLimit, TRIAGE_FOCUSED_FALLBACK_ITEMS_PER_VIEW);
  const reservedRootSearches = remainingRepoCount * triageSearchPageCount(itemLimit, itemLimit);
  const focusedViews = [];
  let budgetExhausted = false;
  for (const view of TRIAGE_VIEWS.slice(1)) {
    if (rootIsComplete) {
      focusedViews.push(
        triageViewFromItems(repo, view, discoveredLabels, rootView.items, itemLimit),
      );
      continue;
    }
    const query = triageSearchQuery(repo, view, discoveredLabels);
    if (query && searchBudget.remaining - reservedRootSearches >= 1) {
      searchBudget.remaining -= triageSearchPageCount(fallbackItemLimit, fallbackItemLimit);
      focusedViews.push(
        await triageViewForRepo(
          env,
          repo,
          view,
          discoveredLabels,
          errors,
          fallbackItemLimit,
          rootView.items,
          itemLimit,
        ),
      );
      continue;
    }
    if (query) budgetExhausted = true;
    focusedViews.push(triageViewFromItems(repo, view, discoveredLabels, rootView.items, itemLimit));
  }
  if (budgetExhausted) {
    errors.push(
      `${repo} focused triage fallback: search budget exhausted; using loaded broad rows`,
    );
  }
  const views = [rootView, ...focusedViews];
  return {
    repository: repo,
    labels: repoLabels,
    views,
  };
}

async function prProofSnapshotForRepo(env, repo, errors, itemLimit) {
  const repoLabels = await repoProofLabels(env, repo).catch((error) => {
    errors.push(`${repo} proof labels: ${error.message}`);
    return [];
  });
  const discoveredLabels = repoLabels.map((label) => label.name);
  const views = [];
  for (const view of PR_PROOF_VIEWS) {
    views.push(await prProofViewForRepo(env, repo, view, discoveredLabels, errors, itemLimit));
  }
  return {
    repository: repo,
    labels: repoLabels,
    views,
  };
}

function triageViewFromItems(repo, definition, discoveredLabels, sourceItems, itemLimit) {
  const query = triageSearchQuery(repo, definition, discoveredLabels);
  if (!query) {
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query: null,
      github_url: null,
      item_limit: itemLimit,
      total_count: 0,
      items: [],
    };
  }
  const items = (sourceItems || [])
    .filter((item) => triageItemMatchesView(item, definition, discoveredLabels))
    .sort(newestTriageCreatedFirst)
    .slice(0, itemLimit);
  return {
    id: definition.id,
    repository: repo,
    title: definition.title,
    description: definition.description,
    query,
    github_url: githubSearchUrl(query),
    item_limit: itemLimit,
    total_count: items.length,
    items,
  };
}

function triageItemMatchesView(item, definition, discoveredLabels) {
  return labeledItemMatchesView(item, definition, discoveredLabels);
}

function labeledItemMatchesView(item, definition, discoveredLabels) {
  const labels = new Set((item.labels || []).map((label) => label.name.toLowerCase()));
  const available = new Set(discoveredLabels.map((label) => label.toLowerCase()));
  const allLabels = (definition.allLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  const withoutLabels = (definition.withoutLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  let anyLabels = [];
  if (definition.anyLabels === "discovered") {
    anyLabels = discoveredLabels;
  } else {
    anyLabels = (definition.anyLabels || []).filter((label) => available.has(label.toLowerCase()));
  }
  if ((definition.allLabels || []).length && allLabels.length !== definition.allLabels.length) {
    return false;
  }
  if (definition.anyLabels && anyLabels.length === 0) return false;
  if (allLabels.some((label) => !labels.has(label.toLowerCase()))) return false;
  if (withoutLabels.some((label) => labels.has(label.toLowerCase()))) return false;
  if (anyLabels.length && !anyLabels.some((label) => labels.has(label.toLowerCase()))) {
    return false;
  }
  return true;
}

function triageItemsPerView(env, repoCount = 1, searchBudget = triageSearchRequestBudget(env)) {
  const configured = Math.min(
    MAX_TRIAGE_ITEMS_PER_VIEW,
    Math.max(1, numberFrom(env.TRIAGE_ITEMS_PER_VIEW, DEFAULT_TRIAGE_ITEMS_PER_VIEW)),
  );
  const rootPagesPerRepo = Math.max(
    1,
    Math.floor(Math.max(1, searchBudget - 1) / Math.max(1, repoCount)),
  );
  return Math.min(configured, rootPagesPerRepo * TRIAGE_SEARCH_PAGE_SIZE);
}

function triageSearchRequestBudget(env) {
  return hasGithubAuth(env) ? 28 : 9;
}

function triageSearchPageCount(limit, totalCount) {
  return Math.ceil(Math.min(limit, Math.max(1, Number(totalCount || 0))) / TRIAGE_SEARCH_PAGE_SIZE);
}

function prProofItemsPerView(env) {
  return Math.min(
    MAX_TRIAGE_ITEMS_PER_VIEW,
    Math.max(1, numberFrom(env.PR_PROOF_ITEMS_PER_VIEW, DEFAULT_PR_PROOF_ITEMS_PER_VIEW)),
  );
}

function mergeTriageRepoViews(repoSnapshots, itemLimit) {
  return TRIAGE_VIEWS.map((definition) => {
    const repoViews = repoSnapshots.map((repo) =>
      repo.views.find((view) => view.id === definition.id),
    );
    const items = repoViews
      .flatMap((view) => view?.items || [])
      .sort(newestTriageCreatedFirst)
      .slice(0, itemLimit);
    const totalCount = repoViews.reduce((total, view) => total + (view?.total_count || 0), 0);
    const combinedQuery = combinedTriageSearchQuery(repoSnapshots, definition, repoViews);
    const viewItemLimit =
      Math.max(...repoViews.map((view) => view?.item_limit || 0).filter(Boolean)) || itemLimit;
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      total_count: totalCount,
      query: combinedQuery,
      github_url: combinedQuery ? githubSearchUrl(combinedQuery) : null,
      item_limit: viewItemLimit,
      items,
    };
  });
}

function mergePrProofRepoViews(repoSnapshots, itemLimit) {
  return PR_PROOF_VIEWS.map((definition) => {
    const repoViews = repoSnapshots.map((repo) =>
      repo.views.find((view) => view.id === definition.id),
    );
    const items = repoViews
      .flatMap((view) => view?.items || [])
      .sort(newestTriageCreatedFirst)
      .slice(0, itemLimit);
    const totalCount = repoViews.reduce((total, view) => total + (view?.total_count || 0), 0);
    const combinedQuery = combinedPrProofSearchQuery(repoSnapshots, definition, repoViews);
    const viewItemLimit =
      Math.max(...repoViews.map((view) => view?.item_limit || 0).filter(Boolean)) || itemLimit;
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      total_count: totalCount,
      query: combinedQuery,
      github_url: combinedQuery ? githubSearchUrl(combinedQuery) : null,
      item_limit: viewItemLimit,
      items,
    };
  });
}

function combinedTriageSearchQuery(repoSnapshots, definition, repoViews) {
  const repos = repoViews
    .filter((view) => view?.query)
    .map((view) => view.repository)
    .filter(Boolean);
  if (!repos.length) return null;
  const parts = [...repos.map((repo) => `repo:${repo}`), "is:issue", "is:open"];
  if (definition.anyLabels === "discovered") {
    const labels = [
      ...new Set(
        repoSnapshots
          .filter((repo) => repos.includes(repo.repository))
          .flatMap((repo) => repo.labels.map((label) => label.name)),
      ),
    ].sort();
    if (!labels.length) return null;
    parts.push(`label:${labels.map(quoteSearchValue).join(",")}`);
  } else if (definition.anyLabels?.length) {
    parts.push(`label:${definition.anyLabels.map(quoteSearchValue).join(",")}`);
  }
  for (const label of definition.allLabels || []) parts.push(`label:${quoteSearchValue(label)}`);
  for (const label of definition.withoutLabels || [])
    parts.push(`-label:${quoteSearchValue(label)}`);
  return parts.join(" ");
}

function combinedPrProofSearchQuery(repoSnapshots, definition, repoViews) {
  const repos = repoViews
    .filter((view) => view?.query)
    .map((view) => view.repository)
    .filter(Boolean);
  if (!repos.length) return null;
  const parts = [...repos.map((repo) => `repo:${repo}`), "is:pr", "is:open"];
  const availableLabels = [
    ...new Set(
      repoSnapshots
        .filter((repo) => repos.includes(repo.repository))
        .flatMap((repo) => repo.labels.map((label) => label.name)),
    ),
  ];
  appendProofSearchLabels(parts, definition, availableLabels);
  return parts.join(" ");
}

async function triageViewForRepo(
  env,
  repo,
  definition,
  discoveredLabels,
  errors,
  itemLimit,
  fallbackSourceItems = null,
  fallbackItemLimit = itemLimit,
) {
  const query = triageSearchQuery(repo, definition, discoveredLabels);
  if (!query) {
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query: null,
      github_url: null,
      item_limit: itemLimit,
      total_count: 0,
      items: [],
    };
  }
  const search = await githubIssueSearch(env, query, itemLimit).catch((error) => {
    errors.push(`${repo} ${definition.id}: ${error.message}`);
    if (fallbackSourceItems) {
      return {
        ...triageViewFromItems(
          repo,
          definition,
          discoveredLabels,
          fallbackSourceItems,
          fallbackItemLimit,
        ),
        search_failed: true,
      };
    }
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query,
      github_url: githubSearchUrl(query),
      item_limit: itemLimit,
      total_count: 0,
      items: [],
      search_failed: true,
    };
  });
  if (search.search_failed) return search;
  return {
    id: definition.id,
    repository: repo,
    title: definition.title,
    description: definition.description,
    query,
    github_url: githubSearchUrl(query),
    item_limit: itemLimit,
    total_count: search.total_count || 0,
    items: Array.isArray(search.items)
      ? search.items.map((issue) => normalizeTriageIssue(repo, issue))
      : [],
  };
}

async function prProofViewForRepo(env, repo, definition, discoveredLabels, errors, itemLimit) {
  const query = prProofSearchQuery(repo, definition, discoveredLabels);
  const viewItemLimit = Math.min(itemLimit, Math.max(1, definition.itemLimit || itemLimit));
  if (!query) {
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query: null,
      github_url: null,
      item_limit: viewItemLimit,
      total_count: 0,
      items: [],
    };
  }
  const search = await githubIssueSearch(env, query, viewItemLimit).catch((error) => {
    errors.push(`${repo} ${definition.id}: ${error.message}`);
    return { total_count: 0, items: [] };
  });
  return {
    id: definition.id,
    repository: repo,
    title: definition.title,
    description: definition.description,
    query,
    github_url: githubSearchUrl(query),
    item_limit: viewItemLimit,
    total_count: search.total_count || 0,
    items: Array.isArray(search.items)
      ? search.items.map((issue) => normalizeProofPullRequest(repo, issue))
      : [],
  };
}

function triageSearchQuery(repo, definition, discoveredLabels) {
  const available = new Set(discoveredLabels.map((label) => label.toLowerCase()));
  const allLabels = (definition.allLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  const withoutLabels = (definition.withoutLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  let anyLabels = [];
  if (definition.anyLabels === "discovered") {
    anyLabels = discoveredLabels;
  } else {
    anyLabels = (definition.anyLabels || []).filter((label) => available.has(label.toLowerCase()));
  }
  if ((definition.allLabels || []).length && allLabels.length !== definition.allLabels.length) {
    return null;
  }
  if (definition.anyLabels && anyLabels.length === 0) return null;
  const parts = [`repo:${repo}`, "is:issue", "is:open"];
  if (anyLabels.length) parts.push(`label:${anyLabels.map(quoteSearchValue).join(",")}`);
  for (const label of allLabels) parts.push(`label:${quoteSearchValue(label)}`);
  for (const label of withoutLabels) parts.push(`-label:${quoteSearchValue(label)}`);
  return parts.join(" ");
}

function prProofSearchQuery(repo, definition, discoveredLabels) {
  const parts = [`repo:${repo}`, "is:pr", "is:open"];
  if (!appendProofSearchLabels(parts, definition, discoveredLabels)) return null;
  return parts.join(" ");
}

function appendProofSearchLabels(parts, definition, discoveredLabels) {
  const available = new Set(discoveredLabels.map((label) => label.toLowerCase()));
  const allLabels = (definition.allLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  const withoutLabels = (definition.withoutLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  let anyLabels = [];
  if (definition.anyLabels === "proof") {
    anyLabels = PR_PROOF_LABEL_NAMES.filter((label) => available.has(label.toLowerCase()));
  } else {
    anyLabels = (definition.anyLabels || []).filter((label) => available.has(label.toLowerCase()));
  }
  if ((definition.allLabels || []).length && allLabels.length !== definition.allLabels.length) {
    return false;
  }
  if (definition.anyLabels && anyLabels.length === 0) return false;
  if (anyLabels.length) parts.push(`label:${anyLabels.map(quoteSearchValue).join(",")}`);
  for (const label of allLabels) parts.push(`label:${quoteSearchValue(label)}`);
  for (const label of withoutLabels) parts.push(`-label:${quoteSearchValue(label)}`);
  return true;
}

function newestTriageCreatedFirst(left, right) {
  const created = Date.parse(right?.created_at || "") - Date.parse(left?.created_at || "");
  if (Number.isFinite(created) && created !== 0) return created;
  const updated = Date.parse(right?.updated_at || "") - Date.parse(left?.updated_at || "");
  if (Number.isFinite(updated) && updated !== 0) return updated;
  const leftNumber = Number(left?.number);
  const rightNumber = Number(right?.number);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return 0;
}

async function repoClawsweeperLabels(env, repo) {
  const labels = [];
  for (let page = 1; page <= 4; page += 1) {
    const rows = await githubJson(env, `/repos/${repo}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    labels.push(
      ...rows
        .filter((label) => String(label.name || "").startsWith(TRIAGE_LABEL_PREFIX))
        .map((label) => ({
          name: String(label.name || ""),
          color: String(label.color || ""),
          description: String(label.description || ""),
        })),
    );
    if (rows.length < 100) break;
  }
  return labels.sort((left, right) => left.name.localeCompare(right.name));
}

async function repoProofLabels(env, repo) {
  const names = new Set(PR_PROOF_LABEL_NAMES.map((label) => label.toLowerCase()));
  const labels = [];
  for (let page = 1; page <= 4; page += 1) {
    const rows = await githubJson(env, `/repos/${repo}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    labels.push(
      ...rows
        .filter((label) => names.has(String(label.name || "").toLowerCase()))
        .map((label) => ({
          name: String(label.name || ""),
          color: String(label.color || ""),
          description: String(label.description || ""),
        })),
    );
    if (rows.length < 100) break;
  }
  return labels.sort((left, right) => left.name.localeCompare(right.name));
}

async function githubIssueSearch(env, query, perPage) {
  const limit = Math.min(MAX_TRIAGE_ITEMS_PER_VIEW, Math.max(1, perPage));
  const pageSize = Math.min(TRIAGE_SEARCH_PAGE_SIZE, limit);
  const firstPage = await githubIssueSearchPage(env, query, pageSize, 1);
  const totalCount = Number(firstPage?.total_count || 0);
  const items = Array.isArray(firstPage?.items) ? [...firstPage.items] : [];
  const wantedItems = Math.min(limit, totalCount || items.length);
  const pageCount = Math.ceil(wantedItems / pageSize);
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await githubIssueSearchPage(env, query, pageSize, page);
    if (!Array.isArray(nextPage?.items) || nextPage.items.length === 0) break;
    items.push(...nextPage.items);
  }
  return {
    ...firstPage,
    total_count: totalCount,
    items: items.slice(0, limit),
  };
}

async function githubIssueSearchPage(env, query, perPage, page) {
  return githubJson(
    env,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=created&order=desc`,
  );
}

function normalizeTriageIssue(repo, issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => ({
        name: String(label.name || ""),
        color: String(label.color || ""),
      }))
    : [];
  return {
    repository: repo,
    number: issue.number,
    title: issue.title || "",
    url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments || 0,
    author: issue.user?.login || null,
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((assignee) => assignee.login).filter(Boolean)
      : [],
    labels,
    routing_groups: triageRoutingGroupsForLabels(labels).map((group) => ({
      id: group.id,
      title: group.title,
    })),
  };
}

function normalizeProofPullRequest(repo, issue) {
  const normalized = normalizeTriageIssue(repo, issue);
  return {
    ...normalized,
    proof_state: proofStateFromLabels(normalized.labels),
  };
}

function proofStateFromLabels(labels) {
  const names = new Set((labels || []).map((label) => label.name.toLowerCase()));
  const has = (name) => names.has(name);
  if (has("proof: override")) return "Override";
  if (has("proof: sufficient") && has("triage: needs-real-behavior-proof")) {
    return "Sufficient + needs label";
  }
  if (has("proof: sufficient")) return "Sufficient";
  if (has("triage: mock-only-proof")) return "Mock-only proof";
  if (has("triage: needs-real-behavior-proof")) return "Needs proof";
  if (has("mantis: telegram-visible-proof")) return "Telegram proof";
  return "";
}

function triageTargetRepos(env) {
  const configured = String(env.TRIAGE_TARGET_REPOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const targetRepos = String(env.TARGET_REPOS || "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return targetRepos.length ? [targetRepos[0]] : ["openclaw/openclaw"];
}

function prProofTargetRepos(env) {
  const configured = String(env.PR_PROOF_TARGET_REPOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return triageTargetRepos(env);
}

function quoteSearchValue(value) {
  return JSON.stringify(String(value));
}

function githubSearchUrl(query) {
  return `https://github.com/issues?q=${encodeURIComponent(query)}&s=created&o=desc`;
}

async function activeWorkerSnapshot(env, repo, runs) {
  const detailRunLimit = Math.max(
    1,
    numberFrom(env.WORKER_DETAIL_RUN_LIMIT, DEFAULT_WORKER_DETAIL_RUN_LIMIT),
  );
  const fetchConcurrency = Math.max(
    1,
    Math.floor(numberFrom(env.WORKER_JOB_FETCH_CONCURRENCY, DEFAULT_WORKER_JOB_FETCH_CONCURRENCY)),
  );
  const detailRuns: WorkflowRunSummary[] = runs.slice(0, detailRunLimit);
  const results = await mapWithConcurrency(detailRuns, fetchConcurrency, async (run) => {
    try {
      const jobs = await workflowJobsForRun(env, repo, run.id);
      return {
        run,
        workers: jobs
          .filter((job) => isActiveWorkflowJob(job) && isCodexWorkerJob(job))
          .map((job) => normalizeWorkerJob(run, job)),
        hasWorkerJobs: jobs.some((job) => isCodexWorkerJob(job)),
        error: null,
      };
    } catch (error) {
      return {
        run,
        workers: [],
        hasWorkerJobs: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const workers = [];
  const errors = [];
  let fallbacks = 0;
  for (const result of results) {
    if (result.error) {
      errors.push(`workflow jobs ${result.run.id}: ${result.error}`);
      if (codexJobName(`${result.run.name || ""} ${result.run.display_title || ""}`)) {
        workers.push(normalizeFallbackWorker(result.run));
        fallbacks += 1;
      }
      continue;
    }
    if (result.workers.length) {
      workers.push(...result.workers);
    } else if (
      !result.hasWorkerJobs &&
      codexJobName(`${result.run.name || ""} ${result.run.display_title || ""}`)
    ) {
      workers.push(normalizeFallbackWorker(result.run));
      fallbacks += 1;
    }
  }
  for (const run of runs.slice(detailRunLimit)) {
    if (!codexJobName(`${run.name || ""} ${run.display_title || ""}`)) continue;
    workers.push(normalizeFallbackWorker(run));
    fallbacks += 1;
  }
  workers.sort(
    (left, right) =>
      workerStatusRank(left.status) - workerStatusRank(right.status) ||
      laneRank(left.mode) - laneRank(right.mode) ||
      Date.parse(left.started_at || "") - Date.parse(right.started_at || ""),
  );
  await attachWorkerTargets(env, workers, errors);
  return {
    count: workers.length,
    workers,
    detailRuns: detailRuns.length,
    fallbacks,
    sample: workers.slice(0, 25).map((worker) => ({
      run_url: worker.run_url,
      run_title: worker.workflow_title,
      job: worker.name,
      status: worker.status,
      current_step: worker.current_step,
      started_at: worker.started_at,
    })),
    rate: null,
    errors,
  };
}

async function recentWorkerHealth(env, repo, runs: WorkflowRunSummary[]) {
  const cacheKey = `worker-health:v1:${String(repo || "").toLowerCase()}`;
  const cached = await readStoredJson(env, cacheKey);
  if (cached) return cached;

  const completedRuns = runs
    .filter(
      (run) =>
        run.status === "completed" &&
        !isSupportWorkflowRun(run) &&
        codexJobName(`${run.name || ""} ${run.display_title || ""}`),
    )
    .sort(newestWorkflowRunFirst)
    .slice(0, RECENT_WORKER_HEALTH_RUN_LIMIT);
  const fetchConcurrency = Math.max(
    1,
    Math.floor(
      numberFrom(env.WORKER_HEALTH_FETCH_CONCURRENCY, DEFAULT_WORKER_HEALTH_FETCH_CONCURRENCY),
    ),
  );
  const results = await mapWithConcurrency(completedRuns, fetchConcurrency, async (run) => {
    try {
      return {
        attempts: (await workflowJobsForRun(env, repo, run.id))
          .filter((job) => isCodexWorkerJob(job))
          .map((job) => workerHealthAttempt(run, job))
          .filter(Boolean),
        error: null,
      };
    } catch (error) {
      return {
        attempts: [],
        error: `worker health run ${run.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });
  const attempts = results.flatMap((result) => result.attempts);
  const successfulByKey = new Map();
  for (const attempt of attempts) {
    if (attempt.outcome !== "success") continue;
    const timestamp = Date.parse(attempt.started_at || "");
    const previous = successfulByKey.get(attempt.key) || 0;
    if (Number.isFinite(timestamp) && timestamp > previous) {
      successfulByKey.set(attempt.key, timestamp);
    }
  }
  const failures = attempts
    .filter((attempt) => attempt.outcome === "failure")
    .map((attempt) => {
      const successAt = successfulByKey.get(attempt.key) || 0;
      const failedAt = Date.parse(attempt.started_at || "");
      return {
        ...attempt,
        recovered: Number.isFinite(failedAt) && successAt > failedAt,
      };
    })
    .sort((left, right) => Date.parse(right.started_at || "") - Date.parse(left.started_at || ""));
  const successfulAttempts = attempts.filter((attempt) => attempt.outcome === "success").length;
  const cancelledAttempts = attempts.filter((attempt) => attempt.outcome === "cancelled").length;
  const measuredAttempts = successfulAttempts + failures.length;
  const recoveredFailures = failures.filter((failure) => failure.recovered).length;
  const health = {
    sampled_runs: completedRuns.length,
    attempts: measuredAttempts,
    successful_attempts: successfulAttempts,
    failed_attempts: failures.length,
    cancelled_attempts: cancelledAttempts,
    recovered_failures: recoveredFailures,
    unresolved_failures: failures.length - recoveredFailures,
    error_rate_percent: ratePercent(failures.length, measuredAttempts),
    recovery_rate_percent: failures.length ? ratePercent(recoveredFailures, failures.length) : null,
    failures: failures.slice(0, 10),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])).slice(0, 10),
    updated_at: new Date().toISOString(),
  };
  await writeStoredJson(
    env,
    cacheKey,
    health,
    numberFrom(env.WORKER_HEALTH_CACHE_TTL_SECONDS, WORKER_HEALTH_CACHE_TTL_SECONDS),
  );
  return health;
}

function emptyWorkerHealth(updatedAt) {
  return {
    sampled_runs: 0,
    attempts: 0,
    successful_attempts: 0,
    failed_attempts: 0,
    cancelled_attempts: 0,
    recovered_failures: 0,
    unresolved_failures: 0,
    error_rate_percent: 0,
    recovery_rate_percent: null,
    failures: [],
    errors: [],
    updated_at: updatedAt,
  };
}

function workerHealthAttempt(run, job) {
  if (String(job?.status || "") !== "completed") return null;
  const runItem = classifyRun(run);
  const target = workerTargetFromJob(runItem, job?.name);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const failedStep = steps.find((step) =>
    TERMINAL_BAD_CONCLUSIONS.has(String(step?.conclusion || "")),
  );
  const conclusion = String(failedStep?.conclusion || job?.conclusion || "");
  const outcome =
    conclusion === "cancelled"
      ? "cancelled"
      : failedStep || TERMINAL_BAD_CONCLUSIONS.has(conclusion)
        ? "failure"
        : conclusion === "success" || conclusion === "neutral"
          ? "success"
          : null;
  if (!outcome) return null;
  const itemNumbers = [...target.itemNumbers].sort((left, right) => left - right);
  const targetKey =
    target.repository && itemNumbers.length
      ? `${String(target.repository).toLowerCase()}#${itemNumbers.join(",")}`
      : `${String(run.name || "").toLowerCase()}|${String(run.display_title || job?.name || "")
          .toLowerCase()
          .replace(/\[clawsweeper-recovery-attempt=\d+\]/g, "")
          .replace(/\s+/g, " ")
          .trim()}`;
  return {
    key: targetKey,
    outcome,
    workflow_title: runItem.title,
    job_name: String(job?.name || runItem.title || "Codex worker"),
    repository: target.repository,
    item_numbers: itemNumbers,
    conclusion: conclusion || null,
    failed_step: failedStep ? String(failedStep.name || "Unknown step") : null,
    url: job?.html_url || run.html_url,
    started_at: job?.started_at || run.created_at || null,
  };
}

function ratePercent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

async function attachWorkerTargets(env, workers, errors) {
  const references = new Map();
  for (const worker of workers) {
    for (const number of worker.item_numbers || []) {
      if (!worker.repository || !Number.isInteger(number) || number <= 0) continue;
      const key = workerTargetKey(worker.repository, number);
      if (!references.has(key)) {
        references.set(key, {
          repository: worker.repository,
          number,
        });
      }
    }
  }
  if (!references.size) return;

  const targets = new Map();
  await Promise.all(
    [...references.keys()].map(async (key) => {
      const cached = await readStoredJson(env, `worker-target:${key}`);
      if (cached?.title) targets.set(key, cached);
    }),
  );

  const missingByRepository = new Map();
  for (const [key, reference] of references) {
    if (targets.has(key)) continue;
    const bucket = missingByRepository.get(reference.repository) || [];
    bucket.push(reference);
    missingByRepository.set(reference.repository, bucket);
  }

  if (missingByRepository.size && hasGithubAuth(env)) {
    await Promise.all(
      [...missingByRepository.entries()].flatMap(([repository, repoReferences]) =>
        chunk(repoReferences, WORKER_TARGET_BATCH_SIZE).map(async (batch) => {
          try {
            const fetched = await fetchWorkerTargetBatch(env, repository, batch);
            for (const target of fetched) {
              const key = workerTargetKey(target.repository, target.number);
              targets.set(key, target);
            }
            await Promise.all(
              fetched.map((target) =>
                writeStoredJson(
                  env,
                  `worker-target:${workerTargetKey(target.repository, target.number)}`,
                  target,
                  numberFrom(env.WORKER_TARGET_CACHE_TTL_SECONDS, WORKER_TARGET_CACHE_TTL_SECONDS),
                ),
              ),
            );
          } catch (error) {
            errors.push(
              `worker target titles ${repository}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
      ),
    );
  }

  for (const worker of workers) {
    worker.target_items = (worker.item_numbers || [])
      .map((number) => targets.get(workerTargetKey(worker.repository, number)))
      .filter(Boolean);
  }
}

async function fetchWorkerTargetBatch(env, repository, references) {
  const [owner, name] = String(repository || "").split("/");
  if (!owner || !name || !references.length) return [];
  const aliases = references
    .map(
      (reference, index) => `
        target${index}: issueOrPullRequest(number: ${Number(reference.number)}) {
          __typename
          ... on Issue { title url }
          ... on PullRequest { title url }
        }`,
    )
    .join("\n");
  const data = await githubGraphql(
    env,
    `query WorkerTargetTitles($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${aliases}
      }
    }`,
    { owner, name },
  );
  const repo = data?.repository || {};
  return references.flatMap((reference, index) => {
    const item = repo[`target${index}`];
    if (!item?.title || !item?.url) return [];
    return [
      {
        repository,
        number: reference.number,
        title: String(item.title),
        url: String(item.url),
        type: item.__typename === "PullRequest" ? "pull_request" : "issue",
      },
    ];
  });
}

function workerTargetKey(repository, number) {
  return `${String(repository || "").toLowerCase()}#${number}`;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency<Item, Result>(
  items: Item[],
  concurrency: number,
  mapper: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!items.length) return [];
  const results = Array.from({ length: items.length }) as Result[];
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

async function workflowJobsForRun(env, repo, runId) {
  const key = `workflow-jobs:${repo}:${runId}`;
  const cached = await readStoredJson(env, key);
  if (Array.isArray(cached)) return cached;
  const jobs = [];
  for (let page = 1; page <= WORKER_JOB_PAGE_LIMIT; page += 1) {
    const payload = await githubJson(
      env,
      `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    const pageJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    jobs.push(...pageJobs);
    const totalCount = Number(payload?.total_count);
    if (
      pageJobs.length < 100 ||
      (Number.isFinite(totalCount) && totalCount >= 0 && jobs.length >= totalCount)
    ) {
      break;
    }
  }
  const hasActiveWorker = jobs.some((job) => isActiveWorkflowJob(job) && isCodexWorkerJob(job));
  await writeStoredJson(
    env,
    key,
    jobs,
    hasActiveWorker
      ? numberFrom(env.WORKER_JOB_CACHE_TTL_SECONDS, WORKER_JOB_CACHE_TTL_SECONDS)
      : WORKER_JOB_IDLE_CACHE_TTL_SECONDS,
  );
  return jobs;
}

function isActiveWorkflowJob(job) {
  return ACTIVE_RUN_STATUSES.has(String(job?.status || ""));
}

function isCodexWorkerJob(job) {
  const name = String(job?.name || "");
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (steps.some((step) => /setup-codex/i.test(String(step?.name || "")))) return true;
  return /review shard|review, comment, and apply event item|review commit|plan and review cluster|execute and apply cluster actions|assist/i.test(
    name,
  );
}

function normalizeWorkerJob(run, job) {
  const runItem = classifyRun(run);
  const target = workerTargetFromJob(runItem, job.name);
  const mode = workerMode(runItem.mode, job.name);
  const workKind = workerWorkKind(runItem, job.name);
  const steps = Array.isArray(job.steps)
    ? job.steps.map((step) => ({
        number: numberOrNull(step.number),
        name: String(step.name || "Unnamed step"),
        status: String(step.status || "unknown"),
        conclusion: nullableString(step.conclusion),
      }))
    : [];
  const current =
    steps.find((step) => step.status === "in_progress") ||
    steps.find((step) => QUEUED_RUN_STATUSES.has(step.status)) ||
    null;
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  const startedAt = job.started_at || run.created_at || null;
  return {
    id: job.id,
    source: "job",
    name: String(job.name || runItem.title || "Codex worker"),
    mode,
    work_kind: workKind,
    stage: runItem.stage,
    status: String(job.status || run.status || "unknown"),
    conclusion: nullableString(job.conclusion),
    repository: target.repository,
    item_number: target.itemNumbers.length === 1 ? target.itemNumbers[0] : null,
    item_numbers: target.itemNumbers,
    workflow_title: runItem.title,
    run_id: run.id,
    run_url: run.html_url,
    job_url: job.html_url || run.html_url,
    started_at: startedAt,
    updated_at: run.updated_at || null,
    elapsed_ms: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : null,
    current_step: current?.name || workerStatusLabel(job.status, job.conclusion),
    progress: {
      completed: completedSteps,
      total: steps.length,
    },
    steps,
  };
}

function workerMode(runMode, jobName) {
  const name = String(jobName || "").toLowerCase();
  if (name.includes("assist")) return "assist";
  if (name.includes("review commit")) return "commit-review";
  if (name.includes("cluster actions") || name.includes("review cluster")) return "repair";
  return runMode;
}

export function workerWorkKind(runItem, jobName) {
  const text = `${runItem?.title || ""} ${runItem?.workflow || ""} ${jobName || ""}`.toLowerCase();
  if (
    text.includes("issue implementation") ||
    /\bissue-[a-z0-9_.-]+-[a-z0-9_.-]+-\d+\b/.test(text)
  ) {
    return "issue_to_pr";
  }
  if (text.includes("automerge") || text.includes("autofix") || text.includes("pr repair")) {
    return "pr_repair";
  }
  if (
    text.includes("repair cluster") ||
    text.includes("cluster actions") ||
    text.includes("review cluster")
  ) {
    return "repair_cluster";
  }
  return "other";
}

function normalizeFallbackWorker(run) {
  const item = classifyRun(run);
  return {
    id: `run-${run.id}`,
    source: "workflow-fallback",
    name: item.title || item.workflow || "Codex worker",
    mode: item.mode,
    work_kind: workerWorkKind(item, ""),
    stage: item.stage,
    status: item.status,
    conclusion: item.conclusion,
    repository: item.repository,
    item_number: item.item_number,
    item_numbers: item.item_number ? [item.item_number] : [],
    workflow_title: item.title,
    run_id: item.id,
    run_url: item.run_url,
    job_url: item.run_url,
    started_at: item.started_at,
    updated_at: item.updated_at,
    elapsed_ms: item.elapsed_ms,
    current_step: item.stage,
    progress: {
      completed: 0,
      total: 0,
    },
    steps: [],
  };
}

function workerTargetFromJob(runItem, jobName) {
  const match = String(jobName || "").match(
    /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]+(?:,[0-9]+)*)/,
  );
  return {
    repository: match?.[1] || runItem.repository,
    itemNumbers: match?.[2]
      ? match[2]
          .split(",")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      : runItem.item_number
        ? [runItem.item_number]
        : [],
  };
}

function workerStatusLabel(status, conclusion) {
  if (status === "completed") return conclusion || "completed";
  if (QUEUED_RUN_STATUSES.has(String(status || ""))) return "Waiting for runner";
  return status || "Starting";
}

function workerStatusRank(status) {
  if (status === "in_progress") return 0;
  if (QUEUED_RUN_STATUSES.has(String(status || ""))) return 1;
  return 2;
}

async function activeWorkflowRuns(env, repo, errors) {
  const pages = await Promise.all(
    ACTIVE_RUN_STATUS_FILTERS.map(async (status) => {
      const runs = await githubJson(
        env,
        `/repos/${repo}/actions/runs?status=${status}&per_page=100`,
      ).catch((error) => {
        errors.push(`workflow runs ${status}: ${error.message}`);
        return null;
      });
      return Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
    }),
  );
  return uniqueWorkflowRuns(pages.flat()).filter((run) => isActiveWorkflowRun(run));
}

function isActiveWorkflowRun(run) {
  const status = String(run?.status || "");
  if (!ACTIVE_RUN_STATUSES.has(status)) return false;
  if (!QUEUED_RUN_STATUSES.has(status)) return true;
  const changedAt = Date.parse(String(run?.updated_at || run?.created_at || ""));
  if (!Number.isFinite(changedAt)) return true;
  return Date.now() - changedAt <= DEFAULT_STALE_QUEUED_WORKFLOW_MS;
}

function uniqueWorkflowRuns(runs) {
  const seen = new Map();
  for (const run of runs) {
    const key =
      run?.id ??
      run?.html_url ??
      `${run?.name || ""}:${run?.display_title || ""}:${run?.created_at || ""}`;
    if (key) seen.set(String(key), run);
  }
  return [...seen.values()];
}

function isSupportWorkflowRun(run) {
  const name = String(run?.name || "").trim();
  if (SUPPORT_WORKFLOW_NAMES.has(name)) return true;
  const title = String(run?.display_title || "").trim();
  if (SUPPORT_WORKFLOW_NAMES.has(title)) return true;
  const lower = `${name} ${title}`.toLowerCase();
  return lower.includes("dashboard ci status") || lower.includes("github_activity");
}

function newestWorkflowRunFirst(left, right) {
  return Date.parse(right.created_at || "") - Date.parse(left.created_at || "");
}

async function pipelineItems(env, runs) {
  const items = [];
  const prCandidates = [];
  for (const run of runs) {
    const item = classifyRun(run);
    if (item.item_number && item.repository) prCandidates.push(item);
    items.push(item);
  }
  await attachStoredCiStatuses(env, prCandidates);
  if (env.INCLUDE_CI_STATUS === "1") {
    await Promise.all(
      prCandidates
        .filter((item) => !item.ci || item.ci.source === "workflow" || item.ci.state === "unknown")
        .slice(0, 4)
        .map((item) => attachCiStatus(env, item)),
    );
  }
  return items.sort(
    (left, right) =>
      laneRank(left.mode) - laneRank(right.mode) ||
      Date.parse(right.started_at || "") - Date.parse(left.started_at || ""),
  );
}

function classifyRun(run) {
  const title = String(run.display_title || run.name || "");
  const workflow = String(run.name || "");
  const extracted = title.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/);
  const lower = `${workflow} ${title}`.toLowerCase();
  let mode = "background-review";
  let stage = "running";
  if (lower.includes("automerge")) {
    mode = "automerge";
    stage = lower.includes("repair") ? "repairing" : "reviewing";
  } else if (lower.includes("repair cluster")) {
    mode = "repair";
    stage = "repairing";
  } else if (lower.includes("review event item")) {
    mode = "exact-review";
    stage = "reviewing";
  } else if (lower.includes("apply clawsweeper closures")) {
    mode = "apply";
    stage = "closing";
  } else if (lower.includes("commit review")) {
    mode = "commit-review";
    stage = "reviewing";
  } else if (lower.includes("hot")) {
    mode = "hot-review";
    stage = "reviewing";
  }
  return {
    id: run.id,
    mode,
    stage,
    status: run.status,
    conclusion: run.conclusion,
    repository: extracted?.[1] || null,
    item_number: extracted?.[2] ? Number(extracted[2]) : null,
    title,
    workflow,
    run_url: run.html_url,
    started_at: run.created_at,
    updated_at: run.updated_at,
    elapsed_ms: Date.now() - Date.parse(run.created_at || new Date().toISOString()),
    ci: workflowRunCi(run),
  };
}

function workflowRunCi(run) {
  const status = String(run.status || "");
  const conclusion = String(run.conclusion || "");
  if (status === "completed") {
    return {
      state: TERMINAL_BAD_CONCLUSIONS.has(conclusion) ? "red" : "green",
      source: "workflow",
      label: conclusion || "completed",
      total: 1,
      failing: TERMINAL_BAD_CONCLUSIONS.has(conclusion) ? 1 : 0,
      pending: 0,
    };
  }
  return {
    state: "pending",
    source: "workflow",
    label: status || "running",
    total: 1,
    failing: 0,
    pending: 1,
  };
}

async function attachStoredCiStatuses(env, items) {
  if (!items.length) return;
  await Promise.all(
    items.map(async (item) => {
      const stored = await readCiStatus(env, item.repository, item.item_number);
      if (stored) item.ci = stored;
    }),
  );
}

async function attachCiStatus(env, item) {
  try {
    const pr = await githubJson(env, `/repos/${item.repository}/pulls/${item.item_number}`);
    if (!pr?.head?.sha) return;
    const checks = await githubJson(
      env,
      `/repos/${item.repository}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    const runs = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
    const failing = runs.filter(
      (check) =>
        check.status === "completed" &&
        !["success", "neutral", "skipped"].includes(String(check.conclusion)),
    );
    const pending = runs.filter((check) => check.status !== "completed");
    item.ci = {
      state: failing.length ? "red" : pending.length ? "pending" : "green",
      head_sha: pr.head.sha,
      total: runs.length,
      failing: failing.length,
      pending: pending.length,
      source: "live",
    };
  } catch (error) {
    if (!item.ci)
      item.ci = { state: "unknown", source: "live", error: String(error?.message || error) };
  }
}

async function recentAutomerge(env, repo) {
  const cacheKey = `recent-automerge:${String(repo).toLowerCase()}`;
  const cached = await readStoredJson(env, cacheKey);
  if (cached?.items && Array.isArray(cached.items)) return cached;

  const search = await githubJson(
    env,
    `/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged label:clawsweeper:automerge sort:updated-desc`)}&per_page=${AVERAGE_LIMIT}`,
  );
  const items = await Promise.all(
    (Array.isArray(search?.items) ? search.items : []).map(async (issue) => {
      const number = issue.number;
      const [pr, comments] = await Promise.all([
        githubJson(env, `/repos/${repo}/pulls/${number}`),
        githubJson(env, `/repos/${repo}/issues/${number}/comments?per_page=100`),
      ]);
      const commandAt = firstAutomergeCommandAt(comments);
      const mergedAt = pr?.merged_at || null;
      const durationMs =
        commandAt && mergedAt ? Date.parse(mergedAt) - Date.parse(commandAt) : null;
      return {
        url: issue.html_url,
        title: issue.title,
        number,
        command_at: commandAt,
        merged_at: mergedAt,
        duration_ms: durationMs,
        merge_commit_sha: pr?.merge_commit_sha || null,
      };
    }),
  );
  const durations = items
    .map((item) => item.duration_ms)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const result = {
    average_ms: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null,
    samples: durations.length,
    items,
  };
  await writeStoredJson(
    env,
    cacheKey,
    result,
    numberFrom(env.AUTOMERGE_CACHE_TTL_SECONDS, AUTOMERGE_CACHE_TTL_SECONDS),
  ).catch(() => undefined);
  return result;
}

async function clusterRepairStatus(env, repo, targetRepos, activeRuns) {
  const [workflowRuns, markers] = await Promise.all([
    githubJson(
      env,
      `/repos/${repo}/actions/workflows/${encodeURIComponent(CLUSTER_REPAIR_INTAKE_WORKFLOW)}/runs?per_page=5`,
    ).catch(() => ({ workflow_runs: [] })),
    Promise.all(targetRepos.map((targetRepo) => readClusterRepairMarker(env, targetRepo))),
  ]);
  const intakeRuns = Array.isArray(workflowRuns?.workflow_runs) ? workflowRuns.workflow_runs : [];
  return {
    workflow: CLUSTER_REPAIR_INTAKE_WORKFLOW,
    markers,
    latest_runs: intakeRuns.slice(0, 5).map(workflowRunSummary),
    active_intake_runs: activeRuns
      .filter((run) => workflowRunNameIncludes(run, "repair cluster intake"))
      .map(workflowRunSummary),
    active_worker_runs: activeRuns
      .filter((run) => workflowRunNameIncludes(run, "repair cluster worker"))
      .map(workflowRunSummary),
  };
}

async function readClusterRepairMarker(env, targetRepo) {
  const stateRepo = String(env.CLAWSWEEPER_STATE_REPO || CLAWSWEEPER_STATE_REPO);
  const stateRef = String(env.CLAWSWEEPER_STATE_REF || CLAWSWEEPER_STATE_REF);
  const repoSlug = String(targetRepo || "").replace(/\//g, "-");
  const markerPath = `results/cluster-repair-intake/${repoSlug}.json`;
  try {
    const content = await githubJson(
      env,
      `/repos/${stateRepo}/contents/${githubPath(markerPath)}?ref=${encodeURIComponent(stateRef)}`,
    );
    const marker = JSON.parse(decodeGithubContent(content?.content));
    const generatedJobs = Array.isArray(marker.generated_jobs) ? marker.generated_jobs : [];
    const storeSha = nullableString(marker.last_processed_store_sha256);
    return {
      target_repo: nullableString(marker.target_repo) || targetRepo,
      marker_path: markerPath,
      status: generatedJobs.length > 0 ? "imported" : "checked",
      last_processed_store_sha256: storeSha,
      last_processed_store_short_sha: storeSha ? storeSha.slice(0, 10) : null,
      last_processed_store_exported_at: nullableString(marker.last_processed_store_exported_at),
      generated_count: Math.max(0, numberOrNull(marker.generated_count) ?? generatedJobs.length),
      generated_jobs: generatedJobs.slice(0, 8).map((job) => String(job)),
      run_url: nullableString(marker.run_url),
      updated_at: nullableString(marker.updated_at),
    };
  } catch {
    return {
      target_repo: targetRepo,
      marker_path: markerPath,
      status: "not_recorded",
      last_processed_store_sha256: null,
      last_processed_store_short_sha: null,
      last_processed_store_exported_at: null,
      generated_count: 0,
      generated_jobs: [],
      run_url: null,
      updated_at: null,
    };
  }
}

function emptyClusterRepairStatus(targetRepos) {
  return {
    workflow: CLUSTER_REPAIR_INTAKE_WORKFLOW,
    markers: targetRepos.map((targetRepo) => ({
      target_repo: targetRepo,
      marker_path: `results/cluster-repair-intake/${String(targetRepo).replace(/\//g, "-")}.json`,
      status: "unavailable",
      last_processed_store_sha256: null,
      last_processed_store_short_sha: null,
      last_processed_store_exported_at: null,
      generated_count: 0,
      generated_jobs: [],
      run_url: null,
      updated_at: null,
    })),
    latest_runs: [],
    active_intake_runs: [],
    active_worker_runs: [],
  };
}

function workflowRunNameIncludes(run, needle) {
  return `${run?.name || ""} ${run?.display_title || ""}`.toLowerCase().includes(needle);
}

function githubPath(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

function decodeGithubContent(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

async function recentClawsweeperClosed(env, repos) {
  const trustedBotLogins = clawsweeperBotLogins(env);
  const cacheKey = [
    "recent-closed",
    repos.map((repo) => String(repo).toLowerCase()).join(","),
    [...trustedBotLogins].sort().join(","),
  ].join(":");
  const cached = await readStoredJson(env, cacheKey);
  if (cached?.items && Array.isArray(cached.items) && cached?.stats) return cached;

  const since = new Date(Date.now() - CLOSED_STATS_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await Promise.all(
    repos.map((repo) => recentClawsweeperClosedForRepo(env, repo, since, trustedBotLogins)),
  );
  const items = rows
    .flat()
    .sort((left, right) => Date.parse(right.closed_at || "") - Date.parse(left.closed_at || ""));
  const result = {
    items: items.slice(0, RECENT_CLOSED_LIMIT),
    stats: closedStats(items, since),
  };
  await writeStoredJson(
    env,
    cacheKey,
    result,
    numberFrom(env.RECENT_CLOSED_CACHE_TTL_SECONDS, RECENT_CLOSED_CACHE_TTL_SECONDS),
  ).catch(() => undefined);
  return result;
}

async function recentClawsweeperClosedForRepo(env, repo, since, trustedBotLogins) {
  const items = [];
  const firstPage = await githubJson(env, closedIssuesPath(repo, since, 1)).catch(() => []);
  const pages = [Array.isArray(firstPage) ? firstPage : []];
  if (pages[0].length >= 100 && CLOSED_STATS_PAGE_LIMIT > 1) {
    const remainingPages = await Promise.all(
      Array.from({ length: CLOSED_STATS_PAGE_LIMIT - 1 }, (_, index) =>
        githubJson(env, closedIssuesPath(repo, since, index + 2)).catch(() => []),
      ),
    );
    pages.push(...remainingPages.map((issues) => (Array.isArray(issues) ? issues : [])));
  }
  for (const issues of pages) {
    for (const item of issues) {
      if (!isClawsweeperClosedItem(item, since, trustedBotLogins)) continue;
      items.push({
        repository: repo,
        number: item.number,
        type: item.pull_request ? "PR" : "Issue",
        title: item.title || "",
        url: item.html_url,
        closed_at: item.closed_at,
        closed_by: item.closed_by?.login || null,
      });
    }
  }
  return items;
}

function closedIssuesPath(repo, since, page) {
  return `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&since=${encodeURIComponent(
    since,
  )}&per_page=100&page=${page}`;
}

function isClawsweeperClosedItem(item, since, trustedBotLogins) {
  if (!item?.closed_at) return false;
  if (!trustedBotLogins.has(String(item.closed_by?.login || ""))) return false;
  return Date.parse(item.closed_at) >= Date.parse(since);
}

function recentActivityEvents(storedEvents, closedItems) {
  const rows = [];
  const seen = new Set();
  const storedCloseItemKeys = new Set();
  for (const event of Array.isArray(storedEvents) ? storedEvents : []) {
    const key = activityEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    const itemKey = activityItemKey(event);
    if (isStoredCloseEvent(event) && itemKey) storedCloseItemKeys.add(itemKey);
    rows.push(event);
  }
  for (const item of Array.isArray(closedItems) ? closedItems : []) {
    const itemKey = activityItemKey(item);
    if (itemKey && storedCloseItemKeys.has(itemKey)) continue;
    const event = activityEventFromClosedItem(item);
    const key = activityEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(event);
  }
  return rows
    .sort(
      (left, right) =>
        Date.parse(right.received_at || right.closed_at || "") -
        Date.parse(left.received_at || left.closed_at || ""),
    )
    .slice(0, 25);
}

export function automaticIssueWork(storedEvents, workers) {
  const grouped = new Map();
  const allEvents = Array.isArray(storedEvents) ? storedEvents : [];
  const automaticKeys = new Set();
  for (const event of allEvents) {
    if (
      event?.automatic !== true &&
      !String(event?.event_type || "").startsWith("clawsweeper.issue_build_")
    ) {
      continue;
    }
    const repository = nullableString(event.repository);
    const issueNumber =
      numberOrNull(event.source_item_number) ??
      issueNumberFromUrl(event.source_item_url) ??
      issueNumberFromUrl(event.item_url);
    if (repository && issueNumber) automaticKeys.add(`${repository}#${issueNumber}`);
  }
  for (const event of [...allEvents].reverse()) {
    const repository = nullableString(event.repository);
    const issueNumber =
      numberOrNull(event.source_item_number) ??
      issueNumberFromUrl(event.source_item_url) ??
      issueNumberFromUrl(event.item_url);
    if (!repository || !issueNumber) continue;
    const key = `${repository}#${issueNumber}`;
    if (!automaticKeys.has(key)) continue;
    const row = grouped.get(key) ?? {
      id: key,
      repository,
      issue_number: issueNumber,
      issue_url:
        nullableString(event.source_item_url) ||
        `https://github.com/${repository}/issues/${issueNumber}`,
      title: nullableString(event.title) || `Issue #${issueNumber}`,
      phase: "queued",
      status: "queued",
      run_url: null,
      pr_url: null,
      updated_at: null,
      active: false,
      worker_id: null,
      timeline: [],
    };
    const eventTitle = nullableString(event.title);
    if (
      eventTitle &&
      isAutomaticWorkPlaceholderTitle(row.title, repository, issueNumber) &&
      !isAutomaticWorkPlaceholderTitle(eventTitle, repository, issueNumber)
    ) {
      row.title = eventTitle;
    }
    row.phase = nullableString(event.stage) || row.phase;
    row.status = nullableString(event.status) || row.status;
    row.run_url = nullableString(event.run_url) || row.run_url;
    row.pr_url =
      nullableString(event.pr_url) ||
      (String(event.item_url || "").includes("/pull/") ? event.item_url : row.pr_url);
    row.updated_at = nullableString(event.received_at) || row.updated_at;
    row.timeline.push({
      event_type: nullableString(event.event_type),
      phase: nullableString(event.stage) || "update",
      status: nullableString(event.status) || "unknown",
      note: nullableString(event.note),
      run_url: nullableString(event.run_url),
      received_at: nullableString(event.received_at),
    });
    grouped.set(key, row);
  }

  for (const worker of Array.isArray(workers) ? workers : []) {
    if (worker?.work_kind !== "issue_to_pr") continue;
    const issueNumber = numberOrNull(worker.item_number) ?? numberOrNull(worker.item_numbers?.[0]);
    let key = worker.repository && issueNumber ? `${worker.repository}#${issueNumber}` : null;
    if (!key && worker.run_url) {
      const matches = [...grouped.values()].filter((row) => row.run_url === worker.run_url);
      if (matches.length === 1) key = matches[0].id;
    }
    if (!key) continue;
    if (!grouped.has(key)) continue;
    const matchedRow = grouped.get(key);
    const resolvedIssueNumber = issueNumber || matchedRow.issue_number;
    worker.repository ||= matchedRow.repository;
    worker.item_number ||= resolvedIssueNumber;
    if (!Array.isArray(worker.item_numbers) || !worker.item_numbers.length) {
      worker.item_numbers = [resolvedIssueNumber];
    }
    if (!Array.isArray(worker.target_items) || !worker.target_items.length) {
      worker.target_items = [
        {
          repository: matchedRow.repository,
          number: resolvedIssueNumber,
          title: matchedRow.title,
          url: matchedRow.issue_url,
          type: "issue",
        },
      ];
    }
    const target = (worker.target_items || []).find(
      (item) => Number(item.number) === resolvedIssueNumber,
    );
    const row = grouped.get(key) ?? {
      id: key,
      repository: worker.repository,
      issue_number: worker.item_number,
      issue_url:
        target?.url || `https://github.com/${worker.repository}/issues/${worker.item_number}`,
      title: target?.title || `Issue #${worker.item_number}`,
      phase: "worker",
      status: worker.status || "running",
      run_url: worker.run_url || null,
      pr_url: null,
      updated_at: worker.updated_at || worker.started_at || null,
      active: true,
      worker_id: String(worker.id),
      timeline: [],
    };
    row.active = true;
    row.worker_id = String(worker.id);
    row.phase = worker.current_step || worker.stage || row.phase;
    row.status = worker.status || row.status;
    row.run_url = worker.run_url || row.run_url;
    row.updated_at = worker.updated_at || worker.started_at || row.updated_at;
    if (
      target?.title &&
      isAutomaticWorkPlaceholderTitle(row.title, row.repository, row.issue_number) &&
      !isAutomaticWorkPlaceholderTitle(target.title, row.repository, row.issue_number)
    ) {
      row.title = target.title;
    }
    row.timeline.push({
      event_type: "clawsweeper.worker_active",
      phase: worker.current_step || worker.stage || "worker",
      status: worker.status || "running",
      note: worker.name || null,
      run_url: worker.run_url || null,
      received_at: worker.updated_at || worker.started_at || null,
    });
    grouped.set(key, row);
  }

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      timeline: row.timeline.sort(
        (left, right) => Date.parse(left.received_at || "") - Date.parse(right.received_at || ""),
      ),
    }))
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        Date.parse(right.updated_at || "") - Date.parse(left.updated_at || ""),
    )
    .slice(0, 20);
}

function issueNumberFromUrl(value) {
  const match = String(value || "").match(/\/issues\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

function isAutomaticWorkPlaceholderTitle(value, repository, issueNumber) {
  const title = String(value || "").trim();
  if (!title) return true;
  const escapedRepository = String(repository || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`^Issue #${issueNumber}$`, "i").test(title) ||
    /^PR #\d+$/i.test(title) ||
    new RegExp(`^${escapedRepository}#\\d+$`, "i").test(title)
  );
}

function operationEventCounts(storedEvents) {
  const counts = {
    inherited_label_cleanups: 0,
    self_heal_conflict_repairs: 0,
    failed_review_retries: 0,
    failed_review_retry_exhaustions: 0,
    bot_owned_proof_decisions_requested: 0,
    bot_owned_proof_dispatches: 0,
  };
  for (const event of Array.isArray(storedEvents) ? storedEvents : []) {
    countOperationEvent(event, counts);
  }
  return counts;
}

function countOperationEvent(event, counts) {
  const key = [event.event_type, event.mode, event.stage, event.status]
    .map((value) =>
      String(value || "")
        .toLowerCase()
        .replaceAll("-", "_"),
    )
    .join(" ");
  if (
    key.includes("inherited_label_cleanup") ||
    key.includes("replacement_label_cleanup") ||
    key.includes("removed_inherited_labels")
  ) {
    counts.inherited_label_cleanups += 1;
  }
  if (
    key.includes("self_heal_conflict") ||
    key.includes("conflict_self_heal") ||
    key.includes("clawsweeper_self_rebase")
  ) {
    counts.self_heal_conflict_repairs += 1;
  }
  if (
    key.includes("failed_review_retry_exhausted") ||
    key.includes("failed_review_retries_exhausted")
  ) {
    counts.failed_review_retry_exhaustions += 1;
  } else if (key.includes("failed_review_retry")) {
    counts.failed_review_retries += 1;
  }
  if (
    key.includes("bot_owned_proof_decision_requested") ||
    key.includes("maintainer_proof_decision_requested") ||
    key.includes("needs_maintainer_proof_decision") ||
    key.includes("bot_proof_decision_planned") ||
    key.includes("bot_proof_decision_posted")
  ) {
    counts.bot_owned_proof_decisions_requested += 1;
  }
  if (
    key.includes("bot_owned_proof_dispatched") ||
    key.includes("bot_owned_proof_capture_dispatched") ||
    key.includes("bot_proof_mantis_request_planned") ||
    key.includes("bot_proof_mantis_request_posted")
  ) {
    counts.bot_owned_proof_dispatches += 1;
  }
}

function activityEventFromClosedItem(item) {
  return {
    event_type: "clawsweeper.item_closed",
    mode: "closed",
    stage: item.type || "item",
    status: "closed",
    repository: item.repository,
    item_number: item.number,
    item_url: item.url,
    title: item.title,
    received_at: item.closed_at,
    source: "closed_items",
  };
}

function activityEventKey(event) {
  return [
    event.event_type || "",
    event.item_url || "",
    event.item_number || "",
    event.id || event.received_at || "",
  ].join(":");
}

function activityItemKey(event) {
  if (event.repository && event.item_number) return `${event.repository}#${event.item_number}`;
  const url = nullableString(event.item_url || event.url);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:\/|$)/);
    return match ? `${match[1]}#${match[2]}` : null;
  } catch {
    return null;
  }
}

function isStoredCloseEvent(event) {
  return event.event_type === "clawsweeper.item_closed" && event.status === "executed";
}

function clawsweeperBotLogins(env) {
  const configured = String(env.CLAWSWEEPER_BOT_LOGINS || "")
    .split(",")
    .map((login) => login.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_CLAWSWEEPER_BOT_LOGINS);
}

function closedStats(items, since) {
  const byRepo = {};
  let issues = 0;
  let prs = 0;
  for (const item of items) {
    const repoStats = byRepo[item.repository] || { total: 0, issues: 0, prs: 0 };
    repoStats.total += 1;
    if (item.type === "PR") {
      prs += 1;
      repoStats.prs += 1;
    } else {
      issues += 1;
      repoStats.issues += 1;
    }
    byRepo[item.repository] = repoStats;
  }
  return {
    window_hours: CLOSED_STATS_HOURS,
    since,
    total: items.length,
    issues,
    prs,
    by_repository: byRepo,
  };
}

function emptyClosedStats(generatedAt) {
  return {
    window_hours: CLOSED_STATS_HOURS,
    since: new Date(Date.parse(generatedAt) - CLOSED_STATS_HOURS * 60 * 60 * 1000).toISOString(),
    total: 0,
    issues: 0,
    prs: 0,
    by_repository: {},
  };
}

function firstAutomergeCommandAt(comments) {
  if (!Array.isArray(comments)) return null;
  const command = comments.find((comment) =>
    /@clawsweeper\s+auto\s*-?\s*merge|@clawsweeper\s+automerge|\/clawsweeper\s+auto\s*-?\s*merge|\/clawsweeper\s+automerge/i.test(
      String(comment.body || ""),
    ),
  );
  return command?.created_at || null;
}

async function readCachedSnapshot(env, ttlSeconds) {
  if (!env.STATUS_STORE) return null;
  const text = await readStatusStoreText(env.STATUS_STORE, "snapshot");
  if (!text) return null;
  const snapshot = JSON.parse(text);
  if (Date.now() - Date.parse(snapshot.generated_at || "") > ttlSeconds * 1000) return null;
  return snapshot;
}

async function readEvents(env) {
  const parsed = await readStoredJson(env, "events");
  return Array.isArray(parsed) ? parsed : [];
}

async function writeCiStatus(env, ci) {
  await writeStoredJson(
    env,
    ciStatusKey(ci.repository, ci.item_number),
    ci,
    numberFrom(env.CI_STATUS_TTL_SECONDS, CI_STATUS_TTL_SECONDS),
  );
}

async function readCiStatus(env, repository, itemNumber) {
  if (!repository || !itemNumber) return null;
  const ci = await readStoredJson(env, ciStatusKey(repository, itemNumber));
  if (!ci) return null;
  if (
    Date.now() - Date.parse(ci.updated_at || ci.received_at || "") >
    numberFrom(env.CI_STATUS_TTL_SECONDS, CI_STATUS_TTL_SECONDS) * 1000
  ) {
    return null;
  }
  return ci;
}

function ciStatusKey(repository, itemNumber) {
  return `ci:${repository}#${itemNumber}`;
}

async function readStoredJson(env, key) {
  if (env.STATUS_STORE) {
    const text = await readStatusStoreText(env.STATUS_STORE, key);
    return text ? JSON.parse(text) : null;
  }
  const cached = await caches.default.match(storeCacheRequest(key));
  return cached ? cached.json() : null;
}

async function writeStoredJson(
  env,
  key,
  value,
  ttlSeconds = numberFrom(env.STORE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS),
) {
  const body = JSON.stringify(value);
  if (env.STATUS_STORE) {
    await writeStatusStoreText(env.STATUS_STORE, key, body, ttlSeconds);
    return;
  }
  await caches.default.put(
    storeCacheRequest(key),
    new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttlSeconds}`,
      },
    }),
  );
}

async function prependStoredEvent(env, event) {
  const store = env.STATUS_STORE;
  if (isDurableStatusStore(store)) {
    const response = await durableStatusStoreStub(store).fetch(
      statusStoreRequest("events", "POST"),
      {
        method: "POST",
        body: JSON.stringify({
          event,
          limit: EVENT_LIMIT,
          ttl_seconds: EVENT_STORE_TTL_SECONDS,
        }),
      },
    );
    if (!response.ok) throw new Error(`status store event write failed: ${response.status}`);
    return;
  }
  const current = await readEvents(env);
  await writeStoredJson(
    env,
    "events",
    [event, ...current].slice(0, EVENT_LIMIT),
    EVENT_STORE_TTL_SECONDS,
  );
}

async function readStatusStoreText(store, key) {
  if (!isDurableStatusStore(store)) return store.get(key);
  const response = await durableStatusStoreStub(store).fetch(statusStoreRequest(key));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`status store read failed: ${response.status}`);
  return response.text();
}

async function writeStatusStoreText(store, key, value, ttlSeconds?) {
  if (!isDurableStatusStore(store)) {
    return store.put(key, value, ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  }
  const response = await durableStatusStoreStub(store).fetch(statusStoreRequest(key, "PUT"), {
    method: "PUT",
    body: JSON.stringify({
      value,
      ...(ttlSeconds ? { expires_at: Date.now() + ttlSeconds * 1000 } : {}),
    }),
  });
  if (!response.ok) throw new Error(`status store write failed: ${response.status}`);
}

function isDurableStatusStore(store) {
  return Boolean(
    store && typeof store.idFromName === "function" && typeof store.get === "function",
  );
}

function durableStatusStoreStub(store) {
  return store.get(store.idFromName("global"));
}

function statusStoreRequest(key, method = "GET") {
  return new Request(`https://clawsweeper-status-store/${encodeURIComponent(key)}`, { method });
}

function storeCacheRequest(key) {
  return new Request(`https://clawsweeper.internal/store/${encodeURIComponent(key)}`, {
    method: "GET",
  });
}

async function githubJson(env, path) {
  const token = await githubAuthToken(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const response = await fetch(`https://api.github.com${path}`, {
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-clawsweeper-status",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

async function githubGraphql(env, query, variables) {
  const token = await githubAuthToken(env);
  if (!token) throw new Error("GitHub auth is required for GraphQL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), OPTIONAL_SECTION_TIMEOUT_MS);
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-status",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`);
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  return payload.data;
}

function hasGithubAuth(env) {
  return Boolean(env.GITHUB_TOKEN || githubAppCredentials(env));
}

async function githubAuthToken(env) {
  if (env.GITHUB_TOKEN) return String(env.GITHUB_TOKEN);
  const credentials = githubAppCredentials(env);
  if (!credentials) return "";

  const now = Date.now();
  const repos = triageTargetRepos(env);
  const cacheKey = [
    credentials.issuer,
    credentials.installationId || repos[0] || "",
    repos.join(","),
  ].join("|");
  if (
    githubAppTokenCache?.key === cacheKey &&
    githubAppTokenCache.expiresAtMs - GITHUB_APP_TOKEN_REFRESH_SKEW_MS > now
  ) {
    return githubAppTokenCache.token;
  }
  if (githubAppTokenCache?.key === cacheKey && githubAppTokenCache.promise) {
    return githubAppTokenCache.promise;
  }

  const promise = createGithubAppInstallationToken(env, credentials, repos)
    .then((result) => {
      githubAppTokenCache = {
        key: cacheKey,
        token: result.token,
        expiresAtMs: result.expiresAtMs,
      };
      return result.token;
    })
    .catch((error) => {
      githubAppTokenCache = null;
      throw error;
    });
  githubAppTokenCache = {
    key: cacheKey,
    token: "",
    expiresAtMs: 0,
    promise,
  };
  return promise;
}

function githubAppCredentials(env) {
  const issuer = stringEnv(env.CLAWSWEEPER_APP_ID) || stringEnv(env.CLAWSWEEPER_APP_CLIENT_ID);
  const privateKey = normalizePrivateKey(env.CLAWSWEEPER_APP_PRIVATE_KEY);
  if (!issuer || !privateKey) return null;
  return {
    issuer,
    privateKey,
    installationId: stringEnv(env.CLAWSWEEPER_APP_INSTALLATION_ID),
  };
}

async function createGithubAppInstallationToken(env, credentials, repos) {
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId =
    credentials.installationId || (await githubAppInstallationId(appJwt, repos[0]));
  const payload = await githubAppJson(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: "POST",
      body: JSON.stringify({
        permissions: {
          actions: "read",
          checks: "read",
          contents: "read",
          issues: "read",
          pull_requests: "read",
        },
      }),
      errorLabel: "GitHub App token",
    },
  );
  const token = String(payload.token || "");
  if (!token) throw new Error("GitHub App token response missing token");
  const expiresAtMs = payload.expires_at
    ? Date.parse(payload.expires_at)
    : Date.now() + GITHUB_APP_TOKEN_DEFAULT_TTL_MS;
  return { token, expiresAtMs };
}

async function githubAppInstallationId(appJwt, repo) {
  if (!repo || !repo.includes("/")) throw new Error("GitHub App installation repo is required");
  const payload = await githubAppJson(`/repos/${repo}/installation`, appJwt, {
    errorLabel: "GitHub App installation",
  });
  const installationId = Number(payload.id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`GitHub App installation response missing id for ${repo}`);
  }
  return String(installationId);
}

async function githubAppJson(path, appJwt, options: GithubAppJsonOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-status",
      Authorization: `Bearer ${appJwt}`,
    },
    body: options.body,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`${options.errorLabel || "GitHub App"} ${response.status}`);
  return response.json();
}

async function signGithubAppJwt(issuer, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }));
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function normalizePrivateKey(value) {
  return stringEnv(value)?.replace(/\\n/g, "\n") || "";
}

function pemToPkcs8(pem) {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  if (!pkcs1) throw new Error("GitHub App private key must be PEM encoded");
  return wrapPkcs1PrivateKey(pkcs1);
}

function pemBody(pem, label) {
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "m");
  const match = String(pem).match(pattern);
  if (!match) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function wrapPkcs1PrivateKey(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetString = derElement(0x04, pkcs1);
  return derElement(0x30, concatBytes(version, algorithm, octetString));
}

function derElement(tag, value) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length) {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base64UrlEncode(value) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringEnv(value) {
  const text = String(value || "").trim();
  return text ? text : "";
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function normalizeEvent(body) {
  const itemNumber = numberOrNull(body.item_number);
  const sourceItemNumber = numberOrNull(body.source_item_number);
  return {
    id: crypto.randomUUID(),
    received_at: new Date().toISOString(),
    event_type: stringField(body.event_type, "status.event"),
    mode: stringField(body.mode, "unknown"),
    stage: stringField(body.stage, "unknown"),
    status: stringField(body.status, "unknown"),
    repository: nullableString(body.repository),
    item_url: nullableString(body.item_url),
    run_url: nullableString(body.run_url),
    title: nullableString(body.title),
    ...(itemNumber === null ? {} : { item_number: itemNumber }),
    ...(sourceItemNumber === null ? {} : { source_item_number: sourceItemNumber }),
    source_item_url: nullableString(body.source_item_url),
    pr_url: nullableString(body.pr_url),
    work_kind: nullableString(body.work_kind),
    automatic: body.automatic === true || body.automatic === "true",
    cluster_id: nullableString(body.cluster_id),
    duration_ms: numberOrNull(body.duration_ms),
    note: nullableString(body.note),
  };
}

function normalizeCiStatus(body) {
  const ci =
    body.ci && typeof body.ci === "object"
      ? body.ci
      : body.event_type === "ci.status"
        ? body
        : null;
  if (!ci) return null;
  const repository = nullableString(ci.repository ?? body.repository);
  const itemNumber = numberOrNull(ci.item_number ?? body.item_number);
  if (!repository || !Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  const state = normalizeCiState(ci.state ?? ci.status ?? body.status);
  return {
    state,
    source: stringField(ci.source ?? body.source, "stored"),
    label: nullableString(ci.label),
    repository,
    item_number: itemNumber,
    item_url:
      nullableString(ci.item_url ?? body.item_url) ||
      `https://github.com/${repository}/pull/${itemNumber}`,
    run_url: nullableString(ci.run_url ?? body.run_url),
    head_sha: nullableString(ci.head_sha ?? body.head_sha),
    total: Math.max(0, numberOrNull(ci.total) ?? 0),
    failing: Math.max(0, numberOrNull(ci.failing) ?? 0),
    pending: Math.max(0, numberOrNull(ci.pending) ?? 0),
    updated_at: nullableString(ci.updated_at) || new Date().toISOString(),
    received_at: new Date().toISOString(),
  };
}

function normalizeCiState(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["green", "success", "passed", "pass"].includes(text)) return "green";
  if (
    [
      "red",
      "failure",
      "failed",
      "error",
      "timed_out",
      "action_required",
      "cancelled",
      "startup_failure",
    ].includes(text)
  )
    return "red";
  if (["pending", "queued", "waiting", "requested", "in_progress", "running"].includes(text))
    return "pending";
  return "unknown";
}

function workflowRunSummary(run) {
  return {
    id: run.id,
    workflow: run.name,
    title: run.display_title || run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    started_at: run.created_at,
    updated_at: run.updated_at,
  };
}

function codexJobName(name) {
  return /review|codex|repair|worker|commit/i.test(name);
}

function laneRank(mode) {
  return (
    {
      automerge: 0,
      repair: 1,
      "exact-review": 2,
      "hot-review": 3,
      apply: 4,
      "commit-review": 5,
      "background-review": 6,
    }[mode] ?? 9
  );
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function stringField(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function nullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberFrom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function json(value, status = 200) {
  return cors(
    new Response(JSON.stringify(value, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function html(value) {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization,content-type");
  return response;
}

function issueTriagePageConfig() {
  return {
    title: "ClawSweeper Triage",
    loadingSubtitle: "Loading advisory issue labels...",
    endpoint: "/api/triage",
    storagePrefix: "clawsweeper:triage",
    defaultView: "clawsweeper",
    navLabel: "Issue triage views",
    filterPlaceholder: "Title, number, author, assignee, label...",
    itemNoun: "issue",
    itemLabel: "Issue",
    emptySnapshotText: "No matching issues in the current snapshot.",
    emptyFilterText: "No issues match the current filter.",
    routingGroups: true,
    highlightLabelPrefixes: ["clawsweeper:"],
    links: [
      { href: "/", label: "Live pipeline" },
      { href: "/pr-proof-triage", label: "PR proof triage" },
    ],
    columns: [
      { key: "issue", label: "Issue", width: 420, min: 240 },
      { key: "assignees", label: "Assignees", width: 140, min: 100 },
      { key: "priority", label: "Priority", width: 92, min: 76 },
      { key: "area", label: "Impact group", width: 180, min: 130 },
      { key: "prs", label: "Linked PRs", width: 180, min: 120 },
      { key: "labels", label: "Labels", width: 430, min: 220 },
      { key: "updated", label: "Updated", width: 130, min: 110 },
      { key: "comments", label: "Comments", width: 96, min: 84 },
    ],
    metrics: [
      {
        label: "ClawSweeper issues",
        view: "clawsweeper",
        detail: "any discovered clawsweeper label",
      },
      { label: "Ready candidates", view: "ready-candidates", detail: "queueable and unblocked" },
      { label: "Blocked queue", view: "queueable-blocked", detail: "queueable but no-new-fix-pr" },
      { label: "Linked PRs", view: "already-has-pr", detail: "open fix PR already found" },
      {
        label: "Needs review",
        view: "needs-maintainer-review",
        detail: "maintainer decision next",
      },
      { label: "Product/security", view: "product-security", detail: "policy or security call" },
    ],
  };
}

function prProofTriagePageConfig() {
  return {
    title: "ClawSweeper PR Proof Triage",
    loadingSubtitle: "Loading pull request proof labels...",
    endpoint: "/api/pr-proof-triage",
    storagePrefix: "clawsweeper:pr-proof-triage",
    defaultView: "missing-proof",
    navLabel: "Pull request proof triage views",
    filterPlaceholder: "Title, number, author, assignee, proof state, label...",
    itemNoun: "PR",
    itemLabel: "Pull request",
    emptySnapshotText: "No matching pull requests in the current snapshot.",
    emptyFilterText: "No pull requests match the current filter.",
    routingGroups: false,
    highlightLabelPrefixes: ["triage:", "proof:", "mantis:"],
    links: [
      { href: "/", label: "Live pipeline" },
      { href: "/triage", label: "Issue triage" },
    ],
    columns: [
      { key: "issue", label: "Pull request", width: 420, min: 240 },
      { key: "author", label: "Author", width: 130, min: 100 },
      { key: "assignees", label: "Assignees", width: 140, min: 100 },
      { key: "priority", label: "Priority", width: 86, min: 76 },
      { key: "proof", label: "Proof state", width: 180, min: 140 },
      { key: "labels", label: "Labels", width: 430, min: 220 },
      { key: "updated", label: "Updated", width: 130, min: 110 },
      { key: "comments", label: "Comments", width: 96, min: 84 },
    ],
    metrics: [
      { label: "Proof triage PRs", view: "proof-triage", detail: "proof-related labels" },
      { label: "Needs proof", view: "needs-proof", detail: "real behavior proof requested" },
      { label: "Needs proof review", view: "missing-proof", detail: "most stuck bucket" },
      {
        label: "Proof sufficient",
        view: "sufficient-proof",
        detail: "proof gate appears satisfied",
      },
      { label: "Mock-only proof", view: "mock-only-proof", detail: "needs stronger proof" },
    ],
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );
}

function externalHttpUrl(value, fallback) {
  try {
    const url = new URL(String(value ?? "").trim() || fallback);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function serializedPageConfig(config) {
  return JSON.stringify(config).replace(/</g, "\\u003c");
}

function triageHtml(config) {
  const pageConfig = serializedPageConfig(config);
  const routingGroupControl = config.routingGroups
    ? `<label class="field">
        <span>Impact group</span>
        <select id="routing-group">
          <option value="">All impact groups</option>
        </select>
      </label>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.title)}</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0a0e14;
  --panel: #111821;
  --panel-2: #151f2b;
  --line: #2a3646;
  --text: #e7edf5;
  --muted: #9aa8ba;
  --blue: #67b7ff;
  --green: #4ed891;
  --amber: #f3b759;
  --red: #f46d75;
  --violet: #b99cff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  background-image:
    radial-gradient(circle at 20% 80%, rgba(103, 183, 255, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 80% 20%, rgba(78, 216, 145, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 40% 40%, rgba(185, 156, 255, 0.02) 0%, transparent 50%);
  background-attachment: fixed;
  color: var(--text);
  font: 14px/1.45 "Avenir Next", "Helvetica Neue", sans-serif;
  letter-spacing: 0;
}
main { width: min(1560px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 48px; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 28px; line-height: 1.1; letter-spacing: 0; }
h2 { margin: 24px 0 12px; font-size: 16px; font-weight: 600; letter-spacing: 0; }
a { color: var(--blue); text-decoration: none; }
a:hover { color: #89c8ff; text-decoration: underline; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.top-links { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.pill,
.tab,
.query-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 3px 10px;
  border-radius: 12px;
  background: #1a2532;
  border: 1px solid #2a3646;
  color: var(--text);
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
}
.query-link { color: var(--blue); }
.grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.metric {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px 16px;
  min-height: 88px;
  overflow: hidden;
}
.metric strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 8px; font-weight: 700; }
.metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
.tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 12px;
  padding-bottom: 8px;
}
button.tab {
  cursor: pointer;
  font: inherit;
}
button.tab[aria-selected="true"] {
  background: rgba(103, 183, 255, 0.16);
  border-color: rgba(103, 183, 255, 0.55);
}
.view-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin: 12px 0;
}
.view-title { display: grid; gap: 3px; min-width: 0; }
.view-title strong { font-size: 18px; }
.controls {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 12px;
  flex-wrap: wrap;
}
.control-group {
  display: flex;
  align-items: end;
  gap: 10px;
  flex-wrap: wrap;
}
.field {
  display: grid;
  gap: 5px;
  min-width: 220px;
}
.field span {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
input,
select,
.secondary-button {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #0d131b;
  color: var(--text);
  padding: 7px 10px;
  font: inherit;
}
input { min-width: min(460px, calc(100vw - 40px)); }
select { min-width: 190px; }
input:focus,
select:focus,
.secondary-button:focus {
  outline: 2px solid rgba(103, 183, 255, 0.4);
  outline-offset: 1px;
}
.secondary-button {
  cursor: pointer;
  min-width: 70px;
  font-weight: 600;
}
.table-wrap {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
}
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
}
th,
td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
th {
  position: relative;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  background: #0d131b;
  font-weight: 600;
  letter-spacing: 0.05em;
}
tbody tr:hover { background: rgba(103, 183, 255, 0.03); }
tr:last-child td { border-bottom: 0; }
.issue-cell { display: grid; gap: 4px; min-width: 0; }
.issue-title {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.25;
  font-weight: 650;
}
.label-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.assignee-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.pr-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.label-pill,
.priority-filter {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.16);
  background: #1a2532;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
}
.label-pill.clawsweeper { border-color: rgba(103, 183, 255, 0.35); }
.label-pill.highlight { border-color: rgba(103, 183, 255, 0.35); }
.label-pill:hover,
.priority-filter:hover {
  border-color: rgba(103, 183, 255, 0.55);
  color: #ffffff;
}
.priority-filter {
  border-color: rgba(243, 183, 89, 0.42);
  background: rgba(243, 183, 89, 0.1);
  color: var(--amber);
}
.assignee-pill {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(103, 183, 255, 0.28);
  background: rgba(103, 183, 255, 0.1);
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.pr-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 19px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.16);
  background: #1a2532;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.pr-chip.open { border-color: rgba(78, 216, 145, 0.45); color: var(--green); }
.pr-chip.merged { border-color: rgba(185, 156, 255, 0.45); color: var(--violet); }
.pr-chip.closed { border-color: rgba(244, 109, 117, 0.45); color: var(--red); }
.resize-handle {
  position: absolute;
  top: 0;
  right: -4px;
  width: 8px;
  height: 100%;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}
.resize-handle::after {
  content: "";
  position: absolute;
  top: 22%;
  bottom: 22%;
  left: 3px;
  width: 1px;
  background: transparent;
}
.resize-handle:hover::after,
body.resizing-col .resize-handle::after {
  background: rgba(103, 183, 255, 0.55);
}
body.resizing-col {
  cursor: col-resize;
  user-select: none;
}
.priority { color: var(--amber); }
.empty,
.error {
  padding: 24px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  text-align: center;
}
.error { color: var(--red); border-color: rgba(244,109,117,0.35); }
@media (max-width: 1280px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } header, .view-head { align-items: start; flex-direction: column; } .top-links { justify-content: flex-start; } }
@media (max-width: 760px) { main { width: min(100vw - 20px, 1560px); padding-top: 16px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(config.title)}</h1>
      <div class="muted" id="subtitle">${escapeHtml(config.loadingSubtitle)}</div>
    </div>
    <div class="top-links">
      ${config.links.map((link) => `<a class="pill" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")}
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="grid" id="metrics"></section>
  <section class="controls" id="controls">
    <div class="control-group">
      <label class="field">
        <span>Filter</span>
        <input id="issue-filter" type="search" placeholder="${escapeHtml(config.filterPlaceholder)}">
      </label>
      <button class="secondary-button" id="clear-filter" type="button">Clear</button>
      ${routingGroupControl}
      <label class="field">
        <span>Sort</span>
        <select id="issue-sort">
          <option value="created-desc">Newest ${escapeHtml(config.itemNoun)} first</option>
          <option value="created-asc">Oldest ${escapeHtml(config.itemNoun)} first</option>
          <option value="number-desc">Highest ${escapeHtml(config.itemNoun)} number first</option>
          <option value="number-asc">Lowest ${escapeHtml(config.itemNoun)} number first</option>
          <option value="updated-desc">Recently updated first</option>
          <option value="updated-asc">Least recently updated first</option>
          <option value="comments-desc">Most comments first</option>
          <option value="comments-asc">Fewest comments first</option>
        </select>
      </label>
    </div>
    <span class="muted mono" id="visible-count">Showing 0 loaded</span>
  </section>
  <nav class="tabs" id="tabs" aria-label="${escapeHtml(config.navLabel)}"></nav>
  <section class="view-head">
    <div class="view-title">
      <strong id="view-name">Loading</strong>
      <span class="muted" id="view-description"></span>
    </div>
    <a class="query-link" id="github-query" href="https://github.com/issues" target="_blank" rel="noreferrer">Open GitHub query</a>
  </section>
  <section id="table"></section>
  <h2>Diagnostics</h2>
  <section id="diagnostics" class="muted"></section>
</main>
<script>
const PAGE = ${pageConfig};
const fmt = new Intl.NumberFormat();
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const COLUMN_ORDER = PAGE.columns.map(column => column.key);
const COLUMN_LABELS = Object.fromEntries(PAGE.columns.map(column => [column.key, column.label]));
const COLUMN_DEFAULTS = Object.fromEntries(PAGE.columns.map(column => [column.key, column.width]));
const COLUMN_MIN = Object.fromEntries(PAGE.columns.map(column => [column.key, column.min]));
function storageGet(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
let state = null;
let activeView = location.hash.replace(/^#/, "") || storageGet(PAGE.storagePrefix + ":view") || PAGE.defaultView;
let activeGroup = PAGE.routingGroups
  ? new URLSearchParams(location.search).get("group") || storageGet(PAGE.storagePrefix + ":group")
  : "";
let filterText = storageGet(PAGE.storagePrefix + ":filter");
let sortMode = storageGet(PAGE.storagePrefix + ":sort") || "created-desc";
let filterTimer = null;
let columnWidths = loadColumnWidths();
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function loadColumnWidths() {
  let saved = {};
  try {
    saved = JSON.parse(storageGet(PAGE.storagePrefix + ":columns") || "{}");
  } catch {
    saved = {};
  }
  return Object.fromEntries(COLUMN_ORDER.map(key => {
    const width = Number(saved[key]);
    return [key, Math.max(COLUMN_MIN[key], Number.isFinite(width) ? width : COLUMN_DEFAULTS[key])];
  }));
}
function saveColumnWidths() {
  storageSet(PAGE.storagePrefix + ":columns", JSON.stringify(columnWidths));
}
function tableWidth() {
  return COLUMN_ORDER.reduce((total, key) => total + columnWidths[key], 0);
}
function columnPercent(key) {
  const total = Math.max(1, tableWidth());
  return ((columnWidths[key] / total) * 100).toFixed(3) + "%";
}
function colgroupHtml() {
  return COLUMN_ORDER.map(key => '<col data-col="' + esc(key) + '" style="width:' + esc(columnPercent(key)) + '">').join("");
}
function headerCell(key) {
  const label = COLUMN_LABELS[key] || key;
  return '<th><span>' + esc(label) + '</span><span class="resize-handle" role="separator" aria-label="Resize ' + esc(label) + ' column" data-resize-col="' + esc(key) + '"></span></th>';
}
function tableHeaderHtml() {
  return COLUMN_ORDER.map(headerCell).join("");
}
function applyColumnWidths() {
  const table = document.querySelector("#table table");
  if (table) table.style.width = "100%";
  document.querySelectorAll("#table col[data-col]").forEach(col => {
    const key = col.getAttribute("data-col");
    if (columnWidths[key]) col.style.width = columnPercent(key);
  });
}
function since(iso) {
  const diff = Date.parse(iso) - Date.now();
  const minutes = Math.round(diff / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (Math.abs(minutes) < 90) return rel.format(minutes, "minute");
  return rel.format(Math.round(minutes / 60), "hour");
}
function compact(value) {
  return String(value ?? "").replace(/\\s+/g, " ").trim();
}
function updateLocation() {
  const url = new URL(location.href);
  if (PAGE.routingGroups && activeGroup) url.searchParams.set("group", activeGroup);
  else url.searchParams.delete("group");
  url.hash = activeView;
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
function metric(label, count, detail) {
  return '<article class="metric"><span>' + esc(label) + '</span><strong>' + esc(fmt.format(count || 0)) + '</strong><div class="muted">' + esc(detail || "") + '</div></article>';
}
function labelPill(label) {
  const name = label.name || String(label);
  const color = label.color ? '#' + label.color : '';
  const style = color ? ' style="background: color-mix(in srgb, ' + esc(color) + ' 22%, #1a2532); border-color: color-mix(in srgb, ' + esc(color) + ' 55%, #2a3646);"' : '';
  const highlighted = (PAGE.highlightLabelPrefixes || []).some(prefix => name.startsWith(prefix));
  const cls = highlighted ? "label-pill highlight" : "label-pill";
  return '<button class="' + cls + '" type="button" data-filter-value="' + esc(name) + '"' + style + ' title="Filter by ' + esc(name) + '">' + esc(name) + '</button>';
}
function assigneePills(row) {
  const assignees = Array.isArray(row.assignees) ? row.assignees : [];
  if (!assignees.length) return '<span class="muted">Unassigned</span>';
  return assignees.map(assignee => '<span class="assignee-pill">' + esc(assignee) + '</span>').join("");
}
function linkedPullRequestPills(row) {
  const prs = Array.isArray(row.linked_pull_requests) ? row.linked_pull_requests : [];
  if (!prs.length) return '<span class="muted">-</span>';
  return prs
    .map((pr) => {
      const state = pr.state || "unknown";
      const label = state.toUpperCase() + " #" + pr.number;
      return '<a class="pr-chip ' + esc(state) + '" href="' + esc(pr.url) + '" target="_blank" rel="noreferrer" title="' + esc(pr.repository + "#" + pr.number + ": " + pr.title) + '">' + esc(label) + '</a>';
    })
    .join("");
}
function priorityFor(row) {
  return (row.labels || []).map(label => label.name).find(name => /^P[0-3]$/.test(name || "")) || "";
}
function routingGroupPills(row) {
  const groups = Array.isArray(row.routing_groups) ? row.routing_groups : [];
  if (!groups.length) return '<span class="muted">Unclassified</span>';
  return groups.map(group =>
    '<button class="label-pill" type="button" data-group-value="' + esc(group.id) +
    '" title="Show ' + esc(group.title) + '">' + esc(group.title) + '</button>'
  ).join("");
}
function searchableText(row) {
  const assignees = row.assignees || [];
  return [
    row.title,
    row.repository,
    "#" + row.number,
    row.number,
    row.author,
    ...(assignees.length ? assignees : ["unassigned"]),
    ...(row.linked_pull_requests || []).flatMap(pr => [
      pr.repository,
      "#" + pr.number,
      pr.title,
      pr.state,
    ]),
    priorityFor(row),
    row.proof_state,
    ...(row.routing_groups || []).flatMap(group => [group.id, group.title]),
    ...(row.labels || []).map(label => label.name)
  ].join(" ").toLowerCase();
}
function filteredRows(rows) {
  const terms = filterText.toLowerCase().split(/\\s+/).filter(Boolean);
  const grouped = activeGroup
    ? rows.filter(row => (row.routing_groups || []).some(group => group.id === activeGroup))
    : rows.slice();
  const visible = terms.length
    ? grouped.filter(row => terms.every(term => searchableText(row).includes(term)))
    : grouped;
  return visible.sort(compareRows);
}
function compareRows(left, right) {
  if (sortMode === "created-asc") return Date.parse(left.created_at || "") - Date.parse(right.created_at || "");
  if (sortMode === "number-desc") return Number(right.number || 0) - Number(left.number || 0);
  if (sortMode === "number-asc") return Number(left.number || 0) - Number(right.number || 0);
  if (sortMode === "updated-desc") return Date.parse(right.updated_at || "") - Date.parse(left.updated_at || "");
  if (sortMode === "updated-asc") return Date.parse(left.updated_at || "") - Date.parse(right.updated_at || "");
  if (sortMode === "comments-desc") return Number(right.comments || 0) - Number(left.comments || 0);
  if (sortMode === "comments-asc") return Number(left.comments || 0) - Number(right.comments || 0);
  return Date.parse(right.created_at || "") - Date.parse(left.created_at || "");
}
function renderTabs(views) {
  document.getElementById("tabs").innerHTML = views.map(view =>
    '<button class="tab" type="button" data-view="' + esc(view.id) + '" aria-selected="' + (view.id === activeView ? "true" : "false") + '">' +
    esc(view.title) + ' <span class="muted">' + esc(fmt.format(view.total_count || 0)) + '</span></button>'
  ).join("");
  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view;
      storageSet(PAGE.storagePrefix + ":view", activeView);
      updateLocation();
      render();
    });
  });
}
function renderMetrics(views) {
  const byId = Object.fromEntries(views.map(view => [view.id, view.total_count || 0]));
  document.getElementById("metrics").innerHTML = PAGE.metrics.map(item =>
    metric(item.label, byId[item.view], item.detail)
  ).join("");
}
function renderTable(view) {
  document.getElementById("view-name").textContent = view.title + " (" + fmt.format(view.total_count || 0) + ")";
  document.getElementById("view-description").textContent = view.description || "";
  const query = document.getElementById("github-query");
  const githubUrl = routingGroupGithubUrl(view);
  query.href = githubUrl || "https://github.com/issues";
  query.style.display = githubUrl ? "inline-flex" : "none";
  renderRows(view);
}
function routingGroupGithubUrl(view) {
  if (!view.github_url || !activeGroup) return view.github_url || "";
  const group = (state?.routing_groups || []).find(candidate => candidate.id === activeGroup);
  if (!group || group.labels?.length !== 1) return "";
  const url = new URL(view.github_url);
  const query = url.searchParams.get("q") || "";
  url.searchParams.set("q", query + ' label:"' + group.labels[0] + '"');
  return url.toString();
}
function authorCell(row) {
  return row.author ? '<button class="label-pill" type="button" data-filter-value="' + esc(row.author) + '" title="Filter by ' + esc(row.author) + '">' + esc(row.author) + '</button>' : '<span class="muted">Unknown</span>';
}
function proofStateCell(row) {
  return row.proof_state ? '<button class="priority-filter" type="button" data-filter-value="' + esc(row.proof_state) + '" title="Filter by ' + esc(row.proof_state) + '">' + esc(row.proof_state) + '</button>' : '<span class="muted">-</span>';
}
function rowCellHtml(key, row) {
  if (key === "issue") {
    const itemLabel = row.repository + "#" + row.number;
    return '<div class="issue-cell"><a class="issue-title" href="' + esc(row.url) + '" target="_blank" rel="noreferrer">' + esc(compact(row.title)) + '</a><span class="muted mono">' + esc(itemLabel) + (row.author ? " opened by " + esc(row.author) : "") + '</span></div>';
  }
  if (key === "author") return authorCell(row);
  if (key === "assignees") return '<div class="assignee-list">' + assigneePills(row) + '</div>';
  if (key === "priority") {
    const priority = priorityFor(row);
    return priority
      ? '<button class="priority-filter" type="button" data-filter-value="' + esc(priority) + '" title="Filter by ' + esc(priority) + '">' + esc(priority) + '</button>'
      : '<span class="muted">-</span>';
  }
  if (key === "proof") return proofStateCell(row);
  if (key === "area") return '<div class="label-list">' + routingGroupPills(row) + '</div>';
  if (key === "prs") return '<div class="pr-list">' + linkedPullRequestPills(row) + '</div>';
  if (key === "labels") return '<div class="label-list">' + (row.labels || []).map(labelPill).join("") + '</div>';
  if (key === "updated") return '<span title="' + esc(row.updated_at || "") + '">' + esc(since(row.updated_at)) + '</span>';
  if (key === "comments") return esc(fmt.format(row.comments || 0));
  return "";
}
function renderRows(view) {
  const rows = filteredRows(view.items || []);
  const visibleCount = document.getElementById("visible-count");
  if (visibleCount) {
    const loaded = (view.items || []).length;
    const total = view.total_count || loaded;
    const limit = view.item_limit || state?.source?.item_limit_per_view || loaded;
    const totalText = total > loaded ? " \\u00b7 " + fmt.format(total) + " total" : "";
    visibleCount.textContent =
      "Showing " +
      fmt.format(rows.length) +
      " of " +
      fmt.format(loaded) +
      " loaded" +
      totalText +
      " \u00b7 max " +
      fmt.format(limit) +
      " for this view";
  }
  if (!view.items || !view.items.length) {
    document.getElementById("table").innerHTML = '<div class="empty">' + esc(PAGE.emptySnapshotText) + '</div>';
    return;
  }
  if (!rows.length) {
    document.getElementById("table").innerHTML = '<div class="empty">' + esc(PAGE.emptyFilterText) + '</div>';
    return;
  }
  const tableRows = rows.map(row => {
    return '<tr>' +
      COLUMN_ORDER.map(key => '<td>' + rowCellHtml(key, row) + '</td>').join("") +
      '</tr>';
  }).join("");
  document.getElementById("table").innerHTML =
    '<div class="table-wrap"><table><colgroup>' +
    colgroupHtml() +
    '</colgroup><thead><tr>' + tableHeaderHtml() + '</tr></thead><tbody>' +
    tableRows +
    '</tbody></table></div>';
}
function currentView() {
  const views = state?.views || [];
  return views.find(view => view.id === activeView) || views[0] || null;
}
function renderRoutingGroupControl(view) {
  if (!PAGE.routingGroups) return;
  const select = document.getElementById("routing-group");
  const groups = state?.routing_groups || [];
  if (activeGroup && !groups.some(group => group.id === activeGroup)) {
    activeGroup = "";
    storageSet(PAGE.storagePrefix + ":group", "");
    updateLocation();
  }
  const counts = view?.loaded_routing_group_counts || {};
  select.innerHTML = '<option value="">All impact groups</option>' + groups.map(group =>
    '<option value="' + esc(group.id) + '">' + esc(group.title) +
    ' (' + esc(fmt.format(counts[group.id] || 0)) + ')</option>'
  ).join("");
  select.value = activeGroup;
}
function initControls() {
  const input = document.getElementById("issue-filter");
  const sort = document.getElementById("issue-sort");
  input.value = filterText;
  sort.value = sortMode;
  const routingGroup = document.getElementById("routing-group");
  input.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterText = input.value;
      storageSet(PAGE.storagePrefix + ":filter", filterText);
      const view = currentView();
      if (view) renderRows(view);
    }, 80);
  });
  document.getElementById("clear-filter").addEventListener("click", () => {
    filterText = "";
    input.value = "";
    storageSet(PAGE.storagePrefix + ":filter", filterText);
    const view = currentView();
    if (view) renderRows(view);
    input.focus();
  });
  sort.addEventListener("change", event => {
    sortMode = event.target.value;
    storageSet(PAGE.storagePrefix + ":sort", sortMode);
    const view = currentView();
    if (view) renderRows(view);
  });
  if (routingGroup) {
    routingGroup.addEventListener("change", event => {
      activeGroup = event.target.value;
      storageSet(PAGE.storagePrefix + ":group", activeGroup);
      updateLocation();
      render();
    });
  }
  document.getElementById("table").addEventListener("click", event => {
    const groupTarget = event.target.closest("[data-group-value]");
    if (groupTarget) {
      activeGroup = groupTarget.getAttribute("data-group-value") || "";
      storageSet(PAGE.storagePrefix + ":group", activeGroup);
      updateLocation();
      render();
      return;
    }
    const target = event.target.closest("[data-filter-value]");
    if (!target) return;
    filterText = target.getAttribute("data-filter-value") || "";
    input.value = filterText;
    storageSet(PAGE.storagePrefix + ":filter", filterText);
    const view = currentView();
    if (view) renderRows(view);
    input.focus();
  });
  document.getElementById("table").addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-resize-col]");
    if (!handle) return;
    event.preventDefault();
    const key = handle.getAttribute("data-resize-col");
    if (!COLUMN_ORDER.includes(key)) return;
    const startX = event.clientX;
    const startWidth = columnWidths[key] || COLUMN_DEFAULTS[key];
    document.body.classList.add("resizing-col");
    const onMove = moveEvent => {
      columnWidths[key] = Math.round(Math.max(COLUMN_MIN[key], startWidth + moveEvent.clientX - startX));
      applyColumnWidths();
    };
    const onUp = () => {
      document.body.classList.remove("resizing-col");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      saveColumnWidths();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}
function renderDiagnostics(data) {
  const errors = data.diagnostics?.errors || [];
  document.getElementById("diagnostics").innerHTML = errors.length
    ? '<div class="error">' + errors.map(esc).join("<br>") + '</div>'
    : '<div class="empty">No dashboard diagnostics in this snapshot.</div>';
}
function render() {
  if (!state) return;
  const views = state.views || [];
  if (!views.find(view => view.id === activeView) && views.length) activeView = views[0].id;
  document.getElementById("subtitle").textContent = (state.source?.target_repositories || []).join(", ") + " - read-only GitHub Search snapshot";
  document.getElementById("updated").textContent = "Updated " + since(state.generated_at);
  renderMetrics(views);
  renderTabs(views);
  const view = views.find(view => view.id === activeView) || views[0] || {};
  renderRoutingGroupControl(view);
  renderTable(view);
  renderDiagnostics(state);
}
async function load() {
  try {
    const response = await fetch(PAGE.endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(PAGE.endpoint + " returned " + response.status);
    state = await response.json();
    render();
  } catch (error) {
    document.getElementById("subtitle").textContent = "Failed to load triage data: " + error.message;
    document.getElementById("table").innerHTML = '<div class="error">' + esc(error.message) + '</div>';
  }
}
initControls();
load();
setInterval(load, 120000);
</script>
</body>
</html>`;
}

function dashboardHtml(env: DashboardEnv = {}) {
  const crabfleetUrl = externalHttpUrl(env.CLAWSWEEPER_CRABFLEET_URL, DEFAULT_CRABFLEET_URL);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🦞 ClawSweeper Live</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0a0e14;
  --panel: #111821;
  --panel-2: #151f2b;
  --line: #2a3646;
  --text: #e7edf5;
  --muted: #9aa8ba;
  --blue: #67b7ff;
  --green: #4ed891;
  --amber: #f3b759;
  --red: #f46d75;
  --violet: #b99cff;
  --accent: #ff7a66;
}
* { box-sizing: border-box; }
@keyframes wave {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-3px) rotate(1deg); }
}
@keyframes bubble {
  0% { transform: translateY(0) scale(1); opacity: 0.05; }
  50% { opacity: 0.08; }
  100% { transform: translateY(-400px) scale(1.2); opacity: 0; }
}
body {
  margin: 0;
  background: var(--bg);
  background-image:
    radial-gradient(circle at 20% 80%, rgba(103, 183, 255, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 80% 20%, rgba(78, 216, 145, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 40% 40%, rgba(185, 156, 255, 0.02) 0%, transparent 50%);
  background-attachment: fixed;
  color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
  position: relative;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed;
  bottom: -50px;
  left: -50px;
  right: -50px;
  height: 120px;
  background: radial-gradient(ellipse at bottom, rgba(103, 183, 255, 0.05) 0%, transparent 70%);
  animation: wave 8s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
}
main { width: min(1440px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 48px; position: relative; z-index: 1; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.1;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 10px;
}
h1::before { content: "🦞"; font-size: 32px; animation: wave 3s ease-in-out infinite; }
h2 {
  margin: 28px 0 12px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.muted { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.metric {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px 16px;
  min-height: 92px;
  position: relative;
  overflow: hidden;
  transition: all 0.2s ease;
}
.metric:hover {
  border-color: rgba(103, 183, 255, 0.4);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.metric::before {
  content: "";
  position: absolute;
  top: -2px;
  right: -2px;
  width: 40px;
  height: 40px;
  background: radial-gradient(circle, rgba(103, 183, 255, 0.08) 0%, transparent 70%);
  border-radius: 0 16px 0 100%;
  pointer-events: none;
}
.metric strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 8px; font-weight: 700; }
.metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
.band { height: 7px; margin-top: 12px; background: #1a2532; border-radius: 999px; overflow: hidden; position: relative; }
.band::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
  animation: shimmer 2s infinite;
}
@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.band > i { display: block; height: 100%; background: var(--blue); width: 0; transition: width 0.6s ease; }
.overview-shell {
  margin-top: 18px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background:
    linear-gradient(135deg, rgba(103, 183, 255, 0.06), transparent 42%),
    var(--panel);
  box-shadow: inset 0 1px rgba(255,255,255,0.025);
}
.overview-head,
.automatic-head,
.workers-head,
.worker-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.overview-head h2,
.automatic-head h2,
.workers-head h2 { margin: 0; }
.flow-map {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  margin-top: 16px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--line);
}
.flow-node {
  min-width: 0;
  min-height: 112px;
  padding: 14px;
  background: #0d141d;
  position: relative;
}
.flow-node:not(:last-child)::after {
  content: "›";
  position: absolute;
  z-index: 2;
  right: -8px;
  top: calc(50% - 15px);
  width: 16px;
  height: 30px;
  display: grid;
  place-items: center;
  color: var(--blue);
  background: var(--line);
  font: 20px/1 ui-monospace, monospace;
}
.flow-node span {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.11em;
}
.flow-node strong {
  display: block;
  margin-top: 7px;
  font-size: 25px;
  line-height: 1;
}
.flow-node p {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
}
.capacity-rail {
  display: grid;
  grid-template-columns: repeat(16, minmax(0, 1fr));
  gap: 4px;
  margin-top: 14px;
}
.capacity-slot {
  height: 8px;
  border-radius: 2px;
  background: #26313e;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
}
.capacity-slot.active {
  background: var(--green);
  box-shadow: 0 0 12px rgba(78,216,145,0.32);
}
.capacity-slot.waiting {
  background: var(--amber);
  box-shadow: 0 0 12px rgba(243,183,89,0.25);
}
.capacity-legend {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 11px;
}
.capacity-legend i,
.status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  background: #526172;
}
.capacity-legend .active,
.status-dot.active { background: var(--green); }
.capacity-legend .waiting,
.status-dot.waiting { background: var(--amber); }
.status-dot.done { background: var(--green); }
.status-dot.failed { background: var(--red); }
.automatic-head { margin-top: 24px; }
.automatic-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 12px;
}
.automatic-card {
  appearance: none;
  display: grid;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 13px;
  text-align: left;
  color: var(--text);
  background:
    linear-gradient(135deg, rgba(185,156,255,0.08), transparent 55%),
    #0d141d;
  border: 1px solid var(--line);
  border-radius: 14px;
  cursor: pointer;
  font: inherit;
  transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.automatic-card:hover,
.automatic-card:focus-visible {
  transform: translateY(-1px);
  border-color: rgba(185,156,255,0.65);
  background: #111b27;
  outline: none;
}
.automatic-card-top,
.automatic-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.automatic-title {
  display: -webkit-box;
  overflow: hidden;
  color: #f0eaff;
  font-weight: 650;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.automatic-card-meta {
  color: var(--muted);
  font-size: 12px;
}
.workers-head { margin-top: 24px; }
.worker-toolbar { margin-top: 10px; align-items: flex-start; }
.worker-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-button {
  appearance: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 10px;
  background: #0d141d;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.filter-button:hover,
.filter-button.active {
  color: var(--text);
  border-color: rgba(103,183,255,0.55);
  background: rgba(103,183,255,0.1);
}
.worker-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 12px;
}
.worker-card {
  appearance: none;
  width: 100%;
  min-width: 0;
  padding: 13px;
  text-align: left;
  color: var(--text);
  background: #0d141d;
  border: 1px solid var(--line);
  border-radius: 14px;
  cursor: pointer;
  font: inherit;
  transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.worker-card:hover,
.worker-card:focus-visible {
  transform: translateY(-1px);
  border-color: rgba(103,183,255,0.6);
  background: #111b27;
  outline: none;
}
.worker-card-top,
.worker-card-meta,
.worker-card-step {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.worker-card-top { justify-content: space-between; }
.worker-name {
  margin: 10px 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
}
.worker-card-meta {
  color: var(--muted);
  font-size: 12px;
}
.worker-card-meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-target-title {
  display: -webkit-box;
  margin-top: 7px;
  overflow: hidden;
  color: #dcecff;
  font-size: 13px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.worker-target-ref { flex: 0 0 auto; }
.worker-card-step {
  margin-top: 11px;
  color: var(--blue);
  font-size: 12px;
}
.worker-card-step span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-progress {
  height: 3px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: #22303e;
}
.worker-progress i {
  display: block;
  height: 100%;
  background: var(--blue);
}
dialog {
  width: min(680px, calc(100vw - 28px));
  max-height: calc(100vh - 28px);
  margin: 14px 14px 14px auto;
  padding: 0;
  color: var(--text);
  background: #0c121a;
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: 0 28px 90px rgba(0,0,0,0.55);
}
dialog::backdrop {
  background: rgba(3,7,12,0.72);
  backdrop-filter: blur(5px);
}
.drawer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  max-height: calc(100vh - 30px);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 20px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(135deg, rgba(103,183,255,0.09), transparent 55%);
}
.drawer-head h3 {
  margin: 9px 0 0;
  font-size: 22px;
  line-height: 1.2;
}
.drawer-close {
  appearance: none;
  width: 34px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: var(--text);
  background: #111b27;
  cursor: pointer;
  font-size: 18px;
}
.drawer-body {
  min-height: 0;
  padding: 20px;
  overflow: auto;
}
.drawer-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.drawer-stat {
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
}
.drawer-stat span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.drawer-stat strong {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.drawer-links { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.step-list {
  display: grid;
  gap: 0;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.step-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 37px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(42,54,70,0.65);
}
.step-row:last-child { border-bottom: 0; }
.step-mark {
  width: 9px;
  height: 9px;
  border: 2px solid #526172;
  border-radius: 50%;
}
.step-row.completed .step-mark { border-color: var(--green); background: var(--green); }
.step-row.in_progress .step-mark {
  border-color: var(--blue);
  background: var(--blue);
  box-shadow: 0 0 0 5px rgba(103,183,255,0.12);
}
.step-row.queued .step-mark,
.step-row.pending .step-mark,
.step-row.waiting .step-mark { border-color: var(--amber); }
.step-row strong { font-size: 12px; font-weight: 550; }
.step-row span { color: var(--muted); font-size: 11px; }
table {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}
th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
td { overflow-wrap: anywhere; }
th {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  background: #0d131b;
  font-weight: 600;
  letter-spacing: 0.05em;
}
tbody tr { transition: background-color 0.15s ease; }
tbody tr:hover { background: rgba(103, 183, 255, 0.03); }
tr:last-child td { border-bottom: 0; }
a { color: var(--blue); text-decoration: none; transition: color 0.15s ease; }
a:hover { color: #89c8ff; text-decoration: underline; }
.top-links { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 3px 10px;
  border-radius: 12px;
  background: #1a2532;
  border: 1px solid #2a3646;
  color: var(--text);
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
  transition: all 0.15s ease;
}
.pill:hover { border-color: rgba(103, 183, 255, 0.4); }
.green { color: var(--green); }
.amber { color: var(--amber); }
.red { color: var(--red); }
.violet { color: var(--violet); }
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 420px);
  gap: 24px;
  align-items: start;
}
.split > div,
.split > aside,
.left-col { min-width: 0; }
.left-col {
  display: grid;
  gap: 0;
  align-content: start;
}
.pipeline-col { overflow: hidden; }
.cluster-col,
.side-col { min-width: 0; }
.cluster-col-mobile { display: none; }
#pipeline,
#automerge,
#closed,
#events {
  min-width: 0;
  overflow: hidden;
  border-radius: 14px;
}
.work-list,
.side-list {
  display: grid;
  gap: 8px;
}
.work-row,
.side-row {
  display: grid;
  gap: 12px;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.work-row {
  grid-template-columns: minmax(0, 1fr) minmax(210px, 260px) 82px;
  align-items: center;
  padding: 12px 14px;
}
.cluster-marker-row {
  grid-template-columns: minmax(0, 1fr) minmax(210px, 260px);
}
.side-row {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  padding: 11px 12px;
}
.work-row:hover,
.side-row:hover {
  border-color: rgba(103, 183, 255, 0.35);
  background: rgba(103, 183, 255, 0.03);
}
.work-main,
.side-main {
  min-width: 0;
}
.row-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.item-link {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.work-title,
.side-title {
  display: -webkit-box;
  margin-top: 4px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.work-state {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.stage-block {
  display: grid;
  justify-items: end;
  gap: 2px;
  min-width: 74px;
}
.run-link {
  color: var(--blue);
}
.timebox {
  display: grid;
  justify-items: end;
  gap: 2px;
  white-space: nowrap;
}
.timebox strong {
  font-size: 18px;
  line-height: 1;
}
.timebox span,
.side-meta {
  color: var(--muted);
  font-size: 12px;
}
.side-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  white-space: nowrap;
}
.closed-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.closed-stat {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 10px 12px;
  min-width: 0;
}
.closed-stat span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.closed-stat strong {
  display: block;
  margin-top: 4px;
  font-size: 22px;
  line-height: 1;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.empty {
  padding: 24px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  text-align: center;
  font-style: italic;
}
.empty::before { content: "🦀 "; opacity: 0.3; }
@media (max-width: 1280px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .split { grid-template-columns: 1fr; } .left-col { order: 1; } .side-col { order: 2; } .cluster-col-desktop { display: none; } .cluster-col-mobile { display: block; order: 3; } header { align-items: start; flex-direction: column; } .top-links { justify-content: flex-start; } .worker-grid, .automatic-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) { .flow-map { grid-template-columns: 1fr; } .flow-node { min-height: 0; } .flow-node:not(:last-child)::after { content: "⌄"; right: 18px; top: auto; bottom: -16px; } }
@media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .work-row { grid-template-columns: 1fr; align-items: start; } .work-state, .stage-block, .timebox { justify-content: start; justify-items: start; } .worker-grid, .automatic-grid { grid-template-columns: 1fr; } .worker-toolbar { align-items: stretch; flex-direction: column; } }
@media (max-width: 560px) { main { width: min(100vw - 20px, 1440px); padding-top: 16px; } .grid, .closed-stats, .drawer-grid { grid-template-columns: 1fr; } .side-row { grid-template-columns: 1fr; } .side-meta { justify-content: flex-start; } .overview-shell { padding: 13px; } .capacity-rail { grid-template-columns: repeat(8, minmax(0, 1fr)); } dialog { margin: 7px; max-height: calc(100vh - 14px); } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>ClawSweeper Live</h1>
      <div class="muted" id="subtitle">🌊 Loading pipeline state...</div>
    </div>
    <div class="top-links">
      <a class="pill" href="/triage">Issue triage</a>
      <a class="pill" href="/pr-proof-triage">PR proof triage</a>
      <a class="pill" href="${escapeHtml(crabfleetUrl)}">Live terminals</a>
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="grid" id="metrics"></section>
  <section class="overview-shell" aria-labelledby="system-overview-title">
    <div class="overview-head">
      <h2 id="system-overview-title">System Overview</h2>
      <span class="muted" id="overview-note">Live control-plane telemetry</span>
    </div>
    <div class="flow-map" id="flow-map"></div>
    <div class="capacity-rail" id="capacity-rail"></div>
    <div class="capacity-legend">
      <span><i class="active"></i>running</span>
      <span><i class="waiting"></i>waiting</span>
      <span><i></i>available</span>
    </div>
    <div class="automatic-head">
      <h2>Automatic Builds</h2>
      <span class="muted" id="automatic-summary"></span>
    </div>
    <div id="automatic-work"></div>
    <div class="workers-head">
      <h2>Active Workers</h2>
      <span class="muted" id="worker-summary"></span>
    </div>
    <div class="worker-toolbar">
      <div class="worker-filters" id="worker-filters" aria-label="Filter workers"></div>
      <span class="muted">Select a worker for its live step timeline.</span>
    </div>
    <div id="workers"></div>
  </section>
  <section class="split">
    <div class="left-col">
      <div class="pipeline-col">
        <h2>🌀 Active Pipeline</h2>
        <div id="pipeline"></div>
      </div>
      <div class="cluster-col cluster-col-desktop">
        <h2>🔎 Cluster Intake</h2>
        <div class="cluster-repair"></div>
      </div>
    </div>
    <aside class="side-col">
      <h2>⚡ Automerge Speed</h2>
      <div id="automerge"></div>
      <h2>✅ Closed by ClawSweeper</h2>
      <div id="closed-stats"></div>
      <div id="closed"></div>
      <h2>🩺 Worker Health</h2>
      <div id="worker-health"></div>
      <h2>🧭 Operations</h2>
      <div id="operations"></div>
      <h2>📡 Recent Activity</h2>
      <div id="events"></div>
    </aside>
    <div class="cluster-col cluster-col-mobile">
      <h2>🔎 Cluster Intake</h2>
      <div class="cluster-repair"></div>
    </div>
  </section>
</main>
<dialog id="worker-dialog" aria-labelledby="worker-dialog-title">
  <div class="drawer">
    <div class="drawer-head">
      <div id="worker-dialog-heading"></div>
      <button class="drawer-close" id="worker-dialog-close" type="button" aria-label="Close worker details">×</button>
    </div>
    <div class="drawer-body" id="worker-dialog-body"></div>
  </div>
</dialog>
<script>
const fmt = new Intl.NumberFormat();
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function elapsed(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 90) return s + "s";
  const m = Math.round(s / 60);
  if (m < 90) return m + "m";
  return Math.round(m / 60) + "h";
}
function since(iso) {
  const diff = Date.parse(iso) - Date.now();
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 90) return rel.format(minutes, "minute");
  return rel.format(Math.round(minutes / 60), "hour");
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function link(url, label) {
  return url ? '<a href="' + esc(url) + '">' + esc(label || url) + '</a>' : esc(label || "");
}
function linkClass(url, label, className) {
  return url ? '<a class="' + esc(className || "") + '" href="' + esc(url) + '">' + esc(label || url) + '</a>' : esc(label || "");
}
function compactText(value) {
  return String(value ?? "")
    .replace(/\\b([0-9a-f]{10})[0-9a-f]{22,}\\b/gi, "$1")
    .replace(/[\\t\\n\\r\\f ]+/g, " ")
    .trim();
}
function pipelineItemLabel(row) {
  if (row.repository && row.item_number) {
    return linkClass("https://github.com/" + row.repository + "/issues/" + row.item_number, row.repository + "#" + row.item_number, "item-link");
  }
  return '<span class="item-link">' + esc(compactText(row.title)) + '</span>';
}
function pipelineItemDetail(row) {
  if (row.repository && row.item_number) return compactText(row.title);
  const workflow = compactText(row.workflow);
  const title = compactText(row.title);
  return workflow && workflow !== title ? workflow : "";
}
function modeLabel(mode) {
  return {
    "background-review": "bg-review",
    "commit-review": "commit",
    "exact-review": "exact",
    "hot-review": "hot",
  }[mode] || mode;
}
function metric(label, value, sub, pct, color) {
  return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><div class="muted">' + esc(sub || "") + '</div><div class="band"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%;background:' + (color || "var(--blue)") + '"></i></div></div>';
}
function ciBadge(ci) {
  if (!ci) return '<span class="pill">ci unknown</span>';
  const cls = ci.state === "green" ? "green" : ci.state === "red" ? "red" : ci.state === "pending" ? "amber" : "";
  const prefix = ci.source === "workflow" ? "run" : "checks";
  const detail = ci.total ? " " + esc(ci.failing || 0) + "/" + esc(ci.pending || 0) + "/" + esc(ci.total || 0) : "";
  return '<span class="pill ' + cls + '" title="' + esc(ci.label || ci.source || "") + '">' + esc(prefix) + " " + esc(ci.state) + detail + '</span>';
}
let lastData = null;
let loading = false;
let activeWorkerFilter = "all";
let workerIndex = new Map();
let automaticIndex = new Map();

function workerGroup(worker) {
  const text = (worker.mode + " " + worker.name + " " + worker.workflow_title).toLowerCase();
  if (worker.work_kind === "issue_to_pr") return "issue-to-pr";
  if (worker.work_kind === "pr_repair") return "pr-repair";
  if (text.includes("assist")) return "assist";
  if (text.includes("repair") || text.includes("automerge")) return "repair";
  if (text.includes("commit")) return "commit";
  if (text.includes("review")) return "review";
  return "other";
}
function workerKindLabel(kind) {
  if (kind === "issue_to_pr") return "Issue to PR";
  if (kind === "pr_repair") return "PR repair";
  if (kind === "repair_cluster") return "Repair cluster";
  return "";
}
function workerStatusClass(status) {
  if (["in_progress", "running"].includes(status)) return "active";
  if (["queued", "waiting", "requested", "pending"].includes(status)) return "waiting";
  if (["completed", "success"].includes(status)) return "done";
  if (["blocked", "failed", "failure", "cancelled"].includes(status)) return "failed";
  return "";
}
function workerTarget(worker) {
  if (worker.repository && worker.item_numbers?.length) {
    return worker.repository + "#" + worker.item_numbers.join(", #");
  }
  if (worker.repository && worker.item_number) return worker.repository + "#" + worker.item_number;
  if (worker.repository) return worker.repository;
  return compactText(worker.workflow_title || worker.name);
}
function workerTargetTitle(worker) {
  const targets = (worker.target_items || []).filter(target => compactText(target.title));
  if (!targets.length) return "";
  const title = compactText(targets[0].title);
  return targets.length > 1 ? title + " +" + (targets.length - 1) + " more" : title;
}
function renderSystemMap(data) {
  const workers = data.workers || [];
  const pipeline = data.pipeline || [];
  const fleet = data.fleet || {};
  const workerRunIds = new Set(workers.map(worker => String(worker.run_id)));
  const planning = pipeline.filter(row => !workerRunIds.has(String(row.id))).length;
  const applying = pipeline.filter(row => row.mode === "apply" || row.mode === "automerge").length;
  const closed = data.recent?.closed_stats?.total || 0;
  const nodes = [
    ["01 · Intake", fleet.queued_workflow_runs || 0, "Events and scheduled sweeps waiting to start"],
    ["02 · Plan", planning, "Runs selecting work or expanding a matrix"],
    ["03 · Workers", workers.length, "Codex jobs reviewing, repairing, or assisting"],
    ["04 · Apply", applying, "Deterministic comment, close, merge, and publish lanes"],
    ["05 · Results", closed, (data.recent?.closed_stats?.window_hours || 24) + "h ClawSweeper closes"]
  ];
  document.getElementById("flow-map").innerHTML = nodes.map(node =>
    '<div class="flow-node"><span>' + esc(node[0]) + '</span><strong>' + fmt.format(node[1]) + '</strong><p>' + esc(node[2]) + '</p></div>'
  ).join("");
  const running = workers.filter(worker => worker.status === "in_progress").length;
  const waiting = workers.length - running;
  const budget = Math.max(0, fleet.worker_budget || 0);
  document.getElementById("capacity-rail").innerHTML = Array.from({ length: budget }, (_, index) => {
    const state = index < running ? " active" : index < running + waiting ? " waiting" : "";
    return '<i class="capacity-slot' + state + '"></i>';
  }).join("");
  const fallbacks = fleet.worker_detail_fallbacks || 0;
  document.getElementById("overview-note").textContent = fallbacks
    ? "Live jobs with " + fallbacks + " workflow fallback" + (fallbacks === 1 ? "" : "s")
    : "Live GitHub job and step telemetry";
}
function renderWorkers(rows) {
  workerIndex = new Map(rows.map(worker => [String(worker.id), worker]));
  const groups = ["issue-to-pr", "pr-repair", "review", "repair", "commit", "assist", "other"];
  const counts = Object.fromEntries(groups.map(group => [group, rows.filter(worker => workerGroup(worker) === group).length]));
  const filters = [["all", "All", rows.length], ...groups.filter(group => counts[group]).map(group => [group, group[0].toUpperCase() + group.slice(1), counts[group]])];
  if (!filters.some(filter => filter[0] === activeWorkerFilter)) activeWorkerFilter = "all";
  document.getElementById("worker-filters").innerHTML = filters.map(filter =>
    '<button type="button" class="filter-button' + (filter[0] === activeWorkerFilter ? " active" : "") + '" data-worker-filter="' + esc(filter[0]) + '">' + esc(filter[1]) + " " + fmt.format(filter[2]) + '</button>'
  ).join("");
  const visible = activeWorkerFilter === "all" ? rows : rows.filter(worker => workerGroup(worker) === activeWorkerFilter);
  document.getElementById("worker-summary").textContent = fmt.format(rows.length) + " active · " + fmt.format(rows.filter(worker => worker.status === "in_progress").length) + " running";
  if (!visible.length) {
    document.getElementById("workers").innerHTML = '<div class="empty">No workers match this view.</div>';
    return;
  }
  document.getElementById("workers").innerHTML = '<div class="worker-grid">' + visible.map(worker => {
    const progress = worker.progress?.total ? Math.round((worker.progress.completed / worker.progress.total) * 100) : 0;
    const kind = workerKindLabel(worker.work_kind);
    const targetTitle = workerTargetTitle(worker);
    return '<button type="button" class="worker-card" data-worker-id="' + esc(worker.id) + '" aria-label="Open details for ' + esc(targetTitle || worker.name) + '"><div class="worker-card-top"><span><span class="pill"><i class="status-dot ' + workerStatusClass(worker.status) + '"></i>' + esc(modeLabel(worker.mode)) + '</span>' + (kind ? ' <span class="pill">' + esc(kind) + '</span>' : '') + '</span><span class="muted mono">' + elapsed(worker.elapsed_ms) + '</span></div><div class="worker-name">' + esc(worker.name) + '</div><div class="worker-card-meta"><span class="worker-target-ref">' + esc(workerTarget(worker)) + '</span></div>' + (targetTitle ? '<div class="worker-target-title" title="' + esc(targetTitle) + '">' + esc(targetTitle) + '</div>' : '') + '<div class="worker-card-step"><span>↳ ' + esc(worker.current_step || worker.stage) + '</span></div><div class="worker-progress"><i style="width:' + progress + '%"></i></div></button>';
  }).join("") + '</div>';
}
function renderAutomaticWork(rows) {
  automaticIndex = new Map(rows.map(row => [String(row.id), row]));
  const active = rows.filter(row => row.active || ["queued", "running", "in_progress"].includes(row.status)).length;
  document.getElementById("automatic-summary").textContent =
    fmt.format(rows.length) + " recent · " + fmt.format(active) + " active";
  if (!rows.length) {
    document.getElementById("automatic-work").innerHTML =
      '<div class="empty">No automatic issue builds have started yet.</div>';
    return;
  }
  document.getElementById("automatic-work").innerHTML =
    '<div class="automatic-grid">' +
    rows.map(row => {
      const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
      return '<button type="button" class="automatic-card" data-automatic-id="' + esc(row.id) +
        '" aria-label="Open automatic build details for ' + esc(row.title) + '">' +
        '<div class="automatic-card-top"><span class="pill"><i class="status-dot ' +
        workerStatusClass(row.status) + '"></i>' + esc(phase) + '</span><span class="muted">' +
        esc(row.updated_at ? since(row.updated_at) : "") + '</span></div>' +
        '<div class="automatic-title">' + esc(row.title || "Issue #" + row.issue_number) + '</div>' +
        '<div class="automatic-card-meta"><span>' + esc(row.repository + "#" + row.issue_number) +
        '</span><span>' + esc(row.pr_url ? "PR opened" : row.active ? "worker active" : row.status) +
        '</span></div></button>';
    }).join("") +
    '</div>';
}
function renderWorkerDialog(worker) {
  const dialog = document.getElementById("worker-dialog");
  const statusClass = workerStatusClass(worker.status);
  document.getElementById("worker-dialog-heading").innerHTML = '<div><span class="pill"><i class="status-dot ' + statusClass + '"></i>' + esc(worker.status) + '</span> <span class="pill">' + esc(modeLabel(worker.mode)) + '</span></div><h3 id="worker-dialog-title">' + esc(worker.name) + '</h3><div class="muted">' + esc(compactText(worker.workflow_title)) + '</div>';
  const targetItems = new Map((worker.target_items || []).map(target => [Number(target.number), target]));
  const targetUrls = worker.repository
    ? (worker.item_numbers || (worker.item_number ? [worker.item_number] : [])).map(number => ({
        url: targetItems.get(Number(number))?.url || "https://github.com/" + worker.repository + "/" + (worker.work_kind === "pr_repair" ? "pull" : "issues") + "/" + number,
        label: "#" + number + (targetItems.get(Number(number))?.title ? " · " + compactText(targetItems.get(Number(number)).title) : "")
      }))
    : [];
  const stepRows = (worker.steps || []).map(step => '<li class="step-row ' + esc(step.status) + '"><i class="step-mark"></i><strong>' + esc(step.name) + '</strong><span>' + esc(step.conclusion || step.status) + '</span></li>').join("");
  document.getElementById("worker-dialog-body").innerHTML =
    '<div class="drawer-grid">' +
      '<div class="drawer-stat"><span>Current step</span><strong>' + esc(worker.current_step || worker.stage) + '</strong></div>' +
      '<div class="drawer-stat"><span>Elapsed</span><strong>' + elapsed(worker.elapsed_ms) + '</strong></div>' +
      '<div class="drawer-stat"><span>Target</span><strong>' + esc(workerTarget(worker)) + '</strong></div>' +
      '<div class="drawer-stat"><span>Progress</span><strong>' + fmt.format(worker.progress?.completed || 0) + " / " + fmt.format(worker.progress?.total || 0) + ' steps</strong></div>' +
    '</div>' +
    '<div class="drawer-links">' +
      linkClass(worker.job_url, "Open job", "pill run-link") +
      linkClass(worker.run_url, "Open workflow run", "pill run-link") +
      targetUrls.map(target => linkClass(target.url, target.label, "pill run-link")).join("") +
    '</div>' +
    '<h2>Step Timeline</h2>' +
    (stepRows ? '<ol class="step-list">' + stepRows + '</ol>' : '<div class="empty">Job-level steps are unavailable; showing workflow fallback telemetry.</div>');
  if (!dialog.open) dialog.showModal();
  history.replaceState(null, "", "#worker-" + encodeURIComponent(worker.id));
}
function renderAutomaticDialog(row) {
  const dialog = document.getElementById("worker-dialog");
  const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
  document.getElementById("worker-dialog-heading").innerHTML =
    '<div><span class="pill"><i class="status-dot ' + workerStatusClass(row.status) + '"></i>' +
    esc(row.status) + '</span> <span class="pill">Automatic issue build</span></div>' +
    '<h3 id="worker-dialog-title">' + esc(row.title) + '</h3>' +
    '<div class="muted">' + esc(row.repository + "#" + row.issue_number) + '</div>';
  const timeline = (row.timeline || []).map(entry =>
    '<li class="step-row ' + esc(entry.status) + '"><i class="step-mark"></i><strong>' +
    esc(compactText(entry.phase).replaceAll("_", " ")) + '</strong><span>' +
    esc(entry.received_at ? since(entry.received_at) : entry.status) + '</span>' +
    (entry.note ? '<div class="muted" style="grid-column:2 / -1">' + esc(entry.note) + '</div>' : '') +
    '</li>'
  ).join("");
  document.getElementById("worker-dialog-body").innerHTML =
    '<div class="drawer-grid">' +
      '<div class="drawer-stat"><span>Current phase</span><strong>' + esc(phase) + '</strong></div>' +
      '<div class="drawer-stat"><span>Status</span><strong>' + esc(row.status) + '</strong></div>' +
      '<div class="drawer-stat"><span>Source</span><strong>' + esc(row.repository + "#" + row.issue_number) + '</strong></div>' +
      '<div class="drawer-stat"><span>Updated</span><strong>' + esc(row.updated_at ? since(row.updated_at) : "unknown") + '</strong></div>' +
    '</div>' +
    '<div class="drawer-links">' +
      linkClass(row.issue_url, "Open issue", "pill run-link") +
      linkClass(row.run_url, "Open workflow run", "pill run-link") +
      linkClass(row.pr_url, "Open generated PR", "pill run-link") +
      (row.worker_id ? '<button type="button" class="filter-button" data-linked-worker-id="' + esc(row.worker_id) + '">Open live worker</button>' : '') +
    '</div>' +
    '<h2>Lifecycle Timeline</h2>' +
    (timeline ? '<ol class="step-list">' + timeline + '</ol>' : '<div class="empty">No lifecycle events recorded yet.</div>');
  if (!dialog.open) dialog.showModal();
  history.replaceState(null, "", "#automatic-" + encodeURIComponent(row.id));
}
function closeWorkerDialog() {
  const dialog = document.getElementById("worker-dialog");
  if (dialog.open) dialog.close();
  if (location.hash.startsWith("#worker-") || location.hash.startsWith("#automatic-")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}
function openWorkerFromHash() {
  if (location.hash.startsWith("#worker-")) {
    const worker = workerIndex.get(decodeURIComponent(location.hash.slice(8)));
    if (worker) renderWorkerDialog(worker);
    else if (document.getElementById("worker-dialog").open) closeWorkerDialog();
  } else if (location.hash.startsWith("#automatic-")) {
    const row = automaticIndex.get(decodeURIComponent(location.hash.slice(11)));
    if (row) renderAutomaticDialog(row);
    else if (document.getElementById("worker-dialog").open) closeWorkerDialog();
  }
}

try {
  lastData = JSON.parse(localStorage.getItem("clawsweeper:last-status") || "null");
  if (lastData) renderDashboard(lastData, "Showing cached status while refreshing...");
} catch {}

async function load() {
  if (loading) return;
  loading = true;
  let data;
  try {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error("/api/status returned " + response.status);
  data = await response.json();
  const cacheState = response.headers.get("x-clawsweeper-cache");
  const hasErrors = Boolean(data.diagnostics && Array.isArray(data.diagnostics.errors) && data.diagnostics.errors.length);
  const looksEmpty = !data.pipeline?.length && data.fleet?.active_workflow_runs === 0 && hasErrors;
  if (looksEmpty && lastData) {
    renderDashboard(lastData, "Live refresh failed; showing last good status.");
    return;
  }
  lastData = data;
  if (!looksEmpty) localStorage.setItem("clawsweeper:last-status", JSON.stringify(data));
  renderDashboard(
    data,
    cacheState === "stale"
      ? "Refreshing live status in the background."
      : hasErrors
        ? "Updated with partial GitHub telemetry."
        : "",
  );
  } catch (error) {
    if (lastData) {
      renderDashboard(lastData, "Live refresh failed; showing last good status.");
    } else {
      document.getElementById("subtitle").textContent = "Failed to load status: " + error.message;
    }
  } finally {
    loading = false;
  }
}

function renderDashboard(data, note) {
  document.getElementById("subtitle").textContent = data.source.target_repositories.join(", ");
  document.getElementById("updated").textContent = "Updated " + since(data.generated_at) + (note ? " \u00b7 " + note : "");
  const fleet = data.fleet;
  document.getElementById("metrics").innerHTML = [
    metric("🦾 Claw Workers", fmt.format(fleet.active_codex_jobs), "budget " + fleet.worker_budget, fleet.budget_used_percent, "var(--green)"),
    metric("🌊 Active Sweeps", fmt.format(fleet.active_workflow_runs), "support " + fmt.format(fleet.support_workflow_runs || 0), Math.min(100, fleet.active_workflow_runs * 3), "var(--blue)"),
    metric("⏳ Queue Depth", fmt.format(fleet.queued_workflow_runs), "support queue " + fmt.format(fleet.support_queued_workflow_runs || 0), Math.min(100, fleet.queued_workflow_runs * 10), "var(--amber)"),
    metric("💥 Error Rate", (data.health?.error_rate_percent || 0) + "%", fmt.format(data.health?.failed_attempts || 0) + " failed / " + fmt.format(data.health?.attempts || 0) + " attempts", Math.min(100, data.health?.error_rate_percent || 0), data.health?.failed_attempts ? "var(--red)" : "var(--green)"),
    metric("🛟 Recovery Rate", data.health?.recovery_rate_percent == null ? "n/a" : data.health.recovery_rate_percent + "%", fmt.format(data.health?.unresolved_failures || 0) + " unresolved", data.health?.recovery_rate_percent == null ? 100 : data.health.recovery_rate_percent, data.health?.unresolved_failures ? "var(--amber)" : "var(--green)"),
    metric("🎯 Capacity", fleet.budget_used_percent + "%", "fleet utilization", fleet.budget_used_percent, "var(--green)")
  ].join("");
  renderSystemMap(data);
  renderAutomaticWork(data.automatic_work || []);
  renderWorkers(data.workers || []);
  openWorkerFromHash();
  renderClusterRepair(data.recent?.cluster_repair);
  renderPipeline(data.pipeline || []);
  renderAutomerge(data.recent.automerge || []);
  renderClosedStats(data.recent.closed_stats);
  renderClosedItems(data.recent.closed_items || []);
  renderWorkerHealth(data.health);
  renderOperations(data.recent.operation_counts);
  renderEvents(data.recent.events || []);
}
function renderPipeline(rows) {
  if (!rows.length) {
    document.getElementById("pipeline").innerHTML = '<div class="empty">All quiet in the depths... no active sweeps</div>';
    return;
  }
  document.getElementById("pipeline").innerHTML = '<div class="work-list">' + rows.map(row => {
    const detail = pipelineItemDetail(row);
    return '<article class="work-row"><div class="work-main" title="' + esc(compactText(row.title)) + '"><div class="row-top"><span class="pill" title="' + esc(row.mode) + '">' + esc(modeLabel(row.mode)) + '</span>' + pipelineItemLabel(row) + '</div>' + (detail ? '<div class="muted work-title">' + esc(detail) + '</div>' : "") + '</div><div class="work-state"><div class="stage-block"><strong>' + esc(row.stage) + '</strong><span class="muted">' + esc(row.status) + '</span></div>' + ciBadge(row.ci) + linkClass(row.run_url, "run", "pill run-link") + '</div><div class="timebox"><strong>' + elapsed(row.elapsed_ms) + '</strong><span>elapsed</span></div></article>';
  }).join("") + '</div>';
}
function renderClusterRepair(cluster) {
  const targets = Array.from(document.querySelectorAll(".cluster-repair"));
  if (!targets.length) return;
  if (!cluster) {
    for (const target of targets) {
      target.innerHTML = '<div class="empty">No cluster intake telemetry in this snapshot.</div>';
    }
    return;
  }
  const markerRows = (cluster.markers || []).map(marker => {
    const jobs = (marker.generated_jobs || []).slice(0, 3).map(job => '<span class="pill mono">' + esc(job.split("/").pop() || job) + '</span>').join("");
    const jobText = marker.generated_count ? fmt.format(marker.generated_count) + " job" + (marker.generated_count === 1 ? "" : "s") : "no jobs";
    return '<article class="work-row cluster-marker-row"><div class="work-main"><div class="row-top"><span class="pill">' + esc(marker.status || "unknown") + '</span><span class="item-link">' + esc(marker.target_repo || "unknown repo") + '</span></div><div class="muted work-title">store ' + esc(marker.last_processed_store_short_sha || "unknown") + " · " + esc(jobText) + (marker.last_processed_store_exported_at ? " · exported " + esc(since(marker.last_processed_store_exported_at)) : "") + '</div><div class="row-top">' + jobs + '</div></div><div class="work-state"><div class="stage-block"><strong>' + esc(marker.updated_at ? since(marker.updated_at) : "never") + '</strong><span class="muted">marker</span></div>' + linkClass(marker.run_url, "run", "pill run-link") + '</div></article>';
  }).join("");
  const runRows = (cluster.latest_runs || []).slice(0, 3).map(run => '<article class="side-row"><div class="side-main">' + linkClass(run.url, compactText(run.title || run.workflow), "item-link") + '<div class="muted side-title">' + esc(run.status || "") + (run.conclusion ? " · " + esc(run.conclusion) : "") + '</div></div><div class="side-meta"><span>' + esc(run.started_at ? since(run.started_at) : "") + '</span></div></article>').join("");
  const activeText = fmt.format((cluster.active_intake_runs || []).length) + " intake · " + fmt.format((cluster.active_worker_runs || []).length) + " workers";
  const html =
    '<div class="split"><div class="pipeline-col"><div class="muted" style="margin-bottom:8px">Runs on ' + esc(cluster.workflow || "repair-cluster-intake.yml") + " · " + esc(activeText) + '</div><div class="work-list">' + (markerRows || '<div class="empty">No processed-store markers yet.</div>') + '</div></div><aside class="side-col"><div class="muted" style="margin-bottom:8px">Recent intake workflow runs</div><div class="side-list">' + (runRows || '<div class="empty">No intake runs found.</div>') + '</div></aside></div>';
  for (const target of targets) {
    target.innerHTML = html;
  }
}
function renderAutomerge(rows) {
  if (!rows.length) {
    document.getElementById("automerge").innerHTML = '<div class="empty">No automerge data yet... claws resting</div>';
    return;
  }
  document.getElementById("automerge").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main">' + linkClass(row.url, "#" + row.number, "item-link") + '<div class="muted side-title">' + esc(row.title) + '</div></div><div class="side-meta"><span class="pill violet">' + (row.duration_ms ? elapsed(row.duration_ms) : "unknown") + '</span><span>' + (row.merged_at ? since(row.merged_at) : "") + '</span></div></article>').join("") + '</div>';
}
function renderClosedItems(rows) {
  if (!rows.length) {
    document.getElementById("closed").innerHTML = '<div class="empty">No ClawSweeper closes found...</div>';
    return;
  }
  document.getElementById("closed").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main"><div class="row-top"><span class="pill">' + esc(row.type) + '</span>' + linkClass(row.url, row.repository + "#" + row.number, "item-link") + '</div><div class="muted side-title">' + esc(row.title) + '</div></div><div class="side-meta">' + since(row.closed_at) + '</div></article>').join("") + '</div>';
}
function renderClosedStats(stats) {
  const safe = stats || { total: 0, issues: 0, prs: 0, window_hours: 24 };
  document.getElementById("closed-stats").innerHTML = '<div class="closed-stats"><div class="closed-stat"><span>' + esc((safe.window_hours || 24) + "h total") + '</span><strong>' + fmt.format(safe.total || 0) + '</strong></div><div class="closed-stat"><span>Issues</span><strong>' + fmt.format(safe.issues || 0) + '</strong></div><div class="closed-stat"><span>PRs</span><strong>' + fmt.format(safe.prs || 0) + '</strong></div></div>';
}
function renderWorkerHealth(health) {
  const safe = health || { attempts: 0, failed_attempts: 0, recovered_failures: 0, unresolved_failures: 0, failures: [] };
  const stats = '<div class="closed-stats"><div class="closed-stat"><span>Attempts sampled</span><strong>' + fmt.format(safe.attempts || 0) + '</strong></div><div class="closed-stat"><span>Failed attempts</span><strong>' + fmt.format(safe.failed_attempts || 0) + '</strong></div><div class="closed-stat"><span>Recovered</span><strong>' + fmt.format(safe.recovered_failures || 0) + '</strong></div></div>';
  const rows = (safe.failures || []).map(failure => '<article class="side-row"><div class="side-main">' + linkClass(failure.url, compactText(failure.workflow_title || failure.job_name), "item-link") + '<div class="muted side-title">' + esc(failure.failed_step || failure.conclusion || "worker failure") + '</div></div><div class="side-meta"><span class="pill ' + (failure.recovered ? "" : "red") + '">' + (failure.recovered ? "recovered" : "unresolved") + '</span><span>' + esc(failure.started_at ? since(failure.started_at) : "") + '</span></div></article>').join("");
  document.getElementById("worker-health").innerHTML = stats + (rows ? '<div class="side-list">' + rows + '</div>' : '<div class="empty">No worker failures in the recent sample.</div>');
}
function renderOperations(counts) {
  const safe = counts || {};
  const rows = [
    ["Inherited labels", safe.inherited_label_cleanups || 0],
    ["Conflict self-heal", safe.self_heal_conflict_repairs || 0],
    ["Review retries", safe.failed_review_retries || 0],
    ["Retry exhausted", safe.failed_review_retry_exhaustions || 0],
    ["Proof decisions", safe.bot_owned_proof_decisions_requested || 0],
    ["Proof dispatches", safe.bot_owned_proof_dispatches || 0]
  ];
  document.getElementById("operations").innerHTML = '<div class="closed-stats">' + rows.map(row => '<div class="closed-stat"><span>' + esc(row[0]) + '</span><strong>' + fmt.format(row[1]) + '</strong></div>').join("") + '</div>';
}
function renderEvents(rows) {
  if (!rows.length) {
    document.getElementById("events").innerHTML = '<div class="empty">Listening for signals from the fleet...</div>';
    return;
  }
  document.getElementById("events").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main"><div class="row-top"><span class="pill">' + esc(row.mode) + '</span><span class="item-link">' + esc(row.stage) + '</span></div><div class="muted side-title">' + (row.item_url ? link(row.item_url, row.title || row.item_url) : esc(row.title || row.event_type)) + '</div></div><div class="side-meta"><span>' + esc(row.status) + '</span><span>' + since(row.received_at) + '</span></div></article>').join("") + '</div>';
}
document.getElementById("worker-filters").addEventListener("click", event => {
  const button = event.target.closest("button[data-worker-filter]");
  if (!button) return;
  activeWorkerFilter = button.dataset.workerFilter || "all";
  renderWorkers(lastData?.workers || []);
});
document.getElementById("workers").addEventListener("click", event => {
  const button = event.target.closest("button[data-worker-id]");
  if (!button) return;
  const worker = workerIndex.get(String(button.dataset.workerId));
  if (worker) renderWorkerDialog(worker);
});
document.getElementById("automatic-work").addEventListener("click", event => {
  const button = event.target.closest("button[data-automatic-id]");
  if (!button) return;
  const row = automaticIndex.get(String(button.dataset.automaticId));
  if (row) renderAutomaticDialog(row);
});
document.getElementById("worker-dialog-close").addEventListener("click", closeWorkerDialog);
document.getElementById("worker-dialog").addEventListener("click", event => {
  const linkedWorker = event.target.closest("button[data-linked-worker-id]");
  if (linkedWorker) {
    const worker = workerIndex.get(String(linkedWorker.dataset.linkedWorkerId));
    if (worker) renderWorkerDialog(worker);
    return;
  }
  if (event.target === event.currentTarget) closeWorkerDialog();
});
document.getElementById("worker-dialog").addEventListener("close", () => {
  if (location.hash.startsWith("#worker-") || location.hash.startsWith("#automatic-")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
});
window.addEventListener("hashchange", openWorkerFromHash);
load();
setInterval(load, 15000);
</script>
</body>
</html>`;
}
