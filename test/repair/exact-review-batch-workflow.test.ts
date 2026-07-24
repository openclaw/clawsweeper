import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const path = ".github/workflows/exact-review-batch-publish.yml";
const source = readFileSync(path, "utf8");
const cliSource = readFileSync("src/repair/exact-review-batch-cli.ts", "utf8");
const prepareSource = readFileSync("scripts/prepare-exact-review-batch.mjs", "utf8");
const publisherSource = readFileSync("src/repair/publish-event-result.ts", "utf8");
const workflow = YAML.parse(source) as {
  on: {
    schedule?: unknown;
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if: string;
      env: Record<string, string>;
      steps: Array<{ name?: string; run?: string; uses?: string }>;
    }
  >;
};

test("batch publisher is event-driven and queue-bounded instead of workflow-serialized", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(workflow.on.workflow_dispatch);
  assert.match(workflow.jobs.publish!.if, /inputs\.execute/);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["execute"]);
  assert.equal(workflow.jobs.publish!.env.EXACT_REVIEW_BATCH_MAX_ITEMS, "50");
  assert.equal(workflow.jobs.publish!.env.EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY, "4");
  assert.equal(workflow.jobs.publish!.env.CLAWSWEEPER_APP_CLIENT_ID, "Iv23liOECG0slfuhz093");
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
});

test("batch workflow signs queue ownership, isolates item failures, and commits once", () => {
  assert.match(source, /repair:exact-review-batch claim/);
  assert.match(source, /repair:exact-review-batch heartbeat/);
  assert.equal(source.match(/repair:exact-review-batch commit/g)?.length, 1);
  assert.equal(source.match(/repair:exact-review-batch complete/g)?.length, 1);
  assert.equal(source.match(/repair:exact-review-batch release/g)?.length, 1);
  assert.match(source, /Finalize healthy members under a fenced heartbeat/);
  assert.match(source, /Release unfinished batch members/);
  assert.match(source, /always\(\).*steps\.batch\.outputs\.claimed/);
  assert.match(source, /name: Release unfinished batch members[\s\S]*?continue-on-error: true/);
  assert.match(source, /while sleep 60/);
  assert.match(source, /test ! -f "\$heartbeat_failed"/);
  assert.match(source, /node scripts\/prepare-exact-review-batch\.mjs/);
  assert.match(prepareSource, /"retryable_failure", "artifact_unavailable"/);
  assert.match(prepareSource, /"permanent_failure", "tuple_protocol_invalid"/);
  assert.match(prepareSource, /EXACT_REVIEW_BATCH_MUTATION_OUTPUT/);
  // Keep the fixture from looking like an embedded credential while still
  // proving that artifact downloads use the owner-scoped repository token.
  const ghToken = ["GH", "TOKEN"].join("_");
  assert.match(prepareSource, new RegExp(`${ghToken}: env\\("REPO_TOKEN"\\)`));
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
  assert.match(prepareSource, /"clone",[\s\S]*?"--shared",[\s\S]*?"--no-checkout"/);
  assert.match(prepareSource, /http\\\.\.\*\\\.extraheader/);
  assert.match(prepareSource, /CLAWSWEEPER_STATE_DIR: stateClone/);
  assert.match(prepareSource, /CLAWSWEEPER_CODE_ROOT: workspace/);
  assert.match(prepareSource, /EXACT_REVIEW_WORK_ROOT: root/);
  assert.match(prepareSource, /publish-event-result\.js"\)\], \{\s*cwd: root,\s*env:/);
  assert.match(
    prepareSource,
    /await importObjects\(\(\) =>\s*importPreparedMutationObjects\(\{[\s\S]*?stateRoot,[\s\S]*?stateClone,[\s\S]*?outcomePath,/,
  );
  assert.match(publisherSource, /codeRoot: resolve\(process\.env\.CLAWSWEEPER_CODE_ROOT/);
  assert.match(publisherSource, /const cli = join\(options\.codeRoot, "dist\/clawsweeper\.js"\)/);
  assert.match(
    publisherSource,
    /spawnSync\(process\.execPath, \[cli, \.\.\.args\], \{\s*cwd: options\.workRoot,/,
  );
  assert.equal(
    publisherSource.match(/\.\.\.eventRecordDirectoryArgs\(options, (?:recordPaths|paths)\)/g)
      ?.length,
    2,
  );
  for (const flag of ["items", "closed", "plans", "decision-packets"]) {
    assert.match(publisherSource, new RegExp(`"--${flag}-dir"`));
  }
  assert.doesNotMatch(publisherSource, /runStreaming\("pnpm"/);
});

test("batch preparation is bounded, heartbeat-fenced, and deterministically aggregated", () => {
  assert.match(prepareSource, /const MAX_CONCURRENCY = 4/);
  assert.match(prepareSource, /const MAX_ITEMS = 32/);
  assert.match(prepareSource, /results\[index\] = await worker/);
  assert.match(prepareSource, /EXACT_REVIEW_BATCH_HEARTBEAT_FAILURE_PATH/);
  assert.match(prepareSource, /DEFAULT_ITEM_TIMEOUT_MS/);
  assert.match(prepareSource, /DEFAULT_TOTAL_TIMEOUT_MS/);
  assert.match(prepareSource, /const MAX_OUTCOME_BYTES = 2 \* 1024 \* 1024/);
  assert.match(prepareSource, /Math\.min\(itemTimeoutMs, remainingTimeout\(deadline\)\)/);
  assert.match(prepareSource, /timeoutMs: importTimeout\(deadline\)/);
  assert.match(prepareSource, /const importObjects = createSerialTaskQueue\(\)/);
  assert.match(prepareSource, /await importObjects\(\(\) =>\s*importPreparedMutationObjects\(/);
  assert.match(prepareSource, /"pack-objects", "--stdout", "--revs", "--no-reuse-object"/);
  assert.match(
    prepareSource,
    /catch \(error\) \{[\s\S]*?writeFailure\(outcomePath, "retryable_failure", "unknown_failure"\);[\s\S]*?console\.error/,
  );
  assert.match(prepareSource, /terminate\("SIGKILL"\)/);
  assert.match(prepareSource, /prepare-telemetry\.json/);
});

test("batch workflow shell steps are valid Bash", () => {
  for (const step of workflow.jobs.publish!.steps) {
    if (!step.run) continue;
    const syntax = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${step.name ?? "unnamed step"}: ${syntax.stderr}`);
  }
});

test("batch claim treats an all-stale fetched batch as terminal", () => {
  assert.match(cliSource, /if \(!manifest\.items\.length\) return;/);
  assert.ok(
    cliSource.indexOf("if (!manifest.items.length) return;") < cliSource.indexOf("owners.size"),
  );
});

test("batch manifest records the dashboard effective lease size", () => {
  assert.match(cliSource, /configuredBatchSize: lease\.configuredBatchSize/);
  assert.doesNotMatch(
    cliSource,
    /configuredBatchSize: positiveInteger\(env\("EXACT_REVIEW_BATCH_MAX_ITEMS"\)\)/,
  );
});

test("batch failure cleanup completes manifest fences without a queue fetch", () => {
  const releaseSource = /async function release\(\) \{([\s\S]*?)\n\}/.exec(cliSource)?.[1] ?? "";
  assert.match(releaseSource, /manifest\.items\.map/);
  assert.match(releaseSource, /readBatchReceipt\(manifest, false\)/);
  assert.match(releaseSource, /receipt\?\.publishedItemKeys\.has\(member\.itemKey\)/);
  assert.match(releaseSource, /terminalOutcome: "published"/);
  assert.match(releaseSource, /receipt\?\.stateCommitSha/);
  assert.match(releaseSource, /receipt\?\.stateWriter/);
  assert.doesNotMatch(releaseSource, /client\.fetch/);
});

test("batch commit rewrites quarantined outcome files before the receipt is written", () => {
  const commitSource = /async function commit\(\) \{([\s\S]*?)\n\}/.exec(cliSource)?.[1] ?? "";
  assert.match(
    commitSource,
    /outcomePathByItemKey\.set\(current\.itemKey, manifestItem\.outcomePath\)/,
  );
  const quarantineRewrite = commitSource.indexOf("for (const itemKey of quarantinedItemKeys)");
  const receiptWrite = commitSource.indexOf("const receiptPath = batchReceiptPath();");
  assert.ok(quarantineRewrite >= 0 && receiptWrite >= 0 && quarantineRewrite < receiptWrite);
  const rewriteWindow = commitSource.slice(quarantineRewrite, receiptWrite);
  assert.match(rewriteWindow, /kind: "retryable_failure"/);
  assert.match(rewriteWindow, /reasonCode: "state_conflict_quarantined"/);
});
