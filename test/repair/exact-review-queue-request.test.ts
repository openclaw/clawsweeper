import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The claim reads the dispatch tuple. The completion reads the claim outputs
// and the results of the review steps.
const completion = {
  QUEUE_LEASE_ID: "lease-7",
  ITEM_KEY: "openclaw/openclaw#7",
  QUEUE_LEASE_REVISION: "3",
  PROTOCOL_VERSION: "2",
  CLAIM_GENERATION: "2",
  PRIMARY_OUTCOME: "success",
};

function leaseStep(record: string, env: Record<string, string> = {}) {
  return run(record.split(" "), { ...completion, ...env });
}

function run(
  argv: string[],
  env: Record<string, string>,
  script = "dist/repair/exact-review-queue-request.js",
) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...lease, ...env },
  });
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
      "lifecycle record must be router-receipt, canonical-receipt, terminal-disposition, command-ack-failed or command-ack-observed",
    ],
  ] as const) {
    const result = lifecycle([...args], env);
    assert.equal(result.status, 1, message);
    assert.equal(result.body, "", message);
    assert.equal(result.error, `exact-review-queue-request: ${message}\n`);
  }
});

// Steps that run before checkout download only this source file and run it with
// the runner Node, which strips the types. It must not need the build.
test("the source file alone gives the same bodies and errors as the build", () => {
  const dir = mkdtempSync(join(tmpdir(), "exact-review-queue-request-"));
  try {
    const copy = join(dir, "exact-review-queue-request.mts");
    copyFileSync("src/repair/exact-review-queue-request.ts", copy);
    // The legacy intake payload, the claim and completion inputs and a 409
    // response; each record reads only its own inputs.
    const env = {
      CLIENT_PAYLOAD: JSON.stringify({
        item_kind: "pull_request",
        item_number: 5,
        target_branch: "main",
      }),
      ...completion,
      RESPONSE: JSON.stringify({ error: "lease_superseded" }),
    };
    for (const argv of [
      [
        "lifecycle",
        "router-receipt",
        "--outcome",
        "durable",
        "--receipt-id-prefix",
        "router-direct-recovery",
      ],
      ["lifecycle", "terminal-disposition", "--kind", "requeue"],
      ["lifecycle", "terminal-disposition", "--kind", "review_completed_routed"],
      ["heartbeat", "--phase", "status"],
      ["enqueue", "route"],
      ["enqueue", "body"],
      ["claim", "body"],
      ["claim", "conflict"],
      ["complete", "body"],
      ["complete", "conflict"],
    ]) {
      const built = run(argv, env);
      assert.deepEqual(run(argv, env, copy), built, argv.join(" "));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command acknowledgement bodies carry the status address and the verified completion", () => {
  const target = {
    canonical_target_key: "openclaw/openclaw#1",
    fence_key: "openclaw/openclaw#1",
    revision: 4,
  };
  // A failed status write may carry no address; the attempt id fences it.
  assert.equal(
    lifecycle([
      "command-ack-failed",
      "--attempt-id",
      "ack:1",
      "--status-marker",
      "",
      "--status-comment-id",
      "",
    ]).body,
    JSON.stringify({ ...target, attempt_id: "ack:1" }),
  );
  const before = Date.now();
  const observed = JSON.parse(
    lifecycle([
      "command-ack-observed",
      "--status-marker",
      "marker",
      "--status-comment-id",
      "7",
      "--command-comment-id",
      "8",
      "--completion-comment-id",
      "9",
      "--completed-at",
      "2026-10-09T00:00:00Z",
      "--completion-outcome",
      "failure",
    ]).body,
  );
  assert.ok(observed.observed_at >= before && observed.observed_at <= Date.now());
  assert.equal(
    JSON.stringify(observed),
    JSON.stringify({
      ...target,
      status_marker: "marker",
      status_comment_id: 7,
      command_comment_id: 8,
      completion_comment_id: 9,
      completed_at: "2026-10-09T00:00:00Z",
      completion_outcome: "failure",
      observed_at: observed.observed_at,
    }),
  );
});

test("terminal-finalization bodies carry the claimed lease tuple before the status address", () => {
  const tuple = {
    lease_id: "lease-1",
    item_key: "openclaw/openclaw#1",
    lease_revision: 3,
    claim_generation: 2,
    run_id: "10",
    run_attempt: 1,
  };
  assert.equal(
    run(
      ["terminal-finalization", "attempt", "--status-marker", "marker", "--status-comment-id", ""],
      {},
    ).body,
    JSON.stringify({ ...tuple, status_marker: "marker" }),
  );
  assert.equal(
    run(
      [
        "terminal-finalization",
        "skip",
        "--attempt-id",
        "ack:1",
        "--reason",
        "missing_status_comment",
        "--status-marker",
        "",
        "--status-comment-id",
        "7",
      ],
      {},
    ).body,
    JSON.stringify({
      ...tuple,
      attempt_id: "ack:1",
      reason: "missing_status_comment",
      status_comment_id: 7,
    }),
  );
});

test("command acknowledgement and terminal-finalization requests reject invalid input", () => {
  const noAddress = ["--status-marker", "", "--status-comment-id", ""];
  for (const [args, env, message] of [
    [["lifecycle", "command-ack-failed"], {}, "missing --attempt-id"],
    [
      ["lifecycle", "command-ack-failed", "--attempt-id", "a", "--status-comment-id", "x"],
      {},
      "invalid --status-comment-id",
    ],
    [
      ["lifecycle", "command-ack-observed", ...noAddress],
      {},
      "--status-marker or --status-comment-id is required",
    ],
    [
      [
        "lifecycle",
        "command-ack-observed",
        "--status-marker",
        "m",
        "--command-comment-id",
        "8",
        "--completion-comment-id",
        "9",
        "--completed-at",
        "later",
        "--completion-outcome",
        "success",
      ],
      {},
      "invalid --completed-at",
    ],
    [
      [
        "lifecycle",
        "command-ack-observed",
        "--status-marker",
        "m",
        "--command-comment-id",
        "8",
        "--completion-comment-id",
        "9",
        "--completed-at",
        "2026-10-09T00:00:00Z",
        "--completion-outcome",
        "done",
      ],
      {},
      "--completion-outcome must be success, failure",
    ],
    [
      ["terminal-finalization", "attempt", ...noAddress],
      {},
      "--status-marker or --status-comment-id is required",
    ],
    [
      ["terminal-finalization", "attempt", "--status-marker", "m"],
      { EXACT_REVIEW_LEASE_ID: "" },
      "missing exact-review lease tuple",
    ],
    [
      [
        "terminal-finalization",
        "attempt",
        "--status-marker",
        "m",
        "--reason",
        "locked_conversation",
      ],
      {},
      "--attempt-id and --reason apply only to skip",
    ],
    [
      ["terminal-finalization", "skip", "--status-marker", "m", "--reason", "locked_conversation"],
      {},
      "missing --attempt-id",
    ],
    [
      [
        "terminal-finalization",
        "skip",
        "--status-marker",
        "m",
        "--attempt-id",
        "a",
        "--reason",
        "closed",
      ],
      {},
      "--reason must be locked_conversation, missing_status_comment",
    ],
    [
      ["terminal-finalization", "retry"],
      {},
      "terminal-finalization record must be attempt or skip",
    ],
  ] as const) {
    const result = run([...args], env);
    assert.equal(result.status, 1, message);
    assert.equal(result.body, "", message);
    assert.equal(result.error, `exact-review-queue-request: ${message}\n`);
  }
});

function enqueue(record: string, payload: unknown, env: Record<string, string> = {}) {
  return run(["enqueue", record], { CLIENT_PAYLOAD: JSON.stringify(payload), ...env });
}

const sourceTuple = {
  installation_id: 1,
  source_head_sha: "a".repeat(40),
  source_base_sha: "b".repeat(40),
  source_is_draft: false,
  source_content_revision: "c".repeat(64),
};

test("legacy events go to branch authority, source authority or plain enqueue", () => {
  const editedPull = {
    item_kind: "pull_request",
    target_repo: "openclaw/clawhub",
    source_event: "pull_request",
    source_action: "edited",
    queue_claim: sourceTuple,
  };
  for (const [payload, route] of [
    [{ item_kind: "issue", source_event: "issues", source_action: "opened" }, "branch-authority"],
    [{ item_kind: "pull_request", source_event: "pull_request_target" }, "branch-authority"],
    [editedPull, "branch-authority"],
    [{ ...editedPull, target_branch: "main" }, "source-authority"],
    // The flat payload fields are the older form of the queue claim.
    [
      { ...editedPull, ...sourceTuple, queue_claim: undefined, target_branch: "main" },
      "source-authority",
    ],
    [{ ...editedPull, source_action: "synchronize", target_branch: "main" }, "enqueue"],
    [{ ...editedPull, source_event: "pull_request_target", target_branch: "main" }, "enqueue"],
    [
      {
        ...editedPull,
        target_branch: "main",
        ingress_route: "target_dispatcher",
        ingress_fingerprint: "d".repeat(64),
      },
      "enqueue",
    ],
    [{ target_branch: "release/v1", source_event: "issue_comment" }, "enqueue"],
  ] as const) {
    const result = enqueue("route", payload);
    assert.equal(result.status, 0, result.error);
    assert.equal(result.body, `/internal/exact-review/${route}`, JSON.stringify(payload));
  }
  // Only a branchless event asks the queue for source authority in its body.
  assert.equal(JSON.parse(enqueue("body", editedPull).body).source_authority_required, true);
  assert.equal(
    Object.hasOwn(
      JSON.parse(enqueue("body", { ...editedPull, target_branch: "main" }).body),
      "source_authority_required",
    ),
    false,
  );
});

test("legacy event bodies keep the queue claim, review options and flat fields in that order", () => {
  assert.equal(
    enqueue("body", {
      target_repo: " openclaw/openclaw ",
      target_branch: "main",
      item_number: 117838,
      item_kind: "pull_request",
      source_event: "pull_request",
      source_action: "edited",
      supersedes_in_progress: true,
      source_delivery_id: "original-review-delivery",
      ...sourceTuple,
      queue_claim: {
        source_head_sha: "E".repeat(40),
        source_updated_at: "2026-10-09T00:00:00Z",
        codex_timeout_ms: 1_200_000,
      },
      review_options: { codex_timeout_ms: 1, media_proof_timeout_ms: 480_000 },
      review_acknowledgement_comment_id: 7001,
      command_status_marker: "<!-- marker -->",
      status_comment_id: 7002,
      additional_prompt: "Retry context",
      ingress_route: "target_dispatcher",
      ingress_fingerprint: "D".repeat(64),
    }).body,
    JSON.stringify({
      delivery_id: "legacy:10:1",
      installation_id: 1,
      decision: {
        targetRepo: "openclaw/openclaw",
        targetBranch: "main",
        itemNumber: 117838,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "edited",
        supersedesInProgress: true,
        sourceDeliveryId: "original-review-delivery",
        sourceHeadSha: "e".repeat(40),
        sourceBaseSha: "b".repeat(40),
        sourceIsDraft: false,
        sourceContentRevision: "c".repeat(64),
        sourceUpdatedAt: "2026-10-09T00:00:00Z",
        codexTimeoutMs: 1_200_000,
        mediaProofTimeoutMs: 480_000,
        commandStatusMarker: "<!-- marker -->",
        statusCommentId: 7002,
        reviewAcknowledgementCommentId: 7001,
        additionalPrompt: "Retry context",
      },
      ingress: { route: "target_dispatcher", fingerprint: "d".repeat(64) },
    }),
  );
  // A router dispatch key names the delivery, so the run is not read.
  assert.equal(
    enqueue(
      "body",
      {
        dispatch_key: " key-1 ",
        item_number: 1455,
        source_action: "failed_review_shard_recovery",
        expected_source_revision: "a".repeat(64),
      },
      { GITHUB_RUN_ID: "" },
    ).body,
    JSON.stringify({
      delivery_id: "router:key-1",
      decision: {
        targetRepo: "openclaw/openclaw",
        itemNumber: 1455,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "failed_review_shard_recovery",
        expectedSourceRevision: "a".repeat(64),
        supersedesInProgress: false,
      },
    }),
  );
});

test("legacy event requests with an invalid target print no route or body", () => {
  for (const [record, payload, env, message] of [
    ["route", { target_repo: "openclaw" }, {}, "invalid legacy target repository: openclaw"],
    [
      "body",
      { target_repo: "openclaw/openclaw\nother/repo" },
      {},
      "invalid legacy target repository: openclaw/openclaw\nother/repo",
    ],
    [
      "route",
      { target_branch: "main; rm" },
      {},
      "invalid legacy target branch for openclaw/openclaw: main; rm",
    ],
    ["body", null, {}, "invalid CLIENT_PAYLOAD"],
    ["body", {}, { GITHUB_RUN_ID: "" }, "invalid GITHUB_RUN_ID"],
    ["claim", {}, {}, "enqueue record must be route or body"],
  ] as const) {
    const result = enqueue(record, payload, env);
    assert.equal(result.status, 1, message);
    assert.equal(result.body, "", message);
    assert.equal(result.error, `exact-review-queue-request: ${message}\n`);
  }
});

test("claim bodies carry the dispatch tuple, or only the lease id for an older dispatch", () => {
  assert.equal(
    leaseStep("claim body", { ITEM_KEY: " openclaw/openclaw#7 ", QUEUE_LEASE_REVISION: " 3 " })
      .body,
    JSON.stringify({
      lease_id: "lease-7",
      item_key: "openclaw/openclaw#7",
      lease_revision: 3,
      run_id: "10",
      run_attempt: 1,
    }),
  );
  assert.equal(
    leaseStep("claim body", { ITEM_KEY: "", QUEUE_LEASE_REVISION: "" }).body,
    JSON.stringify({ lease_id: "lease-7", run_id: "10", run_attempt: 1 }),
  );
});

test("a lease step stops without an error only on the conflicts that another owner causes", () => {
  for (const [step, safe] of [
    [
      "claim",
      [
        "lease_not_active",
        "lease_already_claimed",
        "lease_decision_unavailable",
        "stale_run_attempt",
      ],
    ],
    ["complete", ["lease_superseded"]],
  ] as const) {
    for (const error of [
      "lease_not_active",
      "lease_already_claimed",
      "lease_decision_unavailable",
      "stale_run_attempt",
      "lease_superseded",
      "lease_not_claimed",
      "claim_protocol_mismatch",
    ]) {
      const result = leaseStep(`${step} conflict`, { RESPONSE: JSON.stringify({ error }) });
      if ((safe as readonly string[]).includes(error)) {
        assert.deepEqual(result, { status: 0, body: error, error: "" }, `${step}: ${error}`);
      } else {
        assert.deepEqual(
          result,
          {
            status: 1,
            body: "",
            error: `exact-review-queue-request: unexpected ${step} conflict\n`,
          },
          `${step}: ${error}`,
        );
      }
    }
    for (const response of ["", "{}", "null", "not json", '{"error":["lease_superseded"]}']) {
      const result = leaseStep(`${step} conflict`, { RESPONSE: response });
      assert.equal(result.status, 1, `${step}: ${response}`);
      assert.equal(result.body, "", `${step}: ${response}`);
    }
  }
});

test("completion bodies keep the claim tuple and each review result in the queue order", () => {
  const body = (env: Record<string, string>) => JSON.parse(leaseStep("complete body", env).body);
  const tuple = {
    lease_id: "lease-7",
    item_key: "openclaw/openclaw#7",
    lease_revision: 3,
    claim_generation: 2,
    run_id: "10",
    run_attempt: 1,
  };
  // A protocol 1 claim completes by lease id only.
  assert.equal(
    leaseStep("complete body", { PROTOCOL_VERSION: "1", ITEM_KEY: "", CLAIM_GENERATION: "" }).body,
    JSON.stringify({ lease_id: "lease-7", run_id: "10", run_attempt: 1, outcome: "success" }),
  );
  // A skipped result step reports failure.
  assert.deepEqual(body({ PRIMARY_OUTCOME: "" }), { ...tuple, outcome: "failure" });
  assert.deepEqual(body({ PRIMARY_OUTCOME: "cancelled" }), { ...tuple, outcome: "cancelled" });
  assert.equal(
    leaseStep("complete body", {
      REQUEUE_LATEST: "true",
      SCHEDULED_SEMANTIC_NOOP: "true",
      REVIEW_HOLD: "locked_conversation",
    }).body,
    JSON.stringify({ ...tuple, outcome: "success", requeue_latest: true }),
  );
  assert.equal(
    leaseStep("complete body", {
      SCHEDULED_SEMANTIC_NOOP: "true",
      REVIEW_HOLD: " oversized_pull_request ",
    }).body,
    JSON.stringify({
      ...tuple,
      outcome: "success",
      lifecycle_terminal_disposition: "policy_noop",
      review_hold: "oversized_pull_request",
    }),
  );
  // A command review is never held.
  assert.deepEqual(body({ REVIEW_HOLD: "locked_conversation", HAS_COMMAND_CONTEXT: "true" }), {
    ...tuple,
    outcome: "success",
  });
  assert.equal(
    leaseStep("complete body", {
      DIRECT_PUBLICATION_ACCEPTED: "true",
      DIRECT_LIFECYCLE_OUTCOME: "success",
      DIRECT_PUBLICATION_SUPERSEDED: "true",
      DIRECT_LIFECYCLE_REQUEUE: "true",
      REVIEW_HOLD: "locked_conversation",
    }).body,
    JSON.stringify({
      ...tuple,
      outcome: "success",
      completion_kind: "superseded",
      reason_code: "remote_newer_tuple",
      direct_lifecycle_requeue: true,
    }),
  );
  // The lifecycle step must succeed before the direct publication counts.
  assert.deepEqual(
    body({
      DIRECT_PUBLICATION_ACCEPTED: "true",
      DIRECT_LIFECYCLE_OUTCOME: "failure",
      DIRECT_LIFECYCLE_REQUEUE: "true",
    }),
    { ...tuple, outcome: "success" },
  );
  assert.equal(
    leaseStep("complete body", {
      PRIMARY_OUTCOME: "failure",
      RETRY_KIND: " throttle ",
      RETRY_AT: "2026-10-09T00:00:00Z",
    }).body,
    JSON.stringify({
      ...tuple,
      outcome: "failure",
      retry_kind: "throttle",
      retry_at: "2026-10-09T00:00:00Z",
    }),
  );
  const failure = {
    PRIMARY_OUTCOME: "failure",
    REVIEW_FAILURE_REASON: "codex_failed",
    REVIEW_FAILURE_STAGE: "codex",
    REVIEW_FAILURE_REASON_CODE: "codex_exit",
    REVIEW_FAILURE_RETRYABLE: "false",
    REVIEW_ITEM_KIND: "pull_request",
  };
  const reviewFailure = { stage: "codex", reason_code: "codex_exit", retryable: false };
  assert.equal(
    leaseStep("complete body", {
      ...failure,
      REVIEW_STATUS_VERIFIED: "true",
      REVIEW_STATUS_COMMENT_ID: "9001",
      REVIEW_STATUS_COMPLETED_AT: " 2026-10-09T00:00:00Z ",
    }).body,
    JSON.stringify({
      ...tuple,
      outcome: "failure",
      review_failure_reason: "codex_failed",
      review_failure_status: {
        outcome: "observed",
        comment_id: 9001,
        completed_at: "2026-10-09T00:00:00Z",
      },
      review_failure: reviewFailure,
    }),
  );
  assert.deepEqual(body({ ...failure, REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "9002" }), {
    ...tuple,
    outcome: "failure",
    review_failure_reason: "codex_failed",
    review_failure_status: { outcome: "failed", comment_id: 9002 },
    review_failure: reviewFailure,
  });
  assert.deepEqual(body(failure).review_failure_status, { outcome: "unavailable" });
  // Only an automatic pull request review has a review status comment.
  for (const env of [{ HAS_COMMAND_CONTEXT: "true" }, { REVIEW_ITEM_KIND: "issue" }]) {
    assert.equal(Object.hasOwn(body({ ...failure, ...env }), "review_failure_status"), false);
  }
});

test("completion requests with an invalid tuple or result print no body", () => {
  for (const [env, message] of [
    [{ QUEUE_LEASE_ID: "" }, "missing QUEUE_LEASE_ID"],
    [{ PROTOCOL_VERSION: "3" }, "invalid PROTOCOL_VERSION"],
    [{ ITEM_KEY: "" }, "missing ITEM_KEY"],
    [{ CLAIM_GENERATION: "0" }, "invalid CLAIM_GENERATION"],
    [{ GITHUB_RUN_ATTEMPT: "0" }, "invalid GITHUB_RUN_ATTEMPT"],
    [
      { PRIMARY_OUTCOME: "failure", RETRY_KIND: "later" },
      "RETRY_KIND must be coordination, throttle",
    ],
    [{ PRIMARY_OUTCOME: "failure", RETRY_KIND: "throttle" }, "RETRY_KIND requires RETRY_AT"],
    [
      {
        REQUEUE_LATEST: "true",
        DIRECT_PUBLICATION_ACCEPTED: "true",
        DIRECT_LIFECYCLE_OUTCOME: "success",
        DIRECT_LIFECYCLE_REQUEUE: "true",
      },
      "REQUEUE_LATEST and DIRECT_LIFECYCLE_REQUEUE exclude each other",
    ],
    [{ REVIEW_FAILURE_STAGE: "codex" }, "incomplete review failure"],
  ] as const) {
    const result = leaseStep("complete body", env);
    assert.equal(result.status, 1, message);
    assert.equal(result.body, "", message);
    assert.equal(result.error, `exact-review-queue-request: ${message}\n`);
  }
  for (const [env, message] of [
    [{ ITEM_KEY: "openclaw/openclaw#7", QUEUE_LEASE_REVISION: "" }, "invalid QUEUE_LEASE_REVISION"],
    [{ ITEM_KEY: "", QUEUE_LEASE_REVISION: "3" }, "missing ITEM_KEY"],
    [{ GITHUB_RUN_ID: "run" }, "invalid GITHUB_RUN_ID"],
  ] as const) {
    assert.equal(leaseStep("claim body", env).error, `exact-review-queue-request: ${message}\n`);
  }
});
