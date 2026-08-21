import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRelatedContext } from "../dist/clawsweeper-related-context.js";
import { item } from "./helpers.ts";

class TestGitHubRuntimeBudgetError extends Error {}

function relatedContextHarness(githubPaths: string[]) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-related-context-"));
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  mkdirSync(itemsDir);
  mkdirSync(closedDir);
  writeFileSync(join(itemsDir, "41.md"), "canonical predecessor assessment");

  const harness = createRelatedContext({
    root: "/definitely-missing-clawsweeper-root",
    targetRepo: () => "openclaw/openclaw",
    reportUrl: (path) => path,
    defaultItemsDir: () => itemsDir,
    defaultClosedDir: () => closedDir,
    isMarkdownForActiveRepo: () => true,
    gitHubRuntimeBudgetError: TestGitHubRuntimeBudgetError,
    ghJson: <T>(args: string[]) => {
      githubPaths.push(args.at(-1) ?? "");
      assert.deepEqual(args, ["api", "repos/openclaw/openclaw/issues/41"]);
      return {
        number: 41,
        title: "Design conversation routing",
        state: "open",
        comments: 2,
        updated_at: "2026-07-01T00:00:00Z",
      } as T;
    },
    ghJsonOnce: <T>() => ({ items: [] }) as T,
    asRecord: (value) =>
      value && typeof value === "object" ? (value as Record<string, unknown>) : {},
    login: () => undefined,
    compactIssue: (value) => value,
    compactPullRequest: (value) => value,
    envFlagEnabled: () => false,
    envFlagDisabled: () => false,
    frontMatterValue: (_markdown, key) =>
      ({
        reviewed_at: "2026-07-01T00:00:00Z",
        pull_head_sha: "unknown",
        main_sha: "abc123def456",
        review_comment_url: "https://github.com/openclaw/openclaw/issues/41#issuecomment-9001",
      })[key],
    reviewSectionValue: (_markdown, section) =>
      ({
        summary: "Conversation references must remain scoped to their owning agent.",
        bestSolution: "Keep references owner-scoped.",
        risks:
          "- A persisted reference could retain authority after its owning account is reassigned.",
      })[section],
    effectiveReviewStatus: () => "found risks before implementation.",
    reportPrRating: () => ({
      proofTier: "C",
      patchTier: "C",
      overallTier: "C",
      summary: "Authority proof is required.",
      nextSteps: ["Prove a non-owner cannot dispatch the reference."],
    }),
    reportRealBehaviorProof: () => ({
      status: "missing",
      summary: "No forbidden-principal proof was supplied.",
      evidenceKind: "none",
      needsContributorAction: true,
    }),
    reportReviewFindings: () => [
      {
        priority: 1,
        title: "Keep references owner-scoped",
        body: "A non-owner can dispatch a persisted reference.",
        confidenceScore: 0.95,
        file: "src/router.ts",
        lineStart: 41,
        lineEnd: 41,
      },
    ],
    displayTitle: (title) => title,
    markdownFiles: () => [],
    numberForMarkdownFile: () => 0,
    repoRelativePath: (path) => path,
  });
  return { harness, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("explicit PR predecessors use the indexed canonical ClawSweeper assessment", (t) => {
  const githubPaths: string[] = [];
  const fixture = relatedContextHarness(githubPaths);
  t.after(fixture.cleanup);
  const { harness } = fixture;

  const related = harness.relatedItemsContext({
    item: item({ kind: "pull_request", number: 50 }),
    issue: { body: "Implements #41" },
    comments: [],
    timeline: [],
    pullRequest: { body: "Implements #41" },
  });

  assert.deepEqual(githubPaths, ["repos/openclaw/openclaw/issues/41"]);
  assert.equal(related.length, 1);
  const assessment = (related[0] as { latestClawSweeperAssessment: Record<string, unknown> })
    .latestClawSweeperAssessment;
  assert.equal(
    assessment.summary,
    "Conversation references must remain scoped to their owning agent.",
  );
  assert.deepEqual(assessment.findings, [
    { priority: "P1", title: "Keep references owner-scoped" },
  ]);
  assert.deepEqual(assessment.risks, [
    "A persisted reference could retain authority after its owning account is reassigned.",
  ]);
  assert.equal(assessment.reviewedSha, "abc123def456");
  assert.equal(
    assessment.commentUrl,
    "https://github.com/openclaw/openclaw/issues/41#issuecomment-9001",
  );
  assert.equal("reportUrl" in assessment, false);
  assert.equal("commentUpdatedAt" in assessment, false);
  assert.equal("earlierReviewCycles" in assessment, false);
  assert.equal("completedReviewCycles" in assessment, false);

  harness.refreshRelatedItemsContext(item({ kind: "pull_request", number: 50 }), {
    relatedItems: related,
  } as never);
  assert.deepEqual(githubPaths, [
    "repos/openclaw/openclaw/issues/41",
    "repos/openclaw/openclaw/issues/41",
  ]);
  assert.equal(
    githubPaths.some((path) => path.includes("/comments")),
    false,
  );
});

test("issue related context does not hydrate predecessor assessments", (t) => {
  const githubPaths: string[] = [];
  const fixture = relatedContextHarness(githubPaths);
  t.after(fixture.cleanup);
  const { harness } = fixture;

  const related = harness.relatedItemsContext({
    item: item({ kind: "issue", number: 50 }),
    issue: { body: "Related to #41" },
    comments: [],
    timeline: [],
  });

  assert.equal(related.length, 1);
  assert.deepEqual(githubPaths, ["repos/openclaw/openclaw/issues/41"]);
  assert.equal("latestClawSweeperAssessment" in (related[0] as Record<string, unknown>), false);
});
