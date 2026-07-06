import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPrInterferenceReport,
  detectInterference,
  mergeIntervals,
  parseBaseIntervals,
  prRadarFileFromApi,
  renderPrInterferenceMarkdown,
  type PrRadarFile,
  type PrRadarPr,
} from "../dist/pr-interference.js";

function radarPr(
  number: number,
  files: PrRadarFile[],
  overrides: Partial<PrRadarPr> = {},
): PrRadarPr {
  return {
    number,
    title: `title ${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    author: "alice",
    draft: false,
    base_ref: "main",
    head_sha: `sha-${number}`,
    files,
    files_truncated: false,
    ...overrides,
  };
}

function radarFile(basePath: string, lineRanges: number[][] | null): PrRadarFile {
  return { base_path: basePath, status: "modified", line_ranges: lineRanges };
}

test("parseBaseIntervals merges hunks and defaults omitted counts", () => {
  assert.deepEqual(parseBaseIntervals("@@ -10,5 +10,6 @@\n context\n@@ -14,3 +20,3 @@\n"), [
    [10, 16],
  ]);
  assert.deepEqual(parseBaseIntervals("@@ -5 +5 @@\n-old\n+new\n"), [[5, 5]]);
  assert.deepEqual(parseBaseIntervals("@@ -3,3 +3,3 @@\n@@ -8,2 +8,2 @@\n"), [
    [3, 5],
    [8, 9],
  ]);
});

test("parseBaseIntervals anchors insertions to neighboring base lines", () => {
  assert.deepEqual(parseBaseIntervals("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n"), [[1, 1]]);
  assert.deepEqual(parseBaseIntervals("@@ -40,0 +41,2 @@\n+a\n+b\n"), [[40, 41]]);
});

test("parseBaseIntervals keeps pure deletions on the pre-image range", () => {
  assert.deepEqual(parseBaseIntervals("@@ -10,3 +9,0 @@\n-a\n-b\n-c\n"), [[10, 12]]);
});

test("mergeIntervals coalesces overlapping and adjacent ranges", () => {
  assert.deepEqual(
    mergeIntervals([
      [6, 8],
      [3, 5],
    ]),
    [[3, 8]],
  );
  assert.deepEqual(
    mergeIntervals([
      [3, 5],
      [7, 8],
    ]),
    [
      [3, 5],
      [7, 8],
    ],
  );
});

test("prRadarFileFromApi resolves base paths and file granularity", () => {
  assert.deepEqual(
    prRadarFileFromApi({
      filename: "src/new-name.ts",
      status: "renamed",
      previous_filename: "src/old-name.ts",
      patch: "@@ -4,2 +4,2 @@\n",
    }),
    { base_path: "src/old-name.ts", status: "renamed", line_ranges: [[4, 5]] },
  );
  assert.deepEqual(
    prRadarFileFromApi({ filename: "src/gone.ts", status: "removed", patch: "@@ -1,9 +0,0 @@\n" }),
    { base_path: "src/gone.ts", status: "removed", line_ranges: [[1, 9]] },
  );
  assert.deepEqual(
    prRadarFileFromApi({ filename: "src/new.ts", status: "added", patch: "@@ -0,0 +1,20 @@\n" }),
    { base_path: "src/new.ts", status: "added", line_ranges: null },
  );
  assert.deepEqual(prRadarFileFromApi({ filename: "assets/logo.png", status: "modified" }), {
    base_path: "assets/logo.png",
    status: "modified",
    line_ranges: null,
  });
});

test("detectInterference reports line overlaps with clipped ranges", () => {
  const { pairs, pairs_truncated } = detectInterference(
    [
      radarPr(101, [radarFile("src/a.ts", [[10, 20]])]),
      radarPr(102, [radarFile("src/a.ts", [[15, 30]])], { draft: true }),
    ],
    50,
  );
  assert.equal(pairs_truncated, false);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.severity, "lines");
  assert.equal(pairs[0]?.overlapping_line_total, 6);
  assert.equal(pairs[0]?.pr_a.number, 101);
  assert.equal(pairs[0]?.pr_b.number, 102);
  assert.equal(pairs[0]?.pr_b.draft, true);
  assert.equal(pairs[0]?.pr_b.head_sha, "sha-102");
  assert.deepEqual(pairs[0]?.files, [
    { base_path: "src/a.ts", severity: "lines", overlapping_lines: [[15, 20]] },
  ]);
});

test("detectInterference treats shared boundaries as overlap and adjacency as file-level", () => {
  const boundary = detectInterference(
    [
      radarPr(1, [radarFile("src/a.ts", [[10, 20]])]),
      radarPr(2, [radarFile("src/a.ts", [[20, 25]])]),
    ],
    50,
  );
  assert.deepEqual(boundary.pairs[0]?.files[0]?.overlapping_lines, [[20, 20]]);
  const adjacent = detectInterference(
    [
      radarPr(1, [radarFile("src/a.ts", [[10, 20]])]),
      radarPr(2, [radarFile("src/a.ts", [[21, 25]])]),
    ],
    50,
  );
  assert.equal(adjacent.pairs.length, 1);
  assert.equal(adjacent.pairs[0]?.severity, "file");
  assert.deepEqual(adjacent.pairs[0]?.files[0]?.overlapping_lines, []);
});

test("detectInterference only pairs pull requests with the same base ref", () => {
  const { pairs } = detectInterference(
    [
      radarPr(1, [radarFile("src/a.ts", [[10, 20]])]),
      radarPr(2, [radarFile("src/a.ts", [[10, 20]])], { base_ref: "release-1" }),
    ],
    50,
  );
  assert.deepEqual(pairs, []);
});

test("detectInterference degrades to file granularity without line ranges", () => {
  const { pairs } = detectInterference(
    [
      radarPr(1, [radarFile("assets/logo.png", null)]),
      radarPr(2, [radarFile("assets/logo.png", [[3, 9]])]),
    ],
    50,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.severity, "file");
  assert.equal(pairs[0]?.containment, "none");
});

test("detectInterference never claims containment for opaque line ranges", () => {
  const rangedInner = detectInterference(
    [radarPr(21, [radarFile("src/a.ts", [[10, 12]])]), radarPr(22, [radarFile("src/a.ts", null)])],
    50,
  );
  assert.equal(rangedInner.pairs[0]?.containment, "none");
  const bothOpaque = detectInterference(
    [radarPr(21, [radarFile("src/a.ts", null)]), radarPr(22, [radarFile("src/a.ts", null)])],
    50,
  );
  assert.equal(bothOpaque.pairs[0]?.containment, "none");
  const emptyRanges = detectInterference(
    [radarPr(21, [radarFile("src/a.ts", [])]), radarPr(22, [radarFile("src/a.ts", [[5, 40]])])],
    50,
  );
  assert.equal(emptyRanges.pairs[0]?.containment, "none");
});

test("detectInterference pairs renamed files under the base-branch path", () => {
  const renamed = prRadarFileFromApi({
    filename: "src/renamed.ts",
    status: "renamed",
    previous_filename: "src/original.ts",
    patch: "@@ -12,4 +12,4 @@\n",
  });
  const { pairs } = detectInterference(
    [radarPr(1, [renamed]), radarPr(2, [radarFile("src/original.ts", [[14, 18]])])],
    50,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.severity, "lines");
  assert.deepEqual(pairs[0]?.files[0]?.overlapping_lines, [[14, 15]]);
});

test("detectInterference records containment between overlapping pull requests", () => {
  const within = detectInterference(
    [
      radarPr(11, [radarFile("src/a.ts", [[10, 12]])]),
      radarPr(12, [radarFile("src/a.ts", [[5, 40]]), radarFile("src/b.ts", [[1, 4]])]),
    ],
    50,
  );
  assert.equal(within.pairs[0]?.containment, "a_within_b");
  const equal = detectInterference(
    [
      radarPr(11, [radarFile("src/a.ts", [[10, 12]])]),
      radarPr(12, [radarFile("src/a.ts", [[10, 12]])]),
    ],
    50,
  );
  assert.equal(equal.pairs[0]?.containment, "equal");
  const crossed = detectInterference(
    [
      radarPr(11, [radarFile("src/a.ts", [[10, 12]]), radarFile("src/c.ts", [[1, 2]])]),
      radarPr(12, [radarFile("src/a.ts", [[5, 40]]), radarFile("src/b.ts", [[1, 4]])]),
    ],
    50,
  );
  assert.equal(crossed.pairs[0]?.containment, "none");
  const truncated = detectInterference(
    [
      radarPr(11, [radarFile("src/a.ts", [[10, 12]])]),
      radarPr(12, [radarFile("src/a.ts", [[5, 40]])], { files_truncated: true }),
    ],
    50,
  );
  assert.equal(truncated.pairs[0]?.containment, "none");
});

test("detectInterference sorts line pairs first and enforces the pair cap", () => {
  const { pairs, pairs_truncated } = detectInterference(
    [
      radarPr(1, [radarFile("src/a.ts", [[1, 2]])]),
      radarPr(2, [radarFile("src/a.ts", [[1, 40]])]),
      radarPr(3, [radarFile("src/a.ts", null)]),
    ],
    2,
  );
  assert.equal(pairs_truncated, true);
  assert.deepEqual(
    pairs.map((pair) => [pair.pr_a.number, pair.pr_b.number, pair.severity]),
    [
      [1, 2, "lines"],
      [1, 3, "file"],
    ],
  );
});

test("buildPrInterferenceReport digests are stable across timestamps and input order", () => {
  const prs = [
    radarPr(1, [radarFile("src/a.ts", [[10, 20]])]),
    radarPr(2, [radarFile("src/a.ts", [[15, 30]])]),
  ];
  const limits = { max_prs: 200, max_file_pages_per_pr: 3, max_pairs: 50 };
  const first = buildPrInterferenceReport({
    targetRepo: "openclaw/openclaw",
    prs,
    limits,
    prsTruncated: false,
    updatedAt: "2026-07-06T00:00:00.000Z",
  });
  const second = buildPrInterferenceReport({
    targetRepo: "openclaw/openclaw",
    prs: [...prs].reverse(),
    limits,
    prsTruncated: false,
    updatedAt: "2026-07-07T12:00:00.000Z",
  });
  assert.equal(first.digest, second.digest);
  assert.equal(first.schema_version, 1);
  assert.equal(first.prs_scanned, 2);
  const moved = buildPrInterferenceReport({
    targetRepo: "openclaw/openclaw",
    prs: [prs[0]!, radarPr(2, [radarFile("src/a.ts", [[16, 30]])])],
    limits,
    prsTruncated: false,
    updatedAt: "2026-07-06T00:00:00.000Z",
  });
  assert.notEqual(first.digest, moved.digest);
});

test("report JSON shape matches the published schema", () => {
  const schema = JSON.parse(readFileSync("schema/clawsweeper-pr-interference.schema.json", "utf8"));
  const report = buildPrInterferenceReport({
    targetRepo: "openclaw/openclaw",
    prs: [
      radarPr(1, [radarFile("src/a.ts", [[10, 20]])]),
      radarPr(2, [radarFile("src/a.ts", [[15, 30]])]),
    ],
    limits: { max_prs: 200, max_file_pages_per_pr: 3, max_pairs: 50 },
    prsTruncated: false,
    updatedAt: "2026-07-06T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
  assert.deepEqual(Object.keys(report).sort(), [...schema.required].sort());
  const pairSchema = schema.properties.pairs.items;
  assert.deepEqual(Object.keys(pairSchema.properties).sort(), [...pairSchema.required].sort());
  assert.deepEqual(Object.keys(report.pairs[0]!).sort(), [...pairSchema.required].sort());
  assert.deepEqual(
    Object.keys(report.pairs[0]!.pr_a).sort(),
    [...schema.$defs.pairSide.required].sort(),
  );
});

test("renderPrInterferenceMarkdown renders pairs, containment, and truncation", () => {
  const report = buildPrInterferenceReport({
    targetRepo: "openclaw/openclaw",
    prs: [
      radarPr(11, [radarFile("src/a.ts", [[10, 12]])], { draft: true }),
      radarPr(12, [radarFile("src/a.ts", [[5, 40]])]),
      radarPr(13, [radarFile("src/a.ts", [[6, 8]])]),
    ],
    limits: { max_prs: 200, max_file_pages_per_pr: 3, max_pairs: 2 },
    prsTruncated: true,
    updatedAt: "2026-07-06T00:00:00.000Z",
  });
  const markdown = renderPrInterferenceMarkdown(report);
  assert.match(markdown, /# PR interference radar - openclaw\/openclaw/);
  assert.match(markdown, /3 open pull requests scanned, 2 interfering pairs\./);
  assert.match(
    markdown,
    /\[#11\]\(https:\/\/github\.com\/openclaw\/openclaw\/pull\/11\) \(draft\) and \[#12\]/,
  );
  assert.match(markdown, /#11 within #12/);
  assert.match(markdown, /`src\/a\.ts`/);
  assert.match(markdown, /10-12/);
  assert.match(markdown, /base-branch coordinates/);
  assert.match(
    markdown,
    /Truncated: the open pull request list and the pair list; the scan is not complete\./,
  );
});

test("renderPrInterferenceMarkdown renders the empty state", () => {
  const report = buildPrInterferenceReport({
    targetRepo: "openclaw/openclaw",
    prs: [],
    limits: { max_prs: 200, max_file_pages_per_pr: 3, max_pairs: 50 },
    prsTruncated: false,
    updatedAt: "2026-07-06T00:00:00.000Z",
  });
  const markdown = renderPrInterferenceMarkdown(report);
  assert.match(markdown, /0 open pull requests scanned, 0 interfering pairs\./);
  assert.match(markdown, /No interfering open pull request pairs found\./);
  assert.match(markdown, /No truncation occurred\./);
});
