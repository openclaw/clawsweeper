import { isDeepStrictEqual } from "node:util";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

const MISSING = Symbol("missing sweep status value");
type MergeValue = JsonValue | typeof MISSING;

const HEALTH_KEYS = new Set(["apply_health", "last_close_apply_health"]);
const IMMUTABLE_KEYS = ["schema_version", "slug", "target_repo"] as const;
const METADATA_KEYS = new Set([...IMMUTABLE_KEYS, "display_name"]);
const STATUS_SNAPSHOT_KEYS = new Set([
  "state",
  "detail",
  "run_url",
  "planned_count",
  "planned_capacity",
  "planned_shards",
  "active_codex",
  "due_backlog",
  "oldest_unreviewed_at",
  "capacity_reason",
  "inherited_label_cleanups",
  "self_heal_conflict_repairs",
  "failed_review_retries",
  "failed_review_retry_exhaustions",
  "bot_owned_proof_decisions_requested",
  "bot_owned_proof_dispatches",
  "updated_at",
]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function mergeSweepStatusJson(options: {
  path: string;
  baseText: string | null;
  localText: string | null;
  remoteText: string | null;
}): string {
  const parsedBase = parseStatus(options.baseText, options.path, "base");
  const local = parseStatus(options.localText, options.path, "local");
  const remote = parseStatus(options.remoteText, options.path, "remote");
  if (parsedBase !== null && (local === null || remote === null)) {
    throw new Error(`Refusing to merge deleted sweep status ${options.path}`);
  }
  if (local === null && remote === null) {
    throw new Error(`Refusing to merge missing sweep status ${options.path}`);
  }
  if (local === null || remote === null) {
    const added = local ?? remote;
    if (added === null) throw new Error(`Refusing to merge missing sweep status ${options.path}`);
    assertStatusIdentity(options.path, added);
    requiredTimestamp(
      optionalTimestamp(added.updated_at, options.path, "added.updated_at"),
      options.path,
      "added.updated_at",
    );
    return `${JSON.stringify(added, null, 2)}\n`;
  }

  const base = parsedBase ?? (Object.create(null) as JsonObject);
  assertImmutableIdentity(options.path, base, local, remote);

  const localRootTimestamp = requiredTimestamp(
    optionalTimestamp(local.updated_at, options.path, "local.updated_at"),
    options.path,
    "local.updated_at",
  );
  const remoteRootTimestamp = requiredTimestamp(
    optionalTimestamp(remote.updated_at, options.path, "remote.updated_at"),
    options.path,
    "remote.updated_at",
  );
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  const snapshotKeys = new Set(STATUS_SNAPSHOT_KEYS);
  for (const key of keys) {
    if (!HEALTH_KEYS.has(key) && !METADATA_KEYS.has(key)) snapshotKeys.add(key);
  }
  const statusSnapshot = mergeStatusSnapshot({
    path: options.path,
    base,
    local,
    remote,
    snapshotKeys,
    localRootTimestamp,
    remoteRootTimestamp,
  });
  const merged: JsonObject = Object.create(null) as JsonObject;

  for (const key of keys) {
    let value: MergeValue;
    if (snapshotKeys.has(key)) {
      value = ownValue(statusSnapshot, key);
    } else if (HEALTH_KEYS.has(key)) {
      value = mergeHealthSnapshot({
        path: `${options.path}:${key}`,
        base: ownValue(base, key),
        local: ownValue(local, key),
        remote: ownValue(remote, key),
        localRootTimestamp,
        remoteRootTimestamp,
      });
    } else {
      value = mergeMetadataValue({
        path: `${options.path}:${key}`,
        base: ownValue(base, key),
        local: ownValue(local, key),
        remote: ownValue(remote, key),
        localRootTimestamp,
        remoteRootTimestamp,
      });
    }
    if (value !== MISSING) merged[key] = value;
  }

  return `${JSON.stringify(merged, null, 2)}\n`;
}

function parseStatus(
  text: string | null,
  path: string,
  side: "base" | "local" | "remote",
): JsonObject | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Refusing to merge malformed sweep status JSON ${path} (${side})`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Refusing to merge non-object sweep status JSON ${path} (${side})`);
  }
  assertStatusIdentity(path, parsed, side);
  return parsed;
}

function assertStatusIdentity(
  path: string,
  status: JsonObject,
  side?: "base" | "local" | "remote",
): void {
  const suffix = side ? ` (${side})` : "";
  if (!Number.isInteger(status.schema_version) || Number(status.schema_version) < 1) {
    throw new Error(
      `Refusing to merge malformed sweep status identity ${path}:schema_version${suffix}`,
    );
  }
  if (typeof status.slug !== "string" || !status.slug.trim()) {
    throw new Error(`Refusing to merge malformed sweep status identity ${path}:slug${suffix}`);
  }
  if (typeof status.target_repo !== "string" || !status.target_repo.includes("/")) {
    throw new Error(
      `Refusing to merge malformed sweep status identity ${path}:target_repo${suffix}`,
    );
  }
}

function assertImmutableIdentity(
  path: string,
  base: JsonObject,
  local: JsonObject,
  remote: JsonObject,
): void {
  for (const key of IMMUTABLE_KEYS) {
    const localValue = ownValue(local, key);
    const remoteValue = ownValue(remote, key);
    const baseValue = ownValue(base, key);
    if (
      !sameValue(localValue, remoteValue) ||
      (baseValue !== MISSING && !sameValue(baseValue, localValue))
    ) {
      throw new Error(`Refusing to merge sweep status identity conflict ${path}:${key}`);
    }
  }
}

function mergeStatusSnapshot(options: {
  path: string;
  base: JsonObject;
  local: JsonObject;
  remote: JsonObject;
  snapshotKeys: ReadonlySet<string>;
  localRootTimestamp: number;
  remoteRootTimestamp: number;
}): JsonObject {
  const base = selectKeys(options.base, options.snapshotKeys);
  const local = selectKeys(options.local, options.snapshotKeys);
  const remote = selectKeys(options.remote, options.snapshotKeys);
  if (isDeepStrictEqual(local, remote)) return local;
  if (isDeepStrictEqual(local, base)) return remote;
  if (isDeepStrictEqual(remote, base)) return local;
  return chooseNewer({
    path: `${options.path}:status snapshot`,
    local,
    remote,
    localTimestamp: options.localRootTimestamp,
    remoteTimestamp: options.remoteRootTimestamp,
  });
}

function mergeHealthSnapshot(options: {
  path: string;
  base: MergeValue;
  local: MergeValue;
  remote: MergeValue;
  localRootTimestamp: number;
  remoteRootTimestamp: number;
}): MergeValue {
  const simple = simpleThreeWay(options.base, options.local, options.remote);
  if (simple !== undefined) return simple;
  const localTimestamp = snapshotTimestamp(
    options.local,
    options.localRootTimestamp,
    options.path,
    "local",
  );
  const remoteTimestamp = snapshotTimestamp(
    options.remote,
    options.remoteRootTimestamp,
    options.path,
    "remote",
  );
  return chooseNewer({
    path: options.path,
    local: options.local,
    remote: options.remote,
    localTimestamp,
    remoteTimestamp,
  });
}

function mergeMetadataValue(options: {
  path: string;
  base: MergeValue;
  local: MergeValue;
  remote: MergeValue;
  localRootTimestamp: number;
  remoteRootTimestamp: number;
}): MergeValue {
  const simple = simpleThreeWay(options.base, options.local, options.remote);
  if (simple !== undefined) return simple;
  return chooseNewer({
    path: options.path,
    local: options.local,
    remote: options.remote,
    localTimestamp: options.localRootTimestamp,
    remoteTimestamp: options.remoteRootTimestamp,
  });
}

function simpleThreeWay(
  base: MergeValue,
  local: MergeValue,
  remote: MergeValue,
): MergeValue | undefined {
  if (sameValue(local, remote)) return local;
  if (sameValue(local, base)) return remote;
  if (sameValue(remote, base)) return local;
  return undefined;
}

function snapshotTimestamp(
  value: MergeValue,
  rootTimestamp: number,
  path: string,
  side: "local" | "remote",
): number {
  if (value !== MISSING && isJsonObject(value) && Object.hasOwn(value, "generated_at")) {
    return requiredTimestamp(
      optionalTimestamp(value.generated_at, path, `${side}.generated_at`),
      path,
      `${side}.generated_at`,
    );
  }
  return rootTimestamp;
}

function optionalTimestamp(
  value: JsonValue | undefined,
  path: string,
  label: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`Refusing to merge sweep status with invalid timestamp ${path}:${label}`);
  }
  return Date.parse(value);
}

function requiredTimestamp(value: number | null, path: string, label: string): number {
  if (value === null) {
    throw new Error(`Refusing ambiguous sweep status merge without ${path}:${label}`);
  }
  return value;
}

function chooseNewer<T extends MergeValue | JsonObject>(options: {
  path: string;
  local: T;
  remote: T;
  localTimestamp: number;
  remoteTimestamp: number;
}): T {
  if (options.localTimestamp > options.remoteTimestamp) return options.local;
  if (options.remoteTimestamp > options.localTimestamp) return options.remote;
  throw new Error(`Refusing ambiguous sweep status merge at equal timestamp ${options.path}`);
}

function selectKeys(source: JsonObject, keys: ReadonlySet<string>): JsonObject {
  const selected: JsonObject = Object.create(null) as JsonObject;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) selected[key] = source[key] as JsonValue;
  }
  return selected;
}

function ownValue(source: JsonObject, key: string): MergeValue {
  return Object.hasOwn(source, key) ? (source[key] as JsonValue) : MISSING;
}

function sameValue(left: MergeValue, right: MergeValue): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  return isDeepStrictEqual(left, right);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
