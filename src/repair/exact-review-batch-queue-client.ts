import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  ExactReviewBatchCompletion,
  ExactReviewBatchMember,
} from "./exact-review-batch-publisher.js";
import type { StateWriterOperation, StateWriterProgress } from "../state-writer-telemetry.js";

export type ExactReviewBatchQueueItem = ExactReviewBatchMember & { decision: unknown };

export type ExactReviewBatchLease = {
  batchId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  items: ExactReviewBatchMember[];
};

export type ExactReviewBatchClaim = ExactReviewBatchLease & {
  configuredBatchSize: number;
  batchWaitMs: number;
};

export type ExactReviewBatchObservationStage =
  | "preparation_started"
  | "preparation_finished"
  | "final_github_apply"
  | "github_throttle";

export type ExactReviewBatchFetch = {
  batch: ExactReviewBatchLease;
  items: ExactReviewBatchQueueItem[];
  superseded: number;
};

export type ExactReviewPublicationReconcileResult = {
  apply: boolean;
  scanned: number;
  eligible: number;
  changed: number;
  eligibleRemaining: number;
  staleRevisionEligible: number;
  staleRevisionChanged: number;
  lineageDuplicateEligible: number;
  lineageDuplicateChanged: number;
  lineageRefreshed: number;
  protectedBatchItems: number;
  protectedLineageItems: number;
  oldestEligibleAgeSeconds: number | null;
  oldestRemainingAgeSeconds: number | null;
};

export interface ExactReviewBatchQueue {
  claim(input: {
    claimId: string;
    leaseOwner: string;
    maxItems: number;
    dispatch?: { id: string; at: string };
    runner?: { runId: string; runAttempt: number; startedAt: string };
  }): Promise<ExactReviewBatchClaim | null>;
  fetch(input: { batchId: string; leaseOwner: string }): Promise<ExactReviewBatchFetch>;
  heartbeat(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchMember[];
    stateWriterProgress?: StateWriterProgress;
    observation?: { stage: ExactReviewBatchObservationStage; observedAt: string };
  }): Promise<ExactReviewBatchLease>;
  complete(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchCompletion[];
    stateCommitSha?: string;
    failureFingerprint?: string;
    stateWriter?: StateWriterOperation;
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

  async claim(input: {
    claimId: string;
    leaseOwner: string;
    maxItems: number;
    dispatch?: { id: string; at: string };
    runner?: { runId: string; runAttempt: number; startedAt: string };
  }) {
    const response = await this.post("claim", {
      claim_id: input.claimId,
      lease_owner: input.leaseOwner,
      max_items: input.maxItems,
      ...(input.dispatch
        ? { dispatch_id: input.dispatch.id, dispatched_at: input.dispatch.at }
        : {}),
      ...(input.runner
        ? {
            runner_run_id: input.runner.runId,
            runner_run_attempt: input.runner.runAttempt,
            runner_started_at: input.runner.startedAt,
          }
        : {}),
    });
    if (response.claimed !== true) return null;
    const batch = parseLease(response.batch);
    const legacyConfiguredBatchSize =
      response.effective_max_items !== undefined
        ? positiveInteger(response.effective_max_items, "effective_max_items")
        : input.maxItems;
    return {
      ...batch,
      // During a rolling dashboard deploy, current-main workers advertise the cap
      // under effective_max_items. On rollback, an older worker can return a lease
      // created at a larger cap, so its membership is also a safe lower bound.
      configuredBatchSize:
        response.configured_batch_size !== undefined
          ? positiveInteger(response.configured_batch_size, "configured_batch_size")
          : Math.max(legacyConfiguredBatchSize, batch.items.length),
      batchWaitMs: nonNegativeInteger(response.batch_wait_ms, "batch_wait_ms"),
    };
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
    stateWriterProgress?: StateWriterProgress;
    observation?: { stage: ExactReviewBatchObservationStage; observedAt: string };
  }) {
    const response = await this.post("heartbeat", {
      batch_id: input.batchId,
      lease_owner: input.leaseOwner,
      items: input.items.map((item) => ({
        item_key: item.itemKey,
        revision: item.revision,
        claim_generation: item.claimGeneration,
      })),
      ...(input.stateWriterProgress ? { state_writer_progress: input.stateWriterProgress } : {}),
      ...(input.observation
        ? {
            timeline_stage: input.observation.stage,
            observed_at: input.observation.observedAt,
          }
        : {}),
    });
    return parseLease(response.batch);
  }

  async reconcilePublications(input: { apply: boolean; maxItems: number }) {
    const response = await this.postUrl("/internal/exact-review/publications/reconcile", {
      apply: input.apply,
      max_items: input.maxItems,
    });
    return {
      apply: response.apply === true,
      scanned: nonNegativeInteger(response.scanned, "scanned"),
      eligible: nonNegativeInteger(response.eligible, "eligible"),
      changed: nonNegativeInteger(response.changed, "changed"),
      eligibleRemaining: nonNegativeInteger(response.eligible_remaining, "eligible_remaining"),
      staleRevisionEligible: nonNegativeInteger(
        response.stale_revision_eligible ?? response.eligible,
        "stale_revision_eligible",
      ),
      staleRevisionChanged: nonNegativeInteger(
        response.stale_revision_changed ?? response.changed,
        "stale_revision_changed",
      ),
      lineageDuplicateEligible: nonNegativeInteger(
        response.lineage_duplicate_eligible ?? 0,
        "lineage_duplicate_eligible",
      ),
      lineageDuplicateChanged: nonNegativeInteger(
        response.lineage_duplicate_changed ?? 0,
        "lineage_duplicate_changed",
      ),
      lineageRefreshed: nonNegativeInteger(response.lineage_refreshed ?? 0, "lineage_refreshed"),
      protectedBatchItems: nonNegativeInteger(
        response.protected_batch_items,
        "protected_batch_items",
      ),
      protectedLineageItems: nonNegativeInteger(
        response.protected_lineage_items ?? 0,
        "protected_lineage_items",
      ),
      oldestEligibleAgeSeconds: nullableNonNegativeInteger(
        response.oldest_eligible_age_seconds,
        "oldest_eligible_age_seconds",
      ),
      oldestRemainingAgeSeconds: nullableNonNegativeInteger(
        response.oldest_remaining_age_seconds,
        "oldest_remaining_age_seconds",
      ),
    } satisfies ExactReviewPublicationReconcileResult;
  }

  async complete(input: {
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchCompletion[];
    stateCommitSha?: string;
    failureFingerprint?: string;
    stateWriter?: StateWriterOperation;
  }) {
    const response = await this.post("complete", {
      batch_id: input.batchId,
      lease_owner: input.leaseOwner,
      items: input.items.map((item) => ({
        item_key: item.itemKey,
        revision: item.revision,
        claim_generation: item.claimGeneration,
        terminal_outcome: item.terminalOutcome,
        ...(item.reasonCode ? { reason_code: item.reasonCode } : {}),
        ...(item.errorFingerprint ? { error_fingerprint: item.errorFingerprint } : {}),
      })),
      ...(input.stateCommitSha ? { state_commit_sha: input.stateCommitSha } : {}),
      ...(input.failureFingerprint ? { failure_fingerprint: input.failureFingerprint } : {}),
      ...(input.stateWriter ? { state_writer: input.stateWriter } : {}),
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
    return this.postUrl(`/internal/exact-review/publication-batches/${path}`, payload);
  }

  private async postUrl(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
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

function nullableNonNegativeInteger(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : nonNegativeInteger(value, name);
}
