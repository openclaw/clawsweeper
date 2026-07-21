import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStateBranchIdentity,
  runStateBranchJanitor,
} from "../../dist/repair/state-branch-janitor.js";
import { runStateRepoSizeCheck } from "../../dist/repair/state-repo-size.js";

const now = new Date("2026-07-21T12:00:00.000Z");
const stateToken = "test-token-state";
const sourceToken = "test-token-source";

function branch(runId: string, attempt = 1, suffix = "abcdef123456") {
  return {
    ref: `refs/heads/clawsweeper/immutable-ledger/${runId}-${attempt}-42-${suffix}`,
    object: { sha: runId.padStart(40, "a") },
  };
}

function janitorEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_STATE_REPO_TOKEN: stateToken,
    GH_TOKEN: sourceToken,
    GITHUB_API_URL: "https://api.github.test",
    STATE_BRANCH_RUN_REPOSITORY: "openclaw/clawsweeper",
    STATE_REPOSITORY: "openclaw/clawsweeper-state",
    ...overrides,
  };
}

test("scratch branch identity accepts only the immutable-ledger run tuple", () => {
  assert.deepEqual(
    parseStateBranchIdentity("refs/heads/clawsweeper/immutable-ledger/12345-2-99-abcdef123456"),
    {
      branch: "clawsweeper/immutable-ledger/12345-2-99-abcdef123456",
      runId: "12345",
      runAttempt: 2,
    },
  );
  assert.equal(parseStateBranchIdentity("refs/heads/clawsweeper/immutable-ledger/not-a-run"), null);
  assert.equal(parseStateBranchIdentity("refs/heads/main"), null);
});

test("janitor deletes completed or old runs, respects its cap, and keeps recent runs", async (t) => {
  const deleted: string[] = [];
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.join(" ")));
  const references = [
    branch("100"),
    branch("200"),
    branch("300"),
    branch("400"),
    { ref: "refs/heads/clawsweeper/immutable-ledger/unparseable", object: { sha: "f".repeat(40) } },
  ];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname.includes("/git/matching-refs/")) {
      assert.equal(authorization, `Bearer ${stateToken}`);
      assert.equal(
        url.pathname,
        "/repos/openclaw/clawsweeper-state/git/matching-refs/heads/clawsweeper/immutable-ledger",
      );
      return Response.json(references);
    }
    const runMatch = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (runMatch) {
      assert.equal(authorization, `Bearer ${sourceToken}`);
      const runId = runMatch[1]!;
      const created_at = runId === "200" ? "2026-07-21T11:00:00.000Z" : "2026-07-19T11:00:00.000Z";
      return Response.json({
        id: Number(runId),
        status: runId === "100" || runId === "400" ? "completed" : "in_progress",
        created_at,
      });
    }
    if (init?.method === "DELETE") {
      assert.equal(authorization, `Bearer ${stateToken}`);
      deleted.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runStateBranchJanitor({
    env: janitorEnv({
      STATE_BRANCH_MAX_AGE_HOURS: "24",
      STATE_BRANCH_MAX_DELETIONS: "2",
    }),
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, { scanned: 5, deleted: 2, kept: 3, errors: 0 });
  assert.deepEqual(deleted, [
    "/repos/openclaw/clawsweeper-state/git/refs/heads/clawsweeper/immutable-ledger/100-1-42-abcdef123456",
    "/repos/openclaw/clawsweeper-state/git/refs/heads/clawsweeper/immutable-ledger/300-1-42-abcdef123456",
  ]);
  assert.ok(logged.includes("state-branch janitor: scanned=5 deleted=2 kept=3 errors=0"));
});

test("janitor falls back to branch commit age when the run no longer exists", async () => {
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.includes("/git/matching-refs/")) return Response.json([branch("500")]);
    if (url.pathname.endsWith("/actions/runs/500")) return new Response(null, { status: 404 });
    if (url.pathname.includes("/git/commits/")) {
      return Response.json({ committer: { date: "2026-07-19T11:00:00.000Z" } });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runStateBranchJanitor({
    env: janitorEnv(),
    fetchImpl: mockFetch as typeof fetch,
    now,
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 1, kept: 0, errors: 0 });
});

test("repository size check logs GB and warns only above the configured threshold", async (t) => {
  const logged: string[] = [];
  const warned: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.join(" ")));
  t.mock.method(console, "warn", (...parts: unknown[]) => warned.push(parts.join(" ")));
  const mockFetch = async (): Promise<Response> => Response.json({ size: 6 * 1024 * 1024 });

  const result = await runStateRepoSizeCheck({
    env: {
      CLAWSWEEPER_STATE_REPO_TOKEN: stateToken,
      GITHUB_API_URL: "https://api.github.test",
      STATE_REPO_SIZE_WARN_GB: "5",
    },
    fetchImpl: mockFetch as typeof fetch,
  });

  assert.equal(result.errors, 0);
  assert.equal(result.size?.aboveThreshold, true);
  assert.ok(logged.includes("state-repo size: 6.00GB"));
  assert.ok(warned.includes("::warning::state-repo size: 6.00GB exceeds 5GB threshold"));
});

test("janitor and size check fail open when credentials are unavailable", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.join(" ")));
  t.mock.method(console, "warn", () => {});
  const janitor = await runStateBranchJanitor({ env: {} });
  const size = await runStateRepoSizeCheck({ env: {} });
  assert.deepEqual(janitor, { scanned: 0, deleted: 0, kept: 0, errors: 1 });
  assert.equal(size.errors, 1);
  assert.ok(logged.includes("state-branch janitor: scanned=0 deleted=0 kept=0 errors=1"));
  assert.ok(logged.includes("state-repo size: unavailable"));
});

test("janitor fails open when state reference discovery is unavailable", async () => {
  const summary = await runStateBranchJanitor({
    env: janitorEnv(),
    fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
    now,
  });
  assert.deepEqual(summary, { scanned: 0, deleted: 0, kept: 0, errors: 1 });
});
