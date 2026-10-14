import assert from "node:assert/strict";
import test from "node:test";

import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS } from "../dashboard/github-webhook-read-model.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const repository = "example/project";
const table = "github_webhook_read_model_items_v1";

function request(route: string, body = {}) {
  return new Request(`https://queue.invalid/${route}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function delivery(now: number, count = 70) {
  const old = now - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS - 1;
  return {
    version: 1,
    deliveryId: "old-payloads",
    event: "issues",
    action: "opened",
    receivedAt: new Date(old).toISOString(),
    eventClasses: ["issues"],
    objects: Array.from({ length: count }, (_, index) => ({
      kind: "item",
      repository,
      number: index + 1,
      itemKind: "issue",
      sourceUpdatedAt: new Date(old).toISOString(),
      snapshot: { number: index + 1, body: "old payload" },
    })),
  };
}

test("idle queue alarms drain payloads, restart from persisted deadlines, and stop when done", async () => {
  const storage = new TestStorage();
  let queue = new ExactReviewQueue({ storage }, {});
  const now = Date.now();
  const body = delivery(now);
  assert.equal((await queue.fetch(request("github-read-model/ingest", body))).status, 202);
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${table}`), 0);
  assert.ok((await storage.getAlarm())! >= now);
  await storage.deleteAlarm();
  queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request("admission-capabilities"));
  assert.ok((await storage.getAlarm())! >= now);
  await queue.alarm();
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${table}`), 64);
  assert.ok((await storage.getAlarm())! >= now);
  await queue.alarm();
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${table}`), 70);
  assert.equal(await storage.getAlarm(), null);
});

test("duplicate ingress rearms a committed write after alarm scheduling failure", async () => {
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request("admission-capabilities"));
  const setAlarm = storage.setAlarm.bind(storage);
  storage.setAlarm = async () => {
    throw new Error("alarm unavailable");
  };
  const body = delivery(Date.now(), 1);
  await assert.rejects(queue.fetch(request("github-read-model/ingest", body)), /alarm unavailable/);
  assert.equal(storage.scalar(`SELECT COUNT(*) AS value FROM ${table}`), 1);
  storage.setAlarm = setAlarm;
  const response = await queue.fetch(request("github-read-model/ingest", body));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).deduped, true);
  assert.ok(await storage.getAlarm());
});

test("payload maintenance preserves an earlier alarm and arms fresh repair deadlines", async () => {
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(request("admission-capabilities"));
  const earlier = Date.now() + 500;
  await storage.setAlarm(earlier);
  assert.equal(
    (await queue.fetch(request("github-read-model/ingest", delivery(Date.now(), 1)))).status,
    202,
  );
  assert.equal(await storage.getAlarm(), earlier);
  await queue.alarm();
  assert.equal(await storage.getAlarm(), null);
  const at = Date.now();
  assert.equal(
    (
      await queue.fetch(
        request("github-read-model/repair", {
          repository,
          repair_kind: "comments",
          objects: delivery(at, 1).objects,
          complete_comment_items: [1],
        }),
      )
    ).status,
    202,
  );
  assert.ok((await storage.getAlarm())! >= at + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS);
});
