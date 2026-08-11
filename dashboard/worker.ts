import {
  commandTextForClawSweeperFastAck,
  isClawSweeperReReviewCommandText,
} from "../src/repair/comment-command-text.ts";
import { isExactReviewCloseGuardLabel } from "../src/repair/exact-review-guard-labels.ts";
import { bayHtml } from "./bay-page.ts";
import {
  dashboardHtml,
  issueTriagePageConfig,
  prProofTriagePageConfig,
  triageHtml,
  type DashboardEnv,
} from "./dashboard-pages.ts";
import { liveActivityBaySnapshot } from "./live-activity.ts";
import { summarizeDashboardHealth } from "./dashboard-health.ts";
import {
  githubApiUrl,
  githubAppCredentials,
  githubAppInstallationIdAsPlainError as githubAppInstallationId,
  githubAppJsonAsPlainError as githubAppJson,
  signGithubAppJwt,
} from "./github-api.ts";
import {
  HEALTH_HISTORY_RETENTION_DAYS,
  exactReviewHistorySample,
  mergeHealthHistorySample,
  normalizeHealthHistorySample,
  stateWriterHistorySample,
  summarizeOperationalHealth,
} from "./operational-health.ts";
import { TRIAGE_ROUTING_GROUPS, triageRoutingGroupsForLabels } from "./triage-routing-groups.ts";
import {
  EXACT_REVIEW_QUEUE_NAME,
  EXACT_REVIEW_RECONCILE_CONCURRENCY,
  createGithubAppTokenFor,
  exactReviewActionsReadToken,
  exactReviewClaimedRuns,
  exactReviewRequestedRuns,
  exactReviewTerminalRun,
  exactReviewTerminalRuns,
  exactReviewTerminalRunsFromBatch,
  type DurableObjectNamespace,
  type DurableObjectStub,
  type ExactReviewClaimedRun,
  type ExactReviewCompletionOutcome,
  type ExactReviewDecision,
  type ExactReviewIngress,
} from "./exact-review-queue.ts";
import {
  AUTOMERGE_METRICS_EVENT_TYPE,
  AUTOMERGE_METRICS_EVENT_KEY_PREFIX,
  AUTOMERGE_METRICS_EVENT_ID_KEY_PREFIX,
  AUTOMERGE_METRICS_EVENT_LIMIT,
  AUTOMERGE_METRICS_SESSION_CONTEXT_MS,
  AUTOMERGE_METRICS_STORE_KEY,
  AUTOMERGE_METRICS_TTL_SECONDS,
  automergeMetricRange,
  automergeMetricRangeStart,
  normalizeAutomergeMetricEvent,
  summarizeAutomergeMetrics,
} from "./automerge-metrics.ts";
import {
  APPLY_OBSERVABILITY_IN_PROGRESS_MAX_SILENCE_MS,
  APPLY_OBSERVABILITY_RANGES,
  APPLY_OBSERVABILITY_RETENTION_MS,
  isCurrentApplyObservabilityEvent,
  normalizeApplyObservabilityEvent,
  summarizeApplyObservability,
} from "./apply-observability.ts";
import {
  STATE_BLOB_OPERATIONS,
  handleStateBlobRequest,
  type StateBlobOperation,
} from "./state-blobs.ts";

export {
  ExactReviewQueue,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewJitteredDelayMs,
  exactReviewPublicationCapacity,
  exactReviewPublicationCapacityForState,
  exactReviewQueueAdmittedItems,
  exactReviewQueueCapacity,
  exactReviewQueueNextWakeAt,
} from "./exact-review-queue.ts";

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const QUEUED_RUN_STATUSES = new Set(["queued", "waiting", "requested", "pending"]);
type DashboardContext = { waitUntil?: (promise: Promise<unknown>) => void };
type GithubJsonReader = (path: string) => ReturnType<typeof githubJson>;
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

declare global {
  interface CacheStorage {
    default: Cache;
  }
}
const ACTIVE_RUN_STATUS_FILTERS = ["in_progress", "queued", "waiting", "requested", "pending"];
const TERMINAL_BAD_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
const EVENT_LIMIT = 200;
const EVENT_STORE_TTL_SECONDS = 7 * 24 * 60 * 60;
const BAY_TERMINAL_STATE_KEY = "openclaw-bay:terminal-state:v1";
const BAY_JOURNEY_STATE_KEY = "openclaw-bay:journey-state:v1";
const BAY_TIDE_THRESHOLD = 20;
const BAY_SEEN_EVENT_LIMIT = 256;
const BAY_WASH_VISIBLE_MS = 60_000;
const BAY_TIMING_WINDOW_MS = 60 * 60 * 1000;
const BAY_INITIAL_TERMINAL_LOOKBACK_MS = BAY_TIMING_WINDOW_MS;
const BAY_TIMING_MAX_SAMPLE_MS = 24 * 60 * 60 * 1000;
const BAY_JOURNEY_LIMIT = 100;
const BAY_JOURNEY_TTL_SECONDS = 24 * 60 * 60;
const AVERAGE_LIMIT = 4;
const RECENT_CLOSED_LIMIT = 8;
const CLOSED_STATS_HOURS = 24;
const CLOSED_STATS_PAGE_LIMIT = 10;
const DEFAULT_CLAWSWEEPER_BOT_LOGINS = ["clawsweeper[bot]", "openclaw-clawsweeper[bot]"];
const GITHUB_TIMEOUT_MS = 4500;
const DEFAULT_STALE_QUEUED_WORKFLOW_MS = 6 * 60 * 60 * 1000;
const HEALTH_HISTORY_TTL_SECONDS = (HEALTH_HISTORY_RETENTION_DAYS + 1) * 24 * 60 * 60;
const HEALTH_HISTORY_KEY_PREFIX = "health-history:";
const APPLY_OBSERVABILITY_KEY_PREFIX = "apply-observability:";
const APPLY_OBSERVABILITY_BUCKET_KEY_PREFIX = `${APPLY_OBSERVABILITY_KEY_PREFIX}day:`;
const APPLY_OBSERVABILITY_LEGACY_LIMIT = 5_000;
const CLAWSWEEPER_REVIEW_REPO = "openclaw/clawsweeper";
const CLAWSWEEPER_STATE_REPO = "openclaw/clawsweeper-state";
const CLAWSWEEPER_STATE_REF = "state";
const CLUSTER_REPAIR_INTAKE_WORKFLOW = "repair-cluster-intake.yml";
const CLAWSWEEPER_ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CLAWSWEEPER_ISSUE_ITEM_ACTIONS = new Set([
  "opened",
  "reopened",
  "edited",
  "unlocked",
  "unlabeled",
]);
const CLAWSWEEPER_PULL_ITEM_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "edited",
  "unlocked",
  "unlabeled",
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
const AUTOMERGE_REPAIR_WORKFLOW = "repair-cluster-worker.yml";
const AUTOMERGE_RELIABILITY_RUN_LIMIT = 100;
const AUTOMERGE_STALLED_AFTER_MS = 90 * 60 * 1000;
const AUTOMERGE_FAILURE_DISPLAY_LIMIT = 5;
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

    if (request.method === "GET" && key === AUTOMERGE_METRICS_STORE_KEY) {
      const now = Date.now();
      const range = automergeMetricRange(url.searchParams.get("range"));
      const rangeStart = automergeMetricRangeStart(range, now);
      const contextStart = rangeStart - AUTOMERGE_METRICS_SESSION_CONTEXT_MS;
      const upperBound = `${AUTOMERGE_METRICS_EVENT_KEY_PREFIX}${new Date(now).toISOString()}:\uffff`;
      const entries = (await this.storage.list({
        prefix: AUTOMERGE_METRICS_EVENT_KEY_PREFIX,
        start: `${AUTOMERGE_METRICS_EVENT_KEY_PREFIX}${new Date(contextStart).toISOString()}`,
        end: upperBound,
        limit: AUTOMERGE_METRICS_EVENT_LIMIT,
        reverse: false,
      })) as Map<string, StoredValue>;
      const events = [];
      for (const [entryKey, stored] of entries) {
        if (!entryKey.startsWith(AUTOMERGE_METRICS_EVENT_KEY_PREFIX)) continue;
        if (stored.expires_at && stored.expires_at <= Date.now()) continue;
        try {
          const event = normalizeAutomergeMetricEvent(JSON.parse(stored.value));
          if (event) events.push(event);
        } catch {
          // A malformed isolated event must not hide the rest of the metric history.
        }
      }
      return json(
        summarizeAutomergeMetrics(
          { version: 1, telemetry_since: events[0]?.occurred_at ?? null, events },
          {
            range,
            repo: url.searchParams.get("repo"),
            policyVersion: url.searchParams.get("policy_version"),
            sessionId: url.searchParams.get("session_id"),
            activeOnly: url.searchParams.get("active_only") === "true",
            sessionLimit: Number(url.searchParams.get("session_limit")),
            now: new Date(now).toISOString(),
          },
        ),
      );
    }

    if (request.method === "GET" && key === "apply-observability") {
      return json(await this.summarizeApplyObservability(url));
    }

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

    if (request.method === "POST" && key === BAY_TERMINAL_STATE_KEY) {
      const body = await request.json();
      const current = (await this.storage.get(key)) as StoredValue | undefined;
      const currentValue =
        current?.value && (!current.expires_at || current.expires_at > Date.now())
          ? JSON.parse(current.value)
          : null;
      const generatedAt = String(body?.generated_at || new Date().toISOString());
      const next = mergeBayTerminalState(
        currentValue,
        body?.attempts,
        body?.closed_items,
        generatedAt,
        body?.active_item_keys,
      );
      if (
        currentValue &&
        bayTerminalStateSignature(currentValue) === bayTerminalStateSignature(next)
      ) {
        return json(currentValue);
      }
      const expiresAt = Date.now() + numberFrom(body?.ttl_seconds, EVENT_STORE_TTL_SECONDS) * 1000;
      await this.storage.put(key, {
        value: JSON.stringify(next),
        expires_at: expiresAt,
      });
      await this.scheduleCleanup(expiresAt);
      return json(next);
    }

    if (request.method === "POST" && key === BAY_JOURNEY_STATE_KEY) {
      const body = await request.json();
      const current = (await this.storage.get(key)) as StoredValue | undefined;
      const currentValue =
        current?.value && (!current.expires_at || current.expires_at > Date.now())
          ? JSON.parse(current.value)
          : null;
      const generatedAt = String(body?.generated_at || new Date().toISOString());
      const next = mergeBayJourneyState(
        currentValue,
        body?.triggers,
        body?.completions,
        generatedAt,
      );
      if (
        currentValue &&
        bayJourneyStateSignature(currentValue) === bayJourneyStateSignature(next)
      ) {
        return json(currentValue);
      }
      const expiresAt = Date.now() + numberFrom(body?.ttl_seconds, BAY_JOURNEY_TTL_SECONDS) * 1000;
      await this.storage.put(key, {
        value: JSON.stringify(next),
        expires_at: expiresAt,
      });
      await this.scheduleCleanup(expiresAt);
      return json(next);
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

    if (request.method === "POST" && key === AUTOMERGE_METRICS_STORE_KEY) {
      const body = await request.json();
      const event = normalizeAutomergeMetricEvent(body?.event);
      if (!event) return new Response("invalid automerge metric event", { status: 400 });
      const expiresAt = Date.parse(event.occurred_at) + AUTOMERGE_METRICS_TTL_SECONDS * 1000;
      if (expiresAt <= Date.now()) return json({ ok: true, expired: true });
      const idKey = `${AUTOMERGE_METRICS_EVENT_ID_KEY_PREFIX}${encodeURIComponent(event.event_id)}`;
      const existing = (await this.storage.get(idKey)) as StoredValue | undefined;
      if (existing && (!existing.expires_at || existing.expires_at > Date.now())) {
        return json({ ok: true, duplicate: true });
      }
      const eventKey = `${AUTOMERGE_METRICS_EVENT_KEY_PREFIX}${event.occurred_at}:${encodeURIComponent(event.event_id)}`;
      // Durable Object multi-key put is atomic, so a retry cannot observe an ID
      // receipt without its time-ordered event (or vice versa).
      await this.storage.put({
        [eventKey]: { value: JSON.stringify(event), expires_at: expiresAt },
        [idKey]: { value: eventKey, expires_at: expiresAt },
      });
      await this.scheduleCleanup(expiresAt);
      return json({ ok: true });
    }

    if (request.method === "POST" && key === "apply-observability") {
      const event = normalizeApplyObservabilityEvent((await request.json()).event);
      if (!event) return new Response("invalid apply observability event", { status: 400 });
      const expiresAt = Date.parse(event.occurred_at) + APPLY_OBSERVABILITY_RETENTION_MS;
      if (expiresAt <= Date.now()) return json({ ok: true, expired: true });
      const bucketKey = applyObservabilityBucketKey(event);
      const current = (await this.storage.get(bucketKey)) as StoredValue | undefined;
      const events = mergeApplyObservabilityBucket(current, event);
      const bucketExpiresAt = Math.max(
        ...events.map(
          (storedEvent) => Date.parse(storedEvent.occurred_at) + APPLY_OBSERVABILITY_RETENTION_MS,
        ),
      );
      await this.storage.put(bucketKey, {
        value: JSON.stringify(events),
        expires_at: bucketExpiresAt,
      });
      await this.scheduleCleanup(bucketExpiresAt);
      return json({ ok: true });
    }

    if (request.method === "POST" && key === "health-history") {
      const body = await request.json();
      const sample = normalizeHealthHistorySample(body?.sample);
      if (!sample) return new Response("invalid health sample", { status: 400 });
      const bucketKey = `${HEALTH_HISTORY_KEY_PREFIX}${sample.at.slice(0, 10)}`;
      const current = (await this.storage.get(bucketKey)) as StoredValue | undefined;
      let currentSamples = [];
      try {
        currentSamples = current?.value ? JSON.parse(current.value) : [];
      } catch {
        currentSamples = [];
      }
      const samples = mergeHealthHistorySample(currentSamples, sample);
      const expiresAt = Date.now() + HEALTH_HISTORY_TTL_SECONDS * 1000;
      await this.storage.put(bucketKey, {
        value: JSON.stringify(samples),
        expires_at: expiresAt,
      });
      await this.scheduleCleanup(expiresAt);
      return json({ ok: true, samples: samples.length });
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

  private async summarizeApplyObservability(url: URL) {
    const now = Date.now();
    const rangeValue = url.searchParams.get("range");
    const range = rangeValue === "6h" || rangeValue === "7d" ? rangeValue : "24h";
    const requestedRepo = url.searchParams.get("repo");
    const requiredRepositories = url.searchParams.getAll("required_repo");
    const optionalRepositories = url.searchParams.getAll("optional_repo");
    const readRepositories = requestedRepo
      ? [requestedRepo]
      : [...new Set([...requiredRepositories, ...optionalRepositories])];
    const bucketLookback = Math.max(
      APPLY_OBSERVABILITY_RANGES[range],
      APPLY_OBSERVABILITY_IN_PROGRESS_MAX_SILENCE_MS,
    );
    const bucketGroups = await Promise.all(
      healthHistoryDates(now - bucketLookback, now).flatMap((day) =>
        readRepositories.map(async (repo) => {
          const key = `${APPLY_OBSERVABILITY_BUCKET_KEY_PREFIX}${day}:${encodeURIComponent(repo)}`;
          const stored = (await this.storage.get(key)) as StoredValue | undefined;
          return stored ? new Map([[key, stored]]) : new Map<string, StoredValue>();
        }),
      ),
    );
    const legacyGroups = (await Promise.all(
      readRepositories.map((repo) =>
        this.storage.list({
          prefix: `${APPLY_OBSERVABILITY_KEY_PREFIX}${encodeURIComponent(repo)}:`,
          limit: APPLY_OBSERVABILITY_LEGACY_LIMIT,
          reverse: true,
        }),
      ),
    )) as Array<Map<string, StoredValue>>;
    const events = mergeStoredApplyObservabilityEvents(
      legacyGroups,
      bucketGroups as Array<Map<string, StoredValue>>,
      now,
    );
    const observedRepositories = new Set(
      events
        .filter((event) => isCurrentApplyObservabilityEvent(event, now))
        .map((event) => event.repo),
    );
    const repositories = [
      ...new Set([
        ...requiredRepositories,
        ...optionalRepositories.filter((repo) => observedRepositories.has(repo)),
      ]),
    ];
    return summarizeApplyObservability({
      events,
      range,
      repo: requestedRepo,
      repositories,
      now,
    });
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
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "clawsweeper-status",
        deployment_sha: nullableString(env.CLAWSWEEPER_DEPLOY_SHA),
      });
    }
    if (url.pathname === "/api/events" && request.method === "POST")
      return ingestEvent(request, env);
    if (url.pathname === "/github/webhook" && request.method === "GET")
      return json({ ok: true, service: "clawsweeper-github-webhook" });
    if (url.pathname === "/github/webhook" && request.method === "POST")
      return githubWebhook(request, env, ctx);
    if (url.pathname === "/internal/exact-review/enqueue" && request.method === "POST")
      return authenticatedExactReviewEnqueue(request, env);
    if (url.pathname === "/internal/exact-review/branch-authority" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/branch-authority");
    if (url.pathname === "/internal/exact-review/source-authority" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/source-authority");
    if (url.pathname === "/internal/review-coverage/inventory" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/review-coverage/inventory");
    const operationalCursorPath =
      /^\/internal\/state\/cursors\/(hot-intake|normal-review|audit|review-placeholder-[a-f0-9]{16}-(?:open|closed))$/.exec(
        url.pathname,
      );
    if (operationalCursorPath && (request.method === "GET" || request.method === "PUT"))
      return authenticatedExactReviewQueueCursorRequest(
        request,
        env,
        url.pathname.slice("/internal/state".length),
      );
    const canonicalRecordPath =
      request.method === "GET"
        ? /^\/internal\/state\/records\/[^/]+\/(?:items|closed|plans|decision-packets)\/[1-9]\d*$/.exec(
            url.pathname,
          )
        : null;
    if (canonicalRecordPath)
      return authenticatedExactReviewQueueRead(
        request,
        env,
        url.pathname.slice("/internal/state".length),
      );
    if (url.pathname === "/internal/state/records/slugs" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/slugs");
    if (url.pathname === "/internal/state/records/list" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/list");
    if (url.pathname === "/internal/state/records/export" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/export");
    if (url.pathname === "/internal/state/records/tuples" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/tuples");
    if (url.pathname === "/internal/state/records/commits" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/commits");
    if (url.pathname === "/internal/state/records/snapshots/latest" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/snapshots/latest");
    if (url.pathname === "/internal/state/records/snapshots/trigger" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/snapshots/trigger");
    if (url.pathname === "/internal/state/records/snapshots/chunk" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/records/snapshots/chunk");
    if (url.pathname.startsWith("/internal/state/blobs/") && request.method === "POST") {
      const operation = url.pathname.slice("/internal/state/blobs/".length);
      if (STATE_BLOB_OPERATIONS.includes(operation as StateBlobOperation)) {
        return authenticatedStateBlobRequest(request, env, operation as StateBlobOperation);
      }
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/internal/state-writer/acquire" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/state-writer/acquire");
    if (url.pathname === "/internal/state-writer/heartbeat" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/state-writer/heartbeat");
    if (url.pathname === "/internal/state-writer/release" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/state-writer/release");
    if (url.pathname === "/internal/exact-review/claim" && request.method === "POST")
      return exactReviewQueueRequest(env, "/claim", request);
    // Heartbeat authenticates by full lease tuple, matching /claim and /complete: the
    // tuple is a per-lease capability, so the shared webhook secret never has to enter
    // the review job that runs Codex over untrusted content.
    if (url.pathname === "/internal/exact-review/heartbeat" && request.method === "POST")
      return exactReviewQueueRequest(env, "/heartbeat", request);
    if (
      url.pathname === "/internal/exact-review/state-writer-progress" &&
      request.method === "POST"
    )
      return exactReviewQueueRequest(env, "/state-writer-progress", request);
    if (url.pathname === "/internal/exact-review/complete" && request.method === "POST")
      return exactReviewQueueRequest(env, "/complete", request);
    if (
      url.pathname === "/internal/exact-review/terminal-finalization/attempt" &&
      request.method === "POST"
    )
      return exactReviewQueueRequest(env, "/terminal-finalization/attempt", request);
    if (
      url.pathname === "/internal/exact-review/terminal-finalization/retry" &&
      request.method === "POST"
    )
      return exactReviewQueueRequest(env, "/terminal-finalization/retry", request);
    if (
      url.pathname === "/internal/exact-review/terminal-finalization/skip" &&
      request.method === "POST"
    )
      return exactReviewQueueRequest(env, "/terminal-finalization/skip", request);
    if (url.pathname === "/internal/exact-review/claimed-runs" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/claimed-runs");
    if (url.pathname === "/internal/exact-review/dead-letters/list" && request.method === "POST")
      return authenticatedExactReviewOperatorRequest(request, env, "/dead-letters/list");
    if (
      url.pathname === "/internal/exact-review/lifecycle-audit/inventory" &&
      request.method === "POST"
    )
      return authenticatedExactReviewOperatorRequest(request, env, "/lifecycle-audit/inventory");
    if (url.pathname === "/internal/exact-review/dead-letters/replay" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/dead-letters/replay");
    if (
      url.pathname === "/internal/exact-review/dead-letters/recover-fresh" &&
      request.method === "POST"
    )
      return authenticatedExactReviewOperatorRequest(request, env, "/dead-letters/recover-fresh");
    if (url.pathname === "/internal/exact-review/dead-letters/resolve" && request.method === "POST")
      return authenticatedExactReviewOperatorRequest(request, env, "/dead-letters/resolve");
    if (url.pathname === "/internal/exact-review/parked-reviews/list" && request.method === "POST")
      return authenticatedExactReviewOperatorRequest(request, env, "/parked-reviews/list");
    if (
      url.pathname === "/internal/exact-review/parked-reviews/resolve" &&
      request.method === "POST"
    )
      return authenticatedExactReviewOperatorRequest(request, env, "/parked-reviews/resolve");
    if (
      url.pathname === "/internal/exact-review/parked-reviews/recover-fresh" &&
      request.method === "POST"
    )
      return authenticatedExactReviewOperatorRequest(request, env, "/parked-reviews/recover-fresh");
    if (url.pathname === "/internal/exact-review/publications/list" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/publications/list");
    if (
      url.pathname === "/internal/exact-review/publications/supersede" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publications/supersede");
    if (
      url.pathname === "/internal/exact-review/publications/reconcile" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publications/reconcile");
    if (url.pathname === "/internal/exact-review/publication-results" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/publication-results");
    if (
      url.pathname === "/internal/exact-review/publication-batch-results" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publication-batch-results");
    if (
      url.pathname === "/internal/exact-review/lifecycle/router-receipt" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/lifecycle/router-receipt");
    if (
      url.pathname === "/internal/exact-review/lifecycle/canonical-receipt" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/lifecycle/canonical-receipt");
    if (
      url.pathname === "/internal/exact-review/lifecycle/terminal-disposition" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/lifecycle/terminal-disposition");
    if (
      url.pathname === "/internal/exact-review/lifecycle/command-ack/attempt" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/lifecycle/command-ack/attempt");
    if (
      url.pathname === "/internal/exact-review/lifecycle/command-ack/failed" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/lifecycle/command-ack/failed");
    if (
      url.pathname === "/internal/exact-review/lifecycle/command-ack/observed" &&
      request.method === "POST"
    )
      return authenticatedLifecycleCommandAcknowledgement(request, env, ctx);
    if (url.pathname === "/internal/exact-review/review-run-telemetry" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/review-run-telemetry");
    if (
      url.pathname === "/internal/exact-review/publication-batches/claim" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publication-batches/claim");
    if (
      url.pathname === "/internal/exact-review/publication-batches/fetch" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publication-batches/fetch");
    if (
      url.pathname === "/internal/exact-review/publication-batches/heartbeat" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publication-batches/heartbeat");
    if (
      url.pathname === "/internal/exact-review/publication-batches/complete" &&
      request.method === "POST"
    )
      return authenticatedExactReviewQueueRequest(request, env, "/publication-batches/complete");
    if (url.pathname === "/internal/apply-observability" && request.method === "POST")
      return authenticatedApplyObservability(request, env);
    if (url.pathname === "/internal/exact-review/reconcile" && request.method === "POST")
      return authenticatedExactReviewReconcile(request, env);
    if (url.pathname === "/api/exact-review-queue" && request.method === "GET")
      return exactReviewQueueRequest(env, "/stats");
    if (url.pathname === "/api/durable-lifecycle-bay" && request.method === "GET")
      return json({ durable_lifecycle_bay: await durableLifecycleBaySnapshot(env) });
    if (url.pathname === "/api/live-activity-bay" && request.method === "GET")
      return json({
        live_activity_bay: await liveActivityBaySnapshotForRequest(request, env, ctx),
      });
    if (url.pathname === "/api/recent-durable-publication-events" && request.method === "GET")
      return exactReviewQueueRequest(
        env,
        `/recent-durable-publication-events?${url.searchParams.toString()}`,
      );
    if (url.pathname === "/api/exact-review-queue/item" && request.method === "GET")
      return exactReviewQueueRequest(env, `/item-status?${url.searchParams.toString()}`);
    if (url.pathname === "/api/exact-review-queue/reviews" && request.method === "GET")
      return emptyPerItemReviewsJson(url.searchParams);
    if (url.pathname === "/api/review-observability" && request.method === "GET")
      return exactReviewQueueRequest(env, `/review-observability?${url.searchParams.toString()}`);
    if (url.pathname === "/api/review-coverage" && request.method === "GET")
      return exactReviewQueueRequest(env, "/review-coverage");
    if (url.pathname === "/api/apply-observability" && request.method === "GET")
      return applyObservabilityJson(request, env);
    if (url.pathname === "/api/health-history" && request.method === "GET")
      return healthHistoryJson(request, env);
    if (url.pathname === "/api/automerge-metrics" && request.method === "GET")
      return automergeMetricsJson(request, env);
    if (url.pathname === "/api/status") return statusJson(request, env, ctx);
    if (url.pathname === "/api/triage") return triageJson(request, env, ctx);
    if (url.pathname === "/api/pr-proof-triage") return prProofTriageJson(request, env, ctx);
    if (url.pathname === "/" || url.pathname === "/index.html") return html(dashboardHtml(env));
    if (url.pathname === "/bay") return demoHtml(bayHtml());
    if (url.pathname === "/bay-demo") {
      url.pathname = "/bay";
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname === "/triage" || url.pathname === "/triage.html")
      return html(triageHtml(issueTriagePageConfig()));
    if (url.pathname === "/pr-proof-triage" || url.pathname === "/pr-proof-triage.html")
      return html(triageHtml(prProofTriagePageConfig()));
    return json({ error: "not_found" }, 404);
  },
  async scheduled(_controller, env: DashboardEnv = {}, ctx?: DashboardContext) {
    const maintenance = recordScheduledHealthSample(env);
    if (ctx?.waitUntil) ctx.waitUntil(maintenance);
    else await maintenance;
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
  return statusSnapshotResponse(refreshed.snapshot, "miss");
}

async function healthHistoryJson(request: Request, env: DashboardEnv) {
  const requestedRange = new URL(request.url).searchParams.get("range");
  const range = requestedRange === "6h" || requestedRange === "7d" ? requestedRange : "24h";
  const rangeMs =
    range === "6h"
      ? 6 * 60 * 60 * 1000
      : range === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  const now = Date.now();
  const groups = await Promise.all(
    healthHistoryDates(now - rangeMs, now).map(async (day) => {
      if (!env.STATUS_STORE) return [];
      const text = await readStatusStoreText(
        env.STATUS_STORE,
        `${HEALTH_HISTORY_KEY_PREFIX}${day}`,
      );
      if (!text) return [];
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }),
  );
  const samples = groups
    .flat()
    .map((sample) => normalizeHealthHistorySample(sample))
    .filter((sample) => sample && Date.parse(sample.at) >= now - rangeMs)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return cors(
    json({
      schema_version: 1,
      range,
      retention_days: HEALTH_HISTORY_RETENTION_DAYS,
      samples,
    }),
  );
}

function healthHistoryDates(fromMs: number, toMs: number) {
  const dates = [];
  const cursor = new Date(fromMs);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= toMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function applyObservabilityBucketKey(event) {
  return `${APPLY_OBSERVABILITY_BUCKET_KEY_PREFIX}${event.occurred_at.slice(0, 10)}:${encodeURIComponent(event.repo)}`;
}

function applyObservabilityEventKey(event) {
  return `${event.repo}:${event.run_id}:${event.run_attempt}`;
}

function mergeApplyObservabilityBucket(
  current: StoredValue | undefined,
  incoming,
  now = Date.now(),
) {
  let parsed = [];
  try {
    parsed =
      current?.value && (!current.expires_at || current.expires_at > now)
        ? JSON.parse(current.value)
        : [];
  } catch {
    parsed = [];
  }
  const events = new Map();
  for (const value of Array.isArray(parsed) ? parsed : []) {
    const event = normalizeApplyObservabilityEvent(value, now);
    if (
      event &&
      event.repo === incoming.repo &&
      event.occurred_at.slice(0, 10) === incoming.occurred_at.slice(0, 10) &&
      Date.parse(event.occurred_at) + APPLY_OBSERVABILITY_RETENTION_MS > now
    ) {
      events.set(applyObservabilityEventKey(event), event);
    }
  }
  events.set(applyObservabilityEventKey(incoming), incoming);
  return [...events.values()].sort(
    (left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at),
  );
}

function mergeStoredApplyObservabilityEvents(
  legacyGroups: Array<Map<string, StoredValue>>,
  bucketGroups: Array<Map<string, StoredValue>>,
  now: number,
) {
  const events = new Map();
  const add = (value) => {
    const event = normalizeApplyObservabilityEvent(value, now);
    if (!event || Date.parse(event.occurred_at) + APPLY_OBSERVABILITY_RETENTION_MS <= now) return;
    const key = applyObservabilityEventKey(event);
    const current = events.get(key);
    if (!current || Date.parse(event.occurred_at) >= Date.parse(current.occurred_at)) {
      events.set(key, event);
    }
  };
  for (const group of legacyGroups) {
    for (const stored of group.values()) {
      if (stored.expires_at && stored.expires_at <= now) continue;
      try {
        add(JSON.parse(stored.value));
      } catch {
        // A malformed legacy observation must not hide healthy bucketed observations.
      }
    }
  }
  for (const group of bucketGroups) {
    for (const stored of group.values()) {
      if (stored.expires_at && stored.expires_at <= now) continue;
      try {
        const parsed = JSON.parse(stored.value);
        if (Array.isArray(parsed)) parsed.forEach(add);
      } catch {
        // A malformed isolated bucket must not hide the remaining observation history.
      }
    }
  }
  return [...events.values()].sort(
    (left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at),
  );
}

async function recordScheduledHealthSample(env) {
  const queueSnapshot = exactReviewQueueStatusSnapshot(env).catch(() => null);
  if (!env.STATUS_STORE) {
    await queueSnapshot;
    return;
  }
  // Current operational health still powers the anomaly alert in /api/status.
  // Its old chart history had no remaining consumer, so cron persists only the
  // exact-review queue snapshot and avoids a second GitHub Actions run scan.
  const queue = await queueSnapshot;
  await appendHealthHistorySample(env, {
    at: new Date().toISOString(),
    exact_review: exactReviewHistorySample(queue),
    state_writer: stateWriterHistorySample(objectValue(queue).state_writer),
  });
}

async function appendHealthHistorySample(env, sample) {
  const store = env.STATUS_STORE;
  if (!store) return;
  if (isDurableStatusStore(store)) {
    const response = await durableStatusStoreStub(store).fetch(
      new Request(statusStoreRequest("health-history", "POST"), {
        method: "POST",
        body: JSON.stringify({ sample }),
      }),
    );
    if (!response.ok) throw new Error(`health history write failed: ${response.status}`);
    return;
  }
  const key = `${HEALTH_HISTORY_KEY_PREFIX}${sample.at.slice(0, 10)}`;
  const text = await readStatusStoreText(store, key);
  let current = [];
  try {
    current = text ? JSON.parse(text) : [];
  } catch {
    current = [];
  }
  await writeStatusStoreText(
    store,
    key,
    JSON.stringify(mergeHealthHistorySample(current, sample)),
    HEALTH_HISTORY_TTL_SECONDS,
  );
}

function cachedStatusResponse(cached, cacheState) {
  const headers = new Headers(cached.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-clawsweeper-cache", cacheState);
  return cors(new Response(cached.body, { status: cached.status, headers }));
}

function statusSnapshotResponse(snapshot, cacheState, status = 200, headers?) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-clawsweeper-cache", cacheState);
  return cors(
    new Response(JSON.stringify(snapshot, null, 2), { status, headers: responseHeaders }),
  );
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
  const baseSnapshot = await statusSnapshot(env);
  // Queue stats and the GitHub-backed global lease are operational observations, not
  // request-specific data. Cache the composed document so a cache hit never waits on
  // those remote probes; the existing stale-while-revalidate path refreshes them safely.
  const snapshot = await attachExactReviewQueueStatus(baseSnapshot, env);
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
  return new Request(new URL(`/api/status-cache/v3/${bucket}`, request.url).toString(), {
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
  let metricEvent = null;
  if (body.event_type === AUTOMERGE_METRICS_EVENT_TYPE) {
    metricEvent = normalizeAutomergeMetricEvent(body);
    if (!metricEvent) return json({ error: "invalid_automerge_metric_event" }, 400);
    if (!isDurableStatusStore(env.STATUS_STORE)) {
      return json({ error: "automerge_metrics_store_unavailable" }, 503);
    }
  }
  const event = normalizeEvent(body);
  const writes = [
    prependStoredEvent(env, event),
    writeStoredJson(env, "latest-event", event, EVENT_STORE_TTL_SECONDS),
  ];
  if (metricEvent) writes.push(storeAutomergeMetricEvent(env, metricEvent));
  const ci = normalizeCiStatus(body);
  if (ci) writes.push(writeCiStatus(env, ci));
  await Promise.all(writes);
  return json({ ok: true, event });
}

async function automergeMetricsJson(request, env) {
  const url = new URL(request.url);
  if (!isDurableStatusStore(env.STATUS_STORE)) {
    return json({ error: "automerge_metrics_store_unavailable" }, 503);
  }
  const storeUrl = new URL(statusStoreRequest(AUTOMERGE_METRICS_STORE_KEY).url);
  for (const name of [
    "range",
    "repo",
    "policy_version",
    "session_id",
    "active_only",
    "session_limit",
  ]) {
    const value = url.searchParams.get(name);
    if (value !== null) storeUrl.searchParams.set(name, value);
  }
  const response = await durableStatusStoreStub(env.STATUS_STORE).fetch(new Request(storeUrl));
  if (!response.ok) return json({ error: "automerge_metrics_unavailable" }, 503);
  return json(await response.json());
}

async function storeAutomergeMetricEvent(env, event) {
  const store = env.STATUS_STORE;
  if (!isDurableStatusStore(store)) throw new Error("automerge metrics require durable storage");
  const response = await durableStatusStoreStub(store).fetch(
    statusStoreRequest(AUTOMERGE_METRICS_STORE_KEY, "POST"),
    { method: "POST", body: JSON.stringify({ event }) },
  );
  if (!response.ok) throw new Error(`automerge metric write failed: ${response.status}`);
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

  const completion = bayJourneyCompletionFromGithubWebhook({ event, payload, env });
  if (completion) {
    const acknowledgement = await recordLifecycleCommandAcknowledgement(env, completion);
    if (!acknowledgement.accepted) {
      return json(
        { ok: true, accepted: false, reason: "unmatched lifecycle acknowledgement" },
        202,
      );
    }
    await recordBayJourneyTelemetry(
      env,
      ctx,
      [],
      [
        acknowledgement.sourceDeliveryId
          ? { ...completion, source_delivery_id: acknowledgement.sourceDeliveryId }
          : completion,
      ],
    );
    return json({ ok: true, accepted: false, reason: "recorded Bay journey completion" }, 202);
  }
  const acknowledgement = lifecycleCommandAcknowledgementFromGithubWebhook({ event, payload, env });
  if (acknowledgement) {
    if (!(await recordLifecycleCommandAcknowledgement(env, acknowledgement)).accepted) {
      return json(
        { ok: true, accepted: false, reason: "unmatched lifecycle acknowledgement" },
        202,
      );
    }
    return json({ ok: true, accepted: false, reason: "recorded lifecycle acknowledgement" }, 202);
  }

  const decision = classifyGithubWebhook({ event, payload });
  if (!decision.accepted) {
    return json({ ok: true, accepted: false, reason: decision.reason }, 202);
  }

  if ("type" in decision && decision.type === "item") {
    const deliveryId = request.headers.get("x-github-delivery") || "";
    let itemDecision = decision as ExactReviewDecision & { installationId?: number };
    if (itemDecision.itemKind === "pull_request") {
      await acknowledgePullRequestReceipt({ env, ctx, decision: itemDecision }).catch((error) => {
        console.error(`ClawSweeper pull request fast ack failed: ${error?.message || error}`);
        return undefined;
      });
    }
    itemDecision = await withPullRequestEditContentRevision({
      event,
      payload,
      decision: itemDecision,
    });
    const ingress = await exactReviewPullRequestIngress({
      event,
      payload,
      decision: itemDecision,
    });
    const sourceAuthority =
      itemDecision.itemKind === "pull_request"
        ? await reserveExactReviewSourceAuthority(env, {
            deliveryId,
            decision: itemDecision,
            ingress,
          })
        : null;
    if (itemDecision.itemKind === "pull_request" && sourceAuthority === null) {
      return json({ error: "exact_review_queue_not_configured" }, 503);
    }
    if (sourceAuthority && "deduped" in sourceAuthority) {
      return json({
        ok: true,
        deduped: true,
        item_key: `${itemDecision.targetRepo}#${itemDecision.itemNumber}`,
      });
    }
    const sourceAuthoritySeq =
      sourceAuthority && "sourceAuthoritySeq" in sourceAuthority
        ? sourceAuthority.sourceAuthoritySeq
        : null;
    let exactReviewDecision: ExactReviewDecision | null;
    try {
      exactReviewDecision = await bindLivePullRequestHeadAuthority({
        env,
        decision: itemDecision,
        sourceAuthoritySeq,
      });
    } catch {
      return json(
        {
          ok: true,
          accepted: true,
          deferred: true,
          reason: "pull request head verification deferred",
        },
        202,
      );
    }
    if (!exactReviewDecision) {
      await completeExactReviewSourceAuthority(
        env,
        deliveryId,
        Number(sourceAuthoritySeq),
        "mismatch",
      ).catch(() => undefined);
      return json({ ok: true, accepted: false, reason: "stale pull request head" }, 202);
    }
    const queued = await enqueueExactReview({
      env,
      deliveryId,
      decision: exactReviewDecision,
      ingress,
    });
    if (!queued) return json({ error: "exact_review_queue_not_configured" }, 503);
    if (sourceAuthoritySeq !== null) {
      await completeExactReviewSourceAuthority(
        env,
        deliveryId,
        sourceAuthoritySeq,
        "enqueued",
      ).catch(() => undefined);
    }
    return json({ ok: true, ...queued }, 202);
  }

  const trigger = bayJourneyTriggerFromGithubWebhook({
    decision,
    payload,
    deliveryId: request.headers.get("x-github-delivery"),
  });
  if (trigger) await recordBayJourneyTelemetry(env, ctx, [trigger], []);

  const credentials = githubAppCredentials(env);
  if (!credentials) return json({ error: "github_app_not_configured" }, 503);
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const dispatchToken = await createGithubAppTokenFor({
    env,
    appJwt,
    installationId: await githubAppInstallationId(appJwt, CLAWSWEEPER_REVIEW_REPO, env),
    label: CLAWSWEEPER_REVIEW_REPO,
    repositories: [repoName(CLAWSWEEPER_REVIEW_REPO)],
    permissions: { contents: "write" },
  });

  const commentDecision = decision as any;
  const targetToken = await createGithubAppTokenFor({
    env,
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
    env,
    token: targetToken,
    repo: commentDecision.targetRepo,
    itemNumber: commentDecision.itemNumber,
    sourceCommentId: commentDecision.commentId,
  });
  await addIssueCommentReaction({
    env,
    token: targetToken,
    repo: commentDecision.targetRepo,
    commentId: commentDecision.commentId,
    content: "eyes",
  });
  await dispatchClawsweeperComment({
    env,
    token: dispatchToken,
    decision: commentDecision,
    statusCommentId,
    sourceDeliveryId: trigger?.source_delivery_id,
  });
  settleFastAckComments({
    env,
    token: targetToken,
    repo: commentDecision.targetRepo,
    itemNumber: commentDecision.itemNumber,
    sourceCommentId: commentDecision.commentId,
    delaysMs: fastAckSettleDelaysMs(env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS),
    waitUntil: ctx?.waitUntil?.bind(ctx),
  });
  return json({ ok: true, status_comment_id: statusCommentId }, 202);
}

async function recordBayJourneyTelemetry(env, ctx, triggers, completions) {
  if (!env.STATUS_STORE) return;
  const write = updateBayJourneyState(env, triggers, completions, new Date().toISOString()).catch(
    () => undefined,
  );
  if (ctx?.waitUntil) {
    ctx.waitUntil(write);
    return;
  }
  await write;
}

function bayJourneyTriggerFromGithubWebhook({ decision, payload, deliveryId }) {
  if (!decision?.accepted || decision?.type !== "issue_comment") return null;
  const comment = objectValue(payload?.comment);
  const commandText = commandTextForClawSweeperFastAck(String(comment.body || ""));
  if (!isClawSweeperReReviewCommandText(commandText)) return null;
  const triggerAt = exactWebhookTimestamp(
    String(payload?.action || "") === "edited"
      ? comment.updated_at || comment.created_at
      : comment.created_at || comment.updated_at,
  );
  const sourceDeliveryId = nullableString(deliveryId);
  if (!triggerAt || !sourceDeliveryId) return null;
  return {
    repository: decision.targetRepo,
    number: decision.itemNumber,
    source_comment_id: decision.commentId,
    source_delivery_id: sourceDeliveryId,
    triggered_at: triggerAt,
  };
}

function bayJourneyCompletionFromGithubWebhook({ event, payload, env }) {
  const completion = lifecycleCommandAcknowledgementFromGithubWebhook({ event, payload, env });
  return completion?.status_marker &&
    /<!--\s*clawsweeper-command-status:\d+:(review|re_review):/i.test(completion.status_marker)
    ? completion
    : null;
}

function lifecycleCommandAcknowledgementFromGithubWebhook({ event, payload, env }) {
  if (event !== "issue_comment") return null;
  const comment = objectValue(payload?.comment);
  if (!clawsweeperBotLogins(env).has(normalizedLogin(objectValue(comment.user).login))) return null;
  const issue = objectValue(payload?.issue);
  const repo = objectValue(payload?.repository);
  if (!isEligibleGithubWebhookRepository(repo)) return null;
  const canonicalRepository = String(repo.full_name || "");
  const repository = canonicalRepository.toLowerCase();
  const number = Number(issue.number);
  const body = String(comment.body || "");
  const acknowledgement = body.match(/<!--\s*clawsweeper-command-ack:(\d+)\s*-->/i);
  const hasAcknowledgement = /<!--\s*clawsweeper-command-ack:[^>]*-->/i.test(body);
  const status = body.match(/<!--\s*clawsweeper-command-status:(\d+):([^:\s>]+):([^:\s>]+)\s*-->/i);
  const legacyCommands =
    !hasAcknowledgement && status
      ? Array.from(
          body.matchAll(
            /<!--\s*clawsweeper-command:(\d+):(?:[^>]*:)?([^:\s>]+):([^:\s>]+)\s*-->/gi,
          ),
        )
      : [];
  const legacyCommand =
    legacyCommands.length === 1 &&
    legacyCommands[0]![2] === status?.[2] &&
    legacyCommands[0]![3] === status?.[3]
      ? legacyCommands[0]![1]
      : undefined;
  const sourceCommentId = Number(acknowledgement?.[1] ?? legacyCommand ?? Number.NaN);
  const completedAt = exactWebhookTimestamp(comment.updated_at || comment.created_at);
  const progress =
    /<!--\s*clawsweeper-command-progress:start\s*-->([\s\S]*?)<!--\s*clawsweeper-command-progress:end\s*-->/i.exec(
      body,
    )?.[1];
  const completed =
    /^- State:\s*Complete\s*$/im.test(progress || "") ||
    (/- State:\s*Failed\s*$/im.test(progress || "") &&
      /- Detail:\s*(?:The review artifact was captured, but durable publication ended in a terminal failure\.|Durable publication exhausted its retry budget and was retained for operator dead-letter recovery\.|The exact review reached a durable terminal failure and needs operator attention\.)\s*$/im.test(
        progress || "",
      ));
  if (
    !repository ||
    !Number.isInteger(number) ||
    number <= 0 ||
    !Number.isSafeInteger(sourceCommentId) ||
    sourceCommentId <= 0 ||
    (status && Number(status[1]) !== number) ||
    !completedAt ||
    !completed
  ) {
    return null;
  }
  return {
    repository,
    canonical_repository: canonicalRepository,
    number,
    source_comment_id: sourceCommentId,
    completed_at: completedAt,
    completion_kind: "final_command_status",
    completion_comment_id: Number(comment.id),
    status_marker: status?.[0] ?? null,
    ...(legacyCommand ? { require_exact_status_comment: true } : {}),
  };
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
  const commentUpdatedAt = exactWebhookTimestamp(comment.updated_at);
  return {
    accepted: true,
    type: "issue_comment",
    targetRepo,
    targetBranch,
    itemNumber,
    commentId,
    installationId,
    sourceAction: action,
    ...(commentUpdatedAt
      ? {
          commentUpdatedAt,
          commentBody: String(comment.body || ""),
        }
      : {}),
  };
}

function exactWebhookTimestamp(value) {
  const text = String(value || "").trim();
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

async function withPullRequestEditContentRevision({ event, payload, decision }) {
  if (
    event !== "pull_request" ||
    decision.itemKind !== "pull_request" ||
    decision.sourceAction !== "edited"
  ) {
    return decision;
  }
  const pullRequest = objectValue(payload.pull_request);
  if (
    typeof pullRequest.title !== "string" ||
    (pullRequest.body !== null && typeof pullRequest.body !== "string")
  ) {
    return decision;
  }
  const title = pullRequest.title;
  const body = pullRequest.body || "";
  return {
    ...decision,
    sourceContentRevision: await sha256Text(JSON.stringify({ version: 1, title, body })),
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
    if (action === "unlabeled" && !isCloseGuardLabel(payload.label)) {
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
      supersedesInProgress: ["edited", "unlocked", "unlabeled"].includes(action),
    };
  }

  if (event === "pull_request") {
    if (!CLAWSWEEPER_PULL_ITEM_ACTIONS.has(action)) {
      return { accepted: false, reason: "unsupported action" };
    }
    if (action === "unlabeled" && !isCloseGuardLabel(payload.label)) {
      return { accepted: false, reason: "unsupported action" };
    }
    const pullRequest = objectValue(payload.pull_request);
    const itemNumber = Number(pullRequest.number);
    if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
      return { accepted: false, reason: "missing pull request number" };
    }
    const sourceHeadSha = String(objectValue(pullRequest.head).sha || "")
      .trim()
      .toLowerCase();
    const sourceBaseSha = String(objectValue(pullRequest.base).sha || "")
      .trim()
      .toLowerCase();
    const sourceIsDraft = pullRequest.draft;
    const sourceUpdatedAt = exactWebhookTimestamp(pullRequest.updated_at);
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
      ...(/^[0-9a-f]{40}$/.test(sourceHeadSha) ? { sourceHeadSha } : {}),
      ...(/^[0-9a-f]{40}$/.test(sourceBaseSha) ? { sourceBaseSha } : {}),
      ...(typeof sourceIsDraft === "boolean" ? { sourceIsDraft } : {}),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      supersedesInProgress: [
        "edited",
        "synchronize",
        "ready_for_review",
        "unlocked",
        "unlabeled",
      ].includes(action),
    };
  }

  return { accepted: false, reason: "unsupported event" };
}

async function bindLivePullRequestHeadAuthority({
  env,
  decision,
  sourceAuthoritySeq,
}: {
  env: DashboardEnv;
  decision: ExactReviewDecision & { installationId?: number };
  sourceAuthoritySeq: number | null;
}): Promise<ExactReviewDecision | null> {
  if (decision.itemKind !== "pull_request") return decision;
  if (!Number.isSafeInteger(sourceAuthoritySeq) || Number(sourceAuthoritySeq) <= 0) {
    throw new Error("exact-review source authority unavailable");
  }
  const sourceHeadSha = String(decision.sourceHeadSha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceHeadSha)) return null;

  let token = stringEnv(env.GITHUB_TOKEN);
  if (!token) {
    const credentials = githubAppCredentials(env);
    if (
      !credentials ||
      !Number.isInteger(decision.installationId) ||
      decision.installationId! <= 0
    ) {
      throw new Error("GitHub App credentials are required to verify a pull request head");
    }
    const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
    token = await createGithubAppTokenFor({
      env,
      appJwt,
      installationId: decision.installationId!,
      label: decision.targetRepo,
      repositories: [repoName(decision.targetRepo)],
      permissions: { pull_requests: "read" },
    });
  }
  const pull = await githubTokenJson({
    env,
    token,
    path: `/repos/${decision.targetRepo}/pulls/${decision.itemNumber}`,
    body: undefined,
    errorLabel: "live pull request head",
  });
  const liveHeadSha = String(objectValue(objectValue(pull).head).sha || "")
    .trim()
    .toLowerCase();
  return liveHeadSha === sourceHeadSha
    ? { ...decision, sourceHeadVerified: true, sourceAuthoritySeq: Number(sourceAuthoritySeq) }
    : null;
}

async function exactReviewPullRequestIngress({ event, payload, decision }) {
  if (event !== "pull_request" || decision.itemKind !== "pull_request") return undefined;
  const pullRequest = objectValue(payload.pull_request);
  const headSha = String(objectValue(pullRequest.head).sha || "")
    .trim()
    .toLowerCase();
  const updatedAt = String(pullRequest.updated_at || "").trim();
  if (!/^[0-9a-f]{40}$/.test(headSha) || !updatedAt) return undefined;
  return {
    route: "direct_webhook" as const,
    fingerprint: await sha256Text(
      JSON.stringify({
        version: 1,
        target_repo: decision.targetRepo.toLowerCase(),
        item_number: decision.itemNumber,
        action: decision.sourceAction,
        head_sha: headSha,
        updated_at: updatedAt,
        body: typeof pullRequest.body === "string" ? pullRequest.body : "",
        label: String(objectValue(payload.label).name || ""),
      }),
    ),
  } satisfies ExactReviewIngress;
}

function isCloseGuardLabel(value) {
  const label = String(objectValue(value).name || "")
    .trim()
    .toLowerCase();
  return isExactReviewCloseGuardLabel(label);
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

async function recordLifecycleCommandAcknowledgement(env, completion) {
  const queue = exactReviewQueueStub(env);
  if (!queue) return { accepted: true, sourceDeliveryId: null };
  const observedAt = Date.parse(String(completion.completed_at || ""));
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/lifecycle/command-ack/observed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        canonical_target_key: `${completion.canonical_repository ?? completion.repository}#${completion.number}`,
        status_marker: completion.status_marker,
        command_comment_id: completion.source_comment_id,
        completion_comment_id: completion.completion_comment_id,
        include_delivery_identity: true,
        ...(completion.require_exact_status_comment ? { require_exact_status_comment: true } : {}),
        observed_at: Number.isFinite(observedAt) ? observedAt : Date.now(),
      }),
    }),
  );
  if (!response.ok) throw new Error("lifecycle acknowledgement receipt unavailable");
  const result = objectValue(await response.json());
  return {
    accepted: result.accepted !== false,
    sourceDeliveryId: nullableString(result.source_delivery_id),
  };
}

async function reserveExactReviewSourceAuthority(
  env,
  {
    deliveryId,
    decision,
    ingress,
  }: {
    deliveryId: string;
    decision: ExactReviewDecision & { installationId?: number };
    ingress?: ExactReviewIngress;
  },
): Promise<{ deduped: true } | { sourceAuthoritySeq: number } | null> {
  const queue = exactReviewQueueStub(env);
  if (!queue) return null;
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/source-authority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        delivery_id: deliveryId,
        decision,
        ...(ingress ? { ingress } : {}),
        installation_id: decision.installationId,
      }),
    }),
  );
  const body = objectValue(await response.json().catch(() => null));
  if (!response.ok) {
    throw new Error(String(body.error || "exact-review source authority unavailable"));
  }
  if (body.deduped === true) return { deduped: true as const };
  const sourceAuthoritySeq = Number(body.source_authority_seq);
  if (!Number.isSafeInteger(sourceAuthoritySeq) || sourceAuthoritySeq <= 0) {
    throw new Error("exact-review source authority unavailable");
  }
  return { sourceAuthoritySeq };
}

async function completeExactReviewSourceAuthority(
  env,
  deliveryId: string,
  sourceAuthoritySeq: number,
  disposition: "enqueued" | "mismatch",
) {
  const queue = exactReviewQueueStub(env);
  if (!queue) throw new Error("exact-review queue not configured");
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/source-authority/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        delivery_id: deliveryId,
        source_authority_seq: sourceAuthoritySeq,
        disposition,
      }),
    }),
  );
  if (!response.ok) {
    const body = objectValue(await response.json().catch(() => null));
    throw new Error(String(body.error || "exact-review source authority completion failed"));
  }
}

async function exactReviewQueueRequest(env, path, request?: Request) {
  const queue = exactReviewQueueStub(env);
  if (!queue) return json({ error: "exact_review_queue_not_configured" }, 503);
  const body = request ? await request.text() : undefined;
  return queue.fetch(
    new Request(`https://clawsweeper-exact-review-queue${path}`, {
      method: request?.method || "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      ...(body ? { body } : {}),
    }),
  );
}

export async function durableLifecycleBaySnapshot(env, now = Date.now()) {
  let response: Response;
  let body: Record<string, unknown>;
  try {
    response = await exactReviewQueueRequest(env, "/lifecycle-bay");
    body = objectValue(await response.json().catch(() => null));
  } catch {
    return unknownDurableLifecycleBay("unavailable", now);
  }
  const snapshot = objectValue(body.durable_lifecycle_bay) as Record<string, unknown>;
  const checkedAt = Date.now();
  if (!response.ok) return unknownDurableLifecycleBay("unavailable", now);
  if (!validDurableLifecycleBaySnapshot(snapshot, checkedAt)) {
    return unknownDurableLifecycleBay("malformed", checkedAt);
  }
  if (checkedAt - Date.parse(String(snapshot.generated_at)) > 60_000) {
    return unknownDurableLifecycleBay("stale", checkedAt);
  }
  return snapshot;
}

export async function liveActivityBaySnapshotForRequest(
  request: Request,
  env,
  ctx,
  now = Date.now(),
) {
  try {
    const statusRequest = new Request(new URL("/api/status", request.url).toString());
    const response = await statusJson(statusRequest, env, ctx);
    return liveActivityBaySnapshot(await response.json(), now);
  } catch {
    return liveActivityBaySnapshot(null, now);
  }
}

function unknownDurableLifecycleBay(reason, now = Date.now()) {
  return {
    version: 1,
    source: "exact-review-lifecycle-projection-v1",
    generated_at: new Date(now).toISOString(),
    freshness: { maximum_age_ms: 60_000 },
    collection: { state: "unknown", reason },
    inventory: null,
    lanes: null,
    sample: null,
  };
}

function validDurableLifecycleBaySnapshot(value, now = Date.now()) {
  const snapshot = objectValue(value);
  if (
    snapshot.version !== 1 ||
    snapshot.source !== "exact-review-lifecycle-projection-v1" ||
    !Number.isFinite(Date.parse(String(snapshot.generated_at || ""))) ||
    Date.parse(String(snapshot.generated_at)) > now + 60_000 ||
    !objectValue(snapshot.freshness) ||
    Number(snapshot.freshness.maximum_age_ms) !== 60_000
  ) {
    return false;
  }
  const collection = objectValue(snapshot.collection);
  if (collection.state === "unknown") {
    return (
      ["unavailable", "malformed", "mixed", "stale", "over_cap"].includes(
        String(collection.reason),
      ) &&
      snapshot.inventory === null &&
      snapshot.lanes === null &&
      snapshot.sample === null
    );
  }
  if (collection.state !== "complete") return false;
  const inventory = objectValue(snapshot.inventory);
  const lanes = objectValue(snapshot.lanes);
  const sample = objectValue(snapshot.sample);
  if (
    !["lifecycle_records", "target_revisions", "unique_targets"].every(
      (key) => Number.isSafeInteger(inventory[key]) && Number(inventory[key]) >= 0,
    ) ||
    ![
      "pending",
      "acknowledgement_pending",
      "completed",
      "superseded",
      "requeued",
      "terminal_attention",
    ].every((key) => Number.isSafeInteger(lanes[key]) && Number(lanes[key]) >= 0) ||
    Number(sample.limit) !== 24 ||
    !Number.isSafeInteger(sample.returned) ||
    !Number.isSafeInteger(sample.omitted) ||
    !Array.isArray(sample.cards) ||
    sample.returned !== sample.cards.length ||
    sample.cards.length > 24 ||
    sample.omitted !== Math.max(0, Number(inventory.lifecycle_records) - sample.cards.length)
  ) {
    return false;
  }
  return sample.cards.every(validDurableLifecycleBayCard);
}

function validDurableLifecycleBayCard(value) {
  const card = objectValue(value);
  const target = objectValue(card.target);
  const facts = objectValue(card.facts);
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(target.repository || "")) &&
    Number.isSafeInteger(target.number) &&
    Number(target.number) > 0 &&
    target.url === `https://github.com/${target.repository}/issues/${target.number}` &&
    Number.isSafeInteger(card.revision) &&
    Number(card.revision) > 0 &&
    [
      "pending",
      "completed",
      "acknowledgement_pending",
      "acknowledgement_skipped",
      "superseded",
      "requeue",
      "dead_letter",
      "target_closed",
      "target_missing",
      "policy_noop",
      "guarded_open",
      "failed",
    ].includes(String(card.state)) &&
    [
      "pending",
      "acknowledgement_pending",
      "completed",
      "superseded",
      "requeued",
      "terminal_attention",
    ].includes(String(card.lane)) &&
    (card.terminal_label === null ||
      [
        "review_completed_routed",
        "superseded",
        "requeue",
        "acknowledgement_skipped",
        "dead_letter",
        "target_closed",
        "target_missing",
        "policy_noop",
        "guarded_open",
        "failure",
      ].includes(String(card.terminal_label))) &&
    Array.isArray(card.terminal_history) &&
    card.terminal_history.every((entry) =>
      [
        "review_completed_routed",
        "superseded",
        "requeue",
        "dead_letter",
        "target_closed",
        "target_missing",
        "policy_noop",
        "guarded_open",
        "failure",
      ].includes(String(entry)),
    ) &&
    typeof card.current_revision === "boolean" &&
    facts.admission === "recorded" &&
    Number.isSafeInteger(facts.claim_count) &&
    Number(facts.claim_count) >= 0 &&
    [null, "completed", "failed", "cancelled"].includes(facts.review_result) &&
    typeof facts.github_effect_recorded === "boolean" &&
    Array.isArray(facts.canonical_receipts) &&
    facts.canonical_receipts.every((entry) =>
      ["accepted", "deduped", "superseded"].includes(entry),
    ) &&
    [null, "durable", "not_required"].includes(facts.router_receipt) &&
    [
      "not_required",
      "pending",
      "observed",
      "skipped_locked",
      "skipped_missing_comment",
      "unavailable",
    ].includes(facts.acknowledgement) &&
    Number.isFinite(Date.parse(String(card.updated_at || ""))) &&
    Number.isSafeInteger(card.age_ms) &&
    Number(card.age_ms) >= 0 &&
    card.provenance === "exact-review-lifecycle-projection-v1"
  );
}

async function recentDurablePublicationEventsSnapshot(env, window = "24h") {
  const response = await exactReviewQueueRequest(
    env,
    `/recent-durable-publication-events?window=${encodeURIComponent(window)}`,
  );
  const body = objectValue(await response.json().catch(() => null));
  if (!response.ok)
    throw new Error(String(body.error || "recent durable publication events unavailable"));
  return body.recent_durable_publication_events ?? null;
}

export async function exactReviewQueueStatusSnapshot(
  env,
  options: { bayPriorityKeys?: string[] } = {},
) {
  if (!exactReviewQueueStub(env)) return null;
  const priorityKeys = [...new Set(options.bayPriorityKeys || [])]
    .filter((itemKey) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(itemKey))
    .slice(0, 40);
  const search = new URLSearchParams();
  for (const itemKey of priorityKeys) search.append("bay_priority_key", itemKey);
  const response = await exactReviewQueueRequest(
    env,
    `/stats${search.size ? `?${search.toString()}` : ""}`,
  );
  const body = objectValue(await response.json().catch(() => null));
  const health = objectValue(body.handoff_health);
  if (
    !response.ok ||
    !["idle", "healthy", "degraded", "stalled"].includes(String(health.status || ""))
  ) {
    throw new Error(String(body.error || "exact-review queue status unavailable"));
  }
  return body;
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

async function authenticatedExactReviewQueueRequest(
  request,
  env,
  path: string,
  onAuthenticatedResponse?: (body: string, response: Response) => Promise<void>,
) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  const body = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText: body }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  const response = await exactReviewQueueRequest(
    env,
    path,
    new Request(`https://clawsweeper-exact-review-queue${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  if (onAuthenticatedResponse) await onAuthenticatedResponse(body, response);
  return response;
}

async function authenticatedLifecycleCommandAcknowledgement(request, env, ctx) {
  return authenticatedExactReviewQueueRequest(
    request,
    env,
    "/lifecycle/command-ack/observed",
    async (body, response) => {
      if (!env.STATUS_STORE || !response.ok) return;
      const result = objectValue(
        await response
          .clone()
          .json()
          .catch(() => null),
      );
      const receipt = objectValue(parseJsonObject(body));
      const statusMarker = String(receipt.status_marker || "");
      const target = String(receipt.canonical_target_key || "").match(/^([^#]+)#(\d+)$/);
      const completionCommentId = Number(receipt.completion_comment_id);
      const completedAt = exactWebhookTimestamp(receipt.completed_at);
      if (
        result.accepted === true &&
        target &&
        completedAt &&
        /<!--\s*clawsweeper-command-status:\d+:(review|re_review):/i.test(statusMarker)
      ) {
        await recordBayJourneyTelemetry(
          env,
          ctx,
          [],
          [
            {
              repository: target[1],
              number: Number(target[2]),
              source_comment_id: Number(receipt.command_comment_id),
              ...(nullableString(result.source_delivery_id)
                ? { source_delivery_id: nullableString(result.source_delivery_id) }
                : {}),
              completed_at: completedAt,
              completion_kind: "final_command_status",
              completion_comment_id: completionCommentId,
            },
          ],
        );
      }
    },
  );
}

async function authenticatedExactReviewQueueRead(request, env, path: string) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  const body = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText: body }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  return exactReviewQueueRequest(
    env,
    path,
    new Request(`https://clawsweeper-exact-review-queue${path}`, { method: "GET" }),
  );
}

async function authenticatedExactReviewQueueCursorRequest(request, env, path: string) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  const body = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText: body }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  const init: RequestInit = {
    method: request.method,
    headers: { "content-type": "application/json" },
  };
  if (request.method === "PUT") init.body = body;
  return exactReviewQueueRequest(
    env,
    path,
    new Request(`https://clawsweeper-exact-review-queue${path}`, init),
  );
}

async function authenticatedStateBlobRequest(request, env, operation: StateBlobOperation) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  const bodyText = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  const body = parseJsonObject(bodyText);
  if (!body) return json({ error: "invalid_json" }, 400);
  return handleStateBlobRequest(env.STATE_SNAPSHOTS, operation, body);
}

async function authenticatedExactReviewOperatorRequest(request, env, path: string) {
  const secret = stringEnv(env.EXACT_REVIEW_OPERATOR_SECRET);
  if (!secret) return json({ error: "operator_not_configured" }, 503);
  const body = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText: body }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  return exactReviewQueueRequest(
    env,
    path,
    new Request(`https://clawsweeper-exact-review-queue${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

async function authenticatedApplyObservability(request, env) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  if (!isDurableStatusStore(env.STATUS_STORE))
    return json({ error: "apply_observability_not_configured" }, 503);
  const body = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText: body }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  return durableStatusStoreStub(env.STATUS_STORE).fetch(
    new Request(statusStoreRequest("apply-observability", "POST"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

async function applyObservabilityJson(request: Request, env: DashboardEnv) {
  const params = new URL(request.url).searchParams;
  const rangeValue = params.get("range");
  const range = rangeValue === "6h" || rangeValue === "7d" ? rangeValue : "24h";
  const repoValue = params.get("repo");
  const repo = repoValue && repoValue !== "all" ? repoValue : null;
  if (!isDurableStatusStore(env.STATUS_STORE)) {
    return json({ error: "apply_observability_not_configured" }, 503);
  }
  const requiredRepositories = String(env.APPLY_TARGET_REPOS || "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const optionalRepositories = String(env.APPLY_OPTIONAL_TARGET_REPOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const storeUrl = new URL(statusStoreRequest("apply-observability").url);
  storeUrl.searchParams.set("range", range);
  if (repo) storeUrl.searchParams.set("repo", repo);
  requiredRepositories.forEach((value) => storeUrl.searchParams.append("required_repo", value));
  optionalRepositories.forEach((value) => storeUrl.searchParams.append("optional_repo", value));
  const response = await durableStatusStoreStub(env.STATUS_STORE).fetch(new Request(storeUrl));
  if (!response.ok) return json({ error: "apply_observability_unavailable" }, 503);
  return json(await response.json());
}

async function authenticatedExactReviewReconcile(request, env) {
  const secret = stringEnv(env.CLAWSWEEPER_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook_not_configured" }, 503);
  const bodyText = await request.text();
  const signature = request.headers.get("x-clawsweeper-exact-review-signature") || "";
  if (!(await verifyGithubWebhookSignature({ secret, signature, bodyText }))) {
    return json({ error: "invalid_signature" }, 401);
  }
  const body = parseJsonObject(bodyText);
  if (!body) return json({ error: "invalid_json" }, 400);
  if (Object.hasOwn(body, "terminal_runs")) {
    if (!exactReviewTerminalRuns(body.terminal_runs)) {
      return json({ error: "invalid_terminal_runs" }, 400);
    }
    return exactReviewQueueRequest(
      env,
      "/reconcile",
      new Request("https://clawsweeper-exact-review-queue/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runs: body.terminal_runs }),
      }),
    );
  }
  const requestedRuns = exactReviewRequestedRuns(body.runs ?? body.run_ids);
  if (!requestedRuns) return json({ error: "invalid_runs" }, 400);
  const includeAllClaimed = body.include_all_claimed === true;
  if (body.include_all_claimed !== undefined && typeof body.include_all_claimed !== "boolean") {
    return json({ error: "invalid_include_all_claimed" }, 400);
  }

  const claimedResponse = await exactReviewQueueRequest(
    env,
    "/claimed-runs",
    new Request("https://clawsweeper-exact-review-queue/claimed-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runs: requestedRuns.map((run) => ({
          run_id: run.runId,
          ...(run.runAttempt ? { run_attempt: run.runAttempt } : {}),
        })),
        ...(includeAllClaimed ? { include_all_claimed: true } : {}),
      }),
    }),
  );
  if (!claimedResponse.ok) return json({ error: "exact_review_queue_unavailable" }, 503);
  const claimedBody = objectValue(await claimedResponse.json().catch(() => null));
  const claimedRuns = exactReviewClaimedRuns(claimedBody.runs);
  if (!claimedRuns) return json({ error: "exact_review_queue_unavailable" }, 503);
  const candidates: Array<ExactReviewClaimedRun & { requestedRunAttempt?: number }> = [];
  const candidateRequests = includeAllClaimed
    ? [...new Set(claimedRuns.map((claimed) => claimed.runId))].map((runId) => ({
        runId,
        runAttempt: undefined,
      }))
    : requestedRuns;
  for (const requested of candidateRequests) {
    const matches = claimedRuns.filter((claimed) => claimed.runId === requested.runId);
    if (matches.length !== 1) continue;
    candidates.push({
      ...matches[0],
      requestedRunAttempt: includeAllClaimed ? matches[0].runAttempt : requested.runAttempt,
    });
  }
  if (!candidates.length) {
    return json({
      ok: true,
      requested: requestedRuns.length,
      claimed: 0,
      terminal: 0,
      unavailable: 0,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
  }

  let token: string;
  try {
    token = await exactReviewActionsReadToken(env);
  } catch {
    return json({ error: "github_run_status_unavailable" }, 502);
  }
  const checked = includeAllClaimed
    ? await exactReviewTerminalRunsFromBatch(token, candidates, env)
    : await mapWithConcurrency(
        candidates,
        EXACT_REVIEW_RECONCILE_CONCURRENCY,
        async (candidate) => {
          try {
            return await exactReviewTerminalRun(token, candidate, env);
          } catch {
            return undefined;
          }
        },
      );
  const unavailable = checked.filter((result) => result === undefined).length;
  const terminalRuns = checked.filter(
    (
      result,
    ): result is {
      run_id: string;
      run_attempt: number;
      claimed_run_attempt: number | null;
      claim_generation: number;
      outcome: ExactReviewCompletionOutcome;
    } => Boolean(result),
  );
  let reconciliation = { reconciled: 0, requeued: 0, completed: 0 };
  if (terminalRuns.length) {
    const response = await exactReviewQueueRequest(
      env,
      "/reconcile",
      new Request("https://clawsweeper-exact-review-queue/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runs: terminalRuns }),
      }),
    );
    if (!response.ok) return json({ error: "exact_review_reconcile_failed" }, 502);
    const result = objectValue(await response.json().catch(() => null));
    reconciliation = {
      reconciled: Number(result.reconciled) || 0,
      requeued: Number(result.requeued) || 0,
      completed: Number(result.completed) || 0,
    };
  }
  return json(
    {
      ok: unavailable === 0,
      requested: requestedRuns.length,
      claimed: candidates.length,
      terminal: terminalRuns.length,
      unavailable,
      ...reconciliation,
    },
    unavailable ? 502 : 200,
  );
}

async function enqueueExactReview({
  deliveryId,
  decision,
  ingress,
  env,
}: {
  deliveryId: string;
  decision: ExactReviewDecision;
  ingress?: ExactReviewIngress;
  env: DashboardEnv;
}) {
  const queue = exactReviewQueueStub(env);
  if (!queue) return null;
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery_id: deliveryId, decision, ...(ingress ? { ingress } : {}) }),
    }),
  );
  const body = objectValue(await response.json().catch(() => null));
  if (!response.ok) throw new Error(String(body.error || "exact review queue rejected item"));
  return body;
}

async function acknowledgePullRequestReceipt({ env, ctx, decision }) {
  if (
    decision.itemKind !== "pull_request" ||
    !["opened", "ready_for_review"].includes(decision.sourceAction)
  ) {
    return null;
  }
  const credentials = githubAppCredentials(env);
  if (!credentials || !Number.isInteger(decision.installationId) || decision.installationId <= 0) {
    return null;
  }
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const token = await createGithubAppTokenFor({
    env,
    appJwt,
    installationId: decision.installationId,
    label: decision.targetRepo,
    repositories: [repoName(decision.targetRepo)],
    permissions: { issues: "write", pull_requests: "write" },
  });
  const ackMarker = pullRequestFastAckMarker(decision.itemNumber, decision.sourceAction);
  const ackMatch = pullRequestFastAckMatch(decision.itemNumber);
  const statusCommentId = await createFastAckCommentOnce({
    env,
    token,
    repo: decision.targetRepo,
    itemNumber: decision.itemNumber,
    ackMarker,
    ackMatch,
    ackDedupeKey: "clawsweeper-pr-ack",
    ackBody: renderPullRequestFastAckComment(ackMarker),
  });
  settleFastAckComments({
    env,
    token,
    repo: decision.targetRepo,
    itemNumber: decision.itemNumber,
    ackMarker,
    ackMatch,
    delaysMs: fastAckSettleDelaysMs(env.CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS),
    waitUntil: ctx?.waitUntil?.bind(ctx),
  });
  return statusCommentId;
}

async function createFastAckComment({
  env,
  token,
  repo,
  itemNumber,
  sourceCommentId = undefined,
  ackMarker = fastAckMarker(sourceCommentId),
  ackMatch = undefined,
  ackBody = renderFastAckComment(sourceCommentId),
}) {
  const existingId = await pruneFastAckComments({
    env,
    token,
    repo,
    itemNumber,
    ackMarker,
    ackMatch,
  });
  if (existingId) return existingId;
  const payload = await githubTokenJson({
    env,
    token,
    path: `/repos/${repo}/issues/${itemNumber}/comments`,
    method: "POST",
    body: { body: ackBody },
    errorLabel: "ClawSweeper ack comment",
  });
  return (
    (await pruneFastAckComments({ env, token, repo, itemNumber, ackMarker, ackMatch })) ||
    Number(payload.id) ||
    null
  );
}

function settleFastAckComments({
  env,
  token,
  repo,
  itemNumber,
  sourceCommentId = undefined,
  ackMarker = fastAckMarker(sourceCommentId),
  ackMatch = undefined,
  delaysMs = DEFAULT_FAST_ACK_SETTLE_DELAYS_MS,
  waitUntil,
}) {
  const cleanup = async () => {
    for (const delayMs of delaysMs) {
      await sleep(delayMs);
      await pruneFastAckComments({ env, token, repo, itemNumber, ackMarker, ackMatch });
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

async function createFastAckCommentOnce({
  env,
  token,
  repo,
  itemNumber,
  sourceCommentId = undefined,
  ackMarker = fastAckMarker(sourceCommentId),
  ackMatch = undefined,
  ackDedupeKey = ackMarker,
  ackBody = renderFastAckComment(sourceCommentId),
}) {
  const key = fastAckKey({ repo, itemNumber, ackMarker: ackDedupeKey });
  const pending = inFlightFastAcks.get(key);
  if (pending) return pending;
  const next = createFastAckComment({
    env,
    token,
    repo,
    itemNumber,
    ackMarker,
    ackMatch,
    ackBody,
  }).finally(() => {
    inFlightFastAcks.delete(key);
  });
  inFlightFastAcks.set(key, next);
  return next;
}

function fastAckKey({ repo, itemNumber, ackMarker }) {
  return `${String(repo).toLowerCase()}:${itemNumber}:${ackMarker}`;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function pruneFastAckComments({
  env,
  token,
  repo,
  itemNumber,
  sourceCommentId = undefined,
  ackMarker = fastAckMarker(sourceCommentId),
  ackMatch = undefined,
}) {
  const comments = await listFastAckComments({
    env,
    token,
    repo,
    itemNumber,
    ackMarker,
    ackMatch,
  });
  if (!comments.length) return null;
  const hasStatusComment = comments.some(isStatusBearingFastAckComment);
  comments.sort(compareFastAckKeepPriority);
  const keepId = Number(objectValue(comments[0]).id) || null;
  for (const comment of comments) {
    const id = Number(objectValue(comment).id) || 0;
    if (id <= 0 || id === keepId) continue;
    if (hasStatusComment && isStatusBearingFastAckComment(comment)) continue;
    await githubTokenJson({
      env,
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

async function listFastAckComments({
  env,
  token,
  repo,
  itemNumber,
  ackMarker,
  ackMatch = undefined,
}) {
  const comments = [];
  const matchesAckBody = ackMatch || ((body) => body.includes(ackMarker));
  const since = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  for (let page = 1; page <= 5; page += 1) {
    const payload = await githubTokenJson({
      env,
      token,
      path: `/repos/${repo}/issues/${itemNumber}/comments?per_page=100&page=${page}&since=${since}`,
      method: "GET",
      body: undefined,
      errorLabel: "ClawSweeper ack comment lookup",
    });
    if (!Array.isArray(payload)) return comments;
    for (const comment of payload) {
      if (
        matchesAckBody(String(objectValue(comment).body || "")) &&
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

function pullRequestFastAckMarker(itemNumber, sourceAction) {
  return `<!-- clawsweeper-pr-ack:${sourceAction} item=${itemNumber} -->`;
}

// `opened` and `ready_for_review` can arrive seconds apart for one pull
// request, so receipts dedupe per item across actions — the same
// prefix+suffix identity the target dispatch workflow checks.
function pullRequestFastAckMatch(itemNumber) {
  const suffix = ` item=${itemNumber} -->`;
  return (body) => body.includes("clawsweeper-pr-ack:") && body.includes(suffix);
}

function renderPullRequestFastAckComment(ackMarker) {
  return [
    ackMarker,
    "🦞👀",
    "ClawSweeper picked this up.",
    "",
    "Pull request received. I will update this pull request when review starts.",
  ].join("\n");
}

async function addIssueCommentReaction({ env, token, repo, commentId, content }) {
  await githubTokenJson({
    env,
    token,
    path: `/repos/${repo}/issues/comments/${commentId}/reactions`,
    method: "POST",
    body: { content },
    errorLabel: "ClawSweeper comment reaction",
  }).catch((error) => {
    if (!String(error.message || "").includes("422")) {
      console.error(`ClawSweeper comment reaction failed: ${error?.message || error}`);
    }
    return null;
  });
}

async function dispatchClawsweeperComment({
  env,
  token,
  decision,
  statusCommentId,
  sourceDeliveryId,
}) {
  const exactVersion =
    decision.commentUpdatedAt && typeof decision.commentBody === "string"
      ? {
          comment_event_auth: "github_webhook_v1",
          comment_updated_at: decision.commentUpdatedAt,
          comment_body_sha256: await sha256Text(decision.commentBody),
        }
      : {};
  await githubTokenJson({
    env,
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
        ...(sourceDeliveryId ? {} : { source_event: "issue_comment" }),
        source_action: decision.sourceAction,
        ...(sourceDeliveryId ? { source_delivery_id: sourceDeliveryId } : {}),
        ...exactVersion,
      },
    },
    errorLabel: "ClawSweeper comment dispatch",
  });
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hexEncode(new Uint8Array(digest));
}

async function githubTokenJson({ env = {}, token, path, method = "GET", body, errorLabel }) {
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-webhook",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(githubApiUrl(env, path), init);
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
  if (cached?.bay?.timings?.sample_kind === "completed_review_journeys") {
    return cached;
  }

  const github = createGithubJsonCache(env);
  const generatedAt = new Date().toISOString();
  const errors = [];
  const repo = env.CLAWSWEEPER_REPO || "openclaw/clawsweeper";
  const targetRepos = String(env.TARGET_REPOS || "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const budget = numberFrom(env.WORKER_BUDGET, 128);
  const activeRunErrors = [];
  const [runs, completedRuns, activeRunCandidates] = await Promise.all([
    github(`/repos/${repo}/actions/runs?per_page=100`).catch((error) => {
      errors.push(`workflow runs: ${error.message}`);
      return null;
    }),
    github(`/repos/${repo}/actions/runs?status=completed&per_page=100`).catch((error) => {
      errors.push(`workflow runs completed: ${error.message}`);
      return null;
    }),
    activeWorkflowRunCandidates(env, repo, activeRunErrors, github),
  ]);
  errors.push(...activeRunErrors);
  const workflowRuns = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  const completedWorkflowRuns = uniqueWorkflowRuns([
    ...(Array.isArray(completedRuns?.workflow_runs) ? completedRuns.workflow_runs : []),
    ...workflowRuns.filter((run) => run.status === "completed"),
  ]).sort(newestWorkflowRunFirst);
  const activeRuns = uniqueWorkflowRuns([
    ...activeRunCandidates.filter((run) => isActiveWorkflowRun(run)),
    ...workflowRuns.filter((run) => isActiveWorkflowRun(run)),
  ]).sort(newestWorkflowRunFirst);
  const workerRuns = activeRuns.filter((run) => !isSupportWorkflowRun(run));
  const supportRuns = activeRuns.filter((run) => isSupportWorkflowRun(run));
  const controlPlane = controlPlaneSnapshot(activeRuns);
  const operationalHealth = summarizeOperationalHealth(
    activeRunCandidates.filter((run) => !isSupportWorkflowRun(run)),
    generatedAt,
    activeRunErrors.length === 0,
  );
  const failedRuns = completedWorkflowRuns.filter(
    (run) =>
      run.status === "completed" &&
      !isSupportWorkflowRun(run) &&
      isCodexWorkflowFallback(run) &&
      TERMINAL_BAD_CONCLUSIONS.has(String(run.conclusion)),
  );
  const activeJobs = await activeWorkerSnapshot(env, repo, workerRuns, github);
  const [
    workerHealth,
    pipeline,
    clusterRepair,
    applyHealth,
    automerge,
    automergeReliability,
    closed,
    storedEvents,
  ] = await Promise.all([
    withTimeout(
      recentWorkerHealth(env, repo, completedWorkflowRuns, github),
      OPTIONAL_SECTION_TIMEOUT_MS * 2,
      "worker health",
    ).catch((error) => {
      errors.push(error.message);
      return emptyWorkerHealth(generatedAt);
    }),
    withTimeout(
      pipelineItems(env, workerRuns.slice(0, 30), github),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "pipeline",
    ).catch((error) => {
      errors.push(error.message);
      return workerRuns.slice(0, 30).map((run) => classifyRun(run));
    }),
    withTimeout(
      clusterRepairStatus(env, repo, targetRepos, activeRuns, github),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "cluster repair intake",
    ).catch((error) => {
      errors.push(error.message);
      return emptyClusterRepairStatus(targetRepos);
    }),
    withTimeout(
      applyHealthStatus(env, targetRepos, github),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "apply health",
    ).catch((error) => {
      errors.push(error.message);
      return emptyApplyHealthStatus(targetRepos);
    }),
    withTimeout(
      recentAutomerge(env, targetRepos[0] || "openclaw/openclaw", github),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "automerge timing",
    ).catch((error) => {
      errors.push(error.message);
      return { average_ms: null, samples: 0, items: [] };
    }),
    withTimeout(
      recentAutomergeReliability(env, repo, targetRepos, github),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "automerge reliability",
    ).catch((error) => {
      errors.push(error.message);
      return emptyAutomergeReliability(generatedAt);
    }),
    withTimeout(
      recentClawsweeperClosed(env, targetRepos, github),
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
  const terminalBay = await updateBayTerminalState(
    env,
    workerHealth.recent_attempts,
    closed.items,
    generatedAt,
    activeBayItemKeys(activeJobs.workers),
  ).catch((error) => {
    errors.push(`OpenClaw Bay terminal state: ${error instanceof Error ? error.message : error}`);
    return emptyBayTerminalState(generatedAt);
  });
  const journeyBay = await readBayJourneyState(env).catch((error) => {
    errors.push(`OpenClaw Bay journey state: ${error instanceof Error ? error.message : error}`);
    return { journeys: [] };
  });
  const bay = {
    ...terminalBay,
    timings: summarizeBayJourneyTimings(journeyBay.journeys, generatedAt),
  };
  const { recent_attempts: _recentAttempts, ...publicWorkerHealth } = workerHealth;

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
    control_plane: controlPlane,
    health: publicWorkerHealth,
    operational_health: operationalHealth,
    averages: {
      automerge_command_to_merge_ms: automerge.average_ms,
      automerge_samples: automerge.samples,
    },
    workers: activeJobs.workers,
    automatic_work: automaticIssueWork(storedEvents, activeJobs.workers),
    pipeline,
    bay,
    recent: {
      cluster_repair: clusterRepair,
      apply_health: applyHealth,
      automerge: automerge.items,
      automerge_reliability: automergeReliability,
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

async function attachExactReviewQueueStatus(snapshot, env) {
  const diagnostics = objectValue(snapshot.diagnostics);
  const bay = objectValue(snapshot.bay);
  const bayPriorityKeys = [
    ...(Array.isArray(bay.terminal_buffer) ? bay.terminal_buffer : []),
    ...(Array.isArray(bay.recently_washed) ? bay.recently_washed : []),
  ]
    .map((item) => String(objectValue(item).item_key || ""))
    .filter(Boolean);
  let exactReviewQueue = null;
  let exactReviewQueueError = null;
  let recentDurablePublicationEvents = null;
  let recentDurablePublicationEventsError = null;
  const exactReviewQueueRequest = withTimeout(
    exactReviewQueueStatusSnapshot(env, { bayPriorityKeys }),
    OPTIONAL_SECTION_TIMEOUT_MS,
    "exact-review queue",
  );
  const recentDurablePublicationEventsRequest = withTimeout(
    recentDurablePublicationEventsSnapshot(env),
    OPTIONAL_SECTION_TIMEOUT_MS,
    "recent durable publication events",
  );
  const [queueResult, eventsResult] = await Promise.allSettled([
    exactReviewQueueRequest,
    recentDurablePublicationEventsRequest,
  ]);
  if (queueResult.status === "fulfilled") exactReviewQueue = queueResult.value;
  else
    exactReviewQueueError =
      queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason);
  if (eventsResult.status === "fulfilled") recentDurablePublicationEvents = eventsResult.value;
  else
    recentDurablePublicationEventsError =
      eventsResult.reason instanceof Error
        ? eventsResult.reason.message
        : String(eventsResult.reason);
  const attached = {
    ...snapshot,
    exact_review_queue: exactReviewQueue,
    recent_durable_publication_events: recentDurablePublicationEvents,
    diagnostics: {
      ...diagnostics,
      exact_review_queue_error: exactReviewQueueError,
      recent_durable_publication_events_error: recentDurablePublicationEventsError,
    },
  };
  return { ...attached, dashboard_health: summarizeDashboardHealth(attached) };
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

async function activeWorkerSnapshot(
  env,
  repo,
  runs,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
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
      const jobs = await workflowJobsForRun(env, repo, run.id, github, run);
      const activeJobs = jobs.filter((job) => isActiveWorkflowJob(job));
      return {
        run,
        workers: activeJobs
          .filter((job) => isDashboardWorkerJob(job, run))
          .map((job) => normalizeWorkerJob(run, job)),
        codexWorkers: activeJobs.filter((job) => isCodexWorkerJob(job)).length,
        hasWorkerJobs: jobs.some((job) => isDashboardWorkerJob(job, run)),
        error: null,
      };
    } catch (error) {
      return {
        run,
        workers: [],
        codexWorkers: 0,
        hasWorkerJobs: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const workers = [];
  const errors = [];
  let fallbacks = 0;
  let codexWorkers = 0;
  for (const result of results) {
    codexWorkers += result.codexWorkers;
    if (result.error) {
      errors.push(`workflow jobs ${result.run.id}: ${result.error}`);
      if (isCodexWorkflowFallback(result.run)) {
        workers.push(normalizeFallbackWorker(result.run));
        fallbacks += 1;
        codexWorkers += 1;
      }
      continue;
    }
    if (result.workers.length) {
      workers.push(...result.workers);
    } else if (!result.hasWorkerJobs && isCodexWorkflowFallback(result.run)) {
      workers.push(normalizeFallbackWorker(result.run));
      fallbacks += 1;
      codexWorkers += 1;
    }
  }
  for (const run of runs.slice(detailRunLimit)) {
    if (!isCodexWorkflowFallback(run)) continue;
    workers.push(normalizeFallbackWorker(run));
    fallbacks += 1;
    codexWorkers += 1;
  }
  workers.sort(
    (left, right) =>
      workerStatusRank(left.status) - workerStatusRank(right.status) ||
      laneRank(left.mode) - laneRank(right.mode) ||
      Date.parse(left.started_at || "") - Date.parse(right.started_at || ""),
  );
  await attachWorkerTargets(env, workers, errors);
  return {
    count: codexWorkers,
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

async function recentWorkerHealth(
  env,
  repo,
  runs: WorkflowRunSummary[],
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const cacheKey = `worker-health:v3:${String(repo || "").toLowerCase()}`;
  const cached = await readStoredJson(env, cacheKey);
  if (cached) return cached;

  const completedRuns = runs
    .filter(
      (run) =>
        run.status === "completed" && !isSupportWorkflowRun(run) && isCodexWorkflowFallback(run),
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
        attempts: (await workflowJobsForRun(env, repo, run.id, github, run))
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
    recent_attempts: [...attempts]
      .sort(
        (left, right) =>
          Date.parse(right.completed_at || right.started_at || "") -
          Date.parse(left.completed_at || left.started_at || ""),
      )
      .slice(0, 50),
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
    recent_attempts: [],
    failures: [],
    errors: [],
    updated_at: updatedAt,
  };
}

function boundedBayTimingDuration(startedAt, completedAt) {
  const started = Date.parse(String(startedAt || ""));
  const completed = Date.parse(String(completedAt || ""));
  const duration = completed - started;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || duration < 0) return null;
  if (duration > BAY_TIMING_MAX_SAMPLE_MS) return null;
  return duration;
}

export function summarizeBayJourneyTimings(journeys, generatedAt) {
  const parsedNow = Date.parse(String(generatedAt || ""));
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const cutoff = now - BAY_TIMING_WINDOW_MS;
  const overallDurations: number[] = [];
  for (const journey of Array.isArray(journeys) ? journeys : []) {
    const triggeredAt = Date.parse(String(journey?.triggered_at || ""));
    const completedAt = Date.parse(String(journey?.completed_at || ""));
    if (!Number.isFinite(completedAt) || completedAt < cutoff || completedAt > now) continue;
    const totalDuration = completedAt - triggeredAt;
    if (
      Number.isFinite(totalDuration) &&
      totalDuration >= 0 &&
      totalDuration <= BAY_TIMING_MAX_SAMPLE_MS
    ) {
      overallDurations.push(totalDuration);
    }
  }
  return {
    window_minutes: BAY_TIMING_WINDOW_MS / 60_000,
    sample_kind: "completed_review_journeys",
    sample_limit: BAY_JOURNEY_LIMIT,
    overall: {
      average_ms: overallDurations.length
        ? Math.round(
            overallDurations.reduce((total, value) => total + value, 0) / overallDurations.length,
          )
        : null,
      median_ms: overallDurations.length
        ? (() => {
            const ordered = [...overallDurations].sort((left, right) => left - right);
            const middle = Math.floor(ordered.length / 2);
            return ordered.length % 2
              ? ordered[middle]
              : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
          })()
        : null,
      samples: overallDurations.length,
    },
  };
}

function bayJourneyId(repository, itemNumber, sourceCommentId, sourceDeliveryId, triggeredAt) {
  const prefix = `${String(repository || "").toLowerCase()}#${Number(itemNumber)}:command:${Number(sourceCommentId)}`;
  return sourceDeliveryId
    ? `${prefix}:delivery:${sourceDeliveryId}`
    : `${prefix}:at:${Date.parse(triggeredAt)}`;
}

function bayJourneyCompletionId(
  repository,
  itemNumber,
  sourceCommentId,
  completionCommentId,
  completedAt,
  sourceDeliveryId,
) {
  const completedMarker = Date.parse(completedAt);
  const marker =
    Number.isSafeInteger(Number(completionCommentId)) && Number(completionCommentId) > 0
      ? `comment:${Number(completionCommentId)}:at:${completedMarker}`
      : `at:${completedMarker}`;
  const delivery = sourceDeliveryId ? `:delivery:${sourceDeliveryId}` : "";
  return `${String(repository || "").toLowerCase()}#${Number(itemNumber)}:command:${Number(sourceCommentId)}${delivery}:completion:${marker}`;
}

function bayJourneyTimestamp(value) {
  const text = String(value || "").trim();
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function normalizeBayJourneyTrigger(value) {
  const trigger = objectValue(value);
  const repository = nullableString(trigger.repository)?.toLowerCase() || null;
  const number = Number(trigger.number);
  const sourceCommentId = Number(trigger.source_comment_id);
  const sourceDeliveryId = nullableString(trigger.source_delivery_id);
  const triggeredAt = bayJourneyTimestamp(trigger.triggered_at);
  if (
    !repository ||
    !Number.isInteger(number) ||
    number <= 0 ||
    !Number.isSafeInteger(sourceCommentId) ||
    sourceCommentId <= 0 ||
    !triggeredAt
  ) {
    return null;
  }
  return {
    id: bayJourneyId(repository, number, sourceCommentId, sourceDeliveryId, triggeredAt),
    item_key: `${repository}#${number}`,
    repository,
    number,
    source_comment_id: sourceCommentId,
    source_delivery_id: sourceDeliveryId,
    triggered_at: triggeredAt,
  };
}

function normalizeBayJourneyCompletion(value) {
  const completion = objectValue(value);
  const repository = nullableString(completion.repository)?.toLowerCase() || null;
  const number = Number(completion.number);
  const sourceCommentId = Number(completion.source_comment_id);
  const sourceDeliveryId = nullableString(completion.source_delivery_id);
  const completedAt = bayJourneyTimestamp(completion.completed_at);
  const completionKind = nullableString(completion.completion_kind);
  const completionCommentId = Number(completion.completion_comment_id);
  if (
    !repository ||
    !Number.isInteger(number) ||
    number <= 0 ||
    !Number.isSafeInteger(sourceCommentId) ||
    sourceCommentId <= 0 ||
    !completedAt
  ) {
    return null;
  }
  return {
    id: bayJourneyCompletionId(
      repository,
      number,
      sourceCommentId,
      completionCommentId,
      completedAt,
      sourceDeliveryId,
    ),
    item_key: `${repository}#${number}`,
    repository,
    number,
    source_comment_id: sourceCommentId,
    ...(sourceDeliveryId ? { source_delivery_id: sourceDeliveryId } : {}),
    completed_at: completedAt,
    completion_kind: completionKind || "final_command_status",
    completion_comment_id:
      Number.isSafeInteger(completionCommentId) && completionCommentId > 0
        ? completionCommentId
        : null,
  };
}

function normalizeBayJourneyRecord(value) {
  const record = objectValue(value);
  const trigger = normalizeBayJourneyTrigger(record);
  const completion = normalizeBayJourneyCompletion({
    ...record,
    source_delivery_id: nullableString(record.completion_source_delivery_id),
  });
  if (!trigger && !completion) return null;
  const source = trigger || completion;
  return {
    id: source.id,
    item_key: source.item_key,
    repository: source.repository,
    number: source.number,
    source_comment_id: source.source_comment_id,
    source_delivery_id: trigger?.source_delivery_id || completion?.source_delivery_id || null,
    triggered_at: trigger?.triggered_at || null,
    completed_at: completion?.completed_at || null,
    completion_kind: completion?.completion_kind || null,
    completion_comment_id: completion?.completion_comment_id || null,
    ...(completion?.source_delivery_id
      ? { completion_source_delivery_id: completion.source_delivery_id }
      : {}),
  };
}

export function mergeBayJourneyState(previous, triggers, completions, generatedAt) {
  const parsedNow = Date.parse(String(generatedAt || ""));
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const cutoff = now - BAY_JOURNEY_TTL_SECONDS * 1000;
  const records = new Map();
  for (const value of Array.isArray(previous?.journeys) ? previous.journeys : []) {
    const record = normalizeBayJourneyRecord(value);
    const activityAt = Math.max(
      Date.parse(String(record?.completed_at || "")) || 0,
      Date.parse(String(record?.triggered_at || "")) || 0,
    );
    if (record && activityAt >= cutoff) records.set(record.id, record);
  }
  for (const value of Array.isArray(triggers) ? triggers : []) {
    const trigger = normalizeBayJourneyTrigger(value);
    if (!trigger) continue;
    const completedOrphan = [...records.values()]
      .filter(
        (record) =>
          record.repository === trigger.repository &&
          record.number === trigger.number &&
          record.source_comment_id === trigger.source_comment_id &&
          (!record.source_delivery_id ||
            !trigger.source_delivery_id ||
            record.source_delivery_id === trigger.source_delivery_id) &&
          !record.triggered_at &&
          (Date.parse(String(record.completed_at || "")) || 0) >= Date.parse(trigger.triggered_at),
      )
      .sort(
        (left, right) =>
          (trigger.source_delivery_id
            ? Number(right.source_delivery_id === trigger.source_delivery_id) -
              Number(left.source_delivery_id === trigger.source_delivery_id)
            : 0) ||
          (Date.parse(String(left.completed_at || "")) || 0) -
            (Date.parse(String(right.completed_at || "")) || 0),
      )[0];
    const current = records.get(trigger.id) || completedOrphan || {};
    if (completedOrphan && completedOrphan.id !== trigger.id) records.delete(completedOrphan.id);
    records.set(trigger.id, {
      ...current,
      ...trigger,
      id: trigger.id,
      triggered_at: trigger.triggered_at,
    });
  }
  for (const value of Array.isArray(completions) ? completions : []) {
    const completion = normalizeBayJourneyCompletion(value);
    if (!completion) continue;
    if (completion.source_delivery_id) {
      const legacyCompletionOnIdentifiedJourney = [...records.values()].find(
        (record) =>
          record.repository === completion.repository &&
          record.number === completion.number &&
          record.source_comment_id === completion.source_comment_id &&
          record.source_delivery_id === completion.source_delivery_id &&
          record.triggered_at &&
          record.completed_at &&
          !record.completion_source_delivery_id &&
          (record.completed_at !== completion.completed_at ||
            record.completion_comment_id !== completion.completion_comment_id),
      );
      if (legacyCompletionOnIdentifiedJourney) {
        const legacyCompletion = normalizeBayJourneyCompletion({
          ...legacyCompletionOnIdentifiedJourney,
          source_delivery_id: undefined,
        });
        if (legacyCompletion) {
          records.set(legacyCompletion.id, {
            ...legacyCompletion,
            id: legacyCompletion.id,
            source_delivery_id: null,
            triggered_at: null,
            completed_at: legacyCompletion.completed_at,
            completion_kind: legacyCompletion.completion_kind,
            completion_comment_id: legacyCompletion.completion_comment_id,
          });
        }
        records.set(legacyCompletionOnIdentifiedJourney.id, {
          ...legacyCompletionOnIdentifiedJourney,
          completed_at: null,
          completion_kind: null,
          completion_comment_id: null,
        });
      }
    }
    let exactCompletion = [...records.values()].find(
      (record) =>
        record.repository === completion.repository &&
        record.number === completion.number &&
        record.source_comment_id === completion.source_comment_id &&
        (!completion.source_delivery_id ||
          !record.completion_source_delivery_id ||
          record.completion_source_delivery_id === completion.source_delivery_id) &&
        record.completion_comment_id === completion.completion_comment_id &&
        record.completed_at === completion.completed_at,
    );
    if (
      exactCompletion &&
      completion.source_delivery_id &&
      exactCompletion.source_delivery_id !== completion.source_delivery_id &&
      !exactCompletion.completion_source_delivery_id
    ) {
      if (!exactCompletion.triggered_at) {
        records.delete(exactCompletion.id);
      } else {
        records.set(exactCompletion.id, {
          ...exactCompletion,
          completed_at: null,
          completion_kind: null,
          completion_comment_id: null,
        });
      }
      exactCompletion = undefined;
    }
    const current =
      exactCompletion ||
      (completion.source_delivery_id
        ? [...records.values()].find(
            (record) =>
              record.repository === completion.repository &&
              record.number === completion.number &&
              record.source_comment_id === completion.source_comment_id &&
              record.source_delivery_id === completion.source_delivery_id &&
              record.completion_source_delivery_id === completion.source_delivery_id &&
              (!record.triggered_at ||
                Date.parse(record.triggered_at) <= Date.parse(completion.completed_at)),
          )
        : undefined) ||
      [...records.values()]
        .filter(
          (record) =>
            record.repository === completion.repository &&
            record.number === completion.number &&
            record.source_comment_id === completion.source_comment_id &&
            (!completion.source_delivery_id ||
              !record.source_delivery_id ||
              record.source_delivery_id === completion.source_delivery_id) &&
            record.triggered_at &&
            !record.completed_at &&
            Date.parse(record.triggered_at) <= Date.parse(completion.completed_at),
        )
        .sort(
          (left, right) =>
            (completion.source_delivery_id
              ? Number(right.source_delivery_id === completion.source_delivery_id) -
                Number(left.source_delivery_id === completion.source_delivery_id)
              : 0) ||
            (Date.parse(String(right.triggered_at || "")) || 0) -
              (Date.parse(String(left.triggered_at || "")) || 0),
        )[0] ||
      records.get(completion.id) ||
      {};
    const recordId = current.id || completion.id;
    const currentCompletedAt = Date.parse(String(current.completed_at || ""));
    const completionAt = Date.parse(completion.completed_at);
    if (
      Number.isFinite(currentCompletedAt) &&
      (currentCompletedAt > completionAt ||
        (currentCompletedAt === completionAt &&
          Number(current.completion_comment_id || 0) >
            Number(completion.completion_comment_id || 0)))
    ) {
      continue;
    }
    if (current.id && current.id !== recordId) records.delete(current.id);
    records.set(recordId, {
      ...current,
      ...completion,
      id: recordId,
      completed_at: completion.completed_at,
      completion_kind: completion.completion_kind,
      completion_comment_id: completion.completion_comment_id,
      ...(completion.source_delivery_id
        ? { completion_source_delivery_id: completion.source_delivery_id }
        : {}),
    });
  }
  for (const record of records.values()) {
    if (!record.triggered_at || record.completed_at || !record.source_delivery_id) continue;
    const completedOrphan = [...records.values()]
      .filter(
        (candidate) =>
          !candidate.triggered_at &&
          candidate.completed_at &&
          candidate.repository === record.repository &&
          candidate.number === record.number &&
          candidate.source_comment_id === record.source_comment_id &&
          (candidate.source_delivery_id === record.source_delivery_id ||
            (!candidate.source_delivery_id &&
              [...records.values()].filter(
                (journey) =>
                  journey.triggered_at &&
                  !journey.completed_at &&
                  journey.repository === candidate.repository &&
                  journey.number === candidate.number &&
                  journey.source_comment_id === candidate.source_comment_id &&
                  Date.parse(journey.triggered_at) <= Date.parse(candidate.completed_at),
              ).length === 1)) &&
          Date.parse(candidate.completed_at) >= Date.parse(record.triggered_at),
      )
      .sort(
        (left, right) =>
          (Date.parse(String(left.completed_at || "")) || 0) -
          (Date.parse(String(right.completed_at || "")) || 0),
      )[0];
    if (!completedOrphan) continue;
    records.delete(completedOrphan.id);
    records.set(record.id, {
      ...record,
      completed_at: completedOrphan.completed_at,
      completion_kind: completedOrphan.completion_kind,
      completion_comment_id: completedOrphan.completion_comment_id,
      ...(completedOrphan.completion_source_delivery_id
        ? { completion_source_delivery_id: completedOrphan.completion_source_delivery_id }
        : {}),
    });
  }
  const journeys = [...records.values()]
    .sort(
      (left, right) =>
        Math.max(
          Date.parse(String(right.completed_at || "")) || 0,
          Date.parse(String(right.triggered_at || "")) || 0,
        ) -
        Math.max(
          Date.parse(String(left.completed_at || "")) || 0,
          Date.parse(String(left.triggered_at || "")) || 0,
        ),
    )
    .slice(0, BAY_JOURNEY_LIMIT);
  return {
    schema_version: 1,
    journeys,
    updated_at: new Date(now).toISOString(),
  };
}

function bayJourneyStateSignature(state) {
  return JSON.stringify({
    schema_version: state?.schema_version,
    journeys: state?.journeys,
  });
}

function publicBayJourneyState(state) {
  const journeys = (Array.isArray(state?.journeys) ? state.journeys : [])
    .map(normalizeBayJourneyRecord)
    .filter(Boolean)
    .slice(0, BAY_JOURNEY_LIMIT);
  return { journeys };
}

async function updateBayJourneyState(env, triggers, completions, generatedAt) {
  if (!env.STATUS_STORE) return { journeys: [] };
  if (isDurableStatusStore(env.STATUS_STORE)) {
    const response = await durableStatusStoreStub(env.STATUS_STORE).fetch(
      statusStoreRequest(BAY_JOURNEY_STATE_KEY, "POST"),
      {
        method: "POST",
        body: JSON.stringify({
          triggers,
          completions,
          generated_at: generatedAt,
          ttl_seconds: BAY_JOURNEY_TTL_SECONDS,
        }),
      },
    );
    if (!response.ok) throw new Error(`status store Bay journey merge failed: ${response.status}`);
    return publicBayJourneyState(await response.json());
  }
  const stored = await readStoredJson(env, BAY_JOURNEY_STATE_KEY);
  const next = mergeBayJourneyState(stored, triggers, completions, generatedAt);
  if (!stored || bayJourneyStateSignature(stored) !== bayJourneyStateSignature(next)) {
    await writeStoredJson(env, BAY_JOURNEY_STATE_KEY, next, BAY_JOURNEY_TTL_SECONDS);
  }
  return publicBayJourneyState(next);
}

async function readBayJourneyState(env) {
  if (!env.STATUS_STORE) return { journeys: [] };
  return publicBayJourneyState(await readStoredJson(env, BAY_JOURNEY_STATE_KEY));
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
  const jobConclusion = String(job?.conclusion || run?.conclusion || "");
  const terminalOutcome =
    jobConclusion === "cancelled"
      ? "cancelled"
      : TERMINAL_BAD_CONCLUSIONS.has(jobConclusion)
        ? "failure"
        : jobConclusion === "success" || jobConclusion === "neutral"
          ? "success"
          : null;
  const itemNumbers = [...target.itemNumbers].sort((left, right) => left - right);
  const targetKey =
    target.repository && itemNumbers.length
      ? `${String(target.repository).toLowerCase()}#${itemNumbers.join(",")}`
      : `${String(run.name || "").toLowerCase()}|${String(run.display_title || job?.name || "")
          .toLowerCase()
          .replace(/\[clawsweeper-recovery-attempt=\d+\]/g, "")
          .replace(/\s+/g, " ")
          .trim()}`;
  const startedAt = job?.started_at || run.created_at || null;
  const completedAt = job?.completed_at || run.updated_at || startedAt;
  return {
    key: targetKey,
    outcome,
    terminal_outcome: terminalOutcome,
    workflow_title: runItem.title,
    job_name: String(job?.name || runItem.title || "Codex worker"),
    repository: target.repository,
    item_numbers: itemNumbers,
    conclusion: conclusion || null,
    failed_step: failedStep ? String(failedStep.name || "Unknown step") : null,
    url: job?.html_url || run.html_url,
    run_id: run.id,
    job_id: job?.id || null,
    started_at: startedAt,
    completed_at: completedAt,
    total_duration_ms: boundedBayTimingDuration(run.created_at || startedAt, completedAt),
  };
}

function activeBayItemKeys(workers) {
  const keys = new Set();
  for (const worker of Array.isArray(workers) ? workers : []) {
    const targets = new Map<number, Record<string, unknown>>(
      (Array.isArray(worker?.target_items) ? worker.target_items : []).map(
        (item): [number, Record<string, unknown>] => {
          const target = objectValue(item);
          return [Number(target.number), target];
        },
      ),
    );
    const numbers = Array.isArray(worker?.item_numbers)
      ? worker.item_numbers
      : worker?.item_number
        ? [worker.item_number]
        : [];
    for (const value of numbers) {
      const number = Number(value);
      const target = targets.get(number);
      const repository = nullableString(worker?.repository || target?.repository);
      if (repository && Number.isInteger(number) && number > 0) keys.add(`${repository}#${number}`);
    }
  }
  return [...keys];
}

async function updateBayTerminalState(env, attempts, closedItems, generatedAt, activeItemKeys) {
  if (isDurableStatusStore(env.STATUS_STORE)) {
    const response = await durableStatusStoreStub(env.STATUS_STORE).fetch(
      statusStoreRequest(BAY_TERMINAL_STATE_KEY, "POST"),
      {
        method: "POST",
        body: JSON.stringify({
          attempts,
          closed_items: closedItems,
          generated_at: generatedAt,
          ttl_seconds: EVENT_STORE_TTL_SECONDS,
          active_item_keys: activeItemKeys,
        }),
      },
    );
    if (!response.ok) throw new Error(`status store Bay merge failed: ${response.status}`);
    return publicBayTerminalState(await response.json());
  }
  const stored = await readStoredJson(env, BAY_TERMINAL_STATE_KEY);
  const next = mergeBayTerminalState(stored, attempts, closedItems, generatedAt, activeItemKeys);
  if (!stored || bayTerminalStateSignature(stored) !== bayTerminalStateSignature(next)) {
    await writeStoredJson(env, BAY_TERMINAL_STATE_KEY, next, EVENT_STORE_TTL_SECONDS);
    return publicBayTerminalState(next);
  }
  return publicBayTerminalState(stored);
}

export function mergeBayTerminalState(
  previous,
  attempts,
  closedItems,
  generatedAt,
  activeItemKeys = [],
) {
  const now = Date.parse(generatedAt);
  const source = previous && previous.schema_version === 1 ? previous : {};
  const storedWindowStartedAt = nullableString(source.terminal_window_started_at);
  const bootstrapWindowStartedAt = Number.isFinite(Date.parse(storedWindowStartedAt || ""))
    ? storedWindowStartedAt
    : bayTerminalBootstrapWindowStartedAt(now);
  const activeKeys = new Set(
    (Array.isArray(activeItemKeys) ? activeItemKeys : []).map((value) => String(value)),
  );
  const bootstrapBuffer = Array.isArray(source.terminal_buffer)
    ? source.terminal_buffer.filter(
        (item) =>
          item?.event_id &&
          item?.item_key &&
          isBayTerminalAtOrAfterWindowStart(item, bootstrapWindowStartedAt) &&
          !activeKeys.has(String(item.item_key)),
      )
    : [];
  let terminalWindowStartedAt = bayTerminalWindowStartedAt(source, now, bootstrapBuffer);
  const buffer = bootstrapBuffer.filter((item) =>
    isBayTerminalAtOrAfterWindowStart(item, terminalWindowStartedAt),
  );
  const seenEvents = Array.isArray(source.seen_events)
    ? source.seen_events.filter((item) => item?.event_id)
    : [];
  const seenIds = new Set(seenEvents.map((item) => item.event_id));
  let terminalWindowEventIds = Array.isArray(source.terminal_window_event_ids)
    ? source.terminal_window_event_ids.map((eventId) => String(eventId)).filter(Boolean)
    : [];
  let terminalWindowEventIdSet = new Set(terminalWindowEventIds);
  const recentlyWashed =
    Array.isArray(source.recently_washed) &&
    Number.isFinite(now) &&
    now - Date.parse(source.washed_at || "") <= BAY_WASH_VISIBLE_MS
      ? source.recently_washed
      : [];
  let washedAt = recentlyWashed.length ? source.washed_at || null : null;
  let tideGeneration = Math.max(0, Number(source.tide_generation) || 0);
  let lastTideAt = nullableString(source.last_tide_at);

  for (const candidate of bayTerminalCandidates(attempts, closedItems)) {
    if (activeKeys.has(candidate.item_key)) continue;
    if (
      !isBayTerminalAfterWindowStart(candidate, terminalWindowStartedAt, terminalWindowEventIdSet)
    )
      continue;
    if (seenIds.has(candidate.event_id)) continue;
    seenIds.add(candidate.event_id);
    seenEvents.push({ event_id: candidate.event_id, seen_at: candidate.completed_at });
    const existingIndex = buffer.findIndex((item) => item.item_key === candidate.item_key);
    if (existingIndex === -1) {
      buffer.push(candidate);
      continue;
    }
    if (
      Date.parse(candidate.completed_at || "") >=
      Date.parse(buffer[existingIndex]?.completed_at || "")
    ) {
      buffer[existingIndex] = candidate;
    }
  }
  buffer.sort(
    (left, right) => Date.parse(left.completed_at || "") - Date.parse(right.completed_at || ""),
  );

  let washed = recentlyWashed;
  while (buffer.length >= BAY_TIDE_THRESHOLD) {
    washed = buffer.splice(0, BAY_TIDE_THRESHOLD);
    const tideCompletedAt = nullableString(washed.at(-1)?.completed_at) || generatedAt;
    washedAt = generatedAt;
    lastTideAt = tideCompletedAt;
    terminalWindowStartedAt = tideCompletedAt;
    terminalWindowEventIds = washed
      .filter((item) => item.completed_at === terminalWindowStartedAt)
      .map((item) => String(item.event_id));
    terminalWindowEventIdSet = new Set(terminalWindowEventIds);
    tideGeneration += 1;
  }

  return {
    schema_version: 1,
    tide_threshold: BAY_TIDE_THRESHOLD,
    tide_generation: tideGeneration,
    last_tide_at: lastTideAt,
    terminal_window_started_at: terminalWindowStartedAt,
    terminal_window_event_ids: terminalWindowEventIds,
    terminal_count: buffer.length,
    terminal_buffer: buffer,
    washed_at: washedAt,
    recently_washed: washed,
    seen_events: seenEvents.slice(-BAY_SEEN_EVENT_LIMIT),
    updated_at: generatedAt,
  };
}

function bayTerminalStateSignature(state) {
  return JSON.stringify({
    schema_version: state?.schema_version,
    tide_threshold: state?.tide_threshold,
    tide_generation: state?.tide_generation,
    last_tide_at: state?.last_tide_at,
    terminal_window_started_at: state?.terminal_window_started_at,
    terminal_window_event_ids: state?.terminal_window_event_ids,
    terminal_count: state?.terminal_count,
    terminal_buffer: state?.terminal_buffer,
    washed_at: state?.washed_at,
    recently_washed: state?.recently_washed,
    seen_events: state?.seen_events,
  });
}

function bayTerminalWindowStartedAt(source, now, bootstrapBuffer = []) {
  const storedWindowStart = nullableString(source?.terminal_window_started_at);
  if (Number.isFinite(Date.parse(storedWindowStart || ""))) return storedWindowStart;
  const bufferedWindowStart = [...bootstrapBuffer]
    .map((item) => nullableString(item?.completed_at))
    .filter((value) => Number.isFinite(Date.parse(value || "")))
    .sort()[0];
  if (bufferedWindowStart) return bufferedWindowStart;
  const lastTideAt = nullableString(source?.last_tide_at);
  if (Number.isFinite(Date.parse(lastTideAt || ""))) return lastTideAt;
  return bayTerminalBootstrapWindowStartedAt(now);
}

function bayTerminalBootstrapWindowStartedAt(now) {
  if (!Number.isFinite(now)) return null;
  return new Date(now - BAY_INITIAL_TERMINAL_LOOKBACK_MS).toISOString();
}

function isBayTerminalAfterWindowStart(
  candidate,
  terminalWindowStartedAt,
  terminalWindowEventIds = new Set(),
) {
  const completedAt = Date.parse(String(candidate?.completed_at || ""));
  const windowStart = Date.parse(String(terminalWindowStartedAt || ""));
  if (!Number.isFinite(completedAt) || !Number.isFinite(windowStart)) return false;
  if (completedAt > windowStart) return true;
  return completedAt === windowStart && !terminalWindowEventIds.has(String(candidate?.event_id));
}

function isBayTerminalAtOrAfterWindowStart(candidate, terminalWindowStartedAt) {
  const completedAt = Date.parse(String(candidate?.completed_at || ""));
  const windowStart = Date.parse(String(terminalWindowStartedAt || ""));
  return Number.isFinite(completedAt) && Number.isFinite(windowStart) && completedAt >= windowStart;
}

function bayTerminalCandidates(attempts, closedItems) {
  const candidates = [];
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const outcome = String(attempt?.terminal_outcome || "");
    if (!new Set(["success", "failure", "cancelled"]).has(outcome)) continue;
    const repository = nullableString(attempt?.repository);
    const completedAt = nullableString(attempt?.completed_at || attempt?.started_at);
    if (!repository || !completedAt) continue;
    for (const numberValue of Array.isArray(attempt?.item_numbers) ? attempt.item_numbers : []) {
      const number = Number(numberValue);
      if (!Number.isInteger(number) || number <= 0) continue;
      const itemKey = `${repository}#${number}`;
      const eventId = [
        "worker",
        attempt?.run_id || "run",
        attempt?.job_id || "job",
        itemKey,
        outcome,
        completedAt,
      ].join(":");
      candidates.push({
        event_id: eventId,
        item_key: itemKey,
        repository,
        number,
        outcome,
        title: nullableString(attempt?.workflow_title || attempt?.job_name) || itemKey,
        item_url: `https://github.com/${repository}/issues/${number}`,
        job_url: nullableString(attempt?.url),
        run_id: attempt?.run_id || null,
        completed_at: completedAt,
        current_step: nullableString(attempt?.failed_step || attempt?.conclusion),
        source: "worker_attempt",
      });
    }
  }
  for (const item of Array.isArray(closedItems) ? closedItems : []) {
    const repository = nullableString(item?.repository);
    const number = Number(item?.number);
    const completedAt = nullableString(item?.closed_at);
    if (!repository || !Number.isInteger(number) || number <= 0 || !completedAt) continue;
    const itemKey = `${repository}#${number}`;
    candidates.push({
      event_id: ["closed", itemKey, completedAt].join(":"),
      item_key: itemKey,
      repository,
      number,
      outcome: "success",
      title: nullableString(item?.title) || itemKey,
      item_url: nullableString(item?.url) || `https://github.com/${repository}/issues/${number}`,
      job_url: null,
      run_id: null,
      completed_at: completedAt,
      current_step: "Closed by ClawSweeper",
      source: "closed_item",
    });
  }
  return candidates.sort(
    (left, right) => Date.parse(left.completed_at) - Date.parse(right.completed_at),
  );
}

function publicBayTerminalState(state) {
  return {
    schema_version: 1,
    tide_threshold: state.tide_threshold,
    tide_generation: state.tide_generation,
    last_tide_at: state.last_tide_at,
    terminal_count: state.terminal_count,
    terminal_buffer: state.terminal_buffer,
    washed_at: state.washed_at,
    recently_washed: state.recently_washed,
    updated_at: state.updated_at,
  };
}

function emptyBayTerminalState(generatedAt) {
  return {
    schema_version: 1,
    tide_threshold: BAY_TIDE_THRESHOLD,
    tide_generation: 0,
    last_tide_at: null,
    terminal_count: 0,
    terminal_buffer: [],
    washed_at: null,
    recently_washed: [],
    updated_at: generatedAt,
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

async function workflowJobsForRun(
  env,
  repo,
  runId,
  github: GithubJsonReader = (path) => githubJson(env, path),
  run?: WorkflowRunSummary,
) {
  const key = `workflow-jobs:${repo}:${runId}`;
  const cached = await readStoredJson(env, key);
  if (Array.isArray(cached)) return cached;
  const jobs = [];
  for (let page = 1; page <= WORKER_JOB_PAGE_LIMIT; page += 1) {
    const payload = await github(
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
  const hasActiveWorker = jobs.some(
    (job) => isActiveWorkflowJob(job) && isDashboardWorkerJob(job, run),
  );
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

function isExactReviewPublicationJob(job, run?: WorkflowRunSummary) {
  const name = String(job?.name || "");
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const workflow = `${run?.name || ""} ${run?.display_title || ""}`;
  return (
    /publish (?:exact )?review artifacts?/i.test(name) ||
    (/publish exact review batch/i.test(workflow) && /^publish$/i.test(name)) ||
    steps.some((step) =>
      /claim durable exact review publication|claim one durable publication batch|finalize healthy members under a fenced heartbeat|publish event result and apply safe close|complete durable exact review publication|apply review artifacts|publish review artifact action ledger|commit review records/i.test(
        String(step?.name || ""),
      ),
    )
  );
}

function isDashboardWorkerJob(job, run?: WorkflowRunSummary) {
  return isCodexWorkerJob(job) || isExactReviewPublicationJob(job, run);
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
    is_codex_worker: isCodexWorkerJob(job),
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
    is_codex_worker: true,
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

async function activeWorkflowRunCandidates(
  env,
  repo,
  errors,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const pages = await Promise.all(
    ACTIVE_RUN_STATUS_FILTERS.map(async (status) => {
      const runs = await github(`/repos/${repo}/actions/runs?status=${status}&per_page=100`).catch(
        (error) => {
          errors.push(`workflow runs ${status}: ${error.message}`);
          return null;
        },
      );
      const workflowRuns = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
      // Sampling stays at five cheap status queries. A full page may omit the
      // oldest (and therefore least healthy) runs, so fail closed instead of
      // spending an unbounded number of follow-up requests.
      if (workflowRuns.length >= 100) errors.push(`workflow runs ${status}: page may be truncated`);
      return workflowRuns;
    }),
  );
  return uniqueWorkflowRuns(pages.flat());
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

async function pipelineItems(
  env,
  runs,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
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
        .map((item) => attachCiStatus(env, item, github)),
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

async function attachCiStatus(
  env,
  item,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  try {
    const pr = await github(`/repos/${item.repository}/pulls/${item.item_number}`);
    if (!pr?.head?.sha) return;
    const checks = await github(
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

function emptyAutomergeReliability(updatedAt) {
  return {
    sampled_runs: 0,
    completed_attempts: 0,
    failed_attempts: 0,
    failure_rate_percent: null,
    active_attempts: 0,
    stalled_attempts: 0,
    average_duration_ms: null,
    longest_duration_ms: null,
    unresolved_failures: 0,
    recovered_failures: 0,
    failures: [],
    updated_at: updatedAt,
  };
}

function automergeRepairTarget(run, targetRepos) {
  const title = String(run?.display_title || "").toLowerCase();
  const candidates = targetRepos
    .map((repository) => ({
      repository: String(repository).trim(),
      slug: String(repository).trim().toLowerCase().replaceAll("/", "-"),
    }))
    .filter((candidate) => candidate.repository && candidate.slug)
    .sort((left, right) => right.slug.length - left.slug.length);
  for (const candidate of candidates) {
    const marker = `automerge-${candidate.slug}-`;
    const markerIndex = title.indexOf(marker);
    if (markerIndex < 0) continue;
    const suffix = title.slice(markerIndex + marker.length);
    const match = suffix.match(/^(\d+)\.md(?:\s|$)/);
    if (!match) continue;
    const number = Number(match[1]);
    return {
      repository: candidate.repository,
      number,
      item_url: `https://github.com/${candidate.repository}/pull/${number}`,
    };
  }
  return null;
}

function automergeRunDurationMs(run, nowMs) {
  const startedMs = Date.parse(String(run?.created_at || ""));
  if (!Number.isFinite(startedMs)) return null;
  const completedMs =
    run?.status === "completed" ? Date.parse(String(run?.updated_at || "")) : nowMs;
  if (!Number.isFinite(completedMs) || completedMs < startedMs) return null;
  return completedMs - startedMs;
}

export function summarizeAutomergeReliability(runs, targetRepos, now = new Date().toISOString()) {
  const nowMs = Date.parse(now);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const attempts = runs
    .filter((run) => /\bautomerge repair\b/i.test(String(run?.display_title || "")))
    .map((run) => {
      const target = automergeRepairTarget(run, targetRepos);
      if (!target) return null;
      return {
        run,
        target,
        startedMs: Date.parse(String(run?.created_at || "")),
        completedMs: Date.parse(String(run?.updated_at || "")),
        duration_ms: automergeRunDurationMs(run, effectiveNowMs),
      };
    })
    .filter(Boolean);
  const completed = attempts.filter((attempt) => attempt.run.status === "completed");
  const failed = completed.filter((attempt) =>
    TERMINAL_BAD_CONCLUSIONS.has(String(attempt.run.conclusion)),
  );
  const successes = completed.filter((attempt) => attempt.run.conclusion === "success");
  const active = attempts.filter((attempt) => ACTIVE_RUN_STATUSES.has(String(attempt.run.status)));
  const durations = completed
    .map((attempt) => attempt.duration_ms)
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  const failureAttempts = failed
    .map((attempt) => {
      const recovery = successes.find(
        (candidate) =>
          candidate.target.repository === attempt.target.repository &&
          candidate.target.number === attempt.target.number &&
          candidate.startedMs >= attempt.completedMs,
      );
      return {
        repository: attempt.target.repository,
        number: attempt.target.number,
        item_url: attempt.target.item_url,
        run_url: attempt.run.html_url,
        status: recovery ? "recovered" : "unresolved",
        conclusion: attempt.run.conclusion,
        started_at: attempt.run.created_at,
        completed_at: attempt.run.updated_at,
        duration_ms: attempt.duration_ms,
        recovered: Boolean(recovery),
      };
    })
    .sort(
      (left, right) =>
        Date.parse(String(right.started_at || "")) - Date.parse(String(left.started_at || "")),
    );
  const failuresByTarget = new Map();
  for (const failure of failureAttempts) {
    const targetKey = `${failure.repository}#${failure.number}`;
    if (!failuresByTarget.has(targetKey)) failuresByTarget.set(targetKey, failure);
  }
  const failures = [...failuresByTarget.values()]
    // Unresolved targets stay visible even when recovered retries fill the sample.
    .sort(
      (left, right) =>
        Number(left.recovered) - Number(right.recovered) ||
        Date.parse(String(right.started_at || "")) - Date.parse(String(left.started_at || "")),
    );
  const unresolvedFailures = failures.filter((failure) => !failure.recovered).length;
  const result = emptyAutomergeReliability(new Date(effectiveNowMs).toISOString());
  return {
    ...result,
    sampled_runs: attempts.length,
    completed_attempts: completed.length,
    failed_attempts: failed.length,
    failure_rate_percent: completed.length
      ? Math.round((failed.length / completed.length) * 1000) / 10
      : null,
    active_attempts: active.length,
    stalled_attempts: active.filter(
      (attempt) =>
        Number.isFinite(attempt.duration_ms) && attempt.duration_ms >= AUTOMERGE_STALLED_AFTER_MS,
    ).length,
    average_duration_ms: durations.length
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : null,
    longest_duration_ms: durations.length ? Math.max(...durations) : null,
    unresolved_failures: unresolvedFailures,
    recovered_failures: failures.length - unresolvedFailures,
    failures: failures.slice(0, AUTOMERGE_FAILURE_DISPLAY_LIMIT),
  };
}

async function recentAutomergeReliability(
  env,
  repo,
  targetRepos,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const targetKey = targetRepos
    .map((target) => target.toLowerCase())
    .sort()
    .join(",");
  const cacheKey = `automerge-reliability:${String(repo).toLowerCase()}:${targetKey}`;
  const cached = await readStoredJson(env, cacheKey);
  if (cached && Array.isArray(cached.failures)) return cached;

  const response = await github(
    `/repos/${repo}/actions/workflows/${AUTOMERGE_REPAIR_WORKFLOW}/runs?per_page=${AUTOMERGE_RELIABILITY_RUN_LIMIT}`,
  );
  const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
  const result = summarizeAutomergeReliability(runs, targetRepos);
  await writeStoredJson(
    env,
    cacheKey,
    result,
    numberFrom(env.AUTOMERGE_CACHE_TTL_SECONDS, AUTOMERGE_CACHE_TTL_SECONDS),
  ).catch(() => undefined);
  return result;
}

async function recentAutomerge(
  env,
  repo,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const cacheKey = `recent-automerge:${String(repo).toLowerCase()}`;
  const cached = await readStoredJson(env, cacheKey);
  if (cached?.items && Array.isArray(cached.items)) return cached;

  const search = await github(
    `/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged label:clawsweeper:automerge sort:updated-desc`)}&per_page=${AVERAGE_LIMIT}`,
  );
  const issues = Array.isArray(search?.items) ? search.items : [];
  const items = await recentAutomergeItems(env, repo, issues, github);
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

async function recentAutomergeItems(env, repo, issues, github: GithubJsonReader) {
  if (hasGithubAuth(env) && issues.length) {
    try {
      return await recentAutomergeItemsGraphql(env, repo, issues);
    } catch {
      // Keep dashboards on the existing REST path when GraphQL hydration is unavailable.
    }
  }
  return Promise.all(issues.map((issue) => recentAutomergeItemRest(repo, issue, github)));
}

async function recentAutomergeItemsGraphql(env, repo, issues) {
  const [owner, name] = String(repo || "").split("/");
  if (!owner || !name) throw new Error(`invalid repository ${repo}`);
  const aliases = issues
    .map(
      (issue, index) => `
        pr${index}: pullRequest(number: ${Number(issue.number)}) {
          mergedAt
          mergeCommit { oid }
          comments(first: 100) {
            nodes {
              body
              createdAt
            }
          }
        }`,
    )
    .join("\n");
  const data = await githubGraphql(
    env,
    `query RecentAutomerge($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${aliases}
      }
    }`,
    { owner, name },
  );
  const repository = data?.repository || {};
  return issues.map((issue, index) => {
    const pr = repository[`pr${index}`];
    if (!pr) throw new Error(`missing automerge PR ${issue.number}`);
    const comments = Array.isArray(pr?.comments?.nodes)
      ? pr.comments.nodes.map((comment) => ({
          body: comment?.body || "",
          created_at: comment?.createdAt || null,
        }))
      : [];
    return recentAutomergeItem(issue, {
      merged_at: pr.mergedAt || null,
      merge_commit_sha: pr.mergeCommit?.oid || null,
      comments,
    });
  });
}

async function recentAutomergeItemRest(repo, issue, github: GithubJsonReader) {
  const number = issue.number;
  const [pr, comments] = await Promise.all([
    github(`/repos/${repo}/pulls/${number}`),
    github(`/repos/${repo}/issues/${number}/comments?per_page=100`),
  ]);
  return recentAutomergeItem(issue, {
    merged_at: pr?.merged_at || null,
    merge_commit_sha: pr?.merge_commit_sha || null,
    comments,
  });
}

function recentAutomergeItem(issue, details) {
  const commandAt = firstAutomergeCommandAt(details.comments);
  const mergedAt = details.merged_at || null;
  const durationMs = commandAt && mergedAt ? Date.parse(mergedAt) - Date.parse(commandAt) : null;
  return {
    url: issue.html_url,
    title: issue.title,
    number: issue.number,
    command_at: commandAt,
    merged_at: mergedAt,
    duration_ms: durationMs,
    merge_commit_sha: details.merge_commit_sha || null,
  };
}

async function clusterRepairStatus(
  env,
  repo,
  targetRepos,
  activeRuns,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const [workflowRuns, markers] = await Promise.all([
    github(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(CLUSTER_REPAIR_INTAKE_WORKFLOW)}/runs?per_page=5`,
    ).catch(() => ({ workflow_runs: [] })),
    Promise.all(targetRepos.map((targetRepo) => readClusterRepairMarker(env, targetRepo, github))),
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

async function applyHealthStatus(
  env,
  targetRepos,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const items = await Promise.all(
    targetRepos.map((targetRepo) => readApplyHealthMarker(env, targetRepo, github)),
  );
  const attention = items.filter((item) => applyHealthNeedsAttention(item.status));
  return {
    items,
    attention_count: attention.length,
    latest_attention_at: latestIso(attention.map((item) => item.updated_at)),
  };
}

async function readApplyHealthMarker(
  env,
  targetRepo,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const stateRepo = String(env.CLAWSWEEPER_STATE_REPO || CLAWSWEEPER_STATE_REPO);
  const stateRef = String(env.CLAWSWEEPER_STATE_REF || CLAWSWEEPER_STATE_REF);
  const repoSlug = String(targetRepo || "").replace(/\//g, "-");
  const statusPath = `results/sweep-status/${repoSlug}.json`;
  try {
    const content = await github(
      `/repos/${stateRepo}/contents/${githubPath(statusPath)}?ref=${encodeURIComponent(stateRef)}`,
    );
    const status = parseJsonObject(decodeGithubContent(content?.content)) || {};
    const health = objectValue(status.apply_health);
    const skipReasons = numericRecord(health.skip_reasons);
    const nextActions = applyHealthNextActions(health.next_actions);
    const cursor = objectValue(health.cursor);
    return {
      target_repo: nullableString(status.target_repo) || targetRepo,
      status_path: statusPath,
      state: nullableString(status.state),
      detail: nullableString(status.detail),
      run_url: nullableString(health.run_url) || nullableString(status.run_url),
      updated_at: nullableString(health.generated_at) || nullableString(status.updated_at),
      mode: nullableString(health.mode),
      status: nullableString(health.status) || "unavailable",
      summary: nullableString(health.summary),
      examined: optionalNumber(health.examined),
      action_records: numberOrNull(health.action_records),
      processed: numberOrNull(health.processed),
      processed_limit: numberOrNull(health.processed_limit),
      close_limit: numberOrNull(health.close_limit),
      closed: numberOrNull(health.closed),
      comment_synced: numberOrNull(health.comment_synced),
      skipped: numberOrNull(health.skipped),
      skip_reasons: skipReasons,
      cursor_required: health.cursor_required === true,
      lanes: applyHealthLanes(health.lanes),
      next_actions: nextActions,
      next_action_buckets: numericRecord(health.next_action_buckets),
      cycle: applyHealthCycle(health.cycle),
      attention_reasons: Array.isArray(health.attention_reasons)
        ? health.attention_reasons
            .map((reason) => String(reason))
            .filter(Boolean)
            .slice(0, 8)
        : [],
      cursor: cursor.next_after_number
        ? {
            next_after_number: numberOrNull(cursor.next_after_number),
            next_after_apply_checked_at: nullableString(cursor.next_after_apply_checked_at),
            updated_at: nullableString(cursor.updated_at),
          }
        : null,
    };
  } catch {
    return {
      target_repo: targetRepo,
      status_path: statusPath,
      state: null,
      detail: null,
      run_url: null,
      updated_at: null,
      mode: null,
      status: "unavailable",
      summary: null,
      processed: null,
      processed_limit: null,
      close_limit: null,
      closed: null,
      comment_synced: null,
      skipped: null,
      skip_reasons: {},
      cursor_required: false,
      lanes: emptyApplyHealthLanes(),
      next_actions: [],
      next_action_buckets: {},
      cycle: emptyApplyHealthCycle(),
      attention_reasons: [],
      cursor: null,
    };
  }
}

function emptyApplyHealthStatus(targetRepos) {
  return {
    items: targetRepos.map((targetRepo) => ({
      target_repo: targetRepo,
      status_path: `results/sweep-status/${String(targetRepo || "").replace(/\//g, "-")}.json`,
      status: "unavailable",
      updated_at: null,
      skip_reasons: {},
      cursor_required: false,
      lanes: emptyApplyHealthLanes(),
      next_actions: [],
      next_action_buckets: {},
      cycle: emptyApplyHealthCycle(),
      attention_reasons: [],
      cursor: null,
    })),
    attention_count: 0,
    latest_attention_at: null,
  };
}

function applyHealthNeedsAttention(status) {
  return ["attention", "blocked", "degraded", "failed", "needs_attention", "warning"].includes(
    String(status || "").toLowerCase(),
  );
}

function applyHealthLanes(value) {
  const source = objectValue(value);
  return {
    closure: applyHealthLane(source.closure),
    comment_sync: applyHealthLane(source.comment_sync),
  };
}

function emptyApplyHealthLanes() {
  return {
    closure: applyHealthLane(null),
    comment_sync: applyHealthLane(null),
  };
}

function applyHealthLane(value) {
  const source = objectValue(value);
  return {
    processed: numberOrNull(source.processed),
    closed: numberOrNull(source.closed),
    comment_synced: numberOrNull(source.comment_synced),
    skipped: numberOrNull(source.skipped),
    skip_reasons: numericRecord(source.skip_reasons),
  };
}

function applyHealthNextActions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const source = objectValue(entry);
      const reason = nullableString(source.reason);
      if (!reason) return null;
      return {
        reason,
        count: numberOrNull(source.count),
        bucket: nullableString(source.bucket),
        owner: nullableString(source.owner),
        retryable: Boolean(source.retryable),
        label: nullableString(source.label),
        summary: nullableString(source.summary),
        next_step: nullableString(source.next_step),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function applyHealthCycle(value) {
  const source = objectValue(value);
  return {
    basis: nullableString(source.basis),
    apply_ready_count: optionalNumber(source.apply_ready_count),
    candidate_counts: applyHealthCandidateCounts(source.candidate_counts),
    window_size: optionalNumber(source.window_size),
    estimated_full_cycle_windows: optionalNumber(source.estimated_full_cycle_windows),
    estimated_full_cycle_minutes: optionalNumber(source.estimated_full_cycle_minutes),
    scheduled_interval_minutes: optionalNumber(source.scheduled_interval_minutes),
    label: nullableString(source.label),
  };
}

function emptyApplyHealthCycle() {
  return {
    basis: null,
    apply_ready_count: null,
    candidate_counts: null,
    window_size: null,
    estimated_full_cycle_windows: null,
    estimated_full_cycle_minutes: null,
    scheduled_interval_minutes: null,
    label: null,
  };
}
function applyHealthCandidateCounts(value) {
  const source = objectValue(value);
  const keys = [
    "confirmed_proposal",
    "guarded_retry",
    "proof_required",
    "promotion_total",
    "promotion_eligible",
    "promotion_cooldown_eligible",
    "cooldown_eligible_total",
    "inconsistent_or_stale",
  ];
  if (!keys.some((key) => Number.isFinite(Number(source[key])))) return null;
  return Object.fromEntries(keys.map((key) => [key, numberOrNull(source[key]) || 0]));
}
function latestIso(values) {
  const timestamps = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function numericRecord(value) {
  const record = objectValue(value);
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, count]) => ({ key, count: numberOrNull(count) }))
      .filter((entry) => entry.count !== null && entry.count > 0)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => [entry.key, entry.count]),
  );
}

async function readClusterRepairMarker(
  env,
  targetRepo,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const stateRepo = String(env.CLAWSWEEPER_STATE_REPO || CLAWSWEEPER_STATE_REPO);
  const stateRef = String(env.CLAWSWEEPER_STATE_REF || CLAWSWEEPER_STATE_REF);
  const repoSlug = String(targetRepo || "").replace(/\//g, "-");
  const markerPath = `results/cluster-repair-intake/${repoSlug}.json`;
  try {
    const content = await github(
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

async function recentClawsweeperClosed(
  env,
  repos,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
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
    repos.map((repo) => recentClawsweeperClosedForRepo(env, repo, since, trustedBotLogins, github)),
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

async function recentClawsweeperClosedForRepo(
  env,
  repo,
  since,
  trustedBotLogins,
  github: GithubJsonReader = (path) => githubJson(env, path),
) {
  const items = [];
  const firstPage = await github(closedIssuesPath(repo, since, 1)).catch(() => []);
  const pages = [Array.isArray(firstPage) ? firstPage : []];
  if (pages[0].length >= 100 && CLOSED_STATS_PAGE_LIMIT > 1) {
    const remainingPages = await Promise.all(
      Array.from({ length: CLOSED_STATS_PAGE_LIMIT - 1 }, (_, index) =>
        github(closedIssuesPath(repo, since, index + 2)).catch(() => []),
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
  const command = comments
    .slice()
    .sort((left, right) => automergeCommentTime(left) - automergeCommentTime(right))
    .find((comment) =>
      /@clawsweeper\s+auto\s*-?\s*merge|@clawsweeper\s+automerge|\/clawsweeper\s+auto\s*-?\s*merge|\/clawsweeper\s+automerge/i.test(
        String(comment.body || ""),
      ),
    );
  return command?.created_at || null;
}

function automergeCommentTime(comment) {
  const timestamp = Date.parse(String(comment?.created_at || ""));
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

async function readCachedSnapshot(env, ttlSeconds) {
  if (!env.STATUS_STORE) return null;
  const text = await readStatusStoreText(env.STATUS_STORE, "snapshot");
  if (!text) return null;
  const snapshot = JSON.parse(text);
  if (!snapshot?.bay) return null;
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

function createGithubJsonCache(env): GithubJsonReader {
  const cache = new Map<string, ReturnType<typeof githubJson>>();
  return (path: string) => {
    const key = String(path);
    let request = cache.get(key);
    if (!request) {
      request = githubJson(env, key);
      cache.set(key, request);
    }
    return request;
  };
}

async function githubJson(env, path) {
  const token = await githubAuthToken(env);
  const response = await fetch(githubApiUrl(env, path), {
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-clawsweeper-status",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

async function githubGraphql(env, query, variables) {
  const token = await githubAuthToken(env);
  if (!token) throw new Error("GitHub auth is required for GraphQL");
  const response = await fetch(githubApiUrl(env, "/graphql"), {
    method: "POST",
    signal: AbortSignal.timeout(OPTIONAL_SECTION_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-status",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
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

async function createGithubAppInstallationToken(env, credentials, repos) {
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId =
    credentials.installationId || (await githubAppInstallationId(appJwt, repos[0], env));
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
    env,
  );
  const token = String(payload.token || "");
  if (!token) throw new Error("GitHub App token response missing token");
  const expiresAtMs = payload.expires_at
    ? Date.parse(payload.expires_at)
    : Date.now() + GITHUB_APP_TOKEN_DEFAULT_TTL_MS;
  return { token, expiresAtMs };
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

function isCodexWorkflowFallback(run) {
  const name = `${run?.name || ""} ${run?.display_title || ""}`;
  if (
    /repair comment router|clawsweeper_comment|@publish:|publish (?:exact )?review (?:artifacts?|batch)|exact.review publication|reconcile exact.review lease|sync codex review comments/i.test(
      name,
    )
  ) {
    return false;
  }
  return /review clawsweeper items|review hot (?:clawsweeper items|target repo)|review target repo|review event items?|retry failed codex reviews|commit review|repair cluster|automerge repair|issue implementation|assist\b/i.test(
    name,
  );
}

function controlPlaneSnapshot(runs) {
  const snapshot = {
    publishers: { running: 0, waiting: 0 },
    comment_routers: { running: 0, waiting: 0 },
    reconcilers: { running: 0, waiting: 0 },
  };
  for (const run of runs) {
    const name = `${run?.name || ""} ${run?.display_title || ""}`;
    const lane =
      /@publish:|publish (?:exact )?review (?:artifacts?|batch)|exact.review publication/i.test(
        name,
      )
        ? snapshot.publishers
        : /repair comment router|clawsweeper_comment|sync codex review comments/i.test(name)
          ? snapshot.comment_routers
          : /reconcile exact.review lease/i.test(name)
            ? snapshot.reconcilers
            : null;
    if (!lane) continue;
    if (run.status === "in_progress") lane.running += 1;
    else lane.waiting += 1;
  }
  return snapshot;
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

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return numberOrNull(value);
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

function emptyPerItemReviewsJson(search: URLSearchParams) {
  const repo = String(search.get("repo") || "").trim();
  const itemNumber = Number(search.get("item_number"));
  const limit = search.has("limit") ? Number(search.get("limit")) : 20;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !Number.isInteger(itemNumber) ||
    itemNumber < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return json({ error: "invalid_review_telemetry_query" }, 400);
  }
  return json({ ok: true, repo, item_number: itemNumber, reviews: [] });
}

function html(value) {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function demoHtml(value) {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; img-src 'self' data:; connect-src 'self' https://*.openclaw.ai; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function cors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization,content-type");
  return response;
}
