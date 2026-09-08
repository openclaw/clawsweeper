import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readReviewGit, reviewMergeBase } from "./pr-review-evidence.js";
import { AgentInputScanError, MAX_SCAN_BYTES } from "./agent-input-scan.js";
import { ReviewSourcePreparationError } from "./review-source-preparation.js";

const MAX_BLOB_SIZE_OBJECTS = 160;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_TREE_LIST_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_ATTRIBUTE_OUTPUT_BYTES = 16 * 1024 * 1024;
const REVIEW_ATTRIBUTE_PATH_BATCH_SIZE = 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
export const REVIEW_TREE_MAX_FILES = 200_000;
export const REVIEW_TREE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const REVIEW_TREE_DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
export const REVIEW_TREE_WORKING_COPY_EXPANSION_FACTOR = 2;

export interface ReviewTreeMaterializationBudget {
  maxFiles: number;
  maxBytes: number;
  diskReserveBytes: number;
  availableBytes?: number;
}

export interface ReviewTreeMetadata {
  paths: string[];
  blobBytes: bigint;
}

interface ReviewTreeMaterializationOptions {
  targetDir: string;
  worktreeDir: string;
  itemNumber: number;
  headSha: string;
}

type ReviewGitFailureReason =
  | "review_commit_fetch_failed"
  | "review_checkout_failed"
  | "review_git_inspection_failed"
  | "review_blobs_unavailable";

export class ReviewGitError extends ReviewSourcePreparationError {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly errorCode: string | null;
  readonly stderr: string;

  constructor(
    diagnosticReason: ReviewGitFailureReason,
    result: SpawnSyncReturns<string> | (Error & Partial<SpawnSyncReturns<string>>),
  ) {
    // Public errors omit process output; the diagnostic writer owns its redaction.
    super(diagnosticReason, "Review source preparation failed.");
    this.name = "ReviewGitError";
    this.cause = result instanceof Error ? result : result.error;
    this.status = result.status ?? null;
    this.signal = result.signal ?? null;
    this.errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? null;
    this.stderr = result.stderr ?? "";
  }
}

function checkedReviewGit(
  result: SpawnSyncReturns<string>,
  reason: ReviewGitFailureReason,
): string {
  if (result.error || result.status !== 0) throw new ReviewGitError(reason, result);
  return result.stdout;
}

function gitCommitExists(targetDir: string, sha: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: targetDir,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
      stdio: "ignore",
    }).status === 0
  );
}

function gitRepositoryIsShallow(targetDir: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return checkedReviewGit(result, "review_git_inspection_failed").trim() === "true";
}

export function ensureReviewTreeCommit({
  targetDir,
  sha,
  sourceRef,
  destinationRef,
}: {
  targetDir: string;
  sha: string;
  sourceRef: string;
  destinationRef: string;
}): boolean {
  if (!GIT_OBJECT_ID.test(sha)) return false;
  const shallow = gitRepositoryIsShallow(targetDir);
  if (gitCommitExists(targetDir, sha) && !shallow) return true;
  const fetched = spawnSync(
    "git",
    [
      "fetch",
      "--force",
      "--filter=blob:none",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      ...(shallow ? ["--unshallow"] : []),
      "origin",
      `${sourceRef}:${destinationRef}`,
    ],
    {
      cwd: targetDir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 30_000,
    },
  );
  checkedReviewGit(fetched, "review_commit_fetch_failed");
  return gitCommitExists(targetDir, sha) && !gitRepositoryIsShallow(targetDir);
}

export function ensurePullRequestReviewHead({
  targetDir,
  itemNumber,
  headSha,
}: {
  targetDir: string;
  itemNumber: number;
  headSha: string;
}): boolean {
  if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0) return false;
  const destinationRef = `refs/clawsweeper/review-cache/head-${itemNumber}`;
  let failure: ReviewGitError | undefined;
  // A ref may move or disappear after REST hydration. Only the pinned object
  // decides success, and failure of the ref fetch must still permit the exact fetch.
  for (const sourceRef of [`refs/pull/${itemNumber}/head`, headSha]) {
    try {
      if (
        ensureReviewTreeCommit({
          targetDir,
          sha: headSha,
          sourceRef,
          destinationRef,
        })
      ) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof ReviewGitError)) throw error;
      error.reviewedHeadSha = headSha;
      failure = error;
    }
  }
  if (failure) throw failure;
  return false;
}

export function hydratePullRequestReviewHistory(options: {
  targetDir: string;
  baseSha: string;
  headSha: string;
  itemNumber: number;
  testMergeSha?: string;
}): string | null {
  const { targetDir, baseSha, headSha, itemNumber, testMergeSha } = options;
  if (
    !GIT_OBJECT_ID.test(baseSha) ||
    !GIT_OBJECT_ID.test(headSha) ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber <= 0
  )
    return null;
  if (testMergeSha && GIT_OBJECT_ID.test(testMergeSha)) {
    try {
      ensureReviewTreeCommit({
        targetDir,
        sha: testMergeSha,
        sourceRef: `refs/pull/${itemNumber}/merge`,
        destinationRef: `refs/clawsweeper/review-cache/merge-${itemNumber}`,
      });
    } catch (error) {
      // Test-merge evidence is optional; required base/head acquisition owns admission.
      if (!(error instanceof ReviewGitError)) throw error;
    }
  }
  const mergeBase = reviewMergeBase(targetDir, baseSha, headSha);
  if (mergeBase.status === "ambiguous") throw new AgentInputScanError("incomplete_source");
  return mergeBase.sha;
}

function reviewTreeMatchesCommit({ targetDir, sha }: { targetDir: string; sha: string }): boolean {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (
    checkedReviewGit(head, "review_git_inspection_failed").trim().toLowerCase() !==
    sha.toLowerCase()
  ) {
    return false;
  }
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return checkedReviewGit(status, "review_git_inspection_failed").trim() === "";
}

function reviewTreeBudgetError(headSha: string, detail: string): ReviewSourcePreparationError {
  const error = new ReviewSourcePreparationError(
    "review_checkout_unavailable",
    `Review checkout exceeds its private workspace budget: ${detail}.`,
  );
  error.reviewedHeadSha = headSha;
  return error;
}

function reviewTreeMetadata(targetDir: string, headSha: string): ReviewTreeMetadata {
  const result = spawnSync("git", ["ls-tree", "-r", "-l", "-z", "--full-tree", headSha], {
    cwd: targetDir,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    maxBuffer: MAX_REVIEW_TREE_LIST_BYTES,
  });
  const output = checkedReviewGit(result, "review_git_inspection_failed");
  if (!output) return { paths: [], blobBytes: 0n };
  if (output.includes("\uFFFD")) {
    throw reviewTreeBudgetError(headSha, "Git returned non-UTF-8 checkout metadata");
  }
  if (!output.endsWith("\0")) {
    throw new ReviewGitError("review_git_inspection_failed", {
      ...result,
      status: 1,
      stderr: "git ls-tree returned an incomplete path list",
    });
  }
  const entries = output.slice(0, -1).split("\0");
  const paths: string[] = [];
  let blobBytes = 0n;
  for (const entry of entries) {
    const match =
      /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?) +(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) {
      throw reviewTreeBudgetError(headSha, "Git returned malformed checkout size metadata");
    }
    paths.push(match[5]!);
    if (match[2] !== "blob") continue;
    if (match[4] === "-") {
      throw reviewTreeBudgetError(
        headSha,
        `blob size metadata is unavailable for ${JSON.stringify(match[5])}`,
      );
    }
    blobBytes += BigInt(match[4]!);
  }
  return { paths, blobBytes };
}

function assertReviewTreeHasBoundedTransforms(
  targetDir: string,
  headSha: string,
  paths: readonly string[],
): void {
  for (let offset = 0; offset < paths.length; offset += REVIEW_ATTRIBUTE_PATH_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + REVIEW_ATTRIBUTE_PATH_BATCH_SIZE);
    const result = spawnSync(
      "git",
      [
        "check-attr",
        `--source=${headSha}`,
        "--stdin",
        "-z",
        "filter",
        "working-tree-encoding",
        "ident",
      ],
      {
        cwd: targetDir,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
        encoding: "utf8",
        input: `${batch.join("\0")}\0`,
        maxBuffer: MAX_REVIEW_ATTRIBUTE_OUTPUT_BYTES,
      },
    );
    const output = checkedReviewGit(result, "review_git_inspection_failed");
    if (output.includes("\uFFFD")) {
      throw reviewTreeBudgetError(headSha, "Git returned non-UTF-8 checkout attribute metadata");
    }
    if (!output.endsWith("\0")) {
      throw reviewTreeBudgetError(headSha, "Git returned incomplete checkout attribute metadata");
    }
    const fields = output.slice(0, -1).split("\0");
    if (fields.length !== batch.length * 9) {
      throw reviewTreeBudgetError(headSha, "Git returned malformed checkout attribute metadata");
    }
    for (let index = 0; index < fields.length; index += 3) {
      const path = fields[index]!;
      const attribute = fields[index + 1]!;
      const value = fields[index + 2]!;
      if (value !== "unspecified" && value !== "unset") {
        throw reviewTreeBudgetError(
          headSha,
          `${JSON.stringify(path)} enables unbounded ${attribute}=${JSON.stringify(value)} checkout transformation`,
        );
      }
    }
  }
}

function reviewTreeTotals(
  root: string,
  limits: ReviewTreeMaterializationBudget,
): {
  files: number;
  bytes: number;
} {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory)) {
      if (directory === root && name === ".git") continue;
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile() || metadata.isSymbolicLink()) {
        files += 1;
        bytes += metadata.size;
      } else {
        return { files: limits.maxFiles + 1, bytes: limits.maxBytes + 1 };
      }
      if (files > limits.maxFiles || bytes > limits.maxBytes) return { files, bytes };
    }
  }
  return { files, bytes };
}

function materializePullRequestReviewTreeWithBudget(
  { targetDir, worktreeDir, itemNumber, headSha }: ReviewTreeMaterializationOptions,
  budget: ReviewTreeMaterializationBudget,
  metadataOverride?: ReviewTreeMetadata,
): boolean {
  if (!ensurePullRequestReviewHead({ targetDir, itemNumber, headSha })) return false;
  if (existsSync(worktreeDir)) return false;
  const metadata = metadataOverride ?? reviewTreeMetadata(targetDir, headSha);
  if (metadata.paths.length > budget.maxFiles) {
    throw reviewTreeBudgetError(
      headSha,
      `${metadata.paths.length} tracked paths exceed the ${budget.maxFiles}-file limit`,
    );
  }
  const projectedBytes = metadata.blobBytes * BigInt(REVIEW_TREE_WORKING_COPY_EXPANSION_FACTOR);
  if (projectedBytes > BigInt(budget.maxBytes)) {
    throw reviewTreeBudgetError(
      headSha,
      `${projectedBytes} conservatively projected bytes exceed the ${budget.maxBytes}-byte limit`,
    );
  }
  assertReviewTreeHasBoundedTransforms(targetDir, headSha, metadata.paths);
  const availableBytes =
    budget.availableBytes ??
    (() => {
      const fileSystem = statfsSync(dirname(worktreeDir));
      return fileSystem.bavail * fileSystem.bsize;
    })();
  const requiredBytes = projectedBytes + BigInt(budget.diskReserveBytes);
  if (BigInt(availableBytes) < requiredBytes) {
    throw reviewTreeBudgetError(
      headSha,
      `${availableBytes} available bytes cannot admit ${projectedBytes} projected checkout bytes plus the ${budget.diskReserveBytes}-byte reserve`,
    );
  }
  const worktree = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      "--force",
      worktreeDir,
      headSha,
    ],
    {
      cwd: targetDir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  checkedReviewGit(worktree, "review_checkout_failed");
  const totals = reviewTreeTotals(worktreeDir, budget);
  if (totals.files > budget.maxFiles || totals.bytes > budget.maxBytes) {
    removePullRequestReviewTree({ targetDir, worktreeDir });
    throw reviewTreeBudgetError(
      headSha,
      `${totals.files} files and ${totals.bytes} bytes exceed the ${budget.maxFiles}-file or ${budget.maxBytes}-byte limit`,
    );
  }
  return reviewTreeMatchesCommit({ targetDir: worktreeDir, sha: headSha });
}

export function materializePullRequestReviewTree(
  options: ReviewTreeMaterializationOptions,
): boolean {
  return materializePullRequestReviewTreeWithBudget(options, {
    maxFiles: REVIEW_TREE_MAX_FILES,
    maxBytes: REVIEW_TREE_MAX_BYTES,
    diskReserveBytes: REVIEW_TREE_DISK_RESERVE_BYTES,
  });
}

export function materializePullRequestReviewTreeForTest(
  options: ReviewTreeMaterializationOptions,
  budget: ReviewTreeMaterializationBudget,
  metadataOverride?: ReviewTreeMetadata,
): boolean {
  return materializePullRequestReviewTreeWithBudget(options, budget, metadataOverride);
}

export function removePullRequestReviewTree({
  targetDir,
  worktreeDir,
}: {
  targetDir: string;
  worktreeDir: string;
}): boolean {
  if (!existsSync(worktreeDir)) return true;
  const removed = spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
    cwd: targetDir,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: "ignore",
  });
  return !removed.error && removed.status === 0 && !existsSync(worktreeDir);
}

export function hydratePullRequestReviewBlobs({
  targetDir,
  baseSha,
  headSha,
  resolveBlobSizes,
}: {
  targetDir: string;
  baseSha: string;
  headSha: string;
  resolveBlobSizes?: (objectIds: readonly string[]) => ReadonlyMap<string, number>;
}): number {
  if (!GIT_OBJECT_ID.test(baseSha) || !GIT_OBJECT_ID.test(headSha)) {
    throw new AgentInputScanError("incomplete_source");
  }
  const deadlineAt = Date.now() + 30_000;
  const readOptions = { deadlineAt, maxBytes: MAX_GIT_OUTPUT_BYTES };
  const raw = readReviewGit(
    targetDir,
    [
      "diff",
      "--raw",
      "--no-abbrev",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      baseSha,
      headSha,
      "--",
    ],
    readOptions,
  );
  if (!raw) {
    throw new AgentInputScanError(Date.now() >= deadlineAt ? "deadline" : "incomplete_source");
  }
  let fields: string[];
  try {
    fields = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
  } catch {
    throw new AgentInputScanError("incomplete_source");
  }
  if (fields.pop() !== "" || fields.length % 2 !== 0) {
    throw new AgentInputScanError("incomplete_source");
  }
  const paths = new Set<string>();
  const objectIds = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [AMDT]$/.exec(
      fields[index]!,
    );
    const path = safeReviewPath(fields[index + 1]);
    if (!match) throw new AgentInputScanError("incomplete_source");
    if (!path) throw new AgentInputScanError("unsafe_path");
    paths.add(path);
    for (const [mode, oid] of [
      [match[1]!, match[3]!],
      [match[2]!, match[4]!],
    ]) {
      // Gitlinks are not blobs; the scanner still refuses changed gitlinks.
      if (mode === "000000" || mode === "160000") continue;
      if (!["100644", "100755", "120000"].includes(mode!)) {
        throw new AgentInputScanError("unsupported_content");
      }
      objectIds.add(oid!);
    }
  }

  if (objectIds.size === 0) return 0;
  // Git before 2.45 exits without batch output when GIT_NO_LAZY_FETCH blocks a promisor fetch.
  // Traverse only the two commit trees: this emits their blobs without walking either history.
  // rev-list's missing-object mode suppresses lazy fetches and reports them on older clients too.
  const objectAvailability = spawnSync(
    "git",
    [
      "--literal-pathspecs",
      "rev-list",
      "--objects",
      "--missing=print",
      `${baseSha}^{tree}`,
      `${headSha}^{tree}`,
      "--",
      ...paths,
    ],
    {
      cwd: targetDir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: Math.max(1, deadlineAt - Date.now()),
    },
  );
  if (objectAvailability.error || objectAvailability.status !== 0) {
    throw new AgentInputScanError(Date.now() >= deadlineAt ? "deadline" : "incomplete_source");
  }
  const observed = new Set<string>();
  const missing = new Set<string>();
  for (const entry of objectAvailability.stdout.split("\n")) {
    const match = entry.match(/^(\??)([0-9a-f]{40,64})(?: |$)/i);
    if (!match || !objectIds.has(match[2]!)) continue;
    observed.add(match[2]!);
    if (match[1] === "?") missing.add(match[2]!);
  }
  if (observed.size !== objectIds.size) throw new AgentInputScanError("incomplete_source");

  const sizes = new Map<string, number>();
  const localObjectIds = [...objectIds].filter((objectId) => !missing.has(objectId));
  if (localObjectIds.length > 0) {
    const localObjects = readReviewGit(
      targetDir,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { ...readOptions, input: Buffer.from(`${localObjectIds.join("\n")}\n`) },
    );
    if (!localObjects) {
      throw new AgentInputScanError(Date.now() >= deadlineAt ? "deadline" : "incomplete_source");
    }
    const found = localObjects.toString().trim().split("\n");
    if (found.length !== localObjectIds.length) throw new AgentInputScanError("incomplete_source");
    for (const entry of found) {
      const [objectId, type, size] = entry.split(" ");
      if (!objectId || !objectIds.has(objectId) || type !== "blob") {
        throw new AgentInputScanError("incomplete_source");
      }
      sizes.set(objectId, Number(size));
    }
  }
  if (missing.size > 0) {
    if (!resolveBlobSizes) throwBlobMetadataUnavailable();
    let remoteSizes: ReadonlyMap<string, number>;
    try {
      remoteSizes = resolveBlobSizes([...missing]);
    } catch (error) {
      if (error instanceof AgentInputScanError) throw error;
      throwBlobMetadataUnavailable();
    }
    for (const objectId of missing) {
      const bytes = remoteSizes.get(objectId);
      if (bytes === undefined) throwBlobMetadataUnavailable();
      sizes.set(objectId, bytes);
    }
  }

  let objectBytes = 0;
  for (const objectId of objectIds) {
    const bytes = sizes.get(objectId);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
      throwBlobMetadataUnavailable();
    }
    if (bytes > MAX_SCAN_BYTES - objectBytes) throw new AgentInputScanError("staging_limit");
    objectBytes += bytes;
  }

  if (Date.now() >= deadlineAt) throw new AgentInputScanError("deadline");
  if (missing.size > 0) {
    const fetched = spawnSync(
      "git",
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      {
        cwd: targetDir,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        input: `${[...missing].join("\n")}\n`,
        timeout: Math.max(1, deadlineAt - Date.now()),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
    );
    if (fetched.error || fetched.status !== 0) {
      if (Date.now() >= deadlineAt) throw new AgentInputScanError("deadline");
      throw new ReviewGitError("review_blobs_unavailable", fetched);
    }
  }
  return objectIds.size;
}

function throwBlobMetadataUnavailable(): never {
  throw new ReviewSourcePreparationError(
    "review_blob_metadata_unavailable",
    "Could not obtain complete review blob size metadata.",
  );
}

export function githubReviewBlobSizes({
  repository,
  objectIds,
  request,
}: {
  repository: string;
  objectIds: readonly string[];
  request: (query: string) => unknown;
}): ReadonlyMap<string, number> {
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("invalid bounded review blob metadata request");
  }
  if (objectIds.some((objectId) => !GIT_OBJECT_ID.test(objectId))) {
    throw new Error("invalid review blob object ID");
  }
  const result = new Map<string, number>();
  const deadlineAt = Date.now() + 30_000;
  for (let offset = 0; offset < objectIds.length; offset += MAX_BLOB_SIZE_OBJECTS) {
    if (Date.now() >= deadlineAt) throw new AgentInputScanError("deadline");
    const batch = objectIds.slice(offset, offset + MAX_BLOB_SIZE_OBJECTS);
    const objects = batch.map(
      (objectId, index) => `b${index}: object(oid: "${objectId}") { ... on Blob { byteSize } }`,
    );
    const query = `query { repository(owner: "${match[1]}", name: "${match[2]}") { ${objects.join(" ")} } }`;
    const response = request(query);
    if (!response || typeof response !== "object") throw new Error("invalid review blob response");
    const data = (response as { data?: unknown }).data;
    if (!data || typeof data !== "object") throw new Error("missing review blob response data");
    const values = (data as { repository?: unknown }).repository;
    if (!values || typeof values !== "object") throw new Error("missing review blob repository");
    for (const [index, objectId] of batch.entries()) {
      const object = (values as Record<string, unknown>)[`b${index}`];
      const bytes =
        object && typeof object === "object" ? (object as { byteSize?: unknown }).byteSize : null;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("invalid review blob size");
      }
      result.set(objectId, bytes);
    }
  }
  return result;
}

function safeReviewPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    return null;
  }
  return value;
}
