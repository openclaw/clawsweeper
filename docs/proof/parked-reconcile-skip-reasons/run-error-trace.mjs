#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const EXPECTED_ARTIFACT_SHA256 = "1187c6042803b5ba98048d64157cb98a5399c1cbde76b69ce25f18dffe23b88f";
const proofDirectory = path.resolve("docs/proof/parked-reconcile-skip-reasons");
const artifactPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("usage: run-error-trace.mjs <production-parked-reviews.json>");
}

const artifactBytes = await readFile(artifactPath);
assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), EXPECTED_ARTIFACT_SHA256);
const inventory = JSON.parse(artifactBytes.toString("utf8"));
assert.equal(inventory.complete, true);
assert.equal(inventory.parked_reviews?.length, 20);
const replayRows = inventory.parked_reviews.map((row) => {
  if (row.excluded_reason !== null) return row;
  const { excluded_reason: _artifactNull, ...wireRow } = row;
  return wireRow;
});

const temporaryDirectory = await mkdtemp(joinTemp("clawsweeper-parked-error-trace-"));
try {
  const all403 = await runScenario("all-403", new Set());
  const mixedOpenTargets = new Set(
    inventory.parked_reviews.slice(0, 2).map((row) => `${row.target_repo}#${row.item_number}`),
  );
  const mixed = await runScenario("mixed", mixedOpenTargets);

  assert.deepEqual(all403.summary.skip_reasons, { http_403: 20 });
  assert.equal(all403.summary.skip_samples.length, 3);
  assert.deepEqual(mixed.summary.skip_reasons, { http_403: 18 });
  assert.equal(mixed.summary.open_targets, 2);
  assert.equal(mixed.summary.recovered_targets, 2);
  assert.equal(mixed.summary.skip_samples.length, 3);

  await writeJson("all-403-summary.json", all403.summary);
  await writeJson("mixed-summary.json", mixed.summary);
  await writeFile(
    path.join(proofDirectory, "after-fix-error-trace.jsonl"),
    [...all403.trace, ...mixed.trace].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );

  const operatorBytes = await readFile("scripts/exact-review-dead-letter-operator.mjs");
  const provenance = {
    schema: "clawsweeper-real-boundary-proof-provenance/v1",
    claim:
      "The current source-tree operator attributes loopback GitHub issue lookup failures per parked target while replaying the immutable 20-row production inventory read-only.",
    generated_at: new Date().toISOString(),
    source: {
      run_id: 31449984643,
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/31449984643",
      artifact_id: 9085971968,
      artifact_name: "exact-review-dlq-reconcile-31449984643-1",
      artifact_file: "parked-reviews.json",
      artifact_sha256: EXPECTED_ARTIFACT_SHA256,
      rows: 20,
    },
    execution: {
      operator: "scripts/exact-review-dead-letter-operator.mjs",
      operator_sha256: createHash("sha256").update(operatorBytes).digest("hex"),
      command:
        "node scripts/exact-review-dead-letter-operator.mjs --action reconcile-parked --max-targets 100 --max-recoveries 5 --output <temporary-path>",
      execute: false,
      transport: "real Node HTTP listener bound to 127.0.0.1 on an ephemeral port",
      github_api_url: "http://127.0.0.1:<ephemeral-port>",
      github_token: "unset",
      node: process.version,
    },
    scenarios: {
      all_403: {
        github_issue_responses: { http_403: 20 },
        request_count: all403.trace.length,
        summary_artifact: "all-403-summary.json",
      },
      mixed: {
        github_issue_responses: { http_200_open: 4, http_403: 18 },
        unique_open_targets: 2,
        request_count: mixed.trace.length,
        summary_artifact: "mixed-summary.json",
      },
    },
    trace_artifact: "after-fix-error-trace.jsonl",
    limits: [
      "The production artifact supplies inventory rows; queue pressure and GitHub responses are deterministic loopback HTTP responses.",
      "The artifact's explicit excluded_reason null values are omitted when replayed because the Worker wire payload omits that optional field; all substantive row values are unchanged.",
      "The operator ran without --execute, and the listener implemented no mutation endpoint.",
      "The trace records method, pathname, scenario, and response status only; request headers and local signing material are omitted.",
    ],
  };
  await writeJson("after-fix-error-trace-provenance.json", provenance);

  process.stdout.write(`${JSON.stringify({ all_403: all403.summary, mixed: mixed.summary })}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runScenario(name, openTargets) {
  const trace = [];
  const signingSecret = `loopback-${name}-signing-material`;
  let origin = "";
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    const pathname = new URL(request.url || "/", origin).pathname;
    if (pathname === "/api/exact-review-queue") {
      record(200);
      return json(response, 200, { pressure: { status: "idle", active: 0, capacity: 128 } });
    }
    if (pathname === "/internal/exact-review/parked-reviews/list" && request.method === "POST") {
      const signature = `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}`;
      assert.equal(request.headers["x-clawsweeper-exact-review-signature"], signature);
      record(200);
      return json(response, 200, {
        ok: true,
        parked_reviews: replayRows,
        next_cursor: null,
      });
    }
    const issue = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(pathname);
    if (issue) {
      const [, owner, repo, number] = issue.map(decodeURIComponent);
      const target = `${owner}/${repo}#${number}`;
      if (openTargets.has(target)) {
        record(200);
        return json(response, 200, {
          node_id: `LOOPBACK_${createHash("sha256").update(target).digest("hex").slice(0, 16)}`,
          state: "open",
          number: Number(number),
          repository_url: `${origin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        });
      }
      record(403);
      return json(response, 403, { message: "loopback proof: forbidden" });
    }
    record(404);
    return json(response, 404, { message: "loopback proof: route not implemented" });

    function record(status) {
      trace.push({ scenario: name, method: request.method, pathname, response_status: status });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await runOperator(name, origin, signingSecret);
    assert.equal(result.code, 0, result.stderr);
    return { summary: JSON.parse(result.stdout), trace };
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function runOperator(name, origin, signingSecret) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/exact-review-dead-letter-operator.mjs",
        "--action",
        "reconcile-parked",
        "--max-targets",
        "100",
        "--max-recoveries",
        "5",
        "--output",
        path.join(temporaryDirectory, `${name}-inventory.json`),
      ],
      {
        env: {
          ...process.env,
          EXACT_REVIEW_QUEUE_URL: origin,
          CLAWSWEEPER_WEBHOOK_SECRET: signingSecret,
          GITHUB_API_URL: origin,
          GITHUB_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function joinTemp(prefix) {
  return path.join(tmpdir(), prefix);
}

async function writeJson(name, value) {
  await writeFile(path.join(proofDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}
