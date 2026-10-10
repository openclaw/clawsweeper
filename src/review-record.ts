import { isDeepStrictEqual } from "node:util";
import { createDecisionParser } from "./clawsweeper-decision-parser.js";
import { parseOversizedPrSourceSnapshot } from "./clawsweeper-oversized-pr-freshness.js";
import { parseOversizedPullRequestEvidence } from "./clawsweeper-oversized-pr-policy.js";
import {
  CONFIDENCES,
  isGitHubVerifiedFixedPullRequestSource,
  REGRESSION_PROVENANCE_SCHEMA_KEYS,
} from "./clawsweeper-policy.js";
import {
  isSuspectedRegressionProvenance,
  isVerifiedRegressionProvenance,
} from "./clawsweeper-regression-provenance.js";
import type { Decision, FixedPullRequest, Item } from "./clawsweeper-types.js";
import {
  frontMatterField,
  frontMatterValue,
  replaceFrontMatterValue,
  reportWithoutReviewRecord,
  REVIEW_RECORD_KEY,
} from "./report-front-matter.js";

// The typed review record is one front-matter line in the report:
//   review_record: {"version":1,"decision":{...}}
// A record that the backfill made from an older report also has "origin":"backfill".
const REVIEW_RECORD_VERSION = 1;

// Model text is made safe for the report when the review parses it. Stored text is
// record data: the failed-review decision keeps raw Codex output, for example.
const storedDecisionParser = createDecisionParser({
  neutralizeOwnedSectionSpoofing: (value) => value,
  sanitizeArchitectureDiagram: (value) => value,
});

type ReviewRecordSubject = Pick<Item, "repo" | "number" | "kind">;

export interface ReviewRecord {
  readonly decision: Decision;
  readonly origin?: "backfill";
}

export class ReviewRecordFormatError extends Error {
  constructor(message: string) {
    super(`review_record: ${message}`);
    this.name = "ReviewRecordFormatError";
  }
}

// JSON escapes line breaks. U+2028 and U+2029 are escaped too, because JavaScript
// regular expressions end a line there, and front-matter readers work line by line.
function reviewRecordValue(record: ReviewRecord): string {
  const stored = {
    version: REVIEW_RECORD_VERSION,
    ...(record.origin ? { origin: record.origin } : {}),
    decision: record.decision,
  };
  return JSON.stringify(stored).replace(
    /[\u2028\u2029]/g,
    (separator) => `\\u${separator.charCodeAt(0).toString(16)}`,
  );
}

/** Why a decision cannot be stored, or null. A stored record must read back unchanged. */
export function reviewRecordProblem(
  decision: Decision,
  subject: ReviewRecordSubject,
): string | null {
  try {
    parseStoredDecision(JSON.parse(JSON.stringify(decision)), subject);
    return null;
  } catch (error) {
    if (!(error instanceof ReviewRecordFormatError)) throw error;
    return error.message;
  }
}

// A decision that would not read back is not stored: the report then has no record,
// as before review_record existed, and the backfill makes one from the report.
function storableDecision(decision: Decision, subject: ReviewRecordSubject): boolean {
  const problem = reviewRecordProblem(decision, subject);
  if (problem) {
    console.error(
      `[review-record] ${subject.repo}#${subject.number}: record not stored: ${problem}`,
    );
  }
  return problem === null;
}

/** The front-matter line that stores the typed record of a report, or null. */
export function reviewRecordFrontMatterLine(
  record: ReviewRecord,
  subject: ReviewRecordSubject,
): string | null {
  return storableDecision(record.decision, subject)
    ? `${REVIEW_RECORD_KEY}: ${reviewRecordValue(record)}`
    : null;
}

/**
 * Reads the typed record of a report. Returns null for a report from before
 * review_record existed. Throws ReviewRecordFormatError for any other problem.
 */
export function readReviewRecord(markdown: string): ReviewRecord | null {
  const field = frontMatterField(markdown, REVIEW_RECORD_KEY);
  if (field.status === "absent") return null;
  if (field.status === "ambiguous") throw new ReviewRecordFormatError("the field is ambiguous");
  let stored: unknown;
  try {
    stored = JSON.parse(field.value);
  } catch {
    throw new ReviewRecordFormatError("the value is not JSON");
  }
  const record = storedObject(stored, "the record");
  const { version, origin, decision, ...unexpected } = record;
  if (Object.keys(unexpected).length > 0) {
    throw new ReviewRecordFormatError(`unexpected keys: ${Object.keys(unexpected).join(", ")}`);
  }
  if (version !== REVIEW_RECORD_VERSION) throw new ReviewRecordFormatError("unknown version");
  if (origin !== undefined && origin !== "backfill") {
    throw new ReviewRecordFormatError("unknown origin");
  }
  return {
    decision: parseStoredDecision(decision, reviewRecordSubject(markdown)),
    ...(origin ? { origin } : {}),
  };
}

/**
 * Reads the typed record of a report. A report from before review_record existed
 * gets its decision from `legacyDecision`, which reads the report text. Remove this
 * fallback when the backfill shows that no stored report is without a record.
 * A record that does not read throws ReviewRecordFormatError: it gets no fallback.
 */
export function readReviewRecordOrLegacy<T>(
  markdown: string,
  legacyDecision: (markdown: string) => T,
): ReviewRecord | { decision: T } {
  return readReviewRecord(markdown) ?? { decision: legacyDecision(markdown) };
}

/**
 * Changes decision fields in the typed record of a report. A report without a
 * record does not change: the backfill makes its record. A record that is not
 * valid before or after the change is removed, so a stored record always reads.
 */
export function updateReviewRecordDecision(
  markdown: string,
  update: (decision: Decision) => Partial<Decision>,
): string {
  let record: ReviewRecord | null;
  try {
    record = readReviewRecord(markdown);
  } catch (error) {
    if (!(error instanceof ReviewRecordFormatError)) throw error;
    console.error(`[review-record] record removed: ${error.message}`);
    return reportWithoutReviewRecord(markdown);
  }
  if (!record) return markdown;
  const decision = { ...record.decision, ...update(record.decision) };
  if (!storableDecision(decision, reviewRecordSubject(markdown))) {
    return reportWithoutReviewRecord(markdown);
  }
  return replaceFrontMatterValue(
    markdown,
    REVIEW_RECORD_KEY,
    reviewRecordValue({ ...record, decision }),
  );
}

function reviewRecordSubject(markdown: string): ReviewRecordSubject {
  const repo = frontMatterValue(markdown, "repository");
  const number = Number(frontMatterValue(markdown, "number"));
  const kind = frontMatterValue(markdown, "type");
  // A local-range review has item number 0.
  if (!repo || !Number.isSafeInteger(number) || number < 0) {
    throw new ReviewRecordFormatError("the report has no repository and number");
  }
  if (kind !== "issue" && kind !== "pull_request") {
    throw new ReviewRecordFormatError("the report has no item type");
  }
  return { repo, number, kind };
}

function storedObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewRecordFormatError(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

// The runner adds these keys when it verifies a model regression candidate.
const VERIFIED_REGRESSION_PROVENANCE_KEYS = new Set([
  ...REGRESSION_PROVENANCE_SCHEMA_KEYS,
  "verificationSource",
  "evidenceType",
  "mergedAt",
  "reviewedCommitSha",
  "sourceCommitSha",
  "sourceAuthor",
]);
const SUSPECTED_REGRESSION_PROVENANCE_KEYS = new Set([
  "verificationSource",
  "evidenceType",
  "sourceCommitSha",
  "sourceAuthor",
  "sourcePath",
  "sourceLine",
  "relatedPullRequestNumber",
  "relatedPullRequestUrl",
  "relatedRepo",
]);

function onlyKeys(value: object, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function parseFixedPullRequest(value: unknown): FixedPullRequest | null {
  if (value === null) return null;
  const pull = storedObject(value, "decision.fixedPullRequest");
  const { repo, number, url, title, mergedAt, sha, confidence, source } = pull;
  if (
    typeof repo !== "string" ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    typeof title !== "string" ||
    (mergedAt !== null && typeof mergedAt !== "string") ||
    (sha !== null && typeof sha !== "string") ||
    !CONFIDENCES.has(confidence as FixedPullRequest["confidence"]) ||
    !(isGitHubVerifiedFixedPullRequestSource(source) || source === "report metadata")
  ) {
    throw new ReviewRecordFormatError("decision.fixedPullRequest is invalid");
  }
  return {
    repo,
    number,
    url,
    title,
    mergedAt,
    sha,
    confidence: confidence as FixedPullRequest["confidence"],
    source,
  };
}

// The model schema fields use the review parser. The runner-owned fields use their
// own readers. The stored value must be a fixed point: if parsing changes anything
// (an unknown key, a default, a normalized value), the record is invalid.
function parseStoredDecision(value: unknown, subject: ReviewRecordSubject): Decision {
  const stored = storedObject(value, "decision");
  const {
    oversizedPullRequest,
    oversizedPullRequestSource,
    localCheckoutAccess,
    checkoutInspectionFailed,
    codexTerminalFailure,
    fixedPullRequest,
    regressionProvenance,
    ...schemaFields
  } = stored;
  const publicRegressionProvenance =
    (isVerifiedRegressionProvenance(regressionProvenance) &&
      onlyKeys(regressionProvenance, VERIFIED_REGRESSION_PROVENANCE_KEYS)) ||
    (isSuspectedRegressionProvenance(regressionProvenance) &&
      onlyKeys(regressionProvenance, SUSPECTED_REGRESSION_PROVENANCE_KEYS))
      ? regressionProvenance
      : undefined;
  let decision: Decision;
  try {
    decision = storedDecisionParser.parseStoredDecisionFields(
      publicRegressionProvenance || regressionProvenance === undefined
        ? schemaFields
        : { ...schemaFields, regressionProvenance },
      subject,
    );
  } catch (error) {
    throw new ReviewRecordFormatError(error instanceof Error ? error.message : String(error));
  }
  const runnerField = <T>(name: string, field: unknown, parse: (value: unknown) => T | null) => {
    if (field === undefined) return {};
    const parsed = parse(field);
    if (parsed === null) throw new ReviewRecordFormatError(`decision.${name} is invalid`);
    return { [name]: parsed };
  };
  const flag = (field: unknown) => (typeof field === "boolean" ? field : null);
  Object.assign(
    decision,
    runnerField(
      "oversizedPullRequestSource",
      oversizedPullRequestSource,
      parseOversizedPrSourceSnapshot,
    ),
    runnerField("oversizedPullRequest", oversizedPullRequest, parseOversizedPullRequestEvidence),
    runnerField("localCheckoutAccess", localCheckoutAccess, (field) =>
      field === "verified" || field === "unverified" ? field : null,
    ),
    runnerField("checkoutInspectionFailed", checkoutInspectionFailed, flag),
    runnerField("codexTerminalFailure", codexTerminalFailure, flag),
    fixedPullRequest === undefined
      ? {}
      : { fixedPullRequest: parseFixedPullRequest(fixedPullRequest) },
    publicRegressionProvenance ? { regressionProvenance: publicRegressionProvenance } : {},
  );
  const parsed = JSON.parse(JSON.stringify(decision)) as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(parsed), ...Object.keys(stored)])].filter(
    (key) => !isDeepStrictEqual(parsed[key], stored[key]),
  );
  if (changed.length > 0) {
    throw new ReviewRecordFormatError(`decision.${changed.join(", decision.")} is not canonical`);
  }
  return decision;
}
