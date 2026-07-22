import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createContext, Script } from "node:vm";

import worker, {
  automaticIssueWork,
  ExactReviewQueue,
  exactReviewEffectiveLeaseExpiresAt,
  exactReviewPublicationCapacity,
  exactReviewQueueAdmittedItems,
  exactReviewQueueCapacity,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStatusSnapshot,
  mergeBayJourneyState,
  mergeBayTerminalState,
  StatusStore,
  summarizeAutomergeReliability,
  summarizeBayJourneyTimings,
  workerWorkKind,
} from "../dashboard/worker.ts";
import {
  TRIAGE_ROUTING_GROUPS,
  triageRoutingGroupsForLabels,
} from "../dashboard/triage-routing-groups.ts";

test("exact-review queue defaults to 64 of the 128 global workers", () => {
  assert.equal(exactReviewQueueCapacity({}), 64);
  assert.equal(exactReviewQueueCapacity({ EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "32" }), 32);
  assert.equal(exactReviewQueueCapacity({ EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "100" }), 100);
  assert.equal(
    exactReviewQueueCapacity({
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "100",
      WORKER_BUDGET: "64",
    }),
    64,
  );
});

test("automerge reliability summarizes failures, recovery, duration, and stalled runs", () => {
  const run = (
    id: number,
    number: number,
    status: string,
    conclusion: string | null,
    createdAt: string,
    updatedAt: string,
  ) => ({
    id,
    display_title: `automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-${number}.md`,
    status,
    conclusion,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: createdAt,
    updated_at: updatedAt,
  });
  const summary = summarizeAutomergeReliability(
    [
      run(1, 107691, "completed", "failure", "2026-07-16T09:00:00Z", "2026-07-16T09:20:00Z"),
      run(2, 107691, "completed", "success", "2026-07-16T09:30:00Z", "2026-07-16T09:40:00Z"),
      run(3, 107692, "completed", "failure", "2026-07-16T10:00:00Z", "2026-07-16T10:20:00Z"),
      run(6, 107692, "completed", "failure", "2026-07-16T08:00:00Z", "2026-07-16T08:05:00Z"),
      run(4, 107693, "in_progress", null, "2026-07-16T09:30:00Z", "2026-07-16T09:30:00Z"),
      {
        ...run(5, 107694, "completed", "failure", "2026-07-16T11:00:00Z", "2026-07-16T11:05:00Z"),
        display_title: "repair cluster jobs/openclaw/inbox/gitcrawl-55.md",
      },
    ],
    ["openclaw/openclaw"],
    "2026-07-16T12:00:00Z",
  );

  assert.equal(summary.sampled_runs, 5);
  assert.equal(summary.completed_attempts, 4);
  assert.equal(summary.failed_attempts, 3);
  assert.equal(summary.failure_rate_percent, 75);
  assert.equal(summary.average_duration_ms, 825_000);
  assert.equal(summary.longest_duration_ms, 1_200_000);
  assert.equal(summary.active_attempts, 1);
  assert.equal(summary.stalled_attempts, 1);
  assert.equal(summary.recovered_failures, 1);
  assert.equal(summary.unresolved_failures, 1);
  assert.deepEqual(
    summary.failures.map((failure) => [failure.number, failure.status]),
    [
      [107692, "unresolved"],
      [107691, "recovered"],
    ],
  );
});

test("exact-review publication scales bounded capacity with ready backlog", () => {
  assert.equal(exactReviewPublicationCapacity({}), 24);
  assert.equal(exactReviewPublicationCapacity({}, 99), 24);
  assert.equal(exactReviewPublicationCapacity({}, 100), 32);
  assert.equal(exactReviewPublicationCapacity({}, 249), 32);
  assert.equal(exactReviewPublicationCapacity({}, 250), 40);
  assert.equal(exactReviewPublicationCapacity({}, 400), 48);
  assert.equal(exactReviewPublicationCapacity({}, 2_000), 48);
  assert.equal(exactReviewPublicationCapacity({}, 0, 40), 40);
  assert.equal(exactReviewPublicationCapacity({}, 400, 0, 32), 32);
  assert.equal(exactReviewPublicationCapacity({}, 400, 0, 8), 8);
  assert.equal(exactReviewPublicationCapacity({}, 400, 40, 24), 40);
  assert.equal(exactReviewPublicationCapacity({}, 0, 0, 48, 60 * 60_000), 32);
  assert.equal(exactReviewPublicationCapacity({}, 50, 0, 48, 0, 0), 32);
  assert.equal(
    exactReviewPublicationCapacity({ EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "12" }),
    12,
  );
  assert.equal(
    exactReviewPublicationCapacity(
      {
        EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT: "16",
        EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "32",
      },
      250,
    ),
    32,
  );
  assert.equal(
    exactReviewPublicationCapacity({
      EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT: "24",
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "16",
    }),
    16,
  );
});

test("exact-review publication admission applies the hysteresis controller demand target", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    for (let index = 0; index < 50; index += 1) {
      const number = 10_000 + index;
      const response = await queue.fetch(
        buildExactReviewQueueRequest(
          `publication-demand-${number}`,
          number,
          "exact_review_artifact_publish",
          "issue",
          undefined,
          exactReviewPublicationOverrides(number, String(number * 10)),
        ),
      );
      assert.equal(response.status, 202);
    }
    await storage.put("exact-review-publication-control:v1", {
      capacityCeiling: 48,
      demandCapacity: 32,
      cooldownUntil: 0,
      recoverySuccesses: 0,
      demandSamples: 0,
      demandTier: 1,
      lastDemandSampleAt: now,
      lastScaleAt: now,
    });

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.pending, 50);
    assert.equal(stats.lanes.publication.capacity_control.demand_capacity, 32);
    assert.equal(stats.lanes.publication.capacity, 32);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue debounces fresh work and caps pending revision extensions", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue(
      { storage },
      {
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "1000",
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS: "1500",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("debounce-1", 750, "edited"));
    let state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { createdAt: number; nextAttemptAt: number; revision: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#750"].nextAttemptAt, 1_001_000);

    now += 500;
    await queue.fetch(buildExactReviewQueueRequest("debounce-2", 750, "synchronize"));
    state = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(state.items["openclaw/gogcli#750"].nextAttemptAt, 1_001_500);
    assert.equal(state.items["openclaw/gogcli#750"].revision, 2);

    now += 900;
    await queue.fetch(buildExactReviewQueueRequest("debounce-3", 750, "edited"));
    state = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(state.items["openclaw/gogcli#750"].nextAttemptAt, 1_001_500);
    assert.equal(state.items["openclaw/gogcli#750"].revision, 3);
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 1);
    assert.equal(stats.lanes.publication.enqueued_total, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue bypasses debounce for commands and publications", async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  try {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:751:re_review:0123456789abcdef0123456789abcdef01234567 -->";
    await queue.fetch(
      buildExactReviewQueueRequest(
        "command-immediate",
        751,
        "legacy_dispatch",
        "issue",
        undefined,
        {
          commandStatusMarker,
        },
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publication-immediate",
        752,
        "exact_review_artifact_publish",
        "issue",
        undefined,
        exactReviewPublicationOverrides(752, "7520"),
      ),
    );
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#751"].nextAttemptAt, 2_000_000);
    assert.equal(state.items["openclaw/gogcli#752@publish:7520:1"].nextAttemptAt, 2_000_000);

    // A later plain webhook event merging into the pending command must not
    // re-debounce it: immediacy comes from the merged decision's command marker.
    await queue.fetch(buildExactReviewQueueRequest("command-followup", 751, "edited"));
    const merged = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number; revision: number }>;
    };
    assert.equal(merged.items["openclaw/gogcli#751"].revision, 2);
    assert.equal(merged.items["openclaw/gogcli#751"].nextAttemptAt, 2_000_000);
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 1);
    assert.equal(stats.lanes.review.flow.last_15_minutes.arrival_rate_per_hour, 4);
    assert.equal(stats.lanes.publication.enqueued_total, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue sheds only new recovery work above the pending soft limit", async () => {
  const storage = new MemoryDurableStorage();
  const env = {
    EXACT_REVIEW_PENDING_SOFT_LIMIT: "1",
    EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
  };
  const queue = new ExactReviewQueue({ storage }, env);
  await queue.fetch(buildExactReviewQueueRequest("ordinary-existing", 760, "edited"));

  const existing = await queue.fetch(
    buildExactReviewQueueRequest("existing-recovery", 760, "source_drift_requeue"),
  );
  assert.equal(existing.status, 202);
  assert.equal((await existing.json()).queued, true);

  for (const [index, sourceAction] of [
    "failed_review_shard_recovery",
    "artifact_retention_recovery",
    "source_drift_requeue",
  ].entries()) {
    const shed = await queue.fetch(
      buildExactReviewQueueRequest(`shed-${index}`, 761 + index, sourceAction),
    );
    assert.equal(shed.status, 202);
    assert.deepEqual(await shed.json(), { ok: true, shed: true, reason: "backpressure" });
  }

  const placeholderRecovery = await queue.fetch(
    buildExactReviewQueueRequest(
      "placeholder-recovery-over-limit",
      769,
      "review_placeholder_recovery",
    ),
  );
  assert.equal(placeholderRecovery.status, 202);
  const placeholderRecoveryBody = await placeholderRecovery.json();
  assert.equal(placeholderRecoveryBody.queued, true);
  assert.notEqual(placeholderRecoveryBody.shed, true);

  const webhook = await queue.fetch(
    buildExactReviewQueueRequest("webhook-over-limit", 770, "opened"),
  );
  assert.equal((await webhook.json()).queued, true);
  const publication = await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-over-limit",
      771,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(771, "7710"),
    ),
  );
  assert.equal((await publication.json()).queued, true);

  const restarted = new ExactReviewQueue({ storage }, env);
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 4);
  assert.equal(stats.shed_since_reset, 3);
  assert.equal(stats.handoff_health.pending_depth, 4);
  assert.equal(stats.handoff_health.shed_since_reset, 3);
  assert.equal(stats.lanes.review.pending_depth, 3);
  assert.equal(stats.lanes.review.shed_since_reset, 3);
  assert.equal(stats.lanes.review.enqueued_total, 3);
  assert.deepEqual(stats.lanes.review.flow.last_15_minutes, {
    window_minutes: 15,
    arrival: 6,
    successful: 0,
    retried: 0,
    shed: 3,
    arrival_rate_per_hour: 24,
    successful_rate_per_hour: 0,
    retried_rate_per_hour: 0,
    shed_rate_per_hour: 12,
    retry_amplification: null,
  });
  assert.equal(stats.lanes.publication.enqueued_total, 1);
});

test("exact-review queue does not count work for a disabled target", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    buildExactReviewQueueRequest("disabled-clawhub", 780, "opened", "issue", "openclaw/clawhub"),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "target not enabled",
  });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 0);
  assert.equal(stats.lanes.publication.enqueued_total, 0);
});

test("heartbeated exact-review leases use the heartbeat grace while legacy leases keep execution expiry", () => {
  const now = 1_000_000;
  const item = {
    ...leasedExactReviewQueueItem(700, "7000"),
    leaseHeartbeatAt: undefined as number | undefined,
  };
  item.leaseExpiresAt = now + 130 * 60_000;
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000), item.leaseExpiresAt);

  item.leaseHeartbeatAt = now;
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000), now + 20 * 60_000);
  assert.equal(exactReviewEffectiveLeaseExpiresAt(item, 15 * 60_000, 5 * 60_000), now + 5 * 60_000);
});

test("exact-review heartbeat refreshes only the matching live lease tuple", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": leasedExactReviewQueueItem(700, "7000"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  // Heartbeat is tuple-authenticated like /claim and /complete: no webhook signature.
  const env = {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const body = JSON.stringify({
    item_key: "openclaw/openclaw#700",
    lease_id: "lease-700",
    lease_revision: 1,
    run_id: "7000",
  });
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/heartbeat", {
      method: "POST",
      body,
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const heartbeatAt = Number(
    (
      (await storage.get("exact-review-queue")) as {
        items: Record<string, { leaseHeartbeatAt?: number }>;
      }
    ).items["openclaw/openclaw#700"].leaseHeartbeatAt,
  );
  assert.ok(heartbeatAt > 0);

  const mismatchBody = JSON.stringify({
    item_key: "openclaw/openclaw#700",
    lease_id: "lease-700",
    lease_revision: 2,
    run_id: "7000",
  });
  const mismatch = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/heartbeat", {
      method: "POST",
      body: mismatchBody,
    }),
    env,
  );
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), { error: "lease_not_active" });
});

test("exact-review queue requeues a heartbeat-stale lease before execution expiry", async () => {
  const storage = new MemoryDurableStorage();
  const item = {
    ...leasedExactReviewQueueItem(701, "7010"),
    leaseHeartbeatAt: undefined as number | undefined,
  };
  item.leaseExpiresAt = Date.now() + 100 * 60_000;
  item.leaseHeartbeatAt = Date.now() - 21 * 60_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#701": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pending, 1);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; leaseId?: string; leaseHeartbeatAt?: number }>;
  };
  assert.equal(state.items["openclaw/openclaw#701"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#701"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#701"].leaseHeartbeatAt, undefined);
});

test("signed claimed-run snapshot feeds tuple-safe terminal reconciliation", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#702": leasedExactReviewQueueItem(702, "7020"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const claimedBody = JSON.stringify({ runs: [], include_all_claimed: true });
  const claimedSignature = `sha256=${createHmac("sha256", "test-token-placeholder").update(claimedBody).digest("hex")}`;
  const claimed = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/claimed-runs", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": claimedSignature },
      body: claimedBody,
    }),
    env,
  );
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), {
    runs: [{ run_id: "7020", run_attempt: 1, claim_generation: 1 }],
  });

  const terminalBody = JSON.stringify({
    terminal_runs: [
      {
        run_id: "7020",
        run_attempt: 1,
        claimed_run_attempt: 1,
        claim_generation: 1,
        outcome: "success",
      },
    ],
  });
  const terminalSignature = `sha256=${createHmac("sha256", "test-token-placeholder").update(terminalBody).digest("hex")}`;
  const reconciled = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": terminalSignature },
      body: terminalBody,
    }),
    env,
  );
  assert.equal(reconciled.status, 200);
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 1,
    requeued: 0,
    completed: 1,
  });
});

test("fresh dead-letter recovery is available only through the signed internal route", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const body = JSON.stringify({ ids: ["missing-dead-letter"], idempotency_key: "operator:test" });
  const unsigned = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/dead-letters/recover-fresh",
      {
        method: "POST",
        body,
      },
    ),
    env,
  );
  assert.equal(unsigned.status, 401);

  const signature = `sha256=${createHmac("sha256", "test-token-placeholder").update(body).digest("hex")}`;
  const signed = await worker.fetch(
    new Request(
      "https://clawsweeper.openclaw.ai/internal/exact-review/dead-letters/recover-fresh",
      {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      },
    ),
    env,
  );
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
});

test("exact-review queue counts only work that successfully leaves each lane", async () => {
  const storage = new MemoryDurableStorage();
  const directPublication = leasedExactReviewQueueItem(703, "7030");
  directPublication.decision.sourceAction = "exact_review_artifact_publish";
  directPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const reconciledPublication = leasedExactReviewQueueItem(704, "7040");
  reconciledPublication.decision.sourceAction = "exact_review_artifact_publish";
  reconciledPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const failedPublication = leasedExactReviewQueueItem(705, "7050");
  failedPublication.decision.sourceAction = "exact_review_artifact_publish";
  failedPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const driftPublication = leasedExactReviewQueueItem(707, "7070");
  driftPublication.decision.sourceAction = "exact_review_artifact_publish";
  driftPublication.leaseDecision.sourceAction = "exact_review_artifact_publish";
  const review = leasedExactReviewQueueItem(706, "7060");
  const reconciledReviewFailure = leasedExactReviewQueueItem(708, "7080");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: Object.fromEntries(
      [
        directPublication,
        reconciledPublication,
        failedPublication,
        driftPublication,
        review,
        reconciledReviewFailure,
      ].map((item) => [item.key, item]),
    ),
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = (
    item: ReturnType<typeof leasedExactReviewQueueItem>,
    outcome: string,
    requeueLatest = false,
  ) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: item.leaseRevision,
          claim_generation: item.claimGeneration,
          run_id: item.claimedRunId,
          run_attempt: item.claimedRunAttempt,
          outcome,
          ...(requeueLatest ? { requeue_latest: true } : {}),
        }),
      }),
    );

  assert.equal((await complete(directPublication, "success")).status, 200);
  assert.equal((await complete(review, "success")).status, 200);
  assert.equal((await complete(failedPublication, "failure")).status, 200);
  assert.equal((await complete(driftPublication, "success", true)).status, 200);
  assert.equal((await complete(directPublication, "success")).status, 409);

  const reconcileBody = {
    runs: [
      {
        run_id: reconciledPublication.claimedRunId,
        run_attempt: reconciledPublication.claimedRunAttempt,
        claimed_run_attempt: reconciledPublication.claimedRunAttempt,
        claim_generation: reconciledPublication.claimGeneration,
        outcome: "success",
      },
      {
        run_id: reconciledReviewFailure.claimedRunId,
        run_attempt: reconciledReviewFailure.claimedRunAttempt,
        claimed_run_attempt: reconciledReviewFailure.claimedRunAttempt,
        claim_generation: reconciledReviewFailure.claimGeneration,
        outcome: "failure",
      },
    ],
  };
  const reconciled = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify(reconcileBody),
    }),
  );
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 2,
    requeued: 1,
    completed: 1,
  });
  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/reconcile", {
          method: "POST",
          body: JSON.stringify(reconcileBody),
        }),
      )
    ).status,
    200,
  );

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.completed_total, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.successful_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retry_amplification, 1);
  assert.equal(stats.lanes.publication.completed_total, 2);
  assert.equal(stats.lanes.publication.pending, 2);
});

test("exact-review completion and lane metrics roll back together", async () => {
  const storage = new MemoryDurableStorage();
  const review = leasedExactReviewQueueItem(708, "7080");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [review.key]: review },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const complete = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: review.leaseId,
          item_key: review.key,
          lease_revision: review.leaseRevision,
          claim_generation: review.claimGeneration,
          run_id: review.claimedRunId,
          run_attempt: review.claimedRunAttempt,
          outcome: "success",
        }),
      }),
    );

  storage.failNextSql(/SET review_enqueued_total = review_enqueued_total \+ \?/);
  await assert.rejects(complete(), /injected SQL failure/);
  let state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.ok(state.items[review.key]);
  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.completed_total, 0);

  assert.equal((await complete()).status, 200);
  state = (await storage.get("exact-review-queue")) as typeof state;
  assert.equal(state.items[review.key], undefined);
  stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.completed_total, 1);
});

test("exact-review queue admits and wakes up to 24 publishers", () => {
  const now = 1_000_000;
  const publication = (number: number) => ({
    key: `openclaw/openclaw#${number}@publish:${number}:1`,
    state: "pending",
    nextAttemptAt: now,
    leaseExpiresAt: undefined,
    decision: { sourceAction: "exact_review_artifact_publish" },
  });
  const state = {
    items: Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => {
        const item = publication(index + 1);
        return [item.key, item];
      }),
    ),
  } as never;
  assert.equal(exactReviewQueueAdmittedItems(state, now, 64, 60, 24).length, 24);

  const active = publication(1);
  active.state = "leased";
  active.leaseExpiresAt = now + 60_000;
  const pending = publication(2);
  const wakeState = { items: { [active.key]: active, [pending.key]: pending } } as never;
  assert.equal(exactReviewQueueNextWakeAt(wakeState, now, 64, 60, 24), now + 1_000);
  assert.equal(exactReviewQueueNextWakeAt(wakeState, now, 64, 60, 1), now + 60_000);

  const activeReview = {
    key: "openclaw/openclaw#3",
    state: "leased",
    nextAttemptAt: now,
    leaseExpiresAt: now + 45_000,
    decision: { sourceAction: "opened", targetRepo: "openclaw/openclaw" },
  };
  const budgetBlockedState = {
    items: { [activeReview.key]: activeReview, [pending.key]: pending },
  } as never;
  assert.equal(exactReviewQueueNextWakeAt(budgetBlockedState, now, 64, 60, 0), now + 45_000);
  assert.equal(
    exactReviewQueueNextWakeAt({ items: { [pending.key]: pending } } as never, now, 64, 60, 0),
    now + 30_000,
  );
});

test("dashboard status reads the exact-review handoff model from the durable queue", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  await queue.fetch(buildExactReviewQueueRequest("handoff-status", 597, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("backoff-status", 598, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("leased-review-status", 600, "opened"));
  await queue.fetch(buildExactReviewQueueRequest("recovery-status", 601, "source_drift_requeue"));
  await queue.fetch(
    buildExactReviewQueueRequest(
      "publication-status",
      599,
      "exact_review_artifact_publish",
      "issue",
      undefined,
      exactReviewPublicationOverrides(599, "5990"),
    ),
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: "pending" | "dispatching" | "leased";
        nextAttemptAt: number;
        leaseId?: string;
        leaseExpiresAt?: number;
        decision: { sourceAction: string };
      }
    >;
  };
  state.items["openclaw/gogcli#598"].nextAttemptAt = Date.now() + 60_000;
  for (const key of ["openclaw/gogcli#600", "openclaw/gogcli#599@publish:5990:1"]) {
    state.items[key].state = "leased";
    state.items[key].leaseId = `lease-${key}`;
    state.items[key].leaseExpiresAt = Date.now() + 60_000;
  }
  await storage.put("exact-review-queue", state);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.match(status.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.pending, 3);
  assert.equal(status.ready_pending, 2);
  assert.equal(status.admissible_pending, 2);
  assert.equal(status.dispatching, 0);
  assert.equal(status.leased, 2);
  assert.equal(status.handoff_health.status, "healthy");
  assert.equal(status.handoff_health.phases.pending.count, 3);
  assert.equal(status.lanes.review.enqueued_total, 4);
  assert.equal(status.lanes.review.completed_total, 0);
  assert.equal(status.lanes.publication.enqueued_total, 1);
  assert.equal(status.lanes.publication.completed_total, 0);
  assert.equal(status.review_execution_health, undefined);
  assert.deepEqual(
    {
      pending: status.lanes.review.pending,
      ready: status.lanes.review.ready,
      backoff: status.lanes.review.backoff,
      active: status.lanes.review.active,
      available_slots: status.lanes.review.available_slots,
      capacity: status.lanes.review.capacity,
    },
    { pending: 3, ready: 2, backoff: 1, active: 1, available_slots: 63, capacity: 64 },
  );
  assert.deepEqual(
    {
      pending: status.lanes.publication.pending,
      ready: status.lanes.publication.ready,
      backoff: status.lanes.publication.backoff,
      active: status.lanes.publication.active,
      available_slots: status.lanes.publication.available_slots,
      capacity: status.lanes.publication.capacity,
    },
    { pending: 0, ready: 0, backoff: 0, active: 1, available_slots: 23, capacity: 24 },
  );
  assert.equal(typeof status.lanes.review.oldest_pending_at, "string");
  assert.equal(status.lanes.review.oldest_pending_key, "openclaw/gogcli#597");
  assert.equal(typeof status.lanes.review.next_attempt_at, "string");
  assert.equal(status.pressure.status, "idle");
  assert.equal(status.pressure.reason, "capacity_available");
  assert.equal(status.pressure.active, status.lanes.review.active);
  assert.equal(status.pressure.pending, status.lanes.review.pending);
  assert.equal(status.pressure.capacity, status.lanes.review.capacity);
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 2,
    "setting-up": 1,
    reviewing: 0,
    applying: 1,
    repairing: 1,
  });
  assert.deepEqual(
    status.bay_projection.items.map((item) => ({
      item_key: item.item_key,
      stage: item.stage,
      queue_state: item.queue_state,
    })),
    [
      { item_key: "openclaw/gogcli#597", stage: "arriving", queue_state: "pending" },
      { item_key: "openclaw/gogcli#600", stage: "setting-up", queue_state: "leased" },
      { item_key: "openclaw/gogcli#599", stage: "applying", queue_state: "leased" },
      { item_key: "openclaw/gogcli#601", stage: "repairing", queue_state: "pending" },
      { item_key: "openclaw/gogcli#598", stage: "arriving", queue_state: "pending" },
    ],
  );
  assert.deepEqual(Object.keys(status.bay_projection.items[0]).sort(), [
    "created_at",
    "item_key",
    "item_number",
    "next_attempt_at",
    "queue_state",
    "repository",
    "stage",
    "updated_at",
  ]);
  assert.equal(await exactReviewQueueStatusSnapshot({}), null);
});

test("Bay queue projection applies its public sample cap across all stages", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  for (let index = 0; index < 9; index += 1) {
    await queue.fetch(
      buildExactReviewQueueRequest(`bay-arriving-${index}`, 10_000 + index, "opened"),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(`bay-setting-${index}`, 20_000 + index, "opened"),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        `bay-repairing-${index}`,
        30_000 + index,
        "source_drift_requeue",
      ),
    );
  }
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: "pending" | "dispatching" | "leased"; leaseId?: string; leaseExpiresAt?: number }
    >;
  };
  for (let index = 0; index < 9; index += 1) {
    const item = state.items[`openclaw/gogcli#${20_000 + index}`];
    item.state = "leased";
    item.leaseId = `bay-setting-lease-${index}`;
    item.leaseExpiresAt = Date.now() + 60_000;
  }
  await storage.put("exact-review-queue", state);

  const status = await exactReviewQueueStatusSnapshot({
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  });

  assert.ok(status);
  assert.equal(status.bay_projection.sample_limit, 24);
  assert.deepEqual(status.bay_projection.stages, {
    arriving: 9,
    "setting-up": 9,
    reviewing: 0,
    applying: 0,
    repairing: 9,
  });
  assert.equal(status.bay_projection.total, 27);
  assert.equal(status.bay_projection.items.length, 24);
  assert.deepEqual(
    Object.fromEntries(
      ["arriving", "setting-up", "repairing"].map((stage) => [
        stage,
        status.bay_projection.items.filter((item) => item.stage === stage).length,
      ]),
    ),
    { arriving: 8, "setting-up": 8, repairing: 8 },
  );

  const prioritized = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayPriorityKeys: ["openclaw/gogcli#30008"] },
  );
  assert.ok(prioritized);
  assert.equal(prioritized.bay_projection.items.length, 24);
  assert.equal(prioritized.bay_projection.items[0].item_key, "openclaw/gogcli#30008");
  assert.equal(
    prioritized.bay_projection.items.filter((item) => item.item_key === "openclaw/gogcli#30008")
      .length,
    1,
  );

  const firstRowsInEachLane = [
    ...Array.from({ length: 7 }, (_, index) => `openclaw/gogcli#${10_000 + index}`),
    ...Array.from({ length: 7 }, (_, index) => `openclaw/gogcli#${20_000 + index}`),
    ...Array.from({ length: 7 }, (_, index) => `openclaw/gogcli#${30_000 + index}`),
  ];
  const prioritizedLaneRows = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    { bayPriorityKeys: firstRowsInEachLane },
  );
  assert.ok(prioritizedLaneRows);
  assert.equal(prioritizedLaneRows.bay_projection.items.length, 24);

  const matchingPriorityAfterStaleCards = await exactReviewQueueStatusSnapshot(
    { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
    {
      bayPriorityKeys: [
        ...Array.from({ length: 20 }, (_, index) => `openclaw/stale#${index + 1}`),
        "openclaw/gogcli#30008",
      ],
    },
  );
  assert.ok(matchingPriorityAfterStaleCards);
  assert.equal(
    matchingPriorityAfterStaleCards.bay_projection.items[0].item_key,
    "openclaw/gogcli#30008",
  );
});

test("triage routing groups classify impact labels without forcing one primary group", () => {
  assert.deepEqual(
    triageRoutingGroupsForLabels([
      "impact:message-loss",
      { name: "impact:security" },
      "clawsweeper:queueable-fix",
    ]).map((group) => group.id),
    ["message-delivery", "security"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels(["impact:unknown"]).map((group) => group.id),
    ["unclassified"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels(["impact:ux-release-blocker"]).map((group) => group.id),
    ["user-experience"],
  );
  assert.deepEqual(
    triageRoutingGroupsForLabels([{ name: "impact:ux-friction" }]).map((group) => group.id),
    ["user-experience"],
  );
  assert.equal(TRIAGE_ROUTING_GROUPS.at(-1)?.id, "unclassified");
});

test("issue triage exposes impact-group controls without changing PR proof triage", async () => {
  const issuePage = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/triage"), {});
  const proofPage = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/pr-proof-triage"),
    {},
  );
  const issueHtml = await issuePage.text();
  assert.match(issueHtml, /id="routing-group"/);
  assert.match(issueHtml, /Impact group/);
  assert.doesNotMatch(await proofPage.text(), /id="routing-group"/);
});

test("dashboard health identifies the deployed revision", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/health"), {
    CLAWSWEEPER_DEPLOY_SHA: "abc123",
  });

  assert.deepEqual(await response.json(), {
    ok: true,
    service: "clawsweeper-status",
    deployment_sha: "abc123",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("OpenClaw Bay is an unlisted, hardened demo route", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/bay-demo"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const contentSecurityPolicy = response.headers.get("content-security-policy") || "";
  assert.match(contentSecurityPolicy, /connect-src 'self' https:\/\/\*\.openclaw\.ai/);
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  const body = await response.text();
  assert.match(body, /<title>OpenClaw Bay · ClawSweeper<\/title>/);
  assert.match(body, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(body, /Experimental demo/);
  assert.match(body, /href="\/bay-demo" aria-current="page"/);
  assert.match(body, /Where's my crustacean\?/);
  assert.match(body, /Terminal pools clear together at 20 outcomes/);
  assert.match(body, /Master Sweeper/);
  assert.match(body, /id="bay-control-board"/);
  assert.match(body, /Review admission/);
  assert.match(body, /Result publication/);
  assert.match(body, /Queue handoff/);
  assert.match(body, /function loadBayHistory/);
  assert.match(body, /function bayRateSparkline/);
  assert.match(body, /net throughput over .*bayRangeLabel/);
  assert.match(body, /data-bay-history-range="24h"/);
  assert.match(body, /data-bay-history-range="7d"/);
  assert.match(body, /bay-control-axis-label/);
  assert.match(body, /api\/health-history\?range="\+encodeURIComponent\(range\)/);
  assert.match(body, /function expandQueue/);
  assert.match(body, /Repair cove/);
  assert.match(body, /id="tunnel-layer"/);
  assert.match(body, /function startTunnelJourney/);
  assert.doesNotMatch(body, /function drawTunnels/);
  assert.match(body, /function visualBackwardTransitionKey/);
  assert.match(body, /class="ready-flag"/);
  assert.match(body, /function sweepPendingForward/);
  assert.match(body, /function laneLinesSvg/);
  assert.match(body, /function laneWeightFor/);
  assert.match(body, /gridTemplateColumns=laneWeights/);
  assert.match(body, /function fitStageDensity/);
  assert.match(body, /function terminalColumns\(count\)/);
  assert.match(body, /count>12&&width>=340\)return 4/);
  assert.match(body, /function terminalSlots\(columns\)/);
  assert.match(body, /TERMINAL_GROUPS=/);
  assert.match(body, /Failed \/ cancelled/);
  assert.match(body, /function terminalCapacity\(stage\)/);
  assert.match(body, /stage==="completed"&&terminalStack&&terminalStack\.clientWidth>=340\?20:12/);
  assert.match(body, /columns===4/);
  assert.match(body, /Avg trigger → final review/);
  assert.match(body, /Awaiting a completed journey/);
  assert.match(body, /id="queue-sample-drawer"/);
  assert.match(body, /-reference public sample/);
  assert.match(body, /does not fetch or invent that missing list/);
  assert.match(body, /var known=rows;/);
  assert.match(body, /data-overflow-stage/);
  assert.match(body, /function laneHelp/);
  assert.match(body, /lane-nudge/);
  assert.match(body, /id="overall-average"/);
  assert.doesNotMatch(body, /function laneTimingHtml/);
  assert.doesNotMatch(body, /lane-average/);
  assert.doesNotMatch(body, /AVG WAIT|AVG TIME|AVG RUN/);
  assert.match(body, /function packActiveStages/);
  assert.match(body, /id="chat-overlay"/);
  assert.match(body, /id="chat-overlay" aria-hidden="true"/);
  assert.doesNotMatch(body, /id="chat-overlay" aria-live=/);
  assert.match(body, /function showLaneChat/);
  assert.match(body, /z-index:90/);
  assert.match(body, /id="tide-preview"/);
  assert.match(body, /id="tide-visual"/);
  assert.match(body, /class="tide-carriage wave"/);
  assert.match(body, /tide-water-texture/);
  assert.match(body, /tide-washing/);
  assert.match(body, /dataset\.tidePhase="incoming"/);
  assert.match(body, /duration:"520ms"|end:520/);
  assert.match(body, /function previewTide/);
  assert.match(body, /live outcome data was unchanged/);
  assert.match(body, /realTidePending/);
  assert.match(body, /loadInFlight/);
  assert.match(body, /replaceChildren\(journey\)/);
  assert.match(body, /master\.getAnimations\(\)/);
  assert.match(body, /Let the current beach movement finish first/);
  assert.match(body, /function visualTransitionKey/);
  assert.match(body, /pendingItems/);
  assert.match(body, /OUTCOME_CONFIRM_MS=150000/);
  assert.match(body, /function reconcileConfirmingOutcomes/);
  assert.match(body, /confirming-flag/);
  assert.match(body, /confirming outcome/);
  assert.match(body, /data-key=/);
  assert.match(body, /aria-pressed=/);
  assert.match(body, /function laneChatCopy/);
  assert.match(body, /Have you been in this lane long\?/);
  assert.match(body, /I'm listening for the master sweeper\./);
  assert.match(body, /The sand is cosy enough\./);
  assert.match(body, /chatSequence:0/);
  assert.doesNotMatch(body, /Things are moving|30m end to end/);
  const chatScript = [...body.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(chatScript);
  const chatCopyStart = chatScript.indexOf("function hash(value)");
  const chatCopyEnd = chatScript.indexOf("function runLaneChat()", chatCopyStart);
  assert.ok(chatCopyStart > 0 && chatCopyEnd > chatCopyStart);
  const chatCopySource = chatScript.slice(chatCopyStart, chatCopyEnd);
  const chatContext = createContext({
    state: { chatSequence: 0 },
    asking: { getAttribute: () => "openclaw/openclaw#1" },
    replying: { getAttribute: () => "openclaw/openclaw#2" },
    copies: [],
  });
  new Script(
    `${chatCopySource};for(var chatIndex=0;chatIndex<10;chatIndex+=1)copies.push(laneChatCopy(asking,replying,7));`,
  ).runInContext(chatContext);
  assert.ok(new Set(chatContext.copies.map((copy) => copy.question)).size > 1);
  assert.ok(new Set(chatContext.copies.map((copy) => copy.answer)).size > 1);
  assert.ok(chatContext.copies.every((copy) => copy.answer.includes("7m")));
  const runChangedSource = body.match(/function runChanged\([^}]+\}/)?.[0];
  const transitionKindSource = body.match(
    /function transitionKind\([^]*?return oldIndex>=0&&nextIndex>oldIndex\?"forward":null;\}/,
  )?.[0];
  assert.ok(runChangedSource);
  assert.ok(transitionKindSource);
  const classifyTransition = new Script(
    `${runChangedSource};(${transitionKindSource})`,
  ).runInNewContext({
    MAIN_STAGES: ["arriving", "setting-up", "reviewing", "applying"],
  });
  for (const stage of ["setting-up", "reviewing", "applying"]) {
    assert.equal(
      classifyTransition({ run_id: "old", stage: "reviewing" }, { run_id: "new", stage }),
      "retrigger",
    );
  }
  assert.equal(
    classifyTransition(
      { run_id: "same", stage: "reviewing" },
      { run_id: "same", stage: "repairing" },
    ),
    null,
  );
  assert.equal(
    classifyTransition(
      { run_id: "same", stage: "reviewing" },
      { run_id: "same", stage: "applying" },
    ),
    "forward",
  );
  assert.match(body, /hasBaySchema\(live\.bay\)\?live\.bay:previewBay/);
  assert.match(body, /state\.previewSource=false/);
  assert.match(body, /record\.outcome==="failure"\?"failed"/);
  assert.match(body, /master\.classList\.add\("resting"\)/);
  assert.match(body, /fetch\("\/api\/status"/);
  assert.match(body, /exact_review_queue=live\.exact_review_queue/);
  assert.match(body, /setInterval\(load,20000\)/);
  assert.doesNotMatch(body, /api\.github\.com|fetch\("\/repos\//);
  assert.match(body, /Disappearing workers remain CHECKING/);
  assert.match(body, /renderRepos\(state\.filter\)/);
  assert.match(body, /replacement\.focus\(\{preventScroll:true\}\)/);
  const script = [...body.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  const confirmingStart = script.indexOf("function reconcileConfirmingOutcomes");
  const confirmingEnd = script.indexOf("function reposFor", confirmingStart);
  assert.ok(confirmingStart > 0 && confirmingEnd > confirmingStart);
  const confirmingSource = script.slice(confirmingStart, confirmingEnd);
  const activeVisual = {
    id: "active:1:97722",
    key: "openclaw/openclaw#97722",
    number: 97722,
    repository: "openclaw/openclaw",
    stage: "reviewing",
    status: "in_progress",
    outcome: null,
    run_id: 1,
    current_step: "Review exact event item",
  };
  const confirmingContext = createContext({
    state: { items: [activeVisual], confirmingOutcomes: {} },
    OUTCOME_CONFIRM_MS: 150_000,
    Date,
    Object,
    nextItems: [],
    result: null,
  });
  new Script(`${confirmingSource}\nresult = reconcileConfirmingOutcomes(nextItems);`).runInContext(
    confirmingContext,
  );
  assert.equal(confirmingContext.result.length, 1);
  assert.equal(confirmingContext.result[0].confirming, true);
  assert.equal(confirmingContext.result[0].stage, "reviewing");
  assert.equal(confirmingContext.result[0].current_step, "Confirming terminal outcome");

  confirmingContext.state.items = confirmingContext.result;
  confirmingContext.nextItems = [
    {
      ...activeVisual,
      id: "terminal:1",
      stage: "completed",
      status: "success",
      outcome: "success",
    },
  ];
  new Script("result = reconcileConfirmingOutcomes(nextItems);").runInContext(confirmingContext);
  assert.equal(confirmingContext.result.length, 1);
  assert.equal(confirmingContext.result[0].stage, "completed");
  assert.equal(Object.keys(confirmingContext.state.confirmingOutcomes).length, 0);

  for (const path of ["/bay", "/bay.html", "/bay-demo.html"]) {
    const missing = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${path}`), {});
    assert.equal(missing.status, 404, `${path} should remain unpublished`);
  }

  for (const path of ["/", "/triage", "/pr-proof-triage"]) {
    const page = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${path}`), {});
    const pageBody = await page.text();
    assert.doesNotMatch(pageBody, /href="\/bay-demo"/);
    if (path === "/") assert.match(pageBody, /setInterval\(load, 15000\)/);
  }
});

test("OpenClaw Bay shares a bounded 20-outcome tide buffer", () => {
  const attempts = Array.from({ length: 20 }, (_, index) => ({
    run_id: index + 1,
    job_id: 1000 + index,
    repository: "openclaw/openclaw",
    item_numbers: [9000 + index],
    outcome: index === 18 ? "failure" : index === 19 ? "cancelled" : "success",
    terminal_outcome: index === 18 ? "failure" : index === 19 ? "cancelled" : "success",
    workflow_title: `Review event item openclaw/openclaw#${9000 + index}`,
    completed_at: `2026-07-10T20:00:${String(index).padStart(2, "0")}Z`,
  }));
  const beforeTide = mergeBayTerminalState(null, attempts.slice(0, 19), [], "2026-07-10T20:00:19Z");
  assert.equal(beforeTide.terminal_count, 19);
  assert.equal(beforeTide.tide_generation, 0);
  assert.equal(beforeTide.recently_washed.length, 0);

  const tide = mergeBayTerminalState(beforeTide, attempts, [], "2026-07-10T20:00:20Z");
  assert.equal(tide.terminal_count, 0);
  assert.equal(tide.tide_generation, 1);
  assert.equal(tide.recently_washed.length, 20);
  assert.equal(tide.last_tide_at, "2026-07-10T20:00:20Z");
  assert.equal(tide.terminal_window_started_at, "2026-07-10T20:00:19Z");
  assert.deepEqual(tide.terminal_window_event_ids, [
    "worker:20:1019:openclaw/openclaw#9019:cancelled:2026-07-10T20:00:19Z",
  ]);
  assert.deepEqual(
    tide.recently_washed.slice(-2).map((item: { outcome: string }) => item.outcome),
    ["failure", "cancelled"],
  );

  const staleAfterTide = {
    ...attempts[0],
    run_id: 10_001,
    job_id: 20_001,
    completed_at: "2026-07-10T20:00:18Z",
  };
  const distinctBoundaryEvent = {
    ...attempts[0],
    run_id: 10_003,
    job_id: 20_003,
    item_numbers: [9_999],
    completed_at: "2026-07-10T20:00:19Z",
  };
  const freshAfterTide = {
    ...attempts[0],
    run_id: 10_002,
    job_id: 20_002,
    completed_at: "2026-07-10T20:00:21Z",
  };
  const afterTide = mergeBayTerminalState(
    tide,
    [staleAfterTide, distinctBoundaryEvent, freshAfterTide],
    [],
    "2026-07-10T20:00:21Z",
  );
  assert.deepEqual(
    afterTide.terminal_buffer.map((item: { run_id: number }) => item.run_id),
    [10_003, 10_002],
  );
  assert.equal(
    afterTide.seen_events.some((item: { event_id: string }) => item.event_id.includes(":10001:")),
    false,
  );
  const boundaryReplay = mergeBayTerminalState(
    { ...tide, seen_events: [] },
    attempts.slice(-1),
    [],
    "2026-07-10T20:00:21Z",
  );
  assert.equal(boundaryReplay.terminal_count, 0);

  const burst = Array.from({ length: 50 }, (_, index) => ({
    run_id: 2000 + index,
    job_id: 3000 + index,
    repository: "openclaw/openclaw",
    item_numbers: [10_000 + index],
    outcome: "success",
    terminal_outcome: "success",
    workflow_title: `Review event item openclaw/openclaw#${10_000 + index}`,
    completed_at: `2026-07-10T21:00:${String(index).padStart(2, "0")}Z`,
  }));
  const burstTides = mergeBayTerminalState(null, burst, [], "2026-07-10T21:00:50Z");
  assert.equal(burstTides.tide_generation, 2);
  assert.equal(burstTides.terminal_count, 10);
  assert.equal(burstTides.recently_washed.length, 20);
  assert.equal(burstTides.terminal_window_started_at, "2026-07-10T21:00:39Z");
  assert.deepEqual(
    burstTides.terminal_buffer.map((item: { number: number }) => item.number),
    Array.from({ length: 10 }, (_, index) => 10_040 + index),
  );
  const retainedBurstTail = mergeBayTerminalState(burstTides, [], [], "2026-07-10T21:00:51Z");
  assert.deepEqual(
    retainedBurstTail.terminal_buffer.map((item: { number: number }) => item.number),
    Array.from({ length: 10 }, (_, index) => 10_040 + index),
  );

  const deferredWhileActive = mergeBayTerminalState(
    null,
    attempts.slice(0, 1),
    [],
    "2026-07-10T20:00:00.500Z",
    ["openclaw/openclaw#9000"],
  );
  assert.equal(deferredWhileActive.terminal_count, 0);
  assert.equal(deferredWhileActive.seen_events.length, 0);
  const visibleAfterActiveFeedSettles = mergeBayTerminalState(
    deferredWhileActive,
    attempts.slice(0, 1),
    [],
    "2026-07-10T20:00:01Z",
  );
  assert.equal(visibleAfterActiveFeedSettles.terminal_count, 1);
  assert.equal(visibleAfterActiveFeedSettles.seen_events.length, 1);

  const replay = mergeBayTerminalState(tide, attempts, [], "2026-07-10T20:00:30Z");
  assert.equal(replay.terminal_count, 0);
  assert.equal(replay.tide_generation, 1);

  const nextRun = {
    ...attempts[0],
    run_id: 101,
    job_id: 1101,
    completed_at: "2026-07-10T20:00:31Z",
  };
  const nextBuffer = mergeBayTerminalState(replay, [nextRun], [], "2026-07-10T20:00:31Z");
  assert.equal(nextBuffer.terminal_count, 1);
  assert.equal(nextBuffer.terminal_buffer[0].number, 9000);

  const terminalBeforeRetrigger = mergeBayTerminalState(
    null,
    attempts.slice(0, 2),
    [],
    "2026-07-10T20:00:02Z",
  );
  const activeAgain = mergeBayTerminalState(
    terminalBeforeRetrigger,
    attempts.slice(0, 2),
    [],
    "2026-07-10T20:00:03Z",
    ["openclaw/openclaw#9000"],
  );
  assert.equal(activeAgain.terminal_count, 1);
  assert.deepEqual(
    activeAgain.terminal_buffer.map((item: { number: number }) => item.number),
    [9001],
  );
  assert.equal(activeAgain.seen_events.length, 2);
  const reterminal = mergeBayTerminalState(activeAgain, [nextRun], [], "2026-07-10T20:00:31Z");
  assert.equal(reterminal.terminal_count, 2);
  assert.deepEqual(
    reterminal.terminal_buffer.map((item: { number: number }) => item.number),
    [9001, 9000],
  );

  const ancillaryFailure = mergeBayTerminalState(
    null,
    [
      {
        run_id: 301,
        job_id: 401,
        repository: "openclaw/openclaw",
        item_numbers: [12_345],
        outcome: "failure",
        terminal_outcome: "success",
        workflow_title: "Review with a non-terminal ancillary step failure",
        completed_at: "2026-07-10T20:00:40Z",
      },
    ],
    [],
    "2026-07-10T20:00:40Z",
  );
  assert.equal(ancillaryFailure.terminal_buffer[0].outcome, "success");

  const expiredWash = mergeBayTerminalState(replay, attempts, [], "2026-07-10T20:01:21Z");
  assert.equal(expiredWash.tide_generation, 1);
  assert.equal(expiredWash.recently_washed.length, 0);

  const legacyNoTide = {
    schema_version: 1,
    tide_threshold: 20,
    tide_generation: 0,
    last_tide_at: null,
    terminal_count: 1,
    terminal_buffer: [
      {
        event_id: "worker:old",
        item_key: "openclaw/openclaw#8000",
        completed_at: "2026-07-10T17:00:00Z",
      },
    ],
    washed_at: null,
    recently_washed: [],
    seen_events: [],
    updated_at: "2026-07-10T17:00:00Z",
  };
  const migratedNoTide = mergeBayTerminalState(
    legacyNoTide,
    [
      { ...attempts[0], run_id: 11_000, job_id: 21_000, completed_at: "2026-07-10T17:00:00Z" },
      { ...attempts[0], run_id: 11_001, job_id: 21_001, completed_at: "2026-07-10T19:30:01Z" },
    ],
    [],
    "2026-07-10T20:00:00Z",
  );
  assert.equal(migratedNoTide.terminal_window_started_at, "2026-07-10T19:00:00.000Z");
  assert.deepEqual(
    migratedNoTide.terminal_buffer.map((item: { run_id: number }) => item.run_id),
    [11_001],
  );

  const legacyTideTail = {
    schema_version: 1,
    tide_threshold: 20,
    tide_generation: 1,
    last_tide_at: "2026-07-10T20:00:20Z",
    terminal_count: 2,
    terminal_buffer: [
      {
        event_id: "worker:stale",
        item_key: "openclaw/openclaw#8001",
        completed_at: "2026-07-10T17:00:00Z",
      },
      {
        event_id: "worker:tail",
        item_key: "openclaw/openclaw#8002",
        completed_at: "2026-07-10T20:00:19.900Z",
      },
    ],
    washed_at: "2026-07-10T20:00:20Z",
    recently_washed: [],
    seen_events: [],
    updated_at: "2026-07-10T20:00:20Z",
  };
  const migratedTideTail = mergeBayTerminalState(legacyTideTail, [], [], "2026-07-10T20:00:21Z");
  assert.equal(migratedTideTail.terminal_window_started_at, "2026-07-10T20:00:19.900Z");
  assert.deepEqual(
    migratedTideTail.terminal_buffer.map((item: { item_key: string }) => item.item_key),
    ["openclaw/openclaw#8002"],
  );
});

test("OpenClaw Bay averages completed trigger-to-summary journeys from the last hour", () => {
  const generatedAt = "2026-07-11T12:00:00.000Z";
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 100,
        source_comment_id: 1,
        source_delivery_id: "delivery-1",
        triggered_at: "2026-07-11T11:42:00.000Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 200,
        source_comment_id: 2,
        source_delivery_id: "delivery-2",
        triggered_at: "2026-07-11T11:26:00.000Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 300,
        source_comment_id: 3,
        source_delivery_id: "delivery-3",
        triggered_at: "2026-07-11T10:00:00.000Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 100,
        source_comment_id: 1,
        completed_at: "2026-07-11T11:45:00.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 11,
      },
      {
        repository: "openclaw/openclaw",
        number: 200,
        source_comment_id: 2,
        completed_at: "2026-07-11T11:30:00.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 12,
      },
      {
        repository: "openclaw/openclaw",
        number: 300,
        source_comment_id: 3,
        completed_at: "2026-07-11T10:59:59.000Z",
        completion_kind: "final_command_status",
        completion_comment_id: 13,
      },
    ],
    generatedAt,
  );
  const timings = summarizeBayJourneyTimings(journeys.journeys, generatedAt);

  assert.equal(timings.window_minutes, 60);
  assert.equal("lanes" in timings, false);
  assert.deepEqual(timings.overall, { average_ms: 210_000, samples: 2 });
  assert.equal(timings.sample_kind, "completed_review_journeys");
});

test("OpenClaw Bay retains pre-delivery journey records during normalization", () => {
  const state = mergeBayJourneyState(
    {
      schema_version: 1,
      journeys: [
        {
          id: "openclaw/openclaw#540:command:456",
          item_key: "openclaw/openclaw#540",
          repository: "openclaw/openclaw",
          number: 540,
          source_comment_id: 456,
          triggered_at: "2026-07-13T11:56:00Z",
          completed_at: "2026-07-13T11:59:00Z",
          completion_kind: "final_command_status",
          completion_comment_id: 790,
        },
      ],
    },
    [],
    [],
    "2026-07-13T12:00:00Z",
  );

  assert.equal(state.journeys.length, 1);
  assert.equal(state.journeys[0]?.triggered_at, "2026-07-13T11:56:00Z");
  assert.deepEqual(summarizeBayJourneyTimings(state.journeys, "2026-07-13T12:00:00Z").overall, {
    average_ms: 180_000,
    samples: 1,
  });
});

test("OpenClaw Bay retains a completed journey for each edit of the same command", () => {
  const first = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "first-edit",
        triggered_at: "2026-07-13T12:00:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:05:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:06:00Z",
  );
  const second = mergeBayJourneyState(
    first,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "second-edit",
        triggered_at: "2026-07-13T12:10:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:14:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:15:00Z",
  );

  assert.equal(second.journeys.length, 2);
  assert.notEqual(second.journeys[0]?.id, second.journeys[1]?.id);
  assert.deepEqual(summarizeBayJourneyTimings(second.journeys, "2026-07-13T12:15:00Z").overall, {
    average_ms: 270_000,
    samples: 2,
  });
});

test("OpenClaw Bay retains same-second command edits from separate GitHub deliveries", () => {
  const journeys = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "edit-one",
        triggered_at: "2026-07-13T12:00:00Z",
      },
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "edit-two",
        triggered_at: "2026-07-13T12:00:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:05:00Z",
        completion_comment_id: 790,
      },
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:06:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:07:00Z",
  );

  assert.equal(journeys.journeys.length, 2);
  assert.notEqual(journeys.journeys[0]?.id, journeys.journeys[1]?.id);
  assert.deepEqual(summarizeBayJourneyTimings(journeys.journeys, "2026-07-13T12:07:00Z").overall, {
    average_ms: 330_000,
    samples: 2,
  });
});

test("OpenClaw Bay joins an out-of-order reused status completion to its later trigger", () => {
  const first = mergeBayJourneyState(
    null,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "first-edit",
        triggered_at: "2026-07-13T12:00:00Z",
      },
    ],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:05:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:06:00Z",
  );
  const completionBeforeTrigger = mergeBayJourneyState(
    first,
    [],
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        completed_at: "2026-07-13T12:14:00Z",
        completion_comment_id: 790,
      },
    ],
    "2026-07-13T12:14:00Z",
  );
  assert.equal(completionBeforeTrigger.journeys.length, 2);
  assert.equal(
    completionBeforeTrigger.journeys.filter((journey) => !journey.triggered_at).length,
    1,
  );

  const completed = mergeBayJourneyState(
    completionBeforeTrigger,
    [
      {
        repository: "openclaw/openclaw",
        number: 540,
        source_comment_id: 456,
        source_delivery_id: "second-edit",
        triggered_at: "2026-07-13T12:10:00Z",
      },
    ],
    [],
    "2026-07-13T12:15:00Z",
  );

  assert.equal(completed.journeys.length, 2);
  assert.equal(completed.journeys.filter((journey) => !journey.triggered_at).length, 0);
  assert.deepEqual(summarizeBayJourneyTimings(completed.journeys, "2026-07-13T12:15:00Z").overall, {
    average_ms: 270_000,
    samples: 2,
  });
});

test("hosted webhook records an edited review command through its final command update without GitHub reads", async () => {
  const triggerAtMs = Date.now() - 2 * 60 * 60 * 1000;
  const at = (offsetMs = 0) => new Date(triggerAtMs + offsetMs).toISOString();
  const statusStore = new MemoryKv();
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    STATUS_STORE: statusStore,
  };
  const trigger = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "@clawsweeper review",
          author_association: "MEMBER",
          created_at: at(-60_000),
          updated_at: at(),
          user: { login: "brokemac79" },
        },
      },
    }),
    env,
  );
  assert.equal(trigger.status, 503);

  const durableSummary = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        comment: {
          id: 789,
          body: [
            `<!-- clawsweeper-verdict:needs-human item=540 sha=abc reviewed_at=${at(4_678_000)} -->`,
          ].join("\n"),
          created_at: at(4_805_000),
          updated_at: at(4_805_000),
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal(durableSummary.status, 202);

  const completion = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "edited",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 540 },
        comment: {
          id: 790,
          body: [
            "<!-- clawsweeper-command-ack:456 -->",
            "<!-- clawsweeper-command-status:540:re_review:abc -->",
            "<!-- clawsweeper-command-progress:start -->",
            "Re-review progress:",
            "- State: Complete",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          created_at: at(3_000),
          updated_at: at(4_820_000),
          user: { login: "clawsweeper[bot]" },
        },
      },
    }),
    env,
  );
  assert.equal(completion.status, 202);
  assert.deepEqual(await completion.json(), {
    ok: true,
    accepted: false,
    reason: "recorded Bay journey completion",
  });

  const state = JSON.parse((await statusStore.get("openclaw-bay:journey-state:v1")) || "{}");
  assert.deepEqual(state.journeys, [
    {
      id: "openclaw/openclaw#540:command:456:delivery:test-delivery",
      item_key: "openclaw/openclaw#540",
      repository: "openclaw/openclaw",
      number: 540,
      source_comment_id: 456,
      source_delivery_id: "test-delivery",
      triggered_at: at(),
      completed_at: at(4_820_000),
      completion_kind: "final_command_status",
      completion_comment_id: 790,
    },
  ]);
  const timings = summarizeBayJourneyTimings(state.journeys, at(5_213_000));
  assert.deepEqual(timings.overall, { average_ms: 4_820_000, samples: 1 });
});

class MemoryKv {
  private values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MemorySqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  rowsRead = 0;
  readonly rowsWritten: number;
  private readonly rows: T[];

  constructor(rows: T[], rowsWritten: number) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
  }

  *[Symbol.iterator]() {
    for (const row of this.rows) {
      this.rowsRead += 1;
      yield row;
    }
  }
}

class MemorySqlStorage {
  private readonly database = new DatabaseSync(":memory:");
  private failure: { pattern: RegExp; error: Error } | undefined;

  exec(query: string, ...bindings: unknown[]) {
    if (this.failure?.pattern.test(query)) {
      const { error } = this.failure;
      this.failure = undefined;
      throw error;
    }
    const statement = this.database.prepare(query);
    if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
      const rows = statement.all(...bindings) as Record<string, unknown>[];
      return new MemorySqlCursor(rows, rows.length);
    }
    const result = statement.run(...bindings);
    return new MemorySqlCursor([], Number(result.changes));
  }

  transactionSync<T>(callback: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failNext(pattern: RegExp, error = new Error("injected SQL failure")) {
    this.failure = { pattern, error };
  }

  hasNormalizedQueue() {
    const table = this.database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_queue_meta'",
      )
      .get() as { found?: number } | undefined;
    if (!table) return false;
    return Boolean(
      this.database
        .prepare("SELECT 1 AS found FROM exact_review_queue_meta WHERE singleton_id = 1")
        .get(),
    );
  }

  readNormalizedQueue() {
    const meta = this.database
      .prepare("SELECT dispatcher_json FROM exact_review_queue_meta WHERE singleton_id = 1")
      .get() as { dispatcher_json?: string | null } | undefined;
    const items = Object.fromEntries(
      (
        this.database
          .prepare("SELECT item_key, item_json FROM exact_review_queue_items ORDER BY item_key")
          .all() as Array<{ item_key: string; item_json: string }>
      ).map((row) => [row.item_key, JSON.parse(row.item_json)]),
    );
    const deliveries = Object.fromEntries(
      (
        this.database
          .prepare(
            "SELECT delivery_id, received_at FROM exact_review_queue_deliveries ORDER BY delivery_id",
          )
          .all() as Array<{ delivery_id: string; received_at: number }>
      ).map((row) => [row.delivery_id, row.received_at]),
    );
    const state: {
      deliveries: Record<string, number>;
      items: Record<string, unknown>;
      dispatcher?: unknown;
    } = { deliveries, items };
    if (meta?.dispatcher_json) state.dispatcher = JSON.parse(meta.dispatcher_json);
    return state;
  }

  replaceNormalizedQueue(value: unknown) {
    const state = (value && typeof value === "object" ? value : {}) as {
      deliveries?: Record<string, number>;
      items?: Record<string, unknown>;
      dispatcher?: unknown;
    };
    this.transactionSync(() => {
      this.database.exec("DELETE FROM exact_review_queue_deliveries");
      this.database.exec("DELETE FROM exact_review_queue_items");
      const insertDelivery = this.database.prepare(
        "INSERT INTO exact_review_queue_deliveries (delivery_id, received_at) VALUES (?, ?)",
      );
      for (const [deliveryId, receivedAt] of Object.entries(state.deliveries || {})) {
        insertDelivery.run(deliveryId, receivedAt);
      }
      const insertItem = this.database.prepare(
        "INSERT INTO exact_review_queue_items (item_key, item_json) VALUES (?, ?)",
      );
      for (const [itemKey, item] of Object.entries(state.items || {})) {
        insertItem.run(itemKey, JSON.stringify(item));
      }
      this.database
        .prepare("UPDATE exact_review_queue_meta SET dispatcher_json = ? WHERE singleton_id = 1")
        .run(state.dispatcher === undefined ? null : JSON.stringify(state.dispatcher));
    });
  }

  setMigrationTime(migratedAt: number) {
    this.database
      .prepare("UPDATE exact_review_queue_meta SET migrated_at = ? WHERE singleton_id = 1")
      .run(migratedAt);
  }

  setReceiptTime(deliveryId: string, receivedAt: number) {
    this.database
      .prepare("UPDATE exact_review_queue_deliveries SET received_at = ? WHERE delivery_id = ?")
      .run(receivedAt, deliveryId);
  }
}

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private putCounts = new Map<string, number>();
  private putFailure: { key: string; error: Error } | undefined;
  private deleteFailure: { key: string; error: Error } | undefined;
  private alarmAt: number | null = null;
  readonly sql = new MemorySqlStorage();
  readonly kv = {
    get: (key: string) => this.values.get(key),
    put: (key: string, value: unknown) => this.putRawSync(key, value),
    delete: (key: string) => this.deleteRawSync(key),
  };

  transactionSync<T>(callback: () => T) {
    const valuesBefore = new Map(
      Array.from(this.values, ([key, value]) => [key, structuredClone(value)]),
    );
    const putCountsBefore = new Map(this.putCounts);
    try {
      return this.sql.transactionSync(callback);
    } catch (error) {
      this.values = valuesBefore;
      this.putCounts = putCountsBefore;
      throw error;
    }
  }

  async get(key: string, options?: { noCache?: boolean }) {
    if (key === "exact-review-queue" && this.sql.hasNormalizedQueue() && !options?.noCache) {
      return this.sql.readNormalizedQueue();
    }
    return this.values.get(key);
  }

  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === "object") {
      for (const [entryKey, entryValue] of Object.entries(key)) {
        this.throwPutFailure(entryKey);
        this.storeRaw(entryKey, entryValue);
      }
      return;
    }
    this.throwPutFailure(key);
    if (key === "exact-review-queue" && this.sql.hasNormalizedQueue()) {
      const normalized = this.sql.readNormalizedQueue();
      const candidate = (value && typeof value === "object" ? value : {}) as {
        deliveries?: Record<string, number>;
        items?: Record<string, unknown>;
        dispatcher?: unknown;
      };
      const deliveryEntries = Object.entries(candidate.deliveries || {});
      const markerEntries = deliveryEntries.filter(([deliveryId]) =>
        /^__clawsweeper_sql_generation:\d+$/.test(deliveryId),
      );
      const candidateReceipts = Object.fromEntries(
        deliveryEntries.filter(
          ([deliveryId]) => !deliveryId.startsWith("__clawsweeper_sql_generation:"),
        ),
      );
      const normalizedReceiptIds = Object.keys(normalized.deliveries).sort();
      const rollbackShadow =
        markerEntries.length === 1 &&
        markerEntries[0][1] === Number.MAX_SAFE_INTEGER &&
        isDeepStrictEqual(Object.keys(candidateReceipts).sort(), normalizedReceiptIds) &&
        normalizedReceiptIds.every(
          (deliveryId) =>
            Number(candidateReceipts[deliveryId]) >= Number(normalized.deliveries[deliveryId]),
        ) &&
        isDeepStrictEqual(candidate.items || {}, normalized.items) &&
        isDeepStrictEqual(candidate.dispatcher, normalized.dispatcher);
      if (!rollbackShadow) this.sql.replaceNormalizedQueue(candidate);
    }
    this.storeRaw(key, value);
  }

  async delete(key: string) {
    return this.deleteRawSync(key);
  }

  async list() {
    return new Map(this.values);
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    this.alarmAt = at;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }

  has(key: string) {
    return this.values.has(key);
  }

  putCount(key: string) {
    return this.putCounts.get(key) || 0;
  }

  rawHas(key: string) {
    return this.values.has(key);
  }

  rawGet(key: string) {
    return this.values.get(key);
  }

  rawPut(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }

  private throwPutFailure(key: string) {
    if (this.putFailure?.key !== key) return;
    const { error } = this.putFailure;
    this.putFailure = undefined;
    throw error;
  }

  private putRawSync(key: string, value: unknown) {
    this.throwPutFailure(key);
    this.storeRaw(key, value);
  }

  private storeRaw(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
    this.putCounts.set(key, (this.putCounts.get(key) || 0) + 1);
  }

  private deleteRawSync(key: string) {
    if (this.deleteFailure?.key === key) {
      const { error } = this.deleteFailure;
      this.deleteFailure = undefined;
      throw error;
    }
    return this.values.delete(key);
  }

  failNextPut(key: string, error = new Error("injected storage put failure")) {
    this.putFailure = { key, error };
  }

  failNextDelete(key: string, error = new Error("injected storage delete failure")) {
    this.deleteFailure = { key, error };
  }

  failNextSql(pattern: RegExp, error?: Error) {
    this.sql.failNext(pattern, error);
  }

  setExactReviewMigrationTime(migratedAt: number) {
    this.sql.setMigrationTime(migratedAt);
  }

  setExactReviewReceiptTime(deliveryId: string, receivedAt: number) {
    this.sql.setReceiptTime(deliveryId, receivedAt);
  }
}

class MemoryDurableNamespace {
  private stub;

  constructor(stub) {
    this.stub = stub;
  }

  idFromName(name: string) {
    return name;
  }

  get() {
    return this.stub;
  }
}

class MemoryCache {
  private values = new Map<string, Response>();

  async match(request: Request) {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.values.set(request.url, response.clone());
  }
}

test("automerge metric ingestion validates before writes and requires durable storage", async () => {
  const statusStore = new MemoryKv();
  const token = ["test", "token"].join("-");
  const env = { INGEST_TOKEN: token, STATUS_STORE: statusStore };
  const request = (body: Record<string, unknown>) =>
    worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.automerge_metric",
          repository: "openclaw/openclaw",
          item_number: 42,
          phase: "activated",
          occurred_at: "2026-07-17T10:00:00Z",
          ...body,
        }),
      }),
      env,
    );

  assert.equal((await request({})).status, 400);
  assert.equal(await statusStore.get("events"), null);
  assert.equal(await statusStore.get("latest-event"), null);

  assert.equal(
    (
      await request({
        event_id: "activation-42",
        session_id: "openclaw/openclaw#42:100:2026-07-17T10:00:00Z",
      })
    ).status,
    503,
  );
  assert.equal(await statusStore.get("events"), null);
  assert.equal(await statusStore.get("latest-event"), null);
});

test("automerge metric events use isolated durable keys and aggregate through the API", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace({
    fetch: (request: Request, init?: RequestInit) =>
      store.fetch(init ? new Request(request, init) : request),
  });
  const token = ["test", "token"].join("-");
  const env = { INGEST_TOKEN: token, STATUS_STORE: namespace };
  const occurredAt = new Date().toISOString();
  for (const eventId of ["terminal-1", "terminal-2"]) {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.automerge_metric",
          event_id: eventId,
          session_id: `openclaw/openclaw#42:${eventId}:${occurredAt}`,
          repository: "openclaw/openclaw",
          item_number: 42,
          phase: "terminal",
          outcome: "merged",
          occurred_at: occurredAt,
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
  }
  const duplicate = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "clawsweeper.automerge_metric",
        event_id: "terminal-1",
        session_id: `openclaw/openclaw#42:terminal-1:${occurredAt}`,
        repository: "openclaw/openclaw",
        item_number: 42,
        phase: "terminal",
        outcome: "maintainer_stopped",
        occurred_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
    env,
  );
  assert.equal(duplicate.status, 200);

  assert.equal(storage.rawHas("automerge-product-metrics:v1"), false);
  assert.equal(storage.rawHas("automerge-product-metrics:v1:id:terminal-1"), true);
  assert.equal(storage.rawHas("automerge-product-metrics:v1:id:terminal-2"), true);
  const metrics = await (
    await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/automerge-metrics?range=6h"),
      env,
    )
  ).json();
  assert.equal(metrics.summary.terminal_sessions, 2);
  assert.equal(metrics.summary.merged_sessions, 2);
});

test("dashboard durable status store persists, expires, and prepends events", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const key = "https://clawsweeper-status-store/snapshot";

  assert.equal((await store.fetch(new Request(key))).status, 404);
  assert.equal(
    (
      await store.fetch(
        new Request(key, {
          method: "PUT",
          body: JSON.stringify({ value: "ready" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal(await (await store.fetch(new Request(key))).text(), "ready");

  await store.fetch(
    new Request("https://clawsweeper-status-store/expired", {
      method: "PUT",
      body: JSON.stringify({ value: "old", expires_at: Date.now() - 1 }),
    }),
  );
  assert.equal(
    (await store.fetch(new Request("https://clawsweeper-status-store/expired"))).status,
    404,
  );

  for (const id of ["first", "second"]) {
    assert.equal(
      (
        await store.fetch(
          new Request("https://clawsweeper-status-store/events", {
            method: "POST",
            body: JSON.stringify({ event: { id }, limit: 2, ttl_seconds: 60 }),
          }),
        )
      ).status,
      200,
    );
  }
  assert.deepEqual(
    JSON.parse(
      await (await store.fetch(new Request("https://clawsweeper-status-store/events"))).text(),
    ),
    [{ id: "second" }, { id: "first" }],
  );

  const bayStoreUrl = `https://clawsweeper-status-store/${encodeURIComponent(
    "openclaw-bay:terminal-state:v1",
  )}`;
  for (const number of [501, 502]) {
    const response = await store.fetch(
      new Request(bayStoreUrl, {
        method: "POST",
        body: JSON.stringify({
          attempts: [
            {
              run_id: number,
              job_id: number,
              repository: "openclaw/openclaw",
              item_numbers: [number],
              outcome: "success",
              terminal_outcome: "success",
              completed_at: `2026-07-11T12:00:${String(number - 500).padStart(2, "0")}Z`,
            },
          ],
          closed_items: [],
          generated_at: `2026-07-11T12:00:${String(number - 500).padStart(2, "0")}Z`,
          ttl_seconds: 60,
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
  const persistedBay = JSON.parse(await (await store.fetch(new Request(bayStoreUrl))).text());
  const bayPutsBeforeReplay = storage.putCount("openclaw-bay:terminal-state:v1");
  const replay = await store.fetch(
    new Request(bayStoreUrl, {
      method: "POST",
      body: JSON.stringify({
        attempts: [
          {
            run_id: 502,
            job_id: 502,
            repository: "openclaw/openclaw",
            item_numbers: [502],
            outcome: "success",
            terminal_outcome: "success",
            completed_at: "2026-07-11T12:00:02Z",
          },
        ],
        closed_items: [],
        generated_at: "2026-07-11T12:00:03Z",
        ttl_seconds: 60,
      }),
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal(storage.putCount("openclaw-bay:terminal-state:v1"), bayPutsBeforeReplay);
  assert.equal(JSON.parse(await replay.text()).updated_at, persistedBay.updated_at);
  assert.deepEqual(
    persistedBay.terminal_buffer.map((item: { number: number }) => item.number),
    [501, 502],
  );

  await store.fetch(
    new Request("https://clawsweeper-status-store/events", {
      method: "PUT",
      body: JSON.stringify({
        value: JSON.stringify([{ id: "expired" }]),
        expires_at: Date.now() - 1,
      }),
    }),
  );
  await store.fetch(
    new Request("https://clawsweeper-status-store/events", {
      method: "POST",
      body: JSON.stringify({ event: { id: "fresh" }, limit: 2, ttl_seconds: 60 }),
    }),
  );
  assert.deepEqual(
    JSON.parse(
      await (await store.fetch(new Request("https://clawsweeper-status-store/events"))).text(),
    ),
    [{ id: "fresh" }],
  );

  await store.fetch(
    new Request("https://clawsweeper-status-store/cold-expired", {
      method: "PUT",
      body: JSON.stringify({ value: "old", expires_at: Date.now() - 1 }),
    }),
  );
  assert.equal(storage.has("cold-expired"), true);
  await store.alarm();
  assert.equal(storage.has("cold-expired"), false);
});

test("dashboard reuses a current Bay snapshot from the shared status store", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      bay: {
        timings: { sample_kind: "completed_review_journeys" },
      },
      pipeline: [{ id: "shared-snapshot" }],
    }),
  );
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("shared snapshot should avoid GitHub requests");
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CACHE_TTL_SECONDS: "60",
        STATUS_STORE: statusStore,
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pipeline[0].id, "shared-snapshot");
    assert.equal(networkRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health history persists five-minute samples and serves a bounded range", async () => {
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const sample = {
    at: new Date().toISOString(),
    status: "degraded",
    queued: 12,
    queued_over_30m: 4,
    oldest_queued_minutes: 75,
    running: 3,
    running_over_150m: 0,
    oldest_running_minutes: 40,
    collection_ok: true,
    exact_review: {
      collection_ok: true,
      review: { pending: 317 },
      publication: { pending: 1502 },
    },
  };

  for (const queued of [12, 14]) {
    const response = await store.fetch(
      new Request("https://clawsweeper-status-store/health-history", {
        method: "POST",
        body: JSON.stringify({ sample: { ...sample, queued } }),
      }),
    );
    assert.equal(response.status, 200);
  }

  await store.fetch(
    new Request("https://clawsweeper-status-store/health-history", {
      method: "POST",
      body: JSON.stringify({
        sample: { ...sample, at: new Date(Date.now() - 8 * 60 * 60_000).toISOString(), queued: 3 },
      }),
    }),
  );

  const sixHourResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
    { STATUS_STORE: namespace },
  );
  const sixHourHistory = await sixHourResponse.json();
  assert.equal(sixHourResponse.status, 200);
  assert.equal(sixHourHistory.range, "6h");
  assert.equal(sixHourHistory.retention_days, 7);
  assert.equal(sixHourHistory.samples.length, 1);
  assert.equal(sixHourHistory.samples[0].queued, 14);
  assert.equal(sixHourHistory.samples[0].exact_review.review.pending, 317);

  for (const [query, expectedRange] of [
    ["24h", "24h"],
    ["7d", "7d"],
    ["invalid", "24h"],
  ]) {
    const response = await worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai/api/health-history?range=${query}`),
      { STATUS_STORE: namespace },
    );
    const history = await response.json();
    assert.equal(history.range, expectedRange);
    assert.equal(history.samples.length, 2);
  }
});

test("dashboard cron records only exact-review history without GitHub queries", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const store = new StatusStore({ storage });
  const namespace = new MemoryDurableNamespace(store);
  const requests: string[] = [];
  let queueReads = 0;
  const exactReviewQueue = {
    idFromName: () => "global",
    get: () => ({
      fetch: async () => {
        queueReads += 1;
        return jsonResponse({
          handoff_health: { status: "healthy" },
          lanes: {
            review: {
              pending: 17,
              enqueued_total: 101,
              completed_total: 83,
              shed_since_reset: 5,
            },
            publication: { pending: 29, enqueued_total: 157, completed_total: 123 },
          },
        });
      },
    }),
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.pathname, "/repos/openclaw/clawsweeper/actions/runs");
    const status = url.searchParams.get("status");
    return jsonResponse({
      workflow_runs:
        status === "queued"
          ? Array.from({ length: 100 }, (_, index) => ({
              id: 9001 + index,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "queued",
              created_at: isoAgo((index === 0 ? 40 : 10) * 60_000),
            }))
          : [],
    });
  };
  let recording: Promise<unknown> | undefined;
  try {
    await worker.scheduled(
      {},
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        EXACT_REVIEW_QUEUE: exactReviewQueue,
        STATUS_STORE: namespace,
      },
      { waitUntil: (promise) => (recording = promise) },
    );
    await recording;
    assert.equal(requests.length, 0);
    assert.equal(queueReads, 1);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/health-history?range=24h"),
      { STATUS_STORE: namespace },
    );
    const history = await response.json();
    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0].status, undefined);
    assert.equal(history.samples[0].queued, undefined);
    assert.equal(history.samples[0].exact_review.collection_ok, true);
    assert.equal(history.samples[0].exact_review.review.pending, 17);
    assert.equal(history.samples[0].exact_review.review.enqueued_total, 101);
    assert.equal(history.samples[0].exact_review.review.completed_total, 83);
    assert.equal(history.samples[0].exact_review.review.shed_total, 5);
    assert.equal(history.samples[0].exact_review.publication.pending, 29);
    assert.equal(history.samples[0].exact_review.publication.enqueued_total, 157);
    assert.equal(history.samples[0].exact_review.publication.completed_total, 123);

    let failureRecording: Promise<unknown> | undefined;
    await worker.scheduled(
      {},
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        EXACT_REVIEW_QUEUE: {
          idFromName: () => "global",
          get: () => ({ fetch: async () => Promise.reject(new Error("queue unavailable")) }),
        },
        STATUS_STORE: namespace,
      },
      { waitUntil: (promise) => (failureRecording = promise) },
    );
    await failureRecording;
    const afterFailure = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/health-history?range=6h"),
      { STATUS_STORE: namespace },
    );
    const failedQueueHistory = await afterFailure.json();
    assert.equal(failedQueueHistory.samples.length, 1);
    assert.equal(failedQueueHistory.samples[0].queued, undefined);
    assert.deepEqual(failedQueueHistory.samples[0].exact_review, { collection_ok: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("optional exact-review telemetry failures do not freeze an idle status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const statusStore = new MemoryKv();
  await statusStore.put(
    "snapshot",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      health: {},
      bay: { timings: { sample_kind: "completed_review_journeys" } },
      pipeline: [],
      fleet: { active_workflow_runs: 0 },
      diagnostics: { errors: [] },
    }),
  );
  globalThis.fetch = async () => {
    throw new Error("shared snapshot should avoid GitHub requests");
  };
  let queueReads = 0;
  const failingQueue = {
    fetch: async () => {
      queueReads += 1;
      return new Response(JSON.stringify({ error: "queue_read_failed" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const env = {
    CACHE_TTL_SECONDS: "60",
    STATUS_STORE: statusStore,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(failingQueue),
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.exact_review_queue, null);
    assert.deepEqual(status.diagnostics.errors, []);
    assert.equal(status.diagnostics.exact_review_queue_error, "queue_read_failed");

    const cached = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.headers.get("x-clawsweeper-cache"), "fresh");
    assert.equal((await cached.json()).diagnostics.exact_review_queue_error, "queue_read_failed");
    assert.equal(queueReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("exact-review queue coalesces deliveries, dispatches a bound rollout snapshot, and rejects duplicate claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  let workflowState = "disabled_manually";
  let signalWorkflowCheckStarted!: () => void;
  let releaseWorkflowCheck!: () => void;
  const workflowCheckStarted = new Promise<void>((resolve) => {
    signalWorkflowCheckStarted = resolve;
  });
  const workflowCheckRelease = new Promise<void>((resolve) => {
    releaseWorkflowCheck = resolve;
  });
  let wroteActiveLease = false;
  const storagePut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (key === "exact-review-queue") {
      const snapshot = value as { items?: Record<string, { state?: string }> };
      wroteActiveLease ||= Object.values(snapshot.items || {}).some(
        (item) => item.state === "dispatching" || item.state === "leased",
      );
    }
    await storagePut(key, value);
  };
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      signalWorkflowCheckStarted();
      await workflowCheckRelease;
      return jsonResponse({ state: workflowState });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dispatch-token");
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
      },
    );
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
    const first = buildExactReviewQueueRequest("delivery-1", 597, "opened", "issue", undefined, {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
      codexTimeoutMs: 1_200_000,
      mediaProofTimeoutMs: 480_000,
    });
    const duplicate = first.clone();
    const latest = buildExactReviewQueueRequest("delivery-2", 597, "edited");
    const second = buildExactReviewQueueRequest("delivery-3", 598, "opened");
    assert.equal((await queue.fetch(duplicate)).status, 202);
    assert.equal((await queue.fetch(latest)).status, 202);
    assert.equal((await queue.fetch(second)).status, 202);
    assert.equal((await queue.fetch(first)).status, 202);

    const alarm = queue.alarm();
    await workflowCheckStarted;
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-during-preflight", 600, "opened")))
        .status,
      202,
    );
    releaseWorkflowCheck();
    await alarm;
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.dispatcher.state, "paused");
    assert.equal(stats.dispatcher.reason, "workflow_not_active");
    assert.equal(stats.dispatcher.workflow_state, "disabled_manually");
    assert.equal(wroteActiveLease, false);
    assert.equal(dispatched.length, 0);

    const pausedState = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    assert.ok(
      Object.values(pausedState.items).some(
        (item) => item.nextAttemptAt < pausedState.dispatcher.retryAt,
      ),
    );
    // Simulate the pre-repair persisted state, which moved the whole backlog
    // to the dispatcher retry. At the scheduled wake, recovery must not need
    // an operator rewrite.
    pausedState.dispatcher.retryAt = Date.now() - 1;
    for (const item of Object.values(pausedState.items)) {
      item.nextAttemptAt = pausedState.dispatcher.retryAt;
    }
    await storage.put("exact-review-queue", pausedState);
    workflowState = "active";
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 1);
    assert.equal(stats.leased, 0);
    assert.equal(stats.handoff_health.status, "healthy");
    assert.equal(stats.handoff_health.phases.dispatching.count, 1);
    assert.equal(typeof stats.oldest_dispatching_age_seconds, "number");
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const payload = dispatched[0].client_payload as Record<string, unknown>;
    const leaseId = String(payload.queue_lease_id || "");
    assert.match(leaseId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(payload, {
      queue_lease_id: leaseId,
      queue_claim: {
        protocol_version: 2,
        item_key: "openclaw/gogcli#597",
        lease_revision: 2,
      },
      target_repo: "openclaw/gogcli",
      target_branch: "main",
      item_number: 597,
      item_kind: "issue",
      source_event: "issues",
      source_action: "edited",
      supersedes_in_progress: true,
      review_options: {
        codex_timeout_ms: 1_200_000,
        media_proof_timeout_ms: 480_000,
        command_status_marker: commandStatusMarker,
        status_comment_id: 9001,
        additional_prompt: "Check the maintainer-requested regression path.",
      },
    });
    assert.equal(Object.keys(payload).length, 10);

    const newer = buildExactReviewQueueRequest("delivery-4", 597, "synchronize", "pull_request");
    assert.equal((await queue.fetch(newer)).status, 202);

    const claimed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#597",
          lease_revision: 2,
          run_id: "100",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claimed.status, 200);
    assert.deepEqual(await claimed.json(), {
      ok: true,
      claimed: true,
      protocol_version: 2,
      item_key: "openclaw/gogcli#597",
      lease_revision: 2,
      claim_generation: 1,
      decision: {
        targetRepo: "openclaw/gogcli",
        targetBranch: "main",
        itemNumber: 597,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "edited",
        supersedesInProgress: true,
        commandStatusMarker,
        statusCommentId: 9001,
        additionalPrompt: "Check the maintainer-requested regression path.",
        codexTimeoutMs: 1_200_000,
        mediaProofTimeoutMs: 480_000,
      },
    });
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 1);
    assert.equal(stats.handoff_health.phases.leased.count, 1);
    assert.equal(typeof stats.oldest_leased_age_seconds, "number");
    assert.equal(
      (
        await queue.fetch(
          new Request("https://clawsweeper-exact-review-queue/claim", {
            method: "POST",
            body: JSON.stringify({
              lease_id: leaseId,
              item_key: "openclaw/gogcli#597",
              lease_revision: 2,
              run_id: "101",
              run_attempt: 1,
            }),
          }),
        )
      ).status,
      409,
    );

    const completed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#597",
          lease_revision: 2,
          claim_generation: 1,
          run_id: "100",
          run_attempt: 1,
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: true });
    const requeued = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { attempts: number; nextAttemptAt: number; decision: Record<string, unknown> }
      >;
    };
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.commandStatusMarker, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.statusCommentId, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.additionalPrompt, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].attempts, 0);
    assert.ok(requeued.items["openclaw/gogcli#597"].nextAttemptAt <= Date.now());
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 0);
    assert.match(String(stats.oldest_pending_at), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue upgrades flow metrics without losing publication completions", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_metrics (
       singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
       publication_completed_total INTEGER NOT NULL CHECK (publication_completed_total >= 0)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_metrics (singleton_id, publication_completed_total)
     VALUES (1, 42)`,
  );
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_metric_buckets (
       bucket_start INTEGER PRIMARY KEY,
       publication_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (publication_enqueued >= 0),
       publication_resolved INTEGER NOT NULL DEFAULT 0 CHECK (publication_resolved >= 0),
       publication_published INTEGER NOT NULL DEFAULT 0 CHECK (publication_published >= 0),
       publication_superseded INTEGER NOT NULL DEFAULT 0 CHECK (publication_superseded >= 0),
       publication_retried INTEGER NOT NULL DEFAULT 0 CHECK (publication_retried >= 0),
       publication_dead_lettered INTEGER NOT NULL DEFAULT 0
         CHECK (publication_dead_lettered >= 0)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_metric_buckets
       (bucket_start, publication_enqueued, publication_resolved, publication_published)
     VALUES (?, 2, 1, 1)`,
    Date.now(),
  );
  const queue = new ExactReviewQueue({ storage }, {});

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(
    {
      review_enqueued: stats.lanes.review.enqueued_total,
      review_completed: stats.lanes.review.completed_total,
      publication_enqueued: stats.lanes.publication.enqueued_total,
      publication_completed: stats.lanes.publication.completed_total,
    },
    {
      review_enqueued: 0,
      review_completed: 0,
      publication_enqueued: 0,
      publication_completed: 42,
    },
  );
  assert.equal(stats.lanes.publication.flow.last_15_minutes.published_rate_per_hour, 4);
  assert.deepEqual(stats.lanes.review.flow.last_15_minutes, {
    window_minutes: 15,
    arrival: 0,
    successful: 0,
    retried: 0,
    shed: 0,
    arrival_rate_per_hour: 0,
    successful_rate_per_hour: 0,
    retried_rate_per_hour: 0,
    shed_rate_per_hour: 0,
    retry_amplification: null,
  });
});

test("exact-review queue migrates delivery receipts and retains them for seven days", async () => {
  const storage = new MemoryDurableStorage();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  await storage.put("exact-review-queue", {
    deliveries: {
      "delivery-expired": Date.now() - sevenDaysMs - 60_000,
      "delivery-within-window": Date.now() - sevenDaysMs + 60_000,
    },
    items: {},
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-fresh", 619, "opened"))).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
  };
  assert.deepEqual(Object.keys(state.deliveries).sort(), [
    "delivery-fresh",
    "delivery-within-window",
  ]);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 2);
  assert.equal(stats.storage_schema_version, 1);
  assert.equal(stats.legacy_rollback_available, true);
  const shadowDeliveries = (
    storage.rawGet("exact-review-queue") as { deliveries: Record<string, number> }
  ).deliveries;
  const shadowGenerationIds = Object.keys(shadowDeliveries).filter((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.equal(shadowGenerationIds.length, 1);
  assert.equal(shadowDeliveries[shadowGenerationIds[0]], Number.MAX_SAFE_INTEGER);
  assert.deepEqual(
    Object.keys(shadowDeliveries)
      .filter((deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"))
      .sort(),
    ["delivery-fresh", "delivery-within-window"],
  );
  assert.ok(shadowDeliveries["delivery-within-window"] > Date.now() - 5 * 24 * 60 * 60 * 1000);

  const restarted = new ExactReviewQueue({ storage }, {});
  const duplicate = await restarted.fetch(
    buildExactReviewQueueRequest("delivery-within-window", 619, "edited"),
  );
  assert.deepEqual(await duplicate.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#619",
  });
});

test("exact-review receipt acceptance and queue mutation commit atomically", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  storage.failNextSql(/INSERT INTO exact_review_queue_items/);

  await assert.rejects(
    queue.fetch(buildExactReviewQueueRequest("delivery-atomic", 625, "opened")),
    /injected SQL failure/,
  );
  let state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(state.deliveries, {});
  assert.deepEqual(state.items, {});
  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 0);

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-atomic", 625, "opened"))).status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.deliveries), ["delivery-atomic"]);
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#625"]);
  stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("exact-review re-upgrade imports rollback-era queue mutations and receipts", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-before-rollback", 626, "opened")))
      .status,
    202,
  );

  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, Record<string, unknown>>;
    },
  );
  const oldGenerationId = Object.keys(shadow.deliveries).find((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.ok(oldGenerationId);
  const rollbackItem = structuredClone(shadow.items["openclaw/gogcli#626"]);
  rollbackItem.key = "openclaw/gogcli#627";
  rollbackItem.decision = {
    ...(rollbackItem.decision as Record<string, unknown>),
    itemNumber: 627,
  };
  delete shadow.items["openclaw/gogcli#626"];
  shadow.items["openclaw/gogcli#627"] = rollbackItem;
  shadow.deliveries["delivery-during-rollback"] = Date.now();
  storage.rawPut("exact-review-queue", shadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 2);
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#627"]);
  assert.deepEqual(Object.keys(state.deliveries).sort(), [
    "delivery-before-rollback",
    "delivery-during-rollback",
  ]);
  const upgradedShadow = storage.rawGet("exact-review-queue") as {
    deliveries: Record<string, number>;
  };
  const upgradedGenerationIds = Object.keys(upgradedShadow.deliveries).filter((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.equal(upgradedGenerationIds.length, 1);
  assert.match(upgradedGenerationIds[0], /^__clawsweeper_sql_generation:\d+$/);
  assert.notEqual(upgradedGenerationIds[0], oldGenerationId);
  assert.deepEqual(
    Object.keys(upgradedShadow.deliveries)
      .filter((deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"))
      .sort(),
    ["delivery-before-rollback", "delivery-during-rollback"],
  );
});

test("exact-review re-upgrade distinguishes a refreshed rollback receipt", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-refreshed", 634, "opened"))).status,
    202,
  );
  const oldReceivedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const refreshedAt = Date.now();
  storage.setExactReviewReceiptTime("delivery-refreshed", oldReceivedAt);
  const rollback = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, { revision: number; updatedAt: number }>;
    },
  );
  rollback.deliveries["delivery-refreshed"] = refreshedAt;
  rollback.items["openclaw/gogcli#634"].revision += 1;
  rollback.items["openclaw/gogcli#634"].updatedAt = refreshedAt;
  storage.rawPut("exact-review-queue", rollback);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, { revision: number }>;
  };
  assert.equal(state.deliveries["delivery-refreshed"], refreshedAt);
  assert.equal(state.items["openclaw/gogcli#634"].revision, 2);
  assert.deepEqual(
    await (
      await upgraded.fetch(buildExactReviewQueueRequest("delivery-refreshed", 634, "edited"))
    ).json(),
    { ok: true, deduped: true, item_key: "openclaw/gogcli#634" },
  );
});

test("exact-review receipt pruning removes its translated shadow atomically", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-pruned", 635, "opened"))).status,
    202,
  );
  const expiredAt = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1;
  storage.setExactReviewReceiptTime("delivery-pruned", expiredAt);
  const staleShadow = structuredClone(
    storage.rawGet("exact-review-queue") as { deliveries: Record<string, number> },
  );
  staleShadow.deliveries["delivery-pruned"] = expiredAt + 2 * 24 * 60 * 60 * 1000;
  storage.rawPut("exact-review-queue", staleShadow);

  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 0);
  const refreshedShadow = storage.rawGet("exact-review-queue") as {
    deliveries: Record<string, number>;
  };
  assert.deepEqual(
    Object.keys(refreshedShadow.deliveries).filter(
      (deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"),
    ),
    [],
  );

  const restarted = new ExactReviewQueue({ storage }, {});
  stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 0);
});

test("exact-review re-upgrade fails closed for a divergent stale rollback shadow", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-stale-1", 628, "opened"))).status,
    202,
  );
  const staleShadow = structuredClone(storage.rawGet("exact-review-queue"));
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-stale-2", 629, "opened"))).status,
    202,
  );
  storage.rawPut("exact-review-queue", staleShadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  await assert.rejects(
    upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats")),
    /ambiguous exact-review legacy rollback state/,
  );
  const sqlState = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(sqlState.items).sort(), [
    "openclaw/gogcli#628",
    "openclaw/gogcli#629",
  ]);
  assert.deepEqual(storage.rawGet("exact-review-queue"), staleShadow);
});

test("exact-review discards a stale rollback shadow when its refresh fails", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(storage.rawHas("exact-review-queue"), true);
  storage.failNextPut("exact-review-queue");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-mirror-failure", 630, "opened")))
        .status,
      202,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(storage.rawHas("exact-review-queue"), false);
  assert.match(String(warnings[0][0]), /legacy rollback shadow unavailable/);

  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(storage.rawHas("exact-review-queue"), true);
});

test("exact-review rolls SQL back when an obsolete shadow cannot be removed", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const originalShadow = structuredClone(storage.rawGet("exact-review-queue"));
  storage.failNextPut("exact-review-queue");
  storage.failNextDelete("exact-review-queue");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(
      queue.fetch(buildExactReviewQueueRequest("delivery-atomic-shadow", 633, "opened")),
      /injected storage delete failure/,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.match(String(warnings[0][0]), /stale legacy rollback shadow could not be removed/);
  assert.deepEqual(storage.rawGet("exact-review-queue"), originalShadow);
  let state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(state.deliveries, {});
  assert.deepEqual(state.items, {});

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-atomic-shadow", 633, "opened")))
      .status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.deliveries), ["delivery-atomic-shadow"]);
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#633"]);
});

test("exact-review SQL rows outgrow the bounded rollback shadow without blocking intake", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.now();
  const items = Object.fromEntries(
    Array.from({ length: 220 }, (_, index) => {
      const itemNumber = 10_000 + index;
      const key = `openclaw/openclaw#${itemNumber}`;
      return [
        key,
        {
          key,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "opened",
            supersedesInProgress: false,
            additionalPrompt: "x".repeat(5_000),
          },
          state: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: now,
          attempts: 0,
        },
      ];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let queue: ExactReviewQueue;
  try {
    queue = new ExactReviewQueue({ storage }, {});
    const response = await queue.fetch(
      buildExactReviewQueueRequest("delivery-after-large-migration", 20_000, "opened"),
    );
    assert.equal(response.status, 202);
  } finally {
    console.warn = originalWarn;
  }

  const stats = await (
    await queue!.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 221);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.legacy_rollback_available, false);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /legacy rollback shadow unavailable/);
  assert.match(String(warnings[0][1]), /shadow is \d+ bytes/);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review migration removes its rollback shadow after one day", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-shadow", 626, "opened"))).status,
    202,
  );
  assert.equal(storage.rawHas("exact-review-queue"), true);

  storage.setExactReviewMigrationTime(Date.now() - 24 * 60 * 60 * 1000 - 1);
  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.legacy_rollback_available, false);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review imports an active rollback before expiring an old bridge", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-old-bridge", 631, "opened"))).status,
    202,
  );
  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, Record<string, unknown>>;
    },
  );
  const oldMigrationTime = Date.now() - 24 * 60 * 60 * 1000 - 1;
  storage.setExactReviewMigrationTime(oldMigrationTime);
  const generationId = Object.keys(shadow.deliveries).find((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.ok(generationId);
  assert.equal(shadow.deliveries[generationId], Number.MAX_SAFE_INTEGER);
  for (const [deliveryId, receivedAt] of Object.entries(shadow.deliveries)) {
    if (receivedAt <= Date.now() - 5 * 24 * 60 * 60 * 1000) {
      delete shadow.deliveries[deliveryId];
    }
  }
  assert.equal(shadow.deliveries[generationId], Number.MAX_SAFE_INTEGER);
  shadow.deliveries["delivery-old-bridge-rollback"] = Date.now();
  const rollbackItem = structuredClone(shadow.items["openclaw/gogcli#631"]);
  rollbackItem.key = "openclaw/gogcli#632";
  rollbackItem.decision = {
    ...(rollbackItem.decision as Record<string, unknown>),
    itemNumber: 632,
  };
  delete shadow.items["openclaw/gogcli#631"];
  shadow.items["openclaw/gogcli#632"] = rollbackItem;
  storage.rawPut("exact-review-queue", shadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 2);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#632"]);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review claim preserves its immutable decision across a newer enqueue", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(620);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#620": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const newer = buildExactReviewQueueRequest(
    "newer-620",
    620,
    "edited",
    "pull_request",
    "openclaw/openclaw",
  );
  assert.equal((await queue.fetch(newer)).status, 202);

  const claim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        run_id: "6200",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), {
    ok: true,
    claimed: true,
    protocol_version: 2,
    item_key: "openclaw/openclaw#620",
    lease_revision: 1,
    claim_generation: 1,
    decision: item.leaseDecision,
  });

  const claimedState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        revision: number;
        decision: { sourceAction: string; itemKind: string };
        leaseDecision: { sourceAction: string; itemKind: string };
      }
    >;
  };
  assert.equal(claimedState.items["openclaw/openclaw#620"].revision, 2);
  assert.deepEqual(claimedState.items["openclaw/openclaw#620"].decision, {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 620,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "edited",
    supersedesInProgress: true,
  });
  assert.deepEqual(claimedState.items["openclaw/openclaw#620"].leaseDecision, item.leaseDecision);

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6200",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), { ok: true, requeued: true });

  const requeued = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(requeued.items["openclaw/openclaw#620"].state, "pending");
  assert.equal(requeued.items["openclaw/openclaw#620"].revision, 2);
  assert.equal(
    (requeued.items["openclaw/openclaw#620"].decision as { sourceAction: string }).sourceAction,
    "edited",
  );
  assert.equal(requeued.items["openclaw/openclaw#620"].leaseDecision, undefined);
});

test("new exact-review queue serves legacy workflow claims during rolling deploys", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(624);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#624": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "newer-624",
          624,
          "edited",
          "pull_request",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const legacyClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        run_id: "6240",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(legacyClaim.status, 200);
  assert.deepEqual(await legacyClaim.json(), {
    ok: true,
    claimed: true,
    protocol_version: 1,
    item_key: "openclaw/openclaw#624",
    revision: 1,
    lease_revision: 1,
    claim_generation: 1,
    decision: item.leaseDecision,
  });

  const strictCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        item_key: "openclaw/openclaw#624",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6240",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(strictCompletion.status, 409);
  assert.deepEqual(await strictCompletion.json(), { error: "lease_protocol_not_claimed" });

  const legacyCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        run_id: "6240",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(legacyCompletion.status, 200);
  assert.deepEqual(await legacyCompletion.json(), { ok: true, requeued: true });
  const requeued = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(requeued.items["openclaw/openclaw#624"].state, "pending");
  assert.equal(requeued.items["openclaw/openclaw#624"].claimProtocolVersion, undefined);
  assert.equal(
    (requeued.items["openclaw/openclaw#624"].decision as { sourceAction: string }).sourceAction,
    "edited",
  );
});

test("exact-review claims advance generations only for newer run attempts", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#621": unclaimedExactReviewQueueItem(621) },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const claim = (runAttempt?: number) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-621",
          item_key: "openclaw/openclaw#621",
          lease_revision: 1,
          run_id: "6210",
          ...(runAttempt === undefined ? {} : { run_attempt: runAttempt }),
        }),
      }),
    );

  const first = await claim(1);
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  assert.equal(firstPayload.claim_generation, 1);
  assert.equal(firstPayload.lease_revision, 1);

  const beforeReplay = (await storage.get("exact-review-queue")) as {
    items: Record<string, { leaseExpiresAt: number }>;
  };
  beforeReplay.items["openclaw/openclaw#621"].leaseExpiresAt = Date.now() + 1_000;
  await storage.put("exact-review-queue", beforeReplay);

  const replay = await claim(1);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstPayload);
  const afterReplay = (await storage.get("exact-review-queue")) as typeof beforeReplay;
  assert.ok(afterReplay.items["openclaw/openclaw#621"].leaseExpiresAt - Date.now() > 120 * 60_000);

  const nextAttempt = await claim(2);
  assert.equal(nextAttempt.status, 200);
  assert.equal((await nextAttempt.json()).claim_generation, 2);
  const latestState = structuredClone(await storage.get("exact-review-queue"));

  const staleAttempt = await claim(1);
  assert.equal(staleAttempt.status, 409);
  assert.deepEqual(await staleAttempt.json(), { error: "stale_run_attempt" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);

  const missingAttempt = await claim();
  assert.equal(missingAttempt.status, 409);
  assert.deepEqual(await missingAttempt.json(), { error: "missing_run_attempt" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);

  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-621",
        item_key: "openclaw/openclaw#621",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6210",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );
  assert.equal(staleCompletion.status, 409);
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);
});

test("exact-review claim upgrades a legacy same-attempt generation", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(622);
  item.state = "leased";
  item.claimedRunId = "6220";
  item.claimedRunAttempt = 1;
  item.leaseDecision = structuredClone(item.decision);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#622": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-622",
        item_key: "openclaw/openclaw#622",
        lease_revision: 1,
        run_id: "6220",
        run_attempt: 1,
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).claim_generation, 1);
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { claimGeneration?: number }>;
  };
  assert.equal(stored.items["openclaw/openclaw#622"].claimGeneration, 1);
});

test("exact-review claim and completion reject forged or incomplete lease tuples", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#622": unclaimedExactReviewQueueItem(622),
      "openclaw/openclaw#623": unclaimedExactReviewQueueItem(623),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const claimBase = {
    lease_id: "lease-622",
    item_key: "openclaw/openclaw#622",
    lease_revision: 1,
    run_id: "6220",
    run_attempt: 1,
  };
  const initialState = structuredClone(await storage.get("exact-review-queue"));
  const invalidClaims = [
    { body: { ...claimBase, item_key: undefined }, status: 400 },
    { body: { ...claimBase, lease_revision: undefined }, status: 400 },
    { body: { ...claimBase, item_key: "openclaw/openclaw#623" }, status: 409 },
    { body: { ...claimBase, lease_revision: 2 }, status: 409 },
    {
      body: {
        ...claimBase,
        lease_id: "lease-623",
        item_key: "openclaw/openclaw#622",
      },
      status: 409,
    },
  ];
  for (const candidate of invalidClaims) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify(candidate.body),
      }),
    );
    assert.equal(response.status, candidate.status);
    assert.deepEqual(await storage.get("exact-review-queue"), initialState);
  }

  const validClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify(claimBase),
    }),
  );
  assert.equal(validClaim.status, 200);
  assert.equal((await validClaim.json()).claim_generation, 1);

  const completeBase = {
    ...claimBase,
    claim_generation: 1,
    outcome: "failure",
  };
  const claimedState = structuredClone(await storage.get("exact-review-queue"));
  const invalidCompletions = [
    { body: { ...completeBase, item_key: undefined }, status: 400 },
    { body: { ...completeBase, item_key: "openclaw/openclaw#623" }, status: 409 },
    { body: { ...completeBase, lease_revision: undefined }, status: 400 },
    { body: { ...completeBase, lease_revision: 2 }, status: 409 },
    { body: { ...completeBase, claim_generation: undefined }, status: 400 },
    { body: { ...completeBase, claim_generation: 2 }, status: 409 },
  ];
  for (const candidate of invalidCompletions) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify(candidate.body),
      }),
    );
    assert.equal(response.status, candidate.status);
    assert.deepEqual(await storage.get("exact-review-queue"), claimedState);
  }
});

test("exact-review queue admits at most one active item per target repository", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return jsonResponse({ state: "active" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "2",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "1",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-1", 601, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-2", 602, "opened"));
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-b-1",
        603,
        "opened",
        "issue",
        "openclaw/openclaw",
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-c-1",
        604,
        "opened",
        "issue",
        "openclaw/clawsweeper",
      ),
    );

    await queue.alarm();
    assert.equal(dispatched.length, 2);
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const targets = dispatched.map((payload) =>
      String((payload.client_payload as Record<string, unknown>).target_repo),
    );
    assert.equal(new Set(targets).size, 2);
    assert.equal(targets.filter((target) => target === "openclaw/gogcli").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue can use the global capacity for one target", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    for (const itemNumber of [701, 702, 703, 704]) {
      await queue.fetch(
        buildExactReviewQueueRequest(`delivery-${itemNumber}`, itemNumber, "opened"),
      );
    }

    await queue.alarm();

    assert.equal(dispatched.length, 4);
    assert.equal(
      new Set(
        dispatched.map(
          (payload) => (payload.client_payload as Record<string, unknown>).target_repo,
        ),
      ).size,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue keeps publication artifacts durable outside review capacity", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse(Object.fromEntries([["token", "t"]]));
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:100:1",
        801,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(801, "100"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:101:1",
        802,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(802, "101"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:102:1",
        803,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(803, "102"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:103:1",
        804,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(804, "103", "failed_review_shard_recovery"),
      ),
    );
    await queue.fetch(buildExactReviewQueueRequest("ordinary-801", 801, "edited"));
    await queue.fetch(buildExactReviewQueueRequest("ordinary-803", 803, "edited"));

    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          createdAt: number;
          decision: Record<string, unknown>;
          dispatchedAt?: number;
          leaseDecision?: Record<string, unknown>;
          leaseExpiresAt?: number;
          leaseId?: string;
          leaseRevision?: number;
          nextAttemptAt: number;
          revision: number;
          state: string;
        }
      >;
    };
    assert.deepEqual(Object.keys(state.items).sort(), [
      "openclaw/gogcli#801",
      "openclaw/gogcli#801@publish:100:1",
      "openclaw/gogcli#802@publish:101:1",
      "openclaw/gogcli#803",
      "openclaw/gogcli#803@publish:102:1",
      "openclaw/gogcli#804@publish:103:1",
    ]);
    state.items["openclaw/gogcli#802@publish:101:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#802@publish:101:1"].nextAttemptAt = Date.now() - 1;
    state.items["openclaw/gogcli#803@publish:102:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#803@publish:102:1"].nextAttemptAt = Date.now() - 1;
    state.items["openclaw/gogcli#804@publish:103:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#804@publish:103:1"].nextAttemptAt = Date.now() - 1;
    const activeFreshReview = state.items["openclaw/gogcli#803"];
    activeFreshReview.state = "leased";
    activeFreshReview.decision = {
      ...activeFreshReview.decision,
      additionalPrompt: "newer maintainer context",
    };
    activeFreshReview.revision = 4;
    activeFreshReview.leaseId = "lease-fresh-803";
    activeFreshReview.leaseRevision = 4;
    activeFreshReview.leaseDecision = { ...activeFreshReview.decision };
    activeFreshReview.leaseExpiresAt = Date.now() + 60_000;
    const activeFreshReviewBeforeExpiry = structuredClone(activeFreshReview);
    await storage.put("exact-review-queue", state);

    await queue.alarm();
    const sourceActions = dispatched.map((payload) =>
      String((payload.client_payload as Record<string, unknown>).source_action),
    );
    assert.equal(
      sourceActions.filter((action) => action === "exact_review_artifact_publish").length,
      1,
    );
    assert.equal(sourceActions.filter((action) => action === "edited").length, 1);
    assert.equal(
      sourceActions.filter((action) => action === "artifact_retention_recovery").length,
      1,
    );
    assert.equal(
      sourceActions.filter((action) => action === "failed_review_shard_recovery").length,
      1,
    );
    assert.equal(
      dispatched.some(
        (payload) =>
          Number((payload.client_payload as Record<string, unknown>).item_number) === 803,
      ),
      false,
    );
    const afterExpiry = (await storage.get("exact-review-queue")) as typeof state;
    assert.deepEqual(afterExpiry.items["openclaw/gogcli#803"], activeFreshReviewBeforeExpiry);
    assert.equal(afterExpiry.items["openclaw/gogcli#803@publish:102:1"], undefined);
    const reservedPublisher = afterExpiry.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(reservedPublisher.state, "dispatching");
    assert.ok((reservedPublisher.leaseExpiresAt ?? 0) - Date.now() > 14 * 60_000);
    assert.ok((reservedPublisher.leaseExpiresAt ?? 0) - Date.now() <= 15 * 60_000);
    const publicationPayload = dispatched.find(
      (payload) =>
        (payload.client_payload as Record<string, unknown>).source_action ===
        "exact_review_artifact_publish",
    )?.client_payload as Record<string, unknown>;
    assert.match(
      String((publicationPayload.queue_claim as Record<string, unknown>).item_key),
      /@publish:/,
    );
    assert.ok(
      (
        (publicationPayload.review_options as Record<string, unknown>).publication as Record<
          string,
          unknown
        >
      ).producerDecision,
    );

    const firstPublicationLease = {
      leaseId: reservedPublisher.leaseId,
      leaseRevision: reservedPublisher.leaseRevision,
    };
    reservedPublisher.dispatchedAt = Date.now() - 16 * 60_000;
    reservedPublisher.leaseExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    await storage.put("exact-review-queue", afterExpiry);

    let queueMaintenance: Promise<unknown> | undefined;
    await worker.scheduled(
      {},
      { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
      { waitUntil: (promise) => (queueMaintenance = promise) },
    );
    await queueMaintenance;
    const afterScheduledMaintenance = (await storage.get("exact-review-queue")) as typeof state;
    const scheduledPublisher = afterScheduledMaintenance.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(scheduledPublisher.state, "pending");
    assert.equal(scheduledPublisher.leaseId, undefined);
    assert.ok(((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) <= Date.now() + 1_000);

    await queue.alarm();
    const afterScheduledRedispatch = (await storage.get("exact-review-queue")) as typeof state;
    const scheduledRedispatch = afterScheduledRedispatch.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(scheduledRedispatch.state, "dispatching");
    assert.notEqual(scheduledRedispatch.leaseId, firstPublicationLease.leaseId);
    assert.equal(
      dispatched.filter(
        (payload) =>
          (payload.client_payload as Record<string, unknown>).source_action ===
          "exact_review_artifact_publish",
      ).length,
      2,
    );

    const scheduledPublicationLease = {
      leaseId: scheduledRedispatch.leaseId,
      leaseRevision: scheduledRedispatch.leaseRevision,
    };
    scheduledRedispatch.dispatchedAt = Date.now() - 16 * 60_000;
    scheduledRedispatch.leaseExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    await storage.put("exact-review-queue", afterScheduledRedispatch);

    const expiredLegacyClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: scheduledPublicationLease.leaseId,
          item_key: "openclaw/gogcli#801@publish:100:1",
          lease_revision: scheduledPublicationLease.leaseRevision,
          run_id: "999998",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(expiredLegacyClaim.status, 409);
    assert.deepEqual(await expiredLegacyClaim.json(), { error: "lease_not_active" });
    const afterExpiredClaim = (await storage.get("exact-review-queue")) as typeof state;
    const reclaimedPublisher = afterExpiredClaim.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(reclaimedPublisher.state, "pending");
    assert.equal(reclaimedPublisher.leaseId, undefined);
    assert.ok(((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) <= Date.now() + 1_000);

    await queue.alarm();

    const publicationDispatches = dispatched.filter(
      (payload) =>
        (payload.client_payload as Record<string, unknown>).source_action ===
        "exact_review_artifact_publish",
    );
    assert.equal(publicationDispatches.length, 3);
    const afterRedispatch = (await storage.get("exact-review-queue")) as typeof state;
    const redispatchedPublisher = afterRedispatch.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(redispatchedPublisher.state, "dispatching");
    assert.notEqual(redispatchedPublisher.leaseId, scheduledPublicationLease.leaseId);
    assert.ok((redispatchedPublisher.leaseExpiresAt ?? 0) - Date.now() > 14 * 60_000);
    const staleClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: firstPublicationLease.leaseId,
          item_key: "openclaw/gogcli#801@publish:100:1",
          lease_revision: firstPublicationLease.leaseRevision,
          run_id: "999999",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(staleClaim.status, 409);
    assert.deepEqual(await staleClaim.json(), { error: "lease_not_active" });
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 4);
    assert.equal(stats.lanes.publication.enqueued_total, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue wakes while target capacity remains", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-801", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-802", 802, "opened"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= Date.now() + 5_000);

    await queue.alarm();
    assert.equal(dispatched.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue defers retained backlog until a paused dispatcher retry", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-a", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-b", 802, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-c", 803, "opened"));

    const state = (await storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
      items: Record<string, { leaseExpiresAt?: number; nextAttemptAt: number }>;
    };
    const leaseExpiresAt = Date.now() + 60_000;
    const retryAt = Date.now() + 15 * 60_000;
    const retainedAttemptAt = Date.now() - 1;
    state.dispatcher = {
      state: "paused",
      reason: "workflow_not_active",
      checkedAt: Date.now(),
      retryAt,
    };
    state.items["openclaw/gogcli#801"].leaseExpiresAt = leaseExpiresAt;
    state.items["openclaw/gogcli#802"].nextAttemptAt = retryAt;
    state.items["openclaw/gogcli#803"].nextAttemptAt = retainedAttemptAt;
    await storage.put("exact-review-queue", state);
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= leaseExpiresAt);

    // Emulate a pre-pause alarm that remains scheduled for an active lease,
    // then fires before the paused dispatcher's retry deadline.
    state.items["openclaw/gogcli#801"].leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", state);
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    const after = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(after.items["openclaw/gogcli#802"].nextAttemptAt, retryAt);
    assert.equal(after.items["openclaw/gogcli#803"].nextAttemptAt, retainedAttemptAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("state append is idempotent by delivery and reports bounded-window stats", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const payload = {
    delivery_id: "state-delivery-1",
    records: [
      {
        kind: "sweep_status",
        key: "openclaw/openclaw:sweep",
        payload: { run_id: "123", status: "completed" },
        produced_at: "2026-07-20T12:00:00.000Z",
      },
      {
        kind: "comment_router",
        key: "openclaw/openclaw#738",
        payload: { comment_id: 456 },
        produced_at: "2026-07-20T12:01:00.000Z",
      },
    ],
  };

  const first = await queue.fetch(stateAppendQueueRequest("/state/append", payload));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    ok: true,
    appended: 2,
    first_seq: 1,
    last_seq: 2,
  });
  const duplicate = await queue.fetch(stateAppendQueueRequest("/state/append", payload));
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { ok: true, deduped: true });

  const invalid = await queue.fetch(
    stateAppendQueueRequest("/state/append", {
      delivery_id: "state-delivery-invalid",
      records: [{ ...payload.records[0], kind: "unknown" }],
    }),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_state_append_kind" });

  const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.deepEqual(stats.state_append, {
    pending_rows: 2,
    pending_bytes:
      Buffer.byteLength(JSON.stringify(payload.records[0].payload)) +
      Buffer.byteLength(JSON.stringify(payload.records[1].payload)),
    oldest_produced_at: "2026-07-20T12:00:00.000Z",
    sheds_since_reset: 0,
    delivery_receipts: 1,
    max_pending_rows: 50_000,
    max_pending_bytes: 100 * 1024 * 1024,
  });
});

test("state append sheds atomically at the configured cap without consuming its receipt", async () => {
  const queue = new ExactReviewQueue(
    { storage: new MemoryDurableStorage() },
    { STATE_APPEND_MAX_PENDING_ROWS: "1" },
  );
  const firstPayload = stateAppendPayload("state-cap-first", "sweep_status", "first");
  const shedPayload = stateAppendPayload("state-cap-retry", "apply_proof", "second");
  assert.equal(
    (await queue.fetch(stateAppendQueueRequest("/state/append", firstPayload))).status,
    202,
  );

  const shed = await queue.fetch(stateAppendQueueRequest("/state/append", shedPayload));
  assert.equal(shed.status, 429);
  assert.deepEqual(await shed.json(), { ok: false, shed: true, reason: "capacity" });
  let stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.state_append.pending_rows, 1);
  assert.equal(stats.state_append.sheds_since_reset, 1);
  assert.equal(stats.state_append.delivery_receipts, 1);

  const drained = await (
    await queue.fetch(stateAppendQueueRequest("/state/drain", { max_rows: 1, max_bytes: 1024 }))
  ).json();
  const acked = await queue.fetch(
    stateAppendQueueRequest("/state/ack", { drain_token: drained.drain_token }),
  );
  assert.deepEqual(await acked.json(), { ok: true, acked: 1 });

  const retried = await queue.fetch(stateAppendQueueRequest("/state/append", shedPayload));
  assert.equal(retried.status, 202);
  assert.equal((await retried.json()).appended, 1);
  stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.state_append.pending_rows, 1);
  assert.equal(stats.state_append.delivery_receipts, 2);
});

test("state drain replays its active batch and deletes rows only after ack", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const payload = {
    delivery_id: "state-drain",
    records: [
      stateAppendRecord("sweep_status", "one", { n: 1 }),
      stateAppendRecord("comment_router", "two", { n: 2 }),
      stateAppendRecord("apply_proof", "three", { n: 3 }),
    ],
  };
  await queue.fetch(stateAppendQueueRequest("/state/append", payload));

  const first = await (
    await queue.fetch(stateAppendQueueRequest("/state/drain", { max_rows: 2, max_bytes: 1024 }))
  ).json();
  assert.equal(typeof first.drain_token, "string");
  assert.deepEqual(
    first.records.map((record) => [record.seq, record.kind, record.key, record.payload]),
    [
      [1, "sweep_status", "one", { n: 1 }],
      [2, "comment_router", "two", { n: 2 }],
    ],
  );

  const replay = await (
    await queue.fetch(stateAppendQueueRequest("/state/drain", { max_rows: 1, max_bytes: 1 }))
  ).json();
  assert.equal(replay.drain_token, first.drain_token);
  assert.deepEqual(replay.records, first.records);
  let stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.state_append.pending_rows, 3);

  const ack = await queue.fetch(
    stateAppendQueueRequest("/state/ack", { drain_token: first.drain_token }),
  );
  assert.deepEqual(await ack.json(), { ok: true, acked: 2 });
  const repeatedAck = await queue.fetch(
    stateAppendQueueRequest("/state/ack", { drain_token: first.drain_token }),
  );
  assert.deepEqual(await repeatedAck.json(), { ok: true, acked: 0 });

  const next = await (
    await queue.fetch(stateAppendQueueRequest("/state/drain", { max_rows: 10, max_bytes: 1024 }))
  ).json();
  assert.notEqual(next.drain_token, first.drain_token);
  assert.deepEqual(
    next.records.map((record) => record.seq),
    [3],
  );
  stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  assert.equal(stats.state_append.pending_rows, 1);
});

test("expired state drain leases make the same rows available under a new token", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-20T12:00:00.000Z");
  Date.now = () => now;
  try {
    const queue = new ExactReviewQueue(
      { storage: new MemoryDurableStorage() },
      { STATE_APPEND_DRAIN_LEASE_MS: "1000" },
    );
    await queue.fetch(
      stateAppendQueueRequest(
        "/state/append",
        stateAppendPayload("state-expiry", "apply_proof", "proof"),
      ),
    );
    const first = await (
      await queue.fetch(stateAppendQueueRequest("/state/drain", { max_rows: 1, max_bytes: 1024 }))
    ).json();
    now += 1_001;
    const redrained = await (
      await queue.fetch(stateAppendQueueRequest("/state/drain", { max_rows: 1, max_bytes: 1024 }))
    ).json();
    assert.notEqual(redrained.drain_token, first.drain_token);
    assert.deepEqual(redrained.records, first.records);

    const staleAck = await queue.fetch(
      stateAppendQueueRequest("/state/ack", { drain_token: first.drain_token }),
    );
    assert.deepEqual(await staleAck.json(), { ok: true, acked: 0 });
    const activeAck = await queue.fetch(
      stateAppendQueueRequest("/state/ack", { drain_token: redrained.drain_token }),
    );
    assert.deepEqual(await activeAck.json(), { ok: true, acked: 1 });
  } finally {
    Date.now = originalNow;
  }
});

test("internal state endpoints reject invalid HMAC signatures", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = stateAppendPayload("state-auth", "sweep_status", "auth");
  const unsigned = await worker.fetch(
    stateAppendQueueRequest("/internal/state/append", payload, "https://clawsweeper.openclaw.ai"),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  const signed = await worker.fetch(
    signedStateAppendRequest("/internal/state/append", payload, "test-secret"),
    env,
  );
  assert.equal(signed.status, 202);
  assert.equal((await signed.json()).appended, 1);
});

test("internal state writer routes authenticate and preserve durable ticket identity", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-clawsweeper-webhook-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const acquire = {
    ticket_id: "state-writer:test-route",
    owner: "11111111-1111-4111-8111-111111111111",
    branch: "state",
    repository: "openclaw/clawsweeper-state",
    workflow: "State materializer",
    job: "materialize",
    run_id: "12345",
    run_attempt: 1,
    writer_class: "ordinary",
  };

  const unsigned = await worker.fetch(
    stateAppendQueueRequest(
      "/internal/state-writer/acquire",
      acquire,
      "https://clawsweeper.openclaw.ai",
    ),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  const invalid = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      { ...acquire, ticket_id: "state-writer:invalid", workflow: "bad\u0000metadata" },
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_state_writer_ticket" });

  const acquiredResponse = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      acquire,
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(acquiredResponse.status, 200);
  const acquired = (await acquiredResponse.json()) as {
    ok: boolean;
    ticket: { ticketId: string; owner: string; leaseToken: string; state: string };
  };
  assert.equal(acquired.ok, true);
  assert.equal(acquired.ticket.ticketId, acquire.ticket_id);
  assert.equal(acquired.ticket.owner, acquire.owner);
  assert.equal(acquired.ticket.state, "leased");

  const legacyTicket = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      {
        ...acquire,
        ticket_id: "state-writer:legacy-route",
        owner: "22222222-2222-4222-8222-222222222222",
        writer_class: undefined,
      },
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(legacyTicket.status, 200, "rolling-deploy clients default to ordinary admission");

  const ownership = {
    ticket_id: acquired.ticket.ticketId,
    owner: acquired.ticket.owner,
    ["lease_token"]: acquired.ticket.leaseToken,
  };
  const heartbeat = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/heartbeat",
      ownership,
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(heartbeat.status, 200);
  assert.equal(((await heartbeat.json()) as { ticket: { state: string } }).ticket.state, "leased");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const release = await worker.fetch(
      signedStateAppendRequest(
        "/internal/state-writer/release",
        ownership,
        "test-clawsweeper-webhook-secret",
      ),
      env,
    );
    assert.equal(release.status, 200);
    assert.deepEqual(await release.json(), { ok: true, released: true });
  }
  const stats = (await (await queue.fetch(new Request("https://queue/stats"))).json()) as {
    state_writer: { coordinator: { completed: number; active: unknown } };
  };
  assert.equal(stats.state_writer.coordinator.completed, 1);
  assert.equal(stats.state_writer.coordinator.active, null);
});

test("authenticated legacy exact-review intake enters the durable queue", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const payload = JSON.stringify({
    delivery_id: "legacy:100:1",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 597,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
      commandStatusMarker,
      statusCommentId: "9001",
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
  });
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: Record<string, unknown> }>;
  };
  assert.deepEqual(
    {
      commandStatusMarker: stored.items["openclaw/gogcli#597"].decision.commandStatusMarker,
      statusCommentId: stored.items["openclaw/gogcli#597"].decision.statusCommentId,
      additionalPrompt: stored.items["openclaw/gogcli#597"].decision.additionalPrompt,
    },
    {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  );

  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(denied.status, 401);
});

test("exact-review queue rejects unbounded or unsafe command context", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const invalidDecisions = [
    {
      commandStatusMarker: "<!-- clawsweeper-command-status:597:re_review:na -->\nextra",
    },
    { statusCommentId: Number.MAX_SAFE_INTEGER + 1 },
    { additionalPrompt: "x".repeat(5001) },
    { additionalPrompt: "unsafe\0prompt" },
  ];

  for (const [index, decision] of invalidDecisions.entries()) {
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        `invalid-command-context-${index}`,
        597,
        "legacy_dispatch",
        "issue",
        undefined,
        decision,
      ),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_exact_review_item" });
  }

  const reservedDelivery = await queue.fetch(
    buildExactReviewQueueRequest("__clawsweeper_sql_generation:99", 597, "opened"),
  );
  assert.equal(reservedDelivery.status, 400);
  assert.deepEqual(await reservedDelivery.json(), { error: "reserved_delivery_id" });
});

test("exact-review queue retries dispatch failures and reclaims an unclaimed lease", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchAttempts = 0;
  let workflowStatusAvailable = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      if (!workflowStatusAvailable) {
        return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
          status: 503,
        });
      }
      return jsonResponse({ state: "active" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-1", 599, "opened"))).status,
      202,
    );

    await queue.alarm();
    let state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "workflow_status_unavailable");
    assert.equal(dispatchAttempts, 0);

    const stored = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    workflowStatusAvailable = true;
    stored.dispatcher.retryAt = Date.now() - 1;
    stored.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", stored);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "active");
    assert.equal(dispatchAttempts, 1);

    const retried = (await storage.get("exact-review-queue")) as {
      items: Record<string, { nextAttemptAt: number }>;
    };
    retried.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", retried);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );

    const leased = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseExpiresAt: number; leaseId: string; leaseRevision: number }>;
    };
    const firstLease = leased.items["openclaw/gogcli#599"];
    assert.ok(firstLease.leaseExpiresAt - Date.now() > 350_000);
    assert.ok(firstLease.leaseExpiresAt - Date.now() <= 360_000);
    firstLease.leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", leased);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );
    assert.equal(dispatchAttempts, 3);
    const staleClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: firstLease.leaseId,
          item_key: "openclaw/gogcli#599",
          lease_revision: firstLease.leaseRevision,
          run_id: "5990",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(staleClaim.status, 409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue preserves a claimed lease after an ambiguous dispatch failure", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let signalDispatchStarted!: () => void;
  let releaseDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    signalDispatchStarted = resolve;
  });
  const dispatchRelease = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (url.pathname === "/repos/openclaw/clawsweeper/installation")
      return jsonResponse({ id: 999 });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "t" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      signalDispatchStarted();
      await dispatchRelease;
      return new Response(JSON.stringify({ message: "gateway timeout" }), { status: 504 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("ambiguous-dispatch", 601, "opened"))).status,
      202,
    );

    const alarm = queue.alarm();
    await dispatchStarted;
    const dispatching = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const dispatchingItem = dispatching.items["openclaw/gogcli#601"];
    const leaseId = dispatchingItem.leaseId;
    const claim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: dispatchingItem.leaseRevision,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claim.status, 200);
    releaseDispatch();
    await alarm;

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: stats.pending, dispatching: stats.dispatching, leased: stats.leased },
      { pending: 0, dispatching: 0, leased: 1 },
    );
    const completed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: dispatchingItem.leaseRevision,
          claim_generation: 1,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });
    const released = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(released.leased, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue requeues a cancelled claimed lease", async () => {
  const storage = new MemoryDurableStorage();
  const completedAfter = Date.now();
  const retryAt = completedAfter + 10_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    dispatcher: {
      state: "paused",
      reason: "workflow_not_active",
      workflowState: "disabled_manually",
      checkedAt: Date.now(),
      retryAt,
    },
    items: {
      "openclaw/openclaw#710": leasedExactReviewQueueItem(710, "7100"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-710",
        item_key: "openclaw/openclaw#710",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7100",
        run_attempt: 1,
        outcome: "cancelled",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#710"].state, "pending");
  assert.ok(Number(state.items["openclaw/openclaw#710"].nextAttemptAt) >= completedAfter + 30_000);
  assert.ok(Number(state.items["openclaw/openclaw#710"].nextAttemptAt) > retryAt);
  assert.equal(state.items["openclaw/openclaw#710"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#710"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimedRunId, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimedRunAttempt, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimGeneration, undefined);
});

test("exact-review publication capacity backs off on GitHub pressure and recovers gradually", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-16T08:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const rateLimited = leasedExactReviewPublicationItem(720, "7200");
    await storage.put("exact-review-queue", {
      deliveries: {},
      items: { [rateLimited.key]: rateLimited },
    });
    const queue = new ExactReviewQueue({ storage }, {});
    const complete = (
      item: ReturnType<typeof leasedExactReviewPublicationItem>,
      outcome: "success" | "failure",
      failureKind?: "github_rate_limit" | "github_transient",
    ) =>
      queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: item.leaseId,
            item_key: item.key,
            lease_revision: item.leaseRevision,
            claim_generation: item.claimGeneration,
            run_id: item.claimedRunId,
            run_attempt: item.claimedRunAttempt,
            outcome,
            ...(failureKind ? { failure_kind: failureKind } : {}),
          }),
        }),
      );

    storage.failNextPut("exact-review-publication-control:v1");
    await assert.rejects(
      complete(rateLimited, "failure", "github_rate_limit"),
      /injected storage put failure/,
    );
    let preserved = (await storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(preserved.items[rateLimited.key]);
    assert.equal((await complete(rateLimited, "failure", "github_rate_limit")).status, 200);
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(stats.lanes.publication.capacity_control, {
      mode: "throttled",
      minimum: 4,
      base: 24,
      maximum: 48,
      ceiling: 12,
      demand_capacity: 24,
      demand_samples: 1,
      demand_tier: 0,
      last_scale_at: null,
      cooldown_until: "2026-07-16T08:15:00.000Z",
      recovery_successes: 0,
      last_failure_at: "2026-07-16T08:00:00.000Z",
      last_failure_kind: "github_rate_limit",
    });

    const state = (await storage.get("exact-review-queue")) as {
      deliveries: Record<string, number>;
      items: Record<string, ReturnType<typeof leasedExactReviewPublicationItem>>;
    };
    // One ceiling step per DEFAULT_EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES
    // (10) consecutive clean publications.
    const recovered = Array.from({ length: 10 }, (_, index) =>
      leasedExactReviewPublicationItem(721 + index, String(7210 + index)),
    );
    for (const item of recovered) state.items[item.key] = item;
    await storage.put("exact-review-queue", state);
    now += 15 * 60_000;
    for (const item of recovered) {
      assert.equal((await complete(item, "success")).status, 200);
    }

    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 20);
    assert.equal(stats.lanes.publication.capacity_control.recovery_successes, 0);

    const transient = leasedExactReviewPublicationItem(780, "7800");
    const latest = (await storage.get("exact-review-queue")) as typeof state;
    latest.items[transient.key] = transient;
    await storage.put("exact-review-queue", latest);
    assert.equal((await complete(transient, "failure", "github_transient")).status, 200);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
    assert.equal(
      stats.lanes.publication.capacity_control.cooldown_until,
      "2026-07-16T08:20:00.000Z",
    );
    assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, "github_transient");
    preserved = (await storage.get("exact-review-queue")) as typeof preserved;
    assert.ok(preserved.items[rateLimited.key]);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review publication retries a state fetch timeout without throttling capacity", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7801, "78010");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "github_transient",
        error_fingerprint: "sha256:state-fetch-timeout",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; lastFailureReason?: string }>;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "github_transient");

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication gives state contention the transient retry budget", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7803, "78030");
  item.publicationFailureAttempts = 4;
  item.firstFailureAt = Date.now() - 30 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "state_contention",
        error_fingerprint: "sha256:state-publish-contention",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; lastFailureReason?: string; publicationFailureAttempts?: number }
    >;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "state_contention");
  assert.equal(state.items[item.key]?.publicationFailureAttempts, 5);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication defers an active review lease without throttling capacity", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7802, "78020");
  const retryAt = Date.now() + 12 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "retryable_failure",
        reason_code: "review_lease_active",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; lastFailureReason?: string; nextAttemptAt?: number }>;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "review_lease_active");
  assert.ok(Number(state.items[item.key]?.nextAttemptAt) >= retryAt);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication supersedes stale tuples without counting a publish", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(781, "7810");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "superseded",
        reason_code: "remote_newer_tuple",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as { items: Record<string, unknown> };
  assert.equal(state.items[item.key], undefined);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.completed_total, 1);
  assert.equal(stats.lanes.publication.published_total, 0);
  assert.equal(stats.lanes.publication.superseded_total, 1);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.published_rate_per_hour, 0);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.superseded_rate_per_hour, 4);
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication dead-letters exhausted permanent failures and replays idempotently", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(782, "7820");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:deadbeef",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters.length, 1);
  assert.equal(listed.dead_letters[0].reason_code, "invalid_artifact");
  assert.equal(listed.dead_letters[0].attempts, 3);
  const id = listed.dead_letters[0].dead_letter_id;

  const replay = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/replay", {
        method: "POST",
        body: JSON.stringify({ ids: [id], idempotency_key: "operator:782:v1" }),
      }),
    );
  assert.deepEqual(await (await replay()).json(), {
    ok: true,
    replayed: 1,
    deduped: 0,
    skipped: 0,
  });
  assert.deepEqual(await (await replay()).json(), {
    ok: true,
    replayed: 0,
    deduped: 1,
    skipped: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 0);
});

test("exact-review dead letters expose diagnostics and recover fresh reviews in bounded batches", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(792, "7920");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:fresh-recovery",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const row = listed.dead_letters[0];
  assert.equal(row.item.key, item.key);
  assert.deepEqual(row.diagnostic.reason_code, "invalid_artifact");
  assert.equal(row.diagnostic.attempts, 3);
  assert.equal(row.diagnostic.error_fingerprint, "sha256:fresh-recovery");
  assert.equal(typeof row.diagnostic.first_failed_at, "string");
  assert.equal(typeof row.diagnostic.last_failed_at, "string");
  assert.deepEqual(row.fresh_recovery, {
    mode: "fresh_review_only",
    eligible: true,
    reason: "eligible",
    item_key: "openclaw/openclaw#792",
  });

  const tooMany = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: Array.from({ length: 11 }, (_, index) => `dead-letter-${index}`),
        idempotency_key: "operator:792:too-many",
      }),
    }),
  );
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { error: "invalid_dead_letter_ids" });

  const recover = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
        method: "POST",
        body: JSON.stringify({ ids: [row.dead_letter_id], idempotency_key: "operator:792:v1" }),
      }),
    );
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 0,
    deduped: 1,
    skipped: 0,
    unparked: 0,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; state: string; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(state.items["openclaw/openclaw#792"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#792"].attempts, 0);
  assert.equal(
    state.items["openclaw/openclaw#792"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(Object.hasOwn(state.items["openclaw/openclaw#792"].decision, "publication"), false);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.arrival, 1);

  const resolved = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10, status: "all" }),
      }),
    )
  ).json();
  assert.equal(resolved.dead_letters[0].status, "resolved");
  assert.equal(resolved.dead_letters[0].resolution_note, "recovered_fresh");
  assert.equal(resolved.dead_letters[0].replay_key, "operator:792:v1");
  assert.equal(resolved.dead_letters[0].fresh_recovery.reason, "fresh_review_already_active");
});

test("exact-review fresh recovery preserves failed-shard review-only behavior", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(794, "7940");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.decision.publication.producerDecision.sourceAction = "failed_review_shard_recovery";
  item.leaseDecision.publication.producerDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();

  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [listed.dead_letters[0].dead_letter_id],
        idempotency_key: "operator:794:v1",
      }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string } }>;
  };
  assert.equal(
    state.items["openclaw/openclaw#794"].decision.sourceAction,
    "failed_review_shard_recovery",
  );
});

test("exact-review fresh recovery leaves an active review item untouched", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(793, "7930");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;

  const enqueue = await queue.fetch(
    buildExactReviewQueueRequest(
      "fresh-recovery-guard",
      793,
      "opened",
      "issue",
      "openclaw/openclaw",
    ),
  );
  assert.equal(enqueue.status, 202);
  const before = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  const active = before.items["openclaw/openclaw#793"];
  assert.equal(active.state, "pending");
  assert.equal(active.decision.sourceAction, "opened");

  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({ ids: [id], idempotency_key: "operator:793:v1" }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });

  const after = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  assert.deepEqual(after.items["openclaw/openclaw#793"], active);
  const guarded = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(guarded.dead_letters[0].fresh_recovery.reason, "fresh_review_already_active");
});

test("exact-review publication refreshes an artifact after its third unavailable attempt", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(783, "7830");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "artifact_unavailable",
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#783"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.refreshed_total, 1);
});

test("exact-review publication completes a close-coverage deferral without refreshing", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7831, "78310");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "deferred",
        reason_code: "close_coverage_deferred",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(state.items["openclaw/openclaw#7831"], undefined);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.refreshed_total, 0);
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication accepts the legacy close-coverage refresh during rollout", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7832, "78320");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "refresh_required",
        reason_code: "close_coverage_retry",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#7832"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(state.items["openclaw/openclaw#7832"].decision.publication, undefined);
});

test("exact-review publication retry budgets ignore earlier dispatch failures", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(785, "7850");
  item.attempts = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; publicationFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].attempts, 1);
  assert.equal(state.items[item.key].publicationFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication retains one unknown completion for a current-workflow retry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7851, "78510");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "unknown_failure",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; publicationFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 1);
  assert.equal(state.items[item.key].publicationFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("ordinary exact-review retries do not increment publication retry telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(786, "7860");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.retried_total, 0);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.retried, 0);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retry_amplification, null);
});

test("exact-review completion rejects incompatible structured dispositions", async () => {
  const item = leasedExactReviewPublicationItem(784, "7840");
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "superseded",
        reason_code: "remote_closed",
      }),
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "completion_outcome_mismatch" });
});

test("exact-review publication recovery ignores successful source-drift requeues", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(790, "7900");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  await storage.put("exact-review-publication-control:v1", {
    capacityCeiling: 12,
    cooldownUntil: Date.now() - 1,
    recoverySuccesses: 49,
    lastFailureAt: Date.now() - 60_000,
    lastFailureKind: "github_rate_limit",
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        requeue_latest: true,
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
  assert.equal(stats.lanes.publication.capacity_control.recovery_successes, 49);
});

test("exact-review queue completes a failed shard recovery without a second retry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(710, "7101");
  item.decision.sourceAction = "failed_review_shard_recovery";
  item.leaseDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-710",
        item_key: "openclaw/openclaw#710",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7101",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(Object.keys(state.items).length, 0);
});

test("failed shard recovery does not replace an already-pending ordinary event", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("ordinary-event", 710, "edited"))).status,
    202,
  );
  const beforeRecovery = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; nextAttemptAt: number }>;
  };
  const ordinary = beforeRecovery.items["openclaw/gogcli#710"];
  ordinary.attempts = 1;
  ordinary.nextAttemptAt = Date.now() + 30_000;
  await storage.put("exact-review-queue", beforeRecovery);
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("failed-shard-recovery", 710, "failed_review_shard_recovery"),
      )
    ).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        attempts: number;
        nextAttemptAt: number;
        revision: number;
        decision: { sourceAction: string; supersedesInProgress: boolean };
      }
    >;
  };
  assert.equal(state.items["openclaw/gogcli#710"].decision.sourceAction, "edited");
  assert.equal(state.items["openclaw/gogcli#710"].decision.supersedesInProgress, true);
  assert.equal(state.items["openclaw/gogcli#710"].revision, 1);
  assert.equal(state.items["openclaw/gogcli#710"].attempts, 1);
  assert.equal(state.items["openclaw/gogcli#710"].nextAttemptAt, ordinary.nextAttemptAt);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("failed shard recovery does not replace an ordinary active lease", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#710": leasedExactReviewQueueItem(710, "7102"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-active-lease",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const beforeComplete = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        decision: { sourceAction: string };
        leaseDecision?: { sourceAction: string };
      }
    >;
  };
  const ordinary = beforeComplete.items["openclaw/openclaw#710"];
  assert.equal(ordinary.state, "leased");
  assert.equal(ordinary.revision, 1);
  assert.equal(ordinary.decision.sourceAction, "opened");
  assert.equal(ordinary.leaseDecision?.sourceAction, "opened");

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7102",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
  const afterComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(afterComplete.items["openclaw/openclaw#710"], undefined);
});

test("failed shard recovery does not replace an active recovery lease", async () => {
  const storage = new MemoryDurableStorage();
  const recovery = leasedExactReviewQueueItem(710, "7103");
  recovery.decision.sourceAction = "failed_review_shard_recovery";
  recovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": recovery },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-active-recovery",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const beforeComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  const activeRecovery = beforeComplete.items["openclaw/openclaw#710"];
  assert.equal(activeRecovery.state, "leased");
  assert.equal(activeRecovery.revision, 1);
  assert.equal(activeRecovery.decision.sourceAction, "failed_review_shard_recovery");

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7103",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
  const afterComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(afterComplete.items["openclaw/openclaw#710"], undefined);
});

test("failed shard recovery replaces an expired recovery lease", async () => {
  const storage = new MemoryDurableStorage();
  const expiredRecovery = leasedExactReviewQueueItem(710, "7104");
  expiredRecovery.decision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseExpiresAt = Date.now() - 1;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": expiredRecovery },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-expired-recovery",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; decision: { sourceAction: string }; leaseId?: string }
    >;
  };
  const replacement = state.items["openclaw/openclaw#710"];
  assert.equal(replacement.state, "pending");
  assert.equal(replacement.revision, 1);
  assert.equal(replacement.decision.sourceAction, "failed_review_shard_recovery");
  assert.equal(replacement.leaseId, undefined);
});

test("exact-review queue defers a coordination-held failure until the lease expires", async () => {
  const storage = new MemoryDurableStorage();
  const retryAt = Date.now() + 45 * 60_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#711": leasedExactReviewQueueItem(711, "7110"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-711",
        item_key: "openclaw/openclaw#711",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7110",
        run_attempt: 1,
        outcome: "failure",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.ok(Number(state.items["openclaw/openclaw#711"].nextAttemptAt) >= retryAt);
  assert.equal(state.items["openclaw/openclaw#711"].attempts, 1);
});

test("exact-review queue does not carry an old coordination deadline to a newer revision", async () => {
  const storage = new MemoryDurableStorage();
  const retryAt = Date.now() + 45 * 60_000;
  const item = leasedExactReviewQueueItem(712, "7120");
  item.revision = Number(item.leaseRevision) + 1;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#712": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-712",
        item_key: "openclaw/openclaw#712",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7120",
        run_attempt: 1,
        outcome: "failure",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.ok(Number(state.items["openclaw/openclaw#712"].nextAttemptAt) < retryAt);
});

test("exact-review queue rejects invalid coordination retry deadlines", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const retryAt of ["not-a-timestamp", new Date(Date.now() + 3 * 60 * 60_000).toISOString()]) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-712",
          item_key: "openclaw/openclaw#712",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7120",
          run_attempt: 1,
          outcome: "failure",
          retry_at: retryAt,
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_retry_at" });
  }
});

test("exact-review queue requeues a verified source drift exactly once without failure backoff", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "9113"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-713",
          item_key: "openclaw/openclaw#713",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "9113",
          run_attempt: 1,
          outcome: "success",
          requeue_latest: true,
        }),
      }),
    );

  const response = await complete();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#713"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#713"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#713"].revision, 1);
  assert.equal(state.items["openclaw/openclaw#713"].leaseId, undefined);
  assert.equal((await complete()).status, 409);
  const replayedState = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(Object.keys(replayedState.items).length, 1);
  assert.equal(replayedState.items["openclaw/openclaw#713"].state, "pending");
  const reconciled = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "9113",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 0,
    requeued: 0,
    completed: 0,
  });
  const reconciledState = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(reconciledState.items["openclaw/openclaw#713"].state, "pending");
});

test("exact-review success preserves an already-enqueued newer decision", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(714, "7140");
  item.revision = 2;
  item.decision.sourceAction = "edited";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#714": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-714",
        item_key: "openclaw/openclaw#714",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7140",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  assert.equal(Object.keys(state.items).length, 1);
  assert.equal(state.items["openclaw/openclaw#714"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#714"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#714"].decision.sourceAction, "edited");
});

test("exact-review queue rejects invalid source-drift requeue requests", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const body of [
    { outcome: "success", requeue_latest: "true" },
    { outcome: "failure", requeue_latest: true },
  ]) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-715",
          item_key: "openclaw/openclaw#715",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7150",
          run_attempt: 1,
          ...body,
        }),
      }),
    );
    assert.equal(response.status, 400);
  }
});

test("exact-review completion rejects stale owners and is race-idempotent", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#716": leasedExactReviewQueueItem(716, "9100", 2),
      "openclaw/openclaw#717": leasedExactReviewQueueItem(717, "9101", 1),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = (
    itemNumber: number,
    leaseId: string,
    runId: string,
    runAttempt: number,
    outcome: string,
  ) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: `openclaw/openclaw#${itemNumber}`,
          lease_revision: 1,
          claim_generation: 1,
          run_id: runId,
          run_attempt: runAttempt,
          outcome,
        }),
      }),
    );

  assert.equal((await complete(716, "lease-716", "9100", 1, "failure")).status, 409);
  assert.equal((await complete(716, "lease-716", "9999", 2, "failure")).status, 409);
  const failed = await complete(716, "lease-716", "9100", 2, "failure");
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { ok: true, requeued: true });
  assert.equal((await complete(716, "lease-716", "9100", 2, "success")).status, 409);

  const completed = await complete(717, "lease-717", "9101", 1, "success");
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  assert.equal((await complete(717, "lease-717", "9101", 1, "failure")).status, 409);
  const reconciledAfterSuccess = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "9101",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "failure",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await reconciledAfterSuccess.json(), {
    ok: true,
    reconciled: 0,
    requeued: 0,
    completed: 0,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#716"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#716"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#716"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#717"], undefined);
});

test("signed exact-review reconciliation releases only immutable terminal runs", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#711": leasedExactReviewQueueItem(711, "9001"),
      "openclaw/openclaw#712": leasedExactReviewQueueItem(712, "9002"),
      "openclaw/openclaw#720": leasedExactReviewQueueItem(720, "9004"),
      "openclaw/openclaw#719": leasedExactReviewQueueItem(719, "9003"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)).permissions, { actions: "read" });
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml/runs") {
      assert.equal(url.searchParams.get("event"), "repository_dispatch");
      assert.equal(url.searchParams.get("status"), null);
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = url.searchParams.get("page");
      if (page === "1") {
        return jsonResponse({
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: 10_000 + index,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          })),
        });
      }
      assert.equal(page, "2");
      return jsonResponse({
        workflow_runs: [
          { id: 9001, run_attempt: 1, status: "completed", conclusion: "cancelled" },
          { id: 9002, run_attempt: 1, status: "in_progress", conclusion: null },
          { id: 9003, run_attempt: 1, status: "completed", conclusion: "success" },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9001/attempts/1") {
      return jsonResponse({
        id: 9001,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9003/attempts/1") {
      return jsonResponse({
        id: 9003,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [{ run_id: "9001", run_attempt: 1 }],
      include_all_claimed: true,
    });
    const unsigned = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        body,
      }),
      env,
    );
    assert.equal(unsigned.status, 401);

    const oversizedBody = JSON.stringify({
      run_ids: Array.from({ length: 129 }, (_, index) => String(index + 1)),
    });
    const oversizedSignature = `sha256=${createHmac("sha256", "test-secret").update(oversizedBody).digest("hex")}`;
    const oversized = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": oversizedSignature },
        body: oversizedBody,
      }),
      env,
    );
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: "invalid_runs" });

    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      requested: 1,
      claimed: 4,
      terminal: 2,
      unavailable: 1,
      reconciled: 2,
      requeued: 1,
      completed: 1,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#711"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#711"].claimedRunId, undefined);
    assert.equal(state.items["openclaw/openclaw#712"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#712"].claimedRunId, "9002");
    assert.equal(state.items["openclaw/openclaw#720"].claimedRunId, "9004");
    assert.equal(state.items["openclaw/openclaw#719"], undefined);
    const staleAttemptBody = JSON.stringify({
      runs: [{ run_id: "9004", run_attempt: 2 }],
      include_all_claimed: true,
    });
    const staleAttemptSignature = `sha256=${createHmac("sha256", "test-secret").update(staleAttemptBody).digest("hex")}`;
    const staleAttempt = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": staleAttemptSignature },
        body: staleAttemptBody,
      }),
      env,
    );
    assert.equal(staleAttempt.status, 502);
    const staleAttemptResult = (await staleAttempt.json()) as { unavailable: number };
    assert.equal(staleAttemptResult.unavailable, 1);
    const unavailableBody = JSON.stringify({
      runs: [{ run_id: "9004", run_attempt: 1 }],
      include_all_claimed: true,
    });
    const unavailableSignature = `sha256=${createHmac("sha256", "test-secret").update(unavailableBody).digest("hex")}`;
    const unavailable = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": unavailableSignature },
        body: unavailableBody,
      }),
      env,
    );
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), {
      ok: false,
      requested: 1,
      claimed: 2,
      terminal: 0,
      unavailable: 1,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
    const staleFailure = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-719",
          item_key: "openclaw/openclaw#719",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "9003",
          run_attempt: 1,
          outcome: "failure",
        }),
      }),
    );
    assert.equal(staleFailure.status, 409);

    const replayBody = JSON.stringify({ runs: [{ run_id: "9001", run_attempt: 1 }] });
    const replaySignature = `sha256=${createHmac("sha256", "test-secret").update(replayBody).digest("hex")}`;
    const replay = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": replaySignature },
        body: replayBody,
      }),
      env,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      ok: true,
      requested: 1,
      claimed: 0,
      terminal: 0,
      unavailable: 0,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review reconciliation targets leases beyond 64 entries without accepting stale claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const fillerItems = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => {
      const itemNumber = 8000 + index;
      return [
        `openclaw/openclaw#${itemNumber}`,
        leasedExactReviewQueueItem(itemNumber, String(10_000 + index)),
      ];
    }),
  );
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      ...fillerItems,
      "openclaw/openclaw#8065": leasedExactReviewQueueItem(8065, "9901", 2),
      "openclaw/openclaw#8066": leasedExactReviewQueueItem(8066, "9902"),
      "openclaw/openclaw#8067": leasedExactReviewQueueItem(8067, "9903"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9901") {
      return jsonResponse({ id: 9901, run_attempt: 2, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9902") {
      return jsonResponse({ id: 9902, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9902/attempts/1") {
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-8066",
            item_key: "openclaw/openclaw#8066",
            lease_revision: 1,
            run_id: "9902",
            run_attempt: 2,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      return jsonResponse({
        id: 9902,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9903") {
      return jsonResponse({ id: 9903, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9903/attempts/1") {
      return jsonResponse({
        id: 9903,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [
        { run_id: "9901", run_attempt: 1 },
        { run_id: "9902", run_attempt: 1 },
        { run_id: "9903", run_attempt: 1 },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requested: 3,
      claimed: 3,
      terminal: 2,
      unavailable: 0,
      reconciled: 1,
      requeued: 1,
      completed: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#8000"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8065"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8065"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#8065"].claimGeneration, 1);
    assert.equal(state.items["openclaw/openclaw#8066"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8066"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#8066"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#8067"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#8067"].attempts, 1);
    assert.equal(state.items["openclaw/openclaw#8067"].claimedRunId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review reconciliation cannot release a later attempt with the same run id", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "9010"),
      "openclaw/openclaw#714": {
        ...leasedExactReviewQueueItem(714, "9011"),
        claimedRunAttempt: undefined,
        claimGeneration: 2,
      },
      "openclaw/openclaw#715": leasedExactReviewQueueItem(715, "9012"),
      "openclaw/openclaw#718": leasedExactReviewQueueItem(718, "9013"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9010") {
      return jsonResponse({ id: 9010, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9010/attempts/1") {
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-713",
            item_key: "openclaw/openclaw#713",
            lease_revision: 1,
            run_id: "9010",
            run_attempt: 2,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      return jsonResponse({
        id: 9010,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9011") {
      return jsonResponse({ id: 9011, run_attempt: 2, status: "in_progress", conclusion: null });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9012") {
      return jsonResponse({ id: 9012, run_attempt: 2, status: "queued", conclusion: null });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9013") {
      return jsonResponse({ id: 9013, run_attempt: 2, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9013/attempts/2") {
      return jsonResponse({ id: 9013, run_attempt: 2, status: "completed", conclusion: "failure" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [
        { run_id: "9010", run_attempt: 1 },
        { run_id: "9011", run_attempt: 1 },
        { run_id: "9012", run_attempt: 1 },
        { run_id: "9013", run_attempt: 2 },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requested: 4,
      claimed: 4,
      terminal: 2,
      unavailable: 0,
      reconciled: 1,
      requeued: 1,
      completed: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#713"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#713"].claimedRunId, "9010");
    assert.equal(state.items["openclaw/openclaw#713"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#713"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#714"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#714"].claimedRunId, "9011");
    assert.equal(state.items["openclaw/openclaw#714"].claimedRunAttempt, undefined);
    assert.equal(state.items["openclaw/openclaw#714"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#715"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#715"].claimedRunId, "9012");
    assert.equal(state.items["openclaw/openclaw#715"].claimedRunAttempt, 1);
    assert.equal(state.items["openclaw/openclaw#715"].claimGeneration, 1);
    assert.equal(state.items["openclaw/openclaw#718"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#718"].attempts, 1);
    assert.equal(state.items["openclaw/openclaw#718"].claimedRunId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review stats heals a missing or stale alarm and expired lease", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": {
        key: "openclaw/openclaw#700",
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: 700,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "synchronize",
          supersedesInProgress: true,
        },
        state: "leased",
        revision: 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
        nextAttemptAt: Date.now() - 120_000,
        attempts: 0,
        leaseId: "expired-lease",
        leaseRevision: 1,
        leaseExpiresAt: Date.now() - 1,
        claimedRunId: "run-700",
      },
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.dispatching, 0);
  assert.equal(stats.leased, 0);
  assert.equal(stats.target_stats[0].target_repo, "openclaw/openclaw");
  assert.equal(stats.target_stats[0].pending, 1);
  assert.ok(stats.oldest_pending_age_seconds >= 120);
  assert.equal(stats.oldest_pending_key, "openclaw/openclaw#700");
  assert.equal(stats.lanes.review.oldest_pending_key, "openclaw/openclaw#700");
  assert.ok(stats.next_wake_at);
  assert.ok((await storage.getAlarm()) !== null);

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, Record<string, unknown>>;
  };
  const activeLeaseExpiry = Date.now() + 60_000;
  state.items["openclaw/openclaw#701"] = {
    key: "openclaw/openclaw#701",
    decision: state.items["openclaw/openclaw#700"].decision,
    state: "leased",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
    leaseId: "active-lease",
    leaseRevision: 1,
    leaseExpiresAt: activeLeaseExpiry,
    claimedRunId: "run-701",
  };
  state.items["openclaw/openclaw#702"] = {
    key: "openclaw/openclaw#702",
    decision: {
      ...state.items["openclaw/openclaw#700"].decision,
      itemNumber: 702,
    },
    state: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
  };
  await storage.put("exact-review-queue", state);
  await storage.setAlarm(Date.now() + 1_000);
  const scheduledBeforePoll = await storage.getAlarm();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const scheduledAfterPoll = await storage.getAlarm();
  assert.ok(scheduledBeforePoll !== null && scheduledAfterPoll !== null);
  assert.ok(scheduledAfterPoll <= scheduledBeforePoll);

  await storage.setAlarm(Date.now() - 1_000);
  const staleAlarmPollStartedAt = Date.now();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const rescheduledAlarm = await storage.getAlarm();
  assert.ok(rescheduledAlarm !== null && rescheduledAlarm > staleAlarmPollStartedAt);
});

test("exact-review queue drops an expired failed-shard recovery unless a newer revision superseded it", async () => {
  const storage = new MemoryDurableStorage();
  const expiredRecovery = leasedExactReviewQueueItem(702, "7020");
  expiredRecovery.decision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseExpiresAt = Date.now() - 1;

  const supersededRecovery = leasedExactReviewQueueItem(703, "7030");
  supersededRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  supersededRecovery.decision.sourceAction = "edited";
  supersededRecovery.decision.supersedesInProgress = true;
  supersededRecovery.revision = 2;
  supersededRecovery.leaseExpiresAt = Date.now() - 1;

  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#702": expiredRecovery,
      "openclaw/openclaw#703": supersededRecovery,
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items["openclaw/openclaw#702"], undefined);
  assert.equal(state.items["openclaw/openclaw#703"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#703"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#703"].decision.sourceAction, "edited");
});

function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function completedReviewRun(id: number, itemNumber: number, conclusion: string, ageMs: number) {
  const now = Date.now();
  return {
    id,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${itemNumber}`,
    status: "completed",
    conclusion,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: new Date(now - ageMs).toISOString(),
    updated_at: new Date(now - Math.max(0, ageMs - 10_000)).toISOString(),
  };
}

test("dashboard classifies issue conversion and PR repair workers", () => {
  assert.equal(
    workerWorkKind(
      { title: "repair cluster jobs/openclaw/inbox/issue-openclaw-openclaw-123.md" },
      "Execute and apply cluster actions",
    ),
    "issue_to_pr",
  );
  assert.equal(
    workerWorkKind({ title: "automerge repair jobs/openclaw/inbox/automerge-456.md" }, ""),
    "pr_repair",
  );
  assert.equal(
    workerWorkKind({ title: "repair cluster jobs/openclaw/inbox/cluster-1.md" }, ""),
    "repair_cluster",
  );
});

test("dashboard HTML preserves UTF-8 emoji labels", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"), {
    CLAWSWEEPER_CRABFLEET_URL: "https://fleet.example.test/terminal?view=live&mode=all",
  });
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.match(html, /<title>🦞 ClawSweeper Live<\/title>/);
  assert.match(html, /content: "🦞"/);
  assert.match(html, /Codex Workers/);
  assert.doesNotMatch(html, /Active Sweeps/);
  assert.doesNotMatch(html, /Queue Depth/);
  assert.doesNotMatch(html, /Health Trends/);
  assert.doesNotMatch(html, /id="health-trend-grid"/);
  assert.match(html, /\/api\/health-history\?range=/);
  assert.match(html, /Work execution needs attention/);
  assert.doesNotMatch(html, /Review reliability/);
  assert.doesNotMatch(html, /\/api\/review-observability\?range=/);
  assert.match(html, /data-trend-range="6h"/);
  assert.match(html, /<details class="execution-alert">/);
  assert.match(html, /Error Rate/);
  assert.match(html, /Recovery Rate/);
  assert.match(html, /Capacity/);
  assert.match(html, /Only jobs that execute Codex count against this budget/);
  assert.match(html, /id="exact-review-lanes"/);
  assert.match(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.exact-review-lanes \{ display: contents; \}/);
  assert.match(html, /Review admission/);
  assert.match(html, /Result publication/);
  assert.match(html, /Net publication rate/);
  assert.match(html, /Review throughput/);
  assert.doesNotMatch(html, /Control Plane · GitHub Actions, not Codex/);
  assert.doesNotMatch(html, /id="control-plane"/);
  assert.match(html, /\.exact-lanes \{ grid-template-columns: 1fr; \}/);
  assert.match(
    html,
    /<div class="exact-lanes">\s*<div class="exact-review-lanes" id="exact-review-lanes"[\s\S]*?<section class="exact-lane" id="state-writer-health"/,
  );
  assert.ok(html.indexOf("Codex Capacity") < html.indexOf('id="exact-review-lanes"'));
  assert.ok(html.indexOf('id="exact-review-lanes"') < html.indexOf("Handoff Health"));
  assert.match(html, /Live terminals/);
  assert.match(html, /href="https:\/\/fleet\.example\.test\/terminal\?view=live&amp;mode=all"/);
  assert.match(html, /Loading pipeline state/);
  assert.match(html, /System Overview/);
  assert.match(html, /id="exact-review-handoff"/);
  assert.match(html, /function renderExactReviewHandoff/);
  assert.match(html, /waiting for run claim/);
  assert.match(html, /id="apply-health"/);
  assert.match(html, /function renderApplyHealth/);
  assert.match(html, /candidate examined count unavailable for this lane/);
  assert.match(html, /Pruning sweep/);
  assert.match(html, /Copy command/);
  assert.match(html, /applyHealthRecommendedAction/);
  assert.match(html, /Rotation cursor missing/);
  assert.match(html, /Inspect the cursor-write and state-publish steps/);
  assert.match(html, /const skipCount = skipReasons\[reason\]/);
  assert.doesNotMatch(html, /Apply needs attention/);
  assert.match(html, /Automatic Builds/);
  assert.match(html, /id="automatic-work"/);
  assert.match(html, /Lifecycle Timeline/);
  assert.match(html, /Active Workers/);
  assert.match(html, /id="worker-dialog"/);
  assert.match(html, /Step Timeline/);
  assert.match(html, /worker-target-title/);
  assert.match(html, /Refreshing live status in the background/);
  assert.match(html, /Cluster Intake/);
  assert.match(html, /Active Pipeline/);
  assert.doesNotMatch(html, /Automerge Reliability/);
  assert.doesNotMatch(html, /id="automerge-reliability"/);
  assert.match(html, /Automerge worker operations/);
  assert.match(html, /separate from Automerge Product Health success rate/);
  assert.match(html, /Time-window coverage/);
  assert.match(html, /Active sessions/);
  assert.match(html, /No terminal samples yet/);
  assert.match(html, /Repair workflow failed/);
  assert.match(html, /outcomeLabels\[session\.state\]/);
  assert.match(html, /Showing up to 30 latest sessions in the selected window/);
  assert.match(html, /Closed by ClawSweeper/);
  assert.match(html, /Worker Health/);
  assert.match(html, /Recent Activity/);
  assert.doesNotMatch(html, /ðŸ|â|âš|âœ/);
});

test("dashboard hero treats apply and exact-review handoff health as attention", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"));
  const html = await response.text();
  const script = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(script);

  const elements = new Map();
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener: () => undefined,
        className: "",
        close() {
          this.open = false;
        },
        dataset: {},
        id,
        innerHTML: "",
        open: false,
        showModal() {
          this.open = true;
        },
        style: {},
        textContent: "",
      });
    }
    return elements.get(id);
  };
  const status = {
    generated_at: "2026-07-05T11:22:43.934Z",
    source: { target_repositories: ["openclaw/openclaw"] },
    health: {
      attempts: 0,
      error_rate_percent: 0,
      failed_attempts: 0,
      failures: [],
      recovered_failures: 0,
      recovery_rate_percent: 100,
      unresolved_failures: 0,
    },
    fleet: {
      active_codex_jobs: 0,
      active_workflow_runs: 0,
      budget_used_percent: 0,
      queued_workflow_runs: 0,
      support_queued_workflow_runs: 0,
      support_workflow_runs: 0,
      worker_budget: 128,
      worker_detail_fallbacks: 0,
    },
    workers: [],
    automatic_work: [],
    pipeline: [],
    control_plane: {
      publishers: { running: 2, waiting: 1 },
      comment_routers: { running: 3, waiting: 4 },
      reconcilers: { running: 1, waiting: 0 },
    },
    exact_review_queue: {
      pending: 4,
      ready_pending: 3,
      admissible_pending: 2,
      lanes: {
        review: {
          pending: 4,
          ready: 3,
          backoff: 1,
          dispatching: 2,
          leased: 10,
          active: 12,
          capacity: 64,
          available_slots: 52,
          oldest_pending_age_seconds: 60,
          flow: {
            last_15_minutes: {
              arrival_rate_per_hour: 24,
              successful_rate_per_hour: 20,
              retried_rate_per_hour: 4,
              shed_rate_per_hour: 0,
              retry_amplification: 0.2,
            },
          },
        },
        publication: {
          pending: 2,
          ready: 1,
          backoff: 1,
          dispatching: 1,
          leased: 20,
          active: 21,
          capacity: 24,
          available_slots: 3,
          oldest_pending_age_seconds: 30,
          oldest_ready_age_seconds: 30,
          oldest_backoff_age_seconds: 20,
          flow: {
            last_15_minutes: {
              arrival_rate_per_hour: 12,
              resolved_rate_per_hour: 20,
              published_rate_per_hour: 4,
              superseded_rate_per_hour: 16,
              retried_rate_per_hour: 8,
              dead_lettered_rate_per_hour: 0,
              retry_amplification: 0.4,
            },
          },
          dead_letters: {
            open: 2,
            oldest_failed_at: "2026-07-05T10:22:43.934Z",
          },
          capacity_control: {
            mode: "throttled",
            base: 24,
            maximum: 48,
            ceiling: 24,
            demand_capacity: 32,
            cooldown_until: "2026-07-05T12:00:00.000Z",
            last_failure_kind: "github_rate_limit",
          },
        },
      },
      pressure: {
        status: "congested",
        reason: "capacity_full_with_backlog",
        capacity: 28,
        active: 28,
        pending: 4,
        ready_pending: 3,
        admissible_pending: 2,
      },
      handoff_health: {
        status: "healthy",
        message: "Dispatch-to-claim handoffs are within the expected window.",
        available_slots: 2,
        capacity: 28,
        stalled_after_seconds: 300,
        phases: {
          pending: { count: 4, oldest_age_seconds: 60 },
          dispatching: { count: 2, oldest_age_seconds: 10 },
          leased: { count: 24, oldest_age_seconds: 240 },
        },
      },
    },
    diagnostics: { errors: [], exact_review_queue_error: null as string | null },
    recent: {
      apply_health: {
        attention_count: 1,
        items: [
          {
            attention_reasons: ["cursor_required_but_missing_after_full_window"],
            closed: 0,
            comment_synced: 0,
            cursor: null,
            cursor_required: true,
            cycle: null,
            lanes: {
              closure: {
                closed: 0,
                comment_synced: 0,
                processed: 2,
                skip_reasons: { skipped_changed_since_review: 2 },
                skipped: 2,
              },
              comment_sync: {
                closed: 0,
                comment_synced: 0,
                processed: 0,
                skip_reasons: {},
                skipped: 0,
              },
            },
            mode: "close",
            next_action_buckets: { review_refresh: 2 },
            next_actions: [
              {
                bucket: "review_refresh",
                count: 2,
                label: "Refresh review",
                next_step: "Queue a fresh ClawSweeper review before any close retry.",
                owner: "clawsweeper",
                reason: "skipped_changed_since_review",
                retryable: true,
                summary: "The item changed after review.",
              },
            ],
            processed: 2,
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
            skip_reasons: { skipped_changed_since_review: 2 },
            skipped: 2,
            status: "needs_attention",
            target_repo: "openclaw/openclaw",
            updated_at: "2026-07-05T11:22:03.748Z",
          },
        ],
      },
      automerge: [],
      automerge_reliability: {
        sampled_runs: 3,
        completed_attempts: 3,
        failed_attempts: 2,
        failure_rate_percent: 66.7,
        active_attempts: 0,
        stalled_attempts: 0,
        average_duration_ms: 600_000,
        longest_duration_ms: 1_200_000,
        unresolved_failures: 1,
        recovered_failures: 1,
        failures: [
          {
            repository: "openclaw/openclaw",
            number: 107691,
            item_url: "https://github.com/openclaw/openclaw/pull/107691",
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/29431617465",
            status: "unresolved",
            conclusion: "failure",
            started_at: "2026-07-05T10:50:00Z",
            completed_at: "2026-07-05T11:10:00Z",
            duration_ms: 1_200_000,
            recovered: false,
          },
        ],
      },
      closed_items: [],
      closed_stats: { issues: 0, prs: 0, total: 0, window_hours: 24 },
      cluster_repair: null,
      events: [],
      operation_counts: {},
    },
  };

  const context = createContext({
    console,
    document: {
      addEventListener: () => undefined,
      body: { classList: { add: () => undefined, remove: () => undefined } },
      documentElement: { dataset: {} },
      getElementById: elementFor,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: async () => ({
      headers: { get: () => "fresh" },
      json: async () => status,
      ok: true,
      status: 200,
    }),
    history: { replaceState: () => undefined },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    location: { hash: "", pathname: "/", search: "" },
    navigator: { clipboard: { writeText: async () => undefined } },
    setInterval: () => 1,
    setTimeout: () => 1,
    window: { addEventListener: () => undefined },
  });
  new Script(script).runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("apply-health").innerHTML, /Pruning sweep blocked/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /Dispatching/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /2 of 28 exact-review slots open/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /health-badge healthy/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /pressure congested/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /4 total · 3 ready · 2 admissible/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /Review admission/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /52 review admission slots open/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /Result publication/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /3 result publication slots open/);
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /<div class="exact-lane-head"><strong>State writer<\/strong><span>Unavailable<\/span><\/div>/,
  );
  context.renderStateWriter({
    lanes: { publication: { batches: { enabled: true, max_items: 2 } } },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 0,
        leased: 0,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: {
        materialized_items: 0,
        state_commits: 0,
        items_per_commit: null,
        wait_ms: { p50: null, p95: null, samples: 0 },
        hold_ms: { p50: null, p95: null, samples: 0 },
      },
      live: { freshness_seconds: null, tracked_holding: 0, tracked_waiting: 0 },
      mode: "unknown",
    },
  });
  const stateWriterHtml = elementFor("state-writer-health").innerHTML;
  assert.match(stateWriterHtml, /class="exact-lane-head"/);
  assert.match(stateWriterHtml, /Batch · configured 2 · coordinator live · 6h/);
  assert.match(
    stateWriterHtml,
    /Serialization queue<\/span><strong>0 active · 0 queued · 1 writer max/,
  );
  assert.match(stateWriterHtml, /Git crash fence<\/span><strong>free/);
  assert.match(stateWriterHtml, /Coordinator turns<\/dt><dd>16 completed · 16 admitted/);
  assert.match(stateWriterHtml, /Coordinator wait<\/dt><dd>last 0s · max 5m/);
  assert.match(stateWriterHtml, /Queue history<\/dt><dd>collecting samples/);
  assert.match(stateWriterHtml, /Terminal telemetry<\/dt><dd>terminal telemetry stale/);
  assert.match(stateWriterHtml, /terminal telemetry stale/);
  assert.doesNotMatch(stateWriterHtml, /Exact-review materialized/);

  const coordinatorSamples = [
    {
      at: new Date(Date.now() - 15 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: null,
        tracked_waiting: "",
      },
    },
    {
      at: new Date(Date.now() - 10 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 5,
        accepted_operations_total: 16,
        state_commits_total: 8,
        materialized_items_total: 16,
      },
    },
    {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 2,
      },
    },
    {
      at: new Date().toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 4,
      },
    },
  ];
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ samples: coordinatorSamples }),
  });
  await context.loadHealthHistory("6h", true);
  context.renderStateWriter({
    lanes: { publication: { batches: { enabled: true, max_items: 2 } } },
    state_writer: {
      collection: { status: "stale" },
      coordinator: { queued: 0, leased: 0, admitted: 16, completed: 16 },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Queue history<\/dt><dd>3 samples · 2–5 queued/,
  );
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Latest queue sample<\/dt><dd>1 active · 4 queued ·/,
  );
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Serialized writer queue depth over 6h/,
  );
  assert.doesNotMatch(elementFor("state-writer-health").innerHTML, /Exact-review materialized/);
  assert.match(stateWriterHtml, /class="lane-metrics"/);
  assert.doesNotMatch(stateWriterHtml, /<section class="exact-lane">/);
  const initialLaneHtml = elementFor("exact-review-lanes").innerHTML;
  assert.match(
    initialLaneHtml,
    /<details class="lane-flow"><summary><span class="lane-flow-title">Review throughput · last 15 minutes/,
  );
  assert.match(
    initialLaneHtml,
    /<details class="lane-flow"><summary><span class="lane-flow-title">Publication throughput · last 15 minutes/,
  );
  assert.match(
    initialLaneHtml,
    /15m hourly-equivalent rates respond faster to recent changes but are more burst-sensitive than the up-to-60m net rate above\./,
  );
  assert.equal(initialLaneHtml.match(/class="lane-flow"/g)?.length, 2);
  assert.equal(initialLaneHtml.match(/class="lane-flow-foot"/g)?.length, 2);
  assert.doesNotMatch(initialLaneHtml, /<details class="lane-flow" open>/);
  const flowBlocks = [
    ...initialLaneHtml.matchAll(/<details class="lane-flow">([\s\S]*?)<\/details>/g),
  ];
  assert.equal(flowBlocks.length, 2);
  assert.deepEqual(
    flowBlocks.map((match) => match[1].match(/class="lane-count"/g)?.length),
    [4, 4],
  );
  assert.match(initialLaneHtml, /Successful<\/span><strong>20\/h/);
  assert.match(initialLaneHtml, /Shed<\/span><strong>0\/h/);
  assert.match(initialLaneHtml, /Published<\/span><strong>4\/h/);
  assert.match(initialLaneHtml, /Superseded<\/span><strong>16\/h/);
  assert.doesNotMatch(initialLaneHtml, /Terminal resolved/);
  assert.doesNotMatch(initialLaneHtml, /Dead-lettered/);
  assert.match(initialLaneHtml, /DLQ 2/);
  assert.match(initialLaneHtml, /Retry amplification<\/span><strong>0\.20/);
  assert.match(initialLaneHtml, /Retry amplification<\/span><strong>0\.40/);
  assert.match(elementFor("worker-health").innerHTML, /Automerge worker operations/);
  assert.match(elementFor("worker-health").innerHTML, /Active \/ stalled<\/span><strong>0 \/ 0/);
  assert.match(elementFor("worker-health").innerHTML, /Failed attempts<\/span><strong>2/);
  assert.match(
    elementFor("worker-health").innerHTML,
    /Recovered \/ unresolved<\/span><strong>1 \/ 1/,
  );
  assert.match(elementFor("worker-health").innerHTML, /avg runtime 10m/);
  assert.match(elementFor("worker-health").innerHTML, /openclaw\/openclaw#107691/);
  assert.match(elementFor("worker-health").innerHTML, /actions\/runs\/29431617465/);
  assert.match(elementFor("worker-health").innerHTML, /unresolved/);
  assert.match(
    elementFor("exact-review-lanes").innerHTML,
    /target 32 · pressure ceiling 24 after GitHub rate limit/,
  );
  assert.match(elementFor("exact-review-lanes").innerHTML, /No backlog history in this range/);
  status.workers = Array.from({ length: 130 }, (_, id) => ({ id, status: "in_progress" }));
  context.renderSystemMap(status);
  assert.match(elementFor("capacity-rail").innerHTML, /130 running/);
  assert.match(elementFor("capacity-rail").innerHTML, /2 over budget/);
  status.workers = [];

  status.recent.apply_health.items = [];
  status.exact_review_queue.handoff_health.status = "stalled";
  status.exact_review_queue.pressure.status = "saturated";
  status.exact_review_queue.handoff_health.message =
    "A dispatched review has not been claimed within the expected handoff window.";
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot red");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /health-badge stalled/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /pressure saturated/);

  Object.assign(status, { exact_review_queue: null });
  status.diagnostics.exact_review_queue_error = "exact-review queue timed out";
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /telemetry unavailable/);

  const healthyOperational = {
    status: "healthy",
    telemetry_complete: true,
    queued_runs: 0,
    queued_over_threshold: 0,
    oldest_queued_minutes: 0,
    running_runs: 0,
    running_over_threshold: 0,
    oldest_running_minutes: 0,
  };
  context.renderExecutionAlert(healthyOperational);
  assert.equal(elementFor("execution-alert").innerHTML, "");
  context.renderExecutionAlert({ ...healthyOperational, queued_runs: 2, queued_over_threshold: 2 });
  assert.match(
    elementFor("execution-alert").innerHTML,
    /2 workflows waiting for a runner over 30m/,
  );
  context.renderExecutionAlert({
    ...healthyOperational,
    running_runs: 1,
    running_over_threshold: 1,
  });
  assert.match(elementFor("execution-alert").innerHTML, /1 execution over 150m/);
  context.renderExecutionAlert({ ...healthyOperational, telemetry_complete: false });
  assert.match(elementFor("execution-alert").innerHTML, /telemetry is incomplete/);

  status.diagnostics.exact_review_queue_error = null;
  status.exact_review_queue = { handoff_health: { status: "healthy", phases: {} } };
  status.operational_health = {
    status: "stalled",
    checked_at: "2026-07-05T11:22:43.934Z",
    telemetry_complete: true,
    queued_runs: 10,
    queued_over_threshold: 4,
    oldest_queued_minutes: 90,
    running_runs: 2,
    running_over_threshold: 1,
    oldest_running_minutes: 180,
  };
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot red");
  assert.doesNotMatch(elementFor("metrics").innerHTML, /over 30m|over 150m/);
  assert.match(
    elementFor("execution-alert").innerHTML,
    /4 workflows waiting for a runner over 30m/,
  );
  assert.match(elementFor("execution-alert").innerHTML, /1 execution over 150m/);
  assert.match(elementFor("execution-alert").innerHTML, /Total GitHub queued 10/);
  assert.match(elementFor("execution-alert").innerHTML, /oldest running 3h/);

  const scale = context.niceTrendScale(95, 4);
  assert.equal(scale.maximum, 100);
  assert.deepEqual([...scale.ticks], [0, 25, 50, 75, 100]);

  let resolve24HourHistory: ((response: unknown) => void) | undefined;
  const now = Date.now();
  const samples = Array.from({ length: 25 }, (_, index) => ({
    at: new Date(now - (24 - index) * 5 * 60_000).toISOString(),
    collection_ok: true,
    exact_review: {
      collection_ok: true,
      review: {
        pending: 100 + index,
        enqueued_total: index * 8,
        completed_total: index * 5,
        shed_total: 0,
      },
      publication: {
        pending: 200 - index,
        enqueued_total: index * 4,
        completed_total: index * 10,
      },
    },
  }));
  context.fetch = async (input: string) => {
    if (input.includes("range=24h")) {
      return new Promise((resolve) => {
        resolve24HourHistory = resolve;
      });
    }
    return {
      ok: true,
      json: async () => ({ samples }),
    };
  };
  const stale24HourRequest = context.loadHealthHistory("24h", true);
  const active7DayRequest = context.loadHealthHistory("7d", true);
  await active7DayRequest;
  resolve24HourHistory?.({ ok: true, json: async () => ({ samples: [] }) });
  await stale24HourRequest;
  const laneHtml = elementFor("exact-review-lanes").innerHTML;
  assert.match(laneHtml, /Growing · \+12 in the last hour/);
  assert.match(laneHtml, /Draining · −12 in the last hour/);
  assert.match(laneHtml, /Net review rate/);
  assert.match(laneHtml, /Net publication rate/);
  assert.match(laneHtml, /Net review rate.*<\/div><strong>−36 \/ hour/);
  assert.match(laneHtml, /Net publication rate.*<\/div><strong>\+72 \/ hour/);
  assert.equal(laneHtml.match(/class="lane-rate-help"/g)?.length, 2);
  assert.equal(laneHtml.match(/role="tooltip"/g)?.length, 2);
  assert.match(laneHtml, /aria-describedby="lane-rate-help-net-review-rate"/);
  assert.match(laneHtml, /aria-describedby="lane-rate-help-net-publication-rate"/);
  assert.match(
    laneHtml,
    /Successful completions minus incoming review demand per hour\. Incoming includes newly queued work and shed demand\./,
  );
  assert.match(laneHtml, /Successful completions minus newly queued publication work per hour\./);
  assert.match(laneHtml, /Falling behind/);
  assert.match(laneHtml, /Catching up/);
  assert.equal(laneHtml.match(/class="lane-speed"/g)?.length, 2);
  assert.doesNotMatch(laneHtml, /Processed \/ hour|Incoming \/ hour/);
  assert.match(
    laneHtml,
    /role="img" aria-label="Net review rate, completed minus incoming, over 7d"/,
  );
  assert.match(
    laneHtml,
    /role="img" aria-label="Net publication rate, completed minus incoming, over 7d"/,
  );
  assert.match(laneHtml, /role="img" aria-label="Review admission pending backlog over 7d"/);
  assert.match(laneHtml, /Live snapshot unavailable/);
  assert.match(laneHtml, /Last sampled/);

  const smallAxis = context.exactReviewTrend(
    [{ at: new Date(now).toISOString(), pending: 8 }],
    "Small lane",
  );
  const largeAxis = context.exactReviewTrend(
    [{ at: new Date(now).toISOString(), pending: 1500 }],
    "Large lane",
  );
  assert.match(smallAxis, />8<\/text>/);
  assert.match(largeAxis, />2,000<\/text>/);
  const flowSample = (
    minutesAgo: number,
    enqueuedTotal: number,
    completedTotal: number,
    shedTotal = 0,
  ) => ({
    at: new Date(now - minutesAgo * 60_000).toISOString(),
    enqueuedTotal,
    completedTotal,
    shedTotal,
  });
  const provisionalSamples = [flowSample(5, 10, 20), flowSample(0, 12, 25)];
  const provisionalRates = context.laneSpeedHistory(provisionalSamples);
  assert.equal(provisionalRates.length, 1);
  assert.equal(Math.round(provisionalRates[0].rate), 36);
  assert.equal(provisionalRates[0].provisional, true);
  assert.equal(Math.round(provisionalRates[0].windowMinutes), 5);
  const provisionalSpeed = context.laneSpeedTrend(provisionalSamples, "Net review rate");
  assert.match(provisionalSpeed, /Net review rate<\/span><\/div><strong>\+36 \/ hour/);
  assert.match(provisionalSpeed, /Catching up · provisional 5m window/);

  const balancedSamples = [flowSample(5, 10, 20), flowSample(0, 10, 20)];
  const balancedSpeed = context.laneSpeedTrend(balancedSamples, "Net review rate");
  assert.match(balancedSpeed, /Net review rate<\/span><\/div><strong>0 \/ hour/);
  assert.match(balancedSpeed, /Balanced · provisional 5m window/);
  assert.doesNotMatch(balancedSpeed, /Collecting/);

  const shedRates = context.laneSpeedHistory([flowSample(5, 10, 20, 2), flowSample(0, 10, 20, 3)]);
  assert.equal(Math.round(shedRates[0].rate), -12);

  const matureRates = context.laneSpeedHistory(
    Array.from({ length: 13 }, (_, index) => flowSample((12 - index) * 5, index * 3, index * 5)),
  );
  assert.equal(Math.round(matureRates.at(-1).rate), 24);
  assert.equal(matureRates.at(-1).provisional, false);
  assert.equal(Math.round(matureRates.at(-1).windowMinutes), 60);

  const gapRates = context.laneSpeedHistory([
    flowSample(40, 0, 0),
    flowSample(35, 1, 2),
    flowSample(10, 2, 4),
    flowSample(5, 3, 6),
  ]);
  assert.equal(gapRates.length, 2);
  assert.notEqual(gapRates[0].segmentId, gapRates[1].segmentId);

  const resetRates = context.laneSpeedHistory([
    flowSample(20, 10, 10),
    flowSample(15, 11, 12),
    flowSample(10, 1, 1),
    flowSample(5, 2, 3),
  ]);
  assert.equal(resetRates.length, 2);
  assert.notEqual(resetRates[0].segmentId, resetRates[1].segmentId);
  const resetCollecting = context.laneSpeedTrend(
    [flowSample(10, 10, 10), flowSample(5, 11, 12), flowSample(0, 1, 1)],
    "Net review rate",
  );
  assert.match(resetCollecting, /Net review rate<\/span><\/div><strong>Collecting/);
  assert.match(resetCollecting, /Needs two continuous five-minute samples/);

  const legacyBreakRates = context.laneSpeedHistory([
    flowSample(25, 10, 10),
    flowSample(20, 11, 12),
    { at: new Date(now - 15 * 60_000).toISOString(), pending: 1 },
    flowSample(10, 12, 14),
    flowSample(5, 13, 16),
  ]);
  assert.equal(legacyBreakRates.length, 2);
  assert.notEqual(legacyBreakRates[0].segmentId, legacyBreakRates[1].segmentId);
  const speedGeometry = context.speedTrendGeometry(
    legacyBreakRates,
    { left: 0, top: 0, width: 100, height: 100 },
    20,
    now - 30 * 60_000,
    now,
  );
  assert.equal(speedGeometry[1].connected, false);
  assert.match(context.trendPath(speedGeometry), /^M.* M/);

  const staleSpeed = context.laneSpeedTrend(
    [flowSample(25, 0, 0), flowSample(20, 1, 2)],
    "Net publication rate",
  );
  assert.match(staleSpeed, /Net publication rate<\/span><\/div><strong>Stale/);
  assert.match(staleSpeed, /Stale · no rate sample in the last 12m/);
  const collectingSpeed = context.laneSpeedTrend([flowSample(0, 0, 0)], "Net review rate");
  assert.match(collectingSpeed, /Net review rate<\/span><\/div><strong>Collecting/);
  assert.match(collectingSpeed, /Needs two continuous five-minute samples/);

  assert.equal(
    context.oneHourTrend(samples.slice(0, 1).map((sample) => ({ at: sample.at, pending: 4 })))
      .label,
    "Collecting 1h trend",
  );
  assert.equal(
    context.oneHourTrend(samples.map((sample) => ({ at: sample.at, pending: 9 }))).label,
    "Stable · no change in the last hour",
  );
  const broken = context.trendGeometry(
    [
      { at: new Date(now - 30 * 60_000).toISOString(), pending: 1 },
      { at: new Date(now - 10 * 60_000).toISOString(), pending: 2 },
    ],
    "pending",
    { left: 0, top: 0, width: 100, height: 100 },
    2,
    now - 60 * 60_000,
    now,
  );
  assert.equal(broken[1].connected, false);
  assert.match(context.trendPath(broken), /^M.* M/);
});

test("dashboard HTML emits early persistent theme controls", async () => {
  for (const path of ["/", "/triage", "/pr-proof-triage"]) {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai" + path));
    const html = await response.text();
    const themeInit = html.indexOf('const themeKey = "clawsweeper-theme";');
    const styles = html.indexOf("<style>");

    assert.notEqual(themeInit, -1, path + " should initialize theme preference");
    assert.notEqual(styles, -1, path + " should include CSS");
    assert.ok(themeInit < styles, path + " should apply saved theme before styles");
    assert.match(html, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
    assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    assert.match(html, /data-theme-choice="system"/);
    assert.match(html, /data-theme-choice="light"/);
    assert.match(html, /data-theme-choice="dark"/);
    assert.match(html, /window\.localStorage\?\.setItem\(themeKey, choice\)/);
    assert.match(html, /typeof themeQuery\?\.addEventListener === "function"/);
    assert.match(html, /themeQuery\.addEventListener\("change", updateSystemTheme\)/);
    assert.match(html, /themeQuery\?\.addListener\?\.\(updateSystemTheme\)/);
    assert.match(html, /setAttribute\("aria-pressed", selected \? "true" : "false"\)/);
  }
});

test("dashboard groups automatic issue lifecycle events with active workers", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_queued",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        title: "Add compact export mode",
        stage: "queued",
        status: "queued",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.generated_pr_opened",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        item_url: "https://github.com/steipete/example/pull/51",
        pr_url: "https://github.com/steipete/example/pull/51",
        title: "Add compact export mode",
        stage: "pr_opened",
        status: "completed",
        work_kind: "issue_to_pr",
        automatic: null,
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [
      {
        id: 7001,
        repository: "steipete/example",
        item_number: 42,
        work_kind: "issue_to_pr",
        name: "Implement issue",
        status: "in_progress",
        current_step: "Run Codex",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        updated_at: "2026-06-14T10:05:00Z",
        target_items: [
          {
            number: 42,
            title: "Add compact export mode",
            url: "https://github.com/steipete/example/issues/42",
          },
        ],
      },
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "steipete/example#42");
  assert.equal(rows[0].title, "Add compact export mode");
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7001");
  assert.equal(rows[0].pr_url, "https://github.com/steipete/example/pull/51");
  assert.equal(rows[0].timeline.length, 3);
});

test("dashboard correlates issue implementation workers by run URL", () => {
  const workers = [
    {
      id: 7002,
      repository: null,
      item_number: null,
      item_numbers: [],
      work_kind: "issue_to_pr",
      name: "Execute and apply cluster actions",
      status: "in_progress",
      current_step: "Execute credited fix artifact",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
      updated_at: "2026-06-14T10:05:00Z",
      target_items: [],
    },
  ];
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "Install sudo when missing",
        stage: "building",
        status: "running",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:04:00Z",
      },
    ],
    workers,
  );

  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7002");
  assert.equal(workers[0].repository, "openclaw/openclaw-ansible");
  assert.equal(workers[0].item_number, 20);
  assert.equal(workers[0].target_items[0].title, "Install sudo when missing");
});

test("dashboard preserves issue titles across generated PR repair events", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "installation fails due to not sudo installed",
        stage: "building",
        status: "running",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.contributor_branch_repaired",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        item_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        pr_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        title: "openclaw/openclaw-ansible#49",
        stage: "repair_contributor_branch",
        status: "pushed",
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [],
  );

  assert.equal(rows[0].title, "installation fails due to not sudo installed");
  assert.equal(rows[0].pr_url, "https://github.com/openclaw/openclaw-ansible/pull/49");
});

test("dashboard exposes active worker jobs and their current steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 42,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92521",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    created_at: isoAgo(120_000),
    updated_at: isoAgo(10_000),
  };
  const queuedRun = {
    id: 43,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92523",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/43",
    created_at: isoAgo(30_000),
    updated_at: isoAgo(5_000),
  };
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status
          ? [run, queuedRun]
          : status === "in_progress"
            ? [run]
            : status === "queued"
              ? [queuedRun]
              : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/42/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: 4201,
            name: "Review shard 0 · openclaw/openclaw#92521,92522",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4201",
            started_at: isoAgo(90_000),
            steps: [
              {
                number: 1,
                name: "Set up job",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 3,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4202,
            name: "Publish review artifacts",
            status: "queued",
            conclusion: null,
            steps: [],
          },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/43/jobs") {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            target0: {
              __typename: "Issue",
              title: "Preserve terminal resize state",
              url: "https://github.com/openclaw/openclaw/issues/92521",
            },
            target1: {
              __typename: "PullRequest",
              title: "Repair terminal resize state",
              url: "https://github.com/openclaw/openclaw/pull/92522",
            },
            target2: {
              __typename: "Issue",
              title: "Queued terminal resize follow-up",
              url: "https://github.com/openclaw/openclaw/issues/92523",
            },
          },
        },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 2);
    assert.equal(status.fleet.worker_detail_runs, 2);
    assert.equal(status.fleet.worker_detail_fallbacks, 1);
    assert.equal(status.workers.length, 2);
    assert.equal(status.workers[0].id, 4201);
    assert.equal(status.workers[0].name, "Review shard 0 · openclaw/openclaw#92521,92522");
    assert.equal(status.workers[0].repository, "openclaw/openclaw");
    assert.equal(status.workers[0].item_number, null);
    assert.deepEqual(status.workers[0].item_numbers, [92521, 92522]);
    assert.equal(status.workers[0].current_step, "Review shard");
    assert.deepEqual(status.workers[0].progress, { completed: 2, total: 3 });
    assert.equal(status.workers[0].steps[2].status, "in_progress");
    assert.deepEqual(status.workers[0].target_items, [
      {
        repository: "openclaw/openclaw",
        number: 92521,
        title: "Preserve terminal resize state",
        url: "https://github.com/openclaw/openclaw/issues/92521",
        type: "issue",
      },
      {
        repository: "openclaw/openclaw",
        number: 92522,
        title: "Repair terminal resize state",
        url: "https://github.com/openclaw/openclaw/pull/92522",
        type: "pull_request",
      },
    ]);
    assert.equal(status.workers[1].id, "run-43");
    assert.equal(status.workers[1].source, "workflow-fallback");
    assert.equal(status.workers[1].current_step, "reviewing");
    assert.equal(status.workers[1].target_items[0].title, "Queued terminal resize follow-up");

    const cachedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const cachedStatus = await cachedResponse.json();
    assert.equal(cachedStatus.workers[0].target_items[0].title, "Preserve terminal resize state");
    assert.equal(graphqlRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps control-plane workflow fallbacks out of Codex capacity", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const runs = [
    [1, "ClawSweeper", "Review event item openclaw/openclaw#1", "in_progress"],
    [2, "repair cluster worker", "repair cluster jobs/openclaw/inbox/cluster-2.md", "queued"],
    [3, "Assist", "Assist openclaw/openclaw#3", "in_progress"],
    [4, "ClawSweeper", "Review event item openclaw/openclaw#4@publish:40:1", "in_progress"],
    [5, "repair comment router", "clawsweeper_comment", "queued"],
    [6, "Reconcile exact-review leases", "Reconcile exact-review leases", "in_progress"],
    [7, "ClawSweeper", "Sync Codex review comments for openclaw/openclaw", "queued"],
  ].map(([id, name, displayTitle, status]) => ({
    id,
    name,
    display_title: displayTitle,
    status,
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: isoAgo(Number(id) * 1_000),
    updated_at: isoAgo(500),
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status ? runs : runs.filter((run) => run.status === status),
      });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 3);
    assert.equal(status.fleet.worker_detail_fallbacks, 3);
    assert.deepEqual(status.workers.map((entry: { id: string }) => entry.id).sort(), [
      "run-1",
      "run-2",
      "run-3",
    ]);
    assert.deepEqual(status.control_plane, {
      publishers: { running: 1, waiting: 0 },
      comment_routers: { running: 0, waiting: 2 },
      reconcilers: { running: 1, waiting: 0 },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard bounds worker job detail request concurrency", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: 1000 + index,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${9000 + index}`,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${1000 + index}`,
    created_at: isoAgo((index + 1) * 1000),
    updated_at: isoAgo(1000),
  }));
  let activeJobRequests = 0;
  let maxActiveJobRequests = 0;
  let pipelineRequestsWhileJobsActive = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      const runId = Number(url.pathname.split("/").at(-2));
      activeJobRequests += 1;
      maxActiveJobRequests = Math.max(maxActiveJobRequests, activeJobRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeJobRequests -= 1;
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard ${runId}`,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: isoAgo(1000),
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ head: { sha: `head-${url.pathname.split("/").at(-1)}` } });
    }
    if (/^\/repos\/openclaw\/openclaw\/commits\/head-\d+\/check-runs$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ check_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        WORKER_DETAIL_RUN_LIMIT: "12",
        WORKER_JOB_FETCH_CONCURRENCY: "3",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.workers.length, 12);
    assert.equal(status.fleet.active_codex_jobs, 12);
    assert.equal(maxActiveJobRequests, 3);
    assert.equal(pipelineRequestsWhileJobsActive, 0);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard paginates worker jobs beyond GitHub's first page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 500,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#500",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/500",
    created_at: isoAgo(60_000),
    updated_at: isoAgo(5_000),
  };
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status || status === "in_progress" ? [run] : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/500/jobs") {
      const page = Number(url.searchParams.get("page") || "1");
      requestedPages.push(page);
      const count = page === 1 ? 100 : 28;
      const offset = page === 1 ? 0 : 100;
      return jsonResponse({
        total_count: 128,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: 500_000 + offset + index,
          name: `Review shard ${offset + index}`,
          status: "in_progress",
          conclusion: null,
          html_url: `https://github.com/openclaw/clawsweeper/actions/runs/500/job/${
            500_000 + offset + index
          }`,
          started_at: isoAgo(30_000),
          steps: [
            {
              number: 1,
              name: "Run ./clawsweeper/.github/actions/setup-codex",
              status: "completed",
              conclusion: "success",
            },
            {
              number: 2,
              name: "Review shard",
              status: "in_progress",
              conclusion: null,
            },
          ],
        })),
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 128);
    assert.equal(status.workers.length, 128);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports worker error and recovery rates from completed job steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    completedReviewRun(4, 300, "success", 60_000),
    completedReviewRun(3, 200, "success", 120_000),
    completedReviewRun(2, 100, "success", 180_000),
    completedReviewRun(1, 100, "success", 240_000),
  ];
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({
        workflow_runs:
          url.searchParams.get("status") === "completed"
            ? runs
            : url.searchParams.has("status")
              ? []
              : runs,
      });
    }
    const jobMatch = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/jobs$/,
    );
    if (jobMatch) {
      jobRequests += 1;
      const runId = Number(jobMatch[1]);
      const itemNumber = runId === 1 || runId === 2 ? 100 : runId === 3 ? 200 : 300;
      const failed = runId === 1 || runId === 3;
      const run = runs.find((candidate) => candidate.id === runId);
      const runStartedAt = Date.parse(run?.created_at || "");
      const jobStartedAt = new Date(runStartedAt + 1_000).toISOString();
      const reviewStartedAt = new Date(runStartedAt + 3_000).toISOString();
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard 0 · openclaw/openclaw#${itemNumber}`,
            status: "completed",
            conclusion: runId === 4 ? "neutral" : "success",
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: jobStartedAt,
            completed_at: run?.updated_at,
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
                started_at: jobStartedAt,
                completed_at: reviewStartedAt,
              },
              {
                number: 2,
                name: "Review shard",
                status: "completed",
                conclusion: failed ? "failure" : "success",
                started_at: reviewStartedAt,
                completed_at: run?.updated_at,
              },
            ],
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
      STATUS_STORE: new MemoryKv(),
    };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.health.attempts, 4);
    assert.equal(status.health.successful_attempts, 2);
    assert.equal(status.health.failed_attempts, 2);
    assert.equal(status.health.recovered_failures, 1);
    assert.equal(status.health.unresolved_failures, 1);
    assert.equal(status.health.error_rate_percent, 50);
    assert.equal(status.health.recovery_rate_percent, 50);
    assert.equal(status.bay.tide_threshold, 20);
    assert.equal(status.bay.tide_generation, 0);
    assert.equal(status.bay.terminal_count, 3);
    assert.equal(status.bay.timings.lanes, undefined);
    assert.deepEqual(status.bay.timings.overall, { average_ms: null, samples: 0 });
    assert.deepEqual(
      status.bay.terminal_buffer.map((item: { number: number }) => item.number),
      [100, 200, 300],
    );
    assert.equal(status.health.recent_attempts, undefined);
    assert.equal(status.health.failures[0].item_numbers[0], 200);
    assert.equal(status.health.failures[0].recovered, false);
    assert.equal(status.health.failures[0].failed_step, "Review shard");
    assert.equal(status.health.failures[1].item_numbers[0], 100);
    assert.equal(status.health.failures[1].recovered, true);
    assert.equal(jobRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes scheduled cluster intake markers and runs", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const marker = {
    target_repo: "openclaw/openclaw",
    last_processed_store_sha256: "abc123def4567890",
    last_processed_store_exported_at: "2026-05-25T12:00:00Z",
    generated_count: 1,
    generated_jobs: ["jobs/openclaw/inbox/gitcrawl-42-login-fix.md"],
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    updated_at: "2026-05-25T12:08:00Z",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 42,
            name: "repair cluster intake",
            display_title: "repair cluster intake",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
            created_at: "2026-05-25T12:08:00Z",
            updated_at: "2026-05-25T12:09:00Z",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/cluster-repair-intake/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(marker)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.cluster_repair.workflow, "repair-cluster-intake.yml");
    assert.equal("schedule" in status.recent.cluster_repair, false);
    assert.equal(status.recent.cluster_repair.markers[0].status, "imported");
    assert.equal(status.recent.cluster_repair.markers[0].generated_count, 1);
    assert.equal(
      status.recent.cluster_repair.markers[0].last_processed_store_short_sha,
      "abc123def4",
    );
    assert.equal(status.recent.cluster_repair.latest_runs[0].url, marker.run_url);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes apply health from sweep status without broad scans", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const sweepStatus = {
    target_repo: "openclaw/openclaw",
    state: "Apply finished",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
    updated_at: "2026-07-03T10:15:00Z",
    apply_health: {
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/98",
      mode: "close",
      status: "needs_attention",
      summary:
        "4 examined; 2/2 action records; 0 closed, 0 comments synced, 2 skipped; no cursor recorded.",
      examined: 4,
      action_records: 2,
      processed: 2,
      processed_limit: 2,
      close_limit: 5,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      cursor_required: true,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
      lanes: {
        closure: {
          processed: 2,
          closed: 0,
          comment_synced: 0,
          skipped: 2,
          skip_reasons: {
            skipped_changed_since_review: 2,
          },
        },
        comment_sync: {
          processed: 0,
          closed: 0,
          comment_synced: 0,
          skipped: 0,
          skip_reasons: {},
        },
      },
      next_actions: [
        {
          reason: "skipped_changed_since_review",
          count: 2,
          bucket: "review_refresh",
          owner: "clawsweeper",
          retryable: true,
          label: "Refresh review",
          summary: "The item changed after the review that proposed closing it.",
          next_step: "Queue a fresh ClawSweeper review before any close retry.",
        },
      ],
      next_action_buckets: {
        review_refresh: 2,
      },
      cycle: {
        basis: "scheduled_close_cursor",
        apply_ready_count: 1200,
        candidate_counts: {
          confirmed_proposal: 4,
          guarded_retry: 2,
          proof_required: 3,
          promotion_total: 1194,
          promotion_eligible: 1,
          promotion_cooldown_eligible: 420,
          cooldown_eligible_total: 427,
          inconsistent_or_stale: 1,
        },
        window_size: 300,
        estimated_full_cycle_windows: 4,
        estimated_full_cycle_minutes: null,
        scheduled_interval_minutes: null,
        label:
          "1200 close candidates (confirmed proposals plus live promotion probes) at 300 records per latest cursor advance: about 4 windows.",
      },
      attention_reasons: ["cursor_required_but_missing_after_full_window"],
      cursor: null,
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/sweep-status/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(sweepStatus)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.apply_health.attention_count, 1);
    assert.equal(status.recent.apply_health.items[0].status, "needs_attention");
    assert.equal(
      status.recent.apply_health.items[0].run_url,
      "https://github.com/openclaw/clawsweeper/actions/runs/98",
    );
    assert.equal(status.recent.apply_health.items[0].examined, 4);
    assert.equal(status.recent.apply_health.items[0].action_records, 2);
    assert.equal(status.recent.apply_health.items[0].processed, 2);
    assert.equal(status.recent.apply_health.items[0].cursor_required, true);
    assert.deepEqual(status.recent.apply_health.items[0].skip_reasons, {
      skipped_changed_since_review: 2,
    });
    assert.deepEqual(status.recent.apply_health.items[0].lanes.closure, {
      processed: 2,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
    });
    assert.equal(status.recent.apply_health.items[0].lanes.comment_sync.processed, 0);
    assert.deepEqual(status.recent.apply_health.items[0].next_action_buckets, {
      review_refresh: 2,
    });
    assert.equal(
      status.recent.apply_health.items[0].next_actions[0].next_step,
      "Queue a fresh ClawSweeper review before any close retry.",
    );
    assert.equal(status.recent.apply_health.items[0].cycle.estimated_full_cycle_minutes, null);
    assert.equal(status.recent.apply_health.items[0].cycle.apply_ready_count, 1200);
    assert.deepEqual(status.recent.apply_health.items[0].cycle.candidate_counts, {
      confirmed_proposal: 4,
      guarded_retry: 2,
      proof_required: 3,
      promotion_total: 1194,
      promotion_eligible: 1,
      promotion_cooldown_eligible: 420,
      cooldown_eligible_total: 427,
      inconsistent_or_stale: 1,
    });
    assert.equal(status.recent.apply_health.items[0].cursor, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reads stored CI status for active PR rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          status: "green",
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "green",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 0,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].repository, "openclaw/openclaw");
    assert.equal(status.pipeline[0].item_number, 80609);
    assert.equal(status.pipeline[0].ci.state, "green");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.total, 12);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard falls back to edge cache storage when KV is not bound", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "pending",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 2,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.pending, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard serves stale status while coalescing one background refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/status-cache/v3/stale"),
    jsonResponse({
      schema_version: 1,
      generated_at: "2026-06-13T18:00:00Z",
      source: {
        clawsweeper_repo: "openclaw/clawsweeper",
        target_repositories: ["openclaw/openclaw"],
      },
      fleet: { active_workflow_runs: 1 },
      workers: [],
      pipeline: [{ id: "stale-row" }],
      exact_review_queue: {
        pending: 1,
        dispatching: 1,
        leased: 0,
        handoff_health: { status: "stalled" },
      },
      diagnostics: { errors: [], exact_review_queue_error: null },
    }),
  );

  const currentQueue = {
    pending: 7,
    dispatching: 0,
    leased: 28,
    storage_schema_version: 1,
    handoff_health: {
      status: "healthy",
      reason: "handoff_current",
      phases: {
        pending: { count: 7 },
        dispatching: { count: 0 },
        leased: { count: 28 },
      },
    },
  };
  let queueReads = 0;
  const exactReviewQueue = new MemoryDurableNamespace({
    fetch: async () => {
      queueReads += 1;
      return jsonResponse(currentQueue);
    },
  });

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let unfilteredRunRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    await fetchGate;
    if (url.pathname.includes("/actions/")) {
      if (url.pathname.endsWith("/actions/runs") && !url.searchParams.has("status")) {
        unfilteredRunRequests += 1;
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "20",
      EXACT_REVIEW_QUEUE: exactReviewQueue,
    };
    const context = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const [first, second] = await Promise.all([
      worker.fetch(request, env, context),
      worker.fetch(request, env, context),
    ]);

    assert.equal(first.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal(second.headers.get("x-clawsweeper-cache"), "stale");
    const firstStatus = await first.json();
    const secondStatus = await second.json();
    assert.equal(firstStatus.pipeline[0].id, "stale-row");
    assert.equal(firstStatus.exact_review_queue.pending, 1);
    assert.equal(firstStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(secondStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(queueReads, 0);
    assert.equal(waitUntilPromises.length, 2);

    releaseFetch();
    await Promise.all(waitUntilPromises);
    assert.equal(unfilteredRunRequests, 1);
    assert.equal(queueReads, 1);

    const refreshed = await worker.fetch(request, env);
    assert.equal(refreshed.headers.get("x-clawsweeper-cache"), "fresh");
    const refreshedStatus = await refreshed.json();
    assert.deepEqual(refreshedStatus.pipeline, []);
    assert.equal(refreshedStatus.exact_review_queue.pending, 7);
    assert.equal(refreshedStatus.exact_review_queue.handoff_health.status, "healthy");
    assert.equal(queueReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard status survives cache persistence failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async (request: Request) => {
          if (
            request.url.includes("/api/status-cache/") ||
            request.url.includes("recent-automerge") ||
            request.url.includes("recent-closed")
          ) {
            throw new Error("cache unavailable");
          }
        },
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-clawsweeper-cache"), "miss");
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard parallelizes and caches historical GitHub telemetry", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let closedRequests = 0;
  let activeDetails = 0;
  let maxActiveDetails = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102, 103, 104].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      activeDetails += 1;
      maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDetails -= 1;
      if (url.pathname.includes("/comments")) {
        return jsonResponse([
          {
            body: "@clawsweeper automerge",
            created_at: "2026-06-13T18:00:00Z",
          },
        ]);
      }
      return jsonResponse({
        merged_at: "2026-06-13T18:01:00Z",
        merge_commit_sha: "abc123",
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      closedRequests += 1;
      return jsonResponse([]);
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const env = {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await worker.fetch(request, env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).averages.automerge_samples, 4);
    assert.ok(maxActiveDetails >= 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await worker.fetch(request, env);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).averages.automerge_samples, 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports automerge worker reliability independently of merged PR timing", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let reliabilityRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      reliabilityRequests += 1;
      const workflowRun = (
        id: number,
        number: number,
        conclusion: "failure" | "success",
        createdAt: string,
        updatedAt: string,
      ) => ({
        id,
        display_title: `automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-${number}.md`,
        status: "completed",
        conclusion,
        html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return jsonResponse({
        workflow_runs: [
          workflowRun(
            29431617465,
            107691,
            "failure",
            "2026-07-15T16:15:04Z",
            "2026-07-15T16:34:51Z",
          ),
          workflowRun(
            29434021623,
            107691,
            "success",
            "2026-07-15T16:49:45Z",
            "2026-07-15T16:51:53Z",
          ),
          workflowRun(
            29435000000,
            107692,
            "failure",
            "2026-07-15T17:00:00Z",
            "2026-07-15T17:10:00Z",
          ),
        ],
      });
    }
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    const reliability = status.recent.automerge_reliability;
    assert.equal(reliabilityRequests, 1);
    assert.equal(reliability.sampled_runs, 3);
    assert.equal(reliability.failure_rate_percent, 66.7);
    assert.equal(reliability.recovered_failures, 1);
    assert.equal(reliability.unresolved_failures, 1);
    assert.deepEqual(
      reliability.failures.map((failure: { number: number; status: string }) => [
        failure.number,
        failure.status,
      ]),
      [
        [107692, "unresolved"],
        [107691, "recovered"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard batches recent automerge hydration with GraphQL when authenticated", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let graphqlRequests = 0;
  let restDetailRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            pr0: {
              mergedAt: "2026-06-13T18:01:00Z",
              mergeCommit: { oid: "abc101" },
              comments: {
                nodes: [
                  {
                    body: "@clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:30Z",
                  },
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:00Z",
                  },
                ],
              },
            },
            pr1: {
              mergedAt: "2026-06-13T18:04:00Z",
              mergeCommit: { oid: "abc102" },
              comments: {
                nodes: [
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:02:00Z",
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      restDetailRequests += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "-1",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.averages.automerge_samples, 2);
    assert.equal(status.averages.automerge_command_to_merge_ms, 90_000);
    assert.equal(searchRequests, 1);
    assert.equal(graphqlRequests, 1);
    assert.equal(restDetailRequests, 0);
    assert.deepEqual(
      status.recent.automerge.map((item: { number: number; merge_commit_sha: string }) => [
        item.number,
        item.merge_commit_sha,
      ]),
      [
        [101, "abc101"],
        [102, "abc102"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard preserves repeated untargeted activity events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    for (const title of ["Probe one", "Probe two"]) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event_type: "status.test",
            mode: "test",
            stage: "probe",
            status: "ok",
            title,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.events
        .filter((event: { event_type: string }) => event.event_type === "status.test")
        .map((event: { title: string }) => event.title)
        .sort(),
      ["Probe one", "Probe two"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts cluster-fixer operation events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const events = [
      { event_type: "clawsweeper.replacement_label_cleanup", stage: "executed" },
      { event_type: "clawsweeper.clawsweeper_self_rebase", stage: "dispatched" },
      { event_type: "clawsweeper.dispatched_failed_review_retry", stage: "dispatched" },
      { event_type: "clawsweeper.marked_failed_review_retry_exhausted", stage: "exhausted" },
      { event_type: "clawsweeper.bot_proof_decision_posted", stage: "posted" },
      { event_type: "clawsweeper.bot_proof_mantis_request_posted", stage: "posted" },
    ];
    for (const event of events) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "operation",
            status: "ok",
            ...event,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(status.recent.operation_counts, {
      inherited_label_cleanups: 1,
      self_heal_conflict_repairs: 1,
      failed_review_retries: 1,
      failed_review_retry_exhaustions: 1,
      bot_owned_proof_decisions_requested: 1,
      bot_owned_proof_dispatches: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps workflow CI status when live PR checks fail", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/repos/openclaw/openclaw/pulls/80609")) {
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "workflow");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reuses live PR CI hydration within one status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    {
      id: 8060901,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060901",
      created_at: isoAgo(120_000),
      updated_at: isoAgo(10_000),
    },
    {
      id: 8060902,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060902",
      created_at: isoAgo(90_000),
      updated_at: isoAgo(5_000),
    },
  ];
  let pullRequests = 0;
  let checkRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/80609") {
      pullRequests += 1;
      return jsonResponse({ head: { sha: "head-80609" } });
    }
    if (url.pathname === "/repos/openclaw/openclaw/commits/head-80609/check-runs") {
      checkRequests += 1;
      return jsonResponse({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(pullRequests, 1);
    assert.equal(checkRequests, 1);
    assert.deepEqual(
      status.pipeline.map((row: { ci: { source: string; state: string } }) => row.ci),
      [
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts active runs that are older than the latest unfiltered page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "recent completed run",
              display_title: "recent completed run",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: "2026-05-14T06:40:00Z",
              updated_at: "2026-05-14T06:41:00Z",
            },
          ],
        });
      }
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81001",
              display_title: "Review event item openclaw/openclaw#81001",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(25 * 60_000),
              updated_at: isoAgo(20 * 60_000),
            },
            {
              id: 3,
              name: "Commit review openclaw/openclaw@abc123",
              display_title: "Commit review openclaw/openclaw@abc123",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/3",
              created_at: isoAgo(20 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
            {
              id: 5,
              name: "spam comment intake",
              display_title: "github_activity",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/5",
              created_at: isoAgo(18 * 60_000),
              updated_at: isoAgo(16 * 60_000),
            },
            {
              id: 6,
              name: "ClawSweeper Live Dashboard CI Status",
              display_title: "ClawSweeper Live Dashboard CI Status",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/6",
              created_at: isoAgo(17 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
          ],
        });
      }
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 4,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/4",
              created_at: isoAgo(30 * 60_000),
              updated_at: isoAgo(29 * 60_000),
            },
            {
              id: 7,
              name: "github activity to openclaw",
              display_title: "github_activity",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/7",
              created_at: isoAgo(31 * 60_000),
              updated_at: isoAgo(30 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 3);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.fleet.support_workflow_runs, 3);
    assert.equal(status.fleet.support_queued_workflow_runs, 1);
    assert.equal(status.fleet.worker_budget, 128);
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2, 4, 3],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard hides stale queue ghosts without suppressing queue health", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) return jsonResponse({ workflow_runs: [] });
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "ClawSweeper Commit Review",
              display_title: "clawsweeper_commit_review",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: isoAgo(7 * 24 * 60 * 60_000),
              updated_at: isoAgo(7 * 24 * 60 * 60_000),
            },
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(10 * 60_000),
              updated_at: isoAgo(9 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.operational_health.queued_runs, 2);
    assert.equal(status.operational_health.queued_over_threshold, 1);
    assert.equal(status.operational_health.status, "degraded");
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health retains in-progress runs beyond the queued ghost window", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 8,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "in_progress",
              created_at: isoAgo(8 * 60 * 60_000),
              run_started_at: isoAgo(7 * 60 * 60_000),
              updated_at: isoAgo(60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.operational_health.status, "stalled");
    assert.equal(status.operational_health.running_over_threshold, 1);
    assert.equal(status.operational_health.oldest_running_minutes, 420);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes ClawSweeper-owned recent closes and 24h stats", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    const olderClosedAt = new Date(Date.now() - 120_000).toISOString();
    const oldestClosedAt = new Date(Date.now() - 180_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues" &&
      url.searchParams.get("page") === "1"
    ) {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([
        {
          number: 81,
          title: "Fix stale terminal resize state",
          html_url: "https://github.com/openclaw/openclaw/pull/81",
          closed_at: olderClosedAt,
          closed_by: { login: "clawsweeper[bot]" },
          pull_request: {},
        },
        {
          number: 82,
          title: "Alternate app closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/82",
          closed_at: oldestClosedAt,
          closed_by: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          number: 80,
          title: "Remove old session warning",
          html_url: "https://github.com/openclaw/openclaw/issues/80",
          closed_at: closedAt,
          closed_by: { login: "clawsweeper[bot]" },
        },
        {
          number: 79,
          title: "Human closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/79",
          closed_at: closedAt,
          closed_by: { login: "steipete" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/80",
          title: "Real close event",
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);
    const prClose = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/81",
          title: "Explicit PR close event",
        }),
      }),
      env,
    );
    assert.equal(prClose.status, 200);
    const blocked = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.close_blocked",
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/82",
          title: "Blocked close event",
        }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.closed_items.map(
        (item: { type: string; number: number; closed_by: string }) => ({
          type: item.type,
          number: item.number,
          closed_by: item.closed_by,
        }),
      ),
      [
        { type: "Issue", number: 80, closed_by: "clawsweeper[bot]" },
        { type: "PR", number: 81, closed_by: "clawsweeper[bot]" },
        { type: "Issue", number: 82, closed_by: "openclaw-clawsweeper[bot]" },
      ],
    );
    assert.deepEqual(
      status.recent.events.map(
        (event: {
          mode: string;
          stage: string;
          status: string;
          item_number: number;
          source: string;
          title: string;
        }) => ({
          mode: event.mode,
          stage: event.stage,
          status: event.status,
          item_number: event.item_number,
          source: event.source,
          title: event.title,
        }),
      ),
      [
        {
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          item_number: undefined,
          source: undefined,
          title: "Blocked close event",
        },
        {
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Explicit PR close event",
        },
        {
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Real close event",
        },
        {
          mode: "closed",
          stage: "Issue",
          status: "closed",
          item_number: 82,
          source: "closed_items",
          title: "Alternate app closed issue",
        },
      ],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 3,
      issues: 2,
      prs: 1,
      by_repository: {
        "openclaw/openclaw": {
          total: 3,
          issues: 2,
          prs: 1,
        },
      },
    });
    assert.ok(new Date(status.recent.closed_stats.since).getTime() <= Date.now());
    assert.deepEqual(issuePages, ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard fetches additional closed pages only when the first page is full", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      const page = url.searchParams.get("page") || "";
      issuePages.push(page);
      if (page === "1") {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            title: `Human closed issue ${index + 1}`,
            html_url: `https://github.com/openclaw/openclaw/issues/${index + 1}`,
            closed_at: closedAt,
            closed_by: { login: "steipete" },
          })),
        );
      }
      if (page === "2") {
        return jsonResponse([
          {
            number: 101,
            title: "ClawSweeper closed overflow page issue",
            html_url: "https://github.com/openclaw/openclaw/issues/101",
            closed_at: closedAt,
            closed_by: { login: "clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      issuePages.sort((left, right) => Number(left) - Number(right)),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 1,
      issues: 1,
      prs: 0,
      by_repository: {
        "openclaw/openclaw": {
          total: 1,
          issues: 1,
          prs: 0,
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused views use direct search when broad snapshot is capped", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let readyPerPage = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        readyPerPage = url.searchParams.get("per_page") || "";
        return jsonResponse({
          total_count: 2,
          items: [
            triageIssue(102, ["clawsweeper:queueable-fix", "impact:message-loss"]),
            triageIssue(100, ["clawsweeper:queueable-fix"]),
          ],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const root = snapshot.views.find((view: { id: string }) => view.id === "clawsweeper");
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(root.item_limit, 500);
    assert.equal(ready.total_count, 2);
    assert.equal(ready.item_limit, 100);
    assert.equal(readyPerPage, "100");
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102, 100],
    );
    assert.deepEqual(
      ready.items[0].routing_groups.map((group: { id: string }) => group.id),
      ["message-delivery"],
    );
    assert.deepEqual(
      ready.items[1].routing_groups.map((group: { id: string }) => group.id),
      ["unclassified"],
    );
    assert.equal(ready.loaded_routing_group_counts["message-delivery"], 1);
    assert.equal(ready.loaded_routing_group_counts.unclassified, 1);
    assert.ok(snapshot.routing_groups.some((group: { id: string }) => group.id === "state-data"));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused fallbacks reserve search budget for later repos", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let sawSecondRepoLastRootPage = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      const repo = query.includes("repo:openclaw/other") ? "openclaw/other" : "openclaw/openclaw";
      if (repo === "openclaw/other" && page === "4") {
        sawSecondRepoLastRootPage = true;
      }
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        return jsonResponse({
          total_count: 1,
          items: [triageIssue(repo, 200, ["clawsweeper:queueable-fix"])],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 401,
          items: [triageIssue(repo, Number(page), ["clawsweeper:queueable-fix"])],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: "openclaw/openclaw,openclaw/other",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.equal(sawSecondRepoLastRootPage, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused search errors fall back to loaded broad rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        throw new Error("focused search failed");
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(ready.total_count, 1);
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102],
    );
    assert.match(snapshot.diagnostics.errors.join("\n"), /focused search failed/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage skips repos after root search budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(searchRequests, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage debits failed root searches from the search budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      throw new Error("root search failed");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage uses ClawSweeper GitHub App credentials when no static token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let sawAppJwt = false;
  let sawInstallationToken = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse([{ name: "clawsweeper:queueable-fix", color: "0E8A16" }]);
    }
    if (url.pathname === "/search/issues") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(101, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.equal(snapshot.source.search_request_budget_remaining, 27);
    assert.equal(sawAppJwt, true);
    assert.equal(sawInstallationToken, true);
    assert.doesNotMatch(snapshot.diagnostics.errors.join("\n"), /GITHUB_TOKEN/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("hosted webhook accepts author read-only mention commands", async () => {
  for (const body of [
    "@clawsweeper Re-run",
    "@clawsweeper\nre-review based on latest comments",
    "The issue may already be fixed.\n@clawsweeper re-review based on latest comments\nThanks.",
  ]) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 76991, user: { login: "contributor" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body,
            author_association: "CONTRIBUTOR",
            user: { login: "contributor" },
          },
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
    );
    assert.equal(response.status, 503, `${body} should pass classification before app config`);
    assert.deepEqual(await response.json(), { error: "github_app_not_configured" });
  }
});

test("hosted webhook ignores inline ClawSweeper mentions before fast ack", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issue_comment",
      secret: "test-secret",
      payload: {
        action: "created",
        repository: {
          full_name: "openclaw/openclaw",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 87801, user: { login: "issue-author" } },
        installation: { id: 123 },
        comment: {
          id: 456,
          body: "the closed PR 87835 was closed as already implemented by PR 87890 @clawsweeper re-review and if necessary close this issue",
          author_association: "MEMBER",
          user: { login: "brokemac79" },
        },
      },
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "no routable ClawSweeper command",
  });
});

test("hosted webhook returns invalid_json for signed malformed bodies", async () => {
  const response = await worker.fetch(
    signedGithubWebhookBodyRequest({
      event: "issue_comment",
      secret: "test-secret",
      body: "{",
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("hosted webhook rejects label additions before exact-review intake", async () => {
  for (const sender of ["openclaw-clawsweeper[bot]", "openclaw-barnacle[bot]", "steipete"]) {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issues",
        secret: "test-secret",
        payload: {
          action: "labeled",
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 76991 },
          installation: { id: 123 },
          label: { name: "status: ready for maintainer look" },
          sender: { login: sender },
        },
      }),
      { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      reason: "unsupported action",
    });
  }
});

test("hosted webhook enqueues item events with the repository default branch", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "opened",
        repository: {
          full_name: "openclaw/gogcli",
          default_branch: "trunk",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 597 },
        installation: { id: 123 },
      },
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
  });
});

test("hosted webhook requeues unlocked and close-guard removal events", async () => {
  const closeGuardLabels = [
    "security",
    "beta-blocker",
    "release-blocker",
    "maintainer",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:automerge",
    "clawsweeper:autofix",
  ];
  const cases = [
    { event: "issues", action: "unlocked" },
    { event: "pull_request", action: "unlocked" },
    ...closeGuardLabels.flatMap((name) => [
      { event: "issues", action: "unlabeled", label: { name } },
      { event: "pull_request", action: "unlabeled", label: { name } },
    ]),
  ];
  for (const [index, { event, action, label }] of cases.entries()) {
    const number = 598 + index;
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue({ storage }, {});
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event,
        secret: "test-secret",
        payload: {
          action,
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          ...(event === "issues" ? { issue: { number } } : { pull_request: { number } }),
          ...(label ? { label } : {}),
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      queued: true,
      item_key: `openclaw/gogcli#${number}`,
    });
    const stored = (await storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { sourceAction: string; supersedesInProgress: boolean } }>;
    };
    assert.equal(stored.items[`openclaw/gogcli#${number}`].decision.sourceAction, action);
    assert.equal(stored.items[`openclaw/gogcli#${number}`].decision.supersedesInProgress, true);
  }
});

test("hosted webhook ignores removal of non-close-guard labels", async () => {
  const response = await worker.fetch(
    signedGithubWebhookRequest({
      event: "issues",
      secret: "test-secret",
      payload: {
        action: "unlabeled",
        repository: {
          full_name: "openclaw/gogcli",
          default_branch: "trunk",
          private: false,
          archived: false,
          fork: false,
          has_issues: true,
        },
        issue: { number: 602 },
        label: { name: "clawsweeper:queueable-fix" },
        installation: { id: 123 },
      },
    }),
    { CLAWSWEEPER_WEBHOOK_SECRET: "test-secret" },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    accepted: false,
    reason: "unsupported action",
  });
});

test("hosted webhook reuses existing fast ack comments on redelivery", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchBody: unknown = null;
  let postedAck = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      assert.equal(url.searchParams.get("per_page"), "100");
      return jsonResponse([
        {
          id: 777,
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      postedAck = true;
      return jsonResponse({ id: 888 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(authorization, "Bearer dispatch-token");
      dispatchBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper status",
            updated_at: "2026-07-12T20:00:00Z",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(postedAck, false);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/gogcli",
        target_branch: "trunk",
        item_number: 597,
        comment_id: 456,
        status_comment_id: 777,
        source_event: "issue_comment",
        source_action: "created",
        comment_event_auth: "github_webhook_v1",
        comment_updated_at: "2026-07-12T20:00:00Z",
        comment_body_sha256: createHash("sha256").update("@clawsweeper status").digest("hex"),
      },
    });
    assert.equal(
      Object.keys((dispatchBody as { client_payload: Record<string, unknown> }).client_payload)
        .length,
      10,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook coalesces concurrent duplicate fast ack comments", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const comments: Array<{ id: number; body: string; created_at: string; user: { login: string } }> =
    [];
  const dispatchBodies: unknown[] = [];
  let fastAckPosts = 0;
  let reactions = 0;
  let releaseAckPost: (() => void) | undefined;
  let markAckPostStarted: (() => void) | undefined;
  const ackPostRelease = new Promise<void>((resolve) => {
    releaseAckPost = resolve;
  });
  const ackPostStarted = new Promise<void>((resolve) => {
    markAckPostStarted = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      assert.equal(authorization, "Bearer target-token");
      return jsonResponse([...comments]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      assert.equal(authorization, "Bearer target-token");
      fastAckPosts += 1;
      markAckPostStarted?.();
      await ackPostRelease;
      const body = JSON.parse(String(init.body || "{}"));
      const comment = {
        id: 777,
        body: String(body.body || ""),
        created_at: "2026-05-28T13:00:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.push(comment);
      return jsonResponse(comment);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      assert.equal(authorization, "Bearer target-token");
      reactions += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(authorization, "Bearer dispatch-token");
      dispatchBodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const payload = {
    action: "created",
    repository: {
      full_name: "openclaw/gogcli",
      default_branch: "trunk",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    issue: { number: 597, user: { login: "steipete" } },
    installation: { id: 123 },
    comment: {
      id: 456,
      body: "@clawsweeper build",
      author_association: "OWNER",
      user: { login: "steipete" },
    },
  };
  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
  };

  try {
    const left = worker.fetch(
      signedGithubWebhookRequest({ event: "issue_comment", secret: "test-secret", payload }),
      env,
    );
    const right = worker.fetch(
      signedGithubWebhookRequest({ event: "issue_comment", secret: "test-secret", payload }),
      env,
    );
    await ackPostStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseAckPost?.();
    const [leftResponse, rightResponse] = await Promise.all([left, right]);

    assert.equal(leftResponse.status, 202);
    assert.equal(rightResponse.status, 202);
    assert.deepEqual(await leftResponse.json(), { ok: true, status_comment_id: 777 });
    assert.deepEqual(await rightResponse.json(), { ok: true, status_comment_id: 777 });
    assert.equal(fastAckPosts, 1);
    assert.equal(reactions, 2);
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body || "", /clawsweeper-command-ack:456/);
    assert.equal(dispatchBodies.length, 2);
    assert.deepEqual(
      dispatchBodies.map(
        (body) =>
          (body as { client_payload?: { status_comment_id?: unknown } }).client_payload
            ?.status_comment_id,
      ),
      [777, 777],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook removes duplicate fast ack comments after concurrent redelivery", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let commentLookups = 0;
  let deletedAck = 0;
  let dispatchBody: unknown = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      commentLookups += 1;
      if (commentLookups === 1) return jsonResponse([]);
      return jsonResponse([
        {
          id: 777,
          created_at: "2026-05-24T00:00:00Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 888,
          created_at: "2026-05-24T00:00:01Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "POST") {
      return jsonResponse({ id: 888 });
    }
    if (
      url.pathname === "/repos/openclaw/gogcli/issues/comments/888" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 888;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper build",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(deletedAck, 888);
    assert.equal(commentLookups, 2);
    assert.deepEqual(dispatchBody, {
      event_type: "clawsweeper_comment",
      client_payload: {
        target_repo: "openclaw/gogcli",
        target_branch: "trunk",
        item_number: 597,
        comment_id: 456,
        status_comment_id: 777,
        source_event: "issue_comment",
        source_action: "created",
      },
    });
    assert.ok(
      Object.keys((dispatchBody as { client_payload: Record<string, unknown> }).client_payload)
        .length <= 10,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted webhook schedules post-dispatch fast ack cleanup", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let commentLookups = 0;
  let deletedAck = 0;
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "target-token" });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/597/comments" && init?.method === "GET") {
      commentLookups += 1;
      if (commentLookups <= 2) {
        return jsonResponse([
          {
            id: 777,
            created_at: "2026-05-28T13:00:00Z",
            body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
            user: { login: "openclaw-clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([
        {
          id: 777,
          created_at: "2026-05-28T13:00:00Z",
          body: "<!-- clawsweeper-command-ack:456 -->\nClawSweeper picked this up.",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 888,
          created_at: "2026-05-28T13:00:01Z",
          updated_at: "2026-05-28T13:00:02Z",
          body: [
            "<!-- clawsweeper-command-status:597:implement_issue:abc123 -->",
            "<!-- clawsweeper-command-ack:456 -->",
            "ClawSweeper issue implementation requested.",
            "<!-- clawsweeper-command-progress:start -->",
            "Implementation progress:",
            "- State: In progress",
            "<!-- clawsweeper-command-progress:end -->",
          ].join("\n"),
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    }
    if (
      url.pathname === "/repos/openclaw/gogcli/issues/comments/777" &&
      init?.method === "DELETE"
    ) {
      deletedAck = 777;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/gogcli/issues/comments/456/reactions") {
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "issue_comment",
        secret: "test-secret",
        payload: {
          action: "created",
          repository: {
            full_name: "openclaw/gogcli",
            default_branch: "trunk",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          issue: { number: 597, user: { login: "steipete" } },
          installation: { id: 123 },
          comment: {
            id: 456,
            body: "@clawsweeper build",
            author_association: "OWNER",
            user: { login: "steipete" },
          },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0,0,0",
      },
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, status_comment_id: 777 });
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
    assert.equal(deletedAck, 777);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard shares in-flight GitHub App installation token across parallel requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let tokenRequests = 0;
  let badBearer = "";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      tokenRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.hostname === "api.github.com") {
      if (authorization !== "Bearer installation-token") badBearer = authorization;
      if (url.pathname.endsWith("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      if (url.pathname === "/search/issues") return jsonResponse({ total_count: 0, items: [] });
      if (url.pathname.endsWith("/issues")) return jsonResponse([]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23parallel",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(tokenRequests, 1);
    assert.equal(badBearer, "");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard html preserves client compactText regex escapes", async () => {
  const response = await worker.fetch(new Request("https://example.test/"));
  const body = await response.text();
  const match = body.match(/function compactText\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "compactText function should render in dashboard html");
  const compactText = new Function(`${match[0]}; return compactText;`)() as (
    value: unknown,
  ) => string;

  assert.equal(
    compactText("1234567890abcdef1234567890abcdef\n\t repeated   spaces"),
    "1234567890 repeated spaces",
  );
});

async function activePrFetch(input: RequestInfo | URL) {
  const url = String(input);
  if (url.includes("/actions/workflows/repair-cluster-worker.yml/runs")) {
    return jsonResponse({ workflow_runs: [] });
  }
  if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
    return jsonResponse({
      workflow_runs: [
        {
          id: 1,
          name: "ClawSweeper",
          display_title: "Review event item openclaw/openclaw#80609",
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
  }
  if (url.includes("/repos/openclaw/openclaw/issues")) return jsonResponse([]);
  if (url.includes("/search/issues")) return jsonResponse({ items: [] });
  throw new Error(`unexpected fetch ${url}`);
}

function triageIssue(number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(repo: string, number: number, labelNames: string[]): Record<string, unknown>;
function triageIssue(
  repoOrNumber: string | number,
  numberOrLabels: number | string[],
  maybeLabels?: string[],
) {
  const repo = typeof repoOrNumber === "string" ? repoOrNumber : "openclaw/openclaw";
  const number = typeof repoOrNumber === "string" ? Number(numberOrLabels) : repoOrNumber;
  const labelNames = typeof repoOrNumber === "string" ? maybeLabels || [] : numberOrLabels;
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    created_at: `2026-05-01T00:${String(number % 60).padStart(2, "0")}:00Z`,
    updated_at: `2026-05-02T00:${String(number % 60).padStart(2, "0")}:00Z`,
    comments: 0,
    user: { login: "reporter" },
    assignees: [],
    labels: labelNames.map((name) => ({ name, color: "0E8A16" })),
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function signedGithubWebhookRequest({
  event,
  secret,
  payload,
}: {
  event: string;
  secret: string;
  payload: unknown;
}) {
  const body = JSON.stringify(payload);
  return signedGithubWebhookBodyRequest({ event, secret, body });
}

function signedGithubWebhookBodyRequest({
  event,
  secret,
  body,
}: {
  event: string;
  secret: string;
  body: string;
}) {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("https://clawsweeper.openclaw.ai/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "test-delivery",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

function stateAppendRecord(kind: string, key: string, payload: unknown) {
  return {
    kind,
    key,
    payload,
    produced_at: "2026-07-20T12:00:00.000Z",
  };
}

function stateAppendPayload(deliveryId: string, kind: string, key: string) {
  return {
    delivery_id: deliveryId,
    records: [stateAppendRecord(kind, key, { delivery_id: deliveryId })],
  };
}

function stateAppendQueueRequest(path: string, payload: unknown, origin = "https://queue") {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function signedStateAppendRequest(path: string, payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request(`https://clawsweeper.openclaw.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
}

function buildExactReviewQueueRequest(
  deliveryId: string,
  itemNumber: number,
  sourceAction: string,
  itemKind: "issue" | "pull_request" = "issue",
  targetRepo = "openclaw/gogcli",
  decisionOverrides: Record<string, unknown> = {},
) {
  const sourceEvent = itemKind === "issue" ? "issues" : "pull_request";
  return new Request("https://clawsweeper-exact-review-queue/enqueue", {
    method: "POST",
    body: JSON.stringify({
      delivery_id: deliveryId,
      decision: {
        targetRepo,
        targetBranch: "main",
        itemNumber,
        itemKind,
        sourceEvent,
        sourceAction,
        supersedesInProgress: sourceAction === "edited" || sourceAction === "synchronize",
        ...decisionOverrides,
      },
    }),
  });
}

function exactReviewPublicationOverrides(
  itemNumber: number,
  producerRunId: string,
  producerSourceAction = "opened",
) {
  const producerDecision = {
    targetRepo: "openclaw/gogcli",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: producerSourceAction,
    supersedesInProgress: false,
  };
  return {
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `openclaw/gogcli#${itemNumber}`,
      protocolVersion: 2,
      leaseRevision: 1,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  };
}

function leasedExactReviewQueueItem(itemNumber: number, runId: string, runAttempt = 1) {
  const now = Date.now();
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue" as const,
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    key: `openclaw/openclaw#${itemNumber}`,
    decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: 1,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    nextAttemptAt: now - 60_000,
    attempts: 0,
    leaseId: `lease-${itemNumber}`,
    leaseRevision: 1,
    leaseExpiresAt: now + 60 * 60_000,
    claimedRunId: runId,
    claimedRunAttempt: runAttempt,
    claimGeneration: 1,
    claimProtocolVersion: 2,
  };
}

function leasedExactReviewPublicationItem(itemNumber: number, runId: string) {
  const item = leasedExactReviewQueueItem(itemNumber, runId);
  const sourceAction = "exact_review_artifact_publish";
  const publication = {
    artifactName: `exact-review-${runId}-1`,
    producerRunId: runId,
    producerRunAttempt: 1,
    sourceSha: "a".repeat(40),
    itemKey: item.key,
    protocolVersion: 2 as const,
    leaseRevision: 1,
    claimGeneration: 1,
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
    producerDecision: item.decision,
  };
  return {
    ...item,
    key: `${item.key}@publish:${runId}:1`,
    decision: { ...item.decision, sourceAction, publication },
    leaseDecision: { ...item.leaseDecision, sourceAction, publication },
  };
}

test("state writer telemetry is optional, idempotent, and summary-safe", async () => {
  const storage = new MemoryDurableStorage();
  const items = Object.fromEntries(
    Array.from({ length: 2 }, (_, index) => {
      const item = leasedExactReviewPublicationItem(96_000 + index, `9600${index}`);
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  const telemetry = {
    schema_version: 1,
    operation_id: "batch:telemetry-test",
    mode: "batch",
    started_at: now,
    finished_at: now,
    wait_ms: 1,
    acquire_attempts: 1,
    acquired: true,
    hold_ms: 2,
    renewals: 0,
    released: true,
    git_duration_ms: 3,
    git_processes: 4,
    commit_count: 1,
    materialized_items: 2,
    configured_batch_size: 2,
    actual_batch_size: 2,
    batch_wait_ms: 1,
    outcome: "materialized",
  };
  for (const item of Object.values(items)) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
          outcome: "success",
          completion_kind: "published",
          reason_code: "publication_applied",
          state_writer: telemetry,
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.state_writer.last_15_minutes.operations, 1);
  assert.equal(stats.state_writer.last_15_minutes.state_commits, 1);
  assert.equal(stats.state_writer.last_15_minutes.materialized_items, 2);
  assert.equal(stats.state_writer.last_15_minutes.items_per_commit, 2);
  assert.equal(stats.state_writer.diagnostics.accepted_terminal_total, 1);
  assert.equal(stats.state_writer.diagnostics.duplicate_terminal_total, 1);
  assert.equal(stats.state_writer.diagnostics.state_commits_total, 1);
  assert.equal(stats.state_writer.diagnostics.materialized_items_total, 2);

  const malformed = leasedExactReviewPublicationItem(97_001, "97001");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [malformed.key]: malformed },
  });
  const rejected = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: malformed.leaseId,
        item_key: malformed.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: malformed.claimedRunId,
        run_attempt: 1,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        state_writer: { schema_version: 1, operation_id: "bad" },
      }),
    }),
  );
  assert.equal(rejected.status, 200);
  const afterReject = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(afterReject.state_writer.diagnostics.rejected_terminal_total, 1);

  const reviewOnly = leasedExactReviewQueueItem(97_002, "97002");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [reviewOnly.key]: reviewOnly },
  });
  const ignored = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: reviewOnly.leaseId,
        item_key: reviewOnly.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: reviewOnly.claimedRunId,
        run_attempt: 1,
        outcome: "success",
        state_writer: telemetry,
      }),
    }),
  );
  assert.equal(ignored.status, 200);
  const afterIgnore = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(afterIgnore.state_writer.last_15_minutes.operations, 1);
  assert.equal(afterIgnore.state_writer.diagnostics.rejected_terminal_total, 2);
});

function unclaimedExactReviewQueueItem(itemNumber: number) {
  return {
    ...leasedExactReviewQueueItem(itemNumber, "unclaimed"),
    state: "dispatching" as const,
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
    claimProtocolVersion: undefined,
  };
}

test("exact-review queue durably stores and queries per-item review telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const now = Date.now();
  const refreshing = {
    repo: "openclaw/openclaw",
    item_number: 674,
    run_id: "12345",
    run_attempt: 2,
    status: "refreshing",
    outcome: null,
    started_at: new Date(now - 60_000).toISOString(),
    updated_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + 60 * 60_000).toISOString(),
    phase_durations_ms: { queue: 10_000, claim: 2_000 },
  };
  const recorded = await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refreshing),
    }),
  );
  assert.equal(recorded.status, 200);

  const completed = {
    ...refreshing,
    status: "completed",
    outcome: "succeeded",
    updated_at: new Date(now - 10_000).toISOString(),
    lease_expires_at: null,
    phase_durations_ms: { ...refreshing.phase_durations_ms, review: 180_000, total: 250_000 },
    generation: 7,
    operation_id: "review:674:7",
  };
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify(completed),
    }),
  );
  // Neither a delayed heartbeat nor a conflicting terminal retry can rewrite
  // the first terminal truth.
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({ ...refreshing, updated_at: new Date(now).toISOString() }),
    }),
  );
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        ...completed,
        outcome: "failed",
        updated_at: new Date(now + 1_000).toISOString(),
      }),
    }),
  );

  const response = await queue.fetch(
    new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=674"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { reviews: unknown[] };
  assert.deepEqual(body.reviews, [completed]);

  const restarted = new ExactReviewQueue({ storage }, {});
  const afterRestart = await restarted.fetch(
    new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=674"),
  );
  assert.deepEqual((await afterRestart.json()) as { reviews: unknown[] }, {
    ok: true,
    repo: "openclaw/openclaw",
    item_number: 674,
    reviews: [completed],
  });
});

test("exact-review queue incrementally indexes the v1 review telemetry table", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_review_telemetry (
       repo TEXT NOT NULL,
       item_number INTEGER NOT NULL,
       run_id TEXT NOT NULL,
       run_attempt INTEGER NOT NULL,
       status TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       lease_expires_at INTEGER,
       record_json TEXT NOT NULL,
       PRIMARY KEY (repo, item_number, run_id, run_attempt)
     ) STRICT`,
  );
  const queue = new ExactReviewQueue({ storage }, {});
  const now = new Date().toISOString();
  const response = await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        repo: "openclaw/openclaw",
        item_number: 674,
        run_id: "44000",
        run_attempt: 1,
        status: "completed",
        outcome: "superseded",
        started_at: now,
        updated_at: now,
        lease_expires_at: null,
        phase_durations_ms: { total: 12_000 },
        generation: 2,
        operation_id: "review:674:2",
        trigger_lane: "exact_event",
        trigger_origin: "webhook",
        terminal_at: now,
        terminal_reason: "generation_superseded",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const columns = Array.from(
    storage.sql.exec(
      "SELECT name FROM pragma_table_info('exact_review_review_telemetry') ORDER BY name",
    ),
    (row) => row.name,
  );
  for (const column of [
    "generation",
    "operation_id",
    "outcome",
    "terminal_at",
    "total_ms",
    "trigger_lane",
    "trigger_origin",
  ]) {
    assert.ok(columns.includes(column));
  }
});

test("terminal workflow observer conservatively completes only unleased refreshing telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const refreshing = (itemNumber: number, leaseExpiresAt: string | null) => ({
    repo: "openclaw/openclaw",
    item_number: itemNumber,
    run_id: "55555",
    run_attempt: 1,
    status: "refreshing",
    outcome: null,
    started_at: new Date(now - 10 * 60_000).toISOString(),
    updated_at: new Date(now - 5 * 60_000).toISOString(),
    lease_expires_at: leaseExpiresAt,
    phase_durations_ms: { queue: 1_000 },
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
  });
  for (const record of [
    refreshing(674, null),
    refreshing(675, new Date(now + 60 * 60_000).toISOString()),
    { ...refreshing(676, null), run_attempt: 2 },
  ]) {
    assert.equal(
      (
        await queue.fetch(
          new Request("https://queue/review-telemetry", {
            method: "POST",
            body: JSON.stringify(record),
          }),
        )
      ).status,
      200,
    );
  }
  const run = {
    run_id: "55555",
    run_attempt: 1,
    workflow_outcome: "cancelled",
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
    target_repo: "openclaw/openclaw",
    started_at: new Date(now - 10 * 60_000).toISOString(),
    completed_at: new Date(now).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/55555",
    plan_count: 1,
    item_count: 2,
    publication_count: 0,
    source_event: "repository_dispatch",
    review_jobs: [
      { name: "Review item 674", conclusion: "cancelled", item_number: 674 },
      { name: "Review item 675", conclusion: "cancelled", item_number: 675 },
    ],
  };
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-run-telemetry", {
          method: "POST",
          body: JSON.stringify(run),
        }),
      )
    ).status,
    200,
  );
  const first = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=674"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(first.reviews[0].outcome, "cancelled");
  assert.equal(first.reviews[0].terminal_reason, "workflow_cancelled");
  const leased = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=675"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(leased.reviews[0].status, "refreshing");
  const scheduledReconcile = await storage.getAlarm();
  assert.ok(scheduledReconcile !== null && scheduledReconcile <= now + 60 * 60_000);
  const otherAttempt = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=676"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(otherAttempt.reviews[0].status, "refreshing");

  const aggregate = (await (
    await queue.fetch(
      new Request("https://queue/review-observability?range=24h&repo=openclaw%2Fopenclaw"),
    )
  ).json()) as Record<string, any>;
  assert.equal(aggregate.outcomes.cancelled, 1);
  assert.equal(aggregate.unexpected_cancelled, 1);
  assert.match(aggregate.anomalies[0].run_url, /\/actions\/runs\/55555$/);
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-observability?range=30d&repo=openclaw%2Fopenclaw"),
      )
    ).status,
    400,
  );

  const originalNow = Date.now;
  Date.now = () => now + 61 * 60_000;
  try {
    await queue.alarm();
  } finally {
    Date.now = originalNow;
  }
  const reconciled = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=675"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(reconciled.reviews[0].outcome, "cancelled");
  assert.equal(reconciled.reviews[0].terminal_reason, "workflow_cancelled");
});

test("terminal workflow evidence reconciles telemetry that arrives later", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const run = {
    run_id: "56565",
    run_attempt: 1,
    workflow_outcome: "failure",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(now - 10 * 60_000).toISOString(),
    completed_at: new Date(now - 60_000).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/56565",
    plan_count: 1,
    item_count: 2,
    publication_count: 0,
    review_jobs: [
      { name: "Review item 701", conclusion: "failure", item_number: 701 },
      { name: "Review shard 2", conclusion: "success", item_number: null },
    ],
  };
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-run-telemetry", {
          method: "POST",
          body: JSON.stringify(run),
        }),
      )
    ).status,
    200,
  );
  for (const itemNumber of [701, 702]) {
    assert.equal(
      (
        await queue.fetch(
          new Request("https://queue/review-telemetry", {
            method: "POST",
            body: JSON.stringify({
              repo: "openclaw/openclaw",
              item_number: itemNumber,
              run_id: run.run_id,
              run_attempt: 1,
              status: "refreshing",
              outcome: null,
              started_at: new Date(now - 9 * 60_000).toISOString(),
              updated_at: new Date(now - 2 * 60_000).toISOString(),
              lease_expires_at: null,
              phase_durations_ms: {},
              trigger_lane: "normal_backfill",
              trigger_origin: "schedule",
            }),
          }),
        )
      ).status,
      200,
    );
    const telemetry = (await (
      await queue.fetch(
        new Request(
          `https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=${itemNumber}`,
        ),
      )
    ).json()) as { reviews: Array<Record<string, unknown>> };
    if (itemNumber === 701) {
      assert.equal(telemetry.reviews[0].outcome, "interrupted");
      assert.equal(telemetry.reviews[0].terminal_reason, "workflow_terminal");
    } else {
      assert.equal(telemetry.reviews[0].status, "refreshing");
    }
  }
  assert.equal(await storage.getAlarm(), null);
});

test("terminal workflow evidence records only attributable success", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const refreshing = (itemNumber: number, repo = "openclaw/openclaw") => ({
    repo,
    item_number: itemNumber,
    run_id: "57575",
    run_attempt: 1,
    status: "refreshing",
    outcome: null,
    started_at: new Date(now - 5 * 60_000).toISOString(),
    updated_at: new Date(now - 2 * 60_000).toISOString(),
    lease_expires_at: null,
    phase_durations_ms: {},
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
  });
  for (const itemNumber of [801, 802]) {
    await queue.fetch(
      new Request("https://queue/review-telemetry", {
        method: "POST",
        body: JSON.stringify(refreshing(itemNumber)),
      }),
    );
  }
  const run = {
    run_id: "57575",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(now - 6 * 60_000).toISOString(),
    completed_at: new Date(now - 60_000).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/57575",
    plan_count: 1,
    item_count: 2,
    publication_count: 1,
    review_jobs: [
      { name: "Review item 801", conclusion: "success", item_number: 801 },
      { name: "Review shard 2", conclusion: "success", item_number: null },
    ],
  };
  assert.equal(
    (
      await queue.fetch(
        new Request("https://queue/review-run-telemetry", {
          method: "POST",
          body: JSON.stringify(run),
        }),
      )
    ).status,
    200,
  );
  for (const [itemNumber, expectedStatus] of [
    [801, "completed"],
    [802, "refreshing"],
  ] as const) {
    const telemetry = (await (
      await queue.fetch(
        new Request(
          `https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=${itemNumber}`,
        ),
      )
    ).json()) as { reviews: Array<Record<string, unknown>> };
    assert.equal(telemetry.reviews[0].status, expectedStatus);
    if (itemNumber === 801) {
      assert.equal(telemetry.reviews[0].outcome, "succeeded");
      assert.equal(telemetry.reviews[0].terminal_reason, "workflow_job_succeeded");
    }
  }
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify(refreshing(801, "openclaw/clawhub")),
    }),
  );
  const otherRepo = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fclawhub&item_number=801"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(otherRepo.reviews[0].status, "refreshing");
  assert.equal(await storage.getAlarm(), null);
});

test("workflow observer replay reconciles only from immutable first-writer evidence", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  const now = Date.now();
  const baseRun = {
    run_id: "58585",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "exact_event",
    trigger_origin: "webhook",
    target_repo: "openclaw/clawhub",
    started_at: new Date(now - 5 * 60_000).toISOString(),
    completed_at: new Date(now - 60_000).toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/58585",
    plan_count: 1,
    item_count: 1,
    publication_count: 0,
    review_jobs: [{ name: "Review item 901", conclusion: "success", item_number: 901 }],
  };
  await queue.fetch(
    new Request("https://queue/review-run-telemetry", {
      method: "POST",
      body: JSON.stringify(baseRun),
    }),
  );
  await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        repo: "openclaw/openclaw",
        item_number: 901,
        run_id: "58585",
        run_attempt: 1,
        status: "refreshing",
        outcome: null,
        started_at: new Date(now - 4 * 60_000).toISOString(),
        updated_at: new Date(now - 2 * 60_000).toISOString(),
        lease_expires_at: null,
        phase_durations_ms: {},
        trigger_lane: "exact_event",
        trigger_origin: "webhook",
      }),
    }),
  );
  await queue.fetch(
    new Request("https://queue/review-run-telemetry", {
      method: "POST",
      body: JSON.stringify({
        ...baseRun,
        workflow_outcome: "cancelled",
        target_repo: "openclaw/openclaw",
        review_jobs: [{ name: "Review item 901", conclusion: "cancelled", item_number: 901 }],
      }),
    }),
  );
  const telemetry = (await (
    await queue.fetch(
      new Request("https://queue/review-telemetry?repo=openclaw%2Fopenclaw&item_number=901"),
    )
  ).json()) as { reviews: Array<Record<string, unknown>> };
  assert.equal(telemetry.reviews[0].status, "refreshing");
});

test("review observer write is signed while aggregate telemetry remains read-only", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const record = JSON.stringify({
    run_id: "60000",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/60000",
    plan_count: 1,
    item_count: 4,
    publication_count: 1,
  });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-run-telemetry", {
      method: "POST",
      body: record,
    }),
    env,
  );
  assert.equal(denied.status, 401);

  const signature = `sha256=${createHmac("sha256", "test-token-placeholder").update(record).digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-run-telemetry", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": signature },
      body: record,
    }),
    env,
  );
  assert.equal(accepted.status, 200);
  const aggregate = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/review-observability?range=24h&repo=all"),
    env,
  );
  assert.equal(aggregate.status, 200);
  assert.equal(((await aggregate.json()) as { mode: string }).mode, "passive");
});

test("exact-review health includes the oldest refreshing row beyond operator page bounds", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { REVIEW_OBSERVABILITY_REQUIRED: "1" });
  await queue.fetch(new Request("https://queue/stats"));
  const now = Date.now();
  for (let index = 0; index <= 10_000; index += 1) {
    const old = index === 0;
    const updatedAt = old ? now - 151 * 60_000 : now - 60_000;
    const record = {
      repo: "openclaw/openclaw",
      item_number: index + 1,
      run_id: String(index + 1),
      run_attempt: 1,
      status: "refreshing",
      outcome: null,
      started_at: new Date(updatedAt - 60_000).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
      lease_expires_at: null,
      phase_durations_ms: {},
    };
    storage.sql.exec(
      `INSERT INTO exact_review_review_telemetry
       (repo, item_number, run_id, run_attempt, status, updated_at, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.repo,
      record.item_number,
      record.run_id,
      record.run_attempt,
      record.status,
      updatedAt,
      JSON.stringify(record),
    );
  }

  const response = await queue.fetch(new Request("https://queue/stats"));
  const stats = (await response.json()) as {
    review_telemetry_health: { status: string; refreshing: number; orphan_refreshing: number };
  };
  assert.deepEqual(stats.review_telemetry_health, {
    status: "critical",
    refreshing: 10_001,
    slow_refreshing: 1,
    orphan_refreshing: 1,
    degraded_after_seconds: 1800,
    orphan_after_seconds: 9000,
    orphans: [
      {
        repo: "openclaw/openclaw",
        item_number: 1,
        run_id: "1",
        run_attempt: 1,
        updated_at: new Date(now - 151 * 60_000).toISOString(),
        age_seconds: 9060,
        lease_expires_at: null,
      },
    ],
  });
  const aggregate = (await (
    await queue.fetch(new Request("https://queue/review-observability?range=24h&repo=all"))
  ).json()) as { health: string; orphan: number; telemetry_complete: boolean };
  assert.equal(aggregate.telemetry_complete, false);
  assert.equal(aggregate.orphan, 1);
  assert.equal(aggregate.health, "critical");
});

test("review observability retains refreshing attempts older than the selected range", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { REVIEW_OBSERVABILITY_REQUIRED: "1", REVIEW_RECOVERY_ENABLED: "0" },
  );
  const now = Date.now();
  const response = await queue.fetch(
    new Request("https://queue/review-telemetry", {
      method: "POST",
      body: JSON.stringify({
        repo: "openclaw/openclaw",
        item_number: 674,
        run_id: "70000",
        run_attempt: 1,
        status: "refreshing",
        outcome: null,
        started_at: new Date(now - 26 * 60 * 60_000).toISOString(),
        updated_at: new Date(now - 25 * 60 * 60_000).toISOString(),
        lease_expires_at: null,
        phase_durations_ms: {},
        trigger_lane: "exact_event",
        trigger_origin: "webhook",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const aggregate = (await (
    await queue.fetch(
      new Request("https://queue/review-observability?range=24h&repo=openclaw%2Fopenclaw"),
    )
  ).json()) as { refreshing: number; orphan: number; health: string };
  assert.equal(aggregate.refreshing, 1);
  assert.equal(aggregate.orphan, 1);
  assert.equal(aggregate.health, "critical");
});
