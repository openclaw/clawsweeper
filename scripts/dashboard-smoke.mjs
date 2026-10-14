#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";

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
  const webhookSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  if (expectedDeploySha && !webhookSecret) {
    throw new Error("deployment smoke requires CLAWSWEEPER_WEBHOOK_SECRET");
  }
  const health = expectedDeploySha
    ? await waitForDashboardDeployment({
        baseUrl,
        expectedSha: expectedDeploySha,
        timeoutMs: deploymentReadyTimeoutMs,
        intervalMs: deploymentReadyIntervalMs,
      })
    : await fetchJson(`${baseUrl}/api/health`);
  if (health.ok !== true) throw new Error("health endpoint did not return ok");
  const reviewAdmission = expectedDeploySha
    ? await verifyReviewAdmission(webhookSecret)
    : { state: "skipped", reason: "no_expected_deployment" };

  const statusStartedAt = Date.now();
  const statusResponse = await fetch(`${baseUrl}/api/status`);
  if (!statusResponse.ok) {
    throw new Error(`${baseUrl}/api/status returned ${statusResponse.status}`);
  }
  const status = await statusResponse.json();
  const statusFetchMs = Date.now() - statusStartedAt;
  const cacheState = statusResponse.headers.get("x-clawsweeper-cache") || "unknown";
  try {
    validateStatus(status);
  } catch (error) {
    console.error(
      `status diagnostic: ${JSON.stringify(statusDiagnostic(status, cacheState, statusFetchMs))}`,
    );
    throw error;
  }

  const exactReviewQueue = await fetchJson(`${baseUrl}/api/exact-review-queue`);
  for (const field of ["pending", "dispatching", "leased"]) {
    if (typeof exactReviewQueue[field] !== "number") {
      throw new Error(`exact-review queue response is missing ${field}`);
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

  // The overview is the static dashboard-site build, served from Cloudflare Pages by this Worker.
  const html = await fetchText(`${baseUrl}/`);
  if (!html.includes("<title>Overview · ClawSweeper</title>"))
    throw new Error("dashboard overview title missing");
  if (!html.includes('href="/queue/"')) throw new Error("dashboard queue page link missing");

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: baseUrl,
        deployment_sha: health.deployment_sha || null,
        review_admission: reviewAdmission,
        active_workflow_runs: status.fleet.active_workflow_runs,
        active_codex_jobs: status.fleet.active_codex_jobs,
        worker_details: status.workers.length,
        pipeline_rows: status.pipeline.length,
        exact_review_queue: exactReviewQueue,
        exact_review_reconcile_status: reconcileResponse.status,
        cache_state: cacheState,
        status_fetch_ms: statusFetchMs,
        diagnostic_errors: status.diagnostics?.errors || [],
      },
      null,
      2,
    ),
  );
}

async function verifyReviewAdmission(secret) {
  // Verify the producer contract before a Worker-first rollout can enable new producers.
  // Redirects must never forward the signed request to another endpoint.
  const body = "{}";
  const deadline = Date.now() + deploymentReadyTimeoutMs;
  const timeoutMessage = `review queue deployment ${expectedDeploySha} was not ready within ${deploymentReadyTimeoutMs}ms`;
  while (true) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    let response;
    try {
      response = await fetch(`${baseUrl}/internal/exact-review/admission-capabilities`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(20_000, Math.max(1, deadline - Date.now()))),
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
    } catch (error) {
      throw new Error(
        Date.now() >= deadline ? timeoutMessage : "review admission capability request failed",
        { cause: error },
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`review admission capabilities returned HTTP ${response.status}`);
    }
    const capability = await response.json().catch(() => null);
    const feed = capability?.scheduled_feed;
    const manual = capability?.manual_publication;
    if (
      !Number.isSafeInteger(feed?.target_rate_per_hour) ||
      feed.target_rate_per_hour <= 0 ||
      feed.enqueue_replay !== "scheduled_disposition_v1" ||
      manual?.policy !== "record_comment_only" ||
      typeof manual.enabled !== "boolean"
    ) {
      throw new Error("review admission capability contract is invalid");
    }
    // A healthy outer Worker can still call the previous Durable Object version.
    // Its own deployment identity must match before new producer contracts go live.
    if (capability.deployment_sha !== expectedDeploySha) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(timeoutMessage);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(deploymentReadyIntervalMs, remainingMs)),
      );
      continue;
    }
    return {
      state: "verified",
      deployment_sha: capability.deployment_sha,
      target_rate_per_hour: feed.target_rate_per_hour,
      manual_publication_enabled: manual.enabled,
    };
  }
}

function validateStatus(status) {
  if (status.schema_version !== 1) throw new Error("unexpected status schema");
  if (!status.fleet || typeof status.fleet.active_workflow_runs !== "number") {
    throw new Error("status response is missing fleet metrics");
  }
  if (!Array.isArray(status.workers)) throw new Error("status response is missing worker details");
  if (!Array.isArray(status.pipeline)) throw new Error("status response is missing pipeline rows");
}

function statusDiagnostic(status, cacheState, statusFetchMs) {
  const complete = status?.public_projection_complete;
  const freshness = status?.freshness?.state;
  const errorCount = status?.diagnostics?.error_count;
  return {
    projection: complete === true ? "complete" : complete === false ? "unavailable" : "invalid",
    freshness: ["fresh", "stale", "unavailable"].includes(freshness) ? freshness : "invalid",
    cache_state: ["fresh", "stale", "miss"].includes(cacheState) ? cacheState : "unknown",
    diagnostic_error_count:
      Number.isSafeInteger(errorCount) && errorCount >= 0 && errorCount <= 20 ? errorCount : null,
    status_fetch_ms:
      Number.isSafeInteger(statusFetchMs) && statusFetchMs >= 0 ? statusFetchMs : null,
  };
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
        if (health.ok === true && health.deployment_sha === expectedSha) {
          const queueResponse = await fetchImpl(`${baseUrl}/api/exact-review-queue`, {
            cache: "no-store",
            signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - now()))),
          });
          await queueResponse.body?.cancel();
          if (queueResponse.ok) return health;
          lastObserved = `queue HTTP ${queueResponse.status}`;
        } else {
          lastObserved = `deployment ${String(health.deployment_sha || "unknown")}`;
        }
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

if (process.argv[1] && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
