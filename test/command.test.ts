import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultReviewArtifactDirForTest,
  exactEventReviewLeaseDispositionForTest,
  prepareManagedLocalReviewCheckoutForTest,
  reviewLeaseStillMatchesContextForTest,
} from "../dist/clawsweeper.js";
import { runText, UserFacingCommandError } from "../dist/command.js";
import { mockGhBinEnv } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));

test("runText explains missing working directories", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const missing = join(root, "missing");
  try {
    assert.throws(
      () => runText(process.execPath, ["--version"], { cwd: missing }),
      (error: unknown) => {
        assert.ok(error instanceof UserFacingCommandError);
        assert.match(
          error.message,
          /Working directory not found while running .*: .*missing.*Check --target-dir/,
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runText explains missing executables", () => {
  assert.throws(
    () => runText("clawsweeper-missing-command-for-test", [], { env: { PATH: "" } }),
    (error: unknown) => {
      assert.ok(error instanceof UserFacingCommandError);
      assert.match(
        error.message,
        /Command not found while running clawsweeper-missing-command-for-test/,
      );
      return true;
    },
  );
});

test("review CLI suppresses stack traces for missing local target checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const missing = join(root, "missing-target");
  const artifactDir = join(root, "artifacts");
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-repo",
        "openclaw/openclaw",
        "--target-dir",
        missing,
        "--item-number",
        "357",
        "--artifact-dir",
        artifactDir,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error: Working directory not found while running git:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local exact reviews default to item-specific artifacts", () => {
  assert.equal(defaultReviewArtifactDirForTest(true, 357, undefined), "artifacts/local-review-357");
  assert.equal(defaultReviewArtifactDirForTest(true, 357, [357]), "artifacts/reviews");
  assert.equal(defaultReviewArtifactDirForTest(false, 357, undefined), "artifacts/reviews");
});

test("exact event publication requeues legacy tuples and source drift before mutation", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const base = `---\nitem_source_revision: ${revision}\n---\n`;
  assert.deepEqual(exactEventReviewLeaseDispositionForTest(base, revision), {
    status: "legacy_tupleless",
    reason: "local report has no durable lease identity",
  });
  assert.deepEqual(exactEventReviewLeaseDispositionForTest(base, "f".repeat(40)), {
    status: "source_drift",
    reportRevision: revision,
    liveRevision: "f".repeat(40),
  });
  assert.deepEqual(
    exactEventReviewLeaseDispositionForTest(
      `---\nitem_source_revision: ${revision}\nreview_lease_owner: run-123\nreview_lease_comment_id: 99\n---\n`,
      revision,
    ),
    { status: "current" },
  );
});

test("reserved exact-review leases compare a head only for pull requests", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(reviewLeaseStillMatchesContextForTest("issue", null, revision), true);
  assert.equal(reviewLeaseStillMatchesContextForTest("pull_request", revision, revision), true);
  assert.equal(
    reviewLeaseStillMatchesContextForTest("pull_request", "f".repeat(40), revision),
    false,
  );
});

test("reserve-review-lease creates and confirms a durable pre-review tuple", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-reserve-lease-"));
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh.js");
  const leasePath = join(root, "lease.json");
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      ghPath,
      `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const leasePath = ${JSON.stringify(leasePath)};
const headSha = ${JSON.stringify(headSha)};
const args = process.argv.slice(2);
const path = args[1] || "";
const comments = () => existsSync(leasePath) ? [JSON.parse(readFileSync(leasePath, "utf8"))] : [];
if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Reserve durable exact review lease",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/pulls/357") {
  console.log(JSON.stringify({ head: { sha: headSha } }));
} else if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/issues/357/comments") && !args.includes("--method")) {
  const value = comments();
  console.log(JSON.stringify(args.includes("--slurp") ? [value] : value));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/357/comments" && args.includes("--method")) {
  const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8")).body;
  const lease = {
    id: 9991,
    html_url: "https://github.com/openclaw/openclaw/pull/357#issuecomment-9991",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body
  };
  writeFileSync(leasePath, JSON.stringify(lease));
  console.log(JSON.stringify(lease));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "reserve-review-lease",
        "--target-repo",
        "openclaw/openclaw",
        "--item-number",
        "357",
        "--review-timeout-ms",
        "600000",
      ],
      { encoding: "utf8", env: { ...process.env, ...mockGhBinEnv(ghPath) } },
    );

    assert.equal(result.status, 0, result.stderr);
    const reservation = JSON.parse(result.stdout);
    assert.equal(reservation.status, "posted");
    assert.match(reservation.owner, /^[a-zA-Z0-9._-]{1,200}$/);
    assert.equal(reservation.commentId, 9991);
    assert.equal(reservation.headSha, headSha);
    const lease = JSON.parse(readFileSync(leasePath, "utf8"));
    assert.match(lease.body, /clawsweeper-review-status:started/);
    assert.match(lease.body, /clawsweeper-review-lease item=357/);
    assert.match(lease.body, new RegExp(`sha=${headSha}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed local review checkout fetches the pull request ref", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const targetDir = join(root, "artifacts", "local-review-357", "target");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["init", source], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.com"], { cwd: source });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: source });
    writeFileSync(join(source, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: source });
    execFileSync("git", ["commit", "-m", "base"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: source });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: source });
    execFileSync("git", ["push", "origin", "main"], { cwd: source, stdio: "ignore" });

    writeFileSync(join(source, "feature.txt"), "from pr\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: source, stdio: "ignore" });
    const pullSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["push", "origin", "HEAD:refs/pull/357/head"], {
      cwd: source,
      stdio: "ignore",
    });

    prepareManagedLocalReviewCheckoutForTest({
      baseBranch: "main",
      cloneUrl: origin,
      itemNumber: 357,
      targetDir,
      targetRepo: "openclaw/openclaw",
    });

    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: targetDir,
        encoding: "utf8",
      }).trim(),
      "clawsweeper/pr-357",
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetDir, encoding: "utf8" }).trim(),
      pullSha,
    );
    assert.ok(existsSync(join(targetDir, "feature.txt")));
    assert.equal(normalizeLf(readFileSync(join(targetDir, "feature.txt"), "utf8")), "from pr\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local exact review explains when GitHub item is not open", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const origin = join(root, "origin.git");
  const targetDir = join(root, "target");
  const artifactDir = join(root, "artifacts");
  const binDir = join(root, "bin");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["init", targetDir], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.com"], { cwd: targetDir });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: targetDir });
    writeFileSync(join(targetDir, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: targetDir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: targetDir, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: targetDir });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: targetDir });
    execFileSync("git", ["push", "origin", "main"], { cwd: targetDir, stdio: "ignore" });

    mkdirSync(binDir);
    const ghPath = join(binDir, "gh.js");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/issues/357") {
  console.log(JSON.stringify({
    number: 357,
    title: "Closed local review test",
    html_url: "https://github.com/openclaw/openclaw/pull/357",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: "2026-01-03T00:00:00Z",
    state: "closed",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "author" },
    labels: [],
    pull_request: {}
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/pulls/357") {
  process.exit(1);
}
if (args[0] === "release" && args[1] === "view") {
  process.exit(1);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`,
    );
    chmodSync(ghPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-dir",
        targetDir,
        "--item-number",
        "357",
        "--artifact-dir",
        artifactDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath),
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local ClawSweeper review for openclaw\/openclaw#357/);
    assert.match(result.stderr, /Preparing target checkout/);
    assert.match(result.stderr, /mode: supplied checkout/);
    assert.match(result.stderr, /Loading review item/);
    assert.match(result.stderr, /Error: No review was run for openclaw\/openclaw#357/);
    assert.match(result.stderr, /GitHub reports this PR is closed/);
    assert.doesNotMatch(result.stderr, /selected=0/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local exact review selects PATH Codex instead of the Desktop app binary", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-"));
  const origin = join(root, "origin.git");
  const targetDir = join(root, "target");
  const artifactDir = join(root, "artifacts");
  const binDir = join(root, "bin");
  const localAppData = join(root, "local-app-data");
  const codexMarker = join(root, "path-codex-ran.txt");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    execFileSync("git", ["init", targetDir], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.com"], { cwd: targetDir });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: targetDir });
    writeFileSync(join(targetDir, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: targetDir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: targetDir, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: targetDir });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: targetDir });
    execFileSync("git", ["push", "origin", "main"], { cwd: targetDir, stdio: "ignore" });

    mkdirSync(binDir);
    const ghPath = join(binDir, "gh.js");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const issue = {
  number: 96221,
  title: "Open local review test",
  html_url: "https://github.com/openclaw/openclaw/pull/96221",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  state: "open",
  locked: false,
  active_lock_reason: null,
  author_association: "CONTRIBUTOR",
  comments: 0,
  user: { login: "author" },
  labels: [],
  pull_request: {}
};
const pull = {
  number: 96221,
  title: issue.title,
  html_url: issue.html_url,
  state: "open",
  draft: false,
  merged: false,
  merge_commit_sha: "abc123",
  mergeable: true,
  mergeable_state: "clean",
  user: { login: "author" },
  head: { ref: "feature", sha: "def456" },
  base: { ref: "main", sha: "abc123" },
  additions: 1,
  deletions: 0,
  changed_files: 0,
  commits: 0,
  review_comments: 0,
  created_at: issue.created_at,
  updated_at: issue.updated_at,
  body: "body"
};
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/issues/96221") {
  console.log(JSON.stringify(issue));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/pulls/96221") {
  console.log(JSON.stringify(pull));
  process.exit(0);
}
if (
  args[0] === "api" &&
  (
    args[1].startsWith("repos/openclaw/openclaw/pulls/96221/reviews") ||
    args[1].startsWith("repos/openclaw/openclaw/pulls/96221/comments")
  )
) {
  console.log(JSON.stringify([[]]));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-i" && args[2].startsWith("repos/openclaw/openclaw/issues/96221/timeline")) {
  process.stdout.write("HTTP/2 200\\nlink: <https://api.github.test?page=1>; rel=\\"last\\"\\n\\n[]");
  process.exit(0);
}
if (args[0] === "release" && args[1] === "view") {
  process.exit(1);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`,
    );
    chmodSync(ghPath, 0o755);

    const codexPath = join(binDir, "codex");
    const desktopCodexDir = join(localAppData, "OpenAI", "Codex", "bin");
    mkdirSync(desktopCodexDir, { recursive: true });
    writeFileSync(join(desktopCodexDir, "codex.exe"), "");
    writeFileSync(
      codexPath,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(codexMarker)}, "path\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(1));
`,
    );
    chmodSync(codexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--local-only",
        "--target-dir",
        targetDir,
        "--item-number",
        "96221",
        "--artifact-dir",
        artifactDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOCALAPPDATA: localAppData,
          ...mockGhBinEnv(ghPath),
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Running Codex review/);
    assert.match(result.stderr, /timeout: /);
    assert.match(result.stderr, /stdout: .*96221\.1\.codex\.stdout\.log/);
    assert.match(result.stderr, /stderr: .*96221\.1\.codex\.stderr\.log/);
    assert.match(result.stderr, /Codex review failed/);
    assert.match(result.stderr, /report: .*96221\.md/);
    assert.match(result.stderr, /Error: Codex failed for 1 item/);
    assert.match(result.stderr, /Reports?: .*96221\.md/);
    assert.doesNotMatch(result.stderr, /Review complete/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.match(readFileSync(join(artifactDir, "96221.md"), "utf8"), /review_status: failed/);
    assert.equal(readFileSync(codexMarker, "utf8"), "path\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function normalizeLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
