import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

export async function startGithubFixture() {
  let healthy = false;
  let healthReads = 0;
  let unexpected = 0;
  let failure = null;
  let failureReads = 0;
  let workflowCase = null;
  let workflowReads = 0;
  let responseOrder = [];
  const pending = new Map();
  const now = new Date().toISOString();
  const run = (id, status) => ({
    id,
    name: "Review ClawSweeper items",
    display_title: "Review synthetic telemetry fixture",
    status,
    conclusion: status === "completed" ? "success" : null,
    created_at: now,
    updated_at: now,
  });
  const active = run(202, "in_progress");
  const completed = run(101, "completed");
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body;
    const faultRoute = failure?.app
      ? url.pathname === "/app/installations/17/access_tokens"
      : url.pathname === "/repos/openclaw/clawsweeper/actions/runs" &&
        url.searchParams.get("status") ===
          (failure?.census ? "waiting" : failure?.completed ? "completed" : null);
    if (failure && faultRoute) {
      failureReads += 1;
      if (failure.network) return request.socket.destroy();
      if (failure.timeout) return;
      if (failure.bodyTimeout) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"workflow_runs":[');
        return;
      }
      if (failure.bodyNetwork) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"workflow_runs":[');
        setTimeout(() => request.socket.destroy(), 200);
        return;
      }
      response.writeHead(failure.status || 200, {
        "content-type": "application/json",
        ...(failure.rateLimited ? { "x-ratelimit-remaining": "0" } : {}),
      });
      response.end(
        failure.census
          ? JSON.stringify({ total_count: 1, workflow_runs: [] })
          : "synthetic private upstream detail",
      );
      return;
    }
    if (url.pathname === "/app/installations/17/access_tokens") {
      body = {
        token: "synthetic-loopback-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
    } else if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (workflowCase && !status) unexpected += 1;
      const runs = workflowCase
        ? status === "completed"
          ? workflowCase.completed
          : workflowCase.active.filter((item) => item.status === status)
        : !status
          ? [active, completed]
          : status === "completed"
            ? [completed]
            : status === "in_progress"
              ? [active]
              : [];
      body = { total_count: runs.length, workflow_runs: runs };
      if (workflowCase) {
        workflowReads += 1;
        const source = status || "overview";
        if (workflowCase.sources.includes(source)) {
          const send = () => {
            response.once("finish", () => responseOrder.push(source));
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          };
          pending.set(source, send);
          // Gate only the conflicting pair; holding all seven initial reads
          // would deadlock runtimes with a smaller outbound connection limit.
          if (pending.size === 2) {
            pending.get(workflowCase.first)();
            const second = workflowCase.sources.find((item) => item !== workflowCase.first);
            setTimeout(() => pending.get(second)(), 30);
          }
          return;
        }
      }
    } else if (/\/actions\/runs\/(101|202)\/jobs$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/").at(-2));
      if (id === 101) {
        healthReads += 1;
        if (!healthy) {
          response.writeHead(503, { "content-type": "text/plain" });
          response.end("synthetic private upstream detail");
          return;
        }
      }
      const observed = workflowCase?.winner;
      const jobStatus = observed?.status || (id === 101 ? "completed" : "in_progress");
      body = {
        total_count: 1,
        jobs: [
          {
            id: id * 10,
            run_id: id,
            name: "Review shard",
            status: jobStatus,
            conclusion: observed ? observed.conclusion : id === 101 ? "success" : null,
            started_at: now,
            completed_at: jobStatus === "completed" ? now : null,
            steps: [],
          },
        ],
      };
    } else if (url.pathname.includes("/actions/workflows/")) {
      body = { total_count: 0, workflow_runs: [] };
    } else if (url.pathname === "/search/issues") {
      body = { total_count: 0, items: [] };
    } else if (url.pathname === "/repos/openclaw/openclaw/issues") {
      body = [];
    } else if (
      url.pathname ===
        "/repos/openclaw/clawsweeper-state/contents/results/sweep-status/openclaw-openclaw.json" &&
      url.searchParams.get("ref") === "state"
    ) {
      body = {
        content: Buffer.from('{"apply_health":{"status":"healthy"}}').toString("base64"),
      };
    } else {
      unexpected += 1;
      response.writeHead(500);
      response.end("unexpected fixture route");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    reset() {
      healthy = false;
      healthReads = unexpected = failureReads = 0;
      failure = null;
      workflowCase = null;
      workflowReads = 0;
      responseOrder = [];
      pending.clear();
    },
    recover() {
      healthy = true;
      failure = null;
    },
    fail(value) {
      healthy = true;
      failure = value;
      failureReads = 0;
    },
    workflows(value) {
      healthy = true;
      workflowCase = value;
    },
    observations: () => ({
      health_reads: healthReads,
      unexpected_routes: unexpected,
      failure_reads: failureReads,
      workflow_reads: workflowReads,
      response_order: [...responseOrder],
    }),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

export async function proveWorkflowObservations(preview, label, fixture, restart) {
  const row = {
    id: 202,
    name: "Review ClawSweeper items",
    display_title: "Review synthetic workflow observations",
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/202",
    run_attempt: 1,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 20_000).toISOString(),
  };
  const running = { ...row, status: "in_progress", conclusion: null };
  const queued = { ...running, status: "queued", updated_at: row.created_at };
  const completed = {
    ...row,
    status: "completed",
    conclusion: "failure",
    updated_at: new Date(Date.now() - 10_000).toISOString(),
  };
  const cases = [
    {
      name: "queued-to-running",
      completed: [],
      active: [running, queued],
      winner: running,
      sources: ["queued", "in_progress"],
      expected: [1, 0, 0, true, 0, 0, ["in_progress"]],
      baseline: [1, 1, 0, false, 1, 0, ["queued"]],
    },
    {
      name: "active-to-completed",
      completed: [completed],
      active: [running],
      winner: completed,
      sources: ["in_progress", "completed"],
      expected: [0, 0, 1, false, 0, 1, []],
      baseline: [1, 0, 1, true, 0, 1, ["in_progress"]],
    },
    {
      name: "completed-to-rerun",
      completed: [completed],
      active: [{ ...running, run_attempt: 2 }],
      winner: running,
      sources: ["completed", "in_progress"],
      expected: [1, 0, 0, true, 0, 0, ["in_progress"]],
      baseline: [1, 0, 1, true, 0, 1, ["in_progress"]],
    },
  ];
  const metrics = (body) => [
    body.fleet.active_workflow_runs,
    body.fleet.queued_workflow_runs,
    body.fleet.failed_recent_runs,
    body.operational_health.oldest_running_minutes > 0,
    body.operational_health.queued_runs,
    body.health.sampled_runs,
    body.pipeline.map((item) => item.status),
  ];
  const results = [];
  let current = preview;
  for (const [index, scenario] of cases.entries()) {
    for (const [order, first] of scenario.sources.entries()) {
      fixture.reset();
      fixture.workflows({ ...scenario, first });
      const config = { origin: fixture.origin, scenario: 70 + index * 2 + order, ttl: 10 };
      async function configure() {
        const response = await fetch(current.origin + "/__proof/telemetry", {
          method: "POST",
          body: JSON.stringify(config),
        });
        assert.equal(response.status, 200);
      }
      async function status() {
        const response = await fetch(current.origin + "/api/status");
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.public_projection_complete, true);
        assert.deepEqual(body.diagnostics.errors, []);
        assert.equal(body.operational_health.telemetry_complete, true);
        assert.deepEqual(
          metrics(body),
          label === "base" ? scenario.baseline : scenario.expected,
          `${label}: ${scenario.name}, first=${first}`,
        );
        return response.headers.get("x-clawsweeper-cache");
      }
      await configure();
      await status();
      const observed = fixture.observations();
      assert.deepEqual(observed.response_order, [
        first,
        ...scenario.sources.filter((s) => s !== first),
      ]);
      assert.equal(await status(), "fresh");
      const restartCase = index === 0 && order === 0;
      if (restartCase) {
        current = await restart();
        await configure();
        assert.equal(await status(), "fresh");
      }
      assert.equal(
        fixture.observations().workflow_reads,
        observed.workflow_reads,
        "warm/restarted snapshot must not requery workflows",
      );
      assert.equal(fixture.observations().unexpected_routes, 0);
      results.push({
        revision: label,
        scenario: scenario.name,
        response_order: observed.response_order,
        metrics: label === "base" ? scenario.baseline : scenario.expected,
        workflow_reads: observed.workflow_reads,
        warm_reused: true,
        sqlite_restart: restartCase,
      });
    }
  }
  return results;
}

export async function proveTelemetryFailures(preview, label, fixture, restart) {
  fixture.reset();
  async function configure(origin) {
    const response = await fetch(origin + "/__proof/telemetry", {
      method: "POST",
      body: JSON.stringify({ origin: fixture.origin }),
    });
    assert.equal(response.status, 200);
  }
  async function status(origin) {
    const response = await fetch(origin + "/api/status");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.public_projection_complete, true);
    assert.equal(JSON.stringify(body).includes("synthetic private upstream detail"), false);
    return { body, cache: response.headers.get("x-clawsweeper-cache") };
  }
  await configure(preview.origin);
  const started = Date.now();
  const cold = await status(preview.origin);
  const expected =
    label === "candidate" ? "worker_health_unavailable:http_503" : "telemetry_unavailable";
  assert.deepEqual(cold.body.diagnostics.errors, [expected]);
  const warm = await status(preview.origin);
  assert.equal(warm.cache, "fresh");
  assert.deepEqual(warm.body.diagnostics, cold.body.diagnostics);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const reused = await status(preview.origin);
  assert.deepEqual(reused.body.diagnostics.errors, label === "candidate" ? [expected] : []);
  assert.equal(fixture.observations().health_reads, 1, "health sample must actually be reused");

  const restarted = await restart();
  await configure(restarted.origin);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const persisted = await status(restarted.origin);
  assert.deepEqual(persisted.body.diagnostics, reused.body.diagnostics);
  assert.equal(fixture.observations().health_reads, 1, "health sample must survive SQLite restart");

  fixture.recover();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 11_000 - (Date.now() - started))));
  const recovered = await status(restarted.origin);
  assert.deepEqual(recovered.body.diagnostics.errors, []);
  assert.equal(recovered.body.health.successful_attempts, 1);
  assert.equal(fixture.observations().health_reads, 2);
  assert.equal(fixture.observations().unexpected_routes, 0);
  return {
    revision: label,
    cold_errors: cold.body.diagnostics.errors,
    warm_errors: warm.body.diagnostics.errors,
    cached_sample_errors: reused.body.diagnostics.errors,
    sqlite_restart_errors: persisted.body.diagnostics.errors,
    recovered_errors: recovered.body.diagnostics.errors,
    ...fixture.observations(),
  };
}

export async function proveGithubFailureCauses(preview, label, fixture, restart) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cases = [
    { status: 403, cause: "http_403", restart: true },
    { status: 429, cause: "rate_limited" },
    { status: 503, cause: "http_503", completed: true },
    { status: 403, cause: "rate_limited", rateLimited: true },
    { timeout: true, cause: "timeout" },
    { bodyTimeout: true, cause: "timeout" },
    { network: true, cause: "network" },
    { bodyNetwork: true, cause: "network" },
    { cause: "invalid_json" },
    { census: true, cause: "census_incomplete" },
    { app: true, status: 403, cause: "http_403" },
  ];
  const results = [];
  let current = preview;
  async function status() {
    const response = await fetch(current.origin + "/api/status");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.public_projection_complete, true);
    assert.equal(JSON.stringify(body).includes("synthetic private upstream detail"), false);
    assert.equal(JSON.stringify(body).includes("synthetic-loopback-token"), false);
    return { body, cache: response.headers.get("x-clawsweeper-cache") };
  }
  for (const [index, fault] of cases.entries()) {
    fixture.reset();
    fixture.fail(fault);
    const config = {
      origin: fixture.origin,
      scenario: index + 10,
      // Snapshot age starts before collection. Leave a warm-cache window after
      // the real 4.5-second request timeout, without changing production timing.
      ttl: fault.timeout || fault.bodyTimeout ? 10 : fault.restart ? 5 : 1,
      ...(fault.app ? { privateKey } : {}),
    };
    async function configure() {
      const response = await fetch(current.origin + "/__proof/telemetry", {
        method: "POST",
        body: JSON.stringify(config),
      });
      assert.equal(response.status, 200);
    }
    await configure();
    const cold = await status();
    const section = fault.census
      ? "active_runs_unavailable"
      : fault.completed
        ? "completed_workflow_runs_unavailable"
        : "workflow_runs_unavailable";
    const expected = label === "candidate" ? `${section}:${fault.cause}` : section;
    assert.ok(
      cold.body.diagnostics.errors.includes(expected),
      `${label}: ${JSON.stringify(fault)}`,
    );
    if (!fault.app) assert.equal(cold.body.diagnostics.error_count, 1);
    const reads = fixture.observations().failure_reads;
    if (!fault.app) {
      const warm = await status();
      assert.equal(warm.cache, "fresh");
      assert.deepEqual(warm.body.diagnostics, cold.body.diagnostics);
      if (fault.restart) {
        current = await restart();
        await configure();
        const persisted = await status();
        assert.equal(persisted.cache, "fresh");
        assert.deepEqual(persisted.body.diagnostics, cold.body.diagnostics);
      }
      assert.equal(
        fixture.observations().failure_reads,
        reads,
        "cached reads must not requery GitHub",
      );
    }
    fixture.recover();
    const expires = Date.parse(cold.body.generated_at) + config.ttl * 1000 + 100;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now())));
    const recovered = await status();
    assert.deepEqual(recovered.body.diagnostics.errors, []);
    assert.equal(fixture.observations().unexpected_routes, 0);
    results.push({
      revision: label,
      cause: fault.cause,
      section,
      errors: cold.body.diagnostics.errors,
      error_count: cold.body.diagnostics.error_count,
      sqlite_restart: Boolean(fault.restart),
      recovered_errors: recovered.body.diagnostics.errors,
      failure_reads: reads,
    });
  }
  return results;
}
