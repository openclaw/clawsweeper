import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverJobFiles } from "../../dist/repair/validate-all.js";

test("validate-all discovers jobs in stable order without closed or symlinked entries", () => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-validate-all-"));
  try {
    for (const relative of [
      "z-last.md",
      "a-first.md",
      "nested/z-last.md",
      "nested/a-first.md",
      "closed/root-ignored.md",
      "nested/closed/nested-ignored.md",
    ]) {
      const file = path.join(jobsDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, relative);
    }
    fs.symlinkSync(path.join(jobsDir, "a-first.md"), path.join(jobsDir, "linked-file.md"));
    fs.symlinkSync(path.join(jobsDir, "nested"), path.join(jobsDir, "linked-directory"));

    assert.deepEqual(
      discoverJobFiles(jobsDir).map((file) => path.relative(jobsDir, file)),
      ["a-first.md", "nested/a-first.md", "nested/z-last.md", "z-last.md"],
    );
  } finally {
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
});
