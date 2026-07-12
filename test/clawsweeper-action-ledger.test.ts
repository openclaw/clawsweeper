import assert from "node:assert/strict";
import test from "node:test";

import {
  actionEventPublishPathsForTest,
  actionLedgerFailureDisposition,
  applyActionEventDisposition,
  applyItemBusinessIdempotencyIdentityForTest,
  applyMutationBusinessIdempotencyIdentityForTest,
  applyPhaseSequenceForTest,
  applyRuntimeBudgetYieldResultsForTest,
  classifyGitHubDispatchResultForTest,
  combinedCodexReviewRetryableForTest,
  codexReviewFailureRetryableForTest,
  heldReviewStartStatusCommentResultForTest,
  isGitHubLabelAlreadyExistsErrorForTest,
  observedGitHubMutationAttemptsForTest,
  reviewCommentPublicationEventDisposition,
  reviewRetryActionDisposition,
  reviewRetryBatchEventDisposition,
  reviewRetryBusinessIdempotencyIdentityForTest,
  untrustedCodexEnvForTest,
} from "../dist/clawsweeper.js";
import { actionIdempotencyKey } from "../dist/action-ledger.js";
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
  assert.deepEqual(applyActionEventDisposition("skipped_runtime_budget", true, false), {
    status: "yielded",
    reasonCode: "runtime_budget",
    retryable: true,
    mutation: true,
    completionReason: "runtime_budget",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_changed_since_review", false, false), {
    status: "blocked",
    reasonCode: "source_changed",
    retryable: true,
    mutation: false,
    completionReason: "source_changed",
  });
  assert.deepEqual(applyActionEventDisposition("kept_open", true, false), {
    status: "skipped",
    reasonCode: "not_applicable",
    retryable: false,
    mutation: true,
    completionReason: "kept_open",
  });
  assert.deepEqual(applyActionEventDisposition("skipped_protected_label", true, false), {
    status: "skipped",
    reasonCode: "not_applicable",
    retryable: false,
    mutation: true,
    completionReason: "skipped_protected_label",
  });
  assert.deepEqual(reviewCommentPublicationEventDisposition("review_comment_synced", true, false), {
    status: "published",
    reasonCode: "published",
    retryable: false,
    mutation: true,
    completionReason: "comment_published",
  });
  assert.deepEqual(
    reviewCommentPublicationEventDisposition("review_comment_synced", false, false),
    {
      status: "unchanged",
      reasonCode: "content_unchanged",
      retryable: false,
      mutation: false,
      completionReason: "comment_unchanged",
    },
  );
  assert.deepEqual(applyActionEventDisposition("review_comment_synced", true, false, false), {
    status: "unchanged",
    reasonCode: "content_unchanged",
    retryable: false,
    mutation: true,
    completionReason: "comment_unchanged",
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
  assert.deepEqual(reviewRetryActionDisposition("skipped_retry_dispatch_uncertain"), {
    status: "failed",
    reasonCode: "unavailable",
    retryable: false,
    mutation: true,
  });
  assert.deepEqual(
    reviewRetryBatchEventDisposition([
      "skipped_dispatch_failed",
      "skipped_retry_dispatch_uncertain",
    ]),
    {
      status: "failed",
      reasonCode: "unavailable",
      retryable: false,
      completionReason: "dispatch_outcome_unknown",
      failedCount: 1,
      partial: true,
    },
  );
});

test("action event publication accepts only sorted canonical event and binding paths", () => {
  const paths = [
    "ledger/v1/events/2026/07/12/openclaw-clawsweeper/review/run-part-1-of-1.jsonl",
    `ledger/v1/import-bindings/completed-shard-sets/${"a".repeat(64)}.json`,
    `ledger/v1/import-bindings/events/${"b".repeat(64)}.json`,
    `ledger/v1/import-bindings/producer-runs/${"c".repeat(64)}.json`,
    `ledger/v1/import-bindings/shard-sets/${"d".repeat(64)}.json`,
  ].sort();
  assert.deepEqual(actionEventPublishPathsForTest(`${paths.join("\n")}\n`), paths);
  assert.throws(
    () => actionEventPublishPathsForTest(`${paths[1]}\n${paths[0]}\n`),
    /sorted and unique/,
  );
  assert.throws(
    () => actionEventPublishPathsForTest("ledger/v1/import-bindings/private/raw.json\n"),
    /invalid action event publish path/,
  );
});

test("apply and retry business idempotency ignore batch order but bind source revision", () => {
  const applyIdentity = {
    slot: "apply_item" as const,
    repository: "openclaw/openclaw",
    number: 512,
    sourceRevision: "a".repeat(40),
    reviewContentDigest: "b".repeat(64),
    decisionPacketSha256: "c".repeat(64),
  };
  const applyKey = actionIdempotencyKey(applyItemBusinessIdempotencyIdentityForTest(applyIdentity));
  assert.equal(
    actionIdempotencyKey(
      applyItemBusinessIdempotencyIdentityForTest({
        ...applyIdentity,
      }),
    ),
    applyKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      applyItemBusinessIdempotencyIdentityForTest({
        ...applyIdentity,
        sourceRevision: "d".repeat(40),
      }),
    ),
    applyKey,
  );
  const mutationIdentity = {
    repository: applyIdentity.repository,
    number: applyIdentity.number,
    sourceRevision: applyIdentity.sourceRevision,
    reviewContentDigest: applyIdentity.reviewContentDigest,
    decisionPacketSha256: applyIdentity.decisionPacketSha256,
    mutationIdentity: "review_comment_post:512",
  };
  const mutationKey = actionIdempotencyKey(
    applyMutationBusinessIdempotencyIdentityForTest(mutationIdentity),
  );
  assert.equal(
    actionIdempotencyKey(applyMutationBusinessIdempotencyIdentityForTest(mutationIdentity)),
    mutationKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      applyMutationBusinessIdempotencyIdentityForTest({
        ...mutationIdentity,
        mutationIdentity: "review_comment_delete:512",
      }),
    ),
    mutationKey,
  );

  const retryIdentity = {
    repository: "openclaw/openclaw",
    number: 512,
    revisionKind: "pull_head_sha" as const,
    sourceRevision: "e".repeat(40),
    reviewContentDigest: "f".repeat(64),
    decisionPacketSha256: "1".repeat(64),
    slot: "retry_dispatch" as const,
  };
  const retryKey = actionIdempotencyKey(
    reviewRetryBusinessIdempotencyIdentityForTest(retryIdentity),
  );
  assert.equal(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
      }),
    ),
    retryKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
        sourceRevision: "2".repeat(40),
      }),
    ),
    retryKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
        reviewContentDigest: "3".repeat(64),
      }),
    ),
    retryKey,
  );
  assert.notEqual(
    actionIdempotencyKey(
      reviewRetryBusinessIdempotencyIdentityForTest({
        ...retryIdentity,
        decisionPacketSha256: "4".repeat(64),
      }),
    ),
    retryKey,
  );
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

  assert.match(source, /parentEventId: ledger\.batchStartEventId/);
  assert.match(source, /parentEventId: state\.lastEventId \?\? state\.startEventId/);
  assert.match(
    source,
    /parentEventId: options\.state\.lastEventId \?\? options\.state\.startEventId/,
  );
  assert.match(source, /function nextReviewPhaseSeq\(/);
  assert.match(source, /phaseSeq: nextReviewPhaseSeq\(options\.ledger\)/);
  assert.match(source, /phaseSeq: 1_000_000/);
  assert.match(source, /if \(!state\.logPublication\) \{\s*recordReviewLogPublication\(/);

  assert.match(
    source,
    /idempotencyIdentity: \{\s*operationIdentity: options\.ledger\.operationIdentity,\s*slot: "apply_batch_terminal"/,
  );
  assert.match(source, /candidateSnapshots: options\.candidates\.map/);
  assert.match(source, /candidateRevisions: options\.candidates\.map/);
  assert.match(source, /slot: "apply_item"/);
  assert.match(source, /operation: "apply",\s*slot: options\.slot/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("function applyItemIdempotencyIdentity("),
      source.indexOf("function applyLedgerItemSubject("),
    ),
    /operationIdentity|checkpoint|index/,
  );
  assert.doesNotMatch(
    source,
    /idempotencyIdentity: \{[^}]{0,300}slot: "apply_(?:result|in_flight_failure)"/,
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

test("review candidates start lazily and deferred items cannot remain active", () => {
  const source = readText("src/clawsweeper.ts");
  const ledgerStart = source.slice(
    source.indexOf("function startReviewActionLedger(options:"),
    source.indexOf("function startReviewActionLedgerItem("),
  );
  const reviewLoop = source.slice(
    source.indexOf("for (const item of candidates) {"),
    source.indexOf("if (coordinationHeldRetryAt) {"),
  );

  assert.doesNotMatch(ledgerStart, /status: ACTION_EVENT_STATUSES\.started[\s\S]*reviewItem/);
  assert.match(
    reviewLoop,
    /activeReviewItem = item;[\s\S]*startReviewActionLedgerItem\(reviewLedger, item\)/,
  );
  assert.match(
    reviewLoop,
    /activeReviewMutationRunner = reviewMutationRunner\(reviewLedger, item\)/,
  );
  assert.match(reviewLoop, /catch \(error\) \{\s*reviewItemFailed = true;\s*throw error;/);
  assert.match(
    reviewLoop,
    /finally \{[\s\S]*!reviewItemFailed[\s\S]*finishReviewActionLedgerItem\(\{[\s\S]*completionReason: "coordination_deferred"[\s\S]*activeReviewItem = null;/,
  );
  const reviewMutationAttempt = source.slice(
    source.indexOf("function startReviewMutationAttempt("),
    source.indexOf("function recordReviewLogPublication("),
  );
  assert.match(reviewMutationAttempt, /completion_reason: "mutation_attempted"/);
  assert.match(reviewMutationAttempt, /"mutation_accepted"/);
  assert.match(reviewMutationAttempt, /"mutation_rejected"/);
  assert.match(reviewMutationAttempt, /"mutation_outcome_unknown"/);
  assert.match(reviewMutationAttempt, /mutationIdentitySha256: sha256\(idempotencyIdentity\)/);
  const reviewItemTerminal = source.slice(
    source.indexOf("function finishReviewActionLedgerItem("),
    source.indexOf("export function actionLedgerFailureDisposition("),
  );
  assert.match(reviewItemTerminal, /mutation: state\.mutationObserved/);
  const reviewBatchTerminal = source.slice(
    source.indexOf("function finishReviewActionLedger(options:"),
    source.indexOf("function reviewCommand(args:"),
  );
  assert.match(reviewBatchTerminal, /mutation: options\.ledger\.mutationObserved/);

  const reviewCommandStart = source.indexOf("function reviewCommand(args:");
  const reviewCatchStart = source.indexOf(
    "  } catch (error) {\n    if (reviewLedger) {",
    reviewCommandStart,
  );
  const reviewCatch = source.slice(
    reviewCatchStart,
    source.indexOf("restoreTreeModes(readonlyModeSnapshots)", reviewCatchStart),
  );
  const cleanup = reviewCatch.indexOf(
    "deleteOwnedDedicatedReviewStartLease(acquired.itemNumber, acquired.lease)",
  );
  const finalization = reviewCatch.indexOf("finishReviewActionLedger({");
  assert.ok(cleanup >= 0);
  assert.ok(finalization > cleanup);
});

test("apply receipts start per item and persist mutation observation before finalization", () => {
  const source = readText("src/clawsweeper.ts");
  const applyLoop = source.slice(
    source.indexOf("for (const entry of fileEntries) {"),
    source.indexOf("if (runtimeBudget.yieldReason) {"),
  );

  assert.match(applyLoop, /startApplyActionLedgerItem\(applyLedger, entry\)/);
  assert.match(applyLoop, /mutationByItem\.set\(`\$\{repo\}#\$\{number\}`, true\)/);
  assert.match(
    applyLoop,
    /const recordMutation = \(parentEventId\?: string \| null\): void => \{[\s\S]*recordApplyMutationBoundary\(applyLedger, entry, parentEventId\)/,
  );
  assert.match(source, /completion_reason: "mutation_attempted"/);
  assert.match(source, /parentEventId: state\.lastEventId \?\? state\.startEventId/);
  assert.match(source, /const phaseSeq = nextApplyPhaseSeq\(ledger\)/);
  assert.doesNotMatch(source, /11 \+ state\.index \* 20/);
  assert.match(applyLoop, /syncedComment = upsertReviewComment\(/);
  assert.match(applyLoop, /commentMutationOccurred: !dryRun && needsReviewCommentBodySync/);
  assert.match(
    source,
    /const commentMutationOccurred = result\.commentMutationOccurred === true;[\s\S]*applyActionEventDisposition\([\s\S]*commentMutationOccurred,[\s\S]*reviewCommentPublicationEventDisposition\([\s\S]*commentMutationOccurred,/,
  );
  assert.match(applyLoop, /closeItem\(\{ number, kind: item\.kind/);
  const mutationAttemptStart = source.indexOf("function startApplyMutationAttempt(");
  const mutationIdentityStart = source.indexOf(
    "const businessIdempotencyIdentity = applyMutationBusinessIdempotencyIdentityForTest({",
    mutationAttemptStart,
  );
  const mutationIdentity = source.slice(
    mutationIdentityStart,
    source.indexOf("const receiptIdentitySha256 =", mutationIdentityStart),
  );
  assert.match(mutationIdentity, /mutationIdentity: idempotencyIdentity/);
  assert.doesNotMatch(mutationIdentity, /mutationIndex/);
  assert.match(source, /identity: `\$\{options\.identity\}:request_attempt:\$\{attempt \+ 1\}`/);
  assert.match(source, /idempotencyIdentity: options\.identity/);
  assert.match(
    applyLoop,
    /finally \{[\s\S]*recordApplyActionLedgerItemResults\(\{[\s\S]*activeApplyItem = null;/,
  );
  const yieldStart = source.indexOf(
    "runtimeBudget.onYield = (reason: string, resumeCurrent = true): void => {",
  );
  const yieldHandler = source.slice(
    yieldStart,
    source.indexOf("if (fileEntries.length === 0", yieldStart),
  );
  assert.match(yieldHandler, /const interruptedItem = resumeCurrent && activeApplyItem !== null/);
  assert.match(yieldHandler, /finishApply\(\s*interruptedItem,/);
  assert.doesNotMatch(yieldHandler, /finishApply\(\);/);
});

test("apply mutation receipts bind every GitHub request attempt and preserve no-op truth", () => {
  assert.equal(
    isGitHubLabelAlreadyExistsErrorForTest(
      'HTTP 422: Validation Failed (label "priority: high" already exists)',
    ),
    true,
  );
  assert.equal(isGitHubLabelAlreadyExistsErrorForTest("HTTP 500: unavailable"), false);
  const retriedMutation = observedGitHubMutationAttemptsForTest(["transient", "accepted"]);
  assert.deepEqual(retriedMutation, [
    {
      identity: "test_mutation:request_attempt:1",
      idempotencyIdentity: "test_mutation",
      outcome: "unknown",
    },
    {
      identity: "test_mutation:request_attempt:2",
      idempotencyIdentity: "test_mutation",
      outcome: "accepted",
    },
  ]);
  assert.notEqual(retriedMutation[0]?.identity, retriedMutation[1]?.identity);
  assert.equal(retriedMutation[0]?.idempotencyIdentity, retriedMutation[1]?.idempotencyIdentity);
  assert.deepEqual(observedGitHubMutationAttemptsForTest(["already_exists"]), [
    {
      identity: "test_mutation:request_attempt:1",
      idempotencyIdentity: "test_mutation",
      outcome: "rejected",
    },
  ]);
  assert.deepEqual(observedGitHubMutationAttemptsForTest(["not_started"]), []);
  assert.deepEqual(heldReviewStartStatusCommentResultForTest("2026-07-12T12:00:00Z", false), {
    status: "held",
    lease: null,
    retryAt: "2026-07-12T12:00:00Z",
    didMutate: false,
  });
  assert.deepEqual(heldReviewStartStatusCommentResultForTest("2026-07-12T12:00:00Z", true), {
    status: "held",
    lease: null,
    retryAt: "2026-07-12T12:00:00Z",
    didMutate: true,
  });

  const source = readText("src/clawsweeper.ts");
  const labelCreates = source.match(/identity: `label_create:/g) ?? [];
  const labelNoMutationClassifiers =
    source.match(/knownNoMutation: labelAlreadyExistsError/g) ?? [];
  assert.ok(labelCreates.length > 0);
  assert.ok(labelNoMutationClassifiers.length >= labelCreates.length);
  assert.match(source, /identity: `review_lease_post:/);
  assert.match(source, /identity: `review_lease_delete:/);
  assert.doesNotMatch(source, /identity: `apply_lease_acquire:/);
  assert.match(source, /return \{ status: "posted", lease: acquired, didMutate: true \}/);
  assert.deepEqual(applyPhaseSequenceForTest(6), [2, 3, 4, 5, 6, 7]);
});

test("runtime yields bind the active item and terminal Codex failures preserve retryability", () => {
  assert.deepEqual(
    applyRuntimeBudgetYieldResultsForTest(512, "max runtime reached during coverage proof"),
    [
      {
        number: 512,
        action: "skipped_runtime_budget",
        reason: "max runtime reached during coverage proof",
      },
      {
        number: 0,
        action: "skipped_runtime_budget",
        reason: "max runtime reached during coverage proof",
      },
    ],
  );
  assert.equal(codexReviewFailureRetryableForTest(false), false);
  assert.equal(codexReviewFailureRetryableForTest(true), true);
  assert.equal(combinedCodexReviewRetryableForTest(true, false), false);
  assert.equal(combinedCodexReviewRetryableForTest(false, true), true);
});

test("retry dispatch outcomes distinguish definite rejection, ambiguity, and acceptance", () => {
  assert.equal(
    classifyGitHubDispatchResultForTest({ status: 1, stderr: "HTTP 422: validation failed" }),
    "definitely_not_dispatched",
  );
  assert.equal(
    classifyGitHubDispatchResultForTest({ status: 1, stderr: "HTTP 502: bad gateway" }),
    "ambiguous_transport",
  );
  assert.equal(
    classifyGitHubDispatchResultForTest({ status: null, errorCode: "ETIMEDOUT" }),
    "ambiguous_transport",
  );
  assert.equal(classifyGitHubDispatchResultForTest({ status: 0 }), "accepted");
});

test("untrusted Codex processes cannot inherit action-ledger producer authority", () => {
  const env = untrustedCodexEnvForTest({
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: "/tmp/privileged-ledger",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "review-0",
    GH_TOKEN: "ambient",
  });
  assert.equal(env.CLAWSWEEPER_ACTION_LEDGER_FORCE, undefined);
  assert.equal(env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT, undefined);
  assert.equal(env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION, undefined);
  assert.equal(env.GH_TOKEN, undefined);
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
  const applyProofStep = workflow.indexOf("- name: Generate bound close coverage proofs");
  const applyProofFinalizer = workflow.indexOf("- name: Finalize apply proof action ledger");
  const applyStep = workflow.indexOf("- name: Apply unchanged proposed decisions with checkpoints");
  const applyFinalizer = workflow.indexOf("- name: Finalize apply action ledger");
  const applyPublish = workflow.indexOf("- name: Publish apply action events");
  const retryStep = workflow.indexOf("- name: Plan or dispatch failed-review retries");
  const retryFinalizer = workflow.indexOf("- name: Finalize failed-review retry action ledger");
  const retryPublish = workflow.indexOf("- name: Publish failed-review retry action ledger");

  assert.ok(reviewStep >= 0);
  assert.ok(reviewFinalizer > reviewStep);
  assert.ok(reviewUpload > reviewFinalizer);
  assert.match(
    workflow.slice(reviewFinalizer, reviewUpload),
    /if: always\(\)[\s\S]*node dist\/clawsweeper\.js finalize-action-events/,
  );
  assert.ok(applyProofStep >= 0);
  assert.ok(applyProofFinalizer > applyProofStep);
  assert.match(
    workflow.slice(applyProofStep, applyProofFinalizer),
    /id: generate-apply-proofs[\s\S]*timeout-minutes: 50/,
  );
  assert.match(
    workflow.slice(applyProofFinalizer, applyProofFinalizer + 700),
    /APPLY_PROOF_OUTCOME:[\s\S]*--interrupt-open-attempts --reason cancelled[\s\S]*--interrupt-open-attempts --reason workflow_failed/,
  );
  assert.ok(applyStep >= 0);
  assert.ok(applyFinalizer > applyStep);
  assert.ok(applyPublish > applyFinalizer);
  assert.match(
    workflow.slice(applyStep, applyFinalizer),
    /id: apply-existing-run[\s\S]*timeout-minutes: 350/,
  );
  assert.match(
    workflow.slice(applyFinalizer, applyPublish),
    /if: \$\{\{ always\(\) \}\}[\s\S]*APPLY_OUTCOME:[\s\S]*--interrupt-open-attempts --reason cancelled[\s\S]*--interrupt-open-attempts --reason workflow_failed/,
  );
  assert.ok(retryStep >= 0);
  assert.ok(retryFinalizer > retryStep);
  assert.ok(retryPublish > retryFinalizer);
  assert.match(workflow.slice(retryStep, retryFinalizer), /id: retry-failed-reviews-run/);
  assert.match(
    workflow.slice(retryFinalizer, retryPublish),
    /RETRY_EXIT_CODE:[\s\S]*--interrupt-open-attempts --reason cancelled[\s\S]*--interrupt-open-attempts --reason timeout[\s\S]*--interrupt-open-attempts --reason workflow_failed/,
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
  assert.equal((workflow.match(/publish-action-event-paths/g) ?? []).length, 7);
  assert.doesNotMatch(workflow, /action_ledger_args/);
  assert.doesNotMatch(
    workflow,
    /--message "chore: append (?:review|apply).*action ledger"[\s\S]{0,180}--path "ledger\/v1\/events"/,
  );
});
