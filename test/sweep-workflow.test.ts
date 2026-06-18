import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("sweep keeps optional media tooling out of review startup", () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/sweep.yml"), "utf8");

  assert.doesNotMatch(workflow, /setup-media-proof-tools/);
});
