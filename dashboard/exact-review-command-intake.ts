import {
  validateDirectReReviewIntake,
  type DirectReReviewDecision,
  type DirectReReviewIntake,
} from "../src/repair/direct-re-review-admission.ts";
import { exactReviewBaseDecisionFrom } from "./exact-review-decision.ts";

const COMMAND_INTAKE_TABLE = "exact_review_command_intakes";
const COMMAND_WATERMARK_TABLE = "exact_review_command_watermarks";
const COMMAND_RECEIPT_TABLE = "exact_review_command_receipts";
const COMMAND_BAY_JOURNEY_TABLE = "exact_review_command_bay_journeys";
const ITEM_REVISION_TABLE = "exact_review_item_revisions";
const COMMAND_INTAKE_LIMIT = 16;
const COMMAND_RETRY_BASE_MS = 15_000;
const COMMAND_RETRY_MAX_MS = 15 * 60_000;
export const EXACT_REVIEW_COMMAND_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type SqlRow = Record<string, unknown>;
type CommandIntakeStorage = {
  sql: { exec: (query: string, ...bindings: unknown[]) => Iterable<SqlRow> };
  transactionSync: <T>(callback: () => T) => T;
};

export type CommandIntakeStage = "verify_pending" | "enqueue_pending" | "effects_pending";

export type ExactReviewCommandIntakeRecord = {
  intake: DirectReReviewIntake;
  stage: CommandIntakeStage;
  attempts: number;
  nextAttemptAt: number;
  admittedAt: number;
  verifiedDecision?: DirectReReviewDecision;
};

export type ExactReviewCommandAdmission =
  | {
      accepted: true;
      deduped: boolean;
      commandVersionId: string;
      bayJourneyDeliveryId?: string;
    }
  | {
      accepted: false;
      reason: string;
      commandVersionId: string;
    };

export class ExactReviewCommandIntakeStore {
  private readonly storage: CommandIntakeStorage;

  constructor(storage: CommandIntakeStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COMMAND_INTAKE_TABLE} (
         command_version_id TEXT PRIMARY KEY,
         source_comment_key TEXT NOT NULL,
         source_updated_at INTEGER NOT NULL,
         record_json TEXT NOT NULL,
         next_attempt_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_command_intakes_due
         ON ${COMMAND_INTAKE_TABLE} (next_attempt_at, command_version_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COMMAND_WATERMARK_TABLE} (
         source_comment_key TEXT PRIMARY KEY,
         source_updated_at INTEGER NOT NULL,
         command_version_id TEXT NOT NULL,
         body_digest TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COMMAND_RECEIPT_TABLE} (
         command_version_id TEXT PRIMARY KEY,
         source_comment_key TEXT NOT NULL,
         outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'completed', 'rejected', 'superseded')),
         observed_at INTEGER NOT NULL,
         detail TEXT
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_command_receipts_terminal_observed
         ON ${COMMAND_RECEIPT_TABLE} (outcome, observed_at, command_version_id)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COMMAND_BAY_JOURNEY_TABLE} (
         command_version_id TEXT PRIMARY KEY,
         bay_journey_delivery_id TEXT NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ITEM_REVISION_TABLE} (
         item_key TEXT PRIMARY KEY,
         last_revision INTEGER NOT NULL CHECK (last_revision >= 0)
       ) STRICT`,
    );
  }

  admit(value: unknown, now: number): ExactReviewCommandAdmission | null {
    const intake = validateDirectReReviewIntake(value);
    if (!intake || !exactReviewBaseDecisionFrom(intake.decision)) return null;
    const sourceUpdatedAt = Date.parse(intake.sourceCommentUpdatedAt);
    const sourceCommentKey = commandSourceCommentKey(intake);
    return this.storage.transactionSync(() => {
      const receipt = firstRow(
        this.storage.sql.exec(
          `SELECT receipt.outcome, receipt.detail, journey.bay_journey_delivery_id
             FROM ${COMMAND_RECEIPT_TABLE} receipt
             LEFT JOIN ${COMMAND_BAY_JOURNEY_TABLE} journey
               ON journey.command_version_id = receipt.command_version_id
            WHERE receipt.command_version_id = ?`,
          intake.commandVersionId,
        ),
      );
      if (receipt) {
        const outcome = String(receipt.outcome || "");
        if (outcome === "rejected" || outcome === "superseded") {
          return {
            accepted: false,
            reason: String(receipt.detail || outcome),
            commandVersionId: intake.commandVersionId,
          };
        }
        return {
          accepted: true,
          deduped: true,
          commandVersionId: intake.commandVersionId,
          ...(typeof receipt.bay_journey_delivery_id === "string"
            ? { bayJourneyDeliveryId: receipt.bay_journey_delivery_id }
            : {}),
        };
      }

      const watermark = firstRow(
        this.storage.sql.exec(
          `SELECT source_updated_at, command_version_id FROM ${COMMAND_WATERMARK_TABLE}
            WHERE source_comment_key = ?`,
          sourceCommentKey,
        ),
      );
      const watermarkUpdatedAt = Number(watermark?.source_updated_at);
      const sameWatermarkVersion =
        watermark?.command_version_id === intake.commandVersionId &&
        watermarkUpdatedAt === sourceUpdatedAt;
      if (watermark && (watermarkUpdatedAt > sourceUpdatedAt || sameWatermarkVersion)) {
        const reason = sameWatermarkVersion
          ? "semantic command version already observed"
          : "older comment version";
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO ${COMMAND_RECEIPT_TABLE}
             (command_version_id, source_comment_key, outcome, observed_at, detail)
           VALUES (?, ?, 'rejected', ?, ?)`,
          intake.commandVersionId,
          sourceCommentKey,
          now,
          reason === "older comment version" ? "older_comment_version" : "already_observed",
        );
        return { accepted: false, reason, commandVersionId: intake.commandVersionId };
      }

      if (watermark && watermarkUpdatedAt < sourceUpdatedAt) {
        this.storage.sql.exec(
          `UPDATE ${COMMAND_RECEIPT_TABLE}
              SET outcome = 'superseded', observed_at = ?, detail = 'newer_comment_version'
            WHERE source_comment_key = ? AND outcome = 'pending'`,
          now,
          sourceCommentKey,
        );
        this.storage.sql.exec(
          `DELETE FROM ${COMMAND_INTAKE_TABLE} WHERE source_comment_key = ?`,
          sourceCommentKey,
        );
      }

      const record: ExactReviewCommandIntakeRecord = {
        intake,
        stage: "verify_pending",
        attempts: 0,
        nextAttemptAt: now,
        admittedAt: now,
      };
      this.storage.sql.exec(
        `INSERT INTO ${COMMAND_WATERMARK_TABLE}
           (source_comment_key, source_updated_at, command_version_id, body_digest)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_comment_key) DO UPDATE SET
           source_updated_at = CASE
             WHEN excluded.source_updated_at > source_updated_at
             THEN excluded.source_updated_at ELSE source_updated_at END,
           command_version_id = CASE
             WHEN excluded.source_updated_at > source_updated_at
             THEN excluded.command_version_id ELSE command_version_id END,
           body_digest = CASE
             WHEN excluded.source_updated_at > source_updated_at
             THEN excluded.body_digest ELSE body_digest END`,
        sourceCommentKey,
        sourceUpdatedAt,
        intake.commandVersionId,
        intake.commandBodyDigest,
      );
      this.storage.sql.exec(
        `INSERT INTO ${COMMAND_RECEIPT_TABLE}
           (command_version_id, source_comment_key, outcome, observed_at)
         VALUES (?, ?, 'pending', ?)`,
        intake.commandVersionId,
        sourceCommentKey,
        now,
      );
      if (intake.decision.bayJourneyDeliveryId) {
        this.storage.sql.exec(
          `INSERT INTO ${COMMAND_BAY_JOURNEY_TABLE}
             (command_version_id, bay_journey_delivery_id)
           VALUES (?, ?)`,
          intake.commandVersionId,
          intake.decision.bayJourneyDeliveryId,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO ${COMMAND_INTAKE_TABLE}
           (command_version_id, source_comment_key, source_updated_at, record_json, next_attempt_at)
         VALUES (?, ?, ?, ?, ?)`,
        intake.commandVersionId,
        sourceCommentKey,
        sourceUpdatedAt,
        JSON.stringify(record),
        now,
      );
      return {
        accepted: true,
        deduped: false,
        commandVersionId: intake.commandVersionId,
        ...(intake.decision.bayJourneyDeliveryId
          ? { bayJourneyDeliveryId: intake.decision.bayJourneyDeliveryId }
          : {}),
      };
    });
  }

  due(now: number): ExactReviewCommandIntakeRecord[] {
    return Array.from(
      this.storage.sql.exec(
        `SELECT record_json FROM ${COMMAND_INTAKE_TABLE}
          WHERE next_attempt_at <= ? ORDER BY next_attempt_at, command_version_id
          LIMIT ${COMMAND_INTAKE_LIMIT}`,
        now,
      ),
      (row) => parseRecord(row.record_json),
    ).filter((record): record is ExactReviewCommandIntakeRecord => record !== null);
  }

  isCurrent(record: ExactReviewCommandIntakeRecord) {
    const watermark = firstRow(
      this.storage.sql.exec(
        `SELECT source_updated_at, command_version_id FROM ${COMMAND_WATERMARK_TABLE}
          WHERE source_comment_key = ?`,
        commandSourceCommentKey(record.intake),
      ),
    );
    const timestampMatches =
      Number(watermark?.source_updated_at) === Date.parse(record.intake.sourceCommentUpdatedAt);
    return (
      timestampMatches &&
      (record.stage === "verify_pending" ||
        watermark?.command_version_id === record.intake.commandVersionId)
    );
  }

  markVerified(record: ExactReviewCommandIntakeRecord, now: number) {
    const sourceCommentKey = commandSourceCommentKey(record.intake);
    const sourceUpdatedAt = Date.parse(record.intake.sourceCommentUpdatedAt);
    return this.storage.transactionSync(() => {
      const watermark = firstRow(
        this.storage.sql.exec(
          `SELECT source_updated_at FROM ${COMMAND_WATERMARK_TABLE}
            WHERE source_comment_key = ?`,
          sourceCommentKey,
        ),
      );
      if (Number(watermark?.source_updated_at) > sourceUpdatedAt) return false;
      this.storage.sql.exec(
        `UPDATE ${COMMAND_WATERMARK_TABLE}
            SET command_version_id = ?, body_digest = ?
          WHERE source_comment_key = ? AND source_updated_at = ?`,
        record.intake.commandVersionId,
        record.intake.commandBodyDigest,
        sourceCommentKey,
        sourceUpdatedAt,
      );
      this.storage.sql.exec(
        `UPDATE ${COMMAND_RECEIPT_TABLE}
            SET outcome = 'superseded', observed_at = ?, detail = 'verified_sibling_version'
          WHERE source_comment_key = ? AND command_version_id != ? AND outcome = 'pending'`,
        now,
        sourceCommentKey,
        record.intake.commandVersionId,
      );
      this.storage.sql.exec(
        `DELETE FROM ${COMMAND_INTAKE_TABLE}
          WHERE source_comment_key = ? AND command_version_id != ?`,
        sourceCommentKey,
        record.intake.commandVersionId,
      );
      return true;
    });
  }

  advance(
    commandVersionId: string,
    stage: Exclude<CommandIntakeStage, "verify_pending">,
    now: number,
    verifiedDecision: DirectReReviewDecision,
  ) {
    this.storage.transactionSync(() => {
      const current = this.read(commandVersionId);
      if (!current) return;
      const next: ExactReviewCommandIntakeRecord = {
        ...current,
        stage,
        attempts: 0,
        nextAttemptAt: now,
        verifiedDecision,
      };
      this.write(next);
    });
  }

  finish(
    commandVersionId: string,
    outcome: "completed" | "rejected" | "superseded",
    now: number,
    detail: string | null,
  ) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE ${COMMAND_RECEIPT_TABLE}
            SET outcome = ?, observed_at = ?, detail = ? WHERE command_version_id = ?`,
        outcome,
        now,
        detail,
        commandVersionId,
      );
      this.storage.sql.exec(
        `DELETE FROM ${COMMAND_INTAKE_TABLE} WHERE command_version_id = ?`,
        commandVersionId,
      );
    });
  }

  defer(
    record: ExactReviewCommandIntakeRecord,
    now: number,
    detail: string,
    requestedRetryAt?: number,
    incrementAttempts = true,
  ) {
    this.storage.transactionSync(() => {
      const current = this.read(record.intake.commandVersionId) ?? record;
      const attempts = incrementAttempts ? current.attempts + 1 : current.attempts;
      const delay = Math.min(
        COMMAND_RETRY_MAX_MS,
        COMMAND_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempts - 1), 8),
      );
      const boundedRequestedRetryAt = requestedRetryAt
        ? Math.min(requestedRetryAt, now + COMMAND_RETRY_MAX_MS)
        : 0;
      const next = {
        ...current,
        attempts,
        nextAttemptAt: Math.max(now + Math.max(1_000, delay), boundedRequestedRetryAt),
      };
      this.write(next);
      this.storage.sql.exec(
        `UPDATE ${COMMAND_RECEIPT_TABLE}
            SET observed_at = ?, detail = ? WHERE command_version_id = ? AND outcome = 'pending'`,
        now,
        detail.slice(0, 500),
        record.intake.commandVersionId,
      );
    });
  }

  retryVerification(record: ExactReviewCommandIntakeRecord, now: number, detail: string) {
    this.storage.transactionSync(() => {
      const current = this.read(record.intake.commandVersionId) ?? record;
      const attempts = current.attempts + 1;
      const delay = Math.min(
        COMMAND_RETRY_MAX_MS,
        COMMAND_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
      );
      const next: ExactReviewCommandIntakeRecord = {
        ...current,
        stage: "verify_pending",
        attempts,
        nextAttemptAt: now + delay,
      };
      delete next.verifiedDecision;
      this.write(next);
      this.storage.sql.exec(
        `UPDATE ${COMMAND_RECEIPT_TABLE}
            SET observed_at = ?, detail = ? WHERE command_version_id = ? AND outcome = 'pending'`,
        now,
        detail.slice(0, 500),
        record.intake.commandVersionId,
      );
    });
  }

  nextAttemptAt(): number | null {
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT MIN(next_attempt_at) AS next_attempt_at FROM ${COMMAND_INTAKE_TABLE}`,
      ),
    );
    const next = Number(row?.next_attempt_at || 0);
    return next > 0 ? next : null;
  }

  pruneTerminalReceipts(now: number) {
    this.storage.sql.exec(
      `DELETE FROM ${COMMAND_RECEIPT_TABLE}
        WHERE outcome != 'pending' AND observed_at <= ?`,
      now - EXACT_REVIEW_COMMAND_RECEIPT_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM ${COMMAND_BAY_JOURNEY_TABLE}
        WHERE command_version_id NOT IN (SELECT command_version_id FROM ${COMMAND_RECEIPT_TABLE})`,
    );
  }

  allocateItemRevision(
    itemKey: string,
    minimumRevision: number,
    lifecycleRevision: number,
    publicationRevision: number,
  ) {
    const canonicalKey = itemKey.split("@publish:")[0]!.toLowerCase();
    const floor = Math.max(0, minimumRevision - 1, lifecycleRevision, publicationRevision);
    this.storage.sql.exec(
      `INSERT INTO ${ITEM_REVISION_TABLE} (item_key, last_revision)
       VALUES (?, ?)
       ON CONFLICT(item_key) DO UPDATE SET last_revision = MAX(last_revision, excluded.last_revision)`,
      canonicalKey,
      floor,
    );
    const row = firstRow(
      this.storage.sql.exec(
        `UPDATE ${ITEM_REVISION_TABLE}
            SET last_revision = last_revision + 1 WHERE item_key = ?
          RETURNING last_revision`,
        canonicalKey,
      ),
    );
    const revision = Number(row?.last_revision || 0);
    if (!Number.isSafeInteger(revision) || revision < minimumRevision) {
      throw new Error("exact-review item revision allocation failed");
    }
    return revision;
  }

  private read(commandVersionId: string) {
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT record_json FROM ${COMMAND_INTAKE_TABLE} WHERE command_version_id = ?`,
        commandVersionId,
      ),
    );
    return parseRecord(row?.record_json);
  }

  private write(record: ExactReviewCommandIntakeRecord) {
    this.storage.sql.exec(
      `UPDATE ${COMMAND_INTAKE_TABLE}
          SET record_json = ?, next_attempt_at = ? WHERE command_version_id = ?`,
      JSON.stringify(record),
      record.nextAttemptAt,
      record.intake.commandVersionId,
    );
  }
}

function parseRecord(value: unknown): ExactReviewCommandIntakeRecord | null {
  try {
    const parsed = JSON.parse(String(value || "")) as ExactReviewCommandIntakeRecord;
    return validateDirectReReviewIntake(parsed.intake) &&
      ["verify_pending", "enqueue_pending", "effects_pending"].includes(parsed.stage) &&
      Number.isSafeInteger(parsed.attempts) &&
      parsed.attempts >= 0 &&
      Number.isFinite(parsed.nextAttemptAt)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function commandSourceCommentKey(intake: DirectReReviewIntake) {
  return `${intake.decision.targetRepo.toLowerCase()}:${intake.sourceCommentId}`;
}

function firstRow(rows: Iterable<SqlRow>): SqlRow | undefined {
  return Array.from(rows)[0];
}
