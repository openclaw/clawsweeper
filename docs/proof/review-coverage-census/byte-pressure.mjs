// Node >=24, controlled signed producer/Worker/DO, real 32MiB quotas.
// Estimated ~20-40 seconds and <1GiB RSS on a normal Linux validation host.
// No live GitHub/Worker/model calls; no source constants or quotas are patched.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runBytePressureScenario } from "../../../test/fixtures/review-coverage-byte-pressure.ts";
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
const output = resolve(
  process.env.CENSUS_BYTE_PRESSURE_OUTPUT ??
    ".openclaw/tmp/census-byte-pressure-fix/runtime-byte-pressure",
);
mkdirSync(output, { recursive: true });
const files = [
  "dashboard/review-coverage-census.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/worker.ts",
  "src/review-coverage-census.ts",
  "src/repair/review-coverage-census.ts",
  "test/fixtures/review-coverage-byte-pressure.ts",
  "test/fixtures/review-coverage-census.ts",
  "docs/proof/ui-live-coverage/coverage-authority-fixture.mjs",
  "docs/proof/review-coverage-census/byte-pressure.mjs",
  "dist/repair/review-coverage-census.js",
];
const hashes = () =>
    Object.fromEntries(
      files.map((p) => [p, createHash("sha256").update(readFileSync(p)).digest("hex")]),
    ),
  sourceHashes = hashes(),
  head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  realStarted = new Date().toISOString();
const scenarios = [];
for (const [name, options] of [
  ["replacement-growth-rollback-overcap", { fault: true, overcap: true }],
  [
    "existing-growth-multibatch",
    { fault: false, overcap: false, growthOnExisting: true, tinyPrefix: true },
  ],
]) {
  const result = await runBytePressureScenario(options);
  result.head = head;
  scenarios.push({ name, ...result });
  writeFileSync(join(output, name + ".json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(output, name + "-progress.csv"),
    "at,queries,failed,generation,pass,count,storedCompletePointer\n" +
      result.metrics.frames
        .map((f) =>
          [
            f.at,
            f.queries,
            f.failed,
            f.generation,
            f.pass ?? "",
            f.count ?? "",
            f.storedCompletePointer,
          ].join(","),
        )
        .join("\n") +
      "\n",
  );
}
assert.deepEqual(hashes(), sourceHashes);
const provenance = {
  head,
  headTree,
  base: "03e24309cf919bf866bb2ffe2551beca27fd9bb3",
  provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
  image: process.env.CRABBOX_IMAGE ?? null,
  lease: process.env.CRABBOX_LEASE ?? null,
  node: process.version,
  realStarted,
  realEnded: new Date().toISOString(),
  maxRssKiB: process.resourceUsage().maxRSS,
  sourceHashes,
  scenarios,
  limits:
    "Actual shared producer -> fixed-purpose HMAC Worker -> DO/SQLite with controlled GH/storage/clock. Real 20k/32MiB/64MiB/chunk/wire limits, no quota patches. Transaction-level logical bytes measured from SQL, not physical WAL/disk peak; no live/deployed/current-production or CLI-admission capability claim. Existing normal/hot/audit/coverage CLI budget scenarios remain separate mandatory proof.",
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(provenance, null, 2));
console.log(
  JSON.stringify(
    {
      head,
      maxRssKiB: provenance.maxRssKiB,
      scenarios: scenarios.map((s) => ({
        name: s.name,
        logicalCount: s.logicalCount,
        firstPassBytes: s.firstPassBytes,
        completeBytes: s.completeBytes,
        generation: s.generation,
        rollback: s.rollbackExact,
        replay: s.replayExact,
        staleCAS: s.casExact,
        maxStagingBytes: s.metrics.maxTransactionalStagingBytes,
        maxResidentBytes: s.metrics.maxTransactionalResidentBytes,
        maxReclaimedRowsPerInsert: s.metrics.maxReclaimedRowsPerInsert,
        failedStatuses: s.metrics.failedStatuses,
        unsupported: s.unsupported,
        canonicalUnchanged: s.canonicalUnchanged,
        admissionUnchanged: s.admissionUnchanged,
      })),
    },
    null,
    2,
  ),
);
