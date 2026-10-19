import assert from "node:assert/strict";
import test from "node:test";
import { duration } from "../dashboard-site/src/lib/format.ts";

test("dashboard durations carry rounded seconds into minutes, hours and days", () => {
  for (const [seconds, expected] of [
    [59.49, "59s"],
    [59.5, "1m 00s"],
    [299.49, "4m 59s"],
    [299.5, "5m 00s"],
    [299.9, "5m 00s"],
    [3599.49, "59m 59s"],
    [3599.5, "1h 00m"],
    [172799.49, "47h 59m"],
    [172799.5, "2d"],
  ] as const) {
    assert.equal(duration(seconds), expected, `${seconds} seconds`);
  }
});

test("dashboard durations retain compact precision away from rollovers", () => {
  for (const [seconds, expected] of [
    [0, "0s"],
    [12.4, "12s"],
    [12.6, "13s"],
    [60, "1m 00s"],
    [61, "1m 01s"],
    [3661, "1h 01m"],
    [86399, "23h 59m"],
    [172800, "2d"],
    [259200, "3d"],
  ] as const) {
    assert.equal(duration(seconds), expected, `${seconds} seconds`);
  }
});

test("dashboard durations leave unavailable observations unknown", () => {
  for (const seconds of [null, NaN, Infinity, -Infinity]) {
    assert.equal(duration(seconds), "–");
  }
});
