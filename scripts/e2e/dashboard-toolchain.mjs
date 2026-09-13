import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "dashboard-toolchain-proof-"));
const denyGithub = createServer((_request, response) => {
  response.writeHead(403, { "content-type": "application/json" });
  response.end('{"message":"synthetic local proof"}');
});
await new Promise((resolve) => denyGithub.listen(0, "127.0.0.1", resolve));
const githubPort = denyGithub.address().port;
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const child = spawn(
  "pnpm",
  [
    "run",
    "dashboard:dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--persist-to",
    join(scratch, "state"),
    "--var",
    `GITHUB_API_URL:http://127.0.0.1:${githubPort}`,
    "--var",
    "CLAWSWEEPER_WEBHOOK_SECRET:synthetic-dashboard-toolchain-proof",
  ],
  {
    detached: true,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
let spawnError;
child.stdout.on("data", (chunk) => {
  logs += chunk;
});
child.stderr.on("data", (chunk) => {
  logs += chunk;
});
const completed = new Promise((resolve) => {
  child.once("error", (error) => {
    spawnError = error;
    resolve({ error });
  });
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
const origin = `http://127.0.0.1:${port}`;
function signalChildGroup(signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
try {
  const deadline = Date.now() + 90_000;
  let health;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Wrangler exited: ${logs.slice(-4000)}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.equal(health?.ok, true, logs.slice(-4000));
  const observations = [];
  for (const [route, text] of [
    ["/", "ClawSweeper Live"],
    ["/bay", "OpenClaw Bay"],
    ["/triage", "triage"],
  ]) {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).includes(text), route);
    observations.push({ route, status: response.status });
  }
  const queueResponse = await fetch(`${origin}/api/exact-review-queue`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(queueResponse.status, 200);
  const queue = await queueResponse.json();
  assert.equal(queue.pending, 0);
  const denied = await fetch(`${origin}/internal/exact-review/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(denied.status, 401);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = /wrangler@(\d+\.\d+\.\d+)/.exec(pkg.scripts["dashboard:dev"])?.[1];
  assert.ok(version);
  assert.match(logs, new RegExp(`wrangler\\s+v?${version.replaceAll(".", "\\.")}`));
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        package_manager: pkg.packageManager,
        command: pkg.scripts["dashboard:dev"],
        observed_wrangler_version: version,
        observations,
        local_queue_pending: queue.pending,
        unauthenticated_mutation_status: denied.status,
        package_sha256: createHash("sha256").update(readFileSync("package.json")).digest("hex"),
        result: "passed",
        limits:
          "Actual pnpm dashboard:dev and Wrangler local Worker; empty local SQLite state and a loopback GitHub denial service. No production deployment or GitHub writes.",
      },
      null,
      2,
    ),
  );
} finally {
  signalChildGroup("SIGTERM");
  await Promise.race([completed, delay(5000, undefined, { ref: false })]);
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    signalChildGroup("SIGKILL");
    await completed;
  }
  denyGithub.closeAllConnections();
  await new Promise((resolve) => denyGithub.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
