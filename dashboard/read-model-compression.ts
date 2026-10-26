import { stableJson } from "../src/stable-json.ts";
import type { DurableStorage } from "./durable-storage.ts";
import { decodeStoredJson, encodeStoredJson, STORED_JSON_MAX_BYTES } from "./stored-json.ts";

export const READ_MODEL_COMPRESSION_KEY = "read-model-compression:v1";
export const READ_MODEL_COMPRESSION_TABLES = [
  ["github_webhook_read_model_items_v1", "snapshot_json"],
  ["github_webhook_read_model_comments_v1", "snapshot_json"],
  ["github_webhook_read_model_activity_v1", "snapshot_json"],
  ["github_webhook_read_model_workflows_v1", "snapshot_json"],
  ["exact_review_lifecycle_projection_v1", "projection_json"],
] as const;
export const READ_MODEL_COMPRESSION_ROWS = 64;

type Storage = DurableStorage & {
  kv: { get(key: string): unknown; put(key: string, value: unknown): unknown };
};
type Checkpoint = {
  version: 1;
  upperRowids: number[];
  table: number;
  afterRowid: number;
  scanned: number;
  converted: number;
  sourceBytes: number;
  savedBytes: number;
  oversized: number;
  conflicts: number;
  completedAt: number | null;
};
type Candidate = {
  table: number;
  rowid: number;
  bytes: number;
  original: string | null;
  encoded: string | null;
};

export class ReadModelCompressionConflictError extends Error {
  constructor() {
    super("read_model_compression_checkpoint_changed");
  }
}

// A physical rewrite owns no logical timestamps, revisions, retention or receipts.
// Its checkpoint shares the SQLite transaction with the exact-text CAS updates.
export class ReadModelCompressionStore {
  private readonly storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  checkpoint(): Checkpoint | null {
    return (this.storage.kv.get(READ_MODEL_COMPRESSION_KEY) as Checkpoint | undefined) ?? null;
  }

  async preview(deploymentSha: string) {
    const plan = {
      version: 1,
      codec: "gzip-text-v1",
      deploymentSha,
      rollbackFloor: deploymentSha,
      boundary: "all rows present at the first committed pass",
      tables: READ_MODEL_COMPRESSION_TABLES,
      maxRows: READ_MODEL_COMPRESSION_ROWS,
      maxSourceBytes: STORED_JSON_MAX_BYTES,
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableJson(plan)),
    );
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      plan,
      sha256,
      observedUpperRowids: this.checkpoint()?.upperRowids ?? this.frontier(),
      checkpoint: this.checkpoint(),
    };
  }

  private frontier() {
    return READ_MODEL_COMPRESSION_TABLES.map(([table]) =>
      Number(
        Array.from(
          this.storage.sql.exec(`SELECT COALESCE(MAX(rowid), 0) AS maximum FROM ${table}`),
        )[0]?.maximum,
      ),
    );
  }

  prepare() {
    const previous = this.checkpoint();
    const checkpoint: Checkpoint = previous
      ? structuredClone(previous)
      : {
          version: 1,
          upperRowids: this.frontier(),
          table: 0,
          afterRowid: 0,
          scanned: 0,
          converted: 0,
          sourceBytes: 0,
          savedBytes: 0,
          oversized: 0,
          conflicts: 0,
          completedAt: null,
        };
    const candidates: Candidate[] = [];
    let sourceBytes = 0;
    let table = checkpoint.table;
    let afterRowid = checkpoint.afterRowid;
    if (checkpoint.completedAt !== null)
      return { previous, checkpoint, candidates, table, afterRowid };
    for (; table < READ_MODEL_COMPRESSION_TABLES.length; table++, afterRowid = 0) {
      const [name, column] = READ_MODEL_COMPRESSION_TABLES[table]!;
      // Inspect sizes first. A legacy oversized row must never be materialized
      // merely to discover that it exceeds the bounded compression budget.
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT rowid, octet_length(${column}) AS bytes FROM ${name}
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
          afterRowid,
          checkpoint.upperRowids[table],
          READ_MODEL_COMPRESSION_ROWS - candidates.length,
        ),
      );
      for (const row of rows) {
        const bytes = Number(row.bytes),
          rowid = Number(row.rowid);
        if (bytes <= STORED_JSON_MAX_BYTES && sourceBytes + bytes > STORED_JSON_MAX_BYTES)
          return { previous, checkpoint, candidates, table, afterRowid };
        let original: string | null = null,
          encoded: string | null = null;
        if (bytes <= STORED_JSON_MAX_BYTES) {
          const current = Array.from(
            this.storage.sql.exec(`SELECT ${column} AS text FROM ${name} WHERE rowid = ?`, rowid),
          )[0];
          if (!current) throw new ReadModelCompressionConflictError();
          original = String(current.text);
          if (new TextEncoder().encode(original).length !== bytes)
            throw new ReadModelCompressionConflictError();
          sourceBytes += bytes;
          // Decode existing envelopes for validation; never double-encode them.
          const decoded = decodeStoredJson(original);
          encoded = decoded === original ? encodeStoredJson(original) : original;
          if (decodeStoredJson(encoded) !== decoded)
            throw new Error("read_model_compression_roundtrip_failed");
        }
        candidates.push({ table, rowid, bytes, original, encoded });
        afterRowid = rowid;
      }
      if (candidates.length === READ_MODEL_COMPRESSION_ROWS)
        return { previous, checkpoint, candidates, table, afterRowid };
    }
    return { previous, checkpoint, candidates, table, afterRowid };
  }

  commit(pass: ReturnType<ReadModelCompressionStore["prepare"]>, now: number) {
    return this.storage.transactionSync(() => {
      if (JSON.stringify(this.checkpoint()) !== JSON.stringify(pass.previous))
        throw new ReadModelCompressionConflictError();
      const checkpoint = structuredClone(pass.checkpoint);
      if (checkpoint.completedAt !== null) return checkpoint;
      let conflict = false;
      for (const candidate of pass.candidates) {
        const [table, column] = READ_MODEL_COMPRESSION_TABLES[candidate.table]!;
        if (candidate.original !== null) {
          // Even unchanged/incompressible rows use the CAS: a concurrent payload
          // replacement cannot be silently skipped by an advanced checkpoint.
          const rows =
            candidate.encoded === candidate.original
              ? Array.from(
                  this.storage.sql.exec(
                    `SELECT rowid FROM ${table} WHERE rowid = ? AND ${column} = ?`,
                    candidate.rowid,
                    candidate.original,
                  ),
                )
              : Array.from(
                  this.storage.sql.exec(
                    `UPDATE ${table} SET ${column} = ? WHERE rowid = ? AND ${column} = ? RETURNING rowid`,
                    candidate.encoded,
                    candidate.rowid,
                    candidate.original,
                  ),
                );
          if (rows.length !== 1) {
            checkpoint.conflicts++;
            conflict = true;
            break;
          }
          if (candidate.encoded !== candidate.original) {
            checkpoint.converted++;
            checkpoint.savedBytes +=
              candidate.bytes - new TextEncoder().encode(candidate.encoded!).length;
          }
          checkpoint.sourceBytes += candidate.bytes;
        } else {
          // Oversized rows remain byte-for-byte raw. Recheck the size in the
          // commit so a concurrently replaced small row is not missed.
          const row = Array.from(
            this.storage.sql.exec(
              `SELECT octet_length(${column}) AS bytes FROM ${table} WHERE rowid = ?`,
              candidate.rowid,
            ),
          )[0];
          if (row && Number(row.bytes) <= STORED_JSON_MAX_BYTES) {
            checkpoint.conflicts++;
            conflict = true;
            break;
          }
          checkpoint.oversized++;
        }
        checkpoint.scanned++;
        checkpoint.table = candidate.table;
        checkpoint.afterRowid = candidate.rowid;
      }
      if (!conflict) {
        checkpoint.table = pass.table;
        checkpoint.afterRowid = pass.afterRowid;
        if (pass.table === READ_MODEL_COMPRESSION_TABLES.length) checkpoint.completedAt = now;
      }
      this.storage.kv.put(READ_MODEL_COMPRESSION_KEY, checkpoint);
      return checkpoint;
    });
  }
}
