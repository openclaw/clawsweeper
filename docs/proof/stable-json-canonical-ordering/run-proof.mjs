#!/usr/bin/env node
/**
 * Real-behavior proof for the stableJson canonical-ordering fix.
 *
 * Three claims, all against the built dist/:
 *
 *   1. CANONICAL   - two objects with the same key/value set serialize identically
 *                    regardless of property-insertion order.
 *   2. BYTE-ORDER  - key order is defined by UTF-16 code unit, not by the runtime's
 *                    default locale or ICU collation tables.
 *   3. NO CHURN    - every persisted digest shape produced by the call sites that
 *                    import the locale-ordered stableJson serializes byte-identically
 *                    before and after the fix, so no stored digest is invalidated.
 *
 * Claim 3 compares against a pre-fix build of src/stable-json.ts compiled from the
 * base commit. Pass its path as argv[2]; when absent, claim 3 is reported SKIPPED
 * rather than silently passing.
 *
 * Usage: node docs/proof/stable-json-canonical-ordering/run-proof.mjs [preFixStableJson.js]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distStableJson = path.join(repoRoot, "dist", "stable-json.js");

if (!fs.existsSync(distStableJson)) {
  console.error(`missing build artifact: ${distStableJson}\nrun: pnpm run build`);
  process.exit(2);
}

const { stableJson, stableJsonCodeUnit, compareCodeUnits } = await import(`file://${distStableJson}`);

const ZERO_WIDTH_JOINER = "‍";
const SOFT_HYPHEN = "­";
const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    if (detail) console.log(`        ${detail}`);
    failures.push(label);
  }
};

/* -- Claim 1: canonical form --------------------------------------------- */

console.log("== Claim 1: insertion order cannot change the output ==\n");
for (const [name, invisible] of [
  ["zero-width joiner", ZERO_WIDTH_JOINER],
  ["soft hyphen", SOFT_HYPHEN],
]) {
  const key = `a${invisible}b`;
  const tie = key.localeCompare("ab") === 0;
  check(
    `${name}: keys collate equal under localeCompare (precondition)`,
    tie && key !== "ab",
    `localeCompare returned ${key.localeCompare("ab")}`,
  );
  const left = stableJson({ ab: 1, [key]: 2 });
  const right = stableJson({ [key]: 2, ab: 1 });
  check(`${name}: same key set serializes identically`, left === right, `${left} vs ${right}`);
}

/* -- Claim 2: byte-defined ordering --------------------------------------- */

console.log("\n== Claim 2: key order is byte-defined, not locale-defined ==\n");
check(
  'uppercase sorts before lowercase ("B" 0x42 < "a" 0x61)',
  stableJson({ a: 1, B: 2 }) === '{"B":2,"a":1}',
  stableJson({ a: 1, B: 2 }),
);
// cs-CZ collates "ch" after "h", which reorders these real digest keys.
const czechSensitive = { checksDigest: "a", commitCount: 1, changedFiles: 2 };
check(
  "cs-CZ-sensitive keys keep byte order",
  stableJson(czechSensitive) === '{"changedFiles":2,"checksDigest":"a","commitCount":1}',
  stableJson(czechSensitive),
);
check(
  "compareCodeUnits never ties distinct strings",
  compareCodeUnits("a", `a${ZERO_WIDTH_JOINER}`) !== 0 && compareCodeUnits("a", "a") === 0,
);
check("stableJsonCodeUnit is an alias", stableJsonCodeUnit(czechSensitive) === stableJson(czechSensitive));

/* -- Claim 3: no persisted-digest churn ----------------------------------- */

console.log("\n== Claim 3: persisted digest shapes are byte-identical to pre-fix ==\n");

const PERSISTED_SHAPES = {
  "itemContentDigest": {
    kind: "pull_request", source: "rev",
    timeline: [{ id: 1, event: "labeled", actor: "a", commitId: null, label: "x", rename: null, sourceIssue: null }],
    relations: { closingPullRequests: null, referencingMergedPullRequests: null, relatedItems: null },
    latestRelease: { tagName: "v1", sha: "a".repeat(40) }, releaseStateComplete: true, targetMainSha: null,
    headSha: "b".repeat(40), baseSha: "c".repeat(40),
    pullState: { draft: false, mergeable: true, mergeableState: "clean", additions: 1, deletions: 2, changedFiles: 3 },
    diff: [{ filename: "a.ts", additions: 1, deletions: 0 }], commits: "rev2",
    reviewComments: [{ id: 1, author: "x", authorAssociation: "NONE", body: "b" }],
    checks: { complete: true, checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }], checkRunsTruncated: false, statuses: [], statusesTruncated: false },
  },
  "itemSnapshotHash": {
    item: { repo: "o/r", number: 1, kind: "issue", title: "t", url: "u", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", author: "a", labels: ["bug"] },
    context: { pullRequest: { head: { sha: "a" }, base: { sha: "b" }, draft: false, mergeable: true, mergeableState: "clean", additions: 1, deletions: 1, changedFiles: 1 }, counts: { pullCommits: 1 } },
  },
  "reviewCommentContentRevision": [{ id: 1, author: "x", authorAssociation: "NONE", body: "b" }, { omitted: 3 }],
  "pullCommitContentRevision": [{ author: "a", message: "m" }, { author: "b", message: "n" }],
  "reviewTimelineDigestParts": [{ id: 1, event: "labeled", actor: "a", commitId: null, label: "x", rename: null, sourceIssue: null }],
  "pullChecksDigestParts": {
    complete: true,
    checkRuns: [{ name: "ci", status: "completed", conclusion: "success", detailsUrl: null, startedAt: "t", completedAt: "u" }],
    checkRunsTruncated: false, statuses: [{ context: "c", state: "success", description: "d" }], statusesTruncated: false,
  },
  "action-ledger invocation id": { command: "plan", args: { batch_size: 10, items_dir: "x" } },
};

const preFixPath = process.argv[2];
if (!preFixPath) {
  console.log("  SKIPPED  no pre-fix build supplied (argv[2]); churn not measured");
  failures.push("claim 3 not measured");
} else if (!fs.existsSync(preFixPath)) {
  console.log(`  FAIL     pre-fix build not found: ${preFixPath}`);
  failures.push("claim 3 pre-fix build missing");
} else {
  const pre = await import(`file://${path.resolve(preFixPath)}`);
  for (const [name, value] of Object.entries(PERSISTED_SHAPES)) {
    const before = pre.stableJson(value);
    const after = stableJson(value);
    check(`${name} byte-identical`, before === after, `pre : ${before}\n        post: ${after}`);
  }
}

console.log(`\nRESULT: ${failures.length === 0 ? "PASS" : "FAIL"}`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
