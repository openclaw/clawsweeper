import { createHash } from "node:crypto";
import { extname } from "node:path";

import { getShebang, SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import { createVirtualFileSystem, type FileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

import { REVIEW_CACHE_MAX_AGE_DAYS } from "./scheduler-policy.js";
import { stableJson } from "./stable-json.js";

export const REVIEW_SEMANTIC_CACHE_VERSION = 7;
export const REVIEW_SEMANTIC_CACHE_MAX_AGE_DAYS = REVIEW_CACHE_MAX_AGE_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PATCH_CHARS = 512 * 1024;
const MAX_FILES = 80;
const DIRECTIVE_COMMENT_PATTERN =
  /(?:^\/[/*]!|[@#]|\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b|\b(?:babel|biome|c8|coverage|deno-fmt|deno-lint|eslint|esbuild|flow|gql|graphql|istanbul|jshint|jslint|nosonar|oxfmt|oxlint|prettier|rollup|swc|tslint|v8|vite|webpack)[\w-]*|\b(?:exported|globals?)\b)/i;
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
const COMMENT_LITERAL_KINDS = new Set([
  SyntaxKind.JsxText,
  SyntaxKind.JsxTextAllWhiteSpaces,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);
const COMPILER_VIRTUAL_ROOT = "/clawsweeper-semantic-cache";

export type ReviewSemanticEligibilityReason =
  | "eligible"
  | "not_pull_request"
  | "missing_structural_context"
  | "incomplete_release_state"
  | "incomplete_checks"
  | "incomplete_review_context"
  | "incomplete_file_list"
  | "incomplete_file_modes"
  | "unsupported_file_mode"
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
  "incomplete_release_state",
  "incomplete_checks",
  "incomplete_review_context",
  "incomplete_file_list",
  "incomplete_file_modes",
  "unsupported_file_mode",
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
    releaseStateComplete: boolean;
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
  oldStart: number;
  newStart: number;
  additions: number;
  deletions: number;
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
    baseMode: file.baseMode ?? null,
    baseType: file.baseType ?? null,
    headMode: file.headMode ?? null,
    headType: file.headType ?? null,
    treeModesComplete: file.treeModesComplete ?? false,
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

function parseHunkHeader(
  line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
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
    let additions = 0;
    let deletions = 0;
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
        deletions += 1;
        oldLines.push(text);
      } else if (marker === "+") {
        newSeen += 1;
        additions += 1;
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
      oldStart: header.oldStart,
      newStart: header.newStart,
      additions,
      deletions,
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
    });
  }
  return hunks.length > 0 ? hunks : null;
}

function isDirectiveComment(value: string): boolean {
  return DIRECTIVE_COMMENT_PATTERN.test(value);
}

function canonicalSyntaxGap(text: string): string {
  let canonical = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/\s/.test(character)) continue;
    if (text.startsWith("//", index)) {
      const lineEnd = text.indexOf("\n", index + 2);
      if (lineEnd < 0) break;
      index = lineEnd - 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const blockEnd = text.indexOf("*/", index + 2);
      if (blockEnd < 0) return "";
      index = blockEnd + 1;
      continue;
    }
    canonical += character;
  }
  return canonical;
}

function canonicalAstNode(node: Node, sourceFile: SourceFile): unknown {
  const children: Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  if (children.length === 0) return [node.kind, node.flags, node.getText(sourceFile)];
  const parts: unknown[] = [];
  let cursor = node.getStart(sourceFile);
  for (const child of children) {
    const childStart = child.getStart(sourceFile);
    const gap = canonicalSyntaxGap(sourceFile.text.slice(cursor, childStart));
    if (gap) parts.push(["syntax", gap]);
    parts.push(canonicalAstNode(child, sourceFile));
    cursor = child.getEnd();
  }
  const trailingGap = canonicalSyntaxGap(sourceFile.text.slice(cursor, node.getEnd()));
  if (trailingGap) parts.push(["syntax", trailingGap]);
  return [node.kind, node.flags, parts];
}

function semanticDirectiveComments(sourceFile: SourceFile): unknown[] {
  const literalRanges: Array<{ start: number; end: number }> = [];
  const leafRanges: Array<{ start: number; end: number }> = [];
  const visit = (node: Node): void => {
    if (COMMENT_LITERAL_KINDS.has(node.kind)) {
      literalRanges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
    }
    let hasChild = false;
    node.forEachChild((child) => {
      hasChild = true;
      visit(child);
    });
    if (!hasChild) {
      leafRanges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
    }
  };
  visit(sourceFile);
  literalRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  leafRanges.sort((left, right) => left.start - right.start || left.end - right.end);

  const directives: unknown[] = [];
  const text = sourceFile.text;
  let literalIndex = 0;
  let previousLeaf = -1;
  for (let index = 0; index < text.length; index += 1) {
    while (literalRanges[literalIndex] && literalRanges[literalIndex]!.end <= index) {
      literalIndex += 1;
    }
    const literal = literalRanges[literalIndex];
    if (literal && index >= literal.start && index < literal.end) {
      index = literal.end - 1;
      continue;
    }
    let end = -1;
    if (text.startsWith("//", index)) {
      const lineEnd = text.indexOf("\n", index + 2);
      end = lineEnd < 0 ? text.length : lineEnd;
    } else if (text.startsWith("/*", index)) {
      const blockEnd = text.indexOf("*/", index + 2);
      if (blockEnd < 0) return [{ invalid: true }];
      end = blockEnd + 2;
    }
    if (end < 0) continue;
    const comment = text.slice(index, end);
    if (isDirectiveComment(comment)) {
      while (leafRanges[previousLeaf + 1] && leafRanges[previousLeaf + 1]!.end <= index) {
        previousLeaf += 1;
      }
      let nextLeaf = previousLeaf + 1;
      while (leafRanges[nextLeaf] && leafRanges[nextLeaf]!.start < end) nextLeaf += 1;
      const previousEnd = previousLeaf < 0 ? 0 : leafRanges[previousLeaf]!.end;
      const nextStart = leafRanges[nextLeaf]?.start ?? text.length;
      directives.push({
        afterSyntax: canonicalSyntaxGap(text.slice(end, nextStart)),
        beforeSyntax: canonicalSyntaxGap(text.slice(previousEnd, index)),
        line: sourceFile.getLineAndCharacterOfPosition(index).line,
        nextLeaf,
        previousLeaf,
        text: comment,
      });
    }
    index = end - 1;
  }
  return directives;
}

class SemanticCompilerSession {
  private readonly fileSystem: FileSystem = createVirtualFileSystem({});
  private readonly api = new API({
    cwd: COMPILER_VIRTUAL_ROOT,
    fs: this.fileSystem,
  });
  private nextFileId = 0;

  parse(text: string, extension: string): { digest: string; valid: boolean } {
    const writeFile = this.fileSystem.writeFile;
    if (!writeFile) return { digest: "", valid: false };
    const fileName = `${COMPILER_VIRTUAL_ROOT}/snippet-${this.nextFileId}${extension}`;
    this.nextFileId += 1;
    writeFile(fileName, text);
    try {
      const snapshot = this.api.updateSnapshot({ openFiles: [fileName] });
      try {
        const project = snapshot.getDefaultProjectForFile(fileName);
        const sourceFile = project?.program.getSourceFile(fileName);
        if (
          !project ||
          !sourceFile ||
          project.program.getSyntacticDiagnostics(fileName).length > 0
        ) {
          return { digest: "", valid: false };
        }
        const directives = semanticDirectiveComments(sourceFile);
        if (directives.some((directive) => asRecord(directive).invalid === true)) {
          return { digest: "", valid: false };
        }
        return {
          digest: sha256(
            stableJson({
              ast: canonicalAstNode(sourceFile, sourceFile),
              directives,
              shebang: getShebang(text) ?? null,
            }),
          ),
          valid: true,
        };
      } finally {
        snapshot.dispose();
      }
    } catch {
      return { digest: "", valid: false };
    }
  }

  close(): void {
    try {
      this.api.close();
    } catch {
      // Compiler service shutdown cannot make an otherwise safe fingerprint reusable.
    }
  }
}

function canonicalJson(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let inString = false;
  let escaped = false;
  let canonical = "";
  for (const character of text) {
    if (inString) {
      canonical += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      canonical += character;
      continue;
    }
    if (!/\s/.test(character)) canonical += character;
  }
  return canonical;
}

function semanticHunksForFile(
  filename: string,
  status: "modified" | "added",
  hunks: readonly ParsedHunk[],
  compiler: SemanticCompilerSession,
): FileSemanticResult {
  const extension = extname(filename).toLowerCase();
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    if (
      hunks.length !== 1 ||
      (status === "added"
        ? hunks[0]?.oldStart !== 0 || hunks[0]?.newStart !== 1
        : hunks[0]?.oldStart !== 1 || hunks[0]?.newStart !== 1)
    ) {
      return { eligible: false, reason: "lexical_ambiguity", value: null };
    }
    const semanticHunks = [];
    for (const hunk of hunks) {
      const oldAst = compiler.parse(hunk.oldText, extension);
      const newAst = compiler.parse(hunk.newText, extension);
      if (!oldAst.valid || !newAst.valid) {
        return { eligible: false, reason: "lexical_ambiguity", value: null };
      }
      semanticHunks.push({
        sourceAnchor: status === "added" ? hunk.newStart : hunk.oldStart,
        old: oldAst.digest,
        new: newAst.digest,
      });
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
      semanticHunks.push({
        sourceAnchor: status === "added" ? hunk.newStart : hunk.oldStart,
        old: oldValue,
        new: newValue,
      });
    }
    return { eligible: true, reason: "eligible", value: semanticHunks };
  }
  return { eligible: false, reason: "unsupported_language", value: null };
}

function semanticFile(value: unknown, compiler: SemanticCompilerSession): FileSemanticResult {
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
  if (file.treeModesComplete !== true) {
    return { eligible: false, reason: "incomplete_file_modes", value: null };
  }
  const baseMode = stringValue(file.baseMode);
  const baseType = stringValue(file.baseType);
  const headMode = stringValue(file.headMode);
  const headType = stringValue(file.headType);
  const regularBlob = (mode: string | null, type: string | null): boolean =>
    type === "blob" && (mode === "100644" || mode === "100755");
  if (
    !regularBlob(headMode, headType) ||
    (status === "modified" && !regularBlob(baseMode, baseType)) ||
    (status === "added" && (baseMode !== null || baseType !== null))
  ) {
    return { eligible: false, reason: "unsupported_file_mode", value: null };
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
    const countedAdditions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
    const countedDeletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
    if (
      (additions !== null && additions !== countedAdditions) ||
      (deletions !== null && deletions !== countedDeletions)
    ) {
      return { eligible: false, reason: "truncated_patch", value: null };
    }
  }
  const semantic = semanticHunksForFile(filename, status, hunks, compiler);
  if (!semantic.eligible) return semantic;
  return {
    eligible: true,
    reason: "eligible",
    value: {
      filename,
      status,
      baseMode,
      baseType,
      headMode,
      headType,
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
  let compiler: SemanticCompilerSession;
  try {
    compiler = new SemanticCompilerSession();
  } catch {
    return {
      digest: sha256(stableJson(files.map(exactFileView))),
      eligible: false,
      reason: "lexical_ambiguity",
    };
  }
  try {
    for (const file of files) {
      const result = semanticFile(file, compiler);
      if (!result.eligible) {
        return {
          digest: sha256(stableJson(files.map(exactFileView))),
          eligible: false,
          reason: result.reason,
        };
      }
      semanticFiles.push(result.value);
    }
  } finally {
    compiler.close();
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
      releaseStateComplete: input.git.releaseStateComplete,
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
  if (!input.git.releaseStateComplete) {
    return {
      digest: sha256(stableJson(context)),
      complete: false,
      reason: "incomplete_release_state",
    };
  }
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
