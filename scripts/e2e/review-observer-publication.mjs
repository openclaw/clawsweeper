#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ExactReviewQueue } from "../../dashboard/exact-review-queue.ts";
import { TestStorage } from "../../test/exact-review-test-storage.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = "scripts/review-run-observer.mjs";
const secret = "synthetic-observer-proof-secret";
const token = "synthetic-observer-proof-token";
const repository = "example/observer-proof";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const command = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function sourceHashes() {
  const paths = command([
    "ls-files",
    "dashboard",
    "src",
    "config",
    "package.json",
    "pnpm-lock.yaml",
    "test/exact-review-test-storage.ts",
  ])
    .split("\n")
    .filter(Boolean);
  return {
    head: command(["rev-parse", "HEAD"]),
    cli: hash(readFileSync(join(root, cli))),
    harness: hash(readFileSync(fileURLToPath(import.meta.url))),
    ownerAndDependencyInputs: hash(
      JSON.stringify(paths.map((path) => [path, hash(readFileSync(join(root, path)))])),
    ),
    queue: hash(readFileSync(join(root, "dashboard/exact-review-queue.ts"))),
    storage: hash(readFileSync(join(root, "test/exact-review-test-storage.ts"))),
  };
}

function rows(storage) {
  return Array.from(
    storage.sql.exec(
      "SELECT run_id, run_attempt, record_json FROM exact_review_run_telemetry ORDER BY run_id, run_attempt",
    ),
  ).map((row) => ({
    run_id: row.run_id,
    run_attempt: row.run_attempt,
    payload: JSON.parse(row.record_json),
  }));
}

async function scenario(name, index) {
  const directory = mkdtempSync(join(tmpdir(), "review-observer-publication-"));
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const requests = [];
  const sockets = new Set();
  const handlers = new Set();
  const failures = [];
  let child;
  let joined;
  let childJoined = false;
  let watchdog;
  let timedOut = false;
  let jobsGets = 0;
  const runId = String(910001 + index);
  const event = {
    workflow_run: {
      id: Number(runId),
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      display_title: `Review manual item ${repository}#42`,
      event: "workflow_dispatch",
      run_started_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date().toISOString(),
      html_url: `https://github.com/${repository}/actions/runs/${runId}`,
    },
  };
  const expected = {
    run_id: runId,
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "exact_event",
    trigger_origin: "manual",
    target_repo: repository,
    started_at: event.workflow_run.run_started_at,
    completed_at: event.workflow_run.updated_at,
    run_url: event.workflow_run.html_url,
    plan_count: 0,
    item_count: 1,
    publication_count: 0,
    source_event: "workflow_dispatch",
    review_jobs: [{ name: "Review exact event item", conclusion: "success", item_number: 42 }],
  };
  const server = createServer((request, response) => {
    const handler = handle(request, response).catch((error) => {
      failures.push(error);
      response.destroy();
    });
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  async function handle(request, response) {
    if (request.method === "GET") {
      assert.equal(
        request.url,
        `/repos/${repository}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=1`,
      );
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      jobsGets++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_count: 1,
          jobs: [{ name: "Review exact event item", conclusion: "success" }],
        }),
      );
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/exact-review/review-run-telemetry");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const signature = request.headers["x-clawsweeper-exact-review-signature"];
    assert.equal(signature, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
    assert.deepEqual(JSON.parse(body), expected);
    if (requests.length) {
      assert.equal(body, requests[0].body);
      assert.equal(signature, requests[0].signature);
    }
    const observed = { attempt: requests.length + 1, at: performance.now(), body, signature };
    requests.push(observed);
    if (
      name === "terminal-400" ||
      name === "exhaustion" ||
      (name === "transient-500" && requests.length === 1)
    ) {
      observed.status = name === "terminal-400" ? 400 : 500;
      response.writeHead(observed.status);
      response.end("synthetic upstream failure");
      return;
    }
    if (name === "natural-timeout" && requests.length === 1) {
      // Leave headers unsent. Only the unmodified CLI's real 20-second deadline ends this request.
      response.on("close", () => {
        observed.closedAfterMs = performance.now() - observed.at;
      });
      return;
    }
    const result = await queue.fetch(
      new Request("http://queue/review-run-telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    observed.ownerStatus = result.status;
    observed.ownerReceipt = await result.json();
    assert.equal(result.status, 200);
    assert.deepEqual(observed.ownerReceipt, { ok: true });
    observed.rowsAfterCommit = rows(storage).length;
    assert.equal(observed.rowsAfterCommit, 1);
    if (name === "commit-lost-reply" && requests.length === 1) {
      observed.replyLostAfterCommit = true;
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(observed.ownerReceipt));
  }
  try {
    // Initialize through the real route before any injected failure, so zero-row assertions use its schema.
    const initialized = await queue.fetch(
      new Request("http://queue/review-run-telemetry", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(initialized.status, 400);
    await initialized.arrayBuffer();
    assert.deepEqual(rows(storage), []);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(join(directory, "home"));
    const eventFile = join(directory, "event.json");
    writeFileSync(eventFile, JSON.stringify(event), { mode: 0o600 });
    const started = performance.now();
    child = spawn(process.execPath, [join(root, cli), "--event-file", eventFile], {
      cwd: root,
      env: {
        HOME: join(directory, "home"),
        TMPDIR: directory,
        GH_TOKEN: token,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: address,
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        QUEUE_URL: address,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    joined = once(child, "close");
    watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 75_000);
    const [code, signal] = await joined;
    childJoined = true;
    clearTimeout(watchdog);
    const durationMs = performance.now() - started;
    await Promise.all(handlers);
    if (failures.length) throw new AggregateError(failures, `${name}: loopback handler failed`);
    assert.equal(timedOut, false, `${name}: proof watchdog expired`);
    assert.equal(signal, null);
    const rejected = name === "terminal-400" || name === "exhaustion";
    assert.equal(code, rejected ? 1 : 0, `${name}: ${stderr}`);
    assert.equal(jobsGets, 1);
    assert.equal(
      requests.length,
      name === "exhaustion" ? 3 : name === "success" || name === "terminal-400" ? 1 : 2,
    );
    const persisted = rows(storage);
    assert.deepEqual(
      persisted,
      rejected ? [] : [{ run_id: runId, run_attempt: 1, payload: expected }],
    );
    if (rejected) {
      assert.equal(stdout, "");
      assert.match(
        stderr,
        new RegExp(`review telemetry write returned ${name === "terminal-400" ? 400 : 500}`),
      );
    } else {
      assert.equal(stdout, `observed review run ${runId}/1 lane=exact_event items=1\n`);
    }
    assert.equal(
      (stderr.match(/review telemetry retry attempt=/g) ?? []).length,
      requests.length - 1,
    );
    if (name === "natural-timeout") {
      assert.ok(requests[0].closedAfterMs >= 19_000, "the request must reach the real deadline");
      assert.ok(requests[1].at - requests[0].at >= 20_000, "retry must follow the real deadline");
    }
    return {
      name,
      passed: true,
      exitCode: code,
      durationMs: Math.round(durationMs),
      jobsGets,
      attempts: requests.map(({ body, signature, at, ...entry }) => ({
        ...entry,
        sinceFirstMs: Math.round(at - requests[0].at),
        bodySha256: hash(body),
        signatureSha256: hash(signature),
      })),
      rowCount: persisted.length,
      rows: persisted,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } finally {
    clearTimeout(watchdog);
    if (child && !childJoined) {
      child.kill("SIGKILL");
      await joined?.catch(() => undefined);
    }
    const closed = new Promise((resolveClose) => server.close(resolveClose));
    for (const socket of sockets) socket.destroy();
    await closed;
    await Promise.all(handlers);
    rmSync(directory, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert.ok(values.output, "--output <new JSON path> is required");
const before = sourceHashes();
const originalFetch = globalThis.fetch;
let externalCalls = 0;
// The CLI runs in separate processes with native fetch. The local owner has no network authority.
globalThis.fetch = async () => {
  externalCalls++;
  throw new Error("owner external network forbidden");
};
try {
  const results = [];
  for (const [index, name] of [
    "success",
    "transient-500",
    "commit-lost-reply",
    "natural-timeout",
    "terminal-400",
    "exhaustion",
  ].entries()) {
    results.push(await scenario(name, index));
    process.stdout.write(`PASS ${name}\n`);
  }
  assert.equal(externalCalls, 0);
  assert.deepEqual(sourceHashes(), before, "source changed during proof");
  const receipt = {
    schema: 1,
    passed: true,
    command: "node scripts/e2e/review-observer-publication.mjs --output <new JSON path>",
    source: before,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      sqlite: process.versions.sqlite,
      executableSha256: hash(readFileSync(process.execPath)),
    },
    environment: {
      network: "IPv4 loopback only",
      childEnvironment:
        "explicit allowlist; synthetic credentials; isolated HOME and TMPDIR; no preload or timer override",
      externalCalls,
    },
    limits:
      "Actual CLI and native HTTP sockets; maintained ExactReviewQueue with TestStorage backed by real in-memory node:sqlite. GitHub jobs and failure responses are synthetic. HMAC verified by loopback adapter; Worker ingress authentication and Cloudflare deployment are not exercised. TestStorage databases live until this proof process exits. No live credentials, external service, alarm delivery, or production dispatch.",
    cleanup:
      "All CLI children joined, HTTP servers closed, sockets destroyed, request handlers joined, and task-created temporary directories removed before writing this receipt.",
    results,
  };
  writeFileSync(resolve(values.output), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
} finally {
  globalThis.fetch = originalFetch;
}
