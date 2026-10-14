// Incremental GitHub Actions history for the dashboard.
//
// The state file keeps, per workflow and UTC hour, the run count, conclusion counts and
// completed-run durations. Each build rereads every whole hour from REFRESH_HOURS before its
// last refresh (so runs still in progress then get their final conclusion) and replaces exactly those hours.
// A missing state file bootstraps BOOTSTRAP_DAYS of history; the window then grows to WINDOW_DAYS.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const REPOSITORY = 'openclaw/clawsweeper';
const WINDOW_DAYS = 30;
const BOOTSTRAP_DAYS = 2;
const REFRESH_HOURS = 3;
const FETCH_CONCURRENCY = 8;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// reviewDurations: for sweep only, durations of exact review runs ("Review exact item …"), the
// runs whose time an operator cares about. sweep.yml also runs short relay and apply jobs, and
// the mix shifts when jobs move between workflow files, so the all-runs median is unstable.
type Bucket = { count: number; conclusions: Record<string, number>; durations: number[]; reviewDurations?: number[] };
// reviewSamples: per day, sampled review durations for days whose hourly buckets have none.
type WorkflowState = { file: string; hours: Record<string, Bucket>; reviewSamples?: Record<string, number[]> };
export type ActionsState = { version: 2; coveredFrom: string; updatedAt: string; workflows: Record<string, WorkflowState> };

type ApiRun = {
  id: number;
  path: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
};
const runSeconds = (run: ApiRun) => {
  const seconds = (Date.parse(run.updated_at) - Date.parse(run.run_started_at ?? '')) / 1000;
  return run.status === 'completed' && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
};
const isReviewRun = (run: ApiRun) => run.display_title.startsWith('Review exact item ');
type RunsPage = { total_count: number; workflow_runs: ApiRun[] };

// Retries 5xx, rate limits and dropped connections (a socket can close mid-body), four tries.
async function github(path: string, token: string): Promise<RunsPage> {
  for (let attempt = 1; ; attempt++) {
    // status: the HTTP status, or null when the connection failed before a full response.
    let status: number | null = null;
    let failure: string;
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      status = response.status;
      if (response.ok) return (await response.json()) as RunsPage;
      failure = `HTTP ${response.status}`;
    } catch (error) {
      status = null;
      failure = error instanceof Error ? error.message : String(error);
    }
    const retryable = status === null || status >= 500 || status === 403 || status === 429;
    if (attempt >= 4 || !retryable) throw new Error(`GitHub ${path}: ${failure}`);
    await sleep(attempt * 5_000);
  }
}

// One runs query returns at most 1,000 runs, so split a busy slice in half until it fits.
async function runsCreated(from: number, to: number, token: string): Promise<ApiRun[]> {
  const range = encodeURIComponent(`${new Date(from).toISOString()}..${new Date(to - 1).toISOString()}`);
  const first = await github(`/repos/${REPOSITORY}/actions/runs?per_page=100&created=${range}`, token);
  if (first.total_count > 1_000 && to - from > 60_000) {
    const middle = from + Math.floor((to - from) / 2);
    return [...(await runsCreated(from, middle, token)), ...(await runsCreated(middle, to, token))];
  }
  const runs = [...first.workflow_runs];
  for (let page = 2; runs.length < first.total_count; page++) {
    const next = await github(`/repos/${REPOSITORY}/actions/runs?per_page=100&page=${page}&created=${range}`, token);
    if (!next.workflow_runs.length) break;
    runs.push(...next.workflow_runs);
  }
  return runs;
}

// Read whole hours eight at a time and fold them into per-workflow hourly buckets.
async function readHours(hours: number[], token: string) {
  const fresh: Record<string, WorkflowState> = {};
  const seen = new Set<number>();
  for (let index = 0; index < hours.length; index += FETCH_CONCURRENCY) {
    const slice = hours.slice(index, index + FETCH_CONCURRENCY);
    for (const batch of await Promise.all(slice.map(start => runsCreated(start, start + HOUR_MS, token)))) {
      for (const run of batch) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);
        const file = run.path.replace(/^\.github\/workflows\//, '');
        const id = file.replace(/\.ya?ml$/, '');
        const hour = `${run.created_at.slice(0, 13)}:00:00Z`;
        const bucket = (((fresh[id] ??= { file, hours: {} }).hours)[hour] ??= { count: 0, conclusions: {}, durations: [] });
        bucket.count++;
        if (run.conclusion) bucket.conclusions[run.conclusion] = (bucket.conclusions[run.conclusion] ?? 0) + 1;
        const seconds = runSeconds(run);
        if (seconds === null) continue;
        bucket.durations.push(seconds);
        if (id === 'sweep' && isReviewRun(run)) (bucket.reviewDurations ??= []).push(seconds);
      }
    }
  }
  return fresh;
}

// Replace exactly the hours in [from, to), including hours that now have no runs.
function replaceHours(state: ActionsState, fresh: Record<string, WorkflowState>, from: number, to: number) {
  const first = new Date(from).toISOString();
  const end = new Date(to).toISOString();
  for (const workflow of Object.values(state.workflows)) {
    for (const hour of Object.keys(workflow.hours)) if (hour >= first && hour < end) delete workflow.hours[hour];
  }
  for (const [id, workflow] of Object.entries(fresh)) Object.assign((state.workflows[id] ??= { file: workflow.file, hours: {} }).hours, workflow.hours);
}

export async function loadActionsState(path: string): Promise<ActionsState | null> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as ActionsState;
    return state.version === 2 ? state : null;
  } catch {
    return null;
  }
}

export async function saveActionsState(path: string, state: ActionsState) {
  await writeFile(path, JSON.stringify(state));
}

export async function refreshActions(previous: ActionsState | null, token: string, now = Date.now()): Promise<ActionsState> {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  // Reread from the last refresh (minus the overlap), so a late or failed build never leaves
  // a gap; bounded by the window, so a very old state costs at most one window of reads.
  const windowStart = Math.floor((now - WINDOW_DAYS * DAY_MS) / HOUR_MS) * HOUR_MS;
  const lastHour = Math.floor(Date.parse(previous?.updatedAt ?? '') / HOUR_MS) * HOUR_MS;
  const from = !previous
    ? currentHour - BOOTSTRAP_DAYS * DAY_MS
    : Math.max(windowStart, Math.min(currentHour, Number.isFinite(lastHour) ? lastHour : currentHour) - REFRESH_HOURS * HOUR_MS);
  const hours: number[] = [];
  for (let start = from; start <= currentHour; start += HOUR_MS) hours.push(start);
  const fresh = await readHours(hours, token);

  const state: ActionsState = previous ?? { version: 2, coveredFrom: new Date(from).toISOString(), updatedAt: '', workflows: {} };
  replaceHours(state, fresh, from, currentHour + HOUR_MS);
  const oldest = new Date(Math.floor((now - WINDOW_DAYS * DAY_MS) / DAY_MS) * DAY_MS).toISOString();
  for (const [id, workflow] of Object.entries(state.workflows)) {
    for (const hour of Object.keys(workflow.hours)) if (hour < oldest) delete workflow.hours[hour];
    for (const day of Object.keys(workflow.reviewSamples ?? {})) if (day < oldest.slice(0, 10)) delete workflow.reviewSamples![day];
    if (!Object.keys(workflow.hours).length) delete state.workflows[id];
  }
  if (state.coveredFrom < oldest) state.coveredFrom = oldest;
  state.updatedAt = new Date(now).toISOString();
  return state;
}

// Sweep history for days before the hourly history, on request. Reading every run of a past
// day costs ~150 requests; instead:
// - counts come from the API's total_count per conclusion. total_count is capped at 2,500, so
//   a range at the cap is split in half until it fits (~15 requests for success on a busy day,
//   1 for each rarer conclusion);
// - durations come from a sample: the newest page of 100 runs in each 4-hour slice (6 requests,
//   ~600 runs, ~300-430 of them reviews), enough for a stable p50/p90 but not every run.
// Each such day is one bucket at 00:00; a day with only that key is backfilled (a day of hourly
// history has many keys). The hourly refresh only rewrites recent hours, so it never touches them.
// Any complete day in the window whose hourly buckets carry no review durations (cached before
// they were recorded) gets the same sample in reviewSamples.
const SWEEP_CONCLUSIONS = ['success', 'failure', 'cancelled', 'startup_failure', 'skipped', 'timed_out'];
const COUNT_CAP = 2_500;
const SAMPLE_SLICES = 6;
export async function backfillSweepCounts(state: ActionsState, token: string, days: number, now = Date.now()) {
  const sweep = (state.workflows.sweep ??= { file: 'sweep.yml', hours: {} });
  const keysByDay = new Map<string, string[]>();
  for (const hour of Object.keys(sweep.hours)) keysByDay.set(hour.slice(0, 10), [...(keysByDay.get(hour.slice(0, 10)) ?? []), hour]);
  const isBackfilled = (date: string) => {
    const keys = keysByDay.get(date);
    return keys?.length === 1 && keys[0] === `${date}T00:00:00Z`;
  };
  // Only whole days before the first day of hourly history, inside the window.
  const hourlyDays = [...keysByDay.keys()].filter(date => !isBackfilled(date)).sort();
  const firstDay = Date.parse(`${hourlyDays[0] ?? new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const target = Math.floor((now - Math.min(days, WINDOW_DAYS) * DAY_MS) / DAY_MS) * DAY_MS;
  let requests = 0;
  const runs = async (from: number, to: number, query: string) => {
    requests++;
    const range = encodeURIComponent(`${new Date(from).toISOString()}..${new Date(to - 1).toISOString()}`);
    return github(`/repos/${REPOSITORY}/actions/workflows/sweep.yml/runs?created=${range}&${query}`, token);
  };
  const count = async (from: number, to: number, status: string): Promise<number> => {
    const total = (await runs(from, to, `status=${status}&per_page=1`)).total_count;
    if (total < COUNT_CAP || to - from <= 15 * 60_000) return total;
    const middle = from + Math.floor((to - from) / 2);
    return (await count(from, middle, status)) + (await count(middle, to, status));
  };
  const sampleDurations = async (day: number) => {
    const slice = DAY_MS / SAMPLE_SLICES;
    const pages = await Promise.all(Array.from({ length: SAMPLE_SLICES }, (_, index) => runs(day + index * slice, day + (index + 1) * slice, 'per_page=100')));
    const all: number[] = [];
    const review: number[] = [];
    for (const run of pages.flatMap(page => page.workflow_runs)) {
      const seconds = runSeconds(run);
      if (seconds === null) continue;
      all.push(seconds);
      if (isReviewRun(run)) review.push(seconds);
    }
    return { all, review };
  };
  const reviewSamples = (sweep.reviewSamples ??= {});
  for (let day = firstDay - DAY_MS; day >= target; day -= DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    const key = `${date}T00:00:00Z`;
    const existing = sweep.hours[key];
    // Days counted before durations were sampled only need the sample.
    if (existing) {
      if (!existing.durations.length || !reviewSamples[date]) {
        const sample = await sampleDurations(day);
        if (!existing.durations.length) existing.durations = sample.all;
        reviewSamples[date] = sample.review;
      }
      continue;
    }
    const counts = await Promise.all(SWEEP_CONCLUSIONS.map(status => count(day, day + DAY_MS, status)));
    const conclusions = Object.fromEntries(SWEEP_CONCLUSIONS.flatMap((status, index) => (counts[index] ? [[status, counts[index]]] : [])));
    const sample = await sampleDurations(day);
    // Past days have no runs in progress, so the conclusions add up to the day's total
    // (rare conclusions such as neutral or action_required are not counted).
    sweep.hours[key] = { count: counts.reduce((total, value) => total + value, 0), conclusions, durations: sample.all };
    reviewSamples[date] = sample.review;
  }
  // Complete days of hourly history recorded before review durations existed.
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  for (let day = Math.max(firstDay, target); day < today; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    const hasReviews = (keysByDay.get(date) ?? []).some(hour => sweep.hours[hour]?.reviewDurations?.length);
    if (!hasReviews && !reviewSamples[date]) reviewSamples[date] = (await sampleDurations(day)).review;
  }
  return { requests, from: new Date(target).toISOString().slice(0, 10) };
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null);

export function summarizeActions(state: ActionsState) {
  const workflows = Object.entries(state.workflows).map(([id, workflow]) => {
    const byDay = new Map<string, Bucket>();
    for (const [hour, bucket] of Object.entries(workflow.hours)) {
      const day = byDay.get(hour.slice(0, 10)) ?? { count: 0, conclusions: {}, durations: [], reviewDurations: [] };
      day.count += bucket.count;
      for (const [conclusion, count] of Object.entries(bucket.conclusions)) day.conclusions[conclusion] = (day.conclusions[conclusion] ?? 0) + count;
      day.durations.push(...bucket.durations);
      day.reviewDurations!.push(...(bucket.reviewDurations ?? []));
      byDay.set(hour.slice(0, 10), day);
    }
    const all: number[] = [];
    const conclusionCounts: Record<string, number> = {};
    let totalRuns = 0;
    const days = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => {
        totalRuns += day.count;
        for (const [conclusion, count] of Object.entries(day.conclusions)) conclusionCounts[conclusion] = (conclusionCounts[conclusion] ?? 0) + count;
        const sorted = day.durations.sort((a, b) => a - b);
        all.push(...sorted);
        // Recorded review durations win; a day with none falls back to its sample.
        const reviews = (day.reviewDurations!.length ? day.reviewDurations! : (workflow.reviewSamples?.[date] ?? [])).sort((a, b) => a - b);
        return {
          date,
          count: day.count,
          conclusions: day.conclusions,
          durationSeconds: { p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) },
          reviewSeconds: { p50: quantile(reviews, 0.5), p90: quantile(reviews, 0.9), samples: reviews.length },
        };
      });
    all.sort((a, b) => a - b);
    return { id, file: workflow.file, totalRuns, conclusionCounts, durationSeconds: { p50: quantile(all, 0.5), p90: quantile(all, 0.9) }, days };
  });
  workflows.sort((a, b) => b.totalRuns - a.totalRuns);
  return { coveredFrom: state.coveredFrom, windowEnd: state.updatedAt, workflows };
}
