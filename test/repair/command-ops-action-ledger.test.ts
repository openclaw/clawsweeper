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

test("report-only repair requeues forward a stable dispatch receipt and publish it", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/requeue-job.ts");
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const dispatchIndex = source.indexOf(
    "dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle)",
  );
  const receiptIndex = source.indexOf("recordCommandRequeue(requeueLifecycle", dispatchIndex);
  const finalizeStart = workflow.indexOf("- name: Finalize report command action ledger");
  const publishStart = workflow.indexOf("- name: Publish immutable report command action ledger");
  const mutateStart = workflow.indexOf("\n  mutate:", publishStart);
  const finalizeStep = workflow.slice(finalizeStart, publishStart);
  const publishStep = workflow.slice(publishStart, mutateStart);

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
  assert.match(workflow, /- name: Create report state token/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.ok(finalizeStart >= 0);
  assert.ok(publishStart > finalizeStart);
  assert.ok(mutateStart > publishStart);
  assert.match(
    finalizeStep,
    /if: \$\{\{ always\(\) && steps\.report-setup-pnpm\.outcome == 'success' && steps\.repair_requeue\.outputs\.count != '' && steps\.repair_requeue\.outputs\.count != '0' \}\}/,
  );
  assert.match(
    publishStep,
    /if: \$\{\{ always\(\) && steps\.report-setup-pnpm\.outcome == 'success' && steps\.repair_requeue\.outputs\.count != '' && steps\.repair_requeue\.outputs\.count != '0' \}\}/,
  );
  assertCommandFinalizerUsesCanonicalRoot(finalizeStep);
  assertCommandPublisherUsesCanonicalRoot(publishStep);
  assert.match(publishStep, /--message "chore: append report command action ledger"/);
  assert.match(
    workflow,
    /--source-job-path "\$\{\{ needs\.authorize\.outputs\.source_job_path \}\}"/,
  );
  assert.match(workflow, /--requeue-depth "\$\{\{ inputs\.requeue_depth \}\}"/);
  assert.match(workflow, /--max-requeue-depth 1/);
});

test("exact review publishes status receipts created after its first ledger publication", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/update-command-status.ts");
  const workflow = readText(".github/workflows/sweep.yml");
  const sourceDriftStatus = workflow.indexOf("- name: Mark source-drift re-review queued");
  const latePublish = workflow.indexOf("- name: Publish late command status action ledger");
  const targetFanout = workflow.indexOf("\n  target-fanout:", latePublish);
  const publishStep = workflow.slice(latePublish, targetFanout);

  assert.ok(sourceDriftStatus >= 0);
  assert.ok(latePublish > sourceDriftStatus);
  assert.ok(targetFanout > latePublish);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
  assert.match(
    publishStep,
    /if: \$\{\{ always\(\) && steps\.setup-state\.outcome == 'success' && steps\.setup-pnpm\.outcome == 'success' && steps\.publish-event-result\.outputs\.requeue_latest == 'true' && steps\.complete-exact-review-queue\.outcome == 'success' \}\}/,
  );
  assertCommandPublisherUsesCanonicalRoot(publishStep);
  assert.match(publishStep, /--message "chore: append command status action ledger"/);
});

function assertCommandFinalizerUsesCanonicalRoot(step: string): void {
  assert.match(
    step,
    /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required/,
  );
  assert.match(step, /repair:action-ledger -- finalize/);
}

function assertCommandPublisherUsesCanonicalRoot(step: string): void {
  assert.match(
    step,
    /source_root="\$\{CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required\}"/,
  );
  assert.match(step, /--source-root "\$source_root"/);
  assert.match(step, /if \[ ! -d "\$source_root\/ledger" \]; then[\s\S]*?exit 1[\s\S]*?fi/);
  assert.match(step, /jq -e 'select\(\.event_type \| startswith\("command\."\)\)' "\$shard_path"/);
  assert.match(step, /if \[ "\$command_shard_found" != "true" \]; then[\s\S]*?exit 1[\s\S]*?fi/);
  assert.match(
    step,
    /if ! jq -e '\.created > 0' "\$import_result_file" >\/dev\/null; then[\s\S]*?exit 1[\s\S]*?fi/,
  );
  assert.match(step, /jq -r '\.paths\[\]\?' "\$import_result_file"/);
  assert.match(step, /if \[ ! -s "\$event_paths_file" \]; then[\s\S]*?exit 1[\s\S]*?fi/);
  assert.doesNotMatch(step, /exit 0/);
}
