import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("gitcrawl readers prefer portable gitcrawl-store before legacy local DB", () => {
  const sources = [
    readFileSync("src/clawsweeper.ts", "utf8"),
    readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8"),
    readFileSync("src/repair/import-gitcrawl-low-signal-prs.ts", "utf8"),
  ];

  for (const source of sources) {
    assert.match(source, /CLAWSWEEPER_GITCRAWL_DB/);
    assert.match(source, /gitcrawl-store/);
    assert.match(source, /\.sync\.db/);
    assert.match(source, /replace\(/);
    assert(source.indexOf("gitcrawl-store") < source.indexOf('.config", "gitcrawl", "gitcrawl.db'));
  }
});

test("gitcrawl docs describe external store freshness instead of per-run crawling", () => {
  const relatedDocs = readFileSync("docs/related-issue-discovery.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");

  assert.match(relatedDocs, /does not run a gitcrawl fetch\s+or download issues during review/);
  assert.match(relatedDocs, /git pull --ff-only/);
  assert.match(repairDocs, /does not crawl or download\s+issues during repair import/);
  assert.match(repairDocs, /git -C \.\.\/gitcrawl-store pull --ff-only/);
});

test("gitcrawl cluster intake delegates candidate quality to the selector model", () => {
  const source = readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8");
  const selector = readFileSync("src/repair/select-cluster-candidate.ts", "utf8");
  const limitsDocs = readFileSync("docs/limits.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");

  assert.match(source, /const allowEmpty = Boolean\(args\["allow-empty"\]\)/);
  assert.match(source, /const allowInstantClose = booleanArg\("allow-instant-close", false\)/);
  assert.doesNotMatch(source, /skip-closed-percent|selection score|rankGitcrawlCluster/);
  assert.match(selector, /select at most one, or select none/i);
  assert.match(limitsDocs, /selector model compares/);
  assert.match(repairDocs, /selector model compares/);
});

test("scheduled cluster repair intake follows gitcrawl-store freshness cadence", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  const limitsDocs = readFileSync("docs/limits.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");
  const internalDocs = readFileSync("docs/repair/internal-features.md", "utf8");

  assert.match(workflow, /cron: "8 8 \* \* \*"/);
  assert.match(workflow, /gitcrawl-store refreshes openclaw\/openclaw every 15 minutes/);
  assert.match(workflow, /last_processed_store_sha256/);
  assert.match(workflow, /CLAWSWEEPER_CLUSTER_REPAIR_CANDIDATE_BATCH \|\| '8'/);
  assert.match(workflow, /repair:select-cluster-candidate/);
  assert.match(workflow, /repair:publish-cluster-intake/);
  assert.match(workflow, /owner: \$\{\{ steps\.target\.outputs\.owner \}\}/);
  assert.match(workflow, /repositories: \$\{\{ steps\.target\.outputs\.name \}\}/);
  assert.match(workflow, /gh workflow run state-materializer\.yml --ref main/);
  assert.doesNotMatch(workflow, /pnpm run repair:dispatch/);
  assert.doesNotMatch(workflow, /git pull --rebase origin main/);
  assert.match(limitsDocs, /one cluster or rejects the batch/);
  assert.match(repairDocs, /intake runs daily/);
  assert.match(internalDocs, /refreshes `openclaw\/openclaw` every 15\s+minutes/);
});

test("gitcrawl cluster import is not blocked by the scheduled intake gate", () => {
  const source = readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8");
  const lowSignalSource = readFileSync("src/repair/import-gitcrawl-low-signal-prs.ts", "utf8");
  const dispatchJobs = readFileSync("src/repair/dispatch-jobs.ts", "utf8");

  assert.doesNotMatch(source, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  assert.doesNotMatch(lowSignalSource, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
  assert.doesNotMatch(dispatchJobs, /CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED/);
});
