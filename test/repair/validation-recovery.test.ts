import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { runContainedCommand } from "../../dist/repair/command-runner.js";
import {
  ValidationRecoveryRequiredError,
  validationRecoveryRequired,
  withDisposableValidationState,
} from "../../dist/repair/validation-recovery.js";

test("only a complete supervisor receipt permits restoration", (t) => {
  const valid = { backgroundProcesses: 0, signal: null, status: 0, stdout: "done", stderr: "" };
  for (const receipt of [
    "",
    "{",
    "null",
    "{}",
    JSON.stringify({ ...valid, backgroundProcesses: -1 }),
    JSON.stringify({ ...valid, error: {} }),
  ]) {
    const spawn = t.mock.method(childProcess, "spawnSync", () => ({
      status: 0,
      stdout: receipt,
      stderr: "",
    }));
    syncBuiltinESMExports();
    let restored = false;
    try {
      assert.throws(
        () =>
          withDisposableValidationState(
            (save) =>
              save({
                recoveryPaths: ["/saved-state"],
                restore: () => {
                  restored = true;
                },
              }),
            () => runContainedCommand(process.execPath, ["--version"]),
          ),
        (error) => {
          const recovery = validationRecoveryRequired(error);
          return Boolean(recovery?.recoveryPaths.has("/saved-state"));
        },
      );
      assert.equal(restored, false);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("joined failures restore state and retain the command cause", (t) => {
  for (const result of [
    { status: 1, stderr: "ordinary failure" },
    { status: 0, backgroundProcesses: 1 },
    { status: null, error: { code: "ETIMEDOUT", message: "timeout" } },
  ]) {
    const receipt = { backgroundProcesses: 0, signal: null, stdout: "", stderr: "", ...result };
    const spawn = t.mock.method(childProcess, "spawnSync", () => ({
      status: 0,
      stdout: JSON.stringify(receipt),
      stderr: "",
    }));
    syncBuiltinESMExports();
    let restored = false;
    try {
      assert.throws(
        () =>
          withDisposableValidationState(
            (save) =>
              save({
                recoveryPaths: [],
                restore: () => {
                  restored = true;
                },
              }),
            () => runContainedCommand(process.execPath, ["--version"], { timeoutMs: 100 }),
          ),
        (error) => error instanceof Error && !validationRecoveryRequired(error),
      );
      assert.equal(restored, true);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("restoration failure preserves recovery paths and original failure context", () => {
  const cause = new Error("restore failed");
  assert.throws(
    () =>
      withDisposableValidationState(
        (save) =>
          save({
            recoveryPaths: ["/saved-state"],
            restore: () => {
              throw cause;
            },
          }),
        () => {
          throw new Error("command failed");
        },
      ),
    (error) =>
      error instanceof ValidationRecoveryRequiredError &&
      error.cause === cause &&
      error.recoveryPaths.has("/saved-state") &&
      error.message.includes("command failed"),
  );
  const wrapped = new Error("outer", { cause: new ValidationRecoveryRequiredError("lost", null) });
  assert.ok(validationRecoveryRequired(wrapped));
});
