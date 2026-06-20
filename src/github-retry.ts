export type GhRetryKind = "none" | "throttle" | "transient";

const GH_THROTTLE_PATTERNS = [
  /was submitted too quickly/i,
  /secondary rate/i,
  /API rate limit exceeded/i,
  /rate limit/i,
];

const GH_TRANSIENT_PATTERNS = [
  /unexpected EOF/i,
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
