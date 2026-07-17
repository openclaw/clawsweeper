import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  isOrphanedReviewPlaceholder,
  latestClawSweeperBotComment,
  REVIEW_PLACEHOLDER_MARKER,
  runReviewPlaceholderRecovery,
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

test("review placeholder detection considers only the latest ClawSweeper bot comment", () => {
  const latest = latestClawSweeperBotComment([
    {
      body: REVIEW_PLACEHOLDER_MARKER,
      created_at: "2026-07-17T08:00:00.000Z",
      user: bot,
    },
    {
      body: "ClawSweeper review: keep open.",
      created_at: "2026-07-17T09:00:00.000Z",
      user: bot,
    },
    {
      body: REVIEW_PLACEHOLDER_MARKER,
      created_at: "2026-07-17T11:00:00.000Z",
      user: { login: "someone-else", type: "User" },
    },
  ]);
  assert.equal(latest?.body, "ClawSweeper review: keep open.");
  assert.equal(isOrphanedReviewPlaceholder(latest, now, 2), false);
});

test("review placeholder runner fails open and sends a signed exact-review decision", async () => {
  const enqueueBodies: string[] = [];
  const commentChecks: number[] = [];
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
      assert.match(query, /is:open/);
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
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
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

  assert.deepEqual(summary, { checked: 3, orphaned: 1, enqueued: 1, errors: 1 });
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

test("review placeholder runner stops at the recovery cap", async () => {
  const commentChecks: number[] = [];
  let enqueueCalls = 0;
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/search/issues") {
      return Response.json({ items: [{ number: 201 }, { number: 202 }] });
    }
    const commentMatch = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (commentMatch) {
      commentChecks.push(Number(commentMatch[1]));
      return Response.json([
        {
          body: REVIEW_PLACEHOLDER_MARKER,
          created_at: "2026-07-17T08:00:00.000Z",
          user: bot,
        },
      ]);
    }
    if (url.pathname === "/internal/exact-review/enqueue") {
      enqueueCalls += 1;
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

  assert.deepEqual(summary, { checked: 1, orphaned: 1, enqueued: 1, errors: 0 });
  assert.deepEqual(commentChecks, [201]);
  assert.equal(enqueueCalls, 1);
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
