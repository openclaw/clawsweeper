import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistorySnippets,
  buildRelatedItemBodies,
  buildSourceExcerpts,
  extractShasFromText,
  extractSourceRefsFromText,
  parseGitLogTabular,
} from "../dist/evidence-collector.js";

test("extractSourceRefsFromText finds path, path:line, and path:start-end refs", () => {
  const text = [
    "Repro at src/foo.ts:42 and also lib/bar/baz.ts:10-25.",
    "Loose mention of docs/changelog.md without a line.",
  ].join("\n");
  const refs = extractSourceRefsFromText(text);
  assert.deepEqual(refs, [
    { path: "src/foo.ts", line: 42 },
    { path: "lib/bar/baz.ts", range: [10, 25] },
    { path: "docs/changelog.md" },
  ]);
});

test("extractSourceRefsFromText skips URLs and fenced code blocks", () => {
  const text = [
    "See https://github.com/org/repo/blob/main/src/foo.ts:1 for context.",
    "```ts",
    "import foo from 'src/inside-fence.ts';",
    "```",
    "But src/outside-fence.ts is fair game.",
  ].join("\n");
  const refs = extractSourceRefsFromText(text);
  assert.deepEqual(refs, [{ path: "src/outside-fence.ts" }]);
});

test("extractSourceRefsFromText dedupes repeated refs", () => {
  const text = "First src/foo.ts:10 then again src/foo.ts:10 and once more src/foo.ts:10.";
  const refs = extractSourceRefsFromText(text);
  assert.deepEqual(refs, [{ path: "src/foo.ts", line: 10 }]);
});

test("extractSourceRefsFromText returns [] for empty or refless text", () => {
  assert.deepEqual(extractSourceRefsFromText(""), []);
  assert.deepEqual(extractSourceRefsFromText("Just words, no paths."), []);
});

test("extractShasFromText recognises 7-40 hex with at least one letter and digit", () => {
  const text = "Regressed by abcdef1, then fixed in 1234567890abcdef1234567890abcdef12345678.";
  assert.deepEqual(extractShasFromText(text), [
    "abcdef1",
    "1234567890abcdef1234567890abcdef12345678",
  ]);
});

test("extractShasFromText rejects all-digit and all-letter runs", () => {
  assert.deepEqual(extractShasFromText("phone 1234567 and word aaaaaaa"), []);
});

test("buildSourceExcerpts slices around a single-line ref with default 20-line window", () => {
  const blob = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const excerpts = buildSourceExcerpts({
    refs: [{ path: "src/foo.ts", line: 50 }],
    mainSha: "deadbeef",
    fetchBlob: (path) => (path === "src/foo.ts" ? blob : null),
  });
  assert.equal(excerpts.length, 1);
  assert.equal(excerpts[0].path, "src/foo.ts");
  assert.equal(excerpts[0].sha, "deadbeef");
  assert.equal(excerpts[0].startLine, 30);
  assert.equal(excerpts[0].endLine, 70);
  assert.ok(excerpts[0].body.startsWith("line 30\n"));
  assert.ok(excerpts[0].body.endsWith("line 70"));
});

test("buildSourceExcerpts slices a range ref with surrounding context lines", () => {
  const blob = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const excerpts = buildSourceExcerpts({
    refs: [{ path: "src/foo.ts", range: [100, 110] }],
    mainSha: "deadbeef",
    fetchBlob: () => blob,
    contextLines: 5,
  });
  assert.equal(excerpts[0].startLine, 95);
  assert.equal(excerpts[0].endLine, 115);
});

test("buildSourceExcerpts returns head 200 lines when no line number is supplied", () => {
  const blob = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
  const excerpts = buildSourceExcerpts({
    refs: [{ path: "src/foo.ts" }],
    mainSha: "deadbeef",
    fetchBlob: () => blob,
  });
  assert.equal(excerpts[0].startLine, 1);
  assert.equal(excerpts[0].endLine, 200);
});

test("buildSourceExcerpts skips refs where the fetcher returns null", () => {
  const excerpts = buildSourceExcerpts({
    refs: [
      { path: "missing.ts", line: 1 },
      { path: "ok.ts", line: 1 },
    ],
    mainSha: "deadbeef",
    fetchBlob: (path) => (path === "ok.ts" ? "hello world" : null),
  });
  assert.equal(excerpts.length, 1);
  assert.equal(excerpts[0].path, "ok.ts");
});

test("buildSourceExcerpts caps total bytes across excerpts", () => {
  const blob = "x".repeat(5000);
  const excerpts = buildSourceExcerpts({
    refs: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
    mainSha: "deadbeef",
    fetchBlob: () => blob,
    maxTotalBytes: 4000,
  });
  const total = excerpts.reduce((sum, e) => sum + e.body.length, 0);
  assert.ok(total <= 4000, `total ${total} exceeded cap`);
});

test("buildHistorySnippets calls the fetcher with the requested limit", () => {
  const calls: Array<[string, number]> = [];
  const snippets = buildHistorySnippets({
    paths: ["src/foo.ts", "src/bar.ts"],
    fetchLog: (path, limit) => {
      calls.push([path, limit]);
      return [{ sha: "a".repeat(7), date: "2026-01-01", author: "Alice", subject: "x" }];
    },
    maxCommits: 4,
  });
  assert.deepEqual(calls, [
    ["src/foo.ts", 4],
    ["src/bar.ts", 4],
  ]);
  assert.equal(snippets.length, 2);
  assert.equal(snippets[0].commits[0].author, "Alice");
});

test("buildHistorySnippets drops paths with no commits or fetcher errors", () => {
  const snippets = buildHistorySnippets({
    paths: ["empty.ts", "throws.ts", "ok.ts"],
    fetchLog: (path) => {
      if (path === "empty.ts") return [];
      if (path === "throws.ts") throw new Error("boom");
      return [{ sha: "abc1234", date: "2026-01-01", author: "A", subject: "s" }];
    },
  });
  assert.deepEqual(
    snippets.map((s) => s.path),
    ["ok.ts"],
  );
});

test("parseGitLogTabular parses tab-separated git log output", () => {
  const text = [
    "abc1234\t2026-01-01T12:00:00Z\tAlice\tfix: foo",
    "def5678\t2026-01-02T12:00:00Z\tBob\trefactor: bar baz",
    "",
  ].join("\n");
  assert.deepEqual(parseGitLogTabular(text), [
    { sha: "abc1234", date: "2026-01-01T12:00:00Z", author: "Alice", subject: "fix: foo" },
    {
      sha: "def5678",
      date: "2026-01-02T12:00:00Z",
      author: "Bob",
      subject: "refactor: bar baz",
    },
  ]);
});

test("parseGitLogTabular keeps tab characters in the subject", () => {
  const text = "abc1234\t2026-01-01\tAlice\tfix: with\ttab in subject";
  assert.deepEqual(parseGitLogTabular(text), [
    {
      sha: "abc1234",
      date: "2026-01-01",
      author: "Alice",
      subject: "fix: with\ttab in subject",
    },
  ]);
});

test("buildRelatedItemBodies truncates bodies to the configured cap", () => {
  const bodies = buildRelatedItemBodies({
    related: [
      {
        number: 99,
        kind: "issue",
        title: "Related",
        url: "https://example.test/99",
        body: "x".repeat(5000),
      },
    ],
    maxBodyBytes: 100,
  });
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].bodyExcerpt.startsWith("x".repeat(100)));
  assert.ok(bodies[0].bodyExcerpt.includes("[truncated"));
});

test("buildRelatedItemBodies drops entries with empty bodies", () => {
  const bodies = buildRelatedItemBodies({
    related: [
      { number: 1, body: "" },
      { number: 2, body: null },
      { number: 3, body: "real body" },
    ],
  });
  assert.deepEqual(
    bodies.map((b) => b.number),
    [3],
  );
});
