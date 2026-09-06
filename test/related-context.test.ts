import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelatedContext,
  redactCredentialUriUserinfo,
} from "../dist/clawsweeper-related-context.js";

const TARGET_REPO = "openclaw/openclaw";
const SECRET_URI = ["https://alice", "secret@example.com/chrome"].join(":");
const PASS_URI = ["https://user", "pass@chrome.example.com"].join(":");
const PASS_HTTP_URI = ["http://user", "pass@chrome.example.com"].join(":");

function relatedContextWith(records: Record<string, unknown>) {
  const requested: string[] = [];
  const context = createRelatedContext({
    root: process.cwd(),
    targetRepo: () => TARGET_REPO,
    reportUrl: (value: string) => value,
    defaultItemsDir: () => "items",
    defaultClosedDir: () => "closed",
    isMarkdownForActiveRepo: () => false,
    gitHubRuntimeBudgetError: class GitHubRuntimeBudgetError extends Error {},
    ghJson: <T>(args: string[]): T => {
      const path = args[1] ?? "";
      requested.push(path);
      if (!(path in records)) throw new Error(`unexpected GitHub request: ${path}`);
      return records[path] as T;
    },
    ghJsonOnce: () => {
      throw new Error("unexpected GitHub request");
    },
    asRecord: (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    login: () => undefined,
    compactIssue: (value: unknown) => value,
    compactPullRequest: (value: unknown) => value,
    envFlagEnabled: () => false,
    envFlagDisabled: () => false,
    frontMatterValue: () => undefined,
    reviewSectionValue: () => "",
    effectiveReviewStatus: () => "",
    displayTitle: (value: string) => value,
    markdownFiles: () => [],
    numberForMarkdownFile: () => 0,
    repoRelativePath: (value: string) => value,
  });
  return { context, requested };
}

const item = {
  repo: TARGET_REPO,
  number: 137756,
  kind: "pull_request" as const,
  title: "fix(browser): stop sending credentialed CDP wsUrl to the model",
  url: `https://github.com/${TARGET_REPO}/pull/137756`,
  createdAt: "2026-09-04T01:32:45Z",
  updatedAt: "2026-09-04T01:32:45Z",
  author: "yetval",
  authorAssociation: "NONE" as const,
  labels: [],
};

test("redactCredentialUriUserinfo masks only http(s) userinfo the URI scanner would flag", () => {
  assert.equal(
    redactCredentialUriUserinfo(`cdpUrl ${SECRET_URI}`),
    "cdpUrl https://***:***@example.com/chrome",
  );
  assert.equal(
    redactCredentialUriUserinfo(`cdp ${PASS_HTTP_URI}?token=1 and again ${PASS_HTTP_URI}`),
    "cdp http://***:***@chrome.example.com?token=1 and again http://***:***@chrome.example.com",
  );
  for (const untouched of [
    "https://example.com/path:with@colon",
    ["https://user", "pa/ss@chrome.example.com"].join(":"),
    ["HTTP://user", "secret@example.com"].join(":"),
    "https://***:***@example.com",
    ["wss://admin", "s3cr3t@chrome.example.net/devtools"].join(":"),
    ["https://user", "ab@example.com"].join(":"),
    "no uri here",
  ]) {
    assert.equal(redactCredentialUriUserinfo(untouched), untouched);
  }
});

test("related item bodies pulled into the prompt drop credential URI userinfo", () => {
  const { context } = relatedContextWith({
    [`repos/${TARGET_REPO}/issues/53417`]: {
      number: 53417,
      body: `Repro: set cdpUrl to ${SECRET_URI} and read config.`,
    },
    [`repos/${TARGET_REPO}/issues/67679`]: {
      number: 67679,
      pull_request: { url: "x" },
      body: `Before: ${PASS_URI} is returned verbatim.`,
    },
    [`repos/${TARGET_REPO}/pulls/67679`]: {
      number: 67679,
      body: `Before: ${PASS_URI} is returned verbatim.`,
    },
  });
  const related = context.relatedItemsContext({
    item,
    issue: { body: "Related but distinct from #53417, fixed by #67679." },
    comments: [],
    timeline: [],
  }) as Array<{ issue: { number: number; body: string }; pullRequest?: { body: string } }>;
  assert.deepEqual(
    related.map((entry) => entry.issue.number),
    [53417, 67679],
  );
  assert.equal(
    related[0]?.issue.body,
    "Repro: set cdpUrl to https://***:***@example.com/chrome and read config.",
  );
  assert.equal(
    related[1]?.issue.body,
    "Before: https://***:***@chrome.example.com is returned verbatim.",
  );
  assert.equal(
    related[1]?.pullRequest?.body,
    "Before: https://***:***@chrome.example.com is returned verbatim.",
  );
});

test("timeline cross-references from other repositories are not fetched from the target repo", () => {
  const { context, requested } = relatedContextWith({
    [`repos/${TARGET_REPO}/issues/5`]: { number: 5, body: "same repo" },
    [`repos/${TARGET_REPO}/issues/7`]: { number: 7, body: "legacy event without repository" },
  });
  const related = context.relatedItemsContext({
    item,
    issue: { body: "" },
    comments: [],
    timeline: [
      {
        event: "cross-referenced",
        source: {
          issue: { number: 436, repository: { full_name: "96loveslife/big_model_radar" } },
        },
      },
      {
        event: "cross-referenced",
        source: { issue: { number: 5, repository: { full_name: "OpenClaw/OpenClaw" } } },
      },
      { event: "cross-referenced", source: { issue: { number: 7 } } },
    ],
  }) as Array<{ issue: { number: number } }>;
  assert.deepEqual(
    related.map((entry) => entry.issue.number),
    [5, 7],
  );
  assert.ok(!requested.some((path) => path.endsWith("/issues/436")));
});
