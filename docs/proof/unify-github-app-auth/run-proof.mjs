#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const outputDir = path.resolve(
  process.env.UNIFY_GITHUB_APP_AUTH_PROOF_OUTPUT || "docs/proof/unify-github-app-auth/artifacts",
);
const webhookSecret = "unify-github-app-auth-proof";
const appIssuer = "Iv23unifiedproof";
const persistence = await mkdtemp(path.join(os.tmpdir(), "clawsweeper-unified-app-auth-"));
const workerPort = await availablePort();
const githubPort = await availablePort();
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const githubOrigin = `http://127.0.0.1:${githubPort}`;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const sourceSha = await git("rev-parse", "HEAD");
const sourceTreeSha = await sourceTreeHash([
  "dashboard/github-api.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/worker.ts",
  "test/github-api.test.ts",
  "docs/proof/unify-github-app-auth/README.md",
  "docs/proof/unify-github-app-auth/run-proof.mjs",
  "docs/proof/unify-github-app-auth/run-proof.sh",
]);

await mkdir(outputDir, { recursive: true });
const github = await startGithubServer();
let worker;

try {
  worker = await startWorker();
  await waitForWorker();
  await alignNearSecondStart();

  const workerPayload = {
    action: "created",
    repository: {
      full_name: "openclaw/gogcli",
      default_branch: "trunk",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    issue: { number: 597, user: { login: "steipete" } },
    installation: { id: 123 },
    comment: {
      id: 456,
      body: "@clawsweeper review",
      updated_at: "2026-08-10T12:00:00Z",
      author_association: "OWNER",
      user: { login: "steipete" },
    },
  };
  const queuePayload = {
    delivery_id: "unify-app-auth-queue-598",
    installation_id: 456,
    decision: {
      targetRepo: "openclaw/gogcli",
      itemNumber: 598,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
    },
  };

  const [workerResponse, queueResponse] = await Promise.all([
    signedRequest("/github/webhook", workerPayload, {
      "x-github-event": "issue_comment",
      "x-github-delivery": "unify-app-auth-worker-597",
      "x-hub-signature-256": githubSignature(JSON.stringify(workerPayload)),
    }),
    signedRequest("/internal/exact-review/branch-authority", queuePayload, {
      "x-clawsweeper-exact-review-signature": githubSignature(JSON.stringify(queuePayload)),
    }),
  ]);

  assert.equal(workerResponse.status, 202);
  assert.deepEqual(await workerResponse.json(), { ok: true, status_comment_id: 777 });
  assert.equal(queueResponse.status, 202);
  assert.deepEqual(await queueResponse.json(), { ok: true, branch_authority_pending: true });

  await waitFor(() => github.count("GET", "/repos/openclaw/gogcli") === 1);
  const queueSnapshot = await waitForQueue((snapshot) =>
    JSON.stringify(snapshot).includes("openclaw/gogcli#598"),
  );

  const workerAuthRequest = github.request("GET", "/repos/openclaw/clawsweeper/installation");
  const queueAuthRequest = github.request("POST", "/app/installations/456/access_tokens");
  assert(workerAuthRequest, "worker App-auth request was not observed");
  assert(queueAuthRequest, "queue App-auth request was not observed");
  assert.equal(workerAuthRequest.authorization, queueAuthRequest.authorization);
  assert.equal(workerAuthRequest.canonicalHeaders, queueAuthRequest.canonicalHeaders);
  assert.equal(workerAuthRequest.authorization.split(".").length, 3);
  assert.deepEqual(decodeJwt(workerAuthRequest.authorization), {
    header: { alg: "RS256", typ: "JWT" },
    payload: {
      iat: decodeJwt(workerAuthRequest.authorization).payload.iat,
      exp: decodeJwt(workerAuthRequest.authorization).payload.iat + 600,
      iss: appIssuer,
    },
  });
  assert.deepEqual(JSON.parse(queueAuthRequest.body), {
    repositories: ["gogcli"],
    permissions: { issues: "read", pull_requests: "read" },
  });
  assert.equal(github.unexpectedRequests(), 0);

  const jwtSha256 = sha256(workerAuthRequest.authorization);
  const canonicalHeaderSha256 = sha256(workerAuthRequest.canonicalHeaders);
  const redactedTrace = github.trace.map((entry) => ({
    at: entry.at,
    method: entry.method,
    path: entry.path,
    request_body_sha256: sha256(entry.body),
    authorization: entry.authorization
      ? entry.authorization.startsWith("proof-installation-")
        ? "Bearer <redacted-installation-token>"
        : "Bearer <redacted-app-jwt>"
      : null,
    response_status: entry.responseStatus,
  }));
  await writeJson("github-requests.redacted.json", redactedTrace);
  const summary = {
    schema: "clawsweeper-unified-github-app-auth-proof/v1",
    generated_at: new Date().toISOString(),
    source_sha: sourceSha,
    source_tree_sha: sourceTreeSha,
    runtime: "wrangler dev --local with SQLite-backed ExactReviewQueue",
    transport: `real loopback HTTP sockets (Worker ${workerPort}, GitHub ${githubPort})`,
    routes: {
      worker: "/github/webhook (signed issue_comment)",
      queue: "/internal/exact-review/branch-authority (signed request forwarded to Durable Object)",
    },
    observations: {
      worker_status: 202,
      worker_status_comment_id: 777,
      queue_status: 202,
      queue_item_resolved: JSON.stringify(queueSnapshot).includes("openclaw/gogcli#598"),
      jwt_byte_identical: true,
      canonical_app_auth_headers_byte_identical: true,
      app_jwt_sha256: jwtSha256,
      canonical_app_auth_headers_sha256: canonicalHeaderSha256,
      queue_token_request_body_sha256: sha256(queueAuthRequest.body),
      unexpected_loopback_requests: 0,
    },
    redactions: ["App private key", "App JWT", "installation tokens"],
    production_mutations: 0,
    run_status: "succeeded",
  };
  await writeJson("proof-summary.json", summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  await writeJson("proof-failure.json", {
    generated_at: new Date().toISOString(),
    source_sha: sourceSha,
    source_tree_sha: sourceTreeSha,
    error: error instanceof Error ? error.stack : String(error),
    github_requests: github.trace.map((entry) => ({
      method: entry.method,
      path: entry.path,
      response_status: entry.responseStatus,
    })),
    run_status: "failed",
  });
  throw error;
} finally {
  await stopProcessTree(worker);
  await github.close();
  await rm(persistence, { recursive: true, force: true });
}

async function startGithubServer() {
  const trace = [];
  const heldAuthResponses = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", githubOrigin);
    const method = request.method || "GET";
    const body = await readBody(request);
    const authorizationHeader = String(request.headers.authorization || "");
    const authorization = authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length)
      : "";
    const canonicalHeaders = JSON.stringify({
      accept: request.headers.accept || "",
      authorization: authorizationHeader,
      contentType: request.headers["content-type"] || "",
      userAgent: request.headers["user-agent"] || "",
    });
    const entry = {
      at: new Date().toISOString(),
      method,
      path: url.pathname,
      body,
      authorization,
      canonicalHeaders,
      responseStatus: 0,
    };
    trace.push(entry);

    if (
      (method === "GET" && url.pathname === "/repos/openclaw/clawsweeper/installation") ||
      (method === "POST" && url.pathname === "/app/installations/456/access_tokens")
    ) {
      heldAuthResponses.push({ request, response, entry, url });
      if (heldAuthResponses.length === 2) {
        for (const held of heldAuthResponses.splice(0)) {
          if (held.url.pathname.endsWith("/installation")) {
            sendJson(held.response, held.entry, 200, { id: 999 });
          } else {
            sendJson(held.response, held.entry, 201, { token: "proof-installation-queue" });
          }
        }
      }
      return;
    }
    if (method === "POST" && url.pathname === "/app/installations/999/access_tokens") {
      return sendJson(response, entry, 201, { token: "proof-installation-dispatch" });
    }
    if (method === "POST" && url.pathname === "/app/installations/123/access_tokens") {
      return sendJson(response, entry, 201, { token: "proof-installation-target" });
    }
    if (method === "GET" && url.pathname === "/repos/openclaw/gogcli/issues/597/comments") {
      return sendJson(response, entry, 200, [
        {
          id: 777,
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (
      method === "POST" &&
      url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions"
    ) {
      return sendJson(response, entry, 200, {});
    }
    if (method === "POST" && url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      entry.responseStatus = 204;
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "GET" && url.pathname === "/repos/openclaw/gogcli") {
      return sendJson(response, entry, 200, { default_branch: "trunk" });
    }
    return sendJson(response, entry, 501, { message: "unexpected proof request" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(githubPort, "127.0.0.1", resolve);
  });
  return {
    trace,
    count(method, requestPath) {
      return trace.filter((entry) => entry.method === method && entry.path === requestPath).length;
    },
    request(method, requestPath) {
      return trace.find((entry) => entry.method === method && entry.path === requestPath);
    },
    unexpectedRequests() {
      return trace.filter((entry) => entry.responseStatus === 501).length;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startWorker() {
  const log = createWriteStream(path.join(outputDir, "wrangler-local.log"), { flags: "w" });
  const args = [
    "--yes",
    "wrangler@4.107.0",
    "dev",
    "--config",
    "dashboard/wrangler.toml",
    "--local",
    "--persist-to",
    persistence,
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--var",
    `CLAWSWEEPER_WEBHOOK_SECRET:${webhookSecret}`,
    "--var",
    `CLAWSWEEPER_APP_CLIENT_ID:${appIssuer}`,
    "--var",
    `CLAWSWEEPER_APP_PRIVATE_KEY:${privateKey.replace(/\n/g, "\\n")}`,
    "--var",
    `GITHUB_API_URL:${githubOrigin}`,
    "--var",
    "TARGET_REPOS:openclaw/gogcli",
    "--var",
    "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:600000",
    "--var",
    "CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS:600000",
  ];
  const child = spawn("npx", args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.once("exit", () => log.end());
  return child;
}

async function waitForWorker() {
  await waitFor(async () => {
    try {
      return (await fetch(`${workerOrigin}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 30_000);
}

async function signedRequest(requestPath, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  return fetch(`${workerOrigin}${requestPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body,
  });
}

async function waitForQueue(predicate) {
  let last;
  await waitFor(async () => {
    const response = await fetch(`${workerOrigin}/api/exact-review-queue`);
    if (!response.ok) return false;
    last = await response.json();
    return predicate(last);
  }, 30_000);
  return last;
}

function githubSignature(body) {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

function decodeJwt(jwt) {
  const [header, payload] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

function sendJson(response, entry, status, payload) {
  entry.responseStatus = status;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function alignNearSecondStart() {
  const remainder = Date.now() % 1_000;
  if (remainder > 150) await sleep(1_010 - remainder);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  if (lastError) throw lastError;
  throw new Error(`proof condition timed out after ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function sourceTreeHash(files) {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function git(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} failed`));
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(name, value) {
  await writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
}
