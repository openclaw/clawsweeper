import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
  validateCanonicalRecordTupleMutation,
} from "../dashboard/exact-review-direct-publication.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { reportWithoutHydrationCache } from "../src/report-hydration-cache.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
import { prepareStateMutationPlan } from "../dist/repair/state-publication-mutation.js";

const repo = "example-project";
const key = "record-hydration-cache-cleanup:v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const report = (cache = "cached GitHub inputs") =>
  `---\ntype: pull_request\nreview_status: complete\nreviewed_at: 2026-10-14T00:00:00Z\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\npr_hydration_snapshot: ${cache}\n---\nreview evidence\n`;
const request = () =>
  new Request("https://queue.invalid/admission-capabilities", { method: "POST" });

async function publication(id: number, content = report(), revision = 1) {
  return validateDirectPublicationPlan({
    canonicalTargetKey: `example/project#${id}`,
    fenceKey: `example/project#${id}:fence`,
    revision,
    identity: {
      canonicalTargetKey: `example/project#${id}`,
      fenceKey: `example/project#${id}:fence`,
      revision,
      claimGeneration: 7,
    },
    lifecycle: { kind: "guarded_open" },
    operations: [
      {
        path: `records/${repo}/items/${id}.md`,
        mode: "100644",
        deleted: false,
        bytes: Buffer.byteLength(content),
        contentBase64: Buffer.from(content).toString("base64"),
      },
    ],
    totalBytes: Buffer.byteLength(content),
  });
}

function setup() {
  const storage = new TestStorage();
  const store = new ExactReviewDirectPublicationStore(storage);
  store.ensureSchemaSync();
  return { storage, store };
}

async function legacy(store: ExactReviewDirectPublicationStore, id: number, content = report()) {
  const plan = await publication(id, content);
  // Recreate the older writer's persisted bytes and immutable original receipt.
  store.accept(
    {
      ...plan,
      operations: plan.operations.map(({ storedContent: _cache, ...operation }) => operation),
    },
    Date.now(),
  );
  return plan;
}

async function clean(store: ExactReviewDirectPublicationStore, storage: TestStorage) {
  const pass = await store.prepareHydrationCleanup(0, store.hydrationCleanupUpperRowidSync());
  return storage.transactionSync(() => store.retireHydrationCacheSync(pass, 0, Date.now()));
}

test("normalization removes only the cache field in the leading header", () => {
  const body = "---\npr_hydration_snapshot: quoted example\n---\n";
  const original = report('{"body":"Unicode 🦊"}') + body;
  assert.equal(reportWithoutHydrationCache(original), reportWithoutHydrationCache(report()) + body);
  assert.equal(
    reportWithoutHydrationCache("no header\npr_hydration_snapshot: keep\n"),
    "no header\npr_hydration_snapshot: keep\n",
  );
  assert.equal(
    reportWithoutHydrationCache(report().replaceAll("\n", "\r\n")),
    reportWithoutHydrationCache(report()).replaceAll("\n", "\r\n"),
  );
  const otherField =
    'title: "literal\u2028pr_hydration_snapshot: keep\u2029pr_hydration_snapshot: also keep"\n';
  const header = `---\n${otherField}pr_hydration_snapshot: remove\npr_hydration_snapshot: duplicate\n---\nreview\n`;
  assert.equal(reportWithoutHydrationCache(header), `---\n${otherField}---\nreview\n`);
});

test("old direct publishers retain exact receipts but cannot persist cache bytes", async () => {
  const { storage, store } = setup();
  const plan = await publication(1);
  const first = store.accept(plan, Date.now());
  assert.equal(
    store.readCanonical(repo, "items", 1)?.content,
    reportWithoutHydrationCache(report()),
  );
  assert.equal(
    first.row.operations[0] && "digest" in first.row.operations[0]
      ? first.row.operations[0].digest
      : null,
    hash(report()),
  );
  assert.equal(store.accept(plan, Date.now()).outcome, "deduped");
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM canonical_record_tuple_receipts"), 0);
});

test("new mutation plans omit the cache before calculating payload bytes", () => {
  const plan = prepareStateMutationPlan({
    identity: { itemKey: "example/project#1", revision: 1, claimGeneration: 1 },
    operations: [{ path: `records/${repo}/items/1.md`, content: report() }],
  });
  const expected = reportWithoutHydrationCache(report());
  assert.equal(plan.totalBytes, Buffer.byteLength(expected));
  assert.equal(
    Buffer.from(plan.operations[0]!.contentBase64!, "base64").toString("utf8"),
    expected,
  );
});

test("tuple mutation fingerprints describe original input, including after maintenance", async () => {
  const { storage, store } = setup();
  const old = await legacy(store, 1);
  const before = store.get(old.fenceKey, 1);
  await clean(store, storage);
  assert.deepEqual(store.get(old.fenceKey, 1), before);
  assert.equal(store.accept(old, Date.now()).outcome, "deduped");
  const operations = ["items", "closed", "plans", "decision-packets"].map((section) => ({
    path: `records/${repo}/${section}/1.${section === "decision-packets" ? "json" : "md"}`,
    expectedDigest: store.readCanonical(repo, section as "items", 1)?.digest ?? null,
    ...(section === "items"
      ? { contentBase64: Buffer.from(report("new old producer cache")).toString("base64") }
      : {}),
  }));
  const mutation = await validateCanonicalRecordTupleMutation({
    deliveryId: "original-tuple",
    key: `${repo}/1`,
    operations,
  });
  store.acceptCanonicalTupleMutation(mutation, Date.now());
  const retry = store.acceptCanonicalTupleMutation(mutation, Date.now());
  assert.equal(retry.outcome, "deduped");
  assert.equal(
    store.readCanonical(repo, "items", 1)?.content,
    reportWithoutHydrationCache(report()),
  );
});

test("maintenance preserves provenance, answered state, receipt identity and packet bytes", async () => {
  const { storage, store } = setup();
  await legacy(store, 1);
  storage.run("DELETE FROM exact_review_pull_request_answers");
  const packet = '{"evidence":"unchanged"}';
  const primary = report().replace(
    "---\nreview evidence",
    `decision_packet_sha256: ${hash(packet)}\ndecision_packet_path: records/${repo}/decision-packets/1.json\n---\nreview evidence`,
  );
  storage.run(
    "UPDATE exact_review_canonical_records SET content = ?, digest = ?, byte_length = ? WHERE section = 'items'",
    primary,
    hash(primary),
    Buffer.byteLength(primary),
  );
  storage.run(
    "UPDATE exact_review_record_export_index SET digest = ? WHERE section = 'items'",
    hash(primary),
  );
  storage.run(
    "UPDATE exact_review_canonical_records SET content = ?, digest = ?, byte_length = ?, deleted = 0 WHERE section = 'decision-packets'",
    packet,
    hash(packet),
    packet.length,
  );
  storage.run(
    "UPDATE exact_review_record_export_index SET digest = ?, deleted = 0 WHERE section = 'decision-packets'",
    hash(packet),
  );
  const receipt = store.list();
  const watermark = store.currentExportRevision();
  const result = await clean(store, storage);
  assert.equal(result.retired, 1);
  assert.equal(
    result.retiredBytes,
    Buffer.byteLength(report()) - Buffer.byteLength(reportWithoutHydrationCache(report())),
  );
  assert.equal(store.hasCompletedPullRequestReview(repo, 1), true);
  assert.equal(store.readCanonical(repo, "decision-packets", 1)?.content, packet);
  assert.equal(
    store.readCanonical(repo, "items", 1)?.content,
    reportWithoutHydrationCache(primary),
  );
  assert.equal(store.readCanonical(repo, "closed", 1)?.deleted, true);
  assert.deepEqual(store.list(), receipt);
  assert.equal(
    storage.scalar("SELECT COUNT(DISTINCT revision) AS value FROM exact_review_canonical_records"),
    1,
  );
  assert.equal(
    storage.scalar("SELECT MIN(claim_generation) AS value FROM exact_review_canonical_records"),
    7,
  );
  assert.ok(store.currentExportRevision() > watermark);
  assert.equal((await clean(store, storage)).retired, 0);
});

test("retirement never promotes stale-source or unknown completion provenance", async () => {
  for (const provenance of ["requeue", "unknown"]) {
    const { storage, store } = setup();
    const plan = await legacy(store, 1);
    storage.run("DELETE FROM exact_review_pull_request_answers");
    if (provenance === "unknown") storage.run("DELETE FROM exact_review_direct_publication_plans");
    else
      storage.run(
        "UPDATE exact_review_direct_publication_plans SET lifecycle_json = ?",
        JSON.stringify({ kind: "requeue" }),
      );
    await clean(store, storage);
    assert.equal(store.hasCompletedPullRequestReview(repo, 1), false);
    assert.equal(
      store.readCanonical(repo, "items", 1)?.content,
      reportWithoutHydrationCache(report()),
    );
    assert.equal(store.get(plan.fenceKey, 1)?.lifecycle?.kind ?? "unknown", provenance);
  }
});

test("ambiguous export ownership defers only that tuple and preserves independent progress", async () => {
  const { storage, store } = setup();
  await legacy(store, 1);
  await legacy(store, 2);
  storage.run(
    "UPDATE exact_review_record_export_index SET source = 'backfill' WHERE record_id = '1' AND section = 'items'",
  );
  const pass = await store.prepareHydrationCleanup(0, store.hydrationCleanupUpperRowidSync());
  const result = storage.transactionSync(() => store.retireHydrationCacheSync(pass, 0, Date.now()));
  assert.equal(result.conflicts, 1);
  assert.equal(result.deferredAfterRowid, 0);
  assert.equal(result.retired, 1);
  assert.equal(store.readCanonical(repo, "items", 1)?.content, report());
  assert.equal(
    store.readCanonical(repo, "items", 2)?.content,
    reportWithoutHydrationCache(report()),
  );
});

test("chunked cache retirement reconstructs content and rolls back with its export writes", async () => {
  const { storage, store } = setup();
  const content = report("x".repeat(1_600_000));
  await legacy(store, 1, content);
  assert.ok(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_record_chunks") > 0,
  );
  const before = store.readCanonical(repo, "items", 1);
  const pass = await store.prepareHydrationCleanup(0, store.hydrationCleanupUpperRowidSync());
  storage.failNextSqlMatching(/UPDATE exact_review_record_export_index/);
  assert.throws(
    () => storage.transactionSync(() => store.retireHydrationCacheSync(pass, 0, Date.now())),
    /injected/,
  );
  assert.deepEqual(store.readCanonical(repo, "items", 1), before);
  await clean(store, storage);
  assert.equal(
    store.readCanonical(repo, "items", 1)?.content,
    reportWithoutHydrationCache(content),
  );
  assert.equal(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_record_chunks"),
    0,
  );
});

test("same-byte newer publication is a conflict, not an ABA maintenance overwrite", async () => {
  const { storage, store } = setup();
  await legacy(store, 1);
  const pass = await store.prepareHydrationCleanup(0, store.hydrationCleanupUpperRowidSync());
  storage.run("UPDATE exact_review_canonical_records SET revision = revision + 1");
  storage.run(
    "UPDATE exact_review_record_export_index SET revision = revision + 1, store_revision = store_revision + 100",
  );
  const result = storage.transactionSync(() => store.retireHydrationCacheSync(pass, 0, Date.now()));
  assert.equal(result.conflicts, 1);
  assert.equal(result.deferredAfterRowid, 0);
  assert.equal(store.readCanonical(repo, "items", 1)?.content, report());
  assert.equal((await clean(store, storage)).retired, 1);
});

test("idle cleanup has a fixed bound, atomic checkpoint and restartable completion", async () => {
  const { storage, store } = setup();
  for (let id = 1; id <= 6; id++) await legacy(store, id);
  const earlier = Date.now() + 500;
  await storage.setAlarm(earlier);
  let queue = new ExactReviewQueue({ storage }, {});
  assert.equal((await queue.fetch(request())).status, 200);
  assert.equal(await storage.getAlarm(), earlier);
  const initial = structuredClone(storage.kv.get(key));
  const put = storage.kv.put;
  storage.kv.put = (name, value) => {
    if (name === key) throw new Error("checkpoint unavailable");
    return put(name, value);
  };
  await assert.rejects(queue.alarm(), /checkpoint unavailable/);
  assert.deepEqual(storage.kv.get(key), initial);
  assert.equal(store.readCanonical(repo, "items", 1)?.content, report());
  storage.kv.put = put;
  await queue.alarm();
  assert.equal((storage.kv.get(key) as { retired: number }).retired, 4);
  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  await queue.alarm();
  const complete = structuredClone(storage.kv.get(key)) as { completedAt: number; retired: number };
  assert.ok(complete.completedAt);
  assert.equal(complete.retired, 6);
  assert.equal(await storage.getAlarm(), null);
  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  assert.deepEqual(storage.kv.get(key), complete);
});

test("persistent conflicts finish independent work, replay bounded passes and remain visibly incomplete", async () => {
  const { storage, store } = setup();
  for (let id = 1; id <= 6; id++) await legacy(store, id);
  storage.run(
    "UPDATE exact_review_record_export_index SET revision = revision + 1 WHERE record_id = '1' AND section = 'items'",
  );
  let queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  await queue.alarm();
  const partial = storage.kv.get(key) as { passes: number; passConflicts: number };
  assert.equal(partial.passes, 0);
  assert.equal(partial.passConflicts, 1);
  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  let checkpoint: any;
  for (let alarms = 0; alarms < 8; alarms++) {
    await queue.alarm();
    checkpoint = storage.kv.get(key);
    if (checkpoint.blockedAt !== null) break;
  }
  assert.equal(checkpoint.passes, 3);
  assert.equal(checkpoint.passConflicts, 0);
  assert.equal(checkpoint.unresolved, 1);
  assert.equal(checkpoint.completedAt, null);
  assert.ok(checkpoint.blockedAt);
  assert.equal(checkpoint.retired, 5);
  assert.equal(await storage.getAlarm(), null);
  assert.equal(store.readCanonical(repo, "items", 1)?.content, report());
  const stats = await queue.fetch(
    new Request("https://queue.invalid/storage/stats", { method: "POST" }),
  );
  assert.deepEqual((await stats.json()).hydrationCacheCleanup, checkpoint);
  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request());
  assert.equal(await storage.getAlarm(), null);
});

test("oversized legacy metadata advances as unresolved instead of a zero-step loop", async () => {
  const { storage, store } = setup();
  await legacy(store, 1);
  await legacy(store, 2);
  storage.run(
    "UPDATE exact_review_canonical_records SET byte_length = 100000000 WHERE item_id = 1 AND section = 'items'",
  );
  const result = await clean(store, storage);
  assert.equal(result.conflicts, 1);
  assert.equal(result.retired, 1);
  assert.ok(result.scanned > 0);
  assert.equal(store.readCanonical(repo, "items", 1)?.content, report());
});

test("malformed chunk content defers only its tuple", async () => {
  const { storage, store } = setup();
  await legacy(store, 1, report("x".repeat(1_600_000)));
  await legacy(store, 2);
  storage.run(
    "DELETE FROM exact_review_canonical_record_chunks WHERE item_id = 1 AND chunk_index = 0",
  );
  const result = await clean(store, storage);
  assert.equal(result.conflicts, 1);
  assert.equal(result.retired, 1);
  assert.equal(
    store.readCanonical(repo, "items", 2)?.content,
    reportWithoutHydrationCache(report()),
  );
  assert.throws(() => store.readCanonical(repo, "items", 1), /chunk count mismatch/);
});

test("inconsistent inline byte counts and digests defer without falsifying removal counters", async () => {
  for (const mutation of [
    "UPDATE exact_review_canonical_records SET byte_length = byte_length + 1 WHERE item_id = 1 AND section = 'items'",
    "UPDATE exact_review_canonical_records SET digest = '" +
      "0".repeat(64) +
      "' WHERE item_id = 1 AND section = 'items'",
  ]) {
    const { storage, store } = setup();
    await legacy(store, 1);
    await legacy(store, 2);
    storage.run(mutation);
    const result = await clean(store, storage);
    assert.equal(result.conflicts, 1);
    assert.equal(result.retired, 1);
    assert.equal(
      result.retiredBytes,
      Buffer.byteLength(report()) - Buffer.byteLength(reportWithoutHydrationCache(report())),
    );
    assert.equal(store.readCanonical(repo, "items", 1)?.content, report());
    assert.equal(
      store.readCanonical(repo, "items", 2)?.content,
      reportWithoutHydrationCache(report()),
    );
  }
});
