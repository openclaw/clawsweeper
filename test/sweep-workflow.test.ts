import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";

import { makeTreeReadOnlyForTest, restoreTreeModesForTest } from "../dist/clawsweeper.js";
import { readText, tmpPrefix } from "./helpers.ts";

test("sweep keeps optional media tooling out of review startup", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.doesNotMatch(workflow, /setup-media-proof-tools/);
});

test("ledger-producing jobs initialize immutable workflow context", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  for (const jobName of [
    "event-review-apply",
    "event-review-publish",
    "review",
    "publish",
    "retry-failed-reviews",
    "apply-proof",
    "apply-existing",
  ]) {
    const start = workflow.indexOf(`\n  ${jobName}:`);
    assert.notEqual(start, -1, `missing ${jobName} job`);
    const remaining = workflow.slice(start + 1);
    const nextJob = remaining.match(/\n  [a-z0-9_-]+:\n/);
    const end = nextJob?.index === undefined ? workflow.length : start + 1 + nextJob.index;
    const job = workflow.slice(start, end);
    assert.match(
      job,
      /uses: \.\/(?:clawsweeper\/)?\.github\/actions\/setup-action-ledger/,
      `${jobName} must initialize the action ledger`,
    );
  }

  const action = readText(".github/actions/setup-action-ledger/action.yml");
  assert.match(action, /actions\/runs\/\$\{GITHUB_RUN_ID\}/);
  assert.match(
    action,
    /RUNNER_TEMP\/clawsweeper-action-ledger\/\$\{GITHUB_RUN_ID\}\/\$\{GITHUB_RUN_ATTEMPT\}\/\$\{GITHUB_JOB\}/,
  );
  assert.doesNotMatch(action, /GITHUB_WORKSPACE/);
  assert.match(action, /CLAWSWEEPER_ACTION_LEDGER_FORCE=1/);
  assert.match(action, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(action, /GITHUB_RUN_STARTED_AT=\$run_started_at/);
});

test("review and apply primary boundaries ignore ledger-only failures", () => {
  type WorkflowStep = {
    name?: string;
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    "continue-on-error"?: boolean;
  };
  type WorkflowJob = {
    if?: string;
    steps: WorkflowStep[];
  };

  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const job = (name: string): WorkflowJob => {
    const value = workflow.jobs[name];
    assert.ok(value, `missing ${name} job`);
    return value;
  };
  const step = (jobName: string, name: string): WorkflowStep => {
    const value = job(jobName).steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing ${jobName} step ${name}`);
    return value;
  };
  const setupLedger = (jobName: string): WorkflowStep => {
    const value = job(jobName).steps.find((candidate) =>
      candidate.uses?.endsWith("/setup-action-ledger"),
    );
    assert.ok(value, `missing ${jobName} ledger setup`);
    return value;
  };

  for (const jobName of [
    "event-review-apply",
    "event-review-publish",
    "review",
    "publish",
    "retry-failed-reviews",
    "apply-proof",
    "apply-existing",
  ]) {
    assert.equal(
      setupLedger(jobName)["continue-on-error"],
      true,
      `${jobName} ledger setup must fail open`,
    );
  }
  for (const [jobName, stepName] of [
    ["event-review-apply", "Finalize exact event action ledger"],
    ["review", "Finalize review action ledger"],
  ] as const) {
    assert.equal(
      step(jobName, stepName)["continue-on-error"],
      true,
      `${stepName} must not poison primary review publication`,
    );
  }

  const exactBundle = step("event-review-apply", "Create exact review artifact bundle");
  assert.match(exactBundle.if ?? "", /review-exact-event-item\.outcome == 'success'/);
  assert.doesNotMatch(exactBundle.if ?? "", /action-ledger/);
  const exactPrimary = step("event-review-apply", "Export exact review generation result");
  const exactQueue = step("event-review-apply", "Complete exact-review queue lease");
  const exactUpload = step("event-review-apply", "Upload exact review artifact bundle");
  const exactPublicationQueue = step(
    "event-review-apply",
    "Queue durable exact review publication",
  );
  const exactSteps = job("event-review-apply").steps;
  assert.match(exactPrimary.run ?? "", /outcome=(?:failure|cancelled|success)/);
  assert.match(exactPrimary.run ?? "", /REVIEW_OUTCOME.*cancelled/);
  assert.match(exactPrimary.run ?? "", /PUBLICATION_QUEUE_OUTCOME.*success/);
  assert.match(exactQueue.env?.PRIMARY_OUTCOME ?? "", /exact-review-generation-result/);
  assert.doesNotMatch(exactQueue.run ?? "", /JOB_STATUS|job\.status/);
  assert.ok(exactSteps.indexOf(exactUpload) < exactSteps.indexOf(exactQueue));
  assert.ok(exactSteps.indexOf(exactUpload) < exactSteps.indexOf(exactPublicationQueue));
  assert.ok(exactSteps.indexOf(exactPublicationQueue) < exactSteps.indexOf(exactQueue));
  assert.ok(exactSteps.indexOf(exactQueue) > exactSteps.indexOf(exactPrimary));
  assert.equal(
    job("event-review-publish").steps.some(
      (candidate) => candidate.name === "Publish exact review action ledger",
    ),
    false,
  );

  const ledgerDownload = job("publish").steps.find(
    (candidate) => candidate.id === "download-review-action-ledger",
  );
  assert.ok(ledgerDownload);
  assert.equal(ledgerDownload["continue-on-error"], true);
  for (const name of [
    "Import immutable review action events",
    "Publish immutable review action ledger",
  ]) {
    assert.equal(step("publish", name)["continue-on-error"], true, `${name} must fail open`);
  }
  const artifactSync = step("publish", "Sync before applying artifacts");
  assert.match(artifactSync.if ?? "", /setup-publish-state\.outcome == 'success'/);
  assert.match(artifactSync.if ?? "", /setup-publish-pnpm\.outcome == 'success'/);
  assert.match(artifactSync.if ?? "", /download-review-artifacts\.outcome == 'success'/);
  assert.doesNotMatch(artifactSync.if ?? "", /action-ledger/);
  const artifactApply = step("publish", "Apply review artifacts");
  assert.match(artifactApply.if ?? "", /sync-review-artifacts\.outcome == 'success'/);
  assert.match(artifactApply.run ?? "", /review_batch_succeeded=/);
  assert.match(artifactApply.run ?? "", /artifacts_applied=true/);
  const artifactLedger = step("publish", "Publish review artifact action ledger");
  assert.match(artifactLedger.if ?? "", /apply-review-artifacts\.outputs\.artifacts_applied/);
  const recordPublish = step("publish", "Commit review records");
  assert.match(recordPublish.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.match(recordPublish.if ?? "", /apply-review-artifacts\.outputs\.artifacts_applied/);
  assert.match(recordPublish.run ?? "", /records_published=true/);

  for (const name of [
    "Dispatch reproducible bug implementation candidates",
    "Dispatch vision-fit implementation candidates",
    "Backfill viable open issue implementation candidates",
    "Dispatch background review comment sync",
    "Sync selected review comments",
  ]) {
    const condition = step("publish", name).if ?? "";
    assert.match(condition, /always\(\) && !cancelled\(\)/, name);
    assert.match(condition, /commit-review-records\.outputs\.records_published == 'true'/, name);
    assert.doesNotMatch(condition, /success\(\)|action-ledger/, name);
  }
  const selectedApply = step("publish", "Dispatch selected safe close proposals to isolated apply");
  assert.match(selectedApply.if ?? "", /sync-selected-review-comments\.outputs\.sync_succeeded/);
  assert.doesNotMatch(selectedApply.if ?? "", /success\(\)|action-ledger/);
  const reviewContinuation = step("publish", "Continue sweep");
  assert.match(
    reviewContinuation.if ?? "",
    /apply-review-artifacts\.outputs\.review_batch_succeeded/,
  );
  assert.match(reviewContinuation.if ?? "", /commit-review-records\.outputs\.records_published/);
  assert.doesNotMatch(reviewContinuation.if ?? "", /success\(\)|action-ledger/);

  const proofMarker = step("apply-proof", "Export primary apply proof result");
  assert.match(proofMarker.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.match(proofMarker.if ?? "", /proof-select\.outcome == 'success'/);
  assert.match(proofMarker.if ?? "", /generate-apply-proofs\.outcome == 'success'/);
  assert.doesNotMatch(proofMarker.if ?? "", /success\(\)|action-ledger/);
  assert.match(job("apply-existing").if ?? "", /needs\.apply-proof\.outputs\.proof_ready/);
  assert.doesNotMatch(
    job("apply-existing").if ?? "",
    /needs\.apply-proof\.result|publish-apply-proof-action-ledger/,
  );

  const applySteps = job("apply-existing").steps;
  const applyMarkerIndex = applySteps.findIndex(
    (candidate) => candidate.name === "Export primary apply result",
  );
  const applyFinalizerIndex = applySteps.findIndex(
    (candidate) => candidate.name === "Finalize apply action ledger",
  );
  assert.ok(applyMarkerIndex >= 0);
  assert.ok(applyFinalizerIndex > applyMarkerIndex);
  const applyMarker = applySteps[applyMarkerIndex]!;
  assert.match(applyMarker.if ?? "", /apply-existing-run\.outcome == 'success'/);
  for (const name of [
    "Retry final apply status publication",
    "Continue apply sweep",
    "Queue review backstops",
  ]) {
    const condition = step("apply-existing", name).if ?? "";
    assert.match(condition, /always\(\) && !cancelled\(\)/, name);
    assert.match(condition, /primary-apply-result\.outputs\.succeeded == 'true'/, name);
    assert.doesNotMatch(condition, /success\(\)|action-ledger/, name);
  }
});

test("review workflow gives Codex a read-only inspection token", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewJobStart = workflow.indexOf("\n  event-review-apply:");
  const planJobStart = workflow.indexOf("\n  plan:", eventReviewJobStart);
  const eventReviewJob = workflow.slice(eventReviewJobStart, planJobStart);
  const reviewJobStart = workflow.indexOf("\n  review:");
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);
  const exactReviewStart = eventReviewJob.indexOf("- name: Review exact event item");
  const stateTokenStart = eventReviewJob.indexOf("- name: Create state token", exactReviewStart);
  const exactReviewStep = eventReviewJob.slice(exactReviewStart, stateTokenStart);

  assert.match(workflow, /id: codex-inspection-token/);
  assert.match(workflow, /permission-issues: read/);
  assert.match(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
  assert.match(
    exactReviewStep,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.match(
    exactReviewStep,
    /report_path="artifacts\/event\/\$\{\{ steps\.target\.outputs\.item_number \}\}\.md"/,
  );
  assert.match(exactReviewStep, /coordination-held\.json/);
  assert.match(exactReviewStep, /echo "retry_at=\$retry_at" >> "\$GITHUB_OUTPUT"/);
  assert.match(exactReviewStep, /Exact review produced no artifact for open item/);
  assert.match(reviewJob, /uses: \.\/clawsweeper\/\.github\/actions\/setup-codex/);
  assert.doesNotMatch(reviewJob, /uses: \.\/\.github\/actions\/setup-codex/);
  assert.match(exactReviewStep, /--codex-sandbox read-only/);
  assert.match(exactReviewStep, /--skip-start-comment/);
  assert.match(reviewJob, /--codex-sandbox read-only/);
  assert.doesNotMatch(workflow, /--codex-sandbox danger-full-access/);
});

test("review execution tokens can read check runs and commit statuses", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewStart = workflow.indexOf("\n  event-review-apply:");
  const planStart = workflow.indexOf("\n  plan:", eventReviewStart);
  const reviewStart = workflow.indexOf("\n  review:", planStart);
  const publishStart = workflow.indexOf("\n  publish:", reviewStart);
  const eventReviewJob = workflow.slice(eventReviewStart, planStart);
  const scheduledReviewJob = workflow.slice(reviewStart, publishStart);

  for (const [job, tokenId] of [
    [eventReviewJob, "target-read-token"],
    [scheduledReviewJob, "target-read-token"],
  ] as const) {
    const permissions = job.slice(job.indexOf("\n    permissions:"), job.indexOf("\n    steps:"));
    const targetTokenStart = job.indexOf(`id: ${tokenId}`);
    const targetTokenEnd = job.indexOf("\n      - ", targetTokenStart);
    const targetToken = job.slice(targetTokenStart, targetTokenEnd);

    assert.match(permissions, /checks: read/);
    assert.match(permissions, /statuses: read/);
    assert.match(targetToken, /permission-checks: read/);
    assert.match(targetToken, /permission-statuses: read/);
  }
  assert.match(
    eventReviewJob,
    /Review exact event item[\s\S]*GH_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \}\}/,
  );
});

test("scheduled review shards receive the compiler-backed runtime artifact", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const planJobStart = workflow.indexOf("\n  plan:");
  const reviewJobStart = workflow.indexOf("\n  review:", planJobStart);
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const planJob = workflow.slice(planJobStart, reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);

  assert.match(
    planJob,
    /node scripts\/prepare-review-runtime\.mjs[\s\S]*--output \.artifacts\/review-runtime[\s\S]*--plan plan\.json[\s\S]*--state-root "\$CLAWSWEEPER_STATE_DIR"[\s\S]*--records-path "records\/\$\{target_slug\}\/items"/,
  );
  assert.ok(
    planJob.indexOf("id: select") < planJob.indexOf("name: Prepare review runtime artifact"),
  );
  assert.match(
    planJob,
    /tar -czf \.artifacts\/review-runtime\.tar\.gz -C \.artifacts\/review-runtime \./,
  );
  assert.match(
    planJob,
    /name: clawsweeper-runtime-dist\s+path: clawsweeper\/\.artifacts\/review-runtime\.tar\.gz\s+include-hidden-files: true/,
  );
  assert.match(reviewJob, /name: clawsweeper-runtime-dist\s+path: clawsweeper\/\.artifacts/);
  assert.doesNotMatch(reviewJob, /name: clawsweeper-runtime-dist\s+path: clawsweeper\/dist/);
  assert.match(reviewJob, /tar -xzf \.artifacts\/review-runtime\.tar\.gz/);
  assert.match(
    reviewJob,
    /name: Install review compiler service\s+continue-on-error: true[\s\S]*node scripts\/install-review-native-compiler\.mjs/,
  );
  assert.doesNotMatch(reviewJob, /npm pack "@typescript/);
});

test("exact event review hands immutable artifacts to the queue-bounded publisher lane", () => {
  type Step = {
    "continue-on-error"?: boolean;
    name?: string;
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number | boolean>;
  };
  type Job = {
    needs?: string | string[];
    if?: string;
    "timeout-minutes"?: number;
    permissions?: Record<string, string>;
    concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
    steps: Step[];
  };
  const source = readText(".github/workflows/sweep.yml");
  const workflow = YAML.parse(source) as { jobs: Record<string, Job> };
  const reviewer = workflow.jobs["event-review-apply"]!;
  const publisher = workflow.jobs["event-review-publish"]!;
  const batchPublisher = workflow.jobs.publish!;
  const step = (job: Job, name: string) => {
    const value = job.steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing step: ${name}`);
    return value;
  };

  assert.equal(reviewer.permissions?.contents, "read");
  assert.equal(reviewer["timeout-minutes"], 120);
  assert.equal(reviewer.permissions?.issues, "read");
  assert.equal(
    reviewer.steps.some((candidate) => candidate.uses?.endsWith("/setup-state")),
    false,
  );
  assert.equal(
    reviewer.steps.some(
      (candidate) => candidate.name === "Publish event result and apply safe close",
    ),
    false,
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.GH_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--skip-start-comment/);
  const reserveLease = step(reviewer, "Reserve exact review lease");
  assert.equal(reserveLease.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
  assert.match(reserveLease.run ?? "", /pnpm run --silent reserve-review-lease/);
  assert.match(reserveLease.run ?? "", /review-timeout-ms/);
  const resolvePayload = step(reviewer, "Resolve event payload");
  assert.match(resolvePayload.run ?? "", /maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(
    resolvePayload.run ?? "",
    /Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)/,
  );
  assert.match(
    resolvePayload.run ?? "",
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs/,
  );
  assert.match(
    step(reviewer, "Review exact event item").if ?? "",
    /reserve-exact-review-lease\.outputs\.status == 'posted'/,
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--review-lease-owner/);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--review-lease-comment-id/);

  const create = step(reviewer, "Create exact review artifact bundle");
  const upload = step(reviewer, "Upload exact review artifact bundle");
  const queuePublication = step(reviewer, "Queue durable exact review publication");
  const complete = step(reviewer, "Complete exact-review queue lease");
  const deferHeldReview = step(reviewer, "Defer exact review while same-head lease is held");
  const failGeneration = step(reviewer, "Fail unsuccessful exact review generation");
  const releaseGeneration = step(reviewer, "Release unsuccessful workflow-owned review lease");
  assert.match(create.if ?? "", /review-exact-event-item\.outcome == 'success'/);
  assert.match(create.if ?? "", /review-exact-event-item\.outputs\.retry_at == ''/);
  assert.equal(create.env?.EXACT_REVIEW_PRODUCER_JOB, "event-review-apply");
  assert.equal(
    create.env?.EXACT_REVIEW_DECISION,
    "${{ steps.claim-exact-review-queue.outputs.decision }}",
  );
  assert.match(create.run ?? "", /mkdir -p \.artifacts/);
  assert.ok(
    (create.run ?? "").indexOf("mkdir -p .artifacts") <
      (create.run ?? "").indexOf("exact-review-bundle create"),
  );
  assert.equal(upload.uses, "actions/upload-artifact@v7");
  assert.equal(upload.with?.["retention-days"], 90);
  assert.match(queuePublication.run ?? "", /for attempt in 1 2 3/);
  assert.match(queuePublication.run ?? "", /\.queued == true or \.deduped == true/);
  assert.match(complete.env?.PRIMARY_OUTCOME ?? "", /exact-review-generation-result/);
  assert.match(deferHeldReview.if ?? "", /reserve-exact-review-lease\.outputs\.status == 'held'/);
  assert.match(deferHeldReview.run ?? "", /retry deferred/);
  assert.match(failGeneration.if ?? "", /reserve-exact-review-lease\.outputs\.status != 'held'/);
  assert.match(failGeneration.if ?? "", /complete-exact-review-queue\.outcome != 'success'/);
  assert.match(releaseGeneration.if ?? "", /reserve-exact-review-lease\.outputs\.status != 'held'/);
  assert.match(releaseGeneration.run ?? "", /content == "eyes"/);
  assert.ok(reviewer.steps.indexOf(upload) < reviewer.steps.indexOf(complete));

  assert.equal(publisher.needs, undefined);
  assert.match(publisher.if ?? "", /source_action == 'exact_review_artifact_publish'/);
  assert.match(
    step(publisher, "Claim durable exact review publication").run ?? "",
    /internal\/exact-review\/claim/,
  );
  assert.equal(publisher.concurrency, undefined);
  assert.equal(publisher.permissions?.actions, "write");
  assert.equal(
    batchPublisher.concurrency?.group,
    "clawsweeper-target-review-publish-${{ needs.plan.outputs.target_repo }}",
  );
  const publicationContext = step(publisher, "Claim durable exact review publication");
  assert.match(
    publicationContext.run ?? "",
    /producerDecision\.commandStatusMarker \|\| producerDecision\.statusCommentId/,
  );

  const download = step(publisher, "Download exact review artifact bundle");
  const validate = step(publisher, "Validate exact review artifact bundle");
  const legacyArtifact = step(publisher, "Identify legacy tuple-less exact artifact");
  const targetWriteStep = step(publisher, "Create target write token");
  const stateSetup = publisher.steps.find((candidate) => candidate.uses?.endsWith("/setup-state"));
  assert.ok(stateSetup);
  const publisherCheckout = publisher.steps.find(
    (candidate) => candidate.uses === "actions/checkout@v7",
  );
  assert.ok(publisherCheckout);
  assert.equal(publisherCheckout.with?.ref, "main");
  assert.equal(download.uses, "actions/download-artifact@v8");
  assert.equal(download["continue-on-error"], true);
  assert.equal(download.with?.name, "${{ steps.publication-context.outputs.artifact_name }}");
  assert.equal(
    download.with?.["run-id"],
    "${{ steps.publication-context.outputs.producer_run_id }}",
  );
  assert.match(validate.run ?? "", /repair:exact-review-bundle validate/);
  assert.equal(validate["continue-on-error"], true);
  assert.match(legacyArtifact.run ?? "", /review_lease_owner/);
  assert.match(legacyArtifact.run ?? "", /review_lease_comment_id/);
  assert.doesNotMatch(create.run ?? "", /repair:exact-review-bundle -- create/);
  assert.doesNotMatch(validate.run ?? "", /repair:exact-review-bundle -- validate/);
  assert.ok(publisher.steps.indexOf(validate) < publisher.steps.indexOf(targetWriteStep));
  assert.ok(publisher.steps.indexOf(validate) < publisher.steps.indexOf(stateSetup));
  assert.match(stateSetup.if ?? "", /legacy-exact-artifact\.outputs\.legacy_tupleless != 'true'/);

  const publish = step(publisher, "Publish event result and apply safe close");
  assert.match(publish.run ?? "", /live_state=.*gh api/);
  assert.match(publish.run ?? "", /LIVE_TERMINAL_NOOP.*LIVE_TERMINAL_MISSING/);
  assert.match(publish.run ?? "", /LIVE_GUARDED_OPEN/);
  assert.match(publish.run ?? "", /live_locked=.*jq -r '\.locked == true'/);
  assert.match(publish.run ?? "", /live_locked.*true[\s\S]*guarded_open=true/);
  assert.match(publish.run ?? "", /open\)[\s\S]*?requeue_latest=true/);
  assert.match(publish.run ?? "", /test -f "artifacts\/event\/\$ITEM_NUMBER\.md"/);
  assert.match(publish.run ?? "", /repair:publish-event-result/);
  assert.match(publish.run ?? "", /failure_kind=github_rate_limit/);
  assert.match(publish.run ?? "", /failure_kind=github_transient/);
  assert.match(publish.run ?? "", /HTTP 429/);
  assert.doesNotMatch(publish.run ?? "", /HTTP \(403\|429\)/);
  assert.match(publish.run ?? "", /PIPESTATUS\[0\]/);
  assert.equal(publish.env?.EXACT_EVENT_PUBLICATION, "true");
  assert.equal(
    publisher.steps.some((candidate) => candidate.name === "Route synced ClawSweeper verdict"),
    false,
  );
  const deferredRoute = step(publisher, "Queue deferred exact verdict router");
  assert.match(deferredRoute.if ?? "", /publish-event-result\.outcome == 'success'/);
  assert.match(deferredRoute.if ?? "", /routing_deferred == 'true'/);
  assert.match(deferredRoute.run ?? "", /repair-comment-router\.yml/);
  assert.equal(
    deferredRoute.env?.ITEM_NUMBER,
    "${{ steps.publication-context.outputs.item_number }}",
  );
  assert.match(deferredRoute.run ?? "", /-f item_numbers="\$ITEM_NUMBER"/);
  const drift = step(publisher, "Queue fresh review after source drift");
  assert.match(drift.if ?? "", /requeue_latest == 'true'/);
  assert.match(drift.if ?? "", /legacy-exact-artifact\.outputs\.legacy_tupleless == 'true'/);
  assert.match(drift.run ?? "", /x-clawsweeper-exact-review-signature/);
  assert.match(drift.run ?? "", /internal\/exact-review\/enqueue/);
  assert.match(drift.run ?? "", /decision\.sourceAction === "failed_review_shard_recovery"/);
  assert.match(drift.run ?? "", /\.queued == true or \.deduped == true or \.shed == true/);
  assert.match(drift.run ?? "", /Source-drift recovery shed by exact-review queue backpressure/);
  const status = step(publisher, "Mark re-review complete");
  assert.equal(status.env?.LIVE_TERMINAL_MISSING, undefined);
  assert.equal(status.env?.LIVE_GUARDED_OPEN, undefined);
  assert.match(status.env?.PUBLISH_COMPLETION_KIND ?? "", /publish-event-result/);
  assert.match(status.if ?? "", /reason_code == 'review_lease_active'/);
  assert.match(status.run ?? "", /PUBLISH_COMPLETION_KIND.*superseded/);
  const commandComplete = step(publisher, "Mark re-review complete");
  assert.doesNotMatch(commandComplete.if ?? "", /completion_kind != 'deferred'/);
  assert.match(commandComplete.run ?? "", /state="Complete"/);
  assert.match(commandComplete.run ?? "", /independent bounded read-only proof check/);
  assert.doesNotMatch(commandComplete.run ?? "", /Close coverage proof pending/);
  assert.match(status.run ?? "", /stale result was superseded/);
  assert.doesNotMatch(status.run ?? "", /LIVE_TERMINAL_MISSING|LIVE_GUARDED_OPEN/);
  const reaction = step(publisher, "React to target item completion");
  assert.match(reaction.if ?? "", /requeue_latest != 'true'/);
  assert.doesNotMatch(reaction.if ?? "", /publication-context.*live_guarded_open/);
  assert.equal(
    publisher.steps.some((candidate) => candidate.name === "Publish exact review action ledger"),
    false,
  );
  const publishResult = step(publisher, "Export exact review publication result");
  const publishComplete = step(publisher, "Complete durable exact review publication");
  const activeLeaseWaiting = step(publisher, "Mark active lease retry waiting");
  const publicationPressure = step(publisher, "Probe GitHub pressure after publication failure");
  const releaseTerminal = step(publisher, "Release terminal review leases");
  const releaseUnsuccessful = step(
    publisher,
    "Release superseded or unsuccessful publisher-owned review lease",
  );
  assert.doesNotMatch(releaseTerminal.if ?? "", /publication-context.*live_terminal_noop/);
  assert.match(releaseTerminal.if ?? "", /publish-event-result.*terminal_noop/);
  assert.match(releaseUnsuccessful.run ?? "", /\.user\.login == \\"clawsweeper\[bot\]\\"/);
  assert.match(releaseUnsuccessful.run ?? "", /content == "eyes"/);
  assert.match(releaseUnsuccessful.if ?? "", /completion_kind == 'superseded'/);
  assert.doesNotMatch(releaseUnsuccessful.if ?? "", /completion_kind == 'deferred'/);
  assert.match(publishResult.env?.PRIOR_JOB_STATUS ?? "", /job\.status/);
  assert.match(publishResult.env?.LEGACY_TUPLELESS ?? "", /legacy-exact-artifact/);
  assert.match(publishResult.env?.FAILURE_KIND ?? "", /publish-event-result/);
  assert.match(publishResult.env?.FAILURE_KIND ?? "", /publication-pressure/);
  assert.match(publishResult.env?.DOWNLOAD_OUTCOME ?? "", /download-exact-review-bundle/);
  assert.match(publishResult.env?.VALIDATE_OUTCOME ?? "", /validate-exact-review-bundle/);
  assert.match(publishResult.env?.PUBLISH_COMPLETION_KIND ?? "", /publish-event-result/);
  assert.match(publishResult.env?.PUBLISH_RETRY_AT ?? "", /publish-event-result/);
  assert.match(publicationPressure.if ?? "", /failure\(\)/);
  assert.match(publicationPressure.run ?? "", /gh api rate_limit/);
  assert.match(publicationPressure.run ?? "", /failure_kind=github_rate_limit/);
  assert.match(publicationPressure.run ?? "", /failure_kind=github_transient/);
  assert.match(publicationPressure.run ?? "", /HTTP 429/);
  assert.doesNotMatch(publicationPressure.run ?? "", /HTTP \(403\|429\)/);
  assert.match(publishResult.run ?? "", /REQUEUE_LATEST.*SOURCE_DRIFT_OUTCOME/);
  assert.match(publishResult.run ?? "", /LEGACY_TUPLELESS.*SOURCE_DRIFT_OUTCOME/);
  assert.match(publishResult.run ?? "", /completion_kind=superseded/);
  assert.match(publishResult.run ?? "", /completion_kind=deferred/);
  assert.match(publishResult.run ?? "", /completion_kind=refresh_required/);
  assert.match(publishResult.run ?? "", /reason_code=close_coverage_retry/);
  assert.match(publishResult.run ?? "", /reason_code=close_coverage_deferred/);
  assert.match(publishResult.run ?? "", /reason_code=review_lease_active/);
  assert.match(publishResult.run ?? "", /reason_code=review_lease_active[\s\S]*?outcome=success/);
  assert.match(publishResult.run ?? "", /retry_at="\$PUBLISH_RETRY_AT"/);
  assert.match(
    publishResult.run ?? "",
    /completion_kind" != "superseded".*completion_kind" != "deferred".*completion_kind" != "refresh_required"/,
  );
  assert.match(publishResult.run ?? "", /reason_code=artifact_unavailable/);
  assert.match(publishResult.run ?? "", /reason_code=invalid_artifact/);
  assert.doesNotMatch(publishResult.run ?? "", /LIVE_TERMINAL_NOOP/);
  assert.match(publishComplete.run ?? "", /internal\/exact-review\/complete/);
  assert.match(publishComplete.env?.FAILURE_KIND ?? "", /exact-review-publication-result/);
  assert.match(publishComplete.env?.RETRY_AT ?? "", /exact-review-publication-result/);
  assert.match(publishComplete.run ?? "", /failure_kind: failureKind/);
  assert.match(publishComplete.run ?? "", /completion_kind: completionKind/);
  assert.match(publishComplete.run ?? "", /reason_code: reasonCode/);
  assert.match(publishComplete.run ?? "", /retry_at: retryAt/);
  assert.ok(publisher.steps.indexOf(publishResult) < publisher.steps.indexOf(publishComplete));
  assert.ok(publisher.steps.indexOf(publishComplete) < publisher.steps.indexOf(activeLeaseWaiting));
  assert.match(activeLeaseWaiting.if ?? "", /reason_code == 'review_lease_active'/);
  assert.match(
    activeLeaseWaiting.if ?? "",
    /complete-exact-review-publication\.outcome == 'success'/,
  );
  assert.match(activeLeaseWaiting.run ?? "", /--state "Waiting"/);

  const publisherSource = readText("src/repair/publish-event-result.ts");
  assert.match(
    publisherSource,
    /exactEventPublication: process\.env\.EXACT_EVENT_PUBLICATION === "true"/,
  );
  assert.match(publisherSource, /"--exact-event-publication"/);
  assert.match(publisherSource, /legacyTuplelessReviewLease/);
  assert.match(publisherSource, /activeReviewLeaseRetryAt/);
  assert.match(publisherSource, /review_lease_active/);
  assert.match(publisherSource, /applyDisposition === "close_coverage_deferred"/);
  assert.match(publisherSource, /EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED/);
  assert.match(publisherSource, /writeLegacyRefreshRequiredOutputs/);
  assert.match(publisherSource, /read-only apply-proof lane/);
  assert.match(publisherSource, /deferredCloseCoverageExpected/);
  assert.match(publisherSource, /deferredCloseCoverageExpected && !candidateMatchesCurrentTuple/);
  assert.match(publisherSource, /syncPublishPaths\(commitPaths\)/);
  assert.match(publisherSource, /\}\) && !deferredCloseCoverage/);
  assert.match(publisherSource, /writePublicationCompletionOutputs\(\s*"superseded"/);
  assert.match(publisherSource, /completionKind: completionSupersededReason/);
  const reviewSource = readText("src/clawsweeper.ts");
  assert.match(reviewSource, /reserveReviewLeaseCommand/);
  assert.match(reviewSource, /suppliedReviewStartLeaseFromArgs/);
  assert.match(reviewSource, /exactEventReviewLeaseDisposition/);
  assert.match(reviewSource, /retryCloseCoverageCommandStatusOnlyUpdate/);
  assert.match(reviewSource, /clawsweeper-command-status:/);
  assert.match(reviewSource, /CLAWSWEEPER_BOT_AUTHORS\.has/);
  const completeStart = publisherSource.indexOf("const complete =");
  assert.ok(publisherSource.indexOf("hardResetToRemoteMain();", completeStart) > completeStart);
  assert.match(publisherSource, /GitCommandTimeoutError/);
  assert.match(publisherSource, /retryable_failure/);
  assert.match(publisherSource, /error instanceof GitCommandTimeoutError/);
  assert.match(
    publisherSource,
    /writePublicationCompletionOutputs\(\s*retryableTimeout \? "retryable_failure" : "permanent_failure",\s*reasonCode,\s*errorFingerprint\(error\),\s*\);/,
  );
  assert.doesNotMatch(publisherSource, /retryableTimeout \? "github_transient" : undefined/);
  assert.ok(
    publisherSource.indexOf("eventSnapshotMatchesCurrent(paths)", completeStart) > completeStart,
  );
});
test("exact event workflow binds all work to the canonical queue claim", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventStart = workflow.indexOf("\n  event-review-apply:");
  const eventEnd = workflow.indexOf("\n  event-review-publish:", eventStart);
  const eventJob = workflow.slice(eventStart, eventEnd);
  const claimStart = eventJob.indexOf("- name: Claim exact-review queue lease");
  const checkoutStart = eventJob.indexOf("- uses: actions/checkout@v7", claimStart);
  const claimStep = eventJob.slice(claimStart, checkoutStart);
  const claimedWork = eventJob.slice(checkoutStart);

  assert.match(
    claimStep,
    /ITEM_KEY: \$\{\{ github\.event\.client_payload\.queue_claim\.item_key \|\| github\.event\.client_payload\.item_key \}\}/,
  );
  assert.match(
    claimStep,
    /QUEUE_LEASE_REVISION: \$\{\{ github\.event\.client_payload\.queue_claim\.lease_revision \|\| github\.event\.client_payload\.lease_revision \}\}/,
  );
  assert.match(
    claimStep,
    /hasTuple \? \{ item_key: itemKey, lease_revision: leaseRevision \} : \{\}/,
  );
  assert.match(claimStep, /response\.item_key !== requestedItemKey/);
  assert.match(claimStep, /response\.lease_revision !== requestedLeaseRevision/);
  assert.match(claimStep, /const itemKey = `\$\{targetRepo\}#\$\{itemNumber\}`/);
  assert.match(claimStep, /claim_generation=\$\{responseProtocol === 2 \? claimGeneration : ""\}/);
  assert.match(claimStep, /protocol_version=\$\{responseProtocol\}/);
  assert.match(claimStep, /decision=\$\{JSON\.stringify\(decision\)\}/);
  assert.doesNotMatch(claimedWork, /github\.event\.client_payload/);
  assert.match(
    claimedWork,
    /CLAIM_TARGET_BRANCH: \$\{\{ fromJSON\(steps\.claim-exact-review-queue\.outputs\.decision\)\.targetBranch \}\}/,
  );
  assert.match(claimedWork, /target_branch="\$CLAIM_TARGET_BRANCH"/);
  assert.match(claimedWork, /if \.pull_request then "pull_request" else "issue" end/);
  assert.match(claimedWork, /steps\.live-item\.outputs\.target_branch/);
  assert.match(
    claimedWork,
    /CLAIM_DECISION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.decision \}\}/,
  );
  assert.match(
    claimedWork,
    /const decision = JSON\.parse\(process\.env\.CLAIM_DECISION \|\| "\{\}"\)/,
  );
  assert.match(
    claimedWork,
    /targetRepo !== "openclaw\/clawhub" \|\| process\.env\.CLAWHUB_ENABLED === "1"/,
  );
  assert.match(
    claimedWork,
    /Create target read token[\s\S]*steps\.target\.outputs\.target_enabled == 'true'/,
  );
  assert.match(
    claimedWork,
    /Check live target item state[\s\S]*steps\.target\.outputs\.target_enabled == 'true'/,
  );
  assert.match(
    claimedWork,
    /Create exact review artifact bundle[\s\S]*steps\.target\.outputs\.target_enabled == 'true'/,
  );
  assert.match(
    claimedWork,
    /CLAIM_GENERATION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.claim_generation \}\}/,
  );
  assert.match(
    claimedWork,
    /PROTOCOL_VERSION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.protocol_version \}\}/,
  );
  assert.match(claimedWork, /item_key: process\.env\.ITEM_KEY/);
  assert.match(claimedWork, /lease_revision: leaseRevision/);
  assert.match(claimedWork, /claim_generation: claimGeneration/);
});

test("exact event review heartbeats its queue lease while Codex runs", () => {
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const review = workflow.jobs["event-review-apply"]!.steps.find(
    (candidate) => candidate.name === "Review exact event item",
  );
  assert.ok(review);
  assert.match(review.env?.EXACT_REVIEW_ITEM_KEY ?? "", /claim-exact-review-queue/);
  assert.match(review.env?.EXACT_REVIEW_LEASE_ID ?? "", /claim-exact-review-queue/);
  assert.match(review.env?.EXACT_REVIEW_LEASE_REVISION ?? "", /claim-exact-review-queue/);
  // The Codex-adjacent review step must never receive the shared webhook secret;
  // the heartbeat authenticates by lease tuple like /claim and /complete.
  assert.equal(review.env?.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  assert.match(review.run ?? "", /item_key: process\.env\.EXACT_REVIEW_ITEM_KEY/);
  assert.match(review.run ?? "", /lease_id: process\.env\.EXACT_REVIEW_LEASE_ID/);
  assert.match(review.run ?? "", /lease_revision: leaseRevision/);
  assert.match(review.run ?? "", /run_id: process\.env\.GITHUB_RUN_ID/);
  assert.doesNotMatch(review.run ?? "", /x-clawsweeper-exact-review-signature/);
  assert.doesNotMatch(review.run ?? "", /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(review.run ?? "", /internal\/exact-review\/heartbeat/);
  assert.match(review.run ?? "", /sleep 300/);
  assert.match(review.run ?? "", /heartbeat_payload=.*\|\| return 0/s);
  assert.doesNotMatch(review.run ?? "", /test -n "\$CLAWSWEEPER_WEBHOOK_SECRET"/);
  assert.match(review.run ?? "", /trap cleanup_heartbeat EXIT/);
  assert.match(review.run ?? "", /kill "\$heartbeat_pid" 2>\/dev\/null \|\| true/);

  const publisher = workflow.jobs["event-review-publish"]!;
  assert.equal(
    publisher.steps.some((step) => step.run?.includes("internal/exact-review/heartbeat")),
    false,
  );
});

test("exact-review lease competition skips only known conflicts and gates both owners", () => {
  type Step = { name?: string; uses?: string; if?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };

  for (const [jobName, claimId] of [
    ["event-review-apply", "claim-exact-review-queue"],
    ["event-review-publish", "publication-context"],
  ]) {
    const steps = workflow.jobs[jobName]!.steps;
    const claim = steps[0]!;
    const claimRun = claim.run ?? "";
    const gate = `steps.${claimId}.outputs.claimed == 'true'`;

    assert.match(claimRun, /printf 'claimed=false\\ndecision=\{\}\\n'/, jobName);
    assert.match(claimRun, /--write-out '%\{http_code\}'/, jobName);
    assert.match(claimRun, /if \[ "\$status" = "409" \]/, jobName);
    for (const reason of [
      "lease_not_active",
      "lease_already_claimed",
      "lease_decision_unavailable",
      "stale_run_attempt",
    ]) {
      assert.match(claimRun, new RegExp(`"${reason}"`), `${jobName}: ${reason}`);
    }
    assert.match(claimRun, /if \(!safeConflicts\.has\(response\.error\)\) process\.exit\(1\)/);
    assert.match(claimRun, /if \[ "\$status" != "200" \]/, jobName);
    assert.match(claimRun, /if \[\[ "\$status" != 5\* \]\]/, jobName);
    assert.match(claimRun, /returned an invalid success payload/, jobName);
    assert.doesNotMatch(claimRun, /curl --fail/, jobName);

    for (const step of steps.slice(1)) {
      assert.match(step.if ?? "", new RegExp(gate.replaceAll(".", "\\.")), step.name ?? step.uses);
    }
  }
});

test("exact event workflow keeps both queue protocol versions live during rolling deploys", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventStart = workflow.indexOf("\n  event-review-apply:");
  const eventEnd = workflow.indexOf("\n  target-fanout:", eventStart);
  const eventJob = workflow.slice(eventStart, eventEnd);
  const claimStart = eventJob.indexOf("- name: Claim exact-review queue lease");
  const checkoutStart = eventJob.indexOf("- uses: actions/checkout@v7", claimStart);
  const claimStep = eventJob.slice(claimStart, checkoutStart);
  const completeStart = eventJob.indexOf("- name: Complete exact-review queue lease");
  const completeEnd = eventJob.indexOf("\n      - ", completeStart + 1);
  const completeStep = eventJob.slice(completeStart, completeEnd);

  assert.match(claimStep, /DISPATCH_PAYLOAD: \$\{\{ toJSON\(github\.event\.client_payload\) \}\}/);
  assert.match(claimStep, /const responseProtocol = Number\(response\.protocol_version \|\| 1\)/);
  assert.match(claimStep, /const legacyDecision = \{/);
  assert.match(claimStep, /response\.decision && typeof response\.decision === "object"/);
  assert.match(claimStep, /reviewOptions\.command_status_marker/);
  assert.match(claimStep, /responseProtocol === 2/);
  assert.match(completeStep, /protocolVersion !== 1 && protocolVersion !== 2/);
  assert.match(completeStep, /protocolVersion === 2/);
  assert.match(completeStep, /: \{\}\),/);
});

test("dashboard syncs Worker secrets with durable lifecycle storage", () => {
  const workflow = readText(".github/workflows/dashboard.yml");
  const smoke = readText("scripts/dashboard-smoke.mjs");
  const config = readText("dashboard/wrangler.toml");

  assert.doesNotMatch(workflow, /storage\/kv\/namespaces/);
  assert.match(config, /\[\[durable_objects\.bindings\]\]/);
  assert.match(config, /name = "STATUS_STORE"/);
  assert.match(config, /class_name = "StatusStore"/);
  assert.match(config, /new_sqlite_classes = \["StatusStore"\]/);
  assert.match(workflow, /workers\/scripts\/\$CLOUDFLARE_WORKER_NAME\/secrets-bulk/);
  assert.match(workflow, /Content-Type: application\/merge-patch\+json/);
  assert.match(workflow, /jq -e '\.success == true'/);
  assert.doesNotMatch(workflow, /wrangler@[^\s]+ secret bulk/);
  assert.match(workflow, /CLAWSWEEPER_EXPECTED_DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /CLAWSWEEPER_DEPLOY_SHA = "%s"/);
  assert.match(workflow, /"\$GITHUB_SHA"/);
  assert.match(smoke, /waitForDashboardDeployment/);
  assert.match(smoke, /\/internal\/exact-review\/reconcile/);
  assert.match(smoke, /method: "POST"/);
  assert.match(smoke, /reconcileResponse\.status !== 401/);
});

test("dashboard CI refreshes on cadence without completion-trigger storms", () => {
  const workflow = readText(".github/workflows/dashboard-ci.yml");
  const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("\npermissions:"));
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("\njobs:"));

  assert.match(triggers, /workflow_dispatch:/);
  assert.match(triggers, /schedule:\s+- cron: "\*\/5 \* \* \* \*"/);
  assert.doesNotMatch(triggers, /workflow_run:/);
  assert.match(concurrency, /group: clawsweeper-live-dashboard-ci/);
  assert.match(concurrency, /cancel-in-progress: true/);
});

test("terminal exact-review runs reconcile through a signed isolated backstop", () => {
  const workflow = readText(".github/workflows/exact-review-reconcile.yml");
  const eventJob = workflow.slice(
    workflow.indexOf("\n  reconcile:"),
    workflow.indexOf("\n  sweep:"),
  );

  assert.match(workflow, /name: Reconcile exact-review leases/);
  assert.match(workflow, /workflow_run:\s+workflows: \[ClawSweeper\]\s+types: \[completed\]/);
  assert.match(workflow, /schedule:\s+- cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(
    workflow,
    /group: exact-review-reconcile-\$\{\{ \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && 'sweep'/,
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(eventJob, /github\.event\.workflow_run\.event == 'repository_dispatch'/);
  assert.match(
    eventJob,
    /startsWith\(github\.event\.workflow_run\.display_title, 'Review event item '\)/,
  );
  assert.match(
    eventJob,
    /SOURCE_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/,
  );
  assert.match(eventJob, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(eventJob, /run_id: process\.env\.SOURCE_RUN_ID/);
  assert.match(eventJob, /run_attempt: runAttempt/);
  assert.match(eventJob, /include_all_claimed: true/);
  assert.match(eventJob, /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(eventJob, /x-clawsweeper-exact-review-signature: \$signature/);
  assert.match(eventJob, /--max-time 120/);
  assert.match(eventJob, /--data-binary "\$payload"/);
  assert.match(eventJob, /\/internal\/exact-review\/reconcile/);
  assert.doesNotMatch(eventJob, /actions\/checkout/);
  assert.doesNotMatch(eventJob, /(?:GH_TOKEN|GITHUB_TOKEN|github\.token)/);

  const sweepJob = workflow.slice(workflow.indexOf("\n  sweep:"));
  assert.match(sweepJob, /timeout-minutes: 10/);
  assert.match(
    sweepJob,
    /permissions:\s+actions: read\s+contents: read\s+issues: read\s+pull-requests: read/,
  );
  assert.match(sweepJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(sweepJob, /\/internal\/exact-review\/claimed-runs/);
  assert.match(sweepJob, /include_all_claimed: true/);
  assert.match(sweepJob, /actions\/runs\/\$\{runId\}\$\{suffix\}/);
  assert.match(sweepJob, /terminal_runs: terminalRuns/);
  assert.match(sweepJob, /\/internal\/exact-review\/reconcile/);
  assert.match(sweepJob, /x-clawsweeper-exact-review-signature/);
  assert.match(sweepJob, /actions\/checkout@v7/);
  assert.match(sweepJob, /build-script: build/);
  assert.match(sweepJob, /name: Recover orphaned review placeholders/);
  assert.match(sweepJob, /run: node dist\/review-placeholder-recovery\.js/);
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_MAX_CHECKS: \$\{\{ vars\.REVIEW_PLACEHOLDER_MAX_CHECKS \|\| '20' \}\}/,
  );
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_MAX_RECOVERIES: \$\{\{ vars\.REVIEW_PLACEHOLDER_MAX_RECOVERIES \|\| '5' \}\}/,
  );
  assert.match(
    sweepJob,
    /REVIEW_PLACEHOLDER_MIN_AGE_HOURS: \$\{\{ vars\.REVIEW_PLACEHOLDER_MIN_AGE_HOURS \|\| '2' \}\}/,
  );
  assert.match(sweepJob, /TARGET_REPO: openclaw\/openclaw/);
});

test("publish workflow dispatches immediate apply through the isolated lane", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publishJobStart = workflow.indexOf("\n  publish:");
  const recoverJobStart = workflow.indexOf("\n  recover-review-failures:", publishJobStart);
  const publishJob = workflow.slice(publishJobStart, recoverJobStart);
  const dispatchStart = publishJob.indexOf(
    "- name: Dispatch selected safe close proposals to isolated apply",
  );
  const dispatchEnd = publishJob.indexOf("\n      - ", dispatchStart + 1);
  const dispatchStep = publishJob.slice(dispatchStart, dispatchEnd);
  const dispatchCondition = dispatchStep.match(/^\s+if: (.+)$/m)?.[1] ?? "";

  assert.doesNotMatch(publishJob, /setup-codex/);
  assert.match(publishJob, /name: Dispatch selected safe close proposals to isolated apply/);
  assert.doesNotMatch(dispatchStep, /pnpm run apply-decisions/);
  assert.match(
    dispatchCondition,
    /^\$\{\{ always\(\) && !cancelled\(\) && steps\.sync-selected-review-comments\.outputs\.sync_succeeded == 'true'/,
  );
  assert.doesNotMatch(dispatchCondition, /sync-selected-review-comments\.outcome/);
  assert.doesNotMatch(dispatchCondition, /finalize-selected-review-comment-action-ledger/);
  assert.doesNotMatch(dispatchCondition, /publish-selected-review-comment-action-ledger/);
  assert.match(dispatchStep, /gh workflow run sweep\.yml/);
  assert.match(dispatchStep, /-f apply_existing=true/);
  assert.match(dispatchStep, /-f apply_item_numbers="\$item_numbers"/);
  assert.match(
    publishJob,
    /group: clawsweeper-target-review-publish-\$\{\{ needs\.plan\.outputs\.target_repo \}\}/,
  );
  assert.match(publishJob, /cancel-in-progress: false/);
  assert.match(publishJob, /queue: max/);
});

test("selected comment sync finalizes interrupted receipts before publication", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publishJobStart = workflow.indexOf("\n  publish:");
  const recoverJobStart = workflow.indexOf("\n  recover-review-failures:", publishJobStart);
  const publishJob = workflow.slice(publishJobStart, recoverJobStart);
  const syncStart = publishJob.indexOf("- name: Sync selected review comments");
  const finalizerStart = publishJob.indexOf(
    "- name: Finalize selected review comment action ledger",
  );
  const publicationStart = publishJob.indexOf(
    "- name: Publish selected review comment action ledger",
  );
  const primarySyncSuccess = publishJob.indexOf(
    'echo "sync_succeeded=true" >> "$GITHUB_OUTPUT"',
    syncStart,
  );
  const statusPublishStart = publishJob.indexOf("pnpm run status --", syncStart);

  assert.ok(syncStart >= 0);
  assert.ok(primarySyncSuccess > syncStart);
  assert.ok(statusPublishStart > primarySyncSuccess);
  assert.ok(finalizerStart > syncStart);
  assert.ok(publicationStart > finalizerStart);
  assert.match(
    publishJob.slice(syncStart, finalizerStart),
    /timeout --kill-after=30s 840s pnpm run apply-decisions[\s\S]*echo "exit_code=\$selected_comment_exit_code" >> "\$GITHUB_OUTPUT"[\s\S]*exit "\$selected_comment_exit_code"/,
  );
  assert.match(
    publishJob.slice(finalizerStart, publicationStart),
    /if: \$\{\{ always\(\)[\s\S]*SELECTED_COMMENT_EXIT_CODE:[\s\S]*--interrupt-open-attempts --reason cancelled[\s\S]*--interrupt-open-attempts --reason timeout[\s\S]*--interrupt-open-attempts --reason workflow_failed[\s\S]*finalize-action-events/,
  );
  assert.match(
    publishJob.slice(publicationStart, publicationStart + 400),
    /steps\.finalize-selected-review-comment-action-ledger\.outcome == 'success'/,
  );
});

test("failed-review retry cleanup restores the captured command failure", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const retryJobStart = workflow.indexOf("\n  retry-failed-reviews:");
  const auditJobStart = workflow.indexOf("\n  audit-dashboard:", retryJobStart);
  const retryJob = workflow.slice(retryJobStart, auditJobStart);
  const commandStart = retryJob.indexOf("- name: Plan or dispatch failed-review retries");
  const finalizerStart = retryJob.indexOf("- name: Finalize failed-review retry action ledger");
  const publicationStart = retryJob.indexOf("- name: Publish failed-review retry action ledger");
  const artifactStart = retryJob.indexOf("uses: actions/upload-artifact@v7", publicationStart);
  const restoreStart = retryJob.indexOf("- name: Restore failed-review retry outcome");

  assert.ok(commandStart >= 0);
  assert.ok(finalizerStart > commandStart);
  assert.ok(publicationStart > finalizerStart);
  assert.ok(artifactStart > publicationStart);
  assert.ok(restoreStart > artifactStart);
  assert.match(
    retryJob.slice(commandStart, finalizerStart),
    /continue-on-error: true[\s\S]*echo "exit_code=\$retry_exit_code" >> "\$GITHUB_OUTPUT"[\s\S]*exit "\$retry_exit_code"/,
  );
  assert.match(
    retryJob.slice(restoreStart),
    /steps\.retry-failed-reviews-run\.outcome != 'success'[\s\S]*RETRY_EXIT_CODE:[\s\S]*exit "\$retry_exit_code"/,
  );
});

test("broad record publishers isolate tuple reconciliation from status and auxiliary state", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  for (const stepName of [
    "Commit review records",
    "Sync selected review comments",
    "Commit Audit Health",
  ]) {
    const start = workflow.indexOf(`- name: ${stepName}`);
    assert.notEqual(start, -1, stepName);
    const nextStep = workflow.indexOf("\n      - ", start + 1);
    const block = workflow.slice(start, nextStep === -1 ? undefined : nextStep);
    const recordsPath = block.indexOf('--path "records/${target_slug}"');
    const tupleStrategy = block.indexOf("--rebase-strategy reconcile-records", recordsPath);
    const secondPublish = block.indexOf("pnpm run repair:publish-main", tupleStrategy);
    const statusPath = block.indexOf("results/sweep-status/${target_slug}.json", secondPublish);
    const statusStrategy = block.indexOf("--rebase-strategy theirs", statusPath);

    assert.ok(recordsPath !== -1, `${stepName} records path`);
    assert.ok(tupleStrategy > recordsPath, `${stepName} tuple strategy`);
    assert.ok(secondPublish > tupleStrategy, `${stepName} split publish`);
    assert.equal(
      block.slice(recordsPath, tupleStrategy).includes("results/sweep-status"),
      false,
      `${stepName} must not mix status into tuple reconciliation`,
    );
    assert.ok(statusPath > secondPublish, `${stepName} status path`);
    assert.ok(statusStrategy > statusPath, `${stepName} status strategy`);
    assert.equal(
      block.slice(secondPublish).includes('--path "records/${target_slug}"'),
      false,
      `${stepName} auxiliary publish must not replay records`,
    );
  }
});

test("apply workflow isolates Codex proof from the credentialed mutation runner", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const workflowConcurrency = workflow.slice(
    workflow.indexOf("\nconcurrency:"),
    workflow.indexOf("\njobs:"),
  );
  const proofJobStart = workflow.indexOf("\n  apply-proof:");
  const proofPublisherStart = workflow.indexOf("\n  publish-apply-proof-action-ledger:");
  const applyJobStart = workflow.indexOf("\n  apply-existing:");
  assert.notEqual(proofJobStart, -1);
  assert.notEqual(proofPublisherStart, -1);
  assert.notEqual(applyJobStart, -1);
  assert.doesNotMatch(workflowConcurrency, /queue: max/);
  assert.match(workflowConcurrency, /cancel-in-progress: false/);
  const proofJob = workflow.slice(proofJobStart, proofPublisherStart);
  const proofPublisherJob = workflow.slice(proofPublisherStart, applyJobStart);
  const applyJob = workflow.slice(applyJobStart);
  const applyCondition = applyJob.match(/^\s+if: (.+)$/m)?.[1] ?? "";
  const proofGenerationStart = proofJob.indexOf("- name: Generate bound close coverage proofs");
  const primaryProofResultStart = proofJob.indexOf("- name: Export primary apply proof result");
  const proofFinalizerStart = proofJob.indexOf("- name: Finalize apply proof action ledger");

  assert.match(
    proofJob,
    /permissions:\s+actions: read\s+contents: read\s+issues: read\s+pull-requests: read/,
  );
  assert.match(proofJob, /persist-credentials: false/);
  assert.match(proofJob, /persist-credentials: "false"/);
  assert.doesNotMatch(proofJob, /Create target write token|Create state token/);
  assert.match(proofJob, /proposed-pr-close-coverage-item-numbers/);
  assert.match(proofJob, /--batch-size 2/);
  assert.match(proofJob, /--coverage-proof-limit 2/);
  assert.match(proofJob, /uses: \.\/\.github\/actions\/setup-codex/);
  assert.match(proofJob, /--dry-run/);
  assert.match(proofJob, /--codex-model internal/);
  assert.match(proofJob, /--codex-reasoning-effort high/);
  assert.match(proofJob, /\*\.proof\.json/);
  assert.match(proofJob, /artifact_name: \$\{\{ steps\.proof-artifact\.outputs\.name \}\}/);
  assert.match(
    proofJob,
    /action_ledger_artifact_name: \$\{\{ steps\.publishable-action-ledger\.outputs\.name \}\}/,
  );
  assert.match(proofJob, /proof_ready: \$\{\{ steps\.primary-proof-result\.outputs\.ready \}\}/);
  assert.match(
    proofJob,
    /name=apply-coverage-proofs-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(proofJob, /name: \$\{\{ steps\.proof-artifact\.outputs\.name \}\}/);
  assert.match(
    proofJob,
    /action_ledger_name=action-ledger-apply-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(proofJob, /id: upload-action-events/);
  assert.match(proofJob, /name: \$\{\{ steps\.proof-artifact\.outputs\.action_ledger_name \}\}/);
  assert.match(
    proofJob,
    /path: \$\{\{ runner\.temp \}\}\/clawsweeper-action-ledger\/\$\{\{ github\.run_id \}\}\/\$\{\{ github\.run_attempt \}\}\/\$\{\{ github\.job \}\}\/\*\*/,
  );
  assert.match(proofJob, /include-hidden-files: true/);
  assert.match(proofJob, /if-no-files-found: error/);
  assert.ok(proofGenerationStart >= 0);
  assert.ok(primaryProofResultStart > proofGenerationStart);
  assert.ok(proofFinalizerStart > primaryProofResultStart);
  assert.match(
    proofJob,
    /id: primary-proof-result[\s\S]*if: \$\{\{ always\(\) && !cancelled\(\) && steps\.proof-select\.outcome == 'success' && \(steps\.proof-select\.outputs\.item_numbers == '' \|\| steps\.generate-apply-proofs\.outcome == 'success'\) \}\}[\s\S]*echo "ready=true" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    proofJob,
    /if: \$\{\{ always\(\) && steps\.upload-action-events\.outputs\.artifact-id != '' \}\}/,
  );

  assert.match(proofPublisherJob, /needs: apply-proof/);
  assert.match(
    proofPublisherJob,
    /if: \$\{\{ always\(\) && needs\.apply-proof\.result != 'skipped' \}\}/,
  );
  assert.match(
    proofPublisherJob,
    /name: \$\{\{ needs\.apply-proof\.outputs\.action_ledger_artifact_name \}\}/,
  );
  assert.match(proofPublisherJob, /path: \.clawsweeper-repair\/action-ledger-proof/);
  assert.match(proofPublisherJob, /Publish apply proof action events/);
  assert.doesNotMatch(proofPublisherJob, /github\.run_attempt/);

  assert.match(applyJob, /needs: \[apply-proof, publish-apply-proof-action-ledger\]/);
  assert.match(
    applyCondition,
    /^\$\{\{ always\(\) && !cancelled\(\) && needs\.apply-proof\.outputs\.proof_ready == 'true' &&/,
  );
  assert.doesNotMatch(applyCondition, /needs\.apply-proof\.result/);
  assert.doesNotMatch(applyCondition, /needs\.publish-apply-proof-action-ledger/);
  assert.doesNotMatch(applyJob, /setup-codex|OPENAI_API_KEY|CLAWSWEEPER_INTERNAL_MODEL/);
  assert.match(applyJob, /Create target write token/);
  assert.match(applyJob, /Create state token/);
  assert.match(applyJob, /actions\/download-artifact@v8/);
  assert.match(applyJob, /name: \$\{\{ needs\.apply-proof\.outputs\.artifact_name \}\}/);
  assert.doesNotMatch(applyJob, /action-ledger-proof/);
  assert.match(applyJob, /validate_coverage_proof_tree .* 8 262144 2097152/);
  assert.doesNotMatch(applyJob, /COVERAGE_PROOF_TRUSTED_STARTED_AT|proof-trust/);
  assert.match(applyJob, /target_repo.*PROOF_TARGET_REPO/);
  assert.match(applyJob, /--require-precomputed-pr-close-coverage-proof/);
  assert.match(applyJob, /--artifact-dir \.artifacts\/apply-proof/);
  assert.match(
    applyJob,
    /group: clawsweeper-target-apply-\$\{\{ needs\.apply-proof\.outputs\.target_repo \}\}/,
  );
  assert.match(applyJob, /cancel-in-progress: false/);
  assert.match(applyJob, /queue: max/);
});

test("apply workflow durably publishes each reconciliation before no-op exits", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const preselectReconcile = applyJob.indexOf('persist_reconciliation "${reconcile_args[@]}"');
  const applyStart = applyJob.indexOf(
    "- name: Apply unchanged proposed decisions with checkpoints",
  );
  const policyNoop = applyJob.indexOf("APPLY_NOOP=true", applyStart);
  const applyReconcile = applyJob.indexOf(
    'persist_reconciliation "${reconcile_args[@]}"',
    applyStart,
  );
  const commentIdle = applyJob.indexOf('--state "Apply comments idle"', applyStart);
  const closeIdle = applyJob.indexOf("publish_automatic_apply_idle", applyStart);

  assert.ok(preselectReconcile !== -1);
  assert.ok(preselectReconcile < applyStart);
  assert.ok(policyNoop > preselectReconcile);
  assert.ok(applyReconcile > policyNoop);
  assert.ok(commentIdle > applyReconcile);
  assert.ok(closeIdle > applyReconcile);
});

test("reconcile publication expands only exact changed record tuples", () => {
  const reconcileJson = JSON.stringify({
    changedItemNumbers: [7, 42],
    changedRecordFiles: ["7.md", "openclaw-openclaw-42.md"],
  });
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$@"; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_reconciled_records "persist reconciliation" "$RECONCILE_JSON"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, RECONCILE_JSON: reconcileJson } },
  );
  assert.deepEqual(output.trim().split("\n"), [
    "reconcile-records",
    "persist reconciliation",
    "records/openclaw-openclaw/items/7.md",
    "records/openclaw-openclaw/closed/7.md",
    "records/openclaw-openclaw/plans/7.md",
    "records/openclaw-openclaw/decision-packets/7.json",
    "records/openclaw-openclaw/items/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/closed/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/plans/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/decision-packets/42.json",
  ]);

  const emptyOutput = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "unexpected publish\\n"; return 1; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_reconciled_records "persist reconciliation" \'{"changedItemNumbers":[],"changedRecordFiles":[]}\'',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(emptyOutput.trim(), "Reconcile changed no durable record tuples.");
});

test("apply checkpoints split record tuples from auxiliary state", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$@"; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_changes "apply checkpoint" records apply-report.json results/sweep-status results/apply-cursors',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(output.trim().split("\n"), [
    "reconcile-records",
    "apply checkpoint",
    "records/openclaw-openclaw",
    "apply-records",
    "apply checkpoint",
    "apply-report.json",
    "results/sweep-status",
    "results/apply-cursors",
  ]);

  const failedOutput = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$1"; [ "$1" != reconcile-records ]; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_changes "apply checkpoint" records apply-report.json || true',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(failedOutput.trim(), "reconcile-records");
});

test("apply workflow rejects malformed or oversized coverage proof artifact trees", () => {
  const root = mkdtempSync(tmpPrefix);
  const validate = (maxFiles = 2, maxFileBytes = 64, maxTotalBytes = 128) =>
    execFileSync(
      "bash",
      [
        "-lc",
        `source scripts/apply-workflow-helpers.sh\nvalidate_coverage_proof_tree "$PROOF_DIR" ${maxFiles} ${maxFileBytes} ${maxTotalBytes}`,
      ],
      { encoding: "utf8", env: { ...process.env, PROOF_DIR: root } },
    );

  try {
    writeFileSync(join(root, "10-20.proof.json"), "{}\n");
    writeFileSync(join(root, "30-40.proof.json"), "{}\n");
    assert.equal(validate(), "");

    writeFileSync(join(root, "50-60.proof.json"), "{}\n");
    assert.throws(() => validate(), /maximum is 2/);
    rmSync(join(root, "50-60.proof.json"));

    writeFileSync(join(root, "unexpected.json"), "{}\n");
    assert.throws(() => validate(3), /Unexpected coverage proof filename/);
    rmSync(join(root, "unexpected.json"));

    mkdirSync(join(root, "nested"));
    assert.throws(() => validate(), /Unexpected non-file coverage proof artifact/);
    rmSync(join(root, "nested"), { recursive: true });

    writeFileSync(join(root, "10-20.proof.json"), "x".repeat(65));
    assert.throws(() => validate(), /exceeds 64 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow target token can inspect source workflow runs", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const tokenStart = applyJob.indexOf("- name: Create target write token");
  const stateTokenStart = applyJob.indexOf("- name: Create state token", tokenStart);

  assert.ok(tokenStart !== -1);
  assert.ok(stateTokenStart > tokenStart);
  assert.match(applyJob.slice(tokenStart, stateTokenStart), /permission-actions: read/);
});

test("targeted apply dispatches keep apply names ahead of exact-review names", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const runName = workflow.slice(workflow.indexOf("run-name:"), workflow.indexOf("\non:"));
  const firstExactDispatchName = runName.indexOf(
    "(github.event_name == 'workflow_dispatch' && startsWith(github.event.inputs.item_numbers, 'router-'))",
  );

  assert.ok(firstExactDispatchName > -1);
  for (const applyName of [
    "format('Sync Codex review comments for {0}'",
    "format('Apply custom ClawSweeper closures for {0}'",
    "format('Apply default ClawSweeper closures for {0}'",
  ]) {
    assert.ok(
      runName.indexOf(applyName) < firstExactDispatchName,
      `${applyName} must win when apply_existing also carries item_number or item_numbers`,
    );
  }
  assert.match(
    workflow,
    /item_numbers="\$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.item_number \|\| github\.event\.inputs\.apply_item_numbers \|\| '' \}\}"/,
  );
});

test("apply workflow bounds checkpoints and requeues with a fresh token", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyHelper = readText("scripts/apply-workflow-helpers.sh");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const applyStep = applyJob.slice(
    applyJob.indexOf("- name: Apply unchanged proposed decisions with checkpoints"),
    applyJob.indexOf("- name: Retry final apply status publication"),
  );
  const continueStep = applyJob.slice(
    applyJob.indexOf("- name: Continue apply sweep"),
    applyJob.indexOf("- name: Queue review backstops"),
  );
  const runMarker = "        run: |\n";
  const runBodyStart = applyStep.indexOf(runMarker);
  assert.notEqual(runBodyStart, -1);
  const runBody = applyStep
    .slice(runBodyStart + runMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");

  assert.match(workflow, /format\('Apply default ClawSweeper closures for \{0\}'/);
  assert.match(workflow, /format\('Apply custom ClawSweeper closures for \{0\}'/);
  assert.match(
    workflow,
    /github\.event\.schedule == '8,23,38,53 \* \* \* \*'\) && 'openclaw\/clawhub'/,
  );
  assert.match(inputBlock, /apply_limit:[\s\S]*default: "20"/);
  assert.match(inputBlock, /apply_checkpoint_size:[\s\S]*default: "20"/);
  assert.match(workflow, /github\.event\.inputs\.apply_limit != '20'/);
  assert.match(workflow, /github\.event\.inputs\.apply_checkpoint_size != '20'/);
  assert.match(applyStep, /Capping apply checkpoint size at 20/);
  assert.match(applyStep, /base_close_processed_limit=300/);
  assert.match(applyHelper, /coverage_proof_limit=2/);
  assert.match(applyHelper, /max_runtime_arg=\(--max-runtime-ms 600000\)/);
  assert.match(applyHelper, /max_close_processed_limit=900/);
  assert.match(applyStep, /close_processed_limit="\$base_close_processed_limit"/);
  assert.match(applyStep, /source scripts\/apply-workflow-helpers\.sh/);
  assert.match(applyStep, /select_adaptive_apply_batch/);
  assert.match(applyHelper, /adaptive-apply-batch-size/);
  assert.match(applyHelper, /--status-path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.ok(
    runBody.length < 20_000,
    `apply run expression is ${runBody.length} characters; keep margin below GitHub's 21,000-character limit`,
  );
  assert.match(applyStep, /processed-limit "\$close_processed_limit"/);
  assert.match(applyStep, /comment_sync_processed_limit=1000/);
  assert.match(applyStep, /--processed-limit "\$comment_sync_processed_limit"/);
  const applyFlagInit = applyStep.indexOf('explicit_item_numbers="$item_numbers"');
  assert.ok(applyFlagInit > applyStep.indexOf('item_numbers="${{'));
  assert.ok(applyFlagInit < applyStep.indexOf("auto_selected_apply_batch=true"));
  assert.match(applyStep, /apply_cursor_path="results\/apply-cursors\/\$\{target_slug\}\.json"/);
  assert.match(applyHelper, /write_apply_health\(\)/);
  assert.match(applyStep, /select_apply_candidate_inventory/);
  assert.match(applyHelper, /proposed-item-inventory/);
  assert.match(
    applyHelper,
    /candidate_inventory_env="\.artifacts\/apply-candidate-inventory\.env"/,
  );
  assert.match(applyHelper, /update_item_numbers="\$\{1:-true\}"/);
  assert.match(applyHelper, /item_numbers="\$\(awk -F=/);
  assert.match(applyHelper, /apply_ready_count="\$\(awk -F=/);
  assert.match(applyHelper, /candidate_counts_json="\$\(awk -F=/);
  assert.match(applyHelper, /--batch-size "\$close_processed_limit"/);
  assert.match(applyHelper, /--coverage-proof-limit "\$coverage_proof_limit"/);
  assert.match(applyHelper, /--cursor-path "\$apply_cursor_path"/);
  assert.match(applyStep, /apply-cursor-advance-count/);
  assert.match(applyStep, /examined_count="\$\(apply_checkpoint_examined_count\)"/);
  assert.match(applyHelper, /apply_checkpoint_examined_count\(\)/);
  assert.match(applyHelper, /printf '%s\\n' "unavailable"/);
  assert.match(applyStep, /Candidates examined: \$examined_count\. Action records: \$result_count/);
  assert.match(applyHelper, /--candidate-count "\$health_candidate_count"/);
  assert.match(applyHelper, /--candidate-counts-json "\$health_candidate_counts_json"/);
  assert.match(applyHelper, /--cursor-advance-count "\$health_cursor_advance_count"/);
  assert.match(applyHelper, /--scheduled-interval-minutes "\$health_scheduled_interval_minutes"/);
  assert.match(applyHelper, /pnpm run --silent workflow -- summarize-apply-report/);
  assert.match(applyHelper, /health_cursor_path="\$\{5:-\}"/);
  assert.match(applyStep, /comment_sync_health_cursor_path="\$cursor_path"/);
  assert.match(applyStep, /comment_sync_health_cursor_required="true"/);
  assert.match(applyStep, /comment_sync_health_processed_limit="\$sync_batch_size"/);
  assert.match(applyStep, /close_health_cursor_path="\$apply_cursor_path"/);
  assert.match(applyStep, /--apply-health-file "\.artifacts\/apply-health-\$checkpoint\.json"/);
  assert.match(applyStep, /--apply-health-file "\.artifacts\/apply-health-final\.json"/);
  assert.match(applyStep, /publish_automatic_apply_idle/);
  assert.match(applyHelper, /--apply-health-file "\.artifacts\/apply-health-idle\.json"/);
  assert.match(applyHelper, /apply-report-idle\.json/);
  assert.match(applyHelper, /--state "Apply idle"/);
  assert.match(applyHelper, /proposed-item-quality-summary/);
  assert.match(applyHelper, /candidate_quality_summary="\$\(awk -F=/);
  assert.match(
    applyHelper,
    /candidate_quality_detail=" Close candidate mix: \$candidate_quality_summary\."/,
  );
  assert.match(applyHelper, /awaiting apply\.\$candidate_quality_detail Scheduled apply/);
  assert.match(
    applyStep,
    /\$apply_close_reasons\.\$candidate_quality_detail Scan window: \$close_processed_limit/,
  );
  const applyReconcileIndex = applyStep.indexOf('persist_reconciliation "${reconcile_args[@]}"');
  const qualitySummaryIndex = applyStep.indexOf("summarize_apply_candidate_quality");
  const candidateInventoryIndex = applyStep.indexOf("select_apply_candidate_inventory");
  const selectedItemsBranchIndex = applyStep.indexOf(
    'if [ -n "$item_numbers" ]',
    candidateInventoryIndex,
  );
  const checkpointPublishIndex = applyStep.indexOf(
    'publish_changes "chore: apply sweep decisions checkpoint $checkpoint"',
  );
  const refreshedInventoryIndex = applyStep.indexOf(
    "select_apply_candidate_inventory",
    candidateInventoryIndex + 1,
  );
  assert.notEqual(applyReconcileIndex, -1);
  assert.ok(qualitySummaryIndex > applyReconcileIndex);
  assert.ok(candidateInventoryIndex > qualitySummaryIndex);
  assert.ok(selectedItemsBranchIndex > candidateInventoryIndex);
  assert.ok(refreshedInventoryIndex > checkpointPublishIndex);
  assert.match(applyStep, /select_apply_candidate_inventory false/);
  assert.doesNotMatch(applyStep, /proposed-item-numbers/);
  assert.match(applyHelper, /--batch-size "\$close_processed_limit"/);
  assert.match(
    applyHelper,
    /--close-limit "\$\(\(limit < checkpoint_size \? limit : checkpoint_size\)\)"/,
  );
  assert.match(applyHelper, /--coverage-proof-limit "\$coverage_proof_limit"/);
  assert.match(applyStep, /select_bounded_coverage_proof_tail/);
  assert.match(applyHelper, /select_bounded_coverage_proof_tail\(\)/);
  assert.match(applyHelper, /proposed-pr-close-coverage-item-numbers/);
  assert.match(applyHelper, /drop_bounded_coverage_proof_tail\(\)/);
  assert.match(applyStep, /drop_bounded_coverage_proof_tail "\$cursor_trace_path"/);
  assert.match(
    applyStep,
    /Scan window: \$close_processed_limit records \(\$adaptive_apply_scan_reason\)/,
  );
  assert.match(applyStep, /Selected \$proposed_count from \$close_processed_limit/);
  assert.match(applyStep, /--cursor-path "\$apply_cursor_path"/);
  assert.match(applyStep, /write-apply-cursor/);
  assert.match(applyStep, /--item-numbers "\$item_numbers"/);
  assert.match(applyStep, /--coverage-proof-item-numbers "\$coverage_proof_item_numbers"/);
  assert.match(applyStep, /--cursor-trace "\$cursor_trace_path"/);
  assert.match(applyStep, /cursor_trace_arg=\(--cursor-trace "\$cursor_trace_path"\)/);
  assert.match(applyStep, /select_automatic_apply_runtime/);
  assert.match(applyStep, /"\$\{max_runtime_arg\[@\]\}"/);
  assert.match(applyStep, /results\/apply-cursors/);
  assert.match(applyStep, /reached its \$close_processed_limit-record budget/);
  assert.match(applyStep, /next scheduled apply run will advance the next window/);
  assert.match(applyStep, /apply_close_reasons="\$\(printf '%s\\n' "\$apply_close_reasons"/);
  assert.match(applyStep, /No enabled close reasons remain after policy filtering/);
  assert.match(applyStep, /true\|1\|yes\|on\) product_direction_enabled=true/);
  assert.match(applyStep, /if \[ "\$result_count" -ge "\$close_processed_limit" \]; then/);
  assert.match(applyHelper, /--action skipped_runtime_budget/);
  assert.match(applyStep, /if automatic_apply_runtime_reached/);
  assert.match(applyHelper, /runtime budget before cursor progress/);
  assert.match(applyHelper, /fresh-token continuation will resume the lane/);
  assert.doesNotMatch(
    applyStep,
    /if \[ "\$result_count" -ge "\$close_processed_limit" \] && \[ "\$closed_in_chunk" -gt 0 \]/,
  );
  assert.match(applyStep, /sync_comments_only" != "true" .*apply_close_reasons/);
  assert.match(applyStep, /continue_apply=true/);
  assert.match(applyStep, /break\n\s+done/);
  assert.match(applyStep, /next_apply_item_numbers="\$item_numbers"/);
  assert.match(applyStep, /next_apply_item_numbers=""/);
  assert.match(applyStep, /echo "APPLY_CONTINUE=\$continue_apply"/);
  assert.match(applyStep, /echo "APPLY_AUTO_SELECTED_BATCH=\$auto_selected_apply_batch"/);
  assert.match(applyStep, /echo "APPLY_CANDIDATE_QUALITY_SUMMARY=\$candidate_quality_summary"/);
  assert.match(continueStep, /APPLY_CONTINUE:-false/);
  assert.match(continueStep, /can_share_apply_continuation=false/);
  assert.match(continueStep, /\[ "\$\{APPLY_AUTO_SELECTED_BATCH:-false\}" = "true" \]/);
  assert.match(continueStep, /\[ -z "\$\{APPLY_ITEM_NUMBERS:-\}" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_LIMIT:-20\}" = "20" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_CHECKPOINT_SIZE:-20\}" = "20" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_COMMENT_SYNC_MIN_AGE_DAYS:-7\}" = "7" \]/);
  assert.match(continueStep, /preserving exact continuation dispatch/);
  assert.match(
    continueStep,
    /gh api --paginate "repos\/\$\{\{ github\.repository \}\}\/actions\/runs\?per_page=100&status=\$\{run_status\}"/,
  );
  assert.match(continueStep, /workflowPath:\.path/);
  assert.doesNotMatch(continueStep, /workflowName:\.name/);
  assert.doesNotMatch(continueStep, /gh run list/);
  assert.match(continueStep, /pnpm run --silent workflow -- apply-continuation-blocker/);
  assert.match(continueStep, /--current-run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(continueStep, /--target-repo "\$\{APPLY_TARGET_REPO:-openclaw\/openclaw\}"/);
  assert.match(continueStep, /APPLY_CONTINUATION_BLOCKED/);
  assert.match(continueStep, /existing default cursor run will continue the lane/);
  assert.match(continueStep, /already covered by \$/);
  assert.match(continueStep, /-f apply_item_numbers="\$APPLY_ITEM_NUMBERS"/);
  assert.doesNotMatch(continueStep, /-f item_numbers=/);
  assert.doesNotMatch(continueStep, /APPLY_CLOSED_TOTAL:-0.*APPLY_LIMIT:-0/);
});

test("apply workflow finalization retries only target status after checkpointed state", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const applyStart = applyJob.indexOf(
    "- name: Apply unchanged proposed decisions with checkpoints",
  );
  const finalStatusStart = applyJob.indexOf("- name: Retry final apply status publication");
  const actionLedgerStart = applyJob.indexOf("- name: Publish apply action events");
  const continueStart = applyJob.indexOf("- name: Continue apply sweep");
  assert.ok(applyStart !== -1);
  assert.ok(finalStatusStart > applyStart);
  assert.ok(actionLedgerStart > finalStatusStart);
  assert.ok(continueStart > actionLedgerStart);
  const applyStep = applyJob.slice(applyStart, finalStatusStart);
  const finalStatusStep = applyJob.slice(finalStatusStart, actionLedgerStart);
  const actionLedgerStep = applyJob.slice(actionLedgerStart, continueStart);

  const commentCheckpoint = applyStep.indexOf(
    'publish_changes "chore: sync sweep review comments checkpoint $checkpoint" records apply-report.json results/comment-sync-cursors',
  );
  const closePaths = applyStep.indexOf("apply_publish_paths=(records apply-report.json)");
  const cursorPath = applyStep.indexOf("apply_publish_paths+=(results/apply-cursors)");
  const closeCheckpoint = applyStep.indexOf(
    'publish_changes "chore: apply sweep decisions checkpoint $checkpoint" "${apply_publish_paths[@]}"',
  );
  assert.ok(commentCheckpoint !== -1);
  assert.ok(closePaths !== -1);
  assert.ok(cursorPath > closePaths);
  assert.ok(closeCheckpoint > cursorPath);
  for (const laterBranch of [
    'if automatic_apply_runtime_reached ".artifacts/apply-reports/apply-report-$checkpoint.json"',
    'if [ "$result_count" -ge "$close_processed_limit" ]; then',
    'if [ "$result_count" -eq 0 ]; then',
    'if [ "$closed_in_chunk" -eq 0 ]; then',
  ]) {
    assert.ok(applyStep.indexOf(laterBranch) > closeCheckpoint);
  }
  assert.match(applyStep, /publish_status "chore: mark sweep apply finished"/);

  assert.match(finalStatusStep, /APPLY_NOOP:-false/);
  assert.match(finalStatusStep, /--message "chore: mark sweep apply finished"/);
  assert.deepEqual(
    [...finalStatusStep.matchAll(/--path\s+("?[^\\\s]+"?)/g)].map((match) => match[1]),
    ['"results/sweep-status/${target_slug}.json"'],
  );
  assert.match(finalStatusStep, /--rebase-strategy apply-records/);
  assert.doesNotMatch(finalStatusStep, /--path\s+"?records(?:\/|\s)/);
  assert.doesNotMatch(finalStatusStep, /apply-report\.json/);
  assert.doesNotMatch(finalStatusStep, /results\/(?:apply|comment-sync)-cursors/);
  assert.match(actionLedgerStep, /publish-action-events/);
  assert.doesNotMatch(actionLedgerStep, /action-ledger-proof/);
  assert.match(actionLedgerStep, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT/);
  assert.match(actionLedgerStep, /--state-root "\$CLAWSWEEPER_STATE_DIR"/);
  assert.match(actionLedgerStep, /--expected-producer-job "\$GITHUB_JOB"/);
  assert.match(actionLedgerStep, /cp "\$durable_event_path" "\$event_path"/);
  assert.match(actionLedgerStep, /--message "chore: append apply action ledger"/);
  assert.match(actionLedgerStep, /publish-action-event-paths/);
  assert.match(actionLedgerStep, /--paths-file "\$event_paths_file"/);
  assert.doesNotMatch(actionLedgerStep, /repair:publish-main/);
  assert.doesNotMatch(actionLedgerStep, /continue-on-error: true/);
  assert.match(actionLedgerStep, /no paths were imported[\s\S]*exit 1/i);
});

test("apply workflow does not queue runtime-yield continuation without cursor progress", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "apply-report.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "pnpm() { printf '1\\n'; }",
          "source scripts/apply-workflow-helpers.sh",
          "continue_apply=false",
          "auto_selected_apply_batch=true",
          "cursor_advance_count=0",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
          "continue_apply=false",
          "cursor_advance_count=1",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          REPORT_PATH: reportPath,
        },
      },
    );

    assert.deepEqual(
      output
        .trim()
        .split("\n")
        .filter((line) => line.includes("|")),
      ["yielded|false", "yielded|true"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow drops a coverage-proof tail only after exact trace examination", () => {
  const root = mkdtempSync(tmpPrefix);
  const fastOnlyTrace = join(root, "fast-only.json");
  const firstProofTrace = join(root, "proof-first.json");
  const secondProofTrace = join(root, "proof-second.json");
  writeFileSync(
    fastOnlyTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }),
  );
  writeFileSync(
    firstProofTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [30] }),
  );
  writeFileSync(
    secondProofTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [40] }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node dist/repair/workflow-utils.js "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          "auto_selected_apply_batch=true",
          "item_numbers=10,20,30,40",
          "coverage_proof_item_numbers=30,40",
          'item_numbers_arg=(--item-numbers "$item_numbers")',
          'drop_bounded_coverage_proof_tail "$FAST_ONLY_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$FIRST_PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$SECOND_PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAST_ONLY_TRACE: fastOnlyTrace,
          FIRST_PROOF_TRACE: firstProofTrace,
          SECOND_PROOF_TRACE: secondProofTrace,
          NODE_BIN_DIR: dirname(process.execPath),
        },
      },
    );
    assert.deepEqual(output.trim().split("\n"), [
      "10,20,30,40|30,40|--item-numbers 10,20,30,40",
      "10,20,40|40|--item-numbers 10,20,40",
      "10,20||--item-numbers 10,20",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply proof and mutation start from fresh non-persisted source checkouts", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const proofJobStart = workflow.indexOf("\n  apply-proof:");
  const proofPublisherStart = workflow.indexOf("\n  publish-apply-proof-action-ledger:");
  const applyJobStart = workflow.indexOf("\n  apply-existing:");
  assert.notEqual(proofJobStart, -1);
  assert.notEqual(proofPublisherStart, -1);
  assert.notEqual(applyJobStart, -1);
  const proofJob = workflow.slice(proofJobStart, proofPublisherStart);
  const applyJob = workflow.slice(applyJobStart);

  assert.match(proofJob, /actions\/checkout@v7[\s\S]*?persist-credentials: false/);
  assert.match(
    proofJob,
    /uses: \.\/\.github\/actions\/setup-state[\s\S]*?persist-credentials: "false"/,
  );
  assert.match(applyJob, /actions\/checkout@v7[\s\S]*?persist-credentials: false/);
  assert.doesNotMatch(proofJob, /git pull --rebase/);
  assert.doesNotMatch(applyJob, /git pull --rebase/);
});

test("sweep target tokens fall back when an org app installation is missing", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const stepBlocks = (name: string) =>
    workflow
      .split(`- name: ${name}`)
      .slice(1)
      .map((block) => block.split("\n      - ")[0]);

  assert.match(
    workflow,
    /CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: \$\{\{ steps\.steipete-token\.outputs\.token \|\| '__public__' \}\}/,
  );
  const openclawInventoryBlocks = stepBlocks("Create OpenClaw inventory token");
  assert.equal(openclawInventoryBlocks.length, 1);
  assert.doesNotMatch(openclawInventoryBlocks[0] ?? "", /continue-on-error: true/);
  for (const name of [
    "Create target read token",
    "Create target write token",
    "Create target review token",
    "Create target Codex inspection token",
  ]) {
    const blocks = stepBlocks(name);
    assert.ok(blocks.length > 0, `missing workflow step: ${name}`);
    for (const block of blocks) {
      assert.match(block, /continue-on-error: true/);
    }
  }
  assert.match(
    workflow,
    /GH_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.match(
    workflow,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.codex-inspection-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.ok(
    workflow.includes(
      "if: ${{ always() && !cancelled() && steps.commit-review-records.outputs.records_published == 'true' && steps.target-write-token.outputs.token != '' && needs.plan.outputs.hot_intake != 'true'",
    ),
  );
  assert.ok(
    workflow.includes(
      "if: ${{ always() && !cancelled() && steps.commit-review-records.outputs.records_published == 'true' && steps.target-write-token.outputs.token != '' && ((github.event_name == 'repository_dispatch'",
    ),
  );
  assert.ok(
    workflow.includes(
      "if: ${{ always() && !cancelled() && steps.sync-selected-review-comments.outputs.sync_succeeded == 'true' && steps.target-write-token.outputs.token != '' && github.event.inputs.apply_after_review == 'true' }}",
    ),
  );
  assert.doesNotMatch(workflow, new RegExp("OPENCLAW_" + "GH_TOKEN"));
});

test("sweep target review token can post pull request review leases", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const targetReviewTokenBlocks = workflow
    .split("- name: Create target review token")
    .slice(1)
    .map((block) => block.split("\n      - ")[0]);

  assert.equal(targetReviewTokenBlocks.length, 1);
  const [targetReviewToken] = targetReviewTokenBlocks;
  assert.match(targetReviewToken ?? "", /permission-issues: write/);
  assert.match(targetReviewToken ?? "", /permission-pull-requests: write/);
});

test("proof nudge workflow is manual-first and scheduled behind repo vars", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const workflow = readText(".github/workflows/proof-nudges.yml");
  const job = workflow.slice(workflow.indexOf("  proof-nudges:"), workflow.length);
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("\njobs:"));

  assert.doesNotMatch(sweepWorkflow, /proof_nudges/);
  assert.match(workflow, /execute:[\s\S]*?default: "false"/);
  assert.match(workflow, /cron: "0 10 \* \* \*"/);
  assert.doesNotMatch(workflow, /cron: "0 11 \* \* \*"/);
  assert.match(concurrency, /clawsweeper-proof-nudges/);
  assert.doesNotMatch(job, /Check scheduled Central time/);
  assert.doesNotMatch(job, /PROOF_NUDGES_SCHEDULE_TZ/);
  assert.doesNotMatch(job, /PROOF_NUDGES_EVENT_SCHEDULE/);
  assert.doesNotMatch(job, /steps\.central-time\.outputs\.should_run == 'true'/);
  assert.match(job, /github\.event_name == 'workflow_dispatch'/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_SCHEDULED == '1'/);
  assert.match(job, /vars\.CLAWSWEEPER_BOT_PROOF_SCHEDULED == '1'/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_EXECUTE == '1'/);
  assert.match(job, /vars\.CLAWSWEEPER_BOT_PROOF_EXECUTE == '1'/);
  assert.match(
    job,
    /github\.event_name == 'schedule' && \(vars\.CLAWSWEEPER_PROOF_NUDGES_SCHEDULED == '1' \|\| vars\.CLAWSWEEPER_BOT_PROOF_SCHEDULED == '1'\)/,
  );
  assert.match(job, /TARGET_REPO_INPUT:/);
  assert.match(job, /target_repo must be owner\/repo/);
  assert.match(job, /PROOF_NUDGES_ITEM_NUMBERS:/);
  assert.match(job, /item_numbers must be a comma-separated list/);
  assert.match(job, /PROOF_NUDGES_LIMIT:/);
  assert.match(job, /PROOF_NUDGES_PROCESSED_LIMIT:/);
  assert.match(job, /PROOF_NUDGES_PROCESSED_LIMIT must be a positive integer/);
  assert.match(job, /PROOF_NUDGES_MIN_AGE_DAYS:/);
  assert.match(job, /PROOF_NUDGES_COOLDOWN_DAYS:/);
  assert.match(job, /permission-pull-requests: write/);
  assert.match(
    job,
    /numeric_input in PROOF_NUDGES_LIMIT PROOF_NUDGES_MIN_AGE_DAYS PROOF_NUDGES_COOLDOWN_DAYS/,
  );
  assert.match(job, /execute_arg=\(\)/);
  assert.match(job, /if \[ "\$PROOF_NUDGES_EXECUTE" = "true" \]/);
  assert.match(job, /processed_limit_arg=\(\)/);
  assert.match(job, /--processed-limit "\$PROOF_NUDGES_PROCESSED_LIMIT"/);
  assert.match(job, /--cursor-path "results\/proof-nudge-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /--cursor-path "results\/bot-proof-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /pnpm run proof-nudges/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_LIMIT/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_PROCESSED_LIMIT/);
  assert.match(job, /repair:publish-main/);
  assert.match(job, /results\/proof-nudge-cursors/);
  assert.match(job, /results\/bot-proof-cursors/);
});

test("proof nudge workflow publishes exact cursor files only for executed lanes", () => {
  const workflow = readFileSync(".github/workflows/proof-nudges.yml", "utf8");
  const job = workflow.slice(workflow.indexOf("  proof-nudges:"), workflow.length);
  assert.match(job, /proof_cursor_path="results\/proof-nudge-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /bot_cursor_path="results\/bot-proof-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /if \[ "\$PROOF_NUDGES_EXECUTE" = "true" \] && \[ -f "\$proof_cursor_path" \]/);
  assert.match(job, /if \[ "\$BOT_PROOF_EXECUTE" = "true" \] && \[ -f "\$bot_cursor_path" \]/);
  assert.match(job, /cursor_publish_args\+=\(--path "\$(?:proof|bot)_cursor_path"\)/);
  assert.doesNotMatch(
    job,
    /cursor_publish_args\+=\(--path results\/(?:proof-nudge|bot-proof)-cursors\)/,
  );
});

test(
  "read-only checkout mode restores file modes and leaves git metadata writable",
  {
    skip:
      process.platform === "win32" ? "exact POSIX mode bits are not portable on Windows" : false,
  },
  () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const target = join(root, "target");
      const nested = join(target, "src");
      const gitDir = join(target, ".git");
      mkdirSync(nested, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      const sourceFile = join(nested, "app.ts");
      const executableFile = join(target, "tool.sh");
      const gitConfig = join(gitDir, "config");
      writeFileSync(sourceFile, "export const value = 1;\n");
      writeFileSync(executableFile, "#!/bin/sh\n");
      writeFileSync(gitConfig, "[core]\n");
      chmodSync(target, 0o755);
      chmodSync(nested, 0o750);
      chmodSync(sourceFile, 0o640);
      chmodSync(executableFile, 0o755);
      chmodSync(gitDir, 0o700);
      chmodSync(gitConfig, 0o600);

      const snapshots = makeTreeReadOnlyForTest(target);
      assert.equal(statSync(target).mode & 0o777, 0o555);
      assert.equal(statSync(nested).mode & 0o777, 0o555);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o444);
      assert.equal(statSync(executableFile).mode & 0o777, 0o555);
      assert.equal(statSync(gitDir).mode & 0o777, 0o700);
      assert.equal(statSync(gitConfig).mode & 0o777, 0o600);

      restoreTreeModesForTest(snapshots);
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.equal(statSync(nested).mode & 0o777, 0o750);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o640);
      assert.equal(statSync(executableFile).mode & 0o777, 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("event review completion removes ClawSweeper eyes reaction", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: React to target item completion"),
    workflow.indexOf("\n\n  plan:"),
  );

  assert.match(block, /-f content="\+1"/);
  assert.match(block, /-f content="eyes"/);
  assert.match(block, /repos\/\$TARGET_REPO\/issues\/\$ITEM_NUMBER\/reactions\/\$reaction_id/);
  assert.match(block, /"openclaw-clawsweeper\[bot\]"/);
  assert.doesNotMatch(block, /issues\/comments\/\$ITEM_NUMBER\/reactions/);
});

test("event re-review status distinguishes lease deferral from interruptions", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Mark unsuccessful re-review"),
    workflow.indexOf("- name: Export exact review generation result"),
  );

  assert.match(block, /\[ "\$REVIEW_OUTCOME" = "cancelled" \]/);
  assert.match(block, /\[ "\$RESERVATION_STATUS" = "held" \]/);
  assert.match(block, /state="Waiting"/);
  assert.match(block, /Another exact-head review is already active/);
  assert.match(block, /state="Interrupted"/);
  assert.match(block, /The durable queue will retry it/);
  assert.doesNotMatch(block, /CAPACITY_OUTCOME/);
  assert.doesNotMatch(block, /state="Superseded"/);
});

test("trusted comment router owns command ledger capacity retries", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const routerWorkflow = readText(".github/workflows/repair-comment-router.yml");
  const eventStart = sweepWorkflow.indexOf("\n  event-review-apply:");
  const eventEnd = sweepWorkflow.indexOf("\n  target-fanout:", eventStart);
  const eventJob = sweepWorkflow.slice(eventStart, eventEnd);

  assert.doesNotMatch(eventJob, /publish-action-events/);
  assert.doesNotMatch(eventJob, /publish-action-event-paths/);
  assert.doesNotMatch(eventJob, /count-command-actions/);
  assert.doesNotMatch(eventJob, /--wait-for-capacity/);
  assert.match(routerWorkflow, /Commit comment router ledger/);
  assert.match(routerWorkflow, /Detect waiting repair dispatches/);
  assert.match(routerWorkflow, /--status waiting,active/);
  assert.match(routerWorkflow, /--wait-for-capacity/);
});

test("deferred exact verdict routers cannot replace each other's pending runs", () => {
  const workflow = readText(".github/workflows/repair-comment-router.yml");
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("\njobs:"));

  // GitHub keeps only one pending run per group even when cancel-in-progress is false.
  // Binding exact workflow dispatches to their item preserves both handoffs under load.
  assert.match(concurrency, /github\.event_name == 'workflow_dispatch'/);
  assert.match(concurrency, /github\.event\.inputs\.item_numbers != ''/);
  assert.match(
    concurrency,
    /format\('repair-comment-router-\{0\}-items-\{1\}'[\s\S]*github\.event\.inputs\.item_numbers/,
  );
  assert.match(concurrency, /cancel-in-progress: false/);
});

test("comment commands keep the router-to-sweep dispatch contract", () => {
  const routerWorkflow = readText(".github/workflows/repair-comment-router.yml");
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const routerSource = readText("src/repair/comment-router.ts");

  assert.match(routerWorkflow, /types:\s*\[clawsweeper_comment\]/);
  assert.match(routerWorkflow, /pnpm run repair:comment-router/);
  assert.match(
    routerWorkflow,
    /status_comment_id="\$\{\{ github\.event\.client_payload\.status_comment_id \|\| '' \}\}"/,
  );
  assert.match(routerWorkflow, /--status-comment-id "\$status_comment_id"/);
  assert.match(routerWorkflow, /dispatch_actor="\$\{\{ github\.actor \}\}"/);
  assert.match(routerWorkflow, /--dispatch-actor "\$dispatch_actor"/);
  assert.match(routerWorkflow, /--comment-event-auth "\$comment_event_auth"/);
  assert.match(routerWorkflow, /--comment-updated-at "\$comment_updated_at"/);
  assert.match(routerWorkflow, /--comment-body-sha256 "\$comment_body_sha256"/);
  assert.match(routerWorkflow, /\.short_circuited == true/);
  assert.match(routerSource, /event_type:\s*"clawsweeper_item"/);
  assert.match(routerSource, /adaptiveReviewBudgetForPullRequest\(command\.target\)/);
  assert.match(routerSource, /media_proof_timeout_ms: reviewBudget\.mediaProofTimeoutMs/);
  assert.match(routerSource, /dispatch_key:\s*dispatchKey/);
  assert.match(routerSource, /`item_numbers=\$\{dispatchKey\}`/);
  assert.match(routerSource, /event:\s*"workflow_dispatch"/);
  assert.match(sweepWorkflow, /types:\s*\[clawsweeper_item,\s*clawsweeper_target_sweep\]/);
  assert.match(sweepWorkflow, /Review event item \{0\}#\{1\} \[\{2\}\]/);
  assert.match(sweepWorkflow, /startsWith\(github\.event\.inputs\.item_numbers, 'router-'\)/);
  assert.doesNotMatch(sweepWorkflow, /types:\s*\[[^\]]*clawsweeper_comment/);
});

test("comment router prunes bare ack comments after updating shared automerge status", () => {
  const routerSource = readText("src/repair/comment-router.ts");
  const postComment = routerSource.slice(
    routerSource.indexOf("function postComment("),
    routerSource.indexOf("\nfunction findExistingCommandStatusComment"),
  );

  assert.match(postComment, /const existingStatus = findExistingCommandStatusComment\(command\);/);
  assert.match(postComment, /const precreated = findPrecreatedCommandStatusComment\(command\);/);
  assert.match(postComment, /const existing = existingStatus \?\? precreated;/);
  assert.match(
    postComment,
    /if \(existingStatus && precreatedId > 0 && precreatedId !== existingId\)/,
  );
  assert.match(postComment, /issues\/comments\/\$\{precreatedId\}/);
  assert.match(postComment, /"DELETE"/);
  assert.match(postComment, /pruned_ack_comment_id: String\(precreatedId\)/);
});

test("manual exact-item review dispatches reserve their live shard capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const runName = workflow.slice(workflow.indexOf("run-name:"), workflow.indexOf("\non:"));
  const exactCapacityBlock = workflow.slice(
    workflow.indexOf("active_sweep_exact_workers()"),
    workflow.indexOf("active_sweep_background_workers()"),
  );
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );

  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
  assert.doesNotMatch(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.hot_intake == 'true' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
  assert.match(
    runName,
    /format\('Review event items \{0\}#\{1\},\{2\} \[shards=\{3\}\]', github\.event\.inputs\.target_repo \|\| 'openclaw\/openclaw', github\.event\.inputs\.item_number, github\.event\.inputs\.item_numbers, \(github\.event\.inputs\.hot_intake == 'true' && '1' \|\| github\.event\.inputs\.shard_count \|\| '89'\)\)/,
  );
  assert.match(
    runName,
    /github\.event_name == 'workflow_dispatch' &&\s+github\.event\.inputs\.item_number != '' &&\s+github\.event\.inputs\.item_numbers == ''\) &&\s+format\('Review event item \{0\}#\{1\}', github\.event\.inputs\.target_repo \|\| 'openclaw\/openclaw', github\.event\.inputs\.item_number\)/,
  );
  assert.match(
    runName,
    /format\('Review event items \{0\}#\{1\} \[shards=\{2\}\]', github\.event\.inputs\.target_repo \|\| 'openclaw\/openclaw', github\.event\.inputs\.item_numbers, \(github\.event\.inputs\.hot_intake == 'true' && '1' \|\| github\.event\.inputs\.shard_count \|\| '89'\)\)/,
  );
  assert.ok(
    runName.indexOf("format('Review event item {0}#{1}'") <
      runName.lastIndexOf("'Review ClawSweeper items'"),
  );
  assert.match(exactCapacityBlock, /\.displayTitle \| startswith\("Review event item "\)/);
  assert.match(exactCapacityBlock, /\.displayTitle \| startswith\("Review event items "\)/);
  const singularFastPath = exactCapacityBlock.slice(
    exactCapacityBlock.indexOf('if [[ "$title" == Review\\ event\\ item\\ * ]]'),
    exactCapacityBlock.indexOf('if [ "$status" = "in_progress" ]'),
  );
  assert.match(singularFastPath, /active_shards=1/);
  assert.match(singularFastPath, /continue/);
  assert.doesNotMatch(singularFastPath, /gh run view/);
  assert.match(exactCapacityBlock, /gh run view "\$id".*--json jobs/);
  assert.match(exactCapacityBlock, /limit review_shards\.hard_cap/);
  assert.match(exactCapacityBlock, /reserved_shards="\$requested_shards"/);
  assert.match(exactCapacityBlock, /reserved_shards="\$item_count"/);
  assert.match(modeBlock, /active_run_count .* \+ \$\(active_sweep_exact_workers\)/);
});

test("sweep workflow publishes target-scoped state paths", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.match(workflow, /target_slug="\$TARGET_REPO"/);
  assert.match(workflow, /--path "records\/\$\{target_slug\}"/);
  assert.match(workflow, /--path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.doesNotMatch(workflow, /--path records\s*\\/);
  assert.doesNotMatch(workflow, /--path results\/sweep-status\s*\\/);
});

test("sweep workflow schedules cursor-based PR comment sync batches", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.match(workflow, /cron: "6,21,36,51 \* \* \* \*"/);
  assert.doesNotMatch(workflow, /apply_sync_open_pr_batch:/);
  assert.match(
    workflow,
    /sync_batch_size="\$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.apply_limit \|\| '25' \}\}"/,
  );
  assert.match(workflow, /\$item_numbers" = "__cursor__"/);
  assert.match(workflow, /comment-sync-batch/);
  assert.match(workflow, /write-comment-sync-cursor/);
  assert.match(workflow, /results\/comment-sync-cursors\/\$\{target_slug\}\.json/);
  assert.match(workflow, /APPLY_SYNC_OPEN_PR_BATCH/);
  assert.match(workflow, /github\.event\.schedule == '6,21,36,51 \* \* \* \*'/);
});

test("sweep target checkouts retry without cached references", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const checkoutBlocks =
    workflow.match(/- name: Check out target repository[\s\S]*?rev-parse --short HEAD/g) ?? [];

  assert.equal(checkoutBlocks.length, 2);
  for (const block of checkoutBlocks) {
    assert.match(block, /Cached target repository fetch failed; rebuilding cache/);
    assert.match(block, /Cached target checkout failed; retrying without cache reference/);
    assert.match(block, /rm -rf "\$checkout_dir" "\$cache_dir"/);
    assert.match(
      block,
      /git clone --filter=blob:none --branch "\$target_branch" --single-branch "\$url" "\$checkout_dir"/,
    );
  }
});

test("target sweep runs count as background review capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const capacityBlock = workflow.slice(
    workflow.indexOf("active_sweep_background_workers()"),
    workflow.indexOf(
      'active_critical_workers="$',
      workflow.indexOf("active_sweep_background_workers()"),
    ),
  );

  assert.match(workflow, /Review hot target repo/);
  assert.match(capacityBlock, /startswith\("Review target repo "\)/);
  assert.match(capacityBlock, /startswith\("Review hot target repo "\)/);
  assert.match(capacityBlock, /Review\\ hot\\ target\\ repo/);
});

test("target hot sweep dispatches honor shard cap payload", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("\n      - id: select"),
  );

  assert.match(modeBlock, /elif \[ "\$hot_intake" = "true" \]; then/);
  assert.match(
    modeBlock,
    /shard_count="\$\{\{ github\.event\.client_payload\.shard_count \|\| '' \}\}"/,
  );
  assert.match(modeBlock, /shard_count="\$hot_intake_shards"/);
});

test("review git info follows checked-out target branch", () => {
  const source = readText("src/clawsweeper.ts");

  assert.match(source, /function reviewTargetBranch/);
  assert.match(source, /rev-parse", "--abbrev-ref", "HEAD"/);
  assert.match(source, /refs\/remotes\/origin\/\$\{targetBranch\}/);
});

test("sweep workflow_dispatch input count stays under GitHub limit", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const inputNames = [...inputBlock.matchAll(/^      [A-Za-z0-9_]+:/gm)];

  assert.ok(inputNames.length <= 25, `workflow_dispatch has ${inputNames.length} inputs`);
});

test("sweep review continuations stay workflow-dispatch compatible", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const continueBlock = workflow.slice(
    workflow.indexOf("- name: Continue sweep"),
    workflow.indexOf("\n\n  recover-review-failures:"),
  );

  assert.match(continueBlock, /-f target_repo="\$\{\{ needs\.plan\.outputs\.target_repo \}\}"/);
  assert.match(continueBlock, /-f target_branch="\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/);
});

test("failed review recovery waits for durable exact-review queue acknowledgement", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publisher = readText("src/repair/publish-event-result.ts");
  const recoveryBlock = workflow.slice(
    workflow.indexOf("\n  recover-review-failures:"),
    workflow.indexOf("\n\n  retry-failed-reviews:"),
  );

  assert.match(recoveryBlock, /--arg target_repo "\$\{\{ needs\.plan\.outputs\.target_repo \}\}"/);
  assert.match(
    recoveryBlock,
    /--arg target_branch "\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/,
  );
  assert.match(recoveryBlock, /sourceAction: "failed_review_shard_recovery"/);
  assert.match(recoveryBlock, /delivery_id: \("router:" \+ \$dispatch_key\)/);
  assert.match(recoveryBlock, /\/internal\/exact-review\/enqueue/);
  assert.match(
    publisher,
    /options\.reviewOnly \? \["--sync-comments-only", "--suppress-automation-markers"\] : \[\]/,
  );
  assert.match(
    recoveryBlock,
    /\.ok == true and \(\.queued == true or \.deduped == true or \.shed == true or \.accepted == false\)/,
  );
  assert.match(recoveryBlock, /Recovery shed by exact-review queue backpressure/);
  assert.doesNotMatch(recoveryBlock, /workflow run sweep\.yml/);
  assert.doesNotMatch(recoveryBlock, /repos\/\$GITHUB_REPOSITORY\/dispatches/);
  assert.match(recoveryBlock, /for attempt in 1 2 3/);
});

test("target sweep dispatches preserve disabled ClawHub guard", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    runs-on:", workflow.indexOf("\n  plan:")),
  );

  assert.match(planHeader, /github\.event\.action == 'clawsweeper_target_sweep'/);
  assert.match(
    planHeader,
    /github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.target_repo == 'openclaw\/clawhub' && vars\.CLAWSWEEPER_ENABLE_CLAWHUB != '1'/,
  );
});

test("sweep planning-started status publish is bounded", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Publish planning-started status"),
    workflow.indexOf("- id: mode"),
  );

  assert.match(block, /timeout 20s pnpm run repair:publish-main/);
  assert.match(block, /Skipped slow planning-started dashboard publish/);
});

test("review capacity probes use REST actions run listing", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const sweepBlock = sweepWorkflow.slice(
    sweepWorkflow.indexOf("- id: mode"),
    sweepWorkflow.indexOf("- id: select"),
  );
  const commitWorkflow = readText(".github/workflows/commit-review.yml");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  for (const block of [sweepBlock, commitBlock]) {
    assert.match(block, /active_runs_json\(\)/);
    assert.match(block, /actions\/runs\?per_page=100/);
    assert.match(block, /--paginate/);
    assert.match(block, /status=\$\{run_status\}/);
    assert.match(block, /workflowPath:\.path/);
    assert.doesNotMatch(block, /workflowName:\.name/);
    assert.match(block, /displayTitle:\.display_title/);
    assert.match(block, /createdAt:\.created_at/);
    assert.match(block, /updatedAt:\.updated_at/);
    assert.match(block, /STALE_QUEUED_CUTOFF/);
    assert.doesNotMatch(block, /gh run list/);
    assert.match(block, /gh run view/);
  }
});

test("background review capacity reserves expanding matrices and caps broad manual input", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );
  const commitWorkflow = readText(".github/workflows/commit-review.yml");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  assert.match(modeBlock, /limit review_shards\.hot_intake_default/);
  assert.match(modeBlock, /limit review_shards\.normal_default/);
  assert.match(modeBlock, /STALE_QUEUED_CUTOFF/);
  assert.match(modeBlock, /updatedAt:\.updated_at/);
  assert.match(modeBlock, /workflowPath == "\.github\/workflows\/sweep\.yml"/);
  assert.match(modeBlock, /WORKFLOW_PATH="\$1"/);
  assert.doesNotMatch(modeBlock, /workflowName == "ClawSweeper"/);
  assert.doesNotMatch(modeBlock, /WORKFLOW_NAME="\$1"/);
  assert.match(modeBlock, /total_shards/);
  assert.match(modeBlock, /completed shard jobs are publishing and consume no/);
  assert.match(modeBlock, /\[ "\$active_shards" -lt 1 \] && \[ "\$total_shards" -lt 1 \]/);
  assert.match(modeBlock, /lane_shard_cap="\$normal_shards"/);
  assert.match(modeBlock, /lane_shard_cap="\$hot_intake_shards"/);
  assert.match(modeBlock, /Capping broad background review shards/);
  assert.match(commitBlock, /limit review_shards\.hot_intake_default/);
  assert.match(commitBlock, /limit review_shards\.normal_default/);
  assert.match(commitBlock, /STALE_QUEUED_CUTOFF/);
  assert.match(commitBlock, /updatedAt:\.updated_at/);
  assert.match(commitBlock, /workflowPath == "\.github\/workflows\/sweep\.yml"/);
  assert.match(commitBlock, /\.displayTitle \| startswith\("Review event items "\)/);
  assert.match(commitBlock, /WORKFLOW_PATH="\$1"/);
  assert.doesNotMatch(commitBlock, /workflowName == "ClawSweeper"/);
  assert.doesNotMatch(commitBlock, /WORKFLOW_NAME="\$1"/);
  assert.match(commitBlock, /total_shards/);
  assert.match(commitBlock, /limit review_shards\.hard_cap/);
  assert.match(commitBlock, /reserved_shards="\$requested_shards"/);
  assert.match(commitBlock, /reserved_shards="\$item_count"/);
});

test("background planners fetch exact-review queue pressure once and pass its level", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const sweepBlock = sweepWorkflow.slice(
    sweepWorkflow.indexOf("- id: mode"),
    sweepWorkflow.indexOf("- id: select"),
  );
  const commitWorkflow = readText(".github/workflows/commit-review.yml");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  for (const block of [sweepBlock, commitBlock]) {
    assert.match(
      block,
      /QUEUE_URL: \$\{\{ vars\.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL \|\| 'https:\/\/clawsweeper\.openclaw\.ai' \}\}/,
    );
    assert.equal(block.match(/queue-pressure --queue-url/g)?.length, 1);
    assert.match(block, /--pressure-level "\$pressure_level"/);
    assert.match(block, /queue pressure: \$pressure_level/);
    assert.match(block, /if ! pressure_json=/);
    assert.match(block, /unavailable=probe_failed/);
    assert.match(block, /CLAWSWEEPER_QUEUE_PRESSURE_SOFT_PENDING/);
    assert.match(block, /CLAWSWEEPER_QUEUE_PRESSURE_HARD_AGE_MS/);
  }
  assert.match(sweepBlock, /if \[ -z "\$exact_item" \]; then/);
  assert.match(sweepBlock, /hot_intake \$hot_intake_unpressured->\$hot_intake_shards/);
  assert.match(sweepBlock, /normal_review \$normal_unpressured->\$normal_shards/);
  assert.match(commitBlock, /commit_review \$unpressured_page_size->\$PAGE_SIZE/);
});

test("review backstops identify sweep runs by stable workflow path", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(workflow.indexOf("- name: Queue review backstops"));

  assert.match(block, /actions\/runs\?per_page=100/);
  assert.match(block, /workflowPath:\.path/);
  assert.match(block, /run\.workflowPath !== "\.github\/workflows\/sweep\.yml"/);
  assert.doesNotMatch(block, /gh run list/);
  assert.doesNotMatch(block, /run\.workflowName/);
});

test("target review queues coalesce background work without delaying exact planners", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const concurrencyBlock = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:"),
  );
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    outputs:", workflow.indexOf("\n  plan:")),
  );

  assert.match(concurrencyBlock, /&& 'clawsweeper-intake-v2'/);
  assert.match(concurrencyBlock, /\|\| 'clawsweeper-review'/);
  assert.doesNotMatch(
    concurrencyBlock,
    /format\('clawsweeper-(?:intake-v2|review)-\{0\}', github\.run_id\)/,
  );
  assert.match(
    concurrencyBlock,
    /github\.event\.client_payload\.queue_lease_id \|\| github\.event\.client_payload\.item_number/,
  );
  assert.match(concurrencyBlock, /format\('clawsweeper-comment-sync-\{0\}', github\.run_id\)/);
  assert.match(concurrencyBlock, /format\('clawsweeper-apply-\{0\}', github\.run_id\)/);
  assert.doesNotMatch(concurrencyBlock, /queue: max/);
  assert.match(planHeader, /group: \$\{\{ format\('clawsweeper-planner-\{0\}'/);
  assert.match(
    planHeader,
    /github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(planHeader, /github\.event\.inputs\.item_number == ''/);
  assert.match(planHeader, /github\.event\.inputs\.item_numbers == ''/);
  assert.match(planHeader, /\|\| github\.run_id/);
  assert.doesNotMatch(planHeader, /queue: max/);
  assert.match(planHeader, /cancel-in-progress: false/);
});

test("scheduled normal review uses one item per shard for lease coverage", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );

  assert.match(
    modeBlock,
    /if \[ "\$\{\{ github\.event_name \}\}" = "schedule" \]; then\s+batch_size="1"/,
  );
});

test("planned background reviews allow safe content-cache reuse without weakening exact reviews", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewJobStart = workflow.indexOf("\n  event-review-apply:");
  const planJobStart = workflow.indexOf("\n  plan:", eventReviewJobStart);
  const eventReviewJob = workflow.slice(eventReviewJobStart, planJobStart);
  const reviewJobStart = workflow.indexOf("\n  review:");
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);

  assert.match(
    reviewJob,
    /EXACT_ITEM: \$\{\{ github\.event\.client_payload\.item_number \|\| github\.event\.inputs\.item_number \|\| github\.event\.inputs\.item_numbers \|\| '' \}\}/,
  );
  assert.match(reviewJob, /if \[ -z "\$EXACT_ITEM" \]; then/);
  assert.match(reviewJob, /planned_automatic_review_arg=\(--planned-automatic-review\)/);
  assert.match(
    reviewJob,
    /--item-numbers "\$\{\{ matrix\.item_numbers \}\}" \\\n+\s+"\$\{planned_automatic_review_arg\[@\]\}"/,
  );
  assert.doesNotMatch(eventReviewJob, /--planned-automatic-review/);
});

test("sweep event reviews and target fanout avoid storm amplification", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const legacyIntakeBlock = workflow.slice(
    workflow.indexOf("legacy-event-queue-intake:"),
    workflow.indexOf("event-review-apply:"),
  );
  const eventBlock = workflow.slice(
    workflow.indexOf("event-review-apply:"),
    workflow.indexOf("target-fanout:"),
  );
  const fanoutBlock = workflow.slice(workflow.indexOf("target-fanout:"), workflow.indexOf("plan:"));

  assert.match(eventBlock, /concurrency:/);
  assert.match(
    eventBlock,
    /group: clawsweeper-event-review-\$\{\{ github\.event\.client_payload\.queue_claim\.item_key \|\| github\.event\.client_payload\.item_key \|\| github\.run_id \}\}/,
  );
  assert.match(eventBlock, /queue_lease_id != ''/);
  assert.match(eventBlock, /item_key: process\.env\.ITEM_KEY/);
  assert.match(eventBlock, /lease_revision: leaseRevision/);
  assert.match(eventBlock, /claim_generation: claimGeneration/);
  assert.match(eventBlock, /decision=\$\{JSON\.stringify\(decision\)\}/);
  assert.match(eventBlock, /cancel-in-progress: false/);
  assert.match(legacyIntakeBlock, /legacy-event-queue-intake:/);
  assert.match(legacyIntakeBlock, /\/internal\/exact-review\/enqueue/);
  assert.match(legacyIntakeBlock, /gh api "repos\/\$target_repo" --jq \.default_branch/);
  assert.match(legacyIntakeBlock, /targetBranch: process\.env\.TARGET_BRANCH/);
  assert.doesNotMatch(legacyIntakeBlock, /targetBranch: payload\.target_branch \|\| "main"/);
  assert.match(legacyIntakeBlock, /commandStatusMarker: payload\.command_status_marker/);
  assert.match(legacyIntakeBlock, /statusCommentId: payload\.status_comment_id/);
  assert.match(legacyIntakeBlock, /additionalPrompt: payload\.additional_prompt/);
  assert.match(
    fanoutBlock,
    /FANOUT_LIMIT: \$\{\{ github\.event\.schedule == '41 \* \* \* \*' && '6' \|\| \(github\.event\.schedule == '37 \*\/6 \* \* \*' && '12' \|\| '10'\) \}\}/,
  );
});

test("setup-state defaults to an auth-safe shallow checkout", () => {
  const action = readText(".github/actions/setup-state/action.yml");
  assert.doesNotMatch(action, /CLAWSWEEPER_STATE_REPOSITORY=/);
  assert.doesNotMatch(action, /CLAWSWEEPER_STATE_TOKEN/);
  const filterBlock = action.slice(action.indexOf("filter:"), action.indexOf("fetch-depth:"));
  const fetchDepthBlock = action.slice(action.indexOf("fetch-depth:"), action.indexOf("runs:"));

  assert.match(filterBlock, /default: ""/);
  assert.doesNotMatch(filterBlock, /default: blob:none/);
  assert.match(action, /filter: \$\{\{ inputs\.filter \}\}/);
  assert.match(fetchDepthBlock, /default: "1"/);
  assert.doesNotMatch(fetchDepthBlock, /default: "0"/);
  assert.match(action, /fetch-depth: \$\{\{ inputs\.fetch-depth \}\}/);
  assert.match(action, /sparse-checkout: \$\{\{ inputs\.sparse-checkout \}\}/);
  assert.doesNotMatch(action, /state-repository:/);
  assert.doesNotMatch(action, /state-ref:/);
  assert.match(action, /repository: openclaw\/clawsweeper-state/);
  assert.match(action, /ref: state/);
});

test("sweep exact event reviews consume only the immutable claimed decision", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const resolveBlock = workflow.slice(
    workflow.indexOf("- name: Resolve event payload"),
    workflow.indexOf("- name: Create target read token"),
  );
  const reviewBlock = workflow.slice(
    workflow.indexOf("- name: Review exact event item"),
    workflow.indexOf("- name: Create state token"),
  );

  assert.match(
    resolveBlock,
    /CLAIM_DECISION: \$\{\{ steps\.claim-exact-review-queue\.outputs\.decision \}\}/,
  );
  assert.match(
    resolveBlock,
    /CONFIGURED_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_CODEX_TIMEOUT_MS \|\| '1200000' \}\}/,
  );
  assert.match(resolveBlock, /const decision = JSON\.parse\(process\.env\.CLAIM_DECISION/);
  assert.match(resolveBlock, /const maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(resolveBlock, /Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)/);
  assert.match(resolveBlock, /Math\.min\(1_800_000, Math\.max\(600_000, adaptiveValue\)\)/);
  assert.match(resolveBlock, /Math\.min\(480_000, mediaValue\)/);
  assert.match(
    resolveBlock,
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs,\s*Math\.max\(configuredTimeout, adaptiveTimeout\)/,
  );
  assert.match(resolveBlock, /media_proof_timeout_ms: mediaTimeout/);
  assert.doesNotMatch(resolveBlock, /github\.event\.client_payload/);
  assert.match(
    reviewBlock,
    /codex_timeout_ms="\$\{\{ steps\.target\.outputs\.codex_timeout_ms \}\}"/,
  );
  assert.match(reviewBlock, /media_preprocessing_reserve_seconds=480/);
  assert.match(
    reviewBlock,
    /review_timeout_seconds=\$\(\(codex_timeout_seconds \+ media_preprocessing_reserve_seconds \+ 180\)\)/,
  );
  assert.match(reviewBlock, /detected media allowance \$\{media_proof_timeout_seconds\}s/);
  assert.doesNotMatch(reviewBlock, /review_timeout_seconds=.*media_proof_timeout_seconds/);
  assert.match(reviewBlock, /timeout --kill-after=30s "\$\{review_timeout_seconds\}s"/);
  assert.match(reviewBlock, /echo "exit_code=\$review_exit_code" >> "\$GITHUB_OUTPUT"/);
  assert.match(reviewBlock, /--codex-timeout-ms "\$codex_timeout_ms"/);
  assert.doesNotMatch(reviewBlock, /timeout --kill-after=30s 12m/);
  assert.doesNotMatch(reviewBlock, /--codex-timeout-ms 600000/);
});

test("review finalizers recover start-only ledger attempts after hard timeout", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  for (const finalizerName of [
    "Finalize exact event action ledger",
    "Finalize review action ledger",
  ]) {
    const start = workflow.indexOf(`- name: ${finalizerName}`);
    assert.ok(start >= 0, `missing ${finalizerName}`);
    const block = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));
    assert.match(block, /REVIEW_EXIT_CODE:/);
    assert.match(block, /"124"/);
    assert.match(block, /"137"/);
    assert.match(block, /--interrupt-open-attempts --reason timeout/);
    assert.match(block, /--interrupt-open-attempts --reason cancelled/);
    assert.match(block, /--interrupt-open-attempts --reason workflow_failed/);
    assert.ok(
      block.indexOf("--reason cancelled") < block.indexOf("--reason timeout"),
      "explicit cancellation must outrank timeout-like signal exits",
    );
  }
});

test("every action-ledger publication authenticates the expected producer job", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const commands = workflow.match(
    /pnpm run --silent publish-action-events -- \\\n(?:\s+.*\\\n)*\s+--expected-producer-job [^\n]+/g,
  );
  assert.ok(commands);
  assert.equal(commands.length, 7);
  assert.ok(commands.every((command) => command.includes("--expected-producer-job")));
  assert.match(workflow, /--expected-producer-job review/);
  assert.match(workflow, /--expected-producer-job apply-proof/);
});

test("sweep exact event reviews cap the configured fallback within the lease and job budgets", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const resolveBlock = workflow.slice(
    workflow.indexOf("- name: Resolve event payload"),
    workflow.indexOf("- name: Create target read token"),
  );

  assert.match(
    resolveBlock,
    /CONFIGURED_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_CODEX_TIMEOUT_MS \|\| '1200000' \}\}/,
  );
  assert.match(resolveBlock, /const maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(
    resolveBlock,
    /Number\.isInteger\(configuredValue\) && configuredValue > 0\s*\? Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)\s*: 1_200_000/,
  );
  assert.match(
    resolveBlock,
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs,\s*Math\.max\(configuredTimeout, adaptiveTimeout\)/,
  );
});

test("github activity workflow scopes cancellation to matching item activity", () => {
  const workflow = readText(".github/workflows/github-activity.yml");
  const concurrencyBlock = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:"),
  );

  assert.match(concurrencyBlock, /group: >-/);
  assert.match(
    concurrencyBlock,
    /github-activity-\$\{\{ github\.event\.client_payload\.activity\.repo/,
  );
  assert.match(concurrencyBlock, /github\.event\.client_payload\.target_repo/);
  assert.match(concurrencyBlock, /github\.event\.repository\.full_name/);
  assert.match(concurrencyBlock, /github\.event_name == 'workflow_run'/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.event_name/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.type/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.action/);
  assert.match(concurrencyBlock, /github\.event\.action/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.comment_id/);
  assert.match(concurrencyBlock, /github\.event\.comment\.id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.review\.id/);
  assert.match(concurrencyBlock, /github\.event\.review\.id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.pull_request\.number/);
  assert.match(concurrencyBlock, /github\.event\.pull_request\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.issue\.number/);
  assert.match(concurrencyBlock, /github\.event\.issue\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.subject\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.label\.name/);
  assert.match(concurrencyBlock, /github\.event\.label\.name/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.assignee\.login/);
  assert.match(concurrencyBlock, /github\.event\.assignee\.login/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.delivery_id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.idempotency_key/);
  assert.match(workflow, /Check core API budget/);
  assert.match(workflow, /CLAWSWEEPER_MIN_CORE_REMAINING/);
  assert.match(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /Dispatch spam comment intake candidates/);
  assert.match(workflow, /Dispatch spam scan candidate/);
  assert.match(workflow, /repair:spam-comment-intake -- --write-report/);
  assert.doesNotMatch(workflow, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/dispatches"/);
  assert.match(concurrencyBlock, /cancel-in-progress: true/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /runs-on: blacksmith-/);
  assert.doesNotMatch(
    concurrencyBlock,
    /group: github-activity-\$\{\{ github\.event_name \}\}-\$\{\{ github\.run_id \}\}/,
  );
  assert.doesNotMatch(concurrencyBlock, /workflow-run' \|\| 'activity'/);
});
