import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("no-op automerge repair updates outcome and re-enters router before exit", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const noPlannedBranch = source.match(
    /if \(plannedFixActions\.length === 0\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;

  assert.ok(noPlannedBranch, "expected no planned fix actions branch");
  assert.match(noPlannedBranch, /report\.reason = "no planned fix actions";/);

  const continuationIndex = noPlannedBranch.indexOf(
    "appendAutomergeRepairOutcomeComment(report, resultPath);",
  );
  const writeReportIndex = noPlannedBranch.indexOf("writeReport(report, resultPath);");
  const exitIndex = noPlannedBranch.indexOf("process.exit(0);");

  assert.notEqual(continuationIndex, -1);
  assert.notEqual(writeReportIndex, -1);
  assert.notEqual(exitIndex, -1);
  assert.ok(
    continuationIndex < writeReportIndex && writeReportIndex < exitIndex,
    "no-op repair must update automerge continuation before writing the terminal report and exiting",
  );
});

test("repair source branch writability preflight runs before expensive repair preflights", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

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

test("merged source replacement skip runs before publishing replacement PRs", () => {
  const sourcePath = path.join(process.cwd(), "src/repair/execute-fix-artifact.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

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
