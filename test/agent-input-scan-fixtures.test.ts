import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("WebVNC fixture policy retains both exact native identities and source witnesses", () => {
  // Inspect only the static policy data, without copying credential-shaped fixture values.
  const source = readFileSync(
    new URL("../src/agent-input-scan-fixtures.ts", import.meta.url),
    "utf8",
  );
  const declaration = source.match(/const REVIEWED_FIXTURES:[^\n]* = \[([\s\S]*?)\n\];/);
  assert.ok(declaration);
  const flatObjects = (array: string) => {
    const data = array.replace(/\/\/[^\n]*/g, "");
    assert.equal(data.replace(/\{([^{}]*)\}/g, "").replace(/[\s,]/g, ""), "");
    return [...data.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!);
  };
  for (const unsupported of ["wrap({})", "{ nested: {} }", "...other, {}"])
    assert.throws(() => flatObjects(unsupported));
  const records = flatObjects(declaration[1]!)
    .filter((body) => body.includes('"internal/cli/webvnc_test.go"'))
    .map((body) => {
      const property = /([A-Za-z]\w*):\s*("(?:[^"\\]|\\.)*"|\[[^[\]]*\]),/g;
      const entries = [...body.matchAll(property)].map((match) => {
        const value: unknown = JSON.parse(match[2]!);
        assert.ok(
          typeof value === "string" ||
            (Array.isArray(value) && value.every((part) => typeof part === "string")),
        );
        return [match[1]!, value] as const;
      });
      assert.equal(body.replace(property, "").trim(), "");
      assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
      return Object.fromEntries(entries);
    });
  assert.deepEqual(records, [
    {
      fixtureSha256: "18cd62c666a4b48f9968cacc2acc34a27c1f15682219d4f45bfb903cfb3d60fc",
      rawSha256: "d72aa985328cd8b6b8d13182b028f5e5c06e574b9acfddc31dc5ab0655896050",
      lineSha256s: ["83b93f401c1c6526ce80cca9860fdbf59825c92e70644a6f087e6a1b46b295e8"],
      decoders: ["PLAIN"],
      sources: ["internal/cli/webvnc_test.go"],
    },
    {
      fixtureSha256: "5f63e971f3b95e10c500e2c40cfaf423b47c60e1bbb3c1dad9633cef0aa1a10f",
      rawSha256: "6a160b5adb896b7ae8e5347258bce211ebcb35f422aa9fc0931d2406403e72ae",
      lineSha256s: ["83b93f401c1c6526ce80cca9860fdbf59825c92e70644a6f087e6a1b46b295e8"],
      decoders: ["PLAIN"],
      sources: ["internal/cli/webvnc_test.go"],
    },
  ]);
});
