import assert from "node:assert/strict";
import test from "node:test";
import { asRecord } from "../dist/clawsweeper-item-policy.js";
import { createReportOrchestrationFoundation } from "../dist/clawsweeper-orchestration-foundation.js";
import { pullRequestFilePathsFromContextForTest } from "../dist/clawsweeper.js";

import {
  buildOpenClawPrSurfaceStats,
  openClawPrSurfaceBucket,
  renderOpenClawPrSurfaceSummary,
  renderOpenClawPrSurfaceTable,
} from "../dist/pr-surface-stats.js";
import { pinnedTestRolePaths } from "./openclaw-file-role-fixture.ts";

test("surface counts use only the current rename path while proof retains both sides", () => {
  const { prSurfaceFilesFromContext } = createReportOrchestrationFoundation(
    new Proxy(
      { asRecord },
      {
        get: (target, key) =>
          Reflect.get(target, key) ??
          (() => {
            throw new Error(`Unexpected surface projection dependency: ${String(key)}`);
          }),
      },
    ) as Parameters<typeof createReportOrchestrationFoundation>[0],
  );
  for (const [previous_filename, filename, bucket] of [
    ["src/config/schema.ts", "src/config/schema.test-support.ts", "tests"],
    ["src/config/schema.test-support.ts", "src/config/schema.ts", "source"],
    ["src/config/schema.test.ts", "src/config/schema.test-support.ts", "tests"],
    ["docs/gateway/configuration.md", "src/config/schema.test-support.ts", "tests"],
    ["src/config/schema.test-support.ts", "docs/gateway/configuration.md", "docs"],
  ] as const) {
    const context = {
      issue: {},
      comments: [],
      timeline: [],
      pullFiles: [{ filename, previous_filename, status: "renamed", additions: 57, deletions: 0 }],
    };
    const files = prSurfaceFilesFromContext(context);
    assert.ok(files);
    assert.deepEqual(files, [{ path: filename, additions: 57, deletions: 0 }]);
    const stats = buildOpenClawPrSurfaceStats(files);
    assert.ok(stats);
    const populated = stats.filter((row) => row.files > 0);
    assert.equal(populated.length, 1);
    assert.equal(populated[0]?.bucket, bucket);
    assert.deepEqual(
      new Set(pullRequestFilePathsFromContextForTest(context)),
      new Set([filename, previous_filename]),
    );
    assert.deepEqual(
      prSurfaceFilesFromContext({
        ...context,
        counts: { comments: 0, timeline: 0, pullFilesTruncated: true },
      }),
      null,
    );
  }
});

test("OpenClaw support fixtures count as tests, including the +57 ownership repro", () => {
  for (const path of pinnedTestRolePaths)
    assert.equal(openClawPrSurfaceBucket(path), "tests", path);
  const stats = buildOpenClawPrSurfaceStats([
    { path: pinnedTestRolePaths[0], additions: 57, deletions: 0 },
  ]);
  assert.ok(stats);
  assert.equal(renderOpenClawPrSurfaceSummary(stats), "Tests +57. Total +57 across 1 file.");
  const table = renderOpenClawPrSurfaceTable(stats);
  assert.match(table, /\| Source \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(table, /\| Tests \| 1 \| 57 \| 0 \| \+57 \|/);
});

test("test-role sharing preserves bucket precedence, source roots, and normalization", () => {
  const cases = [
    ["src/config/schema.generated.test-support.ts", "generated"],
    ["docs/.generated/schema.test-support.ts", "generated"],
    ["src/test-support/__snapshots__/schema.snap", "generated"],
    ["docs/gateway/schema.test-support.ts", "tests"],
    ["docs/test-support/README.md", "tests"],
    ["src/config/schema.test-support.md", "docs"],
    ["docs/gateway/configuration.md", "docs"],
    ["src/config/schema.generated.ts", "generated"],
    ["src/config/schema.test-support.production.ts", "source"],
    ["src/config/schema.test-supportive.ts", "source"],
    ["src/config/schema.support.ts", "source"],
    ["src/config/schema.TEST.ts", "source"],
    [".github/test-support/check.ts", "tests"],
    ["test-support/package.json", "tests"],
    [".github/workflows/check.yml", "config"],
    ["src/runtime.ts", "source"],
    ["ui/runtime.ts", "source"],
    ["packages/runtime.ts", "source"],
    ["extensions/runtime.ts", "source"],
    ["scripts/runtime.ts", "other"],
    ["apps/runtime.ts", "other"],
    ["fixtures/runtime.ts", "other"],
    ["scripts/check-harness.ts", "other"],
    [" src\\config\\test-support\\schema.ts ", "tests"],
  ] as const;
  for (const [path, bucket] of cases) assert.equal(openClawPrSurfaceBucket(path), bucket, path);
});

test("OpenClaw PR surface buckets classify changed paths", () => {
  assert.equal(openClawPrSurfaceBucket("src/agents/runtime.ts"), "source");
  assert.equal(openClawPrSurfaceBucket("ui/components/App.tsx"), "source");
  assert.equal(openClawPrSurfaceBucket("extensions/slack/src/index.ts"), "source");
  assert.equal(openClawPrSurfaceBucket("src/agents/runtime.test.ts"), "tests");
  assert.equal(openClawPrSurfaceBucket("tests/fixtures/session.json"), "tests");
  assert.equal(openClawPrSurfaceBucket("docs/gateway/configuration.md"), "docs");
  assert.equal(openClawPrSurfaceBucket("README.md"), "docs");
  assert.equal(openClawPrSurfaceBucket(".github/workflows/check.yml"), "config");
  assert.equal(openClawPrSurfaceBucket("package.json"), "config");
  assert.equal(openClawPrSurfaceBucket("src/config/schema.base.generated.test.ts"), "generated");
  assert.equal(openClawPrSurfaceBucket("protocol-generated/json/frame.json"), "generated");
  assert.equal(openClawPrSurfaceBucket("fixtures/sample.txt"), "other");
});

test("OpenClaw PR surface stats aggregate rows and totals", () => {
  const stats = buildOpenClawPrSurfaceStats([
    { path: "src/runtime.ts", additions: 12, deletions: 2 },
    { path: "src/runtime.test.ts", additions: 8, deletions: 1 },
    { path: "docs/usage.md", additions: 5, deletions: 0 },
    { path: ".github/workflows/check.yml", additions: 4, deletions: 6 },
    { path: "protocol-generated/json/frame.json", additions: 3, deletions: 0 },
    { path: "fixtures/sample.txt", additions: 2, deletions: 1 },
  ]);
  assert.ok(stats);

  assert.deepEqual(
    stats.map(({ label, files, additions, deletions, net }) => ({
      label,
      files,
      additions,
      deletions,
      net,
    })),
    [
      { label: "Source", files: 1, additions: 12, deletions: 2, net: 10 },
      { label: "Tests", files: 1, additions: 8, deletions: 1, net: 7 },
      { label: "Docs", files: 1, additions: 5, deletions: 0, net: 5 },
      { label: "Config", files: 1, additions: 4, deletions: 6, net: -2 },
      { label: "Generated", files: 1, additions: 3, deletions: 0, net: 3 },
      { label: "Other", files: 1, additions: 2, deletions: 1, net: 1 },
    ],
  );

  const summary = renderOpenClawPrSurfaceSummary(stats);
  assert.equal(
    summary,
    "Source +10, Tests +7, Docs +5, Config -2, Generated +3, Other +1. Total +24 across 6 files.",
  );

  const table = renderOpenClawPrSurfaceTable(stats);
  assert.match(table, /\| Source \| 1 \| 12 \| 2 \| \+10 \|/);
  assert.match(table, /\| Config \| 1 \| 4 \| 6 \| -2 \|/);
  assert.match(
    table,
    /\| \*\*Total\*\* \| \*\*6\*\* \| \*\*34\*\* \| \*\*10\*\* \| \*\*\+24\*\* \|/,
  );
});

test("OpenClaw PR surface summary omits zero buckets but table keeps them", () => {
  const stats = buildOpenClawPrSurfaceStats([
    { path: "src/runtime.ts", additions: 3, deletions: 1 },
  ]);
  assert.ok(stats);

  assert.equal(renderOpenClawPrSurfaceSummary(stats), "Source +2. Total +2 across 1 file.");

  const table = renderOpenClawPrSurfaceTable(stats);
  assert.match(table, /\| Tests \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(table, /\| Other \| 0 \| 0 \| 0 \| 0 \|/);
});

test("OpenClaw PR surface never aggregates unknown or invalid counts as verified zero", () => {
  for (const value of [
    null,
    undefined,
    "0",
    "3",
    "",
    false,
    {},
    [],
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const field of ["additions", "deletions"]) {
      assert.equal(
        buildOpenClawPrSurfaceStats([
          { path: "src/known.ts", additions: 5, deletions: 1 },
          { path: "src/unknown.ts", additions: 0, deletions: 0, [field]: value },
        ]),
        null,
        `${field}: ${String(value)}`,
      );
    }
  }
  assert.equal(
    buildOpenClawPrSurfaceStats([
      { path: "src/a.ts", additions: Number.MAX_SAFE_INTEGER, deletions: 0 },
      { path: "docs/b.md", additions: 1, deletions: 0 },
    ]),
    null,
    "even valid per-file counts must not produce an unsafe aggregate",
  );
});

test("OpenClaw PR surface retains verified zero line changes", () => {
  const stats = buildOpenClawPrSurfaceStats([
    { path: "src/renamed.ts", additions: 0, deletions: 0 },
  ]);
  assert.ok(stats);
  assert.equal(renderOpenClawPrSurfaceSummary(stats), "Source 0. Total 0 across 1 file.");
  assert.match(
    renderOpenClawPrSurfaceTable(stats),
    /\| \*\*Total\*\* \| \*\*1\*\* \| \*\*0\*\* \| \*\*0\*\* \| \*\*0\*\* \|/,
  );
});
