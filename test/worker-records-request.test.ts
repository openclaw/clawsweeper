import assert from "node:assert/strict";
import test from "node:test";

import { exportWorkerRecords, signedPost } from "../scripts/worker-records.ts";

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

test("signedPost retries 5xx responses and succeeds within the attempt budget", async () => {
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

test("exportWorkerRecords surfaces the worker error code for a consumed-body failure", async () => {
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
});

test("exportWorkerRecords rides out a transient 502 during export", async () => {
  const { calls, fetchImpl } = fetchStub([
    jsonResponse(502, "<html>cloudflare 502</html>", "text/html"),
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
  assert.equal(calls.length, 2);
});
