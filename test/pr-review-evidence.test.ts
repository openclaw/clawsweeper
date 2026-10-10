import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPullRequestReviewEvidence,
  readReviewGit,
  reviewRecord,
} from "../dist/pr-review-evidence.js";

test("review evidence retains pinned identities on array-backed records", () => {
  const sha = "a".repeat(40);
  const pullRequest = Object.assign([], {
    base: Object.assign([], { sha }),
    head: Object.assign([], { sha }),
  });
  const evidence = buildPullRequestReviewEvidence({ context: { pullRequest }, mainSha: sha });
  assert.equal(evidence.baseSha, sha);
  assert.equal(evidence.originalHead.sha, sha);
});

test("reviewRecord does not read accessors, while review callers preserve their errors", () => {
  const value = Object.defineProperty({}, "base", {
    get() {
      throw new TypeError("fixture base access");
    },
  });
  assert.equal(reviewRecord(value), value);
  assert.throws(
    () => buildPullRequestReviewEvidence({ context: { pullRequest: value }, mainSha: "" }),
    { name: "TypeError", message: "fixture base access" },
  );
});

test("readReviewGit keeps raw reads isolated with a Git-compatible null device", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-git-"));
  const repo = join(root, "repo");
  const malformedGlobalConfig = join(root, "malformed-global.gitconfig");
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
    writeFileSync(malformedGlobalConfig, "[broken\n");
    process.env.GIT_CONFIG_GLOBAL = malformedGlobalConfig;

    const output = readReviewGit(repo, ["rev-parse", "--is-inside-work-tree"]);

    assert.equal(output?.toString("utf8").trim(), "true");
    assert.equal(process.env.GIT_CONFIG_GLOBAL, malformedGlobalConfig);
  } finally {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "readReviewGit enforces explicit deadlines and supports an explicit no-deadline read",
  { skip: process.platform === "win32" ? "POSIX executable fixture" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-git-deadline-"));
    const executable = join(root, "delayed-git");
    try {
      writeFileSync(
        executable,
        `#!${process.execPath}\nsetTimeout(() => process.stdout.write("ready\\n"), 250);\n`,
        { mode: 0o755 },
      );
      assert.equal(readReviewGit(root, [], { executable, deadlineAt: Date.now() - 1 }), null);
      assert.equal(readReviewGit(root, [], { executable, deadlineAt: Date.now() + 50 }), null);
      assert.equal(readReviewGit(root, [], { executable })?.toString("utf8"), "ready\n");
      assert.equal(
        readReviewGit(root, [], { executable, deadlineAt: null })?.toString("utf8"),
        "ready\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "readReviewGit budgets stdout independently from ignored diagnostics",
  { skip: process.platform === "win32" ? "POSIX executable fixture" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-git-budget-"));
    const executable = join(root, "bounded-git");
    try {
      writeFileSync(
        executable,
        `#!${process.execPath}
process.stdout.write("x".repeat(Number(process.env.TEST_STDOUT_BYTES)));
process.stderr.write("diagnostic".repeat(16));
process.exitCode = Number(process.env.TEST_EXIT_STATUS);
`,
        { mode: 0o755 },
      );
      const run = (stdoutBytes: number, exitStatus: number) =>
        readReviewGit(root, [], {
          executable,
          maxBytes: 19,
          objectEnv: {
            TEST_STDOUT_BYTES: String(stdoutBytes),
            TEST_EXIT_STATUS: String(exitStatus),
          },
        });

      assert.equal(run(19, 0)?.toString("utf8"), "x".repeat(19));
      assert.equal(run(20, 0), null);
      assert.equal(run(19, 7), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
