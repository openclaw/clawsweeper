import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureCanonicalRecordBaseline } from "../../dist/repair/canonical-record-baseline.js";
import { publishMainWithStateAppend } from "../../dist/repair/publish-main.js";
import type { GitPublishOptions, PublishResult } from "../../dist/repair/git-publish.js";

const statusPath = "results/sweep-status/openclaw-openclaw.json";
const routerPath = "results/comment-router.json";
const proofPath = `ledger/v1/import-bindings/events/${"a".repeat(64)}.json`;
const tupleRoot = "records/openclaw-openclaw";
const tupleItemPath = `${tupleRoot}/items/42.md`;

test("publish-main appends changed record tuples canonically and never invokes git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-state-"));
  const before = recordMarkdown("2026-07-26T01:00:00.000Z", "before");
  const after = recordMarkdown("2026-07-26T02:00:00.000Z", "after");
  writeText(stateRoot, tupleItemPath, before);
  writeText(root, tupleItemPath, after);
  const gitPublishes: GitPublishOptions[] = [];
  let posted: Record<string, unknown> | undefined;

  const result = await publishMainWithStateAppend(
    { message: "chore: update sweep records", paths: [tupleRoot] },
    {
      root,
      env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(input.toString(), "https://queue.test/internal/state/records/tuples");
        posted = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
        return Response.json(
          { ok: true, accepted: true, deduped: false, revision: 7, sequence: 11 },
          { status: 202 },
        );
      }) as typeof fetch,
      publishGit: capturePublishes(gitPublishes),
    },
  );

  assert.equal(result, "appended");
  assert.equal(gitPublishes.length, 0);
  assert.equal(posted?.key, "openclaw-openclaw/42");
  assert.match(String(posted?.deliveryId), /^record-tuple:1234:2:[a-f0-9]{64}$/);
  assert.deepEqual(posted?.operations, [
    {
      path: tupleItemPath,
      expectedDigest: createHash("sha256").update(before).digest("hex"),
      contentBase64: Buffer.from(after).toString("base64"),
    },
    { path: `${tupleRoot}/closed/42.md`, expectedDigest: null },
    { path: `${tupleRoot}/plans/42.md`, expectedDigest: null },
    { path: `${tupleRoot}/decision-packets/42.json`, expectedDigest: null },
  ]);
});

test("publish-main posts only the tuples whose files differ across a whole-repository request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-state-"));
  const item = (number: number, body: string) =>
    `---\nrepo: openclaw/openclaw\nnumber: ${number}\nreviewed_at: 2026-07-26T01:00:00.000Z\n---\n\n${body}\n`;
  for (let number = 1; number <= 30; number += 1) {
    writeText(stateRoot, `${tupleRoot}/items/${number}.md`, item(number, "unchanged"));
    writeText(root, `${tupleRoot}/items/${number}.md`, item(number, "unchanged"));
  }
  writeText(stateRoot, `${tupleRoot}/items/31.md`, item(31, "before"));
  writeText(root, `${tupleRoot}/items/31.md`, item(31, "after"));
  // An apply checkpoint moves a closed item from items/ to closed/.
  writeText(stateRoot, `${tupleRoot}/items/32.md`, item(32, "open"));
  writeText(root, `${tupleRoot}/closed/32.md`, item(32, "closed"));
  writeText(root, `${tupleRoot}/items/33.md`, item(33, "new"));
  const posted: string[] = [];

  const result = await publishMainWithStateAppend(
    { message: "chore: apply sweep decisions checkpoint 1", paths: [tupleRoot] },
    {
      root,
      env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        posted.push(String(JSON.parse(String(init?.body ?? "")).key));
        return Response.json(
          { ok: true, accepted: true, deduped: false, revision: 7, sequence: 11 },
          { status: 202 },
        );
      }) as typeof fetch,
      publishGit: capturePublishes([]),
    },
  );

  assert.equal(result, "appended");
  assert.deepEqual(posted.sort(), [
    "openclaw-openclaw/31",
    "openclaw-openclaw/32",
    "openclaw-openclaw/33",
  ]);
});

test("publish-main retries transient tuple failures with the same delivery and bounded backoff", async (t) => {
  for (const failure of [
    () => Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 }),
    () => Response.json({ error: "unavailable" }, { status: 503 }),
    () => {
      throw new TypeError("fetch failed");
    },
    () => {
      throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    },
    () => {
      throw new TypeError("request failed", { cause: { code: "ETIMEDOUT" } });
    },
  ]) {
    const fixture = retryPublicationFixture(t);
    const bodies: string[] = [];
    const result = await publishMainWithStateAppend(fixture.options, {
      ...fixture.runtime,
      fetchImpl: (async (_input, init) => {
        bodies.push(String(init?.body));
        return bodies.length <= 2
          ? failure()
          : Response.json({ ok: true, revision: 1, deduped: true });
      }) as typeof fetch,
    });
    assert.equal(result, "appended");
    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(fixture.waits, [10_000, 20_000]);
  }
});

test("publish-main isolates exhausted transient failures and still aborts an all-failed batch", async (t) => {
  for (const sibling of [false, true]) {
    const fixture = retryPublicationFixture(t);
    if (sibling) {
      writeText(
        fixture.runtime.root,
        `${tupleRoot}/items/43.md`,
        recordMarkdown("2026-07-26T02:00:00.000Z", "after").replace("number: 42", "number: 43"),
      );
    }
    const keys: string[] = [];
    const errors: string[] = [];
    const errorMock = t.mock.method(console, "error", (message: string) => errors.push(message));
    const publication = publishMainWithStateAppend(fixture.options, {
      ...fixture.runtime,
      fetchImpl: (async (_input, init) => {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        keys.push(key);
        return key.endsWith("/42")
          ? Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 })
          : Response.json({ ok: true, revision: 1 });
      }) as typeof fetch,
    });
    if (sibling) assert.equal(await publication, "appended");
    else await assert.rejects(publication, /Canonical reconciliation failed for all 1 item/);
    assert.equal(keys.filter((key) => key.endsWith("/42")).length, 5);
    assert.equal(keys.filter((key) => key.endsWith("/43")).length, sibling ? 1 : 0);
    assert.deepEqual(fixture.waits, [10_000, 20_000, 40_000, 50_000]);
    assert.equal(errors.length, 1);
    errorMock.mock.restore();
  }
});

test("publish-main never retries permanent HTTP failures and aborts authentication immediately", async (t) => {
  for (const status of [400, 401, 403, 404, 422]) {
    const fixture = retryPublicationFixture(t);
    let calls = 0;
    await assert.rejects(
      publishMainWithStateAppend(fixture.options, {
        ...fixture.runtime,
        fetchImpl: (async () => {
          calls += 1;
          return Response.json({ error: "denied" }, { status });
        }) as typeof fetch,
      }),
      status === 401 || status === 403
        ? new RegExp(`returned ${status}: denied`)
        : /failed for all/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(fixture.waits, []);
  }
});

test("publish-main keeps persistent infrastructure failures fatal after bounded retries", async (t) => {
  for (const [status, code] of [
    [503, "unavailable"],
    [500, "snapshot_unavailable"],
    [500, "state_unavailable"],
    [500, "storage_unavailable"],
    [500, "store_unavailable"],
  ] as const) {
    const fixture = retryPublicationFixture(t);
    writeText(
      fixture.runtime.root,
      `${tupleRoot}/items/43.md`,
      recordMarkdown("2026-07-26T02:00:00.000Z", "after").replace("number: 42", "number: 43"),
    );
    const keys: string[] = [];
    await assert.rejects(
      publishMainWithStateAppend(fixture.options, {
        ...fixture.runtime,
        fetchImpl: (async (_input, init) => {
          const { key } = JSON.parse(String(init?.body));
          assert.equal(typeof key, "string");
          keys.push(key);
          return Response.json({ error: code }, { status });
        }) as typeof fetch,
      }),
      new RegExp(`returned ${status}: ${code}`),
    );
    assert.deepEqual(keys, Array(5).fill("openclaw-openclaw/42"));
    assert.deepEqual(fixture.waits, [10_000, 20_000, 40_000, 50_000]);
  }
});

test("publish-main honors Retry-After without exceeding the retry wait budget", async (t) => {
  for (const retryAfter of ["65", "Sat, 10 Oct 2026 00:01:05 GMT", "121"]) {
    const fixture = retryPublicationFixture(t);
    let calls = 0;
    const publication = publishMainWithStateAppend(fixture.options, {
      ...fixture.runtime,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? Response.json(
              { error: "rate_limited" },
              { status: 429, headers: { "Retry-After": retryAfter } },
            )
          : Response.json({ ok: true, revision: 1 });
      }) as typeof fetch,
    });
    if (retryAfter === "121") {
      await assert.rejects(publication, /failed for all/);
      assert.equal(calls, 1);
      assert.deepEqual(fixture.waits, []);
    } else {
      assert.equal(await publication, "appended");
      assert.equal(calls, 2);
      assert.deepEqual(fixture.waits, [65_000]);
    }
  }
});

function retryPublicationFixture(t: { after: (cleanup: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-retry-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-retry-state-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  writeText(stateRoot, tupleItemPath, recordMarkdown("2026-07-26T01:00:00.000Z", "before"));
  writeText(root, tupleItemPath, recordMarkdown("2026-07-26T02:00:00.000Z", "after"));
  const waits: number[] = [];
  let clock = Date.parse("2026-10-10T00:00:00Z");
  return {
    options: { message: "test canonical retries", paths: [tupleRoot] },
    waits,
    runtime: {
      root,
      env: appendEnv({
        CLAWSWEEPER_STATE_DIR: stateRoot,
        CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
      }),
      now: () => new Date(clock),
      random: () => 1,
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      publishGit: (): PublishResult => {
        throw new Error("git publication must not run");
      },
    },
  };
}

test("publish-main canonically moves reconciled records from items to closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-state-"));
  const record = closeRecord("source-revision", "closed directly on GitHub");
  const tupleClosedPath = `${tupleRoot}/closed/42.md`;
  writeText(stateRoot, tupleItemPath, record);
  writeText(root, tupleClosedPath, record);
  const gitPublishes: GitPublishOptions[] = [];
  let posted: Record<string, unknown> | undefined;

  const result = await publishMainWithStateAppend(
    {
      message: "chore: persist sweep reconciliation",
      paths: [tupleItemPath, tupleClosedPath],
      rebaseStrategy: "normal",
    },
    {
      root,
      env: appendEnv({
        CLAWSWEEPER_STATE_DIR: stateRoot,
        CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
      }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(input.toString(), "https://queue.test/internal/state/records/tuples");
        posted = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
        return Response.json(
          { ok: true, accepted: true, deduped: false, revision: 8, sequence: 12 },
          { status: 202 },
        );
      }) as typeof fetch,
      publishGit: capturePublishes(gitPublishes),
    },
  );

  assert.equal(result, "appended");
  assert.equal(gitPublishes.length, 0);
  assert.equal(posted?.key, "openclaw-openclaw/42");
  assert.match(String(posted?.deliveryId), /^record-reconcile:openclaw-openclaw:42:[a-f0-9]{64}$/);
  assert.deepEqual(posted?.operations, [
    {
      path: tupleItemPath,
      expectedDigest: createHash("sha256").update(record).digest("hex"),
    },
    {
      path: tupleClosedPath,
      expectedDigest: null,
      contentBase64: Buffer.from(record).toString("base64"),
    },
    { path: `${tupleRoot}/plans/42.md`, expectedDigest: null },
    { path: `${tupleRoot}/decision-packets/42.json`, expectedDigest: null },
  ]);
});

test("publish-main keeps tuple projections out of worker-sparse Git publication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-sparse-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-sparse-state-"));
  const record = closeRecord("source-revision", "closed directly on GitHub");
  const tupleClosedPath = `${tupleRoot}/closed/42.md`;
  const tuplePlanPath = `${tupleRoot}/plans/42.md`;
  const tuplePacketPath = `${tupleRoot}/decision-packets/42.json`;
  writeText(stateRoot, tupleItemPath, record);
  writeText(root, tupleClosedPath, record);
  writeText(root, "apply-report.json", "[]\n");
  const gitPublishes: GitPublishOptions[] = [];

  const result = await publishMainWithStateAppend(
    {
      message: "chore: persist sweep reconciliation",
      paths: [tupleItemPath, tupleClosedPath, tuplePlanPath, tuplePacketPath, "apply-report.json"],
      rebaseStrategy: "normal",
    },
    {
      root,
      env: appendEnv({
        CLAWSWEEPER_STATE_DIR: stateRoot,
        CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
      }),
      fetchImpl: (async () =>
        Response.json(
          { ok: true, accepted: true, deduped: false, revision: 8, sequence: 12 },
          { status: 202 },
        )) as typeof fetch,
      publishGit: (options) => {
        assert.equal(
          options.paths.some((candidate) => candidate.startsWith("records/")),
          false,
          `worker-sparse Git stage received record paths: ${options.paths.join(", ")}`,
        );
        gitPublishes.push(options);
        return "committed";
      },
    },
  );

  assert.equal(result, "committed");
  assert.deepEqual(
    gitPublishes.map((publish) => publish.paths),
    [["apply-report.json"]],
  );
});

test("publish-main fails closed when canonical tuple publication is rejected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-record-state-"));
  writeText(stateRoot, tupleItemPath, recordMarkdown("2026-07-26T01:00:00.000Z", "before"));
  writeText(root, tupleItemPath, recordMarkdown("2026-07-26T02:00:00.000Z", "after"));
  const gitPublishes: GitPublishOptions[] = [];

  await assert.rejects(
    publishMainWithStateAppend(
      { message: "chore: update sweep records", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
        fetchImpl: (async () =>
          Response.json(
            { error: "canonical_record_tuple_conflict" },
            { status: 409 },
          )) as typeof fetch,
        publishGit: capturePublishes(gitPublishes),
      },
    ),
    /canonical_record_tuple_conflict/,
  );
  assert.equal(gitPublishes.length, 0);
});

test("publish-main refetches CURRENT and retries a conflicted reconciliation move once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-current-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-current-state-"));
  const sparseStateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-canonical-current-sparse-state-"),
  );
  const canonicalBaselineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-canonical-current-baseline-"),
  );
  const baseline = closeRecord("old-source-revision", "baseline", "open");
  const target = closeRecord("old-source-revision", "baseline", "closed");
  const current = closeRecord("new-source-revision", "event-driven review", "open");
  const rebased = closeRecord("new-source-revision", "event-driven review", "closed");
  const tupleClosedPath = `${tupleRoot}/closed/42.md`;
  writeText(stateRoot, tupleItemPath, baseline);
  captureCanonicalRecordBaseline({
    baselineRoot: canonicalBaselineRoot,
    repositorySlug: "openclaw-openclaw",
    itemNumber: 42,
    sources: [
      { section: "items", name: "42.md", path: path.join(stateRoot, tupleItemPath) },
      { section: "closed", name: "42.md", path: path.join(stateRoot, tupleClosedPath) },
      {
        section: "plans",
        name: "42.md",
        path: path.join(stateRoot, `${tupleRoot}/plans/42.md`),
      },
      {
        section: "decision-packets",
        name: "42.json",
        path: path.join(stateRoot, `${tupleRoot}/decision-packets/42.json`),
      },
    ],
  });
  writeText(root, tupleClosedPath, target);
  const posted: Array<Record<string, unknown>> = [];
  const deferredPath = path.join(root, ".artifacts/deferred.jsonl");

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: persist sweep reconciliation", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({
          CLAWSWEEPER_STATE_DIR: sparseStateRoot,
          CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: canonicalBaselineRoot,
          CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
          CLAWSWEEPER_RECONCILE_DEFERRED_PATH: deferredPath,
        }),
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const mutation = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
          posted.push(mutation);
          if (posted.length === 1) {
            return conflictResponse(current, "record-tuple:event-review:42");
          }
          const operations = mutation.operations as Array<Record<string, unknown>>;
          assert.equal(
            operations[0]?.expectedDigest,
            createHash("sha256").update(current).digest("hex"),
          );
          assert.equal(operations[0]?.contentBase64, undefined);
          assert.equal(
            Buffer.from(String(operations[1]?.contentBase64), "base64").toString("utf8"),
            rebased,
          );
          return Response.json(
            { ok: true, accepted: true, deduped: false, revision: 3, sequence: 12 },
            { status: 202 },
          );
        }) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    "appended",
  );
  assert.equal(posted.length, 2);
  assert.match(String(posted[0]?.deliveryId), /^record-reconcile:openclaw-openclaw:42:/);
  assert.match(String(posted[1]?.deliveryId), /^record-reconcile:openclaw-openclaw:42:/);
  assert.equal(fs.existsSync(deferredPath), false);
  assert.equal(fs.existsSync(path.join(root, tupleItemPath)), false);
  assert.equal(fs.readFileSync(path.join(root, tupleClosedPath), "utf8"), rebased);
});

test("publish-main skips a conflicted reconciliation move already completed in CURRENT", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-skip-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-skip-state-"));
  const baseline = closeRecord("old-source-revision", "baseline", "open");
  const target = closeRecord("old-source-revision", "baseline", "closed");
  const current = closeRecord("new-source-revision", "already moved", "closed");
  const tupleClosedPath = `${tupleRoot}/closed/42.md`;
  writeText(stateRoot, tupleItemPath, baseline);
  writeText(root, tupleClosedPath, target);
  const deferredPath = path.join(root, ".artifacts/deferred.jsonl");
  const warnings: string[] = [];
  let posts = 0;
  t.mock.method(console, "warn", (message: string) => warnings.push(message));

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: persist sweep reconciliation", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({
          CLAWSWEEPER_STATE_DIR: stateRoot,
          CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
          CLAWSWEEPER_RECONCILE_DEFERRED_PATH: deferredPath,
        }),
        fetchImpl: (async () => {
          posts += 1;
          return conflictResponse(current, "record-tuple:event-close:42", "closed");
        }) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    "appended",
  );
  assert.equal(posts, 1);
  assert.equal(fs.existsSync(path.join(root, tupleItemPath)), false);
  assert.equal(fs.readFileSync(path.join(root, tupleClosedPath), "utf8"), current);
  assert.equal(fs.existsSync(deferredPath), false);
  assert.deepEqual(warnings, [
    "Skipped openclaw-openclaw/42: canonical CURRENT revision 2 already has closed placement",
  ]);
});

test("publish-main isolates a poison reconciliation tuple and publishes its sibling", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-batch-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-batch-state-"));
  const before = recordMarkdown("2026-07-26T01:00:00.000Z", "before");
  const after = recordMarkdown("2026-07-26T02:00:00.000Z", "after");
  writeText(stateRoot, tupleItemPath, before);
  writeText(root, tupleItemPath, after);
  const poisonItemPath = `${tupleRoot}/items/43.md`;
  const poisonClosedPath = `${tupleRoot}/closed/43.md`;
  writeText(stateRoot, poisonItemPath, before.replace("number: 42", "number: 43"));
  writeText(root, poisonItemPath, after.replace("number: 42", "number: 43"));
  writeText(root, poisonClosedPath, after.replace("number: 42", "number: 43"));
  const errors: string[] = [];
  const warnings: string[] = [];
  const postedKeys: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  t.mock.method(console, "warn", (message: string) => warnings.push(message));

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: persist sweep reconciliation", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({
          CLAWSWEEPER_STATE_DIR: stateRoot,
          CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
        }),
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const mutation = JSON.parse(String(init?.body ?? "")) as { key: string };
          postedKeys.push(mutation.key);
          return Response.json(
            { ok: true, accepted: true, deduped: false, revision: 7, sequence: 11 },
            { status: 202 },
          );
        }) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    "appended",
  );
  assert.deepEqual(postedKeys, ["openclaw-openclaw/42"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /openclaw-openclaw\/43 failed: .*both open and closed/);
  assert.deepEqual(warnings, ["[canonical reconcile] continued after 1 of 2 item(s) failed"]);
});

test("publish-main resolves a non-reconcile conflict whose CURRENT already contains the change", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-equivalent-source-"));
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-canonical-equivalent-state-"),
  );
  const before = recordMarkdown("2026-07-26T01:00:00.000Z", "before");
  const after = recordMarkdown("2026-07-26T02:00:00.000Z", "after");
  const concurrentPlan = "concurrent work plan\n";
  writeText(stateRoot, tupleItemPath, before);
  writeText(root, tupleItemPath, after);
  const warnings: string[] = [];
  let posts = 0;
  t.mock.method(console, "warn", (message: string) => warnings.push(message));

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: update sweep records", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
        fetchImpl: (async () => {
          posts += 1;
          return tupleConflictResponse({ item: after, plan: concurrentPlan });
        }) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    "appended",
  );
  assert.equal(posts, 1);
  assert.equal(fs.readFileSync(path.join(root, tupleItemPath), "utf8"), after);
  assert.equal(
    fs.readFileSync(path.join(root, `${tupleRoot}/plans/42.md`), "utf8"),
    concurrentPlan,
  );
  assert.deepEqual(warnings, [
    "Skipped openclaw-openclaw/42: canonical CURRENT revision 2 already contains this publication",
  ]);
});

test("publish-main rebases a non-reconcile conflict on an unrelated section and retries once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-rebase-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-rebase-state-"));
  const before = recordMarkdown("2026-07-26T01:00:00.000Z", "before");
  const after = recordMarkdown("2026-07-26T02:00:00.000Z", "after");
  const concurrentPlan = "concurrent work plan\n";
  writeText(stateRoot, tupleItemPath, before);
  writeText(root, tupleItemPath, after);
  const warnings: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: update sweep records", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const mutation = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
          posted.push(mutation);
          if (posted.length === 1) {
            return tupleConflictResponse({ item: before, plan: concurrentPlan });
          }
          return Response.json(
            { ok: true, accepted: true, deduped: false, revision: 3, sequence: 12 },
            { status: 202 },
          );
        }) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    "appended",
  );
  assert.equal(posted.length, 2);
  assert.match(String(posted[0]?.deliveryId), /^record-tuple:1234:2:[a-f0-9]{64}$/);
  assert.match(String(posted[1]?.deliveryId), /^record-tuple-rebase:1234:2:[a-f0-9]{64}$/);
  const retryOperations = posted[1]?.operations as Array<Record<string, unknown>>;
  assert.equal(
    retryOperations[0]?.expectedDigest,
    createHash("sha256").update(before).digest("hex"),
  );
  assert.equal(
    Buffer.from(String(retryOperations[0]?.contentBase64), "base64").toString("utf8"),
    after,
  );
  assert.equal(
    retryOperations[2]?.expectedDigest,
    createHash("sha256").update(concurrentPlan).digest("hex"),
  );
  assert.equal(
    Buffer.from(String(retryOperations[2]?.contentBase64), "base64").toString("utf8"),
    concurrentPlan,
  );
  assert.equal(fs.readFileSync(path.join(root, tupleItemPath), "utf8"), after);
  assert.equal(
    fs.readFileSync(path.join(root, `${tupleRoot}/plans/42.md`), "utf8"),
    concurrentPlan,
  );
  assert.deepEqual(warnings, ["Rebased openclaw-openclaw/42 onto canonical CURRENT revision 2"]);
});

test("publish-main skips a non-reconcile conflict on its own section and publishes its sibling", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-own-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-own-state-"));
  const before = recordMarkdown("2026-07-26T01:00:00.000Z", "before");
  const after = recordMarkdown("2026-07-26T02:00:00.000Z", "after");
  const concurrent = recordMarkdown("2026-07-26T03:00:00.000Z", "concurrent review");
  writeText(stateRoot, tupleItemPath, before);
  writeText(root, tupleItemPath, after);
  const siblingItemPath = `${tupleRoot}/items/43.md`;
  writeText(stateRoot, siblingItemPath, before.replace("number: 42", "number: 43"));
  writeText(root, siblingItemPath, after.replace("number: 42", "number: 43"));
  const warnings: string[] = [];
  const postedKeys: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: update sweep records", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const mutation = JSON.parse(String(init?.body ?? "")) as { key: string };
          postedKeys.push(mutation.key);
          if (mutation.key === "openclaw-openclaw/42") {
            return tupleConflictResponse({ item: concurrent });
          }
          return Response.json(
            { ok: true, accepted: true, deduped: false, revision: 7, sequence: 11 },
            { status: 202 },
          );
        }) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    "appended",
  );
  assert.deepEqual(postedKeys, ["openclaw-openclaw/42", "openclaw-openclaw/43"]);
  assert.equal(fs.readFileSync(path.join(root, tupleItemPath), "utf8"), concurrent);
  assert.equal(
    fs.readFileSync(path.join(root, siblingItemPath), "utf8"),
    after.replace("number: 42", "number: 43"),
  );
  assert.deepEqual(warnings, [
    "Skipped openclaw-openclaw/42: canonical CURRENT revision 2 concurrently changed a section this publication also changed",
    "[canonical publish] continued after 1 of 2 conflicted item(s) were skipped",
  ]);
});

test("publish-main fails when every non-reconcile item conflicts on its own section", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-allskip-source-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-canonical-allskip-state-"));
  const before = recordMarkdown("2026-07-26T01:00:00.000Z", "before");
  const after = recordMarkdown("2026-07-26T02:00:00.000Z", "after");
  const concurrent = recordMarkdown("2026-07-26T03:00:00.000Z", "concurrent review");
  writeText(stateRoot, tupleItemPath, before);
  writeText(root, tupleItemPath, after);
  t.mock.method(console, "warn", () => {});

  await assert.rejects(
    publishMainWithStateAppend(
      { message: "chore: update sweep records", paths: [tupleRoot] },
      {
        root,
        env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
        fetchImpl: (async () => tupleConflictResponse({ item: concurrent })) as typeof fetch,
        publishGit: () => {
          throw new Error("git publication must not run");
        },
      },
    ),
    /Canonical publication conflicted for all 1 item\(s\)/,
  );
  assert.equal(fs.readFileSync(path.join(root, tupleItemPath), "utf8"), concurrent);
});

test("publish-main keeps sweep status on the git-backed operational lane", async () => {
  const root = statusFixture();
  const gitPublishes: GitPublishOptions[] = [];
  let fetchCalls = 0;

  const result = await publishMainWithStateAppend(
    { message: "chore: update sweep status", paths: [statusPath] },
    {
      root,
      env: appendEnv(),
      fetchImpl: (async () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      }) as typeof fetch,
      publishGit: (options) => {
        gitPublishes.push(options);
        return "committed";
      },
    },
  );

  assert.equal(result, "committed");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(gitPublishes[0]?.paths, [statusPath]);
});

test("publish-main keeps router jobs and results together on the git publisher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-router-"));
  writeJson(root, routerPath, routerLedger());
  const gitPublishes: GitPublishOptions[] = [];

  assert.equal(
    await publishMainWithStateAppend(
      {
        message: "chore: record ClawSweeper comment routing",
        paths: [routerPath, "results/comment-router-latest.json", "jobs"],
        rebaseStrategy: "theirs",
      },
      {
        root,
        env: appendEnv(),
        publishGit: capturePublishes(gitPublishes),
      },
    ),
    "committed",
  );
  assert.deepEqual(gitPublishes[0]?.paths, [
    routerPath,
    "results/comment-router-latest.json",
    "jobs",
  ]);
  assert.equal(gitPublishes[0]?.rebaseStrategy, "theirs");
});

test("publish-main publishes commit reports to the canonical Worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-commit-"));
  const sha = "c".repeat(40);
  const commitPath = `records/openclaw-openclaw/commits/${sha}.md`;
  writeText(root, commitPath, "canonical commit report\n");
  const gitPublishes: GitPublishOptions[] = [];
  let posted: Record<string, unknown> | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    posted = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
    return Response.json({ ok: true, inserted: 1, unchanged: 0 }, { status: 202 });
  }) as typeof fetch;

  assert.equal(
    await publishMainWithStateAppend(
      { message: "chore: publish commit reports", paths: [commitPath] },
      { root, env: appendEnv(), fetchImpl, publishGit: capturePublishes(gitPublishes) },
    ),
    "appended",
  );
  assert.equal(gitPublishes.length, 0);
  assert.deepEqual(posted, {
    repo_slug: "openclaw-openclaw",
    records: [
      {
        sha,
        content: "canonical commit report\n",
        digest: createHash("sha256").update("canonical commit report\n").digest("hex"),
      },
    ],
  });
});

test("publish-main refuses retired ledger and asset git paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-retired-git-path-"));
  const gitPublishes: GitPublishOptions[] = [];
  for (const retiredPath of [proofPath, "assets/dashboard.json"]) {
    await assert.rejects(
      publishMainWithStateAppend(
        { message: "chore: retired git write", paths: [retiredPath] },
        { root, env: appendEnv(), publishGit: capturePublishes(gitPublishes) },
      ),
      /refusing retired git state publication/,
    );
  }
  assert.equal(gitPublishes.length, 0);
});

function statusFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-main-"));
  writeStatus(root, "openclaw-openclaw");
  return root;
}

function writeStatus(root: string, slug: string): void {
  const target = path.join(root, `results/sweep-status/${slug}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(sweepStatus(slug))}\n`);
}

function writeJson(root: string, file: string, value: unknown): void {
  writeText(root, file, `${JSON.stringify(value)}\n`);
}

function writeText(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function sweepStatus(slug = "openclaw-openclaw"): Record<string, unknown> {
  return {
    schema_version: 1,
    slug,
    state: "Review in progress",
    updated_at: "2026-07-21T12:00:00.000Z",
  };
}

function routerLedger(): Record<string, unknown> {
  return {
    updated_at: "2026-07-21T12:10:00.000Z",
    commands: [
      {
        comment_version_key: "router-a",
        comment_id: "123",
        comment_updated_at: "2026-07-21T12:09:00.000Z",
        status: "executed",
        processed_at: "2026-07-21T12:10:00.000Z",
      },
    ],
  };
}

function recordMarkdown(reviewedAt: string, body: string): string {
  return `---\nrepo: openclaw/openclaw\nnumber: 42\nreviewed_at: ${reviewedAt}\n---\n\n${body}\n`;
}

function closeRecord(
  sourceRevision: string,
  body: string,
  currentState: "open" | "closed" = "open",
): string {
  return [
    "---",
    "repo: openclaw/openclaw",
    "number: 42",
    "kind: pull_request",
    `current_state: ${currentState}`,
    "decision: close",
    "close_reason: duplicate_or_superseded",
    `item_source_revision: ${sourceRevision}`,
    "decision_packet_sha256: none",
    "decision_packet_path: none",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function conflictResponse(
  current: string,
  deliveryId: string,
  section: "items" | "closed" = "items",
): Response {
  const currentPath = section === "items" ? tupleItemPath : `${tupleRoot}/closed/42.md`;
  return Response.json(
    {
      error: "canonical_record_tuple_conflict",
      current: {
        key: "openclaw-openclaw/42",
        revision: 2,
        deliveryId,
        operations: [
          section === "items"
            ? {
                path: tupleItemPath,
                expectedDigest: createHash("sha256").update(current).digest("hex"),
                contentBase64: Buffer.from(current).toString("base64"),
              }
            : { path: tupleItemPath, expectedDigest: null },
          section === "closed"
            ? {
                path: currentPath,
                expectedDigest: createHash("sha256").update(current).digest("hex"),
                contentBase64: Buffer.from(current).toString("base64"),
              }
            : { path: `${tupleRoot}/closed/42.md`, expectedDigest: null },
          { path: `${tupleRoot}/plans/42.md`, expectedDigest: null },
          { path: `${tupleRoot}/decision-packets/42.json`, expectedDigest: null },
        ],
      },
    },
    { status: 409 },
  );
}

function tupleConflictResponse(
  contents: { item?: string; closed?: string; plan?: string; packet?: string },
  revision = 2,
): Response {
  const operation = (operationPath: string, content?: string) =>
    content === undefined
      ? { path: operationPath, expectedDigest: null }
      : {
          path: operationPath,
          expectedDigest: createHash("sha256").update(content).digest("hex"),
          contentBase64: Buffer.from(content).toString("base64"),
        };
  return Response.json(
    {
      error: "canonical_record_tuple_conflict",
      current: {
        key: "openclaw-openclaw/42",
        revision,
        deliveryId: "record-tuple:concurrent-run:1",
        operations: [
          operation(tupleItemPath, contents.item),
          operation(`${tupleRoot}/closed/42.md`, contents.closed),
          operation(`${tupleRoot}/plans/42.md`, contents.plan),
          operation(`${tupleRoot}/decision-packets/42.json`, contents.packet),
        ],
      },
    },
    { status: 409 },
  );
}

function appendEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    QUEUE_URL: "https://queue.test",
    CLAWSWEEPER_WEBHOOK_SECRET: "publish-main-test-secret",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "2",
    ...overrides,
  };
}

function capturePublishes(
  publishes: GitPublishOptions[],
): (options: GitPublishOptions) => PublishResult {
  return (options) => {
    publishes.push(options);
    return "committed";
  };
}
