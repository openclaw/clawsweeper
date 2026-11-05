// Explicit controlled predecessor -> candidate proof. No production data, GitHub
// write, checkout/reset, or guessed legacy-state insert. Both owners are built.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import currentWorker, { ExactReviewQueue as CurrentQueue } from "../../../dashboard/worker.ts";
import { ExactReviewDirectPublicationStore as CurrentRecords } from "../../../dashboard/exact-review-direct-publication.ts";
import { runTargetFanout as currentCli } from "../../../dist/repair/target-fanout.js";
import { aggregateRecords } from "../../../dashboard-site/scripts/records.ts";
import { publicDashboardInputs } from "../../../dashboard-site/scripts/coverage.ts";
import { readCoverageForBuild as currentRead } from "../../../dashboard-site/scripts/coverage.ts";
import { coverageCliFixture } from "../../../test/fixtures/review-coverage-cli.ts";
import { captureCompatibilityBrowser } from "./compatibility-browser.mjs";
import { withReplayClock } from "../ui-live-coverage/replay-clock.mjs";

assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
const base = "03e24309cf919bf866bb2ffe2551beca27fd9bb3",
  root = resolve(import.meta.dirname, "../../.."),
  output = resolve(
    process.env.CENSUS_COMPAT_OUTPUT ?? ".openclaw/tmp/census-id-contract-fix/compatibility",
  ),
  prior = resolve(
    process.env.CENSUS_PREDECESSOR_ROOT ?? ".openclaw/tmp/census-id-contract-fix/predecessor-src",
  );
mkdirSync(output, { recursive: true });
mkdirSync(prior, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
  oldTree = git("rev-parse", base + "^{tree}"),
  head = git("rev-parse", "HEAD"),
  headTree = git("rev-parse", "HEAD^{tree}"),
  realStarted = new Date().toISOString(),
  workingTreeCandidate = git("status", "--porcelain").length > 0;
if (!existsSync(join(prior, "package.json"))) {
  const archive = execFileSync("git", ["archive", base], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const unpack = spawnSync("tar", ["-x", "-C", prior], { input: archive });
  assert.equal(unpack.status, 0);
}
const paths = git("ls-tree", "-r", "--name-only", base).split("\n"),
  oldSource = {};
for (const p of paths) {
  const expected = execFileSync("git", ["show", base + ":" + p], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    }),
    bytes = readFileSync(join(prior, p));
  assert.deepEqual(bytes, expected, p);
  oldSource[p] = { bytes: bytes.length, sha256: sha(bytes) };
}
for (const p of ["package.json", "pnpm-lock.yaml"])
  assert.equal(
    sha(readFileSync(join(prior, p))),
    sha(readFileSync(join(root, p))),
    "same installed dependency contract for both owners",
  );
for (const [name, config] of [
  ["main", "tsconfig.json"],
  ["repair", "tsconfig.repair.json"],
  ["dashboard", "tsconfig.dashboard.json"],
]) {
  const r = spawnSync("pnpm", ["exec", "tsc", "-p", join(prior, config)], {
    cwd: root,
    encoding: "utf8",
  });
  writeFileSync(
    join(output, "predecessor-build-" + name + ".log"),
    (r.stdout ?? "") + (r.stderr ?? ""),
  );
  assert.equal(r.status, 0, "predecessor " + name + " build");
}
const load = (p) => import(pathToFileURL(join(prior, p)).href),
  oldWorkerModule = await load("dashboard/worker.ts"),
  oldWorker = oldWorkerModule.default,
  OldQueue = oldWorkerModule.ExactReviewQueue,
  { TestStorage } = await load("test/exact-review-test-storage.ts"),
  oldRecordModule = await load("dashboard/exact-review-direct-publication.ts"),
  oldCliModule = await load("dist/repair/target-fanout.js"),
  oldReadModule = await load("dashboard-site/scripts/coverage.ts"),
  oldTargetAdmission = await load("src/hosted-target-admission.ts");
const storage = new TestStorage(),
  bodies = new Map(),
  bodyWrites = [];
const bucket = {
  async put(key, value) {
    const b = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const old = bodies.get(key);
    if (old) assert.deepEqual(old, b, "immutable body key");
    bodies.set(key, b);
    bodyWrites.push({ key, bytes: b.length, sha256: sha(b) });
    return {};
  },
  async get(key) {
    const b = bodies.get(key);
    if (!b) return null;
    return {
      size: b.length,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(b));
          c.close();
        },
      }),
      text: async () => b.toString(),
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  },
};
const now = Date.now(),
  at = new Date(now).toISOString(),
  recordText =
    "---\nrepository: openclaw/core\nnumber: 1\ntype: issue\nreview_status: complete\nreviewed_at: " +
    at +
    "\n---\nControlled predecessor record; keep this immutable body.\n";
const oldRecords = new oldRecordModule.ExactReviewDirectPublicationStore(storage, bucket);
oldRecords.ensureSchemaSync();
const plan = await oldRecordModule.validateDirectPublicationPlan({
  canonicalTargetKey: "openclaw/core#1",
  fenceKey: "openclaw/core#1:compatibility-seed",
  revision: 1,
  identity: {
    canonicalTargetKey: "openclaw/core#1",
    fenceKey: "openclaw/core#1:compatibility-seed",
    revision: 1,
    claimGeneration: 1,
  },
  lifecycle: { kind: "guarded_open" },
  operations: [
    {
      path: "records/openclaw-core/items/1.md",
      deleted: false,
      mode: "100644",
      bytes: Buffer.byteLength(recordText),
      contentBase64: Buffer.from(recordText).toString("base64"),
    },
  ],
  totalBytes: Buffer.byteLength(recordText),
});
const seed = oldRecords.accept(plan, now, await oldRecords.prepareCanonicalWrites(plan.operations));
assert.ok(seed);
const secret = "synthetic-predecessor-upgrade-secret",
  env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    STATE_SNAPSHOTS: bucket,
    hostedTargetConfiguredRepositories: ["openclaw/openclaw"],
    hostedPublicTargetProbe: (repo) =>
      oldTargetAdmission.probeHostedPublicTarget(
        repo,
        "synthetic-controlled-metadata-token",
        globalThis.fetch,
      ),
  },
  queue = new OldQueue({ storage }, env);
const sql = (q, ...args) => Array.from(storage.sql.exec(q, ...args)),
  canonicalState = () =>
    sql(
      "SELECT repo_slug,section,item_id,digest,revision,deleted,updated_at FROM exact_review_canonical_records_v2 ORDER BY repo_slug,section,item_id",
    );
// Exercise the predecessor's supported inline -> format-two owner API rather
// than hand-inserting v2 rows. Qualification metadata describes this synthetic
// immutable map, NOT a real deployment/R2 rollout authorization.
const inlineSeedFormat = oldRecords.storageFormatSync();
assert.equal(inlineSeedFormat, 1);
const tieringPreview = await oldRecords.tieringPreview(base, {
  operator: "controlled-predecessor-compatibility",
  rollbackFloor: {
    sha: base,
    supportsFormats: [1, 2],
    proof: "Pinned source controlled read/write and restart cells in this compatibility run",
  },
  bucketLifecycle: {
    bucketIdentity: "clawsweeper-state-snapshots",
    observedAt: at,
    rulesJson: '{"rules":[]}',
    canonicalBodiesDoNotExpire: true,
  },
});
const tieringActivation = oldRecords.activateTieringSync(tieringPreview, now),
  tieringPasses = [];
for (let n = 0; n < 4; n++) {
  const prepared = await oldRecords.prepareTieringPass();
  const pass = oldRecords.commitTieringPassSync(prepared, now);
  tieringPasses.push(pass);
  if (oldRecords.storageFormatSync() === 2) break;
}
assert.equal(oldRecords.storageFormatSync(), 2);
assert.ok(sqlCanonicalV2Count());
function sqlCanonicalV2Count() {
  return Number(
    Array.from(storage.sql.exec("SELECT COUNT(*) AS n FROM exact_review_canonical_records_v2"))[0]
      .n,
  );
}
const secondText = recordText
    .replace("number: 1", "number: 2")
    .replace("review_status: complete", "review_status: failed"),
  secondPlan = await oldRecordModule.validateDirectPublicationPlan({
    canonicalTargetKey: "openclaw/core#2",
    fenceKey: "openclaw/core#2:compatibility-seed",
    revision: 1,
    identity: {
      canonicalTargetKey: "openclaw/core#2",
      fenceKey: "openclaw/core#2:compatibility-seed",
      revision: 1,
      claimGeneration: 1,
    },
    lifecycle: { kind: "guarded_open" },
    operations: [
      {
        path: "records/openclaw-core/items/2.md",
        deleted: false,
        mode: "100644",
        bytes: Buffer.byteLength(secondText),
        contentBase64: Buffer.from(secondText).toString("base64"),
      },
    ],
    totalBytes: Buffer.byteLength(secondText),
  });
const secondSeed = oldRecords.accept(
  secondPlan,
  now,
  await oldRecords.prepareCanonicalWrites(secondPlan.operations),
);
assert.ok(secondSeed);
assert.ok(sqlCanonicalV2Count() >= 2);
const historySeedBody = JSON.stringify({
  repo_slug: "openclaw-core",
  records: [
    {
      sha: "a".repeat(40),
      content: "predecessor compatibility history",
      digest: sha("predecessor compatibility history"),
    },
  ],
});
const seedEnv = { ...env, EXACT_REVIEW_QUEUE: { idFromName: (n) => n, get: () => queue } };
const historySeedResponse = await oldWorker.fetch(
  new Request("https://compat.invalid/internal/state/records/commits", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature":
        "sha256=" + createHmac("sha256", secret).update(historySeedBody).digest("hex"),
    },
    body: historySeedBody,
  }),
  seedEnv,
  {},
);
assert.equal(historySeedResponse.status, 202);
const historySeedReceipt = await historySeedResponse.json();
assert.equal(historySeedReceipt.inserted, 1);
assert.ok(historySeedReceipt.watermark > 0);
const authority = { storage, queue, env, secret, canonicalState };
const fixture = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }], now, {
  authority,
  worker: oldWorker,
  runTargetFanout: oldCliModule.runTargetFanout,
  readCoverageForBuild: oldReadModule.readCoverageForBuild,
  protocolFlag: false,
});
let recordWorker = oldWorker;
const exportThroughWorker = async () => {
  const body = JSON.stringify({
    repoSlug: "openclaw-core",
    sections: ["items", "closed", "plans", "decision-packets", "commits"],
    limit: 100,
  });
  const response = await recordWorker.fetch(
    new Request("https://compat.invalid/internal/state/records/export", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    }),
    { ...env, EXACT_REVIEW_QUEUE: { idFromName: (n) => n, get: () => authority.queue } },
    {},
  );
  assert.equal(response.status, 200);
  return response.json();
};
const stages = [],
  recordStage = (s) => {
    stages.push(s);
    writeFileSync(join(output, "stages-in-progress.json"), JSON.stringify(stages, null, 2));
  },
  recordState = async (records) => {
    const exported = await exportThroughWorker(),
      record = exported.records.find((r) => r.section === "items" && r.id === "1" && !r.deleted);
    assert.ok(record);
    assert.equal(record.content, recordText, "normal API must read the immutable format-two body");
    return {
      canonical: canonicalState(),
      exportRevision: records.currentExportRevision(),
      record,
      export: exported,
      legacyAdmission: structuredClone(storage.kv.get("exact-review-queue")) ?? null,
      queueItems: sql("SELECT item_key,item_json FROM exact_review_queue_items ORDER BY item_key"),
      bodies: [...bodies].map(([k, b]) => ({ key: k, bytes: b.length, sha256: sha(b) })),
    };
  };
const schema = () =>
  sql(
    "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
let currentRecords, compatibilityResult, admissionSeedReceipt;
const sourcePaths = [
    "src/repair/target-fanout.ts",
    "src/repair/coverage-summary.ts",
    "dashboard/worker.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/exact-review-direct-publication.ts",
    "dashboard/canonical-bodies.ts",
    "src/hosted-target-admission.ts",
    "test/fixtures/review-coverage-cli.ts",
    "test/fixtures/fleet-coverage-query.ts",
    "docs/proof/review-coverage-census/compatibility.mjs",
    "docs/proof/review-coverage-census/compatibility-browser.mjs",
    "dist/repair/target-fanout.js",
    "dist/repair/coverage-summary.js",
  ],
  sourceBefore = Object.fromEntries(sourcePaths.map((p) => [p, sha(readFileSync(join(root, p)))]));
try {
  const admissionSeedBody = JSON.stringify({
    delivery_id: "compatibility-predecessor-admission",
    decision: {
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      itemNumber: 2,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
    },
  });
  const admitted = await oldWorker.fetch(
    new Request("https://compat.invalid/internal/exact-review/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", secret).update(admissionSeedBody).digest("hex"),
      },
      body: admissionSeedBody,
    }),
    seedEnv,
    {},
  );
  admissionSeedReceipt = {
    status: admitted.status,
    body: await admitted.json(),
    request: JSON.parse(admissionSeedBody),
    configuredTargets: env.hostedTargetConfiguredRepositories,
  };
  writeFileSync(
    join(output, "admission-seed-receipt.json"),
    JSON.stringify(admissionSeedReceipt, null, 2),
  );
  assert.equal(admitted.status, 202);
  assert.ok(
    sql("SELECT item_key FROM exact_review_queue_items").length > 0,
    "actual predecessor enqueue must produce nonempty admission",
  );
  const oldRun = await fixture.run("coverage", "v1"),
    oldApi = await fixture.read();
  assert.ok(oldRun.legacy > 0);
  assert.ok(fixture.calls.some((c) => c.path.endsWith("/review-coverage/inventory")));
  const legacyEntries = [...storage.values].filter(([key]) =>
    String(key).includes("review-coverage"),
  );
  assert.ok(legacyEntries.length);
  const oldInventory = JSON.stringify(legacyEntries),
    before = await recordState(oldRecords),
    oldSchema = schema();
  assert.equal(
    oldSchema.some((t) => t.name.startsWith("coverage_census_")),
    false,
  );
  assert.ok(before.record);
  assert.ok(before.export.records.length);
  assert.ok(
    before.export.records.some((r) => r.section === "commits" && r.id === "a".repeat(40)),
    "actual history API seed must be readable",
  );
  assert.equal(oldApi.coverage_status, "complete");
  recordStage({
    name: "predecessor-v1-api",
    run: oldRun,
    api: oldApi,
    storedLegacy: legacyEntries,
    state: before,
    schema: oldSchema,
  });
  const nextQueue = new CurrentQueue({ storage }, env);
  fixture.useImplementations({
    worker: currentWorker,
    runTargetFanout: currentCli,
    readCoverageForBuild: currentRead,
    queue: nextQueue,
  });
  recordWorker = currentWorker;
  currentRecords = new CurrentRecords(storage, bucket);
  const upgraded = await fixture.read(),
    upgradedState = await recordState(currentRecords),
    newSchema = schema();
  assert.deepEqual(upgradedState, before);
  assert.equal(
    JSON.stringify([...storage.values].filter(([key]) => String(key).includes("review-coverage"))),
    oldInventory,
  );
  for (const t of oldSchema)
    assert.ok(
      newSchema.some((n) => n.name === t.name && n.sql === t.sql),
      "old table preserved: " + t.name,
    );
  assert.ok(newSchema.some((t) => t.name.startsWith("coverage_census_")));
  assert.deepEqual(upgraded, oldApi);
  recordStage({
    name: "candidate-cold-upgrade",
    api: upgraded,
    state: upgradedState,
    addedTables: newSchema
      .filter((t) => !oldSchema.some((o) => o.name === t.name))
      .map((t) => t.name),
  });
  const warmQueue = new CurrentQueue({ storage }, env);
  fixture.useImplementations({
    worker: currentWorker,
    runTargetFanout: currentCli,
    readCoverageForBuild: currentRead,
    queue: warmQueue,
  });
  assert.deepEqual(await fixture.read(), oldApi);
  assert.deepEqual(await recordState(currentRecords), before);
  recordStage({ name: "candidate-warm-reconstruct", preserved: true });
  const query = fixture.model.query;
  let reads = 0;
  fixture.model.query = (q) => {
    if (++reads > 1) throw new Error("controlled interruption after predecessor upgrade");
    return query(q);
  };
  fixture.advance(20 * 60_000);
  await fixture.run("coverage");
  let active = fixture.states().find((r) => r.repo === "openclaw/core").state.active;
  assert.ok(active);
  const generation = active.id,
    partial = await fixture.read();
  assert.equal(partial.coverage_status, "unknown");
  assert.equal(
    JSON.stringify(
      [...storage.values].filter(
        ([key]) => String(key).includes("review-coverage") && !String(key).includes("cache"),
      ),
    ),
    JSON.stringify(legacyEntries.filter(([key]) => !String(key).includes("cache"))),
  );
  recordStage({ name: "v2-partial-no-unsafe-v1-complete", generation, api: partial });
  const reconstructed = new CurrentQueue({ storage }, env);
  fixture.useImplementations({
    worker: currentWorker,
    runTargetFanout: currentCli,
    readCoverageForBuild: currentRead,
    queue: reconstructed,
  });
  assert.equal(
    fixture.states().find((r) => r.repo === "openclaw/core").state.active.id,
    generation,
  );
  assert.deepEqual(await recordState(currentRecords), before);
  recordStage({ name: "partial-v2-reconstructed-with-predecessor-facts", generation });
  fixture.model.query = query;
  let completed;
  for (let n = 0; n < 6; n++) {
    fixture.advance(20 * 60_000);
    const run = await fixture.run("coverage");
    completed = fixture.states().find((r) => r.repo === "openclaw/core").state;
    writeFileSync(
      join(output, "resume-progress.json"),
      JSON.stringify({ n, run, state: completed }, null, 2),
    );
    assert.equal(
      completed.active?.id ?? completed.complete?.generation,
      generation,
      "same accepted generation retained",
    );
    if (completed.complete) break;
  }
  assert.ok(completed.complete, "bounded resumed predecessor upgrade must complete");
  assert.equal(completed.complete.generation, generation);
  const completeApi = await fixture.read();
  assert.equal(completeApi.coverage_status, "complete");
  assert.deepEqual(await recordState(currentRecords), before);
  recordStage({ name: "v2-resumed-promotion", generation, api: completeApi });
  const qualifiedWindow = JSON.stringify(
      fixture.states().find((r) => r.repo === "openclaw/core").state.complete,
    ),
    refreshWindows = [];
  fixture.observe((event) => {
    if (event.path.endsWith("/census/accept"))
      refreshWindows.push(
        structuredClone(fixture.states().find((r) => r.repo === "openclaw/core").state.complete),
      );
  });
  fixture.advance(20 * 60_000);
  const refreshRun = await fixture.run("coverage");
  fixture.observe(undefined);
  assert.ok(refreshWindows.length);
  assert.equal(
    JSON.stringify(refreshWindows[0]),
    qualifiedWindow,
    "pending refresh cannot restamp the old witness",
  );
  assert.ok(
    refreshRun.inventory >= 4,
    "any replacement window follows actually collected complete matching passes",
  );
  assert.equal((await fixture.read()).coverage_status, "complete");
  assert.deepEqual(await recordState(currentRecords), before);
  recordStage({
    name: "v2-refresh-retains-then-reverifies-window",
    priorWindow: JSON.parse(qualifiedWindow),
    pendingWindows: refreshWindows,
    run: refreshRun,
    verifiedWindow: fixture.states().find((r) => r.repo === "openclaw/core").state.complete,
  });
  fixture.useImplementations({
    worker: currentWorker,
    runTargetFanout: oldCliModule.runTargetFanout,
    readCoverageForBuild: currentRead,
    queue: authority.queue,
    protocolFlag: false,
  });
  fixture.advance(20 * 60_000);
  await fixture.run("coverage", "v1");
  assert.deepEqual(await recordState(currentRecords), before);
  const v1OnCandidate = await fixture.read();
  assert.equal(v1OnCandidate.coverage_status, "complete");
  recordStage({ name: "v1-client-on-candidate", api: v1OnCandidate });
  fixture.useImplementations({
    worker: currentWorker,
    runTargetFanout: currentCli,
    readCoverageForBuild: currentRead,
    queue: authority.queue,
  });
  fixture.setCountWitness("core", 20001, 0);
  fixture.advance(20 * 60_000);
  const over = await fixture.run("coverage"),
    blocked = await fixture.read();
  assert.equal(over.inventory, 0);
  assert.equal(blocked.coverage_status, "unknown");
  assert.equal(blocked.totals.coverage_percent, null);
  assert.deepEqual(await recordState(currentRecords), before);
  recordStage({ name: "oversized-v2-no-v1-denominator", run: over, api: blocked });
  fixture.useImplementations({
    worker: currentWorker,
    runTargetFanout: oldCliModule.runTargetFanout,
    readCoverageForBuild: currentRead,
    queue: authority.queue,
    protocolFlag: false,
  });
  fixture.advance(20 * 60_000);
  await fixture.run("coverage", "v1");
  const downgraded = await fixture.read();
  assert.equal(downgraded.coverage_status, "unknown");
  assert.equal(downgraded.totals.coverage_percent, null);
  assert.deepEqual(await recordState(currentRecords), before);
  recordStage({ name: "actual-predecessor-client-cannot-promote-overcap-v2", api: downgraded });
  const recordTree = join(output, "exported-record-tree");
  for (const record of before.export.records) {
    if (record.deleted) continue;
    const folder = join(recordTree, "openclaw-core", record.section);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, record.id + ".md"), record.content);
  }
  const completeCache = await withReplayClock(Date.parse(completeApi.generated_at), () =>
      aggregateRecords(recordTree, {}, undefined, Date.parse(completeApi.generated_at)),
    ),
    blockedCache = await withReplayClock(Date.parse(blocked.generated_at), () =>
      aggregateRecords(recordTree, {}, undefined, Date.parse(blocked.generated_at)),
    );
  assert.ok(completeCache.repositories.length);
  const metadata = (path) => globalThis.fetch(new URL(path, "https://api.github.com/"));
  const completePublic = await publicDashboardInputs(completeCache, completeApi, metadata),
    blockedPublic = await publicDashboardInputs(blockedCache, blocked, metadata);
  writeFileSync(
    join(output, "current-complete-public-build.json"),
    JSON.stringify(completePublic, null, 2),
  );
  writeFileSync(
    join(output, "current-blocked-public-build.json"),
    JSON.stringify(blockedPublic, null, 2),
  );
  const predecessorSources = Object.fromEntries(
    [
      "dashboard/worker.ts",
      "dashboard/exact-review-queue.ts",
      "dashboard/exact-review-direct-publication.ts",
      "dashboard/canonical-bodies.ts",
      "src/hosted-target-admission.ts",
      "test/exact-review-test-storage.ts",
      "src/repair/target-fanout.ts",
      "dist/repair/target-fanout.js",
      "dashboard-site/scripts/coverage.ts",
    ].map((p) => [p, sha(readFileSync(join(prior, p)))]),
  );
  const currentPaths = [
      "src/repair/target-fanout.ts",
      "src/repair/coverage-summary.ts",
      "dashboard/worker.ts",
      "dashboard/exact-review-queue.ts",
      "dashboard/exact-review-direct-publication.ts",
      "dashboard/canonical-bodies.ts",
      "src/hosted-target-admission.ts",
      "test/fixtures/review-coverage-cli.ts",
      "test/fixtures/fleet-coverage-query.ts",
      "docs/proof/review-coverage-census/compatibility.mjs",
      "docs/proof/review-coverage-census/compatibility-browser.mjs",
      "dist/repair/target-fanout.js",
      "dist/repair/coverage-summary.js",
    ],
    sourceHashes = Object.fromEntries(
      currentPaths.map((p) => [p, sha(readFileSync(join(root, p)))]),
    );
  assert.deepEqual(
    sourceHashes,
    Object.fromEntries(Object.keys(sourceHashes).map((p) => [p, sourceBefore[p]])),
  );
  for (const p of paths)
    assert.equal(
      sha(readFileSync(join(prior, p))),
      oldSource[p].sha256,
      "predecessor source after builds: " + p,
    );
  const result = {
    head,
    headTree,
    provider: process.env.CRABBOX_PROVIDER ?? "host-supporting-only",
    image: process.env.CRABBOX_IMAGE ?? null,
    lease: process.env.CRABBOX_LEASE ?? null,
    predecessor: {
      commit: base,
      tree: oldTree,
      canonicalStorageFormat: oldRecords.storageFormatSync(),
      canonicalBodyFormat: "external immutable body read through the normal async API",
      admittedItems: before.queueItems.length,
      tracked: paths.length,
      sourceManifestSha256: sha(JSON.stringify(oldSource)),
      sources: predecessorSources,
    },
    sourceHashes,
    realStarted,
    realEnded: new Date().toISOString(),
    node: process.version,
    maxRssKiB: process.resourceUsage().maxRSS,
    seed: {
      api: "actual predecessor validateDirectPublicationPlan -> prepareCanonicalWrites -> accept; actual predecessor canonical commit owner",
      recordBodySha256: sha(recordText),
      receipt: seed,
      predecessorTiering: {
        inlineSeedFormat,
        previewSha256: tieringPreview.sha256,
        activation: tieringActivation,
        passes: tieringPasses,
        syntheticQualificationOnly: true,
      },
      secondFormatTwoSeed: secondSeed,
      admissionSeed: admissionSeedReceipt,
      historySeed: {
        path: "/internal/state/records/commits",
        body: JSON.parse(historySeedBody),
        receipt: historySeedReceipt,
      },
      bodyWrites,
    },
    stages,
    seedRequests: fixture.calls,
    queries: fixture.queries,
    countExchanges: fixture.countExchanges,
    candidateCanonicalStorageFormat: currentRecords.storageFormatSync(),
    preservedCanonical: true,
    preservedAdmission: true,
    preservedHistory: true,
    sameStorage: true,
    snapshotDigests: {
      predecessor: sha(JSON.stringify(before)),
      upgraded: sha(JSON.stringify(upgradedState)),
      after: sha(JSON.stringify(await recordState(currentRecords))),
    },
    workingTreeCandidate,
    limits:
      "Controlled synthetic public source/storage, not captured production state. Actual pinned03 owner APIs create state; same KV/SQLite instance upgrades. No historical versions beyond this predecessor are claimed. Browser stage is not executed unless separately requested.",
  };
  writeFileSync(
    join(output, "predecessor-source-manifest.json"),
    JSON.stringify(oldSource, null, 2),
  );
  compatibilityResult = result;
  writeFileSync(join(output, "provenance.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(output, "old-private-api.json"), JSON.stringify(oldApi, null, 2));
  writeFileSync(join(output, "upgraded-private-api.json"), JSON.stringify(upgraded, null, 2));
  writeFileSync(
    join(output, "current-complete-private-api.json"),
    JSON.stringify(completeApi, null, 2),
  );
  writeFileSync(join(output, "current-blocked-private-api.json"), JSON.stringify(blocked, null, 2));
} finally {
  fixture.close();
}

if (process.argv.includes("--browser")) {
  compatibilityResult.browser = [];
  for (const [name, complete] of [
    ["current-complete", true],
    ["current-blocked", false],
  ]) {
    const selected = JSON.parse(readFileSync(join(output, name + "-public-build.json"))),
      capture = await captureCompatibilityBrowser({
        selected,
        output: join(output, name + "-browser"),
        evaluation: selected.coverage.generated_at,
        executionStartedAt: realStarted,
        complete,
      });
    compatibilityResult.browser.push({ name, ...capture });
  }
  writeFileSync(join(output, "provenance.json"), JSON.stringify(compatibilityResult, null, 2));
}
console.log(
  JSON.stringify({
    head,
    predecessor: base,
    stages: compatibilityResult.stages.map((s) => s.name),
    sameStorage: true,
    canonical: true,
    admission: true,
    history: true,
    snapshotDigests: compatibilityResult.snapshotDigests,
    browser: compatibilityResult.browser ?? "not requested",
    maxRssKiB: compatibilityResult.maxRssKiB,
  }),
);
