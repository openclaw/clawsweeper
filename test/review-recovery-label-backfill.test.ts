import assert from "node:assert/strict";
import test from "node:test";

import {
  clearResolvedReviewRecoveryLabel,
  REVIEW_RECOVERY_STUCK_LABEL,
  runReviewRecoveryLabelBackfill,
} from "../dist/review-recovery-label-backfill.js";

const now = new Date("2026-08-05T12:00:00.000Z");
const trustedBot = { login: "clawsweeper[bot]", type: "Bot" };
const env = {
  GH_TOKEN: "read-token",
  TARGET_WRITE_TOKEN: "target-write-token",
  TARGET_REPO: "openclaw/openclaw",
  GITHUB_API_URL: "https://api.github.test",
};

type TestComment = {
  body: string;
  created_at?: string;
  updated_at?: string;
  user: { login: string; type: string };
};

function completedReview(
  number: number,
  options: {
    at?: string;
    reviewedAt?: string;
    sha?: string;
    user?: { login: string; type: string };
    body?: string;
  } = {},
): TestComment {
  const at = options.at ?? "2026-08-05T10:00:00.000Z";
  const version = options.reviewedAt
    ? `\n\n<!-- clawsweeper-review-version item=${number} reviewed_at=${options.reviewedAt}${options.sha ? ` sha=${options.sha}` : ""} v=1 -->`
    : "";
  return {
    body:
      options.body ??
      `ClawSweeper review: keep open.${version}\n\n<!-- clawsweeper-review item=${number} -->`,
    created_at: at,
    updated_at: at,
    user: options.user ?? trustedBot,
  };
}

function startedPlaceholder(number: number, at: string): TestComment {
  return {
    body: `ClawSweeper status: review started.\n\n<!-- clawsweeper-review-status:started item=${number} sha=abc v=1 -->\n\n<!-- clawsweeper-review item=${number} -->`,
    created_at: at,
    updated_at: at,
    user: trustedBot,
  };
}

function githubFixture(options: {
  numbers: number[];
  comments: Map<number, TestComment[]>;
  pullHeads?: Map<number, string | undefined>;
  searchPages?: Map<number, number[]>;
  deleteStatus?: number;
  totalCount?: number;
}) {
  const deletions: number[] = [];
  const commentPages: { number: number; page: number }[] = [];
  const searchPages: number[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);

    if (url.pathname === "/search/issues") {
      assert.equal(headers.get("authorization"), "Bearer read-token");
      assert.equal(
        url.searchParams.get("q"),
        `repo:openclaw/openclaw is:open label:"${REVIEW_RECOVERY_STUCK_LABEL}"`,
      );
      const page = Number(url.searchParams.get("page"));
      searchPages.push(page);
      const numbers = options.searchPages?.get(page) ?? options.numbers;
      return Response.json({
        items: numbers.map((number) => ({
          number,
          ...(options.pullHeads?.has(number) ? { pull_request: { url: "pull-request" } } : {}),
        })),
        total_count: options.totalCount ?? options.numbers.length,
      });
    }

    const pullMatch = url.pathname.match(/^\/repos\/openclaw\/openclaw\/pulls\/(\d+)$/);
    if (pullMatch?.[1]) {
      assert.equal(headers.get("authorization"), "Bearer read-token");
      const sha = options.pullHeads?.get(Number(pullMatch[1]));
      return Response.json({ head: sha ? { sha } : {} });
    }

    const commentMatch = url.pathname.match(
      /^\/repos\/openclaw\/openclaw\/issues\/(\d+)\/comments$/,
    );
    if (commentMatch?.[1]) {
      assert.equal(headers.get("authorization"), "Bearer read-token");
      const number = Number(commentMatch[1]);
      const page = Number(url.searchParams.get("page"));
      const pageSize = Number(url.searchParams.get("per_page"));
      commentPages.push({ number, page });
      const comments = options.comments.get(number) ?? [];
      return Response.json(comments.slice((page - 1) * pageSize, page * pageSize));
    }

    const labelMatch = url.pathname.match(
      /^\/repos\/openclaw\/openclaw\/issues\/(\d+)\/labels\/clawsweeper-recovery-stuck$/,
    );
    if (labelMatch?.[1]) {
      assert.equal(init?.method, "DELETE");
      assert.equal(headers.get("authorization"), "Bearer target-write-token");
      deletions.push(Number(labelMatch[1]));
      return new Response(null, { status: options.deleteStatus ?? 204 });
    }

    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  return { fetchImpl: fetchImpl as typeof fetch, deletions, commentPages, searchPages };
}

test("completed publication clears its recovery label and preserves other labels", () => {
  const labels = ["priority: high", REVIEW_RECOVERY_STUCK_LABEL, "maturity: ready"];
  const calls: { number: number; label: string; onMutation?: () => void }[] = [];
  const onMutation = () => {};

  assert.equal(
    clearResolvedReviewRecoveryLabel({
      number: 112370,
      labels,
      complete: true,
      removeLabel: (number, label, callback) => {
        calls.push({ number, label, ...(callback ? { onMutation: callback } : {}) });
      },
      onMutation,
    }),
    true,
  );
  assert.deepEqual(labels, ["priority: high", "maturity: ready"]);
  assert.deepEqual(calls, [{ number: 112370, label: REVIEW_RECOVERY_STUCK_LABEL, onMutation }]);
});

test("incomplete publication and an absent recovery label never mutate", () => {
  for (const options of [
    { complete: false, labels: [REVIEW_RECOVERY_STUCK_LABEL] },
    { complete: true, labels: ["priority: high"] },
  ]) {
    assert.equal(
      clearResolvedReviewRecoveryLabel({
        number: 112370,
        ...options,
        removeLabel: () => assert.fail("unexpected label mutation"),
      }),
      false,
    );
  }
});

test("failed recovery-label removal preserves local labels and propagates its error", () => {
  const labels = [REVIEW_RECOVERY_STUCK_LABEL];
  assert.throws(
    () =>
      clearResolvedReviewRecoveryLabel({
        number: 112370,
        labels,
        complete: true,
        removeLabel: () => {
          throw new Error("GitHub refused the label mutation");
        },
      }),
    /GitHub refused the label mutation/,
  );
  assert.deepEqual(labels, [REVIEW_RECOVERY_STUCK_LABEL]);
});

test("recovery-label backfill clears only trusted, canonical completed reviews", async () => {
  const numbers = [101, 102, 103, 104, 105, 106, 107];
  const fixture = githubFixture({
    numbers,
    comments: new Map([
      [101, [completedReview(101)]],
      [102, [completedReview(102, { user: { login: "clawsweeper[bot]", type: "User" } })]],
      [103, [completedReview(103, { user: { login: "untrusted[bot]", type: "Bot" } })]],
      [104, [completedReview(999)]],
      [105, [startedPlaceholder(105, "2026-08-05T08:00:00.000Z")]],
      [
        106,
        [
          completedReview(106, {
            body: "ClawSweeper review: stale.\n\n<!-- clawsweeper-review-status:stale item=106 v=1 -->\n\n<!-- clawsweeper-review item=106 -->",
          }),
        ],
      ],
      [
        107,
        [
          completedReview(107, {
            user: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
          }),
        ],
      ],
    ]),
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.deletions, [101, 107]);
  assert.deepEqual(summary, {
    checked: 7,
    cleared: 2,
    alreadyCleared: 0,
    retained: 5,
    errors: 0,
    matched: 7,
    remaining: 0,
  });
});

test("a newer started lease overrides old review publication and unrelated comment edits", async () => {
  const missingPlaceholderTimestamp = startedPlaceholder(203, "2026-08-05T09:00:00.000Z");
  delete missingPlaceholderTimestamp.created_at;
  delete missingPlaceholderTimestamp.updated_at;
  const fixture = githubFixture({
    numbers: [201, 202, 203],
    comments: new Map([
      [
        201,
        [
          completedReview(201, {
            at: "2026-08-05T11:30:00.000Z",
            reviewedAt: "2026-08-05T08:00:00.000Z",
          }),
          startedPlaceholder(201, "2026-08-05T10:00:00.000Z"),
        ],
      ],
      [
        202,
        [
          startedPlaceholder(202, "2026-08-05T09:00:00.000Z"),
          completedReview(202, {
            at: "2026-08-05T11:00:00.000Z",
            reviewedAt: "2026-08-05T10:00:00.000Z",
          }),
        ],
      ],
      [203, [completedReview(203), missingPlaceholderTimestamp]],
    ]),
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.deletions, [202]);
  assert.equal(summary.cleared, 1);
  assert.equal(summary.retained, 2);
  assert.equal(summary.errors, 0);
});

test("pull-request cleanup requires a completed durable review of its exact live head", async () => {
  const currentHead = "a".repeat(40);
  const oldHead = "b".repeat(40);
  const fixture = githubFixture({
    numbers: [211, 212, 213, 214],
    pullHeads: new Map([
      [211, currentHead],
      [212, currentHead],
      [213, currentHead],
      [214, undefined],
    ]),
    comments: new Map([
      [
        211,
        [
          completedReview(211, {
            reviewedAt: "2026-08-05T10:00:00.000Z",
            sha: currentHead.toUpperCase(),
          }),
        ],
      ],
      [
        212,
        [
          completedReview(212, {
            reviewedAt: "2026-08-05T10:00:00.000Z",
            sha: oldHead,
          }),
        ],
      ],
      [213, [completedReview(213)]],
      [
        214,
        [
          completedReview(214, {
            reviewedAt: "2026-08-05T10:00:00.000Z",
            sha: currentHead,
          }),
        ],
      ],
    ]),
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.deletions, [211]);
  assert.equal(summary.checked, 4);
  assert.equal(summary.cleared, 1);
  assert.equal(summary.retained, 3);
  assert.equal(summary.errors, 0);
});

test("backfill treats a missing label as an idempotent result without claiming removal", async () => {
  const fixture = githubFixture({
    numbers: [301],
    comments: new Map([[301, [completedReview(301)]]]),
    deleteStatus: 404,
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.deletions, [301]);
  assert.equal(summary.alreadyCleared, 1);
  assert.equal(summary.cleared, 0);
  assert.equal(summary.errors, 0);
});

test("backfill reports forbidden label removal without claiming cleanup", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = githubFixture({
    numbers: [302],
    comments: new Map([[302, [completedReview(302)]]]),
    deleteStatus: 403,
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.deletions, [302]);
  assert.equal(summary.cleared, 0);
  assert.equal(summary.alreadyCleared, 0);
  assert.equal(summary.errors, 1);
  assert.match(warnings[0] ?? "", /returned 403/);
});

test("backfill enforces the existing recovery limits and reports its remaining backlog", async () => {
  const numbers = Array.from({ length: 8 }, (_, index) => 400 + index);
  const fixture = githubFixture({
    numbers,
    comments: new Map(numbers.map((number) => [number, [completedReview(number)]])),
    totalCount: 753,
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env: {
      ...env,
      REVIEW_PLACEHOLDER_MAX_CHECKS: "4",
      REVIEW_PLACEHOLDER_MAX_RECOVERIES: "2",
    },
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.deletions, [400, 401]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.cleared, 2);
  assert.equal(summary.matched, 753);
  assert.equal(summary.remaining, 751);
});

test("backfill rotates beyond genuinely stuck oldest items without a persisted cursor", async () => {
  const rotationMs = 15 * 60 * 1_000;
  const currentSlot = Math.floor(now.getTime() / rotationMs);
  const secondPageSlot = currentSlot + ((1 - (currentSlot % 3) + 3) % 3);
  const rotatedNow = new Date(secondPageSlot * rotationMs);
  const genuinelyStuck = Array.from({ length: 20 }, (_, index) => 600 + index);
  const resolved = 620;
  const fixture = githubFixture({
    numbers: genuinelyStuck,
    totalCount: 60,
    searchPages: new Map([
      [1, genuinelyStuck],
      [2, [resolved]],
    ]),
    comments: new Map([
      ...genuinelyStuck.map(
        (number) =>
          [number, [startedPlaceholder(number, "2026-08-05T08:00:00.000Z")]] as [
            number,
            TestComment[],
          ],
      ),
      [resolved, [completedReview(resolved)]],
    ]),
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now: rotatedNow,
  });

  assert.deepEqual(fixture.searchPages, [1, 2]);
  assert.deepEqual(fixture.deletions, [resolved]);
  assert.equal(summary.checked, 1);
  assert.equal(summary.cleared, 1);
  assert.equal(summary.matched, 60);
  assert.equal(summary.remaining, 59);
});

test("backfill finds canonical review ownership on a bounded later comments page", async () => {
  const noise = Array.from({ length: 100 }, (_, index) =>
    completedReview(500, {
      at: new Date(now.getTime() - index * 1_000).toISOString(),
      user: { login: `other-${index}[bot]`, type: "Bot" },
    }),
  );
  const fixture = githubFixture({
    numbers: [500],
    comments: new Map([[500, [...noise, completedReview(500)]]]),
  });

  const summary = await runReviewRecoveryLabelBackfill({
    env,
    fetchImpl: fixture.fetchImpl,
    now,
  });

  assert.deepEqual(fixture.commentPages, [
    { number: 500, page: 1 },
    { number: 500, page: 2 },
  ]);
  assert.deepEqual(fixture.deletions, [500]);
  assert.equal(summary.cleared, 1);
});

test("backfill refuses to use the read token for target-repository writes", async () => {
  let requests = 0;
  await assert.rejects(
    () =>
      runReviewRecoveryLabelBackfill({
        env: { ...env, TARGET_WRITE_TOKEN: "" },
        fetchImpl: (async () => {
          requests += 1;
          return Response.json({});
        }) as typeof fetch,
        now,
      }),
    /missing read token, target write token, or valid target repository/,
  );
  assert.equal(requests, 0);
});
