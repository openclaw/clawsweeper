// Incremental GitHub Actions history for the dashboard.
//
// The state file keeps, per workflow and UTC hour, the run count, conclusion counts and
// completed-run durations. Each build rereads the last REFRESH_HOURS whole hours (so runs that
// were still in progress get their final conclusion) and replaces exactly those hours.
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

type Bucket = { count: number; conclusions: Record<string, number>; durations: number[] };
type WorkflowState = { file: string; hours: Record<string, Bucket> };
export type ActionsState = { version: 2; coveredFrom: string; updatedAt: string; workflows: Record<string, WorkflowState> };

type ApiRun = {
  id: number;
  path: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
};
type RunsPage = { total_count: number; workflow_runs: ApiRun[] };

async function github(path: string, token: string): Promise<RunsPage> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.ok) return (await response.json()) as RunsPage;
    const retryable = response.status >= 500 || response.status === 403 || response.status === 429;
    if (attempt >= 4 || !retryable) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
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
  const from = previous ? currentHour - REFRESH_HOURS * HOUR_MS : currentHour - BOOTSTRAP_DAYS * DAY_MS;
  const fresh: Record<string, { file: string; hours: Record<string, Bucket> }> = {};
  const seen = new Set<number>();
  const hours: number[] = [];
  for (let start = from; start <= currentHour; start += HOUR_MS) hours.push(start);
  // A bootstrap reads ~50 hours; read eight at a time to stay well inside the job timeout.
  const batches: ApiRun[][] = [];
  for (let index = 0; index < hours.length; index += FETCH_CONCURRENCY) {
    const slice = hours.slice(index, index + FETCH_CONCURRENCY);
    batches.push(...(await Promise.all(slice.map(start => runsCreated(start, start + HOUR_MS, token)))));
  }
  for (const batch of batches) {
    for (const run of batch) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      const file = run.path.replace(/^\.github\/workflows\//, '');
      const id = file.replace(/\.ya?ml$/, '');
      const hour = `${run.created_at.slice(0, 13)}:00:00Z`;
      const bucket = (((fresh[id] ??= { file, hours: {} }).hours)[hour] ??= { count: 0, conclusions: {}, durations: [] });
      bucket.count++;
      if (run.conclusion) bucket.conclusions[run.conclusion] = (bucket.conclusions[run.conclusion] ?? 0) + 1;
      const seconds = (Date.parse(run.updated_at) - Date.parse(run.run_started_at ?? '')) / 1000;
      if (run.status === 'completed' && Number.isFinite(seconds) && seconds >= 0) bucket.durations.push(Math.round(seconds));
    }
  }

  const state: ActionsState = previous ?? { version: 2, coveredFrom: new Date(from).toISOString(), updatedAt: '', workflows: {} };
  const firstRefreshed = new Date(from).toISOString();
  // Replace every refreshed hour, including hours that now have no runs.
  for (const workflow of Object.values(state.workflows)) {
    for (const hour of Object.keys(workflow.hours)) if (hour >= firstRefreshed) delete workflow.hours[hour];
  }
  for (const [id, workflow] of Object.entries(fresh)) {
    const target = (state.workflows[id] ??= { file: workflow.file, hours: {} });
    Object.assign(target.hours, workflow.hours);
  }
  const oldest = new Date(Math.floor((now - WINDOW_DAYS * DAY_MS) / DAY_MS) * DAY_MS).toISOString();
  for (const [id, workflow] of Object.entries(state.workflows)) {
    for (const hour of Object.keys(workflow.hours)) if (hour < oldest) delete workflow.hours[hour];
    if (!Object.keys(workflow.hours).length) delete state.workflows[id];
  }
  if (state.coveredFrom < oldest) state.coveredFrom = oldest;
  state.updatedAt = new Date(now).toISOString();
  return state;
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null);

export function summarizeActions(state: ActionsState) {
  const workflows = Object.entries(state.workflows).map(([id, workflow]) => {
    const byDay = new Map<string, Bucket>();
    for (const [hour, bucket] of Object.entries(workflow.hours)) {
      const day = byDay.get(hour.slice(0, 10)) ?? { count: 0, conclusions: {}, durations: [] };
      day.count += bucket.count;
      for (const [conclusion, count] of Object.entries(bucket.conclusions)) day.conclusions[conclusion] = (day.conclusions[conclusion] ?? 0) + count;
      day.durations.push(...bucket.durations);
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
        return { date, count: day.count, conclusions: day.conclusions, durationSeconds: { p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) } };
      });
    all.sort((a, b) => a - b);
    return { id, file: workflow.file, totalRuns, conclusionCounts, durationSeconds: { p50: quantile(all, 0.5), p90: quantile(all, 0.9) }, days };
  });
  workflows.sort((a, b) => b.totalRuns - a.totalRuns);
  return { coveredFrom: state.coveredFrom, windowEnd: state.updatedAt, workflows };
}
