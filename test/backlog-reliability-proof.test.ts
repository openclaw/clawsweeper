import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

for (const surface of ["source-recovery", "dead-letter-inventory", "batch-concurrency"]) {
  test(`backlog ${surface} behavior proof`, { skip: process.platform === "win32" }, () => {
    const result = JSON.parse(
      execFileSync(process.execPath, [`scripts/e2e/backlog-${surface}.mjs`], {
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env, NODE_V8_COVERAGE: undefined },
      }),
    );
    assert.ok(result && typeof result === "object");
  });
}
