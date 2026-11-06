import assert from "node:assert/strict";
import test from "node:test";
import {
  censusHttpControl,
  runReviewCoverageCensus,
} from "../../dist/repair/review-coverage-census.js";

const sentinel = "SENTINEL-secret-private-repo-cursor-sql";
const work = {
  repo: "fixture/core",
  id: "repo-id",
  generation: "generation",
  revisionNumber: 0,
  kind: "issue",
  pass: 1,
  cursor: null,
};
const repositories = [
  {
    repo: "fixture/core",
    id: "repo-id",
    scope: "eligible",
    visibility: "public",
    issues: 1,
    pulls: 0,
    countsAt: new Date().toISOString(),
  },
];

for (const [name, value, category] of [
  [
    "HTTP-200 mixed GraphQL errors",
    {
      data: { r0: null },
      errors: [{ type: "RATE_LIMITED", message: sentinel }, { type: "FORBIDDEN" }],
    },
    "graphql",
  ],
  ["HTTP-200 access error", { errors: [{ type: "FORBIDDEN", message: sentinel }] }, "graphql"],
  [
    "HTTP-200 authentication error",
    { errors: [{ type: "UNAUTHORIZED", message: sentinel }] },
    "graphql",
  ],
  ["null repository", { data: { r0: null } }, "schema"],
  ["missing alias", { data: {} }, "schema"],
  ["identity mismatch", { data: { r0: { id: "other", nameWithOwner: "fixture/core" } } }, "schema"],
  [
    "connection missing",
    { data: { r0: { id: "repo-id", nameWithOwner: "fixture/core" } } },
    "schema",
  ],
]) {
  test(`failed-closed diagnostics: ${name}`, async () => {
    const diagnostics = [];
    let assigned = false;
    const result = await runReviewCoverageCensus({
      repositories,
      query: () => value,
      onDiagnostic: (d) => diagnostics.push(d),
      control: async (path) => {
        if (path.endsWith("/start") || path.endsWith("/fail")) return { ok: true };
        if (path.endsWith("/next")) {
          const workItems = assigned ? [] : [work];
          assigned = true;
          return { ok: true, work: workItems };
        }
        assert.fail("invalid response must not reach accept");
      },
    });
    assert.equal(result.accepted, 0);
    assert.equal(result.failed, 1);
    assert.equal(diagnostics[0].category, category);
    assert.ok(!JSON.stringify(diagnostics).includes(sentinel));
  });
}

for (const [name, error, category] of [
  ["JSON decoding", new SyntaxError(sentinel), "json"],
  ["transport", new Error(sentinel), "read_failed"],
]) {
  test(`read failure diagnostics: ${name}`, async () => {
    const diagnostics = [];
    let assigned = false;
    const result = await runReviewCoverageCensus({
      repositories,
      query: () => {
        throw error;
      },
      onDiagnostic: (d) => diagnostics.push(d),
      control: async (path) => {
        if (path.endsWith("/start") || path.endsWith("/fail")) return { ok: true };
        const items = assigned ? [] : [work];
        assigned = true;
        return { ok: true, work: items };
      },
    });
    assert.equal(result.accepted, 0);
    assert.equal(result.failed, 1);
    assert.equal(diagnostics[0].category, category);
    assert.ok(!JSON.stringify(diagnostics).includes(sentinel));
  });
}

test("HTTP checkpoint rejection retains generic error and closed diagnostic only", async () => {
  const control = censusHttpControl({
    baseUrl: "https://local.invalid",
    secret: "local-only",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: "coverage_checkpoint_rejected",
          diagnostic: { phase: "fail", category: "lease", detail: sentinel },
        }),
        { status: 409 },
      ),
  });
  await assert.rejects(control("/internal/review-coverage/census/fail", {}), (error) => {
    assert.match(error.message, /coverage_checkpoint_rejected/);
    assert.match(error.message, /phase=fail category=lease/);
    assert.ok(!String(error).includes(sentinel));
    return true;
  });
});

test("malicious control fields and arbitrary error strings are never logged", async () => {
  const control = censusHttpControl({
    baseUrl: "https://local.invalid",
    secret: "local-only",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: sentinel, diagnostic: { phase: sentinel, category: sentinel } }),
        { status: 409 },
      ),
  });
  await assert.rejects(control("/internal/review-coverage/census/start", {}), (error) => {
    assert.ok(!String(error).includes(sentinel));
    assert.match(error.message, /census_control_failed/);
    return true;
  });
});

test("malformed control JSON is closed and response phase cannot spoof the callsite", async () => {
  for (const [body, category] of [
    [sentinel, "json"],
    [
      JSON.stringify({ error: sentinel, diagnostic: { phase: "fail", category: "lease" } }),
      "unclassified",
    ],
  ]) {
    const control = censusHttpControl({
      baseUrl: "https://local.invalid",
      secret: "local-only",
      fetchImpl: async () => new Response(body, { status: 409 }),
    });
    await assert.rejects(control("/internal/review-coverage/census/start", {}), (error) => {
      assert.match(error.message, new RegExp(`phase=start category=${category}`));
      assert.ok(!String(error).includes(sentinel));
      return true;
    });
  }
});

test("control transport errors keep their cause private and injected control exceptions retain identity", async () => {
  const original = new Error(sentinel);
  const control = censusHttpControl({
    baseUrl: "https://local.invalid",
    secret: "local-only",
    fetchImpl: async () => {
      throw original;
    },
  });
  await assert.rejects(control("/internal/review-coverage/census/next", {}), (error) => {
    assert.equal(error.cause, original);
    assert.ok(!String(error).includes(sentinel));
    return true;
  });
  const diagnostics = [];
  await assert.rejects(
    runReviewCoverageCensus({
      repositories,
      query: () => null,
      onDiagnostic: (d) => diagnostics.push(d),
      control: async () => {
        throw original;
      },
    }),
    (error) => {
      assert.equal(error, original);
      return true;
    },
  );
  assert.deepEqual(diagnostics, [
    { phase: "start", category: "unclassified", queries: 0, accepted: 0, failed: 0 },
  ]);
});

test("query failure and rejected fail checkpoint retain primary failure and bounded progress", async () => {
  const original = new Error(sentinel);
  const diagnostics = [];
  await assert.rejects(
    runReviewCoverageCensus({
      repositories,
      query: async () => {
        throw original;
      },
      onDiagnostic: (value) => diagnostics.push(value),
      control: async (path) => {
        if (path.endsWith("/start")) return { ok: true };
        if (path.endsWith("/next")) return { ok: true, work: [work] };
        throw new Error("secondary-" + sentinel);
      },
    }),
    (error) => {
      assert.equal(error.cause, original);
      assert.match(error.message, /phase=query category=read_failed/);
      assert.ok(!String(error).includes(sentinel));
      return true;
    },
  );
  assert.deepEqual(
    diagnostics.map(({ phase, category, queries, accepted, failed }) => ({
      phase,
      category,
      queries,
      accepted,
      failed,
    })),
    [
      { phase: "query", category: "read_failed", queries: 1, accepted: 0, failed: 0 },
      { phase: "fail", category: "unclassified", queries: 1, accepted: 0, failed: 1 },
    ],
  );
  assert.ok(!JSON.stringify(diagnostics).includes(sentinel));
});

test("throwing diagnostic observer cannot prevent a failed query checkpoint", async () => {
  const calls = [];
  let assigned = false;
  const result = await runReviewCoverageCensus({
    repositories,
    query: () => {
      throw new SyntaxError(sentinel);
    },
    onDiagnostic: () => {
      throw new Error("observer failure " + sentinel);
    },
    control: async (path) => {
      calls.push(path);
      if (path.endsWith("start") || path.endsWith("fail")) return { ok: true };
      if (path.endsWith("next")) {
        if (assigned) return { ok: true, work: [] };
        assigned = true;
        return { ok: true, work: [work] };
      }
      assert.fail("a failed query must not reach acceptance");
    },
  });
  assert.equal(result.queries, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.accepted, 0);
  assert.equal(calls.filter((path) => path.endsWith("fail")).length, 1);
});

test("throwing diagnostic observer cannot replace the primary control failure", async () => {
  const original = new Error("census lease conflict");
  const calls = [];
  await assert.rejects(
    runReviewCoverageCensus({
      repositories,
      query: () => assert.fail("start failure must precede GitHub reads"),
      onDiagnostic: () => {
        throw new Error("observer failure " + sentinel);
      },
      control: async (path) => {
        calls.push(path);
        throw original;
      },
    }),
    (error) => {
      assert.equal(error, original);
      assert.ok(!String(error).includes(sentinel));
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("start"));
});
