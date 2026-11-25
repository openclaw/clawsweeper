#!/usr/bin/env node
// Real Worker handler with a stalled loopback GitHub transport; no live mutations.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import worker from "../dashboard/worker.ts";

const originalFetch = globalThis.fetch;
const traces = [];
for (const failure of [false, true]) {
  const trace = [];
  const pending = [];
  let dispatchResponse;
  const pull = {
    number: 42,
    title: "Fix startup",
    body: "Startup crashes",
    state: "open",
    locked: false,
    labels: [],
    draft: false,
    author_association: "CONTRIBUTOR",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:01:00Z",
    user: { login: "contributor" },
    head: { sha: "a".repeat(40) },
  };
  const server = createServer((req, res) => {
    if (req.url.includes("pr-classification.yml/dispatches")) {
      trace.push("classification-dispatch-held");
      dispatchResponse = res;
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/permission")) res.end(JSON.stringify({ permission: "read" }));
    else if (req.url.endsWith("/pulls/42")) res.end(JSON.stringify(pull));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.github.com");
    return originalFetch(origin + url.pathname + url.search, init);
  };
  let timer;
  try {
    const body = JSON.stringify({
      action: "edited",
      installation: { id: 123 },
      repository: {
        full_name: "openclaw/fs-safe",
        private: false,
        archived: false,
        fork: false,
        has_issues: true,
        default_branch: "main",
      },
      sender: { login: "contributor" },
      pull_request: pull,
    });
    const response = await Promise.race([
      worker.fetch(
        new Request("https://worker.invalid/github/webhook", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "controlled-isolation-" + failure,
            "x-hub-signature-256":
              "sha256=" + createHmac("sha256", "synthetic").update(body).digest("hex"),
          },
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: "synthetic",
          GITHUB_TOKEN: "synthetic",
          hostedTargetPredicate: () => true,
          hostedPublicTargetProbe: async () => "public",
          EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS: "0",
          EXACT_REVIEW_INITIAL_PR_QUIET_MS: "0",
          EXACT_REVIEW_QUEUE: {
            idFromName: (name) => name,
            get: () => ({
              async fetch(request) {
                const endpoint = new URL(request.url).pathname;
                if (endpoint === "/source-authority")
                  return Response.json({ source_authority_seq: 1 });
                if (endpoint === "/enqueue") {
                  trace.push("review-enqueued");
                  return Response.json({ ok: true, queued: true });
                }
                return Response.json({ ok: true });
              },
            }),
          },
        },
        { waitUntil: (promise) => pending.push(promise) },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Webhook waited for classification")), 5000);
      }),
    ]);
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal((await response.json()).queued, true);
    trace.push("webhook-returned");
    assert.ok(dispatchResponse, "Classification HTTP request is still held by server");
    assert.ok(trace.includes("review-enqueued"));
    assert.ok(pending.length > 0);
    dispatchResponse.statusCode = failure ? 403 : 204;
    dispatchResponse.end();
    trace.push("classification-released");
    await Promise.all(pending);
    trace.push("background-completed");
    traces.push({ failure, trace });
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
const output = resolve(process.argv[2] || ".artifacts/pr-classification-isolation-proof.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      status: "passed",
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      traces,
      limits: [
        "Actual Worker handler and native HTTP transport; loopback GitHub server and Durable Object transport fixture. No deployed Actions or production label mutation claim.",
        "Independent workflow still shares GitHub API limits and hosted Actions account capacity.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log("Classification isolation runtime proof passed: " + output);
