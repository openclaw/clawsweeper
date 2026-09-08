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
const endpoint = args[0] === "api" ? args[1] : "";
const response = await fetch(new URL(endpoint, process.env.GITHUB_API_URL + "/"), {
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
const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://loopback.invalid");
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  if (mode === "before-discovery") {
    return json(response, 429, { message: "Too Many Requests" });
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

function runRouter(apiUrl, { broad = false, maxComments = 1, receipts = false } = {}) {
  const selectionArgs = broad ? [] : ["--comment-ids", "100", "--item-numbers", "1"];
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
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GH_BIN: fakeGh,
        GH_TOKEN: "loopback-proof-token",
        GITHUB_API_URL: apiUrl,
        CLAWSWEEPER_COMMENT_LOOKUP_CONCURRENCY: "1",
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

function commandComment({ id = 100, issueNumber = 1 } = {}) {
  return {
    id,
    body: "/clawsweeper status",
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
