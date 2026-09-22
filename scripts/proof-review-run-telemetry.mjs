import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import worker from "../dashboard/worker.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import {
  MemoryDurableStorage,
  MemoryDurableNamespace,
  leasedExactReviewQueueItem,
} from "../test/dashboard-worker-harness.ts";

const expectedCensus = process.argv.includes("--expect-census");
assert.ok(process.argv.slice(2).every((arg) => arg === "--expect-census"));
const root = mkdtempSync(join(tmpdir(), "clawsweeper-passive-telemetry-"));
const storage = new MemoryDurableStorage(join(root, "queue.sqlite"));
const queue = new ExactReviewQueue({ storage }, {});
const secret = "test-token-placeholder";
const env = {
  CLAWSWEEPER_WEBHOOK_SECRET: secret,
  EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
};
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await worker.fetch(
      new Request(`https://clawsweeper.openclaw.ai${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks),
      }),
      env,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  } catch {
    response.writeHead(500);
    response.end("fixture transport failed");
  }
});
const operations = [];
const originalExec = storage.sql.exec.bind(storage.sql);
let cursors = [];
storage.sql.exec = (query, ...bindings) => {
  const cursor = originalExec(query, ...bindings);
  if (/\bSELECT\b[\s\S]*\bFROM\s+exact_review_queue_items\b/i.test(query)) cursors.push(cursor);
  return cursor;
};
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/internal/exact-review/review-run-telemetry`;
  async function post(name, value, signed = true) {
    cursors = [];
    const body = JSON.stringify(value);
    const started = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: signed
        ? {
            "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          }
        : {},
      body,
    });
    const result = await response.json();
    operations.push({
      name,
      status: response.status,
      queueRowsRead: cursors.reduce((count, cursor) => count + cursor.rowsRead, 0),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    });
    return { status: response.status, result };
  }
  assert.equal((await post("initialize", {})).status, 400);
  const count = 2_000;
  const items = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const item = leasedExactReviewQueueItem(900_000 + index, String(900_000 + index));
      item.decision.additionalPrompt = "synthetic context ".repeat(512);
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { items });
  const alarm = Date.now() + 60_000;
  await storage.setAlarm(alarm);
  const snapshot = () =>
    Array.from(
      originalExec("SELECT item_key, item_json FROM exact_review_queue_items ORDER BY item_key"),
    );
  const before = snapshot();
  const digest = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const beforeDigest = digest(before);
  const queueBytes = before.reduce((total, row) => total + Buffer.byteLength(row.item_json), 0);
  const record = {
    run_id: "60000",
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/60000",
    plan_count: 1,
    item_count: 4,
    publication_count: 1,
  };
  operations.length = 0;
  assert.equal((await post("unsigned", record, false)).status, 401);
  assert.deepEqual(await post("write", record), { status: 200, result: { ok: true } });
  assert.equal(operations.at(-1).queueRowsRead, expectedCensus ? count : 0);
  assert.equal(await storage.getAlarm(), alarm);
  assert.equal((await post("duplicate", { ...record, workflow_outcome: "failure" })).status, 200);
  assert.equal((await post("invalid", { ...record, run_attempt: 0 })).status, 400);
  const expired = {
    ...record,
    run_id: "60001",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/60001",
    started_at: new Date(Date.now() - 32 * 86_400_000).toISOString(),
    completed_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
  };
  assert.equal((await post("expired-write", expired)).status, 200);
  storage.sql.failNext(
    /INSERT OR IGNORE INTO exact_review_run_telemetry/,
    new Error("synthetic telemetry store failure"),
  );
  assert.deepEqual(await post("storage-failure", record), {
    status: 500,
    result: { error: "exact_review_queue_unavailable" },
  });
  assert.equal(Array.from(originalExec("SELECT run_id FROM exact_review_run_telemetry")).length, 2);
  assert.equal((await post("retention-prune", record)).status, 200);
  const rows = Array.from(
    originalExec("SELECT run_id, workflow_outcome FROM exact_review_run_telemetry"),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, "60000");
  assert.equal(rows[0].workflow_outcome, "success");
  assert.equal(await storage.getAlarm(), alarm);
  assert.equal(digest(snapshot()), beforeDigest);
  for (const operation of operations) {
    assert.equal(operation.queueRowsRead, expectedCensus && operation.status === 200 ? count : 0);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        syntheticOnly: true,
        liveServices: false,
        transport: "loopback HTTP",
        storage: "file-backed node:sqlite",
        queueItems: count,
        queueBytes,
        queueItemsUnchanged: true,
        alarmUnchanged: true,
        dedupePreserved: true,
        retentionPreserved: true,
        storageFailureRollback: true,
        expectedCensus,
        operations,
        limits:
          "Local Worker/DO request handlers with storage and binding adapters; no hosted Cloudflare execution or production overload attribution.",
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  storage.sql.close();
  rmSync(root, { recursive: true, force: true });
}
