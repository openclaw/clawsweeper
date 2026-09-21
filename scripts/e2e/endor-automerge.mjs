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
import { issueSourceRevisionSha256 } from "../../dist/repair/issue-source-guard.js";

const candidate = path.resolve(import.meta.dirname, "../..");
const repo = "openclaw/endor-clawsweeper-e2e";
const root = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "endor-automerge-proof-")),
);
const results = [];
try {
  for (const verdict of ["pass", "needs-human", "stale-pass", "late-manual-hold"]) {
    const workspace = path.join(root, verdict);
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
    const run = (script, args) => {
      const result = spawnSync(process.execPath, [path.join(runtime, script), ...args], {
        cwd: runtime,
        env: { ...env, CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `step-${++invocation}` },
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
    assert.deepEqual(intake(), [{ number: 42, status: "enrolled" }]);
    assert.deepEqual(state().pr.labels, ["clawsweeper:automerge"]);
    const route = () =>
      run("dist/repair/comment-router.js", ["--repo", repo, "--max-comments", "20", "--execute"]);
    route();
    assert.equal(state().dispatches.length, 1, "the new label must request review automatically");
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
    if (verdict === "late-manual-hold") {
      const held = state();
      // The seventh post-verdict PR read is the final snapshot, after source freshness checks.
      held.finalManualHold = { viewReads: 0, triggerViewRead: 7, applied: false };
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
            (action) => action.action === "label" && action.label === "clawsweeper:human-review",
          ),
        ),
        JSON.stringify(commands),
      );
    }
    const after = state();
    const finalMain = currentMain();
    if (verdict === "late-manual-hold") {
      assert.equal(after.finalManualHold.applied, true);
      assert.ok(after.pr.labels.includes("clawsweeper:manual-only"));
      const merge = commands
        .flatMap((command) => command.actions)
        .find((action) => action.action === "merge");
      assert.equal(merge?.status, "blocked");
      assert.equal(merge?.reason, "PR is marked manual-only; merge is disabled");
      const beforeHold = after.calls.slice(0, after.finalManualHold.appliedAtCall - 1);
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
        assert.equal(after.pr.labels.includes("clawsweeper:human-review"), true);
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
      ...(verdict === "late-manual-hold" ? { finalManualHold: after.finalManualHold } : {}),
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
