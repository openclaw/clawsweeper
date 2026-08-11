#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hasSecuritySignalText, parseArgs, repoRoot } from "./lib.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import { resolveGitcrawlDbPath } from "./gitcrawl-store.js";

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? "openclaw/openclaw");
const dbPath = resolveGitcrawlDbPath(repo, typeof args.db === "string" ? args.db : undefined);
const outDir = path.resolve(
  String(args.out ?? path.join(repoRoot(), "jobs", repo.split("/")[0] ?? "unknown", "inbox")),
);
const mode = String(args.mode ?? "autonomous");
const limit = numberArg("limit", 20);
const batchSize = numberArg("batch-size", 5);
const minScore = numberArg("min-score", 2);
const maxFiles = numberArg("max-files", 120);
const sort = String(args.sort ?? "stale");
const skipExisting = args["skip-existing"] !== "false";
const dryRun = Boolean(args["dry-run"]);
const jsonOutput = Boolean(args.json);

if (!["plan", "execute", "autonomous"].includes(mode)) {
  console.error("mode must be plan, execute, or autonomous");
  process.exit(2);
}
if (!["stale", "recent", "score"].includes(sort)) {
  console.error("sort must be stale, recent, or score");
  process.exit(2);
}
const candidates = selectCandidates();
const batches: JsonValue[] = [];
for (let i = 0; i < candidates.length; i += batchSize) {
  batches.push(candidates.slice(i, i + batchSize));
}

fs.mkdirSync(outDir, { recursive: true });
const generated = batches.map((batch: JsonValue, index: JsonValue) => writeJob(batch, index + 1));

if (jsonOutput) {
  console.log(JSON.stringify({ generated, candidates }, null, 2));
} else {
  for (const item of generated) console.log(item.path);
}

function selectCandidates() {
  const existing = skipExisting ? existingLowSignalRefs() : new Set();
  const rows = sqliteJson(`
    select
      t.id,
      t.number,
      t.state,
      t.title,
      t.body,
      t.author_login,
      t.author_type,
      t.labels_json,
      t.assignees_json,
      t.raw_json,
      t.is_draft,
      t.created_at_gh,
      t.updated_at_gh,
      t.last_pulled_at,
      group_concat(distinct f.path) as files
    from threads t
    join repositories r on r.id = t.repo_id
    left join thread_revisions tr on tr.thread_id = t.id
    left join thread_code_snapshots s on s.thread_revision_id = tr.id
    left join thread_changed_files f on f.snapshot_id = s.id
    where r.owner = ${sqlString(repo.split("/")[0])}
      and r.name = ${sqlString(repo.split("/")[1])}
      and t.kind = 'pull_request'
      and t.state = 'open'
      and t.closed_at_local is null
    group by t.id
  `);

  return rows
    .map((row: JsonValue) => scoreCandidate(row))
    .filter((candidate: JsonValue) => !existing.has(candidate.ref))
    .filter((candidate: JsonValue) => candidate.score >= minScore)
    .filter((candidate: JsonValue) => candidate.files.length <= maxFiles)
    .sort(compareCandidates)
    .slice(0, limit);
}

function scoreCandidate(row: LooseRecord) {
  const raw = safeJson(row.raw_json);
  const labels = safeJson(row.labels_json);
  const assignees = safeJson(row.assignees_json);
  const files = unique(
    String(row.files ?? "")
      .split(",")
      .filter(Boolean),
  );
  const title = String(row.title ?? "");
  const body = String(row.body ?? "");
  const signals: LooseRecord[] = [];
  const blockers: LooseRecord[] = [];

  if (isMaintainerAssociated(raw.author_association))
    blockers.push(`author association is ${raw.author_association}`);
  if (assignees.length > 0) blockers.push("assigned PR");
  if (hasSecuritySignalText(title, body, labels))
    blockers.push("security-sensitive text or labels");

  addSignal(signals, blankTemplateSignal(body), "blank_template");
  addSignal(signals, docsOnlySignal(title, files), "docs_only");
  addSignal(signals, testsOnlySignal(title, files), "test_only");
  addSignal(signals, refactorOnlySignal(title, body, files), "refactor_or_cleanup");
  addSignal(
    signals,
    thirdPartyCoreSignal(title, body, files),
    "third_party_or_external_capability",
  );
  addSignal(signals, riskyInfraSignal(title, files), "risky_infra");
  addSignal(signals, dirtyBranchSignal(files), "dirty_branch");

  const hasConcreteFix = /\b(fixes|fixes?|root cause|repro|regression|bug|problem)\b/i.test(
    `${title}\n${body}`,
  );
  if (hasConcreteFix && signals.length === 1 && !signals.includes("blank_template")) {
    blockers.push("possible focused fix needs human review");
  }

  const score = blockers.length > 0 ? 0 : signals.length;
  return {
    number: Number(row.number),
    ref: `#${row.number}`,
    title,
    author: row.author_login,
    author_association: raw.author_association ?? null,
    created_at: row.created_at_gh,
    updated_at: row.updated_at_gh ?? row.last_pulled_at,
    is_draft: Boolean(row.is_draft),
    files,
    file_count: files.length,
    labels: labels.map((label: JsonValue) => label.name ?? label).filter(Boolean),
    score,
    signals,
    blockers,
    body_excerpt: excerpt(body),
  };
}

function writeJob(batch: JsonValue, index: JsonValue) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13);
  const clusterId = `low-signal-pr-sweep-${stamp}-${String(index).padStart(2, "0")}`;
  const filePath = path.join(outDir, `${clusterId}.md`);
  const markdown = [
    "---",
    `repo: ${repo}`,
    `cluster_id: ${clusterId}`,
    `mode: ${mode}`,
    renderJobIntentFrontmatter("low_signal_pr_cleanup"),
    "triage_policy: low_signal_prs",
    "allowed_actions:",
    "  - comment",
    "  - close",
    "blocked_actions:",
    "  - force_push",
    "  - bypass_checks",
    "  - merge",
    "  - fix",
    "  - label",
    "require_human_for:",
    "  - security_sensitive",
    "  - maintainer_signal",
    "  - active_author_followup",
    "  - focused_bug_fix",
    "  - green_checks",
    "  - technical_correctness_judgment",
    "canonical: []",
    "candidates:",
    ...yamlList(batch.map((candidate: JsonValue) => candidate.ref)),
    "cluster_refs:",
    ...yamlList(batch.map((candidate: JsonValue) => candidate.ref)),
    "security_policy: central_security_only",
    "security_sensitive: false",
    "allow_instant_close: false",
    "allow_low_signal_pr_close: true",
    "allow_fix_pr: false",
    "allow_merge: false",
    "allow_post_merge_close: false",
    `canonical_hint: ${quoteYaml("No canonical is needed; this is an opt-in low-signal PR cleanup sweep.")}`,
    `notes: ${quoteYaml(`Generated from local gitcrawl open PR data on ${now.toISOString()}.`)}`,
    "---",
    "",
    `# Low-Signal PR Sweep ${index}`,
    "",
    "Use `instructions/low-signal-prs.md`. This job is not a dedupe cluster.",
    "",
    "## Goal",
    "",
    'Review only the listed open pull requests. Emit `close_low_signal` with `classification: "low_signal"` only when the PR is boringly clear under the low-signal policy and live GitHub state still has no maintainer signal. Otherwise emit `needs_human`, `keep_related`, or `keep_independent`.',
    "",
    "The deterministic applicator will re-fetch live state, reject non-PRs, reject maintainer-authored/reviewed/commented/assigned PRs, and close only planned `close_low_signal` actions.",
    "",
    "## Gitcrawl Candidate Signals",
    "",
    ...batch.flatMap(candidateBlock),
    "",
  ].join("\n");

  if (!dryRun) fs.writeFileSync(filePath, markdown);
  return {
    path: path.relative(repoRoot(), filePath),
    cluster_id: clusterId,
    candidates: batch.map((candidate: JsonValue) => candidate.ref),
  };
}

function candidateBlock(candidate: LooseRecord) {
  return [
    `### ${candidate.ref} ${candidate.title}`,
    "",
    `- author: ${candidate.author}`,
    `- updated: ${candidate.updated_at}`,
    `- score: ${candidate.score}`,
    `- signals: ${candidate.signals.join(", ")}`,
    `- files: ${candidate.file_count}`,
    `- body excerpt: ${candidate.body_excerpt || "none"}`,
    `- changed files: ${candidate.files.slice(0, 18).join(", ") || "not hydrated in gitcrawl"}`,
    "",
  ];
}

function existingLowSignalRefs() {
  const jobsDir = path.join(repoRoot(), "jobs");
  if (!fs.existsSync(jobsDir)) return new Set();
  const refs = new Set();
  for (const entry of fs.readdirSync(jobsDir, { recursive: true })) {
    const file = path.join(jobsDir, String(entry));
    if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("triage_policy: low_signal_prs")) continue;
    for (const match of text.matchAll(/#(\d+)\b/g)) refs.add(`#${match[1]}`);
  }
  return refs;
}

function compareCandidates(left: JsonValue, right: JsonValue) {
  if (sort === "score") return right.score - left.score || staleCompare(left, right);
  if (sort === "recent") return String(right.updated_at).localeCompare(String(left.updated_at));
  return staleCompare(left, right);
}

function staleCompare(left: JsonValue, right: JsonValue) {
  return String(left.updated_at).localeCompare(String(right.updated_at));
}

function blankTemplateSignal(body: string) {
  const text = String(body ?? "");
  if (
    /Describe the problem and fix in 2.?5 bullets:\s*[\r\n]+\s*-\s*Problem:\s*[\r\n]+\s*-\s*Fix:/i.test(
      text,
    )
  ) {
    return true;
  }
  const placeholders = ["Problem:", "Why it matters:", "Describe the problem and fix"];
  return (
    placeholders.filter((placeholder: JsonValue) => text.includes(placeholder)).length >= 2 &&
    text.length < 700
  );
}

function docsOnlySignal(title: JsonValue, files: LooseRecord[]) {
  return (
    /\bdocs?\b/i.test(title) &&
    files.length > 0 &&
    files.every((file: JsonValue) => isDocsPath(file))
  );
}

function testsOnlySignal(title: JsonValue, files: LooseRecord[]) {
  return (
    /\btest\b/i.test(title) &&
    files.length > 0 &&
    files.every((file: JsonValue) => isTestPath(file))
  );
}

function refactorOnlySignal(title: JsonValue, body: string, files: LooseRecord[]) {
  return (
    /\b(refactor|cleanup|format|chore)\b/i.test(title) &&
    !/#\d+\b/.test(`${title}\n${body}`) &&
    files.length > 0
  );
}

function thirdPartyCoreSignal(title: JsonValue, body: string, files: LooseRecord[]) {
  const text = `${title}\n${body}`.toLowerCase();
  return (
    /\b(new|add|feat).*(plugin|provider|channel|skill|tool|app)\b/.test(text) ||
    files.some((file: JsonValue) => String(file).startsWith("apps/linux/"))
  );
}

function riskyInfraSignal(title: JsonValue, files: LooseRecord[]) {
  return (
    /\b(ci|infra|docker|build|release|workflow)\b/i.test(title) &&
    files.some((file: JsonValue) =>
      /^\.github\/|^Dockerfile|^scripts\/|^fly\.|^render\.|^docker-compose/.test(file),
    )
  );
}

function dirtyBranchSignal(files: LooseRecord[]) {
  if (files.length < 12) return false;
  const topLevels = new Set(files.map((file: JsonValue) => file.split("/")[0]));
  return (
    topLevels.size >= 4 ||
    (files.some((file: JsonValue) => file.includes(".generated")) && topLevels.size >= 2)
  );
}

function isDocsPath(file: JsonValue) {
  return /(^docs\/|^README|\.md$|\.mdx$|^skills\/|^\.github\/ISSUE_TEMPLATE)/.test(file);
}

function isTestPath(file: JsonValue) {
  return /(\.test\.|\.spec\.|__tests__|^test\/|^test-fixtures\/)/.test(file);
}

function isMaintainerAssociated(value: JsonValue) {
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(value ?? "").toUpperCase());
}

function addSignal(signals: LooseRecord[], enabled: JsonValue, name: string) {
  if (enabled) signals.push(name);
}

function sqliteJson(sql: JsonValue) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    cwd: repoRoot(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return JSON.parse(output || "[]");
}

function numberArg(name: string, fallback: JsonValue) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

function yamlList(values: LooseRecord[]) {
  if (values.length === 0) return ["  []"];
  return values.map((value: string) => `  - ${quoteYaml(value)}`);
}

function quoteYaml(value: JsonValue) {
  return JSON.stringify(String(value));
}

function sqlString(value: JsonValue) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeJson(value: JsonValue) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function unique(values: LooseRecord[]) {
  return [...new Set(values)];
}

function excerpt(value: JsonValue) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
