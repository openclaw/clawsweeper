const PUBLIC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const PUBLIC_TIMESTAMP_MIN_MS = Date.UTC(2020, 0, 1);
const PUBLIC_TIMESTAMP_MAX_MS = Date.UTC(2100, 0, 1);

export function publicTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 35 || !PUBLIC_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    timestamp >= PUBLIC_TIMESTAMP_MIN_MS &&
    timestamp < PUBLIC_TIMESTAMP_MAX_MS
    ? new Date(timestamp).toISOString()
    : null;
}
