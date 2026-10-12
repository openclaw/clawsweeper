#!/usr/bin/env node
// Node >=24. Usage (from repo root):
// node docs/proof/github-webhook-activity/run-proof.mjs TOOLS_DIR FRESH_OUTPUT_DIR
// TOOLS_DIR must contain miniflare and esbuild (e.g. an external wrangler@4.131.1 installation).
// Suggested output: /Users/obviyus/Developer/.agents/handoffs/ci-waste-audit/github-activity/runtime-<unique>
// Uses the real Worker /github/webhook route, real HMAC, and external loopback
// GitHub/App/hook fixtures. No production traffic, secrets, schema or source edits.
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBHOOK_ACTIVITY_DELIVERY, WEBHOOK_ACTIVITY_ENV, webhookActivityPayload } from "../../../test/github-webhook-activity-fixtures.ts";

const [toolsDir, outputDir] = process.argv.slice(2);
assert.ok(toolsDir && outputDir, "expected TOOLS_DIR FRESH_OUTPUT_DIR");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const output = path.resolve(outputDir);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output); // Never overwrite a previous proof.
const require = createRequire(path.resolve(toolsDir, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const secret = "local-webhook-proof-not-a-secret";
const appKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const hookRequests = [];
const unexpected = [];
const outcomes = [];
let mode = "delivered";
let heldResponse;
let visibility = "public";
let hookAttempts = 0;
let revokedVisibilityProbes = 0;
const completed = { ok: true, runId: "local-proof-run", completion: { status: "ok", delivered: true } };
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(request.url, "http://fixture");
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/hooks/agent") {
    hookAttempts++;
    hookRequests.push({ headers: request.headers, body: JSON.parse(body) });
    if (mode === "held") { heldResponse = () => send(200, completed); return; }
    if (mode === "retry" && hookAttempts === 1) return send(503, { error: "local transient fixture" });
    if (mode === "revoke") {
      visibility = "private";
      return send(503, { error: "transient before visibility changed" });
    }
    if (mode === "failed") return send(200, { ok: true, runId: "local-failed", completion: { status: "error", deliveryError: "fixture failure" } });
    return send(200, completed);
  }
  if (url.pathname === "/openclaw/clawsweeper/main/config/target-repositories.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(readFileSync(path.join(root, "config/target-repositories.json")));
    return;
  }
  if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(url.pathname)) return send(200, { id: 123 });
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) return send(201, { token: "local-installation-token", expires_at: "2100-01-01T00:00:00Z" });
  if (url.pathname === "/repos/openclaw/openclaw") {
    if (mode === "revoke" && visibility === "private") revokedVisibilityProbes++;
    return send(200, { ...webhookActivityPayload().repository, private: visibility === "private", visibility });
  }
  unexpected.push(`${request.method} ${url.pathname}`);
  return send(500, { error: "unexpected outbound request" });
});
// Only strip non-handler exports rejected by workerd. No injected production
// predicates, clocks, transport replacement, forwarding logic, or schema changes.
const bundle = await build({
  stdin: { contents: `export { default } from ${JSON.stringify(path.join(root, "dashboard/worker.ts"))};`, resolveDir: root, sourcefile: "webhook-proof-entry.ts" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  external: ["node:*", "cloudflare:*"], logLevel: "silent",
});
writeFileSync(path.join(output, "worker.mjs"), bundle.outputFiles[0].text);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `127.0.0.1:${server.address().port}`;
const runtime = (enabled) => new Miniflare({
  name: "github-webhook-activity-proof", modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-08", compatibilityFlags: ["nodejs_compat"],
  bindings: {
    ...WEBHOOK_ACTIVITY_ENV,
    CLAWSWEEPER_GITHUB_ACTIVITY_FROM_WEBHOOK: enabled ? "1" : "0",
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    CLAWSWEEPER_APP_ID: "1234", CLAWSWEEPER_APP_PRIVATE_KEY: appKey,
  },
  outboundService: { external: { address, http: {} } },
});
function post(mf, { payload = webhookActivityPayload(), event = "issue_comment", delivery = WEBHOOK_ACTIVITY_DELIVERY, validSignature = true } = {}) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", validSignature ? secret : "wrong-secret").update(body).digest("hex");
  return mf.dispatchFetch("https://clawsweeper.openclaw.ai/github/webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${signature}` }, body,
  });
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function acknowledged(promise) {
  let timer;
  try {
    const response = await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("webhook acknowledgement awaited hook completion")), 5000); })]);
    assert.equal(response.status, 202, await response.clone().text());
    return response.json();
  } finally { clearTimeout(timer); }
}
let mf;
try {
  mf = runtime(false);
  await mf.ready;
  await acknowledged(post(mf));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hookRequests.length, 0);
  outcomes.push({ scenario: "gate_off", status: 202, hook_requests: 0 });
  await mf.dispose();
  mf = runtime(true);
  await mf.ready;

  const rejected = await post(mf, { validSignature: false });
  assert.equal(rejected.status, 401);
  assert.equal(hookRequests.length, 0);
  outcomes.push({ scenario: "invalid_hmac", status: rejected.status, hook_requests: 0 });

  const outside = webhookActivityPayload();
  outside.repository.full_name = "outside/not-eligible";
  await acknowledged(post(mf, { payload: outside }));
  assert.equal(hookRequests.length, 0);
  outcomes.push({ scenario: "outside_owner", status: 202, hook_requests: 0 });

  visibility = "private";
  await acknowledged(post(mf));
  assert.equal(hookRequests.length, 0);
  visibility = "public";
  outcomes.push({ scenario: "private_target", status: 202, hook_requests: 0 });

  const routine = webhookActivityPayload();
  routine.action = "edited";
  await acknowledged(post(mf, { payload: routine }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hookRequests.length, 0);
  outcomes.push({ scenario: "routine_filtered", status: 202, hook_requests: 0 });

  mode = "held";
  const acknowledgment = post(mf);
  await until(() => heldResponse !== undefined, "external hook request");
  const response = await acknowledged(acknowledgment);
  assert.ok(heldResponse, "hook response is still blocked after webhook acknowledgement");
  const first = hookRequests[0];
  assert.equal(first.headers.authorization, `Bearer ${WEBHOOK_ACTIVITY_ENV.CLAWSWEEPER_OPENCLAW_HOOK_TOKEN}`);
  assert.equal(first.headers["idempotency-key"], `github-activity:openclaw/openclaw:issue_comment:created:pull_request-42:${WEBHOOK_ACTIVITY_DELIVERY}`);
  assert.equal(first.body.idempotencyKey, first.headers["idempotency-key"]);
  assert.equal(first.body.timeoutSeconds, 60);
  assert.equal(first.body.name, "GitHub issue_comment openclaw/openclaw");
  assert.equal(first.body.waitForCompletion, true);
  heldResponse();
  heldResponse = undefined;
  outcomes.push({ scenario: "async_delivery", status: 202, acknowledged_before_hook_completed: true, response, key: first.body.idempotencyKey });

  mode = "delivered";
  await acknowledged(post(mf));
  await until(() => hookRequests.length === 2, "duplicate forwarding");
  assert.equal(hookRequests[1].body.idempotencyKey, first.body.idempotencyKey);
  outcomes.push({ scenario: "gateway_dedupe_identity", identical_key: true, hook_requests: 2 });

  mode = "failed";
  await acknowledged(post(mf, { delivery: "failed-delivery" }));
  await until(() => hookRequests.length === 3, "failed hook outcome");
  outcomes.push({ scenario: "failed_hook_is_best_effort", status: 202, hook_requests: 1 });

  mode = "retry";
  hookAttempts = 0;
  await acknowledged(post(mf, { delivery: "retry-delivery" }));
  await until(() => hookAttempts === 2, "bounded retry");
  assert.equal(hookRequests[3].body.idempotencyKey, hookRequests[4].body.idempotencyKey);
  assert.deepEqual(hookRequests[3].body, hookRequests[4].body);
  outcomes.push({ scenario: "transient_retry", status: 202, attempts: 2, identical_body: true });

  mode = "revoke";
  hookAttempts = 0;
  await acknowledged(post(mf, { delivery: "revoked-delivery" }));
  await until(() => revokedVisibilityProbes > 0, "fresh retry visibility probe");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hookAttempts, 1, "a newly private repository cannot reach retry hook I/O");
  outcomes.push({ scenario: "visibility_revoked_before_retry", status: 202, hook_requests: 1, fresh_visibility_probes: revokedVisibilityProbes });
  assert.deepEqual(unexpected, []);
  // Redact dummy credentials too: artifacts contain only observations and bodies.
  const report = {
    schema: "github-webhook-activity-proof/v1", generated_at: new Date().toISOString(),
    runtime: { node: process.version, miniflare: require("miniflare/package.json").version, workerd: require("workerd/package.json").version },
    sources: Object.fromEntries(["dashboard/worker.ts", "dashboard/github-activity.ts", "src/repair/github-activity.ts", "src/repair/openclaw-hook.ts"].map((file) => [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")])),
    outcomes, hook_bodies: hookRequests.map((request) => request.body), unexpected,
    limits: ["Synthetic GitHub App events, credentials, visibility responses, and hook; no production traffic.", "Best-effort waitUntil is not durable delivery and this proof makes no durable/coalescing guarantee.", "Duplicate deliveries forward the same key; actual Gateway suppression is outside this local fixture.", "The App-webhook design has no producer-side repository_dispatch fallback; remaining legacy sources retain their existing workflow path."],
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  heldResponse?.();
  await mf?.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
