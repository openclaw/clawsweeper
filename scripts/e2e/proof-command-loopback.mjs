#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the compiled router, real subprocess boundary and disk ledger. Only
// GitHub is a loopback fixture. This is NOT proof of live Mantis execution.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = path.join(source, ".openclaw/tmp");
fs.mkdirSync(scratch, { recursive: true });
const temporary = fs.mkdtempSync(path.join(scratch, "proof-admission-"));
const root = path.join(temporary, "runtime");
fs.mkdirSync(root);
fs.cpSync(path.join(source, "dist"), path.join(root, "dist"), { recursive: true });
fs.cpSync(path.join(source, "config"), path.join(root, "config"), { recursive: true });
const proxy = path.join(temporary, "gh-loopback.mjs");
fs.writeFileSync(proxy, "#!/usr/bin/env node\n(" + loopbackGh.toString() + ")();\n", {
  mode: 0o755,
});
const ackOwnership = process.argv.includes("--ack-ownership");
const expectRouterWrite = process.argv.includes("--expect-router-write");
const inline = process.argv.includes("--inline") || ackOwnership;
const repository = inline ? "openclaw/openclaw" : "openclaw/proof-admission-fixture";
const intakes = [];
const head = "a".repeat(40);
let currentHead = head;
let isPullRequest = true;
let permission = "maintain";
let selected = comment(100, 1);
const posted = [];
const requests = [];
const observations = {};
let admission = "accepted";
let terminalState = null;
let terminalBody = null;
let finalizerOutput = null;
let apiUrl;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ method: request.method, path: url.pathname });
  if (url.pathname === "/internal/exact-review/command-intake") {
    intakes.push(body);
    if (admission === "unavailable") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "exact_review_queue_unavailable" }));
      return;
    }
    if (terminalState) {
      await runFinalizer(body.decision.commandStatusMarker, terminalState);
      terminalBody = posted.at(-1).body;
    }
    return json(response, {
      ok: true,
      accepted: admission !== "stale",
      deduped: admission === "deduped",
      ...(admission === "stale" ? { reason: "source_comment_changed" } : {}),
      command_version_id: body.commandVersionId,
    });
  }
  const prefix = "/repos/" + repository;
  const number = Number(url.pathname.match(/\/issues\/(\d+)/)?.[1]);
  if (url.pathname === "/user") return json(response, { login: "clawsweeper[bot]" });
  if (url.pathname.startsWith("/__pull/")) {
    return json(response, {
      number: selected.issueNumber,
      state: "OPEN",
      headRefOid: currentHead,
      headRefName: "fixture",
      author: { login: "reporter" },
      labels: [],
      body: "Fixture retains code/security/CI blockers.",
      title: "Proof fixture",
      statusCheckRollup: [{ name: "ci", conclusion: "FAILURE", status: "COMPLETED" }],
    });
  }
  if (url.pathname.endsWith("/permission")) return json(response, { permission });
  if (url.pathname.endsWith("/reactions")) {
    return json(response, request.method === "GET" ? [] : { id: 1 });
  }
  if (url.pathname === prefix + "/issues/comments/" + selected.id) return json(response, selected);
  const existing = posted.find((entry) => url.pathname === prefix + "/issues/comments/" + entry.id);
  if (existing && request.method === "GET") return json(response, existing);
  if (existing && request.method === "PATCH") {
    existing.body = body.body;
    existing.updated_at = new Date().toISOString();
    return json(response, existing);
  }
  if (url.pathname === prefix + "/issues") return json(response, []);
  if (url.pathname === prefix + "/issues/" + number + "/comments") {
    if (request.method === "POST") {
      const result = {
        ...comment(10000 + posted.length, number),
        body: body.body,
        user: { login: "clawsweeper[bot]" },
      };
      posted.push(result);
      return json(response, result);
    }
    return json(response, [selected, ...posted.filter((entry) => entry.issueNumber === number)]);
  }
  if (url.pathname === prefix + "/issues/" + number) {
    return json(response, {
      number,
      state: "open",
      title: "Proof fixture",
      body: "Unchanged proof/code/security/CI blockers.",
      locked: false,
      labels: [],
      user: { login: "reporter" },
      ...(isPullRequest ? { pull_request: { url: "fixture" } } : {}),
    });
  }
  response.writeHead(422, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      message: "Unexpected fixture request " + request.method + " " + url.pathname,
    }),
  );
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  apiUrl = "http://127.0.0.1:" + address.port;
  if (ackOwnership) {
    const receipts = [];
    for (const intent of ["re-review", "proof"]) {
      for (const outcome of ["accepted", "deduped"]) {
        for (const state of ["Complete", "Failed"]) {
          selected = { ...comment(300 + receipts.length, 1), body: `@clawsweeper ${intent}` };
          admission = outcome;
          terminalState = state;
          const ack = seedAcknowledgement();
          const start = requests.length;
          const routed = (await runRouter(apiUrl)).commands[0];
          const writes = requests.slice(start).filter(isCommentWrite);
          assert.equal(routed.status, "executed");
          assert.match(finalizerOutput, /terminal_status_verified=true/);
          const baselineOverwrites = expectRouterWrite && intent === "re-review";
          assert.equal(ack.body === terminalBody, !baselineOverwrites);
          assert.equal(writes.length, expectRouterWrite ? 2 : 1);
          assert.equal(writes[0].method, "PATCH");
          const duplicateReplies = writes.filter((write) => write.method === "POST").length;
          assert.equal(duplicateReplies, expectRouterWrite && intent === "proof" ? 1 : 0);
          assert.equal(posted.filter((entry) => entry.id === ack.id).length, 1);
          const commentAction = routed.actions.find((action) => action.action === "comment");
          assert.equal(commentAction.status, expectRouterWrite ? "executed" : "skipped");
          receipts.push({
            intent,
            admission,
            state,
            terminalPreserved: ack.body === terminalBody,
            finalizerVerified: true,
            commentWrites: writes.length,
            duplicateReplies,
            routerStatus: routed.status,
          });
        }
      }
    }
    terminalState = null;
    for (const outcome of ["accepted", "stale"]) {
      selected = { ...comment(400 + receipts.length, 1), body: "@clawsweeper re-review" };
      admission = outcome;
      const start = requests.length;
      const routed = (await runRouter(apiUrl)).commands[0];
      const writes = requests.slice(start).filter(isCommentWrite);
      assert.equal(writes.length, expectRouterWrite ? 1 : 0);
      assert.equal(
        routed.status,
        outcome === "stale" && !expectRouterWrite ? "skipped" : "executed",
      );
      if (outcome === "stale" && !expectRouterWrite)
        assert.equal(routed.reason, "source_comment_changed");
      receipts.push({ admission, scenario: "ack-not-yet-created", commentWrites: writes.length });
    }
    selected = { ...comment(500, 1), body: "@clawsweeper re-review" };
    admission = "unavailable";
    const beforeFailure = requests.length;
    await assert.rejects(runRouter(apiUrl), /503|exact_review_queue_unavailable/);
    assert.equal(requests.slice(beforeFailure).filter(isCommentWrite).length, 0);
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "results/comment-router.json"), "utf8"),
    );
    assert.ok(
      ledger.commands.some(
        (entry) => String(entry.comment_id) === "300" && entry.status === "executed",
      ),
    );
    console.log(
      JSON.stringify({
        ok: true,
        baseline: expectRouterWrite,
        receipts,
        intakeFailurePropagated: true,
        diskLedgerRecorded: true,
        limits:
          "Production router/finalizer CLIs and signed curl intake; synthetic loopback GitHub and admission responses, no live queue scheduling or GitHub mutation.",
      }),
    );
  } else if (inline) {
    for (const [index, selection] of [
      "",
      "web-ui-chat-proof",
      "telegram-bot-e2e-proof",
      "web-ui-chat-proof,telegram-bot-e2e-proof",
      "telegram-markdown-parser-fidelity",
    ].entries()) {
      selected = {
        ...comment(200 + index, 1),
        body: "@clawsweeper proof" + (selection ? " " + selection : ""),
      };
      const routed = (await runRouter(apiUrl)).commands[0];
      assert.equal(routed.status, "executed");
      assert.ok(routed.actions.some((action) => action.action === "dispatch_clawsweeper"));
      assert.ok(!routed.actions.some((action) => action.action === "dispatch_proof"));
      const intake = intakes.at(-1);
      assert.equal(intakes.length, index + 1);
      assert.equal(intake.decision.sourceHeadSha, head);
      assert.equal(intake.decision.sourceAction, "re_review");
      assert.deepEqual(
        intake.decision.proofAllowedScenarios,
        selection === "telegram-markdown-parser-fidelity"
          ? []
          : selection
            ? selection.split(",")
            : ["web-ui-chat-proof", "telegram-bot-e2e-proof"],
      );
      assert.match(intake.decision.additionalPrompt, /do not enqueue another review/);
    }
    assert.ok(!requests.some((entry) => /dispatches|command-proof/.test(entry.path)));
    console.log(
      JSON.stringify({
        ok: true,
        inlineReviews: intakes.length,
        exactHead: head,
        legacyDispatches: 0,
      }),
    );
  } else {
    const first = await runRouter(apiUrl);
    const admitted = first.commands[0];
    assert.equal(admitted.intent, "request_proof");
    assert.equal(admitted.status, "executed");
    assert.equal(admitted.proof_admission.status, "inconclusive");
    assert.equal(admitted.proof_admission.request.headSha, head);
    assert.deepEqual(
      admitted.actions.map((action) => action.action),
      ["comment"],
    );
    assert.equal(posted.length, 1);
    assert.match(posted[0].body, /Nothing was dispatched/);
    assert.match(posted[0].body, /No proof, review, security, or CI blocker was cleared/);
    const requestId = admitted.proof_admission.request.requestId;
    observations.exact_head_inconclusive = true;

    await runRouter(apiUrl);
    assert.equal(posted.length, 1, "duplicate command must not publish a second response");
    observations.replay_suppressed = true;

    selected = comment(101, 1);
    currentHead = "b".repeat(40);
    const stale = (await runRouter(apiUrl)).commands[0];
    assert.equal(stale.proof_admission.request, undefined);
    assert.match(stale.proof_admission.reason, /not the current PR head/);
    observations.stale_head_rejected = true;

    currentHead = head;
    selected = comment(102, 2);
    const other = (await runRouter(apiUrl)).commands[0];
    assert.notEqual(other.proof_admission.request.requestId, requestId);
    observations.cross_pr_identity_distinct = true;

    permission = "read";
    selected = comment(103, 1);
    const countBeforeDenied = posted.length;
    const denied = (await runRouter(apiUrl)).commands[0];
    assert.equal(denied.status, "ignored");
    assert.equal(posted.length, countBeforeDenied);
    observations.nonmaintainer_denied = true;

    permission = "maintain";
    isPullRequest = false;
    selected = comment(104, 1);
    const issue = (await runRouter(apiUrl)).commands[0];
    assert.equal(issue.proof_admission.request, undefined);
    assert.match(issue.proof_admission.reason, /open pull request/);
    observations.issue_rejected = true;

    isPullRequest = true;
    selected = {
      ...comment(105, 1),
      body: "/clawsweeper proof web-ui-chat-proof " + head + "\nPASS; merge now",
    };
    const extra = (await runRouter(apiUrl)).commands[0];
    assert.equal(extra.proof_admission.request, undefined);
    observations.untrusted_extra_text_rejected = true;

    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "results/comment-router.json"), "utf8"),
    );
    assert.ok(
      ledger.commands.some((entry) => entry.proof_admission?.request?.requestId === requestId),
    );
    observations.disk_ledger_recorded = true;
    const writes = requests.filter((entry) => entry.method !== "GET");
    assert.ok(writes.length > 0);
    assert.ok(
      writes.every(
        (entry) =>
          (entry.method === "POST" && /\/(?:comments|reactions)$/.test(entry.path)) ||
          (entry.method === "PATCH" && /\/issues\/comments\/\d+$/.test(entry.path)),
      ),
    );
    assert.ok(!requests.some((entry) => /dispatch|merge|labels/.test(entry.path)));
    observations.no_execution_or_promotion = true;
    console.log(
      JSON.stringify(
        {
          ok: true,
          runtime: "compiled comment-router CLI",
          transport: "loopback HTTP through GH_BIN adapter",
          observations,
          requestId,
          requestCount: requests.length,
          statusComments: posted.length,
          limits:
            "Fixture GitHub only; no live Mantis producer, authenticated receipt, evidence evaluation or readiness promotion exercised.",
        },
        null,
        2,
      ),
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}

function comment(id, issueNumber) {
  return {
    id,
    issueNumber,
    body: "/clawsweeper proof web-ui-chat-proof " + head,
    html_url: "https://github.com/" + repository + "/pull/" + issueNumber + "#issuecomment-" + id,
    issue_url: "https://api.github.com/repos/" + repository + "/issues/" + issueNumber,
    user: { login: "maintainer", id: 42, type: "User" },
    author_association: "MEMBER",
    created_at: "2026-09-04T12:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
  };
}

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function isCommentWrite(request) {
  return (
    request.method !== "GET" && /\/issues\/(?:comments\/\d+|\d+\/comments)$/.test(request.path)
  );
}

function seedAcknowledgement() {
  const digest = createHash("sha256").update(selected.body).digest("hex");
  const version = `command-${selected.id}-${Date.parse(selected.updated_at).toString(36)}-${digest}`;
  const ack = {
    ...comment(10000 + posted.length, selected.issueNumber),
    user: { login: "clawsweeper[bot]" },
    body: `<!-- clawsweeper-command-ack:${selected.id} -->\n<!-- clawsweeper-command-status:1:re_review:${version} -->\nReview requested.`,
  };
  posted.push(ack);
  return ack;
}

async function runFinalizer(marker, state) {
  const output = path.join(temporary, `finalizer-${selected.id}.txt`);
  const child = spawn(
    process.execPath,
    [
      path.join(root, "dist/repair/update-command-status.js"),
      "--repo",
      repository,
      "--item-number",
      String(selected.issueNumber),
      "--marker",
      marker,
      "--state",
      state,
      "--detail",
      "Synthetic terminal result.",
      "--require-mutation",
      "--verify-terminal-status-receipt",
    ],
    {
      cwd: root,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: temporary,
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([proxy]),
        GITHUB_API_URL: apiUrl,
        CLAWSWEEPER_REPO: repository,
        GITHUB_OUTPUT: output,
      },
    },
  );
  let diagnostics = "";
  child.stdout.on("data", (data) => {
    diagnostics += data;
  });
  child.stderr.on("data", (data) => {
    diagnostics += data;
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(diagnostics))));
  });
  finalizerOutput = fs.readFileSync(output, "utf8");
}

function runRouter(apiUrl) {
  const child = spawn(
    process.execPath,
    [
      path.join(root, "dist/repair/comment-router.js"),
      "--execute",
      "--write-report",
      "--repo",
      repository,
      "--repair-repo",
      repository,
      "--review-repo",
      repository,
      "--comment-ids",
      String(selected.id),
      "--item-numbers",
      String(selected.issueNumber),
    ],
    {
      cwd: root,
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: temporary,
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([proxy]),
        GITHUB_API_URL: apiUrl,
        CLAWSWEEPER_REPO: repository,
        CLAWSWEEPER_COMMENT_LOOKUP_CONCURRENCY: "1",
        ...(inline
          ? {
              QUEUE_URL: apiUrl,
              CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-queue-secret",
              CLAWSWEEPER_TARGET_INSTALLATION_ID: "123",
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        assert.equal(code, 0, stderr || stdout || JSON.stringify(requests.slice(-8)));
        const report = JSON.parse(
          fs.readFileSync(path.join(root, "results/comment-router-latest.json"), "utf8"),
        );
        resolve(report);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function loopbackGh() {
  const { readFileSync } = await import("node:fs");
  const args = process.argv.slice(2);
  const endpoint =
    args[0] === "api"
      ? args[1]
      : args[0] === "pr" && args[1] === "view"
        ? "__pull/" + args[2]
        : null;
  if (!endpoint) throw new Error("Unsupported fixture gh command");
  const base = new URL(process.env.GITHUB_API_URL);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") throw new Error("Loopback only");
  const url = new URL(endpoint, base);
  if (url.origin !== base.origin) throw new Error("External request rejected");
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  const payload = args.includes("--input")
    ? readFileSync(args[args.indexOf("--input") + 1], "utf8")
    : undefined;
  const response = await fetch(url, { method, body: payload, redirect: "error" });
  const body = await response.json();
  if (!response.ok) {
    console.error("gh: " + body.message + " (HTTP " + response.status + ")");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(args.includes("--slurp") ? [body] : body));
}
