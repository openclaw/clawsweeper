import assert from "node:assert/strict";
import test from "node:test";
import { branchPushes, runExecuteFixFixture } from "./execute-fix-cli-fixture.ts";

const skip = process.platform === "win32";
const replacementBranch = "clawsweeper/automerge-fixture-1";
const replacement = { fixArtifact: { repair_strategy: "replace_uneditable_branch" } };
// The first review advances main, so the final base sync must rebase and review again.
const advanceMainDuringReview = (file: string, content: string, call = 1) =>
  `if (ctx.review && ctx.callIndex === ${call}) ctx.pushRemote("main", ${JSON.stringify(file)}, ${JSON.stringify(content)});`;

test(
  "final base sync publishes on the fetched base and reviews the synchronized tree",
  { skip },
  (t) => {
    const run = runExecuteFixFixture(t, {
      ...replacement,
      codex: advanceMainDuringReview("LATER.md", "Later.\n"),
    });

    assert.equal(run.status, 0, run.output);
    const advancedBase = run.remoteGit("rev-parse", "refs/heads/main");
    assert.notEqual(advancedBase, run.baseSha);
    const outcome = run.report.actions.at(-1);
    assert.equal(outcome.status, "opened", JSON.stringify(run.report));
    assert.equal(run.git("rev-parse", `${outcome.commit}^`), advancedBase);
    assert.equal(run.remoteGit("rev-parse", `refs/heads/${replacementBranch}`), outcome.commit);
    assert.deepEqual(
      run.codexCalls.map((call) => call.files.includes("LATER.md")),
      [false, true],
    );
  },
);

test("final repair contract checks the delta from the synchronized base", { skip }, (t) => {
  const run = runExecuteFixFixture(t, {
    fixArtifact: {
      ...replacement.fixArtifact,
      deterministic_rebase_only: false,
      repair_contract: { must_touch: ["LATER.md"], match: "all" },
    },
    codex: [
      'if (ctx.callIndex === 1) ctx.fs.appendFileSync("CONTRIBUTING.md", "Repaired.\\n");',
      advanceMainDuringReview("LATER.md", "Later.\n", 2),
    ].join("\n"),
  });

  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /repair contract rejected final repair tree/);
  assert.match(run.output, /missing=LATER\.md/);
  assert.deepEqual(branchPushes(run.gitCalls), []);
});

test("final rebase conflict resolution stays pinned to the fetched base", { skip }, (t) => {
  const run = runExecuteFixFixture(t, {
    ...replacement,
    codex: [
      advanceMainDuringReview("CONTRIBUTING.md", "Main.\n"),
      // The workspace-write reconcile worker resolves the conflict and also moves origin/main
      // to a commit that is not in the rebased history.
      'if (!ctx.review && ctx.git("diff", "--name-only", "--diff-filter=U")) {',
      '  ctx.fs.writeFileSync("CONTRIBUTING.md", "Main.\\nContribution.\\n");',
      '  ctx.git("add", "CONTRIBUTING.md");',
      '  const drift = ctx.git("commit-tree", "main^{tree}", "-p", "main", "-m", "drift");',
      '  ctx.git("update-ref", "refs/remotes/origin/main", drift);',
      "}",
    ].join("\n"),
  });

  assert.equal(run.status, 0, run.output);
  const advancedBase = run.remoteGit("rev-parse", "refs/heads/main");
  const outcome = run.report.actions.at(-1);
  assert.equal(outcome.status, "opened", JSON.stringify(run.report));
  assert.equal(run.git("rev-parse", `${outcome.commit}^`), advancedBase);
  assert.equal(
    run.git("show", `${outcome.commit}:CONTRIBUTING.md`),
    "Main.\nContribution.\nFollow-up.",
  );
});

test("replacement push keeps the remote lease read before validation", { skip }, (t) => {
  let leased = "";
  const run = runExecuteFixFixture(t, {
    ...replacement,
    setup: ({ git, sourceHead }) => {
      git("branch", replacementBranch, sourceHead);
      leased = sourceHead;
    },
    codex: `if (ctx.review && ctx.callIndex === 2) ctx.pushRemote(${JSON.stringify(replacementBranch)}, "OTHER.md", "Other writer.\\n");`,
  });

  const concurrent = run.remoteGit("rev-parse", `refs/heads/${replacementBranch}`);
  assert.notEqual(concurrent, leased);
  assert.equal(run.remoteGit("log", "-1", "--format=%s", concurrent), "write OTHER.md");
  assert.deepEqual(
    branchPushes(run.gitCalls).map((call) => call.args.find((arg) => arg.startsWith("--force"))),
    [`--force-with-lease=refs/heads/${replacementBranch}:${leased}`],
  );
  assert.deepEqual(run.publications, []);
});
