import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createCodexWorkStatePublisher } from "../dist/codex-work-state.js";

const active = { state: "running", phase: "codex", summary: "active" };
const complete = { state: "running", phase: "validating", summary: "complete" };

test("work-state updates serialize and capture their publication-time identity", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const publish = createCodexWorkStatePublisher(
    {
      url: "https://example.invalid/state",
      token: "synthetic",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
      onError: assert.fail,
    },
    async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic");
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) {
        started.resolve();
        await release.promise;
      }
      return new Response(null, { status: 204 });
    },
  );
  const first = publish(active);
  const terminal = { ...complete, codexTurnId: "turn-1" };
  const last = publish(terminal);
  terminal.codexTurnId = "later-turn";
  await started.promise;
  assert.deepEqual(calls, [active]);
  release.resolve();
  await Promise.all([first, last]);
  assert.deepEqual(calls, [active, { ...complete, codexTurnId: "turn-1" }]);
});

test("a failed work-state request does not prevent the next update", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const failure = new Error("synthetic failure");
  const publish = createCodexWorkStatePublisher(
    {
      url: "https://example.invalid/state",
      token: "synthetic",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
      onError: (error) => errors.push(error),
    },
    async () => {
      if (++calls === 1) throw failure;
      return new Response(null, { status: 204 });
    },
  );
  await Promise.all([publish(active), publish(complete)]);
  assert.equal(calls, 2);
  assert.deepEqual(errors, [failure]);
});

test("worker shutdown aborts the active request and prevents queued writes", async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const publish = createCodexWorkStatePublisher(
    {
      url: "https://example.invalid/state",
      token: "synthetic",
      signal: abort.signal,
      deadlineAt: Date.now() + 30_000,
      onError: assert.fail,
    },
    async (_url, init) => {
      calls++;
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  );
  const first = publish(active);
  const last = publish(complete);
  await started.promise;
  abort.abort();
  await Promise.all([first, last, publish(active)]);
  assert.equal(calls, 1);
});

test("queued work-state updates cannot extend the worker deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  let calls = 0;
  const publish = createCodexWorkStatePublisher(
    {
      url: "https://example.invalid/state",
      token: "synthetic",
      signal: new AbortController().signal,
      deadlineAt: 1000,
      onError: (error) => errors.push(error),
    },
    async () => {
      calls++;
      started.resolve();
      await release.promise;
      return new Response(null, { status: 204 });
    },
  );
  const first = publish(active);
  const last = publish(complete);
  await started.promise;
  t.mock.timers.tick(1000);
  release.resolve();
  await Promise.all([first, last]);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /publication deadline expired/);
});

test("coalesced app-server completion cannot overtake a slow active-state write", () => {
  const output = execFileSync(process.execPath, ["scripts/e2e/app-server-work-state.mjs"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const observed = JSON.parse(output);
  assert.deepEqual(observed.phases, ["codex", "codex", "validating"]);
  assert.equal(observed.result_valid, true);
});
