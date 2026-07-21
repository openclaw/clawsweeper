import assert from "node:assert/strict";
import test from "node:test";

import { publishExactReviewBatch } from "../../dist/repair/exact-review-batch-publisher.js";

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

function plan(member: (typeof members)[number]) {
  return {
    identity: member,
    operations: [
      {
        path: `records/openclaw-openclaw/items/${member.itemKey.at(-1)}.md`,
        expectedOid: null,
        targetOid: "a".repeat(40),
        mode: "100644" as const,
        bytes: 1,
      },
    ],
    totalBytes: 1,
  };
}
