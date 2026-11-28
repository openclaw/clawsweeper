import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyTestCutSources } from "../dist/review-test-cuts.js";

test("publish a surviving assertion from the reviewed commit only when it remains after all cuts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-cut-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  const file = "reload.test.ts";
  const assertion = 'expect(result.draft).toBe("saved");';
  const row = '["saved", "saved"],';
  writeFileSync(join(root, file), [assertion, assertion, row, row].join("\n") + "\n");
  git("add", file);
  git("-c", "commit.gpgSign=false", "commit", "-qm", "reload");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(root, file), "uncommitted assertion\n");
  const candidate = (
    line: number,
    other: number,
    quote = assertion,
    path = file,
    inputLine = 3,
  ) => ({
    file,
    lineStart: line,
    lineEnd: line,
    sourceLines: [line < 3 ? assertion : row],
    reason: "Duplicate draft assertion.",
    behaviors: [
      {
        behavior: "A saved draft is returned.",
        fault: "Return an empty draft.",
        survivor: {
          file: path,
          line: other,
          assertion: quote,
          failure: "The returned draft differs.",
          inputs: [{ file, lineStart: inputLine, lineEnd: inputLine, sourceLine: row }],
        },
      },
    ],
  });
  const cut = candidate(1, 2);
  assert.deepEqual(verifyTestCutSources([cut], root, sha), [cut]);
  for (const cuts of [
    [candidate(1, 1)],
    [cut, candidate(2, 1)],
    [candidate(1, 1, assertion, "./" + file)],
    [candidate(1, 1, "uncommitted assertion")],
    [candidate(5, 2)],
    [candidate(1, 5)],
    [candidate(1, 2, assertion, file, 1)],
    // Both duplicate rows point at the same assertion. Removing both would stop it running on this input.
    [candidate(3, 2, assertion, file, 4), candidate(4, 2, assertion, file, 3)],
  ])
    assert.deepEqual(verifyTestCutSources(cuts, root, sha), []);
  assert.deepEqual(verifyTestCutSources([cut], root, undefined), []);

  // Remove the second assertion. Its old line 2 now holds a row, but still fits in the file.
  writeFileSync(join(root, file), [assertion, row, row, row, row].join("\n") + "\n");
  git("-c", "commit.gpgSign=false", "commit", "-qam", "remove duplicate assertion");
  const head = git("rev-parse", "HEAD");
  const removed = candidate(2, 1, assertion, file, 5);
  assert.deepEqual(verifyTestCutSources([removed], root, head), []);
  const remaining = { ...removed, sourceLines: [row] };
  assert.deepEqual(verifyTestCutSources([remaining], root, head), [remaining]);
  const block = { ...remaining, lineEnd: 4, sourceLines: [row, row, row] };
  assert.deepEqual(verifyTestCutSources([block], root, head), [block]);
  const staleMiddle = { ...block, sourceLines: [row, assertion, row] };
  assert.deepEqual(verifyTestCutSources([staleMiddle], root, head), []);
});
