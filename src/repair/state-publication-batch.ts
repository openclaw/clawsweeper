import { mkdtempSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  measureGitProcesses,
  publishRoot,
  pushStateCommitUnderLease,
  runGit,
  spawnGit,
  withStatePublishLease,
  type GitProcessMeasurement,
  type StatePublishLeaseOptions,
} from "./git-publish.js";
import {
  validatePreparedStateMutationPlans,
  type PreparedStateMutationOperation,
  type PreparedStateMutationPlan,
} from "./state-publication-mutation.js";
import { clawsweeperGitIdentityEnv } from "./process-env.js";

export const STATE_PUBLICATION_BATCH_MAX_ITEMS = 32;
// Reuse the validated exact-review envelope per item while keeping aggregate
// cardinality and bytes proportional to the hard batch bound.
export const STATE_PUBLICATION_BATCH_MAX_PATHS = 32 * 512;
export const STATE_PUBLICATION_BATCH_MAX_BYTES = 32 * 16 * 1024 * 1024;
export const STATE_PUBLICATION_BATCH_MAX_PATH_BYTES = 128 * 1024;

const STATE_FETCH_TIMEOUT_MS = 60_000;
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_OID_PATTERN = /^[a-f0-9]{40,64}$/;

export class StateMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMutationConflictError";
  }
}

export type StateBatchCommitResult = {
  outcome: "committed" | "already_committed";
  commitSha: string;
  batchId: string;
  fingerprint: string;
  itemCount: number;
  pathCount: number;
  totalBytes: number;
  leaseHoldMs: number;
  git: GitProcessMeasurement;
};

export type StateBatchCommitHooks = {
  beforePush?: (commitSha: string) => void;
  afterPush?: (commitSha: string) => void;
};

export function commitPreparedStateBatch(options: {
  batchId: string;
  plans: readonly PreparedStateMutationPlan[];
  remote?: string;
  branch?: string;
  message?: string;
  lease?: Omit<StatePublishLeaseOptions, "remote" | "branch">;
  hooks?: StateBatchCommitHooks;
}): StateBatchCommitResult {
  if (!publishRoot()) {
    throw new Error("State publication batches require an isolated state publish root");
  }
  validateBatchId(options.batchId);
  const message = validateCommitSubject(options.message);
  const validated = validatePreparedStateMutationPlans(options.plans);
  const operations = validateAndCombinePlans(validated.plans, validated.totalBytes);
  const fingerprint = batchFingerprint(validated.plans);
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? process.env.CLAWSWEEPER_PUBLISH_BRANCH ?? "state";
  const measured = measureGitProcesses(() => {
    let leaseHoldMs = 0;
    const publication = withStatePublishLease(
      () => {
        const leaseStartedAt = Date.now();
        try {
          return commitUnderLease({
            ...options,
            plans: validated.plans,
            message,
            remote,
            branch,
            operations,
            fingerprint,
          });
        } finally {
          leaseHoldMs = Date.now() - leaseStartedAt;
        }
      },
      { ...options.lease, remote, branch },
    );
    return { publication, leaseHoldMs };
  });

  return {
    ...measured.result.publication,
    batchId: options.batchId,
    fingerprint,
    itemCount: validated.plans.length,
    pathCount: operations.length,
    totalBytes: validated.totalBytes,
    leaseHoldMs: measured.result.leaseHoldMs,
    git: measured.measurement,
  };
}

function commitUnderLease(options: {
  batchId: string;
  plans: readonly PreparedStateMutationPlan[];
  operations: readonly PreparedStateMutationOperation[];
  fingerprint: string;
  remote: string;
  branch: string;
  message: string;
  hooks?: StateBatchCommitHooks;
}): Pick<StateBatchCommitResult, "outcome" | "commitSha"> {
  const receiptRef = batchReceiptRef(options.batchId);
  const recovered = findBatchReceipt(options.remote, receiptRef, options.batchId);
  if (recovered) {
    if (recovered.fingerprint !== options.fingerprint) {
      throw new StateMutationConflictError(
        `Batch id ${options.batchId} is already bound to a different mutation fingerprint`,
      );
    }
    return { outcome: "already_committed", commitSha: recovered.commit };
  }

  const remoteRef = fetchLatestState(options.remote, options.branch);
  const remoteCommit = runGit(["rev-parse", remoteRef], { quiet: true }).trim();

  const remoteEntries = readRemoteEntries(
    remoteCommit,
    options.operations.map(({ path }) => path),
  );
  const pending = options.operations.filter((operation) => {
    const remoteEntry = remoteEntries.get(operation.path) ?? null;
    const remoteOid = remoteEntry?.oid ?? null;
    if (
      remoteOid === operation.targetOid &&
      (operation.targetOid === null || remoteEntry?.mode === operation.mode)
    ) {
      return false;
    }
    if (remoteOid !== operation.expectedOid) {
      throw new StateMutationConflictError(
        `Remote state path ${operation.path} changed after mutation preparation`,
      );
    }
    return true;
  });
  const remoteTree = runGit(["rev-parse", `${remoteCommit}^{tree}`], { quiet: true }).trim();
  // Even a content no-op needs a durable batch-id/fingerprint binding. A same-tree
  // marker commit lets a later ambiguous retry prove which payload this id owns.
  const tree = pending.length === 0 ? remoteTree : applyOperationsToTree(remoteTree, pending);
  const commitSha = runGit(["commit-tree", tree, "-p", remoteCommit], {
    env: { ...process.env, ...clawsweeperGitIdentityEnv() },
    input: batchCommitMessage(options),
    quiet: true,
  }).trim();
  options.hooks?.beforePush?.(commitSha);
  pushStateCommitUnderLease(commitSha, options.remote, options.branch, receiptRef);
  verifyRemoteCommit(options.remote, options.branch, receiptRef, commitSha);
  options.hooks?.afterPush?.(commitSha);
  return { outcome: "committed", commitSha };
}

function validateAndCombinePlans(
  plans: readonly PreparedStateMutationPlan[],
  totalBytes: number,
): PreparedStateMutationOperation[] {
  if (plans.length === 0) throw new Error("A state publication batch must contain an item");
  if (plans.length > STATE_PUBLICATION_BATCH_MAX_ITEMS) {
    throw new Error(`A state publication batch exceeds ${STATE_PUBLICATION_BATCH_MAX_ITEMS} items`);
  }
  const itemKeys = new Set<string>();
  const byPath = new Map<string, PreparedStateMutationOperation>();
  let totalPathBytes = 0;
  for (const plan of plans) {
    if (itemKeys.has(plan.identity.itemKey)) {
      throw new StateMutationConflictError(`Batch repeats item ${plan.identity.itemKey}`);
    }
    itemKeys.add(plan.identity.itemKey);
    for (const operation of plan.operations) {
      totalPathBytes += Buffer.byteLength(operation.path) + 1;
      const existing = byPath.get(operation.path);
      if (existing) {
        const identical =
          existing.expectedOid === operation.expectedOid &&
          existing.targetOid === operation.targetOid &&
          existing.mode === operation.mode;
        if (!identical) {
          throw new StateMutationConflictError(
            `Batch contains incompatible mutations for ${operation.path}`,
          );
        }
        continue;
      }
      byPath.set(operation.path, operation);
    }
  }
  if (byPath.size > STATE_PUBLICATION_BATCH_MAX_PATHS) {
    throw new Error(`A state publication batch exceeds ${STATE_PUBLICATION_BATCH_MAX_PATHS} paths`);
  }
  if (totalBytes > STATE_PUBLICATION_BATCH_MAX_BYTES) {
    throw new Error(`A state publication batch exceeds ${STATE_PUBLICATION_BATCH_MAX_BYTES} bytes`);
  }
  if (totalPathBytes > STATE_PUBLICATION_BATCH_MAX_PATH_BYTES) {
    throw new Error(
      `A state publication batch exceeds ${STATE_PUBLICATION_BATCH_MAX_PATH_BYTES} path bytes`,
    );
  }
  return [...byPath.values()].sort((left, right) => compareCanonicalText(left.path, right.path));
}

function fetchLatestState(remote: string, branch: string): string {
  runGit(["check-ref-format", `refs/heads/${branch}`], { quiet: true });
  const shallow = runGit(["rev-parse", "--is-shallow-repository"], { quiet: true }).trim();
  runGit(
    [
      "fetch",
      "--no-tags",
      ...(shallow === "true" ? ["--depth=1"] : []),
      remote,
      `refs/heads/${branch}`,
    ],
    { quiet: true, timeout: STATE_FETCH_TIMEOUT_MS },
  );
  return "FETCH_HEAD";
}

function findBatchReceipt(
  remote: string,
  receiptRef: string,
  batchId: string,
): { commit: string; fingerprint: string } | null {
  const advertised = spawnGit(["ls-remote", "--refs", remote, receiptRef], {
    quiet: true,
    timeout: STATE_FETCH_TIMEOUT_MS,
  });
  if (advertised.timedOut || advertised.status !== 0) {
    throw new Error(`Failed to inspect state batch receipt ${receiptRef}`);
  }
  const advertisedLine = advertised.stdout.trim();
  if (!advertisedLine) return null;
  const receiptCommit = advertisedLine.split(/\s+/, 1)[0];
  if (!receiptCommit || !GIT_OID_PATTERN.test(receiptCommit)) {
    throw new StateMutationConflictError(`State batch receipt ${receiptRef} is malformed`);
  }
  if (spawnGit(["cat-file", "-e", `${receiptCommit}^{commit}`], { quiet: true }).status !== 0) {
    runGit(["fetch", "--no-tags", "--depth=1", remote, receiptRef], {
      quiet: true,
      timeout: STATE_FETCH_TIMEOUT_MS,
    });
  }
  const output = runGit(
    [
      "show",
      "-s",
      "--format=%H%x00%(trailers:key=ClawSweeper-Batch-ID,valueonly)%x00%(trailers:key=ClawSweeper-Batch-Fingerprint,valueonly)%x00",
      receiptCommit,
    ],
    { quiet: true },
  );
  const [commit, receiptBatchId, fingerprint] = output.split("\0").map((field) => field.trim());
  if (
    !commit ||
    !GIT_OID_PATTERN.test(commit) ||
    receiptBatchId !== batchId ||
    !fingerprint ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  ) {
    throw new StateMutationConflictError(`State batch receipt ${receiptRef} is malformed`);
  }
  return { commit, fingerprint };
}

function readRemoteEntries(
  commit: string,
  paths: readonly string[],
): Map<string, { mode: "100644" | "100755"; oid: string }> {
  const output = runGit(
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", ...paths],
    { quiet: true },
  );
  const result = new Map<string, { mode: "100644" | "100755"; oid: string }>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record);
    if (!match) throw new Error("State mutation path did not resolve to a regular Git blob");
    result.set(match[3]!, { mode: match[1] as "100644" | "100755", oid: match[2]! });
  }
  return result;
}

function applyOperationsToTree(
  remoteTree: string,
  operations: readonly PreparedStateMutationOperation[],
): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "clawsweeper-state-batch-index-"));
  const indexPath = join(temporaryRoot, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    runGit(["read-tree", remoteTree], { env, quiet: true });
    const objectFormat = runGit(["rev-parse", "--show-object-format"], { env, quiet: true }).trim();
    const zeroOid = objectFormat === "sha256" ? "0".repeat(64) : "0".repeat(40);
    const indexInfo = operations
      .map((operation) =>
        operation.targetOid
          ? `${operation.mode} ${operation.targetOid}\t${operation.path}\0`
          : `0 ${zeroOid}\t${operation.path}\0`,
      )
      .join("");
    runGit(["update-index", "-z", "--index-info"], { env, input: indexInfo, quiet: true });
    return runGit(["write-tree"], { env, quiet: true }).trim();
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function batchCommitMessage(options: {
  batchId: string;
  fingerprint: string;
  plans: readonly PreparedStateMutationPlan[];
  message: string;
}): string {
  return [
    options.message,
    "",
    `ClawSweeper-Batch-ID: ${options.batchId}`,
    `ClawSweeper-Batch-Fingerprint: ${options.fingerprint}`,
    `ClawSweeper-Batch-Items: ${options.plans.length}`,
    "",
  ].join("\n");
}

function batchFingerprint(plans: readonly PreparedStateMutationPlan[]): string {
  const canonical = [...plans]
    .sort((left, right) => compareCanonicalText(left.identity.itemKey, right.identity.itemKey))
    .map((plan) => ({
      identity: {
        itemKey: plan.identity.itemKey,
        revision: plan.identity.revision,
        claimGeneration: plan.identity.claimGeneration,
      },
      operations: [...plan.operations]
        .sort((left, right) => compareCanonicalText(left.path, right.path))
        .map(({ path, expectedOid, targetOid, mode, bytes }) => ({
          path,
          expectedOid,
          targetOid,
          mode,
          bytes,
        })),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function verifyRemoteCommit(
  remote: string,
  branch: string,
  receiptRef: string,
  expected: string,
): void {
  const observed = spawnGit(["ls-remote", "--refs", remote, `refs/heads/${branch}`, receiptRef], {
    quiet: true,
    timeout: STATE_FETCH_TIMEOUT_MS,
  });
  if (observed.timedOut || observed.status !== 0) {
    throw new Error(`State batch push succeeded but ${remote}/${branch} could not be verified`);
  }
  const oids = observed.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 1)[0]);
  if (oids.length !== 2 || oids.some((oid) => oid !== expected)) {
    throw new StateMutationConflictError(
      `State batch push was not the visible head of ${remote}/${branch}`,
    );
  }
}

function batchReceiptRef(batchId: string): string {
  const digest = createHash("sha256").update(batchId).digest("hex");
  // The state history can advance hundreds of commits before an ambiguous retry.
  // A per-batch ref keeps recovery bounded; PR 3 owns deleting it only after the
  // durable queue has acknowledged the matching commit and fingerprint.
  return `refs/heads/clawsweeper-state-batches/${digest}`;
}

function validateCommitSubject(message: string | undefined): string {
  const subject = message?.trim() || "chore: publish exact-review state batch";
  if (subject.includes("\0") || subject.includes("\r") || subject.includes("\n")) {
    throw new Error("State publication batch commit subjects must be single-line values");
  }
  return subject;
}

function validateBatchId(batchId: string): void {
  if (!BATCH_ID_PATTERN.test(batchId)) {
    throw new Error("State publication batch ids must be stable printable identifiers");
  }
}
