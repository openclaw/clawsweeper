import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupProgressScenario,
  noWorkProgressScenario,
} from "./fixtures/review-coverage-cleanup.ts";

test(
  "real20k retired identities drain inside the existing producer control budget",
  { timeout: 180_000 },
  async () => {
    const r = await cleanupProgressScenario();
    assert.equal(r.coreOrphansAtRetirement, 20_000);
    assert.equal(r.coreOrphansAfter, 0);
    assert.equal(r.cleanupQueries[0], 0);
    assert.ok(r.cleanup.nexts <= 200);
    assert.equal(r.maxDeletedPerCall, 128);
    assert.ok(r.shortBatches.includes(32));
  },
);
test(
  "interrupted cleanup replay and reconstruction preserve latest/peer state without starving normal work",
  { timeout: 180_000 },
  async () => {
    const r = await cleanupProgressScenario({ count: 20_000, mixed: true, interrupt: true });
    assert.equal(r.coreOrphansAfter, 0);
    assert.equal(r.interrupted, true);
    assert.ok(r.cleanupQueries.some((q) => Number(q) > 0));
    assert.equal(r.canonicalUnchanged, true);
    assert.equal(r.admissionUnchanged, true);
  },
);

test("no orphans or future-retry work never invents a pending spin", async () => {
  const r = await noWorkProgressScenario();
  assert.equal(r.pending, false);
  assert.ok(r.zeroNexts < 200);
  assert.ok(r.retryNexts < 200);
});
