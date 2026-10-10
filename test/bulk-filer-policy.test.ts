import assert from "node:assert/strict";
import test from "node:test";

import {
  bulkFilerThreshold,
  bulkFilerWindowDays,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";
import {
  bulkFilerIssueSearchQuery,
  detectBulkFiler,
  bulkFilerPolicyInvalidatesCachedReview,
  updateBulkFilerDetectedFrontMatter,
} from "../dist/clawsweeper-context-hydration.js";
import { createLabelMutationOperations } from "../dist/clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "../dist/clawsweeper-label-operations.js";
import { issueRatingLabelForState } from "../dist/clawsweeper-label-selection.js";
import {
  BULK_FILER_UNCOUNTED_ISSUE_RATING_LABELS,
  ISSUE_ADVISORY_LABELS,
} from "../dist/clawsweeper-policy.js";
import { item } from "./helpers.ts";

test("bulk-filer defaults and positive env overrides are bounded", () => {
  assert.equal(bulkFilerThreshold({}), 10);
  assert.equal(bulkFilerWindowDays({}), 7);
  assert.equal(bulkFilerThreshold({ CLAWSWEEPER_BULK_FILER_THRESHOLD: "12" }), 12);
  assert.equal(bulkFilerWindowDays({ CLAWSWEEPER_BULK_FILER_WINDOW_DAYS: "14" }), 14);
  assert.equal(bulkFilerThreshold({ CLAWSWEEPER_BULK_FILER_THRESHOLD: "0" }), 10);
  assert.equal(bulkFilerWindowDays({ CLAWSWEEPER_BULK_FILER_WINDOW_DAYS: "nope" }), 7);
});

test("bulk-filer detection includes the threshold boundary and leaves labeling to publication", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  let searches = 0;
  const cutoffResult = detectBulkFiler({
    item: item({ number: 43, createdAt: "2026-07-09T12:00:00.000Z" }),
    cache: new Map(),
    now,
    searchCount: () => {
      searches += 1;
      return 10;
    },
  });
  assert.deepEqual(cutoffResult, {
    context: null,
    labelPending: false,
    labelApplied: false,
  });
  assert.equal(searches, 0);

  const candidate = item({ number: 44, createdAt: "2026-07-09T12:00:00.001Z" });
  let observedWindowStart = "";
  let observedWindowEnd = "";
  const result = detectBulkFiler({
    item: candidate,
    cache: new Map(),
    now,
    searchCount: ({ windowStart, windowEnd }) => {
      searches += 1;
      observedWindowStart = windowStart;
      observedWindowEnd = windowEnd;
      return 10;
    },
  });

  assert.equal(searches, 1);
  assert.equal(observedWindowStart, "2026-07-02T12:00:00.001Z");
  assert.equal(observedWindowEnd, "2026-07-09T12:00:00.001Z");
  assert.equal(result.context?.issueCount, 10);
  assert.equal(result.context?.threshold, 10);
  assert.equal(result.context?.windowDays, 7);
  assert.equal(result.labelPending, true);
  assert.equal(result.labelApplied, false);
  assert.equal(candidate.labels.includes("clawsweeper:bulk-filed"), false);
});

test("bulk-filer count ends at the issue's creation, not at review time", () => {
  // Real shape from openclaw/openclaw: nine issues by 10-04, three more afterwards.
  const filedAt = [
    "2026-10-01T14:52:00Z",
    "2026-10-02T22:24:00Z",
    "2026-10-03T20:02:00Z",
    "2026-10-03T21:38:00Z",
    "2026-10-03T22:19:00Z",
    "2026-10-03T22:19:30Z",
    "2026-10-03T22:29:00Z",
    "2026-10-04T14:54:00Z",
    "2026-10-04T15:07:54Z",
    "2026-10-05T17:59:00Z",
    "2026-10-06T18:30:00Z",
    "2026-10-06T23:00:00Z",
  ].map((value) => Date.parse(value));
  // Like GitHub search: an absent upper bound counts everything filed after the start.
  const searchCount = ({ windowStart, windowEnd }: { windowStart: string; windowEnd?: string }) =>
    filedAt.filter(
      (ms) =>
        ms > Date.parse(windowStart) &&
        ms <= (windowEnd ? Date.parse(windowEnd) : Number.POSITIVE_INFINITY),
    ).length;
  const cache = new Map();
  const reReviewNow = Date.parse("2026-10-08T12:00:00.000Z");

  const earlier = detectBulkFiler({
    item: item({ author: "reporter", number: 164972, createdAt: "2026-10-04T15:07:54Z" }),
    cache,
    now: reReviewNow,
    searchCount,
  });
  assert.deepEqual(earlier, {
    context: null,
    labelPending: false,
    labelApplied: false,
    belowThreshold: true,
  });

  const tenth = detectBulkFiler({
    item: item({ author: "reporter", number: 165709, createdAt: "2026-10-05T17:59:00Z" }),
    cache,
    now: reReviewNow,
    searchCount,
  });
  assert.equal(tenth.context?.issueCount, 10);
  assert.equal(tenth.labelPending, true);
  assert.equal(cache.size, 2);
});

test("bulk-filer count leaves out only completed and high-confidence reproduced issues", () => {
  const query = bulkFilerIssueSearchQuery({
    repo: "openclaw/openclaw",
    author: "reporter",
    windowStart: "2026-10-03T11:00:00.000Z",
    windowEnd: "2026-10-10T11:00:00.000Z",
  });
  // The author's filing window stays as before; the exclusions only narrow it.
  for (const term of [
    "repo:openclaw/openclaw",
    "type:issue",
    "author:reporter",
    "created:2026-10-03T11:00:00.001Z..2026-10-10T11:00:00.000Z",
    "-reason:completed",
    '-label:"issue-rating: 🦀 challenger crab"',
    '-label:"issue-rating: 🦞 diamond lobster"',
  ]) {
    assert.ok(query.includes(term), term);
  }

  // The uncounted ratings are exactly the ones the review assigns for a
  // high-confidence reproduction, so a renamed rating cannot silently drift.
  assert.deepEqual(
    [...BULK_FILER_UNCOUNTED_ISSUE_RATING_LABELS].sort(),
    [
      issueRatingLabelForState({
        type: "issue",
        reproductionStatus: "reproduced",
        reproductionConfidence: "high",
      }),
      issueRatingLabelForState({
        type: "issue",
        reproductionStatus: "source_reproducible",
        reproductionConfidence: "high",
      }),
    ].sort(),
  );
  for (const { name } of ISSUE_ADVISORY_LABELS) {
    if (!name.startsWith("issue-rating:")) continue;
    const uncounted = BULK_FILER_UNCOUNTED_ISSUE_RATING_LABELS.includes(name);
    assert.equal(query.includes(name), uncounted, name);
  }
  // Open, unrated, not-planned and duplicate issues keep counting.
  assert.doesNotMatch(query, /is:(open|closed)|reason:(?!completed)/);
});

test("bulk-filer policy exempts only owners and members", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  for (const authorAssociation of ["OWNER", "MEMBER"]) {
    let searches = 0;
    const result = detectBulkFiler({
      item: item({ authorAssociation, createdAt: "2026-07-16T11:59:59.999Z" }),
      cache: new Map(),
      now,
      searchCount: () => {
        searches += 1;
        return 16;
      },
    });
    assert.deepEqual(result, { context: null, labelPending: false, labelApplied: false });
    assert.equal(searches, 0, `${authorAssociation} must not consume a bulk-filer search`);
  }

  let collaboratorSearches = 0;
  const collaborator = detectBulkFiler({
    item: item({ authorAssociation: "COLLABORATOR", createdAt: "2026-07-16T11:59:59.999Z" }),
    cache: new Map(),
    now,
    searchCount: () => {
      collaboratorSearches += 1;
      return 16;
    },
  });
  assert.equal(collaborator.context?.detected, true);
  assert.equal(collaboratorSearches, 1);
});

test("bulk-filer detection caches counts, fails open, and respects an existing label", () => {
  const cache = new Map();
  let searches = 0;
  const searchCount = () => {
    searches += 1;
    throw new Error("search unavailable");
  };
  const first = detectBulkFiler({
    item: item({ author: "Reporter", number: 1 }),
    cache,
    now: 0,
    searchCount,
  });
  const second = detectBulkFiler({
    item: item({ author: "reporter", number: 2 }),
    cache,
    now: 0,
    searchCount,
  });
  assert.deepEqual(first, { context: null, labelPending: false, labelApplied: false });
  assert.deepEqual(second, { context: null, labelPending: false, labelApplied: false });
  assert.equal(searches, 1);

  const existing = detectBulkFiler({
    item: item({ labels: ["ClawSweeper:Bulk-Filed"] }),
    cache: new Map(),
    now: 0,
    searchCount: () => 16,
  });
  assert.equal(existing.context?.detected, true);
  assert.equal(existing.labelPending, false);
  assert.equal(existing.labelApplied, false);
});

test("review-start comments stay neutral when a bulk filer is detected", () => {
  const comment = renderReviewStartStatusComment({
    number: 44,
    kind: "issue",
    title: "Templated report",
    headSha: "0123456789abcdef0123456789abcdef0123456789abcdef",
  });

  assert.doesNotMatch(comment, /High filing volume detected/);
  assert.match(comment, /ClawSweeper status: review started/);
});

test("the publisher applies a detected bulk-filer label only for non-exempt authors", () => {
  const offline = () => {
    throw new Error("a dry run must not call gh");
  };
  const { syncBulkFilerLabel } = createLabelSyncOperations(
    createLabelMutationOperations({ ghJson: offline, ghObservedMutationCommand: offline }),
  );
  assert.deepEqual(
    syncBulkFilerLabel({
      number: 44,
      labels: [],
      bulkFilerDetected: true,
      authorAssociation: "MEMBER",
      dryRun: true,
    }),
    { labels: [], changed: false },
  );
  assert.deepEqual(
    syncBulkFilerLabel({
      number: 44,
      labels: [],
      bulkFilerDetected: true,
      authorAssociation: "COLLABORATOR",
      dryRun: true,
    }),
    { labels: ["clawsweeper:bulk-filed"], changed: true },
  );
  assert.deepEqual(
    syncBulkFilerLabel({
      number: 44,
      labels: ["clawsweeper:bulk-filed", "maintainer"],
      bulkFilerDetected: false,
      authorAssociation: "OWNER",
      dryRun: true,
    }),
    { labels: ["maintainer"], changed: true },
  );
  assert.deepEqual(
    syncBulkFilerLabel({
      number: 44,
      labels: ["clawsweeper:bulk-filed", "maintainer"],
      bulkFilerDetected: true,
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "maintain",
      dryRun: true,
    }),
    { labels: ["maintainer"], changed: true },
  );
  assert.deepEqual(
    syncBulkFilerLabel({
      number: 44,
      labels: ["clawsweeper:bulk-filed", "maintainer"],
      bulkFilerDetected: true,
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "admin",
      dryRun: true,
    }),
    { labels: ["maintainer"], changed: true },
  );
  assert.deepEqual(
    syncBulkFilerLabel({
      number: 44,
      labels: [],
      bulkFilerDetected: true,
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "write",
      dryRun: true,
    }),
    { labels: ["clawsweeper:bulk-filed"], changed: true },
  );
});

test("a confirmed below-threshold count removes a retroactive label, a failed search keeps it", () => {
  const offline = () => {
    throw new Error("a dry run must not call gh");
  };
  const { syncBulkFilerLabel } = createLabelSyncOperations(
    createLabelMutationOperations({ ghJson: offline, ghObservedMutationCommand: offline }),
  );
  const retroactivelyLabeled = {
    number: 164972,
    labels: ["clawsweeper:bulk-filed", "P2"],
    bulkFilerDetected: false,
    authorAssociation: "CONTRIBUTOR",
    dryRun: true,
  };
  assert.deepEqual(syncBulkFilerLabel({ ...retroactivelyLabeled, bulkFilerBelowThreshold: true }), {
    labels: ["P2"],
    changed: true,
  });
  assert.deepEqual(syncBulkFilerLabel(retroactivelyLabeled), {
    labels: ["clawsweeper:bulk-filed", "P2"],
    changed: false,
  });
  assert.deepEqual(
    syncBulkFilerLabel({
      ...retroactivelyLabeled,
      bulkFilerDetected: true,
      bulkFilerBelowThreshold: true,
    }),
    { labels: ["clawsweeper:bulk-filed", "P2"], changed: false },
  );

  const below = detectBulkFiler({
    item: item({ createdAt: "2026-07-16T11:59:59.999Z" }),
    cache: new Map(),
    now: Date.parse("2026-07-16T12:00:00.000Z"),
    searchCount: () => 9,
  });
  assert.match(
    updateBulkFilerDetectedFrontMatter("---\nreview_cache_hit: true\n---\n", below),
    /^bulk_filer_below_threshold: true$/m,
  );
  const failed = detectBulkFiler({
    item: item({ createdAt: "2026-07-16T11:59:59.999Z" }),
    cache: new Map(),
    now: Date.parse("2026-07-16T12:00:00.000Z"),
    searchCount: () => {
      throw new Error("search unavailable");
    },
  });
  assert.match(
    updateBulkFilerDetectedFrontMatter("---\nreview_cache_hit: true\n---\n", failed),
    /^bulk_filer_below_threshold: false$/m,
  );
});

test("a confirmed below-threshold count bypasses a cached bulk-suppressed review", () => {
  const suppressed =
    "---\nbulk_filer_detected: true\nlast_full_review_bulk_filer_detected: true\nreview_cache_hit: false\n---\n";
  assert.equal(bulkFilerPolicyInvalidatesCachedReview(suppressed, false, true), true);
  assert.equal(bulkFilerPolicyInvalidatesCachedReview(suppressed, false, false), false);
  assert.equal(
    bulkFilerPolicyInvalidatesCachedReview(
      "---\nlast_full_review_bulk_filer_detected: false\nreview_cache_hit: false\n---\n",
      false,
      true,
    ),
    false,
  );
  // Legacy reports without the field are not re-reviewed just because the count is low.
  assert.equal(
    bulkFilerPolicyInvalidatesCachedReview("---\nreview_cache_hit: false\n---\n", false, true),
    false,
  );
});

test("cached reports refresh the bulk-filer handoff, including legacy reports", () => {
  const detected = detectBulkFiler({
    item: item({ createdAt: "2026-07-16T11:59:59.999Z" }),
    cache: new Map(),
    now: Date.parse("2026-07-16T12:00:00.000Z"),
    searchCount: () => 16,
  });
  assert.match(
    updateBulkFilerDetectedFrontMatter("---\nreview_cache_hit: true\n---\n", detected),
    /^bulk_filer_detected: true$/m,
  );
});

test("a newly exempt maintainer bypasses a cached bulk-filer review", () => {
  assert.equal(
    bulkFilerPolicyInvalidatesCachedReview(
      "---\nbulk_filer_detected: false\nlast_full_review_bulk_filer_detected: true\nreview_cache_hit: false\n---\n",
      true,
    ),
    true,
  );
  assert.equal(
    bulkFilerPolicyInvalidatesCachedReview(
      "---\nbulk_filer_detected: true\nlast_full_review_bulk_filer_detected: false\nreview_cache_hit: false\n---\n",
      true,
    ),
    false,
  );
  assert.equal(
    bulkFilerPolicyInvalidatesCachedReview("---\nreview_cache_hit: false\n---\n", true),
    true,
  );
  assert.equal(
    bulkFilerPolicyInvalidatesCachedReview(
      "---\nlast_full_review_bulk_filer_detected: true\nreview_cache_hit: false\n---\n",
      false,
    ),
    false,
  );
});
