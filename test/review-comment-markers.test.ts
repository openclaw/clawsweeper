import assert from "node:assert/strict";
import test from "node:test";

import { trailingHtmlComments } from "../dist/review-comment-markers.js";

test("trailingHtmlComments returns only the final contiguous comment block", () => {
  assert.deepEqual(
    trailingHtmlComments(
      [
        "Codex review: ready for maintainer look.",
        "<!-- stale-marker -->",
        "Visible review details.",
        "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
        "<!-- clawsweeper-action:fix-required item=321 sha=head -->",
        "",
      ].join("\n"),
    ),
    [
      "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
      "<!-- clawsweeper-action:fix-required item=321 sha=head -->",
    ],
  );
});

test("trailingHtmlComments rejects an unterminated adversarial suffix", () => {
  const value = `<!--${"--><!--".repeat(10_000)}unterminated`;
  assert.deepEqual(trailingHtmlComments(value), []);
});
