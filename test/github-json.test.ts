import assert from "node:assert/strict";
import test from "node:test";

import { parseGhJsonLinesWithRetry } from "../dist/github-json.js";

test("JSON-lines loader retries a successful command with truncated output", () => {
  const responses = ['{"number":1}\n{"number":', '{"number":1}\n{"number":2}'];
  const retries: number[] = [];

  const parsed = parseGhJsonLinesWithRetry<{ number: number }>(
    () => responses.shift() ?? "",
    ["api", "repos/openclaw/openclaw/issues", "--jq", ".[]"],
    {
      onRetry: (_error, attempt) => retries.push(attempt),
    },
  );

  assert.deepEqual(parsed, [{ number: 1 }, { number: 2 }]);
  assert.deepEqual(retries, [1]);
  assert.equal(responses.length, 0);
});
