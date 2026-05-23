import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenClawPrSurfaceStats,
  openClawPrSurfaceBucket,
  renderOpenClawPrSurfaceSummary,
  renderOpenClawPrSurfaceTable,
} from "../dist/pr-surface-stats.js";

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

  assert.equal(renderOpenClawPrSurfaceSummary(stats), "Source +2. Total +2 across 1 file.");

  const table = renderOpenClawPrSurfaceTable(stats);
  assert.match(table, /\| Tests \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(table, /\| Other \| 0 \| 0 \| 0 \| 0 \|/);
});
