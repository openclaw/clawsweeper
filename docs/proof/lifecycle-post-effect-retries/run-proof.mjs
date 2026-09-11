import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExactReviewBatchQueueClient } from "../../../dist/repair/exact-review-batch-queue-client.js";

const args = process.argv.slice(2);
const baselineIndex = args.indexOf("--baseline-client");
const baseline =
  baselineIndex < 0
    ? null
    : (await import(pathToFileURL(path.resolve(args[baselineIndex + 1])).href))
        .ExactReviewBatchQueueClient;
const output = path.resolve(
  process.env.LIFECYCLE_PROOF_OUTPUT || ".artifacts/lifecycle-post-effect-retries",
);
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-retry-proof-"));
const secret = "synthetic-lifecycle-proof";
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const nonce = randomUUID();
const origin = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sign = (body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
async function call(route, body) {
  const raw = JSON.stringify(body);
  const response = await fetch(origin + route, {
    method: "POST",
    headers: { "x-clawsweeper-exact-review-signature": sign(raw) },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
  return response.json();
}
let active;
const proxy = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const s = active;
    assert.ok(s);
    s.calls.push({ body, signature: req.headers["x-clawsweeper-exact-review-signature"] });
    if (s.kind === "before" && s.calls.length === 1) {
      res.writeHead(500);
      res.end("temporary queue failure");
      return;
    }
    const response = await fetch(origin + req.url, {
      method: "POST",
      headers: req.headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.text();
    if (s.kind !== "before" && s.calls.length === 1) {
      assert.equal(response.status, 200, result);
      if (s.kind === "newer-requeue") {
        await sleep(5);
        await call("/internal/exact-review/lifecycle/terminal-disposition", {
          ...s.wire,
          kind: "requeue",
          operation_id: `newer:${s.identity.fenceKey}`,
        });
      }
      s.committed = await call("/__proof/read", s.identity);
      await call("/__proof/reconstruct", {});
      res.destroy();
      return;
    }
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(result);
  } catch (error) {
    active.error = error;
    res.writeHead(500);
    res.end("proof proxy failure");
  }
});
const log = fs.openSync(path.join(output, "worker.log"), "w");
const child = spawn(
  "wrangler",
  [
    "dev",
    "--config",
    "docs/proof/lifecycle-post-effect-retries/wrangler.toml",
    "--local",
    "--persist-to",
    path.join(scratch, "state"),
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
    stdio: ["ignore", log, log],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  },
);
fs.closeSync(log);
const childExit = once(child, "exit");
const results = [];
try {
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("local Worker exited; inspect worker.log");
    try {
      const response = await fetch(origin + "/__proof/ready", {
        signal: AbortSignal.timeout(1_000),
      });
      ready = response.ok && (await response.json()).nonce === nonce;
      if (ready) break;
    } catch {}
    await sleep(300);
  }
  assert.ok(ready, "local Worker ready");
  for (const [arm, Client] of [
    ...(baseline ? [["baseline", baseline]] : []),
    ["candidate", ExactReviewBatchQueueClient],
  ]) {
    for (const route of ["router-receipt", "terminal-disposition"]) {
      for (const kind of ["before", "lost-response", "newer-requeue"]) {
        const identity = {
          canonicalTargetKey: "openclaw/clawsweeper#706",
          fenceKey: `proof:${arm}:${route}:${kind}`,
          revision: 1,
        };
        const wire = {
          canonical_target_key: identity.canonicalTargetKey,
          fence_key: identity.fenceKey,
          revision: identity.revision,
        };
        await call("/__proof/seed", identity);
        active = { kind, calls: [], identity, wire };
        const client = new Client({
          baseUrl: "https://queue.example.test",
          webhookSecret: secret,
          fetch: (url, init) => fetch(proxyOrigin + new URL(url).pathname, init),
        });
        const payload = JSON.stringify({
          ...wire,
          ...(route === "router-receipt"
            ? { outcome: "durable", receipt_id: `receipt:${identity.fenceKey}` }
            : { kind: "policy_noop", operation_id: `operation:${identity.fenceKey}` }),
        });
        if (arm === "baseline")
          await assert.rejects(
            client.postEffect(route, payload, { retryLifecycle: true }),
            /HTTP 500|network_error/,
          );
        else
          assert.equal(
            (await client.postEffect(route, payload, { retryLifecycle: true })).ok,
            true,
          );
        assert.equal(active.error, undefined);
        assert.equal(active.calls.length, arm === "baseline" ? 1 : 2);
        for (const request of active.calls) {
          assert.equal(request.body, payload);
          assert.equal(request.signature, sign(payload));
        }
        const state = await call("/__proof/read", identity);
        assert.equal(state.outbound, 0);
        if (active.committed)
          assert.deepEqual(
            state,
            active.committed,
            "replay preserves durable state after reconstruction",
          );
        if (kind === "newer-requeue") {
          assert.equal(state.projection.terminalDisposition.kind, "requeue");
          assert.deepEqual(state.drivers, []);
        } else if (arm === "candidate") {
          assert.equal(state.drivers.length, 1);
        }
        results.push({
          arm,
          route,
          kind,
          attempts: active.calls.length,
          drivers: state.drivers.length,
          terminal: state.projection.terminalDisposition?.kind ?? null,
          routerReceipts: state.projection.routerReceipts.length,
          outbound: state.outbound,
        });
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        node: process.version,
        platform: process.platform,
        results,
        pass: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  if (child.exitCode === null) {
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([childExit, sleep(5_000)]);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
