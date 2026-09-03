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
  id?: string;
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
    const expectedGate =
      "${{ github.event_name == 'pull_request_target' && env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true' }}";

    assert.equal(normalizeWhitespace(token.if), expectedGate);
    assert.equal(normalizeWhitespace(acknowledgement.if), expectedGate);
    assert.equal(token["continue-on-error"], true);
    assert.equal(acknowledgement["continue-on-error"], true);
    assert.equal(acknowledgement.id, "pr_acknowledgement");
    assert.deepEqual(
      Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-")),
      ["permission-issues"],
    );
    assert.equal(token.with?.["permission-issues"], "write");
    assert.equal(acknowledgement.env?.ACK_TOKEN, "${{ steps.pr_ack_token.outputs.token }}");

    const run = acknowledgement.run ?? "";
    assert.match(run, /issues\/\$ITEM_NUMBER\/comments\?per_page=100/);
    assert.match(run, /page <= 10/);
    assert.doesNotMatch(run, /--paginate/);
    assert.match(run, /\| jq -s 'add'/);
    assert.match(run, /leaving existing comments untouched/);
    assert.match(run, /--arg marker_prefix "clawsweeper-pr-ack:"/);
    assert.match(run, /--arg marker_suffix " item=\$ITEM_NUMBER -->"/);
    assert.match(run, /\["clawsweeper", "clawsweeper\[bot\]", "openclaw-clawsweeper\[bot\]"\]/);
    assert.match(run, /clawsweeper-review-progress:start/);
    assert.match(run, /sort_by\(\.created_at, \.id\) \| first/);
    assert.match(run, /echo "status_comment_id=\$status_comment_id" >> "\$GITHUB_OUTPUT"/);
    assert.match(run, /\$SOURCE_ACTION" != "ready_for_review"/);
    assert.match(run, /"<!-- clawsweeper-pr-ack:\$SOURCE_ACTION item=\$ITEM_NUMBER -->"/);
    assert.match(
      run,
      /"Pull request received\. I will update this pull request when review starts\."/,
    );
    assert.match(run, /issues\/\$ITEM_NUMBER\/comments"\s*\\\s*--method POST/);
    const dispatch = namedStep(steps, "Dispatch exact ClawSweeper review");
    assert.equal(
      dispatch.env?.REVIEW_ACKNOWLEDGEMENT_COMMENT_ID,
      "${{ steps.pr_acknowledgement.outputs.status_comment_id }}",
    );
    assert.match(
      dispatch.run ?? "",
      /queueClaim\.review_acknowledgement_comment_id = reviewAcknowledgementCommentId/,
    );
  }
});

test("target dispatcher carries immutable issue and pull-request source identity", () => {
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const run = namedStep(dispatchSteps(source), "Dispatch exact ClawSweeper review").run ?? "";
    assert.match(run, /source_identity_json=/);
    assert.match(run, /version: 2/);
    assert.match(run, /const result = \{ queue_claim: queueClaim \}/);
    assert.match(run, /queueClaim\.source_content_revision/);
    assert.match(run, /queueClaim\.source_updated_at/);
    assert.match(run, /queueClaim\.source_head_sha/);
    assert.match(run, /queueClaim\.source_base_sha/);
    assert.match(run, /queueClaim\.source_is_draft/);
    assert.match(run, /result\.ingress_route = "target_dispatcher"/);
    assert.match(run, /result\.ingress_fingerprint/);
    assert.doesNotMatch(run, /process\.exit\(0\)/);
    assert.match(run, /\+ \$source_identity/);
    assert.equal(
      [
        "target_repo",
        "target_branch",
        "item_number",
        "item_kind",
        "source_event",
        "source_action",
        "supersedes_in_progress",
        "queue_claim",
        "ingress_route",
        "ingress_fingerprint",
      ].length,
      10,
    );
  }
});

test("automatic acknowledgement lookup bounds real shell pagination and fails closed", () => {
  const sweep = readFileSync(".github/workflows/sweep.yml", "utf8");
  const jobs = workflowJobs(sweep);
  const scheduled = Object.values(jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === "Resolve automatic review status comment");
  assert.ok(scheduled?.run);
  const dispatcher = namedStep(dispatchSteps(liveWorkflow), "Acknowledge received pull request");
  const cases = [
    {
      name: "old receipt after five pages",
      count: 501,
      failPage: 0,
      malformed: false,
      pages: 6,
      success: true,
    },
    { name: "empty thread", count: 0, failPage: 0, malformed: false, pages: 1, success: true },
    {
      name: "full tenth page",
      count: 1000,
      failPage: 0,
      malformed: false,
      pages: 10,
      success: false,
    },
    {
      name: "API failure discards partial lookup",
      count: 501,
      failPage: 2,
      malformed: false,
      pages: 2,
      success: false,
    },
    {
      name: "malformed response",
      count: 0,
      failPage: 0,
      malformed: true,
      pages: 1,
      success: false,
    },
  ];
  for (const run of [dispatcher.run!, scheduled.run]) {
    const helper = /^list_ack_comments\(\) \{[\s\S]*?^\}/m.exec(run)?.[0];
    assert.ok(helper, "expected the actual bounded workflow helper");
    for (const scenario of cases) {
      const fixture =
        "const args=process.argv.slice(1);" +
        'if(args.length!==2 || args[0]!=="api")process.exit(91);' +
        'const page=Number(new URL(args[1],"https://fixture.invalid/").searchParams.get("page"));' +
        'console.error("ACK_PAGE:"+page);' +
        "if(page===Number(process.env.ACK_FAIL_PAGE))process.exit(92);" +
        'if(process.env.ACK_MALFORMED==="true"){console.log("{}");process.exit(0);}' +
        "const count=Math.max(0,Math.min(100,Number(process.env.ACK_COUNT)-(page-1)*100));" +
        "console.log(JSON.stringify(Array.from({length:count},(_,i)=>({id:(page-1)*100+i+1}))));";
      const script = [
        "set -euo pipefail",
        "gh() { node -e '" + fixture + '\' "$@"; }',
        helper,
        'comments="$(list_ack_comments)"',
        'printf "%s" "$comments"',
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          TARGET_REPO: "proof/acknowledgements",
          ITEM_NUMBER: "42",
          ACK_COUNT: String(scenario.count),
          ACK_FAIL_PAGE: String(scenario.failPage),
          ACK_MALFORMED: String(scenario.malformed),
        },
      });
      assert.equal(result.error, undefined, scenario.name);
      assert.equal(result.status === 0, scenario.success, scenario.name + ": " + result.stderr);
      assert.equal((result.stderr.match(/ACK_PAGE:/g) ?? []).length, scenario.pages, scenario.name);
      if (scenario.success) {
        assert.equal(JSON.parse(result.stdout).length, scenario.count, scenario.name);
      } else {
        assert.equal(result.stdout, "", scenario.name);
      }
    }
  }
});
