#!/usr/bin/env node
/**
 * Real-behavior proof for the repository-slug case-sensitivity fix.
 *
 * Three claims, all against the built dist/:
 *
 *   1. RESOLVES  - automergeOutcomeReviewedShaFromResult() returns the reviewed
 *                  head when canonical_pr names the same repository with
 *                  different casing. Pre-fix it returned null.
 *   2. BOUNDED   - a genuinely different repository is still rejected, so the
 *                  fix cannot widen into cross-repository head borrowing. This
 *                  must hold both before and after.
 *   3. CONSISTENT- every module that compares a parsed repository slug now uses
 *                  the shared comparator, so no equivalent site is left behind.
 *
 * Claim 1 compares against a pre-fix build when one is supplied as argv[2];
 * without it, the before/after contrast is reported SKIPPED rather than assumed.
 *
 * Usage: node docs/proof/automerge-repo-case-sensitivity/run-proof.mjs [preFixDistRepairDir]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distRepair = path.join(repoRoot, "dist", "repair");
const distOutcome = path.join(distRepair, "automerge-outcome.js");

if (!fs.existsSync(distOutcome)) {
  console.error(`missing build artifact: ${distOutcome}\nrun: pnpm run build:repair`);
  process.exit(2);
}

const { automergeOutcomeReviewedShaFromResult } = await import(`file://${distOutcome}`);
const { sameRepoSlug } = await import(`file://${path.join(distRepair, "github-ref.js")}`);

const HEAD = "92dca8fde03aee8da56a84a011fa387b9c1640fe";
const REPO = "openclaw/openclaw";
const TARGET = 83707;
const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    if (detail) console.log(`        ${detail}`);
    failures.push(label);
  }
};

const resolve = (impl, canonicalPr) =>
  impl({
    repo: REPO,
    target: TARGET,
    result: { repo: REPO, canonical_pr: canonicalPr, fix_artifact: null },
    targetView: { headRefOid: HEAD },
  });

/* -- Claim 1: case-differing slug resolves ------------------------------- */

console.log("== Claim 1: a slug differing only by case resolves the reviewed head ==\n");
const CASE_VARIANTS = [
  `https://github.com/OpenClaw/OpenClaw/pull/${TARGET}`,
  `https://github.com/openclaw/OPENCLAW/pull/${TARGET}`,
  `https://GitHub.com/OpenClaw/openclaw/pull/${TARGET}`,
];
check(
  "control: exact-case canonical_pr resolves",
  resolve(automergeOutcomeReviewedShaFromResult, `https://github.com/${REPO}/pull/${TARGET}`) === HEAD,
);
for (const url of CASE_VARIANTS) {
  check(`resolves ${url}`, resolve(automergeOutcomeReviewedShaFromResult, url) === HEAD);
}

/* -- Claim 2: cross-repository borrowing still rejected ------------------ */

console.log("\n== Claim 2: a different repository is still rejected ==\n");
for (const url of [
  `https://github.com/openclaw/other-repo/pull/${TARGET}`,
  `https://github.com/OtherOwner/OpenClaw/pull/${TARGET}`,
  `https://github.com/openclaw/openclaw-state/pull/${TARGET}`,
]) {
  check(`rejects ${url}`, resolve(automergeOutcomeReviewedShaFromResult, url) === null);
}
check(
  "an absent slug never satisfies a repository guard",
  sameRepoSlug(undefined, undefined) === false && sameRepoSlug("", "") === false,
);

/* -- Claim 3: no equivalent comparison site left behind ------------------ */

console.log("\n== Claim 3: every parsed-slug comparison uses the shared comparator ==\n");
const CONSUMERS = [
  "automerge-outcome.js",
  "execute-fix-github.js",
  "execute-fix-artifact.js",
  "post-flight.js",
  "source-pr-checkout.js",
  "target-validation.js",
];
// A parsed slug compared with === / !== instead of sameRepoSlug is the defect.
const LEFTOVER = /(?:parsed|canonicalPr|sourcePr)(?:\?)?\.repo\s*(?:===|!==)/;
for (const file of CONSUMERS) {
  const full = path.join(distRepair, file);
  if (!fs.existsSync(full)) {
    check(`${file} present`, false, "build artifact missing");
    continue;
  }
  const src = fs.readFileSync(full, "utf8");
  const leftover = src.match(new RegExp(LEFTOVER.source, "g")) ?? [];
  check(
    `${file}: no case-sensitive parsed-slug comparison`,
    leftover.length === 0,
    leftover.length ? `found: ${leftover.join(", ")}` : undefined,
  );
}

/* -- Before/after contrast ------------------------------------------------ */

console.log("\n== Before/after against a pre-fix build ==\n");
const preFixDir = process.argv[2];
if (!preFixDir) {
  console.log("  SKIPPED  no pre-fix build supplied (argv[2]); contrast not measured");
  failures.push("before/after not measured");
} else {
  const preOutcome = path.join(path.resolve(preFixDir), "automerge-outcome.js");
  if (!fs.existsSync(preOutcome)) {
    check("pre-fix build present", false, preOutcome);
  } else {
    const pre = await import(`file://${preOutcome}`);
    const url = CASE_VARIANTS[0];
    const before = resolve(pre.automergeOutcomeReviewedShaFromResult, url);
    const after = resolve(automergeOutcomeReviewedShaFromResult, url);
    console.log(`  ${url}`);
    console.log(`    pre-fix : ${before === null ? "null  (reviewed SHA dropped)" : before}`);
    console.log(`    post-fix: ${after}`);
    check("pre-fix dropped the reviewed SHA", before === null);
    check("post-fix resolves the reviewed SHA", after === HEAD);
    // The bounded claim must hold in BOTH builds.
    const crossRepo = `https://github.com/openclaw/other-repo/pull/${TARGET}`;
    check(
      "cross-repository rejection unchanged by the fix",
      resolve(pre.automergeOutcomeReviewedShaFromResult, crossRepo) === null &&
        resolve(automergeOutcomeReviewedShaFromResult, crossRepo) === null,
    );
  }
}

console.log(`\nRESULT: ${failures.length === 0 ? "PASS" : "FAIL"}`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
