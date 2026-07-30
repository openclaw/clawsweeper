import assert from "node:assert/strict";
import test from "node:test";

import {
  exportWorkerRecords,
  fetchWorkerCanonicalItemIds,
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

test("signedPost throws invalid_json_body for a 2xx response with an empty body", async () => {
  const { calls, fetchImpl } = fetchStub([jsonResponse(200, "")]);
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
  assert.equal(calls.length, 1, "2xx must not retry");
});

test("signedPost throws invalid_json_body with a snippet for a 2xx HTML body", async () => {
  const { fetchImpl } = fetchStub([
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
  const { calls, fetchImpl } = fetchStub([jsonResponse(200, "null")]);
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
  assert.equal(calls.length, 1);
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
