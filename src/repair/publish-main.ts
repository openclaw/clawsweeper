#!/usr/bin/env node
import { sha256 } from "../content-hash.js";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

import { capturedCanonicalRecordBaselineKeys } from "./canonical-record-baseline.js";
import {
  publishMainCommit,
  type GitPublishOptions,
  type PublishResult,
  type RebaseStrategy,
} from "./git-publish.js";
import { recordTuplePaths, validateRecordTuple, type RecordTupleContents } from "./record-tuple.js";
import {
  CanonicalRecordTupleConflictError,
  CanonicalRecordTupleRequestError,
  postCanonicalCommitRecords,
  postCanonicalRecordTuple,
  type CanonicalCommitRecord,
  type CanonicalRecordTupleConflictState,
  type CanonicalRecordTupleMutation,
} from "./state-append-client.js";

type Args = {
  message: string;
  paths: string[];
  restorePaths: string[];
  maxAttempts?: number;
  pushAttempts?: number;
  rebaseStrategy?: RebaseStrategy;
};

type PublishMainRuntime = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  publishGit?: (options: GitPublishOptions) => PublishResult;
  root?: string;
};

type CanonicalRecordPlan = {
  items: Array<
    | { key: string; mutation: CanonicalRecordTupleMutation; error?: never }
    | { key: string; mutation?: never; error: unknown }
  >;
  remainingPaths: string[];
};

export async function publishMainWithStateAppend(
  options: GitPublishOptions,
  runtime: PublishMainRuntime = {},
): Promise<PublishResult | "appended"> {
  const env = runtime.env ?? process.env;
  const publishGit = runtime.publishGit ?? publishMainCommit;
  const root = runtime.root ?? process.cwd();
  const queueUrl = env.QUEUE_URL ?? "";
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  const canonicalBaselineRoot =
    env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR?.trim() || env.CLAWSWEEPER_STATE_DIR;
  const canonicalPlan = planCanonicalRecordTuples(options.paths, root, canonicalBaselineRoot, env);
  const canonicalItemCount = canonicalPlan.items.length;
  let canonicalResolvedCount = 0;
  let canonicalFailedCount = 0;
  let canonicalSkippedCount = 0;
  if (canonicalItemCount > 0) {
    if (!queueUrl || !webhookSecret) {
      throw new Error("canonical record publication is required for record tuple changes");
    }
    const isolateFailures = env.CLAWSWEEPER_CANONICAL_PUBLICATION_KIND === "reconcile";
    for (const item of canonicalPlan.items) {
      try {
        if ("error" in item) throw item.error;
        const outcome = await postCanonicalRecordTupleWithRecovery({
          queueUrl,
          webhookSecret,
          mutation: item.mutation,
          root,
          stateRoot: canonicalBaselineRoot!,
          env,
          ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
        });
        if (outcome === "skipped") canonicalSkippedCount += 1;
        else canonicalResolvedCount += 1;
      } catch (error) {
        if (!isolateFailures || isCanonicalInfrastructureError(error)) throw error;
        canonicalFailedCount += 1;
        console.error(`[canonical reconcile] ${item.key} failed: ${publishErrorMessage(error)}`);
      }
    }
    if (canonicalFailedCount === canonicalItemCount) {
      throw new Error(
        `Canonical reconciliation failed for all ${canonicalItemCount} item(s); see per-item errors above`,
      );
    }
    if (canonicalSkippedCount === canonicalItemCount) {
      throw new Error(
        `Canonical publication conflicted for all ${canonicalItemCount} item(s); see per-item warnings above`,
      );
    }
    if (canonicalFailedCount > 0) {
      console.warn(
        `[canonical reconcile] continued after ${canonicalFailedCount} of ${canonicalItemCount} item(s) failed`,
      );
    }
    if (canonicalSkippedCount > 0) {
      console.warn(
        `[canonical publish] continued after ${canonicalSkippedCount} of ${canonicalItemCount} conflicted item(s) were skipped`,
      );
    }
  }
  const commitPlan = planCanonicalCommitRecords(canonicalPlan.remainingPaths, root);
  if (commitPlan.recordsByRepository.size > 0 && (!queueUrl || !webhookSecret)) {
    throw new Error("canonical record publication is required for commit records");
  }
  for (const [repoSlug, records] of commitPlan.recordsByRepository) {
    for (let index = 0; index < records.length; index += 50) {
      await postCanonicalCommitRecords({
        queueUrl,
        webhookSecret,
        repoSlug,
        records: records.slice(index, index + 50),
        ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
      });
    }
  }
  const publicationOptions = { ...options, paths: commitPlan.remainingPaths };
  if (publicationOptions.paths.length === 0) {
    console.log(`Resolved ${canonicalResolvedCount} canonical record tuple(s)`);
    return "appended";
  }
  const retiredGitPath = publicationOptions.paths
    .map(normalizedPath)
    .find(
      (path) =>
        path === "ledger" ||
        path.startsWith("ledger/") ||
        path === "assets" ||
        path.startsWith("assets/"),
    );
  if (retiredGitPath) {
    throw new Error(`refusing retired git state publication for ${retiredGitPath}`);
  }
  return publishGit(publicationOptions);
}

const COMMIT_RECORD_PATH = /^records\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/commits\/([a-f0-9]{40})\.md$/;

function planCanonicalCommitRecords(requestedPaths: readonly string[], root: string) {
  const recordsByRepository = new Map<string, CanonicalCommitRecord[]>();
  const remainingPaths: string[] = [];
  for (const requestedPath of requestedPaths) {
    const normalized = normalizedPath(requestedPath);
    if (!isRecordsPath(normalized)) {
      remainingPaths.push(requestedPath);
      continue;
    }
    for (const [path, content] of collectRequestedRecordFiles(root, [normalized])) {
      const match = COMMIT_RECORD_PATH.exec(path);
      if (!match?.[1] || !match[2]) {
        throw new Error(`record publication path is not canonically addressable: ${path}`);
      }
      const records = recordsByRepository.get(match[1]) ?? [];
      records.push({ sha: match[2], content, digest: sha256(content) });
      recordsByRepository.set(match[1], records);
    }
  }
  for (const records of recordsByRepository.values()) {
    records.sort((left, right) => left.sha.localeCompare(right.sha));
  }
  return { recordsByRepository, remainingPaths };
}

const RECORD_TUPLE_PATH =
  /^records\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/(items|closed|plans|decision-packets)\/([1-9]\d*)\.(md|json)$/;
const RECORD_TUPLE_SECTIONS = ["items", "closed", "plans", "decision-packets"] as const;

function planCanonicalRecordTuples(
  requestedPaths: readonly string[],
  root: string,
  stateRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): CanonicalRecordPlan {
  const recordRequests = requestedPaths.filter((path) => isRecordsPath(normalizedPath(path)));
  if (recordRequests.length === 0) {
    return { items: [], remainingPaths: [...requestedPaths] };
  }
  if (recordRequests.every((path) => isCommitRecordRequest(normalizedPath(path)))) {
    return { items: [], remainingPaths: [...requestedPaths] };
  }
  if (!stateRoot) throw new Error("record publication requires a hydrated state checkout");
  const explicitBaselineRoot = env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR?.trim();
  const capturedKeys = explicitBaselineRoot
    ? capturedCanonicalRecordBaselineKeys(explicitBaselineRoot)
    : null;
  if (capturedKeys) {
    for (const requestedPath of recordRequests) {
      const match = RECORD_TUPLE_PATH.exec(normalizedPath(requestedPath));
      if (!match?.[1] || !match[3]) continue;
      const key = `${match[1]}/${match[3]}`;
      if (!capturedKeys.has(key)) {
        throw new Error(`canonical tuple ${key} was not captured before mutation`);
      }
    }
  }
  const includeFile = (path: string): boolean => {
    if (!capturedKeys) return true;
    const match = RECORD_TUPLE_PATH.exec(path);
    return Boolean(match?.[1] && match[3] && capturedKeys.has(`${match[1]}/${match[3]}`));
  };
  const localFiles = new Map(
    [...collectRequestedRecordFiles(root, recordRequests)].filter(([path]) => includeFile(path)),
  );
  const stateFiles = new Map(
    [...collectRequestedRecordFiles(stateRoot, recordRequests)].filter(([path]) =>
      includeFile(path),
    ),
  );
  const changedPaths = new Set(
    [...new Set([...localFiles.keys(), ...stateFiles.keys()])].filter(
      (path) => localFiles.get(path) !== stateFiles.get(path),
    ),
  );
  const changedTupleKeys = new Set<string>();
  for (const path of changedPaths) {
    const match = RECORD_TUPLE_PATH.exec(path);
    if (match && (match[2] === "decision-packets") === (match[4] === "json")) {
      changedTupleKeys.add(`${match[1]}/${match[3]}`);
    } else if (/^records\/[^/]+\/(?:items|closed|plans|decision-packets)\//.test(path)) {
      throw new Error(`record tuple path is not canonically addressable: ${path}`);
    }
  }
  const items = [...changedTupleKeys].sort().map((key) => {
    try {
      const [repository, number] = key.split("/");
      if (!repository || !number) throw new Error(`invalid canonical tuple key: ${key}`);
      const paths = recordTuplePaths({ repository, number });
      const localContent = (path: string) =>
        localFiles.has(path) ? localFiles.get(path)! : readOptionalRecordFile(root, path);
      const stateContent = (path: string) =>
        stateFiles.has(path) ? stateFiles.get(path)! : readOptionalRecordFile(stateRoot, path);
      const tuple: RecordTupleContents = {
        paths,
        item: localContent(paths.item),
        closed: localContent(paths.closed),
        plan: localContent(paths.plan),
        packet: localContent(paths.packet),
      };
      validateRecordTuple(tuple, "canonical publication tuple");
      const operations = RECORD_TUPLE_SECTIONS.map((section) => {
        const path = tuplePathForSection(paths, section);
        const content = localContent(path);
        const expected = stateContent(path);
        return {
          path,
          expectedDigest: expected === null ? null : sha256(expected),
          ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
        };
      });
      const contentHash = createHash("sha256")
        .update(JSON.stringify({ key, operations }))
        .digest("hex");
      const deliveryPrefix =
        env.CLAWSWEEPER_CANONICAL_PUBLICATION_KIND === "reconcile"
          ? `record-reconcile:${repository}:${number}`
          : `record-tuple:${deliveryPart(env.GITHUB_RUN_ID, "local")}:${deliveryPart(env.GITHUB_RUN_ATTEMPT, "1")}`;
      return {
        key,
        mutation: {
          deliveryId: `${deliveryPrefix}:${contentHash}`,
          key,
          operations,
        },
      };
    } catch (error) {
      return { key, error };
    }
  });
  const remainingPaths = requestedPaths.flatMap((requestedPath) => {
    const normalized = normalizedPath(requestedPath);
    if (!isRecordsPath(normalized)) return [requestedPath];
    if (isRecordTupleProjectionPath(normalized)) return [];
    const coveredChanges = [...changedPaths].filter(
      (path) => path === normalized || path.startsWith(`${normalized}/`),
    );
    return coveredChanges.filter((path) => !isRecordTupleProjectionPath(path));
  });
  return { items, remainingPaths: [...new Set(remainingPaths)] };
}

function isCommitRecordRequest(path: string): boolean {
  return /^records\/[A-Za-z0-9][A-Za-z0-9_.-]*\/commits(?:\/|$)/.test(path);
}

function isRecordTupleProjectionPath(path: string): boolean {
  return /^records\/[A-Za-z0-9][A-Za-z0-9_.-]*\/(?:items|closed|plans|decision-packets)(?:\/|$)/.test(
    path,
  );
}

type CanonicalPublicationOutcome = "published" | "skipped";

type CanonicalPublicationOptions = {
  queueUrl: string;
  webhookSecret: string;
  mutation: CanonicalRecordTupleMutation;
  root: string;
  stateRoot: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

async function postCanonicalRecordTupleWithRecovery(
  options: CanonicalPublicationOptions,
): Promise<CanonicalPublicationOutcome> {
  try {
    await postCanonicalRecordTuple(options);
    return "published";
  } catch (error) {
    if (!(error instanceof CanonicalRecordTupleConflictError)) throw error;
    if (options.env.CLAWSWEEPER_CANONICAL_PUBLICATION_KIND !== "reconcile") {
      return recoverNonReconcilePublicationConflict(options, error);
    }
    const current = currentTupleFromConflict(error.current, options.mutation.key);
    if (!current) throw error;
    const [repoSlug, itemNumber] = options.mutation.key.split("/");
    if (!repoSlug || !itemNumber) throw error;
    const paths = recordTuplePaths({ repository: repoSlug, number: itemNumber });
    const baseline = tupleFromRoot(options.stateRoot, paths);
    const target = tupleFromMutation(options.mutation, paths);
    const baselineLocation = tupleLocation(baseline);
    const targetLocation = tupleLocation(target);
    const currentLocation = tupleLocation(current.tuple);
    if (targetLocation === currentLocation) {
      syncTupleToRoot(options.root, current.tuple);
      console.warn(
        `Skipped ${options.mutation.key}: canonical CURRENT revision ${current.state.revision} already has ${targetLocation ?? "deleted"} placement`,
      );
      return "published";
    }
    if (
      baselineLocation === targetLocation ||
      currentLocation === null ||
      currentLocation !== baselineLocation
    ) {
      syncTupleToRoot(options.root, current.tuple);
      console.warn(
        `Skipped ${options.mutation.key}: canonical CURRENT revision ${current.state.revision} made the reconcile move obsolete`,
      );
      return "published";
    }

    const rebasedTarget = rebaseReconciliationMove({ baseline, target, current: current.tuple });
    const operations = current.state.operations.map((operation) => {
      const content = tupleContentForPath(rebasedTarget, operation.path);
      return {
        path: operation.path,
        expectedDigest: operation.expectedDigest,
        ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
      };
    });
    const contentHash = createHash("sha256")
      .update(JSON.stringify({ key: options.mutation.key, operations }))
      .digest("hex");
    const retryMutation: CanonicalRecordTupleMutation = {
      ...options.mutation,
      deliveryId: `record-reconcile:${repoSlug}:${itemNumber}:${contentHash}`,
      operations,
    };
    try {
      await postCanonicalRecordTuple({
        queueUrl: options.queueUrl,
        webhookSecret: options.webhookSecret,
        mutation: retryMutation,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch (retryError) {
      if (!(retryError instanceof CanonicalRecordTupleConflictError)) throw retryError;
      let retryCurrent: ReturnType<typeof currentTupleFromConflict> = null;
      try {
        retryCurrent = currentTupleFromConflict(retryError.current, options.mutation.key);
      } catch (parseError) {
        console.warn(
          `Skipped ${options.mutation.key} after retry conflict with invalid CURRENT state: ${publishErrorMessage(parseError)}`,
        );
        return "published";
      }
      if (retryCurrent) {
        syncTupleToRoot(options.root, retryCurrent.tuple);
        if (tupleLocation(retryCurrent.tuple) !== targetLocation) {
          recordReconciliationDeferralIfConfigured(options.env, {
            itemNumber: Number(itemNumber),
            key: options.mutation.key,
            currentRevision: retryCurrent.state.revision,
            reason: "canonical CURRENT changed again during reconcile retry",
          });
        }
      }
      console.warn(
        `Skipped ${options.mutation.key}: canonical CURRENT changed again during the single retry`,
      );
      return "published";
    }
    syncTupleToRoot(options.root, rebasedTarget);
    console.warn(
      `Retried ${options.mutation.key} against canonical CURRENT revision ${current.state.revision}`,
    );
    return "published";
  }
}

// Non-reconcile publications (apply checkpoints, comment sync, review artifacts)
// race the ~70 concurrent review workers that continuously bump canonical record
// revisions, so a 409 is routine rather than exceptional. Recover by rebasing only
// the sections this publication changed onto canonical CURRENT; anything murkier
// is skipped per item so one contested tuple cannot kill the whole run.
async function recoverNonReconcilePublicationConflict(
  options: CanonicalPublicationOptions,
  error: CanonicalRecordTupleConflictError,
): Promise<CanonicalPublicationOutcome> {
  const current = currentTupleFromConflict(error.current, options.mutation.key);
  if (!current) throw error;
  const [repoSlug, itemNumber] = options.mutation.key.split("/");
  if (!repoSlug || !itemNumber) throw error;
  const paths = recordTuplePaths({ repository: repoSlug, number: itemNumber });
  const target = tupleFromMutation(options.mutation, paths);
  const baselineDigests = new Map(
    options.mutation.operations.map((operation) => [operation.path, operation.expectedDigest]),
  );
  // Sections this publication changed: the mutation's content differs from the
  // state-baseline digest the mutation asserted for that section.
  const changedPaths = RECORD_TUPLE_SECTIONS.map((section) =>
    tuplePathForSection(paths, section),
  ).filter(
    (path) => contentDigest(tupleContentForPath(target, path)) !== baselineDigests.get(path),
  );
  const conflictingPaths = changedPaths.filter(
    (path) => tupleContentForPath(current.tuple, path) !== tupleContentForPath(target, path),
  );
  if (conflictingPaths.length === 0) {
    syncTupleToRoot(options.root, current.tuple);
    console.warn(
      `Skipped ${options.mutation.key}: canonical CURRENT revision ${current.state.revision} already contains this publication`,
    );
    return "published";
  }
  // GitHub-side effects for this item already happened (capture-before-mutate), so
  // a skipped publication may repeat the action next cycle. Comment idempotency
  // fences and the unchanged-edit dedupe (#857) make that repeat a no-op; never
  // weaken those fences to compensate here.
  if (
    conflictingPaths.some(
      (path) =>
        contentDigest(tupleContentForPath(current.tuple, path)) !== baselineDigests.get(path),
    )
  ) {
    syncTupleToRoot(options.root, current.tuple);
    console.warn(
      `Skipped ${options.mutation.key}: canonical CURRENT revision ${current.state.revision} concurrently changed a section this publication also changed`,
    );
    return "skipped";
  }
  const changed = new Set(changedPaths);
  const rebasedContent = (path: string) =>
    changed.has(path)
      ? tupleContentForPath(target, path)
      : tupleContentForPath(current.tuple, path);
  const rebased: RecordTupleContents = {
    paths,
    item: rebasedContent(paths.item),
    closed: rebasedContent(paths.closed),
    plan: rebasedContent(paths.plan),
    packet: rebasedContent(paths.packet),
  };
  try {
    validateRecordTuple(rebased, "rebased canonical publication tuple");
  } catch (validationError) {
    syncTupleToRoot(options.root, current.tuple);
    console.warn(
      `Skipped ${options.mutation.key}: rebase onto canonical CURRENT revision ${current.state.revision} is invalid: ${publishErrorMessage(validationError)}`,
    );
    return "skipped";
  }
  const operations = current.state.operations.map((operation) => {
    const content = tupleContentForPath(rebased, operation.path);
    return {
      path: operation.path,
      expectedDigest: operation.expectedDigest,
      ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
    };
  });
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ key: options.mutation.key, operations }))
    .digest("hex");
  const retryMutation: CanonicalRecordTupleMutation = {
    ...options.mutation,
    deliveryId: `record-tuple-rebase:${deliveryPart(options.env.GITHUB_RUN_ID, "local")}:${deliveryPart(options.env.GITHUB_RUN_ATTEMPT, "1")}:${contentHash}`,
    operations,
  };
  try {
    await postCanonicalRecordTuple({
      queueUrl: options.queueUrl,
      webhookSecret: options.webhookSecret,
      mutation: retryMutation,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (retryError) {
    if (!(retryError instanceof CanonicalRecordTupleConflictError)) throw retryError;
    try {
      const retryCurrent = currentTupleFromConflict(retryError.current, options.mutation.key);
      if (retryCurrent) syncTupleToRoot(options.root, retryCurrent.tuple);
    } catch {
      // Keep the single-retry skip even when the retry CURRENT payload is unusable.
    }
    console.warn(
      `Skipped ${options.mutation.key}: canonical CURRENT changed again during the single rebase retry`,
    );
    return "skipped";
  }
  syncTupleToRoot(options.root, rebased);
  console.warn(
    `Rebased ${options.mutation.key} onto canonical CURRENT revision ${current.state.revision}`,
  );
  return "published";
}

function contentDigest(content: string | null): string | null {
  return content === null ? null : sha256(content);
}

function currentTupleFromConflict(
  state: CanonicalRecordTupleConflictState | null,
  expectedKey: string,
): {
  state: CanonicalRecordTupleConflictState;
  tuple: RecordTupleContents;
  deliveryId: string | null;
} | null {
  if (!state || state.key !== expectedKey) return null;
  const [repository, number] = expectedKey.split("/");
  if (!repository || !number) return null;
  const paths = recordTuplePaths({ repository, number });
  const tuple = tupleFromMutation(
    { deliveryId: "current", key: expectedKey, operations: state.operations },
    paths,
  );
  validateRecordTuple(tuple, "canonical CURRENT tuple");
  for (const operation of state.operations) {
    const content = operation.contentBase64
      ? Buffer.from(operation.contentBase64, "base64").toString("utf8")
      : null;
    if ((content === null ? null : sha256(content)) !== operation.expectedDigest) {
      throw new Error(`canonical CURRENT digest does not match ${operation.path}`);
    }
  }
  return { state, tuple, deliveryId: state.deliveryId };
}

function tupleFromMutation(
  mutation: CanonicalRecordTupleMutation,
  paths: ReturnType<typeof recordTuplePaths>,
): RecordTupleContents {
  const content = (path: string) => {
    const operation = mutation.operations.find((candidate) => candidate.path === path);
    if (!operation) throw new Error(`canonical tuple omitted ${path}`);
    return operation.contentBase64 === undefined
      ? null
      : Buffer.from(operation.contentBase64, "base64").toString("utf8");
  };
  return {
    paths,
    item: content(paths.item),
    closed: content(paths.closed),
    plan: content(paths.plan),
    packet: content(paths.packet),
  };
}

function tupleFromRoot(
  root: string,
  paths: ReturnType<typeof recordTuplePaths>,
): RecordTupleContents {
  return {
    paths,
    item: readOptionalRecordFile(root, paths.item),
    closed: readOptionalRecordFile(root, paths.closed),
    plan: readOptionalRecordFile(root, paths.plan),
    packet: readOptionalRecordFile(root, paths.packet),
  };
}

function tupleLocation(tuple: RecordTupleContents): "items" | "closed" | null {
  if (tuple.item !== null) return "items";
  if (tuple.closed !== null) return "closed";
  return null;
}

function rebaseReconciliationMove(options: {
  baseline: RecordTupleContents;
  target: RecordTupleContents;
  current: RecordTupleContents;
}): RecordTupleContents {
  const baselinePrimary = options.baseline.item ?? options.baseline.closed;
  const targetPrimary = options.target.item ?? options.target.closed;
  const currentPrimary = options.current.item ?? options.current.closed;
  const targetLocation = tupleLocation(options.target);
  if (!baselinePrimary || !targetPrimary || !currentPrimary || !targetLocation) {
    throw new Error(`Cannot rebase non-move reconciliation for ${options.target.paths.key}`);
  }
  const rebasedPrimary = applyFrontMatterDelta(baselinePrimary, targetPrimary, currentPrimary);
  const rebased: RecordTupleContents = {
    paths: options.target.paths,
    item: targetLocation === "items" ? rebasedPrimary : null,
    closed: targetLocation === "closed" ? rebasedPrimary : null,
    plan: rebaseTupleSidecar(options.baseline.plan, options.target.plan, options.current.plan),
    packet: rebaseTupleSidecar(
      options.baseline.packet,
      options.target.packet,
      options.current.packet,
    ),
  };
  validateRecordTuple(rebased, "rebased canonical reconciliation tuple");
  return rebased;
}

function rebaseTupleSidecar(
  baseline: string | null,
  target: string | null,
  current: string | null,
): string | null {
  if (target === baseline) return current;
  if (target === null) return null;
  if (baseline === null || current === null) return target;
  return applyFrontMatterDelta(baseline, target, current);
}

function applyFrontMatterDelta(baseline: string, target: string, current: string): string {
  const baselineDocument = parseFrontMatterDocument(baseline);
  const targetDocument = parseFrontMatterDocument(target);
  const currentDocument = parseFrontMatterDocument(current);
  if (!baselineDocument || !targetDocument || !currentDocument) return target;
  if (baselineDocument.body !== targetDocument.body) return target;

  const changedKeys = new Set(
    [...new Set([...baselineDocument.fields.keys(), ...targetDocument.fields.keys()])].filter(
      (key) => baselineDocument.fields.get(key)?.value !== targetDocument.fields.get(key)?.value,
    ),
  );
  const lines = [...currentDocument.lines];
  for (const key of changedKeys) {
    const targetField = targetDocument.fields.get(key);
    const currentIndex = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (!targetField) {
      if (currentIndex !== -1) lines.splice(currentIndex, 1);
      continue;
    }
    if (currentIndex !== -1) {
      lines[currentIndex] = targetField.line;
      continue;
    }
    const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
    if (closingIndex === -1) return target;
    lines.splice(closingIndex, 0, targetField.line);
  }
  return lines.join("\n");
}

function parseFrontMatterDocument(markdown: string): {
  lines: string[];
  body: string;
  fields: Map<string, { line: string; value: string }>;
} | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex === -1) return null;
  const fields = new Map<string, { line: string; value: string }>();
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) fields.set(match[1], { line, value: match[2] ?? "" });
  }
  return { lines, body: lines.slice(closingIndex + 1).join("\n"), fields };
}

function tuplePathForSection(
  paths: ReturnType<typeof recordTuplePaths>,
  section: (typeof RECORD_TUPLE_SECTIONS)[number],
): string {
  if (section === "items") return paths.item;
  if (section === "closed") return paths.closed;
  if (section === "plans") return paths.plan;
  return paths.packet;
}

function tupleContentForPath(tuple: RecordTupleContents, path: string): string | null {
  if (path === tuple.paths.item) return tuple.item;
  if (path === tuple.paths.closed) return tuple.closed;
  if (path === tuple.paths.plan) return tuple.plan;
  if (path === tuple.paths.packet) return tuple.packet;
  throw new Error(`canonical CURRENT tuple included unexpected path ${path}`);
}

function syncTupleToRoot(root: string, tuple: RecordTupleContents): void {
  for (const [path, content] of [
    [tuple.paths.item, tuple.item],
    [tuple.paths.closed, tuple.closed],
    [tuple.paths.plan, tuple.plan],
    [tuple.paths.packet, tuple.packet],
  ] as const) {
    const absolute = resolve(root, path);
    if (content === null) {
      if (existsSync(absolute)) unlinkSync(absolute);
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function recordReconciliationDeferral(
  env: NodeJS.ProcessEnv,
  deferral: { itemNumber: number; key: string; currentRevision: number; reason: string },
): void {
  const path = env.CLAWSWEEPER_RECONCILE_DEFERRED_PATH;
  if (!path) throw new Error("reconciliation deferral path is required for conflict recovery");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(deferral)}\n`, "utf8");
}

function recordReconciliationDeferralIfConfigured(
  env: NodeJS.ProcessEnv,
  deferral: { itemNumber: number; key: string; currentRevision: number; reason: string },
): void {
  if (!env.CLAWSWEEPER_RECONCILE_DEFERRED_PATH) return;
  recordReconciliationDeferral(env, deferral);
}

function isCanonicalInfrastructureError(error: unknown): boolean {
  return (
    error instanceof CanonicalRecordTupleRequestError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 503 ||
      /(?:snapshot_|state_|storage_|store_)unavailable/.test(error.code))
  );
}

function publishErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecordsPath(path: string): boolean {
  return path === "records" || path.startsWith("records/");
}

function readOptionalRecordFile(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return null;
  return readContainedRegularFile(root, path);
}

function collectRequestedRecordFiles(root: string, requestedPaths: readonly string[]) {
  const files = new Map<string, string>();
  for (const requestedPath of requestedPaths) {
    collectRecordFiles(root, normalizedPath(requestedPath), files);
  }
  return files;
}

function collectRecordFiles(root: string, relativePath: string, files: Map<string, string>): void {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink())
    throw new Error(`record publication path is symbolic: ${relativePath}`);
  if (stat.isFile()) {
    files.set(relativePath, readContainedRegularFile(root, relativePath));
    return;
  }
  if (!stat.isDirectory())
    throw new Error(`record publication path is not regular: ${relativePath}`);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    collectRecordFiles(root, `${relativePath}/${entry.name}`, files);
  }
}

function readContainedRegularFile(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, path);
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`state append source must not be a symbolic link: ${path}`);
  }
  const realFile = realpathSync(candidate);
  const relativePath = relative(realRoot, realFile);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`state append source resolves outside the workspace: ${path}`);
  }
  if (!statSync(realFile).isFile()) {
    throw new Error(`state append source is not a regular file: ${path}`);
  }
  return readFileSync(realFile, "utf8");
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function deliveryPart(value: string | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "-");
  return normalized || fallback;
}

function parseArgs(argv: readonly string[]): Args {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) throw new Error(`Unknown argument: ${arg}`);
    if (arg === "--") continue;
    if (
      [
        "--message",
        "--path",
        "--restore",
        "--max-attempts",
        "--push-attempts",
        "--rebase-strategy",
      ].includes(arg)
    ) {
      normalized.push(`${arg}=${requiredValue(argv, ++index, arg)}`);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const { values } = parseNodeArgs({
    args: normalized,
    options: {
      message: { type: "string" },
      path: { type: "string", multiple: true },
      restore: { type: "string", multiple: true },
      "max-attempts": { type: "string" },
      "push-attempts": { type: "string" },
      "rebase-strategy": { type: "string" },
    },
  });
  const parsed: Args = {
    message: values.message ?? "",
    paths: values.path ?? [],
    restorePaths: values.restore ?? [],
    ...(values["max-attempts"]
      ? { maxAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts") }
      : {}),
    ...(values["push-attempts"]
      ? { pushAttempts: parsePositiveInt(values["push-attempts"], "--push-attempts") }
      : {}),
    ...(values["rebase-strategy"]
      ? { rebaseStrategy: parseRebaseStrategy(values["rebase-strategy"]) }
      : {}),
  };
  if (!parsed.message) throw new Error("--message is required");
  if (parsed.paths.length === 0) throw new Error("At least one --path is required");
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseRebaseStrategy(value: string): RebaseStrategy {
  if (value === "normal" || value === "theirs") return value;
  throw new Error("--rebase-strategy must be normal or theirs");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  await publishMainWithStateAppend({
    message: args.message,
    paths: args.paths,
    restorePaths: args.restorePaths,
    ...(args.maxAttempts ? { maxAttempts: args.maxAttempts } : {}),
    ...(args.pushAttempts ? { pushAttempts: args.pushAttempts } : {}),
    ...(args.rebaseStrategy ? { rebaseStrategy: args.rebaseStrategy } : {}),
  });
}
