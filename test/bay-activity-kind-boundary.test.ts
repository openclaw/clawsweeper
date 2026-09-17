import assert from "node:assert/strict";
import test from "node:test";
import {
  publicBayActiveTargetsForTest,
  composePublicBayActivityForTest,
} from "../dashboard/worker.ts";

test("public Bay carries observed repair identity independently of the checks lane", () => {
  const base = {
    repository: "openclaw/openclaw",
    started_at: "2026-09-17T12:00:00Z",
    status: "in_progress",
    current_step: "Run tests",
  };
  const active = publicBayActiveTargetsForTest([
    { ...base, item_number: 1, mode: "exact-review", work_kind: "other" },
    { ...base, item_number: 2, mode: "automerge", work_kind: "pr_repair" },
    { ...base, item_number: 3, activity_kind: "repair" },
    { ...base, repository: "private-owner/private-repo", item_number: 4, mode: "repair" },
  ]);
  assert.equal(active.complete, true);
  assert.deepEqual(
    active.items.slice(0, 3).map((item) => item.activity_kind),
    ["review", "repair", undefined],
  );
  assert.ok(active.items.every((item) => item.stage === "repairing"));
  const zero = {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  };
  const projected = composePublicBayActivityForTest(
    { complete: true, stages: zero, active_overlaps: zero, items: [] },
    active,
  );
  assert.equal(projected.complete, true);
  assert.deepEqual(
    projected.items?.map((item) => item.activity_kind),
    ["review", "repair", undefined],
  );
  assert.doesNotMatch(JSON.stringify(projected), /private-owner|private-repo/);
});

test("activity identity is discarded from queue references and unknown live categories", () => {
  const zero = {
    arriving: 0,
    "setting-up": 0,
    reviewing: 0,
    publishing: 0,
    applying: 0,
    repairing: 0,
  };
  const active = publicBayActiveTargetsForTest([]);
  const projection = {
    complete: true,
    stages: { ...zero, repairing: 1 },
    active_overlaps: zero,
    items: [
      {
        repository: "openclaw/openclaw",
        item_number: 120887,
        stage: "repairing",
        source: "queue",
        activity_kind: "repair",
      },
    ],
  };
  const projected = composePublicBayActivityForTest(projection, active);
  assert.equal(projected.items?.[0].activity_kind, undefined);
  const invalid = {
    ...active,
    items: [
      {
        repository: "openclaw/openclaw",
        item_number: 2,
        stage: "repairing",
        source: "live",
        activity_kind: "private/raw",
      },
    ],
  };
  const clean = composePublicBayActivityForTest(
    { complete: true, stages: zero, active_overlaps: zero, items: [] },
    invalid,
  );
  assert.equal(JSON.stringify(clean).includes("private/raw"), false);
});
