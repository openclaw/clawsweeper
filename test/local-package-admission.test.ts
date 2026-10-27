import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/local-package-admission.mjs");
const repository = "example/automation";
const initialPaths = [
  ".github/workflows/audit.yml",
  ".github/workflows/sweep.yml",
  ".github/workflows/failed-review-retry.yml",
  "test/node-build-workflows.test.ts",
  "changelog.d/old-fragment.md",
  "src/runtime.ts",
];

function fixture(change: (root: string) => void, advanceBase?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "package-admission-"));
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  const origin = join(root, "origin.git");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  mkdirSync(source);
  mkdirSync(checkout);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "core.hooksPath", "/dev/null");
  for (const path of initialPaths) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), "base\n");
  }
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  let base = git(source, "rev-parse", "HEAD");
  change(source);
  git(source, "add", "-A");
  git(source, "commit", "--allow-empty", "-m", "head");
  const head = git(source, "rev-parse", "HEAD");
  let tree = git(source, "rev-parse", "HEAD^{tree}");
  if (advanceBase) {
    git(source, "checkout", "--detach", base);
    advanceBase(source);
    git(source, "add", "-A");
    git(source, "commit", "-m", "advance base");
    base = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "--detach", head);
    git(source, "merge", "--no-ff", "--no-commit", base);
    tree = git(source, "write-tree");
  }
  const merge = git(source, "commit-tree", tree, "-p", base, "-p", head, "-m", "merge");
  git(source, "init", "--bare", origin);
  git(source, "push", origin, `${merge}:refs/pull/7/merge`);
  git(checkout, "init");
  git(checkout, "fetch", "--depth=2", `file://${origin}`, `+${merge}:refs/remotes/pull/7/merge`);
  git(checkout, "checkout", "--detach", merge);
  assert.equal(git(checkout, "rev-parse", "--is-shallow-repository"), "true");
  const event = {
    number: 7,
    repository: { full_name: repository },
    pull_request: {
      base: { sha: base, repo: { full_name: repository } },
      head: { sha: head, repo: { full_name: repository } },
    },
  };
  const eventPath = join(root, "event.json");
  let sequence = 0;
  return {
    root,
    source,
    checkout,
    base,
    head,
    merge,
    event,
    eventPath,
    git: (...args: string[]) => git(checkout, ...args),
    run(overrides: Record<string, string | undefined> = {}) {
      writeFileSync(eventPath, JSON.stringify(event));
      const output = join(root, `output-${sequence++}`);
      const summary = `${output}.summary`;
      const result = spawnSync(process.execPath, [script], {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: repository,
          GITHUB_SHA: merge,
          GITHUB_REF: "refs/pull/7/merge",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          ...overrides,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const facts = JSON.parse(result.stdout);
      assert.equal(readFileSync(output, "utf8"), `package-required=${facts.required}\n`);
      assert.match(
        readFileSync(summary, "utf8"),
        new RegExp(facts.required ? "required" : "skipped"),
      );
      return facts;
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const path of [...initialPaths.slice(0, 5), "changelog.d/new-fragment.md"]) {
  test(`bound depth-two operational change can skip: ${path}`, () => {
    const f = fixture((root) => writeFileSync(join(root, path), "changed\n"));
    try {
      assert.deepEqual(f.run(), {
        required: false,
        reason: "operational-only",
        changedPaths: 1,
        base: f.base,
        head: f.head,
        merge: f.merge,
      });
    } finally {
      f.close();
    }
  });
}

for (const path of [
  "src/runtime.ts",
  ".github/workflows/ci.yml",
  ".github/actions/setup-pnpm/action.yml",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/stage-local-package.mjs",
  "test/local-package-install.test.ts",
  "test/local-range-review.test.ts",
  "test/agent-input-scan-helpers.ts",
  "test/helpers.ts",
  "test/local-entry-import-guard.mjs",
  "docs/local-package.md",
  "changelog.d/README.md",
  "changelog.d/new.md\nextra.md",
  "changelog.d/new.md\n",
  "changelog.d/new.md\r",
  "changelog.d/new.md\u2028",
  "unknown.md",
]) {
  test(`package and unknown inputs retain full qualification: ${JSON.stringify(path)}`, () => {
    const f = fixture((root) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "changed\n");
      writeFileSync(join(root, initialPaths[0]!), "operational change\n");
    });
    try {
      assert.equal(f.run().required, true);
    } finally {
      f.close();
    }
  });
}

test("NUL-separated deletions and both rename endpoints remain authoritative", () => {
  const deletion = fixture((root) => rmSync(join(root, initialPaths[0]!)));
  try {
    assert.equal(deletion.run().required, false);
  } finally {
    deletion.close();
  }
  const renameOut = fixture((root) =>
    renameSync(join(root, initialPaths[0]!), join(root, "src/renamed.ts")),
  );
  try {
    assert.equal(renameOut.run().required, true);
    assert.equal(renameOut.run().changedPaths, 2);
  } finally {
    renameOut.close();
  }
  const renameIn = fixture((root) =>
    renameSync(join(root, "src/runtime.ts"), join(root, "changelog.d/renamed.md")),
  );
  try {
    assert.equal(renameIn.run().required, true);
  } finally {
    renameIn.close();
  }
});

test("empty and unavailable comparisons never skip", () => {
  const empty = fixture(() => {});
  try {
    assert.equal(empty.run().reason, "empty-comparison");
  } finally {
    empty.close();
  }
  const f = fixture((root) => writeFileSync(join(root, initialPaths[0]!), "changed\n"));
  try {
    f.git("fetch", "--depth=1", `file://${join(f.root, "origin.git")}`, f.merge);
    assert.equal(f.run().required, true);
    assert.equal(f.run({ PATH: join(f.root, "absent-bin") }).reason, "comparison-unavailable");
    assert.equal(f.run({ GITHUB_EVENT_PATH: join(f.root, "missing.json") }).required, true);
    const malformed = join(f.root, "malformed.json");
    writeFileSync(malformed, "{");
    assert.equal(f.run({ GITHUB_EVENT_PATH: malformed }).reason, "comparison-unavailable");
  } finally {
    f.close();
  }
});

test("behind-base package changes remain full because consumers execute the PR head", () => {
  const f = fixture(
    (root) => writeFileSync(join(root, initialPaths[0]!), "operational head\n"),
    (root) => writeFileSync(join(root, "src/runtime.ts"), "new base runtime\n"),
  );
  try {
    assert.equal(f.git("diff", "--name-only", f.base, f.merge), initialPaths[0]);
    assert.equal(f.run().required, true);
    assert.equal(f.run().changedPaths, 2);
  } finally {
    f.close();
  }
});

test("event, receiver, checkout, base, head and repository identity must all bind", () => {
  const f = fixture((root) => writeFileSync(join(root, initialPaths[0]!), "changed\n"));
  try {
    for (const override of [
      { GITHUB_SHA: f.head },
      { GITHUB_SHA: "not-a-sha" },
      { GITHUB_REF: "refs/heads/main" },
      { GITHUB_REPOSITORY: "other/repository" },
    ])
      assert.equal(f.run(override).required, true);
    f.event.pull_request.head.repo.full_name = "fork/automation";
    assert.equal(f.run().reason, "unbound-pull-request");
    f.event.pull_request.head.repo.full_name = repository;
    f.event.pull_request.base.sha = f.head;
    assert.equal(f.run().reason, "unbound-checkout");
    f.event.pull_request.base.sha = f.base;
    f.git("checkout", "--detach", f.head);
    assert.equal(f.run().reason, "unbound-checkout");
  } finally {
    f.close();
  }
});

for (const event of ["push", "workflow_dispatch", "release", "pull_request_target", ""]) {
  test(`non-PR admission stays full without reading PR input: ${event}`, () => {
    const f = fixture(() => {});
    try {
      assert.deepEqual(f.run({ GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: "absent" }), {
        required: true,
        reason: "not-pull-request",
      });
    } finally {
      f.close();
    }
  });
}

test("an unwritable output cannot produce successful admission", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: tmpdir() },
  });
  assert.notEqual(result.status, 0);
});
