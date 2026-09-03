import { createHmac } from "node:crypto";

import type {
  ExactReviewBatchCompletion,
  ExactReviewBatchMember,
} from "./exact-review-batch-publisher.js";
import type { StateWriterOperation, StateWriterProgress } from "../state-writer-telemetry.js";

export type ExactReviewBatchQueueItem = ExactReviewBatchMember & {
  decision: unknown;
  repeatRevision?: boolean;
};

export type ExactReviewGithubRateLimitObservation = {
  scope: "repository_actions" | "target_app";
  targetOwner?: string;
  observedAt: string;
  retryAt: string;
  provenance: "retry_after" | "rate_limit_reset" | "rate_limit_status" | "fallback";
  authoritative: boolean;
};

export type ExactReviewGithubRequestMetric = {
  scope: "repository_actions" | "target_app";
  category:
    | "artifact_download"
    | "rate_status"
    | "comments"
    | "labels"
    | "reviews"
    | "workflow_dispatch"
    | "item_metadata"
    | "other";
  mode: "read" | "mutation_or_private_read";
  outcome: "success" | "throttle" | "transient" | "error" | "skipped_by_circuit";
  repeatRevision: boolean;
  count: number;
};

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
  legacyTerminalScanned: number;
  eligible: number;
  changed: number;
  eligibleRemaining: number;
  staleRevisionEligible: number;
  staleRevisionChanged: number;
  lineageDuplicateEligible: number;
  lineageDuplicateChanged: number;
  lineageRefreshed: number;
  legacyTerminalCandidates: number;
  legacyTerminalSelected: number;
  legacyTerminalEligible: number;
  legacyTerminalChanged: number;
  legacyStateBatchTerminalCandidates: number;
  legacyStateBatchTerminalSelected: number;
  legacyStateBatchTerminalProducerSucceeded: number;
  legacyStateBatchTerminalEligible: number;
  legacyStateBatchTerminalChanged: number;
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
    leaseExpiresAt: string;
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
    rateLimitObservations?: readonly ExactReviewGithubRateLimitObservation[];
    requestMetrics?: readonly ExactReviewGithubRequestMetric[];
    telemetryId?: string;
  }): Promise<{
    accepted: number;
    skipped: number;
    telemetryAccepted: boolean;
    batch: ExactReviewBatchLease;
  }>;
}

type QueueClientOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
};

const POST_EFFECT_ROUTES = {
  enqueue: "/internal/exact-review/enqueue",
  "router-receipt": "/internal/exact-review/lifecycle/router-receipt",
  "terminal-disposition": "/internal/exact-review/lifecycle/terminal-disposition",
} as const;

export type ExactReviewBatchPostEffectRoute = keyof typeof POST_EFFECT_ROUTES;

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DEADLINE_MS = 45_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;

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
    leaseExpiresAt: string;
    items: readonly ExactReviewBatchMember[];
    stateWriterProgress?: StateWriterProgress;
    observation?: { stage: ExactReviewBatchObservationStage; observedAt: string };
  }) {
    const leaseExpiry = Date.parse(input.leaseExpiresAt);
    if (!Number.isFinite(leaseExpiry)) throw new Error("Invalid batch lease expiry");
    const response = await this.postUrl(
      "/internal/exact-review/publication-batches/heartbeat",
      {
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
      },
      Math.min(Date.now() + RETRY_DEADLINE_MS, leaseExpiry),
    );
    return parseLease(response.batch);
  }

  async postEffect(route: ExactReviewBatchPostEffectRoute, payload: string) {
    if (!Object.hasOwn(POST_EFFECT_ROUTES, route))
      throw new Error("Invalid batch post-effect route");
    return this.postUrl(POST_EFFECT_ROUTES[route], payload);
  }

  async reconcilePublications(input: { apply: boolean; maxItems: number }) {
    const response = await this.postUrl("/internal/exact-review/publications/reconcile", {
      apply: input.apply,
      max_items: input.maxItems,
    });
    return {
      apply: response.apply === true,
      scanned: nonNegativeInteger(response.scanned, "scanned"),
      legacyTerminalScanned: nonNegativeInteger(
        response.legacy_terminal_scanned ?? 0,
        "legacy_terminal_scanned",
      ),
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
      legacyTerminalCandidates: nonNegativeInteger(
        response.legacy_terminal_candidates ?? 0,
        "legacy_terminal_candidates",
      ),
      legacyTerminalSelected: nonNegativeInteger(
        response.legacy_terminal_selected ?? 0,
        "legacy_terminal_selected",
      ),
      legacyTerminalEligible: nonNegativeInteger(
        response.legacy_terminal_eligible ?? 0,
        "legacy_terminal_eligible",
      ),
      legacyTerminalChanged: nonNegativeInteger(
        response.legacy_terminal_changed ?? 0,
        "legacy_terminal_changed",
      ),
      legacyStateBatchTerminalCandidates: nonNegativeInteger(
        response.legacy_state_batch_terminal_candidates ?? 0,
        "legacy_state_batch_terminal_candidates",
      ),
      legacyStateBatchTerminalSelected: nonNegativeInteger(
        response.legacy_state_batch_terminal_selected ?? 0,
        "legacy_state_batch_terminal_selected",
      ),
      legacyStateBatchTerminalProducerSucceeded: nonNegativeInteger(
        response.legacy_state_batch_terminal_producer_succeeded ?? 0,
        "legacy_state_batch_terminal_producer_succeeded",
      ),
      legacyStateBatchTerminalEligible: nonNegativeInteger(
        response.legacy_state_batch_terminal_eligible ?? 0,
        "legacy_state_batch_terminal_eligible",
      ),
      legacyStateBatchTerminalChanged: nonNegativeInteger(
        response.legacy_state_batch_terminal_changed ?? 0,
        "legacy_state_batch_terminal_changed",
      ),
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
    rateLimitObservations?: readonly ExactReviewGithubRateLimitObservation[];
    requestMetrics?: readonly ExactReviewGithubRequestMetric[];
    telemetryId?: string;
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
        ...(item.retryAt ? { retry_at: item.retryAt } : {}),
        ...(item.attempted !== undefined ? { attempted: item.attempted } : {}),
        ...(item.poolClass ? { pool_class: item.poolClass } : {}),
      })),
      ...(input.stateCommitSha ? { state_commit_sha: input.stateCommitSha } : {}),
      ...(input.failureFingerprint ? { failure_fingerprint: input.failureFingerprint } : {}),
      ...(input.stateWriter ? { state_writer: input.stateWriter } : {}),
      ...(input.rateLimitObservations?.length
        ? {
            github_rate_limit_observations: input.rateLimitObservations.map((observation) => ({
              scope: observation.scope,
              ...(observation.targetOwner ? { target_owner: observation.targetOwner } : {}),
              observed_at: observation.observedAt,
              retry_at: observation.retryAt,
              provenance: observation.provenance,
              authoritative: observation.authoritative,
            })),
          }
        : {}),
      ...(input.requestMetrics?.length
        ? {
            github_request_metrics: input.requestMetrics.map((metric) => ({
              scope: metric.scope,
              category: metric.category,
              mode: metric.mode,
              outcome: metric.outcome,
              repeat_revision: metric.repeatRevision,
              count: metric.count,
            })),
          }
        : {}),
      ...(input.telemetryId ? { github_telemetry_id: input.telemetryId } : {}),
    });
    return {
      accepted: nonNegativeInteger(response.accepted, "accepted"),
      skipped: nonNegativeInteger(response.skipped, "skipped"),
      telemetryAccepted: response.telemetry_accepted === true,
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
    payload: Record<string, unknown> | string,
    retryDeadline?: number,
  ): Promise<Record<string, unknown>> {
    // Serialize and sign once: receipt/delivery identity must survive ambiguous failures.
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
    const deadline = retryDeadline ?? Date.now() + REQUEST_TIMEOUT_MS;
    const maxAttempts = retryDeadline === undefined ? 1 : MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Batch queue ${path} deadline expired`);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException("Batch queue request timeout", "TimeoutError")),
        Math.min(REQUEST_TIMEOUT_MS, remaining),
      );
      let response: Response | undefined;
      let responseText: string | undefined;
      let errorCode: string | undefined;
      let failure: Error | undefined;
      let reason: string | undefined;
      try {
        response = await this.request(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": signature,
          },
          body,
          signal: controller.signal,
        });
        if (response.ok) {
          responseText = await response.text();
        } else {
          // Status alone determines retryability, even for plain-text edge errors.
          errorCode = await responseErrorCode(response);
          throw new Error(
            `Batch queue ${path} failed (HTTP ${response.status})${errorCode ? `: ${errorCode}` : ""}`,
          );
        }
      } catch (error) {
        const status = response?.status;
        if (status !== undefined && !response!.ok && (status < 500 || status > 599)) throw error;
        reason =
          status !== undefined && !response!.ok
            ? `HTTP_${status}`
            : controller.signal.aborted ||
                error?.name === "TimeoutError" ||
                error?.name === "AbortError"
              ? "timeout"
              : "network_error";
        // Only a validated server code may accompany the closed failure class.
        failure = new Error(
          `Batch queue ${path} failed (${reason.startsWith("HTTP_") ? reason.replace("_", " ") : reason})${errorCode ? `: ${errorCode}` : ""}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!failure) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(responseText ?? "");
        } catch {
          throw new Error(`Batch queue ${path} returned invalid JSON (HTTP ${response!.status})`);
        }
        return objectValue(parsed);
      }
      if (attempt === maxAttempts) throw failure;
      const backoff = Math.floor(1_000 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5));
      const delay = Math.max(
        backoff,
        retryAfterMs(response?.headers.get("retry-after"), Date.now()),
      );
      // No new request can be admitted once this confirmed lease/deadline expires.
      if (Date.now() + delay >= deadline) throw failure;
      console.warn(
        `Batch queue retry endpoint=${path} reason=${reason} attempt=${attempt + 1}/${maxAttempts}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    throw new Error(`Batch queue ${path} retry attempts exhausted`);
  }
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    const bytes = new Uint8Array(512);
    let length = 0;
    while (length < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, bytes.length - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    const error = objectValue(parsed).error;
    return typeof error === "string" && /^[a-z0-9_]{1,64}$/.test(error) ? error : undefined;
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function retryAfterMs(value: string | null | undefined, now: number): number {
  if (!value) return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay)) : 0;
}

function parseQueueItem(value: unknown): ExactReviewBatchQueueItem {
  const item = objectValue(value);
  return {
    ...parseMember(item),
    decision: item.decision,
    ...(item.repeat_revision === true ? { repeatRevision: true } : {}),
  };
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
