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
  assert.match(workflow, /timeout-minutes: 120/);
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
  assert.match(
    workflow,
    /name: Record execute recovery deadline[\s\S]*CLAWSWEEPER_EXECUTE_DEADLINE_EPOCH/,
  );
  assert.match(
    workflow,
    /name: Execute credited fix artifact[\s\S]*timeout --signal=TERM --kill-after=30s "\$\{execute_timeout_seconds\}s"[\s\S]*node dist\/repair\/execute-fix-attempt\.js/,
  );
  assert.doesNotMatch(workflow, /timeout --foreground/);
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

test("repair source branch writability preflight runs before target repair", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = readText(sourcePath);

  const branchPreflightIndex = source.indexOf(
    "const sourceBranchPreflight = preflightRepairSourceBranchWrite(fixArtifact);",
  );
  const checkoutIndex = source.indexOf("ensureTargetCheckout(result.repo, targetDir);");
  const validationIndex = source.indexOf("preflightTargetValidationPlan(");
  const repairIndex = source.indexOf("outcome = executeRepairBranch({ fixArtifact, targetDir });");

  assert.notEqual(branchPreflightIndex, -1);
  assert.notEqual(checkoutIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.notEqual(repairIndex, -1);
  assert.ok(
    branchPreflightIndex < checkoutIndex &&
      checkoutIndex < validationIndex &&
      validationIndex < repairIndex,
    "live source-branch writability must be resolved before checkout, validation planning, and repair",
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
  const preparedPushIndex = preparedReplacement.indexOf("pushRecoverableBranch({");
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

test("terminal Codex and persistent setup failures do not request repair requeue", () => {
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
  const setupGuardIndex = helper.indexOf(
    "if (isPersistentCodexSetupFailure(message)) return false;",
  );
  const broadFallbackIndex = helper.indexOf("/Codex .*(?:timed out|failed|exited)");

  assert.notEqual(terminalGuardIndex, -1);
  assert.notEqual(setupGuardIndex, -1);
  assert.notEqual(broadFallbackIndex, -1);
  assert.ok(
    terminalGuardIndex < setupGuardIndex && setupGuardIndex < broadFallbackIndex,
    "terminal and persistent setup failures must be rejected before the broad Codex failure fallback",
  );
  assert.match(source, /sandbox \(\?:wrapper\|startup\)/);
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

test("repair publication pushes the accepted checkout through isolated Git auth", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const isolation = readText(path.join(process.cwd(), "src/repair/git-network-isolation.ts"));
  assert.match(source, /assertTargetPublicationGitConfiguration\(cwd, timeoutMs\)/);
  assert.match(source, /runIsolatedGitNetwork\(\{ args, cwd, env, timeoutMs, token \}\)/);
  assert.match(isolation, /GIT_ASKPASS: askpassPath/);
  assert.match(isolation, /`--git-dir=\$\{networkGitDir\}`/);
  assert.match(isolation, /GIT_OBJECT_DIRECTORY: source\.objectDirectory/);
  assert.match(isolation, /"push\.gpgSign=false"/);
  assert.match(isolation, /"push\.recurseSubmodules=no"/);
  assert.match(isolation, /"submodule\.recurse=false"/);
  assert.match(source, /assertTargetCheckoutBinding\(targetDir, checkoutBinding/);
  assert.match(source, /sourceRef: checkoutBinding\.headSha/);
  assert.match(
    source,
    /\["push", "--no-verify", remote, `\$\{sourceRef\}:\$\{pull\.head\.ref\}`\]/,
  );
  assert.match(source, /if \(publishedSha !== sourceRef\)/);
  assert.doesNotMatch(source, /gh", \["auth", "setup-git"\]/);
  assert.doesNotMatch(source, /`HEAD:\$\{pull\.head\.ref\}`/);
});

test("repair contract gates the final cumulative tree, not individual checkpoints", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  assert.equal(
    [...source.matchAll(/commitCheckpointIfNeeded\(/g)].length,
    5,
    "four checkpoint call sites plus the ordinary commit helper should remain",
  );
  assert.doesNotMatch(source, /commitRepairCheckpointIfNeeded|checkpointBaseHead/);
  assert.match(
    source,
    /enforceFinalRepairContract\(\{ fixArtifact, targetDir, baseSha: acceptedBaseSha \}\)/,
  );
  assert.doesNotMatch(source, /pushIntermediateCheckpoint|pushCheckpoint/);
  assert.match(source, /captureFinalTargetCheckoutBinding\(/);
  assert.match(source, /checkout_binding: checkoutBinding/);

  const compact = source.indexOf("const historyCompaction =");
  const enforce = source.indexOf("enforceFinalRepairContract(", compact);
  const binding = source.indexOf(
    "const checkoutBinding = captureFinalTargetCheckoutBinding(",
    enforce,
  );
  const result = source.indexOf("checkout_binding: checkoutBinding", binding);
  assert.ok(compact < enforce && enforce < binding && binding < result);
});

test("final repair contract and compaction use the exact accepted base SHA", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const start = source.indexOf("function enforceFinalRepairContract(");
  const end = source.indexOf("function pushRecoverableBranch(", start);
  const helper = source.slice(start, end);
  assert.match(source, /\.\/repair-contract\.js/);
  assert.match(source, /let acceptedBaseSha = targetBaseSha/);
  assert.match(source, /acceptedBaseSha = synchronizedBaseSha/);
  assert.match(source, /baseRef: baseSha/);
  assert.match(source, /target_base_sha: acceptedBaseSha/);
  assert.match(helper, /"diff", "--name-only", "-z", `\$\{baseSha\}\.\.HEAD`/);
  assert.match(helper, /enforceRepairContract\(\{ fixArtifact, changedFiles \}\)/);
  assert.doesNotMatch(helper, /origin\//);
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
    /runDiffCheck\(\{[\s\S]*?baseRef: targetBaseSha,[\s\S]*?checkoutBinding[\s\S]*?\}\)/,
  );
  assert.match(source, /pinned target base \$\{targetBaseSha\}/);
  assert.match(validation, /pinnedBaseRef\?: string/);
  assert.match(source, /classifyExternalBaseValidationFailure\(\{/);
  assert.match(
    source,
    /rebaseResult\?\.status === "conflicts" \? \(sourceHead \?\? targetBaseSha\) : currentHead\(targetDir\)/,
  );
  assert.match(validation, /if \(!options\.pinnedBaseRef\) \{[\s\S]*ensureMergeBaseAvailable/);
  assert.match(promptBuilder, /Pinned target base SHA: \$\{targetBaseSha\}/);
});

test("final synchronized tree is reviewed and reports persist before publication", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));

  assert.match(source, /reviewAfterFinalBaseSync\(\{/);
  assert.match(source, /validateAndReviewSynchronizedTree\(\{/);
  assert.match(source, /repairDeltaPaths: finalSyncRepairDeltaPaths/);
  assert.match(source, /attempt: "final-sync"/);
  assert.match(source, /finalizeExecutionReport\(\{/);
});

test("repair workflow renews target credentials before deferred outcome publication", () => {
  const workflow = readText(
    path.join(process.cwd(), ".github/workflows/repair-cluster-worker.yml"),
  );
  const executeIndex = workflow.indexOf("- name: Execute credited fix artifact");
  const renewIndex = workflow.indexOf("- name: Renew target write token for post-flight");
  const publishIndex = workflow.indexOf("- name: Publish deferred fix outcome");
  const postFlightIndex = workflow.indexOf("- name: Post-flight finalize fix PRs");

  assert.ok(
    executeIndex < renewIndex && renewIndex < publishIndex && publishIndex < postFlightIndex,
  );
  assert.match(workflow.slice(executeIndex, renewIndex), /--latest --defer-publication/);
  assert.match(
    workflow.slice(publishIndex, postFlightIndex),
    /GH_TOKEN: \${{ steps\.target_post_flight_token\.outputs\.token }}/,
  );
  assert.match(workflow.slice(publishIndex, postFlightIndex), /--latest --publish-report-only/);
});
