#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { githubEtagCacheKey, githubEtagCacheRequestBody } from "../../../dist/github-etag-cache-contract.js";
import { durableGithubEtagReadSync } from "../../../dist/github-etag-read-broker.js";

const secret = "etag-proof-publisher-placeholder";
const operatorSecret = "etag-proof-operator-placeholder";

if (process.argv.includes("--server")) {
  await runServer();
} else {
  await runProof();
}

async function runProof() {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  assert.ok(output, "--output is required");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--server"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const baseUrl = await serverUrl(child);
  const events = [];
  const key1 = requiredKey("/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=1");
  const key2 = requiredKey("/repos/openclaw/openclaw/issues/42/comments?per_page=100&page=2");
  const read = (key) =>
    durableGithubEtagReadSync({
      key,
      lookup: () => {
        const response = signedPost(baseUrl, "lookup", githubEtagCacheRequestBody(key, "apply"));
        return response.hit ? { hit: true, entry: response.entry } : { hit: false };
      },
      store200: (_key, response) => {
        const stored = signedPost(baseUrl, "store", {
          ...githubEtagCacheRequestBody(key, "apply"),
          ...response,
        });
        return { stored: stored.stored === true };
      },
      confirm304: (_key, expected) =>
        signedPost(baseUrl, "confirm", {
          ...githubEtagCacheRequestBody(key, "apply"),
          etag: expected.etag,
          body_digest: expected.bodyDigest,
        }),
      githubRequest: (ifNoneMatch) => githubGet(baseUrl, key.route, ifNoneMatch),
      record: (event) => events.push(event),
    });

  try {
    const first = read(key1);
    const unchanged = read(key1);
    assert.equal(unchanged, first);
    assert.equal(sha256(unchanged), sha256(first));

    await adminPost(baseUrl, "/admin/mutate", {
      route: key1.route,
      etag: '"comments-page-1-v2"',
      body: JSON.stringify([{ id: 1, body: "changed" }]),
    });
    const changed = read(key1);
    assert.notEqual(changed, first);

    const page2 = read(key2);
    const finalGuard = read(key2);
    assert.equal(finalGuard, page2);

    const requests = await (await fetch(`${baseUrl}/admin/requests`)).json();
    assert.equal(requests.length, 5);
    assert.equal(requests[0].if_none_match, null);
    assert.equal(requests[1].if_none_match, '"comments-page-1-v1"');
    assert.equal(requests[2].if_none_match, '"comments-page-1-v1"');
    assert.equal(requests[3].route, key2.route);
    assert.equal(requests[3].if_none_match, null);
    assert.equal(requests[4].if_none_match, '"comments-page-2-v1"');
    assert.deepEqual(
      requests.map((request) => request.status),
      [200, 304, 200, 200, 304],
    );

    const lookupBody = JSON.stringify(githubEtagCacheRequestBody(key1, "apply"));
    const publisherStatus = rawSignedStatus(baseUrl, "lookup", lookupBody, secret);
    const operatorStatus = rawSignedStatus(baseUrl, "lookup", lookupBody, operatorSecret);
    assert.equal(publisherStatus, 200);
    assert.equal(operatorStatus, 401);

    const head = git("rev-parse", "HEAD");
    const base = git("merge-base", "HEAD", "origin/main");
    git("cat-file", "-e", `${head}^{commit}`);
    git("cat-file", "-e", `${base}^{commit}`);
    const counts = Object.fromEntries(
      ["cache_hit", "cache_miss", "cache_skip", "cache_200_stored", "cache_304_served"].map(
        (outcome) => [outcome, events.filter((event) => event.outcome === outcome).length],
      ),
    );
    const report = {
      schema: "clawsweeper-etag-read-broker-proof/v1",
      generated_at: new Date().toISOString(),
      tested_head: head,
      merge_base: base,
      key_schema: "[1, credential_pool, route_with_sorted_query, media_type]",
      storage: { max_entries: 2048, max_body_bytes: 524288, ttl_days: 30 },
      results: {
        first_read: "200_stored",
        unchanged_read: "304_confirmed_body_served",
        byte_identical: Buffer.from(unchanged).equals(Buffer.from(first)),
        digest_asserted: sha256(unchanged) === sha256(first),
        changed_read: "200_replaced",
        page_2_carried_page_1_etag: false,
        final_guard_revalidated: requests[4].status === 304,
        bare_cache_reads: 0,
        wire_calls: requests.length,
        quota_charges: requests.filter((request) => request.status === 200).length,
        telemetry: counts,
        publisher_hmac_status: publisherStatus,
        operator_hmac_status: operatorStatus,
      },
      limits: [
        "Loopback GitHub and credentials are deterministic fixtures.",
        "The proof exercises production Worker routing and Durable Object SQL in memory, not production state.",
        "GitHub documents REST 304 responses as zero primary-rate-limit points; the fixture models that accounting.",
      ],
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function runServer() {
  const [{ default: worker, ExactReviewQueue }, harness] = await Promise.all([
    import("../../../dashboard/worker.ts"),
    import("../../../test/dashboard-worker-harness.ts"),
  ]);
  const storage = new harness.MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_OPERATOR_SECRET: operatorSecret,
    EXACT_REVIEW_QUEUE: new harness.MemoryDurableNamespace(queue),
  };
  const resources = new Map([
    [
      "/repos/openclaw/openclaw/issues/42/comments?page=1&per_page=100",
      { etag: '"comments-page-1-v1"', body: JSON.stringify([{ id: 1, body: "first" }]) },
    ],
    [
      "/repos/openclaw/openclaw/issues/42/comments?page=2&per_page=100",
      { etag: '"comments-page-2-v1"', body: JSON.stringify([{ id: 101, body: "second" }]) },
    ],
  ]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/admin/requests") return sendJson(response, 200, requests);
    if (url.pathname === "/admin/mutate") {
      const value = JSON.parse(await requestText(request));
      resources.set(value.route, { etag: value.etag, body: value.body });
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname.startsWith("/github/")) {
      const route = `${url.pathname.slice("/github".length)}${url.search}`;
      const resource = resources.get(route);
      if (!resource) return sendJson(response, 404, { error: "missing_fixture" });
      const ifNoneMatch = request.headers["if-none-match"] || null;
      const status = ifNoneMatch === resource.etag ? 304 : 200;
      requests.push({ route, if_none_match: ifNoneMatch, status });
      response.writeHead(status, { etag: resource.etag, "content-type": "application/json" });
      response.end(status === 304 ? undefined : resource.body);
      return;
    }
    if (url.pathname.startsWith("/internal/exact-review/github-etag-cache/")) {
      const body = await requestText(request);
      const forwarded = new Request(`https://clawsweeper.openclaw.ai${url.pathname}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": String(
            request.headers["x-clawsweeper-exact-review-signature"] || "",
          ),
        },
        body,
      });
      const result = await worker.fetch(forwarded, env);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}` })}\n`);
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

function signedPost(baseUrl, operation, body) {
  const bodyText = JSON.stringify(body);
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--header",
      `x-clawsweeper-exact-review-signature: ${signature(bodyText, secret)}`,
      "--data-binary",
      "@-",
      `${baseUrl}/internal/exact-review/github-etag-cache/${operation}`,
    ],
    { input: bodyText, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rawSignedStatus(baseUrl, operation, body, signingSecret) {
  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--header",
      `x-clawsweeper-exact-review-signature: ${signature(body, signingSecret)}`,
      "--data-binary",
      "@-",
      `${baseUrl}/internal/exact-review/github-etag-cache/${operation}`,
    ],
    { input: body, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout);
}

function githubGet(baseUrl, route, ifNoneMatch) {
  const args = ["--silent", "--show-error", "--include"];
  if (ifNoneMatch) args.push("--header", `If-None-Match: ${ifNoneMatch}`);
  args.push(`${baseUrl}/github${route}`);
  const result = spawnSync("curl", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const normalized = result.stdout.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const headers = normalized.slice(0, separator);
  const body = normalized.slice(separator + 2);
  const status = Number(/^HTTP\/[^\s]+\s+(\d{3})/m.exec(headers)?.[1]);
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim();
  return { status, body, etag };
}

async function adminPost(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
}

function serverUrl(child) {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(text.slice(0, newline)).url);
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => reject(new Error(`loopback server exited ${code}`)));
  });
}

function requiredKey(route) {
  const key = githubEtagCacheKey({
    credentialPool: "repository_actions",
    route,
    surface: "apply",
  });
  assert.ok(key);
  return key;
}

function signature(body, signingSecret) {
  return `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function requestText(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
