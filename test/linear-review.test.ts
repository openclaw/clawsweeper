import assert from "node:assert/strict";
import test from "node:test";

import { runLinearReview } from "../scripts/linear-review.mjs";

test("runLinearReview forwards CLI scope arguments to snapshot before triage", () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { input?: string };
  }> = [];
  const run = (command: string, args: string[], options: { input?: string }) => {
    calls.push({ command, args, options });
    if (calls.length === 1) {
      return { status: 0, stdout: '{"items":[]}', stderr: "", error: undefined };
    }
    return { status: 0, stdout: '{"ok":true}', stderr: "", error: undefined };
  };

  const result = runLinearReview(["--team", "PAR"], {
    run,
    nodePath: "/node",
    scriptsDir: "/repo/scripts",
  });

  assert.deepEqual(calls[0]?.args, ["/repo/scripts/linear-snapshot.mjs", "--team", "PAR"]);
  assert.deepEqual(calls[1]?.args, ["/repo/scripts/linear-triage.mjs", "--review-only", "--json"]);
  assert.equal(calls[1]?.options.input, '{"items":[]}');
  assert.equal(result.stdout, '{"ok":true}');
});
