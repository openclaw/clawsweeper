import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function startGithubFixture() {
  let healthy = false;
  let healthReads = 0;
  let unexpected = 0;
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
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
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
      healthReads = unexpected = 0;
    },
    recover() {
      healthy = true;
    },
    observations: () => ({ health_reads: healthReads, unexpected_routes: unexpected }),
    close: () => new Promise((resolve) => server.close(resolve)),
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
  const expected = label === "candidate" ? "worker_health_unavailable" : "telemetry_unavailable";
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
