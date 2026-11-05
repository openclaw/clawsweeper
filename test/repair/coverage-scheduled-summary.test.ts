import {
  installCoverageFailure,
  COVERAGE_FAILURE_PRIVATE_MARKER,
} from "../fixtures/coverage-summary-failure.ts";
import { Console } from "node:console";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ExactReviewDirectPublicationStore,
  validateDirectPublicationPlan,
} from "../../dashboard/exact-review-direct-publication.ts";
import { COVERAGE_SUMMARY_READ } from "../../src/repair/coverage-summary.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { coverageCliFixture } from "../fixtures/review-coverage-cli.ts";

let outputSequence = 0,
  lastDiagnostics = "";
const diagnosticConsole = new Console(process.stdout, process.stderr);
async function stdoutOf(work: () => Promise<unknown>) {
  const stdout = process.stdout.write,
    stderr = process.stderr.write,
    originalError = console.error;
  let text = "",
    diagnostics = "";
  const capture =
    (append: (text: string) => void) =>
    (chunk: unknown, encoding?: unknown, callback?: () => void) => {
      append(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      const done = typeof encoding === "function" ? (encoding as () => void) : callback;
      done?.();
      return true;
    };
  process.stdout.write = capture((value) => {
    text += value;
  }) as typeof process.stdout.write;
  process.stderr.write = capture((value) => {
    diagnostics += value;
  }) as typeof process.stderr.write;
  console.error = diagnosticConsole.error.bind(diagnosticConsole);
  try {
    await work();
    return text;
  } finally {
    lastDiagnostics = diagnostics;
    console.error = originalError;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    const output = process.env.CENSUS_SUMMARY_TRACE_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      const name = String(++outputSequence).padStart(3, "0");
      writeFileSync(join(output, name + ".md"), text);
      writeFileSync(join(output, name + ".stderr.txt"), diagnostics);
    }
  }
}

test("published seven-day coverage command retains Markdown job-summary metrics with one v2 census", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  try {
    await seedFresh(f);
    const output = await stdoutOf(() => f.run("coverage", "v2", { windowDays: 7 }));
    assert.match(output, /## Weekly review coverage/);
    assert.match(lastDiagnostics, /"coverage_collection"/);
    assert.ok(!output.includes("coverage_collection"));
    assert.ok(!/openclaw\/core|ID_core|checkpoint/.test(lastDiagnostics));
    assert.match(output, /Current observed open items \| 3/);
    assert.match(output, /Fresh in trailing 7 days \| 1/);
    assert.match(output, /Trailing coverage \| 33\.3%/);
    assert.match(output, /Counts observed as of: \d{4}-/);
    assert.match(output, /Canonical facts observed as of: \d{4}-/);
    assert.equal(f.publicCoverageReads.length, 1);
    assert.deepEqual(f.publicCoverageReads[0], {
      path: "/api/review-coverage",
      method: "GET",
      query: "",
      authorization: false,
      signature: false,
      redirect: "error",
    });
    assert.equal(f.calls.filter((c) => c.path.endsWith("/census/start")).length, 1);
    assert.ok(!f.calls.some((c) => c.path.endsWith("/review-coverage/inventory")));
    assert.ok(f.queries[0]!.inventory <= 25);
    assert.ok(!/openclaw\/core|ID_core|checkpoint|generation|sha256=/.test(output));
  } finally {
    f.close();
  }
});

async function seedFresh(f: Awaited<ReturnType<typeof coverageCliFixture>>) {
  const content =
      "---\nrepository: openclaw/core\nnumber: 1\ntype: issue\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nreviewed_at: " +
      new Date(f.time).toISOString() +
      "\n---\nControlled canonical report.\n",
    plan = await validateDirectPublicationPlan({
      canonicalTargetKey: "openclaw/core#1",
      fenceKey: "openclaw/core#1:summary-seed",
      revision: 1,
      identity: {
        canonicalTargetKey: "openclaw/core#1",
        fenceKey: "openclaw/core#1:summary-seed",
        revision: 1,
        claimGeneration: 1,
      },
      lifecycle: { kind: "guarded_open" },
      operations: [
        {
          path: "records/openclaw-core/items/1.md",
          deleted: false,
          mode: "100644",
          bytes: Buffer.byteLength(content),
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
      totalBytes: Buffer.byteLength(content),
    });
  const store = new ExactReviewDirectPublicationStore(f.authority.storage);
  store.ensureSchemaSync();
  store.accept(plan, f.time, await store.prepareCanonicalWrites(plan.operations));
}

test("requested14-day report does not relabel seven-day aggregate review metrics", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  try {
    await seedFresh(f);
    const out = await stdoutOf(() => f.run("coverage", "v2", { windowDays: 14 }));
    assert.match(out, /Requested review window \| 14 days/);
    assert.match(out, /Source review window \| 7 days/);
    assert.match(out, /Current observed open items \| 3/);
    assert.match(out, /Fresh in trailing 14 days \| Unknown/);
    assert.match(out, /Trailing coverage \| Unknown/);
    assert.match(out, /not 14/);
    assert.equal(f.publicCoverageReads.length, 1);
  } finally {
    f.close();
  }
});

test("no-publish legacy seven-day coverage keeps its human report without a report GET or publication", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  try {
    const out = await stdoutOf(() => f.run("coverage", "v2", { publish: false, windowDays: 7 }));
    assert.match(out, /## Weekly review coverage/);
    assert.match(out, /Items scanned in trailing 7 days \| [0-3]/);
    assert.match(out, /Open items total \| 3/);
    assert.equal(f.publicCoverageReads.length, 0);
    assert.ok(
      !f.calls.some(
        (c) => c.path.includes("/census/") || c.path.endsWith("/review-coverage/inventory"),
      ),
    );
  } finally {
    f.close();
  }
});

for (const mode of ["normal-review", "hot-intake", "audit"])
  test(mode + " does not add a public report read or change its stdout contract", async () => {
    const f = await coverageCliFixture([{ name: "core", issues: 1, pulls: 0 }]);
    try {
      const out = await stdoutOf(() => f.run(mode));
      assert.equal(f.publicCoverageReads.length, 0);
      assert.ok(!out.includes("## Weekly review coverage"));
    } finally {
      f.close();
    }
  });

for (const kind of [
  "malformed",
  "http",
  "redirect",
  "transport",
  "identifying",
  "null-counts",
  "facts-unavailable",
  "partial-zero",
  "bad-time",
  "bad-calendar",
  "oversized",
] as const)
  test(
    "public aggregate " + kind + " is bounded/closed and never echoes private payload",
    async () => {
      const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
      const secret = "private/secret-repo ID_secret ghp_never_echo checkpoint-secret";
      let cancelled = false;
      try {
        f.setPublicCoverageResponse(async () => {
          if (kind === "malformed") return new Response("{" + secret);
          if (kind === "http") return new Response(secret, { status: 503 });
          if (kind === "redirect")
            return new Response(secret, {
              status: 302,
              headers: { location: "https://private.invalid/" + secret },
            });
          if (kind === "transport") throw new Error(secret);
          if (kind === "oversized")
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(
                    new TextEncoder().encode(secret + "x".repeat(COVERAGE_SUMMARY_READ.bytes)),
                  );
                },
                cancel() {
                  cancelled = true;
                },
              }),
            );
          const source = (await (await f.anonymous()).json()) as Record<string, unknown> & {
            totals: Record<string, unknown>;
          };
          if (kind === "identifying")
            return Response.json({
              ...source,
              scope: "authenticated-coverage-candidates",
              fleets: [{ repo: secret, id: secret }],
              error: secret,
            });
          if (kind === "bad-time") source.generated_at = secret;
          if (kind === "bad-calendar") source.generated_at = "2026-02-31T00:00:00.000Z";
          if (kind === "partial-zero") {
            source.census_status = "partial";
            source.coverage_status = "unknown";
            source.totals.reviewable_records = null;
            source.totals.reviewed_recent = 0;
            source.totals.coverage_percent = 0;
          }
          if (kind === "null-counts") {
            source.count_status = "unavailable";
            source.coverage_status = "unknown";
            for (const key of Object.keys(source.totals)) source.totals[key] = null;
          }
          if (kind === "facts-unavailable") {
            source.scan_status = "unavailable";
            source.coverage_status = "unknown";
            for (const key of Object.keys(source.totals))
              if (key !== "open_records" && key !== "reviewable_records") source.totals[key] = null;
          }
          return Response.json(source);
        });
        const out = await stdoutOf(() => f.run("coverage"));
        assert.match(out, /## Weekly review coverage/);
        assert.match(out, /Trailing coverage \| Unknown/);
        assert.ok(!out.includes(secret));
        assert.ok(!f.logs.join("\n").includes(secret));
        assert.ok(!lastDiagnostics.includes(secret));
        assert.ok(!/ID_secret|ghp_never_echo|checkpoint-secret/.test(out));
        assert.equal(f.publicCoverageReads.length, 1);
        assert.equal(f.calls.filter((c) => c.path.endsWith("/census/start")).length, 1);
        assert.ok(!f.calls.some((c) => c.path.endsWith("/review-coverage/inventory")));
        if (kind === "null-counts") {
          assert.match(out, /Current observed open items \| Unknown/);
          assert.match(out, /Fresh in trailing 7 days \| Unknown/);
          assert.ok(!out.includes("Trailing coverage | 0.0%"));
        }
        if (kind === "partial-zero") {
          assert.match(out, /Fresh in trailing 7 days \| Unknown/);
          assert.ok(!out.includes("Trailing coverage | 0.0%"));
        }
        if (kind === "facts-unavailable") {
          assert.match(out, /Current observed open items \| 3/);
          assert.match(out, /Canonical review facts \| Unknown/);
          assert.match(out, /Fresh in trailing 7 days \| Unknown/);
        }
        if (kind === "oversized") assert.equal(cancelled, true);
      } finally {
        f.close();
      }
    },
  );

for (const part of ["headers", "body"] as const)
  test(
    "public aggregate " + part + " timeout becomes safe Unknown under the real read deadline",
    { timeout: 12_000 },
    async () => {
      const f = await coverageCliFixture([{ name: "core", issues: 1, pulls: 0 }]);
      let cancelled = false;
      try {
        f.setPublicCoverageResponse((request) => {
          if (part === "headers")
            return new Promise<Response>((_resolve, reject) => {
              const hold = setTimeout(
                () => reject(new Error("mock transport escaped report deadline")),
                10_000,
              );
              request.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(hold);
                  cancelled = true;
                  reject(new Error("private timeout payload"));
                },
                { once: true },
              );
            });
          let hold: ReturnType<typeof setTimeout>;
          return new Response(
            new ReadableStream({
              start() {
                hold = setTimeout(() => {}, 10_000);
              },
              cancel() {
                clearTimeout(hold);
                cancelled = true;
              },
            }),
          );
        });
        // The referenced mock transport keeps only this test alive. The unchanged
        // production deadline must abort the read and release the hold.
        const start = performance.now(),
          out = await stdoutOf(() => f.run("coverage"));
        assert.match(out, /public aggregate read timed out/);
        assert.match(out, /Trailing coverage \| Unknown/);
        assert.equal(cancelled, true);
        assert.ok(performance.now() - start < COVERAGE_SUMMARY_READ.timeoutMs + 4_000);
        assert.ok(!out.includes("private timeout"));
        assert.equal(f.publicCoverageReads.length, 1);
      } finally {
        f.close();
      }
    },
  );

test("actual143/145 qualified census keeps aggregate Open numeric and fleet coverage Unknown without identifying rows", async () => {
  const specs = [
      { name: "core", issues: 1200, pulls: 0 },
      { name: "ent", issues: 260, pulls: 0 },
      ...Array.from({ length: 143 }, (_, i) => ({ name: "small" + i, issues: 1, pulls: 0 })),
    ],
    f = await coverageCliFixture(specs),
    original = f.model.query;
  let tick = 0,
    last = "";
  try {
    f.model.query = (q) => {
      tick++;
      for (const name of ["core", "ent"]) f.model.members.get(name)!.labels = ["changed-" + tick];
      return original(q);
    };
    let reached = false;
    for (let i = 0; i < 36; i++) {
      if (i) f.advance(20 * 60_000);
      last = await stdoutOf(() => f.run("coverage"));
      if (f.states().filter((s) => s.state.complete).length === 143) {
        reached = true;
        break;
      }
    }
    assert.equal(reached, true);
    assert.match(last, /Current observed open items \| 1603/);
    assert.match(last, /Trailing coverage \| Unknown/);
    assert.match(last, /Census status \| Unknown/);
    assert.match(last, /Census Complete\/Total \| Unknown \(not exposed/);
    assert.ok(
      !/openclaw\/(?:core|ent|small)|ID_(?:core|ent|small)|checkpoint|generation/.test(last),
    );
    assert.ok(f.queries.every((q) => q.inventory <= 25));
  } finally {
    f.close();
  }
});

test("actual anonymous Worker keeps observed counts separate when canonical scan is unavailable", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  let actual: Record<string, unknown> | undefined;
  try {
    f.authority.storage.failNextSqlMatching(/FROM\s+exact_review_canonical_records(?:_v2)?\b/i);
    f.setPublicCoverageResponse(async () => {
      const response = await f.anonymous();
      actual = (await response.clone().json()) as Record<string, unknown>;
      return response;
    });
    const out = await stdoutOf(() => f.run("coverage"));
    assert.equal(actual?.scope, "aggregate-only");
    assert.equal(actual?.scan_status, "unknown");
    assert.match(out, /Current observed open items \| 3/);
    assert.match(out, /Canonical review facts \| Unknown/);
    assert.match(out, /Fresh in trailing 7 days \| Unknown/);
    assert.match(out, /Trailing coverage \| Unknown/);
    assert.ok(!out.includes("exact_review_canonical_records"));
    assert.equal(f.publicCoverageReads.length, 1);
  } finally {
    f.close();
  }
});

test("zero-open aggregate uses zero counts rather than Unknown or an invented percentage", async () => {
  const f = await coverageCliFixture([{ name: "empty", issues: 0, pulls: 0 }]);
  try {
    const out = await stdoutOf(() => f.run("coverage"));
    assert.match(out, /Current observed open items \| 0/);
    assert.match(out, /Qualified live-open identities \| 0/);
    assert.match(out, /Fresh in trailing 7 days \| 0/);
    assert.match(out, /Trailing coverage \| Unknown/);
    assert.equal(f.publicCoverageReads.length, 1);
  } finally {
    f.close();
  }
});

test("explicit legacy-v1 publication keeps one inventory publication and reads only the public aggregate report", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  try {
    const out = await stdoutOf(() => f.run("coverage", "v1"));
    assert.match(out, /## Weekly review coverage/);
    assert.equal(
      f.calls.filter((c) => c.path.endsWith("/review-coverage/inventory") && c.method === "POST")
        .length,
      1,
    );
    assert.ok(!f.calls.some((c) => c.path.endsWith("/census/start")));
    assert.equal(f.publicCoverageReads.length, 1);
    assert.ok(f.queries[0]!.legacy <= 25);
  } finally {
    f.close();
  }
});

test("coverage publication failure still emits an independent public report and rejects", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]),
    fault = installCoverageFailure(f, "start", "http503");
  let rejection: unknown;
  try {
    const out = await stdoutOf(async () => {
      try {
        await f.run("coverage", "v2", { windowDays: 7 });
      } catch (e) {
        rejection = e;
      }
    });
    assert.ok(rejection instanceof Error);
    assert.equal(rejection.message, COVERAGE_FAILURE_PRIVATE_MARKER);
    assert.match(out, /## Weekly review coverage/);
    assert.match(out, /collection\/publication unavailable/);
    assert.equal(f.publicCoverageReads.length, 1);
    assert.equal(fault.countQueries, 1);
    assert.equal(fault.identityQueries, 0);
    assert.equal(fault.requests.length, 1);
    assert.ok(!out.includes(COVERAGE_FAILURE_PRIVATE_MARKER));
    assert.ok(!lastDiagnostics.includes(COVERAGE_FAILURE_PRIVATE_MARKER));
    assert.ok(
      !f.calls.some((c) => c.path.endsWith("/review-coverage/inventory") && c.method === "POST"),
    );
  } finally {
    fault.restore();
    f.close();
  }
});

for (const [stage, kind] of [
  ["count", "network"],
  ["start", "network"],
  ["start", "malformed"],
  ["start", "lease409"],
  ["next", "http503"],
  ["next", "network"],
  ["next", "malformed"],
  ["page", "http503"],
  ["page", "network"],
  ["page", "malformed"],
  ["page", "lease409"],
] as const)
  test(
    "coverage " + stage + "/" + kind + " keeps failure after exactly one public report",
    async () => {
      const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]),
        fault = installCoverageFailure(f, stage, kind);
      let rejection: unknown;
      try {
        const out = await stdoutOf(async () => {
          try {
            await f.run("coverage");
          } catch (e) {
            rejection = e;
          }
        });
        assert.ok(rejection instanceof Error);
        if (stage === "count" || kind === "network") assert.equal(rejection, fault.original);
        assert.match(out, /## Weekly review coverage/);
        assert.ok(out.includes("collection/publication unavailable"));
        assert.equal(f.publicCoverageReads.length, 1);
        assert.equal(fault.countQueries, 1);
        assert.equal(fault.identityQueries, stage === "page" ? 1 : 0);
        assert.equal(fault.requests.length, stage === "count" ? 0 : stage === "page" ? 2 : 1);
        assert.ok(!out.includes(COVERAGE_FAILURE_PRIVATE_MARKER));
        assert.ok(!lastDiagnostics.includes(COVERAGE_FAILURE_PRIVATE_MARKER));
        assert.ok(
          !/ID_core|ID_secret|ghp_never_echo|private\/secret-repo/.test(out + lastDiagnostics),
        );
        assert.match(lastDiagnostics, /coverage_collection_unavailable/);
        assert.ok(
          !f.calls.some(
            (c) => c.path.endsWith("/review-coverage/inventory") && c.method === "POST",
          ),
        );
        assert.deepEqual(f.publicCoverageReads[0], {
          path: "/api/review-coverage",
          method: "GET",
          query: "",
          authorization: false,
          signature: false,
          redirect: "error",
        });
      } finally {
        fault.restore();
        f.close();
      }
    },
  );

for (const failure of [
  "http",
  "malformed",
  "oversized",
  "headers-timeout",
  "body-timeout",
] as const)
  test(
    "publication rejection survives simultaneous public report " + failure,
    { timeout: 15_000 },
    async () => {
      const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]),
        fault = installCoverageFailure(f, "start", "network");
      let rejection: unknown,
        cancelled = false;
      try {
        f.setPublicCoverageResponse((request) => {
          if (failure === "http")
            return new Response(COVERAGE_FAILURE_PRIVATE_MARKER, { status: 503 });
          if (failure === "malformed") return new Response(COVERAGE_FAILURE_PRIVATE_MARKER);
          if (failure === "oversized")
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new Uint8Array(COVERAGE_SUMMARY_READ.bytes + 1));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            );
          if (failure === "headers-timeout")
            return new Promise<Response>((_resolve, reject) => {
              const hold = setTimeout(
                () => reject(new Error("mock escaped report deadline")),
                12_000,
              );
              request.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(hold);
                  cancelled = true;
                  reject(new Error(COVERAGE_FAILURE_PRIVATE_MARKER));
                },
                { once: true },
              );
            });
          let hold: ReturnType<typeof setTimeout>;
          return new Response(
            new ReadableStream({
              start() {
                hold = setTimeout(() => {}, 12_000);
              },
              cancel() {
                clearTimeout(hold);
                cancelled = true;
              },
            }),
          );
        });
        const start = performance.now(),
          out = await stdoutOf(async () => {
            try {
              await f.run("coverage");
            } catch (e) {
              rejection = e;
            }
          });
        assert.equal(rejection, fault.original);
        assert.match(out, /## Weekly review coverage/);
        assert.ok(out.includes("collection/publication unavailable"));
        assert.match(out, /Trailing coverage \| Unknown/);
        assert.equal(f.publicCoverageReads.length, 1);
        assert.equal(fault.countQueries, 1);
        assert.equal(fault.identityQueries, 0);
        assert.equal(fault.requests.length, 1);
        assert.ok(!out.includes(COVERAGE_FAILURE_PRIVATE_MARKER));
        assert.ok(!lastDiagnostics.includes(COVERAGE_FAILURE_PRIVATE_MARKER));
        if (failure.includes("timeout")) {
          assert.ok(performance.now() - start < COVERAGE_SUMMARY_READ.timeoutMs + 4_000);
          assert.ok(out.includes("timed out"));
          assert.equal(cancelled, true);
        }
        if (failure === "oversized") assert.equal(cancelled, true);
      } finally {
        fault.restore();
        f.close();
      }
    },
  );

test("initial count rejection may report valid cached aggregates without retimestamping or new-publication claims", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  let fault: ReturnType<typeof installCoverageFailure> | undefined, rejection: unknown;
  try {
    await seedFresh(f);
    await stdoutOf(() => f.run("coverage"));
    const state = JSON.stringify(f.states()),
      before = (await (await f.anonymous()).json()) as {
        counts_observed_at: string;
        inventory_generated_at: string;
      };
    f.advance(20 * 60_000);
    fault = installCoverageFailure(f, "count");
    const out = await stdoutOf(async () => {
      try {
        await f.run("coverage");
      } catch (e) {
        rejection = e;
      }
    });
    assert.equal(rejection, fault.original);
    assert.match(out, /Current observed open items \| 3/);
    assert.match(out, /Fresh in trailing 7 days \| 1/);
    assert.match(out, /Trailing coverage \| 33\.3%/);
    assert.ok(out.includes("not a claim of newly published coverage"));
    assert.ok(out.includes(before.counts_observed_at));
    assert.ok(out.includes(before.inventory_generated_at));
    assert.equal(JSON.stringify(f.states()), state);
    assert.equal(fault.countQueries, 1);
    assert.equal(fault.identityQueries, 0);
    assert.equal(f.publicCoverageReads.length, 2);
  } finally {
    fault?.restore();
    f.close();
  }
});

test("failed collection never relabels cached source7 as requested14 and still rejects", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
  let fault: ReturnType<typeof installCoverageFailure> | undefined, rejection: unknown;
  try {
    await seedFresh(f);
    await stdoutOf(() => f.run("coverage"));
    fault = installCoverageFailure(f, "count");
    const out = await stdoutOf(async () => {
      try {
        await f.run("coverage", "v2", { windowDays: 14 });
      } catch (e) {
        rejection = e;
      }
    });
    assert.equal(rejection, fault.original);
    assert.match(out, /Source review window \| 7 days/);
    assert.match(out, /Fresh in trailing 14 days \| Unknown/);
    assert.match(out, /Trailing coverage \| Unknown/);
    assert.match(out, /Current observed open items \| 3/);
    assert.ok(out.includes("collection/publication unavailable"));
  } finally {
    fault?.restore();
    f.close();
  }
});

test("invalid coverage window rejects before collection/report instead of emitting a misleading fallback", async () => {
  const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]),
    fault = installCoverageFailure(f, "count");
  let rejection: unknown;
  try {
    const out = await stdoutOf(async () => {
      try {
        await f.run("coverage", "v2", { windowDays: 0 });
      } catch (e) {
        rejection = e;
      }
    });
    assert.ok(rejection instanceof Error);
    assert.equal(out, "");
    assert.equal(fault.countQueries, 0);
    assert.equal(f.publicCoverageReads.length, 0);
  } finally {
    fault.restore();
    f.close();
  }
});

for (const stage of ["count", "start", "next", "page"] as const)
  test(
    "actual compiled CLI " + stage + " failure exits1 with Markdown and sanitized stderr",
    () => {
      mkdirSync(".artifacts", { recursive: true });
      const folder = mkdtempSync(join(".artifacts", "coverage-failure-child-")),
        trace = join(folder, "trace.json");
      try {
        const result = spawnSync(
          process.execPath,
          ["test/fixtures/coverage-summary-failure-child.mjs"],
          {
            encoding: "utf8",
            timeout: 25_000,
            env: {
              ...process.env,
              CENSUS_SUMMARY_FAILURE_STAGE: stage,
              CENSUS_SUMMARY_FAILURE_KIND: stage === "count" ? "network" : "http503",
              CENSUS_SUMMARY_FAILURE_TRACE: trace,
            },
          },
        );
        assert.equal(result.status, 1);
        assert.equal(result.signal, null);
        assert.equal(result.error, undefined);
        assert.match(result.stdout, /## Weekly review coverage/);
        assert.ok(result.stdout.includes("collection/publication unavailable"));
        assert.match(result.stderr, /coverage_command_failed/);
        assert.ok(
          !/ID_secret|ghp_never_echo|private\/secret-repo|SYNTHETIC_PRIVATE_ERROR/.test(
            result.stdout + result.stderr,
          ),
        );
        const t = JSON.parse(readFileSync(trace, "utf8"));
        assert.equal(t.actualCliExit, 1);
        assert.equal(t.entryByteIdentical, true);
        assert.equal(t.compiledCanonicalSha256, t.compiledEntrySha256);
        assert.equal(t.fixtureClosed, true);
        assert.equal(t.countQueries, 1);
        assert.equal(t.identityQueries, stage === "page" ? 1 : 0);
        assert.equal(t.publicReads.length, 1);
        assert.equal(t.v1Publications, 0);
        const output = process.env.CENSUS_SUMMARY_TRACE_OUTPUT;
        if (output) {
          mkdirSync(output, { recursive: true });
          writeFileSync(join(output, "child-" + stage + ".md"), result.stdout);
          writeFileSync(join(output, "child-" + stage + ".stderr.txt"), result.stderr);
          writeFileSync(join(output, "child-" + stage + ".trace.json"), JSON.stringify(t, null, 2));
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
