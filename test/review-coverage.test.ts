import assert from "node:assert/strict";
import test from "node:test";
import {
  ExactReviewDirectPublicationStore,
  normalizeReviewCoverageInventory,
  type ReviewCoverageFleetCounts,
} from "../dashboard/exact-review-direct-publication.ts";
import {
  reviewCoverageRecord,
  reviewCoverageRecordState,
  type ReviewCoverageInventorySnapshot,
  type ReviewCoverageOpenItem,
} from "../src/review-coverage.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
import {
  loadReviewCoverageInventory,
  reviewCoverageInventorySnapshot,
} from "../dist/repair/target-fanout.js";
import { publicReviewCoverageProjection } from "../dashboard/public-observability.ts";
import { liveCoverage } from "../dashboard-site/src/lib/live-coverage.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const date = new Date(now - 60_000).toISOString();
const open = (
  number: number,
  extra: Partial<ReviewCoverageOpenItem> = {},
): ReviewCoverageOpenItem => ({
  number,
  kind: "issue",
  updated_at: date,
  reopened_at: null,
  labels: [],
  ...extra,
});
const report = (extra = "") =>
  reviewCoverageRecord(`---
type: issue
review_status: complete
reviewed_at: ${date}
local_checkout_access: verified
local_checkout_access_source: runner_preflight_v1
${extra}---
`);
const inventory = (items: ReviewCoverageOpenItem[]): ReviewCoverageInventorySnapshot => ({
  generated_at: new Date(now).toISOString(),
  repositories: [
    {
      repo: "sample/repo",
      repo_slug: "sample-repo",
      open_issues: items.filter((item) => item.kind === "issue").length,
      open_pull_requests: items.filter((item) => item.kind === "pull_request").length,
      complete: true,
      items,
    },
  ],
});
function fixture() {
  const fleet: ReviewCoverageFleetCounts = {
    repo: "sample/repo",
    repo_slug: "sample-repo",
    tracked_records: 3,
    reviewed_recent: 3,
    stale: 0,
    failed: 0,
    expired: 0,
    unreviewed_records: 0,
    excluded: 0,
    oldest_reviewed_at: date,
    records: new Map([
      [1, report()],
      [2, report()],
      [3, report()],
    ]),
  };
  return {
    store: new ExactReviewDirectPublicationStore(new TestStorage()),
    scanned: new Map([["sample-repo", fleet]]),
  };
}

test("coverage joins live identities instead of letting closed fresh records consume open slots", () => {
  const { store, scanned } = fixture();
  const result = store.reviewCoverageSummary(scanned, now, inventory([open(1), open(4), open(5)]));
  assert.equal(result.coverage_status, "complete");
  assert.equal(result.totals.reviewed_recent, 1);
  assert.equal(result.totals.untracked_open, 2);
  assert.equal(result.totals.record_drift, 2);
  assert.equal(result.totals.coverage_percent, 33.3);
  assert.equal(JSON.stringify(result).includes('"records"'), false);
});

test("coverage uses live exclusion labels and checks item kind and measured pull head", () => {
  const { store, scanned } = fixture();
  const result = store.reviewCoverageSummary(
    scanned,
    now,
    inventory([
      open(1, { labels: ["security"] }),
      open(2, { kind: "pull_request", head_sha: "a".repeat(40) }),
      open(3),
    ]),
  );
  assert.equal(result.totals.excluded, 1);
  assert.equal(result.totals.stale, 1);
  assert.equal(result.totals.reviewed_recent, 1);
  assert.equal(result.totals.coverage_percent, 50);
});

test("missing, count-only, incomplete and stale inventories cannot claim coverage", () => {
  const { store, scanned } = fixture();
  const counted = inventory([open(1)]);
  delete counted.repositories[0]!.items;
  delete counted.repositories[0]!.complete;
  const incomplete = inventory([open(1)]);
  incomplete.repositories[0]!.complete = false;
  const stale = inventory([open(1)]);
  stale.generated_at = new Date(now - 13 * 60 * 60 * 1000).toISOString();
  for (const value of [null, counted, incomplete, stale]) {
    const result = store.reviewCoverageSummary(scanned, now, value);
    assert.equal(result.coverage_status, "unknown");
    assert.equal(result.totals.coverage_percent, null);
    assert.equal(result.totals.reviewed_recent, 0);
    assert.equal(result.totals.pending, 0);
  }
});

test("inventory normalization rejects duplicate, partial and malformed identity witnesses", () => {
  assert.ok(normalizeReviewCoverageInventory(inventory([open(1)])));
  assert.equal(normalizeReviewCoverageInventory(inventory([open(1), open(1)])), null);
  const partial = inventory([open(1)]);
  partial.repositories[0]!.open_issues = 2;
  assert.equal(normalizeReviewCoverageInventory(partial), null);
  assert.equal(
    normalizeReviewCoverageInventory(
      inventory([open(1, { kind: "pull_request", head_sha: "unknown" })]),
    ),
    null,
  );
});

test("coverage requires matching measured PR head while retaining the existing review window", () => {
  const pull = open(1, { kind: "pull_request", head_sha: "a".repeat(40) });
  const current = { ...report(), kind: "pull_request", headSha: "a".repeat(40) };
  assert.equal(reviewCoverageRecordState(current, pull, now, 7 * 86400_000), "reviewed_recent");
  assert.equal(
    reviewCoverageRecordState({ ...current, headSha: "b".repeat(40) }, pull, now, 7 * 86400_000),
    "stale",
  );
  assert.equal(
    reviewCoverageRecordState(
      { ...current, reviewedAt: new Date(now - 8 * 86400_000).toISOString() },
      { ...pull, updated_at: new Date(now - 9 * 86400_000).toISOString() },
      now,
      7 * 86400_000,
    ),
    "expired",
  );
  assert.equal(
    reviewCoverageRecordState(
      { ...current, reviewedAt: new Date(now + 1).toISOString() },
      pull,
      now,
      7 * 86400_000,
    ),
    "unreviewed_records",
  );
  assert.equal(
    reviewCoverageRecordState({ ...current, status: "failed" }, pull, now, 7 * 86400_000),
    "failed",
  );
});

test("stale or future canonical scans never certify live coverage", () => {
  const { store, scanned } = fixture();
  for (const scannedAt of [now + 1, now - 16 * 60000]) {
    const result = store.reviewCoverageSummary(
      scanned,
      now,
      inventory([open(1)]),
      undefined,
      scannedAt,
    );
    assert.equal(result.coverage_status, "unknown");
    assert.equal(result.scan_status, "unknown");
    assert.equal(result.fleets[0]!.coverage_status, "unknown");
    assert.equal(result.totals.coverage_percent, null);
  }
});

test("legacy v2 metadata without identity facts cannot grant freshness", () => {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  storage.sql.exec(
    `INSERT INTO exact_review_canonical_records_v2
    (repo_slug,section,item_id,digest,byte_length,deleted,revision,item_key,claim_generation,updated_at,coverage_repo,coverage_status,coverage_reviewed_at,coverage_excluded)
    VALUES ('sample-repo','items',1,?,1,0,1,'sample/repo#1',1,?,'sample/repo','complete',?,0)`,
    "a".repeat(64),
    now,
    now,
  );
  const scanned = new Map<string, ReviewCoverageFleetCounts>();
  store.reviewCoverageScanPageSync(scanned, null, 10, now);
  const result = store.reviewCoverageSummary(scanned, now, inventory([open(1)]));
  assert.equal(result.totals.reviewed_recent, 0);
  assert.equal(result.fleets[0]!.coverage_status, "unknown");
  assert.equal(result.fleets[0]!.reason, "canonical_evidence_unavailable");
  assert.equal(result.totals.coverage_percent, null);
});

test("more than ten pages retains trusted Open while identity categories remain bounded", () => {
  const repo = { targetRepo: "sample/repo", defaultBranch: "main", visibility: "PUBLIC" };
  let reads = 0;
  const value = loadReviewCoverageInventory(
    [repo],
    new Map([
      [repo.targetRepo, { issues: 1001, pullRequests: 0, observedAt: new Date(now).toISOString() }],
    ]),
    now,
    (query) => {
      reads++;
      const start = Number(query.match(/after:"([0-9]+)"/)?.[1] ?? 0);
      const page = {
        issues: {
          totalCount: 1001,
          nodes: Array.from({ length: Math.min(100, 1001 - start) }, (_, index) => ({
            number: start + index + 1,
            updatedAt: date,
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            timelineItems: { nodes: [] },
          })),
          pageInfo: { hasNextPage: start + 100 < 1001, endCursor: String(start + 100) },
        },
      };
      return { data: query.includes("r0:repository") ? { r0: page } : { repository: page } };
    },
  );
  assert.equal(reads, 10);
  assert.equal(value.repositories[0]!.complete, false);
  const { store } = fixture();
  const summary = store.reviewCoverageSummary(
    new Map(),
    now,
    normalizeReviewCoverageInventory(value),
  );
  const projected = publicReviewCoverageProjection({
    ok: true,
    generated_at: new Date(now).toISOString(),
    ...summary,
  })!;
  assert.equal(projected.count_status, "observed");
  assert.equal(projected.totals.open_records, 1001);
  assert.equal(projected.totals.excluded, null);
  assert.equal(projected.totals.reviewable_records, null);
  assert.equal(projected.totals.coverage_percent, null);
  const model = liveCoverage(projected, now);
  assert.equal(model.open_records, 1001);
  assert.equal(model.rows[0].open_records, 1001);
  assert.equal(model.rows[0].percent, null);
});

test("missing, stale and future count observations never become observed zero", () => {
  const repo = { targetRepo: "sample/repo", defaultBranch: "main", visibility: "PUBLIC" };
  const { store } = fixture();
  for (const counts of [
    new Map(),
    new Map([
      [
        repo.targetRepo,
        { issues: 7, pullRequests: 0, observedAt: new Date(now - 13 * 3600000).toISOString() },
      ],
    ]),
    new Map([
      [
        repo.targetRepo,
        { issues: 7, pullRequests: 0, observedAt: new Date(now + 1).toISOString() },
      ],
    ]),
  ]) {
    const snapshot = reviewCoverageInventorySnapshot([repo], counts, now);
    const summary = store.reviewCoverageSummary(
      new Map(),
      now,
      normalizeReviewCoverageInventory(snapshot),
    );
    const projected = publicReviewCoverageProjection({
      ok: true,
      generated_at: new Date(now).toISOString(),
      ...summary,
    })!;
    assert.equal(projected.totals.open_records, null);
    assert.equal(projected.totals.coverage_percent, null);
  }
});

function scanRecord(markdown: string, chunked = false) {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  storage.sql.exec(
    `INSERT INTO exact_review_canonical_records
    (repo_slug, section, item_id, content, digest, byte_length, chunk_count, revision, item_key, claim_generation, updated_at)
    VALUES ('sample-repo', 'items', 1, ?, ?, ?, ?, 1, 'sample/repo#1', 1, ?)`,
    chunked ? null : markdown,
    "a".repeat(64),
    Buffer.byteLength(markdown),
    chunked ? 1 : 0,
    now,
  );
  if (chunked)
    storage.sql.exec(
      `INSERT INTO exact_review_canonical_record_chunks
    (repo_slug, section, item_id, chunk_index, content_base64)
    VALUES ('sample-repo', 'items', 1, 0, ?)`,
      Buffer.from(markdown).toString("base64"),
    );
  const scanned = new Map<string, ReviewCoverageFleetCounts>();
  store.reviewCoverageScanPageSync(scanned, null, 10, now);
  return scanned.get("sample-repo")!.records!.get(1)!;
}

test("bounded coverage scans preserve full-report semantics across long typed headers", () => {
  for (const status of ["complete", "failed", "stale_source"]) {
    for (const access of ["verified", "unverified"]) {
      // Canonical writer puts scalar status/source fields before the large review_record JSON.
      const markdown = `---
number: 1
repository: sample/repo
type: pull_request
pull_head_sha: ${"a".repeat(40)}
reviewed_at: ${date}
review_status: ${status}
local_checkout_access: ${access}
local_checkout_access_source: runner_preflight_v1
review_record: ${JSON.stringify({ version: 1, decision: { summary: "typed review evidence ".repeat(1000) } })}
---
body
`;
      assert.ok(markdown.indexOf("\n---", 3) > 4096);
      assert.equal(markdown.slice(0, 4096).includes("\n---", 3), false);
      for (const chunked of [false, true]) {
        assert.deepEqual(scanRecord(markdown, chunked), reviewCoverageRecord(markdown));
      }
    }
  }
});

test("bounded coverage scan does not accept duplicate or clipped gate fields", () => {
  const fields = `---\ntype: issue\nreviewed_at: ${date}\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\n`;
  assert.equal(
    scanRecord(`${fields}review_status: failed\nreview_record: ${"x".repeat(5000)}\n---\n`).status,
    "unknown",
  );
  const prefix = fields.replace("local_checkout_access_source: runner_preflight_v1\n", "");
  const clipped = `${prefix}padding: ${"x".repeat(4096 - prefix.length - "padding: ".length - 1)}\nlocal_checkout_access_source: runner_preflight_v1\n---\n`;
  assert.equal(scanRecord(clipped).status, "stale_local_checkout_unverified");
  // Earlier writer versions can place status after a long metadata field.
  const oldHeader = `---\ntype: issue\nlabels: ${JSON.stringify(["x".repeat(5000)])}\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\n---\n`;
  assert.equal(scanRecord(oldHeader).status, "unknown");
});
