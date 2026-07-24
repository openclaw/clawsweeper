import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";

const healthFile = optional("--health-file");
const healthPath = healthFile && existsSync(healthFile) ? healthFile : fallbackHealthPath();
const health = healthPath ? JSON.parse(readFileSync(healthPath, "utf8")) : {};
const telemetryContextPath = ".artifacts/apply-observability-context.json";
const telemetryContext = existsSync(telemetryContextPath)
  ? JSON.parse(readFileSync(telemetryContextPath, "utf8"))
  : {};
const now = new Date().toISOString();
const lifecycleStart = process.env.APPLY_STARTED_AT || telemetryContext?.started_at;
const startedAt = contextTimestamp(lifecycleStart, now);
const lifecycleStarted = hasTimestamp(lifecycleStart, now);
const outcome = ["in_progress", "success", "failure", "cancelled", "skipped"].includes(
  process.env.APPLY_OUTCOME,
)
  ? process.env.APPLY_OUTCOME
  : "failure";
const inProgress = outcome === "in_progress";
const idle =
  String(process.env.APPLY_NOOP || "").toLowerCase() === "true" ||
  telemetryContext?.noop === true ||
  healthPath.endsWith("/apply-health-idle.json") ||
  healthPath.endsWith("\\apply-health-idle.json");
const nextActions = Array.isArray(health.next_actions) ? health.next_actions : [];
const safeCloseBlocked = nextActions.some((action) =>
  ["close_coverage_proof", "conversation_unlock", "maintainer_review"].includes(
    String(action?.bucket),
  ),
);
const closed = count(health.closed);
const commentSynced = count(health.comment_synced);
const usefulApplied = idle
  ? 0
  : closed === null || commentSynced === null
    ? null
    : closed + commentSynced;
const statePublicationFailed =
  process.env.STATE_STATUS_OUTCOME === "failure" ||
  process.env.STATE_PUBLICATION_OUTCOME === "failure";
const actionLedgerFailed = process.env.ACTION_LEDGER_OUTCOME === "failure";
const observedFailureKinds = [
  ...(actionLedgerFailed ? ["action_ledger_failure"] : []),
  ...(statePublicationFailed ? ["state_publication_failure"] : []),
  ...(safeCloseBlocked ? ["safe_close_blocked"] : []),
  ...(outcome === "failure" ? ["workflow_failure"] : []),
];
const failures = [
  ...(outcome === "failure" ? [{ kind: "workflow_failure", at: now }] : []),
  ...(safeCloseBlocked ? [{ kind: "safe_close_blocked", at: now }] : []),
  ...(actionLedgerFailed ? [{ kind: "action_ledger_failure", at: now }] : []),
  ...(statePublicationFailed ? [{ kind: "state_publication_failure", at: now }] : []),
];

const payload = JSON.stringify({
  event: {
    schema_version: 1,
    repo: requiredEnv("TARGET_REPO"),
    run_id: requiredEnv("GITHUB_RUN_ID"),
    run_attempt: Number(requiredEnv("GITHUB_RUN_ATTEMPT")),
    occurred_at: now,
    started_at: startedAt,
    lifecycle_started: lifecycleStarted,
    outcome,
    run_url: `https://github.com/${requiredEnv("GITHUB_REPOSITORY")}/actions/runs/${requiredEnv("GITHUB_RUN_ID")}`,
    queue: {
      // Terminal health files do not observe the live GitHub Actions queue.
      // Only the start observation can truthfully say that this apply job is active.
      active: inProgress ? 1 : null,
      capacity: inProgress ? 1 : null,
      ready: null,
      backoff: null,
      dispatching: null,
      leased: null,
      oldest_ready_age_seconds: null,
      oldest_backoff_age_seconds: null,
      oldest_lease_age_seconds: null,
    },
    // The legacy apply state has no arrival ledger. Keep this unknown until
    // producers emit one instead of turning ready-depth changes into fiction.
    arrivals: idle ? 0 : null,
    results: {
      applied: usefulApplied,
      closed: idle ? 0 : closed,
      superseded: null,
      retried: null,
      dead_lettered: null,
    },
    lease: { wait_ms: null, hold_ms: null },
    observed_failure_kinds: observedFailureKinds,
    failures,
  },
});
const queueUrl = requiredEnv("QUEUE_URL").replace(/\/+$/, "");
const response = await fetch(`${queueUrl}/internal/apply-observability`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", requiredEnv("CLAWSWEEPER_WEBHOOK_SECRET")).update(payload).digest("hex")}`,
  },
  body: payload,
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`apply observability publish failed: ${response.status}`);

function count(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function optional(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function fallbackHealthPath() {
  const final = ".artifacts/apply-health-final.json";
  if (existsSync(final)) return final;
  const checkpoint = latestCheckpointHealthPath();
  if (checkpoint) return checkpoint;
  const idle = ".artifacts/apply-health-idle.json";
  return existsSync(idle) ? idle : "";
}

function latestCheckpointHealthPath() {
  try {
    const checkpoints = readdirSync(".artifacts")
      .map((name) => {
        const match = /^apply-health-(\d+)\.json$/.exec(name);
        return match ? { name, checkpoint: Number(match[1]) } : null;
      })
      .filter(Boolean);
    const latest = checkpoints.sort((left, right) => right.checkpoint - left.checkpoint)[0];
    return latest ? `.artifacts/${latest.name}` : "";
  } catch {
    return "";
  }
}

function contextTimestamp(value, fallback) {
  return hasTimestamp(value, fallback)
    ? new Date(Date.parse(String(value))).toISOString()
    : fallback;
}

function hasTimestamp(value, now) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed <= Date.parse(now);
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
