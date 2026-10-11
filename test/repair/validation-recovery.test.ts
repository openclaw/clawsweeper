import assert from "node:assert/strict";
import test from "node:test";
import {
  ValidationRecoveryRequiredError,
  validationRecoveryRequired,
} from "../../dist/repair/validation-recovery.js";

test("recovery errors retain acquisition paths and the original cause", () => {
  const cause = new Error("supervisor completion could not be verified");
  const recovery = new ValidationRecoveryRequiredError("acquisition failed", cause, ["/checkout"]);
  assert.equal(recovery.cause, cause);
  assert.equal(recovery.retain(["/checkout", "/retained-source"]), recovery);
  assert.deepEqual([...recovery.recoveryPaths], ["/checkout", "/retained-source"]);
  assert.match(recovery.message, /stop and verify all target processes have exited/);
  assert.match(recovery.message, /do not retry this checkout/);
  assert.match(recovery.message, /Retained paths: \/checkout, \/retained-source/);
});

test("review callers find recovery errors through wrapped causes", () => {
  const recovery = new ValidationRecoveryRequiredError("lost supervisor receipt", null);
  const wrapped = new Error("review source preparation failed", {
    cause: new Error("acquisition failed", { cause: recovery }),
  });
  assert.equal(validationRecoveryRequired(recovery), recovery);
  assert.equal(validationRecoveryRequired(wrapped), recovery);
  assert.equal(validationRecoveryRequired(new Error("ordinary failure")), null);
  assert.equal(validationRecoveryRequired(null), null);
});

test("cause traversal terminates when errors form a cycle", () => {
  const outer = new Error("outer");
  const inner = new Error("inner", { cause: outer });
  outer.cause = inner;
  assert.equal(validationRecoveryRequired(outer), null);
});
