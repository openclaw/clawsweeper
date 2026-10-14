import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./value-coerce.js";
import type { ReviewUsageRecord } from "./review-usage-contract.js";

export type ReviewTokenUsage = NonNullable<ReviewUsageRecord["usage"]>;
const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const TOKEN_COUNT_MARKER = Buffer.from('"token_count"');

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseReviewTokenUsage(value: unknown): ReviewTokenUsage | null {
  if (!isRecord(value)) return null;
  const {
    input_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    output_tokens,
    reasoning_output_tokens,
  } = value;
  if (
    !tokenCount(input_tokens) ||
    !tokenCount(cached_input_tokens) ||
    !tokenCount(cache_write_input_tokens) ||
    !tokenCount(output_tokens) ||
    !tokenCount(reasoning_output_tokens)
  )
    return null;
  return {
    input_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    output_tokens,
    reasoning_output_tokens,
  };
}

function* rolloutFiles(directory: string, depth = 0): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth < 3) yield* rolloutFiles(path, depth + 1);
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) yield path;
  }
}

/** Search from the tail: unrelated large tool events need no JSON decoding. */
function lastRolloutUsage(file: number, size: number): ReviewTokenUsage | null {
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  let position = size;
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  const inspectLine = (): ReviewTokenUsage | null | undefined => {
    const line =
      fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments.reverse(), lineBytes);
    fragments = [];
    lineBytes = 0;
    if (!line.includes(TOKEN_COUNT_MARKER)) return undefined;
    let event: unknown;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      return null;
    }
    if (
      !isRecord(event) ||
      event.type !== "event_msg" ||
      !isRecord(event.payload) ||
      event.payload.type !== "token_count" ||
      event.payload.info == null
    )
      return undefined;
    return isRecord(event.payload.info)
      ? parseReviewTokenUsage(event.payload.info.total_token_usage)
      : null;
  };
  while (position > 0) {
    const length = Math.min(buffer.length, position);
    position -= length;
    let filled = 0;
    while (filled < length) {
      const bytes = readSync(file, buffer, filled, length - filled, position + filled);
      if (!bytes) return null;
      filled += bytes;
    }
    let end = length;
    for (let index = length - 1; index >= 0; index -= 1) {
      if (buffer[index] !== 0x0a) continue;
      if (end > index + 1) {
        fragments.push(Buffer.from(buffer.subarray(index + 1, end)));
        lineBytes += end - index - 1;
      }
      const usage = inspectLine();
      if (usage !== undefined) return usage;
      end = index;
    }
    if (end > 0) {
      fragments.push(Buffer.from(buffer.subarray(0, end)));
      lineBytes += end;
    }
  }
  return inspectLine() ?? null;
}

/** Last cumulative total per session, summed only across this review's files. */
export function readReviewRolloutUsage(options: {
  codexHome: string | undefined;
  startedAt: number;
  finishedAt: number;
}): ReviewTokenUsage | null {
  try {
    if (!options.codexHome) return null;
    let total: ReviewTokenUsage | null = null;
    for (const path of rolloutFiles(join(options.codexHome, "sessions"))) {
      const before = lstatSync(path);
      const modifiedAt = Math.floor(before.mtimeMs);
      if (modifiedAt < options.startedAt || modifiedAt > options.finishedAt) continue;
      if (!before.isFile() || before.size > MAX_ROLLOUT_BYTES || before.size === 0) return null;
      const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let latest: ReviewTokenUsage | null;
      try {
        const opened = fstatSync(file);
        if (
          opened.ino !== before.ino ||
          opened.dev !== before.dev ||
          opened.size !== before.size ||
          opened.mtimeMs !== before.mtimeMs
        )
          return null;
        latest = lastRolloutUsage(file, before.size);
        const after = fstatSync(file);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || !latest) return null;
      } finally {
        closeSync(file);
      }
      total = total ? sumReviewTokenUsage([total, latest]) : latest;
    }
    return total && Object.values(total).every(tokenCount) ? total : null;
  } catch {
    // Missing, unreadable, or incomplete files cannot yield a trustworthy sum.
    return null;
  }
}

export function sumReviewTokenUsage(usages: readonly ReviewTokenUsage[]): ReviewTokenUsage {
  const total: ReviewTokenUsage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  for (const usage of usages) for (const field of TOKEN_FIELDS) total[field] += usage[field];
  return total;
}

/** Complete the local handoff before callers can terminate the review process. */
export function appendReviewUsage(options: {
  record: Omit<ReviewUsageRecord, "schema" | "run_id" | "run_attempt" | "usage">;
  codexHome: string | undefined;
  startedAt: number;
  finishedAt: number;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    const env = options.env ?? process.env;
    const path = env.CLAWSWEEPER_REVIEW_USAGE_PATH;
    if (!path) return;
    const record: ReviewUsageRecord = {
      ...options.record,
      schema: 1,
      run_id: env.GITHUB_RUN_ID ?? "",
      run_attempt: Number(env.GITHUB_RUN_ATTEMPT ?? "1"),
      usage: readReviewRolloutUsage(options),
    };
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > 16 * 1024) throw new Error("Usage line exceeds handoff budget");
    const file = openSync(
      path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const metadata = fstatSync(file);
      if (!metadata.isFile() || metadata.size + bytes > 1024 * 1024) {
        throw new Error("Usage file exceeds handoff budget");
      }
      appendFileSync(file, line, "utf8");
    } finally {
      closeSync(file);
    }
  } catch {
    console.error("[review-usage] best-effort local handoff unavailable");
  }
}
