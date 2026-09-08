import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createContextHydration } from "../dist/clawsweeper-context-hydration.js";
import { createItemContext } from "../dist/clawsweeper-item-context.js";
import { createSourceRevisionTools } from "../dist/clawsweeper-source-revision.js";
import {
  asRecord,
  labelNames,
  login,
  normalizeAuthorAssociation,
  normalizeLabelName,
} from "../dist/clawsweeper-item-policy.js";
import type { PrimaryBodyContext } from "../dist/clawsweeper-primary-body.js";
import type { Item, ItemKind } from "../dist/clawsweeper-types.js";
import { item } from "./helpers.ts";

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

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const stringOrUndefined = (value: unknown) => (typeof value === "string" ? value : undefined);
const githubCount = (value: unknown) => (typeof value === "number" ? value : null);
const CLAWSWEEPER_BOT_AUTHORS = new Set(["clawsweeper[bot]"]);
const isClawSweeperComment = (value: unknown) =>
  CLAWSWEEPER_BOT_AUTHORS.has((login(asRecord(value).user) ?? "").toLowerCase());

export const sourceTools = createSourceRevisionTools({
  asRecord,
  clawsweeperBotAuthors: CLAWSWEEPER_BOT_AUTHORS,
  githubCount,
  isClawSweeperComment,
  login,
  normalizeAuthorAssociation,
  normalizeLabelName,
  pullHeadShaFromContext: (context) =>
    stringOrUndefined(asRecord(asRecord(context.pullRequest).head).sha) ?? null,
  sha256,
  stringOrUndefined,
});

function unavailable(): never {
  throw new Error("Unexpected dependency: this fixture must not use external capabilities");
}

// Unused dependencies fail closed instead of invoking GitHub or local archives.
export const hydration = createContextHydration(
  new Proxy(
    {
      asRecord,
      CLAWSWEEPER_BOT_AUTHORS,
      labelNames,
      login,
      normalizeAuthorAssociation,
      normalizeLabelName,
      stringOrUndefined,
      githubCount,
      reviewCommentBodyDigest: sourceTools.reviewCommentBodyDigest,
    },
    { get: (target, key) => Reflect.get(target, key) ?? unavailable },
  ) as Parameters<typeof createContextHydration>[0],
);

export function hydratePrimaryBody(
  body: unknown,
  kind: ItemKind,
  options: {
    pullBody?: string;
    closingBodies?: string[];
    comments?: unknown[];
    pullFiles?: unknown[];
  } = {},
) {
  const target = item({ kind }) as Item;
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
    review_comments: 0,
  };
  const window = (items: unknown[]) => ({
    items,
    total: items.length,
    hydrated: items.length,
    truncated: false,
  });
  const { collectItemContext } = createItemContext({
    ...hydration,
    ...sourceTools,
    asRecord,
    sha256,
    stringOrUndefined,
    targetRepo: () => target.repo,
    ghJson: <T>(args: string[]) => {
      if (args[1] === `repos/${target.repo}/issues/${target.number}`) return rawIssue as T;
      if (args[1] === `repos/${target.repo}/pulls/${target.number}`) return rawPull as T;
      return unavailable();
    },
    ghPaged: unavailable,
    ghPagedContextWindow: <T>(path: string) => {
      const items = path.endsWith(`/issues/${target.number}/comments`)
        ? (options.comments ?? [])
        : path.endsWith(`/pulls/${target.number}/files`)
          ? (options.pullFiles ?? [])
          : [];
      return window(items) as {
        items: T[];
        total: number;
        hydrated: number;
        truncated: boolean;
      };
    },
    ghPagedLinkHeaderContextWindow: () => window([]),
    closingPullRequestsForIssue: () =>
      (options.closingBodies ?? []).map((closingBody, index) => ({
        ...rawPull,
        number: target.number + index + 1,
        body: closingBody,
      })),
    referencingMergedPullRequestsForIssue: () => [],
    relatedItemsContext: () => [],
    fetchReviewedPrActivityCursor: () => null,
    pullChecksContext: () => ({ complete: true, checkRuns: [], statuses: [] }),
  });
  const context = collectItemContext(target, { reviewCacheDigest: true });
  return { target, rawIssue, rawPull, context };
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
