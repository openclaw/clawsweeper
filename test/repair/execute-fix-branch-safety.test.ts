import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { branchPushes, runExecuteFixFixture } from "./execute-fix-cli-fixture.ts";

const skip = process.platform === "win32";
const movedHead = "f".repeat(40);

test("stale planning head blocks the repair before any target checkout", { skip }, (t) => {
  const run = runExecuteFixFixture(t, { pulls: [{ head: { sha: movedHead } }] });

  assert.equal(run.status, 1, run.output);
  assert.equal(run.report.status, "blocked");
  assert.deepEqual(
    {
      status: run.report.actions[0].status,
      expected: run.report.actions[0].expected_head_sha,
      current: run.report.actions[0].current_head_sha,
      requeue: run.report.actions[0].requeue_required,
    },
    { status: "blocked", expected: run.sourceHead, current: movedHead, requeue: true },
  );
  assert.deepEqual(run.gitCalls, []);
});

test("repair rechecks the planned head on the PR object it checks out", { skip }, (t) => {
  const run = runExecuteFixFixture(t, { pulls: [{}, { head: { sha: movedHead } }] });

  assert.equal(run.status, 1, run.output);
  const outcome = run.report.actions.at(-1);
  assert.equal(outcome.action, "repair_contributor_branch");
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.expected_head_sha, run.sourceHead);
  assert.equal(outcome.current_head_sha, movedHead);
  assert.equal(outcome.requeue_required, true);
  assert.equal(
    run.gitCalls.some((call) => call.args.some((arg) => arg.includes("refs/pull/1/head"))),
    false,
  );
});

for (const [name, live, reason, requeue] of [
  [
    "a moved head",
    { head: { sha: movedHead } },
    /changed during the repair settle window; requeue against the latest head/,
    true,
  ],
  ["a closed PR", { state: "closed" }, /is closed after the repair settle window/, undefined],
] as const) {
  test(`repair push settle blocks ${name} before the branch push`, { skip }, (t) => {
    const run = runExecuteFixFixture(t, {
      headRepo: "openclaw/fixture",
      pulls: [{}, {}, live],
    });

    assert.equal(run.status, requeue ? 1 : 0, run.output);
    const outcome = run.report.actions.at(-1);
    assert.equal(outcome.status, "blocked");
    assert.match(outcome.reason, reason);
    assert.equal(outcome.requeue_required, requeue);
    assert.deepEqual(branchPushes(run.gitCalls), []);
    assert.equal(run.remoteGit("rev-parse", "refs/heads/contributor"), run.sourceHead);
  });
}

test("repair publication pushes the accepted commit through isolated Git auth", { skip }, (t) => {
  const run = runExecuteFixFixture(t, { headRepo: "openclaw/fixture" });

  assert.equal(run.status, 0, run.output);
  const outcome = run.report.actions.at(-1);
  assert.equal(outcome.status, "pushed", JSON.stringify(run.report));
  const [push, ...extra] = branchPushes(run.gitCalls);
  assert.deepEqual(extra, []);
  assert.deepEqual(push.args.slice(-4), [
    "--no-verify",
    `--force-with-lease=refs/heads/contributor:${run.sourceHead}`,
    "https://github.com/openclaw/fixture.git",
    `${outcome.commit}:contributor`,
  ]);
  assert.ok(push.args.some((arg) => arg.startsWith("--git-dir=")));
  assert.equal(push.askpass, true);
  assert.equal(push.token, "fixture-token");
  assert.equal(run.remoteGit("rev-parse", "refs/heads/contributor"), outcome.commit);
  assert.equal(run.git("merge-base", run.baseSha, outcome.commit), run.baseSha);
});

test("merged source replacement skips before any replacement push or PR", { skip }, (t) => {
  const run = runExecuteFixFixture(t, {
    prView: { state: "MERGED", mergedAt: "2026-07-01T00:00:00Z" },
    setup: ({ git }) => git("cherry-pick", "main..contributor"),
  });

  assert.equal(run.status, 0, run.output);
  const outcome = run.report.actions.at(-1);
  assert.equal(outcome.action, "open_fix_pr");
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.merged_source_pr, "#1");
  assert.equal(
    outcome.reason,
    "source PR already merged and replacement branch has no changes versus base",
  );
  assert.deepEqual(
    branchPushes(run.gitCalls).map((call) => call.args.at(-2)),
    ["https://github.com/contributor/fixture.git"],
  );
  assert.deepEqual(run.publications, []);
});

test(
  "issue implementation runs sandboxed Codex and rechecks opt-out labels before the push",
  { skip },
  (t) => {
    const run = runExecuteFixFixture(t, {
      clusterId: "issue-fixture-7",
      source: "issue_implementation",
      jobFields: ["source_issue_repo: openclaw/fixture", "source_issue_number: 7"],
      fixArtifact: {
        repair_strategy: "new_fix_pr",
        source_prs: [],
        deterministic_rebase_only: false,
      },
      issue: { number: 7, state: "open", labels: ["clawsweeper:bulk-filed"] },
      codex: `if (!ctx.review) ctx.fs.writeFileSync("CONTRIBUTING.md", "Implemented.\\n");`,
      env: { GITHUB_ACTIONS: "true" },
    });

    // Inside Actions only the edit worker gets write access; review stays read-only.
    assert.deepEqual(
      run.codexCalls.map((call) => call.args[call.args.indexOf("--sandbox") + 1]),
      ["danger-full-access", "read-only"],
    );
    assert.deepEqual(
      fs
        .readdirSync(run.workRoot)
        .filter((name) => /\.(?:jsonl|stderr\.log)$/.test(name))
        .sort(),
      [
        "replacement-codex-1.jsonl",
        "replacement-codex-1.stderr.log",
        "replacement-codex-review-1.jsonl",
        "replacement-codex-review-1.stderr.log",
      ],
    );
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /is bulk-filed; refusing to push or open an automatic PR/);
    assert.deepEqual(branchPushes(run.gitCalls), []);
    assert.deepEqual(run.publications, []);
  },
);
