import { execFileSync } from "node:child_process";

import type { JsonValue, LooseRecord } from "./json-types.js";
import { EXACT_REVIEW_CLOSE_GUARD_LABELS } from "./exact-review-guard-labels.js";

export const UMBRELLA_PROPOSAL_MARKER = "<!-- clawsweeper:umbrella-proposals -->";
export const UMBRELLA_PROPOSAL_TITLE = "Umbrella consolidation proposals";
export const UMBRELLA_PROPOSAL_AUTHOR_LOGIN = "clawsweeper[bot]";
export const NEEDS_PRODUCT_DECISION_LABEL = "clawsweeper:needs-product-decision";
export const IDEA_ARCHIVE_LABEL = "clawsweeper:idea-archive";
export const DEFAULT_UMBRELLA_MIN_CLUSTER_SIZE = 5;
export const DEFAULT_UMBRELLA_MAX_PROPOSALS = 10;
export const DEFAULT_UMBRELLA_MAX_MEMBERS_PER_PROPOSAL = 20;
export const DEFAULT_UMBRELLA_PROPOSAL_BODY_MAX_CHARS = 60_000;
export const MAX_SUGGESTED_UMBRELLA_TITLE_LENGTH = 120;
// Headroom kept while accepting sections so a truncation note can always be
// appended without slicing accepted content (note text + cluster id + counts).
export const PROPOSAL_TRUNCATION_NOTE_RESERVE = 220;

const PROTECTED_LABELS = new Set(
  [...EXACT_REVIEW_CLOSE_GUARD_LABELS, IDEA_ARCHIVE_LABEL].map((label) => label.toLowerCase()),
);
const TITLE_STOP_WORDS = new Set([
  "a",
  "add",
  "allow",
  "an",
  "and",
  "for",
  "feature",
  "from",
  "in",
  "into",
  "of",
  "on",
  "request",
  "support",
  "the",
  "to",
  "with",
]);

export type ClusterMember = {
  clusterId: number;
  number: number;
  kind: string;
  state: string;
  title: string;
  author: string;
  labels: string[];
};

export type UmbrellaProposal = {
  clusterId: string;
  title: string;
  members: ClusterMember[];
};

export function readGitcrawlClusterMembers(dbPath: string): ClusterMember[] {
  const source = detectClusterSource(dbPath);
  const sql =
    source === "portable"
      ? `
        select cg.id as cluster_id, t.number, t.kind, t.state, t.title,
               coalesce(t.author_login, '') as author_login, t.labels_json
        from cluster_groups cg
        join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
        join threads t on t.id = cm.thread_id
        where cg.status = 'active'
        order by cg.id, t.number;
      `
      : `
        select c.id as cluster_id, t.number, t.kind, t.state, t.title,
               coalesce(t.author_login, '') as author_login, t.labels_json
        from clusters c
        join cluster_members cm on cm.cluster_id = c.id
        join threads t on t.id = cm.thread_id
        where c.closed_at_local is null
        order by c.id, t.number;
      `;
  return sqliteJson(dbPath, sql).flatMap(normalizeClusterMember);
}

export function selectUmbrellaProposals(
  members: ClusterMember[],
  options: { minClusterSize?: number; maxProposals?: number } = {},
): UmbrellaProposal[] {
  const minClusterSize = positiveInteger(options.minClusterSize, DEFAULT_UMBRELLA_MIN_CLUSTER_SIZE);
  const maxProposals = positiveInteger(options.maxProposals, DEFAULT_UMBRELLA_MAX_PROPOSALS);
  const byCluster = new Map<number, ClusterMember[]>();
  for (const member of members) {
    if (member.kind !== "issue" || member.state !== "open") continue;
    if (umbrellaMemberBlockReason(member.labels)) continue;
    const cluster = byCluster.get(member.clusterId) ?? [];
    cluster.push(member);
    byCluster.set(member.clusterId, cluster);
  }
  return [...byCluster.entries()]
    .map(([clusterId, eligible]) => ({
      clusterId: stableClusterId(clusterId),
      title: suggestedUmbrellaTitle(eligible.map((member) => member.title)),
      members: eligible.sort((left, right) => left.number - right.number),
    }))
    .filter((proposal) => proposal.members.length >= minClusterSize)
    .sort(
      (left, right) =>
        right.members.length - left.members.length ||
        parseStableClusterId(left.clusterId) - parseStableClusterId(right.clusterId),
    )
    .slice(0, maxProposals);
}

export function suggestedUmbrellaTitle(titles: string[]): string {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const unique = new Set(
      title
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9+._-]*/g)
        ?.filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token)) ?? [],
    );
    for (const token of unique) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    ([leftToken, leftCount], [rightToken, rightCount]) =>
      rightCount - leftCount || leftToken.localeCompare(rightToken),
  );
  const repeated = ranked.filter(([, count]) => count > 1);
  const selected = (repeated.length > 0 ? repeated : ranked).slice(0, 5).map(([token]) => token);
  const themeTokens =
    selected.length > 0 ? selected.map(titleCaseToken) : ["Related", "feature", "requests"];
  return boundedSuggestedTitle(themeTokens);
}

export function selectAppAuthoredUmbrellaProposalIssue(
  issues: JsonValue[],
  authorLogin = UMBRELLA_PROPOSAL_AUTHOR_LOGIN,
): number | null {
  const candidates = issues
    .filter(
      (issue): issue is LooseRecord =>
        Boolean(issue) && typeof issue === "object" && !Array.isArray(issue),
    )
    .filter(
      (issue) =>
        !issue.pull_request &&
        String(issue.state ?? "").toLowerCase() === "open" &&
        String(issue.user?.login ?? "") === authorLogin &&
        (String(issue.body ?? "").includes(UMBRELLA_PROPOSAL_MARKER) ||
          String(issue.title ?? "") === UMBRELLA_PROPOSAL_TITLE),
    )
    .sort((left, right) => {
      const leftMarked = String(left.body ?? "").includes(UMBRELLA_PROPOSAL_MARKER);
      const rightMarked = String(right.body ?? "").includes(UMBRELLA_PROPOSAL_MARKER);
      return Number(rightMarked) - Number(leftMarked) || Number(left.number) - Number(right.number);
    });
  const number = Number(candidates[0]?.number);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function renderUmbrellaProposals(
  proposals: UmbrellaProposal[],
  options: {
    targetRepo: string;
    generatedAt?: string;
    maxMembersPerCluster?: number;
    maxBodyChars?: number;
  } = { targetRepo: "openclaw/openclaw" },
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const maxMembersPerCluster = positiveInteger(
    options.maxMembersPerCluster,
    DEFAULT_UMBRELLA_MAX_MEMBERS_PER_PROPOSAL,
  );
  const maxBodyChars = positiveInteger(
    options.maxBodyChars,
    DEFAULT_UMBRELLA_PROPOSAL_BODY_MAX_CHARS,
  );
  let body = [
    UMBRELLA_PROPOSAL_MARKER,
    "# Umbrella consolidation proposals",
    "",
    `Generated ${generatedAt}. Proposal generation is read-only against \`${options.targetRepo}\`.`,
    "This report does not mutate target issues.",
  ].join("\n");

  if (proposals.length === 0) {
    return boundedProposalBody(
      `${body}\n\nNo eligible clusters met the configured threshold.`,
      maxBodyChars,
    );
  }

  for (const [index, proposal] of proposals.entries()) {
    const renderedMembers = proposal.members.slice(0, maxMembersPerCluster);
    const hiddenMembers = proposal.members.length - renderedMembers.length;
    const section = [
      `## ${proposal.clusterId}: ${neutralizeProposalText(proposal.title)}`,
      "",
      `${proposal.members.length} eligible open issues in \`${options.targetRepo}\`.`,
      "",
      "A maintainer can consolidate these manually or wait for the upcoming consolidation command.",
      "",
      ...renderedMembers.map(
        (member) =>
          `- https://github.com/${options.targetRepo}/issues/${member.number} ${neutralizeProposalText(member.title)}`,
      ),
      ...(hiddenMembers > 0 ? [`...and ${hiddenMembers} more eligible member(s).`] : []),
    ].join("\n");
    const candidate = `${body}\n\n${section}`;
    // Reserve room for a possible truncation note whenever later sections
    // remain, so the note never has to slice an already accepted section.
    const isLastProposal = index === proposals.length - 1;
    const fits = isLastProposal
      ? candidate.length <= maxBodyChars
      : candidate.length + PROPOSAL_TRUNCATION_NOTE_RESERVE <= maxBodyChars;
    if (fits) {
      body = candidate;
      continue;
    }
    const omittedClusters = proposals.length - index;
    return appendProposalTruncationNote(
      body,
      `_Proposal body limit reached; ${omittedClusters} cluster section(s), starting with \`${proposal.clusterId}\`, were omitted._`,
      maxBodyChars,
    );
  }
  return body;
}

export function neutralizeProposalText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/([`[\]_*~])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b");
}

function normalizeClusterMember(row: LooseRecord): ClusterMember[] {
  const clusterId = Number(row.cluster_id);
  const number = Number(row.number);
  if (!Number.isSafeInteger(clusterId) || !Number.isSafeInteger(number)) return [];
  return [
    {
      clusterId,
      number,
      kind: String(row.kind ?? ""),
      state: String(row.state ?? "").toLowerCase(),
      title: String(row.title ?? "").trim(),
      author: String(row.author_login ?? "").trim(),
      labels: jsonStringArray(row.labels_json),
    },
  ];
}

function umbrellaMemberBlockReason(labels: string[]): string | null {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  if (!normalized.has(NEEDS_PRODUCT_DECISION_LABEL)) {
    return `missing ${NEEDS_PRODUCT_DECISION_LABEL}`;
  }
  const protectedLabel = [...normalized].find((label) => PROTECTED_LABELS.has(label));
  return protectedLabel ? `protected label: ${protectedLabel}` : null;
}

function stableClusterId(clusterId: number): string {
  if (!Number.isSafeInteger(clusterId) || clusterId <= 0)
    throw new Error("cluster id must be positive");
  return `gitcrawl-${clusterId}`;
}

function parseStableClusterId(clusterId: string): number {
  const match = clusterId.match(/^gitcrawl-([1-9]\d*)$/);
  const number = Number(match?.[1]);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid cluster id");
  return number;
}

function boundedProposalBody(body: string, maxBodyChars: number): string {
  if (body.length <= maxBodyChars) return body;
  return appendProposalTruncationNote(
    body,
    "_Proposal body limit reached; report content was truncated._",
    maxBodyChars,
  );
}

function appendProposalTruncationNote(body: string, note: string, maxBodyChars: number): string {
  const suffix = `\n\n${note}`;
  if (suffix.length >= maxBodyChars) return body.slice(0, maxBodyChars);
  const prefix = body.slice(0, maxBodyChars - suffix.length).trimEnd();
  return `${prefix}${suffix}`;
}

function titleCaseToken(token: string): string {
  return token.length > 0 ? `${token[0]?.toUpperCase()}${token.slice(1)}` : token;
}

function boundedSuggestedTitle(themeTokens: string[]): string {
  const prefix = "Umbrella:";
  const selected: string[] = [];
  for (const token of themeTokens) {
    const candidate = `${prefix} ${[...selected, token].join(" ")}`;
    if (candidate.length > MAX_SUGGESTED_UMBRELLA_TITLE_LENGTH) break;
    selected.push(token);
  }
  if (selected.length === 0) return "Umbrella: Related feature requests";
  return `${prefix} ${selected.join(" ")}`;
}

function detectClusterSource(dbPath: string): "portable" | "legacy" {
  const legacyTable = Number(
    sqliteScalar(
      dbPath,
      "select count(*) from sqlite_master where type = 'table' and name = 'clusters';",
    ),
  );
  if (legacyTable > 0 && Number(sqliteScalar(dbPath, "select count(*) from clusters;")) > 0) {
    return "legacy";
  }
  const portableTable = Number(
    sqliteScalar(
      dbPath,
      "select count(*) from sqlite_master where type = 'table' and name = 'cluster_groups';",
    ),
  );
  // Schema is detected by table existence: a valid snapshot with zero clusters
  // must produce the "no eligible clusters" report, not abort the workflow.
  if (portableTable > 0) return "portable";
  if (legacyTable > 0) return "legacy";
  throw new Error("gitcrawl database has no supported cluster tables");
}

function sqliteJson(dbPath: string, sql: string): LooseRecord[] {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  const parsed: JsonValue = JSON.parse(output || "[]");
  return Array.isArray(parsed) ? (parsed as LooseRecord[]) : [];
}

function sqliteScalar(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
}

function jsonStringArray(value: JsonValue): string[] {
  try {
    const parsed: JsonValue = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error("limit must be a positive integer");
  return number;
}
