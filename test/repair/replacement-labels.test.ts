import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMERGE_BLOCKING_LABEL_NAMES,
  AUTOMERGE_LABEL,
} from "../../dist/repair/exact-review-guard-labels.js";
import {
  jobSourceLabelChanges,
  replacementLabelsToCopy,
  replacementSourceLabelCopyable,
} from "../../dist/repair/replacement-labels.js";

test("generated issue implementation PRs carry a merge-blocking label and lose automerge", () => {
  const blocking: readonly string[] = AUTOMERGE_BLOCKING_LABEL_NAMES;
  const generated = jobSourceLabelChanges({ source: "issue_implementation" });
  assert.ok(generated.add.some((label) => blocking.includes(label)));
  assert.ok(generated.remove.includes(AUTOMERGE_LABEL));
  // A maintainer-opted automerge job keeps its opt-in and gets no merge-blocking label.
  const automerge = jobSourceLabelChanges({ source: "pr_automerge" });
  assert.deepEqual(automerge, { add: [], remove: [] });
});

test("replacement PRs preserve durable source labels and required labels without duplicates", () => {
  assert.deepEqual(
    replacementLabelsToCopy(
      [
        ["app: web-ui", "component: gateway", "impact:message-loss", "clawsweeper:automerge"],
        ["Gateway", "bug"],
      ],
      ["clawsweeper"],
    ),
    [
      "app: web-ui",
      "component: gateway",
      "impact:message-loss",
      "clawsweeper:automerge",
      "Gateway",
      "bug",
      "clawsweeper",
    ],
  );
});

test("replacement PRs do not copy source close or stale labels", () => {
  assert.deepEqual(
    replacementLabelsToCopy(
      [["close:superseded", "close:stale", "stale", "component: gateway"]],
      ["clawsweeper"],
    ),
    ["component: gateway", "clawsweeper"],
  );
});

test("replacement PRs do not copy source review, proof, status, risk, size, or priority labels", () => {
  assert.deepEqual(
    replacementLabelsToCopy(
      [
        [
          "rating: 🧂 unranked krab",
          "status: 📣 needs proof",
          "proof: missing",
          "triage: needs-real-behavior-proof",
          "triage: needs-pr-context",
          "merge-risk: 🚨 compatibility",
          "size: M",
          "P1",
          "app: web-ui",
        ],
      ],
      ["P2", "status: explicit repair decision"],
    ),
    ["app: web-ui", "P2", "status: explicit repair decision"],
  );
});

test("replacement source label filter documents denied classes", () => {
  for (const label of [
    "close:superseded",
    "stale",
    "rating: 🧂 unranked krab",
    "status: 📣 needs proof",
    "proof: missing",
    "triage: needs-real-behavior-proof",
    "triage: needs-pr-context",
    "merge-risk: 🚨 compatibility",
    "size: M",
    "P3",
  ]) {
    assert.equal(replacementSourceLabelCopyable(label), false, label);
  }
});
