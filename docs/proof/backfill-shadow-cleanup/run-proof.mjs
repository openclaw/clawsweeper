import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "backfill-shadow-proof-"));
mkdirSync(path.join(root, "home"));
const nonce = randomUUID();
const now = Date.parse("2026-10-14T00:00:00Z");
const baseline = "b4cc911db6ed4a995d99f4fc7cc1eeb5492a4051";
const proofPath = "docs/proof/backfill-shadow-cleanup";
const candidateConfig = path.resolve(proofPath, "wrangler.toml");
let child;
let ownedProcesses = new Map();
let diagnostics = "";
let baseUrl;

function groupMembers() {
  const rows = execFileSync("ps", ["-axo", "pid=,pgid=,lstart=,stat=,comm="], {
    encoding: "utf8",
  });
  return rows
    .trim()
    .split("\n")
    .map((line) =>
      line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/),
    )
    .filter((row) => row && Number(row[2]) === child.pid && !row[4].startsWith("Z"))
    .map((row) => ({ pid: Number(row[1]), identity: row[3] }));
}

function ownedMembers() {
  const members = groupMembers();
  const leader = members.find((member) => member.pid === child.pid);
  const knownLeader = ownedProcesses.get(child.pid);
  // A live, unchanged group leader admits its descendants. After it exits,
  // require previously recorded identities before signaling any survivor.
  const anchored = leader && (!knownLeader || knownLeader === leader.identity);
  for (const member of members) {
    const known = ownedProcesses.get(member.pid);
    assert.ok(
      known === member.identity || (anchored && known === undefined),
      "process-group ownership changed; retaining proof storage",
    );
    ownedProcesses.set(member.pid, member.identity);
  }
  return members;
}

async function stop() {
  if (!child?.pid) return;
  const signal = (members, name) => {
    for (const member of members) {
      // Recheck immediately before signaling; never signal a reused PID.
      if (!ownedMembers().some((current) => current.pid === member.pid)) continue;
      try {
        process.kill(member.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  for (let attempt = 0; attempt < 120; attempt++) {
    const members = ownedMembers();
    if (members.length === 0) {
      child = null;
      ownedProcesses = new Map();
      return;
    }
    if (attempt === 0 || attempt >= 100) signal(members, attempt < 100 ? "SIGTERM" : "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("owned Worker process group did not exit; retaining proof storage");
}

async function start(config = candidateConfig) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(
    process.env.WRANGLER_BIN || "wrangler",
    [
      "dev",
      "--config",
      config,
      "--local",
      "--persist-to",
      path.join(root, "state"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--var",
      `PROOF_NONCE:${nonce}`,
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  child.on("error", (error) => {
    diagnostics += String(error);
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4000);
    });
  for (let attempt = 0; attempt < 120; attempt++) {
    ownedMembers();
    if (child.exitCode !== null) throw new Error(`local Worker exited: ${diagnostics}`);
    try {
      const response = await fetch(`${baseUrl}/ready`, {
        headers: { "x-proof-nonce": nonce },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`local Worker startup timed out: ${diagnostics}`);
}

function archivedFixture(revision, name) {
  const archive = execFileSync(
    "git",
    ["archive", "--format=tar", revision, "dashboard", "src", "config", "package.json"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const entries = execFileSync("tar", ["-tvf", "-"], { input: archive, encoding: "utf8" })
    .trim()
    .split("\n");
  assert.ok(
    entries.every((entry) => ["-", "d"].includes(entry[0])),
    "baseline archive contains only files/directories",
  );
  const baselineRoot = path.join(root, name);
  mkdirSync(baselineRoot);
  execFileSync("tar", ["-xf", "-", "-C", baselineRoot], { input: archive });
  const fixtureRoot = path.join(baselineRoot, proofPath);
  mkdirSync(fixtureRoot, { recursive: true });
  for (const file of ["worker.ts", "wrangler.toml"])
    copyFileSync(path.join(proofPath, file), path.join(fixtureRoot, file));
  return { archive, config: path.join(fixtureRoot, "wrangler.toml") };
}

async function call(object, route, body = {}) {
  const response = await fetch(`${baseUrl}/${object}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proof-nonce": nonce },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${object}${route}: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const inspect = (object, full = false) => call(object, "/__proof/inspect", { full });
const sql = (object, statements) =>
  call(object, "/__proof/sql", {
    statements: statements.map(([sql, ...bindings]) => ({ sql, bindings })),
  });
async function view(object, sinceRevision = 0) {
  const pages = [];
  let cursor = 0;
  do {
    const page = await call(object, "/records/export", {
      repoSlug: "example-project",
      limit: 11,
      cursor,
      sinceRevision,
    });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}
async function snapshot(object) {
  const { snapshot } = await call(object, "/records/snapshots/trigger", {
    repoSlug: "example-project",
  });
  const response = await fetch(`${baseUrl}/${object}/records/snapshots/chunk`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proof-nonce": nonce },
    body: JSON.stringify({
      repoSlug: "example-project",
      revisionWatermark: snapshot.revisionWatermark,
      offset: 0,
      length: snapshot.bytes,
    }),
  });
  assert.equal(response.status, 206);
  return {
    revision: snapshot.revisionWatermark,
    count: snapshot.fileCount,
    hash: createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex"),
  };
}
async function waitComplete(object) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await inspect(object);
    if (value.state?.completedAt !== null && value.state !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`automatic cleanup did not finish: ${object}`);
}
const tuple = (deliveryId, id, content, expectedDigest = null) => ({
  deliveryId,
  key: `example-project/${id}`,
  operations: [
    {
      path: `records/example-project/items/${id}.md`,
      expectedDigest,
      contentBase64: Buffer.from(content).toString("base64"),
    },
    ...["closed", "plans"].map((section) => ({
      path: `records/example-project/${section}/${id}.md`,
      expectedDigest: null,
    })),
    { path: `records/example-project/decision-packets/${id}.json`, expectedDigest: null },
  ],
});

let failure;
let report;
try {
  const archived = archivedFixture(baseline, "baseline");
  await start(archived.config);
  for (const object of ["global", "worst", "empty"]) {
    await call(object, "/admission-capabilities");
    await call(object, "/__proof/pause");
  }
  await call("global", "/__proof/seed", { start: 1, count: 70 });
  await call("global", "/__proof/seed", { slug: "held-project", start: 1, count: 5 });
  await call("global", "/__proof/held");
  await sql("global", [
    [
      "UPDATE exact_review_record_export_index SET revision = revision + 1 WHERE repo_slug = 'held-project' AND record_id = '2'",
    ],
    [
      "UPDATE exact_review_record_export_index SET digest = ? WHERE repo_slug = 'held-project' AND section = 'items' AND record_id = '3'",
      "f".repeat(64),
    ],
    ["DELETE FROM exact_review_canonical_records WHERE repo_slug = 'held-project' AND item_id = 4"],
    [
      "UPDATE exact_review_canonical_records SET deleted = 1, content = NULL, digest = NULL, byte_length = 0, chunk_count = 0 WHERE repo_slug = 'held-project' AND item_id = 5",
    ],
    [
      "UPDATE exact_review_canonical_records SET deleted = 1, content = NULL, digest = NULL, byte_length = 0, chunk_count = 0 WHERE repo_slug = 'example-project' AND item_id = 2",
    ],
    [
      "DELETE FROM exact_review_canonical_record_chunks WHERE repo_slug = 'example-project' AND item_id = 2",
    ],
    [
      "UPDATE exact_review_record_export_index SET deleted = 1, digest = NULL WHERE repo_slug = 'example-project' AND record_id = '2'",
    ],
  ]);
  const queued = {
    delivery_id: "proof-queue",
    decision: {
      targetRepo: "example/project",
      targetBranch: "main",
      itemNumber: 999,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
    },
  };
  assert.equal((await call("global", "/enqueue", queued)).queued, true);
  const initialTuple = tuple("proof-tuple", 999, "retained canonical tuple\n");
  assert.equal((await call("global", "/records/tuples", initialTuple)).accepted, true);
  // Commit each maximum-sized record in its own request: fixture setup must
  // release request-scoped binding buffers instead of retaining a whole batch.
  for (let start = 1000; start < 1064; start++)
    await call("worst", "/__proof/seed", { start, count: 1, size: 2 * 1024 * 1024 });
  await call("empty", "/__proof/seed", { start: 1, count: 65 });
  const before = await inspect("global", true);
  assert.equal(before.state, null);
  assert.ok(before.protected.exact_review_queue_items.length > 0);
  assert.ok(before.protected.exact_review_queue_deliveries.length > 0);
  assert.ok(before.protected.canonical_record_tuple_receipts.length > 0);
  assert.ok(before.protected.exact_review_lifecycle_projection_v1.length > 0);
  const beforeView = await view("global");
  const beforeDelta = await view("global", 30);
  const beforeSnapshot = await snapshot("global");
  const worstBefore = await inspect("worst");
  assert.equal(worstBefore.logicalBytes, 64 * 2 * 1024 * 1024);
  assert.equal(worstBefore.outbound, 0);
  assert.equal((await inspect("global")).outbound, 0);
  await stop();
  await start();
  assert.deepEqual((await inspect("global", true)).protected, before.protected);
  await call("global", "/admission-capabilities");
  const initialized = await inspect("global", true);
  assert.equal(initialized.state.upperRowid, 79);
  assert.equal(initialized.state.afterRowid, 0);
  assert.deepEqual(initialized.protected, before.protected);
  assert.match(
    (await call("global", "/__proof/pass", { fail: true })).error,
    /proof checkpoint failure/,
  );
  const rolledBack = await inspect("global", true);
  assert.deepEqual(rolledBack.metadata, initialized.metadata);
  assert.deepEqual(rolledBack.chunks, initialized.chunks);
  assert.deepEqual(rolledBack.state, initialized.state);
  assert.deepEqual(rolledBack.protected, initialized.protected);
  await call("global", "/__proof/pass");
  const checkpoint = (await inspect("global")).state;
  assert.equal(checkpoint.scanned, 64);
  assert.equal(checkpoint.completedAt, null);
  assert.equal((await inspect("global")).outbound, 0);
  await stop();
  await start();
  await call("global", "/admission-capabilities");
  assert.deepEqual((await inspect("global")).state, checkpoint);
  await call("global", "/__proof/enable");
  const complete = await waitComplete("global");
  assert.equal(complete.state.scanned, 79);
  assert.equal(complete.state.retired, 70);
  assert.equal(complete.state.retiredBytes, 70 * 64);
  assert.equal(complete.metadata.length, 9);
  assert.ok(complete.passes.every((pass) => pass.after.scanned - pass.before.scanned <= 64));
  assert.ok(complete.nextAlarm > Date.now(), "future queued work retains an alarm after cleanup");
  assert.deepEqual((await inspect("global", true)).protected, before.protected);
  assert.deepEqual(await view("global"), beforeView);
  assert.deepEqual(await view("global", 30), beforeDelta);
  assert.deepEqual(await snapshot("global"), beforeSnapshot);
  assert.equal((await call("global", "/enqueue", queued)).deduped, true);
  assert.equal((await call("global", "/records/tuples", initialTuple)).deduped, true);
  // A fresh tuple write must retire its shadow immediately, after sweep completion.
  await sql("global", [
    [
      "INSERT INTO exact_review_record_backfill VALUES ('example-project', 'items', '999', 'old', ?, 3, 0, 1)",
      "f".repeat(64),
    ],
  ]);
  const expectedDigest = createHash("sha256").update("retained canonical tuple\n").digest("hex");
  assert.equal(
    (
      await call(
        "global",
        "/records/tuples",
        tuple("replacement-tuple", 999, "new canonical tuple\n", expectedDigest),
      )
    ).accepted,
    true,
  );
  assert.equal(
    (await inspect("global")).metadata.some((row) => row.record_id === "999"),
    false,
  );
  await call("worst", "/admission-capabilities");
  const warmAdmission = [];
  for (let index = 0; index < 15; index++) {
    const startedAt = Date.now();
    await call("worst", "/admission-capabilities");
    warmAdmission.push({ startedAt, finishedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const maintenanceStartedAt = Date.now();
  await call("worst", "/__proof/enable");
  const responsiveness = [];
  let maintenanceCompletedAt;
  const [worstAfter] = await Promise.all([
    waitComplete("worst").then((value) => {
      maintenanceCompletedAt = Date.now();
      return value;
    }),
    (async () => {
      for (let index = 0; index < 15; index++) {
        const startedAt = Date.now();
        const [target, control] = await Promise.all(
          ["worst", "global"].map(async (object) => {
            const requestStartedAt = Date.now();
            await call(object, "/admission-capabilities");
            return { object, startedAt: requestStartedAt, finishedAt: Date.now() };
          }),
        );
        responsiveness.push({ startedAt, target, control });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(),
  ]);
  assert.equal(worstAfter.state.retired, 64);
  assert.equal(worstAfter.state.retiredBytes, worstBefore.logicalBytes);
  assert.equal(worstAfter.logicalBytes, 0);
  assert.equal(worstAfter.chunks.count, 0);
  assert.equal(worstAfter.nextAlarm, null);
  await call("empty", "/admission-capabilities");
  await call("empty", "/__proof/pass");
  assert.equal((await inspect("empty")).state.completedAt, null);
  await call("empty", "/__proof/seed", { start: 131, count: 1 });
  const tailDigest = createHash("sha256").update("canonical 65\n".padEnd(64, "x")).digest("hex");
  assert.equal(
    (
      await call(
        "empty",
        "/records/tuples",
        tuple("remove-tail", 65, "replacement tail\n", tailDigest),
      )
    ).accepted,
    true,
  );
  await call("empty", "/__proof/pass");
  const emptyTail = await inspect("empty");
  assert.ok(emptyTail.state.completedAt);
  assert.equal(emptyTail.state.afterRowid, 65);
  assert.equal(emptyTail.state.scanned, 64);
  assert.equal(emptyTail.metadata.length, 1);
  assert.equal(emptyTail.metadata[0].record_id, "131");
  const completedReceipt = (await inspect("global")).state;
  assert.equal((await inspect("global")).outbound, 0);
  assert.equal(worstAfter.outbound, 0);
  await stop();
  await start();
  await call("global", "/admission-capabilities");
  assert.deepEqual((await inspect("global")).state, completedReceipt);
  assert.equal((await inspect("worst")).state.retired, 64);
  assert.equal((await inspect("worst")).outbound, 0);
  report = {
    ok: true,
    runtime: "local Workerd SQLite Durable Object",
    baseline,
    baselineArchiveSha256: createHash("sha256").update(archived.archive).digest("hex"),
    samePersistedObject: true,
    rollbackAtomic: true,
    exportPages: beforeView.length,
    snapshotAndDeltaUnchanged: true,
    protectedQueueAndCanonicalStateUnchanged: true,
    tupleProducerAndReplay: true,
    finiteCleanup: complete.state,
    automaticPasses: complete.passes,
    worstSizedBatch: {
      logicalBytes: worstBefore.logicalBytes,
      encodedChunkBytes: worstBefore.chunks.bytes,
      beforeDatabaseBytes: worstBefore.databaseBytes,
      afterDatabaseBytes: worstAfter.databaseBytes,
      passes: worstAfter.passes,
      warmAdmission,
      maintenanceStartedAt,
      maintenanceCompletedAt,
      externalCompletionMs: maintenanceCompletedAt - maintenanceStartedAt,
      admissionTimeline: responsiveness,
    },
    futureQueueWakePreserved: true,
    emptyPageCompletesAndNewRowsStayOutsideSweep: true,
    completedReceiptSurvivesRestart: true,
    outboundRequests: 0,
    liveCloudflare: false,
  };
} catch (error) {
  console.error(diagnostics);
  failure = error;
}
try {
  await stop();
  rmSync(root, { recursive: true, force: true });
} catch (error) {
  throw failure ? new AggregateError([failure, error], "proof and cleanup failed") : error;
}
if (failure) throw failure;
console.log(JSON.stringify(report));
