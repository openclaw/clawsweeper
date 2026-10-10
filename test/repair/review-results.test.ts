import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const updatedAt = "2026-05-25T00:00:00Z";

function reviewActions(actions: Record<string, unknown>[]) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-review-results-"));
  try {
    fs.writeFileSync(
      path.join(runDir, "cluster-plan.json"),
      JSON.stringify({
        item_matrix: [101, 202, 303].map((number) => ({
          ref: `#${number}`,
          kind: "pull_request",
          state: "open",
          updated_at: updatedAt,
        })),
      }),
    );
    fs.writeFileSync(
      path.join(runDir, "result.json"),
      JSON.stringify({
        repo: "openclaw/openclaw",
        cluster_id: "review-results-typed",
        mode: "autonomous",
        status: "planned",
        actions: actions.map((action) => ({
          target_kind: "pull_request",
          target_updated_at: updatedAt,
          idempotency_key: `key-${String(action.target)}`,
          evidence: ["Hydrated preflight shows the same change."],
          ...action,
        })),
      }),
    );
    const child = spawnSync(process.execPath, ["dist/repair/review-results.js", runDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return JSON.parse(child.stdout).reports[0];
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

test("review gate reads typed action fields instead of prose wording", () => {
  const report = reviewActions([
    {
      target: "#101",
      action: "close_duplicate",
      status: "blocked",
      classification: "duplicate",
      canonical: "#202",
      comment: "Closing this one.",
      reason: "Held.",
    },
    {
      target: "#303",
      action: "close_superseded",
      status: "planned",
      classification: "superseded",
      canonical: "#202",
      comment: "Closing this one.",
      reason: "Same change.",
    },
    {
      target: "#999",
      action: "needs_human",
      status: "blocked",
      classification: "needs_human",
      target_kind: null,
      target_updated_at: null,
      reason: "Maintainer decision needed.",
    },
  ]);

  assert.deepEqual(report.failures, []);
  assert.equal(report.status, "passed");
});

test("review gate rejects needs_human with security_sensitive classification", () => {
  const report = reviewActions([
    {
      target: "#101",
      action: "needs_human",
      status: "blocked",
      classification: "security_sensitive",
      reason: "Maintainer decision needed.",
    },
  ]);

  assert.equal(report.status, "failed");
  assert.ok(
    report.failures.includes(
      "#101 security routing must use route_security instead of needs_human",
    ),
  );
});
