#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LooseRecord } from "./json-types.js";

import {
  actionLedgerJson,
  parseActionEventShardContent,
  validateActionEvent,
} from "../action-ledger.js";
import { isActionEventPublishPath } from "../action-ledger-paths.js";
import { mergeCommentRouterLedgers } from "./comment-router-ledger-merge.js";
import {
  dispatchClaimDecision,
  hasSuccessfulDispatchExecutionJob,
} from "./comment-router-utils.js";
import { ghJson } from "./github-cli.js";
import {
  GitShallowHistoryExhaustionError,
  publishMainCommit,
  SHALLOW_MERGE_BASE_EXHAUSTION_DISPOSITION,
  type ShallowHistoryExhaustionStrategy,
} from "./git-publish.js";
import { liveWorkerCapacity } from "./live-worker-capacity.js";
import { workerLimit } from "./limits.js";
import {
  convergeRecordTupleSidecars,
  recordTuplePaths,
  validateRecordTuple,
  type RecordTupleContents,
} from "./record-tuple.js";
import { mergeSweepStatusJson } from "./sweep-status-merge.js";
import {
  clusterDispatchAuthenticationTag,
  clusterIntakeIntent,
  clusterIntakeLedger,
  clusterWorkflowDispatchInputs,
  CLUSTER_INTAKE_LEDGER_SCHEMA,
  markClusterIntakeDispatchClaimed,
  markClusterIntakeDispatched,
  mergeClusterIntakeLedger,
  mergeClusterSelectorDecisionLedger,
  validateClusterJobContent,
  verifyClusterLedgerEntryAcceptedIntent,
  type ClusterIntakeIntent,
  type ClusterIntakeLedger,
  type ClusterLedgerEntry,
} from "./cluster-intake-state.js";

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
  "cluster_intake",
]);

export type StateAppendKind =
  | "sweep_status"
  | "comment_router"
  | "apply_proof"
  | "record_tuple"
  | "cluster_intake";

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
  clusterCapacity?: (options: Record<string, unknown>) => {
    active: number;
    max_live_workers: number;
  };
  clusterDispatchObserver?: ClusterDispatchObserver;
};

export type ClusterDispatchObservation = {
  action: "dispatch" | "wait" | "recover";
  run: LooseRecord | null;
};

export type ClusterDispatchObserver = (
  entry: ClusterLedgerEntry,
  env: NodeJS.ProcessEnv,
) => ClusterDispatchObservation;

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

    if (record.kind === "cluster_intake") {
      const intent = clusterIntakeIntent(record.payload);
      const ledgerPath = clusterIntakeLedgerPath(intent);
      const sameRepository = selected.records
        .filter((candidate) => candidate.kind === "cluster_intake")
        .map((candidate) => clusterIntakeIntent(candidate.payload))
        .filter((candidate) => candidate.target_repo === intent.target_repo);
      const ledger = mergeClusterIntakeLedger(currentFiles.get(ledgerPath), sameRepository);
      contentByPath.set(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      addPublishPath(ledgerPath);
      const selectorLedgerPath = clusterSelectorDecisionLedgerPath(intent);
      const selectorLedger = mergeClusterSelectorDecisionLedger(
        currentFiles.get(selectorLedgerPath),
        sameRepository,
      );
      if (selectorLedger) {
        contentByPath.set(selectorLedgerPath, `${JSON.stringify(selectorLedger, null, 2)}\n`);
        addPublishPath(selectorLedgerPath);
      }
      for (const job of intent.jobs) {
        const accepted = ledger.clusters[String(job.cluster_id)];
        if (
          accepted?.job !== job.path ||
          accepted.dispatch_key !== job.dispatch_key ||
          accepted.digest !== job.digest
        ) {
          continue;
        }
        const current = currentFiles.get(job.path);
        if (current !== undefined && current !== job.content) {
          throw new Error(`cluster intake job already has different content: ${job.path}`);
        }
        contentByPath.set(job.path, job.content);
        addPublishPath(job.path);
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
  const clusterCapacity = reserveClusterCapacity(options.clusterCapacity ?? liveWorkerCapacity);
  const clusterDispatchObserver = options.clusterDispatchObserver ?? observeClusterDispatch;
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

  // A durable dispatch claim must be published before the workflow_dispatch
  // side effect so a crash between the two redispatches through recovery
  // instead of losing the claim.
  const persistClusterClaim = (ledgerPath: string): void => {
    publishCommit({
      message: STATE_MATERIALIZER_COMMIT_MESSAGE,
      paths: [ledgerPath],
      branch,
      maxAttempts: publishMaxAttempts,
      pushAttempts: publishPushAttempts,
    });
  };

  try {
    const recovered = recoverPendingClusterIntakes(
      process.cwd(),
      env,
      clusterCapacity,
      clusterDispatchObserver,
      persistClusterClaim,
    );
    if (recovered.updatedLedgers.length > 0) {
      publishCommit({
        message: STATE_MATERIALIZER_COMMIT_MESSAGE,
        paths: recovered.updatedLedgers,
        branch,
        maxAttempts: publishMaxAttempts,
        pushAttempts: publishPushAttempts,
      });
    }
  } catch (error) {
    // A durable pending ledger is an independent retry source. Report the
    // dispatch failure, but keep draining unrelated state instead of turning
    // worker capacity or Actions availability into a global publication lock.
    summary.errors += 1;
    console.warn(`cluster intake recovery failed: ${errorMessage(error)}`);
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
      const isolatedSeqs = new Set(failures.map((failure) => failure.seq));
      const clusterIntakes = hydrated.records
        .filter((record) => record.kind === "cluster_intake" && !isolatedSeqs.has(record.seq))
        .map((record) => clusterIntakeIntent(record.payload));
      if (clusterIntakes.length > 0) {
        try {
          const dispatch = dispatchClusterIntakes(
            clusterIntakes,
            process.cwd(),
            env,
            clusterCapacity,
            clusterDispatchObserver,
            persistClusterClaim,
          );
          if (dispatch.updatedLedgers.length > 0) {
            publishCommit({
              message: STATE_MATERIALIZER_COMMIT_MESSAGE,
              paths: dispatch.updatedLedgers,
              branch,
              maxAttempts: publishMaxAttempts,
              pushAttempts: publishPushAttempts,
            });
          }
          if (dispatch.pending) {
            console.warn("cluster intake remains durably pending until worker capacity frees");
          }
        } catch (error) {
          summary.errors += 1;
          console.warn(`cluster intake dispatch deferred: ${errorMessage(error)}`);
        }
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

export function reserveClusterCapacity(
  capacity: (options: Record<string, unknown>) => {
    active: number;
    max_live_workers: number;
  },
): (options: Record<string, unknown>) => { active: number; max_live_workers: number } {
  let reserved = 0;
  return (options) => {
    const snapshot = capacity(options);
    const maximum = Math.max(0, Math.floor(Number(snapshot.max_live_workers) || 0));
    const visibleActive = Math.max(0, Math.floor(Number(snapshot.active) || 0));
    const effectiveActive = Math.min(maximum, visibleActive + reserved);
    const requested = Math.max(0, Math.floor(Number(options.requested) || 0));
    reserved += Math.min(requested, Math.max(0, maximum - effectiveActive));
    return { active: effectiveActive, max_live_workers: maximum };
  };
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
      // Malformed cluster intents are isolated per row like corrupt record
      // tuples: one poison row dead-letters alone instead of re-failing the
      // whole drain on every cycle.
      if (record.kind !== "record_tuple" && record.kind !== "cluster_intake") throw error;
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
    if (record.kind === "cluster_intake") {
      // A malformed intent contributes no paths here; the per-row isolation in
      // the planning phase dead-letters it without failing the batch.
      let intent: ClusterIntakeIntent;
      try {
        intent = clusterIntakeIntent(record.payload);
      } catch {
        continue;
      }
      for (const recordPath of [
        clusterIntakeLedgerPath(intent),
        clusterSelectorDecisionLedgerPath(intent),
        ...intent.jobs.map((job) => job.path),
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

export function dispatchClusterIntakes(
  intents: readonly ClusterIntakeIntent[],
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  capacity: (options: Record<string, unknown>) => {
    active: number;
    max_live_workers: number;
  } = liveWorkerCapacity,
  observe: ClusterDispatchObserver = observeClusterDispatch,
  persistClaim?: (ledgerPath: string) => void,
): { updatedLedgers: string[]; pending: boolean } {
  const updatedLedgers: string[] = [];
  let pending = false;
  const byRepository = new Map<string, ClusterIntakeIntent[]>();
  for (const intent of intents) {
    const values = byRepository.get(intent.target_repo) ?? [];
    values.push(intent);
    byRepository.set(intent.target_repo, values);
  }
  for (const repositoryIntents of byRepository.values()) {
    const ledgerPath = clusterIntakeLedgerPath(repositoryIntents[0]!);
    const absoluteLedger = resolve(root, ledgerPath);
    const ledger = mergeClusterIntakeLedger(
      readFileSync(absoluteLedger, "utf8"),
      repositoryIntents,
    );
    const dispatch = dispatchClusterLedger(
      ledgerPath,
      ledger,
      root,
      env,
      capacity,
      observe,
      persistClaim,
      false,
    );
    if (dispatch.updated) updatedLedgers.push(ledgerPath);
    pending ||= dispatch.pending;
  }
  return { updatedLedgers, pending };
}

export function recoverPendingClusterIntakes(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  capacity: (options: Record<string, unknown>) => {
    active: number;
    max_live_workers: number;
  } = liveWorkerCapacity,
  observe: ClusterDispatchObserver = observeClusterDispatch,
  persistClaim?: (ledgerPath: string) => void,
): { updatedLedgers: string[]; pending: boolean } {
  const ledgerRoot = resolve(root, "results/cluster-repair-intake");
  if (!existsSync(ledgerRoot)) return { updatedLedgers: [], pending: false };
  const updatedLedgers: string[] = [];
  let pending = false;
  for (const name of readdirSync(ledgerRoot)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const ledgerPath = `results/cluster-repair-intake/${name}`;
    const parsed = JSON.parse(readFileSync(resolve(root, ledgerPath), "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schema?: unknown }).schema !== CLUSTER_INTAKE_LEDGER_SCHEMA
    ) {
      continue;
    }
    // The git checkout is projection, never dispatch authority: a ledger that
    // fails the strict v2 contract is skipped instead of blessed, and the
    // durable queue remains the source that can rebuild it.
    let ledger: ClusterIntakeLedger;
    try {
      ledger = clusterIntakeLedger(parsed);
    } catch (error) {
      console.warn(
        `cluster intake recovery skipped unverifiable ledger ${ledgerPath}: ${errorMessage(error)}`,
      );
      continue;
    }
    const dispatch = dispatchClusterLedger(
      ledgerPath,
      ledger,
      root,
      env,
      capacity,
      observe,
      persistClaim,
      true,
    );
    if (dispatch.updated) updatedLedgers.push(ledgerPath);
    pending ||= dispatch.pending;
  }
  return { updatedLedgers, pending };
}

function dispatchClusterLedger(
  ledgerPath: string,
  ledger: ClusterIntakeLedger,
  root: string,
  env: NodeJS.ProcessEnv,
  capacity: (options: Record<string, unknown>) => {
    active: number;
    max_live_workers: number;
  },
  observe: ClusterDispatchObserver,
  persistClaim: ((ledgerPath: string) => void) | undefined,
  recoverUnclaimed: boolean,
): { updated: boolean; pending: boolean } {
  const repoSlug = ledger.target_repo.replace("/", "-");
  const dispatchSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  const unresolvedJobs = Object.values(ledger.clusters)
    .filter((entry) => entry.status !== "dispatched")
    .sort(
      (left, right) =>
        left.accepted_at.localeCompare(right.accepted_at) || left.cluster_id - right.cluster_id,
    )
    .map((entry) => {
      // Git ledger and job files are projection, not authority. Only entries
      // carrying the HMAC accepted-intent receipt minted when the durable
      // append was accepted may reach dispatch; hand-written or corrupted
      // state fails closed here instead of being blessed with a fresh
      // materializer signature.
      verifyClusterLedgerEntryAcceptedIntent(dispatchSecret, ledger.target_repo, entry);
      if (
        entry.dispatch_key !== `cluster-intake:${repoSlug}:${entry.cluster_id}` ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(entry.runner) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(entry.execution_runner) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(entry.model)
      ) {
        throw new Error(`invalid unresolved cluster dispatch metadata: ${entry.cluster_id}`);
      }
      const absoluteJob = resolve(root, entry.job);
      const resolvedRoot = resolve(root);
      if (
        absoluteJob === resolvedRoot ||
        !absoluteJob.startsWith(`${resolvedRoot}${sep}`) ||
        !existsSync(absoluteJob)
      ) {
        throw new Error(`unresolved cluster job is missing or outside checkout: ${entry.job}`);
      }
      const content = readFileSync(absoluteJob, "utf8");
      if (createHash("sha256").update(content).digest("hex") !== entry.digest) {
        throw new Error(`unresolved cluster job digest mismatch: ${entry.job}`);
      }
      validateClusterJobContent(content, ledger.target_repo, entry.cluster_id);
      return {
        cluster_id: entry.cluster_id,
        path: entry.job,
        content,
        digest: entry.digest,
        dispatch_key: entry.dispatch_key,
        accepted_intent_digest: entry.accepted_intent_digest,
        accepted_intent_receipt: entry.accepted_intent_receipt,
        runner: entry.runner,
        execution_runner: entry.execution_runner,
        model: entry.model,
        ledgerEntry: entry,
      };
    });
  let pending = false;
  let ledgerUpdated = false;
  let workingLedger = ledger;
  const dispatchableJobs = [] as (typeof unresolvedJobs)[number][];
  for (const job of unresolvedJobs) {
    if (job.ledgerEntry.status === "dispatch_pending" && !recoverUnclaimed) {
      dispatchableJobs.push(job);
      continue;
    }
    const observationEntry =
      job.ledgerEntry.status === "dispatch_pending"
        ? { ...job.ledgerEntry, dispatch_claimed_at: job.ledgerEntry.accepted_at }
        : job.ledgerEntry;
    if (!observationEntry.dispatch_claimed_at) {
      throw new Error(`cluster dispatch claim has no timestamp: ${job.cluster_id}`);
    }
    const observation = observe(observationEntry, env);
    if (observation.action === "recover") {
      const runId = Number(observation.run?.id ?? observation.run?.databaseId ?? 0);
      workingLedger = markClusterIntakeDispatched(workingLedger, [job], new Date().toISOString(), {
        ...(Number.isSafeInteger(runId) && runId > 0 ? { id: runId } : {}),
        ...(observation.run?.url || observation.run?.html_url
          ? { url: String(observation.run.url ?? observation.run.html_url) }
          : {}),
      });
      ledgerUpdated = true;
      continue;
    }
    if (observation.action === "wait") {
      pending = true;
      continue;
    }
    dispatchableJobs.push(job);
  }
  let jobsToDispatch = dispatchableJobs;
  if (dispatchableJobs.length > 0) {
    const workerCapacity = capacity({
      repo: env.CLAWSWEEPER_REPO || "openclaw/clawsweeper",
      workflow: "repair-cluster-worker.yml",
      requested: dispatchableJobs.length,
      maxLiveWorkers: workerLimit("cluster_repair"),
      env,
    });
    const available = Math.max(0, workerCapacity.max_live_workers - workerCapacity.active);
    jobsToDispatch = dispatchableJobs.slice(0, available);
    pending ||= jobsToDispatch.length < dispatchableJobs.length;
  }
  if (jobsToDispatch.length > 0) {
    // The claim is persisted and published before the workflow_dispatch side
    // effect. GitHub gives no atomic run receipt, so this is at-least-once
    // workflow creation: a crash in the window between publication and
    // dispatch redispatches through recovery, and the worker-side receipt
    // gate keeps worker execution intent exactly-once.
    workingLedger = markClusterIntakeDispatchClaimed(
      workingLedger,
      jobsToDispatch,
      new Date().toISOString(),
    );
    ledgerUpdated = true;
    pending = true;
  }
  if (ledgerUpdated) {
    writeFileSync(resolve(root, ledgerPath), `${JSON.stringify(workingLedger, null, 2)}\n`, "utf8");
  }
  if (jobsToDispatch.length > 0) {
    persistClaim?.(ledgerPath);
  }
  for (const job of jobsToDispatch) {
    const jobAuthentication = clusterDispatchAuthenticationTag(dispatchSecret, {
      jobPath: job.path,
      jobDigest: job.digest,
      dispatchKey: job.dispatch_key,
      mode: "autonomous",
      runner: job.runner,
      executionRunner: job.execution_runner,
      plannerSandbox: "read-only",
      model: job.model,
      dryRun: "false",
    });
    const dispatchInputs = clusterWorkflowDispatchInputs(job, {
      runner: job.runner,
      executionRunner: job.execution_runner,
      model: job.model,
      jobAuth: jobAuthentication,
    });
    const result = spawnSync(
      "gh",
      [
        "workflow",
        "run",
        "repair-cluster-worker.yml",
        "--repo",
        env.CLAWSWEEPER_REPO || "openclaw/clawsweeper",
        "--ref",
        env.CLAWSWEEPER_DISPATCH_REF || "main",
        ...Object.entries(dispatchInputs).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
      ],
      { cwd: root, encoding: "utf8", env, stdio: "pipe" },
    );
    if (result.status !== 0) {
      // The durable claim already covers this job; recovery observes the
      // missing run and redispatches after the claim grace window.
      throw new Error(
        `cluster intake dispatch failed for ${ledger.target_repo} cluster ${job.cluster_id}: ${result.stderr || result.stdout || result.status}`,
      );
    }
  }
  return { updated: ledgerUpdated, pending };
}

export function observeClusterDispatch(
  entry: ClusterLedgerEntry,
  env: NodeJS.ProcessEnv,
): ClusterDispatchObservation {
  const repo = env.CLAWSWEEPER_REPO || "openclaw/clawsweeper";
  const expectedTitle = `repair cluster ${entry.job} [${entry.dispatch_key}]`;
  const runs = ghJson<LooseRecord[]>(
    [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "repair-cluster-worker.yml",
      "--limit",
      "100",
      "--json",
      "databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url",
    ],
    { env },
  ).map((run) => {
    if (
      String(run.displayTitle ?? run.display_title ?? "") !== expectedTitle ||
      String(run.status ?? "").toLowerCase() !== "completed"
    ) {
      return run;
    }
    const runId = Number(run.databaseId ?? run.id ?? 0);
    if (!Number.isSafeInteger(runId) || runId < 1) {
      return { ...run, dispatch_execution_verified: false };
    }
    const response = ghJson<LooseRecord>(
      ["api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`],
      { env },
    );
    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    return {
      ...run,
      dispatch_execution_verified: hasSuccessfulDispatchExecutionJob(
        jobs,
        "Plan and review cluster",
      ),
    };
  });
  return dispatchClaimDecision({
    claim: { processed_at: entry.dispatch_claimed_at },
    runs,
    expectedTitle,
  }) as ClusterDispatchObservation;
}

function clusterIntakeLedgerPath(intent: ClusterIntakeIntent): string {
  return `results/cluster-repair-intake/${intent.repo_slug}.json`;
}

function clusterSelectorDecisionLedgerPath(intent: ClusterIntakeIntent): string {
  return `results/cluster-repair-intake/${intent.repo_slug}.selector-decisions-v1.json`;
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
