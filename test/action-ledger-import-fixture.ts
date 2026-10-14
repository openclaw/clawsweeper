import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  actionAttemptId,
  actionEventKey,
  actionIdempotencyKey,
  actionOperationId,
  createActionEvent,
  writeActionEventShards,
} from "../src/action-ledger.ts";
import { importActionEventShards } from "../src/action-ledger-runtime.ts";

export function ledgerImportFixture(root: string, runAttempt = 1, count = 1) {
  root = realpathSync(root);
  const source = path.join(root, `source-${runAttempt}`);
  const destination = path.join(root, `published-${runAttempt}`);
  mkdirSync(source, { recursive: true });
  mkdirSync(destination, { recursive: true });
  const producer = {
    repository: "openclaw/clawsweeper",
    sha: "a".repeat(40),
    workflow: "sweep.yml",
    job: "review",
    runId: "123",
    runAttempt,
    component: "review",
  };
  const events = Array.from({ length: count }, (_, index) => {
    const identity = { runAttempt, index };
    const operationId = actionOperationId(producer.repository, "review", identity);
    return createActionEvent(
      {
        eventKey: actionEventKey("review.completed", identity),
        operationId,
        attemptId: actionAttemptId(operationId, identity),
        parentEventId: null,
        phaseSeq: 1,
        idempotencyKeySha256: actionIdempotencyKey(identity),
        type: "review.completed",
        producer,
        subject: {
          repository: "openclaw/openclaw",
          kind: "pull_request",
          number: index + 1,
          sourceRevision: producer.sha,
        },
        action: {
          name: "review",
          status: "completed",
          reasonCode: "keep_open",
          retryable: false,
          mutation: false,
        },
        occurredAt: "2026-10-12T00:00:00.000Z",
      },
      { now: () => new Date("2026-10-12T00:00:00.000Z") },
    );
  });
  const identity = { ...producer, producer: producer.component, partitionDate: "2026-10-12" };
  writeActionEventShards(source, identity, events);
  const result = importActionEventShards(source, destination);
  const blobs = new Map(
    result.paths.map((relativePath) => [
      relativePath,
      readFileSync(path.join(destination, relativePath)),
    ]),
  );
  return { ...result, destination, source, blobs, events, identity };
}

export class LedgerBucket {
  objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  hidden = new Set<string>();
  seed(key: string, bytes: Uint8Array) {
    this.objects.set(key, {
      bytes,
      customMetadata: { sha256: createHash("sha256").update(bytes).digest("hex") },
    });
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? this.describe(key, object) : null;
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const object = this.objects.get(key);
    if (!object) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? object.bytes.byteLength;
    return {
      ...this.describe(key, object),
      body: new Response(object.bytes.slice(offset, offset + length)).body,
    };
  }
  async put(key: string, bytes: Uint8Array, options?: { customMetadata?: Record<string, string> }) {
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      customMetadata: options?.customMetadata ?? {},
    });
  }
  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix) && !this.hidden.has(key))
      .sort();
    const offset = Number(options.cursor ?? 0);
    const selected = keys.slice(offset, offset + 127);
    const truncated = offset + selected.length < keys.length;
    return {
      objects: selected.map((key) => this.describe(key, this.objects.get(key)!)),
      truncated,
      ...(truncated ? { cursor: String(offset + selected.length) } : {}),
    };
  }
  async createMultipartUpload() {
    throw new Error("unexpected multipart upload");
  }
  resumeMultipartUpload() {
    throw new Error("unexpected multipart upload");
  }
  private describe(
    key: string,
    object: { bytes: Uint8Array; customMetadata: Record<string, string> },
  ) {
    return { key, size: object.bytes.byteLength, customMetadata: object.customMetadata };
  }
}
