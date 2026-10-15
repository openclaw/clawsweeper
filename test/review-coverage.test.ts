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

const now = Date.parse("2026-10-15T12:00:00Z");
const date = new Date(now - 60_000).toISOString();
const open = (
  number: number,
  extra: Partial<ReviewCoverageOpenItem> = {},
): ReviewCoverageOpenItem => ({ number, kind: "issue", updated_at: date, labels: [], ...extra });
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
      pull,
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
