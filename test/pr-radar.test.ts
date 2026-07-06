import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { main } from "../dist/pr-radar.js";
import { tmpPrefix, withMockGh } from "./helpers.ts";

const happyPathMock = `
const args = process.argv.slice(2);
const apiIndex = args.lastIndexOf("api");
const path = args[apiIndex + 1] || "";
const pulls = [
  {
    number: 101,
    title: "fix: gateway reconnect",
    html_url: "https://github.com/openclaw/openclaw/pull/101",
    draft: false,
    user: { login: "alice" },
    base: { ref: "main" },
    head: { sha: "headsha101" },
  },
  {
    number: 102,
    title: "refactor: gateway session",
    html_url: "https://github.com/openclaw/openclaw/pull/102",
    draft: true,
    user: { login: "bob" },
    base: { ref: "main" },
    head: { sha: "headsha102" },
  },
  {
    number: 103,
    title: "docs: gateway guide",
    html_url: "https://github.com/openclaw/openclaw/pull/103",
    draft: false,
    user: { login: "carol" },
    base: { ref: "main" },
    head: { sha: "headsha103" },
  },
];
if (apiIndex === -1) {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
if (path.startsWith("repos/openclaw/openclaw/pulls?")) {
  console.log(JSON.stringify(path.includes("page=1") ? pulls : []));
} else if (path.startsWith("repos/openclaw/openclaw/pulls/101/files")) {
  console.log(JSON.stringify([
    { filename: "src/gateway/session.ts", status: "modified", patch: "@@ -140,20 +140,25 @@" },
  ]));
} else if (path.startsWith("repos/openclaw/openclaw/pulls/102/files")) {
  console.log(JSON.stringify([
    { filename: "src/gateway/session.ts", status: "modified", patch: "@@ -150,10 +150,12 @@" },
  ]));
} else if (path.startsWith("repos/openclaw/openclaw/pulls/103/files")) {
  console.log(JSON.stringify([
    { filename: "docs/gateway.md", status: "modified", patch: "@@ -1,5 +1,9 @@" },
  ]));
} else {
  console.error("unexpected gh path", path);
  process.exit(1);
}
`;

test("pr-radar scan writes a schema-shaped report for interfering pull requests", async () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const outDir = join(root, "out");
    await withMockGh(root, happyPathMock, () =>
      main(["scan", "--target-repo", "openclaw/openclaw", "--out-dir", outDir]),
    );
    const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(report.schema_version, 1);
    assert.equal(report.target_repo, "openclaw/openclaw");
    assert.equal(report.prs_scanned, 3);
    assert.deepEqual(report.truncated, { prs: false, pairs: false });
    assert.equal(report.pairs.length, 1);
    const pair = report.pairs[0];
    assert.equal(pair.pr_a.number, 101);
    assert.equal(pair.pr_a.head_sha, "headsha101");
    assert.equal(pair.pr_b.number, 102);
    assert.equal(pair.pr_b.draft, true);
    assert.equal(pair.severity, "lines");
    assert.deepEqual(pair.files, [
      {
        base_path: "src/gateway/session.ts",
        severity: "lines",
        overlapping_lines: [[150, 159]],
      },
    ]);
    const markdown = readFileSync(join(outDir, "report.md"), "utf8");
    assert.match(markdown, /\[#101\].* and \[#102\].*\(draft\)/);
    assert.match(markdown, /150-159/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const truncatedFilesMock = `
const args = process.argv.slice(2);
const apiIndex = args.lastIndexOf("api");
const path = args[apiIndex + 1] || "";
const pulls = [
  {
    number: 7,
    title: "wide refactor",
    html_url: "https://github.com/openclaw/openclaw/pull/7",
    draft: false,
    user: { login: "alice" },
    base: { ref: "main" },
    head: { sha: "headsha7" },
  },
  {
    number: 8,
    title: "small fix",
    html_url: "https://github.com/openclaw/openclaw/pull/8",
    draft: false,
    user: { login: "bob" },
    base: { ref: "main" },
    head: { sha: "headsha8" },
  },
];
if (path.startsWith("repos/openclaw/openclaw/pulls?")) {
  console.log(JSON.stringify(path.includes("page=1") ? pulls : []));
} else if (path.startsWith("repos/openclaw/openclaw/pulls/7/files")) {
  const files = Array.from({ length: 100 }, (_, index) => ({
    filename: "src/file-" + index + ".ts",
    status: "modified",
    patch: "@@ -1,2 +1,2 @@",
  }));
  files[0] = { filename: "src/shared.ts", status: "modified", patch: "@@ -5,36 +5,36 @@" };
  console.log(JSON.stringify(files));
} else if (path.startsWith("repos/openclaw/openclaw/pulls/8/files")) {
  console.log(JSON.stringify([
    { filename: "src/shared.ts", status: "modified", patch: "@@ -10,3 +10,3 @@" },
  ]));
} else {
  console.error("unexpected gh path", path);
  process.exit(1);
}
`;

test("pr-radar scan withholds containment when a file page cap truncates a pull request", async () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const outDir = join(root, "out");
    await withMockGh(root, truncatedFilesMock, () =>
      main([
        "scan",
        "--target-repo",
        "openclaw/openclaw",
        "--out-dir",
        outDir,
        "--max-file-pages",
        "1",
      ]),
    );
    const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].severity, "lines");
    assert.equal(report.pairs[0].containment, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const emptyRepoMock = `
const args = process.argv.slice(2);
const apiIndex = args.lastIndexOf("api");
const path = args[apiIndex + 1] || "";
if (path.startsWith("repos/openclaw/openclaw/pulls?")) {
  console.log("[]");
} else {
  console.error("unexpected gh path", path);
  process.exit(1);
}
`;

test("pr-radar scan renders the empty state for a repository without open pull requests", async () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const outDir = join(root, "out");
    await withMockGh(root, emptyRepoMock, () =>
      main(["scan", "--target-repo", "openclaw/openclaw", "--out-dir", outDir]),
    );
    const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(report.prs_scanned, 0);
    assert.deepEqual(report.pairs, []);
    assert.match(
      readFileSync(join(outDir, "report.md"), "utf8"),
      /No interfering open pull request pairs found\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const failingMock = `
console.error("boom: repository unavailable");
process.exit(1);
`;

test("pr-radar scan rejects on non-retryable gh failures", async () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const pending = withMockGh(root, failingMock, () =>
      main(["scan", "--target-repo", "openclaw/openclaw", "--out-dir", join(root, "out")]),
    );
    await assert.rejects(pending, /boom: repository unavailable|Command failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pr-radar rejects invalid target repositories and unknown commands", async () => {
  await assert.rejects(main(["scan", "--target-repo", "not-a-repo"]), /owner\/repo/);
  await assert.rejects(main(["frobnicate"]), /Unknown command/);
});

test("pr-radar rejects non-positive and fractional scan limits", async () => {
  await assert.rejects(main(["scan", "--max-prs", "0"]), /--max-prs must be a positive integer/);
  await assert.rejects(
    main(["scan", "--max-file-pages", "0"]),
    /--max-file-pages must be a positive integer/,
  );
  await assert.rejects(
    main(["scan", "--max-pairs", "1.5"]),
    /--max-pairs must be a positive integer/,
  );
});
