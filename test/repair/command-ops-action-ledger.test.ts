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
  const ledgerSetupStart = workflow.indexOf(
    "- uses: ./.github/actions/setup-action-ledger",
    executeFixStart,
  );
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

test("repair execution publishes crash-safe workflow attempt receipts", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const executeJobStart = workflow.indexOf("\n  execute:");
  const deadlineStart = workflow.indexOf(
    "- name: Record execute recovery deadline",
    executeJobStart,
  );
  const checkoutStart = workflow.indexOf("- uses: actions/checkout@v7", executeJobStart);
  const setupStart = workflow.indexOf(
    "- uses: ./.github/actions/setup-action-ledger",
    executeJobStart,
  );
  const pnpmStart = workflow.indexOf("- uses: ./.github/actions/setup-pnpm", setupStart);
  const executeStart = workflow.indexOf("- name: Execute credited fix artifact", pnpmStart);
  const finalizeStart = workflow.indexOf(
    "- name: Finalize execute-fix action ledger",
    executeStart,
  );
  const publishStart = workflow.indexOf(
    "- name: Publish immutable execute-fix action ledger",
    finalizeStart,
  );
  const postFlightTokenStart = workflow.indexOf(
    "- name: Renew target write token for post-flight",
    publishStart,
  );
  const requeueStart = workflow.indexOf("- name: Detect repair requeue requests", publishStart);
  const executeStep = workflow.slice(executeStart, finalizeStart);
  const finalizeStep = workflow.slice(finalizeStart, publishStart);
  const publishStep = workflow.slice(publishStart, postFlightTokenStart);

  assert.ok(executeJobStart >= 0);
  assert.ok(deadlineStart > executeJobStart);
  assert.ok(checkoutStart > deadlineStart);
  assert.ok(setupStart > executeJobStart);
  assert.ok(pnpmStart > setupStart);
  assert.ok(executeStart > pnpmStart);
  assert.ok(finalizeStart > executeStart);
  assert.ok(publishStart > finalizeStart);
  assert.ok(postFlightTokenStart > publishStart);
  assert.ok(requeueStart > publishStart);
  assert.match(workflow.slice(executeJobStart, deadlineStart), /timeout-minutes: 120/);
  assert.match(
    workflow.slice(executeJobStart, deadlineStart),
    /CLAWSWEEPER_EXECUTE_JOB_WINDOW_SECONDS: "5400"/,
  );
  assert.match(
    workflow.slice(executeJobStart, deadlineStart),
    /CLAWSWEEPER_EXECUTE_RECOVERY_RESERVE_SECONDS: "900"/,
  );
  assert.match(
    workflow.slice(deadlineStart, checkoutStart),
    /deadline="\$\(\(started_at \+ CLAWSWEEPER_EXECUTE_JOB_WINDOW_SECONDS\)\)"/,
  );
  assert.match(workflow.slice(deadlineStart, checkoutStart), /CLAWSWEEPER_EXECUTE_DEADLINE_EPOCH/);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(workflow.slice(pnpmStart, executeStart), /build-script: build:worker/);
  assert.match(executeStep, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION: execute-fix/);
  assert.match(
    executeStep,
    /node dist\/repair\/execute-fix-attempt\.js "\$\{\{ inputs\.job \}\}" --latest --defer-publication/,
  );
  assert.match(
    executeStep,
    /remaining_seconds="\$\(\(CLAWSWEEPER_EXECUTE_DEADLINE_EPOCH - now - CLAWSWEEPER_EXECUTE_RECOVERY_RESERVE_SECONDS\)\)"/,
  );
  assert.match(
    executeStep,
    /timeout --signal=TERM --kill-after=30s "\$\{execute_timeout_seconds\}s"/,
  );
  assert.doesNotMatch(executeStep, /timeout --foreground/);
  assert.doesNotMatch(executeStep, /pnpm run repair:execute-fix-attempt/);
  assert.doesNotMatch(executeStep, /timeout-minutes:/);
  assert.match(executeStep, /execute_exit_code=\$\?/);
  assert.match(executeStep, /echo "exit_code=\$execute_exit_code" >> "\$GITHUB_OUTPUT"/);
  assert.match(executeStep, /exit "\$execute_exit_code"/);
  assert.match(
    finalizeStep,
    /if: \$\{\{ always\(\) && steps\.execute-action-ledger\.outcome == 'success' && steps\.execute-setup-pnpm\.outcome == 'success' \}\}/,
  );
  assert.match(finalizeStep, /EXECUTE_EXIT_CODE:/);
  assert.match(finalizeStep, /reason=cancelled/);
  assert.match(finalizeStep, /reason=timeout/);
  assert.match(finalizeStep, /reason=workflow_failed/);
  assert.match(finalizeStep, /finalize-action-events/);
  assert.match(finalizeStep, /--interrupt-open-attempts/);
  assert.match(finalizeStep, /--reason "\$reason"/);
  assert.match(publishStep, /steps\.finalize-execute-fix-action-ledger\.outcome == 'success'/);
  assert.match(
    publishStep,
    /source_root="\$\{CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required\}"/,
  );
  assert.match(publishStep, /publish-action-events/);
  assert.match(publishStep, /--expected-producer-job "\$GITHUB_JOB"/);
  assert.match(publishStep, /--state-root "\$CLAWSWEEPER_STATE_DIR"/);
  assert.match(publishStep, /publish-action-event-paths/);
  assert.match(publishStep, /--message "chore: append execute-fix action ledger"/);
});

test("exact review publishes status receipts created after its first ledger publication", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/update-command-status.ts");
  const workflow = readText(".github/workflows/sweep.yml");
  const sourceDriftStatus = workflow.indexOf("- name: Mark source-drift re-review queued");
  const lateFinalize = workflow.indexOf("- name: Finalize late command status action ledger");
  const latePublish = workflow.indexOf("- name: Publish late command status action ledger");
  const targetFanout = workflow.indexOf("\n  target-fanout:", latePublish);
  const finalizeStep = workflow.slice(lateFinalize, latePublish);
  const publishStep = workflow.slice(latePublish, targetFanout);

  assert.ok(sourceDriftStatus >= 0);
  assert.ok(lateFinalize > sourceDriftStatus);
  assert.ok(latePublish > lateFinalize);
  assert.ok(targetFanout > latePublish);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
  assert.match(
    publishStep,
    /if: \$\{\{ always\(\) && steps\.setup-state\.outcome == 'success' && steps\.setup-pnpm\.outcome == 'success' && steps\.publish-event-result\.outputs\.requeue_latest == 'true' && steps\.complete-exact-review-queue\.outcome == 'success' \}\}/,
  );
  assertCommandFinalizerUsesCanonicalRoot(finalizeStep);
  assertCommandPublisherUsesCanonicalRoot(publishStep);
  assert.match(finalizeStep, /--lane late-command-status/);
  assert.match(publishStep, /--lane late-command-status/);
  assert.match(publishStep, /--message "chore: append command status action ledger"/);
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
