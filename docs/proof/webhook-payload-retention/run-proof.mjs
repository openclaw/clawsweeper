import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "webhook-payload-proof-"));
mkdirSync(path.join(root, "home"));
const nonce = randomUUID();
const now = Date.parse("2026-10-14T00:00:00Z");
let child;
let exited;
let diagnostics = "";
let baseUrl;

async function stop() {
  if (!child?.pid) return;
  const pid = child.pid;
  const signal = (name) => {
    try {
      process.kill(-pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    signal("SIGKILL");
    child = null;
  }
}

async function start() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(
    process.env.WRANGLER_BIN || "wrangler",
    [
      "dev",
      "--config",
      "docs/proof/webhook-payload-retention/wrangler.toml",
      "--local",
      "--persist-to",
      path.join(root, "state"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--var",
      `PROOF_NONCE:${nonce}`,
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  exited = once(child, "exit");
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4000);
    });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`local Worker exited: ${diagnostics}`);
    try {
      const response = await fetch(`${baseUrl}/ready`, {
        headers: { "x-proof-nonce": nonce },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`local Worker startup timed out: ${diagnostics}`);
}

async function send(route) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proof-nonce": nonce },
    body: JSON.stringify({ now }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

try {
  await start();
  const before = await send("/seed");
  assert.equal(before.retainedRows, 71);
  assert.equal(before.placeholders.usable, true);
  assert.deepEqual(await send("/prune"), { pruned: 64 });
  await stop();
  await start();
  assert.deepEqual(await send("/prune"), { pruned: 7 });
  assert.deepEqual(await send("/prune"), { pruned: 0 });
  const retired = await send("/read");
  assert.ok(retired.payloadBytes < before.payloadBytes / 50);
  assert.ok(retired.databaseBytes < before.databaseBytes);
  assert.equal(retired.retainedRows, before.retainedRows);
  assert.equal(retired.receipts, before.receipts);
  assert.equal(retired.item.usable, false);
  assert.equal(retired.comments.usable, false);
  assert.deepEqual(retired.comments.tombstones, [2]);
  assert.equal(retired.placeholders.usable, false);
  const repaired = await send("/repair");
  assert.equal(repaired.item.usable, true);
  assert.equal(repaired.comments.usable, true);
  assert.deepEqual(repaired.comments.tombstones, [2]);
  assert.equal(repaired.placeholders.usable, true);
  assert.deepEqual(repaired.placeholders.candidates, before.placeholders.candidates);
  console.log(
    JSON.stringify({
      ok: true,
      runtime: "local Workerd SQLite Durable Object",
      beforePayloadBytes: before.payloadBytes,
      retiredPayloadBytes: retired.payloadBytes,
      beforeDatabaseBytes: before.databaseBytes,
      retiredDatabaseBytes: retired.databaseBytes,
      retainedItemRows: retired.retainedRows,
      passes: [64, 7, 0],
      restart: true,
      rebuildEquivalent: true,
      liveCloudflare: false,
      limits:
        "synthetic local storage only; no production size, billed storage, or full queue proof",
    }),
  );
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
