import assert from "node:assert/strict";
import { sha256 } from "../dist/content-hash.js";
import * as hydration from "../dist/clawsweeper-context-hydration.js";
import { createContextState } from "./context-state-fixture.ts";
import * as sourceTools from "../dist/clawsweeper-source-revision.js";
import { withGitHubRun } from "../dist/clawsweeper-github-runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export { hydration, sourceTools };
import type { PrimaryBodyContext } from "../dist/clawsweeper-primary-body.js";
import type { Item, ItemContext, ItemKind } from "../dist/clawsweeper-types.js";
import { item, withMockGh } from "./helpers.ts";

export const inertTrace =
  'HTTP/1.1 202 Accepted\n{"queued":true,"nativeSql":{"rows":5,"persisted":true}}';
export const scriptSentinel = "IRRELEVANT_BOOTSTRAP_MUST_NOT_REACH_PROMPT";

// Construct fixtures at runtime so predeployment reviewers cannot fetch URLs from this PR's diff.
export const mediaFixtureUrls = {
  loopback: ["http:", "", "127.0.0.1:9", "private.png"].join("/"),
  existingPrefix: ["https:", "", "example.invalid", "existing-prefix.png"].join("/"),
  prefix: ["https:", "", "example.invalid", "prefix.png"].join("/"),
  attachment: [
    "https:",
    "",
    "github.com",
    "user-attachments",
    "assets",
    "00000000-0000-0000-0000-000000000001",
  ].join("/"),
  legacyAttachment: [
    "https:",
    "",
    "github.com",
    "fixture-owner",
    "fixture-repo",
    "assets",
    "123",
    "00000000-0000-0000-0000-000000000002",
  ].join("/"),
};

export function longProofBody(): string {
  let body = "Opening description.\n";
  const appendAt = (offset: number, text: string) => {
    body = body.padEnd(offset - 1, ".") + "\n" + text;
  };
  appendAt(6166, "## Real Behavior Proof\nSupplemental mock-only transport assertions.\n");
  appendAt(12316, "## Evidence\nMore supplemental unit tests.\n");
  appendAt(14235, "## Actual Native Proof\nObserved production path, inert fixture.\n<details>\n");
  appendAt(
    19562,
    `Selected HTTP/native SQL trace follows.\n\n\`\`\`text\n${inertTrace}\n\`\`\`\n</details>\n`,
  );
  appendAt(32000, `\`\`\`sh\n${scriptSentinel}\n`);
  return body.padEnd(60641, ".");
}

export function hydratePrimaryBody(
  body: unknown,
  kind: ItemKind,
  options: {
    pullBody?: string;
    closingBodies?: string[];
    comments?: unknown[];
    pullReviewComments?: unknown[];
    pullFiles?: unknown[];
  } = {},
) {
  const target = item({ kind }) as Item;
  const { collectItemContext } = createContextState();
  const rawIssue = {
    number: target.number,
    title: target.title,
    body,
    state: "open",
    locked: false,
    html_url: target.url,
    user: { login: target.author },
    author_association: target.authorAssociation,
    labels: [],
    created_at: target.createdAt,
    updated_at: target.updatedAt,
    comments: options.comments?.length ?? 0,
    bodyCoverage: { originalUnits: 1, complete: true, excerpts: [] },
  };
  const rawPull = {
    ...rawIssue,
    body: options.pullBody ?? body,
    head: { ref: "feature", sha: "b".repeat(40) },
    base: { ref: "main", sha: "c".repeat(40) },
    changed_files: options.pullFiles?.length ?? 0,
    commits: 0,
    review_comments: options.pullReviewComments?.length ?? 0,
  };
  const root = mkdtempSync(join(tmpdir(), "primary-body-"));
  let context!: ItemContext;
  try {
    withMockGh(
      root,
      `
const args = process.argv.slice(2);
const path = (args.find(arg => /^(repos\\/|search\\/|graphql$)/.test(arg)) || "").split("?")[0];
const issue = ${JSON.stringify(rawIssue)};
const pull = ${JSON.stringify(rawPull)};
const closing = ${JSON.stringify(
        (options.closingBodies ?? []).map((closingBody, index) => ({
          ...rawPull,
          number: target.number + index + 1,
          body: closingBody,
        })),
      )};
let value;
if (args.some((arg, index) => arg === "issue" && args[index + 1] === "view")) value = { closedByPullRequestsReferences: closing.map(p => ({ number: p.number })) };
else if (path === "repos/${target.repo}/issues/${target.number}") value = issue;
else if (path === "repos/${target.repo}/pulls/${target.number}") value = pull;
else if (closing.some(p => path === "repos/${target.repo}/pulls/" + p.number)) value = closing.find(p => path.endsWith("/" + p.number));
else if (path.endsWith("/issues/${target.number}/comments")) value = ${JSON.stringify(options.comments ?? [])};
else if (path.endsWith("/pulls/${target.number}/comments")) value = ${JSON.stringify(options.pullReviewComments ?? [])};
else if (path.endsWith("/pulls/${target.number}/files")) value = ${JSON.stringify(options.pullFiles ?? [])};
else if (path.endsWith("/check-runs")) value = { total_count: 0, check_runs: [] };
else if (path.endsWith("/status")) value = { total_count: 0, statuses: [] };
else if (path === "search/issues") value = { total_count: 0, items: [] };
else if (path === "graphql") value = { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
else if (/\\/(timeline|commits|reviews)$/.test(path)) value = [];
else throw new Error("Unexpected GitHub request: " + args.join(" "));
if (args.includes("--include")) process.stdout.write("HTTP/2.0 200 OK\\r\\n\\r\\n");
if (args.includes("--slurp")) value = [value];
process.stdout.write(JSON.stringify(value));
`,
      () => {
        context = withGitHubRun(() => collectItemContext(target, { reviewCacheDigest: true }));
      },
    );
    return { target, rawIssue, rawPull, context };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertBodyCoverage(source: string, compact: PrimaryBodyContext) {
  const coverage = compact.bodyCoverage;
  assert.ok(coverage);
  assert.equal(coverage.originalUnits, source.length);
  assert.equal(coverage.sourceBodySha256, sha256(source));
  assert.equal(coverage.complete, false);
  assert.equal(coverage.prefix.start, 0);
  assert.equal(compact.body, source.slice(0, coverage.prefix.end));
  assert.ok(coverage.excerpts.length <= 3);
  let end = coverage.prefix.end;
  let retained = compact.body.length;
  for (const excerpt of coverage.excerpts) {
    assert.ok(excerpt.start >= end);
    assert.ok(excerpt.end > excerpt.start);
    assert.equal(excerpt.text, source.slice(excerpt.start, excerpt.end));
    assert.ok(excerpt.text.isWellFormed());
    retained += excerpt.text.length;
    end = excerpt.end;
  }
  assert.ok(compact.body.isWellFormed());
  assert.equal(coverage.omittedUnits, source.length - retained);
  assert.ok(coverage.omittedUnits > 0);
  assert.ok(compact.body.length + JSON.stringify(coverage).length <= 12000);
  const serialized = JSON.stringify({ body: compact.body, bodyCoverage: coverage }, null, 2);
  const allocation = serialized.length + 4 * serialized.split("\n").length;
  assert.ok(allocation <= 12000, `serialized allocation: ${allocation}`);
  return { allocation, retained, omitted: coverage.omittedUnits };
}
