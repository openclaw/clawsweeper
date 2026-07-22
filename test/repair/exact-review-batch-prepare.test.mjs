import assert from "node:assert/strict";
import test from "node:test";

import { runBoundedPool } from "../../scripts/prepare-exact-review-batch.mjs";

test("bounded preparation never exceeds four workers and preserves manifest order", async () => {
  const completionOrder = [];
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 32 }, (_, index) => index);
  const { results, peak: reportedPeak } = await runBoundedPool(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, (7 - (item % 7)) * 2));
    completionOrder.push(item);
    active -= 1;
    return `outcome-${item}`;
  });

  assert.equal(peak, 4);
  assert.equal(reportedPeak, 4);
  assert.notDeepEqual(completionOrder, items);
  assert.deepEqual(
    results,
    items.map((item) => `outcome-${item}`),
  );
});

test("concurrency one is serial and invalid concurrency fails closed", async () => {
  const order = [];
  const { results, peak } = await runBoundedPool([3, 2, 1], 1, async (item) => {
    order.push(item);
    return item * 2;
  });
  assert.deepEqual(order, [3, 2, 1]);
  assert.deepEqual(results, [6, 4, 2]);
  assert.equal(peak, 1);
  await assert.rejects(() => runBoundedPool([1], 5, async () => 1), /between 1 and 4/);
});
