import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const liveWorkflow = readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8").replace(
  /\r\n/g,
  "\n",
);
const documentation = readFileSync("docs/target-dispatcher.md", "utf8").replace(/\r\n/g, "\n");
const templateMatch = documentation.match(/```yaml\n(name: ClawSweeper Dispatch[\s\S]*?)\n```/);

assert.ok(templateMatch, "target dispatcher workflow template is missing");
const documentedWorkflow = `${templateMatch[1]}\n`;

type WorkflowStep = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};

function dispatchSteps(source: string): WorkflowStep[] {
  const workflow = parse(source) as {
    jobs?: { dispatch?: { steps?: WorkflowStep[] } };
  };
  return workflow.jobs?.dispatch?.steps ?? [];
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

test("documented target dispatcher template matches the live workflow", () => {
  assert.equal(documentedWorkflow, liveWorkflow);
});

test("target dispatcher acknowledges non-draft PR receipts before review dispatch", () => {
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const steps = dispatchSteps(source);
    const tokenIndex = steps.findIndex(
      (step) => step.name === "Create target PR acknowledgement token",
    );
    const acknowledgementIndex = steps.findIndex(
      (step) => step.name === "Acknowledge received pull request",
    );
    const dispatchIndex = steps.findIndex(
      (step) => step.name === "Dispatch exact ClawSweeper review",
    );
    assert.ok(tokenIndex >= 0 && tokenIndex < acknowledgementIndex);
    assert.ok(acknowledgementIndex < dispatchIndex);

    const token = namedStep(steps, "Create target PR acknowledgement token");
    const acknowledgement = namedStep(steps, "Acknowledge received pull request");
    const expectedGate = [
      "${{",
      "github.event_name == 'pull_request_target' &&",
      "(",
      "github.event.action == 'ready_for_review' ||",
      "(github.event.action == 'opened' && github.event.pull_request.draft == false)",
      ") &&",
      "env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true'",
      "}}",
    ].join(" ");

    assert.equal(normalizeWhitespace(token.if), expectedGate);
    assert.equal(normalizeWhitespace(acknowledgement.if), expectedGate);
    assert.equal(token["continue-on-error"], true);
    assert.equal(acknowledgement["continue-on-error"], true);
    assert.deepEqual(
      Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-")),
      ["permission-issues"],
    );
    assert.equal(token.with?.["permission-issues"], "write");
    assert.equal(acknowledgement.env?.ACK_TOKEN, "${{ steps.pr_ack_token.outputs.token }}");

    const run = acknowledgement.run ?? "";
    assert.match(run, /issues\/\$ITEM_NUMBER\/comments\?per_page=100/);
    assert.match(run, /--arg marker_prefix "clawsweeper-pr-ack:"/);
    assert.match(run, /--arg marker_suffix " item=\$ITEM_NUMBER -->"/);
    assert.match(run, /"<!-- clawsweeper-pr-ack:\$SOURCE_ACTION item=\$ITEM_NUMBER -->"/);
    assert.match(
      run,
      /"Pull request received\. I will update this pull request when review starts\."/,
    );
    assert.match(run, /issues\/\$ITEM_NUMBER\/comments"\s*\\\s*--method POST/);
  }
});
