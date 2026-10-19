import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2] ?? `${root}/.artifacts/actions-hook-boundary`);
mkdirSync(output, { recursive: true });
const workflowPath = ".github/workflows/github-activity.yml";
const workflowSource = readFileSync(resolve(root, workflowPath), "utf8");
const workflow = YAML.parse(workflowSource);
const normalize = (value) => value.replace(/\s+/g, " ").trim();
const expression = normalize(workflow.jobs.notify.if);

// This deliberately supports only the exact current expression, not arbitrary
// Actions syntax. Drift must fail instead of silently proving a stale condition.
assert.equal(
  expression,
  normalize(`\${{
  (github.event_name != 'workflow_run' || (github.event.workflow_run.head_repository.full_name == github.repository && contains(fromJSON('["schedule","workflow_dispatch","repository_dispatch","push"]'), github.event.workflow_run.event))) &&
  !(github.event_name == 'pull_request_target' && github.event.action == 'synchronize') &&
  !(github.event_name == 'repository_dispatch' && github.event.client_payload.activity.type == 'pull_request_target' && github.event.client_payload.activity.action == 'synchronize') &&
  !(github.event_name == 'workflow_run' && contains(fromJSON('["success","neutral","skipped"]'), github.event.workflow_run.conclusion))
}}`),
);

// GitHub string comparisons and contains are case-insensitive; missing property
// dereferences yield an empty string. These operands are strings or missing.
const string = (value) => {
  assert.ok(value === undefined || typeof value === "string", "string-only fixture domain");
  return (value ?? "").toLowerCase();
};
const equal = (left, right) => string(left) === string(right);
const contains = (values, value) => values.some((candidate) => equal(candidate, value));
function admitted(github) {
  const event = github.event;
  return (
    (!equal(github.event_name, "workflow_run") ||
      (equal(event.workflow_run?.head_repository?.full_name, github.repository) &&
        contains(
          JSON.parse('["schedule","workflow_dispatch","repository_dispatch","push"]'),
          event.workflow_run?.event,
        ))) &&
    !(equal(github.event_name, "pull_request_target") && equal(event.action, "synchronize")) &&
    !(
      equal(github.event_name, "repository_dispatch") &&
      equal(event.client_payload?.activity?.type, "pull_request_target") &&
      equal(event.client_payload?.activity?.action, "synchronize")
    ) &&
    !(
      equal(github.event_name, "workflow_run") &&
      contains(JSON.parse('["success","neutral","skipped"]'), event.workflow_run?.conclusion)
    )
  );
}

const repository = "openclaw/clawsweeper";
function context(headRepository = repository, conclusion = "failure", runEvent = "schedule") {
  return {
    repository,
    event_name: "workflow_run",
    event: {
      action: "completed",
      repository: { full_name: repository, default_branch: "main" },
      sender: { login: "fixture-user" },
      workflow_run: {
        id: 42,
        run_number: 1,
        name: "sweep",
        status: "completed",
        conclusion,
        event: runEvent,
        head_repository: { full_name: headRepository },
        head_sha: "a".repeat(40),
        html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
      },
    },
  };
}

assert.equal(admitted(context()), true);
assert.equal(admitted(context("fixture/fork")), false);
assert.equal(admitted(context("OPENCLAW/CLAWSWEEPER")), true);
assert.equal(admitted(context(undefined, "FAILURE")), true);
for (const conclusion of ["success", "NEUTRAL", "skipped"])
  assert.equal(admitted(context(repository, conclusion)), false);
const missingHead = context();
delete missingHead.event.workflow_run.head_repository;
assert.equal(admitted(missingHead), false);
for (const runEvent of ["pull_request_target", "pull_request", "issue_comment"])
  assert.equal(admitted(context(repository, "failure", runEvent)), false);
const missingEvent = context();
delete missingEvent.event.workflow_run.event;
assert.equal(admitted(missingEvent), false);
for (const runEvent of ["workflow_dispatch", "REPOSITORY_DISPATCH", "push"])
  assert.equal(admitted(context(repository, "failure", runEvent)), true);
assert.equal(admitted({ repository, event_name: "issues", event: {} }), true);
assert.equal(
  admitted({ repository, event_name: "pull_request_target", event: { action: "synchronize" } }),
  false,
);
assert.equal(
  admitted({
    repository,
    event_name: "repository_dispatch",
    event: { client_payload: { activity: { type: "pull_request_target", action: "synchronize" } } },
  }),
  false,
);
assert.equal(admitted({ repository, event_name: "repository_dispatch", event: {} }), true);

const token = "synthetic-hook-boundary-token";
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  // Never persist the bearer token, even though this one is synthetic.
  requests.push({
    method: request.method,
    path: request.url,
    authenticated: request.headers.authorization === `Bearer ${token}`,
    authorization: "Bearer <redacted>",
    idempotencyKey: request.headers["idempotency-key"],
    body: JSON.parse(body),
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      runId: "synthetic-hook-run",
      completion: {
        status: "ok",
        replyDisposition: "empty",
        delivered: false,
        deliveryAttempted: false,
      },
    }),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const [scenario, fixture, expected] of [
    ["fork-origin", context("fixture/fork"), false],
    // pull_request_target runs report the base repository as head_repository.
    ["pull-request-target-origin", context(repository, "failure", "pull_request_target"), false],
    ["same-repository", context(), true],
  ]) {
    const eventPath = resolve(output, `${scenario}.event.json`);
    const eventSource = `${JSON.stringify(fixture.event, null, 2)}\n`;
    writeFileSync(eventPath, eventSource);
    const jobAdmitted = admitted(fixture);
    assert.equal(jobAdmitted, expected);
    const before = requests.length;
    let notifier = null;
    if (jobAdmitted) {
      // This is the package script's actual CLI entry, with no fetch/function mock.
      assert.equal(
        JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts[
          "repair:notify-github-activity"
        ],
        "node dist/repair/notify-github-activity.js",
      );
      const child = spawn(
        process.execPath,
        [
          "dist/repair/notify-github-activity.js",
          "--write-report",
          "--strict",
          "--report",
          resolve(output, `${scenario}.report.json`),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            GITHUB_EVENT_NAME: fixture.event_name,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: repository,
            GITHUB_STEP_SUMMARY: resolve(output, `${scenario}.step-summary.md`),
            CLAWSWEEPER_OPENCLAW_HOOK_URL: `${origin}/hooks`,
            CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: token,
            CLAWSWEEPER_OPENCLAW_AGENT_ID: "fixture-agent",
            CLAWSWEEPER_DISCORD_TARGET: "channel:synthetic-proof",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const [code] = await once(child, "close");
      assert.equal(code, 0, stderr.replaceAll(token, "<redacted>"));
      notifier = JSON.parse(stdout);
      assert.equal(notifier.sent, 1);
      assert.equal(notifier.failed, 0);
    }
    const received = requests.slice(before);
    assert.equal(received.length, expected ? 1 : 0);
    if (expected) {
      assert.equal(received[0].method, "POST");
      assert.equal(received[0].path, "/hooks/agent");
      assert.equal(received[0].authenticated, true);
      assert.equal(received[0].body.agentId, "fixture-agent");
      assert.equal(received[0].body.deliver, false);
      assert.match(received[0].body.message, /workflow_run/);
      assert.match(received[0].body.message, /failure/);
      assert.equal(received[0].idempotencyKey, received[0].body.idempotencyKey);
    }
    results.push({
      scenario,
      job: jobAdmitted ? "admitted" : "skipped",
      notifierInvoked: jobAdmitted,
      hookRequests: received.length,
      authenticatedHookRequests: received.filter((request) => request.authenticated).length,
      fixtureSha256: createHash("sha256").update(eventSource).digest("hex"),
      notifier,
    });
  }
  const summary = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    provider: `local-${process.platform}`,
    node: process.version,
    image: null,
    lease: null,
    workflow: workflowPath,
    workflowSha256: createHash("sha256").update(workflowSource).digest("hex"),
    expression,
    evaluator: "exact-expression, string-only GitHub semantics; implicit success() assumed",
    results,
    trace: "requests.json",
    artifact: "summary.json",
    limits:
      "Offline job admission plus real notifier CLI/HTTP on loopback. Assumes successful setup and sufficient API budget; no hosted Actions scheduler, checkout, secret provisioning, GitHub API, external hook, or Discord delivery exercised.",
  };
  writeFileSync(resolve(output, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  assert.ok(!json.includes(token));
  writeFileSync(resolve(output, "summary.json"), json);
  process.stdout.write(json);
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
