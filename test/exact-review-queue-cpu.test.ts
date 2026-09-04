import assert from "node:assert/strict";
import test from "node:test";
import { ExactReviewQueue, type ExactReviewQueueItem } from "../dashboard/exact-review-queue.ts";
import {
  ExactReviewLifecycleProjectionStore,
  EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE,
} from "../dashboard/exact-review-lifecycle.ts";
import { ExactReviewPublicationBatchStore } from "../dashboard/exact-review-publication-batches.ts";
import { exactReviewQueueStats } from "../dashboard/exact-review-read-model.ts";
import type { ExactReviewQueueState } from "../dashboard/exact-review-queue.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const NOW = Date.parse("2026-09-03T22:20:00Z");
const post = (path: string, body: unknown) =>
  new Request(`https://queue${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// Same publication/lease shape as the publication-batch fixtures. Historical direct
// rows include the old inline base64 operations still readable after the cutover.
async function fixture(size = 300, overrides = {}, leasedCount = 50) {
  const storage = new TestStorage();
  const env: Record<string, unknown> = {
    EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
    hostedTargetPredicate: () => true,
    hostedPublicTargetProbe: async () => "public",
    ...overrides,
  };
  let queue = new ExactReviewQueue({ storage }, env);
  await queue.fetch(new Request("https://queue/stats"));
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const items: ExactReviewQueueItem[] = [];
  for (let n = 1; n <= size + leasedCount; n++) {
    const producerDecision = {
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      itemNumber: n,
      itemKind: "issue" as const,
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
      ...(n >= 41 && n <= 50 ? { statusCommentId: n } : {}),
      ...(n % 5 === 0
        ? { additionalPrompt: "Verify the reproduction and current implementation. ".repeat(80) }
        : {}),
    };
    const publication = {
      artifactName: `exact-review-${10000 + n}-1`,
      producerRunId: String(10000 + n),
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `openclaw/openclaw#${n}`,
      protocolVersion: 2 as const,
      leaseRevision: 1,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    };
    const decision =
      n <= size
        ? { ...producerDecision, sourceAction: "exact_review_artifact_publish", publication }
        : producerDecision;
    const item: ExactReviewQueueItem = {
      key: n <= size ? `${publication.itemKey}@publish:${10000 + n}:1` : publication.itemKey,
      decision,
      state: n <= size ? "pending" : "leased",
      revision: 1,
      attempts: 0,
      createdAt: NOW - 60_000 - n,
      updatedAt: NOW - 60_000,
      nextAttemptAt: NOW + 60_000,
      ...(n > size
        ? {
            leaseDecision: decision,
            leaseId: `lease-${n}`,
            leaseRevision: 1,
            leaseExpiresAt: NOW + 3_600_000,
            claimedRunId: String(10000 + n),
            claimedRunAttempt: 1,
            claimGeneration: 1,
            claimProtocolVersion: 2 as const,
          }
        : {}),
    };
    items.push(item);
    storage.run(
      "INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
      item.key,
      JSON.stringify(item),
    );
    storage.run(
      "INSERT INTO exact_review_publication_heads (target_key,source_revision,updated_at) VALUES (?,?,?)",
      publication.itemKey,
      1,
      NOW,
    );
    lifecycle.recordAdmission({
      canonicalTargetKey: publication.itemKey,
      fenceKey: item.key,
      revision: 1,
      deliveryId: `fixture-${n}`,
      sourceAction: "opened",
      commandOriginated: n >= 41 && n <= 50,
      statusMarker: null,
      statusCommentId: n >= 41 && n <= 50 ? n : null,
      observedAt: NOW - 60_000,
    });
    if (n <= size) {
      const operations = [
        {
          path: `records/openclaw-openclaw/items/${n}.md`,
          deleted: false,
          mode: "100644",
          bytes: 48000,
          contentBase64: Buffer.from("Synthetic retained review evidence.\n".repeat(1400)).toString(
            "base64",
          ),
        },
      ];
      storage.run(
        `INSERT INTO exact_review_direct_publication_plans
        (item_key,canonical_target_key,fence_key,revision,identity_item_key,identity_revision,claim_generation,
         operations_json,lifecycle_json,total_bytes,file_count,state,created_at,updated_at,next_attempt_at)
        VALUES (?,?,?,1,?,1,1,?,'{}',48000,1,'published',?,?,?)`,
        item.key,
        publication.itemKey,
        item.key,
        publication.itemKey,
        JSON.stringify(operations),
        NOW - 60_000,
        NOW,
        NOW,
      );
    }
  }
  // Match a long-running object whose rollback bridge has already expired.
  storage.run("UPDATE exact_review_queue_meta SET migrated_at = ?", NOW - 2 * 86_400_000);
  storage.kv.delete("exact-review-queue");
  queue = new ExactReviewQueue({ storage }, env);
  await queue.fetch(new Request("https://queue/stats"));
  return { queue, storage, items, lifecycle, env };
}

test(
  "queue request CPU benchmark (opt in)",
  { skip: process.env.EXACT_REVIEW_CPU_BENCH !== "1" },
  async (t) => {
    t.mock.method(Date, "now", () => NOW);
    const h = await fixture(320);
    const samples: Record<string, unknown>[] = [];
    const batchStore = new ExactReviewPublicationBatchStore(h.storage);
    const batches = Array.from(
      { length: 10 },
      (_, i) =>
        batchStore.claim({
          batchId: `cpu-batch-${i}`,
          leaseOwner: "cpu-worker",
          leaseExpiresAt: NOW + 3_600_000,
          now: NOW,
          maxItems: 8,
          maxConcurrentBatches: 10,
          candidates: h.items
            .slice(100 + i * 8, 108 + i * 8)
            .map((item) => ({ itemKey: item.key, revision: 1 })),
        })!,
    );
    // Seed publication and command-finalizer leases outside the measured call.
    for (let i = 0; i < 20; i++) {
      const item = h.items[30 + i]!;
      Object.assign(item, {
        state: "leased",
        leaseDecision: item.decision,
        leaseId: `cpu-lease-${i}`,
        leaseRevision: 1,
        leaseExpiresAt: NOW + 3_600_000,
        claimedRunId: String(20000 + i),
        claimedRunAttempt: 1,
        claimGeneration: 1,
        claimProtocolVersion: 2,
      });
      if (i >= 10)
        item.terminalFinalization = {
          disposition: "policy_noop",
          statusState: "Complete",
          statusDetail: "No action required.",
        };
      h.storage.run(
        "UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?",
        JSON.stringify(item),
        item.key,
      );
    }
    // Warm the normal poll before distinguishing cached and uncached requests.
    await h.queue.fetch(new Request("https://queue/stats"));
    async function measure(route: string, run: (i: number) => Promise<unknown>, count = 10) {
      const times: number[] = [];
      let queries = 0;
      const exec = h.storage.sql.exec;
      h.storage.sql.exec = (query, ...bindings) => {
        queries++;
        return exec(query, ...bindings);
      };
      for (let i = 0; i < count; i++) {
        const start = process.cpuUsage();
        await run(i);
        const cpu = process.cpuUsage(start);
        times.push((cpu.user + cpu.system) / 1000);
        // Keep 300 pending publications throughout the benchmark; fixture repair
        // is outside both CPU timing and sql.exec instrumentation.
        const restore =
          route === "complete"
            ? [h.items[320 + i]!]
            : route === "complete-publication"
              ? [h.items[30 + i]!]
              : route === "lifecycle/router-receipt"
                ? [h.items[i]!]
                : route === "publication-batches/complete"
                  ? h.items.slice(100 + i * 8, 108 + i * 8)
                  : [];
        for (const item of restore)
          h.storage.run(
            "INSERT OR REPLACE INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
            item.key,
            JSON.stringify(item),
          );
      }
      h.storage.sql.exec = exec;
      times.sort((a, b) => a - b);
      samples.push({
        route,
        median_cpu_ms: times[Math.floor(times.length / 2)],
        max_cpu_ms: times.at(-1),
        sql_per_call: queries / count,
      });
    }
    await measure("stats", async () => {
      assert.equal((await h.queue.fetch(new Request("https://queue/stats"))).status, 200);
    });
    h.env.EXACT_REVIEW_STATS_CACHE_MS = "0";
    await measure("stats-uncached", async () => {
      assert.equal((await h.queue.fetch(new Request("https://queue/stats"))).status, 200);
    });
    delete h.env.EXACT_REVIEW_STATS_CACHE_MS;
    await measure("lifecycle-bay", async () => {
      const r = await h.queue.fetch(new Request("https://queue/lifecycle-bay"));
      assert.equal((await r.json()).durable_lifecycle_bay.collection.state, "complete");
    });
    await measure("complete", async (i) => {
      const item = h.items[320 + i]!;
      const response = await h.queue.fetch(
        post("/complete", {
          item_key: item.key,
          lease_id: item.leaseId,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
          outcome: "success",
        }),
      );
      assert.equal(response.status, 200, await response.text());
    });
    await measure("complete-publication", async (i) => {
      const item = h.items[30 + i]!;
      const response = await h.queue.fetch(
        post("/complete", {
          item_key: item.key,
          lease_id: item.leaseId,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
          outcome: "success",
          completion_kind: "published",
          reason_code: "publication_applied",
        }),
      );
      assert.equal(response.status, 200, await response.text());
    });
    await measure("terminal-finalization/attempt", async (i) => {
      const item = h.items[40 + i]!;
      const response = await h.queue.fetch(
        post("/terminal-finalization/attempt", {
          item_key: item.key,
          lease_id: item.leaseId,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
          status_comment_id: item.decision.itemNumber,
        }),
      );
      assert.equal(response.status, 200, await response.text());
    });
    await measure("publication-batches/complete", async (i) => {
      const batch = batches[i]!;
      const response = await h.queue.fetch(
        post("/publication-batches/complete", {
          batch_id: batch.batchId,
          lease_owner: batch.leaseOwner,
          items: batch.items.map((item) => ({
            item_key: item.itemKey,
            revision: item.revision,
            claim_generation: item.claimGeneration,
            terminal_outcome: "published",
          })),
        }),
      );
      assert.equal(response.status, 200, await response.text());
    });
    await measure("lifecycle/router-receipt", async (i) => {
      const item = h.items[i]!;
      const response = await h.queue.fetch(
        post("/lifecycle/router-receipt", {
          canonical_target_key: `openclaw/openclaw#${i + 1}`,
          fence_key: item.key,
          revision: 1,
          receipt_id: `router-${i}`,
        }),
      );
      assert.equal(response.status, 200, await response.text());
    });
    await measure("alarm-housekeeping", async () => {
      await h.queue.alarm();
    });
    console.log(
      JSON.stringify({
        fixture: { pending: 300, leased: 70, lifecycle: 370, direct: 320 },
        samples,
      }),
    );
  },
);

test(
  "Bay and claimed-run CPU benchmark at 500 projections and 100 leases (opt in)",
  { skip: process.env.EXACT_REVIEW_CPU_BENCH !== "1" },
  async (t) => {
    t.mock.method(Date, "now", () => NOW);
    const { queue, storage, items, env } = await fixture(400, {}, 100);
    const samples: Record<string, unknown>[] = [];
    async function measure(route: string, request: () => Request) {
      const times: number[] = [];
      let queries = 0;
      const exec = storage.sql.exec;
      storage.sql.exec = (query, ...bindings) => {
        queries++;
        return exec(query, ...bindings);
      };
      try {
        for (let i = 0; i < 20; i++) {
          const start = process.cpuUsage();
          const response = await queue.fetch(request());
          assert.equal(response.status, 200);
          const body = await response.json();
          if (route.startsWith("lifecycle-bay")) {
            assert.equal(body.durable_lifecycle_bay.collection.state, "complete");
            assert.equal(body.durable_lifecycle_bay.inventory.lifecycle_records, 500);
          } else assert.ok(body.runs.length > 0);
          const cpu = process.cpuUsage(start);
          times.push((cpu.user + cpu.system) / 1000);
        }
      } finally {
        storage.sql.exec = exec;
      }
      times.sort((a, b) => a - b);
      samples.push({
        route,
        median_cpu_ms: times[10],
        max_cpu_ms: times.at(-1),
        sql_per_call: queries / times.length,
      });
    }
    const bayRequest = () =>
      new Request("https://queue/lifecycle-bay?public_repo=openclaw/openclaw");
    env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "0";
    await measure("lifecycle-bay-uncached", bayRequest);
    env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "10000";
    await queue.fetch(bayRequest());
    await measure("lifecycle-bay-cached", bayRequest);
    await measure("claimed-runs-all", () =>
      post("/claimed-runs", { runs: [], include_all_claimed: true }),
    );
    await measure("claimed-runs-filtered", () =>
      post("/claimed-runs", {
        runs: items.slice(400, 432).map((item) => ({ run_id: item.claimedRunId, run_attempt: 1 })),
      }),
    );
    console.log(
      JSON.stringify({ fixture: { pending: 400, leased: 100, lifecycle: 500 }, samples }),
    );
  },
);

type QueueInternals = {
  readStateSync(): ExactReviewQueueState;
  readSchedulingStateSync(): ExactReviewQueueState;
  writeStateSync(state: ExactReviewQueueState): void;
  invalidateReadCaches(): void;
  scheduleNext(state: ExactReviewQueueState, now: number): Promise<void>;
  hostedTargetAdmission(): Promise<{ outcome: "terminal" }>;
};
const internals = (queue: ExactReviewQueue) => queue as unknown as QueueInternals;

for (const outcome of ["success", "failure"] as const) {
  for (const claimGeneration of [undefined, 1]) {
    test(`legacy v1 ${outcome} completion without lifecycle row reschedules the alarm (generation ${claimGeneration})`, async (t) => {
      t.mock.method(Date, "now", () => NOW);
      const h = await fixture(0, {}, 2);
      const q = internals(h.queue);
      const state = q.readStateSync();
      const item = state.items[h.items[0]!.key]!;
      item.claimProtocolVersion = 1;
      item.claimGeneration = claimGeneration;
      const pending = state.items[h.items[1]!.key]!;
      pending.state = "pending";
      pending.nextAttemptAt = NOW + 60_000;
      h.storage.transactionSync(() => q.writeStateSync(state));
      h.storage.run(
        `DELETE FROM ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} WHERE fence_key = ?`,
        item.key,
      );
      await h.storage.setAlarm(NOW + 3_600_000);

      const response = await h.queue.fetch(
        post("/complete", {
          lease_id: item.leaseId,
          run_id: item.claimedRunId,
          run_attempt: item.claimedRunAttempt,
          outcome,
          ...(outcome === "failure" ? { retry_at: new Date(NOW + 30_000).toISOString() } : {}),
        }),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, requeued: outcome === "failure" });
      const completed = q.readStateSync().items[item.key];
      if (outcome === "success") {
        assert.equal(completed, undefined);
        assert.equal(h.storage.scheduledAlarm(), NOW + 60_000);
      } else {
        assert.equal(completed?.state, "pending");
        assert.equal(completed?.nextAttemptAt, NOW + 30_000);
        assert.equal(h.storage.scheduledAlarm(), completed.nextAttemptAt);
      }
      assert.equal(h.lifecycle.read(item.key, item.key, item.revision), null);
    });
  }
}

test("completion reschedules a committed retry even when lifecycle validation throws", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = await fixture(0, {}, 1);
  const q = internals(h.queue);
  const state = q.readStateSync();
  const item = state.items[h.items[0]!.key]!;
  item.claimProtocolVersion = 1;
  item.claimGeneration = undefined;
  h.storage.transactionSync(() => q.writeStateSync(state));
  await h.storage.setAlarm(NOW + 3_600_000);

  await assert.rejects(
    h.queue.fetch(
      post("/complete", {
        lease_id: item.leaseId,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        retry_at: new Date(NOW + 30_000).toISOString(),
      }),
    ),
    /invalid lifecycle review result/,
  );

  const retried = q.readStateSync().items[item.key]!;
  assert.equal(retried.state, "pending");
  assert.equal(retried.nextAttemptAt, NOW + 30_000);
  assert.equal(h.storage.scheduledAlarm(), retried.nextAttemptAt);
  assert.deepEqual(h.lifecycle.read(item.key, item.key, item.revision)?.reviewResults, []);
});

test("stats memo shares concurrent polls, expires, and retains the snapshot timestamp", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const { queue, storage } = await fixture(3, { EXACT_REVIEW_STATS_CACHE_MS: "10000" });
  const exec = t.mock.method(storage.sql, "exec");
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => queue.fetch(new Request("https://queue/stats"))),
  );
  assert.equal(responses[0]!.headers.get("cache-control"), "no-store");
  assert.equal(responses[0]!.headers.get("content-type"), "application/json; charset=utf-8");
  const first = await responses[0]!.text();
  for (const response of responses.slice(1)) assert.equal(await response.text(), first);
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /SELECT item_key, item_json FROM/.test(sql))
      .length,
    0,
  );
  now += 9_999;
  assert.equal(await (await queue.fetch(new Request("https://queue/stats"))).text(), first);
  now++;
  assert.notEqual(await (await queue.fetch(new Request("https://queue/stats"))).text(), first);
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /SELECT item_key, item_json FROM/.test(sql))
      .length,
    1,
  );
});

test("stats memo invalidates on queue and auxiliary state writes, and keys Bay parameters", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, items } = await fixture(3);
  const read = async (query = "") =>
    (await queue.fetch(new Request(`https://queue/stats${query}`))).json();
  const before = await read();
  const state = internals(queue).readStateSync();
  delete state.items[items[0]!.key];
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  assert.equal((await read()).lanes.publication.pending, before.lanes.publication.pending - 1);
  storage.run(
    "DELETE FROM exact_review_direct_publication_plans WHERE item_key = ?",
    items[1]!.key,
  );
  assert.equal((await read()).lanes.publication.direct.retained_receipts, 2);
  const exec = t.mock.method(storage.sql, "exec");
  await read("?bay_priority_key=openclaw/openclaw%233");
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /SELECT item_key, item_json FROM/.test(sql))
      .length,
    1,
  );
});

test("stats memo TTL zero disables reuse and failures do not poison the memo", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, env } = await fixture(3, { EXACT_REVIEW_STATS_CACHE_MS: "0" });
  const exec = t.mock.method(storage.sql, "exec");
  for (let i = 0; i < 2; i++) await queue.fetch(new Request("https://queue/stats"));
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /SELECT item_key, item_json FROM/.test(sql))
      .length,
    2,
  );
  env.EXACT_REVIEW_STATS_CACHE_MS = "10000";
  storage.failNextSqlMatching(/SELECT item_key, item_json FROM/);
  await assert.rejects(queue.fetch(new Request("https://queue/stats")));
  assert.equal((await queue.fetch(new Request("https://queue/stats"))).status, 200);
});

for (const mutation of ["explicit invalidation", "auxiliary SQL write"] as const) {
  test(`stats memo recomputes after ${mutation} during an in-flight computation`, async (t) => {
    t.mock.method(Date, "now", () => NOW);
    const { queue, storage, items } = await fixture(3);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = internals(queue).scheduleNext.bind(queue);
    let computations = 0;
    t.mock.method(internals(queue), "scheduleNext", async (state, now) => {
      await original(state, now);
      if (++computations === 1) {
        entered.resolve();
        await resume.promise;
      }
    });
    internals(queue).invalidateReadCaches();
    const first = queue.fetch(new Request("https://queue/stats"));
    await entered.promise;
    if (mutation === "explicit invalidation") {
      internals(queue).invalidateReadCaches();
    } else {
      storage.run(
        "DELETE FROM exact_review_direct_publication_plans WHERE item_key = ?",
        items[0]!.key,
      );
    }
    resume.resolve();
    await first;
    const next = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(computations, 2);
    assert.equal(
      next.lanes.publication.direct.retained_receipts,
      mutation === "explicit invalidation" ? 3 : 2,
    );
  });
}

test("stats memo observes an alarm removing a branch reservation mid-computation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage } = await fixture(3);
  for (const deliveryId of ["a", "b"]) {
    storage.kv.put(`exact-review-branch-authority-reservation:v1:${deliveryId}`, {
      deliveryId,
      decision: {
        targetRepo: "openclaw/openclaw",
        itemNumber: 900,
        itemKind: "issue",
        sourceEvent: "issues",
        sourceAction: "opened",
        supersedesInProgress: false,
      },
      sourceAuthorityRequired: false,
      attempts: 0,
      nextAttemptAt: NOW,
    });
  }
  const alarmEntered = Promise.withResolvers<void>();
  const resumeAlarm = Promise.withResolvers<void>();
  const removed = Promise.withResolvers<void>();
  const finishAlarm = Promise.withResolvers<void>();
  const statsEntered = Promise.withResolvers<void>();
  const resumeStats = Promise.withResolvers<void>();
  const deleteAlarm = storage.deleteAlarm.bind(storage);
  t.mock.method(storage, "deleteAlarm", async () => {
    await deleteAlarm();
    alarmEntered.resolve();
    await resumeAlarm.promise;
  });
  let admissions = 0;
  t.mock.method(internals(queue), "hostedTargetAdmission", async () => {
    if (++admissions === 2) {
      removed.resolve();
      await finishAlarm.promise;
    }
    return { outcome: "terminal" as const };
  });
  const scheduleNext = internals(queue).scheduleNext.bind(queue);
  let computations = 0;
  t.mock.method(internals(queue), "scheduleNext", async (state, now) => {
    await scheduleNext(state, now);
    if (++computations === 1) {
      statsEntered.resolve();
      await resumeStats.promise;
    }
  });
  const alarm = queue.alarm();
  try {
    await alarmEntered.promise;
    const first = queue.fetch(new Request("https://queue/stats"));
    await statsEntered.promise;
    resumeAlarm.resolve();
    await removed.promise;
    assert.equal(storage.kv.get("exact-review-branch-authority-reservation:v1:a"), undefined);
    const next = queue.fetch(new Request("https://queue/stats"));
    resumeStats.resolve();
    assert.equal((await (await first).json()).lanes.review.authority_pending.branch_resolution, 2);
    assert.equal((await (await next).json()).lanes.review.authority_pending.branch_resolution, 1);
    const repeated = await (await queue.fetch(new Request("https://queue/stats"))).json();
    assert.equal(repeated.lanes.review.authority_pending.branch_resolution, 1);
  } finally {
    resumeAlarm.resolve();
    resumeStats.resolve();
    finishAlarm.resolve();
    await alarm;
  }
});

test("lazy item writes retain unread bytes and persist replacement, deletion, and nested edits", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, items } = await fixture(3);
  const state = internals(queue).readStateSync();
  const untouched = items[2]!.key;
  const original = Array.from(
    storage.sql.exec(
      "SELECT item_json FROM exact_review_queue_items WHERE item_key = ?",
      untouched,
    ),
  )[0]!.item_json;
  state.items[items[0]!.key]!.decision.publication!.producerDecision.additionalPrompt =
    "changed nested prompt";
  delete state.items[items[1]!.key];
  const getter = Object.getOwnPropertyDescriptor(state.items, untouched)!.get;
  assert.ok(getter);
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  assert.equal(Object.getOwnPropertyDescriptor(state.items, untouched)!.get, getter);
  assert.equal(
    Array.from(
      storage.sql.exec(
        "SELECT item_json FROM exact_review_queue_items WHERE item_key = ?",
        untouched,
      ),
    )[0]!.item_json,
    original,
  );
  const reread = internals(queue).readStateSync();
  assert.equal(
    reread.items[items[0]!.key]!.decision.publication!.producerDecision.additionalPrompt,
    "changed nested prompt",
  );
  assert.equal(reread.items[items[1]!.key], undefined);
  reread.items[untouched] = { ...items[2]!, revision: 9 };
  storage.transactionSync(() => internals(queue).writeStateSync(reread));
  assert.equal(internals(queue).readStateSync().items[untouched]!.revision, 9);
});

test("scheduling census is equivalent on mixed leases, commands, legacy publications, and finalizers", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, items } = await fixture(12);
  const state = internals(queue).readStateSync();
  const phases = ["pending", "dispatching", "leased", "parked"] as const;
  for (const [index, item] of Object.values(state.items).entries()) {
    item.state = phases[index % phases.length]!;
    item.decision.additionalPrompt = "large prompt ".repeat(300);
    item.leaseDecision = structuredClone(item.decision);
    if (item.decision.publication) {
      item.decision.publication.producerDecision.additionalPrompt = "producer prompt ".repeat(300);
      if (index % 3 === 0) item.decision.publication.protocolVersion = 1;
      if (index % 3 === 1)
        item.decision.publication.directLifecycle = {
          plan: { kind: "router" },
          receiptOutcome: "accepted",
        };
      if (index % 3 === 2) item.decision.publication.producerDecision.statusCommentId = 100 + index;
    }
    if (index % 7 === 0)
      item.terminalFinalization = {
        disposition: "policy_noop",
        statusState: "Complete",
        statusDetail: "No action required.",
      };
  }
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  const full = internals(queue).readStateSync();
  const census = internals(queue).readSchedulingStateSync();
  assert.equal(census.items[items[0]!.key]!.leaseDecision, undefined);
  assert.equal(census.items[items[0]!.key]!.decision.additionalPrompt, undefined);
  assert.deepEqual(
    exactReviewQueueStats(census, NOW, 128, 120, 32),
    exactReviewQueueStats(full, NOW, 128, 120, 32),
  );
  await storage.deleteAlarm();
  await internals(queue).scheduleNext(full, NOW);
  const expected = storage.scheduledAlarm();
  await storage.deleteAlarm();
  await internals(queue).scheduleNext(census, NOW);
  assert.equal(storage.scheduledAlarm(), expected);
  assert.throws(
    () => storage.transactionSync(() => internals(queue).writeStateSync(census)),
    /cannot persist a queue census/,
  );
});

test("cold concurrent stats polls share one computation after invalidation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage } = await fixture(3);
  const state = internals(queue).readStateSync();
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  const exec = t.mock.method(storage.sql, "exec");
  const bodies = await Promise.all(
    Array.from({ length: 8 }, async () =>
      (await queue.fetch(new Request("https://queue/stats"))).text(),
    ),
  );
  assert.ok(bodies.every((body) => body === bodies[0]));
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /SELECT item_key, item_json FROM/.test(sql))
      .length,
    1,
  );
});

test("Bay projection cache observes revised and malformed durable rows", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, lifecycle, items } = await fixture(3, {
    EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS: "0",
  });
  const read = async () =>
    (await (await queue.fetch(new Request("https://queue/lifecycle-bay"))).json())
      .durable_lifecycle_bay;
  const before = await read();
  lifecycle.recordTerminalDisposition({
    canonicalTargetKey: "openclaw/openclaw#1",
    fenceKey: items[0]!.key,
    revision: 1,
    kind: "superseded",
    observedAt: NOW,
  });
  const after = await read();
  assert.equal(after.lanes.superseded, before.lanes.superseded + 1);
  storage.run(
    `UPDATE ${EXACT_REVIEW_LIFECYCLE_PROJECTION_TABLE} SET projection_json = ? WHERE canonical_target_key = ?`,
    "{",
    "openclaw/openclaw#1",
  );
  assert.equal((await read()).collection.state, "unknown");
});

test("concurrent renewal of an expired stats memo performs one queue scan", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const { queue, storage } = await fixture(3);
  const exec = t.mock.method(storage.sql, "exec");
  now += 10_000;
  const bodies = await Promise.all(
    Array.from({ length: 8 }, async () =>
      (await queue.fetch(new Request("https://queue/stats"))).text(),
    ),
  );
  assert.ok(bodies.every((body) => body === bodies[0]));
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /SELECT item_key, item_json FROM/.test(sql))
      .length,
    1,
  );
});

test("lifecycle Bay memo shares fresh polls, expires, and preserves headers and snapshot time", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const { queue, storage } = await fixture(3);
  const exec = t.mock.method(storage.sql, "exec");
  const read = () => queue.fetch(new Request("https://queue/lifecycle-bay"));
  const responses = await Promise.all(Array.from({ length: 8 }, read));
  const first = await responses[0]!.text();
  assert.equal(responses[0]!.headers.get("cache-control"), "no-store");
  assert.equal(responses[0]!.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(responses[0]!.headers.get("access-control-allow-origin"), "*");
  for (const response of responses.slice(1)) assert.equal(await response.text(), first);
  now += 29_999;
  assert.equal(await (await read()).text(), first);
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) =>
      /SELECT projection_json, canonical_target_key, fence_key, revision/.test(sql),
    ).length,
    1,
  );
  now++;
  const renewed = await Promise.all(Array.from({ length: 8 }, async () => (await read()).text()));
  assert.notEqual(renewed[0], first);
  assert.ok(renewed.every((body) => body === renewed[0]));
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) =>
      /SELECT projection_json, canonical_target_key, fence_key, revision/.test(sql),
    ).length,
    2,
  );
});

test("lifecycle Bay memo separates repository scopes, including invalid and absent scopes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, lifecycle } = await fixture(3);
  lifecycle.recordAdmission({
    canonicalTargetKey: "openclaw/clawhub#1",
    fenceKey: "hub-1",
    revision: 1,
    deliveryId: "hub-1",
    sourceAction: "opened",
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: NOW,
  });
  const read = async (query = "") =>
    (await (await queue.fetch(new Request(`https://queue/lifecycle-bay${query}`))).json())
      .durable_lifecycle_bay;
  const all = await read();
  const scoped = await read("?public_repo=openclaw/openclaw");
  assert.equal(all.inventory.lifecycle_records, scoped.inventory.lifecycle_records + 1);
  assert.equal((await read("?public_repo=openclaw/clawhub")).inventory.lifecycle_records, 1);
  assert.equal((await read("?public_repo=invalid")).inventory.lifecycle_records, 0);
  assert.equal((await read("?public_repo=")).inventory.lifecycle_records, 0);
  const exec = t.mock.method(storage.sql, "exec");
  const combined = await read("?public_repo=openclaw/openclaw&public_repo=openclaw/clawhub");
  const count = exec.mock.calls.length;
  assert.deepEqual(
    await read(
      "?public_repo=OpenClaw/ClawHub&public_repo=openclaw/openclaw&public_repo=openclaw/clawhub",
    ),
    combined,
  );
  assert.equal(exec.mock.calls.length, count, "equivalent scopes perform no storage reads");
  assert.deepEqual(await read(), all);
  assert.equal(
    (await read(`?${Array.from({ length: 33 }, () => "public_repo=openclaw/openclaw").join("&")}`))
      .inventory.lifecycle_records,
    0,
  );
});

test("lifecycle Bay memo can be disabled and survives queue state writes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, env } = await fixture(3);
  const exec = t.mock.method(storage.sql, "exec");
  const read = () => queue.fetch(new Request("https://queue/lifecycle-bay"));
  await read();
  await read();
  const state = internals(queue).readStateSync();
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  await read();
  env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "0";
  await read();
  await read();
  env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "10000";
  await read();
  await read();
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) =>
      /SELECT projection_json, canonical_target_key, fence_key, revision/.test(sql),
    ).length,
    4,
  );
});

test("lifecycle Bay single-flight survives writes during in-flight serialization", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, lifecycle, items } = await fixture(3);
  const target = queue as unknown as {
    computeLifecycleBayBody(repositories?: ReadonlySet<string>): string | Promise<string>;
  };
  const compute = target.computeLifecycleBayBody.bind(target);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  t.mock.method(target, "computeLifecycleBayBody", (repositories?: ReadonlySet<string>) => {
    const body = compute(repositories);
    if (++calls === 1) {
      entered();
      return gate.then(() => body);
    }
    return body;
  });
  const read = async () =>
    (await (await queue.fetch(new Request("https://queue/lifecycle-bay"))).json())
      .durable_lifecycle_bay;
  const pending = read();
  await started;
  const waiter = read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "the second reader waits on the in-flight computation");
  lifecycle.recordTerminalDisposition({
    canonicalTargetKey: "openclaw/openclaw#1",
    fenceKey: items[0]!.key,
    revision: 1,
    kind: "superseded",
    observedAt: NOW,
  });
  const afterWrite = read();
  release();
  const old = await pending;
  assert.deepEqual(await afterWrite, old);
  assert.deepEqual(await waiter, old);
  assert.deepEqual(await read(), old);
  assert.equal(calls, 1);
});

test("lifecycle Bay serialization failures do not poison or evict a replacement memo", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, env } = await fixture(3);
  const target = queue as unknown as { computeLifecycleBayBody(): string | Promise<string> };
  const compute = target.computeLifecycleBayBody.bind(target);
  let reject!: (reason: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<string>((_resolve, fail) => {
    reject = fail;
  });
  let calls = 0;
  t.mock.method(target, "computeLifecycleBayBody", () => {
    const body = compute();
    if (++calls === 1) {
      entered();
      return gate;
    }
    return body;
  });
  const read = async () => (await queue.fetch(new Request("https://queue/lifecycle-bay"))).text();
  const pending = read();
  const rejected = assert.rejects(pending, /serialization failed/);
  await started;
  env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "0";
  await read();
  env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = "30000";
  const fresh = await read();
  reject(new Error("serialization failed"));
  await rejected;
  assert.equal(await read(), fresh);
  assert.equal(calls, 3);
});

test("lean claimed-run reads equal full reads across mixed leases, duplicates, legacy claims, and limits", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { queue, storage, items } = await fixture(8, {}, 150);
  const state = internals(queue).readStateSync();
  const leased = items.slice(8);
  for (const [index, original] of leased.entries()) {
    const item = state.items[original.key]!;
    if (index < 3) item.claimedRunId = "9999";
    if (index === 3) {
      delete item.claimedRunAttempt;
      delete item.claimGeneration;
    }
    if (index === 4) {
      item.claimGeneration = 0;
      item.leaseExpiresAt = NOW - 1;
    }
    if (index === 5) delete item.claimedRunId;
    if (index === 6) item.state = "pending";
    if (index === 7) item.state = "dispatching";
    if (index === 8) item.state = "parked";
    if (index === 9)
      item.terminalFinalization = {
        disposition: "policy_noop",
        statusState: "Complete",
        statusDetail: "Done.",
      };
    item.decision.additionalPrompt = "Synthetic large decision. ".repeat(400);
  }
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  const full = Object.values(internals(queue).readStateSync().items);
  function expected(runIds: string[], all: boolean) {
    const grouped = new Map<string, ExactReviewQueueItem[]>();
    for (const item of full) {
      if (
        item.state !== "leased" ||
        !item.claimedRunId ||
        (!all && !runIds.includes(item.claimedRunId))
      )
        continue;
      const matches = grouped.get(item.claimedRunId) || [];
      if (matches.length < 2) matches.push(item);
      grouped.set(item.claimedRunId, matches);
    }
    return {
      runs: [...grouped.values()]
        .flatMap((matches) =>
          matches.map((item) => ({
            run_id: String(item.claimedRunId),
            run_attempt: item.claimedRunAttempt ?? null,
            claim_generation:
              Number.isInteger(Number(item.claimGeneration)) && Number(item.claimGeneration) >= 0
                ? Number(item.claimGeneration)
                : 0,
          })),
        )
        .slice(0, 128),
    };
  }
  const exec = t.mock.method(storage.sql, "exec");
  for (const [runIds, all] of [
    [[], true],
    [["9999", leased[3]!.claimedRunId!, leased[4]!.claimedRunId!], false],
    [["999999999"], false],
    [["9999"], true],
  ] as const) {
    const response = await queue.fetch(
      post("/claimed-runs", {
        runs: runIds.map((run_id) => ({ run_id, run_attempt: 7 })),
        include_all_claimed: all,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected([...runIds], all));
  }
  assert.equal(exec.mock.calls.length, 4);
  assert.ok(exec.mock.calls.every(({ arguments: [sql] }) => /AS claim_json/.test(sql)));
  const owned = state.items[leased[3]!.key]!;
  owned.claimGeneration = 12;
  storage.transactionSync(() => internals(queue).writeStateSync(state));
  const fresh = await queue.fetch(
    post("/claimed-runs", { runs: [{ run_id: owned.claimedRunId }] }),
  );
  assert.equal(
    (await fresh.json()).runs[0].claim_generation,
    12,
    "claim changes are immediately visible",
  );
  const invalid = await queue.fetch(
    post("/claimed-runs", { runs: [], include_all_claimed: "true" }),
  );
  assert.equal(invalid.status, 400);
});

test(
  "Bay TTL CPU benchmark at 20,000 projections with one state write per second (opt in)",
  { skip: process.env.EXACT_REVIEW_CPU_BENCH !== "1" },
  async (t) => {
    let now = NOW;
    t.mock.method(Date, "now", () => now);
    const { queue, storage, lifecycle, env } = await fixture(3, {}, 0);
    for (let n = 4; n <= 20_000; n++) {
      lifecycle.recordAdmission({
        canonicalTargetKey: `openclaw/openclaw#${n}`,
        fenceKey: `fence:${n}`,
        revision: 1,
        deliveryId: `delivery:${n}`,
        sourceAction: "opened",
        commandOriginated: false,
        statusMarker: null,
        statusCommentId: null,
        observedAt: NOW - n,
      });
    }
    const state = internals(queue).readStateSync();
    const samples = [];
    for (const ttl of [0, 30_000]) {
      env.EXACT_REVIEW_LIFECYCLE_BAY_CACHE_MS = String(ttl);
      const times: number[] = [];
      let scans = 0;
      const original = storage.sql.exec;
      storage.sql.exec = (sql, ...bindings) => {
        if (/SELECT projection_json, canonical_target_key, fence_key, revision/.test(sql)) scans++;
        return original(sql, ...bindings);
      };
      try {
        for (let i = 0; i < 30; i++) {
          storage.transactionSync(() => internals(queue).writeStateSync(state));
          const start = process.cpuUsage();
          const response = await queue.fetch(
            new Request("https://queue/lifecycle-bay?public_repo=openclaw/openclaw"),
          );
          const body = await response.json();
          assert.equal(body.durable_lifecycle_bay.inventory.lifecycle_records, 20_000);
          const cpu = process.cpuUsage(start);
          times.push((cpu.user + cpu.system) / 1000);
          now += 1000;
        }
      } finally {
        storage.sql.exec = original;
      }
      times.sort((a, b) => a - b);
      assert.equal(scans, ttl ? 1 : 30);
      samples.push({
        ttl_ms: ttl,
        calls: 30,
        state_writes: 30,
        scans,
        median_cpu_ms: times[15],
        total_cpu_ms: times.reduce((a, b) => a + b, 0),
      });
    }
    console.log(JSON.stringify({ fixture: { lifecycle: 20_000 }, samples }));
  },
);

// Inclusive method timings overlap; SQL counts include every request query but
// exclude fixture restoration. CPU is process CPU on Node/SQLite, not edge CPU.
test(
  "completion and receipt CPU breakdown (opt in)",
  {
    skip: process.env.EXACT_REVIEW_COMPLETION_CPU_BENCH !== "1",
  },
  async (t) => {
    t.mock.method(Date, "now", () => NOW);
    const samples = [];
    for (const route of [
      "complete-success",
      "complete-failure",
      "lifecycle/router-receipt",
      "terminal-finalization/attempt",
      "heartbeat",
    ]) {
      const h = await fixture(300, {}, 65);
      for (const item of h.items.slice(350)) {
        item.state = "pending";
        for (const key of [
          "leaseDecision",
          "leaseId",
          "leaseRevision",
          "leaseExpiresAt",
          "claimedRunId",
          "claimedRunAttempt",
          "claimGeneration",
          "claimProtocolVersion",
        ])
          delete item[key];
        h.storage.run(
          "UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?",
          JSON.stringify(item),
          item.key,
        );
      }
      const metrics: Record<string, { cpu_ms: number; calls: number }> = {};
      const instrument = (object, name, label = name) => {
        const original = object[name];
        object[name] = function (...args) {
          const start = process.cpuUsage();
          const finish = () => {
            const cpu = process.cpuUsage(start);
            const entry = (metrics[label] ??= { cpu_ms: 0, calls: 0 });
            entry.cpu_ms += (cpu.user + cpu.system) / 1000;
            entry.calls++;
          };
          try {
            const result = original.apply(this, args);
            if (result instanceof Promise) return result.finally(finish);
            finish();
            return result;
          } catch (error) {
            finish();
            throw error;
          }
        };
      };
      for (const name of [
        "readStateSync",
        "readSchedulingStateSync",
        "writeStateSync",
        "scheduleNext",
        "refreshPublicationControlSync",
        "publicationHeadsSync",
        "freshPublicationItemKeysSync",
        "supersededPublicationItemKeysSync",
        "syncBayLifecycle",
        "incrementQueueMetricsSync",
      ])
        instrument(h.queue, name);
      instrument(h.queue["lifecycleProjectionStore"], "writeSync", "lifecycleWrite");
      const exec = h.storage.sql.exec;
      let queries = 0;
      const queryCounts = new Map<string, number>();
      h.storage.sql.exec = (query, ...bindings) => {
        queries++;
        const normalized = query.replace(/\s+/g, " ").trim();
        queryCounts.set(normalized, (queryCounts.get(normalized) || 0) + 1);
        return exec(query, ...bindings);
      };
      const times = [];
      for (let i = 0; i < 10; i++) {
        // Terminal finalization needs one extra owned publication driver; all
        // other routes retain exactly 300 publications / 50 leases / 15 pending.
        const item = structuredClone(h.items[route === "lifecycle/router-receipt" ? i : 300 + i]!);
        if (route === "terminal-finalization/attempt") {
          item.key += "@finalizer";
          item.decision = {
            ...h.items[40]!.decision,
            itemNumber: item.decision.itemNumber,
            statusCommentId: 41,
          };
          item.terminalFinalization = {
            disposition: "policy_noop",
            statusState: "Complete",
            statusDetail: "No action required.",
            projection: {
              canonicalTargetKey: "openclaw/openclaw#41",
              fenceKey: h.items[40]!.key,
              revision: 1,
            },
          };
          h.storage.run(
            "INSERT OR REPLACE INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
            item.key,
            JSON.stringify(item),
          );
        }
        const tuple = {
          item_key: item.key,
          lease_id: item.leaseId,
          lease_revision: 1,
          claim_generation: 1,
          run_id: item.claimedRunId,
          run_attempt: 1,
        };
        const request = route.startsWith("complete-")
          ? post("/complete", {
              ...tuple,
              outcome: route === "complete-success" ? "success" : "failure",
            })
          : route === "lifecycle/router-receipt"
            ? post(`/${route}`, {
                canonical_target_key: `openclaw/openclaw#${i + 1}`,
                fence_key: item.key,
                revision: 1,
                receipt_id: `breakdown-${i}`,
              })
            : post(`/${route}`, {
                ...tuple,
                ...(route === "terminal-finalization/attempt" ? { status_comment_id: 41 } : {}),
              });
        const start = process.cpuUsage();
        const response = await h.queue.fetch(request);
        const body = await response.json();
        const cpu = process.cpuUsage(start);
        times.push((cpu.user + cpu.system) / 1000);
        assert.equal(response.status, 200, JSON.stringify(body));
        if (route.startsWith("complete-"))
          assert.equal(body.requeued, route === "complete-failure");
        if (route === "terminal-finalization/attempt")
          h.storage.run("DELETE FROM exact_review_queue_items WHERE item_key = ?", item.key);
        else
          h.storage.run(
            "INSERT OR REPLACE INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
            item.key,
            JSON.stringify(item),
          );
      }
      times.sort((a, b) => a - b);
      samples.push({
        route,
        median_cpu_ms: times[5],
        max_cpu_ms: times.at(-1),
        sql_per_call: queries / 10,
        inclusive_methods: Object.fromEntries(
          Object.entries(metrics).map(([key, value]) => [
            key,
            { cpu_ms: value.cpu_ms / 10, calls: value.calls / 10 },
          ]),
        ),
        queries: [...queryCounts].map(([query, count]) => ({ query, per_call: count / 10 })),
      });
    }
    console.log(
      JSON.stringify({
        fixture: { pending_publications: 300, leased_reviews: 50, pending_reviews: 15 },
        samples,
      }),
    );
  },
);

test("retained-alarm scheduling equals full scans across queue transitions and admission gates", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const scenarios = [
    "unchanged",
    "success",
    "retry-later",
    "retry-earlier",
    "heartbeat",
    "finalizing",
    "ready-batch",
    "expired-lease",
    "parked",
    "paused",
    "target-cap",
    "empty",
  ];
  for (const scenario of scenarios) {
    const h = await fixture(300, {}, 65);
    const q = h.queue as unknown as QueueInternals & {
      scheduleNext(state: ExactReviewQueueState, now: number, forceScan?: boolean): Promise<void>;
    };
    const state = q.readStateSync();
    for (const item of Object.values(state.items).slice(350)) {
      item.state = "pending";
      item.nextAttemptAt = NOW + 60_000;
    }
    const leased = state.items[h.items[300]!.key]!;
    if (scenario === "success") delete state.items[leased.key];
    if (scenario.startsWith("retry-")) {
      leased.state = "pending";
      leased.nextAttemptAt = NOW + (scenario === "retry-later" ? 120_000 : 5_000);
    }
    if (scenario === "heartbeat" || scenario === "finalizing") {
      leased.leaseHeartbeatAt = NOW;
      leased.leasePhase = scenario === "heartbeat" ? "review" : "finalizing";
    }
    if (scenario === "ready-batch")
      for (const item of Object.values(state.items).slice(0, 8)) item.nextAttemptAt = NOW;
    if (scenario === "expired-lease") leased.leaseExpiresAt = NOW - 1;
    if (scenario === "parked") {
      leased.state = "parked";
      leased.parkedReason = "review_retry_exhausted";
      leased.updatedAt = NOW;
    }
    if (scenario === "paused")
      state.dispatcher = { ...state.dispatcher, state: "paused", retryAt: NOW + 10_000 };
    if (scenario === "target-cap") h.env.EXACT_REVIEW_TARGET_MAX_CONCURRENT = "1";
    if (scenario === "empty") state.items = {};
    h.storage.transactionSync(() => q.writeStateSync(state));
    const alarmBefore = h.storage.scheduledAlarm();
    const controlsBefore = structuredClone(h.storage.kv.get("exact-review-publication-control:v1"));
    const before = exactReviewQueueStats(q.readStateSync(), NOW, 128, 120, 32);
    await q.scheduleNext(q.readStateSync(), NOW);
    const actual = h.storage.scheduledAlarm();
    const controlsAfter = structuredClone(h.storage.kv.get("exact-review-publication-control:v1"));
    if (alarmBefore === null) await h.storage.deleteAlarm();
    else await h.storage.setAlarm(alarmBefore);
    if (controlsBefore === undefined) h.storage.kv.delete("exact-review-publication-control:v1");
    else h.storage.kv.put("exact-review-publication-control:v1", controlsBefore);
    await q.scheduleNext(q.readStateSync(), NOW, true);
    assert.equal(actual, h.storage.scheduledAlarm(), scenario);
    assert.deepEqual(
      controlsAfter,
      h.storage.kv.get("exact-review-publication-control:v1"),
      scenario,
    );
    assert.deepEqual(before, exactReviewQueueStats(q.readStateSync(), NOW, 128, 120, 32), scenario);
  }
});

test("retained alarm falls back to a fresh durable census after an await consumes the alarm", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = await fixture(10);
  const q = internals(h.queue);
  const original = h.storage.getAlarm.bind(h.storage);
  let consumed = false;
  t.mock.method(h.storage, "getAlarm", async () => {
    if (!consumed) {
      consumed = true;
      await h.storage.deleteAlarm();
      const item = { ...h.items[0]!, nextAttemptAt: NOW + 1_000 };
      h.storage.run(
        "UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?",
        JSON.stringify(item),
        item.key,
      );
    }
    return original();
  });
  await q.scheduleNext(q.readStateSync(), NOW);
  assert.equal(h.storage.scheduledAlarm(), NOW + 1_000);
});

test("receipt without a final timing boundary updates only its lifecycle row and never rebuilds tides", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = await fixture(300);
  const sql = t.mock.method(h.storage.sql, "exec");
  const item = h.items[0]!;
  const response = await h.queue.fetch(
    post("/lifecycle/router-receipt", {
      canonical_target_key: "openclaw/openclaw#1",
      fence_key: item.key,
      revision: 1,
      receipt_id: "no-final-boundary",
    }),
  );
  assert.equal(response.status, 200);
  const queries = sql.mock.calls.map((call) => call.arguments[0]);
  assert.equal(queries.filter((query) => /WITH lifecycle_events/.test(query)).length, 0);
  for (const call of sql.mock.calls.filter((call) =>
    /(?:INSERT INTO|UPDATE) exact_review_lifecycle_projection_v1/.test(call.arguments[0]),
  )) {
    assert.ok(call.arguments.includes("openclaw/openclaw#1"));
    assert.ok(call.arguments.includes(item.key));
  }
  assert.equal(
    h.lifecycle.read("openclaw/openclaw#2", h.items[1]!.key, 1)!.terminalDisposition,
    null,
  );
});
