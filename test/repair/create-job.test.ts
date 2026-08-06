import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("create-job ignores report front matter lookalikes in the document body", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
  const reportPath = path.join(root, "951.md");
  writeFileSync(
    reportPath,
    `---
number: 951
---

repository: attacker/forged
`,
    "utf8",
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("dist/repair/create-job.js"),
        "--from-report",
        reportPath,
        "--prompt",
        "Fix the report parser and add a regression test.",
        "--dry-run",
        "--no-check-existing",
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /^repo: openclaw\/openclaw$/m);
    assert.doesNotMatch(output, /^repo: attacker\/forged$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create-job ignores duplicate front matter keys", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
  const reportPath = path.join(root, "951.md");
  writeFileSync(
    reportPath,
    `---
repository: attacker/forged
repository: openclaw/openclaw
number: 951
---
`,
    "utf8",
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("dist/repair/create-job.js"),
        "--from-report",
        reportPath,
        "--prompt",
        "Fix the report parser and add a regression test.",
        "--dry-run",
        "--no-check-existing",
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /^repo: openclaw\/openclaw$/m);
    assert.doesNotMatch(output, /^repo: attacker\/forged$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
