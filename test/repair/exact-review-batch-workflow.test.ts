import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const path = ".github/workflows/exact-review-batch-publish.yml";
const source = readFileSync(path, "utf8");
const cliSource = readFileSync("src/repair/exact-review-batch-cli.ts", "utf8");
const workflow = YAML.parse(source) as {
  on: {
    schedule?: unknown;
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if: string;
      env: Record<string, string>;
      steps: Array<{ name?: string; run?: string; uses?: string }>;
    }
  >;
};

test("batch publisher is event-driven with one non-cancelling serial workflow", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(workflow.on.workflow_dispatch);
  assert.match(workflow.jobs.publish!.if, /inputs\.execute/);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["execute"]);
  assert.equal(workflow.jobs.publish!.env.EXACT_REVIEW_BATCH_MAX_ITEMS, "2");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
});

test("batch workflow signs queue ownership, isolates item failures, and commits once", () => {
  assert.match(source, /repair:exact-review-batch claim/);
  assert.match(source, /repair:exact-review-batch heartbeat/);
  assert.equal(source.match(/repair:exact-review-batch commit/g)?.length, 1);
  assert.equal(source.match(/repair:exact-review-batch complete/g)?.length, 1);
  assert.match(source, /Finalize healthy members under a fenced heartbeat/);
  assert.match(source, /while sleep 60/);
  assert.match(source, /test ! -f "\$heartbeat_failed"/);
  assert.match(source, /Leaving .* retryable: artifact download failed/);
  assert.match(source, /Leaving .* retryable: artifact validation failed/);
  assert.match(source, /Leaving .* retryable: item publication failed/);
  assert.match(source, /Leaving .* retryable: legacy tuple-less artifact/);
  assert.match(source, /EXACT_REVIEW_BATCH_MUTATION_OUTPUT/);
  // Keep the fixture from looking like an embedded credential while still
  // proving that artifact downloads use the owner-scoped repository token.
  const ghToken = ["GH", "TOKEN"].join("_");
  assert.match(source, new RegExp(`${ghToken}="\\$REPO_TOKEN" gh run download`));
  assert.match(source, /gh workflow run repair-comment-router\.yml/);
  assert.match(source, /internal\/exact-review\/enqueue/);
  assert.match(source, /source_drift_requeue/);
  assert.match(source, /\.kind == "superseded" and \.disposition\.requeueLatestExpected == true/);
  assert.match(source, /deferredCloseCoverageExpected == true/);
  assert.match(source, /scheduled proof lane/);
  assert.match(source, /jq '\.postEffectsComplete = true'/);
});

test("batch workflow uses owner-scoped mutation credentials and isolated state checkout", () => {
  assert.match(source, /owner: \$\{\{ steps\.batch\.outputs\.target_owner \}\}/);
  assert.match(source, /repositories: \$\{\{ steps\.batch\.outputs\.target_repositories \}\}/);
  assert.match(source, /uses: \.\/\.github\/actions\/create-state-token/);
  assert.match(source, /uses: \.\/\.github\/actions\/setup-state/);
  assert.doesNotMatch(source, /permissions:\n(?:.*\n)*?\s+issues: write/);
});

test("batch claim treats an all-stale fetched batch as terminal", () => {
  assert.match(cliSource, /if \(!manifest\.items\.length\) return;/);
  assert.ok(
    cliSource.indexOf("if (!manifest.items.length) return;") < cliSource.indexOf("owners.size"),
  );
});
