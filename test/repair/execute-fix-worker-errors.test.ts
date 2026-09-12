import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as transient from "../../src/codex-transient.ts";
import * as pushErrors from "../../src/repair/repair-branch-push-errors.ts";

const source = fs.readFileSync("src/repair/execute-fix-artifact.ts", "utf8");
const start = source.indexOf("function isRetryableCodexFailure(");
const end = source.indexOf("function shouldFallbackToReplacementAfterRepairError(", start);
assert.ok(start >= 0 && end > start);
const dependencies = { ...transient, ...pushErrors };
const { isBlockedFixError, isRetryableCodexFailure } = new Function(
  ...Object.keys(dependencies),
  `${stripTypeScriptTypes(source.slice(start, end))}; return { isBlockedFixError, isRetryableCodexFailure };`,
)(...Object.values(dependencies));

for (const phase of ["fix worker", "review-fix worker", "validation-fix worker", "/review"]) {
  for (const failure of ["timed out after 1800000ms", "failed"]) {
    test(`${phase} ${failure} retains the blocked recovery outcome`, () => {
      const message = `Codex ${phase} ${failure}`;
      assert.equal(isBlockedFixError(new Error(message)), true);
      assert.equal(isRetryableCodexFailure(message), true);
    });
  }
}

test("validation-fix reporting does not make persistent setup failures retryable", () => {
  assert.equal(
    isRetryableCodexFailure("Codex validation-fix worker failed: login required"),
    false,
  );
  assert.equal(isRetryableCodexFailure("Codex validation-fix worker failed: bwrap setup"), false);
  assert.equal(isBlockedFixError(new Error("unexpected executor invariant failure")), false);
});
