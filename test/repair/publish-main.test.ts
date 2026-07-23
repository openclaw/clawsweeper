import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishMainWithStateAppend } from "../../dist/repair/publish-main.js";
import type { GitPublishOptions, PublishResult } from "../../dist/repair/git-publish.js";

const statusPath = "results/sweep-status/openclaw-openclaw.json";
const routerPath = "results/comment-router.json";
const proofPath = `ledger/v1/import-bindings/events/${"a".repeat(64)}.json`;
const oversizedProofPath = `ledger/v1/import-bindings/events/${"b".repeat(64)}.json`;

test("publish-main appends sweep status instead of invoking the git publisher", async () => {
  const root = statusFixture();
  const gitPublishes: GitPublishOptions[] = [];
  let posted: Record<string, unknown> | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    posted = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
    return Response.json({ ok: true, appended: 1 }, { status: 202 });
  }) as typeof fetch;

  const result = await publishMainWithStateAppend(
    { message: "chore: update sweep status", paths: [statusPath] },
    {
      root,
      env: appendEnv(),
      fetchImpl,
      publishGit: (options) => {
        gitPublishes.push(options);
        return "committed";
      },
    },
  );

  assert.equal(result, "appended");
  assert.equal(gitPublishes.length, 0);
  assert.match(String(posted?.delivery_id), /^router:sweep-status-1234-2-[a-f0-9]{64}$/);
  assert.deepEqual(posted?.records, [
    {
      kind: "sweep_status",
      key: statusPath,
      payload: sweepStatus(),
      produced_at: "2026-07-21T12:00:00.000Z",
    },
  ]);
});

test("publish-main keeps mixed non-status paths on the git publisher", async () => {
  const root = statusFixture();
  const gitPublishes: GitPublishOptions[] = [];
  const fetchImpl = (async () =>
    Response.json({ ok: true, appended: 1 }, { status: 202 })) as typeof fetch;

  assert.equal(
    await publishMainWithStateAppend(
      {
        message: "chore: publish sweep audit status",
        paths: ["README.md", statusPath],
        rebaseStrategy: "theirs",
      },
      {
        root,
        env: appendEnv(),
        fetchImpl,
        publishGit: capturePublishes(gitPublishes),
      },
    ),
    "committed",
  );
  assert.deepEqual(gitPublishes[0]?.paths, ["README.md"]);
  assert.equal(gitPublishes[0]?.rebaseStrategy, "theirs");
});

test("publish-main publishes dependent router outputs before appending a content-addressed ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-router-"));
  writeJson(root, routerPath, routerLedger());
  const gitPublishes: GitPublishOptions[] = [];
  const deliveries: string[] = [];
  const routerPayload = routerLedger();
  const routerKey = createHash("sha256").update(JSON.stringify(routerPayload)).digest("hex");
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(gitPublishes.length, deliveries.length + 1);
    const body = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
    deliveries.push(String(body.delivery_id));
    assert.deepEqual(body.records, [
      {
        kind: "comment_router",
        key: routerKey,
        payload: routerPayload,
        produced_at: "2026-07-21T12:10:00.000Z",
      },
    ]);
    return Response.json({ ok: true, appended: 1 }, { status: 202 });
  }) as typeof fetch;
  const options = {
    message: "chore: record ClawSweeper comment routing",
    paths: [routerPath, "results/comment-router-latest.json", "jobs"],
    rebaseStrategy: "theirs" as const,
  };

  for (const instant of ["2026-07-21T12:11:00.000Z", "2026-07-21T12:12:00.000Z"]) {
    assert.equal(
      await publishMainWithStateAppend(options, {
        root,
        env: appendEnv(),
        fetchImpl,
        now: () => new Date(instant),
        publishGit: capturePublishes(gitPublishes),
      }),
      "committed",
    );
  }

  assert.deepEqual(
    gitPublishes.map((publish) => publish.paths),
    [
      ["results/comment-router-latest.json", "jobs"],
      ["results/comment-router-latest.json", "jobs"],
    ],
  );
  assert.match(deliveries[0] ?? "", /^router:comment-router-1234-2-[a-f0-9]{64}$/);
  assert.equal(deliveries[1], deliveries[0]);
});

test("publish-main falls back to the full comment-router git publish on shed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-router-"));
  writeJson(root, routerPath, routerLedger());
  const gitPublishes: GitPublishOptions[] = [];
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const original = {
    message: "chore: record ClawSweeper comment routing",
    paths: [routerPath, "jobs"],
    rebaseStrategy: "theirs" as const,
  };

  assert.equal(
    await publishMainWithStateAppend(original, {
      root,
      env: appendEnv(),
      fetchImpl: (async () =>
        Response.json({ ok: false, shed: true }, { status: 429 })) as typeof fetch,
      publishGit: capturePublishes(gitPublishes),
    }),
    "committed",
  );
  assert.deepEqual(
    gitPublishes.map((publish) => publish.paths),
    [["jobs"], [routerPath, "jobs"]],
  );
  assert.deepEqual(warnings, ["state-append shed/failed; falling back to git publish"]);
});

test("publish-main appends canonical apply-proof content and git-publishes an oversized sibling", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-proof-"));
  const canonical =
    '{"event_id":"proof-event","schema":"clawsweeper.action-ledger-import-event-binding","schema_version":1}\n';
  writeText(root, proofPath, canonical);
  writeText(root, oversizedProofPath, "x".repeat(256 * 1024));
  const gitPublishes: GitPublishOptions[] = [];
  const warnings: string[] = [];
  let posted: Record<string, unknown> | undefined;
  t.mock.method(console, "warn", (message: string) => warnings.push(message));

  assert.equal(
    await publishMainWithStateAppend(
      {
        message: "chore: append apply proof action ledger",
        paths: [proofPath, oversizedProofPath],
        rebaseStrategy: "normal",
      },
      {
        root,
        env: appendEnv(),
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          posted = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
          return Response.json({ ok: true, appended: 1 }, { status: 202 });
        }) as typeof fetch,
        now: () => new Date("2026-07-21T12:20:00.000Z"),
        publishGit: capturePublishes(gitPublishes),
      },
    ),
    "committed",
  );

  assert.match(String(posted?.delivery_id), /^router:apply-proof-1234-2-[a-f0-9]{64}$/);
  assert.deepEqual(posted?.records, [
    {
      kind: "apply_proof",
      key: proofPath,
      payload: canonical,
      produced_at: "2026-07-21T12:20:00.000Z",
    },
  ]);
  assert.deepEqual(gitPublishes[0]?.paths, [oversizedProofPath]);
  assert.deepEqual(warnings, [
    `State append apply-proof record ${oversizedProofPath} exceeds 262144 bytes; using git fallback`,
  ]);
});

test("publish-main rejects an apply-proof symlink outside the workspace and uses git fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-proof-"));
  const outside = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-proof-outside-")),
    "secret.json",
  );
  fs.writeFileSync(outside, '{"sensitive":"must-not-post"}\n');
  const target = path.join(root, proofPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.symlinkSync(outside, target, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("file symlinks require an elevated Windows test environment");
      return;
    }
    throw error;
  }
  const gitPublishes: GitPublishOptions[] = [];
  const warnings: string[] = [];
  let fetchCalls = 0;
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const original = { message: "chore: append apply proof action ledger", paths: [proofPath] };

  assert.equal(
    await publishMainWithStateAppend(original, {
      root,
      env: appendEnv(),
      fetchImpl: (async () => {
        fetchCalls += 1;
        return Response.json({ ok: true, appended: 1 }, { status: 202 });
      }) as typeof fetch,
      publishGit: capturePublishes(gitPublishes),
    }),
    "committed",
  );

  assert.equal(fetchCalls, 0);
  assert.deepEqual(gitPublishes, [original]);
  assert.deepEqual(warnings, ["state-append shed/failed; falling back to git publish"]);
});

test("publish-main falls back to the original git publish on shed", async (t) => {
  const root = statusFixture();
  const stateRoot = statusFixture();
  const gitPublishes: GitPublishOptions[] = [];
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const original = {
    message: "chore: update sweep status",
    paths: ["results/sweep-status"],
    rebaseStrategy: "apply-records" as const,
  };

  assert.equal(
    await publishMainWithStateAppend(original, {
      root,
      env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
      fetchImpl: (async () =>
        Response.json({ ok: false, shed: true }, { status: 429 })) as typeof fetch,
      publishGit: capturePublishes(gitPublishes),
    }),
    "committed",
  );
  assert.deepEqual(gitPublishes, [original]);
  assert.deepEqual(warnings, ["state-append shed/failed; falling back to git publish"]);
});

test("publish-main keeps directory deletions on the git fallback path", async (t) => {
  const root = statusFixture();
  const stateRoot = statusFixture();
  writeStatus(stateRoot, "openclaw-clawhub");
  const gitPublishes: GitPublishOptions[] = [];
  const warnings: string[] = [];
  let fetchCalls = 0;
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const original = {
    message: "chore: delete stale sweep status",
    paths: ["results/sweep-status"],
    rebaseStrategy: "apply-records" as const,
  };

  assert.equal(
    await publishMainWithStateAppend(original, {
      root,
      env: appendEnv({ CLAWSWEEPER_STATE_DIR: stateRoot }),
      fetchImpl: (async () => {
        fetchCalls += 1;
        return Response.json({ ok: true }, { status: 202 });
      }) as typeof fetch,
      publishGit: capturePublishes(gitPublishes),
    }),
    "committed",
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(gitPublishes, [original]);
  assert.deepEqual(warnings, ["state-append shed/failed; falling back to git publish"]);
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

function appendEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_STATE_APPEND_ENABLED: "1",
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
