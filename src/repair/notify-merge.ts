#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject, JsonValue } from "./json-types.js";
import { asJsonObject } from "./json-types.js";
import { parseArgs, repoRoot } from "./lib.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import {
  errorText,
  normalizeString,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
  stringArg,
  stringOrNull,
} from "./openclaw-hook.js";
import type {
  CollectionResult,
  MergeLedgerEntry,
  MergeNotification,
  MergeNotificationLedger,
  MergeNotifierRuntime,
  MergeNotifierSummary,
} from "./notify-merge-types.js";
export { resolveHookAgentUrl } from "./openclaw-hook.js";

export type {
  CollectionResult,
  MergeLedgerEntry,
  MergeNotification,
  MergeNotificationLedger,
  MergeNotifierRuntime,
  MergeNotifierSummary,
} from "./notify-merge-types.js";

const MERGE_ACTIONS = new Set(["merge_candidate", "merge_canonical"]);
const DEFAULT_LEDGER_PATH = "notifications/clawsweeper-merge-ledger.json";
const DEFAULT_REPORT_PATH = "notifications/clawsweeper-merge-report.json";
const DEFAULT_INPUT_PATH = "repair-apply-report.json";
export function normalizeLedger(value: JsonValue): MergeNotificationLedger {
  const object = asJsonObject(value);
  const notifications = Array.isArray(object.notifications)
    ? object.notifications.map(asJsonObject).map(normalizeLedgerEntry).filter(isLedgerEntry)
    : [];
  return {
    version: 1,
    updated_at: stringOrNull(object.updated_at),
    notifications,
  };
}

function isLedgerEntry(value: MergeLedgerEntry | null): value is MergeLedgerEntry {
  return value !== null;
}

export function collectMergeNotifications(
  rows: JsonValue,
  ledger: MergeNotificationLedger,
  options: { runId?: string | undefined } = {},
): CollectionResult {
  const seen = new Set(ledger.notifications.map((entry) => entry.key));
  const notifications: MergeNotification[] = [];
  const skipped: JsonObject[] = [];
  const runId = normalizeString(options.runId);
  let considered = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = asJsonObject(raw);
    if (runId && stringOrNull(row.run_id) !== runId) continue;
    const candidate = buildMergeNotification(row);
    if (!candidate) continue;
    considered += 1;
    if (seen.has(candidate.key)) {
      skipped.push({
        key: candidate.key,
        repo: candidate.repo,
        target: candidate.target,
        status: "skipped",
        reason: "notification already sent",
      });
      continue;
    }
    seen.add(candidate.key);
    notifications.push(candidate);
  }

  return { considered, notifications, skipped };
}

export function buildMergeNotification(row: JsonObject): MergeNotification | null {
  const action = stringOrNull(row.action);
  if (!action || !MERGE_ACTIONS.has(action)) return null;
  if (stringOrNull(row.status) !== "executed") return null;
  const reason = stringOrNull(row.reason);
  if (reason?.toLowerCase() === "already merged") return null;

  const repo = stringOrNull(row.repo);
  const number = parseTargetNumber(row.target);
  if (!repo || !number) return null;

  const mergeCommitSha = stringOrNull(row.merge_commit_sha);
  const mergedAt = stringOrNull(row.merged_at);
  const runId = stringOrNull(row.run_id);
  const publishedAt = stringOrNull(row.published_at);
  const keySuffix = mergeCommitSha ?? mergedAt ?? runId ?? publishedAt ?? "unknown";
  const target = `#${number}`;
  const key = `merge:${repo}${target}:${action}:${keySuffix}`;
  return {
    key,
    idempotencyKey: key,
    repo,
    number,
    target,
    prUrl: `https://github.com/${repo}/pull/${number}`,
    title: stringOrNull(row.title),
    action,
    reason,
    mergedAt,
    mergeCommitSha,
    runId,
    runUrl: stringOrNull(row.run_url),
    clusterId: stringOrNull(row.cluster_id),
    publishedAt,
  };
}

export function addLedgerEntry(
  ledger: MergeNotificationLedger,
  notification: MergeNotification,
  result: { notifiedAt: string; hookRunId: string | null; discordTarget: string | null },
): MergeNotificationLedger {
  const existing = new Map(ledger.notifications.map((entry) => [entry.key, entry]));
  existing.set(notification.key, {
    ...notification,
    notifiedAt: result.notifiedAt,
    hookRunId: result.hookRunId,
    discordTarget: result.discordTarget,
  });
  return {
    version: 1,
    updated_at: result.notifiedAt,
    notifications: [...existing.values()].sort((left, right) =>
      left.notifiedAt.localeCompare(right.notifiedAt),
    ),
  };
}

export function renderNotificationMessage(notification: MergeNotification): string {
  return [
    "Send one concise Discord notification. Do not include a markdown table.",
    "",
    "Event: ClawSweeper merged a pull request.",
    `Repository: ${notification.repo}`,
    `Pull request: ${notification.target}${notification.title ? ` ${notification.title}` : ""}`,
    `URL: ${notification.prUrl}`,
    `Action: ${notification.action}`,
    `Reason: ${notification.reason ?? "merged by ClawSweeper"}`,
    `Merged at: ${notification.mergedAt ?? "unknown"}`,
    `Merge commit: ${notification.mergeCommitSha ?? "unknown"}`,
    `Cluster: ${notification.clusterId ?? "unknown"}`,
    `Workflow run: ${notification.runUrl ?? notification.runId ?? "unknown"}`,
  ].join("\n");
}

export async function runMergeNotifier(
  argv: string[],
  runtime: MergeNotifierRuntime = {},
): Promise<MergeNotifierSummary> {
  const args = parseArgs(argv);
  const root = runtime.root ?? repoRoot();
  const env = runtime.env ?? process.env;
  const log = runtime.log ?? console.log;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? (() => new Date());
  const inputPath = path.resolve(root, stringArg(args.input) ?? DEFAULT_INPUT_PATH);
  const ledgerPath = path.resolve(root, stringArg(args.ledger) ?? DEFAULT_LEDGER_PATH);
  const reportPath = path.resolve(root, stringArg(args.report) ?? DEFAULT_REPORT_PATH);
  const runId = stringArg(args["run-id"]) ?? env.RUN_ID ?? env.GITHUB_RUN_ID;
  const dryRun = Boolean(args["dry-run"] || env.CLAWSWEEPER_MERGE_NOTIFY_DRY_RUN === "1");
  const strict = Boolean(args.strict || env.CLAWSWEEPER_MERGE_NOTIFY_STRICT === "1");

  if (!fs.existsSync(inputPath)) {
    const summary = summaryRow("skipped", 0, 0, 0, 0, 0, "input report missing");
    log(JSON.stringify({ ...summary, inputPath }));
    return summary;
  }

  const ledger = readLedger(ledgerPath);
  const collected = collectMergeNotifications(readJsonFile(inputPath), ledger, { runId });
  const config = resolveOpenClawHookConfig(env);
  if (!config) {
    const summary = summaryRow(
      "skipped",
      collected.considered,
      collected.notifications.length,
      0,
      0,
      collected.skipped.length,
      "OpenClaw hook notification is not configured",
    );
    log(
      JSON.stringify({
        status: summary.status,
        reason: summary.reason,
        considered: summary.considered,
        pending: summary.pending,
      }),
    );
    return summary;
  }

  const reportActions: JsonObject[] = [...collected.skipped];
  let nextLedger = ledger;
  for (const notification of collected.notifications) {
    if (dryRun) {
      reportActions.push(reportRow(notification, "planned", "dry run"));
      continue;
    }
    try {
      const result = await postOpenClawAgentHook({
        config,
        fetcher,
        post: {
          name: `ClawSweeper merged ${notification.repo}${notification.target}`,
          message: renderNotificationMessage(notification),
          idempotencyKey: notification.idempotencyKey,
          deliver: true,
        },
      });
      const notifiedAt = now().toISOString();
      nextLedger = addLedgerEntry(nextLedger, notification, {
        notifiedAt,
        hookRunId: result.runId,
        discordTarget: config.discordTarget,
      });
      reportActions.push(reportRow(notification, "sent", "sent to OpenClaw hook", result.runId));
    } catch (error) {
      reportActions.push(reportRow(notification, "failed", errorText(error)));
    }
  }

  if (!dryRun && nextLedger !== ledger) writeJsonFile(ledgerPath, nextLedger);
  if (reportActions.length > 0 || Boolean(args["write-report"])) {
    writeJsonFile(reportPath, {
      version: 1,
      generated_at: now().toISOString(),
      input: path.relative(root, inputPath),
      ledger: path.relative(root, ledgerPath),
      dry_run: dryRun,
      run_id: runId ?? null,
      considered: collected.considered,
      pending: collected.notifications.length,
      sent: reportActions.filter((action) => action.status === "sent").length,
      failed: reportActions.filter((action) => action.status === "failed").length,
      skipped: reportActions.filter((action) => action.status === "skipped").length,
      actions: reportActions,
    });
  }

  const failed = reportActions.filter((action) => action.status === "failed").length;
  const summary = summaryRow(
    "ok",
    collected.considered,
    collected.notifications.length,
    reportActions.filter((action) => action.status === "sent").length,
    failed,
    reportActions.filter((action) => action.status === "skipped").length,
    null,
  );
  const result = { ...summary, exitCode: failed > 0 && strict ? 1 : 0 };
  log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const summary = await runMergeNotifier(process.argv.slice(2));
  if (summary.exitCode) process.exitCode = summary.exitCode;
}

function summaryRow(
  status: "ok" | "skipped",
  considered: number,
  pending: number,
  sent: number,
  failed: number,
  skipped: number,
  reason: string | null,
): MergeNotifierSummary {
  return {
    status,
    considered,
    pending,
    sent,
    failed,
    skipped,
    exitCode: 0,
    reason,
  };
}

function readLedger(ledgerPath: string): MergeNotificationLedger {
  if (!fs.existsSync(ledgerPath)) return { version: 1, updated_at: null, notifications: [] };
  return normalizeLedger(readJsonFile(ledgerPath));
}

function normalizeLedgerEntry(row: JsonObject): MergeLedgerEntry | null {
  const key = stringOrNull(row.key);
  const repo = stringOrNull(row.repo);
  const number = parseTargetNumber(row.number ?? row.target);
  const action = stringOrNull(row.action);
  const notifiedAt = stringOrNull(row.notifiedAt) ?? stringOrNull(row.notified_at);
  if (!key || !repo || !number || !action || !notifiedAt) return null;
  const target = stringOrNull(row.target) ?? `#${number}`;
  const prUrl =
    stringOrNull(row.prUrl) ??
    stringOrNull(row.pr_url) ??
    `https://github.com/${repo}/pull/${number}`;
  return {
    key,
    idempotencyKey: stringOrNull(row.idempotencyKey) ?? stringOrNull(row.idempotency_key) ?? key,
    repo,
    number,
    target,
    prUrl,
    title: stringOrNull(row.title),
    action,
    reason: stringOrNull(row.reason),
    mergedAt: stringOrNull(row.mergedAt) ?? stringOrNull(row.merged_at),
    mergeCommitSha: stringOrNull(row.mergeCommitSha) ?? stringOrNull(row.merge_commit_sha),
    runId: stringOrNull(row.runId) ?? stringOrNull(row.run_id),
    runUrl: stringOrNull(row.runUrl) ?? stringOrNull(row.run_url),
    clusterId: stringOrNull(row.clusterId) ?? stringOrNull(row.cluster_id),
    publishedAt: stringOrNull(row.publishedAt) ?? stringOrNull(row.published_at),
    notifiedAt,
    hookRunId: stringOrNull(row.hookRunId) ?? stringOrNull(row.hook_run_id),
    discordTarget: stringOrNull(row.discordTarget) ?? stringOrNull(row.discord_target),
  };
}

function reportRow(
  notification: MergeNotification,
  status: "failed" | "planned" | "sent",
  reason: string,
  hookRunId: string | null = null,
): JsonObject {
  return {
    key: notification.key,
    repo: notification.repo,
    target: notification.target,
    title: notification.title,
    action: notification.action,
    status,
    reason,
    merge_commit_sha: notification.mergeCommitSha,
    merged_at: notification.mergedAt,
    run_id: notification.runId,
    hook_run_id: hookRunId,
    url: notification.prUrl,
  };
}

function parseTargetNumber(value: JsonValue): number | null {
  const match = String(value ?? "").match(/^#?([0-9]+)$/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
