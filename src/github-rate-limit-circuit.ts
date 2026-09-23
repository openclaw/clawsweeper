import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import {
  GitHubRateLimitError,
  type GitHubCredentialScope,
  type GitHubRateLimitProvenance,
} from "./github-retry.js";

export class GitHubRateLimitCircuitError extends GitHubRateLimitError {}

/** Read only this batch's matching credential circuit; never extend its reset. */
export function activeGitHubRateLimitCircuit(
  path: string,
  scope: GitHubCredentialScope,
  targetOwner: string,
  now = Date.now(),
): GitHubRateLimitCircuitError | null {
  let contents: string;
  try {
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      contents = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let latest: GitHubRateLimitCircuitError | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || value.scope !== scope) continue;
      if (scope === "target_app" && value.target_owner !== targetOwner.toLowerCase()) continue;
      const observedAt = Date.parse(value.observed_at);
      const retryAt = Date.parse(value.retry_at);
      if (
        !Number.isFinite(observedAt) ||
        observedAt > now ||
        !Number.isFinite(retryAt) ||
        retryAt <= now ||
        retryAt > now + 2 * 60 * 60_000 ||
        typeof value.authoritative !== "boolean" ||
        !["retry_after", "rate_limit_reset", "rate_limit_status", "fallback"].includes(
          value.provenance,
        )
      )
        continue;
      if (latest && retryAt <= Date.parse(latest.retryAt)) continue;
      latest = new GitHubRateLimitCircuitError(
        `Shared publication credential is rate limited until ${new Date(retryAt).toISOString()}`,
        now,
        {
          scope,
          retryAt,
          provenance: value.provenance as GitHubRateLimitProvenance,
          authoritative: value.authoritative,
        },
      );
    } catch {
      // Sibling processes can still be appending a complete observation.
    }
  }
  return latest;
}
