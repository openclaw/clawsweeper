#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { githubActionsRunUrl, parseArgs, repoRoot } from "./lib.js";
import { readJsonFile as readJson } from "./json-file.js";
import { escapeRegExp, slug } from "./text-utils.js";
import { renderClusterReport, writeClosedRecord } from "./publish-cluster-report.js";
import {
  findResultPaths,
  inferRunId,
  latestClusterRecords,
  readArchivedClusters,
  readExistingRunRecord,
  readRunMetadata,
  readRunRecords,
  readSiblingJson,
} from "./publish-files.js";
import { formatTimestamp, normalizeRetiredRepairEnvNames, tableCell } from "./publish-markdown.js";
import {
  buildInspectionRows,
  renderBlockedReasonRows,
  renderFinalizerRows,
  renderFixFailureRows,
  renderInspectionRows,
  renderRecentClosureRows,
} from "./publish-dashboard-rows.js";
import {
  buildTrackedPrRows,
  hydrateClosureRows,
  sortNewestClosureRowFirst,
} from "./publish-tracked-rows.js";

const DASHBOARD_START = "<!-- clawsweeper-repair-dashboard:start -->";
const DASHBOARD_END = "<!-- clawsweeper-repair-dashboard:end -->";
const CLOSE_APPLICATOR_ACTIONS = new Set([
  "close",
  "close_duplicate",
  "close_superseded",
  "close_fixed_by_candidate",
  "close_low_signal",
  "post_merge_close",
]);
const MERGE_APPLICATOR_ACTIONS = new Set(["merge_candidate", "merge_canonical"]);
const APPLICATOR_ACTIONS = new Set([...CLOSE_APPLICATOR_ACTIONS, ...MERGE_APPLICATOR_ACTIONS]);
const POST_FLIGHT_APPLY_ACTIONS = new Set(["finalize_fix_pr", "post_merge_closeout"]);
const root = repoRoot();
const archivedClusters = readArchivedClusters(root);

const args = parseArgs(process.argv.slice(2));
const inputs = args._.length > 0 ? args._ : [path.join(root, ".clawsweeper-repair", "runs")];
const metadataByRunId = readRunMetadata(args["runs-json"]);
const published: LooseRecord[] = [];

for (const input of inputs) {
  for (const resultPath of findResultPaths(path.resolve(input))) {
    const record = publishResult(resultPath);
    published.push(record);
  }
}

writeAggregateApplyReport();
if (args["write-dashboard"]) updateDashboard();

console.log(JSON.stringify({ published: published.length, records: published }, null, 2));

function publishResult(resultPath: string) {
  const runDir = path.dirname(resultPath);
  const result = readJson(resultPath);
  const applyReport = readSiblingJson(runDir, "apply-report.json") ?? { actions: [] };
  const postFlightReport = readSiblingJson(runDir, "post-flight-report.json") ?? { actions: [] };
  const fixReport = readSiblingJson(runDir, "fix-execution-report.json") ?? { actions: [] };
  const clusterPlan = readSiblingJson(runDir, "cluster-plan.json");
  const runId = String(args["run-id"] ?? inferRunId(resultPath) ?? "");
  const metadata = runId ? metadataByRunId.get(runId) : undefined;
  const previousRecord = runId ? readExistingRunRecord(root, runId) : null;
  const runUrl =
    String(args["run-url"] ?? metadata?.url ?? "") ||
    previousRecord?.run_url ||
    (runId ? githubActionsRunUrl(runId) : null);
  const headSha = String(
    args["head-sha"] ?? metadata?.headSha ?? metadata?.head_sha ?? previousRecord?.head_sha ?? "",
  );
  const workflowConclusion = String(
    args.conclusion ?? metadata?.conclusion ?? previousRecord?.workflow_conclusion ?? "",
  );
  const workflowStatus = String(metadata?.status ?? previousRecord?.workflow_status ?? "");
  const repo = String(result.repo ?? "unknown/unknown");
  const owner = repo.split("/")[0] || "unknown";
  const clusterId = String(result.cluster_id ?? path.basename(runDir));
  const applyActions = uniquePlainActionRows(
    [
      ...(applyReport.actions ?? []),
      ...(postFlightReport.actions ?? [])
        .filter(isPostFlightApplyAction)
        .map(postFlightToApplyAction),
    ].filter(isApplicatorAction),
  );
  const fixActions = (fixReport.actions ?? []).map(sanitizeFixAction);
  const report = {
    repo,
    cluster_id: clusterId,
    mode: result.mode ?? null,
    run_id: runId || null,
    run_url: runUrl,
    head_sha: headSha || null,
    workflow_conclusion: workflowConclusion || null,
    workflow_status: workflowStatus || null,
    post_flight_outcome: postFlightReport.outcome ?? null,
    post_flight_detail: postFlightReport.detail ?? null,
    workflow_created_at:
      metadata?.createdAt ?? metadata?.created_at ?? previousRecord?.workflow_created_at ?? null,
    workflow_updated_at:
      metadata?.updatedAt ?? metadata?.updated_at ?? previousRecord?.workflow_updated_at ?? null,
    result_status: result.status ?? null,
    source_job: clusterPlan?.source_job ?? null,
    published_at: new Date().toISOString(),
    canonical: result.canonical ?? null,
    canonical_issue: result.canonical_issue ?? null,
    canonical_pr: result.canonical_pr ?? null,
    summary: result.summary ?? "",
    actions: summarizeActions(result.actions),
    action_counts: countBy(result.actions ?? [], (action: JsonValue) =>
      String(action.action ?? "unknown"),
    ),
    action_status_counts: countBy(result.actions ?? [], (action: JsonValue) =>
      String(action.status ?? "unknown"),
    ),
    fix_counts: countBy(fixActions, (action: JsonValue) => String(action.status ?? "unknown")),
    apply_counts: countBy(applyActions, (action: JsonValue) => String(action.status ?? "unknown")),
    needs_human: Array.isArray(result.needs_human) ? result.needs_human : [],
    fix_actions: fixActions,
    apply_actions: applyActions.map(sanitizeApplyAction),
  };

  const reportDir = path.join(root, "results", owner);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, `${slug(clusterId)}.md`),
    renderClusterReport(report),
    "utf8",
  );

  const runDirOut = path.join(root, "results", "runs");
  fs.mkdirSync(runDirOut, { recursive: true });
  if (runId) {
    fs.writeFileSync(
      path.join(runDirOut, `${runId}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  for (const action of report.apply_actions.filter(
    (action: JsonValue) => action.status === "executed",
  )) {
    writeClosedRecord({ report, action, owner, root });
  }

  return {
    cluster_id: report.cluster_id,
    run_id: report.run_id,
    result_status: report.result_status,
    workflow_conclusion: report.workflow_conclusion,
    fix_counts: report.fix_counts,
    apply_counts: report.apply_counts,
  };
}

function updateDashboard() {
  const readmePath = path.join(root, "docs", "repair", "README.md");
  if (!fs.existsSync(readmePath)) return;
  const readme = fs.readFileSync(readmePath, "utf8");
  const records = readRunRecords(root);
  const allLatestByCluster = latestClusterRecords(records).sort(sortNewestRecordFirst);
  const latestByCluster = allLatestByCluster.filter(
    (record: JsonValue) => !archivedClusters.has(record.cluster_id),
  );
  const archivedLatestByCluster = allLatestByCluster.filter((record: JsonValue) =>
    archivedClusters.has(record.cluster_id),
  );
  const trackedPrRows = buildTrackedPrRows(records, MERGE_APPLICATOR_ACTIONS);
  const latestApplyRows = latestByCluster.flatMap((record: JsonValue) =>
    (record.apply_actions ?? [])
      .filter(isApplicatorAction)
      .map((action: JsonValue) => ({ record, action })),
  );
  const latestFixRows = latestByCluster.flatMap((record: JsonValue) =>
    (record.fix_actions ?? []).map((action: JsonValue) => ({ record, action })),
  );
  const fixRows = uniqueFixRows(
    records.flatMap((record: JsonValue) =>
      (record.fix_actions ?? []).map((action: JsonValue) => ({ record, action })),
    ),
  );
  const applyRows = uniqueActionRows(
    records.flatMap((record: JsonValue) =>
      (record.apply_actions ?? [])
        .filter(isApplicatorAction)
        .map((action: JsonValue) => ({ record, action })),
    ),
  );
  const executedRows = applyRows.filter((row: JsonValue) => row.action.status === "executed");
  const closedRows = executedRows.filter((row: JsonValue) =>
    CLOSE_APPLICATOR_ACTIONS.has(String(row.action.action ?? "")),
  );
  const mergedRows = executedRows.filter((row: JsonValue) =>
    MERGE_APPLICATOR_ACTIONS.has(String(row.action.action ?? "")),
  );
  const closureRows = hydrateClosureRows(closedRows).sort(sortNewestClosureRowFirst);
  const blockedRows = applyRows.filter((row: JsonValue) => row.action.status === "blocked");
  const skippedRows = applyRows.filter((row: JsonValue) => row.action.status === "skipped");
  const latestBlockedRows = latestApplyRows.filter(
    (row: JsonValue) => row.action.status === "blocked",
  );
  const latestSkippedRows = latestApplyRows.filter(
    (row: JsonValue) => row.action.status === "skipped",
  );
  const latestFailedFixRows = latestFixRows.filter((row: JsonValue) =>
    ["blocked", "failed"].includes(String(row.action.status ?? "")),
  );
  const needsHumanRows = latestByCluster.filter(
    (record: JsonValue) => (record.needs_human ?? []).length > 0,
  );
  const inspectionRows = buildInspectionRows({
    latestByCluster,
    latestFailedFixRows,
    latestBlockedRows,
    latestSkippedRows,
  });
  const finalizerReport = readFinalizerReport();
  const cleanClusters = latestByCluster.filter(
    (record: JsonValue) =>
      record.workflow_conclusion === "success" &&
      (record.needs_human ?? []).length === 0 &&
      (record.fix_actions ?? []).every(
        (action: JsonValue) => !["blocked", "failed"].includes(action.status),
      ) &&
      (record.apply_actions ?? []).every(
        (action: JsonValue) => !["blocked", "failed"].includes(action.status),
      ),
  );
  const workflowState = latestByCluster.some(
    (record: JsonValue) => record.workflow_conclusion === "failure",
  )
    ? "Failed clusters need inspection"
    : latestFailedFixRows.length > 0
      ? "Fix execution needs repair"
      : latestBlockedRows.length > 0
        ? "Blocked actions need triage"
        : needsHumanRows.length > 0
          ? "Human review needed"
          : "Clean";
  const mutationRows = applyRows.filter((row: JsonValue) =>
    ["executed", "blocked", "skipped"].includes(String(row.action.status ?? "")),
  );
  const duplicateCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "duplicate",
  );
  const supersededCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "superseded",
  );
  const fixedByCandidateCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "fixed_by_candidate",
  );
  const lowSignalCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "low_signal",
  );
  const totals = {
    clusters: latestByCluster.length,
    archivedClusters: archivedLatestByCluster.length,
    runs: records.length,
    success: latestByCluster.filter((record: JsonValue) => record.workflow_conclusion === "success")
      .length,
    failure: latestByCluster.filter((record: JsonValue) => record.workflow_conclusion === "failure")
      .length,
    cancelled: latestByCluster.filter(
      (record: JsonValue) => record.workflow_conclusion === "cancelled",
    ).length,
    cleanClusters: cleanClusters.length,
    closed: closedRows.length,
    merged: mergedRows.length,
    trackedPrs: trackedPrRows.length,
    openTrackedPrs: countRows(trackedPrRows, (row: JsonValue) => row.state === "open"),
    closedUnmergedTrackedPrs: countRows(
      trackedPrRows,
      (row: JsonValue) => row.state === "closed" && !row.merged,
    ),
    blocked: blockedRows.length,
    skipped: skippedRows.length,
    fixAttempts: fixRows.length,
    fixExecuted: countRows(fixRows, (row: JsonValue) => row.action.status === "executed"),
    fixFailed: countRows(fixRows, (row: JsonValue) => row.action.status === "failed"),
    fixBlocked: countRows(fixRows, (row: JsonValue) => row.action.status === "blocked"),
    latestFixProblemClusters: new Set(
      latestFailedFixRows.map((row: JsonValue) => row.record.cluster_id),
    ).size,
    needsHumanClusters: needsHumanRows.length,
    mutationAttempts: mutationRows.length,
    duplicateCloses,
    supersededCloses,
    fixedByCandidateCloses,
    lowSignalCloses,
  };
  const dashboard = `## Dashboard

Last dashboard update: ${formatTimestamp(new Date().toISOString())}

${DASHBOARD_START}
State: ${workflowState}

Scope: ${totals.clusters} active latest cluster reports. ${totals.archivedClusters} policy-archived cluster(s) are excluded from health stats; run attempts are tracked as audit history only.

| Metric | Count | Rate |
| --- | ---: | ---: |
${renderMetricRow("Latest clusters reviewed", totals.clusters, "100%")}
${renderMetricRow("Policy-archived clusters", totals.archivedClusters, "audit")}
${renderMetricRow("Clean completed clusters", totals.cleanClusters, percent(totals.cleanClusters, totals.clusters))}
${renderMetricRow("Needs-human clusters", totals.needsHumanClusters, percent(totals.needsHumanClusters, totals.clusters))}
${renderMetricRow("Latest successful clusters", totals.success, percent(totals.success, totals.clusters))}
${renderMetricRow("Latest failed clusters", totals.failure, percent(totals.failure, totals.clusters))}
${renderMetricRow("Latest cancelled clusters", totals.cancelled, percent(totals.cancelled, totals.clusters))}
${renderMetricRow("Run attempts archived", totals.runs, "audit")}
${renderMetricRow("Fix action attempts", totals.fixAttempts, "audit")}
${renderMetricRow("Fix actions executed", totals.fixExecuted, percent(totals.fixExecuted, totals.fixAttempts))}
${renderMetricRow("Fix actions failed", totals.fixFailed, percent(totals.fixFailed, totals.fixAttempts))}
${renderMetricRow("Fix actions blocked", totals.fixBlocked, percent(totals.fixBlocked, totals.fixAttempts))}
${renderMetricRow("Latest clusters with fix failures", totals.latestFixProblemClusters, percent(totals.latestFixProblemClusters, totals.clusters))}
${renderMetricRow("Distinct PRs touched", totals.trackedPrs, "100%")}
${renderMetricRow("Open PRs tracked", totals.openTrackedPrs, percent(totals.openTrackedPrs, totals.trackedPrs))}
${renderMetricRow(
  "Closed unmerged PRs tracked",
  totals.closedUnmergedTrackedPrs,
  percent(totals.closedUnmergedTrackedPrs, totals.trackedPrs),
)}
${renderMetricRow("Completed close actions", totals.closed, percent(totals.closed, totals.mutationAttempts))}
${renderMetricRow("Completed merge actions", totals.merged, percent(totals.merged, totals.mutationAttempts))}
${renderMetricRow("Duplicate closes", totals.duplicateCloses, percent(totals.duplicateCloses, totals.closed))}
${renderMetricRow("Superseded closes", totals.supersededCloses, percent(totals.supersededCloses, totals.closed))}
${renderMetricRow(
  "Fixed-by-candidate closes",
  totals.fixedByCandidateCloses,
  percent(totals.fixedByCandidateCloses, totals.closed),
)}
${renderMetricRow("Low-signal PR closes", totals.lowSignalCloses, percent(totals.lowSignalCloses, totals.closed))}
${renderMetricRow("Blocked mutation attempts", totals.blocked, percent(totals.blocked, totals.mutationAttempts))}
${renderMetricRow("Skipped mutation attempts", totals.skipped, percent(totals.skipped, totals.mutationAttempts))}

### Clusters Needing Inspection

| Cluster | State | Source job | Reason | Report | Run |
| --- | --- | --- | --- | --- | --- |
${renderInspectionRows(inspectionRows.slice(0, 25))}

### Fix Failure Queue

| Cluster | Status | Target | Branch/PR | Reason | Run |
| --- | --- | --- | --- | --- | --- |
${renderFixFailureRows(latestFailedFixRows.slice(0, 25))}

### Top Blocked Reasons

| Reason | Latest count | Example cluster |
| --- | ---: | --- |
${renderBlockedReasonRows([...latestBlockedRows, ...latestSkippedRows])}

### Open PR Finalizer Queue

| PR | Title | Cluster | Branch | Blockers | Next action |
| --- | --- | --- | --- | --- | --- |
${renderFinalizerRows(finalizerReport)}

### Latest ClawSweeper Repair Closures

| Target | Type | Title | Closed | Action | Cluster | Report | Run |
| --- | --- | --- | --- | --- | --- | --- | --- |
${renderRecentClosureRows(closureRows.slice(0, 25))}
${DASHBOARD_END}`;

  let updated;
  const markerPattern = new RegExp(
    `${escapeRegExp(DASHBOARD_START)}[\\s\\S]*?${escapeRegExp(DASHBOARD_END)}`,
  );
  if (markerPattern.test(readme)) {
    updated = readme.replace(
      /## Dashboard[\s\S]*?## How It Works/,
      `${dashboard}\n\n## How It Works`,
    );
  } else if (/## How It Works/.test(readme)) {
    updated = readme.replace(/## How It Works/, `${dashboard}\n\n## How It Works`);
  } else {
    updated = `${readme.trim()}\n\n${dashboard}\n`;
  }
  fs.writeFileSync(readmePath, updated, "utf8");
}

function writeAggregateApplyReport() {
  const records = readRunRecords(root);
  const rows = records.flatMap((record: JsonValue) =>
    (record.apply_actions ?? []).filter(isApplicatorAction).map((action: JsonValue) =>
      normalizeReportRow({
        repo: record.repo,
        run_id: record.run_id,
        run_url: record.run_url,
        cluster_id: record.cluster_id,
        published_at: record.published_at,
        ...action,
      }),
    ),
  );
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify(uniquePlainActionRows(rows), null, 2)}\n`,
    "utf8",
  );
}

function summarizeActions(actions: LooseRecord[]) {
  return (Array.isArray(actions) ? actions : []).map((action: JsonValue) => ({
    target: action.target ?? null,
    action: action.action ?? null,
    status: action.status ?? null,
    classification: action.classification ?? null,
    canonical: action.canonical ?? action.duplicate_of ?? null,
    candidate_fix: action.candidate_fix ?? null,
    reason: normalizeNullableText(action.reason),
  }));
}

function sanitizeApplyAction(action: LooseRecord) {
  return {
    target: action.target ?? null,
    action: action.action ?? null,
    status: action.status ?? null,
    classification: action.classification ?? null,
    canonical: action.canonical ?? null,
    candidate_fix: action.candidate_fix ?? null,
    title: action.title ?? action.target_title ?? action.pr_title ?? null,
    idempotency_key: action.idempotency_key ?? null,
    reason: normalizeNullableText(action.reason),
    merged_at: action.merged_at ?? null,
    merge_commit_sha: action.merge_commit_sha ?? null,
    live_state: action.live_state ?? null,
    live_updated_at: action.live_updated_at ?? null,
  };
}

function sanitizeFixAction(action: LooseRecord) {
  return {
    action: action.action ?? null,
    status: action.status ?? null,
    target: action.target ?? null,
    pr: action.pr ?? action.pr_url ?? null,
    branch: action.branch ?? action.head_branch ?? null,
    source_action: action.source_action ?? null,
    source_status: action.source_status ?? null,
    repair_strategy: action.repair_strategy ?? null,
    reason: normalizeNullableText(action.reason),
    title: action.title ?? null,
    url: action.url ?? action.pr_url ?? null,
  };
}

function isApplicatorAction(action: LooseRecord) {
  return APPLICATOR_ACTIONS.has(String(action?.action ?? ""));
}

function isPostFlightApplyAction(action: LooseRecord) {
  const actionName = String(action?.action ?? "");
  if (!POST_FLIGHT_APPLY_ACTIONS.has(actionName)) return false;
  if (actionName === "finalize_fix_pr") return Boolean(action?.pr);
  return Boolean(action?.target);
}

function postFlightToApplyAction(action: LooseRecord) {
  if (String(action.action ?? "") === "post_merge_closeout") {
    return {
      target: action.target,
      action: action.source_action ?? "post_merge_close",
      status: action.status,
      classification: "post_merge_closeout",
      canonical: action.canonical ?? null,
      candidate_fix: action.candidate_fix ?? null,
      title: action.title ?? null,
      reason: normalizeNullableText(action.reason),
      merged_at: null,
      merge_commit_sha: action.merge_commit_sha ?? null,
      live_state: action.live_state ?? null,
      live_updated_at: null,
    };
  }
  return {
    target: action.pr,
    action: "merge_canonical",
    status: action.status,
    classification: "fix_pr",
    title: action.title ?? null,
    reason: normalizeNullableText(action.reason),
    merged_at: action.merged_at ?? null,
    merge_commit_sha: action.merge_commit_sha ?? null,
    live_state: action.status === "executed" ? "merged" : null,
    live_updated_at: null,
  };
}

function normalizeNullableText(value: JsonValue) {
  if (typeof value !== "string") return value ?? null;
  return normalizeRetiredRepairEnvNames(value);
}

function normalizeReportRow(row: LooseRecord): LooseRecord {
  const normalized: LooseRecord = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = typeof value === "string" ? normalizeRetiredRepairEnvNames(value) : value;
  }
  return normalized;
}

function sortNewestRecordFirst(left: JsonValue, right: JsonValue) {
  return String(right.published_at ?? "").localeCompare(String(left.published_at ?? ""));
}

function countRows(rows: LooseRecord[], predicate: (row: LooseRecord) => boolean) {
  return rows.filter(predicate).length;
}

function readFinalizerReport() {
  const filePath = path.join(root, "results", "finalize-open-prs.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function uniqueActionRows(rows: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const row of rows) {
    const record = row.record ?? row;
    const action = row.action ?? row;
    const key = [record.repo, action.target, action.action].join(":");
    const previous = byKey.get(key);
    if (!previous || preferActionRow(row, previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function uniquePlainActionRows(rows: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const row of rows) {
    const key = [row.repo, row.cluster_id, row.target, row.action].join(":");
    const previous = byKey.get(key);
    if (!previous || preferActionRow(row, previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function uniqueFixRows(rows: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const row of rows) {
    const record = row.record ?? row;
    const action = row.action ?? row;
    const key = [
      record.repo,
      record.cluster_id,
      action.action,
      action.target,
      action.pr,
      action.branch,
      action.repair_strategy,
      action.source_action,
    ].join(":");
    const previous = byKey.get(key);
    if (!previous || preferActionRow(row, previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function preferActionRow(candidate: LooseRecord, previous: JsonValue) {
  const candidateRecord =
    candidate.record && typeof candidate.record === "object" ? candidate.record : candidate;
  const previousRecord =
    previous.record && typeof previous.record === "object" ? previous.record : previous;
  const candidateAction =
    candidate.action && typeof candidate.action === "object" ? candidate.action : candidate;
  const previousAction =
    previous.action && typeof previous.action === "object" ? previous.action : previous;
  const candidateRank = actionStatusRank(candidateAction.status);
  const previousRank = actionStatusRank(previousAction.status);
  if (candidateRank !== previousRank) return candidateRank > previousRank;
  return (
    String(candidateRecord.published_at ?? "").localeCompare(
      String(previousRecord.published_at ?? ""),
    ) > 0
  );
}

function actionStatusRank(status: string) {
  switch (status) {
    case "executed":
      return 6;
    case "merged":
      return 6;
    case "failed":
      return 5;
    case "blocked":
      return 4;
    case "skipped":
      return 3;
    case "planned":
      return 2;
    default:
      return 1;
  }
}

function renderMetricRow(metric: string, count: JsonValue, rate: string) {
  return `| ${tableCell(metric)} | ${count} | ${tableCell(rate)} |`;
}

function percent(count: JsonValue, total: JsonValue) {
  if (!total) return "0.0%";
  return `${((Number(count) / Number(total)) * 100).toFixed(1)}%`;
}

function countBy(values: LooseRecord[], keyFn: (value: LooseRecord) => string) {
  const out: Record<string, number> = {};
  for (const value of Array.isArray(values) ? values : []) {
    const key = keyFn(value);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
