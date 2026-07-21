import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanupStateCompactionBackup,
  createStateCompactionBackup,
  runStateCompactionPreflight,
} from "../../dist/repair/state-compaction.js";

const token = "test-token-state";
const expectedHead = "a".repeat(40);

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_STATE_REPO_TOKEN: token,
    GITHUB_API_URL: "https://api.github.test",
    STATE_REPOSITORY: "openclaw/clawsweeper-state",
    STATE_REPO_SIZE_WARN_GB: "5",
    ...overrides,
  };
}

test("compaction preflight skips below the repository warning threshold", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.join(" ")));
  const result = await runStateCompactionPreflight({
    env: env(),
    fetchImpl: (async () => Response.json({ size: 4 * 1024 * 1024 })) as typeof fetch,
  });
  assert.deepEqual(result, { compact: false, sizeGb: 4, thresholdGb: 5 });
  assert.ok(logged.includes("state compaction: skipped at 4.00GB (threshold 5GB)"));
});

test("compaction preflight proceeds only above the repository warning threshold", async () => {
  const result = await runStateCompactionPreflight({
    env: env(),
    fetchImpl: (async () => Response.json({ size: 5.25 * 1024 * 1024 })) as typeof fetch,
  });
  assert.deepEqual(result, { compact: true, sizeGb: 5.25, thresholdGb: 5 });
});

test("backup creation verifies live main and creates a dated ref at the exact head", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: expectedHead } });
    }
    if (method === "GET") return new Response(null, { status: 404 });
    return Response.json({
      ref: "refs/heads/backup/pre-compact-2026-07-21",
      object: { sha: expectedHead },
    });
  };

  const result = await createStateCompactionBackup({
    env: env({ STATE_COMPACTION_EXPECTED_HEAD: expectedHead }),
    fetchImpl: mockFetch as typeof fetch,
    now: new Date("2026-07-21T12:00:00.000Z"),
  });

  assert.deepEqual(result, {
    backupRef: "backup/pre-compact-2026-07-21",
    expectedHead,
  });
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/repos/openclaw/clawsweeper-state/git/ref/heads/main",
      body: null,
    },
    {
      method: "GET",
      path: "/repos/openclaw/clawsweeper-state/git/ref/heads/backup/pre-compact-2026-07-21",
      body: null,
    },
    {
      method: "POST",
      path: "/repos/openclaw/clawsweeper-state/git/refs",
      body: { ref: "refs/heads/backup/pre-compact-2026-07-21", sha: expectedHead },
    },
  ]);
});

test("backup creation refuses a moved main before creating a ref", async () => {
  let requests = 0;
  await assert.rejects(
    createStateCompactionBackup({
      env: env({ STATE_COMPACTION_EXPECTED_HEAD: expectedHead }),
      fetchImpl: (async () => {
        requests += 1;
        return Response.json({ object: { sha: "b".repeat(40) } });
      }) as typeof fetch,
    }),
    /state head moved before backup creation/,
  );
  assert.equal(requests, 1);
});

test("backup creation reuses an exact same-day ref", async () => {
  let requests = 0;
  const result = await createStateCompactionBackup({
    env: env({ STATE_COMPACTION_EXPECTED_HEAD: expectedHead }),
    fetchImpl: (async (_input, init) => {
      requests += 1;
      assert.equal(init?.method, undefined);
      if (requests === 1) return Response.json({ object: { sha: expectedHead } });
      return Response.json({
        ref: "refs/heads/backup/pre-compact-2026-07-21",
        object: { sha: expectedHead },
      });
    }) as typeof fetch,
    now: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.equal(result.backupRef, "backup/pre-compact-2026-07-21");
  assert.equal(requests, 2);
});

test("backup creation refuses to continue when GitHub rejects the backup ref", async () => {
  let requests = 0;
  await assert.rejects(
    createStateCompactionBackup({
      env: env({ STATE_COMPACTION_EXPECTED_HEAD: expectedHead }),
      fetchImpl: (async () => {
        requests += 1;
        if (requests === 1) return Response.json({ object: { sha: expectedHead } });
        if (requests === 2) return new Response(null, { status: 404 });
        return Response.json({ message: "rejected" }, { status: 422 });
      }) as typeof fetch,
    }),
    /POST backup ref returned 422/,
  );
  assert.equal(requests, 3);
});

test("transactional backup cleanup verifies both refs before deleting history", async () => {
  const newHead = "b".repeat(40);
  const requests: Array<{ method: string; path: string }> = [];
  const result = await cleanupStateCompactionBackup({
    env: env({
      STATE_COMPACTION_BACKUP_REF: "backup/pre-compact-2026-07-21",
      STATE_COMPACTION_EXPECTED_HEAD: expectedHead,
      STATE_COMPACTION_NEW_HEAD: newHead,
    }),
    fetchImpl: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ method: init?.method ?? "GET", path: url.pathname });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: newHead } });
      }
      return Response.json({ object: { sha: expectedHead } });
    }) as typeof fetch,
  });
  assert.deepEqual(result, {
    backupRef: "backup/pre-compact-2026-07-21",
    expectedHead,
    newHead,
  });
  assert.deepEqual(requests, [
    { method: "GET", path: "/repos/openclaw/clawsweeper-state/git/ref/heads/main" },
    {
      method: "GET",
      path: "/repos/openclaw/clawsweeper-state/git/ref/heads/backup/pre-compact-2026-07-21",
    },
    {
      method: "DELETE",
      path: "/repos/openclaw/clawsweeper-state/git/refs/heads/backup/pre-compact-2026-07-21",
    },
  ]);
});

test("compaction workflow preserves backup and lease safety", () => {
  const workflow = readFileSync(".github/workflows/state-compaction.yml", "utf8");
  assert.match(workflow, /cron: "17 9 1 \* \*"/);
  assert.match(workflow, /node dist\/repair\/state-compaction\.js preflight/);
  assert.match(workflow, /node dist\/repair\/state-compaction\.js prepare-backup/);
  assert.match(workflow, /node dist\/repair\/state-compaction\.js cleanup-backup/);
  assert.match(workflow, /git -C "\$state_dir" commit-tree "\$tree"/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/main:\$EXPECTED_HEAD"/);
  assert.match(workflow, /test "\$remote_head" = "\$new_head"/);
});
