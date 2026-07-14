#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const cliUrl = process.argv.find((arg, index) => index > 1 && arg !== "--");
const baseUrl = cliUrl || process.env.CLAWSWEEPER_STATUS_URL || "http://127.0.0.1:8787";
const expectedDeploySha = String(process.env.CLAWSWEEPER_EXPECTED_DEPLOY_SHA || "").trim();
const deploymentReadyTimeoutMs = positiveInteger(
  process.env.CLAWSWEEPER_DEPLOY_READY_TIMEOUT_MS,
  180_000,
);
const deploymentReadyIntervalMs = positiveInteger(
  process.env.CLAWSWEEPER_DEPLOY_READY_INTERVAL_MS,
  5_000,
);

async function main() {
  const health = expectedDeploySha
    ? await waitForDashboardDeployment({
        baseUrl,
        expectedSha: expectedDeploySha,
        timeoutMs: deploymentReadyTimeoutMs,
        intervalMs: deploymentReadyIntervalMs,
      })
    : await fetchJson(`${baseUrl}/api/health`);
  if (health.ok !== true) throw new Error("health endpoint did not return ok");

  const statusStartedAt = Date.now();
  const statusResponse = await fetch(`${baseUrl}/api/status`);
  if (!statusResponse.ok) {
    throw new Error(`${baseUrl}/api/status returned ${statusResponse.status}`);
  }
  const status = await statusResponse.json();
  const statusFetchMs = Date.now() - statusStartedAt;
  const cacheState = statusResponse.headers.get("x-clawsweeper-cache") || "unknown";
  if (status.schema_version !== 1) throw new Error("unexpected status schema");
  if (!status.fleet || typeof status.fleet.active_workflow_runs !== "number") {
    throw new Error("status response is missing fleet metrics");
  }
  if (!Array.isArray(status.workers)) throw new Error("status response is missing worker details");
  if (!Array.isArray(status.pipeline)) throw new Error("status response is missing pipeline rows");
  if (!status.bay || status.bay.tide_threshold !== 20) {
    throw new Error("status response is missing the bounded Bay tide contract");
  }
  if (!Array.isArray(status.bay.terminal_buffer) || !Array.isArray(status.bay.recently_washed)) {
    throw new Error("status response is missing Bay terminal outcome arrays");
  }
  if (status.bay.timings?.sample_kind !== "completed_review_journeys") {
    throw new Error("status response is missing the evidenced Bay timing sample");
  }

  const exactReviewQueue = await fetchJson(`${baseUrl}/api/exact-review-queue`);
  for (const field of ["pending", "dispatching", "leased"]) {
    if (typeof exactReviewQueue[field] !== "number") {
      throw new Error(`exact-review queue response is missing ${field}`);
    }
  }
  if (
    !Array.isArray(exactReviewQueue.pressure_history) ||
    exactReviewQueue.pressure_history.length > 37
  ) {
    throw new Error("exact-review queue response is missing bounded pressure history");
  }
  for (const point of exactReviewQueue.pressure_history) {
    if (
      !point ||
      typeof point.observed_at !== "string" ||
      ["pending", "dispatching", "leased"].some((field) => typeof point[field] !== "number")
    ) {
      throw new Error("exact-review queue pressure history contains an invalid point");
    }
  }

  const reconcileResponse = await fetch(`${baseUrl}/internal/exact-review/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (reconcileResponse.status !== 401) {
    throw new Error(
      `${baseUrl}/internal/exact-review/reconcile returned ${reconcileResponse.status}, expected 401`,
    );
  }

  const html = await fetchText(`${baseUrl}/`);
  if (!html.includes("ClawSweeper Live")) throw new Error("dashboard HTML title missing");
  if (!html.includes("System Overview")) throw new Error("dashboard system overview missing");
  if (!html.includes('id="worker-dialog"')) throw new Error("dashboard worker drill-down missing");
  if (html.includes('href="/bay-demo"')) {
    throw new Error("experimental Bay route leaked into the overview navigation");
  }

  const bayResponse = await fetch(`${baseUrl}/bay-demo`);
  if (!bayResponse.ok) throw new Error(`${baseUrl}/bay-demo returned ${bayResponse.status}`);
  if (bayResponse.headers.get("cache-control") !== "no-store") {
    throw new Error("Bay demo HTML is not marked no-store");
  }
  if (bayResponse.headers.get("x-robots-tag") !== "noindex, nofollow, noarchive") {
    throw new Error("Bay demo is missing its noindex response policy");
  }
  const bayCsp = bayResponse.headers.get("content-security-policy") || "";
  if (
    !bayCsp.includes("connect-src 'self' https://*.openclaw.ai") ||
    !bayCsp.includes("frame-ancestors 'none'")
  ) {
    throw new Error("Bay demo is missing its expected content security policy");
  }
  const bayHtml = await bayResponse.text();
  if (!bayHtml.includes("OpenClaw Bay · ClawSweeper")) {
    throw new Error("Bay demo HTML title missing");
  }
  if (!bayHtml.includes('fetch("/api/status"')) {
    throw new Error("Bay demo does not use the shared status endpoint");
  }
  if (containsDirectGitHubApiUrl(bayHtml)) {
    throw new Error("Bay demo contains a direct browser-to-GitHub request");
  }

  const unpublishedBay = await fetch(`${baseUrl}/bay`);
  if (unpublishedBay.status !== 404) {
    throw new Error(`${baseUrl}/bay returned ${unpublishedBay.status}, expected 404`);
  }

  const bayAssets = {};
  for (const asset of [
    "bay-background.webp",
    "bay-background-portrait.webp",
    "crustaceans-atlas.webp",
    "master-sweeper.webp",
  ]) {
    const response = await fetch(`${baseUrl}/bay-assets/${asset}`);
    if (!response.ok) throw new Error(`${baseUrl}/bay-assets/${asset} returned ${response.status}`);
    if (response.headers.get("content-type") !== "image/webp") {
      throw new Error(`${asset} did not return image/webp`);
    }
    const bytes = (await response.arrayBuffer()).byteLength;
    if (bytes < 1_000) throw new Error(`${asset} is unexpectedly small`);
    bayAssets[asset] = bytes;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: baseUrl,
        deployment_sha: health.deployment_sha || null,
        active_workflow_runs: status.fleet.active_workflow_runs,
        active_codex_jobs: status.fleet.active_codex_jobs,
        worker_details: status.workers.length,
        pipeline_rows: status.pipeline.length,
        exact_review_queue: exactReviewQueue,
        exact_review_reconcile_status: reconcileResponse.status,
        cache_state: cacheState,
        status_fetch_ms: statusFetchMs,
        diagnostic_errors: status.diagnostics?.errors || [],
        bay_demo: {
          route: "/bay-demo",
          unlisted: true,
          direct_github_requests: 0,
          assets: bayAssets,
        },
      },
      null,
      2,
    ),
  );
}

export async function waitForDashboardDeployment({
  baseUrl,
  expectedSha,
  timeoutMs = 180_000,
  intervalMs = 5_000,
  fetchImpl = fetch,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  let lastObserved = "no response";

  while (true) {
    const remainingMs = Math.max(1, deadline - now());
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(10_000, remainingMs)),
      });
      if (!response.ok) {
        lastObserved = `HTTP ${response.status}`;
      } else {
        const health = await response.json();
        if (health.ok === true && health.deployment_sha === expectedSha) return health;
        lastObserved = `deployment ${String(health.deployment_sha || "unknown")}`;
      }
    } catch (error) {
      lastObserved = error instanceof Error ? error.message : String(error);
    }

    const afterAttempt = now();
    if (afterAttempt >= deadline) {
      throw new Error(
        `dashboard deployment ${expectedSha} was not ready within ${timeoutMs}ms (${lastObserved})`,
      );
    }
    await sleep(Math.min(intervalMs, deadline - afterAttempt));
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

export function containsDirectGitHubApiUrl(html) {
  return /(?:^|[^a-z0-9.-])api\.github\.com\.?(?=$|[^a-z0-9.-])/iu.test(html);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
