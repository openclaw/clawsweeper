import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createContext, Script } from "node:vm";
import { gunzipSync } from "node:zlib";

import runtimeWorker, {
  automaticIssueWork,
  ExactReviewQueue as RuntimeExactReviewQueue,
  completedBayReviews,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewJitteredDelayMs,
  exactReviewPublicationCapacity,
  exactReviewPublicationCapacityForState,
  exactReviewQueueAdmittedItems,
  exactReviewQueueCapacity,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStatusSnapshot,
  mergeBayJourneyState,
  mergeBayTerminalState,
  recentWorkerHealthRunSample,
  workerHealthSectionTimeoutMs,
  readCachedSnapshot,
  StatusStore,
  summarizeAutomergeReliability,
  summarizeBayJourneyTimings,
  workerWorkKind,
  workflowJobsForRunSnapshot,
} from "../dashboard/worker.ts";
import { ExactReviewPublicationBatchStore } from "../dashboard/exact-review-publication-batches.ts";
import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
} from "../dashboard/exact-review-direct-publication.ts";
import type { ExactReviewQueueItem } from "../dashboard/exact-review-queue.ts";
import {
  commandAcknowledgementState,
  EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
} from "../dashboard/exact-review-lifecycle.ts";
import type {
  HostedPublicTargetProbe,
  HostedTargetAdmission,
} from "../dashboard/exact-review-queue.ts";
import { ExactReviewLifecycleTelemetryStore } from "../dashboard/exact-review-lifecycle-telemetry.ts";
import { LIVE_ACTIVITY_SOURCE_LIMIT, liveActivityBaySnapshot } from "../dashboard/live-activity.ts";
import { captureCanonicalRecordBaseline } from "../dist/repair/canonical-record-baseline.js";
import { publishMainWithStateAppend } from "../dist/repair/publish-main.js";

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function withHostedTargetAdmissionDefaults<Env extends Record<string, unknown>>(
  env: Env,
  includeVisibilityProbe: boolean,
): Env {
  const prepared = Object.create(
    Object.getPrototypeOf(env),
    Object.getOwnPropertyDescriptors(env),
  ) as Env;
  if (!Object.hasOwn(prepared, "hostedTargetPredicate")) {
    Object.defineProperty(prepared, "hostedTargetPredicate", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: () => true,
    });
  }
  if (includeVisibilityProbe && !Object.hasOwn(prepared, "hostedPublicTargetProbe")) {
    Object.defineProperty(prepared, "hostedPublicTargetProbe", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: async () => "public",
    });
  }
  // Visibility fencing tests exercise each live probe; cache policy has its own queue tests.
  if (!Object.hasOwn(prepared, "EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS")) {
    Object.defineProperty(prepared, "EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: "0",
    });
  }
  return prepared;
}

class ExactReviewQueue extends RuntimeExactReviewQueue {
  constructor(
    state: ConstructorParameters<typeof RuntimeExactReviewQueue>[0],
    env: ConstructorParameters<typeof RuntimeExactReviewQueue>[1],
    random?: ConstructorParameters<typeof RuntimeExactReviewQueue>[2],
  ) {
    super(state, withHostedTargetAdmissionDefaults(env, true), random);
  }
}

const worker = {
  ...runtimeWorker,
  fetch(
    request: Request,
    env: Record<string, unknown> = {},
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
  ) {
    return runtimeWorker.fetch(request, withHostedTargetAdmissionDefaults(env, false), ctx);
  },
};

class MemoryKv {
  private values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MemorySqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  rowsRead = 0;
  readonly rowsWritten: number;
  private readonly rows: T[];

  constructor(rows: T[], rowsWritten: number) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
  }

  *[Symbol.iterator]() {
    for (const row of this.rows) {
      this.rowsRead += 1;
      yield row;
    }
  }
}

class MemorySqlStorage {
  private readonly database = new DatabaseSync(":memory:");
  private failure: { pattern: RegExp; error: Error } | undefined;
  private bindingLimit = Number.POSITIVE_INFINITY;
  private queryHistory: Array<{ query: string; bindings: unknown[] }> | null = null;

  exec(query: string, ...bindings: unknown[]) {
    this.queryHistory?.push({ query, bindings });
    if (bindings.length > this.bindingLimit) {
      throw new Error(`test SQL binding limit exceeded: ${bindings.length}`);
    }
    if (this.failure?.pattern.test(query)) {
      const { error } = this.failure;
      this.failure = undefined;
      throw error;
    }
    const statement = this.database.prepare(query);
    if (
      /^\s*(?:SELECT|WITH|EXPLAIN(?:\s+QUERY\s+PLAN)?)\b/i.test(query) ||
      /\bRETURNING\b/i.test(query)
    ) {
      const rows = statement.all(...bindings) as Record<string, unknown>[];
      return new MemorySqlCursor(rows, rows.length);
    }
    const result = statement.run(...bindings);
    return new MemorySqlCursor([], Number(result.changes));
  }

  transactionSync<T>(callback: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failNext(pattern: RegExp, error = new Error("injected SQL failure")) {
    this.failure = { pattern, error };
  }

  setBindingLimit(limit: number) {
    this.bindingLimit = limit;
  }

  queriesMatching(pattern: RegExp) {
    const flags = pattern.flags.replaceAll("g", "");
    return (this.queryHistory ?? []).filter(({ query }) =>
      new RegExp(pattern.source, flags).test(query),
    );
  }

  resetQueryHistory() {
    this.queryHistory = [];
  }

  hasNormalizedQueue() {
    const table = this.database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_queue_meta'",
      )
      .get() as { found?: number } | undefined;
    if (!table) return false;
    return Boolean(
      this.database
        .prepare("SELECT 1 AS found FROM exact_review_queue_meta WHERE singleton_id = 1")
        .get(),
    );
  }

  readNormalizedQueue() {
    const meta = this.database
      .prepare("SELECT dispatcher_json FROM exact_review_queue_meta WHERE singleton_id = 1")
      .get() as { dispatcher_json?: string | null } | undefined;
    const items = Object.fromEntries(
      (
        this.database
          .prepare("SELECT item_key, item_json FROM exact_review_queue_items ORDER BY item_key")
          .all() as Array<{ item_key: string; item_json: string }>
      ).map((row) => [row.item_key, JSON.parse(row.item_json)]),
    );
    const deliveries = Object.fromEntries(
      (
        this.database
          .prepare(
            "SELECT delivery_id, received_at FROM exact_review_queue_deliveries ORDER BY delivery_id",
          )
          .all() as Array<{ delivery_id: string; received_at: number }>
      ).map((row) => [row.delivery_id, row.received_at]),
    );
    const state: {
      deliveries: Record<string, number>;
      items: Record<string, unknown>;
      dispatcher?: unknown;
    } = { deliveries, items };
    if (meta?.dispatcher_json) state.dispatcher = JSON.parse(meta.dispatcher_json);
    return state;
  }

  replaceNormalizedQueue(value: unknown) {
    const state = (value && typeof value === "object" ? value : {}) as {
      deliveries?: Record<string, number>;
      items?: Record<string, unknown>;
      dispatcher?: unknown;
    };
    this.transactionSync(() => {
      this.database.exec("DELETE FROM exact_review_queue_deliveries");
      this.database.exec("DELETE FROM exact_review_queue_items");
      const insertDelivery = this.database.prepare(
        "INSERT INTO exact_review_queue_deliveries (delivery_id, received_at) VALUES (?, ?)",
      );
      for (const [deliveryId, receivedAt] of Object.entries(state.deliveries || {})) {
        insertDelivery.run(deliveryId, receivedAt);
      }
      const insertItem = this.database.prepare(
        "INSERT INTO exact_review_queue_items (item_key, item_json) VALUES (?, ?)",
      );
      for (const [itemKey, item] of Object.entries(state.items || {})) {
        insertItem.run(itemKey, JSON.stringify(item));
      }
      this.database
        .prepare("UPDATE exact_review_queue_meta SET dispatcher_json = ? WHERE singleton_id = 1")
        .run(state.dispatcher === undefined ? null : JSON.stringify(state.dispatcher));
    });
  }

  setMigrationTime(migratedAt: number) {
    this.database
      .prepare("UPDATE exact_review_queue_meta SET migrated_at = ? WHERE singleton_id = 1")
      .run(migratedAt);
  }

  setReceiptTime(deliveryId: string, receivedAt: number) {
    this.database
      .prepare("UPDATE exact_review_queue_deliveries SET received_at = ? WHERE delivery_id = ?")
      .run(receivedAt, deliveryId);
  }
}

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private putCounts = new Map<string, number>();
  private getHistory: string[] = [];
  private listHistory: Array<{ options: Record<string, unknown>; keys: string[] }> = [];
  private putFailure: { key: string; error: Error } | undefined;
  private deleteFailure: { key: string; error: Error } | undefined;
  private alarmAt: number | null = null;
  readonly sql = new MemorySqlStorage();
  readonly kv = {
    get: (key: string) => this.values.get(key),
    put: (key: string, value: unknown) => this.putRawSync(key, value),
    delete: (key: string) => this.deleteRawSync(key),
  };

  transactionSync<T>(callback: () => T) {
    const valuesBefore = new Map(
      Array.from(this.values, ([key, value]) => [key, structuredClone(value)]),
    );
    const putCountsBefore = new Map(this.putCounts);
    try {
      return this.sql.transactionSync(callback);
    } catch (error) {
      this.values = valuesBefore;
      this.putCounts = putCountsBefore;
      throw error;
    }
  }

  async get(key: string, options?: { noCache?: boolean }) {
    this.getHistory.push(key);
    if (key === "exact-review-queue" && this.sql.hasNormalizedQueue() && !options?.noCache) {
      return this.sql.readNormalizedQueue();
    }
    return this.values.get(key);
  }

  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === "object") {
      for (const [entryKey, entryValue] of Object.entries(key)) {
        this.throwPutFailure(entryKey);
        this.storeRaw(entryKey, entryValue);
      }
      return;
    }
    this.throwPutFailure(key);
    if (key === "exact-review-queue" && this.sql.hasNormalizedQueue()) {
      const normalized = this.sql.readNormalizedQueue();
      const candidate = (value && typeof value === "object" ? value : {}) as {
        deliveries?: Record<string, number>;
        items?: Record<string, unknown>;
        dispatcher?: unknown;
      };
      const deliveryEntries = Object.entries(candidate.deliveries || {});
      const markerEntries = deliveryEntries.filter(([deliveryId]) =>
        /^__clawsweeper_sql_generation:\d+$/.test(deliveryId),
      );
      const candidateReceipts = Object.fromEntries(
        deliveryEntries.filter(
          ([deliveryId]) => !deliveryId.startsWith("__clawsweeper_sql_generation:"),
        ),
      );
      const normalizedReceiptIds = Object.keys(normalized.deliveries).sort();
      const rollbackShadow =
        markerEntries.length === 1 &&
        markerEntries[0][1] === Number.MAX_SAFE_INTEGER &&
        isDeepStrictEqual(Object.keys(candidateReceipts).sort(), normalizedReceiptIds) &&
        normalizedReceiptIds.every(
          (deliveryId) =>
            Number(candidateReceipts[deliveryId]) >= Number(normalized.deliveries[deliveryId]),
        ) &&
        isDeepStrictEqual(candidate.items || {}, normalized.items) &&
        isDeepStrictEqual(candidate.dispatcher, normalized.dispatcher);
      if (!rollbackShadow) this.sql.replaceNormalizedQueue(candidate);
    }
    this.storeRaw(key, value);
  }

  async delete(key: string) {
    return this.deleteRawSync(key);
  }

  async list(
    options: {
      prefix?: string;
      start?: string;
      startAfter?: string;
      end?: string;
      limit?: number;
      reverse?: boolean;
    } = {},
  ) {
    let entries = [...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .filter(([key]) => !options.start || key >= options.start)
      .filter(([key]) => !options.startAfter || key > options.startAfter)
      .filter(([key]) => !options.end || key < options.end)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (options.reverse) entries.reverse();
    if (options.limit !== undefined) entries = entries.slice(0, options.limit);
    this.listHistory.push({ options: { ...options }, keys: entries.map(([key]) => key) });
    return new Map(entries);
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    this.alarmAt = at;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }

  has(key: string) {
    return this.values.has(key);
  }

  putCount(key: string) {
    return this.putCounts.get(key) || 0;
  }

  rawHas(key: string) {
    return this.values.has(key);
  }

  rawGet(key: string) {
    return this.values.get(key);
  }

  rawPut(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }

  listedKeys(prefix: string) {
    return this.listHistory
      .filter((call) => call.options.prefix === prefix)
      .flatMap((call) => call.keys);
  }

  fetchedKeys(prefix: string) {
    return this.getHistory.filter((key) => key.startsWith(prefix));
  }

  resetGetHistory() {
    this.getHistory = [];
  }

  private throwPutFailure(key: string) {
    if (this.putFailure?.key !== key) return;
    const { error } = this.putFailure;
    this.putFailure = undefined;
    throw error;
  }

  private putRawSync(key: string, value: unknown) {
    this.throwPutFailure(key);
    this.storeRaw(key, value);
  }

  private storeRaw(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
    this.putCounts.set(key, (this.putCounts.get(key) || 0) + 1);
  }

  private deleteRawSync(key: string) {
    if (this.deleteFailure?.key === key) {
      const { error } = this.deleteFailure;
      this.deleteFailure = undefined;
      throw error;
    }
    return this.values.delete(key);
  }

  failNextPut(key: string, error = new Error("injected storage put failure")) {
    this.putFailure = { key, error };
  }

  failNextDelete(key: string, error = new Error("injected storage delete failure")) {
    this.deleteFailure = { key, error };
  }

  failNextSql(pattern: RegExp, error?: Error) {
    this.sql.failNext(pattern, error);
  }

  setExactReviewMigrationTime(migratedAt: number) {
    this.sql.setMigrationTime(migratedAt);
  }

  setExactReviewReceiptTime(deliveryId: string, receivedAt: number) {
    this.sql.setReceiptTime(deliveryId, receivedAt);
  }
}

class MemoryDurableNamespace {
  private stub;

  constructor(stub) {
    this.stub = stub;
  }

  idFromName(name: string) {
    return name;
  }

  get() {
    return this.stub;
  }
}

class MemoryR2Bucket {
  private objects = new Map<string, Uint8Array>();

  async createMultipartUpload(key: string) {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadPart: async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
        parts.set(partNumber, new Uint8Array(value).slice());
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (completed: Array<{ partNumber: number }>) => {
        const selected = completed.map((part) => parts.get(part.partNumber)!);
        const bytes = new Uint8Array(selected.reduce((sum, part) => sum + part.byteLength, 0));
        let offset = 0;
        for (const part of selected) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        this.objects.set(key, bytes);
        return { key, size: bytes.byteLength };
      },
      abort: async () => undefined,
    };
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { key, size: value.byteLength } : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const value = this.objects.get(key);
    if (!value) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? value.byteLength - offset;
    const body = new Response(value.slice(offset, offset + length)).body;
    assert.ok(body);
    return { body, size: value.byteLength };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  keys() {
    return [...this.objects.keys()].sort();
  }
}

class MemoryCache {
  private values = new Map<string, Response>();

  async match(request: Request) {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.values.set(request.url, response.clone());
  }
}

function applyObservation(options: {
  repo?: string;
  runId: string;
  occurredAt: string;
  outcome?: "in_progress" | "success";
  closed?: number | null;
}) {
  return {
    schema_version: 1,
    repo: options.repo ?? "openclaw/openclaw",
    run_id: options.runId,
    run_attempt: 1,
    occurred_at: options.occurredAt,
    started_at: options.occurredAt,
    lifecycle_started: true,
    outcome: options.outcome ?? "success",
    run_url: `https://github.com/openclaw/clawsweeper/actions/runs/${options.runId}`,
    queue: {
      active: 0,
      capacity: 1,
      ready: 0,
      backoff: 0,
      dispatching: 0,
      leased: 0,
      oldest_ready_age_seconds: null,
      oldest_backoff_age_seconds: null,
      oldest_lease_age_seconds: null,
    },
    arrivals: 1,
    results: {
      applied: options.closed ?? 0,
      closed: options.closed ?? 0,
      superseded: 0,
      retried: 0,
      dead_lettered: 0,
    },
    lease: { wait_ms: 0, hold_ms: 0 },
    observed_failure_kinds: [],
    failures: [],
  };
}

async function guardedDeadLetterFixture(number: number, env: Record<string, string> = {}) {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(number, `${number}0`);
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, env);
  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  return { storage, queue, id: listed.dead_letters[0].dead_letter_id as string };
}

function deadLetterFingerprint(ids: string[]): string {
  let fingerprint = 2_166_136_261;
  for (const id of [...ids].sort()) {
    for (const character of `${id}\n`) {
      fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16_777_619) >>> 0;
    }
  }
  return `${ids.length}:${fingerprint.toString(16).padStart(8, "0")}`;
}

function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function completedReviewRun(id: number, itemNumber: number, conclusion: string, ageMs: number) {
  const now = Date.now();
  return {
    id,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${itemNumber}`,
    status: "completed",
    conclusion,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: new Date(now - ageMs).toISOString(),
    updated_at: new Date(now - Math.max(0, ageMs - 10_000)).toISOString(),
  };
}

async function activePrFetch(input: RequestInfo | URL) {
  const url = String(input);
  if (url.includes("/actions/workflows/repair-cluster-worker.yml/runs")) {
    return jsonResponse({ workflow_runs: [] });
  }
  if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
    return jsonResponse({
      workflow_runs: [
        {
          id: 1,
          name: "ClawSweeper",
          display_title: "Review event item openclaw/openclaw#80609",
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
  }
  if (url.includes("/repos/openclaw/openclaw/issues")) return jsonResponse([]);
  if (url.includes("/search/issues")) return jsonResponse({ items: [] });
  throw new Error(`unexpected fetch ${url}`);
}

function triageIssue(number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(repo: string, number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(
  repoOrNumber: string | number,
  numberOrLabels: number | string[],
  maybeLabels?: string[],
) {
  const repo = typeof repoOrNumber === "string" ? repoOrNumber : "openclaw/openclaw";
  const number = typeof repoOrNumber === "string" ? Number(numberOrLabels) : repoOrNumber;
  const labelNames = typeof repoOrNumber === "string" ? maybeLabels || [] : numberOrLabels;
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    created_at: `2026-05-01T00:${String(number % 60).padStart(2, "0")}:00Z`,
    updated_at: `2026-05-02T00:${String(number % 60).padStart(2, "0")}:00Z`,
    comments: 0,
    user: { login: "reporter" },
    assignees: [],
    labels: labelNames.map((name) => ({ name, color: "0E8A16" })),
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function signedGithubWebhookRequest({
  event,
  secret,
  payload,
  deliveryId = "test-delivery",
}: {
  event: string;
  secret: string;
  payload: unknown;
  deliveryId?: string;
}) {
  const body = JSON.stringify(payload);
  return signedGithubWebhookBodyRequest({ event, secret, body, deliveryId });
}

function signedGithubWebhookBodyRequest({
  event,
  secret,
  body,
  deliveryId = "test-delivery",
}: {
  event: string;
  secret: string;
  body: string;
  deliveryId?: string;
}) {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("https://clawsweeper.openclaw.ai/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

function stateAppendQueueRequest(path: string, payload: unknown, origin = "https://queue") {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function signedStateAppendRequest(path: string, payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request(`https://clawsweeper.openclaw.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
}

function createExactReviewAdmissionHarness(
  liveItem: (
    targetRepo: string,
    itemNumber: number,
    itemKind: "issue" | "pull_request",
  ) => Response | Promise<Response>,
  options: {
    maxConcurrent?: string;
    retryPolicyEpoch?: string;
    publicationBatching?: boolean;
    publicationBatchSize?: string;
    publicationFreshLane?: boolean;
    captureBatchDispatch?: boolean;
    workflow?: () => Response | Promise<Response>;
    targetInstallation?: (targetRepo: string) => Response | Promise<Response>;
    targetAccessToken?: (
      installationId: number,
      init: RequestInit | undefined,
    ) => Response | Promise<Response>;
    targetRepository?: (targetRepo: string, init?: RequestInit) => Response | Promise<Response>;
    targetItem?: (targetRepo: string) => Response | Promise<Response>;
    targetPull?: (targetRepo: string) => Response | Promise<Response>;
    targetComments?: (
      targetRepo: string,
      itemNumber: number,
      init: RequestInit | undefined,
      url: URL,
    ) => Response | Promise<Response>;
    producerRun?: (
      runId: string,
      runAttempt: number | null,
      kind: "summary" | "attempt",
    ) => Response | Promise<Response>;
    dispatch?: () => Response | Promise<Response>;
    batchDispatch?: () => Response | Promise<Response>;
    useRealHostedPublicTargetProbe?: boolean;
    hostedPublicTargetProbe?: (
      targetRepo: string,
    ) => Promise<HostedPublicTargetProbe | HostedTargetAdmission>;
  } = {},
) {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  let batchDispatches = 0;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return options.workflow?.() ?? jsonResponse({ state: "active" });
    }
    const installation = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (installation) {
      return options.targetInstallation?.(installation[1]) ?? jsonResponse({ id: 999 });
    }
    const repository = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (repository) {
      return (
        options.targetRepository?.(repository[1], init) ??
        jsonResponse({ full_name: repository[1], private: false, visibility: "public" })
      );
    }
    const accessToken = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (accessToken && options.targetAccessToken) {
      return options.targetAccessToken(Number(accessToken[1]), init);
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "queue-token" });
    }
    const producerRunAttempt = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/attempts\/(\d+)$/,
    );
    if (producerRunAttempt) {
      return (
        options.producerRun?.(producerRunAttempt[1]!, Number(producerRunAttempt[2]), "attempt") ??
        jsonResponse({
          id: producerRunAttempt[1],
          run_attempt: Number(producerRunAttempt[2]),
          status: "in_progress",
        })
      );
    }
    const producerRun = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)$/,
    );
    if (producerRun) {
      return (
        options.producerRun?.(producerRun[1]!, null, "summary") ??
        jsonResponse({ id: producerRun[1], run_attempt: 1, status: "in_progress" })
      );
    }
    const targetItem = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
    if (targetItem) {
      return (
        options.targetItem?.(targetItem[1]) ??
        liveItem(targetItem[1], Number(targetItem[2]), "issue")
      );
    }
    const targetPull = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (targetPull) {
      return (
        options.targetPull?.(targetPull[1]) ??
        options.targetItem?.(targetPull[1]) ??
        liveItem(targetPull[1], Number(targetPull[2]), "pull_request")
      );
    }
    const targetComments = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
    if (targetComments && options.targetComments) {
      return options.targetComments(targetComments[1]!, Number(targetComments[2]), init, url);
    }
    if (
      options.captureBatchDispatch &&
      url.pathname ===
        "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches"
    ) {
      batchDispatches += 1;
      return options.batchDispatch?.() ?? new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return options.dispatch?.() ?? new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const queue = new ExactReviewQueue(
    { storage },
    {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      hostedTargetPredicate: () => true,
      ...(options.useRealHostedPublicTargetProbe
        ? { hostedPublicTargetProbe: undefined }
        : options.hostedPublicTargetProbe
          ? { hostedPublicTargetProbe: options.hostedPublicTargetProbe }
          : {}),
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: options.maxConcurrent ?? "1",
      ...(options.retryPolicyEpoch
        ? { EXACT_REVIEW_RETRY_POLICY_EPOCH: options.retryPolicyEpoch }
        : {}),
      ...(options.publicationBatching
        ? {
            EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
            EXACT_REVIEW_PUBLICATION_BATCH_SIZE: options.publicationBatchSize ?? "1",
            EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "300000",
            ...(options.publicationFreshLane
              ? { EXACT_REVIEW_PUBLICATION_FRESH_LANE_ENABLED: "1" }
              : {}),
          }
        : {}),
    },
  );
  return {
    queue,
    storage,
    dispatched,
    get batchDispatches() {
      return batchDispatches;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function withExactReviewAdmissionHarness<T>(
  harness: ReturnType<typeof createExactReviewAdmissionHarness>,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } finally {
    harness.restore();
  }
}

function buildExactReviewQueueRequest(
  deliveryId: string,
  itemNumber: number,
  sourceAction: string,
  itemKind: "issue" | "pull_request" = "issue",
  targetRepo = "openclaw/gogcli",
  decisionOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
) {
  const sourceEvent = itemKind === "issue" ? "issues" : "pull_request";
  return new Request("https://clawsweeper-exact-review-queue/enqueue", {
    method: "POST",
    body: JSON.stringify({
      delivery_id: deliveryId,
      decision: {
        targetRepo,
        targetBranch: "main",
        itemNumber,
        itemKind,
        sourceEvent,
        sourceAction,
        supersedesInProgress: sourceAction === "edited" || sourceAction === "synchronize",
        ...decisionOverrides,
      },
      ...envelopeOverrides,
    }),
  });
}

function exactReviewPublicationOverrides(
  itemNumber: number,
  producerRunId: string,
  producerSourceAction = "opened",
  leaseRevision = 1,
  targetRepo = "openclaw/gogcli",
) {
  const producerDecision = {
    targetRepo,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: producerSourceAction,
    supersedesInProgress: false,
  };
  return {
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `${targetRepo}#${itemNumber}`,
      protocolVersion: 2,
      leaseRevision,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  };
}

function legacyExactReviewPublicationOverrides(
  itemNumber: number,
  producerRunId: string,
  producerSourceAction = "opened",
  targetRepo = "openclaw/gogcli",
) {
  const publication = exactReviewPublicationOverrides(
    itemNumber,
    producerRunId,
    producerSourceAction,
    1,
    targetRepo,
  ).publication;
  return {
    publication: {
      ...publication,
      protocolVersion: 1,
      leaseRevision: null,
      claimGeneration: null,
    },
  };
}

function leasedExactReviewQueueItem(itemNumber: number, runId: string, runAttempt = 1) {
  const now = Date.now();
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue" as const,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    key: `openclaw/openclaw#${itemNumber}`,
    decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: 1,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    nextAttemptAt: now - 60_000,
    attempts: 0,
    leaseId: `lease-${itemNumber}`,
    leaseRevision: 1,
    leaseExpiresAt: now + 60 * 60_000,
    claimedRunId: runId,
    claimedRunAttempt: runAttempt,
    claimGeneration: 1,
    claimProtocolVersion: 2,
  };
}

function leasedExactReviewPublicationItem(itemNumber: number, runId: string) {
  const item = leasedExactReviewQueueItem(itemNumber, runId);
  const sourceAction = "exact_review_artifact_publish";
  const publication = {
    artifactName: `exact-review-${runId}-1`,
    producerRunId: runId,
    producerRunAttempt: 1,
    sourceSha: "a".repeat(40),
    itemKey: item.key,
    protocolVersion: 2 as const,
    leaseRevision: 1,
    claimGeneration: 1,
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
    producerDecision: item.decision,
  };
  return {
    ...item,
    key: `${item.key}@publish:${runId}:1`,
    decision: { ...item.decision, sourceAction, publication },
    leaseDecision: { ...item.leaseDecision, sourceAction, publication },
  };
}

function unclaimedExactReviewQueueItem(itemNumber: number) {
  return {
    ...leasedExactReviewQueueItem(itemNumber, "unclaimed"),
    state: "dispatching" as const,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
    claimProtocolVersion: undefined,
  };
}

export {
  assert,
  createHash,
  createHmac,
  generateKeyPairSync,
  DatabaseSync,
  fs,
  os,
  path,
  test,
  isDeepStrictEqual,
  createContext,
  Script,
  gunzipSync,
  worker,
  automaticIssueWork,
  ExactReviewQueue,
  completedBayReviews,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewJitteredDelayMs,
  exactReviewPublicationCapacity,
  exactReviewPublicationCapacityForState,
  exactReviewQueueAdmittedItems,
  exactReviewQueueCapacity,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStatusSnapshot,
  mergeBayJourneyState,
  mergeBayTerminalState,
  recentWorkerHealthRunSample,
  workerHealthSectionTimeoutMs,
  readCachedSnapshot,
  StatusStore,
  summarizeAutomergeReliability,
  summarizeBayJourneyTimings,
  workerWorkKind,
  workflowJobsForRunSnapshot,
  ExactReviewPublicationBatchStore,
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
  commandAcknowledgementState,
  EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
  ExactReviewLifecycleTelemetryStore,
  LIVE_ACTIVITY_SOURCE_LIMIT,
  liveActivityBaySnapshot,
  captureCanonicalRecordBaseline,
  publishMainWithStateAppend,
  seededRandom,
  MemoryKv,
  MemorySqlCursor,
  MemorySqlStorage,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  MemoryR2Bucket,
  MemoryCache,
  applyObservation,
  guardedDeadLetterFixture,
  deadLetterFingerprint,
  isoAgo,
  completedReviewRun,
  activePrFetch,
  triageIssue,
  jsonResponse,
  signedGithubWebhookRequest,
  signedGithubWebhookBodyRequest,
  stateAppendQueueRequest,
  signedStateAppendRequest,
  createExactReviewAdmissionHarness,
  withExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  exactReviewPublicationOverrides,
  legacyExactReviewPublicationOverrides,
  leasedExactReviewQueueItem,
  leasedExactReviewPublicationItem,
  unclaimedExactReviewQueueItem,
  type ExactReviewQueueItem,
};
