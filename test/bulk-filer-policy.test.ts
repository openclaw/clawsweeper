import assert from "node:assert/strict";
import test from "node:test";

import {
  activateBulkFilerAfterReviewLeaseForTest,
  bulkFilerThreshold,
  bulkFilerWindowDays,
  detectBulkFilerForTest,
  renderReviewStartStatusComment,
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

test("bulk-filer detection includes the threshold boundary and excludes the exact cutoff", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  let searches = 0;
  const cutoffResult = detectBulkFilerForTest({
    item: item({
      number: 43,
      createdAt: "2026-07-09T12:00:00.000Z",
    }),
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

  const candidate = item({
    number: 44,
    createdAt: "2026-07-09T12:00:00.001Z",
  });
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

  const mutations: string[] = [];
  assert.equal(
    activateBulkFilerAfterReviewLeaseForTest({
      item: candidate,
      detection: result,
      patchTransparency: () => mutations.push("transparency"),
      applyLabel: () => {
        mutations.push("label");
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(mutations, ["label", "transparency"]);
  assert.equal(candidate.labels.includes("clawsweeper:bulk-filed"), true);

  const below = detectBulkFilerForTest({
    item: item({ number: 45, createdAt: "2026-07-16T00:00:00.000Z" }),
    cache: new Map(),
    now,
    searchCount: () => 9,
  });
  assert.deepEqual(below, { context: null, labelPending: false, labelApplied: false });
});

test("bulk-filer eligibility excludes old issues from prolific authors", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  let searches = 0;
  const oldCandidate = item({
    number: 46,
    createdAt: "2026-07-09T11:59:59.999Z",
  });
  const oldResult = detectBulkFilerForTest({
    item: oldCandidate,
    cache: new Map(),
    now,
    searchCount: () => {
      searches += 1;
      return 16;
    },
  });

  assert.deepEqual(oldResult, { context: null, labelPending: false, labelApplied: false });
  assert.equal(searches, 0);
  assert.equal(
    activateBulkFilerAfterReviewLeaseForTest({
      item: oldCandidate,
      detection: oldResult,
      patchTransparency: () => {
        throw new Error("old issues must not receive transparency");
      },
      applyLabel: () => {
        throw new Error("old issues must not be labeled");
      },
    }),
    false,
  );
  assert.equal(oldCandidate.labels.includes("clawsweeper:bulk-filed"), false);

  const freshCandidate = item({
    number: 47,
    createdAt: "2026-07-16T11:59:59.999Z",
  });
  const freshResult = detectBulkFilerForTest({
    item: freshCandidate,
    cache: new Map(),
    now,
    searchCount: () => {
      searches += 1;
      return 16;
    },
  });
  assert.equal(
    activateBulkFilerAfterReviewLeaseForTest({
      item: freshCandidate,
      detection: freshResult,
      patchTransparency: () => undefined,
      applyLabel: () => true,
    }),
    true,
  );

  assert.equal(searches, 1);
  assert.equal(freshResult.context?.detected, true);
  assert.equal(freshCandidate.labels.includes("clawsweeper:bulk-filed"), true);
});

test("bulk-filer activation omits transparency when label application fails", () => {
  const candidate = item();
  const detection = detectBulkFilerForTest({
    item: candidate,
    cache: new Map(),
    now: 0,
    searchCount: () => 16,
  });
  const mutations: string[] = [];

  assert.equal(
    activateBulkFilerAfterReviewLeaseForTest({
      item: candidate,
      detection,
      applyLabel: () => {
        mutations.push("label");
        return false;
      },
      patchTransparency: () => mutations.push("transparency"),
    }),
    false,
  );
  assert.deepEqual(mutations, ["label"]);
  assert.equal(detection.labelPending, true);
  assert.equal(detection.labelApplied, false);
  assert.equal(candidate.labels.includes("clawsweeper:bulk-filed"), false);

  assert.equal(
    activateBulkFilerAfterReviewLeaseForTest({
      item: candidate,
      detection,
      applyLabel: () => {
        mutations.push("label");
        return true;
      },
      patchTransparency: () => mutations.push("transparency"),
    }),
    true,
  );
  assert.deepEqual(mutations, ["label", "label", "transparency"]);
  assert.equal(detection.labelPending, false);
  assert.equal(detection.labelApplied, true);
});

test("bulk-filer detection caches counts per author and fails open", () => {
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
});

test("bulk-filer labeling is idempotent", () => {
  const candidate = item({ labels: ["ClawSweeper:Bulk-Filed"] });
  const result = detectBulkFilerForTest({
    item: candidate,
    cache: new Map(),
    now: 0,
    searchCount: () => 16,
  });
  let mutations = 0;
  const applied = activateBulkFilerAfterReviewLeaseForTest({
    item: candidate,
    detection: result,
    patchTransparency: () => {
      mutations += 1;
    },
    applyLabel: () => {
      mutations += 1;
      return true;
    },
  });

  assert.equal(result.context?.detected, true);
  assert.equal(result.labelPending, false);
  assert.equal(result.labelApplied, false);
  assert.equal(applied, false);
  assert.equal(mutations, 0);
  assert.deepEqual(candidate.labels, ["ClawSweeper:Bulk-Filed"]);
});

test("first bulk-filer label application adds polite scheduling transparency", () => {
  const comment = renderReviewStartStatusComment({
    number: 44,
    kind: "issue",
    title: "Templated report",
    headSha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    bulkFilerLabelApplied: true,
  });

  assert.match(comment, /High filing volume detected/);
  assert.match(comment, /batched behind other reviews/);
  assert.match(comment, /Consolidating related reports into fewer issues/);
});
