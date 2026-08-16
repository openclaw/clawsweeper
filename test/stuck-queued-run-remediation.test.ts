import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEAD_LETTER_RESERVED_MS,
  MAX_CANCELLATIONS_PER_PASS,
  MAX_WORKFLOW_HISTORIES_PER_PASS,
  remediateCandidate,
  selectStuckQueuedRuns,
  selectWorkflowHistoriesForInspection,
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

test("selects an aged pending rerun as wedged without started-around evidence", () => {
  const candidate = {
    ...queuedRun(100, 180),
    status: "pending",
    run_attempt: 2,
  };
  const result = selection([candidate], []);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]?.reason, "wedged_rerun");

  const boundary = {
    ...queuedRun(101, 90),
    status: "pending",
    run_attempt: 2,
    created_at: new Date(nowMs - STALE_QUEUED_AGE_MS).toISOString(),
  };
  const firstAttempt = {
    ...queuedRun(102, 180),
    status: "pending",
    run_attempt: 1,
  };
  const excluded = selection([boundary, firstAttempt], []);
  assert.deepEqual(
    excluded.candidates.map((entry) => entry.reason),
    ["younger_than_threshold", "not_queued"],
  );
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

test("inspects at most eight distinct workflows in oldest-first order", () => {
  const staleWorkflows = new Map(
    Array.from({ length: MAX_WORKFLOW_HISTORIES_PER_PASS + 3 }, (_, index) => [
      String(100 + index),
      nowMs - index * 60_000,
    ]),
  );
  assert.deepEqual(
    selectWorkflowHistoriesForInspection(staleWorkflows).map(([workflow]) => workflow),
    ["110", "109", "108", "107", "106", "105", "104", "103"],
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

test("classifies the pre-queue conflict after force-cancel without recording a zombie", async () => {
  const candidate = queuedRun(100, 180);
  const plan = selection(
    [candidate],
    [
      newerRun(1, candidate, "completed"),
      newerRun(2, candidate, "completed"),
      newerRun(3, candidate, "completed"),
    ],
  );
  const zombieState = new Map();
  const calls: string[] = [];
  const action = await remediateCandidate({
    candidate: plan.selected[0],
    zombieState,
    now: "2026-08-12T04:00:00Z",
    postCancellation: async (_runId: string, endpoint: string) => {
      calls.push(endpoint);
      return endpoint === "cancel"
        ? { ok: false, status: 500, body: "Internal Server Error" }
        : {
            ok: false,
            status: 409,
            body: '{"message":"Cannot cancel a workflow re-run that has not yet queued"}',
          };
    },
  });
  assert.deepEqual(calls, ["cancel", "force-cancel"]);
  assert.deepEqual(action, {
    run_id: "100",
    outcome: "wedged_rerun_skipped",
    cancel_status: 500,
    force_cancel_status: 409,
  });
  assert.equal(zombieState.size, 0);
});

test("pre-queue rerun cancellation conflict exits successfully as a structured skip", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-wedged-rerun-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  const candidate = queuedRun(100, 180);
  const history = [
    newerRun(1, candidate, "completed"),
    newerRun(2, candidate, "in_progress"),
    newerRun(3, candidate, "completed"),
  ];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://loopback.invalid");
    requests.push(`${request.method} ${url.pathname}`);
    const base = "/repos/openclaw/clawsweeper";
    if (request.method === "GET" && url.pathname === `${base}/actions/runs`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_count: 1, workflow_runs: [candidate] }));
      return;
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/workflows/42/runs`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_count: history.length, workflow_runs: history }));
      return;
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/runs/100`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(candidate));
      return;
    }
    if (request.method === "POST" && url.pathname === `${base}/actions/runs/100/cancel`) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ message: "Cannot cancel a workflow re-run that has not yet queued" }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
      execute: true,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(summary.skip_reasons, { wedged_rerun: 1 });
    assert.deepEqual(summary.skip_samples, [{ phase: "remediation", run_id: "100" }]);
    assert.deepEqual(summary.actions, [
      {
        run_id: "100",
        outcome: "wedged_rerun_skipped",
        cancel_status: 409,
        force_cancel_status: null,
      },
    ]);
    assert.equal(requests.filter((entry) => entry.endsWith("/force-cancel")).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("aged pending rerun exits successfully as a structured skip before cancellation", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-pending-rerun-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  const candidate = {
    ...queuedRun(100, 180),
    status: "pending",
    run_attempt: 2,
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://loopback.invalid");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const base = "/repos/openclaw/clawsweeper";
    if (request.method === "GET" && url.pathname === `${base}/actions/runs`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_count: url.searchParams.get("status") === "pending" ? 1 : 0,
          workflow_runs: url.searchParams.get("status") === "pending" ? [candidate] : [],
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/runs/100`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(candidate));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
      execute: true,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(summary.skip_reasons, { wedged_rerun: 1 });
    assert.deepEqual(summary.skip_samples, [{ phase: "remediation", run_id: "100" }]);
    assert.deepEqual(summary.actions, [
      {
        run_id: "100",
        outcome: "wedged_rerun_skipped",
        cancel_status: null,
        force_cancel_status: null,
      },
    ]);
    assert.equal(summary.selected[0]?.reason, "wedged_rerun");
    assert.ok(requests.some((entry) => entry.includes("status=pending")));
    assert.equal(
      requests.some((entry) => entry.startsWith("POST ")),
      false,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("discovery GitHub throttling exits successfully with a structured skip reason", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-throttle-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "API rate limit exceeded for installation" }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const skipLine = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((line) => line?.event === "stuck_queued_remediation_skipped");
    assert.deepEqual(skipLine, {
      event: "stuck_queued_remediation_skipped",
      skip_reasons: { github_throttled: 1 },
      phase: "discovery",
      request_path: "/actions/runs?status=queued&per_page=100&page=1",
    });
    const summary = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(summary.skip_reasons, { github_throttled: 1 });
    assert.deepEqual(summary.skip_samples, [
      {
        phase: "discovery",
        request_path: "/actions/runs?status=queued&per_page=100&page=1",
      },
    ]);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("persistent discovery 5xx still exits unsuccessfully after bounded retry", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-5xx-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Service Unavailable" }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /returned 503/);
    assert.equal(requests, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a non-throttle discovery 403 remains a hard failure", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-auth-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /returned 403/);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an unexpected discovery response shape remains a hard failure", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-shape-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ total_count: 1, workflow_runs: {} }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /invalid run inventory/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("mid-remediation throttling stops after completed actions and exits successfully", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-mid-throttle-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  const first = queuedRun(100, 180);
  const second = queuedRun(101, 170);
  const history = [
    newerRun(1, second, "completed"),
    newerRun(2, second, "in_progress"),
    newerRun(3, second, "completed"),
  ];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://loopback.invalid");
    requests.push(`${request.method} ${url.pathname}`);
    const base = "/repos/openclaw/clawsweeper";
    if (request.method === "GET" && url.pathname === `${base}/actions/runs`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_count: 2, workflow_runs: [first, second] }));
      return;
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/workflows/42/runs`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_count: history.length, workflow_runs: history }));
      return;
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/runs/100`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(first));
      return;
    }
    if (request.method === "POST" && url.pathname === `${base}/actions/runs/100/cancel`) {
      response.writeHead(202).end();
      return;
    }
    if (request.method === "GET" && url.pathname === `${base}/actions/runs/101`) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "You have exceeded a secondary rate limit." }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs: Date.now() + DEAD_LETTER_RESERVED_MS + 30_000,
      output,
      zombieOutput,
      zombieSeed,
      execute: true,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(summary.actions, [
      {
        run_id: "100",
        outcome: "cancel_requested",
        cancel_status: 202,
        force_cancel_status: null,
      },
    ]);
    assert.deepEqual(summary.skip_reasons, { github_throttled: 1 });
    assert.deepEqual(summary.skip_samples, [
      { phase: "remediation", request_path: "/actions/runs/101" },
    ]);
    assert.equal(requests.at(-1), "GET /repos/openclaw/clawsweeper/actions/runs/101");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("slow workflow discovery stops at the shared deadline with dead-letter headroom intact", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawsweeper-stuck-deadline-"));
  const output = join(scratch, "summary.json");
  const zombieOutput = join(scratch, "zombies.json");
  const zombieSeed = join(scratch, "seed.json");
  await writeFile(zombieSeed, '{"schema_version":1,"zombies":[]}\n', "utf8");
  const historyRequests: string[] = [];
  const runs = Array.from({ length: 20 }, (_, index) => ({
    ...queuedRun(10_000 + index, 100 + index),
    workflow_id: 1000 + index,
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://loopback.invalid");
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
      return;
    }
    if (url.pathname.includes("/actions/workflows/")) {
      historyRequests.push(url.pathname);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ total_count: 0, workflow_runs: [] }));
      }, 20_000).unref();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const sharedDeadlineMs = Date.now() + DEAD_LETTER_RESERVED_MS + 1500;
  const startedAt = Date.now();
  try {
    const result = await runProduction({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sharedDeadlineMs,
      output,
      zombieOutput,
      zombieSeed,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(Date.now() - startedAt < 5000, "the 20-second history request must be cut short");
    const summary = JSON.parse(await readFile(output, "utf8"));
    assert.equal(summary.deadline_reached, true);
    assert.equal(summary.workflow_discovery.distinct_stale_workflows, runs.length);
    assert.equal(summary.workflow_discovery.inspected_workflows, 1);
    assert.equal(summary.workflow_discovery.skipped_workflows, runs.length - 1);
    assert.equal(
      summary.workflow_discovery.skipped_by_bound,
      runs.length - MAX_WORKFLOW_HISTORIES_PER_PASS,
    );
    assert.equal(
      summary.workflow_discovery.skipped_by_deadline,
      MAX_WORKFLOW_HISTORIES_PER_PASS - 1,
    );
    assert.equal(historyRequests.length, 1);
    assert.match(historyRequests[0]!, /\/actions\/workflows\/1019\/runs$/);
    assert.equal(
      summary.deadline.shared_deadline_ms - summary.deadline.deadline_ms,
      DEAD_LETTER_RESERVED_MS,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});

async function runProduction({
  apiUrl,
  sharedDeadlineMs,
  output,
  zombieOutput,
  zombieSeed,
  execute = false,
}: {
  apiUrl: string;
  sharedDeadlineMs: number;
  output: string;
  zombieOutput: string;
  zombieSeed: string;
  execute?: boolean;
}) {
  const args = [
    "scripts/stuck-queued-run-remediation.mjs",
    "--repository",
    "openclaw/clawsweeper",
    "--output",
    output,
    "--zombie-output",
    zombieOutput,
    "--zombie-seed",
    zombieSeed,
  ];
  if (execute) args.push("--execute");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      GITHUB_API_URL: apiUrl,
      GITHUB_TOKEN: "deadline-test-token",
      EXACT_REVIEW_RECONCILE_DEADLINE_MS: String(sharedDeadlineMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { exitCode, stdout, stderr };
}
