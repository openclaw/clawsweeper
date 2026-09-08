import type { JsonValue } from "./json-types.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { stripAnsi } from "./comment-router-utils.js";
import { ghCliEnv as ghEnv } from "./process-env.js";
import { repoRoot } from "./paths.js";
import { GitHubRateLimitError, ghRetryKind, ghRetryWaitMs } from "../github-retry.js";
import { parseGhJsonWithRetry, parseGhJsonWithRetryAsync } from "../github-json.js";
import { isPublicOpenClawReadOnlyRequest } from "../github-public-read.js";
import { resolveCommand } from "../command.js";

const execFileAsync = promisify(execFile);

export type GhRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
};

export type GhRetryOptions = GhRunOptions & {
  attempts?: number;
};

type PublicReadFallback = {
  appToken: string;
  options: GhRunOptions;
};

const claimedPublicReadFallbackTokens = new Set<string>();

export function ghJson<T = JsonValue>(ghArgs: string[], options: GhRunOptions = {}): T {
  return JSON.parse(ghText(ghArgs, options) || "null") as T;
}

export function ghJsonWithRetry<T = JsonValue>(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): T {
  return parseGhJsonWithRetry<T>(() => ghTextWithRetry(ghArgs, options) || "null", ghArgs, {
    onRetry: (_error, attempt) => sleepMs(ghRetryWaitMs("transient", attempt - 1)),
  });
}

export async function ghJsonWithRetryAsync<T = JsonValue>(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): Promise<T> {
  return parseGhJsonWithRetryAsync<T>(
    async () => (await ghTextWithRetryAsync(ghArgs, options)) || "null",
    ghArgs,
    {
      onRetry: (_error, attempt) => sleepAsync(ghRetryWaitMs("transient", attempt - 1)),
    },
  );
}

export function ghJsonBestEffort<T = JsonValue>(
  ghArgs: string[],
  fallback: T,
  options: GhRunOptions = {},
): T {
  try {
    return ghJson<T>(ghArgs, options);
  } catch {
    return fallback;
  }
}

export function githubPaginatedPath(apiPath: string): string {
  return githubPathWithQueryDefaults(apiPath, { per_page: "100" });
}

export function githubLimitedPagePath(apiPath: string, limit: number, page = 1): string {
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const normalizedPage = Number.isFinite(page) ? Math.floor(page) : 1;
  const pageSize = Math.max(1, Math.min(100, normalizedLimit));
  const pageNumber = Math.max(1, normalizedPage);
  return githubPathWithQueryDefaults(
    apiPath,
    { per_page: String(pageSize), page: String(pageNumber) },
    { override: true },
  );
}

export function ghPaged<T = JsonValue>(apiPath: string, options: GhRunOptions = {}): T[] {
  const pages = ghJson<JsonValue[]>(
    ["api", githubPaginatedPath(apiPath), "--paginate", "--slurp"],
    options,
  );
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: JsonValue) => (Array.isArray(page) ? (page as T[]) : []));
}

export function ghPagedWithRetry<T = JsonValue>(
  apiPath: string,
  options: GhRetryOptions | number = {},
): T[] {
  const pages = ghJsonWithRetry<JsonValue[]>(
    ["api", githubPaginatedPath(apiPath), "--paginate", "--slurp"],
    options,
  );
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: JsonValue) => (Array.isArray(page) ? (page as T[]) : []));
}

export async function ghPagedWithRetryAsync<T = JsonValue>(
  apiPath: string,
  options: GhRetryOptions | number = {},
): Promise<T[]> {
  const pages = await ghJsonWithRetryAsync<JsonValue[]>(
    ["api", githubPaginatedPath(apiPath), "--paginate", "--slurp"],
    options,
  );
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: JsonValue) => (Array.isArray(page) ? (page as T[]) : []));
}

export function ghPagedLimit<T = JsonValue>(
  apiPath: string,
  limit: number,
  options: GhRunOptions = {},
): T[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (max <= 0) return [];

  const perPage = Math.min(100, max);
  const out: T[] = [];
  for (let page = 1; out.length < max; page += 1) {
    const entries = ghJson<JsonValue[]>(
      ["api", githubLimitedPagePath(apiPath, perPage, page)],
      options,
    );
    if (!Array.isArray(entries) || entries.length === 0) break;
    out.push(...(entries as T[]));
    if (entries.length < perPage) break;
  }
  return out.slice(0, max);
}

export function ghPagedLimitWithRetry<T = JsonValue>(
  apiPath: string,
  limit: number,
  options: GhRetryOptions | number = {},
): T[] {
  const resolved = resolveRetryOptions(options);
  const attempts = Math.max(1, resolved.attempts ?? 6);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return ghPagedLimit<T>(apiPath, limit, resolved);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (retryKind === "throttle") throw new GitHubRateLimitError(error);
      if (attempt >= attempts || retryKind === "none") throw error;
      sleepMs(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function ghText(ghArgs: string[], options: GhRunOptions = {}): string {
  const env = ghCommandEnv(ghArgs, options);
  const command = ghCommand(ghArgs, env);
  const text = execFileSync(command.command, command.args, {
    cwd: options.cwd ?? repoRoot(),
    timeout: ghRunTimeoutMs(options, env),
    env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stripAnsi(text).trim();
}

export function ghTextWithRetry(ghArgs: string[], options: GhRetryOptions | number = {}): string {
  const resolved = resolveRetryOptions(options);
  const attempts = Math.max(1, resolved.attempts ?? 6);
  let activeOptions: GhRunOptions = resolved;
  const publicReadFallback = publicReadFallbackOptions(ghArgs, resolved);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return ghText(ghArgs, activeOptions);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      const fallback =
        retryKind === "throttle" ? claimPublicReadFallback(publicReadFallback) : null;
      if (retryKind === "throttle" && fallback) {
        activeOptions = fallback;
        try {
          return ghText(ghArgs, fallback);
        } catch (fallbackError) {
          lastError = fallbackError;
          const fallbackRetryKind = ghRetryKind(fallbackError);
          if (fallbackRetryKind === "throttle") {
            throw new GitHubRateLimitError(fallbackError);
          }
          if (attempt >= attempts || fallbackRetryKind === "none") throw fallbackError;
          sleepMs(ghRetryWaitMs(fallbackRetryKind, attempt - 1));
          continue;
        }
      }
      if (retryKind === "throttle") throw new GitHubRateLimitError(error);
      if (attempt >= attempts || retryKind === "none") throw error;
      sleepMs(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ghTextWithRetryAsync(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): Promise<string> {
  const resolved = resolveRetryOptions(options);
  const attempts = Math.max(1, resolved.attempts ?? 6);
  let activeOptions: GhRunOptions = resolved;
  const publicReadFallback = publicReadFallbackOptions(ghArgs, resolved);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ghTextAsync(ghArgs, activeOptions);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      const fallback =
        retryKind === "throttle" ? claimPublicReadFallback(publicReadFallback) : null;
      if (retryKind === "throttle" && fallback) {
        activeOptions = fallback;
        try {
          return await ghTextAsync(ghArgs, fallback);
        } catch (fallbackError) {
          lastError = fallbackError;
          const fallbackRetryKind = ghRetryKind(fallbackError);
          if (fallbackRetryKind === "throttle") {
            throw new GitHubRateLimitError(fallbackError);
          }
          if (attempt >= attempts || fallbackRetryKind === "none") throw fallbackError;
          await sleepAsync(ghRetryWaitMs(fallbackRetryKind, attempt - 1));
          continue;
        }
      }
      if (retryKind === "throttle") throw new GitHubRateLimitError(error);
      if (attempt >= attempts || retryKind === "none") throw error;
      await sleepAsync(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ghTextAsync(ghArgs: string[], options: GhRunOptions = {}): Promise<string> {
  if (options.input !== undefined) return ghText(ghArgs, options);
  const env = ghCommandEnv(ghArgs, options);
  const command = ghCommand(ghArgs, env);
  const { stdout } = await execFileAsync(command.command, command.args, {
    cwd: options.cwd ?? repoRoot(),
    timeout: ghRunTimeoutMs(options, env),
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stripAnsi(String(stdout)).trim();
}

export function ghBestEffortWithRetry(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): string {
  try {
    return ghTextWithRetry(ghArgs, options);
  } catch {
    return "";
  }
}

export function ghSpawn(ghArgs: string[], options: GhRunOptions = {}) {
  const env = ghEnv(options.env);
  const command = ghCommand(ghArgs, env);
  return spawnSync(command.command, command.args, {
    cwd: options.cwd ?? repoRoot(),
    timeout: ghRunTimeoutMs(options, env),
    encoding: "utf8",
    env,
    input: options.input,
    stdio: "pipe",
  });
}

function ghCommandEnv(ghArgs: readonly string[], options: GhRunOptions): NodeJS.ProcessEnv {
  const overrides = options.env ?? {};
  const env = ghEnv(overrides);
  const publicToken = publicReadToken(ghArgs, options, env);
  if (!publicToken) return env;
  return ghEnv({ ...overrides, GH_TOKEN: publicToken });
}

function publicReadToken(
  ghArgs: readonly string[],
  options: GhRunOptions,
  env = ghEnv(options.env ?? {}),
): string | null {
  const overrides = options.env ?? {};
  const publicToken = process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN?.trim();
  if (
    !publicToken ||
    options.input !== undefined ||
    Object.hasOwn(overrides, "GH_TOKEN") ||
    Object.hasOwn(overrides, "GITHUB_TOKEN") ||
    (env.GH_HOST && env.GH_HOST.toLowerCase() !== "github.com") ||
    !isPublicOpenClawReadOnlyRequest(ghArgs)
  ) {
    return null;
  }
  return publicToken;
}

function publicReadFallbackOptions(
  ghArgs: readonly string[],
  options: GhRunOptions,
): PublicReadFallback | null {
  const overrides = options.env ?? {};
  const publicToken = publicReadToken(ghArgs, options);
  const appToken = process.env.GH_TOKEN?.trim();
  if (!publicToken || !appToken || publicToken === appToken) {
    return null;
  }
  return {
    appToken,
    options: { ...options, env: { ...overrides, GH_TOKEN: appToken } },
  };
}

function claimPublicReadFallback(fallback: PublicReadFallback | null): GhRunOptions | null {
  if (!fallback || claimedPublicReadFallbackTokens.has(fallback.appToken)) return null;
  claimedPublicReadFallbackTokens.add(fallback.appToken);
  return fallback.options;
}

export function ghErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const commandError = error as {
    message?: string;
    output?: unknown[];
    stderr?: Buffer | string;
    stdout?: Buffer | string;
  };
  const parts = [
    commandError.stderr,
    commandError.stdout,
    ...(Array.isArray(commandError.output) ? commandError.output : []),
    commandError.message,
  ].filter(Boolean);
  return stripAnsi(parts.map((part) => bufferLikeToString(part)).join("\n")).trim();
}

export function ghStdoutFromError(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const commandError = error as {
    output?: unknown[];
    stdout?: Buffer | string;
  };
  return stripAnsi(
    bufferLikeToString(commandError.stdout ?? commandError.output?.[1] ?? ""),
  ).trim();
}

function ghRunTimeoutMs(options: GhRunOptions, env: NodeJS.ProcessEnv): number {
  if (
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
  ) {
    return Math.max(1, Math.floor(options.timeoutMs));
  }
  const configured = Number(
    env.CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS ?? env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS,
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.max(30_000, Math.floor(configured))
    : 120_000;
}

function resolveRetryOptions(options: GhRetryOptions | number): GhRetryOptions {
  if (typeof options === "number") return { attempts: options };
  if (options.attempts !== undefined) return options;
  const configuredValue =
    options.env?.CLAWSWEEPER_GH_RETRY_ATTEMPTS ?? process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configuredValue == null || configuredValue.trim() === "") return options;
  const configuredAttempts = Number(configuredValue);
  if (!Number.isFinite(configuredAttempts)) return options;
  return { ...options, attempts: Math.max(1, Math.floor(configuredAttempts)) };
}

function ghCommand(
  ghArgs: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  return resolveCommand("gh", ghArgs, env);
}

function githubPathWithQueryDefaults(
  apiPath: string,
  defaults: Record<string, string>,
  { override = false }: { override?: boolean } = {},
): string {
  const [basePart, query = ""] = apiPath.split("?", 2);
  const base = basePart ?? apiPath;
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(defaults)) {
    if (override || !params.has(key)) params.set(key, value);
  }
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function bufferLikeToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
