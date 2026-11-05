import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker from "../dashboard/worker.ts";
import { authorityFixture } from "../docs/proof/ui-live-coverage/coverage-authority-fixture.mjs";
import { censusSignatureInput } from "../src/review-coverage-census.ts";
import { censusFixture } from "./fixtures/review-coverage-census.ts";
import {
  censusHttpControl,
  runReviewCoverageCensus,
} from "../dist/repair/review-coverage-census.js";

test("actual Worker checkpoint controls reject anonymous, wrong-purpose, cross-path and legacy signatures", async () => {
  const f = await authorityFixture(),
    path = "/internal/review-coverage/census/start",
    body = JSON.stringify({
      version: 2,
      attempt: "auth-attempt",
      repositories: [],
      observedAt: f.snapshot.generated_at,
    });
  const invoke = (input: string | null, env = f.env, method = "POST") =>
    worker.fetch(
      new Request("https://local.invalid" + path, {
        method,
        headers: input
          ? {
              "x-clawsweeper-exact-review-signature":
                "sha256=" + createHmac("sha256", f.secret).update(input).digest("hex"),
            }
          : undefined,
        ...(method === "POST" ? { body } : {}),
      }),
      env,
      {},
    );
  assert.equal((await invoke(null)).status, 401);
  assert.equal((await invoke(body)).status, 401);
  assert.equal(
    (await invoke("coverage-build-read-v1\nPOST\n/internal/review-coverage/build\n" + body)).status,
    401,
  );
  assert.equal(
    (await invoke(censusSignatureInput("/internal/review-coverage/census/accept", body))).status,
    401,
  );
  assert.equal(
    (await invoke(censusSignatureInput(path, body), { ...f.env, CLAWSWEEPER_WEBHOOK_SECRET: "" }))
      .status,
    503,
  );
  assert.equal((await invoke(censusSignatureInput(path, body), f.env, "GET")).status, 400);
  const accepted = await invoke(censusSignatureInput(path, body));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("access-control-allow-origin"), null);
  const preflight = await invoke(censusSignatureInput(path, body), f.env, "OPTIONS");
  assert.equal(preflight.status, 400);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  const oversized = JSON.stringify({
    version: 2,
    attempt: "wire-bound",
    padding: "x".repeat(1_900_000),
  });
  const callsBefore = f.calls.length;
  const tooLarge = await worker.fetch(
    new Request("https://local.invalid" + path, {
      method: "POST",
      body: oversized,
      headers: {
        "x-clawsweeper-exact-review-signature":
          "sha256=" +
          createHmac("sha256", f.secret)
            .update(censusSignatureInput(path, oversized))
            .digest("hex"),
      },
    }),
    f.env,
    {},
  );
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.headers.get("access-control-allow-origin"), null);
  assert.equal(f.calls.length, callsBefore);
});
test("real producer -> signed Worker -> actual DO/SQLite resumes without canonical/admission mutation", async () => {
  const f = await authorityFixture(),
    fixture = censusFixture([
      { name: "one", issues: 950, pulls: 0 },
      { name: "two", issues: 950, pulls: 0 },
      { name: "three", issues: 950, pulls: 0 },
    ]);
  const env = {
    ...f.env,
    EXACT_REVIEW_QUEUE: { idFromName: (id: string) => id, get: () => f.queue },
  };
  const before = JSON.stringify(f.canonicalState());
  const writes: string[] = [];
  const originalExec = f.storage.sql.exec;
  f.storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE)/i.test(sql)) writes.push(sql);
    return originalExec(sql, ...bindings);
  };
  const admissionBefore = JSON.stringify(f.storage.kv.get("exact-review-queue"));
  const control = censusHttpControl({
    baseUrl: "https://local.invalid",
    secret: f.secret,
    fetchImpl: (url, init) => worker.fetch(new Request(url, init), env, {}),
  });
  const runs = [];
  for (let i = 0; i < 8; i++) {
    const result = await runReviewCoverageCensus({
      repositories: fixture.population().map((r) => ({ ...r, countsAt: new Date().toISOString() })),
      control,
      query: fixture.query,
      attempt: "actual-owner-proof",
    });
    assert.ok(result.queries <= 25);
    assert.equal(result.failed, 0);
    runs.push(result);
    const states = Array.from(
      f.storage.sql.exec("SELECT state FROM coverage_census_repositories"),
    ).map((r) => JSON.parse(String(r.state)));
    if (states.length === 3 && states.every((s) => s.complete && !s.active)) break;
  }
  const states = Array.from(
    f.storage.sql.exec("SELECT state FROM coverage_census_repositories"),
  ).map((r) => JSON.parse(String(r.state)));
  assert.equal(states.filter((s) => s.complete && !s.active).length, 3);
  assert.equal(JSON.stringify(f.canonicalState()), before);
  assert.equal(JSON.stringify(f.storage.kv.get("exact-review-queue")), admissionBefore);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((sql) => sql.includes("coverage_census_")));
  f.storage.sql.exec = originalExec;
  const anonymous = await worker.fetch(
    new Request("https://local.invalid/api/review-coverage"),
    env,
    {},
  );
  assert.equal(anonymous.status, 200);
  const text = await anonymous.text();
  assert.ok(!text.includes("fixture/"));
  assert.equal(anonymous.headers.get("access-control-allow-origin"), "*");
  const unrelated = JSON.stringify(
    Array.from(
      f.storage.sql.exec("SELECT state FROM coverage_census_repositories WHERE repo='fixture/two'"),
    ),
  );
  const corrupt = Array.from(
    f.storage.sql.exec(
      "SELECT rowid,payload FROM coverage_census_items WHERE repo='fixture/one' AND slot='complete' LIMIT 1",
    ),
  )[0]!;
  const payload = JSON.parse(String(corrupt.payload));
  payload.labels = ["post-promotion-corruption"];
  const serialized = JSON.stringify(payload);
  f.storage.sql.exec(
    "UPDATE coverage_census_items SET payload=?,bytes=? WHERE rowid=?",
    serialized,
    Buffer.byteLength(serialized),
    corrupt.rowid,
  );
  const { readCoverageForBuild } = await import("../dashboard-site/scripts/coverage.ts");
  await assert.rejects(
    readCoverageForBuild(
      f.secret,
      (url, init) => worker.fetch(new Request(url, init), env, {}),
      "https://local.invalid",
    ),
    /coverage_build_read_failed/,
  );
  const unavailable = await worker.fetch(
    new Request("https://local.invalid/api/review-coverage"),
    env,
    {},
  );
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("fixture/"));
  assert.equal(
    JSON.stringify(
      Array.from(
        f.storage.sql.exec(
          "SELECT state FROM coverage_census_repositories WHERE repo='fixture/two'",
        ),
      ),
    ),
    unrelated,
  );
  assert.equal(JSON.stringify(f.canonicalState()), before);
  assert.equal(JSON.stringify(f.storage.kv.get("exact-review-queue")), admissionBefore);
  fixture.db.close();
});

test("streamed v2 projection preserves v1 matched review categories and independent counts", async () => {
  const f = await authorityFixture();
  const { readCoverageForBuild } = await import("../dashboard-site/scripts/coverage.ts");
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) =>
    worker.fetch(new Request(url, init), f.env, {});
  const before = await readCoverageForBuild(f.secret, fetchImpl, "https://local.invalid"),
    canonical = JSON.stringify(f.canonicalState());
  const repositories = f.snapshot.repositories.map((r) => ({
    repo: r.repo,
    id: "ID_" + r.repo,
    revision: "v2-parity",
    visibility: "public" as const,
    scope: "eligible" as const,
    issues: r.open_issues,
    pulls: r.open_pull_requests,
    countsAt: new Date().toISOString(),
  }));
  const query = (text: string) => ({
    data: Object.fromEntries(
      [
        ...text.matchAll(
          /r(\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\) \{ id nameWithOwner (issues|pullRequests)\(/g,
        ),
      ].map((match) => {
        const repo = match[2] + "/" + match[3],
          kind = match[4] === "issues" ? "issue" : "pull_request",
          r = f.snapshot.repositories.find((r) => r.repo === repo),
          items = r.items.filter((item) => item.kind === kind);
        return [
          "r" + match[1],
          {
            id: "ID_" + repo,
            nameWithOwner: repo,
            [match[4]!]: {
              totalCount: items.length,
              pageInfo: {
                hasNextPage: false,
                endCursor: items.length ? "terminal-" + items.length : null,
              },
              nodes: items.map((item) => ({
                number: item.number,
                updatedAt: item.updated_at,
                ...(kind === "pull_request" ? { headRefOid: item.head_sha } : {}),
                labels: {
                  nodes: item.labels.map((name) => ({ name })),
                  pageInfo: { hasNextPage: false },
                },
                timelineItems: { nodes: item.reopened_at ? [{ createdAt: item.reopened_at }] : [] },
              })),
            },
          },
        ];
      }),
    ),
  });
  const control = censusHttpControl({
    baseUrl: "https://local.invalid",
    secret: f.secret,
    fetchImpl,
  });
  const result = await runReviewCoverageCensus({ repositories, control, query });
  assert.equal(result.failed, 0);
  const after = await readCoverageForBuild(f.secret, fetchImpl, "https://local.invalid");
  const metrics = (source) =>
    source.fleets.map((row) => [
      row.repo,
      ...[
        "open_records",
        "reviewable_records",
        "reviewed_recent",
        "failed",
        "stale",
        "expired",
        "excluded",
        "untracked_open",
        "coverage_percent",
      ].map((key) => row[key]),
    ]);
  assert.deepEqual(metrics(after), metrics(before));
  assert.equal(JSON.stringify(f.canonicalState()), canonical);
  assert.ok(after.fleets.every((row) => row.collection_window));
});

test("actual v2 private read streams a complete inventory larger than the v1 1.9 MB value", async () => {
  const f = await authorityFixture(),
    fixture = censusFixture([{ name: "wide", issues: 1000, pulls: 0 }]);
  fixture.members.get("wide")!.labels = Array.from(
    { length: 100 },
    (_, i) => "L" + String(i).padStart(3, "0") + "x".repeat(96),
  );
  const env = {
    ...f.env,
    EXACT_REVIEW_QUEUE: { idFromName: (id: string) => id, get: () => f.queue },
  };
  let maxRequestBytes = 0;
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) => {
    maxRequestBytes = Math.max(maxRequestBytes, Buffer.byteLength(String(init?.body ?? "")));
    return worker.fetch(new Request(url, init), env, {});
  };
  const control = censusHttpControl({
    baseUrl: "https://local.invalid",
    secret: f.secret,
    fetchImpl,
  });
  for (let run = 0; run < 4; run++) {
    const result = await runReviewCoverageCensus({
      repositories: fixture.population().map((r) => ({ ...r, countsAt: new Date().toISOString() })),
      control,
      query: fixture.query,
      attempt: "byte-partition",
    });
    assert.equal(result.failed, 0);
    assert.ok(result.queries <= 25);
    const row = Array.from(
      f.storage.sql.exec(
        "SELECT state FROM coverage_census_repositories WHERE repo='fixture/wide'",
      ),
    )[0];
    if (row && JSON.parse(String(row.state)).complete) break;
  }
  const bytes = Number(
    Array.from(
      f.storage.sql.exec(
        "SELECT SUM(bytes) AS bytes FROM coverage_census_items WHERE repo='fixture/wide' AND slot='complete'",
      ),
    )[0]!.bytes,
  );
  assert.ok(bytes > 1_900_000);
  assert.ok(bytes < 32 * 1024 * 1024);
  assert.ok(maxRequestBytes <= 1_900_000);
  const { readCoverageForBuild } = await import("../dashboard-site/scripts/coverage.ts");
  const result = await readCoverageForBuild(f.secret, fetchImpl, "https://local.invalid");
  const row = result.fleets.find((r) => r.repo === "fixture/wide");
  assert.equal(row.coverage_status, "complete");
  assert.equal(row.open_records, 1000);
  assert.equal(row.reviewable_records, 1000);
  fixture.db.close();
});

test("raw GitHub terminal cursors are normalized only inside actual producer/Worker acceptance", async () => {
  for (const issues of [0, 2, 101]) {
    const f = await authorityFixture(),
      fixture = censusFixture([{ name: "terminal", issues, pulls: 0 }]);
    const env = {
      ...f.env,
      EXACT_REVIEW_QUEUE: { idFromName: (id: string) => id, get: () => f.queue },
    };
    const pages: Record<string, unknown>[] = [],
      observations: { nodes: number; hasNextPage: boolean; endCursor: string | null }[] = [];
    const control = censusHttpControl({
      baseUrl: "https://local.invalid",
      secret: f.secret,
      fetchImpl: (url, init) => {
        if (String(url).endsWith("/accept")) pages.push(...JSON.parse(String(init?.body)).pages);
        return worker.fetch(new Request(url, init), env, {});
      },
    });
    const result = await runReviewCoverageCensus({
      repositories: fixture.population().map((r) => ({ ...r, countsAt: new Date().toISOString() })),
      control,
      query: (query) => {
        const value = fixture.query(query);
        for (const repo of Object.values(value.data))
          for (const kind of ["issues", "pullRequests"]) {
            const connection = repo[kind];
            if (connection)
              observations.push({ nodes: connection.nodes.length, ...connection.pageInfo });
          }
        return value;
      },
    });
    assert.equal(result.failed, 0);
    assert.ok(
      observations.filter((r) => !r.hasNextPage && r.nodes > 0).every((r) => r.endCursor !== null),
    );
    const terminal = pages.filter((p) => p.hasNext === false);
    assert.ok(terminal.length > 0);
    assert.ok(terminal.every((p) => p.next === null));
    assert.ok(
      terminal
        .filter((p) => (p.items as unknown[]).length > 0)
        .every((p) => (p.sourcePageInfo as { endCursor: unknown }).endCursor !== null),
    );
    assert.ok(
      Array.from(f.storage.sql.exec("SELECT state FROM coverage_census_repositories")).every(
        (row) => JSON.parse(String(row.state)).complete,
      ),
    );
    fixture.db.close();
  }
});
