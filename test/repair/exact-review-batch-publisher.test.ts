import assert from "node:assert/strict";
import test from "node:test";

import {
  exactReviewDirectPublicationEnabled,
  postDirectPublicationResult,
} from "../../dist/repair/exact-review-direct-publication.js";

test("direct producer retries bounded failures then requests legacy enqueue fallback", async () => {
  let calls = 0;
  const requests: Array<{ url: string; body: unknown }> = [];
  const payload = directPayload();
  const result = await postDirectPublicationResult({
    baseUrl: "https://clawsweeper.openclaw.ai",
    webhookSecret: "test-secret",
    payload,
    attempts: 3,
    sleep: async () => undefined,
    fetch: async (url, init) => {
      calls += 1;
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ error: "worker_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(
    requests,
    Array.from({ length: 3 }, () => ({
      url: "https://clawsweeper.openclaw.ai/internal/exact-review/publication-results",
      body: payload,
    })),
  );
  assert.deepEqual(result, {
    kind: "fallback",
    attempts: 3,
    reason: "worker_unavailable",
    status: 503,
  });
});

test("direct producer treats structured 413 as immediate legacy fallback", async () => {
  let calls = 0;
  const result = await postDirectPublicationResult({
    baseUrl: "https://clawsweeper.openclaw.ai",
    webhookSecret: "test-secret",
    payload: directPayload(),
    attempts: 3,
    sleep: async () => undefined,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "direct_publication_payload_too_large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.kind, "fallback");
  assert.equal(result.status, 413);
});

test("direct producer includes a structured rejection detail in its fallback reason", async () => {
  const result = await postDirectPublicationResult({
    baseUrl: "https://clawsweeper.openclaw.ai",
    webhookSecret: "test-secret",
    payload: directPayload(),
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: "invalid_direct_publication_plan",
          fallback_required: true,
          detail: "invalid direct publication revision",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });
  assert.deepEqual(result, {
    kind: "fallback",
    attempts: 1,
    reason: "invalid_direct_publication_plan: invalid direct publication revision",
    status: 400,
  });
});

test("direct and batch producers accept fenced supersession without legacy fallback", async () => {
  for (const path of [
    "/internal/exact-review/publication-results",
    "/internal/exact-review/publication-batch-results",
  ] as const) {
    let calls = 0;
    const response = {
      ok: true,
      accepted: false,
      deduped: false,
      superseded: true,
      superseded_revisions: [],
      canonical_target_key: "openclaw/openclaw#1",
      fence_key: "openclaw/openclaw#1",
      state_commit_sha: null,
    };
    const result = await postDirectPublicationResult({
      baseUrl: "https://clawsweeper.openclaw.ai",
      webhookSecret: "test-secret",
      payload: directPayload(),
      path,
      fetch: async () => {
        calls += 1;
        return Response.json(response, { status: 202 });
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(result, { kind: "accepted", attempts: 1, response });
  }
});

test("direct publication flag defaults through workflow wiring while explicit off stays legacy", () => {
  assert.equal(exactReviewDirectPublicationEnabled("1"), true);
  assert.equal(exactReviewDirectPublicationEnabled("true"), true);
  assert.equal(exactReviewDirectPublicationEnabled("0"), false);
  assert.equal(exactReviewDirectPublicationEnabled(undefined), false);
});

function directPayload() {
  return {
    canonicalTargetKey: "openclaw/openclaw#1",
    fenceKey: "openclaw/openclaw#1",
    revision: 1,
    identity: {
      canonicalTargetKey: "openclaw/openclaw#1",
      fenceKey: "openclaw/openclaw#1",
      itemKey: "openclaw/openclaw#1",
      revision: 1,
      claimGeneration: 1,
    },
    operations: [
      {
        path: "records/openclaw-openclaw/items/1.md",
        deleted: false,
        mode: "100644" as const,
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
  };
}
