import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { materializeWorkerRecords } from "../../../scripts/worker-records.ts";
const require = createRequire(path.resolve(process.env.PROOF_TOOL_ROOT || ".", "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare"),
  { build } = require("esbuild");
const root = mkdtempSync(path.join(tmpdir(), "canonical-body-proof-")),
  baseline = "291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0",
  throughputBaseline = "ea6d72efc0a2e2c0683ad984b060b5c22008ce57";
let runtime;
const report = {
  baseline,
  throughputBaseline,
  runtime: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  esbuild: require("esbuild/package.json").version,
  node: process.version,
  liveCloudflare: false,
  provider: process.env.PROOF_PROVIDER || "controlled Workerd",
  passes: [],
};
async function start(old = false, deploymentSha = "a".repeat(40)) {
  const built = await build({
    entryPoints: [path.resolve("docs/proof/canonical-body-tiering/worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*", "node:*"],
    plugins: old
      ? [
          {
            name: "frozen-baseline",
            setup(api) {
              api.onResolve(
                {
                  filter:
                    /dashboard\/(exact-review-queue|exact-review-direct-publication|exact-review-publication-batches)\.ts$/,
                },
                (args) => ({
                  path: path.join(
                    root,
                    old === "serial" ? "serial/dashboard" : "baseline/dashboard",
                    path.basename(args.path),
                  ),
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
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    durableObjects: {
      QUEUE: {
        className: "Queue",
        useSQLite: true,
        unsafeUniqueKey: "canonical-body-tiering-proof",
      },
    },
    r2Buckets: ["STATE_SNAPSHOTS"],
    bindings: { PROOF_DEPLOYMENT_SHA: deploymentSha },
    resourcePersistencePath: path.join(root, "state"),
    outboundService: () => new Response("outbound fetch prohibited", { status: 503 }),
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
async function response(object, route, body = {}) {
  return runtime.dispatchFetch(`http://localhost/${object}${route}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
async function call(object, route, body = {}, status = 200) {
  const res = await response(object, route, body),
    text = await res.text();
  assert.equal(res.status, status, text.slice(0, 1200));
  return JSON.parse(text);
}
async function maintenance(object, action) {
  const preview = await call(object, "/maintenance", { action: "preview" });
  return call(object, "/maintenance", {
    action,
    execute: true,
    reviewedPreviewSha256: preview.sha256,
  });
}
async function allRecords(object) {
  const records = [];
  let cursor = 0,
    revision = 0;
  for (let pass = 0; pass < 1000; pass++) {
    const page = await call(object, "/export", { cursor, limit: 200 });
    records.push(...page.records);
    revision = page.revision;
    if (page.nextCursor === null) return { records, revision };
    assert.ok(page.nextCursor > cursor);
    cursor = page.nextCursor;
  }
  throw Error("export stalled");
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  mkdirSync(path.join(root, "serial"));
  const serialArchive = process.env.PROOF_THROUGHPUT_BASELINE_ARCHIVE
    ? readFileSync(process.env.PROOF_THROUGHPUT_BASELINE_ARCHIVE)
    : execFileSync(
        "git",
        ["archive", throughputBaseline, "dashboard", "src", "config", "package.json"],
        { maxBuffer: 64 * 1024 * 1024 },
      );
  execFileSync("tar", ["-xf", "-", "-C", path.join(root, "serial")], { input: serialArchive });
  report.throughputBaselineArchiveSha256 = createHash("sha256").update(serialArchive).digest("hex");
  await start(true);
  await call("records", "/seed", { count: 1010 });
  await call("faults", "/seed", { count: 6 });
  await call("corrupt", "/seed", { count: 6 });
  await call("warm", "/seed", { count: 6 });
  await call("mixed", "/seed", { count: 6, mixed: true });
  for (const object of ["serial", "parallel", "drain", "interleave", "requalify"])
    await call(object, "/seed-throughput");
  const throughputBefore = await allRecords("serial");
  for (const object of ["parallel", "drain", "interleave", "requalify"])
    assert.deepEqual(await allRecords(object), throughputBefore);
  const mixedBefore = await allRecords("mixed"),
    mixedBackfill = await call("mixed", "/backfill-facts");
  const beforeFacts = await call("records", "/facts");
  const before = await allRecords("records"),
    old = await call("records", "/inspect");
  assert.equal(old.version, 1);
  assert.equal(old.bodies, 0);
  report.before = {
    digest: digest(before),
    records: before.records.length,
    databaseBytes: old.databaseBytes,
    watermark: old.watermark,
    profile: await call("records", "/profile"),
  };
  await stop();
  await start();
  const dormant = await call("records", "/inspect");
  assert.equal(dormant.version, 1);
  assert.equal(dormant.bodies, 0);
  assert.equal(digest(await allRecords("records")), digest(before));
  report.dormantProfile = await call("records", "/profile");
  for (const operation of report.dormantProfile.operations) {
    assert.ok(operation.maxRowsRead < 1200, JSON.stringify(operation));
    assert.ok(
      operation.queries.every((query) =>
        query.plan.every(
          (detail) => !detail.includes("MATERIALIZE exact_review_canonical_record_sources"),
        ),
      ),
    );
  }
  const warmBefore = await call("warm", "/inspect");
  const warmResult = await call("warm", "/warm-write");
  assert.equal(warmResult.status, 202, JSON.stringify(warmResult));
  const warmAfter = await call("warm", "/inspect");
  assert.equal(warmAfter.version, 2);
  assert.equal(warmAfter.v1, warmBefore.v1);
  assert.ok(warmAfter.v2 > 0);
  report.warmFormatFence = true;
  await maintenance("records", "activate");
  let prior = await call("records", "/inspect"),
    maxBytes = prior.databaseBytes,
    maxMs = 0;
  for (let pass = 0; pass < 1000; pass++) {
    const start = performance.now(),
      result = await maintenance("records", "migrate"),
      elapsed = performance.now() - start,
      next = await call("records", "/inspect");
    const sql = result.migrationSql;
    // The durable format fence scans SQLite's fixed schema catalog. Measure it
    // separately from record queries; index and ephemeral view reads count too.
    assert.ok(sql.maxRecordRowsRead <= 128, JSON.stringify(sql));
    assert.ok(sql.maxTupleRowsRead <= 32, JSON.stringify(sql));
    assert.ok(sql.tupleQueries <= 8, JSON.stringify(sql));
    const seeks = sql.tuplePlans.filter((detail) =>
      /SEARCH (?:v1|exact_review_canonical_records_v2) /.test(detail),
    );
    assert.ok(seeks.length >= 2, JSON.stringify(sql));
    assert.ok(
      seeks.every((detail) => detail.includes("repo_slug=? AND section=? AND item_id=?")),
      JSON.stringify(sql),
    );
    assert.ok(
      !sql.tuplePlans.some((detail) =>
        /SCAN (?:v1|exact_review_canonical_records_v2) |MATERIALIZE exact_review_canonical_record_sources/.test(
          detail,
        ),
      ),
      JSON.stringify(sql),
    );
    assert.ok(result.checkpoint.scanned - (prior.checkpoint?.scanned ?? 0) <= 64);
    assert.ok(result.checkpoint.migrated - (prior.checkpoint?.migrated ?? 0) <= 16);
    assert.ok(
      result.checkpoint.source_bytes - (prior.checkpoint?.source_bytes ?? 0) <= 8 * 1024 * 1024,
    );
    assert.equal(next.watermark, old.watermark);
    maxMs = Math.max(maxMs, elapsed);
    maxBytes = Math.max(maxBytes, next.databaseBytes);
    report.passes.push({
      scanned: result.checkpoint.scanned - (prior.checkpoint?.scanned ?? 0),
      rows: result.checkpoint.migrated - (prior.checkpoint?.migrated ?? 0),
      bytes: result.checkpoint.source_bytes - (prior.checkpoint?.source_bytes ?? 0),
      elapsedMs: Math.round(elapsed),
      sql,
    });
    prior = next;
    if (result.checkpoint.completed_at) break;
    if (pass === 999) throw Error("migration stalled");
  }
  const afterFacts = await call("records", "/facts", { answers: true });
  assert.deepEqual(afterFacts.coverage, beforeFacts.coverage);
  assert.equal(afterFacts.fresh, true);
  assert.equal(afterFacts.stale, false);
  report.coverageAndAnswers = true;
  assert.equal(prior.v1, 0);
  assert.equal(prior.chunks, 0);
  assert.equal(prior.v2, old.v1);
  assert.equal(digest(await allRecords("records")), digest(before));
  assert.deepEqual(prior.receipts, old.receipts);
  report.after = {
    digest: digest(await allRecords("records")),
    records: prior.v2,
    databaseBytes: prior.databaseBytes,
    maxTemporaryDatabaseBytes: maxBytes,
    maxPassWallMs: Math.round(maxMs),
    profile: await call("records", "/profile"),
  };
  await maintenance("mixed", "activate");
  for (let pass = 0; pass < 20; pass++) {
    const result = await maintenance("mixed", "migrate");
    assert.equal(result.checkpoint.conflicts, 0);
    if (result.checkpoint.completed_at) break;
    if (pass === 19) throw Error("mixed-source migration stalled");
  }
  assert.deepEqual(await call("mixed", "/backfill-facts"), mixedBackfill);
  assert.equal(digest(await allRecords("mixed")), digest(mixedBefore));
  await stop();
  await start();
  assert.equal(digest(await allRecords("records")), digest(before));
  assert.deepEqual(await call("mixed", "/backfill-facts"), mixedBackfill);
  assert.equal(digest(await allRecords("mixed")), digest(mixedBefore));
  report.mixedSources = {
    backfillRows: mixedBackfill.rows.length,
    exportRecords: mixedBefore.records.length,
    exactRoundtrip: true,
    restart: true,
  };
  const snapshot = await call("records", "/snapshot", {}, 201);
  assert.equal(
    snapshot.snapshot.fileCount,
    before.records.filter((record) => !record.deleted).length,
  );
  const restored = path.join(root, "restore");
  await materializeWorkerRecords({
    worktreeRoot: restored,
    cacheRoot: path.join(root, "cache"),
    baseUrl: "https://fixture.invalid",
    webhookSecret: "synthetic-proof-secret",
    repoSlugs: ["example-project"],
    log: () => {},
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      return runtime.dispatchFetch("http://localhost/records" + url.pathname, init);
    },
  });
  for (const record of before.records.filter((record) => !record.deleted))
    assert.equal(
      readFileSync(
        path.join(
          restored,
          "records/example-project",
          record.section,
          record.id + (record.section === "decision-packets" ? ".json" : ".md"),
        ),
        "utf8",
      ),
      record.content,
    );
  report.snapshotRestore = {
    files: snapshot.snapshot.fileCount,
    watermark: snapshot.snapshot.revisionWatermark ?? snapshot.snapshot.revision,
  };
  await maintenance("faults", "activate");
  for (const [offset, fault, batch] of [
    [0, "expire", false],
    [1, "cancel", false],
    [2, "generation", false],
    [3, "batch", true],
    [4, "batch-replace", true],
  ]) {
    const id = 2000 + offset,
      beforeFault = await call("faults", "/inspect"),
      result = await call("faults", "/publish", { id, fault, batch });
    assert.equal(result.status, 409, JSON.stringify(result));
    const afterFault = await call("faults", "/inspect");
    assert.equal(afterFault.watermark, beforeFault.watermark);
    assert.equal(afterFault.v1, beforeFault.v1);
    assert.equal(afterFault.receipts.length, beforeFault.receipts.length);
  }
  const accepted = await call("faults", "/publish", { id: 2100 });
  assert.equal(accepted.status, 202);
  assert.equal((await call("faults", "/retry", { id: 2100 })).result.deduped, true);
  assert.equal(
    (await call("faults", "/retry", { id: 2100, content: "changed direct retry" })).status,
    400,
  );
  const batch = await call("faults", "/publish", { id: 2101, batch: true });
  assert.equal(batch.status, 202);
  assert.equal(
    (
      await call("faults", "/retry", {
        id: 2101,
        batch: true,
        failR2: true,
        content: "refreshed guarded apply metadata",
      })
    ).result.deduped,
    true,
  );
  report.authority = {
    expired: true,
    cancelled: true,
    generationChanged: true,
    batchExpired: true,
    batchReplaced: true,
    lostResponseDirect: true,
    strictDirectRetry: true,
    changedBatchRetryDuringR2Outage: true,
  };
  const growthBefore = await call("warm", "/inspect");
  for (let index = 0; index < 3; index++) {
    const content = String(index).repeat(2 * 1024 * 1024),
      id = 2300 + index;
    const written = await call("warm", "/publish", { id, content });
    assert.equal(written.status, 202, JSON.stringify(written));
    assert.equal((await call("warm", "/point", { id })).content, content);
  }
  const growthAfter = await call("warm", "/inspect");
  assert.equal(growthAfter.v1, growthBefore.v1);
  assert.ok(growthAfter.databaseBytes - growthBefore.databaseBytes < 256 * 1024);
  report.newWriteGrowth = {
    bodyBytes: 6 * 1024 * 1024,
    sqlBytes: growthAfter.databaseBytes - growthBefore.databaseBytes,
    v1RowsUnchanged: true,
  };
  await maintenance("corrupt", "activate");
  await call("corrupt", "/prepare");
  await stop();
  await start();
  // Uploads survived, but the abandoned prepared pass had no SQL authority.
  assert.equal((await call("corrupt", "/inspect")).v1, 16);
  await maintenance("corrupt", "migrate");
  await maintenance("corrupt", "migrate");
  await call("corrupt", "/corrupt", { id: 2, sameSize: true });
  assert.ok((await response("corrupt", "/point", { id: 2 })).status >= 500);
  await call("corrupt", "/corrupt", { id: 1, missing: true });
  const missing = await response("corrupt", "/point", { id: 1 });
  assert.ok(missing.status >= 500);
  const failedExport = await response("corrupt", "/export", {});
  assert.ok(failedExport.status >= 500);
  report.integrity = {
    crashAfterUploadBeforeCommit: true,
    corruptBodyInfrastructureError: true,
    missingBodyInfrastructureError: true,
    missingExportInfrastructureError: true,
  };
  await stop();
  await start("serial");
  await call("serial", "/warm-throughput");
  async function measureThroughput(object) {
    await maintenance(object, "activate");
    await call(object, "/r2-controls", { delayMs: 20 });
    const started = performance.now();
    let passes = 0;
    for (; passes < 20; passes++) {
      const result = await maintenance(object, "migrate");
      if (result.checkpoint.completed_at) {
        passes++;
        break;
      }
    }
    const elapsedMs = performance.now() - started;
    const metrics = await call(object, "/r2-metrics");
    assert.equal(metrics.active, 0);
    await call(object, "/r2-controls");
    assert.deepEqual(await allRecords(object), throughputBefore);
    assert.equal((await call(object, "/inspect")).v1, 0);
    return { elapsedMs, passes, ...metrics };
  }
  const serialTiming = await measureThroughput("serial");
  assert.equal(serialTiming.peak, 1);
  await maintenance("requalify", "activate");
  await maintenance("requalify", "migrate");
  const oldCheckpoint = (await call("requalify", "/inspect")).checkpoint;
  await stop();
  await start();
  const parallelTiming = await measureThroughput("parallel");
  assert.equal(parallelTiming.peak, 4);
  assert.equal(parallelTiming.calls, 60); // six passes, five unique bodies, PUT + GET
  assert.ok(
    parallelTiming.elapsedMs < serialTiming.elapsedMs,
    JSON.stringify({ serialTiming, parallelTiming }),
  );
  report.throughput = {
    warmObjects: true,
    delayPerOperationMs: 20,
    serial: serialTiming,
    parallel: parallelTiming,
    sameDatasetSha256: digest(throughputBefore),
    productionEstimate: false,
  };
  await maintenance("drain", "activate");
  const drainBefore = await call("drain", "/inspect");
  await call("drain", "/r2-controls", { delayMs: 20, failAt: 5 });
  const drained = await call("drain", "/prepare-failure");
  assert.equal(drained.failed, true);
  assert.equal(drained.metrics.active, 0);
  assert.equal(drained.metrics.putsAfterFailure, 0);
  assert.ok(drained.metrics.peak <= 4);
  const drainAfter = await call("drain", "/inspect");
  assert.equal(drainAfter.v1, drainBefore.v1);
  assert.deepEqual(drainAfter.checkpoint, drainBefore.checkpoint);
  report.failedPipelineDrained = drained.metrics;
  await maintenance("interleave", "activate");
  await call("interleave", "/r2-controls", { delayMs: 20 });
  const interleaved = await call("interleave", "/prepare-interleave");
  assert.equal(interleaved.publicationStatus, 202);
  assert.equal(interleaved.captured, "body-4");
  assert.equal(interleaved.checkpoint.conflicts, 1);
  assert.equal((await call("interleave", "/point", { id: 4 })).content, "foreground replacement");
  report.foregroundInterleaving = true;
  await stop();
  await start(false, "b".repeat(40));
  assert.deepEqual((await call("requalify", "/inspect")).checkpoint, oldCheckpoint);
  const refused = await response("requalify", "/maintenance", { action: "preview" });
  assert.ok(refused.status >= 400);
  await refused.arrayBuffer();
  await call("requalify", "/prepare");
  const requalification = await call("requalify", "/maintenance", {
    action: "requalify-preview",
    previousPlanSha256: oldCheckpoint.preview_sha256,
  });
  assert.equal(requalification.packet.checkpointSha256, digest(oldCheckpoint));
  const apply = {
    action: "requalify",
    execute: true,
    previousPlanSha256: oldCheckpoint.preview_sha256,
    reviewedPreviewSha256: requalification.sha256,
  };
  await call(
    "requalify",
    "/maintenance",
    { ...apply, reviewedPreviewSha256: requalification.packet.nextPlanSha256 },
    409,
  );
  const qualified = await call("requalify", "/maintenance", apply);
  assert.deepEqual(qualified.checkpoint, {
    ...oldCheckpoint,
    deployment_sha: "b".repeat(40),
    preview_sha256: requalification.packet.nextPlanSha256,
    plan_json: JSON.stringify(requalification.packet.nextPlan),
  });
  const oldCommit = await response("requalify", "/commit");
  assert.ok(oldCommit.status >= 400);
  await oldCommit.arrayBuffer();
  const replay = await response("requalify", "/maintenance", apply);
  assert.ok(replay.status >= 400);
  await replay.arrayBuffer();
  await stop();
  await start(false, "b".repeat(40));
  assert.deepEqual((await call("requalify", "/inspect")).checkpoint, qualified.checkpoint);
  for (let pass = 0; pass < 20; pass++) {
    if ((await maintenance("requalify", "migrate")).checkpoint.completed_at) break;
  }
  const resumed = await call("requalify", "/inspect");
  assert.equal(resumed.v1, 0);
  assert.equal(resumed.chunks, 0);
  assert.equal(resumed.checkpoint.upper_rowid, oldCheckpoint.upper_rowid);
  assert.deepEqual(await allRecords("requalify"), throughputBefore);
  report.requalification = {
    before: oldCheckpoint,
    after: qualified.checkpoint,
    resumed: resumed.checkpoint,
    envelopeSha256: requalification.sha256,
    stalePassRejected: true,
    replayRejected: true,
    restartPreservedProgress: true,
  };
  report.resourceLimits = {
    rawIdentities: 64,
    tuples: 4,
    sourceBytes: 8 * 1024 * 1024,
    perFileBytes: 2 * 1024 * 1024,
    parallelR2Requests: 4,
    hostRssBytes: process.memoryUsage().rss,
    hostCpu: process.cpuUsage(),
    limits:
      "synthetic volume; wall time includes IPC and R2; host RSS and CPU are not isolate allocations; bucket lifecycle and deployment drain are production gates, not exercised against Cloudflare",
  };
  report.passSummary = {
    count: report.passes.length,
    totalWallMs: Math.round(report.passes.reduce((sum, pass) => sum + pass.elapsedMs, 0)),
    maxRawIdentities: Math.max(...report.passes.map((pass) => pass.scanned)),
    maxRows: Math.max(...report.passes.map((pass) => pass.rows)),
    maxSourceBytes: Math.max(...report.passes.map((pass) => pass.bytes)),
  };
  report.migrationSql = {
    maxRowsRead: Math.max(...report.passes.map((pass) => pass.sql.maxRowsRead)),
    maxRecordRowsRead: Math.max(...report.passes.map((pass) => pass.sql.maxRecordRowsRead)),
    maxSchemaRowsRead: Math.max(...report.passes.map((pass) => pass.sql.maxSchemaRowsRead)),
    maxTupleRowsRead: Math.max(...report.passes.map((pass) => pass.sql.maxTupleRowsRead)),
    maxTupleQueries: Math.max(...report.passes.map((pass) => pass.sql.tupleQueries)),
    tuplePlans: [...new Set(report.passes.flatMap((pass) => pass.sql.tuplePlans))],
    bounds: { perRecordQueryRowsRead: 128, perTupleQueryRowsRead: 32, tupleQueriesPerPass: 8 },
  };
  delete report.passes;
  for (const profile of [report.before.profile, report.dormantProfile, report.after.profile])
    for (const operation of profile.operations) {
      const plans = operation.queries.flatMap((query) => query.plan);
      operation.queryCount = operation.queries.length;
      operation.canonicalIndexed = plans.some((detail) =>
        /SEARCH (?:exact_review_canonical_records(?:_v2)?|r|v1) USING (?:COVERING )?INDEX/.test(
          detail,
        ),
      );
      operation.materializesBodyView = plans.some((detail) =>
        detail.includes("MATERIALIZE exact_review_canonical_record_sources"),
      );
      assert.equal(operation.canonicalIndexed, true);
      assert.equal(operation.materializesBodyView, false);
      delete operation.queries;
    }
  console.log(JSON.stringify(report));
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
