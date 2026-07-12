import assert from "node:assert/strict";
import test from "node:test";

import { deterministicRequeueDispatchKey } from "../../dist/repair/requeue-job-key.js";

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
