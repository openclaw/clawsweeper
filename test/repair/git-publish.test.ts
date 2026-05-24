import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  commitMessageForPublishedPaths,
  publishMainCommit,
  setTokenOrigin,
  uniqueNonEmpty,
} from "../../dist/repair/git-publish.js";

for (const key of [
  "CLAWSWEEPER_STATE_DIR",
  "CLAWSWEEPER_PUBLISH_ROOT",
  "CLAWSWEEPER_PUBLISH_BRANCH",
]) {
  delete process.env[key];
}

test("uniqueNonEmpty trims, drops blanks, and deduplicates paths", () => {
  assert.deepEqual(uniqueNonEmpty([" jobs ", "", "results", "jobs", "results "]), [
    "jobs",
    "results",
  ]);
});

test("commitMessageForPublishedPaths skips CI for generated-only publishes", () => {
  assert.equal(
    commitMessageForPublishedPaths("chore: update sweep records", [
      "records",
      "assets/pr-eggs",
      "results/sweep-status",
    ]),
    "chore: update sweep records\n\n[skip ci]",
  );
  assert.equal(
    commitMessageForPublishedPaths("chore: publish\n\n[skip ci]", ["results"]),
    "chore: publish\n\n[skip ci]",
  );
  assert.equal(
    commitMessageForPublishedPaths("fix: update scheduler", ["src/repair/git-publish.ts"]),
    "fix: update scheduler",
  );
});

test("publishMainCommit commits selected paths and restores volatile tracked files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  fs.mkdirSync(path.join(work, "results"));
  fs.mkdirSync(path.join(work, "docs"));
  fs.writeFileSync(path.join(work, "results", "initial.txt"), "initial\n");
  fs.writeFileSync(path.join(work, "docs", "volatile.txt"), "before\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  fs.writeFileSync(path.join(work, "results", "ledger.txt"), "ledger\n");
  fs.writeFileSync(path.join(work, "docs", "volatile.txt"), "after\n");
  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: publish ledger",
      paths: ["results"],
      restorePaths: ["docs/volatile.txt"],
      maxAttempts: 1,
      pushAttempts: 1,
    }),
  );

  assert.equal(result, "committed");
  assert.equal(fs.readFileSync(path.join(work, "docs", "volatile.txt"), "utf8"), "before\n");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:results/ledger.txt"], root),
    "ledger\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:docs/volatile.txt"], root),
    "before\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "log", "-1", "--format=%B", "main"], root),
    "chore: publish ledger\n\n[skip ci]\n\n",
  );
});

test("publishMainCommit resolves apply record delete conflicts during rebase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "open old\n");
  write(path.join(work, "apply-report.json"), "[]\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "records/openclaw-openclaw/items/1.md"), "open remote\n");
  run("git", ["commit", "-am", "remote item update"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  fs.rmSync(path.join(work, "records/openclaw-openclaw/items/1.md"));
  write(path.join(work, "records/openclaw-openclaw/closed/1.md"), "closed\n");
  write(path.join(work, "apply-report.json"), '[{"action":"closed"}]\n');

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: apply sweep decisions checkpoint 1",
      paths: ["records", "apply-report.json"],
      maxAttempts: 1,
      pushAttempts: 1,
      rebaseStrategy: "apply-records",
    }),
  );

  assert.equal(result, "committed");
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/1.md"], root),
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/closed/1.md"], root),
    "closed\n",
  );
});

test("publishMainCommit rebuilds generated state commits after rebase conflicts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "results/sweep-status/openclaw-openclaw.json"), "{}\n");
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "record old\n");
  write(path.join(work, "keep.txt"), "keep old\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "results/sweep-status/openclaw-openclaw.json"), '{"state":"remote"}\n');
  write(path.join(other, "records/openclaw-openclaw/items/1.md"), "record remote\n");
  write(path.join(other, "records/openclaw-openclaw/items/2.md"), "remote only\n");
  write(path.join(other, "keep.txt"), "keep remote\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote generated state update"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  write(path.join(work, "results/sweep-status/openclaw-openclaw.json"), '{"state":"local"}\n');
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "record local\n");

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: update sweep records",
      paths: ["results/sweep-status", "records"],
      maxAttempts: 1,
      pushAttempts: 1,
    }),
  );

  assert.equal(result, "committed");
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "main:results/sweep-status/openclaw-openclaw.json"],
      root,
    ),
    '{"state":"local"}\n',
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/1.md"], root),
    "record local\n",
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/2.md"], root),
  );
  assert.equal(run("git", ["--git-dir", origin, "show", "main:keep.txt"], root), "keep remote\n");
});

test("publishMainCommit preserves remote-only PR egg images during publish rebuilds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "results/sweep-status/openclaw-openclaw.json"), '{"state":"base"}\n');
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "results/sweep-status/openclaw-openclaw.json"), '{"state":"remote"}\n');
  write(path.join(other, "assets/pr-eggs/openclaw-openclaw/84269.png"), "remote egg\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote generated state update"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  write(path.join(work, "results/sweep-status/openclaw-openclaw.json"), '{"state":"local"}\n');
  write(path.join(work, "assets/pr-eggs/openclaw-openclaw/84374.png"), "local egg\n");

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: update sweep records",
      paths: ["results/sweep-status", "assets/pr-eggs"],
      maxAttempts: 1,
      pushAttempts: 1,
    }),
  );

  assert.equal(result, "committed");
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "main:results/sweep-status/openclaw-openclaw.json"],
      root,
    ),
    '{"state":"local"}\n',
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "main:assets/pr-eggs/openclaw-openclaw/84269.png"],
      root,
    ),
    "remote egg\n",
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "main:assets/pr-eggs/openclaw-openclaw/84374.png"],
      root,
    ),
    "local egg\n",
  );
});

test("publishMainCommit publishes generated paths to state branch when state root is configured", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, "results/initial.txt"), "initial\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "results/ledger.txt"), "ledger\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish state ledger",
        paths: ["results"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:results/ledger.txt"], root),
    "ledger\n",
  );
  assert.throws(() => run("git", ["--git-dir", origin, "show", "main:results/ledger.txt"], root));
});

test("publishMainCommit preserves state-only automerge jobs on broad jobs publishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(
    path.join(state, "jobs/openclaw/inbox/automerge-openclaw-openclaw-75589.md"),
    "state automerge job\n",
  );
  write(path.join(state, "jobs/openclaw/inbox/ordinary.md"), "state ordinary job\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "jobs/openclaw/inbox/new.md"), "local job\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish jobs",
        paths: ["jobs"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run(
      "git",
      [
        "--git-dir",
        origin,
        "show",
        "state:jobs/openclaw/inbox/automerge-openclaw-openclaw-75589.md",
      ],
      root,
    ),
    "state automerge job\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:jobs/openclaw/inbox/new.md"], root),
    "local job\n",
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "state:jobs/openclaw/inbox/ordinary.md"], root),
  );
});

test("publishMainCommit preserves state-only PR egg images on PR egg asset publishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, "assets/pr-eggs/openclaw-openclaw/84269.png"), "old egg\n");
  write(path.join(state, "assets/pr-eggs/openclaw-openclaw/readme.txt"), "not preserved\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "assets/pr-eggs/openclaw-openclaw/84374.png"), "new egg\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish PR egg assets",
        paths: ["assets/pr-eggs"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "state:assets/pr-eggs/openclaw-openclaw/84269.png"],
      root,
    ),
    "old egg\n",
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "state:assets/pr-eggs/openclaw-openclaw/84374.png"],
      root,
    ),
    "new egg\n",
  );
  assert.throws(() =>
    run(
      "git",
      ["--git-dir", origin, "show", "state:assets/pr-eggs/openclaw-openclaw/readme.txt"],
      root,
    ),
  );
});

test("publish-main CLI accepts package-manager double dash separators", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "results/initial.txt"), "initial\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  write(path.join(work, "results/from-cli.txt"), "from cli\n");
  run(
    process.execPath,
    [
      path.resolve("dist/repair/publish-main.js"),
      "--",
      "--message",
      "chore: publish cli ledger",
      "--path",
      "results",
      "--max-attempts",
      "1",
      "--push-attempts",
      "1",
    ],
    work,
  );

  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:results/from-cli.txt"], root),
    "from cli\n",
  );
});

test("setTokenOrigin redacts tokens from command logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  run("git", ["init"], root);
  run("git", ["remote", "add", "origin", "https://github.com/openclaw/clawsweeper.git"], root);
  const lines = captureConsoleLog(() =>
    withCwd(root, () => setTokenOrigin("super-secret-token", "openclaw/clawsweeper")),
  );

  assert.equal(
    lines.some((line) => line.includes("super-secret-token")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("git remote <redacted-args>")),
    true,
  );
});

function withCwd(cwd, callback) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function withEnv(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function configureUser(cwd) {
  run("git", ["config", "user.name", "Tester"], cwd);
  run("git", ["config", "user.email", "tester@example.com"], cwd);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function captureConsoleLog(callback) {
  const original = console.log;
  const lines = [];
  console.log = (message) => {
    lines.push(String(message));
  };
  try {
    callback();
    return lines;
  } finally {
    console.log = original;
  }
}
