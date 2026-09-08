import { ExactReviewBatchQueueTransportError } from "./repair/exact-review-queue-transport-error.js";

export type GhRetryKind = "none" | "throttle" | "transient";

export type GitHubCredentialScope = "repository_actions" | "target_app";
export type GitHubRateLimitProvenance =
  | "retry_after"
  | "rate_limit_reset"
  | "rate_limit_status"
  | "fallback";

type GitHubRateLimitOptions = {
  scope?: GitHubCredentialScope;
  retryAt?: string | number;
  provenance?: GitHubRateLimitProvenance;
  authoritative?: boolean;
};

export class GitHubRateLimitError extends Error {
  readonly retryAt: string;
  readonly scope: GitHubCredentialScope;
  readonly provenance: GitHubRateLimitProvenance;
  readonly authoritative: boolean;

  constructor(cause: unknown, now = Date.now(), options: GitHubRateLimitOptions = {}) {
    const message = ghErrorText(cause);
    const retryAfter = message.match(/\bretry-after\s*[:=]\s*(\d+)\b/i)?.[1];
    const reset = message.match(/\bx-ratelimit-reset\s*[:=]\s*(\d+)\b/i)?.[1];
    const propagated = message.match(/\brate limited until\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i)?.[1];
    const propagatedScope = message.match(/\bcredential scope\s+([a-z_]+)\b/i)?.[1];
    const propagatedProvenance = message.match(/\breset source\s+([a-z_]+)\b/i)?.[1];
    const carriedProvenance = [
      "retry_after",
      "rate_limit_reset",
      "rate_limit_status",
      "fallback",
    ].includes(propagatedProvenance || "")
      ? (propagatedProvenance as GitHubRateLimitProvenance)
      : null;
    const explicitRetryAt =
      typeof options.retryAt === "number"
        ? options.retryAt
        : Date.parse(options.retryAt || "") || 0;
    const propagatedRetryAt = propagated ? Date.parse(propagated) || 0 : 0;
    const hintedRetryAt = retryAfter
      ? now + Number(retryAfter) * 1_000
      : reset
        ? Number(reset) * 1_000
        : propagatedRetryAt;
    const provenance =
      options.provenance ??
      (retryAfter ? "retry_after" : reset ? "rate_limit_reset" : carriedProvenance || "fallback");
    const scope =
      options.scope ??
      (propagatedScope === "repository_actions" || propagatedScope === "target_app"
        ? propagatedScope
        : "target_app");
    const retryFloor = propagatedRetryAt > now ? now : now + 60_000;
    const retryAt = new Date(Math.max(retryFloor, explicitRetryAt, hintedRetryAt)).toISOString();
    super(
      `GitHub API rate limited until ${retryAt}; credential scope ${scope}; reset source ${provenance}: ${message}`,
      { cause },
    );
    this.name = "GitHubRateLimitError";
    this.retryAt = retryAt;
    this.scope = scope;
    this.provenance = provenance;
    this.authoritative =
      options.authoritative ??
      Boolean(
        retryAfter ||
        reset ||
        provenance === "rate_limit_status" ||
        (propagated && carriedProvenance && carriedProvenance !== "fallback"),
      );
  }
}

const GH_THROTTLE_PATTERNS = [
  /was submitted too quickly/i,
  /abuse detection/i,
  /secondary rate/i,
  /API rate limit exceeded/i,
  /rate limit/i,
];

const GH_TRANSIENT_PATTERNS = [
  /unexpected EOF/i,
  /unexpected end of JSON input/i,
  /connection reset/i,
  /connection reset by peer/i,
  /error connecting to api\.github\.com/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /invalid character '<' looking for beginning of value/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /TLS handshake timeout/i,
  /\bi\/o timeout\b/i,
  /Client\.Timeout exceeded/i,
  /connection refused/i,
  /could not resolve host/i,
  /timed out/i,
  /\btimeout\b/i,
  /temporary failure/i,
  /try again later/i,
];

export function ghRetryKind(error: unknown): GhRetryKind {
  // Coordinator retries belong to their queue, not the GitHub retry loop.
  if (error instanceof ExactReviewBatchQueueTransportError) return "none";
  const message = ghErrorText(error);
  if (GH_THROTTLE_PATTERNS.some((pattern) => pattern.test(message))) return "throttle";
  if (hasGitHubStatus(message, [429])) return "throttle";
  if (hasGitHubStatus(message, [500, 502, 503, 504])) return "transient";
  if (GH_TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "none";
}

export function shouldRetryGh(error: unknown): boolean {
  return ghRetryKind(error) !== "none";
}

export function isLockedConversationCommentError(error: unknown): boolean {
  const message = ghErrorText(error);
  return (
    /\bHTTP\s*403\b/i.test(message) &&
    /(?:issue|conversation|discussion).{0,80}locked|locked.{0,80}(?:issue|conversation|discussion)/i.test(
      message,
    )
  );
}

export function isGitHubNotFoundError(error: unknown): boolean {
  const message = ghErrorText(error);
  return /\b(?:HTTP\s*)?404\b/i.test(message) && /\bnot found\b/i.test(message);
}

export function isGitHubRequiresAuthenticationError(error: unknown): boolean {
  const message = ghErrorText(error);
  return hasGitHubStatus(message, [401]) && /\brequires authentication\b/i.test(message);
}

export function ghRetryWaitMs(kind: GhRetryKind, attempt: number): number {
  if (kind === "throttle") return Math.min(60_000, 30_000 * 2 ** attempt);
  if (kind === "transient") return Math.min(60_000, 2_000 * 2 ** attempt);
  return 0;
}

export function summarizeGhArgs(args: readonly string[]): string {
  if (args[0] === "api" && args[1]) return `gh api ${args[1]}`;
  return `gh ${args.slice(0, 3).join(" ")}`;
}

function ghErrorText(error: unknown): string {
  return [
    error instanceof Error ? error.message : String(error),
    errorField(error, "stdout"),
    errorField(error, "stderr"),
  ].join("\n");
}

function hasGitHubStatus(message: string, statuses: readonly number[]): boolean {
  const lower = message.toLowerCase();
  return statuses.some((status) => {
    const value = String(status);
    return [
      `http ${value}`,
      `http: ${value}`,
      `http:${value}`,
      `status ${value}`,
      `status: ${value}`,
      `status code ${value}`,
      `status code: ${value}`,
      `status code:${value}`,
    ].some((needle) => lower.includes(needle));
  });
}

function errorField(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}
