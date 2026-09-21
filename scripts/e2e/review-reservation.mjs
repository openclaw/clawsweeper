#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const output = resolve(process.argv[2] || ".artifacts/review-reservation");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "review-reservation-"));
const repo = "openclaw/reservation-fixture";
const number = 357;
const head = "a".repeat(40);
const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps || []);
const reservation = steps.find((step) => step.name === "Reserve exact review lease").run;
const sources = [
  "src/clawsweeper-review-comment-leases.ts",
  "src/clawsweeper-command-operations.ts",
  "src/clawsweeper-review-comment-state.ts",
  ".github/workflows/sweep.yml",
  "scripts/e2e/review-reservation.mjs",
];
const sourceHashes = Object.fromEntries(
  sources.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
);
const proxy = join(root, "github-fixture.cjs");
writeFileSync(
  proxy,
  `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "api") throw new Error("unexpected GitHub CLI command");
const at = args.indexOf("--method");
const method = at < 0 ? "GET" : args[at + 1];
const input = args.indexOf("--input");
fetch(process.env.RESERVATION_FIXTURE_URL + "/" + args[1], {
  method, ...(input < 0 ? {} : {body: fs.readFileSync(args[input + 1])}),
}).then(async response => {
  const text = await response.text();
  if (!response.ok) { console.error("HTTP " + response.status); process.exitCode = 1; return; }
  process.stdout.write(args.includes("--slurp") ? JSON.stringify([JSON.parse(text)]) : text);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
`,
);
const cases = [
  { name: "superseded-before-post", codes: [409], result: "superseded", posts: 0, deletes: 0 },
  { name: "valid-owner", codes: [200], result: "posted", posts: 1, deletes: 0 },
  { name: "preflight-service-recovery", codes: [503, 200], result: "posted", posts: 1, deletes: 0 },
  { name: "post-service-recovery", codes: [200, 503, 200], result: "posted", posts: 1, deletes: 0 },
  {
    name: "post-throttle-recovery",
    codes: [200, 429, 200],
    result: "posted",
    posts: 1,
    deletes: 0,
  },
  { name: "superseded-after-post", codes: [200, 409], result: "superseded", posts: 1, deletes: 1 },
  {
    name: "head-changed-after-post",
    codes: [200],
    drift: true,
    result: "superseded",
    posts: 1,
    deletes: 1,
  },
  {
    name: "other-owner-held",
    codes: [200],
    otherOwner: true,
    result: "held",
    posts: 0,
    deletes: 0,
  },
  { name: "service-unavailable", codes: [503], result: "failure", posts: 0, deletes: 0 },
];
const results = [];
try {
  for (const scenario of cases) {
    const trace = [];
    const comments = [];
    let checks = 0;
    let currentHead = head;
    let nextId = 1000;
    if (scenario.otherOwner)
      comments.push({
        id: 999,
        user: { login: "clawsweeper[bot]" },
        body: `<!-- clawsweeper-review-status:started item=${number} sha=${head} started_at=${new Date().toISOString()} lease_expires_at=${new Date(Date.now() + 600_000).toISOString()} owner=github-run-998-1 v=1 -->\n<!-- clawsweeper-review-lease item=${number} -->`,
      });
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const path = new URL(request.url, "http://localhost").pathname;
      const event = { method: request.method, path };
      trace.push(event);
      const send = (code, value) => {
        event.code = code;
        response.writeHead(code, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (path === "/internal/exact-review/heartbeat") {
        assert.equal(JSON.parse(body).source_head_sha, head);
        const code = scenario.codes[Math.min(checks++, scenario.codes.length - 1)];
        return send(
          code,
          code === 200
            ? { ok: true }
            : { error: code === 409 ? "lease_not_active" : "fixture_unavailable" },
        );
      }
      if (path === `/repos/${repo}/issues/${number}`)
        return send(200, {
          number,
          title: "Synthetic reservation proof",
          state: "open",
          locked: false,
          html_url: `https://github.com/${repo}/pull/${number}`,
          user: { login: "fixture-author" },
          labels: [],
          pull_request: {},
          created_at: "2026-09-21T00:00:00Z",
          updated_at: "2026-09-21T00:00:00Z",
        });
      if (path === `/repos/${repo}/pulls/${number}`)
        return send(200, { head: { sha: currentHead } });
      if (path === `/repos/${repo}/issues/${number}/comments`) {
        if (request.method === "GET") return send(200, comments);
        assert.equal(request.method, "POST");
        const comment = {
          id: nextId++,
          user: { login: "clawsweeper[bot]" },
          body: JSON.parse(body).body,
        };
        event.commentId = comment.id;
        comments.push(comment);
        if (scenario.drift) currentHead = "b".repeat(40);
        return send(201, comment);
      }
      if (request.method === "DELETE" && path.startsWith(`/repos/${repo}/issues/comments/`)) {
        const id = Number(path.split("/").at(-1));
        const index = comments.findIndex((comment) => comment.id === id);
        assert.ok(index >= 0);
        comments.splice(index, 1);
        event.commentId = id;
        return send(200, {});
      }
      send(404, { error: "unexpected_fixture_path" });
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const url = `http://127.0.0.1:${server.address().port}`;
    const githubOutput = join(root, `${scenario.name}.output`);
    writeFileSync(githubOutput, "");
    try {
      const child = spawn("bash", ["-c", reservation], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          ...(process.env.COREPACK_HOME ? { COREPACK_HOME: process.env.COREPACK_HOME } : {}),
          GH_BIN: "/usr/bin/env",
          GH_BIN_ARGS: JSON.stringify(["-u", "NODE_V8_COVERAGE", process.execPath, proxy]),
          ...(process.env.NODE_V8_COVERAGE
            ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }
            : {}),
          GH_TOKEN: "synthetic-fixture-no-live-access",
          RESERVATION_FIXTURE_URL: url,
          TARGET_REPO: repo,
          ITEM_NUMBER: String(number),
          CODEX_TIMEOUT_MS: "1000",
          MEDIA_PROOF_TIMEOUT_MS: "0",
          GITHUB_OUTPUT: githubOutput,
          GITHUB_RUN_ID: "999",
          GITHUB_RUN_ATTEMPT: "1",
          EXACT_REVIEW_QUEUE_URL: url,
          EXACT_REVIEW_ITEM_KEY: `${repo}#${number}`,
          EXACT_REVIEW_LEASE_ID: "fixture-lease",
          EXACT_REVIEW_LEASE_REVISION: "3",
          EXACT_REVIEW_CLAIM_GENERATION: "1",
          EXACT_REVIEW_SOURCE_HEAD_SHA: head,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      const exitCode = await new Promise((resolveExit, reject) => {
        child.on("error", reject);
        child.on("close", resolveExit);
      }).finally(() => clearTimeout(timer));
      const outputs = Object.fromEntries(
        readFileSync(githubOutput, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")),
      );
      const posts = trace.filter(
        (event) => event.method === "POST" && event.path.endsWith("/comments"),
      );
      const deletes = trace.filter((event) => event.method === "DELETE");
      writeFileSync(join(output, `${scenario.name}.trace.json`), JSON.stringify(trace, null, 2));
      assert.equal(
        exitCode === 0,
        scenario.result !== "failure",
        `${scenario.name}: ${stdout}\n${stderr}`,
      );
      assert.equal(outputs.status || "failure", scenario.result, scenario.name);
      assert.equal(posts.length, scenario.posts, scenario.name);
      assert.equal(deletes.length, scenario.deletes, scenario.name);
      assert.equal(
        comments.length,
        scenario.otherOwner ? 1 : scenario.posts - scenario.deletes,
        scenario.name,
      );
      if (scenario.name === "service-unavailable") assert.equal(checks, 5);
      if (scenario.name === "superseded-before-post") assert.equal(checks, 1);
      if (outputs.status === "posted") assert.equal(Number(outputs.comment_id), posts[0].commentId);
      const result = {
        name: scenario.name,
        exitCode,
        status: outputs.status || "failure",
        checks,
        posts: posts.length,
        deletes: deletes.length,
        remaining: comments.length,
        trace,
      };
      results.push(result);
      writeFileSync(
        join(output, `${scenario.name}.json`),
        JSON.stringify({ ...result, stdout, stderr }, null, 2),
      );
      console.log(
        `${scenario.name}: ${result.status}, POST=${posts.length}, DELETE=${deletes.length}`,
      );
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
  const summary = {
    claim:
      "Superseded reservation exits without comment churn; transient queue checks reuse the authorized worker's comment.",
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version,
    sourceHashes,
    provider: process.env.RESERVATION_PROOF_PROVIDER || "unspecified",
    lease: process.env.RESERVATION_PROOF_LEASE || "unspecified",
    image: process.env.RESERVATION_PROOF_IMAGE || "unspecified",
    limits:
      "Actual reservation workflow shell, built CLI and curl over loopback HTTP. GitHub and queue responses are controlled fixtures; no production writes or model review.",
    passed: results.length,
    results,
  };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ passed: results.length, output }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
