import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("OpenClaw Codex source setup materializes the pinned sibling for base and PR review trees", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-openclaw-codex-source-"));
  const workspace = join(root, "workspace");
  const target = join(workspace, "openclaw");
  const remote = join(root, "codex-remote");
  const cache = join(workspace, "openclaw-codex-cache.git");
  const artifacts = join(workspace, "artifacts", "event");
  const githubEnv = join(workspace, "github-env");
  const script = ".github/actions/setup-openclaw-codex-source/install.sh";

  try {
    mkdirSync(join(target, "extensions", "codex"), { recursive: true });
    writeFileSync(
      join(target, "extensions", "codex", "package.json"),
      `${JSON.stringify({ dependencies: { "@openai/codex": "1.2.3" } })}\n`,
    );
    mkdirSync(remote, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: remote });
    execFileSync("git", ["config", "user.name", "ClawSweeper test"], { cwd: remote });
    execFileSync("git", ["config", "user.email", "clawsweeper@example.invalid"], {
      cwd: remote,
    });
    writeFileSync(join(remote, "contract.rs"), 'pub const SKILL_SELECTION: &str = "path";\n');
    execFileSync("git", ["add", "contract.rs"], { cwd: remote });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: remote });
    execFileSync("git", ["tag", "rust-v1.2.3"], { cwd: remote });
    const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: remote,
      encoding: "utf8",
    }).trim();

    const result = spawnSync(
      "bash",
      [script, "OpenClaw/OpenClaw", target, artifacts, cache, remote],
      {
        cwd: process.cwd(),
        env: { ...process.env, GITHUB_ENV: githubEnv, GITHUB_WORKSPACE: workspace },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(githubEnv, "utf8"),
      /CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT=.*\/setup-openclaw-codex-source\/install\.sh/u,
    );
    const source = join(workspace, "codex");
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
      expectedHead,
    );
    assert.equal(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
      realpathSync(cache),
    );
    assert.equal(
      readFileSync(join(source, "contract.rs"), "utf8"),
      'pub const SKILL_SELECTION: &str = "path";\n',
    );
    const reviewSibling = join(artifacts, "review-trees", "codex");
    assert.equal(existsSync(reviewSibling), true);
    assert.equal(lstatSync(reviewSibling).isSymbolicLink(), true);
    assert.equal(realpathSync(reviewSibling), realpathSync(source));
    const pullRequestTree = join(artifacts, "review-trees", "131584");
    mkdirSync(pullRequestTree);
    assert.equal(
      readFileSync(join(pullRequestTree, "..", "codex", "contract.rs"), "utf8"),
      'pub const SKILL_SELECTION: &str = "path";\n',
    );

    mkdirSync(join(pullRequestTree, "extensions", "codex"), { recursive: true });
    writeFileSync(
      join(pullRequestTree, "extensions", "codex", "package.json"),
      `${JSON.stringify({ dependencies: { "@openai/codex": "2.0.0" } })}\n`,
    );
    writeFileSync(join(remote, "contract.rs"), 'pub const SKILL_SELECTION: &str = "name";\n');
    execFileSync("git", ["add", "contract.rs"], { cwd: remote });
    execFileSync("git", ["commit", "--quiet", "-m", "updated fixture"], { cwd: remote });
    execFileSync("git", ["tag", "rust-v2.0.0"], { cwd: remote });
    const updatedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: remote,
      encoding: "utf8",
    }).trim();

    const retargetResult = spawnSync(
      "bash",
      [script, "openclaw/openclaw", target, artifacts, cache, remote, pullRequestTree],
      {
        cwd: process.cwd(),
        env: { ...process.env, GITHUB_ENV: githubEnv, GITHUB_WORKSPACE: workspace },
        encoding: "utf8",
      },
    );

    assert.equal(retargetResult.status, 0, retargetResult.stderr);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
      updatedHead,
    );
    assert.equal(
      readFileSync(join(pullRequestTree, "..", "codex", "contract.rs"), "utf8"),
      'pub const SKILL_SELECTION: &str = "name";\n',
    );

    const pullRequestManifest = join(pullRequestTree, "extensions", "codex", "package.json");
    rmSync(pullRequestManifest);
    symlinkSync(join(target, "extensions", "codex", "package.json"), pullRequestManifest);
    const escapedPinResult = spawnSync(
      "bash",
      [script, "openclaw/openclaw", target, artifacts, cache, remote, pullRequestTree],
      {
        cwd: process.cwd(),
        env: { ...process.env, GITHUB_ENV: githubEnv, GITHUB_WORKSPACE: workspace },
        encoding: "utf8",
      },
    );
    assert.notEqual(escapedPinResult.status, 0);
    assert.match(escapedPinResult.stderr, /regular file|stay inside/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
