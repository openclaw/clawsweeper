import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readText } from "../helpers.ts";

test("repair workflow and executor share coherent production timeout defaults", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const workflow = readText(
    path.join(process.cwd(), ".github/workflows/repair-cluster-worker.yml"),
  );

  assert.match(source, /repairTimeoutBudgetFromEnv\(\s*process\.env,?\s*\)/);
  assert.match(source, /currentCodexTimeoutMs\(true\)/);
  assert.match(workflow, /timeout-minutes: 75/);
  assert.match(
    workflow,
    /CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS \|\| '1800000' \}\}/,
  );
  assert.match(
    workflow,
    /CLAWSWEEPER_FIX_STEP_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_FIX_STEP_TIMEOUT_MS \|\| '4200000' \}\}/,
  );
  assert.match(
    workflow,
    /CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS: \$\{\{ vars\.CLAWSWEEPER_FIX_TIMEOUT_RESERVE_MS \|\| '1800000' \}\}/,
  );
  assert.match(workflow, /name: Execute credited fix artifact[\s\S]*timeout-minutes: 70/);
});

test("no-op automerge repair updates outcome and re-enters router before exit", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);
  const noPlannedBranch = source.match(
    /if \(plannedFixActions\.length === 0\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;

  assert.ok(noPlannedBranch, "expected no planned fix actions branch");
  assert.match(noPlannedBranch, /report\.reason = "no planned fix actions";/);

  const writeReportIndex = noPlannedBranch.indexOf("writeReport(report, resultPath);");
  const exitIndex = noPlannedBranch.indexOf("process.exit(0);");

  assert.notEqual(writeReportIndex, -1);
  assert.notEqual(exitIndex, -1);
  assert.ok(
    writeReportIndex < exitIndex,
    "no-op repair must durably write the terminal report before exiting",
  );
});

test("repair source branch writability preflight runs before expensive repair preflights", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);

  const branchPreflightIndex = source.indexOf(
    "const sourceBranchPreflight = preflightRepairSourceBranchWrite(fixArtifact);",
  );
  const checkoutIndex = source.indexOf("ensureTargetCheckout(result.repo, targetDir);");
  const validationIndex = source.indexOf("preflightTargetValidationPlan(");
  const codexPreflightIndex = source.indexOf("const writePreflight = runCodexWritePreflight();");

  assert.notEqual(branchPreflightIndex, -1);
  assert.notEqual(checkoutIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.notEqual(codexPreflightIndex, -1);
  assert.ok(
    branchPreflightIndex < checkoutIndex &&
      checkoutIndex < validationIndex &&
      validationIndex < codexPreflightIndex,
    "live source-branch writability must be resolved before checkout, validation planning, and Codex write preflight",
  );
});

test("repair branch pushes settle and re-check the exact source head", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);
  const pushStart = source.indexOf("function pushRepairBranchAndUpdateStatus(");
  const pushEnd = source.indexOf("function repairPushSettleSeconds()", pushStart);
  assert.notEqual(pushStart, -1);
  assert.notEqual(pushEnd, -1);
  const push = source.slice(pushStart, pushEnd);

  assert.match(source, /DEFAULT_REPAIR_PUSH_SETTLE_SECONDS = 90/);
  assert.match(source, /CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS/);
  assert.match(push, /sleepMs\(settleSeconds \* 1000\)/);
  assert.ok(
    push.indexOf("sleepMs(settleSeconds * 1000)") <
      push.indexOf("const livePull = fetchPullRequest"),
    "the live head must be fetched after the settle window",
  );
  assert.ok(
    push.indexOf("repairPushSettleBlock") < push.indexOf("runGitNetwork(pushArgs, targetDir)"),
    "the exact-head guard must run before the branch push",
  );

  const settleStart = source.indexOf("function repairPushSettleBlock(");
  const settle = source.slice(settleStart, source.indexOf("\n}\n", settleStart) + 2);
  assert.match(settle, /initialPull\?\.head\?\.sha/);
  assert.match(settle, /livePull\?\.head\?\.sha/);
  assert.match(settle, /liveState !== "open"/);
  assert.match(settle, /requeue_required: true/);
});

test("merged source replacement skip runs before publishing replacement PRs", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);

  const preparedStart = source.indexOf("function openReplacementPrFromPreparedRepairCheckout(");
  const preparedEnd = source.indexOf("function executeReplacementBranch(", preparedStart);
  assert.notEqual(preparedStart, -1);
  assert.notEqual(preparedEnd, -1);
  const preparedReplacement = source.slice(preparedStart, preparedEnd);
  assert.match(
    preparedReplacement,
    /mergedReplacementSourcePr\(\{ fixArtifact, sourcePr, targetDir \}\)/,
  );
  assert.match(preparedReplacement, /skipMergedSourceReplacementWithoutDiff\(\{/);

  const preparedSkipIndex = preparedReplacement.indexOf("skipMergedSourceReplacementWithoutDiff({");
  const preparedPushIndex = preparedReplacement.indexOf(
    "pushRecoverableBranch({ targetDir, branch });",
  );
  const preparedCreateIndex = preparedReplacement.indexOf('"pr",\n        "create"');
  assert.notEqual(preparedSkipIndex, -1);
  assert.notEqual(preparedPushIndex, -1);
  assert.notEqual(preparedCreateIndex, -1);
  assert.ok(
    preparedSkipIndex < preparedPushIndex && preparedPushIndex < preparedCreateIndex,
    "merged-source no-diff replacement skip must run before branch push and PR creation",
  );

  const helperStart = source.indexOf("function skipMergedSourceReplacementWithoutDiff(");
  const helperEnd = source.indexOf("function labelReplacementPullRequest(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(!mergedSource\) return null;/);
  assert.match(helper, /if \(branchHasBaseDiff\(\{ targetDir, baseBranch \}\)\) return null;/);
  assert.match(
    helper,
    /reason: "source PR already merged and replacement branch has no changes versus base"/,
  );
});

test("terminal Codex failures do not request repair requeue", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);
  const helperStart = source.indexOf("function isRetryableCodexFailure(");
  const helperEnd = source.indexOf("function isBlockedFixError(", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  const terminalGuardIndex = helper.indexOf(
    "if (messages.some((value) => isTerminalCodexErrorMessage(value))) return false;",
  );
  const broadFallbackIndex = helper.indexOf("/Codex .*(?:timed out|failed|exited)");

  assert.notEqual(terminalGuardIndex, -1);
  assert.notEqual(broadFallbackIndex, -1);
  assert.ok(
    terminalGuardIndex < broadFallbackIndex,
    "terminal model-access failures must be rejected before the broad Codex failure fallback",
  );
});

test("repair Codex heartbeat wrapper uses bounded process capture", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);
  const helperStart = source.indexOf("function spawnCodexSyncWithHeartbeat(");
  const helperEnd = source.indexOf("function startCodexHeartbeat(", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /return runCodexProcess\(\{/);
  assert.match(helper, /\{ stdoutPath: options\.stdoutPath \}/);
  assert.match(helper, /\{ stderrPath: options\.stderrPath \}/);
  assert.doesNotMatch(helper, /spawnSync\("codex"/);
  assert.doesNotMatch(source, /CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*codexResult\.stdout/);
});

test("issue implementation rechecks opt-out labels immediately before branch pushes", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const pushStart = source.indexOf("function pushRecoverableBranch(");
  const pushEnd = source.indexOf("function fetchRemoteRecoverableBranch(", pushStart);
  const helperStart = source.indexOf("function assertIssueImplementationNotPaused(");
  const helperEnd = source.indexOf("function fetchRemoteRecoverableBranch(", helperStart);

  assert.notEqual(pushStart, -1);
  assert.notEqual(pushEnd, -1);
  assert.match(source.slice(pushStart, pushEnd), /assertIssueImplementationNotPaused\(\)/);
  assert.notEqual(helperStart, -1);
  assert.match(source.slice(helperStart, helperEnd), /repairPauseLabel\(issue\.labels\)/);
  assert.match(source.slice(helperStart, helperEnd), /refusing to push or open a PR/);
});

test("repair contract gates the final cumulative tree, not individual checkpoints", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  assert.equal(
    [...source.matchAll(/commitCheckpointIfNeeded\(/g)].length,
    5,
    "four checkpoint call sites plus the ordinary commit helper should remain",
  );
  assert.doesNotMatch(source, /commitRepairCheckpointIfNeeded|checkpointBaseHead/);
  assert.match(source, /enforceFinalRepairContract\(\{ fixArtifact, targetDir, baseBranch \}\)/);
  assert.equal(
    [...source.matchAll(/pushIntermediateCheckpoint\?\.\(\)/g)].length,
    4,
    "contract jobs must defer all four recovery pushes until final validation",
  );
  assert.match(source, /if \(hasRepairContract \|\| historyCompaction\?\.status === "compacted"\)/);

  const compact = source.indexOf("const historyCompaction =");
  const enforce = source.indexOf("enforceFinalRepairContract(", compact);
  const commit = source.indexOf('const commit = run("git", ["rev-parse", "HEAD"]', enforce);
  const proof = source.indexOf("ensureFinalStagedProof(", commit);
  const publish = source.indexOf("if (hasRepairContract", proof);
  assert.ok(compact < enforce && enforce < commit && commit < proof && proof < publish);
});

test("push-denied replacement fallback re-proves the compacted head before publication", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const start = source.indexOf("function openReplacementPrFromPreparedRepairCheckout(");
  const end = source.indexOf("function liveRepairPauseBlock(", start);
  const fallback = source.slice(start, end);

  assert.match(fallback, /sourceHead/);
  const compact = fallback.indexOf("compactReplacementHistory(");
  const proof = fallback.indexOf("ensureFinalStagedProof(", compact);
  const preflight = fallback.indexOf("bindMergePreflightToStagedProof(", proof);
  const push = fallback.indexOf("pushRecoverableBranch(", preflight);
  assert.ok(compact < proof && proof < preflight && preflight < push);
});

test("final repair contract compares the repaired tree with the latest base", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const start = source.indexOf("function enforceFinalRepairContract(");
  const end = source.indexOf("function pushRecoverableBranch(", start);
  const helper = source.slice(start, end);
  assert.match(source, /\.\/repair-contract\.js/);
  assert.match(helper, /const baseRef = `origin\/\$\{baseBranch\}`/);
  assert.match(helper, /"diff", "--name-only", "-z", `\$\{baseRef\}\.\.HEAD`/);
  assert.match(helper, /enforceRepairContract\(\{ fixArtifact, changedFiles \}\)/);
  assert.doesNotMatch(helper, /--porcelain=v1|phase|checkpoint/);
});

test("contributor repair review loop stays on one pinned target base", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const validation = readText(path.join(process.cwd(), "src/repair/target-validation.ts"));
  const promptBuilder = readText(path.join(process.cwd(), "src/repair/fix-prompt-builder.ts"));

  assert.match(
    source,
    /const targetBaseSha = pinRepairBase\(\(\) =>[\s\S]*?run\("git", \["rev-parse", `origin\/\$\{baseBranch\}`\]/,
  );
  assert.match(source, /validateAndReviewLoop\(\{[\s\S]*targetBaseSha/);
  assert.match(source, /pinnedBaseRef: targetBaseSha/);
  assert.match(
    source,
    /runTargetValidationProof\([\s\S]*?validationPlan\.options,[\s\S]*?baseBranch/,
  );
  assert.match(source, /pinned target base \$\{targetBaseSha\}/);
  assert.match(validation, /pinnedBaseRef\?: string/);
  assert.match(validation, /const baseRef = validationBaseRef\(cwd, baseBranch, options\)/);
  assert.match(validation, /\["git", "diff", "--check", `\$\{baseRef\}\.\.\.HEAD`\]/);
  assert.match(source, /classifyExternalBaseValidationFailure\(\{/);
  assert.match(source, /const repairDeltaBaseHead = sourceHead \?\? targetBaseSha/);
  assert.match(
    source,
    /const sourceHead = currentHead\(targetDir\);[\s\S]*replacement repair delta base[\s\S]*prepareTargetToolchain/,
  );
  assert.match(validation, /if \(!options\.pinnedBaseRef\) \{[\s\S]*ensureMergeBaseAvailable/);
  assert.match(promptBuilder, /Pinned target base SHA: \$\{targetBaseSha\}/);
});

test("final synchronized tree is reviewed and reports persist before publication", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));

  assert.match(source, /reviewAfterFinalBaseSync\(\{/);
  assert.match(source, /finalBaseSyncRequiresReview\(\{/);
  assert.match(source, /return \{ status: "already-current", base_sha: baseSha \}/);
  assert.match(source, /validateAndReviewSynchronizedTree\(\{/);
  assert.match(source, /repairDeltaPaths: finalSyncRepairDeltaPaths/);
  assert.match(source, /attempt: "final-sync"/);
  assert.match(source, /finalizeExecutionReport\(\{/);
});

test("proof runtime budget exhaustion is terminal for validation-fix", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const classifierStart = source.indexOf("function isFixableValidationError(");
  const classifierEnd = source.indexOf("\nfunction ", classifierStart + 1);
  const classifier = source.slice(classifierStart, classifierEnd);

  assert.match(classifier, /staged proof runtime budget exhausted/);
  assert.match(classifier, /validation command runtime budget exhausted/);
  assert.ok(
    classifier.indexOf("runtime budget exhausted") <
      classifier.indexOf("return /validation command failed"),
  );
});

test("repair workflow binds one run through no-credential proof and token-only mutation", () => {
  const workflow = readText(
    path.join(process.cwd(), ".github/workflows/repair-cluster-worker.yml"),
  );
  const authorizeIndex = workflow.indexOf("\n  authorize:");
  const executeIndex = workflow.indexOf("- name: Execute credited fix artifact");
  const handoffIndex = workflow.indexOf("- name: Upload sealed execution handoff");
  const validateIndex = workflow.indexOf("\n  validate:");
  const reportIndex = workflow.indexOf("\n  report:");
  const mutateIndex = workflow.indexOf("\n  mutate:");
  const receiptIndex = workflow.indexOf(
    "- name: Verify immutable mutation authorization",
    mutateIndex,
  );
  const mutationTokenIndex = workflow.indexOf(
    "- name: Create exact-repository mutation token",
    receiptIndex,
  );
  const verifierTokenIndex = workflow.indexOf(
    "- name: Create exact-repository ruleset verifier token",
    mutationTokenIndex,
  );

  assert.ok(
    authorizeIndex < executeIndex &&
      executeIndex < handoffIndex &&
      handoffIndex < validateIndex &&
      validateIndex < reportIndex &&
      reportIndex < mutateIndex &&
      mutateIndex < receiptIndex &&
      receiptIndex < mutationTokenIndex &&
      mutationTokenIndex < verifierTokenIndex,
  );
  const authorize = workflow.slice(
    authorizeIndex,
    workflow.indexOf("\n  execute:", authorizeIndex),
  );
  const execute = workflow.slice(workflow.indexOf("\n  execute:"), validateIndex);
  const validate = workflow.slice(validateIndex, reportIndex);
  const report = workflow.slice(reportIndex, mutateIndex);
  const mutate = workflow.slice(mutateIndex);

  assert.match(
    workflow.slice(workflow.indexOf("\n  cluster:"), authorizeIndex),
    /Upload worker transfer artifacts[\s\S]*if-no-files-found: error[\s\S]*retention-days: 90/,
  );
  assert.match(authorize, /repair:execution-handoff -- authorize/);
  assert.match(authorize, /repair:execution-handoff -- restore-authorization/);
  assert.ok(
    authorize.indexOf("Restore checkpoint authorization before live source intake") <
      authorize.indexOf("Authorize exact job and run"),
  );
  assert.match(
    authorize,
    /authorization_sha256: \$\{\{ steps\.restore_authorization\.outputs\.authorization_sha256 \|\| steps\.authorize\.outputs\.authorization_sha256 \}\}/,
  );
  assert.match(
    authorize,
    /Restore checkpoint authorization before live source intake[\s\S]*--source-root \.clawsweeper-repair\/recovery-authorized[\s\S]*--publication-root \.clawsweeper-repair\/recovery-execution[\s\S]*--publication-receipt \.clawsweeper-repair\/recovery-publication\/receipt\.json[\s\S]*--source-job-path "\$\{\{ inputs\.job \}\}"/,
  );
  assert.equal(
    [
      ...authorize.matchAll(
        /--expected-producer-attempt "\$\{\{ steps\.authorization_publication_artifact\.outputs\.producer_attempt \}\}"/g,
      ),
    ].length,
    4,
  );
  assert.match(
    authorize,
    /Resolve prior checkpoint worker artifact[\s\S]*--prefix clawsweeper-repair-worker[\s\S]*Download prior checkpoint worker artifact[\s\S]*artifact-ids: \$\{\{ steps\.prior_worker_artifact\.outputs\.artifact_id \}\}/,
  );
  assert.match(
    authorize,
    /Resolve prior checkpoint validation receipt[\s\S]*--prefix clawsweeper-repair-validation[\s\S]*Restore checkpoint authorization before live source intake[\s\S]*--validation-receipt \.clawsweeper-repair\/recovery-validation\/receipt\.json/,
  );
  assert.match(
    authorize,
    /artifact_id: \$\{\{ steps\.prior_authorized_artifact\.outputs\.artifact_id \|\| steps\.upload\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    authorize,
    /worker_artifact_id: \$\{\{ steps\.prior_worker_artifact\.outputs\.artifact_id \|\| needs\.cluster\.outputs\.worker_artifact_id \}\}/,
  );
  assert.match(authorize, /persist-credentials: "false"/);
  assert.match(execute, /repair:execution-handoff -- verify/);
  assert.match(
    execute,
    /Reuse exact checkpointed execution handoff[\s\S]*repair:execution-handoff -- verify-execution/,
  );
  assert.match(
    execute,
    /needs\.authorize\.outputs\.checkpoint_recovered != '1'[\s\S]*Execute credited fix artifact/,
  );
  assert.match(execute, /repair:execution-handoff -- seal/);
  assert.match(execute, /GH_TOKEN: ""/);
  assert.match(execute, /GITHUB_TOKEN: ""/);
  assert.match(execute, /--prepare-publication/);
  assert.match(execute, /--execution-intent/);
  assert.match(execute, /needs\.authorize\.outputs\.result_path/);
  assert.doesNotMatch(
    execute,
    /create-github-app-token|create-state-token|setup-state|--latest|permission-(?:contents|issues|pull-requests): write/,
  );
  assert.match(validate, /GH_TOKEN: ""/);
  assert.match(validate, /GITHUB_TOKEN: ""/);
  assert.match(validate, /repair:execution-handoff -- validate/);
  assert.match(
    validate,
    /Reuse exact checkpointed validation receipt[\s\S]*repair:execution-handoff -- verify-receipt/,
  );
  assert.match(validate, /Upload validation receipt[\s\S]*retention-days: 90/);
  assert.doesNotMatch(validate, /create-github-app-token|setup-codex|OPENAI_API_KEY/);
  assert.match(report, /count-requeue-required/);
  assert.match(report, /--dashboard-only/);
  assert.match(report, /repositories: clawsweeper/);
  assert.doesNotMatch(
    report,
    /needs\.authorize\.outputs\.target_name|permission-(?:issues|pull-requests): write|--publish-report-only/,
  );
  assert.match(mutate, /repair:execution-handoff -- verify-receipt/);
  assert.match(mutate, /repair:execution-handoff -- publish/);
  assert.match(
    mutate,
    /repair:execution-handoff -- publish[\s\S]*--mutation-actor "\$\{\{ steps\.target_post_flight_token\.outputs\.app-slug \}\}\[bot\]"/,
  );
  assert.match(mutate, /repair:execution-handoff -- verify-publication/);
  assert.match(mutate, /repair:execution-handoff -- checkpoint-source-closes/);
  assert.match(mutate, /repair:execution-handoff -- close-sources/);
  const publishIndex = mutate.indexOf("- name: Publish exact independently validated repair");
  const verifyPublicationIndex = mutate.indexOf("- name: Verify publication receipt");
  const prepareCheckpointIndex = mutate.indexOf("- name: Prepare durable source-close checkpoint");
  const durableCheckpointIndex = mutate.indexOf("- name: Upload durable pre-close checkpoint");
  const closeSourcesIndex = mutate.indexOf(
    "- name: Close superseded sources from publication checkpoint",
  );
  const completionCheckpointIndex = mutate.indexOf(
    "- name: Upload completed publication checkpoint",
  );
  const postFlightIndex = mutate.indexOf("- name: Post-flight finalize fix PRs");
  assert.ok(
    publishIndex < verifyPublicationIndex &&
      verifyPublicationIndex < prepareCheckpointIndex &&
      prepareCheckpointIndex < durableCheckpointIndex &&
      durableCheckpointIndex < closeSourcesIndex &&
      closeSourcesIndex < completionCheckpointIndex &&
      completionCheckpointIndex < postFlightIndex &&
      closeSourcesIndex < postFlightIndex,
  );
  assert.match(
    mutate,
    /Upload durable pre-close checkpoint[\s\S]*name: clawsweeper-repair-publication-close-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*if-no-files-found: error[\s\S]*Close superseded sources from publication checkpoint/,
  );
  assert.match(
    mutate,
    /Upload durable pre-close checkpoint[\s\S]*retention-days: 90[\s\S]*Upload completed publication checkpoint[\s\S]*retention-days: 90/,
  );
  assert.match(
    mutate,
    /checkpoint-source-closes[\s\S]*id: upload_source_close_checkpoint[\s\S]*close-sources[\s\S]*steps\.checkpoint_sources\.outputs\.publication_receipt_sha256/,
  );
  assert.equal(
    [
      ...mutate.matchAll(
        /--close-actor "\$\{\{ steps\.target_post_flight_token\.outputs\.app-slug \}\}\[bot\]"/g,
      ),
    ].length,
    2,
  );
  assert.match(
    mutate,
    /id: close_sources[\s\S]*publication_receipt_sha256[\s\S]*steps\.close_sources\.outputs\.publication_receipt_sha256/,
  );
  assert.match(mutate, /needs\.execute\.result == 'success'/);
  assert.match(mutate, /needs\.execute\.outputs\.execute_fix_outcome == 'success'/);
  assert.match(mutate, /needs\.execute\.outputs\.mutation_ready == 'true'/);
  assert.match(mutate, /needs\.validate\.result == 'success'/);
  assert.match(
    mutate,
    /Write final publication provenance[\s\S]*source_close_mutations[\s\S]*preserve_human_reopened_source_pull_request/,
  );
  assert.match(
    mutate,
    /artifacts: \{[\s\S]*worker: artifact\([\s\S]*authorization: artifact\([\s\S]*execution: artifact\([\s\S]*validation: artifact\([\s\S]*pre_close: artifact\([\s\S]*publication: artifact\([\s\S]*final_worker: artifact\(/,
  );
  assert.match(
    mutate,
    /Upload final worker artifacts[\s\S]*\.clawsweeper-repair\/publication\/receipt\.json[\s\S]*\.clawsweeper-repair\/provenance\/publication\.json[\s\S]*retention-days: 90/,
  );
  assert.match(
    mutate,
    /Record final worker artifact provenance[\s\S]*FINAL_WORKER_ARTIFACT_ID[\s\S]*publication_provenance_sha256[\s\S]*Upload final worker provenance[\s\S]*retention-days: 90/,
  );
  assert.match(
    mutate,
    /WORKER_ARTIFACT_ID: \$\{\{ needs\.authorize\.outputs\.worker_artifact_id \}\}[\s\S]*WORKER_ARTIFACT_DIGEST: \$\{\{ needs\.authorize\.outputs\.worker_artifact_digest \}\}[\s\S]*WORKER_PRODUCER_ATTEMPT: \$\{\{ needs\.authorize\.outputs\.worker_producer_attempt \}\}[\s\S]*AUTHORIZATION_PRODUCER_ATTEMPT: \$\{\{ needs\.authorize\.outputs\.producer_attempt \}\}[\s\S]*EXECUTION_PRODUCER_ATTEMPT: \$\{\{ needs\.execute\.outputs\.producer_attempt \}\}[\s\S]*VALIDATION_PRODUCER_ATTEMPT: \$\{\{ needs\.validate\.outputs\.producer_attempt \}\}/,
  );
  assert.doesNotMatch(mutate, /setup-codex|--latest|create-state-token|setup-state/);
  assert.match(mutate, /npm_config_ignore_scripts: "true"/);
  assert.doesNotMatch(mutate, /repair:apply-result|repair:tag-clawsweeper/);
  assert.match(
    readText(path.join(process.cwd(), "src/repair/post-flight.ts")),
    /finalized\.status === "executed" && !publicationReceipt/,
  );
});
