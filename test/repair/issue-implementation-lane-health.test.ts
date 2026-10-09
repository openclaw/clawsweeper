import assert from "node:assert/strict";
import test from "node:test";

import {
  issueImplementationLaneHealth,
  issueImplementationLaneHealthSummary,
} from "../../dist/repair/issue-implementation-lane-health.js";

const nowMs = Date.parse("2026-10-10T00:00:00Z");
const hour = 60 * 60 * 1000;

function workerRun(
  number: number,
  conclusion: string,
  {
    title = `issue implementation jobs/openclaw/inbox/issue-openclaw-openclaw-${number}.md`,
    createdMs = nowMs - hour,
    status = "completed",
  } = {},
) {
  return {
    display_title: title,
    status,
    conclusion,
    created_at: new Date(createdMs).toISOString(),
  };
}

function runs(succeeded: number, failed: number) {
  return [
    ...Array.from({ length: succeeded }, (_, index) => workerRun(index + 1, "success")),
    ...Array.from({ length: failed }, (_, index) => workerRun(1000 + index, "failure")),
  ];
}

test("lane health counts only finished issue implementation runs of the target in the last 7 days", () => {
  const health = issueImplementationLaneHealth({
    targetRepo: "openclaw/openclaw",
    nowMs,
    runs: [
      workerRun(1, "success"),
      workerRun(2, "success", {
        title: "issue implementation jobs/openclaw/inbox/issue-openclaw-openclaw-2.md [router-7]",
      }),
      workerRun(3, "failure"),
      workerRun(4, "timed_out"),
      workerRun(5, "startup_failure"),
      workerRun(6, "cancelled"),
      workerRun(7, "skipped"),
      workerRun(8, "", { status: "in_progress" }),
      workerRun(9, "failure", { createdMs: nowMs - 7 * 24 * hour - 1 }),
      workerRun(10, "failure", {
        title: "issue implementation jobs/openclaw/inbox/issue-openclaw-clawhub-10.md",
      }),
      workerRun(11, "failure", {
        title: "automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-11.md",
      }),
      workerRun(12, "failure", { title: "repair cluster jobs/openclaw/inbox/cluster-12.md" }),
    ],
  });
  assert.equal(health.succeeded_runs, 2);
  assert.equal(health.failed_runs, 3);
  assert.equal(health.success_rate_percent, 40);
  assert.equal(health.window_days, 7);
  assert.equal(health.paused, false, "five finished runs are below the minimum sample");
  assert.equal(health.notice, null);
});

test("lane health pauses below the floor once enough runs have finished", () => {
  const paused = issueImplementationLaneHealth({
    targetRepo: "openclaw/openclaw",
    nowMs,
    runs: runs(2, 8),
  });
  assert.equal(paused.success_rate_percent, 20);
  assert.equal(paused.min_success_percent, 50);
  assert.equal(paused.paused, true);
  assert.match(paused.notice ?? "", /2 of 10 finished worker runs in the last 7 days succeeded/);
  assert.match(paused.notice ?? "", /CLAWSWEEPER_AUTO_IMPLEMENT_MIN_SUCCESS_PERCENT=0/);

  assert.equal(
    issueImplementationLaneHealth({ targetRepo: "openclaw/openclaw", nowMs, runs: runs(2, 7) })
      .paused,
    false,
    "nine finished runs never pause the lane",
  );
  assert.equal(
    issueImplementationLaneHealth({ targetRepo: "openclaw/openclaw", nowMs, runs: runs(5, 5) })
      .paused,
    false,
    "a rate at the floor keeps dispatching",
  );
  assert.equal(
    issueImplementationLaneHealth({
      targetRepo: "openclaw/openclaw",
      nowMs,
      runs: runs(0, 20),
      minSuccessPercent: 0,
    }).paused,
    false,
    "a zero floor overrides the pause",
  );
  assert.equal(
    issueImplementationLaneHealth({
      targetRepo: "openclaw/openclaw",
      nowMs,
      runs: runs(8, 2),
      minSuccessPercent: 90,
    }).paused,
    true,
  );
});

test("lane health summary publishes the rate and the pause notice", () => {
  const paused = issueImplementationLaneHealth({
    targetRepo: "openclaw/openclaw",
    nowMs,
    runs: runs(2, 8),
  });
  const summary = issueImplementationLaneHealthSummary(paused);
  assert.match(summary, /Automatic issue implementation health \(openclaw\/openclaw, 7 days\)/);
  assert.match(summary, /\| 2 \| 8 \| 20% \| 50% \| paused \|/);
  assert.ok(summary.includes(paused.notice ?? "missing notice"));

  const empty = issueImplementationLaneHealthSummary(
    issueImplementationLaneHealth({ targetRepo: "openclaw/openclaw", nowMs, runs: [] }),
  );
  assert.match(empty, /\| 0 \| 0 \| n\/a \| 50% \| dispatching \|/);
  assert.doesNotMatch(empty, /paused:/);
});
