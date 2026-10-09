import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { parse } from "yaml";
import {
  TARGET_DISPATCH_ENDPOINT,
  TARGET_DISPATCH_WORKFLOW_PATH,
} from "../dashboard/target-dispatch-ingress.ts";

type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: string };
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
};

const liveWorkflow = parse(
  readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8"),
) as Workflow;
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
const documentedWorkflow = parse(dispatcherTemplates[0]!.content) as Workflow;
const hostedAdmissionRevision = "174a2c9c903323eb9387d030748ed2b41824a7be";

function dispatchSteps(workflow: Workflow): WorkflowStep[] {
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
  assert.deepEqual(documentedWorkflow, liveWorkflow);
});

test("copied dispatchers isolate comment and ignored bot-label concurrency", () => {
  const expectedGroup =
    "clawsweeper-dispatch-${{ github.repository }}-${{ github.event_name }}-${{ github.event.comment.id || github.event.issue.number || github.event.pull_request.number || github.run_id }}-${{ endsWith(github.actor, '[bot]') && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.actor || 'dispatchable' }}";
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const concurrency = source.concurrency;
    assert.equal(concurrency?.group, expectedGroup);
    assert.equal(
      concurrency?.["cancel-in-progress"],
      "${{ github.event.action == 'edited' || github.event.action == 'synchronize' || github.event.action == 'ready_for_review' }}",
    );
  }
});

test("copied dispatchers admit the target before any token or acknowledgement", () => {
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const jobs = source.jobs;
    assert.equal(
      jobs?.["hosted-target-admission"]?.uses,
      `openclaw/clawsweeper/.github/workflows/hosted-target-admission.yml@${hostedAdmissionRevision}`,
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

test("copied dispatchers keep command delivery independent of target acknowledgement tokens", () => {
  for (const source of [liveWorkflow, documentedWorkflow]) {
    const steps = dispatchSteps(source);
    const token = namedStep(steps, "Create target comment token");
    const command = namedStep(steps, "Acknowledge and dispatch ClawSweeper comment");

    assert.equal(token["continue-on-error"], true);
    assert.doesNotMatch(normalizeWhitespace(command.if), /target_token|TARGET_TOKEN/);
    assert.equal(command.env?.TARGET_TOKEN, "${{ steps.target_token.outputs.token }}");
    assert.equal(command.env?.DISPATCH_TOKEN, "${{ steps.token.outputs.token }}");
    assert.match(command.run ?? "", /if \[ -n "\$TARGET_TOKEN" \]; then/);
    assert.match(
      command.run ?? "",
      /GH_TOKEN="\$DISPATCH_TOKEN" gh api repos\/openclaw\/clawsweeper\/dispatches/,
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

    const dispatch = namedStep(steps, "Dispatch exact ClawSweeper review");
    assert.equal(
      dispatch.env?.REVIEW_ACKNOWLEDGEMENT_COMMENT_ID,
      "${{ steps.pr_acknowledgement.outputs.status_comment_id }}",
    );
  }
});

test("target dispatcher reuses a trusted acknowledgement or posts one for new ready PRs", () => {
  const run = namedStep(dispatchSteps(liveWorkflow), "Acknowledge received pull request").run!;
  const root = mkdtempSync(path.join(tmpdir(), "target-dispatch-ack-"));
  const posts = path.join(root, "posts");
  writeFileSync(
    path.join(root, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.GH_TOKEN !== "ack-token") process.exit(9);
if (args.includes("POST")) {
  fs.appendFileSync(process.env.POSTS, args[1] + " " + JSON.parse(fs.readFileSync(0, "utf8")).body.split("\\n")[0] + "\\n");
  console.log('{"id":900}');
} else {
  console.log(new URL(args[1], "https://fixture.invalid/").searchParams.get("page") === "1" ? process.env.ACK_COMMENTS : "[]");
}
`,
    { mode: 0o755 },
  );
  const ack = (id: number, login: string, extra = "") => ({
    id,
    user: { login },
    body: `<!-- clawsweeper-pr-ack:opened item=42 -->${extra}`,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: `2026-10-01T00:0${id}:00Z`,
  });
  const bot = "openclaw-clawsweeper[bot]";
  const progress = ack(6, bot, "\n<!-- clawsweeper-review-progress:start -->");
  try {
    for (const [action, draft, comments, output, token] of [
      ["opened", "false", [], "", ""],
      ["synchronize", "false", [ack(5, bot)], "5"],
      ["opened", "false", [ack(5, bot), progress], "6"],
      ["opened", "false", [ack(5, "outsider")], "900"],
      ["ready_for_review", "true", [], "900"],
      ["synchronize", "false", [], ""],
      ["opened", "true", [], ""],
    ] as const) {
      const name = `${action} draft=${draft} -> ${output || "none"}`;
      writeFileSync(posts, "");
      writeFileSync(path.join(root, "output"), "");
      const result = spawnSync(
        "bash",
        ["-c", `sleep() { :; }\n${run.replace("${{ github.event.pull_request.draft }}", draft)}`],
        {
          encoding: "utf8",
          env: {
            PATH: `${root}:${process.env.PATH}`,
            POSTS: posts,
            GITHUB_OUTPUT: path.join(root, "output"),
            ACK_TOKEN: token ?? "ack-token",
            ACK_COMMENTS: JSON.stringify(comments),
            TARGET_REPO: "openclaw/example",
            ITEM_NUMBER: "42",
            SOURCE_ACTION: action,
          },
        },
      );
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      const expectedOutput = output ? `status_comment_id=${output}\n` : "";
      assert.equal(readFileSync(path.join(root, "output"), "utf8"), expectedOutput, name);
      assert.equal(
        readFileSync(posts, "utf8"),
        output === "900"
          ? `repos/openclaw/example/issues/42/comments <!-- clawsweeper-pr-ack:${action} item=42 -->\n`
          : "",
        name,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatcher queues directly with its OIDC identity and falls back to repository_dispatch", async () => {
  // The Worker only trusts tokens minted by the documented dispatcher file.
  assert.equal(TARGET_DISPATCH_WORKFLOW_PATH, ".github/workflows/clawsweeper-dispatch.yml");
  assert.match(documentation, /`\.github\/workflows\/clawsweeper-dispatch\.yml`, or merge/);
  for (const source of [liveWorkflow, documentedWorkflow]) {
    assert.deepEqual(source.jobs?.dispatch?.permissions, {
      contents: "read",
      "id-token": "write",
    });
    const step = namedStep(dispatchSteps(source), "Dispatch exact ClawSweeper review");
    assert.equal(step.env?.TARGET_DISPATCH_URL, TARGET_DISPATCH_ENDPOINT);
  }
  const run = namedStep(dispatchSteps(liveWorkflow), "Dispatch exact ClawSweeper review").run!;
  const root = mkdtempSync(path.join(tmpdir(), "target-dispatch-"));
  const eventPath = path.join(root, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        title: "Fix parser",
        body: "Body",
        locked: false,
        draft: false,
        labels: [{ name: "bug" }],
        updated_at: "2026-10-01T03:10:50Z",
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
      },
    }),
  );
  writeFileSync(
    path.join(root, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_STUB_LOG"\ncat >> "$GH_STUB_LOG"\nprintf "\\n" >> "$GH_STUB_LOG"\n',
  );
  chmodSync(path.join(root, "gh"), 0o755);
  let tokenStatus = 200;
  let directStatus = 202;
  let requests: Array<{ path: string; query: string; authorization: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      requests.push({
        path: url.pathname,
        query: url.search,
        authorization: String(request.headers.authorization ?? ""),
        body,
      });
      const status = url.pathname === "/token" ? tokenStatus : directStatus;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          url.pathname === "/token"
            ? { value: "synthetic-oidc-token" }
            : { ok: status < 300, queued: status < 300, item_key: "openclaw/example#42" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directUrl = `${origin}/github/target-dispatch`;
  let executions = 0;
  const execute = (options: { oidc: boolean; directUrl?: string }) => {
    const log = path.join(root, `gh-${(executions += 1)}.log`);
    writeFileSync(log, "");
    return new Promise<{ status: number | null; stdout: string; gh: string }>((resolve, reject) => {
      const child = spawn("bash", ["-e", "-c", run], {
        env: {
          PATH: `${root}:${process.env.PATH}`,
          GH_STUB_LOG: log,
          GH_TOKEN: "app-installation-token",
          GITHUB_EVENT_PATH: eventPath,
          TARGET_REPO: "openclaw/example",
          TARGET_BRANCH: "main",
          ITEM_NUMBER: "42",
          ITEM_KIND: "pull_request",
          SOURCE_EVENT: "pull_request_target",
          SOURCE_ACTION: "opened",
          SUPERSEDES_IN_PROGRESS: "false",
          REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "77",
          TARGET_DISPATCH_URL: options.directUrl ?? directUrl,
          ...(options.oidc
            ? {
                ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
              }
            : {}),
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, gh: readFileSync(log, "utf8") }));
    });
  };
  try {
    const direct = await execute({ oidc: true });
    assert.equal(direct.status, 0);
    assert.equal(direct.gh, "", "a direct admission must not create a repository_dispatch");
    assert.match(direct.stdout, /Queued exact ClawSweeper review directly: \{"ok":true/);
    assert.deepEqual(
      requests.map((request) => request.path),
      ["/token", "/github/target-dispatch"],
    );
    const tokenQuery = new URLSearchParams(requests[0]!.query);
    assert.equal(requests[0]!.authorization, "bearer request-token");
    assert.equal(tokenQuery.get("api-version"), "2.0");
    // One URL is both the OIDC audience and the POST target.
    assert.equal(tokenQuery.get("audience"), directUrl);
    assert.equal(requests[1]!.authorization, "Bearer synthetic-oidc-token");
    const clientPayload = JSON.parse(requests[1]!.body);
    assert.deepEqual(Object.keys(clientPayload).sort(), [
      "ingress_fingerprint",
      "ingress_route",
      "item_kind",
      "item_number",
      "queue_claim",
      "source_action",
      "source_event",
      "supersedes_in_progress",
      "target_branch",
      "target_repo",
    ]);
    assert.equal(clientPayload.ingress_route, "target_dispatcher");
    assert.match(clientPayload.ingress_fingerprint, /^[0-9a-f]{64}$/);
    const contentRevision = createHash("sha256")
      .update(
        JSON.stringify({
          version: 2,
          title: "Fix parser",
          body: "Body",
          locked: false,
          close_guard_labels: ["bug"],
        }),
      )
      .digest("hex");
    assert.deepEqual(clientPayload.queue_claim, {
      review_acknowledgement_comment_id: 77,
      source_updated_at: "2026-10-01T03:10:50Z",
      source_content_revision: contentRevision,
      source_head_sha: "a".repeat(40),
      source_base_sha: "b".repeat(40),
      source_is_draft: false,
    });

    const fallbacks = [
      { name: "worker rejection", oidc: true, token: 200, direct: 401, posts: 2 },
      { name: "worker outage", oidc: true, token: 200, direct: 503, posts: 2 },
      { name: "token endpoint failure", oidc: true, token: 500, direct: 202, posts: 1 },
      { name: "no id-token permission", oidc: false, token: 200, direct: 202, posts: 0 },
      {
        name: "unreachable worker",
        oidc: true,
        token: 200,
        direct: 202,
        posts: 1,
        directUrl: "http://127.0.0.1:9/github/target-dispatch",
      },
    ];
    for (const scenario of fallbacks) {
      requests = [];
      tokenStatus = scenario.token;
      directStatus = scenario.direct;
      const result = await execute({
        oidc: scenario.oidc,
        ...(scenario.directUrl ? { directUrl: scenario.directUrl } : {}),
      });
      assert.equal(result.status, 0, scenario.name);
      assert.equal(requests.length, scenario.posts, scenario.name);
      const [args, input] = result.gh.split("\n");
      assert.equal(args, "api repos/openclaw/clawsweeper/dispatches --method POST --input -");
      // The fallback is byte-for-byte the payload the relay received before.
      assert.deepEqual(JSON.parse(input!), {
        event_type: "clawsweeper_item",
        client_payload: clientPayload,
      });
    }
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic acknowledgement lookup bounds real shell pagination and fails closed", () => {
  const jobs = (parse(readFileSync(".github/workflows/sweep.yml", "utf8")) as Workflow).jobs;
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
