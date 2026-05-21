#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { UsageTelemetryEvent, UsageTokens } from "../src/usage-telemetry.ts";

type CliOptions = {
  sinceHours: number;
  limit: number;
  now: Date;
  sessionId?: string;
  paths: string[];
};

type UsageRow = {
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  reasoning_output: number;
  total: number;
  cache_input: number;
  cache_read_ratio: number;
};

type InvocationRow = UsageRow & {
  emitted_at: string;
  workflow: string;
  mode: string;
  phase: string;
  target_repo: string;
  item: string;
  provider: string;
  model: string;
  session_id: string;
  turn_id: string;
  github_run_id: string;
  status: string;
};

export type UsageSnapshot = {
  generated_at: string;
  window_hours: number;
  cutoff: string;
  files_read: number;
  events_read: number;
  events_in_window: number;
  totals: UsageRow;
  largest_invocations: InvocationRow[];
  by_workflow: Record<string, UsageRow>;
  by_target_repo: Record<string, UsageRow>;
  by_model: Record<string, UsageRow>;
  by_session: Record<string, UsageRow>;
  failed_or_timeout: Record<string, UsageRow>;
  session_timeline_session_id: string | null;
  session_timeline: InvocationRow[];
};

function emptyRow(): UsageRow {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    reasoning_output: 0,
    total: 0,
    cache_input: 0,
    cache_read_ratio: 0,
  };
}

function tokenValue(tokens: UsageTokens | null | undefined, key: keyof UsageTokens): number {
  const value = tokens?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function refreshCacheHealth(row: UsageRow): void {
  row.cache_input = row.input + row.cache_read + row.cache_creation;
  row.cache_read_ratio = row.cache_input > 0 ? row.cache_read / row.cache_input : 0;
}

function addTokens(row: UsageRow, tokens: UsageTokens | null | undefined): void {
  row.calls += 1;
  row.input += tokenValue(tokens, "input");
  row.output += tokenValue(tokens, "output");
  row.cache_read += tokenValue(tokens, "cache_read");
  row.cache_creation += tokenValue(tokens, "cache_creation");
  row.reasoning_output += tokenValue(tokens, "reasoning_output");
  row.total += tokenValue(tokens, "total");
  refreshCacheHealth(row);
}

function bucketAdd(
  bucket: Record<string, UsageRow>,
  key: string,
  tokens: UsageTokens | null | undefined,
): void {
  const normalizedKey = key || "unknown";
  bucket[normalizedKey] ??= emptyRow();
  addTokens(bucket[normalizedKey], tokens);
}

function sortBucket(bucket: Record<string, UsageRow>): Record<string, UsageRow> {
  return Object.fromEntries(Object.entries(bucket).sort((a, b) => b[1].total - a[1].total));
}

function isUsageEvent(value: unknown): value is UsageTelemetryEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.surface === "clawsweeper" && typeof record.emitted_at === "string";
}

function itemKey(event: UsageTelemetryEvent): string {
  if (typeof event.item_number === "number") return `issue:${event.item_number}`;
  if (event.commit_sha) return `commit:${event.commit_sha.slice(0, 12)}`;
  if (event.job_path) return `job:${event.job_path}`;
  return "unknown";
}

function invocationRow(event: UsageTelemetryEvent): InvocationRow {
  const row = emptyRow();
  addTokens(row, event.tokens);
  return {
    ...row,
    emitted_at: event.emitted_at,
    workflow: event.workflow ?? "unknown",
    mode: event.mode ?? "unknown",
    phase: event.phase ?? "unknown",
    target_repo: event.target_repo ?? "unknown",
    item: itemKey(event),
    provider: event.provider ?? "unknown",
    model: event.model ?? "unknown",
    session_id: event.session_id ?? "unknown",
    turn_id: event.turn_id ?? "unknown",
    github_run_id: event.github_run_id ?? "unknown",
    status: event.status,
  };
}

function collectUsageFiles(paths: string[]): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    const stats = statSync(path);
    if (stats.isFile()) {
      files.push(path);
      return;
    }
    if (!stats.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile() && entry.name === "usage-events.jsonl") files.push(child);
    }
  };

  for (const path of paths) visit(resolve(path));
  return [...new Set(files)].sort();
}

export function buildUsageSnapshotFromJsonl(
  contentsByFile: readonly { path: string; contents: string }[],
  options: { sinceHours?: number; now?: Date; limit?: number; sessionId?: string } = {},
): UsageSnapshot {
  const now = options.now ?? new Date();
  const sinceHours = options.sinceHours ?? 48;
  const limit = options.limit ?? 10;
  const sessionId = options.sessionId;
  const cutoff = new Date(now.getTime() - sinceHours * 60 * 60 * 1000);
  const totals = emptyRow();
  const byWorkflow: Record<string, UsageRow> = {};
  const byTargetRepo: Record<string, UsageRow> = {};
  const byModel: Record<string, UsageRow> = {};
  const bySession: Record<string, UsageRow> = {};
  const failedOrTimeout: Record<string, UsageRow> = {};
  const invocations: InvocationRow[] = [];
  let eventsRead = 0;
  let eventsInWindow = 0;

  for (const file of contentsByFile) {
    for (const line of file.contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isUsageEvent(parsed)) continue;
      eventsRead += 1;
      const emittedAt = new Date(parsed.emitted_at);
      if (!Number.isFinite(emittedAt.getTime()) || emittedAt < cutoff || emittedAt > now) continue;
      eventsInWindow += 1;
      addTokens(totals, parsed.tokens);
      bucketAdd(byWorkflow, parsed.workflow ?? "unknown", parsed.tokens);
      bucketAdd(byTargetRepo, parsed.target_repo ?? "unknown", parsed.tokens);
      bucketAdd(byModel, parsed.model ?? "unknown", parsed.tokens);
      bucketAdd(bySession, parsed.session_id ?? parsed.github_run_id ?? "unknown", parsed.tokens);
      if (
        ["failed", "timeout", "buffer_exceeded", "missing_result", "schema_invalid"].includes(
          parsed.status,
        )
      ) {
        bucketAdd(
          failedOrTimeout,
          `${parsed.status}|${parsed.workflow ?? "unknown"}`,
          parsed.tokens,
        );
      }
      invocations.push(invocationRow(parsed));
    }
  }

  return {
    generated_at: now.toISOString(),
    window_hours: sinceHours,
    cutoff: cutoff.toISOString(),
    files_read: contentsByFile.length,
    events_read: eventsRead,
    events_in_window: eventsInWindow,
    totals,
    largest_invocations: invocations.sort((a, b) => b.total - a.total).slice(0, limit),
    by_workflow: sortBucket(byWorkflow),
    by_target_repo: sortBucket(byTargetRepo),
    by_model: sortBucket(byModel),
    by_session: sortBucket(bySession),
    failed_or_timeout: sortBucket(failedOrTimeout),
    session_timeline_session_id: sessionId ?? null,
    session_timeline: sessionId
      ? invocations
          .filter((event) => event.session_id === sessionId)
          .sort((a, b) => a.emitted_at.localeCompare(b.emitted_at))
          .slice(0, limit)
      : [],
  };
}

export function parseCliArgs(argv: readonly string[], now = new Date()): CliOptions {
  const options: CliOptions = { sinceHours: 48, limit: 10, now, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--since-hours") {
      const value = argv[index + 1];
      if (!value) throw new Error("--since-hours requires a value");
      options.sinceHours = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) throw new Error("--limit requires a value");
      options.limit = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--now") {
      const value = argv[index + 1];
      if (!value) throw new Error("--now requires an ISO timestamp");
      options.now = new Date(value);
      index += 1;
      continue;
    }
    if (arg === "--session-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--session-id requires a value");
      options.sessionId = value;
      index += 1;
      continue;
    }
    options.paths.push(arg);
  }
  if (!Number.isFinite(options.sinceHours) || options.sinceHours <= 0) {
    throw new Error("--since-hours must be a positive number");
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isFinite(options.now.getTime()))
    throw new Error("--now must be a valid ISO timestamp");
  if (options.paths.length === 0) options.paths.push(".");
  return options;
}

function main(): void {
  const options = parseCliArgs(process.argv.slice(2));
  const files = collectUsageFiles(options.paths);
  const contentsByFile = files.map((path) => ({ path, contents: readFileSync(path, "utf8") }));
  const snapshot = buildUsageSnapshotFromJsonl(contentsByFile, options);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) main();
