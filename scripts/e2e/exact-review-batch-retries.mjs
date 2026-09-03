import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the built CLI and real fetch/abort behavior without production access.
const root = await mkdtemp(join(tmpdir(), "batch-retry-proof-"));
const cli = resolve(process.argv[2] || "dist/repair/exact-review-batch-cli.js");
const secret = "synthetic-local-proof";
const manifestPath = join(root, "manifest.json");
const payloadPath = join(root, "payload.json");
const preloadPath = join(root, "loopback.cjs");
const payload = '{ "receipt_id": "synthetic-receipt", "kind": "policy_noop" }\n';
const results = [];
let scenario;
let requests = [];
let leaseExpiresAt;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const signature = request.headers["x-clawsweeper-exact-review-signature"];
  requests.push({ path: request.url, body, signature, at: Date.now() });
  assert.equal(signature, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const attempt = requests.length;
  if (scenario === "network" && attempt === 1) return request.socket.destroy();
  if (scenario === "lease" && attempt > 1) return;
  if (scenario === "body-timeout" && attempt === 1) {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
    return;
  }
  if (scenario === "rejection") response.statusCode = 409;
  else if (
    scenario === "exhaustion" ||
    ((scenario === "recovery" || scenario === "lease") && attempt === 1)
  )
    response.statusCode = 500;
  const batch = {
    batch_id: "proof-batch",
    lease_owner: "proof-owner",
    lease_expires_at: leaseExpiresAt,
    items: [],
  };
  response.end(
    JSON.stringify(
      response.statusCode >= 400
        ? { error: "exact_review_queue_unavailable" }
        : request.url.endsWith("/claim")
          ? { claimed: true, batch, configured_batch_size: 1, batch_wait_ms: 0 }
          : request.url.endsWith("/fetch")
            ? { batch, items: [], superseded: 0 }
            : request.url.endsWith("/heartbeat")
              ? { batch }
              : { ok: true },
    ),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
await writeFile(payloadPath, payload);
await writeFile(
  preloadPath,
  `const original = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = new URL(url);
  if (target.origin !== "https://queue.example.test") throw new Error("Non-fixture access blocked");
  return original(${JSON.stringify(origin)} + target.pathname, init);
};\n`,
);

async function run(args) {
  const started = Date.now();
  const child = spawn(process.execPath, ["--require", preloadPath, cli, ...args], {
    env: {
      ...process.env,
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
      EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
      EXACT_REVIEW_BATCH_ID: "proof-batch",
      EXACT_REVIEW_BATCH_LEASE_OWNER: "proof-owner",
      EXACT_REVIEW_BATCH_MAX_ITEMS: "1",
      GITHUB_OUTPUT: join(root, "github-output"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 50_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.doesNotMatch(stderr, /synthetic-local-proof|synthetic-receipt|sha256=/);
    return { code, stdout, stderr, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

try {
  for (const route of ["enqueue", "router-receipt", "terminal-disposition"]) {
    for (const fault of ["recovery", "network", "exhaustion", "rejection"]) {
      scenario = fault;
      requests = [];
      const result = await run(["post-effect", "--route", route, "--payload", payloadPath]);
      const expectedAttempts = fault === "rejection" ? 1 : fault === "exhaustion" ? 3 : 2;
      assert.equal(
        result.code,
        fault === "rejection" || fault === "exhaustion" ? 1 : 0,
        result.stderr,
      );
      assert.equal(requests.length, expectedAttempts, result.stderr);
      assert.ok(
        requests.every(
          (request) => request.body === payload && request.signature === requests[0].signature,
        ),
      );
      results.push({
        route,
        fault,
        attempts: requests.length,
        exitCode: result.code,
        identicalBytes: true,
        elapsedMs: result.elapsedMs,
      });
    }
  }
  scenario = "claim";
  requests = [];
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await run(["claim"])).code, 0);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).leaseExpiresAt, leaseExpiresAt);
  scenario = "recovery";
  requests = [];
  leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const renewed = await run(["heartbeat"]);
  assert.equal(renewed.code, 0, renewed.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].signature, requests[1].signature);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).leaseExpiresAt, leaseExpiresAt);
  results.push({ route: "heartbeat", fault: "recovery", attempts: 2, persistedExpiry: true });

  scenario = "lease";
  requests = [];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.leaseExpiresAt = new Date(Date.now() + 2_500).toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest));
  const expired = await run(["heartbeat"]);
  assert.equal(expired.code, 1, expired.stderr);
  assert.equal(requests.length, 2);
  assert.ok(expired.elapsedMs >= 2_000 && expired.elapsedMs < 3_500, String(expired.elapsedMs));
  assert.equal(
    JSON.parse(await readFile(manifestPath, "utf8")).leaseExpiresAt,
    manifest.leaseExpiresAt,
  );
  results.push({
    route: "heartbeat",
    fault: "lease",
    attempts: 2,
    exitCode: expired.code,
    elapsedMs: expired.elapsedMs,
    retainedExpiry: true,
  });

  scenario = "body-timeout";
  requests = [];
  const bodyTimeout = await run([
    "post-effect",
    "--route",
    "router-receipt",
    "--payload",
    payloadPath,
  ]);
  assert.equal(bodyTimeout.code, 0, bodyTimeout.stderr);
  assert.equal(requests.length, 2);
  assert.ok(
    bodyTimeout.elapsedMs >= 20_000 && bodyTimeout.elapsedMs < 24_000,
    String(bodyTimeout.elapsedMs),
  );
  results.push({
    route: "router-receipt",
    fault: "body-timeout",
    attempts: 2,
    exitCode: 0,
    elapsedMs: bodyTimeout.elapsedMs,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        environment: {
          platform: process.platform,
          node: process.version,
          transport: "loopback HTTP through a host-only fetch adapter",
        },
        results,
        limits:
          "No production Worker, Durable Object, GitHub action, or TLS handshake exercised; native fetch and CLI processes are real.",
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
