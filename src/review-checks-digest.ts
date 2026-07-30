import { stableJsonCodeUnit } from "./stable-json.js";

export function reviewPullChecksDigestParts(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const checks = value as Record<string, unknown>;
  if (!Array.isArray(checks.checkRuns)) return value;

  const seen = new Set<string>();
  const checkRuns = checks.checkRuns.filter((checkRun) => {
    const identity = stableJsonCodeUnit(checkRun);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  return checkRuns.length === checks.checkRuns.length ? value : { ...checks, checkRuns };
}
