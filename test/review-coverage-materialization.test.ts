import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ExactReviewDirectPublicationStore,
  REVIEW_COVERAGE_INVENTORY_KEY,
  type ReviewCoverageFleetCounts,
} from "../dashboard/exact-review-direct-publication.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { CANONICAL_BODY_PREFIX } from "../dashboard/canonical-bodies.ts";
import {
  reviewCoverageRecord,
  type ReviewCoverageInventorySnapshot,
} from "../src/review-coverage.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const now = Date.now();
const date = new Date(now - 60000).toISOString();
const markdown = (status = "complete") =>
  [
    "---",
    "repository: sample/repo",
    "type: issue",
    "review_status: " + status,
    "reviewed_at: " + date,
    "local_checkout_access: verified",
    "local_checkout_access_source: runner_preflight_v1",
    "---",
    "Existing synthetic canonical body, not a new review.",
    "",
  ].join("\n");
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
function setup() {
  const storage = new TestStorage();
  const bodies = new Map<string, Uint8Array>();
  let gets = 0;
  let beforeGet: (() => void) | null = null;
  const bucket = {
    async get(key: string) {
      gets++;
      const hook = beforeGet;
      beforeGet = null;
      hook?.();
      const value = bodies.get(key);
      return value
        ? {
            size: value.length,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(value.slice());
                controller.close();
              },
            }),
          }
        : null;
    },
    async put() {
      throw new Error("Read-model extraction must not put bodies");
    },
  };
  const store = new ExactReviewDirectPublicationStore(storage, bucket);
  store.ensureSchemaSync();
  const seed = (number: number, body = markdown(), revision = 7) => {
    const digest = hash(body);
    bodies.set(CANONICAL_BODY_PREFIX + digest, Buffer.from(body));
    storage.sql.exec(
      "INSERT INTO exact_review_canonical_records_v2 (repo_slug,section,item_id,digest,byte_length,deleted,revision,item_key,claim_generation,updated_at,coverage_repo,coverage_status,coverage_reviewed_at,coverage_excluded) VALUES ('sample-repo','items',?,?,?,0,?,'sample/repo',3,?,'sample/repo','complete',?,0)",
      number,
      digest,
      Buffer.byteLength(body),
      revision,
      now - 1000,
      now - 60000,
    );
    return digest;
  };
  const inventory = (ids: number[]): ReviewCoverageInventorySnapshot => ({
    generated_at: new Date(now).toISOString(),
    repositories: [
      {
        repo: "sample/repo",
        repo_slug: "sample-repo",
        visibility: "public",
        counts_observed_at: new Date(now).toISOString(),
        open_issues: ids.length,
        open_pull_requests: 0,
        complete: true,
        items: ids.map((number) => ({
          number,
          kind: "issue",
          labels: [],
          updated_at: date,
          reopened_at: null,
        })),
      },
    ],
  });
  const row = (id: number) =>
    Array.from(
      storage.sql.exec("SELECT * FROM exact_review_canonical_records_v2 WHERE item_id=?", id),
    )[0]!;
  return {
    storage,
    bodies,
    bucket,
    store,
    seed,
    inventory,
    row,
    gets: () => gets,
    beforeGet: (hook: () => void) => {
      beforeGet = hook;
    },
  };
}

test("coverage reader automatically materializes legacy v2 facts with no review or tuple publication", async () => {
  const f = setup();
  f.seed(1);
  const before = f.row(1);
  assert.equal(before.coverage_facts, null);
  const queue = new ExactReviewQueue({ storage: f.storage }, { STATE_SNAPSHOTS: f.bucket });
  f.storage.kv.put(REVIEW_COVERAGE_INVENTORY_KEY, f.inventory([1]));
  const response = await queue.fetch(new Request("https://queue/review-coverage"));
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    coverage_status: string;
    totals: { reviewed_recent: number; coverage_percent: number };
  };
  assert.equal(result.coverage_status, "complete");
  assert.equal(result.totals.reviewed_recent, 1);
  assert.equal(result.totals.coverage_percent, 100);
  const after = f.row(1);
  const { coverage_facts: ignoredBefore, ...sourceBefore } = before;
  const { coverage_facts: facts, ...sourceAfter } = after;
  assert.equal(ignoredBefore, null);
  assert.deepEqual(sourceAfter, sourceBefore, "only read-model facts may change");
  assert.equal(JSON.parse(String(facts)).sourceDigest, before.digest);
  assert.equal(JSON.parse(String(facts)).sourceRevision, before.revision);
  assert.equal(
    f.storage.scalar("SELECT COUNT(*) AS value FROM canonical_record_tuple_receipts"),
    0,
  );
  assert.equal(f.gets(), 1);
});

test("existing one-review PR facts are recovered without a new tuple or admission write", async () => {
  const f = setup();
  const head = "a".repeat(40);
  f.seed(1, markdown().replace("type: issue", "type: pull_request\npull_head_sha: " + head));
  const observed = f.inventory([1]);
  observed.repositories[0]!.open_issues = 0;
  observed.repositories[0]!.open_pull_requests = 1;
  observed.repositories[0]!.items![0] = {
    ...observed.repositories[0]!.items![0]!,
    kind: "pull_request",
    head_sha: head,
  };
  const queue = new ExactReviewQueue({ storage: f.storage }, { STATE_SNAPSHOTS: f.bucket });
  f.storage.kv.put(REVIEW_COVERAGE_INVENTORY_KEY, observed);
  const result = (await (
    await queue.fetch(new Request("https://queue/review-coverage"))
  ).json()) as { totals: { reviewed_recent: number; coverage_percent: number } };
  assert.equal(result.totals.reviewed_recent, 1);
  assert.equal(result.totals.coverage_percent, 100);
  assert.equal(
    f.storage.scalar("SELECT COUNT(*) AS value FROM canonical_record_tuple_receipts"),
    0,
  );
  assert.equal(
    f.storage.scalar("SELECT COUNT(*) AS value FROM exact_review_pull_request_answers"),
    0,
  );
});

test("legacy long headers are extracted from verified full bodies, not clipped scalar prefixes", async () => {
  const f = setup();
  f.seed(
    1,
    markdown().replace(
      "repository: sample/repo\n",
      "repository: sample/repo\npadding: " + "x".repeat(6000) + "\n",
    ),
  );
  const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  assert.equal(result.materialized, 1);
  const facts = JSON.parse(String(f.row(1).coverage_facts));
  assert.equal(facts.status, "complete");
  assert.equal(facts.kind, "issue");
});

test("legacy inline NUL prefixes cannot acquire later body facts during automatic materialization", async () => {
  const f = setup();
  const digest = f.seed(1, "---\n\0\n" + markdown().slice(4));
  const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  assert.equal(result.materialized, 1);
  const facts = JSON.parse(String(f.row(1).coverage_facts));
  assert.equal(facts.status, "unknown");
  assert.equal(facts.kind, undefined);
  assert.equal(facts.reviewedAt, undefined);
  assert.equal(facts.sourceDigest, digest);
  assert.equal(facts.sourceRevision, 7);
  assert.equal(
    f.storage.scalar("SELECT COUNT(*) AS value FROM canonical_record_tuple_receipts"),
    0,
  );
});

test("invalid or exhausted fact budgets never become unbounded reads", async () => {
  const f = setup();
  f.seed(1);
  for (const budget of [
    { rows: Number.NaN, bytes: 1024 },
    { rows: 32, bytes: Number.POSITIVE_INFINITY },
    { rows: 32, bytes: 1 },
  ]) {
    const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]), budget);
    assert.equal(result.attempted, 0);
  }
  assert.equal(f.gets(), 0);
  assert.equal(f.row(1).coverage_facts, null);
});

test("fact extraction is bounded and makes subsequent progress on already-stored bodies", async () => {
  const f = setup();
  f.seed(1);
  f.seed(2, markdown("failed"));
  const a = await f.store.materializeReviewCoverageFacts(f.inventory([1, 2]), {
    rows: 1,
    bytes: 4 * 1024 * 1024,
  });
  assert.equal(a.materialized, 1);
  assert.equal(a.attempted, 1);
  assert.equal(a.bounded, true);
  assert.equal(f.row(2).coverage_facts, null);
  const b = await f.store.materializeReviewCoverageFacts(f.inventory([1, 2]), {
    rows: 1,
    bytes: 4 * 1024 * 1024,
  });
  assert.equal(b.materialized, 1);
  assert.equal(f.gets(), 2);
  const c = await f.store.materializeReviewCoverageFacts(f.inventory([1, 2]));
  assert.equal(c.attempted, 0);
  assert.equal(f.gets(), 2);
});

test("digest/revision fencing preserves a concurrent current revision", async () => {
  const f = setup();
  const old = f.seed(1);
  const body = markdown("failed"),
    digest = hash(body);
  const currentFacts = JSON.stringify({
    ...reviewCoverageRecord(body),
    sourceDigest: digest,
    sourceRevision: 8,
  });
  f.bodies.set(CANONICAL_BODY_PREFIX + digest, Buffer.from(body));
  f.beforeGet(() =>
    f.storage.sql.exec(
      "UPDATE exact_review_canonical_records_v2 SET digest=?,byte_length=?,revision=8,coverage_facts=? WHERE item_id=1",
      digest,
      Buffer.byteLength(body),
      currentFacts,
    ),
  );
  const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  assert.equal(result.conflicts, 1);
  assert.equal(result.materialized, 0);
  assert.notEqual(f.row(1).digest, old);
  assert.equal(f.row(1).coverage_facts, currentFacts);
  assert.equal(f.row(1).revision, 8);
});

test("a concurrent deletion is never resurrected by a late fact read", async () => {
  const f = setup();
  f.seed(1);
  f.beforeGet(() =>
    f.storage.sql.exec(
      "UPDATE exact_review_canonical_records_v2 SET deleted=1,digest=NULL,byte_length=0,revision=8 WHERE item_id=1",
    ),
  );
  const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  assert.equal(result.conflicts, 1);
  assert.equal(f.row(1).deleted, 1);
  assert.equal(f.row(1).coverage_facts, null);
  assert.equal(f.row(1).revision, 8);
});

test("stale-bound facts from an older writer are rederived, never trusted across revisions", async () => {
  const f = setup();
  const old = f.seed(1);
  await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  const body = markdown("failed"),
    digest = hash(body);
  f.bodies.set(CANONICAL_BODY_PREFIX + digest, Buffer.from(body));
  f.storage.sql.exec(
    "UPDATE exact_review_canonical_records_v2 SET digest=?,byte_length=?,revision=8 WHERE item_id=1",
    digest,
    Buffer.byteLength(body),
  );
  const scanned = new Map<string, ReviewCoverageFleetCounts>();
  f.store.reviewCoverageScanPageSync(scanned, null, 10, now);
  assert.equal(scanned.get("sample-repo")!.records!.get(1)!.unavailable, true);
  const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  assert.equal(result.materialized, 1);
  const facts = JSON.parse(String(f.row(1).coverage_facts));
  assert.equal(facts.status, "failed");
  assert.equal(facts.sourceDigest, digest);
  assert.notEqual(facts.sourceDigest, old);
  assert.equal(facts.sourceRevision, 8);
});

test("a failed body cannot starve later valid legacy facts in the next bounded pass", async () => {
  const f = setup();
  const bad = f.seed(1);
  f.seed(2, markdown("failed"));
  f.bodies.set(CANONICAL_BODY_PREFIX + bad, Buffer.from("corrupt"));
  const first = await f.store.materializeReviewCoverageFacts(f.inventory([1, 2]), {
    rows: 1,
    bytes: 4 * 1024 * 1024,
  });
  assert.equal(first.unavailable, 1);
  const second = await f.store.materializeReviewCoverageFacts(f.inventory([1, 2]), {
    rows: 1,
    bytes: 4 * 1024 * 1024,
  });
  assert.equal(second.materialized, 1);
  assert.equal(f.row(1).coverage_facts, null);
  assert.notEqual(f.row(2).coverage_facts, null);
});

test("missing or corrupt bodies stay unknown without source changes or cache poisoning", async () => {
  const f = setup();
  const digest = f.seed(1),
    before = f.row(1);
  f.bodies.set(CANONICAL_BODY_PREFIX + digest, Buffer.from("corrupt"));
  const result = await f.store.materializeReviewCoverageFacts(f.inventory([1]));
  assert.equal(result.unavailable, 1);
  assert.equal(result.materialized, 0);
  assert.deepEqual(f.row(1), before);
});
