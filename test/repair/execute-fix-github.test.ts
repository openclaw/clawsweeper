import assert from "node:assert/strict";
import test from "node:test";

import { coAuthorTrailers } from "../../dist/repair/execute-fix-github.js";

test("replacement co-author trailers include contributors without bot self-credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "Mona Octocat",
        email: "1+octocat@users.noreply.github.com",
      },
    ]),
    ["Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>"],
  );
});

test("replacement co-author trailers omit ClawSweeper self-credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "clawsweeper[bot]",
        email: "274271284+clawsweeper[bot]@users.noreply.github.com",
      },
    ]),
    [],
  );
});
