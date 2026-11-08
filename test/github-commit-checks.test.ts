import assert from "node:assert/strict";
import test from "node:test";
import { readCommitChecks } from "../dist/github-commit-checks.js";
import { createApplyGuardActivity } from "../dist/clawsweeper-apply-guard-activity.js";

// openclaw/openclaw PR heads routinely carry 100-250 check runs (#194898 had 231).
function fakeChecks(total: number, latest: { index: number; completedAt: string }) {
  const runs = Array.from({ length: total }, (_, index) => ({
    name: `check-${index}`,
    conclusion: "success",
    completed_at: index === latest.index ? latest.completedAt : "2026-01-01T00:00:00Z",
  }));
  return (path: string): unknown => {
    const page = Number(new URL(`https://x/${path}`).searchParams.get("page") ?? "1");
    if (path.includes("/check-runs")) {
      return { total_count: total, check_runs: runs.slice((page - 1) * 100, page * 100) };
    }
    if (path.includes("/status")) return { state: "success", total_count: 0, statuses: [] };
    if (path.includes("/actions/runs?")) return { workflow_runs: [] };
    throw new Error(`unexpected ${path}`);
  };
}

test("commit checks read every page of check runs", () => {
  const read = fakeChecks(231, { index: 230, completedAt: "2026-11-01T00:00:00Z" });
  const requested: string[] = [];
  const checks = readCommitChecks({
    repository: "openclaw/openclaw",
    sha: "a".repeat(40),
    readPages: (paths) => {
      requested.push(...paths);
      return paths.map(read);
    },
  });
  assert.equal(checks.complete, true);
  assert.equal(checks.checkRuns.length, 231);
  assert.equal(requested.filter((path) => path.includes("/check-runs")).length, 3);
});

test("commit checks report an inconsistent page set as incomplete", () => {
  const checks = readCommitChecks({
    repository: "openclaw/openclaw",
    sha: "a".repeat(40),
    readPages: (paths) =>
      paths.map((path) =>
        path.includes("/check-runs")
          ? {
              total_count: 150,
              check_runs: path.includes("page=1") ? Array.from({ length: 100 }, () => ({})) : [],
            }
          : { state: "success", total_count: 0, statuses: [] },
      ),
  });
  assert.equal(checks.complete, false);
});

test("close guards see check activity beyond the first page of check runs", () => {
  // Before: only the first 100 runs were read, so a recent run on page 3 was
  // invisible and a PR with fresh CI activity could be treated as inactive.
  const recent = "2026-11-07T00:00:00Z";
  const read = fakeChecks(231, { index: 230, completedAt: recent });
  const activity = createApplyGuardActivity({
    targetRepo: () => "openclaw/openclaw",
    ghPaged: () => [],
    ghJson: (args: string[]) => {
      const path = args[1]!;
      if (path === "repos/openclaw/openclaw/pulls/7") {
        return { state: "open", head: { sha: "head-sha" }, created_at: "2026-01-01T00:00:00Z" };
      }
      return read(path);
    },
  } as never);
  const live = activity.pullRequestLiveActivity(7);
  assert.equal(live.headStatusActivityAtMs, Date.parse(recent));
});
