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
