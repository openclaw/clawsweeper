export const LIVE_ACTIVITY_MAX_AGE_MS = 60_000;
// This is the configured 128 review-worker maximum plus the 50 concurrent
// publication workers. The panel samples its output, but accepts a complete
// bounded status snapshot first.
export const LIVE_ACTIVITY_SOURCE_LIMIT = 178;
export const LIVE_ACTIVITY_SAMPLE_LIMIT = 16;

export type LiveActivityKind = "worker" | "repair" | "scheduler" | "publisher" | "reconciliation";

export type LiveActivityUnknownReason =
  | "unavailable"
  | "malformed"
  | "mixed"
  | "stale"
  | "over_cap";

export type LiveActivityBaySnapshot = {
  version: 1;
  source: "dashboard-status-v1";
  generated_at: string;
  freshness: { maximum_age_ms: number; expires_at: string };
  collection: { state: "complete" } | { state: "unknown"; reason: LiveActivityUnknownReason };
  activity: {
    limit: number;
    returned: number;
    omitted: number;
    signals: Array<{
      kind: LiveActivityKind;
      label: string;
      source: "github-actions";
      observed_at: string;
    }>;
  } | null;
};

type ObjectRecord = Record<string, unknown>;

export function liveActivityBaySnapshot(
  source: unknown,
  now = Date.now(),
): LiveActivityBaySnapshot {
  const unknown = (reason: LiveActivityUnknownReason): LiveActivityBaySnapshot => ({
    version: 1,
    source: "dashboard-status-v1",
    generated_at: new Date(now).toISOString(),
    freshness: {
      maximum_age_ms: LIVE_ACTIVITY_MAX_AGE_MS,
      expires_at: new Date(now + LIVE_ACTIVITY_MAX_AGE_MS).toISOString(),
    },
    collection: { state: "unknown", reason },
    activity: null,
  });
  const snapshot = object(source);
  const generatedAt = Date.parse(String(snapshot.generated_at || ""));
  if (!Number.isFinite(generatedAt) || generatedAt > now + LIVE_ACTIVITY_MAX_AGE_MS)
    return unknown("malformed");
  if (now - generatedAt > LIVE_ACTIVITY_MAX_AGE_MS) return unknown("stale");
  const diagnostics = object(snapshot.diagnostics);
  if (!Array.isArray(diagnostics.errors) || diagnostics.errors.length > 0)
    return unknown("unavailable");
  if (!Array.isArray(snapshot.workers)) return unknown("malformed");
  if (snapshot.workers.length > LIVE_ACTIVITY_SOURCE_LIMIT) return unknown("over_cap");
  const controlPlane = object(snapshot.control_plane);
  const lanes = [
    ["publishers", "publisher", "publication scheduler"],
    ["comment_routers", "scheduler", "comment router"],
    ["reconcilers", "reconciliation", "lease reconciler"],
  ] as const;
  if (!lanes.every(([name]) => validLane(controlPlane[name]))) return unknown("mixed");

  const observedAt = new Date(generatedAt).toISOString();
  const signals: Array<{
    kind: LiveActivityKind;
    label: string;
    source: "github-actions";
    observed_at: string;
  }> = [];
  for (const worker of snapshot.workers) {
    const row = object(worker);
    if (!validWorker(row)) return unknown("mixed");
    const repair =
      row.work_kind === "repair_cluster" || row.work_kind === "pr_repair" || row.mode === "repair";
    signals.push({
      kind: repair ? "repair" : "worker",
      label: repair ? "repair worker active" : "worker active",
      source: "github-actions",
      observed_at: observedAt,
    });
  }
  for (const [name, kind, label] of lanes) {
    const lane = object(controlPlane[name]);
    const active = Number(lane.running) + Number(lane.waiting);
    if (active > 0) {
      signals.push({
        kind,
        label: `${label} active`,
        source: "github-actions",
        observed_at: observedAt,
      });
    }
  }
  signals.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label),
  );
  return {
    version: 1,
    source: "dashboard-status-v1",
    generated_at: observedAt,
    freshness: {
      maximum_age_ms: LIVE_ACTIVITY_MAX_AGE_MS,
      expires_at: new Date(generatedAt + LIVE_ACTIVITY_MAX_AGE_MS).toISOString(),
    },
    collection: { state: "complete" },
    activity: {
      limit: LIVE_ACTIVITY_SAMPLE_LIMIT,
      returned: Math.min(LIVE_ACTIVITY_SAMPLE_LIMIT, signals.length),
      omitted: Math.max(0, signals.length - LIVE_ACTIVITY_SAMPLE_LIMIT),
      signals: signals.slice(0, LIVE_ACTIVITY_SAMPLE_LIMIT),
    },
  };
}

function object(value: unknown): ObjectRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectRecord) : {};
}

function validWorker(value: ObjectRecord) {
  return (
    typeof value.work_kind === "string" &&
    typeof value.mode === "string" &&
    typeof value.status === "string" &&
    ["queued", "in_progress", "waiting", "requested", "pending"].includes(value.status)
  );
}

function validLane(value: unknown) {
  const lane = object(value);
  return ["running", "waiting"].every(
    (key) =>
      Number.isSafeInteger(lane[key]) &&
      Number(lane[key]) >= 0 &&
      Number(lane[key]) <= LIVE_ACTIVITY_SOURCE_LIMIT,
  );
}
