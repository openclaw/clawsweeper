import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRelatedContext,
  redactCredentialUriUserinfo,
} from "../dist/clawsweeper-related-context.js";

const TARGET_REPO = "openclaw/openclaw";
const SECRET_URI = ["https://alice", "secret@example.com/chrome"].join(":");
const PASS_URI = ["https://user", "pass@chrome.example.com"].join(":");
const PASS_HTTP_URI = ["http://user", "pass@chrome.example.com"].join(":");

function relatedContextWith(records: Record<string, unknown>, localReportsRoot?: string) {
  const requested: string[] = [];
  const batches: string[][] = [];
  const context = createRelatedContext({
    root: localReportsRoot ?? process.cwd(),
    targetRepo: () => TARGET_REPO,
    reportUrl: (value: string) => value,
    defaultItemsDir: () => (localReportsRoot ? join(localReportsRoot, "items") : "items"),
    defaultClosedDir: () => (localReportsRoot ? join(localReportsRoot, "closed") : "closed"),
    isMarkdownForActiveRepo: () => localReportsRoot !== undefined,
    gitHubRuntimeBudgetError: class GitHubRuntimeBudgetError extends Error {},
    ghJsonEach: <T>(requests: readonly string[][]) => {
      const paths = requests.map((args) => args[1] ?? "");
      if (paths.length > 0) batches.push(paths);
      requested.push(...paths);
      return paths.map((path) =>
        path in records
          ? { ok: true as const, value: records[path] as T }
          : { ok: false as const, error: new Error(`unexpected GitHub request: ${path}`) },
      );
    },
    ghJsonOnce: () => {
      throw new Error("unexpected GitHub request");
    },
    compactIssue: (value: unknown) => value,
    compactPullRequest: (value: unknown) => value,
    displayTitle: (value: string) => value,
    repoRelativePath: (value: string) => value,
  });
  return { context, requested, batches };
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

test("related items read every issue in one batch, then their pull requests, failing per item", () => {
  const { context, batches } = relatedContextWith({
    [`repos/${TARGET_REPO}/issues/11`]: { number: 11, pull_request: { url: "x" }, body: "a" },
    [`repos/${TARGET_REPO}/pulls/11`]: { number: 11, body: "a pull" },
    [`repos/${TARGET_REPO}/issues/22`]: { number: 22, body: "b" },
    [`repos/${TARGET_REPO}/issues/44`]: { number: 44, pull_request: { url: "y" }, body: "d" },
  });
  const related = context.relatedItemsContext({
    item,
    issue: { body: "See #44, #11, #33 and #22." },
    comments: [],
    timeline: [],
  });

  assert.deepEqual(batches, [
    [11, 22, 33, 44].map((number) => `repos/${TARGET_REPO}/issues/${number}`),
    [11, 44].map((number) => `repos/${TARGET_REPO}/pulls/${number}`),
  ]);
  assert.deepEqual(related, [
    {
      mentionedIn: ["item body"],
      issue: { number: 11, pull_request: { url: "x" }, body: "a" },
      commentCount: undefined,
      pullRequest: { number: 11, body: "a pull" },
    },
    {
      mentionedIn: ["item body"],
      issue: { number: 22, body: "b" },
      commentCount: undefined,
    },
    {
      number: 33,
      mentionedIn: ["item body"],
      error: `unexpected GitHub request: repos/${TARGET_REPO}/issues/33`,
    },
    {
      mentionedIn: ["item body"],
      issue: { number: 44, pull_request: { url: "y" }, body: "d" },
      commentCount: undefined,
      pullRequestError: `unexpected GitHub request: repos/${TARGET_REPO}/pulls/44`,
    },
  ]);
});

test("local title matches are unchanged by typed record lines", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-related-record-"));
  try {
    mkdirSync(join(root, "items"));
    mkdirSync(join(root, "closed"));
    const report = (number: number) => `---
repository: ${TARGET_REPO}
number: ${number}
type: pull_request
title: Browser credential transmission repair
url: https://github.com/${TARGET_REPO}/pull/${number}
author: contributor-example
decision: keep_open
close_reason: none
action_taken: kept_open
---

## Summary

Keep browser credentials out of model input.

## Evidence

review_record: this body line is not metadata
`;
    const paths = [join(root, "items", "1.md"), join(root, "closed", "2.md")];
    paths.forEach((path, index) => writeFileSync(path, report(index + 1)));
    const options = {
      item: { ...item, title: "Browser credential transmission" },
      issue: {},
      comments: [],
      timeline: [],
    };
    const before = relatedContextWith({}, root).context.relatedItemsContext(options);
    assert.equal(before.length, 2);
    paths.forEach((path, index) => {
      const record = `review_record: ${JSON.stringify({
        version: 1,
        origin: "backfill",
        decision: { summary: "unrelated typed summary".repeat(1000) },
      })}\n`;
      writeFileSync(path, report(index + 1).replace("\n---\n", `\n${record}---\n`));
    });
    assert.deepEqual(relatedContextWith({}, root).context.relatedItemsContext(options), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local title index does not retain the reports backing its metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-related-heap-"));
  try {
    const itemsDir = join(root, "items");
    mkdirSync(itemsDir);
    const source = join(root, "source.md");
    // The retained summary is tiny compared with the irrelevant report body.
    // Hardlinks keep the fixture small on disk while every read gets its own string.
    writeFileSync(
      source,
      `---
repository: ${TARGET_REPO}
type: pull_request
title: Browser credential transmission repair
url: https://github.com/${TARGET_REPO}/pull/1
author: contributor-example
decision: keep_open
close_reason: none
action_taken: kept_open
review_record: {"version":1,"origin":"backfill","decision":{"summary":"${"r".repeat(512 * 1024)}"}}
---

## Summary

Keep browser credentials out of model input.

## Evidence

${"e".repeat(512 * 1024)}
`,
    );
    for (let number = 1; number <= 100; number += 1) {
      linkSync(source, join(itemsDir, `${number}.md`));
    }
    const moduleUrl = new URL("../dist/clawsweeper-related-context.js", import.meta.url).href;
    const script = `
      import { createRelatedContext } from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(root)};
      const context = createRelatedContext({
        root, targetRepo: () => ${JSON.stringify(TARGET_REPO)}, reportUrl: x => x,
        defaultItemsDir: () => root + "/items", defaultClosedDir: () => root + "/closed",
        isMarkdownForActiveRepo: () => true, gitHubRuntimeBudgetError: Error,
        ghJsonEach: () => [], ghJsonOnce: () => { throw Error("unexpected network"); },
        compactIssue: x => x, compactPullRequest: x => x,
        displayTitle: x => x, repoRelativePath: x => x,
      });
      const related = context.relatedItemsContext({
        item: ${JSON.stringify({ ...item, title: "Browser credential transmission" })}, issue: {}, comments: [], timeline: [],
      });
      console.log(JSON.stringify(related.map(entry => entry.localReport.number)));
    `;
    const stdout = execFileSync(
      process.execPath,
      ["--max-old-space-size=64", "--input-type=module", "--eval", script],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.deepEqual(JSON.parse(stdout), [1, 2, 3, 4, 5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
