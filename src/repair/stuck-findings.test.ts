import assert from "node:assert/strict";
import test from "node:test";

import {
  computeStuckFindings,
  detectStuckFindings,
  parseReviewFindings,
  renderStuckFindingsConstraint,
  selectRecentClawsweeperReviews,
  stuckFindingsToTelemetry,
} from "./stuck-findings.js";

function review({
  body,
  createdAt = "2026-05-21T12:00:00Z",
}: {
  body: string;
  createdAt?: string;
}) {
  return { body, created_at: createdAt };
}

const VERDICT_MARKER =
  "<!-- clawsweeper-verdict:needs-changes item=55 sha=abc confidence=medium -->";

test("parseReviewFindings extracts canonical [P*] file:line markers", () => {
  const body = `${VERDICT_MARKER}\n\n**Review findings**\n- [P2] Tighten the max_tokens failure classifier — \`src/clawsweeper.ts:4364\`\n- [P1] Drop the dead retry telemetry path — \`src/usage-telemetry.ts:120\`\n`;
  const findings = parseReviewFindings(body);
  assert.deepEqual(findings, [
    {
      priority: 2,
      summary: "Tighten the max_tokens failure classifier",
      filePath: "src/clawsweeper.ts",
      line: 4364,
    },
    {
      priority: 1,
      summary: "Drop the dead retry telemetry path",
      filePath: "src/usage-telemetry.ts",
      line: 120,
    },
  ]);
});

test("parseReviewFindings accepts double-dash separator alongside em dash", () => {
  const body = "- [P3] Trim the log line -- `src/repair/exec.ts:99`";
  assert.deepEqual(parseReviewFindings(body), [
    { priority: 3, summary: "Trim the log line", filePath: "src/repair/exec.ts", line: 99 },
  ]);
});

test("parseReviewFindings ignores prose bullets, footnotes, and missing line numbers", () => {
  const body = `Some prose first.\n- A non-finding bullet that mentions [P2] in passing\n- [P2] Missing line — \`src/foo.ts\`\n- [P2] Real finding — \`src/foo.ts:42\`\n* [P4] Star-prefixed finding — \`src/bar.ts:7\``;
  assert.deepEqual(parseReviewFindings(body), [
    { priority: 2, summary: "Real finding", filePath: "src/foo.ts", line: 42 },
    { priority: 4, summary: "Star-prefixed finding", filePath: "src/bar.ts", line: 7 },
  ]);
});

test("parseReviewFindings on empty / non-string input returns an empty array", () => {
  assert.deepEqual(parseReviewFindings(""), []);
  assert.deepEqual(parseReviewFindings(undefined as unknown as string), []);
});

test("selectRecentClawsweeperReviews drops non-bot comments and sorts newest first", () => {
  const comments = [
    review({ body: "human nit, no marker", createdAt: "2026-05-21T11:00:00Z" }),
    review({ body: `${VERDICT_MARKER}\nfirst bot review`, createdAt: "2026-05-21T12:00:00Z" }),
    review({ body: "another human comment", createdAt: "2026-05-21T12:30:00Z" }),
    review({ body: `${VERDICT_MARKER}\nsecond bot review`, createdAt: "2026-05-21T13:00:00Z" }),
    review({ body: `${VERDICT_MARKER}\nthird bot review`, createdAt: "2026-05-21T14:00:00Z" }),
  ];
  const picked = selectRecentClawsweeperReviews(comments);
  assert.equal(picked.length, 3);
  assert.match(picked[0]!.body!, /third bot review/);
  assert.match(picked[1]!.body!, /second bot review/);
  assert.match(picked[2]!.body!, /first bot review/);
});

test("computeStuckFindings flags findings that survived across reviews", () => {
  const prior = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten the classifier — \`src/clawsweeper.ts:4364\`\n- [P3] Fix the spelling — \`README.md:12\``,
    createdAt: "2026-05-21T12:00:00Z",
  });
  const current = review({
    body: `${VERDICT_MARKER}\n- [P2] Classifier still matches bare max_tokens — \`src/clawsweeper.ts:4364\`\n- [P1] New finding — \`src/new.ts:10\``,
    createdAt: "2026-05-21T13:00:00Z",
  });
  const stuck = computeStuckFindings([prior, current]);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]!.filePath, "src/clawsweeper.ts");
  assert.equal(stuck[0]!.line, 4364);
  assert.equal(stuck[0]!.priority, 2);
  // Reworded summary is taken from the current review, not the prior one.
  assert.match(stuck[0]!.summary, /Classifier still matches bare/);
  assert.equal(stuck[0]!.priorOccurrences, 1);
});

test("computeStuckFindings counts repeats across multiple prior reviews", () => {
  const oldest = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T11:00:00Z",
  });
  const middle = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T12:00:00Z",
  });
  const current = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T13:00:00Z",
  });
  const stuck = computeStuckFindings([oldest, middle, current]);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]!.priorOccurrences, 2);
});

test("computeStuckFindings returns empty when there is only one bot review", () => {
  const only = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten — \`src/foo.ts:10\``,
  });
  assert.deepEqual(computeStuckFindings([only]), []);
});

test("computeStuckFindings returns empty when findings do not intersect", () => {
  const prior = review({
    body: `${VERDICT_MARKER}\n- [P2] A — \`src/a.ts:1\``,
    createdAt: "2026-05-21T12:00:00Z",
  });
  const current = review({
    body: `${VERDICT_MARKER}\n- [P2] B — \`src/b.ts:1\``,
    createdAt: "2026-05-21T13:00:00Z",
  });
  assert.deepEqual(computeStuckFindings([prior, current]), []);
});

test("computeStuckFindings keys on (file, line, priority) — priority bumps reset stuckness", () => {
  const prior = review({
    body: `${VERDICT_MARKER}\n- [P3] Cosmetic — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T12:00:00Z",
  });
  const current = review({
    body: `${VERDICT_MARKER}\n- [P1] Now blocking — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T13:00:00Z",
  });
  // Same file:line but different priority — treated as a new finding,
  // not a stuck one. The repair worker should approach a P1 escalation
  // without the "stop adding scope" addendum that suits a stuck P3.
  assert.deepEqual(computeStuckFindings([prior, current]), []);
});

test("detectStuckFindings swallows fetcher errors and returns empty", () => {
  const stuck = detectStuckFindings({
    repo: "valkyriweb/clawsweeper",
    prNumber: 55,
    fetcher: () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(stuck, []);
});

test("detectStuckFindings short-circuits on bad inputs", () => {
  assert.deepEqual(detectStuckFindings({ repo: "", prNumber: 55 }), []);
  assert.deepEqual(detectStuckFindings({ repo: "x/y", prNumber: 0 }), []);
  assert.deepEqual(detectStuckFindings({ repo: "x/y", prNumber: 1 }), []);
});

test("detectStuckFindings drives the production parser path through a fetcher stub", () => {
  const prior = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T12:00:00Z",
  });
  const current = review({
    body: `${VERDICT_MARKER}\n- [P2] Tighten — \`src/foo.ts:10\``,
    createdAt: "2026-05-21T13:00:00Z",
  });
  const stuck = detectStuckFindings({
    repo: "valkyriweb/clawsweeper",
    prNumber: 55,
    fetcher: (path, limit) => {
      assert.match(path, /\/repos\/valkyriweb\/clawsweeper\/issues\/55\/comments/);
      assert.ok(limit > 0);
      return [prior, current];
    },
  });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]!.filePath, "src/foo.ts");
});

test("renderStuckFindingsConstraint returns empty string for empty input", () => {
  assert.equal(renderStuckFindingsConstraint([]), "");
});

test("renderStuckFindingsConstraint renders an explicit scope-narrowing block", () => {
  const text = renderStuckFindingsConstraint([
    {
      priority: 2,
      summary: "Tighten the classifier",
      filePath: "src/clawsweeper.ts",
      line: 4364,
      priorOccurrences: 1,
    },
  ]);
  assert.match(text, /Previous repair attempt\(s\) on this PR did not modify/);
  assert.match(text, /\[P2\] Tighten the classifier — `src\/clawsweeper\.ts:4364`/);
  assert.match(text, /make ONLY the targeted change/);
  assert.match(text, /Do not widen scope to retry\/logging\/telemetry refactors/);
});

test("renderStuckFindingsConstraint surfaces repeat counts when N > 1", () => {
  const text = renderStuckFindingsConstraint([
    {
      priority: 2,
      summary: "Tighten",
      filePath: "src/clawsweeper.ts",
      line: 4364,
      priorOccurrences: 2,
    },
  ]);
  assert.match(text, /flagged 2× before/);
});

test("stuckFindingsToTelemetry exposes a stable structured shape", () => {
  const out = stuckFindingsToTelemetry([
    {
      priority: 2,
      summary: "Tighten",
      filePath: "src/clawsweeper.ts",
      line: 4364,
      priorOccurrences: 1,
    },
  ]) as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(out, [
    {
      priority: 2,
      file_path: "src/clawsweeper.ts",
      line: 4364,
      prior_occurrences: 1,
      summary: "Tighten",
    },
  ]);
});
