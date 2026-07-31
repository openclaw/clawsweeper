export const EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE = "exact_review_lifecycle_projection_v1";
export const EXACT_REVIEW_ACKNOWLEDGEMENT_ATTEMPT_LEASE_MS = 5 * 60 * 1000;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

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
  | "unavailable";

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
  terminalSkip?: { reason: "locked_conversation"; observedAt: number };
};

export type ExactReviewLifecycleProjection = {
  version: 1;
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
  admission: {
    deliveryId: string;
    sourceAction: string;
    commandOriginated: boolean;
    statusMarker: string | null;
    statusCommentId: number | null;
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
  /** Current terminal outcome used to derive lifecycle and acknowledgement state. */
  terminalDisposition: { kind: LifecycleTerminalDisposition; observedAt: number } | null;
  updatedAt: number;
};

type ProjectionIdentity = {
  canonicalTargetKey: string;
  fenceKey: string;
  revision: number;
};

export class ExactReviewLifecycleProjectionStore {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} (
         canonical_target_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         fence_key TEXT NOT NULL,
         projection_json TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (canonical_target_key, fence_key, revision)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_lifecycle_projection_fence
         ON ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} (fence_key, revision)`,
    );
  }

  recordAdmission(
    input: ProjectionIdentity & {
      deliveryId: string;
      sourceAction: string;
      commandOriginated: boolean;
      statusMarker: string | null;
      statusCommentId: number | null;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    if (!validText(input.deliveryId, 1, 300) || !validText(input.sourceAction, 1, 200)) {
      throw new Error("invalid lifecycle admission fact");
    }
    if (input.statusMarker !== null && !validText(input.statusMarker, 1, 300)) {
      throw new Error("invalid lifecycle status marker");
    }
    if (input.statusCommentId !== null && !positiveInteger(input.statusCommentId)) {
      throw new Error("invalid lifecycle status comment id");
    }
    return this.storage.transactionSync(() => {
      const existing = this.readSync(input.canonicalTargetKey, input.fenceKey, input.revision);
      if (existing) {
        this.assertIdentity(existing, input);
        const admission = existing.admission;
        if (
          admission.deliveryId !== input.deliveryId ||
          admission.sourceAction !== input.sourceAction ||
          admission.commandOriginated !== input.commandOriginated ||
          admission.statusMarker !== input.statusMarker ||
          admission.statusCommentId !== input.statusCommentId
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
          sourceAction: input.sourceAction,
          commandOriginated: input.commandOriginated,
          statusMarker: input.statusMarker,
          statusCommentId: input.statusCommentId,
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
        terminalDisposition: null,
        updatedAt: input.observedAt,
      };
      this.writeSync(projection);
      return projection;
    });
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
    this.validateIdentity(input);
    if (!positiveInteger(input.claimGeneration) || !validRunId(input.runId)) {
      throw new Error("invalid lifecycle review result");
    }
    if (input.runAttempt !== null && !positiveInteger(input.runAttempt)) {
      throw new Error("invalid lifecycle review result attempt");
    }
    return this.mutate(input, (projection) => {
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
    });
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
    },
  ) {
    this.validateIdentity(input);
    if (!validText(input.receiptId, 1, 300)) throw new Error("invalid lifecycle router receipt");
    return this.mutate(input, (projection) => {
      const next = {
        outcome: input.outcome,
        receiptId: input.receiptId,
        observedAt: input.observedAt,
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
      if (!existing) projection.routerReceipts.push(next);
      projection.routerReceipt ??= next;
      return projection;
    });
  }

  recordTerminalDisposition(
    input: ProjectionIdentity & {
      kind: LifecycleTerminalDisposition;
      observedAt: number;
    },
  ) {
    this.validateIdentity(input);
    return this.mutate(input, (projection) => {
      const next = { kind: input.kind, observedAt: input.observedAt };
      const current = projection.terminalDisposition;
      if (!current) {
        projection.terminalDispositions.push(next);
        projection.terminalDisposition = next;
        return projection;
      }
      if (current.kind === next.kind) return projection;
      // A newer source can requeue a just-routed revision before its final
      // queue completion lands. Requeue remains an immutable history fact and
      // a later durable handoff may still complete the same admitted revision.
      if (next.kind !== "requeue" && current.kind !== "requeue") {
        throw new Error("conflicting lifecycle terminal disposition");
      }
      projection.terminalDispositions.push(next);
      projection.terminalDisposition = next;
      return projection;
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
      reason: "locked_conversation";
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
    statusMarker: string | null;
    commandCommentId: number;
    completionCommentId: number;
    observedAt: number;
  }) {
    if (
      !validCanonicalTargetKey(input.canonicalTargetKey) ||
      (input.statusMarker !== null && !validText(input.statusMarker, 1, 300)) ||
      !positiveInteger(input.commandCommentId) ||
      !positiveInteger(input.completionCommentId)
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
      for (const row of rows) {
        const projection = projectionFromRow(String(row.projection_json || ""));
        const attempted = projection.acknowledgement.attempts.some(
          (attempt) =>
            attempt.statusCommentId === input.completionCommentId ||
            (input.statusMarker !== null && attempt.statusMarker === input.statusMarker),
        );
        if (!attempted || !projection.acknowledgement.required) continue;
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

  private mutate<T>(
    input: ProjectionIdentity,
    apply: (projection: ExactReviewLifecycleProjection) => T,
    writeResult = true,
  ): T {
    return this.storage.transactionSync(() => {
      const projection = this.readSync(input.canonicalTargetKey, input.fenceKey, input.revision);
      if (!projection) throw new Error("missing lifecycle admission fact");
      this.assertIdentity(projection, input);
      const result = apply(projection);
      if (writeResult) {
        projection.updatedAt = Date.now();
        this.writeSync(projection);
      }
      return result;
    });
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
         (canonical_target_key, revision, fence_key, projection_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(canonical_target_key, fence_key, revision) DO UPDATE SET
         fence_key = excluded.fence_key,
         projection_json = excluded.projection_json,
         updated_at = excluded.updated_at`,
      projection.canonicalTargetKey,
      projection.revision,
      projection.fenceKey,
      JSON.stringify(projection),
      projection.updatedAt,
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
  if (commandAcknowledgementTerminalSkip(projection)) return "skipped_locked";
  if (projection.terminalDisposition?.kind === "review_completed_routed") {
    return lifecycleState(projection) === "acknowledgement_pending" ? "pending" : "unavailable";
  }
  if (projection.terminalDisposition?.kind === "requeue") return "unavailable";
  return projection.terminalDisposition ? "pending" : "unavailable";
}

function commandAcknowledgementTerminalSkip(projection: ExactReviewLifecycleProjection) {
  return projection.acknowledgement.attempts.some(
    (attempt) => attempt.terminalSkip?.reason === "locked_conversation",
  );
}

function projectionFromRow(value: string): ExactReviewLifecycleProjection {
  const parsed = JSON.parse(value) as ExactReviewLifecycleProjection;
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
  return parsed;
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
