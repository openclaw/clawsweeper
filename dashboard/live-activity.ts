export const LIVE_ACTIVITY_MAX_AGE_MS = 60_000;
// Public status deliberately caps the complete worker census at 100 rows.
// Larger or explicitly incomplete inputs are never summarized as complete.
export const LIVE_ACTIVITY_SOURCE_LIMIT = 100;

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
    total: number;
    by_kind: Record<LiveActivityKind, number>;
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
  const generatedAtText = publicTimestamp(snapshot.generated_at);
  const generatedAt = generatedAtText ? Date.parse(generatedAtText) : Number.NaN;
  if (!Number.isFinite(generatedAt) || generatedAt > now + LIVE_ACTIVITY_MAX_AGE_MS)
    return unknown("malformed");
  if (now - generatedAt > LIVE_ACTIVITY_MAX_AGE_MS) return unknown("stale");
  const diagnostics = object(snapshot.diagnostics);
  if (!Array.isArray(diagnostics.errors) || diagnostics.errors.length > 0)
    return unknown("unavailable");
  if (!Array.isArray(snapshot.workers)) return unknown("malformed");
  if (snapshot.workers.length > LIVE_ACTIVITY_SOURCE_LIMIT) return unknown("over_cap");
  const bay = object(snapshot.bay);
  if (bay.active_census_complete === false) {
    return unknown(
      snapshot.workers.length >= LIVE_ACTIVITY_SOURCE_LIMIT ? "over_cap" : "unavailable",
    );
  }
  if (bay.active_census_complete !== true) return unknown("malformed");
  const controlPlane = object(snapshot.control_plane);
  const lanes = [
    ["publishers", "publisher"],
    ["comment_routers", "scheduler"],
    ["reconcilers", "reconciliation"],
  ] as const;
  if (!lanes.every(([name]) => validLane(controlPlane[name]))) return unknown("mixed");

  const observedAt = new Date(generatedAt).toISOString();
  const byKind: Record<LiveActivityKind, number> = {
    worker: 0,
    repair: 0,
    scheduler: 0,
    publisher: 0,
    reconciliation: 0,
  };
  for (const worker of snapshot.workers) {
    const row = object(worker);
    if (!validWorker(row)) return unknown("mixed");
    const repair =
      row.work_kind === "repair_cluster" || row.work_kind === "pr_repair" || row.mode === "repair";
    byKind[repair ? "repair" : "worker"] += 1;
  }
  for (const [name, kind] of lanes) {
    const lane = object(controlPlane[name]);
    byKind[kind] = Number(lane.running) + Number(lane.waiting);
  }
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
      total: Object.values(byKind).reduce((sum, count) => sum + count, 0),
      by_kind: byKind,
    },
  };
}

function publicTimestamp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 35 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= Date.UTC(2020, 0, 1) && parsed < Date.UTC(2100, 0, 1)
    ? new Date(parsed).toISOString()
    : null;
}

function object(value: unknown): ObjectRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectRecord) : {};
}

function validWorker(value: ObjectRecord) {
  return (
    ["issue_to_pr", "pr_repair", "repair_cluster", "other"].includes(String(value.work_kind)) &&
    [
      "assist",
      "automerge",
      "background-review",
      "commit-review",
      "exact-review",
      "apply",
      "hot-review",
      "repair",
    ].includes(String(value.mode)) &&
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
