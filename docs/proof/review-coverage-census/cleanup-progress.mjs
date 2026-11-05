// Controlled actual CLI -> signed Worker/DO. Real20k/25/200/128 limits.
// No live GitHub/model/production calls, clocks/caps or stored rows patched.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cleanupProgressScenario,
  noWorkProgressScenario,
} from "../../../test/fixtures/review-coverage-cleanup.ts";
const root = resolve(import.meta.dirname, "../../.."),
  output = resolve(
    process.env.CENSUS_CLEANUP_OUTPUT ?? ".openclaw/tmp/census-cleanup-progress-proof",
  ),
  realStarted = new Date().toISOString(),
  git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
  head = git("rev-parse", "HEAD"),
  tree = git("rev-parse", "HEAD^{tree}"),
  workingTreeCandidate = git("status", "--porcelain").length > 0;
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
mkdirSync(output, { recursive: true });
const sourceFiles = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "src/review-coverage-census.ts",
    "src/repair/review-coverage-census.ts",
    "src/repair/target-fanout.ts",
    "dashboard/review-coverage-census.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/worker.ts",
    "test/fixtures/review-coverage-cli.ts",
    "test/fixtures/review-coverage-census.ts",
    "test/fixtures/fleet-coverage-query.ts",
    "test/fixtures/review-coverage-cleanup.ts",
    "docs/proof/review-coverage-census/cleanup-progress.mjs",
    "dist/repair/review-coverage-census.js",
    "dist/repair/target-fanout.js",
  ],
  hashes = () =>
    Object.fromEntries(
      sourceFiles.map((p) => [
        p,
        createHash("sha256")
          .update(readFileSync(join(root, p)))
          .digest("hex"),
      ]),
    ),
  sourceHashes = hashes();
const full = await cleanupProgressScenario(),
  mixed = await cleanupProgressScenario({ count: 20_000, mixed: true, interrupt: true }),
  idle = await noWorkProgressScenario();
assert.deepEqual(hashes(), sourceHashes);
for (const [name, record] of [
  ["full20k", full],
  ["mixed20k-interrupted", mixed],
  ["no-progress", idle],
])
  writeFileSync(join(output, name + ".json"), JSON.stringify(record, null, 2));
for (const [name, record] of [
  ["full20k", full],
  ["mixed20k-interrupted", mixed],
])
  writeFileSync(
    join(output, name + "-control.csv"),
    [
      "phase,path,orphans_before,orphans_after,removed,identity_queries,pending,work",
      ...record.trace.map((r) =>
        [
          r.phase,
          r.path,
          r.orphansBefore,
          r.orphansAfter,
          r.removed,
          r.identityQueries,
          r.response?.pending,
          r.response?.work?.length,
        ]
          .map((v) => JSON.stringify(v ?? null))
          .join(","),
      ),
    ].join("\n") + "\n",
  );
const result = {
  head,
  tree,
  workingTreeCandidate,
  provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
  image: process.env.CRABBOX_IMAGE ?? null,
  lease: process.env.CRABBOX_LEASE ?? null,
  node: process.version,
  realStarted,
  realEnded: new Date().toISOString(),
  maxRssKiB: process.resourceUsage().maxRSS,
  sourceHashes,
  full,
  mixed,
  idle,
  limits:
    "Controlled raw GitHub adapter, actual CLI/signed Worker/DO/storage.20k split across2 connections at virtual20-minute opportunities; no single20k-connection or production latency guarantee. Orphan retirement is real generation promotion followed by a lost control ACK, not manual SQLite edits.6h/13h are observer evaluations of the unchanged qualified window. No clocks/quotas/alarms/TTL/admission/canonical facts changed.",
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    head,
    provider: result.provider,
    full: {
      retired: full.coreOrphansAtRetirement,
      remaining: full.coreOrphansAfter,
      nexts: full.cleanup.nexts,
      identityQueries: full.cleanupQueries,
      maxRows: full.maxDeletedPerCall,
      short: full.shortBatches,
    },
    mixed: {
      retired: mixed.coreOrphansAtRetirement,
      remaining: mixed.coreOrphansAfter,
      interrupted: mixed.interrupted,
      identityQueries: mixed.cleanupQueries,
      maxRows: mixed.maxDeletedPerCall,
    },
    idle,
    sourceUnchanged: true,
    maxRssKiB: result.maxRssKiB,
  }),
);
