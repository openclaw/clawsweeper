import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeExecutionReport,
  persistBeforePublication,
  reviewAfterFinalBaseSync,
} from "./execution-finalization.js";

test("changed final base sync runs exactly one review against the synchronized tree", () => {
  const events: string[] = [];
  const review = reviewAfterFinalBaseSync({
    syncChanged: true,
    currentReview: { status: "stale", base: "pinned" },
    reviewSynchronizedTree: () => {
      events.push("review");
      return { status: "passed", base: "synchronized" };
    },
    checkpointSynchronizedTree: () => events.push("checkpoint"),
  });

  assert.deepEqual(events, ["review", "checkpoint"]);
  assert.deepEqual(review, { status: "passed", base: "synchronized" });
});

test("unchanged final base sync keeps the existing review", () => {
  const currentReview = { status: "passed", base: "pinned" };
  const review = reviewAfterFinalBaseSync({
    syncChanged: false,
    currentReview,
    reviewSynchronizedTree: () => {
      throw new Error("unexpected synchronized-tree review");
    },
    checkpointSynchronizedTree: () => {
      throw new Error("unexpected synchronized-tree checkpoint");
    },
  });

  assert.equal(review, currentReview);
});

test("publication failure cannot prevent durable report persistence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-finalization-"));
  const reportPath = path.join(directory, "report.json");
  const report = { status: "completed", actions: [] as string[] };

  assert.throws(
    () =>
      persistBeforePublication({
        reportPath,
        serialize: () => `${JSON.stringify(report)}\n`,
        publish: () => {
          report.actions.push("publication-started");
          throw new Error("forced publication failure");
        },
      }),
    /forced publication failure/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), report);
});

test("deferred report publication hands off from expired to fresh credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-handoff-"));
  const reportPath = path.join(directory, "report.json");
  const report = { status: "completed", actions: [] as string[] };
  const publishers: string[] = [];

  finalizeExecutionReport({
    deferPublication: true,
    reportPath,
    serialize: () => `${JSON.stringify(report)}\n`,
    publish: () => {
      publishers.push("expired");
      throw new Error("expired credential should not publish");
    },
  });

  assert.equal(publishers.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), report);

  finalizeExecutionReport({
    deferPublication: false,
    reportPath,
    serialize: () => `${JSON.stringify(report)}\n`,
    publish: () => publishers.push("fresh"),
  });

  assert.deepEqual(publishers, ["fresh"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), report);
});
