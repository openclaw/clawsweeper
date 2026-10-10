import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addCanonicalNeedsHumanVerdict,
  addExactHeadVerdict,
  createCandidateRuntime,
  createCommandBin,
  initialGitHubState,
} from "../../test/e2e/automerge/run.mjs";
import { createTargetFixture } from "../../test/e2e/automerge/target-fixtures.mjs";
import {
  AUTOFIX_LABEL,
  AUTOMERGE_BLOCKING_LABEL_NAMES,
  AUTOMERGE_LABEL,
  HUMAN_REVIEW_LABEL,
} from "../../dist/repair/exact-review-guard-labels.js";
import { issueSourceRevisionSha256 } from "../../dist/repair/issue-source-guard.js";

const candidate = path.resolve(import.meta.dirname, "../..");
const repo = "openclaw/endor-clawsweeper-e2e";
const root = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "endor-automerge-proof-")),
);
const results = [];
const lateHolds = AUTOMERGE_BLOCKING_LABEL_NAMES;
const scenarios = [
  "pass",
  "head-continuation",
  "needs-human",
  "stale-pass",
  ...lateHolds,
  "autofix-continuation",
];
const selectedScenarios = process.argv.slice(2);
assert.ok(
  selectedScenarios.every((scenario) => scenarios.includes(scenario)),
  `unknown scenario; choose from ${scenarios.join(", ")}`,
);
try {
  for (const verdict of selectedScenarios.length ? selectedScenarios : scenarios) {
    const lateHold = lateHolds.includes(verdict) ? verdict : null;
    const workspace = path.join(root, verdict.replace(/[^a-z0-9-]/g, "-"));
    fs.mkdirSync(workspace);
    const runtime = createCandidateRuntime(workspace, candidate);
    const fixture = createTargetFixture(workspace, { fixture: "tiny" });
    const currentMain = () =>
      execFileSync("/usr/bin/git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim();
    const initialMain = currentMain();
    const statePath = path.join(workspace, "github-state.json");
    const initial = initialGitHubState(fixture);
    initial.repo = repo;
    Object.assign(initial.pr, {
      author: "endor-labs-pro[bot]",
      authorId: 179191674,
      authorType: "Bot",
      labels: [],
    });
    const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
    const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
    save(initial);
    const bin = createCommandBin(workspace);
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: workspace,
      GH_TOKEN: "post-token",
      CLAWSWEEPER_E2E_GITHUB_STATE: statePath,
      CLAWSWEEPER_E2E_REAL_COREPACK: execFileSync("which", ["corepack"], {
        encoding: "utf8",
      }).trim(),
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOW_FIX_PR: "1",
      CLAWSWEEPER_ALLOW_MERGE: "1",
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: path.join(workspace, "events"),
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: path.join(workspace, "event-output"),
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "Endor automerge proof",
      GITHUB_JOB: "proof",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_STARTED_AT: new Date().toISOString(),
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: new Date().toISOString().slice(0, 10),
    };
    fs.mkdirSync(env.CLAWSWEEPER_ACTION_LEDGER_ROOT);
    fs.mkdirSync(env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT);
    let invocation = 0;
    const run = (script, args, extraEnv = {}) => {
      const result = spawnSync(process.execPath, [path.join(runtime, script), ...args], {
        cwd: runtime,
        env: { ...env, ...extraEnv, CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `step-${++invocation}` },
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    const intake = () =>
      JSON.parse(run("dist/repair/endor-automerge-intake.js", ["--repo", repo, "--execute"]));
    const admission = (decision) =>
      run("dist/repair/workflow-utils.js", ["exact-review-admission"], {
        TARGET_REPO: repo,
        ITEM_NUMBER: "42",
        CLAIM_TARGET_BRANCH: "main",
        CLAIM_DECISION: JSON.stringify(decision),
      });
    assert.match(admission({ sourceAction: "opened" }), /^scheduled_semantic_noop=true$/m);
    assert.deepEqual(
      state().comments,
      initial.comments,
      "early admission must not publish a verdict or hold",
    );
    assert.deepEqual(state().pr.labels, []);
    assert.deepEqual(state().dispatches, []);
    assert.ok(
      state().calls.every((call) => !call.args.includes("POST") && !call.args.includes("PATCH")),
    );
    assert.deepEqual(intake(), [{ number: 42, status: "enrolled" }]);
    assert.deepEqual(state().pr.labels, [AUTOMERGE_LABEL]);
    if (verdict === "autofix-continuation") {
      const opted = state();
      opted.pr.labels = [AUTOFIX_LABEL];
      save(opted);
    }
    const route = () =>
      run(
        "dist/repair/comment-router.js",
        ["--repo", repo, "--max-comments", "20", "--execute"],
        verdict === "head-continuation" ? { CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS: "0" } : {},
      );
    route();
    assert.equal(state().dispatches.length, 1, "the new label must request review automatically");
    const enrolled = state();
    for (const sourceAction of ["synchronize", "scheduled_hot_intake"]) {
      assert.match(admission({ sourceAction }), /^scheduled_semantic_noop=true$/m);
    }
    assert.deepEqual(state().comments, enrolled.comments, "ordinary reviews must not publish");
    assert.deepEqual(state().pr, enrolled.pr, "ordinary reviews must not alter the enrolled PR");
    assert.deepEqual(state().dispatches, enrolled.dispatches, "no competing review dispatch");
    assert.ok(
      state()
        .calls.slice(enrolled.calls.length)
        .every((call) => !call.args.includes("POST") && !call.args.includes("PATCH")),
    );
    if (verdict === "autofix-continuation") {
      const held = state();
      held.finalLabelHold = {
        viewReads: 0,
        triggerViewRead: 1,
        afterSnapshot: true,
        applied: false,
        label: "security",
      };
      const priorCalls = held.calls.length;
      save(held);
      route();
      const after = state();
      assert.equal(after.finalLabelHold.applied, true);
      assert.deepEqual(after.pr.labels, [AUTOFIX_LABEL, "security"]);
      assert.deepEqual(after.dispatches, enrolled.dispatches);
      assert.deepEqual(after.comments, enrolled.comments);
      assert.equal(after.pr.mergedAt, null);
      assert.ok(
        after.calls
          .slice(priorCalls)
          .every(
            ({ args }) =>
              !args.some((arg) => ["POST", "PATCH", "DELETE"].includes(arg)) &&
              !(args[0] === "issue" && args[1] === "edit") &&
              !(args[0] === "pr" && ["comment", "edit", "merge"].includes(args[1])) &&
              !(args[0] === "workflow" && args[1] === "run"),
          ),
        "held autofix continuation remains read-only",
      );
      results.push({ verdict, reviewRequested: true, lateHold: "read-only", mergeCalls: 0 });
      continue;
    }
    if (verdict === "head-continuation") {
      const originalBody = state().pr.body;
      const waiting = state();
      waiting.pendingCheckReads = 100;
      save(waiting);
      let currentHead = fixture.headSha;
      const reviewCurrent = () =>
        addExactHeadVerdict(
          statePath,
          currentHead,
          issueSourceRevisionSha256(state().pr, state().comments),
        );
      reviewCurrent();
      route();
      assert.equal(state().dispatches.length, 1, "reuse a completed current-source review");
      const first = state().dispatches[0].client_payload;
      assert.match(first.source_delivery_id, /^endor-review-revision:[0-9a-f]{64}$/);
      for (const body of [`${originalBody}\n\nContributor clarification.`, originalBody]) {
        const edited = state();
        const priorDispatches = edited.dispatches.length;
        edited.pr.body = body;
        edited.pr.updatedAt = new Date().toISOString();
        save(edited);
        route();
        const dispatch = state().dispatches.at(-1).client_payload;
        assert.equal(
          state().dispatches.length,
          priorDispatches + 1,
          "review changed or restored source",
        );
        assert.ok(dispatch.status_comment_id);
        route();
        const repeat = state().dispatches.at(-1).client_payload;
        assert.equal(state().dispatches.length, priorDispatches + 2);
        assert.equal(repeat.source_delivery_id, dispatch.source_delivery_id);
        assert.notEqual(
          repeat.dispatch_key,
          dispatch.dispatch_key,
          "transport receipt stays per attempt",
        );
        assert.equal(state().pr.mergedAt, null);
        reviewCurrent();
        route();
        assert.equal(
          state().dispatches.length,
          priorDispatches + 2,
          "reuse the new completed review",
        );
      }
      assert.equal(
        state().dispatches.at(-1).client_payload.source_delivery_id,
        first.source_delivery_id,
      );

      const relative = "src/external-push.txt";
      fs.mkdirSync(path.dirname(path.join(fixture.seed, relative)), { recursive: true });
      fs.writeFileSync(path.join(fixture.seed, relative), "external contributor push\n");
      for (const args of [
        ["add", relative],
        ["commit", "-m", "test: external push"],
        ["push", "origin", fixture.headRef],
      ]) {
        execFileSync("/usr/bin/git", args, { cwd: fixture.seed });
      }
      currentHead = execFileSync(
        "/usr/bin/git",
        ["--git-dir", fixture.remote, "rev-parse", `refs/heads/${fixture.headRef}`],
        { encoding: "utf8" },
      ).trim();
      execFileSync("/usr/bin/git", [
        "--git-dir",
        fixture.remote,
        "update-ref",
        "refs/pull/42/head",
        currentHead,
      ]);
      assert.notEqual(currentHead, fixture.headSha);
      const pushed = state();
      pushed.pr.updatedAt = new Date().toISOString();
      pushed.pr.files.push(relative);
      save(pushed);
      for (const { label, mergeStateStatus, late } of lateHolds.flatMap((label) =>
        ["CLEAN", "DIRTY"].flatMap((mergeStateStatus) =>
          [false, true].map((late) => ({ label, mergeStateStatus, late })),
        ),
      )) {
        const held = state();
        held.pr.labels = [AUTOMERGE_LABEL];
        held.pr.mergeStateStatus = mergeStateStatus;
        if (late)
          held.finalLabelHold = {
            viewReads: 0,
            triggerViewRead: 1,
            afterSnapshot: true,
            applied: false,
            label,
          };
        else {
          delete held.finalLabelHold;
          held.pr.labels.push(label);
        }
        const priorCalls = held.calls.length;
        const priorDispatches = held.dispatches.length;
        save(held);
        route();
        assert.equal(
          state().dispatches.length,
          priorDispatches,
          `${label} blocks ${mergeStateStatus} continuation (${late ? "after" : "before"} classification)`,
        );
        assert.equal(state().pr.mergedAt, null);
        if (late) assert.equal(state().finalLabelHold.applied, true);
        assert.ok(
          state()
            .calls.slice(priorCalls)
            .every(
              ({ args }) =>
                !args.some((arg) => ["POST", "PATCH", "DELETE"].includes(arg)) &&
                !(args[0] === "issue" && args[1] === "edit") &&
                !(args[0] === "pr" && ["comment", "edit", "merge"].includes(args[1])) &&
                !(args[0] === "workflow" && args[1] === "run"),
            ),
          "held continuation remains read-only",
        );
      }
      const resumed = state();
      resumed.pr.labels = [AUTOMERGE_LABEL];
      resumed.pr.mergeStateStatus = "CLEAN";
      delete resumed.finalLabelHold;
      save(resumed);
      route();
      assert.equal(state().dispatches.length, 6, "review the pushed head");
      const continuation = state().dispatches.at(-1).client_payload;
      assert.match(continuation.command_status_marker, new RegExp(`:${currentHead} -->$`));
      assert.notEqual(continuation.source_delivery_id, first.source_delivery_id);
      assert.equal(state().pr.mergedAt, null, "old verdict cannot merge a new head");
      const ready = state();
      ready.pendingCheckReads = 0;
      save(ready);
      reviewCurrent();
      route();
      const after = state();
      const merges = after.calls.filter(({ args }) => args[0] === "pr" && args[1] === "merge");
      assert.equal(merges.length, 1);
      assert.ok(merges[0].args.includes(currentHead));
      assert.equal(currentMain(), after.pr.mergeCommitSha);
      route();
      assert.equal(
        state().calls.filter(({ args }) => args[0] === "pr" && args[1] === "merge").length,
        1,
      );
      results.push({
        verdict,
        dispatches: after.dispatches.length,
        mergeCalls: merges.length,
        currentHead,
        lateHold: "read-only",
        continuationHolds: lateHolds.length * 4,
        replay: "closed PR excluded",
      });
      continue;
    }
    const dispatch = state().dispatches[0].client_payload;
    assert.ok(dispatch.command_status_marker, "existing label sweep owns the review");
    assert.match(
      admission({
        sourceAction: "internal",
        commandStatusMarker: dispatch.command_status_marker,
      }),
      /^proceed=true$/m,
    );
    assert.equal(state().pr.mergedAt, null, "no merge before the review result");
    assert.deepEqual(intake(), [{ number: 42, status: "skipped" }]);
    const current = state();
    const sourceRevision = issueSourceRevisionSha256(current.pr, current.comments);
    if (verdict === "needs-human") addCanonicalNeedsHumanVerdict(statePath, fixture.headSha);
    else {
      addExactHeadVerdict(
        statePath,
        verdict === "stale-pass" ? "0".repeat(40) : fixture.headSha,
        sourceRevision,
      );
    }
    if (lateHold) {
      const held = state();
      // The seventh post-verdict PR read is the final snapshot, after source freshness checks.
      held.finalLabelHold = { viewReads: 0, triggerViewRead: 7, applied: false, label: lateHold };
      save(held);
    }
    route();
    const report = JSON.parse(
      fs.readFileSync(path.join(runtime, "results/comment-router-latest.json"), "utf8"),
    );
    const commands = report.commands.filter((value) => Number(value.issue_number) === 42);
    assert.ok(commands.length, `router must process the enrolled PR: ${JSON.stringify(report)}`);
    if (verdict === "needs-human") {
      assert.ok(
        commands.some((command) =>
          command.actions.some(
            (action) => action.action === "label" && action.label === HUMAN_REVIEW_LABEL,
          ),
        ),
        JSON.stringify(commands),
      );
    }
    const after = state();
    const finalMain = currentMain();
    if (lateHold) {
      assert.equal(after.finalLabelHold.applied, true);
      assert.ok(after.pr.labels.includes(lateHold));
      const merge = commands
        .flatMap((command) => command.actions)
        .find((action) => action.action === "merge");
      assert.equal(merge?.status, "blocked");
      assert.match(
        merge?.reason ?? "",
        /manual-only|manual merge|autofix mode|human review|protected or paused repair label/,
      );
      const beforeHold = after.calls.slice(0, after.finalLabelHold.appliedAtCall - 1);
      assert.deepEqual(
        beforeHold.slice(-2).map((call) => call.args.slice(0, 2)),
        [
          ["pr", "view"],
          ["api", `repos/${repo}/issues/42/comments?per_page=100`],
        ],
      );
    }
    const mergeCalls = (value) =>
      value.calls.filter((call) => call.args[0] === "pr" && call.args[1] === "merge");
    if (verdict === "pass") {
      assert.equal(after.pr.state, "closed");
      assert.ok(after.pr.mergedAt, JSON.stringify(commands));
      assert.equal(mergeCalls(after).length, 1);
      assert.ok(mergeCalls(after)[0].args.includes(fixture.headSha));
      assert.equal(finalMain, after.pr.mergeCommitSha);
      assert.notEqual(finalMain, initialMain);
    } else {
      assert.equal(finalMain, initialMain);
      assert.equal(after.pr.state, "open");
      assert.equal(after.pr.mergedAt, null);
      assert.equal(mergeCalls(after).length, 0);
      if (verdict === "needs-human")
        assert.equal(after.pr.labels.includes(HUMAN_REVIEW_LABEL), true);
    }
    assert.deepEqual(
      after.workflowDispatches,
      [],
      "review-only outcomes must not dispatch a repair",
    );
    route();
    assert.equal(
      mergeCalls(state()).length,
      mergeCalls(after).length,
      "replay must not merge again",
    );
    assert.deepEqual(intake(), verdict === "pass" ? [] : [{ number: 42, status: "skipped" }]);
    results.push({
      verdict,
      reviewRequested: true,
      prState: after.pr.state,
      initialMain,
      finalMain,
      mergeCommit: after.pr.mergeCommitSha,
      mergeCalls: mergeCalls(after).length,
      ...(lateHold ? { finalLabelHold: after.finalLabelHold } : {}),
      replay: verdict === "pass" ? "closed PR excluded" : "skipped",
      globalMergeEnabled: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        results,
        limits:
          "Real intake/router CLIs, persisted state and local Git merge; synthetic GitHub and review results, no live Endor scan or model repair.",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
