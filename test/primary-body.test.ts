import assert from "node:assert/strict";
import test from "node:test";
import { compactPrimaryBody } from "../dist/clawsweeper-primary-body.js";
import { truncateText } from "../dist/clawsweeper-text.js";
import {
  assertBodyCoverage,
  hydration,
  inertTrace,
  longProofBody,
} from "./primary-body-fixture.ts";

for (const value of [null, undefined, "", "x".repeat(11999), "x".repeat(12000)]) {
  test(`short primary body stays intact without metadata: ${typeof value}, ${String(value ?? "").length}`, () => {
    assert.deepEqual(compactPrimaryBody(value), { body: value ?? "" });
  });
}

test("12,001-unit body reserves serialized coverage budget", () => {
  const body = "x".repeat(12001);
  const compact = compactPrimaryBody(body);
  assertBodyCoverage(body, compact);
  assert.equal(compact.bodyCoverage?.excerpts.length, 0);
  assert.ok(compact.body.length > 11000);
});

test("early supplemental proof cannot crowd out the later actual trace", () => {
  const body = longProofBody();
  assert.equal(body.length, 60641);
  assert.equal(body.indexOf("## Real Behavior Proof"), 6166);
  assert.equal(body.indexOf("## Actual Native Proof"), 14235);
  assert.equal(body.indexOf("Selected HTTP/native SQL trace"), 19562);
  const compact = compactPrimaryBody(body);
  assertBodyCoverage(body, compact);
  assert.deepEqual(
    compact.bodyCoverage?.excerpts.map(({ start }) => start),
    [6166, 14235, 19562],
  );
  assert.ok(compact.bodyCoverage?.excerpts.some(({ text }) => text.includes(inertTrace)));
});

for (const [name, body] of [
  ["no anchors", "unrecognized layout\n".repeat(2000)],
  [
    "repeated and overlapping anchors",
    "x".repeat(5000) + "\n## Proof\n## Proof\nOutput:\nHTTP/1.1 202 Accepted\n".repeat(500),
  ],
  ["candidate overflow", "x".repeat(5000) + ("\n## Output\n" + "x".repeat(4000)).repeat(150)],
  [
    "malformed details and fences",
    "x".repeat(15000) +
      "\n<details><summary>Proof\n```broken\nOutput:\n" +
      inertTrace +
      "\n".repeat(10000),
  ],
  ["oversized trace", "x".repeat(15000) + "\n## Trace\n" + "row=1\n".repeat(10000)],
  ["JSON escaping", "x".repeat(15000) + "\n## Output\n" + '\u0000\\"\t\r\n'.repeat(10000)],
  ["astral prefix and excerpts", "🦞".repeat(8000) + "\n## Output\n" + "🦞".repeat(10000)],
  [
    "CRLF",
    "x".repeat(15000) + "\r\n<summary>Output</summary>\r\n" + inertTrace + "\r\n".repeat(10000),
  ],
] as const) {
  test(`bounded exact coverage with ${name}`, () => {
    const compact = compactPrimaryBody(body);
    assertBodyCoverage(body, compact);
    assert.deepEqual(compactPrimaryBody(body), compact);
    if (name === "no anchors") assert.deepEqual(compact.bodyCoverage?.excerpts, []);
    if (name === "candidate overflow") assert.equal(compact.bodyCoverage?.excerpts.length, 3);
    if (name === "oversized trace") {
      assert.ok(compact.bodyCoverage?.excerpts[0]?.text.includes("row=1"));
      assert.ok(compact.bodyCoverage!.excerpts[0]!.end < body.length);
    }
  });
}

test("surrogate pairs at prefix and supplemental cuts remain whole", () => {
  for (const offset of [0, 1]) {
    const body = "x".repeat(offset) + "🦞".repeat(8000) + "\n## Output\n" + "🦞".repeat(10000);
    assertBodyCoverage(body, compactPrimaryBody(body));
  }
});

test("generic compactors keep related body, comment, list, commit and patch budgets", () => {
  const body = longProofBody();
  for (const compact of [
    hydration.compactIssue({ body }),
    hydration.compactPullRequest({ body }),
  ]) {
    assert.equal((compact as { body: string }).body, truncateText(body, 12000));
    assert.equal("bodyCoverage" in (compact as object), false);
  }
  assert.equal(
    (hydration.compactComment({ body }) as { body: string }).body,
    truncateText(body, 6000),
  );
  for (const cap of [24, 40, 80]) {
    const values = Array.from({ length: 100 }, (_, id) => ({ id }));
    const retained = hydration.compactMappedWindow(values, 100, cap, (value) => value);
    assert.equal(retained.length, cap + 1);
    assert.deepEqual(retained[Math.floor(cap / 2)], {
      omitted: 100 - cap,
      note: "middle entries omitted from prompt context",
    });
  }
  assert.equal(
    (hydration.compactPullFile({ patch: body }) as { patch: string }).patch,
    truncateText(body, 2000),
  );
});
