import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../../value-coerce.js";
import { dispatchClaimLookupKeys, forcedReplayIdentityFields } from "./dispatch.js";
import type { JsonValue, LooseRecord } from "../json-types.js";

type JsonRecord = Record<string, unknown>;

const LEDGER_COMMAND_STATUSES = new Set(["claimed", "executed", "skipped", "waiting"]);
const LEDGER_COMMAND_STRING_FIELDS = [
  "idempotency_key",
  "comment_id",
  "comment_version_key",
  "comment_created_at",
  "comment_updated_at",
  "source_delivery_id",
  "repo",
  "processed_at",
] as const;

export function readLedger(file: JsonValue) {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { updated_at: null, commands: [] };
    }
    throw error;
  }
  let data: LooseRecord;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error(`failed to parse comment router ledger: ${String(file)}`, { cause: error });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("comment router ledger must be an object");
  }
  if (!Array.isArray(data.commands)) {
    throw new Error("comment router ledger commands must be an array");
  }
  return {
    updated_at: data.updated_at ?? null,
    commands: data.commands.map((entry: JsonValue) => validatedLedgerCommand(entry)),
  };
}

export function appendLedger(current: LooseRecord, entries: LooseRecord[]) {
  const byCommentVersion = new Map(
    (current.commands ?? []).map((entry: JsonValue) => [ledgerEntryKey(entry), entry]),
  );
  const compact = entries
    .filter((entry: JsonValue) =>
      ["claimed", "executed", "skipped", "waiting"].includes(entry.status),
    )
    .filter((entry: JsonValue) => !isNoopSkip(entry))
    .map((entry: JsonValue) => {
      const actions = compactLedgerActions(entry.actions);
      const previous = byCommentVersion.get(ledgerEntryKey(entry)) as LooseRecord | undefined;
      const deliveryConflicted =
        entry.source_delivery_conflict === true || previous?.source_delivery_conflict === true;
      return {
        idempotency_key: entry.idempotency_key,
        comment_id: entry.comment_id,
        comment_version_key: entry.comment_version_key ?? null,
        comment_url: entry.comment_url,
        comment_created_at: entry.comment_created_at ?? null,
        comment_updated_at: entry.comment_updated_at ?? null,
        ...(entry.comment_body_sha256 ? { comment_body_sha256: entry.comment_body_sha256 } : {}),
        ...(deliveryConflicted
          ? { source_delivery_conflict: true }
          : /^[A-Za-z0-9_.:-]{1,200}$/.test(String(entry.source_delivery_id ?? ""))
            ? { source_delivery_id: entry.source_delivery_id }
            : {}),
        repo: entry.repo,
        issue_number: entry.issue_number,
        author: entry.author,
        author_id: entry.author_id ?? null,
        author_name: entry.author_name ?? null,
        author_association: entry.author_association,
        trigger: entry.trigger,
        command: entry.command,
        intent: entry.intent,
        ...(entry.intent === "request_proof" && entry.proof_admission
          ? { proof_admission: entry.proof_admission }
          : {}),
        trusted_bot: Boolean(entry.trusted_bot),
        trusted_bot_author: entry.trusted_bot_author ?? null,
        automation_source: entry.automation_source ?? null,
        repair_reason: entry.repair_reason ?? null,
        ...forcedReplayIdentityFields(entry),
        expected_head_sha: entry.expected_head_sha ?? null,
        finding_id: entry.finding_id ?? null,
        status: entry.status,
        processed_at: entry.processed_at ?? new Date().toISOString(),
        target: entry.target
          ? {
              kind: entry.target.kind,
              branch: entry.target.branch,
              head_sha: entry.target.head_sha,
              cluster_id: entry.target.cluster_id,
              job_path: entry.target.job_path,
            }
          : null,
        ...(actions.length > 0 ? { actions } : {}),
      };
    });
  if (compact.length === 0) return false;
  let changed = false;
  for (const entry of compact) {
    const key = ledgerEntryKey(entry);
    const previous = byCommentVersion.get(key);
    if (previous && stableLedgerEntry(previous) === stableLedgerEntry(entry)) continue;
    if (previous) byCommentVersion.delete(key);
    byCommentVersion.set(key, entry);
    changed = true;
  }
  if (!changed) return false;
  current.updated_at = new Date().toISOString();
  current.commands = [...byCommentVersion.values()].slice(-1000);
  return true;
}

function validatedLedgerCommand(entry: JsonValue): LooseRecord {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("comment router ledger commands must be objects");
  }
  const command = { ...entry, ...forcedReplayIdentityFields(entry) };
  for (const field of LEDGER_COMMAND_STRING_FIELDS) {
    const value = command[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim())) {
      throw new Error(`comment router ledger command ${field} must be a non-empty string or null`);
    }
  }
  if (!LEDGER_COMMAND_STATUSES.has(command.status)) {
    throw new Error("comment router ledger command status is invalid");
  }
  if (
    command.source_delivery_id !== undefined &&
    command.source_delivery_id !== null &&
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(String(command.source_delivery_id))
  ) {
    throw new Error("comment router ledger command source_delivery_id is invalid");
  }
  if (
    command.source_delivery_conflict !== undefined &&
    (command.source_delivery_conflict !== true || command.source_delivery_id !== undefined)
  ) {
    throw new Error("comment router ledger delivery conflict must suppress delivery provenance");
  }
  if (
    typeof command.processed_at !== "string" ||
    !Number.isFinite(Date.parse(command.processed_at))
  ) {
    throw new Error("comment router ledger command processed_at must be a valid timestamp");
  }
  if (
    command.actions !== undefined &&
    (!Array.isArray(command.actions) ||
      command.actions.some(
        (action: JsonValue) => !action || typeof action !== "object" || Array.isArray(action),
      ))
  ) {
    throw new Error("comment router ledger command actions must be an array of objects");
  }
  if (
    command.target !== undefined &&
    command.target !== null &&
    (typeof command.target !== "object" || Array.isArray(command.target))
  ) {
    throw new Error("comment router ledger command target must be an object or null");
  }
  if (command.status === "claimed" && dispatchClaimLookupKeys(command).length === 0) {
    throw new Error("claimed comment router ledger command requires a durable lookup identity");
  }
  return command;
}

function isNoopSkip(entry: LooseRecord) {
  if (String(entry.status ?? "") !== "skipped") return false;
  const reason = String(entry.reason ?? "");
  return (
    reason === "comment version already processed in ledger" ||
    reason === "matching ClawSweeper response comment already exists" ||
    /already enabled for this PR/i.test(reason)
  );
}

function stableLedgerEntry(entry: LooseRecord) {
  return JSON.stringify({
    ...entry,
    processed_at: entry.status === "claimed" ? entry.processed_at : null,
  });
}

function compactLedgerActions(actions: JsonValue) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action: JsonValue) => ({
      action: action?.action ?? null,
      status: action?.status ?? null,
      label: action?.label ?? null,
      job_path: action?.job_path ?? null,
    }))
    .filter((action: LooseRecord) => action.action || action.status);
}

export function writeLedger(file: JsonValue, current: LooseRecord) {
  const ledgerPath = String(file);
  const directory = path.dirname(ledgerPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(ledgerPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = `${JSON.stringify(current, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    const descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, ledgerPath);
    fsyncDirectory(directory);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ledgerEntryKey(entry: LooseRecord): string {
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
