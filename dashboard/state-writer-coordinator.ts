const STATE_WRITER_TICKET_TABLE = "state_writer_tickets";
const STATE_WRITER_META_TABLE = "state_writer_meta";
const STATE_WRITER_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_WRITER_TERMINAL_PRUNE_LIMIT = 256;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export type StateWriterTicketInput = {
  ticketId: string;
  owner: string;
  branch: string;
  repository: string;
  workflow: string;
  job: string;
  runId: string;
  runAttempt: number;
};

export type StateWriterTicket = {
  seq: number;
  ticketId: string;
  owner: string;
  state: "queued" | "leased" | "completed" | "expired";
  leaseToken: string | null;
  leaseGeneration: number;
  leaseExpiresAt: number | null;
  leaseDeadlineAt: number | null;
  position: number;
};

export type StateWriterCoordinatorStats = {
  queued: number;
  leased: number;
  admitted: number;
  completed: number;
  expired: number;
  recovered: number;
  last_wait_ms: number;
  max_wait_ms: number;
  active: null | {
    ticket_id: string;
    owner: string;
    branch: string;
    repository: string;
    workflow: string;
    job: string;
    run_id: string;
    run_attempt: number;
    enqueued_at: string;
    leased_at: string;
    wait_ms: number;
    lease_expires_at: string;
    lease_deadline_at: string;
  };
};

export class StateWriterCoordinator {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_WRITER_TICKET_TABLE} (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         ticket_id TEXT NOT NULL UNIQUE,
         owner TEXT NOT NULL,
         branch TEXT NOT NULL,
         repository TEXT NOT NULL,
         workflow TEXT NOT NULL,
         job TEXT NOT NULL,
         run_id TEXT NOT NULL,
         run_attempt INTEGER NOT NULL CHECK (run_attempt >= 1),
         state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'expired')),
         enqueued_at INTEGER NOT NULL,
         last_seen_at INTEGER NOT NULL,
         leased_at INTEGER,
         lease_token TEXT,
         lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
         lease_expires_at INTEGER,
         lease_deadline_at INTEGER,
         completed_at INTEGER
       ) STRICT`,
    );
    this.ensureTicketColumnsSync();
    this.storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS state_writer_one_active_ticket
         ON ${STATE_WRITER_TICKET_TABLE} (state)
       WHERE state = 'leased'`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS state_writer_fifo
         ON ${STATE_WRITER_TICKET_TABLE} (state, seq)`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS state_writer_terminal_retention
         ON ${STATE_WRITER_TICKET_TABLE} (state, completed_at, seq)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATE_WRITER_META_TABLE} (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         admitted_total INTEGER NOT NULL DEFAULT 0 CHECK (admitted_total >= 0),
         completed_total INTEGER NOT NULL DEFAULT 0 CHECK (completed_total >= 0),
         expired_total INTEGER NOT NULL DEFAULT 0 CHECK (expired_total >= 0),
         recovered_total INTEGER NOT NULL DEFAULT 0 CHECK (recovered_total >= 0),
         last_wait_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_wait_ms >= 0),
         max_wait_ms INTEGER NOT NULL DEFAULT 0 CHECK (max_wait_ms >= 0)
       ) STRICT`,
    );
    this.ensureMetaColumnsSync();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO ${STATE_WRITER_META_TABLE} (singleton_id) VALUES (1)`,
    );
  }

  acquire(
    input: StateWriterTicketInput,
    now: number,
    leaseMs: number,
    queuedStaleMs: number,
    maximumLeaseAgeMs: number,
  ): StateWriterTicket {
    return this.storage.transactionSync(() => {
      this.reclaimAndPruneSync(now, queuedStaleMs);
      let row = this.ticketRowSync(input.ticketId);
      if (!row) {
        this.storage.sql.exec(
          `INSERT INTO ${STATE_WRITER_TICKET_TABLE}
             (ticket_id, owner, branch, repository, workflow, job, run_id, run_attempt,
              state, enqueued_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          input.ticketId,
          input.owner,
          input.branch,
          input.repository,
          input.workflow,
          input.job,
          input.runId,
          input.runAttempt,
          now,
          now,
        );
        row = this.ticketRowSync(input.ticketId);
      }
      if (!row) throw new Error("state writer ticket insert was not visible");
      if (!ticketMatchesInput(row, input)) {
        throw new Error("state writer ticket metadata does not match its durable identity");
      }
      if (row.state === "completed" || row.state === "expired") {
        return this.ticketJsonSync(row);
      }
      if (row.state === "queued") {
        this.storage.sql.exec(
          `UPDATE ${STATE_WRITER_TICKET_TABLE} SET last_seen_at = ? WHERE ticket_id = ?`,
          now,
          input.ticketId,
        );
        const active = this.activeRowSync();
        const head = this.queuedHeadSync();
        if (!active && String(head?.ticket_id || "") === input.ticketId) {
          const leaseToken = crypto.randomUUID();
          const leaseDeadlineAt = now + maximumLeaseAgeMs;
          const leaseExpiresAt = Math.min(now + leaseMs, leaseDeadlineAt);
          const waitMs = Math.max(0, now - Number(row.enqueued_at));
          this.storage.sql.exec(
            `UPDATE ${STATE_WRITER_TICKET_TABLE}
                SET state = 'leased', leased_at = ?, last_seen_at = ?, lease_token = ?,
                    lease_generation = lease_generation + 1, lease_expires_at = ?,
                    lease_deadline_at = ?
              WHERE ticket_id = ? AND state = 'queued'`,
            now,
            now,
            leaseToken,
            leaseExpiresAt,
            leaseDeadlineAt,
            input.ticketId,
          );
          this.storage.sql.exec(
            `UPDATE ${STATE_WRITER_META_TABLE}
                SET admitted_total = admitted_total + 1,
                    last_wait_ms = ?,
                    max_wait_ms = MAX(max_wait_ms, ?)
              WHERE singleton_id = 1`,
            waitMs,
            waitMs,
          );
        }
        row = this.ticketRowSync(input.ticketId);
      }
      if (!row) throw new Error("state writer ticket disappeared during acquisition");
      return this.ticketJsonSync(row);
    });
  }

  heartbeat(
    ticketId: string,
    owner: string,
    leaseToken: string,
    now: number,
    leaseMs: number,
    queuedStaleMs: number,
  ): StateWriterTicket | null {
    return this.storage.transactionSync(() => {
      this.reclaimAndPruneSync(now, queuedStaleMs);
      const row = this.ticketRowSync(ticketId);
      if (
        !row ||
        row.state !== "leased" ||
        row.owner !== owner ||
        row.lease_token !== leaseToken ||
        Number(row.lease_expires_at || 0) <= now ||
        Number(row.lease_deadline_at || 0) <= now
      ) {
        return null;
      }
      this.storage.sql.exec(
        `UPDATE ${STATE_WRITER_TICKET_TABLE}
            SET last_seen_at = ?, lease_expires_at = MIN(?, lease_deadline_at)
          WHERE ticket_id = ? AND state = 'leased' AND owner = ? AND lease_token IS ?`,
        now,
        now + leaseMs,
        ticketId,
        owner,
        leaseToken,
      );
      return this.ticketJsonSync(this.ticketRowSync(ticketId)!);
    });
  }

  release(
    ticketId: string,
    owner: string,
    leaseToken: string,
    now: number,
    queuedStaleMs: number,
  ): boolean {
    return this.storage.transactionSync(() => {
      this.reclaimAndPruneSync(now, queuedStaleMs);
      const existing = this.ticketRowSync(ticketId);
      if (
        existing?.state === "completed" &&
        existing.owner === owner &&
        existing.lease_token === leaseToken
      ) {
        return true;
      }
      const released = Array.from(
        this.storage.sql.exec(
          `UPDATE ${STATE_WRITER_TICKET_TABLE}
              SET state = 'completed', last_seen_at = ?, completed_at = ?, lease_expires_at = NULL
            WHERE ticket_id = ? AND state = 'leased' AND owner = ? AND lease_token IS ?
              AND lease_expires_at > ? AND lease_deadline_at > ?
          RETURNING ticket_id`,
          now,
          now,
          ticketId,
          owner,
          leaseToken,
          now,
          now,
        ),
      ).length;
      if (released === 1) {
        this.storage.sql.exec(
          `UPDATE ${STATE_WRITER_META_TABLE}
              SET completed_total = completed_total + 1
            WHERE singleton_id = 1`,
        );
      }
      return released === 1;
    });
  }

  stats(now: number, queuedStaleMs: number): StateWriterCoordinatorStats {
    return this.storage.transactionSync(() => {
      this.reclaimAndPruneSync(now, queuedStaleMs);
      const liveCounts = { queued: 0, leased: 0 };
      for (const row of this.storage.sql.exec(
        `SELECT state, COUNT(*) AS count FROM ${STATE_WRITER_TICKET_TABLE}
          WHERE state IN ('queued', 'leased') GROUP BY state`,
      ) as Iterable<{ state: keyof typeof liveCounts; count: number }>) {
        if (Object.hasOwn(liveCounts, row.state)) liveCounts[row.state] = Number(row.count || 0);
      }
      const meta = Array.from(
        this.storage.sql.exec(
          `SELECT admitted_total, completed_total, expired_total, recovered_total,
                  last_wait_ms, max_wait_ms
             FROM ${STATE_WRITER_META_TABLE} WHERE singleton_id = 1`,
        ),
      )[0] as Record<string, unknown> | undefined;
      const active = this.activeRowSync();
      return {
        ...liveCounts,
        admitted: Number(meta?.admitted_total || 0),
        completed: Number(meta?.completed_total || 0),
        expired: Number(meta?.expired_total || 0),
        recovered: Number(meta?.recovered_total || 0),
        last_wait_ms: Number(meta?.last_wait_ms || 0),
        max_wait_ms: Number(meta?.max_wait_ms || 0),
        active: active
          ? {
              ticket_id: String(active.ticket_id),
              owner: String(active.owner),
              branch: String(active.branch),
              repository: String(active.repository),
              workflow: String(active.workflow),
              job: String(active.job),
              run_id: String(active.run_id),
              run_attempt: Number(active.run_attempt),
              enqueued_at: new Date(Number(active.enqueued_at)).toISOString(),
              leased_at: new Date(Number(active.leased_at)).toISOString(),
              wait_ms: Math.max(0, Number(active.leased_at) - Number(active.enqueued_at)),
              lease_expires_at: new Date(Number(active.lease_expires_at)).toISOString(),
              lease_deadline_at: new Date(Number(active.lease_deadline_at)).toISOString(),
            }
          : null,
      };
    });
  }

  private ensureMetaColumnsSync(): void {
    const columns = new Set(
      Array.from(
        this.storage.sql.exec(`SELECT name FROM pragma_table_info('${STATE_WRITER_META_TABLE}')`),
      ).map((row) => String(row.name || "")),
    );
    for (const column of [
      "admitted_total",
      "completed_total",
      "expired_total",
      "recovered_total",
      "last_wait_ms",
      "max_wait_ms",
    ]) {
      if (!columns.has(column)) {
        this.storage.sql.exec(
          `ALTER TABLE ${STATE_WRITER_META_TABLE}
             ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`,
        );
      }
    }
  }

  private ensureTicketColumnsSync(): void {
    const columns = new Set(
      Array.from(
        this.storage.sql.exec(`SELECT name FROM pragma_table_info('${STATE_WRITER_TICKET_TABLE}')`),
      ).map((row) => String(row.name || "")),
    );
    // The absolute deadline was added after the first coordinator prototype.
    // Preserve already-queued tickets during deployment; a leased legacy row
    // remains bounded by lease_expires_at; every subsequently admitted ticket
    // receives the absolute deadline.
    if (!columns.has("lease_deadline_at")) {
      this.storage.sql.exec(
        `ALTER TABLE ${STATE_WRITER_TICKET_TABLE} ADD COLUMN lease_deadline_at INTEGER`,
      );
    }
  }

  private reclaimAndPruneSync(now: number, queuedStaleMs: number): void {
    const reclaimed = Array.from(
      this.storage.sql.exec(
        `UPDATE ${STATE_WRITER_TICKET_TABLE}
            SET state = 'expired', completed_at = ?, lease_expires_at = NULL
          WHERE (state = 'leased' AND (lease_expires_at <= ? OR lease_deadline_at <= ?))
             OR (state = 'queued' AND last_seen_at <= ?)
        RETURNING ticket_id`,
        now,
        now,
        now,
        now - queuedStaleMs,
      ),
    ).length;
    if (reclaimed) {
      this.storage.sql.exec(
        `UPDATE ${STATE_WRITER_META_TABLE}
            SET expired_total = expired_total + ?, recovered_total = recovered_total + ?
          WHERE singleton_id = 1`,
        reclaimed,
        reclaimed,
      );
    }
    // Terminal rows retain idempotent release/acquire receipts for a week, while
    // this bounded delete keeps a busy coordinator from growing SQLite forever.
    this.storage.sql.exec(
      `DELETE FROM ${STATE_WRITER_TICKET_TABLE}
        WHERE seq IN (
          SELECT seq FROM ${STATE_WRITER_TICKET_TABLE}
           WHERE state IN ('completed', 'expired') AND completed_at <= ?
           ORDER BY completed_at, seq
           LIMIT ?
        )`,
      now - STATE_WRITER_TERMINAL_RETENTION_MS,
      STATE_WRITER_TERMINAL_PRUNE_LIMIT,
    );
  }

  private ticketRowSync(ticketId: string) {
    return Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${STATE_WRITER_TICKET_TABLE} WHERE ticket_id = ?`,
        ticketId,
      ),
    )[0] as Record<string, unknown> | undefined;
  }

  private activeRowSync() {
    return Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${STATE_WRITER_TICKET_TABLE} WHERE state = 'leased' LIMIT 1`,
      ),
    )[0] as Record<string, unknown> | undefined;
  }

  private queuedHeadSync() {
    return Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${STATE_WRITER_TICKET_TABLE}
          WHERE state = 'queued' ORDER BY seq LIMIT 1`,
      ),
    )[0] as Record<string, unknown> | undefined;
  }

  private ticketJsonSync(row: Record<string, unknown>): StateWriterTicket {
    const seq = Number(row.seq);
    const position =
      row.state === "queued"
        ? Number(
            (
              Array.from(
                this.storage.sql.exec(
                  `SELECT COUNT(*) AS count FROM ${STATE_WRITER_TICKET_TABLE}
                    WHERE state = 'queued' AND seq <= ?`,
                  seq,
                ),
              )[0] as { count?: number } | undefined
            )?.count || 0,
          )
        : 0;
    return {
      seq,
      ticketId: String(row.ticket_id),
      owner: String(row.owner),
      state: row.state as StateWriterTicket["state"],
      leaseToken: String(row.lease_token || "") || null,
      leaseGeneration: Number(row.lease_generation || 0),
      leaseExpiresAt: nullableNumber(row.lease_expires_at),
      leaseDeadlineAt: nullableNumber(row.lease_deadline_at),
      position,
    };
  }
}

function ticketMatchesInput(row: Record<string, unknown>, input: StateWriterTicketInput): boolean {
  return (
    String(row.owner) === input.owner &&
    String(row.branch) === input.branch &&
    String(row.repository) === input.repository &&
    String(row.workflow) === input.workflow &&
    String(row.job) === input.job &&
    String(row.run_id) === input.runId &&
    Number(row.run_attempt) === input.runAttempt
  );
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
