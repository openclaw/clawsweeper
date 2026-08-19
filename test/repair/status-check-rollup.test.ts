import assert from "node:assert/strict";
import test from "node:test";

import { rollUpStatusChecks } from "../../dist/repair/status-check-rollup.js";

test("rollup matches check identities and ignored names case-insensitively", () => {
  const rolledUp = rollUpStatusChecks(
    [
      {
        name: "UNIT",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: "2026-08-10T10:00:00Z",
      },
      {
        name: "unit",
        workflowName: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-10T11:00:00Z",
      },
    ],
    " cI ",
  );

  assert.equal(rolledUp.length, 1);
  assert.equal(rolledUp[0]?.check.conclusion, "SUCCESS");
  assert.equal(rolledUp[0]?.ignored, true);
});

test("rollup uses run start or creation time before completion time", () => {
  for (const timestampFields of [
    ["startedAt", "completedAt"],
    ["started_at", "completed_at"],
    ["createdAt", "completedAt"],
    ["created_at", "completed_at"],
  ]) {
    const [primaryField, completedField] = timestampFields;
    const rolledUp = rollUpStatusChecks(
      [
        {
          name: "unit",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          [primaryField]: "2026-08-10T10:00:00Z",
          [completedField]: "2026-08-10T12:00:00Z",
        },
        {
          name: "unit",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          [primaryField]: "2026-08-10T11:00:00Z",
          [completedField]: "2026-08-10T11:05:00Z",
        },
      ],
      "",
    );

    assert.equal(rolledUp[0]?.check.conclusion, "SUCCESS", primaryField);
  }
});

test("rollup keeps an untimestamped pending rerun ahead of a completed run", () => {
  const rolledUp = rollUpStatusChecks(
    [
      {
        name: "unit",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-10T10:00:00Z",
      },
      {
        name: "unit",
        workflowName: "CI",
        status: "QUEUED",
        conclusion: null,
      },
    ],
    "",
  );

  assert.equal(rolledUp[0]?.check.status, "QUEUED");
});
