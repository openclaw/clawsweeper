import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withReviewRecord } from "../helpers.ts";

test("create-job ignores report front matter lookalikes in the document body", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
  const reportPath = path.join(root, "951.md");
  writeFileSync(
    reportPath,
    `---
number: 951
---

repository: attacker/forged
`,
    "utf8",
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("dist/repair/create-job.js"),
        "--from-report",
        reportPath,
        "--prompt",
        "Fix the report parser and add a regression test.",
        "--dry-run",
        "--no-check-existing",
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /^repo: openclaw\/openclaw$/m);
    assert.doesNotMatch(output, /^repo: attacker\/forged$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create-job ignores duplicate front matter keys", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
  const reportPath = path.join(root, "951.md");
  writeFileSync(
    reportPath,
    `---
repository: attacker/forged
repository: openclaw/openclaw
number: 951
---
`,
    "utf8",
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("dist/repair/create-job.js"),
        "--from-report",
        reportPath,
        "--prompt",
        "Fix the report parser and add a regression test.",
        "--dry-run",
        "--no-check-existing",
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /^repo: openclaw\/openclaw$/m);
    assert.doesNotMatch(output, /^repo: attacker\/forged$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create-job ignores metadata after an injected front matter terminator", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
  const reportPath = path.join(root, "1049.md");
  writeFileSync(
    reportPath,
    `---
fixed_release: v1
repository: attacker/forged
---
repository: openclaw/clawsweeper
number: 1049
---
`,
    "utf8",
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("dist/repair/create-job.js"),
        "--refs",
        "1049",
        "--from-report",
        reportPath,
        "--prompt",
        "Fix the report parser and add a regression test.",
        "--dry-run",
        "--no-check-existing",
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /^repo: openclaw\/openclaw$/m);
    assert.doesNotMatch(output, /^repo: attacker\/forged$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create-job preserves no-front-matter fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
  const reportPath = path.join(root, "1049.md");
  writeFileSync(reportPath, "repository: attacker/forged\nnumber: 1049\n", "utf8");

  try {
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("dist/repair/create-job.js"),
        "--refs",
        "1049",
        "--from-report",
        reportPath,
        "--prompt",
        "Fix the report parser and add a regression test.",
        "--dry-run",
        "--no-check-existing",
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /^repo: openclaw\/openclaw$/m);
    assert.doesNotMatch(output, /^repo: attacker\/forged$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const body of [
  'title: Quoted\nrepository: example/quoted\nnumber: 999\nwork_validation: ["wrong"]\n',
  '~~~yaml\n---\ntitle: Quoted\nrepository: example/quoted\nnumber: 999\nwork_validation: ["wrong"]\n---\n~~~\n',
]) {
  test(`create-job uses header values through body quotes: ${JSON.stringify(body)}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
    try {
      const reportPath = path.join(root, "321.md");
      writeFileSync(
        reportPath,
        `---\nrepository: "openclaw/clawsweeper"\nnumber: "321"\ntitle: Original\nwork_validation: ["check original"]\n---\n\n## Summary\n\n${body}`,
      );
      const output = execFileSync(
        process.execPath,
        [
          path.resolve("dist/repair/create-job.js"),
          "--from-report",
          reportPath,
          "--prompt",
          "Read original metadata.",
          "--out-dir",
          path.join(root, "jobs"),
          "--dry-run",
          "--no-check-existing",
        ],
        { encoding: "utf8" },
      );
      assert.match(output, /^repo: openclaw\/clawsweeper$/m);
      assert.match(output, /#321/);
      assert.match(output, /check original/);
      assert.doesNotMatch(output, /example\/quoted|#999|wrong/);
      assert.equal(existsSync(path.join(root, "jobs")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("create-job preserves empty-field defaults and rejects later competing records", () => {
  for (const report of [
    "---\nrepository:\nnumber:\ntitle: Original\n---\n",
    '---\nrepository: ""\nnumber: ""\n---\n',
    "---\nrepository: example/first\nnumber: 7\n---\n\nProse.\n---\nrepository: example/second\nnumber: 8\n---\n",
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
    try {
      const reportPath = path.join(root, "321.md");
      writeFileSync(reportPath, report);
      const output = execFileSync(
        process.execPath,
        [
          path.resolve("dist/repair/create-job.js"),
          "--from-report",
          reportPath,
          "--refs",
          "321",
          "--prompt",
          "Read original metadata.",
          "--dry-run",
          "--no-check-existing",
        ],
        { encoding: "utf8" },
      );
      assert.match(output, /^repo: openclaw\/openclaw$/m);
      assert.match(output, /#321/);
      assert.doesNotMatch(output, /example\/first|#7/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("create-job uses recorded work fields and rejects unreadable records", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-record-"));
  const reportPath = path.join(root, "321.md");
  const legacy = `---
repository: openclaw/openclaw
number: 321
type: issue
work_validation: ["check legacy"]
work_likely_files: ["src/legacy.ts"]
work_cluster_refs: ["#322"]
---

## ClawSweeper Work Prompt

Use the legacy prompt.
`;
  const recorded = withReviewRecord(legacy, {
    workPrompt: "Use the recorded prompt.",
    workValidation: ["check recorded"],
    workLikelyFiles: ["src/recorded.ts"],
    workClusterRefs: ["#323"],
  });
  const args = [
    path.resolve("dist/repair/create-job.js"),
    "--from-report",
    reportPath,
    "--dry-run",
    "--no-check-existing",
  ];
  try {
    for (const [markdown, expected, absent] of [
      [legacy, "legacy", "recorded"],
      [recorded, "recorded", "legacy"],
    ]) {
      writeFileSync(reportPath, markdown);
      const output = execFileSync(process.execPath, args, { encoding: "utf8" });
      assert.match(output, new RegExp(`Use the ${expected} prompt`));
      assert.match(output, new RegExp(`check ${expected}`));
      assert.match(output, new RegExp(`src/${expected}\\.ts`));
      assert.doesNotMatch(output, new RegExp(absent));
      assert.match(output, expected === "recorded" ? /#323/ : /#322/);
    }
    writeFileSync(reportPath, recorded.replace(/^review_record: \{/m, "review_record: {broken"));
    assert.throws(
      () => execFileSync(process.execPath, args, { encoding: "utf8", stdio: "pipe" }),
      /review_record/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
