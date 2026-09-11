import assert from "node:assert/strict";
import test from "node:test";
import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const NOW = Date.parse("2026-09-11T06:00:00Z");

test("overdue command-intake wake uses a fresh deadline and polling preserves it", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://queue/stats"));
  const internals = queue as unknown as {
    commandIntakeStore: { nextAttemptAt(): number | null };
    scheduleNext(state: { items: {}; deliveries: {} }, now: number): Promise<void>;
  };
  t.mock.method(internals.commandIntakeStore, "nextAttemptAt", () => NOW - 7_200_000);
  await storage.setAlarm(NOW - 60_000);
  await internals.scheduleNext({ items: {}, deliveries: {} }, NOW);
  assert.equal(await storage.getAlarm(), NOW + 1_000);
  t.mock.method(Date, "now", () => NOW + 100);
  await internals.scheduleNext({ items: {}, deliveries: {} }, NOW + 100);
  assert.equal(await storage.getAlarm(), NOW + 1_000);
});

test("source-authority recovery clamps past deadlines but preserves an earlier future alarm", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://queue/stats"));
  const internals = queue as unknown as {
    scheduleSourceAuthorityVerification(next: number): Promise<void>;
  };
  await internals.scheduleSourceAuthorityVerification(NOW - 7_200_000);
  assert.equal(await storage.getAlarm(), NOW + 1_000);
  await storage.setAlarm(NOW + 500);
  await internals.scheduleSourceAuthorityVerification(NOW - 7_200_000);
  assert.equal(await storage.getAlarm(), NOW + 500);
  await storage.deleteAlarm();
  await internals.scheduleSourceAuthorityVerification(NOW + 60_000);
  assert.equal(await storage.getAlarm(), NOW + 60_000);
});

test("scheduling uses the current clock after asynchronous storage reads", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://queue/stats"));
  const internals = queue as unknown as {
    commandIntakeStore: { nextAttemptAt(): number | null };
    scheduleNext(state: { items: {}; deliveries: {} }, now: number): Promise<void>;
  };
  t.mock.method(internals.commandIntakeStore, "nextAttemptAt", () => NOW - 7_200_000);
  await storage.setAlarm(NOW + 500);
  const getAlarm = storage.getAlarm.bind(storage);
  t.mock.method(storage, "getAlarm", async () => {
    const value = await getAlarm();
    now = NOW + 2_000;
    return value;
  });
  await internals.scheduleNext({ items: {}, deliveries: {} }, NOW);
  assert.equal(await getAlarm(), NOW + 3_000);
});
