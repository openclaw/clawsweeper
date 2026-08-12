import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CANCELLATIONS_PER_PASS,
  remediateCandidate,
  selectStuckQueuedRuns,
  STALE_QUEUED_AGE_MS,
} from "../scripts/stuck-queued-run-remediation.mjs";

const nowMs = Date.parse("2026-08-12T04:00:00Z");
const workflowId = 42;

function queuedRun(id: number, ageMinutes: number, path = ".github/workflows/sweep.yml") {
  return {
    id,
    workflow_id: workflowId,
    path,
    status: "queued",
    created_at: new Date(nowMs - ageMinutes * 60_000).toISOString(),
    display_title: `run ${id}`,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
  };
}

function newerRun(id: number, candidate: ReturnType<typeof queuedRun>, status: string) {
  return {
    id,
    workflow_id: workflowId,
    status,
    created_at: new Date(Date.parse(candidate.created_at) + id * 1000).toISOString(),
    run_started_at: new Date(Date.parse(candidate.created_at) + id * 1000).toISOString(),
  };
}

function selection(queuedRuns: Array<ReturnType<typeof queuedRun>>, history: Array<any>) {
  return selectStuckQueuedRuns({
    queuedRuns,
    historyByWorkflow: new Map([[String(workflowId), history]]),
    historyCompleteByWorkflow: new Map([[String(workflowId), true]]),
    nowMs,
  });
}

test("selects a stale queued run only after three newer runs started", () => {
  const candidate = queuedRun(100, 91);
  const result = selection(candidate ? [candidate] : [], [
    newerRun(1, candidate, "completed"),
    newerRun(2, candidate, "in_progress"),
    newerRun(3, candidate, "completed"),
  ]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]?.reason, "started_around_it");
  assert.deepEqual(
    result.selected[0]?.discriminator.evidence.map((run: { run_id: string }) => run.run_id),
    ["1", "2", "3"],
  );
});

test("does not select stale queued runs during a global capacity crunch", () => {
  const candidate = queuedRun(100, 180);
  const result = selection(candidate ? [candidate] : [], [
    newerRun(1, candidate, "queued"),
    newerRun(2, candidate, "queued"),
    newerRun(3, candidate, "queued"),
  ]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.candidates[0]?.reason, "insufficient_newer_started_runs");
});

test("does not select young runs or the strict 90-minute boundary", () => {
  const young = queuedRun(100, 89);
  const boundary = {
    ...queuedRun(101, 90),
    created_at: new Date(nowMs - STALE_QUEUED_AGE_MS).toISOString(),
  };
  const history = [
    newerRun(1, young, "completed"),
    newerRun(2, young, "completed"),
    newerRun(3, young, "completed"),
  ];
  const result = selection([young, boundary], history);
  assert.equal(result.selected.length, 0);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.reason),
    ["younger_than_threshold", "younger_than_threshold"],
  );
});

test("does not select workflows with legitimate long serialized queues", () => {
  const candidate = queuedRun(100, 180, ".github/workflows/repair-cluster-worker.yml");
  const history = [
    newerRun(1, candidate, "completed"),
    newerRun(2, candidate, "completed"),
    newerRun(3, candidate, "completed"),
  ];
  const result = selection([candidate], history);
  assert.equal(result.selected.length, 0);
  assert.equal(result.candidates[0]?.reason, "expected_long_queue_workflow");
});

test("caps each pass at ten cancellation candidates", () => {
  const candidates = Array.from({ length: MAX_CANCELLATIONS_PER_PASS + 2 }, (_, index) =>
    queuedRun(100 + index, 180 + index),
  );
  const history = [
    newerRun(1, candidates[0]!, "completed"),
    newerRun(2, candidates[0]!, "completed"),
    newerRun(3, candidates[0]!, "completed"),
  ];
  const result = selection(candidates, history);
  assert.equal(result.selected.length, MAX_CANCELLATIONS_PER_PASS);
  assert.equal(
    result.candidates.filter((candidate) => candidate.reason === "cancellation_bound").length,
    2,
  );
});

test("records 500-500 as a permanent zombie and never selects it again", async () => {
  const candidate = queuedRun(100, 180);
  const plan = selection(candidate ? [candidate] : [], [
    newerRun(1, candidate, "completed"),
    newerRun(2, candidate, "completed"),
    newerRun(3, candidate, "completed"),
  ]);
  const zombieState = new Map<string, Record<string, string>>();
  const calls: string[] = [];
  const action = await remediateCandidate({
    candidate: plan.selected[0],
    zombieState,
    now: "2026-08-12T04:00:00Z",
    postCancellation: async (_runId: string, endpoint: string) => {
      calls.push(endpoint);
      return { ok: false, status: 500 };
    },
  });
  assert.deepEqual(calls, ["cancel", "force-cancel"]);
  assert.equal(action.outcome, "permanent_zombie_recorded");
  assert.ok(zombieState.has("100"));

  const nextPlan = selectStuckQueuedRuns({
    queuedRuns: [candidate],
    historyByWorkflow: new Map([[String(workflowId), []]]),
    historyCompleteByWorkflow: new Map([[String(workflowId), true]]),
    zombieRunIds: new Set(zombieState.keys()),
    nowMs,
  });
  assert.equal(nextPlan.selected.length, 0);
  assert.equal(nextPlan.candidates[0]?.reason, "permanent_zombie");
});

test("does not force-cancel when regular cancellation fails with a non-500 status", async () => {
  const candidate = queuedRun(100, 180);
  const plan = selection(
    [candidate],
    [
      newerRun(1, candidate, "completed"),
      newerRun(2, candidate, "completed"),
      newerRun(3, candidate, "completed"),
    ],
  );
  const calls: string[] = [];
  const action = await remediateCandidate({
    candidate: plan.selected[0],
    zombieState: new Map(),
    now: "2026-08-12T04:00:00Z",
    postCancellation: async (_runId: string, endpoint: string) => {
      calls.push(endpoint);
      return { ok: false, status: 403 };
    },
  });
  assert.deepEqual(calls, ["cancel"]);
  assert.equal(action.outcome, "cancel_failed");
});
