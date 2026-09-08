#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonObject } from "./json-types.js";
import { asJsonObject } from "./json-types.js";
import { writeJsonFile } from "./json-file.js";
import { parseArgs, repoRoot } from "./lib.js";
import {
  boolEnv,
  errorText,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
  stringArg,
  stringOrNull,
} from "./openclaw-hook.js";

export type MaintainerReportPointer = {
  date: string;
  reportUrl: string;
  dataUrl: string;
};

export type MaintainerReportNotifierSummary = {
  status: "ok" | "skipped";
  sent: number;
  failed: number;
  exitCode: number;
  reason: string | null;
  reportUrl: string | null;
  date: string | null;
};

export type MaintainerReportNotifierRuntime = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
};

const DEFAULT_BASE_URL = "https://reports.openclaw.ai/";
const DEFAULT_REPORT_PATH = "notifications/maintainer-report-discord.json";
const MAX_HIGHLIGHTS = 3;
const MAX_HIGHLIGHT_CHARS = 220;

export function resolveDailyReportPointer({
  index,
  baseUrl,
  publicBaseUrl,
  date,
}: {
  index: JsonObject;
  baseUrl: string;
  publicBaseUrl?: string;
  date?: string;
}): MaintainerReportPointer | null {
  const entries = Array.isArray(index.entries) ? index.entries.map(asJsonObject) : [];
  const entry =
    (date
      ? entries.find((item) => item.period === "day" && item.key === date)
      : asJsonObject(asJsonObject(index.latest).day)) ??
    entries.find((item) => item.period === "day");
  if (!entry) return null;
  const key = stringOrNull(entry.key);
  const href = stringOrNull(entry.href);
  const data = stringOrNull(entry.data);
  if (!key || !href || !data) return null;
  return {
    date: key,
    reportUrl: new URL(href, publicBaseUrl ?? baseUrl).toString(),
    dataUrl: new URL(data, baseUrl).toString(),
  };
}

export function renderMaintainerReportMessage({
  report,
  reportUrl,
}: {
  report: JsonObject;
  reportUrl: string;
}): string {
  const period = asJsonObject(report.period);
  const date =
    stringOrNull(period.key) ??
    dateFromIso(stringOrNull(period.since)) ??
    dateFromIso(stringOrNull(report.generatedAt));
  const title = date ? formatDate(date) : (stringOrNull(period.title) ?? "latest report");
  const totals = asJsonObject(report.totals);
  const github = asJsonObject(totals.github);
  const discord = asJsonObject(totals.discord);
  const highlights = readHighlights(report);
  const topRows = highlights.length ? highlights : topMaintainerRows(report);
  const lines = [
    `OpenClaw maintainer report: ${title}`,
    `${numberText(report.activeMaintainers)}/${numberText(report.maintainerCount)} active; ${numberText(github.commits)} commits, ${numberText(github.prsMerged)} merged PRs, ${numberText(github.issueComments)} issue/PR comments, ${numberText(discord.messages)} Discord messages.`,
    topRows.length ? "Highlights:" : "",
    ...topRows.map((row) => `- ${row}`),
    `Full report: ${reportUrl}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function runMaintainerReportNotifier(
  argv: string[],
  runtime: MaintainerReportNotifierRuntime = {},
): Promise<MaintainerReportNotifierSummary> {
  const args = parseArgs(argv);
  const root = runtime.root ?? repoRoot();
  const env = runtime.env ?? process.env;
  const fetcher = runtime.fetch ?? fetch;
  const log = runtime.log ?? console.log;
  const now = runtime.now ?? (() => new Date());
  const baseUrl = normalizeBaseUrl(
    stringArg(args["base-url"]) ?? env.REPORTS_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const publicBaseUrl = normalizeBaseUrl(
    stringArg(args["public-base-url"]) ?? env.REPORTS_PUBLIC_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const date = stringArg(args.date) ?? env.CLAWSWEEPER_MAINTAINER_REPORT_DATE;
  const reportPath = path.resolve(root, stringArg(args.report) ?? DEFAULT_REPORT_PATH);
  const dryRun = Boolean(args["dry-run"] || env.CLAWSWEEPER_MAINTAINER_REPORT_DRY_RUN === "1");
  const strict = Boolean(args.strict || env.CLAWSWEEPER_MAINTAINER_REPORT_STRICT === "1");
  const deliver = boolEnv(env.CLAWSWEEPER_MAINTAINER_REPORT_DELIVER, true);
  const accessHeaders = resolveReportsAccessHeaders(env);

  const pointer = await fetchReportPointer({
    fetcher,
    baseUrl,
    publicBaseUrl,
    ...(accessHeaders ? { headers: accessHeaders } : {}),
    ...(date ? { date } : {}),
  });
  if (!pointer) {
    const summary = summaryRow("skipped", 0, 0, "daily report not found", null, null, strict);
    log(JSON.stringify(summary));
    return summary;
  }

  const report = await fetchJson(fetcher, pointer.dataUrl, accessHeaders);
  const message = renderMaintainerReportMessage({ report, reportUrl: pointer.reportUrl });
  const config = resolveOpenClawHookConfig(env);
  if (!config) {
    if (args["write-report"]) {
      writeJsonFile(reportPath, reportPayload({ now, dryRun, deliver, pointer, message }));
    }
    log(message);
    const summary = summaryRow(
      "skipped",
      0,
      0,
      "OpenClaw hook notification is not configured",
      pointer.reportUrl,
      pointer.date,
      strict,
    );
    log(JSON.stringify(summary));
    return summary;
  }

  let hookRunId: string | null = null;
  let failed = 0;
  let reason: string | null = null;
  if (!dryRun) {
    try {
      const result = await postOpenClawAgentHook({
        config,
        fetcher,
        post: {
          name: `Maintainer report ${pointer.date}`,
          message,
          idempotencyKey: `maintainer-report:${pointer.date}`,
          deliver,
        },
      });
      hookRunId = result.runId;
    } catch (error) {
      failed = 1;
      reason = errorText(error);
    }
  }

  if (args["write-report"]) {
    writeJsonFile(reportPath, {
      ...reportPayload({ now, dryRun, deliver, pointer, message }),
      hook_run_id: hookRunId,
      failed,
      reason,
    });
  }

  const summary = summaryRow(
    "ok",
    failed ? 0 : 1,
    failed,
    reason,
    pointer.reportUrl,
    pointer.date,
    strict,
  );
  log(JSON.stringify(summary, null, 2));
  return summary;
}

async function fetchReportPointer({
  fetcher,
  baseUrl,
  publicBaseUrl,
  headers,
  date,
}: {
  fetcher: typeof fetch;
  baseUrl: string;
  publicBaseUrl?: string;
  headers?: Record<string, string>;
  date?: string;
}): Promise<MaintainerReportPointer | null> {
  const index = await fetchJson(fetcher, new URL("index.json", baseUrl).toString(), headers);
  return resolveDailyReportPointer({
    index,
    baseUrl,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(date ? { date } : {}),
  });
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  headers?: Record<string, string>,
): Promise<JsonObject> {
  if (url.startsWith("file:")) {
    return asJsonObject(JSON.parse(fs.readFileSync(fileURLToPath(url), "utf8")));
  }
  const response = await fetcher(url, {
    headers: {
      ...headers,
      accept: "application/json",
      "user-agent": "openclaw-clawsweeper-maintainer-report",
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status} ${body.slice(0, 300)}`);
  }
  try {
    return asJsonObject(JSON.parse(body));
  } catch (error) {
    const contentType = response.headers.get("content-type") ?? "";
    throw new Error(
      `failed to parse JSON from ${url}; content-type=${contentType}; body=${body.slice(0, 120)}`,
      { cause: error },
    );
  }
}

function resolveReportsAccessHeaders(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const clientId =
    stringOrNull(env.REPORTS_ACCESS_CLIENT_ID) ??
    stringOrNull(env.OPENCLAW_REPORTS_ACCESS_CLIENT_ID) ??
    stringOrNull(env.CF_ACCESS_CLIENT_ID) ??
    stringOrNull(env.CLOUDFLARE_ACCESS_CLIENT_ID);
  const clientSecret =
    stringOrNull(env.REPORTS_ACCESS_CLIENT_SECRET) ??
    stringOrNull(env.OPENCLAW_REPORTS_ACCESS_CLIENT_SECRET) ??
    stringOrNull(env.CF_ACCESS_CLIENT_SECRET) ??
    stringOrNull(env.CLOUDFLARE_ACCESS_CLIENT_SECRET);
  if (!clientId || !clientSecret) return undefined;
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

function readHighlights(report: JsonObject): string[] {
  const highlights = asJsonObject(report.summary).highlights;
  if (!Array.isArray(highlights)) return [];
  return highlights
    .map((value) => clipText(stringOrNull(value) ?? ""))
    .filter(Boolean)
    .slice(0, MAX_HIGHLIGHTS);
}

function topMaintainerRows(report: JsonObject): string[] {
  const rows = Array.isArray(report.maintainers) ? report.maintainers.map(asJsonObject) : [];
  return rows
    .filter((row) => {
      const github = asJsonObject(row.github);
      const discord = asJsonObject(row.discord);
      return numberValue(github.total) > 0 || numberValue(discord.total) > 0;
    })
    .slice(0, MAX_HIGHLIGHTS)
    .map((row) => {
      const github = asJsonObject(row.github);
      const discord = asJsonObject(row.discord);
      const bits = [
        metric(github.commits, "commits"),
        metric(github.prsMerged, "merged PRs"),
        metric(github.issueComments, "comments"),
        metric(discord.total, "Discord messages"),
      ].filter(Boolean);
      const name = stringOrNull(row.name) ?? `@${stringOrNull(row.login) ?? "unknown"}`;
      return `${name}: ${bits.slice(0, 3).join(", ") || "activity"}`;
    });
}

function metric(value: unknown, label: string): string {
  const number = numberValue(value);
  return number > 0 ? `${numberText(number)} ${label}` : "";
}

function reportPayload({
  now,
  dryRun,
  deliver,
  pointer,
  message,
}: {
  now: () => Date;
  dryRun: boolean;
  deliver: boolean;
  pointer: MaintainerReportPointer;
  message: string;
}): JsonObject {
  return {
    version: 1,
    generated_at: now().toISOString(),
    dry_run: dryRun,
    deliver,
    date: pointer.date,
    report_url: pointer.reportUrl,
    data_url: pointer.dataUrl,
    message,
  };
}

function summaryRow(
  status: "ok" | "skipped",
  sent: number,
  failed: number,
  reason: string | null,
  reportUrl: string | null,
  date: string | null,
  strict: boolean,
): MaintainerReportNotifierSummary {
  return {
    status,
    sent,
    failed,
    exitCode: strict && (failed > 0 || status === "skipped") ? 1 : 0,
    reason,
    reportUrl,
    date,
  };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function numberText(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(numberValue(value));
}

function clipText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_HIGHLIGHT_CHARS) return normalized;
  const clipped = normalized.slice(0, MAX_HIGHLIGHT_CHARS - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 80 ? lastSpace : clipped.length).trimEnd()}...`;
}

function dateFromIso(value: string | null): string | null {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function formatDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

async function main() {
  const summary = await runMaintainerReportNotifier(process.argv.slice(2));
  if (summary.exitCode) process.exitCode = summary.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
