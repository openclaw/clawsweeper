import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  ExactReviewBatchCompletion,
  ExactReviewBatchMember,
} from "./exact-review-batch-publisher.js";

export type ExactReviewBatchQueueItem = ExactReviewBatchMember & { decision: unknown };

export type ExactReviewBatchLease = {
  batchId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  items: ExactReviewBatchMember[];
};

export type ExactReviewBatchFetch = {
  batch: ExactReviewBatchLease;
  items: ExactReviewBatchQueueItem[];
  superseded: number;
};

export interface ExactReviewBatchQueue {
  claim(input: {
    claimId: string;
    leaseOwner: string;
    maxItems: number;
  }): Promise<ExactReviewBatchLease | null>;
  fetch(input: { batchId: string; leaseOwner: string }): Promise<ExactReviewBatchFetch>;
  heartbeat(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchMember[];
  }): Promise<ExactReviewBatchLease>;
  complete(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchCompletion[];
    stateCommitSha?: string;
    failureFingerprint?: string;
  }): Promise<{ accepted: number; skipped: number; batch: ExactReviewBatchLease }>;
}

type QueueClientOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
};

export class ExactReviewBatchQueueClient implements ExactReviewBatchQueue {
  private readonly baseUrl: string;
  private readonly webhookSecret: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: QueueClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    if (!this.baseUrl.startsWith("https://")) throw new Error("Batch queue URL must use HTTPS");
    if (!options.webhookSecret) throw new Error("Batch queue webhook secret is required");
    this.webhookSecret = options.webhookSecret;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async claim(input: { claimId: string; leaseOwner: string; maxItems: number }) {
    const response = await this.post("claim", {
      claim_id: input.claimId,
      lease_owner: input.leaseOwner,
      max_items: input.maxItems,
    });
    if (response.claimed !== true) return null;
    return parseLease(response.batch);
  }

  async fetch(input: { batchId: string; leaseOwner: string }) {
    const response = await this.post("fetch", {
      batch_id: input.batchId,
      lease_owner: input.leaseOwner,
    });
    const items = arrayValue(response.items).map(parseQueueItem);
    return {
      batch: parseLease(response.batch),
      items,
      superseded: nonNegativeInteger(response.superseded, "superseded"),
    };
  }

  async heartbeat(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchMember[];
  }) {
    const response = await this.post("heartbeat", {
      batch_id: input.batchId,
      lease_owner: input.leaseOwner,
      items: input.items.map((item) => ({
        item_key: item.itemKey,
        revision: item.revision,
        claim_generation: item.claimGeneration,
      })),
    });
    return parseLease(response.batch);
  }

  async complete(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchCompletion[];
    stateCommitSha?: string;
    failureFingerprint?: string;
  }) {
    const response = await this.post("complete", {
      batch_id: input.batchId,
      lease_owner: input.leaseOwner,
      items: input.items.map((item) => ({
        item_key: item.itemKey,
        revision: item.revision,
        claim_generation: item.claimGeneration,
        terminal_outcome: item.terminalOutcome,
      })),
      ...(input.stateCommitSha ? { state_commit_sha: input.stateCommitSha } : {}),
      ...(input.failureFingerprint ? { failure_fingerprint: input.failureFingerprint } : {}),
    });
    return {
      accepted: nonNegativeInteger(response.accepted, "accepted"),
      skipped: nonNegativeInteger(response.skipped, "skipped"),
      batch: parseLease(response.batch),
    };
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
    const response = await this.request(
      `${this.baseUrl}/internal/exact-review/publication-batches/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      },
    );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Batch queue ${path} returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const error = objectValue(parsed).error;
      throw new Error(
        `Batch queue ${path} failed (HTTP ${response.status}): ${String(error || "unknown")}`,
      );
    }
    return objectValue(parsed);
  }
}

export function verifyExactReviewBatchSignature(
  body: string,
  signature: string,
  webhookSecret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseQueueItem(value: unknown): ExactReviewBatchQueueItem {
  const item = objectValue(value);
  return { ...parseMember(item), decision: item.decision };
}

function parseLease(value: unknown): ExactReviewBatchLease {
  const batch = objectValue(value);
  const leaseOwner = stringValue(batch.lease_owner, "lease_owner");
  const leaseExpiresAt = stringValue(batch.lease_expires_at, "lease_expires_at");
  if (!Number.isFinite(Date.parse(leaseExpiresAt))) throw new Error("Invalid batch lease expiry");
  return {
    batchId: stringValue(batch.batch_id, "batch_id"),
    leaseOwner,
    leaseExpiresAt,
    items: arrayValue(batch.items).map(parseMember),
  };
}

function parseMember(value: unknown): ExactReviewBatchMember {
  const item = objectValue(value);
  return {
    itemKey: stringValue(item.item_key, "item_key"),
    revision: positiveInteger(item.revision, "revision"),
    claimGeneration: positiveInteger(item.claim_generation, "claim_generation"),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid batch queue response object");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid batch queue response array");
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid batch queue ${name}`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Invalid batch queue ${name}`);
  return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid batch queue ${name}`);
  return result;
}
