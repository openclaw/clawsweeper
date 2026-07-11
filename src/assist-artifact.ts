import { createHash } from "node:crypto";

export const ASSIST_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const ASSIST_ARTIFACT_MAX_BYTES = 128 * 1024;
export const ASSIST_ANSWER_MAX_BYTES = 60_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMENT_ID_PATTERN = /^\d{1,30}$/;
const CLAWSWEEPER_MARKER_PATTERN = /<!--\s*clawsweeper(?:-|:)/i;

export type AssistMode = "assist" | "visual";

export interface AssistRequestBinding {
  targetRepo: string;
  itemNumber: number;
  question: string;
  mode: AssistMode;
  lens: string;
  sourceCommentId: string;
  sourceCommentUrl: string;
  author: string;
  reasoningEffort: string;
}

export interface AssistArtifact {
  schema_version: typeof ASSIST_ARTIFACT_SCHEMA_VERSION;
  generated_at: string;
  workflow: {
    run_id: string;
    run_attempt: number;
  };
  target: {
    repo: string;
    item_number: number;
    item_kind: "issue" | "pull_request";
    source_revision: string;
    context_digest: string;
    pull_head_sha: string | null;
  };
  source: {
    comment_id: string;
    comment_url: string;
    author: string;
    digest: string | null;
  };
  request: {
    sha256: string;
    mode: AssistMode;
    lens: string;
    reasoning_effort: string;
  };
  output: {
    answer: string;
  };
  idempotency_key: string;
}

export interface CreateAssistArtifactOptions {
  generatedAt: string;
  runId: string;
  runAttempt: number;
  itemKind: "issue" | "pull_request";
  sourceRevision: string;
  contextDigest: string;
  pullHeadSha: string | null;
  sourceDigest: string | null;
  request: AssistRequestBinding;
  answer: string;
}

export interface ExpectedAssistArtifact {
  runId: string;
  runAttempt: number;
  request: AssistRequestBinding;
}

export interface AssistLiveRevision {
  itemKind: "issue" | "pull_request";
  sourceRevision: string;
  contextDigest: string;
  pullHeadSha: string | null;
  sourceDigest: string | null;
}

export function assistRequestSha256(request: AssistRequestBinding): string {
  return sha256(
    JSON.stringify({
      target_repo: request.targetRepo,
      item_number: request.itemNumber,
      question: request.question,
      mode: request.mode,
      lens: request.lens,
      source_comment_id: request.sourceCommentId,
      source_comment_url: request.sourceCommentUrl,
      author: request.author,
      reasoning_effort: request.reasoningEffort,
    }),
  );
}

export function assistSourceCommentSha256(comment: {
  id: string;
  issueUrl: string;
  htmlUrl: string;
  author: string;
  body: string;
  updatedAt: string;
}): string {
  return sha256(
    JSON.stringify({
      id: comment.id,
      issue_url: comment.issueUrl,
      html_url: comment.htmlUrl,
      author: comment.author,
      body: comment.body,
      updated_at: comment.updatedAt,
    }),
  );
}

export function createAssistArtifact(options: CreateAssistArtifactOptions): AssistArtifact {
  const requestSha = assistRequestSha256(options.request);
  const idempotencyKey = assistIdempotencyKey({
    targetRepo: options.request.targetRepo,
    itemNumber: options.request.itemNumber,
    itemKind: options.itemKind,
    sourceCommentId: options.request.sourceCommentId,
    sourceCommentUrl: options.request.sourceCommentUrl,
    author: options.request.author,
    mode: options.request.mode,
    lens: options.request.lens,
    reasoningEffort: options.request.reasoningEffort,
    requestSha,
  });
  return validateAssistArtifact({
    schema_version: ASSIST_ARTIFACT_SCHEMA_VERSION,
    generated_at: options.generatedAt,
    workflow: {
      run_id: options.runId,
      run_attempt: options.runAttempt,
    },
    target: {
      repo: options.request.targetRepo,
      item_number: options.request.itemNumber,
      item_kind: options.itemKind,
      source_revision: options.sourceRevision,
      context_digest: options.contextDigest,
      pull_head_sha: options.pullHeadSha,
    },
    source: {
      comment_id: options.request.sourceCommentId,
      comment_url: options.request.sourceCommentUrl,
      author: options.request.author,
      digest: options.sourceDigest,
    },
    request: {
      sha256: requestSha,
      mode: options.request.mode,
      lens: options.request.lens,
      reasoning_effort: options.request.reasoningEffort,
    },
    output: {
      answer: options.answer,
    },
    idempotency_key: idempotencyKey,
  });
}

export function parseAssistArtifact(
  text: string,
  expected?: ExpectedAssistArtifact,
): AssistArtifact {
  if (Buffer.byteLength(text, "utf8") > ASSIST_ARTIFACT_MAX_BYTES) {
    throw new Error(`assist artifact exceeds ${ASSIST_ARTIFACT_MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("assist artifact is not valid JSON");
  }
  const artifact = validateAssistArtifact(parsed);
  if (expected) validateExpectedAssistArtifact(artifact, expected);
  return artifact;
}

export function assertAssistArtifactLiveRevision(
  artifact: AssistArtifact,
  live: AssistLiveRevision,
): void {
  if (live.itemKind !== artifact.target.item_kind) {
    throw new Error("assist target kind changed after generation");
  }
  if (live.sourceRevision !== artifact.target.source_revision) {
    throw new Error("assist target source changed after generation; refusing stale publication");
  }
  if (live.contextDigest !== artifact.target.context_digest) {
    throw new Error("assist prompt context changed after generation; refusing stale publication");
  }
  if (live.pullHeadSha !== artifact.target.pull_head_sha) {
    throw new Error(
      "assist pull request head changed after generation; refusing stale publication",
    );
  }
  if (live.sourceDigest !== artifact.source.digest) {
    throw new Error("assist source comment changed after generation; refusing stale publication");
  }
}

export function validateAssistArtifact(value: unknown): AssistArtifact {
  const artifact = record(value, "assist artifact");
  exactKeys(artifact, [
    "schema_version",
    "generated_at",
    "workflow",
    "target",
    "source",
    "request",
    "output",
    "idempotency_key",
  ]);
  if (artifact.schema_version !== ASSIST_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported assist artifact schema version: ${String(artifact.schema_version)}`,
    );
  }
  const generatedAt = scalar(artifact.generated_at, "generated_at", 64);
  const generatedDate = new Date(generatedAt);
  const canonicalGeneratedAt = Number.isFinite(generatedDate.valueOf())
    ? generatedDate.toISOString()
    : "";
  if (
    !canonicalGeneratedAt ||
    (generatedAt !== canonicalGeneratedAt &&
      generatedAt !== canonicalGeneratedAt.replace(".000Z", "Z"))
  ) {
    throw new Error("generated_at must be a canonical ISO timestamp");
  }

  const workflow = record(artifact.workflow, "workflow");
  exactKeys(workflow, ["run_id", "run_attempt"]);
  const runId = digits(workflow.run_id, "workflow.run_id", 30);
  const runAttempt = positiveInteger(workflow.run_attempt, "workflow.run_attempt");

  const target = record(artifact.target, "target");
  exactKeys(target, [
    "repo",
    "item_number",
    "item_kind",
    "source_revision",
    "context_digest",
    "pull_head_sha",
  ]);
  const repo = scalar(target.repo, "target.repo", 201);
  if (!REPO_PATTERN.test(repo)) throw new Error("target.repo is invalid");
  const itemNumber = positiveInteger(target.item_number, "target.item_number");
  if (target.item_kind !== "issue" && target.item_kind !== "pull_request") {
    throw new Error("target.item_kind must be issue or pull_request");
  }
  const sourceRevision = digest(target.source_revision, "target.source_revision");
  const contextDigest = digest(target.context_digest, "target.context_digest");
  const pullHeadSha = nullableSha(target.pull_head_sha, "target.pull_head_sha");
  if (target.item_kind === "pull_request" && !pullHeadSha) {
    throw new Error("pull_request assist artifacts require target.pull_head_sha");
  }
  if (target.item_kind === "issue" && pullHeadSha !== null) {
    throw new Error("issue assist artifacts must not include target.pull_head_sha");
  }

  const source = record(artifact.source, "source");
  exactKeys(source, ["comment_id", "comment_url", "author", "digest"]);
  const commentId = optionalCommentId(source.comment_id, "source.comment_id");
  const commentUrl = scalar(source.comment_url, "source.comment_url", 1_000, true);
  const author = scalar(source.author, "source.author", 100, true);
  const sourceDigest = nullableDigest(source.digest, "source.digest");
  if (commentId && !sourceDigest) {
    throw new Error("source.digest is required when source.comment_id is present");
  }
  if (!commentId && sourceDigest) {
    throw new Error("source.digest requires source.comment_id");
  }

  const request = record(artifact.request, "request");
  exactKeys(request, ["sha256", "mode", "lens", "reasoning_effort"]);
  const requestSha = digest(request.sha256, "request.sha256");
  if (request.mode !== "assist" && request.mode !== "visual") {
    throw new Error("request.mode must be assist or visual");
  }
  const lens = scalar(request.lens, "request.lens", 32);
  if (!/^(?:auto|ux|flow|state|data|proof|risk|maintainer)$/.test(lens)) {
    throw new Error("request.lens is invalid");
  }
  const reasoningEffort = scalar(request.reasoning_effort, "request.reasoning_effort", 16);
  if (!/^(?:low|medium|high|xhigh)$/.test(reasoningEffort)) {
    throw new Error("request.reasoning_effort is invalid");
  }

  const output = record(artifact.output, "output");
  exactKeys(output, ["answer"]);
  const answer = scalar(output.answer, "output.answer", ASSIST_ANSWER_MAX_BYTES, false, true);
  if (!answer.trim()) throw new Error("output.answer must not be empty");
  if (CLAWSWEEPER_MARKER_PATTERN.test(answer)) {
    throw new Error("output.answer must not contain ClawSweeper control markers");
  }

  const idempotencyKey = digest(artifact.idempotency_key, "idempotency_key");
  const expectedIdempotencyKey = assistIdempotencyKey({
    targetRepo: repo,
    itemNumber,
    itemKind: target.item_kind,
    sourceCommentId: commentId,
    sourceCommentUrl: commentUrl,
    author,
    mode: request.mode,
    lens,
    reasoningEffort,
    requestSha,
  });
  if (idempotencyKey !== expectedIdempotencyKey) {
    throw new Error("assist artifact idempotency key does not match its bound inputs");
  }

  return {
    schema_version: ASSIST_ARTIFACT_SCHEMA_VERSION,
    generated_at: generatedAt,
    workflow: { run_id: runId, run_attempt: runAttempt },
    target: {
      repo,
      item_number: itemNumber,
      item_kind: target.item_kind,
      source_revision: sourceRevision,
      context_digest: contextDigest,
      pull_head_sha: pullHeadSha,
    },
    source: {
      comment_id: commentId,
      comment_url: commentUrl,
      author,
      digest: sourceDigest,
    },
    request: {
      sha256: requestSha,
      mode: request.mode,
      lens,
      reasoning_effort: reasoningEffort,
    },
    output: { answer },
    idempotency_key: idempotencyKey,
  };
}

function validateExpectedAssistArtifact(
  artifact: AssistArtifact,
  expected: ExpectedAssistArtifact,
): void {
  const expectedRunId = digits(expected.runId, "expected run id", 30);
  const expectedRunAttempt = positiveInteger(expected.runAttempt, "expected run attempt");
  if (
    artifact.workflow.run_id !== expectedRunId ||
    artifact.workflow.run_attempt !== expectedRunAttempt
  ) {
    throw new Error("assist artifact belongs to a different workflow run or attempt");
  }
  if (
    artifact.target.repo !== expected.request.targetRepo ||
    artifact.target.item_number !== expected.request.itemNumber
  ) {
    throw new Error("assist artifact target does not match the trusted workflow request");
  }
  if (artifact.request.sha256 !== assistRequestSha256(expected.request)) {
    throw new Error("assist artifact request does not match the trusted workflow request");
  }
  if (
    artifact.source.comment_id !== expected.request.sourceCommentId ||
    artifact.source.comment_url !== expected.request.sourceCommentUrl ||
    artifact.source.author !== expected.request.author ||
    artifact.request.mode !== expected.request.mode ||
    artifact.request.lens !== expected.request.lens ||
    artifact.request.reasoning_effort !== expected.request.reasoningEffort
  ) {
    throw new Error("assist artifact metadata does not match the trusted workflow request");
  }
}

function assistIdempotencyKey(options: {
  targetRepo: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  sourceCommentId: string;
  sourceCommentUrl: string;
  author: string;
  mode: AssistMode;
  lens: string;
  reasoningEffort: string;
  requestSha: string;
}): string {
  return sha256(
    JSON.stringify({
      target_repo: options.targetRepo,
      item_number: options.itemNumber,
      item_kind: options.itemKind,
      source_comment_id: options.sourceCommentId,
      source_comment_url: options.sourceCommentUrl,
      author: options.author,
      mode: options.mode,
      lens: options.lens,
      reasoning_effort: options.reasoningEffort,
      request_sha256: options.requestSha,
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`unexpected assist artifact fields: ${actual.join(", ")}`);
  }
}

function scalar(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty = false,
  allowNewlines = false,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} bytes`);
  }
  if (containsUnsupportedControlCharacter(value, allowNewlines)) {
    throw new Error(`${name} contains control characters`);
  }
  return value;
}

function containsUnsupportedControlCharacter(value: string, allowNewlines: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code >= 0x20) continue;
    if (allowNewlines && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    return true;
  }
  return false;
}

function digits(value: unknown, name: string, maxBytes: number): string {
  const text = scalar(value, name, maxBytes);
  if (!COMMENT_ID_PATTERN.test(text)) throw new Error(`${name} must contain decimal digits`);
  return text;
}

function optionalCommentId(value: unknown, name: string): string {
  if (value === "") return "";
  return digits(value, name, 30);
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function digest(value: unknown, name: string): string {
  const text = scalar(value, name, 64);
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return text;
}

function nullableDigest(value: unknown, name: string): string | null {
  return value === null ? null : digest(value, name);
}

function nullableSha(value: unknown, name: string): string | null {
  if (value === null) return null;
  const text = scalar(value, name, 40);
  if (!SHA_PATTERN.test(text)) throw new Error(`${name} must be a lowercase 40-character SHA`);
  return text;
}
