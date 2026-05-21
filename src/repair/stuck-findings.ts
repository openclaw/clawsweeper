// Wrong-diff replay: when ClawSweeper's review comments keep flagging the
// same `[Px] description — file:line` finding across repair attempts, the
// fix worker is shipping diffs that don't touch the named location. This
// module detects that pattern by intersecting the latest two ClawSweeper
// review comments on a PR, and surfaces the stuck findings so the next
// fix prompt can pin Codex to the exact unchanged file:line.
//
// Triggered from `editValidatePrepareMerge` (contributor branch path);
// rendered by `buildFixPrompt` as a hard constraint addendum, parallel to
// the existing `previousNoDiff` recovery message.

import type { JsonValue, LooseRecord } from "./json-types.js";

const REVIEW_FINDING_LINE = /^\s*[-*]\s*\[P(\d+)\]\s+(.+?)\s+(?:—|--)\s+`([^:`]+):(\d+)`/gm;
const CLAWSWEEPER_VERDICT_MARKER = "<!-- clawsweeper-verdict:";
const COMMENT_FETCH_LIMIT = 60;

export interface ReviewFinding {
  priority: number;
  summary: string;
  filePath: string;
  line: number;
}

export interface StuckFinding extends ReviewFinding {
  // How many prior reviews (out of the inspected window) already flagged
  // the same file:line at this priority. >= 1 means at least one prior
  // repair attempt left it untouched.
  priorOccurrences: number;
}

/**
 * Parse ClawSweeper review finding lines from a comment body. Matches the
 * canonical render `- [P2] Tighten the classifier — \`src/foo.ts:42\``,
 * accepting either em dash or `--` as the separator.
 */
export function parseReviewFindings(body: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (!body) return findings;
  REVIEW_FINDING_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REVIEW_FINDING_LINE.exec(body)) !== null) {
    const priority = Number(match[1]);
    const line = Number(match[4]);
    if (!Number.isFinite(priority) || !Number.isFinite(line)) continue;
    findings.push({
      priority,
      summary: match[2]?.trim() ?? "",
      filePath: match[3]?.trim() ?? "",
      line,
    });
  }
  return findings;
}

interface CommentLike {
  body?: string;
  created_at?: string;
}

/**
 * From a list of issue comments, return the most recent ClawSweeper review
 * comments (those carrying a `clawsweeper-verdict` marker), newest first.
 * Bounded for predictable cost — callers should not need more than a small
 * window of recent reviews to detect repeat findings.
 */
export function selectRecentClawsweeperReviews(
  comments: readonly CommentLike[],
  limit = 4,
): CommentLike[] {
  const reviews = comments.filter(
    (entry) => typeof entry?.body === "string" && entry.body.includes(CLAWSWEEPER_VERDICT_MARKER),
  );
  reviews.sort((a, b) => {
    const at = Date.parse(String(a.created_at ?? "")) || 0;
    const bt = Date.parse(String(b.created_at ?? "")) || 0;
    return bt - at;
  });
  return reviews.slice(0, Math.max(1, limit));
}

/**
 * Compute the set of findings that appear in the *current* review and in
 * at least one *prior* ClawSweeper review on the same PR. The intersection
 * key is `(filePath, line, priority)` — same description text is not
 * required, so a re-worded summary still counts as a repeat.
 */
export function computeStuckFindings(comments: readonly CommentLike[]): StuckFinding[] {
  const reviews = selectRecentClawsweeperReviews(comments);
  if (reviews.length < 2) return [];
  const current = reviews[0];
  const prior = reviews.slice(1);
  if (!current) return [];
  const currentFindings = parseReviewFindings(current.body ?? "");
  if (currentFindings.length === 0) return [];
  const priorFindings = prior.map((entry) => parseReviewFindings(entry.body ?? ""));
  const stuck: StuckFinding[] = [];
  for (const finding of currentFindings) {
    let priorOccurrences = 0;
    for (const priorSet of priorFindings) {
      const hit = priorSet.some(
        (other) =>
          other.filePath === finding.filePath &&
          other.line === finding.line &&
          other.priority === finding.priority,
      );
      if (hit) priorOccurrences += 1;
    }
    if (priorOccurrences > 0) stuck.push({ ...finding, priorOccurrences });
  }
  return stuck;
}

export interface DetectStuckFindingsOptions {
  repo: string;
  prNumber: number;
  fetcher?: (apiPath: string, limit: number) => CommentLike[];
}

/**
 * Production entry point used by the repair worker. Fetches the latest PR
 * issue comments via gh and returns the stuck-finding intersection. Errors
 * are swallowed — a failure to detect must never block repair.
 */
export function detectStuckFindings(options: DetectStuckFindingsOptions): StuckFinding[] {
  const { repo, prNumber, fetcher } = options;
  if (!repo || !Number.isFinite(prNumber) || prNumber <= 0) return [];
  if (!fetcher) return [];
  try {
    const comments = fetcher(`/repos/${repo}/issues/${prNumber}/comments`, COMMENT_FETCH_LIMIT);
    return computeStuckFindings(comments);
  } catch {
    return [];
  }
}

/**
 * Render a stuck-findings constraint block for the fix prompt. Empty input
 * returns an empty string so callers can drop it through a `.filter(Boolean)`
 * join without conditionals.
 */
export function renderStuckFindingsConstraint(stuck: readonly StuckFinding[]): string {
  if (!stuck || stuck.length === 0) return "";
  const lines = stuck.map((finding) => {
    const repeat =
      finding.priorOccurrences > 1 ? ` (flagged ${finding.priorOccurrences}× before)` : "";
    return `- [P${finding.priority}] ${finding.summary} — \`${finding.filePath}:${finding.line}\`${repeat}`;
  });
  return [
    "Previous repair attempt(s) on this PR did not modify the following finding(s) — the ClawSweeper review is flagging them again at the same file:line:",
    "",
    ...lines,
    "",
    "This iteration, make ONLY the targeted change(s) at the cited file:line. Do not widen scope to retry/logging/telemetry refactors elsewhere; do not add adjacent improvements. Before returning, verify your diff modifies code AT each cited location.",
  ].join("\n");
}

// Pass-through helper for callers that want to log structured stuck-finding
// state. Kept stable so the schema can be promoted to a fix-artifact field
// later without rewriting the consumer.
export function stuckFindingsToTelemetry(stuck: readonly StuckFinding[]): JsonValue {
  return stuck.map((finding) => ({
    priority: finding.priority,
    file_path: finding.filePath,
    line: finding.line,
    prior_occurrences: finding.priorOccurrences,
    summary: finding.summary,
  })) as unknown as JsonValue;
}

// Used by tests that need to invoke the parser with a synthetic body.
export function parseReviewFindingsForTest(body: string): ReviewFinding[] {
  return parseReviewFindings(body);
}

// Internal type re-export so the worker can pass strongly typed values to
// buildFixPrompt without importing from this file's implementation.
export type StuckFindingRecord = StuckFinding;

// Silence unused-import lint when consumers only need types.
export type _Loose = LooseRecord;
