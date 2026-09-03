import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  configSurfaceChangeFromPullFilesForTest,
  dataModelChangeFromPullFilesForTest,
  parseDecision,
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
  sqliteSchemaChangeFromPullFilesForTest,
} from "../dist/clawsweeper.js";
import { createReportDocumentRendering } from "../dist/clawsweeper-report-document.js";
import { createReportContextRendering } from "../dist/clawsweeper-report-context.js";
import { createDashboardPresentation } from "../dist/clawsweeper-dashboard.js";
import { closeDecision, item, reviewReportFrontMatter as reportFrontMatter } from "./helpers.ts";
import { hydratePrimaryBody } from "./primary-body-fixture.ts";
import { namedTestRoles, pinnedTestRolePaths } from "./openclaw-file-role-fixture.ts";

test("config test roles are excluded before inspecting assertion, key-like, or incomplete patches", () => {
  const filenames = [
    "src/config/schema.test.ts",
    "src/config/types.spec.ts",
    "src/config/zod-schema.e2e.test.ts",
    ...namedTestRoles.flatMap((role) => [
      `src/config/schema.${role}.ts`,
      `src/config/types-${role}.ts`,
      `src/config/zod-schema-${role}.ts`,
      `src/config/${role}/schema.ts`,
    ]),
    ...["test", "tests", "__tests__"].map((directory) => `src/config/${directory}/schema.ts`),
    ...pinnedTestRolePaths,
  ];
  const patches = [
    undefined,
    "",
    "@@\n context only",
    "@@\n+// comment only",
    "@@\n+  expect(result).toEqual(expected);",
    "@@\n+  allowedProviders: z.string(),",
    "@@\n+  allowedProviders: z.string(),\n\n[truncated 99 chars]",
    `@@\n${" // retained context\n".repeat(110)}+  allowedProviders: z.string(),`,
  ];
  for (const filename of filenames) {
    for (const patch of patches) {
      for (const normalized of [false, true]) {
        const files = [{ filename, patch }];
        const pullFiles = normalized
          ? hydratePrimaryBody("", "pull_request", { pullFiles: files }).context.pullFiles
          : files;
        assert.deepEqual(
          configSurfaceChangeFromPullFilesForTest({ pullFiles }),
          { change: false, keys: [] },
          `${filename}: ${normalized ? "normalized" : "raw"} ${patch}`,
        );
      }
    }
  }
});

test("config production names retain keys and conservative patch uncertainty", () => {
  const filenames = [
    "src/config/schema.ts",
    "src/config/types.ts",
    "src/config/zod-schema.ts",
    "src/config/schema.generated.ts",
    "src/config/schema.test-support.production.ts",
    "src/config/schema.test-supportive.ts",
    "src/config/schema.TEST.ts",
    ...["support", "helper", "helpers", "harness", "fixtures", "utils"].map(
      (role) => `src/config/schema.${role}.ts`,
    ),
  ];
  const cases = [
    [undefined, ["unknown-config-surface-change"]],
    ["", ["unknown-config-surface-change"]],
    ["@@\n context only", ["unknown-config-surface-change"]],
    ["@@\n+// comment only", []],
    ["@@\n+  allowedProviders: z.string(),", ["allowedProviders"]],
    [
      "@@\n+  allowedProviders: z.string(),\n\n[truncated 99 chars]",
      ["allowedProviders", "unknown-config-surface-change"],
    ],
  ] as const;
  for (const filename of filenames) {
    for (const [patch, keys] of cases) {
      assert.deepEqual(
        configSurfaceChangeFromPullFilesForTest({ pullFiles: [{ filename, patch }] }),
        { change: keys.length > 0, keys },
        filename,
      );
    }
  }
  const pullFiles = hydratePrimaryBody("", "pull_request", {
    pullFiles: [
      {
        filename: "src/config/schema.ts",
        patch: `@@\n${" // retained context\n".repeat(110)}+  allowedProviders: z.string(),`,
      },
    ],
  }).context.pullFiles;
  assert.match(pullFiles[0].patch, /\[truncated \d+ chars\]$/);
  assert.deepEqual(configSurfaceChangeFromPullFilesForTest({ pullFiles }), {
    change: true,
    keys: ["unknown-config-surface-change"],
  });
});

test("config rename candidates retain production and semantic docs evidence on either side", () => {
  const cases = [
    ["src/config/schema.ts", "src/config/schema.test-support.ts", true],
    ["src/config/schema.test-support.ts", "src/config/schema.ts", true],
    ["src/config/schema.test.ts", "src/config/schema.test-support.ts", false],
    ["src/config/schema.test-support.ts", "src/config/schema.test.ts", false],
    ["docs/gateway/configuration.md", "src/config/schema.test-support.ts", true],
    ["src/config/schema.test-support.ts", "docs/gateway/configuration.md", true],
    ["docs/plugins/manifest.md", "src/config/schema.test.ts", true],
    ["src/config/schema.test.ts", "docs/plugins/manifest.md", true],
  ] as const;
  for (const [previous_filename, filename, production] of cases) {
    for (const patch of [
      undefined,
      "",
      "@@\n+| `agents.defaults.model` | Default model. |",
      "@@\n+| `agents.defaults.model` | Default model. |\n\n[truncated 99 chars]",
    ]) {
      const keys = production
        ? [
            ...(patch ? ["agents.defaults.model"] : []),
            ...(!patch || patch.includes("[truncated") ? ["unknown-config-surface-change"] : []),
          ]
        : [];
      assert.deepEqual(
        configSurfaceChangeFromPullFilesForTest({
          pullFiles: [{ filename, previous_filename, patch }],
        }),
        { change: keys.length > 0, keys },
        `${previous_filename} -> ${filename}`,
      );
    }
  }
});

test("config test filtering preserves file-list uncertainty and caller path policy", () => {
  for (const pullFiles of [undefined, [], [{ filename: "src/config/schema.test.ts" }]]) {
    for (const pullFilesTruncated of [undefined, false, true]) {
      const keys = pullFilesTruncated ? ["unknown-truncated-pull-files"] : [];
      assert.deepEqual(configSurfaceChangeFromPullFilesForTest({ pullFiles, pullFilesTruncated }), {
        change: keys.length > 0,
        keys,
      });
    }
  }
  for (const [filename, change] of [
    [" src/config/schema.ts ", true],
    ["src\\config\\schema.ts", false],
    ["src/CONFIG/schema.ts", false],
    ["scripts/schema.ts", false],
    ["src/config/schema.mts", false],
    ["src/config/schema.tsx", false],
    ["docs/gateway/configuration.test-support.md", true],
  ] as const) {
    assert.equal(
      configSurfaceChangeFromPullFilesForTest({ pullFiles: [{ filename }] }).change,
      change,
      filename,
    );
  }
  assert.deepEqual(
    configSurfaceChangeFromPullFilesForTest({
      repo: "openclaw/clawhub",
      pullFilesTruncated: true,
      pullFiles: [{ filename: "src/config/schema.ts" }],
    }),
    { change: false, keys: [] },
  );
});

function persistenceReport(detection: { change: boolean; surfaces: string[] }, headSha: string) {
  return `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "132718",
    decision: "keep_open",
    close_reason: "none",
    work_candidate: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    pull_head_sha: headSha,
    real_behavior_proof_status: "sufficient",
    real_behavior_proof_needs_contributor_action: "false",
    data_model_change: String(detection.change),
    data_model_surfaces: JSON.stringify(detection.surfaces),
  })}\n\n## Summary\n\nReview completed.\n\n## Review Findings\n\nOverall correctness: patch is correct\n\nOverall confidence: 0.9\n\nFull review comments:\n\n- none\n`;
}

function renderPersistenceReport(
  pullFiles: unknown[],
  headSha: string,
  pullFilesTruncated = false,
) {
  const document = createReportDocumentRendering({
    ...createReportContextRendering({} as never),
    ...createDashboardPresentation({} as never),
    prSurfaceFilesFromContext: () => [],
    compactPullFilePaths: (file) => [file.filename],
    confidenceText: String,
    fixedInText: () => "unknown",
    formatTimestamp: String,
    labelJustificationsMarkdown: () => "- none",
    linkedSha: String,
    markdownLink: (label, url) => `[${label}](${url})`,
    publicLikelyOwnerRole: String,
    pullHeadShaFromContext: () => headSha,
    reviewStructuralPullStateFromContext: () => null,
    sentence: String,
    sha256: () => "synthetic-digest",
  } as Parameters<typeof createReportDocumentRendering>[0]);
  return document.markdownFor({
    item: item({
      kind: "pull_request",
      url: "https://github.com/openclaw/openclaw/pull/123",
      labels: ["clawsweeper:automerge"],
    }),
    decision: {
      ...parseDecision(
        closeDecision({
          decision: "keep_open",
          closeReason: "none",
          summary: "Review completed.",
          changeSummary: "Changes runtime fields.",
          evidence: [],
          overallCorrectness: "patch is correct",
          workReason: "",
          nextStep: { kind: "none", text: "" },
          realBehaviorProof: {
            status: "sufficient",
            summary: "Synthetic runtime proof is sufficient; no upgrade proof is supplied.",
            evidenceKind: "terminal",
            needsContributorAction: false,
          },
        }),
      ),
      localCheckoutAccess: "verified",
    },
    context: {
      issue: {},
      comments: [],
      timeline: [],
      pullFiles,
      counts: { comments: 0, timeline: 0, pullFilesTruncated },
    },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: { actionTaken: "kept_open" },
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    reviewLeaseOwner: "synthetic-lease",
    reviewLeaseCommentId: 123,
    runtime: { model: "Codex", reasoningEffort: "high" },
  } as Parameters<typeof document.markdownFor>[0]);
}

for (const [name, fixturePath, normalizationTruncates] of [
  ["pane-local diagnostics", "./fixtures/persistence-classifier-132718.json", true],
  ["test-support workspace guard", "./fixtures/persistence-classifier-133209.json", true],
  ["Go chunk diagnostics", "./fixtures/persistence-classifier-134934.json", false],
  ["retained image runtime fields", "./fixtures/persistence-classifier-132839.json", true],
  ["worker input layout fields", "./fixtures/persistence-classifier-132839-workers.json", true],
  ["hovercard promise cancellation", "./fixtures/persistence-classifier-136772.json", false],
] as const) {
  for (const normalized of [false, true]) {
    test(`${name} creates no stored-data warning or migration gate (${normalized ? "production-normalized" : "full"} patch)`, () => {
      const fixture = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), "utf8"));
      const pullFiles = normalized
        ? hydratePrimaryBody("", "pull_request", { pullFiles: fixture.pullFiles }).context.pullFiles
        : fixture.pullFiles;
      if (normalized) {
        assert.equal(
          pullFiles.some((file) => /\[truncated \d+ chars\]$/.test(file.patch)),
          normalizationTruncates,
        );
      }
      const detection = dataModelChangeFromPullFilesForTest({ pullFiles });
      const report = renderPersistenceReport(pullFiles, fixture.headSha ?? fixture.mergeCommit);
      const comment = renderReviewCommentFromReport(report, "none");
      // Check the contributor-visible consequence before the classification detail.
      assert.doesNotMatch(
        comment,
        /Persistent data-model change detected|### Stored data model|Confirm migration/,
      );
      assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
      assert.doesNotMatch(reviewAutomationMarkersFromReport(report), /needs-human|fix-required/);
      assert.match(report, /^data_model_change: false$/m);
      assert.match(comment, /clawsweeper-review-state:ready/);
      assert.deepEqual(detection, { change: false, surfaces: [] });
      assert.deepEqual(sqliteSchemaChangeFromPullFilesForTest({ pullFiles }), {
        change: false,
        files: [],
      });
    });
  }
}

test("runtime state names and typed parameters alone do not establish stored data", () => {
  const patch =
    "@@\n+function show(\n+  state: ViewState,\n+  session: string,\n+) { return state; }";
  for (const filename of [
    "ui/src/state.ts",
    "src/runtime/session.ts",
    "ui/src/history/merge.ts",
    "src/runtime/metadata.ts",
    "src/runtime/row-id.ts",
    "src/runtime/document-id.ts",
    "src/runtime/chunk-id.ts",
    "ui/src/cache.ts",
    "src/cache/helpers.ts",
    "src/caches/request.ts",
    "src/cache-key.ts",
    "src/cache_version.ts",
    "src/cache.helper.ts",
  ]) {
    for (const evidence of [patch, "", `${patch}\n\n[truncated 90 chars]`, undefined]) {
      const pullFiles = [
        { filename, previous_filename: "ui/src/session-view.ts", patch: evidence },
      ];
      const detection = dataModelChangeFromPullFilesForTest({ pullFiles });
      assert.deepEqual(detection, { change: false, surfaces: [] }, filename);
      assert.match(
        renderReviewCommentFromReport(renderPersistenceReport(pullFiles, "a".repeat(40)), "none"),
        /clawsweeper-review-state:ready/,
      );
    }
  }
});

for (const [name, patch] of [
  ["missing", undefined],
  ["empty", ""],
  ["truncated", "@@\n+  prompt: value,\n\n[truncated 99 chars]"],
] as const) {
  test(`worker request fields do not imply stored data (${name} patch)`, () => {
    const detection = dataModelChangeFromPullFilesForTest({
      pullFiles: [{ filename: "src/workers/turn.ts", patch }],
    });
    const report = persistenceReport(detection, "a".repeat(40));
    assert.doesNotMatch(
      renderReviewCommentFromReport(report, "none"),
      /Persistent data-model change detected|### Stored data model|Confirm migration/,
    );
    assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
    assert.deepEqual(detection, { change: false, surfaces: [] });
  });
}

test("generic metadata, cache keys, versions, and TTL do not warn or gate without storage evidence", () => {
  for (const name of [
    "metadata",
    "documentId",
    "chunkID",
    "collection",
    "dimension",
    "rowId",
    "cache",
    "cacheKey",
    "cacheVersion",
    "cacheNamespace",
    "cache_key",
    "cache_version",
    "cache_namespace",
    "ttl",
  ]) {
    for (const patch of [
      `@@\n+  ${name}: value,`,
      `@@\n+log.Printf("rejected %s", ${name})`,
      `@@\n+const ${name} = input;`,
      `@@\n localStorage.getItem("preferences");\n@@\n+  ${name}: value,`,
      `@@\n const cacheSchema = { revision: 1 };\n@@\n+  ${name}: value,`,
    ]) {
      const pullFiles = [{ filename: "scripts/translation/diagnostics.go", patch }];
      const detection = dataModelChangeFromPullFilesForTest({ pullFiles });
      const report = persistenceReport(detection, "a".repeat(40));
      assert.doesNotMatch(renderReviewCommentFromReport(report, "none"), /Confirm migration/);
      assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
      assert.deepEqual(detection, { change: false, surfaces: [] }, `${name}: ${patch}`);
    }
  }
});

test("storage evidence still warns and gates browser, runtime, and schema changes", () => {
  const cases = [
    {
      filename: "ui/src/state.ts",
      patch:
        '@@\n+const owners = new WeakMap<object, string>();\n+// Display ownership only.\n+localStorage.setItem("preferences", JSON.stringify(value));',
      surface: "serialized state",
    },
    {
      filename: "ui/src/history.ts",
      patch: '@@\n-sessionStorage.setItem("history", value);',
      surface: "serialized state",
    },
    {
      filename: "ui/src/session.ts",
      patch: '@@\n+indexedDB.open("sessions", 2);',
      surface: "serialized state",
    },
    {
      filename: "ui/src/preferences.ts",
      patch:
        '@@ -1,3 +1,3 @@\n localStorage.setItem("preferences", JSON.stringify({\n-  theme: "dark",\n+  theme: "system",\n }));\n@@ -40,3 +40,4 @@\n function show(\n   title: string,\n+  subtitle: string,\n ) {',
      surface: "serialized state",
    },
    {
      filename: "src/runtime/snapshot.ts",
      patch: '@@\n await state.storage.put("snapshot", {\n+  revision: nextRevision,\n });',
      surface: "durable storage schema",
    },
    {
      filename: "src/workers/snapshot.ts",
      patch: '@@\n await state.storage.put("snapshot", {\n+  revision: nextRevision,\n });',
      surface: "durable storage schema",
    },
    {
      filename: "src/workers/room.ts",
      patch: "@@\n+class Room extends DurableObject {\n+  revision: number;\n+}",
      surface: "durable storage schema",
    },
    {
      filename: "src/gateway/protocol/schema/session.ts",
      patch: "@@\n-  schemaVersion: 1,\n+  schemaVersion: 2,",
      surface: "database schema",
    },
    {
      filename: "src/gateway/protocol/schema/session.ts",
      patch: "@@\n+  migrate(session);",
      surface: "migration/backfill/repair",
    },
    {
      filename: "src/db/migrations/002.sql",
      patch: "@@\n+ALTER TABLE sessions ADD COLUMN revision INTEGER;",
      surface: "database schema",
    },
    {
      filename: "src/runtime/database.ts",
      patch: "@@\n CREATE TABLE sessions (\n+  revision INTEGER,\n );",
      surface: "database schema",
    },
    {
      filename: "src/db/schema.ts",
      patch: '@@\n+const revision = integer("revision").notNull();',
      surface: "database schema",
    },
    {
      filename: "src/persistence/session.ts",
      patch: "@@\n+export type Session = { lastModel?: string };",
      surface: "serialized state",
    },
    {
      filename: "src/memory/vector-store.ts",
      patch: "@@\n-  embeddingDimension: 768,\n+  embeddingDimension: 1024,",
      surface: "vector/embedding metadata",
    },
    {
      filename: "src/memory/vector-store.ts",
      patch: '@@\n+console.log("rejected", chunkId);\n+  metadata: row.metadata,',
      surface: "vector/embedding metadata",
    },
    {
      filename: "src/runtime/records.ts",
      patch: "@@\n-  embeddingDimension: 768,\n+  embeddingDimension: 1024,",
      surface: "vector/embedding metadata",
    },
    {
      filename: "docs/search.md",
      patch: "@@\n+The vector schema now includes a revision field.",
      surface: "vector/embedding metadata",
    },
    {
      filename: "scripts/translation/records.go",
      patch: '@@\n+log.Printf("rejected %s", chunkID)\n+CREATE TABLE chunks (id TEXT);',
      surface: "database schema",
    },
    {
      filename: "src/runtime/records.ts",
      patch:
        '@@\n+console.log("rejected", chunkId);\n await state.storage.put("snapshot", {\n+  metadata: nextMetadata,\n });',
      surface: "durable storage schema",
    },
    {
      filename: "src/db/schema.sql",
      patch: "@@\n+CREATE INDEX sessions_updated ON sessions(updated_at);",
      surface: "database schema",
    },
    {
      filename: "src/cache/schema.ts",
      patch: "@@\n-  ttl: 86400,\n+  ttl: 3600,",
      surface: "persistent cache schema",
    },
    {
      filename: "src/cache/helpers.ts",
      patch: '@@\n writeFile("cache.json", JSON.stringify({\n+  expiresAt: now,\n }));',
      surface: "serialized state",
    },
    {
      filename: "ui/src/cache.ts",
      patch: "@@\n const cacheSchema = {\n+  revision: 2,\n };",
      surface: "persistent cache schema",
    },
    {
      filename: "src/runtime/preview.ts",
      patch: "@@\n+  cache_schema: 2,",
      surface: "persistent cache schema",
    },
    {
      filename: "ui/src/cache.ts",
      patch:
        '@@\n const cache = new Map();\n cache.set(key, {\n+  signal: controller.signal,\n });\n@@\n localStorage.setItem("cache", JSON.stringify({\n+  expiresAt: now,\n }));',
      surface: "serialized state",
    },
    {
      filename: "ui/src/cache.ts",
      patch:
        '@@\n const cache = new Map();\n const store: IDBObjectStore = transaction.objectStore("previews");\n store.put({\n+  expiresAt: now,\n });',
      surface: "serialized state",
    },
    {
      filename: "src/cache/helpers.ts",
      patch: '@@\n await state.storage.put("cache", {\n+  expiresAt: now,\n });',
      surface: "durable storage schema",
    },
    {
      filename: "docs/storage.md",
      patch: "@@\n+The cache schema now includes a revision field.",
      surface: "persistent cache schema",
    },
    {
      filename: "src/runtime/metadata.ts",
      patch: '@@\n localStorage.setItem("preferences", JSON.stringify({\n+  revision: 2,\n }));',
      surface: "serialized state",
    },
    {
      filename: "src/runtime/row-id.ts",
      patch: "@@\n CREATE TABLE sessions (\n+  revision INTEGER,\n );",
      surface: "database schema",
    },
    {
      filename: "src/runtime/document-id.ts",
      patch: '@@\n await state.storage.put("snapshot", {\n+  revision: nextRevision,\n });',
      surface: "durable storage schema",
    },
    {
      filename: "src/runtime/chunk-id.ts",
      patch: "@@\n-  embeddingDimension: 768,\n+  embeddingDimension: 1024,",
      surface: "vector/embedding metadata",
    },
    ...["vector", "embedding", "embeddings", "memory"].map((owner) => ({
      filename: `src/${owner}/records.ts`,
      patch: "@@\n+  metadata: row.metadata,",
      surface: "vector/embedding metadata",
    })),
  ];
  for (const { surface, ...file } of cases) {
    const pullFiles = hydratePrimaryBody("", "pull_request", { pullFiles: [file] }).context
      .pullFiles;
    const detection = dataModelChangeFromPullFilesForTest({ pullFiles });
    assert.ok(detection.surfaces.includes(`${surface}: ${file.filename}`), file.filename);
    if (file.patch.includes("TABLE")) {
      assert.equal(sqliteSchemaChangeFromPullFilesForTest({ pullFiles }).change, true);
    }
    const report = renderPersistenceReport(pullFiles, "a".repeat(40));
    const comment = renderReviewCommentFromReport(report, "none");
    assert.match(report, /^data_model_change: true$/m);
    assert.match(comment, /- \[ \] \*\*Add data-model compatibility proof\*\*/);
    assert.match(comment, /clawsweeper-review-state:blocked/);
    if (file.patch.includes("TABLE")) assert.match(comment, /SQLite table change/);
    const markers = reviewAutomationMarkersFromReport(report);
    assert.match(markers, /clawsweeper-verdict:needs-human/);
    assert.doesNotMatch(markers, /clawsweeper-verdict:pass|clawsweeper-action:fix-required/);
  }
});

test("strong persistence evidence remains unknown when production normalization loses content", () => {
  for (const file of [
    { filename: "ui/src/persistence/preferences.ts" },
    { filename: "src/durable-objects/room.ts" },
    { filename: "src/storage/room.ts" },
    { filename: "src/workers/room.ts", previous_filename: "src/storage/room.ts" },
    { filename: "src/gateway/protocol/schema/session.ts" },
    { filename: "ui/src/display.ts", previous_filename: "ui/src/storage/state.ts" },
    { filename: "ui/src/storage/state.ts", previous_filename: "ui/src/display.ts" },
    { filename: "ui/src/display.ts", patch: '@@\n localStorage.getItem("preferences");\n' },
    { filename: "src/vector/records.ts" },
    { filename: "src/embedding/records.ts" },
    { filename: "src/embeddings/records.ts" },
    { filename: "src/memory/records.ts" },
    { filename: "src/cache/schema.ts" },
    { filename: "src/cache-schema.ts" },
    { filename: "ui/src/cache.ts", previous_filename: "src/cache/schema.ts" },
    { filename: "src/cache/schema.ts", previous_filename: "ui/src/cache.ts" },
    { filename: "ui/src/cache.ts", patch: "@@\n const cacheSchema = {\n" },
    { filename: "src/runtime/metadata.ts", previous_filename: "src/vector/records.ts" },
    { filename: "src/vector/records.ts", previous_filename: "src/runtime/metadata.ts" },
  ]) {
    const patch = `${file.patch ?? "@@\n"}${" // retained context\n".repeat(110)}+  revision: 2,`;
    const pullFiles = hydratePrimaryBody("", "pull_request", { pullFiles: [{ ...file, patch }] })
      .context.pullFiles;
    const detection = dataModelChangeFromPullFilesForTest({ pullFiles });
    assert.ok(
      detection.surfaces.some((surface) => surface.startsWith("unknown-data-model-change:")),
      file.filename,
    );
    assert.match(
      reviewAutomationMarkersFromReport(persistenceReport(detection, "a".repeat(40))),
      /clawsweeper-verdict:needs-human/,
    );
  }
});

test("config surface reports force human review instead of automerge pass", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74454",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    config_surface_change: "true",
    config_surface_keys: JSON.stringify(["contracts.embeddingProviders"]),
  })}

## Summary

Keep this config-surface PR open for maintainer review.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
});

test("cache config fields retain their config blocker without inventing a persistence blocker", () => {
  const report = renderPersistenceReport(
    [{ filename: "src/config/types.ts", patch: "@@\n+  cacheTtl?: number;" }],
    "a".repeat(40),
  );
  assert.match(report, /^config_surface_change: true$/m);
  assert.match(report, /^data_model_change: false$/m);
  const comment = renderReviewCommentFromReport(report, "none");
  assert.match(comment, /clawsweeper-verdict:needs-human/);
  assert.match(comment, /clawsweeper-review-state:blocked/);
  assert.doesNotMatch(comment, /Confirm migration/);
});

test("config surface reports preserve security-sensitive markers", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74455",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    config_surface_change: "true",
    config_surface_keys: JSON.stringify(["unknown-config-surface-change"]),
  })}

## Summary

Keep this security-sensitive config-surface PR open for maintainer review.

## Security Review

Status: needs_attention

Summary: The config surface change may affect credential handling.

Concerns:

- **[high] Confirm credential scope:** \`src/config/zod-schema.ts:42\`
  - body: The changed config default may alter credential routing.
  - confidence: 0.91
`;

  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(markers, /clawsweeper-security:security-sensitive/);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
});

test("config surface detector finds schema and plugin manifest additions", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/config/zod-schema.ts",
        patch: "@@\n+  experimentalLocalModelLean: z.boolean().optional(),",
      },
      {
        filename: "src/plugins/manifest.ts",
        patch: "@@\n+    embeddingProviders?: PluginEmbeddingProviderContract[];",
      },
      {
        filename: "docs/plugins/manifest.md",
        patch: "@@\n+| `contracts.embeddingProviders` | Embedding provider contracts. |",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    keys: ["contracts.embeddingProviders", "experimentalLocalModelLean"],
  });
});

test("config surface detector ignores non-semantic docs wording", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "docs/gateway/configuration.md",
        patch: "@@\n+This section explains the existing `agents` config in clearer words.",
      },
      {
        filename: "docs/plugins/manifest.md",
        patch: "@@\n+This paragraph now describes plugin contracts more clearly.",
      },
    ],
  });

  assert.deepEqual(detection, { change: false, keys: [] });
});

test("config surface detector finds added and removed schema keys", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/config/zod-schema.ts",
        patch:
          "@@\n-  legacyModelProvider: z.string().optional(),\n+  historyLimit: z.number().optional(),",
      },
    ],
  });

  assert.deepEqual(detection, { change: true, keys: ["historyLimit", "legacyModelProvider"] });
});

test("config surface detector finds schema assembly changes", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/config/schema.ts",
        patch: "@@\n+  allowedProviders: buildAllowedProviderSchema(),",
      },
    ],
  });

  assert.deepEqual(detection, { change: true, keys: ["allowedProviders"] });
});

test("config surface detector fails closed for schema continuation changes", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/config/zod-schema.ts",
        patch: "@@\n-    .min(1)\n+    .min(2)",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    keys: ["unknown-config-surface-change"],
  });
});

test("config surface detector fails closed for missing patches", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "docs/plugins/manifest.md",
      },
      {
        filename: "src/config/zod-schema.ts",
        patch: "",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    keys: ["unknown-config-surface-change"],
  });
});

test("config surface detector fails closed for truncated file patches", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "docs/gateway/configuration.md",
        patch:
          "@@\n+This section explains the existing `agents` config in clearer words.\n\n[truncated 120 chars]",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    keys: ["unknown-config-surface-change"],
  });
});

test("config surface detector fails closed for renamed config surface files", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/legacy/zod-schema.ts",
        previous_filename: "src/config/zod-schema.ts",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    keys: ["unknown-config-surface-change"],
  });
});

test("config surface detector fails closed for truncated pull files", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFilesTruncated: true,
    pullFiles: [
      {
        filename: "src/config/schema.help.ts",
        patch: '@@\n+  experimentalLocalModelLean: "Prefer lean local model routing.",',
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    keys: ["experimentalLocalModelLean", "unknown-truncated-pull-files"],
  });
});

test("tooling diagnostic and subprocess regression do not produce a stored-data warning", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/persistence-classifier-130585.json", import.meta.url), "utf8"),
  );
  const detection = dataModelChangeFromPullFilesForTest({ pullFiles: fixture.pullFiles });

  assert.deepEqual(detection, { change: false, surfaces: [] });

  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "130585",
      url: fixture.pullRequest,
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: fixture.headSha,
      data_model_change: String(detection.change),
      data_model_surfaces: JSON.stringify(detection.surfaces),
    })}

## Summary

Corrects missing-tool installation guidance and adds a subprocess regression.
`,
    "none",
  );

  assert.doesNotMatch(comment, /Persistent data-model change detected|### Stored data model/);
});

test("real #119762 workflow metadata carrier does not produce a stored-data warning", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/persistence-classifier-119762.json", import.meta.url), "utf8"),
  );
  const detection = dataModelChangeFromPullFilesForTest({ pullFiles: fixture.pullFiles });

  assert.deepEqual(detection, { change: false, surfaces: [] });
});

test("bundled hook prose does not become a persistence warning or migration gate", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/persistence-classifier-130734.json", import.meta.url), "utf8"),
  );
  const detection = dataModelChangeFromPullFilesForTest({ pullFiles: fixture.pullFiles });
  assert.deepEqual(detection, { change: false, surfaces: [] });
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "130734",
    url: fixture.pullRequest,
    decision: "keep_open",
    close_reason: "none",
    work_candidate: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    pull_head_sha: fixture.headSha,
    real_behavior_proof_status: "sufficient",
    real_behavior_proof_needs_contributor_action: "false",
    data_model_change: String(detection.change),
    data_model_surfaces: JSON.stringify(detection.surfaces),
  })}\n\n## Summary\n\nClarifies hook guidance.\n\n## Review Findings\n\nOverall correctness: patch is correct\n\nOverall confidence: 0.9\n\nFull review comments:\n\n- none\n`;
  assert.doesNotMatch(
    renderReviewCommentFromReport(report, "none"),
    /Persistent data-model change detected|### Stored data model/,
  );
  const withoutStorageFields = report.replace(/^data_model_(?:change|surfaces):.*\n/gm, "");
  assert.deepEqual(
    reviewAutomationMarkersFromReport(report),
    reviewAutomationMarkersFromReport(withoutStorageFields),
  );
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:pass/);
  assert.match(
    reviewAutomationMarkersFromReport(
      report.replace("data_model_change: false", "data_model_change: true"),
    ),
    /clawsweeper-verdict:needs-human/,
  );
});

test("Markdown persistence contracts and structured frontmatter remain detectable", () => {
  for (const file of [
    {
      filename: "src/storage/README.md",
      patch: "@@\n+The serialized format now includes a revision field.",
    },
    {
      filename: "src/hooks/bundled/session-memory/HOOK.md",
      patch: "@@ -1,4 +1,4 @@\n ---\n-schema_version: 1\n+schema_version: 2\n ---\n # Hook",
    },
    {
      filename: "docs/storage.md",
      patch: "@@\n+ALTER TABLE sessions ADD COLUMN revision INTEGER;",
    },
    {
      filename: "src/memory/README.md",
      patch: '@@\n-  "embeddingDimension": 768,\n+  "embeddingDimension": 1024,',
    },
  ]) {
    assert.equal(
      dataModelChangeFromPullFilesForTest({ pullFiles: [file] }).change,
      true,
      file.filename,
    );
  }
});

for (const { name, file, surfaces, pullFilesTruncated, sqliteSchemaChange } of [
  ...[
    { filename: "src/cache/sqlite-store.ts" },
    { filename: "src/cache/sqlite.ts" },
    { filename: "src/runtime/requests.ts", previous_filename: "src/cache/sqlite-schema-v2.ts" },
    { filename: "src/cache/sqlite/store.ts", previous_filename: "src/runtime/requests.ts" },
  ].flatMap((file) =>
    [
      ["missing", undefined],
      ["empty", ""],
      ["truncated", "@@\n+  refresh();\n\n[truncated 99 chars]"],
    ].map(([patchKind, patch]) => ({
      name: `incomplete SQLite cache ${file.previous_filename ? `${file.previous_filename} -> ` : ""}${file.filename} (${patchKind} patch)`,
      file: { ...file, patch },
      surfaces: [
        `unknown-data-model-change: ${file.filename === "src/runtime/requests.ts" ? file.previous_filename : file.filename}`,
      ],
      sqliteSchemaChange: patchKind !== "empty",
    })),
  ),
  {
    name: "cache schema with a missing patch",
    file: { filename: "src/cache/schema.ts" },
    surfaces: ["unknown-data-model-change: src/cache/schema.ts"],
  },
  {
    name: "cache schema moved to a helper with a missing patch",
    file: { filename: "src/cache/helpers.ts", previous_filename: "src/cache/schema.ts" },
    surfaces: ["unknown-data-model-change: src/cache/schema.ts"],
  },
  {
    name: "cache helper with incomplete file list",
    file: { filename: "src/cache/helpers.ts" },
    pullFilesTruncated: true,
    surfaces: ["unknown-truncated-pull-files"],
  },
  {
    name: "plain form-validation schema fields",
    file: { filename: "ui/src/forms/schema.ts", patch: "@@\n+  fieldLabel: z.string()," },
    surfaces: [],
  },
  {
    name: "ordinary protocol fields without persistence evidence",
    file: {
      filename: "src/gateway/protocol/schema/session.ts",
      patch: "@@\n+  runId: Type.Optional(Type.String()),",
    },
    surfaces: [],
  },
  {
    name: "protocol schema with a missing patch",
    file: { filename: "src/gateway/protocol/schema/session.ts" },
    surfaces: ["unknown-data-model-change: src/gateway/protocol/schema/session.ts"],
  },
  {
    name: "unchanged storage beside a separate hunk with typed display parameters",
    file: {
      filename: "ui/src/preferences.ts",
      patch:
        '@@ -1,4 +1,4 @@\n function savePreferences(value: string) {\n   localStorage.setItem("preferences", value);\n-  refresh();\n+  refresh(true);\n }\n@@ -40,3 +40,4 @@\n function show(\n   title: string,\n+  subtitle: string,\n ) {',
    },
    surfaces: [],
  },
  {
    name: "colocated test serialization",
    file: { filename: "src/cache/store.test.ts", patch: '@@\n+writeFile("fixture.json", "{}");' },
    surfaces: [],
  },
  {
    name: "test setup with a missing patch",
    file: { filename: "src/cache/__tests__/setup.ts" },
    surfaces: [],
  },
  {
    name: "test support with a missing persistence patch",
    file: { filename: "src/cache/store.test-support.ts" },
    surfaces: [],
  },
  {
    name: "Go test with a missing persistence patch",
    file: { filename: "src/storage/records_test.go" },
    surfaces: [],
  },
  {
    name: "Go test with a truncated schema patch",
    file: {
      filename: "src/storage/records_test.go",
      patch: "@@\n+CREATE TABLE fixture (id TEXT);\n\n[truncated 90 chars]",
    },
    surfaces: [],
  },
  {
    name: "production to Go test rename with schema removed",
    file: {
      filename: "scripts/translation/records_test.go",
      previous_filename: "scripts/translation/records.go",
      patch: "@@\n-CREATE TABLE chunks (id TEXT);",
    },
    surfaces: ["database schema: scripts/translation/records.go"],
  },
  {
    name: "Go test to production rename with a missing persistence patch",
    file: {
      filename: "src/storage/records.go",
      previous_filename: "src/storage/records_test.go",
    },
    surfaces: ["unknown-data-model-change: src/storage/records.go"],
  },
  {
    name: "test support with a truncated schema patch",
    file: {
      filename: "src/db/schema.test-support.ts",
      patch: "@@\n+CREATE TABLE fixture (id TEXT);\n\n[truncated 90 chars]",
    },
    surfaces: [],
  },
  {
    name: "test support to production rename with a missing patch",
    file: {
      filename: "src/persistence/state.ts",
      previous_filename: "src/persistence/state.test-support.ts",
    },
    surfaces: ["unknown-data-model-change: src/persistence/state.ts"],
  },
  {
    name: "production to test support rename with stored data removed",
    file: {
      filename: "src/runtime/io.test-support.ts",
      previous_filename: "src/runtime/io.ts",
      patch: "@@\n-await writeFile(target, JSON.stringify(value));",
    },
    surfaces: ["serialized state: src/runtime/io.ts"],
  },
  {
    name: "truncated file list containing only test support",
    file: { filename: "src/cache/store.test-support.ts", patch: "@@\n+const metadata = {};" },
    pullFilesTruncated: true,
    surfaces: ["unknown-truncated-pull-files"],
  },
  {
    name: "fixture with a truncated patch",
    file: {
      filename: "fixtures/schema.sql",
      patch: "@@\n+CREATE TABLE example (id TEXT);\n\n[truncated 90 chars]",
    },
    surfaces: [],
  },
  {
    name: "example storage setup",
    file: { filename: "examples/storage.ts", patch: '@@\n+await state.storage.put("key", value);' },
    surfaces: [],
  },
  {
    name: "test to production rename with a missing patch",
    file: { filename: "src/persistence/state.ts", previous_filename: "fixtures/state.ts" },
    surfaces: ["unknown-data-model-change: src/persistence/state.ts"],
  },
  {
    name: "production to test rename with serialization removed",
    file: {
      filename: "tests/runtime/io.ts",
      previous_filename: "src/runtime/io.ts",
      patch: "@@\n-await writeFile(target, JSON.stringify(value));",
    },
    surfaces: ["serialized state: src/runtime/io.ts"],
  },
  {
    name: "production to fixture rename with a missing patch",
    file: { filename: "fixtures/state.ts", previous_filename: "src/persistence/state.ts" },
    surfaces: ["unknown-data-model-change: src/persistence/state.ts"],
  },
  {
    name: "truncated file list containing only test setup",
    file: { filename: "test/setup.ts", patch: '@@\n+writeFile("fixture.json", "{}");' },
    pullFilesTruncated: true,
    surfaces: ["unknown-truncated-pull-files"],
  },
  {
    name: "workflow-only persistence vocabulary",
    file: {
      filename: ".github/workflows/release.yml",
      patch:
        '@@\n+metadata=".artifacts/candidate.json"\n+await upgrade(state)\n+await writeFile(statePath, JSON.stringify(value));',
    },
    surfaces: [],
  },
  {
    name: "workflow to production rename with a missing patch",
    file: {
      filename: "src/storage/session-state.ts",
      previous_filename: ".github/workflows/session-state.yml",
    },
    surfaces: ["unknown-data-model-change: src/storage/session-state.ts"],
  },
]) {
  test(`data model detector scopes ${name}`, () => {
    const detection = dataModelChangeFromPullFilesForTest({
      pullFiles: [file],
      pullFilesTruncated,
    });

    assert.deepEqual(detection, { change: surfaces.length > 0, surfaces });
    const report = renderPersistenceReport([file], "a".repeat(40), pullFilesTruncated);
    const comment = renderReviewCommentFromReport(report, "none");
    assert.equal(/Confirm migration/.test(comment), detection.change);
    assert.match(
      comment,
      detection.change ? /clawsweeper-review-state:blocked/ : /clawsweeper-review-state:ready/,
    );
    if (sqliteSchemaChange !== undefined) {
      assert.equal(/^sqlite_schema_change: true$/m.test(report), sqliteSchemaChange);
      assert.equal(comment.includes("SQLite table change"), sqliteSchemaChange);
    }
    assert.match(
      reviewAutomationMarkersFromReport(report),
      detection.change ? /clawsweeper-verdict:needs-human/ : /clawsweeper-verdict:pass/,
    );
  });
}

test("data model detector finds production persistence and semantic docs changes in mixed diffs", () => {
  const detection = dataModelChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "packages/database/migrations/018_sessions.sql",
        patch: "@@\n+ALTER TABLE sessions ADD COLUMN last_model TEXT;",
      },
      {
        filename: "src/memory/vector-store.ts",
        patch:
          "@@\n+  embeddingDimension: row.embedding_dimension,\n+  documentId: row.document_id,",
      },
      {
        filename: "src/doctor/backfill.ts",
        patch: "@@\n+  await backfillMissingSessionVersions(db);",
      },
      {
        filename: "packages/database/migrations/019_backfill_sessions.sql",
        patch: "@@\n+UPDATE sessions SET last_model = 'unknown' WHERE last_model IS NULL;",
      },
      {
        filename: "src/runtime/io.ts",
        patch: "@@\n+await writeFile(target, JSON.stringify(value));",
      },
      {
        filename: "src/workers/store.ts",
        patch: '@@\n+await state.storage.put("revision", revision);',
      },
      {
        filename: "docs/storage.md",
        patch: "@@\n+The serialized format now includes a revision field.",
      },
      {
        filename: "src/memory/vector-store.test.ts",
        patch: '@@\n+writeFile("fixture.json", JSON.stringify(value));',
      },
      {
        filename: "src/memory/vector-store.test-support.ts",
        patch: '@@\n+writeFile("fixture.json", JSON.stringify({ embeddingDimension: 1024 }));',
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    surfaces: [
      "database schema: packages/database/migrations/018_sessions.sql",
      "durable storage schema: src/workers/store.ts",
      "migration/backfill/repair: packages/database/migrations/019_backfill_sessions.sql",
      "migration/backfill/repair: src/doctor/backfill.ts",
      "serialized state: docs/storage.md",
      "serialized state: src/runtime/io.ts",
      "vector/embedding metadata: src/memory/vector-store.ts",
    ],
  });
});

test("data model detector ignores query-only and non-semantic docs changes", () => {
  const detection = dataModelChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "packages/database/search.ts",
        patch:
          "@@\n+  return db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));",
      },
      {
        filename: "src/memory/search.ts",
        patch: "@@\n+  return query.trim().toLowerCase();",
      },
      {
        filename: "docs/storage.md",
        patch: "@@\n+This section explains the existing `sessions` table in clearer words.",
      },
    ],
  });

  assert.deepEqual(detection, { change: false, surfaces: [] });
});

test("SQLite schema detector finds production table changes and ignores non-schema SQL", () => {
  const detection = sqliteSchemaChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "packages/memory-host-sdk/src/host/memory-schema-base.ts",
        patch:
          "@@\n     CREATE TABLE IF NOT EXISTS memory_index_chunks (\n       id TEXT PRIMARY KEY,\n+      source_kind TEXT NOT NULL,\n     );",
      },
      {
        filename: "src/transcripts/sqlite-schema.ts",
        patch:
          "@@\n+CREATE TABLE IF NOT EXISTS meeting_transcript_summaries (\n+  id TEXT PRIMARY KEY\n+);",
      },
      {
        filename: "src/memory/search.ts",
        patch: "@@\n+  return db.prepare('SELECT * FROM memory_index_chunks').all();",
      },
      {
        filename: "src/memory/manager-db.test.ts",
        patch: "@@\n+  db.exec('CREATE TABLE fixture_rows (id TEXT PRIMARY KEY)');",
      },
      {
        filename: "src/memory/manager-db.test-support.ts",
        patch: "@@\n+  db.exec('CREATE TABLE fixture_rows (id TEXT PRIMARY KEY)');",
      },
      {
        filename: "docs/storage.md",
        patch: "@@\n+CREATE TABLE example_rows (id TEXT PRIMARY KEY);",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    files: [
      "packages/memory-host-sdk/src/host/memory-schema-base.ts",
      "src/transcripts/sqlite-schema.ts",
    ],
  });
});

test("production path classification preserves test segment and basename boundaries", () => {
  const cases = [
    ["test/schema.sql", false],
    ["src/__TESTS__/schema.sql", false],
    ["examples/schema.sql", false],
    ["src/cache/store.spec.ts", false],
    ["src/cache/store.TEST.TS", false],
    ["src/cache/store.test-support.ts", false],
    ["src/cache/store.TEST-SUPPORT.TS", false],
    ["src/cache/store.test-supported.ts", true],
    ["src/cache/store.test-support.", true],
    ["src/store.test-support.ts/schema.sql", true],
    ["src/spec/schema.sql", true],
    ["src/test-fixtures/schema.sql", true],
    ["src/cache/store.spec.", true],
    ["src/cache/store.spec.unit.spec.", false],
    ["scripts/translation/records_test.go", false],
    ["scripts/translation/records.go", true],
    ["src/storage/records_test.go", false],
    ["src/storage/records.go", true],
  ] as const;

  for (const [filename, expectedChange] of cases) {
    const detection = sqliteSchemaChangeFromPullFilesForTest({
      pullFiles: [{ filename, patch: "@@\n+CREATE TABLE example (id TEXT);" }],
    });

    assert.equal(detection.change, expectedChange, filename);
  }
});

test("production path classification is bounded for repeated test markers", () => {
  const filename = `${".spec.".repeat(20_000)}/schema.sql`;
  const startedAt = performance.now();
  const detection = sqliteSchemaChangeFromPullFilesForTest({
    pullFiles: [{ filename, patch: "@@\n+CREATE TABLE example (id TEXT);" }],
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(detection.change, true);
  assert.equal(detection.files.length, 1);
  assert.ok(elapsedMs < 250, `classification took ${elapsedMs.toFixed(1)}ms`);
});

test("SQLite schema warning is visible for table changes and absent otherwise", () => {
  const reportBody = `

## Summary

Keep this PR open for maintainer review.

## What This Changes

Adds a column to the persisted memory index.
`;
  const warningComment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74464",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      sqlite_schema_change: "true",
      sqlite_schema_files: JSON.stringify([
        "packages/memory-host-sdk/src/host/memory-schema-base.ts",
      ]),
    })}${reportBody}`,
    "none",
  );
  const ordinaryComment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74465",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      sqlite_schema_change: "false",
      sqlite_schema_files: JSON.stringify([]),
    })}${reportBody}`,
    "none",
  );

  assert.match(warningComment, /> \[!WARNING\]/);
  assert.match(warningComment, /SQLite table change/);
  assert.match(warningComment, /`packages\/memory-host-sdk\/src\/host\/memory-schema-base\.ts`/);
  assert.match(warningComment, /Prefer a design that avoids changing persisted SQLite tables/);
  assert.ok(
    warningComment.indexOf("SQLite table change") <
      warningComment.indexOf("<summary><strong>Agent review details</strong></summary>"),
  );
  assert.doesNotMatch(ordinaryComment, /SQLite table change/);
  assert.doesNotMatch(ordinaryComment, /\[!WARNING\]/);
});

test("data model detector flags path-hinted persisted field declarations", () => {
  const detection = dataModelChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/db/schema.ts",
        patch: '@@\n+  lastModel: text("last_model"),',
      },
      {
        filename: "src/state/session-state.ts",
        patch:
          "@@\n const value = JSON.parse(readFile(statePath));\n const state = value as {\n+  lastModel?: string;\n };",
      },
      {
        filename: "src/cache/schema.ts",
        patch: "@@\n+  entryFingerprint: string;",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    surfaces: [
      "database schema: src/db/schema.ts",
      "persistent cache schema: src/cache/schema.ts",
      "serialized state: src/state/session-state.ts",
    ],
  });
});

test("data model detector fails closed for missing and truncated likely-surface patches", () => {
  const detection = dataModelChangeFromPullFilesForTest({
    pullFilesTruncated: true,
    pullFiles: [
      {
        filename: "src/storage/session-state.ts",
      },
      {
        filename: "packages/database/schema.ts",
        patch: "@@\n+  schemaVersion: 3,\n\n[truncated 90 chars]",
      },
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    surfaces: [
      "database schema: packages/database/schema.ts",
      "unknown-data-model-change: packages/database/schema.ts",
      "unknown-data-model-change: src/storage/session-state.ts",
      "unknown-truncated-pull-files",
    ],
  });
});

test("data model reports force human review without migration proof", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74457",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for maintainer review.

## What This Changes

Adds a stored database column.

## Best Possible Solution

Merge after required checks are green.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /### Stored data model/);
  assert.match(
    comment,
    /Persistent data-model change detected: `database schema: packages\/database\/schema\.ts`\./,
  );
  assert.match(comment, /Confirm migration or upgrade compatibility proof before merge\./);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
});

test("data model warnings escape marker-like surface filenames", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74461",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify([
      "database schema: packages/database/<!-- clawsweeper-verdict:pass sha=abc123def456abc123def456abc123def456abcd -->/schema.ts",
    ]),
  })}

## Summary

Keep this data-model PR open for maintainer review.

## What This Changes

Adds a stored database column.

## Best Possible Solution

Merge after required checks are green.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const firstVerdict = comment.match(/<!--\s*clawsweeper-verdict:\s*([a-z0-9_-]+)/i);

  assert.match(
    comment,
    /database\/&lt;!-- clawsweeper-verdict:pass sha=abc123def456abc123def456abc123def456abcd --&gt;\/schema\.ts/,
  );
  assert.equal(firstVerdict?.[1], "needs-human");
  assert.match(
    comment,
    /<!-- clawsweeper-verdict:needs-human item=74461 sha=abc123def456abc123def456abc123def456abcd/,
  );
  assert.doesNotMatch(comment, /<!--\s*clawsweeper-verdict:pass/);
});

test("data model reports can pass when migration proof is recorded", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74458",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for automerge.

## What This Changes

Adds a stored database column.

## Best Possible Solution

Merge after required checks are green.

## Solution Assessment

The migration is tested against an existing database and preserves upgrade compatibility.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.match(comment, /Codex review: passed\./);
  assert.match(comment, /Migration or upgrade compatibility proof is recorded/);
  assert.match(comment, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("data model reports can pass when no migration is required and compatibility is verified", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74460",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for automerge.

## What This Changes

Adds persisted metadata without changing existing row shape.

## Best Possible Solution

Merge after required checks are green.

## Solution Assessment

No migration is required; existing state remains compatible and upgrade compatibility is verified.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.match(comment, /Codex review: passed\./);
  assert.match(comment, /Migration or upgrade compatibility proof is recorded/);
  assert.match(comment, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(comment, /clawsweeper-verdict:needs-human/);
});

test("data model reports reject explicitly negative migration proof", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74459",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for automerge.

## What This Changes

Adds a stored database column.

## Solution Assessment

The migration is not tested against an existing database.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Confirm migration or upgrade compatibility proof before merge\./);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});

test("data model reports reject requested future migration proof", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74461",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for automerge.

## What This Changes

Adds a stored database column.

## Best Possible Solution

Add a migration test before merge.

## Solution Assessment

This PR still needs migration compatibility proof before merge.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Confirm migration or upgrade compatibility proof before merge\./);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});

test("data model reports reject planned migration tests as proof", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74463",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for automerge.

## What This Changes

Adds a stored database column.

## Solution Assessment

Migration tests are planned.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Confirm migration or upgrade compatibility proof before merge\./);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});

test("data model reports reject hypothetical compatibility proof", () => {
  const report = `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: "74462",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify(["database schema: packages/database/schema.ts"]),
  })}

## Summary

Keep this data-model PR open for automerge.

## What This Changes

Adds a stored database column.

## Solution Assessment

The migration should preserve upgrade compatibility for existing databases.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /Confirm migration or upgrade compatibility proof before merge\./);
  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:pass/);
});
