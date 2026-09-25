import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "scheduled-feed-proof-"));
const secret = "synthetic-scheduled-feed-proof";
let workerd;
let workerLog = "";
try {
  await writeFile(
    join(scratch, "entry.ts"),
    `
import worker, { ExactReviewQueue } from ${JSON.stringify(resolve("dashboard/worker.ts"))};
export class ProofQueue extends ExactReviewQueue {
  constructor(state, env) {
    super(state, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" });
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/stats") return Response.json({ generated_at: new Date().toISOString() });
    return super.fetch(request);
  }
}
globalThis.fetch = async () => { throw new Error("proof forbids outbound network"); };
export default { fetch(request, env, ctx) {
  return worker.fetch(request, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" }, ctx);
} };
`,
  );
  await writeFile(
    join(scratch, "wrangler.json"),
    JSON.stringify({
      name: "scheduled-feed-admission-proof",
      main: "entry.ts",
      compatibility_date: "2026-05-11",
      durable_objects: { bindings: [{ name: "EXACT_REVIEW_QUEUE", class_name: "ProofQueue" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ProofQueue"] }],
      vars: {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_TARGET_RATE_PER_HOUR: "2",
        EXACT_REVIEW_TARGET_BURST: "2",
        EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1",
      },
    }),
  );
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const baseUrl = `http://127.0.0.1:${port}`;
  workerd = spawn(
    "corepack",
    [
      "pnpm",
      "dlx",
      "--allow-build",
      "esbuild",
      "--allow-build",
      "workerd",
      "wrangler@4.131.1",
      "dev",
      "--config",
      join(scratch, "wrangler.json"),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(scratch, "state"),
      "--show-interactive-dev-session=false",
    ],
    {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [workerd.stdout, workerd.stderr]) {
    stream.on("data", (chunk) => {
      workerLog = (workerLog + chunk).slice(-16_384);
    });
  }
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    ready = await fetch(`${baseUrl}/api/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready || workerd.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.ok(ready, "local Workerd must start");
  const aggregate = await fetch(`${baseUrl}/api/exact-review-queue`);
  assert.equal(aggregate.status, 503, "fixture reproduces incomplete aggregate telemetry");
  const unauthorized = await fetch(`${baseUrl}/internal/exact-review/admission-capabilities`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  await writeFile(
    join(scratch, "transport.mjs"),
    `
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://scheduled-feed.invalid") throw new Error("proof refused outbound request");
  return originalFetch(new Request(${JSON.stringify(baseUrl)} + url.pathname, request));
};
`,
  );
  await writeFile(
    join(scratch, "plan.json"),
    JSON.stringify({
      candidates: [42, 43].map((number) => ({
        repo: "openclaw/gogcli",
        number,
        kind: "issue",
        updatedAt: "2026-09-04T00:00:00Z",
      })),
    }),
  );
  const cliArgs = [
    "--import",
    join(scratch, "transport.mjs"),
    "dist/repair/scheduled-review-enqueue.js",
    "--plan",
    join(scratch, "plan.json"),
    "--lane",
    "normal_backfill",
    "--target-repo",
    "openclaw/gogcli",
    "--target-branch",
    "main",
    "--queue-url",
    "https://scheduled-feed.invalid",
    "--delivery-prefix",
    "scheduled:proof",
  ];
  const cliEnv = { ...process.env, CLAWSWEEPER_WEBHOOK_SECRET: secret };
  const first = JSON.parse((await execute(process.execPath, cliArgs, { env: cliEnv })).stdout);
  const replay = JSON.parse((await execute(process.execPath, cliArgs, { env: cliEnv })).stdout);
  assert.equal(first.queued, 1);
  assert.equal(first.rateLimited, 1);
  assert.deepEqual(replay, first, "same delivery replays exact durable dispositions");
  await writeFile(
    join(scratch, "github.mjs"),
    `
if (process.argv.slice(2).join(" ") !== "api repos/openclaw/gogcli/issues/44") {
  throw new Error("proof refused unexpected GitHub request");
}
console.log(JSON.stringify({ number: 44 }));
`,
  );
  const manual = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          "--import",
          join(scratch, "transport.mjs"),
          "dist/repair/manual-review-enqueue.js",
          "--target-repo",
          "openclaw/gogcli",
          "--target-branch",
          "main",
          "--codex-timeout-ms",
          "1200000",
          "--item-numbers",
          "44",
          "--request-id",
          "manual:proof",
          "--queue-url",
          "https://scheduled-feed.invalid",
        ],
        {
          env: {
            ...cliEnv,
            GH_BIN: process.execPath,
            GH_BIN_ARGS: JSON.stringify([join(scratch, "github.mjs")]),
          },
        },
      )
    ).stdout,
  );
  assert.equal(manual.ok, true);
  assert.equal(manual.accepted, 1);
  console.log(
    JSON.stringify({
      result: "passed",
      runtime: "local-workerd",
      node: process.version,
      aggregateStatus: aggregate.status,
      unauthenticatedStatus: unauthorized.status,
      queued: first.queued,
      rateLimited: first.rateLimited,
      identicalReplay: true,
      manualAccepted: manual.accepted,
      limits: "synthetic target, real CLI/HTTP/SQLite; no GitHub or production mutation",
    }),
  );
} catch (error) {
  // Logs contain only this synthetic fixture; replace machine-specific scratch paths.
  console.error(workerLog.split(scratch).join("<proof-scratch>"));
  throw error;
} finally {
  if (workerd?.pid) {
    const signalGroup = (signal) => {
      try {
        process.kill(-workerd.pid, signal);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    // The wrapper can exit before its children. Wait for this proof's entire
    // detached group, with bounded escalation, before removing its state.
    signalGroup("SIGTERM");
    for (let attempt = 0; attempt < 100 && signalGroup(0); attempt++) {
      if (attempt === 50) signalGroup("SIGKILL");
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(signalGroup(0), false, "proof process group must stop");
  }
  await rm(scratch, { recursive: true, force: true });
}
