import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isOrphanedReviewPlaceholder,
  REVIEW_PLACEHOLDER_MARKER,
  reviewPlaceholderCursorMode,
  reviewPlaceholderRecoveryFailureReason,
  runReviewPlaceholderRecovery,
  selectReviewPlaceholderComment,
} from "../dist/review-placeholder-recovery.js";

test("scheduled placeholder recovery also performs bounded recovery-label reconciliation", () => {
  const source = readFileSync("src/review-placeholder-recovery.ts", "utf8");
  const cli = source.slice(source.indexOf("if (invokedPath && invokedPath ==="));
  const runner = source.slice(source.indexOf("export async function runReviewPlaceholderRecovery"));

  assert.match(cli, /runReviewPlaceholderRecovery\(\{ reconcileRecoveryLabels: true \}\)/);
  assert.match(runner, /if \(options\.reconcileRecoveryLabels && targetWriteToken\)/);
  assert.match(runner, /runReviewRecoveryLabelBackfill\(\{/);
  assert.match(runner, /github,[\s\S]*fetchComments: fetchReviewComments/);
  assert.match(runner, /review-recovery label reconciliation skipped:/);
});

test("the scheduled reconciler reuses recovery transport to clear an exact-head completed PR", async () => {
  const head = "da73f50fbca83cc89f3e8f33f61e27963351403b";
  let deletions = 0;
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      return Response.json(
        query.includes("label:")
          ? { total_count: 1, items: [{ number: 112370, pull_request: {} }] }
          : { total_count: 0, items: [] },
      );
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/112370/comments") {
      return Response.json([
        {
          body: [
            "ClawSweeper review: keep open.",
            `<!-- clawsweeper-review-version item=112370 reviewed_at=2026-08-05T08:07:22.093Z sha=${head} v=1 -->`,
            "<!-- clawsweeper-review item=112370 -->",
          ].join("\n\n"),
          created_at: "2026-08-05T08:07:22.093Z",
          user: { login: "clawsweeper[bot]", type: "Bot" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/112370") {
      return Response.json({ head: { sha: head } });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues/112370/labels/clawsweeper-recovery-stuck"
    ) {
      assert.equal(init?.method, "DELETE");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer target-token");
      deletions += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "read-token",
      TARGET_WRITE_TOKEN: "target-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "webhook-secret",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: fetchImpl as typeof fetch,
    now: new Date("2026-08-05T12:00:00.000Z"),
    reconcileRecoveryLabels: true,
  });

  assert.equal(deletions, 1);
});

const now = new Date("2026-07-17T12:00:00.000Z");
const bot = { login: "clawsweeper[bot]", type: "Bot" };

test("review placeholder orphan detection requires the bot marker and minimum age", () => {
  const boundary = {
    body: `${REVIEW_PLACEHOLDER_MARKER}\n\nStill reviewing.`,
    created_at: "2026-07-17T10:00:00.000Z",
    user: bot,
  };
  assert.equal(isOrphanedReviewPlaceholder(boundary, now, 2), true);
  assert.equal(
    isOrphanedReviewPlaceholder({ ...boundary, created_at: "2026-07-17T10:00:00.001Z" }, now, 2),
    false,
  );
  assert.equal(
    isOrphanedReviewPlaceholder(
      {
        ...boundary,
        body: "ClawSweeper review: keep open.\n\n- Current implementation still needs proof.",
      },
      now,
      2,
    ),
    false,
  );
  assert.equal(
    isOrphanedReviewPlaceholder(
      { ...boundary, user: { login: "maintainer", type: "User" } },
      now,
      2,
    ),
    false,
  );
  assert.equal(
    isOrphanedReviewPlaceholder(
      { ...boundary, user: { login: "clawsweeper[bot]", type: "User" } },
      now,
      2,
    ),
    false,
  );
});

test("review placeholder selection matches the status marker, not the newest bot comment", () => {
  const placeholder = {
    id: 11,
    body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=42 sha=abc v=1 -->`,
    created_at: "2026-07-17T06:00:00.000Z",
    updated_at: "2026-07-17T06:00:00.000Z",
    user: bot,
  };
  const editedVerdict = {
    id: 12,
    body: "ClawSweeper review: keep open.\n\n<!-- clawsweeper-review item=42 v=1 -->",
    created_at: "2026-07-16T16:00:00.000Z",
    updated_at: "2026-07-17T11:50:00.000Z",
    user: bot,
  };
  const selected = selectReviewPlaceholderComment(42, [editedVerdict, placeholder]);
  assert.equal(selected?.id, 11);
  assert.equal(isOrphanedReviewPlaceholder(selected, now, 2), true);
  assert.equal(
    selectReviewPlaceholderComment(42, [
      editedVerdict,
      { ...placeholder, id: 13, body: REVIEW_PLACEHOLDER_MARKER },
    ])?.id,
    13,
  );
  assert.equal(selectReviewPlaceholderComment(42, [editedVerdict]), null);
  assert.equal(
    selectReviewPlaceholderComment(42, [
      { ...placeholder, id: 14, user: { login: "someone-else", type: "User" } },
    ]),
    null,
  );
});

test("review placeholder runner fails open and sends a signed exact-review decision", async (t) => {
  const enqueueBodies: string[] = [];
  const commentChecks: number[] = [];
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => {
    logged.push(parts.join(" "));
  });
  const { WEBHOOK: webhookSecret = "test-token-placeholder" } = {} as Record<string, string>;
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      assert.match(query, /repo:openclaw\/openclaw/);
      assert.match(query, /ClawSweeper status: review started\./);
      assert.match(query, /updated:>=2026-07-15T12:00:00\.000Z/);
      assert.match(query, /is:(open|closed)/);
      if (query.includes("is:closed")) return Response.json({ items: [] });
      return Response.json({
        items: [
          { number: 101 },
          { number: 102 },
          { number: 103, pull_request: { url: "https://api.github.test/pulls/103" } },
          { number: 104 },
        ],
      });
    }
    const commentMatch = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (commentMatch) {
      const number = Number(commentMatch[1]);
      commentChecks.push(number);
      assert.equal(url.searchParams.get("sort"), "created");
      assert.equal(url.searchParams.get("direction"), "desc");
      if (number === 101) return new Response("unavailable", { status: 503 });
      if (number === 102) {
        return Response.json([
          {
            body: "ClawSweeper review: keep open.",
            created_at: "2026-07-17T08:00:00.000Z",
            user: bot,
          },
        ]);
      }
      return Response.json([
        {
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      assert.equal(init?.method, "POST");
      const body = String(init?.body ?? "");
      const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
      assert.equal(
        new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
        signature,
      );
      enqueueBodies.push(body);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test/",
      TARGET_REPO: "openclaw/openclaw",
      TARGET_BRANCH: "main",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      REVIEW_PLACEHOLDER_MAX_CHECKS: "3",
      REVIEW_PLACEHOLDER_MAX_RECOVERIES: "5",
      REVIEW_PLACEHOLDER_MIN_AGE_HOURS: "2",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 3,
    orphaned: 1,
    enqueued: 1,
    cleaned: 0,
    escalated: 0,
    errors: 1,
    actionFailures: 0,
    matched: 4,
    remaining: 1,
  });
  assert.ok(logged.includes("review-placeholder recovery: enqueued #103 (pull_request)"));
  assert.deepEqual(commentChecks, [101, 102, 103]);
  assert.equal(enqueueBodies.length, 1);
  assert.deepEqual(JSON.parse(enqueueBodies[0] ?? ""), {
    delivery_id: "router:review-placeholder-recovery-12345-2-103",
    decision: {
      targetRepo: "openclaw/openclaw",
      targetBranch: "main",
      itemNumber: 103,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "review_placeholder_recovery",
      supersedesInProgress: false,
    },
  });
});

test("review placeholder runner fills the recovery cap with the oldest orphans first", async () => {
  const commentChecks: number[] = [];
  const enqueuedNumbers: number[] = [];
  const createdAtByNumber: Record<number, string> = {
    201: "2026-07-17T09:00:00.000Z",
    202: "2026-07-17T04:00:00.000Z",
  };
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      return Response.json({ items: [{ number: 201 }, { number: 202 }] });
    }
    const commentMatch = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (commentMatch) {
      const number = Number(commentMatch[1]);
      commentChecks.push(number);
      return Response.json([
        {
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: createdAtByNumber[number],
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { decision: { itemNumber: number } };
      enqueuedNumbers.push(body.decision.itemNumber);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      REVIEW_PLACEHOLDER_MAX_RECOVERIES: "1",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 2,
    orphaned: 2,
    enqueued: 1,
    cleaned: 0,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 4,
    remaining: 2,
  });
  assert.deepEqual(commentChecks, [201, 202]);
  assert.deepEqual(enqueuedNumbers, [202]);
});

test("review placeholder runner escalates orphans stuck well beyond the minimum age", async () => {
  const escalatedLabels: { number: number; body: unknown }[] = [];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      return Response.json({
        items: [{ number: 301 }, { number: 302, labels: [{ name: "clawsweeper-recovery-stuck" }] }],
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/301/comments") {
      return Response.json([
        {
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-16T00:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/302/comments") {
      return Response.json([
        {
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-16T00:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/301/labels") {
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-target-write-token");
      escalatedLabels.push({ number: 301, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json([], { status: 200 });
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      TARGET_WRITE_TOKEN: "test-target-write-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
      REVIEW_PLACEHOLDER_STUCK_HOURS: "12",
      REVIEW_PLACEHOLDER_MAX_RECOVERIES: "2",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 2,
    orphaned: 2,
    enqueued: 2,
    cleaned: 0,
    escalated: 1,
    errors: 0,
    actionFailures: 0,
    matched: 4,
    remaining: 2,
  });
  assert.deepEqual(escalatedLabels, [
    { number: 301, body: { labels: ["clawsweeper-recovery-stuck"] } },
  ]);
});

test("stuck escalation without a target write token is a visible error, not a wrong-identity write", async () => {
  let labelRequests = 0;
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      return Response.json({ items: [{ number: 311 }] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/311/comments") {
      return Response.json([
        {
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-16T00:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname.endsWith("/labels")) {
      labelRequests += 1;
      return Response.json([], { status: 200 });
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
      REVIEW_PLACEHOLDER_STUCK_HOURS: "12",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 1,
    cleaned: 0,
    escalated: 0,
    errors: 1,
    actionFailures: 0,
    matched: 2,
    remaining: 1,
  });
  assert.equal(labelRequests, 0);
});

test("orphaned placeholders on closed items are deleted instead of re-enqueued", async () => {
  const deletedComments: string[] = [];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) {
        return Response.json({
          items: [{ number: 401, pull_request: { url: "https://api.github.test/pulls/401" } }],
        });
      }
      return Response.json({ items: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/401/comments") {
      return Response.json([
        {
          id: 9001,
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/401") {
      return Response.json({ state: "closed" });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/comments/9001") {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          id: 9001,
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=401 sha=abc lease_expires_at=2026-07-17T09:00:00.000Z owner=github-run-1-1 v=1 -->`,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        });
      }
      assert.equal(init?.method, "DELETE");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-target-write-token");
      deletedComments.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      TARGET_WRITE_TOKEN: "test-target-write-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 0,
    cleaned: 1,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 1,
    remaining: 0,
  });
  assert.deepEqual(deletedComments, ["/repos/openclaw/openclaw/issues/comments/9001"]);
});

test("closed-item cleanup without a target write token is a visible error", async () => {
  let deleteRequests = 0;
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ items: [{ number: 402 }] });
      return Response.json({ items: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/402/comments") {
      return Response.json([
        {
          id: 9002,
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname.startsWith("/repos/openclaw/openclaw/issues/comments/")) {
      deleteRequests += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 0,
    cleaned: 0,
    escalated: 0,
    errors: 1,
    actionFailures: 1,
    matched: 1,
    remaining: 0,
  });
  assert.equal(deleteRequests, 0);
  assert.equal(
    reviewPlaceholderRecoveryFailureReason(summary),
    "orphaned placeholders remain and every recovery action failed",
  );
});

test("discovery errors do not fail a closed orphan that changed during revalidation", async () => {
  let deleteRequests = 0;
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ items: [{ number: 403 }] });
      return new Response("unavailable", { status: 503 });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/403/comments") {
      return Response.json([
        {
          id: 9003,
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/403") {
      return Response.json({ state: "closed" });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/comments/9003") {
      if ((init?.method ?? "GET") === "GET") {
        // An in-flight publish replaced the placeholder body with the review.
        return Response.json({
          id: 9003,
          body: "ClawSweeper review: keep open.",
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        });
      }
      deleteRequests += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      TARGET_WRITE_TOKEN: "test-target-write-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 0,
    cleaned: 0,
    escalated: 0,
    errors: 1,
    actionFailures: 0,
    matched: 1,
    remaining: 0,
  });
  assert.equal(deleteRequests, 0);
  assert.equal(reviewPlaceholderRecoveryFailureReason(summary), null);
});

test("locked closed items are terminal skips, not retrying cleanup errors", async () => {
  let deleteRequests = 0;
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ items: [{ number: 405 }] });
      return Response.json({ items: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/405/comments") {
      return Response.json([
        {
          id: 9005,
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/405") {
      return Response.json({ state: "closed", locked: true });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/comments/9005") {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          id: 9005,
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=405 sha=abc v=1 -->`,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        });
      }
      deleteRequests += 1;
      return new Response("locked", { status: 403 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      TARGET_WRITE_TOKEN: "test-target-write-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 0,
    cleaned: 0,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 1,
    remaining: 0,
  });
  assert.equal(deleteRequests, 1);
});

test("closed cleanup keeps its own check budget when open placeholders fill the cap", async () => {
  const deletedComments: string[] = [];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ items: [{ number: 502 }] });
      return Response.json({ items: [{ number: 501 }] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/501/comments") {
      return Response.json([
        {
          body: "ClawSweeper review: keep open.",
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/502/comments") {
      return Response.json([
        {
          id: 9502,
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/502") {
      return Response.json({ state: "closed" });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/comments/9502") {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          id: 9502,
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=502 sha=abc v=1 -->`,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        });
      }
      deletedComments.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      TARGET_WRITE_TOKEN: "test-target-write-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
      REVIEW_PLACEHOLDER_MAX_CHECKS: "1",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 2,
    orphaned: 1,
    enqueued: 0,
    cleaned: 1,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 2,
    remaining: 0,
  });
  assert.deepEqual(deletedComments, ["/repos/openclaw/openclaw/issues/comments/9502"]);
});

test("recovery failure reason fires only when every live-verified action fails", () => {
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({
      checked: 5,
      orphaned: 2,
      enqueued: 0,
      cleaned: 0,
      escalated: 0,
      errors: 2,
      actionFailures: 2,
      matched: 5,
      remaining: 0,
    }),
    "orphaned placeholders remain and every recovery action failed",
  );
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({
      checked: 5,
      orphaned: 2,
      enqueued: 1,
      cleaned: 0,
      escalated: 0,
      errors: 1,
      actionFailures: 1,
      matched: 5,
      remaining: 0,
    }),
    null,
  );
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({
      checked: 5,
      orphaned: 0,
      enqueued: 0,
      cleaned: 0,
      escalated: 0,
      errors: 1,
      actionFailures: 0,
      matched: 5,
      remaining: 0,
    }),
    null,
  );
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({
      checked: 5,
      orphaned: 2,
      enqueued: 0,
      cleaned: 0,
      escalated: 1,
      errors: 2,
      actionFailures: 0,
      matched: 5,
      remaining: 0,
    }),
    null,
  );
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({
      checked: 40,
      orphaned: 1,
      enqueued: 1,
      cleaned: 0,
      escalated: 0,
      errors: 0,
      actionFailures: 0,
      matched: 1_240,
      remaining: 1_200,
    }),
    null,
  );
});

test("discovery ranks the whole search page before it applies the check budget", async () => {
  const commentChecks: number[] = [];
  const searchOrders: string[] = [];
  const enqueuedNumbers: number[] = [];
  const createdAtByNumber: Record<number, string> = {
    603: "2026-07-16T02:00:00.000Z",
    604: "2026-07-15T22:00:00.000Z",
  };
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      searchOrders.push(url.searchParams.get("order") ?? "");
      assert.match(query, /updated:>=2026-07-14T12:00:00\.000Z/);
      if (query.includes("is:closed")) return Response.json({ total_count: 0, items: [] });
      return Response.json({
        total_count: 4,
        items: [
          { number: 601, updated_at: "2026-07-17T11:40:00.000Z" },
          { number: 602, updated_at: "2026-07-17T11:20:00.000Z" },
          { number: 603, updated_at: "2026-07-16T02:00:00.000Z" },
          { number: 604, updated_at: "2026-07-15T22:00:00.000Z" },
        ],
      });
    }
    const commentMatch = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (commentMatch) {
      const number = Number(commentMatch[1]);
      commentChecks.push(number);
      const createdAt = createdAtByNumber[number];
      assert.ok(createdAt, `unexpected comment fetch for #${number}`);
      return Response.json([
        {
          id: 7000 + number,
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=${number} sha=abc v=1 -->`,
          created_at: createdAt,
          updated_at: createdAt,
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { decision: { itemNumber: number } };
      enqueuedNumbers.push(body.decision.itemNumber);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
      REVIEW_PLACEHOLDER_MAX_CHECKS: "2",
      REVIEW_PLACEHOLDER_LOOKBACK_HOURS: "72",
      REVIEW_PLACEHOLDER_STUCK_HOURS: "720",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 2,
    orphaned: 2,
    enqueued: 2,
    cleaned: 0,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 4,
    remaining: 2,
  });
  assert.deepEqual(searchOrders, ["asc", "asc"]);
  assert.deepEqual(commentChecks, [604, 603]);
  assert.deepEqual(enqueuedNumbers, [604, 603]);
});

test("an edited durable verdict no longer masks the marker-tagged placeholder", async () => {
  const enqueuedNumbers: number[] = [];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ total_count: 0, items: [] });
      return Response.json({
        total_count: 1,
        items: [{ number: 611, updated_at: "2026-07-17T11:50:00.000Z" }],
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/611/comments") {
      return Response.json([
        {
          id: 6111,
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=611 sha=abc v=1 -->`,
          created_at: "2026-07-17T06:00:00.000Z",
          updated_at: "2026-07-17T06:00:00.000Z",
          user: bot,
        },
        {
          id: 6112,
          body: "ClawSweeper review: keep open.\n\n<!-- clawsweeper-review item=611 v=1 -->",
          created_at: "2026-07-16T16:00:00.000Z",
          updated_at: "2026-07-17T11:50:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { decision: { itemNumber: number } };
      enqueuedNumbers.push(body.decision.itemNumber);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 1,
    cleaned: 0,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 1,
    remaining: 0,
  });
  assert.deepEqual(enqueuedNumbers, [611]);
});

test("a large search count remains telemetry and does not fail the run", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => {
    logged.push(parts.join(" "));
  });
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ total_count: 0, items: [] });
      return Response.json({
        total_count: 900,
        items: [{ number: 621, updated_at: "2026-07-17T05:00:00.000Z" }],
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/621/comments") {
      return Response.json([
        {
          id: 6211,
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=621 sha=abc v=1 -->`,
          created_at: "2026-07-17T05:00:00.000Z",
          updated_at: "2026-07-17T05:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const summary = await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "test-token-placeholder",
      CLAWSWEEPER_WEBHOOK_SECRET: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
      REVIEW_PLACEHOLDER_MAX_CHECKS: "1",
    },
    fetchImpl: mockFetch as typeof fetch,
    now,
  });

  assert.deepEqual(summary, {
    checked: 1,
    orphaned: 1,
    enqueued: 1,
    cleaned: 0,
    escalated: 0,
    errors: 0,
    actionFailures: 0,
    matched: 900,
    remaining: 899,
  });
  assert.ok(
    logged.some((line) => line.includes("matched=900 remaining=899")),
    "summary line reports the discovery backlog",
  );
  assert.equal(reviewPlaceholderRecoveryFailureReason(summary), null);
});

test("durable discovery rotation reaches later open and closed candidates without bypassing age", async () => {
  const openNumbers = Array.from({ length: 180 }, (_, index) => 1_001 + index);
  const closedNumbers = Array.from({ length: 180 }, (_, index) => 2_001 + index);
  const cursorModes = {
    open: reviewPlaceholderCursorMode("openclaw/openclaw", "open"),
    closed: reviewPlaceholderCursorMode("openclaw/openclaw", "closed"),
  };
  const stored = new Map(
    Object.values(cursorModes).map((mode) => [
      mode,
      { next_cursor: 0, revision: 0, updated_at: null as string | null },
    ]),
  );
  const checks = Array.from({ length: 4 }, () => ({
    open: [] as number[],
    closed: [] as number[],
  }));
  const enqueued: number[] = [];
  const deleted: number[] = [];
  let runIndex = 0;
  let runNow = now;
  let closedTargetDeleted = false;

  const candidate = (number: number, index: number) => ({
    number,
    updated_at: new Date(Date.parse("2026-07-15T12:00:00.000Z") + index * 1_000).toISOString(),
  });
  const placeholder = (number: number, commentId: number, createdAt: string) => ({
    id: commentId,
    body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=${number} sha=abc v=1 -->`,
    created_at: createdAt,
    updated_at: createdAt,
    user: bot,
  });
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const cursorMatch = url.pathname.match(/\/internal\/state\/cursors\/([^/]+)$/);
    if (cursorMatch) {
      const mode = decodeURIComponent(cursorMatch[1]!);
      const cursor = stored.get(mode);
      assert.ok(cursor, `unexpected cursor mode ${mode}`);
      if (init?.method === "PUT") {
        const update = JSON.parse(String(init.body)) as {
          next_cursor: number;
          expected_revision: number;
        };
        assert.equal(update.expected_revision, cursor.revision);
        cursor.next_cursor = update.next_cursor;
        cursor.revision += 1;
        cursor.updated_at = runNow.toISOString();
      }
      return Response.json({ ok: true, mode, ...cursor });
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      const state = query.includes("is:closed") ? "closed" : "open";
      const numbers = state === "closed" ? closedNumbers : openNumbers;
      const page = Number(url.searchParams.get("page"));
      const pageStart = (page - 1) * 100;
      return Response.json({
        // Search count is intentionally stale for closed items; page contents
        // remain the only completion authority for cursor advancement.
        total_count: state === "closed" ? 1 : numbers.length,
        incomplete_results: false,
        items: numbers.slice(pageStart, pageStart + 100).map(candidate),
      });
    }
    const commentsMatch = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (commentsMatch) {
      const number = Number(commentsMatch[1]);
      const state = number >= 2_000 ? "closed" : "open";
      checks[runIndex]![state].push(number);
      if (number === 1_001) {
        return Response.json([placeholder(number, 91_001, "2026-07-17T11:00:00.000Z")]);
      }
      if (number === 2_144 && !closedTargetDeleted) {
        return Response.json([placeholder(number, 92_144, "2026-07-17T06:00:00.000Z")]);
      }
      return Response.json([
        {
          body: "ClawSweeper review: keep open.",
          created_at: "2026-07-17T06:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/2144") {
      return Response.json({ state: "closed", locked: false });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues/comments/92144" &&
      init?.method === "DELETE"
    ) {
      deleted.push(92_144);
      closedTargetDeleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/comments/92144") {
      return Response.json(placeholder(2_144, 92_144, "2026-07-17T06:00:00.000Z"));
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      const body = JSON.parse(String(init?.body)) as { decision: { itemNumber: number } };
      enqueued.push(body.decision.itemNumber);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  const run = async (index: number, at: Date) => {
    runIndex = index;
    runNow = at;
    return runReviewPlaceholderRecovery({
      env: {
        GH_TOKEN: "read-token",
        TARGET_WRITE_TOKEN: "write-token",
        CLAWSWEEPER_WEBHOOK_SECRET: "cursor-secret",
        GITHUB_API_URL: "https://api.github.test",
        QUEUE_URL: "https://queue.test",
        REVIEW_PLACEHOLDER_CURSOR_STORE_URL: "https://queue.test",
        REVIEW_PLACEHOLDER_MAX_CHECKS: "60",
        REVIEW_PLACEHOLDER_MAX_RECOVERIES: "5",
        REVIEW_PLACEHOLDER_MIN_AGE_HOURS: "2",
        TARGET_REPO: "openclaw/openclaw",
        GITHUB_RUN_ID: String(10_000 + index),
      },
      fetchImpl: mockFetch as typeof fetch,
      now: at,
    });
  };

  const first = await run(0, now);
  const second = await run(1, now);
  const third = await run(2, now);
  const fourth = await run(3, new Date("2026-07-17T14:00:00.000Z"));

  assert.equal(first.cleaned, 0);
  assert.equal(second.cleaned, 0);
  assert.equal(third.cleaned, 1, "the rank-144 closed placeholder is reached on cycle three");
  assert.equal(fourth.enqueued, 1, "the under-age open placeholder is retried after wrap");
  assert.deepEqual(enqueued, [1_001]);
  assert.deepEqual(deleted, [92_144]);
  for (const [index, expected] of [
    [0, [0, 60]],
    [1, [60, 120]],
    [2, [120, 180]],
    [3, [0, 60]],
  ] as const) {
    assert.deepEqual(checks[index]!.open, openNumbers.slice(...expected));
    assert.deepEqual(checks[index]!.closed, closedNumbers.slice(...expected));
  }
  assert.equal(stored.get(cursorModes.open)?.next_cursor, 60);
  assert.equal(stored.get(cursorModes.closed)?.next_cursor, 60);
});

test("a stale discovery cursor resets inside the current result set", async () => {
  const mode = reviewPlaceholderCursorMode("openclaw/openclaw", "open");
  const closedMode = reviewPlaceholderCursorMode("openclaw/openclaw", "closed");
  let stored = { next_cursor: 900, revision: 7, updated_at: now.toISOString() };
  const checked: number[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith(`/${mode}`)) {
      if (init?.method === "PUT") {
        const update = JSON.parse(String(init.body)) as {
          next_cursor: number;
          expected_revision: number;
        };
        assert.equal(update.expected_revision, 7);
        stored = { next_cursor: update.next_cursor, revision: 8, updated_at: now.toISOString() };
      }
      return Response.json({ ok: true, mode, ...stored });
    }
    if (url.pathname.endsWith(`/${closedMode}`)) {
      return Response.json({
        ok: true,
        mode: closedMode,
        next_cursor: 0,
        revision: 0,
        updated_at: null,
      });
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ total_count: 0, items: [] });
      if (url.searchParams.get("page") !== "1") {
        return Response.json({ total_count: 1, items: [] });
      }
      return Response.json({ total_count: 1, items: [{ number: 7_001 }] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/7001/comments") {
      checked.push(7_001);
      return Response.json([]);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  await runReviewPlaceholderRecovery({
    env: {
      GH_TOKEN: "read-token",
      CLAWSWEEPER_WEBHOOK_SECRET: "cursor-secret",
      GITHUB_API_URL: "https://api.github.test",
      QUEUE_URL: "https://queue.test",
      REVIEW_PLACEHOLDER_CURSOR_STORE_URL: "https://queue.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: fetchImpl as typeof fetch,
    now,
  });

  assert.deepEqual(checked, [7_001]);
  assert.equal(stored.next_cursor, 0);
});

test("cursor conflict repeats productive recovery safely after restart", async () => {
  const modes = {
    open: reviewPlaceholderCursorMode("openclaw/openclaw", "open"),
    closed: reviewPlaceholderCursorMode("openclaw/openclaw", "closed"),
  };
  const checked: number[] = [];
  const enqueued: number[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const cursorMode = Object.values(modes).find((mode) => url.pathname.endsWith(`/${mode}`));
    if (cursorMode) {
      if (init?.method === "PUT") {
        return Response.json({ error: "fanout_cursor_revision_conflict" }, { status: 409 });
      }
      return Response.json({
        ok: true,
        mode: cursorMode,
        next_cursor: 0,
        revision: 0,
        updated_at: null,
      });
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ total_count: 0, items: [] });
      return Response.json({ total_count: 2, items: [{ number: 8_001 }, { number: 8_002 }] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues/8001/comments") {
      checked.push(8_001);
      return Response.json([
        {
          body: `${REVIEW_PLACEHOLDER_MARKER}\n\n<!-- clawsweeper-review-status:started item=8001 sha=abc v=1 -->`,
          created_at: "2026-07-17T06:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      enqueued.push(8_001);
      return Response.json(
        enqueued.length === 1 ? { ok: true, queued: true } : { ok: true, deduped: true },
        { status: 202 },
      );
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };
  const run = (runId: string) =>
    runReviewPlaceholderRecovery({
      env: {
        GH_TOKEN: "read-token",
        CLAWSWEEPER_WEBHOOK_SECRET: "cursor-secret",
        GITHUB_API_URL: "https://api.github.test",
        QUEUE_URL: "https://queue.test",
        REVIEW_PLACEHOLDER_CURSOR_STORE_URL: "https://queue.test",
        REVIEW_PLACEHOLDER_MAX_CHECKS: "1",
        TARGET_REPO: "openclaw/openclaw",
        GITHUB_RUN_ID: runId,
      },
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

  assert.equal((await run("restart-1")).enqueued, 1);
  assert.equal((await run("restart-2")).enqueued, 1);
  assert.deepEqual(checked, [8_001, 8_001]);
  assert.deepEqual(enqueued, [8_001, 8_001]);
});

test("placeholder refreshed recently by an active recovery is not orphaned", () => {
  const now = new Date("2026-07-17T22:20:00Z");
  assert.equal(
    isOrphanedReviewPlaceholder(
      {
        body: "ClawSweeper status: review started.",
        created_at: "2026-07-17T02:01:47Z",
        updated_at: "2026-07-17T22:12:44Z",
        user: { login: "clawsweeper[bot]", type: "Bot" },
      },
      now,
    ),
    false,
  );
  assert.equal(
    isOrphanedReviewPlaceholder(
      {
        body: "ClawSweeper status: review started.",
        created_at: "2026-07-17T02:01:47Z",
        updated_at: "2026-07-17T02:01:47Z",
        user: { login: "clawsweeper[bot]", type: "Bot" },
      },
      now,
    ),
    true,
  );
});
