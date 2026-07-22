import assert from "node:assert/strict";
import test from "node:test";

import {
  configSurfaceChangeFromPullFilesForTest,
  dataModelChangeFromPullFilesForTest,
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { reportFrontMatter } from "./helpers.ts";

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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
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

test("config surface detector finds removed schema keys", () => {
  const detection = configSurfaceChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/config/zod-schema.ts",
        patch: "@@\n-  legacyModelProvider: z.string().optional(),",
      },
    ],
  });

  assert.deepEqual(detection, { change: true, keys: ["legacyModelProvider"] });
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

test("data model detector finds persistent schema and embedding metadata changes", () => {
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
    ],
  });

  assert.deepEqual(detection, {
    change: true,
    surfaces: [
      "database schema: packages/database/migrations/018_sessions.sql",
      "migration/backfill/repair: packages/database/migrations/019_backfill_sessions.sql",
      "migration/backfill/repair: src/doctor/backfill.ts",
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

test("data model detector flags path-hinted persisted field declarations", () => {
  const detection = dataModelChangeFromPullFilesForTest({
    pullFiles: [
      {
        filename: "src/db/schema.ts",
        patch: '@@\n+  lastModel: text("last_model"),',
      },
      {
        filename: "src/state/session-state.ts",
        patch: "@@\n+  lastModel?: string;",
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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
    data_model_change: "true",
    data_model_surfaces: JSON.stringify([
      "database schema: packages/database/<!-- clawsweeper-verdict:pass sha=abc123def456 -->/schema.ts",
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
    /database\/&lt;!-- clawsweeper-verdict:pass sha=abc123def456 --&gt;\/schema\.ts/,
  );
  assert.equal(firstVerdict?.[1], "needs-human");
  assert.match(comment, /<!-- clawsweeper-verdict:needs-human item=74461 sha=abc123def456/);
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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
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
    pull_head_sha: "abc123def456",
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
