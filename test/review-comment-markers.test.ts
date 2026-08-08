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

test("trailingHtmlComments recovers when prose contains an unmatched opener", () => {
  assert.deepEqual(
    trailingHtmlComments(
      [
        "Codex review: mention the literal `<!--` delimiter in visible prose.",
        "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
        "<!-- clawsweeper-review item=321 -->",
      ].join("\n"),
    ),
    [
      "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
      "<!-- clawsweeper-review item=321 -->",
    ],
  );
});

test("a stray '-->' in prose never merges an earlier marker into a blob", () => {
  // Backward scanning pairs each "-->" with the nearest preceding "<!--". When
  // visible prose ends in an arrow, that pairing used to bridge back to a real
  // marker and swallow everything between them.
  const markers = trailingHtmlComments(
    [
      "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
      "The rust operator `-` then `->` renders as -->",
      "<!-- clawsweeper-review item=321 -->",
    ].join("\n"),
  );

  // Prose separates the verdict marker from the final block, so only the
  // contiguous trailing block is returned - and no entry spans visible text.
  assert.deepEqual(markers, ["<!-- clawsweeper-review item=321 -->"]);
  for (const marker of markers) {
    assert.doesNotMatch(marker, /renders as/, "a marker must never contain prose");
    // "no terminator before the closing one" rather than
    // indexOf("-->") === length - 3, which compares equal when indexOf returns
    // -1 and the string is two characters long.
    assert.equal(
      marker.slice(0, -3).includes("-->"),
      false,
      "a marker holds exactly one terminator",
    );
  }
});

test("a review-history marker cannot be bridged into by later prose", () => {
  // renderReviewHistorySection emits a mid-body marker inside a <details> block,
  // which is exactly the earlier opener a stray arrow can bridge back to.
  const body = [
    "Codex review: ready for maintainer look.",
    "",
    "<details>",
    "<summary>Review history (2 cycles)</summary>",
    "<!-- clawsweeper-review-history v=1 total=2 -->",
    "- reviewed abc :: ready :: none",
    "</details>",
    "",
    "Data flows plan --> review --> apply -->",
    "",
    "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
    "<!-- clawsweeper-review item=321 -->",
  ].join("\n");

  const markers = trailingHtmlComments(body);
  assert.deepEqual(markers, [
    "<!-- clawsweeper-verdict:needs-human item=321 sha=head -->",
    "<!-- clawsweeper-review item=321 -->",
  ]);
  assert.equal(
    markers.some((marker) => marker.includes("clawsweeper-review-history")),
    false,
    "the mid-body history marker must not be dragged into the trailing block",
  );
});

test("every returned marker is a single well-formed HTML comment", () => {
  // Property guard: whatever the body, no entry may contain an interior
  // terminator or visible text between the delimiters.
  const bodies = [
    "text --> <!-- a --> <!-- b -->",
    "<!-- a --> mid --> <!-- b --> <!-- c -->",
    "<!-- unmatched opener --> trailing prose -->\n<!-- clawsweeper-review item=1 -->",
    "<!-- a -->",
    "no markers at all",
    "-->",
    "<!--",
  ];
  for (const body of bodies) {
    for (const marker of trailingHtmlComments(body)) {
      assert.ok(marker.startsWith("<!--"), `must open a comment: ${marker}`);
      assert.ok(marker.endsWith("-->"), `must close a comment: ${marker}`);
      assert.equal(
        marker.slice(0, -3).includes("-->"),
        false,
        `must hold exactly one terminator: ${marker}`,
      );
    }
  }
});
