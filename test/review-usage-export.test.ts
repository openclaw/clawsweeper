import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { exportReviewUsage } from "../dist/review-usage-export.js";
import { actionEventPublicationPaths } from "../dist/action-ledger-import.js";
import { readReviewUsageReport } from "../dist/review-usage-report.js";
import { reviewUsageExportFixture } from "./review-usage-export-fixture.ts";

test("native export publishes one private, strictly closed producer and preserves report coverage", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  const { report, selection } = await exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl });
  assert.deepEqual(selection.paths, f.paths);
  assert.equal(selection.producer.runId, f.source.runId);
  assert.equal(selection.producer.producer, "review.fixture.default");
  assert.deepEqual(report.rows[0]?.usage, { input_tokens: 100, output_tokens: 10 });
  assert.equal(report.rows[0]?.producer.run_id, f.source.runId);
  assert.equal(report.coverage.actual_billing, "unavailable");
  assert.equal(report.coverage.selection, "provided-shards-only");
  assert.deepEqual(readReviewUsageReport(f.source.output, f.paths), report);
  const manifest = [...f.paths, ...f.bindings.map((x) => x.relativePath)].sort();
  assert.equal(actionEventPublicationPaths(f.source.output, manifest).length, manifest.length);
  assert.equal(statSync(f.source.output).mode & 0o777, 0o700);
  for (const path of manifest)
    assert.equal(statSync(join(f.source.output, path)).mode & 0o777, 0o600);
  assert.ok(f.calls.every((c) => ["list", "stat", "chunk"].includes(c.operation)));
});

test("projection failure producers cannot hide the full-review transaction", async (t) => {
  const f = await reviewUsageExportFixture({ projectionFailure: true });
  t.after(f.cleanup);
  const projectionPaths = f.paths.filter((p) => p.includes(".crabfleet_projection/"));
  assert.ok(projectionPaths.length > 0);
  assert.ok([...f.objects.keys()][0]!.includes(".crabfleet_projection/"));
  const { report, selection } = await exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl });
  assert.equal(selection.producer.producer, "review.fixture.default");
  assert.deepEqual(report.rows[0]?.usage, { input_tokens: 100, output_tokens: 10 });
  for (const path of projectionPaths) {
    assert.equal(existsSync(join(f.source.output, path)), false);
    assert.ok(!f.calls.some((c) => c.body.path === path));
  }
});

test("batch-only exports still identify the selected producer and paths", async (t) => {
  const f = await reviewUsageExportFixture({ withItem: false });
  t.after(f.cleanup);
  const { report, selection } = await exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl });
  assert.deepEqual(report.rows, []);
  assert.deepEqual(selection.paths, f.paths);
  assert.equal(selection.producer.producer, "review.fixture.default");
});

test("two matching producers export only the first complete native transaction", async (t) => {
  const f = await reviewUsageExportFixture({ secondProducer: true });
  t.after(f.cleanup);
  const { report, selection } = await exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl });
  assert.equal(selection.producer.producer, "review.fixture.default");
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]?.subject.number, 42);
  assert.ok(selection.paths.length < f.paths.length);
  for (const path of f.paths.filter((p) => p.includes("/review.fixture.secondary/"))) {
    assert.equal(existsSync(join(f.source.output, path)), false);
    assert.ok(!f.calls.some((c) => c.body.path === path));
  }
});

for (const missing of ["reservation", "completion", "event"]) {
  test(`missing ${missing} binding produces no usable export`, async (t) => {
    const f = await reviewUsageExportFixture();
    t.after(f.cleanup);
    const binding = f.bindings.find((b) =>
      missing === "reservation"
        ? b.relativePath.includes("/shard-sets/")
        : missing === "completion"
          ? b.relativePath.includes("/completed-shard-sets/")
          : b.relativePath.includes("/events/"),
    )!;
    assert.ok(binding);
    f.objects.delete(binding.relativePath);
    await assert.rejects(exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl }), /incomplete/);
    assert.equal(existsSync(f.source.output), false);
  });
}

test("legacy markerless shards cannot certify a canonical export", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  for (const binding of f.bindings) f.objects.delete(binding.relativePath);
  await assert.rejects(exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl }), /http_404/);
  assert.equal(existsSync(f.source.output), false);
});

test("wrong producer source and modified binding refuse publication", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  await assert.rejects(
    exportReviewUsage({ ...f.source, sourceSha: "c".repeat(40), fetchImpl: f.fetchImpl }),
    /wrong_producer/,
  );
  assert.equal(existsSync(f.source.output), false);
  f.objects.set(f.bindings.at(-1)!.relativePath, Buffer.from("{}\n"));
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl }),
    /canonical_validation/,
  );
  assert.equal(existsSync(f.source.output), false);
});

test("request and payload caps cannot publish partial data", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl, limits: { requests: 1 } }),
    /request_budget/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(existsSync(f.source.output), false);
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl, limits: { payloadBytes: 1 } }),
    /payload_budget/,
  );
  assert.equal(existsSync(f.source.output), false);
});

test("descriptor streaming budget and cursor cycles are bounded", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl, limits: { metadataBytes: 16 } }),
    /byte_budget/,
  );
  assert.equal(existsSync(f.source.output), false);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({
      ok: true,
      prefix: "ledger/v1/events/2026/11/26/openclaw-clawsweeper/",
      blobs: [],
      nextCursor: "repeat",
    });
  };
  await assert.rejects(exportReviewUsage({ ...f.source, fetchImpl }), /invalid_cursor/);
  assert.equal(calls, 2);
  assert.equal(existsSync(f.source.output), false);
});

test("metadata and payload limits are cumulative across responses", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  const sizes: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await f.fetchImpl(input, init);
    if (!String(input).endsWith("/chunk"))
      sizes.push((await response.clone().arrayBuffer()).byteLength);
    return response;
  };
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl, limits: { metadataBytes: 800 } }),
    /byte_budget/,
  );
  assert.ok(Math.max(...sizes) < 800);
  assert.ok(sizes.reduce((a, b) => a + b, 0) > 800);
  assert.equal(existsSync(f.source.output), false);
  const first = f.objects.get(f.paths[0]!)!.length;
  const reservation = f.objects.get(
    f.bindings.find((b) => b.relativePath.includes("/shard-sets/"))!.relativePath,
  )!.length;
  const budget = first + reservation - 1;
  assert.ok(first < budget && reservation < budget);
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl, limits: { payloadBytes: budget } }),
    /payload_budget/,
  );
  assert.equal(existsSync(f.source.output), false);
});

test("error response bodies consume the same metadata byte budget", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl, limits: { metadataBytes: 4 } }),
    /byte_budget/,
  );
  assert.equal(calls, 1);
  assert.equal(existsSync(f.source.output), false);
});

test("one overall deadline aborts an outstanding request", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  let aborted = false;
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("fixture aborted"));
        },
        { once: true },
      );
    });
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl, limits: { deadlineMs: 30 } }),
    /deadline/,
  );
  assert.equal(aborted, true);
  assert.equal(existsSync(f.source.output), false);
});

test("the same deadline aborts a body stalled after headers", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  let aborted = false;
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          init!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              controller.error(new Error("fixture body aborted"));
            },
            { once: true },
          );
        },
      }),
    );
  await assert.rejects(
    exportReviewUsage({ ...f.source, fetchImpl, limits: { deadlineMs: 30 } }),
    /deadline/,
  );
  assert.equal(aborted, true);
  assert.equal(existsSync(f.source.output), false);
});

test("HTTP failures never retry, and existing output remains untouched", async (t) => {
  const f = await reviewUsageExportFixture();
  t.after(f.cleanup);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(exportReviewUsage({ ...f.source, fetchImpl }), /http_503/);
  assert.equal(calls, 1);
  assert.equal(existsSync(f.source.output), false);
  mkdirSync(f.source.output);
  const sentinel = join(f.source.output, "keep.txt");
  writeFileSync(sentinel, "keep");
  await assert.rejects(exportReviewUsage({ ...f.source, fetchImpl: f.fetchImpl }), /incomplete/);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});
