#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [captureRoot, artifactDir, baseSha, headSha] = process.argv.slice(2);
assert(captureRoot && artifactDir && baseSha && headSha, "missing page comparison arguments");

const pages = ["root", "triage", "pr-proof-triage"];
const results = [];
const diff = [];
for (const page of pages) {
  const before = await readFile(path.join(captureRoot, "before", `${page}.html`), "utf8");
  const after = await readFile(path.join(captureRoot, "after", `${page}.html`), "utf8");
  const normalizedBefore = normalize(before);
  const normalizedAfter = normalize(after);
  const equal = normalizedBefore === normalizedAfter;
  if (!equal) diff.push(renderFirstDifference(page, normalizedBefore, normalizedAfter));
  results.push({
    page,
    route: page === "root" ? "/" : `/${page}`,
    before_bytes: Buffer.byteLength(before),
    after_bytes: Buffer.byteLength(after),
    before_sha256: sha256(before),
    after_sha256: sha256(after),
    normalized_before_sha256: sha256(normalizedBefore),
    normalized_after_sha256: sha256(normalizedAfter),
    normalized_equal: equal,
  });
}

await writeFile(path.join(artifactDir, "normalized.diff"), diff.join("\n"));
await writeFile(
  path.join(artifactDir, "page-comparison.json"),
  `${JSON.stringify(
    {
      schema: "clawsweeper-dashboard-page-extraction-proof/v1",
      base_sha: baseSha,
      head_sha: headSha,
      normalization: ["ISO-8601 timestamps", "40-character hexadecimal SHAs"],
      pages: results,
      normalized_diff_empty: diff.length === 0,
    },
    null,
    2,
  )}\n`,
);
assert.equal(diff.length, 0, "normalized rendered-page diff was not empty");
console.log("normalized_page_diff=empty");
for (const result of results) {
  console.log(
    `${result.route} bytes=${result.after_bytes} sha256=${result.after_sha256} normalized_equal=${result.normalized_equal}`,
  );
}

function normalize(value) {
  return value
    .replace(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<normalized-timestamp>")
    .replace(/\b[0-9a-f]{40}\b/gi, "<normalized-sha>");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function renderFirstDifference(page, before, after) {
  let offset = 0;
  while (offset < before.length && offset < after.length && before[offset] === after[offset]) offset += 1;
  return [
    `--- before/${page}.html`,
    `+++ after/${page}.html`,
    `@@ first differing character ${offset} @@`,
    `-${JSON.stringify(before.slice(offset, offset + 160))}`,
    `+${JSON.stringify(after.slice(offset, offset + 160))}`,
  ].join("\n");
}
