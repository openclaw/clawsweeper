import { summarizeGhArgs } from "./github-retry.js";

export class GhJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhJsonParseError";
  }
}

export function parseGhJson<T>(text: string, args: readonly string[]): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new GhJsonParseError(
      `Failed to parse JSON from ${summarizeGhArgs(args)}: ${formatParseError(error)}`,
    );
  }
}

export function parseGhJsonWithRetry<T>(
  load: () => string,
  args: readonly string[],
  options: {
    attempts?: number;
    onRetry?: (error: GhJsonParseError, attempt: number, attempts: number) => void;
  } = {},
): T {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: GhJsonParseError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return parseGhJson<T>(load(), args);
    } catch (error) {
      if (!(error instanceof GhJsonParseError) || attempt === attempts) throw error;
      lastError = error;
      options.onRetry?.(error, attempt, attempts);
    }
  }
  throw lastError;
}

export async function parseGhJsonWithRetryAsync<T>(
  load: () => Promise<string>,
  args: readonly string[],
  options: {
    attempts?: number;
    onRetry?: (error: GhJsonParseError, attempt: number, attempts: number) => void | Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: GhJsonParseError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return parseGhJson<T>(await load(), args);
    } catch (error) {
      if (!(error instanceof GhJsonParseError) || attempt === attempts) throw error;
      lastError = error;
      await options.onRetry?.(error, attempt, attempts);
    }
  }
  throw lastError;
}

export function parseGhJsonLines<T>(text: string, args: readonly string[]): T[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new GhJsonParseError(
          `Failed to parse JSON line ${index + 1} from ${summarizeGhArgs(args)}: ${formatParseError(error)}`,
        );
      }
    });
}

export function parseGhJsonLinesWithRetry<T>(
  load: () => string,
  args: readonly string[],
  options: {
    attempts?: number;
    onRetry?: (error: GhJsonParseError, attempt: number, attempts: number) => void;
  } = {},
): T[] {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: GhJsonParseError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return parseGhJsonLines<T>(load(), args);
    } catch (error) {
      if (!(error instanceof GhJsonParseError) || attempt === attempts) throw error;
      lastError = error;
      options.onRetry?.(error, attempt, attempts);
    }
  }
  throw lastError;
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
