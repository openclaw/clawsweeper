import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ExactReviewPublicationTerminalLedger } from "../dashboard/exact-review-publication-terminal-ledger.ts";

class TestStorage {
  private readonly database = new DatabaseSync(":memory:");
  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = this.database.prepare(query);
      return /\b(?:SELECT|RETURNING)\b/i.test(query)
        ? statement.all(...bindings)
        : (statement.run(...bindings), []);
    },
  };
}

test("terminal ledger compacts old revisions without admitting their redelivery", () => {
  const ledger = new ExactReviewPublicationTerminalLedger(new TestStorage());
  ledger.ensureSchemaSync();
  assert.equal(
    ledger.record({
      targetKey: "openclaw/openclaw#42",
      sourceRevision: 3,
      outcome: "published",
      terminalAt: 100,
      runId: "301",
    }),
    "recorded",
  );
  assert.equal(
    ledger.record({
      targetKey: "openclaw/openclaw#42",
      sourceRevision: 3,
      outcome: "published",
      terminalAt: 101,
    }),
    "duplicate",
  );
  assert.equal(ledger.compact(1_000, { retentionMs: 1, limit: 10 }).deleted, 1);
  assert.deepEqual(ledger.terminalFor("openclaw/openclaw#42", 3), {
    outcome: "compacted",
    compacted: true,
  });
  assert.equal(ledger.terminalFor("openclaw/openclaw#42", 4), null);
});
