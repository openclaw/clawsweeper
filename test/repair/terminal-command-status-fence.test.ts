import assert from "node:assert/strict";
import test from "node:test";
import { terminalCommandStatusFence } from "../../dist/repair/terminal-command-status-fence.js";
const env = {
  QUEUE_URL: "http://127.0.0.1:9999",
  TERMINAL_FINALIZATION_ITEM_KEY: "terminal-finalization:synthetic/repo#1:1",
  TERMINAL_FINALIZATION_LEASE_ID: "synthetic-lease",
  TERMINAL_FINALIZATION_LEASE_REVISION: "1",
  TERMINAL_FINALIZATION_CLAIM_GENERATION: "2",
  GITHUB_RUN_ID: "3",
  GITHUB_RUN_ATTEMPT: "1",
  ATTEMPT_ID: "ack:2",
};
const address = { marker: "synthetic-marker", statusCommentId: null };
test("terminal status fence binds exact lease, attempt and address for verify and release", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      "http://127.0.0.1:9999/internal/exact-review/terminal-finalization/attempt",
    );
    assert.equal(init.method, "POST");
    assert.ok(init.signal);
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return Response.json(
      body.release_status_write
        ? { ok: true, released: true }
        : { ok: true, allowed: true, write_fenced: true },
    );
  };
  try {
    assert.equal(await terminalCommandStatusFence(address, false, env), true);
    assert.equal(await terminalCommandStatusFence(address, true, env), true);
    assert.deepEqual(bodies[0], {
      item_key: env.TERMINAL_FINALIZATION_ITEM_KEY,
      lease_id: "synthetic-lease",
      lease_revision: 1,
      claim_generation: 2,
      run_id: "3",
      run_attempt: 1,
      attempt_id: "ack:2",
      verify_only: true,
      status_marker: "synthetic-marker",
    });
    assert.equal(bodies[1].release_status_write, true);
  } finally {
    globalThis.fetch = original;
  }
});
test("terminal status fence recognizes only typed stale ownership conflicts", async () => {
  const original = globalThis.fetch;
  try {
    for (const error of [
      "lease_not_active",
      "parked_command_superseded",
      "parked_command_target_changed",
      "acknowledgement_not_active",
    ]) {
      globalThis.fetch = async () => Response.json({ error }, { status: 409 });
      assert.equal(await terminalCommandStatusFence(address, false, env), false);
    }
    for (const [status, value] of [
      [409, { error: "unknown_conflict" }],
      [503, { error: "unavailable" }],
      [200, { ok: true, allowed: true }],
      [200, { ok: true, allowed: false, write_fenced: true }],
    ]) {
      globalThis.fetch = async () => Response.json(value, { status });
      await assert.rejects(
        terminalCommandStatusFence(address, false, env),
        /terminal status fence failed/,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("terminal status fence rejects incomplete identity and insecure nonloopback origins before requests", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected request");
  };
  try {
    await assert.rejects(
      terminalCommandStatusFence(address, false, { ...env, ATTEMPT_ID: "ack:0" }),
      /missing terminal status fence tuple/,
    );
    await assert.rejects(
      terminalCommandStatusFence(address, false, { ...env, QUEUE_URL: "http://example.com" }),
      /invalid terminal status fence origin/,
    );
    await assert.rejects(
      terminalCommandStatusFence(address, false, {
        ...env,
        QUEUE_URL: "https://user:pass@example.com",
      }),
      /invalid terminal status fence origin/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
