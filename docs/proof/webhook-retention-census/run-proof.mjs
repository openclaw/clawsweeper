import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(path.resolve(process.env.PROOF_TOOL_ROOT || ".", "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const base = "ef5a507f43321fda5babbc176283756d9e755944";
const asOf = 1_800_000_000_000;
const root = mkdtempSync(path.join(tmpdir(), "webhook-retention-census-"));
const report = {
  base,
  node: process.version,
  workerd: require("workerd/package.json").version,
  liveCloudflare: false,
  outbound: 0,
  passes: [],
};
let runtime;
async function start(baseline) {
  const built = await build({
    entryPoints: ["docs/proof/webhook-retention-census/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    nodePaths: [path.resolve("node_modules")],
    plugins: baseline
      ? [
          {
            name: "frozen-owner-baseline",
            setup(api) {
              api.onLoad(
                { filter: /dashboard\/(?:storage-stats|github-webhook-read-model)\.ts$/ },
                ({ path: file }) => ({
                  contents: execFileSync(
                    "git",
                    ["show", `${base}:${path.relative(process.cwd(), file)}`],
                    { encoding: "utf8" },
                  ),
                  loader: "ts",
                  resolveDir: path.dirname(file),
                }),
              );
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
      QUEUE: { className: "Queue", useSQLite: true, unsafeUniqueKey: "webhook-retention-census" },
    },
    resourcePersistencePath: path.join(root, "state"),
    outboundService: () => {
      report.outbound++;
      return new Response("outbound prohibited", { status: 503 });
    },
  };
  runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  await runtime.ready;
  if (!baseline)
    report.bundleSha256 = createHash("sha256").update(built.outputFiles[0].text).digest("hex");
}
async function stop() {
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
}
async function call(route, body = {}, signed = false, expected = 200) {
  const text = JSON.stringify(body);
  const response = await runtime.dispatchFetch(`https://fixture${route}`, {
    method: "POST",
    body: text,
    headers: signed
      ? {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", "synthetic-secret").update(text).digest("hex")}`,
        }
      : {},
  });
  const result = await response.text();
  assert.equal(response.status, expected, result.slice(0, 1000));
  return {
    body: JSON.parse(result),
    rowsRead: Number(response.headers.get("x-proof-rows-read")),
    rowsWritten: Number(response.headers.get("x-proof-rows-written")),
    queryCount: Number(response.headers.get("x-proof-query-count")),
    ms: Number(response.headers.get("x-proof-ms")),
  };
}
const endpoint = "/internal/exact-review/storage-stats";
const census = (kind) => ({
  census: { table: `github_webhook_read_model_${kind}_v1`, retention: true, asOf },
});
async function cli(table, pages) {
  const url = await runtime.ready;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["scripts/queue-storage-census.mjs"],
    {
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        EXACT_REVIEW_QUEUE_URL: String(url),
        CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret",
        STORAGE_CENSUS_TABLE: `github_webhook_read_model_${table}_v1`,
        STORAGE_CENSUS_CURSOR: JSON.stringify({ retention: true, asOf }),
        STORAGE_CENSUS_MAX_PAGES: String(pages),
      },
    },
  );
  return JSON.parse(stdout);
}
try {
  await start(true);
  await call("/__proof/seed");
  const original = (await call("/__proof/inspect")).body;
  const before = await call(endpoint, census("comments"), true);
  assert.equal(before.body.census.retention, undefined);
  assert.equal(before.rowsWritten, 0);
  assert.deepEqual((await call("/__proof/inspect")).body, original);
  report.passes.push({
    name: "baseline_has_bytes_without_retention_reasons",
    rows: before.body.census.scannedRows,
  });
  await stop();
  await start(false);
  assert.deepEqual((await call("/__proof/inspect")).body, original);
  const after = await call(endpoint, census("comments"), true);
  assert.equal(after.rowsWritten, 0);
  const page = after.body.census;
  assert.deepEqual(
    Object.fromEntries(Object.entries(page.retention.categories).map(([k, v]) => [k, v.rows])),
    {
      retired: 1,
      tombstone: 1,
      placeholder_comment: 2,
      placeholder_parent: 0,
      stale_protection: 1,
      active_family: 1,
      idle_future_deadline: 1,
      due_eligible: 2,
    },
  );
  assert.equal(
    Object.values(page.retention.categories).reduce((n, v) => n + v.bytes, 0),
    page.columns.snapshot_json,
  );
  const parents = await call(endpoint, census("items"), true);
  assert.equal(parents.body.census.retention.categories.placeholder_parent.rows, 2);
  const operated = await cli("comments", 2);
  assert.deepEqual(operated.retention.categories, page.retention.categories);
  assert.equal(operated.complete, true);
  await call(endpoint, census("comments"), false, 401);
  assert.deepEqual((await call("/__proof/inspect")).body, original);
  report.passes.push({
    name: "signed_read_only_categories_and_cli",
    rows: page.scannedRows,
    payloadBytes: page.columns.snapshot_json,
    categories: page.retention.categories,
    rowsRead: after.rowsRead,
    rowsWritten: after.rowsWritten,
    ms: after.ms,
    stateDigestUnchanged: true,
    kvAndAlarmUnchanged: true,
  });

  const cold = (await call("/__proof/inspect?fixture=cold")).body;
  await call(`${endpoint}?fixture=cold`, census("comments"), true, 400);
  assert.deepEqual((await call("/__proof/inspect?fixture=cold")).body, cold);
  report.passes.push({ name: "absent_schema_is_not_initialized", unchanged: true });

  await call("/__proof/large");
  const large = await call(endpoint, census("items"), true);
  assert.equal(large.body.census.scannedRows, 64);
  assert.equal(large.body.census.complete, false);
  assert.equal(large.rowsWritten, 0);
  assert.ok(large.rowsRead < 200_000, JSON.stringify(large));
  const completed = await cli("items", 3);
  assert.equal(completed.scannedRows, 74);
  assert.equal(completed.pages, 2);
  assert.equal(completed.complete, true);
  const capped = await cli("comments", 1);
  assert.equal(capped.scannedRows, 64);
  assert.equal(capped.complete, false);
  assert.equal(capped.nextCursor.retention, true);
  assert.equal(capped.nextCursor.asOf, asOf);
  report.passes.push({
    name: "bounded_dense_family_page_and_cli_continuation",
    families: 65,
    childrenPerFamily: 1500,
    scannedRows: 64,
    rowsRead: large.rowsRead,
    rowsWritten: large.rowsWritten,
    queries: large.queryCount,
    ms: large.ms,
    cliRows: completed.scannedRows,
    cliPages: completed.pages,
  });
  assert.equal(report.outbound, 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
