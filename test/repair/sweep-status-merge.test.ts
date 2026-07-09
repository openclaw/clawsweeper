import assert from "node:assert/strict";
import test from "node:test";

import { mergeSweepStatusJson } from "../../dist/repair/sweep-status-merge.js";

const statusPath = "results/sweep-status/openclaw-openclaw.json";

test("mergeSweepStatusJson preserves newer top-level status and independent remote health", () => {
  const initialHealth = health("2026-07-09T20:00:00Z", "comment_sync", 1);
  const remoteHealth = health("2026-07-09T20:59:00Z", "close", 2);
  const base = status("2026-07-09T20:00:01Z", "Applying", initialHealth, initialHealth);
  const local = status("2026-07-09T21:02:00Z", "Complete", initialHealth, initialHealth);
  const remote = status("2026-07-09T20:59:01Z", "Applying close", remoteHealth, remoteHealth);

  const merged = merge({ base, local, remote });

  assert.equal(merged.state, "Complete");
  assert.equal(merged.detail, "Complete detail");
  assert.equal(merged.updated_at, "2026-07-09T21:02:00Z");
  assert.deepEqual(merged.apply_health, remoteHealth);
  assert.deepEqual(merged.last_close_apply_health, remoteHealth);
});

test("mergeSweepStatusJson timestamps top-level and health conflicts independently", () => {
  const baseHealth = health("2026-07-09T20:00:00Z", "close", 1);
  const localHealth = health("2026-07-09T21:06:00Z", "close", 2);
  const remoteHealth = health("2026-07-09T21:05:00Z", "close", 3);
  const base = status("2026-07-09T20:00:01Z", "Base", baseHealth, baseHealth);
  const local = status("2026-07-09T21:07:00Z", "Local", localHealth, localHealth);
  const remote = status("2026-07-09T21:08:00Z", "Remote", remoteHealth, remoteHealth);

  const merged = merge({ base, local, remote });

  assert.equal(merged.state, "Remote");
  assert.equal(merged.updated_at, "2026-07-09T21:08:00Z");
  assert.deepEqual(merged.apply_health, localHealth);
  assert.deepEqual(merged.last_close_apply_health, localHealth);
});

test("mergeSweepStatusJson keeps future top-level fields in the atomic status snapshot", () => {
  const baseHealth = health("2026-07-09T20:00:00Z", "close", 1);
  const base = {
    ...status("2026-07-09T20:00:01Z", "Base", baseHealth, baseHealth),
    future_phase: "base",
    future_count: 0,
  };
  const local = {
    ...status("2026-07-09T21:00:00Z", "Local", baseHealth, baseHealth),
    future_phase: "local",
    future_count: 0,
  };
  const remote = {
    ...status("2026-07-09T21:01:00Z", "Remote", baseHealth, baseHealth),
    future_phase: "base",
    future_count: 2,
  };

  const merged = merge({ base, local, remote });

  assert.equal(merged.state, "Remote");
  assert.equal(merged.future_phase, "base");
  assert.equal(merged.future_count, 2);
});

test("mergeSweepStatusJson rejects equal-timestamp same-key conflicts", () => {
  const baseHealth = health("2026-07-09T20:00:00Z", "close", 1);
  const base = status("2026-07-09T20:00:01Z", "Base", baseHealth, baseHealth);
  const local = status("2026-07-09T21:00:00Z", "Local", baseHealth, baseHealth);
  const remote = status("2026-07-09T21:00:00Z", "Remote", baseHealth, baseHealth);

  assert.throws(
    () => merge({ base, local, remote }),
    /ambiguous sweep status merge at equal timestamp.*status snapshot/,
  );

  const localHealth = health("2026-07-09T21:30:00Z", "close", 2);
  const remoteHealth = health("2026-07-09T21:30:00Z", "close", 3);
  assert.throws(
    () =>
      merge({
        base,
        local: status("2026-07-09T21:31:00Z", "Local", localHealth, localHealth),
        remote: status("2026-07-09T21:32:00Z", "Remote", remoteHealth, remoteHealth),
      }),
    /ambiguous sweep status merge at equal timestamp.*apply_health/,
  );
});

test("mergeSweepStatusJson fails closed for malformed, invalid, and deleted status", () => {
  const initialHealth = health("2026-07-09T20:00:00Z", "close", 1);
  const base = status("2026-07-09T20:00:01Z", "Base", initialHealth, initialHealth);
  const local = status("2026-07-09T21:00:00Z", "Local", initialHealth, initialHealth);
  const remote = status("2026-07-09T21:01:00Z", "Remote", initialHealth, initialHealth);

  assert.throws(
    () =>
      mergeSweepStatusJson({
        path: statusPath,
        baseText: JSON.stringify(base),
        localText: JSON.stringify(local),
        remoteText: "{broken",
      }),
    /malformed sweep status JSON/,
  );
  assert.throws(
    () =>
      merge({
        base,
        local: { ...local, updated_at: "today" },
        remote,
      }),
    /invalid timestamp/,
  );
  assert.throws(
    () =>
      mergeSweepStatusJson({
        path: statusPath,
        baseText: JSON.stringify(base),
        localText: JSON.stringify(local),
        remoteText: null,
      }),
    /deleted sweep status/,
  );
});

test("mergeSweepStatusJson accepts an independently added valid status", () => {
  const added = status("2026-07-09T21:00:00Z", "Added", null, null);
  const merged = JSON.parse(
    mergeSweepStatusJson({
      path: statusPath,
      baseText: null,
      localText: null,
      remoteText: JSON.stringify(added),
    }),
  );

  assert.deepEqual(merged, added);
});

function merge({ base, local, remote }) {
  return JSON.parse(
    mergeSweepStatusJson({
      path: statusPath,
      baseText: JSON.stringify(base),
      localText: JSON.stringify(local),
      remoteText: JSON.stringify(remote),
    }),
  );
}

function status(updatedAt, state, applyHealth, lastCloseApplyHealth) {
  return {
    schema_version: 1,
    slug: "openclaw-openclaw",
    display_name: "OpenClaw",
    target_repo: "openclaw/openclaw",
    state,
    detail: `${state} detail`,
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
    apply_health: applyHealth,
    last_close_apply_health: lastCloseApplyHealth,
    updated_at: updatedAt,
  };
}

function health(generatedAt, mode, processed) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    target_repo: "openclaw/openclaw",
    mode,
    processed,
  };
}
