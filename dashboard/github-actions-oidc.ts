/** GitHub Actions OIDC JWT verification shared by workflow-authenticated Worker routes. */
export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = GITHUB_ACTIONS_OIDC_ISSUER + "/.well-known/jwks";
const MAX_TOKEN_LENGTH = 16_384;
const MAX_JWKS_BYTES = 65_536;

export type GithubActionsOidcClaims = Record<string, unknown>;
export type GithubActionsOidcOptions = { fetch?: typeof fetch; now?: number };
export type GithubActionsOidcResult =
  | { ok: true; claims: GithubActionsOidcClaims }
  | { ok: false; reason: "rejected" | "unavailable" };

function bytes(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
    character.charCodeAt(0),
  );
}

function part(value: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(value)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_jwt");
  return parsed;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || Number(response.headers.get("content-length") || 0) > MAX_JWKS_BYTES)
    return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > MAX_JWKS_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}

/**
 * Verifies a GitHub-signed Actions OIDC token for `audience`.
 * `accept` runs on the unverified claims before the JWKS fetch so cheap identity
 * mismatches never reach the network. Rejection and verifier unavailability
 * both fail closed, but only unavailability is retryable.
 */
export async function verifiedGithubActionsOidcClaims(
  token: string,
  audience: string,
  accept: (claims: GithubActionsOidcClaims) => boolean,
  options: GithubActionsOidcOptions = {},
): Promise<GithubActionsOidcResult> {
  let segments: string[];
  let header: Record<string, unknown>;
  let claims: GithubActionsOidcClaims;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "rejected" };
    segments = token.split(".");
    if (segments.length !== 3 || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s)))
      return { ok: false, reason: "rejected" };
    header = part(segments[0]!);
    claims = part(segments[1]!);
    signature = bytes(segments[2]!);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 200 ||
      header.crit !== undefined
    )
      return { ok: false, reason: "rejected" };
    const now = (options.now ?? Date.now()) / 1000;
    if (
      claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER ||
      claims.aud !== audience ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      typeof claims.nbf !== "number" ||
      claims.exp <= now ||
      claims.nbf > now + 30 ||
      claims.iat > now + 30 ||
      claims.exp - claims.iat > 600 ||
      claims.iat < now - 600 ||
      !accept(claims)
    )
      return { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "rejected" };
  }
  let key: CryptoKey;
  try {
    // Workers reject `redirect: "error"`; a manual 3xx is not ok, so it fails closed.
    const response = await (options.fetch ?? fetch)(JWKS, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    const keys = (await boundedJson(response)) as { keys?: unknown } | null;
    if (
      !keys ||
      !Array.isArray(keys.keys) ||
      keys.keys.length > 20 ||
      keys.keys.some((key) => !key || typeof key !== "object" || Array.isArray(key))
    )
      return { ok: false, reason: "unavailable" };
    const matches = keys.keys.filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig"),
    );
    // A missing key can be GitHub key-rotation propagation, not a bad token.
    if (matches.length !== 1) return { ok: false, reason: "unavailable" };
    key = await crypto.subtle.importKey(
      "jwk",
      matches[0],
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  try {
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(segments[0] + "." + segments[1]),
    );
    return verified ? { ok: true, claims } : { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "rejected" };
  }
}
