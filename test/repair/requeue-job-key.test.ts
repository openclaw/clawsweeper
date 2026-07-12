import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedNextRequeueDepth,
  deterministicRequeueDispatchKey,
  normalizedRequeueSourceJobPath,
} from "../../dist/repair/requeue-job-key.js";

const base = {
  repo: "openclaw/clawsweeper",
  workflow: "repair-cluster-worker.yml",
  sourceRunId: "123456789",
  sourceJobPath: "jobs/openclaw-openclaw/pr-42.md",
  authorizationSha256: "a".repeat(64),
  depth: 1,
};

test("requeue dispatch identity binds source job digest and depth", () => {
  const key = deterministicRequeueDispatchKey(base);

  assert.match(key, /^requeue-1-[0-9a-f]{24}$/);
  assert.equal(deterministicRequeueDispatchKey({ ...base }), key);
  assert.notEqual(deterministicRequeueDispatchKey({ ...base, sourceRunId: "123456790" }), key);
  assert.notEqual(
    deterministicRequeueDispatchKey({ ...base, authorizationSha256: "b".repeat(64) }),
    key,
  );
  assert.notEqual(deterministicRequeueDispatchKey({ ...base, depth: 2 }), key);
});

test("requeue depth advances once and respects the production bound", () => {
  assert.equal(boundedNextRequeueDepth(0, 1), 1);
  assert.throws(() => boundedNextRequeueDepth(1, 1), /reached the maximum 1/);
  assert.throws(() => boundedNextRequeueDepth(-1, 1), /non-negative integer/);
});

test("requeue source paths preserve the original jobs path for sealed local jobs", () => {
  assert.equal(
    normalizedRequeueSourceJobPath(
      "jobs/openclaw/inbox/automerge-openclaw-openclaw-514.md",
      ".clawsweeper-repair/authorized/job.md",
    ),
    "jobs/openclaw/inbox/automerge-openclaw-openclaw-514.md",
  );
  assert.throws(
    () => normalizedRequeueSourceJobPath("../private/job.md", "jobs/openclaw/inbox/job.md"),
    /normalized relative jobs/,
  );
});
