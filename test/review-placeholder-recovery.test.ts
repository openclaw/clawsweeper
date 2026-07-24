import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  isOrphanedReviewPlaceholder,
  REVIEW_PLACEHOLDER_MARKER,
  reviewPlaceholderRecoveryFailureReason,
  runReviewPlaceholderRecovery,
  selectReviewPlaceholderComment,
} from "../dist/review-placeholder-recovery.js";

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
    matched: 1,
    remaining: 0,
  });
  assert.equal(deleteRequests, 0);
});

test("closed-item cleanup revalidates and skips a placeholder that became a real review", async () => {
  let deleteRequests = 0;
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:closed")) return Response.json({ items: [{ number: 403 }] });
      return Response.json({ items: [] });
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
    errors: 0,
    matched: 1,
    remaining: 0,
  });
  assert.equal(deleteRequests, 0);
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
    matched: 2,
    remaining: 0,
  });
  assert.deepEqual(deletedComments, ["/repos/openclaw/openclaw/issues/comments/9502"]);
});

test("recovery failure reason fires on total action failure and on an undrainable backlog", () => {
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({
      checked: 5,
      orphaned: 2,
      enqueued: 0,
      cleaned: 0,
      escalated: 0,
      errors: 2,
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
      matched: 5,
      remaining: 0,
    }),
    "orphaned placeholders remain and every recovery action failed",
  );
  const backlogged = {
    checked: 40,
    orphaned: 1,
    enqueued: 1,
    cleaned: 0,
    escalated: 0,
    errors: 0,
    matched: 1_240,
    remaining: 1_200,
  };
  assert.equal(
    reviewPlaceholderRecoveryFailureReason(backlogged),
    "1200 matching placeholders were left unexamined (backlog alert threshold 480)",
  );
  assert.equal(reviewPlaceholderRecoveryFailureReason(backlogged, 1_201), null);
  assert.equal(
    reviewPlaceholderRecoveryFailureReason({ ...backlogged, matched: 60, remaining: 20 }),
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
    matched: 1,
    remaining: 0,
  });
  assert.deepEqual(enqueuedNumbers, [611]);
});

test("a backlog the sweep cannot examine is reported and fails the run", async (t) => {
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
    matched: 900,
    remaining: 899,
  });
  assert.ok(
    logged.some((line) => line.includes("matched=900 remaining=899")),
    "summary line reports the discovery backlog",
  );
  assert.equal(
    reviewPlaceholderRecoveryFailureReason(summary),
    "899 matching placeholders were left unexamined (backlog alert threshold 480)",
  );
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
