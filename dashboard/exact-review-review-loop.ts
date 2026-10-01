import type { DurableStorage } from "./durable-storage.ts";
import {
  EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION,
  exactReviewDecisionHasCommandContext,
  isLowPriorityExactReviewDecision,
  type ExactReviewDecision,
} from "./exact-review-decision.ts";
import { exactReviewScheduledLane } from "./exact-review-queue-shared.ts";
import { MANUAL_REVIEW_SOURCE_ACTION } from "../src/manual-publication-policy.ts";

export const EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE = "exact_review_queue_source_drift_loops";
export const EXACT_REVIEW_REVIEW_GENERATION_TABLE = "exact_review_queue_review_generations";
export const DEFAULT_EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT = 3;
export const DEFAULT_EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY = 24;
export const EXACT_REVIEW_RUNAWAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Private /stats sample size; the public projection keeps at most five public keys. */
export const EXACT_REVIEW_RUNAWAY_SAMPLE_LIMIT = 20;
// A loop counter idle this long is no longer a consecutive loop.
export const EXACT_REVIEW_SOURCE_DRIFT_LOOP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const PRUNE_MAX_BATCHES = 5;
const ITEM_KEY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d*$/;

// Review-triggering GitHub item actions accepted by webhook ingress
// (CLAWSWEEPER_ISSUE_ITEM_ACTIONS and CLAWSWEEPER_PULL_ITEM_ACTIONS in worker.ts).
export const EXACT_REVIEW_ORGANIC_SOURCE_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "reopened",
  "edited",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "unlocked",
  "unlabeled",
]);

export type ExactReviewSourceDriftLoop = { consecutive: number; updatedAt: number };

export type ExactReviewRunawayHealth = {
  status: "healthy" | "degraded" | "unknown";
  reason: "review_runaway" | "telemetry_unavailable" | null;
  window_hours: number;
  threshold_reviews_per_day: number;
  runaway_items: number;
  /** Private item keys, highest review count first. Public projection filters these. */
  sample_item_keys: string[];
};

/** `0` disables the breaker; unset or malformed values keep the default. */
export function exactReviewSourceDriftRequeueLimit(env: Record<string, unknown>): number {
  return boundedInteger(
    env.EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT,
    DEFAULT_EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT,
    0,
    100,
  );
}

export function exactReviewRunawayReviewsPerDay(env: Record<string, unknown>): number {
  return boundedInteger(
    env.EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY,
    DEFAULT_EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY,
    1,
    10_000,
  );
}

export function exactReviewLoopItemKey(
  decision: Pick<ExactReviewDecision, "targetRepo" | "itemNumber">,
) {
  return `${decision.targetRepo}#${decision.itemNumber}`.toLowerCase();
}

/**
 * An automatic source-drift requeue counts toward the breaker. One that still
 * carries command context continues an explicit command's lifecycle: it is
 * neither counted nor parked, so the command's status obligation is preserved.
 */
export function exactReviewSourceDriftLoopCounted(decision: ExactReviewDecision): boolean {
  return (
    !decision.publication &&
    decision.sourceAction === EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_SOURCE_ACTION &&
    !exactReviewDecisionHasCommandContext(decision)
  );
}

/**
 * Organic source events, explicit commands, and explicit manual reviews end a
 * loop and reset its counter. Scheduled offers never reset it.
 */
export function exactReviewSourceDriftLoopReleases(decision: ExactReviewDecision): boolean {
  if (decision.publication || isLowPriorityExactReviewDecision(decision)) return false;
  if (EXACT_REVIEW_ORGANIC_SOURCE_ACTIONS.has(decision.sourceAction)) return true;
  if (decision.sourceAction === MANUAL_REVIEW_SOURCE_ACTION) return true;
  return exactReviewDecisionHasCommandContext(decision);
}

/**
 * A scheduled offer releases a parked loop for one review generation only when
 * GitHub reports a source update after the park. It never resets the counter:
 * ClawSweeper's own post-review writes can move updated_at, so if that review
 * ends in another source-drift requeue the item re-parks immediately.
 */
export function exactReviewScheduledOfferReleasesSourceDriftLoop(
  decision: ExactReviewDecision,
  observedAt: number,
): boolean {
  if (decision.publication || !exactReviewScheduledLane(decision)) return false;
  const updatedAt = Date.parse(String(decision.sourceUpdatedAt || ""));
  return Number.isFinite(updatedAt) && Number.isFinite(observedAt) && updatedAt > observedAt;
}

/**
 * Additive, advisory loop and review-generation history. Both tables live
 * outside queue item JSON because completed items are deleted between review
 * generations. Older code ignores them; a missing row means no loop history.
 */
export class ExactReviewReviewLoopStore {
  private readonly storage: DurableStorage;
  private schemaReady = false;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    if (this.schemaReady) {
      try {
        // A caller-owned transaction can roll back this DDL after the flag is
        // set. Probe both tables so the next access repairs that rollback.
        this.storage.sql.exec(
          `SELECT item_key FROM ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} LIMIT 0`,
        );
        this.storage.sql.exec(
          `SELECT item_key FROM ${EXACT_REVIEW_REVIEW_GENERATION_TABLE} LIMIT 0`,
        );
        return;
      } catch {
        this.schemaReady = false;
      }
    }
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} (
         item_key TEXT PRIMARY KEY,
         consecutive INTEGER NOT NULL CHECK (consecutive >= 0),
         updated_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_source_drift_loops_updated_at
         ON ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} (updated_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_REVIEW_GENERATION_TABLE} (
         item_key TEXT NOT NULL,
         run_id TEXT NOT NULL,
         run_attempt INTEGER NOT NULL CHECK (run_attempt >= 0),
         claimed_at INTEGER NOT NULL,
         PRIMARY KEY (item_key, run_id, run_attempt)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_queue_review_generations_claimed_at
         ON ${EXACT_REVIEW_REVIEW_GENERATION_TABLE} (claimed_at, item_key)`,
    );
    this.schemaReady = true;
  }

  /**
   * An idle counter is no longer a consecutive loop. Expiry is applied on this
   * read, so an old exhausted counter can never deny admission even when no
   * pruning write ran in between.
   */
  sourceDriftLoopSync(itemKey: string, now: number): ExactReviewSourceDriftLoop | null {
    this.ensureSchemaSync();
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT consecutive, updated_at FROM ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE}
          WHERE item_key = ?`,
        itemKey,
      ),
    )[0] as { consecutive?: number; updated_at?: number } | undefined;
    if (!row) return null;
    const updatedAt = Number(row.updated_at || 0);
    if (updatedAt <= sourceDriftLoopExpiryCutoff(now)) {
      this.storage.sql.exec(
        `DELETE FROM ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} WHERE item_key = ? AND updated_at <= ?`,
        itemKey,
        sourceDriftLoopExpiryCutoff(now),
      );
      return null;
    }
    return { consecutive: Number(row.consecutive || 0), updatedAt };
  }

  /** Records one admitted source-drift review generation and returns the new count. */
  recordSourceDriftGenerationSync(itemKey: string, now: number): number {
    this.ensureSchemaSync();
    this.pruneSourceDriftLoopsSync(now);
    // An expired row restarts at one even if the bounded prune missed it.
    const row = Array.from(
      this.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} (item_key, consecutive, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(item_key) DO UPDATE SET
           consecutive = CASE WHEN updated_at <= ? THEN 1 ELSE consecutive + 1 END,
           updated_at = excluded.updated_at
         RETURNING consecutive`,
        itemKey,
        now,
        sourceDriftLoopExpiryCutoff(now),
      ),
    )[0] as { consecutive?: number } | undefined;
    return Number(row?.consecutive || 0);
  }

  /**
   * The breaker's observation time anchors the scheduled-offer release check.
   * Only a live counter is refreshed; parking never resurrects an expired row.
   */
  markSourceDriftLoopParkedSync(itemKey: string, now: number) {
    this.ensureSchemaSync();
    this.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} SET updated_at = ?
        WHERE item_key = ? AND updated_at > ?`,
      now,
      itemKey,
      sourceDriftLoopExpiryCutoff(now),
    );
  }

  resetSourceDriftLoopSync(itemKey: string) {
    this.ensureSchemaSync();
    this.storage.sql.exec(
      `DELETE FROM ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} WHERE item_key = ?`,
      itemKey,
    );
  }

  /**
   * Best-effort: the generation history only feeds the runaway alert, so a
   * failed write must never block or roll back the review claim.
   */
  recordReviewGenerationSafely(
    itemKey: string,
    runId: string,
    runAttempt: number | null | undefined,
    now: number,
  ) {
    if (!ITEM_KEY_PATTERN.test(itemKey) || !/^\d+$/.test(runId)) return;
    try {
      this.ensureSchemaSync();
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO ${EXACT_REVIEW_REVIEW_GENERATION_TABLE}
           (item_key, run_id, run_attempt, claimed_at)
         VALUES (?, ?, ?, ?)`,
        itemKey,
        runId,
        Number.isSafeInteger(runAttempt) && Number(runAttempt) > 0 ? Number(runAttempt) : 0,
        now,
      );
      this.pruneReviewGenerationsSync(now);
    } catch (error) {
      console.warn("exact-review review generation history write failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  runawayHealthSync(now: number, threshold: number): ExactReviewRunawayHealth {
    this.ensureSchemaSync();
    const cutoff = now - EXACT_REVIEW_RUNAWAY_WINDOW_MS;
    const count = Array.from(
      this.storage.sql.exec(
        `SELECT COUNT(*) AS runaway_items FROM (
           SELECT item_key FROM ${EXACT_REVIEW_REVIEW_GENERATION_TABLE}
            WHERE claimed_at > ?
            GROUP BY item_key
           HAVING COUNT(*) > ?
         )`,
        cutoff,
        threshold,
      ),
    )[0] as { runaway_items?: number } | undefined;
    const runawayItems = Number(count?.runaway_items || 0);
    const samples = runawayItems
      ? (Array.from(
          this.storage.sql.exec(
            `SELECT item_key, COUNT(*) AS reviews FROM ${EXACT_REVIEW_REVIEW_GENERATION_TABLE}
              WHERE claimed_at > ?
              GROUP BY item_key
             HAVING COUNT(*) > ?
              ORDER BY reviews DESC, item_key
              LIMIT ?`,
            cutoff,
            threshold,
            EXACT_REVIEW_RUNAWAY_SAMPLE_LIMIT,
          ),
        ) as Array<{ item_key?: string }>)
      : [];
    return {
      status: runawayItems > 0 ? "degraded" : "healthy",
      reason: runawayItems > 0 ? "review_runaway" : null,
      window_hours: EXACT_REVIEW_RUNAWAY_WINDOW_MS / (60 * 60 * 1000),
      threshold_reviews_per_day: threshold,
      runaway_items: runawayItems,
      sample_item_keys: samples
        .map((row) => String(row.item_key || ""))
        .filter((key) => ITEM_KEY_PATTERN.test(key)),
    };
  }

  private pruneSourceDriftLoopsSync(now: number) {
    this.pruneSync(
      EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE,
      "updated_at",
      sourceDriftLoopExpiryCutoff(now),
    );
  }

  private pruneReviewGenerationsSync(now: number) {
    this.pruneSync(
      EXACT_REVIEW_REVIEW_GENERATION_TABLE,
      "claimed_at",
      now - EXACT_REVIEW_RUNAWAY_WINDOW_MS,
    );
  }

  private pruneSync(table: string, column: string, cutoff: number) {
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const deleted = Array.from(
        this.storage.sql.exec(
          `DELETE FROM ${table}
            WHERE rowid IN (
              SELECT rowid FROM ${table}
               WHERE ${column} <= ?
               ORDER BY ${column}
               LIMIT ${PRUNE_BATCH}
            )
           RETURNING item_key`,
          cutoff,
        ),
      );
      if (deleted.length < PRUNE_BATCH) break;
    }
  }
}

/** Counters last touched at or before this instant are expired. */
export function sourceDriftLoopExpiryCutoff(now: number) {
  return now - EXACT_REVIEW_SOURCE_DRIFT_LOOP_RETENTION_MS;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) return fallback;
  return Math.min(maximum, number);
}
