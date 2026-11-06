// node docs/proof/ui-live-coverage/coverage-observation-window.mjs <pinned-base-sha>
// Real signed Worker -> ExactReviewQueue -> workerd SQLite; synthetic local data only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const root = process.cwd(),
  base = process.argv[2];
assert.match(base ?? "", /^[a-f0-9]{40}$/);
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const sourceClean = !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
const scratch = resolve(root, ".openclaw/tmp/observation-window-fix");
await mkdir(scratch, { recursive: true });
const output = await mkdtemp(resolve(scratch, "native-"));
const baseline = resolve(output, "baseline");
await mkdir(baseline);
execFileSync("git", ["archive", "-o", resolve(output, "baseline.tar"), base]);
execFileSync("tar", ["-xf", resolve(output, "baseline.tar"), "-C", baseline]);
const require = createRequire(import.meta.url),
  mfRequire = createRequire(require.resolve("miniflare"));
const versions = {
  node: process.version,
  miniflare: require("miniflare/package.json").version,
  workerd: mfRequire("workerd/package.json").version,
  esbuild: require("esbuild/package.json").version,
};
assert.equal(versions.miniflare, "5.20260911.0-alpha");
assert.equal(versions.workerd, "1.20260911.1");
const bundles = {};
for (const [name, source] of [
  ["base", baseline],
  ["candidate", root],
]) {
  const workerFile = resolve(output, name + "-worker.mjs"),
    runner = resolve(output, name + "-producer.mjs");
  const fixture = (
    await readFile(
      resolve(root, "docs/proof/ui-live-coverage/coverage-observation-window.worker.ts"),
      "utf8",
    )
  ).replaceAll("../../../dashboard/", resolve(source, "dashboard") + "/");
  await build({
    stdin: { contents: fixture, resolveDir: root, sourcefile: "temporal-worker.ts", loader: "ts" },
    outfile: workerFile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  await build({
    stdin: {
      contents:
        "export * from " +
        JSON.stringify(resolve(source, "src/repair/review-coverage-census.ts")) +
        ";",
      resolveDir: root,
    },
    outfile: runner,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
  });
  bundles[name] = {
    workerFile,
    producer: await import(pathToFileURL(runner)),
    workerSha256: createHash("sha256")
      .update(await readFile(workerFile))
      .digest("hex"),
    producerSha256: createHash("sha256")
      .update(await readFile(runner))
      .digest("hex"),
  };
}
const specs = [
  { name: "core", issues: 4865, pulls: 2881 },
  { name: "enterprise", issues: 107, pulls: 153 },
  ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
];
const results = [],
  secret = "synthetic-only-no-production-secret";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function nonCensus(s) {
  return Object.fromEntries(
    Object.entries(s.tables).filter(([name]) => !name.startsWith("coverage_census_")),
  );
}
async function run({
  name,
  server = "candidate",
  client = "candidate",
  offset = 0,
  fleet = false,
  legacy = false,
}) {
  const trace = [];
  let outbound = 0,
    serverOffset = 0,
    queryWork,
    actualQueries = 0;
  const producer = bundles[client].producer;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "proof",
          modules: true,
          scriptPath: bundles[server].workerFile,
          compatibilityDate: "2026-06-25",
          bindings: { CLAWSWEEPER_WEBHOOK_SECRET: secret },
          outboundService: () => {
            outbound++;
            return new Response("blocked", { status: 502 });
          },
          durableObjects: {
            EXACT_REVIEW_QUEUE: { className: "ExactReviewQueue", useSQLite: true },
          },
        },
      ],
      r2Buckets: [],
    }),
  );
  const fetchImpl = async (url, init) => {
    // The production Worker intentionally strips arbitrary headers before DO forwarding.
    // Configure the independent TEST clock out-of-band, then use the untouched signed route.
    await mf.dispatchFetch("https://local/proof-clock", {
      headers: { "x-proof-clock-offset": String(serverOffset) },
    });
    const response = await mf.dispatchFetch(url, init);
    const body = await response.clone().json();
    if (new URL(url).pathname.endsWith("/next")) queryWork = body.work;
    trace.push({
      path: new URL(url).pathname,
      status: response.status,
      serverAt: Number(response.headers.get("x-proof-server-time")),
      producerAt: Date.now() + offset,
      request: JSON.parse(init.body),
      response: body,
    });
    return response;
  };
  const control = producer.censusHttpControl({ baseUrl: "https://local", secret, fetchImpl });
  const state = async () => (await mf.dispatchFetch("https://local/proof-state")).json();
  let error,
    before,
    after,
    observation,
    totals = { queries: 0, accepted: 0, failed: 0 };
  try {
    // Bootstrap the same production schema gate before the immutability snapshot.
    await control("/internal/review-coverage/census/next", {
      version: 2,
      attempt: "bootstrap",
    }).catch(() => {});
    before = await state();
    if (!legacy && producer.prepareCensusObservation)
      observation = await producer.prepareCensusObservation({
        baseUrl: "https://local",
        secret,
        fetchImpl,
      });
    // Source metadata is read AFTER the prepare response; countsAt is producer provenance in legacy only.
    await sleep(10);
    const population = (fleet ? specs : [{ name: "tiny", issues: 1, pulls: 1 }]).map((s) => ({
      repo: "fixture/" + s.name,
      id: "ID_" + s.name,
      revision: "policy-v1",
      visibility: "public",
      scope: "eligible",
      issues: s.issues,
      pulls: s.pulls,
      countsAt: new Date(Date.now() + offset).toISOString(),
    }));
    const attempt = observation?.attempt ?? "legacy-proof";
    for (let i = 0; i < (fleet ? 40 : 1); i++) {
      const result = await producer.runReviewCoverageCensus({
        repositories: population,
        observation,
        attempt,
        control,
        now: () => Date.now() + offset,
        query: async (text) => {
          actualQueries++;
          // Real query delay plus an independently advancing server epoch. No SQL or transport mock.
          await sleep(fleet ? 2 : 300);
          serverOffset += fleet ? 1000 : 50;
          const data = query(text, population);
          assert.equal(queryWork.length, Object.keys(data.data).length);
          return data;
        },
      });
      for (const key of Object.keys(totals)) totals[key] += result[key];
    }
    after = await state();
    assert.deepEqual(nonCensus(after), nonCensus(before));
    assert.equal(Object.keys(nonCensus(after)).length, 58);
    assert.deepEqual(after.kv, before.kv);
    assert.equal(after.alarm, before.alarm);
    assert.equal(after.alarm, null);
    assert.equal(outbound, 0);
    const states = after.tables.coverage_census_repositories.map((r) => JSON.parse(r.state));
    const complete = states.filter((s) => s.complete).length;
    if ((server === "candidate" && client === "candidate" && !legacy) || offset === 0) {
      assert.equal(totals.failed, 0);
      assert.equal(complete, population.length);
      if (fleet) {
        assert.equal(totals.accepted, 736);
        assert.equal(after.tables.coverage_census_items.length, 8149);
      }
      for (const state of states)
        assert.ok(Date.parse(state.complete.start) <= Date.parse(state.complete.end));
    }
    const counterexamples = [];
    if (name === "fixed-120000") {
      const oldPage = trace.find((t) => t.path.endsWith("/accept")).request.pages[0];
      serverOffset += 21 * 60_000;
      const epoch = await producer.prepareCensusObservation({
        baseUrl: "https://local",
        secret,
        fetchImpl,
      });
      const repositories = population.map((r) => ({
        ...r,
        countsAt: epoch.observationWindow.startedAt,
      }));
      await control("/internal/review-coverage/census/start", {
        version: 2,
        ...epoch,
        observedAt: epoch.observationWindow.startedAt,
        repositories,
      });
      const assignment = await control("/internal/review-coverage/census/next", {
        version: 2,
        attempt: epoch.attempt,
      });
      await sleep(1000);
      const raw = query(producer.censusQuery(assignment.work), repositories);
      // A source update INSIDE the query window must not be mislabeled as future-at-start.
      const changedAt = new Date(Date.now() + serverOffset).toISOString();
      raw.data.r0[
        assignment.work[0].kind === "issue" ? "issues" : "pullRequests"
      ].nodes[0].updatedAt = changedAt;
      await sleep(1000);
      const pages = producer.censusQueryPages(
        raw,
        assignment.work,
        new Date(Date.now() + offset).toISOString(),
      );
      assert.ok(Date.parse(changedAt) > Date.parse(pages[0].observationWindow.startedAt));
      const reject = async (label, changed) => {
        await assert.rejects(
          control("/internal/review-coverage/census/accept", {
            version: 2,
            attempt: epoch.attempt,
            requestId: "negative-" + label,
            pages: changed,
          }),
          { message: "coverage_checkpoint_rejected" },
        );
        counterexamples.push(label);
      };
      for (const [label, mutate] of [
        [
          "forged-window",
          (p) => {
            p.observationWindow.id = "forged";
          },
        ],
        [
          "future-window",
          (p) => {
            p.observationWindow.startedAt = new Date(
              Date.now() + serverOffset + 3600000,
            ).toISOString();
          },
        ],
        [
          "stale-window",
          (p) => {
            p.observationWindow.startedAt = new Date(
              Date.parse(p.observationWindow.startedAt) - 1,
            ).toISOString();
          },
        ],
        [
          "future-identity",
          (p) => {
            p.items[0].updated_at = new Date(Date.now() + serverOffset + 3600000).toISOString();
          },
        ],
        [
          "wrong-pass",
          (p) => {
            p.pass++;
          },
        ],
        [
          "wrong-revision",
          (p) => {
            p.revisionNumber++;
          },
        ],
        [
          "wrong-generation",
          (p) => {
            p.generation = "old";
          },
        ],
        [
          "wrong-cursor",
          (p) => {
            p.cursor = "old";
          },
        ],
        [
          "clock-downgrade",
          (p) => {
            p.observedAt = changedAt;
            delete p.observationWindow;
          },
        ],
      ]) {
        const changed = structuredClone(pages);
        mutate(changed[0]);
        await reject(label, changed);
      }
      await reject("previous-metadata-epoch", [oldPage]);
      const accepted = await control("/internal/review-coverage/census/accept", {
        version: 2,
        attempt: epoch.attempt,
        requestId: "fresh-long-query",
        pages,
      });
      assert.equal(accepted.accepted, true);
      const replay = await control("/internal/review-coverage/census/accept", {
        version: 2,
        attempt: epoch.attempt,
        requestId: "fresh-long-query",
        pages,
      });
      assert.equal(replay.replayed, true);
      await reject("different-receipt-replay", pages);
      const wrong = producer.censusHttpControl({
        baseUrl: "https://local",
        secret: "wrong-synthetic-secret",
        fetchImpl,
      });
      await assert.rejects(
        wrong("/internal/review-coverage/census/prepare", {
          version: 2,
          attempt: "wrong-signature",
        }),
      );
      counterexamples.push("HMAC");
      assert.equal(
        (await mf.dispatchFetch("https://local/internal/review-coverage/census/prepare")).status,
        400,
      );
      counterexamples.push("method");
      const final = await state();
      assert.deepEqual(nonCensus(final), nonCensus(before));
      assert.deepEqual(final.kv, before.kv);
      assert.equal(final.alarm, null);
      // Preserve the production 20,000-identity fence; no widened capacity as a clock cure.
      serverOffset += 6 * 60_000;
      const bounded = await producer.prepareCensusObservation({
        baseUrl: "https://local",
        secret,
        fetchImpl,
      });
      const capacity = await control("/internal/review-coverage/census/start", {
        version: 2,
        ...bounded,
        observedAt: bounded.observationWindow.startedAt,
        repositories: [
          {
            ...repositories[0],
            issues: 25000,
            pulls: 0,
            countsAt: bounded.observationWindow.startedAt,
          },
        ],
      });
      assert.equal(capacity.capacityBlocked, true);
      counterexamples.push("25000-identities");
      const capacityState = await state();
      assert.deepEqual(nonCensus(capacityState), nonCensus(before));
      assert.deepEqual(capacityState.kv, before.kv);
      assert.equal(capacityState.alarm, null);
    }
    results.push({
      name,
      server,
      client,
      offset,
      fleet,
      totals,
      actualQueries,
      complete,
      outbound,
      counterexamples,
      nonCensusTables: 58,
      immutable: true,
      clockNegotiated: !!observation,
      trace,
    });
  } catch (e) {
    error = String(e);
    results.push({
      name,
      server,
      client,
      offset,
      fleet,
      totals,
      actualQueries,
      error,
      trace,
      outbound,
      state: await state(),
    });
  } finally {
    await writeFile(resolve(output, name + ".json"), JSON.stringify(results.at(-1), null, 2));
    await mf.dispose();
  }
  if ((server === "candidate" && client === "candidate" && !legacy) || offset === 0)
    assert.equal(error, undefined, name);
}
await run({ name: "base-behind", server: "base", client: "base", offset: -500 });
await run({ name: "base-ahead", server: "base", client: "base", offset: 500 });
for (const offset of [-120000, -500, 500, 120000]) await run({ name: "fixed-" + offset, offset });
await run({ name: "large-two-witness-fleet", offset: -500, fleet: true });
await run({ name: "old-client-new-worker", client: "base", offset: 0, legacy: true });
await run({ name: "new-client-old-worker", server: "base", offset: 0 });
await persistedLegacyUpgrade();
const behind = results.find((r) => r.name === "base-behind"),
  ahead = results.find((r) => r.name === "base-ahead");
assert.ok(behind.trace.some((t) => t.response.diagnostic?.fault === "observation_window"));
assert.ok(
  ahead.trace.some(
    (t) =>
      t.response.diagnostic?.phase === "start" &&
      t.response.diagnostic?.category === "invalid_checkpoint",
  ),
);
assert.equal(results.find((r) => r.name === "new-client-old-worker").clockNegotiated, false);
const artifact = {
  base,
  head,
  sourceTree,
  sourceClean,
  versions,
  provider: "local-miniflare-workerd-sqlite",
  outbound: 0,
  bundles: Object.fromEntries(
    Object.entries(bundles).map(([k, v]) => [
      k,
      { workerSha256: v.workerSha256, producerSha256: v.producerSha256 },
    ]),
  ),
  results,
  limits:
    "Synthetic local proof, not a live offset measurement or hosted recovery claim; no production credentials, Store, R2, dispatch, deploy, or GitHub calls.",
};
await writeFile(resolve(output, "result.json"), JSON.stringify(artifact, null, 2));
console.log(
  JSON.stringify(
    { output, base, head, sourceClean, versions, results: results.map(({ trace, ...r }) => r) },
    null,
    2,
  ),
);
function query(text, population) {
  const matches = [
    ...text.matchAll(
      /r(\d+):repository\(owner:"[^"]+",name:"([^"]+)"\) { id nameWithOwner (issues|pullRequests)\(states:OPEN,orderBy:{field:CREATED_AT,direction:ASC},first:100,after:(null|"[^"]+")\)/g,
    ),
  ];
  assert.ok(matches.length);
  return {
    data: Object.fromEntries(
      matches.map(([, alias, name, kind, cursor]) => {
        const spec = population.find((s) => s.repo === "fixture/" + name);
        assert.ok(spec);
        const count = kind === "issues" ? spec.issues : spec.pulls,
          start = cursor === "null" ? 0 : Number(JSON.parse(cursor).slice(1)),
          end = Math.min(count, start + 100);
        return [
          "r" + alias,
          {
            id: spec.id,
            nameWithOwner: spec.repo,
            [kind]: {
              totalCount: count,
              pageInfo: { hasNextPage: end < count, endCursor: end > start ? "c" + end : null },
              nodes: Array.from({ length: end - start }, (_, i) => ({
                number: start + i + 1,
                updatedAt: "2026-11-01T00:00:00Z",
                ...(kind === "pullRequests" ? { headRefOid: "a".repeat(40) } : {}),
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                timelineItems: { nodes: [], pageInfo: { hasNextPage: false } },
              })),
            },
          },
        ];
      }),
    ),
  };
}

async function persistedLegacyUpgrade() {
  const statePath = resolve(output, "legacy-upgrade-state");
  let mf,
    serverOffset = 0,
    outbound = 0;
  const trace = [];
  const population = [
    {
      repo: "fixture/upgrade",
      id: "ID_upgrade",
      revision: "policy-v1",
      visibility: "public",
      scope: "eligible",
      issues: 101,
      pulls: 1,
      countsAt: new Date().toISOString(),
    },
  ];
  const create = (source) =>
    new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "proof",
            modules: true,
            scriptPath: bundles[source].workerFile,
            compatibilityDate: "2026-06-25",
            bindings: { CLAWSWEEPER_WEBHOOK_SECRET: secret },
            outboundService: () => {
              outbound++;
              return new Response("blocked", { status: 502 });
            },
            durableObjects: {
              EXACT_REVIEW_QUEUE: { className: "ExactReviewQueue", useSQLite: true },
            },
          },
        ],
        resourcePersistencePath: statePath,
        r2Buckets: [],
      }),
    );
  const state = async () => (await mf.dispatchFetch("https://local/proof-state")).json();
  const fetchImpl = async (url, init) => {
    await mf.dispatchFetch("https://local/proof-clock", {
      headers: { "x-proof-clock-offset": String(serverOffset) },
    });
    const response = await mf.dispatchFetch(url, init);
    trace.push({
      path: new URL(url).pathname,
      status: response.status,
      serverAt: Number(response.headers.get("x-proof-server-time")),
      request: JSON.parse(init.body),
      response: await response.clone().json(),
    });
    return response;
  };
  try {
    mf = create("base");
    const legacy = bundles.base.producer,
      current = bundles.candidate.producer;
    const oldControl = legacy.censusHttpControl({ baseUrl: "https://local", secret, fetchImpl });
    await oldControl("/internal/review-coverage/census/next", {
      version: 2,
      attempt: "bootstrap",
    }).catch(() => {});
    const before = await state();
    const attempt = "deployed-legacy-v2";
    await oldControl("/internal/review-coverage/census/start", {
      version: 2,
      attempt,
      repositories: population,
      observedAt: new Date().toISOString(),
    });
    const first = await oldControl("/internal/review-coverage/census/next", {
      version: 2,
      attempt,
    });
    const firstPages = legacy.censusQueryPages(
      query(legacy.censusQuery(first.work), population),
      first.work,
      new Date().toISOString(),
    );
    await oldControl("/internal/review-coverage/census/accept", {
      version: 2,
      attempt,
      requestId: "legacy-persisted-page",
      pages: firstPages,
    });
    const pending = await oldControl("/internal/review-coverage/census/next", {
      version: 2,
      attempt,
    });
    const oldPages = legacy.censusQueryPages(
      query(legacy.censusQuery(pending.work), population),
      pending.work,
      new Date().toISOString(),
    );
    const persisted = await state();
    const oldState = JSON.parse(persisted.tables.coverage_census_repositories[0].state);
    assert.equal(oldState.active.connections.issue.cursor, "c100");
    assert.equal(oldState.complete, null);
    assert.equal(persisted.tables.coverage_census_items.length, 100);
    assert.ok(!oldState.active.connections.issue.observationWindow);
    await writeFile(
      resolve(output, "persisted-legacy-v2.json"),
      JSON.stringify(persisted, null, 2),
    );
    await mf.dispose();
    // Genuine engine restart: the same workerd SQLite files and DO identity, new Worker code.
    mf = create("candidate");
    const loaded = await state();
    assert.deepEqual(loaded.tables, persisted.tables);
    assert.deepEqual(loaded.kv, persisted.kv);
    assert.equal(loaded.alarm, persisted.alarm);
    const control = current.censusHttpControl({ baseUrl: "https://local", secret, fetchImpl });
    serverOffset += 6 * 60_000; // Expire the existing lease through time, never a state reset.
    const observation = await current.prepareCensusObservation({
      baseUrl: "https://local",
      secret,
      fetchImpl,
    });
    await sleep(10); // Actual metadata source read is after server preparation.
    const repositories = population.map((r) => ({
      ...r,
      countsAt: observation.observationWindow.startedAt,
    }));
    await control("/internal/review-coverage/census/start", {
      version: 2,
      ...observation,
      observedAt: observation.observationWindow.startedAt,
      repositories,
    });
    const upgraded = await state(),
      checkpoint = JSON.parse(upgraded.tables.coverage_census_repositories[0].state);
    assert.equal(checkpoint.active.id, oldState.active.id);
    assert.equal(checkpoint.active.pass, oldState.active.pass);
    assert.equal(checkpoint.active.connections.issue.cursor, "c100");
    // This is deliberately BEFORE next issues any new window: persisted legacy work cannot
    // select the legacy branch merely by omitting a witness under a negotiated lease.
    await assert.rejects(
      control("/internal/review-coverage/census/accept", {
        version: 2,
        attempt: observation.attempt,
        requestId: "legacy-cross-mode-replay",
        pages: oldPages,
      }),
      { message: "coverage_checkpoint_rejected" },
    );
    await assert.rejects(
      oldControl("/internal/review-coverage/census/accept", {
        version: 2,
        attempt,
        requestId: "expired-legacy-attempt",
        pages: oldPages,
      }),
      { message: "coverage_checkpoint_rejected" },
    );
    // Receipts remain durable and idempotent across the binary upgrade.
    const receipt = await oldControl("/internal/review-coverage/census/accept", {
      version: 2,
      attempt,
      requestId: "legacy-persisted-page",
      pages: firstPages,
    });
    assert.equal(receipt.replayed, true);
    const totals = await current.runReviewCoverageCensus({
      observation,
      repositories,
      control,
      now: () => Date.now() - 500,
      query: async (text) => {
        await sleep(20);
        serverOffset += 1000;
        return query(text, population);
      },
    });
    assert.equal(totals.failed, 0);
    const after = await state(),
      complete = JSON.parse(after.tables.coverage_census_repositories[0].state).complete;
    assert.ok(complete);
    assert.equal(complete.issues, 101);
    assert.equal(complete.pulls, 1);
    assert.equal(complete.generation, oldState.active.id);
    assert.equal(after.tables.coverage_census_items.length, 102);
    assert.deepEqual(nonCensus(after), nonCensus(before));
    assert.equal(Object.keys(nonCensus(after)).length, 58);
    assert.deepEqual(after.kv, before.kv);
    assert.equal(after.alarm, null);
    assert.equal(outbound, 0);
    await writeFile(resolve(output, "upgraded-negotiated-v2.json"), JSON.stringify(after, null, 2));
    results.push({
      name: "persisted-legacy-v2-upgrade",
      server: "base-to-candidate",
      client: "legacy-to-negotiated",
      statePath,
      loadedUnchanged: true,
      retainedCursor: "c100",
      retainedGeneration: oldState.active.id,
      retainedItemsBefore: 100,
      finalItems: 102,
      durableReceiptReplayed: true,
      missingWindowBeforeNextRejected: true,
      oldAttemptRejected: true,
      totals,
      complete: 1,
      nonCensusTables: 58,
      immutable: true,
      outbound,
      trace,
    });
  } catch (error) {
    await writeFile(
      resolve(output, "legacy-upgrade-failure.json"),
      JSON.stringify({ error: String(error), trace, state: mf ? await state() : null }, null, 2),
    );
    throw error;
  } finally {
    if (mf) await mf.dispose();
  }
}
