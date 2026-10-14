import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRunWindow } from "../dashboard-site/src/lib/run-window.ts";

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
