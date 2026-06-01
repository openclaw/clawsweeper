#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { hasSecuritySignalText, parseArgs, parseJob, repoRoot, validateJob } from "./lib.js";
import { ghJson } from "./github-cli.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { readJsonFileIfExists as readJson } from "./json-file.js";
import { requireTargetRepo } from "../repository-profiles.js";

const args = parseArgs(process.argv.slice(2));
const jobsDir = path.resolve(
  String(args.jobs ?? path.join(repoRoot(), "jobs", "openclaw", "inbox")),
);
const outboxDir = path.resolve(
  String(args.outbox ?? path.join(repoRoot(), "jobs", "openclaw", "outbox", "finalized")),
);
const stuckDir = path.resolve(
  String(args.stuck ?? path.join(repoRoot(), "jobs", "openclaw", "outbox", "stuck")),
);
const reportPath = path.resolve(
  String(args.report ?? path.join(repoRoot(), "results", "openclaw-job-sweep.json")),
);
const live = Boolean(args.live);
const applyDeleteTests = Boolean(args["apply-delete-tests"]);
const applyOutbox = Boolean(args["apply-outbox"]);
const applyStuck = Boolean(args["apply-stuck"]);
const dryRun = !applyDeleteTests && !applyOutbox && !applyStuck;

const records = readRunRecords();
const latestByCluster = latestClusterRecords(records);
const openPrClusters = live ? readOpenClawSweeperPrClusters() : new Map();
const activeRuns = live ? readActiveClusterRuns() : [];
const rows: LooseRecord[] = [];

for (const jobPath of activeJobFiles(jobsDir)) {
  rows.push(classifyJob(jobPath));
}

const byStatus = countBy(rows, (row: JsonValue) => row.status);
const report: LooseRecord = {
  status: dryRun ? "dry_run" : "applied",
  generated_at: new Date().toISOString(),
  live,
  jobs_dir: path.relative(repoRoot(), jobsDir),
  outbox_dir: path.relative(repoRoot(), outboxDir),
  stuck_dir: path.relative(repoRoot(), stuckDir),
  active_cluster_runs: activeRuns,
  totals: {
    jobs: rows.length,
    ...byStatus,
  },
  delete_test_jobs: rows
    .filter((row: JsonValue) => row.status === "delete_test_job")
    .map(publicRow),
  outbox_jobs: rows.filter((row: JsonValue) => row.status === "move_to_outbox").map(publicRow),
  stuck_jobs: rows.filter((row: JsonValue) => row.status === "move_to_stuck").map(publicRow),
  requeue_candidates: rows
    .filter((row: JsonValue) => row.status === "requeue_candidate")
    .map(publicRow),
  active_jobs: rows.filter((row: JsonValue) => row.status === "active").map(publicRow),
  security_hold_jobs: rows
    .filter((row: JsonValue) => row.status === "security_hold")
    .map(publicRow),
  keep_jobs: rows.filter((row: JsonValue) => row.status === "keep").map(publicRow),
  invalid_jobs: rows.filter((row: JsonValue) => row.status === "invalid").map(publicRow),
};

if (applyDeleteTests || applyOutbox || applyStuck) applyActions(rows);

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeMarkdownReport(report, reportPath.replace(/\.json$/i, ".md"));
console.log(JSON.stringify(report, null, 2));

function activeJobFiles(root: string) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry: JsonValue) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry: JsonValue) => path.join(root, entry.name))
    .sort();
}

function classifyJob(jobPath: string) {
  let job;
  try {
    job = parseJob(jobPath);
  } catch (error) {
    return baseRow(jobPath, null, "invalid", error.message);
  }
  const errors = validateJob(job);
  if (errors.length > 0) {
    return baseRow(jobPath, job.frontmatter.cluster_id, "invalid", errors.join("; "));
  }

  const clusterId = String(job.frontmatter.cluster_id);
  const latest = latestByCluster.get(clusterId);
  const openPrs = openPrClusters.get(clusterId) ?? [];
  const row = baseRow(jobPath, clusterId, "keep", "job is still eligible for normal dispatch");
  row.mode = job.frontmatter.mode;
  row.latest_run_id = latest?.run_id ?? null;
  row.latest_workflow_conclusion = latest?.workflow_conclusion ?? null;
  row.latest_result_status = latest?.result_status ?? null;
  row.open_prs = openPrs;

  if (isExampleJob(job)) {
    return { ...row, status: "keep", reason: "example job is referenced by local run docs" };
  }
  if (job.frontmatter.security_sensitive === true || hasSecuritySignalText(job.raw)) {
    return {
      ...row,
      status: "security_hold",
      reason: "security-sensitive job stays out of automation cleanup",
    };
  }
  if (openPrs.length > 0) {
    return { ...row, status: "active", reason: "open clawsweeper PR exists for this cluster" };
  }
  if (isTestJob(job) && latest) {
    return {
      ...row,
      status: "delete_test_job",
      reason: "old smoke/test job has a published result and no open clawsweeper PR",
    };
  }
  if (!latest) {
    return { ...row, status: "move_to_stuck", reason: "no published run record found" };
  }
  if (needsRequeue(latest)) {
    return { ...row, status: "requeue_candidate", reason: requeueReason(latest) };
  }
  if (isFinalized(latest)) {
    return {
      ...row,
      status: "move_to_outbox",
      reason: "latest run is clean and no open clawsweeper PR remains",
    };
  }
  return row;
}

function baseRow(jobPath: string, clusterId: JsonValue, status: string, reason: string): JsonValue {
  return {
    job: path.relative(repoRoot(), jobPath),
    cluster_id: clusterId,
    status,
    reason,
  };
}

function isTestJob(job: LooseRecord) {
  const name = path.basename(job.path);
  return name.includes("autonomous-smoke");
}

function isExampleJob(job: LooseRecord) {
  const name = path.basename(job.path);
  return name === "cluster-example.md" || name === "autonomous-example.md";
}

function needsRequeue(record: LooseRecord) {
  if (["failure", "cancelled", "timed_out"].includes(String(record.workflow_conclusion ?? "")))
    return true;
  if (
    (record.fix_actions ?? []).some((action: JsonValue) =>
      ["failed", "blocked"].includes(String(action.status ?? "")),
    )
  ) {
    return true;
  }
  if (
    (record.apply_actions ?? []).some(
      (action: JsonValue) => String(action.status ?? "") === "blocked",
    )
  )
    return true;
  return false;
}

function requeueReason(record: LooseRecord) {
  if (["failure", "cancelled", "timed_out"].includes(String(record.workflow_conclusion ?? ""))) {
    return `latest workflow conclusion is ${record.workflow_conclusion}`;
  }
  if (
    (record.fix_actions ?? []).some((action: JsonValue) =>
      ["failed", "blocked"].includes(String(action.status ?? "")),
    )
  ) {
    return "latest result has blocked or failed fix actions";
  }
  return "latest result has blocked apply actions";
}

function isFinalized(record: LooseRecord) {
  if (record.workflow_conclusion !== "success") return false;
  if (record.result_status === "needs_human") return false;
  if ((record.needs_human ?? []).length > 0) return false;
  if (needsRequeue(record)) return false;
  return true;
}

function applyActions(classifiedRows: JsonValue) {
  for (const row of classifiedRows) {
    const absolute = path.join(repoRoot(), row.job);
    if (applyDeleteTests && row.status === "delete_test_job") {
      fs.unlinkSync(absolute);
      row.applied = "deleted";
    }
    if (applyOutbox && row.status === "move_to_outbox") {
      fs.mkdirSync(outboxDir, { recursive: true });
      const destination = path.join(outboxDir, path.basename(row.job));
      fs.renameSync(absolute, destination);
      row.applied = `moved:${path.relative(repoRoot(), destination)}`;
    }
    if (applyStuck && row.status === "move_to_stuck") {
      fs.mkdirSync(stuckDir, { recursive: true });
      const destination = path.join(stuckDir, path.basename(row.job));
      fs.renameSync(absolute, destination);
      row.applied = `moved:${path.relative(repoRoot(), destination)}`;
    }
  }
}

function readRunRecords() {
  const dir = path.join(repoRoot(), "results", "runs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name: string) => name.endsWith(".json"))
    .map((name: string) => readJson(path.join(dir, name)))
    .filter(Boolean);
}

function latestClusterRecords(runRecords: JsonValue) {
  const latest = new Map();
  for (const record of runRecords) {
    const clusterId = String(record.cluster_id ?? "");
    if (!clusterId) continue;
    const previous = latest.get(clusterId);
    if (
      !previous ||
      String(record.published_at ?? "").localeCompare(String(previous.published_at ?? "")) > 0
    ) {
      latest.set(clusterId, record);
    }
  }
  return latest;
}

function readOpenClawSweeperPrClusters() {
  const repo = requireTargetRepo(process.env.CLAWSWEEPER_TARGET_REPO);
  const pulls = ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number,title,headRefName,url,updatedAt",
  ]);
  const byCluster = new Map();
  for (const pull of pulls ?? []) {
    const head = String(pull.headRefName ?? "");
    if (!head.startsWith("clawsweeper/")) continue;
    const clusterId = head.replace(/^clawsweeper\//, "");
    const rows = byCluster.get(clusterId) ?? [];
    rows.push({
      number: pull.number,
      title: pull.title,
      url: pull.url,
      head_ref: head,
      updated_at: pull.updatedAt,
    });
    byCluster.set(clusterId, rows);
  }
  return byCluster;
}

function readActiveClusterRuns() {
  const repo = process.env.CLAWSWEEPER_REPO ?? "openclaw/clawsweeper";
  const statuses = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
  const workflowName = workflowDisplayName(REPAIR_CLUSTER_WORKFLOW);
  const runs = ghJson<LooseRecord[]>([
    "run",
    "list",
    "--repo",
    repo,
    "--limit",
    "200",
    "--json",
    "databaseId,workflowName,status,conclusion,createdAt,updatedAt,url,displayTitle",
  ]).filter((run: LooseRecord) => {
    return run.workflowName === workflowName && statuses.has(String(run.status));
  });
  const byId = new Map();
  for (const run of runs) byId.set(String(run.databaseId), run);
  return [...byId.values()].sort((left: JsonValue, right: JsonValue) =>
    String(right.createdAt).localeCompare(String(left.createdAt)),
  );
}

function workflowDisplayName(workflow: string): string {
  if (workflow === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflow;
}

function publicRow(row: LooseRecord) {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]: JsonValue[]) => value !== undefined),
  );
}

function countBy(rows: LooseRecord[], keyFn: JsonValue) {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function writeMarkdownReport(report: LooseRecord, filePath: string) {
  const sections = [
    ["Delete Test Jobs", report.delete_test_jobs],
    ["Move To Outbox", report.outbox_jobs],
    ["Move To Stuck Queue", report.stuck_jobs],
    ["Requeue Candidates", report.requeue_candidates],
    ["Active Jobs", report.active_jobs],
    ["Security Hold Jobs", report.security_hold_jobs],
    ["Invalid Jobs", report.invalid_jobs],
  ];
  const body = `# OpenClaw Job Sweep

Mode: ${report.status}

| Metric | Count |
| --- | ---: |
| Jobs | ${report.totals.jobs ?? 0} |
| Delete test jobs | ${report.totals.delete_test_job ?? 0} |
| Move to outbox | ${report.totals.move_to_outbox ?? 0} |
| Move to stuck queue | ${report.totals.move_to_stuck ?? 0} |
| Requeue candidates | ${report.totals.requeue_candidate ?? 0} |
| Active | ${report.totals.active ?? 0} |
| Security hold | ${report.totals.security_hold ?? 0} |
| Invalid | ${report.totals.invalid ?? 0} |

${sections.map(renderSection).join("\n\n")}
`;
  fs.writeFileSync(filePath, body, "utf8");
}

function renderSection([title, rows]: JsonValue) {
  const body = rows
    .slice(0, 150)
    .map((row: JsonValue) => `| ${row.job} | ${row.cluster_id ?? ""} | ${row.reason} |`)
    .join("\n");
  return `## ${title}

| Job | Cluster | Reason |
| --- | --- | --- |
${body || "| _None_ |  |  |"}`;
}
