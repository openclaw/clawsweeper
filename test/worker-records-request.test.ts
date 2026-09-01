import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  discoverWorkerRecordRepoSlugs,
  downloadWorkerSnapshot,
  exportWorkerRecords,
  fetchWorkerCanonicalItemIds,
  fetchWorkerStoredSnapshot,
  signedPost,
} from "../scripts/worker-records.ts";

const baseUrl = "http://127.0.0.1:8787";
const webhookSecret = "test-secret";

function jsonResponse(status: number, body: unknown, contentType = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function fetchStub(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("fetch stub exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

function captureRetryDelays(t: TestContext) {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const immediateSetTimeout = (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (![250, 500, 30_000, 60_000].includes(Number(delay))) {
      return originalSetTimeout(callback, delay, ...args);
    }
    delays.push(Number(delay));
    queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  t.mock.method(globalThis, "setTimeout", immediateSetTimeout as typeof setTimeout);
  return delays;
}

test("canonical record export recovers through a signed loopback HTTP transport", async (t) => {
  const requests: Array<{
    body: string;
    method: string | undefined;
    path: string;
    signature: string;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      body: Buffer.concat(chunks).toString("utf8"),
      method: request.method,
      path: request.url ?? "",
      signature: String(request.headers["x-clawsweeper-exact-review-signature"] ?? ""),
    });
    response.setHeader("content-type", "application/json");
    if (requests.length === 1) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "exact_review_queue_unavailable" }));
      return;
    }
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        repoSlug: "openclaw-openclaw",
        revision: 7,
        records: [],
        nextCursor: null,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const delays = captureRetryDelays(t);

  const snapshot = await exportWorkerRecords({
    baseUrl: `http://127.0.0.1:${address.port}`,
    webhookSecret,
    repoSlug: "openclaw-openclaw",
  });

  assert.equal(snapshot.revision, 7);
  assert.equal(requests.length, 2);
  assert.deepEqual(delays, [30_000]);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/internal/state/records/export");
    assert.equal(
      request.signature,
      `sha256=${createHmac("sha256", webhookSecret).update(request.body).digest("hex")}`,
    );
  }
});

test("signedPost surfaces status and error code from a non-OK response without cloning", async () => {
  const { calls, fetchImpl } = fetchStub([jsonResponse(422, { error: "invalid_repo" })]);
  await assert.rejects(
    signedPost({ baseUrl, path: "/internal/test", webhookSecret, body: {}, fetch: fetchImpl }),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.notEqual(error.name, "TypeError");
      assert.equal(error.status, 422);
      assert.equal(error.code, "invalid_repo");
      assert.match(error.message, /422/);
      assert.match(error.message, /invalid_repo/);
      return true;
    },
  );
  assert.equal(calls.length, 1, "4xx must not retry");
});

test("signedPost includes a body snippet for non-JSON error bodies", async () => {
  const { fetchImpl } = fetchStub([jsonResponse(403, "<html>edge denied</html>", "text/html")]);
  await assert.rejects(
    signedPost({ baseUrl, path: "/internal/test", webhookSecret, body: {}, fetch: fetchImpl }),
    (error: Error & { status?: number; code?: string; bodySnippet?: string }) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "403");
      assert.equal(error.bodySnippet, "<html>edge denied</html>");
      assert.match(error.message, /edge denied/);
      return true;
    },
  );
});

test("signedPost throws invalid_json_body for persistently empty 2xx bodies", async () => {
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(200, ""),
    jsonResponse(200, ""),
    jsonResponse(200, ""),
  ]);
  await assert.rejects(
    signedPost({ baseUrl, path: "/internal/test", webhookSecret, body: {}, fetch: fetchImpl }),
    (error: Error & { status?: number; code?: string; bodySnippet?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.equal(error.status, 200);
      assert.equal(error.code, "invalid_json_body");
      assert.equal(error.bodySnippet, "");
      return true;
    },
  );
  assert.equal(calls.length, 3, "transient blank 2xx bodies retry within the bounded budget");
});

test("signedPost recovers when a blank 2xx body clears on retry", async () => {
  const { calls, fetchImpl } = fetchStub([jsonResponse(200, ""), jsonResponse(200, { ok: true })]);
  const value = await signedPost<{ ok: boolean }>({
    baseUrl,
    path: "/internal/test",
    webhookSecret,
    body: {},
    fetch: fetchImpl,
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls.length, 2);
});

test("signedPost throws invalid_json_body with a snippet for a 2xx HTML body", async () => {
  const { fetchImpl } = fetchStub([
    jsonResponse(200, "<html><body>maintenance page</body></html>", "text/html"),
    jsonResponse(200, "<html><body>maintenance page</body></html>", "text/html"),
    jsonResponse(200, "<html><body>maintenance page</body></html>", "text/html"),
  ]);
  await assert.rejects(
    signedPost({ baseUrl, path: "/internal/test", webhookSecret, body: {}, fetch: fetchImpl }),
    (error: Error & { status?: number; code?: string; bodySnippet?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.equal(error.status, 200);
      assert.equal(error.code, "invalid_json_body");
      assert.equal(error.bodySnippet, "<html><body>maintenance page</body></html>");
      assert.match(error.message, /invalid_json_body/);
      assert.match(error.message, /maintenance page/);
      return true;
    },
  );
});

test("signedPost throws invalid_json_body for a 2xx response with a literal null body", async () => {
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(200, "null"),
    jsonResponse(200, "null"),
    jsonResponse(200, "null"),
  ]);
  await assert.rejects(
    signedPost({ baseUrl, path: "/internal/test", webhookSecret, body: {}, fetch: fetchImpl }),
    (error: Error & { status?: number; code?: string; bodySnippet?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.equal(error.status, 200);
      assert.equal(error.code, "invalid_json_body");
      assert.equal(error.bodySnippet, "null");
      return true;
    },
  );
  assert.equal(calls.length, 3);
});

test("signedPost resends the full JSON request body on a retry after a 502", async () => {
  const responses = [
    jsonResponse(502, "<html>bad gateway</html>", "text/html"),
    jsonResponse(200, { ok: true }),
  ];
  const bodies: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    const next = responses.shift();
    if (!next) throw new Error("fetch stub exhausted");
    return next;
  };
  const payload = { repoSlug: "openclaw-openclaw", sections: ["items"], cursor: 0 };
  const value = await signedPost<{ ok: boolean }>({
    baseUrl,
    path: "/internal/test",
    webhookSecret,
    body: payload,
    fetch: fetchImpl,
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], JSON.stringify(payload), "first attempt must carry the full JSON body");
  assert.equal(bodies[1], bodies[0], "retry must resend an identical body payload");
});

test("signedPost keeps the short retry schedule for callers outside record reads", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(502, "<html>bad gateway</html>", "text/html"),
    jsonResponse(502, { error: "upstream_unavailable" }),
    jsonResponse(200, { ok: true }),
  ]);
  const value = await signedPost<{ ok: boolean }>({
    baseUrl,
    path: "/internal/test",
    webhookSecret,
    body: {},
    fetch: fetchImpl,
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("signedPost surfaces the final 5xx after exhausting retries", async () => {
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(502, { error: "upstream_unavailable" }),
    jsonResponse(503, { error: "overloaded" }),
    jsonResponse(502, { error: "upstream_unavailable" }),
  ]);
  await assert.rejects(
    signedPost({ baseUrl, path: "/internal/test", webhookSecret, body: {}, fetch: fetchImpl }),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.equal(error.status, 502);
      assert.equal(error.code, "upstream_unavailable");
      return true;
    },
  );
  assert.equal(calls.length, 3);
});

test("signedPost retries network errors and succeeds", async () => {
  const { calls, fetchImpl } = fetchStub([
    new TypeError("fetch failed"),
    jsonResponse(200, { ok: true }),
  ]);
  const value = await signedPost<{ ok: boolean }>({
    baseUrl,
    path: "/internal/test",
    webhookSecret,
    body: {},
    fetch: fetchImpl,
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls.length, 2);
});

test("exportWorkerRecords does not retry a deterministic 4xx", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([jsonResponse(409, { error: "revision_conflict" })]);
  await assert.rejects(
    exportWorkerRecords({
      baseUrl,
      webhookSecret,
      repoSlug: "openclaw-openclaw",
      fetch: fetchImpl,
    }),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.equal(error.status, 409);
      assert.equal(error.code, "revision_conflict");
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("exportWorkerRecords waits thirty seconds then one minute across eligible retries", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(502, "<html>cloudflare 502</html>", "text/html"),
    jsonResponse(500, { error: "exact_review_queue_unavailable" }),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      revision: 7,
      records: [],
      nextCursor: null,
    }),
  ]);
  const snapshot = await exportWorkerRecords({
    baseUrl,
    webhookSecret,
    repoSlug: "openclaw-openclaw",
    fetch: fetchImpl,
  });
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.records, []);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
});

test("record reads share one three-attempt budget across 5xx and invalid 2xx failures", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(502, { error: "exact_review_queue_unavailable" }),
    jsonResponse(200, "null"),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      revision: 7,
      records: [],
      nextCursor: null,
    }),
  ]);
  const snapshot = await exportWorkerRecords({
    baseUrl,
    webhookSecret,
    repoSlug: "openclaw-openclaw",
    fetch: fetchImpl,
  });
  assert.equal(snapshot.revision, 7);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
});

test("record reads retry malformed endpoint envelopes, rows, and cursors", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      revision: 7,
      records: [{}],
      nextCursor: null,
    }),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      revision: 7,
      records: [],
      nextCursor: 0,
    }),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      revision: 7,
      records: [],
      nextCursor: null,
    }),
  ]);
  const snapshot = await exportWorkerRecords({
    baseUrl,
    webhookSecret,
    repoSlug: "openclaw-openclaw",
    fetch: fetchImpl,
  });
  assert.equal(snapshot.revision, 7);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
});

test("record reads surface pre-fetch configuration errors without long retries", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([]);
  await assert.rejects(
    exportWorkerRecords({
      baseUrl: "http://worker.example.test",
      webhookSecret,
      repoSlug: "openclaw-openclaw",
      fetch: fetchImpl,
    }),
    /Worker record URL must use HTTPS/,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(delays, []);
});

test("stored-snapshot reads remain fail-closed after the long retry budget", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(500, { error: "exact_review_queue_unavailable" }),
    jsonResponse(500, { error: "exact_review_queue_unavailable" }),
    jsonResponse(500, { error: "exact_review_queue_unavailable" }),
  ]);
  await assert.rejects(
    fetchWorkerStoredSnapshot({
      baseUrl,
      webhookSecret,
      repoSlug: "openclaw-openclaw",
      fetch: fetchImpl,
    }),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.name, "WorkerRecordRequestError");
      assert.equal(error.status, 500);
      assert.equal(error.code, "exact_review_queue_unavailable");
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
});

test("snapshot chunks retry malformed successful responses within the shared budget", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-snapshot-chunk-retry-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const archivePath = join(root, "snapshot.tar.gz");
  const bytes = Buffer.from("snapshot-bytes");
  const expectedRange = `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`;
  const malformedStatus = new Response(bytes, { status: 200 });
  const malformedRange = new Response(bytes, {
    status: 206,
    headers: { "content-range": `bytes 1-${bytes.byteLength}/${bytes.byteLength}` },
  });
  const valid = new Response(bytes, {
    status: 206,
    headers: { "content-range": expectedRange },
  });
  const { calls, fetchImpl } = fetchStub([malformedStatus, malformedRange, valid]);
  const delays = captureRetryDelays(t);

  await downloadWorkerSnapshot({
    archivePath,
    baseUrl,
    webhookSecret,
    snapshot: {
      repoSlug: "openclaw-openclaw",
      revisionWatermark: 7,
      objectKey: "records/openclaw-openclaw/7.tar.gz",
      bytes: bytes.byteLength,
      uncompressedBytes: bytes.byteLength,
      fileCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      access: { mode: "worker_range_proxy", maxChunkBytes: bytes.byteLength },
    },
    fetch: fetchImpl,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
  assert.deepEqual(readFileSync(archivePath), bytes);
});

test("slug discovery retries malformed repository entries", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(200, { repositories: [{}] }),
    jsonResponse(200, {
      repositories: [{ repoSlug: "openclaw-openclaw", revision: 12 }],
    }),
  ]);
  assert.deepEqual(
    await discoverWorkerRecordRepoSlugs({ baseUrl, webhookSecret, fetch: fetchImpl }),
    [{ repoSlug: "openclaw-openclaw", revision: 12 }],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [30_000]);
});

test("canonical item listing retries malformed rows and inconsistent cursors", async (t) => {
  const delays = captureRetryDelays(t);
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      section: "items",
      records: [{}],
      nextCursor: null,
    }),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      section: "items",
      records: [{ id: 1 }],
      nextCursor: 2,
    }),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      section: "items",
      records: [{ id: 1 }],
      nextCursor: null,
    }),
  ]);
  assert.deepEqual(
    await fetchWorkerCanonicalItemIds({
      baseUrl,
      webhookSecret,
      repoSlug: "openclaw-openclaw",
      fetch: fetchImpl,
    }),
    [1],
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
});

test("fetchWorkerCanonicalItemIds pages the exact coverage identity set", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      section: "items",
      records: [{ id: 1 }, { id: 500 }],
      nextCursor: 500,
    }),
    jsonResponse(200, {
      repoSlug: "openclaw-openclaw",
      section: "items",
      records: [{ id: 501 }, { id: 3_020 }],
      nextCursor: null,
    }),
  ];
  const ids = await fetchWorkerCanonicalItemIds({
    baseUrl,
    webhookSecret,
    repoSlug: "openclaw-openclaw",
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("fetch stub exhausted");
      return response;
    },
  });

  assert.deepEqual(ids, [1, 500, 501, 3_020]);
  assert.deepEqual(
    requests.map((request) => request.cursor),
    [0, 500],
  );
});
