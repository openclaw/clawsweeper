import assert from "node:assert/strict";
import test from "node:test";

import { safePreflightErrorMessage } from "../../dist/repair/containment-preflight.js";

test("containment preflight preserves only validated safe diagnostics", () => {
  assert.equal(
    safePreflightErrorMessage(
      new Error(
        "validation process containment failed: stage=landlock_capability_probe syscall=444 errno=38",
      ),
    ),
    "validation process containment failed: stage=landlock_capability_probe syscall=444 errno=38",
  );
  assert.equal(
    safePreflightErrorMessage(
      new Error("validation process containment failed: stage=namespace_setup exit=125"),
    ),
    "validation process containment failed: stage=namespace_setup exit=125",
  );
  assert.equal(
    safePreflightErrorMessage(new Error("failed near /home/runner/target-work command")),
    "containment preflight failed closed",
  );
});
