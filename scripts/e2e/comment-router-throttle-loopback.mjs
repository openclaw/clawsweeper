#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Ledger roots must be canonical even when macOS exposes tmpdir through /var.
const temporary = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-router-throttle-")),
);
const root = path.join(temporary, "runtime");
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
fs.cpSync(path.join(sourceRoot, "dist"), path.join(root, "dist"), { recursive: true });
fs.cpSync(path.join(sourceRoot, "config"), path.join(root, "config"), { recursive: true });
fs.copyFileSync(
  path.join(sourceRoot, "scripts/operator-skip-reasons.mjs"),
  path.join(root, "scripts/operator-skip-reasons.mjs"),
);
if (fs.existsSync(path.join(sourceRoot, "scripts/comment-router-runner.mjs"))) {
  fs.copyFileSync(
    path.join(sourceRoot, "scripts/comment-router-runner.mjs"),
    path.join(root, "scripts/comment-router-runner.mjs"),
  );
}
const runner = fs.existsSync(path.join(root, "scripts/comment-router-runner.mjs"))
  ? path.join(root, "scripts/comment-router-runner.mjs")
  : path.join(root, "dist/repair/comment-router.js");
if (process.argv[2]) {
  fs.writeFileSync(
    runner,
    execFileSync("git", ["show", `${process.argv[2]}:scripts/comment-router-runner.mjs`], {
      cwd: sourceRoot,
    }),
  );
}
const targetRepo = "openclaw/router-throttle-proof";
const cursorPath = path.join(
  root,
  "results/comment-router-cursors/openclaw-router-throttle-proof.json",
);
const resultPath = path.join(root, "results/comment-router-latest.json");
const ledgerPath = path.join(root, "results/comment-router.json");
const eventRoot = path.join(temporary, "events");
const eventOutput = path.join(temporary, "event-output");
const producerEnv = {
  CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
  CLAWSWEEPER_ACTION_LEDGER_ROOT: eventRoot,
  CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: eventOutput,
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW: "Comment router loopback proof",
  GITHUB_JOB: "proof",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_STARTED_AT: "2026-09-05T00:00:00Z",
  CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-09-05",
  GITHUB_WORKFLOW_REF: "",
  GITHUB_ACTION: "route",
  CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
  CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
  CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
};
const fakeGh = path.join(temporary, "gh-loopback.mjs");
const cursor = {
  schema_version: 1,
  repo: targetRepo,
  updated_at: "2026-08-13T11:50:00.000Z",
  comment_ids: [90],
};

fs.writeFileSync(
  fakeGh,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const valued = new Set(["--method", "-X", "--input", "--jq", "-H", "--header", "-f", "-F"]);
let endpoint = "";
let method = "GET";
let input = null;
for (let index = 1; args[0] === "api" && index < args.length; index += 1) {
  if (args[index] === "--method" || args[index] === "-X") method = args[index + 1];
  if (args[index] === "--input") input = args[index + 1];
  if (valued.has(args[index])) index += 1;
  else if (!endpoint && !args[index].startsWith("-")) endpoint = args[index];
}
// "gh pr view N --repo R" reads one pull request fixture.
if (args[0] === "pr" && args[1] === "view") {
  endpoint = "repos/" + args[args.indexOf("--repo") + 1] + "/__pr/" + args[2];
}
let payload;
if (input === "-") {
  payload = "";
  for await (const chunk of process.stdin) payload += chunk;
} else if (input) {
  payload = (await import("node:fs")).readFileSync(input, "utf8");
}
const response = await fetch(new URL(endpoint, process.env.GITHUB_API_URL + "/"), {
  method,
  body: payload,
  headers: { authorization: "Bearer loopback-proof-token" },
});
const body = await response.json();
if (!response.ok) {
  if (args.includes("--slurp")) process.stdout.write(JSON.stringify([body]));
  process.stderr.write("gh: " + body.message + " (HTTP " + response.status + ")\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(args.includes("--slurp") ? [body] : body));
`,
  { mode: 0o755 },
);

let mode = "throttle";
const requests = [];
// Executed commands: status replies on issues 3 and 5, an assist dispatch on issue 4,
// and an autofix review dispatch on pull request 6.
const executionCommands = {
  3: commandComment({ id: 300, issueNumber: 3 }),
  4: commandComment({
    id: 400,
    issueNumber: 4,
    body: "/clawsweeper ask is this blocked on flaky CI?",
  }),
  5: commandComment({ id: 500, issueNumber: 5 }),
  6: commandComment({ id: 600, issueNumber: 6, body: "/clawsweeper autofix" }),
};
// The status comment that an earlier autofix command on pull request 6 left behind.
const retainedStatus = {
  id: 650,
  body: "<!-- clawsweeper-command-status:6:autofix:0000000 -->\nAutofix is active.",
  issue_url: `https://api.github.com/repos/${targetRepo}/issues/6`,
  user: { login: "openclaw-clawsweeper[bot]" },
  created_at: "2026-08-13T11:00:00.000Z",
  updated_at: "2026-08-13T11:00:00.000Z",
};
const dispatchBodies = [];
// The webhook acknowledgement for comment 500. It is deleted before the router updates it.
const deletedAck = {
  id: 501,
  body: "<!-- clawsweeper-command-ack:500 -->\nWorking on it.",
  issue_url: `https://api.github.com/repos/${targetRepo}/issues/5`,
  user: { login: "openclaw-clawsweeper[bot]" },
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://loopback.invalid");
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  if (mode === "before-discovery") {
    return json(response, 429, { message: "Too Many Requests" });
  }
  if (request.method !== "GET") {
    if (
      mode === "mutation-throttle" ||
      (mode === "dispatch-throttle" && url.pathname.endsWith("/dispatches"))
    ) {
      return json(response, 403, { message: "API rate limit exceeded for installation" });
    }
    if (url.pathname.endsWith(`/issues/comments/${deletedAck.id}`)) {
      return json(response, 404, { message: "Not Found" });
    }
    if (url.pathname.endsWith("/dispatches")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      dispatchBodies.push(JSON.parse(body));
    }
    return json(response, 201, { id: 1 });
  }
  if (url.pathname === `/repos/${targetRepo}/__pr/6`) {
    return json(response, 200, {
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      files: [{ path: "src/a.ts", additions: 10, deletions: 2 }],
      headRefName: "fix",
      headRefOid: "1".repeat(40),
      baseRefName: "main",
      author: { login: "contributor" },
      body: "Fix a bug",
      title: "Fix a bug",
      closingIssuesReferences: [],
      commits: [],
      isDraft: false,
      labels: [],
      mergeable: "MERGEABLE",
      mergeCommit: null,
      mergeStateStatus: "CLEAN",
      mergedAt: null,
      reviewDecision: "",
      state: "OPEN",
      statusCheckRollup: [],
      url: `https://github.com/${targetRepo}/pull/6`,
    });
  }
  if (url.pathname === `/repos/${targetRepo}/issues/6/comments`) {
    return json(response, 200, [retainedStatus, executionCommands[6]]);
  }
  if (url.pathname === "/user") return json(response, 200, { login: "openclaw-clawsweeper[bot]" });
  if (url.pathname === `/repos/${targetRepo}/issues/comments/${deletedAck.id}`) {
    return json(response, 200, deletedAck);
  }
  for (const [issueNumber, comment] of Object.entries(executionCommands)) {
    const issuePath = `/repos/${targetRepo}/issues/${issueNumber}`;
    if (url.pathname === `/repos/${targetRepo}/issues/comments/${comment.id}`) {
      return json(response, 200, comment);
    }
    if (url.pathname === issuePath) {
      return json(response, 200, {
        number: Number(issueNumber),
        state: "open",
        locked: false,
        title: "Executed command issue",
        body: "Router mutation throttle fixture",
        user: { login: "reporter" },
        labels: [],
        ...(issueNumber === "6" ? { pull_request: { url: `${issuePath}/pull` } } : {}),
      });
    }
    if (url.pathname === `${issuePath}/comments`) return json(response, 200, [comment]);
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues/comments/100") {
    return json(response, 200, commandComment());
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues/comments") {
    return json(response, 200, [
      {
        ...commandComment(),
        id: 90,
        body: "ordinary earlier comment",
        created_at: cursor.updated_at,
        updated_at: cursor.updated_at,
      },
      commandComment(),
      commandComment({ id: 200, issueNumber: 2 }),
    ]);
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues") {
    return json(response, 200, []);
  }
  if (
    url.pathname === "/repos/openclaw/router-throttle-proof/collaborators/maintainer/permission"
  ) {
    return json(response, 200, { permission: "admin" });
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues/1") {
    return json(response, 200, {
      number: 1,
      state: "open",
      locked: false,
      title: "Loopback proof issue",
      body: "Router throttle fixture",
      user: { login: "reporter" },
      labels: [],
    });
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues/2") {
    return json(response, 200, {
      number: 2,
      state: "open",
      locked: false,
      title: "Already fetched routable issue",
      body: "Router partial-progress fixture",
      user: { login: "reporter" },
      labels: [],
    });
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues/1/comments") {
    if (["throttle", "abuse", "too_many"].includes(mode)) {
      const status = mode === "too_many" ? 429 : 403;
      return json(response, status, {
        message:
          mode === "abuse"
            ? "You have triggered an abuse detection mechanism"
            : mode === "too_many"
              ? "Too Many Requests"
              : "API rate limit exceeded for installation",
        documentation_url:
          "https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#rate-limiting",
        status: String(status),
      });
    }
    if (mode === "error") return json(response, 422, { message: "loopback request is invalid" });
    return json(response, 200, [commandComment()]);
  }
  if (url.pathname === "/repos/openclaw/router-throttle-proof/issues/2/comments") {
    return json(response, 200, [commandComment({ id: 200, issueNumber: 2 })]);
  }
  return json(response, 404, { message: `unhandled ${request.method} ${url.pathname}` });
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  fs.writeFileSync(ledgerPath, '{"updated_at":null,"commands":[]}\n');
  fs.mkdirSync(eventRoot);
  fs.mkdirSync(eventOutput);

  mode = "before-discovery";
  const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
  fs.writeFileSync(
    resultPath,
    JSON.stringify({
      commands_seen: 7,
      commands: [{ issue_number: 999, status: "ready" }],
      ledger_changed: 7,
      routing_cursor_candidate: { ...cursor, updated_at: "2026-08-14T00:00:00.000Z" },
    }),
  );
  for (const broad of [true, false]) {
    if (!broad) fs.rmSync(resultPath);
    const early = await runRouter(apiUrl, { broad, receipts: true });
    assert.equal(early.status, 0, early.stderr || early.stdout);
    const report = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(report.commands_seen, 0);
    assert.deepEqual(report.commands, []);
    assert.equal(report.ledger_changed, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, "utf8")), cursor);
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
    const finalized = finalize(report);
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(finalized.stdout, "");
  }

  mode = "throttle";

  const throttled = await runRouter(apiUrl);
  assert.equal(throttled.status, 0, throttled.stderr || throttled.stdout);
  assert.match(throttled.stdout, /comment_router_skip .*"reason":"github_throttled"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, "utf8")), cursor);
  const deferred = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.operator_skip.reason, "github_throttled");
  assert.equal(deferred.routing_cursor.advanced, false);

  const partial = await runRouter(apiUrl, { broad: true, maxComments: 2, receipts: true });
  assert.equal(partial.status, 0, partial.stderr || partial.stdout);
  const partialReport = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(partialReport.operator_skip.reason, "github_throttled");
  assert.deepEqual(
    partialReport.commands.map((command) => [command.issue_number, command.status]),
    [
      [2, "ready"],
      [1, "waiting"],
    ],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, "utf8")), cursor);
  const partialFinalized = finalize(partialReport);
  assert.equal(partialFinalized.status, 0, partialFinalized.stderr);
  assert.ok(JSON.parse(partialFinalized.stdout).event_paths.length > 0);

  mode = "abuse";
  const abuse = await runRouter(apiUrl);
  assert.equal(abuse.status, 0, abuse.stderr || abuse.stdout);
  assert.match(abuse.stdout, /comment_router_skip .*"reason":"github_throttled"/);

  mode = "too_many";
  const tooMany = await runRouter(apiUrl);
  assert.equal(tooMany.status, 0, tooMany.stderr || tooMany.stdout);
  assert.match(tooMany.stdout, /comment_router_skip .*"reason":"github_throttled"/);

  mode = "error";
  const realError = await runRouter(apiUrl);
  assert.notEqual(realError.status, 0, "non-throttle errors must remain fatal");

  mode = "success";
  const resumed = await runRouter(apiUrl, { broad: true });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const advancedCursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.equal(advancedCursor.updated_at, "2026-08-13T11:51:00.000Z");
  assert.deepEqual(advancedCursor.comment_ids, [100]);
  assert.ok(
    requests.some(
      (request) =>
        request.includes("/issues/comments?since=2026-08-13T11%3A50%3A00.000Z") &&
        request.includes("sort=updated") &&
        request.includes("direction=asc"),
    ),
  );

  // A throttled write stops the command: no reply comment and no reaction cleanup follow.
  mode = "mutation-throttle";
  const reactionThrottle = await runExecutedCommand(apiUrl, 3);
  assert.equal(reactionThrottle.status, 0, reactionThrottle.stderr || reactionThrottle.stdout);
  assert.match(reactionThrottle.stdout, /comment_router_skip .*"reason":"github_throttled"/);
  assert.deepEqual(reactionThrottle.writes, [
    `POST /repos/${targetRepo}/issues/comments/300/reactions`,
  ]);
  assert.equal(reactionThrottle.command?.status, "waiting");

  // A throttled dispatch defers the command instead of failing the run.
  mode = "dispatch-throttle";
  const dispatchThrottle = await runExecutedCommand(apiUrl, 4);
  assert.equal(dispatchThrottle.status, 0, dispatchThrottle.stderr || dispatchThrottle.stdout);
  assert.match(dispatchThrottle.stdout, /comment_router_skip .*"reason":"github_throttled"/);
  assert.deepEqual(dispatchThrottle.writes, [
    `POST /repos/${targetRepo}/issues/comments/400/reactions`,
    "POST /repos/openclaw/clawsweeper/dispatches",
  ]);
  assert.equal(dispatchThrottle.command?.status, "waiting");

  // A replayed webhook whose acknowledgement is already deleted converges with no write.
  mode = "success";
  const processed = await runExecutedCommand(apiUrl, 5);
  assert.equal(processed.status, 0, processed.stderr || processed.stdout);
  assert.equal(processed.command?.status, "executed");
  const processedComment = executionCommands[5];
  const replay = await runExecutedCommand(apiUrl, 5, [
    "--comment-event-auth",
    "github_webhook_v1",
    "--source-event",
    "issue_comment",
    "--source-action",
    "created",
    "--dispatch-actor",
    "openclaw-clawsweeper[bot]",
    "--comment-updated-at",
    processedComment.updated_at,
    "--comment-body-sha256",
    createHash("sha256").update(processedComment.body).digest("hex"),
    "--status-comment-id",
    String(deletedAck.id),
  ]);
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.equal(replay.report.exact_comment_version_ack, "already_converged");
  assert.deepEqual(replay.writes, [`PATCH /repos/${targetRepo}/issues/comments/${deletedAck.id}`]);

  // A forced replay carries its attempt identity on every routed command.
  const forced = await runRouter(apiUrl, {
    selection: [
      "--comment-ids",
      "100",
      "--item-numbers",
      "1",
      "--force-reprocess",
      "--attempt-id",
      "forced-replay-42",
    ],
  });
  assert.equal(forced.status, 0, forced.stderr || forced.stdout);
  const forcedCommand = JSON.parse(fs.readFileSync(resultPath, "utf8")).commands[0];
  assert.equal(forcedCommand.forced_replay, true);
  assert.equal(forcedCommand.attempt_id, "forced-replay-42");

  // An autofix review follow-up keeps the existing status comment in its dispatch.
  const autofix = await runExecutedCommand(apiUrl, 6);
  assert.equal(autofix.status, 0, autofix.stderr || autofix.stdout);
  const reviewDispatch = dispatchBodies.find((body) => body.event_type === "clawsweeper_item");
  assert.ok(reviewDispatch, JSON.stringify(autofix.report));
  assert.equal(reviewDispatch.client_payload.target_repo, targetRepo);
  assert.equal(reviewDispatch.client_payload.item_number, "6");
  assert.equal(reviewDispatch.client_payload.item_kind, "pull_request");
  assert.equal(reviewDispatch.client_payload.status_comment_id, String(retainedStatus.id));
  assert.match(
    reviewDispatch.client_payload.command_status_marker,
    /^<!-- clawsweeper-command-status:6:autofix:/,
  );
  assert.ok(reviewDispatch.client_payload.review_options);
  assert.equal(
    reviewDispatch.client_payload.dispatch_key,
    autofix.command?.actions.find((action) => action.action === "dispatch_clawsweeper")
      ?.dispatch_key,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sourceRoot,
          encoding: "utf8",
        }).trim(),
        working_tree_dirty: Boolean(
          execFileSync("git", ["status", "--porcelain"], {
            cwd: sourceRoot,
            encoding: "utf8",
          }).trim(),
        ),
        runner_sha256: createHash("sha256").update(fs.readFileSync(runner)).digest("hex"),
        transport: "loopback HTTP via GITHUB_API_URL",
        assertions: {
          throttle_exit_zero: true,
          abuse_403_exit_zero: true,
          throttle_429_exit_zero: true,
          structured_skip: true,
          routable_data_completed: true,
          cursor_unchanged: true,
          cursor_resumed_incrementally: true,
          real_error_nonzero: true,
          stale_report_retired: true,
          undiscovered_explicit_comment_not_counted: true,
          empty_finalization_succeeded: true,
          partial_receipts_finalized: true,
          throttled_write_stops_command: true,
          throttled_dispatch_defers_command: true,
          deleted_ack_converges_without_write: true,
          forced_replay_attempt_routed: true,
          review_dispatch_keeps_status_comment: true,
        },
        requests,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}

async function runExecutedCommand(apiUrl, issueNumber, eventArgs = []) {
  const firstRequest = requests.length;
  const comment = executionCommands[issueNumber];
  const result = await runRouter(apiUrl, {
    selection: [
      "--comment-ids",
      String(comment.id),
      "--item-numbers",
      String(issueNumber),
      ...eventArgs,
    ],
    execute: true,
  });
  const report = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : {};
  return {
    ...result,
    report,
    writes: requests.slice(firstRequest).filter((request) => !request.startsWith("GET ")),
    command: report.commands?.find((command) => command.issue_number === issueNumber),
  };
}

function runRouter(
  apiUrl,
  {
    broad = false,
    maxComments = 1,
    receipts = false,
    selection = ["--comment-ids", "100", "--item-numbers", "1"],
    execute = false,
  } = {},
) {
  const selectionArgs = broad ? [] : selection;
  const child = spawn(
    process.execPath,
    [
      runner,
      "--",
      "--write-report",
      "--repo",
      targetRepo,
      ...selectionArgs,
      "--max-comments",
      String(maxComments),
      ...(execute ? ["--execute"] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GH_BIN: fakeGh,
        GH_TOKEN: "loopback-proof-token",
        GITHUB_API_URL: apiUrl,
        CLAWSWEEPER_COMMENT_LOOKUP_CONCURRENCY: "1",
        CLAWSWEEPER_STATE_DIR: root,
        ...(receipts ? producerEnv : { CLAWSWEEPER_ACTION_LEDGER_FORCE: "0" }),
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function finalize(report) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "dist/repair/action-ledger-cli.js"),
      "finalize",
      "--lane",
      "comment-router",
      ...(report.commands_seen === 0 ? ["--allow-empty"] : []),
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...producerEnv } },
  );
}

function commandComment({ id = 100, issueNumber = 1, body = "/clawsweeper status" } = {}) {
  return {
    id,
    body,
    html_url: `https://github.com/openclaw/router-throttle-proof/issues/${issueNumber}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/openclaw/router-throttle-proof/issues/${issueNumber}`,
    user: { login: "maintainer", id: 42 },
    author_association: "MEMBER",
    created_at: "2026-08-13T11:51:00.000Z",
    updated_at: "2026-08-13T11:51:00.000Z",
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
