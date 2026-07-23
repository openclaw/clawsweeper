import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  repairCommentRouterGroup,
  replayWorkflowTrace,
  WorkflowScheduler,
} from "./e2e/automerge/workflow-scheduler.mjs";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "e2e/automerge/fixtures",
);

test("router concurrency groups isolate exact workflow handoffs only", () => {
  assert.equal(
    repairCommentRouterGroup({
      repository: "openclaw/openclaw",
      eventName: "workflow_dispatch",
      itemNumbers: "104054",
    }),
    "repair-comment-router-openclaw/openclaw-items-104054",
  );
  assert.equal(
    repairCommentRouterGroup({
      repository: "openclaw/openclaw",
      eventName: "repository_dispatch",
      itemNumbers: "104054",
    }),
    "repair-comment-router-openclaw/openclaw",
  );
  assert.equal(
    repairCommentRouterGroup({
      repository: "openclaw/openclaw",
      eventName: "workflow_dispatch",
    }),
    "repair-comment-router-openclaw/openclaw",
  );
});

test("workflow scheduler keeps one running and replaces one pending run per group", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.dispatch({ id: "running", group: "repo" });
  scheduler.dispatch({ id: "old-pending", group: "repo" });
  scheduler.dispatch({ id: "new-pending", group: "repo" });

  assert.deepEqual(
    scheduler.records().map(({ id, status, replacedBy }) => ({ id, status, replacedBy })),
    [
      { id: "running", status: "running", replacedBy: undefined },
      { id: "old-pending", status: "replaced", replacedBy: "new-pending" },
      { id: "new-pending", status: "pending", replacedBy: undefined },
    ],
  );
  scheduler.complete("running");
  assert.equal(scheduler.records().find((run) => run.id === "new-pending")?.status, "running");
});

test("workflow scheduler isolates concurrency groups and records cancellation", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.dispatch({ id: "item-1", group: "items-1" });
  scheduler.dispatch({ id: "item-2", group: "items-2" });
  scheduler.cancel("item-1", "test interruption");
  scheduler.complete("item-2");

  assert.deepEqual(
    scheduler.records().map(({ id, status }) => ({ id, status })),
    [
      { id: "item-1", status: "cancelled" },
      { id: "item-2", status: "executed" },
    ],
  );
});

test("production trace reproduces the old loss and preserves both item-scoped verdicts", () => {
  const trace = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "deferred-verdict-pending-replacement.json"), "utf8"),
  );
  const oldRecords = replayWorkflowTrace(
    trace,
    (run: { repository: string }) => `repair-comment-router-${run.repository}`,
  );
  assert.equal(oldRecords.find((run) => run.id === "verdict-104054")?.status, "replaced");

  const fixedRecords = replayWorkflowTrace(
    trace,
    (run: { kind: string; repository: string; item?: number }) =>
      repairCommentRouterGroup({
        repository: run.repository,
        eventName: run.kind === "exact-verdict" ? "workflow_dispatch" : "schedule",
        itemNumbers: run.item ? String(run.item) : "",
      }),
    { completeRemaining: true },
  );
  assert.equal(fixedRecords.find((run) => run.id === "verdict-104054")?.status, "executed");
  assert.equal(fixedRecords.find((run) => run.id === "verdict-108974")?.status, "executed");
});
