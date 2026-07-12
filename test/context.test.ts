import assert from "node:assert/strict";
import test from "node:test";

import {
  assistIssueUrlMatchesForTest,
  assistPromptContextForTest,
  compactMappedSlice,
  compactMappedWindow,
  extractLatestClawSweeperReviewForTest,
  extractLatestClawSweeperReviewFromHydrationForTest,
  filterReviewContextCommentsForTest,
  ghPagedContextWindow,
  ghPagedLinkHeaderContextWindow,
  githubContextWindowPlan,
  githubLinkLastPageNumber,
  githubPaginatedPath,
  stripEmptyMaintainerRulingFieldsForTest,
} from "../dist/clawsweeper.js";

test("assist source comment URL matching preserves canonical repository casing", () => {
  assert.equal(
    assistIssueUrlMatchesForTest(
      "https://api.github.com/repos/OpenClaw/ExampleRepo/issues/42",
      "openclaw/examplerepo",
      42,
    ),
    true,
  );
  assert.equal(
    assistIssueUrlMatchesForTest(
      "https://api.github.com/repos/OpenClaw/ExampleRepo/issues/420",
      "openclaw/examplerepo",
      42,
    ),
    false,
  );
});

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
    issueComment(
      8,
      "ClawSweeper assist: prior answer.\n\n<!-- clawsweeper-assist:abc -->",
      "clawsweeper[bot]",
    ),
    issueComment(4, "@clawsweeper re-review", "author"),
    issueComment(5, "Here is real behavior proof from my terminal.", "author"),
    issueComment(6, "Actionable file/line review feedback.", "chatgpt-codex-connector[bot]"),
  ];

  const result = filterReviewContextCommentsForTest(comments, 123);

  assert.equal(result.filtered, 6);
  assert.deepEqual(
    result.included.map((comment) => (comment as { id: number }).id),
    [5, 6],
  );
});

test("assist prompt context excludes transient API state but preserves material review inputs", () => {
  const base = {
    issue: {
      number: 42,
      title: "Stable title",
      state: "open",
      comments: 3,
      updatedAt: "2026-07-10T01:00:00Z",
      body: "Stable body",
    },
    comments: [{ id: 1, author: "maintainer", body: "Please verify this." }],
    timeline: [{ id: 9, event: "commented", actor: "clawsweeper[bot]" }],
    sourceRevision: "a".repeat(64),
    relatedItems: [{ issue: { number: 99, title: "Local search result" } }],
    counts: { comments: 3, timeline: 9, pullFiles: 2 },
    pullRequest: {
      number: 42,
      state: "open",
      draft: false,
      mergeable: null,
      mergeableState: "unknown",
      updatedAt: "2026-07-10T01:00:00Z",
      head: { sha: "b".repeat(40) },
      base: { sha: "c".repeat(40) },
    },
    pullFiles: [{ filename: "src/example.ts", patch: "+fixed" }],
    pullCommits: [{ sha: "b".repeat(40), message: "fix: example" }],
    pullReviewComments: [{ id: 2, author: "reviewer", body: "Needs a test." }],
  };
  const transientlyChanged = structuredClone(base);
  transientlyChanged.issue.comments = 4;
  transientlyChanged.issue.updatedAt = "2026-07-10T01:01:00Z";
  transientlyChanged.counts.comments = 4;
  transientlyChanged.pullRequest.mergeable = true;
  transientlyChanged.pullRequest.mergeableState = "clean";
  transientlyChanged.pullRequest.updatedAt = "2026-07-10T01:01:00Z";

  assert.deepEqual(
    assistPromptContextForTest(base),
    assistPromptContextForTest(transientlyChanged),
  );
  const projected = assistPromptContextForTest(base);
  assert.equal(projected.timeline, undefined);
  assert.equal(projected.relatedItems, undefined);
  assert.equal(projected.counts, undefined);
  assert.equal((projected.issue as Record<string, unknown>).updatedAt, undefined);
  assert.equal((projected.pullRequest as Record<string, unknown>).mergeableState, undefined);

  const materiallyChanged = structuredClone(base);
  materiallyChanged.pullRequest.draft = true;
  assert.notDeepEqual(
    assistPromptContextForTest(base),
    assistPromptContextForTest(materiallyChanged),
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

test("durable review identity uses complete comments outside the prompt window", () => {
  const comments = Array.from({ length: 30 }, (_, index) =>
    issueComment(index + 1, `comment ${index + 1}`, "contributor"),
  );
  comments[14] = issueComment(
    15,
    `Codex review: passed.

**Summary**
The review in the middle of an active discussion remains authoritative.

<!-- clawsweeper-verdict:pass item=123 sha=abc confidence=high -->
<!-- clawsweeper-review item=123 -->`,
    "clawsweeper[bot]",
    "2026-05-24T02:00:00Z",
  );
  const commentsWindow = ghPagedContextWindow<unknown>(
    "repos/openclaw/openclaw/issues/123/comments",
    comments.length,
    24,
    {
      page: (_path, page) => comments.slice((page - 1) * 100, page * 100),
    },
  );

  assert.equal(extractLatestClawSweeperReviewForTest(commentsWindow.items, 123), null);
  const review = extractLatestClawSweeperReviewFromHydrationForTest(commentsWindow, comments, 123);

  assert.ok(review);
  assert.equal(review.reviewedSha, "abc");
  assert.match(review.summary ?? "", /middle of an active discussion/);
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
