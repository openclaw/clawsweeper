import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_WEBHOOK_READ_MODEL_PLACEHOLDER_REPAIR_TTL_MS,
  GithubWebhookReadModelStore,
} from "../dashboard/github-webhook-read-model.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const repository = "example/project";
const now = Date.parse("2026-10-13T10:00:00Z");
const marker = "ClawSweeper status: review started.";
type Row = Record<string, unknown>;
type Storage = ConstructorParameters<typeof GithubWebhookReadModelStore>[0];
type Candidate = { number: number; item: Row; comments: Row[] };

function scriptedStore(rows: Iterable<Row>) {
  const storage: Storage = {
    sql: {
      exec(query) {
        if (query.includes("SELECT c.number")) return rows;
        if (query.includes("SELECT repaired_at")) return [{ repaired_at: now, watermark: 1 }];
        if (query.includes("SELECT delivery_count")) {
          return [{ delivery_count: 1, last_delivery_at: now }];
        }
        if (query.includes("SELECT created_at")) return [{ created_at: now }];
        if (query.includes("SELECT watermark")) return [{ watermark: 1 }];
        throw new Error(`unexpected query: ${query}`);
      },
    },
    transactionSync: (callback) => callback(),
  };
  return new GithubWebhookReadModelStore(storage);
}

function row(number: number, comment: Row, item: Row = { state: "open" }): Row {
  return {
    number,
    item_number: number,
    item_pruned: 0,
    snapshot_json: JSON.stringify(comment),
    item_json: JSON.stringify(item),
    item_kind: "issue",
  };
}

test("placeholder discovery processes a lazy cursor and drains late selected comments", async () => {
  const trace: string[] = [];
  const itemReads = new Map<number, number>();
  const input = [
    row(1, { id: 1, body: "ordinary comment" }),
    row(2, { id: 2, body: marker }, { state: "closed" }),
    row(3, { id: 3, body: marker, updated_at: "2026-10-13T06:00:00Z" }),
    row(4, { id: 4, body: marker, user: { login: "visitor", type: "User" } }),
    row(5, { id: 5, body: marker }),
    row(3, {
      id: 6,
      body: `${marker}\n<!-- clawsweeper-review-status:started item=3 v=1 -->`,
      updated_at: "2026-10-13T09:59:00Z",
    }),
    row(4, { id: 7, body: marker }),
    row(3, {
      id: 8,
      body: `${marker}\n<!-- clawsweeper-review-status:started item=3 v=1 -->`,
      updated_at: "2026-10-13T09:59:00Z",
    }),
    row(3, { id: 9, body: marker, updated_at: "2026-10-13T10:00:00Z" }),
  ];
  const rows = {
    *[Symbol.iterator]() {
      for (const [index, value] of input.entries()) {
        if (index > 0) assert.equal(trace.at(-1), `parse:${index - 1}`);
        trace.push(`yield:${index}`);
        yield {
          ...value,
          get snapshot_json() {
            trace.push(`parse:${index}`);
            return value.snapshot_json;
          },
          get item_json() {
            const number = Number(value.number);
            itemReads.set(number, (itemReads.get(number) ?? 0) + 1);
            assert.notEqual(number, 5, "unselected groups must not be materialized");
            return value.item_json;
          },
        };
      }
      trace.push("drained");
    },
  };
  const result = await scriptedStore(rows).readPlaceholders(
    { repository, state: "open", limit: 2 },
    now,
  );
  const candidates = result.candidates as Candidate[];
  assert.equal(result.usable, true);
  assert.deepEqual(
    candidates.map((candidate) => candidate.number),
    [3, 4],
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.comments.map((comment) => comment.id)),
    [
      [3, 6, 8, 9],
      [4, 7],
    ],
  );
  assert.equal(candidates[0].comments[1].updated_at, "2026-10-13T09:59:00Z");
  assert.equal(itemReads.get(3), 1);
  assert.equal(itemReads.get(4), 1);
  assert.equal(trace.at(-1), "drained");
});

test("placeholder discovery preserves coercion and malformed-value behavior", async () => {
  const malformed = { number: 1, snapshot_json: "{", item_json: "{", item_kind: "issue" };
  const result = await scriptedStore([
    malformed,
    row(2, { body: null }),
    row(3, { body: [marker] }, { state: ["open"] }),
    row(4, { body: marker }, { state: "OPEN" }),
    row(5, { body: marker }, { state: "closed" }),
  ]).readPlaceholders({ repository, state: "open", limit: 2 }, now);
  assert.deepEqual(
    (result.candidates as Candidate[]).map((candidate) => candidate.number),
    [3, 4],
  );
  await assert.rejects(
    scriptedStore([]).readPlaceholders(null, now),
    /invalid_.*placeholders_request/,
  );
  await assert.rejects(
    scriptedStore([]).readPlaceholders({ repository, state: "invalid" }, now),
    /invalid_.*placeholders_request/,
  );
});

test("placeholder discovery still detects parent gaps after reaching its group limit", async () => {
  for (const parent of [
    { item_number: null, item_pruned: null },
    { item_number: 2, item_pruned: 1 },
  ]) {
    const result = await scriptedStore([
      row(1, { id: 1, body: marker }),
      { ...row(2, { id: 2, body: marker }), ...parent },
      row(1, { id: 3, body: marker }),
    ]).readPlaceholders({ repository, state: "open", limit: 1 }, now);
    assert.equal(result.usable, false);
    assert.equal(result.gap_detected, true);
    assert.deepEqual(
      (result.candidates as Candidate[]).map((candidate) => candidate.comments.map(({ id }) => id)),
      [[1, 3]],
    );
  }
});

for (const [limit, expected] of [
  [undefined, 100],
  [0, 100],
  [1, 1],
  [1_500, 1_000],
] as const) {
  test(`placeholder discovery retains the existing limit policy (${limit})`, async () => {
    let visited = 0;
    const rows = {
      *[Symbol.iterator]() {
        for (let number = 1; number <= 1_001; number += 1) {
          visited += 1;
          yield row(number, { id: number, body: marker });
        }
        yield row(1, { id: 2_000, body: marker });
      },
    };
    const result = await scriptedStore(rows).readPlaceholders(
      { repository, state: "open", limit },
      now,
    );
    const candidates = result.candidates as Candidate[];
    assert.equal(candidates.length, expected);
    assert.equal(visited, 1_001);
    assert.deepEqual(
      candidates[0].comments.map((comment) => comment.id),
      [1, 2_000],
    );
  });
}

test("SQLite placeholder discovery preserves group order, isolation, kind, and freshness", async () => {
  const storage = new TestStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  store.ingest(
    {
      version: 1,
      deliveryId: "observed",
      event: "issue_comment",
      action: "created",
      receivedAt: new Date(now).toISOString(),
      eventClasses: ["issue_comments"],
      objects: [],
    },
    now,
  );
  store.repair({ repository, repair_kind: "placeholders", objects: [] }, now);
  for (const [number, state, kind] of [
    [1, "open", "pull_request"],
    [2, "closed", "issue"],
    [3, "open", "issue"],
    [4, "open", "issue"],
  ] as const) {
    storage.run(
      `INSERT INTO github_webhook_read_model_items_v1
         (repository, number, item_kind, source_updated_at, snapshot_json, delivery_id, watermark, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      repository,
      number,
      kind,
      now,
      JSON.stringify({ number, state }),
      "fixture",
      1,
      now,
    );
  }
  storage.run(
    `INSERT INTO github_webhook_read_model_items_v1
       (repository, number, item_kind, source_updated_at, snapshot_json, delivery_id, watermark, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    "other/project",
    1,
    "issue",
    now,
    JSON.stringify({ number: 1, state: "open" }),
    "fixture",
    1,
    now,
  );
  for (const [repo, number, id, updated, body, tombstone] of [
    [repository, 3, 30, 1, "ordinary", 0],
    [repository, 2, 20, 2, marker, 0],
    [repository, 1, 10, 3, marker, 0],
    [repository, 3, 31, 3, marker, 0],
    [repository, 1, 11, 4, marker, 0],
    [repository, 4, 40, 1, marker, 1],
    ["other/project", 1, 1, 0, marker, 0],
  ] as const) {
    storage.run(
      `INSERT INTO github_webhook_read_model_comments_v1
         (repository, number, comment_id, source_updated_at, tombstone, snapshot_json, delivery_id, watermark, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      repo,
      number,
      id,
      updated,
      tombstone,
      JSON.stringify({ id, body }),
      "fixture",
      1,
      now,
    );
  }
  for (const [state, numbers] of [
    ["open", [1, 3]],
    ["closed", [2]],
    ["all", [2, 1, 3]],
  ] as const) {
    const result = await store.readPlaceholders({ repository, state, limit: 10 }, now);
    const candidates = result.candidates as Candidate[];
    assert.equal(result.usable, true);
    assert.deepEqual(
      candidates.map((candidate) => candidate.number),
      numbers,
    );
    const pull = candidates.find((candidate) => candidate.number === 1);
    if (pull) {
      assert.deepEqual(pull.item.pull_request, {});
      assert.deepEqual(
        pull.comments.map((comment) => comment.id),
        [10, 11],
      );
    }
  }
  const limited = await store.readPlaceholders({ repository, state: "all", limit: 2 }, now);
  assert.deepEqual(
    (limited.candidates as Candidate[]).map((candidate) => candidate.number),
    [2, 1],
  );
  assert.deepEqual(
    (limited.candidates as Candidate[])[1].comments.map((comment) => comment.id),
    [10, 11],
  );
  const stale = await store.readPlaceholders(
    { repository, state: "open" },
    now + GITHUB_WEBHOOK_READ_MODEL_PLACEHOLDER_REPAIR_TTL_MS + 1,
  );
  assert.equal(stale.usable, false);
  assert.deepEqual(
    stale.candidates,
    (await store.readPlaceholders({ repository, state: "open" }, now)).candidates,
  );
});
