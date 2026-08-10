import assert from "node:assert/strict";
import test from "node:test";

import { publishExactReviewBatch } from "../../dist/repair/exact-review-batch-publisher.js";
import {
  exactReviewDirectPublicationEnabled,
  postDirectPublicationResult,
} from "../../dist/repair/exact-review-direct-publication.js";

const members = [
  { itemKey: "openclaw/openclaw#1", revision: 1, claimGeneration: 1 },
  { itemKey: "openclaw/openclaw#2", revision: 1, claimGeneration: 1 },
  { itemKey: "openclaw/openclaw#3", revision: 1, claimGeneration: 1 },
];

test("batch publisher isolates poison members and commits healthy plans once", async () => {
  let commits = 0;
  const result = await publishExactReviewBatch(members, {
    async prepare(member) {
      if (member.itemKey.endsWith("#1"))
        return { kind: "retryable", reason: "artifact_unavailable" };
      if (member.itemKey.endsWith("#2")) return { kind: "superseded" };
      return { kind: "eligible", plan: plan(member) };
    },
    async deliverGithubEffects() {
      return "ready";
    },
    async commit(plans) {
      commits += 1;
      assert.equal(plans.length, 1);
      return { commitSha: "a".repeat(40) };
    },
  });
  assert.equal(commits, 1);
  assert.deepEqual(result.completions.map((item) => item.terminalOutcome).sort(), [
    "published",
    "superseded",
  ]);
  assert.equal(result.retryable[0]?.reason, "artifact_unavailable");
});

test("shared commit failure leaves only commit candidates retryable", async () => {
  const result = await publishExactReviewBatch(members.slice(0, 2), {
    async prepare(member) {
      return { kind: "eligible", plan: plan(member) };
    },
    async deliverGithubEffects() {
      return "ready";
    },
    async commit() {
      throw new Error("ambiguous push");
    },
  });
  assert.equal(result.completions.length, 0);
  assert.equal(result.retryable.length, 2);
  assert.equal(result.stateCommitSha, null);
});

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

test("direct publication flag defaults through workflow wiring while explicit off stays legacy", () => {
  assert.equal(exactReviewDirectPublicationEnabled("1"), true);
  assert.equal(exactReviewDirectPublicationEnabled("true"), true);
  assert.equal(exactReviewDirectPublicationEnabled("0"), false);
  assert.equal(exactReviewDirectPublicationEnabled(undefined), false);
});

function plan(member: (typeof members)[number]) {
  return {
    identity: member,
    operations: [
      {
        path: `records/openclaw-openclaw/items/${member.itemKey.at(-1)}.md`,
        deleted: false,
        mode: "100644" as const,
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
  };
}

function directPayload() {
  return {
    canonicalTargetKey: "openclaw/openclaw#1",
    fenceKey: "openclaw/openclaw#1",
    revision: 1,
    identity: {
      canonicalTargetKey: "openclaw/openclaw#1",
      fenceKey: "openclaw/openclaw#1",
      ...members[0]!,
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
