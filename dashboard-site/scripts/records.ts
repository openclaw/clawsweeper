// Aggregate the canonical review records (hydrated from the Worker's R2 snapshots) into the
// dashboard corpus. Reads only each report's front matter, one file at a time, and keeps
// public repositories only. No report bodies, author identities or free-text concerns leave here.
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isRecord } from "./guards.ts";
import { isMaintainerAuthorAssociation } from "../../src/maintainer-review-policy.ts";

const DAY_MS = 86_400_000;
const LIST_LIMIT = 500;
const VISIBILITY_TTL_MS = DAY_MS;

export type Visibility = Record<string, { public: boolean; checkedAt: string }>;
type Counts = Record<string, number>;
type Row = {
  repo: string;
  number: number;
  kind: "issue" | "pull_request";
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

// Version-1 review_record front matter; anything else counts as missing typed evidence.
// Stored records are trusted ClawSweeper output, so the guard checks the version only.
const typedDecision = (record: unknown): ReviewDecision | null =>
  isRecord(record) && record.version === 1 && isRecord(record.decision)
    ? (record.decision as ReviewDecision)
    : null;

const bump = (counts: Counts, key: unknown) => {
  if (typeof key === "string" && key && key !== "unknown") counts[key] = (counts[key] ?? 0) + 1;
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
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let started = false;
  try {
    for await (const line of lines) {
      if (!started) {
        if (line !== "---") break;
        started = true;
        continue;
      }
      if (line === "---") break;
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      attrs[key] = key === "review_record" || key === "title" ? parseScalar(value) : value;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return attrs;
}

async function isPublic(
  repo: string,
  visibility: Visibility,
  token: string | undefined,
  now: number,
) {
  const cached = visibility[repo];
  if (cached && now - Date.parse(cached.checkedAt) < VISIBILITY_TTL_MS) return cached.public;
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  let result = false;
  if (response.ok) {
    const metadata = (await response.json()) as { private?: boolean; visibility?: string };
    result = metadata.private === false && metadata.visibility !== "private";
  } else if (response.status !== 404) {
    // Keep the last known answer through a transient failure; never assume public.
    if (cached) return cached.public;
    throw new Error(`Repository visibility check for ${repo}: HTTP ${response.status}`);
  }
  visibility[repo] = { public: result, checkedAt: new Date(now).toISOString() };
  return result;
}

type CloseRow = Row & { closedAt: string };
type ListName = "maintainer" | "security" | "stale";

// Everything one repository contributes to the corpus. The cache keeps these per repository, so
// a build can drop a repository that is no longer public and recompute every aggregate without it.
export type RepoCorpus = {
  stats: RepoStats;
  totals: { records: number; typed: number; missingTyped: number; open: number; archived: number };
  distributions: Record<string, Counts>;
  // maintainer: items whose author is an owner, member or collaborator, or that carry the
  // `maintainer` label (the same rule as the review policy). Absent in caches built before it.
  days: Record<string, { reviewed: number; archived: number; maintainer?: number }>;
  closes: {
    total: number;
    byReason: Counts;
    days: Record<string, { count: number; byReason: Counts }>;
    recent: CloseRow[];
  };
  closedElsewhere: Counts;
  lists: Record<ListName, Row[]>;
  codexMs: number[];
  createdToReviewHours: number[];
};
export type CorpusCache = {
  version: 2;
  generatedAt: string;
  excludedRepositories: number;
  repositories: RepoCorpus[];
};

const DISTRIBUTIONS = [
  "decisions",
  "closeReasons",
  "confidence",
  "ratings",
  "findings",
  "proof",
  "security",
  "maintainerKinds",
  "policies",
];
const newestReviewFirst = (a: Row, b: Row) =>
  String(b.reviewedAt ?? "").localeCompare(String(a.reviewedAt ?? ""));
const oldestReviewFirst = (a: Row, b: Row) => -newestReviewFirst(a, b);
const LIST_ORDER: Record<ListName, (a: Row, b: Row) => number> = {
  maintainer: newestReviewFirst,
  security: newestReviewFirst,
  stale: oldestReviewFirst,
};
const newestCloseFirst = (a: CloseRow, b: CloseRow) => b.closedAt.localeCompare(a.closedAt);
// Keep a bounded list while it grows: trim back to LIST_LIMIT whenever it doubles.
const keep = <T>(list: T[], row: T, order: (a: T, b: T) => number) => {
  list.push(row);
  if (list.length > LIST_LIMIT * 2) {
    list.sort(order);
    list.length = LIST_LIMIT;
  }
};
const top = <T>(list: T[], order: (a: T, b: T) => number) => list.sort(order).slice(0, LIST_LIMIT);
const addCounts = (target: Counts, source: Counts) => {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
};
const maintainerAuthored = (attrs: Record<string, unknown>) => {
  if (isMaintainerAuthorAssociation(attrs.author_association)) return true;
  const labels = parseScalar(String(attrs.labels ?? "[]"));
  return (
    Array.isArray(labels) &&
    labels.some((label) => typeof label === "string" && label.trim().toLowerCase() === "maintainer")
  );
};

export async function aggregateRecords(
  root: string,
  visibility: Visibility,
  token: string | undefined,
  nowMs = Date.now(),
): Promise<CorpusCache> {
  const date = (value: unknown) => {
    const time = Date.parse(String(value ?? ""));
    return Number.isFinite(time) && time > Date.UTC(2020, 0, 2) && time <= nowMs + 60_000
      ? new Date(time).toISOString()
      : null;
  };
  const repositories: RepoCorpus[] = [];
  let excludedRepositories = 0;

  repositories: for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const part: RepoCorpus = {
      stats: {
        repo: "",
        slug: directory.name,
        records: 0,
        typed: 0,
        open: 0,
        archived: 0,
        reviewed7d: 0,
        reviewed30d: 0,
        staleOpen: 0,
        missingTyped: 0,
        decisions: {},
      },
      totals: { records: 0, typed: 0, missingTyped: 0, open: 0, archived: 0 },
      distributions: Object.fromEntries(DISTRIBUTIONS.map((key) => [key, {}])),
      days: {},
      closes: { total: 0, byReason: {}, days: {}, recent: [] },
      closedElsewhere: {},
      lists: { maintainer: [], security: [], stale: [] },
      codexMs: [],
      createdToReviewHours: [],
    };
    const { stats, totals, distributions } = part;
    let repoChecked = false;
    for (const area of ["items", "closed"] as const) {
      let files: string[];
      try {
        files = await readdir(`${root}/${directory.name}/${area}`);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^\d+\.md$/.test(file)) continue;
        const attrs = await frontMatter(`${root}/${directory.name}/${area}/${file}`);
        const repo = typeof attrs.repository === "string" ? attrs.repository : "";
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
        const kind = attrs.type === "pull_request" ? "pull_request" : "issue";
        const reviewedAt = date(attrs.reviewed_at);
        const createdAt = date(attrs.item_created_at);
        const archived = area === "closed";
        const decision = typedDecision(attrs.review_record);
        stats.repo = repo;
        totals.records++;
        stats.records++;
        totals[archived ? "archived" : "open"]++;
        stats[archived ? "archived" : "open"]++;
        const row: Row = {
          repo,
          number,
          kind,
          title: String(
            attrs.title || `${kind === "issue" ? "Issue" : "Pull request"} ${number}`,
          ).slice(0, 300),
          url: `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
          reviewedAt,
          createdAt,
          archived,
          decision: decision?.decision ?? null,
          closeReason: decision?.closeReason ?? null,
          proof: decision?.realBehaviorProof?.status ?? null,
          security: decision?.securityReview?.status ?? null,
          maintainerKind: decision?.maintainerDecision?.required
            ? decision.maintainerDecision.kind
            : null,
        };

        // Apply also writes action_taken: closed when it archives an item someone else already
        // closed (merged, or closed by a maintainer, even after a close recommendation). That path
        // records GitHub's close time as current_item_closed_at; ClawSweeper's own close does not.
        // So only a close decision without current_item_closed_at counts as a ClawSweeper close.
        const externalClosedAt = date(attrs.current_item_closed_at);
        const closedAt =
          attrs.action_taken === "closed" ? (externalClosedAt ?? date(attrs.applied_at)) : null;
        if (closedAt) {
          const day = closedAt.slice(0, 10);
          if (externalClosedAt || decision?.decision !== "close") {
            part.closedElsewhere[day] = (part.closedElsewhere[day] ?? 0) + 1;
          } else {
            const reason = decision.closeReason || "reason_not_recorded";
            part.closes.total++;
            bump(part.closes.byReason, reason);
            const closeDay = (part.closes.days[day] ??= { count: 0, byReason: {} });
            closeDay.count++;
            bump(closeDay.byReason, reason);
            keep(part.closes.recent, { ...row, closedAt }, newestCloseFirst);
          }
        }

        if (reviewedAt) {
          const age = nowMs - Date.parse(reviewedAt);
          if (age <= 7 * DAY_MS) stats.reviewed7d++;
          if (age <= 30 * DAY_MS) stats.reviewed30d++;
          if (!archived && age > 7 * DAY_MS) {
            stats.staleOpen++;
            keep(part.lists.stale, row, LIST_ORDER.stale);
          }
          const day = (part.days[reviewedAt.slice(0, 10)] ??= {
            reviewed: 0,
            archived: 0,
            maintainer: 0,
          });
          day.reviewed++;
          if (archived) day.archived++;
          if (maintainerAuthored(attrs)) day.maintainer = (day.maintainer ?? 0) + 1;
          if (createdAt && reviewedAt >= createdAt)
            part.createdToReviewHours.push(
              Math.round((Date.parse(reviewedAt) - Date.parse(createdAt)) / 36_000) / 100,
            );
        }
        const elapsed = Number(attrs.review_codex_elapsed_ms);
        if (Number.isFinite(elapsed) && elapsed > 0) part.codexMs.push(Math.round(elapsed));
        bump(distributions.policies, attrs.review_policy);
        if (!decision) {
          totals.missingTyped++;
          stats.missingTyped++;
          continue;
        }
        totals.typed++;
        stats.typed++;
        bump(distributions.decisions, decision.decision);
        bump(stats.decisions, decision.decision);
        bump(distributions.closeReasons, decision.closeReason);
        bump(distributions.confidence, decision.confidence);
        bump(distributions.ratings, decision.prRating?.overallTier);
        bump(distributions.proof, decision.realBehaviorProof?.status);
        bump(distributions.security, decision.securityReview?.status);
        for (const finding of decision.reviewFindings ?? [])
          bump(distributions.findings, `P${finding.priority}`);
        if (!archived && decision.maintainerDecision?.required) {
          bump(distributions.maintainerKinds, decision.maintainerDecision.kind);
          keep(part.lists.maintainer, row, LIST_ORDER.maintainer);
        }
        if (!archived && decision.securityReview?.status === "needs_attention")
          keep(part.lists.security, row, LIST_ORDER.security);
      }
    }
    if (!stats.records) continue;
    for (const name of Object.keys(part.lists) as ListName[])
      part.lists[name] = top(part.lists[name], LIST_ORDER[name]);
    part.closes.recent = top(part.closes.recent, newestCloseFirst);
    repositories.push(part);
  }
  return {
    version: 2,
    generatedAt: new Date(nowMs).toISOString(),
    excludedRepositories,
    repositories,
  };
}

// The published corpus: every aggregate is recomputed from the kept repositories only.
export function combineCorpus(cache: CorpusCache, isKept: (repo: string) => boolean) {
  const kept = cache.repositories.filter((part) => isKept(part.stats.repo));
  const totals = {
    records: 0,
    typed: 0,
    missingTyped: 0,
    open: 0,
    archived: 0,
    repositories: kept.length,
  };
  const distributions: Record<string, Counts> = Object.fromEntries(
    DISTRIBUTIONS.map((key) => [key, {}]),
  );
  // A day's maintainer count is null when any repository's cache predates the field.
  const days: Record<string, { reviewed: number; archived: number; maintainer: number | null }> =
    {};
  const closes = {
    total: 0,
    byReason: {} as Counts,
    days: {} as Record<string, { count: number; byReason: Counts }>,
    recent: [] as CloseRow[],
  };
  const closedElsewhere: Counts = {};
  const lists: Record<ListName, Row[]> = { maintainer: [], security: [], stale: [] };
  const codexMs: number[] = [];
  const createdToReviewHours: number[] = [];
  for (const part of kept) {
    for (const key of Object.keys(part.totals) as (keyof RepoCorpus["totals"])[])
      totals[key] += part.totals[key];
    for (const key of DISTRIBUTIONS) addCounts(distributions[key], part.distributions[key] ?? {});
    for (const [day, count] of Object.entries(part.days)) {
      const target = (days[day] ??= { reviewed: 0, archived: 0, maintainer: 0 });
      target.reviewed += count.reviewed;
      target.archived += count.archived;
      target.maintainer =
        target.maintainer === null || count.maintainer === undefined
          ? null
          : target.maintainer + count.maintainer;
    }
    closes.total += part.closes.total;
    addCounts(closes.byReason, part.closes.byReason);
    for (const [day, count] of Object.entries(part.closes.days)) {
      const target = (closes.days[day] ??= { count: 0, byReason: {} });
      target.count += count.count;
      addCounts(target.byReason, count.byReason);
    }
    closes.recent.push(...part.closes.recent);
    addCounts(closedElsewhere, part.closedElsewhere);
    for (const name of Object.keys(lists) as ListName[]) lists[name].push(...part.lists[name]);
    codexMs.push(...part.codexMs);
    createdToReviewHours.push(...part.createdToReviewHours);
  }
  const byDate = <T>(record: Record<string, T>) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return {
    generatedAt: cache.generatedAt,
    totals,
    distributions,
    days: byDate(days).map(([day, count]) => ({ date: day, ...count })),
    repos: kept.map((part) => part.stats).sort((a, b) => b.open - a.open),
    lists: {
      maintainer: top(lists.maintainer, LIST_ORDER.maintainer),
      security: top(lists.security, LIST_ORDER.security),
      stale: top(lists.stale, LIST_ORDER.stale),
    },
    timings: { codexMs: quantiles(codexMs), createdToReviewHours: quantiles(createdToReviewHours) },
    recordedCloses: {
      total: closes.total,
      byReason: closes.byReason,
      days: byDate(closes.days).map(([day, count]) => ({ date: day, ...count })),
      recent: top(closes.recent, newestCloseFirst),
    },
    closedElsewhere: {
      total: Object.values(closedElsewhere).reduce((sum, count) => sum + count, 0),
      days: byDate(closedElsewhere).map(([day, count]) => ({ date: day, count })),
    },
    scope: {
      publicRepositories: kept.length,
      excludedRepositories: cache.excludedRepositories + cache.repositories.length - kept.length,
    },
  };
}
