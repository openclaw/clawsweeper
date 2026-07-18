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
    if (!previous || compareEntries(previous, entry) < 0) byKey.set(key, entry);
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
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
