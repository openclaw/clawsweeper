import {
  LinearRequestError,
  linearRetryKind,
  linearRetryWaitMs,
  shouldRetryLinear,
} from "./retry.js";

export type LinearTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

export interface ResolveTokenOptions {
  token?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveLinearToken(options?: ResolveTokenOptions): string {
  const env = options?.env ?? process.env;
  const token = options?.token ?? env["LINEAR_API_KEY"] ?? env["LINEAR_TOKEN"];
  if (!token) {
    throw new Error(
      "No Linear API token found. Set LINEAR_API_KEY or LINEAR_TOKEN in the environment.",
    );
  }
  return token;
}

export interface LinearTransportOptions {
  token?: string;
  /**
   * Authorization header style. "raw" (the default) sends the token verbatim — the
   * personal-API-key read path Linear expects. "bearer" sends `Bearer <token>`, the
   * form required for OAuth client_credentials access tokens (the write/comment path).
   * Defaulting to "raw" keeps the existing read path byte-for-byte unchanged.
   */
  auth?: "raw" | "bearer";
  endpoint?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const LINEAR_OAUTH_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse reset timestamp from rate-limit headers (may be ms or sec epoch).
function parseResetHeader(headers: Headers): number | undefined {
  const raw = headers.get("x-ratelimit-requests-reset") ?? headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!isFinite(value)) return undefined;
  // If the value is less than 1e10, it's likely seconds; convert to ms.
  return value < 1e10 ? value * 1000 : value;
}

function joinErrors(errors: unknown[]): string {
  return errors
    .map((e) =>
      typeof e === "object" && e !== null && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e),
    )
    .join("; ");
}

function extractErrorCode(errors: unknown[]): string | undefined {
  const first = errors[0];
  if (typeof first !== "object" || first === null) return undefined;
  const ext = (first as Record<string, unknown>)["extensions"];
  if (typeof ext !== "object" || ext === null) return undefined;
  const code = (ext as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}

function networkErrorMessage(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return error.message;
  const code = (cause as Record<string, unknown>)["code"];
  return typeof code === "string" && code.length > 0 ? `${error.message}: ${code}` : error.message;
}

// Build a LinearRequestError options object omitting undefined fields to satisfy
// exactOptionalPropertyTypes — assigning `undefined` to an optional prop is forbidden.
function makeErrOpts(
  status: number | undefined,
  code: string | undefined,
  resetAtMs: number | undefined,
): { status?: number; code?: string; resetAtMs?: number } {
  const opts: { status?: number; code?: string; resetAtMs?: number } = {};
  if (status !== undefined) opts.status = status;
  if (code !== undefined) opts.code = code;
  if (resetAtMs !== undefined) opts.resetAtMs = resetAtMs;
  return opts;
}

export function createLinearTransport(options?: LinearTransportOptions): LinearTransport {
  const resolveOpts: ResolveTokenOptions = {};
  if (options?.token !== undefined) resolveOpts.token = options.token;
  const token = resolveLinearToken(resolveOpts);
  // Compute the Authorization header value once; reused on every retry attempt.
  // Bearer for OAuth access tokens, raw token for the personal-key read path (default).
  const authHeader = options?.auth === "bearer" ? `Bearer ${token}` : token;
  const endpoint = options?.endpoint ?? LINEAR_ENDPOINT;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxRetries = options?.maxRetries ?? 5;
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? (() => Date.now());

  return async function linearTransport(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    let attempt = 0;
    const isMutation = /^\s*mutation\b/i.test(query);

    while (true) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (networkError) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        const linearErr = new LinearRequestError(networkErrorMessage(err));
        if (!isMutation && attempt < maxRetries && shouldRetryLinear(linearErr)) {
          const kind = linearRetryKind(linearErr);
          await sleep(linearRetryWaitMs(kind, attempt, undefined, now()));
          attempt++;
          continue;
        }
        throw linearErr;
      }

      if (!response.ok) {
        let body: Record<string, unknown> = {};
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          // best effort; keep empty body
        }
        const errors = Array.isArray(body["errors"]) ? (body["errors"] as unknown[]) : [];
        const message =
          errors.length > 0
            ? joinErrors(errors)
            : typeof body["message"] === "string"
              ? body["message"]
              : `Linear API error: HTTP ${response.status}`;
        const ext = body["extensions"];
        const topLevelCode =
          typeof ext === "object" && ext !== null && "code" in ext
            ? String((ext as Record<string, unknown>)["code"])
            : undefined;
        const code = extractErrorCode(errors) ?? topLevelCode;
        const resetAtMs = parseResetHeader(response.headers);
        const err = new LinearRequestError(message, makeErrOpts(response.status, code, resetAtMs));
        if (!isMutation && attempt < maxRetries && shouldRetryLinear(err)) {
          const kind = linearRetryKind(err);
          await sleep(linearRetryWaitMs(kind, attempt, resetAtMs, now()));
          attempt++;
          continue;
        }
        throw err;
      }

      const body = (await response.json()) as Record<string, unknown>;

      if (Array.isArray(body["errors"]) && body["errors"].length > 0) {
        const errors = body["errors"] as unknown[];
        const message = joinErrors(errors);
        const code = extractErrorCode(errors);
        const resetAtMs = parseResetHeader(response.headers);
        const err = new LinearRequestError(message, makeErrOpts(response.status, code, resetAtMs));
        if (!isMutation && attempt < maxRetries && shouldRetryLinear(err)) {
          const kind = linearRetryKind(err);
          await sleep(linearRetryWaitMs(kind, attempt, resetAtMs, now()));
          attempt++;
          continue;
        }
        throw err;
      }

      return body["data"];
    }
  };
}

/** Options for minting an OAuth client_credentials access token. */
export interface MintAppTokenOptions {
  clientId: string;
  clientSecret: string;
  scope?: string; // default "read,write"
  endpoint?: string; // default https://api.linear.app/oauth/token
  fetchImpl?: typeof fetch;
}

/** The result of a successful mint. Carries no secret — only the access token + lifetime. */
export interface MintedAppToken {
  accessToken: string;
  expiresInSec: number;
  tokenType: string; // typically "Bearer"
}

/**
 * Mints a Linear OAuth access token via the client_credentials grant (actor=app).
 *
 * This is a one-shot urlencoded POST to the OAuth token endpoint — NOT a GraphQL call,
 * so it deliberately does not route through createLinearTransport. The returned access
 * token is used with `createLinearTransport({ token, auth: "bearer" })` for writes.
 *
 * Secret hygiene: clientId, clientSecret, and the minted accessToken are NEVER logged,
 * stringified into errors, or otherwise surfaced. Error messages carry only the HTTP
 * status / OAuth error code, never the credentials or token.
 */
export async function mintLinearAppToken(options: MintAppTokenOptions): Promise<MintedAppToken> {
  const { clientId, clientSecret } = options;
  if (!clientId || !clientSecret) {
    throw new Error("mintLinearAppToken requires both clientId and clientSecret");
  }
  const endpoint = options.endpoint ?? LINEAR_OAUTH_TOKEN_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const scope = options.scope ?? "read,write";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  }).toString();

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    // best effort; keep empty so the error below stays token-free
  }

  if (!response.ok) {
    const code = typeof parsed["error"] === "string" ? String(parsed["error"]) : undefined;
    const detail = code ? `: ${code}` : "";
    throw new LinearRequestError(
      `Linear OAuth token mint failed (HTTP ${response.status})${detail}`,
      makeErrOpts(response.status, code, undefined),
    );
  }

  const accessToken = parsed["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Linear OAuth token mint returned no access_token");
  }
  const expiresInSec = typeof parsed["expires_in"] === "number" ? parsed["expires_in"] : 0;
  const tokenType = typeof parsed["token_type"] === "string" ? parsed["token_type"] : "Bearer";

  return { accessToken, expiresInSec, tokenType };
}
