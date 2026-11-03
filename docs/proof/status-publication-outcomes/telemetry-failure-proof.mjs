import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

export async function startGithubFixture() {
  let healthy = false;
  let healthReads = 0;
  let unexpected = 0;
  let failure = null;
  let failureReads = 0;
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
      const runs = !status
        ? [active, completed]
        : status === "completed"
          ? [completed]
          : status === "in_progress"
            ? [active]
            : [];
      body = { total_count: runs.length, workflow_runs: runs };
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
      body = {
        total_count: 1,
        jobs: [
          {
            id: id * 10,
            run_id: id,
            name: "Review shard",
            status: id === 101 ? "completed" : "in_progress",
            conclusion: id === 101 ? "success" : null,
            started_at: now,
            completed_at: id === 101 ? now : null,
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
    observations: () => ({
      health_reads: healthReads,
      unexpected_routes: unexpected,
      failure_reads: failureReads,
    }),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
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
      ttl: fault.restart ? 5 : 1,
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
