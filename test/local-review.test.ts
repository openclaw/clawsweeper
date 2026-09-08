import assert from "node:assert/strict";
import test from "node:test";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitMetadata,
  localReviewAdditionalPrompt,
  LOCAL_REVIEW_SCRUBBED_TOKEN_ENV,
  LOCAL_REVIEW_WEB_SEARCH_CONFIG,
} from "../dist/commit-sweeper.js";

const GIT = process.env.GIT_BIN ?? "git";
const CLI = fileURLToPath(new URL("../dist/commit-sweeper.js", import.meta.url));

test("the offline local-review CLI remains available as a package command", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.["local-review"], "node dist/commit-sweeper.js local-review");
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test Author");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "--author", "Test Author <test@example.com>", "-m", "init");
  return dir;
}

function runLocalReview(
  dir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; out: string; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "local-review", "--target-dir", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, out: `${stderr}${stdout}`, stdout, stderr };
}

for (const admission of ["clean", "invalid-output"])
  test(
    `local-review ${admission} preserves GitHub isolation without diagnostic prompt copies`,
    { skip: process.platform === "win32" },
    (t) => {
      const dir = initRepo();
      const harness = mkdtempSync(join(tmpdir(), "lr-success-"));
      const reportDir = join(harness, "reports");
      useFakeScanner(
        t,
        `
assert.equal(fs.readdirSync(${JSON.stringify(reportDir)}, {recursive: true}).some(name => String(name).endsWith('.prompt.md')), false);
${admission === "invalid-output" ? "process.exit(183);" : ""}
`,
      );
      try {
        git(dir, "branch", "local-base");
        writeFileSync(join(dir, "feature.txt"), "offline proof\n");
        git(dir, "add", "feature.txt");
        git(dir, "commit", "-q", "-m", "feat: preserve offline local review");

        const capture = join(harness, "capture.json");
        const fakeCodex = join(harness, "codex");
        writeFileSync(
          fakeCodex,
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const tokens = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "COMMIT_SWEEPER_TARGET_GH_TOKEN",
  "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
];
fs.writeFileSync(process.env.LOCAL_REVIEW_PROOF_CAPTURE, JSON.stringify({
  args,
  leakedTokens: tokens.filter((name) => Boolean(process.env[name])),
  ghConfigDir: process.env.GH_CONFIG_DIR,
  prompt: fs.readFileSync(0, "utf8"),
}));
fs.writeFileSync(output, "---\\nresult: success\\n---\\n\\nOffline local review completed.\\n");
`,
        );
        chmodSync(fakeCodex, 0o755);

        const result = runLocalReview(
          dir,
          [
            "--target-repo",
            "openclaw/clawsweeper",
            "--base",
            "local-base",
            "--report-dir",
            reportDir,
          ],
          {
            CODEX_BIN: fakeCodex,
            LOCAL_REVIEW_PROOF_CAPTURE: capture,
            GH_TOKEN: "must-not-reach-reviewer",
            GITHUB_TOKEN: "must-not-reach-reviewer",
            GH_ENTERPRISE_TOKEN: "must-not-reach-reviewer",
            GITHUB_ENTERPRISE_TOKEN: "must-not-reach-reviewer",
          },
        );

        assert.equal(
          readdirSync(reportDir, { recursive: true }).some((name) =>
            String(name).endsWith(".prompt.md"),
          ),
          false,
        );
        if (admission === "invalid-output") {
          assert.equal(result.status, 1, result.out);
          assert.match(result.out, /Agent input scan refused: scanner_failed/);
          assert.equal(existsSync(capture), false);
          return;
        }
        assert.equal(result.status, 0, result.out);
        const recorded = JSON.parse(readFileSync(capture, "utf8")) as {
          args: string[];
          leakedTokens: string[];
          ghConfigDir: string;
          prompt: string;
        };
        assert.deepEqual(recorded.leakedTokens, []);
        assert.ok(existsSync(recorded.ghConfigDir));
        assert.ok(recorded.args.includes('web_search="disabled"'));
        const sandboxIndex = recorded.args.indexOf("--sandbox");
        assert.equal(recorded.args[sandboxIndex + 1], "read-only");
        assert.match(recorded.prompt, /do not run gh/i);
        assert.match(recorded.prompt, /do not .*network request/i);
        assert.match(result.out, /local-review\.md/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(harness, { recursive: true, force: true });
      }
    },
  );

// The local-review offline contract: commitMetadata(..., offline=true) must read
// only local git and never shell out to `gh`. Using an UNSUPPORTED repo slug proves
// it: a real gh api call against "example/unsupported-repo" would fail, so a passing
// run with populated local fields confirms gh was never invoked.
test("commitMetadata offline mode uses only local git and never contacts GitHub", () => {
  const dir = initRepo();
  try {
    const sha = git(dir, "rev-parse", "HEAD");
    const meta = commitMetadata(dir, "example/unsupported-repo", sha, true);

    assert.equal(meta.githubAuthor, "");
    assert.equal(meta.githubCommitter, "");
    assert.equal(meta.sha, sha);
    assert.equal(meta.authorName, "Test Author");
    assert.equal(meta.authorEmail, "test@example.com");
    assert.equal(meta.subject, "init");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "local-review default returns text or JSON and removes its private run output",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = initRepo();
    const harness = mkdtempSync(join(tmpdir(), "lr-transient-"));
    useFakeScanner(t);
    try {
      git(dir, "branch", "local-base");
      git(dir, "commit", "-q", "--allow-empty", "-m", "test: empty local review");
      const fakeCodex = join(harness, "codex");
      writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.LOCAL_REVIEW_PROOF_CAPTURE, process.env.GH_CONFIG_DIR);
fs.writeFileSync(
  args[args.indexOf("--output-last-message") + 1],
  "---\\nresult: success\\n---\\n\\nTransient local review completed.\\n",
);
`,
      );
      chmodSync(fakeCodex, 0o755);

      for (const format of ["text", "json"] as const) {
        const capture = join(harness, `${format}.txt`);
        const result = runLocalReview(
          dir,
          [
            "--target-repo",
            "openclaw/clawsweeper",
            "--base",
            "local-base",
            "--result-format",
            format,
          ],
          {
            CODEX_BIN: fakeCodex,
            LOCAL_REVIEW_PROOF_CAPTURE: capture,
          },
        );
        assert.equal(result.status, 0, result.out);
        const ghConfigDir = readFileSync(capture, "utf8");
        assert.equal(existsSync(ghConfigDir), false);
        assert.doesNotMatch(result.stderr, /clawsweeper-local-review-/);
        if (format === "json") {
          const output = JSON.parse(result.stdout);
          assert.equal(output.status, "completed");
          assert.equal(output.retention, "none");
          assert.equal(output.reports[0].artifact_path, null);
          assert.match(output.reports[0].report, /Transient local review completed/);
        } else {
          assert.match(result.stdout, /Transient local review completed/);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(harness, { recursive: true, force: true });
    }
  },
);

test(
  "local-review summary failure removes its owned output and returns one JSON envelope",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = initRepo();
    const harness = mkdtempSync(join(tmpdir(), "lr-summary-failure-"));
    const reportDir = join(harness, "reports");
    useFakeScanner(t);
    try {
      git(dir, "branch", "local-base");
      git(dir, "commit", "-q", "--allow-empty", "-m", "test: oversized review output");
      const fakeCodex = join(harness, "codex");
      writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, "");
fs.truncateSync(output, 4 * 1024 * 1024 + 1);
`,
        { mode: 0o755 },
      );

      const result = runLocalReview(
        dir,
        [
          "--target-repo",
          "openclaw/clawsweeper",
          "--base",
          "local-base",
          "--output-retention",
          "summary",
          "--report-dir",
          reportDir,
          "--result-format",
          "json",
        ],
        { CODEX_BIN: fakeCodex },
      );

      assert.equal(result.status, 1, result.out);
      assert.deepEqual(JSON.parse(result.stdout), {
        status: "failed",
        retention: "summary",
        reports: [],
        error: {
          message: "Review result output exceeded its 4194304-byte limit.",
        },
      });
      assert.deepEqual(readdirSync(reportDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(harness, { recursive: true, force: true });
    }
  },
);

test("local-review refuses a dirty working tree", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "dirty.txt"), "x\n"); // untracked -> dirty
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /working tree not clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review JSON preflight failure leaves no scratch or receipt directory", () => {
  const dir = initRepo();
  const scratch = mkdtempSync(join(tmpdir(), "lr-failure-scratch-"));
  try {
    writeFileSync(join(dir, "dirty.txt"), "x\n");
    const result = runLocalReview(
      dir,
      ["--target-repo", "openclaw/clawsweeper", "--base", "HEAD", "--result-format", "json"],
      { TMPDIR: scratch },
    );
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "failed",
      retention: "none",
      reports: [],
      error: {
        message: "[local-review] working tree not clean — commit or stash first:\n?? dirty.txt",
      },
    });
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("local-review rejects an unsupported repository instead of a foreign-profile fallback", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "nobody/not-a-real-profile",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no review profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review rejects repositories covered only by a generic owner fallback", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/example-tool",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no review profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review reports nothing to review when HEAD has no commits beyond base", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no commits on HEAD beyond/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review scrubs both GitHub and GitHub Enterprise token aliases", () => {
  for (const v of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "COMMIT_SWEEPER_TARGET_GH_TOKEN",
    "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
  ]) {
    assert.ok(
      LOCAL_REVIEW_SCRUBBED_TOKEN_ENV.includes(v),
      `${v} must be in the offline scrub list`,
    );
  }
});

test("local-review disables web search and forbids network lookups in its prompt", () => {
  assert.equal(LOCAL_REVIEW_WEB_SEARCH_CONFIG, 'web_search="disabled"');
  const prompt = localReviewAdditionalPrompt("a".repeat(40), "b".repeat(40), "main");
  assert.match(prompt, /do not run gh/i);
  assert.match(prompt, /do not .*web search/i);
  assert.match(prompt, /do not .*network request/i);
  assert.match(prompt, /only the local checkout and git history/i);
});
