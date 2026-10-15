import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { submitReviewUsageFile } from "../dist/review-usage-submit.js";
import worker from "../dashboard/worker.ts";
import type { ReviewUsageDataPoint } from "../dashboard/review-usage.ts";

const RECORD = {
  schema: 1,
  target_repo: "openclaw/openclaw",
  item_number: 42,
  item_kind: "pull_request",
  run_id: "12345678901234567890",
  run_attempt: 2,
  trigger_lane: "scheduled",
  service_tier: "priority",
  reasoning_effort: "high",
  outcome: "ok",
  duration_ms: 12500,
  usage: {
    input_tokens: 1000,
    cached_input_tokens: 200,
    cache_write_input_tokens: 50,
    output_tokens: 100,
    reasoning_output_tokens: 30,
  },
};
const ENV = {
  EXACT_REVIEW_QUEUE_URL: "https://example.com/",
  CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
};

function fixture(t: TestContext, content = JSON.stringify(RECORD) + "\n") {
  const directory = mkdtempSync(join(tmpdir(), "review-usage-submit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "usage.jsonl");
  writeFileSync(path, content);
  return path;
}

test("trusted submission signs the exact validated body with a short timeout", async (t) => {
  const path = fixture(t);
  const calls: { url: string; init: RequestInit }[] = [];
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 202 });
  });
  await submitReviewUsageFile({ path, env: ENV });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  const body = JSON.stringify(RECORD);
  assert.equal(call.url, "https://example.com/internal/exact-review/review-usage");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, body);
  assert.equal(call.init.redirect, "error");
  assert.equal(new Headers(call.init.headers).get("content-type"), "application/json");
  assert.equal(
    new Headers(call.init.headers).get("x-clawsweeper-exact-review-signature"),
    `sha256=${createHmac("sha256", ENV.CLAWSWEEPER_WEBHOOK_SECRET).update(body).digest("hex")}`,
  );
  assert.deepEqual(timeouts, [1500]);
});

test("submission skips malformed, unknown-field, invalid-counter, and oversized lines", async (t) => {
  const invalid = [
    "{",
    "null",
    JSON.stringify({ ...RECORD, model: "private-model" }),
    JSON.stringify({ ...RECORD, usage: { ...RECORD.usage, turns: 2 } }),
    JSON.stringify({ ...RECORD, usage: { ...RECORD.usage, output_tokens: -1 } }),
    JSON.stringify({ ...RECORD, run_id: 42 }),
    JSON.stringify({ ...RECORD, reasoning_effort: "a".repeat(65) }),
    " ".repeat(16 * 1024) + JSON.stringify(RECORD),
  ];
  const unavailable = { ...RECORD, usage: null, outcome: "timeout" };
  const path = fixture(
    t,
    [...invalid, JSON.stringify(RECORD), JSON.stringify(unavailable)].join("\n"),
  );
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(null, { status: 202 });
  });
  await submitReviewUsageFile({ path, env: ENV });
  assert.deepEqual(bodies, [JSON.stringify(RECORD), JSON.stringify(unavailable)]);
});

test("submission bounds the complete file and counts invalid lines toward the 200-line limit", async (t) => {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(null, { status: 202 });
  });
  const path = fixture(
    t,
    "invalid\n".repeat(199) + JSON.stringify(RECORD) + "\n" + JSON.stringify(RECORD),
  );
  await submitReviewUsageFile({ path, env: ENV });
  assert.deepEqual(bodies, [JSON.stringify(RECORD)]);
  truncateSync(path, 1024 * 1024 + 1);
  await submitReviewUsageFile({ path, env: ENV });
  assert.equal(bodies.length, 1);
});

test("submission swallows network and rejection failures without logging sensitive details", async (t) => {
  const path = fixture(t, (JSON.stringify(RECORD) + "\n").repeat(3));
  const logs: string[] = [];
  let calls = 0;
  t.mock.method(console, "error", (message: string) => logs.push(message));
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new Error("https://private-url.test secret private-model");
    if (calls === 2) return new Response("private response body", { status: 503 });
    return new Response(null, { status: 202 });
  });
  await assert.doesNotReject(submitReviewUsageFile({ path, env: ENV }));
  assert.equal(calls, 3);
  assert.deepEqual(logs, [
    "[review-usage] best-effort telemetry unavailable",
    "[review-usage] best-effort telemetry unavailable",
  ]);
});

test("missing credentials or files never submit or fail", async (t) => {
  const path = fixture(t);
  const logs: string[] = [];
  t.mock.method(console, "error", (message: string) => logs.push(message));
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  for (const env of [
    {},
    { EXACT_REVIEW_QUEUE_URL: ENV.EXACT_REVIEW_QUEUE_URL },
    {
      CLAWSWEEPER_WEBHOOK_SECRET: ENV.CLAWSWEEPER_WEBHOOK_SECRET,
    },
  ]) {
    await assert.doesNotReject(submitReviewUsageFile({ path, env }));
  }
  assert.deepEqual(logs, []);
  await assert.doesNotReject(submitReviewUsageFile({ path: path + ".missing", env: ENV }));
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(logs, ["[review-usage] best-effort telemetry unavailable"]);
});

test("HTTP is restricted to loopback hosts and URL credentials are rejected", async (t) => {
  const path = fixture(t);
  const destinations: string[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    destinations.push(String(url));
    return new Response(null, { status: 202 });
  });
  for (const baseUrl of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "http://example.com",
    "http://localhost.example.com",
    "ftp://localhost",
    "https://user:password@example.com",
    "not a URL",
  ]) {
    await submitReviewUsageFile({ path, env: { ...ENV, EXACT_REVIEW_QUEUE_URL: baseUrl } });
  }
  assert.deepEqual(destinations, [
    "http://localhost:8080/internal/exact-review/review-usage",
    "http://127.0.0.1:8080/internal/exact-review/review-usage",
    "http://[::1]:8080/internal/exact-review/review-usage",
  ]);
});

test("CLI reads its default environment path and signs a local HTTP submission", async (t) => {
  const path = fixture(t);
  const requests: { path: string | undefined; body: string; signature: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const signature = request.headers["x-clawsweeper-exact-review-signature"];
    requests.push({
      path: request.url,
      body,
      signature: typeof signature === "string" ? signature : undefined,
    });
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await promisify(server.close.bind(server))();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cli = fileURLToPath(new URL("../dist/review-usage-submit.js", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [cli], {
    env: {
      ...process.env,
      ...ENV,
      EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${address.port}`,
      CLAWSWEEPER_REVIEW_USAGE_PATH: path,
    },
    timeout: 10000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const body = JSON.stringify(RECORD);
  assert.deepEqual(requests, [
    {
      path: "/internal/exact-review/review-usage",
      body,
      signature: `sha256=${createHmac("sha256", ENV.CLAWSWEEPER_WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  ]);
});

test("CLI always exits zero for missing configuration, files, and invalid destinations", async (t) => {
  const path = fixture(t);
  const cli = fileURLToPath(new URL("../dist/review-usage-submit.js", import.meta.url));
  for (const [file, baseUrl, secret] of [
    [path, "", ""],
    [path + ".missing", ENV.EXACT_REVIEW_QUEUE_URL, ENV.CLAWSWEEPER_WEBHOOK_SECRET],
    [path, "http://example.com", ENV.CLAWSWEEPER_WEBHOOK_SECRET],
  ]) {
    const result = await promisify(execFile)(process.execPath, [cli, file!], {
      env: {
        ...process.env,
        EXACT_REVIEW_QUEUE_URL: baseUrl!,
        CLAWSWEEPER_WEBHOOK_SECRET: secret!,
      },
      timeout: 10000,
    });
    assert.equal(result.stdout, "");
    assert.ok(
      result.stderr === "" ||
        result.stderr === "[review-usage] best-effort telemetry unavailable\n",
    );
  }
});

test("compiled submission reaches the authenticated receiver for full, partial, and missing usage", async (t) => {
  const records = [
    RECORD,
    { ...RECORD, usage: { ...RECORD.usage, cache_write_input_tokens: null } },
    { ...RECORD, usage: null },
    { ...RECORD, usage: { ...RECORD.usage, cache_write_input_tokens: 0 } },
  ];
  const path = fixture(t, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const points: ReviewUsageDataPoint[] = [];
  const statuses: number[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const result = await worker.fetch(
      new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body,
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: ENV.CLAWSWEEPER_WEBHOOK_SECRET,
        REVIEW_USAGE: { writeDataPoint: (point) => points.push(point) },
        get EXACT_REVIEW_QUEUE() {
          throw new Error("Usage ingestion must not access queue state");
        },
      },
    );
    statuses.push(result.status);
    response.writeHead(result.status).end(await result.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => promisify(server.close.bind(server))());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const rejected = await fetch(`${baseUrl}/internal/exact-review/review-usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(records[1]),
  });
  assert.equal(rejected.status, 401);
  await rejected.body?.cancel();
  assert.deepEqual(points, []);
  const cli = fileURLToPath(new URL("../dist/review-usage-submit.js", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [cli, path], {
    env: { ...process.env, ...ENV, EXACT_REVIEW_QUEUE_URL: baseUrl },
    timeout: 10000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(statuses, [401, 202, 202, 202, 202]);
  assert.deepEqual(
    points.map((point) => point.doubles),
    [
      [1000, 200, 50, 100, 30, 12500, 1, 1],
      [1000, 200, 0, 100, 30, 12500, 0, 1],
      [0, 0, 0, 0, 0, 12500, 0, 0],
      [1000, 200, 0, 100, 30, 12500, 1, 1],
    ],
  );
});
