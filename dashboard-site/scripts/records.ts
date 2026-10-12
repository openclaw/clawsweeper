// Aggregate the canonical review records (hydrated from the Worker's R2 snapshots) into the
// dashboard corpus. Reads only each report's front matter, one file at a time, and keeps
// public repositories only. No report bodies, author identities or free-text concerns leave here.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const DAY_MS = 86_400_000;
const LIST_LIMIT = 500;
const VISIBILITY_TTL_MS = DAY_MS;

export type Visibility = Record<string, { public: boolean; checkedAt: string }>;
type Counts = Record<string, number>;
type Row = {
  repo: string;
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  url: string;
  reviewedAt: string | null;
  createdAt: string | null;
  archived: boolean;
  decision: string | null;
  closeReason: string | null;
  proof: string | null;
  security: string | null;
  maintainerKind: string | null;
};
type RepoStats = {
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
  decisions: Counts;
};
// The typed review record fields this aggregate reads. Every field is optional because
// records come from storage written by many code versions.
type ReviewDecision = {
  decision?: string;
  closeReason?: string;
  confidence?: string;
  prRating?: { overallTier?: string };
  realBehaviorProof?: { status?: string };
  securityReview?: { status?: string };
  maintainerDecision?: { required?: boolean; kind?: string };
  reviewFindings?: { priority?: number }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// Version-1 review_record front matter; anything else counts as missing typed evidence.
// Stored records are trusted ClawSweeper output, so the guard checks the version only.
const typedDecision = (record: unknown): ReviewDecision | null =>
  isObject(record) && record.version === 1 && isObject(record.decision) ? (record.decision as ReviewDecision) : null;

const bump = (counts: Counts, key: unknown) => {
  if (typeof key === 'string' && key && key !== 'unknown') counts[key] = (counts[key] ?? 0) + 1;
};
const parseScalar = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const quantiles = (values: number[]) => {
  values.sort((a, b) => a - b);
  const at = (q: number) => (values.length ? values[Math.floor((values.length - 1) * q)] : null);
  return { count: values.length, p50: at(0.5), p90: at(0.9) };
};

async function frontMatter(path: string) {
  const attrs: Record<string, unknown> = {};
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let started = false;
  try {
    for await (const line of lines) {
      if (!started) {
        if (line !== '---') break;
        started = true;
        continue;
      }
      if (line === '---') break;
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      attrs[key] = key === 'review_record' || key === 'title' ? parseScalar(value) : value;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return attrs;
}

async function isPublic(repo: string, visibility: Visibility, token: string | undefined, now: number) {
  const cached = visibility[repo];
  if (cached && now - Date.parse(cached.checkedAt) < VISIBILITY_TTL_MS) return cached.public;
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let result = false;
  if (response.ok) {
    const metadata = (await response.json()) as { private?: boolean; visibility?: string };
    result = metadata.private === false && metadata.visibility !== 'private';
  } else if (response.status !== 404) {
    // Keep the last known answer through a transient failure; never assume public.
    if (cached) return cached.public;
    throw new Error(`Repository visibility check for ${repo}: HTTP ${response.status}`);
  }
  visibility[repo] = { public: result, checkedAt: new Date(now).toISOString() };
  return result;
}

export async function aggregateRecords(root: string, visibility: Visibility, token: string | undefined, nowMs = Date.now()) {
  const date = (value: unknown) => {
    const time = Date.parse(String(value ?? ''));
    return Number.isFinite(time) && time > Date.UTC(2020, 0, 2) && time <= nowMs + 60_000 ? new Date(time).toISOString() : null;
  };
  const distributions: Record<string, Counts> = Object.fromEntries(
    ['decisions', 'closeReasons', 'confidence', 'ratings', 'findings', 'proof', 'security', 'maintainerKinds', 'policies'].map(key => [key, {}]),
  );
  const totals = { records: 0, typed: 0, missingTyped: 0, open: 0, archived: 0, repositories: 0 };
  const days = new Map<string, { date: string; reviewed: number; archived: number }>();
  const repos: RepoStats[] = [];
  const lists: Record<'maintainer' | 'security' | 'stale', Row[]> = { maintainer: [], security: [], stale: [] };
  const codexMs: number[] = [];
  const createdToReviewHours: number[] = [];
  const recordedCloses = { total: 0, byReason: {} as Counts, days: new Map<string, { date: string; count: number; byReason: Counts }>(), recent: [] as (Row & { closedAt: string })[] };
  // Apply also writes action_taken: closed when it finds the item already closed on GitHub
  // (merged, or closed by a maintainer). Only a close decision means ClawSweeper closed it.
  const closedElsewhere = { total: 0, days: new Map<string, number>() };
  let excludedRepositories = 0;
  const keep = (list: Row[], row: Row, newestFirst: boolean) => {
    list.push(row);
    if (list.length > LIST_LIMIT * 2) {
      list.sort((a, b) => (newestFirst ? -1 : 1) * String(a.reviewedAt ?? '').localeCompare(String(b.reviewedAt ?? '')));
      list.length = LIST_LIMIT;
    }
  };

  repositories: for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const repoStats: RepoStats = { repo: '', slug: directory.name, records: 0, typed: 0, open: 0, archived: 0, reviewed7d: 0, reviewed30d: 0, staleOpen: 0, missingTyped: 0, decisions: {} };
    let repoChecked = false;
    for (const area of ['items', 'closed'] as const) {
      let files: string[];
      try {
        files = await readdir(`${root}/${directory.name}/${area}`);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^\d+\.md$/.test(file)) continue;
        const attrs = await frontMatter(`${root}/${directory.name}/${area}/${file}`);
        const repo = typeof attrs.repository === 'string' ? attrs.repository : '';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue;
        if (!repoChecked) {
          repoChecked = true;
          // One repository per directory: a non-public one is excluded entirely.
          if (!(await isPublic(repo, visibility, token, nowMs))) {
            excludedRepositories++;
            continue repositories;
          }
        }
        const number = Number(attrs.number);
        if (!Number.isSafeInteger(number) || number < 1) continue;
        const kind = attrs.type === 'pull_request' ? 'pull_request' : 'issue';
        const reviewedAt = date(attrs.reviewed_at);
        const createdAt = date(attrs.item_created_at);
        const archived = area === 'closed';
        const decision = typedDecision(attrs.review_record);
        totals.records++;
        repoStats.records++;
        repoStats.repo = repo;
        totals[archived ? 'archived' : 'open']++;
        repoStats[archived ? 'archived' : 'open']++;
        const row: Row = {
          repo,
          number,
          kind,
          title: String(attrs.title || `${kind === 'issue' ? 'Issue' : 'Pull request'} ${number}`).slice(0, 300),
          url: `https://github.com/${repo}/${kind === 'pull_request' ? 'pull' : 'issues'}/${number}`,
          reviewedAt,
          createdAt,
          archived,
          decision: decision?.decision ?? null,
          closeReason: decision?.closeReason ?? null,
          proof: decision?.realBehaviorProof?.status ?? null,
          security: decision?.securityReview?.status ?? null,
          maintainerKind: decision?.maintainerDecision?.required ? decision.maintainerDecision.kind : null,
        };

        const closedAt = attrs.action_taken === 'closed' ? date(attrs.applied_at) : null;
        if (closedAt) {
          const day = closedAt.slice(0, 10);
          if (decision?.decision !== 'close') {
            closedElsewhere.total++;
            closedElsewhere.days.set(day, (closedElsewhere.days.get(day) ?? 0) + 1);
          } else {
            const reason = decision.closeReason || 'reason_not_recorded';
            recordedCloses.total++;
            bump(recordedCloses.byReason, reason);
            const closeDay = recordedCloses.days.get(day) ?? { date: day, count: 0, byReason: {} };
            closeDay.count++;
            bump(closeDay.byReason, reason);
            recordedCloses.days.set(day, closeDay);
            recordedCloses.recent.push({ ...row, closedAt });
            if (recordedCloses.recent.length > LIST_LIMIT * 2) {
              recordedCloses.recent.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
              recordedCloses.recent.length = LIST_LIMIT;
            }
          }
        }

        if (reviewedAt) {
          const age = nowMs - Date.parse(reviewedAt);
          if (age <= 7 * DAY_MS) repoStats.reviewed7d++;
          if (age <= 30 * DAY_MS) repoStats.reviewed30d++;
          if (!archived && age > 7 * DAY_MS) {
            repoStats.staleOpen++;
            keep(lists.stale, row, false);
          }
          const day = days.get(reviewedAt.slice(0, 10)) ?? { date: reviewedAt.slice(0, 10), reviewed: 0, archived: 0 };
          day.reviewed++;
          if (archived) day.archived++;
          days.set(day.date, day);
          if (createdAt && reviewedAt >= createdAt) createdToReviewHours.push((Date.parse(reviewedAt) - Date.parse(createdAt)) / 3_600_000);
        }
        const elapsed = Number(attrs.review_codex_elapsed_ms);
        if (Number.isFinite(elapsed) && elapsed > 0) codexMs.push(elapsed);
        bump(distributions.policies, attrs.review_policy);
        if (!decision) {
          totals.missingTyped++;
          repoStats.missingTyped++;
          continue;
        }
        totals.typed++;
        repoStats.typed++;
        bump(distributions.decisions, decision.decision);
        bump(repoStats.decisions, decision.decision);
        bump(distributions.closeReasons, decision.closeReason);
        bump(distributions.confidence, decision.confidence);
        bump(distributions.ratings, decision.prRating?.overallTier);
        bump(distributions.proof, decision.realBehaviorProof?.status);
        bump(distributions.security, decision.securityReview?.status);
        for (const finding of decision.reviewFindings ?? []) bump(distributions.findings, `P${finding.priority}`);
        if (!archived && decision.maintainerDecision?.required) {
          bump(distributions.maintainerKinds, decision.maintainerDecision.kind);
          keep(lists.maintainer, row, true);
        }
        if (!archived && decision.securityReview?.status === 'needs_attention') keep(lists.security, row, true);
      }
    }
    if (repoStats.records) repos.push(repoStats);
  }

  totals.repositories = repos.length;
  const byReviewedAt = (newestFirst: boolean) => (a: Row, b: Row) => (newestFirst ? -1 : 1) * String(a.reviewedAt ?? '').localeCompare(String(b.reviewedAt ?? ''));
  lists.stale = lists.stale.sort(byReviewedAt(false)).slice(0, LIST_LIMIT);
  lists.maintainer = lists.maintainer.sort(byReviewedAt(true)).slice(0, LIST_LIMIT);
  lists.security = lists.security.sort(byReviewedAt(true)).slice(0, LIST_LIMIT);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    totals,
    distributions,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    repos: repos.sort((a, b) => b.open - a.open),
    lists,
    timings: { codexMs: quantiles(codexMs), createdToReviewHours: quantiles(createdToReviewHours) },
    recordedCloses: {
      total: recordedCloses.total,
      byReason: recordedCloses.byReason,
      days: [...recordedCloses.days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      recent: recordedCloses.recent.sort((a, b) => b.closedAt.localeCompare(a.closedAt)).slice(0, LIST_LIMIT),
    },
    closedElsewhere: {
      total: closedElsewhere.total,
      days: [...closedElsewhere.days].map(([day, count]) => ({ date: day, count })).sort((a, b) => a.date.localeCompare(b.date)),
    },
    scope: { publicRepositories: repos.length, excludedRepositories },
  };
}
