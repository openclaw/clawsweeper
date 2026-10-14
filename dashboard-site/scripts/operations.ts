// Operations history for the dashboard, from two public Worker APIs:
//   /api/health-history?range=7d       one queue sample every 5 minutes (counters and depths)
//   /api/apply-observability?range=…   apply and close outcomes and failure kinds
// The samples are reduced to hourly points and to incidents (runs of unhealthy handoff), so
// the page carries about 170 small rows instead of 2,000 raw samples.

import { isRecord } from './guards.ts';

const HOUR_MS = 3_600_000;
const SAMPLE_MS = 5 * 60_000;

// idle: nothing queued or active (the queue is empty), which is fine, like healthy.
type Handoff = 'idle' | 'healthy' | 'degraded' | 'stalled';
const HANDOFF_RANK: Record<Handoff, number> = { idle: 0, healthy: 0, degraded: 1, stalled: 2 };
const unhealthy = (status: Handoff): status is 'degraded' | 'stalled' => HANDOFF_RANK[status] > 0;

type Lane = { pending: number; enqueued_total?: number; completed_total?: number; published_total?: number; shed_total?: number };
type Sample = {
  at: string;
  exact_review: { review: Lane; publication: Lane; handoff: { status: Handoff; leased: number } | null };
};

export type OperationsHour = {
  hour: string;
  // null: no usable sample in this hour (telemetry gap), so charts can show a gap, not a zero.
  completed: number | null;
  enqueued: number | null;
  shed: number | null;
  published: number | null;
  reviewPending: number | null;
  publicationPending: number | null;
  leased: number | null;
  handoff: Handoff | null;
};
export type Incident = { start: string; end: string; minutes: number; worst: 'degraded' | 'stalled' };
// null: the API did not establish the value (no observation), which is not the same as zero.
type ApplyWindow = { applied: number | null; closed: number | null; failures: Record<string, number | null> };
export type Operations = {
  generatedAt: string;
  windowStart: string;
  hours: OperationsHour[];
  reviewOffers: { accepted: number; shed: number } | null;
  incidents: Incident[];
  coverage: { percent: number | null; failedSlots: number | null; missingSlots: number | null };
  // Usable samples in the window, and how many of them were unhealthy.
  handoffSamples: { observed: number; unhealthy: number };
  apply: { day: ApplyWindow; week: ApplyWindow; lastFailure: { kind: string; at: string } | null };
};

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function lane(value: unknown): Lane | null {
  if (!isRecord(value)) return null;
  const pending = num(value.pending);
  if (pending === null) return null;
  return { pending, ...Object.fromEntries(['enqueued_total', 'completed_total', 'published_total', 'shed_total'].flatMap(key => {
    const count = num(value[key]);
    return count === null ? [] : [[key, count]];
  })) };
}

// Collection and depths establish a sample. Each counter and handoff is observed independently.
function usableSample(value: unknown): Sample | null {
  if (!isRecord(value) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  const exact = value.exact_review;
  if (!isRecord(exact) || exact.collection_ok !== true) return null;
  const review = lane(exact.review);
  const publication = lane(exact.publication);
  if (!review || !publication) return null;
  const handoff = isRecord(exact.handoff) ? exact.handoff : {};
  const status = handoff.status;
  const leased = num(handoff.leased);
  return { at: value.at, exact_review: { review, publication, handoff: leased !== null && (status === 'idle' || status === 'healthy' || status === 'degraded' || status === 'stalled') ? { status, leased } : null } };
}

// Counter growth between two samples; a drop means the counter was reset, so the step is unknown.
const growth = (current: number | undefined, previous: number | undefined) =>
  current === undefined || previous === undefined || current < previous ? null : current - previous;

function applyWindow(value: unknown): ApplyWindow {
  const totals = isRecord(value) && isRecord(value.totals) ? value.totals : {};
  const failures = isRecord(value) && isRecord(value.failures) ? value.failures : {};
  return {
    applied: num(totals.applied),
    closed: num(totals.closed),
    failures: Object.fromEntries(Object.entries(failures).flatMap(([kind, count]) => (kind.startsWith('last_') ? [] : [[kind, num(count)]]))),
  };
}

export function summarizeOperations(history: unknown, applyDay: unknown, applyWeek: unknown, now = Date.now()): Operations {
  const raw = isRecord(history) && Array.isArray(history.samples) ? history.samples : [];
  const samples = raw.flatMap(sample => usableSample(sample) ?? []).sort((a, b) => a.at.localeCompare(b.at));
  const endHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const startHour = endHour - 7 * 24 * HOUR_MS;

  type Flow = 'completed' | 'enqueued' | 'shed' | 'published';
  type Bucket = Record<Flow, number | null> & { reviewPending: number; publicationPending: number; leased: number | null; handoff: Handoff | null };
  const buckets = new Map<number, Bucket>();
  let reviewOffers: Operations['reviewOffers'] = null;
  let previous: Sample | null = null;
  for (const sample of samples) {
    const time = Date.parse(sample.at);
    if (time > now) continue;
    const hour = Math.floor(time / HOUR_MS) * HOUR_MS;
    if (hour < startHour) {
      previous = sample;
      continue;
    }
    const { review, publication, handoff } = sample.exact_review;
    const bucket = buckets.get(hour) ?? { completed: null, enqueued: null, shed: null, published: null, reviewPending: 0, publicationPending: 0, leased: null, handoff: null };
    // Count a step only across a normal sample interval; a long gap would pile hours of work into one point.
    if (previous && time > Date.parse(previous.at) && time - Date.parse(previous.at) <= 2 * SAMPLE_MS) {
      const prior = previous.exact_review;
      const steps: Record<Flow, number | null> = {
        completed: growth(review.completed_total, prior.review.completed_total),
        enqueued: growth(review.enqueued_total, prior.review.enqueued_total),
        shed: growth(review.shed_total, prior.review.shed_total),
        published: growth(publication.published_total, prior.publication.published_total),
      };
      for (const key of Object.keys(steps) as Flow[]) {
        const step = steps[key];
        if (step !== null) bucket[key] = (bucket[key] ?? 0) + step;
      }
      // Ratios need the same observed intervals on both sides. Independent
      // hourly totals can otherwise turn a missing denominator into 100% shed.
      if (hour < endHour && steps.enqueued !== null && steps.shed !== null) {
        reviewOffers ??= { accepted: 0, shed: 0 };
        reviewOffers.accepted += steps.enqueued;
        reviewOffers.shed += steps.shed;
      }
    }
    bucket.reviewPending = Math.max(bucket.reviewPending, review.pending);
    bucket.publicationPending = Math.max(bucket.publicationPending, publication.pending);
    if (handoff) {
      bucket.leased = Math.max(bucket.leased ?? 0, handoff.leased);
      if (bucket.handoff === null || HANDOFF_RANK[handoff.status] > HANDOFF_RANK[bucket.handoff]) bucket.handoff = handoff.status;
    }
    buckets.set(hour, bucket);
    previous = sample;
  }

  const hours: OperationsHour[] = [];
  for (let hour = startHour; hour <= endHour; hour += HOUR_MS) {
    const bucket = buckets.get(hour);
    hours.push({
      hour: new Date(hour).toISOString(),
      completed: bucket?.completed ?? null,
      enqueued: bucket?.enqueued ?? null,
      shed: bucket?.shed ?? null,
      published: bucket?.published ?? null,
      reviewPending: bucket ? bucket.reviewPending : null,
      publicationPending: bucket ? bucket.publicationPending : null,
      leased: bucket ? bucket.leased : null,
      handoff: bucket ? bucket.handoff : null,
    });
  }

  // Incidents: consecutive unhealthy samples, merged across one missing sample. Idle and healthy end one.
  const incidents: Incident[] = [];
  const handoffSamples = { observed: 0, unhealthy: 0 };
  let open: { start: number; end: number; worst: 'degraded' | 'stalled' } | null = null;
  const close = () => {
    if (open) incidents.push({ start: new Date(open.start).toISOString(), end: new Date(open.end).toISOString(), minutes: Math.max(5, Math.round((open.end - open.start) / 60_000) + 5), worst: open.worst });
    open = null;
  };
  for (const sample of samples) {
    const time = Date.parse(sample.at);
    if (time < startHour || time > now || !sample.exact_review.handoff) continue;
    const status = sample.exact_review.handoff.status;
    handoffSamples.observed++;
    if (!unhealthy(status)) {
      close();
      continue;
    }
    handoffSamples.unhealthy++;
    if (open && time - open.end <= 2 * SAMPLE_MS) {
      open.end = time;
      if (HANDOFF_RANK[status] > HANDOFF_RANK[open.worst]) open.worst = status;
    } else {
      close();
      open = { start: time, end: time, worst: status };
    }
  }
  close();

  const coverage = isRecord(history) && isRecord(history.coverage) ? history.coverage : {};
  const week = isRecord(applyWeek) && isRecord(applyWeek.failures) ? applyWeek.failures : {};
  const lastKind = week.last_failure_kind;
  const lastAt = week.last_failure_at;
  return {
    generatedAt: new Date(now).toISOString(),
    windowStart: new Date(startHour).toISOString(),
    hours,
    reviewOffers,
    incidents: incidents.reverse(),
    coverage: { percent: num(coverage.coverage_percent), failedSlots: num(coverage.failed_slots), missingSlots: num(coverage.missing_slots) },
    handoffSamples,
    apply: {
      day: applyWindow(applyDay),
      week: applyWindow(applyWeek),
      lastFailure: typeof lastKind === 'string' && typeof lastAt === 'string' ? { kind: lastKind, at: lastAt } : null,
    },
  };
}
