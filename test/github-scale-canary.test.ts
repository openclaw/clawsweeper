import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectScaleFindings,
  evaluateScaleCanary,
  observeCheckRunScale,
  observeReviewFailures,
} from "../dist/repair/github-scale-canary.js";

const openclaw = JSON.parse(
  readFileSync(new URL("./fixtures/openclaw-scale.json", import.meta.url), "utf8"),
);

test("canary alerts on the source-preparation failure rate the tree outage produced", () => {
  const findings = evaluateScaleCanary([], {
    windowMinutes: 60,
    sourcePreparationFailures: openclaw.reviewFailuresPerHourDuringTreeOutage,
  });
  assert.deepEqual(
    findings.map((finding) => finding.key),
    ["source_preparation_failures"],
  );
  assert.deepEqual(
    evaluateScaleCanary([], { windowMinutes: 60, sourcePreparationFailures: 2 }),
    [],
  );
});

test("canary stays quiet at openclaw's current check-run scale and warns before the reader bound", () => {
  const current = {
    repository: openclaw.repository,
    maxCheckRuns: openclaw.maxCheckRunsOnOpenHead,
    maxCheckRunsPr: 1,
  };
  assert.deepEqual(evaluateScaleCanary([current], null), []);
  assert.deepEqual(
    evaluateScaleCanary([{ ...current, maxCheckRuns: 800 }], null).map((finding) => finding.key),
    ["check_runs:openclaw/openclaw"],
  );
});

test("canary reads the largest open-PR check-run count from one GraphQL query", () => {
  const queries: string[] = [];
  const observed = observeCheckRunScale("openclaw/openclaw", (query) => {
    queries.push(query);
    const head = (count: number) => ({
      nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCount: count } } } }],
    });
    return {
      pullRequests: {
        nodes: [
          { number: 194898, commits: head(openclaw.checkRunsOnPr194898) },
          { number: 1, commits: head(12) },
          { number: 2, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
        ],
      },
    };
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(observed, {
    repository: "openclaw/openclaw",
    maxCheckRuns: 231,
    maxCheckRunsPr: 194898,
  });
  assert.throws(
    () => observeCheckRunScale('openclaw/x") { evil', () => null),
    /invalid repository/,
  );
});

test("canary reads source-preparation failures from the public status document", () => {
  assert.deepEqual(
    observeReviewFailures({
      exact_review_queue: {
        review_failure_health: { window_minutes: 60, by_stage: { source_preparation: 613 } },
      },
    }),
    { windowMinutes: 60, sourcePreparationFailures: 613, unavailableReasons: [] },
  );
  assert.equal(observeReviewFailures({}), null);
});

test("canary keeps observed findings and reports each source it could not read", async () => {
  const outageStatus = {
    exact_review_queue: {
      review_failure_health: {
        window_minutes: 60,
        by_stage: { source_preparation: openclaw.reviewFailuresPerHourDuringTreeOutage },
      },
    },
  };
  const githubDown = await collectScaleFindings(
    ["openclaw/openclaw"],
    async () => outageStatus,
    () => {
      throw new Error("HTTP 502 from GraphQL");
    },
  );
  assert.deepEqual(
    githubDown.findings.map((finding) => finding.key),
    ["source_preparation_failures", "check_runs_unavailable:openclaw/openclaw"],
  );

  const quiet = { repository: "openclaw/openclaw", maxCheckRuns: 12, maxCheckRunsPr: 1 };
  for (const readStatus of [
    async () => {
      throw new Error("HTTP 503");
    },
    async () => ({ exact_review_queue: {} }),
  ]) {
    const statusDown = await collectScaleFindings(["openclaw/openclaw"], readStatus, () => quiet);
    assert.deepEqual(
      statusDown.findings.map((finding) => finding.key),
      ["review_failures_unavailable"],
    );
  }

  const healthy = await collectScaleFindings(
    ["openclaw/openclaw"],
    async () => ({
      exact_review_queue: {
        review_failure_health: { window_minutes: 60, by_stage: { source_preparation: 0 } },
      },
    }),
    () => quiet,
  );
  assert.deepEqual(healthy.findings, []);
});

async function runCanaryCli(env: Record<string, string>) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["dist/repair/github-scale-canary.js"], {
      env: { ...process.env, TARGET_REPOS: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("canary CLI records only conclusive deliveries and alerts on unknown failure health", async () => {
  let status: unknown = {
    exact_review_queue: {
      review_failure_health: {
        status: "degraded",
        window_minutes: 60,
        by_stage: { source_preparation: openclaw.reviewFailuresPerHourDuringTreeOutage },
      },
    },
  };
  let completion: unknown = { status: "error", deliveryError: "discord unavailable" };
  const hookPosts: Array<{ idempotencyKey: string; message: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/status") {
        response.end(JSON.stringify(status));
        return;
      }
      hookPosts.push(JSON.parse(body));
      response.end(JSON.stringify({ ok: true, runId: `run-${hookPosts.length}`, completion }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "scale-canary-"));
  try {
    const { port } = server.address() as AddressInfo;
    const sentFile = join(directory, "sent.txt");
    const env = {
      CLAWSWEEPER_STATUS_URL: `http://127.0.0.1:${port}/status`,
      CLAWSWEEPER_OPENCLAW_HOOK_URL: `http://127.0.0.1:${port}/hooks`,
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "test-token",
      CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "1",
      CLAWSWEEPER_DISCORD_TARGET: "channel:1",
      CLAWSWEEPER_SCALE_CANARY_SENT_FILE: sentFile,
    };

    // A failed delivery is not recorded, so the next hourly run retries it.
    const failed = await runCanaryCli(env);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stdout, /alert: .*failed/i);
    assert.equal(existsSync(sentFile) && readFileSync(sentFile, "utf8"), false);

    completion = { status: "ok", delivered: true };
    const delivered = await runCanaryCli(env);
    assert.equal(delivered.code, 1, delivered.stderr);
    const repeat = await runCanaryCli(env);
    assert.match(
      repeat.stdout,
      /alert already sent: github-scale-canary:\S+:source_preparation_failures/,
    );
    assert.equal(hookPosts.length, 2);
    assert.match(hookPosts[0]!.message, /docs\/github-api-limits\.md/);

    // Health explicitly unknown with a low count is not a healthy run.
    status = {
      exact_review_queue: {
        review_failure_health: {
          status: "unknown",
          reasons: ["telemetry_unavailable"],
          window_minutes: 60,
          by_stage: { source_preparation: 0 },
        },
      },
    };
    const unknown = await runCanaryCli(env);
    assert.equal(unknown.code, 1, unknown.stderr);
    assert.match(unknown.stdout, /review_failures_unavailable/);
    assert.match(unknown.stdout, /telemetry_unavailable/);
    assert.equal(hookPosts.length, 3);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
