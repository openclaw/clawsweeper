import assert from "node:assert/strict";
import test from "node:test";

import {
  compactMappedSlice,
  compactMappedWindow,
  extractLatestClawSweeperReviewForTest,
  filterReviewContextCommentsForTest,
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  githubContextWindowPlan,
  githubLinkLastPageNumber,
  githubPaginatedPath,
  stripEmptyMaintainerRulingFieldsForTest,
} from "../dist/clawsweeper.js";

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("compactMappedSlice maps only retained prompt entries", () => {
  const mapped: number[] = [];
  const result = compactMappedSlice([1, 2, 3, 4, 5, 6], 4, (value) => {
    mapped.push(value);
    return value * 10;
  });
  assert.deepEqual(result, [
    10,
    20,
    { omitted: 2, note: "middle entries omitted from prompt context" },
    50,
    60,
  ]);
  assert.deepEqual(mapped, [1, 2, 5, 6]);
});

test("compactMappedSlice maps every entry when no compaction is needed", () => {
  const mapped: number[] = [];
  const result = compactMappedSlice([1, 2, 3], 3, (value) => {
    mapped.push(value);
    return value * 10;
  });
  assert.deepEqual(result, [10, 20, 30]);
  assert.deepEqual(mapped, [1, 2, 3]);
});

test("compactMappedWindow marks omitted entries when hydration is already bounded", () => {
  const mapped: number[] = [];
  const result = compactMappedWindow([1, 2, 5, 6], 6, 4, (value) => {
    mapped.push(value);
    return value * 10;
  });
  assert.deepEqual(result, [
    10,
    20,
    { omitted: 2, note: "middle entries omitted from prompt context" },
    50,
    60,
  ]);
  assert.deepEqual(mapped, [1, 2, 5, 6]);
});

test("compactMappedWindow keeps bounded hydrated context when total is larger than limit", () => {
  const mapped: number[] = [];
  const result = compactMappedWindow([1, 2, 99, 100], 100, 4, (value) => {
    mapped.push(value);
    return value;
  });
  assert.deepEqual(result, [
    1,
    2,
    { omitted: 96, note: "middle entries omitted from prompt context" },
    99,
    100,
  ]);
  assert.deepEqual(mapped, [1, 2, 99, 100]);
});

function issueComment(
  id: number,
  body: string,
  login = "contributor",
  updatedAt = "2026-05-24T00:00:00Z",
) {
  return {
    id,
    body,
    html_url: `https://github.com/openclaw/openclaw/pull/123#issuecomment-${id}`,
    updated_at: updatedAt,
    created_at: updatedAt,
    user: { login },
    author_association: "CONTRIBUTOR",
  };
}

test("review context comment filter removes ClawSweeper self-noise and command-only comments", () => {
  const comments = [
    issueComment(
      1,
      "Codex review: needs maintainer review.\n\n<!-- clawsweeper-review item=123 -->",
      "clawsweeper[bot]",
    ),
    issueComment(
      2,
      "Legacy generated comment\n\n<!-- clawsweeper-pr-egg-hatch:123 -->",
      "openclaw-clawsweeper[bot]",
    ),
    issueComment(
      3,
      "<!-- clawsweeper-command-status:123:re_review:abc -->\nQueued.",
      "clawsweeper",
    ),
    issueComment(
      7,
      "<!-- clawsweeper-visual item=123 lens=state sha=abc -->\n# Visual brief",
      "clawsweeper",
    ),
    issueComment(4, "@clawsweeper re-review", "author"),
    issueComment(5, "Here is real behavior proof from my terminal.", "author"),
    issueComment(6, "Actionable file/line review feedback.", "chatgpt-codex-connector[bot]"),
  ];

  const result = filterReviewContextCommentsForTest(comments, 123);

  assert.equal(result.filtered, 5);
  assert.deepEqual(
    result.included.map((comment) => (comment as { id: number }).id),
    [5, 6],
  );
});

test("visual brief sanitizer removes empty maintainer ruling template fields", () => {
  const body = [
    "# Visual brief",
    "",
    "The routing path is working.",
    "",
    "## Maintainer ruling",
    "",
    "Benefit:",
    "Risk:",
    "Proof needed:",
    "Recommended next action:",
    "Question presented:",
  ].join("\n");

  const sanitized = stripEmptyMaintainerRulingFieldsForTest(body);

  assert.equal(sanitized, "# Visual brief\n\nThe routing path is working.");
});

test("visual brief sanitizer keeps concrete maintainer ruling fields", () => {
  const body = [
    "# Visual brief",
    "",
    "## Maintainer ruling",
    "",
    "Benefit: Reduces operator confusion.",
    "Risk:",
    "Proof needed: Live router and assist smoke.",
    "Recommended next action:",
    "Question presented: Should maintainers accept this proof?",
  ].join("\n");

  const sanitized = stripEmptyMaintainerRulingFieldsForTest(body);

  assert.match(sanitized, /## Maintainer ruling/);
  assert.match(sanitized, /Benefit: Reduces operator confusion\./);
  assert.doesNotMatch(sanitized, /^Risk:$/m);
  assert.doesNotMatch(sanitized, /^Recommended next action:$/m);
  assert.match(sanitized, /Proof needed: Live router and assist smoke\./);
  assert.match(sanitized, /Question presented: Should maintainers accept this proof\?/);
});

test("review context comment filter keeps contributor text that only quotes markers", () => {
  const comments = [
    issueComment(
      1,
      "I pasted a prior marker while debugging: <!-- clawsweeper-review item=123 -->",
      "contributor",
    ),
  ];

  const result = filterReviewContextCommentsForTest(comments, 123);

  assert.equal(result.filtered, 0);
  assert.equal(result.included.length, 1);
  assert.equal(extractLatestClawSweeperReviewForTest(comments, 123), null);
});

test("latest ClawSweeper durable review is extracted as compact previous review state", () => {
  const older = issueComment(
    1,
    `Codex review: needs real behavior proof before merge.

**Latest ClawSweeper review:** 2026-05-24 01:00 UTC.

**Summary**
Old summary.

<!-- clawsweeper-verdict:needs-human item=123 sha=oldsha confidence=high -->

<!-- clawsweeper-review item=123 -->`,
    "clawsweeper[bot]",
    "2026-05-24T01:00:00Z",
  );
  const latest = issueComment(
    2,
    `Codex review: found issues before merge.

**Latest ClawSweeper review:** 2026-05-24 02:00 UTC.

**Summary**
The PR changes routing behavior.

**PR rating**
Overall: unranked.

**Real behavior proof**
Needs real behavior proof before merge.

**Review findings**
- [P1] Preserve session state - src/file.ts:10

<!-- clawsweeper-verdict:needs-human item=123 sha=newsha confidence=high -->
<!-- clawsweeper-action:fix-required item=123 sha=newsha confidence=high finding=review-feedback -->

<!-- clawsweeper-review item=123 -->`,
    "clawsweeper[bot]",
    "2026-05-24T02:00:00Z",
  );

  const review = extractLatestClawSweeperReviewForTest([older, latest], 123);

  assert.ok(review);
  assert.equal(review.status, "found issues before merge.");
  assert.equal(review.reviewedSha, "newsha");
  assert.equal(review.summary, "The PR changes routing behavior.");
  assert.equal(review.proofStatus, "Needs real behavior proof before merge.");
  assert.equal(review.findings[0]?.priority, "P1");
  assert.equal(review.findings[0]?.title, "Preserve session state");
  assert.doesNotMatch(JSON.stringify(review), /How this review workflow works/);
});

test("latest ClawSweeper durable review parser supports compact merge readiness layout", () => {
  const latest = issueComment(
    2,
    `Codex review: needs real behavior proof before merge. _Reviewed May 24, 2026, 8:34 AM ET / 12:34 UTC._

**Summary**
The PR changes review comment layout.

**Merge readiness**
Overall: 🧂 unranked krab
Proof: 🧂 unranked krab
Patch quality: 🦞 diamond lobster
Result: blocked until real behavior proof is added.

Overall follows the weaker of proof and patch quality, so missing proof can cap an otherwise strong patch.

Proof guidance:
Needs real behavior proof before merge: The PR has no real ingestion-run proof yet. After adding proof, update the PR body; ClawSweeper should re-review automatically.

**Next step before merge**
Add real behavior proof.

**Review findings**
- [P2] Keep prior-review extraction in sync — src/clawsweeper.ts:11021

<details>
<summary>Label changes</summary>

- add \`P2\`

</details>

<!-- clawsweeper-verdict:needs-human item=123 sha=newsha confidence=high -->

<!-- clawsweeper-review item=123 -->`,
    "clawsweeper[bot]",
    "2026-05-24T02:00:00Z",
  );

  const review = extractLatestClawSweeperReviewForTest([latest], 123);

  assert.ok(review);
  assert.equal(review.status, "needs real behavior proof before merge.");
  assert.equal(review.reviewedAt, "May 24, 2026, 8:34 AM ET / 12:34 UTC");
  assert.equal(review.reviewedSha, "newsha");
  assert.equal(review.summary, "The PR changes review comment layout.");
  assert.equal(review.rating, "Overall: 🧂 unranked krab");
  assert.match(review.proofStatus, /^Needs real behavior proof before merge:/);
  assert.equal(review.nextStep, "Add real behavior proof.");
  assert.equal(review.findings[0]?.priority, "P2");
  assert.equal(review.findings[0]?.title, "Keep prior-review extraction in sync");
});

test("githubContextWindowPlan includes prior page when the tail crosses a page boundary", () => {
  assert.deepEqual(githubContextWindowPlan(101, 80), {
    keepStart: 40,
    keepEnd: 40,
    tailFirstPageNumber: 1,
    lastPageNumber: 2,
    tailOffset: 61,
  });
});

test("githubContextWindowPlan keeps large tails to the final page when possible", () => {
  assert.deepEqual(githubContextWindowPlan(3000, 80), {
    keepStart: 40,
    keepEnd: 40,
    tailFirstPageNumber: 30,
    lastPageNumber: 30,
    tailOffset: 60,
  });
});

test("ghPagedContextWindow reuses first page when tail overlaps the head page", () => {
  const fetchedPages: number[] = [];
  const window = ghPagedContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/comments",
    101,
    80,
    {
      page: (_path, page) => {
        fetchedPages.push(page);
        const start = (page - 1) * 100 + 1;
        const end = Math.min(page * 100, 101);
        return Array.from({ length: end - start + 1 }, (_, index) => start + index);
      },
    },
  );

  assert.deepEqual(fetchedPages, [1, 2]);
  assert.deepEqual(window.items, [
    ...Array.from({ length: 40 }, (_, index) => index + 1),
    ...Array.from({ length: 40 }, (_, index) => index + 62),
  ]);
  assert.equal(window.total, 101);
  assert.equal(window.hydrated, 80);
  assert.equal(window.truncated, true);
});

test("ghPagedContextWindow falls back to full pagination when total is missing", () => {
  const window = ghPagedContextWindow<number>(
    "repos/openclaw/openclaw/pulls/123/files",
    undefined,
    80,
    {
      paged: () => [1, 2, 3],
      page: () => {
        throw new Error("page fetch should not be used without a total count");
      },
    },
  );

  assert.deepEqual(window, {
    items: [1, 2, 3],
    total: 3,
    hydrated: 3,
    truncated: false,
  });
});

test("githubLinkLastPageNumber extracts the final REST page", () => {
  assert.equal(
    githubLinkLastPageNumber(
      '<https://api.github.com/repositories/123/issues/1/timeline?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/123/issues/1/timeline?per_page=100&page=30>; rel="last"',
    ),
    30,
  );
  assert.equal(githubLinkLastPageNumber(undefined), null);
});

test("ghPagedLinkHeaderContextWindow uses GitHub link headers for large timeline tails", () => {
  const fetchedPages: number[] = [];
  const window = ghPagedLinkHeaderContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/timeline",
    80,
    {
      pageWithHeaders: (_path, page) => {
        fetchedPages.push(page);
        const start = (page - 1) * 100 + 1;
        return {
          items: Array.from({ length: 100 }, (_, index) => start + index),
          lastPageNumber: page === 1 ? 30 : null,
        };
      },
      paged: () => {
        throw new Error("full pagination should not be used with link headers");
      },
    },
  );

  assert.deepEqual(fetchedPages, [1, 30]);
  assert.deepEqual(window.items, [
    ...Array.from({ length: 40 }, (_, index) => index + 1),
    ...Array.from({ length: 40 }, (_, index) => index + 2961),
  ]);
  assert.equal(window.total, 3000);
  assert.equal(window.hydrated, 80);
  assert.equal(window.truncated, true);
});

test("ghPagedLinkHeaderContextWindow keeps timeline tails that cross the first page", () => {
  const fetchedPages: number[] = [];
  const window = ghPagedLinkHeaderContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/timeline",
    80,
    {
      pageWithHeaders: (_path, page) => {
        fetchedPages.push(page);
        if (page === 1) {
          return {
            items: Array.from({ length: 100 }, (_, index) => index + 1),
            lastPageNumber: 2,
          };
        }
        return { items: [101], lastPageNumber: null };
      },
    },
  );

  assert.deepEqual(fetchedPages, [1, 2]);
  assert.deepEqual(window.items, [
    ...Array.from({ length: 40 }, (_, index) => index + 1),
    ...Array.from({ length: 40 }, (_, index) => index + 62),
  ]);
  assert.equal(window.total, 101);
  assert.equal(window.hydrated, 80);
  assert.equal(window.truncated, true);
});

test("ghPagedLinkHeaderContextWindow falls back when link headers are unavailable", () => {
  const window = ghPagedLinkHeaderContextWindow<number>(
    "repos/openclaw/openclaw/issues/123/timeline",
    80,
    {
      pageWithHeaders: () => ({
        items: Array.from({ length: 100 }, (_, index) => index + 1),
        lastPageNumber: null,
      }),
      paged: () => [1, 2, 3],
    },
  );

  assert.deepEqual(window, {
    items: [1, 2, 3],
    total: 3,
    hydrated: 3,
    truncated: false,
  });
});
