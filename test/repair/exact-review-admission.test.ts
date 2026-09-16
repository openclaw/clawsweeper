import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { runReadScopeProof } from "../../scripts/e2e/exact-review-noop-read-scope.mjs";

test("compiled live admission preserves decisions and scopes its single public-read fallback", () => {
  runReadScopeProof();
});

for (const phase of ["snapshot construction", "proof validation"]) {
  test("admission proof removes its runtime after failed " + phase, (t) => {
    const directories: string[] = [];
    const mkdtemp = fs.mkdtempSync;
    t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof mkdtemp>) => {
      const directory = mkdtemp(...args);
      assert.equal(typeof directory, "string");
      directories.push(directory);
      return directory;
    });
    // No command reaches these empty copies: inject failure during construction
    // or validate an unknown scenario after the runtime has been allocated.
    t.mock.method(fs, "cpSync", () => {
      if (phase === "snapshot construction") throw new Error("fixture copy failed");
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => runReadScopeProof({ scenarioNames: ["unknown cleanup scenario"] }),
        phase === "snapshot construction" ? /fixture copy failed/ : /unknown proof scenario/,
      );
      assert.equal(directories.length, 1);
      assert.ok(directories.every((directory) => !fs.existsSync(directory)));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
