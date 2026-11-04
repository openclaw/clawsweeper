import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ExactReviewQueue, REVIEW_COVERAGE_READ_WAIT_MS } from "../dashboard/exact-review-queue.ts";
import {
  ExactReviewDirectPublicationStore,
  REVIEW_COVERAGE_INVENTORY_KEY,
  REVIEW_COVERAGE_SCAN_MAX_AGE_MS,
} from "../dashboard/exact-review-direct-publication.ts";
import { CANONICAL_BODY_PREFIX } from "../dashboard/canonical-bodies.ts";
import { privateReviewCoverageProjection } from "../dashboard/public-observability.ts";
import { publicCoverageForBuild } from "../dashboard-site/scripts/coverage.ts";
import { liveCoverage } from "../dashboard-site/src/lib/live-coverage.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

function fixture() {
  const now = Date.now(),
    date = new Date(now - 60000).toISOString(),
    storage = new TestStorage(),
    bodies = new Map<string, Uint8Array>();
  let gets = 0,
    revision = 7,
    hook: (() => Promise<void>) | null = null;
  const bucket = {
    async get(key: string) {
      gets++;
      const pending = hook;
      hook = null;
      if (pending) await pending();
      const value = bodies.get(key);
      return value
        ? {
            size: value.length,
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(value.slice());
                c.close();
              },
            }),
          }
        : null;
    },
    async put() {
      throw new Error("Read-only existing-body fixture");
    },
  };
  const store = new ExactReviewDirectPublicationStore(storage, bucket);
  store.ensureSchemaSync();
  const content = (status: string) =>
    [
      "---",
      "repository: sample/repo",
      "type: issue",
      "review_status: " + status,
      "reviewed_at: " + date,
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "---",
      "Existing synthetic canonical body.",
    ].join("\n");
  const source = (status: string, insert = false) => {
    const body = content(status),
      digest = createHash("sha256").update(body).digest("hex");
    bodies.set(CANONICAL_BODY_PREFIX + digest, Buffer.from(body));
    if (insert)
      storage.sql.exec(
        "INSERT INTO exact_review_canonical_records_v2 (repo_slug,section,item_id,digest,byte_length,deleted,revision,item_key,claim_generation,updated_at,coverage_repo,coverage_status,coverage_reviewed_at,coverage_excluded) VALUES ('sample-repo','items',1,?,?,0,?,'sample/repo#1',3,?,'sample/repo','complete',?,0)",
        digest,
        Buffer.byteLength(body),
        revision,
        now,
        Date.parse(date),
      );
    else
      storage.sql.exec(
        "UPDATE exact_review_canonical_records_v2 SET digest=?,byte_length=?,revision=?,coverage_facts=NULL,updated_at=? WHERE item_id=1",
        digest,
        Buffer.byteLength(body),
        ++revision,
        Date.now(),
      );
  };
  source("complete", true);
  const queue = new ExactReviewQueue({ storage }, { STATE_SNAPSHOTS: bucket });
  storage.kv.put(REVIEW_COVERAGE_INVENTORY_KEY, {
    generated_at: new Date(now).toISOString(),
    repositories: [
      {
        repo: "sample/repo",
        repo_slug: "sample-repo",
        visibility: "public",
        open_issues: 1,
        open_pull_requests: 0,
        counts_observed_at: new Date(now).toISOString(),
        complete: true,
        items: [{ number: 1, kind: "issue", labels: [], reopened_at: null, updated_at: date }],
      },
    ],
  });
  let fetches = 0;
  const read = async () => {
    fetches++;
    const response = await queue.fetch(new Request("https://queue/review-coverage"));
    assert.equal(response.status, 200);
    const raw = (await response.json()) as Record<string, unknown>;
    const candidate = privateReviewCoverageProjection(raw);
    assert.ok(candidate);
    const projected = publicCoverageForBuild(candidate, new Set(["sample/repo"]));
    return { raw, projected, model: liveCoverage(projected, Date.now()) };
  };
  const block = () => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    hook = async () => {
      entered();
      await waiting;
    };
    return { started, release };
  };
  return { queue, storage, source, read, block, gets: () => gets, fetches: () => fetches };
}

test("one fetch at each 15m+1 build cadence consumes a refreshed source, not stale counts with a fresh date", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  let result = await f.read();
  assert.equal(result.model.percent, 100);
  let previous = result.raw.record_scan_observed_at;
  for (let cycle = 1; cycle <= 3; cycle++) {
    t.mock.timers.tick(REVIEW_COVERAGE_SCAN_MAX_AGE_MS + 1);
    const status = cycle % 2 ? "failed" : "complete";
    f.source(status);
    const before = f.fetches();
    result = await f.read();
    assert.equal(f.fetches(), before + 1, "the static consumer fetches exactly once per cycle");
    assert.equal(result.model.known, true);
    assert.equal(result.model.percent, status === "failed" ? 0 : 100);
    assert.equal(result.projected.totals.failed, status === "failed" ? 1 : 0);
    assert.notEqual(result.raw.record_scan_observed_at, previous);
    assert.equal(Date.parse(String(result.raw.record_scan_observed_at)), Date.now());
    previous = result.raw.record_scan_observed_at;
  }
});

test("expired-cache refreshes coalesce while unrelated reads and heartbeat validation remain responsive", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  await f.read();
  t.mock.timers.tick(REVIEW_COVERAGE_SCAN_MAX_AGE_MS + 1);
  f.source("failed");
  const block = f.block();
  const first = f.read(),
    second = f.read();
  await block.started;
  const stats = await f.queue.fetch(new Request("https://queue/stats"));
  assert.equal(stats.status, 200);
  const heartbeat = await f.queue.fetch(
    new Request("https://queue/heartbeat", { method: "POST", body: "{}" }),
  );
  assert.equal(heartbeat.status, 400);
  assert.equal(f.gets(), 2, "warm read plus one shared refresh body read");
  block.release();
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.model.known, true);
    assert.equal(result.model.percent, 0);
    assert.equal(result.projected.totals.failed, 1);
  }
});

test("failed expired-cache refresh returns Unknown rather than copying stale categories or their date", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  const warm = await f.read();
  assert.equal(warm.model.percent, 100);
  t.mock.timers.tick(REVIEW_COVERAGE_SCAN_MAX_AGE_MS + 1);
  f.source("failed");
  f.storage.failNextSqlMatching(/SELECT MIN\(repo_slug\)/);
  const failed = await f.read();
  assert.equal(failed.raw.record_scan_observed_at, null);
  assert.equal(failed.model.known, false);
  assert.equal(failed.model.percent, null);
  assert.equal(failed.projected.totals.reviewed_recent, null);
  assert.equal(failed.model.open_records, 1);
  assert.notEqual(failed.raw.record_scan_observed_at, warm.raw.record_scan_observed_at);
  t.mock.timers.tick(REVIEW_COVERAGE_SCAN_MAX_AGE_MS + 1);
  const next = await f.read();
  assert.equal(next.model.known, true);
  assert.equal(next.projected.totals.failed, 1);
  assert.equal(next.model.percent, 0);
});

test("bounded read timeout returns Unknown and a late refresh cannot rewrite that response", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  await f.read();
  t.mock.timers.tick(REVIEW_COVERAGE_SCAN_MAX_AGE_MS + 1);
  f.source("failed");
  const block = f.block(),
    pending = f.read();
  await block.started;
  t.mock.timers.tick(REVIEW_COVERAGE_READ_WAIT_MS);
  const timeout = await pending;
  assert.equal(timeout.raw.record_scan_observed_at, null);
  assert.equal(timeout.raw.scan_status, "unknown");
  assert.equal(timeout.model.known, false);
  assert.equal(timeout.model.percent, null);
  assert.equal(timeout.projected.totals.reviewed_recent, null);
  assert.equal(timeout.model.open_records, 1);
  const inFlight = (f.queue as unknown as { reviewCoverageScanInFlight: Promise<unknown> | null })
    .reviewCoverageScanInFlight;
  block.release();
  await inFlight;
  assert.equal(timeout.raw.record_scan_observed_at, null);
  assert.equal(timeout.model.known, false);
});
