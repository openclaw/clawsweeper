import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { parse } from "yaml";

const liveWorkflow = readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8").replace(
  /\r\n/g,
  "\n",
);
const documentation = readFileSync("docs/target-dispatcher.md", "utf8").replace(/\r\n/g, "\n");
const dispatcherTemplates = new MarkdownIt()
  .parse(documentation, {})
  .filter(
    (token) =>
      token.type === "fence" &&
      token.markup === "```" &&
      token.info.trim() === "yaml" &&
      token.content.startsWith("name: ClawSweeper Dispatch\n"),
  );

assert.equal(dispatcherTemplates.length, 1, "expected one canonical target dispatcher template");
const documentedWorkflow = dispatcherTemplates[0]!.content;

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

function workflowJobs(source: string) {
  return (
    parse(source) as {
      jobs?: Record<
        string,
        {
          if?: string;
          needs?: string;
          permissions?: Record<string, string>;
          steps?: WorkflowStep[];
          uses?: string;
          with?: Record<string, string>;
        }
      >;
    }
  ).jobs;
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

test("copied dispatchers admit the target before any token or acknowledgement", () => {
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const jobs = workflowJobs(source);
    assert.equal(
      jobs?.["hosted-target-admission"]?.uses,
      "openclaw/clawsweeper/.github/workflows/hosted-target-admission.yml@main",
    );
    assert.deepEqual(jobs?.["hosted-target-admission"]?.with, {
      target_repo: "${{ github.repository }}",
    });
    const rejected = jobs?.["reject-hosted-target"];
    assert.equal(
      rejected?.if,
      "${{ always() && needs.hosted-target-admission.outputs.outcome != 'public' }}",
    );
    assert.equal(rejected?.needs, "hosted-target-admission");
    assert.deepEqual(rejected?.permissions, {});
    assert.match(rejected?.steps?.[0]?.run ?? "", /run the review locally/);
    assert.match(rejected?.steps?.[0]?.run ?? "", /Retry the workflow later/);
    assert.doesNotMatch(
      rejected?.steps?.[0]?.run ?? "",
      /gh api|GITHUB_TOKEN|github\.token|create-github-app-token|CLAWSWEEPER_APP/,
    );
    assert.equal(jobs?.dispatch?.needs, "hosted-target-admission");
    assert.match(
      jobs?.dispatch?.if ?? "",
      /needs\.hosted-target-admission\.outputs\.outcome == 'public'/,
    );
  }
});

test("copied dispatcher prefilters every canonical maintainer command form", () => {
  const commands = [
    "@clawsweeper",
    "@openclaw-clawsweeper[bot]",
    "/clawsweeper",
    "/review",
    "/re-review",
    "/rerun review",
    "/rerun-review",
    "/status",
    "/explain",
    "/fix",
    "/build",
    "/implement",
    "/create pr",
    "/create-pr",
    "/fix issue",
    "/fix-issue",
    "/autofix",
    "/auto fix",
    "/auto-fix",
    "/automerge",
    "/auto merge",
    "/auto-merge",
    "/approve",
    "/stop",
    "/autoclose",
  ];
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const run = namedStep(dispatchSteps(source), "Pre-filter ClawSweeper comment").run ?? "";
    const pattern = run.match(/grep -Eiq '([^']+)'/)?.[1];
    assert.ok(pattern);
    for (const command of commands) {
      const result = spawnSync("grep", ["-Eiq", pattern], {
        input: `please ${command}\n`,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
  }
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
