import {
  COMMAND_PROOF_LIFETIME_MS,
  parseCommandProofClaim,
  proofRecord,
  proofSha,
  proofText,
  type CommandProofClaim,
} from "../src/command-proof-contract.ts";
import type { DurableStorage } from "./durable-storage.ts";

export type CommandProofRecord = {
  claim: CommandProofClaim;
  state: "dispatch_claimed" | "review_pending" | "completed" | "inconclusive";
  createdAt: number;
  expiresAt: number;
  reason?: string;
  runId?: string;
  notified?: boolean;
  nextAttemptAt?: number;
  result?: {
    outcome: "pass" | "fail";
    digest: string;
    reviewContext: string;
    runId: string;
    runAttempt: number;
  };
};
const TABLE = "command_proof_requests_v1";
/** Shares the existing queue's transactional store; no independent scheduler or public API. */
export class CommandProofRequestStore {
  private readonly storage: DurableStorage;
  constructor(storage: DurableStorage) {
    this.storage = storage;
  }
  ensureSchemaSync() {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS " +
        TABLE +
        " (request_id TEXT PRIMARY KEY, target_key TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT",
    );
  }
  claim(value: unknown, now: number) {
    const claim = parseCommandProofClaim(value);
    if (
      !claim ||
      Date.parse(claim.sourceCommentUpdatedAt) > now + 60_000 ||
      Date.parse(claim.sourceCommentUpdatedAt) < now - 24 * 60 * 60_000
    )
      return { accepted: false, reason: "invalid_or_old_claim" };
    return this.storage.transactionSync(() => {
      this.expire(now);
      const sameId = this.get(claim.requestId);
      if (sameId)
        return JSON.stringify(sameId.claim) === JSON.stringify(claim)
          ? { accepted: true, dispatch: false, record: sameId }
          : { accepted: false, reason: "request_identity_conflict" };
      const key = JSON.stringify([
        claim.repositoryId,
        claim.pullRequest,
        claim.sourceCommentId,
        Date.parse(claim.sourceCommentUpdatedAt),
        claim.sourceCommentBodySha256,
      ]);
      const previous = [
        // Match legacy rows too: their old keys included mutable PR/config fields.
        ...this.storage.sql.exec(
          "SELECT record_json FROM " +
            TABLE +
            " WHERE target_key = ? OR (json_extract(record_json, '$.claim.repositoryId') = ? AND json_extract(record_json, '$.claim.pullRequest') = ? AND json_extract(record_json, '$.claim.sourceCommentId') = ? AND julianday(json_extract(record_json, '$.claim.sourceCommentUpdatedAt')) = julianday(?) AND json_extract(record_json, '$.claim.sourceCommentBodySha256') = ?) LIMIT 1",
          key,
          claim.repositoryId,
          claim.pullRequest,
          claim.sourceCommentId,
          claim.sourceCommentUpdatedAt,
          claim.sourceCommentBodySha256,
        ),
      ][0];
      if (previous) {
        const record = JSON.parse(String(previous.record_json)) as CommandProofRecord;
        // A human command version authorizes one immutable binding, regardless of
        // later target/config drift or the original request's terminal state.
        if (
          Object.entries(claim).some(
            ([field, value]) => field !== "requestId" && proofRecord(record.claim)[field] !== value,
          )
        )
          return { accepted: false, reason: "proof_target_binding_changed" };
        return { accepted: true, dispatch: false, record };
      }
      if (
        [
          ...this.storage.sql.exec(
            "SELECT request_id FROM " +
              TABLE +
              " WHERE json_extract(record_json, '$.state') IN ('dispatch_claimed', 'review_pending') LIMIT 1",
          ),
        ].length
      )
        return { accepted: false, reason: "proof_capacity_busy" };
      const record: CommandProofRecord = {
        claim,
        state: "dispatch_claimed",
        createdAt: now,
        expiresAt: now + COMMAND_PROOF_LIFETIME_MS,
      };
      this.storage.sql.exec(
        "INSERT INTO " +
          TABLE +
          " (request_id, target_key, record_json, expires_at) VALUES (?, ?, ?, ?)",
        claim.requestId,
        key,
        JSON.stringify(record),
        record.expiresAt,
      );
      // Durable before any external dispatch. A lost POST response never permits redispatch.
      return { accepted: true, dispatch: true, record };
    });
  }
  get(id: string): CommandProofRecord | null {
    const row = [
      ...this.storage.sql.exec("SELECT record_json FROM " + TABLE + " WHERE request_id = ?", id),
    ][0];
    return row ? (JSON.parse(String(row.record_json)) as CommandProofRecord) : null;
  }
  pending(now: number): CommandProofRecord[] {
    this.expire(now);
    return [
      ...this.storage.sql.exec(
        "SELECT record_json FROM " +
          TABLE +
          " WHERE (json_extract(record_json, '$.state') IN ('dispatch_claimed', 'review_pending') OR coalesce(json_extract(record_json, '$.notified'), 0) = 0) AND coalesce(json_extract(record_json, '$.nextAttemptAt'), 0) <= ? ORDER BY CASE WHEN json_extract(record_json, '$.state') IN ('dispatch_claimed', 'review_pending') THEN 0 ELSE 1 END, expires_at LIMIT 4",
        now,
      ),
    ].map((row) => JSON.parse(String(row.record_json)) as CommandProofRecord);
  }
  update(value: unknown, now: number): CommandProofRecord | null {
    const body = proofRecord(value);
    if (!proofSha(body.requestId, 64)) return null;
    return this.storage.transactionSync(() => {
      this.expire(now);
      const record = this.get(body.requestId as string);
      if (!record) return null;
      if (
        body.operation === "defer" &&
        typeof body.retryAt === "number" &&
        Number.isFinite(body.retryAt) &&
        body.retryAt > now
      ) {
        record.nextAttemptAt = body.retryAt;
        this.storage.sql.exec(
          "UPDATE " + TABLE + " SET record_json = ? WHERE request_id = ?",
          JSON.stringify(record),
          record.claim.requestId,
        );
        return record;
      }
      if (record.state === "completed" || record.state === "inconclusive") {
        if (body.operation === "notified") {
          record.notified = true;
          this.storage.sql.exec(
            "UPDATE " + TABLE + " SET record_json = ? WHERE request_id = ?",
            JSON.stringify(record),
            record.claim.requestId,
          );
        }
        return record;
      }
      if (
        body.operation === "dispatched" &&
        typeof body.runId === "string" &&
        /^[1-9][0-9]{0,19}$/.test(body.runId)
      ) {
        if (record.runId && record.runId !== body.runId) return null;
        record.runId = body.runId;
      } else if (body.operation === "inconclusive" && proofText(body.reason, 2048)) {
        record.state = "inconclusive";
        record.reason = body.reason;
      } else if (body.operation === "verified") {
        const result = proofRecord(body.result);
        if (
          !["pass", "fail"].includes(String(result.outcome)) ||
          !proofSha(result.digest, 64) ||
          !proofText(result.reviewContext, 4800) ||
          typeof result.runId !== "string" ||
          !/^[1-9][0-9]{0,19}$/.test(result.runId) ||
          !Number.isSafeInteger(result.runAttempt) ||
          Number(result.runAttempt) < 1
        )
          return null;
        if (record.result && JSON.stringify(record.result) !== JSON.stringify(result)) return null;
        record.result = result as NonNullable<CommandProofRecord["result"]>;
        record.state = "review_pending";
      } else if (
        body.operation === "enqueued" &&
        record.state === "review_pending" &&
        record.result?.digest === body.digest
      ) {
        record.state = "completed";
        record.notified = true; // The independent review owns further status updates.
      } else return null;
      this.storage.sql.exec(
        "UPDATE " + TABLE + " SET record_json = ? WHERE request_id = ?",
        JSON.stringify(record),
        record.claim.requestId,
      );
      return record;
    });
  }
  private expire(now: number) {
    // Reconciliation backoff ends with the active request. A later terminal
    // notification defer survives because this transition only matches active states.
    this.storage.sql.exec(
      "UPDATE " +
        TABLE +
        " SET record_json = json_remove(json_set(record_json, '$.state', 'inconclusive', '$.reason', 'proof_deadline_expired'), '$.nextAttemptAt') WHERE expires_at <= ? AND json_extract(record_json, '$.state') IN ('dispatch_claimed', 'review_pending')",
      now,
    );
    this.storage.sql.exec(
      "DELETE FROM " + TABLE + " WHERE expires_at < ?",
      now - 30 * 24 * 60 * 60_000,
    );
  }
}
