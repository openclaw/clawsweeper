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
  endpoint?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

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
  const endpoint = options?.endpoint ?? LINEAR_ENDPOINT;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxRetries = options?.maxRetries ?? 5;
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? (() => Date.now());

  return async function linearTransport(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    if (/^\s*mutation\b/i.test(query)) {
      throw new Error("Linear transport is read-only; GraphQL mutations are disabled");
    }
    let attempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (networkError) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        const linearErr = new LinearRequestError(networkErrorMessage(err));
        if (attempt < maxRetries && shouldRetryLinear(linearErr)) {
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
        if (attempt < maxRetries && shouldRetryLinear(err)) {
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
        if (attempt < maxRetries && shouldRetryLinear(err)) {
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
