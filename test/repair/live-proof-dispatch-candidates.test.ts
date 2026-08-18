import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("live-proof dispatch candidate CLI emits recommended enabled records as JSONL", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-candidates-"));
  const items = join(root, "openclaw-clawsweeper", "items");
  mkdirSync(items, { recursive: true });
  writeFileSync(
    join(items, "42.md"),
    `## Live Proof

Status: recommended

Surface: browser

Reason: The changed settings confirmation is visible in the browser.

Payoff: ui_interaction

Payoff justification: The viewer sees the confirmation appear after clicking Save.

Entry: /settings

Steps:

- {"action":"goto","path":"/settings"}
- {"action":"expect_text","text":"Saved"}
`,
    "utf8",
  );
  writeFileSync(
    join(items, "43.md"),
    `## Live Proof

Status: not_applicable

Surface: none

Reason: This change has no visible behavior.

Payoff: static_text

Payoff justification: There is no visual recording payoff.

Entry:

Steps:
`,
    "utf8",
  );

  try {
    const output = execFileSync(
      process.execPath,
      [resolve("dist/repair/live-proof-dispatch-candidates.js")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TARGET_REPO: "openclaw/clawsweeper",
          ITEM_NUMBERS: "42,43,44",
          RECORDS_ROOT: root,
        },
      },
    );
    assert.deepEqual(output.trim().split("\n").map(JSON.parse), [
      {
        item: 42,
        plan: {
          status: "recommended",
          surface: "browser",
          reason: "The changed settings confirmation is visible in the browser.",
          payoff: {
            kind: "ui_interaction",
            justification: "The viewer sees the confirmation appear after clicking Save.",
          },
          entry: "/settings",
          steps: [
            { action: "goto", path: "/settings" },
            { action: "expect_text", text: "Saved" },
          ],
        },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
