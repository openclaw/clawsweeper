import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH,
  GITHUB_PR_TITLE_MAX_LENGTH,
  commitFindingPrTitle,
  normalizeGithubPrTitle,
} from "../../dist/repair/pr-title.js";
import { validateFixArtifact } from "../../dist/repair/execute-fix-validation.js";

test("commit finding PR titles summarize scoped findings without leaking report prose", () => {
  const title = commitFindingPrTitle(
    "Found two concrete regressions in the shared helper extraction. The first failure drops docker state and the second breaks script cleanup.",
  );

  assert.equal(title, "fix: shared helper extraction regressions");
  assert.equal(title.length <= CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH, true);
});

test("commit finding PR titles keep CI prefix and stay under the generated title cap", () => {
  const title = commitFindingPrTitle(
    "Found one low-severity formatting bug in the new loose-list paragraph for GitHub Actions output. The rest of the report explains why it matters.",
  );

  assert.equal(title, "fix(ci): loose-list paragraph for GitHub Actions output formatting bug");
  assert.equal(title.length <= CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH, true);
});

test("commit finding PR titles retain known special-case titles", () => {
  assert.equal(
    commitFindingPrTitle("extension-shard matrix handling regressed"),
    "fix(ci): gate extension aggregate on shard matrix",
  );
});

test("github PR title normalization applies the hard GitHub ceiling", () => {
  const title = normalizeGithubPrTitle(`fix: ${"a".repeat(400)}`);

  assert.equal(title.length, GITHUB_PR_TITLE_MAX_LENGTH);
  assert.match(title, /\.\.\.$/);
});

test("fix artifact validation rejects titles past the GitHub ceiling", () => {
  assert.throws(
    () =>
      validateFixArtifact({
        summary: "summary",
        pr_title: `fix: ${"a".repeat(GITHUB_PR_TITLE_MAX_LENGTH)}`,
        pr_body: "body",
        affected_surfaces: ["src"],
        likely_files: ["src/example.ts"],
        linked_refs: ["none"],
        validation_commands: ["pnpm check:changed"],
        credit_notes: ["ClawSweeper"],
        changelog_required: false,
        repair_strategy: "new_fix_pr",
        source_prs: [],
      }),
    /fix_artifact\.pr_title must be 256 characters or fewer/,
  );
});
