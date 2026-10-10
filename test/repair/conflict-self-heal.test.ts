import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { selfHealJobPath } from "../../dist/repair/conflict-self-heal-core.js";
import { mockGhBinEnv } from "../helpers.ts";

const repo = "openclaw/openclaw";
const headSha = "a".repeat(40);

// A worker hydrates its self-heal job from published state, so the job must be on the state
// remote before any worker is dispatched.
test("conflict self-heal dispatches a worker only after its job is on the state remote", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-self-heal-")));
  const runtime = path.join(root, "runtime");
  const remote = path.join(root, "state.git");
  const seed = path.join(root, "seed");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const dispatched = path.join(root, "dispatched");
  const jobPath = selfHealJobPath(repo, 42);
  try {
    // The script writes jobs and reports under its own repository root, so run a copy.
    for (const entry of ["dist", "config", "package.json"]) {
      fs.cpSync(entry, path.join(runtime, entry), { recursive: true });
    }
    fs.symlinkSync(path.resolve("node_modules"), path.join(runtime, "node_modules"), "dir");

    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["clone", remote, seed]);
    fs.writeFileSync(path.join(seed, "README.md"), "state\n");
    const identity = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
    execFileSync("git", ["add", "README.md"], { cwd: seed });
    execFileSync("git", [...identity, "commit", "-m", "seed"], { cwd: seed });
    execFileSync("git", ["push", "origin", "HEAD:state"], { cwd: seed });
    execFileSync("git", ["clone", "--branch", "state", remote, state]);

    const pull = {
      number: 42,
      title: "fix: repair conflict",
      url: `https://github.com/${repo}/pull/42`,
      author: { __typename: "App", login: "clawsweeper" },
      baseRefName: "main",
      headRefName: "clawsweeper/repair-42",
      headRefOid: headSha,
      headRepository: { nameWithOwner: repo },
      isDraft: false,
      labels: [],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      state: "OPEN",
    };
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/usr/bin/env node",
        "const { execFileSync } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const pull = JSON.parse(process.env.FAKE_PULL);",
        "const print = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };",
        "if (args[0] === 'search' && args[1] === 'prs') print([pull]);",
        "if (args[0] === 'pr' && args[1] === 'view') print(pull);",
        "if (args[0] === 'api' && args.some((arg) => arg.includes('/actions/workflows/'))) print([]);",
        "if (args[0] === 'api' && args.includes('--paginate')) print([[]]);",
        "if (args[0] === 'api' && args.includes('--input')) print({ id: 1 });",
        "if (args[0] === 'workflow' && args[1] === 'run') {",
        "  try {",
        "    execFileSync('git', ['--git-dir', process.env.FAKE_STATE_REMOTE, 'cat-file', '-e', `state:${process.env.FAKE_JOB_PATH}`], { stdio: 'ignore' });",
        "  } catch {",
        "    process.stderr.write('worker dispatched before its job was published\\n');",
        "    process.exit(1);",
        "  }",
        "  fs.writeFileSync(process.env.FAKE_DISPATCHED, args.join(' '));",
        "  process.exit(0);",
        "}",
        "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
        "process.exit(2);",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(runtime, "dist/repair/conflict-self-heal.js"),
        "--repo",
        repo,
        "--repair-repo",
        "openclaw/clawsweeper",
        "--execute",
      ],
      {
        cwd: runtime,
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(path.join(bin, "gh"), bin),
          CLAWSWEEPER_ALLOW_EXECUTE: "1",
          CLAWSWEEPER_ALLOW_FIX_PR: "1",
          CLAWSWEEPER_DISPATCH_RECHECK_MS: "0",
          CLAWSWEEPER_STATE_DIR: state,
          CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "",
          CLAWSWEEPER_PUBLISH_BRANCH: "",
          FAKE_PULL: JSON.stringify(pull),
          FAKE_STATE_REMOTE: remote,
          FAKE_JOB_PATH: jobPath,
          FAKE_DISPATCHED: dispatched,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(dispatched, "utf8"), new RegExp(`job=${jobPath}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
