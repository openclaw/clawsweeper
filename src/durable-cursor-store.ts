import { requireRecord as record, errorSummary as errorMessage } from "./value-coerce.js";
import { createHmac } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export interface DurableCursorSnapshot<Mode extends string = string> {
  mode: Mode;
  nextCursor: number;
  revision: number;
  updatedAt: string | null;
}

export type DurableCursorStoreOptions<Mode extends string = string> = {
  baseUrl: string;
  webhookSecret: string;
  mode: Mode;
  attempts?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export async function fetchDurableCursor<Mode extends string>(
  options: DurableCursorStoreOptions<Mode>,
): Promise<DurableCursorSnapshot<Mode>> {
  const payload = await durableCursorRequest(options, "GET", "");
  if (payload.mode !== options.mode) throw new Error("durable cursor response mode mismatch");
  return {
    mode: options.mode,
    nextCursor: nonNegativeNumber(payload.next_cursor, "durable cursor next_cursor"),
    revision: nonNegativeNumber(payload.revision, "durable cursor revision"),
    updatedAt:
      payload.updated_at === null || typeof payload.updated_at === "string"
        ? payload.updated_at
        : null,
  };
}

export async function putDurableCursor<Mode extends string>(
  options: DurableCursorStoreOptions<Mode>,
  nextCursor: number,
  expectedRevision: number,
): Promise<DurableCursorSnapshot<Mode>> {
  const body = JSON.stringify({
    next_cursor: nonNegativeNumber(nextCursor, "durable cursor next_cursor"),
    expected_revision: nonNegativeNumber(expectedRevision, "durable cursor expected_revision"),
  });
  const payload = await durableCursorRequest(options, "PUT", body);
  if (payload.mode !== options.mode) throw new Error("durable cursor response mode mismatch");
  return {
    mode: options.mode,
    nextCursor: nonNegativeNumber(payload.next_cursor, "durable cursor next_cursor"),
    revision: nonNegativeNumber(payload.revision, "durable cursor revision"),
    updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : null,
  };
}

async function durableCursorRequest<Mode extends string>(
  options: DurableCursorStoreOptions<Mode>,
  method: "GET" | "PUT",
  body: string,
): Promise<JsonRecord> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("durable cursor store URL must use HTTPS");
  if (!options.webhookSecret) throw new Error("durable cursor webhook secret is required");
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
  const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 3)));
  const request = options.fetchImpl ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastFailure = "durable cursor request failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const init: RequestInit = {
        method,
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        signal: AbortSignal.timeout(5_000),
      };
      if (method === "PUT") init.body = body;
      const response = await request(
        `${baseUrl}/internal/state/cursors/${encodeURIComponent(options.mode)}`,
        init,
      );
      const payload = record(await response.json().catch(() => ({})), "durable cursor response");
      if (response.ok && payload.ok === true) return payload;
      lastFailure =
        typeof payload.error === "string" && payload.error
          ? payload.error
          : `http_${response.status}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = errorMessage(error);
    }
    if (attempt < attempts) await sleep(attempt * 1_000);
  }
  throw new Error(`${method} durable cursor failed: ${lastFailure}`);
}

function nonNegativeNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}
