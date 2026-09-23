import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

// This workflow uses Linux process groups; other hosts retain the static checks.
test(
  "exact-review startup fences stale owners before either generation path",
  {
    skip: process.platform !== "linux",
    timeout: 90_000,
  },
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["scripts/e2e/exact-review-start-authority.mjs"],
      { timeout: 85_000 },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.guarded, true);
    assert.equal(result.cases.length, 12);
    assert.ok(result.cases.every((entry: { processesReaped: boolean }) => entry.processesReaped));
  },
);
