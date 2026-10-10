import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withReviewRecord } from "../helpers.ts";

for (const markdown of [
  "---\nnumber: 951\n---\n\nrepository: attacker/forged\n",
  "---\nrepository: attacker/forged\nrepository: openclaw/openclaw\nnumber: 951\n---\n",
  "---\nfixed_release: v1\nrepository: attacker/forged\n---\nrepository: openclaw/clawsweeper\nnumber: 1049\n---\n",
  "repository: attacker/forged\nnumber: 1049\n",
  "---\nrepository:\nnumber:\ntitle: Original\n---\n",
  '---\nrepository: ""\nnumber: ""\n---\n',
  "---\nrepository: example/first\nnumber: 7\n---\n\nProse.\n---\nrepository: example/second\nnumber: 8\n---\n",
]) {
  test(`create-job requires a fresh review when no record exists: ${JSON.stringify(markdown)}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-create-job-"));
    const reportPath = path.join(root, "951.md");
    writeFileSync(reportPath, markdown, "utf8");
    try {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              path.resolve("dist/repair/create-job.js"),
              "--from-report",
              reportPath,
              "--refs",
              "951",
              "--prompt",
              "An explicit prompt must not authorize an unreviewed report.",
              "--dry-run",
              "--no-check-existing",
            ],
            { encoding: "utf8", stdio: "pipe" },
          ),
        /review_record: missing record/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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
        withReviewRecord(
          `---\nrepository: "openclaw/clawsweeper"\nnumber: "321"\ntype: issue\ntitle: Original\nwork_validation: ["check original"]\n---\n\n## Summary\n\n${body}`,
          { workValidation: ["check original"] },
        ),
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
    writeFileSync(reportPath, recorded);
    const output = execFileSync(process.execPath, args, { encoding: "utf8" });
    assert.match(output, /Use the recorded prompt/);
    assert.match(output, /check recorded/);
    assert.match(output, /src\/recorded\.ts/);
    assert.doesNotMatch(output, /legacy/);
    assert.match(output, /#323/);
    writeFileSync(reportPath, legacy);
    assert.throws(
      () => execFileSync(process.execPath, args, { encoding: "utf8", stdio: "pipe" }),
      /review_record: missing record/,
    );
    writeFileSync(reportPath, recorded.replace(/^review_record: \{/m, "review_record: {broken"));
    assert.throws(
      () => execFileSync(process.execPath, args, { encoding: "utf8", stdio: "pipe" }),
      /review_record/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
