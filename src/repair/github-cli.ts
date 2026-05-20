import type { JsonValue } from "./json-types.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { stripAnsi } from "./comment-router-utils.js";
import { ghCliEnv } from "./process-env.js";
import { repoRoot } from "./paths.js";

const execFileAsync = promisify(execFile);

export type GhRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
};

export type GhRetryOptions = GhRunOptions & {
  attempts?: number;
};

export function ghJson<T = JsonValue>(ghArgs: string[], options: GhRunOptions = {}): T {
  return JSON.parse(ghText(ghArgs, options) || "null") as T;
}

export function ghJsonWithRetry<T = JsonValue>(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): T {
  return JSON.parse(ghTextWithRetry(ghArgs, options) || "null") as T;
}

export async function ghJsonWithRetryAsync<T = JsonValue>(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): Promise<T> {
  return JSON.parse((await ghTextWithRetryAsync(ghArgs, options)) || "null") as T;
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
      if (attempt >= attempts || !shouldRetryGh(error)) throw error;
      sleepMs(Math.min(1000 * attempt, 5000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function ghText(ghArgs: string[], options: GhRunOptions = {}): string {
  const text = execFileSync("gh", ghArgs, {
    cwd: options.cwd ?? repoRoot(),
    env: ghEnv(options.env),
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
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return ghText(ghArgs, resolved);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryGh(error)) throw error;
      sleepMs(Math.min(1000 * attempt, 5000));
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
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ghTextAsync(ghArgs, resolved);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryGh(error)) throw error;
      await sleepAsync(Math.min(1000 * attempt, 5000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ghTextAsync(ghArgs: string[], options: GhRunOptions = {}): Promise<string> {
  if (options.input !== undefined) return ghText(ghArgs, options);
  const { stdout } = await execFileAsync("gh", ghArgs, {
    cwd: options.cwd ?? repoRoot(),
    env: ghEnv(options.env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stripAnsi(String(stdout)).trim();
}

export function ghBestEffort(ghArgs: string[], options: GhRunOptions = {}): void {
  try {
    ghText(ghArgs, options);
  } catch {
    // Helpful metadata should not block the primary command path.
  }
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
  return spawnSync("gh", ghArgs, {
    cwd: options.cwd ?? repoRoot(),
    encoding: "utf8",
    env: ghEnv(options.env),
    input: options.input,
    stdio: "pipe",
  });
}

export function ghEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return ghCliEnv(overrides);
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

export function shouldRetryGh(error: unknown): boolean {
  const text = ghErrorText(error).toLowerCase();
  return (
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504") ||
    text.includes("bad gateway") ||
    text.includes("gateway timeout") ||
    text.includes("service unavailable") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("connection reset") ||
    text.includes("connection refused") ||
    text.includes("could not resolve host") ||
    text.includes("temporary failure") ||
    text.includes("try again later") ||
    text.includes("secondary rate limit") ||
    text.includes("rate limit")
  );
}

function resolveRetryOptions(options: GhRetryOptions | number): GhRetryOptions {
  if (typeof options === "number") return { attempts: options };
  return options;
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
