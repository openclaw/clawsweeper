import { createHash } from "node:crypto";
import { extname } from "node:path";

import { createScanner, getShebang, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

import { REVIEW_CACHE_MAX_AGE_DAYS } from "./scheduler-policy.js";
import { stableJson } from "./stable-json.js";

export const REVIEW_SEMANTIC_CACHE_VERSION = 1;
export const REVIEW_SEMANTIC_CACHE_MAX_AGE_DAYS = REVIEW_CACHE_MAX_AGE_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PATCH_CHARS = 512 * 1024;
const MAX_FILES = 80;
const DIRECTIVE_COMMENT_PATTERN =
  /@ts-(?:ignore|expect-error|nocheck|check)\b|[#@]\s*sourceMappingURL=|[#@]\s*sourceURL=|\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b/i;
const TYPESCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const JSON_EXTENSIONS = new Set([".json"]);

export type ReviewSemanticEligibilityReason =
  | "eligible"
  | "not_pull_request"
  | "missing_structural_context"
  | "incomplete_checks"
  | "incomplete_review_context"
  | "incomplete_file_list"
  | "missing_patch"
  | "truncated_patch"
  | "oversized_patch"
  | "binary_patch"
  | "deleted_file"
  | "renamed_file"
  | "unsupported_status"
  | "unsupported_language"
  | "malformed_patch"
  | "lexical_ambiguity"
  | "invalid_json";

const ELIGIBILITY_REASONS = new Set<ReviewSemanticEligibilityReason>([
  "eligible",
  "not_pull_request",
  "missing_structural_context",
  "incomplete_checks",
  "incomplete_review_context",
  "incomplete_file_list",
  "missing_patch",
  "truncated_patch",
  "oversized_patch",
  "binary_patch",
  "deleted_file",
  "renamed_file",
  "unsupported_status",
  "unsupported_language",
  "malformed_patch",
  "lexical_ambiguity",
  "invalid_json",
]);

export interface ReviewSemanticRecord {
  version: typeof REVIEW_SEMANTIC_CACHE_VERSION;
  fingerprint: string;
  codeDigest: string;
  exactDigest: string;
  contextDigest: string;
  eligible: boolean;
  eligibilityReason: ReviewSemanticEligibilityReason;
  reviewPolicy: string;
  reviewModel: string;
}

export interface ReviewSemanticPriorReview {
  reviewStatus?: string | undefined;
  decision?: string | undefined;
  lastFullReviewAt?: string | undefined;
  lastFullReviewDecision?: string | undefined;
  reviewPolicy?: string | undefined;
  reviewModel?: string | undefined;
}

export type ReviewSemanticCacheReason =
  | "hit"
  | "explicit_dispatch"
  | "maintainer_request"
  | "coordination_disabled"
  | "missing_review"
  | "incomplete_review"
  | "non_keep_open_verdict"
  | "policy_changed"
  | "model_changed"
  | "stale_review"
  | "missing_or_invalid_record"
  | "semantic_ineligible"
  | "code_changed"
  | "context_changed";

export interface ReviewSemanticCacheDecision {
  hit: boolean;
  reason: ReviewSemanticCacheReason;
}

export interface ReviewSemanticInput {
  item: {
    repo: string;
    number: number;
    kind: "issue" | "pull_request";
  };
  context: {
    issue: unknown;
    comments: readonly unknown[];
    timeline: readonly unknown[];
    timelineRevision?: string | undefined;
    closingPullRequests?: readonly unknown[] | undefined;
    referencingMergedPullRequests?: readonly unknown[] | undefined;
    relatedItems?: readonly unknown[] | undefined;
    pullRequest?: unknown;
    pullFiles?: readonly unknown[] | undefined;
    semanticPullFiles?: readonly unknown[] | undefined;
    pullCommits?: readonly unknown[] | undefined;
    pullReviewComments?: readonly unknown[] | undefined;
    pullReviewCommentsRevision?: string | undefined;
    pullChecks?: unknown;
    counts?: Record<string, unknown> | undefined;
  };
  git: {
    mainSha: string;
    latestRelease: {
      tagName?: string | undefined;
      sha?: string | null | undefined;
    } | null;
  };
  structuralContextRevision: string | null;
  reviewPolicy: string;
  reviewModel: string;
}

interface ParsedHunk {
  oldText: string;
  newText: string;
}

interface FileSemanticResult {
  eligible: boolean;
  reason: ReviewSemanticEligibilityReason;
  value: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedStatus(value: unknown): string {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "m" || status === "modified" || status === "changed") return "modified";
  if (status === "a" || status === "added") return "added";
  if (status === "d" || status === "deleted" || status === "removed") return "deleted";
  if (status.startsWith("r") || status === "renamed") return "renamed";
  if (status.startsWith("c") || status === "copied") return "copied";
  return status;
}

function exactFileView(value: unknown): unknown {
  const file = asRecord(value);
  return {
    filename: file.filename ?? null,
    previousFilename: file.previous_filename ?? null,
    status: file.status ?? null,
    additions: file.additions ?? null,
    deletions: file.deletions ?? null,
    changes: file.changes ?? null,
    patch: file.patch ?? null,
  };
}

function exactDiffDigest(input: ReviewSemanticInput): string {
  const files = input.context.semanticPullFiles ?? input.context.pullFiles ?? [];
  return sha256(
    stableJson({
      files: files.map(exactFileView),
      counts: {
        total: input.context.counts?.pullFiles ?? null,
        hydrated: input.context.counts?.pullFilesHydrated ?? null,
        truncated: input.context.counts?.pullFilesTruncated ?? null,
      },
    }),
  );
}

function parseHunkHeader(line: string): { oldCount: number; newCount: number } | null {
  const match = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)?$/);
  if (!match) return null;
  return {
    oldCount: match[1] === undefined ? 1 : Number(match[1]),
    newCount: match[2] === undefined ? 1 : Number(match[2]),
  };
}

function parseUnifiedPatch(patch: string): ParsedHunk[] | null {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const hunks: ParsedHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = parseHunkHeader(lines[index] ?? "");
    if (!header) {
      index += 1;
      continue;
    }
    index += 1;
    let oldSeen = 0;
    let newSeen = 0;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (index < lines.length && !parseHunkHeader(lines[index] ?? "")) {
      const line = lines[index] ?? "";
      if (line === "\\ No newline at end of file") {
        index += 1;
        continue;
      }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        oldSeen += 1;
        newSeen += 1;
        oldLines.push(text);
        newLines.push(text);
      } else if (marker === "-") {
        oldSeen += 1;
        oldLines.push(text);
      } else if (marker === "+") {
        newSeen += 1;
        newLines.push(text);
      } else if (line.length > 0) {
        return null;
      }
      index += 1;
      if (oldSeen === header.oldCount && newSeen === header.newCount) break;
      if (oldSeen > header.oldCount || newSeen > header.newCount) return null;
    }
    if (oldSeen !== header.oldCount || newSeen !== header.newCount) return null;
    hunks.push({
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
    });
  }
  return hunks.length > 0 ? hunks : null;
}

function isDirectiveComment(value: string): boolean {
  return DIRECTIVE_COMMENT_PATTERN.test(value);
}

function scanCompilerTokens(
  text: string,
  languageVariant: LanguageVariant,
): { tokens: string[]; valid: boolean } {
  const scanner = createScanner(false, languageVariant, text);
  const shebang = getShebang(text);
  const tokens: string[] = [];
  let iterations = 0;
  while (iterations <= text.length + 1) {
    iterations += 1;
    const kind = scanner.scan();
    const tokenText = scanner.getTokenText();
    if (kind === SyntaxKind.EndOfFile) return { tokens, valid: true };
    if (scanner.isUnterminated()) return { tokens: [], valid: false };
    if (
      kind === SyntaxKind.WhitespaceTrivia ||
      kind === SyntaxKind.NewLineTrivia ||
      ((kind === SyntaxKind.SingleLineCommentTrivia ||
        kind === SyntaxKind.MultiLineCommentTrivia) &&
        !isDirectiveComment(tokenText))
    ) {
      continue;
    }
    if (kind === SyntaxKind.Unknown && shebang === tokenText && scanner.getTokenStart() === 0) {
      tokens.push(`shebang:${tokenText}`);
      continue;
    }
    if (
      kind === SyntaxKind.Unknown ||
      kind === SyntaxKind.ConflictMarkerTrivia ||
      kind === SyntaxKind.NonTextFileMarkerTrivia
    ) {
      return { tokens: [], valid: false };
    }
    tokens.push(`${kind}:${tokenText}`);
  }
  return { tokens: [], valid: false };
}

function canonicalJson(text: string): string | null {
  try {
    return stableJson(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function semanticHunksForFile(filename: string, hunks: readonly ParsedHunk[]): FileSemanticResult {
  const extension = extname(filename).toLowerCase();
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    const variant =
      extension === ".tsx" || extension === ".jsx" ? LanguageVariant.JSX : LanguageVariant.Standard;
    const semanticHunks = [];
    for (const hunk of hunks) {
      const oldTokens = scanCompilerTokens(hunk.oldText, variant);
      const newTokens = scanCompilerTokens(hunk.newText, variant);
      if (!oldTokens.valid || !newTokens.valid) {
        return { eligible: false, reason: "lexical_ambiguity", value: null };
      }
      semanticHunks.push({ old: oldTokens.tokens, new: newTokens.tokens });
    }
    return { eligible: true, reason: "eligible", value: semanticHunks };
  }
  if (JSON_EXTENSIONS.has(extension)) {
    const semanticHunks = [];
    for (const hunk of hunks) {
      const oldValue = hunk.oldText.trim() ? canonicalJson(hunk.oldText) : "";
      const newValue = hunk.newText.trim() ? canonicalJson(hunk.newText) : "";
      if (oldValue === null || newValue === null) {
        return { eligible: false, reason: "invalid_json", value: null };
      }
      semanticHunks.push({ old: oldValue, new: newValue });
    }
    return { eligible: true, reason: "eligible", value: semanticHunks };
  }
  return { eligible: false, reason: "unsupported_language", value: null };
}

function semanticFile(value: unknown): FileSemanticResult {
  const file = asRecord(value);
  const filename = stringValue(file.filename);
  const previousFilename = stringValue(file.previous_filename);
  const status = normalizedStatus(file.status);
  const patch = stringValue(file.patch);
  if (!filename) return { eligible: false, reason: "malformed_patch", value: null };
  if (previousFilename || status === "renamed") {
    return { eligible: false, reason: "renamed_file", value: null };
  }
  if (status === "deleted") return { eligible: false, reason: "deleted_file", value: null };
  if (status !== "modified" && status !== "added") {
    return { eligible: false, reason: "unsupported_status", value: null };
  }
  if (!patch) return { eligible: false, reason: "missing_patch", value: null };
  if (patch.length > MAX_PATCH_CHARS) {
    return { eligible: false, reason: "oversized_patch", value: null };
  }
  if (patch.includes("[truncated ") || patch.includes("... truncated ")) {
    return { eligible: false, reason: "truncated_patch", value: null };
  }
  if (
    patch.includes("\0") ||
    /(?:^|\n)(?:Binary files .* differ|GIT binary patch)(?:\n|$)/.test(patch)
  ) {
    return { eligible: false, reason: "binary_patch", value: null };
  }
  const hunks = parseUnifiedPatch(patch);
  if (!hunks) return { eligible: false, reason: "malformed_patch", value: null };
  const additions = finiteCount(file.additions);
  const deletions = finiteCount(file.deletions);
  if (additions !== null || deletions !== null) {
    const changed = patch.replace(/\r\n?/g, "\n").split("\n");
    const countedAdditions = changed.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length;
    const countedDeletions = changed.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length;
    if (
      (additions !== null && additions !== countedAdditions) ||
      (deletions !== null && deletions !== countedDeletions)
    ) {
      return { eligible: false, reason: "truncated_patch", value: null };
    }
  }
  const semantic = semanticHunksForFile(filename, hunks);
  if (!semantic.eligible) return semantic;
  return {
    eligible: true,
    reason: "eligible",
    value: {
      filename,
      status,
      hunks: semantic.value,
    },
  };
}

function semanticCode(input: ReviewSemanticInput): {
  digest: string;
  eligible: boolean;
  reason: ReviewSemanticEligibilityReason;
} {
  if (input.item.kind !== "pull_request") {
    return { digest: sha256("not-pull-request"), eligible: false, reason: "not_pull_request" };
  }
  const files = input.context.semanticPullFiles ?? input.context.pullFiles;
  const counts = input.context.counts;
  const total = finiteCount(counts?.pullFiles);
  const hydrated = finiteCount(counts?.pullFilesHydrated);
  if (
    !files ||
    files.length === 0 ||
    files.length > MAX_FILES ||
    counts?.pullFilesTruncated === true ||
    (total !== null && total !== files.length) ||
    (hydrated !== null && hydrated !== files.length) ||
    files.some((file) => finiteCount(asRecord(file).omitted) !== null)
  ) {
    return {
      digest: sha256(stableJson((files ?? []).map(exactFileView))),
      eligible: false,
      reason: "incomplete_file_list",
    };
  }
  const semanticFiles = [];
  for (const file of files) {
    const result = semanticFile(file);
    if (!result.eligible) {
      return {
        digest: sha256(stableJson(files.map(exactFileView))),
        eligible: false,
        reason: result.reason,
      };
    }
    semanticFiles.push(result.value);
  }
  semanticFiles.sort((left, right) =>
    String(asRecord(left).filename).localeCompare(String(asRecord(right).filename)),
  );
  return { digest: sha256(stableJson(semanticFiles)), eligible: true, reason: "eligible" };
}

function omitKeys(value: unknown, omitted: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter(([key]) => !omitted.has(key)));
}

function normalizedComments(values: readonly unknown[] | undefined): unknown[] {
  return (values ?? []).map((value) =>
    omitKeys(value, new Set(["createdAt", "updatedAt", "url", "id"])),
  );
}

function normalizedCommits(values: readonly unknown[] | undefined): unknown[] {
  return (values ?? []).map((value) => {
    const commit = asRecord(value);
    return {
      author: commit.author ?? null,
      message: commit.message ?? null,
    };
  });
}

function completePullChecks(value: unknown): boolean {
  const checks = asRecord(value);
  return (
    checks.complete === true &&
    checks.checkRunsTruncated !== true &&
    checks.statusesTruncated !== true &&
    Array.isArray(checks.checkRuns) &&
    Array.isArray(checks.statuses)
  );
}

function semanticContext(input: ReviewSemanticInput): {
  digest: string;
  complete: boolean;
  reason: ReviewSemanticEligibilityReason;
} {
  const pull = asRecord(input.context.pullRequest);
  const base = asRecord(pull.base);
  const issue = omitKeys(
    input.context.issue,
    new Set(["comments", "createdAt", "updatedAt", "url"]),
  );
  const normalizedPull = {
    ...omitKeys(
      pull,
      new Set([
        "additions",
        "changedFiles",
        "createdAt",
        "deletions",
        "head",
        "mergeCommitSha",
        "updatedAt",
        "url",
      ]),
    ),
    base: {
      ref: base.ref ?? null,
      sha: base.sha ?? null,
    },
  };
  const context = {
    item: input.item,
    issue,
    comments: normalizedComments(input.context.comments),
    timeline:
      input.context.timelineRevision ??
      input.context.timeline.map((entry) =>
        omitKeys(entry, new Set(["createdAt", "updatedAt", "url"])),
      ),
    relations: {
      closingPullRequests: input.context.closingPullRequests ?? null,
      referencingMergedPullRequests: input.context.referencingMergedPullRequests ?? null,
      relatedItems: input.context.relatedItems ?? null,
    },
    pull: normalizedPull,
    commits: normalizedCommits(input.context.pullCommits),
    reviewComments:
      input.context.pullReviewCommentsRevision ??
      normalizedComments(input.context.pullReviewComments),
    checks: input.context.pullChecks ?? null,
    completeness: {
      commentsTruncated: input.context.counts?.commentsTruncated ?? null,
      timelineTruncated: input.context.counts?.timelineTruncated ?? null,
      pullCommitsTruncated: input.context.counts?.pullCommitsTruncated ?? null,
      pullReviewCommentsTruncated: input.context.counts?.pullReviewCommentsTruncated ?? null,
    },
    target: {
      mainSha: input.git.mainSha,
      latestRelease: input.git.latestRelease
        ? {
            tagName: input.git.latestRelease.tagName ?? null,
            sha: input.git.latestRelease.sha ?? null,
          }
        : null,
    },
    structuralContextRevision: input.structuralContextRevision,
    reviewPolicy: input.reviewPolicy,
    reviewModel: input.reviewModel,
  };
  if (!input.structuralContextRevision || !DIGEST_PATTERN.test(input.structuralContextRevision)) {
    return {
      digest: sha256(stableJson(context)),
      complete: false,
      reason: "missing_structural_context",
    };
  }
  if (!completePullChecks(input.context.pullChecks)) {
    return {
      digest: sha256(stableJson(context)),
      complete: false,
      reason: "incomplete_checks",
    };
  }
  if (input.context.counts?.pullCommitsTruncated === true) {
    return {
      digest: sha256(stableJson(context)),
      complete: false,
      reason: "incomplete_review_context",
    };
  }
  return { digest: sha256(stableJson(context)), complete: true, reason: "eligible" };
}

function recordFingerprint(record: Omit<ReviewSemanticRecord, "fingerprint">): string {
  return sha256(stableJson(record));
}

export function createReviewSemanticRecord(input: ReviewSemanticInput): ReviewSemanticRecord {
  const exactDigest = exactDiffDigest(input);
  const code = semanticCode(input);
  const context = semanticContext(input);
  const eligible = code.eligible && context.complete;
  const eligibilityReason = code.eligible ? context.reason : code.reason;
  const withoutFingerprint = {
    version: REVIEW_SEMANTIC_CACHE_VERSION,
    codeDigest: code.digest,
    exactDigest,
    contextDigest: context.digest,
    eligible,
    eligibilityReason,
    reviewPolicy: input.reviewPolicy,
    reviewModel: input.reviewModel,
  } satisfies Omit<ReviewSemanticRecord, "fingerprint">;
  return {
    ...withoutFingerprint,
    fingerprint: recordFingerprint(withoutFingerprint),
  };
}

export function validReviewSemanticRecord(
  record: ReviewSemanticRecord | null,
): record is ReviewSemanticRecord {
  if (
    !record ||
    record.version !== REVIEW_SEMANTIC_CACHE_VERSION ||
    !DIGEST_PATTERN.test(record.fingerprint) ||
    !DIGEST_PATTERN.test(record.codeDigest) ||
    !DIGEST_PATTERN.test(record.exactDigest) ||
    !DIGEST_PATTERN.test(record.contextDigest) ||
    !record.reviewPolicy ||
    !record.reviewModel ||
    !ELIGIBILITY_REASONS.has(record.eligibilityReason) ||
    (record.eligible && record.eligibilityReason !== "eligible") ||
    (!record.eligible && record.eligibilityReason === "eligible")
  ) {
    return false;
  }
  const { fingerprint: _, ...withoutFingerprint } = record;
  return recordFingerprint(withoutFingerprint) === record.fingerprint;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareSemanticRecords(
  prior: ReviewSemanticRecord | null,
  current: ReviewSemanticRecord | null,
  reviewPolicy: string,
  reviewModel: string,
): ReviewSemanticCacheDecision {
  if (!validReviewSemanticRecord(prior) || !validReviewSemanticRecord(current)) {
    return { hit: false, reason: "missing_or_invalid_record" };
  }
  if (prior.reviewPolicy !== reviewPolicy || current.reviewPolicy !== reviewPolicy) {
    return { hit: false, reason: "policy_changed" };
  }
  if (prior.reviewModel !== reviewModel || current.reviewModel !== reviewModel) {
    return { hit: false, reason: "model_changed" };
  }
  if (!prior.eligible || !current.eligible) {
    return { hit: false, reason: "semantic_ineligible" };
  }
  if (prior.codeDigest !== current.codeDigest) {
    return { hit: false, reason: "code_changed" };
  }
  if (prior.contextDigest !== current.contextDigest) {
    return { hit: false, reason: "context_changed" };
  }
  return { hit: true, reason: "hit" };
}

export function reviewSemanticCacheDecision(options: {
  review: ReviewSemanticPriorReview | null;
  priorRecord: ReviewSemanticRecord | null;
  currentRecord: ReviewSemanticRecord | null;
  reviewPolicy: string;
  reviewModel: string;
  explicitDispatch: boolean;
  maintainerRequest: boolean;
  coordinationEnabled: boolean;
  now?: number;
}): ReviewSemanticCacheDecision {
  if (options.explicitDispatch) return { hit: false, reason: "explicit_dispatch" };
  if (options.maintainerRequest) return { hit: false, reason: "maintainer_request" };
  if (!options.coordinationEnabled) return { hit: false, reason: "coordination_disabled" };
  const review = options.review;
  if (!review) return { hit: false, reason: "missing_review" };
  if (review.reviewStatus !== "complete") return { hit: false, reason: "incomplete_review" };
  if (review.decision !== "keep_open" || review.lastFullReviewDecision !== "keep_open") {
    return { hit: false, reason: "non_keep_open_verdict" };
  }
  if (review.reviewPolicy !== options.reviewPolicy) {
    return { hit: false, reason: "policy_changed" };
  }
  if (review.reviewModel !== options.reviewModel) {
    return { hit: false, reason: "model_changed" };
  }
  const lastFullReviewAt = timestampMs(review.lastFullReviewAt);
  const now = options.now ?? Date.now();
  if (
    lastFullReviewAt === null ||
    lastFullReviewAt > now ||
    now - lastFullReviewAt >= REVIEW_SEMANTIC_CACHE_MAX_AGE_DAYS * DAY_MS
  ) {
    return { hit: false, reason: "stale_review" };
  }
  return compareSemanticRecords(
    options.priorRecord,
    options.currentRecord,
    options.reviewPolicy,
    options.reviewModel,
  );
}

export function reviewSemanticRevalidationDecision(options: {
  initialRecord: ReviewSemanticRecord | null;
  currentRecord: ReviewSemanticRecord | null;
  reviewPolicy: string;
  reviewModel: string;
}): ReviewSemanticCacheDecision {
  return compareSemanticRecords(
    options.initialRecord,
    options.currentRecord,
    options.reviewPolicy,
    options.reviewModel,
  );
}
