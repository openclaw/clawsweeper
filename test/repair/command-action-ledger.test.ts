import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  flushCommandActionEvents,
  recordCommandClaimed,
  recordCommandClassified,
  recordCommandOutcome,
  recordCommandReceived,
} from "../../dist/repair/command-action-ledger.js";

test("command receipts preserve operation identity across explicit retry attempts", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "command-action-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "initial",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair comment router",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-comment-router.yml@refs/heads/main",
    GITHUB_JOB: "route-comments",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTION: "route",
    GITHUB_RUN_STARTED_AT: "2026-07-12T16:00:00Z",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
  });

  try {
    const initial = syntheticCommand("b".repeat(40));
    recordCommandReceived(initial);
    initial.status = "ready";
    recordCommandClassified(initial);
    initial.status = "claimed";
    recordCommandClaimed(initial);
    initial.status = "executed";
    initial.actions = [
      {
        action: "dispatch_clawsweeper",
        status: "executed",
        dispatch_key: "router-stable",
      },
    ];
    recordCommandOutcome(initial);
    await flushCommandActionEvents();

    process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = "retry";
    const retry = syntheticCommand("c".repeat(40));
    recordCommandReceived(retry);
    retry.status = "ready";
    recordCommandClassified(retry);
    retry.status = "executed";
    retry.actions = [
      {
        action: "dispatch_clawsweeper",
        status: "executed",
        dispatch_key: "router-stable",
      },
    ];
    recordCommandOutcome(retry);
    await flushCommandActionEvents();

    const events = readEvents(outputRoot);
    const attempts = Map.groupBy(events, (event) => String(event.attempt_id));
    assert.equal(attempts.size, 2);
    assert.equal(new Set(events.map((event) => event.operation_id)).size, 1);

    for (const attemptEvents of attempts.values()) {
      const ordered = [...attemptEvents].sort((left, right) => left.phase_seq - right.phase_seq);
      assert.deepEqual(
        ordered.map((event) => event.phase_seq),
        ordered.map((_, index) => index + 1),
      );
      assert.equal(ordered[0]?.parent_event_id, null);
      for (let index = 1; index < ordered.length; index += 1) {
        assert.equal(ordered[index]?.parent_event_id, ordered[index - 1]?.event_id);
      }
    }

    const dispatches = events.filter((event) => event.event_type === "command.dispatched");
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[0]?.idempotency_key_sha256, dispatches[1]?.idempotency_key_sha256);
    assert.equal(new Set(dispatches.map((event) => event.attempt_id)).size, 2);
    assert.deepEqual(
      events
        .filter((event) => event.producer.component.endsWith(".initial"))
        .map((event) => event.event_type),
      [
        "command.received",
        "command.classified",
        "command.claimed",
        "command.dispatched",
        "command.completed",
      ],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function syntheticCommand(headSha: string) {
  return {
    repo: "openclaw/openclaw",
    issue_number: 42,
    idempotency_key: "repair-loop-label-sweep:openclaw/openclaw:automerge:42",
    comment_body_sha256: null,
    status: "pending",
    target: {
      kind: "pull_request",
      head_sha: headSha,
    },
    actions: [] as Record<string, unknown>[],
  };
}

function readEvents(root: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const file of walk(root)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
      if (line) events.push(JSON.parse(line));
    }
  }
  return events.sort((left, right) => {
    const component = String(left.producer.component).localeCompare(
      String(right.producer.component),
    );
    return component || left.phase_seq - right.phase_seq;
  });
}

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
