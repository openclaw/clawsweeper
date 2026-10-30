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
import { exactReviewSourceRevisionMaterial } from "../dashboard/exact-review-source-revision.ts";
import { classifyItemWebhook } from "../dist/repair/comment-webhook.js";
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

function dispatchSteps(workflow: Workflow): WorkflowStep[] {
  return workflow.jobs?.dispatch?.steps ?? [];
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
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

test("copied dispatchers are keyless and leave admission and acknowledgements to the Worker", () => {
  for (const source of [liveWorkflow, documentedWorkflow]) {
    assert.deepEqual(Object.keys(source.jobs ?? {}), ["dispatch"]);
    assert.doesNotMatch(
      JSON.stringify(source),
      /secrets\.|create-github-app-token|repository_dispatch|GH_TOKEN/,
    );
    assert.equal(source.jobs?.dispatch?.needs, undefined);
    const command = namedStep(dispatchSteps(source), "Dispatch ClawSweeper comment");
    assert.match(command.if ?? "", /comment_filter.outputs.is_command == 'true'/);
    assert.equal(command.env?.COMMENT_BODY, undefined);
    assert.equal(command.env?.AUTHOR_ASSOCIATION, undefined);
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

test("an old maintainer reminder comment cannot route itself as a command", () => {
  const prefilter = namedStep(dispatchSteps(liveWorkflow), "Pre-filter ClawSweeper comment").run!;
  const root = mkdtempSync(path.join(tmpdir(), "target-dispatch-reminder-"));
  const output = path.join(root, "output");
  // Reminders posted before maintainer first reviews became automatic mention the command.
  const body = [
    "<!-- clawsweeper-maintainer-opt-in:opened item=42 -->",
    "ClawSweeper reviews are opt-in for maintainers. If a review is required, finish the work and validation first, then comment `@clawsweeper review`.",
  ].join("\n");
  try {
    writeFileSync(output, "");
    const filtered = spawnSync("bash", ["-e", "-c", prefilter], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, COMMENT_BODY: body, GITHUB_OUTPUT: output },
    });
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.equal(readFileSync(output, "utf8"), "is_command=false\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatcher uses OIDC only and fails transient intake errors while warning on rejection", async () => {
  // The Worker only trusts tokens minted by the documented dispatcher file.
  assert.equal(TARGET_DISPATCH_WORKFLOW_PATH, ".github/workflows/clawsweeper-dispatch.yml");
  assert.match(documentation, /canonical dispatcher filename/);
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
        labels: [
          { name: "bug" },
          { name: "clawsweeper:autofix" },
          { name: "clawsweeper:automerge" },
        ],
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
  const execute = (options: { oidc: boolean; directUrl?: string; comment?: boolean }) => {
    const log = path.join(root, `gh-${(executions += 1)}.log`);
    writeFileSync(log, "");
    return new Promise<{ status: number | null; stdout: string; gh: string }>((resolve, reject) => {
      const child = spawn(
        "bash",
        [
          "-e",
          "-c",
          options.comment
            ? namedStep(dispatchSteps(liveWorkflow), "Dispatch ClawSweeper comment").run!
            : run,
        ],
        {
          env: {
            PATH: `${root}:${process.env.PATH}`,
            GH_STUB_LOG: log,
            GH_TOKEN: "app-installation-token",
            GITHUB_EVENT_PATH: eventPath,
            RUNNER_TEMP: root,
            TARGET_REPO: "openclaw/example",
            TARGET_BRANCH: "main",
            ITEM_NUMBER: "42",
            ITEM_KIND: "pull_request",
            SOURCE_EVENT: "pull_request_target",
            SOURCE_ACTION: options.comment ? "created" : "opened",
            COMMENT_ID: "9001",
            SUPERSEDES_IN_PROGRESS: "false",
            TARGET_DISPATCH_URL: options.directUrl ?? directUrl,
            ...(options.oidc
              ? {
                  ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
                  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
                }
              : {}),
          },
        },
      );
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
    assert.match(direct.stdout, /Queued ClawSweeper intake directly: \{"ok":true/);
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
          close_guard_labels: ["bug", "clawsweeper:autofix", "clawsweeper:automerge"],
        }),
      )
      .digest("hex");
    assert.deepEqual(clientPayload.queue_claim, {
      source_updated_at: "2026-10-01T03:10:50Z",
      source_content_revision: contentRevision,
      source_head_sha: "a".repeat(40),
      source_base_sha: "b".repeat(40),
      source_is_draft: false,
    });
    const pullRequest = JSON.parse(readFileSync(eventPath, "utf8")).pull_request;
    const webhook = classifyItemWebhook({
      event: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "openclaw/openclaw", default_branch: "main" },
        installation: { id: 1 },
        pull_request: pullRequest,
      },
    });
    assert.equal(webhook.accepted, true);
    assert.equal(webhook.sourceContentRevision, clientPayload.queue_claim.source_content_revision);
    const workerRevision = createHash("sha256")
      .update(JSON.stringify(exactReviewSourceRevisionMaterial(pullRequest)))
      .digest("hex");
    assert.equal(workerRevision, clientPayload.queue_claim.source_content_revision);

    requests = [];
    const command = await execute({ oidc: true, comment: true });
    assert.equal(command.status, 0);
    assert.equal(command.gh, "");
    assert.deepEqual(JSON.parse(requests[1]!.body), {
      target_repo: "openclaw/example",
      item_number: 42,
      comment_id: 9001,
      source_event: "issue_comment",
      source_action: "created",
    });

    const declined = /::warning::.*declined this event/;
    const unavailable = /::error::.*intake unavailable/;
    const noToken = /::error::.*OIDC token unavailable/;
    // Definitive rejection is covered by the App webhook. Transient errors must
    // fail the run and stay re-runnable, including OIDC verifier unavailability.
    const failures = [
      {
        name: "worker rejection",
        oidc: true,
        token: 200,
        direct: 401,
        posts: 2,
        exit: 0,
        log: declined,
      },
      {
        name: "worker timeout",
        oidc: true,
        token: 200,
        direct: 408,
        posts: 2,
        exit: 1,
        log: unavailable,
      },
      {
        name: "worker throttling",
        oidc: true,
        token: 200,
        direct: 429,
        posts: 2,
        exit: 1,
        log: unavailable,
      },
      {
        name: "worker outage",
        oidc: true,
        token: 200,
        direct: 503,
        posts: 2,
        exit: 1,
        log: unavailable,
      },
      // curl --fail treats a 3xx as success; only a 2xx counts as delivered.
      {
        name: "worker redirect",
        oidc: true,
        token: 200,
        direct: 307,
        posts: 2,
        exit: 1,
        log: unavailable,
      },
      {
        name: "token endpoint failure",
        oidc: true,
        token: 500,
        direct: 202,
        posts: 1,
        exit: 1,
        log: noToken,
      },
      {
        name: "no id-token permission",
        oidc: false,
        token: 200,
        direct: 202,
        posts: 0,
        exit: 1,
        log: noToken,
      },
      {
        name: "unreachable worker",
        oidc: true,
        token: 200,
        direct: 202,
        posts: 1,
        exit: 1,
        log: unavailable,
        directUrl: "http://127.0.0.1:9/github/target-dispatch",
      },
    ];
    for (const scenario of failures) {
      tokenStatus = scenario.token;
      directStatus = scenario.direct;
      for (const comment of [false, true]) {
        requests = [];
        const result = await execute({
          oidc: scenario.oidc,
          comment,
          ...(scenario.directUrl ? { directUrl: scenario.directUrl } : {}),
        });
        assert.equal(result.status, scenario.exit, scenario.name);
        assert.equal(requests.length, scenario.posts, scenario.name);
        assert.equal(result.gh, "", scenario.name);
        assert.match(result.stdout, scenario.log, scenario.name);
      }
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
  for (const run of [scheduled.run]) {
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
