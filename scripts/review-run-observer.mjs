#!/usr/bin/env node

/**
 * 定义：只读 GitHub workflow_run 终态并写入 ClawSweeper review 观测接口。
 * 参数：--event-file 必填；--dry-run 可选。认证和 API 地址来自环境变量。
 * 输出：stdout 打印 skipped 或写入摘要；错误写 stderr，退出码 1。
 * 决策：无法证明是 review 的 sweep 运行直接跳过，避免把 apply/audit/router 支持任务计入成功率。
 */

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function usage() {
  return `Usage:
  node scripts/review-run-observer.mjs --event-file <path> [--dry-run]

Description:
  Observe one completed ClawSweeper workflow_run and publish bounded run-level telemetry.

Options:
  --event-file <path>  GitHub event JSON containing workflow_run (required)
  --dry-run            Print the normalized record without posting it
  -h, --help           Show this help

Outputs:
  Prints a JSON record in dry-run mode or a one-line publish/skip summary. Exit 1 means
  the event, GitHub lookup, configuration, or telemetry write was invalid.

Examples:
  node scripts/review-run-observer.mjs --event-file "$GITHUB_EVENT_PATH" --dry-run
  node scripts/review-run-observer.mjs --event-file event.json
`;
}

export function classifyReviewRun(run) {
  const title = String(run.display_title || run.name || "").trim();
  const event = String(run.event || "");
  if (/^(Apply |Sync |Audit |Fan out )/.test(title)) return null;
  let triggerLane;
  if (title.startsWith("Review event item")) triggerLane = "exact_event";
  else if (/^Review hot (?:ClawSweeper items|target repo)/.test(title)) triggerLane = "hot_intake";
  else if (title.startsWith("Retry failed Codex reviews")) triggerLane = "recovery";
  else if (/^Review (?:target repo|ClawSweeper items)/.test(title)) triggerLane = "normal_backfill";
  else return null;

  const command = /\[(?:router-|command:)/i.test(title);
  const triggerOrigin = command
    ? "command"
    : event === "schedule"
      ? "schedule"
      : event === "workflow_dispatch"
        ? "manual"
        : event === "repository_dispatch"
          ? "webhook"
          : "system";
  const targetMatch = title.match(
    /\b(?:repo |item |items |for )([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\b)/,
  );
  return {
    trigger_lane: triggerLane,
    trigger_origin: triggerOrigin,
    target_repo: targetMatch?.[1] ?? null,
  };
}

export function buildReviewRunTelemetry(run, jobs) {
  const classification = classifyReviewRun(run);
  if (!classification) return null;
  const names = jobs.map((job) => String(job.name || ""));
  const titleItem = String(run.display_title || "").match(/#(\d+)\b/)?.[1];
  const rawReviewJobs = jobs.flatMap((job) => {
    const name = String(job.name || "");
    if (!/^Review (?:exact event item|item|shard)\b/i.test(name)) {
      return [];
    }
    const conclusion = ["success", "failure", "cancelled", "skipped"].includes(job.conclusion)
      ? job.conclusion
      : "failure";
    const itemMatch = name.match(/(?:#|\bitem\s+)(\d+)\b/i)?.[1];
    return [{ name, conclusion, item_number: itemMatch ? Number(itemMatch) : null }];
  });
  // Exact-event rolling deploys can expose both old and new compute jobs for
  // one title-bound item. Collapse them to the durable item identity instead
  // of manufacturing multiple attempts for one run tuple.
  const reviewJobs =
    titleItem && rawReviewJobs.length
      ? [mergeTitleItemJobs(rawReviewJobs, Number(titleItem))]
      : rawReviewJobs;
  const count = (pattern) => names.filter((name) => pattern.test(name)).length;
  const activePlanCount = jobs.filter(
    (job) =>
      /\b(?:plan|select).*review/i.test(String(job.name || "")) && job.conclusion !== "skipped",
  ).length;
  const activeReviewCount = reviewJobs.filter((job) => job.conclusion !== "skipped").length;
  // Queue-intake and publication-only sweep runs share the review title. Only an active plan or
  // review-compute job proves that the run belongs in the review reliability denominator.
  if (!activePlanCount && !activeReviewCount) return null;
  const startedAt = run.run_started_at || run.created_at;
  return {
    run_id: String(run.id || ""),
    run_attempt: Number(run.run_attempt),
    workflow_outcome:
      run.conclusion === "success"
        ? "success"
        : run.conclusion === "cancelled"
          ? "cancelled"
          : run.conclusion === "skipped"
            ? "skipped"
            : "failure",
    ...classification,
    started_at: startedAt,
    completed_at: run.updated_at,
    run_url: run.html_url,
    plan_count: activePlanCount,
    item_count: reviewJobs.length,
    publication_count: count(/\bPublish .*review/i),
    source_event: String(run.event || "system"),
    review_jobs: reviewJobs.slice(0, 1_000),
  };
}

function mergeTitleItemJobs(jobs, itemNumber) {
  const rank = { skipped: 0, success: 1, cancelled: 2, failure: 3 };
  const selected = jobs.reduce((current, candidate) =>
    rank[candidate.conclusion] > rank[current.conclusion] ? candidate : current,
  );
  return { ...selected, item_number: itemNumber };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.eventFile) throw new Error("--event-file is required; use --help for examples");
  const event = JSON.parse(await readFile(args.eventFile, "utf8"));
  const run = event.workflow_run;
  if (!run || run.status !== "completed")
    throw new Error("event does not contain a completed workflow_run");
  const classification = classifyReviewRun(run);
  if (!classification) {
    process.stdout.write(`skipped non-review run ${String(run.id || "unknown")}\n`);
    return;
  }
  const jobs = await fetchJobs(run);
  const record = buildReviewRunTelemetry(run, jobs);
  if (!record) {
    process.stdout.write(`skipped support-only review run ${String(run.id || "unknown")}\n`);
    return;
  }
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  await publish(record);
  process.stdout.write(
    `observed review run ${record.run_id}/${record.run_attempt} lane=${record.trigger_lane} items=${record.item_count}\n`,
  );
}

function parseArgs(argv) {
  const result = { eventFile: "", dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--event-file") result.eventFile = String(argv[++index] || "");
    else throw new Error(`unknown option ${arg}; use --help`);
  }
  return result;
}

export async function fetchJobs(run, options = {}) {
  const token = options.token ?? process.env.GH_TOKEN ?? "";
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY ?? "";
  const apiUrl = options.apiUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!token || !repository) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const maxJobs = 1_000;
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `${apiUrl}/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    if (!response.ok) throw new Error(`GitHub jobs lookup returned ${response.status}`);
    const body = await response.json();
    const pageJobs = Array.isArray(body.jobs) ? body.jobs : [];
    const totalCount = Number.isSafeInteger(body.total_count) ? body.total_count : null;
    if (totalCount !== null && totalCount > maxJobs)
      throw new Error(`workflow job list exceeds observer bound of ${maxJobs}`);
    jobs.push(...pageJobs);
    // GitHub's total_count distinguishes an exact full final page from a truncated run.
    // Keep the short-page fallback for test doubles and older compatible API proxies.
    if (pageJobs.length < 100 || (totalCount !== null && jobs.length >= totalCount)) return jobs;
  }
  throw new Error(`workflow job list exceeds observer bound of ${maxJobs}`);
}

async function publish(record) {
  const secret = process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  const queueUrl = String(process.env.QUEUE_URL || "").replace(/\/$/, "");
  if (!secret || !queueUrl)
    throw new Error("CLAWSWEEPER_WEBHOOK_SECRET and QUEUE_URL are required");
  const body = JSON.stringify(record);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${queueUrl}/internal/exact-review/review-run-telemetry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`review telemetry write returned ${response.status}: ${await response.text()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `review-run-observer: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
