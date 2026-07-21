import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishMainWithStateAppend } from "../../dist/repair/publish-main.js";
import type { GitPublishOptions, PublishResult } from "../../dist/repair/git-publish.js";

const statusPath = "results/sweep-status/openclaw-openclaw.json";

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

function sweepStatus(slug = "openclaw-openclaw"): Record<string, unknown> {
  return {
    schema_version: 1,
    slug,
    state: "Review in progress",
    updated_at: "2026-07-21T12:00:00.000Z",
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
