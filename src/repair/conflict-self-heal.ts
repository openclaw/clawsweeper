#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  activeRepairWorkflowRunForJobAfterDispatchRecheck,
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseJob,
  readMaxLiveWorkers,
  repoRoot,
  validateJob,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { publishMainCommit, publishRoot } from "./git-publish.js";
import { ghJson, ghJsonWithRetry, ghPaged, ghText, githubCommandTimeoutMs } from "./github-cli.js";
import { DEFAULT_TARGET_REPO, REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { writePayload } from "./comment-router-utils.js";
import {
  DEFAULT_SELF_HEAL_HEAD_PREFIX,
  CLAWSWEEPER_SELF_REBASE_SOURCE,
  renderSelfHealJob,
  renderSelfHealStatusComment,
  selfHealEligibility,
  selfHealJobPath,
  selfHealStatusMarkerPrefix,
} from "./conflict-self-heal-core.js";

const args = parseArgs(process.argv.slice(2));

if (args["verify-job-head"]) {
  verifyJobHead(String(args["verify-job-head"]));
  process.exit(0);
}

const repo = String(args.repo ?? process.env.CLAWSWEEPER_TARGET_REPO ?? DEFAULT_TARGET_REPO);
const repairRepo = String(
  args["repair-repo"] ?? args.repair_repo ?? process.env.CLAWSWEEPER_REPO ?? currentProjectRepo(),
);
const workflow = String(args.workflow ?? REPAIR_CLUSTER_WORKFLOW);
const headPrefix = String(args["head-prefix"] ?? args.head_prefix ?? DEFAULT_SELF_HEAL_HEAD_PREFIX);
const runner = String(
  args.runner ?? process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404",
);
const executionRunner = String(
  args["execution-runner"] ??
    args.execution_runner ??
    process.env.CLAWSWEEPER_EXECUTION_RUNNER ??
    "blacksmith-16vcpu-ubuntu-2404",
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxPrs = Number(args["max-prs"] ?? args.max_prs ?? args.limit ?? 5);
const maxRepairsPerHead = Number(
  args["max-repairs-per-head"] ??
    args.max_repairs_per_head ??
    process.env.CLAWSWEEPER_MAX_REPAIRS_PER_HEAD ??
    2,
);
const maxRepairsPerPr = Number(
  args["max-repairs-per-pr"] ??
    args.max_repairs_per_pr ??
    process.env.CLAWSWEEPER_MAX_REPAIRS_PER_PR ??
    10,
);
const maxLiveWorkers = readMaxLiveWorkers(args);
const execute = Boolean(args.execute);
const writeReport = Boolean(args["write-report"] ?? true);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const allowRepeat = Boolean(args["allow-repeat"]);
const activeRepairRunsByPrefix = new Map<string, LooseRecord[]>();

validateRepo(repo, "repo");
validateRepo(repairRepo, "repair repo");
const positiveIntegerOptions: Array<[string, number]> = [
  ["--max-prs", maxPrs],
  ["--max-repairs-per-head", maxRepairsPerHead],
  ["--max-repairs-per-pr", maxRepairsPerPr],
];
for (const [name, value] of positiveIntegerOptions) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

const openPulls = listOpenPullRequests(repo);
const ledger = readLedger();
const plannedHeads = new Set<string>();
const classified = openPulls.map((pull) => classifyCandidate(pull, plannedHeads, ledger));
const candidates = classified
  .filter((candidate) => candidate.status === "candidate")
  .slice(0, maxPrs);
const dispatchSummary = {
  enabled: execute,
  workflow,
  repair_repo: repairRepo,
  runner,
  execution_runner: executionRunner,
  model,
  max_prs: maxPrs,
  max_repairs_per_head: maxRepairsPerHead,
  max_repairs_per_pr: maxRepairsPerPr,
  candidates: candidates.map(summarizeCandidate),
  attempts: [],
};
const report: LooseRecord = {
  repo,
  head_prefix: headPrefix,
  generated_at: new Date().toISOString(),
  summary: summarize(classified),
  dispatch: dispatchSummary,
  prs: classified,
};

if (execute) {
  report.dispatch = executeDispatches(candidates, dispatchSummary, ledger);
}

if (writeReport) writeReports(report);
console.log(JSON.stringify(report, null, 2));

function listOpenPullRequests(targetRepo: string): LooseRecord[] {
  const searchResults = ghJsonWithRetry<LooseRecord[]>(
    [
      "search",
      "prs",
      "--repo",
      targetRepo,
      "--author",
      "app/clawsweeper",
      "--state",
      "open",
      "--json",
      "number,title,url,author,updatedAt",
      "--limit",
      "100",
    ],
    { attempts: 4 },
  );
  return searchResults.map((pull: LooseRecord) => ({
    ...pull,
    ...fetchPullRequestView(targetRepo, pull.number),
  }));
}

function fetchPullRequestView(targetRepo: string, number: JsonValue) {
  return ghJsonWithRetry<LooseRecord>(
    [
      "pr",
      "view",
      String(number),
      "--repo",
      targetRepo,
      "--json",
      [
        "author",
        "baseRefName",
        "headRefName",
        "headRefOid",
        "headRepository",
        "isDraft",
        "labels",
        "mergeable",
        "mergeStateStatus",
        "state",
        "title",
        "url",
      ].join(","),
    ],
    { attempts: 4 },
  );
}

function classifyCandidate(
  pull: LooseRecord,
  plannedHeads: Set<string>,
  currentLedger: LooseRecord,
) {
  const headSha = String(pull.headRefOid ?? "");
  const jobPath = selfHealJobPath(repo, pull.number);
  const base = {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    author: pull.author?.login ?? pull.author ?? null,
    branch: pull.headRefName,
    head_repo: pull.headRepository?.nameWithOwner ?? null,
    head_sha: headSha || null,
    mergeable: pull.mergeable ?? null,
    merge_state_status: pull.mergeStateStatus ?? null,
    labels: (pull.labels ?? []).map((label: JsonValue) =>
      typeof label === "string" ? label : (label as LooseRecord).name,
    ),
    job_path: jobPath,
  };
  const eligibility = selfHealEligibility({ pull, repo, headPrefix });
  if (!eligibility.eligible) return { ...base, status: "skipped", reason: eligibility.reason };

  const capBlock = repairCapBlockReason({
    ledger: currentLedger,
    pr: pull.number,
    headSha,
    plannedHeads,
  });
  if (capBlock) return { ...base, status: "skipped", reason: capBlock };

  const active = activeRepairWorkflowRunForJobAfterDispatchRecheck({
    repo: repairRepo,
    workflow,
    jobPath,
    activeRunsByPrefix: activeRepairRunsByPrefix,
  });
  if (active) {
    return {
      ...base,
      status: "waiting",
      reason: "repair worker already active for this self-heal job",
      active_run_url: active.url ?? null,
      active_run_id: active.databaseId ?? active.id ?? null,
    };
  }

  const headKey = `${repo}#${pull.number}:${headSha}`;
  plannedHeads.add(headKey);
  return { ...base, status: "candidate", reason: eligibility.reason };
}

function repairCapBlockReason({
  ledger,
  pr,
  headSha,
  plannedHeads,
}: {
  ledger: LooseRecord;
  pr: JsonValue;
  headSha: string;
  plannedHeads: Set<string>;
}) {
  const headKey = `${repo}#${pr}:${headSha}`;
  if (plannedHeads.has(headKey)) return "repair already planned for this PR head in this scan";
  const attempts = (ledger.attempts ?? []).filter(
    (attempt: JsonValue) =>
      String(attempt.target_repo ?? "") === repo &&
      Number(attempt.pr) === Number(pr) &&
      ["dispatched", "waiting"].includes(String(attempt.status ?? "")),
  );
  if (!allowRepeat && attempts.length >= maxRepairsPerPr) {
    return `self-heal already dispatched ${attempts.length} total time(s) for this PR`;
  }
  const headAttempts = attempts.filter(
    (attempt: JsonValue) => String(attempt.head_sha ?? "") === headSha,
  );
  if (!allowRepeat && headAttempts.length >= maxRepairsPerHead) {
    return `self-heal already dispatched ${headAttempts.length} time(s) for this PR head`;
  }
  return null;
}

function executeDispatches(
  candidates: LooseRecord[],
  dispatchSummary: LooseRecord,
  currentLedger: LooseRecord,
) {
  const summary = {
    ...dispatchSummary,
    status: candidates.length === 0 ? "no_candidates" : "dispatching",
    dispatched_at: new Date().toISOString(),
    attempts: [],
  };
  if (candidates.length === 0) return summary;
  if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
    throw new Error("refusing conflict self-heal dispatch: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
  }
  if (process.env.CLAWSWEEPER_ALLOW_FIX_PR !== "1") {
    throw new Error("refusing conflict self-heal dispatch: CLAWSWEEPER_ALLOW_FIX_PR must be 1");
  }
  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({
        repo: repairRepo,
        workflow,
        requested: candidates.length,
        maxLiveWorkers,
      })
    : assertLiveWorkerCapacity({
        repo: repairRepo,
        workflow,
        requested: candidates.length,
        maxLiveWorkers,
      });

  const batchId = `conflict-self-heal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const prepared: Array<{ candidate: LooseRecord; attempt: LooseRecord }> = [];
  for (const candidate of candidates) {
    const latest = fetchPullHead(repo, candidate.number);
    const attempt: LooseRecord = {
      batch_id: batchId,
      target_repo: repo,
      repair_repo: repairRepo,
      pr: candidate.number,
      url: candidate.url,
      branch: candidate.branch,
      head_sha: candidate.head_sha,
      latest_head_sha: latest.head_sha,
      merge_state: candidate.reason,
      job_path: candidate.job_path,
      workflow,
      runner,
      execution_runner: executionRunner,
      model,
      dispatched_at: new Date().toISOString(),
      status: "pending",
    };
    if (latest.head_sha !== candidate.head_sha) {
      attempt.status = "skipped";
      attempt.reason = "head SHA changed before dispatch";
    } else {
      writeSelfHealJob(candidate);
      attempt.status = "prepared";
      prepared.push({ candidate, attempt });
    }
    summary.attempts.push(attempt);
    currentLedger.attempts = [...(currentLedger.attempts ?? []), attempt];
  }
  if (prepared.length > 0) publishSelfHealJobs();
  for (const item of prepared) {
    const { candidate, attempt } = item;
    const latest = fetchPullHead(repo, candidate.number);
    attempt.latest_head_sha_after_publish = latest.head_sha;
    if (latest.head_sha !== candidate.head_sha) {
      attempt.status = "skipped";
      attempt.reason = "head SHA changed after state publish";
      continue;
    }
    postSelfHealStatus(candidate, { status: "dispatching" });
    dispatchRepair(candidate);
    attempt.status = "dispatched";
  }
  currentLedger.updated_at = new Date().toISOString();
  writeLedger(currentLedger);
  summary.status = "dispatched";
  return summary;
}

function publishSelfHealJobs() {
  if (!publishRoot()) {
    throw new Error("refusing conflict self-heal dispatch: CLAWSWEEPER_STATE_DIR is required");
  }
  const result = publishMainCommit({
    message: "chore: publish conflict self-heal jobs",
    paths: ["jobs"],
    maxAttempts: 12,
    pushAttempts: 4,
  });
  console.log(`Published conflict self-heal jobs before dispatch: ${result}`);
}

function writeSelfHealJob(candidate: LooseRecord) {
  const absolute = path.join(repoRoot(), candidate.job_path);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    renderSelfHealJob({
      repo,
      issueNumber: candidate.number,
      title: candidate.title,
      branch: candidate.branch,
      headSha: candidate.head_sha,
      mergeState: candidate.reason,
      runUrl: currentActionsRunUrl(),
    }),
    "utf8",
  );
  const job = parseJob(candidate.job_path);
  const errors = validateJob(job);
  if (errors.length > 0) throw new Error(`invalid self-heal job ${candidate.job_path}: ${errors}`);
}

function postSelfHealStatus(candidate: LooseRecord, { status }: { status: string }) {
  const body = renderSelfHealStatusComment({
    repo,
    issueNumber: candidate.number,
    headSha: candidate.head_sha,
    mergeState: candidate.reason,
    jobPath: candidate.job_path,
    runUrl: currentActionsRunUrl(),
    status,
  });
  const existing = findSelfHealStatusComment(candidate.number);
  const payload = writePayload(
    repoRoot(),
    `conflict-self-heal-status-${candidate.number}-${candidate.head_sha}`,
    { body },
  );
  if (existing?.id) {
    ghText([
      "api",
      `repos/${repo}/issues/comments/${existing.id}`,
      "--method",
      "PATCH",
      "--input",
      payload,
    ]);
  } else {
    ghText(["api", `repos/${repo}/issues/${candidate.number}/comments`, "--input", payload]);
  }
}

function findSelfHealStatusComment(number: JsonValue) {
  const prefix = selfHealStatusMarkerPrefix(number);
  const comments = ghPaged<LooseRecord>(`repos/${repo}/issues/${number}/comments?per_page=100`);
  return comments
    .reverse()
    .find(
      (comment) => String(comment.body ?? "").includes(prefix) && isTrustedStatusComment(comment),
    );
}

function dispatchRepair(candidate: LooseRecord) {
  const result = spawnSync(
    "gh",
    [
      "workflow",
      "run",
      workflow,
      "--repo",
      repairRepo,
      "-f",
      `job=${candidate.job_path}`,
      "-f",
      "mode=autonomous",
      "-f",
      `runner=${runner}`,
      "-f",
      `execution_runner=${executionRunner}`,
      "-f",
      `model=${model}`,
    ],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: githubCommandTimeoutMs(process.env),
      killSignal: "SIGKILL",
    },
  );
  if (result.status !== 0) {
    throw new Error(`failed to dispatch ${candidate.job_path}: ${result.stderr || result.stdout}`);
  }
}

function verifyJobHead(jobPath: string) {
  const job = parseJob(jobPath);
  let matched = true;
  let reason = "not a self-heal job";
  if (job.frontmatter.source === CLAWSWEEPER_SELF_REBASE_SOURCE) {
    const target = Number(job.frontmatter.self_heal_target_pr);
    const expected = String(job.frontmatter.expected_head_sha ?? "");
    const live = fetchPullHead(String(job.frontmatter.repo ?? ""), target);
    matched = live.state === "OPEN" && live.head_sha === expected;
    reason = matched
      ? "self-heal head matches"
      : `self-heal head mismatch: expected ${expected || "unknown"}, got ${live.head_sha || "unknown"} (${live.state || "unknown"})`;
  }
  writeGithubOutput({ matched: matched ? "true" : "false", reason });
  if (!matched) {
    console.log(`::notice title=Skipped stale self-heal job::${reason}`);
  }
}

function fetchPullHead(targetRepo: string, number: JsonValue) {
  const view = ghJson<LooseRecord>([
    "pr",
    "view",
    String(number),
    "--repo",
    targetRepo,
    "--json",
    "headRefOid,state",
  ]);
  return {
    head_sha: String(view.headRefOid ?? ""),
    state: String(view.state ?? ""),
  };
}

function summarize(prs: LooseRecord[]) {
  return {
    open_clawsweeper_prs: prs.filter((pr) => String(pr.branch ?? "").startsWith(headPrefix)).length,
    candidates: prs.filter((pr) => pr.status === "candidate").length,
    waiting: prs.filter((pr) => pr.status === "waiting").length,
    skipped: prs.filter((pr) => pr.status === "skipped").length,
    conflicting_or_dirty: prs.filter(
      (pr) => pr.status !== "skipped" || /mergeState|mergeable/.test(String(pr.reason)),
    ).length,
  };
}

function summarizeCandidate(candidate: LooseRecord) {
  return {
    pr: candidate.number,
    url: candidate.url,
    branch: candidate.branch,
    head_sha: candidate.head_sha,
    merge_state: candidate.reason,
    job_path: candidate.job_path,
  };
}

function readLedger() {
  const file = ledgerPath();
  if (!fs.existsSync(file)) return { updated_at: null, attempts: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { updated_at: data.updated_at ?? null, attempts: data.attempts ?? [] };
  } catch {
    return { updated_at: null, attempts: [] };
  }
}

function writeLedger(ledger: LooseRecord) {
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);
}

function ledgerPath() {
  return path.join(repoRoot(), "results", "conflict-self-heal-dispatch.json");
}

function writeReports(report: LooseRecord) {
  const resultsDir = path.join(repoRoot(), "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, "conflict-self-heal.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(resultsDir, "conflict-self-heal.md"), renderMarkdown(report));
}

function renderMarkdown(report: LooseRecord) {
  const rows = (report.prs ?? [])
    .map((pr: JsonValue) =>
      [
        markdownLink(`#${pr.number}`, pr.url),
        tableCell(pr.title ?? ""),
        tableCell(pr.branch ?? ""),
        tableCell(pr.mergeable ?? ""),
        tableCell(pr.merge_state_status ?? ""),
        tableCell(pr.status ?? ""),
        tableCell(pr.reason ?? ""),
      ].join(" | "),
    )
    .map((row: string) => `| ${row} |`);
  return [
    "# ClawSweeper Conflict Self-Heal",
    "",
    `Generated: ${report.generated_at}`,
    `Repository: ${report.repo}`,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    ...Object.entries(report.summary ?? {}).map(
      ([key, value]) => `| ${tableCell(key)} | ${value} |`,
    ),
    "",
    "## Pull Requests",
    "",
    "| PR | Title | Branch | Mergeable | Merge State | Status | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| none |  |  |  |  |  |  |"]),
    "",
  ].join("\n");
}

function markdownLink(label: JsonValue, url: JsonValue) {
  return url ? `[${label}](${url})` : String(label ?? "");
}

function tableCell(value: JsonValue) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function currentActionsRunUrl() {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : null;
}

function isTrustedStatusComment(comment: LooseRecord) {
  const author = String(comment.user?.login ?? "").toLowerCase();
  return (
    author === "clawsweeper" ||
    author === "clawsweeper[bot]" ||
    author === "openclaw-clawsweeper[bot]"
  );
}

function writeGithubOutput(values: Record<string, string>) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } else {
    console.log(lines.join("\n"));
  }
}

function validateRepo(value: string, name: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} must be owner/repo, got ${value}`);
  }
}
