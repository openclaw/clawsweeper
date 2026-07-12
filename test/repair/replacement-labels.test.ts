import assert from "node:assert/strict";
import test from "node:test";

import {
  replacementAutomationLabel,
  replacementLabelsToCopy,
  replacementSourceLabelCopyable,
} from "../../dist/repair/replacement-labels.js";

test("replacement PRs inherit autofix intent from source PR labels", () => {
  assert.equal(
    replacementAutomationLabel([["docs", "clawsweeper:autofix"]]),
    "clawsweeper:autofix",
  );
});

test("replacement PRs prefer automerge intent over autofix", () => {
  assert.equal(
    replacementAutomationLabel([["clawsweeper:autofix"], ["clawsweeper:automerge"]]),
    "clawsweeper:automerge",
  );
});

test("replacement PRs without source automation labels stay unlabeled", () => {
  assert.equal(replacementAutomationLabel([["docs"], ["clawsweeper"]]), null);
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
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
  ]) {
    assert.equal(replacementSourceLabelCopyable(label), false, label);
  }
});
