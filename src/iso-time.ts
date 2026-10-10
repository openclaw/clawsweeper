import { DAY_MS } from "./clawsweeper-policy.js";

const ISO_TIMESTAMP_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_TIMESTAMP_OFFSET_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Return the epoch milliseconds of a timestamp, or null when it is empty or not a date. */
export function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Return true when the value is an ISO date-time that Date.parse accepts.
 * Without allowOffset, the value must end in "Z".
 */
export function isIsoTimestamp(value: string, options: { allowOffset: boolean }): boolean {
  const pattern = options.allowOffset ? ISO_TIMESTAMP_OFFSET_PATTERN : ISO_TIMESTAMP_UTC_PATTERN;
  return pattern.test(value) && parseIsoMs(value) !== null;
}

/** A timestamp that is not a date is never old. A zero or negative age is always old. */
export function isOlderThanMs(
  timestamp: string | undefined,
  milliseconds: number,
  now = Date.now(),
): boolean {
  if (milliseconds <= 0) return true;
  const parsed = parseIsoMs(timestamp);
  return parsed !== null && now - parsed > milliseconds;
}

export function isOlderThanDays(timestamp: string | undefined, days: number, now = Date.now()) {
  return isOlderThanMs(timestamp, days * DAY_MS, now);
}
