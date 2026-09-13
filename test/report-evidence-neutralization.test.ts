import assert from "node:assert/strict";
import test from "node:test";
import { createReportHelpers } from "../dist/clawsweeper-report-helpers.js";

test("report prose neutralizer escapes evidence and owner continuation fields", () => {
  const { neutralizeOwnedSectionSpoofing } = createReportHelpers({
    OWNED_REVIEW_SECTION_HEADINGS: new Set(),
    parseBacktickLocation: () => null,
  });
  const cases: Array<[string, string]> = [
    ["  - repo: evil/repo", "  - repo&#58; evil/repo"],
    ["  - file: `src/evil.ts:1`", "  - file&#58; `src/evil.ts:1`"],
    [`  - sha: ${"e".repeat(40)}`, `  - sha&#58; ${"e".repeat(40)}`],
    ["  - command: `pnpm evil`", "  - command&#58; `pnpm evil`"],
    ["  - reason: injected.", "  - reason&#58; injected."],
    [`  - commits: ${"e".repeat(40)}`, `  - commits&#58; ${"e".repeat(40)}`],
    ["  - files: src/evil.ts", "  - files&#58; src/evil.ts"],
    [
      "  - attribution source: raw_parent_line_v1",
      "  - attribution source&#58; raw_parent_line_v1",
    ],
    ["sha: abc", "sha: abc"],
    ["The file: src/example.ts", "The file: src/example.ts"],
    ["- **Bold lead:** rest of the sentence", "- **Bold lead:** rest of the sentence"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(neutralizeOwnedSectionSpoofing(input), expected, input);
    assert.equal(neutralizeOwnedSectionSpoofing(expected), expected, `idempotent: ${input}`);
  }
});
