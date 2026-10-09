import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const lease = {
  EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#1",
  EXACT_REVIEW_LEASE_ID: "lease-1",
  EXACT_REVIEW_LEASE_REVISION: "3",
  EXACT_REVIEW_CLAIM_GENERATION: "2",
  EXACT_REVIEW_SOURCE_HEAD_SHA: ` ${"A".repeat(40)} `,
  GITHUB_RUN_ID: "10",
  GITHUB_RUN_ATTEMPT: "1",
  TARGET_REPO: "openclaw/openclaw",
  ITEM_NUMBER: "1",
  FENCE_KEY: "openclaw/openclaw#1",
  REVISION: "4",
};

function run(argv: string[], env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["dist/repair/exact-review-queue-request.js", ...argv],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...lease, ...env },
    },
  );
  return { status: result.status, body: result.stdout, error: result.stderr };
}

function request(args: string[], env: Record<string, string> = {}) {
  return run(["heartbeat", ...args], env);
}

function lifecycle(args: string[], env: Record<string, string> = {}) {
  return run(["lifecycle", ...args], env);
}

test("heartbeat bodies carry the lease tuple and the phase options the queue accepts", () => {
  const tuple = {
    item_key: "openclaw/openclaw#1",
    lease_id: "lease-1",
    lease_revision: 3,
    claim_generation: 2,
    run_id: "10",
    run_attempt: 1,
    source_head_sha: "a".repeat(40),
  };
  assert.deepEqual(JSON.parse(request(["--phase", "finalizing"]).body), {
    ...tuple,
    phase: "finalizing",
  });
  assert.deepEqual(JSON.parse(request(["--phase", "review", "--generation-start"]).body), {
    ...tuple,
    phase: "review",
    generation_start: true,
  });
  assert.equal(
    request(["--phase", "status", "--review-acknowledgement-comment-id", "7001"]).body,
    JSON.stringify({ ...tuple, review_acknowledgement_comment_id: 7001, phase: "status" }),
  );
  const { source_head_sha: _sourceHeadSha, ...tupleWithoutSha } = tuple;
  assert.deepEqual(
    JSON.parse(request(["--phase", "status"], { EXACT_REVIEW_SOURCE_HEAD_SHA: "" }).body),
    { ...tupleWithoutSha, phase: "status" },
  );
});

test("heartbeat requests with an invalid tuple or phase option print no body", () => {
  for (const [args, env, message] of [
    [
      ["--phase", "review"],
      { EXACT_REVIEW_LEASE_REVISION: "0" },
      "invalid EXACT_REVIEW_LEASE_REVISION",
    ],
    [["--phase", "review"], { EXACT_REVIEW_LEASE_ID: "" }, "missing exact-review lease tuple"],
    [
      ["--phase", "review"],
      { EXACT_REVIEW_SOURCE_HEAD_SHA: "abc" },
      "invalid EXACT_REVIEW_SOURCE_HEAD_SHA",
    ],
    [["--phase", "review"], { GITHUB_RUN_ID: "run-10" }, "invalid GITHUB_RUN_ID"],
    [["--phase", "paused"], {}, "--phase must be review, status or finalizing"],
    [["--phase", "status", "--generation-start"], {}, "--generation-start requires --phase review"],
    [
      ["--phase", "review", "--review-acknowledgement-comment-id", "7001"],
      {},
      "--review-acknowledgement-comment-id requires --phase status",
    ],
    [
      ["--phase", "status", "--review-acknowledgement-comment-id", ""],
      {},
      "invalid --review-acknowledgement-comment-id",
    ],
  ] as const) {
    const result = request([...args], env);
    assert.equal(result.status, 1, message);
    assert.equal(result.body, "", message);
    assert.equal(result.error, `exact-review-queue-request: ${message}\n`);
  }
});

test("lifecycle bodies name the target revision and the run that records them", () => {
  const target = {
    canonical_target_key: "openclaw/openclaw#1",
    fence_key: "openclaw/openclaw#1",
    revision: 4,
  };
  assert.equal(
    lifecycle([
      "router-receipt",
      "--outcome",
      "not_required",
      "--receipt-id-prefix",
      "router-not-required",
    ]).body,
    JSON.stringify({ ...target, outcome: "not_required", receipt_id: "router-not-required:10:1" }),
  );
  // The queue reads a router receipt without an outcome as durable.
  assert.equal(
    lifecycle(["router-receipt", "--receipt-id-prefix", "router"]).body,
    JSON.stringify({ ...target, receipt_id: "router:10:1" }),
  );
  assert.equal(
    lifecycle(["canonical-receipt", "--outcome", "accepted", "--receipt-id-prefix", "fallback"])
      .body,
    JSON.stringify({ ...target, outcome: "accepted", receipt_id: "fallback:10:1" }),
  );
  assert.equal(
    lifecycle(["terminal-disposition", "--kind", "policy_noop"], { GITHUB_RUN_ID: "" }).body,
    JSON.stringify({ ...target, kind: "policy_noop" }),
  );
});

test("lifecycle requests with an invalid target or record option print no body", () => {
  const receipt = ["router-receipt", "--outcome", "durable", "--receipt-id-prefix", "router"];
  for (const [args, env, message] of [
    [receipt, { REVISION: "0" }, "invalid REVISION"],
    [receipt, { FENCE_KEY: "" }, "missing FENCE_KEY"],
    [receipt, { TARGET_REPO: "openclaw" }, "invalid TARGET_REPO"],
    [receipt, { ITEM_NUMBER: "" }, "invalid ITEM_NUMBER"],
    [receipt, { GITHUB_RUN_ATTEMPT: "0" }, "invalid GITHUB_RUN_ATTEMPT"],
    [
      ["router-receipt", "--outcome", "accepted", "--receipt-id-prefix", "router"],
      {},
      "--outcome must be durable, not_required",
    ],
    [["router-receipt", "--outcome", "durable"], {}, "invalid --receipt-id-prefix"],
    [
      ["router-receipt", "--outcome", "durable", "--receipt-id-prefix", "router:1"],
      {},
      "invalid --receipt-id-prefix",
    ],
    [
      ["canonical-receipt", "--receipt-id-prefix", "fallback"],
      {},
      "--outcome must be accepted, deduped, superseded",
    ],
    [
      ["terminal-disposition", "--kind", "review_completed_routed"],
      {},
      "--kind must be requeue, target_missing, target_closed, guarded_open, policy_noop",
    ],
    [
      ["claim-receipt"],
      {},
      "lifecycle record must be router-receipt, canonical-receipt or terminal-disposition",
    ],
  ] as const) {
    const result = lifecycle([...args], env);
    assert.equal(result.status, 1, message);
    assert.equal(result.body, "", message);
    assert.equal(result.error, `exact-review-queue-request: ${message}\n`);
  }
});
