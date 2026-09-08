import {
  GITHUB_ETAG_CACHE_MAX_BODY_BYTES,
  githubEtagCacheKeyFromValue,
  type GithubEtagCacheKey,
} from "../src/github-etag-cache-contract.ts";
import { recordOrEmpty as objectValue } from "../src/value-coerce.ts";

export const GITHUB_ETAG_CACHE_TABLE = "github_etag_response_cache_v1";
export const GITHUB_ETAG_CACHE_MAX_ENTRIES = 2_048;
export { GITHUB_ETAG_CACHE_MAX_BODY_BYTES };
export const GITHUB_ETAG_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const METRICS_TABLE = "github_etag_response_cache_metrics_v1";
const CLEANUP_LIMIT = 128;
const CLEANUP_INTERVAL_MS = 60_000;
const ENTRY_COUNT_RECONCILE_STORES = 64;
const ETAG_MAX_LENGTH = 1_024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type SqlRow = Record<string, unknown>;
type GithubEtagStorage = {
  sql: { exec: (query: string, ...bindings: unknown[]) => Iterable<SqlRow> };
  transactionSync: <T>(callback: () => T) => T;
};

export type GithubEtagCacheLookup = {
  etag: string;
  bodyDigest: string;
  responseAt: number;
  validatedAt: number;
  expiresAt: number;
};

export class GithubEtagResponseStore {
  private readonly storage: GithubEtagStorage;
  private entryCount: number | null = null;
  private storesSinceCount = 0;
  private lastCleanupAt: number | null = null;

  constructor(storage: GithubEtagStorage) {
    this.storage = storage;
  }

  ensureSchemaSync(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${GITHUB_ETAG_CACHE_TABLE} (
         cache_key TEXT PRIMARY KEY,
         credential_pool TEXT NOT NULL,
         route TEXT NOT NULL,
         media_type TEXT NOT NULL,
         page INTEGER NOT NULL CHECK (page >= 1),
         etag TEXT NOT NULL,
         body TEXT NOT NULL,
         body_digest TEXT NOT NULL,
         body_bytes INTEGER NOT NULL CHECK (body_bytes >= 1),
         response_at INTEGER NOT NULL,
         validated_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS github_etag_response_cache_expiry_v1
         ON ${GITHUB_ETAG_CACHE_TABLE} (expires_at, validated_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (
         bucket_start INTEGER NOT NULL,
         credential_pool TEXT NOT NULL,
         outcome TEXT NOT NULL,
         count INTEGER NOT NULL CHECK (count >= 1),
         PRIMARY KEY (bucket_start, credential_pool, outcome)
       ) STRICT`,
    );
  }

  lookup(value: unknown, now: number): GithubEtagCacheLookup | null {
    const key = githubEtagCacheKeyFromValue(value);
    if (!key) return null;
    this.deleteExpiredSync(now);
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT etag, body_digest, response_at, validated_at, expires_at
           FROM ${GITHUB_ETAG_CACHE_TABLE}
          WHERE cache_key = ? AND expires_at > ?`,
        key.cacheKey,
        now,
      ),
    );
    this.recordMetricSync(now, key.credentialPool, row ? "cache_hit" : "cache_miss");
    return row
      ? {
          etag: String(row.etag),
          bodyDigest: String(row.body_digest),
          responseAt: Number(row.response_at),
          validatedAt: Number(row.validated_at),
          expiresAt: Number(row.expires_at),
        }
      : null;
  }

  async store200(
    value: unknown,
    now: number,
  ): Promise<
    | { ok: true; stored: true; entry: GithubEtagCacheLookup }
    | { ok: true; stored: false; reason: string }
    | { ok: false; error: string; status: number }
  > {
    const key = githubEtagCacheKeyFromValue(value);
    const body = objectValue(value);
    const etag = String(body.etag || "").trim();
    const responseBody = typeof body.body === "string" ? body.body : "";
    if (!key) return { ok: false, error: "invalid_github_etag_cache_key", status: 400 };
    if (
      !("body" in body) &&
      typeof body.body_bytes === "number" &&
      Number.isSafeInteger(body.body_bytes) &&
      body.body_bytes > GITHUB_ETAG_CACHE_MAX_BODY_BYTES
    ) {
      return this.skipped(key, now, "body_size_bound");
    }
    if (!validEtag(etag)) return this.skipped(key, now, "missing_or_invalid_etag");
    const encodedBody = new TextEncoder().encode(responseBody);
    const bodyBytes = encodedBody.byteLength;
    if (bodyBytes > GITHUB_ETAG_CACHE_MAX_BODY_BYTES) {
      return this.skipped(key, now, "body_size_bound");
    }
    if (!validJsonBody(responseBody)) return this.skipped(key, now, "invalid_json_body");
    const bodyDigest = await sha256Bytes(encodedBody);
    const expiresAt = now + GITHUB_ETAG_CACHE_RETENTION_MS;
    const lastCleanupAt = this.lastCleanupAt;
    try {
      this.storage.transactionSync(() => {
        this.deleteExpiredSync(now);
        const existing =
          this.entryCount !== null &&
          firstRow(
            this.storage.sql.exec(
              `SELECT 1 AS found FROM ${GITHUB_ETAG_CACHE_TABLE} WHERE cache_key = ?`,
              key.cacheKey,
            ),
          );
        this.storage.sql.exec(
          `INSERT INTO ${GITHUB_ETAG_CACHE_TABLE} (
           cache_key, credential_pool, route, media_type, page, etag, body,
           body_digest, body_bytes, response_at, validated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET
           etag = excluded.etag,
           body = excluded.body,
           body_digest = excluded.body_digest,
           body_bytes = excluded.body_bytes,
           response_at = excluded.response_at,
           validated_at = excluded.validated_at,
           expires_at = excluded.expires_at`,
          key.cacheKey,
          key.credentialPool,
          key.route,
          key.mediaType,
          key.page,
          etag,
          responseBody,
          bodyDigest,
          bodyBytes,
          now,
          now,
          expiresAt,
        );
        if (this.entryCount !== null && !existing) this.entryCount += 1;
        this.enforceEntryCapSync();
        this.recordMetricSync(now, key.credentialPool, "cache_200_stored");
      });
    } catch (error) {
      // SQLite rolls back housekeeping too; discard the in-memory count.
      this.entryCount = null;
      this.storesSinceCount = 0;
      this.lastCleanupAt = lastCleanupAt;
      throw error;
    }
    return {
      ok: true,
      stored: true,
      entry: { etag, bodyDigest, responseAt: now, validatedAt: now, expiresAt },
    };
  }

  confirm304(
    value: unknown,
    now: number,
  ):
    | { ok: true; confirmed: true; body: string; entry: GithubEtagCacheLookup }
    | { ok: true; confirmed: false; reason: string }
    | { ok: false; error: string; status: number } {
    const key = githubEtagCacheKeyFromValue(value);
    const body = objectValue(value);
    const etag = String(body.etag || "").trim();
    const bodyDigest = String(body.body_digest || "").trim();
    if (!key || !validEtag(etag) || !DIGEST_PATTERN.test(bodyDigest)) {
      return { ok: false, error: "invalid_github_etag_confirmation", status: 400 };
    }
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT etag, body, body_digest, response_at
           FROM ${GITHUB_ETAG_CACHE_TABLE}
          WHERE cache_key = ? AND expires_at > ?`,
        key.cacheKey,
        now,
      ),
    );
    if (!row || row.etag !== etag || row.body_digest !== bodyDigest) {
      this.recordMetricSync(now, key.credentialPool, "cache_skip");
      return { ok: true, confirmed: false, reason: "entry_changed_or_expired" };
    }
    const responseBody = String(row.body);
    const expiresAt = now + GITHUB_ETAG_CACHE_RETENTION_MS;
    this.storage.sql.exec(
      `UPDATE ${GITHUB_ETAG_CACHE_TABLE}
          SET validated_at = ?, expires_at = ? WHERE cache_key = ?`,
      now,
      expiresAt,
      key.cacheKey,
    );
    this.recordMetricSync(now, key.credentialPool, "cache_304_served");
    return {
      ok: true,
      confirmed: true,
      body: responseBody,
      entry: {
        etag,
        bodyDigest,
        responseAt: Number(row.response_at),
        validatedAt: now,
        expiresAt,
      },
    };
  }

  telemetry(now: number): Record<string, number> {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT outcome, SUM(count) AS count FROM ${METRICS_TABLE}
          WHERE bucket_start >= ? GROUP BY outcome`,
        now - 24 * 60 * 60 * 1_000,
      ),
    );
    return Object.fromEntries(rows.map((row) => [String(row.outcome), Number(row.count)]));
  }

  private skipped(
    key: GithubEtagCacheKey,
    now: number,
    reason: string,
  ): { ok: true; stored: false; reason: string } {
    this.recordMetricSync(now, key.credentialPool, "cache_skip");
    return { ok: true, stored: false, reason };
  }

  private deleteExpiredSync(now: number): void {
    if (this.lastCleanupAt !== null && now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    const deleted = Array.from(
      this.storage.sql.exec(
        `DELETE FROM ${GITHUB_ETAG_CACHE_TABLE}
        WHERE cache_key IN (
          SELECT cache_key FROM ${GITHUB_ETAG_CACHE_TABLE}
           WHERE expires_at <= ? ORDER BY expires_at LIMIT ${CLEANUP_LIMIT}
        ) RETURNING cache_key`,
        now,
      ),
    ).length;
    if (this.entryCount !== null) this.entryCount -= deleted;
    this.storage.sql.exec(
      `DELETE FROM ${METRICS_TABLE} WHERE bucket_start < ?`,
      now - 30 * 86_400_000,
    );
    this.lastCleanupAt = now;
  }

  private enforceEntryCapSync(): void {
    this.storesSinceCount += 1;
    if (this.entryCount === null || this.storesSinceCount >= ENTRY_COUNT_RECONCILE_STORES) {
      this.entryCount = Number(
        firstRow(this.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${GITHUB_ETAG_CACHE_TABLE}`))
          ?.count || 0,
      );
      this.storesSinceCount = 0;
    }
    const overflow = Math.max(0, this.entryCount - GITHUB_ETAG_CACHE_MAX_ENTRIES);
    if (!overflow) return;
    this.storage.sql.exec(
      `DELETE FROM ${GITHUB_ETAG_CACHE_TABLE}
        WHERE cache_key IN (
          SELECT cache_key FROM ${GITHUB_ETAG_CACHE_TABLE}
           ORDER BY validated_at ASC, cache_key ASC LIMIT ?
        )`,
      overflow,
    );
    this.entryCount -= overflow;
  }

  private recordMetricSync(now: number, credentialPool: string, outcome: string): void {
    const bucketStart = Math.floor(now / 300_000) * 300_000;
    this.storage.sql.exec(
      `INSERT INTO ${METRICS_TABLE} (bucket_start, credential_pool, outcome, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket_start, credential_pool, outcome)
       DO UPDATE SET count = count + 1`,
      bucketStart,
      credentialPool,
      outcome,
    );
  }
}

function validEtag(value: string): boolean {
  return Boolean(value && value.length <= ETAG_MAX_LENGTH && !/[\r\n]/.test(value));
}

function validJsonBody(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Boolean(parsed && typeof parsed === "object");
  } catch {
    return false;
  }
}

async function sha256Bytes(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function firstRow(rows: Iterable<SqlRow>): SqlRow | undefined {
  return Array.from(rows)[0];
}
