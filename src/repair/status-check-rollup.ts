import type { JsonValue, LooseRecord } from "./json-types.js";

export interface RolledUpStatusCheck {
  check: LooseRecord;
  ignored: boolean;
}

export function rollUpStatusChecks(
  checks: LooseRecord[],
  ignoredNames: JsonValue,
): RolledUpStatusCheck[] {
  const ignored = parseIgnoredStatusCheckNames(ignoredNames);
  const latestByIdentity = new Map<string, LooseRecord>();
  for (const check of checks) {
    const identity = statusCheckIdentity(check);
    const previous = latestByIdentity.get(identity);
    if (!previous || statusCheckTimestamp(check) >= statusCheckTimestamp(previous)) {
      latestByIdentity.set(identity, check);
    }
  }
  return [...latestByIdentity.values()].map((check) => ({
    check,
    ignored: ignored.has(statusCheckName(check)) || ignored.has(statusCheckWorkflow(check)),
  }));
}

function parseIgnoredStatusCheckNames(value: JsonValue) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item: string) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function statusCheckIdentity(check: LooseRecord) {
  return `${statusCheckWorkflow(check)}\n${statusCheckName(check)}`;
}

function statusCheckName(check: LooseRecord) {
  return String(check.name ?? check.context ?? "unknown check").toLowerCase();
}

function statusCheckWorkflow(check: LooseRecord) {
  return String(check.workflowName ?? "").toLowerCase();
}

function statusCheckTimestamp(check: LooseRecord) {
  for (const field of [
    "startedAt",
    "started_at",
    "createdAt",
    "created_at",
    "completedAt",
    "completed_at",
  ]) {
    const parsed = Date.parse(String(check[field] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return isPendingStatusCheck(check) ? Number.MAX_SAFE_INTEGER : 0;
}

function isPendingStatusCheck(check: LooseRecord) {
  const status = String(check.status ?? check.state ?? "").toUpperCase();
  const conclusion = String(check.conclusion ?? "").toUpperCase();
  return !conclusion && Boolean(status) && !["COMPLETED", "SUCCESS"].includes(status);
}
