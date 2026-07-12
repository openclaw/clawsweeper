import assert from "node:assert/strict";
import test from "node:test";

import {
  createReviewSemanticRecord,
  reviewSemanticCacheDecision,
  reviewSemanticRevalidationDecision,
} from "../dist/review-semantic-cache.js";

const NOW = Date.parse("2026-07-12T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const STRUCTURAL_CONTEXT = "a".repeat(64);

function input(overrides: Record<string, unknown> = {}) {
  const context = {
    issue: {
      number: 123,
      title: "Improve the cache",
      body: "Keep the verdict current.",
      state: "open",
      author: "contributor",
      authorAssociation: "CONTRIBUTOR",
      labels: ["performance"],
    },
    comments: [{ author: "maintainer", authorAssociation: "MEMBER", body: "Looks useful." }],
    timeline: [],
    timelineRevision: "timeline-1",
    pullRequest: {
      number: 123,
      title: "Improve the cache",
      body: "Keep the verdict current.",
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      head: { ref: "feature", sha: "b".repeat(40) },
      base: { ref: "main", sha: "c".repeat(40) },
    },
    pullFiles: [
      {
        filename: "src/cache.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-const answer = 41;\n+const answer = 42;",
      },
    ],
    pullCommits: [{ sha: "d".repeat(40), author: "contributor", message: "perf: cache it" }],
    pullCommitsRevision: "b".repeat(64),
    pullReviewComments: [],
    pullReviewCommentsRevision: "review-comments-1",
    pullChecks: {
      complete: true,
      checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
      checkRunsTruncated: false,
      statuses: [{ context: "ci", state: "success" }],
      statusesTruncated: false,
    },
    counts: {
      comments: 1,
      commentsTruncated: false,
      timeline: 0,
      timelineTruncated: false,
      pullFiles: 1,
      pullFilesHydrated: 1,
      pullFilesTruncated: false,
      pullCommits: 1,
      pullCommitsHydrated: 1,
      pullCommitsTruncated: false,
      pullReviewComments: 0,
      pullReviewCommentsTruncated: false,
    },
  };
  const base = {
    item: {
      repo: "openclaw/openclaw",
      number: 123,
      kind: "pull_request" as const,
    },
    context,
    git: {
      mainSha: "e".repeat(40),
      releaseStateComplete: true,
      latestRelease: { tagName: "v1.0.0", sha: "f".repeat(40) },
    },
    structuralContextRevision: STRUCTURAL_CONTEXT,
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
  };
  const merged = {
    ...base,
    ...overrides,
    context: {
      ...context,
      ...(overrides.context as Record<string, unknown> | undefined),
    },
  };
  const withTreeIdentity = (value: unknown): unknown => {
    const file = value as Record<string, unknown>;
    if (file.treeModesComplete !== undefined || file.omitted !== undefined) return file;
    const status = typeof file.status === "string" ? file.status.toLowerCase() : "";
    return {
      ...file,
      baseMode: status === "added" ? null : "100644",
      baseType: status === "added" ? null : "blob",
      headMode: status === "deleted" ? null : "100644",
      headType: status === "deleted" ? null : "blob",
      treeModesComplete: true,
    };
  };
  const mergedContext = merged.context as Record<string, unknown>;
  for (const key of ["pullFiles", "semanticPullFiles"]) {
    const files = mergedContext[key];
    if (Array.isArray(files)) mergedContext[key] = files.map(withTreeIdentity);
  }
  return merged;
}

function record(overrides: Record<string, unknown> = {}) {
  return createReviewSemanticRecord(input(overrides));
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    reviewStatus: "complete",
    decision: "keep_open",
    lastFullReviewAt: new Date(NOW - DAY_MS).toISOString(),
    lastFullReviewDecision: "keep_open",
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  const priorRecord = record();
  return reviewSemanticCacheDecision({
    review: review(),
    priorRecord,
    currentRecord: priorRecord,
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    explicitDispatch: false,
    maintainerRequest: false,
    coordinationEnabled: true,
    now: NOW,
    ...overrides,
  });
}

test("TypeScript whitespace and ordinary comments do not perturb the semantic digest", () => {
  const plain = record();
  const reformatted = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            "@@ -1 +1,2 @@\n-const answer = 41;\n+// formatting-only explanation\n+const   answer=42;",
        },
      ],
    },
  });

  assert.equal(plain.eligible, true);
  assert.equal(reformatted.eligible, true);
  assert.equal(plain.codeDigest, reformatted.codeDigest);
  assert.notEqual(plain.exactDigest, reformatted.exactDigest);
});

test("semantic fingerprint uses the bounded full patch instead of prompt truncation", () => {
  const result = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-const answer = 41;\n+\n[truncated 20 chars]",
        },
      ],
      semanticPullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-const answer = 41;\n+const answer = 42;",
        },
      ],
    },
  });

  assert.equal(result.eligible, true);
  assert.equal(result.eligibilityReason, "eligible");
});

test("semantic TypeScript token changes bust the code digest", () => {
  const prior = record();
  const changed = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-const answer = 41;\n+const answer = 43;",
        },
      ],
    },
  });

  assert.notEqual(prior.codeDigest, changed.codeDigest);
  assert.equal(decision({ priorRecord: prior, currentRecord: changed }).reason, "code_changed");
});

test("Git tree mode changes bust the code digest and unsupported modes fail closed", () => {
  const prior = record();
  const executable = record({
    context: {
      pullFiles: [
        {
          ...input().context.pullFiles[0],
          baseMode: "100644",
          baseType: "blob",
          headMode: "100755",
          headType: "blob",
          treeModesComplete: true,
        },
      ],
    },
  });
  const symlink = record({
    context: {
      pullFiles: [
        {
          ...input().context.pullFiles[0],
          baseMode: "100644",
          baseType: "blob",
          headMode: "120000",
          headType: "blob",
          treeModesComplete: true,
        },
      ],
    },
  });
  const unavailable = record({
    context: {
      pullFiles: [{ ...input().context.pullFiles[0], treeModesComplete: false }],
    },
  });

  assert.notEqual(prior.codeDigest, executable.codeDigest);
  assert.equal(decision({ priorRecord: prior, currentRecord: executable }).reason, "code_changed");
  assert.equal(symlink.eligibilityReason, "unsupported_file_mode");
  assert.equal(unavailable.eligibilityReason, "incomplete_file_modes");
});

test("identical token edits at different source locations do not collide", () => {
  const firstBlock = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -10 +10 @@\n-return staleValue;\n+return freshValue;",
        },
      ],
    },
  });
  const secondBlock = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -200 +200 @@\n-return staleValue;\n+return freshValue;",
        },
      ],
    },
  });

  assert.equal(firstBlock.eligible, false);
  assert.equal(firstBlock.eligibilityReason, "lexical_ambiguity");
  assert.equal(secondBlock.eligible, false);
  assert.equal(secondBlock.eligibilityReason, "lexical_ambiguity");
  assert.notEqual(firstBlock.codeDigest, secondBlock.codeDigest);
});

test("TypeScript directives and shebangs remain semantic", () => {
  const ordinary = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const answer = 41;\n+// ordinary\n+const answer = 42;",
        },
      ],
    },
  });
  const directive = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            "@@ -1 +1,2 @@\n-const answer = 41;\n+// @ts-expect-error intentional\n+const answer = 42;",
        },
      ],
    },
  });
  const shebang = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const answer = 41;\n+#!/usr/bin/env node\n+const answer = 42;",
        },
      ],
    },
  });
  const sourceMapDirective = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            "@@ -1 +1,2 @@\n-const answer = 41;\n+const answer = 42;\n+//# sourceMappingURL=cache.js.map",
        },
      ],
    },
  });
  const referenceDirective = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            '@@ -1 +1,2 @@\n-const answer = 41;\n+/// <reference path="./types.d.ts" />\n+const answer = 42;',
        },
      ],
    },
  });

  assert.notEqual(ordinary.codeDigest, directive.codeDigest);
  assert.notEqual(ordinary.codeDigest, shebang.codeDigest);
  assert.notEqual(ordinary.codeDigest, sourceMapDirective.codeDigest);
  assert.notEqual(ordinary.codeDigest, referenceDirective.codeDigest);
});

test("Flow comment annotations remain semantic", () => {
  const numberType = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.js",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "@@ -1 +1 @@\n-function square(x /*: boolean */) { return x * x; }\n+function square(x /*: number */) { return x * x; }",
        },
      ],
    },
  });
  const stringType = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.js",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "@@ -1 +1 @@\n-function square(x /*: boolean */) { return x * x; }\n+function square(x /*: string */) { return x * x; }",
        },
      ],
    },
  });

  assert.equal(numberType.eligible, true);
  assert.equal(stringType.eligible, true);
  assert.notEqual(numberType.codeDigest, stringType.codeDigest);
});

test("tooling and bundler magic comments remain semantic", () => {
  const ordinary = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            '@@ -1 +1,2 @@\n-const chunk = import("./cache");\n+// load the cache chunk\n+const chunk = import("./cache");',
        },
      ],
    },
  });
  const webpack = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            '@@ -1 +1,2 @@\n-const chunk = import("./cache");\n+/* webpackChunkName: "cache" */\n+const chunk = import("./cache");',
        },
      ],
    },
  });
  const pure = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "@@ -1 +1 @@\n-const value = buildCache();\n+const value = /*#__PURE__*/ buildCache();",
        },
      ],
    },
  });
  const legal = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            "@@ -1 +1,2 @@\n-const value = buildCache();\n+/*! required attribution */\n+const value = buildCache();",
        },
      ],
    },
  });

  assert.notEqual(ordinary.codeDigest, webpack.codeDigest);
  assert.notEqual(ordinary.codeDigest, pure.codeDigest);
  assert.notEqual(ordinary.codeDigest, legal.codeDigest);
});

test("tooling directives retain their exact syntax attachment", () => {
  const beforeNew = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "@@ -1 +1 @@\n-const value = buildCache();\n+const value = /*#__PURE__*/ new Cache();",
        },
      ],
    },
  });
  const afterNew = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "@@ -1 +1 @@\n-const value = buildCache();\n+const value = new /*#__PURE__*/ Cache();",
        },
      ],
    },
  });

  assert.equal(beforeNew.eligible, true);
  assert.equal(afterNew.eligible, true);
  assert.notEqual(beforeNew.codeDigest, afterNew.codeDigest);
});

test("global declarations and formatter controls remain semantic", () => {
  const ordinary = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const value = Cache;\n+// ordinary\n+const value = Cache;",
        },
      ],
    },
  });
  const globalDeclaration = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const value = Cache;\n+/* global Cache */\n+const value = Cache;",
        },
      ],
    },
  });
  const denoFormatter = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const value = Cache;\n+// deno-fmt-ignore\n+const value = Cache;",
        },
      ],
    },
  });
  const oxlintControl = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            "@@ -1 +1,2 @@\n-const value = Cache;\n+// oxlint-disable-next-line no-undef\n+const value = Cache;",
        },
      ],
    },
  });
  const oxfmtControl = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const value = Cache;\n+// oxfmt-ignore\n+const value = Cache;",
        },
      ],
    },
  });
  const v8Control = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch:
            "@@ -1 +1,2 @@\n-const value = Cache;\n+/* v8 ignore next */\n+const value = Cache;",
        },
      ],
    },
  });
  const noSonarControl = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-const value = Cache;\n+// NOSONAR\n+const value = Cache;",
        },
      ],
    },
  });

  assert.notEqual(ordinary.codeDigest, globalDeclaration.codeDigest);
  assert.notEqual(ordinary.codeDigest, denoFormatter.codeDigest);
  assert.notEqual(ordinary.codeDigest, oxlintControl.codeDigest);
  assert.notEqual(ordinary.codeDigest, oxfmtControl.codeDigest);
  assert.notEqual(ordinary.codeDigest, v8Control.codeDigest);
  assert.notEqual(ordinary.codeDigest, noSonarControl.codeDigest);
});

test("structured JSON ignores formatting but preserves object order", () => {
  const compact = record({
    context: {
      pullFiles: [
        {
          filename: "config.json",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-{"enabled":false}\n+{"enabled":true,"limit":2}',
        },
      ],
    },
  });
  const formatted = record({
    context: {
      pullFiles: [
        {
          filename: "config.json",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-{ "enabled": false }\n+{ "enabled": true, "limit": 2 }',
        },
      ],
    },
  });
  const reordered = record({
    context: {
      pullFiles: [
        {
          filename: "config.json",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-{ "enabled": false }\n+{ "limit": 2, "enabled": true }',
        },
      ],
    },
  });

  assert.equal(compact.eligible, true);
  assert.equal(formatted.eligible, true);
  assert.equal(compact.codeDigest, formatted.codeDigest);
  assert.notEqual(compact.codeDigest, reordered.codeDigest);
});

test("compiler AST distinguishes regex, template, JSX, and shift semantics", () => {
  const cases = [
    {
      name: "regular expression",
      filename: "src/cache.ts",
      before: "const pattern = /old/;",
      after: "const pattern = /a b/;",
      changed: "const pattern = /a  b/;",
    },
    {
      name: "interpolated template",
      filename: "src/cache.ts",
      before: "const value = `old ${input}`;",
      after: "const value = `new ${input}`;",
      changed: "const value = `new  ${input}`;",
    },
    {
      name: "JSX",
      filename: "src/cache.tsx",
      before: "const view = <p>old</p>;",
      after: "const view = <p>new</p>;",
      changed: "const view = <p>new value</p>;",
    },
    {
      name: "shift operator",
      filename: "src/cache.ts",
      before: "const value = input;",
      after: "const value = input >> 1;",
      changed: "const value = input > > 1;",
    },
    {
      name: "prefix unary operator",
      filename: "src/cache.ts",
      before: "const value = input;",
      after: "const value = +input;",
      changed: "const value = -input;",
    },
    {
      name: "type-only import",
      filename: "src/cache.ts",
      before: 'import type { Cache } from "./cache.js";',
      after: 'import type { Cache } from "./cache.js";',
      changed: 'import { Cache } from "./cache.js";',
    },
    {
      name: "auto accessor",
      filename: "src/cache.ts",
      before: "class Cache { value = 1; }",
      after: "class Cache { accessor value = 1; }",
      changed: "class Cache { value = 1; }",
    },
  ];

  for (const entry of cases) {
    const baseline = record({
      context: {
        pullFiles: [
          {
            filename: entry.filename,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: `@@ -1 +1 @@\n-${entry.before}\n+${entry.after}`,
          },
        ],
      },
    });
    const changed = record({
      context: {
        pullFiles: [
          {
            filename: entry.filename,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: `@@ -1 +1 @@\n-${entry.before}\n+${entry.changed}`,
          },
        ],
      },
    });
    assert.equal(baseline.eligible, true, entry.name);
    assert.notEqual(baseline.codeDigest, changed.codeDigest, entry.name);
  }
});

test("partial lexical context and compiler parse errors fail closed", () => {
  const isolated = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -20 +20 @@\n-// inside a possible template\n+// changed runtime text",
        },
      ],
    },
  });
  const malformed = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-const value = 1;\n+const value = ;",
        },
      ],
    },
  });

  for (const result of [isolated, malformed]) {
    assert.equal(result.eligible, false);
    assert.equal(result.eligibilityReason, "lexical_ambiguity");
  }
});

test("ASI-significant line terminators remain semantic", () => {
  const newline = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-return staleValue;\n+return\n+{ fresh: true };",
        },
      ],
    },
  });
  const inline = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-return staleValue;\n+return { fresh: true };",
        },
      ],
    },
  });

  assert.equal(newline.eligible, true);
  assert.equal(inline.eligible, true);
  assert.notEqual(newline.codeDigest, inline.codeDigest);
});

test("unary source lines are counted inside parsed hunks", () => {
  const result = record({
    context: {
      pullFiles: [
        {
          filename: "src/cache.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n---value;\n+++value;",
        },
      ],
    },
  });

  assert.equal(result.eligible, true);
  assert.equal(result.eligibilityReason, "eligible");
});

test("ambiguous, truncated, binary, unsupported, deleted, renamed, and missing patches fail closed", () => {
  const cases = [
    {
      reason: "lexical_ambiguity",
      file: {
        filename: "src/cache.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-const value = "ok";\n+const value = "unterminated;',
      },
    },
    {
      reason: "truncated_patch",
      file: {
        filename: "src/cache.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n\n[truncated 40 chars]",
      },
    },
    {
      reason: "binary_patch",
      file: {
        filename: "src/cache.ts",
        status: "modified",
        patch: "Binary files a/src/cache.ts and b/src/cache.ts differ",
      },
    },
    {
      reason: "unsupported_language",
      file: {
        filename: "style.css",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-color: red;\n+color: blue;",
      },
    },
    {
      reason: "deleted_file",
      file: {
        filename: "src/cache.ts",
        status: "removed",
        patch: "@@ -1 +0,0 @@\n-const value = 1;",
      },
    },
    {
      reason: "renamed_file",
      file: {
        filename: "src/new.ts",
        previous_filename: "src/old.ts",
        status: "renamed",
        patch: "@@ -1 +1 @@\n-const value = 1;\n+const value = 1;",
      },
    },
    {
      reason: "missing_patch",
      file: {
        filename: "src/cache.ts",
        status: "modified",
      },
    },
    {
      reason: "malformed_patch",
      file: {
        filename: "src/cache.ts",
        status: "modified",
        patch: "@@ malformed @@\n-old\n+new",
      },
    },
  ];

  for (const entry of cases) {
    const result = record({
      context: {
        pullFiles: [entry.file],
      },
    });
    assert.equal(result.eligible, false, entry.reason);
    assert.equal(result.eligibilityReason, entry.reason);
    assert.match(result.exactDigest, /^[0-9a-f]{64}$/);
  }
});

test("incomplete file hydration and mutable check context disable semantic reuse", () => {
  const truncated = record({
    context: {
      counts: {
        ...input().context.counts,
        pullFiles: 2,
        pullFilesHydrated: 1,
        pullFilesTruncated: true,
      },
    },
  });
  const missingChecks = record({
    context: {
      pullChecks: { complete: false },
    },
  });
  const truncatedCommits = record({
    context: {
      counts: {
        ...input().context.counts,
        pullCommitsTruncated: true,
      },
    },
  });
  const incompleteRelation = record({
    context: {
      relatedItems: [
        {
          number: 456,
          mentionedIn: ["item body"],
          error: "GitHub request failed",
        },
      ],
    },
  });

  assert.equal(truncated.eligibilityReason, "incomplete_file_list");
  assert.equal(missingChecks.eligibilityReason, "incomplete_checks");
  assert.equal(truncatedCommits.eligibilityReason, "incomplete_review_context");
  assert.equal(incompleteRelation.eligibilityReason, "incomplete_review_context");
  assert.equal(
    decision({ priorRecord: record(), currentRecord: missingChecks }).reason,
    "semantic_ineligible",
  );
});

test("unknown release state disables semantic reuse", () => {
  const unknownRelease = record({
    git: {
      mainSha: "e".repeat(40),
      releaseStateComplete: false,
      latestRelease: null,
    },
  });

  assert.equal(unknownRelease.eligible, false);
  assert.equal(unknownRelease.eligibilityReason, "incomplete_release_state");
  assert.equal(
    decision({ priorRecord: record(), currentRecord: unknownRelease }).reason,
    "semantic_ineligible",
  );
});

test("changed discussion, reviews, checks, or target context busts the context digest", () => {
  const prior = record();
  const changedDiscussion = record({
    context: {
      comments: [
        { author: "maintainer", authorAssociation: "MEMBER", body: "This still needs work." },
      ],
    },
  });
  const changedChecks = record({
    context: {
      pullChecks: {
        complete: true,
        checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }],
        checkRunsTruncated: false,
        statuses: [{ context: "ci", state: "failure" }],
        statusesTruncated: false,
      },
    },
  });
  const changedReviews = record({ structuralContextRevision: "b".repeat(64) });
  const changedRelation = record({
    context: {
      relatedItems: [
        {
          mentionedIn: ["item body"],
          issue: { number: 456, state: "closed", title: "Related issue" },
        },
      ],
    },
  });
  const changedTarget = record({
    git: {
      mainSha: "1".repeat(40),
      releaseStateComplete: true,
      latestRelease: { tagName: "v1.0.0", sha: "f".repeat(40) },
    },
  });

  for (const currentRecord of [
    changedDiscussion,
    changedChecks,
    changedReviews,
    changedRelation,
    changedTarget,
  ]) {
    assert.notEqual(prior.contextDigest, currentRecord.contextDigest);
    assert.equal(decision({ priorRecord: prior, currentRecord }).reason, "context_changed");
  }
});

test("head SHA churn alone does not perturb semantic or context digests", () => {
  const prior = record();
  const rebased = record({
    context: {
      pullRequest: {
        ...input().context.pullRequest,
        head: { ref: "feature", sha: "1".repeat(40) },
      },
      pullCommits: [{ sha: "2".repeat(40), author: "contributor", message: "perf: cache it" }],
    },
  });

  assert.equal(prior.codeDigest, rebased.codeDigest);
  assert.equal(prior.contextDigest, rebased.contextDigest);
  assert.equal(decision({ priorRecord: prior, currentRecord: rebased }).hit, true);
});

test("mutable item timestamps do not perturb semantic context", () => {
  const prior = record({
    item: {
      ...input().item,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  });
  const refreshed = record({
    item: {
      ...input().item,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    },
  });

  assert.equal(prior.contextDigest, refreshed.contextDigest);
  assert.equal(decision({ priorRecord: prior, currentRecord: refreshed }).hit, true);
});

test("full commit message changes bust context beyond prompt truncation", () => {
  const prior = record();
  const changedSuffix = record({
    context: {
      pullCommits: [
        {
          sha: "2".repeat(40),
          author: "contributor",
          message: "x".repeat(1000),
        },
      ],
      pullCommitsRevision: "c".repeat(64),
    },
  });

  assert.notEqual(prior.contextDigest, changedSuffix.contextDigest);
  assert.equal(
    decision({ priorRecord: prior, currentRecord: changedSuffix }).reason,
    "context_changed",
  );
});

test("explicit reruns, maintainer prompts, policy changes, and close reports never reuse", () => {
  assert.equal(decision({ explicitDispatch: true }).reason, "explicit_dispatch");
  assert.equal(decision({ maintainerRequest: true }).reason, "maintainer_request");
  assert.equal(decision({ reviewPolicy: "policy-2" }).reason, "policy_changed");
  assert.equal(decision({ review: review({ decision: "close" }) }).reason, "non_keep_open_verdict");
});

test("stale, failed, and future-dated reviews never reuse", () => {
  assert.equal(
    decision({ review: review({ reviewStatus: "failed" }) }).reason,
    "incomplete_review",
  );
  assert.equal(
    decision({
      review: review({ lastFullReviewAt: new Date(NOW - 14 * DAY_MS).toISOString() }),
    }).reason,
    "stale_review",
  );
  assert.equal(
    decision({
      review: review({ lastFullReviewAt: new Date(NOW + DAY_MS).toISOString() }),
    }).reason,
    "stale_review",
  );
});

test("post-lease revalidation catches mutable context drift", () => {
  const initialRecord = record();
  const currentRecord = record({
    context: {
      pullChecks: {
        complete: true,
        checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }],
        checkRunsTruncated: false,
        statuses: [],
        statusesTruncated: false,
      },
    },
  });

  assert.deepEqual(
    reviewSemanticRevalidationDecision({
      initialRecord,
      currentRecord,
      reviewPolicy: "policy-1",
      reviewModel: "gpt-5.6",
    }),
    { hit: false, reason: "context_changed" },
  );
});
