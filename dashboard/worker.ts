import {
  commandTextForClawSweeperFastAck,
  isClawSweeperReReviewCommandText,
} from "../src/repair/comment-command-text.ts";
import { isExactReviewCloseGuardLabel } from "../src/repair/exact-review-guard-labels.ts";
import { stableJson } from "../src/stable-json.ts";
import { bayHtml } from "./bay-page.ts";
import { summarizeExactReviewHandoff } from "./exact-review-health.ts";
import {
  HEALTH_HISTORY_RETENTION_DAYS,
  exactReviewHistorySample,
  mergeHealthHistorySample,
  normalizeHealthHistorySample,
  summarizeOperationalHealth,
} from "./operational-health.ts";
import { TRIAGE_ROUTING_GROUPS, triageRoutingGroupsForLabels } from "./triage-routing-groups.ts";

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const QUEUED_RUN_STATUSES = new Set(["queued", "waiting", "requested", "pending"]);
type DashboardEnv = Record<string, unknown>;
type DashboardContext = { waitUntil?: (promise: Promise<unknown>) => void };
type GithubAppJsonOptions = { method?: string; body?: BodyInit; errorLabel?: string };
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

const FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION = "failed_review_shard_recovery";
const EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION = "exact_review_artifact_publish";
const EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION = "artifact_retention_recovery";
const EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION = "source_drift_requeue";
const EXACT_REVIEW_LOW_PRIORITY_SOURCE_ACTIONS = new Set([
  FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
  EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION,
]);

type ExactReviewBaseDecision = {
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceEvent: "issues" | "pull_request";
  sourceAction: string;
  supersedesInProgress: boolean;
  codexTimeoutMs?: number;
  mediaProofTimeoutMs?: number;
  commandStatusMarker?: string;
  statusCommentId?: number;
  additionalPrompt?: string;
};
type ExactReviewPublication = {
  artifactName: string;
  producerRunId: string;
  producerRunAttempt: number;
  sourceSha: string;
  itemKey: string;
  protocolVersion: 1 | 2;
  leaseRevision: number | null;
  claimGeneration: number | null;
  liveProceeded: boolean;
  liveTerminalNoop: boolean;
  liveTerminalMissing: boolean;
  liveGuardedOpen: boolean;
  producerDecision: ExactReviewBaseDecision;
};
type ExactReviewDecision = ExactReviewBaseDecision & {
  publication?: ExactReviewPublication;
};
type ExactReviewQueueItem = {
  key: string;
  decision: ExactReviewDecision;
  leaseDecision?: ExactReviewDecision;
  state: "pending" | "dispatching" | "leased";
  revision: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  attempts: number;
  leaseId?: string;
  leaseRevision?: number;
  leaseExpiresAt?: number;
  leaseHeartbeatAt?: number;
  claimedRunId?: string;
  claimedRunAttempt?: number;
  claimGeneration?: number;
  claimProtocolVersion?: 1 | 2;
  dispatchedAt?: number;
  claimedAt?: number;
};
type ExactReviewCompletionOutcome = "success" | "failure" | "cancelled";
type ExactReviewPublicationFailureKind = "github_rate_limit" | "github_transient";
type ExactReviewPublicationFeedback = {
  at: number;
  capacity: number;
  outcome: "success" | "failure";
  failureKind?: ExactReviewPublicationFailureKind;
};
type ExactReviewPublicationControl = {
  capacityCeiling: number;
  cooldownUntil: number;
  recoverySuccesses: number;
  lastFailureAt?: number;
  lastFailureKind?: ExactReviewPublicationFailureKind;
};
type ExactReviewClaimedRun = {
  runId: string;
  runAttempt?: number;
  claimGeneration: number;
};
type ExactReviewQueueState = {
  items: Record<string, ExactReviewQueueItem>;
  shedSinceReset?: number;
  dispatcher?: {
    state: "active" | "paused" | "blocked" | "unknown";
    reason?: "workflow_not_active" | "workflow_status_unavailable";
    workflowState?: string;
    checkedAt: number;
    retryAt?: number;
  };
};
type LegacyExactReviewQueueState = ExactReviewQueueState & {
  deliveries?: Record<string, number>;
};
type ExactReviewQueueBaseline = {
  items: Map<string, string>;
  dispatcherJson: string | null;
};
type ExactReviewQueueStorageMeta = {
  schema_version: number;
  migrated_at: number;
  storage_generation: number;
  dispatcher_json: string | null;
  shed_since_reset?: number;
};
type ExactReviewQueueMetricTotals = {
  review: { enqueued: number; completed: number };
  publication: { enqueued: number; completed: number };
};
type ExactReviewQueueMetricDelta = {
  reviewEnqueued?: number;
  reviewCompleted?: number;
  publicationEnqueued?: number;
  publicationCompleted?: number;
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
const BAY_TERMINAL_STATE_KEY = "openclaw-bay:terminal-state:v1";
const BAY_JOURNEY_STATE_KEY = "openclaw-bay:journey-state:v1";
const BAY_TIDE_THRESHOLD = 20;
const BAY_SEEN_EVENT_LIMIT = 256;
const BAY_WASH_VISIBLE_MS = 60_000;
const BAY_TIMING_WINDOW_MS = 60 * 60 * 1000;
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
const DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT = 64;
const DEFAULT_EXACT_REVIEW_TARGET_MAX_CONCURRENT = 60;
const DEFAULT_EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT = 4;
const DEFAULT_EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT = 24;
const DEFAULT_EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT = 48;
const EXACT_REVIEW_PUBLICATION_READY_PER_SCALE_STEP = 250;
const EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP = 8;
const EXACT_REVIEW_PUBLICATION_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
const EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES = 50;
const DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS = 6 * 60 * 1000;
// Exact publications have a dedicated bounded lane. Bound the unclaimed handoff so a run that
// never reaches its claim step is re-dispatched; stale runs lose the lease tuple safely.
const DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS = 130 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS = 20 * 60 * 1000;
const DEFAULT_EXACT_REVIEW_RETRY_MS = 30_000;
const DEFAULT_EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS = 60_000;
const DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MS = 45_000;
const DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS = 3 * 60_000;
const DEFAULT_EXACT_REVIEW_PENDING_SOFT_LIMIT = 300;
const EXACT_REVIEW_COMPLETION_RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const EXACT_REVIEW_ARTIFACT_RETRY_MAX_MS = 80 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_RECONCILE_RUN_LIMIT = 128;
const EXACT_REVIEW_RECONCILE_CLAIM_MATCH_LIMIT = EXACT_REVIEW_RECONCILE_RUN_LIMIT * 2;
const EXACT_REVIEW_RECONCILE_CONCURRENCY = 8;
const EXACT_REVIEW_RECONCILE_LIST_PAGE_LIMIT = 3;
// This is an idempotency policy, not a storage-size control. Receipts live in
// individual indexed SQLite rows and are pruned in bounded batches.
const EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH = 1_000;
const EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES = 5;
const EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH = 50;
const EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION = 1;
const EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS = 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_LEGACY_SHADOW_MAX_BYTES = 1 * 1024 * 1024;
const EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT = 20_000;
const EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_SHIFT_MS = 2 * 24 * 60 * 60 * 1000;
const EXACT_REVIEW_QUEUE_ROLLBACK_CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX = "__clawsweeper_sql_generation:";
const EXACT_REVIEW_QUEUE_STATE_KEY = "exact-review-queue";
const EXACT_REVIEW_QUEUE_META_TABLE = "exact_review_queue_meta";
const EXACT_REVIEW_QUEUE_ITEM_TABLE = "exact_review_queue_items";
const EXACT_REVIEW_QUEUE_DELIVERY_TABLE = "exact_review_queue_deliveries";
const EXACT_REVIEW_QUEUE_METRICS_TABLE = "exact_review_queue_metrics";
const EXACT_REVIEW_PUBLICATION_CONTROL_KEY = "exact-review-publication-control:v1";
const EXACT_REVIEW_QUEUE_NAME = "global";
const EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN =
  /^<!-- clawsweeper-command-status:[^<>\r\n]{1,200} -->$/;
const EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS = 5000;
const CLAWSWEEPER_REVIEW_REPO = "openclaw/clawsweeper";
const CLAWSWEEPER_STATE_REPO = "openclaw/clawsweeper-state";
const CLAWSWEEPER_STATE_REF = "state";
const DEFAULT_CRABFLEET_URL = "https://crabfleet.openclaw.ai";
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
}

export class ExactReviewQueue {
  private storage;
  private env;
  private ready: Promise<void>;
  private migratedAt = 0;
  private legacyMirrorDisabled = false;
  private legacyMirrorWarningReported = false;
  private readonly baselines = new WeakMap<ExactReviewQueueState, ExactReviewQueueBaseline>();

  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    const initialize = () => this.initializeStorage();
    this.ready =
      typeof state.blockConcurrencyWhile === "function"
        ? Promise.resolve(state.blockConcurrencyWhile(initialize))
        : initialize();
  }

  async fetch(request: Request) {
    await this.ready;
    this.cleanupLegacyCompatibilitySync();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/enqueue") {
      const body = objectValue(await request.json().catch(() => null));
      const deliveryId = String(body.delivery_id || "").trim();
      const decision = exactReviewDecisionFrom(body.decision);
      if (!deliveryId) return json({ error: "missing_delivery_id" }, 400);
      if (deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX)) {
        return json({ error: "reserved_delivery_id" }, 400);
      }
      if (!decision) return json({ error: "invalid_exact_review_item" }, 400);
      if (!isExactReviewQueueTargetEnabled(decision, this.env)) {
        return json({ ok: true, accepted: false, reason: "target not enabled" }, 202);
      }

      const now = Date.now();
      const accepted = this.storage.transactionSync(() => {
        this.pruneDeliveryReceiptsSync(now);
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
            WHERE delivery_id = ? AND received_at <= ?`,
          deliveryId,
          now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS,
        );
        const insertedReceipts = Array.from(
          this.storage.sql.exec(
            `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             (delivery_id, received_at) VALUES (?, ?)
           RETURNING delivery_id`,
            deliveryId,
            now,
          ),
        );
        if (insertedReceipts.length !== 1) {
          this.syncLegacyCompatibilitySync(this.readStateSync());
          return { deduped: true as const };
        }

        const state = this.readStateSync();
        // A delayed or lost alarm must not let an expired one-shot recovery
        // suppress the next failed shard's recovery delivery.
        reclaimExpiredExactReviewLeases(
          state,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        );
        const key = exactReviewItemKey(decision);
        const current = state.items[key];
        if (current) {
          const ignoredRecovery =
            decision.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
          // A recovery is only a one-shot repair of a failed shard. It may create a queue item,
          // but must never supersede an existing pending, dispatching, or leased decision: doing
          // so can leave either ordinary work or another recovery as a stale follow-up revision.
          // Ordinary source events retain normal replacement behavior, including the
          // command-context merge for pending items.
          if (!ignoredRecovery) {
            current.decision =
              current.state === "pending"
                ? mergePendingExactReviewDecision(current.decision, decision)
                : decision;
            current.revision += 1;
            current.updatedAt = now;
            // Immediacy must come from the merged decision: a pending explicit command
            // keeps its command marker through the merge, and a later plain webhook
            // event must not re-debounce it.
            current.nextAttemptAt =
              current.state === "pending"
                ? exactReviewQueueDebouncedAttemptAt(
                    state,
                    current.decision,
                    now,
                    current.createdAt,
                    this.env,
                  )
                : exactReviewQueueEnqueueAttemptAt(state, now);
            if (current.state === "pending") {
              current.attempts = 0;
            }
          }
        } else {
          if (
            isLowPriorityExactReviewDecision(decision) &&
            exactReviewQueuePendingCount(state) >= exactReviewPendingSoftLimit(this.env)
          ) {
            state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
            this.writeStateSync(state);
            return { shed: true as const };
          }
          state.items[key] = {
            key,
            decision,
            state: "pending",
            revision: 1,
            createdAt: now,
            updatedAt: now,
            nextAttemptAt: exactReviewQueueDebouncedAttemptAt(state, decision, now, now, this.env),
            attempts: 0,
          };
        }
        this.writeStateSync(state);
        return { deduped: false as const, key, state };
      });
      if (accepted.deduped) {
        return json({ ok: true, deduped: true, item_key: exactReviewItemKey(decision) }, 202);
      }
      if (accepted.shed) {
        return json({ ok: true, shed: true, reason: "backpressure" }, 202);
      }
      await this.scheduleNext(accepted.state, now);
      return json({ ok: true, queued: true, item_key: accepted.key }, 202);
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = objectValue(await request.json().catch(() => null));
      const leaseId = String(body.lease_id || "").trim();
      const itemKey = String(body.item_key || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const runId = String(body.run_id || "").trim();
      if (!leaseId || !runId) return json({ error: "missing_lease_or_run" }, 400);
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);
      const tupleClaim = Boolean(itemKey) || body.lease_revision !== undefined;
      if (tupleClaim && (!itemKey || !Number.isInteger(leaseRevision) || leaseRevision < 1)) {
        return json({ error: "invalid_lease_revision" }, 400);
      }
      const claimProtocolVersion: 1 | 2 = tupleClaim ? 2 : 1;
      const runAttempt = exactReviewRunAttempt(body.run_attempt);
      if (body.run_attempt !== undefined && runAttempt === null) {
        return json({ error: "invalid_run_attempt" }, 400);
      }

      const now = Date.now();
      const state = this.readStateSync();
      const item = tupleClaim ? state.items[itemKey] : exactReviewItemForLease(state, leaseId);
      if (
        item &&
        reclaimExpiredExactReviewLease(
          state,
          item.key,
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        this.writeStateSync(state);
        await this.scheduleNext(state, now);
        return json({ error: "lease_not_active" }, 409);
      }
      if (
        !item ||
        item.leaseId !== leaseId ||
        (tupleClaim && item.leaseRevision !== leaseRevision) ||
        !isLiveExactReviewLease(
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        return json({ error: "lease_not_active" }, 409);
      }
      if (item.claimedRunId && item.claimedRunId !== runId) {
        return json({ error: "lease_already_claimed" }, 409);
      }

      // Deploys can observe a pre-snapshot lease. Recover it only when no newer
      // enqueue has replaced the decision that was dispatched for this revision.
      if (!item.leaseDecision) {
        if (item.revision !== item.leaseRevision) {
          return json({ error: "lease_decision_unavailable" }, 409);
        }
        item.leaseDecision = { ...item.decision };
      }

      const claimedRunAttempt = item.claimedRunAttempt;
      if (item.claimedRunId && claimedRunAttempt !== undefined) {
        if (runAttempt === null) return json({ error: "missing_run_attempt" }, 409);
        if (runAttempt < claimedRunAttempt) {
          return json({ error: "stale_run_attempt" }, 409);
        }
        if (runAttempt === claimedRunAttempt) {
          if (
            item.claimProtocolVersion !== undefined &&
            item.claimProtocolVersion !== claimProtocolVersion
          ) {
            return json({ error: "claim_protocol_mismatch" }, 409);
          }
          const claimGeneration = Math.max(1, exactReviewClaimGeneration(item.claimGeneration));
          item.claimGeneration = claimGeneration;
          item.claimProtocolVersion = claimProtocolVersion;
          item.leaseExpiresAt = now + exactReviewExecutionLeaseMs(this.env);
          item.updatedAt = now;
          await this.writeState(state);
          await this.scheduleNext(state, now);
          return json(exactReviewClaimResponse(item, claimProtocolVersion, claimGeneration));
        }
      } else if (item.claimedRunId && runAttempt === null) {
        if (
          item.claimProtocolVersion !== undefined &&
          item.claimProtocolVersion !== claimProtocolVersion
        ) {
          return json({ error: "claim_protocol_mismatch" }, 409);
        }
        const claimGeneration = Math.max(1, exactReviewClaimGeneration(item.claimGeneration));
        if (
          item.claimGeneration !== claimGeneration ||
          item.claimProtocolVersion !== claimProtocolVersion
        ) {
          item.claimGeneration = claimGeneration;
          item.claimProtocolVersion = claimProtocolVersion;
          await this.writeState(state);
        }
        return json(exactReviewClaimResponse(item, claimProtocolVersion, claimGeneration));
      }

      item.state = "leased";
      item.claimedRunId = runId;
      item.claimedRunAttempt = runAttempt ?? undefined;
      item.claimGeneration = exactReviewClaimGeneration(item.claimGeneration) + 1;
      item.claimProtocolVersion = claimProtocolVersion;
      item.leaseExpiresAt = now + exactReviewExecutionLeaseMs(this.env);
      item.leaseHeartbeatAt = undefined;
      item.claimedAt = now;
      item.updatedAt = now;
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json(exactReviewClaimResponse(item, claimProtocolVersion, item.claimGeneration));
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = objectValue(await request.json().catch(() => null));
      const itemKey = String(body.item_key || "").trim();
      const leaseId = String(body.lease_id || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const runId = String(body.run_id || "").trim();
      if (!itemKey || !leaseId || !runId) return json({ error: "missing_lease_tuple" }, 400);
      if (!Number.isInteger(leaseRevision) || leaseRevision < 1) {
        return json({ error: "invalid_lease_revision" }, 400);
      }
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);

      const now = Date.now();
      const state = this.readStateSync();
      const item = state.items[itemKey];
      if (
        item &&
        reclaimExpiredExactReviewLease(
          state,
          itemKey,
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        await this.writeState(state);
        await this.scheduleNext(state, now);
        return json({ error: "lease_not_active" }, 409);
      }
      if (
        !item ||
        item.state !== "leased" ||
        item.leaseId !== leaseId ||
        item.leaseRevision !== leaseRevision ||
        item.claimedRunId !== runId ||
        !isLiveExactReviewLease(
          item,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        )
      ) {
        return json({ error: "lease_not_active" }, 409);
      }
      item.leaseHeartbeatAt = now;
      item.updatedAt = now;
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return json({ ok: true, lease_heartbeat_at: new Date(now).toISOString() });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = objectValue(await request.json().catch(() => null));
      const leaseId = String(body.lease_id || "").trim();
      const itemKey = String(body.item_key || "").trim();
      const leaseRevision = Number(body.lease_revision);
      const claimGeneration = Number(body.claim_generation);
      const runId = String(body.run_id || "").trim();
      if (!leaseId || !runId) return json({ error: "missing_lease_or_run" }, 400);
      if (!/^\d+$/.test(runId)) return json({ error: "invalid_run_id" }, 400);
      const tupleCompletion =
        Boolean(itemKey) ||
        body.lease_revision !== undefined ||
        body.claim_generation !== undefined;
      if (tupleCompletion) {
        if (!itemKey || !Number.isInteger(leaseRevision) || leaseRevision < 1) {
          return json({ error: "invalid_lease_revision" }, 400);
        }
        if (!Number.isInteger(claimGeneration) || claimGeneration < 1) {
          return json({ error: "invalid_claim_generation" }, 400);
        }
      }
      const completionProtocolVersion: 1 | 2 = tupleCompletion ? 2 : 1;
      const runAttempt = exactReviewRunAttempt(body.run_attempt);
      if (body.run_attempt !== undefined && runAttempt === null) {
        return json({ error: "invalid_run_attempt" }, 400);
      }
      const outcome = exactReviewCompletionOutcome(body.outcome, "success");
      if (!outcome) return json({ error: "invalid_outcome" }, 400);
      const failureKind =
        body.failure_kind === undefined
          ? undefined
          : exactReviewPublicationFailureKind(body.failure_kind);
      if (body.failure_kind !== undefined && !failureKind) {
        return json({ error: "invalid_failure_kind" }, 400);
      }
      if (failureKind && outcome !== "failure") {
        return json({ error: "failure_kind_without_failure" }, 400);
      }
      const requeueLatest = body.requeue_latest === true;
      if (body.requeue_latest !== undefined && typeof body.requeue_latest !== "boolean") {
        return json({ error: "invalid_requeue_latest" }, 400);
      }
      if (requeueLatest && outcome !== "success") {
        return json({ error: "invalid_requeue_latest_outcome" }, 400);
      }

      const now = Date.now();
      const requestedRetryAt = exactReviewCompletionRetryAt(body.retry_at, now);
      if (body.retry_at !== undefined && requestedRetryAt === null) {
        return json({ error: "invalid_retry_at" }, 400);
      }
      const state = this.readStateSync();
      const item = tupleCompletion ? state.items[itemKey] : exactReviewItemForLease(state, leaseId);
      if (
        !item ||
        item.leaseId !== leaseId ||
        (tupleCompletion && item.leaseRevision !== leaseRevision) ||
        (tupleCompletion && exactReviewClaimGeneration(item.claimGeneration) !== claimGeneration) ||
        item.claimedRunId !== runId
      ) {
        return json({ error: "lease_not_claimed" }, 409);
      }
      if ((item.claimProtocolVersion ?? 1) !== completionProtocolVersion) {
        return json({ error: "lease_protocol_not_claimed" }, 409);
      }
      const publicationItem = exactReviewQueueIsPublication(item);
      if (failureKind && !publicationItem) {
        return json({ error: "failure_kind_outside_publication" }, 400);
      }
      const publicationDesiredCapacity = publicationItem
        ? exactReviewPublicationCapacityForState(
            this.env,
            state,
            now,
            this.publicationControlSync().capacityCeiling,
            false,
          )
        : 0;
      if (
        item.claimedRunAttempt !== undefined &&
        (runAttempt === null || runAttempt !== item.claimedRunAttempt)
      ) {
        return json({ error: "lease_attempt_not_claimed" }, 409);
      }

      // The workflow reports success only after every primary review mutation has settled.
      // Complete that revision now so a later auxiliary-step failure cannot make the
      // workflow_run reconciler requeue review work that already succeeded.
      const requeued = finishExactReviewQueueItem(
        state,
        item,
        now,
        outcome,
        requestedRetryAt ?? undefined,
        requeueLatest,
      );
      // A successful workflow can still request requeue_latest after source
      // drift. That work did not leave its lane, so it must not improve the
      // operator-facing net speed until a later revision actually completes.
      const completedLane = outcome === "success" && !requeued ? exactReviewQueueLane(item) : null;
      await this.writeState(
        state,
        {
          ...(completedLane === "review" ? { reviewCompleted: 1 } : {}),
          ...(completedLane === "publication" ? { publicationCompleted: 1 } : {}),
        },
        publicationItem && ((outcome === "success" && !requeued) || failureKind)
          ? {
              at: now,
              capacity: publicationDesiredCapacity,
              outcome: outcome === "success" ? "success" : "failure",
              ...(failureKind ? { failureKind } : {}),
            }
          : undefined,
      );
      await this.scheduleNext(state, now);
      return json({ ok: true, requeued });
    }

    if (request.method === "POST" && url.pathname === "/claimed-runs") {
      const body = objectValue(await request.json().catch(() => null));
      const includeAllClaimed = body.include_all_claimed === true;
      const requestedRuns =
        includeAllClaimed && Array.isArray(body.runs) && body.runs.length === 0
          ? []
          : exactReviewRequestedRuns(body.runs);
      if (!requestedRuns) return json({ error: "invalid_requested_runs" }, 400);
      if (body.include_all_claimed !== undefined && typeof body.include_all_claimed !== "boolean") {
        return json({ error: "invalid_include_all_claimed" }, 400);
      }

      // A coalesced workflow_run backstop can scan every live claim. Keep two matches per run
      // so corrupt duplicates remain ambiguous, and bound the snapshot to the global worker
      // budget so one reconciliation never becomes an unbounded GitHub API fan-out.
      const requestedRunIds = new Set(requestedRuns.map((run) => run.runId));
      const matchesByRunId = new Map<string, ExactReviewQueueItem[]>();
      const state = this.readStateSync();
      for (const item of Object.values(state.items)) {
        if (
          item.state !== "leased" ||
          !item.claimedRunId ||
          (!includeAllClaimed && !requestedRunIds.has(item.claimedRunId))
        ) {
          continue;
        }
        const matches = matchesByRunId.get(item.claimedRunId) || [];
        if (matches.length < 2) matches.push(item);
        matchesByRunId.set(item.claimedRunId, matches);
      }
      const runs = [...matchesByRunId.values()]
        .flatMap((matches) =>
          matches.map((item) => ({
            run_id: String(item.claimedRunId),
            run_attempt: item.claimedRunAttempt ?? null,
            claim_generation: exactReviewClaimGeneration(item.claimGeneration),
          })),
        )
        .slice(0, EXACT_REVIEW_RECONCILE_RUN_LIMIT);
      return json({ runs });
    }

    if (request.method === "POST" && url.pathname === "/reconcile") {
      const body = objectValue(await request.json().catch(() => null));
      const runs = exactReviewTerminalRuns(body.runs);
      if (!runs) return json({ error: "invalid_terminal_runs" }, 400);

      const now = Date.now();
      const state = this.readStateSync();
      let reconciled = 0;
      let requeued = 0;
      let completed = 0;
      let completedReviews = 0;
      let completedPublications = 0;
      for (const run of runs) {
        const matches = Object.values(state.items).filter(
          (item) =>
            item.state === "leased" &&
            item.claimedRunId === run.runId &&
            exactReviewClaimGeneration(item.claimGeneration) === run.claimGeneration &&
            (item.claimedRunAttempt ?? null) === (run.claimedRunAttempt ?? null),
        );
        if (matches.length !== 1) continue;
        const item = matches[0];
        const didRequeue = finishExactReviewQueueItem(state, item, now, run.outcome);
        reconciled += 1;
        if (didRequeue) requeued += 1;
        else {
          completed += 1;
          if (run.outcome === "success") {
            if (exactReviewQueueIsPublication(item)) completedPublications += 1;
            else completedReviews += 1;
          }
        }
      }
      if (reconciled) {
        await this.writeState(state, {
          reviewCompleted: completedReviews,
          publicationCompleted: completedPublications,
        });
        await this.scheduleNext(state, now);
      }
      return json({ ok: true, reconciled, requeued, completed });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const now = Date.now();
      const snapshot = this.storage.transactionSync(() => {
        this.pruneDeliveryReceiptsSync(now);
        const current = this.readStateSync();
        // Dashboard reads are also the operational heartbeat. Reclaim leases and
        // restore the alarm here so a deploy or lost alarm cannot strand backlog.
        const changed = reclaimExpiredExactReviewLeases(
          current,
          now,
          exactReviewPublicationDispatchLeaseMs(this.env),
          exactReviewHeartbeatGraceMs(this.env),
        );
        if (changed) this.writeStateSync(current);
        else this.syncLegacyCompatibilitySync(current);
        return { state: current, metrics: this.queueMetricTotalsSync() };
      });
      const { state, metrics } = snapshot;
      await this.scheduleNext(state, now);
      const publicationControl = this.publicationControlSync();
      const stats = exactReviewQueueStats(
        state,
        now,
        exactReviewQueueCapacity(this.env),
        exactReviewTargetCapacity(this.env),
        exactReviewPublicationCapacityForState(
          this.env,
          state,
          now,
          publicationControl.capacityCeiling,
        ),
        exactReviewDispatchLeaseMs(this.env),
        exactReviewExecutionLeaseMs(this.env),
        exactReviewPublicationDispatchLeaseMs(this.env),
        exactReviewHeartbeatGraceMs(this.env),
      );
      return json({
        ...stats,
        lanes: {
          review: {
            ...stats.lanes.review,
            enqueued_total: metrics.review.enqueued,
            completed_total: metrics.review.completed,
          },
          publication: {
            ...stats.lanes.publication,
            enqueued_total: metrics.publication.enqueued,
            completed_total: metrics.publication.completed,
            capacity_control: exactReviewPublicationControlStatus(this.env, publicationControl),
          },
        },
        delivery_receipts: this.deliveryReceiptCountSync(),
        storage_schema_version: EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION,
        legacy_rollback_available:
          !this.legacyMirrorDisabled &&
          now < this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS,
      });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    await this.ready;
    this.cleanupLegacyCompatibilitySync();
    const startedAt = Date.now();
    await this.storage.deleteAlarm();
    this.storage.transactionSync(() => {
      this.pruneDeliveryReceiptsSync(startedAt);
      this.syncLegacyCompatibilitySync(this.readStateSync());
    });
    const snapshot = this.readStateSync();
    const reclaimedSnapshot = reclaimExpiredExactReviewLeases(
      snapshot,
      startedAt,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
    );
    const expiredSnapshot = expireExactReviewPublicationItems(snapshot, startedAt, this.env);
    const snapshotChanged = reclaimedSnapshot || expiredSnapshot;
    const capacity = exactReviewQueueCapacity(this.env);
    const targetCapacity = exactReviewTargetCapacity(this.env);
    const snapshotPublicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      snapshot,
      startedAt,
      this.publicationControlSync().capacityCeiling,
    );
    const snapshotAdmission = exactReviewQueueAdmittedItems(
      snapshot,
      startedAt,
      capacity,
      targetCapacity,
      snapshotPublicationCapacity,
    );
    if (!snapshotAdmission.length) {
      if (snapshotChanged) await this.writeState(snapshot);
      await this.scheduleNext(snapshot, startedAt);
      return;
    }

    let preflight: { ok: true; token: string; workflowState: string } | { ok: false } = {
      ok: false,
    };
    try {
      const token = await exactReviewDispatchToken(this.env);
      preflight = { ok: true, token, workflowState: await exactReviewWorkflowState(token) };
    } catch {
      preflight = { ok: false };
    }

    // External fetches release the Durable Object input gate. Re-read before any
    // write so concurrent enqueue, claim, or complete requests cannot be lost.
    const now = Date.now();
    const state = this.readStateSync();
    reclaimExpiredExactReviewLeases(
      state,
      now,
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
    );
    expireExactReviewPublicationItems(state, now, this.env);
    // The preflight fetch releases the input gate, so publication demand may
    // have crossed a scale boundary while the workflow state was checked.
    const publicationCapacity = exactReviewPublicationCapacityForState(
      this.env,
      state,
      now,
      this.publicationControlSync().capacityCeiling,
    );
    const admitted = exactReviewQueueAdmittedItems(
      state,
      now,
      capacity,
      targetCapacity,
      publicationCapacity,
    );
    if (!preflight.ok) {
      const retryAt = now + exactReviewWorkflowPausedRetryMs(this.env);
      state.dispatcher = {
        state: "blocked",
        reason: "workflow_status_unavailable",
        checkedAt: now,
        retryAt,
      };
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return;
    }
    if (preflight.workflowState !== "active") {
      const retryAt = now + exactReviewWorkflowPausedRetryMs(this.env);
      state.dispatcher = {
        state: "paused",
        reason: "workflow_not_active",
        workflowState: preflight.workflowState,
        checkedAt: now,
        retryAt,
      };
      await this.writeState(state);
      await this.scheduleNext(state, now);
      return;
    }

    state.dispatcher = {
      state: "active",
      workflowState: preflight.workflowState,
      checkedAt: now,
    };
    for (const item of admitted) {
      item.state = "dispatching";
      item.leaseId = crypto.randomUUID();
      item.leaseRevision = item.revision;
      item.leaseDecision = { ...item.decision };
      item.leaseExpiresAt =
        now +
        (item.decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION
          ? exactReviewPublicationDispatchLeaseMs(this.env)
          : exactReviewDispatchLeaseMs(this.env));
      item.claimedRunId = undefined;
      item.claimedRunAttempt = undefined;
      item.claimGeneration = undefined;
      item.dispatchedAt = now;
      item.claimedAt = undefined;
      item.updatedAt = now;
    }
    await this.writeState(state);
    if (!admitted.length) {
      await this.scheduleNext(state, now);
      return;
    }

    const failures: Array<{ key: string; leaseId: string }> = [];
    for (const item of admitted) {
      try {
        await dispatchClawsweeperItem({
          token: preflight.token,
          decision: item.leaseDecision || item.decision,
          itemKey: item.key,
          leaseId: item.leaseId,
          leaseRevision: item.leaseRevision,
        });
      } catch {
        failures.push({ key: item.key, leaseId: String(item.leaseId || "") });
      }
    }

    // Dispatch calls also release the input gate. Merge failures into current
    // state only when the exact lease still owns the item.
    const completedAt = Date.now();
    const current = this.readStateSync();
    let currentChanged = false;
    for (const failure of failures) {
      const item = current.items[failure.key];
      if (
        !item ||
        !failure.leaseId ||
        item.leaseId !== failure.leaseId ||
        item.state !== "dispatching" ||
        item.claimedRunId
      ) {
        continue;
      }
      clearExactReviewLease(item);
      item.state = "pending";
      item.attempts += 1;
      item.nextAttemptAt = completedAt + exactReviewRetryDelayMs(item.attempts);
      item.updatedAt = completedAt;
      currentChanged = true;
    }
    if (currentChanged) await this.writeState(current);
    await this.scheduleNext(current, completedAt);
  }

  private async initializeStorage() {
    this.ensureStorageSchemaSync();
    let meta = this.readStorageMetaSync();
    let migratedLegacy = false;
    const legacy = this.storage.kv.get(EXACT_REVIEW_QUEUE_STATE_KEY) as
      | LegacyExactReviewQueueState
      | undefined;
    if (!meta) {
      const migratedAt = Date.now();
      this.migratedAt = migratedAt;
      this.storage.transactionSync(() => {
        if (this.readStorageMetaSync()) return;

        const itemRows = Object.entries(
          legacy?.items && typeof legacy.items === "object" ? legacy.items : {},
        ).map(([itemKey, item]) => [itemKey, JSON.stringify({ ...item, key: itemKey })]);
        this.insertMigrationRowsSync(
          EXACT_REVIEW_QUEUE_ITEM_TABLE,
          ["item_key", "item_json"],
          itemRows,
        );

        const receiptCutoff = migratedAt - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
        const receiptRows = Object.entries(
          legacy?.deliveries && typeof legacy.deliveries === "object" ? legacy.deliveries : {},
        )
          .filter(
            ([deliveryId, receivedAt]) =>
              !deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX) &&
              Number.isSafeInteger(receivedAt) &&
              receivedAt > receiptCutoff,
          )
          .map(([deliveryId, receivedAt]) => [deliveryId, receivedAt]);
        this.insertMigrationRowsSync(
          EXACT_REVIEW_QUEUE_DELIVERY_TABLE,
          ["delivery_id", "received_at"],
          receiptRows,
        );

        const dispatcherJson =
          legacy?.dispatcher && typeof legacy.dispatcher === "object"
            ? JSON.stringify(legacy.dispatcher)
            : null;
        this.storage.sql.exec(
          `INSERT INTO ${EXACT_REVIEW_QUEUE_META_TABLE}
             (singleton_id, schema_version, migrated_at, storage_generation, dispatcher_json,
              shed_since_reset)
           VALUES (1, ?, ?, 1, ?, ?)`,
          EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION,
          migratedAt,
          dispatcherJson,
          exactReviewShedSinceReset(legacy || { items: {} }),
        );
        migratedLegacy = true;
        this.syncLegacyCompatibilitySync(this.readStateSync());
      });
      meta = this.readStorageMetaSync();
    }
    if (!meta || Number(meta.schema_version) !== EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION) {
      throw new Error(`unsupported exact-review queue storage schema ${meta?.schema_version}`);
    }
    if (!Number.isSafeInteger(meta.storage_generation) || meta.storage_generation < 1) {
      throw new Error("invalid exact-review queue storage generation");
    }
    if (!Number.isSafeInteger(meta.migrated_at) || meta.migrated_at < 1) {
      throw new Error("invalid exact-review queue migration time");
    }
    this.migratedAt = Number(meta.migrated_at);
    // Reconcile a surviving generation even after the ordinary shadow window:
    // an actual rollback can keep mutating it while the new Worker is absent.
    if (!migratedLegacy) {
      this.storage.transactionSync(() => {
        if (legacy) this.reconcileLegacyRollbackSync(legacy, meta);
        this.syncLegacyCompatibilitySync(this.readStateSync());
      });
    }
  }

  private ensureStorageSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_META_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         schema_version INTEGER NOT NULL,
         migrated_at INTEGER NOT NULL,
         storage_generation INTEGER NOT NULL,
         dispatcher_json TEXT,
         shed_since_reset INTEGER NOT NULL DEFAULT 0
       ) STRICT`,
    );
    const hasShedCounter = Array.from(
      this.storage.sql.exec(
        `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_META_TABLE}')
          WHERE name = 'shed_since_reset'`,
      ),
    ).length;
    if (!hasShedCounter) {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_QUEUE_META_TABLE}
           ADD COLUMN shed_since_reset INTEGER NOT NULL DEFAULT 0`,
      );
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_ITEM_TABLE} (
         item_key TEXT PRIMARY KEY,
         item_json TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} (
         delivery_id TEXT PRIMARY KEY,
         received_at INTEGER NOT NULL
       ) STRICT`,
    );
    // Flow telemetry is independent of queue rollback compatibility. A
    // separate singleton keeps cumulative lane counters monotonic without
    // changing the normalized queue schema or its legacy shadow contract.
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_QUEUE_METRICS_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         review_enqueued_total INTEGER NOT NULL DEFAULT 0 CHECK (review_enqueued_total >= 0),
         review_completed_total INTEGER NOT NULL DEFAULT 0 CHECK (review_completed_total >= 0),
         publication_enqueued_total INTEGER NOT NULL DEFAULT 0
           CHECK (publication_enqueued_total >= 0),
         publication_completed_total INTEGER NOT NULL CHECK (publication_completed_total >= 0)
       ) STRICT`,
    );
    for (const column of [
      "review_enqueued_total",
      "review_completed_total",
      "publication_enqueued_total",
    ]) {
      const present = Array.from(
        this.storage.sql.exec(
          `SELECT name FROM pragma_table_info('${EXACT_REVIEW_QUEUE_METRICS_TABLE}')
            WHERE name = ?`,
          column,
        ),
      ).length;
      if (!present) {
        this.storage.sql.exec(
          `ALTER TABLE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
             ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`,
        );
      }
    }
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
         (singleton_id, publication_completed_total) VALUES (1, 0)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_deliveries_received_at
         ON ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE} (received_at, delivery_id)`,
    );
  }

  private readStorageMetaSync() {
    return Array.from(
      this.storage.sql.exec(
        `SELECT schema_version, migrated_at, storage_generation, dispatcher_json,
                shed_since_reset
           FROM ${EXACT_REVIEW_QUEUE_META_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as ExactReviewQueueStorageMeta | undefined;
  }

  private insertMigrationRowsSync(table: string, columns: string[], rows: unknown[][]) {
    for (let offset = 0; offset < rows.length; offset += EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH) {
      const batch = rows.slice(offset, offset + EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH);
      const placeholders = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      this.storage.sql.exec(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
        ...batch.flat(),
      );
    }
  }

  private readDeliveryReceiptsByIdSync(deliveryIds: string[]) {
    const receipts = new Map<string, number>();
    for (
      let offset = 0;
      offset < deliveryIds.length;
      offset += EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH
    ) {
      const batch = deliveryIds.slice(offset, offset + EXACT_REVIEW_QUEUE_SQL_BINDING_ROW_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      for (const row of this.storage.sql.exec(
        `SELECT delivery_id, received_at
           FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
          WHERE delivery_id IN (${placeholders})`,
        ...batch,
      ) as Iterable<{ delivery_id: string; received_at: number }>) {
        receipts.set(row.delivery_id, row.received_at);
      }
    }
    return receipts;
  }

  private reconcileLegacyRollbackSync(
    legacy: LegacyExactReviewQueueState,
    meta: ExactReviewQueueStorageMeta,
  ) {
    const legacyState = this.normalizeLegacyState(legacy);
    const sqlState = this.readStateSync();
    const stateMatches = stableJson(legacyState) === stableJson(sqlState);
    const { generation: legacyGeneration, receipts } = this.readLegacyBridge(legacy);
    const sqlGeneration = Number(meta.storage_generation);

    if (legacyGeneration !== undefined && legacyGeneration > sqlGeneration) {
      throw new Error(
        `invalid exact-review legacy rollback generation ${legacyGeneration} > ${sqlGeneration}`,
      );
    }
    if (legacyGeneration !== undefined && legacyGeneration < sqlGeneration && !stateMatches) {
      // A stale shadow can mean either a failed mirror write by this version or
      // rollback-era mutations by the old version. Neither side is safe to discard.
      throw new Error(
        `ambiguous exact-review legacy rollback state at generations ${legacyGeneration} and ${sqlGeneration}`,
      );
    }
    if (legacyGeneration === undefined && !stateMatches) {
      throw new Error("ambiguous exact-review legacy rollback state without a generation marker");
    }

    const replaceState = legacyGeneration === sqlGeneration && !stateMatches;
    const sqlReceipts = this.readDeliveryReceiptsByIdSync(
      receipts.map(([deliveryId]) => String(deliveryId)),
    );
    const receiptChanges: unknown[][] = [];
    if (legacyGeneration === sqlGeneration) {
      const latestRollbackTime = Date.now() + EXACT_REVIEW_QUEUE_ROLLBACK_CLOCK_SKEW_MS;
      for (const [deliveryId, receivedAt] of receipts) {
        const sqlReceivedAt = sqlReceipts.get(String(deliveryId));
        if (
          sqlReceivedAt !== undefined &&
          Number(receivedAt) === this.legacyReceiptTimestamp(sqlReceivedAt)
        ) {
          continue;
        }
        if (!Number.isSafeInteger(receivedAt) || Number(receivedAt) > latestRollbackTime) {
          throw new Error(`invalid exact-review rollback receipt ${deliveryId}`);
        }
        receiptChanges.push([deliveryId, receivedAt]);
      }
    } else if (legacyGeneration !== undefined) {
      for (const [deliveryId, receivedAt] of receipts) {
        const sqlReceivedAt = sqlReceipts.get(String(deliveryId));
        if (
          sqlReceivedAt === undefined ||
          Number(receivedAt) !== this.legacyReceiptTimestamp(sqlReceivedAt)
        ) {
          throw new Error(
            `ambiguous exact-review legacy rollback receipt at generations ${legacyGeneration} and ${sqlGeneration}`,
          );
        }
      }
    }

    if (replaceState) {
      this.storage.sql.exec(`DELETE FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`);
      this.insertMigrationRowsSync(
        EXACT_REVIEW_QUEUE_ITEM_TABLE,
        ["item_key", "item_json"],
        Object.entries(legacyState.items).map(([itemKey, item]) => [itemKey, JSON.stringify(item)]),
      );
    }
    this.insertMigrationRowsSync(
      EXACT_REVIEW_QUEUE_DELIVERY_TABLE,
      ["delivery_id", "received_at"],
      receiptChanges,
    );
    if (!replaceState && receiptChanges.length === 0) return;
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_META_TABLE}
          SET dispatcher_json = ?, shed_since_reset = ?,
              storage_generation = storage_generation + 1
        WHERE singleton_id = 1 AND storage_generation = ?`,
      replaceState && legacyState.dispatcher
        ? JSON.stringify(legacyState.dispatcher)
        : replaceState
          ? null
          : meta.dispatcher_json,
      replaceState ? exactReviewShedSinceReset(legacyState) : Number(meta.shed_since_reset || 0),
      sqlGeneration,
    );
    const reconciledGeneration = this.readStorageMetaSync()?.storage_generation;
    if (reconciledGeneration !== sqlGeneration + 1) {
      throw new Error("exact-review legacy rollback reconciliation lost its generation race");
    }
  }

  private normalizeLegacyState(legacy: LegacyExactReviewQueueState): ExactReviewQueueState {
    const items = Object.fromEntries(
      Object.entries(legacy.items && typeof legacy.items === "object" ? legacy.items : {}).map(
        ([itemKey, item]) => [itemKey, { ...item, key: itemKey }],
      ),
    ) as Record<string, ExactReviewQueueItem>;
    return {
      items,
      shedSinceReset: exactReviewShedSinceReset(legacy),
      ...(legacy.dispatcher && typeof legacy.dispatcher === "object"
        ? { dispatcher: legacy.dispatcher }
        : {}),
    };
  }

  private readLegacyBridge(legacy: LegacyExactReviewQueueState) {
    const deliveries =
      legacy.deliveries && typeof legacy.deliveries === "object" ? legacy.deliveries : {};
    const generationMarkers = Object.entries(deliveries).filter(([deliveryId]) =>
      deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX),
    );
    if (generationMarkers.length > 1) {
      throw new Error("invalid exact-review legacy rollback generation markers");
    }

    let generation: number | undefined;
    if (generationMarkers.length === 1) {
      const [deliveryId, markedAt] = generationMarkers[0];
      const rawGeneration = deliveryId.slice(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX.length);
      generation = Number(rawGeneration);
      if (
        !/^\d+$/.test(rawGeneration) ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        markedAt !== Number.MAX_SAFE_INTEGER
      ) {
        throw new Error("invalid exact-review legacy rollback generation marker");
      }
    }

    const receiptCutoff = Date.now() - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    const receipts = Object.entries(deliveries)
      .filter(
        ([deliveryId, receivedAt]) =>
          !deliveryId.startsWith(EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX) &&
          Number.isSafeInteger(receivedAt) &&
          receivedAt > receiptCutoff,
      )
      .map(([deliveryId, receivedAt]) => [deliveryId, receivedAt]);
    return { generation, receipts };
  }

  private readStateSync(): ExactReviewQueueState {
    const meta = this.readStorageMetaSync();
    if (!meta || Number(meta.schema_version) !== EXACT_REVIEW_QUEUE_STORAGE_SCHEMA_VERSION) {
      throw new Error("exact-review queue storage is not initialized");
    }

    const items: Record<string, ExactReviewQueueItem> = {};
    const baselineItems = new Map<string, string>();
    for (const row of this.storage.sql.exec(
      `SELECT item_key, item_json FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`,
    ) as Iterable<{ item_key: string; item_json: string }>) {
      let item: ExactReviewQueueItem;
      try {
        item = JSON.parse(row.item_json) as ExactReviewQueueItem;
      } catch {
        throw new Error(`invalid exact-review queue item JSON for ${row.item_key}`);
      }
      if (!item || typeof item !== "object" || item.key !== row.item_key) {
        throw new Error(`invalid exact-review queue item for ${row.item_key}`);
      }
      items[row.item_key] = item;
      baselineItems.set(row.item_key, row.item_json);
    }

    let dispatcher: ExactReviewQueueState["dispatcher"];
    if (meta.dispatcher_json) {
      try {
        dispatcher = JSON.parse(meta.dispatcher_json) as ExactReviewQueueState["dispatcher"];
      } catch {
        throw new Error("invalid exact-review queue dispatcher JSON");
      }
    }
    const state = {
      items,
      dispatcher,
      shedSinceReset: Math.max(0, Number(meta.shed_since_reset || 0)),
    };
    this.baselines.set(state, {
      items: baselineItems,
      dispatcherJson: meta.dispatcher_json,
    });
    return state;
  }

  private writeState(
    state: ExactReviewQueueState,
    metricDelta: ExactReviewQueueMetricDelta = {},
    publicationFeedback?: ExactReviewPublicationFeedback,
  ) {
    this.storage.transactionSync(() => {
      this.writeStateSync(state);
      this.incrementQueueMetricsSync(metricDelta);
      if (publicationFeedback) this.applyPublicationFeedbackSync(publicationFeedback);
    });
  }

  private publicationControlSync() {
    return exactReviewPublicationControl(
      this.env,
      this.storage.kv.get(EXACT_REVIEW_PUBLICATION_CONTROL_KEY),
    );
  }

  private applyPublicationFeedbackSync(feedback: ExactReviewPublicationFeedback) {
    const current = this.publicationControlSync();
    const next = exactReviewPublicationControlAfterFeedback(this.env, current, feedback);
    this.storage.kv.put(EXACT_REVIEW_PUBLICATION_CONTROL_KEY, next);
  }

  private queueMetricTotalsSync(): ExactReviewQueueMetricTotals {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT review_enqueued_total, review_completed_total,
                publication_enqueued_total, publication_completed_total
           FROM ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          WHERE singleton_id = 1`,
      ),
    )[0] as
      | {
          review_enqueued_total?: number;
          review_completed_total?: number;
          publication_enqueued_total?: number;
          publication_completed_total?: number;
        }
      | undefined;
    return {
      review: {
        enqueued: exactReviewMetricTotal(row?.review_enqueued_total),
        completed: exactReviewMetricTotal(row?.review_completed_total),
      },
      publication: {
        enqueued: exactReviewMetricTotal(row?.publication_enqueued_total),
        completed: exactReviewMetricTotal(row?.publication_completed_total),
      },
    };
  }

  private incrementQueueMetricsSync(delta: ExactReviewQueueMetricDelta) {
    const reviewEnqueued = exactReviewMetricDelta(delta.reviewEnqueued);
    const reviewCompleted = exactReviewMetricDelta(delta.reviewCompleted);
    const publicationEnqueued = exactReviewMetricDelta(delta.publicationEnqueued);
    const publicationCompleted = exactReviewMetricDelta(delta.publicationCompleted);
    if (!reviewEnqueued && !reviewCompleted && !publicationEnqueued && !publicationCompleted) {
      return;
    }
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_METRICS_TABLE}
          SET review_enqueued_total = review_enqueued_total + ?,
              review_completed_total = review_completed_total + ?,
              publication_enqueued_total = publication_enqueued_total + ?,
              publication_completed_total = publication_completed_total + ?
        WHERE singleton_id = 1`,
      reviewEnqueued,
      reviewCompleted,
      publicationEnqueued,
      publicationCompleted,
    );
  }

  private writeStateSync(state: ExactReviewQueueState) {
    const baseline = this.baselines.get(state) || this.readStateBaselineSync();
    const nextItems = new Map<string, string>();
    let reviewEnqueued = 0;
    let publicationEnqueued = 0;
    for (const [itemKey, item] of Object.entries(state.items)) {
      const itemJson = JSON.stringify(item);
      nextItems.set(itemKey, itemJson);
      if (baseline.items.get(itemKey) === itemJson) continue;
      if (!baseline.items.has(itemKey)) {
        if (exactReviewQueueIsPublication(item)) publicationEnqueued += 1;
        else reviewEnqueued += 1;
      }
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_QUEUE_ITEM_TABLE} (item_key, item_json)
         VALUES (?, ?)
         ON CONFLICT(item_key) DO UPDATE SET item_json = excluded.item_json`,
        itemKey,
        itemJson,
      );
    }
    for (const itemKey of baseline.items.keys()) {
      if (!nextItems.has(itemKey)) {
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE} WHERE item_key = ?`,
          itemKey,
        );
      }
    }
    // Count queue work, not webhook volume. A new key creates one unit of
    // operator-visible demand; dedupes and merged revisions retain an existing
    // key and therefore cannot inflate the speed calculation.
    this.incrementQueueMetricsSync({ reviewEnqueued, publicationEnqueued });

    const dispatcherJson = state.dispatcher ? JSON.stringify(state.dispatcher) : null;
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_QUEUE_META_TABLE}
          SET dispatcher_json = ?, shed_since_reset = ?,
              storage_generation = storage_generation + 1
        WHERE singleton_id = 1`,
      dispatcherJson,
      exactReviewShedSinceReset(state),
    );
    this.syncLegacyCompatibilitySync(state);
    this.baselines.set(state, {
      items: nextItems,
      dispatcherJson,
    });
  }

  private readStateBaselineSync(): ExactReviewQueueBaseline {
    const items = new Map<string, string>();
    for (const row of this.storage.sql.exec(
      `SELECT item_key, item_json FROM ${EXACT_REVIEW_QUEUE_ITEM_TABLE}`,
    ) as Iterable<{ item_key: string; item_json: string }>) {
      items.set(row.item_key, row.item_json);
    }
    return {
      items,
      dispatcherJson: this.readStorageMetaSync()?.dispatcher_json ?? null,
    };
  }

  private pruneDeliveryReceiptsSync(now: number) {
    const cutoff = now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS;
    for (let batch = 0; batch < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_MAX_BATCHES; batch += 1) {
      const deleted = Array.from(
        this.storage.sql.exec(
          `DELETE FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
          WHERE delivery_id IN (
            SELECT delivery_id
              FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
             WHERE received_at <= ?
             ORDER BY received_at, delivery_id
             LIMIT ${EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH}
          )
        RETURNING delivery_id`,
          cutoff,
        ),
      );
      if (deleted.length < EXACT_REVIEW_QUEUE_DELIVERY_PRUNE_BATCH) break;
    }
  }

  private deliveryReceiptCountSync() {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS receipt_count FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}`,
      ),
    )[0] as { receipt_count?: number } | undefined;
    return Number(row?.receipt_count || 0);
  }

  private legacyReceiptTimestamp(receivedAt: number) {
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      receivedAt + EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_SHIFT_MS,
    );
  }

  private legacyDeliverySnapshotSync(now: number) {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT delivery_id, received_at
           FROM ${EXACT_REVIEW_QUEUE_DELIVERY_TABLE}
          WHERE received_at > ?
          ORDER BY delivery_id
          LIMIT ${EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT + 1}`,
        now - EXACT_REVIEW_QUEUE_DELIVERY_TTL_MS,
      ) as Iterable<{ delivery_id: string; received_at: number }>,
    );
    if (rows.length > EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT) return undefined;
    return Object.fromEntries(
      rows.map((row) => [row.delivery_id, this.legacyReceiptTimestamp(row.received_at)]),
    );
  }

  private syncLegacyCompatibilitySync(state: ExactReviewQueueState) {
    const now = Date.now();
    if (now >= this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS) {
      this.cleanupLegacyCompatibilitySync();
      return;
    }
    const generation = this.readStorageMetaSync()?.storage_generation;
    if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
      throw new Error("invalid exact-review queue storage generation");
    }
    const deliveries = this.legacyDeliverySnapshotSync(now);
    if (!deliveries) {
      this.disableLegacyMirrorSync(
        `active receipt count exceeds ${EXACT_REVIEW_QUEUE_LEGACY_RECEIPT_ROW_LIMIT}`,
      );
      return;
    }
    // Old Worker code preserves the marker as an inert receipt. If it mutates
    // this shadow after a rollback, the next upgrade can reconcile that exact
    // generation instead of silently choosing one side. Its five-day receipt
    // pruner sees timestamps shifted by two days, preserving the restored
    // seven-day contract without changing the normalized SQL timestamps.
    const shadow = {
      deliveries: {
        ...deliveries,
        [`${EXACT_REVIEW_QUEUE_LEGACY_GENERATION_PREFIX}${generation}`]: Number.MAX_SAFE_INTEGER,
      },
      items: state.items,
      dispatcher: state.dispatcher,
      shedSinceReset: exactReviewShedSinceReset(state),
    };
    const shadowBytes = new TextEncoder().encode(JSON.stringify(shadow)).byteLength;
    if (shadowBytes > EXACT_REVIEW_QUEUE_LEGACY_SHADOW_MAX_BYTES) {
      this.disableLegacyMirrorSync(`shadow is ${shadowBytes} bytes`);
      return;
    }
    try {
      this.storage.kv.put(EXACT_REVIEW_QUEUE_STATE_KEY, shadow);
      this.legacyMirrorDisabled = false;
    } catch (error) {
      this.disableLegacyMirrorSync(error instanceof Error ? error.message : String(error));
    }
  }

  private disableLegacyMirrorSync(reason: string) {
    try {
      // A failed refresh must not leave a stale generation that becomes
      // indistinguishable from rollback-era mutations on the next upgrade.
      this.storage.kv.delete(EXACT_REVIEW_QUEUE_STATE_KEY);
    } catch (error) {
      console.warn(
        "exact-review stale legacy rollback shadow could not be removed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    this.reportLegacyMirrorUnavailable(reason);
  }

  private reportLegacyMirrorUnavailable(reason: string) {
    this.legacyMirrorDisabled = true;
    if (this.legacyMirrorWarningReported) return;
    this.legacyMirrorWarningReported = true;
    console.warn("exact-review legacy rollback shadow unavailable", reason);
  }

  private cleanupLegacyCompatibilitySync() {
    if (!this.migratedAt || Date.now() < this.migratedAt + EXACT_REVIEW_QUEUE_LEGACY_ROLLBACK_MS) {
      return;
    }
    this.storage.kv.delete(EXACT_REVIEW_QUEUE_STATE_KEY);
  }

  private async scheduleNext(state: ExactReviewQueueState, now: number) {
    const next = exactReviewQueueNextWakeAt(
      state,
      now,
      exactReviewQueueCapacity(this.env),
      exactReviewTargetCapacity(this.env),
      exactReviewPublicationCapacityForState(
        this.env,
        state,
        now,
        this.publicationControlSync().capacityCeiling,
      ),
      exactReviewPublicationDispatchLeaseMs(this.env),
      exactReviewHeartbeatGraceMs(this.env),
    );
    if (next === null) {
      await this.storage.deleteAlarm();
      return;
    }
    const scheduled = await this.storage.getAlarm();
    if (scheduled === null || scheduled <= now || next < scheduled) {
      await this.storage.setAlarm(next);
    }
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
    if (url.pathname === "/internal/exact-review/claim" && request.method === "POST")
      return exactReviewQueueRequest(env, "/claim", request);
    // Heartbeat authenticates by full lease tuple, matching /claim and /complete: the
    // tuple is a per-lease capability, so the shared webhook secret never has to enter
    // the review job that runs Codex over untrusted content.
    if (url.pathname === "/internal/exact-review/heartbeat" && request.method === "POST")
      return exactReviewQueueRequest(env, "/heartbeat", request);
    if (url.pathname === "/internal/exact-review/complete" && request.method === "POST")
      return exactReviewQueueRequest(env, "/complete", request);
    if (url.pathname === "/internal/exact-review/claimed-runs" && request.method === "POST")
      return authenticatedExactReviewQueueRequest(request, env, "/claimed-runs");
    if (url.pathname === "/internal/exact-review/reconcile" && request.method === "POST")
      return authenticatedExactReviewReconcile(request, env);
    if (url.pathname === "/api/exact-review-queue" && request.method === "GET")
      return exactReviewQueueRequest(env, "/stats");
    if (url.pathname === "/api/health-history" && request.method === "GET")
      return healthHistoryJson(request, env);
    if (url.pathname === "/api/status") return statusJson(request, env, ctx);
    if (url.pathname === "/api/triage") return triageJson(request, env, ctx);
    if (url.pathname === "/api/pr-proof-triage") return prProofTriageJson(request, env, ctx);
    if (url.pathname === "/" || url.pathname === "/index.html") return html(dashboardHtml(env));
    if (url.pathname === "/bay-demo") return demoHtml(bayHtml());
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
  if (cached) return cachedStatusResponse(cached, "fresh", env);

  const stale = await cache.match(statusCacheRequest(request, "stale"));
  if (stale && ctx?.waitUntil) {
    ctx.waitUntil(refreshStatus(request, env).catch(() => undefined));
    return cachedStatusResponse(stale, "stale", env);
  }

  const refreshed = await refreshStatus(request, env);
  if (refreshed.looksEmpty && stale) return cachedStatusResponse(stale, "stale", env);
  return statusSnapshotResponse(refreshed.snapshot, "miss", env);
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

async function cachedStatusResponse(cached, cacheState, env) {
  const snapshot = await cached.json();
  const headers = new Headers(cached.headers);
  return statusSnapshotResponse(snapshot, cacheState, env, cached.status, headers);
}

async function statusSnapshotResponse(snapshot, cacheState, env, status = 200, headers?) {
  const current = await attachExactReviewQueueStatus(snapshot, env);
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-clawsweeper-cache", cacheState);
  return cors(new Response(JSON.stringify(current, null, 2), { status, headers: responseHeaders }));
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
  return new Request(new URL(`/api/status-cache/v2/${bucket}`, request.url).toString(), {
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

  const completion = bayJourneyCompletionFromGithubWebhook({ event, payload, env });
  if (completion) {
    await recordBayJourneyTelemetry(env, ctx, [], [completion]);
    return json({ ok: true, accepted: false, reason: "recorded Bay journey completion" }, 202);
  }

  const decision = classifyGithubWebhook({ event, payload });
  if (!decision.accepted) {
    return json({ ok: true, accepted: false, reason: decision.reason }, 202);
  }

  if ("type" in decision && decision.type === "item") {
    const deliveryId = request.headers.get("x-github-delivery") || "";
    const queued = await enqueueExactReview({
      env,
      deliveryId,
      decision: decision as ExactReviewDecision,
    });
    if (!queued) return json({ error: "exact_review_queue_not_configured" }, 503);
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
  if (event !== "issue_comment") return null;
  const comment = objectValue(payload?.comment);
  if (!clawsweeperBotLogins(env).has(normalizedLogin(objectValue(comment.user).login))) return null;
  const issue = objectValue(payload?.issue);
  const repo = objectValue(payload?.repository);
  if (!isEligibleGithubWebhookRepository(repo)) return null;
  const repository = String(repo.full_name || "").toLowerCase();
  const number = Number(issue.number);
  const body = String(comment.body || "");
  const sourceCommentId = Number(body.match(/<!--\s*clawsweeper-command-ack:(\d+)\s*-->/i)?.[1]);
  const status = body.match(/<!--\s*clawsweeper-command-status:(\d+):(review|re_review):[^>]*-->/i);
  const completedAt = exactWebhookTimestamp(comment.updated_at || comment.created_at);
  const completed =
    /<!--\s*clawsweeper-command-progress:start\s*-->[\s\S]*?^- State:\s*Complete\s*$[\s\S]*?<!--\s*clawsweeper-command-progress:end\s*-->/im.test(
      body,
    );
  if (
    !repository ||
    !Number.isInteger(number) ||
    number <= 0 ||
    !Number.isSafeInteger(sourceCommentId) ||
    sourceCommentId <= 0 ||
    !status ||
    Number(status[1]) !== number ||
    !completedAt ||
    !completed
  ) {
    return null;
  }
  return {
    repository,
    number,
    source_comment_id: sourceCommentId,
    completed_at: completedAt,
    completion_kind: "final_command_status",
    completion_comment_id: Number(comment.id),
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

export async function exactReviewQueueStatusSnapshot(env) {
  if (!exactReviewQueueStub(env)) return null;
  const response = await exactReviewQueueRequest(env, "/stats");
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

async function authenticatedExactReviewQueueRequest(request, env, path: string) {
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
    new Request(`https://clawsweeper-exact-review-queue${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
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
    ? await exactReviewTerminalRunsFromBatch(token, candidates)
    : await mapWithConcurrency(
        candidates,
        EXACT_REVIEW_RECONCILE_CONCURRENCY,
        async (candidate) => {
          try {
            return await exactReviewTerminalRun(token, candidate);
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
  const base = exactReviewBaseDecisionFrom(value);
  if (!base) return null;
  const decision = objectValue(value);
  const hasPublication = Object.hasOwn(decision, "publication");
  const publication = hasPublication ? exactReviewPublicationFrom(decision.publication) : undefined;
  if (hasPublication && !publication) return null;
  if (publication) {
    if (base.sourceAction !== EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION) return null;
    if (
      publication.producerDecision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION ||
      publication.producerDecision.targetRepo !== base.targetRepo ||
      publication.producerDecision.targetBranch !== base.targetBranch ||
      publication.producerDecision.itemNumber !== base.itemNumber ||
      publication.producerDecision.itemKind !== base.itemKind ||
      publication.producerDecision.sourceEvent !== base.sourceEvent ||
      publication.itemKey !== `${base.targetRepo}#${base.itemNumber}`
    ) {
      return null;
    }
  } else if (base.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION) {
    return null;
  }
  return { ...base, ...(publication ? { publication } : {}) };
}

function exactReviewBaseDecisionFrom(value): ExactReviewBaseDecision | null {
  const decision = objectValue(value);
  const targetRepo = String(decision.targetRepo || "").trim();
  const targetBranch = String(decision.targetBranch || "").trim();
  const itemNumber = Number(decision.itemNumber);
  const itemKind = String(decision.itemKind || "");
  const sourceEvent = String(decision.sourceEvent || "");
  const sourceAction = String(decision.sourceAction || "");
  const hasCommandStatusMarker = Object.hasOwn(decision, "commandStatusMarker");
  const commandStatusMarker = hasCommandStatusMarker ? decision.commandStatusMarker : undefined;
  const hasStatusCommentId = Object.hasOwn(decision, "statusCommentId");
  const statusCommentId = hasStatusCommentId ? Number(decision.statusCommentId) : undefined;
  const hasAdditionalPrompt = Object.hasOwn(decision, "additionalPrompt");
  const additionalPrompt = hasAdditionalPrompt ? decision.additionalPrompt : undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(targetBranch)) return null;
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  if (itemKind !== "issue" && itemKind !== "pull_request") return null;
  if (sourceEvent !== "issues" && sourceEvent !== "pull_request") return null;
  if (!sourceAction) return null;
  if (
    hasCommandStatusMarker &&
    (typeof commandStatusMarker !== "string" ||
      !EXACT_REVIEW_COMMAND_STATUS_MARKER_PATTERN.test(commandStatusMarker))
  ) {
    return null;
  }
  if (
    hasStatusCommentId &&
    (!Number.isSafeInteger(statusCommentId) || Number(statusCommentId) <= 0)
  ) {
    return null;
  }
  if (
    hasAdditionalPrompt &&
    (typeof additionalPrompt !== "string" ||
      additionalPrompt.length > EXACT_REVIEW_ADDITIONAL_PROMPT_MAX_CHARS ||
      additionalPrompt.includes("\0"))
  ) {
    return null;
  }
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
    ...(hasCommandStatusMarker ? { commandStatusMarker } : {}),
    ...(hasStatusCommentId ? { statusCommentId } : {}),
    ...(hasAdditionalPrompt ? { additionalPrompt } : {}),
  };
}

function exactReviewPublicationFrom(value): ExactReviewPublication | null {
  const publication = objectValue(value);
  const artifactName = String(publication.artifactName || "").trim();
  const producerRunId = String(publication.producerRunId || "").trim();
  const producerRunAttempt = Number(publication.producerRunAttempt);
  const sourceSha = String(publication.sourceSha || "").trim();
  const itemKey = String(publication.itemKey || "").trim();
  const protocolVersion = Number(publication.protocolVersion);
  const leaseRevision =
    publication.leaseRevision === null ? null : Number(publication.leaseRevision);
  const claimGeneration =
    publication.claimGeneration === null ? null : Number(publication.claimGeneration);
  const producerDecision = exactReviewBaseDecisionFrom(publication.producerDecision);
  const liveProceeded = publication.liveProceeded;
  const liveTerminalNoop = publication.liveTerminalNoop;
  const liveTerminalMissing = publication.liveTerminalMissing;
  const liveGuardedOpen = publication.liveGuardedOpen;
  if (!/^exact-review-\d{1,30}-[1-9]\d*$/.test(artifactName)) return null;
  if (!/^\d{1,30}$/.test(producerRunId)) return null;
  if (!Number.isSafeInteger(producerRunAttempt) || producerRunAttempt < 1) return null;
  if (artifactName !== `exact-review-${producerRunId}-${producerRunAttempt}`) return null;
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(itemKey)) return null;
  if (protocolVersion !== 1 && protocolVersion !== 2) return null;
  if (
    (leaseRevision !== null && (!Number.isSafeInteger(leaseRevision) || leaseRevision < 1)) ||
    (claimGeneration !== null && (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1))
  ) {
    return null;
  }
  if (protocolVersion === 2 && (leaseRevision === null || claimGeneration === null)) return null;
  if (!producerDecision) return null;
  const liveOutcomes = [liveProceeded, liveTerminalNoop, liveTerminalMissing, liveGuardedOpen];
  if (liveOutcomes.some((outcome) => typeof outcome !== "boolean")) return null;
  if (liveOutcomes.filter(Boolean).length !== 1) return null;
  return {
    artifactName,
    producerRunId,
    producerRunAttempt,
    sourceSha,
    itemKey,
    protocolVersion,
    leaseRevision,
    claimGeneration,
    liveProceeded,
    liveTerminalNoop,
    liveTerminalMissing,
    liveGuardedOpen,
    producerDecision,
  };
}

function mergePendingExactReviewDecision(
  current: ExactReviewDecision,
  next: ExactReviewDecision,
): ExactReviewDecision {
  const merged = { ...current, ...next };
  if (
    Object.hasOwn(next, "commandStatusMarker") &&
    next.commandStatusMarker !== current.commandStatusMarker &&
    !Object.hasOwn(next, "statusCommentId")
  ) {
    delete merged.statusCommentId;
  }
  return merged;
}

function exactReviewItemKey(decision: ExactReviewDecision) {
  const base = `${decision.targetRepo}#${decision.itemNumber}`;
  return decision.publication
    ? `${base}@publish:${decision.publication.producerRunId}:${decision.publication.producerRunAttempt}`
    : base;
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

function exactReviewClaimResponse(
  item: ExactReviewQueueItem,
  protocolVersion: 1 | 2,
  claimGeneration: number,
) {
  return {
    ok: true,
    claimed: true,
    protocol_version: protocolVersion,
    item_key: item.key,
    ...(protocolVersion === 1 ? { revision: item.leaseRevision } : {}),
    lease_revision: item.leaseRevision,
    claim_generation: claimGeneration,
    decision: item.leaseDecision,
  };
}

function exactReviewCompletionOutcome(
  value,
  fallback?: ExactReviewCompletionOutcome,
): ExactReviewCompletionOutcome | null {
  const normalized =
    value === undefined || value === null || value === "" ? fallback : String(value);
  return normalized === "success" || normalized === "failure" || normalized === "cancelled"
    ? normalized
    : null;
}

function exactReviewPublicationFailureKind(value): ExactReviewPublicationFailureKind | null {
  const normalized = String(value || "");
  return normalized === "github_rate_limit" || normalized === "github_transient"
    ? normalized
    : null;
}

function exactReviewRunAttempt(value): number | null {
  const runAttempt = Number(value);
  return Number.isInteger(runAttempt) && runAttempt > 0 ? runAttempt : null;
}

function exactReviewClaimGeneration(value) {
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 0 ? generation : 0;
}

function exactReviewTerminalRuns(value) {
  if (!Array.isArray(value) || value.length > EXACT_REVIEW_RECONCILE_RUN_LIMIT) return null;
  const runs: Array<
    ExactReviewClaimedRun & {
      runAttempt: number;
      claimedRunAttempt?: number;
      outcome: ExactReviewCompletionOutcome;
    }
  > = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = objectValue(entry);
    const runId = String(record.run_id || "").trim();
    const runAttempt = exactReviewRunAttempt(record.run_attempt);
    const claimedRunAttempt =
      record.claimed_run_attempt === null || record.claimed_run_attempt === undefined
        ? undefined
        : exactReviewRunAttempt(record.claimed_run_attempt);
    const claimGeneration = Number(record.claim_generation);
    const outcome = exactReviewCompletionOutcome(record.outcome);
    if (
      !/^\d+$/.test(runId) ||
      !runAttempt ||
      claimedRunAttempt === null ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 0 ||
      !outcome
    ) {
      return null;
    }
    const key = `${runId}:${runAttempt}:${claimGeneration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ runId, runAttempt, claimedRunAttempt, claimGeneration, outcome });
  }
  return runs;
}

function exactReviewRequestedRuns(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > EXACT_REVIEW_RECONCILE_RUN_LIMIT
  ) {
    return null;
  }
  const runs: Array<{ runId: string; runAttempt?: number }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = objectValue(entry);
    const runId = String(record.run_id || (typeof entry !== "object" ? entry : "")).trim();
    if (!/^\d+$/.test(runId)) return null;
    const hasRunAttempt = Object.hasOwn(record, "run_attempt");
    const runAttempt = hasRunAttempt ? exactReviewRunAttempt(record.run_attempt) : null;
    if (hasRunAttempt && !runAttempt) return null;
    const key = `${runId}:${runAttempt || "latest"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ runId, ...(runAttempt ? { runAttempt } : {}) });
  }
  return runs;
}

function exactReviewClaimedRuns(value): ExactReviewClaimedRun[] | null {
  if (!Array.isArray(value) || value.length > EXACT_REVIEW_RECONCILE_CLAIM_MATCH_LIMIT) {
    return null;
  }
  const runs: ExactReviewClaimedRun[] = [];
  for (const entry of value) {
    const record = objectValue(entry);
    const runId = String(record.run_id || "").trim();
    const runAttempt =
      record.run_attempt === null || record.run_attempt === undefined
        ? undefined
        : exactReviewRunAttempt(record.run_attempt);
    const claimGeneration = Number(record.claim_generation);
    if (
      !/^\d+$/.test(runId) ||
      runAttempt === null ||
      !Number.isInteger(claimGeneration) ||
      claimGeneration < 0
    ) {
      return null;
    }
    runs.push({ runId, runAttempt, claimGeneration });
  }
  return runs;
}

function finishExactReviewQueueItem(
  state: ExactReviewQueueState,
  item: ExactReviewQueueItem,
  now: number,
  outcome: ExactReviewCompletionOutcome,
  requestedRetryAt = 0,
  requeueLatest = false,
) {
  const retryingFailure = outcome !== "success";
  const hasNewerRevision = item.revision > Number(item.leaseRevision || 0);
  // A regular queue item may back off and retry after a failed lease. Failed
  // sweep shards already consumed their one recovery attempt before reaching
  // the queue, so only a newer source revision may supersede that recovery.
  const oneShotRecovery =
    item.leaseDecision?.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
  const requeued = (!oneShotRecovery && retryingFailure) || hasNewerRevision || requeueLatest;
  if (requeued) {
    clearExactReviewLease(item);
    item.state = "pending";
    if (retryingFailure && !hasNewerRevision && !requeueLatest) {
      item.attempts += 1;
      item.nextAttemptAt = Math.max(
        exactReviewQueueEnqueueAttemptAt(state, now),
        now + exactReviewRetryDelayMs(item.attempts),
        hasNewerRevision ? 0 : requestedRetryAt,
      );
    } else {
      item.nextAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
      item.attempts = 0;
    }
    item.updatedAt = now;
  } else {
    delete state.items[item.key];
  }
  return requeued;
}

function exactReviewCompletionRetryAt(value, now: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const retryAt = Date.parse(String(value));
  if (!Number.isFinite(retryAt)) return null;
  if (retryAt > now + EXACT_REVIEW_COMPLETION_RETRY_MAX_MS) return null;
  return Math.max(now, retryAt);
}

function clearExactReviewLease(item: ExactReviewQueueItem) {
  item.leaseId = undefined;
  item.leaseRevision = undefined;
  item.leaseDecision = undefined;
  item.leaseExpiresAt = undefined;
  item.leaseHeartbeatAt = undefined;
  item.claimedRunId = undefined;
  item.claimedRunAttempt = undefined;
  item.claimGeneration = undefined;
  item.claimProtocolVersion = undefined;
  item.dispatchedAt = undefined;
  item.claimedAt = undefined;
}

export function exactReviewEffectiveLeaseExpiresAt(
  item: ExactReviewQueueItem,
  publicationDispatchLeaseMs: number,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  const leaseExpiresAt = Number(item.leaseExpiresAt || 0);
  const leaseHeartbeatAt = Number(item.leaseHeartbeatAt || 0);
  if (leaseExpiresAt && item.state === "leased" && leaseHeartbeatAt) {
    return Math.min(leaseExpiresAt, leaseHeartbeatAt + heartbeatGraceMs);
  }
  if (
    !leaseExpiresAt ||
    item.state !== "dispatching" ||
    !exactReviewQueueIsPublication(item) ||
    item.claimedRunId ||
    !item.dispatchedAt
  ) {
    return leaseExpiresAt;
  }
  return Math.min(leaseExpiresAt, item.dispatchedAt + publicationDispatchLeaseMs);
}

function isLiveExactReviewLease(
  item: ExactReviewQueueItem,
  now: number,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  return Boolean(
    item.leaseId &&
    exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs) > now,
  );
}

function reclaimExpiredExactReviewLeases(
  state: ExactReviewQueueState,
  now: number,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  let changed = false;
  for (const [key, item] of Object.entries(state.items)) {
    if (
      reclaimExpiredExactReviewLease(
        state,
        key,
        item,
        now,
        publicationDispatchLeaseMs,
        heartbeatGraceMs,
      )
    ) {
      changed = true;
    }
  }
  return changed;
}

function reclaimExpiredExactReviewLease(
  state: ExactReviewQueueState,
  key: string,
  item: ExactReviewQueueItem,
  now: number,
  publicationDispatchLeaseMs: number,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  if (
    (item.state !== "dispatching" && item.state !== "leased") ||
    isLiveExactReviewLease(item, now, publicationDispatchLeaseMs, heartbeatGraceMs)
  ) {
    return false;
  }
  const oneShotRecovery =
    (item.leaseDecision || item.decision).sourceAction ===
    FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION;
  const hasNewerRevision = item.revision > Number(item.leaseRevision || 0);
  if (oneShotRecovery && !hasNewerRevision) {
    delete state.items[key];
    return true;
  }
  clearExactReviewLease(item);
  item.state = "pending";
  item.nextAttemptAt = now;
  if (hasNewerRevision) item.attempts = 0;
  item.updatedAt = now;
  return true;
}

function expireExactReviewPublicationItems(state: ExactReviewQueueState, now: number, env) {
  let changed = false;
  for (const [key, item] of Object.entries(state.items)) {
    const publication = item.decision.publication;
    if (
      item.state !== "pending" ||
      !publication ||
      now < item.createdAt + EXACT_REVIEW_ARTIFACT_RETRY_MAX_MS
    ) {
      continue;
    }
    delete state.items[key];
    const decision: ExactReviewDecision = {
      ...publication.producerDecision,
      sourceAction:
        publication.producerDecision.sourceAction === FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
          ? FAILED_REVIEW_SHARD_RECOVERY_SOURCE_ACTION
          : EXACT_REVIEW_ARTIFACT_RETENTION_RECOVERY_SOURCE_ACTION,
      supersedesInProgress: true,
    };
    const recoveryKey = exactReviewItemKey(decision);
    const current = state.items[recoveryKey];
    if (current?.state === "pending") {
      current.decision = mergePendingExactReviewDecision(current.decision, decision);
      current.revision += 1;
      current.updatedAt = now;
      // Merged decision, not the raw recovery: a pending explicit command must
      // keep its immediate attempt time (same rule as the enqueue merge path).
      current.nextAttemptAt = exactReviewQueueDebouncedAttemptAt(
        state,
        current.decision,
        now,
        current.createdAt,
        env,
      );
      current.attempts = 0;
    } else if (!current) {
      // The expired publication was already deleted above; shedding here only
      // suppresses creation of its replacement recovery item.
      if (exactReviewQueuePendingCount(state) >= exactReviewPendingSoftLimit(env)) {
        state.shedSinceReset = exactReviewShedSinceReset(state) + 1;
        changed = true;
        continue;
      }
      state.items[recoveryKey] = {
        key: recoveryKey,
        decision,
        state: "pending",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: exactReviewQueueDebouncedAttemptAt(state, decision, now, now, env),
        attempts: 0,
      };
    }
    changed = true;
  }
  return changed;
}

function exactReviewQueueEnqueueAttemptAt(state: ExactReviewQueueState, now: number) {
  const retryAt = Number(state.dispatcher?.retryAt || 0);
  return (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    retryAt > now
    ? retryAt
    : now;
}

function exactReviewQueueDebouncedAttemptAt(
  state: ExactReviewQueueState,
  decision: ExactReviewDecision,
  now: number,
  firstEnqueuedAt: number,
  env,
) {
  const baseAttemptAt = exactReviewQueueEnqueueAttemptAt(state, now);
  if (isImmediateExactReviewDecision(decision)) return baseAttemptAt;
  const debounceAt = Math.min(
    now + exactReviewDispatchDebounceMs(env),
    firstEnqueuedAt + exactReviewDispatchDebounceMaxMs(env),
  );
  return Math.max(baseAttemptAt, debounceAt);
}

function isImmediateExactReviewDecision(decision: ExactReviewDecision) {
  return Boolean(decision.commandStatusMarker || decision.publication);
}

function isLowPriorityExactReviewDecision(decision: ExactReviewDecision) {
  return EXACT_REVIEW_LOW_PRIORITY_SOURCE_ACTIONS.has(decision.sourceAction);
}

function exactReviewQueuePendingCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter((item) => item.state === "pending").length;
}

function exactReviewShedSinceReset(state: Pick<ExactReviewQueueState, "shedSinceReset">) {
  const value = Number(state.shedSinceReset || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function exactReviewMetricTotal(value: unknown) {
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

function exactReviewMetricDelta(value: unknown) {
  const delta = Number(value || 0);
  return Number.isSafeInteger(delta) && delta > 0 ? delta : 0;
}

function exactReviewQueueIsPublication(item: ExactReviewQueueItem) {
  return item.decision.sourceAction === EXACT_REVIEW_ARTIFACT_PUBLISH_SOURCE_ACTION;
}

function exactReviewQueueLane(item: ExactReviewQueueItem) {
  return exactReviewQueueIsPublication(item) ? "publication" : "review";
}

function exactReviewQueueActiveReviewCount(state: ExactReviewQueueState) {
  return Object.values(state.items).filter(
    (item) =>
      !exactReviewQueueIsPublication(item) &&
      (item.state === "dispatching" || item.state === "leased"),
  ).length;
}

export function exactReviewQueueAdmittedItems(
  state: ExactReviewQueueState,
  now: number,
  capacity: number,
  targetCapacity: number,
  publicationCapacity: number,
) {
  const dispatcherRetryAt = Number(state.dispatcher?.retryAt || 0);
  if (
    (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    dispatcherRetryAt > now
  ) {
    return [];
  }
  const reviewSlots = Math.max(0, capacity - exactReviewQueueActiveReviewCount(state));
  const activeTargets = new Map<string, number>();
  let activePublishers = 0;
  for (const item of Object.values(state.items)) {
    if (item.state !== "dispatching" && item.state !== "leased") continue;
    if (exactReviewQueueIsPublication(item)) {
      activePublishers += 1;
      continue;
    }
    const target = item.decision.targetRepo;
    activeTargets.set(target, (activeTargets.get(target) || 0) + 1);
  }
  const admitted: ExactReviewQueueItem[] = [];
  let admittedReviews = 0;
  const pending = Object.values(state.items)
    .filter((item) => item.state === "pending" && item.nextAttemptAt <= now)
    .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
  for (const item of pending) {
    const publication = exactReviewQueueIsPublication(item);
    if (publication) {
      if (activePublishers >= publicationCapacity) continue;
      activePublishers += 1;
      admitted.push(item);
      continue;
    }
    if (admittedReviews >= reviewSlots) continue;
    const target = item.decision.targetRepo;
    const active = activeTargets.get(target) || 0;
    if (active >= targetCapacity) continue;
    activeTargets.set(target, active + 1);
    admittedReviews += 1;
    admitted.push(item);
  }
  return admitted;
}

function exactReviewQueueStats(
  state: ExactReviewQueueState,
  now = Date.now(),
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
  publicationCapacity = Number.POSITIVE_INFINITY,
  dispatchLeaseMs = DEFAULT_EXACT_REVIEW_DISPATCH_LEASE_MS,
  executionLeaseMs = DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  const items = Object.values(state.items);
  const handoffHealth = summarizeExactReviewHandoff({
    items,
    dispatcher: state.dispatcher,
    shedSinceReset: exactReviewShedSinceReset(state),
    now,
    capacity,
    dispatchLeaseMs,
    executionLeaseMs,
  });
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
  const nextWakeAt = exactReviewQueueNextWakeAt(
    state,
    now,
    capacity,
    targetCapacity,
    publicationCapacity,
    publicationDispatchLeaseMs,
    heartbeatGraceMs,
  );
  const lanes = {
    review: exactReviewQueueLaneStats(
      items.filter((item) => !exactReviewQueueIsPublication(item)),
      now,
      capacity,
      exactReviewShedSinceReset(state),
    ),
    publication: exactReviewQueueLaneStats(
      items.filter(exactReviewQueueIsPublication),
      now,
      publicationCapacity,
    ),
  };
  return {
    pending: handoffHealth.phases.pending.count,
    shed_since_reset: exactReviewShedSinceReset(state),
    dispatching: handoffHealth.phases.dispatching.count,
    leased: handoffHealth.phases.leased.count,
    oldest_pending_at: handoffHealth.phases.pending.oldest_at,
    oldest_pending_age_seconds: handoffHealth.phases.pending.oldest_age_seconds,
    oldest_dispatching_at: handoffHealth.phases.dispatching.oldest_at,
    oldest_dispatching_age_seconds: handoffHealth.phases.dispatching.oldest_age_seconds,
    oldest_leased_at: handoffHealth.phases.leased.oldest_at,
    oldest_leased_age_seconds: handoffHealth.phases.leased.oldest_age_seconds,
    handoff_health: handoffHealth,
    lanes,
    next_wake_at: nextWakeAt === null ? null : new Date(nextWakeAt).toISOString(),
    dispatcher: {
      state: state.dispatcher?.state || "unknown",
      reason: state.dispatcher?.reason || null,
      workflow_state: state.dispatcher?.workflowState || null,
      checked_at: state.dispatcher?.checkedAt
        ? new Date(state.dispatcher.checkedAt).toISOString()
        : null,
      retry_at: state.dispatcher?.retryAt ? new Date(state.dispatcher.retryAt).toISOString() : null,
    },
    target_stats: targetStats,
  };
}

function exactReviewQueueLaneStats(
  items: ExactReviewQueueItem[],
  now: number,
  capacity: number,
  shedSinceReset = 0,
) {
  const pendingItems = items.filter((item) => item.state === "pending");
  const dispatchingItems = items.filter((item) => item.state === "dispatching");
  const leasedItems = items.filter((item) => item.state === "leased");
  const active = dispatchingItems.length + leasedItems.length;
  const oldestPendingAt = pendingItems.reduce<number | null>(
    (oldest, item) => (oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)),
    null,
  );
  const nextAttemptAt = pendingItems.reduce<number | null>(
    (next, item) => (next === null ? item.nextAttemptAt : Math.min(next, item.nextAttemptAt)),
    null,
  );
  return {
    pending: pendingItems.length,
    pending_depth: pendingItems.length,
    shed_since_reset: shedSinceReset,
    ready: pendingItems.filter((item) => item.nextAttemptAt <= now).length,
    backoff: pendingItems.filter((item) => item.nextAttemptAt > now).length,
    dispatching: dispatchingItems.length,
    leased: leasedItems.length,
    capacity,
    active,
    available_slots: Math.max(0, capacity - active),
    oldest_pending_at: oldestPendingAt === null ? null : new Date(oldestPendingAt).toISOString(),
    oldest_pending_age_seconds:
      oldestPendingAt === null ? null : Math.max(0, Math.floor((now - oldestPendingAt) / 1_000)),
    next_attempt_at: nextAttemptAt === null ? null : new Date(nextAttemptAt).toISOString(),
  };
}

export function exactReviewQueueNextWakeAt(
  state: ExactReviewQueueState,
  now: number,
  capacity = Number.POSITIVE_INFINITY,
  targetCapacity = Number.POSITIVE_INFINITY,
  publicationCapacity = Number.POSITIVE_INFINITY,
  publicationDispatchLeaseMs = DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  heartbeatGraceMs = DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS,
) {
  const items = Object.values(state.items);
  if (!items.length) return null;
  const dispatcherRetryAt = Number(state.dispatcher?.retryAt || 0);
  const dispatcherPaused =
    (state.dispatcher?.state === "paused" || state.dispatcher?.state === "blocked") &&
    dispatcherRetryAt > now;
  const activeItems = items.filter(
    (item) => item.state === "dispatching" || item.state === "leased",
  );
  if (
    activeItems.some(
      (item) =>
        !item.leaseExpiresAt ||
        exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs) <=
          now,
    )
  ) {
    return now + 1_000;
  }
  const activeReviews = activeItems.filter((item) => !exactReviewQueueIsPublication(item));
  const activePublishers = activeItems.filter(exactReviewQueueIsPublication);
  const activeReviewWakeAt = activeReviews
    .map((item) =>
      exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs),
    )
    .filter((value): value is number => Boolean(value && value > now));
  const activePublisherWakeAt = activePublishers
    .map((item) =>
      exactReviewEffectiveLeaseExpiresAt(item, publicationDispatchLeaseMs, heartbeatGraceMs),
    )
    .filter((value): value is number => Boolean(value && value > now));
  const activeTargetWakeAt = new Map<string, number>();
  const activeTargetCounts = new Map<string, number>();
  for (const item of activeReviews) {
    const leaseExpiresAt = exactReviewEffectiveLeaseExpiresAt(
      item,
      publicationDispatchLeaseMs,
      heartbeatGraceMs,
    );
    if (leaseExpiresAt > now) {
      const target = item.decision.targetRepo;
      activeTargetCounts.set(target, (activeTargetCounts.get(target) || 0) + 1);
      const current = activeTargetWakeAt.get(item.decision.targetRepo);
      activeTargetWakeAt.set(
        target,
        current === undefined ? leaseExpiresAt : Math.min(current, leaseExpiresAt),
      );
    }
  }
  const times = items.flatMap((item) => {
    if (item.state === "pending") {
      if (dispatcherPaused) return [dispatcherRetryAt];
      if (exactReviewQueueIsPublication(item)) {
        const blockedUntil =
          activePublishers.length >= publicationCapacity && activePublisherWakeAt.length
            ? Math.min(...activePublisherWakeAt)
            : item.nextAttemptAt;
        return [Math.max(item.nextAttemptAt, blockedUntil)];
      }
      const target = item.decision.targetRepo;
      const blockedUntil = [
        ...(activeReviews.length >= capacity && activeReviewWakeAt.length
          ? [Math.min(...activeReviewWakeAt)]
          : []),
        ...((activeTargetCounts.get(target) || 0) >= targetCapacity &&
        activeTargetWakeAt.has(target)
          ? [activeTargetWakeAt.get(target) as number]
          : []),
      ];
      return [
        Math.max(
          item.nextAttemptAt,
          blockedUntil.length ? Math.min(...blockedUntil) : item.nextAttemptAt,
        ),
      ];
    }
    const leaseExpiresAt = exactReviewEffectiveLeaseExpiresAt(
      item,
      publicationDispatchLeaseMs,
      heartbeatGraceMs,
    );
    return leaseExpiresAt ? [leaseExpiresAt] : [];
  });
  if (!times.length) return now + DEFAULT_EXACT_REVIEW_RETRY_MS;
  return Math.max(now + 1_000, Math.min(...times));
}

export function exactReviewQueueCapacity(env) {
  return Math.max(
    1,
    Math.min(
      numberFrom(env.WORKER_BUDGET, 128),
      numberFrom(env.EXACT_REVIEW_QUEUE_MAX_CONCURRENT, DEFAULT_EXACT_REVIEW_QUEUE_MAX_CONCURRENT),
    ),
  );
}

export function exactReviewPublicationCapacity(
  env,
  readyBacklog = 0,
  activePublishers = 0,
  capacityCeiling = Number.POSITIVE_INFINITY,
) {
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  const base = exactReviewPublicationBase(env, maximum);
  const adaptiveMaximum = Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(Number(capacityCeiling)) ? Number(capacityCeiling) : maximum),
  );
  const scaleSteps = Math.floor(
    Math.max(0, Number(readyBacklog) || 0) / EXACT_REVIEW_PUBLICATION_READY_PER_SCALE_STEP,
  );
  const desired = Math.min(
    adaptiveMaximum,
    base + scaleSteps * EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP,
  );
  // Scaling down is admission-only. Keep the reported capacity at the active
  // publisher count so a drained backlog does not look over capacity while
  // already-running publication jobs finish naturally.
  return Math.min(maximum, Math.max(desired, Math.max(0, Number(activePublishers) || 0)));
}

function exactReviewPublicationMaximum(env) {
  return Math.max(
    1,
    Math.min(
      exactReviewQueueCapacity(env),
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT,
        DEFAULT_EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT,
      ),
    ),
  );
}

function exactReviewPublicationBase(env, maximum = exactReviewPublicationMaximum(env)) {
  return Math.max(
    exactReviewPublicationMinimum(env, maximum),
    Math.min(
      maximum,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT,
        DEFAULT_EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT,
      ),
    ),
  );
}

function exactReviewPublicationMinimum(env, maximum = exactReviewPublicationMaximum(env)) {
  return Math.min(
    maximum,
    Math.max(
      1,
      numberFrom(
        env.EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT,
        DEFAULT_EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT,
      ),
    ),
  );
}

function exactReviewPublicationControl(env, value: unknown): ExactReviewPublicationControl {
  const control = objectValue(value);
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  const rawCeiling = Number(control.capacityCeiling);
  const rawCooldown = Number(control.cooldownUntil);
  const rawRecoverySuccesses = Number(control.recoverySuccesses);
  const rawLastFailureAt = Number(control.lastFailureAt);
  const lastFailureKind = exactReviewPublicationFailureKind(control.lastFailureKind);
  return {
    capacityCeiling: Number.isSafeInteger(rawCeiling)
      ? Math.max(minimum, Math.min(maximum, rawCeiling))
      : maximum,
    cooldownUntil: Number.isSafeInteger(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0,
    recoverySuccesses:
      Number.isSafeInteger(rawRecoverySuccesses) && rawRecoverySuccesses > 0
        ? rawRecoverySuccesses
        : 0,
    ...(Number.isSafeInteger(rawLastFailureAt) && rawLastFailureAt > 0
      ? { lastFailureAt: rawLastFailureAt }
      : {}),
    ...(lastFailureKind ? { lastFailureKind } : {}),
  };
}

function exactReviewPublicationControlAfterFeedback(
  env,
  control: ExactReviewPublicationControl,
  feedback: ExactReviewPublicationFeedback,
) {
  const maximum = exactReviewPublicationMaximum(env);
  const minimum = exactReviewPublicationMinimum(env, maximum);
  if (feedback.outcome === "failure") {
    const failureKind = feedback.failureKind || "github_transient";
    const rateLimited = failureKind === "github_rate_limit";
    const currentCapacity = Math.max(minimum, Math.min(control.capacityCeiling, feedback.capacity));
    const ceiling = rateLimited
      ? Math.max(minimum, Math.floor(currentCapacity / 2))
      : Math.max(minimum, currentCapacity - EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP);
    return {
      capacityCeiling: ceiling,
      cooldownUntil: Math.max(
        control.cooldownUntil,
        feedback.at +
          (rateLimited
            ? EXACT_REVIEW_PUBLICATION_RATE_LIMIT_COOLDOWN_MS
            : EXACT_REVIEW_PUBLICATION_TRANSIENT_COOLDOWN_MS),
      ),
      recoverySuccesses: 0,
      lastFailureAt: feedback.at,
      lastFailureKind: failureKind,
    };
  }
  if (feedback.at < control.cooldownUntil || control.capacityCeiling >= maximum) {
    return { ...control, recoverySuccesses: 0 };
  }
  const recoverySuccesses = control.recoverySuccesses + 1;
  if (recoverySuccesses < EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES) {
    return { ...control, recoverySuccesses };
  }
  return {
    ...control,
    capacityCeiling: Math.min(
      maximum,
      control.capacityCeiling + EXACT_REVIEW_PUBLICATION_CONCURRENT_SCALE_STEP,
    ),
    recoverySuccesses: 0,
  };
}

function exactReviewPublicationControlStatus(env, control: ExactReviewPublicationControl) {
  const maximum = exactReviewPublicationMaximum(env);
  return {
    mode: control.capacityCeiling < maximum ? "throttled" : "adaptive",
    minimum: exactReviewPublicationMinimum(env, maximum),
    base: exactReviewPublicationBase(env, maximum),
    maximum,
    ceiling: control.capacityCeiling,
    cooldown_until:
      control.cooldownUntil > 0 ? new Date(control.cooldownUntil).toISOString() : null,
    recovery_successes: control.recoverySuccesses,
    last_failure_at:
      control.lastFailureAt && control.lastFailureAt > 0
        ? new Date(control.lastFailureAt).toISOString()
        : null,
    last_failure_kind: control.lastFailureKind || null,
  };
}

function exactReviewPublicationCapacityForState(
  env,
  state: ExactReviewQueueState,
  now: number,
  capacityCeiling = Number.POSITIVE_INFINITY,
  preserveActive = true,
) {
  let readyBacklog = 0;
  let activePublishers = 0;
  for (const item of Object.values(state.items)) {
    if (!exactReviewQueueIsPublication(item)) continue;
    if (item.state === "pending" && item.nextAttemptAt <= now) readyBacklog += 1;
    else if (item.state === "dispatching" || item.state === "leased") activePublishers += 1;
  }
  return exactReviewPublicationCapacity(
    env,
    readyBacklog,
    preserveActive ? activePublishers : 0,
    capacityCeiling,
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

function exactReviewPublicationDispatchLeaseMs(env) {
  return Math.max(
    exactReviewDispatchLeaseMs(env),
    DEFAULT_EXACT_REVIEW_PUBLICATION_DISPATCH_LEASE_MS,
  );
}

function exactReviewExecutionLeaseMs(env) {
  return Math.max(
    60_000,
    numberFrom(env.EXACT_REVIEW_EXECUTION_LEASE_MS, DEFAULT_EXACT_REVIEW_EXECUTION_LEASE_MS),
  );
}

function exactReviewHeartbeatGraceMs(env) {
  // Floor must stay above the 5-minute worker heartbeat interval (plus request time and
  // scheduling jitter) or a configured grace would reclaim healthy leases between beats.
  return Math.max(
    420_000,
    numberFrom(env.EXACT_REVIEW_HEARTBEAT_GRACE_MS, DEFAULT_EXACT_REVIEW_HEARTBEAT_GRACE_MS),
  );
}

function exactReviewRetryDelayMs(attempt: number) {
  return Math.min(5 * 60_000, DEFAULT_EXACT_REVIEW_RETRY_MS * 2 ** Math.min(attempt - 1, 4));
}

function exactReviewWorkflowPausedRetryMs(env) {
  return Math.max(
    30_000,
    Math.min(
      15 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS,
        DEFAULT_EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS,
      ),
    ),
  );
}

function exactReviewDispatchDebounceMs(env) {
  return Math.max(
    0,
    Math.min(
      15 * 60_000,
      numberFrom(env.EXACT_REVIEW_DISPATCH_DEBOUNCE_MS, DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MS),
    ),
  );
}

function exactReviewDispatchDebounceMaxMs(env) {
  return Math.max(
    0,
    Math.min(
      60 * 60_000,
      numberFrom(
        env.EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS,
        DEFAULT_EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS,
      ),
    ),
  );
}

function exactReviewPendingSoftLimit(env) {
  return Math.max(
    1,
    Math.min(
      100_000,
      numberFrom(env.EXACT_REVIEW_PENDING_SOFT_LIMIT, DEFAULT_EXACT_REVIEW_PENDING_SOFT_LIMIT),
    ),
  );
}

async function exactReviewDispatchToken(env) {
  return exactReviewRepositoryToken(env, { actions: "read", contents: "write" });
}

async function exactReviewActionsReadToken(env) {
  return exactReviewRepositoryToken(env, { actions: "read" });
}

async function exactReviewRepositoryToken(env, permissions) {
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new Error("github app is not configured");
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId = await githubAppInstallationId(appJwt, CLAWSWEEPER_REVIEW_REPO);
  return createGithubAppTokenFor({
    appJwt,
    installationId,
    label: CLAWSWEEPER_REVIEW_REPO,
    repositories: [repoName(CLAWSWEEPER_REVIEW_REPO)],
    permissions,
  });
}

async function exactReviewWorkflowState(token: string) {
  const payload = await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/workflows/sweep.yml`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper workflow status",
  });
  const state = String(payload.state || "").trim();
  if (!state) throw new Error("ClawSweeper workflow status response missing state");
  return state;
}

async function exactReviewTerminalRun(
  token: string,
  candidate: ExactReviewClaimedRun & { requestedRunAttempt?: number },
) {
  const latest = await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/runs/${candidate.runId}`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper run status",
  });
  return exactReviewTerminalRunFromSummary(token, candidate, latest);
}

async function exactReviewTerminalRunsFromBatch(
  token: string,
  candidates: Array<ExactReviewClaimedRun & { requestedRunAttempt?: number }>,
) {
  const runsById = new Map<string, Record<string, unknown>>();
  const unresolved = new Set(candidates.map((candidate) => candidate.runId));
  for (let page = 1; page <= EXACT_REVIEW_RECONCILE_LIST_PAGE_LIMIT; page += 1) {
    let payload;
    try {
      payload = await githubTokenJson({
        token,
        path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/workflows/sweep.yml/runs?event=repository_dispatch&per_page=100&page=${page}`,
        method: "GET",
        body: undefined,
        errorLabel: "ClawSweeper run batch",
      });
    } catch {
      break;
    }
    const workflowRuns = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
    for (const entry of workflowRuns) {
      const summary = objectValue(entry);
      const runId = String(summary.id || "").trim();
      if (!unresolved.has(runId)) continue;
      runsById.set(runId, summary);
      unresolved.delete(runId);
    }
    if (!unresolved.size || workflowRuns.length < 100) break;
  }
  return mapWithConcurrency(candidates, EXACT_REVIEW_RECONCILE_CONCURRENCY, async (candidate) => {
    const summary = runsById.get(candidate.runId);
    try {
      return summary
        ? await exactReviewTerminalRunFromSummary(token, candidate, summary)
        : await exactReviewTerminalRun(token, candidate);
    } catch {
      return undefined;
    }
  });
}

async function exactReviewTerminalRunFromSummary(
  token: string,
  candidate: ExactReviewClaimedRun & { requestedRunAttempt?: number },
  latest: Record<string, unknown>,
) {
  const expectedRunAttempt = candidate.requestedRunAttempt ?? candidate.runAttempt;
  if (String(latest.id || "") !== candidate.runId) {
    throw new Error("ClawSweeper run status response id mismatch");
  }
  const latestRunAttempt = exactReviewRunAttempt(latest.run_attempt);
  if (!latestRunAttempt) {
    throw new Error("ClawSweeper run status response attempt mismatch");
  }
  if (expectedRunAttempt && latestRunAttempt !== expectedRunAttempt) return null;
  if (String(latest.status || "") !== "completed") return null;

  const payload = await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/actions/runs/${candidate.runId}/attempts/${latestRunAttempt}`,
    method: "GET",
    body: undefined,
    errorLabel: "ClawSweeper run attempt status",
  });
  if (
    String(payload.id || "") !== candidate.runId ||
    exactReviewRunAttempt(payload.run_attempt) !== latestRunAttempt ||
    String(payload.status || "") !== "completed"
  ) {
    throw new Error("ClawSweeper run attempt status response mismatch");
  }
  const conclusion = String(payload.conclusion || "").trim();
  if (!conclusion) throw new Error("ClawSweeper completed run missing conclusion");
  return {
    run_id: candidate.runId,
    run_attempt: latestRunAttempt,
    claimed_run_attempt: candidate.runAttempt ?? null,
    claim_generation: candidate.claimGeneration,
    outcome:
      conclusion === "success" ? "success" : conclusion === "cancelled" ? "cancelled" : "failure",
  } satisfies {
    run_id: string;
    run_attempt: number;
    claimed_run_attempt: number | null;
    claim_generation: number;
    outcome: ExactReviewCompletionOutcome;
  };
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
    if (!String(error.message || "").includes("422")) {
      console.error(`ClawSweeper comment reaction failed: ${error?.message || error}`);
    }
    return null;
  });
}

async function dispatchClawsweeperItem({
  token,
  decision,
  itemKey,
  leaseId,
  leaseRevision,
}: {
  token: string;
  decision: ExactReviewDecision;
  itemKey: string;
  leaseId: string;
  leaseRevision: number;
}) {
  // Keep the v1 fields during the rolling-upgrade window. Old workflows consume
  // this immutable dispatch snapshot, while v2 workflows ignore it after claim
  // and consume the Worker's leaseDecision response instead.
  const reviewOptions = {
    ...(decision.codexTimeoutMs ? { codex_timeout_ms: decision.codexTimeoutMs } : {}),
    ...(decision.mediaProofTimeoutMs
      ? { media_proof_timeout_ms: decision.mediaProofTimeoutMs }
      : {}),
    ...(decision.commandStatusMarker
      ? { command_status_marker: decision.commandStatusMarker }
      : {}),
    ...(decision.statusCommentId ? { status_comment_id: decision.statusCommentId } : {}),
    ...(decision.additionalPrompt ? { additional_prompt: decision.additionalPrompt } : {}),
    ...(decision.publication ? { publication: decision.publication } : {}),
  };
  await githubTokenJson({
    token,
    path: `/repos/${CLAWSWEEPER_REVIEW_REPO}/dispatches`,
    method: "POST",
    body: {
      event_type: "clawsweeper_item",
      client_payload: {
        queue_lease_id: leaseId,
        queue_claim: {
          protocol_version: 2,
          item_key: itemKey,
          lease_revision: leaseRevision,
        },
        target_repo: decision.targetRepo,
        target_branch: decision.targetBranch,
        item_number: decision.itemNumber,
        item_kind: decision.itemKind,
        source_event: decision.sourceEvent,
        source_action: decision.sourceAction,
        supersedes_in_progress: decision.supersedesInProgress,
        ...(Object.keys(reviewOptions).length > 0 ? { review_options: reviewOptions } : {}),
      },
    },
    errorLabel: "ClawSweeper item dispatch",
  });
}

async function dispatchClawsweeperComment({ token, decision, statusCommentId }) {
  const exactVersion =
    decision.commentUpdatedAt && typeof decision.commentBody === "string"
      ? {
          comment_event_auth: "github_webhook_v1",
          comment_updated_at: decision.commentUpdatedAt,
          comment_body_sha256: await sha256Text(decision.commentBody),
        }
      : {};
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
  const [workerHealth, pipeline, clusterRepair, applyHealth, automerge, closed, storedEvents] =
    await Promise.all([
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
  let exactReviewQueue = null;
  let exactReviewQueueError = null;
  try {
    exactReviewQueue = await withTimeout(
      exactReviewQueueStatusSnapshot(env),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "exact-review queue",
    );
  } catch (error) {
    exactReviewQueueError = error instanceof Error ? error.message : String(error);
  }
  return {
    ...snapshot,
    exact_review_queue: exactReviewQueue,
    diagnostics: {
      ...diagnostics,
      exact_review_queue_error: exactReviewQueueError,
    },
  };
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
      const jobs = await workflowJobsForRun(env, repo, run.id, github);
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
      if (isCodexWorkflowFallback(result.run)) {
        workers.push(normalizeFallbackWorker(result.run));
        fallbacks += 1;
      }
      continue;
    }
    if (result.workers.length) {
      workers.push(...result.workers);
    } else if (!result.hasWorkerJobs && isCodexWorkflowFallback(result.run)) {
      workers.push(normalizeFallbackWorker(result.run));
      fallbacks += 1;
    }
  }
  for (const run of runs.slice(detailRunLimit)) {
    if (!isCodexWorkflowFallback(run)) continue;
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
        attempts: (await workflowJobsForRun(env, repo, run.id, github))
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
) {
  const completedMarker = Date.parse(completedAt);
  const marker =
    Number.isSafeInteger(Number(completionCommentId)) && Number(completionCommentId) > 0
      ? `comment:${Number(completionCommentId)}:at:${completedMarker}`
      : `at:${completedMarker}`;
  return `${String(repository || "").toLowerCase()}#${Number(itemNumber)}:command:${Number(sourceCommentId)}:completion:${marker}`;
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
    ),
    item_key: `${repository}#${number}`,
    repository,
    number,
    source_comment_id: sourceCommentId,
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
  const completion = normalizeBayJourneyCompletion(record);
  if (!trigger && !completion) return null;
  const source = trigger || completion;
  return {
    id: source.id,
    item_key: source.item_key,
    repository: source.repository,
    number: source.number,
    source_comment_id: source.source_comment_id,
    source_delivery_id: trigger?.source_delivery_id || null,
    triggered_at: trigger?.triggered_at || null,
    completed_at: completion?.completed_at || null,
    completion_kind: completion?.completion_kind || null,
    completion_comment_id: completion?.completion_comment_id || null,
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
          !record.triggered_at &&
          (Date.parse(String(record.completed_at || "")) || 0) >= Date.parse(trigger.triggered_at),
      )
      .sort(
        (left, right) =>
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
    const current =
      [...records.values()]
        .filter(
          (record) =>
            record.repository === completion.repository &&
            record.number === completion.number &&
            record.source_comment_id === completion.source_comment_id &&
            record.triggered_at &&
            !record.completed_at &&
            Date.parse(record.triggered_at) <= Date.parse(completion.completed_at),
        )
        .sort(
          (left, right) =>
            (Date.parse(String(right.triggered_at || "")) || 0) -
            (Date.parse(String(left.triggered_at || "")) || 0),
        )[0] ||
      [...records.values()].find(
        (record) =>
          record.repository === completion.repository &&
          record.number === completion.number &&
          record.source_comment_id === completion.source_comment_id &&
          record.completion_comment_id === completion.completion_comment_id &&
          record.completed_at === completion.completed_at,
      ) ||
      records.get(completion.id) ||
      {};
    const recordId = current.id || completion.id;
    const currentCompletedAt = Date.parse(String(current.completed_at || ""));
    const completionAt = Date.parse(completion.completed_at);
    if (Number.isFinite(currentCompletedAt) && currentCompletedAt > completionAt) continue;
    if (current.id && current.id !== recordId) records.delete(current.id);
    records.set(recordId, {
      ...current,
      ...completion,
      id: recordId,
      completed_at: completion.completed_at,
      completion_kind: completion.completion_kind,
      completion_comment_id: completion.completion_comment_id,
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
  const activeKeys = new Set(
    (Array.isArray(activeItemKeys) ? activeItemKeys : []).map((value) => String(value)),
  );
  const buffer = Array.isArray(source.terminal_buffer)
    ? source.terminal_buffer.filter(
        (item) => item?.event_id && item?.item_key && !activeKeys.has(String(item.item_key)),
      )
    : [];
  const seenEvents = Array.isArray(source.seen_events)
    ? source.seen_events.filter((item) => item?.event_id)
    : [];
  const seenIds = new Set(seenEvents.map((item) => item.event_id));
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
    washedAt = generatedAt;
    lastTideAt = generatedAt;
    tideGeneration += 1;
  }

  return {
    schema_version: 1,
    tide_threshold: BAY_TIDE_THRESHOLD,
    tide_generation: tideGeneration,
    last_tide_at: lastTideAt,
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
    terminal_count: state?.terminal_count,
    terminal_buffer: state?.terminal_buffer,
    washed_at: state?.washed_at,
    recently_washed: state?.recently_washed,
    seen_events: state?.seen_events,
  });
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

function isCodexWorkflowFallback(run) {
  const name = `${run?.name || ""} ${run?.display_title || ""}`;
  if (
    /repair comment router|clawsweeper_comment|@publish:|publish exact review artifact|exact.review publication|reconcile exact.review lease|sync codex review comments/i.test(
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
    const lane = /@publish:|publish exact review artifact|exact.review publication/i.test(name)
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
      "x-robots-tag": "noindex, nofollow, noarchive",
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

function dashboardThemeInitScript() {
  return `<script>
(() => {
  const themeKey = "clawsweeper-theme";
  const themeChoices = new Set(["system", "light", "dark"]);
  const themeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const themeColor = { light: "#f6f3ec", dark: "#141110" };
  let themeChoice = "system";
  try {
    const saved = window.localStorage?.getItem(themeKey);
    if (themeChoices.has(saved)) themeChoice = saved;
  } catch {}
  const active = themeChoice === "system" && themeQuery?.matches ? "dark" : themeChoice === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = active;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[active]);
})();
</script>`;
}

function dashboardThemeCss() {
  return `
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
.theme-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}
.theme-control > span {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.theme-options {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.theme-options button {
  appearance: none;
  min-width: 48px;
  min-height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.theme-options button:hover {
  color: var(--text);
}
.theme-options button[aria-pressed="true"] {
  color: var(--claw);
  background: color-mix(in srgb, var(--claw) 10%, transparent);
}
`;
}

function dashboardThemeControlHtml() {
  return `<div class="theme-control" aria-label="Theme">
        <span>Theme</span>
        <div class="theme-options" role="group" aria-label="Theme preference">
          <button type="button" data-theme-choice="system" aria-pressed="true">System</button>
          <button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
          <button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
        </div>
      </div>`;
}

function dashboardThemeControlScript() {
  return `(() => {
  const themeKey = "clawsweeper-theme";
  const themeChoices = new Set(["system", "light", "dark"]);
  const themeColor = { light: "#f6f3ec", dark: "#141110" };
  const themeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const themeButtons = document.querySelectorAll("[data-theme-choice]");
  const readThemeChoice = () => {
    try {
      const saved = window.localStorage?.getItem(themeKey);
      return themeChoices.has(saved) ? saved : "system";
    } catch {
      return "system";
    }
  };
  let themeChoice = readThemeChoice();
  const activeTheme = () => themeChoice === "system" && themeQuery?.matches ? "dark" : themeChoice === "dark" ? "dark" : "light";
  const applyTheme = () => {
    const active = activeTheme();
    document.documentElement.dataset.theme = active;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[active]);
    themeButtons.forEach(button => {
      const selected = button.dataset.themeChoice === themeChoice;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  };
  themeButtons.forEach(button => button.addEventListener("click", () => {
    const choice = button.dataset.themeChoice;
    if (!themeChoices.has(choice)) return;
    themeChoice = choice;
    try {
      window.localStorage?.setItem(themeKey, choice);
    } catch {}
    applyTheme();
  }));
  const updateSystemTheme = () => {
    if (themeChoice === "system") applyTheme();
  };
  if (typeof themeQuery?.addEventListener === "function") {
    themeQuery.addEventListener("change", updateSystemTheme);
  } else {
    themeQuery?.addListener?.(updateSystemTheme);
  }
  applyTheme();
})();`;
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
<meta name="theme-color" content="#f6f3ec">
<title>${escapeHtml(config.title)}</title>
${dashboardThemeInitScript()}
<style>
:root {
  color-scheme: light dark;
  --bg: light-dark(#f6f3ec, #141110);
  --panel: light-dark(#fffefa, #1c1916);
  --line: light-dark(#e6dfd2, #2d2822);
  --line-soft: light-dark(#eee8dd, #262019);
  --text: light-dark(#211c15, #ece5da);
  --muted: light-dark(#857a69, #988b7b);
  --claw: light-dark(#d94a26, #ff6f48);
  --green: light-dark(#31824f, #5cc088);
  --amber: light-dark(#b3831d, #dcaf5e);
  --red: light-dark(#c03d33, #ef685c);
  --violet: light-dark(#6b59c8, #a893f0);
}
* { box-sizing: border-box; }
html { scrollbar-color: light-dark(#cfc6b6, #3a332b) transparent; }
${dashboardThemeCss()}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--claw);
  z-index: 10;
}
::selection { background: color-mix(in srgb, var(--claw) 22%, transparent); }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--claw) 60%, transparent); outline-offset: 2px; }
main { width: min(1560px, calc(100vw - 48px)); margin: 0 auto; padding: 34px 0 72px; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
header h1 + .muted { margin-top: 6px; font-size: 12px; }
h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 9px;
}
h1::before { content: "🦞"; font-size: 20px; }
h2 {
  margin: 32px 0 12px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
h2::before { content: ""; flex: 0 0 auto; width: 14px; height: 2px; border-radius: 1px; background: var(--claw); }
a { color: var(--claw); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.top-links { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.top-link { color: var(--muted); font-size: 12.5px; font-weight: 500; }
.top-link:hover { color: var(--claw); text-decoration: none; }
#updated { font-size: 11px; }
.pill,
.tab,
.query-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 2px 10px;
  border-radius: 999px;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.pill:hover,
.tab:hover,
.query-link:hover { border-color: color-mix(in srgb, var(--claw) 45%, var(--line)); color: var(--text); }
a.pill:hover,
.query-link:hover { color: var(--claw); text-decoration: none; }
.query-link { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 35%, transparent); }
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 24px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.metric { padding: 16px 18px 14px; border-left: 1px solid var(--line-soft); min-width: 0; overflow: hidden; }
.metric:first-child { border-left: 0; padding-left: 0; }
.metric strong { display: block; margin-top: 9px; font-size: 28px; font-weight: 560; line-height: 1; letter-spacing: -0.03em; }
.metric span { color: var(--muted); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
.metric .muted { font-size: 12px; margin-top: 4px; }
.tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 14px;
  padding-bottom: 10px;
}
button.tab {
  cursor: pointer;
  font: inherit;
}
button.tab[aria-selected="true"] {
  color: var(--claw);
  border-color: color-mix(in srgb, var(--claw) 55%, transparent);
  background: color-mix(in srgb, var(--claw) 8%, transparent);
}
.view-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin: 14px 0;
}
.view-title { display: grid; gap: 3px; min-width: 0; }
.view-title strong { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.controls {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 14px;
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
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
input,
select,
.secondary-button {
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 6px 10px;
  font: inherit;
}
input { min-width: min(460px, calc(100vw - 48px)); }
select { min-width: 190px; }
input::placeholder { color: var(--muted); }
input:focus,
select:focus,
.secondary-button:focus {
  outline: 2px solid color-mix(in srgb, var(--claw) 55%, transparent);
  outline-offset: 1px;
}
.secondary-button {
  cursor: pointer;
  min-width: 70px;
  font-weight: 600;
  color: var(--muted);
  transition: border-color 0.15s ease, color 0.15s ease;
}
.secondary-button:hover { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 45%, var(--line)); }
.table-wrap {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
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
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  vertical-align: top;
}
th {
  position: relative;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  background: transparent;
  font-weight: 600;
  letter-spacing: 0.1em;
  border-bottom-color: var(--line);
}
tbody tr:hover { background: color-mix(in srgb, var(--claw) 3%, transparent); }
tr:last-child td { border-bottom: 0; }
.issue-cell { display: grid; gap: 4px; min-width: 0; }
.issue-title {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
  font-weight: 600;
  color: var(--text);
}
.issue-title:hover { color: var(--claw); }
.label-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.assignee-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.pr-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.label-pill,
.priority-filter {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.label-pill.dot::before {
  content: "";
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--label-color, transparent);
}
.label-pill.clawsweeper,
.label-pill.highlight { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 40%, transparent); }
.label-pill:hover,
.priority-filter:hover {
  border-color: color-mix(in srgb, var(--claw) 55%, transparent);
  color: var(--claw);
}
.priority-filter {
  border-color: color-mix(in srgb, var(--amber) 45%, transparent);
  background: color-mix(in srgb, var(--amber) 8%, transparent);
  color: var(--amber);
}
.assignee-pill {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--violet) 40%, transparent);
  background: color-mix(in srgb, var(--violet) 7%, transparent);
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
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.pr-chip.open { border-color: color-mix(in srgb, var(--green) 45%, transparent); color: var(--green); }
.pr-chip.merged { border-color: color-mix(in srgb, var(--violet) 45%, transparent); color: var(--violet); }
.pr-chip.closed { border-color: color-mix(in srgb, var(--red) 45%, transparent); color: var(--red); }
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
  background: color-mix(in srgb, var(--claw) 55%, transparent);
}
body.resizing-col {
  cursor: col-resize;
  user-select: none;
}
.priority { color: var(--amber); }
.empty,
.error {
  padding: 26px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 12px;
  text-align: center;
}
.empty::before { content: "🦞 "; opacity: 0.5; }
.error { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
@media (max-width: 1280px) {
  .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .metric:nth-child(3n + 1) { border-left: 0; padding-left: 0; }
  header, .view-head { align-items: start; flex-direction: column; }
  .top-links { justify-content: flex-start; }
}
@media (max-width: 760px) {
  main { width: min(100vw - 24px, 1560px); padding-top: 20px; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .grid { grid-template-columns: 1fr; }
}
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
      ${config.links.map((link) => `<a class="top-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")}
      ${dashboardThemeControlHtml()}
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
${dashboardThemeControlScript()}
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
  const style = color ? ' style="--label-color: ' + esc(color) + ';"' : '';
  const highlighted = (PAGE.highlightLabelPrefixes || []).some(prefix => name.startsWith(prefix));
  const cls = (highlighted ? "label-pill highlight" : "label-pill") + (color ? " dot" : "");
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
<meta name="theme-color" content="#f6f3ec">
${dashboardThemeInitScript()}
<title>🦞 ClawSweeper Live</title>
<style>
:root {
  color-scheme: light dark;
  --bg: light-dark(#f6f3ec, #141110);
  --panel: light-dark(#fffefa, #1c1916);
  --line: light-dark(#e6dfd2, #2d2822);
  --line-soft: light-dark(#eee8dd, #262019);
  --track: light-dark(#ebe4d7, #2b2620);
  --text: light-dark(#211c15, #ece5da);
  --muted: light-dark(#857a69, #988b7b);
  --claw: light-dark(#d94a26, #ff6f48);
  --green: light-dark(#31824f, #5cc088);
  --amber: light-dark(#b3831d, #dcaf5e);
  --red: light-dark(#c03d33, #ef685c);
  --violet: light-dark(#6b59c8, #a893f0);
}
* { box-sizing: border-box; }
html { scrollbar-color: light-dark(#cfc6b6, #3a332b) transparent; }
${dashboardThemeCss()}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--claw);
  z-index: 10;
}
::selection { background: color-mix(in srgb, var(--claw) 22%, transparent); }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--claw) 60%, transparent); outline-offset: 2px; }
main { width: min(1280px, calc(100vw - 48px)); margin: 0 auto; padding: 26px 0 72px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 9px;
}
h1::before { content: "🦞"; font-size: 18px; }
.live-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--claw) 45%, transparent);
  border-radius: 999px;
  color: var(--claw);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.live-tag::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--claw);
  animation: heartbeat 2.4s ease-in-out infinite;
}
@keyframes heartbeat {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
.top-links { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.top-link { color: var(--muted); font-size: 12.5px; font-weight: 500; }
.top-link:hover { color: var(--claw); text-decoration: none; }
#updated { font-size: 11px; }
.hero { margin: 44px 0 10px; }
.hero-headline {
  display: flex;
  align-items: center;
  gap: 14px;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  font-size: 38px;
  font-weight: 500;
  line-height: 1.12;
  letter-spacing: -0.015em;
  text-wrap: balance;
}
.hero-dot {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--muted) 50%, transparent);
}
.hero-dot.ok { background: var(--green); box-shadow: 0 0 0 5px color-mix(in srgb, var(--green) 14%, transparent); }
.hero-dot.amber { background: var(--amber); box-shadow: 0 0 0 5px color-mix(in srgb, var(--amber) 16%, transparent); }
.hero-dot.red { background: var(--red); box-shadow: 0 0 0 5px color-mix(in srgb, var(--red) 16%, transparent); }
.hero > .muted { margin-top: 10px; font-size: 12.5px; }
h2 {
  margin: 44px 0 12px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
h2::before { content: ""; flex: 0 0 auto; width: 14px; height: 2px; border-radius: 1px; background: var(--claw); }
.muted { color: var(--muted); }
.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 30px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.metric { padding: 18px 20px 16px; border-left: 1px solid var(--line-soft); min-width: 0; }
.metric:first-child { border-left: 0; padding-left: 0; }
.metric span { color: var(--muted); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
.metric strong { display: block; margin-top: 10px; font-size: 30px; font-weight: 560; line-height: 1; letter-spacing: -0.03em; }
.metric > div.muted { margin-top: 4px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.band { width: 54px; height: 2px; margin-top: 12px; background: var(--track); border-radius: 999px; overflow: hidden; }
.band > i { display: block; height: 100%; border-radius: 999px; background: var(--claw); width: 0; transition: width 0.6s ease; }
.exact-review-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 22px; }
.exact-review-head .overview-section-title { margin: 0; }
.trend-ranges { display: flex; gap: 6px; }
.trend-range {
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.trend-range.active { color: var(--text); border-color: var(--claw); }
.execution-alert { margin-top: 24px; border: 1px solid color-mix(in srgb, var(--amber) 48%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--amber) 7%, var(--panel)); }
.execution-alert summary { display: flex; justify-content: space-between; gap: 16px; padding: 13px 15px; cursor: pointer; list-style: none; }
.execution-alert summary::-webkit-details-marker { display: none; }
.execution-alert-title { display: grid; gap: 4px; }
.execution-alert-title strong { font-size: 13px; }
.execution-alert-title span, .execution-alert-toggle, .execution-alert-body { color: var(--muted); font-size: 11px; }
.execution-alert-body { padding: 0 15px 13px; }
.exact-trend { margin: 14px 0 16px; }
.exact-trend-status { font-size: 12px; font-weight: 650; }
.exact-trend-status.growing { color: var(--amber); }
.exact-trend-status.draining { color: var(--green); }
.exact-trend-status.catching-up { color: var(--green); }
.exact-trend-status.falling-behind { color: var(--amber); }
.exact-trend-status.stable,
.exact-trend-status.collecting,
.exact-trend-status.stale { color: var(--muted); }
.exact-trend-svg { display: block; width: 100%; height: 150px; margin-top: 6px; overflow: visible; }
.trend-grid-line { stroke: var(--line-soft); stroke-width: 1; }
.trend-grid-line.lane-speed-zero { stroke: var(--muted); }
.trend-axis-label { fill: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; }
.exact-trend-line { fill: none; stroke: var(--claw); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.exact-trend-point { fill: var(--claw); }
.lane-speed { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.lane-speed .exact-trend-status { margin-top: 4px; }
.lane-speed-line { fill: none; stroke: var(--violet); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.lane-speed-point { fill: var(--violet); }
.trend-empty { display: grid; place-items: center; height: 130px; color: var(--muted); font-size: 12px; }
.overview-shell { margin: 0; padding: 0; border: 0; background: transparent; }
.overview-head,
.automatic-head,
.workers-head,
.worker-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.overview-head,
.automatic-head,
.workers-head { margin-top: 44px; }
.overview-head h2,
.automatic-head h2,
.workers-head h2 { margin: 0; }
.overview-head .muted,
.automatic-head .muted,
.workers-head .muted,
.worker-toolbar .muted { font-size: 12px; }
.flow-map {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 28px;
  margin-top: 26px;
}
.flow-node { position: relative; min-width: 0; padding-top: 18px; }
.flow-node::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: -28px;
  height: 2px;
  background: var(--line);
}
.flow-node:last-child::before { right: 0; }
.flow-node::after {
  content: "";
  position: absolute;
  top: -3px;
  left: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--claw);
}
.flow-node span {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.flow-node strong {
  display: block;
  margin-top: 7px;
  font-size: 26px;
  font-weight: 560;
  letter-spacing: -0.02em;
  line-height: 1;
}
.flow-node p {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.capacity-rail { margin-top: 30px; }
.overview-section-title {
  margin: 28px 0 0;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.capacity-bar {
  display: flex;
  height: 10px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.capacity-bar i { display: block; height: 100%; }
.capacity-bar .active { background: var(--claw); }
.capacity-bar .waiting { background: var(--amber); }
.capacity-meta { margin-top: 8px; color: var(--muted); font-size: 12px; }
.capacity-note { margin-top: 5px; color: var(--muted); font-size: 11px; }
.exact-lanes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 10px;
}
.exact-lane {
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.exact-lane-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.exact-lane-head strong { font-size: 13px; }
.exact-lane-head span { color: var(--muted); font-size: 11px; }
.lane-counts { display: grid; gap: 6px; margin-top: 12px; }
.lane-count { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 11px; }
.exact-lane > .lane-count { margin-top: 14px; }
.lane-count strong { color: var(--text); font-weight: 600; }
.lane-bar { height: 6px; margin-top: 12px; overflow: hidden; border-radius: 999px; background: var(--track); }
.lane-bar i { display: block; height: 100%; background: var(--claw); }
.lane-foot { margin-top: 7px; color: var(--muted); font-size: 11px; }
.exact-handoff {
  margin-top: 18px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.exact-handoff-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}
.exact-handoff-title { display: grid; gap: 3px; }
.exact-handoff-title strong { font-size: 13px; font-weight: 650; }
.exact-handoff-title span { color: var(--muted); font-size: 12px; }
.health-badge {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.health-badge.healthy,
.health-badge.idle { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.health-badge.degraded { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent); }
.health-badge.stalled { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.handoff-phases {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--line-soft);
}
.handoff-phase { padding: 11px 12px; background: var(--bg); }
.handoff-phase span {
  display: block;
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.handoff-phase strong { display: block; margin-top: 4px; font-size: 21px; font-weight: 560; line-height: 1; }
.handoff-phase small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
.handoff-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: var(--muted);
  font-size: 11px;
}
.status-dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--muted) 50%, transparent);
}
.status-dot.active { background: var(--claw); }
.status-dot.waiting { background: var(--amber); }
.status-dot.done { background: var(--green); }
.status-dot.failed { background: var(--red); }
.apply-health-alert {
  display: grid;
  gap: 8px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--amber) 45%, transparent);
  border-left: 3px solid var(--amber);
  border-radius: 10px;
  background: color-mix(in srgb, var(--amber) 7%, transparent);
}
.apply-health-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.apply-health-heading strong { color: var(--amber); }
.apply-health-alert p { margin: 0; color: var(--muted); font-size: 13px; }
.apply-health-next strong { color: var(--text); }
.apply-health-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.apply-health-meta .pill {
  min-height: 21px;
  padding: 1px 8px;
  font-size: 11px;
}
.apply-health-reason { cursor: help; }
.apply-health-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
}
.apply-health-command {
  min-width: 0;
  padding: 6px 9px;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: normal;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  line-height: 1.45;
  font-size: 12px;
}
.apply-health-copy { min-height: 27px; }
@media (max-width: 740px) {
  .apply-health-action { grid-template-columns: 1fr; }
}
.worker-toolbar { margin-top: 12px; }
.worker-filters {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  overflow: hidden;
}
.filter-button {
  appearance: none;
  border: 0;
  border-left: 1px solid var(--line-soft);
  padding: 5px 13px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.filter-button:first-child { border-left: 0; }
.filter-button:hover { color: var(--text); }
.filter-button.active {
  color: var(--claw);
  background: color-mix(in srgb, var(--claw) 8%, transparent);
}
.worker-list {
  margin-top: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.worker-row {
  appearance: none;
  display: block;
  width: 100%;
  padding: 11px 16px 12px;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.worker-row:last-child { border-bottom: 0; }
.worker-row:hover,
.worker-row:focus-visible { background: color-mix(in srgb, var(--claw) 3%, transparent); outline: none; }
.worker-row-main {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1.1fr) minmax(0, 1.5fr) auto;
  gap: 12px;
  align-items: center;
}
.automatic-row .worker-row-main { grid-template-columns: auto auto minmax(0, 1fr) auto; }
.worker-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13.5px;
}
.worker-step {
  color: var(--claw);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-step::before { content: "↳ "; }
.worker-time { color: var(--muted); font-size: 12px; text-align: right; white-space: nowrap; }
.worker-row-sub {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
  padding-left: 19px;
}
.worker-target-ref { color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.worker-target-title {
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-progress {
  width: 64px;
  height: 2px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.worker-progress i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--claw);
}
dialog {
  width: min(680px, calc(100vw - 28px));
  max-height: calc(100vh - 28px);
  margin: 14px 14px 14px auto;
  padding: 0;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 24px 70px light-dark(rgba(48, 34, 22, 0.2), rgba(0, 0, 0, 0.6));
}
dialog::backdrop {
  background: light-dark(rgba(52, 40, 28, 0.32), rgba(0, 0, 0, 0.55));
  backdrop-filter: blur(4px);
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
}
.drawer-head h3 {
  margin: 9px 0 0;
  font-size: 19px;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.drawer-head .pill { margin-right: 4px; }
.drawer-close {
  appearance: none;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  font-size: 16px;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.drawer-close:hover {
  color: var(--claw);
  border-color: color-mix(in srgb, var(--claw) 45%, var(--line));
}
.drawer-body {
  min-height: 0;
  padding: 20px;
  overflow: auto;
}
.drawer-body h2 { margin: 26px 0 10px; }
.drawer-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.drawer-stat {
  padding: 11px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--bg);
}
.drawer-stat span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
.drawer-stat strong {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
  font-weight: 600;
}
.drawer-links { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.drawer-links .filter-button { border: 1px solid var(--line); border-radius: 999px; }
.step-list {
  display: grid;
  gap: 0;
  margin: 10px 0 0;
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
  border-bottom: 1px solid var(--line-soft);
}
.step-row:last-child { border-bottom: 0; }
.step-mark {
  width: 8px;
  height: 8px;
  border: 2px solid color-mix(in srgb, var(--muted) 55%, transparent);
  border-radius: 50%;
}
.step-row.completed .step-mark { border-color: var(--green); background: var(--green); }
.step-row.in_progress .step-mark {
  border-color: var(--claw);
  background: var(--claw);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--claw) 15%, transparent);
}
.step-row.queued .step-mark,
.step-row.pending .step-mark,
.step-row.waiting .step-mark { border-color: var(--amber); }
.step-row strong { font-size: 12.5px; font-weight: 550; }
.step-row span { color: var(--muted); font-size: 11px; }
table {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; }
td { overflow-wrap: anywhere; }
th {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  background: transparent;
  font-weight: 600;
  letter-spacing: 0.1em;
  border-bottom-color: var(--line);
}
tbody tr { transition: background-color 0.15s ease; }
tbody tr:hover { background: color-mix(in srgb, var(--claw) 3%, transparent); }
tr:last-child td { border-bottom: 0; }
a { color: var(--claw); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 2px 10px;
  border-radius: 999px;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.pill:hover { border-color: color-mix(in srgb, var(--claw) 45%, var(--line)); color: var(--text); }
a.pill:hover { color: var(--claw); text-decoration: none; }
.green { color: var(--green); }
.amber { color: var(--amber); }
.red { color: var(--red); }
.violet { color: var(--violet); }
.pill.green { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill.amber { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
.pill.red { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.pill.violet { color: var(--violet); border-color: color-mix(in srgb, var(--violet) 40%, transparent); }
.run-link { color: var(--claw); }
.pill.run-link { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 35%, transparent); }
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 390px);
  gap: 32px;
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
  border-radius: 10px;
}
.work-list,
.side-list {
  display: block;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.work-row,
.side-row {
  display: grid;
  gap: 12px;
  min-width: 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  transition: background-color 0.15s ease;
}
.work-row:last-child,
.side-row:last-child { border-bottom: 0; }
.work-row {
  grid-template-columns: minmax(0, 1fr) minmax(200px, 250px) 74px;
  align-items: center;
  padding: 11px 14px;
}
.cluster-marker-row {
  grid-template-columns: minmax(0, 1fr) minmax(200px, 250px);
}
.side-row {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  padding: 10px 12px;
}
.work-row:hover,
.side-row:hover { background: color-mix(in srgb, var(--claw) 3%, transparent); }
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
.stage-block strong { font-size: 13px; font-weight: 600; }
.timebox {
  display: grid;
  justify-items: end;
  gap: 2px;
  white-space: nowrap;
}
.timebox strong {
  font-size: 15px;
  font-weight: 620;
  line-height: 1;
  letter-spacing: -0.01em;
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
  margin-bottom: 10px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.closed-stat {
  padding: 12px 14px 12px;
  border-left: 1px solid var(--line-soft);
  min-width: 0;
}
.closed-stat:first-child { border-left: 0; padding-left: 0; }
.closed-stat span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
.closed-stat strong {
  display: block;
  margin-top: 6px;
  font-size: 22px;
  font-weight: 560;
  letter-spacing: -0.02em;
  line-height: 1;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.empty {
  padding: 26px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 10px;
  text-align: center;
}
.empty::before { content: "🦞 "; opacity: 0.5; }
@media (max-width: 1280px) {
  .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .metric { padding: 16px 18px 14px; }
  .metric:nth-child(3n + 1) { border-left: 0; padding-left: 0; }
  .split { grid-template-columns: 1fr; }
  .left-col { order: 1; }
  .side-col { order: 2; }
  .cluster-col-desktop { display: none; }
  .cluster-col-mobile { display: block; order: 3; }
  header { align-items: start; flex-direction: column; }
  .top-links { justify-content: flex-start; }
}
@media (max-width: 900px) {
  .hero-headline { font-size: 28px; }
  .flow-map { grid-template-columns: 1fr; gap: 16px; }
  .flow-node { padding-top: 0; padding-left: 20px; }
  .flow-node::before { display: none; }
  .flow-node::after { top: 5px; }
}
@media (max-width: 760px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric:nth-child(3n + 1) { border-left: 1px solid var(--line-soft); padding-left: 18px; }
  .metric:nth-child(2n + 1) { border-left: 0; padding-left: 0; }
  .worker-row-main { grid-template-columns: auto auto minmax(0, 1fr) auto; }
  .worker-step { display: none; }
  .work-row { grid-template-columns: 1fr; align-items: start; }
  .work-state, .stage-block, .timebox { justify-content: start; justify-items: start; }
  .worker-toolbar { align-items: stretch; flex-direction: column; }
}
@media (max-width: 560px) {
  main { width: min(100vw - 24px, 1280px); padding-top: 18px; }
  .hero { margin-top: 30px; }
  .hero-headline { font-size: 23px; gap: 10px; }
  .hero-dot { width: 10px; height: 10px; }
  .exact-review-head { align-items: flex-start; flex-direction: column; }
  .grid, .drawer-grid { grid-template-columns: 1fr; }
  .metric, .metric:nth-child(3n + 1) { border-left: 0; border-top: 1px solid var(--line-soft); padding-left: 0; }
  .metric:first-child { border-top: 0; }
  .closed-stats { grid-template-columns: 1fr; }
  .closed-stat { border-left: 0; border-top: 1px solid var(--line-soft); padding-left: 0; }
  .closed-stat:first-child { border-top: 0; }
  .side-row { grid-template-columns: 1fr; }
  .side-meta { justify-content: flex-start; }
  .worker-row-sub { grid-template-columns: auto minmax(0, 1fr); }
  .worker-progress { display: none; }
  .exact-handoff-head, .handoff-foot { align-items: start; flex-direction: column; }
  .handoff-phases { grid-template-columns: 1fr; }
  .exact-lanes { grid-template-columns: 1fr; }
  dialog { margin: 7px; max-height: calc(100vh - 14px); }
}
</style>
</head>
<body>
<main>
  <header>
    <h1>ClawSweeper <span class="live-tag">Live</span></h1>
    <div class="top-links">
      <a class="top-link" href="/triage">Issue triage</a>
      <a class="top-link" href="/pr-proof-triage">PR proof triage</a>
      <a class="top-link" href="${escapeHtml(crabfleetUrl)}">Live terminals</a>
      ${dashboardThemeControlHtml()}
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="hero">
    <div class="hero-headline"><span class="hero-dot" id="hero-dot"></span><span id="hero-headline">Loading pipeline state...</span></div>
    <div class="muted" id="subtitle"></div>
  </section>
  <section class="grid" id="metrics"></section>
  <section class="overview-shell" aria-labelledby="system-overview-title">
    <div class="overview-head">
      <h2 id="system-overview-title">System Overview</h2>
      <span class="muted" id="overview-note">Live GitHub workflow telemetry</span>
    </div>
    <div class="flow-map" id="flow-map"></div>
    <h3 class="overview-section-title">Codex Capacity</h3>
    <div class="capacity-rail" id="capacity-rail"></div>
    <div id="execution-alert" aria-live="polite"></div>
    <div class="exact-review-head">
      <h3 class="overview-section-title">Exact Review</h3>
      <div class="trend-ranges" id="trend-ranges" aria-label="Exact Review backlog history range">
        <button class="trend-range active" type="button" data-trend-range="6h">6 hours</button>
        <button class="trend-range" type="button" data-trend-range="24h">24 hours</button>
        <button class="trend-range" type="button" data-trend-range="7d">7 days</button>
      </div>
    </div>
    <div class="exact-lanes" id="exact-review-lanes" aria-live="polite"></div>
    <h3 class="overview-section-title">Handoff Health</h3>
    <div id="exact-review-handoff" aria-live="polite"></div>
    <div id="apply-health"></div>
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
        <h2>Active Pipeline</h2>
        <div id="pipeline"></div>
      </div>
      <div class="cluster-col cluster-col-desktop">
        <h2>Cluster Intake</h2>
        <div class="cluster-repair"></div>
      </div>
    </div>
    <aside class="side-col">
      <h2>Automerge Speed</h2>
      <div id="automerge"></div>
      <h2>Closed by ClawSweeper</h2>
      <div id="closed-stats"></div>
      <div id="closed"></div>
      <h2>Worker Health</h2>
      <div id="worker-health"></div>
      <h2>Operations</h2>
      <div id="operations"></div>
      <h2>Recent Activity</h2>
      <div id="events"></div>
    </aside>
    <div class="cluster-col cluster-col-mobile">
      <h2>Cluster Intake</h2>
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
${dashboardThemeControlScript()}
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
  return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><div class="muted">' + esc(sub || "") + '</div><div class="band"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%;background:' + (color || "var(--claw)") + '"></i></div></div>';
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
let activeHealthRange = "6h";
let healthHistoryLoadedAt = 0;
let healthHistorySamples = [];

function exactReviewHistory(lane) {
  return healthHistorySamples.flatMap(sample => {
    const laneSample = sample.exact_review?.collection_ok === true
      ? sample.exact_review?.[lane]
      : null;
    const pending = Number(laneSample?.pending);
    const enqueuedTotal = Number(laneSample?.enqueued_total);
    const completedTotal = Number(laneSample?.completed_total);
    const shedTotal = lane === "review" ? Number(laneSample?.shed_total || 0) : 0;
    const hasFlowCounters = Number.isFinite(enqueuedTotal) && Number.isFinite(completedTotal) && Number.isFinite(shedTotal);
    return Number.isFinite(Date.parse(sample.at)) && Number.isFinite(pending)
      ? [{
          at: sample.at,
          pending: Math.max(0, pending),
          ...(hasFlowCounters
            ? {
                enqueuedTotal: Math.max(0, enqueuedTotal),
                completedTotal: Math.max(0, completedTotal),
                shedTotal: Math.max(0, shedTotal)
              }
            : {})
        }]
      : [];
  });
}

function laneSpeedHistory(samples) {
  let segment = [];
  let previous = null;
  let segmentId = 0;
  return samples.flatMap(sample => {
    const at = Date.parse(sample.at);
    const hasFlowCounters =
      Number.isFinite(at) &&
      Number.isFinite(sample.enqueuedTotal) &&
      Number.isFinite(sample.completedTotal) &&
      Number.isFinite(sample.shedTotal);
    if (!hasFlowCounters) {
      // A legacy sample means the counter delta across this interval is
      // unknowable. Treat it as a boundary so the chart never bridges that
      // missing demand with a plausible-looking speed line.
      if (segment.length) segmentId += 1;
      segment = [];
      previous = null;
      return [];
    }
    const previousAt = previous ? Date.parse(previous.at) : null;
    const reset = previous && (
      at <= previousAt ||
      at - previousAt > 12 * 60 * 1000 ||
      sample.enqueuedTotal < previous.enqueuedTotal ||
      sample.completedTotal < previous.completedTotal ||
      sample.shedTotal < previous.shedTotal
    );
    if (reset) {
      segment = [];
      segmentId += 1;
    }
    previous = sample;
    segment.push(sample);
    const cutoff = at - 60 * 60 * 1000;
    const hourlyBaseline = segment.filter(candidate => Date.parse(candidate.at) <= cutoff).at(-1);
    const hasHourlyBaseline = hourlyBaseline && cutoff - Date.parse(hourlyBaseline.at) <= 12 * 60 * 1000;
    const baseline = hasHourlyBaseline ? hourlyBaseline : segment[0];
    const elapsedHours = (at - Date.parse(baseline.at)) / (60 * 60 * 1000);
    if (elapsedHours < 4 / 60) return [];
    const completed = sample.completedTotal - baseline.completedTotal;
    const incoming =
      sample.enqueuedTotal - baseline.enqueuedTotal + sample.shedTotal - baseline.shedTotal;
    return [{
      at: sample.at,
      rate: (completed - incoming) / elapsedHours,
      windowMinutes: elapsedHours * 60,
      provisional: !hasHourlyBaseline,
      segmentId
    }];
  });
}

function trendGeometry(samples, field, plot, maximum, fromAt, toAt) {
  if (!samples.length || maximum <= 0) return [];
  const span = Math.max(1, toAt - fromAt);
  let previousAt = null;
  return samples.flatMap(sample => {
    const at = Date.parse(sample.at);
    if (!Number.isFinite(at)) {
      previousAt = null;
      return [];
    }
    const x = plot.left + ((at - fromAt) / span) * plot.width;
    const y = plot.top + plot.height - (Math.max(0, Number(sample[field]) || 0) / maximum) * plot.height;
    const connected = previousAt !== null && at - previousAt <= 12 * 60 * 1000;
    previousAt = at;
    return [{ at, x, y, connected }];
  });
}

function trendPath(geometry) {
  return geometry.map(point => (point.connected ? "L" : "M") + point.x.toFixed(1) + " " + point.y.toFixed(1)).join(" ");
}

function niceTrendScale(maximum, tickCount) {
  const safeMaximum = Math.max(1, Number(maximum) || 0);
  const roughStep = safeMaximum / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = [1, 2, 2.5, 5, 10].find(candidate => normalized <= candidate) || 10;
  const step = factor * magnitude;
  return {
    maximum: step * tickCount,
    ticks: Array.from({ length: tickCount + 1 }, (_, index) => index * step),
  };
}

function niceSignedTrendScale(maximum) {
  const positive = niceTrendScale(Math.max(1, maximum), 2);
  const step = positive.maximum / 2;
  return {
    maximum: positive.maximum,
    ticks: [-positive.maximum, -step, 0, step, positive.maximum]
  };
}

function formatTrendValue(value) {
  return fmt.format(Math.round(value));
}

function formatSignedTrendValue(value) {
  const rounded = Math.round(value);
  if (rounded > 0) return "+" + fmt.format(rounded);
  if (rounded < 0) return "−" + fmt.format(Math.abs(rounded));
  return "0";
}

function speedTrendGeometry(samples, plot, maximum, fromAt, toAt) {
  if (!samples.length || maximum <= 0) return [];
  const span = Math.max(1, toAt - fromAt);
  let previous = null;
  return samples.map(sample => {
    const at = Date.parse(sample.at);
    const x = plot.left + ((at - fromAt) / span) * plot.width;
    const y = plot.top + ((maximum - sample.rate) / (maximum * 2)) * plot.height;
    const connected = previous !== null &&
      sample.segmentId === previous.segmentId &&
      at - previous.at <= 12 * 60 * 1000;
    const point = { at, x, y, connected, segmentId: sample.segmentId };
    previous = point;
    return point;
  });
}

function oneHourTrend(samples) {
  if (!samples.length) return { className: "collecting", label: "Collecting 1h trend" };
  const latest = samples.at(-1);
  const cutoff = Date.parse(latest.at) - 60 * 60 * 1000;
  const baseline = samples.filter(sample => Date.parse(sample.at) <= cutoff).at(-1);
  if (!baseline || cutoff - Date.parse(baseline.at) > 12 * 60 * 1000) {
    return { className: "collecting", label: "Collecting 1h trend" };
  }
  const delta = latest.pending - baseline.pending;
  if (delta > 0) return { className: "growing", label: "Growing · +" + fmt.format(delta) + " in the last hour" };
  if (delta < 0) return { className: "draining", label: "Draining · −" + fmt.format(Math.abs(delta)) + " in the last hour" };
  return { className: "stable", label: "Stable · no change in the last hour" };
}

function exactReviewTrend(samples, label) {
  if (!samples.length) {
    return '<div class="exact-trend"><div class="exact-trend-status collecting">Collecting 1h trend</div><div class="trend-empty">No backlog history in this range.</div></div>';
  }
  const width = 600;
  const height = 150;
  const plot = { left: 48, top: 8, width: 540, height: 110 };
  const rangeMs = activeHealthRange === "7d" ? 7 * 86400000 : activeHealthRange === "24h" ? 86400000 : 6 * 3600000;
  const latestAt = Date.parse(samples.at(-1).at);
  const toAt = Math.max(Date.now(), latestAt);
  const fromAt = toAt - rangeMs;
  const visible = samples.filter(sample => Date.parse(sample.at) >= fromAt && Date.parse(sample.at) <= toAt);
  const scale = niceTrendScale(Math.max(1, ...visible.map(sample => sample.pending)), 4);
  const grid = scale.ticks.map(value => {
    const y = plot.top + plot.height - value / scale.maximum * plot.height;
    return '<line class="trend-grid-line" x1="' + plot.left + '" x2="' + (plot.left + plot.width) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line><text class="trend-axis-label" x="' + (plot.left - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + esc(formatTrendValue(value)) + '</text>';
  }).join("");
  const geometry = trendGeometry(visible, "pending", plot, scale.maximum, fromAt, toAt);
  const points = geometry.map(point => '<circle class="exact-trend-point" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="3"></circle>').join("");
  const direction = oneHourTrend(visible);
  const rangeLabel = activeHealthRange === "7d" ? "7d ago" : activeHealthRange + " ago";
  const axis = '<text class="trend-axis-label" x="' + plot.left + '" y="' + (height - 7) + '">' + rangeLabel + '</text><text class="trend-axis-label" x="' + (plot.left + plot.width) + '" y="' + (height - 7) + '" text-anchor="end">now</text>';
  return '<div class="exact-trend"><div class="exact-trend-status ' + direction.className + '">' + esc(direction.label) + '</div><svg class="exact-trend-svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + esc(label + " pending backlog over " + activeHealthRange) + '">' + grid + '<path class="exact-trend-line" d="' + trendPath(geometry) + '"></path>' + points + axis + '</svg></div>';
}

function laneSpeedStatus(sample) {
  const rate = Math.round(sample.rate);
  const window = sample.provisional
    ? " · provisional " + fmt.format(Math.round(sample.windowMinutes)) + "m window"
    : "";
  if (rate > 0) return { className: "catching-up", label: "Catching up" + window };
  if (rate < 0) return { className: "falling-behind", label: "Falling behind" + window };
  return { className: "stable", label: "Balanced" + window };
}

function laneSpeedTrend(samples, speedLabel) {
  const rates = laneSpeedHistory(samples);
  const rangeMs = activeHealthRange === "7d" ? 7 * 86400000 : activeHealthRange === "24h" ? 86400000 : 6 * 3600000;
  const latestAt = rates.length ? Date.parse(rates.at(-1).at) : 0;
  const latestObservationAt = samples.length ? Date.parse(samples.at(-1).at) : 0;
  const hasLatestObservation = Number.isFinite(latestObservationAt) && latestObservationAt > 0;
  const latestSegmentNeedsBaseline = hasLatestObservation && latestObservationAt > latestAt;
  const toAt = Math.max(Date.now(), latestAt, hasLatestObservation ? latestObservationAt : 0);
  const latestObservationFresh =
    hasLatestObservation && toAt - latestObservationAt <= 12 * 60 * 1000;
  const collectingCurrentSegment = latestSegmentNeedsBaseline && latestObservationFresh;
  const fromAt = toAt - rangeMs;
  const visible = rates.filter(sample => Date.parse(sample.at) >= fromAt && Date.parse(sample.at) <= toAt);
  const latestVisible = visible.at(-1);
  const current =
    !latestSegmentNeedsBaseline &&
    latestVisible &&
    toAt - Date.parse(latestVisible.at) <= 12 * 60 * 1000
      ? latestVisible
      : null;
  const headline = current
    ? formatSignedTrendValue(current.rate) + " / hour"
    : collectingCurrentSegment
      ? "Collecting"
    : hasLatestObservation || visible.length
      ? "Stale"
      : "Collecting";
  if (!visible.length) {
    const emptyClass = headline === "Stale" ? "stale" : "collecting";
    const emptyLabel = headline === "Stale"
      ? "Stale · no speed sample in the last 12m"
      : "Needs two continuous five-minute samples";
    return '<div class="lane-speed"><div class="lane-count"><span>' + esc(speedLabel) + '</span><strong>' + headline + '</strong></div><div class="exact-trend-status ' + emptyClass + '">' + emptyLabel + '</div><div class="trend-empty">No speed history in this range.</div></div>';
  }
  const width = 600;
  const height = 150;
  const plot = { left: 48, top: 8, width: 540, height: 110 };
  const scale = niceSignedTrendScale(Math.max(1, ...visible.map(sample => Math.abs(sample.rate))));
  const grid = scale.ticks.map(value => {
    const y = plot.top + ((scale.maximum - value) / (scale.maximum * 2)) * plot.height;
    const className = value === 0 ? "trend-grid-line lane-speed-zero" : "trend-grid-line";
    return '<line class="' + className + '" x1="' + plot.left + '" x2="' + (plot.left + plot.width) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line><text class="trend-axis-label" x="' + (plot.left - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + esc(formatSignedTrendValue(value)) + '</text>';
  }).join("");
  const geometry = speedTrendGeometry(visible, plot, scale.maximum, fromAt, toAt);
  const points = geometry.map(point => '<circle class="lane-speed-point" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="3"></circle>').join("");
  const direction = current
    ? laneSpeedStatus(current)
    : collectingCurrentSegment
      ? { className: "collecting", label: "Needs two continuous five-minute samples" }
    : { className: "stale", label: "Stale · no speed sample in the last 12m" };
  const rangeLabel = activeHealthRange === "7d" ? "7d ago" : activeHealthRange + " ago";
  const axis = '<text class="trend-axis-label" x="' + plot.left + '" y="' + (height - 7) + '">' + rangeLabel + '</text><text class="trend-axis-label" x="' + (plot.left + plot.width) + '" y="' + (height - 7) + '" text-anchor="end">now</text>';
  return '<div class="lane-speed"><div class="lane-count"><span>' + esc(speedLabel) + '</span><strong>' + headline + '</strong></div><div class="exact-trend-status ' + direction.className + '">' + esc(direction.label) + '</div><svg class="exact-trend-svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + esc(speedLabel + ", completed minus incoming, over " + activeHealthRange) + '">' + grid + '<path class="lane-speed-line" d="' + trendPath(geometry) + '"></path>' + points + axis + '</svg></div>';
}

function renderExecutionAlert(current) {
  const target = document.getElementById("execution-alert");
  if (!target) return;
  const incomplete = !current || current.telemetry_complete !== true;
  const queued = Number(current?.queued_over_threshold) || 0;
  const running = Number(current?.running_over_threshold) || 0;
  if (!incomplete && queued === 0 && running === 0) {
    target.innerHTML = "";
    return;
  }
  const parts = [];
  if (queued) parts.push(fmt.format(queued) + " workflow" + (queued === 1 ? "" : "s") + " waiting for a runner over 30m");
  if (running) parts.push(fmt.format(running) + " execution" + (running === 1 ? "" : "s") + " over 150m");
  if (incomplete) parts.push("work execution telemetry is incomplete");
  const details = "Total GitHub queued " + fmt.format(Number(current?.queued_runs) || 0) + " · oldest queued " + formatAgeMinutes(current?.oldest_queued_minutes) + " · oldest running " + formatAgeMinutes(current?.oldest_running_minutes);
  target.innerHTML = '<details class="execution-alert"><summary><span class="execution-alert-title"><strong>⚠ Work execution needs attention</strong><span>' + esc(parts.join(" · ")) + '</span></span><span class="execution-alert-toggle">Details ▾</span></summary><div class="execution-alert-body">' + esc(details) + '</div></details>';
}

function formatAgeMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 90) return fmt.format(Math.round(minutes)) + "m";
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return fmt.format(hours) + "h" + (remainder ? " " + fmt.format(remainder) + "m" : "");
}

async function loadHealthHistory(range, force) {
  if (!force && range === activeHealthRange && Date.now() - healthHistoryLoadedAt < 60000) {
    renderExactReviewLanes(lastData?.exact_review_queue);
    return;
  }
  activeHealthRange = range;
  const requestedRange = range;
  try {
    const response = await fetch("/api/health-history?range=" + encodeURIComponent(range), { cache: "no-store" });
    if (!response.ok) throw new Error("history returned " + response.status);
    const payload = await response.json();
    if (requestedRange !== activeHealthRange) return;
    healthHistorySamples = Array.isArray(payload.samples) ? payload.samples : [];
    healthHistoryLoadedAt = Date.now();
  } catch {
    if (requestedRange !== activeHealthRange) return;
    healthHistorySamples = [];
  }
  renderExactReviewLanes(lastData?.exact_review_queue);
}

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
  const budget = Math.max(0, fleet.worker_budget || 0);
  const running = workers.filter(worker => worker.status === "in_progress").length;
  const waiting = workers.length - running;
  const free = Math.max(0, budget - running - waiting);
  const overflow = Math.max(0, running + waiting - budget);
  const share = value => budget ? Math.min(100, (value / budget) * 100) : 0;
  document.getElementById("capacity-rail").innerHTML =
    '<div class="capacity-bar"><i class="active" style="width:' + share(running) + '%"></i><i class="waiting" style="width:' + share(waiting) + '%"></i></div>' +
    '<div class="capacity-meta">' + fmt.format(running) + ' running · ' + fmt.format(waiting) + ' waiting · ' + fmt.format(free) + ' of ' + fmt.format(budget) + ' Codex slots free' + (overflow ? ' · ' + fmt.format(overflow) + ' over budget' : '') + '</div>' +
    '<div class="capacity-note">Only jobs that execute Codex count against this budget.</div>';
  const fallbacks = fleet.worker_detail_fallbacks || 0;
  document.getElementById("overview-note").textContent = fallbacks
    ? "Live jobs with " + fallbacks + " workflow fallback" + (fallbacks === 1 ? "" : "s")
    : "Live GitHub job and step telemetry";
}
function renderExactReviewLanes(queue) {
  const target = document.getElementById("exact-review-lanes");
  if (!target) return;
  const lanes = queue?.lanes;
  target.innerHTML = [["Review admission", "Review speed", "review", lanes?.review], ["Result publication", "Publication speed", "publication", lanes?.publication]].map(([label, speedLabel, laneKey, lane]) => {
    const samples = exactReviewHistory(laneKey);
    if (!lane) {
      const sampledAt = samples.at(-1)?.at;
      return '<div class="exact-lane"><div class="exact-lane-head"><strong>' + esc(label) + '</strong><span>Live snapshot unavailable</span></div>' +
        exactReviewTrend(samples, label) +
        laneSpeedTrend(samples, speedLabel) +
        '<div class="lane-foot">' + (sampledAt ? "Last sampled " + esc(since(sampledAt)) : "History starts with the next five-minute sample") + '</div></div>';
    }
    const capacity = Math.max(0, lane.capacity || 0);
    const active = Math.max(0, lane.active || 0);
    const used = capacity ? Math.min(100, (active / capacity) * 100) : 0;
    const oldest = Number.isFinite(lane.oldest_pending_age_seconds)
      ? " · oldest " + elapsed(lane.oldest_pending_age_seconds * 1000)
      : "";
    const publicationControl = laneKey === "publication" ? lane.capacity_control : null;
    const capacityNote = publicationControl?.mode === "throttled"
      ? " · adaptive ceiling " + fmt.format(publicationControl.ceiling || capacity) + " after " +
        (publicationControl.last_failure_kind === "github_rate_limit" ? "GitHub rate limit" : "GitHub 5xx")
      : laneKey === "publication"
        ? " · adaptive " + fmt.format(publicationControl?.base || 24) + "–" + fmt.format(publicationControl?.maximum || capacity)
        : "";
    return '<div class="exact-lane"><div class="exact-lane-head"><strong>' + esc(label) + '</strong><span>' + fmt.format(active) + ' of ' + fmt.format(capacity) + ' active</span></div>' +
      '<div class="lane-count"><span>Pending</span><strong>' + fmt.format(lane.pending || 0) + '</strong></div>' +
      exactReviewTrend(samples, label) +
      laneSpeedTrend(samples, speedLabel) +
      '<div class="lane-counts">' +
      '<div class="lane-count"><span>Ready</span><strong>' + fmt.format(lane.ready || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Backoff</span><strong>' + fmt.format(lane.backoff || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Dispatching</span><strong>' + fmt.format(lane.dispatching || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Leased</span><strong>' + fmt.format(lane.leased || 0) + '</strong></div></div>' +
      '<div class="lane-bar"><i style="width:' + used + '%"></i></div>' +
      '<div class="lane-foot">' + fmt.format(lane.available_slots || 0) + ' ' + esc(label.toLowerCase()) + ' slots open' + esc(oldest + capacityNote) + '</div></div>';
  }).join("");
}
function renderExactReviewHandoff(queue) {
  const target = document.getElementById("exact-review-handoff");
  if (!target) return;
  const health = queue?.handoff_health;
  if (!health?.phases) {
    target.innerHTML = '<div class="exact-handoff"><div class="exact-handoff-head"><div class="exact-handoff-title"><strong>Queue handoff health</strong><span>Queue telemetry unavailable in this snapshot.</span></div><span class="health-badge">unknown</span></div></div>';
    return;
  }
  const status = ["idle", "healthy", "degraded", "stalled"].includes(health.status) ? health.status : "unknown";
  const labels = {
    pending: ["Pending", "waiting for admission"],
    dispatching: ["Dispatching", "waiting for run claim"],
    leased: ["Leased", "run owns the review"]
  };
  const phases = ["pending", "dispatching", "leased"].map(phase => {
    const summary = health.phases[phase] || {};
    const age = Number.isFinite(summary.oldest_age_seconds)
      ? "oldest " + elapsed(summary.oldest_age_seconds * 1000)
      : "none waiting";
    return '<div class="handoff-phase"><span>' + esc(labels[phase][0]) + '</span><strong>' + fmt.format(summary.count || 0) + '</strong><small>' + esc(labels[phase][1] + " · " + age) + '</small></div>';
  }).join("");
  const slots = fmt.format(health.available_slots || 0) + " of " + fmt.format(health.capacity || 0) + " exact-review slots open";
  const threshold = "stalled after " + elapsed((health.stalled_after_seconds || 0) * 1000);
  target.innerHTML = '<div class="exact-handoff"><div class="exact-handoff-head"><div class="exact-handoff-title"><strong>Queue handoff health</strong><span>' + esc(health.message || "Queue phase telemetry") + '</span></div><span class="health-badge ' + esc(status) + '">' + esc(status) + '</span></div><div class="handoff-phases">' + phases + '</div><div class="handoff-foot"><span>' + esc(slots) + '</span><span>' + esc(threshold) + '</span></div></div>';
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
  document.getElementById("workers").innerHTML = '<div class="worker-list">' + visible.map(worker => {
    const progress = worker.progress?.total ? Math.round((worker.progress.completed / worker.progress.total) * 100) : 0;
    const kind = workerKindLabel(worker.work_kind);
    const targetTitle = workerTargetTitle(worker);
    return '<button type="button" class="worker-row" data-worker-id="' + esc(worker.id) + '" aria-label="Open details for ' + esc(targetTitle || worker.name) + '">' +
      '<div class="worker-row-main">' +
      '<i class="status-dot ' + workerStatusClass(worker.status) + '"></i>' +
      '<span class="pill">' + esc(modeLabel(worker.mode)) + (kind ? " · " + esc(kind) : "") + '</span>' +
      '<strong class="worker-name" title="' + esc(worker.name) + '">' + esc(worker.name) + '</strong>' +
      '<span class="worker-step">' + esc(worker.current_step || worker.stage) + '</span>' +
      '<span class="worker-time mono">' + elapsed(worker.elapsed_ms) + '</span>' +
      '</div>' +
      '<div class="worker-row-sub">' +
      '<span class="worker-target-ref mono">' + esc(workerTarget(worker)) + '</span>' +
      '<span class="worker-target-title" title="' + esc(targetTitle) + '">' + esc(targetTitle) + '</span>' +
      '<span class="worker-progress"><i style="width:' + progress + '%"></i></span>' +
      '</div>' +
      '</button>';
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
    '<div class="worker-list">' +
    rows.map(row => {
      const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
      return '<button type="button" class="worker-row automatic-row" data-automatic-id="' + esc(row.id) +
        '" aria-label="Open automatic build details for ' + esc(row.title) + '">' +
        '<div class="worker-row-main">' +
        '<i class="status-dot ' + workerStatusClass(row.status) + '"></i>' +
        '<span class="pill">' + esc(phase) + '</span>' +
        '<strong class="worker-name">' + esc(row.title || "Issue #" + row.issue_number) + '</strong>' +
        '<span class="worker-time mono">' + esc(row.updated_at ? since(row.updated_at) : "") + '</span>' +
        '</div>' +
        '<div class="worker-row-sub">' +
        '<span class="worker-target-ref mono">' + esc(row.repository + "#" + row.issue_number) + '</span>' +
        '<span class="worker-target-title">' + esc(row.pr_url ? "PR opened" : row.active ? "worker active" : row.status) + '</span>' +
        '</div>' +
        '</button>';
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
  loadHealthHistory(activeHealthRange, false).catch(() => undefined);
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
  const unresolved = data.health?.unresolved_failures || 0;
  const applyAttention = (data.recent?.apply_health?.items || []).filter(item =>
    applyHealthNeedsAttention(item.status)
  ).length;
  const handoffStatus = data.exact_review_queue?.handoff_health?.status;
  const handoffTelemetryFailed = Boolean(data.diagnostics?.exact_review_queue_error);
  const handoffAttention =
    handoffTelemetryFailed || handoffStatus === "degraded" || handoffStatus === "stalled";
  const operationalStatus = data.operational_health?.status;
  const operationalAttention = ["degraded", "stalled", "unknown"].includes(operationalStatus);
  const needsAttention = unresolved || applyAttention || handoffAttention || operationalAttention;
  const workerCount = (data.workers || []).length;
  const repoCount = (data.source.target_repositories || []).length;
  document.getElementById("hero-dot").className = "hero-dot " + (handoffStatus === "stalled" || operationalStatus === "stalled" ? "red" : needsAttention ? "amber" : "ok");
  document.getElementById("hero-headline").textContent =
    (needsAttention ? "Needs attention" : "All clear") + " — " +
    fmt.format(workerCount) + " claw worker" + (workerCount === 1 ? "" : "s") + " sweeping " +
    fmt.format(repoCount) + " " + (repoCount === 1 ? "repository" : "repositories");
  document.getElementById("subtitle").textContent = data.source.target_repositories.join(", ");
  document.getElementById("updated").textContent = "Updated " + since(data.generated_at) + (note ? " \u00b7 " + note : "");
  const fleet = data.fleet;
  document.getElementById("metrics").innerHTML = [
    metric("Codex Workers", fmt.format(fleet.active_codex_jobs), "Codex budget " + fleet.worker_budget, fleet.budget_used_percent, "var(--green)"),
    metric("Error Rate", (data.health?.error_rate_percent || 0) + "%", fmt.format(data.health?.failed_attempts || 0) + " failed / " + fmt.format(data.health?.attempts || 0) + " attempts", Math.min(100, data.health?.error_rate_percent || 0), data.health?.failed_attempts ? "var(--red)" : "var(--green)"),
    metric("Recovery Rate", data.health?.recovery_rate_percent == null ? "n/a" : data.health.recovery_rate_percent + "%", fmt.format(data.health?.unresolved_failures || 0) + " unresolved", data.health?.recovery_rate_percent == null ? 100 : data.health.recovery_rate_percent, data.health?.unresolved_failures ? "var(--amber)" : "var(--green)"),
    metric("Codex Capacity", fleet.budget_used_percent + "%", "Codex slot utilization", fleet.budget_used_percent, "var(--green)")
  ].join("");
  renderExecutionAlert(data.operational_health);
  renderSystemMap(data);
  renderExactReviewLanes(data.exact_review_queue);
  renderExactReviewHandoff(data.exact_review_queue);
  renderApplyHealth(data);
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
function renderApplyHealth(data) {
  const target = document.getElementById("apply-health");
  if (!target) return;
  const items = (data.recent?.apply_health?.items || []).filter(item => applyHealthNeedsAttention(item.status));
  if (!items.length) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = items.map(item => {
    const topReason = applyHealthPrimaryReason(item);
    const topInfo = applyHealthReasonInfo(topReason, item);
    const action = applyHealthRecommendedAction(item, topReason);
    const reasons = applyHealthReasonEntries(item)
      .slice(0, 4)
      .map(([reason, count]) => applyHealthReasonPill(reason, count, item))
      .join("");
    const showCursor = item.cursor_required || Boolean(item.cursor?.next_after_number);
    const buckets = applyHealthNextActionBucketPills(item);
    const cursor = item.cursor?.next_after_number ? "cursor #" + item.cursor.next_after_number : "cursor missing";
    const cursorTitle = item.cursor?.next_after_number
      ? "Rotation cursor was recorded; the next pruning run should continue after this item."
      : "No rotation cursor was recorded. If this was a full scan window, the next pruning run can repeat the same records.";
    const cursorPill = showCursor
      ? '<span class="pill" title="' + esc(cursorTitle) + '">' + esc(cursor) + '</span>'
      : "";
    const actionRecords = Number.isFinite(item.action_records)
      ? fmt.format(item.action_records)
      : Number.isFinite(item.processed)
        ? fmt.format(item.processed)
        : "unknown";
    const hasExamined = Number.isFinite(item.examined);
    const examined = hasExamined ? fmt.format(item.examined) : null;
    const activityLabel = hasExamined ? examined + " examined" : actionRecords + " actions";
    const activityTitle = hasExamined
      ? examined + " candidates examined; " + actionRecords + " produced action records."
      : actionRecords + " action records; candidate examined count unavailable for this lane.";
    const closed = Number.isFinite(item.closed) ? fmt.format(item.closed) : "unknown";
    const synced = Number.isFinite(item.comment_synced) ? fmt.format(item.comment_synced) : "unknown";
    const closureProcessed = Number.isFinite(item.lanes?.closure?.processed) ? fmt.format(item.lanes.closure.processed) : actionRecords;
    const syncProcessed = Number.isFinite(item.lanes?.comment_sync?.processed) ? fmt.format(item.lanes.comment_sync.processed) : actionRecords;
    const closureSynced = Number.isFinite(item.lanes?.closure?.comment_synced) ? fmt.format(item.lanes.closure.comment_synced) : "0";
    const syncLaneSynced = Number.isFinite(item.lanes?.comment_sync?.comment_synced) ? fmt.format(item.lanes.comment_sync.comment_synced) : "0";
    const cycle = applyHealthCyclePill(item.cycle);
    const candidateMix = applyHealthCandidateMixPill(item.cycle);
    return '<div class="apply-health-alert" role="status" title="' + esc(topInfo.summary + " Next: " + topInfo.action) + '">' +
      '<div class="apply-health-heading"><strong>Pruning sweep ' + esc(applyHealthStatusLabel(item.status)) + " - " + esc(item.target_repo || "target repo") + '</strong><span class="pill" title="' + esc("Latest " + applyHealthModeLabel(item.mode) + " status from the sweep-status marker.") + '">' + esc(applyHealthModeLabel(item.mode)) + '</span></div>' +
      '<p>' + esc(applyHealthOperatorSummary(item, topInfo)) + '</p>' +
      '<p class="apply-health-next"><strong>Next check:</strong> ' + esc(topInfo.action) + '</p>' +
      applyHealthActionHtml(action) +
      '<div class="apply-health-meta"><span class="pill" title="' + esc(activityTitle) + '">' + esc(activityLabel) + '</span><span class="pill" title="' + esc("Closure lane: " + closureProcessed + " action records; " + closed + " closed.") + '">' + esc(closed) + ' closed</span><span class="pill" title="' + esc("Durable review comments refreshed across lanes: " + synced + ". Closure lane refreshed " + closureSynced + "; comment-sync lane refreshed " + syncLaneSynced + " from " + syncProcessed + " action records.") + '">' + esc(synced) + ' comments synced</span>' + cycle + candidateMix + cursorPill + reasons + buckets + linkClass(item.run_url, "workflow run", "pill run-link") + '</div></div>';
  }).join("");
}
function applyHealthCyclePill(cycle) {
  if (!cycle || cycle.basis !== "scheduled_close_cursor") return "";
  const windows = Number(cycle.estimated_full_cycle_windows);
  const label = Number.isFinite(windows)
    ? "revisit ~" + fmt.format(windows) + " window" + (windows === 1 ? "" : "s")
    : "revisit estimate";
  return '<span class="pill" title="' + esc(cycle.label || "Estimated time to revisit the current apply-ready close queue.") + '">' + esc(label) + '</span>';
}
function applyHealthCandidateMixPill(cycle) {
  const counts = cycle?.candidate_counts;
  if (!counts) return "";
  const confirmed = Number(counts.confirmed_proposal) || 0;
  const guarded = Number(counts.guarded_retry) || 0;
  const proof = Number(counts.proof_required) || 0;
  const promotions = Number(counts.promotion_total) || 0;
  const eligiblePromotions = Number(counts.promotion_eligible) || 0;
  const cooldownEligiblePromotions = Number(counts.promotion_cooldown_eligible) || 0;
  const cooldownEligibleTotal = Number(counts.cooldown_eligible_total) || 0;
  const inconsistent = Number(counts.inconsistent_or_stale) || 0;
  const label = fmt.format(confirmed) + " proposals · " + fmt.format(guarded) + " retries · " + fmt.format(eligiblePromotions) + "/" + fmt.format(promotions) + " promotions admitted";
  const title = fmt.format(confirmed) + " confirmed proposals; " + fmt.format(guarded) + " guarded retries; " + fmt.format(eligiblePromotions) + " of " + fmt.format(promotions) + " promotion probes scheduler-admitted; " + fmt.format(cooldownEligiblePromotions) + " promotion probes and " + fmt.format(cooldownEligibleTotal) + " total candidates meet cooldown rules; " + fmt.format(proof) + " admitted candidates require close proof; " + fmt.format(inconsistent) + " inconsistent or stale records excluded.";
  return '<span class="pill" title="' + esc(title) + '">' + esc(label) + '</span>';
}
function applyHealthNeedsAttention(status) {
  return ["attention", "blocked", "degraded", "failed", "needs_attention", "warning"].includes(String(status || "").toLowerCase());
}
function applyHealthStatusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "failed") return "failed";
  if (value === "degraded" || value === "warning" || value === "attention") return "degraded";
  return "blocked";
}
function applyHealthModeLabel(mode) {
  const value = String(mode || "").toLowerCase();
  if (value === "comment_sync") return "comment-sync lane";
  if (value === "close") return "close lane";
  return "pruning lane";
}
function applyHealthReasonEntries(item) {
  const entries = [];
  const seen = new Set();
  const skipReasons = item.skip_reasons || {};
  for (const reason of item.attention_reasons || []) {
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    const skipCount = skipReasons[reason];
    entries.push([reason, Number.isFinite(skipCount) ? skipCount : null]);
  }
  for (const entry of Object.entries(skipReasons).sort((left, right) => Number(right[1]) - Number(left[1]))) {
    if (seen.has(entry[0])) continue;
    seen.add(entry[0]);
    entries.push(entry);
  }
  return entries;
}
function applyHealthPrimaryReason(item) {
  return applyHealthReasonEntries(item)[0]?.[0] || item.status || "";
}
function applyHealthReasonPill(reason, count, item) {
  const info = applyHealthReasonInfo(reason, item);
  const countText = Number.isFinite(count) ? " " + fmt.format(count) : "";
  return '<span class="pill apply-health-reason" title="' + esc(info.summary + " Next: " + info.action) + '">' + esc(info.label + countText) + '</span>';
}
function applyHealthNextActionForReason(item, reason) {
  return (item.next_actions || []).find(action => action.reason === reason) || null;
}
function applyHealthNextActionBucketPills(item) {
  const buckets = item.next_action_buckets || {};
  const entries = Object.entries(buckets)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  if (entries.length < 2) return "";
  const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
  const summary = entries
    .slice(0, 4)
    .map(([bucket, count]) => applyHealthBucketLabel(bucket) + " " + fmt.format(Number(count)))
    .join("; ");
  return '<span class="pill apply-health-reason" title="' + esc("Follow-up buckets: " + summary) + '">' + esc("follow-ups " + fmt.format(total)) + '</span>';
}
function applyHealthBucketLabel(bucket) {
  const labels = {
    already_resolved: "already resolved",
    close_coverage_proof: "needs close proof",
    conversation_unlock: "unlock conversation",
    defer_until_closing_pr: "defer for PR state",
    inspect: "inspect skips",
    live_state_recovery: "live check recovery",
    maintainer_review: "maintainer decision",
    report_quality_repair: "repair review report",
    review_refresh: "refresh reviews",
    run_budget: "runtime budget",
    stable_skip: "stable skips",
  };
  return labels[bucket] || applyHealthReasonLabel(bucket);
}
function applyHealthActionHtml(action) {
  if (!action) return "";
  const command = action.command || "";
  const commandHtml = command
    ? '<code class="apply-health-command" title="' + esc(command) + '">' + esc(command) + '</code><button class="filter-button apply-health-copy" type="button" data-copy-command="' + esc(command) + '" title="Copy this maintainer command">Copy command</button>'
    : '<span class="apply-health-command" title="' + esc(action.detail || "") + '">' + esc(action.detail || "No safe automatic action is available from the dashboard.") + '</span>';
  return '<div class="apply-health-action" title="' + esc(action.title || "") + '">' + commandHtml + linkClass(action.url, action.linkLabel || "open workflow", "pill run-link") + '</div>';
}
function applyHealthRecommendedAction(item, reason) {
  const targetRepo = String(item.target_repo || "openclaw/openclaw");
  const mode = String(item.mode || "").toLowerCase();
  const workflowUrl = "https://github.com/openclaw/clawsweeper/actions/workflows/sweep.yml";
  const nextAction = applyHealthNextActionForReason(item, reason);
  if (reason === "cursor_required_but_missing_after_full_window") {
    return {
      title: "Maintainer action: inspect the current run before rerunning, because a missing cursor can make the next run repeat the same window.",
      detail: "Inspect the cursor-write and state-publish steps; rerun only after the cursor write failure is understood.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (reason === "skipped_changed_since_review") {
    return {
      title: "Maintainer action: " + (nextAction?.next_step || "refresh review records before trying to close changed items."),
      command: "gh workflow run sweep.yml --repo openclaw/clawsweeper -f target_repo=" + targetRepo + " -f apply_existing=false",
      url: workflowUrl,
      linkLabel: "open workflow",
    };
  }
  if (reason === "skipped_pr_close_coverage_proof") {
    return {
      title: "Maintainer action: " + (nextAction?.next_step || "add close-coverage proof before retrying PR pruning."),
      detail: nextAction?.next_step || "Add or refresh close-coverage proof, then rerun the close lane.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (nextAction && !nextAction.retryable) {
    return {
      title: "Maintainer action: " + (nextAction.next_step || "inspect this stable or policy-gated skip before rerunning."),
      detail: nextAction.next_step || "No automatic rerun is recommended for this skip bucket.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (nextAction && nextAction.bucket === "report_quality_repair") {
    return {
      title: "Maintainer action: " + (nextAction.next_step || "repair or refresh the review report."),
      detail: nextAction.next_step || "Queue report-quality repair or re-review before retrying apply.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (nextAction) {
    return {
      title: "Maintainer action: " + (nextAction.next_step || "inspect this follow-up before rerunning."),
      detail: nextAction.next_step || "Inspect this follow-up bucket before retrying apply.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (mode === "comment_sync") {
    return {
      title: "Maintainer action: run the next comment-sync cursor window. GitHub permissions control who can run it.",
      command: "gh workflow run sweep.yml --repo openclaw/clawsweeper -f target_repo=" + targetRepo + " -f apply_existing=true -f apply_sync_comments_only=true -f apply_item_numbers=__cursor__ -f apply_limit=25",
      url: workflowUrl,
      linkLabel: "open workflow",
    };
  }
  const closeLimit = Number.isFinite(item.close_limit) && item.close_limit > 0 ? item.close_limit : 5;
  return {
    title: "Maintainer action: rerun the bounded close lane. GitHub permissions control who can run it.",
    command: "gh workflow run sweep.yml --repo openclaw/clawsweeper -f target_repo=" + targetRepo + " -f apply_existing=true -f apply_limit=" + closeLimit + " -f apply_kind=all -f apply_close_reasons=all",
    url: workflowUrl,
    linkLabel: "open workflow",
  };
}
function applyHealthReasonInfo(reason, item) {
  const nextAction = item ? applyHealthNextActionForReason(item, reason) : null;
  if (nextAction?.label || nextAction?.summary || nextAction?.next_step) {
    return {
      label: nextAction.label || applyHealthReasonLabel(reason),
      summary: nextAction.summary || "ClawSweeper classified this skip bucket with a deterministic follow-up.",
      action: nextAction.next_step || "Inspect this follow-up bucket before rerunning.",
    };
  }
  const value = String(reason || "");
  if (value === "cursor_required_but_missing_after_full_window") {
    return {
      label: "Rotation cursor missing",
      summary: "The pruning sweep processed the full bounded window but did not publish the next cursor.",
      action: "Open the workflow run and check the cursor-write step; until the cursor is written, the next run can repeat this window.",
    };
  }
  if (value === "skipped_runtime_budget") {
    return {
      label: "Runtime budget hit",
      summary: "The workflow stopped processing because it reached its bounded runtime.",
      action: "Let the next scheduled sweep continue; if this repeats, reduce the batch size or raise the apply runtime budget.",
    };
  }
  if (value === "skipped_live_fetch_failed") {
    return {
      label: "GitHub live check failed",
      summary: "ClawSweeper could not confirm live GitHub state before mutating an item.",
      action: "Inspect the workflow run for GitHub API, auth, or rate-limit failures, then rerun after live checks recover.",
    };
  }
  if (value === "skipped_changed_since_review") {
    return {
      label: "Changed since review",
      summary: "The item changed after the ClawSweeper review that proposed the close.",
      action: "Refresh the ClawSweeper review for those items before closing; this skip is a safety guard.",
    };
  }
  if (value === "skipped_pr_close_coverage_proof") {
    return {
      label: "PR close proof needed",
      summary: "The PR needs coverage proof before ClawSweeper can close it as duplicate or superseded.",
      action: "Add or refresh close-coverage proof, then rerun the sweep.",
    };
  }
  if (value === "skipped_open_closing_pr") {
    return {
      label: "Closing PR still open",
      summary: "The issue appears covered by an open pull request, so ClawSweeper avoided closing it early.",
      action: "Review or land the linked closing PR before expecting the issue to close.",
    };
  }
  if (value === "skipped_maintainer_authored") {
    return {
      label: "Maintainer-authored item",
      summary: "Automation will not close this maintainer-authored item without human review.",
      action: "Have a maintainer decide whether to close it manually or update the review policy.",
    };
  }
  if (value === "skipped_policy_exempt" || value === "skipped_protected_label") {
    return {
      label: "Policy-protected item",
      summary: "A label or policy exemption blocked automated pruning.",
      action: "Check the policy or label before taking manual action.",
    };
  }
  if (value === "skipped_not_open" || value === "skipped_already_closed" || value === "skipped_closed") {
    return {
      label: "Already closed",
      summary: "The item was no longer open by the time ClawSweeper checked it.",
      action: "No action is usually needed; investigate only if already-closed records dominate repeated runs.",
    };
  }
  return {
    label: applyHealthReasonLabel(value || "blocked_condition"),
    summary: "ClawSweeper reported this skip bucket while checking whether it could safely prune an item.",
    action: "Open the workflow run and inspect this skip bucket before rerunning or changing limits.",
  };
}
function applyHealthReasonLabel(reason) {
  return String(reason || "")
    .replace(/^skipped_/, "")
    .replace(/_/g, " ")
    .replace(/\\b\\w/g, letter => letter.toUpperCase());
}
function applyHealthOperatorSummary(item, reasonInfo) {
  const processed = applyHealthCount(item.processed, "record", "records");
  const skipped = Number.isFinite(item.skipped) ? "; " + applyHealthCount(item.skipped, "record", "records") + " skipped" : "";
  const closed = Number.isFinite(item.closed) ? item.closed : 0;
  const synced = Number.isFinite(item.comment_synced) ? item.comment_synced : 0;
  const useful = closed + synced;
  const result = useful > 0
    ? "ClawSweeper processed " + processed + " and completed " + applyHealthCount(useful, "close/comment update", "close/comment updates")
    : "ClawSweeper processed " + processed + " without closing or syncing anything";
  return result + skipped + ". Main signal: " + reasonInfo.label + ".";
}
function applyHealthCount(value, singular, plural) {
  if (!Number.isFinite(value)) return "unknown " + plural;
  return fmt.format(value) + " " + (value === 1 ? singular : plural);
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
document.getElementById("trend-ranges").addEventListener("click", event => {
  const button = event.target.closest("button[data-trend-range]");
  if (!button) return;
  document.querySelectorAll("button[data-trend-range]").forEach(item => item.classList.toggle("active", item === button));
  loadHealthHistory(button.dataset.trendRange || "6h", true).catch(() => undefined);
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
document.addEventListener("click", event => {
  const button = event.target.closest("button[data-copy-command]");
  if (!button) return;
  const command = String(button.dataset.copyCommand || "");
  if (!command) return;
  const copied = navigator.clipboard?.writeText(command);
  if (!copied) return;
  copied.then(() => {
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = original || "Copy command";
    }, 1500);
  }).catch(() => undefined);
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
