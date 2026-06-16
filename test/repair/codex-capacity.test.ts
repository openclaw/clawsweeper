import assert from "node:assert/strict";
import test from "node:test";

import {
  exactReviewAdmission,
  fetchActiveExactReviewRuns,
  type CapacityRun,
  type CodexCapacitySnapshot,
} from "../../dist/repair/codex-capacity.js";

test("exact review admission lets the oldest configured waiters proceed", () => {
  const snapshot = capacitySnapshot([
    exactRun(102, "2026-06-15T12:00:02Z"),
    exactRun(100, "2026-06-15T12:00:00Z"),
    exactRun(101, "2026-06-15T12:00:01Z"),
  ]);

  assert.equal(
    exactReviewAdmission({
      currentRunId: 101,
      snapshot,
      exactLimit: 2,
    }).proceed,
    true,
  );
  const blocked = exactReviewAdmission({
    currentRunId: 102,
    snapshot,
    exactLimit: 2,
  });
  assert.equal(blocked.proceed, false);
  assert.equal(blocked.current_rank, 3);
});

test("exact review admission fails closed when the current run is absent", () => {
  assert.throws(
    () =>
      exactReviewAdmission({
        currentRunId: 200,
        snapshot: capacitySnapshot([exactRun(201, "2026-06-15T12:00:00Z")]),
        exactLimit: 4,
      }),
    /current exact-review run 200 was not found/,
  );
});

test("cancelled or completed exact runs disappear without lease recovery", () => {
  const snapshot = capacitySnapshot([
    exactRun(401, "2026-06-15T12:00:01Z"),
    exactRun(402, "2026-06-15T12:00:02Z"),
  ]);
  const admission = exactReviewAdmission({
    currentRunId: 402,
    snapshot,
    exactLimit: 1,
  });
  assert.equal(admission.current_rank, 2);
  assert.equal(admission.proceed, false);

  const afterCancellation = capacitySnapshot([exactRun(402, "2026-06-15T12:00:02Z")]);
  assert.equal(
    exactReviewAdmission({
      currentRunId: 402,
      snapshot: afterCancellation,
      exactLimit: 1,
    }).proceed,
    true,
  );
});

test("workflow-scoped fetch accepts dynamic Actions run names", () => {
  const runs = fetchActiveExactReviewRuns("openclaw/clawsweeper", (args) => {
    const query = new URL(`https://github.test/${args[3]}`).searchParams;
    if (query.get("status") !== "in_progress") return [];
    return [
      exactApiRun(500, "2026-06-15T12:00:00Z"),
      {
        id: 501,
        name: "Review target repo openclaw/openclaw",
        display_title: "Review target repo openclaw/openclaw",
        status: "in_progress",
        created_at: "2026-06-15T12:00:01Z",
      },
    ];
  });

  assert.deepEqual(
    runs.map((run) => run.databaseId),
    [500],
  );
});

test("exact review run fetch paginates until the oldest active page", () => {
  const calls: { status: string; page: number }[] = [];
  const runs = fetchActiveExactReviewRuns("openclaw/clawsweeper", (args) => {
    const query = new URL(`https://github.test/${args[3]}`).searchParams;
    const status = query.get("status") ?? "";
    const page = Number(query.get("page"));
    calls.push({ status, page });
    if (status !== "in_progress") return [];
    if (page <= 2) {
      return Array.from({ length: 100 }, (_, index) =>
        exactApiRun(page * 100 + index, `2026-06-15T12:00:${page}Z`),
      );
    }
    if (page === 3) return [exactApiRun(1, "2026-06-15T11:00:00Z")];
    return [];
  });

  assert.equal(runs.length, 201);
  assert.deepEqual(
    calls.filter((call) => call.status === "in_progress"),
    [
      { status: "in_progress", page: 1 },
      { status: "in_progress", page: 2 },
      { status: "in_progress", page: 3 },
    ],
  );
  assert.equal(
    runs.some((run) => run.databaseId === 1),
    true,
  );
});

function capacitySnapshot(runs: CapacityRun[]): CodexCapacitySnapshot {
  return { runs };
}

function exactApiRun(databaseId: number, createdAt: string) {
  return {
    id: databaseId,
    name: `Review event item openclaw/openclaw#${databaseId}`,
    display_title: `Review event item openclaw/openclaw#${databaseId}`,
    status: "in_progress",
    created_at: createdAt,
  };
}

function exactRun(databaseId: number, createdAt: string): CapacityRun {
  return {
    databaseId,
    displayTitle: `Review event item openclaw/openclaw#${databaseId}`,
    status: "in_progress",
    createdAt,
  };
}
