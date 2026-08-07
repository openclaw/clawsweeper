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
