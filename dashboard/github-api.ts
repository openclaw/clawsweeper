import {
  githubResponseRateLimitHint,
  githubResponseRateLimited,
  type GitHubRateLimitHint,
} from "../src/hosted-target-admission.ts";

export {
  githubResponseRateLimitHint,
  githubResponseRateLimited,
  type GitHubRateLimitHint,
} from "../src/hosted-target-admission.ts";

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

const GITHUB_APP_TIMEOUT_MS = 4500;
const workerTransportErrors = new WeakMap<GitHubRequestError, unknown>();

type GithubApiEnv = Record<string, unknown>;

export type GithubAppJsonOptions = { method?: string; body?: BodyInit; errorLabel?: string };
export type GitHubRequestValidationDetail = {
  validationFields: string[];
  validationCodes: string[];
};
export class GitHubRequestError extends Error {
  readonly status?: number | undefined;
  readonly timedOut: boolean;
  readonly rateLimited: boolean;
  readonly validationDetail?: GitHubRequestValidationDetail | undefined;
  readonly rateLimitHint?: GitHubRateLimitHint | undefined;

  constructor(
    message: string,
    status?: number,
    timedOut = false,
    rateLimited = false,
    validationDetail?: GitHubRequestValidationDetail,
    rateLimitHint?: GitHubRateLimitHint,
  ) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
    this.timedOut = timedOut;
    this.rateLimited = rateLimited;
    this.validationDetail = validationDetail;
    this.rateLimitHint = rateLimitHint;
  }
}

export function githubApiBaseUrl(env: GithubApiEnv = {}): string {
  const configured = env.GITHUB_API_URL;
  if (configured === undefined || configured === null || configured === "") {
    return DEFAULT_GITHUB_API_URL;
  }
  if (typeof configured !== "string") throw invalidGithubApiUrl();

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalidGithubApiUrl();
  }
  const isDefaultGithubOrigin = configured === DEFAULT_GITHUB_API_URL;
  const isLoopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    Boolean(url.port);
  if (
    (!isDefaultGithubOrigin && !isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== configured
  ) {
    throw invalidGithubApiUrl();
  }
  return url.origin;
}

export function githubApiUrl(env: GithubApiEnv, path: string): string {
  const normalizedPath = String(path);
  if (!normalizedPath.startsWith("/")) throw new Error("GitHub API path must start with /");
  return `${githubApiBaseUrl(env)}${normalizedPath}`;
}

function invalidGithubApiUrl(): Error {
  return new Error(
    "invalid GITHUB_API_URL: expected https://api.github.com or an http://127.0.0.1:<port> / http://localhost:<port> origin",
  );
}

export function githubAppCredentials(env: GithubApiEnv) {
  const issuer = stringEnv(env.CLAWSWEEPER_APP_ID) || stringEnv(env.CLAWSWEEPER_APP_CLIENT_ID);
  const privateKey = normalizePrivateKey(env.CLAWSWEEPER_APP_PRIVATE_KEY);
  if (!issuer || !privateKey) return null;
  return {
    issuer,
    privateKey,
    installationId: stringEnv(env.CLAWSWEEPER_APP_INSTALLATION_ID),
  };
}

export async function githubAppInstallationId(
  appJwt: string,
  repo: string,
  env: GithubApiEnv = {},
) {
  if (!repo || !repo.includes("/")) throw new Error("GitHub App installation repo is required");
  const payload = await githubAppJson(
    `/repos/${repo}/installation`,
    appJwt,
    { errorLabel: "GitHub App installation" },
    env,
  );
  const installationId = Number(payload.id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`GitHub App installation response missing id for ${repo}`);
  }
  return String(installationId);
}

export async function githubAppInstallationIdAsPlainError(
  appJwt: string,
  repo: string,
  env: GithubApiEnv = {},
) {
  try {
    return await githubAppInstallationId(appJwt, repo, env);
  } catch (error) {
    throwPlainGitHubRequestError(error);
  }
}

export async function githubAppJson(
  path: string,
  appJwt: string,
  options: GithubAppJsonOptions = {},
  env: GithubApiEnv = {},
) {
  const signal = AbortSignal.timeout(GITHUB_APP_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetch(githubApiUrl(env, path), {
      method: options.method || "GET",
      signal,
      cache: "no-store",
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "User-Agent": "openclaw-clawsweeper-status",
        Authorization: `Bearer ${appJwt}`,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    text = await response.text().catch((error) => {
      if (response.ok) throw error;
      return "";
    });
  } catch (error) {
    const timedOut =
      signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || error.message === "timeout"));
    const requestError = new GitHubRequestError(
      `${options.errorLabel || "GitHub App"} ${timedOut ? "timed out" : "network failure"}`,
      undefined,
      timedOut,
    );
    if (!signal.aborted) workerTransportErrors.set(requestError, error);
    throw requestError;
  }
  if (!response.ok) {
    const rateLimited = githubResponseRateLimited(response, text);
    throw new GitHubRequestError(
      `${options.errorLabel || "GitHub App"} ${response.status}`,
      response.status,
      false,
      rateLimited,
      githubResponseValidationDetail(response.status, text),
      rateLimited ? githubResponseRateLimitHint(response, Date.now()) : undefined,
    );
  }
  return JSON.parse(text);
}

export async function createGithubAppTokenFor({
  env = {},
  appJwt,
  installationId,
  label,
  repositories,
  permissions,
}: {
  env?: GithubApiEnv;
  appJwt: string;
  installationId: string | number;
  label: string;
  repositories?: string[];
  permissions: Record<string, string>;
}) {
  const payload = await githubAppJson(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: "POST",
      body: JSON.stringify({
        ...(repositories ? { repositories: repositories.filter(Boolean) } : {}),
        permissions,
      }),
      errorLabel: `GitHub App token for ${label}`,
    },
    env,
  );
  const token = String(payload.token || "");
  if (!token) throw new Error(`GitHub App token response missing token for ${label}`);
  return token;
}

export async function githubAppJsonAsPlainError(
  path: string,
  appJwt: string,
  options: GithubAppJsonOptions = {},
  env: GithubApiEnv = {},
) {
  try {
    return await githubAppJson(path, appJwt, options, env);
  } catch (error) {
    throwPlainGitHubRequestError(error);
  }
}

function throwPlainGitHubRequestError(error: unknown): never {
  if (error instanceof GitHubRequestError) {
    if (workerTransportErrors.has(error)) throw workerTransportErrors.get(error);
    throw new Error(error.message);
  }
  throw error;
}

export function githubResponseValidationDetail(status: number, text: string) {
  if (status !== 422 || text.length > 16_384) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = objectValue(payload);
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const validationFields = new Set<string>();
  const validationCodes = new Set<string>();
  for (const error of errors.slice(0, 8)) {
    const value = objectValue(error);
    const field = githubValidationToken(value.field);
    const code = githubValidationToken(value.code);
    if (field) validationFields.add(field);
    if (code) validationCodes.add(code);
  }
  if (!validationFields.size && !validationCodes.size) return undefined;
  return {
    validationFields: [...validationFields].sort().slice(0, 4),
    validationCodes: [...validationCodes].sort().slice(0, 4),
  };
}

function githubValidationToken(value: unknown) {
  const token =
    String(value || "")
      .match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0]
      ?.toLowerCase() || "";
  return token.length <= 64 ? token : "";
}

export async function signGithubAppJwt(issuer: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }));
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export function normalizePrivateKey(value: unknown) {
  return stringEnv(value)?.replace(/\\n/g, "\n") || "";
}

export function pemToPkcs8(pem: string) {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  if (!pkcs1) throw new Error("GitHub App private key must be PEM encoded");
  return wrapPkcs1PrivateKey(pkcs1);
}

export function pemBody(pem: string, label: string) {
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "m");
  const match = String(pem).match(pattern);
  if (!match) return null;
  const encoded = match[1];
  if (!encoded) return null;
  const binary = atob(encoded.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function wrapPkcs1PrivateKey(pkcs1: Uint8Array) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetString = derElement(0x04, pkcs1);
  return derElement(0x30, concatBytes(version, algorithm, octetString));
}

export function derElement(tag: number, value: Uint8Array) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

export function derLength(length: number) {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function concatBytes(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function base64UrlEncode(value: string | Uint8Array | ArrayBuffer) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringEnv(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : "";
}
