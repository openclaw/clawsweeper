import { createHash } from "node:crypto";
import path from "node:path";

import {
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  prepareSafeWriteTarget,
  readDirectoryEntriesNoFollow,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  writeUtf8FileCreateOnlyNoFollow,
  type SafeReadRoot,
} from "./action-ledger-files.js";
import {
  ACTION_EVENT_SHARD_FILE_LIMITS,
  ACTION_EVENT_TYPES,
  actionEventShardsReplayEquivalent,
  actionAttemptId,
  actionEventShardRelativePath,
  actionEventKey,
  actionIdempotencyKey,
  actionLedgerJson,
  actionOperationId,
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
  type ActionEventLearning,
  type ActionEventPrivacy,
  type ActionEventProducer,
  type ActionEventPhaseType,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEventSubject,
} from "./action-ledger.js";
import { normalizeRepo } from "./repository-profiles.js";

const DEFAULT_EVENT_OUTPUT_DIR = path.join(".clawsweeper-repair", "action-ledger-state");
const DEFAULT_CRABFLEET_ORIGIN = "https://crabfleet.openclaw.ai";
const DEFAULT_CRABFLEET_TIMEOUT_MS = 10_000;
const MAX_CRABFLEET_TIMEOUT_MS = 60_000;
const ALLOWED_CRABFLEET_ORIGINS = new Set([DEFAULT_CRABFLEET_ORIGIN]);
const ACTION_EVENT_SHARD_PATH_PATTERN =
  /^ledger\/v1\/events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/;
const pendingCrabFleetPosts = new Set<Promise<void>>();
const activeCrabFleetRequests = new Set<Promise<unknown>>();
const queuedCrabFleetPosts: QueuedCrabFleetProjection[] = [];

export const CRABFLEET_PROJECTION_LIMITS = {
  maxConcurrent: 4,
  maxQueued: 64,
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
  maxTotalEvents: 4_096,
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
};

type QueuedCrabFleetProjection = {
  root: string;
  event: ActionEvent;
  config: CrabFleetProjectionConfig;
  fetchImpl: typeof fetch;
};

type CrabFleetProjectionConfig = {
  endpointUrl: string;
  token: string;
  timeoutMs: number;
};

export function workflowActionEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAWSWEEPER_ACTION_LEDGER_DISABLED === "1") return false;
  return env.GITHUB_ACTIONS === "true" || env.CLAWSWEEPER_ACTION_LEDGER_FORCE === "1";
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
  createActionEvent(eventInput, writeOptions);
  ensureWorkflowPartitionDate(root, persistedWorkflowProducer(producer), env);
  const event = writeActionEvent(root, eventInput, writeOptions).event;
  queueCrabFleetEvent(root, event, env, options.fetchImpl ?? fetch);
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
  } = {},
): Promise<string[]> {
  await flushPendingCrabFleetPosts();
  const env = options.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return [];
  const safeRoot = prepareSafeReadRoot(root, "action event spool");
  const outputRoot =
    options.outputRoot ??
    env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT ??
    path.join(root, DEFAULT_EVENT_OUTPUT_DIR);
  const safeOutputRoot = prepareSafeReadRoot(outputRoot, "action event shard output");
  const events = readAllSpooledActionEvents(safeRoot);
  const groups = new Map<string, ActionEvent[]>();
  for (const event of events) {
    const key = actionLedgerJson(event.producer);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const paths: string[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const partitionDate = readWorkflowPartitionDate(safeRoot, first.producer);
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
      group,
    );
    paths.push(...results.map((result) => result.relativePath));
  }
  return paths.sort();
}

export async function flushPendingCrabFleetPosts(): Promise<void> {
  while (pendingCrabFleetPosts.size > 0 || queuedCrabFleetPosts.length > 0) {
    drainCrabFleetProjectionQueue();
    await Promise.all(pendingCrabFleetPosts);
  }
}

export async function postActionEventToCrabFleet(
  event: ActionEvent,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = crabFleetProjectionConfig(env);
  if (!config) return;
  await postActionEventToCrabFleetConfig(event, config, fetchImpl);
}

async function postActionEventToCrabFleetConfig(
  event: ActionEvent,
  config: CrabFleetProjectionConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const validatedEvent = validateActionEvent(event, "CrabFleet action event");
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutError = new Error(
    `CrabFleet action event append timed out after ${config.timeoutMs}ms`,
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, config.timeoutMs);
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
  const requestAndCleanup = request.then(async (response) => {
    const result = { ok: response.ok, status: response.status };
    await cancelResponseBody(response);
    return result;
  });
  trackCrabFleetRequest(requestAndCleanup);
  try {
    const result = await Promise.race([requestAndCleanup, deadline]);
    if (!result.ok) {
      throw new Error(`CrabFleet action event append failed (${result.status})`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    const raced = readUtf8FileNoFollow(shard.target, ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes);
    if (
      raced !== shard.content &&
      !importedShardReplayEquivalent(raced, shard, shard.target.path)
    ) {
      throw new Error(`action event shard import conflict: ${shard.relativePath}`);
    }
    unchanged += 1;
  }
  return { created, unchanged, paths: relativePaths };
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
  for (const { relativePath, content, events } of parsed) {
    validateCanonicalImportedShard(relativePath, events, content);
  }
  return parsed;
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
): void {
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
  const expectedPath = actionEventShardRelativePath(
    {
      repository: first.producer.repository,
      sha: first.producer.sha,
      producer: first.producer.component,
      workflow: first.producer.workflow,
      job: first.producer.job,
      runId: first.producer.run_id,
      runAttempt: first.producer.run_attempt,
      partitionDate: `${match[1]}-${match[2]}-${match[3]}`,
    },
    sorted,
    importedShardIndex(relativePath),
  ).replaceAll(path.sep, "/");
  if (expectedPath !== relativePath) {
    throw new Error(
      `action event shard path does not match canonical identity: ${relativePath} != ${expectedPath}`,
    );
  }
}

function importedShardIndex(relativePath: string): number | undefined {
  const match = /-part-(\d{6})\.jsonl$/.exec(relativePath);
  return match ? Number(match[1]) : undefined;
}

function queueCrabFleetEvent(
  root: string,
  event: ActionEvent,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): void {
  const config = crabFleetProjectionConfig(env);
  if (!config) return;
  const projection = { root, event, config, fetchImpl };
  if (activeCrabFleetRequests.size < CRABFLEET_PROJECTION_LIMITS.maxConcurrent) {
    startCrabFleetProjection(projection);
    return;
  }
  if (queuedCrabFleetPosts.length < CRABFLEET_PROJECTION_LIMITS.maxQueued) {
    queuedCrabFleetPosts.push(projection);
    drainCrabFleetProjectionQueue();
    return;
  }
  failCrabFleetProjection(
    root,
    event,
    `queue limit ${CRABFLEET_PROJECTION_LIMITS.maxQueued} reached`,
  );
}

function startCrabFleetProjection(projection: QueuedCrabFleetProjection): void {
  const post = postActionEventToCrabFleetConfig(
    projection.event,
    projection.config,
    projection.fetchImpl,
  )
    .catch((error) => {
      failCrabFleetProjection(
        projection.root,
        projection.event,
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      pendingCrabFleetPosts.delete(post);
      drainCrabFleetProjectionQueue();
    });
  pendingCrabFleetPosts.add(post);
}

function drainCrabFleetProjectionQueue(): void {
  while (
    activeCrabFleetRequests.size < CRABFLEET_PROJECTION_LIMITS.maxConcurrent &&
    queuedCrabFleetPosts.length > 0
  ) {
    startCrabFleetProjection(queuedCrabFleetPosts.shift()!);
  }
  if (
    queuedCrabFleetPosts.length > 0 &&
    pendingCrabFleetPosts.size === 0 &&
    activeCrabFleetRequests.size >= CRABFLEET_PROJECTION_LIMITS.maxConcurrent
  ) {
    const blocked = queuedCrabFleetPosts.splice(0);
    for (const projection of blocked) {
      failCrabFleetProjection(
        projection.root,
        projection.event,
        `blocked by ${activeCrabFleetRequests.size} unresolved CrabFleet requests`,
      );
    }
  }
}

function trackCrabFleetRequest(request: Promise<unknown>): void {
  activeCrabFleetRequests.add(request);
  void request
    .finally(() => {
      activeCrabFleetRequests.delete(request);
      drainCrabFleetProjectionQueue();
    })
    .catch(() => undefined);
}

function failCrabFleetProjection(root: string, event: ActionEvent, reason: string): void {
  recordCrabFleetProjectionFailure(root, event);
  console.error(`[action-ledger] live CrabFleet projection failed: ${reason}`);
}

function recordCrabFleetProjectionFailure(root: string, event: ActionEvent): void {
  try {
    writeActionEvent(
      root,
      {
        eventKey: actionEventKey("projection.failed", {
          sourceEventId: event.event_id,
          destination: "crabfleet",
        }),
        operationId: event.operation_id,
        attemptId: event.attempt_id,
        parentEventId: event.event_id,
        phaseSeq:
          event.phase_seq === Number.MAX_SAFE_INTEGER ? event.phase_seq : event.phase_seq + 1,
        idempotencyKeySha256: actionIdempotencyKey({
          sourceEventId: event.event_id,
          destination: "crabfleet",
        }),
        type: ACTION_EVENT_TYPES.projectionFailed,
        producer: {
          repository: event.producer.repository,
          sha: event.producer.sha,
          workflow: event.producer.workflow,
          job: event.producer.job,
          runId: event.producer.run_id,
          runAttempt: event.producer.run_attempt,
          component: event.producer.component,
        },
        subject: {
          repository: event.subject.repository,
          kind: event.subject.kind,
          ...(event.subject.subject_id === undefined
            ? {}
            : { subjectId: event.subject.subject_id }),
          ...(event.subject.number === undefined ? {} : { number: event.subject.number }),
          ...(event.subject.cluster_id === undefined
            ? {}
            : { clusterId: event.subject.cluster_id }),
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
      },
      {
        generatedOccurredAt: event.recorded_at,
      },
    );
  } catch (error) {
    console.error(
      `[action-ledger] failed to record CrabFleet projection failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function ensureWorkflowPartitionDate(
  root: string,
  producer: ActionEvent["producer"],
  env: NodeJS.ProcessEnv,
): string {
  const configured = String(env.CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE ?? "").trim();
  const runStartedAt = String(env.GITHUB_RUN_STARTED_AT ?? "").trim();
  let partitionDate: string;
  if (configured) {
    partitionDate = workflowPartitionCalendarDate(
      configured,
      "CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE",
    );
  } else if (runStartedAt) {
    partitionDate = workflowPartitionTimestampDate(runStartedAt);
  } else {
    throw new Error(
      "action event partitioning requires CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE or GITHUB_RUN_STARTED_AT",
    );
  }
  const target = prepareSafeWriteTarget(
    root,
    workflowPartitionRelativePath(producer),
    "action event partition marker",
  );
  const existing = readUtf8FileIfExistsNoFollow(target);
  if (existing !== null) {
    return validateWorkflowPartitionMarker(existing, partitionDate);
  }
  if (writeUtf8FileCreateOnlyNoFollow(target, `${partitionDate}\n`) === "exists") {
    return validateWorkflowPartitionMarker(readUtf8FileNoFollow(target), partitionDate);
  }
  return partitionDate;
}

function readWorkflowPartitionDate(root: SafeReadRoot, producer: ActionEvent["producer"]): string {
  const target = prepareSafeReadTarget(
    root,
    workflowPartitionRelativePath(producer),
    "action event partition marker",
  );
  return workflowPartitionCalendarDate(
    readUtf8FileNoFollow(target).trim(),
    "action event partition marker",
  );
}

function workflowPartitionRelativePath(producer: ActionEvent["producer"]): string {
  const identity = createHash("sha256").update(actionLedgerJson(producer)).digest("hex");
  return path.join(".clawsweeper-repair", "action-events", "_partitions", `${identity}.txt`);
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

function crabFleetProjectionConfig(env: NodeJS.ProcessEnv): CrabFleetProjectionConfig | null {
  const sessionId = String(env.CLAWSWEEPER_CRABFLEET_SESSION_ID ?? "").trim();
  const token = String(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN ?? "").trim();
  if (!sessionId || !token) return null;
  const rawUrl = String(env.CLAWSWEEPER_CRABFLEET_URL ?? DEFAULT_CRABFLEET_ORIGIN).trim();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `CLAWSWEEPER_CRABFLEET_URL must be the credential-free HTTPS origin ${DEFAULT_CRABFLEET_ORIGIN}`,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !ALLOWED_CRABFLEET_ORIGINS.has(parsed.origin)
  ) {
    throw new Error(
      `CLAWSWEEPER_CRABFLEET_URL must be the credential-free HTTPS origin ${DEFAULT_CRABFLEET_ORIGIN}`,
    );
  }
  return {
    endpointUrl: `${parsed.origin}/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/events`,
    token,
    timeoutMs: crabFleetTimeoutMs(env),
  };
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
