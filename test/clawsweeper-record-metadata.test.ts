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

test("report prose that quotes a front matter key does not mask the real value", () => {
  // The body is model-authored review text. A quoted PR field, a fenced YAML
  // sample, or a findings row can legitimately start a line with `key:`, and that
  // must not make the record's own front matter unreadable.
  const frontMatter = [
    "---",
    "repository: openclaw/openclaw",
    "type: pull_request",
    "title: Fix the thing",
    "url: https://github.com/openclaw/openclaw/pull/42",
    "---",
  ].join("\n");

  const bodies = {
    "quoted PR field": "Codex review: ready.\n\nThe PR body says:\n\ntitle: quoted by the model\n",
    "fenced yaml sample": "Codex review: ready.\n\n```yaml\ntype: bug\n```\n",
    "findings row": "Codex review: ready.\n\nurl: see the linked run\n",
  };

  for (const [name, body] of Object.entries(bodies)) {
    const report = `${frontMatter}\n\n${body}`;
    assert.deepEqual(
      metadata.frontMatterField(report, "type"),
      { status: "value", value: "pull_request" },
      `${name} must not mask type`,
    );
    assert.deepEqual(
      metadata.frontMatterField(report, "title"),
      { status: "value", value: "Fix the thing" },
      `${name} must not mask title`,
    );
    assert.deepEqual(
      metadata.frontMatterField(report, "url"),
      { status: "value", value: "https://github.com/openclaw/openclaw/pull/42" },
      `${name} must not mask url`,
    );
  }
});

test("a second front matter block still makes a field ambiguous", () => {
  // The competing-record guard is the point of the check and must survive, in both
  // the delimiter-first and bare-run shapes.
  const bare = ["---", "type: issue", "---", "type: pull_request", "---", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(bare, "type"), { status: "ambiguous" });

  const delimited = ["---", "type: issue", "---", "---", "type: pull_request", "---", ""].join(
    "\n",
  );
  assert.deepEqual(metadata.frontMatterField(delimited, "type"), { status: "ambiguous" });

  // A competing block that does not mention the key leaves other keys readable.
  const other = ["---", "type: issue", "number: 7", "---", "number: 9", "---", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(other, "type"), { status: "value", value: "issue" });
  assert.deepEqual(metadata.frontMatterField(other, "number"), { status: "ambiguous" });
});

test("an unterminated key-shaped run in the body is prose, not a competing block", () => {
  // Without a closing `---` there is no second record, so the leading value stands.
  const report = ["---", "type: pull_request", "---", "type: not a record", ""].join("\n");
  assert.deepEqual(metadata.frontMatterField(report, "type"), {
    status: "value",
    value: "pull_request",
  });
});
