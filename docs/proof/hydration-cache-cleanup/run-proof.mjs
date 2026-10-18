import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "hydration-cache-proof-"));
mkdirSync(path.join(root, "home"));
const nonce = randomUUID();
const baseline = "8cf2991cefeee11414e011cdb5aa51f70c151f14";
const proofPath = "docs/proof/hydration-cache-cleanup";
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
const sql = (object, query) =>
  call(object, "/__proof/sql", { statements: [{ sql: query, bindings: [] }] });
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
  return {
    revision: snapshot.revisionWatermark,
    count: snapshot.fileCount,
    bytes: snapshot.bytes,
    hash: await snapshotHash(object, snapshot.revisionWatermark, snapshot.bytes),
  };
}
async function snapshotHash(object, revision, bytes) {
  const response = await fetch(`${baseUrl}/${object}/records/snapshots/chunk`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proof-nonce": nonce },
    body: JSON.stringify({
      repoSlug: "example-project",
      revisionWatermark: revision,
      offset: 0,
      length: bytes,
    }),
  });
  assert.equal(response.status, 206);
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}
async function waitComplete(object) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await inspect(object);
    if (value.state?.completedAt !== null && value.state !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`automatic cleanup did not finish: ${object}`);
}
async function waitBlocked(object) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await inspect(object);
    if (value.state?.blockedAt != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`deferred cleanup did not stop: ${object}`);
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

const hash = (content) => createHash("sha256").update(content).digest("hex");
// Independent expected bytes: the fixture has one CRLF cache line in its header.
const withoutCache = (content) => content.replace(/^pr_hydration_snapshot: [^\r\n]*\r\n/m, "");
const records = async (object, since = 0) =>
  (await view(object, since)).flatMap((page) => page.records);
let failure;
try {
  const archived = archivedFixture(baseline, "baseline");
  await start(archived.config);
  for (const object of ["global", "worst", "empty", "blocked"]) {
    await call(object, "/admission-capabilities");
    await call(object, "/__proof/pause");
  }
  await call("global", "/__proof/seed", { start: 1, count: 6 });
  await call("worst", "/__proof/seed", { start: 1, count: 5, size: 400000 });
  await call("blocked", "/__proof/seed", { start: 1, count: 6 });
  await sql(
    "blocked",
    "UPDATE exact_review_record_export_index SET revision = revision + 1 WHERE record_id = '1' AND section = 'items'",
  );
  const original = tuple(
    "original-receipt",
    99,
    "---\r\npr_hydration_snapshot: old tuple cache\r\n---\r\nunchanged tuple\r\n",
  );
  assert.equal((await call("global", "/records/tuples", original)).accepted, true);
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
  const before = await inspect("global", true);
  const beforeRecords = await records("global");
  const beforeSnapshot = await snapshot("global");
  assert.ok(before.protected.exact_review_queue_items.length);
  assert.ok(before.protected.canonical_record_tuple_receipts.length);
  assert.ok(before.protected.exact_review_lifecycle_projection_v1.length);
  assert.equal(before.protected.exact_review_pull_request_answers.length, 6);
  await stop();

  await start();
  await call("global", "/admission-capabilities");
  const initialized = await inspect("global", true);
  assert.deepEqual(initialized.protected, before.protected);
  assert.match(
    (await call("global", "/__proof/pass", { fail: true })).error,
    /proof checkpoint failure/,
  );
  assert.deepEqual((await inspect("global", true)).protected, initialized.protected);
  assert.deepEqual((await inspect("global")).state, initialized.state);
  await call("global", "/__proof/pass");
  const checkpoint = (await inspect("global")).state;
  assert.equal(checkpoint.retired, 4);
  assert.equal(checkpoint.completedAt, null);
  await call("blocked", "/admission-capabilities");
  await call("blocked", "/__proof/pass");
  const deferredCheckpoint = (await inspect("blocked")).state;
  assert.equal(deferredCheckpoint.passes, 0);
  assert.equal(deferredCheckpoint.passConflicts, 1);
  await stop();
  await start();
  await call("global", "/admission-capabilities");
  assert.deepEqual((await inspect("global")).state, checkpoint);
  await call("blocked", "/admission-capabilities");
  assert.deepEqual((await inspect("blocked")).state, deferredCheckpoint);
  await call("blocked", "/__proof/enable");
  const blocked = await waitBlocked("blocked");
  assert.equal(blocked.state.passes, 3);
  assert.equal(blocked.state.passConflicts, 0);
  assert.equal(blocked.state.unresolved, 1);
  assert.equal(blocked.state.completedAt, null);
  assert.equal(blocked.state.retired, 5);
  assert.equal(blocked.nextAlarm, null);
  await call("global", "/__proof/enable");
  const completed = await waitComplete("global");
  await call("global", "/__proof/pause");
  const after = await inspect("global", true);
  const afterRecords = await records("global");
  const expected = new Map(
    beforeRecords.map((record) => [`${record.section}/${record.id}`, record]),
  );
  let removedBytes = 0;
  for (const actual of afterRecords) {
    const prior = expected.get(`${actual.section}/${actual.id}`);
    const content = prior.content === null ? null : withoutCache(prior.content);
    assert.equal(actual.content, content);
    assert.equal(actual.digest, content === null ? null : hash(content));
    if (content !== null)
      removedBytes += Buffer.byteLength(prior.content) - Buffer.byteLength(content);
    assert.ok(actual.revision > prior.revision);
    assert.ok(actual.storeRevision > prior.storeRevision);
  }
  assert.equal(completed.state.retiredBytes, removedBytes);
  for (const table of [
    "exact_review_direct_publication_plans",
    "canonical_record_tuple_receipts",
    "exact_review_queue_items",
    "exact_review_queue_deliveries",
    "exact_review_lifecycle_projection_v1",
    "exact_review_pull_request_answers",
  ])
    assert.deepEqual(after.protected[table], before.protected[table]);
  assert.equal((await call("global", "/records/tuples", original)).deduped, true);
  const retryWithOldDigest = tuple(
    "unseen-old-cas",
    99,
    "stale writer",
    hash(
      original.operations[0].contentBase64
        ? Buffer.from(original.operations[0].contentBase64, "base64")
        : "",
    ),
  );
  const response = await fetch(`${baseUrl}/global/records/tuples`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proof-nonce": nonce },
    body: JSON.stringify(retryWithOldDigest),
  });
  assert.equal(response.status, 409);
  const freshSnapshot = await snapshot("global");
  assert.notEqual(freshSnapshot.hash, beforeSnapshot.hash);
  assert.equal(
    await snapshotHash("global", beforeSnapshot.revision, beforeSnapshot.bytes),
    beforeSnapshot.hash,
  );
  // Old snapshot artifacts are immutable; current export deliberately advances.
  assert.ok(freshSnapshot.revision > beforeSnapshot.revision);
  const delta = await records("global", beforeSnapshot.revision);
  assert.equal(delta.length, afterRecords.length);
  await call("global", "/__proof/seed", { start: 1, count: 1 });
  assert.deepEqual(await records("global"), afterRecords);
  await call("global", "/__proof/seed", { start: 101, count: 1 });
  const postPublicationRecords = await records("global");
  assert.doesNotMatch(
    postPublicationRecords.find((record) => record.id === "101" && record.section === "items")
      .content,
    /pr_hydration_snapshot:/,
  );
  assert.deepEqual((await inspect("global")).state, completed.state);
  await call("worst", "/admission-capabilities");
  const largeBefore = await inspect("worst");
  await call("worst", "/__proof/enable");
  const largeDone = await waitComplete("worst");
  assert.equal(largeDone.state.retired, 5);
  assert.equal(largeDone.chunks.count, 0);
  assert.ok(largeDone.passes.every((pass) => pass.after.retired - pass.before.retired <= 4));
  await call("empty", "/admission-capabilities");
  assert.ok((await inspect("empty")).state.completedAt);
  await stop();
  await start(archived.config);
  await call("global", "/admission-capabilities");
  assert.deepEqual(await records("global"), postPublicationRecords);
  assert.equal((await inspect("global")).outbound, 0);
  console.log(
    JSON.stringify({
      baseline,
      retired: completed.state.retired,
      retiredBytes: removedBytes,
      originalReceiptReplay: true,
      oldDigestConflict: true,
      rollbackReadable: true,
      deferredCleanup: blocked.state,
      exportAndDelta: true,
      newSnapshotChanged: true,
      beforeSnapshot,
      maximumBodyBytes: largeBefore.logicalBytes,
      nativePasses: largeDone.passes,
      outbound: 0,
    }),
  );
} catch (error) {
  failure = error;
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
if (failure) throw failure;
