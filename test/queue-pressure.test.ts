import assert from "node:assert/strict";
import test from "node:test";

import { workerLimit, type WorkerLane } from "../dist/limits.js";
import {
  QUEUE_PRESSURE_HARD_AGE_MS,
  QUEUE_PRESSURE_HARD_PENDING,
  QUEUE_PRESSURE_SOFT_AGE_MS,
  QUEUE_PRESSURE_SOFT_PENDING,
  fetchExactReviewQueuePressure,
  queuePressureLevel,
  type ExactReviewQueuePressure,
} from "../dist/queue-pressure.js";

const PRESSURE_ENV_NAMES = [
  "CLAWSWEEPER_QUEUE_PRESSURE_SOFT_PENDING",
  "CLAWSWEEPER_QUEUE_PRESSURE_HARD_PENDING",
  "CLAWSWEEPER_QUEUE_PRESSURE_SOFT_AGE_MS",
  "CLAWSWEEPER_QUEUE_PRESSURE_HARD_AGE_MS",
] as const;

test("queue pressure levels include threshold boundaries", () => {
  assert.equal(
    queuePressureLevel(pressure(QUEUE_PRESSURE_SOFT_PENDING - 1, QUEUE_PRESSURE_SOFT_AGE_MS - 1)),
    "none",
  );
  assert.equal(queuePressureLevel(pressure(QUEUE_PRESSURE_SOFT_PENDING, 0)), "soft");
  assert.equal(queuePressureLevel(pressure(0, QUEUE_PRESSURE_SOFT_AGE_MS)), "soft");
  assert.equal(queuePressureLevel(pressure(QUEUE_PRESSURE_HARD_PENDING, 0)), "hard");
  assert.equal(queuePressureLevel(pressure(0, QUEUE_PRESSURE_HARD_AGE_MS)), "hard");
  assert.equal(queuePressureLevel({ ok: false, reason: "unavailable" }), "unknown");
});

test("queue pressure levels honor environment overrides", () => {
  withPressureEnv(
    {
      CLAWSWEEPER_QUEUE_PRESSURE_SOFT_PENDING: "10",
      CLAWSWEEPER_QUEUE_PRESSURE_HARD_PENDING: "20",
      CLAWSWEEPER_QUEUE_PRESSURE_SOFT_AGE_MS: "100",
      CLAWSWEEPER_QUEUE_PRESSURE_HARD_AGE_MS: "200",
    },
    () => {
      assert.equal(queuePressureLevel(pressure(9, 99)), "none");
      assert.equal(queuePressureLevel(pressure(10, 0)), "soft");
      assert.equal(queuePressureLevel(pressure(0, 100)), "soft");
      assert.equal(queuePressureLevel(pressure(20, 0)), "hard");
      assert.equal(queuePressureLevel(pressure(0, 200)), "hard");
    },
  );
});

test("queue pressure fetch reads public aggregate stats", async () => {
  let requestedUrl = "";
  const result = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example/base/",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json({ pending: 812, oldest_pending_age_seconds: 15_120 });
    },
  });

  assert.equal(requestedUrl, "https://clawsweeper.example/api/exact-review-queue");
  assert.deepEqual(result, { ok: true, pendingCount: 812, oldestPendingAgeMs: 15_120_000 });

  const empty = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () => Response.json({ pending: 0, oldest_pending_age_seconds: null }),
  });
  assert.deepEqual(empty, { ok: true, pendingCount: 0, oldestPendingAgeMs: 0 });
});

test("queue pressure uses review thresholds and ignores independent publication health", async () => {
  const healthyPublication = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () =>
      Response.json({
        pending: 812,
        oldest_pending_age_seconds: 80_000,
        lanes: {
          review: { pending: 36, oldest_pending_age_seconds: 120 },
          publication: {
            pending: 776,
            oldest_pending_age_seconds: 80_000,
            health: { status: "healthy" },
          },
        },
      }),
  });
  assert.deepEqual(healthyPublication, {
    ok: true,
    pendingCount: 36,
    oldestPendingAgeMs: 120_000,
  });
  assert.equal(queuePressureLevel(healthyPublication), "none");

  const criticalPublication = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () =>
      Response.json({
        lanes: {
          review: { pending: 0, oldest_pending_age_seconds: null },
          publication: {
            pending: 776,
            oldest_pending_age_seconds: 80_000,
            health: { status: "critical" },
          },
        },
      }),
  });
  assert.deepEqual(criticalPublication, { ok: true, pendingCount: 0, oldestPendingAgeMs: 0 });
  assert.equal(queuePressureLevel(criticalPublication), "none");

  const emptyReviewLane = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () =>
      Response.json({
        pending: 400,
        oldest_pending_age_seconds: 70_000,
        lanes: { review: { pending: 0, oldest_pending_age_seconds: null } },
      }),
  });
  assert.deepEqual(emptyReviewLane, { ok: true, pendingCount: 0, oldestPendingAgeMs: 0 });
});

test("queue pressure exposes free candidate capacity after active and pending review work", async () => {
  const result = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () =>
      Response.json({
        lanes: {
          review: {
            pending: 5,
            active: 3,
            capacity: 128,
            oldest_pending_age_seconds: 30,
          },
        },
      }),
  });

  assert.deepEqual(result, {
    ok: true,
    pendingCount: 5,
    oldestPendingAgeMs: 30_000,
    activeCount: 3,
    capacity: 128,
    availableCandidateCapacity: 120,
  });
});

test("queue pressure fetch fails closed for background admission on errors, timeouts, and malformed bodies", async () => {
  const failed = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });
  assert.deepEqual(failed, { ok: false, reason: "network unavailable" });
  assert.equal(queuePressureLevel(failed), "unknown");

  const timedOut = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    timeoutMs: 5,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  assert.deepEqual(timedOut, { ok: false, reason: "timeout" });
  assert.equal(queuePressureLevel(timedOut), "unknown");

  const serverError = await fetchExactReviewQueuePressure({
    queueUrl: "https://clawsweeper.example",
    fetchImpl: async () => Response.json({ error: "unavailable" }, { status: 503 }),
  });
  assert.deepEqual(serverError, { ok: false, reason: "http_503" });
  assert.equal(queuePressureLevel(serverError), "unknown");

  for (const body of [
    null,
    {},
    { pending: "812", oldest_pending_age_seconds: 60 },
    { pending: 1.5, oldest_pending_age_seconds: 60 },
    { pending: 1, oldest_pending_age_seconds: Number.MAX_VALUE },
  ]) {
    const malformed = await fetchExactReviewQueuePressure({
      queueUrl: "https://clawsweeper.example",
      fetchImpl: async () => Response.json(body),
    });
    assert.deepEqual(malformed, { ok: false, reason: "malformed_response" });
    assert.equal(queuePressureLevel(malformed), "unknown");
  }
});

test("worker limits scale every background lane and leave priority lanes unchanged", () => {
  const backgroundLanes: WorkerLane[] = ["normal_review", "hot_intake"];
  for (const lane of backgroundLanes) {
    const normalBudget = workerLimit(lane, { pressureLevel: "none" });
    assert.equal(workerLimit(lane, { pressureLevel: "soft" }), Math.ceil(normalBudget * 0.5));
    assert.equal(
      workerLimit(lane, { pressureLevel: "hard" }),
      Math.max(1, Math.floor(normalBudget * 0.1)),
    );
    assert.equal(
      workerLimit(lane, { pressureLevel: "unknown" }),
      workerLimit(lane, { pressureLevel: "hard" }),
    );
  }

  const priorityLanes: WorkerLane[] = [
    "repair",
    "automerge_repair",
    "issue_implementation",
    "cluster_repair",
    "exact_item",
  ];
  for (const lane of priorityLanes) {
    assert.equal(workerLimit(lane, { pressureLevel: "hard" }), workerLimit(lane));
    assert.equal(workerLimit(lane, { pressureLevel: "unknown" }), workerLimit(lane));
  }
  assert.equal(workerLimit("normal_review"), 8);
});

test("an unavailable probe reduces the eight-slot background allowance", () => {
  const normal = workerLimit("normal_review", { pressureLevel: "none" });
  const conservative = workerLimit("normal_review", { pressureLevel: "unknown" });

  assert.equal(normal, 8);
  assert.equal(conservative, workerLimit("normal_review", { pressureLevel: "hard" }));
  assert.ok(conservative >= 1);
  assert.ok(conservative < normal);
  assert.equal(conservative, 1);
  assert.equal(workerLimit("exact_item", { pressureLevel: "unknown" }), 1);
});

function pressure(pendingCount: number, oldestPendingAgeMs: number): ExactReviewQueuePressure {
  return { ok: true, pendingCount, oldestPendingAgeMs };
}

function withPressureEnv(
  values: Record<(typeof PRESSURE_ENV_NAMES)[number], string>,
  run: () => void,
) {
  const previous = new Map(PRESSURE_ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of PRESSURE_ENV_NAMES) process.env[name] = values[name];
    run();
  } finally {
    for (const name of PRESSURE_ENV_NAMES) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
