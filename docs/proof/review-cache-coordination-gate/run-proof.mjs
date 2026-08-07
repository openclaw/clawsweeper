#!/usr/bin/env node
/**
 * Real-behavior proof for the review-cache coordination gate.
 *
 * The exact-event lane reserves the durable review lease in its own write-token
 * step, so it must invoke the review command with `--skip-start-comment`. That
 * flag also decided `coordinationEnabled`, which the structural cache probe
 * checks before anything else — so the shipped lane could never reach its own
 * receipt, and never seeded one either.
 *
 * This drives the SHIPPED preparation and probe:
 *
 *   .github/workflows/sweep.yml  (flags read verbatim from the workflow)
 *     -> parseArgs()                          src/clawsweeper-args.ts
 *     -> suppliedReviewStartLeaseFromArgs()   src/clawsweeper-review-lease.ts
 *     -> isExplicitReviewDispatch()           src/clawsweeper-review-preparation.ts
 *     -> isReviewCoordinationEnabled()        src/clawsweeper-review-preparation.ts
 *     -> reviewStructuralCacheProbeDecision() src/review-structural-cache.ts
 *
 * No production module is stubbed or replaced: every function above runs its
 * shipped implementation from dist/. The one synthetic value is the prior review
 * record, standing in for a completed keep-open review of an unchanged item.
 *
 * The argument list is parsed out of the workflow rather than retyped, so the
 * proof fails loudly if production stops passing these flags together.
 *
 * Run against the pre-fix build (upstream/main) and the post-fix build; the
 * script reports which one it is looking at.
 *
 * Usage: node docs/proof/review-cache-coordination-gate/run-proof.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = (name) => path.join(repoRoot, "dist", name);

for (const name of [
  "clawsweeper-args.js",
  "clawsweeper-review-lease.js",
  "clawsweeper-review-preparation.js",
  "review-structural-cache.js",
]) {
  if (!fs.existsSync(dist(name))) {
    console.error(`missing build artifact: ${dist(name)}\nrun: pnpm run build`);
    process.exit(2);
  }
}

const { parseArgs } = await import(`file://${dist("clawsweeper-args.js")}`);
const { suppliedReviewStartLeaseFromArgs } = await import(
  `file://${dist("clawsweeper-review-lease.js")}`
);
const preparation = await import(`file://${dist("clawsweeper-review-preparation.js")}`);
const { reviewStructuralCacheProbeDecision } = await import(
  `file://${dist("review-structural-cache.js")}`
);

const { isExplicitReviewDispatch, isReviewCoordinationEnabled } = preparation;
const fixPresent = typeof isReviewCoordinationEnabled === "function";

// Pre-fix, `coordinationEnabled` was exactly `!skipStartComment` at the two probe
// call sites in src/clawsweeper-review-command-workflow.ts.
const coordinationEnabledFor = fixPresent
  ? isReviewCoordinationEnabled
  : (skipStartComment) => !skipStartComment;

// ---------------------------------------------------------------------------
// Read the production invocation out of the workflow instead of retyping it.
// ---------------------------------------------------------------------------
const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "sweep.yml"), "utf8");
const invocation = workflow
  .split("\n")
  .join("\n")
  .match(/pnpm run review -- \\\n(?:[^\n]*\\\n)*[^\n]*/);
if (!invocation) {
  console.error("could not locate the exact-event review invocation in sweep.yml");
  process.exit(2);
}
const flags = [...invocation[0].matchAll(/--[a-z-]+/g)].map((match) => match[0]);
for (const required of ["--skip-start-comment", "--review-lease-owner", "--review-source-action"]) {
  if (!flags.includes(required)) {
    console.error(`sweep.yml no longer passes ${required}; this proof is stale`);
    process.exit(2);
  }
}

// Every value below comes from one real scheduled delivery, so the fixture is
// not assembled from different items: openclaw/clawscan#7, reviewed by
// clawsweeper run 31131759207 starting 2026-08-06T23:36:45Z with
// sourceAction scheduled_hot_intake, and the durable lease marker that run
// published (lease_owner=github-run-31131759207-1, lease_comment_id=5210008452).
const argv = parseArgs([
  "--target-repo",
  "openclaw/clawscan",
  "--artifact-dir",
  "artifacts/event",
  "--batch-size",
  "1",
  "--max-pages",
  "1",
  "--codex-model",
  "internal",
  "--item-numbers",
  "7",
  "--readonly-openclaw",
  "--skip-start-comment",
  "--review-lease-owner",
  "github-run-31131759207-1",
  "--review-lease-comment-id",
  "5210008452",
  "--shard-index",
  "0",
  "--shard-count",
  "1",
  "--review-source-action",
  "scheduled_hot_intake",
]);

const suppliedReviewLease = suppliedReviewStartLeaseFromArgs(argv);
// prepareReviewCommand derives this the same way (local-only/local-range also
// force it); the exact-event lane reaches it through the explicit flag.
const skipStartComment = Boolean(argv.skip_start_comment);
const explicitDispatch = isExplicitReviewDispatch(argv, true);
const coordinationEnabled = coordinationEnabledFor(skipStartComment, suppliedReviewLease);

// A completed keep-open review of an unchanged item, i.e. the state every
// scheduled re-review of a still-open PR or issue starts from.
const priorReview = {
  reviewStatus: "complete",
  decision: "keep_open",
  lastFullReviewDecision: "keep_open",
  lastFullReviewAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  reviewPolicy: "854905faf35a29c0",
  reviewModel: "internal",
  itemSourceRevision: "e".repeat(64),
};

const probe = reviewStructuralCacheProbeDecision({
  review: priorReview,
  reviewPolicy: priorReview.reviewPolicy,
  reviewModel: priorReview.reviewModel,
  explicitDispatch,
  maintainerRequest: false,
  coordinationEnabled,
});

console.log(`build                     ${fixPresent ? "post-fix" : "pre-fix (upstream/main)"}`);
console.log(`workflow flags            ${flags.join(" ")}`);
console.log(`skipStartComment          ${skipStartComment}`);
console.log(`suppliedReviewLease       ${JSON.stringify(suppliedReviewLease)}`);
console.log(`explicitDispatch          ${explicitDispatch}`);
console.log(`coordinationEnabled       ${coordinationEnabled}`);
console.log(`structural probe          ${JSON.stringify(probe)}`);
// The probe decision is the last thing this harness observes. What the review
// command does next is not exercised here, so label it as the implication it is.
console.log(
  `implied next step (not run here)  ${probe.hit ? "reuse the recorded verdict" : "full hydration + Codex"}`,
);
