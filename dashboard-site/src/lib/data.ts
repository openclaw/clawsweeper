import raw from "../data/dashboard.json";
import type { Operations, OperationsHour } from "../../scripts/operations.ts";
import { duration, label } from "./format";

// The build snapshot (scripts/build-data.ts). Typed loosely at the edge; every page reads
// through the view helpers below so presentation never learns the raw shapes.
type Json = any;
const snapshot = raw as Json;

export interface Item {
  repo: string;
  number: number;
  kind: string;
  title: string;
  url: string;
  reviewedAt: string;
  createdAt: string;
  decision: string;
  closeReason: string;
  proof: string;
  security: string;
  maintainerKind: string | null;
}

export interface Repo {
  repo: string;
  slug: string;
  records: number;
  typed: number;
  open: number;
  archived: number;
  reviewed7d: number;
  reviewed30d: number;
  staleOpen: number;
  missingTyped: number;
  decisions: Record<string, number>;
}

export interface DayPoint {
  date: string;
  value: number;
}

// value null: not recorded for that day (shown as "No data", never as zero).
export interface GapPoint {
  date: string;
  value: number | null;
}

const corpus = snapshot.corpus;
const queue = snapshot.queue;
const coverage = snapshot.coverage;
const actions = snapshot.actions;

export const asOf = {
  corpus: corpus.generatedAt as string,
  queue: (queue.generated_at ?? queue.handoff_health?.observed_at) as string,
  coverage: coverage.generated_at as string,
  actions: actions.windowEnd as string,
  build: snapshot.generatedAt as string,
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const scaled = (value: unknown, factor: number) =>
  typeof value === "number" ? value * factor : null;

// Daily series end at the corpus snapshot day; the last (partial) day is excluded from
// period comparisons so a half-finished day never reads as a drop. Sources omit days
// with no events, so every series is filled to one point per calendar day.
const DAY_MS = 86_400_000;
const snapshotDay = Date.parse(`${String(corpus.generatedAt).slice(0, 10)}T00:00:00Z`);
function daily<T extends number | null>(
  rows: Json[],
  value: (row: Json) => T,
  empty: T,
): { date: string; value: T }[] {
  const byDate = new Map<string, T>(rows.map((row) => [row.date, value(row)]));
  const first = rows.length ? Date.parse(`${rows[0].date}T00:00:00Z`) : snapshotDay;
  const points: { date: string; value: T }[] = [];
  for (let time = first; time <= snapshotDay; time += DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10);
    points.push({ date, value: byDate.has(date) ? (byDate.get(date) as T) : empty });
  }
  return points;
}
const reviewDays: DayPoint[] = daily(corpus.days, (day) => day.reviewed, 0);
// Reviews of items authored by maintainers (owner, member or collaborator, or `maintainer` label).
const maintainerDays: GapPoint[] = daily(
  corpus.days,
  (day): number | null => (typeof day.maintainer === "number" ? day.maintainer : null),
  0,
);
const closeDays: DayPoint[] = daily(corpus.recordedCloses.days, (day) => day.count, 0);
const elsewhereDays: DayPoint[] = daily(corpus.closedElsewhere.days, (day) => day.count, 0);

// Complete days only; a window that does not fit in the history is empty, never shifted.
function lastDays<T>(complete: T[], days: number, offset = 0): T[] {
  const end = complete.length - offset;
  return end > 0 ? complete.slice(Math.max(0, end - days), end) : [];
}
const windowed = <T>(series: T[], days: number, offset = 0) =>
  lastDays(series.slice(0, -1), days, offset);

// The previous period counts only when the history holds all of it.
function periodDelta(series: DayPoint[], days: number) {
  const current = sum(windowed(series, days).map((point) => point.value));
  const before = windowed(series, days, days);
  const previous = before.length === days ? sum(before.map((point) => point.value)) : null;
  return { current, previous, delta: previous ? (current - previous) / previous : null };
}

export const series = {
  reviews: (days: number) => windowed(reviewDays, days),
  maintainerReviews: (days: number) => windowed(maintainerDays, days),
  // Share of each day's reviews that were of maintainer-authored items.
  maintainerShare: (days: number): GapPoint[] => {
    const totals = windowed(reviewDays, days);
    return windowed(maintainerDays, days).map((point, index) => {
      const total = totals[index]?.value ?? 0;
      return {
        date: point.date,
        value: point.value === null || total === 0 ? null : point.value / total,
      };
    });
  },
  closes: (days: number) => windowed(closeDays, days),
  closedElsewhere: (days: number) => windowed(elsewhereDays, days),
};

const sweep = actions.workflows.find((workflow: Json) => workflow.id === "sweep");
// reviewP50/reviewP90: exact review runs only (recorded, or a ~300-run daily sample for older
// days); null when a day has neither. The all-runs median shifts whenever jobs move between files.
const runDays: {
  date: string;
  total: number;
  failure: number;
  success: number;
  cancelled: number;
  reviewP50: number | null;
  reviewP90: number | null;
}[] = (sweep?.days ?? []).map((day: Json) => ({
  date: day.date,
  total: day.count,
  failure: (day.conclusions.failure ?? 0) + (day.conclusions.startup_failure ?? 0),
  success: day.conclusions.success ?? 0,
  cancelled: day.conclusions.cancelled ?? 0,
  reviewP50: day.reviewSeconds?.p50 ?? null,
  reviewP90: day.reviewSeconds?.p90 ?? null,
}));
const completeRunDays = runDays.slice(0, -1);

function runRate(days: number, offset = 0) {
  const slice = lastDays(completeRunDays, days, offset);
  if (offset && slice.length < days) return null;
  const total = sum(slice.map((day) => day.total));
  const success = sum(slice.map((day) => day.success));
  return total ? success / total : null;
}

export const kpis = {
  reviews7d: periodDelta(reviewDays, 7),
  reviews30d: periodDelta(reviewDays, 30),
  closes7d: periodDelta(closeDays, 7),
  closes30d: periodDelta(closeDays, 30),
  closedElsewhere7d: periodDelta(elsewhereDays, 7),
  runSuccess7d: { current: runRate(7), previous: runRate(7, 7) },
  // Seconds; null when the corpus has no samples.
  reviewTime: {
    p50: scaled(corpus.timings.codexMs.p50, 1 / 1000),
    p90: scaled(corpus.timings.codexMs.p90, 1 / 1000),
  },
  firstReview: {
    p50: scaled(corpus.timings.createdToReviewHours.p50, 3600),
    p90: scaled(corpus.timings.createdToReviewHours.p90, 3600),
  },
};

export const runs = {
  days: completeRunDays,
  failureRate: completeRunDays.map((day) => ({
    date: day.date,
    value: day.total ? day.failure / day.total : null,
  })),
  workflows: actions.workflows.map((workflow: Json) => {
    const outcomes = workflow.conclusionCounts as Record<string, number>;
    const finished = sum(Object.values(outcomes));
    const failed = (outcomes.failure ?? 0) + (outcomes.startup_failure ?? 0);
    return {
      id: workflow.id as string,
      file: workflow.file as string,
      runs: workflow.totalRuns as number,
      success: finished ? (outcomes.success ?? 0) / finished : null,
      failed,
      cancelled: outcomes.cancelled ?? 0,
      p50: workflow.durationSeconds.p50 as number,
      p90: workflow.durationSeconds.p90 as number,
      days: workflow.days.length as number,
    };
  }),
};

const reviewLane = queue.lanes.review;
const publicationLane = queue.lanes.publication;

// Optional queue telemetry: the Worker sends null when a source is missing or malformed.
const object = (value: unknown): Json => (value && typeof value === "object" ? value : null);

export const live = {
  handoff: object(queue.handoff_health),
  failures: object(queue.review_failure_health),
  runaway: object(queue.review_runaway_health),
  feed: object(queue.scheduled_feed),
  pressure: object(queue.pressure),
  review: reviewLane as Json,
  publication: publicationLane as Json,
  pending: reviewLane.pending as number,
  leased: reviewLane.leased as number,
  parked: (reviewLane.parked + publicationLane.parked) as number,
  capacity: reviewLane.capacity as number,
  active: reviewLane.active as number,
  oldestPendingSeconds: reviewLane.oldest_pending_age_seconds as number | null,
  parkedReasons: entries({ ...reviewLane.parked_reasons }, ["unknown"]),
  publicationParked: entries({ ...publicationLane.parked_reasons }, ["unknown"]),
  backoffReasons: entries({ ...reviewLane.backoff_reasons }),
};

// One check per health source, in the Worker's own terms: idle and healthy are fine,
// degraded/critical/stalled need attention, and missing telemetry is never "all clear".
export interface HealthCheck {
  name: string;
  ok: boolean;
  value: string;
  detail: string;
  tip: string;
  alert: string | null;
}
const unavailable = (name: string, tip: string): HealthCheck => ({
  name,
  ok: false,
  value: "Unavailable",
  detail: "Telemetry missing from the snapshot.",
  tip,
  alert: `${name}: telemetry unavailable`,
});

export const healthChecks: HealthCheck[] = [
  (() => {
    const name = "Review failures";
    const tip =
      "Review attempts that failed in the rolling window. Terminal failures will not retry on their own.";
    const failures = live.failures;
    if (!failures || failures.status === "unknown") return unavailable(name, tip);
    const detail = `${failures.attempts} attempts on ${failures.affected_targets} targets in ${failures.window_minutes}m`;
    if (failures.status === "healthy")
      return { name, ok: true, value: "Healthy", detail, tip, alert: null };
    const value = `${label(failures.status)} · ${failures.terminal_attempts} terminal, ${failures.retryable_attempts} retrying`;
    return {
      name,
      ok: false,
      value,
      detail,
      tip,
      alert: `Review failures ${failures.status}: ${failures.attempts} failed attempts in ${failures.window_minutes}m`,
    };
  })(),
  (() => {
    const name = "Runaway reviews";
    const tip =
      "Items reviewed again and again in a short window. Usually a revision loop or a feed bug.";
    const runaway = live.runaway;
    if (!runaway || runaway.status === "unknown") return unavailable(name, tip);
    const detail = `over ${runaway.threshold_reviews_per_day} reviews in ${runaway.window_hours}h`;
    if (runaway.status === "healthy")
      return { name, ok: true, value: "Healthy", detail, tip, alert: null };
    return {
      name,
      ok: false,
      value: `${runaway.runaway_items} items`,
      detail,
      tip,
      alert: `${runaway.runaway_items} items over ${runaway.threshold_reviews_per_day} reviews/day`,
    };
  })(),
  (() => {
    const name = "Handoff";
    const tip = "Whether claimed work moves from pending to dispatching to leased on time.";
    const handoff = live.handoff;
    if (!handoff) return unavailable(name, tip);
    const detail = `warn after ${duration(handoff.warning_after_seconds)}, stall after ${duration(handoff.stalled_after_seconds)}`;
    if (handoff.status === "healthy" || handoff.status === "idle")
      return { name, ok: true, value: label(handoff.status), detail, tip, alert: null };
    return {
      name,
      ok: false,
      value: label(handoff.reason),
      detail,
      tip,
      alert: `Review handoff ${handoff.status}: ${label(handoff.reason)}`,
    };
  })(),
];

export const status = (() => {
  const alerts = healthChecks.flatMap((check) => (check.alert ? [check.alert] : []));
  return {
    level: alerts.length ? "warn" : "ok",
    text: alerts.length ? alerts.join(" · ") : "All clear",
  } as const;
})();

// The coverage projection splits reviewable items into disjoint parts:
// reviewed_recent + stale + failed + expired + unreviewed_records + untracked_open.
const coverageTotals = coverage.totals;
export const cover = {
  percent:
    typeof coverageTotals.coverage_percent === "number"
      ? (coverageTotals.coverage_percent as number)
      : null,
  reviewable: coverageTotals.reviewable_records as number,
  reviewed: coverageTotals.reviewed_recent as number,
  stale: coverageTotals.stale as number,
  pending: coverageTotals.pending as number,
  windowDays: coverage.window_days as number,
  segments: [
    {
      label: "Reviewed recently",
      value: coverageTotals.reviewed_recent as number,
      color: "var(--ok)",
    },
    { label: "Stale", value: coverageTotals.stale as number, color: "var(--warn)" },
    { label: "Expired", value: coverageTotals.expired as number, color: "var(--accent)" },
    { label: "Failed", value: coverageTotals.failed as number, color: "var(--bad)" },
    {
      label: "Never reviewed",
      value: (coverageTotals.unreviewed_records + coverageTotals.untracked_open) as number,
      color: "var(--fg-faint)",
    },
  ],
};
export const coverText = cover.percent === null ? "–" : `${cover.percent.toFixed(1)}%`;

export const totals = corpus.totals as {
  records: number;
  typed: number;
  missingTyped: number;
  open: number;
  archived: number;
  repositories: number;
};
export const distributions = corpus.distributions as Record<string, Record<string, number>>;
export const closeReasons = entries({ ...corpus.recordedCloses.byReason });
export const closedElsewhereTotal = corpus.closedElsewhere.total as number;
export const recommendedCloseReasons = entries({ ...distributions.closeReasons }, ["none"]);
export const repos: Repo[] = [...corpus.repos].sort((a: Repo, b: Repo) => b.records - a.records);

export const lists = {
  stale: corpus.lists.stale as Item[],
  security: corpus.lists.security as Item[],
  maintainer: corpus.lists.maintainer as Item[],
  closes: corpus.recordedCloses.recent as Item[],
};

function entries(record: Record<string, number>, drop: string[] = []) {
  return Object.entries(record)
    .filter(([key, value]) => value > 0 && !drop.includes(key))
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, value }));
}

export { entries };

// Operations: 7 days of hourly queue history and apply outcomes (scripts/operations.ts).
const operations = snapshot.operations as Operations;
const opsHours = operations.hours;
// The current hour is still filling; rates and medians use complete hours only.
const completeHours = opsHours.slice(0, -1);
const known = (values: (number | null)[]) =>
  values.filter((value): value is number => value !== null);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const hourly = (pick: (hour: OperationsHour) => number | null) =>
  opsHours.map((hour) => ({ date: hour.hour, value: pick(hour) }));
const majorIncidents = operations.incidents.filter((incident) => incident.minutes >= 10);
const { observed: handoffObserved, unhealthy: handoffUnhealthy } = operations.handoffSamples;
const offered =
  sum(known(completeHours.map((hour) => hour.shed))) +
  sum(known(completeHours.map((hour) => hour.enqueued)));
const failureKinds = [
  ...new Set([
    ...Object.keys(operations.apply.day.failures),
    ...Object.keys(operations.apply.week.failures),
  ]),
];

export const ops = {
  asOf: operations.generatedAt,
  windowStart: operations.windowStart,
  reviewsPerHour: {
    day: median(known(completeHours.slice(-24).map((hour) => hour.completed))),
    week: median(known(completeHours.map((hour) => hour.completed))),
  },
  shed: {
    // observed: at least one hour with known counter growth; a measured zero is still a value.
    observed: completeHours.some((hour) => hour.shed !== null),
    week: sum(known(completeHours.map((hour) => hour.shed))),
    share: offered ? sum(known(completeHours.map((hour) => hour.shed))) / offered : null,
  },
  handoff: {
    // Share of observed 5-minute samples; unobserved time is unknown, not healthy.
    healthyShare: handoffObserved ? 1 - handoffUnhealthy / handoffObserved : null,
    observedShare: handoffObserved / (7 * 24 * 12),
    observed: handoffObserved,
    incidents: majorIncidents,
    blips: operations.incidents.length - majorIncidents.length,
    strip: opsHours.map((hour) => ({ hour: hour.hour, status: hour.handoff })),
  },
  series: {
    completed: hourly((hour) => hour.completed),
    shed: hourly((hour) => hour.shed),
    reviewPending: hourly((hour) => hour.reviewPending),
    publicationPending: hourly((hour) => hour.publicationPending),
    leased: hourly((hour) => hour.leased),
  },
  apply: {
    applied: operations.apply.day.applied,
    closed: operations.apply.day.closed,
    // null: not reported for that window (unknown), shown as "–", never as zero.
    failures: failureKinds
      .map((kind) => ({
        kind,
        day: operations.apply.day.failures[kind] ?? null,
        week: operations.apply.week.failures[kind] ?? null,
      }))
      .sort((a, b) => (b.week ?? -1) - (a.week ?? -1) || (b.day ?? -1) - (a.day ?? -1)),
    lastFailure: operations.apply.lastFailure,
  },
  coverage: operations.coverage,
};
