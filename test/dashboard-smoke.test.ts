import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  containsDirectGitHubApiUrl,
  isCanonicalLegacyBayRedirect,
  waitForDashboardDeployment,
} from "../scripts/dashboard-smoke.mjs";

test("dashboard smoke executes through a symlink and reports unhealthy responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-smoke-symlink-"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.writeHead(503);
    response.end();
  });
  try {
    const script = join(root, "smoke.mjs");
    symlinkSync(fileURLToPath(new URL("../scripts/dashboard-smoke.mjs", import.meta.url)), script);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(
      promisify(execFile)(process.execPath, [script, `http://127.0.0.1:${address.port}`], {
        env: { ...process.env, CLAWSWEEPER_EXPECTED_DEPLOY_SHA: "" },
        timeout: 30_000,
      }),
      (error: Error & { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /api\/health returned 503/);
        return true;
      },
    );
    assert.deepEqual(requests, ["/api/health"]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function completeStatus() {
  return {
    schema_version: 1,
    public_projection_complete: true,
    freshness: { state: "fresh" },
    fleet: { active_workflow_runs: 1, active_codex_jobs: 1 },
    workers: [],
    pipeline: [],
    bay: {
      tide_threshold: 20,
      terminal_buffer: [],
      recently_washed: [],
      timings: {
        sample_kind: "completed_review_journeys",
        source: "durable_exact_review_lifecycles",
        completion_source: "verified_final_review_receipts",
      },
    },
    diagnostics: { errors: [], error_count: 0 },
  };
}

async function runStatusSmoke(
  status: unknown,
  cacheState = "miss",
  admission: {
    deploy?: boolean;
    secret?: string;
    status?: number;
    body?: string;
    capability?: unknown;
    redirect?: boolean;
  } = {},
) {
  const requests: string[] = [];
  const signedRequests: Array<{ body: boolean; signature: boolean }> = [];
  const secret = admission.secret ?? "synthetic-deployment-secret";
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/api/health") {
      response.end(JSON.stringify({ ok: true, deployment_sha: "expected-sha" }));
    } else if (request.url === "/internal/exact-review/admission-capabilities") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      signedRequests.push({
        body: body === "{}",
        signature:
          request.headers["x-clawsweeper-exact-review-signature"] ===
          `sha256=${createHmac("sha256", secret).update("{}").digest("hex")}`,
      });
      if (admission.redirect) {
        response.writeHead(302, { location: "/must-not-follow" });
      } else {
        response.writeHead(admission.status ?? 200);
      }
      response.end(admission.body ?? JSON.stringify(admission.capability));
    } else if (request.url === "/api/status") {
      response.setHeader("x-clawsweeper-cache", cacheState);
      response.end(JSON.stringify(status));
    } else if (request.url === "/api/exact-review-queue") {
      response.end(JSON.stringify({ pending: 0, dispatching: 0, leased: 0 }));
    } else if (request.url === "/internal/exact-review/reconcile") {
      response.writeHead(401);
      response.end();
    } else if (request.url === "/") {
      response.end('ClawSweeper Live System Overview <div id="worker-dialog"><a href="/bay">');
    } else if (request.url === "/bay") {
      response.setHeader("cache-control", "no-store");
      response.setHeader(
        "content-security-policy",
        "connect-src 'self' https://*.openclaw.ai; frame-ancestors https://team.openclaw.ai;",
      );
      response.end('OpenClaw Bay · ClawSweeper <script>fetch("/api/status")</script>');
    } else if (request.url === "/bay-demo?repo=openclaw%2Fopenclaw&q=proof") {
      response.writeHead(308, { location: `http://${request.headers.host}/bay` });
      response.end();
    } else if (request.url?.startsWith("/bay-assets/")) {
      response.setHeader("content-type", "image/webp");
      response.end(Buffer.alloc(1_000));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/dashboard-smoke.mjs", import.meta.url)),
        `http://127.0.0.1:${address.port}`,
      ],
      {
        env: {
          ...process.env,
          CLAWSWEEPER_EXPECTED_DEPLOY_SHA: admission.deploy ? "expected-sha" : "",
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
        },
        timeout: 30_000,
      },
    ).then(
      (output) => ({ ...output, code: 0 }),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );
    return { ...result, requests, signedRequests };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("dashboard smoke diagnoses observed status contracts without weakening failures", async (t) => {
  const unavailable = {
    ...completeStatus(),
    generated_at: "2020-01-01T00:00:00.000Z",
    public_projection_complete: false,
    freshness: { state: "unavailable", generated_at: null },
    bay: {},
    diagnostics: { errors: ["telemetry_unavailable"], error_count: 1 },
  };
  const cases = [
    {
      name: "unavailable miss",
      status: unavailable,
      cache: "miss",
      projection: "unavailable",
      freshness: "unavailable",
      tide: "missing",
      value: null,
      count: 1,
    },
    {
      name: "unavailable fresh cache",
      status: unavailable,
      cache: "fresh",
      projection: "unavailable",
      freshness: "unavailable",
      tide: "missing",
      value: null,
      count: 1,
    },
    {
      name: "complete tide mismatch",
      status: { ...completeStatus(), bay: { tide_threshold: 19 } },
      cache: "stale",
      projection: "complete",
      freshness: "fresh",
      tide: "mismatch",
      value: 19,
      count: 0,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const result = await runStatusSmoke(scenario.status, scenario.cache);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      const [diagnostic, error, trailing] = result.stderr.split("\n");
      assert.equal(error, "status response is missing the bounded Bay tide contract");
      assert.equal(trailing, "");
      assert.ok(diagnostic.startsWith("status diagnostic: "));
      const summary = JSON.parse(diagnostic.slice("status diagnostic: ".length));
      assert.ok(Number.isSafeInteger(summary.status_fetch_ms) && summary.status_fetch_ms >= 0);
      assert.deepEqual(summary, {
        projection: scenario.projection,
        freshness: scenario.freshness,
        cache_state: scenario.cache,
        tide: scenario.tide,
        tide_threshold: scenario.value,
        diagnostic_error_count: scenario.count,
        status_fetch_ms: summary.status_fetch_ms,
      });
      assert.deepEqual(result.requests, ["GET /api/health", "GET /api/status"]);
      assert.doesNotMatch(result.stderr, /2020|telemetry_unavailable/);
    });
  }
});

test("dashboard smoke never copies arbitrary status fields into failure diagnostics", async (t) => {
  const marker = "private-marker-do-not-print";
  for (const tide of [marker, null, -1, 1.5, 101, { nested: marker }]) {
    await t.test(JSON.stringify(tide), async () => {
      const result = await runStatusSmoke(
        {
          ...completeStatus(),
          public_projection_complete: marker,
          freshness: { state: marker, generated_at: marker },
          generated_at: marker,
          workers: [{ message: marker }],
          pipeline: [{ message: marker }],
          bay: { tide_threshold: tide, message: marker },
          diagnostics: { errors: [marker], error_count: marker },
          extra: marker,
        },
        marker,
      );
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, new RegExp(marker));
      const summary = JSON.parse(result.stderr.split("\n")[0].slice("status diagnostic: ".length));
      assert.deepEqual(summary, {
        projection: "invalid",
        freshness: "invalid",
        cache_state: "unknown",
        tide: "invalid",
        tide_threshold: null,
        diagnostic_error_count: null,
        status_fetch_ms: summary.status_fetch_ms,
      });
      assert.deepEqual(result.requests, ["GET /api/health", "GET /api/status"]);
    });
  }
});

test("dashboard smoke diagnoses earlier and later status assertions with their original errors", async () => {
  for (const [status, message] of [
    [{ ...completeStatus(), schema_version: 2 }, "unexpected status schema"],
    [{ ...completeStatus(), fleet: {} }, "status response is missing fleet metrics"],
    [{ ...completeStatus(), workers: {} }, "status response is missing worker details"],
    [{ ...completeStatus(), pipeline: {} }, "status response is missing pipeline rows"],
    [
      { ...completeStatus(), bay: { tide_threshold: 20 } },
      "status response is missing Bay terminal outcome arrays",
    ],
    [
      { ...completeStatus(), bay: { ...completeStatus().bay, timings: {} } },
      "status response is missing the durable Bay timing provenance",
    ],
  ] as const) {
    const result = await runStatusSmoke(status);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.startsWith("status diagnostic: "));
    assert.equal(result.stderr.split("\n")[1], message);
    assert.deepEqual(result.requests, ["GET /api/health", "GET /api/status"]);
  }
});

test("dashboard smoke diagnostics tolerate malformed roots and nested status fields", async () => {
  for (const status of [
    null,
    [],
    1,
    "private-marker",
    false,
    { bay: [], freshness: null, diagnostics: false },
  ]) {
    const result = await runStatusSmoke(status);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-marker/);
    const [diagnostic, originalError] = result.stderr.split("\n");
    const summary = JSON.parse(diagnostic.slice("status diagnostic: ".length));
    assert.deepEqual(summary, {
      projection: "invalid",
      freshness: "invalid",
      cache_state: "miss",
      tide: "missing",
      tide_threshold: null,
      diagnostic_error_count: null,
      status_fetch_ms: summary.status_fetch_ms,
    });
    assert.match(
      originalError,
      status === null ? /Cannot read properties of null/ : /unexpected status schema/,
    );
    assert.deepEqual(result.requests, ["GET /api/health", "GET /api/status"]);
  }
});

test("dashboard smoke bounds numeric diagnostics without coercing values", async () => {
  for (const [tide, count, expectedCount] of [
    [0, 20, 20],
    [100, 21, null],
    [19, -1, null],
    [19, 1.5, null],
  ]) {
    const result = await runStatusSmoke({
      ...completeStatus(),
      freshness: { state: "stale" },
      bay: { tide_threshold: tide },
      diagnostics: { error_count: count },
    });
    assert.equal(result.code, 1);
    const summary = JSON.parse(result.stderr.split("\n")[0].slice("status diagnostic: ".length));
    assert.equal(summary.freshness, "stale");
    assert.equal(summary.tide, "mismatch");
    assert.equal(summary.tide_threshold, tide);
    assert.equal(summary.diagnostic_error_count, expectedCount);
  }
});

test("dashboard smoke preserves the complete valid CLI route and authorization checks", async () => {
  const result = await runStatusSmoke(completeStatus());
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.exact_review_reconcile_status, 401);
  assert.equal(output.bay.public, true);
  assert.deepEqual(output.review_admission, {
    state: "skipped",
    reason: "no_expected_deployment",
  });
  assert.deepEqual(result.requests, [
    "GET /api/health",
    "GET /api/status",
    "GET /api/exact-review-queue",
    "POST /internal/exact-review/reconcile",
    "GET /",
    "GET /bay",
    "GET /bay-demo?repo=openclaw%2Fopenclaw&q=proof",
    "GET /bay-assets/bay-background.webp",
    "GET /bay-assets/bay-background-portrait.webp",
    "GET /bay-assets/crustaceans-atlas.webp",
    "GET /bay-assets/master-sweeper.webp",
  ]);
});

function admissionCapability(enabled = false) {
  return {
    scheduled_feed: { target_rate_per_hour: 60, enqueue_replay: "scheduled_disposition_v1" },
    manual_publication: { policy: "record_comment_only", enabled },
    ignored: "private-response-marker",
  };
}

test("deployment smoke verifies signed admission without enabling disabled manual intake", async () => {
  for (const enabled of [false, true]) {
    const result = await runStatusSmoke(completeStatus(), "miss", {
      deploy: true,
      capability: admissionCapability(enabled),
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.signedRequests, [{ body: true, signature: true }]);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.review_admission, {
      state: "verified",
      target_rate_per_hour: 60,
      manual_publication_enabled: enabled,
    });
    assert.equal(output.exact_review_reconcile_status, 401);
    assert.equal(output.bay.public, true);
    assert.doesNotMatch(result.stdout, /private-response-marker|synthetic-deployment-secret/);
  }
});

test("deployment smoke rejects missing signing authority before any request", async () => {
  const result = await runStatusSmoke(completeStatus(), "miss", { deploy: true, secret: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /deployment smoke requires CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.requests, []);
});

test("deployment smoke keeps capability failures closed and redacted", async (t) => {
  const marker = "private-response-marker";
  const cases = [
    { name: "auth", status: 401, body: marker, error: /returned HTTP 401/ },
    { name: "old Worker", status: 404, body: marker, error: /returned HTTP 404/ },
    { name: "server", status: 500, body: marker, error: /returned HTTP 500/ },
    { name: "malformed JSON", body: `{"${marker}`, error: /contract is invalid/ },
    { name: "redirect", redirect: true, body: marker, error: /request failed/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const result = await runStatusSmoke(completeStatus(), "miss", {
        deploy: true,
        ...scenario,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, scenario.error);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /private-response-marker|synthetic-deployment-secret/);
      assert.deepEqual(result.signedRequests, [{ body: true, signature: true }]);
      assert.deepEqual(result.requests, [
        "GET /api/health",
        "GET /api/exact-review-queue",
        "POST /internal/exact-review/admission-capabilities",
      ]);
    });
  }
});

test("deployment smoke rejects invalid scheduled and manual capability contracts", async () => {
  const valid = admissionCapability();
  for (const capability of [
    null,
    { ...valid, scheduled_feed: { ...valid.scheduled_feed, target_rate_per_hour: 0 } },
    { ...valid, scheduled_feed: { ...valid.scheduled_feed, target_rate_per_hour: 1.5 } },
    { ...valid, scheduled_feed: { ...valid.scheduled_feed, target_rate_per_hour: "60" } },
    { ...valid, scheduled_feed: { ...valid.scheduled_feed, target_rate_per_hour: 2 ** 53 } },
    { ...valid, scheduled_feed: { ...valid.scheduled_feed, enqueue_replay: "unknown" } },
    { ...valid, manual_publication: { policy: "unknown", enabled: false } },
    { ...valid, manual_publication: { policy: "record_comment_only", enabled: "false" } },
  ]) {
    const result = await runStatusSmoke(completeStatus(), "miss", { deploy: true, capability });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /review admission capability contract is invalid/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-response-marker|synthetic-deployment-secret/);
  }
});

test("dashboard smoke detects only the exact GitHub API hostname", () => {
  assert.equal(containsDirectGitHubApiUrl('fetch("https://api.github.com/repos/openclaw")'), true);
  assert.equal(containsDirectGitHubApiUrl('fetch("https://API.GITHUB.COM./graphql")'), true);
  assert.equal(containsDirectGitHubApiUrl('fetch("//api.github.com/repos/openclaw")'), true);
  assert.equal(
    containsDirectGitHubApiUrl('fetch("https:\\\/\\\/api.github.com/repos/openclaw")'),
    true,
  );
  assert.equal(
    containsDirectGitHubApiUrl('fetch("https://api.github.com.evil.example/repos/openclaw")'),
    false,
  );
  assert.equal(
    containsDirectGitHubApiUrl('fetch("//api.github.com.evil.example/repos/openclaw")'),
    false,
  );
  assert.equal(
    containsDirectGitHubApiUrl('fetch("https://evil-api.github.com/repos/openclaw")'),
    false,
  );
  assert.equal(containsDirectGitHubApiUrl('fetch("https://github.com/openclaw")'), false);
});

test("dashboard smoke requires the bounded Bay journey timing contract", () => {
  const source = readFileSync(new URL("../scripts/dashboard-smoke.mjs", import.meta.url), "utf8");

  assert.match(source, /sample_kind !== "completed_review_journeys"/);
  assert.match(source, /source !== "durable_exact_review_lifecycles"/);
  assert.match(source, /completion_source !== "verified_final_review_receipts"/);
  assert.doesNotMatch(source, /latest_completed_jobs/);
});

test("dashboard smoke requires Bay's public indexability and overview navigation", () => {
  const source = readFileSync(new URL("../scripts/dashboard-smoke.mjs", import.meta.url), "utf8");

  assert.match(source, /public Bay route is missing from the overview navigation/);
  assert.match(source, /x-robots-tag"\) !== null/);
  assert.match(source, /public Bay route has unexpected robots page metadata/);
  assert.match(source, /public: true/);
  assert.match(source, /indexable: true/);
  assert.doesNotMatch(source, /unlisted: true/);
});

test("dashboard smoke requires the legacy Bay redirect to strip query data", () => {
  const baseUrl = "https://clawsweeper.example";

  assert.equal(
    isCanonicalLegacyBayRedirect(
      new Response(null, { status: 308, headers: { location: `${baseUrl}/bay` } }),
      baseUrl,
    ),
    true,
  );
  assert.equal(
    isCanonicalLegacyBayRedirect(
      new Response(null, {
        status: 308,
        headers: { location: `${baseUrl}/bay?repo=public%2Frepository&q=proof` },
      }),
      baseUrl,
    ),
    false,
  );
});

test("dashboard smoke waits for the exact deployed revision", async () => {
  const observed = ["old-sha", "expected-sha"];
  let sleeps = 0;
  const health = await waitForDashboardDeployment({
    baseUrl: "https://clawsweeper.example",
    expectedSha: "expected-sha",
    timeoutMs: 1_000,
    intervalMs: 1,
    fetchImpl: async () =>
      Response.json({
        ok: true,
        service: "clawsweeper-status",
        deployment_sha: observed.shift(),
      }),
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(health.deployment_sha, "expected-sha");
  assert.equal(sleeps, 1);
});

test("dashboard smoke bounds deployment propagation waits", async () => {
  let timestamp = 0;
  await assert.rejects(
    waitForDashboardDeployment({
      baseUrl: "https://clawsweeper.example",
      expectedSha: "expected-sha",
      timeoutMs: 2,
      intervalMs: 1,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          service: "clawsweeper-status",
          deployment_sha: "old-sha",
        }),
      sleep: async () => {},
      now: () => timestamp++,
    }),
    /dashboard deployment expected-sha was not ready within 2ms \(deployment old-sha\)/,
  );
});

test("dashboard smoke waits for queue readiness after the deployed revision matches", async () => {
  const requests: string[] = [];
  let queueProbes = 0;
  let sleeps = 0;
  const health = await waitForDashboardDeployment({
    baseUrl: "https://clawsweeper.example",
    expectedSha: "expected-sha",
    timeoutMs: 1_000,
    intervalMs: 1,
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)).pathname);
      if (String(url).endsWith("/api/health")) {
        return Response.json({ ok: true, deployment_sha: "expected-sha" });
      }
      queueProbes += 1;
      return queueProbes === 1
        ? new Response(null, { status: 503 })
        : Response.json({ pending: 0, dispatching: 0, leased: 0 });
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(health.deployment_sha, "expected-sha");
  assert.equal(queueProbes, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(requests, [
    "/api/health",
    "/api/exact-review-queue",
    "/api/health",
    "/api/exact-review-queue",
  ]);
});

test("dashboard smoke keeps the deployment deadline when the queue stays unavailable", async () => {
  let timestamp = 0;
  await assert.rejects(
    waitForDashboardDeployment({
      baseUrl: "https://clawsweeper.example",
      expectedSha: "expected-sha",
      timeoutMs: 6,
      intervalMs: 1,
      fetchImpl: async (url) =>
        String(url).endsWith("/api/health")
          ? Response.json({ ok: true, deployment_sha: "expected-sha" })
          : new Response(null, { status: 503 }),
      sleep: async () => {},
      now: () => timestamp++,
    }),
    /dashboard deployment expected-sha was not ready within 6ms \(queue HTTP 503\)/,
  );
});
