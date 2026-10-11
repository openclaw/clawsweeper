// Durable command identities are shared by review intake and historical ledgers.
import { sha256 } from "../../content-hash.js";
import type { LooseRecord } from "../json-types.js";

export function dispatchClaimLookupKeys(entry: LooseRecord) {
  const keys: string[] = [];
  const attemptId = forcedReplayAttemptId(entry);
  const commentId = String(entry.comment_id ?? "").trim();
  const commentUpdatedAt = String(entry.comment_updated_at ?? "").trim();
  if (commentId && commentUpdatedAt) {
    keys.push(scopedDispatchLookupKey(`comment:${commentId}:${commentUpdatedAt}`, attemptId));
  }
  const idempotencyKey = String(entry.idempotency_key ?? "").trim();
  if (idempotencyKey) {
    keys.push(scopedDispatchLookupKey(`idempotency:${idempotencyKey}`, attemptId));
  }
  return keys;
}

export function dispatchReceiptKeyMaterial(entry: LooseRecord, claim: LooseRecord | null) {
  const idempotencyKey = String(entry.idempotency_key ?? entry.comment_version_key ?? "unknown");
  const attemptId = forcedReplayAttemptId(entry);
  if (attemptId) {
    return JSON.stringify({ idempotency_key: idempotencyKey, forced_replay_attempt_id: attemptId });
  }
  // Old ledger identities must still reconcile with their original receipts.
  if (entry.automation_source !== "repair_loop_label_sweep") return idempotencyKey;
  const attempt = String(
    claim?.processed_at ?? entry.processed_at ?? entry.comment_updated_at ?? "unknown-attempt",
  );
  return `${idempotencyKey}:${attempt}`;
}

export function routerDispatchReceiptKey(entry: LooseRecord, claim: LooseRecord | null) {
  return `router-${sha256(dispatchReceiptKeyMaterial(entry, claim)).slice(0, 16)}`;
}

function forcedReplayAttemptId(entry: LooseRecord): string | null {
  const identity = forcedReplayIdentityFields(entry);
  return identity.attempt_id ? String(identity.attempt_id) : null;
}

export function forcedReplayIdentityFields(entry: LooseRecord): LooseRecord {
  const forcedReplay = entry.forced_replay;
  const hasAttemptId = entry.attempt_id !== undefined && entry.attempt_id !== null;
  const attemptId = String(entry.attempt_id ?? "").trim();
  if (
    (forcedReplay === undefined || forcedReplay === null || forcedReplay === false) &&
    !hasAttemptId
  ) {
    return {};
  }
  if (forcedReplay !== true) {
    throw new Error("forced replay dispatch identity requires forced_replay=true");
  }
  if (
    !attemptId ||
    attemptId.length > 128 ||
    /\s/.test(attemptId) ||
    attemptId.includes(String.fromCharCode(0))
  ) {
    throw new Error(
      "forced replay dispatch attempt_id must be a non-empty token of at most 128 characters",
    );
  }
  return { forced_replay: true, attempt_id: attemptId };
}

function scopedDispatchLookupKey(key: string, attemptId: string | null): string {
  return attemptId ? `forced-replay:${JSON.stringify([key, attemptId])}` : key;
}
