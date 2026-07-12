import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  prepareSafeWriteTarget,
  processIncarnationIdentitySha256,
  processIsDefunct,
  readDirectoryEntriesNoFollow,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  removeUtf8FileIfContentNoFollow,
  tryAcquireUtf8FileLockNoFollow,
  writeUtf8FileCreateOnlyNoFollow,
  type SafeReadRoot,
} from "./action-ledger-files.js";
import {
  ACTION_LEDGER_CANONICAL_JSON_LIMITS,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_SHARD_FILE_LIMITS,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionEventShardsReplayEquivalent,
  actionAttemptId,
  actionEventShardImportBindingRelativePaths,
  actionEventShardRelativePath,
  actionEventSpoolRelativePath,
  actionEventKey,
  actionIdempotencyKey,
  actionLedgerJson,
  actionOperationId,
  actionEventReplayJson,
  createActionEvent,
  isActionEventPhaseType,
  isActionEventReasonCode,
  isActionEventStatus,
  parseActionEventShardContent,
  readAllSpooledActionEvents,
  sortActionEventsCausally,
  validateActionEvent,
  writeActionEvent,
  writeActionEventShards,
  type ActionEvent,
  type ActionEventAction,
  type ActionEventAttributes,
  type ActionEventEvidence,
  type ActionEventInput,
  type ActionEventLearning,
  type ActionEventPrivacy,
  type ActionEventProducer,
  type ActionEventPhaseType,
  type ActionEventReasonCode,
  type ActionEventShardIdentity,
  type ActionEventStatus,
  type ActionEventSubject,
} from "./action-ledger.js";
import { normalizeRepo } from "./repository-profiles.js";

const DEFAULT_EVENT_OUTPUT_DIR = path.join(".clawsweeper-repair", "action-ledger-state");
const DEFAULT_CRABFLEET_BASE_URL = "https://crabfleet.openclaw.ai";
const DEFAULT_CRABFLEET_TIMEOUT_MS = 10_000;
const MAX_CRABFLEET_TIMEOUT_MS = 60_000;
const DEFAULT_CRABFLEET_FLUSH_TIMEOUT_MS = 10_000;
const MAX_CRABFLEET_FLUSH_TIMEOUT_MS = 60_000;
const ACTION_EVENT_SHARD_PATH_PATTERN =
  /^ledger\/v1\/events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/;
const ACTION_EVENT_IMPORT_BINDING_MAX_BYTES = 1024 * 1024;
const ACTION_EVENT_FINALIZATION_MAX_BYTES = 1024 * 1024;
const ACTION_EVENT_PARTITION_MARKER_MAX_BYTES = 64;
const ACTION_EVENT_PRODUCER_LOCK_MAX_BYTES = 1024;
const ACTION_EVENT_PRODUCER_LOCK_WAIT_MS = 10_000;
const pendingCrabFleetPosts = new Set<Promise<void>>();
const pendingWorkflowCrabFleetPosts = new Map<string, Set<Promise<void>>>();
const workflowCrabFleetRequests = new Map<string, Set<CrabFleetProjectionRequest>>();
const activeCrabFleetRequests = new Set<CrabFleetProjectionRequest>();
const queuedCrabFleetPosts = new Map<string, CrabFleetProjectionRequest[]>();
const queuedCrabFleetAdmissionOrder: string[] = [];
const DIRECT_CRABFLEET_ADMISSION_KEY = "\0direct";
let queuedCrabFleetPostCount = 0;
let nextCrabFleetAdmissionIndex = 0;
const producerLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export const CRABFLEET_PROJECTION_LIMITS = {
  maxConcurrent: 4,
  maxQueued: 64,
  maxTotalQueued: 256,
  maxQueuedRoots: 64,
  defaultFlushTimeoutMs: DEFAULT_CRABFLEET_FLUSH_TIMEOUT_MS,
  maxFlushTimeoutMs: MAX_CRABFLEET_FLUSH_TIMEOUT_MS,
} as const;

export const ACTION_EVENT_SHARD_IMPORT_LIMITS = {
  maxDepth: 6,
  maxEntriesPerDirectory: 512,
  maxDirectories: 512,
  maxFiles: 256,
  maxFileBytes: ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes,
  maxFileLines: 2_048,
  maxFileEvents: ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents,
  maxTotalBytes: 16 * 1024 * 1024,
  maxTotalEvents: 256 * ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents,
  maxCausalBindings: 256 * ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents,
} as const;

export type WorkflowActionEventInput = {
  scope: string;
  identity: unknown;
  operation?: string;
  operationIdentity?: unknown;
  attemptIdentity?: unknown;
  parentEventId?: string | null;
  phaseSeq?: number;
  idempotencyIdentity?: unknown;
  type: string;
  component: string;
  subject: ActionEventSubject;
  action: ActionEventAction;
  learning?: ActionEventLearning;
  evidence?: readonly ActionEventEvidence[];
  attributes?: ActionEventAttributes;
  privacy?: ActionEventPrivacy;
  occurredAt?: string;
};

export type WorkflowActionEventOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
};

export type WorkflowActionPhaseEventInput = Omit<
  WorkflowActionEventInput,
  "scope" | "type" | "action"
> & {
  phase: ActionEventPhaseType;
  status: ActionEventStatus;
  reasonCode?: ActionEventReasonCode;
  retryable: boolean;
  mutation: boolean;
};

export type ActionEventShardImportResult = {
  created: number;
  unchanged: number;
  paths: string[];
};

type ImportedActionEventShard = {
  relativePath: string;
  content: string;
  events: ActionEvent[];
  identity: ActionEventShardIdentity;
  shardIndex: number | undefined;
  shardCount: number | undefined;
};

type ActionEventShardImportBinding = {
  relativePath: string;
  content: string;
  label: string;
  kind: "reservation" | "completion";
};

type ImportedActionEventIdentityBinding = {
  schema: "clawsweeper.action-ledger-import-event";
  schema_version: 1;
  event_id: string;
  semantic_sha256: string;
  parent_event_id: string | null;
};

type CrabFleetProjectionRequest = {
  event: ActionEvent;
  config: CrabFleetProjectionConfig;
  fetchImpl: typeof fetch;
  admissionKey: string;
  rootKey?: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  done: boolean;
  handle?: CrabFleetPostHandle;
  queueTimer?: NodeJS.Timeout;
};

type CrabFleetProjectionConfig = {
  endpointUrl: string;
  token: string;
  timeoutMs: number;
};

type CrabFleetPostHandle = {
  result: Promise<void>;
  settled: Promise<void>;
  cleanupComplete: () => boolean;
  cancel: (error: Error) => void;
};

type WorkflowProducerFinalization = {
  schema: "clawsweeper.action-ledger-producer-finalization";
  schema_version: 1;
  producer: ActionEvent["producer"];
  partition_date: string;
  event_count: number;
  replay_sha256: string;
};

type ActionEventLock = {
  schema: "clawsweeper.action-ledger-producer-lock" | "clawsweeper.action-ledger-import-lock";
  schema_version: 1;
  pid: number;
  process_incarnation_sha256: string;
  acquired_at_ms: number;
  nonce: string;
};

export function workflowActionEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAWSWEEPER_ACTION_LEDGER_DISABLED === "1") return false;
  return env.CLAWSWEEPER_ACTION_LEDGER_FORCE === "1";
}

export function workflowActionProducer(
  component: string,
  env: NodeJS.ProcessEnv = process.env,
): ActionEventProducer {
  const repository = normalizeRepo(requiredEnv(env, "GITHUB_REPOSITORY"));
  if (!/^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9_][a-z0-9_.-]*$/.test(repository)) {
    throw new Error(`invalid GITHUB_REPOSITORY for action event telemetry: ${repository}`);
  }
  const workflowRef = String(env.GITHUB_WORKFLOW_REF ?? "").trim();
  const workflow = workflowRef
    ? machineIdentifier(path.posix.basename(workflowPathFromRef(workflowRef)), 128)
    : machineIdentifier(requiredEnv(env, "GITHUB_WORKFLOW"), 128);
  const step = machineIdentifier(String(env.GITHUB_ACTION ?? "process"), 64);
  const invocation = machineIdentifier(
    String(env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION ?? "default"),
    64,
  );
  return {
    repository,
    sha: requiredEnv(env, "GITHUB_SHA"),
    workflow,
    job: requiredEnv(env, "GITHUB_JOB"),
    runId: requiredEnv(env, "GITHUB_RUN_ID"),
    runAttempt: positiveIntegerEnv(env, "GITHUB_RUN_ATTEMPT"),
    component: `${machineIdentifier(component, 120)}.${step}.${invocation}`,
  };
}

export function recordWorkflowActionEvent(
  root: string,
  input: WorkflowActionEventInput,
  options: WorkflowActionEventOptions = {},
): ActionEvent | null {
  const env = options.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return null;
  if (input.action.mutation && input.idempotencyIdentity === undefined) {
    throw new Error("mutation action events require an explicit idempotencyIdentity");
  }
  const producer = workflowActionProducer(input.component, env);
  const operation = input.operation ?? input.scope.split(".", 1)[0] ?? input.scope;
  const operationId = actionOperationId(
    input.subject.repository,
    operation,
    input.operationIdentity ?? input.subject,
  );
  const attemptId = actionAttemptId(
    operationId,
    input.attemptIdentity ?? {
      repository: producer.repository,
      workflow: producer.workflow,
      runId: producer.runId,
      runAttempt: producer.runAttempt,
    },
  );
  const phaseSeq = input.phaseSeq ?? 1;
  const eventInput = {
    eventKey: actionEventKey(input.scope, {
      attemptId,
      phaseSeq,
      producer: {
        job: producer.job,
        component: producer.component,
      },
      identity: input.identity,
    }),
    operationId,
    attemptId,
    parentEventId: input.parentEventId ?? null,
    phaseSeq,
    idempotencyKeySha256: actionIdempotencyKey(
      input.idempotencyIdentity ?? {
        operationId,
        scope: input.scope,
        identity: input.identity,
      },
    ),
    type: input.type,
    producer,
    subject: input.subject,
    action: input.action,
    ...(input.learning ? { learning: input.learning } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
    ...(input.privacy ? { privacy: input.privacy } : {}),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  };
  const recordedAt = options.now ? options.now() : new Date();
  const writeOptions = { now: () => recordedAt };
  const candidate = createActionEvent(eventInput, writeOptions);
  const partitionDate = workflowPartitionDate(env);
  const event = withWorkflowProducerLock(root, candidate.producer, () => {
    assertWorkflowProducerAcceptsEvent(root, candidate);
    ensureWorkflowPartitionDateValue(root, persistedWorkflowProducer(producer), partitionDate);
    const persisted = writeActionEvent(root, eventInput, writeOptions).event;
    queueCrabFleetEvent(root, persisted, env, options.fetchImpl ?? fetch);
    return persisted;
  });
  return event;
}

export function recordWorkflowPhaseEvent(
  root: string,
  input: WorkflowActionPhaseEventInput,
  options: WorkflowActionEventOptions = {},
): ActionEvent | null {
  const phase = String(input.phase);
  const status = String(input.status);
  const reasonCode = input.reasonCode === undefined ? undefined : String(input.reasonCode);
  if (!isActionEventPhaseType(phase)) {
    throw new Error(`unknown action event phase type: ${phase}`);
  }
  if (!isActionEventStatus(status)) {
    throw new Error(`unknown action event status: ${status}`);
  }
  if (reasonCode !== undefined && !isActionEventReasonCode(reasonCode)) {
    throw new Error(`unknown action event reason code: ${reasonCode}`);
  }
  return recordWorkflowActionEvent(
    root,
    {
      scope: phase,
      identity: {
        phase,
        status,
        ...(reasonCode ? { reasonCode } : {}),
        identity: input.identity,
      },
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.operationIdentity === undefined
        ? {}
        : { operationIdentity: input.operationIdentity }),
      ...(input.attemptIdentity === undefined ? {} : { attemptIdentity: input.attemptIdentity }),
      ...(input.parentEventId === undefined ? {} : { parentEventId: input.parentEventId }),
      ...(input.phaseSeq === undefined ? {} : { phaseSeq: input.phaseSeq }),
      ...(input.idempotencyIdentity === undefined
        ? {}
        : { idempotencyIdentity: input.idempotencyIdentity }),
      type: phase,
      component: input.component,
      subject: input.subject,
      action: {
        name: phase,
        status,
        ...(reasonCode ? { reasonCode } : {}),
        retryable: input.retryable,
        mutation: input.mutation,
      },
      ...(input.learning ? { learning: input.learning } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(input.privacy ? { privacy: input.privacy } : {}),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    },
    options,
  );
}

export async function flushWorkflowActionEvents(
  root: string,
  options: {
    env?: NodeJS.ProcessEnv;
    outputRoot?: string;
    projectionFlushTimeoutMs?: number;
  } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return [];
  const safeRoot = prepareSafeReadRoot(root, "action event spool");
  const outputRoot =
    options.outputRoot ??
    env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT ??
    path.join(root, DEFAULT_EVENT_OUTPUT_DIR);
  const safeOutputRoot = prepareSafeReadRoot(outputRoot, "action event shard output");
  const paths = new Set(
    finalizeWorkflowActionEventSpool(safeRoot, safeOutputRoot, {
      includeProjectionFailures: false,
    }),
  );
  await flushPendingCrabFleetPostsForRoot(
    safeRoot.path,
    options.projectionFlushTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.projectionFlushTimeoutMs },
  );
  for (const relativePath of finalizeWorkflowActionEventSpool(safeRoot, safeOutputRoot)) {
    paths.add(relativePath);
  }
  return [...paths].sort();
}

function workflowActionEventIsRecoverableStart(event: ActionEvent): boolean {
  return (
    (event.event_type === ACTION_EVENT_TYPES.reviewBatch ||
      event.event_type === ACTION_EVENT_TYPES.reviewItem ||
      event.event_type === ACTION_EVENT_TYPES.applyBatch ||
      event.event_type === ACTION_EVENT_TYPES.applyAction) &&
    event.action.status === ACTION_EVENT_STATUSES.started
  );
}

function workflowActionEventClosesLifecycle(event: ActionEvent): boolean {
  if (event.action.status === ACTION_EVENT_STATUSES.started) return false;
  return !(
    event.event_type === ACTION_EVENT_TYPES.applyAction &&
    event.action.status === ACTION_EVENT_STATUSES.executed
  );
}

export function interruptOpenWorkflowActionEvents(
  root: string,
  options: {
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    fetchImpl?: typeof fetch;
    reasonCode?: ActionEventReasonCode;
  } = {},
): number {
  const env = options.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return 0;
  const reasonCode = options.reasonCode ?? ACTION_EVENT_REASON_CODES.timeout;
  if (reasonCode !== ACTION_EVENT_REASON_CODES.timeout) {
    throw new Error(`unsupported interrupted workflow action reason: ${reasonCode}`);
  }
  const safeRoot = prepareSafeReadRoot(root, "action event spool");
  const groups = [...groupWorkflowActionEvents(readAllSpooledActionEvents(safeRoot)).values()]
    .filter((group) => group.some(workflowActionEventIsRecoverableStart))
    .sort((left, right) => {
      const leftKey = actionLedgerJson(left[0]!.producer);
      const rightKey = actionLedgerJson(right[0]!.producer);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  let interrupted = 0;
  for (const group of groups) {
    const producer = group[0]!.producer;
    interrupted += withWorkflowProducerLock(root, producer, () => {
      const current = readAllSpooledActionEvents(safeRoot).filter(
        (event) => actionLedgerJson(event.producer) === actionLedgerJson(producer),
      );
      const starts = current
        .filter(workflowActionEventIsRecoverableStart)
        .sort((left, right) => left.phase_seq - right.phase_seq);
      let written = 0;
      for (const start of starts) {
        const lifecycleKey = workflowActionLifecycleKey(start);
        const lifecycleEvents = current.filter(
          (event) =>
            event.event_id !== start.event_id && workflowActionLifecycleKey(event) === lifecycleKey,
        );
        if (lifecycleEvents.some(workflowActionEventClosesLifecycle)) {
          continue;
        }
        const mutationEvents = current
          .filter(
            (event) =>
              event.operation_id === start.operation_id &&
              event.attempt_id === start.attempt_id &&
              event.action.mutation,
          )
          .sort(
            (left, right) =>
              left.phase_seq - right.phase_seq || left.event_id.localeCompare(right.event_id),
          );
        const lifecycleMutation = lifecycleEvents
          .filter((event) => event.action.mutation)
          .sort(
            (left, right) =>
              left.phase_seq - right.phase_seq || left.event_id.localeCompare(right.event_id),
          )
          .at(-1);
        const mutationOccurred =
          start.event_type === ACTION_EVENT_TYPES.applyBatch
            ? mutationEvents.length > 0
            : lifecycleMutation !== undefined;
        const parentEventId =
          start.event_type === ACTION_EVENT_TYPES.applyAction && lifecycleMutation
            ? lifecycleMutation.event_id
            : start.event_id;
        const eventInput: ActionEventInput = {
          eventKey: actionEventKey("workflow.interrupted", {
            startEventId: start.event_id,
            reasonCode,
            mutationOccurred,
          }),
          operationId: start.operation_id,
          attemptId: start.attempt_id,
          parentEventId,
          phaseSeq:
            start.event_type === ACTION_EVENT_TYPES.reviewBatch ||
            start.event_type === ACTION_EVENT_TYPES.applyBatch
              ? 1_000_000
              : start.phase_seq + 2,
          idempotencyKeySha256:
            start.event_type === ACTION_EVENT_TYPES.applyAction
              ? start.idempotency_key_sha256
              : actionIdempotencyKey({
                  operationId: start.operation_id,
                  slot: "interrupted_terminal",
                  eventType: start.event_type,
                  subject: workflowActionSubjectIdentity(start),
                }),
          type: start.event_type,
          producer: workflowActionProducerInput(start.producer),
          subject: workflowActionSubjectInput(start.subject),
          action: {
            name: start.event_type,
            status: ACTION_EVENT_STATUSES.failed,
            reasonCode,
            retryable: true,
            mutation: mutationOccurred,
          },
          ...(start.evidence === undefined
            ? {}
            : {
                evidence: start.evidence.map((entry) => ({
                  kind: entry.kind,
                  ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
                  ...(entry.report_path === undefined ? {} : { reportPath: entry.report_path }),
                  ...(entry.run_url === undefined ? {} : { runUrl: entry.run_url }),
                  ...(entry.snapshot_id === undefined ? {} : { snapshotId: entry.snapshot_id }),
                })),
              }),
          attributes: {
            completion_reason: "timeout",
            failed_count: 1,
            ...(mutationOccurred ? { action_count: 1 } : {}),
            partial: true,
          },
          privacy: {
            classification: start.privacy.classification,
            redactionVersion: start.privacy.redaction_version,
            fieldsDropped: start.privacy.fields_dropped,
          },
        };
        const writeOptions = { now: options.now ?? (() => new Date()) };
        const candidate = createActionEvent(eventInput, writeOptions);
        assertWorkflowProducerAcceptsEvent(root, candidate);
        const partitionDate = readWorkflowPartitionDate(safeRoot, start.producer);
        ensureWorkflowPartitionDateValue(root, start.producer, partitionDate);
        const event = writeActionEvent(root, eventInput, writeOptions).event;
        queueCrabFleetEvent(root, event, env, options.fetchImpl ?? fetch);
        current.push(event);
        written += 1;
      }
      return written;
    });
  }
  return interrupted;
}

function workflowActionLifecycleKey(event: ActionEvent): string {
  return actionLedgerJson({
    operationId: event.operation_id,
    attemptId: event.attempt_id,
    eventType: event.event_type,
    subject: workflowActionSubjectIdentity(event),
  });
}

function workflowActionSubjectIdentity(event: ActionEvent) {
  return {
    repository: event.subject.repository,
    kind: event.subject.kind,
    ...(event.subject.subject_id === undefined ? {} : { subjectId: event.subject.subject_id }),
    ...(event.subject.number === undefined ? {} : { number: event.subject.number }),
    ...(event.subject.cluster_id === undefined ? {} : { clusterId: event.subject.cluster_id }),
  };
}

function workflowActionProducerInput(producer: ActionEvent["producer"]): ActionEventProducer {
  return {
    repository: producer.repository,
    sha: producer.sha,
    workflow: producer.workflow,
    job: producer.job,
    runId: producer.run_id,
    runAttempt: producer.run_attempt,
    component: producer.component,
  };
}

function workflowActionSubjectInput(subject: ActionEvent["subject"]): ActionEventSubject {
  return {
    repository: subject.repository,
    kind: subject.kind,
    ...(subject.subject_id === undefined ? {} : { subjectId: subject.subject_id }),
    ...(subject.number === undefined ? {} : { number: subject.number }),
    ...(subject.cluster_id === undefined ? {} : { clusterId: subject.cluster_id }),
    ...(subject.source_revision === undefined ? {} : { sourceRevision: subject.source_revision }),
    ...(subject.record_path === undefined ? {} : { recordPath: subject.record_path }),
  };
}

function finalizeWorkflowActionEventSpool(
  safeRoot: SafeReadRoot,
  safeOutputRoot: SafeReadRoot,
  options: { includeProjectionFailures?: boolean } = {},
): string[] {
  const discovered = groupWorkflowActionEvents(readAllSpooledActionEvents(safeRoot));
  const producers = [...discovered.values()]
    .filter(
      (group) =>
        options.includeProjectionFailures !== false ||
        !group.every((event) => event.event_type === ACTION_EVENT_TYPES.projectionFailed),
    )
    .map((group) => group[0]!.producer);
  return withWorkflowProducerLocks(safeRoot.path, producers, () => {
    const current = groupWorkflowActionEvents(readAllSpooledActionEvents(safeRoot));
    const paths: string[] = [];
    for (const producer of producers) {
      const group = current.get(actionLedgerJson(producer)) ?? [];
      const ordered = sortActionEventsCausally(group);
      const first = ordered[0];
      if (!first) continue;
      const partitionDate = readWorkflowPartitionDate(safeRoot, first.producer);
      reserveWorkflowProducerFinalization(safeRoot, first.producer, partitionDate, ordered);
      const results = writeActionEventShards(
        safeOutputRoot.path,
        {
          repository: first.producer.repository,
          sha: first.producer.sha,
          producer: first.producer.component,
          workflow: first.producer.workflow,
          job: first.producer.job,
          runId: first.producer.run_id,
          runAttempt: first.producer.run_attempt,
          partitionDate,
        },
        ordered,
      );
      paths.push(...results.map((result) => result.relativePath));
    }
    return paths.sort();
  });
}

function groupWorkflowActionEvents(events: readonly ActionEvent[]): Map<string, ActionEvent[]> {
  const groups = new Map<string, ActionEvent[]>();
  for (const event of events) {
    const key = actionLedgerJson(event.producer);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return groups;
}

export async function flushPendingCrabFleetPosts(
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await flushCrabFleetProjectionPosts(
    () => pendingCrabFleetPosts,
    (error) => failPendingWorkflowCrabFleetRequests(error),
    options,
  );
}

async function flushPendingCrabFleetPostsForRoot(
  rootKey: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await flushCrabFleetProjectionPosts(
    () => pendingWorkflowCrabFleetPosts.get(rootKey) ?? new Set(),
    (error) => failPendingWorkflowCrabFleetRequests(error, rootKey),
    options,
  );
}

async function flushCrabFleetProjectionPosts(
  pendingPosts: () => ReadonlySet<Promise<void>>,
  failPending: (error: Error) => void,
  options: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = crabFleetFlushTimeoutMs(options.timeoutMs);
  let timeout: NodeJS.Timeout | undefined;
  const deadlineError = new Error(`CrabFleet projection flush timed out after ${timeoutMs}ms`);
  const deadline = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    while (pendingPosts().size > 0) {
      drainCrabFleetProjectionQueue();
      const pending = Promise.all(pendingPosts()).then(() => "settled" as const);
      if ((await Promise.race([pending, deadline])) === "timeout") {
        failPending(deadlineError);
        await Promise.all(pendingPosts());
        return;
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function postActionEventToCrabFleet(
  event: ActionEvent,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = crabFleetProjectionConfig(env);
  if (!config) return;
  await enqueueCrabFleetProjection(event, config, fetchImpl);
}

function startActionEventCrabFleetPost(
  event: ActionEvent,
  config: CrabFleetProjectionConfig,
  fetchImpl: typeof fetch,
): CrabFleetPostHandle {
  const validatedEvent = validateActionEvent(event, "CrabFleet action event");
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let cancelReject!: (error: Error) => void;
  let cancelled = false;
  let cleanupComplete = false;
  const timeoutError = new Error(
    `CrabFleet action event append timed out after ${config.timeoutMs}ms`,
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, config.timeoutMs);
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancelReject = reject;
  });
  const request = Promise.resolve().then(() =>
    fetchImpl(config.endpointUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventKey: validatedEvent.event_key,
        type: "clawsweeper.action",
        message: actionEventMessage(validatedEvent),
        payload: {
          version: 1,
          event: validatedEvent,
        },
      }),
      signal: controller.signal,
    }),
  );
  const requestAndCleanup = request
    .then(async (response) => {
      const result = { ok: response.ok, status: response.status };
      await cancelResponseBody(response);
      return result;
    })
    .finally(() => {
      cleanupComplete = true;
    });
  const result = Promise.race([requestAndCleanup, deadline, cancellation])
    .then((response) => {
      if (!response.ok) {
        throw new Error(`CrabFleet action event append failed (${response.status})`);
      }
    })
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  const settled = requestAndCleanup.then(
    () => undefined,
    () => undefined,
  );
  return {
    result,
    settled,
    cleanupComplete: () => cleanupComplete,
    cancel: (error) => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      cancelReject(error);
    },
  };
}

export function importActionEventShards(
  sourceRoot: string,
  destinationRoot: string,
): ActionEventShardImportResult {
  let safeSource: SafeReadRoot;
  try {
    safeSource = prepareSafeReadRoot(sourceRoot, "action event shard import source");
  } catch (error) {
    if (isNotFoundError(error)) return { created: 0, unchanged: 0, paths: [] };
    throw error;
  }
  let relativePaths: string[];
  try {
    relativePaths = collectActionEventShardFiles(safeSource);
  } catch (error) {
    if (isNotFoundError(error)) return { created: 0, unchanged: 0, paths: [] };
    throw error;
  }
  const shards = readImportedActionEventShards(safeSource, relativePaths);
  const safeDestination = prepareSafeReadRoot(destinationRoot, "action event shard import");
  return withActionEventLock(
    safeDestination.path,
    ".action-ledger-import.lock",
    "action event shard import lock",
    "clawsweeper.action-ledger-import-lock",
    () => {
      validateImportedActionEventHistory(safeDestination, shards);
      const bindings = prepareActionEventShardImportBindings(safeDestination, shards);
      const prepared = shards.map((shard) => {
        const target = prepareSafeWriteTarget(
          safeDestination.path,
          shard.relativePath,
          "action event shard import",
        );
        const existing = readUtf8FileIfExistsNoFollow(
          target,
          ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes,
        );
        if (
          existing !== null &&
          existing !== shard.content &&
          !importedShardReplayEquivalent(existing, shard, target.path)
        ) {
          throw new Error(`action event shard import conflict: ${shard.relativePath}`);
        }
        return { ...shard, target, existing };
      });
      for (const binding of bindings.reservations) {
        publishActionEventShardImportBinding(binding);
      }
      let created = 0;
      let unchanged = 0;
      for (const shard of prepared) {
        if (shard.existing !== null) {
          unchanged += 1;
          continue;
        }
        const status = writeUtf8FileCreateOnlyNoFollow(shard.target, shard.content);
        if (status === "created") {
          created += 1;
          continue;
        }
        const raced = readUtf8FileNoFollow(
          shard.target,
          ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes,
        );
        if (
          raced !== shard.content &&
          !importedShardReplayEquivalent(raced, shard, shard.target.path)
        ) {
          throw new Error(`action event shard import conflict: ${shard.relativePath}`);
        }
        unchanged += 1;
      }
      for (const shard of prepared) {
        const durable = readUtf8FileNoFollow(
          shard.target,
          ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes,
        );
        if (
          durable !== shard.content &&
          !importedShardReplayEquivalent(durable, shard, shard.target.path)
        ) {
          throw new Error(`action event shard import conflict: ${shard.relativePath}`);
        }
      }
      for (const binding of bindings.completions) {
        publishActionEventShardImportBinding(binding);
      }
      return { created, unchanged, paths: relativePaths };
    },
  );
}

function prepareActionEventShardImportBindings(
  destination: SafeReadRoot,
  shards: readonly ImportedActionEventShard[],
) {
  const bindings = actionEventShardImportBindings(shards).map((binding) => {
    const target = prepareSafeWriteTarget(destination.path, binding.relativePath, binding.label);
    const existing = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_IMPORT_BINDING_MAX_BYTES);
    if (existing !== null && existing !== binding.content) {
      throw new Error(`${binding.label} conflict`);
    }
    return { ...binding, target, existing };
  });
  return {
    reservations: bindings.filter((binding) => binding.kind === "reservation"),
    completions: bindings.filter((binding) => binding.kind === "completion"),
  };
}

function actionEventShardImportBindings(
  shards: readonly ImportedActionEventShard[],
): ActionEventShardImportBinding[] {
  const producerRuns = new Map<string, ActionEventShardImportBinding>();
  const eventIdentities = new Map<string, ActionEventShardImportBinding>();
  const shardSets = new Map<string, ImportedActionEventShard[]>();
  for (const shard of shards) {
    const { partitionDate, ...producerIdentity } = shard.identity;
    const producerKey = actionLedgerJson(producerIdentity);
    const producerDigest = createHash("sha256").update(producerKey).digest("hex");
    const producerContent = `${actionLedgerJson({
      schema: "clawsweeper.action-ledger-import-producer-run",
      schema_version: 1,
      producer: producerIdentity,
      partition_date: partitionDate,
    })}\n`;
    const existingProducer = producerRuns.get(producerKey);
    if (existingProducer && existingProducer.content !== producerContent) {
      throw new Error("action event shard batch splits one producer run across partition dates");
    }
    producerRuns.set(producerKey, {
      relativePath: path.join(
        "ledger",
        "v1",
        "import-bindings",
        "producer-runs",
        `${producerDigest}.json`,
      ),
      content: producerContent,
      label: "action event shard import producer partition binding",
      kind: "reservation",
    });

    for (const event of shard.events) {
      const content = `${actionLedgerJson(importedActionEventIdentityBinding(event))}\n`;
      const existingEvent = eventIdentities.get(event.event_id);
      if (existingEvent && existingEvent.content !== content) {
        throw new Error(`action event shard import event identity conflict: ${event.event_id}`);
      }
      eventIdentities.set(event.event_id, {
        relativePath: importedActionEventIdentityBindingRelativePath(event.event_id),
        content,
        label: "action event shard import event identity binding",
        kind: "reservation",
      });
    }

    const shardSetKey = actionLedgerJson(shard.identity);
    const group = shardSets.get(shardSetKey) ?? [];
    group.push(shard);
    shardSets.set(shardSetKey, group);
  }

  const bindings = [...producerRuns.values(), ...eventIdentities.values()];
  for (const group of shardSets.values()) {
    const ordered = [...group].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    const bindingPaths = actionEventShardImportBindingRelativePaths(ordered[0]!.identity);
    const reservation = {
      schema: "clawsweeper.action-ledger-import-shard-set",
      schema_version: 1,
      producer: ordered[0]!.identity,
      shards: ordered.map((shard) => ({
        path: shard.relativePath,
        replay_sha256: createHash("sha256")
          .update(`${shard.events.map((event) => actionEventReplayJson(event)).join("\n")}\n`)
          .digest("hex"),
      })),
    };
    const reservationContent = `${actionLedgerJson(reservation)}\n`;
    bindings.push({
      relativePath: bindingPaths.reservation,
      content: reservationContent,
      label: "action event shard import producer shard-set binding",
      kind: "reservation",
    });
    bindings.push({
      relativePath: bindingPaths.completion,
      content: `${actionLedgerJson({
        schema: "clawsweeper.action-ledger-import-shard-set-completion",
        schema_version: 1,
        producer: ordered[0]!.identity,
        reservation_sha256: createHash("sha256").update(reservationContent).digest("hex"),
      })}\n`,
      label: "action event shard import producer shard-set completion binding",
      kind: "completion",
    });
  }
  return bindings.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "reservation" ? -1 : 1;
    return left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0;
  });
}

function publishActionEventShardImportBinding(
  binding: ReturnType<typeof prepareActionEventShardImportBindings>["reservations"][number],
): void {
  if (binding.existing !== null) return;
  if (writeUtf8FileCreateOnlyNoFollow(binding.target, binding.content) === "created") return;
  const raced = readUtf8FileNoFollow(binding.target, ACTION_EVENT_IMPORT_BINDING_MAX_BYTES);
  if (raced !== binding.content) {
    throw new Error(`${binding.label} conflict`);
  }
}

function validateImportedActionEventHistory(
  destination: SafeReadRoot,
  shards: readonly ImportedActionEventShard[],
): void {
  const incoming = new Map<string, ImportedActionEventIdentityBinding>();
  for (const shard of shards) {
    for (const event of shard.events) {
      incoming.set(event.event_id, importedActionEventIdentityBinding(event));
    }
  }

  const existing = new Map<string, ImportedActionEventIdentityBinding | null>();
  let bindingReads = 0;
  const readBinding = (eventId: string): ImportedActionEventIdentityBinding | null => {
    const cached = existing.get(eventId);
    if (cached !== undefined) return cached;
    bindingReads += 1;
    if (bindingReads > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxCausalBindings) {
      throw new Error(
        `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxCausalBindings} causal binding limit`,
      );
    }
    const binding = readImportedActionEventIdentityBinding(destination, eventId);
    existing.set(eventId, binding);
    return binding;
  };

  for (const [eventId, binding] of incoming) {
    const prior = readBinding(eventId);
    if (prior && prior.semantic_sha256 !== binding.semantic_sha256) {
      throw new Error(`action event shard import event identity conflict: ${eventId}`);
    }
  }

  const resolved = new Set<string>();
  for (const eventId of incoming.keys()) {
    const pathPositions = new Map<string, number>();
    const traversed: string[] = [];
    let current: string | null = eventId;
    while (current !== null && !resolved.has(current)) {
      if (pathPositions.has(current)) {
        throw new Error(`action event shard import contains a causal cycle: ${current}`);
      }
      pathPositions.set(current, traversed.length);
      traversed.push(current);
      current = (incoming.get(current) ?? readBinding(current))?.parent_event_id ?? null;
    }
    for (const traversedEventId of traversed) resolved.add(traversedEventId);
  }
}

function importedActionEventIdentityBinding(
  event: ActionEvent,
): ImportedActionEventIdentityBinding {
  return {
    schema: "clawsweeper.action-ledger-import-event",
    schema_version: 1,
    event_id: event.event_id,
    semantic_sha256: event.semantic_sha256,
    parent_event_id: event.parent_event_id,
  };
}

function importedActionEventIdentityBindingRelativePath(eventId: string): string {
  return path.join("ledger", "v1", "import-bindings", "events", `${eventId}.json`);
}

function readImportedActionEventIdentityBinding(
  destination: SafeReadRoot,
  eventId: string,
): ImportedActionEventIdentityBinding | null {
  let target;
  try {
    target = prepareSafeReadTarget(
      destination,
      importedActionEventIdentityBindingRelativePath(eventId),
      "action event shard import event identity binding",
    );
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const content = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_IMPORT_BINDING_MAX_BYTES);
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`invalid action event shard import event identity binding: ${eventId}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Partial<ImportedActionEventIdentityBinding>).schema !==
      "clawsweeper.action-ledger-import-event" ||
    (value as Partial<ImportedActionEventIdentityBinding>).schema_version !== 1 ||
    (value as Partial<ImportedActionEventIdentityBinding>).event_id !== eventId ||
    !/^[a-f0-9]{64}$/.test(
      String((value as Partial<ImportedActionEventIdentityBinding>).semantic_sha256 ?? ""),
    ) ||
    ((value as Partial<ImportedActionEventIdentityBinding>).parent_event_id !== null &&
      !/^[a-f0-9]{64}$/.test(
        String((value as Partial<ImportedActionEventIdentityBinding>).parent_event_id ?? ""),
      )) ||
    `${actionLedgerJson(value)}\n` !== content
  ) {
    throw new Error(`invalid action event shard import event identity binding: ${eventId}`);
  }
  return value as ImportedActionEventIdentityBinding;
}

function readImportedActionEventShards(
  source: SafeReadRoot,
  relativePaths: readonly string[],
): ImportedActionEventShard[] {
  let totalBytes = 0;
  const contents = relativePaths.map((relativePath) => {
    if (!ACTION_EVENT_SHARD_PATH_PATTERN.test(relativePath)) {
      throw new Error(`invalid action event shard path: ${relativePath}`);
    }
    const target = prepareSafeReadTarget(source, relativePath, "action event shard import source");
    const content = readUtf8FileNoFollow(target, ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes);
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (totalBytes > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(
        `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes} total byte limit`,
      );
    }
    assertImportedShardLineLimit(relativePath, content);
    if (!content.endsWith("\n")) {
      throw new Error(`action event shard must end with a newline: ${relativePath}`);
    }
    return { relativePath, content };
  });

  let totalEvents = 0;
  const parsed = contents.map(({ relativePath, content }) => {
    const events = parseActionEventShardContent(content, relativePath);
    assertImportedShardEventLimit(relativePath, events);
    totalEvents += events.length;
    if (totalEvents > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalEvents) {
      throw new Error(
        `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalEvents} total event limit`,
      );
    }
    return { relativePath, content, events };
  });
  const validated = parsed.map((shard) => ({
    ...shard,
    ...validateCanonicalImportedShard(shard.relativePath, shard.events, shard.content),
  }));
  validateCanonicalImportedShardBatch(validated);
  return validated;
}

function importedShardReplayEquivalent(
  content: string,
  candidate: ImportedActionEventShard,
  filePath: string,
): boolean {
  assertImportedShardLineLimit(candidate.relativePath, content);
  const parsed = parseActionEventShardContent(content, filePath);
  assertImportedShardEventLimit(candidate.relativePath, parsed);
  validateCanonicalImportedShard(candidate.relativePath, parsed, content);
  return actionEventShardsReplayEquivalent(parsed, candidate.events);
}

function assertImportedShardLineLimit(relativePath: string, content: string): void {
  let lineCount = content.length === 0 ? 0 : content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lineCount += 1;
  }
  if (lineCount > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileLines) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileLines} line limit: ${relativePath}`,
    );
  }
}

function assertImportedShardEventLimit(relativePath: string, events: readonly ActionEvent[]): void {
  if (events.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents} event limit: ${relativePath}`,
    );
  }
}

function validateCanonicalImportedShard(
  relativePath: string,
  events: readonly ActionEvent[],
  content: string,
): Pick<ImportedActionEventShard, "identity" | "shardIndex" | "shardCount"> {
  const match =
    /^ledger\/v1\/events\/(\d{4})\/(\d{2})\/(\d{2})\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/.exec(
      relativePath,
    );
  const first = events[0];
  if (!match || !first || events.length === 0) {
    throw new Error(`action event shard is empty or has an invalid path: ${relativePath}`);
  }
  const seen = new Set<string>();
  const firstProducer = actionLedgerJson(first.producer);
  for (const event of events) {
    if (seen.has(event.event_id)) {
      throw new Error(`action event shard contains duplicate events: ${relativePath}`);
    }
    seen.add(event.event_id);
    if (actionLedgerJson(event.producer) !== firstProducer) {
      throw new Error(`action event shard mixes producer identities: ${relativePath}`);
    }
  }
  const sorted = sortActionEventsCausally(events);
  const canonicalContent = `${sorted.map((event) => actionLedgerJson(event)).join("\n")}\n`;
  if (content !== canonicalContent) {
    throw new Error(`action event shard content is not canonical: ${relativePath}`);
  }
  const identity = {
    repository: first.producer.repository,
    sha: first.producer.sha,
    producer: first.producer.component,
    workflow: first.producer.workflow,
    job: first.producer.job,
    runId: first.producer.run_id,
    runAttempt: first.producer.run_attempt,
    partitionDate: `${match[1]}-${match[2]}-${match[3]}`,
  };
  const { shardIndex, shardCount } = importedShardPart(relativePath);
  const expectedPath = actionEventShardRelativePath(
    identity,
    sorted,
    shardIndex,
    shardCount,
  ).replaceAll(path.sep, "/");
  if (expectedPath !== relativePath) {
    throw new Error(
      `action event shard path does not match canonical identity: ${relativePath} != ${expectedPath}`,
    );
  }
  return { identity, shardIndex, shardCount };
}

function validateCanonicalImportedShardBatch(shards: readonly ImportedActionEventShard[]): void {
  const allEvents = shards.flatMap((shard) => shard.events);
  const seen = new Set<string>();
  for (const event of allEvents) {
    if (seen.has(event.event_id)) {
      throw new Error(`action event shard batch contains duplicate event: ${event.event_id}`);
    }
    seen.add(event.event_id);
  }
  sortActionEventsCausally(allEvents);

  const producerPartitions = new Map<string, string>();
  for (const shard of shards) {
    const { partitionDate, ...producerIdentity } = shard.identity;
    const key = actionLedgerJson(producerIdentity);
    const existing = producerPartitions.get(key);
    if (existing !== undefined && existing !== partitionDate) {
      throw new Error("action event shard batch splits one producer run across partition dates");
    }
    producerPartitions.set(key, partitionDate);
  }

  const groups = new Map<string, ImportedActionEventShard[]>();
  for (const shard of shards) {
    const key = actionLedgerJson(shard.identity);
    const group = groups.get(key) ?? [];
    group.push(shard);
    groups.set(key, group);
  }
  for (const group of groups.values()) validateCanonicalImportedShardGroup(group);
}

function validateCanonicalImportedShardGroup(group: readonly ImportedActionEventShard[]): void {
  const numbered = group.filter((shard) => shard.shardIndex !== undefined);
  if (numbered.length === 0) {
    if (group.length !== 1) {
      throw new Error("action event shard batch contains repeated unnumbered producer shards");
    }
    return;
  }
  if (numbered.length !== group.length) {
    throw new Error("action event shard batch mixes numbered and unnumbered producer shards");
  }

  const shardCount = numbered[0]!.shardCount!;
  if (numbered.some((shard) => shard.shardCount !== shardCount) || numbered.length !== shardCount) {
    throw new Error("action event shard batch is incomplete");
  }
  const ordered = [...group].sort((left, right) => left.shardIndex! - right.shardIndex!);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.shardIndex !== index + 1) {
      throw new Error("action event shard batch is incomplete");
    }
  }
  const events = sortActionEventsCausally(ordered.flatMap((shard) => shard.events));
  const packed = packImportedActionEventShards(events);
  if (packed.length !== ordered.length) {
    throw new Error("action event shard batch is not deterministically packed");
  }
  const identity = ordered[0]!.identity;
  for (let index = 0; index < packed.length; index += 1) {
    const eventsForPart = packed[index]!;
    const shard = ordered[index]!;
    const expectedPath = actionEventShardRelativePath(
      identity,
      eventsForPart,
      index + 1,
      shardCount,
    ).replaceAll(path.sep, "/");
    const expectedContent = `${eventsForPart.map((event) => actionLedgerJson(event)).join("\n")}\n`;
    if (shard.relativePath !== expectedPath || shard.content !== expectedContent) {
      throw new Error("action event shard batch is not deterministically packed");
    }
  }
}

function packImportedActionEventShards(events: readonly ActionEvent[]): ActionEvent[][] {
  const shards: ActionEvent[][] = [];
  let current: ActionEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(`${actionLedgerJson(event)}\n`, "utf8");
    if (eventBytes > ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes) {
      throw new Error(
        `action event ${event.event_id} exceeds ${ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes} shard byte limit`,
      );
    }
    if (
      current.length > 0 &&
      (current.length >= ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents ||
        currentBytes + eventBytes > ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes)
    ) {
      shards.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) shards.push(current);
  return shards;
}

function importedShardPart(relativePath: string): {
  shardIndex: number | undefined;
  shardCount: number | undefined;
} {
  const match = /-part-(\d{6})-of-(\d{6})\.jsonl$/.exec(relativePath);
  return match
    ? { shardIndex: Number(match[1]), shardCount: Number(match[2]) }
    : { shardIndex: undefined, shardCount: undefined };
}

function queueCrabFleetEvent(
  root: string,
  event: ActionEvent,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): void {
  let config: CrabFleetProjectionConfig | null;
  try {
    config = crabFleetProjectionConfig(env);
  } catch {
    failCrabFleetProjection(root, event, "invalid CrabFleet projection configuration");
    return;
  }
  if (!config) return;
  const rootKey = prepareSafeReadRoot(root, "action event spool").path;
  const request = createCrabFleetProjectionRequest(event, config, fetchImpl, rootKey);
  const requests = workflowCrabFleetRequests.get(rootKey) ?? new Set();
  requests.add(request);
  workflowCrabFleetRequests.set(rootKey, requests);
  const rootPosts = pendingWorkflowCrabFleetPosts.get(rootKey) ?? new Set();
  const post = request.promise
    .catch((error) => {
      failCrabFleetProjection(root, event, error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      requests.delete(request);
      if (requests.size === 0) workflowCrabFleetRequests.delete(rootKey);
      rootPosts.delete(post);
      if (rootPosts.size === 0) pendingWorkflowCrabFleetPosts.delete(rootKey);
      pendingCrabFleetPosts.delete(post);
    });
  rootPosts.add(post);
  pendingWorkflowCrabFleetPosts.set(rootKey, rootPosts);
  pendingCrabFleetPosts.add(post);
  admitCrabFleetProjection(request);
}

function enqueueCrabFleetProjection(
  event: ActionEvent,
  config: CrabFleetProjectionConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const request = createCrabFleetProjectionRequest(event, config, fetchImpl);
  admitCrabFleetProjection(request);
  return request.promise;
}

function createCrabFleetProjectionRequest(
  event: ActionEvent,
  config: CrabFleetProjectionConfig,
  fetchImpl: typeof fetch,
  rootKey?: string,
): CrabFleetProjectionRequest {
  const validatedEvent = validateActionEvent(event, "CrabFleet action event");
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    event: validatedEvent,
    config,
    fetchImpl,
    admissionKey: rootKey ?? DIRECT_CRABFLEET_ADMISSION_KEY,
    ...(rootKey === undefined ? {} : { rootKey }),
    promise,
    resolve,
    reject,
    done: false,
  };
}

function admitCrabFleetProjection(request: CrabFleetProjectionRequest): void {
  if (activeCrabFleetRequests.size < CRABFLEET_PROJECTION_LIMITS.maxConcurrent) {
    startCrabFleetProjection(request);
    return;
  }
  const queue = queuedCrabFleetPosts.get(request.admissionKey);
  if (
    (queue?.length ?? 0) < CRABFLEET_PROJECTION_LIMITS.maxQueued &&
    queuedCrabFleetPostCount < CRABFLEET_PROJECTION_LIMITS.maxTotalQueued &&
    (queue !== undefined || queuedCrabFleetPosts.size < CRABFLEET_PROJECTION_LIMITS.maxQueuedRoots)
  ) {
    if (queue) {
      queue.push(request);
    } else {
      queuedCrabFleetPosts.set(request.admissionKey, [request]);
      queuedCrabFleetAdmissionOrder.push(request.admissionKey);
    }
    queuedCrabFleetPostCount += 1;
    request.queueTimer = setTimeout(() => {
      if (!removeQueuedCrabFleetProjection(request) || request.done) return;
      settleCrabFleetProjection(
        request,
        new Error(`CrabFleet projection queue timed out after ${request.config.timeoutMs}ms`),
      );
      drainCrabFleetProjectionQueue();
    }, request.config.timeoutMs);
    drainCrabFleetProjectionQueue();
    return;
  }
  const limit =
    (queue?.length ?? 0) >= CRABFLEET_PROJECTION_LIMITS.maxQueued
      ? CRABFLEET_PROJECTION_LIMITS.maxQueued
      : CRABFLEET_PROJECTION_LIMITS.maxTotalQueued;
  settleCrabFleetProjection(request, new Error(`queue limit ${limit} reached`));
}

function startCrabFleetProjection(request: CrabFleetProjectionRequest): void {
  if (request.queueTimer) {
    clearTimeout(request.queueTimer);
    delete request.queueTimer;
  }
  const handle = startActionEventCrabFleetPost(request.event, request.config, request.fetchImpl);
  request.handle = handle;
  activeCrabFleetRequests.add(request);
  void handle.result
    .then(
      async () => {
        await handle.settled;
        settleCrabFleetProjection(request);
      },
      async (error) => {
        if (handle.cleanupComplete()) await handle.settled;
        settleCrabFleetProjection(request, error);
      },
    )
    .finally(() => drainCrabFleetProjectionQueue());
  void handle.settled.finally(() => {
    activeCrabFleetRequests.delete(request);
    drainCrabFleetProjectionQueue();
  });
}

function settleCrabFleetProjection(request: CrabFleetProjectionRequest, error?: unknown): void {
  if (request.done) return;
  request.done = true;
  if (request.queueTimer) {
    clearTimeout(request.queueTimer);
    delete request.queueTimer;
  }
  removeQueuedCrabFleetProjection(request);
  if (error === undefined) request.resolve();
  else request.reject(error);
}

function drainCrabFleetProjectionQueue(): void {
  while (
    activeCrabFleetRequests.size < CRABFLEET_PROJECTION_LIMITS.maxConcurrent &&
    queuedCrabFleetPostCount > 0
  ) {
    const next = shiftNextCrabFleetProjection();
    if (!next) break;
    startCrabFleetProjection(next);
  }
  if (
    queuedCrabFleetPostCount > 0 &&
    activeCrabFleetRequests.size >= CRABFLEET_PROJECTION_LIMITS.maxConcurrent &&
    [...activeCrabFleetRequests].every((request) => request.done)
  ) {
    const blockedAdmissionKeys = new Set(
      [...activeCrabFleetRequests].map((request) => request.admissionKey),
    );
    for (const admissionKey of blockedAdmissionKeys) {
      const blocked = [...(queuedCrabFleetPosts.get(admissionKey) ?? [])];
      for (const request of blocked) {
        settleCrabFleetProjection(
          request,
          new Error(`blocked by ${activeCrabFleetRequests.size} unresolved CrabFleet requests`),
        );
      }
    }
  }
}

function shiftNextCrabFleetProjection(): CrabFleetProjectionRequest | undefined {
  if (queuedCrabFleetAdmissionOrder.length === 0) return undefined;
  const activeByAdmissionKey = new Map<string, number>();
  for (const request of activeCrabFleetRequests) {
    activeByAdmissionKey.set(
      request.admissionKey,
      (activeByAdmissionKey.get(request.admissionKey) ?? 0) + 1,
    );
  }
  let selectedIndex = -1;
  let selectedActiveCount = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < queuedCrabFleetAdmissionOrder.length; offset += 1) {
    const index = (nextCrabFleetAdmissionIndex + offset) % queuedCrabFleetAdmissionOrder.length;
    const admissionKey = queuedCrabFleetAdmissionOrder[index]!;
    const activeCount = activeByAdmissionKey.get(admissionKey) ?? 0;
    if (activeCount < selectedActiveCount) {
      selectedIndex = index;
      selectedActiveCount = activeCount;
    }
  }
  if (selectedIndex === -1) return undefined;
  const admissionKey = queuedCrabFleetAdmissionOrder[selectedIndex]!;
  const queue = queuedCrabFleetPosts.get(admissionKey)!;
  const request = queue.shift()!;
  queuedCrabFleetPostCount -= 1;
  if (queue.length === 0) {
    removeCrabFleetAdmissionQueue(admissionKey);
  } else {
    nextCrabFleetAdmissionIndex = (selectedIndex + 1) % queuedCrabFleetAdmissionOrder.length;
  }
  return request;
}

function removeQueuedCrabFleetProjection(request: CrabFleetProjectionRequest): boolean {
  const queue = queuedCrabFleetPosts.get(request.admissionKey);
  if (!queue) return false;
  const index = queue.indexOf(request);
  if (index === -1) return false;
  queue.splice(index, 1);
  queuedCrabFleetPostCount -= 1;
  if (queue.length === 0) removeCrabFleetAdmissionQueue(request.admissionKey);
  return true;
}

function removeCrabFleetAdmissionQueue(admissionKey: string): void {
  queuedCrabFleetPosts.delete(admissionKey);
  const index = queuedCrabFleetAdmissionOrder.indexOf(admissionKey);
  if (index === -1) return;
  queuedCrabFleetAdmissionOrder.splice(index, 1);
  if (queuedCrabFleetAdmissionOrder.length === 0) {
    nextCrabFleetAdmissionIndex = 0;
  } else if (index < nextCrabFleetAdmissionIndex) {
    nextCrabFleetAdmissionIndex -= 1;
  } else if (nextCrabFleetAdmissionIndex >= queuedCrabFleetAdmissionOrder.length) {
    nextCrabFleetAdmissionIndex = 0;
  }
}

function failPendingWorkflowCrabFleetRequests(error: Error, rootKey?: string): void {
  const requests =
    rootKey === undefined
      ? [...workflowCrabFleetRequests.values()].flatMap((entries) => [...entries])
      : [...(workflowCrabFleetRequests.get(rootKey) ?? [])];
  for (const request of requests) {
    if (request.done) continue;
    request.handle?.cancel(error);
    settleCrabFleetProjection(request, error);
  }
  drainCrabFleetProjectionQueue();
}

function failCrabFleetProjection(root: string, event: ActionEvent, reason: string): void {
  recordCrabFleetProjectionFailure(root, event);
  console.error(`[action-ledger] live CrabFleet projection failed: ${reason}`);
}

function recordCrabFleetProjectionFailure(root: string, event: ActionEvent): void {
  try {
    const producer = crabFleetProjectionFailureProducer(event);
    const partitionDate = readWorkflowPartitionDate(
      prepareSafeReadRoot(root, "action event spool"),
      event.producer,
    );
    const failureInput: ActionEventInput = {
      eventKey: actionEventKey("projection.failed", {
        sourceEventId: event.event_id,
        destination: "crabfleet",
        producer: producer.component,
      }),
      operationId: event.operation_id,
      attemptId: event.attempt_id,
      parentEventId: event.event_id,
      phaseSeq: event.phase_seq === Number.MAX_SAFE_INTEGER ? event.phase_seq : event.phase_seq + 1,
      idempotencyKeySha256: actionIdempotencyKey({
        sourceEventId: event.event_id,
        destination: "crabfleet",
      }),
      type: ACTION_EVENT_TYPES.projectionFailed,
      producer: {
        repository: producer.repository,
        sha: producer.sha,
        workflow: producer.workflow,
        job: producer.job,
        runId: producer.run_id,
        runAttempt: producer.run_attempt,
        component: producer.component,
      },
      subject: {
        repository: event.subject.repository,
        kind: event.subject.kind,
        ...(event.subject.subject_id === undefined ? {} : { subjectId: event.subject.subject_id }),
        ...(event.subject.number === undefined ? {} : { number: event.subject.number }),
        ...(event.subject.cluster_id === undefined ? {} : { clusterId: event.subject.cluster_id }),
        ...(event.subject.source_revision === undefined
          ? {}
          : { sourceRevision: event.subject.source_revision }),
        ...(event.subject.record_path === undefined
          ? {}
          : { recordPath: event.subject.record_path }),
      },
      action: {
        name: "crabfleet_projection",
        status: "failed",
        reasonCode: "append_failed",
        retryable: true,
        mutation: false,
      },
      learning: {
        category: "delivery",
        signal: "retry_from_durable_ledger",
        ruleId: "crabfleet_projection_failed",
        confidence: 1,
      },
      attributes: {
        phase: "live_projection",
      },
      privacy: {
        classification: "internal",
        redactionVersion: "v1",
        fieldsDropped: ["token", "response_body", "error_detail"],
      },
    };
    const writeOptions = { generatedOccurredAt: event.recorded_at };
    const candidate = createActionEvent(failureInput, writeOptions);
    withWorkflowProducerLock(root, candidate.producer, () => {
      assertWorkflowProducerAcceptsEvent(root, candidate);
      ensureWorkflowPartitionDateValue(root, producer, partitionDate);
      writeActionEvent(root, failureInput, writeOptions);
    });
  } catch (error) {
    console.error(
      `[action-ledger] failed to record CrabFleet projection failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function crabFleetProjectionFailureProducer(event: ActionEvent): ActionEvent["producer"] {
  return {
    ...event.producer,
    component: machineIdentifier(`${event.producer.component}.crabfleet_projection`, 256),
  };
}

function workflowPartitionDate(env: NodeJS.ProcessEnv): string {
  const configured = String(env.CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE ?? "").trim();
  const runStartedAt = String(env.GITHUB_RUN_STARTED_AT ?? "").trim();
  if (configured) {
    return workflowPartitionCalendarDate(configured, "CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE");
  }
  if (runStartedAt) return workflowPartitionTimestampDate(runStartedAt);
  throw new Error(
    "action event partitioning requires CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE or GITHUB_RUN_STARTED_AT",
  );
}

function ensureWorkflowPartitionDateValue(
  root: string,
  producer: ActionEvent["producer"],
  partitionDate: string,
): string {
  const target = prepareSafeWriteTarget(
    root,
    workflowPartitionRelativePath(producer),
    "action event partition marker",
  );
  const existing = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_PARTITION_MARKER_MAX_BYTES);
  if (existing !== null) {
    return validateWorkflowPartitionMarker(existing, partitionDate);
  }
  if (writeUtf8FileCreateOnlyNoFollow(target, `${partitionDate}\n`) === "exists") {
    return validateWorkflowPartitionMarker(
      readUtf8FileNoFollow(target, ACTION_EVENT_PARTITION_MARKER_MAX_BYTES),
      partitionDate,
    );
  }
  return partitionDate;
}

function assertWorkflowProducerAcceptsEvent(root: string, event: ActionEvent): void {
  const safeRoot = prepareSafeReadRoot(root, "action event spool");
  if (readWorkflowProducerFinalization(safeRoot, event.producer) === null) return;
  try {
    const target = prepareSafeReadTarget(
      safeRoot,
      actionEventSpoolRelativePath(event.subject.repository, event.event_id),
      "action event spool entry",
    );
    if (
      readUtf8FileIfExistsNoFollow(target, ACTION_LEDGER_CANONICAL_JSON_LIMITS.maxBytes) !== null
    ) {
      return;
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  throw new Error(
    "action event producer is already finalized; use a new CLAWSWEEPER_ACTION_LEDGER_INVOCATION",
  );
}

function withWorkflowProducerLocks<T>(
  root: string,
  producers: readonly ActionEvent["producer"][],
  callback: () => T,
): T {
  const ordered = [...new Map(producers.map((producer) => [actionLedgerJson(producer), producer]))]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, producer]) => producer);
  const acquire = (index: number): T => {
    const producer = ordered[index];
    return producer === undefined
      ? callback()
      : withWorkflowProducerLock(root, producer, () => acquire(index + 1));
  };
  return acquire(0);
}

function withWorkflowProducerLock<T>(
  root: string,
  producer: ActionEvent["producer"],
  callback: () => T,
): T {
  return withActionEventLock(
    root,
    workflowProducerLockRelativePath(producer),
    "action event producer lock",
    "clawsweeper.action-ledger-producer-lock",
    callback,
  );
}

function withActionEventLock<T>(
  root: string,
  relativePath: string,
  label: string,
  schema: ActionEventLock["schema"],
  callback: () => T,
): T {
  const target = prepareSafeWriteTarget(root, relativePath, label);
  const processIncarnation = processIncarnationIdentitySha256();
  if (processIncarnation === null) {
    throw new Error(`unable to determine ${label} process incarnation`);
  }
  const lock: ActionEventLock = {
    schema,
    schema_version: 1,
    pid: process.pid,
    process_incarnation_sha256: processIncarnation,
    acquired_at_ms: Date.now(),
    nonce: randomUUID(),
  };
  const content = `${actionLedgerJson(lock)}\n`;
  const deadline = Date.now() + ACTION_EVENT_PRODUCER_LOCK_WAIT_MS;
  for (;;) {
    const release = tryAcquireUtf8FileLockNoFollow(target, content);
    if (release) {
      try {
        return callback();
      } finally {
        release();
      }
    }
    const existing = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_PRODUCER_LOCK_MAX_BYTES);
    if (existing === null) continue;
    const owner = parseActionEventLock(existing, schema, label);
    if (actionEventLockOwnerIsStale(owner)) {
      removeUtf8FileIfContentNoFollow(target, existing);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out after ${ACTION_EVENT_PRODUCER_LOCK_WAIT_MS}ms`);
    }
    Atomics.wait(producerLockWaitArray, 0, 0, 5);
  }
}

function parseActionEventLock(
  content: string,
  schema: ActionEventLock["schema"],
  label: string,
): ActionEventLock {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`invalid ${label}`);
  }
  const lock = value as Partial<ActionEventLock>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    lock.schema !== schema ||
    lock.schema_version !== 1 ||
    !Number.isSafeInteger(lock.pid) ||
    Number(lock.pid) < 1 ||
    typeof lock.process_incarnation_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(lock.process_incarnation_sha256) ||
    !Number.isSafeInteger(lock.acquired_at_ms) ||
    Number(lock.acquired_at_ms) < 0 ||
    typeof lock.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(lock.nonce) ||
    `${actionLedgerJson(value)}\n` !== content
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value as ActionEventLock;
}

function actionEventLockOwnerIsStale(owner: ActionEventLock): boolean {
  if (!processIsAlive(owner.pid)) return true;
  const currentIncarnation = processIncarnationIdentitySha256(owner.pid, { fresh: true });
  return currentIncarnation !== null && currentIncarnation !== owner.process_incarnation_sha256;
}

function processIsAlive(pid: number): boolean {
  if (processIsDefunct(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function reserveWorkflowProducerFinalization(
  root: SafeReadRoot,
  producer: ActionEvent["producer"],
  partitionDate: string,
  events: readonly ActionEvent[],
): void {
  const value: WorkflowProducerFinalization = {
    schema: "clawsweeper.action-ledger-producer-finalization",
    schema_version: 1,
    producer,
    partition_date: partitionDate,
    event_count: events.length,
    replay_sha256: createHash("sha256")
      .update(`${events.map((event) => actionEventReplayJson(event)).join("\n")}\n`)
      .digest("hex"),
  };
  const content = `${actionLedgerJson(value)}\n`;
  const target = prepareSafeWriteTarget(
    root.path,
    workflowFinalizationRelativePath(producer),
    "action event producer finalization",
  );
  const existing = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_FINALIZATION_MAX_BYTES);
  if (existing !== null) {
    if (existing !== content) {
      throw new Error("action event producer finalization conflicts with late spool events");
    }
    return;
  }
  if (writeUtf8FileCreateOnlyNoFollow(target, content) === "created") return;
  if (readUtf8FileNoFollow(target, ACTION_EVENT_FINALIZATION_MAX_BYTES) !== content) {
    throw new Error("action event producer finalization conflicts with late spool events");
  }
}

function readWorkflowProducerFinalization(
  root: SafeReadRoot,
  producer: ActionEvent["producer"],
): WorkflowProducerFinalization | null {
  let target;
  try {
    target = prepareSafeReadTarget(
      root,
      workflowFinalizationRelativePath(producer),
      "action event producer finalization",
    );
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const content = readUtf8FileIfExistsNoFollow(target, ACTION_EVENT_FINALIZATION_MAX_BYTES);
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("invalid action event producer finalization");
  }
  const finalization = value as Partial<WorkflowProducerFinalization>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    finalization.schema !== "clawsweeper.action-ledger-producer-finalization" ||
    finalization.schema_version !== 1 ||
    actionLedgerJson(finalization.producer) !== actionLedgerJson(producer) ||
    typeof finalization.partition_date !== "string" ||
    !Number.isSafeInteger(finalization.event_count) ||
    Number(finalization.event_count) < 1 ||
    !/^[a-f0-9]{64}$/.test(String(finalization.replay_sha256 ?? "")) ||
    `${actionLedgerJson(value)}\n` !== content
  ) {
    throw new Error("invalid action event producer finalization");
  }
  workflowPartitionCalendarDate(
    finalization.partition_date,
    "action event producer finalization partition",
  );
  return value as WorkflowProducerFinalization;
}

function readWorkflowPartitionDate(root: SafeReadRoot, producer: ActionEvent["producer"]): string {
  const target = prepareSafeReadTarget(
    root,
    workflowPartitionRelativePath(producer),
    "action event partition marker",
  );
  return workflowPartitionCalendarDate(
    readUtf8FileNoFollow(target, ACTION_EVENT_PARTITION_MARKER_MAX_BYTES).trim(),
    "action event partition marker",
  );
}

function workflowPartitionRelativePath(producer: ActionEvent["producer"]): string {
  const identity = createHash("sha256").update(actionLedgerJson(producer)).digest("hex");
  return path.join(".clawsweeper-repair", "action-events", "_partitions", `${identity}.txt`);
}

function workflowFinalizationRelativePath(producer: ActionEvent["producer"]): string {
  const identity = createHash("sha256").update(actionLedgerJson(producer)).digest("hex");
  return path.join(".clawsweeper-repair", "action-events", "_finalizations", `${identity}.json`);
}

function workflowProducerLockRelativePath(producer: ActionEvent["producer"]): string {
  const identity = createHash("sha256").update(actionLedgerJson(producer)).digest("hex");
  return path.join(".clawsweeper-repair", "action-events", "_locks", `${identity}.lock`);
}

function persistedWorkflowProducer(producer: ActionEventProducer): ActionEvent["producer"] {
  return {
    repository: producer.repository,
    sha: producer.sha,
    workflow: producer.workflow,
    job: producer.job,
    run_id: producer.runId,
    run_attempt: producer.runAttempt,
    component: producer.component,
  };
}

function validateWorkflowPartitionMarker(content: string, expected: string): string {
  const recorded = workflowPartitionCalendarDate(content.trim(), "action event partition marker");
  if (recorded !== expected) {
    throw new Error(`action event partition marker conflict: ${recorded} != ${expected}`);
  }
  return recorded;
}

function workflowPartitionCalendarDate(value: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must be YYYY-MM-DD`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = strictUtcCalendarDate(year, month, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

function workflowPartitionTimestampDate(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) {
    throw new Error("GITHUB_RUN_STARTED_AT must be an ISO date-time timestamp");
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendar = strictUtcCalendarDate(year, month, day);
  const validCalendar =
    year >= 1 &&
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
  const validClock =
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59);
  if (!validCalendar || !validClock || !Number.isFinite(Date.parse(value))) {
    throw new Error("GITHUB_RUN_STARTED_AT must be an ISO date-time timestamp");
  }
  const partitionDate = new Date(value).toISOString().slice(0, 10);
  return workflowPartitionCalendarDate(partitionDate, "GITHUB_RUN_STARTED_AT UTC partition date");
}

function actionEventMessage(event: ActionEvent): string {
  const subject =
    event.subject.number === undefined
      ? `${event.subject.repository}:${event.subject.kind}`
      : `${event.subject.repository}#${event.subject.number}`;
  return `${event.event_type}:${event.action.status}:${subject}`;
}

function machineIdentifier(value: string, maxLength: number): string {
  const source = value.trim();
  const readable = source.replace(/[^A-Za-z0-9_.:/@+-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!readable) throw new Error("workflow action identifier is required");
  if (readable === source && readable.length <= maxLength) return readable;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const prefixLength = maxLength - digest.length - 1;
  if (prefixLength < 1) throw new Error("workflow action identifier limit is too small");
  const prefix = readable.slice(0, prefixLength).replace(/-+$/g, "") || "id";
  return `${prefix}-${digest}`;
}

function workflowPathFromRef(workflowRef: string): string {
  const delimiter = workflowRef.lastIndexOf("@refs/");
  return delimiter === -1 ? workflowRef : workflowRef.slice(0, delimiter);
}

function strictUtcCalendarDate(year: number, month: number, day: number): Date {
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required for action event telemetry`);
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnv(env, name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function collectActionEventShardFiles(root: SafeReadRoot): string[] {
  const files: string[] = [];
  let directoryCount = 0;
  let fileCount = 0;
  const visit = (relativeDirectory: string, depth: number): void => {
    directoryCount += 1;
    if (directoryCount > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDirectories) {
      throw new Error(
        `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDirectories} directory limit`,
      );
    }
    const entries = readDirectoryEntriesNoFollow(
      root,
      relativeDirectory,
      "action event shard import source",
      ACTION_EVENT_SHARD_IMPORT_LIMITS.maxEntriesPerDirectory,
    );
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory.replaceAll(path.sep, "/"), entry.name);
      const childDepth = depth + 1;
      if (childDepth > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDepth) {
        throw new Error(
          `action event shard import exceeds maximum depth ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDepth}: ${relativePath}`,
        );
      }
      if (entry.isDirectory()) {
        if (childDepth === ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDepth) {
          throw new Error(
            `action event shard import exceeds maximum depth ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDepth}: ${relativePath}`,
          );
        }
        visit(relativePath, childDepth);
        continue;
      }
      if (entry.isFile()) {
        fileCount += 1;
        if (fileCount > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles) {
          throw new Error(
            `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} file limit`,
          );
        }
        if (relativePath.endsWith(".jsonl")) files.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing symbolic link in action event shard import: ${relativePath}`);
      }
      throw new Error(`refusing unsafe action event shard import entry: ${relativePath}`);
    }
  };
  visit(path.join("ledger", "v1", "events"), 0);
  return files.sort();
}

function crabFleetTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.CLAWSWEEPER_CRABFLEET_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT_CRABFLEET_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CRABFLEET_TIMEOUT_MS) {
    throw new Error(
      `CLAWSWEEPER_CRABFLEET_TIMEOUT_MS must be an integer between 1 and ${MAX_CRABFLEET_TIMEOUT_MS}`,
    );
  }
  return value;
}

function crabFleetFlushTimeoutMs(value: number | undefined): number {
  const normalized = value ?? DEFAULT_CRABFLEET_FLUSH_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_CRABFLEET_FLUSH_TIMEOUT_MS
  ) {
    throw new Error(
      `CrabFleet projection flush timeout must be an integer between 1 and ${MAX_CRABFLEET_FLUSH_TIMEOUT_MS}`,
    );
  }
  return normalized;
}

function crabFleetProjectionConfig(env: NodeJS.ProcessEnv): CrabFleetProjectionConfig | null {
  const sessionId = String(env.CLAWSWEEPER_CRABFLEET_SESSION_ID ?? "").trim();
  const token = String(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN ?? "").trim();
  if (!sessionId && !token) return null;
  if (!sessionId || !token) {
    throw new Error("CrabFleet projection requires both session ID and agent token");
  }
  const registeredBaseUrl = crabFleetRegisteredBaseUrl(env, sessionId);
  const configuredBaseUrl = crabFleetConfiguredBaseUrl(env);
  if (configuredBaseUrl !== registeredBaseUrl) {
    throw new Error("CrabFleet projection base does not match registered session provenance");
  }
  return {
    endpointUrl: `${registeredBaseUrl}/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/events`,
    token,
    timeoutMs: crabFleetTimeoutMs(env),
  };
}

function crabFleetConfiguredBaseUrl(env: NodeJS.ProcessEnv): string {
  const rawUrl = String(env.CLAWSWEEPER_CRABFLEET_URL ?? DEFAULT_CRABFLEET_BASE_URL).trim();
  const parsed = credentialFreeHttpsUrl(rawUrl, "CLAWSWEEPER_CRABFLEET_URL");
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${basePath === "/" ? "" : basePath}`;
}

function crabFleetRegisteredBaseUrl(env: NodeJS.ProcessEnv, sessionId: string): string {
  const rawUrl = String(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL ?? "").trim();
  if (!rawUrl) {
    throw new Error("CrabFleet projection requires registered work-state provenance");
  }
  const parsed = credentialFreeHttpsUrl(rawUrl, "CLAWSWEEPER_CRABFLEET_WORK_STATE_URL");
  const suffix = `/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/work-state`;
  if (!parsed.pathname.endsWith(suffix)) {
    throw new Error("CrabFleet work-state URL does not match the registered session");
  }
  const basePath = parsed.pathname.slice(0, -suffix.length).replace(/\/+$/, "");
  return `${parsed.origin}${basePath}`;
}

function credentialFreeHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return parsed;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    throw new Error("CrabFleet action event response cleanup failed");
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
