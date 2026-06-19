#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { ghJson } from "./github-cli.js";
import { renderJobIntentFrontmatter } from "./job-intent.js";
import { parseArgs, parseJob, repoRoot, validateJob } from "./lib.js";
import { slug } from "./text-utils.js";
import { repositoryProfileFor } from "../repository-profiles.js";

type Signal = {
  kind: string;
  detail: string;
  source?: string;
};

type Candidate = {
  number: number;
  title: string;
  url: string;
  baseRefName?: string;
  headRefName?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: JsonValue[];
  comments?: LooseRecord[];
  reviews?: LooseRecord[];
  updatedAt?: string;
};

type AuthorSearchPullRequest = {
  repository?: { nameWithOwner?: string };
};

type AuthorWideRepositoryDecision = {
  repo?: string;
  reason?: "private" | "metadata_unavailable" | "unsupported_profile";
};

const args = parseArgs(process.argv.slice(2));
const requestedRepo = stringArg("repo", "");
const author = stringArg("author", "");
const allOpen = truthy(args["all-open"] ?? args.all_open);
const limit = numberArg("limit", 50);
const outDirArg = stringArg("out-dir", stringArg("out_dir", ""));
const dryRun = truthy(args["dry-run"] ?? args.dry_run);
const force = truthy(args.force);
const includeComments = !truthy(args["no-comments"] ?? args.no_comments);
const includeReviewOnly = truthy(
  args["include-review-comments-only"] ?? args.include_review_comments_only,
);
const minSignals = numberArg("min-signals", 1);

const reviewThreadsQuery = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          isResolved
          isOutdated
          comments(first:10) {
            nodes { author { login } body url }
          }
        }
      }
    }
  }
}
`;

if (!author.trim()) die("--author is required");

if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(requestedRepo)) {
  console.log(JSON.stringify(runRepoIntake(requestedRepo, repoModeOutDir(requestedRepo)), null, 2));
} else if (allOpen) {
  console.log(JSON.stringify(runAuthorWideIntake(), null, 2));
} else {
  die("--repo owner/name is required unless --all-open is set");
}

function runAuthorWideIntake() {
  const pullRequests = fetchAuthorOpenPullRequests({ author, limit });
  const discoveredRepositories = Array.from(
    new Set(pullRequests.map((pr) => repoNameWithOwner(pr)).filter(Boolean)),
  ).sort();
  const decisions = discoveredRepositories.map(authorWideRepositoryDecision);
  const repositories = decisions.flatMap((decision) => (decision.repo ? [decision.repo] : []));
  const summaries = repositories.map((targetRepo) =>
    runRepoIntake(targetRepo, authorWideOutDir(targetRepo)),
  );

  return {
    status: "ok",
    mode: "author-wide",
    author,
    state: "open",
    searched: pullRequests.length,
    repos_discovered: discoveredRepositories.length,
    repos_scanned: summaries.length,
    skipped_repositories: skippedRepositoryCounts(decisions),
    scanned: summaries.reduce((sum, summary) => sum + Number(summary.scanned ?? 0), 0),
    candidates: summaries.reduce((sum, summary) => sum + Number(summary.candidates ?? 0), 0),
    dry_run: dryRun,
    jobs: summaries.flatMap((summary) => (Array.isArray(summary.jobs) ? summary.jobs : [])),
    repositories: summaries,
  };
}

function runRepoIntake(targetRepo: string, outDir: string): LooseRecord {
  const prs = fetchOpenPullRequests({ repo: targetRepo, author, limit });
  const results = prs
    .map((pr) => candidateResult(targetRepo, pr))
    .filter((result) => result.signals.length >= minSignals);

  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  const written: LooseRecord[] = [];
  for (const result of results) {
    const clusterId = slug(`repair-pr-${targetRepo.replace("/", "-")}-${result.number}`);
    const jobPath = path.join(outDir, `${clusterId}.md`);
    const relativeJobPath = path.relative(repoRoot(), jobPath);
    const branch = `clawsweeper/${clusterId}`;
    const body = renderJob({ targetRepo, result, clusterId, branch });
    if (dryRun) {
      written.push({
        status: "planned",
        job: relativeJobPath,
        number: result.number,
        signals: result.signals,
      });
      continue;
    }
    if (fs.existsSync(jobPath) && !force) {
      written.push({
        status: "exists",
        job: relativeJobPath,
        number: result.number,
        signals: result.signals,
      });
      continue;
    }
    fs.writeFileSync(jobPath, body, "utf8");
    const parsed = parseJob(jobPath);
    const errors = validateJob(parsed);
    if (errors.length > 0)
      die(`generated invalid job ${relativeJobPath}:\n- ${errors.join("\n- ")}`);
    written.push({
      status: "written",
      job: relativeJobPath,
      number: result.number,
      signals: result.signals,
    });
  }

  return {
    status: "ok",
    repo: targetRepo,
    author,
    scanned: prs.length,
    candidates: results.length,
    dry_run: dryRun,
    jobs: written,
  };
}

function repoModeOutDir(targetRepo: string): string {
  const owner = targetRepo.split("/")[0] ?? "unknown";
  return path.resolve(repoRoot(), outDirArg || `jobs/${owner}/inbox`);
}

function authorWideOutDir(targetRepo: string): string {
  const root = outDirArg
    ? path.resolve(repoRoot(), outDirArg)
    : path.resolve(repoRoot(), "jobs", "author", slug(author));
  return path.join(root, slug(targetRepo), "inbox");
}

function fetchAuthorOpenPullRequests({
  author,
  limit,
}: {
  author: string;
  limit: number;
}): AuthorSearchPullRequest[] {
  return ghJson<AuthorSearchPullRequest[]>([
    "search",
    "prs",
    "--author",
    author,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "repository",
  ]);
}

function repoNameWithOwner(pr: AuthorSearchPullRequest): string {
  return String(pr.repository?.nameWithOwner ?? "");
}

function authorWideRepositoryDecision(targetRepo: string): AuthorWideRepositoryDecision {
  try {
    repositoryProfileFor(targetRepo);
  } catch {
    return { reason: "unsupported_profile" };
  }
  try {
    const metadata = ghJson<LooseRecord>(["repo", "view", targetRepo, "--json", "isPrivate"]);
    if (metadata.isPrivate === true) return { reason: "private" };
    return metadata.isPrivate === false ? { repo: targetRepo } : { reason: "metadata_unavailable" };
  } catch {
    return { reason: "metadata_unavailable" };
  }
}

function skippedRepositoryCounts(decisions: AuthorWideRepositoryDecision[]) {
  const counts = {
    private: 0,
    metadata_unavailable: 0,
    unsupported_profile: 0,
  };
  for (const decision of decisions) {
    if (decision.reason) counts[decision.reason] += 1;
  }
  return counts;
}

function fetchOpenPullRequests({
  repo,
  author,
  limit,
}: {
  repo: string;
  author: string;
  limit: number;
}) {
  return ghJson<Candidate[]>([
    "pr",
    "list",
    "--repo",
    repo,
    "--author",
    author,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    [
      "number",
      "title",
      "url",
      "baseRefName",
      "headRefName",
      "mergeStateStatus",
      "reviewDecision",
      "statusCheckRollup",
      "comments",
      "reviews",
      "updatedAt",
    ].join(","),
  ]);
}

function candidateResult(targetRepo: string, pr: Candidate) {
  const blockingSignals: Signal[] = [];
  const contextSignals: Signal[] = [];
  const mergeState = String(pr.mergeStateStatus ?? "").toUpperCase();
  if (["DIRTY", "BLOCKED"].includes(mergeState)) {
    blockingSignals.push({ kind: "merge_state", detail: `mergeStateStatus=${mergeState}` });
  }

  const reviewDecision = String(pr.reviewDecision ?? "").toUpperCase();
  if (reviewDecision === "CHANGES_REQUESTED") {
    blockingSignals.push({ kind: "review_decision", detail: "reviewDecision=CHANGES_REQUESTED" });
  }

  for (const check of pr.statusCheckRollup ?? []) {
    const signal = checkSignal(check);
    if (signal) blockingSignals.push(signal);
  }

  const reviewThreadSignals = unresolvedReviewThreadSignals(targetRepo, pr.number);
  blockingSignals.push(...reviewThreadSignals);

  if (includeComments) {
    for (const comment of pr.comments ?? []) {
      const signal = actionableTextSignal("comment", comment);
      if (signal) contextSignals.push(signal);
    }
    for (const review of pr.reviews ?? []) {
      const state = String(review.state ?? "").toUpperCase();
      if (state === "CHANGES_REQUESTED") {
        contextSignals.push({
          kind: "review_changes_requested",
          detail: compact(
            `review by ${loginOf(review.author)} requested changes: ${review.body ?? ""}`,
          ),
          source: String(review.url ?? ""),
        });
        continue;
      }
      const signal = actionableTextSignal("review", review);
      if (signal) contextSignals.push(signal);
    }
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseRefName: pr.baseRefName ?? "main",
    headRefName: pr.headRefName ?? "",
    updatedAt: pr.updatedAt ?? "",
    signals: dedupeSignals([
      ...blockingSignals,
      ...(blockingSignals.length > 0 || includeReviewOnly ? contextSignals : []),
    ]).slice(0, 12),
  };
}

function unresolvedReviewThreadSignals(targetRepo: string, number: number): Signal[] {
  try {
    const data = ghJson<LooseRecord>([
      "api",
      "graphql",
      "-f",
      `owner=${targetRepo.split("/")[0]}`,
      "-f",
      `name=${targetRepo.split("/")[1]}`,
      "-F",
      `number=${number}`,
      "-f",
      `query=${reviewThreadsQuery}`,
    ]);
    const pullRequest = objectRecord(objectRecord(objectRecord(data.data).repository).pullRequest);
    const threads = objectRecord(objectRecord(pullRequest.reviewThreads)).nodes;
    if (!Array.isArray(threads)) return [];
    return threads
      .map((thread) => reviewThreadSignal(objectRecord(thread)))
      .filter((signal): signal is Signal => Boolean(signal));
  } catch {
    return [];
  }
}

function reviewThreadSignal(thread: LooseRecord): Signal | null {
  if (thread.isResolved || thread.isOutdated) return null;
  const comments = objectRecord(thread.comments).nodes;
  if (!Array.isArray(comments) || comments.length === 0) {
    return { kind: "review_thread_unresolved", detail: "unresolved current review thread" };
  }
  const latest = objectRecord(comments[comments.length - 1]);
  return {
    kind: "review_thread_unresolved",
    detail: compact(`unresolved review thread by ${loginOf(latest.author)}: ${latest.body ?? ""}`),
    source: String(latest.url ?? ""),
  };
}

function checkSignal(check: JsonValue): Signal | null {
  const record = objectRecord(check);
  const conclusion = String(record.conclusion ?? record.state ?? "").toUpperCase();
  const status = String(record.status ?? "").toUpperCase();
  const name = String(record.name ?? record.context ?? record.workflowName ?? "check");
  if (["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(conclusion)) {
    return { kind: "check_failed", detail: `${name}: conclusion=${conclusion}` };
  }
  if (["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(status)) {
    return { kind: "check_failed", detail: `${name}: status=${status}` };
  }
  return null;
}

function actionableTextSignal(kind: string, entry: LooseRecord): Signal | null {
  const author = loginOf(entry.author);
  const body = String(entry.body ?? "");
  const text = body.toLowerCase();
  if (!body.trim()) return null;
  if (
    /no actionable comments were generated|no actionable comments|looks good|approved/i.test(body)
  )
    return null;
  const actionable = [
    /changes? requested/,
    /needs? changes?/,
    /please (fix|address|update|change|rebase)/,
    /must (fix|address|update|change)/,
    /merge conflict/,
    /conflicts? with/,
    /dirty/,
    /failing checks?/,
    /ci (failed|failure|is failing)/,
    /not mergeable/,
    /actionable comment/,
    /blocking/,
  ].some((pattern) => pattern.test(text));
  if (!actionable) return null;
  return {
    kind: `${kind}_actionable`,
    detail: compact(`${kind} by ${author}: ${body}`),
    source: String(entry.url ?? ""),
  };
}

function renderJob({ targetRepo, result, clusterId, branch }: LooseRecord) {
  const ref = `#${result.number}`;
  const sourcePr = String(result.url);
  const prompt = renderPrompt(targetRepo, result);
  return `---
repo: ${targetRepo}
cluster_id: ${clusterId}
mode: autonomous
${renderJobIntentFrontmatter("pr_repair")}
allowed_actions:
  - comment
  - label
  - fix
  - raise_pr
blocked_actions:
  - close
  - merge
require_human_for:
  - merge
canonical:
  - ${ref}
candidates:
  - ${ref}
cluster_refs:
  - ${ref}
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_unmerged_fix_close: false
allow_post_merge_close: false
require_fix_before_close: true
security_policy: central_security_only
security_sensitive: false
target_branch: ${branch}
source: pr-repair-intake
---

# Repair-only PR intake for ${targetRepo}${ref}

This job was created by deterministic repair-only intake. It does not represent a full ClawSweeper review verdict and must not close or merge the source PR.

## Operator Prompt

${prompt}

## Related Refs

- ${ref}
- ${sourcePr}

## Likely Files

- inspect the source PR diff and review comments

## Validation

- inspect source PR comments, reviews, mergeability, and checks
- run the narrowest repo-native validation for the touched surface

## Guardrails

- Do not merge.
- Do not close the source PR.
- Prefer repairing the contributor branch when maintainable; otherwise prepare a replacement/follow-up repair branch.
- Preserve contributor credit and source PR links.
`;
}

function renderPrompt(targetRepo: JsonValue, result: LooseRecord) {
  const lines = [
    `Repair source PR ${result.url} (${targetRepo}#${result.number}): ${result.title}`,
    "",
    "The PR has objective repair signals and should be made merge-ready if possible.",
    "Use read-only GitHub inspection to review the PR diff, checks, comments, reviews, and latest head/base state before editing.",
    "Emit or apply the narrowest repair that addresses the concrete signals below.",
    "",
    "Required fix artifact fields/hints:",
    '- repair_strategy: "repair_contributor_branch" when the contributor branch can be updated safely; otherwise use the existing replacement-branch flow.',
    `- source_prs: ["${result.url}"]`,
    "",
    "Repair signals:",
    ...result.signals.map(
      (signal: Signal) =>
        `- ${signal.kind}: ${signal.detail}${signal.source ? ` (${signal.source})` : ""}`,
    ),
  ];
  return lines.join("\n");
}

function dedupeSignals(signals: Signal[]) {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}:${signal.detail}:${signal.source ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loginOf(value: JsonValue): string {
  const record = objectRecord(value);
  return String(record.login ?? record.name ?? "unknown");
}

function objectRecord(value: JsonValue): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : {};
}

function compact(value: string, max = 500) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 20)} ... ${text.slice(-15)}`;
}

function stringArg(name: string, fallback: string) {
  const value = args[name] ?? args[name.replace(/-/g, "_")];
  return typeof value === "string" ? value : fallback;
}

function numberArg(name: string, fallback: number) {
  const value = Number(args[name] ?? args[name.replace(/-/g, "_")] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function truthy(value: JsonValue): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
