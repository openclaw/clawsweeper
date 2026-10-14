import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "webhook-payload-proof-"));
mkdirSync(path.join(root, "home"));
const nonce = randomUUID();
const now = Date.parse("2026-10-14T00:00:00Z");
const baseline = "bc3ae1d960157d3bbd751af0bfd794c2f2e1aba9";
const proofPath = "docs/proof/webhook-payload-retention";
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

async function upgradeProof() {
  const { archive, config } = archivedFixture(baseline, "baseline");
  const stamp = Date.parse("2030-01-01T00:00:00Z");
  const historical = stamp - 31 * 60_000;
  let clock = historical;
  const repository = "example/project";
  const sourceUpdatedAt = new Date(historical).toISOString();
  const item = (number) => ({
    kind: "item",
    repository,
    number,
    itemKind: "issue",
    sourceUpdatedAt,
    snapshot: { number, state: "open", body: "x".repeat(8192) },
  });
  const comment = (number, id, body = "ordinary comment") => ({
    kind: "comment",
    repository,
    number,
    id,
    sourceUpdatedAt,
    tombstone: false,
    snapshot: { id, body },
  });
  const ordinary = comment(1, 1);
  const marker = comment(71, 3, "ClawSweeper status: review started.");
  const review = { ...comment(1, 21), kind: "review" };
  const delivery = (id, objects) => ({
    version: 1,
    deliveryId: id,
    event: "issue_comment",
    action: "created",
    receivedAt: new Date(clock).toISOString(),
    eventClasses: ["issues", "issue_comments", "pull_request_reviews"],
    objects,
  });
  const call = async (route, body) => {
    const response = await fetch(`${baseUrl}/queue${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-proof-nonce": nonce,
        "x-proof-now": String(clock),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const snapshot = () => call("/__proof/snapshot");
  const countPruned = (value) =>
    Object.values(value.payloads)
      .flat()
      .filter((row) => row.payload_pruned === 1).length;
  const content =
    "---\nrepo: example/project\nnumber: 999\nreviewed_at: 2030-01-01T00:00:00.000Z\n---\n\nretained canonical review\n";
  const tuple = {
    deliveryId: "upgrade-canonical",
    key: "example-project/999",
    operations: [
      {
        path: "records/example-project/items/999.md",
        expectedDigest: null,
        contentBase64: Buffer.from(content).toString("base64"),
      },
      ...["closed", "plans"].map((section) => ({
        path: `records/example-project/${section}/999.md`,
        expectedDigest: null,
      })),
      { path: "records/example-project/decision-packets/999.json", expectedDigest: null },
    ],
  };
  const queued = {
    delivery_id: "upgrade-pending",
    decision: {
      targetRepo: repository,
      targetBranch: "main",
      itemNumber: 999,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
    },
  };
  await stop();
  await start(config);
  await call(
    "/github-read-model/ingest",
    delivery("upgrade-old", [
      ...Array.from({ length: 72 }, (_, index) => item(index + 1)),
      ordinary,
      { ...comment(1, 2), tombstone: true, snapshot: { id: 2, body: null } },
      marker,
      review,
      ...Array.from({ length: 100 }, (_, index) => comment(72, 1000 + index)),
    ]),
  );
  await call("/github-read-model/repair", {
    repository,
    repair_kind: "placeholders",
    objects: [ordinary],
    complete_comment_items: [1],
  });
  clock = stamp;
  await call(
    "/github-read-model/ingest",
    delivery("upgrade-hot", [
      { ...comment(72, 1100), sourceUpdatedAt: new Date(clock).toISOString() },
    ]),
  );
  assert.equal((await call("/enqueue", queued)).queued, true);
  assert.equal((await call("/records/tuples", tuple)).accepted, true);
  const before = await snapshot();
  assert.ok(
    Object.values(before.columns).every(
      (columns) => !columns.includes("payload_pruned") && !columns.includes("payload_retire_at"),
    ),
  );
  assert.equal(before.protected.exact_review_queue_items.length, 1);
  assert.ok(before.protected.exact_review_queue_deliveries.length > 0);
  assert.ok(before.protected.canonical_record_tuple_receipts.length > 0);
  assert.equal(
    before.protected.exact_review_canonical_records.filter((row) => row.deleted === 0).length,
    1,
  );
  assert.ok(before.protected.exact_review_lifecycle_projection_v1.length > 0);
  assert.equal(before.outbound, 0);
  await stop();
  await start();
  const reopened = await snapshot();
  assert.deepEqual(reopened.protected, before.protected);
  await call("/github-read-model/item", { repository, number: 1 });
  const initialized = await snapshot();
  assert.ok(
    Object.values(initialized.columns).every(
      (columns) => columns.includes("payload_pruned") && columns.includes("payload_retire_at"),
    ),
  );
  assert.equal(countPruned(initialized), 0);
  for (const [table, rows] of Object.entries(before.payloads)) {
    assert.deepEqual(
      initialized.payloads[table].map((row, index) =>
        Object.fromEntries(Object.keys(rows[index]).map((key) => [key, row[key]])),
      ),
      rows,
    );
  }
  assert.ok(
    initialized.collections.length > 0 &&
      initialized.collections.every((row) => row.complete === 0),
  );
  assert.deepEqual(initialized.protected, before.protected);
  assert.equal((await call("/enqueue", queued)).deduped, true);
  assert.equal((await call("/records/tuples", tuple)).deduped, true);
  const passes = [];
  let previous = 0;
  for (let pass = 0; pass < 5; pass++) {
    assert.equal((await call("/__proof/alarm")).outbound, 0);
    const retired = countPruned(await snapshot());
    passes.push(retired - previous);
    assert.ok(retired - previous <= 64);
    previous = retired;
  }
  const retired = await snapshot();
  assert.equal(countPruned(retired), 72);
  for (const row of Object.values(retired.payloads).flat()) {
    if (row.payload_pruned === 1) assert.equal(row.snapshot_json, "{}");
  }
  assert.deepEqual(retired.protected, before.protected);
  assert.equal((await call("/github-read-model/item", { repository, number: 1 })).usable, false);
  const retiredComments = await call("/github-read-model/comments", { repository, number: 1 });
  assert.equal(retiredComments.usable, false);
  assert.deepEqual(retiredComments.tombstones, [2]);
  const hot = await call("/github-read-model/comments", { repository, number: 72 });
  assert.equal(hot.usable, true);
  assert.equal(hot.comments.length, 101);
  const placeholderRows = retired.payloads.github_webhook_read_model_comments_v1.filter(
    (row) => row.comment_id === 3,
  );
  assert.equal(placeholderRows[0].payload_pruned, 0);
  assert.equal(
    retired.payloads.github_webhook_read_model_items_v1.find((row) => row.number === 71)
      .payload_pruned,
    0,
  );
  await call("/github-read-model/repair", {
    repository,
    repair_kind: "placeholders",
    objects: [item(1), ordinary, review, item(71), marker],
    complete_comment_items: [1],
  });
  const repairedItem = await call("/github-read-model/item", { repository, number: 1 });
  assert.equal(repairedItem.usable, true);
  assert.deepEqual(repairedItem.item, item(1).snapshot);
  const repairedComments = await call("/github-read-model/comments", { repository, number: 1 });
  assert.equal(repairedComments.usable, true);
  assert.deepEqual(repairedComments.comments, [ordinary.snapshot]);
  assert.deepEqual(repairedComments.tombstones, [2]);
  const placeholders = await call("/github-read-model/placeholders", { repository, state: "open" });
  assert.equal(placeholders.usable, true);
  assert.equal(placeholders.candidates.length, 1);
  assert.equal((await snapshot()).outbound, 0);
  await stop();
  await start();
  assert.equal((await call("/github-read-model/item", { repository, number: 1 })).usable, true);
  assert.equal((await call("/github-read-model/comments", { repository, number: 1 })).usable, true);
  const final = await snapshot();
  assert.deepEqual(final.protected, before.protected);
  assert.equal(final.outbound, 0);
  return {
    baseline,
    baselineArchiveSha256: createHash("sha256").update(archive).digest("hex"),
    actualQueue: true,
    samePersistedObject: true,
    initializerAddedColumns: true,
    initializerPreservesOldRows: true,
    legacyCompletenessInvalidated: true,
    protectedRowsUnchanged: true,
    retiredPayloads: countPruned(retired),
    passes,
    hotFamilyComments: hot.comments.length,
    authoritativeRepair: true,
    repairedStateSurvivesRestart: true,
    outboundRequests: 0,
  };
}

async function send(route) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-proof-nonce": nonce },
    body: JSON.stringify({ now }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function automaticMaintenanceProof() {
  const metrics = [];
  const call = async (object, route, body = {}, clock = null) => {
    const response = await fetch(`${baseUrl}/maintenance/${object}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-proof-nonce": nonce,
        ...(clock === null ? {} : { "x-proof-now": String(clock) }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${object}${route}: ${response.status} ${raw.slice(0, 200)}`);
    }
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`);
    if (response.headers.has("x-proof-rows-read")) {
      metrics.push({
        object,
        route,
        rowsRead: Number(response.headers.get("x-proof-rows-read")),
        elapsedMs: Number(response.headers.get("x-proof-elapsed-ms")),
      });
    }
    return value;
  };
  await stop();
  const deployed = "5a55fa9e8866abb28f54d4eeb5e04b7ddeb63f44";
  const deployedFixture = archivedFixture(deployed, "deployed");
  await start(deployedFixture.config);
  const item = (number, at, body = "x".repeat(8192)) => ({
    kind: "item",
    repository: "example/project",
    number,
    itemKind: "issue",
    sourceUpdatedAt: new Date(at).toISOString(),
    snapshot: { number, body },
  });
  const comment = (number, id, at, body = "ordinary comment") => ({
    kind: "comment",
    repository: "example/project",
    number,
    id,
    tombstone: false,
    sourceUpdatedAt: new Date(at).toISOString(),
    snapshot: { id, body },
  });
  const envelope = (id, objects, at) => ({
    version: 1,
    deliveryId: id,
    event: "issue_comment",
    action: "created",
    receivedAt: new Date(at).toISOString(),
    eventClasses: ["issues", "issue_comments", "pull_request_reviews"],
    objects,
  });
  const waitFor = async (object, predicate) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const value = await call(object, "/__proof/inspect");
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`automatic maintenance did not reach expected state: ${object}`);
  };
  const old = Date.now() - 31 * 60_000;
  const objects = [
    ...Array.from({ length: 130 }, (_, i) => item(i + 1, old)),
    comment(1, 1, old),
    { ...comment(1, 2, old), kind: "review" },
    item(900, old),
    comment(900, 900, old, "ClawSweeper status: review started."),
    item(901, old),
    comment(901, 901, old),
  ];
  const seed = envelope("automatic-seed", objects, old);
  await call("idle", "/github-read-model/ingest", seed, old);
  await call(
    "idle",
    "/github-read-model/ingest",
    envelope("hot", [comment(901, 902, Date.now())], Date.now()),
    old,
  );
  const before = await call("idle", "/__proof/inspect", {}, old);
  assert.equal(before.passes.length, 0);
  assert.equal(
    Object.values(before.tables).reduce((n, table) => n + table.retired, 0),
    0,
  );
  let last;
  for (let family = 1; family <= 64; family++) {
    last = envelope(
      `populated-${family}`,
      [
        item(family, old),
        ...Array.from({ length: 500 }, (_, id) => comment(family, id + 1, old, "y".repeat(512))),
        ...Array.from({ length: 500 }, (_, id) => ({
          ...comment(family, id + 1, old),
          kind: "review",
        })),
      ],
      old,
    );
    await call("populated", "/github-read-model/ingest", last, old);
  }
  const populatedBefore = await call("populated", "/__proof/inspect", {}, old);
  assert.equal(populatedBefore.tables.comments.rows, 32_000);
  assert.equal(populatedBefore.tables.activity.rows, 32_000);
  assert.equal(populatedBefore.passes.length, 0);
  await call("populated", "/github-read-model/ingest", envelope("deployed-probe", [], Date.now()));
  const deployedProbe = metrics.at(-1);
  const populatedAfterProbe = await call("populated", "/__proof/inspect");
  assert.equal(populatedAfterProbe.tables.items.retired, 64);
  assert.equal(populatedAfterProbe.outbound, 0);
  await stop();
  await start();
  await call("idle", "/__proof/enable");
  assert.equal((await call("idle", "/github-read-model/ingest", seed)).deduped, true);
  const interrupted = await waitFor("idle", (value) => value.passes.length >= 1);
  assert.ok(Object.values(interrupted.tables).reduce((n, table) => n + table.retired, 0) < 132);
  await stop();
  await start();
  const drained = await waitFor(
    "idle",
    (value) => Object.values(value.tables).reduce((n, table) => n + table.retired, 0) === 132,
  );
  assert.equal(drained.outbound, 0);
  assert.ok(drained.passes.every((pass) => pass.scanned <= 64));
  assert.equal(drained.tables.items.retired, 130);
  assert.equal(drained.tables.comments.retired, 1);
  assert.equal(drained.tables.activity.retired, 1);
  assert.ok(drained.tables.items.bytes < before.tables.items.bytes / 20);
  assert.ok(drained.nextAlarm > Date.now(), "hot family retains its future wake");
  const futureAt = Date.now() - 30 * 60_000 + 2_000;
  await call(
    "future",
    "/github-read-model/ingest",
    envelope("future", [item(1, futureAt)], futureAt),
  );
  await call("future", "/__proof/enable");
  await call("future", "/github-read-model/ingest", envelope("future", [], futureAt));
  const futureBefore = await call("future", "/__proof/inspect");
  assert.equal(futureBefore.tables.items.retired, 0);
  const future = await waitFor("future", (value) => value.tables.items.retired === 1);
  assert.equal(future.nextAlarm, null);

  // A populated first pass must traverse capped child families. Record native
  // work and live request latency, rather than equating 64 candidates with 64 reads.
  await call("populated", "/github-read-model/ingest", envelope("candidate-probe", [], Date.now()));
  const candidateProbe = metrics.at(-1);
  const afterCandidateProbe = await call("populated", "/__proof/inspect");
  assert.equal(afterCandidateProbe.tables.comments.retired, 0);
  assert.equal(afterCandidateProbe.tables.activity.retired, 0);
  assert.ok(candidateProbe.rowsRead < deployedProbe.rowsRead / 10);
  const enqueued = await call("populated", "/enqueue", {
    delivery_id: "maintenance-review",
    decision: {
      targetRepo: "example/project",
      targetBranch: "main",
      itemNumber: 999,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
    },
  });
  assert.equal(enqueued.queued, true);
  const lease = await call("populated", "/__proof/dispatch-fixture", {
    item_key: enqueued.item_key,
  });
  await call("populated", "/__proof/enable");
  await call("populated", "/github-read-model/ingest", last);
  const claim = await call("populated", "/claim", { ...lease, run_id: "9001", run_attempt: 1 });
  assert.equal(claim.claimed, true);
  const concurrentStart = Date.now();
  let concurrentRequests = 0;
  while (Date.now() - concurrentStart < 3_000) {
    await Promise.all([
      call("populated", "/admission-capabilities"),
      call(
        "populated",
        "/github-read-model/ingest",
        envelope(`concurrent-${concurrentRequests}`, [], Date.now()),
      ),
    ]);
    concurrentRequests += 2;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completed = await call("populated", "/complete", {
    ...lease,
    claim_generation: claim.claim_generation,
    run_id: "9001",
    run_attempt: 1,
    outcome: "success",
  });
  assert.equal(completed.ok, true);
  const populated = await waitFor("populated", (value) => value.passes.length >= 2);
  assert.ok(populated.passes.every((pass) => pass.scanned <= 64));
  assert.ok(populated.passes.every((pass) => pass.retired_bytes > 0));
  assert.equal(populated.outbound, 0);
  return {
    deployedBaseline: deployed,
    deployedArchiveSha256: createHash("sha256").update(deployedFixture.archive).digest("hex"),
    automaticAlarmDelivery: true,
    restartContinuesMaintenance: true,
    futureDeadlineWakesWithoutIngress: true,
    idleBefore: before.tables,
    idleAfter: drained.tables,
    idlePasses: drained.passes,
    futurePasses: future.passes,
    populatedBefore: populatedBefore.tables,
    deployedProbe,
    candidateProbe,
    queueClaimAndComplete: true,
    simulatedExternalDispatchOnly: true,
    concurrentSuccessfulRequests: concurrentRequests,
    populatedPasses: populated.passes,
    requestMetrics: metrics.filter((metric) => metric.object === "populated").slice(-70),
    populatedBacklogFullyDrained: false,
    outboundRequests: 0,
  };
}

let report;
let failure;
try {
  await start();
  const before = await send("/seed");
  assert.equal(before.retainedRows, 71);
  assert.equal(before.placeholders.usable, true);
  assert.deepEqual(await send("/prune"), { pruned: 64 });
  await stop();
  await start();
  assert.deepEqual(await send("/prune"), { pruned: 7 });
  assert.deepEqual(await send("/prune"), { pruned: 0 });
  const retired = await send("/read");
  assert.ok(retired.payloadBytes < before.payloadBytes / 50);
  assert.ok(retired.databaseBytes < before.databaseBytes);
  assert.equal(retired.retainedRows, before.retainedRows);
  assert.equal(retired.receipts, before.receipts);
  assert.equal(retired.item.usable, false);
  assert.equal(retired.comments.usable, false);
  assert.deepEqual(retired.comments.tombstones, [2]);
  assert.equal(retired.placeholders.usable, true);
  assert.deepEqual(retired.placeholders.candidates, before.placeholders.candidates);
  const repaired = await send("/repair");
  assert.equal(repaired.item.usable, true);
  assert.equal(repaired.comments.usable, true);
  assert.deepEqual(repaired.comments.tombstones, [2]);
  assert.equal(repaired.placeholders.usable, true);
  assert.deepEqual(repaired.placeholders.candidates, before.placeholders.candidates);
  const hot = await send("/hot");
  assert.equal(hot.pruned, 0);
  assert.equal(hot.usable, true);
  assert.equal(hot.comments, 101);
  assert.ok(hot.pruneRowsRead > 0 && hot.pruneRowsRead < 5_000);
  const upgrade = await upgradeProof();
  const automatic = await automaticMaintenanceProof();
  report = {
    ok: true,
    runtime: "local Workerd SQLite Durable Object",
    beforePayloadBytes: before.payloadBytes,
    retiredPayloadBytes: retired.payloadBytes,
    beforeDatabaseBytes: before.databaseBytes,
    retiredDatabaseBytes: retired.databaseBytes,
    retainedItemRows: retired.retainedRows,
    passes: [64, 7, 0],
    restart: true,
    rebuildEquivalent: true,
    hotFamily: hot,
    persistedQueueUpgrade: upgrade,
    automaticMaintenance: automatic,
    liveCloudflare: false,
    limits:
      "synthetic local storage and controlled queue entrypoints; no production size, billed storage, dispatch, or full queue workload proof",
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
