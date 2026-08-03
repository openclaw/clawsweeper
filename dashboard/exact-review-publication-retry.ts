type PublicationCompletion = {
  kind: string;
  reasonCode: string;
};

const TRANSIENT_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_RETRY_MAX_AGE_MS = 60 * 60 * 1000;
// Retry more often without shortening the existing outage-recovery windows.
// Twelve old transient attempts spanned about 211 minutes; five old unknown
// attempts spanned about 51 minutes before they entered the dead-letter lane.
const TRANSIENT_RETRY_LIMIT = 48;
const PERMANENT_RETRY_LIMIT = 3;
const UNKNOWN_RETRY_LIMIT = 14;
const NORMAL_RETRY_MAX_MS = 5 * 60_000;
const RATE_LIMIT_RETRY_MAX_MS = 60 * 60_000;

export function exactReviewPublicationRetryExhausted(
  completion: PublicationCompletion,
  attempt: number,
  firstFailureAt: number,
  now: number,
): boolean {
  if (completion.kind === "retryable_failure") {
    if (completion.reasonCode === "artifact_unavailable") return false;
    if (completion.reasonCode === "unknown_failure") {
      return attempt >= UNKNOWN_RETRY_LIMIT || now >= firstFailureAt + UNKNOWN_RETRY_MAX_AGE_MS;
    }
    return attempt >= TRANSIENT_RETRY_LIMIT || now >= firstFailureAt + TRANSIENT_RETRY_MAX_AGE_MS;
  }
  if (completion.kind !== "permanent_failure") return false;
  if (completion.reasonCode === "unknown_failure") {
    return attempt >= UNKNOWN_RETRY_LIMIT || now >= firstFailureAt + UNKNOWN_RETRY_MAX_AGE_MS;
  }
  return attempt >= PERMANENT_RETRY_LIMIT;
}

export function exactReviewPublicationRetryDelayMs(
  itemKey: string,
  completion: PublicationCompletion,
  attempt: number,
): number {
  const maximum =
    completion.reasonCode === "github_rate_limit" ? RATE_LIMIT_RETRY_MAX_MS : NORMAL_RETRY_MAX_MS;
  const baselineDelay =
    completion.kind === "permanent_failure" && completion.reasonCode !== "unknown_failure"
      ? attempt <= 1
        ? 60_000
        : NORMAL_RETRY_MAX_MS
      : 60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6);
  const delay = Math.min(maximum, baselineDelay);
  const hash = [...`${itemKey}:${attempt}`].reduce(
    (current, character) => (current * 33 + character.charCodeAt(0)) >>> 0,
    5381,
  );
  return delay + Math.floor(delay * ((hash % 21) / 100));
}
