#!/usr/bin/env node
/**
 * Real-behavior proof for the scheduler duplicate-candidate stranding fix.
 *
 * Drives the SHIPPED planner path, not just the pure comparator:
 *
 *   createReviewPlanningSelection(...).selectCandidates()
 *     -> src/clawsweeper-review-planning-selection.ts:90-111
 *     -> selectDueCandidates()  (src/scheduler-policy.ts)
 *
 * The only injected behavior is `fetchOpenItemPage`, which reproduces the real
 * GitHub artifact that triggers this: the paginated issue listing is sorted by
 * `updated`, so an item touched mid-pagination shifts pages and is returned
 * twice. Everything downstream is the real planner.
 *
 * Pre-fix the planner silently returns a truncated batch; post-fix it returns
 * every distinct due item.
 *
 * Usage: node docs/proof/scheduler-duplicate-candidate-stranding/run-proof.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distPlanner = path.join(repoRoot, "dist", "clawsweeper-review-planning-selection.js");

if (!fs.existsSync(distPlanner)) {
  console.error(`missing build artifact: ${distPlanner}\nrun: pnpm run build`);
  process.exit(2);
}

const { createReviewPlanningSelection } = await import(`file://${distPlanner}`);

// selectCandidates() calls selectDueCandidates() without a `now` argument, so the
// scheduler uses the real Date.now(). Anchor to it: a candidate reviewed an hour
// ago is NOT weekly-coverage-due (that lane needs 6 days), so selection falls
// through to the weighted drain loop this proof is about. Using a fixed past
// timestamp instead would route everything through the coverage preselect lane,
// which takes candidates in a plain loop and never exercises the defect.
const REVIEWED_AT = Date.now() - 60 * 60 * 1000;
const REPO = "openclaw/openclaw";

const makeItem = (number) => ({
  repo: REPO,
  number,
  kind: "issue",
  title: `Item ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
  author: "contributor",
  authorAssociation: "NONE",
  labels: [],
});

/**
 * Two pages of open issues. #1 is touched between the two reads, so GitHub's
 * `updated`-sorted listing shifts it onto page 2 as well - it is returned twice.
 */
const pagesWithDuplicate = [
  [makeItem(1), makeItem(2)],
  [makeItem(1), makeItem(3)],
];

/** Same distinct items, no pagination race. */
const pagesWithoutDuplicate = [
  [makeItem(1), makeItem(2)],
  [makeItem(3)],
];

const buildPlanner = (pages) =>
  createReviewPlanningSelection({
    maxPlanShardCount: 8,
    targetRepo: () => REPO,
    shouldPlanItem: () => true,
    buildExistingReviewIndex: () => new Map(),
    fetchOpenItemPage: (page) => pages[page - 1] ?? [],
    fetchHotIntakeItems: () => ({ items: [], pagesScanned: 0 }),
    fetchItem: () => ({ item: null, state: "open" }),
    shouldSkipScheduledHotIntakeExactReview: () => false,
    reviewBackfillCandidate: () => null,
    // Every item is due, in the weight-1 weekly_issue bucket, already reviewed
    // recently enough that the weekly-coverage preselect lane does not claim it.
    dueCandidate: (item) => ({
      item,
      review: { reviewStatus: "complete", reviewedAt: new Date(REVIEWED_AT).toISOString() },
      priority: 6,
      reviewedAt: REVIEWED_AT,
      nextDueAt: 0,
      bucket: "weekly_issue",
      coverageTracked: true,
    }),
  });

const run = (pages) =>
  buildPlanner(pages)
    .selectCandidates({
      batchSize: 10, // capacity far above the 3 distinct due items
      maxPages: pages.length,
      shardIndex: 0,
      shardCount: 1,
      itemsDir: path.join(repoRoot, "does-not-exist"),
    })
    .candidates.map((item) => item.number);

const control = run(pagesWithoutDuplicate);
const subject = run(pagesWithDuplicate);

const expected = [1, 2, 3];
const sameSet = (left, right) =>
  left.length === right.length && [...left].sort().every((value, i) => value === [...right].sort()[i]);

console.log("== planner selectCandidates(), batchSize 10, 3 distinct due items ==\n");
console.log(`  control  (no pagination race)  -> [${control.join(", ")}]`);
console.log(`  subject  (#1 returned twice)   -> [${subject.join(", ")}]`);
console.log(`  expected                       -> [${expected.join(", ")}]\n`);

const controlOk = sameSet(control, expected);
const subjectOk = sameSet(subject, expected);
const noDuplicates = new Set(subject).size === subject.length;

console.log(`  control selects every due item : ${controlOk ? "yes" : "NO"}`);
console.log(`  subject selects every due item : ${subjectOk ? "yes" : "NO  <- stranded"}`);
console.log(`  subject is still deduplicated  : ${noDuplicates ? "yes" : "NO  <- duplicate leaked"}\n`);

const passed = controlOk && subjectOk && noDuplicates;
console.log(`RESULT: ${passed ? "PASS" : "FAIL"}`);
console.log(
  passed
    ? "  A duplicated page entry no longer costs the batch its remaining candidates."
    : "  The pagination duplicate truncated the batch (pre-fix behavior).",
);
process.exit(passed ? 0 : 1);
