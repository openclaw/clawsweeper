import {
  canonicalBodyLifecycleRules,
  verifyCanonicalBodyLifecycle,
} from "../src/canonical-body-tiering-policy.ts";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { ExactReviewPublicationBatchStore } from "../dashboard/exact-review-publication-batches.ts";
import { CanonicalBodyStore } from "../dashboard/canonical-bodies.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
  validateCanonicalRecordTupleMutation,
  CanonicalRecordTupleConflictError,
} from "../dashboard/exact-review-direct-publication.ts";
import {
  CanonicalBodyUnavailableError,
  CANONICAL_BODY_PREFIX,
} from "../dashboard/canonical-bodies.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
const repo = "example-project",
  sha = "a".repeat(40);
const gates = {
  operator: "synthetic-operator",
  rollbackFloor: {
    sha: "a".repeat(40),
    supportsFormats: [1, 2] as const,
    proof: "controlled candidate restart reads and writes both storage formats",
  },
  bucketLifecycle: {
    bucketIdentity: "clawsweeper-state-snapshots",
    observedAt: "2026-10-16T00:00:00Z",
    rulesJson: '{"rules":[]}',
    canonicalBodiesDoNotExpire: true as const,
  },
};
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
class Bucket {
  objects = new Map<string, Uint8Array>();
  puts = 0;
  gets = 0;
  beforeGet: (() => Promise<void>) | null = null;
  async put(key: string, bytes: Uint8Array, options: any) {
    this.puts++;
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    assert.equal(Buffer.from(options.sha256).toString("hex"), hash(Buffer.from(bytes).toString()));
    if (this.objects.has(key)) return null;
    this.objects.set(key, bytes.slice());
    return {};
  }
  async get(key: string) {
    this.gets++;
    if (this.beforeGet) await this.beforeGet();
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: value.byteLength,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(value.slice());
          controller.close();
        },
      }),
    };
  }
}
function setup() {
  const storage = new TestStorage(),
    bucket = new Bucket(),
    store = new ExactReviewDirectPublicationStore(storage, bucket);
  store.ensureSchemaSync();
  storage.exec(
    "CREATE TABLE exact_review_queue_meta(singleton_id INTEGER PRIMARY KEY,schema_version INTEGER NOT NULL); INSERT INTO exact_review_queue_meta VALUES(1,1)",
  );
  return { storage, bucket, store };
}
async function plan(id = 1, content = "雪🦊", revision = 1, lifecycle = "guarded_open") {
  return validateDirectPublicationPlan({
    canonicalTargetKey: `example/project#${id}`,
    fenceKey: `example/project#${id}:fence`,
    revision,
    identity: {
      canonicalTargetKey: `example/project#${id}`,
      fenceKey: `example/project#${id}:fence`,
      revision,
      claimGeneration: 3,
    },
    lifecycle: { kind: lifecycle as "guarded_open" },
    operations: [
      {
        path: `records/${repo}/items/${id}.md`,
        deleted: false,
        mode: "100644",
        bytes: Buffer.byteLength(content),
        contentBase64: Buffer.from(content).toString("base64"),
      },
    ],
    totalBytes: Buffer.byteLength(content),
  });
}
async function activate(store: ExactReviewDirectPublicationStore) {
  const preview = await store.tieringPreview(sha, gates);
  return store.activateTieringSync(preview, Date.now());
}
async function migrate(store: ExactReviewDirectPublicationStore) {
  const pass = await store.prepareTieringPass();
  return store.commitTieringPassSync(pass, Date.now());
}
const exportOptions = {
  repoSlug: repo,
  sections: ["items", "closed", "plans", "decision-packets"] as const,
  sinceRevision: 0,
  cursor: 0,
  limit: 200,
  maxBytes: 32 * 1024 * 1024,
  maxSourceBytes: 8 * 1024 * 1024,
  maxRecords: 200,
};

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function seedConcurrentPass(store: ExactReviewDirectPublicationStore) {
  for (let id = 1; id <= 4; id++) {
    const mutation = await validateCanonicalRecordTupleMutation({
      deliveryId: `concurrent-${id}`,
      key: `${repo}/${id}`,
      operations: ["items", "closed", "plans", "decision-packets"].map((section) => ({
        path: `records/${repo}/${section}/${id}.${section === "decision-packets" ? "json" : "md"}`,
        expectedDigest: null,
        ...(["items", "plans"].includes(section)
          ? {
              contentBase64: Buffer.from(
                section === "plans" ? "shared plan" : `body-${id}`,
              ).toString("base64"),
            }
          : {}),
      })),
    });
    store.acceptCanonicalTupleMutation(mutation, Date.now());
  }
  await activate(store);
}

test(
  "migration captures the whole pass, deduplicates bodies and caps verified pipelines at four",
  { timeout: 5000 },
  async () => {
    const { store, bucket } = setup();
    await seedConcurrentPass(store);
    const entered = barrier(),
      resume = barrier();
    let active = 0,
      peak = 0;
    bucket.beforeGet = async () => {
      active++;
      peak = Math.max(peak, active);
      if (active === 4) entered.release();
      await resume.promise;
      active--;
    };
    const preparing = store.prepareTieringPass();
    await entered.promise;
    assert.equal(bucket.puts, 4);
    // A foreground write to the last tuple races the first upload: its source
    // must already be captured, so the original complete-tuple CAS rejects it.
    bucket.beforeGet = null;
    const replacement = await plan(4, "foreground replacement", 2);
    store.accept(
      replacement,
      Date.now(),
      await store.prepareCanonicalWrites(replacement.operations),
    );
    resume.release();
    const pass = await preparing;
    assert.equal(pass.tuples.length, 4);
    assert.equal(pass.tuples[3]?.bodies.get("items"), "body-4");
    assert.equal(peak, 4);
    assert.equal(bucket.puts, 6); // five unique migration bodies plus foreground
    assert.equal(bucket.gets, 6);
    const committed = store.commitTieringPassSync(pass, Date.now());
    assert.equal(committed?.conflicts, 1);
    assert.equal(
      (await store.readCanonicalAsync(repo, "items", 4))?.content,
      "foreground replacement",
    );
  },
);

test(
  "failed migration stops new pipelines and drains all started I/O before rejecting",
  { timeout: 5000 },
  async () => {
    const { store, bucket, storage } = setup();
    await seedConcurrentPass(store);
    const allStarted = barrier(),
      failed = barrier(),
      drain = barrier();
    let started = 0,
      settled = false;
    bucket.beforeGet = async () => {
      const index = started++;
      if (started === 4) allStarted.release();
      await allStarted.promise;
      if (index === 0) {
        failed.release();
        throw new Error("synthetic readback failure");
      }
      await drain.promise;
    };
    const checkpoint = store.tieringStatusSync();
    const preparing = store.prepareTieringPass().finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(preparing, CanonicalBodyUnavailableError);
    await failed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(bucket.puts, 4);
    drain.release();
    await rejected;
    assert.equal(bucket.puts, 4);
    assert.equal(started, 4);
    assert.deepEqual(store.tieringStatusSync(), checkpoint);
    assert.equal(
      storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"),
      16,
    );
  },
);

test("same digest with disagreeing source bytes or content fails before any upload", async () => {
  for (const differentLength of [false, true]) {
    const { store, bucket, storage } = setup();
    store.accept(await plan(1, "first"), Date.now());
    store.accept(await plan(2, differentLength ? "different length" : "other"), Date.now());
    storage.sql.exec(
      "UPDATE exact_review_canonical_records SET digest=? WHERE item_id=2 AND section='items'",
      hash("first"),
    );
    await activate(store);
    await assert.rejects(store.prepareTieringPass(), /digest collision/);
    assert.equal(bucket.puts, 0);
    assert.equal(bucket.gets, 0);
  }
});

test("checkpoint requalification preserves progress, rejects old prepared passes and resumes after restart", async () => {
  const { store, bucket, storage } = setup();
  for (let id = 1; id <= 9; id++) store.accept(await plan(id, `body-${id}`), Date.now());
  const original = await store.tieringPreview(sha, gates);
  store.activateTieringSync(original, Date.now());
  await migrate(store);
  const before = store.tieringStatusSync()!;
  const inFlight = await store.prepareTieringPass();
  const nextSha = "b".repeat(40);
  const nextGates = {
    ...gates,
    rollbackFloor: { ...gates.rollbackFloor, sha: nextSha, proof: "qualified next deployment" },
    bucketLifecycle: { ...gates.bucketLifecycle, observedAt: "2026-10-19T00:00:00Z" },
  };
  await assert.rejects(store.tieringPreview(nextSha, nextGates), /approved plan changed/);
  const preview = await store.tieringRequalificationPreview(nextSha, nextGates, original.sha256);
  assert.equal(preview.packet.checkpointSha256, hash(JSON.stringify(before)));
  assert.equal(preview.sha256, hash(JSON.stringify(preview.packet)));
  assert.notEqual(preview.sha256, preview.packet.nextPlanSha256);
  const after = store.requalifyTieringSync(preview)!;
  assert.deepEqual(
    { ...after },
    {
      ...before,
      deployment_sha: nextSha,
      preview_sha256: preview.packet.nextPlanSha256,
      plan_json: JSON.stringify(preview.packet.nextPlan),
    },
  );
  assert.throws(() => store.commitTieringPassSync(inFlight, Date.now()), /checkpoint changed/);
  assert.throws(() => store.requalifyTieringSync(preview), /checkpoint changed/);
  await assert.rejects(
    store.tieringRequalificationPreview(nextSha, nextGates, original.sha256),
    /integrity mismatch/,
  );
  const restarted = new ExactReviewDirectPublicationStore(storage, bucket);
  restarted.ensureSchemaSync();
  assert.deepEqual(restarted.tieringStatusSync(), after);
  assert.equal(
    (await restarted.tieringPreview(nextSha, nextGates)).sha256,
    preview.packet.nextPlanSha256,
  );
  while (!restarted.tieringStatusSync()?.completed_at) await migrate(restarted);
  assert.equal(restarted.tieringStatusSync()?.upper_rowid, before.upper_rowid);
  assert.equal((await restarted.readCanonicalAsync(repo, "items", 9))?.content, "body-9");
  await assert.rejects(
    restarted.tieringRequalificationPreview("c".repeat(40), nextGates, after.preview_sha256),
    /incomplete checkpoint required/,
  );
});

test("requalification rejects stale checkpoints, corrupted plans and every unapproved plan change", async () => {
  const { store, storage } = setup();
  for (let id = 1; id <= 9; id++) store.accept(await plan(id, `body-${id}`), Date.now());
  const original = await store.tieringPreview(sha, gates);
  store.activateTieringSync(original, Date.now());
  const nextSha = "b".repeat(40);
  const nextGates = { ...gates, rollbackFloor: { ...gates.rollbackFloor, sha: nextSha } };
  for (const changed of [
    { ...nextGates, operator: "different-operator" },
    {
      ...nextGates,
      bucketLifecycle: {
        ...nextGates.bucketLifecycle,
        rulesJson: '{"rules":[{"id":"safe","enabled":false,"conditions":{}}]}',
      },
    },
  ])
    await assert.rejects(
      store.tieringRequalificationPreview(nextSha, changed, original.sha256),
      /scope changed/,
    );
  await assert.rejects(
    store.tieringRequalificationPreview(nextSha, nextGates, "0".repeat(64)),
    /integrity mismatch/,
  );
  const preview = await store.tieringRequalificationPreview(nextSha, nextGates, original.sha256);
  await migrate(store);
  assert.throws(() => store.requalifyTieringSync(preview), /checkpoint changed/);
  const checkpoint = store.tieringStatusSync()!;
  for (const mutate of [
    (packet: any) => {
      packet.limits.tuples = 5;
    },
    (packet: any) => {
      packet.scope.rows = "unbounded";
    },
    (packet: any) => {
      packet.version = 2;
    },
    (packet: any) => {
      packet.extra = true;
    },
  ]) {
    const packet = JSON.parse(String(checkpoint.plan_json));
    mutate(packet);
    const serialized = JSON.stringify(packet),
      digest = hash(serialized);
    storage.sql.exec(
      "UPDATE exact_review_canonical_body_tiering SET plan_json=?,preview_sha256=?",
      serialized,
      digest,
    );
    await assert.rejects(
      store.tieringRequalificationPreview(nextSha, nextGates, digest),
      /not canonical/,
    );
  }
  for (const mutate of [
    (packet: any) => {
      packet.gates.rollbackFloor.proof = "";
    },
    (packet: any) => {
      packet.gates.bucketLifecycle.observedAt = "invalid";
    },
    (packet: any) => {
      packet.deploymentSha = packet.gates.rollbackFloor.sha = "invalid";
    },
  ]) {
    const packet = JSON.parse(String(checkpoint.plan_json));
    mutate(packet);
    const serialized = JSON.stringify(packet),
      digest = hash(serialized);
    storage.sql.exec(
      "UPDATE exact_review_canonical_body_tiering SET plan_json=?,preview_sha256=?",
      serialized,
      digest,
    );
    await assert.rejects(
      store.tieringRequalificationPreview(nextSha, nextGates, digest),
      /invalid canonical tiering attestation/,
    );
  }
  storage.sql.exec(
    "UPDATE exact_review_canonical_body_tiering SET plan_json=?",
    checkpoint.plan_json,
  );
  await assert.rejects(
    store.tieringRequalificationPreview(nextSha, nextGates, original.sha256),
    /integrity mismatch/,
  );
});

test("dormant schema1 writes have no R2 effects; physical migration preserves bytes and all logical metadata", async () => {
  const { storage, bucket, store } = setup();
  for (const [i, content] of [
    "",
    "snow 雪🦊\0",
    "x".repeat(1572865),
    "z".repeat(2 * 1024 * 1024),
  ].entries()) {
    const publication = await plan(i + 1, content);
    const prepared = await store.prepareCanonicalWrites(publication.operations);
    store.accept(publication, Date.now(), prepared);
  }
  assert.equal(store.storageFormatSync(), 1);
  assert.equal(bucket.puts, 0);
  const before = await store.exportRecords(exportOptions),
    watermark = store.currentExportRevision();
  const receipts = store.list();
  await activate(store);
  const checkpoint = await migrate(store);
  assert.ok(checkpoint?.completed_at);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"), 0);
  assert.equal(
    storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_record_chunks"),
    0,
  );
  assert.deepEqual(await store.exportRecords(exportOptions), before);
  assert.equal(store.currentExportRevision(), watermark);
  assert.deepEqual(store.list(), receipts);
  assert.equal((await store.readCanonicalAsync(repo, "items", 2))?.content, "snow 雪🦊\0");
});

test("format1 preparation cannot write SQL bodies after activation; capable warm writer reprepares", async () => {
  const { storage, store } = setup();
  const publication = await plan();
  const prepared = await store.prepareCanonicalWrites(publication.operations);
  await activate(store);
  assert.throws(
    () => store.accept(publication, Date.now(), prepared),
    CanonicalBodyUnavailableError,
  );
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"), 0);
  store.accept(publication, Date.now(), await store.prepareCanonicalWrites(publication.operations));
  assert.equal((await store.readCanonicalAsync(repo, "items", 1))?.content, "雪🦊");
});

test("pending point read keeps captured metadata on overwrite", async () => {
  const { store, bucket } = setup();
  store.accept(await plan(), Date.now());
  await activate(store);
  await migrate(store);
  let unblock: () => void = () => {},
    entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  bucket.beforeGet = async () => {
    entered();
    await pending;
  };
  const old = store.readCanonicalAsync(repo, "items", 1);
  await started;
  bucket.beforeGet = null;
  const next = await plan(1, "new", 2);
  store.accept(next, Date.now(), await store.prepareCanonicalWrites(next.operations));
  unblock();
  assert.equal((await old)?.content, "雪🦊");
  assert.equal((await store.readCanonicalAsync(repo, "items", 1))?.content, "new");
});

test("concurrent tuple changes lose migration CAS without changing export sequence", async () => {
  const { store, storage } = setup();
  store.accept(await plan(), Date.now());
  await activate(store);
  const pass = await store.prepareTieringPass();
  const next = await plan(1, "changed", 2);
  store.accept(next, Date.now(), await store.prepareCanonicalWrites(next.operations));
  const watermark = store.currentExportRevision();
  const result = store.commitTieringPassSync(pass, Date.now());
  assert.equal(result?.conflicts, 1);
  assert.equal(store.currentExportRevision(), watermark);
  assert.equal((await store.readCanonicalAsync(repo, "items", 1))?.content, "changed");
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"), 0);
});

test("upload or object corruption never detaches a source or becomes a missing record", async () => {
  const { store, bucket, storage } = setup();
  store.accept(await plan(), Date.now());
  await activate(store);
  bucket.objects.set(CANONICAL_BODY_PREFIX + hash("雪🦊"), new TextEncoder().encode("bad"));
  await assert.rejects(store.prepareTieringPass(), CanonicalBodyUnavailableError);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"), 3);
  bucket.objects.clear();
  await migrate(store);
  bucket.objects.clear();
  await assert.rejects(store.readCanonicalAsync(repo, "items", 1), CanonicalBodyUnavailableError);
  await assert.rejects(store.exportRecords(exportOptions), CanonicalBodyUnavailableError);
});

test("crash after upload resumes idempotently and SQL failures preserve source/checkpoint", async () => {
  const { store, bucket, storage } = setup();
  store.accept(await plan(), Date.now());
  await activate(store);
  const first = await store.prepareTieringPass();
  storage.failNextSqlMatching(/DELETE FROM exact_review_canonical_records WHERE/);
  assert.throws(() => store.commitTieringPassSync(first, Date.now()));
  assert.equal(store.tieringStatusSync()?.migrated, 0);
  const restarted = new ExactReviewDirectPublicationStore(storage, bucket);
  restarted.ensureSchemaSync();
  await migrate(restarted);
  assert.equal((await restarted.readCanonicalAsync(repo, "items", 1))?.content, "雪🦊");
  assert.equal(restarted.tieringStatusSync()?.migrated, 3);
});

test("coverage and lifetime answered facts survive detachment including stale-source false", async () => {
  const { store } = setup();
  const report = (status: string) =>
    `---\ntype: pull_request\nreview_status: ${status}\nreviewed_at: 2026-10-15T00:00:00Z\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nrepository: example/project\nlabels: []\n---\nreview`;
  store.accept(await plan(1, report("complete"), 1, "guarded_open"), Date.now());
  store.accept(await plan(2, report("complete"), 1, "requeue"), Date.now());
  const now = Date.parse("2026-10-16T00:00:00Z"),
    before = new Map();
  store.reviewCoverageScanPageSync(before, null, 200, now);
  assert.equal(store.hasCompletedPullRequestReview(repo, 1), true);
  assert.equal(store.hasCompletedPullRequestReview(repo, 2), false);
  await activate(store);
  await migrate(store);
  const after = new Map();
  store.reviewCoverageScanPageSync(after, null, 200, now);
  assert.deepEqual(after, before);
  assert.equal(store.hasCompletedPullRequestReview(repo, 1), true);
  assert.equal(store.hasCompletedPullRequestReview(repo, 2), false);
});

test("bounded body reader cancels an extra chunk after exact descriptor length", async () => {
  let cancelled = false;
  const bucket = {
    put: async () => ({}),
    get: async () => ({
      size: 1,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([97]));
          controller.enqueue(new Uint8Array([98]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  };
  await assert.rejects(
    new CanonicalBodyStore(bucket).read({ digest: hash("a"), bytes: 1 }),
    CanonicalBodyUnavailableError,
  );
  assert.equal(cancelled, true);
});

test("export captures all source bodies before awaiting and preserves deletion versus overwrite identity", async () => {
  const { store, bucket } = setup();
  store.accept(await plan(1, "old one"), Date.now());
  store.accept(await plan(2, "old two"), Date.now());
  await activate(store);
  await migrate(store);
  const before = await store.exportRecords(exportOptions);
  let unblock: () => void = () => {},
    entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  bucket.beforeGet = async () => {
    entered();
    await pending;
  };
  const reading = store.exportRecords(exportOptions);
  await started;
  bucket.beforeGet = null;
  const changed = await plan(1, "new one", 2);
  store.accept(changed, Date.now(), await store.prepareCanonicalWrites(changed.operations));
  const deletion = await validateCanonicalRecordTupleMutation({
    deliveryId: "delete-second",
    key: repo + "/2",
    operations: ["items", "closed", "plans", "decision-packets"].map((section) => ({
      path: `records/${repo}/${section}/2.${section === "decision-packets" ? "json" : "md"}`,
      expectedDigest: section === "items" ? hash("old two") : null,
    })),
  });
  store.acceptCanonicalTupleMutation(
    deletion,
    Date.now(),
    await store.prepareCanonicalWrites(deletion.operations),
  );
  unblock();
  assert.deepEqual((await reading).records, before.records);
  assert.equal((await store.readCanonicalAsync(repo, "items", 2))?.deleted, true);
});

test("tuple conflict captures all four external sections coherently, including packet references", async () => {
  const { store } = setup(),
    packet = '{"decision":"keep"}',
    primary = `---\ndecision_packet_path: records/${repo}/decision-packets/1.json\ndecision_packet_sha256: ${hash(packet)}\n---\nreport`;
  const contentBySection: Record<string, string | null> = {
    items: primary,
    closed: null,
    plans: "plan",
    "decision-packets": packet,
  };
  const mutation = await validateCanonicalRecordTupleMutation({
    deliveryId: "four-sections",
    key: repo + "/1",
    operations: Object.entries(contentBySection).map(([section, content]) => ({
      path: `records/${repo}/${section}/1.${section === "decision-packets" ? "json" : "md"}`,
      expectedDigest: null,
      ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
    })),
  });
  store.acceptCanonicalTupleMutation(mutation, Date.now());
  await activate(store);
  await migrate(store);
  let conflict: CanonicalRecordTupleConflictError | undefined;
  try {
    store.acceptCanonicalTupleMutation(
      { ...mutation, deliveryId: "conflict" },
      Date.now(),
      await store.prepareCanonicalWrites(mutation.operations),
    );
  } catch (error) {
    assert.ok(error instanceof CanonicalRecordTupleConflictError);
    conflict = error;
  }
  assert.ok(conflict);
  await store.hydrateTupleConflict(conflict);
  assert.equal(conflict.current?.operations.length, 4);
  for (const operation of conflict.current!.operations) {
    const section = operation.path.split("/")[2]!;
    assert.equal(
      operation.contentBase64 === undefined
        ? null
        : Buffer.from(operation.contentBase64, "base64").toString(),
      contentBySection[section],
    );
  }
});

async function queueFixture() {
  const storage = new TestStorage(),
    bucket = new Bucket(),
    env = {
      STATE_SNAPSHOTS: bucket,
      CLAWSWEEPER_DEPLOY_SHA: sha,
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    };
  const queue = new ExactReviewQueue({ storage }, env);
  await queue.fetch(new Request("http://queue/admission-capabilities", { method: "POST" }));
  const store = new ExactReviewDirectPublicationStore(storage, bucket);
  return { storage, bucket, queue, store };
}

test("canonical maintenance logs bounded failure stages and preserves thrown failures", async (t) => {
  const events: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => events.push(values));
  const trace = "12345678-1234-4123-8123-123456789abc";
  for (const phase of ["plan", "prepare", "commit"] as const) {
    const { storage, bucket, queue, store } = await queueFixture();
    store.accept(await plan(), Date.now());
    const preview = await store.tieringPreview(sha, gates);
    store.activateTieringSync(preview, Date.now());
    const before = store.tieringStatusSync();
    if (phase === "prepare")
      t.mock.method(bucket, "put", async () => {
        throw new Error("private-bucket-sentinel https://private.example.test/token");
      });
    if (phase === "commit")
      storage.failNextSqlMatching(/UPDATE exact_review_canonical_body_tiering SET after_rowid/);
    events.length = 0;
    await assert.rejects(
      queue.fetch(
        new Request("https://queue/canonical-bodies/maintenance", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-trace": trace,
          },
          body: JSON.stringify({
            action: "migrate",
            execute: true,
            expectedDeploymentSha: sha,
            reviewedPreviewSha256: preview.sha256,
            attestation: phase === "plan" ? { private: "private-plan-sentinel" } : gates,
          }),
        }),
      ),
      phase === "prepare" ? CanonicalBodyUnavailableError : Error,
    );
    assert.deepEqual(events[0], [
      "canonical_tiering_failed",
      {
        phase,
        trace_id: trace,
        failure_category: phase === "prepare" ? "body_unavailable" : "handler_exception",
      },
    ]);
    assert.equal(events[1]?.[0], "exact_review_queue_handler_failed");
    assert.doesNotMatch(JSON.stringify(events), /private-|token|https:/);
    assert.deepEqual(store.tieringStatusSync(), before);
    assert.equal(store.readCanonical(repo, "items", 1)?.content, "雪🦊");
  }
});
async function seedLease(storage: TestStorage, id: number, batch = false) {
  const key = `example/project#${id}`,
    now = Date.now(),
    decision = {
      targetRepo: "example/project",
      targetBranch: "main",
      itemNumber: id,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
    };
  const item = {
    key,
    decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: 1,
    createdAt: now - 60000,
    updatedAt: now - 60000,
    nextAttemptAt: now - 60000,
    attempts: 0,
    leaseId: "lease-" + id,
    leaseRevision: 1,
    leaseExpiresAt: now + 3600000,
    claimedRunId: String(1000 + id),
    claimedRunAttempt: 1,
    claimGeneration: 1,
    claimProtocolVersion: 2,
  };
  storage.run(
    "INSERT INTO exact_review_queue_items(item_key,item_json) VALUES(?,?)",
    key,
    JSON.stringify(item),
  );
  if (!batch) return { leaseId: item.leaseId, runId: item.claimedRunId, runAttempt: 1 };
  const batches = new ExactReviewPublicationBatchStore(storage);
  batches.ensureSchemaSync();
  batches.claim({
    batchId: "batch-" + id,
    leaseOwner: "worker-" + id,
    leaseExpiresAt: now + 3600000,
    now,
    maxItems: 1,
    runner: { runId: item.claimedRunId, runAttempt: 1, startedAt: now },
    candidates: [{ itemKey: key, revision: 1 }],
  });
  return {
    batchId: "batch-" + id,
    leaseOwner: "worker-" + id,
    runId: item.claimedRunId,
    runAttempt: 1,
  };
}

test("queue rechecks lease cancellation, expiry, generation and batch ownership after final R2 await", async () => {
  for (const fault of ["expire", "cancel", "generation", "batch"]) {
    const { storage, bucket, queue, store } = await queueFixture();
    await activate(store);
    const owner = await seedLease(storage, 90, fault === "batch");
    const publication = {
      ...(await plan(90)),
      fenceKey: "example/project#90",
      identity: {
        canonicalTargetKey: "example/project#90",
        fenceKey: "example/project#90",
        revision: 1,
        claimGeneration: 1,
      },
      owner,
      sourceSha: "b".repeat(40),
    };
    bucket.beforeGet = async () => {
      bucket.beforeGet = null;
      if (fault === "expire")
        storage.run(
          "UPDATE exact_review_queue_items SET item_json=json_set(item_json,'$.leaseExpiresAt',?)",
          Date.now() - 1,
        );
      else if (fault === "cancel") storage.run("DELETE FROM exact_review_queue_items");
      else if (fault === "generation")
        storage.run(
          "UPDATE exact_review_queue_items SET item_json=json_set(item_json,'$.claimGeneration',99)",
        );
      else
        storage.run(
          "UPDATE exact_review_publication_batches SET lease_expires_at=?",
          Date.now() - 1,
        );
    };
    const response = await queue.fetch(
      new Request(
        "http://queue/" + (fault === "batch" ? "publication-batch-results" : "publication-results"),
        { method: "POST", body: JSON.stringify(publication) },
      ),
    );
    assert.equal(response.status, 409, fault);
    assert.equal(store.currentExportRevision(), 0);
    assert.equal(store.count(), 0);
    assert.equal(
      storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records_v2"),
      0,
    );
  }
});

test("stable reviewed plan survives progress and publications but rejects substituted evidence", async () => {
  const { store } = setup();
  const preview = await store.tieringPreview(sha, gates);
  store.accept(await plan(), Date.now());
  assert.equal((await store.tieringPreview(sha, gates)).sha256, preview.sha256);
  store.activateTieringSync(preview, Date.now());
  await migrate(store);
  assert.equal((await store.tieringPreview(sha, gates)).sha256, preview.sha256);
  await assert.rejects(
    store.tieringPreview(sha, { ...gates, operator: "other-operator" }),
    /approved plan changed/,
  );
  await assert.rejects(
    store.tieringPreview(sha, {
      ...gates,
      rollbackFloor: { ...gates.rollbackFloor, sha: "b".repeat(40) },
    }),
    /rollback floor/,
  );
});
test("lifecycle evidence is named, canonical and compared with current read-only policy", async () => {
  const safe = {
    rules: [
      {
        id: "snapshots",
        enabled: true,
        conditions: { prefix: "snapshots/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 3600 } },
      },
    ],
  };
  const attestation = {
    ...gates,
    bucketLifecycle: { ...gates.bucketLifecycle, rulesJson: JSON.stringify(safe) },
  };
  let requests = 0;
  await verifyCanonicalBodyLifecycle(
    attestation,
    "a".repeat(32),
    "synthetic-token",
    async (input) => {
      requests++;
      assert.equal(
        String(input),
        "https://api.cloudflare.com/client/v4/accounts/" +
          "a".repeat(32) +
          "/r2/buckets/clawsweeper-state-snapshots/lifecycle",
      );
      return Response.json({
        success: true,
        result: {
          rules: [
            {
              conditions: { prefix: "snapshots/" },
              enabled: true,
              id: "snapshots",
              deleteObjectsTransition: { condition: { maxAge: 3600, type: "Age" } },
            },
          ],
        },
      });
    },
  );
  assert.equal(requests, 1);
  await assert.rejects(
    verifyCanonicalBodyLifecycle(attestation, "a".repeat(32), "synthetic-token", async () =>
      Response.json({ success: true, result: { rules: [] } }),
    ),
    /differs/,
  );
  for (const prefix of ["", "records/", "records/bodies/v1/sha256/a"])
    assert.throws(
      () =>
        canonicalBodyLifecycleRules({
          rules: [
            { id: "unsafe", enabled: true, conditions: { prefix }, deleteObjectsTransition: {} },
          ],
        }),
      /must not expire/,
    );
});
test("inline coverage preserves SQLite code-point and NUL prefixes", async () => {
  const prefix = "---\nreview_status: complete\nreviewed_at: 2026-10-15T00:00:00Z\n",
    tail = "🦊".repeat(30) + "\nrepository: example/project\n";
  for (const content of [
    prefix + "#".repeat(4090 - Array.from(prefix + tail).length) + tail + "---\nbody",
    "---\n\0\nrepository: example/project\nreview_status: complete\nreviewed_at: 2026-10-15T00:00:00Z\n---\nbody",
  ]) {
    const { store } = setup();
    store.accept(await plan(1, content), Date.now());
    const now = Date.parse("2026-10-16T00:00:00Z"),
      before = new Map();
    store.reviewCoverageScanPageSync(before, null, 200, now);
    assert.equal(before.size, 1);
    await activate(store);
    await migrate(store);
    const after = new Map();
    store.reviewCoverageScanPageSync(after, null, 200, now);
    assert.deepEqual(after, before);
  }
});

test("accepted direct and refreshed batch retries resume without unused R2 reads", async () => {
  for (const batch of [false, true]) {
    const { storage, bucket, queue, store } = await queueFixture();
    await activate(store);
    const owner = await seedLease(storage, 91, batch);
    const make = async (content: string) => ({
      ...(await plan(91, content)),
      fenceKey: "example/project#91",
      identity: {
        canonicalTargetKey: "example/project#91",
        fenceKey: "example/project#91",
        revision: 1,
        claimGeneration: 1,
      },
      owner,
      sourceSha: "b".repeat(40),
    });
    const route = "http://queue/" + (batch ? "publication-batch-results" : "publication-results"),
      send = async (content: string) =>
        queue.fetch(
          new Request(route, { method: "POST", body: JSON.stringify(await make(content)) }),
        );
    assert.equal((await send("accepted body")).status, 202);
    const gets = bucket.gets,
      puts = bucket.puts;
    bucket.beforeGet = async () => {
      throw Error("synthetic R2 outage");
    };
    const retry = await send(batch ? "regenerated apply metadata" : "accepted body");
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).deduped, true);
    assert.equal(bucket.gets, gets);
    assert.equal(bucket.puts, puts);
    if (!batch) assert.equal((await send("changed direct plan")).status, 400);
  }
});
test("body preparation and accept agree at the terminal receipt retention boundary", async () => {
  const { store } = setup(),
    publication = await plan(),
    created = Date.now() - 8 * 24 * 60 * 60 * 1000,
    deadline = created + 7 * 24 * 60 * 60 * 1000;
  store.accept(publication, created);
  await activate(store);
  await migrate(store);
  assert.equal(store.publicationNeedsBodiesSync(publication, deadline - 1), false);
  assert.equal(store.publicationNeedsBodiesSync(publication, deadline), true);
  const prepared = await store.prepareCanonicalWrites(publication.operations),
    before = store.currentExportRevision();
  assert.equal(store.accept(publication, deadline, prepared).outcome, "accepted");
  assert.ok(store.currentExportRevision() > before);
});

test("accepted tuple retries and payload conflicts retain receipt authority during R2 outage", async () => {
  const { store, bucket, queue } = await queueFixture();
  await activate(store);
  const mutation = {
    deliveryId: "accepted-tuple",
    key: repo + "/92",
    operations: ["items", "closed", "plans", "decision-packets"].map((section) => ({
      path: `records/${repo}/${section}/92.${section === "decision-packets" ? "json" : "md"}`,
      expectedDigest: null,
      ...(section === "items"
        ? { contentBase64: Buffer.from("accepted tuple body").toString("base64") }
        : {}),
    })),
  };
  const send = (value: unknown) =>
    queue.fetch(
      new Request("http://queue/records/tuples", {
        method: "POST",
        body: JSON.stringify(value),
      }),
    );
  assert.equal((await send(mutation)).status, 202);
  const gets = bucket.gets,
    puts = bucket.puts,
    watermark = store.currentExportRevision();
  bucket.beforeGet = async () => {
    throw Error("synthetic R2 outage");
  };
  const retry = await send(mutation);
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).deduped, true);
  const changed = structuredClone(mutation);
  changed.operations[0]!.contentBase64 = Buffer.from("changed tuple body").toString("base64");
  const conflict = await send(changed);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "canonical_record_tuple_conflict");
  assert.equal(bucket.gets, gets);
  assert.equal(bucket.puts, puts);
  assert.equal(store.currentExportRevision(), watermark);
});

test("tuple body preparation follows the exact bounded receipt prune set", async () => {
  const { store, storage } = setup();
  const mutation = await validateCanonicalRecordTupleMutation({
    deliveryId: "retention-tuple",
    key: repo + "/93",
    operations: ["items", "closed", "plans", "decision-packets"].map((section) => ({
      path: `records/${repo}/${section}/93.${section === "decision-packets" ? "json" : "md"}`,
      expectedDigest: null,
      ...(section === "items"
        ? { contentBase64: Buffer.from("receipt body").toString("base64") }
        : {}),
    })),
  });
  const created = Date.now() - 8 * 24 * 60 * 60 * 1000,
    deadline = created + 7 * 24 * 60 * 60 * 1000;
  store.acceptCanonicalTupleMutation(mutation, created);
  assert.equal(store.tupleMutationNeedsBodiesSync(mutation, deadline - 1), false);
  assert.equal(store.tupleMutationNeedsBodiesSync(mutation, deadline), true);
  for (let i = 0; i < 256; i++)
    storage.sql.exec(
      "INSERT INTO canonical_record_tuple_receipts (delivery_id,fingerprint,revision,sequence,received_at) VALUES (?,?,?,?,?)",
      "older-" + i,
      hash("test"),
      1,
      1,
      created - 1,
    );
  assert.equal(store.tupleMutationNeedsBodiesSync(mutation, deadline), false);
  assert.equal(store.acceptCanonicalTupleMutation(mutation, deadline).outcome, "deduped");
  assert.equal(store.tupleMutationNeedsBodiesSync(mutation, deadline), true);
});

test("migration preserves backfill-only siblings and refuses changed or invalid export ownership", async () => {
  for (const scenario of ["unchanged", "changed", "invalid-canonical"] as const) {
    const { store, storage } = setup();
    store.accept(await plan(), Date.now());
    const content = '{ "decision": "backfill-only sibling 雪" }',
      digest = hash(content),
      now = Date.now();
    storage.sql.exec(
      "INSERT INTO exact_review_record_backfill (repo_slug,section,record_id,content,digest,byte_length,chunk_count,updated_at) VALUES (?, 'plans', '1', ?, ?, ?, 0, ?)",
      repo,
      content,
      digest,
      Buffer.byteLength(content),
      now,
    );
    storage.sql.exec(
      "UPDATE exact_review_record_export_meta SET current_revision=current_revision+1 WHERE singleton_id=1",
    );
    storage.sql.exec(
      "INSERT INTO exact_review_record_export_index (repo_slug,section,record_id,digest,deleted,revision,store_revision,source,updated_at) VALUES (?, 'plans', '1', ?, 0, 1, ?, ?, ?)",
      repo,
      digest,
      store.currentExportRevision(),
      scenario === "invalid-canonical" ? "canonical" : "backfill",
      now,
    );
    const backfill = [...storage.sql.exec("SELECT * FROM exact_review_record_backfill")],
      exports = [
        ...storage.sql.exec("SELECT * FROM exact_review_record_export_index ORDER BY section"),
      ],
      watermark = store.currentExportRevision(),
      before = scenario === "invalid-canonical" ? null : await store.exportRecords(exportOptions);
    await activate(store);
    const pass = await store.prepareTieringPass();
    if (scenario === "changed")
      storage.sql.exec(
        "UPDATE exact_review_record_export_index SET updated_at=updated_at+1 WHERE section='plans'",
      );
    const result = store.commitTieringPassSync(pass, Date.now());
    if (scenario !== "unchanged") {
      assert.equal(result?.conflicts, 1);
      assert.equal(result?.completed_at, null);
      assert.equal(
        storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"),
        3,
      );
      assert.equal(
        storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records_v2"),
        0,
      );
      assert.deepEqual(
        [...storage.sql.exec("SELECT * FROM exact_review_record_backfill")],
        backfill,
      );
      assert.equal(store.currentExportRevision(), watermark);
      continue;
    }
    assert.ok(result?.completed_at);
    assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records"), 0);
    assert.equal(
      storage.scalar("SELECT COUNT(*) AS value FROM exact_review_canonical_records_v2"),
      3,
    );
    assert.deepEqual([...storage.sql.exec("SELECT * FROM exact_review_record_backfill")], backfill);
    assert.deepEqual(
      [...storage.sql.exec("SELECT * FROM exact_review_record_export_index ORDER BY section")],
      exports,
    );
    assert.equal(store.currentExportRevision(), watermark);
    assert.deepEqual(await store.exportRecords(exportOptions), before);
  }
});
