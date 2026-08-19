import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  recordTuplePaths,
  validateRecordTuple,
  type RecordTupleContents,
} from "../../src/repair/record-tuple.ts";

function mixedCaseTuple(subjectRepository = "steipete/CodexBar"): RecordTupleContents {
  const number = "2516";
  const paths = recordTuplePaths({ repository: "steipete-codexbar", number });
  const packet = JSON.stringify({
    version: 1,
    subject: { repo: subjectRepository, number: Number(number) },
    source: { reportPath: "records/steipete-CodexBar/items/2516.md" },
  });
  const digest = createHash("sha256").update(packet).digest("hex");
  const item = [
    "---",
    "repository: steipete/CodexBar",
    `number: ${number}`,
    "reviewed_at: 2026-08-10T09:02:00.000Z",
    `decision_packet_sha256: ${digest}`,
    "decision_packet_path: records/steipete-CodexBar/decision-packets/2516.json",
    "---",
    "",
    "review",
    "",
  ].join("\n");
  return { paths, item, closed: null, plan: null, packet };
}

test("record tuple validation accepts repository-only casing differences", () => {
  assert.doesNotThrow(() => validateRecordTuple(mixedCaseTuple()));
});

test("record tuple validation still rejects a genuinely different repository", () => {
  assert.throws(
    () => validateRecordTuple(mixedCaseTuple("steipete/Other")),
    /decision packet belongs to another subject/,
  );
});
