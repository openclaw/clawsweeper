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

const candidate = path.resolve(import.meta.dirname, "../..");
const repo = "openclaw/endor-clawsweeper-e2e";
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "endor-autofix-proof-")));
const results = [];
try {
  for (const verdict of ["pass", "needs-human"]) {
    const workspace = path.join(root, verdict);
    fs.mkdirSync(workspace);
    const runtime = createCandidateRuntime(workspace, candidate);
    const fixture = createTargetFixture(workspace, { fixture: "tiny" });
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
      GITHUB_WORKFLOW: "Endor autofix proof",
      GITHUB_JOB: "proof",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_STARTED_AT: new Date().toISOString(),
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: new Date().toISOString().slice(0, 10),
    };
    fs.mkdirSync(env.CLAWSWEEPER_ACTION_LEDGER_ROOT);
    fs.mkdirSync(env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT);
    const run = (script, args) => {
      const result = spawnSync(process.execPath, [path.join(runtime, script), ...args], {
        cwd: runtime,
        env,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    const intake = () =>
      JSON.parse(run("dist/repair/endor-autofix-intake.js", ["--repo", repo, "--execute"]));
    assert.deepEqual(intake(), [{ number: 42, status: "enrolled" }]);
    assert.deepEqual(state().pr.labels, ["clawsweeper:autofix"]);
    if (verdict === "pass") addExactHeadVerdict(statePath, fixture.headSha);
    else addCanonicalNeedsHumanVerdict(statePath, fixture.headSha);
    run("dist/repair/comment-router.js", ["--repo", repo, "--max-comments", "20", "--execute"]);
    const report = JSON.parse(
      fs.readFileSync(path.join(runtime, "results/comment-router-latest.json"), "utf8"),
    );
    const commands = report.commands.filter((value) => Number(value.issue_number) === 42);
    assert.ok(commands.length, `router must process the enrolled PR: ${JSON.stringify(report)}`);
    const completed = commands.some((command) => command.autofix_complete === true);
    if (verdict === "pass") assert.equal(completed, true, JSON.stringify(commands));
    else {
      assert.equal(completed, false);
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
    if (verdict === "pass") assert.equal(after.pr.labels.includes("clawsweeper:autofix"), false);
    else assert.equal(after.pr.labels.includes("clawsweeper:human-review"), true);
    assert.equal(after.pr.state, "open");
    assert.equal(after.pr.mergedAt, null);
    assert.deepEqual(
      after.workflowDispatches,
      [],
      "review-only outcomes must not dispatch a repair",
    );
    assert.equal(
      after.calls.some((call) => call.args[0] === "pr" && call.args[1] === "merge"),
      false,
    );
    after.pr.labels = [];
    save(after);
    assert.deepEqual(intake(), [{ number: 42, status: "skipped" }]);
    results.push({
      verdict,
      autofixComplete: completed,
      prOpen: true,
      mergeCalls: 0,
      replay: "skipped",
      globalMergeEnabled: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        results,
        limits:
          "Real intake/router CLIs and persisted state; synthetic GitHub, no Endor scan or model repair.",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
