export interface ReviewHistoryCycle {
  reviewedAt: string;
  sha: string;
  verdict: string;
  findings: string[];
}

export const MAX_REVIEW_HISTORY_CYCLES = 8;
const MAX_CYCLE_FINDINGS = 6;
const MAX_HISTORY_FIELD_CHARS = 160;
const REVIEW_HISTORY_MARKER = "<!-- clawsweeper-review-history v=1 -->";
const HISTORY_LINE_PREFIX = "- reviewed ";
const HISTORY_FIELD_SEPARATOR = " :: ";
const HISTORY_FINDING_SEPARATOR = " | ";
const REVIEW_START_PLACEHOLDER = "ClawSweeper status: review started.";
const VERDICT_LINE_PATTERN = /^(?:Codex|ClawSweeper) review: (.+)$/;
const DETAILED_FINDING_PATTERN = /^- \*\*\[(P[0-3])\] (.+?):\*\*/;
const SUMMARY_FINDING_PATTERN = /^- \[(P[0-3])\] (.+)$/;
const HISTORY_HEAD_PATTERN = /^(.+) sha (\S+)$/;

function sanitizeHistoryField(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").replaceAll("::", ":").replaceAll("|", "/").trim();
  return collapsed.length > MAX_HISTORY_FIELD_CHARS
    ? `${collapsed.slice(0, MAX_HISTORY_FIELD_CHARS - 3)}...`
    : collapsed;
}

function reviewHistoryLine(cycle: ReviewHistoryCycle): string {
  const findings = cycle.findings.length
    ? cycle.findings
        .slice(0, MAX_CYCLE_FINDINGS)
        .map(sanitizeHistoryField)
        .filter(Boolean)
        .join(HISTORY_FINDING_SEPARATOR)
    : "none";
  const reviewedAt = sanitizeHistoryField(cycle.reviewedAt) || "unknown";
  const sha = sanitizeHistoryField(cycle.sha).split(" ", 1)[0] || "unknown";
  const verdict = sanitizeHistoryField(cycle.verdict) || "unknown";
  return [`${HISTORY_LINE_PREFIX}${reviewedAt} sha ${sha}`, verdict, findings || "none"].join(
    HISTORY_FIELD_SEPARATOR,
  );
}

export function renderReviewHistorySection(cycles: readonly ReviewHistoryCycle[]): string {
  if (!cycles.length) return "";
  const noun = cycles.length === 1 ? "cycle" : "cycles";
  return [
    "<details>",
    `<summary>Review history (${cycles.length} earlier review ${noun})</summary>`,
    "",
    REVIEW_HISTORY_MARKER,
    ...cycles.map(reviewHistoryLine),
    "",
    "</details>",
  ].join("\n");
}

function parseReviewHistoryLine(line: string): ReviewHistoryCycle | null {
  const fields = line.slice(HISTORY_LINE_PREFIX.length).split(HISTORY_FIELD_SEPARATOR);
  if (fields.length !== 3) return null;
  const head = fields[0]?.match(HISTORY_HEAD_PATTERN);
  if (!head?.[1] || !head[2]) return null;
  const verdict = fields[1]?.trim();
  if (!verdict) return null;
  const findingsField = fields[2]?.trim() ?? "";
  const findings =
    !findingsField || findingsField === "none"
      ? []
      : findingsField
          .split(HISTORY_FINDING_SEPARATOR)
          .map((finding) => finding.trim())
          .filter(Boolean);
  return { reviewedAt: head[1].trim(), sha: head[2], verdict, findings };
}

export function parseReviewHistory(body: string): ReviewHistoryCycle[] {
  const markerIndex = body.indexOf(REVIEW_HISTORY_MARKER);
  if (markerIndex < 0) return [];
  const lines = body.slice(markerIndex).split(/\r?\n/).slice(1);
  const cycles: ReviewHistoryCycle[] = [];
  for (const line of lines) {
    if (!line.startsWith(HISTORY_LINE_PREFIX)) break;
    const cycle = parseReviewHistoryLine(line);
    if (cycle) cycles.push(cycle);
  }
  return cycles.slice(-MAX_REVIEW_HISTORY_CYCLES);
}

function reviewHistoryCycleKey(cycle: ReviewHistoryCycle): string {
  return `${cycle.reviewedAt}\u0000${cycle.sha}`;
}

export function appendReviewHistoryCycle(
  cycles: readonly ReviewHistoryCycle[],
  cycle: ReviewHistoryCycle | null,
): ReviewHistoryCycle[] {
  if (!cycle) return [...cycles];
  const key = reviewHistoryCycleKey(cycle);
  const kept = cycles.filter((entry) => reviewHistoryCycleKey(entry) !== key);
  return [...kept, cycle].slice(-MAX_REVIEW_HISTORY_CYCLES);
}

function reviewMarkerAttribute(body: string, name: string): string | null {
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const start = body.indexOf("<!--", searchFrom);
    if (start < 0) return null;
    const end = body.indexOf("-->", start + 4);
    if (end < 0) return null;
    searchFrom = end + 3;
    const inner = body.slice(start + 4, end).trim();
    const lower = inner.toLowerCase();
    if (!lower.startsWith("clawsweeper-verdict:") && !lower.startsWith("clawsweeper-action:")) {
      continue;
    }
    for (const token of inner.split(/\s+/)) {
      const separator = token.indexOf("=");
      if (separator <= 0) continue;
      if (token.slice(0, separator).toLowerCase() === name) {
        return token.slice(separator + 1) || null;
      }
    }
    return null;
  }
  return null;
}

function commentBodyFindings(lines: readonly string[]): string[] {
  const detailed: string[] = [];
  const summary: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(HISTORY_LINE_PREFIX)) continue;
    const detailedMatch = line.match(DETAILED_FINDING_PATTERN);
    if (detailedMatch?.[1] && detailedMatch[2]) {
      detailed.push(`[${detailedMatch[1]}] ${detailedMatch[2].trim()}`);
      continue;
    }
    const summaryMatch = line.match(SUMMARY_FINDING_PATTERN);
    if (summaryMatch?.[1] && summaryMatch[2]) {
      const rest = summaryMatch[2];
      const cut = [rest.indexOf(" - "), rest.indexOf(" — ")]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      const title = (cut === undefined ? rest : rest.slice(0, cut)).trim();
      if (title) summary.push(`[${summaryMatch[1]}] ${title}`);
    }
  }
  const findings = detailed.length ? detailed : summary;
  return [...new Set(findings)].slice(0, MAX_CYCLE_FINDINGS);
}

export function reviewHistoryCycleFromCommentBody(body: string): ReviewHistoryCycle | null {
  if (!body.trim() || body.includes(REVIEW_START_PLACEHOLDER)) return null;
  const lines = body.split(/\r?\n/);
  let verdict = "";
  for (const line of lines) {
    const match = line.trim().match(VERDICT_LINE_PATTERN);
    if (match?.[1]) {
      verdict = match[1].trim();
      break;
    }
  }
  if (!verdict) return null;
  const freshnessIndex = verdict.toLowerCase().indexOf("_reviewed ");
  if (freshnessIndex >= 0) verdict = verdict.slice(0, freshnessIndex).trim();
  if (!verdict) return null;
  const inlineReviewedAt = body.match(/_reviewed ([^_]+?)\.?_/i)?.[1]?.trim();
  const reviewedAt = reviewMarkerAttribute(body, "reviewed_at") ?? inlineReviewedAt ?? "unknown";
  const sha = reviewMarkerAttribute(body, "sha") ?? "unknown";
  return { reviewedAt, sha, verdict, findings: commentBodyFindings(lines) };
}
