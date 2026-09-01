/**
 * Enforce the dashboard strict allowlist as a monotonic ratchet. When a module
 * joins the allowlist, add the same one-line entry to the baseline below in
 * that PR; baseline entries must never be removed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const configPath = "tsconfig.dashboard-strict.json";
const tscPath = path.resolve("node_modules/typescript/bin/tsc");

export const DASHBOARD_STRICT_BASELINE_FILES = Object.freeze([
  "dashboard/apply-observability.ts",
  "dashboard/automerge-metrics.ts",
  "dashboard/bay-page.ts",
  "dashboard/dashboard-health.ts",
  "dashboard/dashboard-pages.ts",
  "dashboard/error-safety.ts",
  "dashboard/exact-review-artifact-cache.ts",
  "dashboard/exact-review-command-intake.ts",
  "dashboard/exact-review-decision.ts",
  "dashboard/exact-review-direct-publication.ts",
  "dashboard/exact-review-health.ts",
  "dashboard/exact-review-lifecycle-telemetry.ts",
  "dashboard/exact-review-lifecycle.ts",
  "dashboard/exact-review-publication-batches.ts",
  "dashboard/exact-review-publication-retry.ts",
  "dashboard/exact-review-queue-observability.ts",
  "dashboard/exact-review-queue-shared.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/github-api.ts",
  "dashboard/github-webhook-read-model.ts",
  "dashboard/github-etag-cache.ts",
  "dashboard/github-egress-telemetry.ts",
  "dashboard/live-activity.ts",
  "dashboard/operational-health.ts",
  "dashboard/recent-durable-publication-events.ts",
  "dashboard/record-snapshots.ts",
  "dashboard/review-observability.ts",
  "dashboard/review-run-telemetry.ts",
  "dashboard/state-blobs.ts",
  "dashboard/state-writer-coordinator.ts",
  "dashboard/triage-routing-groups.ts",
]);

export function assertDashboardStrictBaseline(
  files,
  baselineFiles = DASHBOARD_STRICT_BASELINE_FILES,
) {
  const strictFiles = new Set(files.map(normalizeFile));
  const baseline = new Set(baselineFiles.map(normalizeFile));
  const missing = [...baseline].filter((file) => !strictFiles.has(file));
  if (missing.length > 0) {
    throw new Error(`dashboard strict config is missing baseline files:\n${missing.join("\n")}`);
  }

  const unrecorded = [...strictFiles].filter((file) => !baseline.has(file));
  if (unrecorded.length > 0) {
    throw new Error(
      `dashboard strict config has files missing from its baseline:\n${unrecorded.join("\n")}`,
    );
  }
}

function main() {
  const showConfig = runTsc(["-p", configPath, "--showConfig"]);
  if (showConfig.status !== 0) {
    process.stderr.write(showConfig.output);
    process.exitCode = 1;
    return;
  }

  const config = JSON.parse(showConfig.stdout);
  if (
    config.compilerOptions?.strict !== true ||
    config.compilerOptions?.noUncheckedIndexedAccess !== true ||
    config.compilerOptions?.exactOptionalPropertyTypes !== true
  ) {
    throw new Error("dashboard strict config must enable all strict flags");
  }

  const configuredFiles = Array.isArray(config.files) ? config.files : [];
  assertDashboardStrictBaseline(configuredFiles);
  const strictFiles = new Set(configuredFiles.map(normalizeFile));

  const check = runTsc(["-p", configPath, "--pretty", "false"]);
  if (check.status === 0) return;

  const selected = [];
  let includeContinuation = false;
  let recognizedDiagnostic = false;
  for (const line of check.output.split(/(?<=\n)/)) {
    const match = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (match) {
      recognizedDiagnostic = true;
      includeContinuation = strictFiles.has(normalizeFile(match[1]));
    } else if (/^error TS\d+:/.test(line)) {
      recognizedDiagnostic = true;
      includeContinuation = true;
    }
    if (includeContinuation) selected.push(line);
  }

  if (selected.length > 0 || !recognizedDiagnostic) {
    process.stderr.write(selected.length > 0 ? selected.join("") : check.output);
    process.exitCode = 1;
  }
}

function normalizeFile(file) {
  return path.normalize(file).replace(/^\.\//, "");
}

function runTsc(args) {
  const result = spawnSync(process.execPath, [tscPath, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
