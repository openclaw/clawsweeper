import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_BODY_BUCKET,
  canonicalBodyLifecycleRules,
  verifyCanonicalBodyLifecycle,
} from "../src/canonical-body-tiering-policy.ts";
import { stableJson } from "../src/stable-json.ts";

// Shape returned by R2 for its enabled default, bucket-wide multipart abort rule.
const observedPolicy = {
  rules: [
    {
      id: "Default Multipart Abort Rule",
      enabled: true,
      conditions: {},
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
    },
  ],
};

test("bucket-wide multipart abort policy retains its observed shape through read-only verification", async () => {
  const rulesJson = canonicalBodyLifecycleRules(observedPolicy);
  assert.equal(rulesJson, stableJson(observedPolicy));
  assert.deepEqual(JSON.parse(rulesJson), observedPolicy);
  let requests = 0;
  await verifyCanonicalBodyLifecycle(
    { bucketLifecycle: { bucketIdentity: CANONICAL_BODY_BUCKET, rulesJson } },
    "a".repeat(32),
    "synthetic-token",
    async (input, init) => {
      requests++;
      const request = new Request(input, init);
      assert.equal(request.method, "GET");
      assert.equal(request.body, null);
      assert.equal(
        request.url,
        `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/r2/buckets/${CANONICAL_BODY_BUCKET}/lifecycle`,
      );
      return Response.json({ success: true, result: observedPolicy });
    },
  );
  assert.equal(requests, 1);
});

test("omitted and empty prefixes cannot hide bucket-wide object deletion", () => {
  for (const conditions of [{}, { prefix: "" }]) {
    const policy = {
      rules: [{ enabled: true, conditions, deleteObjectsTransition: {} }],
    };
    assert.throws(() => canonicalBodyLifecycleRules(policy), /canonical bodies must not expire/);
    policy.rules[0]!.enabled = false;
    assert.equal(canonicalBodyLifecycleRules(policy), stableJson(policy));
  }
});

test("optional prefixes do not admit malformed conditions or explicit prefixes", () => {
  for (const conditions of [
    undefined,
    null,
    true,
    1,
    "",
    "prefix",
    [],
    { prefix: null },
    { prefix: true },
    { prefix: 1 },
    { prefix: {} },
    { prefix: [] },
  ]) {
    assert.throws(
      () => canonicalBodyLifecycleRules({ rules: [{ enabled: true, conditions }] }),
      /invalid bucket lifecycle rule/,
    );
  }
});
