import assert from "node:assert/strict";
import test from "node:test";

import {
  bulkFilerThreshold,
  bulkFilerWindowDays,
  detectBulkFilerForTest,
  renderReviewStartStatusComment,
  syncBulkFilerLabelForTest,
  updateBulkFilerDetectedFrontMatterForTest,
} from "../dist/clawsweeper.js";
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
  const cutoffResult = detectBulkFilerForTest({
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
  const result = detectBulkFilerForTest({
    item: candidate,
    cache: new Map(),
    now,
    searchCount: ({ windowStart }) => {
      searches += 1;
      observedWindowStart = windowStart;
      return 10;
    },
  });

  assert.equal(searches, 1);
  assert.equal(observedWindowStart, "2026-07-09T12:00:00.000Z");
  assert.equal(result.context?.issueCount, 10);
  assert.equal(result.context?.threshold, 10);
  assert.equal(result.context?.windowDays, 7);
  assert.equal(result.labelPending, true);
  assert.equal(result.labelApplied, false);
  assert.equal(candidate.labels.includes("clawsweeper:bulk-filed"), false);
});

test("bulk-filer policy exempts only owners and members", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  for (const authorAssociation of ["OWNER", "MEMBER"]) {
    let searches = 0;
    const result = detectBulkFilerForTest({
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
  const collaborator = detectBulkFilerForTest({
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
  const first = detectBulkFilerForTest({
    item: item({ author: "Reporter", number: 1 }),
    cache,
    now: 0,
    searchCount,
  });
  const second = detectBulkFilerForTest({
    item: item({ author: "reporter", number: 2 }),
    cache,
    now: 0,
    searchCount,
  });
  assert.deepEqual(first, { context: null, labelPending: false, labelApplied: false });
  assert.deepEqual(second, { context: null, labelPending: false, labelApplied: false });
  assert.equal(searches, 1);

  const existing = detectBulkFilerForTest({
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
  assert.deepEqual(
    syncBulkFilerLabelForTest({
      number: 44,
      labels: [],
      bulkFilerDetected: true,
      authorAssociation: "MEMBER",
      dryRun: true,
    }),
    { labels: [], changed: false },
  );
  assert.deepEqual(
    syncBulkFilerLabelForTest({
      number: 44,
      labels: [],
      bulkFilerDetected: true,
      authorAssociation: "COLLABORATOR",
      dryRun: true,
    }),
    { labels: ["clawsweeper:bulk-filed"], changed: true },
  );
  assert.deepEqual(
    syncBulkFilerLabelForTest({
      number: 44,
      labels: ["clawsweeper:bulk-filed", "maintainer"],
      bulkFilerDetected: false,
      authorAssociation: "OWNER",
      dryRun: true,
    }),
    { labels: ["maintainer"], changed: true },
  );
});

test("cached reports refresh the bulk-filer handoff, including legacy reports", () => {
  const detected = detectBulkFilerForTest({
    item: item({ createdAt: "2026-07-16T11:59:59.999Z" }),
    cache: new Map(),
    now: Date.parse("2026-07-16T12:00:00.000Z"),
    searchCount: () => 16,
  });
  assert.match(
    updateBulkFilerDetectedFrontMatterForTest("---\nreview_cache_hit: true\n---\n", detected),
    /^bulk_filer_detected: true$/m,
  );
});
