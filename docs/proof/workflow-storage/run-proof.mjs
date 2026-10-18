import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.resolve(process.env.PROOF_TOOL_ROOT || ".", "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const root = mkdtempSync(path.join(tmpdir(), "workflow-storage-proof-"));
const baseline = "69d79662aa5d54f8a4771a1b5cd017925c31f57c";
const entry = path.resolve("docs/proof/workflow-storage/worker.ts");
let runtime;
const report = {
  baseline,
  runtime: require("workerd/package.json").version,
  liveCloudflare: false,
};
async function start(base = false) {
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*", "node:*"],
    plugins: base
      ? [
          {
            name: "baseline",
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
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    durableObjects: {
      QUEUE: { className: "Queue", useSQLite: true, unsafeUniqueKey: "workflow-storage-proof" },
    },
    resourcePersistencePath: path.join(root, "state"),
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
async function call(object, route, body = {}, status = 200) {
  const response = await runtime.dispatchFetch(`http://localhost/${object}${route}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
async function waitFor(object, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await call(object, "/inspect");
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `maintenance stalled: ${object} ${JSON.stringify(await call(object, "/inspect"))}`,
  );
}
try {
  mkdirSync(path.join(root, "baseline"));
  const archive = execFileSync(
    "git",
    ["archive", baseline, "dashboard", "src", "config", "package.json"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", path.join(root, "baseline")], { input: archive });
  report.baselineArchiveSha256 = createHash("sha256").update(archive).digest("hex");
  await start(true);
  await call("small", "/seed", { count: 513 });
  await call("large", "/seed", { count: 227965 });
  assert.equal((await call("small", "/inspect")).index.length, 0);
  await stop();
  await start();
  assert.equal(
    (await call("large", "/inspect")).coverage.reduce((n, row) => n + row.n, 0),
    227968,
  );
  const startAt = Date.now();
  await call("large", "/enable");
  report.populatedInitializationMs = Date.now() - startAt;
  const large = await waitFor("large", (value) => value.passes.length >= 1);
  assert.equal(large.index.length, 1);
  assert.ok(large.passes.every((pass) => pass.retired <= 256));
  assert.match(JSON.stringify(large.plan), /workflow_coverage_expiry_v1/);
  assert.doesNotMatch(JSON.stringify(large.plan), /TEMP B-TREE/);
  report.populatedFirstPass = large.passes[0];
  await call("small", "/enable");
  await waitFor("small", (value) => value.passes.length >= 1);
  await stop();
  await start();
  const small = await waitFor(
    "small",
    (value) => value.coverage.reduce((n, row) => n + row.n, 0) === 3,
  );
  assert.ok(small.passes.every((pass) => pass.retired <= 256));
  assert.ok(small.coverage.some((row) => row.coverage_kind === "run_census"));
  assert.ok(small.coverage.some((row) => row.coverage_kind === "unknown"));
  report.idleRestartPasses = small.passes;
  const first = await call("small", "/storage/stats", { census: { table: "census_sample" } });
  assert.equal(first.census.scannedRows, 128);
  assert.deepEqual(first.census.columns, { body: 128, payload: 256, n: 0 });
  const plans = await call("small", "/census-plan");
  const pageQuery = plans.at(-1);
  assert.equal(pageQuery.rowsWritten, 0);
  assert.match(JSON.stringify(pageQuery.plan), /INTEGER PRIMARY KEY/);
  assert.doesNotMatch(JSON.stringify(pageQuery.plan), /TEMP B-TREE/);
  report.censusPageRowsRead = pageQuery.rowsRead;
  assert.equal(
    (await call("small", "/storage/stats", { census: { table: "wide98" } })).census.complete,
    true,
  );
  assert.equal(
    (await call("small", "/storage/stats", { census: { table: "wide99" } }, 400)).error,
    "invalid_storage_census_columns",
  );
  report.workerdColumnBoundary = true;
  await call("small", "/append");
  await stop();
  await start();
  const last = await call("small", "/storage/stats", {
    census: { table: "census_sample", ...first.census.nextCursor },
  });
  assert.equal(last.census.scannedRows, 2);
  assert.deepEqual(last.census.columns, { body: 80001, payload: 4, n: 0 });
  assert.equal(last.census.complete, true);
  report.census = {
    rows: first.census.scannedRows + last.census.scannedRows,
    bodyBytes: first.census.columns.body + last.census.columns.body,
    excludesLaterInsert: true,
    survivesRestart: true,
  };
  await call("small", "/future");
  await stop();
  await start();
  const wake = await call("small", "/wake");
  await call("small", "/enable");
  assert.equal((await call("small", "/inspect")).nextAlarm, wake.at);
  await call("small", "/refresh");
  const passesBefore = small.passes.length;
  const refreshed = await waitFor("small", (value) => value.passes.length > passesBefore);
  assert.equal(
    refreshed.coverage.reduce((n, row) => n + row.n, 0),
    3,
  );
  assert.ok(refreshed.nextAlarm > Date.now() + 290_000);
  report.earlierWakePreserved = true;
  report.refreshBeforeExpiryPreserved = true;
  await call("small", "/future");
  await stop();
  await start();
  await call("small", "/enable");
  const expired = await waitFor("small", (value) => value.coverage.length === 2);
  assert.equal(expired.nextAlarm, null);
  report.futureDeadlineWithoutIngress = true;
  report.ok = true;
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
