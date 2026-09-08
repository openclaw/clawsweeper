import { escapeRegExp } from "../clawsweeper-text.js";
import type { JsonValue, LooseRecord } from "./json-types.js";

const TIMELINE_START = "<!-- clawsweeper-automerge-timeline:start -->";
const TIMELINE_END = "<!-- clawsweeper-automerge-timeline:end -->";
const EVENT_PREFIX = "<!-- clawsweeper-automerge-timeline-event:";

export function mergeAutomergeTimelineSection({ body, existingBody, events }: LooseRecord): string {
  const base = stripAutomergeTimeline(body).trimEnd();
  const rows = existingTimelineRows(existingBody);
  for (const event of Array.isArray(events) ? events : []) {
    const row = renderTimelineEvent(event);
    if (!row) continue;
    const id = timelineEventId(row);
    const index = rows.findIndex((existing) => timelineEventId(existing) === id);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }
  if (rows.length === 0) return base;
  return `${base}\n\n${TIMELINE_START}\nAutomerge progress:\n${rows.slice(-16).join("\n")}\n${TIMELINE_END}`;
}

export function stripAutomergeTimeline(value: JsonValue): string {
  return String(value ?? "")
    .replace(
      new RegExp(`${escapeRegExp(TIMELINE_START)}[\\s\\S]*?${escapeRegExp(TIMELINE_END)}\\n?`, "g"),
      "",
    )
    .trimEnd();
}

function existingTimelineRows(value: JsonValue): string[] {
  const match = String(value ?? "").match(
    new RegExp(`${escapeRegExp(TIMELINE_START)}([\\s\\S]*?)${escapeRegExp(TIMELINE_END)}`),
  );
  if (!match) return [];
  const lines = match[1]!
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && line.trim() !== "Automerge progress:");
  const rows: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.includes(EVENT_PREFIX)) continue;
    const parts = [line];
    while (index + 1 < lines.length && !lines[index + 1]!.includes(EVENT_PREFIX)) {
      parts.push(lines[++index]!);
    }
    const row = sanitizeTimelineRow(parts.join("\n"));
    if (row) rows.push(row);
  }
  return rows;
}

function renderTimelineEvent(event: LooseRecord): string {
  const id = safeTimelineId(event.id);
  if (!id) return "";
  const at = formatTimestamp(event.completedAt ?? event.completed_at ?? event.at);
  const label = compact(event.label ?? event.phase ?? "event", 90);
  const head = renderCommitSha(event.headSha ?? event.head_sha, event.repo ?? event.targetRepo);
  const status = compact(event.status, 80);
  const duration = formatDuration(event.durationMs ?? event.duration_ms);
  const runUrl = safeTimelineRunUrl(event.runUrl ?? event.run_url);
  const details = compact(event.details ?? event.detail ?? event.reason, 160);
  const eventMarker = `${EVENT_PREFIX}${id} -->`;
  const row = [
    "-",
    at,
    label,
    head,
    status ? `(${status})` : "",
    duration ? `in ${duration}` : "",
    runUrl ? `Run: ${runUrl}` : "",
    details,
  ]
    .filter(Boolean)
    .join(" ");
  return `${eventMarker}\n${row}`;
}

function sanitizeTimelineRow(row: string): string {
  const id = timelineEventId(row);
  if (!id) return "";
  const body = row
    .replace(/\r?\n/g, " ")
    .replace(/^\s*-\s*/, "")
    .replace(new RegExp(escapeRegExp(`${EVENT_PREFIX}${id} -->`), "g"), "")
    .replace(
      /\s+Run:\s+https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/\d+#issuecomment-\d+\b/gi,
      "",
    )
    .replace(/\]\s+\(/g, "](")
    .replace(/\s+/g, " ")
    .trim();
  return `${EVENT_PREFIX}${id} -->${body ? `\n${body.startsWith("- ") ? body : `- ${body}`}` : ""}`;
}

function safeTimelineRunUrl(value: JsonValue): string {
  const url = String(value ?? "").trim();
  if (!url) return "";
  if (
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/\d+#issuecomment-\d+\b/i.test(url)
  )
    return "";
  return url;
}

function timelineEventId(row: string): string {
  return row.match(/<!-- clawsweeper-automerge-timeline-event:([^ ]+) -->/)?.[1] ?? "";
}

function safeTimelineId(value: JsonValue): string {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function formatTimestamp(value: JsonValue): string {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "time unknown";
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function formatDuration(value: JsonValue): string {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function renderCommitSha(value: JsonValue, repoValue: JsonValue): string {
  const full = fullSha(value);
  if (!full) return "";
  const short = full.slice(0, 12);
  const repo = String(repoValue ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return `\`${short}\``;
  return `[\`${short}\`](https://github.com/${repo}/commit/${full})`;
}

function fullSha(value: JsonValue): string {
  const text = String(value ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(text) ? text : "";
}

function compact(value: JsonValue, max: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}
