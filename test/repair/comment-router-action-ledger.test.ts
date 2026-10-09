import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { readText } from "../helpers.ts";

function routerWorkflowSteps() {
  const workflow = parseYaml(readText(".github/workflows/repair-comment-router.yml")) as {
    jobs: Record<
      string,
      {
        steps?: Array<{
          name?: string;
          if?: string;
          "continue-on-error"?: boolean;
          run?: string;
          env?: Record<string, string>;
        }>;
      }
    >;
  };
  return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}

test("scheduled Endor enrolment routes only the test repository into automerge without recursion", () => {
  const steps = routerWorkflowSteps();
  const schedule = steps.find((step) => step.name === "Schedule Endor test repository automerge");
  const intake = steps.find((step) => step.name === "Enrol Endor remediation PRs");
  assert.ok(schedule?.run);
  assert.ok(intake);
  assert.equal(
    schedule.if,
    "${{ github.event_name == 'schedule' && vars.CLAWSWEEPER_COMMENT_ROUTER_EXECUTE == '1' && steps.target.outputs.target_repo != 'openclaw/endor-clawsweeper-e2e' }}",
  );
  assert.equal(schedule.env?.GH_TOKEN, "${{ steps.dispatch-token.outputs.token }}");
  assert.equal(schedule["continue-on-error"], true);
  const args = execFileSync(
    "bash",
    ["-eu", "-c", `gh() { printf '%s\\n' "$@"; }\n${schedule.run}`],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_REF_NAME: "main",
      },
    },
  )
    .trim()
    .split("\n");
  assert.deepEqual(args, [
    "workflow",
    "run",
    "repair-comment-router.yml",
    "--repo",
    "openclaw/clawsweeper",
    "--ref",
    "main",
    "-f",
    "execute=true",
    "-f",
    "target_repo=openclaw/endor-clawsweeper-e2e",
  ]);
  assert.equal(
    intake.if,
    "${{ steps.target.outputs.target_repo == 'openclaw/endor-clawsweeper-e2e' && ((github.event_name == 'schedule' && vars.CLAWSWEEPER_COMMENT_ROUTER_EXECUTE == '1') || (github.event_name == 'workflow_dispatch' && inputs.execute)) }}",
  );
  assert.equal(
    intake.run,
    'node dist/repair/endor-automerge-intake.js --repo "$TARGET_REPO" --execute',
  );
  assert.equal(intake["continue-on-error"], true);
});

test("comment router isolates public target reads from its GitHub App mutation identity", () => {
  const steps = routerWorkflowSteps();
  assert.deepEqual(
    steps
      .filter((step) => step.env?.GH_TOKEN === "${{ steps.app_token.outputs.token }}")
      .map((step) => step.name),
    [
      "Enrol Endor remediation PRs",
      "Route ClawSweeper comments",
      "Reconcile explicitly requested behavioral proof",
      "Retry waiting repair dispatches",
    ],
  );
  assert.deepEqual(
    steps
      .filter((step) => step.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN !== undefined)
      .map((step) => [step.name, step.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN]),
    [
      ["Route ClawSweeper comments", "${{ github.token }}"],
      ["Retry waiting repair dispatches", "${{ github.token }}"],
    ],
  );
});

test("re-review recovery signs with the Worker-accepted webhook secret", () => {
  assert.deepEqual(
    routerWorkflowSteps()
      .filter(
        (step) =>
          step.env?.CLAWSWEEPER_WEBHOOK_SECRET === "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}",
      )
      .map((step) => step.name),
    [
      "Route ClawSweeper comments",
      "Reconcile explicitly requested behavioral proof",
      "Commit comment router ledger",
      "Retry waiting repair dispatches",
      "Commit comment router retry ledger",
      "Publish immutable command action ledger",
    ],
  );
});

// Each router write goes through runGitHub*Mutation, which records the action-ledger receipt.
test("comment router never calls a GitHub writer that skips its action receipt", () => {
  assert.doesNotMatch(readText("src/repair/comment-router.ts"), /\bghText\(|\bghBestEffort/);
});

// A workflow_dispatch fallback gives a failed review follow-up explicit retry authority.
test("comment router never falls back to a manual review workflow dispatch", () => {
  assert.doesNotMatch(
    readText("src/repair/comment-router.ts"),
    /actions\/workflows\/[^\n]*\/dispatches/,
  );
});

// Router write-order guards (moved from comment-router-core.test.ts).
// The router reads GitHub, decides and then writes. These guards keep each live re-check
// ahead of its write. Remove a guard when a loopback behavior test covers the same order.
const routerSource = readText("src/repair/comment-router.ts");

// Return the text of one top-level router function.
function routerFunction(name: string): string {
  const start = routerSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = routerSource.indexOf("\nfunction ", start + 1);
  return routerSource.slice(start, end < 0 ? undefined : end);
}

function assertBefore(body: string, first: string, second: string) {
  const firstIndex = body.indexOf(first);
  assert.ok(firstIndex >= 0, `missing ${first}`);
  assert.ok(firstIndex < body.indexOf(second), `${first} must come before ${second}`);
}

test("autofix and automerge commands coordinate the review before they write labels or jobs", () => {
  // Without this re-check, a label sweep can start a second review on the same head.
  assertBefore(
    routerFunction("executeCommand"),
    "repairLoopPreMutationReviewDispatchDecision(command)",
    "ensureRepairLoopLabel(command, modeLabel)",
  );
});

test("automerge re-reads the final PR snapshot before the merge write", () => {
  // The merge must use live labels, head and review, not the classification snapshot.
  assertBefore(
    routerFunction("executeAutomerge"),
    "finalAutomergeSnapshot(command)",
    '"pull_request_merge"',
  );
});

test("trusted autoclose runs the live close gate before each close write", () => {
  // A trusted close marker can be stale; the live gate blocks a close after source drift.
  assertBefore(
    routerFunction("executeAutoclose"),
    "liveTrustedCloseBlockReason(command, liveTarget)",
    "closeIssueOrPullRequest(",
  );
  assert.match(routerFunction("classifyAutoclose"), /trustedCloseBlockReason\(\{/);
});

test("merge commands remove repair-loop labels only after a successful merge", () => {
  // A failed merge must keep the pause and mode labels on the PR.
  assert.doesNotMatch(routerFunction("executeAutomerge"), /applyRemoveLabelActions/);
  const execute = routerFunction("executeCommand");
  const mergeBlock = execute.slice(
    execute.indexOf("const merge = executeAutomerge(command)"),
    execute.indexOf('if (merge.status === "executed")'),
  );
  assert.ok(mergeBlock.length > 0);
  assert.doesNotMatch(mergeBlock, /applyRemoveLabelActions/);
  assert.match(
    execute,
    /if \(merge\.status === "executed"\) \{\s*applyRemoveLabelActions\(command\);\s*\}/,
  );
});
