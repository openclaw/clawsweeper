import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { branchPushes, runExecuteFixFixture } from "./execute-fix-cli-fixture.ts";

const skip = process.platform === "win32";
const changelog = "# Changelog\n\n## Unreleased\n\n### Fixes\n\n- Existing release entry.\n";
const noCodex = 'throw new Error("deterministic repair must not start Codex");';

for (const strategy of ["repair_contributor_branch", "replace_uneditable_branch"]) {
  test(`replacement publication preserves contributor credit via ${strategy}`, { skip }, (t) => {
    const run = runExecuteFixFixture(t, {
      fixArtifact: { repair_strategy: strategy },
      codex: strategy === "repair_contributor_branch" ? noCodex : "",
    });

    assert.equal(run.status, 0, run.output);
    if (strategy === "repair_contributor_branch") {
      assert.match(run.output, /automerge deterministic rebase validated/);
      assert.match(run.output, /repair branch push blocked; publishing prepared repair/);
    }
    assert.equal(run.report.status, "opened", JSON.stringify(run.report));
    const published = run.report.actions.find(
      (action: { action: string }) => action.action === "open_fix_pr",
    );
    assert.equal(published.pr_url, run.replacementUrl);
    assert.equal(run.git("rev-parse", `${published.commit}^`), run.baseSha);
    assert.equal(
      run.remoteGit("rev-parse", "refs/heads/clawsweeper/automerge-fixture-1"),
      published.commit,
    );
    assert.equal(
      run.git("show", `${published.commit}:CONTRIBUTING.md`),
      "Contribution.\nFollow-up.",
    );
    assert.match(
      String(run.publications.find((entry) => entry.kind === "pr")?.body),
      /Original contributor: @octocat\./,
    );
    const comments = run.publications.filter((entry) => entry.kind === "comment");
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.number, "1");
    assert.match(String(comments[0]?.body), /Source PR status: left open/);
    assert.match(
      String(comments[0]?.body),
      /@octocat: Co-authored-by: Mona Octocat <1\+octocat@users\.noreply\.github\.com>/,
    );
  });
}

test(
  "changelog-only repair delegates unchanged release notes to the edit worker",
  { skip },
  (t) => {
    const run = runExecuteFixFixture(t, {
      baseFiles: { "CHANGELOG.md": changelog, "AGENTS.md": "CHANGELOG.md is release-owned.\n" },
      fixArtifact: {
        likely_files: ["CHANGELOG.md"],
        changelog_required: true,
        deterministic_rebase_only: false,
      },
      env: { CLAWSWEEPER_FIX_EDIT_ATTEMPTS: "1" },
    });

    assert.equal(run.status, 0, run.output);
    assert.equal(run.report.status, "blocked", JSON.stringify(run.report));
    assert.match(run.report.reason, /no target repo changes after 1 edit attempt/);
    assert.equal(run.codexCalls.length, 1);
    assert.equal(run.codexCalls[0]?.args.includes("--output-schema"), false);
    assert.match(run.codexCalls[0]?.prompt ?? "", /"changelog_required": true/);
    assert.equal(fs.readFileSync(path.join(run.target, "CHANGELOG.md"), "utf8"), changelog);
    assert.deepEqual(run.publications, []);
    assert.deepEqual(
      branchPushes(run.gitCalls).filter(
        (call) => !call.args.includes("https://github.com/contributor/fixture.git"),
      ),
      [],
    );
  },
);

for (const managedLocale of [false, true]) {
  test(
    `replacement publication ${managedLocale ? "preserves managed locale" : "closes ordinary superseded"} source PR`,
    { skip },
    (t) => {
      const run = runExecuteFixFixture(t, {
        fixArtifact: { repair_strategy: "replace_uneditable_branch" },
        env: { CLAWSWEEPER_CLOSE_SUPERSEDED_SOURCE_PRS: "1" },
        ...(managedLocale
          ? {
              targetRepo: "openclaw/openclaw",
              headRepo: "openclaw/openclaw",
              pulls: [
                {
                  user: { login: "openclaw-mantis[bot]" },
                  head: { ref: "automation/native-app-locale-refresh" },
                },
              ],
              prView: { author: { login: "app/openclaw-mantis", is_bot: true } },
            }
          : {}),
      });

      assert.equal(run.status, 0, run.output);
      assert.equal(run.report.status, "opened", JSON.stringify(run.report));
      const published = run.report.actions.find(
        (action: { action: string }) => action.action === "open_fix_pr",
      );
      const closeout = published.superseded_source_actions[0];
      assert.equal(closeout.status, managedLocale ? "skipped" : "executed");
      assert.match(
        closeout.reason,
        managedLocale ? /repository-managed locale PR/ : /closed in favor/,
      );
      for (const kind of ["close", "comment"]) {
        assert.equal(
          run.publications.filter((entry) => entry.kind === kind).length,
          managedLocale ? 0 : 1,
        );
      }
    },
  );
}
