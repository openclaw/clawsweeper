export interface ReviewHistoryCycle {
  reviewedAt: string;
  sha: string;
  verdict: string;
  findings: string[];
}

export interface ReviewHistoryLedger {
  cycles: ReviewHistoryCycle[];
  totalCompletedCycles: number;
}

export const MAX_REVIEW_HISTORY_CYCLES = 8;
const MAX_CYCLE_FINDINGS = 6;
const MAX_HISTORY_FIELD_CHARS = 160;
const REVIEW_CONTROL_MARKER_PREFIX = "<!-- clawsweeper-";
const REVIEW_CONTROL_MARKER_PATTERN = /<!--(?=\s*clawsweeper-)/gi;
const REVIEW_HISTORY_MARKER_PREFIX = `${REVIEW_CONTROL_MARKER_PREFIX}review-history `;
const HISTORY_LINE_PREFIX = "- reviewed ";
const HISTORY_FIELD_SEPARATOR = " :: ";
const HISTORY_FINDING_SEPARATOR = " | ";
const REVIEW_START_PLACEHOLDER = "ClawSweeper status: review started.";
const FAILED_REVIEW_VERDICT = "did not complete due to Codex infrastructure failure.";
const VERDICT_LINE_PATTERN = /^(?:Codex|ClawSweeper) review: (.+)$/;
const DETAILED_FINDING_PATTERN = /^- \*\*\[(P[0-3])\] (.+?):\*\*/;
const SUMMARY_FINDING_PATTERN = /^- \[(P[0-3])\] (.+)$/;
const HISTORY_HEAD_PATTERN = /^(.+) sha (\S+)$/;

function sanitizeHistoryField(value: string): string {
  const collapsed = value
    .replace(/\s+/g, " ")
    .replaceAll("::", ":")
    .replaceAll("|", "/")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .trim();
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

export function renderReviewHistorySection(ledger: ReviewHistoryLedger): string {
  if (!ledger.cycles.length) return "";
  const cycles = ledger.cycles.slice(-MAX_REVIEW_HISTORY_CYCLES);
  const totalCompletedCycles = Math.max(ledger.totalCompletedCycles, cycles.length);
  const noun = totalCompletedCycles === 1 ? "cycle" : "cycles";
  const retainedSuffix =
    totalCompletedCycles > cycles.length ? `; latest ${cycles.length} shown` : "";
  return [
    "<details>",
    `<summary>Review history (${totalCompletedCycles} earlier review ${noun}${retainedSuffix})</summary>`,
    "",
    `${REVIEW_HISTORY_MARKER_PREFIX}v=1 total=${totalCompletedCycles} -->`,
    ...cycles.map(reviewHistoryLine),
    "",
    "</details>",
  ].join("\n");
}

export function neutralizeReviewControlMarkers(value: string): string {
  // Model-authored review text shares the durable comment with this ledger.
  // Keep lookalike markers inert so only locally rendered controls become state.
  return value.replace(REVIEW_CONTROL_MARKER_PATTERN, "‹!--");
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

function parseReviewHistoryAt(body: string, markerIndex: number): ReviewHistoryLedger | null {
  const markerEnd = body.indexOf("-->", markerIndex + REVIEW_HISTORY_MARKER_PREFIX.length);
  if (markerEnd < 0) return null;
  const marker = body.slice(markerIndex + 4, markerEnd).trim();
  const attributes = new Map<string, string>();
  for (const token of marker.split(/\s+/).slice(1)) {
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    attributes.set(token.slice(0, separator), token.slice(separator + 1));
  }
  const totalValue = attributes.get("total") ?? "";
  if (attributes.get("v") !== "1" || !/^\d+$/.test(totalValue)) {
    return null;
  }
  const parsedTotal = Number(totalValue);
  if (!Number.isSafeInteger(parsedTotal)) {
    return null;
  }

  const detailsStart = body.lastIndexOf("<details>", markerIndex);
  if (detailsStart < 0) return null;
  const summary = body.slice(detailsStart, markerIndex);
  const detailsEnd = body.indexOf("</details>", markerEnd + 3);
  if (detailsEnd < 0) return null;
  const historyBody = body.slice(markerEnd + 3, detailsEnd);
  if (!/^\r?\n[\s\S]*\r?\n\r?\n$/.test(historyBody)) return null;
  const lines = historyBody.split(/\r?\n/).slice(1, -2);
  if (!lines.length || lines.length > MAX_REVIEW_HISTORY_CYCLES) return null;
  const cycles: ReviewHistoryCycle[] = [];
  for (const line of lines) {
    if (!line.startsWith(HISTORY_LINE_PREFIX)) return null;
    const cycle = parseReviewHistoryLine(line);
    if (!cycle) return null;
    cycles.push(cycle);
  }
  if (parsedTotal < cycles.length) return null;
  const noun = parsedTotal === 1 ? "cycle" : "cycles";
  const retainedSuffix = parsedTotal > cycles.length ? `; latest ${cycles.length} shown` : "";
  const expectedSummary = [
    "<details>",
    `<summary>Review history (${parsedTotal} earlier review ${noun}${retainedSuffix})</summary>`,
    "",
    "",
  ].join("\n");
  if (summary.replaceAll("\r\n", "\n") !== expectedSummary) return null;
  return {
    cycles,
    totalCompletedCycles: parsedTotal,
  };
}

export function parseReviewHistory(body: string): ReviewHistoryLedger {
  let searchFrom = body.length;
  while (searchFrom > 0) {
    const markerIndex = body.lastIndexOf(REVIEW_HISTORY_MARKER_PREFIX, searchFrom - 1);
    if (markerIndex < 0) break;
    const ledger = parseReviewHistoryAt(body, markerIndex);
    if (ledger) return ledger;
    searchFrom = markerIndex;
  }
  return { cycles: [], totalCompletedCycles: 0 };
}

function reviewHistoryCycleKey(cycle: ReviewHistoryCycle): string {
  return `${cycle.reviewedAt}\u0000${cycle.sha}`;
}

export function appendReviewHistoryCycle(
  ledger: ReviewHistoryLedger,
  cycle: ReviewHistoryCycle | null,
): ReviewHistoryLedger {
  if (!cycle) {
    return { cycles: [...ledger.cycles], totalCompletedCycles: ledger.totalCompletedCycles };
  }
  const key = reviewHistoryCycleKey(cycle);
  if (ledger.cycles.some((entry) => reviewHistoryCycleKey(entry) === key)) {
    return { cycles: [...ledger.cycles], totalCompletedCycles: ledger.totalCompletedCycles };
  }
  return {
    cycles: [...ledger.cycles, cycle].slice(-MAX_REVIEW_HISTORY_CYCLES),
    totalCompletedCycles: ledger.totalCompletedCycles + 1,
  };
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

function hasReviewStatusMarker(body: string): boolean {
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const start = body.indexOf("<!--", searchFrom);
    if (start < 0) return false;
    const end = body.indexOf("-->", start + 4);
    if (end < 0) return false;
    searchFrom = end + 3;
    if (
      body
        .slice(start + 4, end)
        .trim()
        .toLowerCase()
        .startsWith("clawsweeper-review-status:")
    ) {
      return true;
    }
  }
  return false;
}

function reviewFindingLines(lines: readonly string[]): readonly string[] {
  const detailsStart = lines.findLastIndex((line) => line.trim() === "Full review comments:");
  if (detailsStart >= 0) {
    const detailsLines = lines.slice(detailsStart + 1);
    const end = detailsLines.findIndex((line) =>
      /^(?:Overall correctness:|<\/details>|<!--)/.test(line.trim()),
    );
    return end < 0 ? detailsLines : detailsLines.slice(0, end);
  }
  const summaryStart = lines.findIndex((line) => line.trim() === "**Review findings**");
  if (summaryStart < 0) return [];
  const summaryLines = lines.slice(summaryStart + 1);
  const end = summaryLines.findIndex((line) => /^(?:\*\*|<details>|<!--)/.test(line.trim()));
  return end < 0 ? summaryLines : summaryLines.slice(0, end);
}

function commentBodyFindings(body: string): string[] {
  const detailed: string[] = [];
  const summary: string[] = [];
  for (const raw of reviewFindingLines(body.split(/\r?\n/))) {
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
  if (!body.trim() || body.includes(REVIEW_START_PLACEHOLDER) || hasReviewStatusMarker(body)) {
    return null;
  }
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
  if (!verdict || verdict === FAILED_REVIEW_VERDICT) return null;
  const inlineReviewedAt = body.match(/_reviewed ([^_]+?)\.?_/i)?.[1]?.trim();
  const reviewedAt = reviewMarkerAttribute(body, "reviewed_at") ?? inlineReviewedAt ?? "unknown";
  const sha = reviewMarkerAttribute(body, "sha") ?? "unknown";
  return { reviewedAt, sha, verdict, findings: commentBodyFindings(body) };
}
