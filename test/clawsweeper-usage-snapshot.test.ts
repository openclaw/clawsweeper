import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsageSnapshotFromJsonl,
  parseCliArgs,
} from "../scripts/clawsweeper-usage-snapshot.ts";

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    surface: "clawsweeper",
    emitted_at: "2026-05-18T10:00:00.000Z",
    workflow: "sweep",
    mode: "review",
    phase: "item-review",
    target_repo: "openclaw/openclaw",
    item_number: 123,
    model: "gpt-5.1-codex-max",
    github_run_id: "1000",
    status: "success",
    tokens: { input: 10, cache_read: 20, output: 5, reasoning_output: 2, total: 37 },
    ...overrides,
  });
}

test("buildUsageSnapshotFromJsonl prints aggregate-only last-48h usage", () => {
  const snapshot = buildUsageSnapshotFromJsonl(
    [
      {
        path: "usage-events.jsonl",
        contents: [
          event(),
          event({
            emitted_at: "2026-05-18T09:00:00.000Z",
            workflow: "repair-worker",
            mode: "plan",
            phase: "primary",
            target_repo: "openclaw/clawhub",
            item_number: null,
            job_path: "records/openclaw/jobs/job-1.md",
            model: "gpt-5.1-codex-mini",
            github_run_id: "1001",
            status: "timeout",
            tokens: { input: 100, cache_read: 0, output: 10, reasoning_output: 0, total: 110 },
            prompt: "must not leak",
            output: "must not leak",
            transcript: "must not leak",
            issue_body: "must not leak",
          }),
          event({
            emitted_at: "2026-05-15T10:00:00.000Z",
            tokens: { input: 999, cache_read: 0, output: 0, reasoning_output: 0, total: 999 },
          }),
          "not json",
        ].join("\n"),
      },
    ],
    { now: new Date("2026-05-18T10:30:00.000Z"), sinceHours: 48, limit: 5 },
  );

  assert.equal(snapshot.files_read, 1);
  assert.equal(snapshot.events_read, 3);
  assert.equal(snapshot.events_in_window, 2);
  assert.deepEqual(snapshot.totals, {
    calls: 2,
    input: 110,
    output: 15,
    cache_read: 20,
    reasoning_output: 2,
    total: 147,
  });
  assert.equal(snapshot.by_workflow.sweep?.total, 37);
  assert.equal(snapshot.by_workflow["repair-worker"]?.total, 110);
  assert.equal(snapshot.by_target_repo["openclaw/openclaw"]?.total, 37);
  assert.equal(snapshot.by_model["gpt-5.1-codex-mini"]?.total, 110);
  assert.equal(snapshot.failed_or_timeout["timeout|repair-worker"]?.total, 110);
  assert.deepEqual(snapshot.largest_invocations[0], {
    calls: 1,
    input: 100,
    output: 10,
    cache_read: 0,
    reasoning_output: 0,
    total: 110,
    emitted_at: "2026-05-18T09:00:00.000Z",
    workflow: "repair-worker",
    mode: "plan",
    phase: "primary",
    target_repo: "openclaw/clawhub",
    item: "job:records/openclaw/jobs/job-1.md",
    model: "gpt-5.1-codex-mini",
    github_run_id: "1001",
    status: "timeout",
  });
  assert.equal(JSON.stringify(snapshot).includes("must not leak"), false);
});

test("parseCliArgs defaults to a 48h current-directory snapshot", () => {
  const options = parseCliArgs([], new Date("2026-05-18T00:00:00.000Z"));

  assert.equal(options.sinceHours, 48);
  assert.equal(options.limit, 10);
  assert.deepEqual(options.paths, ["."]);
});

test("parseCliArgs accepts explicit window, limit, now, and paths", () => {
  const options = parseCliArgs(
    ["--since-hours", "24", "--limit", "3", "--now", "2026-05-18T00:00:00.000Z", "artifacts"],
    new Date("2026-05-19T00:00:00.000Z"),
  );

  assert.equal(options.sinceHours, 24);
  assert.equal(options.limit, 3);
  assert.equal(options.now.toISOString(), "2026-05-18T00:00:00.000Z");
  assert.deepEqual(options.paths, ["artifacts"]);
});
