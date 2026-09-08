#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { querySqliteRows, querySqliteScalar } from "../sqlite-readonly.js";
import { parseArgs, repoRoot } from "./lib.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import {
  existingGitcrawlClusterIds,
  existingGitcrawlMemberRefs,
} from "./gitcrawl-cluster-history.js";
import { resolveGitcrawlDbPath } from "./gitcrawl-store.js";

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? "openclaw/openclaw");
const mode = String(args.mode ?? "plan");
if (!["plan", "execute", "autonomous"].includes(mode)) {
  console.error("mode must be plan, execute, or autonomous");
  process.exit(2);
}
const outDir = path.resolve(
  String(args.out ?? path.join(repoRoot(), "jobs", repo.split("/")[0] ?? "unknown", "inbox")),
);
const dbPath = resolveGitcrawlDbPath(repo, typeof args.db === "string" ? args.db : undefined);
const suffix = typeof args.suffix === "string" ? args.suffix : "";
const allowInstantClose = booleanArg("allow-instant-close", false);
const editEnabledByDefault = mode === "autonomous" || mode === "execute";
const allowMerge = booleanArg("allow-merge", editEnabledByDefault);
const allowFixPr = booleanArg("allow-fix-pr", editEnabledByDefault);
const allowPostMergeClose = booleanArg("allow-post-merge-close", allowMerge || allowFixPr);
const skipExisting = args["skip-existing"] !== "false";
const allowEmpty = Boolean(args["allow-empty"]);
const fromGitcrawl = Boolean(args["from-gitcrawl"] || args["from-ghcrawl"] || args.all);
const limit = numberArg("limit", 40);
let clusterIds: number[] = args._.map((value: string) => Number(value)).filter(Boolean);
const selectingFromGitcrawl = clusterIds.length === 0 && fromGitcrawl;
const clusterSource = detectClusterSource();

if (selectingFromGitcrawl) clusterIds = selectClusterIds();

if (clusterIds.length === 0) {
  if (selectingFromGitcrawl && allowEmpty) {
    console.error("no unprocessed gitcrawl clusters found");
    process.exit(0);
  }
  console.error(
    "usage: node scripts/import-gitcrawl-clusters.ts <cluster-id> [...] [--from-gitcrawl] [--allow-empty] [--limit N] [--repo owner/repo] [--db path] [--out dir] [--mode plan|autonomous] [--suffix name] [--allow-instant-close] [--allow-merge true|false] [--allow-fix-pr true|false] [--allow-post-merge-close true|false]",
  );
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const historyRoots = [
  outDir,
  path.join(repoRoot(), "jobs", repo.split("/")[0] ?? "unknown"),
  path.join(repoRoot(), "results", repo.split("/")[0] ?? "unknown"),
  path.join(repoRoot(), "results", "cluster-repair-intake"),
];
const existingClusterIds = skipExisting
  ? existingGitcrawlClusterIds(historyRoots, repo)
  : new Set<number>();
const existingMemberRefs = skipExisting
  ? existingGitcrawlMemberRefs(historyRoots, repo)
  : new Map();
let createdCount = 0;

for (const clusterId of clusterIds) {
  if (selectingFromGitcrawl && createdCount >= limit) break;
  if (existingClusterIds.has(clusterId)) {
    console.error(`skip existing cluster: ${clusterId}`);
    continue;
  }

  const members = sqliteJson(memberSql(clusterId));

  if (members.length === 0) {
    console.error(`cluster not found: ${clusterId}`);
    continue;
  }
  const overlappingRefs = members
    .map((member: JsonValue) => Number(member.number))
    .filter((number: string) => existingMemberRefs.has(number));
  if (overlappingRefs.length > 0) {
    const examples = overlappingRefs
      .slice(0, 4)
      .map((number: string) => `#${number}`)
      .join(", ");
    const existingFiles = [
      ...new Set(overlappingRefs.flatMap((number: string) => existingMemberRefs.get(number) ?? [])),
    ];
    console.error(
      `skip existing member overlap cluster: ${clusterId} ${members[0].representative_title ?? ""} (${examples}${overlappingRefs.length > 4 ? ", ..." : ""}; ${existingFiles.slice(0, 2).join(", ")})`,
    );
    continue;
  }

  const first = members[0];
  const representative = {
    number: first.representative_number,
    kind: first.representative_kind,
    state: first.representative_state,
    title: first.representative_title,
  };
  const openMembers = members.filter((member: JsonValue) => member.state === "open");
  const closedMembers = members.filter((member: JsonValue) => member.state !== "open");
  if (openMembers.length === 0) {
    console.error(`skip closed-only cluster: ${clusterId} ${representative.title ?? ""}`);
    continue;
  }
  const issueCount = members.filter((member: JsonValue) => member.kind === "issue").length;
  const pullRequestCount = members.filter(
    (member: JsonValue) => member.kind === "pull_request",
  ).length;
  const latestUpdatedAt = members
    .map((member: JsonValue) => member.updated_at)
    .sort()
    .at(-1);
  const slug = slugify(representative.title || `cluster-${clusterId}`);
  const fileStem = suffix
    ? `gitcrawl-${clusterId}-${slugify(suffix)}`
    : `gitcrawl-${clusterId}-${slug}`;
  const filePath = path.join(outDir, `${fileStem}.md`);
  const clusterSlug = suffix
    ? `gitcrawl-${clusterId}-${slugify(suffix)}`
    : `gitcrawl-${clusterId}-${slug}`;
  const canonical = representative.number ? [`#${representative.number}`] : [];

  const markdown = [
    "---",
    `repo: ${repo}`,
    `cluster_id: ${clusterSlug}`,
    `mode: ${mode}`,
    renderJobIntentFrontmatter("repair_cluster"),
    "allowed_actions:",
    "  - comment",
    "  - label",
    "  - close",
    ...(allowMerge ? ["  - merge"] : []),
    ...(allowFixPr ? ["  - fix", "  - raise_pr"] : []),
    "blocked_actions:",
    "  - force_push",
    "  - bypass_checks",
    ...(allowMerge ? [] : ["  - merge"]),
    ...(allowFixPr ? [] : ["  - fix", "  - raise_pr"]),
    "require_human_for:",
    "  - security_sensitive",
    "  - failing_checks",
    "  - conflicting_prs",
    "  - unclear_canonical",
    "  - broad_code_delta",
    "canonical:",
    ...yamlList(canonical),
    "candidates:",
    ...yamlList(openMembers.map((member: JsonValue) => `#${member.number}`)),
    "cluster_refs:",
    ...yamlList(members.map((member: JsonValue) => `#${member.number}`)),
    "security_policy: central_security_only",
    "security_sensitive: false",
    ...(mode === "autonomous" || mode === "execute"
      ? [
          `allow_instant_close: ${allowInstantClose ? "true" : "false"}`,
          `allow_fix_pr: ${allowFixPr ? "true" : "false"}`,
          `allow_merge: ${allowMerge ? "true" : "false"}`,
          `allow_post_merge_close: ${allowPostMergeClose ? "true" : "false"}`,
          `require_fix_before_close: ${allowFixPr || allowMerge ? "true" : "false"}`,
        ]
      : []),
    `canonical_hint: ${quoteYaml(canonicalHint(representative))}`,
    `notes: ${quoteYaml(jobNotes(clusterId))}`,
    "---",
    "",
    `# Gitcrawl Cluster ${clusterId}`,
    "",
    `Generated from local gitcrawl run cluster ${clusterId} for \`${repo}\`.`,
    "",
    "Display title:",
    "",
    `> ${representative.title || "Untitled representative"}`,
    "",
    "Cluster shape from gitcrawl:",
    "",
    `- total members: ${members.length}`,
    `- issues: ${issueCount}`,
    `- pull requests: ${pullRequestCount}`,
    `- open candidates in local store: ${openMembers.length}`,
    `- representative: #${representative.number}, currently ${representative.state} in local store`,
    `- latest member update: ${latestUpdatedAt}`,
    "",
    "## Goal",
    "",
    goalText(mode),
    "",
    "## Member Inventory",
    "",
    "Closed context refs:",
    "",
    ...bulletList(closedMembers),
    "",
    "Open candidates:",
    "",
    ...bulletList(openMembers),
    "",
  ].join("\n");

  fs.writeFileSync(filePath, markdown);
  for (const member of members) {
    const number = Number(member.number);
    if (!Number.isSafeInteger(number)) continue;
    const files = existingMemberRefs.get(number) ?? [];
    files.push(path.relative(repoRoot(), filePath));
    existingMemberRefs.set(number, files);
  }
  createdCount += 1;
  console.log(path.relative(repoRoot(), filePath));
}
function selectClusterIds() {
  if (clusterSource === "portable") {
    return sqliteJson(`
      select
        cg.id,
        count(*) as member_count,
        sum(case when t.state = 'open' then 1 else 0 end) as open_count,
        sum(case when t.state != 'open' then 1 else 0 end) as closed_count
      from cluster_groups cg
      join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
      join threads t on t.id = cm.thread_id
      where cg.status = 'active'
      group by cg.id
      having open_count > 0
      order by max(case when t.state = 'open' then t.updated_at else '' end) desc, cg.id asc
    `)
      .map((row: JsonValue) => Number(row.id))
      .filter(Boolean);
  }
  return sqliteJson(`
    select
      c.id,
      count(*) as member_count,
      sum(case when t.state = 'open' then 1 else 0 end) as open_count,
      sum(case when t.state != 'open' then 1 else 0 end) as closed_count
    from clusters c
    join cluster_members cm on cm.cluster_id = c.id
    join threads t on t.id = cm.thread_id
    where c.closed_at_local is null
    group by c.id
    having open_count > 0
    order by max(case when t.state = 'open' then t.updated_at else '' end) desc, c.id asc
  `)
    .map((row: JsonValue) => Number(row.id))
    .filter(Boolean);
}

function memberSql(clusterId: JsonValue) {
  return memberSqlForClusterIds([clusterId]);
}

function memberSqlForClusterIds(clusterIds: JsonValue[]) {
  const idList = clusterIds.map(sqlNumber).join(",");
  if (clusterSource === "portable") {
    return `
      select
        cg.id as cluster_id,
        (
          select count(*)
          from cluster_memberships cm_count
          where cm_count.cluster_id = cg.id
            and cm_count.state = 'active'
        ) as member_count,
        cg.created_at as cluster_created_at,
        cg.closed_at as closed_at_local,
        cg.status as close_reason_local,
        rt.number as representative_number,
        rt.kind as representative_kind,
        rt.state as representative_state,
        rt.title as representative_title,
        t.number,
        t.kind,
        t.state,
        t.title,
        t.body_excerpt as body,
        t.labels_json,
        t.updated_at
      from cluster_groups cg
      join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
      join threads t on t.id = cm.thread_id
      left join threads rt on rt.id = cg.representative_thread_id
      where cg.id in (${idList})
      order by cg.id, t.number;
    `;
  }
  return `
    select
      c.id as cluster_id,
      c.member_count,
      c.created_at as cluster_created_at,
      c.closed_at_local,
      c.close_reason_local,
      rt.number as representative_number,
      rt.kind as representative_kind,
      rt.state as representative_state,
      rt.title as representative_title,
      t.number,
      t.kind,
      t.state,
      t.title,
      t.body,
      t.labels_json,
      t.updated_at
    from clusters c
    join cluster_members cm on cm.cluster_id = c.id
    join threads t on t.id = cm.thread_id
    left join threads rt on rt.id = c.representative_thread_id
    where c.id in (${idList})
    order by c.id, t.number;
  `;
}

function sqliteJson(sql: JsonValue): JsonValue {
  return querySqliteRows(dbPath, String(sql));
}

function sqliteScalar(sql: string) {
  return querySqliteScalar(dbPath, sql);
}

function detectClusterSource() {
  const legacyRows =
    Number(
      sqliteScalar(
        "select count(*) from sqlite_master where type = 'table' and name = 'clusters';",
      ),
    ) > 0
      ? Number(sqliteScalar("select count(*) from clusters;"))
      : 0;
  if (legacyRows > 0) return "legacy";
  const hasPortableSchema =
    Number(
      sqliteScalar(
        "select count(*) from sqlite_master where type = 'table' and name = 'cluster_groups';",
      ),
    ) > 0;
  return hasPortableSchema ? "portable" : "legacy";
}

function numberArg(name: string, fallback: JsonValue) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function booleanArg(name: string, fallback: JsonValue) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function sqlNumber(value: JsonValue) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`unsafe cluster id: ${value}`);
  }
  return String(value);
}

function yamlList(values: LooseRecord[]) {
  if (values.length === 0) return ["  []"];
  return values.map((value: string) => `  - ${quoteYaml(value)}`);
}

function quoteYaml(value: JsonValue) {
  return JSON.stringify(String(value));
}

function canonicalHint(representative: JsonValue) {
  if (!representative.number)
    return "No gitcrawl representative was available; worker must choose a live canonical.";
  if (representative.state === "open") {
    return `gitcrawl representative #${representative.number} is open; worker must verify it is still the best live canonical.`;
  }
  return `gitcrawl representative #${representative.number} is ${representative.state}; worker must verify whether an open canonical should replace it.`;
}

function goalText(mode: string) {
  if (mode === "plan") {
    return "Classify the open candidate issues and PRs in read-only plan mode. Do not close anything. If the representative is closed, report whether another open item should become the live canonical. If the cluster contains multiple root causes, split them in the action matrix instead of forcing a single duplicate family.";
  }
  return "Run one live autonomous classification pass. Classify open candidates only, verify live GitHub state, choose the current canonical issue or PR if the representative is obsolete, and emit only high-confidence planned close/comment/label actions. Closed context refs are evidence only and must not receive close actions.";
}

function jobNotes(clusterId: string | number) {
  return `Generated from gitcrawl run cluster ${clusterId} on ${new Date().toISOString().slice(0, 10)}. Candidate quality is decided by the cluster selector model; deterministic worker safety gates still apply.`;
}

function bulletList(members: JsonValue) {
  if (members.length === 0) return ["- none"];
  return members.map((member: JsonValue) => `- #${member.number} ${member.title}`);
}

function slugify(value: JsonValue) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "cluster"
  );
}
