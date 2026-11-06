// Run from the repository: node docs/proof/ui-live-coverage/coverage-accept-operations.mjs <pinned-base-sha>
// Synthetic-only native SQLite proof. Never uses credentials or production data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const base = process.argv[2];
assert.match(base ?? "", /^[a-f0-9]{40}$/, "Supply the pinned intended base commit");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const sourceClean = !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
const scratch = resolve(root, ".openclaw/tmp/accept-operations");
await mkdir(scratch, { recursive: true });
const output = await mkdtemp(resolve(scratch, "native-"));
const baseline = resolve(output, "baseline");
await mkdir(baseline);
execFileSync("git", ["archive", "--output=" + resolve(output, "baseline.tar"), base]);
execFileSync("tar", ["-xf", resolve(output, "baseline.tar"), "-C", baseline]);
const require = createRequire(import.meta.url);
const mfRequire = createRequire(require.resolve("miniflare"));
const versions = {
  node: process.version,
  miniflare: require("miniflare/package.json").version,
  workerd: mfRequire("workerd/package.json").version,
  esbuild: require("esbuild/package.json").version,
};
const specs = [
  { name: "core", issues: 4865, pulls: 2881 },
  { name: "enterprise", issues: 107, pulls: 153 },
  ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
];
const results = [];
for (const [name, source] of [
  ["base", baseline],
  ["candidate", root],
]) {
  const worker = resolve(output, name + ".mjs");
  const workerSource = (
    await readFile(
      resolve(root, "docs/proof/ui-live-coverage/coverage-accept-operations.worker.ts"),
      "utf8",
    )
  ).replaceAll(
    '"../../../dashboard/',
    JSON.stringify(resolve(source, "dashboard") + "/").slice(0, -1),
  );
  await build({
    stdin: {
      contents: workerSource,
      resolveDir: root,
      sourcefile: "synthetic-proof-worker.ts",
      loader: "ts",
    },
    outfile: worker,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const runner = resolve(output, name + "-runner.mjs");
  await build({
    stdin: {
      contents:
        "export {runReviewCoverageCensus,censusHttpControl,censusQuery,censusQueryPages} from " +
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
  const { runReviewCoverageCensus, censusHttpControl, censusQuery, censusQueryPages } =
    await import(pathToFileURL(runner));
  const secret = "synthetic-only-no-production-secret";
  let outbound = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "proof",
          modules: true,
          scriptPath: worker,
          compatibilityDate: "2026-05-11",
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
      durableObjectsPersist: resolve(output, name + "-state"),
      r2Buckets: [],
    }),
  );
  const state = async () => (await mf.dispatchFetch("http://local/proof-state")).json();
  let fault = false;
  const diagnostics = [];
  const control = censusHttpControl({
    baseUrl: "https://local",
    secret,
    fetchImpl: async (url, init) => {
      const response = await mf.dispatchFetch(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          ...(fault ? { "x-proof-fault": "receipt" } : {}),
        },
      });
      if (!response.ok) diagnostics.push((await response.clone().json()).diagnostic);
      return response;
    },
  });
  try {
    const repositories = specs.map((spec) => ({
      repo: "proof/" + spec.name,
      id: "ID_" + spec.name,
      revision: "policy-v1",
      scope: "eligible",
      visibility: "public",
      countsAt: new Date().toISOString(),
      issues: spec.issues,
      pulls: spec.pulls,
    }));
    const attempt = "synthetic-valid";
    await control("/internal/review-coverage/census/start", { version: 2, attempt, repositories });
    const before = await state();
    const totals = { queries: 0, accepted: 0, failed: 0 };
    for (let i = 0; i < 40; i++) {
      const result = await runReviewCoverageCensus({
        repositories,
        query,
        control,
        attempt,
        now: () => Date.now(),
      });
      assert.equal(result.failed, 0);
      assert.ok(result.queries <= 25);
      for (const key of Object.keys(totals)) totals[key] += result[key];
    }
    const after = await state();
    assert.equal(after.complete, 145);
    assert.equal(totals.accepted, 736);
    const nonCensus = (snapshot) =>
      Object.fromEntries(
        Object.entries(snapshot.tables).filter(([table]) => !table.startsWith("coverage_census_")),
      );
    assert.deepEqual(nonCensus(after), nonCensus(before));
    assert.deepEqual(after.kv, before.kv);
    assert.equal(after.alarm, before.alarm);
    assert.equal(Object.keys(nonCensus(after)).length, 58);
    const negativeAttempt = attempt;
    await control("/internal/review-coverage/census/start", {
      version: 2,
      attempt: negativeAttempt,
      repositories: [
        {
          ...repositories[2],
          repo: "proof/negative",
          id: "ID_negative",
          revision: "synthetic-negative-policy",
          countsAt: new Date().toISOString(),
        },
      ],
    });
    const next = await control("/internal/review-coverage/census/next", {
      version: 2,
      attempt: negativeAttempt,
    });
    const pages = censusQueryPages(
      query(censusQuery(next.work)),
      next.work,
      new Date().toISOString(),
    );
    pages[0].revisionNumber++;
    const checkpointBefore = await state();
    await assert.rejects(
      control("/internal/review-coverage/census/accept", {
        version: 2,
        attempt: negativeAttempt,
        requestId: "synthetic-checkpoint",
        pages,
      }),
      { message: "coverage_checkpoint_rejected" },
    );
    assert.deepEqual(await state(), checkpointBefore);
    const checkpoint = diagnostics.at(-1);
    assert.deepEqual(
      checkpoint,
      name === "base"
        ? { phase: "accept", category: "unclassified" }
        : {
            phase: "accept",
            category: "unclassified",
            operation: "checkpoint",
            fault: "checkpoint",
          },
    );
    pages[0].revisionNumber--;
    fault = true;
    await mf.dispatchFetch("http://local/proof-arm");
    await assert.rejects(
      control("/internal/review-coverage/census/accept", {
        version: 2,
        attempt: negativeAttempt,
        requestId: "synthetic-receipt",
        pages,
      }),
      { message: "coverage_checkpoint_rejected" },
    );
    assert.deepEqual(await state(), checkpointBefore);
    const receipt = diagnostics.at(-1);
    assert.deepEqual(
      receipt,
      name === "base"
        ? { phase: "accept", category: "unclassified" }
        : { phase: "accept", category: "unclassified", operation: "receipt", fault: "type_error" },
    );
    fault = false;
    assert.ok(
      await control("/internal/review-coverage/census/accept", {
        version: 2,
        attempt: negativeAttempt,
        requestId: "synthetic-receipt",
        pages,
      }),
    );
    const denialBefore = await state();
    for (const method of ["GET", "POST"]) {
      const denied = await mf.dispatchFetch("http://local/internal/review-coverage/census/accept", {
        method,
        headers: { "x-proof-fault": "receipt" },
        ...(method === "POST"
          ? { body: '{"version":2,"malicious":"private-sql-token-cursor"}' }
          : {}),
      });
      assert.ok(denied.status >= 400);
      assert.ok(!(await denied.text()).includes('"operation"'));
    }
    assert.deepEqual(await state(), denialBefore);
    const capacity = await control("/internal/review-coverage/census/start", {
      version: 2,
      attempt,
      repositories: [
        { ...repositories[0], issues: 25000, pulls: 0, countsAt: new Date().toISOString() },
      ],
    });
    assert.equal(capacity.capacityBlocked, true);
    const capacityAfter = await state();
    assert.deepEqual(nonCensus(capacityAfter), nonCensus(after));
    assert.deepEqual(capacityAfter.kv, after.kv);
    assert.equal(capacityAfter.alarm, after.alarm);
    assert.equal(outbound, 0);
    const limits = await (await mf.dispatchFetch("http://local/proof-limits")).json();
    assert.deepEqual(limits, [
      { binds: 100, ok: true },
      { binds: 101, ok: false },
    ]);
    assert.ok(!JSON.stringify(diagnostics).includes("private-sql-token-cursor"));
    results.push({
      source: name,
      totals,
      repositories: 145,
      items: 8149,
      completeStates: after.complete,
      nonCensusTables: 58,
      nonCensusRowsUnchanged: true,
      kvUnchanged: true,
      alarm: after.alarm,
      checkpoint,
      receipt,
      unsignedDenialsUnchanged: true,
      identityFence25000Blocked: true,
      outbound,
      limits,
      bundleSha256: createHash("sha256")
        .update(await readFile(worker))
        .digest("hex"),
    });
  } finally {
    await mf.dispose();
  }
}
const evidence = {
  head,
  base,
  sourceTree,
  sourceClean,
  harnessSha256: Object.fromEntries(
    await Promise.all(
      ["coverage-accept-operations.mjs", "coverage-accept-operations.worker.ts"].map(
        async (name) => [
          name,
          createHash("sha256")
            .update(await readFile(resolve(root, "docs/proof/ui-live-coverage", name)))
            .digest("hex"),
        ],
      ),
    ),
  ),
  versions,
  platform: process.platform,
  provider: "local-workerd-not-container",
  compatibilityDate: "2026-05-11",
  results,
  limits: [
    "Clean synthetic state, not production data",
    "Fault injection proves mapping and rollback only, not production root cause",
    "Cached engine differs from hosted Cloudflare",
    "No R2 binding, credentials, production I/O, or deployment",
  ],
};
await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ ...evidence, artifact: resolve(output, "evidence.json") }, null, 2));

function query(text) {
  const matches = [
    ...text.matchAll(
      /r(\d+):repository\(owner:"[^"]+",name:"([^"]+)"\) { id nameWithOwner (issues|pullRequests)\(states:OPEN,orderBy:{field:CREATED_AT,direction:ASC},first:100,after:(null|"[^"]+")\)/g,
    ),
  ];
  assert.ok(matches.length);
  return {
    data: Object.fromEntries(
      matches.map((m) => {
        const [, alias, repo, kind, cursor] = m;
        const spec =
          repo === "negative" ? { issues: 1, pulls: 0 } : specs.find((item) => item.name === repo);
        assert.ok(spec);
        const count = kind === "issues" ? spec.issues : spec.pulls;
        const start = cursor === "null" ? 0 : Number(JSON.parse(cursor).slice(1));
        const end = Math.min(start + 100, count);
        return [
          "r" + alias,
          {
            id: "ID_" + repo,
            nameWithOwner: "proof/" + repo,
            [kind]: {
              totalCount: count,
              pageInfo: { hasNextPage: end < count, endCursor: end > start ? "c" + end : null },
              nodes: Array.from({ length: end - start }, (_, n) => ({
                number: start + n + 1,
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
