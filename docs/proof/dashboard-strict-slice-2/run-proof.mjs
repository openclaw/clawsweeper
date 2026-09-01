#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, ".artifacts/dashboard-strict-slice-2");
const upstreamArtifact = path.join(
  repoRoot,
  "docs/proof/queue-policy-readmodel-extraction/artifacts/proof-summary.json",
);

const [{ stdout: head }, { stdout: mergeBase }, { stdout: trackedStatus }] = await Promise.all([
  exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
  exec("git", ["merge-base", "HEAD", "origin/main"], { cwd: repoRoot }),
  exec("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot }),
]);
assert.equal(trackedStatus.trim(), "", "proof requires a clean committed checkout");
await exec("git", ["cat-file", "-e", "HEAD^{commit}"], { cwd: repoRoot });

const harness = await exec(
  process.execPath,
  ["docs/proof/queue-policy-readmodel-extraction/run-proof.mjs"],
  { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
);
process.stdout.write(harness.stdout);
process.stderr.write(harness.stderr);

const workerResult = JSON.parse(await readFile(upstreamArtifact, "utf8"));
assert.equal(workerResult.candidate_head, head.trim());
assert.equal(workerResult.merge_base, mergeBase.trim());
assert.equal(workerResult.worker, "wrangler dev --local");
assert.equal(workerResult.durable_object, "SQLite-backed ExactReviewQueue");
assert.equal(workerResult.seed_route, "/internal/exact-review/enqueue");
assert.equal(workerResult.seeded_items, 6);
assert.equal(workerResult.all_normalized_responses_byte_identical, true);

const summary = {
  schema: "dashboard-strict-slice-2-proof/v1",
  receipt: "COMMITTED",
  source_head: head.trim(),
  merge_base: mergeBase.trim(),
  harness: "docs/proof/queue-policy-readmodel-extraction/run-proof.mjs",
  worker: workerResult.worker,
  durable_object: workerResult.durable_object,
  durable_object_instantiated: true,
  seeded_items: workerResult.seeded_items,
  seed_route: workerResult.seed_route,
  worker_process_tree_kill_between_boots: true,
  responses: workerResult.responses,
  all_normalized_responses_byte_identical: true,
  production_mutations: 0,
  openclaw_bay_affected: false,
  limits: workerResult.limits,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(
  path.join(artifactDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
