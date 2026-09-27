import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the compiled CLI function without starting unrelated comment discovery.
function reviewDispatch(status: number) {
  const source = readFileSync("dist/repair/comment-router.js", "utf8");
  const start = source.indexOf("function dispatchClawSweeperReview(");
  const end = source.indexOf("function enqueueClawSweeperReReview(", start);
  assert.ok(start >= 0 && end > start);
  const mutations: unknown[][] = [];
  const dispatch = runInNewContext(`(${source.slice(start, end)})`, {
    reviewRepo: "openclaw/clawsweeper",
    reviewWorkflow: "sweep.yml",
    dispatchReceiptKey: () => "router-fixture",
    claimedDispatchState: () => null,
    findExistingCommandStatusComment: () => null,
    adaptiveReviewBudgetForPullRequest: () => ({
      codexTimeoutMs: 600_000,
      mediaProofTimeoutMs: 30_000,
    }),
    commandStatusMarker: () => "fixture-marker",
    freeformReviewPrompt: () => "Preserve the requested scope",
    dispatchTokenEnv: () => ({}),
    runGitHubSpawnMutation: (...args: unknown[]) => {
      mutations.push(args);
      return { status, stderr: status ? "dispatch unavailable" : "", stdout: "" };
    },
  });
  return { dispatch, mutations };
}

const command = {
  intent: "autofix",
  repo: "openclaw/fixture",
  issue_number: 123,
  target: { kind: "pull_request" },
};

test("failed review follow-up does not acquire explicit retry authority through a manual fallback", () => {
  const { dispatch, mutations } = reviewDispatch(1);
  assert.throws(() => dispatch(command), /repository_dispatch=dispatch unavailable/);
  assert.equal(mutations.length, 1);
  const metadata = mutations[0][2] as { event: string };
  assert.equal(metadata.event, "repository_dispatch");
});

test("successful review follow-up retains queue dispatch options", () => {
  const { dispatch, mutations } = reviewDispatch(0);
  assert.equal(dispatch(command).event, "repository_dispatch");
  assert.equal(mutations.length, 1);
  const options = mutations[0][4] as { input: string };
  const payload = JSON.parse(options.input).client_payload;
  assert.equal(payload.dispatch_key, "router-fixture");
  assert.equal(payload.additional_prompt, "Preserve the requested scope");
  assert.equal(payload.review_options.codex_timeout_ms, 600_000);
  assert.equal(payload.command_status_marker, "fixture-marker");
});
