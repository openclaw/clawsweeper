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
  await storage.deleteAlarm();
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

test("a pending alarm that becomes due during storage reads is not postponed", async (t) => {
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
  assert.equal(await getAlarm(), NOW + 500);
});

test("due stored alarms survive repeated request scheduling until delivery", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://queue/stats"));
  const internals = queue as unknown as {
    commandIntakeStore: { nextAttemptAt(): number | null };
    scheduleNext(state: { items: {}; deliveries: {} }, now: number): Promise<void>;
    scheduleSourceAuthorityVerification(next: number): Promise<void>;
  };
  t.mock.method(internals.commandIntakeStore, "nextAttemptAt", () => NOW - 7_200_000);
  await storage.setAlarm(NOW - 60_000);
  for (let i = 0; i < 20; i++) {
    now += 2000;
    await internals.scheduleNext({ items: {}, deliveries: {} }, now);
    await internals.scheduleSourceAuthorityVerification(NOW - 7_200_000);
    assert.equal(await storage.getAlarm(), NOW - 60_000);
  }
  // Once consumed or missing, the next wake is still created normally.
  await storage.deleteAlarm();
  await internals.scheduleNext({ items: {}, deliveries: {} }, now);
  assert.equal(await storage.getAlarm(), now + 1_000);
});

test("stranded-alarm recovery is bounded and never rearms an active handler", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://queue/stats"));
  const internals = queue as unknown as {
    commandIntakeStore: { nextAttemptAt(): number | null };
    scheduleNext(state: { items: {}; deliveries: {} }, now: number): Promise<void>;
    alarmInFlightAt: number | null;
    scheduleSourceAuthorityVerification(next: number): Promise<void>;
  };
  t.mock.method(internals.commandIntakeStore, "nextAttemptAt", () => NOW - 7_200_000);
  const stranded = NOW - 6 * 60_000;
  await storage.setAlarm(stranded);
  internals.alarmInFlightAt = NOW - 10_000;
  await internals.scheduleNext({ items: {}, deliveries: {} }, now);
  assert.equal(await storage.getAlarm(), stranded);
  internals.alarmInFlightAt = null;
  await Promise.all([
    internals.scheduleNext({ items: {}, deliveries: {} }, now),
    internals.scheduleNext({ items: {}, deliveries: {} }, now),
    internals.scheduleSourceAuthorityVerification(NOW - 7_200_000),
  ]);
  const recovered = await storage.getAlarm();
  assert.equal(recovered, NOW + 1_000);
  for (let i = 0; i < 10; i++) {
    now += 6 * 60_000;
    await internals.scheduleNext({ items: {}, deliveries: {} }, now);
    assert.equal(await storage.getAlarm(), recovered);
  }
});
