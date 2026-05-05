import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LIVE_WORKERS,
  listActiveWorkflowRuns,
  normalizeWorkflowRun,
  readMaxLiveWorkers,
  repairRunNameForJob,
  repairRunNamePrefixForJob,
} from "../../dist/repair/live-worker-capacity.js";

test("live worker capacity refuses limits above the global Codex cap", () => {
  assert.equal(MAX_LIVE_WORKERS, 100);
  assert.equal(readMaxLiveWorkers({ "max-live-workers": "100" }), 100);
  assert.throws(
    () => readMaxLiveWorkers({ "max-live-workers": "101" }),
    /max-live-workers must be <= 100/,
  );
});

test("live worker capacity accepts env default within the global Codex cap", () => {
  const previous = process.env.CLAWSWEEPER_MAX_LIVE_WORKERS;
  process.env.CLAWSWEEPER_MAX_LIVE_WORKERS = "75";
  try {
    assert.equal(readMaxLiveWorkers(), 75);
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_MAX_LIVE_WORKERS;
    else process.env.CLAWSWEEPER_MAX_LIVE_WORKERS = previous;
  }
});

test("repair run names match workflow dispatch titles", () => {
  assert.equal(
    repairRunNameForJob("jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md"),
    "automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
  );
  assert.equal(repairRunNamePrefixForJob("jobs/openclaw/inbox/cluster-abc.md"), "repair cluster ");
  assert.equal(
    repairRunNameForJob("jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md", "auto "),
    "auto jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
  );
  assert.equal(
    repairRunNameForJob(
      "jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
      "automerge repair",
    ),
    "automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
  );
});

test("workflow run normalization prefers the human Actions URL", () => {
  const run = normalizeWorkflowRun(
    {
      id: 123,
      status: "queued",
      url: "https://api.github.com/repos/openclaw/clawsweeper/actions/runs/123",
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/123",
      display_title: "automerge repair jobs/openclaw/inbox/a.md",
    },
    "queued",
  );
  assert.equal(run.url, "https://github.com/openclaw/clawsweeper/actions/runs/123");
});

test("active workflow runs are filtered from one recent-runs fetch", () => {
  const calls = [];
  const runs = listActiveWorkflowRuns({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster.yml",
    runNamePrefix: "repair cluster ",
    excludeRunNamePrefix: "repair cluster skip",
    fetchWorkflowRuns: ({ repo, workflow }) => {
      calls.push({ repo, workflow });
      return [
        {
          id: 1,
          status: "completed",
          display_title: "repair cluster completed",
          created_at: "2026-05-05T00:04:00.000Z",
        },
        {
          id: 2,
          status: "queued",
          display_title: "repair cluster older.md",
          created_at: "2026-05-05T00:01:00.000Z",
        },
        {
          id: 3,
          status: "in_progress",
          display_title: "repair cluster newer.md",
          created_at: "2026-05-05T00:03:00.000Z",
        },
        {
          id: 4,
          status: "waiting",
          display_title: "repair cluster skip this.md",
          created_at: "2026-05-05T00:05:00.000Z",
        },
        {
          id: 5,
          status: "requested",
          display_title: "automerge repair jobs/openclaw/inbox/pr.md",
          created_at: "2026-05-05T00:02:00.000Z",
        },
      ];
    },
  });

  assert.deepEqual(calls, [{ repo: "openclaw/clawsweeper", workflow: "repair-cluster.yml" }]);
  assert.deepEqual(
    runs.map((run) => run.databaseId),
    [3, 2],
  );
});
