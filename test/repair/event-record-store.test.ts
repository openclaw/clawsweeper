import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyEventSnapshot,
  applyEventSnapshotIfCurrent,
  captureEventBaseSnapshot,
  captureEventSnapshot,
  eventRecordDirectories,
  eventRecordPaths,
  eventSnapshotMatchesCurrent,
  resetEventSnapshot,
} from "../../dist/repair/event-record-store.js";
import { refreshSourceAfterStatePublish } from "../../dist/repair/git-publish.js";

test("event record directories stay inside the isolated worker root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-record-dirs-"));
  const paths = eventRecordPaths({
    targetRepo: "openclaw/clawsweeper",
    itemNumber: "828",
    snapshotDir: path.join(root, "snapshot"),
  });

  assert.deepEqual(eventRecordDirectories(paths, root), {
    items: path.join(root, "records", "openclaw-clawsweeper", "items"),
    closed: path.join(root, "records", "openclaw-clawsweeper", "closed"),
    plans: path.join(root, "records", "openclaw-clawsweeper", "plans"),
    decisionPackets: path.join(root, "records", "openclaw-clawsweeper", "decision-packets"),
  });
});

test("event snapshot match follows the final tuple winner, not only its action", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "91668",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base open",
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
      extraFrontMatter: ["action_taken: proposed_close"],
    });
    captureEventBaseSnapshot(store);
    writeEventTuple(paths, {
      marker: "candidate guarded open",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
      extraFrontMatter: [
        "action_taken: skipped_same_author_pair",
        "apply_checked_at: 2026-07-09T23:11:00.000Z",
      ],
    });
    captureEventSnapshot(store);
    assert.equal(eventSnapshotMatchesCurrent(paths), true);

    writeEventTuple(paths, {
      marker: "newer remote guarded open",
      reviewedAt: "2026-07-09T23:20:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
      extraFrontMatter: [
        "action_taken: skipped_same_author_pair",
        "apply_checked_at: 2026-07-09T23:21:00.000Z",
      ],
    });
    assert.equal(eventSnapshotMatchesCurrent(paths), false);
  });
});

test("event snapshot match rejects live close-guard label drift after kept-open sync", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "91271",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "kept-open sync",
      reviewedAt: "2026-07-10T13:29:00.000Z",
      itemUpdatedAt: "2026-07-10T13:28:00Z",
      extraFrontMatter: ["action_taken: kept_open", 'labels: ["clawsweeper:human-review"]'],
    });
    captureEventSnapshot(store);
    assert.equal(eventSnapshotMatchesCurrent(paths), true);

    writeEventTuple(paths, {
      marker: "kept-open sync",
      reviewedAt: "2026-07-10T13:29:00.000Z",
      itemUpdatedAt: "2026-07-10T13:28:00Z",
      extraFrontMatter: ["action_taken: kept_open", "labels: []"],
    });
    assert.equal(eventSnapshotMatchesCurrent(paths), false);
  });
});

test("authoritative state refresh exposes a remote winner hidden by a stale local checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "91272",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "candidate kept-open sync",
      reviewedAt: "2026-07-10T13:29:00.000Z",
      itemUpdatedAt: "2026-07-10T13:28:00Z",
      extraFrontMatter: ["action_taken: kept_open"],
    });
    captureEventSnapshot(store);
    const stateRoot = path.join(root, "state");
    copyTupleToRoot(paths, stateRoot);
    const statePaths = {
      ...paths,
      itemRecord: path.join(stateRoot, paths.itemRecord),
      closedRecord: path.join(stateRoot, paths.closedRecord),
      planRecord: path.join(stateRoot, paths.planRecord),
      decisionPacket: path.join(stateRoot, paths.decisionPacket),
    };
    writeEventTuple(statePaths, {
      marker: "competing newer winner",
      reviewedAt: "2026-07-10T13:30:00.000Z",
      itemUpdatedAt: "2026-07-10T13:28:00Z",
      extraFrontMatter: ["action_taken: kept_open"],
    });

    assert.equal(eventSnapshotMatchesCurrent(paths), true, "local checkout is still stale");
    const previousStateDir = process.env.CLAWSWEEPER_STATE_DIR;
    process.env.CLAWSWEEPER_STATE_DIR = stateRoot;
    try {
      refreshSourceAfterStatePublish(
        [paths.itemRecord, paths.closedRecord, paths.planRecord, paths.decisionPacket],
        null,
      );
    } finally {
      if (previousStateDir === undefined) delete process.env.CLAWSWEEPER_STATE_DIR;
      else process.env.CLAWSWEEPER_STATE_DIR = previousStateDir;
    }
    assert.equal(eventSnapshotMatchesCurrent(paths), false);
  });
});

test("event record snapshots prefer closed records and remove open records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "42",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base open",
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    writeEventTuple(paths, {
      marker: "candidate closed",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
      location: "closed",
      packet: false,
      plan: false,
      extraFrontMatter: ["reconciled_at: 2026-07-09T23:20:21.470Z"],
    });

    const captured = captureEventSnapshot(store);
    fs.rmSync(paths.itemRecord, { force: true });
    fs.rmSync(paths.closedRecord, { force: true });
    fs.rmSync(paths.planRecord, { force: true });
    fs.rmSync(paths.decisionPacket, { force: true });

    assert.equal(applyEventSnapshot(captured, { remoteRoot }), "closed");
    assert.equal(fs.existsSync(paths.itemRecord), false);
    assert.match(fs.readFileSync(paths.closedRecord, "utf8"), /candidate closed/);
    assert.equal(fs.existsSync(paths.planRecord), false);
    assert.equal(fs.existsSync(paths.decisionPacket), false);
  });
});

test("event record snapshots skip stale open snapshots when remote is already closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "99",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base open",
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
    captureEventBaseSnapshot(store);
    writeEventTuple(paths, {
      marker: "stale candidate open",
      reviewedAt: "2026-07-09T23:13:13.035Z",
      itemUpdatedAt: "2026-07-09T23:06:04Z",
    });
    captureEventSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    writeEventTuple(
      {
        ...paths,
        itemRecord: path.join(remoteRoot, paths.itemRecord),
        closedRecord: path.join(remoteRoot, paths.closedRecord),
        planRecord: path.join(remoteRoot, paths.planRecord),
        decisionPacket: path.join(remoteRoot, paths.decisionPacket),
      },
      {
        marker: "remote closed",
        reviewedAt: "2026-07-09T23:18:00.000Z",
        itemUpdatedAt: "2026-07-09T23:12:00Z",
        location: "closed",
        packet: false,
        plan: false,
        extraFrontMatter: ["reconciled_at: 2026-07-09T23:20:20.000Z"],
      },
    );

    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "remote-closed");
    assert.match(
      fs.readFileSync(path.join(remoteRoot, paths.closedRecord), "utf8"),
      /remote closed/,
    );
  });
});

test("closed-state transition time outranks stale open review time", () => {
  for (const transitionField of ["reconciled_at", "applied_at"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
    const store = {
      targetRepo: "openclaw/openclaw",
      itemNumber: transitionField === "reconciled_at" ? "71" : "72",
      snapshotDir: path.join(root, "snapshot"),
    };
    withCwd(root, () => {
      const paths = eventRecordPaths(store);
      resetEventSnapshot(store);
      writeEventTuple(paths, {
        marker: "base open review T10",
        reviewedAt: "2026-07-09T23:10:00.000Z",
        itemUpdatedAt: "2026-07-09T23:00:00Z",
      });
      captureEventBaseSnapshot(store);
      writeEventTuple(paths, {
        marker: "stale open review T20",
        reviewedAt: "2026-07-09T23:20:00.000Z",
        itemUpdatedAt: "2026-07-09T23:00:00Z",
      });
      captureEventSnapshot(store);
      const remoteRoot = path.join(root, "remote");
      const remotePaths = {
        ...paths,
        itemRecord: path.join(remoteRoot, paths.itemRecord),
        closedRecord: path.join(remoteRoot, paths.closedRecord),
        planRecord: path.join(remoteRoot, paths.planRecord),
        decisionPacket: path.join(remoteRoot, paths.decisionPacket),
      };
      writeEventTuple(remotePaths, {
        marker: `closed by ${transitionField} T30`,
        reviewedAt: "2026-07-09T23:10:00.000Z",
        itemUpdatedAt: "2026-07-09T23:00:00Z",
        location: "closed",
        packet: false,
        plan: false,
        extraFrontMatter: [`${transitionField}: 2026-07-09T23:30:00.000Z`],
      });
      assert.equal(applyEventSnapshot(paths, { remoteRoot }), "remote-closed");

      if (transitionField === "reconciled_at") {
        resetEventSnapshot(store);
        copyTupleFromRoot(paths, remoteRoot);
        captureEventBaseSnapshot(store);
        writeEventTuple(paths, {
          marker: "hydrated stale open review T20",
          reviewedAt: "2026-07-09T23:20:00.000Z",
          itemUpdatedAt: "2026-07-09T23:00:00Z",
        });
        captureEventSnapshot(store);
        assert.equal(applyEventSnapshot(paths, { remoteRoot }), "remote-closed");
      }
    });
  }
});

test("latest closed-state transition wins when applied and reconciled timestamps coexist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "73",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base open transition T5",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:00:00Z",
      extraFrontMatter: ["reconciled_at: 2026-07-09T23:05:00.000Z"],
    });
    captureEventBaseSnapshot(store);
    writeEventTuple(paths, {
      marker: "stale open transition T40",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:00:00Z",
      extraFrontMatter: ["reconciled_at: 2026-07-09T23:40:00.000Z"],
    });
    captureEventSnapshot(store);

    const remoteRoot = path.join(root, "remote");
    const remotePaths = {
      ...paths,
      itemRecord: path.join(remoteRoot, paths.itemRecord),
      closedRecord: path.join(remoteRoot, paths.closedRecord),
      planRecord: path.join(remoteRoot, paths.planRecord),
      decisionPacket: path.join(remoteRoot, paths.decisionPacket),
    };
    writeEventTuple(remotePaths, {
      marker: "closed applied T30 reconciled T50",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:00:00Z",
      location: "closed",
      packet: false,
      plan: false,
      extraFrontMatter: [
        "applied_at: 2026-07-09T23:30:00.000Z",
        "reconciled_at: 2026-07-09T23:50:00.000Z",
      ],
    });

    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "remote-closed");
    assert.match(
      fs.readFileSync(path.join(remoteRoot, paths.closedRecord), "utf8"),
      /closed applied T30 reconciled T50/,
    );
  });
});

test("event snapshots publish an atomic record, plan, and matching decision packet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "100960",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base",
      reviewedAt: "2026-07-09T23:13:13.035Z",
      itemUpdatedAt: "2026-07-09T23:06:04Z",
    });
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    const exact = writeEventTuple(paths, {
      marker: "exact event 5731116d2efa",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
      extraFrontMatter: [
        "apply_checked_at: 2026-07-09T23:20:21.470Z",
        "review_comment_synced_at: 2026-07-09T23:20:21.464Z",
        "last_full_review_at: 2026-07-09T23:19:10.353Z",
      ],
    });
    captureEventSnapshot(store);

    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "open");
    assert.equal(fs.readFileSync(paths.itemRecord, "utf8"), exact.primary);
    assert.equal(fs.readFileSync(paths.planRecord, "utf8"), exact.plan);
    assert.equal(fs.readFileSync(paths.decisionPacket, "utf8"), exact.packet);
    assert.match(
      exact.primary,
      new RegExp(
        `^decision_packet_sha256: ${createHash("sha256").update(exact.packet).digest("hex")}$`,
        "m",
      ),
    );
  });
});

test("newer subject and review state outranks later operational stamps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "100960",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base",
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
    captureEventBaseSnapshot(store);
    const candidate = writeEventTuple(paths, {
      marker: "newer exact review",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
    });
    captureEventSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    const remotePaths = {
      ...paths,
      itemRecord: path.join(remoteRoot, paths.itemRecord),
      closedRecord: path.join(remoteRoot, paths.closedRecord),
      planRecord: path.join(remoteRoot, paths.planRecord),
      decisionPacket: path.join(remoteRoot, paths.decisionPacket),
    };
    writeEventTuple(remotePaths, {
      marker: "older broad review with later apply stamp",
      reviewedAt: "2026-07-09T23:13:13.035Z",
      itemUpdatedAt: "2026-07-09T23:06:04Z",
      extraFrontMatter: ["apply_checked_at: 2026-07-09T23:21:00.000Z"],
    });

    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "open");
    assert.equal(fs.readFileSync(paths.itemRecord, "utf8"), candidate.primary);
  });
});

test("newer reopened exact tuple outranks an older broad close and restores its sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "100960",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base open",
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
    captureEventBaseSnapshot(store);
    const reopened = writeEventTuple(paths, {
      marker: "newer exact reopen",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
    });
    captureEventSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    const remotePaths = {
      ...paths,
      itemRecord: path.join(remoteRoot, paths.itemRecord),
      closedRecord: path.join(remoteRoot, paths.closedRecord),
      planRecord: path.join(remoteRoot, paths.planRecord),
      decisionPacket: path.join(remoteRoot, paths.decisionPacket),
    };
    writeEventTuple(remotePaths, {
      marker: "older broad close",
      reviewedAt: "2026-07-09T23:13:13.035Z",
      itemUpdatedAt: "2026-07-09T23:06:04Z",
      location: "closed",
      packet: false,
      plan: false,
      extraFrontMatter: ["reconciled_at: 2026-07-09T23:14:00.000Z"],
    });

    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "open");
    assert.equal(fs.readFileSync(paths.itemRecord, "utf8"), reopened.primary);
    assert.equal(fs.existsSync(paths.closedRecord), false);
    assert.equal(fs.readFileSync(paths.planRecord, "utf8"), reopened.plan);
    assert.equal(fs.readFileSync(paths.decisionPacket, "utf8"), reopened.packet);
  });
});

test("stale event preflight invokes no external apply callback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "100960",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "newer captured base",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
    });
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    writeEventTuple(paths, {
      marker: "stale exact artifact",
      reviewedAt: "2026-07-09T23:13:13.035Z",
      itemUpdatedAt: "2026-07-09T23:06:04Z",
    });
    captureEventSnapshot(store);

    let applyInvocations = 0;
    assert.equal(
      applyEventSnapshotIfCurrent(paths, { remoteRoot }, () => {
        applyInvocations += 1;
      }),
      "remote-newer",
    );
    assert.equal(applyInvocations, 0);
  });
});

test("event tuple cleanup accepts only-plan deletion and recaptures post-apply sidecar removal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "77",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base with obsolete plan",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
    });
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    fs.rmSync(paths.planRecord);
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "open");
    assert.equal(fs.existsSync(paths.planRecord), false);

    writeEventTuple(paths, {
      marker: "fresh apply candidate",
      reviewedAt: "2026-07-09T23:20:10.353Z",
      itemUpdatedAt: "2026-07-09T23:11:43Z",
    });
    captureEventSnapshot(store);
    assert.equal(
      applyEventSnapshotIfCurrent(paths, { remoteRoot }, () => {
        writeEventTuple(paths, {
          marker: "post-apply close",
          reviewedAt: "2026-07-09T23:20:10.353Z",
          itemUpdatedAt: "2026-07-09T23:11:43Z",
          location: "closed",
          packet: false,
          plan: false,
          extraFrontMatter: ["reconciled_at: 2026-07-09T23:21:00.000Z"],
        });
      }),
      "open",
    );
    captureEventSnapshot(store);
    fs.rmSync(paths.itemRecord, { force: true });
    fs.rmSync(paths.closedRecord, { force: true });
    fs.rmSync(paths.planRecord, { force: true });
    fs.rmSync(paths.decisionPacket, { force: true });
    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "closed");
    assert.equal(fs.existsSync(paths.planRecord), false);
    assert.equal(fs.existsSync(paths.decisionPacket), false);
  });
});

test("duplicate-primary base accepts only its packet-bound closed repair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "74",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    const closed = writeEventTuple(paths, {
      marker: "authoritative closed projection",
      reviewedAt: "2026-07-09T23:19:10.353Z",
      itemUpdatedAt: "2026-07-09T23:10:43Z",
      location: "closed",
    });
    write(
      paths.itemRecord,
      closed.primary.replace("# authoritative closed projection", "# duplicate stale open copy"),
    );
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);

    writeEventTuple(paths, {
      marker: "stale open repair",
      reviewedAt: "2026-07-09T23:13:13.035Z",
      itemUpdatedAt: "2026-07-09T23:06:04Z",
    });
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "remote-closed");

    resetEventSnapshot(store);
    copyTupleFromRoot(paths, remoteRoot);
    captureEventBaseSnapshot(store);
    fs.rmSync(paths.itemRecord);
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "closed");
    assert.equal(fs.existsSync(paths.itemRecord), false);
    assert.equal(fs.readFileSync(paths.closedRecord, "utf8"), closed.primary);
  });
});

test("legacy-invalid packet sidecars cannot make an older valid primary win", () => {
  const corruptions = [
    {
      name: "missing packet",
      corrupt(paths) {
        fs.rmSync(paths.decisionPacket);
      },
    },
    {
      name: "retained packet after none",
      corrupt(paths) {
        write(
          paths.itemRecord,
          fs
            .readFileSync(paths.itemRecord, "utf8")
            .replace(/^decision_packet_sha256: .*$/m, "decision_packet_sha256: none")
            .replace(/^decision_packet_path: .*$/m, "decision_packet_path: none"),
        );
      },
    },
    {
      name: "digest mismatch",
      corrupt(paths) {
        fs.appendFileSync(paths.decisionPacket, " ");
      },
    },
    {
      name: "packet without pointer",
      corrupt(paths) {
        write(
          paths.itemRecord,
          fs
            .readFileSync(paths.itemRecord, "utf8")
            .replace(/^decision_packet_(?:sha256|path): .*\n/gm, ""),
        );
      },
    },
  ];

  for (const [index, corruption] of corruptions.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
    const store = {
      targetRepo: "openclaw/openclaw",
      itemNumber: String(800 + index),
      snapshotDir: path.join(root, "snapshot"),
    };
    withCwd(root, () => {
      const paths = eventRecordPaths(store);
      resetEventSnapshot(store);
      writeEventTuple(paths, {
        marker: `${corruption.name} base T20`,
        reviewedAt: "2026-07-09T23:20:00.000Z",
        itemUpdatedAt: "2026-07-09T23:10:00Z",
      });
      corruption.corrupt(paths);
      captureEventBaseSnapshot(store);
      const remoteRoot = path.join(root, "remote");
      copyTupleToRoot(paths, remoteRoot);
      writeEventTuple(paths, {
        marker: "older valid candidate T10",
        reviewedAt: "2026-07-09T23:10:00.000Z",
        itemUpdatedAt: "2026-07-09T23:00:00Z",
      });
      if (index === 0) {
        const packet = JSON.parse(fs.readFileSync(paths.decisionPacket, "utf8"));
        packet.generatedAt = "2026-07-09T23:30:00.000Z";
        packet.updatedAt = "2026-07-09T23:30:00.000Z";
        packet.source.reviewedAt = "2026-07-09T23:30:00.000Z";
        const packetText = `${JSON.stringify(packet, null, 2)}\n`;
        write(paths.decisionPacket, packetText);
        write(
          paths.itemRecord,
          fs
            .readFileSync(paths.itemRecord, "utf8")
            .replace(
              /^decision_packet_sha256: .*$/m,
              `decision_packet_sha256: ${createHash("sha256").update(packetText).digest("hex")}`,
            ),
        );
      }
      captureEventSnapshot(store);
      assert.equal(applyEventSnapshot(paths, { remoteRoot }), "remote-newer", corruption.name);
    });
  }
});

test("equal-vector legacy packet repair requires an unchanged primary and plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "439",
    snapshotDir: path.join(root, "snapshot"),
  };
  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    const valid = writeEventTuple(paths, {
      marker: "legacy missing packet base",
      reviewedAt: "2026-07-09T23:20:00.000Z",
      itemUpdatedAt: "2026-07-09T23:10:00Z",
    });
    fs.rmSync(paths.decisionPacket);
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    write(paths.decisionPacket, valid.packet);
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot }), "open");
    assert.equal(fs.readFileSync(paths.decisionPacket, "utf8"), valid.packet);

    resetEventSnapshot(store);
    const corrected = writeEventTuple(paths, {
      marker: "legacy digest mismatch base",
      reviewedAt: "2026-07-09T23:20:00.000Z",
      itemUpdatedAt: "2026-07-09T23:10:00Z",
    });
    write(
      paths.itemRecord,
      corrected.primary.replace(
        /^decision_packet_sha256: .*$/m,
        `decision_packet_sha256: ${"0".repeat(64)}`,
      ),
    );
    captureEventBaseSnapshot(store);
    const mismatchRemoteRoot = path.join(root, "mismatch-remote");
    copyTupleToRoot(paths, mismatchRemoteRoot);
    write(paths.itemRecord, corrected.primary);
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot: mismatchRemoteRoot }), "open");
    assert.equal(fs.readFileSync(paths.itemRecord, "utf8"), corrected.primary);

    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "closed legacy packet and obsolete plan",
      reviewedAt: "2026-07-09T23:20:00.000Z",
      itemUpdatedAt: "2026-07-09T23:10:00Z",
      location: "closed",
    });
    write(
      paths.closedRecord,
      fs
        .readFileSync(paths.closedRecord, "utf8")
        .replace(/^decision_packet_(?:sha256|path): .*\n/gm, ""),
    );
    captureEventBaseSnapshot(store);
    const closedCleanupRemoteRoot = path.join(root, "closed-cleanup-remote");
    copyTupleToRoot(paths, closedCleanupRemoteRoot);
    fs.rmSync(paths.planRecord);
    fs.rmSync(paths.decisionPacket);
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot: closedCleanupRemoteRoot }), "closed");
    assert.equal(fs.existsSync(paths.planRecord), false);
    assert.equal(fs.existsSync(paths.decisionPacket), false);

    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "legacy missing packet T20",
      reviewedAt: "2026-07-09T23:20:00.000Z",
      itemUpdatedAt: "2026-07-09T23:10:00Z",
    });
    fs.rmSync(paths.decisionPacket);
    captureEventBaseSnapshot(store);
    const preservedRemoteRoot = path.join(root, "preserved-invalid-remote");
    copyTupleToRoot(paths, preservedRemoteRoot);
    write(
      paths.itemRecord,
      fs
        .readFileSync(paths.itemRecord, "utf8")
        .replace("2026-07-09T23:20:00.000Z", "2026-07-09T23:30:00.000Z")
        .replace("2026-07-09T23:10:00Z", "2026-07-09T23:20:00Z")
        .replace("# legacy missing packet T20", "# monotonic legacy packet carry T30"),
    );
    captureEventSnapshot(store);
    assert.equal(applyEventSnapshot(paths, { remoteRoot: preservedRemoteRoot }), "open");
    assert.match(fs.readFileSync(paths.itemRecord, "utf8"), /monotonic legacy packet carry T30/);
  });
});

test("event snapshots fail closed on packet mismatch and equal-time divergence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-"));
  const store = {
    targetRepo: "openclaw/openclaw",
    itemNumber: "42",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "base",
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
    captureEventBaseSnapshot(store);
    const remoteRoot = path.join(root, "remote");
    copyTupleToRoot(paths, remoteRoot);
    writeEventTuple(paths, {
      marker: "candidate",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:05:00Z",
    });
    fs.appendFileSync(paths.decisionPacket, " ");
    assert.throws(() => captureEventSnapshot(store), /decision packet digest mismatch/);

    resetEventSnapshot(store);
    writeEventTuple(paths, {
      marker: "wrong-primary packet",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:05:00Z",
    });
    const wrongPrimaryPacket = JSON.parse(fs.readFileSync(paths.decisionPacket, "utf8"));
    wrongPrimaryPacket.source.reportPath = paths.closedRecord;
    const wrongPrimaryPacketText = `${JSON.stringify(wrongPrimaryPacket, null, 2)}\n`;
    write(paths.decisionPacket, wrongPrimaryPacketText);
    write(
      paths.itemRecord,
      fs
        .readFileSync(paths.itemRecord, "utf8")
        .replace(
          /^decision_packet_sha256: .*$/m,
          `decision_packet_sha256: ${createHash("sha256").update(wrongPrimaryPacketText).digest("hex")}`,
        ),
    );
    assert.throws(() => captureEventSnapshot(store), /points to another primary record/);

    resetEventSnapshot(store);
    copyTupleFromRoot(paths, remoteRoot);
    captureEventBaseSnapshot(store);
    writeEventTuple(paths, {
      marker: "malformed candidate",
      reviewedAt: "not-a-timestamp",
      itemUpdatedAt: "2026-07-09T23:05:00Z",
    });
    assert.throws(() => captureEventSnapshot(store), /malformed reviewed_at/);

    resetEventSnapshot(store);
    copyTupleFromRoot(paths, remoteRoot);
    captureEventBaseSnapshot(store);
    writeEventTuple(paths, {
      marker: "same-time candidate",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:05:00Z",
    });
    captureEventSnapshot(store);
    const remotePaths = {
      ...paths,
      itemRecord: path.join(remoteRoot, paths.itemRecord),
      closedRecord: path.join(remoteRoot, paths.closedRecord),
      planRecord: path.join(remoteRoot, paths.planRecord),
      decisionPacket: path.join(remoteRoot, paths.decisionPacket),
    };
    writeEventTuple(remotePaths, {
      marker: "same-time remote",
      reviewedAt: "2026-07-09T23:10:00.000Z",
      itemUpdatedAt: "2026-07-09T23:05:00Z",
    });
    assert.throws(
      () => applyEventSnapshot(paths, { remoteRoot }),
      /equal mutation vector with different tuple contents/,
    );

    resetEventSnapshot(store);
    writeTimelessTuple(paths, "timeless base");
    captureEventBaseSnapshot(store);
    const timelessRemoteRoot = path.join(root, "timeless-remote");
    copyTupleToRoot(paths, timelessRemoteRoot);
    writeTimelessTuple(paths, "timeless candidate");
    assert.throws(() => captureEventSnapshot(store), /missing comparable state-mutation timestamp/);
  });
});

test("event record paths normalize display-cased target repos to the profile slug", () => {
  const paths = eventRecordPaths({
    targetRepo: "steipete/Nameplate",
    itemNumber: "24",
    snapshotDir: "snapshot",
  });
  assert.equal(paths.targetSlug, "steipete-nameplate");
  assert.equal(paths.itemRecord, "records/steipete-nameplate/items/24.md");
  assert.equal(paths.closedRecord, "records/steipete-nameplate/closed/24.md");
  assert.equal(paths.planRecord, "records/steipete-nameplate/plans/24.md");
  assert.equal(paths.decisionPacket, "records/steipete-nameplate/decision-packets/24.json");

  const lowercase = eventRecordPaths({
    targetRepo: "openclaw/openclaw",
    itemNumber: "91668",
    snapshotDir: "snapshot",
  });
  assert.equal(lowercase.targetSlug, "openclaw-openclaw");
});

test("display-cased target repo captures the tuple written under the lowercase profile slug", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-event-records-case-"));
  const store = {
    targetRepo: "steipete/Nameplate",
    itemNumber: "24",
    snapshotDir: path.join(root, "snapshot"),
  };

  withCwd(root, () => {
    const paths = eventRecordPaths(store);
    resetEventSnapshot(store);
    captureEventBaseSnapshot(store);
    // apply-artifacts writes through the repository profile, which lowercases
    // the repo before deriving the slug.
    writeEventTuple(paths, {
      marker: "case-normalized candidate",
      reviewedAt: "2026-07-10T20:20:00.000Z",
      itemUpdatedAt: "2026-07-10T20:00:00Z",
      packet: false,
      plan: false,
    });
    const captured = captureEventSnapshot(store);
    assert.equal(fs.existsSync(captured.snapshotItem), true);
    assert.equal(applyEventSnapshot(captured), "open");
  });
});

function withCwd(cwd, callback) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeEventTuple(
  paths,
  {
    marker,
    reviewedAt,
    itemUpdatedAt,
    location = "items",
    packet = true,
    plan = true,
    extraFrontMatter = [],
  },
) {
  const packetContent = packet
    ? `${JSON.stringify(
        {
          version: 1,
          generatedAt: reviewedAt,
          updatedAt: itemUpdatedAt,
          subject: {
            repo: "openclaw/openclaw",
            number: Number(path.basename(paths.itemRecord, ".md")),
          },
          source: {
            reportPath: (location === "items" ? paths.itemRecord : paths.closedRecord).replace(
              /^.*?(records\/)/,
              "$1",
            ),
            reviewedAt,
          },
          marker,
        },
        null,
        2,
      )}\n`
    : null;
  const digest = packetContent ? createHash("sha256").update(packetContent).digest("hex") : "none";
  const primary = [
    "---",
    `decision_packet_sha256: ${digest}`,
    `decision_packet_path: ${packetContent ? paths.decisionPacket.replace(/^.*?(records\/)/, "$1") : "none"}`,
    `item_updated_at: ${itemUpdatedAt}`,
    `reviewed_at: ${reviewedAt}`,
    ...extraFrontMatter,
    "---",
    "",
    `# ${marker}`,
    "",
  ].join("\n");
  const planContent = plan ? `---\nreviewed_at: ${reviewedAt}\n---\n\n# Plan ${marker}\n` : null;

  fs.rmSync(location === "items" ? paths.closedRecord : paths.itemRecord, { force: true });
  write(location === "items" ? paths.itemRecord : paths.closedRecord, primary);
  if (planContent) write(paths.planRecord, planContent);
  else fs.rmSync(paths.planRecord, { force: true });
  if (packetContent) write(paths.decisionPacket, packetContent);
  else fs.rmSync(paths.decisionPacket, { force: true });
  return { primary, plan: planContent, packet: packetContent };
}

function writeTimelessTuple(paths, marker) {
  fs.rmSync(paths.closedRecord, { force: true });
  fs.rmSync(paths.planRecord, { force: true });
  fs.rmSync(paths.decisionPacket, { force: true });
  write(
    paths.itemRecord,
    `---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\n\n# ${marker}\n`,
  );
}

function copyTupleToRoot(paths, root) {
  for (const recordPath of [
    paths.itemRecord,
    paths.closedRecord,
    paths.planRecord,
    paths.decisionPacket,
  ]) {
    if (fs.existsSync(recordPath)) write(path.join(root, recordPath), fs.readFileSync(recordPath));
  }
}

function copyTupleFromRoot(paths, root) {
  for (const recordPath of [
    paths.itemRecord,
    paths.closedRecord,
    paths.planRecord,
    paths.decisionPacket,
  ]) {
    fs.rmSync(recordPath, { force: true });
    const source = path.join(root, recordPath);
    if (fs.existsSync(source)) write(recordPath, fs.readFileSync(source));
  }
}
