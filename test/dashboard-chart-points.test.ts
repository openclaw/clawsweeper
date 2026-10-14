import assert from "node:assert/strict";
import test from "node:test";
import { isolatedPoints } from "../dashboard-site/src/lib/chart.ts";

test("isolated observations remain visible at boundaries and between gaps", () => {
  assert.deepEqual(isolatedPoints([10, null, 20, null, 0]), [
    { index: 0, value: 10 },
    { index: 2, value: 20 },
    { index: 4, value: 0 },
  ]);
  assert.deepEqual(isolatedPoints([0]), [{ index: 0, value: 0 }]);
});

test("connected observations and missing history do not need point markers", () => {
  assert.deepEqual(isolatedPoints([null, 10, 20, null, 30, 40]), []);
  assert.deepEqual(isolatedPoints([null, null]), []);
  assert.deepEqual(isolatedPoints([]), []);
});
