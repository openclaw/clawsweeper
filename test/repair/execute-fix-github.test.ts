import assert from "node:assert/strict";
import test from "node:test";

import {
  coAuthorTrailers,
  supersededReplacementSources,
} from "../../dist/repair/execute-fix-github.js";

test("replacement co-author trailers include contributors without bot self-credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "Mona Octocat",
        email: "1+octocat@users.noreply.github.com",
      },
    ]),
    ["Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>"],
  );
});

test("replacement co-author trailers omit ClawSweeper self-credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "clawsweeper[bot]",
        email: "274271284+clawsweeper[bot]@users.noreply.github.com",
      },
    ]),
    [],
  );
});

const replacementSources = [
  "https://github.com/openclaw/openclaw/pull/101",
  "https://github.com/openclaw/openclaw/pull/102",
  "https://github.com/openclaw/openclaw/pull/103",
  "https://github.com/other/repo/pull/104",
];

test("replacement supersedes the first source PR and close_superseded targets only", () => {
  assert.deepEqual(
    supersededReplacementSources({
      fixArtifact: {
        source_prs: replacementSources,
        branch_update_blockers: ["#102 maintainer_can_modify=false and the branch is uneditable"],
      },
      actions: [
        { action: "close_superseded", status: "blocked", target: "#103", candidate_fix: null },
        { action: "keep_related", target: "#102" },
      ],
      repo: "openclaw/openclaw",
    }),
    [replacementSources[0], replacementSources[2]],
  );
});

test("replacement without close_superseded actions supersedes only the first source PR", () => {
  assert.deepEqual(
    supersededReplacementSources({
      fixArtifact: { source_prs: replacementSources, branch_update_blockers: [] },
      actions: [],
      repo: "openclaw/openclaw",
    }),
    [replacementSources[0]],
  );
});

test("replacement leaves close_superseded actions bound to another fix to the applicator", () => {
  assert.deepEqual(
    supersededReplacementSources({
      fixArtifact: { source_prs: replacementSources, branch_update_blockers: [] },
      actions: [
        { action: "close_superseded", status: "blocked", target: "#102", candidate_fix: "#900" },
        { action: "close_superseded", status: "blocked", target: "#103", canonical: "#901" },
      ],
      repo: "openclaw/openclaw",
    }),
    [replacementSources[0]],
  );
});
