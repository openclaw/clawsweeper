#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const EXPECTED_ARTIFACT_SHA256 = "1187c6042803b5ba98048d64157cb98a5399c1cbde76b69ce25f18dffe23b88f";
const artifactPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("usage: run-production-replay.mjs <production-parked-reviews.json>");
}
assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN must come from the authenticated gh session");

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

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "clawsweeper-cap-replay-"));
const signingSecret = "reconcile-cap-read-only-loopback";
let origin = "";
const server = createServer(async (request, response) => {
  const body = await requestBody(request);
  const pathname = new URL(request.url || "/", origin).pathname;
  if (pathname === "/api/exact-review-queue") {
    return json(response, 200, { pressure: { status: "idle", active: 0, capacity: 128 } });
  }
  if (pathname === "/internal/exact-review/parked-reviews/list" && request.method === "POST") {
    const signature = `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], signature);
    return json(response, 200, { ok: true, parked_reviews: replayRows, next_cursor: null });
  }
  return json(response, 404, { message: "read-only proof route not implemented" });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
origin = `http://127.0.0.1:${address.port}`;

try {
  const result = await runOperator();
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.dry_run, true);
  assert.equal(summary.inspected_targets, 20);
  assert.equal(summary.open_targets + summary.terminal_targets, 20);
  assert.equal(summary.skip_reasons.recovery_cap, summary.open_targets - summary.recovered_targets);
  process.stdout.write(
    `${JSON.stringify({
      summary,
      provenance: {
        schema: "clawsweeper-real-boundary-proof-provenance/v1",
        generated_at: new Date().toISOString(),
        source: {
          run_id: 31449984643,
          artifact_id: 9085971968,
          artifact_name: "exact-review-dlq-reconcile-31449984643-1",
          artifact_file: "parked-reviews.json",
          artifact_sha256: EXPECTED_ARTIFACT_SHA256,
          rows: replayRows.length,
        },
        execution: {
          operator: "scripts/exact-review-dead-letter-operator.mjs",
          operator_sha256: createHash("sha256")
            .update(await readFile("scripts/exact-review-dead-letter-operator.mjs"))
            .digest("hex"),
          execute: false,
          inventory_transport: "signed loopback list route",
          github_target_reads: "live api.github.com with authenticated gh token",
          mutation_routes: "not implemented",
          node: process.version,
        },
        limits: [
          "The immutable artifact supplies inventory while target state is read live.",
          "The loopback server exposes only queue pressure and inventory list routes.",
          "This proof does not exercise queue mutation or the stopped handoff-health half.",
        ],
      },
    })}\n`,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function runOperator() {
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
        path.join(temporaryDirectory, "inventory.json"),
      ],
      {
        env: {
          ...process.env,
          EXACT_REVIEW_QUEUE_URL: origin,
          CLAWSWEEPER_WEBHOOK_SECRET: signingSecret,
          GITHUB_API_URL: "https://api.github.com",
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
