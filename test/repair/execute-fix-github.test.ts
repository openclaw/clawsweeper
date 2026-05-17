import assert from "node:assert/strict";
import test from "node:test";

import { CLAWSWEEPER_CO_AUTHOR_TRAILER } from "../../dist/repair/co-author-credit.js";
import { coAuthorTrailers } from "../../dist/repair/execute-fix-github.js";

test("replacement co-author trailers include contributor and ClawSweeper credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "Mona Octocat",
        email: "1+octocat@users.noreply.github.com",
      },
    ]),
    [
      "Co-authored-by: Mona Octocat <1+octocat@users.noreply.github.com>",
      CLAWSWEEPER_CO_AUTHOR_TRAILER,
    ],
  );
});

test("replacement co-author trailers dedupe ClawSweeper credit", () => {
  assert.deepEqual(
    coAuthorTrailers([
      {
        name: "clawsweeper[bot]",
        email: "274271284+clawsweeper[bot]@users.noreply.github.com",
      },
    ]),
    [CLAWSWEEPER_CO_AUTHOR_TRAILER],
  );
});
