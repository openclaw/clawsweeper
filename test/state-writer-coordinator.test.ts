import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  StateWriterCoordinator,
  type StateWriterTicketInput,
} from "../dashboard/state-writer-coordinator.ts";

const LEASE_MS = 1_000;
const QUEUED_STALE_MS = 1_000;
const MAXIMUM_LEASE_AGE_MS = 10_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

class SqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  private readonly rows: T[];

  constructor(rows: T[]) {
    this.rows = rows;
  }

  *[Symbol.iterator]() {
    yield* this.rows;
  }
}

class TestStorage {
  private readonly database = new DatabaseSync(":memory:");

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = this.database.prepare(query);
      if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new SqlCursor(statement.all(...bindings) as Record<string, unknown>[]);
      }
      statement.run(...bindings);
      return new SqlCursor<Record<string, unknown>>([]);
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  scalar(query: string): number {
    return Number((this.database.prepare(query).get() as { value: number }).value);
  }

  execute(query: string): void {
    this.database.exec(query);
  }

  columns(table: string): string[] {
    return (
      this.database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  }
}

test("coordinator schema upgrades pre-deadline ticket storage in place", () => {
  const storage = new TestStorage();
  storage.execute(`CREATE TABLE state_writer_tickets (
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
    completed_at INTEGER
  ) STRICT`);

  const coordinator = new StateWriterCoordinator(storage);
  coordinator.ensureSchemaSync();
  assert.ok(storage.columns("state_writer_tickets").includes("lease_deadline_at"));
  const lease = acquire(
    coordinator,
    writer("migrated", "State materializer", "materialize"),
    1_000,
  );
  assert.equal(lease.state, "leased");
  assert.equal(lease.leaseDeadlineAt, 1_000 + MAXIMUM_LEASE_AGE_MS);
});

test("state writer coordinator admits different writer classes in strict FIFO order", () => {
  const { coordinator } = fixture();
  const batch = writer("batch", "Exact review batch publish", "publish");
  const router = writer("router", "Repair comment router", "route");
  const materializer = writer("materializer", "State materializer", "materialize");

  const batchLease = acquire(coordinator, batch, 1_000);
  assert.equal(batchLease.state, "leased");
  assert.equal(acquire(coordinator, router, 1_100).position, 1);
  assert.equal(acquire(coordinator, materializer, 1_200).position, 2);

  // Polling more frequently cannot let a later writer skip the durable queue head.
  assert.deepEqual(pick(acquire(coordinator, materializer, 1_300), ["state", "position"]), {
    state: "queued",
    position: 2,
  });
  assert.equal(
    coordinator.release(
      batch.ticketId,
      batch.owner,
      required(batchLease.leaseToken),
      1_400,
      QUEUED_STALE_MS,
    ),
    true,
  );
  assert.deepEqual(pick(acquire(coordinator, materializer, 1_500), ["state", "position"]), {
    state: "queued",
    position: 2,
  });

  const routerLease = acquire(coordinator, router, 1_600);
  assert.equal(routerLease.state, "leased");
  assert.equal(
    coordinator.release(
      router.ticketId,
      router.owner,
      required(routerLease.leaseToken),
      1_700,
      QUEUED_STALE_MS,
    ),
    true,
  );
  const materializerLease = acquire(coordinator, materializer, 1_800);
  assert.equal(materializerLease.state, "leased");

  const stats = coordinator.stats(1_900, QUEUED_STALE_MS);
  assert.equal(stats.queued, 0);
  assert.equal(stats.leased, 1);
  assert.equal(stats.admitted, 3);
  assert.equal(stats.completed, 2);
  assert.equal(stats.last_wait_ms, 600);
  assert.equal(stats.max_wait_ms, 600);
  assert.deepEqual(pick(required(stats.active), ["ticket_id", "workflow", "job", "run_id"]), {
    ticket_id: materializer.ticketId,
    workflow: materializer.workflow,
    job: materializer.job,
    run_id: materializer.runId,
  });
});

test("expired active and abandoned queue-head writers recover without accepting stale owners", () => {
  const { coordinator } = fixture();
  const active = writer("active", "Exact review batch publish", "publish");
  const abandonedHead = writer("abandoned", "Repair comment router", "route");
  const liveTail = writer("live", "State materializer", "materialize");
  const activeLease = acquire(coordinator, active, 1_000);
  acquire(coordinator, abandonedHead, 1_100);
  acquire(coordinator, liveTail, 1_200);

  // The active writer crashed. Reclamation frees the slot, but the live tail
  // still cannot overtake the older queued writer.
  assert.deepEqual(pick(acquire(coordinator, liveTail, 2_001), ["state", "position"]), {
    state: "queued",
    position: 2,
  });
  assert.equal(
    coordinator.heartbeat(
      active.ticketId,
      active.owner,
      required(activeLease.leaseToken),
      2_002,
      LEASE_MS,
      QUEUED_STALE_MS,
    ),
    null,
  );
  assert.equal(
    coordinator.release(
      active.ticketId,
      active.owner,
      required(activeLease.leaseToken),
      2_002,
      QUEUED_STALE_MS,
    ),
    false,
  );

  // Once the abandoned queue head itself goes stale, the still-polling tail
  // becomes the oldest live ticket and can acquire immediately.
  const recovered = acquire(coordinator, liveTail, 2_101);
  assert.equal(recovered.state, "leased");
  assert.equal(
    coordinator.heartbeat(
      liveTail.ticketId,
      "stale-owner",
      required(recovered.leaseToken),
      2_102,
      LEASE_MS,
      QUEUED_STALE_MS,
    ),
    null,
  );
  assert.equal(
    coordinator.release(liveTail.ticketId, liveTail.owner, "stale-token", 2_102, QUEUED_STALE_MS),
    false,
  );
  assert.equal(coordinator.stats(2_102, QUEUED_STALE_MS).active?.ticket_id, liveTail.ticketId);
  assert.equal(coordinator.stats(2_102, QUEUED_STALE_MS).recovered, 2);
});

test("a durable ticket rejects every metadata mutation and release remains idempotent", () => {
  const { coordinator } = fixture();
  const input = writer("identity", "Sweep", "status");
  const lease = acquire(coordinator, input, 1_000);
  const mutations: Array<Partial<StateWriterTicketInput>> = [
    { owner: "other-owner" },
    { branch: "main" },
    { repository: "openclaw/other-state" },
    { workflow: "Other workflow" },
    { job: "other-job" },
    { runId: "999" },
    { runAttempt: 2 },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => acquire(coordinator, { ...input, ...mutation }, 1_100),
      /metadata does not match its durable identity/,
    );
  }

  const token = required(lease.leaseToken);
  assert.equal(
    coordinator.release(input.ticketId, input.owner, token, 1_200, QUEUED_STALE_MS),
    true,
  );
  assert.equal(
    coordinator.release(input.ticketId, input.owner, token, 1_300, QUEUED_STALE_MS),
    true,
  );
  assert.equal(
    coordinator.release(input.ticketId, input.owner, "wrong-token", 1_300, QUEUED_STALE_MS),
    false,
  );
  assert.equal(acquire(coordinator, input, 1_400).state, "completed");
  assert.equal(coordinator.stats(1_400, QUEUED_STALE_MS).completed, 1);
});

test("absolute lease age cannot be heartbeated forever and terminal pruning is bounded", () => {
  const { coordinator } = fixture();
  const bounded = writer("bounded", "Repair result", "publish");
  const lease = coordinator.acquire(bounded, 10_000, LEASE_MS, QUEUED_STALE_MS, 2_500);
  const token = required(lease.leaseToken);
  assert.equal(lease.leaseDeadlineAt, 12_500);
  assert.equal(
    coordinator.heartbeat(bounded.ticketId, bounded.owner, token, 10_900, LEASE_MS, QUEUED_STALE_MS)
      ?.leaseExpiresAt,
    11_900,
  );
  assert.equal(
    coordinator.heartbeat(bounded.ticketId, bounded.owner, token, 11_800, LEASE_MS, QUEUED_STALE_MS)
      ?.leaseExpiresAt,
    12_500,
  );
  assert.equal(
    coordinator.heartbeat(
      bounded.ticketId,
      bounded.owner,
      token,
      12_500,
      LEASE_MS,
      QUEUED_STALE_MS,
    ),
    null,
  );
  assert.equal(
    coordinator.release(bounded.ticketId, bounded.owner, token, 12_500, QUEUED_STALE_MS),
    false,
  );
  assert.equal(coordinator.stats(12_500, QUEUED_STALE_MS).expired, 1);

  const terminalFixture = fixture();
  let completedAt = 20_000;
  for (let index = 0; index < 260; index += 1) {
    const input = writer(`terminal-${index}`, "Sweep", "status");
    const acquired = acquire(terminalFixture.coordinator, input, completedAt);
    completedAt += 1;
    assert.equal(
      terminalFixture.coordinator.release(
        input.ticketId,
        input.owner,
        required(acquired.leaseToken),
        completedAt,
        QUEUED_STALE_MS,
      ),
      true,
    );
    completedAt += 1;
  }
  assert.equal(
    terminalFixture.storage.scalar(
      "SELECT COUNT(*) AS value FROM state_writer_tickets WHERE state = 'completed'",
    ),
    260,
  );

  const pruneAt = completedAt + TERMINAL_RETENTION_MS + 1;
  const firstPrune = terminalFixture.coordinator.stats(pruneAt, QUEUED_STALE_MS);
  assert.equal(firstPrune.completed, 260, "durable counters survive receipt pruning");
  assert.equal(
    terminalFixture.storage.scalar("SELECT COUNT(*) AS value FROM state_writer_tickets"),
    4,
    "one maintenance pass deletes at most 256 terminal rows",
  );
  terminalFixture.coordinator.stats(pruneAt, QUEUED_STALE_MS);
  assert.equal(
    terminalFixture.storage.scalar("SELECT COUNT(*) AS value FROM state_writer_tickets"),
    0,
  );
});

function fixture() {
  const storage = new TestStorage();
  const coordinator = new StateWriterCoordinator(storage);
  coordinator.ensureSchemaSync();
  return { coordinator, storage };
}

function writer(suffix: string, workflow: string, job: string): StateWriterTicketInput {
  return {
    ticketId: `ticket-${suffix}`,
    owner: `owner-${suffix}`,
    branch: "state",
    repository: "openclaw/clawsweeper-state",
    workflow,
    job,
    runId: `run-${suffix}`,
    runAttempt: 1,
  };
}

function acquire(coordinator: StateWriterCoordinator, input: StateWriterTicketInput, now: number) {
  return coordinator.acquire(input, now, LEASE_MS, QUEUED_STALE_MS, MAXIMUM_LEASE_AGE_MS);
}

function required<T>(value: T | null | undefined): T {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as T;
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}
