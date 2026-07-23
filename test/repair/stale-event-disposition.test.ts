import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  staleEventDisposition,
  staleEventDispositionOutputLines,
} from "../../dist/repair/stale-event-disposition.js";

test("stale event dispositions are terminal, never retry-the-same-artifact", () => {
  assert.deepEqual(staleEventDisposition("remote-newer"), {
    detail: "current state has a newer tuple",
    requeueLatest: true,
    terminalClosed: false,
    terminalMissing: false,
  });
  assert.deepEqual(staleEventDisposition("remote-closed"), {
    detail: "current state is already closed",
    requeueLatest: false,
    terminalClosed: true,
    terminalMissing: false,
  });
  assert.deepEqual(staleEventDisposition("missing"), {
    detail: "the event produced no record tuple",
    requeueLatest: false,
    terminalClosed: false,
    terminalMissing: true,
  });
});

test("stale event disposition output lines match the workflow contract", () => {
  const lines = staleEventDispositionOutputLines(staleEventDisposition("remote-newer"));
  assert.ok(lines.includes("requeue_latest=true"));
  assert.ok(lines.includes("terminal_closed=false"));
  assert.ok(lines.includes("terminal_missing=false"));
  assert.ok(lines.includes("remote_tuple_verified=false"));
  const closed = staleEventDispositionOutputLines(staleEventDisposition("remote-closed"));
  assert.ok(closed.includes("terminal_closed=true"));
  assert.ok(closed.includes("requeue_latest=false"));
});

test("publish-event-result exits terminally on a stale preflight instead of throwing", () => {
  // The workflow classifier treats an unset disposition as failure -> infinite
  // requeue of the same stale artifact (2026-07-16 poison cohort). Guard the
  // contract at the source level.
  const source = readFileSync("src/repair/publish-event-result.ts", "utf8");
  const preflightBlock = source.slice(
    source.indexOf('preflightResult === "remote-closed"'),
    source.indexOf("const actions = readApplyActions"),
  );
  assert.ok(preflightBlock.includes("writeStaleEventDispositionOutputs"));
  assert.ok(!preflightBlock.includes("throw new Error"));
});
