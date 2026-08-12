#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createWriteStream, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";

import {
  githubEgressTelemetrySubmissions,
  submitGitHubEgressTelemetry,
} from "../../../dist/repair/github-egress-telemetry-client.js";

const repoRoot = process.cwd();
const outputDir = required("GITHUB_EGRESS_PROOF_OUTPUT");
const scratch = required("GITHUB_EGRESS_PROOF_SCRATCH");
const tlsKey = required("GITHUB_EGRESS_PROOF_TLS_KEY");
const tlsCert = required("GITHUB_EGRESS_PROOF_TLS_CERT");
const realGh = required("GITHUB_EGRESS_PROOF_REAL_GH");
const wrapper = path.join(repoRoot, "scripts/github-egress-observer.sh");
const metricsPath = path.join(scratch, "github-egress.jsonl");
const rateLimitPath = path.join(scratch, "github-rate-limits.jsonl");
const persistPath = path.join(scratch, "wrangler-state");
const workerLogPath = path.join(scratch, "wrangler.log");
const proofSecret = "disposable-github-egress-proof-secret";
const workers = [];
const requestSummary = new Map();
const candidateHead = process.env.GITHUB_EGRESS_PROOF_SOURCE_SHA || (await gitHead());

await mkdir(outputDir, { recursive: true });
await Promise.all(
  [
    "proof-summary.json",
    "public-observability.json",
    "public-observability-15m.json",
    "wrangler.log",
  ].map((name) => rm(path.join(outputDir, name), { force: true })),
);

const github = createHttpsServer(
  { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) },
  githubRequest,
);
await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
const githubAddress = github.address();
assert.ok(githubAddress && typeof githubAddress !== "string");
const githubHost = `127.0.0.1:${githubAddress.port}`;

const commonEnv = {
  ...process.env,
  GH_HOST: githubHost,
  GH_ENTERPRISE_TOKEN: "disposable-loopback-token",
  SSL_CERT_FILE: tlsCert,
  CLAWSWEEPER_REAL_GH_BIN: realGh,
  CLAWSWEEPER_GITHUB_OBSERVER_ROOT: repoRoot,
  CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: metricsPath,
  CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: rateLimitPath,
  CLAWSWEEPER_GITHUB_STAGE: "publication_prepare",
  CLAWSWEEPER_GITHUB_SOURCE_ACTION: "scheduled_hot_intake",
  CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "2",
  CLAWSWEEPER_GITHUB_REQUEST_REPEAT: "false",
  CLAWSWEEPER_DEPLOYMENT_REVISION: candidateHead,
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  TARGET_REPO: "proof-owner/proof-repo",
  EXACT_REVIEW_BATCH_MAX_ITEMS: "8",
  EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY: "1",
};

try {
  const paginationArgs = [
    "api",
    "repos/proof-owner/proof-repo/issues/42/comments?per_page=1",
    "--paginate",
    "--slurp",
  ];
  await assertBehaviorPreserved(paginationArgs, "repository_actions", true);
  await assertBehaviorPreserved(
    ["api", "repos/proof-owner/proof-repo/issues/43/comments"],
    "repository_actions",
    false,
  );
  const parserFailureArgs = ["api", "repos/proof-owner/proof-repo/issues/43/comments"];
  const parserFailureDirect = await command(
    realGh,
    parserFailureArgs,
    { ...commonEnv, GH_DEBUG: "" },
    true,
  );
  const parserFailureObserved = await command(
    "bash",
    [wrapper, ...parserFailureArgs],
    {
      ...commonEnv,
      CLAWSWEEPER_GITHUB_OBSERVER_ROOT: path.join(scratch, "missing-observer"),
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    },
    true,
  );
  assert.equal(parserFailureObserved.status, parserFailureDirect.status);
  assert.deepEqual(parserFailureObserved.stdout, parserFailureDirect.stdout);
  assert.deepEqual(parserFailureObserved.stderr, parserFailureDirect.stderr);
  const noNewlineGh = path.join(scratch, "gh-no-newline");
  await writeFile(
    noNewlineGh,
    `#!/usr/bin/env bash
printf '%s\n' '* Request at 2026-08-12T12:00:00Z' '> GET /repos/proof/private HTTP/1.1' '* Request took 1ms' >&2
printf '%s' 'ordinary-error-without-newline' >&2
exit 73
`,
  );
  await chmod(noNewlineGh, 0o755);
  const noNewlineObserved = await command(
    "bash",
    [wrapper, "api", "repos/proof/private"],
    {
      ...commonEnv,
      CLAWSWEEPER_REAL_GH_BIN: noNewlineGh,
      CLAWSWEEPER_GITHUB_OBSERVER_ROOT: path.join(scratch, "missing-observer"),
      CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    },
    true,
  );
  assert.equal(noNewlineObserved.status, 73);
  assert.deepEqual(noNewlineObserved.stdout, Buffer.alloc(0));
  assert.deepEqual(noNewlineObserved.stderr, Buffer.from("ordinary-error-without-newline"));
  await observedGh(
    ["api", "repos/proof-owner/proof-repo/issues/44/comments"],
    "public_read_fallback",
  );
  await observedGh(["api", "repos/proof-owner/proof-repo/issues/45/comments"], "target_app");
  await assertBehaviorPreserved(
    ["api", "repos/proof-owner/proof-repo/mystery/private"],
    "repository_actions",
    true,
  );
  const directArtifactDir = path.join(scratch, "direct-artifact");
  const observedArtifactDir = path.join(scratch, "observed-artifact");
  await mkdir(directArtifactDir, { recursive: true });
  await mkdir(observedArtifactDir, { recursive: true });
  const directArtifact = await command(
    realGh,
    [
      "run",
      "download",
      "46",
      "--repo",
      "proof-owner/proof-repo",
      "--name",
      "proof-artifact",
      "--dir",
      directArtifactDir,
    ],
    { ...commonEnv, GH_DEBUG: "" },
  );
  const observedArtifact = await observedGh(
    [
      "run",
      "download",
      "46",
      "--repo",
      "proof-owner/proof-repo",
      "--name",
      "proof-artifact",
      "--dir",
      observedArtifactDir,
    ],
    "repository_actions",
  );
  assert.equal(observedArtifact.status, directArtifact.status);
  assert.deepEqual(observedArtifact.stdout, directArtifact.stdout);
  assert.deepEqual(observedArtifact.stderr, directArtifact.stderr);
  await command(process.execPath, ["dist/github-egress-observer-cli.js", "record-member"], {
    ...commonEnv,
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
  });

  const baselineSamples = [];
  const observedSamples = [];
  for (let index = 0; index < 12; index += 1) {
    baselineSamples.push(
      (
        await command(realGh, ["api", "repos/proof-owner/proof-repo/issues/44/comments"], {
          ...commonEnv,
          GH_DEBUG: "",
        })
      ).elapsedMs,
    );
  }
  for (let index = 0; index < 12; index += 1) {
    observedSamples.push(
      (
        await observedGh(
          ["api", "repos/proof-owner/proof-repo/issues/44/comments"],
          "repository_actions",
        )
      ).elapsedMs,
    );
  }

  const metrics = jsonLines(await readFile(metricsPath, "utf8"));
  const rateLimits = jsonLines(await readFile(rateLimitPath, "utf8"));
  const totals = countBy(metrics, "unit");
  assert.deepEqual(totals, { invocation: 18, member: 1, wire_attempt: 19 });
  assert.equal(rateLimits.length, 1);
  assert.equal(rateLimits[0].status, 403);
  assert.equal(rateLimits[0].headers.retryAfterPresent, true);
  assert.equal(rateLimits[0].headers.retryAfterSeconds, 120);
  assert.equal(rateLimits[0].headers.resetPresent, true);
  assert.equal(rateLimits[0].resetAuthorityCandidate, "retry_after");
  assert.equal(
    sum(
      metrics.filter(
        (metric) => metric.unit === "wire_attempt" && metric.poolClass === "public_read_fallback",
      ),
    ),
    1,
  );
  assert.equal(
    sum(
      metrics.filter(
        (metric) => metric.unit === "wire_attempt" && metric.poolClass === "target_app",
      ),
    ),
    1,
  );
  const incompleteWire = metrics.filter(
    (metric) => metric.unit === "wire_attempt" && metric.telemetryComplete === false,
  );
  assert.equal(sum(incompleteWire), 1, JSON.stringify(incompleteWire));

  privacyScan(`${JSON.stringify(metrics)}\n${JSON.stringify(rateLimits)}`);
  const submissions = githubEgressTelemetrySubmissions({
    metricsPath,
    rateLimitPath,
    receiptScope: "github-egress-proof:1:loopback",
  });
  assert.equal(submissions.length, 1);
  const emptySinkSubmissions = githubEgressTelemetrySubmissions({
    metricsPath: path.join(scratch, "missing-egress.jsonl"),
    rateLimitPath: path.join(scratch, "missing-rate-limits.jsonl"),
    receiptScope: "github-egress-proof:1:missing-sink",
  });
  assert.equal(emptySinkSubmissions.length, 1);
  assert.equal(emptySinkSubmissions[0].metrics.length, 1);
  assert.equal(emptySinkSubmissions[0].metrics[0].unit, "invocation");
  assert.equal(emptySinkSubmissions[0].metrics[0].attempted, false);
  assert.equal(emptySinkSubmissions[0].metrics[0].telemetryComplete, false);

  const workerPort = await availablePort();
  let worker = await startWorker(workerPort, persistPath, workerLogPath);
  workers.push(worker);
  await waitForWorker(worker.origin);
  const firstUpload = await submitGitHubEgressTelemetry({
    baseUrl: "https://proof.invalid",
    webhookSecret: proofSecret,
    submission: submissions[0],
    fetch: rewriteFetch(worker.origin),
  });
  assert.deepEqual(firstUpload, { accepted: true, deduped: false });
  const emptySinkUpload = await submitGitHubEgressTelemetry({
    baseUrl: "https://proof.invalid",
    webhookSecret: proofSecret,
    submission: emptySinkSubmissions[0],
    fetch: rewriteFetch(worker.origin),
  });
  assert.deepEqual(emptySinkUpload, { accepted: true, deduped: false });
  const beforeRestart = await getJson(`${worker.origin}/api/github-egress-observability?hours=1`);
  assertPublicView(beforeRestart);

  await stopWorker(worker);
  workers.splice(workers.indexOf(worker), 1);
  worker = await startWorker(workerPort, persistPath, workerLogPath, true);
  workers.push(worker);
  await waitForWorker(worker.origin);
  const afterRestart = await getJson(`${worker.origin}/api/github-egress-observability?hours=1`);
  assert.deepEqual(afterRestart.rows, beforeRestart.rows);
  assert.deepEqual(afterRestart.rate_limit_observations, beforeRestart.rate_limit_observations);
  const duplicateUpload = await submitGitHubEgressTelemetry({
    baseUrl: "https://proof.invalid",
    webhookSecret: proofSecret,
    submission: submissions[0],
    fetch: rewriteFetch(worker.origin),
  });
  assert.deepEqual(duplicateUpload, { accepted: false, deduped: true });
  const afterDuplicate = await getJson(`${worker.origin}/api/github-egress-observability?hours=1`);
  assert.deepEqual(afterDuplicate.rows, beforeRestart.rows);
  const fifteenMinuteView = await getJson(
    `${worker.origin}/api/github-egress-observability?hours=0.25`,
  );
  assert.equal(fifteenMinuteView.window.hours, 0.25);
  assertPublicView(fifteenMinuteView);

  privacyScan(JSON.stringify(afterDuplicate));
  privacyScan(JSON.stringify(fifteenMinuteView));
  const baselineMedianMs = median(baselineSamples);
  const observedMedianMs = median(observedSamples);
  const addedMedianMs = observedMedianMs - baselineMedianMs;
  assert.ok(addedMedianMs < 1_000, `observer median overhead was ${addedMedianMs}ms`);

  const summary = {
    schema: "github-egress-telemetry-proof/v1",
    generated_at: new Date().toISOString(),
    candidate_head: candidateHead,
    runtime: {
      node: process.version,
      gh: (await command(realGh, ["--version"], commonEnv)).stdout.toString("utf8").split("\n")[0],
      worker: "wrangler 4.107.0 dev --local",
      durable_object: "SQLite-backed ExactReviewQueue",
      transport: "real loopback TLS GitHub CLI and HTTP Worker sockets",
    },
    assertions: {
      wire_attempts: totals.wire_attempt,
      invocations: totals.invocation,
      members: totals.member,
      pagination_pages: 3,
      rate_limit_observations: rateLimits.length,
      repository_actions_wire_attempts: sum(
        metrics.filter(
          (metric) => metric.unit === "wire_attempt" && metric.poolClass === "repository_actions",
        ),
      ),
      public_read_fallback_wire_attempts: 1,
      target_app_wire_attempts: 1,
      incomplete_unknown_route_wire_attempts: 1,
      empty_sink_incomplete_invocations: 1,
      restart_rows_preserved: true,
      duplicate_upload_deduped: true,
      fifteen_minute_public_query_complete: fifteenMinuteView.completeness.query_complete,
      output_and_exit_preserved: true,
      parser_failure_error_preserved: true,
      sentinel_privacy_scan_passed: true,
    },
    request_summary: Object.fromEntries([...requestSummary].sort()),
    overhead: {
      samples_per_lane: 12,
      baseline_median_ms: baselineMedianMs,
      observed_median_ms: observedMedianMs,
      added_median_ms: addedMedianMs,
      note: "Loopback process-launch timing; not a production latency benchmark.",
    },
    production_mutations: 0,
    openclaw_bay_affected: false,
    run_status: "succeeded",
    limits: [
      "Synthetic loopback GitHub responses, not live GitHub quota consumption.",
      "The artifact invocation is real, but its internal inventory and archive wire count remains deliberately opaque.",
      "The proof observes telemetry only; it does not exercise Phase 1 admission or circuit behavior.",
    ],
  };
  await writeFile(
    path.join(outputDir, "public-observability.json"),
    `${JSON.stringify(afterDuplicate, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "public-observability-15m.json"),
    `${JSON.stringify(fifteenMinuteView, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDir, "proof-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await Promise.all(workers.map(stopWorker));
  await new Promise((resolve) => github.close(resolve));
  const workerLog = await readFile(workerLogPath, "utf8").catch(() => "");
  await writeFile(
    path.join(outputDir, "wrangler.log"),
    workerLog.replaceAll(proofSecret, "[redacted-local-proof-secret]").slice(0, 32_000),
  );
}

function githubRequest(request, response) {
  const url = new URL(request.url || "/", "https://loopback.invalid");
  const pathKey = routeKey(url.pathname);
  const key = `${request.method || "UNKNOWN"} ${pathKey}`;
  requestSummary.set(key, (requestSummary.get(key) || 0) + 1);
  const commonHeaders = {
    "content-type": "application/json",
    etag: '"synthetic-etag-secret"',
    "x-github-request-id": "synthetic-request-id-secret",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-resource": "core",
  };
  if (url.pathname.endsWith("/actions/runs/46/artifacts")) {
    response.writeHead(200, commonHeaders);
    response.end(
      JSON.stringify({
        total_count: 1,
        artifacts: [
          {
            id: 9001,
            name: "proof-artifact",
            size_in_bytes: 22,
            archive_download_url: `https://${request.headers.host}/api/v3/repos/proof-owner/proof-repo/actions/artifacts/9001/zip`,
            expired: false,
            created_at: "2026-08-12T10:00:00Z",
            updated_at: "2026-08-12T10:00:00Z",
            expires_at: "2026-08-13T10:00:00Z",
            workflow_run: { id: 46 },
          },
        ],
      }),
    );
    return;
  }
  if (url.pathname.endsWith("/actions/artifacts/9001/zip")) {
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64"));
    return;
  }
  if (url.pathname.endsWith("/issues/43/comments")) {
    response.writeHead(403, {
      ...commonHeaders,
      "retry-after": "120",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-used": "5000",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
    });
    response.end(JSON.stringify({ message: "synthetic rate limit body secret" }));
    return;
  }
  if (url.pathname.endsWith("/issues/42/comments")) {
    const page = Number(url.searchParams.get("page") || "1");
    const headers = {
      ...commonHeaders,
      "x-ratelimit-remaining": "100",
      "x-ratelimit-used": "4900",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    };
    if (page < 3) {
      headers.link = `<https://${request.headers.host}${url.pathname}?per_page=1&page=${page + 1}>; rel="next"`;
    }
    response.writeHead(200, headers);
    response.end(JSON.stringify([{ id: page, body: "synthetic page body secret" }]));
    return;
  }
  response.writeHead(200, {
    ...commonHeaders,
    "x-ratelimit-remaining": "100",
    "x-ratelimit-used": "4900",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  });
  response.end(JSON.stringify([{ id: 1, body: "synthetic body secret" }]));
}

function routeKey(pathname) {
  if (pathname.endsWith("/issues/42/comments")) return "issue_comments_paginated";
  if (pathname.endsWith("/issues/43/comments")) return "issue_comments_throttled";
  if (pathname.endsWith("/issues/44/comments")) return "issue_comments_control";
  if (pathname.endsWith("/issues/45/comments")) return "issue_comments_target_app";
  if (pathname.endsWith("/actions/runs/46/artifacts")) return "artifact_inventory";
  if (pathname.endsWith("/actions/artifacts/9001/zip")) return "artifact_archive";
  return "unknown_route";
}

async function assertBehaviorPreserved(args, poolClass, expectSuccess) {
  const direct = await command(realGh, args, { ...commonEnv, GH_DEBUG: "" }, true);
  const observed = await observedGh(args, poolClass, true);
  assert.equal(observed.status, direct.status);
  assert.deepEqual(observed.stdout, direct.stdout);
  assert.deepEqual(observed.stderr, direct.stderr);
  assert.equal(observed.status === 0, expectSuccess);
}

function observedGh(args, poolClass, allowFailure = false) {
  return command(
    "bash",
    [wrapper, ...args],
    { ...commonEnv, CLAWSWEEPER_GITHUB_POOL_CLASS: poolClass },
    allowFailure,
  );
}

function command(executable, args, env, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = {
        status: status ?? 128,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      };
      if (!allowFailure && (status !== 0 || signal)) {
        reject(
          new Error(
            `${executable} ${args.join(" ")} failed (${status}/${signal}): ${result.stderr.toString("utf8")}`,
          ),
        );
      } else resolve(result);
    });
  });
}

async function startWorker(port, persist, logPath, append = false) {
  const log = createWriteStream(logPath, { flags: append ? "a" : "w" });
  const child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.107.0",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--config",
      "dashboard/wrangler.toml",
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${proofSecret}`,
    ],
    {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, log, origin: `http://127.0.0.1:${port}` };
}

async function waitForWorker(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker did not become ready: ${origin}`);
}

async function stopWorker(worker) {
  if (!worker?.child) return;
  signalProcessTree(worker.child, "SIGTERM");
  if (worker.child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => worker.child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  signalProcessTree(worker.child, "SIGKILL");
  await new Promise((resolve) => worker.log.end(resolve));
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function rewriteFetch(origin) {
  return (input, init) => fetch(String(input).replace("https://proof.invalid", origin), init);
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function assertPublicView(view) {
  assert.equal(view.version, 2);
  assert.equal(view.completeness.rows_truncated, false);
  assert.equal(view.completeness.rate_limit_rows_truncated, false);
  assert.equal(view.completeness.query_complete, true);
  assert.equal(view.rate_limit_observations.length, 1);
  assert.equal(view.privacy.pool_identity, "withheld");
  const totals = countBy(view.rows, "unit");
  assert.deepEqual(totals, { invocation: 19, member: 1, wire_attempt: 19 });
}

function privacyScan(serialized) {
  for (const sentinel of [
    "proof-owner",
    "proof-repo",
    "synthetic-etag-secret",
    "synthetic-request-id-secret",
    "synthetic page body secret",
    "synthetic rate limit body secret",
    "disposable-loopback-token",
    "/issues/",
    "https://127.0.0.1",
  ]) {
    assert.equal(serialized.includes(sentinel), false, `privacy sentinel: ${sentinel}`);
  }
}

function jsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function countBy(rows, key) {
  return Object.fromEntries(
    [...new Set(rows.map((row) => row[key]))]
      .sort()
      .map((value) => [value, sum(rows.filter((row) => row[key] === value))]),
  );
}

function sum(rows) {
  return rows.reduce((total, row) => total + Number(row.count || 0), 0);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[midpoint] : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function gitHead() {
  const result = await command("git", ["rev-parse", "HEAD"], process.env);
  return result.stdout.toString("utf8").trim();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
