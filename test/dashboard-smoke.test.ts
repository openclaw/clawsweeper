import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  containsDirectGitHubApiUrl,
  waitForDashboardDeployment,
} from "../scripts/dashboard-smoke.mjs";

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

test("dashboard smoke requires bounded Bay timing and handoff-pressure contracts", () => {
  const source = readFileSync(new URL("../scripts/dashboard-smoke.mjs", import.meta.url), "utf8");

  assert.match(source, /sample_kind !== "completed_review_journeys"/);
  assert.match(source, /pressure_history\.length > 37/);
  assert.match(source, /contains an invalid point/);
  assert.doesNotMatch(source, /latest_completed_jobs/);
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
