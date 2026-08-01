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
const sweepSource = readFileSync(".github/workflows/sweep.yml", "utf8");
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
      steps: Array<{ name?: string; if?: string; run?: string; uses?: string }>;
    }
  >;
};

test("batch publisher is event-driven and queue-bounded instead of workflow-serialized", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(workflow.on.workflow_dispatch);
  assert.match(workflow.jobs.publish!.if, /inputs\.execute/);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "execute",
    "dispatch_id",
    "dispatched_at",
  ]);
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
  assert.match(
    publisherSource,
    /if \(options\.batchMutationOutput\)[\s\S]*?writeBatchMutationResult\(options\.batchMutationOutput, \{[\s\S]*?kind: completionKind,[\s\S]*?reasonCode,/,
  );
  assert.match(
    publisherSource,
    /canonicalTargetKey: `\$\{options\.targetRepo\}#\$\{options\.itemNumber\}`,\s*fenceKey: itemKey/,
  );
  // Keep the fixture from looking like an embedded credential while still
  // proving that artifact downloads use the owner-scoped repository token.
  const ghToken = ["GH", "TOKEN"].join("_");
  assert.match(prepareSource, new RegExp(`${ghToken}: env\\("REPO_TOKEN"\\)`));
  assert.match(source, /gh workflow run repair-comment-router\.yml/);
  assert.match(
    source,
    /AUTO_IMPLEMENT_ISSUES: \$\{\{ vars\.CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES \}\}/,
  );
  assert.match(source, /node scripts\/dispatch-issue-implementation-candidates\.mjs/);
  assert.match(
    source,
    /MAX_DISPATCH: \$\{\{ vars\.CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP \|\| '' \}\}/,
  );
  assert.match(source, /remaining_implementations="\$MAX_DISPATCH"/);
  assert.match(source, /\[ "\$remaining_implementations" -gt 0 \]/);
  assert.match(source, /--max-dispatch "\$remaining_implementations"/);
  assert.match(
    source,
    /remaining_implementations=\$\(\(remaining_implementations - dispatched\)\)/,
  );
  assert.match(
    source,
    /if implementation_output="\$\(node scripts\/dispatch-issue-implementation-candidates\.mjs/,
  );
  assert.match(
    source,
    /Automatic issue implementation dispatch failed; scheduled backfill will retry/,
  );
  assert.match(source, /--item-number "\$item_number"/);
  assert.match(prepareSource, /outcomePath\.replace\(\/\\\.json\$\/, "\.report\.md"\)/);
  assert.match(source, /internal\/exact-review\/lifecycle\/router-receipt/);
  assert.match(source, /internal\/exact-review\/lifecycle\/terminal-disposition/);
  assert.match(source, /router-batch-not-required/);
  assert.match(source, /router-batch/);
  assert.match(source, /router-batch-proof/);
  assert.match(source, /lifecycle_terminal="requeue"/);
  assert.match(source, /lifecycle_terminal="target_closed"/);
  assert.match(source, /lifecycle_terminal="target_missing"/);
  assert.match(source, /lifecycle_terminal="superseded"/);
  assert.doesNotMatch(source, /lifecycle_terminal="failure"/);
  const lifecycleHandoff = source.indexOf("internal/exact-review/lifecycle/terminal-disposition");
  const implementationDispatch = source.indexOf("dispatch-issue-implementation-candidates.mjs");
  const postEffectsComplete = source.indexOf(".postEffectsComplete = true");
  assert.ok(
    lifecycleHandoff >= 0 &&
      lifecycleHandoff < implementationDispatch &&
      implementationDispatch < postEffectsComplete,
  );
  assert.doesNotMatch(source, /TARGET_GH_TOKEN/);
  assert.doesNotMatch(source, /lifecycle\/command-ack\/attempt/);
  assert.doesNotMatch(source, /repair:update-command-status/);
  assert.match(source, /internal\/exact-review\/enqueue/);
  assert.match(source, /source_drift_requeue/);
  assert.match(source, /state-receipt\.json/);
  assert.match(source, /receipt_outcome/);
  assert.match(source, /"permanent_failure"/);
  assert.match(source, /deferredCloseCoverageExpected == true/);
  assert.match(source, /lifecycle_deferred_coverage="true"/);
  assert.match(source, /durable handoff completes this review lifecycle/);
  assert.match(source, /jq '\.postEffectsRequired = true'/);
  assert.match(source, /jq '\.postEffectsComplete = true'/);
  assert.match(cliSource, /outcome\.postEffectsRequired === true/);
  assert.match(source, /Capture runner start timestamp/);
  assert.match(source, /EXACT_REVIEW_BATCH_DISPATCH_ID/);
  assert.match(source, /Record batch preparation start/);
  assert.match(source, /Record batch preparation finish/);
  assert.match(source, /EXACT_REVIEW_BATCH_OBSERVATION=final_github_apply/);
  assert.match(source, /EXACT_REVIEW_BATCH_OBSERVATION=github_throttle/);
  assert.match(source, /rate limit\|HTTP 429/);
  assert.match(cliSource, /"observe"/);
  assert.match(cliSource, /optionalDispatchTelemetry/);
  assert.match(cliSource, /optionalRunnerTelemetry/);
  assert.match(cliSource, /if \(!startedAt\) return undefined;/);

  const healthyMembers = workflow.jobs.publish!.steps.find(
    (step) => step.name === "Finalize healthy members under a fenced heartbeat",
  );
  assert.ok(healthyMembers, "missing healthy member finalizer");
  assert.match(
    healthyMembers.run ?? "",
    /permanent publisher result remains retryable until the durable/,
  );
  assert.match(healthyMembers.run ?? "", /\[ "\$outcome_kind" = "permanent_failure" \].*continue/s);
  const implementationBlock = (healthyMembers.run ?? "").slice(
    (healthyMembers.run ?? "").indexOf("# The optional implementation lane"),
    (healthyMembers.run ?? "").indexOf('report_path="${outcome_path%.json}.report.md"'),
  );
  assert.match(
    implementationBlock,
    /\{ \[ "\$receipt_outcome" = "accepted" \] \|\| \[ "\$receipt_outcome" = "deduped" \]; \} &&/,
  );
  assert.doesNotMatch(implementationBlock, /superseded|permanent/);
  assert.equal(
    workflow.jobs.publish!.steps.some(
      (step) => step.name === "Acknowledge terminal batch command lifecycle status",
    ),
    false,
  );
});

test("exact-review producer uses direct publication with bounded legacy fallback", () => {
  assert.match(sweepSource, /name: Deliver GitHub effects and prepare direct state mutation/);
  assert.match(
    sweepSource,
    /EXACT_REVIEW_BATCH_MUTATION_OUTPUT: \.artifacts\/direct-publication-outcome\.json/,
  );
  assert.match(sweepSource, /repair:exact-review-direct-publication/);
  assert.match(
    sweepSource,
    /EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: \$\{\{ vars\.EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED \|\| '1' \}\}/,
  );
  assert.match(
    sweepSource,
    /name: Upload exact review artifact bundle[\s\S]*?steps\.direct-exact-review-publication\.outputs\.accepted != 'true'/,
  );
  assert.match(
    sweepSource,
    /name: Queue durable exact review publication[\s\S]*?steps\.upload-exact-review-bundle\.outcome == 'success'/,
  );
  assert.match(sweepSource, /internal\/exact-review\/enqueue/);
  assert.match(source, /name: Claim one durable publication batch/);
});

test("batch workflow uses owner-scoped mutation credentials and canonical Worker hydration", () => {
  assert.match(source, /owner: \$\{\{ steps\.batch\.outputs\.target_owner \}\}/);
  assert.match(source, /repositories: \$\{\{ steps\.batch\.outputs\.target_repositories \}\}/);
  assert.doesNotMatch(source, /uses: \.\/\.github\/actions\/create-state-token/);
  assert.match(source, /uses: \.\/\.github\/actions\/setup-state/);
  assert.match(source, /records-repo-slugs: \$\{\{ steps\.batch\.outputs\.records_repo_slugs \}\}/);
  assert.match(source, /hydrate-git-state: "false"/);
  assert.match(source, /hydrate-state-blobs: "false"/);
  assert.match(cliSource, /slugForRepo\(normalizeRepo\(target\)\)/);
  assert.doesNotMatch(source, /permissions:\n(?:.*\n)*?\s+issues: write/);
  assert.match(prepareSource, /cpSync\(recordsSource, join\(root, "records"\)/);
  assert.doesNotMatch(prepareSource, /stateClone|CLAWSWEEPER_STATE_DIR|"clone"/);
  assert.match(prepareSource, /CLAWSWEEPER_CODE_ROOT: workspace/);
  assert.match(prepareSource, /EXACT_REVIEW_WORK_ROOT: root/);
  assert.match(prepareSource, /publish-event-result\.js"\)\], \{\s*cwd: root,\s*env:/);
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
  assert.match(publisherSource, /"--record-root",\s*options\.workRoot/);
  assert.doesNotMatch(publisherSource, /runStreaming\("pnpm"/);
});

test("batch preparation is bounded, heartbeat-fenced, and deterministically aggregated", () => {
  assert.match(prepareSource, /const MAX_CONCURRENCY = 4/);
  assert.match(prepareSource, /const MAX_ITEMS = 32/);
  assert.match(prepareSource, /results\[index\] = await worker/);
  assert.match(prepareSource, /EXACT_REVIEW_BATCH_HEARTBEAT_FAILURE_PATH/);
  assert.match(prepareSource, /DEFAULT_ITEM_TIMEOUT_MS/);
  assert.match(prepareSource, /DEFAULT_TOTAL_TIMEOUT_MS/);
  assert.match(prepareSource, /Math\.min\(itemTimeoutMs, remainingTimeout\(deadline\)\)/);
  assert.doesNotMatch(prepareSource, /importPreparedMutationObjects|pack-objects|targetOid/);
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
  assert.match(releaseSource, /receipt\?\.outcomes\.get\(member\.itemKey\)/);
  assert.match(releaseSource, /receipt\?\.publishedItemKeys\.has\(member\.itemKey\)/);
  assert.match(releaseSource, /terminalOutcome: "published"/);
  assert.match(releaseSource, /receipt\?\.stateCommitSha/);
  assert.match(releaseSource, /receipt\?\.stateWriter/);
  assert.doesNotMatch(releaseSource, /client\.fetch/);
});

test("batch commit publishes every prepared tuple to canonical Worker state", () => {
  const commitSource = /async function commit\(\) \{([\s\S]*?)\n\}/.exec(cliSource)?.[1] ?? "";
  assert.match(commitSource, /await publishCanonicalBatch\(commitCandidates\)/);
  assert.match(commitSource, /permanentPublicationOutcome\(current, failureFingerprint\(error\)\)/);
  assert.match(commitSource, /outcomes: publicationOutcomes/);
  assert.match(cliSource, /canonicalTargetKey/);
  assert.match(cliSource, /fenceKey/);
  assert.match(cliSource, /postDirectPublicationResult/);
  assert.match(cliSource, /publication-batch-results/);
  assert.match(cliSource, /plan\.operations\.map\(\(operation\) => \(\{ \.\.\.operation \}\)\)/);
  assert.doesNotMatch(cliSource, /runGit|targetOid/);
  assert.doesNotMatch(cliSource, /commitPreparedStateBatch/);
  assert.doesNotMatch(cliSource, /state-publication-batch/);
});
