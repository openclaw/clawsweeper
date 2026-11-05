import {
  pendingCopyDriftScenario,
  pendingWitnessDriftScenario,
} from "./fixtures/review-coverage-pending-promotion.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { stickyDriftScenario } from "./fixtures/review-coverage-sticky-drift.ts";
test("count reversion during orphan cleanup never revives an old qualified witness", async () => {
  const r = await stickyDriftScenario();
  assert.equal(r.before.orphans, 256);
  assert.equal(r.drifted.orphans, 128);
  assert.equal(r.drifted.percent, null);
  assert.equal(r.returned.orphans, 0);
  assert.equal(r.noQueryDuringCountDrift, 0);
  assert.equal(r.returned.coreComplete, false);
  assert.equal(r.returned.percent, null);
  assert.equal(r.returned.compatible, false);
  assert.equal(r.returned.completeHash, r.before.completeHash);
  assert.equal(r.returned.latestPayloadSha256, r.before.latestPayloadSha256);
});

test("sticky drift survives durable control lifecycles and clears only after real two-pass promotion", async () => {
  const r = await stickyDriftScenario({ lifecycle: true, recover: true });
  assert.equal(r.returned.percent, null);
  assert.equal(r.afterCleanup.compatible, false);
  assert.ok(r.lifecycle.length >= 7);
  for (const s of r.lifecycle) {
    assert.equal(s.percent, null);
    assert.equal(s.completeHash, r.before.completeHash);
    assert.equal(s.latestPayloadSha256, r.before.latestPayloadSha256);
  }
  assert.equal(r.sawSecondWitness, true);
  assert.ok(r.witnessRequestCounts.pass1 > 0 && r.witnessRequestCounts.pass2 > 0);
  assert.equal(r.recovered!.coreComplete, true);
  assert.notEqual(r.recovered!.completeHash, r.before.completeHash);
  assert.equal(r.canonicalAdmissionUnchanged, true);
});

test(
  "real20k drift stays Unknown across bounded cleanup while healthy and zero peers remain complete",
  { timeout: 180_000 },
  async () => {
    const r = await stickyDriftScenario({
      count: 20_000,
      mixed: true,
      lifecycle: true,
      recover: true,
    });
    assert.equal(r.fleetCount, 20_000);
    assert.equal(r.before.orphans, 19_998);
    assert.equal(r.drifted.orphans, 19_998 - 128);
    assert.equal(r.returned.percent, null);
    assert.ok(r.cleanupCalls <= 200);
    assert.equal(r.maxDeleted, 128);
    assert.equal(r.noQueryDuringCountDrift, 0);
    assert.ok(r.opportunities.every((o) => o.queries <= 25));
    assert.ok(r.lifecycle.every((s) => s.peers.every((p) => p.complete)));
    assert.equal(r.recovered!.coreComplete, true);
    assert.equal(r.sawSecondWitness, true);
    assert.equal(r.canonicalAdmissionUnchanged, true);
  },
);

test(
  "actual20k retired identities remain invalid through count reversion and recover by two new sweeps",
  { timeout: 180_000 },
  async () => {
    const r = await stickyDriftScenario({ count: 20_000, lifecycle: true, recover: true });
    assert.equal(r.before.orphans, 20_000);
    assert.equal(r.drifted.orphans, 20_000 - 128);
    assert.equal(r.returned.percent, null);
    assert.equal(r.maxDeleted, 128);
    assert.ok(r.cleanupCalls <= 200);
    assert.equal(r.noQueryDuringCountDrift, 0);
    assert.equal(r.recovered!.coreComplete, true);
    assert.equal(r.sawSecondWitness, true);
  },
);

test(
  "ordinary count drift invalidates a pending promotion before capacity frees",
  { timeout: 180_000 },
  async () => {
    const r = await pendingCopyDriftScenario();
    assert.equal(r.pending.promoting, true);
    assert.equal(r.pending.promotingCount, 1000);
    assert.equal(r.contradicted.promoting, false);
    assert.equal(r.finalized.completeCount, 10);
    assert.equal(r.returned.percent, null);
    assert.equal(r.returned.compatible, false);
    assert.equal(r.coreQueriesOnCountDrift, 0);
    assert.equal(r.returned.completeHash, r.oldWindow.completeHash);
    assert.equal(r.returned.payloadHash, r.oldWindow.payloadHash);
  },
);

test(
  "pending copy drift hold survives durable control and recovers only by fresh witnesses",
  { timeout: 180_000 },
  async () => {
    const r = await pendingCopyDriftScenario({ lifecycle: true, recover: true });
    assert.equal(r.contradicted.promoting, false);
    assert.equal(r.returned.percent, null);
    assert.ok(
      r.lifecycle.every(
        (s) =>
          s.percent === null &&
          s.completeHash === r.oldWindow.completeHash &&
          s.payloadHash === r.oldWindow.payloadHash,
      ),
    );
    assert.equal(r.recovered!.completeCount, 1000);
    assert.equal(typeof r.recovered!.percent, "number");
    assert.ok(r.witnessPasses.length >= 2);
    assert.equal(r.canonicalAdmissionUnchanged, true);
  },
);

test("ordinary count drift cannot reuse a pre-drift first witness after one new sweep", async () => {
  const r = await pendingWitnessDriftScenario();
  assert.equal(r.returned.percent, null);
  assert.equal(r.oneSweep.percent, null);
  assert.equal(r.oneSweep.completeHash, r.oldWindow.completeHash);
  assert.equal(typeof r.recovered.percent, "number");
  assert.notEqual(r.recovered.completeHash, r.oldWindow.completeHash);
  assert.ok(r.freshWitnessPasses.length >= 2);
});
