import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
