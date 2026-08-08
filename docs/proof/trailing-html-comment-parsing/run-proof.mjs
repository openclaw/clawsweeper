#!/usr/bin/env node
/**
 * Real-behavior proof for the trailing HTML comment parsing fix.
 *
 * Three claims, all against the built dist/:
 *
 *   1. WELL-FORMED - every returned entry is a single HTML comment: it opens with
 *                    `<!--`, closes with `-->`, and holds no interior terminator.
 *                    A blob spanning visible prose violates this.
 *   2. BOUNDED     - the mid-body `<!-- clawsweeper-review-history -->` marker that
 *                    renderReviewHistorySection emits is never dragged into the
 *                    trailing block by a later stray arrow.
 *   3. NO LOSS     - for bodies with a clean trailing block, the fix returns
 *                    exactly what the pre-fix parser returned. It must not make a
 *                    previously-recoverable marker unrecoverable.
 *
 * Claim 3 compares against a pre-fix build supplied as argv[2]; without it the
 * claim is reported SKIPPED and the proof FAILS rather than passing silently.
 *
 * Usage: node docs/proof/trailing-html-comment-parsing/run-proof.mjs [preFixMarkers.js]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distMarkers = path.join(repoRoot, "dist", "review-comment-markers.js");

if (!fs.existsSync(distMarkers)) {
  console.error(`missing build artifact: ${distMarkers}\nrun: pnpm run build`);
  process.exit(2);
}
const { trailingHtmlComments } = await import(`file://${distMarkers}`);

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    if (detail) console.log(`        ${detail}`);
    failures.push(label);
  }
};

const VERDICT = "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->";
const REVIEW = "<!-- clawsweeper-review item=321 -->";
const HISTORY = "<!-- clawsweeper-review-history v=1 total=2 -->";

/** A durable review body shaped like the real renderer emits one. */
const reviewBody = (proseBeforeMarkers) =>
  [
    "Codex review: ready for maintainer look.",
    "",
    "## How this fits together",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Open GitHub item pages] --> B[Review planning]",
    "```",
    "",
    "<details>",
    "<summary>Review history (2 cycles)</summary>",
    HISTORY,
    "- reviewed abc :: ready :: none",
    "</details>",
    "",
    ...(proseBeforeMarkers ? [proseBeforeMarkers, ""] : []),
    VERDICT,
    REVIEW,
  ].join("\n");

const CASES = {
  "clean trailing block": reviewBody(null),
  "prose ending in an arrow": reviewBody("Data flows plan --> review --> apply -->"),
  "marker then prose then markers": [VERDICT, "renders as -->", REVIEW].join("\n"),
  "arrow directly before markers": ["intro -->", VERDICT, REVIEW].join("\n"),
  "no markers": "just prose --> with an arrow",
  "unterminated opener": `<!--${"--><!--".repeat(50)}unterminated`,
};

/* -- Claim 1: every returned entry is one well-formed comment -------------- */

/**
 * One well-formed comment: opens, closes, and carries no terminator before the
 * closing one. Expressed as "the body before the final terminator contains no
 * terminator" rather than `indexOf("-->") === length - 3`, which compares equal
 * when indexOf returns -1 and the string is two characters long.
 */
const isSingleWellFormedComment = (marker) =>
  marker.startsWith("<!--") && marker.endsWith("-->") && !marker.slice(0, -3).includes("-->");

console.log("== Claim 1: every returned entry is a single well-formed comment ==\n");
for (const [name, body] of Object.entries(CASES)) {
  const markers = trailingHtmlComments(body);
  const bad = markers.filter((m) => !isSingleWellFormedComment(m));
  check(
    `${name} (${markers.length} marker${markers.length === 1 ? "" : "s"})`,
    bad.length === 0,
    bad.length ? `malformed: ${JSON.stringify(bad[0].slice(0, 100))}` : undefined,
  );
}

/* -- Claim 2: the mid-body history marker stays out of the trailing block -- */

console.log("\n== Claim 2: the mid-body review-history marker is never bridged into ==\n");
for (const [name, body] of Object.entries({
  "clean trailing block": reviewBody(null),
  "prose ending in an arrow": reviewBody("Data flows plan --> review --> apply -->"),
})) {
  const markers = trailingHtmlComments(body);
  check(
    `${name}: history marker absent from trailing block`,
    markers.every((m) => !m.includes("clawsweeper-review-history")),
  );
  check(`${name}: durable review marker recovered`, markers.includes(REVIEW));
}

/* -- Claim 3: no regression for clean bodies ------------------------------ */

console.log("\n== Claim 3: clean trailing blocks parse exactly as before ==\n");
const preFixPath = process.argv[2];
if (!preFixPath) {
  console.log("  SKIPPED  no pre-fix build supplied (argv[2]); no-loss not measured");
  failures.push("claim 3 not measured");
} else if (!fs.existsSync(preFixPath)) {
  console.log(`  FAIL     pre-fix build not found: ${preFixPath}`);
  failures.push("claim 3 pre-fix build missing");
} else {
  const pre = await import(`file://${path.resolve(preFixPath)}`);
  const CLEAN = {
    "clean review body": reviewBody(null),
    "two adjacent markers": [VERDICT, REVIEW].join("\n"),
    "markers on one line": `${VERDICT} ${REVIEW}`,
    "trailing whitespace": `${VERDICT}\n${REVIEW}\n\n  \n`,
    "single marker": REVIEW,
    "no markers": "prose only",
    "unterminated opener": `<!--${"--><!--".repeat(50)}unterminated`,
  };
  for (const [name, body] of Object.entries(CLEAN)) {
    const before = pre.trailingHtmlComments(body);
    const after = trailingHtmlComments(body);
    check(
      `${name}: identical to pre-fix`,
      JSON.stringify(before) === JSON.stringify(after),
      `pre : ${JSON.stringify(before)}\n        post: ${JSON.stringify(after)}`,
    );
  }
  // And the defect itself must differ.
  const buggy = [VERDICT, "renders as -->", REVIEW].join("\n");
  const before = pre.trailingHtmlComments(buggy);
  const after = trailingHtmlComments(buggy);
  console.log("\n  defect case: marker, prose ending in an arrow, marker");
  console.log(`    pre-fix : ${JSON.stringify(before)}`);
  console.log(`    post-fix: ${JSON.stringify(after)}`);
  check(
    "pre-fix emitted a blob spanning prose",
    before.some((m) => m.includes("renders as")),
  );
  check(
    "post-fix emits no blob spanning prose",
    after.every((m) => !m.includes("renders as")),
  );
}

console.log(`\nRESULT: ${failures.length === 0 ? "PASS" : "FAIL"}`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
