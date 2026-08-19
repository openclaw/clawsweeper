import assert from "node:assert/strict";
import test from "node:test";

import { createRecordMetadata } from "../dist/clawsweeper-record-metadata.js";

const metadata = createRecordMetadata({
  reportFileName: () => "unused.md",
  markdownRepository: () => "openclaw/clawsweeper",
  isVerifiedFixedCloseReason: () => false,
  isOlderThanDays: () => false,
  timestampMs: () => null,
  pullHeadShaFromReport: () => null,
  reviewLeaseRevisionFromReport: () => null,
  lockedConversationApplyReason: () => null,
  markdownFiles: () => [],
  numberForMarkdownFile: () => 0,
});

test("front matter fields are ambiguous when the same key occurs after the leading block", () => {
  const report = `---
fixed_release: v1
real_behavior_proof_status: sufficient
---
real_behavior_proof_status: missing
---
`;

  assert.deepEqual(metadata.frontMatterField(report, "real_behavior_proof_status"), {
    status: "ambiguous",
  });
});

test("front matter fields preserve current-format, duplicate, and no-block behavior", () => {
  assert.deepEqual(
    metadata.frontMatterField(
      "---\nreal_behavior_proof_status: missing\n---\n\n## Summary\n\nUnproven.\n",
      "real_behavior_proof_status",
    ),
    { status: "value", value: "missing" },
  );
  assert.deepEqual(
    metadata.frontMatterField(
      "---\nreal_behavior_proof_status: sufficient\nreal_behavior_proof_status: missing\n---\n",
      "real_behavior_proof_status",
    ),
    { status: "ambiguous" },
  );
  assert.deepEqual(
    metadata.frontMatterField(
      "real_behavior_proof_status: sufficient\n\n## Summary\n\nNo leading block.\n",
      "real_behavior_proof_status",
    ),
    { status: "absent" },
  );
});

test("label names containing replacement patterns survive a front matter write", () => {
  // `labels` is written as replaceFrontMatterValue(markdown, "labels", JSON.stringify(
  // item.labels)), and those names come from the reviewed repository. GitHub permits
  // `$`, a backtick and a quote in a label, so `$&`, "$`" and "$'" reach this writer as
  // ordinary data and must not be expanded against the match.
  const report = ["---", "repository: openclaw/openclaw", "labels: []", "---", "", "body", ""].join(
    "\n",
  );

  for (const labels of [["bug"], ["$&"], ["$`"], ["$'"], ["a$&b"], ["$$"], ["P$1"]]) {
    const written = JSON.stringify(labels);
    const next = metadata.replaceFrontMatterValue(report, "labels", written);
    assert.equal(
      metadata.frontMatterValue(next, "labels"),
      written,
      `labels ${written} must be stored verbatim`,
    );
    assert.deepEqual(
      metadata.frontMatterStringArray(next, "labels"),
      labels,
      `labels ${written} must read back unchanged`,
    );
  }
});

test("front matter keys are matched literally, not as regular expressions", () => {
  // No shipped caller passes a key with regex syntax, but the helpers advertise a plain
  // `key: string` contract; interpolating it raw makes them throw or match the wrong line.
  for (const key of ["a.c", "a+b", "x(y", "k[0]", "q|r"]) {
    const report = ["---", `${key}: original`, "---", "", "body", ""].join("\n");

    assert.deepEqual(
      metadata.frontMatterField(report, key),
      { status: "value", value: "original" },
      `key ${key} must be readable`,
    );

    const next = metadata.replaceFrontMatterValue(report, key, "updated");
    assert.equal(
      metadata.frontMatterValue(next, key),
      "updated",
      `key ${key} must be updated in place`,
    );
    assert.equal(next.includes(`${key}: original`), false, `key ${key} must not be duplicated`);
  }

  // A literal key must not match a different, regex-equivalent line.
  const decoy = ["---", "aXc: decoy", "---", "", "body", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(decoy, "a.c"), { status: "absent" });
});
