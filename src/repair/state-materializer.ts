#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  actionLedgerJson,
  parseActionEventShardContent,
  validateActionEvent,
} from "../action-ledger.js";
import { isActionEventPublishPath } from "../action-ledger-paths.js";
import { mergeCommentRouterLedgers } from "./comment-router-ledger-merge.js";
import {
  GitShallowHistoryExhaustionError,
  publishMainCommit,
  SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION,
  type ShallowHistoryExhaustionStrategy,
} from "./git-publish.js";
import {
  convergeRecordTupleSidecars,
  recordTuplePaths,
  validateRecordTuple,
  type RecordTupleContents,
} from "./record-tuple.js";
import { mergeSweepStatusJson } from "./sweep-status-merge.js";

export const DEFAULT_STATE_MATERIALIZER_MAX_ROWS = 2_000;
export const DEFAULT_STATE_MATERIALIZER_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_STATE_MATERIALIZER_MAX_RUNTIME_MS = 10 * 60 * 1_000;

const COMMENT_ROUTER_LEDGER_PATH = "results/comment-router.json";
const COMMENT_ROUTER_LATEST_REPORT_PATH = "results/comment-router-latest.json";
const EMPTY_COMMENT_ROUTER_LEDGER = '{"updated_at":null,"commands":[]}';
const STATE_MATERIALIZER_COMMIT_MESSAGE = "chore: materialize queued state\n\n[skip ci]";
const STATE_APPEND_KINDS = new Set<StateAppendKind>([
  "sweep_status",
  "comment_router",
  "apply_proof",
  "record_tuple",
]);

export type StateAppendKind = "sweep_status" | "comment_router" | "apply_proof" | "record_tuple";

type RecordTupleProjectionOperation = {
  path: string;
  repoSlug: string;
  section: "items" | "closed" | "plans" | "decision-packets";
  itemId: number;
  digest: string | null;
  revision: number;
  bytes: number;
  deleted: boolean;
  content?: string;
  oversize?: boolean;
};

type RecordTupleProjection = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
  operations: RecordTupleProjectionOperation[];
};

export type StateAppendRecord = {
  seq: number;
  kind: StateAppendKind;
  key: string;
  payload: unknown;
  produced_at: string;
  delivery_id: string;
  materialization_attempts?: number;
  materialization_last_error?: string;
};

type StateMaterializationFailure = {
  seq: number;
  key: string;
  reason: string;
  retryable: boolean;
};

export type StateMaterializerSummary = {
  drained: number;
  committed: number;
  acked: number;
  skipped: number;
  errors: number;
};

export type StateMaterializationPlan = {
  deletes: string[];
  publishPaths: string[];
  writes: Array<{ path: string; content: string }>;
  selected: number;
  skipped: number;
};

export type StateMaterializerRunOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  publishCommit?: typeof publishMainCommit;
};

type StateDrainResponse = {
  token: string | null;
  records: StateAppendRecord[];
};

export function selectLatestStateRecords(records: readonly StateAppendRecord[]): {
  records: StateAppendRecord[];
  skipped: number;
} {
  const ordered = [...records].sort((left, right) => left.seq - right.seq);
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index]!;
    assertStateAppendRecord(record);
    if (index > 0 && ordered[index - 1]!.seq === record.seq) {
      throw new Error(`state drain contains duplicate sequence ${record.seq}`);
    }
  }

  const latest = new Map<string, StateAppendRecord>();
  for (const record of ordered) {
    const key = `${record.kind}\0${record.key}`;
    const current = latest.get(key);
    const currentRevision = current?.kind === "record_tuple" ? recordTupleRevision(current) : null;
    const incomingRevision = record.kind === "record_tuple" ? recordTupleRevision(record) : null;
    if (
      record.kind === "record_tuple" &&
      current?.kind === "record_tuple" &&
      currentRevision !== null &&
      incomingRevision !== null &&
      currentRevision > incomingRevision
    ) {
      continue;
    }
    latest.set(key, record);
  }
  const selected = [...latest.values()].sort((left, right) => left.seq - right.seq);
  return { records: selected, skipped: records.length - selected.length };
}

export function sweepStatusPathForStateKey(key: string): string {
  const slugMatch = /^([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(key);
  if (slugMatch) return `results/sweep-status/${slugMatch[1]}.json`;
  const pathMatch = /^results\/sweep-status\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.json$/.exec(key);
  if (pathMatch) return key;
  throw new Error(`invalid sweep status key: ${key}`);
}

export function serializeApplyProof(path: string, payload: unknown): string {
  if (!isActionEventPublishPath(path)) {
    throw new Error(`invalid apply proof ledger path: ${path}`);
  }
  if (path.endsWith(".jsonl")) {
    const content =
      typeof payload === "string"
        ? payload
        : Array.isArray(payload)
          ? `${payload
              .map((event, index) =>
                actionLedgerJson(validateActionEvent(event, `${path}:${index + 1}`)),
              )
              .join("\n")}\n`
          : (() => {
              throw new Error(`apply proof event payload must be an array or string: ${path}`);
            })();
    parseActionEventShardContent(content, path);
    return content;
  }

  if (typeof payload !== "string") return `${actionLedgerJson(payload)}\n`;
  if (!payload.endsWith("\n") || payload.slice(0, -1).includes("\n")) {
    throw new Error(`apply proof binding must be one newline-terminated JSON value: ${path}`);
  }
  const parsed = JSON.parse(payload.slice(0, -1)) as unknown;
  const canonical = `${actionLedgerJson(parsed)}\n`;
  if (payload !== canonical) throw new Error(`apply proof binding is not canonical: ${path}`);
  return payload;
}

export function planStateMaterialization(
  records: readonly StateAppendRecord[],
  currentFiles: ReadonlyMap<string, string> = new Map(),
): StateMaterializationPlan {
  const selected = selectLatestStateRecords(records);
  const contentByPath = new Map<string, string>();
  const deletes = new Set<string>();
  const publishPaths: string[] = [];
  const addPublishPath = (path: string): void => {
    if (!publishPaths.includes(path)) publishPaths.push(path);
  };

  for (const record of selected.records) {
    if (record.kind === "sweep_status") {
      const path = sweepStatusPathForStateKey(record.key);
      const slug = path.slice("results/sweep-status/".length, -".json".length);
      if (!isRecord(record.payload) || record.payload.slug !== slug) {
        throw new Error(`sweep status payload slug does not match ${path}`);
      }
      const payloadText = JSON.stringify(record.payload);
      const content = mergeSweepStatusJson({
        path,
        baseText: null,
        localText: null,
        remoteText: payloadText,
      });
      contentByPath.set(path, content);
      addPublishPath(path);
      continue;
    }

    if (record.kind === "comment_router") {
      const payloadText = JSON.stringify(record.payload);
      const current =
        contentByPath.get(COMMENT_ROUTER_LEDGER_PATH) ??
        currentFiles.get(COMMENT_ROUTER_LEDGER_PATH) ??
        EMPTY_COMMENT_ROUTER_LEDGER;
      contentByPath.set(
        COMMENT_ROUTER_LEDGER_PATH,
        mergeCommentRouterLedgers(payloadText, current),
      );
      addPublishPath(COMMENT_ROUTER_LEDGER_PATH);
      // This report describes one invocation, not durable command state. Retire
      // the old tracked copy in the same single-writer commit as the next ledger.
      if (currentFiles.has(COMMENT_ROUTER_LATEST_REPORT_PATH)) {
        deletes.add(COMMENT_ROUTER_LATEST_REPORT_PATH);
        addPublishPath(COMMENT_ROUTER_LATEST_REPORT_PATH);
      }
      continue;
    }

    if (record.kind === "record_tuple") {
      const tuple = recordTupleProjection(record);
      const primaryWrites = tuple.operations.filter(
        (operation) =>
          (operation.section === "items" || operation.section === "closed") && !operation.deleted,
      );
      if (primaryWrites.length > 1) {
        throw new Error(`record tuple projection ${record.key} writes both primary sections`);
      }
      for (const operation of tuple.operations) {
        addPublishPath(operation.path);
        if (operation.deleted) {
          contentByPath.delete(operation.path);
          if (currentFiles.has(operation.path)) deletes.add(operation.path);
        } else {
          if (typeof operation.content !== "string" || operation.oversize) {
            throw new Error(`record tuple content was not hydrated: ${operation.path}`);
          }
          contentByPath.set(operation.path, operation.content);
          deletes.delete(operation.path);
        }
      }
      const paths = recordTuplePaths({
        repository: tuple.operations[0]!.repoSlug,
        number: String(tuple.operations[0]!.itemId),
      });
      const primaryWrite = primaryWrites[0];
      if (primaryWrite) {
        const displacedPrimary = primaryWrite.section === "items" ? paths.closed : paths.item;
        contentByPath.delete(displacedPrimary);
        if (currentFiles.has(displacedPrimary)) deletes.add(displacedPrimary);
        addPublishPath(displacedPrimary);
      }
      const target = (path: string): string | null => {
        if (deletes.has(path)) return null;
        return contentByPath.get(path) ?? currentFiles.get(path) ?? null;
      };
      const contents: RecordTupleContents = {
        paths,
        item: target(paths.item),
        closed: target(paths.closed),
        plan: target(paths.plan),
        packet: target(paths.packet),
      };
      const converged = convergeRecordTupleSidecars(contents);
      for (const path of converged.deletedPaths) {
        contentByPath.delete(path);
        if (currentFiles.has(path)) deletes.add(path);
        addPublishPath(path);
      }
      validateRecordTuple(converged.tuple, `record tuple projection ${record.key}`);
      continue;
    }

    const path = record.key;
    const content = serializeApplyProof(path, record.payload);
    const current = currentFiles.get(path);
    if (current !== undefined && current !== content) {
      throw new Error(`immutable apply proof already has different content: ${path}`);
    }
    contentByPath.set(path, content);
    addPublishPath(path);
  }

  return {
    deletes: [...deletes].sort(),
    publishPaths,
    writes: [...contentByPath]
      .filter(([path, content]) => currentFiles.get(path) !== content)
      .map(([path, content]) => ({ path, content })),
    selected: selected.records.length,
    skipped: selected.skipped,
  };
}

export async function runStateMaterializer(
  options: StateMaterializerRunOptions = {},
): Promise<StateMaterializerSummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const publishCommit = options.publishCommit ?? publishMainCommit;
  const queueUrl = (env.QUEUE_URL ?? "").replace(/\/$/, "");
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  registerStateSecretForRedaction(webhookSecret);
  const maximumRows = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_MAX_ROWS ?? env.STATE_MATERIALIZER_MAX_ROWS,
    DEFAULT_STATE_MATERIALIZER_MAX_ROWS,
    100_000,
  );
  const maximumBytes = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_MAX_BYTES ?? env.STATE_MATERIALIZER_MAX_BYTES,
    DEFAULT_STATE_MATERIALIZER_MAX_BYTES,
    100 * 1024 * 1024,
  );
  const maximumRuntimeMs = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_MAX_RUNTIME_MS ?? env.STATE_MATERIALIZER_MAX_RUNTIME_MS,
    DEFAULT_STATE_MATERIALIZER_MAX_RUNTIME_MS,
    60 * 60 * 1_000,
  );
  const publishMaxAttempts = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_PUBLISH_MAX_ATTEMPTS,
    8,
    64,
  );
  const publishPushAttempts = boundedPositiveInteger(
    env.CLAWSWEEPER_STATE_MATERIALIZER_PUSH_ATTEMPTS,
    3,
    16,
  );
  const branch = env.CLAWSWEEPER_PUBLISH_BRANCH?.trim() || "state";
  const startedAt = now().getTime();
  const summary: StateMaterializerSummary = {
    drained: 0,
    committed: 0,
    acked: 0,
    skipped: 0,
    errors: 0,
  };
  const finish = (): StateMaterializerSummary => {
    console.log(
      `state-materializer: drained=${summary.drained} committed=${summary.committed} acked=${summary.acked} skipped=${summary.skipped} errors=${summary.errors}`,
    );
    return summary;
  };

  if (!queueUrl || !webhookSecret) {
    summary.errors += 1;
    console.warn("state-materializer skipped: missing queue URL or webhook secret");
    return finish();
  }

  while (now().getTime() - startedAt < maximumRuntimeMs) {
    let drain: StateDrainResponse;
    try {
      drain = await drainStateWindow({
        queueUrl,
        webhookSecret,
        maximumRows,
        maximumBytes,
        fetchImpl,
      });
    } catch (error) {
      summary.errors += 1;
      console.warn(`state-materializer drain failed: ${errorMessage(error)}`);
      break;
    }
    if (drain.records.length === 0) break;
    summary.drained += drain.records.length;

    try {
      if (!drain.token) throw new Error("non-empty state drain omitted its token");
      const selected = selectLatestStateRecords(drain.records);
      const hydrated = await hydrateRecordTupleRecords({
        records: selected.records,
        queueUrl,
        webhookSecret,
        fetchImpl,
      });
      const currentFiles = readCurrentFiles(materializationPaths(hydrated.records), process.cwd());
      const isolated = planStateMaterializationWithIsolation(hydrated.records, currentFiles);
      const failures = [...hydrated.failures, ...isolated.failures];
      const publicationFailureSeqs = new Set<number>();
      const tupleRecordsByKey = new Map(
        hydrated.records
          .filter((record) => record.kind === "record_tuple")
          .map((record) => [record.key, record]),
      );
      const plan = isolated.plan;
      applyStateMaterializationPlan(plan, process.cwd());
      const recordTuplePaths = plan.publishPaths.filter(isRecordTupleProjectionPath);
      const regularPaths = plan.publishPaths.filter((path) => !isRecordTupleProjectionPath(path));
      if (regularPaths.length > 0) {
        publishCommit({
          message: STATE_MATERIALIZER_COMMIT_MESSAGE,
          paths: regularPaths,
          branch,
          maxAttempts: publishMaxAttempts,
          pushAttempts: publishPushAttempts,
        });
      }
      if (recordTuplePaths.length > 0) {
        publishCommit({
          message: STATE_MATERIALIZER_COMMIT_MESSAGE,
          paths: recordTuplePaths,
          branch,
          maxAttempts: publishMaxAttempts,
          pushAttempts: publishPushAttempts,
          rebaseStrategy: "reconcile-records",
          shallowHistoryExhaustionStrategy: shallowHistoryExhaustionStrategyForRecords(
            drain.records,
          ),
          onRecordTupleFailure: ({ key, reason }) => {
            const record = tupleRecordsByKey.get(key);
            if (!record) {
              throw new Error(`git publisher isolated an unknown record tuple: ${key}`);
            }
            if (publicationFailureSeqs.has(record.seq)) return;
            publicationFailureSeqs.add(record.seq);
            failures.push({
              seq: record.seq,
              key,
              reason: materializationFailureReason(reason),
              retryable: false,
            });
          },
        });
      }
      summary.committed += plan.selected - publicationFailureSeqs.size;
      summary.skipped += selected.skipped + hydrated.skipped + plan.skipped;
      summary.errors += failures.length;
      for (const failure of failures) {
        console.warn(
          `state-materializer isolated ${failure.retryable ? "retryable" : "terminal"} record ${failure.key} seq=${failure.seq}: ${failure.reason}`,
        );
      }

      const disposition =
        failures.length > 0
          ? await disposeStateWindow({
              queueUrl,
              webhookSecret,
              drainToken: drain.token,
              failures,
              fetchImpl,
            })
          : {
              acked: await ackStateWindow({
                queueUrl,
                webhookSecret,
                drainToken: drain.token,
                fetchImpl,
              }),
              retried: 0,
              deadLettered: 0,
            };
      const acked = disposition.acked;
      if (acked > drain.records.length) {
        throw new Error(`state ack count ${acked} exceeded drained count ${drain.records.length}`);
      }
      if (acked < drain.records.length) {
        // An expired drain lease re-exposes the rows for the next cycle and a
        // re-materialization of already-applied records commits nothing, so a
        // partial ack is re-delivery by design, not a failure.
        console.warn(
          `state ack count ${acked} was below drained count ${drain.records.length}; rows re-drain next cycle`,
        );
      }
      summary.acked += acked;
      if (disposition.retried > 0 || disposition.deadLettered > 0) {
        console.warn(
          `state-materializer disposition: retried=${disposition.retried} dead_lettered=${disposition.deadLettered}`,
        );
      }
    } catch (error) {
      summary.errors += 1;
      const message = errorMessage(error);
      console.warn(`state-materializer cycle failed: ${message}`);
      if (error instanceof GitShallowHistoryExhaustionError) {
        if (!drain.token) throw new Error("shallow-history deferral has no drain token");
        const disposition = await disposeStateWindow({
          queueUrl,
          webhookSecret,
          drainToken: drain.token,
          failures: drain.records.map((record) => ({
            seq: record.seq,
            key: record.key,
            reason: SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION,
            retryable: true,
          })),
          fetchImpl,
        });
        summary.acked += disposition.acked;
        console.warn(
          `state-materializer shallow-history deferral disposition: retried=${disposition.retried} dead_lettered=${disposition.deadLettered}`,
        );
        finish();
        throw new Error(stateMaterializerDeferralMessage(summary, message));
      }
      if (message.includes("deferred to the next run")) {
        finish();
        throw new Error(stateMaterializerDeferralMessage(summary, message));
      }
      break;
    }
  }
  return finish();
}

export function shallowHistoryExhaustionStrategyForRecords(
  records: readonly StateAppendRecord[],
): ShallowHistoryExhaustionStrategy {
  // The queue persists both fields through /state/dispose. Requiring the same
  // last error keeps an unrelated retry from escalating this recovery phase.
  return records.some(
    (record) =>
      (record.materialization_attempts ?? 0) > 0 &&
      record.materialization_last_error === SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION,
  )
    ? "rebuild-on-remote-head"
    : "defer";
}

export function stateMaterializerDeferralMessage(
  summary: StateMaterializerSummary,
  reason: string,
): string {
  const outcome = summary.committed > 0 ? "progress with deferral" : "stalled cycle with deferral";
  return `state-materializer ${outcome}: drained=${summary.drained} committed=${summary.committed} acked=${summary.acked} skipped=${summary.skipped} errors=${summary.errors}; ${reason}`;
}

function planStateMaterializationWithIsolation(
  records: readonly StateAppendRecord[],
  currentFiles: ReadonlyMap<string, string>,
): { plan: StateMaterializationPlan; failures: StateMaterializationFailure[] } {
  const staged = new Map(currentFiles);
  const publishPaths: string[] = [];
  const failures: StateMaterializationFailure[] = [];
  let selected = 0;
  let skipped = 0;

  for (const record of records) {
    try {
      const recordPlan = planStateMaterialization([record], staged);
      for (const path of recordPlan.deletes) staged.delete(path);
      for (const write of recordPlan.writes) staged.set(write.path, write.content);
      for (const path of recordPlan.publishPaths) {
        if (!publishPaths.includes(path)) publishPaths.push(path);
      }
      selected += recordPlan.selected;
      skipped += recordPlan.skipped;
    } catch (error) {
      if (record.kind !== "record_tuple") throw error;
      failures.push({
        seq: record.seq,
        key: record.key,
        reason: materializationFailureReason(error),
        retryable: false,
      });
    }
  }

  return {
    plan: {
      deletes: publishPaths.filter((path) => currentFiles.has(path) && !staged.has(path)).sort(),
      publishPaths,
      writes: publishPaths.flatMap((path) => {
        const content = staged.get(path);
        return content !== undefined && currentFiles.get(path) !== content
          ? [{ path, content }]
          : [];
      }),
      selected,
      skipped,
    },
    failures,
  };
}

export function applyStateMaterializationPlan(plan: StateMaterializationPlan, root: string): void {
  const resolvedRoot = resolve(root);
  for (const path of plan.deletes) {
    const target = resolve(resolvedRoot, path);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`refusing state deletion outside checkout: ${path}`);
    }
    rmSync(target, { force: true });
  }
  for (const write of plan.writes) {
    const target = resolve(resolvedRoot, write.path);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`refusing state materialization outside checkout: ${write.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.content, "utf8");
  }
}

function materializationPaths(records: readonly StateAppendRecord[]): string[] {
  const paths: string[] = [];
  for (const record of records) {
    if (record.kind === "record_tuple") {
      const tuple = recordTupleProjection(record);
      const tuplePaths = recordTuplePaths({
        repository: tuple.operations[0]!.repoSlug,
        number: String(tuple.operations[0]!.itemId),
      });
      for (const recordPath of [
        tuplePaths.item,
        tuplePaths.closed,
        tuplePaths.plan,
        tuplePaths.packet,
      ]) {
        if (!paths.includes(recordPath)) paths.push(recordPath);
      }
      continue;
    }
    const path =
      record.kind === "sweep_status"
        ? sweepStatusPathForStateKey(record.key)
        : record.kind === "comment_router"
          ? [COMMENT_ROUTER_LEDGER_PATH, COMMENT_ROUTER_LATEST_REPORT_PATH]
          : record.key;
    const recordPaths = Array.isArray(path) ? path : [path];
    if (record.kind === "apply_proof" && !isActionEventPublishPath(recordPaths[0]!)) {
      throw new Error(`invalid apply proof ledger path: ${recordPaths[0]}`);
    }
    for (const recordPath of recordPaths) {
      if (!paths.includes(recordPath)) paths.push(recordPath);
    }
  }
  return paths;
}

function readCurrentFiles(paths: readonly string[], root: string): Map<string, string> {
  const resolvedRoot = resolve(root);
  const files = new Map<string, string>();
  for (const path of paths) {
    const target = resolve(resolvedRoot, path);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`refusing state read outside checkout: ${path}`);
    }
    if (existsSync(target)) files.set(path, readFileSync(target, "utf8"));
  }
  return files;
}

async function hydrateRecordTupleRecords(options: {
  records: readonly StateAppendRecord[];
  queueUrl: string;
  webhookSecret: string;
  fetchImpl: typeof fetch;
}): Promise<{
  records: StateAppendRecord[];
  skipped: number;
  failures: StateMaterializationFailure[];
}> {
  const records: StateAppendRecord[] = [];
  const failures: StateMaterializationFailure[] = [];
  let skipped = 0;
  for (const record of options.records) {
    if (record.kind !== "record_tuple") {
      records.push(record);
      continue;
    }
    try {
      const tuple = recordTupleProjection(record);
      const operations: RecordTupleProjectionOperation[] = [];
      let superseded = false;
      for (const operation of tuple.operations) {
        if (!operation.oversize) {
          operations.push(operation);
          continue;
        }
        const fetched = await fetchCanonicalRecord({
          queueUrl: options.queueUrl,
          webhookSecret: options.webhookSecret,
          operation,
          fetchImpl: options.fetchImpl,
        });
        if (fetched.kind === "superseded") {
          superseded = true;
          break;
        }
        operations.push({ ...operation, content: fetched.content, oversize: false });
      }
      if (superseded) {
        skipped += 1;
        console.warn(`record tuple projection superseded before oversize fetch: ${record.key}`);
        continue;
      }
      records.push({ ...record, payload: { ...tuple, operations } });
    } catch (error) {
      failures.push({
        seq: record.seq,
        key: record.key,
        reason: materializationFailureReason(error),
        retryable: error instanceof RetryableStateMaterializationError,
      });
    }
  }
  return { records, skipped, failures };
}

class RetryableStateMaterializationError extends Error {}

async function fetchCanonicalRecord(options: {
  queueUrl: string;
  webhookSecret: string;
  operation: RecordTupleProjectionOperation;
  fetchImpl: typeof fetch;
}): Promise<{ kind: "fetched"; content: string } | { kind: "superseded" }> {
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update("").digest("hex")}`;
  const path = `/internal/state/records/${encodeURIComponent(options.operation.repoSlug)}/${options.operation.section}/${options.operation.itemId}`;
  let response: Response;
  try {
    response = await options.fetchImpl(`${options.queueUrl}${path}`, {
      method: "GET",
      headers: { "x-clawsweeper-exact-review-signature": signature },
    });
  } catch (error) {
    throw new RetryableStateMaterializationError(
      `GET ${path} failed transiently: ${errorMessage(error)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableStateMaterializationError(
        `GET ${path} returned ${response.status} with invalid JSON`,
      );
    }
    throw new Error(`GET ${path} returned invalid JSON`);
  }
  const revision = Number(body.revision);
  if (Number.isSafeInteger(revision) && revision > options.operation.revision) {
    return { kind: "superseded" };
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableStateMaterializationError(`GET ${path} returned ${response.status}`);
    }
    throw new Error(`GET ${path} returned ${response.status}`);
  }
  const content = body.content;
  const digest = String(body.digest || "");
  if (
    revision !== options.operation.revision ||
    typeof content !== "string" ||
    digest !== options.operation.digest
  ) {
    throw new Error(`canonical record fence mismatch for ${options.operation.path}`);
  }
  assertProjectedContent(options.operation, content);
  return { kind: "fetched", content };
}

function recordTupleProjection(record: StateAppendRecord): RecordTupleProjection {
  if (!isRecord(record.payload))
    throw new Error(`record tuple payload must be an object: ${record.key}`);
  const itemKey = String(record.payload.itemKey || "").trim();
  const revision = Number(record.payload.revision);
  const claimGeneration = Number(record.payload.claimGeneration);
  const itemMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(itemKey);
  if (
    !itemMatch ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(claimGeneration) ||
    claimGeneration < 1 ||
    !Array.isArray(record.payload.operations) ||
    record.payload.operations.length < 1 ||
    record.payload.operations.length > 4
  ) {
    throw new Error(`invalid record tuple projection fence: ${record.key}`);
  }
  const repoSlug = `${itemMatch[1]}-${itemMatch[2]}`;
  const itemId = Number(itemMatch[3]);
  if (record.key !== `${repoSlug}/${itemId}`) {
    throw new Error(`record tuple key does not match its item fence: ${record.key}`);
  }
  const seen = new Set<string>();
  const operations = record.payload.operations.map((value): RecordTupleProjectionOperation => {
    if (!isRecord(value))
      throw new Error(`record tuple operation must be an object: ${record.key}`);
    const hasContent = Object.hasOwn(value, "content");
    if (hasContent && typeof value.content !== "string") {
      throw new Error(`record tuple operation has invalid content: ${record.key}`);
    }
    const operation = {
      path: String(value.path || ""),
      repoSlug: String(value.repoSlug || ""),
      section: String(value.section || "") as RecordTupleProjectionOperation["section"],
      itemId: Number(value.itemId),
      digest: value.digest === null ? null : String(value.digest || ""),
      revision: Number(value.revision),
      bytes: Number(value.bytes),
      deleted: value.deleted === true,
      ...(hasContent ? { content: value.content as string } : {}),
      ...(Object.hasOwn(value, "oversize") ? { oversize: value.oversize === true } : {}),
    };
    const extension = operation.section === "decision-packets" ? "json" : "md";
    const expectedPath = `records/${repoSlug}/${operation.section}/${itemId}.${extension}`;
    if (
      operation.repoSlug !== repoSlug ||
      operation.itemId !== itemId ||
      operation.revision !== revision ||
      !["items", "closed", "plans", "decision-packets"].includes(operation.section) ||
      operation.path !== expectedPath ||
      seen.has(operation.path) ||
      !Number.isSafeInteger(operation.bytes) ||
      operation.bytes < 0 ||
      operation.bytes > 2 * 1024 * 1024
    ) {
      throw new Error(`invalid record tuple operation: ${operation.path || record.key}`);
    }
    seen.add(operation.path);
    if (operation.deleted) {
      if (
        operation.digest !== null ||
        operation.bytes !== 0 ||
        operation.content !== undefined ||
        operation.oversize
      ) {
        throw new Error(`invalid deleted record tuple operation: ${operation.path}`);
      }
      return operation;
    }
    if (!/^[a-f0-9]{64}$/.test(operation.digest || "")) {
      throw new Error(`invalid record tuple digest: ${operation.path}`);
    }
    if (operation.oversize) {
      if (operation.content !== undefined) {
        throw new Error(
          `oversize record tuple operation carried inline content: ${operation.path}`,
        );
      }
      return operation;
    }
    if (typeof operation.content !== "string") {
      throw new Error(`record tuple operation omitted content: ${operation.path}`);
    }
    assertProjectedContent(operation, operation.content);
    return operation;
  });
  return { itemKey, revision, claimGeneration, operations };
}

function recordTupleRevision(record: StateAppendRecord): number | null {
  if (!isRecord(record.payload)) return null;
  const revision = Number(record.payload.revision);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

function assertProjectedContent(operation: RecordTupleProjectionOperation, content: string): void {
  const bytes = Buffer.byteLength(content);
  const digest = createHash("sha256").update(content).digest("hex");
  if (bytes !== operation.bytes || digest !== operation.digest) {
    throw new Error(`record tuple content does not match its digest: ${operation.path}`);
  }
}

function isRecordTupleProjectionPath(path: string): boolean {
  return (
    /^records\/[^/]+\/(?:items|closed|plans)\/[^/]+\.md$/.test(path) ||
    /^records\/[^/]+\/decision-packets\/\d+\.json$/.test(path)
  );
}

async function drainStateWindow(options: {
  queueUrl: string;
  webhookSecret: string;
  maximumRows: number;
  maximumBytes: number;
  fetchImpl: typeof fetch;
}): Promise<StateDrainResponse> {
  const body = await postSignedStateRequest({
    ...options,
    path: "/internal/state/drain",
    payload: { max_rows: options.maximumRows, max_bytes: options.maximumBytes },
  });
  if (body.ok !== true || !Array.isArray(body.records)) {
    throw new Error("POST /internal/state/drain returned an invalid response");
  }
  const token = body.drain_token === null ? null : String(body.drain_token || "").trim();
  if (body.records.length > 0 && !token) {
    throw new Error("POST /internal/state/drain returned records without a token");
  }
  const records = body.records.map(stateAppendRecordFrom);
  selectLatestStateRecords(records);
  return { token, records };
}

async function ackStateWindow(options: {
  queueUrl: string;
  webhookSecret: string;
  drainToken: string;
  fetchImpl: typeof fetch;
}): Promise<number> {
  const body = await postSignedStateRequest({
    ...options,
    path: "/internal/state/ack",
    payload: { drain_token: options.drainToken },
  });
  const acked = Number(body.acked);
  if (body.ok !== true || !Number.isSafeInteger(acked) || acked < 0) {
    throw new Error("POST /internal/state/ack returned an invalid response");
  }
  return acked;
}

async function disposeStateWindow(options: {
  queueUrl: string;
  webhookSecret: string;
  drainToken: string;
  failures: readonly StateMaterializationFailure[];
  fetchImpl: typeof fetch;
}): Promise<{ acked: number; retried: number; deadLettered: number }> {
  const body = await postSignedStateRequest({
    ...options,
    path: "/internal/state/dispose",
    payload: {
      drain_token: options.drainToken,
      failures: options.failures.map((failure) => ({
        seq: failure.seq,
        reason: failure.reason,
        retryable: failure.retryable,
      })),
    },
  });
  const acked = Number(body.acked);
  const retried = Number(body.retried);
  const deadLettered = Number(body.dead_lettered);
  if (
    body.ok !== true ||
    !Number.isSafeInteger(acked) ||
    acked < 0 ||
    !Number.isSafeInteger(retried) ||
    retried < 0 ||
    !Number.isSafeInteger(deadLettered) ||
    deadLettered < 0
  ) {
    throw new Error("POST /internal/state/dispose returned an invalid response");
  }
  return { acked, retried, deadLettered };
}

async function postSignedStateRequest(options: {
  queueUrl: string;
  webhookSecret: string;
  path: string;
  payload: unknown;
  fetchImpl: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = JSON.stringify(options.payload);
  const signature = `sha256=${createHmac("sha256", options.webhookSecret)
    .update(body)
    .digest("hex")}`;
  const response = await options.fetchImpl(`${options.queueUrl}${options.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`POST ${options.path} returned ${response.status}`);
  const value = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(value)) throw new Error(`POST ${options.path} returned invalid JSON`);
  return value;
}

function stateAppendRecordFrom(value: unknown): StateAppendRecord {
  if (!isRecord(value)) throw new Error("state drain record must be an object");
  if (!Object.hasOwn(value, "payload")) throw new Error("state drain record has no payload");
  const record = {
    seq: Number(value.seq),
    kind: String(value.kind || "") as StateAppendKind,
    key: String(value.key || "").trim(),
    payload: value.payload,
    produced_at: String(value.produced_at || "").trim(),
    delivery_id: String(value.delivery_id || "").trim(),
    ...(Object.hasOwn(value, "materialization_attempts")
      ? { materialization_attempts: Number(value.materialization_attempts) }
      : {}),
    ...(Object.hasOwn(value, "materialization_last_error")
      ? { materialization_last_error: String(value.materialization_last_error || "").trim() }
      : {}),
  };
  assertStateAppendRecord(record);
  return record;
}

function assertStateAppendRecord(record: StateAppendRecord): void {
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error("state drain record has an invalid sequence");
  }
  if (!STATE_APPEND_KINDS.has(record.kind)) {
    throw new Error(`state drain record has an invalid kind: ${record.kind}`);
  }
  if (!record.key || record.key.length > 2_048) {
    throw new Error("state drain record has an invalid key");
  }
  if (record.payload === undefined) throw new Error("state drain record has no payload");
  if (!record.produced_at || !Number.isFinite(Date.parse(record.produced_at))) {
    throw new Error("state drain record has an invalid produced_at");
  }
  if (!record.delivery_id) throw new Error("state drain record has no delivery_id");
  if (
    record.materialization_attempts !== undefined &&
    (!Number.isSafeInteger(record.materialization_attempts) || record.materialization_attempts < 0)
  ) {
    throw new Error("state drain record has invalid materialization attempts");
  }
  if (
    record.materialization_last_error !== undefined &&
    (!record.materialization_last_error ||
      record.materialization_last_error.length > 2_000 ||
      record.materialization_last_error.includes("\r") ||
      record.materialization_last_error.includes("\n") ||
      record.materialization_last_error.includes(String.fromCharCode(0)))
  ) {
    throw new Error("state drain record has invalid materialization last error");
  }
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactStateSecrets(message);
}

function materializationFailureReason(error: unknown): string {
  return errorMessage(error)
    .replaceAll("\u0000", " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .slice(0, 2_000);
}

let stateSecretsToRedact: string[] = [];

function registerStateSecretForRedaction(secret: string): void {
  if (secret && !stateSecretsToRedact.includes(secret)) stateSecretsToRedact.push(secret);
}

// Error text can transit request internals; never let a registered secret
// value reach the log stream in clear text.
function redactStateSecrets(message: string): string {
  let redacted = message;
  for (const secret of stateSecretsToRedact) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runStateMaterializer();
    if (summary.errors > 0) process.exitCode = 1;
  } catch (error) {
    console.warn(`state-materializer failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
