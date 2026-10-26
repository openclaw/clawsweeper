#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "../..");
const output = path.resolve(process.env.STOP_PROOF_OUTPUT || ".artifacts/stop-hold-loopback");
const baseline = process.env.STOP_PROOF_BASELINE === "1";
const hold = "clawsweeper:human-review";
const protection = ["clawsweeper:autofix", "clawsweeper:automerge", "clawsweeper:merge-ready"];
const temporary = path.join(output, `runtime-${process.pid}`);
fs.mkdirSync(temporary, { recursive: true });
const gh = path.join(temporary, "gh.mjs");
fs.writeFileSync(
  gh,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const inputIndex = args.indexOf("--input");
const input = inputIndex < 0 ? null : (await import("node:fs")).readFileSync(args[inputIndex + 1], "utf8");
const response = await fetch(process.env.GITHUB_API_URL, {method:"POST", body:JSON.stringify({args,input})});
const body = await response.json();
if (!response.ok) { console.error("gh: " + body.message + " (HTTP " + response.status + ")"); process.exit(1); }
console.log(JSON.stringify(args.includes("--slurp") ? [body] : body));
`,
  { mode: 0o755 },
);
let state;
let invocation = 0;
const traces = [];
const comment = {
  id: 100,
  body: "@clawsweeper stop",
  issue_url: "https://api.github.com/repos/openclaw/stop-proof/issues/1",
  html_url: "https://github.com/openclaw/stop-proof/issues/1#issuecomment-100",
  user: { login: "maintainer", id: 42 },
  author_association: "MEMBER",
  created_at: "2026-10-26T20:00:00Z",
  updated_at: "2026-10-26T20:00:00Z",
};
const server = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { args, input } = JSON.parse(body);
  const trace = { scenario: state.name, args, before: [...state.labels] };
  traces.push(trace);
  function reply(value, code = 200) {
    trace.after = [...state.labels];
    trace.status = code;
    response.writeHead(code, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }
  if (args[0] === "api") {
    const endpoint = args.find((a) => a === "user" || a.startsWith("repos/"));
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    if (endpoint === "user") return reply({ login: "openclaw-clawsweeper[bot]" });
    if (endpoint.includes("/collaborators/")) return reply({ permission: "admin" });
    if (endpoint.includes("/reactions")) return reply([]);
    if (endpoint === "repos/openclaw/stop-proof/issues/comments/100") return reply(comment);
    if (endpoint.startsWith("repos/openclaw/stop-proof/issues/1/comments")) {
      if (method === "POST") {
        state.replies.push(JSON.parse(input).body);
        return reply({ id: 200 });
      }
      return reply([
        comment,
        ...state.replies.map((b, i) => ({
          id: 200 + i,
          body: b,
          user: { login: "openclaw-clawsweeper[bot]" },
        })),
      ]);
    }
    if (endpoint === "repos/openclaw/stop-proof/issues/1") {
      if (state.mode === "read-fail" && state.adds > 0)
        return reply({ message: "read forbidden" }, 403);
      return reply({
        number: 1,
        state: "open",
        locked: false,
        title: "Stop proof",
        body: "controlled fixture",
        user: { login: "contributor" },
        labels: state.labels.map((name) => ({ name })),
        ...(state.pull ? { pull_request: { url: "fixture" } } : {}),
      });
    }
  }
  if (args[0] === "pr" && args[1] === "view")
    return reply({
      headRefName: "fixture",
      headRefOid: "a".repeat(40),
      author: { login: "contributor" },
      body: "fixture",
      title: "Fixture PR",
      labels: state.labels.map((name) => ({ name })),
      files: [],
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      state: "OPEN",
      statusCheckRollup: [],
      reviewDecision: "",
    });
  if (args[0] === "label" && args[1] === "create") return reply({ message: "already exists" }, 422);
  if (args[0] === "issue" && args[1] === "edit") {
    const add = args.indexOf("--add-label");
    const remove = args.indexOf("--remove-label");
    if (add >= 0) {
      state.adds++;
      if (state.mode === "forbidden")
        return reply({ message: "Resource not accessible by integration" }, 403);
      if (state.mode === "transient") return reply({ message: "Service Unavailable" }, 503);
      if (state.mode !== "silent-noop")
        state.labels = [...new Set([...state.labels, args[add + 1]])];
      if (state.mode === "lost-response") {
        trace.after = [...state.labels];
        trace.status = "socket_lost";
        response.destroy();
        return;
      }
    }
    if (remove >= 0) {
      state.removes++;
      if (state.mode === "remove-fail")
        return reply({ message: "Resource not accessible by integration" }, 403);
      state.labels = state.labels.filter((label) => label !== args[remove + 1]);
    }
    return reply({});
  }
  return reply({ message: "Unhandled fixture operation: " + JSON.stringify(args) }, 400);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = [];
try {
  for (const pull of [false, true]) {
    for (const mode of baseline
      ? ["forbidden"]
      : [
          "forbidden",
          "transient",
          "lost-response",
          "silent-noop",
          "read-fail",
          "success",
          "existing-hold",
          "remove-fail",
        ]) {
      state = {
        name: `${pull ? "pr" : "issue"}-${mode}`,
        pull,
        mode,
        labels: [...protection, ...(mode === "existing-hold" ? [hold] : [])],
        replies: [],
        adds: 0,
        removes: 0,
      };
      const root = path.join(temporary, state.name);
      fs.mkdirSync(root, { recursive: true });
      fs.cpSync(path.join(source, "dist"), path.join(root, "dist"), { recursive: true });
      fs.cpSync(path.join(source, "config"), path.join(root, "config"), { recursive: true });
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        GH_BIN: gh,
        GH_TOKEN: "synthetic-loopback-only",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "F1 stop hold proof",
        GITHUB_JOB: "proof",
        GITHUB_RUN_STARTED_AT: "2026-10-26T20:00:00Z",
        CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
        CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
        CLAWSWEEPER_ACTION_LEDGER_ROOT: path.join(root, "events"),
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: path.join(root, "event-output"),
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
      };
      fs.mkdirSync(path.join(root, "events"), { recursive: true });
      fs.mkdirSync(path.join(root, "event-output"), { recursive: true });
      const first = await run(root, env);
      const beforeRetry = structuredClone(state);
      const events = readEvents(path.join(root, "events"));
      let retry;
      if (baseline) {
        assert.equal(first.code, 0, first.stderr);
        assert.equal(state.labels.length, 0);
        assert.match(state.replies[0], /I added.*clawsweeper:human-review/);
        assert.equal(readLedger(root).commands[0].status, "executed");
      } else if (["success", "existing-hold"].includes(mode)) {
        assert.equal(first.code, 0, first.stderr);
        assert.deepEqual(state.labels, [hold]);
        if (mode === "existing-hold") assert.equal(state.adds, 0);
      } else {
        assert.notEqual(first.code, 0, first.stdout);
        assert.equal(state.replies.length, 0);
        for (const label of protection) assert.ok(state.labels.includes(label));
        assert.ok(!readLedger(root)?.commands?.some((c) => c.status === "executed"));
        assert.ok(
          events.some((e) => e.event_type === "command.failed"),
          JSON.stringify(events) + first.stderr,
        );
        assert.ok(!events.some((e) => e.event_type === "command.completed"));
        if (["forbidden", "transient", "lost-response", "silent-noop", "read-fail"].includes(mode))
          assert.equal(state.removes, 0);
        if (mode === "lost-response") {
          assert.ok(state.labels.includes(hold));
          assert.ok(
            events.some((e) => e.attributes?.completion_reason === "mutation_outcome_unknown"),
          );
        }
      }
      if (!baseline && mode !== "silent-noop") {
        state.mode = "success";
        const addsBefore = state.adds;
        retry = await run(root, env);
        assert.equal(retry.code, 0, retry.stderr);
        assert.deepEqual(state.labels, [hold]);
        assert.equal(state.replies.length, 1);
        if (
          ["lost-response", "existing-hold", "read-fail", "remove-fail", "success"].includes(mode)
        )
          assert.equal(state.adds, addsBefore);
        const writes = state.adds + state.removes;
        const replay = await run(root, env);
        assert.equal(replay.code, 0, replay.stderr);
        assert.equal(state.adds + state.removes, writes);
        assert.equal(state.replies.length, 1);
      }
      results.push({
        scenario: beforeRetry.name,
        first: {
          ...first,
          labels: beforeRetry.labels,
          replies: beforeRetry.replies,
          adds: beforeRetry.adds,
          removes: beforeRetry.removes,
        },
        retry,
        events,
      });
    }
  }
  const result = {
    ok: true,
    baseline,
    transport: "real production CLI via gh-compatible child and loopback HTTP",
    routerSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(source, "dist/repair/comment-router.js")))
      .digest("hex"),
    scenarios: results,
    traces,
    limits:
      "Synthetic GitHub-compatible service; no live GitHub mutation, production queue or permission assertion.",
  };
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      ok: true,
      baseline,
      scenarios: results.map((r) => ({
        name: r.scenario,
        firstExit: r.first.code,
        labels: r.first.labels,
        successReplies: r.first.replies.length,
        retryExit: r.retry?.code,
      })),
      artifact: path.join(output, "result.json"),
      transport: result.transport,
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
function run(root, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, "dist/repair/comment-router.js"),
        "--repo",
        "openclaw/stop-proof",
        "--comment-ids",
        "100",
        "--item-numbers",
        "1",
        "--execute",
      ],
      { cwd: root, env: { ...env, CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `proof-${++invocation}` } },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
function readLedger(root) {
  const file = path.join(root, "results/comment-router.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function readEvents(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? readEvents(path.join(root, entry.name))
        : entry.name.endsWith(".json")
          ? [JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"))]
          : [],
    );
}
