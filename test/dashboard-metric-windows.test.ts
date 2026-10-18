import assert from "node:assert/strict";
import test from "node:test";
import { reviewTimingWindow, summarizeRunWindow } from "../dashboard-site/src/lib/run-window.ts";

test("review timings retain calendar gaps and exclude current, future and older samples", () => {
  const result = reviewTimingWindow(
    [
      { date: "2026-10-01", reviewP50: 999, reviewP90: 999 },
      { date: "2026-10-11", reviewP50: 60, reviewP90: 600 },
      { date: "2026-10-13", reviewP50: 0, reviewP90: 0 },
      { date: "2026-10-14", reviewP50: 999, reviewP90: 999 },
      { date: "2026-10-15", reviewP50: 999, reviewP90: 999 },
    ],
    "2026-10-14T08:00:00Z",
    3,
  );
  assert.deepEqual(result, [
    { date: "2026-10-11", reviewP50: 60, reviewP90: 600 },
    { date: "2026-10-12", reviewP50: null, reviewP90: null },
    { date: "2026-10-13", reviewP50: 0, reviewP90: 0 },
  ]);
});

test("review timings without observations still occupy the full calendar window", () => {
  assert.deepEqual(reviewTimingWindow([], "2026-01-02T08:00:00Z", 2), [
    { date: "2025-12-31", reviewP50: null, reviewP90: null },
    { date: "2026-01-01", reviewP50: null, reviewP90: null },
  ]);
});

test("run windows expose sparse history and exclude the current day", () => {
  const result = summarizeRunWindow(
    [
      { date: "2026-10-01", total: 100, success: 100 },
      { date: "2026-10-10", total: 10, success: 8 },
      { date: "2026-10-13", total: 20, success: 19 },
      { date: "2026-10-14", total: 100, success: 0 },
    ],
    "2026-10-14T05:00:00Z",
    7,
  );
  assert.deepEqual(result, {
    total: 30,
    success: 27,
    recordedDays: 2,
    requestedDays: 7,
    rate: 0.9,
  });
});

test("prior windows stay on calendar boundaries rather than shifting to old samples", () => {
  const days = [{ date: "2026-10-05", total: 4, success: 2 }];
  assert.equal(summarizeRunWindow(days, "2026-10-14T05:00:00Z", 7).rate, null);
  assert.deepEqual(summarizeRunWindow(days, "2026-10-14T05:00:00Z", 7, 7), {
    total: 4,
    success: 2,
    recordedDays: 1,
    requestedDays: 7,
    rate: 0.5,
  });
});

test("a recorded zero-run day is distinct from missing history", () => {
  assert.deepEqual(
    summarizeRunWindow([{ date: "2026-10-13", total: 0, success: 0 }], "2026-10-14", 7),
    {
      total: 0,
      success: 0,
      recordedDays: 1,
      requestedDays: 7,
      rate: null,
    },
  );
});
