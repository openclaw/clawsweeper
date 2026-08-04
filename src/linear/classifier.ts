/**
 * Linear review-only classifier (deterministic, offline, pure functions).
 *
 * Doctrine — proposal-only, never-close-without-evidence:
 *   This module classifies a LinearReviewRecord into a triage disposition for
 *   downstream human or LLM review. It is strictly review-only: the classifier
 *   never emits a "close" decision and never mutates any state. Closing a Linear
 *   issue requires concrete evidence (implemented on main, duplicate, cannot
 *   reproduce, incoherent) that a deterministic label-and-date layer cannot
 *   establish. Stale items are surfaced as "stale-candidate" — a signal for the
 *   downstream judgment step — not as close decisions. The invariant is enforced
 *   by `proposesClose`, which always returns false.
 *
 * Deterministic and clock-free:
 *   This module never reads the system clock. The caller supplies `nowIso`
 *   (required) so that results are reproducible, testable, and independent of
 *   wall time. No network calls are made.
 *
 * Disposition precedence (first match wins):
 *   1. record.state === "closed"           → "closed"
 *   2. any protectedLabel present          → "protected"
 *   3. any exclusionLabel present          → "excluded"
 *   4. requiredLabels non-empty, none hit  → "not-ready"
 *   5. updatedAt older than staleDays      → "stale-candidate"
 *   6. otherwise                           → "review"
 *
 * Stale candidates are eligible items that have exceeded the staleness threshold.
 * They are surfaced as candidates for `stale_insufficient_info` but remain
 * review-only — the downstream judgment step decides whether to act.
 */

import type { LinearReviewRecord } from "./record.js";
import { assertLinearReviewRecord } from "./record.js";

// Mirror record.ts constants — staleness semantics must be identical.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 60;

export type ReviewDisposition =
  | "review" // eligible; needs downstream human/LLM judgment
  | "stale-candidate" // eligible + stale; candidate for stale_insufficient_info (still review-only)
  | "protected" // protected/maintainer label present → never auto-close
  | "excluded" // an exclusion label is present → skip this run
  | "not-ready" // requiredLabels set and none present → skip this run
  | "closed"; // record.state === "closed" → skip this run

export type CloseCandidateReason = "stale_insufficient_info" | "none";

export interface ClassifierOptions {
  nowIso: string; // caller-supplied clock (REQUIRED; never read system clock)
  staleDays?: number; // default 60
  requiredLabels?: string[]; // case-insensitive; if non-empty, >=1 must be present, else "not-ready"
  exclusionLabels?: string[]; // case-insensitive; any present → "excluded"
  protectedLabels?: string[]; // case-insensitive; any present → "protected" (never auto-close)
}

export interface LinearClassification {
  key: string; // = record.key
  identifier: string; // = record.identifier
  disposition: ReviewDisposition;
  reviewOnly: true; // invariant marker — this layer proposes only, never mutates
  eligible: boolean; // true iff disposition is "review" or "stale-candidate"
  closeable: boolean; // NOT "safe to close": only false for "protected"/"closed", true even for "excluded"/"review". Whether a close is *authorized* is decided by authority.ts (the evidence gate), never by this flag.
  staleCandidate: boolean; // true iff disposition === "stale-candidate"
  closeCandidateReason: CloseCandidateReason; // "stale_insufficient_info" iff stale-candidate, else "none"
  reasons: string[]; // ordered, human-readable rationale (non-empty)
}

/**
 * Returns true if any candidate label name matches any record label, using
 * case-insensitive exact comparison. Returns the first matching record label
 * name when found, or undefined when no match.
 */
function firstMatchingLabel(recordLabels: string[], candidates: string[]): string | undefined {
  const lower = candidates.map((c) => c.toLowerCase());
  return recordLabels.find((l) => lower.includes(l.toLowerCase()));
}

/**
 * Returns true iff any candidate label matches any label on the record.
 * Case-insensitive exact-name comparison.
 */
function hasAnyLabel(recordLabels: string[], candidates: string[]): boolean {
  return firstMatchingLabel(recordLabels, candidates) !== undefined;
}

/**
 * Returns true if updatedAt is older than staleDays before nowIso.
 * Boundary semantics mirror record.ts `isStaleIssue`: strictly greater-than —
 * exactly staleDays old is NOT considered stale.
 */
function isStaleRecord(updatedAt: string, nowIso: string, staleDays: number): boolean {
  const now = new Date(nowIso).getTime();
  const updated = new Date(updatedAt).getTime();
  if (!Number.isFinite(now)) throw new Error(`invalid nowIso timestamp: ${nowIso}`);
  if (!Number.isFinite(updated)) throw new Error(`invalid updatedAt timestamp: ${updatedAt}`);
  return now - updated > staleDays * MS_PER_DAY;
}

/**
 * Classifies a single LinearReviewRecord into a review-only triage disposition.
 *
 * Calls `assertLinearReviewRecord` first; throws on malformed input.
 * All label matching is case-insensitive exact-name against `record.labels`.
 * Disposition is determined by first-match precedence (see module doc comment).
 */
export function classifyRecord(
  record: LinearReviewRecord,
  options: ClassifierOptions,
): LinearClassification {
  assertLinearReviewRecord(record);

  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const protectedLabels = options.protectedLabels ?? [];
  const exclusionLabels = options.exclusionLabels ?? [];
  const requiredLabels = options.requiredLabels ?? [];

  let disposition: ReviewDisposition;
  const reasons: string[] = [];

  if (record.state === "closed") {
    disposition = "closed";
    reasons.push("state is closed — skipped");
  } else if (protectedLabels.length > 0 && hasAnyLabel(record.labels, protectedLabels)) {
    disposition = "protected";
    const matched = firstMatchingLabel(record.labels, protectedLabels) ?? "";
    reasons.push(`protected label present: ${matched} — never auto-close`);
  } else if (exclusionLabels.length > 0 && hasAnyLabel(record.labels, exclusionLabels)) {
    disposition = "excluded";
    const matched = firstMatchingLabel(record.labels, exclusionLabels) ?? "";
    reasons.push(`exclusion label present: ${matched} — skipped`);
  } else if (requiredLabels.length > 0 && !hasAnyLabel(record.labels, requiredLabels)) {
    disposition = "not-ready";
    reasons.push(`no required label present (need one of: ${requiredLabels.join(", ")}) — skipped`);
  } else if (isStaleRecord(record.updatedAt, options.nowIso, staleDays)) {
    disposition = "stale-candidate";
    reasons.push(
      `stale: updatedAt ${record.updatedAt} is older than ${staleDays}d before ${options.nowIso}`,
    );
  } else {
    disposition = "review";
    reasons.push("eligible for review");
  }

  const eligible = disposition === "review" || disposition === "stale-candidate";
  const closeable = disposition !== "protected" && disposition !== "closed";
  const staleCandidate = disposition === "stale-candidate";
  const closeCandidateReason: CloseCandidateReason = staleCandidate
    ? "stale_insufficient_info"
    : "none";

  return {
    key: record.key,
    identifier: record.identifier,
    disposition,
    reviewOnly: true,
    eligible,
    closeable,
    staleCandidate,
    closeCandidateReason,
    reasons,
  };
}

/**
 * Classifies an array of LinearReviewRecords, returning one LinearClassification
 * per record. Equivalent to `records.map(r => classifyRecord(r, options))`.
 */
export function classifyRecords(
  records: LinearReviewRecord[],
  options: ClassifierOptions,
): LinearClassification[] {
  return records.map((r) => classifyRecord(r, options));
}

/**
 * Always returns false. Documents the review-only doctrine invariant: this
 * classifier layer never proposes a close decision. Closing a Linear issue
 * requires concrete evidence (implemented on main, duplicate, cannot reproduce,
 * incoherent) that only the downstream judgment step can establish from source
 * history and context — not from labels and dates alone.
 */
export function proposesClose(_classification: LinearClassification): false {
  return false;
}
