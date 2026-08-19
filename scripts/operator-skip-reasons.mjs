function failureText(value) {
  return value instanceof Error ? value.message : String(value ?? "");
}

function failureStatus(value, text) {
  if (Number.isInteger(value?.status)) return String(value.status);
  return /(?:\bwith|\breturned|\()\s*([1-5]\d{2})\)?\b/.exec(text)?.[1] ?? null;
}

export function isGitHubThrottleFailure(value) {
  if (value?.rateLimited === true) return true;
  const text = failureText(value);
  const status = failureStatus(value, text);
  if (status === "429") return true;
  if (status !== "403") return false;
  return /api[\s-]+rate[\s-]+limit exceeded|secondary[\s-]+rate[\s-]+limit|abuse detection|rate[\s-]+limited|too many requests|was submitted too quickly/i.test(
    text,
  );
}

export function classifyOperatorSkipReason(value) {
  const reason = failureText(value);
  const normalized = reason.toLowerCase();
  if (normalized.includes("github app installation is missing or revoked")) {
    return "installation_missing";
  }
  if (normalized.includes("not inspected because canonical discovery aborted")) {
    return "not_inspected_abort";
  }
  if (normalized.includes("inspected but reconciliation aborted")) {
    return "inspected_before_abort";
  }
  if (normalized.includes("missing from an existing repository")) {
    return "missing_from_existing_repository";
  }
  if (
    normalized.includes("invalid identity") ||
    normalized.includes("invalid canonical identity")
  ) {
    return "invalid_identity";
  }
  if (/\b(timeout|timed out|aborterror|timeouterror)\b/.test(normalized)) return "timeout";
  if (isGitHubThrottleFailure(value)) return "github_throttled";
  const status = failureStatus(value, reason);
  if (status === "403") return "http_403";
  if (status === "429") return "http_429";
  if (status?.startsWith("5")) return "http_5xx";
  if (status?.startsWith("4")) return "http_4xx";
  if (status?.startsWith("3")) return "http_3xx";
  return "other";
}
