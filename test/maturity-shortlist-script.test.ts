import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("maturity shortlist script distinguishes eligible primary surfaces from exclusions", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-maturity-"));
  try {
    const scorecard = join(dir, "maturity-scores.yaml");
    writeFileSync(
      scorecard,
      [
        "surfaces:",
        "  - id: gateway-runtime",
        "    name: Gateway runtime",
        "    level:",
        "      code: M4",
        "      label: Stable",
        "    scores:",
        "      quality:",
        "        score: 81",
        "      completeness:",
        "        score: 89",
        "    categories:",
        "      - name: HTTP APIs",
        "  - id: agent-runtime",
        "    name: Agent runtime",
        "    level:",
        "      code: M3",
        "      label: Beta",
      ].join("\n"),
    );

    const output = execFileSync(process.execPath, [
      "scripts/maturity-stable-shortlist.mjs",
      scorecard,
    ]).toString();

    assert.match(output, /Primary-surface rule:/);
    assert.match(output, /M4\+ primary surfaces \(eligible for maturity:stable\):/);
    assert.match(output, /gateway-runtime \| Gateway runtime \| M4 Stable \| q81 c89/);
    assert.match(output, /categories: HTTP APIs/);
    assert.match(output, /Below-M4 primary surfaces \(not eligible for maturity:stable\):/);
    assert.match(output, /agent-runtime \| Agent runtime \| M3 Beta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
