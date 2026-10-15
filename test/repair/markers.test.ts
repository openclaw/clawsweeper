import assert from "node:assert/strict";
import test from "node:test";

import {
  commandAckCommentIds,
  commandAckMarker,
  commandAckMarkerFromBody,
  commandResponseMarker,
  commandResponseMarkersInBody,
  commandStatusMarker,
  commandStatusMarkerFromBody,
  commandStatusMarkerPrefix,
  hasCommandAckMarker,
  hasCommandStatusMarker,
  itemCommandStatusMarkerPrefix,
  parseCommandResponseMarker,
  parseCommandStatusMarker,
} from "../../dist/repair/markers.js";

test("command-ack marker round-trips through its parsers", () => {
  const marker = commandAckMarker(4358615144);
  const body = `${marker}\nClawSweeper picked this up.`;
  assert.equal(marker, "<!-- clawsweeper-command-ack:4358615144 -->");
  assert.equal(commandAckMarkerFromBody(body), marker);
  assert.deepEqual(commandAckCommentIds(body), [4358615144]);
  assert.equal(hasCommandAckMarker(body), true);
  assert.equal(hasCommandAckMarker("no marker"), false);
});

test("command-status marker round-trips through its parsers", () => {
  const marker = commandStatusMarker(
    75338,
    "automerge",
    "dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10",
  );
  const body = `${marker}\nClawSweeper status.`;
  assert.equal(
    marker,
    "<!-- clawsweeper-command-status:75338:automerge:dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10 -->",
  );
  assert.ok(marker.startsWith(commandStatusMarkerPrefix(75338, "automerge")));
  assert.ok(marker.startsWith(itemCommandStatusMarkerPrefix(75338)));
  assert.equal(commandStatusMarkerFromBody(body), marker);
  assert.equal(hasCommandStatusMarker(body), true);
  assert.deepEqual(parseCommandStatusMarker(marker), {
    issueNumber: "75338",
    intent: "automerge",
    revision: "dc3e9a97a2c655c0c054cddb5a64e7b6fc51dd10",
  });
});

test("command response marker round-trips through its parser", () => {
  const marker = commandResponseMarker("4358615144", "fix_ci", "na");
  assert.deepEqual(commandResponseMarkersInBody(`${marker}\nDone.`), [marker]);
  assert.deepEqual(parseCommandResponseMarker(marker), {
    commentId: "4358615144",
    createdAt: null,
    intent: "fix_ci",
    revision: "na",
  });
});

test("marker parsers keep each caller's case rule", () => {
  const upper = "<!-- CLAWSWEEPER-COMMAND-STATUS:7:automerge:na -->";
  assert.equal(parseCommandStatusMarker(upper), null);
  assert.equal(parseCommandStatusMarker(upper, { ignoreCase: true })?.intent, "automerge");
  assert.equal(hasCommandAckMarker("<!-- CLAWSWEEPER-COMMAND-ACK:1 -->"), false);
  assert.equal(
    hasCommandAckMarker("<!-- CLAWSWEEPER-COMMAND-ACK:1 -->", { ignoreCase: true }),
    true,
  );
});
