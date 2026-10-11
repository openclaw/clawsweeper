import assert from "node:assert/strict";
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

test("comment router retains review commands without repair automation", () => {
  const source = readText(".github/workflows/repair-comment-router.yml");
  assert.doesNotMatch(
    source,
    /endor|command-proof|dispatch_repair|waiting-repair|ALLOW_MERGE|execution_runner|--runner|--wait-for-capacity/i,
  );
  const steps = routerWorkflowSteps();
  assert.match(
    steps.find((step) => step.name === "Route ClawSweeper comments")?.run ?? "",
    /pnpm run repair:comment-router/,
  );
  assert.ok(steps.find((step) => step.name === "Commit comment router ledger"));
  assert.ok(steps.find((step) => step.name === "Publish immutable command action ledger"));
});

test("comment router isolates public target reads from its GitHub App mutation identity", () => {
  const steps = routerWorkflowSteps();
  assert.deepEqual(
    steps
      .filter((step) => step.env?.GH_TOKEN === "${{ steps.app_token.outputs.token }}")
      .map((step) => step.name),
    ["Route ClawSweeper comments"],
  );
  assert.deepEqual(
    steps
      .filter((step) => step.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN !== undefined)
      .map((step) => [step.name, step.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN]),
    [["Route ClawSweeper comments", "${{ github.token }}"]],
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
      "Commit comment router ledger",
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
