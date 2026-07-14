import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importWorkflowActionEvents } from "./action-event-importer.js";

test("workflow action event importer binds shards to the expected producer job", () => {
  let captured:
    | {
        sourceRoot: string;
        stateRoot: string;
        expectedProducer: unknown;
      }
    | undefined;
  const result = importWorkflowActionEvents({
    sourceRoot: "/tmp/source",
    stateRoot: "/tmp/state",
    expectedProducerJob: "review",
    dependencies: {
      workflowActionProducer: () => ({
        repository: "openclaw/clawsweeper",
        sha: "a".repeat(40),
        workflow: "sweep.yml",
        job: "publisher",
        runId: "123",
        runAttempt: 2,
        component: "action_event_publisher.test.default",
      }),
      importActionEventShards: (sourceRoot, stateRoot, options) => {
        captured = {
          sourceRoot,
          stateRoot,
          expectedProducer: options?.expectedProducer,
        };
        return {
          created: 1,
          unchanged: 0,
          eventPaths: ["ledger/v1/events/example.jsonl"],
          reservationPaths: [],
          completionPaths: [],
          paths: ["ledger/v1/events/example.jsonl"],
        };
      },
    },
  });

  assert.equal(result.created, 1);
  assert.deepEqual(captured, {
    sourceRoot: "/tmp/source",
    stateRoot: "/tmp/state",
    expectedProducer: {
      repository: "openclaw/clawsweeper",
      sha: "a".repeat(40),
      workflow: "sweep.yml",
      job: "review",
      runId: "123",
      runAttempt: 2,
    },
  });
});

test("repair-native action event importer CLI accepts the package-manager separator", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./publish-action-events.js", import.meta.url)),
      "--",
      "--source-root",
      "/tmp/source",
      "--state-root",
      "/tmp/state",
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--expected-producer-job is required/);
  assert.doesNotMatch(result.stderr, /Unknown argument/);
});
