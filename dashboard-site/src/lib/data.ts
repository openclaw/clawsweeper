import raw from '../data/dashboard.json';

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

// Daily series end at the corpus snapshot day; the last (partial) day is excluded from
// period comparisons so a half-finished day never reads as a drop. Sources omit days
// with no events, so every series is filled to one point per calendar day.
const DAY_MS = 86_400_000;
const snapshotDay = Date.parse(`${String(corpus.generatedAt).slice(0, 10)}T00:00:00Z`);
function daily(rows: Json[], value: (row: Json) => number): DayPoint[] {
  const byDate = new Map<string, number>(rows.map(row => [row.date, value(row)]));
  const first = rows.length ? Date.parse(`${rows[0].date}T00:00:00Z`) : snapshotDay;
  const points: DayPoint[] = [];
  for (let time = first; time <= snapshotDay; time += DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10);
    points.push({ date, value: byDate.get(date) ?? 0 });
  }
  return points;
}
const reviewDays = daily(corpus.days, day => day.reviewed);
const closeDays = daily(corpus.recordedCloses.days, day => day.count);
const elsewhereDays = daily(corpus.closedElsewhere.days, day => day.count);

function windowed(series: DayPoint[], days: number, offset = 0): DayPoint[] {
  const complete = series.slice(0, -1);
  const end = complete.length - offset;
  return complete.slice(Math.max(0, end - days), end);
}

function periodDelta(series: DayPoint[], days: number) {
  const current = sum(windowed(series, days).map(point => point.value));
  const previous = sum(windowed(series, days, days).map(point => point.value));
  return { current, previous, delta: previous ? (current - previous) / previous : null };
}

export const series = {
  reviews: (days: number) => windowed(reviewDays, days),
  closes: (days: number) => windowed(closeDays, days),
  closedElsewhere: (days: number) => windowed(elsewhereDays, days),
};

const sweep = actions.workflows.find((workflow: Json) => workflow.id === 'sweep');
const runDays: { date: string; total: number; failure: number; success: number; cancelled: number; p50: number; p90: number }[] =
  sweep.days.map((day: Json) => ({
    date: day.date,
    total: day.count,
    failure: (day.conclusions.failure ?? 0) + (day.conclusions.startup_failure ?? 0),
    success: day.conclusions.success ?? 0,
    cancelled: day.conclusions.cancelled ?? 0,
    p50: day.durationSeconds.p50,
    p90: day.durationSeconds.p90,
  }));
const completeRunDays = runDays.slice(0, -1);

function runRate(days: number, offset = 0) {
  const slice = completeRunDays.slice(Math.max(0, completeRunDays.length - offset - days), completeRunDays.length - offset);
  const total = sum(slice.map(day => day.total));
  const success = sum(slice.map(day => day.success));
  return total ? success / total : null;
}

export const kpis = {
  reviews7d: periodDelta(reviewDays, 7),
  reviews30d: periodDelta(reviewDays, 30),
  closes7d: periodDelta(closeDays, 7),
  closes30d: periodDelta(closeDays, 30),
  closedElsewhere7d: periodDelta(elsewhereDays, 7),
  runSuccess7d: { current: runRate(7), previous: runRate(7, 7) },
  reviewTime: { p50: corpus.timings.codexMs.p50 as number, p90: corpus.timings.codexMs.p90 as number },
  firstReview: { p50: corpus.timings.createdToReviewHours.p50 as number, p90: corpus.timings.createdToReviewHours.p90 as number },
};

export const runs = {
  days: completeRunDays,
  failureRate: completeRunDays.map(day => ({ date: day.date, value: day.total ? day.failure / day.total : 0 })),
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

export const live = {
  handoff: queue.handoff_health as Json,
  failures: queue.review_failure_health as Json,
  runaway: queue.review_runaway_health as Json,
  feed: queue.scheduled_feed as Json,
  pressure: queue.pressure as Json,
  review: reviewLane as Json,
  publication: publicationLane as Json,
  pending: reviewLane.pending as number,
  leased: reviewLane.leased as number,
  parked: (reviewLane.parked + publicationLane.parked) as number,
  capacity: reviewLane.capacity as number,
  active: reviewLane.active as number,
  oldestPendingSeconds: reviewLane.oldest_pending_age_seconds as number | null,
  parkedReasons: entries({ ...reviewLane.parked_reasons }, ['unknown']),
  publicationParked: entries({ ...publicationLane.parked_reasons }, ['unknown']),
  backoffReasons: entries({ ...reviewLane.backoff_reasons }),
};

export const status = (() => {
  const reasons: string[] = [];
  if (live.failures.status !== 'healthy' && live.failures.terminal_attempts)
    reasons.push(`${live.failures.terminal_attempts} terminal review ${live.failures.terminal_attempts === 1 ? 'failure' : 'failures'} in ${live.failures.window_minutes}m`);
  if (live.runaway.status !== 'healthy' && live.runaway.runaway_items)
    reasons.push(`${live.runaway.runaway_items} items over ${live.runaway.threshold_reviews_per_day} reviews/day`);
  if (live.handoff.status !== 'healthy') reasons.push('Review handoff degraded');
  return { level: reasons.length ? 'warn' : 'ok', text: reasons.length ? reasons.join(' · ') : 'All clear' } as const;
})();

export const cover = {
  percent: coverage.totals.coverage_percent as number,
  reviewable: coverage.totals.reviewable_records as number,
  reviewed: coverage.totals.reviewed_recent as number,
  stale: coverage.totals.stale as number,
  unreviewed: coverage.totals.unreviewed_records as number,
  pending: coverage.totals.pending as number,
  windowDays: coverage.window_days as number,
};

export const totals = corpus.totals as { records: number; typed: number; missingTyped: number; open: number; archived: number; repositories: number };
export const distributions = corpus.distributions as Record<string, Record<string, number>>;
export const closeReasons = entries({ ...corpus.recordedCloses.byReason });
export const closedElsewhereTotal = corpus.closedElsewhere.total as number;
export const recommendedCloseReasons = entries({ ...distributions.closeReasons }, ['none']);
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
