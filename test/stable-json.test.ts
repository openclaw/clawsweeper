import assert from "node:assert/strict";
import test from "node:test";

import { compareCodeUnits, stableJson, stableJsonCodeUnit } from "../dist/stable-json.js";

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

test("stableJson is a canonical form: insertion order cannot change the output", () => {
  // Collation-ignorable characters make localeCompare return 0 for distinct keys.
  // Array.prototype.sort is stable, so a tie would leave property-insertion order
  // in the output and two equal objects would hash differently.
  const zeroWidthJoiner = "‍";
  const softHyphen = "­";
  for (const invisible of [zeroWidthJoiner, softHyphen]) {
    const key = `a${invisible}b`;
    assert.notEqual(key, "ab");
    assert.equal(key.localeCompare("ab"), 0, "precondition: these keys collate equal");

    assert.equal(stableJson({ ab: 1, [key]: 2 }), stableJson({ [key]: 2, ab: 1 }));
  }
});

test("stableJson key order is byte-defined, not locale-defined", () => {
  // Code-unit order puts "B" (0x42) before "a" (0x61); collation does not.
  assert.equal(stableJson({ a: 1, B: 2 }), '{"B":2,"a":1}');

  // cs-CZ collates "ch" after "h", which reorders these two real digest keys.
  // The canonical form must not depend on the runtime's default locale.
  assert.equal(
    stableJson({ checksDigest: "a", commitCount: 1, changedFiles: 2 }),
    '{"changedFiles":2,"checksDigest":"a","commitCount":1}',
  );
});

test("stableJson orders nested arrays and objects consistently", () => {
  assert.equal(
    stableJson({ b: [{ z: 1, a: 2 }], a: { y: 3, x: 4 } }),
    '{"a":{"x":4,"y":3},"b":[{"a":2,"z":1}]}',
  );
});

test("stableJsonCodeUnit remains an alias for stableJson", () => {
  const value = { I: 1, i: 2, checksDigest: "a", changedFiles: 2, [`a‍b`]: 3, ab: 4 };
  assert.equal(stableJsonCodeUnit(value), stableJson(value));
});

test("compareCodeUnits is a strict total order over distinct strings", () => {
  const samples = ["a", "B", "ab", `a‍b`, "checksDigest", "changedFiles", "", "İ"];
  for (const left of samples) {
    for (const right of samples) {
      const result = compareCodeUnits(left, right);
      if (left === right) assert.equal(result, 0);
      else assert.notEqual(result, 0, `distinct keys must never tie: ${left} / ${right}`);
      // Sum rather than negate: -0 !== 0 under the strict assert's Object.is.
      assert.equal(result + compareCodeUnits(right, left), 0, "must be antisymmetric");
    }
  }
});
