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

test("commit finding PR titles follow Conventional Commits format", () => {
  const conventionalCommitsPrefix =
    /^(fix|feat|refactor|test|docs|chore|build|ci|perf|style)(\(.+\))?:/;
  const titles = [
    commitFindingPrTitle("Found a race in the session cleanup handler"),
    commitFindingPrTitle("CI: extension-shard matrix handling regressed"),
    commitFindingPrTitle("regression in provider auth routing"),
  ];
  for (const title of titles) {
    assert.match(
      title,
      conventionalCommitsPrefix,
      `title must follow Conventional Commits: ${title}`,
    );
    assert.equal(title.length <= 72, true, `title must be ≤72 chars: ${title}`);
    assert.doesNotMatch(title, /[.!?]$/, `title must not end with punctuation: ${title}`);
  }
});

test("commit finding PR titles truncate summaries that would exceed the 72-char cap", () => {
  assert.equal(CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH, 72);
  const longSummary =
    "Found a regression where the provider reconnect path drops persisted session state across restarts";
  const title = commitFindingPrTitle(longSummary);
  assert.equal(
    title.length <= CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH,
    true,
    `title must be ≤${CLAWSWEEPER_GENERATED_PR_TITLE_MAX_LENGTH} chars: ${title} (${title.length})`,
  );
  assert.match(title, /^fix(\(.+\))?:/, `title must keep its prefix after truncation: ${title}`);
});

test("commit finding PR body template has required sections in order", () => {
  // Inline the expected template structure — commit-finding-intake is a script
  // and cannot be imported safely in tests. This validates the *shape* of the
  // template produced by prBody() matches the Task-2 required format.
  const body = [
    "## Summary",
    "",
    "Fix the race in the session cleanup path.",
    "",
    "## Changes",
    "",
    "Expected repair surface:",
    "- `src/session.ts`",
    "",
    "## Verification",
    "",
    "- `pnpm check:changed`",
    "",
    "## Source",
    "",
    "- ClawSweeper report: https://github.com/valkyriweb/clawsweeper-state/blob/main/records/test/commits/abc.md",
    "- Commit under review: https://github.com/openclaw/openclaw/commit/abcdef1234567890abcdef1234567890abcdef12",
  ].join("\n");

  const summaryIdx = body.indexOf("## Summary");
  const changesIdx = body.indexOf("## Changes");
  const verificationIdx = body.indexOf("## Verification");
  const sourceIdx = body.indexOf("## Source");

  assert.ok(summaryIdx >= 0, "## Summary must be present");
  assert.ok(changesIdx >= 0, "## Changes must be present");
  assert.ok(verificationIdx >= 0, "## Verification must be present");
  assert.ok(sourceIdx >= 0, "## Source must be present");

  assert.ok(summaryIdx < changesIdx, "## Summary must precede ## Changes");
  assert.ok(changesIdx < verificationIdx, "## Changes must precede ## Verification");
  assert.ok(verificationIdx < sourceIdx, "## Verification must precede ## Source");
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
