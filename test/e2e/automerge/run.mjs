import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOMERGE_E2E_FIXTURES,
  createCiRegressionFixture,
  createTargetFixture,
} from "./target-fixtures.mjs";
import { repairCommentRouterGroup, WorkflowScheduler } from "./workflow-scheduler.mjs";

const helperRoot = path.dirname(fileURLToPath(import.meta.url));
export const AUTOMERGE_E2E_SCENARIOS = [
  "approve-intent-persistence",
  "completed-verdict-resume",
  "dependency-setup-mutation",
  "happy-path",
  "pending-checks",
  "planning-head-drift",
  "resume-intent-persistence",
  "workflow-scheduler-convergence",
  "verdict-head-drift",
  "ci-regression-29623139111",
];

export function runAutomergeE2E({
  candidateRoot = process.cwd(),
  outputRoot = path.join(process.cwd(), "test-results", "automerge"),
  scenario = "happy-path",
  fixture = "tiny",
  expectedOutcome = "success",
  targetPrNumber = 42,
  keep = false,
} = {}) {
  if (!AUTOMERGE_E2E_SCENARIOS.includes(scenario)) {
    throw new Error(`unsupported scenario: ${scenario}`);
  }
  if (!AUTOMERGE_E2E_FIXTURES.includes(fixture)) {
    throw new Error(`unsupported fixture: ${fixture}`);
  }
  if (!["success", "setup-identity-failure"].includes(expectedOutcome)) {
    throw new Error(`unsupported expected outcome: ${expectedOutcome}`);
  }
  if (scenario === "workflow-scheduler-convergence") {
    assert.equal(expectedOutcome, "success", "scheduler convergence supports only success");
    return runWorkflowSchedulerConvergence({ candidateRoot, outputRoot, fixture, keep });
  }
  if (
    expectedOutcome !== "success" &&
    !(
      scenario === "ci-regression-29623139111" ||
      (scenario === "happy-path" && fixture === "openclaw-shaped")
    )
  ) {
    throw new Error(
      `${expectedOutcome} is only valid for ci-regression-29623139111 or the openclaw-shaped happy-path`,
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-automerge-e2e-"));
  const artifacts = path.resolve(outputRoot, fixture, scenario);
  fs.rmSync(artifacts, { recursive: true, force: true });
  fs.mkdirSync(artifacts, { recursive: true });

  try {
    const runtimeRoot = createCandidateRuntime(root, candidateRoot);
    if (scenario === "resume-intent-persistence") {
      assertDeferredVerdictHandoffIsolation(candidateRoot);
    }
    const targetFixture =
      scenario === "ci-regression-29623139111"
        ? createCiRegressionFixture(root, { fixture })
        : createTargetFixture(root, {
            fixture,
            dependencySetupMutation: scenario === "dependency-setup-mutation",
          });
    if (targetPrNumber !== 42) {
      execFileSync("/usr/bin/git", [
        "--git-dir",
        targetFixture.remote,
        "update-ref",
        `refs/pull/${targetPrNumber}/head`,
        targetFixture.headSha,
      ]);
    }
    const statePath = path.join(root, "github-state.json");
    const binDir = createCommandBin(root);
    const realCorepack = execFileSync("which", ["corepack"], { encoding: "utf8" }).trim();
    const jobPath = createJob(root, targetFixture.headSha, targetPrNumber);
    writeJson(statePath, initialGitHubState(targetFixture, targetPrNumber));

    const baseEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CLAWSWEEPER_E2E_GITHUB_STATE: statePath,
      CLAWSWEEPER_E2E_REAL_COREPACK: realCorepack,
      ...(scenario === "ci-regression-29623139111"
        ? { CLAWSWEEPER_E2E_COREPACK_PNPM_ONLY: "1" }
        : {}),
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOW_FIX_PR: "1",
      CLAWSWEEPER_ALLOW_MERGE: "1",
      CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT: "0",
      CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS: "0",
      CLAWSWEEPER_CODEX_HEARTBEAT_MS: "10000",
      CLAWSWEEPER_FIX_EDIT_ATTEMPTS: "1",
      CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
      CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS: "1",
      CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "2000",
      CLAWSWEEPER_POST_FLIGHT_POLL_MS: "20",
      CLAWSWEEPER_TARGET_INSTALL_REGISTRY: "https://registry.npmjs.org/",
      CLAWSWEEPER_TARGET_VALIDATION_MODE: "strict",
      CLAWSWEEPER_MODEL: "e2e-codex",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ID: "4242",
      GITHUB_SERVER_URL: "https://github.com",
    };

    runCli(
      runtimeRoot,
      ["dist/repair/validate-job.js", jobPath],
      baseEnv,
      "read-token",
      artifacts,
      "01-validate",
    );
    runCli(
      runtimeRoot,
      ["dist/repair/run-worker.js", jobPath, "--mode", "autonomous", "--model", "e2e-codex"],
      baseEnv,
      "read-token",
      artifacts,
      "02-plan",
    );
    const sourceRunDir = latestRunDir(runtimeRoot);
    runCli(
      runtimeRoot,
      ["dist/repair/review-results.js", sourceRunDir],
      baseEnv,
      "read-token",
      artifacts,
      "03-review",
    );

    const transferDir = path.join(root, "artifact-transfer", path.basename(sourceRunDir));
    fs.mkdirSync(path.dirname(transferDir), { recursive: true });
    fs.cpSync(sourceRunDir, transferDir, { recursive: true });
    fs.rmSync(path.join(runtimeRoot, ".clawsweeper-repair", "runs"), {
      recursive: true,
      force: true,
    });
    const resultPath = path.join(transferDir, "result.json");
    const targetDir = path.join(root, "execute-workspace", "target");

    if (scenario === "ci-regression-29623139111" && expectedOutcome === "setup-identity-failure") {
      return runCiRegressionFailureScenario({
        artifacts,
        baseEnv,
        fixture: targetFixture,
        jobPath,
        resultPath,
        runtimeRoot,
        targetDir,
      });
    }
    if (scenario === "happy-path" && expectedOutcome === "setup-identity-failure") {
      return runSetupIdentityFailureScenario({
        artifacts,
        baseEnv,
        fixture: targetFixture,
        jobPath,
        resultPath,
        runtimeRoot,
        targetDir,
      });
    }

    if (scenario === "planning-head-drift") {
      return runPlanningHeadDriftScenario({
        artifacts,
        baseEnv,
        fixture: targetFixture,
        jobPath,
        resultPath,
        runtimeRoot,
        statePath,
        targetDir,
        transferDir,
      });
    }
    if (scenario === "dependency-setup-mutation") {
      return runDependencySetupMutationScenario({
        artifacts,
        baseEnv,
        fixture: targetFixture,
        jobPath,
        resultPath,
        runtimeRoot,
        statePath,
        targetDir,
      });
    }

    const indexStatMutation =
      scenario === "ci-regression-29623139111"
        ? startIndexStatMutation(targetDir, targetFixture.repairTarget, artifacts)
        : null;
    runCli(
      runtimeRoot,
      [
        "dist/repair/execute-fix-artifact.js",
        jobPath,
        resultPath,
        "--target-dir",
        targetDir,
        "--defer-publication",
      ],
      baseEnv,
      "write-token",
      artifacts,
      "04-execute",
    );
    if (indexStatMutation) assertIndexStatMutation(indexStatMutation);
    runCli(
      runtimeRoot,
      ["dist/repair/execute-fix-artifact.js", jobPath, resultPath, "--publish-report-only"],
      baseEnv,
      "post-token",
      artifacts,
      "05-publish",
    );
    runCli(
      runtimeRoot,
      ["dist/repair/apply-result.js", jobPath, resultPath],
      baseEnv,
      "post-token",
      artifacts,
      "06-apply-before",
    );
    runCli(
      runtimeRoot,
      ["dist/repair/post-flight.js", jobPath, resultPath],
      baseEnv,
      "post-token",
      artifacts,
      "07-post-flight",
    );
    const repairPostFlight = JSON.parse(
      fs.readFileSync(path.join(transferDir, "post-flight-report.json"), "utf8"),
    );

    const repairedHead = currentRef(targetFixture.remote, targetFixture.headRef);
    assertFixturePostRepair(targetFixture, repairedHead);
    if (
      scenario === "approve-intent-persistence" ||
      scenario === "completed-verdict-resume" ||
      scenario === "resume-intent-persistence"
    ) {
      const activeJob = path.join(
        runtimeRoot,
        "jobs/openclaw/inbox/automerge-openclaw-openclaw-42.md",
      );
      fs.mkdirSync(path.dirname(activeJob), { recursive: true });
      fs.copyFileSync(jobPath, activeJob);
    }
    let completedVerdictAlreadyRouted = false;
    if (scenario === "approve-intent-persistence") {
      updateGitHubState(statePath, (state) => {
        state.pr.mergeStateStatus = "BEHIND";
        state.pr.labels.push("clawsweeper:human-review");
      });
      const approvalId = addMaintainerApproveCommand(statePath);
      runCommentRouterExact(runtimeRoot, baseEnv, artifacts, "08-comment-router-approve", {
        commentId: approvalId,
      });
      assert.equal(
        JSON.parse(fs.readFileSync(statePath, "utf8")).pr.mergedAt,
        null,
        "a behind branch must remain open after the first exact-head approval",
      );
      updateGitHubState(statePath, (state) => {
        state.pr.mergeStateStatus = "CLEAN";
      });
      addCanonicalNeedsHumanVerdict(statePath, repairedHead);
    } else if (scenario === "completed-verdict-resume") {
      updateGitHubState(statePath, (state) => {
        if (!state.pr.labels.includes("clawsweeper:automerge")) {
          state.pr.labels.push("clawsweeper:automerge");
        }
      });
      const verdictId = addExactHeadVerdict(statePath, repairedHead);
      const commandId = addMaintainerAutomergeCommand(statePath);
      runCommentRouterExact(runtimeRoot, baseEnv, artifacts, "08-comment-router-command", {
        commentId: commandId,
      });
      const resumedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const verdictHandoff = resumedState.dispatches.findLast(
        (dispatch) =>
          dispatch.event_type === "clawsweeper_comment" &&
          dispatch.client_payload?.comment_id === String(verdictId),
      );
      assert.ok(
        verdictHandoff,
        "an armed-plan resume must requeue an exact verdict that completed before the command",
      );
      assert.equal(verdictHandoff.client_payload.force_reprocess, "true");
      runCommentRouterExact(runtimeRoot, baseEnv, artifacts, "10-comment-router-verdict-handoff", {
        commentId: verdictId,
        forceReprocess: true,
        attemptId: String(verdictHandoff.client_payload.attempt_id),
      });
      completedVerdictAlreadyRouted = true;
    } else if (scenario === "resume-intent-persistence") {
      addMaintainerAutomergeCommand(statePath);
      runCommentRouter(runtimeRoot, baseEnv, artifacts, "08-comment-router-resume-command");
      const resumeReport = readRouterReport(runtimeRoot);
      const resume = resumeReport.commands.find(
        (command) => command.intent === "automerge" && command.trusted_bot === false,
      );
      assert.equal(
        resume?.status,
        "executed",
        "maintainer replay must record active resume intent",
      );
      const persistedLedger = JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, "results", "comment-router.json"), "utf8"),
      );
      assert.equal(
        persistedLedger.commands.some(
          (command) =>
            command.intent === "automerge" &&
            command.status === "executed" &&
            command.author === "fixture-maintainer",
        ),
        true,
        "a later router invocation must be able to hydrate the resume command",
      );
      addCanonicalNeedsHumanVerdict(statePath, repairedHead);
    } else if (!completedVerdictAlreadyRouted) {
      addExactHeadVerdict(statePath, repairedHead);
    }
    if (scenario === "verdict-head-drift") {
      const driftedHead = advanceRemoteContributorHead(root, targetFixture, "verdict head drift");
      runCommentRouter(runtimeRoot, baseEnv, artifacts, "08-comment-router-stale-verdict");
      const routerReport = readRouterReport(runtimeRoot);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(state.pr.mergedAt, null, "a stale exact-head verdict must not merge");
      assert.equal(currentRef(targetFixture.remote, targetFixture.headRef), driftedHead);
      assert.equal(
        state.calls.filter((call) => call.args[0] === "pr" && call.args[1] === "merge").length,
        0,
      );
      assert.match(
        String(routerReport.commands.at(-1)?.reason ?? ""),
        /does not match current head/,
      );
      fs.copyFileSync(statePath, path.join(artifacts, "github-state.json"));
      writeJson(path.join(artifacts, "summary.json"), {
        status: "passed",
        fixture,
        scenario,
        reviewed_head: repairedHead,
        current_head: driftedHead,
        merge: "blocked before mutation",
      });
      return { status: "passed", fixture, scenario, artifacts };
    }
    if (scenario === "pending-checks") {
      updateGitHubState(statePath, (state) => {
        // Prehydration and the execution-time exact-head lease check each read
        // the PR before merge readiness performs its own observation.
        state.pendingCheckReads = 4;
      });
      runCommentRouter(
        runtimeRoot,
        { ...baseEnv, CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS: "0" },
        artifacts,
        "08-comment-router-pending",
      );
      const waitingReport = readRouterReport(runtimeRoot);
      assert.equal(waitingReport.commands.at(-1)?.status, "waiting");
      assert.match(
        String(
          waitingReport.commands.at(-1)?.actions.find((action) => action.action === "merge")
            ?.reason ?? "",
        ),
        /checks are still running/,
      );
      assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).pr.mergedAt, null);
      runCommentRouter(runtimeRoot, baseEnv, artifacts, "09-comment-router-checks-green");
    } else if (!completedVerdictAlreadyRouted) {
      runCommentRouter(runtimeRoot, baseEnv, artifacts, "08-comment-router");
    }
    const routerReport = readRouterReport(runtimeRoot);
    runCommentRouter(runtimeRoot, baseEnv, artifacts, "10-comment-router-idempotent");
    const idempotentRouterReport = readRouterReport(runtimeRoot);
    runCli(
      runtimeRoot,
      ["dist/repair/apply-result.js", jobPath, resultPath],
      baseEnv,
      "post-token",
      artifacts,
      "11-apply-after",
    );
    runCli(
      runtimeRoot,
      ["dist/repair/post-flight.js", jobPath, resultPath],
      baseEnv,
      "post-token",
      artifacts,
      "12-post-flight-idempotent",
    );

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const fixReport = JSON.parse(
      fs.readFileSync(path.join(transferDir, "fix-execution-report.json"), "utf8"),
    );
    assert.ok(state.pr.mergedAt, "the exact-head verdict must route to the final merge");
    assert.equal(fixReport.actions.at(-1)?.status, "pushed");
    assert.equal(repairPostFlight.actions.at(-1)?.status, "blocked");
    assert.equal(repairPostFlight.actions.at(-1)?.reason, "job does not allow merge");
    const mergedCommand = routerReport.commands.find((command) =>
      command.actions.some((action) => action.action === "merge"),
    );
    assert.equal(
      mergedCommand?.actions.find((action) => action.action === "merge")?.status,
      "executed",
    );
    assert.equal(idempotentRouterReport.actionable, 0);
    assert.equal(
      state.calls.filter((call) => call.args[0] === "pr" && call.args[1] === "merge").length,
      scenario === "approve-intent-persistence" ? 2 : 1,
      "an idempotent router replay must not attempt a second merge",
    );
    assert.ok(state.calls.some((call) => call.token === "read"));
    assert.ok(state.calls.some((call) => call.token === "write"));
    assert.ok(state.calls.some((call) => call.token === "post"));

    fs.copyFileSync(statePath, path.join(artifacts, "github-state.json"));
    fs.cpSync(transferDir, path.join(artifacts, "run"), { recursive: true });
    writeJson(path.join(artifacts, "summary.json"), {
      status: "passed",
      fixture,
      scenario,
      target_repo: state.repo,
      target_pr: state.pr.number,
      repaired_head: repairedHead,
      merge_commit: state.pr.mergeCommitSha,
      artifact_transfer: "planning run copied into a fresh execution workspace",
      tokens: ["read", "write", "post"],
    });
    return { status: "passed", fixture, scenario, artifacts };
  } catch (error) {
    const deferredRun = path.join(root, "artifact-transfer");
    if (fs.existsSync(deferredRun)) {
      // Publication failures are encoded in durable execution reports, so
      // retain that handoff even when a later terminal-state assertion fails.
      fs.cpSync(deferredRun, path.join(artifacts, "artifact-transfer"), {
        recursive: true,
      });
    }
    const statePath = path.join(root, "github-state.json");
    if (fs.existsSync(statePath)) {
      fs.copyFileSync(statePath, path.join(artifacts, "github-state.json"));
    }
    writeJson(path.join(artifacts, "failure.json"), {
      status: "failed",
      fixture,
      scenario,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      retained_root: root,
    });
    throw error;
  } finally {
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

function runWorkflowSchedulerConvergence({ candidateRoot, outputRoot, fixture, keep }) {
  assertDeferredVerdictHandoffIsolation(candidateRoot);
  const artifacts = path.resolve(outputRoot, fixture, "workflow-scheduler-convergence");
  fs.rmSync(artifacts, { recursive: true, force: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const scheduler = new WorkflowScheduler();
  const repository = "openclaw/openclaw";
  const dispatches = [
    { id: "background-running", eventName: "schedule", itemNumbers: "" },
    { id: "background-replaced", eventName: "workflow_dispatch", itemNumbers: "" },
    { id: "background-survivor", eventName: "repository_dispatch", itemNumbers: "" },
    { id: "verdict-104054", eventName: "workflow_dispatch", itemNumbers: "104054" },
    { id: "verdict-108974", eventName: "workflow_dispatch", itemNumbers: "108974" },
  ];
  for (const dispatch of dispatches) {
    scheduler.dispatch({
      ...dispatch,
      group: repairCommentRouterGroup({ repository, ...dispatch }),
    });
  }

  const results = new Map();
  while (true) {
    const running = scheduler.active().flatMap((group) => (group.running ? [group.running] : []));
    if (running.length === 0) break;
    for (const runId of running) {
      if (runId.startsWith("verdict-")) {
        results.set(
          runId,
          runAutomergeE2E({
            candidateRoot,
            outputRoot: path.join(artifacts, runId),
            scenario: "happy-path",
            fixture,
            keep,
            targetPrNumber: Number(runId.slice("verdict-".length)),
          }),
        );
      }
      scheduler.complete(runId);
    }
  }

  const records = scheduler.records();
  assert.equal(records.find((run) => run.id === "background-replaced")?.status, "replaced");
  for (const runId of ["verdict-104054", "verdict-108974"]) {
    assert.equal(records.find((run) => run.id === runId)?.status, "executed");
    assert.equal(results.get(runId)?.status, "passed");
  }
  writeJson(path.join(artifacts, "scheduler-trace.json"), { dispatches, records });
  writeJson(path.join(artifacts, "summary.json"), {
    status: "passed",
    fixture,
    scenario: "workflow-scheduler-convergence",
    exact_verdicts: ["verdict-104054", "verdict-108974"],
    background_interference: "one pending broad router replaced",
  });
  return { status: "passed", fixture, scenario: "workflow-scheduler-convergence", artifacts };
}

function assertDeferredVerdictHandoffIsolation(candidateRoot) {
  const sweep = fs.readFileSync(path.join(candidateRoot, ".github/workflows/sweep.yml"), "utf8");
  const router = fs.readFileSync(
    path.join(candidateRoot, ".github/workflows/repair-comment-router.yml"),
    "utf8",
  );
  assert.match(
    sweep,
    /Queue deferred exact verdict router[\s\S]*-f item_numbers="\$ITEM_NUMBER"/,
    "the exact review publisher must identify the PR in its deferred router handoff",
  );
  assert.match(
    router,
    /github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.item_numbers != '' && format\('repair-comment-router-\{0\}-items-\{1\}'/,
    "deferred verdict handoffs must not share the replaceable repository-wide pending group",
  );
}

function createCandidateRuntime(root, candidateRoot) {
  const source = path.resolve(candidateRoot);
  const runtime = path.join(root, "candidate-runtime");
  for (const relative of ["dist", "schema", "prompts", "config"]) {
    const from = path.join(source, relative);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(runtime, relative), { recursive: true });
  }
  for (const relative of ["package.json", "VISION.md", "README.md"]) {
    const from = path.join(source, relative);
    if (fs.existsSync(from)) {
      fs.mkdirSync(runtime, { recursive: true });
      fs.copyFileSync(from, path.join(runtime, relative));
    }
  }
  const modules = path.join(source, "node_modules");
  if (!fs.existsSync(path.join(runtime, "dist"))) {
    throw new Error(`candidate build output is missing: ${path.join(source, "dist")}`);
  }
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(runtime, "node_modules"), "dir");
  return runtime;
}

function addExactHeadVerdict(statePath, headSha) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const now = new Date().toISOString();
  state.comments.push({
    id: state.nextCommentId++,
    body: `ClawSweeper review passed.\n<!-- clawsweeper-verdict:pass item=${state.pr.number} sha=${headSha} reviewed_at=${now} -->`,
    issue_url: `https://api.github.com/repos/${state.repo}/issues/${state.pr.number}`,
    html_url: `https://github.com/${state.repo}/pull/${state.pr.number}#issuecomment-${state.nextCommentId - 1}`,
    user: { id: 1, login: "clawsweeper[bot]" },
    author_association: "MEMBER",
    created_at: now,
    updated_at: now,
  });
  writeJson(statePath, state);
  return state.nextCommentId - 1;
}

function addMaintainerAutomergeCommand(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  addFixtureComment(statePath, {
    author: "clawsweeper[bot]",
    authorId: 1,
    body: `Automerge is already active.\n<!-- clawsweeper-command-status:${state.pr.number}:automerge:active -->`,
  });
  return addFixtureComment(statePath, {
    author: "fixture-maintainer",
    authorId: 2,
    body: "@clawsweeper automerge\n\nResume the exact current head after the repair fix landed.",
  });
}

function addMaintainerApproveCommand(statePath) {
  return addFixtureComment(statePath, {
    author: "fixture-maintainer",
    authorId: 2,
    body: "@clawsweeper approve",
  });
}

function addCanonicalNeedsHumanVerdict(statePath, headSha) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const now = new Date(Date.now() + 1000).toISOString();
  addFixtureComment(statePath, {
    author: "clawsweeper[bot]",
    authorId: 1,
    body: [
      "ClawSweeper needs maintainer judgment.",
      "",
      "**Next step before merge**",
      "- [P2] No repair lane is needed: the PR already contains the narrow fix, but missing real behavior proof needs maintainer handling.",
      "",
      `<!-- clawsweeper-verdict:needs-human item=${state.pr.number} sha=${headSha} reviewed_at=${now} -->`,
    ].join("\n"),
    timestamp: now,
  });
}

function addFixtureComment(
  statePath,
  { author, authorId, body, timestamp = new Date().toISOString() },
) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const id = state.nextCommentId++;
  state.comments.push({
    id,
    body,
    issue_url: `https://api.github.com/repos/${state.repo}/issues/${state.pr.number}`,
    html_url: `https://github.com/${state.repo}/pull/${state.pr.number}#issuecomment-${id}`,
    user: { id: authorId, login: author },
    author_association: "MEMBER",
    created_at: timestamp,
    updated_at: timestamp,
  });
  writeJson(statePath, state);
  return id;
}

function runPlanningHeadDriftScenario({
  artifacts,
  baseEnv,
  fixture,
  jobPath,
  resultPath,
  runtimeRoot,
  statePath,
  targetDir,
  transferDir,
}) {
  const plannedHead = fixture.headSha;
  const driftedHead = advanceContributorHead(fixture, "planning head drift");
  runCliExpectFailure(
    runtimeRoot,
    [
      "dist/repair/execute-fix-artifact.js",
      jobPath,
      resultPath,
      "--target-dir",
      targetDir,
      "--defer-publication",
    ],
    baseEnv,
    "write-token",
    artifacts,
    "04-execute-stale-head",
  );

  const reportPath = path.join(transferDir, "fix-execution-report.json");
  assert.ok(fs.existsSync(reportPath), "stale planning must produce a durable execution report");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const action = report.actions.at(-1);
  assert.equal(report.status, "blocked");
  assert.equal(action?.status, "blocked");
  assert.equal(action?.requeue_required, true);
  assert.equal(action?.expected_head_sha, plannedHead);
  assert.equal(action?.current_head_sha, driftedHead);
  assert.match(String(action?.reason ?? ""), /changed after automerge planning/);
  assert.equal(
    currentRef(fixture.remote, fixture.headRef),
    driftedHead,
    "a stale executor must not push over the contributor's new head",
  );
  assert.equal(fs.existsSync(targetDir), false, "stale planning must stop before target checkout");

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.copyFileSync(statePath, path.join(artifacts, "github-state.json"));
  fs.copyFileSync(reportPath, path.join(artifacts, "fix-execution-report.json"));
  writeJson(path.join(artifacts, "summary.json"), {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "planning-head-drift",
    target_repo: state.repo,
    target_pr: state.pr.number,
    planned_head: plannedHead,
    current_head: driftedHead,
    mutation: "blocked before target checkout, Codex, or push",
  });
  return { status: "passed", fixture: fixture.fixture, scenario: "planning-head-drift", artifacts };
}

function advanceContributorHead(fixture, message) {
  const target = path.join(fixture.seed, fixture.repairTarget);
  fs.appendFileSync(target, `${message}\n`);
  git(["add", fixture.repairTarget], fixture.seed);
  git(["commit", "-m", `test: ${message}`], fixture.seed);
  git(["push", "origin", fixture.headRef], fixture.seed);
  const head = currentRef(fixture.remote, fixture.headRef);
  git(["update-ref", "refs/pull/42/head", head], fixture.remote);
  return head;
}

function advanceRemoteContributorHead(root, fixture, message) {
  const checkout = path.join(root, `remote-update-${message.replace(/[^a-z0-9]+/gi, "-")}`);
  git(["clone", fixture.remote, checkout]);
  git(["config", "user.name", "E2E Contributor"], checkout);
  git(["config", "user.email", "contributor@example.invalid"], checkout);
  git(["checkout", fixture.headRef], checkout);
  const target = path.join(checkout, fixture.repairTarget);
  fs.appendFileSync(target, `${message}\n`);
  git(["add", fixture.repairTarget], checkout);
  git(["commit", "-m", `test: ${message}`], checkout);
  git(["push", "origin", fixture.headRef], checkout);
  const head = currentRef(fixture.remote, fixture.headRef);
  git(["update-ref", "refs/pull/42/head", head], fixture.remote);
  return head;
}

function runDependencySetupMutationScenario({
  artifacts,
  baseEnv,
  fixture,
  jobPath,
  resultPath,
  runtimeRoot,
  statePath,
  targetDir,
}) {
  const originalHead = currentRef(fixture.remote, fixture.headRef);
  const child = runCliExpectFailure(
    runtimeRoot,
    [
      "dist/repair/execute-fix-artifact.js",
      jobPath,
      resultPath,
      "--target-dir",
      targetDir,
      "--defer-publication",
    ],
    baseEnv,
    "write-token",
    artifacts,
    "04-execute-mutating-install",
  );
  assert.match(
    `${child.stderr ?? ""}\n${child.stdout ?? ""}`,
    /target dependency setup mutated checkout identity/,
  );
  assert.equal(
    currentRef(fixture.remote, fixture.headRef),
    originalHead,
    "dependency setup failure must stop before branch push",
  );
  assert.equal(
    fs.readFileSync(path.join(targetDir, fixture.repairTarget), "utf8"),
    "broken\n",
    "dependency setup failure must stop before Codex edits",
  );
  fs.copyFileSync(statePath, path.join(artifacts, "github-state.json"));
  writeJson(path.join(artifacts, "summary.json"), {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "dependency-setup-mutation",
    rejected_error: "target dependency setup mutated checkout identity",
    mutation: "blocked before Codex or push",
  });
  return {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "dependency-setup-mutation",
    artifacts,
  };
}

function runCiRegressionFailureScenario({
  artifacts,
  baseEnv,
  fixture,
  jobPath,
  resultPath,
  runtimeRoot,
  targetDir,
}) {
  const indexStatMutation = startIndexStatMutation(targetDir, artifacts);
  const child = runCliRaw(
    runtimeRoot,
    [
      "dist/repair/execute-fix-artifact.js",
      jobPath,
      resultPath,
      "--target-dir",
      targetDir,
      "--defer-publication",
    ],
    baseEnv,
    "write-token",
    artifacts,
    "04-execute-ci-regression",
  );
  assertIndexStatMutation(indexStatMutation);
  const reportPath = path.join(path.dirname(resultPath), "fix-execution-report.json");
  let reportedReason = "";
  if (fs.existsSync(reportPath)) {
    fs.copyFileSync(reportPath, path.join(artifacts, "fix-execution-report.json"));
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    reportedReason = String(report.actions.at(-1)?.reason ?? "");
    assert.equal(report.actions.at(-1)?.status, "failed");
  }
  assert.ok(child.status !== 0 || reportedReason, "CI regression unexpectedly succeeded");
  assert.match(
    `${reportedReason}\n${child.stderr ?? ""}\n${child.stdout ?? ""}`,
    /target dependency setup mutated checkout identity/,
  );
  assert.equal(currentRef(fixture.remote, fixture.headRef), fixture.headSha);
  writeJson(path.join(artifacts, "summary.json"), {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "ci-regression-29623139111",
    expected_outcome: "setup-identity-failure",
    clawsweeper_revision: "7be2e4915b4b1d9aa953ccfe359cea670a4616ec",
    target_revision: fixture.headSha,
    reproduced_error: "target dependency setup mutated checkout identity",
  });
  return {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "ci-regression-29623139111",
    artifacts,
  };
}

function runSetupIdentityFailureScenario({
  artifacts,
  baseEnv,
  fixture,
  jobPath,
  resultPath,
  runtimeRoot,
  targetDir,
}) {
  const originalHead = currentRef(fixture.remote, fixture.headRef);
  const child = runCliExpectFailure(
    runtimeRoot,
    [
      "dist/repair/execute-fix-artifact.js",
      jobPath,
      resultPath,
      "--target-dir",
      targetDir,
      "--defer-publication",
    ],
    baseEnv,
    "write-token",
    artifacts,
    "04-execute-setup-identity-regression",
  );
  assert.match(
    `${child.stderr ?? ""}\n${child.stdout ?? ""}`,
    /target dependency setup mutated checkout identity: worktreeSha256/,
  );
  assert.equal(currentRef(fixture.remote, fixture.headRef), originalHead);
  assert.equal(
    fs.readFileSync(path.join(targetDir, fixture.repairTarget), "utf8"),
    "broken\n",
    "setup identity failure must stop before Codex edits or branch push",
  );
  writeJson(path.join(artifacts, "summary.json"), {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "happy-path",
    expected_outcome: "setup-identity-failure",
    reproduced_error: "target dependency setup mutated checkout identity: worktreeSha256",
    mutation: "blocked before Codex or push",
  });
  return {
    status: "passed",
    fixture: fixture.fixture,
    scenario: "happy-path",
    artifacts,
  };
}

function runCommentRouter(runtimeRoot, baseEnv, artifacts, label) {
  const statePath = baseEnv.CLAWSWEEPER_E2E_GITHUB_STATE;
  assert.equal(typeof statePath, "string", "router requires the fake GitHub state path");
  const itemNumber = JSON.parse(fs.readFileSync(statePath, "utf8")).pr.number;
  runCli(
    runtimeRoot,
    [
      "dist/repair/comment-router.js",
      "--repo",
      "openclaw/openclaw",
      "--item-number",
      String(itemNumber),
      "--max-comments",
      "20",
      "--execute",
    ],
    baseEnv,
    "post-token",
    artifacts,
    label,
  );
}

function runCommentRouterExact(
  runtimeRoot,
  baseEnv,
  artifacts,
  label,
  { commentId, forceReprocess = false, attemptId = "" },
) {
  const statePath = baseEnv.CLAWSWEEPER_E2E_GITHUB_STATE;
  assert.equal(typeof statePath, "string", "router requires the fake GitHub state path");
  const itemNumber = JSON.parse(fs.readFileSync(statePath, "utf8")).pr.number;
  const replayArgs = forceReprocess ? ["--force-reprocess", "--attempt-id", attemptId] : [];
  runCli(
    runtimeRoot,
    [
      "dist/repair/comment-router.js",
      "--repo",
      "openclaw/openclaw",
      "--item-number",
      String(itemNumber),
      "--comment-id",
      String(commentId),
      "--max-comments",
      "1",
      ...replayArgs,
      "--execute",
    ],
    baseEnv,
    "post-token",
    artifacts,
    label,
  );
}

function readRouterReport(runtimeRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, "results", "comment-router-latest.json"), "utf8"),
  );
}

function updateGitHubState(statePath, update) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  update(state);
  writeJson(statePath, state);
}

function initialGitHubState(fixture, targetPrNumber = 42) {
  const now = new Date().toISOString();
  return {
    repo: "openclaw/openclaw",
    remote: fixture.remote,
    tokens: { read: "read-token", write: "write-token", post: "post-token" },
    pendingCheckReads: 0,
    nextCommentId: 100,
    comments: [],
    dispatches: [],
    calls: [],
    pr: {
      number: targetPrNumber,
      state: "open",
      title: "fix: repair the deterministic fixture",
      body: "Exercise the ClawSweeper automerge repair flow.",
      author: "fixture-contributor",
      baseRef: "main",
      headRef: fixture.headRef,
      labels: ["clawsweeper:automerge"],
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      mergeCommitSha: null,
      mergeStateStatus: "CLEAN",
      files: fixture.files ?? ["src/repair-target.txt"],
    },
  };
}

function assertFixturePostRepair(fixture, repairedHead) {
  if (!fixture.behindMain) return;
  execFileSync(
    "/usr/bin/git",
    ["--git-dir", fixture.remote, "merge-base", "--is-ancestor", fixture.baseSha, repairedHead],
    { stdio: "ignore" },
  );
  assert.equal(
    execFileSync(
      "/usr/bin/git",
      ["--git-dir", fixture.remote, "show", `${repairedHead}:CHANGELOG.md`],
      { encoding: "utf8" },
    ),
    fixture.changelog,
    "ordinary OpenClaw automerge repair must preserve the release-owned changelog",
  );
  assert.match(
    execFileSync(
      "/usr/bin/git",
      ["--git-dir", fixture.remote, "ls-tree", repairedHead, "CLAUDE.md"],
      { encoding: "utf8" },
    ),
    /^120000 blob /,
    "OpenClaw's tracked CLAUDE.md symlink must survive repair and base sync",
  );
}

function createCommandBin(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const [name, source] of [
    ["gh", "fake-gh.mjs"],
    ["codex", "fake-codex.mjs"],
    ["corepack", "corepack-proxy.mjs"],
    ["git", "git-proxy.mjs"],
  ]) {
    fs.symlinkSync(path.join(helperRoot, source), path.join(bin, name));
  }
  return bin;
}

function startIndexStatMutation(targetDir, trackedRelativePath, artifacts) {
  const marker = path.join(artifacts, "index-stat-mutation.txt");
  const child = spawn(
    process.execPath,
    [path.join(helperRoot, "index-stat-mutator.mjs"), targetDir, trackedRelativePath, marker],
    { stdio: "ignore" },
  );
  return { child, marker };
}

function assertIndexStatMutation({ child, marker }) {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!fs.existsSync(marker)) {
    child.kill();
    throw new Error("Git index stat-cache mutation did not run");
  }
}

function createJob(root, headSha, targetPrNumber = 42) {
  const jobPath = path.join(root, "automerge-job.md");
  fs.writeFileSync(
    jobPath,
    `---\nrepo: openclaw/openclaw\ncluster_id: automerge-openclaw-openclaw-${targetPrNumber}\nmode: autonomous\njob_intent: pr_repair\nallowed_actions: [comment, label, fix, raise_pr]\nblocked_actions: [merge, close]\nrequire_human_for: [merge]\ncanonical: [#${targetPrNumber}]\ncandidates: [#${targetPrNumber}]\ncluster_refs: [#${targetPrNumber}]\nallow_fix_pr: true\nallow_merge: false\nallow_post_merge_close: false\nrequire_fix_before_close: true\nsecurity_policy: central_security_only\nsecurity_sensitive: false\ntarget_branch: clawsweeper/automerge-openclaw-openclaw-${targetPrNumber}\nsource: pr_automerge\nrepair_mode: automerge\nexpected_head_sha: ${headSha}\n---\n\nRepair the opted-in pull request and preserve contributor credit.\n`,
  );
  return jobPath;
}

function runCli(candidateRoot, commandArgs, baseEnv, token, artifacts, label) {
  const child = runCliRaw(candidateRoot, commandArgs, baseEnv, token, artifacts, label);
  if (child.status !== 0) {
    throw new Error(
      `${label} failed with exit ${child.status}\n${child.stderr ?? ""}\n${child.stdout ?? ""}`,
    );
  }
}

function runCliExpectFailure(candidateRoot, commandArgs, baseEnv, token, artifacts, label) {
  const child = runCliRaw(candidateRoot, commandArgs, baseEnv, token, artifacts, label);
  if (child.status === 0) throw new Error(`${label} unexpectedly succeeded`);
  return child;
}

function runCliRaw(candidateRoot, commandArgs, baseEnv, token, artifacts, label) {
  const child = spawnSync(process.execPath, commandArgs, {
    cwd: candidateRoot,
    env: { ...baseEnv, GH_TOKEN: token },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(artifacts, `${label}.stdout.log`), child.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, `${label}.stderr.log`), child.stderr ?? "");
  if (child.error) throw child.error;
  return child;
}

function latestRunDir(candidateRoot) {
  const runsRoot = path.join(candidateRoot, ".clawsweeper-repair", "runs");
  const entries = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name));
  assert.equal(entries.length, 1, "planning must produce exactly one transfer run directory");
  return entries[0];
}

function currentRef(remote, ref) {
  return execFileSync("/usr/bin/git", ["--git-dir", remote, "rev-parse", `refs/heads/${ref}`], {
    encoding: "utf8",
  }).trim();
}

function git(args, cwd = process.cwd()) {
  execFileSync("/usr/bin/git", args, { cwd, stdio: "ignore" });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
