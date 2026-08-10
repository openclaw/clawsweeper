#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const phase = process.argv[2];
if (!new Set(["exhaust", "reconcile"]).has(phase)) {
  throw new Error("usage: run-proof.mjs <exhaust|reconcile>");
}

const outputDir = path.resolve(required("PARKED_REVIEW_RECONCILE_PROOF_OUTPUT"));
const workerOrigin = loopbackOrigin(required("PARKED_REVIEW_RECONCILE_WORKER_ORIGIN"));
const githubOrigin = loopbackOrigin(required("PARKED_REVIEW_RECONCILE_GITHUB_ORIGIN"));
const webhookSecret = required("PARKED_REVIEW_RECONCILE_WEBHOOK_SECRET");
const operatorSecret = required("PARKED_REVIEW_RECONCILE_OPERATOR_SECRET");
await mkdir(outputDir, { recursive: true });

if (phase === "exhaust") await exhaustRecoveryBudget();
else await reconcileParkedReviews();

async function exhaustRecoveryBudget() {
  for (const number of [114100, 114101]) {
    const result = await signedPost(
      "/internal/exact-review/enqueue",
      {
        delivery_id: `parked-review-proof-${number}`,
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: number,
          itemKind: "issue",
          sourceEvent: "issues",
          sourceAction: "opened",
          supersedesInProgress: false,
        },
      },
      webhookSecret,
    );
    assert.equal(result.status, 202);
    assert.equal(result.body.queued, true);
  }

  const deadline = Date.now() + 60 * 60_000;
  let prior = "";
  for (;;) {
    const inventory = await signedPost(
      "/internal/exact-review/parked-reviews/list",
      { limit: 50 },
      operatorSecret,
    );
    assert.equal(inventory.status, 200);
    const rows = inventory.body.parked_reviews || [];
    const progress = rows
      .map((row) => `${row.item_key}:${row.parked_recovery_attempts}`)
      .sort()
      .join(",");
    if (progress !== prior) {
      process.stdout.write(
        `parked recovery progress ${new Date().toISOString()} ${progress || "none"}\n`,
      );
      prior = progress;
    }
    if (
      rows.length === 2 &&
      rows.every(
        (row) => row.parked_reason === "dispatch_rejected" && row.parked_recovery_attempts === 3,
      )
    ) {
      await writeJson("parked-inventory-exhausted.json", inventory.body);
      await writeJson("exhaustion-summary.json", {
        exhausted_at: new Date().toISOString(),
        rows: rows.map((row) => ({
          item_key: row.item_key,
          parked_reason: row.parked_reason,
          parked_recovery_attempts: row.parked_recovery_attempts,
        })),
      });
      return;
    }
    if (Date.now() >= deadline) throw new Error("parked recovery budget did not exhaust in 60m");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function reconcileParkedReviews() {
  const control = await fetch(`${githubOrigin}/__proof/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reject_dispatch: false, issue_114101_state: "closed" }),
  });
  assert.equal(control.status, 200);

  const operator = await runOperator();
  await writeFile(path.join(outputDir, "operator.stdout.log"), operator.stdout);
  await writeFile(path.join(outputDir, "operator.stderr.log"), operator.stderr);
  assert.equal(operator.code, 0, operator.stderr);
  const result = JSON.parse(operator.stdout);
  assert.deepEqual(
    {
      action: result.action,
      dry_run: result.dry_run,
      inspected_targets: result.inspected_targets,
      terminal_targets: result.terminal_targets,
      resolved_targets: result.resolved_targets,
      open_targets: result.open_targets,
      recovered_targets: result.recovered_targets,
      skipped_targets: result.skipped_targets,
    },
    {
      action: "reconcile-parked",
      dry_run: false,
      inspected_targets: 2,
      terminal_targets: 1,
      resolved_targets: 1,
      open_targets: 1,
      recovered_targets: 1,
      skipped_targets: 0,
    },
  );

  const open = await getJson(
    "/api/exact-review-queue/item?target_repo=openclaw%2Fopenclaw&item_number=114100",
  );
  const terminal = await getJson(
    "/api/exact-review-queue/item?target_repo=openclaw%2Fopenclaw&item_number=114101",
  );
  const finalInventory = await signedPost(
    "/internal/exact-review/parked-reviews/list",
    { limit: 50 },
    operatorSecret,
  );
  await writeJson("open-target-after.json", open.body);
  await writeJson("terminal-target-after.json", terminal.body);
  await writeJson("parked-inventory-final.json", finalInventory.body);
  assert.equal(open.status, 200);
  assert.equal(open.body.items.length, 1);
  assert.equal(open.body.items[0].state, "pending");
  assert.equal(open.body.items[0].attempts, 0);
  assert.equal(open.body.items[0].parked_recovery_attempts, 0);
  assert.equal(terminal.status, 200);
  assert.equal(terminal.body.items.length, 0);
  assert.equal(finalInventory.status, 200);
  assert.deepEqual(finalInventory.body.parked_reviews, []);

  const proofSummary = {
    proof: "parked review inventory and reconcile",
    source_sha: process.env.SOURCE_SHA || null,
    completed_at: new Date().toISOString(),
    assertions: {
      durable_object_instantiated: true,
      automatic_recovery_attempts_exhausted: 3,
      terminal_target_resolved: true,
      open_target_recovered_pending: true,
      final_parked_inventory_rows: 0,
    },
    operator: result,
  };
  await writeJson("proof-summary.json", proofSummary);
  process.stdout.write(`${JSON.stringify(proofSummary)}\n`);
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
        "--execute",
        "--output",
        path.join(outputDir, "parked-operator-inventory.json"),
      ],
      {
        env: {
          ...process.env,
          EXACT_REVIEW_QUEUE_URL: workerOrigin,
          CLAWSWEEPER_WEBHOOK_SECRET: operatorSecret,
          GITHUB_API_URL: githubOrigin,
          GITHUB_TOKEN: "loopback-proof-token",
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

async function signedPost(pathname, payload, secret) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${workerOrigin}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(pathname) {
  const response = await fetch(`${workerOrigin}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function writeJson(name, value) {
  await writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function required(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/"
  ) {
    throw new Error(`proof origin must be explicit-port loopback HTTP: ${value}`);
  }
  return url.origin;
}
