import assert from "node:assert/strict";
import test from "node:test";

import { stableJsonCodeUnit } from "../dist/stable-json.js";

test("code-unit stable JSON canonicalizes nested object keys without locale state", () => {
  assert.equal(
    stableJsonCodeUnit({
      I: { changedFiles: 1, checksDigest: "a" },
      i: { checksDigest: "b", changedFiles: 2 },
      "\u0130": [{ checksDigest: "c", changedFiles: 3 }],
      "\u0131": [{ changedFiles: 4, checksDigest: "d" }],
    }),
    '{"I":{"changedFiles":1,"checksDigest":"a"},"i":{"changedFiles":2,"checksDigest":"b"},"\u0130":[{"changedFiles":3,"checksDigest":"c"}],"\u0131":[{"changedFiles":4,"checksDigest":"d"}]}',
  );
});
