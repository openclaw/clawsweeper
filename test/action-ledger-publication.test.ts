import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import worker from "../dashboard/worker.ts";
import { actionEventPublicationPaths } from "../src/action-ledger-import.ts";
import {
  actionEventShardRelativePath,
  actionLedgerJson,
  readActionEventShardAt,
  writeActionEventShard,
} from "../src/action-ledger.ts";
import { publishStateBlob } from "../src/state-blob-client.ts";
import { materializeStateBlobs } from "../scripts/worker-blobs.ts";
import { LedgerBucket, ledgerImportFixture } from "./action-ledger-import-fixture.ts";

const secret = "synthetic-ledger-publication";
const baseUrl = "https://worker.example";

test("canonical writer, publisher, Worker and hydrator preserve closed imports and identical replay", async (t) => {
  const root = temp(t);
  const fixture = ledgerImportFixture(root, 1, 1025);
  const bucket = new LedgerBucket();
  const options = { baseUrl, webhookSecret: secret, fetchImpl: transport(bucket) };
  const order = actionEventPublicationPaths(fixture.destination, fixture.paths);
  assert.deepEqual(order, [
    ...fixture.reservationPaths,
    ...fixture.eventPaths,
    ...fixture.completionPaths,
  ]);
  for (const relativePath of order)
    await publishStateBlob({
      ...options,
      path: relativePath,
      content: fixture.blobs.get(relativePath)!,
    });
  const target = path.join(root, "hydrated");
  const result = await materializeStateBlobs({
    ...options,
    fetch: options.fetchImpl,
    worktreeRoot: target,
  });
  assert.equal(result.omittedProducers, 0);
  assert.equal(
    fixture.eventPaths.flatMap((entry) => readActionEventShardAt(target, entry)).length,
    1025,
  );
  for (const relativePath of order)
    assert.equal(
      (
        await publishStateBlob({
          ...options,
          path: relativePath,
          content: fixture.blobs.get(relativePath)!,
        })
      ).unchanged,
      true,
    );
  assert.equal(bucket.objects.size, fixture.paths.length);
});

test("interrupted producers are explicitly omitted without blocking healthy or direct legacy shards", async (t) => {
  const root = temp(t);
  const first = ledgerImportFixture(root, 1, 1025);
  const second = ledgerImportFixture(root, 2);
  const healthy = ledgerImportFixture(root, 3);
  const legacy = ledgerImportFixture(root, 4);
  const bucket = new LedgerBucket();
  for (const fixture of [first, second]) {
    for (const key of [...fixture.reservationPaths, fixture.eventPaths[0]!])
      bucket.seed(key, fixture.blobs.get(key)!);
  }
  for (const [key, bytes] of healthy.blobs) bucket.seed(key, bytes);
  for (const key of legacy.eventPaths) bucket.seed(key, legacy.blobs.get(key)!);
  const before = bucket.objects.size;
  const target = path.join(root, "hydrated");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...values: unknown[]) => warnings.push(values.join(" ")));
  const options = {
    baseUrl,
    webhookSecret: secret,
    fetch: transport(bucket),
    worktreeRoot: target,
  };
  const result = await materializeStateBlobs(options);
  assert.equal(result.omittedProducers, 2);
  assert.equal(result.omittedPayloads, 2);
  assert.equal(result.materializedBlobs, result.blobs - 2);
  assert.equal(
    result.materializedBytes,
    result.bytes -
      first.blobs.get(first.eventPaths[0]!)!.byteLength -
      second.blobs.get(second.eventPaths[0]!)!.byteLength,
  );
  assert.equal(warnings.length, 1);
  for (const fixture of [first, second]) {
    assert.equal(existsSync(path.join(target, fixture.eventPaths[0]!)), false);
    for (const key of fixture.reservationPaths)
      assert.equal(existsSync(path.join(target, key)), true);
  }
  for (const fixture of [healthy, legacy])
    assert.equal(readActionEventShardAt(target, fixture.eventPaths[0]!).length, 1);
  assert.equal(bucket.objects.size, before);
  for (const [key, bytes] of first.blobs) bucket.seed(key, bytes);
  for (const [key, bytes] of second.blobs) bucket.seed(key, bytes);
  assert.equal((await materializeStateBlobs(options)).omittedProducers, 0);
  assert.equal(first.eventPaths.flatMap((key) => readActionEventShardAt(target, key)).length, 1025);
});

test("completed closure fills payloads and bindings missing from a listing, including subset marker discovery", async (t) => {
  const root = temp(t);
  const fixture = ledgerImportFixture(root, 1, 1025);
  const bucket = new LedgerBucket();
  for (const [key, bytes] of fixture.blobs) bucket.seed(key, bytes);
  bucket.hidden = new Set([fixture.eventPaths[1]!, ...fixture.reservationPaths]);
  const fetch = transport(bucket);
  const target = path.join(root, "hydrated");
  const result = await materializeStateBlobs({
    baseUrl,
    webhookSecret: secret,
    fetch,
    worktreeRoot: target,
  });
  assert.equal(result.omittedProducers, 0);
  assert.equal(result.closureBlobs, bucket.hidden.size);
  assert.equal(result.blobs, fixture.paths.length);
  for (const key of fixture.paths) assert.equal(existsSync(path.join(target, key)), true);
  assert.equal(
    fixture.eventPaths.flatMap((key) => readActionEventShardAt(target, key)).length,
    1025,
  );
  bucket.hidden = new Set([...fixture.eventPaths, ...fixture.reservationPaths]);
  const completionOnly = path.join(root, "completion-only");
  await materializeStateBlobs({
    baseUrl,
    webhookSecret: secret,
    fetch,
    worktreeRoot: completionOnly,
  });
  assert.equal(
    fixture.eventPaths.flatMap((key) => readActionEventShardAt(completionOnly, key)).length,
    1025,
  );
  bucket.hidden = new Set([fixture.eventPaths[1]!, ...fixture.reservationPaths]);
  const subset = path.join(root, "subset");
  await materializeStateBlobs({
    baseUrl,
    webhookSecret: secret,
    fetch,
    worktreeRoot: subset,
    trees: ["ledger/v1/events"],
  });
  for (const key of fixture.paths) assert.equal(existsSync(path.join(subset, key)), true);
});

test("late completion is point-read before omission; completion after authoritative 404 arrives next hydration", async (t) => {
  for (const arrivesBefore of [true, false]) {
    const root = temp(t);
    const fixture = ledgerImportFixture(root);
    const bucket = new LedgerBucket();
    for (const [key, bytes] of fixture.blobs)
      if (!fixture.completionPaths.includes(key)) bucket.seed(key, bytes);
    const completion = fixture.completionPaths[0]!;
    let intercepted = false;
    const base = transport(bucket);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (!intercepted && String(input).endsWith("/stat") && body.path === completion) {
        intercepted = true;
        if (arrivesBefore) bucket.seed(completion, fixture.blobs.get(completion)!);
        const response = await base(input, init);
        if (!arrivesBefore) bucket.seed(completion, fixture.blobs.get(completion)!);
        return response;
      }
      return base(input, init);
    };
    const options = {
      baseUrl,
      webhookSecret: secret,
      fetch,
      worktreeRoot: path.join(root, "hydrated"),
    };
    t.mock.method(console, "warn", () => {});
    assert.equal((await materializeStateBlobs(options)).omittedProducers, arrivesBefore ? 0 : 1);
    assert.equal((await materializeStateBlobs(options)).omittedProducers, 0);
    assert.equal(readActionEventShardAt(options.worktreeRoot, fixture.eventPaths[0]!).length, 1);
  }
});

test("missing committed members, extra same-producer shards, and transport failures preserve the previous tree", async (t) => {
  const root = temp(t);
  const fixture = ledgerImportFixture(root, 1, 1025);
  for (const failure of [
    "missing-payload",
    "extra-payload",
    "unauthorized",
    "unavailable",
    "foreign-reservation",
    "completion-digest",
  ] as const) {
    const bucket = new LedgerBucket();
    for (const [key, bytes] of fixture.blobs) bucket.seed(key, bytes);
    if (failure === "missing-payload") bucket.objects.delete(fixture.eventPaths[1]!);
    if (failure === "extra-payload") {
      writeActionEventShard(fixture.destination, fixture.identity, [fixture.events[0]!]);
      const key = actionEventShardRelativePath(fixture.identity, [fixture.events[0]!]);
      bucket.seed(key, readFileSync(path.join(fixture.destination, key)));
    }
    if (failure === "foreign-reservation") {
      const foreign = ledgerImportFixture(root, 2);
      const key = fixture.reservationPaths.find((entry) => entry.includes("/shard-sets/"))!;
      const content = JSON.parse(fixture.blobs.get(key)!.toString());
      content.shards[0].path = foreign.eventPaths[0];
      bucket.seed(key, Buffer.from(`${actionLedgerJson(content)}\n`));
      bucket.objects.delete(fixture.completionPaths[0]!);
    }
    if (failure === "completion-digest") {
      const key = fixture.completionPaths[0]!;
      const value = JSON.parse(fixture.blobs.get(key)!.toString());
      value.reservation_sha256 = "b".repeat(64);
      bucket.seed(key, Buffer.from(`${actionLedgerJson(value)}\n`));
    }
    const base = transport(bucket);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("/stat") && body.path === fixture.completionPaths[0]) {
        return Response.json(
          { error: failure === "unauthorized" ? "invalid_signature" : "blob_store_unavailable" },
          { status: failure === "unauthorized" ? 401 : 503 },
        );
      }
      return base(input, init);
    };
    if (failure === "unauthorized" || failure === "unavailable")
      bucket.hidden.add(fixture.completionPaths[0]!);
    const target = path.join(root, `hydrated-${failure}`);
    mkdirSync(path.join(target, "ledger"), { recursive: true });
    writeFileSync(path.join(target, "ledger", "previous"), "previous");
    mkdirSync(path.join(target, ".artifacts"));
    writeFileSync(
      path.join(target, ".artifacts", "worker-blobs-manifest.json"),
      "previous manifest",
    );
    await assert.rejects(
      materializeStateBlobs({ baseUrl, webhookSecret: secret, fetch, worktreeRoot: target }),
    );
    assert.equal(readFileSync(path.join(target, "ledger", "previous"), "utf8"), "previous");
    assert.equal(
      readFileSync(path.join(target, ".artifacts", "worker-blobs-manifest.json"), "utf8"),
      "previous manifest",
    );
  }
});

function temp(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ledger-publication-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function transport(bucket: LedgerBucket): typeof globalThis.fetch {
  return async (input, init) =>
    worker.fetch(new Request(String(input), init), {
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      STATE_SNAPSHOTS: bucket,
    });
}
