import {
  pendingCopyDriftScenario,
  pendingWitnessDriftScenario,
} from "../../../test/fixtures/review-coverage-pending-promotion.ts";
// Actual raw producer/signed Worker/DO promotion, count drift, durable control
// lifecycle and fresh two-pass recovery. No manually inserted generation shape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { stickyDriftScenario } from "../../../test/fixtures/review-coverage-sticky-drift.ts";
const root = resolve(import.meta.dirname, "../../.."),
  output = resolve(process.env.CENSUS_STICKY_OUTPUT ?? ".openclaw/tmp/census-sticky-drift-proof"),
  git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
  head = git("rev-parse", "HEAD"),
  headTree = git("rev-parse", "HEAD^{tree}"),
  realStarted = new Date().toISOString();
mkdirSync(output, { recursive: true });
const paths = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "dashboard/review-coverage-census.ts",
    "dashboard/worker.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/public-observability.ts",
    "src/review-coverage-census.ts",
    "src/repair/review-coverage-census.ts",
    "src/repair/target-fanout.ts",
    "src/repair/coverage-summary.ts",
    "test/fixtures/review-coverage-cli.ts",
    "test/fixtures/review-coverage-sticky-drift.ts",
    "test/fixtures/review-coverage-pending-promotion.ts",
    "test/fixtures/fleet-coverage-query.ts",
    "docs/proof/ui-live-coverage/replay-clock.mjs",
    "docs/proof/review-coverage-census/sticky-drift.mjs",
    "dist/repair/target-fanout.js",
    "dist/repair/coverage-summary.js",
    "dist/repair/review-coverage-census.js",
  ],
  hashes = () =>
    Object.fromEntries(
      paths.map((p) => [
        p,
        createHash("sha256")
          .update(readFileSync(join(root, p)))
          .digest("hex"),
      ]),
    ),
  sourceHashes = hashes();
const small = await stickyDriftScenario({ lifecycle: true, recover: true }),
  full20k = await stickyDriftScenario({ count: 20_000, lifecycle: true, recover: true }),
  mixed20k = await stickyDriftScenario({
    count: 20_000,
    mixed: true,
    lifecycle: true,
    recover: true,
  });
for (const [name, r] of [
  ["retired256", small],
  ["retired20k", full20k],
  ["retired20k-mixed", mixed20k],
]) {
  assert.equal(r.returned.percent, null);
  assert.equal(r.afterCleanup.compatible, false);
  assert.equal(r.noQueryDuringCountDrift, 0);
  assert.ok(
    r.lifecycle.every(
      (s) =>
        s.percent === null &&
        s.completeHash === r.before.completeHash &&
        s.latestPayloadSha256 === r.before.latestPayloadSha256,
    ),
  );
  assert.equal(r.sawSecondWitness, true);
  assert.equal(r.recovered.coreComplete, true);
  assert.ok(r.witnessRequestCounts.pass1 > 0 && r.witnessRequestCounts.pass2 > 0);
  assert.ok(r.opportunities.every((o) => o.queries <= 25));
  assert.equal(r.canonicalAdmissionUnchanged, true);
  writeFileSync(join(output, name + ".json"), JSON.stringify(r, null, 2));
  writeFileSync(join(output, name + ".stdout.md"), r.stdout);
}
assert.equal(full20k.before.orphans, 20_000);
assert.equal(full20k.cleanupBatches.at(-1), 32);
assert.equal(mixed20k.before.orphans, 19_998);
assert.equal(mixed20k.fleetCount, 20_000);
assert.equal(mixed20k.maxDeleted, 128);
assert.ok(mixed20k.cleanupCalls <= 200);
assert.ok(mixed20k.lifecycle.every((s) => s.peers.every((p) => p.complete)));
const pendingCopy = await pendingCopyDriftScenario({ lifecycle: true, recover: true }),
  pendingWitness = await pendingWitnessDriftScenario();
assert.equal(pendingCopy.contradicted.promoting, false);
assert.equal(pendingCopy.returned.percent, null);
assert.equal(pendingCopy.coreQueriesOnCountDrift, 0);
assert.equal(pendingCopy.finalized.completeCount, 10);
assert.ok(
  pendingCopy.lifecycle.every(
    (s) =>
      s.percent === null &&
      s.completeHash === pendingCopy.oldWindow.completeHash &&
      s.payloadHash === pendingCopy.oldWindow.payloadHash,
  ),
);
assert.equal(pendingCopy.recovered.completeCount, 1000);
assert.ok(pendingCopy.witnessPasses.length >= 2);
assert.equal(pendingWitness.oneSweep.percent, null);
assert.equal(pendingWitness.oneSweep.completeHash, pendingWitness.oldWindow.completeHash);
assert.ok(pendingWitness.freshWitnessPasses.length >= 2);
assert.equal(typeof pendingWitness.recovered.percent, "number");
writeFileSync(join(output, "pending-copy.json"), JSON.stringify(pendingCopy, null, 2));
writeFileSync(join(output, "pending-copy.stdout.md"), pendingCopy.stdout);
writeFileSync(join(output, "pending-witness.json"), JSON.stringify(pendingWitness, null, 2));
writeFileSync(join(output, "pending-witness.stdout.md"), pendingWitness.stdout);
assert.deepEqual(hashes(), sourceHashes);
const result = {
  head,
  headTree,
  provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
  image: process.env.CRABBOX_IMAGE ?? null,
  lease: process.env.CRABBOX_LEASE ?? null,
  node: process.version,
  workingTreeCandidate: git("status", "--porcelain").length > 0,
  realStarted,
  realEnded: new Date().toISOString(),
  sourceHashes,
  small,
  full20k,
  mixed20k,
  pendingCopy,
  pendingWitness,
  limits:
    "Controlled selected-field GitHub/KVSQLite/R2 adapters. Actual signed metadata admissions and normal two-witness producer promotion; no SQL generation/state insertion. VIRTUAL observation cadence is not real production latency. No deployed Cloudflare/store capture/throughput/admission or binaryrollback authority. Legacyv1client runs on current server, not an oldWorker rollback.",
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    head,
    sourceUnchanged: true,
    small: {
      before: small.before.orphans,
      drift: small.drifted.orphans,
      back: small.returned.orphans,
      percent: small.returned.percent,
      recovered: small.recovered.coreComplete,
    },
    mixed20k: {
      retired: mixed20k.before.orphans,
      drift: mixed20k.drifted.orphans,
      queriesOnCountDrift: mixed20k.noQueryDuringCountDrift,
      maxDeleted: mixed20k.maxDeleted,
      recovered: mixed20k.recovered.coreComplete,
    },
    provider: result.provider,
  }),
);
