#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { parseArgs } from "node:util";
import {
  itemSourceRevisionSha256ForTest,
  renderReviewCommentFromReport,
  renderReviewStartStatusComment,
} from "../../dist/clawsweeper.js";
import { createReviewedPrActivityCursorV2 } from "../../dist/review-activity-cursor.js";

const source = resolve(import.meta.dirname, "../..");
const { values } = parseArgs({
  options: {
    gh: { type: "string" },
    output: { type: "string" },
    "baseline-ref": { type: "string" },
  },
});
assert.ok(values.gh?.startsWith("/"), "--gh must select the absolute stock GitHub CLI path");
assert.ok(values.output, "--output must select a new evidence directory");
const output = resolve(values.output);
assert.ok(!existsSync(output), "refusing to overwrite proof evidence");
mkdirSync(output, { recursive: true });
const socketRoot = realpathSync(mkdtempSync(join(tmpdir(), "review-proof-")));
const root = join(output, "runtime");
mkdirSync(root);
for (const name of ["dist", "config", "schema", "prompts", "package.json"])
  cpSync(join(source, name), join(root, name), { recursive: true });
symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
if (values["baseline-ref"]) {
  // Recompile only this repair's owner from the specified Git revision in the disposable runtime.
  const prior = execFileSync(
    "git",
    ["show", `${values["baseline-ref"]}:src/clawsweeper-review-comment-state.ts`],
    { cwd: source, encoding: "utf8" },
  );
  writeFileSync(
    join(root, "dist/clawsweeper-review-comment-state.js"),
    stripTypeScriptTypes(prior, { mode: "transform" }),
  );
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const repo = "openclaw/openclaw";
const number = 321;
const head = "a".repeat(40);
const durableId = 9321;
const leaseId = 700321;
const leaseOwner = "exact-review-freshness-proof";
const minute = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
const reviewedAt = new Date(minute + 45_000).toISOString();
const itemUpdatedAt = new Date(minute - 120_000).toISOString();
const churnAt = new Date(minute + 50_000).toISOString();
const humanReview = {
  id: 7001,
  user: { login: "fixture-reviewer" },
  state: "COMMENTED",
  body: "Earlier synthetic review.",
  submitted_at: "2026-09-04T00:00:00Z",
  commit_id: head,
};
const cursor = createReviewedPrActivityCursorV2({
  reviews: [humanReview],
  inlineComments: [],
  reviewThreads: [],
});
const issue = {
  number,
  title: "Synthetic exact review freshness",
  body: "A synthetic unchanged patch.",
  html_url: `https://github.com/${repo}/pull/${number}`,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: itemUpdatedAt,
  state: "open",
  locked: false,
  author_association: "CONTRIBUTOR",
  user: { login: "fixture-author" },
  labels: ["rating: 🧂 unranked krab", "status: 📣 needs proof"],
  pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
};
const revision = itemSourceRevisionSha256ForTest(issue, []);
let kind = "pull_request";
const baseReport = (time, lease) => `---
repository: ${repo}
number: ${number}
type: ${kind}
title: ${issue.title}
url: ${issue.html_url}
author: fixture-author
author_association: CONTRIBUTOR
reviewed_at: ${time}
item_updated_at: ${itemUpdatedAt}
item_snapshot_hash: synthetic-proof-snapshot
item_source_revision: ${revision}
review_timeline_revision: ${hash("[]")}
review_activity_cursor: ${cursor}
${kind === "pull_request" ? `pull_head_sha: ${head}\n` : ""}review_lease_owner: ${leaseOwner}
review_lease_comment_id: ${lease}
review_status: complete
local_checkout_access: verified
local_checkout_access_source: runner_preflight_v1
decision: keep_open
action_taken: kept_open
close_reason: none
confidence: high
work_candidate: none
work_status: none
labels: ${JSON.stringify(issue.labels)}
---

## Summary

Synthetic unchanged review.
`;
const render = (report) =>
  `${renderReviewCommentFromReport(report, "none").trimEnd()}\n\n<!-- clawsweeper-review item=${number} -->`;
let comments = [];
let phase;
const trace = [];
const results = [];
let nextCommentId = leaseId + 100;
const comment = (id, body, updatedAt) => ({
  id,
  html_url: `${issue.html_url}#issuecomment-${id}`,
  user: { login: "clawsweeper[bot]" },
  created_at: updatedAt,
  updated_at: updatedAt,
  body,
});
const server = createServer(async (request, response) => {
  let event;
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(request.url, "http://proof.invalid");
    const path = url.pathname.replace(/^\/api\/v3/, "").replace(/^\/api\/graphql$/, "/graphql");
    event = { phase, method: request.method, path, ...(body ? { body } : {}) };
    trace.push(event);
    const send = (value, code = 200) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(code === 204 ? "" : JSON.stringify(value));
    };
    if (path === "/graphql") {
      if (body.query.includes("closedByPullRequestsReferences"))
        return send({
          data: {
            repository: {
              hasIssuesEnabled: true,
              issue: { number, closedByPullRequestsReferences: { nodes: [] } },
            },
          },
        });
      const connection = (nodes) => ({
        totalCount: nodes.length,
        pageInfo: { hasNextPage: false },
        nodes,
      });
      assert.match(body.query, /ReviewedPrActivityCursorV2/);
      return send({
        data: {
          repository: {
            [`pr_${number}`]: {
              reviews: connection([
                {
                  fullDatabaseId: String(humanReview.id),
                  author: humanReview.user,
                  state: humanReview.state,
                  body: humanReview.body,
                  submittedAt: humanReview.submitted_at,
                  commit: { oid: head },
                },
              ]),
              reviewThreads: connection([]),
            },
          },
        },
      });
    }
    const prefix = `/repos/${repo}`;
    if (path === "/search/issues") return send({ items: [] });
    if (path === `${prefix}/issues/${number}/comments`) {
      if (request.method === "GET") return send(comments);
      assert.equal(request.method, "POST");
      const created = comment(++nextCommentId, body.body, new Date().toISOString());
      comments.push(created);
      issue.updated_at = created.updated_at;
      return send(created, 201);
    }
    const commentId = /^\/repos\/openclaw\/openclaw\/issues\/comments\/(\d+)$/.exec(path)?.[1];
    if (commentId) {
      const selected = comments.find((entry) => entry.id === Number(commentId));
      assert.ok(selected, "comment target must exist");
      if (request.method === "GET") return send(selected);
      if (request.method === "DELETE") {
        assert.notEqual(selected.id, durableId, "durable review cannot be deleted");
        comments = comments.filter((entry) => entry !== selected);
        return send(null, 204);
      }
      assert.equal(request.method, "PATCH");
      selected.body = body.body;
      selected.updated_at = new Date().toISOString();
      issue.updated_at = selected.updated_at;
      return send(selected);
    }
    assert.equal(request.method, "GET", "only comment mutations are allowed");
    if (path === `${prefix}/issues/${number}`) return send({ ...issue, comments: comments.length });
    if (path === `${prefix}/pulls/${number}`)
      return send({
        ...issue,
        comments: comments.length,
        changed_files: 0,
        commits: 0,
        review_comments: 0,
        draft: false,
        merged: false,
        head: { sha: head, ref: "fixture", repo: { full_name: repo } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: repo } },
      });
    if (path === `${prefix}/issues/${number}/timeline`)
      return send(
        comments.map((entry) => ({
          id: entry.id,
          event: "commented",
          actor: entry.user,
          created_at: entry.created_at,
        })),
      );
    if (path === `${prefix}/pulls/${number}/reviews`) return send([humanReview]);
    if (
      ["files", "commits", "comments"].some((kind) => path === `${prefix}/pulls/${number}/${kind}`)
    )
      return send([]);
    if (path === `${prefix}/commits/${head}/check-runs`)
      return send({ total_count: 0, check_runs: [] });
    if (path === `${prefix}/commits/${head}/status`) return send({ total_count: 0, statuses: [] });
    throw new Error(`unsupported proof request ${request.method} ${path}`);
  } catch (error) {
    if (event) event.error = error.message;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: error.message }));
  }
});
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: root,
  GH_CONFIG_DIR: join(root, "gh-config"),
  GH_HOST: "proof.invalid",
  GH_ENTERPRISE_TOKEN: "synthetic-proof-token",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_BIN: values.gh,
  CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
  CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
  TMPDIR: root,
};
async function command(file, args) {
  const child = spawn(file, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}
try {
  const socket = join(socketRoot, "gh.sock");
  await new Promise((ready) => server.listen(socket, ready));
  await command(values.gh, ["config", "set", "http_unix_socket", socket]);
  for (const [name, itemKind, oldReviewedAt] of [
    ["same-minute-issue", "issue", new Date(minute + 5_000).toISOString()],
    ["same-minute-pr", "pull_request", new Date(minute + 5_000).toISOString()],
    ["expired-pr", "pull_request", new Date(minute - 24 * 60 * 60 * 1000).toISOString()],
  ]) {
    kind = itemKind;
    issue.pull_request =
      kind === "pull_request"
        ? { url: `https://api.github.com/repos/${repo}/pulls/${number}` }
        : null;
    issue.html_url = `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`;
    issue.labels =
      kind === "pull_request"
        ? ["rating: 🧂 unranked krab", "status: 📣 needs proof"]
        : ["issue-rating: 🧂 unranked krab"];
    const scenario = join(root, name);
    const items = join(scenario, "items");
    mkdirSync(items, { recursive: true });
    const oldBody = render(baseReport(oldReviewedAt, leaseId - 1));
    comments = [
      comment(durableId, oldBody, oldReviewedAt),
      comment(
        leaseId,
        renderReviewStartStatusComment({
          number,
          kind,
          title: issue.title,
          headSha: kind === "pull_request" ? head : revision,
          startedAt: new Date(minute).toISOString(),
          leaseExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          leaseOwner,
        }),
        churnAt,
      ),
      comment(
        leaseId + 1,
        `Waiting for review.\n<!-- clawsweeper-command-status:${number}:re_review:fixture -->`,
        churnAt,
      ),
    ];
    issue.updated_at = churnAt;
    comments[0].updated_at = churnAt;
    const report = baseReport(reviewedAt, leaseId).replace(
      /^---\n/,
      `---\nreview_comment_id: ${durableId}\nreview_comment_url: ${issue.html_url}#issuecomment-${durableId}\nreview_comment_sha256: ${hash(oldBody)}\nreview_comment_synced_at: ${oldReviewedAt}\n`,
    );
    writeFileSync(join(items, `${number}.md`), report);
    const args = [
      join(root, "dist/clawsweeper.js"),
      "apply-decisions",
      "--target-repo",
      repo,
      "--skip-dashboard",
      "--item-number",
      String(number),
      "--items-dir",
      items,
      "--closed-dir",
      join(scenario, "closed"),
      "--plans-dir",
      join(scenario, "plans"),
      "--report-path",
      join(scenario, "apply-report.json"),
      "--sync-comments-only",
      "--comment-sync-min-age-days",
      "0",
      "--limit",
      "0",
      "--close-delay-ms",
      "0",
    ];
    phase = `${name}:publish`;
    const applied = await command(process.execPath, args);
    writeFileSync(join(output, `${name}-publish.log`), `${applied.stdout}\n${applied.stderr}`);
    const publishResult = JSON.parse(readFileSync(join(scenario, "apply-report.json"), "utf8"));
    writeFileSync(
      join(output, `${name}-published-report.md`),
      readFileSync(join(items, `${number}.md`)),
    );
    assert.equal(publishResult[0]?.action, "review_comment_synced");
    const published = comments.find((entry) => entry.id === durableId);
    writeFileSync(
      join(output, `${name}-publication.json`),
      `${JSON.stringify(
        {
          reviewStateBaselineRef: values["baseline-ref"] ?? null,
          publishResult,
          durableId,
          expectedReviewedAt: reviewedAt,
          actualVersionMarker: published.body.match(/<!-- clawsweeper-review-version[^>]*-->/)?.[0],
        },
        null,
        2,
      )}\n`,
    );
    assert.match(
      published.body,
      new RegExp(
        `clawsweeper-review-version item=${number} reviewed_at=${reviewedAt.replaceAll(".", "\\.")} sha=${kind === "pull_request" ? head : "na"}`,
      ),
    );
    const patches = () =>
      trace.filter(
        (entry) => entry.method === "PATCH" && entry.path.endsWith(`/comments/${durableId}`),
      );
    assert.equal(patches().filter((entry) => entry.phase === phase).length, 1);
    const bodyAfterPublication = published.body;
    const ack = comments.find((entry) => entry.id === leaseId + 1);
    ack.body = `Review completed.\n<!-- clawsweeper-command-status:${number}:re_review:fixture -->`;
    ack.updated_at = new Date().toISOString();
    issue.updated_at = ack.updated_at;
    phase = `${name}:retry`;
    const retried = await command(process.execPath, args);
    writeFileSync(join(output, `${name}-retry.log`), `${retried.stdout}\n${retried.stderr}`);
    assert.equal(
      patches().filter((entry) => entry.phase === phase).length,
      0,
      "same report must not rewrite the durable review",
    );
    assert.equal(comments.find((entry) => entry.id === durableId).body, bodyAfterPublication);
    const retryResult = JSON.parse(readFileSync(join(scenario, "apply-report.json"), "utf8"));
    assert.deepEqual(
      retryResult,
      [],
      "same completed report remains outside the publication queue",
    );
    assert.equal(itemSourceRevisionSha256ForTest(issue, comments), revision);
    results.push({
      name,
      kind,
      oldReviewedAt,
      reviewedAt,
      head: kind === "pull_request" ? head : null,
      durableId,
      durablePatches: 1,
      retryPatches: 0,
      publishResult,
      retryResult,
    });
  }
  assert.ok(
    trace.every((entry) => !entry.error),
    "all loopback requests must be understood",
  );
  const summary = {
    provider: "local-controlled-subprocess",
    node: process.version,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    scriptSha256: hash(readFileSync(new URL(import.meta.url))),
    reviewStateBuildSha256: hash(
      readFileSync(join(root, "dist/clawsweeper-review-comment-state.js")),
    ),
    reviewStateBaselineRef: values["baseline-ref"] ?? null,
    results,
    limits:
      "Built apply-decisions CLI and stock gh CLI against synthetic local HTTP over a Unix socket. No hosted GitHub, cloud queue, new Codex review, merge, or deployment exercised. No container or cloud lease.",
  };
  writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  writeFileSync(join(output, "http-trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  await new Promise((done) => server.close(done));
  rmSync(socketRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
