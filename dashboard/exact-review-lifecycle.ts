import type { DurableStorage } from "./durable-storage.ts";

export const EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE = "exact_review_lifecycle_projection_v1";
export const EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS = 5 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_BAY_SAMPLE_LIMIT = 24;
export const EXACT_REVIEW_LIFECYCLE_BAY_TELEMETRY_RECOVERY_BATCH_LIMIT = 256;
export const EXACT_REVIEW_LIFECYCLE_AUDIT_READ_LIMIT = 10_000;
export const EXACT_REVIEW_LIFECYCLE_AUDIT_PAGE_MAX = 100;
export const EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_MAX_ACTIVE = 4;
const EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE = "exact_review_lifecycle_audit_snapshots_v1";
const EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_ROW_TABLE =
  "exact_review_lifecycle_audit_snapshot_rows_v1";

export type LifecycleTerminalDisposition =
  | "review_completed_routed"
  | "superseded"
  | "requeue"
  | "dead_letter"
  | "target_closed"
  | "target_missing"
  | "policy_noop"
  | "guarded_open"
  | "failure";

export type LifecycleState =
  | "pending"
  | "completed"
  | "acknowledgement_pending"
  | "acknowledgement_skipped"
  | "superseded"
  | "requeue"
  | "dead_letter"
  | "target_closed"
  | "target_missing"
  | "policy_noop"
  | "guarded_open"
  | "failed";

export type CommandAcknowledgementState =
  | "not_required"
  | "pending"
  | "observed"
  | "skipped_locked"
  | "skipped_missing_comment"
  | "unavailable";

export type CommandAcknowledgementTerminalSkipReason =
  | "locked_conversation"
  | "missing_status_comment";

export const COMMAND_ACKNOWLEDGEMENT_TERMINAL_SKIP_REASONS: readonly [
  CommandAcknowledgementTerminalSkipReason,
  ...CommandAcknowledgementTerminalSkipReason[],
] = ["locked_conversation", "missing_status_comment"];

export type DurableLifecycleBayLane =
  | "pending"
  | "acknowledgement_pending"
  | "completed"
  | "superseded"
  | "requeued"
  | "terminal_attention";

export type DurableLifecycleBayUnknownReason =
  | "unavailable"
  | "malformed"
  | "mixed"
  | "stale"
  | "over_cap";

export type DurableLifecycleBaySnapshot = {
  version: 1;
  source: "exact-review-lifecycle-projection-v1";
  generated_at: string;
  freshness: { maximum_age_ms: number };
  collection:
    | { state: "complete" }
    | { state: "unknown"; reason: DurableLifecycleBayUnknownReason };
  inventory: {
    lifecycle_records: number;
    target_revisions: number;
    unique_targets: number;
  } | null;
  lanes: Record<DurableLifecycleBayLane, number> | null;
  sample: {
    limit: number;
    returned: number;
    omitted: number;
    cards: DurableLifecycleBayCard[];
  } | null;
};

export type DurableLifecycleBayCard = {
  target: { repository: string; number: number; url: string };
  revision: number;
  state: LifecycleState;
  lane: DurableLifecycleBayLane;
  terminal_label: string | null;
  terminal_history: LifecycleTerminalDisposition[];
  current_revision: boolean;
  facts: {
    admission: "recorded";
    claim_count: number;
    review_result: "completed" | "failed" | "cancelled" | null;
    github_effect_recorded: boolean;
    canonical_receipts: Array<"accepted" | "deduped" | "superseded">;
    router_receipt: "durable" | "not_required" | null;
    acknowledgement: CommandAcknowledgementState;
  };
  updated_at: string;
  age_ms: number;
  provenance: "exact-review-lifecycle-projection-v1";
};

export type DurableLifecycleAuditInventory = {
  version: 1;
  source: "exact-review-lifecycle-projection-v1";
  generated_at: string;
  collection:
    | { state: "complete" }
    | { state: "unknown"; reason: DurableLifecycleBayUnknownReason };
  snapshot: {
    id: string;
    created_at: string;
    expires_at: string;
    total_records: number;
    retention_ms: number;
  } | null;
  page: {
    limit: number;
    returned: number;
    next_cursor: string | null;
    records: DurableLifecycleBayCard[];
  } | null;
};

type LifecycleClaimFact = {
  fenceKey: string;
  claimGeneration: number;
  runId: string;
  runAttempt: number | null;
  claimedAt: number;
};

type LifecycleReviewResultFact = Omit<LifecycleClaimFact, "claimedAt"> & {
  outcome: "completed" | "failed" | "cancelled";
  observedAt: number;
};

type LifecycleAcknowledgementAttempt = {
  attemptId: string;
  statusMarker: string | null;
  statusCommentId: number | null;
  attemptedAt: number;
  failedAt?: number;
  expiredAt?: number;
  terminalSkip?: { reason: CommandAcknowledgementTerminalSkipReason; observedAt: number };
};

export type ExactReviewLifecycleProjection = {
  version: 1;
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  admission: {
    deliveryId: string;
    sourceDeliveryId?: string;
    bayJourneyDeliveryId?: string;
    sourceAction: string;
    commandOriginated: boolean;
    statusMarker: string | null;
    statusCommentId: number | null;
    /** Webhook/source time when available; legacy rows fall back to admission time. */
    triggeredAt?: number;
    admittedAt: number;
  };
  claims: LifecycleClaimFact[];
  reviewResults: LifecycleReviewResultFact[];
  githubEffect: { commentId: number; digest: string; observedAt: number } | null;
  canonicalReceipts: Array<{
    outcome: "accepted" | "deduped" | "superseded";
    receiptId: string;
    observedAt: number;
  }>;
  /**
   * Every durable router handoff for this revision. A router may be safely
   * retried from a new GitHub run, so its receipt identifier is not a
   * singleton fact.
   */
  routerReceipts: Array<{
    outcome: "durable" | "not_required";
    receiptId: string;
    observedAt: number;
    operationComplete?: true;
  }>;
  /** The first durable handoff retained for the completion-state contract. */
  routerReceipt: {
    outcome: "durable" | "not_required";
    receiptId: string;
    observedAt: number;
  } | null;
  acknowledgement: {
    required: boolean;
    attempts: LifecycleAcknowledgementAttempt[];
    observed: {
      statusMarker: string | null;
      commandCommentId: number;
      completionCommentId: number;
      observedAt: number;
    } | null;
  };
  /**
   * Immutable terminal facts, including a retry/requeue fact that was later
   * followed by a durable completion of the same admitted revision.
   */
  terminalDispositions: Array<{ kind: LifecycleTerminalDisposition; observedAt: number }>;
  /** Applied terminal POST identities, retained with the revision's receipt history. */
  terminalOperationIds: Array<{ operationId: string; kind: LifecycleTerminalDisposition }>;
  /** Current terminal outcome used to derive lifecycle and acknowledgement state. */
  terminalDisposition: { kind: LifecycleTerminalDisposition; observedAt: number } | null;
  /**
   * A terminal fact that has not yet been durably materialized into the Bay
   * aggregate. This lives with the source projection so a telemetry-table
   * outage cannot make the completion undiscoverable.
   */
  bayTelemetryPending: boolean;
  /**
   * The current terminal fact already reflected in Bay's compact aggregate.
   * It keeps repeated finalizer delivery idempotent after the short timing
   * window has expired and its row has been pruned from Bay telemetry.
   */
  bayTelemetryEventId?: string;
  updatedAt: number;
};

type ProjectionIdentity = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
};
type LifecycleAdmissionInput = ProjectionIdentity & {
  deliveryId: string;
  sourceDeliveryId?: string;
  bayJourneyDeliveryId?: string;
  sourceAction: string;
  commandOriginated: boolean;
  statusMarker: string | null;
  statusCommentId: number | null;
  triggeredAt?: number;
  observedAt: number;
};

export class ExactReviewLifecycleProjectionStore {
  private readonly storage: DurableStorage;
  private schemaReady = false;
  private auditSchemaReady = false;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    if (this.schemaReady) return;
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} (
         canonical_target_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         fence_key TEXT NOT NULL,
         projection_json TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         bay_telemetry_pending INTEGER NOT NULL DEFAULT 0 CHECK (bay_telemetry_pending IN (0, 1)),
         PRIMARY KEY (canonical_target_key, fence_key, revision)
       ) STRICT`,
    );
    try {
      Array.from(
        this.storage.sql.exec(
          `SELECT bay_telemetry_pending FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} LIMIT 1`,
        ),
      );
    } catch {
      this.storage.sql.exec(
        `ALTER TABLE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
           ADD COLUMN bay_telemetry_pending INTEGER NOT NULL DEFAULT 0
           CHECK (bay_telemetry_pending IN (0, 1))`,
      );
    }
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_projection_fence
          ON ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} (fence_key, revision)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_projection_bay
          ON ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          (updated_at DESC, canonical_target_key, fence_key, revision)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_projection_bay_repository_v2
          ON ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          (
            LOWER(SUBSTR(canonical_target_key, 1, INSTR(canonical_target_key, '#') - 1)),
            updated_at DESC,
            canonical_target_key,
            fence_key,
            revision DESC
          )`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_projection_bay_telemetry_pending
         ON ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
         (bay_telemetry_pending, updated_at, canonical_target_key, fence_key, revision)`,
    );
    this.schemaReady = true;
  }

  recordAdmission(input: LifecycleAdmissionInput) {
    return this.storage.transactionSync(() => this.recordAdmissionSync(input));
  }

  recordAdmissionSync(input: LifecycleAdmissionInput) {
    this.validateIdentity(input);
    if (!validText(input.deliveryId, 1, 300) || !validText(input.sourceAction, 1, 200)) {
      throw new Error("invalid lifecycle admission fact");
    }
    if (input.sourceDeliveryId !== undefined && !validText(input.sourceDeliveryId, 1, 200)) {
      throw new Error("invalid lifecycle source delivery identity");
    }
    if (
      input.bayJourneyDeliveryId !== undefined &&
      !validText(input.bayJourneyDeliveryId, 1, 200)
    ) {
      throw new Error("invalid lifecycle Bay journey delivery identity");
    }
    if (input.statusMarker !== null && !validText(input.statusMarker, 1, 300)) {
      throw new Error("invalid lifecycle status marker");
    }
    if (input.statusCommentId !== null && !positiveInteger(input.statusCommentId)) {
      throw new Error("invalid lifecycle status comment id");
    }
    if (input.triggeredAt !== undefined && !finiteTimestamp(input.triggeredAt)) {
      throw new Error("invalid lifecycle trigger time");
    }
    this.ensureSchemaSync();
    const existing = this.readSync(input.canonicalTargetKey, input.fenceKey, input.revision);
    if (existing) {
      this.assertIdentity(existing, input);
      const admission = existing.admission;
      if (
        admission.deliveryId !== input.deliveryId ||
        admission.sourceDeliveryId !== input.sourceDeliveryId ||
        admission.bayJourneyDeliveryId !== input.bayJourneyDeliveryId ||
        admission.sourceAction !== input.sourceAction ||
        admission.commandOriginated !== input.commandOriginated ||
        admission.statusMarker !== input.statusMarker ||
        admission.statusCommentId !== input.statusCommentId ||
        (admission.triggeredAt !== undefined &&
          admission.triggeredAt !== (input.triggeredAt ?? input.observedAt))
      ) {
        throw new Error("conflicting lifecycle admission fact");
      }
      return existing;
    }
    const projection: ExactReviewLifecycleProjection = {
      version: 1,
      canonicalTargetKey: input.canonicalTargetKey,
      fenceKey: input.fenceKey,
      revision: input.revision,
      admission: {
        deliveryId: input.deliveryId,
        ...(input.sourceDeliveryId ? { sourceDeliveryId: input.sourceDeliveryId } : {}),
        ...(input.bayJourneyDeliveryId ? { bayJourneyDeliveryId: input.bayJourneyDeliveryId } : {}),
        sourceAction: input.sourceAction,
        commandOriginated: input.commandOriginated,
        statusMarker: input.statusMarker,
        statusCommentId: input.statusCommentId,
        ...(input.triggeredAt === undefined ? {} : { triggeredAt: input.triggeredAt }),
        admittedAt: input.observedAt,
      },
      claims: [],
      reviewResults: [],
      githubEffect: null,
      canonicalReceipts: [],
      routerReceipts: [],
      routerReceipt: null,
      acknowledgement: { required: input.commandOriginated, attempts: [], observed: null },
      terminalDispositions: [],
      terminalOperationIds: [],
      terminalDisposition: null,
      bayTelemetryPending: false,
      updatedAt: input.observedAt,
    };
    this.writeSync(projection);
    return projection;
  }

  recordClaim(
    input: ProjectionIdentity &
      Omit<LifecycleClaimFact, "fenceKey" | "claimedAt"> & {
        observedAt: number;
      },
  ) {
    this.validateIdentity(input);
    if (!positiveInteger(input.claimGeneration) || !validRunId(input.runId)) {
      throw new Error("invalid lifecycle claim fact");
    }
    if (input.runAttempt !== null && !positiveInteger(input.runAttempt)) {
      throw new Error("invalid lifecycle claim attempt");
    }
    return this.mutate(input, (projection) => {
      const fact: LifecycleClaimFact = {
        fenceKey: input.fenceKey,
        claimGeneration: input.claimGeneration,
        runId: input.runId,
        runAttempt: input.runAttempt,
        claimedAt: input.observedAt,
      };
      const existing = projection.claims.find((candidate) => sameClaim(candidate, fact));
      if (!existing) projection.claims.push(fact);
      return projection;
    });
  }

  recordReviewResult(
    input: ProjectionIdentity &
      Omit<LifecycleReviewResultFact, "fenceKey" | "observedAt"> & {
        observedAt: number;
      },
  ) {
    return this.recordReviewResultIfPresent(input, true)!;
  }

  recordReviewResultIfPresent(
    input: ProjectionIdentity &
      Omit<LifecycleReviewResultFact, "fenceKey" | "observedAt"> & { observedAt: number },
    requirePresent = false,
  ) {
    this.validateIdentity(input);
    return this.mutate<ExactReviewLifecycleProjection | null>(
      input,
      (projection) => {
        // Legacy leases without admission rows have no lifecycle metadata to validate.
        if (!positiveInteger(input.claimGeneration) || !validRunId(input.runId)) {
          throw new Error("invalid lifecycle review result");
        }
        if (input.runAttempt !== null && !positiveInteger(input.runAttempt)) {
          throw new Error("invalid lifecycle review result attempt");
        }
        const fact: LifecycleReviewResultFact = {
          fenceKey: input.fenceKey,
          claimGeneration: input.claimGeneration,
          runId: input.runId,
          runAttempt: input.runAttempt,
          outcome: input.outcome,
          observedAt: input.observedAt,
        };
        const existing = projection.reviewResults.find((candidate) =>
          sameReviewResult(candidate, fact),
        );
        if (!existing) projection.reviewResults.push(fact);
        return projection;
      },
      true,
      requirePresent ? undefined : () => null,
    );
  }

  recordGithubEffect(
    input: ProjectionIdentity & {
      commentId: number;
      digest: string;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    if (!positiveInteger(input.commentId) || !/^[0-9a-f]{64}$/.test(input.digest)) {
      throw new Error("invalid lifecycle GitHub effect");
    }
    return this.mutate(input, (projection) => {
      const next = {
        commentId: input.commentId,
        digest: input.digest,
        observedAt: input.observedAt,
      };
      if (
        projection.githubEffect &&
        (projection.githubEffect.commentId !== next.commentId ||
          projection.githubEffect.digest !== next.digest)
      ) {
        throw new Error("conflicting lifecycle GitHub effect");
      }
      projection.githubEffect ??= next;
      return projection;
    });
  }

  recordCanonicalReceipt(
    input: ProjectionIdentity & {
      outcome: "accepted" | "deduped" | "superseded";
      receiptId: string;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    if (!validText(input.receiptId, 1, 300)) throw new Error("invalid lifecycle canonical receipt");
    return this.mutate(input, (projection) => {
      const existing = projection.canonicalReceipts.find(
        (candidate) => candidate.receiptId === input.receiptId,
      );
      if (existing && existing.outcome !== input.outcome) {
        throw new Error("conflicting lifecycle canonical receipt");
      }
      if (!existing) {
        projection.canonicalReceipts.push({
          outcome: input.outcome,
          receiptId: input.receiptId,
          observedAt: input.observedAt,
        });
      }
      return projection;
    });
  }

  recordRouterReceipt(
    input: ProjectionIdentity & {
      outcome: "durable" | "not_required";
      receiptId: string;
      observedAt: number;
      operationComplete?: true;
    },
  ) {
    return this.storage.transactionSync(() => this.recordRouterReceiptSync(input).projection);
  }

  recordRouterReceiptSync(
    input: ProjectionIdentity & {
      outcome: "durable" | "not_required";
      receiptId: string;
      observedAt: number;
      operationComplete?: true;
    },
  ) {
    this.validateIdentity(input);
    if (!validText(input.receiptId, 1, 300)) throw new Error("invalid lifecycle router receipt");
    return this.mutateIdempotentlySync(input, (projection) => {
      const next = {
        outcome: input.outcome,
        receiptId: input.receiptId,
        observedAt: input.observedAt,
        ...(input.operationComplete ? { operationComplete: input.operationComplete } : {}),
      };
      const existing = projection.routerReceipts.find(
        (candidate) => candidate.receiptId === next.receiptId,
      );
      if (existing && existing.outcome !== next.outcome) {
        throw new Error("conflicting lifecycle router receipt");
      }
      if (projection.routerReceipt && projection.routerReceipt.outcome !== next.outcome) {
        throw new Error("conflicting lifecycle router receipt");
      }
      if (existing && (existing.operationComplete || !input.operationComplete)) return true;
      if (!existing) projection.routerReceipts.push(next);
      else if (input.operationComplete) existing.operationComplete = true;
      projection.routerReceipt ??= next;
      return false;
    });
  }

  recordTerminalDisposition(
    input: ProjectionIdentity & {
      kind: LifecycleTerminalDisposition;
      operationId?: string;
      observedAt: number;
    },
  ) {
    return this.storage.transactionSync(() => this.recordTerminalDispositionSync(input).projection);
  }

  recordTerminalDispositionSync(
    input: ProjectionIdentity & {
      kind: LifecycleTerminalDisposition;
      operationId?: string;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    if (input.operationId !== undefined && !validText(input.operationId, 1, 300)) {
      throw new Error("invalid lifecycle terminal operation id");
    }
    return this.mutateIdempotentlySync(input, (projection) => {
      if (input.operationId) {
        const operation = projection.terminalOperationIds.find(
          (entry) => entry.operationId === input.operationId,
        );
        if (operation) {
          if (operation.kind !== input.kind) {
            throw new Error("conflicting lifecycle terminal operation");
          }
          return true;
        }
      }
      const terminal = applyTerminalDisposition(projection, input);
      if (input.operationId) {
        terminal.terminalOperationIds.push({ operationId: input.operationId, kind: input.kind });
      }
      terminal.bayTelemetryPending = true;
      return false;
    });
  }

  authorizeCommandAcknowledgement(
    input: ProjectionIdentity & {
      statusMarker: string | null;
      statusCommentId: number | null;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    validateAcknowledgementAddress(input.statusMarker, input.statusCommentId);
    return this.mutate(
      input,
      (projection) => {
        const lifecycle = lifecycleState(projection);
        const acknowledgement = commandAcknowledgementState(projection);
        if (acknowledgement !== "pending") {
          return { projection, allowed: false, lifecycle, acknowledgement, attemptId: null };
        }
        if (
          projection.admission.statusMarker !== input.statusMarker ||
          projection.admission.statusCommentId !== input.statusCommentId
        ) {
          return { projection, allowed: false, lifecycle, acknowledgement, attemptId: null };
        }
        for (const attempt of projection.acknowledgement.attempts) {
          if (
            attempt.failedAt === undefined &&
            attempt.expiredAt === undefined &&
            attempt.terminalSkip === undefined &&
            input.observedAt - attempt.attemptedAt >= EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS
          ) {
            attempt.expiredAt = input.observedAt;
          }
        }
        const activeAttempt = projection.acknowledgement.attempts.some(
          (attempt) =>
            attempt.failedAt === undefined &&
            attempt.expiredAt === undefined &&
            attempt.terminalSkip === undefined,
        );
        if (activeAttempt) {
          return { projection, allowed: false, lifecycle, acknowledgement, attemptId: null };
        }
        const attemptId = `ack:${projection.acknowledgement.attempts.length + 1}`;
        projection.acknowledgement.attempts.push({
          attemptId,
          statusMarker: input.statusMarker,
          statusCommentId: input.statusCommentId,
          attemptedAt: input.observedAt,
        });
        projection.updatedAt = input.observedAt;
        this.writeSync(projection);
        return {
          projection,
          allowed: true,
          lifecycle,
          acknowledgement,
          attemptId,
        };
      },
      false,
    );
  }

  recordCommandAcknowledgementFailure(
    input: ProjectionIdentity & {
      attemptId: string;
      statusMarker: string | null;
      statusCommentId: number | null;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    if (!/^ack:[1-9]\d*$/.test(input.attemptId))
      throw new Error("invalid lifecycle acknowledgement attempt");
    validateAcknowledgementAddress(input.statusMarker, input.statusCommentId);
    return this.mutate(
      input,
      (projection) => {
        const attempt = [...projection.acknowledgement.attempts]
          .reverse()
          .find(
            (candidate) =>
              candidate.failedAt === undefined &&
              candidate.expiredAt === undefined &&
              candidate.terminalSkip === undefined &&
              candidate.attemptId === input.attemptId &&
              candidate.statusMarker === input.statusMarker &&
              candidate.statusCommentId === input.statusCommentId,
          );
        if (!attempt || projection.acknowledgement.observed) {
          return { projection, released: false };
        }
        attempt.failedAt = input.observedAt;
        projection.updatedAt = input.observedAt;
        this.writeSync(projection);
        return { projection, released: true };
      },
      false,
    );
  }

  recordCommandAcknowledgementTerminalSkip(
    input: ProjectionIdentity & {
      attemptId: string;
      statusMarker: string | null;
      statusCommentId: number | null;
      reason: CommandAcknowledgementTerminalSkipReason;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    if (!/^ack:[1-9]\d*$/.test(input.attemptId))
      throw new Error("invalid lifecycle acknowledgement attempt");
    if (!COMMAND_ACKNOWLEDGEMENT_TERMINAL_SKIP_REASONS.includes(input.reason))
      throw new Error("invalid lifecycle acknowledgement terminal skip reason");
    validateAcknowledgementAddress(input.statusMarker, input.statusCommentId);
    return this.mutate(
      input,
      (projection) => {
        const attempt = [...projection.acknowledgement.attempts]
          .reverse()
          .find(
            (candidate) =>
              candidate.attemptId === input.attemptId &&
              candidate.statusMarker === input.statusMarker &&
              candidate.statusCommentId === input.statusCommentId,
          );
        if (!attempt || projection.acknowledgement.observed) {
          return { projection, skipped: false };
        }
        if (attempt.terminalSkip) {
          return {
            projection,
            skipped: attempt.terminalSkip.reason === input.reason,
          };
        }
        if (attempt.failedAt !== undefined || attempt.expiredAt !== undefined) {
          return { projection, skipped: false };
        }
        attempt.terminalSkip = { reason: input.reason, observedAt: input.observedAt };
        projection.updatedAt = input.observedAt;
        this.writeSync(projection);
        return { projection, skipped: true };
      },
      false,
    );
  }

  observeCommandAcknowledgement(input: {
    canonicalTargetKey: string;
    fenceKey?: string;
    revision?: number;
    statusMarker: string | null;
    commandCommentId: number;
    completionCommentId: number;
    statusCommentId?: number;
    requireExactStatusComment?: boolean;
    observedAt: number;
  }) {
    if (
      !validCanonicalTargetKey(input.canonicalTargetKey) ||
      (input.fenceKey === undefined) !== (input.revision === undefined) ||
      (input.fenceKey !== undefined && !validFenceKey(input.fenceKey)) ||
      (input.revision !== undefined && !positiveInteger(input.revision)) ||
      (input.statusMarker !== null && !validText(input.statusMarker, 1, 300)) ||
      !positiveInteger(input.commandCommentId) ||
      !positiveInteger(input.completionCommentId) ||
      (input.statusCommentId !== undefined && !positiveInteger(input.statusCommentId))
    ) {
      throw new Error("invalid lifecycle acknowledgement receipt");
    }
    return this.storage.transactionSync(() => {
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
            WHERE canonical_target_key = ? ORDER BY revision DESC`,
          input.canonicalTargetKey,
        ),
      );
      const matchedProjections: ExactReviewLifecycleProjection[] = [];
      for (const row of rows) {
        const projection = projectionFromRow(String(row.projection_json || ""));
        if (
          input.fenceKey !== undefined &&
          (projection.fenceKey !== input.fenceKey || projection.revision !== input.revision)
        ) {
          continue;
        }
        const attempted = projection.acknowledgement.attempts.some(
          (attempt) =>
            (input.statusCommentId === undefined ||
              attempt.statusCommentId === input.statusCommentId) &&
            ((attempt.statusCommentId === input.completionCommentId &&
              (attempt.statusMarker === input.statusMarker ||
                attempt.statusMarker === null ||
                (!input.requireExactStatusComment && input.statusMarker === null))) ||
              (input.requireExactStatusComment &&
                attempt.statusCommentId === null &&
                input.statusMarker !== null &&
                attempt.statusMarker === input.statusMarker) ||
              (!input.requireExactStatusComment &&
                input.statusMarker !== null &&
                attempt.statusMarker === input.statusMarker)),
        );
        if (attempted && projection.acknowledgement.required) matchedProjections.push(projection);
      }
      const exactStatusCommentMatches =
        input.fenceKey === undefined && matchedProjections.length > 1
          ? matchedProjections.filter((projection) =>
              projection.acknowledgement.attempts.some(
                (attempt) => attempt.statusCommentId === input.completionCommentId,
              ),
            )
          : [];
      if (
        input.fenceKey === undefined &&
        matchedProjections.length > 1 &&
        exactStatusCommentMatches.length !== 1
      ) {
        return { accepted: false, projection: null, state: null, acknowledgement: null };
      }
      for (const projection of exactStatusCommentMatches.length
        ? exactStatusCommentMatches
        : matchedProjections) {
        const observed = {
          statusMarker: input.statusMarker,
          commandCommentId: input.commandCommentId,
          completionCommentId: input.completionCommentId,
          observedAt: input.observedAt,
        };
        if (
          projection.acknowledgement.observed &&
          (projection.acknowledgement.observed.statusMarker !== observed.statusMarker ||
            projection.acknowledgement.observed.commandCommentId !== observed.commandCommentId ||
            projection.acknowledgement.observed.completionCommentId !==
              observed.completionCommentId)
        ) {
          throw new Error("conflicting lifecycle acknowledgement receipt");
        }
        projection.acknowledgement.observed ??= observed;
        // The final receipt is the only timing boundary for command journeys.
        // Queue its Bay materialization in this same source transaction so a
        // Durable Object restart cannot persist the receipt without its outbox
        // marker.
        projection.bayTelemetryPending = true;
        projection.updatedAt = input.observedAt;
        this.writeSync(projection);
        return {
          accepted: true,
          projection,
          state: lifecycleState(projection),
          acknowledgement: commandAcknowledgementState(projection),
        };
      }
      return { accepted: false, projection: null, state: null, acknowledgement: null };
    });
  }

  read(canonicalTargetKey: string, fenceKey: string, revision: number) {
    if (
      !validCanonicalTargetKey(canonicalTargetKey) ||
      !validFenceKey(fenceKey) ||
      !positiveInteger(revision)
    ) {
      return null;
    }
    return this.readSync(canonicalTargetKey, fenceKey, revision);
  }

  maxRevision(canonicalTargetKey: string) {
    if (!validCanonicalTargetKey(canonicalTargetKey)) return 0;
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT MAX(revision) AS max_revision
           FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          WHERE canonical_target_key = ?`,
        canonicalTargetKey,
      ),
    )[0] as { max_revision?: unknown } | undefined;
    const revision = Number(row?.max_revision || 0);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  /**
   * This reader is intentionally side-effect free. Its caller provisions the
   * table and indexes through the Durable Object constructor barrier; this
   * method does not ensure schema, normalize legacy rows, or write an index.
   */
  readBaySnapshot(
    now = Date.now(),
    allowedRepositories?: ReadonlySet<string>,
  ): DurableLifecycleBaySnapshot {
    const unknown = (reason: DurableLifecycleBayUnknownReason): DurableLifecycleBaySnapshot => ({
      version: 1,
      source: "exact-review-lifecycle-projection-v1",
      generated_at: new Date(now).toISOString(),
      freshness: { maximum_age_ms: 60_000 },
      collection: { state: "unknown", reason },
      inventory: null,
      lanes: null,
      sample: null,
    });

    const repositories = allowedRepositories
      ? [
          ...new Set([...allowedRepositories].map((repository) => repository.trim().toLowerCase())),
        ].sort()
      : null;
    if (
      repositories &&
      (repositories.length > 32 ||
        repositories.some((repository) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)))
    ) {
      return unknown("malformed");
    }

    try {
      // Keep counts, validation, and sample revision lookups in one snapshot.
      // Stream history through the existing reducer; only lane samples survive
      // each cursor step, regardless of how many completed facts are retained.
      return this.storage.transactionSync<DurableLifecycleBaySnapshot>(() => {
        const inventory = { lifecycle_records: 0, target_revisions: 0, unique_targets: 0 };
        const lanes = emptyDurableLifecycleBayLanes();
        const cardsByLane = new Map<DurableLifecycleBayLane, DurableLifecycleBayCard[]>();
        const laneOrder = Object.keys(lanes) as DurableLifecycleBayLane[];
        for (const lane of laneOrder) cardsByLane.set(lane, []);

        for (const repository of repositories ?? [null]) {
          const bindings = repository === null ? [] : [repository];
          const source = `${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
            INDEXED BY ${repository === null ? "exact_review_lifecycle_projection_bay" : "exact_review_lifecycle_projection_bay_repository_v2"}
            ${repository === null ? "" : "WHERE LOWER(SUBSTR(canonical_target_key, 1, INSTR(canonical_target_key, '#') - 1)) = ?"}`;
          const counts = Array.from(
            this.storage.sql.exec(
              `SELECT COUNT(*) AS lifecycle_records,
                      COUNT(DISTINCT canonical_target_key || ':' || revision) AS target_revisions,
                      COUNT(DISTINCT canonical_target_key) AS unique_targets
                 FROM ${source}`,
              ...bindings,
            ),
          )[0];
          for (const key of ["lifecycle_records", "target_revisions", "unique_targets"] as const) {
            const count = Number(counts?.[key]);
            if (!Number.isSafeInteger(count) || count < 0) return unknown("mixed");
            inventory[key] += count;
          }

          for (const row of this.storage.sql.exec(
            `SELECT projection_json, canonical_target_key, fence_key, revision
               FROM ${source}
              ORDER BY updated_at DESC, canonical_target_key ASC, fence_key ASC, revision DESC`,
            ...bindings,
          )) {
            let projection: ExactReviewLifecycleProjection;
            try {
              projection = projectionFromRow(String(row.projection_json || ""));
            } catch {
              return unknown("malformed");
            }
            try {
              if (
                !validDurableLifecycleBayProjection(projection) ||
                projection.canonicalTargetKey !== row.canonical_target_key ||
                projection.fenceKey !== row.fence_key ||
                projection.revision !== row.revision
              ) {
                return unknown("mixed");
              }
              const lane = durableLifecycleBayLane(lifecycleState(projection));
              lanes[lane] += 1;
              const laneCards = cardsByLane.get(lane)!;
              const last = laneCards.at(-1);
              if (
                laneCards.length === EXACT_REVIEW_LIFECYCLE_BAY_SAMPLE_LIMIT &&
                last &&
                projection.updatedAt < Date.parse(last.updated_at)
              ) {
                continue;
              }
              laneCards.push(durableLifecycleBayCard(projection, now, projection.revision));
              laneCards.sort(compareAuditInventoryRecords);
              if (laneCards.length > EXACT_REVIEW_LIFECYCLE_BAY_SAMPLE_LIMIT) laneCards.pop();
            } catch {
              return unknown("mixed");
            }
          }
        }

        const sample: DurableLifecycleBayCard[] = [];
        for (let index = 0; sample.length < EXACT_REVIEW_LIFECYCLE_BAY_SAMPLE_LIMIT; index += 1) {
          let added = false;
          for (const lane of laneOrder) {
            const card = cardsByLane.get(lane)?.[index];
            if (!card) continue;
            sample.push(card);
            added = true;
            if (sample.length === EXACT_REVIEW_LIFECYCLE_BAY_SAMPLE_LIMIT) break;
          }
          if (!added) break;
        }
        // Resolve only sampled targets; a newer revision can be arbitrarily
        // old and absent from every retained lane sample.
        const sampledTargets = [
          ...new Set(sample.map((card) => `${card.target.repository}#${card.target.number}`)),
        ];
        const maxRevisionByTarget = new Map<string, number>();
        if (sampledTargets.length) {
          for (const row of this.storage.sql.exec(
            `SELECT canonical_target_key, MAX(revision) AS max_revision
             FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
             WHERE canonical_target_key IN (SELECT value FROM json_each(?))
             GROUP BY canonical_target_key`,
            JSON.stringify(sampledTargets),
          )) {
            const revision = Number(row.max_revision || 0);
            maxRevisionByTarget.set(
              String(row.canonical_target_key),
              Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
            );
          }
        }
        for (const card of sample) {
          const key = `${card.target.repository}#${card.target.number}`;
          card.current_revision &&= card.revision === (maxRevisionByTarget.get(key) ?? 0);
        }
        return {
          version: 1,
          source: "exact-review-lifecycle-projection-v1",
          generated_at: new Date(now).toISOString(),
          freshness: { maximum_age_ms: 60_000 },
          collection: { state: "complete" },
          inventory,
          lanes,
          sample: {
            limit: EXACT_REVIEW_LIFECYCLE_BAY_SAMPLE_LIMIT,
            returned: sample.length,
            omitted: Math.max(0, inventory.lifecycle_records - sample.length),
            cards: sample,
          },
        };
      });
    } catch (error) {
      return unknown(
        error instanceof Error && /malformed JSON/i.test(error.message)
          ? "malformed"
          : "unavailable",
      );
    }
  }

  createAuditInventorySnapshot(
    pageLimit: number,
    now = Date.now(),
  ): DurableLifecycleAuditInventory {
    if (!validAuditPageLimit(pageLimit)) return this.unknownAuditInventory("malformed", now);
    try {
      // Unlike the public Bay reader, this authenticated snapshot operation may
      // initialize its own durable schema so a cold DO has a known empty inventory.
      this.ensureSchemaSync();
      this.ensureAuditSchemaSync();
      return this.storage.transactionSync(() => {
        this.pruneExpiredAuditSnapshotsSync(now);
        const active = Array.from(
          this.storage.sql.exec(
            `SELECT snapshot_id FROM ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE}
             WHERE expires_at > ? LIMIT ?`,
            now,
            EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_MAX_ACTIVE + 1,
          ),
        );
        if (active.length >= EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_MAX_ACTIVE) {
          return this.unknownAuditInventory("over_cap", now);
        }

        const rows = Array.from(
          this.storage.sql.exec(
            `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
             ORDER BY updated_at DESC, canonical_target_key ASC, fence_key ASC, revision DESC
             LIMIT ?`,
            EXACT_REVIEW_LIFECYCLE_AUDIT_READ_LIMIT + 1,
          ),
        );
        if (rows.length > EXACT_REVIEW_LIFECYCLE_AUDIT_READ_LIMIT) {
          return this.unknownAuditInventory("over_cap", now);
        }
        const projections = rows.map((row) => projectionFromRow(String(row.projection_json || "")));
        if (!projections.every(validDurableLifecycleBayProjection)) {
          return this.unknownAuditInventory("mixed", now);
        }
        const maxRevisionByTarget = new Map<string, number>();
        for (const projection of projections) {
          maxRevisionByTarget.set(
            projection.canonicalTargetKey,
            Math.max(
              maxRevisionByTarget.get(projection.canonicalTargetKey) ?? 0,
              projection.revision,
            ),
          );
        }
        const records = projections.map((projection) =>
          durableLifecycleBayCard(
            projection,
            now,
            maxRevisionByTarget.get(projection.canonicalTargetKey),
          ),
        );
        records.sort(compareAuditInventoryRecords);

        const snapshotId = crypto.randomUUID();
        const expiresAt = now + EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TTL_MS;
        this.storage.sql.exec(
          `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE}
             (snapshot_id, created_at, expires_at, total_records)
           VALUES (?, ?, ?, ?)`,
          snapshotId,
          now,
          expiresAt,
          records.length,
        );
        for (const [ordinal, record] of records.entries()) {
          this.storage.sql.exec(
            `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_ROW_TABLE}
               (snapshot_id, ordinal, record_json) VALUES (?, ?, ?)`,
            snapshotId,
            ordinal,
            JSON.stringify(record),
          );
        }
        return this.auditInventoryPageSync(snapshotId, 0, pageLimit, now);
      });
    } catch (error) {
      return this.unknownAuditInventory(
        isMalformedLifecycleError(error) ? "malformed" : "unavailable",
        now,
      );
    }
  }

  readAuditInventoryPage(
    cursor: { snapshotId: string; offset: number },
    pageLimit: number,
    now = Date.now(),
  ): DurableLifecycleAuditInventory {
    if (
      !validAuditPageLimit(pageLimit) ||
      !validAuditSnapshotId(cursor.snapshotId) ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    ) {
      return this.unknownAuditInventory("malformed", now);
    }
    try {
      this.ensureAuditSchemaSync();
      return this.storage.transactionSync(() =>
        this.auditInventoryPageSync(cursor.snapshotId, cursor.offset, pageLimit, now),
      );
    } catch (error) {
      return this.unknownAuditInventory(
        isMalformedLifecycleError(error) ? "malformed" : "unavailable",
        now,
      );
    }
  }

  private ensureAuditSchemaSync() {
    if (this.auditSchemaReady) return;
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE} (
         snapshot_id TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         total_records INTEGER NOT NULL CHECK (total_records >= 0)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_ROW_TABLE} (
         snapshot_id TEXT NOT NULL,
         ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
         record_json TEXT NOT NULL,
         PRIMARY KEY (snapshot_id, ordinal)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_audit_snapshot_expiry
         ON ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE} (expires_at)`,
    );
    this.auditSchemaReady = true;
  }

  private pruneExpiredAuditSnapshotsSync(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_ROW_TABLE}
       WHERE snapshot_id IN (
         SELECT snapshot_id FROM ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE}
         WHERE expires_at <= ?
       )`,
      now,
    );
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE}
       WHERE expires_at <= ?`,
      now - EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TTL_MS,
    );
  }

  private auditInventoryPageSync(
    snapshotId: string,
    offset: number,
    pageLimit: number,
    now: number,
  ): DurableLifecycleAuditInventory {
    const snapshot = Array.from(
      this.storage.sql.exec(
        `SELECT created_at, expires_at, total_records
         FROM ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TABLE} WHERE snapshot_id = ?`,
        snapshotId,
      ),
    )[0];
    if (!snapshot) return this.unknownAuditInventory("unavailable", now);
    const createdAt = Number(snapshot.created_at);
    const expiresAt = Number(snapshot.expires_at);
    const totalRecords = Number(snapshot.total_records);
    if (
      !finiteTimestamp(createdAt) ||
      !finiteTimestamp(expiresAt) ||
      expiresAt - createdAt !== EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TTL_MS ||
      !Number.isSafeInteger(totalRecords) ||
      totalRecords < 0 ||
      totalRecords > EXACT_REVIEW_LIFECYCLE_AUDIT_READ_LIMIT ||
      offset > totalRecords
    ) {
      return this.unknownAuditInventory("mixed", now);
    }
    if (expiresAt <= now) return this.unknownAuditInventory("stale", now);
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT record_json FROM ${EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_ROW_TABLE}
         WHERE snapshot_id = ? AND ordinal >= ? ORDER BY ordinal ASC LIMIT ?`,
        snapshotId,
        offset,
        pageLimit + 1,
      ),
    );
    const hasMore = rows.length > pageLimit;
    const records = rows
      .slice(0, pageLimit)
      .map((row) => auditRecordFromRow(String(row.record_json || "")));
    const expectedRecords = Math.min(pageLimit, totalRecords - offset);
    if (records.length !== expectedRecords || !records.every(validAuditInventoryRecord)) {
      return this.unknownAuditInventory("mixed", now);
    }
    return {
      version: 1,
      source: "exact-review-lifecycle-projection-v1",
      generated_at: new Date(now).toISOString(),
      collection: { state: "complete" },
      snapshot: {
        id: snapshotId,
        created_at: new Date(createdAt).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        total_records: totalRecords,
        retention_ms: EXACT_REVIEW_LIFECYCLE_AUDIT_SNAPSHOT_TTL_MS,
      },
      page: {
        limit: pageLimit,
        returned: records.length,
        next_cursor: hasMore ? encodeAuditCursor(snapshotId, offset + records.length) : null,
        records,
      },
    };
  }

  private unknownAuditInventory(
    reason: DurableLifecycleBayUnknownReason,
    now: number,
  ): DurableLifecycleAuditInventory {
    return {
      version: 1,
      source: "exact-review-lifecycle-projection-v1",
      generated_at: new Date(now).toISOString(),
      collection: { state: "unknown", reason },
      snapshot: null,
      page: null,
    };
  }

  /**
   * Replays terminal facts whose Bay aggregate write failed. The marker is
   * stored on the lifecycle row itself, rather than only in the secondary
   * telemetry tables, so it survives a temporary telemetry-schema outage.
   * Callers must fail closed while a bounded replay has more work.
   */
  reconcileBayTelemetryPending(
    materialize: (projection: ExactReviewLifecycleProjection) => boolean,
  ) {
    this.ensureSchemaSync();
    let progressed = false;
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          WHERE bay_telemetry_pending = 1
          ORDER BY updated_at, canonical_target_key, fence_key, revision
          LIMIT ?`,
        EXACT_REVIEW_LIFECYCLE_BAY_TELEMETRY_RECOVERY_BATCH_LIMIT + 1,
      ),
    );
    const more = rows.length > EXACT_REVIEW_LIFECYCLE_BAY_TELEMETRY_RECOVERY_BATCH_LIMIT;
    for (const row of rows.slice(0, EXACT_REVIEW_LIFECYCLE_BAY_TELEMETRY_RECOVERY_BATCH_LIMIT)) {
      try {
        const projection = projectionFromRow(String(row.projection_json || ""));
        // Materialization has its own Durable Object transaction. Keep this
        // source transaction separate: a retry after its source-marker clear is
        // interrupted is idempotent by lifecycle event id.
        if (!projection.bayTelemetryPending || !materialize(projection)) {
          return { pending: true, progressed };
        }
        this.markBayTelemetryMaterialized(projection);
      } catch {
        return { pending: true, progressed };
      }
      progressed = true;
    }
    return { pending: more, progressed };
  }

  markBayTelemetryPending(input: ProjectionIdentity) {
    this.validateIdentity(input);
    return this.mutate(input, (projection) => {
      projection.bayTelemetryPending = true;
      return projection;
    });
  }

  markBayTelemetryMaterialized(input: ProjectionIdentity & { bayTelemetryEventId?: string }) {
    this.validateIdentity(input);
    if (input.bayTelemetryEventId !== undefined && !validText(input.bayTelemetryEventId, 1, 536)) {
      throw new Error("invalid lifecycle Bay telemetry event identity");
    }
    return this.mutate(input, (projection) => {
      if (input.bayTelemetryEventId === undefined) delete projection.bayTelemetryEventId;
      else projection.bayTelemetryEventId = input.bayTelemetryEventId;
      projection.bayTelemetryPending = false;
      return projection;
    });
  }

  hasBayTelemetryPending() {
    try {
      return (
        Array.from(
          this.storage.sql.exec(
            `SELECT 1 AS pending FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
              WHERE bay_telemetry_pending = 1 LIMIT 1`,
          ),
        ).length > 0
      );
    } catch {
      return true;
    }
  }

  private mutate<T>(
    input: ProjectionIdentity,
    apply: (projection: ExactReviewLifecycleProjection) => T,
    writeResult = true,
    onMissing?: () => T,
  ): T {
    return this.storage.transactionSync(() =>
      this.mutateSync(input, apply, writeResult, onMissing),
    );
  }

  private mutateSync<T>(
    input: ProjectionIdentity,
    apply: (projection: ExactReviewLifecycleProjection) => T,
    writeResult = true,
    onMissing?: () => T,
  ): T {
    this.ensureSchemaSync();
    const projection = this.readSync(input.canonicalTargetKey, input.fenceKey, input.revision);
    if (!projection) {
      if (onMissing) return onMissing();
      throw new Error("missing lifecycle admission fact");
    }
    this.assertIdentity(projection, input);
    const result = apply(projection);
    if (writeResult) {
      projection.updatedAt = Date.now();
      this.writeSync(projection);
    }
    return result;
  }

  private mutateIdempotentlySync(
    input: ProjectionIdentity,
    apply: (projection: ExactReviewLifecycleProjection) => boolean,
  ) {
    this.ensureSchemaSync();
    const projection = this.readSync(input.canonicalTargetKey, input.fenceKey, input.revision);
    if (!projection) throw new Error("missing lifecycle admission fact");
    this.assertIdentity(projection, input);
    const duplicate = apply(projection);
    if (!duplicate) {
      projection.updatedAt = Date.now();
      this.writeSync(projection);
    }
    return { projection, duplicate };
  }

  private readSync(canonicalTargetKey: string, fenceKey: string, revision: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT projection_json FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
          WHERE canonical_target_key = ? AND fence_key = ? AND revision = ?`,
        canonicalTargetKey,
        fenceKey,
        revision,
      ),
    )[0];
    return row ? projectionFromRow(String(row.projection_json || "")) : null;
  }

  private writeSync(projection: ExactReviewLifecycleProjection) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE}
         (canonical_target_key, revision, fence_key, projection_json, updated_at, bay_telemetry_pending)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_target_key, fence_key, revision) DO UPDATE SET
         fence_key = excluded.fence_key,
         projection_json = excluded.projection_json,
         updated_at = excluded.updated_at,
         bay_telemetry_pending = excluded.bay_telemetry_pending`,
      projection.canonicalTargetKey,
      projection.revision,
      projection.fenceKey,
      JSON.stringify(projection),
      projection.updatedAt,
      Number(projection.bayTelemetryPending),
    );
  }

  private validateIdentity(identity: ProjectionIdentity) {
    if (
      !validCanonicalTargetKey(identity.canonicalTargetKey) ||
      !validFenceKey(identity.fenceKey) ||
      !positiveInteger(identity.revision)
    ) {
      throw new Error("invalid lifecycle projection identity");
    }
  }

  private assertIdentity(projection: ExactReviewLifecycleProjection, identity: ProjectionIdentity) {
    if (
      projection.canonicalTargetKey !== identity.canonicalTargetKey ||
      projection.fenceKey !== identity.fenceKey ||
      projection.revision !== identity.revision
    ) {
      throw new Error("conflicting lifecycle projection identity");
    }
  }
}

function applyTerminalDisposition(
  projection: ExactReviewLifecycleProjection,
  input: ProjectionIdentity & { kind: LifecycleTerminalDisposition; observedAt: number },
) {
  const next = { kind: input.kind, observedAt: input.observedAt };
  const current = projection.terminalDisposition;
  if (!current) {
    projection.terminalDispositions.push(next);
    projection.terminalDisposition = next;
    return projection;
  }
  if (current.kind === next.kind) return projection;
  // A newer source can requeue a just-routed revision before its final queue
  // completion lands. Only a requeue may transition to another terminal fact.
  if (next.kind !== "requeue" && current.kind !== "requeue") {
    throw new Error("conflicting lifecycle terminal disposition");
  }
  projection.terminalDispositions.push(next);
  projection.terminalDisposition = next;
  return projection;
}

export function lifecycleState(projection: ExactReviewLifecycleProjection): LifecycleState {
  switch (projection.terminalDisposition?.kind) {
    case "superseded":
      return "superseded";
    case "requeue":
      return "requeue";
    case "dead_letter":
      return "dead_letter";
    case "target_closed":
      return "target_closed";
    case "target_missing":
      return "target_missing";
    case "policy_noop":
      return "policy_noop";
    case "guarded_open":
      return "guarded_open";
    case "failure":
      return "failed";
    case "review_completed_routed":
      if (
        !projection.canonicalReceipts.some((receipt) =>
          ["accepted", "deduped"].includes(receipt.outcome),
        ) ||
        !projection.routerReceipt ||
        !["durable", "not_required"].includes(projection.routerReceipt.outcome)
      ) {
        return "pending";
      }
      if (projection.acknowledgement.required && !projection.acknowledgement.observed) {
        return commandAcknowledgementTerminalSkip(projection)
          ? "acknowledgement_skipped"
          : "acknowledgement_pending";
      }
      return "completed";
    default:
      return "pending";
  }
}

export function commandAcknowledgementState(
  projection: ExactReviewLifecycleProjection,
): CommandAcknowledgementState {
  if (!projection.acknowledgement.required) return "not_required";
  if (projection.acknowledgement.observed) return "observed";
  const terminalSkip = commandAcknowledgementTerminalSkip(projection);
  if (terminalSkip) {
    return terminalSkip.reason === "missing_status_comment"
      ? "skipped_missing_comment"
      : "skipped_locked";
  }
  if (projection.terminalDisposition?.kind === "review_completed_routed") {
    return lifecycleState(projection) === "acknowledgement_pending" ? "pending" : "unavailable";
  }
  if (projection.terminalDisposition?.kind === "requeue") return "unavailable";
  return projection.terminalDisposition ? "pending" : "unavailable";
}

function emptyDurableLifecycleBayLanes(): Record<DurableLifecycleBayLane, number> {
  return {
    pending: 0,
    acknowledgement_pending: 0,
    completed: 0,
    superseded: 0,
    requeued: 0,
    terminal_attention: 0,
  };
}

function durableLifecycleBayLane(state: LifecycleState): DurableLifecycleBayLane {
  switch (state) {
    case "pending":
      return "pending";
    case "acknowledgement_pending":
      return "acknowledgement_pending";
    case "completed":
      return "completed";
    case "superseded":
      return "superseded";
    case "requeue":
      return "requeued";
    case "acknowledgement_skipped":
    case "dead_letter":
    case "target_closed":
    case "target_missing":
    case "policy_noop":
    case "guarded_open":
    case "failed":
      return "terminal_attention";
  }
}

function durableLifecycleBayCard(
  projection: ExactReviewLifecycleProjection,
  now: number,
  maxRevision: number | undefined,
): DurableLifecycleBayCard {
  const target = canonicalTarget(projection.canonicalTargetKey);
  if (!target) throw new Error("invalid durable lifecycle Bay target");
  const state = lifecycleState(projection);
  const latestReviewResult = projection.reviewResults.reduce<
    ExactReviewLifecycleProjection["reviewResults"][number] | null
  >(
    (latest, result) => (!latest || result.observedAt >= latest.observedAt ? result : latest),
    null,
  );
  const terminalLabel =
    state === "acknowledgement_skipped"
      ? "acknowledgement_skipped"
      : durableLifecycleBayLane(state) === "terminal_attention"
        ? (projection.terminalDisposition?.kind ?? null)
        : null;
  return {
    target,
    revision: projection.revision,
    state,
    lane: durableLifecycleBayLane(state),
    terminal_label: terminalLabel,
    terminal_history: Array.from(
      new Set(projection.terminalDispositions.map((entry) => entry.kind)),
    ),
    current_revision:
      projection.revision === maxRevision && state !== "superseded" && state !== "requeue",
    facts: {
      admission: "recorded",
      claim_count: projection.claims.length,
      review_result: latestReviewResult?.outcome ?? null,
      github_effect_recorded: projection.githubEffect !== null,
      canonical_receipts: Array.from(
        new Set(projection.canonicalReceipts.map((receipt) => receipt.outcome)),
      ),
      router_receipt: projection.routerReceipt?.outcome ?? null,
      acknowledgement: commandAcknowledgementState(projection),
    },
    updated_at: new Date(projection.updatedAt).toISOString(),
    age_ms: Math.max(0, now - projection.updatedAt),
    provenance: "exact-review-lifecycle-projection-v1",
  };
}

function canonicalTarget(value: string) {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const repository = match[1];
  const itemNumber = match[2];
  if (repository === undefined || itemNumber === undefined) return null;
  return {
    repository,
    number: Number(itemNumber),
    url: `https://github.com/${repository}/issues/${itemNumber}`,
  };
}

export function parseDurableLifecycleAuditCursor(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.(0|[1-9]\d*)$/i.exec(value);
  if (!match) return null;
  const snapshotId = match[1];
  const offsetText = match[2];
  if (snapshotId === undefined || offsetText === undefined) return null;
  const offset = Number(offsetText);
  if (!Number.isSafeInteger(offset)) return null;
  return { snapshotId: snapshotId.toLowerCase(), offset };
}

function encodeAuditCursor(snapshotId: string, offset: number) {
  return `${snapshotId}.${offset}`;
}

function compareAuditInventoryRecords(
  left: DurableLifecycleBayCard,
  right: DurableLifecycleBayCard,
) {
  return (
    Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
    left.target.repository.localeCompare(right.target.repository) ||
    left.target.number - right.target.number ||
    right.revision - left.revision
  );
}

function auditRecordFromRow(value: string): DurableLifecycleBayCard {
  const parsed = JSON.parse(value) as DurableLifecycleBayCard;
  if (!validAuditInventoryRecord(parsed)) throw new Error("invalid lifecycle audit snapshot row");
  return {
    target: {
      repository: parsed.target.repository,
      number: parsed.target.number,
      url: parsed.target.url,
    },
    revision: parsed.revision,
    state: parsed.state,
    lane: parsed.lane,
    terminal_label: parsed.terminal_label,
    terminal_history: [...parsed.terminal_history],
    current_revision: parsed.current_revision,
    facts: {
      admission: "recorded",
      claim_count: parsed.facts.claim_count,
      review_result: parsed.facts.review_result,
      github_effect_recorded: parsed.facts.github_effect_recorded,
      canonical_receipts: [...parsed.facts.canonical_receipts],
      router_receipt: parsed.facts.router_receipt,
      acknowledgement: parsed.facts.acknowledgement,
    },
    updated_at: parsed.updated_at,
    age_ms: parsed.age_ms,
    provenance: "exact-review-lifecycle-projection-v1",
  };
}

function validAuditInventoryRecord(value: unknown): value is DurableLifecycleBayCard {
  if (!value || typeof value !== "object") return false;
  const card = value as DurableLifecycleBayCard;
  return (
    !!card.target &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(card.target.repository) &&
    positiveInteger(card.target.number) &&
    card.target.url ===
      `https://github.com/${card.target.repository}/issues/${card.target.number}` &&
    positiveInteger(card.revision) &&
    [
      "pending",
      "completed",
      "acknowledgement_pending",
      "acknowledgement_skipped",
      "superseded",
      "requeue",
      "dead_letter",
      "target_closed",
      "target_missing",
      "policy_noop",
      "guarded_open",
      "failed",
    ].includes(card.state) &&
    [
      "pending",
      "acknowledgement_pending",
      "completed",
      "superseded",
      "requeued",
      "terminal_attention",
    ].includes(card.lane) &&
    (card.terminal_label === null || typeof card.terminal_label === "string") &&
    Array.isArray(card.terminal_history) &&
    card.terminal_history.every((entry) =>
      [
        "review_completed_routed",
        "superseded",
        "requeue",
        "dead_letter",
        "target_closed",
        "target_missing",
        "policy_noop",
        "guarded_open",
        "failure",
      ].includes(entry),
    ) &&
    typeof card.current_revision === "boolean" &&
    !!card.facts &&
    card.facts.admission === "recorded" &&
    Number.isSafeInteger(card.facts.claim_count) &&
    card.facts.claim_count >= 0 &&
    ["completed", "failed", "cancelled", null].includes(card.facts.review_result) &&
    typeof card.facts.github_effect_recorded === "boolean" &&
    Array.isArray(card.facts.canonical_receipts) &&
    card.facts.canonical_receipts.every((receipt) =>
      ["accepted", "deduped", "superseded"].includes(receipt),
    ) &&
    ["durable", "not_required", null].includes(card.facts.router_receipt) &&
    [
      "not_required",
      "pending",
      "observed",
      "skipped_locked",
      "skipped_missing_comment",
      "unavailable",
    ].includes(card.facts.acknowledgement) &&
    Number.isFinite(Date.parse(card.updated_at)) &&
    Number.isFinite(card.age_ms) &&
    card.age_ms >= 0 &&
    card.provenance === "exact-review-lifecycle-projection-v1"
  );
}

function validAuditPageLimit(value: number) {
  return (
    Number.isSafeInteger(value) && value >= 1 && value <= EXACT_REVIEW_LIFECYCLE_AUDIT_PAGE_MAX
  );
}

function validAuditSnapshotId(value: string) {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isMalformedLifecycleError(error: unknown) {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && /invalid lifecycle (projection|audit snapshot)/.test(error.message))
  );
}

const lifecycleTerminalKinds = new Set<LifecycleTerminalDisposition>([
  "review_completed_routed",
  "superseded",
  "requeue",
  "dead_letter",
  "target_closed",
  "target_missing",
  "policy_noop",
  "guarded_open",
  "failure",
]);

function validDurableLifecycleBayProjection(value: ExactReviewLifecycleProjection) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !validCanonicalTargetKey(value.canonicalTargetKey) ||
    !validFenceKey(value.fenceKey) ||
    !positiveInteger(value.revision) ||
    !finiteTimestamp(value.updatedAt) ||
    typeof value.bayTelemetryPending !== "boolean" ||
    // `bay:v2:` + a valid 512-character fence key + `:` + a safe-integer
    // revision (up to 16 decimal digits).
    (value.bayTelemetryEventId !== undefined && !validText(value.bayTelemetryEventId, 1, 536)) ||
    !validText(value.admission.deliveryId, 1, 300) ||
    (value.admission.sourceDeliveryId !== undefined &&
      !validText(value.admission.sourceDeliveryId, 1, 200)) ||
    (value.admission.bayJourneyDeliveryId !== undefined &&
      !validText(value.admission.bayJourneyDeliveryId, 1, 200)) ||
    !validText(value.admission.sourceAction, 1, 200) ||
    (value.admission.statusMarker !== null && !validText(value.admission.statusMarker, 1, 300)) ||
    (value.admission.statusCommentId !== null &&
      !positiveInteger(value.admission.statusCommentId)) ||
    (value.admission.triggeredAt !== undefined && !finiteTimestamp(value.admission.triggeredAt)) ||
    typeof value.admission.commandOriginated !== "boolean" ||
    !finiteTimestamp(value.admission.admittedAt) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.reviewResults) ||
    !Array.isArray(value.canonicalReceipts) ||
    !Array.isArray(value.routerReceipts) ||
    !Array.isArray(value.terminalDispositions) ||
    !Array.isArray(value.terminalOperationIds) ||
    !value.acknowledgement ||
    typeof value.acknowledgement.required !== "boolean" ||
    !Array.isArray(value.acknowledgement.attempts)
  ) {
    return false;
  }
  if (
    !value.claims.every(
      (claim) =>
        validFenceKey(claim.fenceKey) &&
        positiveInteger(claim.claimGeneration) &&
        validRunId(claim.runId) &&
        (claim.runAttempt === null || positiveInteger(claim.runAttempt)) &&
        finiteTimestamp(claim.claimedAt),
    ) ||
    !value.reviewResults.every(
      (result) =>
        validFenceKey(result.fenceKey) &&
        positiveInteger(result.claimGeneration) &&
        validRunId(result.runId) &&
        (result.runAttempt === null || positiveInteger(result.runAttempt)) &&
        ["completed", "failed", "cancelled"].includes(result.outcome) &&
        finiteTimestamp(result.observedAt),
    ) ||
    !value.canonicalReceipts.every(
      (receipt) =>
        ["accepted", "deduped", "superseded"].includes(receipt.outcome) &&
        validText(receipt.receiptId, 1, 300) &&
        finiteTimestamp(receipt.observedAt),
    ) ||
    !value.routerReceipts.every(
      (receipt) =>
        ["durable", "not_required"].includes(receipt.outcome) &&
        validText(receipt.receiptId, 1, 300) &&
        finiteTimestamp(receipt.observedAt) &&
        (receipt.operationComplete === undefined || receipt.operationComplete === true),
    ) ||
    !value.terminalDispositions.every(
      (disposition) =>
        lifecycleTerminalKinds.has(disposition.kind) && finiteTimestamp(disposition.observedAt),
    ) ||
    !value.acknowledgement.attempts.every(
      (attempt) =>
        /^ack:[1-9]\d*$/.test(attempt.attemptId) &&
        (attempt.statusMarker === null || validText(attempt.statusMarker, 1, 300)) &&
        (attempt.statusCommentId === null || positiveInteger(attempt.statusCommentId)) &&
        finiteTimestamp(attempt.attemptedAt) &&
        (attempt.failedAt === undefined || finiteTimestamp(attempt.failedAt)) &&
        (attempt.expiredAt === undefined || finiteTimestamp(attempt.expiredAt)) &&
        (attempt.terminalSkip === undefined ||
          (COMMAND_ACKNOWLEDGEMENT_TERMINAL_SKIP_REASONS.includes(attempt.terminalSkip.reason) &&
            finiteTimestamp(attempt.terminalSkip.observedAt))),
    )
  ) {
    return false;
  }
  if (
    value.githubEffect === undefined ||
    (value.githubEffect !== null &&
      (!positiveInteger(value.githubEffect.commentId) ||
        !/^[0-9a-f]{64}$/.test(value.githubEffect.digest) ||
        !finiteTimestamp(value.githubEffect.observedAt)))
  ) {
    return false;
  }
  if (
    value.acknowledgement.observed &&
    (!positiveInteger(value.acknowledgement.observed.commandCommentId) ||
      !positiveInteger(value.acknowledgement.observed.completionCommentId) ||
      (value.acknowledgement.observed.statusMarker !== null &&
        !validText(value.acknowledgement.observed.statusMarker, 1, 300)) ||
      !finiteTimestamp(value.acknowledgement.observed.observedAt))
  ) {
    return false;
  }
  if (value.routerReceipt) {
    if (
      !["durable", "not_required"].includes(value.routerReceipt.outcome) ||
      !value.routerReceipts.some(
        (receipt) =>
          receipt.receiptId === value.routerReceipt?.receiptId &&
          receipt.outcome === value.routerReceipt.outcome,
      )
    ) {
      return false;
    }
  }
  if (value.terminalDisposition) {
    const latest = value.terminalDispositions.at(-1);
    if (
      !lifecycleTerminalKinds.has(value.terminalDisposition.kind) ||
      !finiteTimestamp(value.terminalDisposition.observedAt) ||
      !latest ||
      latest.kind !== value.terminalDisposition.kind ||
      latest.observedAt !== value.terminalDisposition.observedAt
    ) {
      return false;
    }
  } else if (value.terminalDispositions.length) {
    return false;
  }
  return true;
}

function finiteTimestamp(value: unknown) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}

function commandAcknowledgementTerminalSkip(projection: ExactReviewLifecycleProjection) {
  return (
    [...projection.acknowledgement.attempts].reverse().find((attempt) => attempt.terminalSkip)
      ?.terminalSkip ?? null
  );
}

function projectionFromRow(value: string): ExactReviewLifecycleProjection {
  return normalizeProjection(JSON.parse(value));
}

function normalizeProjection(
  parsed: ExactReviewLifecycleProjection,
): ExactReviewLifecycleProjection {
  if (
    !parsed ||
    parsed.version !== 1 ||
    !validCanonicalTargetKey(parsed.canonicalTargetKey) ||
    !validFenceKey(parsed.fenceKey) ||
    !positiveInteger(parsed.revision)
  ) {
    throw new Error("invalid lifecycle projection row");
  }
  // The projection is new, but tolerate rows written by an earlier v1 worker
  // during a rolling deployment so append-only facts are never lost.
  parsed.routerReceipts ??= parsed.routerReceipt ? [parsed.routerReceipt] : [];
  parsed.terminalDispositions ??= parsed.terminalDisposition ? [parsed.terminalDisposition] : [];
  parsed.terminalOperationIds ??= [];
  if (!validTerminalOperations(parsed.terminalOperationIds)) {
    throw new Error("invalid lifecycle projection row");
  }
  parsed.bayTelemetryPending ??= false;
  return parsed;
}

function validTerminalOperations(operations: unknown, terminalKinds = lifecycleTerminalKinds) {
  if (!Array.isArray(operations)) return false;
  const operationIds = new Set<string>();
  return operations.every((operation) => {
    const candidate = operation as { operationId?: unknown; kind?: unknown } | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.operationId !== "string" ||
      !validText(candidate.operationId, 1, 300) ||
      !terminalKinds.has(candidate.kind as LifecycleTerminalDisposition) ||
      operationIds.has(candidate.operationId)
    ) {
      return false;
    }
    operationIds.add(candidate.operationId);
    return true;
  });
}

function sameClaim(left: LifecycleClaimFact, right: LifecycleClaimFact) {
  return (
    left.fenceKey === right.fenceKey &&
    left.claimGeneration === right.claimGeneration &&
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt
  );
}

function sameReviewResult(left: LifecycleReviewResultFact, right: LifecycleReviewResultFact) {
  return (
    left.fenceKey === right.fenceKey &&
    left.claimGeneration === right.claimGeneration &&
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.outcome === right.outcome
  );
}

function validCanonicalTargetKey(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value);
}

function validFenceKey(value: string) {
  return value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value);
}

function validRunId(value: string) {
  return /^\d+$/.test(value);
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validateAcknowledgementAddress(
  statusMarker: string | null,
  statusCommentId: number | null,
) {
  if (statusMarker !== null && !validText(statusMarker, 1, 300)) {
    throw new Error("invalid lifecycle acknowledgement marker");
  }
  if (statusCommentId !== null && !positiveInteger(statusCommentId)) {
    throw new Error("invalid lifecycle acknowledgement comment id");
  }
  if (statusMarker === null && statusCommentId === null) {
    throw new Error("missing lifecycle acknowledgement address");
  }
}

function validText(value: string, min: number, max: number) {
  return value.length >= min && value.length <= max && !/[\r\n]/.test(value);
}
