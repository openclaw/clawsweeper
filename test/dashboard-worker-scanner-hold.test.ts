import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";
import {
  exactReviewParkedRecoveryAt,
  exactReviewParkedOperatorEligible,
} from "../dashboard/exact-review-read-model.ts";

async function refused(
  options: {
    kind?: string;
    successor?: Record<string, unknown>;
    command?: Record<string, unknown>;
  } = {},
) {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(1455, "1000");
  item.claimedAt = Date.now() - 60_000;
  Object.assign(item.decision, {
    itemKind: options.kind ?? "pull_request",
    sourceEvent: options.kind === "issue" ? "issues" : "pull_request",
    sourceHeadSha: "a".repeat(40),
    sourceAction: "re_review",
    commandStatusMarker: "<!-- clawsweeper-command-status:1455:re_review:old -->",
    additionalPrompt: "old command instructions",
    ...options.command,
  });
  item.leaseDecision = { ...item.decision };
  if (options.successor) {
    item.revision++;
    item.decision = { ...item.decision, ...options.successor };
  }
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const env = {
    EXACT_REVIEW_RETRY_POLICY_EPOCH: "1",
    EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1",
  };
  const queue = new ExactReviewQueue({ storage }, env);
  const response = await queue.fetch(
    new Request("https://queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "1000",
        run_attempt: 1,
        outcome: "failure",
        review_failure_reason: "findings",
      }),
    }),
  );
  assert.equal(response.status, 200);
  return { queue, storage, env, completion: await response.json(), key: item.key };
}
const decision = (changes = {}) => ({
  targetRepo: "openclaw/openclaw",
  targetBranch: "main",
  itemNumber: 1455,
  itemKind: "pull_request",
  sourceEvent: "pull_request",
  sourceAction: "synchronize",
  supersedesInProgress: true,
  sourceHeadSha: "b".repeat(40),
  sourceUpdatedAt: new Date().toISOString(),
  ...changes,
});
const enqueue = async (queue, delivery_id, changes = {}) =>
  (
    await queue.fetch(
      new Request("https://queue/enqueue", {
        method: "POST",
        body: JSON.stringify({ delivery_id, decision: decision(changes) }),
      }),
    )
  ).json();
const stored = async (f) => (await f.storage.get("exact-review-queue")).items[f.key];

for (const kind of ["issue", "pull_request"]) {
  test(`scanner refusal holds ${kind} across producers and newer automatic source`, async () => {
    const f = await refused({
      kind,
      successor: { sourceAction: "synchronize", sourceHeadSha: "b".repeat(40) },
    });
    assert.equal(f.completion.requeued, false);
    const held = await stored(f);
    assert.equal(held.parkedReason, "scanner_refused");
    assert.equal(held.decision.sourceHeadSha, "a".repeat(40));
    assert.equal(held.leaseId, undefined);
    assert.equal(exactReviewParkedRecoveryAt(held), null);
    assert.equal(exactReviewParkedOperatorEligible(held), false);
    for (const action of [
      "scheduled_hot_intake",
      "scheduled_normal_backfill",
      "failed_review_shard_recovery",
      "source_drift_requeue",
      "reopened",
      "edited",
      "synchronize",
      "branch_repaired",
    ]) {
      const result = await enqueue(f.queue, `auto:${kind}:${action}`, {
        sourceAction: action,
        itemKind: kind,
        sourceUpdatedAt: new Date().toISOString(),
      });
      assert.notEqual(result.queued, true, action);
      assert.deepEqual(await stored(f), held, action);
    }
    // Restart and changed repository casing do not create a second slot.
    const restarted = new ExactReviewQueue({ storage: f.storage }, f.env);
    assert.equal(
      (await enqueue(restarted, `restart:${kind}`, { targetRepo: "OpenClaw/OpenClaw" })).reason,
      "scanner_refused",
    );
    const expected = { item_key: f.key, revision: held.revision, updated_at_ms: held.updatedAt };
    for (const [route, body] of [
      ["resolve", { items: [expected], note: "closed" }],
      [
        "recover-fresh",
        {
          items: [{ ...expected, source_head_sha: "c".repeat(40) }],
          idempotency_key: "new-source",
          override_retry_budget: true,
        },
      ],
    ]) {
      const res = await restarted.fetch(
        new Request(`https://queue/parked-reviews/${route}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).skipped, 1);
      assert.deepEqual(await stored(f), held);
    }
  });
}

test("scanner hold requires a fresh verified command and replaces old authority", async () => {
  const f = await refused();
  const held = await stored(f);
  const command = {
    sourceAction: "re_review",
    sourceCommentId: 2000,
    sourceCommentUpdatedAt: new Date(held.scannerRefusal.observedAt + 1000).toISOString(),
    commandOrigin: "hosted_webhook",
    commandBodyDigest: "c".repeat(64),
    commandStatusMarker: "<!-- clawsweeper-command-status:1455:re_review:new -->",
    sourceCommentVerified: true,
  };
  for (const [id, changes] of [
    [
      "marker-only",
      { sourceAction: "re_review", commandStatusMarker: command.commandStatusMarker },
    ],
    ["unverified", { ...command, sourceCommentVerified: false }],
    [
      "old",
      {
        ...command,
        sourceCommentUpdatedAt: new Date(held.scannerRefusal.observedAt - 1000).toISOString(),
      },
    ],
  ])
    assert.equal((await enqueue(f.queue, id, changes)).reason, "scanner_refused");
  assert.equal((await enqueue(f.queue, "fresh", command)).queued, true);
  const next = await stored(f);
  assert.equal(next.state, "pending");
  assert.ok(next.revision > held.revision);
  assert.equal(next.scannerRefusal, undefined);
  assert.equal(next.decision.commandStatusMarker, command.commandStatusMarker);
  assert.equal(next.decision.additionalPrompt, undefined);
});

test("scanner hold rejects workflow reruns and releases for a new explicit item request", async () => {
  const f = await refused();
  const manual = {
    sourceAction: "manual_explicit_review",
    publicationPolicy: "record_comment_only",
  };
  assert.equal((await enqueue(f.queue, "manual:1000:1455", manual)).reason, "scanner_refused");
  assert.equal((await enqueue(f.queue, "manual:999:1455", manual)).reason, "scanner_refused");
  assert.equal((await enqueue(f.queue, "manual:1001:1455", manual)).queued, true);
  assert.equal((await stored(f)).decision.commandStatusMarker, undefined);
});

for (const requestId of [
  "incident-1455",
  "a.b_c:retry-2",
  "d5f1a5a0-a741-4ee8-b2d1-9ff783ec8290",
]) {
  test(`scanner hold admits a distinct opaque manual request: ${requestId}`, async () => {
    const priorId = `manual:${requestId}:1455`;
    const f = await refused({
      command: { sourceAction: "manual_explicit_review", sourceDeliveryId: priorId },
    });
    const manual = {
      sourceAction: "manual_explicit_review",
      publicationPolicy: "record_comment_only",
    };
    assert.equal((await enqueue(f.queue, priorId, manual)).reason, "scanner_refused");
    assert.equal(
      (await enqueue(f.queue, `manual:${requestId}-new:999`, manual)).reason,
      "scanner_refused",
    );
    const nextId = `manual:${requestId}-new:1455`;
    assert.equal((await enqueue(f.queue, nextId, manual)).queued, true);
    assert.equal((await stored(f)).decision.sourceDeliveryId, nextId);
  });
}

test("failed numeric API request IDs cannot replay above the worker run ID", async () => {
  const f = await refused({
    command: {
      sourceAction: "manual_explicit_review",
      sourceDeliveryId: "manual:5000:1455",
    },
  });
  const manual = {
    sourceAction: "manual_explicit_review",
    publicationPolicy: "record_comment_only",
  };
  assert.equal((await enqueue(f.queue, "manual:5000:1455", manual)).reason, "scanner_refused");
  assert.equal((await enqueue(f.queue, "manual:5001:1455", manual)).queued, true);
});

test("intentional policy epoch releases on automatic admission without failed command context", async () => {
  const f = await refused();
  f.queue = new ExactReviewQueue(
    { storage: f.storage },
    { ...f.env, EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" },
  );
  assert.equal(
    (
      await enqueue(f.queue, "epoch-command", {
        sourceAction: "re_review",
        commandStatusMarker: "<!-- clawsweeper-command-status:1455:re_review:old -->",
      })
    ).reason,
    "scanner_refused",
  );
  const admitted = await enqueue(f.queue, "epoch-schedule", {
    sourceAction: "scheduled_normal_backfill",
  });
  assert.equal(admitted.queued, true, JSON.stringify(admitted));
  const next = await stored(f);
  assert.equal(next.reviewRetryPolicyEpoch, "2");
  assert.equal(next.revision, 2);
  assert.equal(next.decision.commandStatusMarker, undefined);
  assert.equal(next.decision.additionalPrompt, undefined);
});

test("a command queued before scanner refusal cannot use the lease start as its cutoff", async () => {
  const f = await refused({
    successor: {
      sourceCommentId: 3000,
      sourceCommentUpdatedAt: new Date(Date.now() - 1000).toISOString(),
      sourceCommentVerified: true,
      commandOrigin: "hosted_webhook",
      commandBodyDigest: "d".repeat(64),
      commandStatusMarker: "<!-- clawsweeper-command-status:1455:re_review:fresh -->",
      additionalPrompt: "new request",
    },
  });
  assert.equal(f.completion.requeued, false);
  assert.equal((await stored(f)).state, "parked");
  assert.equal((await stored(f)).parkedReason, "scanner_refused");
});

test("scanner holds require later command timestamps for automatic and command origins", async () => {
  const originalNow = Date.now;
  const now = 1_790_000_000_678;
  Date.now = () => now;
  try {
    const command = {
      sourceAction: "re_review",
      sourceCommentId: 4000,
      sourceCommentUpdatedAt: new Date(Math.floor(now / 1000) * 1000).toISOString(),
      commandOrigin: "hosted_webhook",
      commandBodyDigest: "e".repeat(64),
      commandStatusMarker: "<!-- clawsweeper-command-status:1455:re_review:same-second -->",
      sourceCommentVerified: true,
    };
    for (const origin of ["automatic", "command"]) {
      const f = await refused({
        command: origin === "command" ? command : { sourceAction: "synchronize" },
      });
      const tiedRequests = [
        command,
        {
          ...command,
          sourceCommentUpdatedAt: command.sourceCommentUpdatedAt.replace(".000Z", "Z"),
        },
        { ...command, sourceCommentId: 3999 },
        { ...command, sourceCommentId: 4001 },
        { ...command, commandBodyDigest: "f".repeat(64) },
      ];
      for (const [index, tied] of tiedRequests.entries()) {
        assert.equal(
          (await enqueue(f.queue, `${origin}:tied:${index}`, tied)).reason,
          "scanner_refused",
        );
        assert.equal((await stored(f)).state, "parked");
      }
      assert.equal(
        (
          await enqueue(f.queue, `${origin}:later`, {
            ...command,
            sourceCommentId: 3999,
            sourceCommentUpdatedAt: new Date(now + 1000).toISOString(),
          })
        ).queued,
        true,
      );
      assert.equal((await stored(f)).revision, 2);
    }
  } finally {
    Date.now = originalNow;
  }
});

test("issue retry pins validate at intake and do not constrain a fresh request", async () => {
  const { exactReviewDecisionFrom, mergePendingExactReviewDecision } =
    await import("../dashboard/exact-review-decision.ts");
  const automatic = decision({
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "failed_review_shard_recovery",
    expectedSourceRevision: "a".repeat(64),
  });
  const parsed = exactReviewDecisionFrom(automatic);
  assert.ok(parsed);
  assert.equal(parsed.expectedSourceRevision, "a".repeat(64));
  assert.equal(exactReviewDecisionFrom({ ...automatic, expectedSourceRevision: "bad" }), null);
  assert.equal(exactReviewDecisionFrom({ ...automatic, itemKind: "pull_request" }), null);
  const fresh = exactReviewDecisionFrom(
    decision({ itemKind: "issue", sourceEvent: "issues", sourceAction: "edited" }),
  );
  assert.ok(fresh);
  assert.equal(mergePendingExactReviewDecision(parsed, fresh).expectedSourceRevision, undefined);
});
