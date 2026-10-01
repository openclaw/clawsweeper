import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkChangelogFragments,
  fragmentBullet,
  planChangelogStitch,
  readChangelogFragments,
} from "../scripts/changelog-stitch.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "changelog-stitch.mjs");
const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.3.1 - Unreleased",
  "",
  "- Existing unreleased entry.",
  "",
  "- Older unreleased entry.",
  "",
  "## 0.3.0 - 2026-06-15",
  "",
  "- Released entry.",
  "",
].join("\n");

function fixture(fragments: Record<string, string>, changelog = CHANGELOG): string {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-changelog-"));
  mkdirSync(join(root, "changelog.d"));
  writeFileSync(join(root, "changelog.d", "README.md"), "# Changelog fragments\n\nRules.\n");
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  for (const [name, text] of Object.entries(fragments)) {
    writeFileSync(join(root, "changelog.d", name), text);
  }
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function pendingFragments(root: string): string[] {
  return readdirSync(join(root, "changelog.d"))
    .filter((name) => name !== "README.md")
    .sort();
}

test("fragment bullets accept exactly one house-style bullet line", () => {
  assert.deepEqual(fragmentBullet("- Fix the queue.\n"), { bullet: "- Fix the queue." });
  for (const [text, error] of [
    ["- One.\n- Two.\n", /exactly one line/],
    ["- Wrapped entry\n  continues here.\n", /exactly one line/],
    ["\n- Leading blank.\n", /exactly one line/],
    ["- Missing newline.", /exactly one newline/],
    ["- Extra newline.\n\n", /exactly one newline/],
    ["- Windows.\r\n", /LF line endings/],
    ["﻿- Marked.\n", /byte-order mark/],
    ["* Star bullet.\n", /single "- " bullet/],
    ["Plain text.\n", /single "- " bullet/],
    ["-  Double space.\n", /single "- " bullet/],
    ["- \n", /single "- " bullet/],
    ["## Heading\n", /single "- " bullet/],
    ["- Trailing space. \n", /trailing whitespace/],
  ] as const) {
    assert.match(String(fragmentBullet(text).error), error, JSON.stringify(text));
  }
});

test("fragment discovery orders by file name and reports unexpected entries", () => {
  const root = fixture({ "b-second.md": "- B.\n", "a-first.md": "- A.\n", "Upper.md": "- U.\n" });
  writeFileSync(join(root, "changelog.d", "notes.txt"), "- T.\n");
  mkdirSync(join(root, "changelog.d", "nested.md"));
  symlinkSync(join(root, "changelog.d", "a-first.md"), join(root, "changelog.d", "linked.md"));
  try {
    const { fragments, findings } = readChangelogFragments(root);
    assert.deepEqual(
      fragments.map((fragment: { file: string }) => fragment.file),
      ["changelog.d/a-first.md", "changelog.d/b-second.md"],
    );
    assert.deepEqual(
      findings.map((finding: { file: string }) => finding.file),
      [
        "changelog.d/Upper.md",
        "changelog.d/linked.md",
        "changelog.d/nested.md",
        "changelog.d/notes.txt",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stitch plans insert at the top of the Unreleased section in every layout", () => {
  const fragments = [{ file: "changelog.d/new.md", text: "- New entry.\n" }];
  const cases = [
    [CHANGELOG, "## 0.3.1 - Unreleased\n\n- New entry.\n- Existing unreleased entry.\n"],
    [
      "# Changelog\n\n## 0.4.0 - Unreleased\n\n## 0.3.0 - 2026-06-15\n\n- Released entry.\n",
      "## 0.4.0 - Unreleased\n\n- New entry.\n\n## 0.3.0 - 2026-06-15\n",
    ],
    ["# Changelog\n\n## 0.4.0 - Unreleased\n", "## 0.4.0 - Unreleased\n\n- New entry.\n"],
    ["# Changelog\n\n## 0.4.0 - Unreleased", "## 0.4.0 - Unreleased\n\n- New entry.\n"],
    [
      "# Changelog\n\n## 0.4.0 - Unreleased\n- Tight entry.\n",
      "## 0.4.0 - Unreleased\n\n- New entry.\n- Tight entry.\n",
    ],
    [
      "# Changelog\n\n## 0.4.0 - Unreleased\n\nIntro prose.\n",
      "## 0.4.0 - Unreleased\n\n- New entry.\n\nIntro prose.\n",
    ],
  ] as const;
  for (const [changelog, expected] of cases) {
    const plan = planChangelogStitch({ changelog, fragments });
    assert.deepEqual(plan.findings, []);
    assert.ok(plan.changelog.endsWith("\n"), JSON.stringify(plan.changelog));
    assert.ok(plan.changelog.includes(expected), JSON.stringify(plan.changelog));
  }
});

test("stitch folds fragments deterministically, deletes them, and is idempotent", () => {
  const first = fixture({
    "1719-zeta.md": "- Zeta entry.\n",
    "1720-alpha.md": "- Alpha entry.\n",
    "docs-beta.md": "- Beta entry.\n",
  });
  const second = fixture({
    "docs-beta.md": "- Beta entry.\n",
    "1720-alpha.md": "- Alpha entry.\n",
    "1719-zeta.md": "- Zeta entry.\n",
  });
  try {
    const stitched = run(first);
    assert.equal(stitched.status, 0, stitched.stderr);
    assert.match(stitched.stdout, /Stitched 3 fragment\(s\) into CHANGELOG\.md; removed 3\./);
    const text = readFileSync(join(first, "CHANGELOG.md"), "utf8");
    assert.ok(
      text.includes(
        "## 0.3.1 - Unreleased\n\n- Zeta entry.\n- Alpha entry.\n- Beta entry.\n- Existing unreleased entry.\n",
      ),
      text,
    );
    assert.ok(text.endsWith("## 0.3.0 - 2026-06-15\n\n- Released entry.\n"));
    assert.deepEqual(pendingFragments(first), []);
    assert.ok(existsSync(join(first, "changelog.d", "README.md")));

    const again = run(first);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /No changelog fragments to stitch\./);
    assert.equal(readFileSync(join(first, "CHANGELOG.md"), "utf8"), text);

    assert.equal(run(second).status, 0);
    assert.equal(readFileSync(join(second, "CHANGELOG.md"), "utf8"), text);
    assert.equal(run(first, "--check").status, 0);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("stitch finishes an interrupted run without duplicating entries", () => {
  const changelog = CHANGELOG.replace(
    "## 0.3.1 - Unreleased\n\n",
    "## 0.3.1 - Unreleased\n\n- Already stitched.\n",
  );
  const root = fixture(
    { "a-done.md": "- Already stitched.\n", "b-new.md": "- New entry.\n" },
    changelog,
  );
  try {
    const check = run(root, "--check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, /changelog\.d\/a-done\.md: CHANGELOG\.md already lists this entry/);

    const stitched = run(root);
    assert.equal(stitched.status, 0, stitched.stderr);
    assert.match(stitched.stdout, /Stitched 1 fragment\(s\) into CHANGELOG\.md; removed 2\./);
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.equal(text.split("- Already stitched.").length, 2);
    assert.ok(text.includes("## 0.3.1 - Unreleased\n\n- New entry.\n- Already stitched.\n"));
    assert.deepEqual(pendingFragments(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check and stitch reject malformed, stale, and duplicate fragments without writing", () => {
  const root = fixture({
    "good.md": "- Good entry.\n",
    "malformed.md": "- First line.\n- Second line.\n",
    "stale.md": "- Released entry.\n",
    "twin-a.md": "- Same entry.\n",
    "twin-b.md": "- Same entry.\n",
  });
  try {
    const check = run(root, "--check");
    assert.equal(check.status, 1);
    assert.match(check.stderr, /Changelog fragment checks failed \(3\):/);
    assert.match(check.stderr, /changelog\.d\/malformed\.md: must contain exactly one line/);
    assert.match(
      check.stderr,
      /changelog\.d\/stale\.md: re-adds an entry .* outside the Unreleased/,
    );
    assert.match(
      check.stderr,
      /changelog\.d\/twin-b\.md: duplicates the entry in changelog\.d\/twin-a\.md/,
    );

    const stitch = run(root);
    assert.equal(stitch.status, 1);
    assert.match(stitch.stderr, /Changelog stitch refused \(3\):/);
    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), CHANGELOG);
    assert.equal(pendingFragments(root).length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing Unreleased heading blocks only the stitch", () => {
  const changelog = "# Changelog\n\n## 0.3.1 - 2026-09-30\n\n- Released entry.\n";
  const root = fixture({ "next.md": "- Next entry.\n" }, changelog);
  try {
    assert.equal(run(root, "--check").status, 0);
    const stitch = run(root);
    assert.equal(stitch.status, 1);
    assert.match(stitch.stderr, /has no "## <version> - Unreleased" heading/);
    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), changelog);
    assert.deepEqual(pendingFragments(root), ["next.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const doubled = fixture(
    { "next.md": "- Next entry.\n" },
    "## 0.4.0 - Unreleased\n\n## 0.3.1 - Unreleased\n",
  );
  try {
    assert.match(run(doubled, "--check").stderr, /has 2 "## <version> - Unreleased" headings/);
  } finally {
    rmSync(doubled, { recursive: true, force: true });
  }
});

test("repository fragments pass and the static check gate runs them", () => {
  const root = join(import.meta.dirname, "..");
  assert.deepEqual(checkChangelogFragments(root).findings, []);
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["check:changelog"], "node scripts/changelog-stitch.mjs --check");
  assert.equal(scripts["changelog:stitch"], "node scripts/changelog-stitch.mjs");
  assert.match(scripts["check:static"], /\|check:changelog\|/);
});
