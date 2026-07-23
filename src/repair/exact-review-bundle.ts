import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EXACT_REVIEW_BUNDLE_SCHEMA_VERSION = 1 as const;
export const EXACT_REVIEW_BUNDLE_MAX_FILES = 512;
export const EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9_./-]{1,255}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ITEM_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9]\d*$/;
const FILE_PATH_PATTERN = /^(?:review\/[1-9]\d*\.md|action-ledger\/ledger\/[A-Za-z0-9_./-]+)$/;

export interface ExactReviewBundleContext {
  repository: string;
  sourceSha: string;
  runId: string;
  runAttempt: number;
  producerJob: string;
  decisionSha256: string;
  targetRepo: string;
  targetBranch: string;
  itemNumber: number;
  itemKind: "issue" | "pull_request";
  itemKey: string;
  protocolVersion: 1 | 2;
  leaseRevision: number | null;
  claimGeneration: number | null;
  liveProceeded: boolean;
  liveTerminalNoop: boolean;
  liveTerminalMissing: boolean;
  liveGuardedOpen: boolean;
}

export interface ExactReviewBundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ExactReviewBundleManifest {
  schema_version: typeof EXACT_REVIEW_BUNDLE_SCHEMA_VERSION;
  created_at: string;
  workflow: {
    repository: string;
    source_sha: string;
    run_id: string;
    run_attempt: number;
    producer_job: string;
  };
  queue: {
    item_key: string;
    protocol_version: 1 | 2;
    lease_revision: number | null;
    claim_generation: number | null;
  };
  target: {
    repo: string;
    branch: string;
    item_number: number;
    item_kind: "issue" | "pull_request";
  };
  review: {
    decision_sha256: string;
    live_proceeded: boolean;
    live_terminal_noop: boolean;
    live_terminal_missing: boolean;
    live_guarded_open: boolean;
    artifact_present: boolean;
  };
  files: ExactReviewBundleFile[];
}

export interface CreateExactReviewBundleOptions {
  bundleDir: string;
  reviewPath?: string;
  actionLedgerRoot?: string;
  createdAt: string;
  context: ExactReviewBundleContext;
}

export function exactReviewDecisionSha256(decisionJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(decisionJson);
  } catch {
    throw new Error("exact review decision is not valid JSON");
  }
  return sha256(canonicalJson(value));
}

export function createExactReviewBundle(
  options: CreateExactReviewBundleOptions,
): ExactReviewBundleManifest {
  const context = validateContext(options.context);
  const bundleDir = path.resolve(options.bundleDir);
  fs.rmSync(bundleDir, { force: true, recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  let artifactPresent = false;
  if (options.reviewPath && fs.existsSync(options.reviewPath)) {
    const reviewDestination = path.join(bundleDir, "review", `${context.itemNumber}.md`);
    copyRegularFile(options.reviewPath, reviewDestination);
    artifactPresent = true;
  }
  if (options.actionLedgerRoot && fs.existsSync(options.actionLedgerRoot)) {
    copyTree(options.actionLedgerRoot, path.join(bundleDir, "action-ledger"));
  }

  const files = collectBundleFiles(bundleDir);
  if (context.liveProceeded && !artifactPresent) {
    throw new Error("a proceeded exact review bundle requires a review artifact");
  }
  const manifest = validateManifest({
    schema_version: EXACT_REVIEW_BUNDLE_SCHEMA_VERSION,
    created_at: canonicalTimestamp(options.createdAt),
    workflow: {
      repository: context.repository,
      source_sha: context.sourceSha,
      run_id: context.runId,
      run_attempt: context.runAttempt,
      producer_job: context.producerJob,
    },
    queue: {
      item_key: context.itemKey,
      protocol_version: context.protocolVersion,
      lease_revision: context.leaseRevision,
      claim_generation: context.claimGeneration,
    },
    target: {
      repo: context.targetRepo,
      branch: context.targetBranch,
      item_number: context.itemNumber,
      item_kind: context.itemKind,
    },
    review: {
      decision_sha256: context.decisionSha256,
      live_proceeded: context.liveProceeded,
      live_terminal_noop: context.liveTerminalNoop,
      live_terminal_missing: context.liveTerminalMissing,
      live_guarded_open: context.liveGuardedOpen,
      artifact_present: artifactPresent,
    },
    files,
  });
  fs.writeFileSync(
    path.join(bundleDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return manifest;
}

export function validateExactReviewBundle(
  bundleDirInput: string,
  expected: ExactReviewBundleContext,
): ExactReviewBundleManifest {
  const bundleDir = path.resolve(bundleDirInput);
  const manifestPath = path.join(bundleDir, "manifest.json");
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("exact review bundle manifest must be a regular file");
  }
  if (stat.size > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
    throw new Error("exact review bundle manifest is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("exact review bundle manifest is not valid JSON");
  }
  const manifest = validateManifest(parsed);
  const context = validateContext(expected);
  assertExpectedManifest(manifest, context);

  const actualFiles = collectBundleFiles(bundleDir);
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files)) {
    throw new Error("exact review bundle file inventory does not match its manifest");
  }
  const expectedReviewPath = `review/${context.itemNumber}.md`;
  const hasReview = actualFiles.some((file) => file.path === expectedReviewPath);
  if (hasReview !== manifest.review.artifact_present) {
    throw new Error("exact review bundle review artifact presence does not match its manifest");
  }
  return manifest;
}

function assertExpectedManifest(
  manifest: ExactReviewBundleManifest,
  expected: ExactReviewBundleContext,
): void {
  const actual = {
    repository: manifest.workflow.repository,
    sourceSha: manifest.workflow.source_sha,
    runId: manifest.workflow.run_id,
    runAttempt: manifest.workflow.run_attempt,
    producerJob: manifest.workflow.producer_job,
    decisionSha256: manifest.review.decision_sha256,
    targetRepo: manifest.target.repo,
    targetBranch: manifest.target.branch,
    itemNumber: manifest.target.item_number,
    itemKind: manifest.target.item_kind,
    itemKey: manifest.queue.item_key,
    protocolVersion: manifest.queue.protocol_version,
    leaseRevision: manifest.queue.lease_revision,
    claimGeneration: manifest.queue.claim_generation,
    liveProceeded: manifest.review.live_proceeded,
    liveTerminalNoop: manifest.review.live_terminal_noop,
    liveTerminalMissing: manifest.review.live_terminal_missing,
    liveGuardedOpen: manifest.review.live_guarded_open,
  } satisfies ExactReviewBundleContext;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("exact review bundle does not match the trusted workflow context");
  }
}

function validateContext(value: ExactReviewBundleContext): ExactReviewBundleContext {
  if (!REPO_PATTERN.test(value.repository)) throw new Error("repository is invalid");
  if (!SHA_PATTERN.test(value.sourceSha)) throw new Error("source SHA is invalid");
  if (!/^\d{1,30}$/.test(value.runId)) throw new Error("run ID is invalid");
  positiveInteger(value.runAttempt, "run attempt");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value.producerJob)) {
    throw new Error("producer job is invalid");
  }
  if (!SHA256_PATTERN.test(value.decisionSha256)) {
    throw new Error("decision digest is invalid");
  }
  if (!REPO_PATTERN.test(value.targetRepo)) throw new Error("target repository is invalid");
  if (!BRANCH_PATTERN.test(value.targetBranch) || value.targetBranch.includes("..")) {
    throw new Error("target branch is invalid");
  }
  positiveInteger(value.itemNumber, "item number");
  if (value.itemKind !== "issue" && value.itemKind !== "pull_request") {
    throw new Error("item kind is invalid");
  }
  if (!ITEM_KEY_PATTERN.test(value.itemKey)) throw new Error("item key is invalid");
  if (value.itemKey !== `${value.targetRepo}#${value.itemNumber}`) {
    throw new Error("item key does not match the target");
  }
  if (value.protocolVersion !== 1 && value.protocolVersion !== 2) {
    throw new Error("queue protocol version is invalid");
  }
  nullablePositiveInteger(value.leaseRevision, "lease revision");
  nullablePositiveInteger(value.claimGeneration, "claim generation");
  if (
    value.protocolVersion === 2 &&
    (value.leaseRevision === null || value.claimGeneration === null)
  ) {
    throw new Error("queue protocol v2 requires the full claim tuple");
  }
  for (const [label, flag] of [
    ["live proceeded", value.liveProceeded],
    ["live terminal noop", value.liveTerminalNoop],
    ["live terminal missing", value.liveTerminalMissing],
    ["live guarded open", value.liveGuardedOpen],
  ] as const) {
    if (typeof flag !== "boolean") throw new Error(`${label} must be boolean`);
  }
  const liveOutcomes = [
    value.liveProceeded,
    value.liveTerminalNoop,
    value.liveTerminalMissing,
    value.liveGuardedOpen,
  ].filter(Boolean).length;
  if (liveOutcomes !== 1) throw new Error("exact review bundle requires one live outcome");
  return { ...value };
}

function validateManifest(value: unknown): ExactReviewBundleManifest {
  const manifest = record(value, "manifest");
  exactKeys(manifest, [
    "schema_version",
    "created_at",
    "workflow",
    "queue",
    "target",
    "review",
    "files",
  ]);
  if (manifest.schema_version !== EXACT_REVIEW_BUNDLE_SCHEMA_VERSION) {
    throw new Error("unsupported exact review bundle schema version");
  }
  const createdAt = canonicalTimestamp(stringValue(manifest.created_at, "created_at"));

  const workflow = record(manifest.workflow, "workflow");
  exactKeys(workflow, ["repository", "source_sha", "run_id", "run_attempt", "producer_job"]);
  const queue = record(manifest.queue, "queue");
  exactKeys(queue, ["item_key", "protocol_version", "lease_revision", "claim_generation"]);
  const target = record(manifest.target, "target");
  exactKeys(target, ["repo", "branch", "item_number", "item_kind"]);
  const review = record(manifest.review, "review");
  exactKeys(review, [
    "decision_sha256",
    "live_proceeded",
    "live_terminal_noop",
    "live_terminal_missing",
    "live_guarded_open",
    "artifact_present",
  ]);

  const context = validateContext({
    repository: stringValue(workflow.repository, "workflow.repository"),
    sourceSha: stringValue(workflow.source_sha, "workflow.source_sha"),
    runId: stringValue(workflow.run_id, "workflow.run_id"),
    runAttempt: numberValue(workflow.run_attempt, "workflow.run_attempt"),
    producerJob: stringValue(workflow.producer_job, "workflow.producer_job"),
    decisionSha256: stringValue(review.decision_sha256, "review.decision_sha256"),
    targetRepo: stringValue(target.repo, "target.repo"),
    targetBranch: stringValue(target.branch, "target.branch"),
    itemNumber: numberValue(target.item_number, "target.item_number"),
    itemKind: target.item_kind as "issue" | "pull_request",
    itemKey: stringValue(queue.item_key, "queue.item_key"),
    protocolVersion: queue.protocol_version as 1 | 2,
    leaseRevision: nullableNumber(queue.lease_revision, "queue.lease_revision"),
    claimGeneration: nullableNumber(queue.claim_generation, "queue.claim_generation"),
    liveProceeded: booleanValue(review.live_proceeded, "review.live_proceeded"),
    liveTerminalNoop: booleanValue(review.live_terminal_noop, "review.live_terminal_noop"),
    liveTerminalMissing: booleanValue(review.live_terminal_missing, "review.live_terminal_missing"),
    liveGuardedOpen: booleanValue(review.live_guarded_open, "review.live_guarded_open"),
  });
  const artifactPresent = booleanValue(review.artifact_present, "review.artifact_present");
  if (context.liveProceeded && !artifactPresent) {
    throw new Error("a proceeded exact review bundle requires a review artifact");
  }
  if (!Array.isArray(manifest.files)) throw new Error("manifest.files must be an array");
  if (manifest.files.length > EXACT_REVIEW_BUNDLE_MAX_FILES) {
    throw new Error("exact review bundle has too many files");
  }
  let totalBytes = 0;
  const files = manifest.files.map((entry, index) => {
    const file = record(entry, `files[${index}]`);
    exactKeys(file, ["path", "bytes", "sha256"]);
    const relativePath = stringValue(file.path, `files[${index}].path`);
    if (!FILE_PATH_PATTERN.test(relativePath) || relativePath.includes("..")) {
      throw new Error(`files[${index}].path is invalid`);
    }
    const bytes = numberValue(file.bytes, `files[${index}].bytes`);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
      throw new Error(`files[${index}].bytes is invalid`);
    }
    const digest = stringValue(file.sha256, `files[${index}].sha256`);
    if (!SHA256_PATTERN.test(digest)) throw new Error(`files[${index}].sha256 is invalid`);
    totalBytes += bytes;
    return { path: relativePath, bytes, sha256: digest };
  });
  if (totalBytes > EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES) {
    throw new Error("exact review bundle exceeds its total byte limit");
  }
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(sorted) !== JSON.stringify(files)) {
    throw new Error("exact review bundle files must be sorted");
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("exact review bundle contains duplicate file paths");
  }
  return {
    schema_version: EXACT_REVIEW_BUNDLE_SCHEMA_VERSION,
    created_at: createdAt,
    workflow: {
      repository: context.repository,
      source_sha: context.sourceSha,
      run_id: context.runId,
      run_attempt: context.runAttempt,
      producer_job: context.producerJob,
    },
    queue: {
      item_key: context.itemKey,
      protocol_version: context.protocolVersion,
      lease_revision: context.leaseRevision,
      claim_generation: context.claimGeneration,
    },
    target: {
      repo: context.targetRepo,
      branch: context.targetBranch,
      item_number: context.itemNumber,
      item_kind: context.itemKind,
    },
    review: {
      decision_sha256: context.decisionSha256,
      live_proceeded: context.liveProceeded,
      live_terminal_noop: context.liveTerminalNoop,
      live_terminal_missing: context.liveTerminalMissing,
      live_guarded_open: context.liveGuardedOpen,
      artifact_present: artifactPresent,
    },
    files,
  };
}

function collectBundleFiles(root: string): ExactReviewBundleFile[] {
  const files: ExactReviewBundleFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "manifest.json") continue;
      if (entry.isSymbolicLink()) throw new Error("exact review bundle must not contain symlinks");
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("exact review bundle contains a non-file entry");
      if (!FILE_PATH_PATTERN.test(relative) || relative.includes("..")) {
        throw new Error(`exact review bundle contains an unexpected path: ${relative}`);
      }
      const stat = fs.statSync(absolute);
      if (stat.size > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
        throw new Error(`exact review bundle file is too large: ${relative}`);
      }
      totalBytes += stat.size;
      if (totalBytes > EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES) {
        throw new Error("exact review bundle exceeds its total byte limit");
      }
      files.push({
        path: relative,
        bytes: stat.size,
        sha256: sha256(fs.readFileSync(absolute)),
      });
      if (files.length > EXACT_REVIEW_BUNDLE_MAX_FILES) {
        throw new Error("exact review bundle has too many files");
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function copyTree(sourceRoot: string, destinationRoot: string): void {
  const stat = fs.lstatSync(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("action ledger root must be a regular directory");
  }
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error("action ledger root must not contain symlinks");
    if (entry.isDirectory()) copyTree(source, destination);
    else if (entry.isFile()) copyRegularFile(source, destination);
    else throw new Error("action ledger root contains a non-file entry");
  }
}

function copyRegularFile(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("bundle source must be a regular file");
  if (stat.size > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) throw new Error("bundle source is too large");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("exact review decision contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("exact review decision contains an unsupported value");
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error("created_at must be an ISO timestamp");
  const canonical = parsed.toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
    throw new Error("created_at must be a canonical ISO timestamp");
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error("exact review bundle contains unexpected manifest fields");
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return numberValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} is invalid`);
}

function nullablePositiveInteger(value: number | null, label: string): void {
  if (value !== null) positiveInteger(value, label);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
