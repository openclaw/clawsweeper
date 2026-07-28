import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";

import { hydrateState } from "../scripts/hydrate-state.ts";
import { backfillWorkerRecords } from "../scripts/backfill-worker-records.ts";
import { verifyWorkerRecordParity } from "../scripts/verify-worker-record-parity.ts";
import {
  decideRecordAuthority,
  reconcileWorkerRecordAuthority,
} from "../scripts/reconcile-worker-records.ts";
import {
  ingestGitRecords,
  replayWorkerRecordProjections,
  type WorkerRecord,
} from "../scripts/worker-records.ts";

const repoSlug = "openclaw-openclaw";
const commitId = "c".repeat(40);
const contents = new Map([
  ["items/1", "---\nnumber: 1\n---\nbyte-identical item\n"],
  ["decision-packets/1", '{"decision":"keep"}\n'],
  [`commits/${commitId}`, "---\nsha: fixture\n---\ncommit finding\n"],
]);

test("hydrate-state Worker mode uses snapshot cold and warm paths before replaying the journal", async () => {
  const fixture = createStateFixture();
  const coldTarget = path.join(fixture.root, "worker-cold-target");
  const warmTarget = path.join(fixture.root, "worker-warm-target");
  const cacheRoot = path.join(fixture.root, "snapshot-cache");
  const fetchStats = { chunkRequests: 0 };
  const journal = [{ section: "closed" as const, id: "2", content: "journal delta\n" }];
  try {
    await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        coldTarget,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      workerFetch(contents, fetchStats, journal),
    );
    const coldChunkRequests = fetchStats.chunkRequests;
    assert.ok(coldChunkRequests > 0);
    for (const [key, content] of contents) {
      const [section, id] = key.split("/");
      const extension = section === "decision-packets" ? ".json" : ".md";
      assert.equal(
        readFileSync(
          path.join(coldTarget, "records", repoSlug, section!, `${id}${extension}`),
          "utf8",
        ),
        content,
      );
    }
    assert.equal(
      readFileSync(path.join(coldTarget, "records", repoSlug, "closed", "2.md"), "utf8"),
      "journal delta\n",
    );
    assert.equal(readFileSync(path.join(coldTarget, "jobs", "fixture.json"), "utf8"), "{}\n");
    const manifest = JSON.parse(
      readFileSync(path.join(coldTarget, ".artifacts", "worker-records-manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest, {
      schemaVersion: 2,
      source: "worker",
      repositories: {
        [repoSlug]: {
          revision: contents.size + journal.length,
          snapshotRevision: contents.size,
          snapshotBytes: snapshotArchive(contents).byteLength,
          snapshotCache: "miss",
          deltaRecords: journal.length,
          recordCount: contents.size + journal.length,
        },
      },
    });

    await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        warmTarget,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      workerFetch(contents, fetchStats, journal),
    );
    assert.equal(fetchStats.chunkRequests, coldChunkRequests);
    const warmManifest = JSON.parse(
      readFileSync(path.join(warmTarget, ".artifacts", "worker-records-manifest.json"), "utf8"),
    );
    assert.equal(warmManifest.repositories[repoSlug].snapshotCache, "hit");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("worker-mode hydration discovers slugs from the Worker and warns about git-only slugs", async () => {
  const fixture = createStateFixture();
  write(path.join(fixture.stateRoot, "records", "git-only-repo", "items", "9.md"), "orphan\n");
  const target = path.join(fixture.root, "discovery-target");
  const cacheRoot = path.join(fixture.root, "snapshot-cache");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  const healthyFetch = workerFetch(contents);
  let slugRequests = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/internal/state/records/slugs") {
      slugRequests += 1;
      const bodyText = String(init?.body || "");
      const signature = `sha256=${createHmac("sha256", "fixture-secret").update(bodyText).digest("hex")}`;
      assert.equal(
        new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
        signature,
      );
      assert.equal(bodyText, "{}");
      return Response.json({
        ok: true,
        repositories: [{ repoSlug, revision: contents.size }],
      });
    }
    return healthyFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        target,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        // setup-state always exports this env var, usually empty; an empty
        // explicit list must not suppress Worker discovery (live regression:
        // materializer runs 30348317111 / 30352195592 refused cutover).
        CLAWSWEEPER_RECORDS_REPO_SLUGS: "",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      fetchImpl,
    );
    assert.equal(slugRequests, 1);
    assert.equal(result.recordsSource, "worker");
    assert.equal(result.recordsFallback, undefined);
    assert.deepEqual(Object.keys(result.worker ?? {}), [repoSlug]);
    assert.equal(
      readFileSync(path.join(target, "records", repoSlug, "items", "1.md"), "utf8"),
      contents.get("items/1"),
    );
    // The Worker list is canonical: the git-only slug is not hydrated, only warned about.
    assert.equal(existsSync(path.join(target, "records", "git-only-repo")), false);
    const log = errors.join("\n");
    assert.match(
      log,
      new RegExp(
        `worker slug discovery: 1 repositories endpoint=/internal/state/records/slugs ` +
          `revisions=${repoSlug}:${contents.size}`,
      ),
    );
    assert.match(
      log,
      /WARNING: 1 record repo slug\(s\) exist in the git state checkout but not in the Worker record store \(un-backfilled\?\): git-only-repo/,
    );
  } finally {
    console.error = originalError;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit record repo slugs win over the environment and skip Worker discovery", async () => {
  const fixture = createStateFixture();
  const target = path.join(fixture.root, "explicit-target");
  const cacheRoot = path.join(fixture.root, "snapshot-cache");
  const healthyFetch = workerFetch(contents);
  const requestedSlugs = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.notEqual(url.pathname, "/internal/state/records/slugs");
    const body = JSON.parse(String(init?.body || "{}")) as { repoSlug?: string };
    if (body.repoSlug) requestedSlugs.add(body.repoSlug);
    return healthyFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        target,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        CLAWSWEEPER_RECORDS_REPO_SLUGS: "ignored-env-slug",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      fetchImpl,
    );
    assert.equal(result.recordsSource, "worker");
    assert.deepEqual(Object.keys(result.worker ?? {}), [repoSlug]);
    assert.deepEqual([...requestedSlugs], [repoSlug]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state refuses cutover with request evidence when slug discovery is unavailable", async () => {
  const fixture = createStateFixture();
  const target = path.join(fixture.root, "discovery-fallback-target");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    const result = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        target,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
      ],
      { CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret" },
      (async (input: string | URL | Request) => {
        // A Worker deployment that predates the slugs endpoint answers 404.
        assert.equal(new URL(String(input)).pathname, "/internal/state/records/slugs");
        return Response.json({ error: "not_found" }, { status: 404 });
      }) as typeof fetch,
    );
    assert.equal(result.recordsSource, "git");
    assert.equal(result.recordsFallback?.reason, "snapshot_store_unavailable");
    assert.equal(result.recordsFallback?.slug, undefined);
    assert.deepEqual(result.recordsFallback?.detail, {
      endpoint: "/internal/state/records/slugs",
      status: 404,
      code: "not_found",
      bodySnippet: '{"error":"not_found"}',
    });
    const refusal = errors.join("\n");
    assert.match(refusal, /WORKER RECORD CUTOVER REFUSED.*FALLING BACK TO GIT/);
    assert.match(refusal, /endpoint=\/internal\/state\/records\/slugs status=404 code=not_found/);
    assert.equal(
      readFileSync(path.join(target, "records", repoSlug, "items", "1.md"), "utf8"),
      contents.get("items/1"),
    );
  } finally {
    console.error = originalError;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state refuses Worker cutover and loudly falls back to git without snapshots", async () => {
  const fixture = createStateFixture();
  const target = path.join(fixture.root, "fallback-target");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    const result = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        target,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        repoSlug,
      ],
      { CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret" },
      async () =>
        Response.json(
          { error: "snapshot_store_unavailable", snapshotStoreAvailable: false },
          { status: 503 },
        ),
    );
    assert.equal(result.recordsSource, "git");
    assert.equal(result.recordsFallback?.reason, "snapshot_store_unavailable");
    assert.equal(result.recordsFallback?.slug, repoSlug);
    assert.deepEqual(result.recordsFallback?.detail, {
      endpoint: "/internal/state/records/snapshots/latest",
      status: 503,
      code: "snapshot_store_unavailable",
      bodySnippet: '{"error":"snapshot_store_unavailable","snapshotStoreAvailable":false}',
      succeededSlugs: 0,
    });
    const refusal = errors.join("\n");
    assert.match(refusal, /WORKER RECORD CUTOVER REFUSED.*FALLING BACK TO GIT/);
    assert.match(
      refusal,
      new RegExp(`repo=${repoSlug} .*status=503 code=snapshot_store_unavailable`),
    );
    assert.equal(
      readFileSync(path.join(target, "records", repoSlug, "items", "1.md"), "utf8"),
      contents.get("items/1"),
    );
  } finally {
    console.error = originalError;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hydrate-state refusal names the failing slug, request evidence, and prior successes", async () => {
  const fixture = createStateFixture();
  const target = path.join(fixture.root, "partial-fallback-target");
  const cacheRoot = path.join(fixture.root, "snapshot-cache");
  const missingSlug = "zz-missing";
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  const healthyFetch = workerFetch(contents);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body || "{}")) as { repoSlug?: string };
    if (body.repoSlug === missingSlug) {
      assert.ok(url.pathname.endsWith("/snapshots/latest"));
      return Response.json(
        { error: "snapshot_not_found", snapshotStoreAvailable: true },
        { status: 404 },
      );
    }
    return healthyFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await hydrateState(
      [
        "--state-dir",
        fixture.stateRoot,
        "--worktree",
        target,
        "--records-source",
        "worker",
        "--records-url",
        "https://worker.example",
        "--records-repo-slugs",
        `${repoSlug},${missingSlug}`,
      ],
      {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        CLAWSWEEPER_RECORDS_CACHE_DIR: cacheRoot,
      },
      fetchImpl,
    );
    assert.equal(result.recordsSource, "git");
    assert.equal(result.recordsFallback?.reason, "snapshot_not_found");
    assert.equal(result.recordsFallback?.slug, missingSlug);
    assert.deepEqual(result.recordsFallback?.detail, {
      endpoint: "/internal/state/records/snapshots/latest",
      status: 404,
      code: "snapshot_not_found",
      bodySnippet: '{"error":"snapshot_not_found","snapshotStoreAvailable":true}',
      succeededSlugs: 1,
    });
    const log = errors.join("\n");
    assert.match(
      log,
      new RegExp(
        `WORKER RECORD CUTOVER REFUSED: SNAPSHOT NOT FOUND \\(repo=${missingSlug} ` +
          `endpoint=/internal/state/records/snapshots/latest status=404 code=snapshot_not_found ` +
          `succeededSlugs=1 body=.*\\); FALLING BACK TO GIT RECORDS`,
      ),
    );
    assert.match(
      log,
      new RegExp(
        `\\[worker-records\\] snapshot hydrated repo=${repoSlug} revision=\\d+ ` +
          `snapshotRevision=\\d+ snapshotBytes=\\d+ cache=miss deltaRecords=\\d+ records=\\d+`,
      ),
    );
    // Fallback still materialized the git records tree.
    assert.equal(
      readFileSync(path.join(target, "records", repoSlug, "items", "1.md"), "utf8"),
      contents.get("items/1"),
    );
  } finally {
    console.error = originalError;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("record parity verifier reports matching trees and exact path/digest mismatches", async () => {
  const fixture = createStateFixture();
  try {
    const matching = await verifyWorkerRecordParity(
      {
        stateRoot: fixture.stateRoot,
        repoSlug,
        recordsUrl: "https://worker.example",
        webhookSecret: "fixture-secret",
      },
      workerFetch(contents),
    );
    assert.deepEqual(matching, {
      repoSlug,
      gitRecords: contents.size,
      workerRecords: contents.size,
      mismatches: [],
    });

    const changed = new Map(contents);
    changed.set("items/1", "different\n");
    const mismatched = await verifyWorkerRecordParity(
      {
        stateRoot: fixture.stateRoot,
        repoSlug,
        recordsUrl: "https://worker.example",
        webhookSecret: "fixture-secret",
      },
      workerFetch(changed),
    );
    assert.equal(mismatched.mismatches.length, 1);
    assert.equal(mismatched.mismatches[0]?.path, "items/1.md");
    assert.notEqual(mismatched.mismatches[0]?.gitDigest, mismatched.mismatches[0]?.workerDigest);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority reconciliation trusts GitHub-closed placement over canonical-open state", () => {
  const canonicalOpen = workerRecord("items", "42", "canonical open\n", 4);
  const result = decideRecordAuthority({
    mismatches: [
      { path: "closed/42.md", gitDigest: "a".repeat(64), workerDigest: null },
      { path: "items/42.md", gitDigest: null, workerDigest: "b".repeat(64) },
    ],
    canonicalRecords: new Map([["items/42.md", canonicalOpen]]),
    gitRecordPaths: new Set(["closed/42.md"]),
    githubStates: new Map([["42", "closed"]]),
    gitCommitTimes: new Map(),
  });

  assert.deepEqual(result.tuples, [
    {
      itemId: "42",
      verdict: "git-wins",
      reason: "GitHub is closed; canonical items placement is stale",
    },
  ]);
  assert.equal(
    result.decisions.find((entry) => entry.path === "closed/42.md")?.verdict,
    "git-wins",
  );
  assert.equal(result.decisions.find((entry) => entry.path === "items/42.md")?.verdict, "lag");
});

test("authority reconciliation imports a git-only decision packet with its tuple", () => {
  const result = decideRecordAuthority({
    mismatches: [
      {
        path: "decision-packets/43.json",
        gitDigest: "c".repeat(64),
        workerDigest: null,
      },
    ],
    canonicalRecords: new Map(),
    gitRecordPaths: new Set(["items/43.md", "decision-packets/43.json"]),
    githubStates: new Map([["43", "open"]]),
    gitCommitTimes: new Map(),
  });

  assert.deepEqual(result.tuples, [
    {
      itemId: "43",
      verdict: "git-wins",
      reason: "git-only decision-packets must be imported with its atomic tuple",
    },
  ]);
});

test("authority reconciliation tolerates agreeing-but-stale placement and keeps the ambiguous throw", () => {
  // Item 857: canonical and git both keep the item under items/, GitHub says
  // closed, and the only parity mismatch is a git-only decision packet.
  const canonicalOpen = workerRecord("items", "857", "canonical open\n", 4);
  const result = decideRecordAuthority({
    mismatches: [
      { path: "decision-packets/857.json", gitDigest: "a".repeat(64), workerDigest: null },
    ],
    canonicalRecords: new Map([["items/857.md", canonicalOpen]]),
    gitRecordPaths: new Set(["items/857.md", "decision-packets/857.json"]),
    githubStates: new Map([["857", "closed"]]),
    gitCommitTimes: new Map(),
  });

  assert.deepEqual(result.tuples, [
    {
      itemId: "857",
      verdict: "both-stale",
      reason: "GitHub is closed but git and canonical agree on items; sweep will correct placement",
    },
  ]);
  assert.equal(
    result.decisions.find((entry) => entry.path === "decision-packets/857.json")?.verdict,
    "both-stale",
  );

  // Genuinely ambiguous: stores disagree on the primary and git lacks the
  // GitHub-expected primary. This must still fail loudly.
  assert.throws(
    () =>
      decideRecordAuthority({
        mismatches: [
          { path: "decision-packets/858.json", gitDigest: "b".repeat(64), workerDigest: null },
        ],
        canonicalRecords: new Map([["items/858.md", workerRecord("items", "858", "open\n", 5)]]),
        gitRecordPaths: new Set(["decision-packets/858.json"]),
        githubStates: new Map([["858", "closed"]]),
        gitCommitTimes: new Map(),
      }),
    /Canonical placement for 858 contradicts GitHub, but git lacks closed/,
  );
});

test("reconciliation imports a git-only packet for a both-stale item keyed to canonical placement", async () => {
  const slug = "openclaw-clawsweeper";
  const packet = '{"decision":"merge"}\n';
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const item = [
    "---",
    "number: 857",
    `decision_packet_sha256: ${packetDigest}`,
    `decision_packet_path: records/${slug}/decision-packets/857.json`,
    "---",
    "shared item body",
    "",
  ].join("\n");
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-both-stale-test-"));
  const stateRoot = path.join(root, "state");
  write(path.join(stateRoot, "records", slug, "items", "857.md"), item);
  write(path.join(stateRoot, "records", slug, "decision-packets", "857.json"), packet);
  const parityReport = path.join(root, "parity.json");
  writeFileSync(
    parityReport,
    JSON.stringify({
      repoSlug: slug,
      gitRecords: 2,
      workerRecords: 1,
      mismatches: [
        { path: "decision-packets/857.json", gitDigest: packetDigest, workerDigest: null },
      ],
    }),
  );
  const summaryFile = path.join(root, "summary.md");
  writeFileSync(summaryFile, "");
  const tupleRequests: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname === "/internal/state/records/export") {
      return Response.json({
        repoSlug: slug,
        revision: 4,
        nextCursor: null,
        records: [workerRecord("items", "857", item, 1)],
      });
    }
    assert.equal(url.pathname, "/internal/state/records/tuples");
    tupleRequests.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true, accepted: true, deduped: false, revision: 2, sequence: 7 });
  }) as typeof fetch;

  try {
    const result = await reconcileWorkerRecordAuthority({
      stateRoot,
      targetRepo: "openclaw/clawsweeper",
      repoSlug: slug,
      baseUrl: "https://worker.example",
      webhookSecret: "fixture-secret",
      parityReport,
      summaryFile,
      fetch: fetchImpl,
      githubStates: () => new Map([["857", "closed"]]),
      gitCommitTimes: () => ({ times: new Map(), unavailable: new Set() }),
    });

    assert.deepEqual(result.decisions, [
      {
        path: "decision-packets/857.json",
        itemId: "857",
        verdict: "both-stale",
        reason:
          "GitHub is closed but git and canonical agree on items; sweep will correct placement",
      },
    ]);
    assert.deepEqual(result.corrections, [
      { itemId: "857", deduped: false, revision: 2, sequence: 7 },
    ]);
    assert.equal(tupleRequests.length, 1);
    assert.deepEqual(tupleRequests[0]?.operations, [
      {
        path: `records/${slug}/items/857.md`,
        expectedDigest: createHash("sha256").update(item).digest("hex"),
        contentBase64: Buffer.from(item).toString("base64"),
      },
      { path: `records/${slug}/closed/857.md`, expectedDigest: null },
      { path: `records/${slug}/plans/857.md`, expectedDigest: null },
      {
        path: `records/${slug}/decision-packets/857.json`,
        expectedDigest: null,
        contentBase64: Buffer.from(packet).toString("base64"),
      },
    ]);
    assert.match(readFileSync(summaryFile, "utf8"), /both-stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authority reconciliation keeps canonical content when its provenance is newer", () => {
  const canonical = workerRecord("items", "44", "canonical\n", 7);
  canonical.updatedAt = "2026-07-26T12:00:00.000Z";
  const result = decideRecordAuthority({
    mismatches: [
      {
        path: "items/44.md",
        gitDigest: "d".repeat(64),
        workerDigest: canonical.digest,
      },
    ],
    canonicalRecords: new Map([["items/44.md", canonical]]),
    gitRecordPaths: new Set(["items/44.md"]),
    githubStates: new Map([["44", "open"]]),
    gitCommitTimes: new Map([["items/44.md", "2026-07-26T11:00:00.000Z"]]),
  });

  assert.deepEqual(result.tuples, [
    {
      itemId: "44",
      verdict: "canonical-wins",
      reason: "canonical provenance post-dates every differing git record",
    },
  ]);
});

test("backfill importer walks all record sections and sends digest-bearing rows", async () => {
  const fixture = createStateFixture();
  const requests: unknown[] = [];
  try {
    const result = await ingestGitRecords({
      stateRoot: fixture.stateRoot,
      repoSlug,
      baseUrl: "https://worker.example",
      webhookSecret: "fixture-secret",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return Response.json({
          inserted: body.records.length,
          unchanged: 0,
          skippedNewer: 0,
          watermark: body.records.length,
        });
      },
    });
    assert.equal(result.records, contents.size);
    const rows = requests.flatMap(
      (request) => (request as { records: unknown[] }).records,
    ) as Array<{
      section: string;
      id: string;
      content: string;
      digest: string;
    }>;
    assert.deepEqual(
      rows.map((row) => `${row.section}/${row.id}`).sort(),
      [...contents.keys()].sort(),
    );
    for (const row of rows) {
      assert.equal(row.digest, createHash("sha256").update(row.content).digest("hex"));
    }

    requests.length = 0;
    const resumed = await ingestGitRecords({
      stateRoot: fixture.stateRoot,
      repoSlug,
      baseUrl: "https://worker.example",
      webhookSecret: "fixture-secret",
      maxRecordsPerBatch: 1,
      cursor: 1,
      maxBatches: 1,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return Response.json({
          inserted: body.records.length,
          unchanged: 0,
          skippedNewer: 0,
          watermark: 2,
        });
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(resumed.cursor, 1);
    assert.equal(resumed.nextCursor, 2);
    assert.equal(resumed.totalBatches, contents.size);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("canonical projection replay re-appends a complete tuple without overwriting from git", async () => {
  const packet = contents.get("decision-packets/1")!;
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const item = [
    "---",
    "number: 1",
    `decision_packet_sha256: ${packetDigest}`,
    `decision_packet_path: records/${repoSlug}/decision-packets/1.json`,
    "---",
    "byte-identical item",
    "",
  ].join("\n");
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.pathname === "/internal/state/records/export") {
      return Response.json({
        repoSlug,
        revision: 4,
        nextCursor: null,
        records: [
          workerRecord("items", "1", item, 1),
          workerRecord("decision-packets", "1", packet, 2),
        ],
      });
    }
    assert.equal(url.pathname, "/internal/state/records/tuples");
    requests.push(body);
    return Response.json({ ok: true, accepted: true, deduped: false, revision: 2, sequence: 9 });
  }) as typeof fetch;

  const result = await replayWorkerRecordProjections({
    baseUrl: "https://worker.example",
    webhookSecret: "fixture-secret",
    repoSlug,
    itemIds: ["1"],
    fetch: fetchImpl,
  });

  assert.deepEqual(result, {
    attempted: 1,
    replayed: 1,
    deduped: 0,
    failed: 0,
    failedIds: [],
    failures: [],
    available: 1,
    cursor: 0,
    nextCursor: null,
    revision: 4,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.key, `${repoSlug}/1`);
  assert.deepEqual(requests[0]?.operations, [
    {
      path: `records/${repoSlug}/items/1.md`,
      expectedDigest: createHash("sha256").update(item).digest("hex"),
      contentBase64: Buffer.from(item).toString("base64"),
    },
    { path: `records/${repoSlug}/closed/1.md`, expectedDigest: null },
    { path: `records/${repoSlug}/plans/1.md`, expectedDigest: null },
    {
      path: `records/${repoSlug}/decision-packets/1.json`,
      expectedDigest: createHash("sha256").update(packet).digest("hex"),
      contentBase64: Buffer.from(packet).toString("base64"),
    },
  ]);
});

test("canonical projection replay expresses partial and revision-ordered legacy tuples", async () => {
  const packet = '{"decision":"keep"}\n';
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const itemWithPacket = [
    "---",
    `decision_packet_sha256: ${packetDigest}`,
    `decision_packet_path: records/${repoSlug}/decision-packets/10.json`,
    "---",
    "item with no plan",
    "",
  ].join("\n");
  const itemWithPlan = "---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\nitem\n";
  const plan = "---\nreviewed_at: 2026-07-26T01:00:00Z\n---\nplan\n";
  const closed = "---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\nclosed\n";
  const staleOpen = "---\nreviewed_at: 2026-07-26T00:00:00Z\n---\nstale open\n";
  const requests = new Map<string, Array<Record<string, unknown>>>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.pathname === "/internal/state/records/export") {
      return Response.json({
        repoSlug,
        revision: 12,
        nextCursor: null,
        records: [
          workerRecord("items", "10", itemWithPacket, 1, 2),
          workerRecord("decision-packets", "10", packet, 2, 2),
          workerRecord("items", "11", itemWithPlan, 3, 2),
          workerRecord("plans", "11", plan, 4, 2),
          workerRecord("closed", "12", closed, 5, 3),
          workerRecord("plans", "12", plan, 6, 1),
          workerRecord("items", "13", staleOpen, 7, 1),
          workerRecord("closed", "13", closed, 8, 4),
        ],
      });
    }
    const itemId = String(body.key).split("/").at(-1)!;
    requests.set(itemId, body.operations);
    return Response.json({ ok: true, accepted: true, deduped: false, revision: 5, sequence: 9 });
  }) as typeof fetch;

  const result = await replayWorkerRecordProjections({
    baseUrl: "https://worker.example",
    webhookSecret: "fixture-secret",
    repoSlug,
    itemIds: ["10", "11", "12", "13"],
    fetch: fetchImpl,
  });

  assert.equal(result.replayed, 4);
  assert.equal(result.failed, 0);
  assert.equal(
    requests.get("10")?.find((entry) => String(entry.path).includes("/plans/"))?.contentBase64,
    undefined,
  );
  assert.equal(
    requests.get("11")?.find((entry) => String(entry.path).includes("/decision-packets/"))
      ?.contentBase64,
    undefined,
  );
  const closedPlan = requests.get("12")?.find((entry) => String(entry.path).includes("/plans/"));
  assert.equal(closedPlan?.expectedDigest, createHash("sha256").update(plan).digest("hex"));
  assert.equal(closedPlan?.contentBase64, undefined);
  const stalePrimary = requests.get("13")?.find((entry) => String(entry.path).includes("/items/"));
  assert.equal(stalePrimary?.expectedDigest, createHash("sha256").update(staleOpen).digest("hex"));
  assert.equal(stalePrimary?.contentBase64, undefined);
});

test("backfill replay continues after tuple rejection and fails once with every rejected id", async () => {
  const fixture = createStateFixture();
  const tupleIds: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...values) => errors.push(values.join(" "));
  console.log = (...values) => output.push(values.join(" "));
  try {
    await assert.rejects(
      backfillWorkerRecords(
        [
          "--state-dir",
          fixture.stateRoot,
          "--repo-slug",
          repoSlug,
          "--replay-projections",
          "--replay-item-ids",
          "1,2,3",
        ],
        { CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret" },
        (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input.toString());
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (url.pathname === "/internal/state/records/ingest") {
            return Response.json({
              inserted: body.records.length,
              unchanged: 0,
              skippedNewer: 0,
              watermark: 1,
            });
          }
          if (url.pathname === "/internal/state/records/export") {
            return Response.json({
              repoSlug,
              revision: 3,
              nextCursor: null,
              records: [
                workerRecord("items", "1", "---\n---\none\n", 1),
                workerRecord("items", "2", "---\n---\ntwo\n", 2),
                workerRecord("items", "3", "---\n---\nthree\n", 3),
              ],
            });
          }
          const itemId = String(body.key).split("/").at(-1)!;
          tupleIds.push(itemId);
          if (itemId === "2") {
            return Response.json(
              { error: "invalid_canonical_record_tuple", detail: "fixture rejection" },
              { status: 400 },
            );
          }
          return Response.json({ ok: true, accepted: true, deduped: false });
        }) as typeof fetch,
      ),
      /failed for 1 tuple\(s\): 2:invalid_canonical_record_tuple/,
    );
  } finally {
    console.error = originalError;
    console.log = originalLog;
    rmSync(fixture.root, { recursive: true, force: true });
  }

  assert.deepEqual(tupleIds, ["1", "2", "3"]);
  assert.ok(
    errors.some((line) =>
      line.includes(
        "rejected tuple=2/3 repo=openclaw-openclaw item=2 status=400 code=invalid_canonical_record_tuple",
      ),
    ),
  );
  const summary = JSON.parse(output.at(-1)!);
  assert.deepEqual(summary.replay.failedIds, ["2"]);
  assert.equal(summary.replay.replayed, 2);
});

test("backfill workflow is manual per-target and setup-state plumbs the opt-in Worker flag", () => {
  const workflowSource = readFileSync(".github/workflows/backfill-worker-records.yml", "utf8");
  const workflow = parse(workflowSource) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    jobs?: {
      backfill?: { steps?: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }> };
    };
  };
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.target_repo);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.cursor);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.max_batches);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.replay_projections);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.replay_item_ids);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.max_replay_tuples);
  assert.ok(workflow.on?.workflow_dispatch?.inputs?.replay_cursor);
  const setupState = workflow.jobs?.backfill?.steps?.find(
    (step) => step.uses === "./.github/actions/setup-state",
  );
  assert.equal(setupState?.with?.["records-source"], "git");
  assert.equal(setupState?.with?.["ledger-source"], "git");
  assert.match(workflowSource, /scripts\/backfill-worker-records\.ts/);
  assert.match(workflowSource, /--cursor "\$BACKFILL_CURSOR"/);
  assert.match(workflowSource, /--replay-projections --max-replay-tuples/);
  assert.match(workflowSource, /records\/\$\{\{ steps\.target\.outputs\.slug \}\}/);

  const action = readFileSync(".github/actions/setup-state/action.yml", "utf8");
  assert.match(action, /records-source:[\s\S]*?default: git/);
  assert.match(action, /ledger-source:[\s\S]*?default: git/);
  assert.match(action, /CLAWSWEEPER_RECORDS_SOURCE: \$\{\{ inputs\.records-source \}\}/);
  assert.match(action, /CLAWSWEEPER_RECORDS_URL: \$\{\{ inputs\.records-url \}\}/);
  assert.match(action, /CLAWSWEEPER_RECORDS_REPO_SLUGS: \$\{\{ inputs\.records-repo-slugs \}\}/);
  assert.match(action, /CLAWSWEEPER_RECORDS_SECRET: \$\{\{ inputs\.records-secret \}\}/);
  assert.match(action, /CLAWSWEEPER_LEDGER_SOURCE: \$\{\{ inputs\.ledger-source \}\}/);
  assert.match(
    action,
    /CLAWSWEEPER_BLOBS_CACHE_DIR: \$\{\{ inputs\.worktree-path \}\}\/\.artifacts\/worker-blobs-cache/,
  );
  assert.match(action, /uses: actions\/cache@v6/);
  assert.match(action, /steps\.records-snapshot\.outputs\.cache-key/);
  assert.match(action, /\.artifacts\/worker-records-cache/);
  assert.match(action, /inputs\.ledger-source == 'worker'/);
  assert.match(action, /\.artifacts\/worker-blobs-cache/);
});

test("worker records ops workflow snapshots and verifies one requested repository", () => {
  const workflowSource = readFileSync(".github/workflows/worker-records-ops.yml", "utf8");
  const workflow = parse(workflowSource) as {
    on?: {
      workflow_dispatch?: {
        inputs?: Record<
          string,
          { required?: boolean; type?: string; default?: string; options?: string[] }
        >;
      };
    };
    env?: Record<string, string>;
    jobs?: Record<
      string,
      {
        needs?: string;
        steps?: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }>;
      }
    >;
  };
  const inputs = workflow.on?.workflow_dispatch?.inputs;
  assert.deepEqual(inputs?.target_repo, {
    description: "Repository whose Worker records should be operated on (owner/name).",
    required: true,
    type: "string",
  });
  assert.deepEqual(inputs?.action, {
    description: "Worker records operation to run.",
    required: true,
    type: "choice",
    options: ["snapshot", "verify", "both", "reconcile"],
    default: "both",
  });
  assert.match(workflow.env?.CLAWSWEEPER_RECORDS_URL ?? "", /CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL/);

  const snapshot = workflow.jobs?.snapshot;
  const verify = workflow.jobs?.verify;
  const reconcile = workflow.jobs?.reconcile;
  assert.ok(snapshot);
  assert.ok(verify);
  assert.ok(reconcile);
  assert.equal(verify.needs, "snapshot");
  for (const job of [snapshot, verify]) {
    assert.ok(job.steps?.some((step) => step.uses === "actions/checkout@v7"));
    assert.ok(job.steps?.some((step) => step.uses === "./.github/actions/setup-pnpm"));
  }
  assert.equal(
    snapshot.steps?.some((step) => step.uses === "./.github/actions/setup-state"),
    false,
  );
  const setupState = verify.steps?.find((step) => step.uses === "./.github/actions/setup-state");
  assert.equal(setupState?.with?.["records-source"], "git");
  assert.equal(setupState?.with?.["ledger-source"], "git");
  assert.equal(setupState?.with?.["persist-credentials"], "false");
  assert.equal(
    setupState?.with?.["coordinator-enabled"],
    "${{ vars.CLAWSWEEPER_STATE_COORDINATOR_ENABLED || 'false' }}",
  );
  assert.equal(
    setupState?.with?.["coordinator-url"],
    "${{ vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai' }}",
  );

  assert.match(workflowSource, /inputs\.action == 'snapshot' \|\| inputs\.action == 'both'/);
  assert.match(
    workflowSource,
    /inputs\.action == 'verify' \|\| needs\.snapshot\.result == 'success'/,
  );
  assert.match(workflowSource, /signedPost/);
  assert.match(workflowSource, /\/internal\/state\/records\/snapshots\/trigger/);
  assert.match(workflowSource, /body: \{ repoSlug: process\.env\.TARGET_SLUG \}/);
  assert.equal(
    workflowSource.match(
      /CLAWSWEEPER_WEBHOOK_SECRET: \$\{\{ secrets\.CLAWSWEEPER_WEBHOOK_SECRET \}\}/g,
    )?.length,
    3,
  );
  assert.match(
    workflowSource,
    /pnpm run state:records:verify --[\s\\]*--state-dir clawsweeper-state[\s\\]*--repo-slug "\$TARGET_SLUG"/,
  );
  assert.match(workflowSource, /records\/\$\{\{ steps\.target\.outputs\.slug \}\}/);
  assert.match(workflowSource, /inputs\.action == 'reconcile'/);
  assert.match(workflowSource, /state:records:reconcile/);
  assert.match(workflowSource, /--summary-file "\$GITHUB_STEP_SUMMARY"/);
});

function createStateFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-worker-records-test-"));
  const stateRoot = path.join(root, "state");
  for (const [key, content] of contents) {
    const [section, id] = key.split("/");
    const extension = section === "decision-packets" ? ".json" : ".md";
    write(path.join(stateRoot, "records", repoSlug, section!, `${id}${extension}`), content);
  }
  write(path.join(stateRoot, "jobs", "fixture.json"), "{}\n");
  return { root, stateRoot };
}

function workerRecord(
  section: WorkerRecord["section"],
  id: string,
  content: string,
  storeRevision: number,
  revision = 1,
): WorkerRecord {
  return {
    section,
    id,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    revision,
    storeRevision,
    deleted: false,
  };
}

function workerFetch(
  recordsByKey: Map<string, string>,
  stats: { chunkRequests: number } = { chunkRequests: 0 },
  journal: Array<{ section: WorkerRecord["section"]; id: string; content: string }> = [],
): typeof globalThis.fetch {
  const archive = snapshotArchive(recordsByKey);
  return async (input, init) => {
    const url = new URL(String(input));
    const bodyText = String(init?.body || "");
    const signature = `sha256=${createHmac("sha256", "fixture-secret").update(bodyText).digest("hex")}`;
    assert.equal(new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"), signature);
    const body = JSON.parse(bodyText) as {
      cursor: number;
      sinceRevision?: number;
      offset?: number;
      length?: number;
    };
    if (url.pathname.endsWith("/snapshots/latest")) {
      return Response.json({
        ok: true,
        snapshotStoreAvailable: true,
        snapshot: {
          repoSlug,
          revisionWatermark: recordsByKey.size,
          objectKey: `${repoSlug}/${recordsByKey.size}/fixture.tar.gz`,
          bytes: archive.byteLength,
          uncompressedBytes: [...recordsByKey.values()].reduce(
            (sum, content) => sum + Buffer.byteLength(content),
            0,
          ),
          fileCount: recordsByKey.size,
          createdAt: "2026-07-26T00:00:00.000Z",
          access: { mode: "worker_range_proxy", maxChunkBytes: 32 * 1024 * 1024 },
        },
      });
    }
    if (url.pathname.endsWith("/snapshots/chunk")) {
      stats.chunkRequests += 1;
      const offset = body.offset ?? 0;
      const length = Math.min(body.length ?? archive.byteLength, archive.byteLength - offset);
      return new Response(archive.subarray(offset, offset + length), {
        status: 206,
        headers: {
          "content-range": `bytes ${offset}-${offset + length - 1}/${archive.byteLength}`,
        },
      });
    }
    assert.equal(body.cursor, 0);
    const records: WorkerRecord[] = [...recordsByKey.entries()].map(([key, content], index) => {
      const [section, id] = key.split("/") as [WorkerRecord["section"], string];
      return {
        section,
        id,
        content,
        digest: createHash("sha256").update(content).digest("hex"),
        revision: 0,
        storeRevision: index + 1,
        deleted: false,
      };
    });
    const journalRecords: WorkerRecord[] = body.sinceRevision
      ? journal.map((record, index) => ({
          ...record,
          digest: createHash("sha256").update(record.content).digest("hex"),
          revision: records.length + index + 1,
          storeRevision: records.length + index + 1,
          deleted: false,
        }))
      : records;
    return Response.json({
      repoSlug,
      revision: records.length + journal.length,
      records: journalRecords,
      nextCursor: null,
    });
  };
}

function snapshotArchive(recordsByKey: Map<string, string>) {
  const chunks: Buffer[] = [];
  for (const [key, content] of recordsByKey) {
    const [section, id] = key.split("/");
    const extension = section === "decision-packets" ? ".json" : ".md";
    const bytes = Buffer.from(content);
    chunks.push(testTarHeader(`${section}/${id}${extension}`, bytes.byteLength), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function testTarHeader(name: string, size: number) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number) {
  target.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}
