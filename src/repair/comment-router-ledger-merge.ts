import { isRecord } from "../value-coerce.js";
type JsonRecord = Record<string, unknown>;

const MAX_COMMANDS = 1000;

export function mergeCommentRouterLedgers(localText: string, remoteText: string): string {
  const local = parseLedger(localText, "local");
  const remote = parseLedger(remoteText, "remote");
  const byKey = new Map<string, JsonRecord>();

  // A router run publishes a bounded snapshot. Unioning by durable command
  // identity prevents a later stale snapshot from erasing commands that a
  // concurrent run already committed.
  for (const entry of [...remote.commands, ...local.commands]) {
    const key = ledgerEntryKey(entry);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, entry);
      continue;
    }
    const winner = compareEntries(previous, entry) < 0 ? entry : previous;
    const alternate = winner === entry ? previous : entry;
    const matchingCommentIdentity =
      winner.repo === alternate.repo &&
      winner.comment_id === alternate.comment_id &&
      winner.comment_updated_at === alternate.comment_updated_at &&
      typeof winner.comment_body_sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(winner.comment_body_sha256) &&
      winner.comment_body_sha256 === alternate.comment_body_sha256;
    const deliveryIds = [winner.source_delivery_id, alternate.source_delivery_id]
      .map((value) => String(value ?? ""))
      .filter((value) => /^[A-Za-z0-9_.:-]{1,200}$/.test(value))
      .sort();
    const conflicted =
      winner.source_delivery_conflict === true ||
      alternate.source_delivery_conflict === true ||
      (!matchingCommentIdentity &&
        (deliveryIds.length > 0 ||
          typeof winner.comment_body_sha256 === "string" ||
          typeof alternate.comment_body_sha256 === "string"));
    if (conflicted) {
      const { source_delivery_id: _discardedDeliveryId, ...unverifiedWinner } = winner;
      byKey.set(key, { ...unverifiedWinner, source_delivery_conflict: true });
    } else {
      byKey.set(
        key,
        matchingCommentIdentity && deliveryIds.length > 0
          ? { ...winner, source_delivery_id: deliveryIds[0] }
          : winner,
      );
    }
  }

  const commands = [...byKey.values()]
    .sort((left, right) => compareLedgerOrder(left, right))
    .slice(-MAX_COMMANDS);
  const updatedAt = latestTimestamp(local.updated_at, remote.updated_at);
  return `${JSON.stringify({ updated_at: updatedAt, commands }, null, 2)}\n`;
}

function parseLedger(
  text: string,
  side: string,
): { updated_at: string | null; commands: JsonRecord[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to parse ${side} comment router ledger`, { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.commands) || !value.commands.every(isRecord)) {
    throw new Error(`${side} comment router ledger must contain a commands array`);
  }
  const updatedAt = typeof value.updated_at === "string" ? value.updated_at : null;
  return { updated_at: updatedAt, commands: value.commands };
}

function ledgerEntryKey(entry: JsonRecord): string {
  if (
    !entry.comment_version_key &&
    entry.automation_source === "repair_loop_label_sweep" &&
    entry.idempotency_key
  ) {
    return `idempotency:${String(entry.idempotency_key)}`;
  }
  return String(
    entry.comment_version_key ??
      `${String(entry.comment_id ?? "unknown")}:${String(entry.comment_updated_at ?? "unknown")}`,
  );
}

function compareEntries(left: JsonRecord, right: JsonRecord): number {
  const status = statusRank(left.status) - statusRank(right.status);
  if (status !== 0) return status;
  const processed = timestamp(left.processed_at) - timestamp(right.processed_at);
  if (processed !== 0) return processed;
  return canonicalEntryText(left).localeCompare(canonicalEntryText(right));
}

function canonicalEntryText(entry: JsonRecord): string {
  const {
    source_delivery_id: _sourceDeliveryId,
    source_delivery_conflict: _sourceDeliveryConflict,
    ...canonical
  } = entry;
  return JSON.stringify(canonical);
}

function compareLedgerOrder(left: JsonRecord, right: JsonRecord): number {
  const processed = timestamp(left.processed_at) - timestamp(right.processed_at);
  if (processed !== 0) return processed;
  return ledgerEntryKey(left).localeCompare(ledgerEntryKey(right));
}

function statusRank(value: unknown): number {
  if (value === "executed") return 4;
  if (value === "skipped") return 3;
  if (value === "waiting") return 2;
  if (value === "claimed") return 1;
  return 0;
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return timestamp(left) >= timestamp(right) ? left : right;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
