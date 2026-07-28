const SERVER_ERROR_MAX_LENGTH = 500;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu;
const URL_SECRET_QUERY_PATTERN =
  /([?&](?:access_?token|api_?key|key|password|secret|signature|token)=)[^&\s]+/giu;
const NAMED_SECRET_PATTERN =
  /\b(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CLOUDFLARE_API_TOKEN)=([^\s"']+)/giu;
const GITHUB_TOKEN_PATTERN = /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/gu;
const BEARER_CREDENTIAL_PATTERN = /\b((?:authorization\s*:\s*)?bearer\s+)[A-Za-z0-9._~+/-]+=*/giu;

export function sanitizedServerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(URL_SECRET_QUERY_PATTERN, "$1[REDACTED]")
    .replace(NAMED_SECRET_PATTERN, "$1=[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED_GITHUB_TOKEN]")
    .replace(BEARER_CREDENTIAL_PATTERN, "$1[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return sanitized.slice(0, SERVER_ERROR_MAX_LENGTH) || "unknown error";
}
