import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("command status mutations have exact attempt and outcome receipts", () => {
  const source = readText("src/repair/update-command-status.ts");
  const patchIndex = source.indexOf('kind: "status_comment_update"');
  const receiptIndex = source.indexOf("recordCommandProgress(lifecycle", patchIndex);

  assert.ok(patchIndex >= 0);
  assert.ok(receiptIndex > patchIndex);
  assert.match(source, /runCommandLifecycleMutation\(lifecycle,/);
  assert.match(source, /kind: "ack_comment_delete"/);
  assert.match(source, /status: "unchanged"/);
  assert.match(source, /status: "skipped"/);
  assert.match(source, /recordCommandLifecycleFailure/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
});

test("direct repair requeues forward a stable dispatch receipt and publish it", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/requeue-job.ts");
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const dispatchIndex = source.indexOf(
    "dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle)",
  );
  const receiptIndex = source.indexOf("recordCommandRequeue(requeueLifecycle", dispatchIndex);
  const finalizeStart = workflow.indexOf("- name: Finalize repair requeue action ledger");
  const publishStart = workflow.indexOf("- name: Publish immutable repair requeue action ledger");
  const nextStep = workflow.indexOf("- name: Record requeued work", publishStart);
  const executeFixStart = workflow.indexOf("- name: Execute credited fix artifact");
  const ledgerSetupStart = workflow.indexOf("- uses: ./.github/actions/setup-action-ledger");
  const requeueStart = workflow.indexOf("- name: Requeue source-head repair races");
  const finalizeStep = workflow.slice(finalizeStart, publishStart);
  const publishStep = workflow.slice(publishStart, nextStep);

  assert.ok(dispatchIndex >= 0);
  assert.ok(receiptIndex > dispatchIndex);
  assert.match(source, /deterministicRequeueDispatchKey\(\{/);
  assert.match(source, /authorizationSha256/);
  assert.match(source, /depth: nextRequeueDepth/);
  assert.match(source, /boundedNextRequeueDepth\(requeueDepth, maxRequeueDepth\)/);
  assert.match(source, /`dispatch_key=\$\{dispatchKey\}`/);
  assert.match(source, /`job=\$\{jobPath\}`/);
  assert.match(source, /`requeue_depth=\$\{nextRequeueDepth\}`/);
  assert.match(source, /operationKey: `repair-requeue:/);
  assert.match(source, /sourceRevision: authorizationSha256/);
  assert.match(source, /runCommandLifecycleMutation\(lifecycle,/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(workflow, /- name: Create state token/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /execute:[\s\S]*?permissions:\n\s+actions: read/);
  assert.match(workflow, /sparse-checkout: \|\n\s+jobs\n\s+ledger/);
  assert.ok(executeFixStart < ledgerSetupStart && ledgerSetupStart < requeueStart);
  assert.ok(finalizeStart >= 0);
  assert.ok(publishStart > finalizeStart);
  assert.ok(nextStep > publishStart);
  assert.match(
    finalizeStep,
    /if: \$\{\{ always\(\) && steps\.execute-setup-pnpm\.outcome == 'success' && steps\.repair-requeue-ledger\.outcome == 'success' && steps\.repair_requeue\.outputs\.count != '' && steps\.repair_requeue\.outputs\.count != '0' \}\}/,
  );
  assert.match(
    publishStep,
    /if: \$\{\{ always\(\) && steps\.execute-setup-pnpm\.outcome == 'success' && steps\.repair-requeue-ledger\.outcome == 'success' && steps\.repair_requeue\.outputs\.count != '' && steps\.repair_requeue\.outputs\.count != '0' \}\}/,
  );
  assertCommandFinalizerUsesCanonicalRoot(finalizeStep);
  assertCommandPublisherUsesCanonicalRoot(publishStep);
  assert.match(finalizeStep, /--lane repair-requeue/);
  assert.match(publishStep, /--lane repair-requeue/);
  assert.match(publishStep, /--message "chore: append repair requeue action ledger"/);
  assert.match(workflow, /pnpm run repair:requeue -- "\$\{\{ inputs\.job \}\}"/);
  assert.match(workflow, /--source-job-path "\$\{\{ inputs\.job \}\}"/);
  assert.match(workflow, /--requeue-depth "\$\{\{ inputs\.requeue_depth \}\}"/);
  assert.match(workflow, /--max-requeue-depth 1/);
});

test("exact review publisher includes command status receipts after the status mutation", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/update-command-status.ts");
  const workflow = readText(".github/workflows/sweep.yml");
  const publisherJob = workflow.indexOf("\n  event-review-publish:");
  const statusMutation = workflow.indexOf("- name: Mark re-review complete", publisherJob);
  const ledgerPublish = workflow.indexOf(
    "- name: Publish exact review action ledger",
    publisherJob,
  );
  const nextStep = workflow.indexOf(
    "- name: Release unsuccessful publisher-owned review lease",
    ledgerPublish,
  );
  const publishStep = workflow.slice(ledgerPublish, nextStep);

  assert.ok(publisherJob >= 0);
  assert.ok(statusMutation > publisherJob);
  assert.ok(ledgerPublish > statusMutation);
  assert.ok(nextStep > ledgerPublish);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
  assert.match(
    publishStep,
    /if: \$\{\{ always\(\) && steps\.setup-state\.outcome == 'success' \}\}/,
  );
  assert.match(publishStep, /continue-on-error: true/);
  assert.match(publishStep, /source_root="\.artifacts\/exact-review-bundle\/action-ledger"/);
  assert.match(publishStep, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:-/);
  assert.match(publishStep, /publisher_ledger_root\/ledger/);
  assert.match(publishStep, /--expected-producer-job "\$GITHUB_JOB"/);
  assert.match(publishStep, /sort -u -o "\$event_paths_file" "\$event_paths_file"/);
  assert.match(publishStep, /--message "chore: append exact review action ledger"/);
});

function assertCommandFinalizerUsesCanonicalRoot(step: string): void {
  assert.match(
    step,
    /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required/,
  );
  assert.match(step, /repair:action-ledger -- finalize \\\n\s+--lane [a-z0-9-]+ \\\n/);
  assert.match(step, /> \.artifacts\/[a-z0-9-]+-action-ledger-manifest\.json/);
}

function assertCommandPublisherUsesCanonicalRoot(step: string): void {
  assert.match(
    step,
    /source_root="\$\{CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required\}"/,
  );
  assert.match(step, /manifest_file="\.artifacts\/[a-z0-9-]+-action-ledger-manifest\.json"/);
  assert.match(step, /test -s "\$manifest_file"/);
  assert.match(step, /repair:action-ledger -- publish/);
  assert.match(step, /--lane [a-z0-9-]+/);
  assert.match(step, /--manifest "\$manifest_file"/);
  assert.match(step, /--source-root "\$source_root"/);
  assert.match(
    step,
    /jq -e --slurpfile manifest "\$manifest_file"[\s\S]*?'\.eventPaths == \$manifest\[0\]\.event_paths'/,
  );
  assert.match(step, /jq -r '\.paths\[\]\?' "\$import_result_file"/);
  assert.match(step, /if \[ ! -s "\$event_paths_file" \]; then[\s\S]*?exit 1[\s\S]*?fi/);
  assert.doesNotMatch(step, /command_shard_found/);
  assert.doesNotMatch(step, /\.created > 0/);
  assert.doesNotMatch(step, /exit 0/);
}
