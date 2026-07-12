import assert from "node:assert/strict";
import test from "node:test";

import {
  actionLedgerFailureDisposition,
  applyActionEventDisposition,
  reviewCommentPublicationEventDisposition,
  reviewRetryActionDisposition,
} from "../dist/clawsweeper.js";
import { readText } from "./helpers.ts";

test("review and apply outcome classifiers cover terminal and resumable states", () => {
  assert.deepEqual(actionLedgerFailureDisposition(new Error("worker timed out after 30s")), {
    status: "failed",
    reasonCode: "timeout",
    completionReason: "timeout",
  });
  assert.deepEqual(actionLedgerFailureDisposition(new Error("process interrupted by SIGINT")), {
    status: "cancelled",
    reasonCode: "cancelled",
    completionReason: "interrupted",
  });
  assert.deepEqual(actionLedgerFailureDisposition(new Error("unexpected failure")), {
    status: "failed",
    reasonCode: "exception",
    completionReason: "failed",
  });

  assert.deepEqual(applyActionEventDisposition("closed", true, false), {
    status: "completed",
    reasonCode: "completed",
    retryable: false,
    mutation: true,
    completionReason: "closed",
  });
  assert.deepEqual(applyActionEventDisposition("closed", false, true), {
    status: "planned",
    reasonCode: "dry_run",
    retryable: false,
    mutation: false,
    completionReason: "dry_run",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_runtime_budget", false, false), {
    status: "yielded",
    reasonCode: "runtime_budget",
    retryable: true,
    mutation: false,
    completionReason: "runtime_budget",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_changed_since_review", false, false), {
    status: "blocked",
    reasonCode: "source_changed",
    retryable: true,
    mutation: false,
    completionReason: "source_changed",
  });
  assert.deepEqual(reviewCommentPublicationEventDisposition("review_comment_synced", true, false), {
    status: "published",
    reasonCode: "published",
    retryable: false,
    mutation: true,
    completionReason: "comment_published",
  });
  assert.deepEqual(reviewCommentPublicationEventDisposition("skipped_comment_auth", true, false), {
    status: "blocked",
    reasonCode: "authorization_failed",
    retryable: true,
    mutation: false,
    completionReason: "authorization_failed",
  });
  assert.deepEqual(
    reviewCommentPublicationEventDisposition("retry_stale_canonical_comment_sync", false, false),
    {
      status: "waiting",
      reasonCode: "dependency_pending",
      retryable: true,
      mutation: false,
      completionReason: "retry_pending",
    },
  );
});

test("failed-review retry events distinguish dispatch, exhaustion, and backpressure", () => {
  assert.deepEqual(reviewRetryActionDisposition("dispatched_failed_review_retry"), {
    status: "dispatched",
    reasonCode: "retry_scheduled",
    retryable: true,
    mutation: true,
  });
  assert.deepEqual(reviewRetryActionDisposition("marked_failed_review_retry_exhausted"), {
    status: "blocked",
    reasonCode: "retry_exhausted",
    retryable: false,
    mutation: true,
  });
  assert.deepEqual(reviewRetryActionDisposition("skipped_runtime_budget"), {
    status: "yielded",
    reasonCode: "runtime_budget",
    retryable: true,
    mutation: false,
  });
  assert.deepEqual(reviewRetryActionDisposition("skipped_stale_revision"), {
    status: "blocked",
    reasonCode: "source_changed",
    retryable: false,
    mutation: false,
  });
});

test("lane instrumentation uses stable slots with explicit parent and phase ordering", () => {
  const source = readText("src/clawsweeper.ts");

  for (const phase of [
    "reviewBatch",
    "reviewItem",
    "reviewRetry",
    "reviewLogPublication",
    "reviewCommentPublication",
    "applyAction",
    "applyBatch",
    "applyPublish",
  ]) {
    assert.match(source, new RegExp(`ACTION_EVENT_TYPES\\.${phase}`));
  }

  assert.match(source, /parentEventId: batchStart\?\.event_id \?\? null/);
  assert.match(source, /parentEventId: state\.startEventId/);
  assert.match(
    source,
    /parentEventId: actionEvent\?\.event_id \?\? options\.ledger\.batchStartEventId/,
  );
  assert.match(source, /phaseSeq: 10 \+ index \* 10/);
  assert.match(source, /phaseSeq: 11 \+ index \* 10/);
  assert.match(source, /phaseSeq: 12 \+ state\.index \* 10/);
  assert.match(source, /phaseSeq: 1_000_000/);
  assert.match(source, /if \(!state\.logPublication\) \{\s*recordReviewLogPublication\(/);

  assert.match(
    source,
    /idempotencyIdentity: \{\s*operationIdentity: options\.ledger\.operationIdentity,\s*slot: "apply_batch_terminal"/,
  );
  assert.match(
    source,
    /idempotencyIdentity: \{\s*operationIdentity: options\.ledger\.operationIdentity,\s*slot: "batch_terminal"/,
  );
  assert.doesNotMatch(
    source,
    /idempotencyIdentity: \{[^}]{0,300}(?:status|reasonCode|completionReason)/,
  );
});

test("apply failure finalization survives report publication errors", () => {
  const source = readText("src/clawsweeper.ts");
  const finishApplyStart = source.indexOf(
    "const finishApply = (failed = false, failure?: unknown): void => {",
  );
  const onFailureStart = source.indexOf(
    "runtimeBudget.onFailure = (error: unknown): void => {",
    finishApplyStart,
  );
  const finishApply = source.slice(finishApplyStart, onFailureStart);

  assert.ok(finishApplyStart >= 0);
  assert.ok(onFailureStart > finishApplyStart);
  assert.match(finishApply, /catch \(error\) \{\s*publicationError = error;\s*\}/);
  assert.ok(
    finishApply.indexOf("recordApplyActionEvents({") > finishApply.indexOf("catch (error)"),
  );
  assert.ok(finishApply.indexOf("if (publicationError) throw publicationError;") > 0);
  assert.match(
    source.slice(onFailureStart, source.indexOf("runtimeBudget.onYield", onFailureStart)),
    /finishApply\(true, error\)/,
  );
});

test("retry and review publication lanes finalize unexpected failures", () => {
  const source = readText("src/clawsweeper.ts");
  const retryStart = source.indexOf("const retryLedger = startFailedReviewRetryLedger({");
  const retryRecord = source.indexOf("recordFailedReviewRetryEvents({", retryStart);
  const retryThrow = source.indexOf("if (commandError) throw commandError;", retryRecord);
  assert.ok(retryStart >= 0);
  assert.ok(retryRecord > retryStart);
  assert.ok(retryThrow > retryRecord);
  assert.match(
    source.slice(retryRecord, retryThrow),
    /ledger: retryLedger[\s\S]*failure: commandError/,
  );

  const publicationStart = source.indexOf("function applyArtifactsCommand(args: Args): void {");
  const publicationCatch = source.indexOf("} catch (error) {", publicationStart);
  const publicationFinish = source.indexOf(
    "finishPublication(error, interruptedMutation);",
    publicationCatch,
  );
  const publicationThrow = source.indexOf("throw error;", publicationFinish);
  assert.ok(publicationCatch > publicationStart);
  assert.ok(publicationFinish > publicationCatch);
  assert.ok(publicationThrow > publicationFinish);
  assert.match(
    source.slice(publicationCatch, publicationFinish),
    /recordPublication\(\{[\s\S]*status: actionLedgerFailureDisposition\(error\)\.status/,
  );
  assert.match(
    source,
    /syncStalePullRequestReviewLabels\(\{[\s\S]{0,240}onMutation: recordMutation/,
  );
  assert.match(source, /syncPriorityLabel\(\{[\s\S]{0,240}onMutation: recordMutation/);
  assert.match(source, /tryAddOptionalLabel\(\{[\s\S]{0,220}onMutation: options\.onMutation/);
});

test("sweep publishes complete immutable shards for every review and apply producer", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const reviewStep = workflow.indexOf("- name: Review shard");
  const reviewFinalizer = workflow.indexOf("- name: Finalize review action ledger");
  const reviewUpload = workflow.indexOf("name: action-ledger-review-${{ matrix.shard }}");

  assert.ok(reviewStep >= 0);
  assert.ok(reviewFinalizer > reviewStep);
  assert.ok(reviewUpload > reviewFinalizer);
  assert.match(
    workflow.slice(reviewFinalizer, reviewUpload),
    /if: always\(\)[\s\S]*node dist\/clawsweeper\.js finalize-action-events/,
  );

  for (const name of [
    "Import immutable review action events",
    "Publish immutable review action ledger",
    "Publish review artifact action ledger",
    "Publish selected review comment action ledger",
    "Publish failed-review retry action ledger",
    "Finalize exact event action ledger",
    "Publish exact event action ledger",
    "Finalize apply proof action ledger",
    "Publish apply proof action events",
    "Publish apply action events",
  ]) {
    assert.match(workflow, new RegExp(`- name: ${name}`));
  }

  assert.match(
    workflow,
    /publish-apply-proof-action-ledger:\s*\n\s*name: Publish immutable apply proof action ledger/,
  );
  assert.match(workflow, /pattern: action-ledger-review-\*/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /--state-root "\$CLAWSWEEPER_STATE_DIR"/);
  assert.match(workflow, /durable_event_path="\$CLAWSWEEPER_STATE_DIR\/\$event_path"/);
  assert.match(workflow, /action_ledger_args\+=\(--path "\$event_path"\)/);
  assert.doesNotMatch(
    workflow,
    /--message "chore: append (?:review|apply).*action ledger"[\s\S]{0,180}--path "ledger\/v1\/events"/,
  );
});
