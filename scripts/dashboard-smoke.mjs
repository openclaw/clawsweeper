#!/usr/bin/env node

const cliUrl = process.argv.find((arg, index) => index > 1 && arg !== "--");
const baseUrl = cliUrl || process.env.CLAWSWEEPER_STATUS_URL || "http://127.0.0.1:8787";

async function main() {
  const health = await fetchJson(`${baseUrl}/api/health`);
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

  const exactReviewQueue = await fetchJson(`${baseUrl}/api/exact-review-queue`);
  for (const field of ["pending", "dispatching", "leased"]) {
    if (typeof exactReviewQueue[field] !== "number") {
      throw new Error(`exact-review queue response is missing ${field}`);
    }
  }

  const html = await fetchText(`${baseUrl}/`);
  if (!html.includes("ClawSweeper Live")) throw new Error("dashboard HTML title missing");
  if (!html.includes("System Overview")) throw new Error("dashboard system overview missing");
  if (!html.includes('id="worker-dialog"')) throw new Error("dashboard worker drill-down missing");

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: baseUrl,
        active_workflow_runs: status.fleet.active_workflow_runs,
        active_codex_jobs: status.fleet.active_codex_jobs,
        worker_details: status.workers.length,
        pipeline_rows: status.pipeline.length,
        exact_review_queue: exactReviewQueue,
        cache_state: cacheState,
        status_fetch_ms: statusFetchMs,
        diagnostic_errors: status.diagnostics?.errors || [],
      },
      null,
      2,
    ),
  );
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
