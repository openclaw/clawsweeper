import assert from "node:assert/strict";
import test from "node:test";

import { StateWriterTelemetryRecorder } from "../../dist/repair/state-writer-telemetry-recorder.js";

test("state writer recorder measures wait, hold, and verified materialization", () => {
  let now = 1_000;
  const phases: string[] = [];
  const recorder = new StateWriterTelemetryRecorder({
    runId: "42",
    runAttempt: 1,
    now: () => now,
    observer: {
      progress(progress) {
        phases.push(progress.phase);
      },
    },
  });

  recorder.enteredWaiting();
  now = 1_500;
  recorder.recordAcquireAttempt();
  recorder.recordAcquireAttempt();
  recorder.acquiredLease();
  now = 2_000;
  recorder.recordGitProcess();
  recorder.recordMaterializedCommit(1);
  recorder.enteredReleasing();
  recorder.releasedLease(true);
  const terminal = recorder.finalize("materialized");

  assert.equal(terminal.operation_id, "single:42:1");
  assert.equal(terminal.wait_ms, 500);
  assert.equal(terminal.acquire_attempts, 2);
  assert.equal(terminal.hold_ms, 500);
  assert.equal(terminal.commit_count, 1);
  assert.equal(terminal.materialized_items, 1);
  assert.equal(terminal.git_processes, 1);
  assert.deepEqual(phases, ["waiting", "holding", "releasing", "finished"]);
});

test("state writer recorder isolates progress observer failures", () => {
  const recorder = new StateWriterTelemetryRecorder({
    runId: "7",
    runAttempt: 2,
    observer: {
      progress() {
        throw new Error("progress sink failed");
      },
    },
  });
  assert.doesNotThrow(() => {
    recorder.enteredWaiting();
    recorder.finalize("contention_timeout");
  });
  assert.equal(recorder.toTerminalObject()?.outcome, "contention_timeout");
  assert.equal(recorder.toTerminalObject()?.acquired, false);
});

test("an acquired batch writer reports a push failure without losing its batch identity", () => {
  const recorder = new StateWriterTelemetryRecorder({
    mode: "batch",
    operationId: "batch:exact-review-batch:123",
    configuredBatchSize: 8,
    actualBatchSize: 8,
    batchWaitMs: 500,
  });

  recorder.enteredWaiting();
  recorder.recordAcquireAttempt();
  recorder.acquiredLease();
  recorder.enteredReleasing();
  recorder.releasedLease(true);
  const terminal = recorder.finalize("contention_timeout");

  assert.equal(terminal.mode, "batch");
  assert.equal(terminal.operation_id, "batch:exact-review-batch:123");
  assert.equal(terminal.outcome, "failed");
  assert.equal(terminal.acquired, true);
});

test("state writer recorder refreshes waiting progress during long acquisition", () => {
  let now = 1_000;
  const phases: Array<{ phase: string; at: number }> = [];
  const recorder = new StateWriterTelemetryRecorder({
    runId: "9",
    runAttempt: 1,
    now: () => now,
    observer: {
      progress(progress) {
        phases.push({ phase: progress.phase, at: now });
      },
    },
  });
  recorder.enteredWaiting();
  now = 20_000;
  recorder.recordAcquireAttempt();
  now = 40_000;
  recorder.recordAcquireAttempt();
  assert.deepEqual(
    phases.map((entry) => entry.phase),
    ["waiting", "waiting"],
  );
  assert.equal(phases[1]?.at, 40_000);
});
