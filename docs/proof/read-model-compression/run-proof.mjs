import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(path.resolve(process.env.PROOF_TOOL_ROOT || ".", "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const baseline = "d44a78ce5f214999b5cce854613319f9453989b9";
const root = mkdtempSync(path.join(tmpdir(), "read-model-compression-"));
let runtime;
const report = {
  baseline,
  node: process.version,
  workerd: require("workerd/package.json").version,
  liveCloudflare: false,
  nodejsCompat: false,
  passes: [],
};
async function start(old = false) {
  const built = await build({
    entryPoints: [path.resolve("docs/proof/read-model-compression/worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    nodePaths: [path.resolve("node_modules")],
    plugins: old
      ? [
          {
            name: "frozen-baseline",
            setup(api) {
              api.onResolve({ filter: /dashboard\/exact-review-queue\.ts$/ }, () => ({
                path: path.join(root, "baseline/dashboard/exact-review-queue.ts"),
              }));
            },
          },
        ]
      : [],
  });
  const options = {
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2026-05-11",
    cf: false,
    durableObjects: {
      QUEUE: { className: "Queue", useSQLite: true, unsafeUniqueKey: "read-model-compression" },
    },
    resourcePersistencePath: path.join(root, "state"),
    outboundService: () => new Response("outbound prohibited", { status: 503 }),
  };
  runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  await runtime.ready;
}
async function stop() {
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
}
async function call(route, body = {}) {
  const response = await runtime.dispatchFetch(`https://fixture${route}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 1000));
  return {
    body: JSON.parse(text),
    rowsRead: Number(response.headers.get("x-proof-rows-read")),
    maxQueryRowsRead: Number(response.headers.get("x-proof-max-query-rows-read")),
    ms: Number(response.headers.get("x-proof-ms")),
  };
}
try {
  mkdirSync(path.join(root, "baseline"));
  const archive = process.env.PROOF_BASELINE_ARCHIVE
    ? readFileSync(process.env.PROOF_BASELINE_ARCHIVE)
    : execFileSync("git", ["archive", baseline, "dashboard", "src", "config", "package.json"], {
        maxBuffer: 64 * 1024 * 1024,
      });
  execFileSync("tar", ["-xf", "-", "-C", path.join(root, "baseline")], { input: archive });
  report.baselineArchiveSha256 = createHash("sha256").update(archive).digest("hex");
  await start(true);
  await call("/__proof/seed");
  let before = (await call("/__proof/inspect")).body;
  assert.equal(before.encoded, 0);
  assert.equal(before.markers, 128);
  assert.ok(before.storedBytes > 1024 * 1024);
  await stop();
  await start();
  assert.equal((await call("/__proof/inspect")).body.digest, before.digest);
  assert.equal((await call("/__proof/probe", { number: 1001 })).body.encoded, false);
  before = (await call("/__proof/inspect")).body;
  const reads = (await call("/__proof/read")).body;
  const preview = (
    await call("/read-model/compression", {
      action: "preview",
      expectedDeploymentSha: "a".repeat(40),
    })
  ).body;
  assert.equal(preview.checkpoint, null);
  let checkpoint;
  for (let pass = 0; pass < 100; pass++) {
    const result = await call("/read-model/compression", {
      action: "migrate",
      execute: true,
      expectedDeploymentSha: "a".repeat(40),
      reviewedPreviewSha256: preview.sha256,
    });
    assert.ok(result.body.checkpoint.scanned - (checkpoint?.scanned || 0) <= 64);
    assert.ok(
      result.body.checkpoint.sourceBytes - (checkpoint?.sourceBytes || 0) <= 8 * 1024 * 1024,
    );
    checkpoint = result.body.checkpoint;
    report.passes.push({
      rowsRead: result.rowsRead,
      maxQueryRowsRead: result.maxQueryRowsRead,
      ms: result.ms,
    });
    if (pass === 1) {
      await stop();
      await start();
    }
    if (checkpoint.completedAt !== null) break;
  }
  assert.ok(checkpoint.completedAt);
  const after = (await call("/__proof/inspect")).body;
  assert.equal(after.digest, before.digest);
  assert.equal(after.decodedBytes, before.decodedBytes);
  assert.equal(after.markers, before.markers);
  assert.ok(after.encoded > 500);
  assert.ok(after.storedBytes < before.storedBytes / 5);
  assert.ok(after.databaseBytes < before.databaseBytes);
  assert.deepEqual((await call("/__proof/read")).body, reads);
  await stop();
  await start();
  assert.equal((await call("/__proof/inspect")).body.digest, before.digest);
  let protectedRows = 0,
    retired = 0;
  for (let pass = 0; pass < 10; pass++) {
    const result = (await call("/__proof/retain")).body;
    protectedRows += result.protected;
    retired += result.retired;
    if (result.scanned === 0) break;
  }
  assert.equal(protectedRows, 256);
  assert.equal(retired, 129); // Unprotected reviews plus the raw probe item.
  assert.equal((await call("/__proof/inspect")).body.markers, 128);
  const retained = (await call("/__proof/read")).body;
  assert.deepEqual(retained.item, reads.item);
  assert.deepEqual(retained.comments, reads.comments);
  assert.equal((await call("/__proof/probe", { number: 1002 })).body.encoded, true);
  const acknowledgement = (await call("/__proof/ack")).body;
  assert.equal(acknowledgement.allowed, true);
  assert.ok(acknowledgement.projection.acknowledgement.observed);
  assert.equal(acknowledgement.projection.terminalDisposition.kind, "policy_noop");
  Object.assign(report, {
    ok: true,
    before,
    after,
    checkpoint,
    retention: { protectedRows, retired },
    acknowledgementPreserved: true,
    dormantWritesRaw: true,
    activatedRestartWritesCompressed: true,
    restart: true,
    exactBytes: true,
    limitation:
      "synthetic native storage; timings include fixture overhead, not production capacity",
  });
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
