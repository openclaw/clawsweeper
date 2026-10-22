import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  materializePullRequestReviewTree,
  prepareAdmittedReviewObjects,
} from "../dist/clawsweeper-review-blobs.js";
import { AgentInputScanError } from "../dist/agent-input-scan.js";

const trailer = "Co-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>";
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "review-closure-"));
  const source = join(root, "source");
  fs.mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Closure fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  const commit = (text: string) => {
    fs.writeFileSync(join(source, "source.txt"), text);
    git(source, "add", "source.txt");
    git(source, "commit", "-qm", text + "\n\n" + trailer);
    return git(source, "rev-parse", "HEAD");
  };
  const older = commit("older excluded ancestry\n");
  const floor = commit("floor\n");
  git(source, "checkout", "-qb", "feature");
  const history = commit("feature history\n");
  const head = commit("feature head\n");
  git(source, "checkout", "-q", "main");
  const base = commit("actual pinned base\n");
  const canary = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: source,
    input: "UNADMITTED_OBJECT_CANARY",
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(join(source, ".env"), "UNTRACKED_PROVIDER_CANARY");
  const foreign = commit("unrelated private branch\n");
  git(source, "update-ref", "refs/heads/private", foreign);
  git(source, "reset", "--hard", base);
  const closure = join(root, "closure");
  return { root, source, older, floor, history, head, base, canary, foreign, closure };
}

test("private closure preserves pinned base/head/range history but excludes known dangling and unrelated objects", () => {
  const f = fixture();
  try {
    git(f.source, "replace", f.head, f.foreign);
    const result = prepareAdmittedReviewObjects({
      targetDir: f.source,
      directory: f.closure,
      revisions: [f.head, f.base],
      deadlineAt: Date.now() + 30_000,
    });
    assert.deepEqual(result.boundaries, [f.floor]);
    assert.equal(git(f.closure, "show", f.head + ":source.txt"), "feature head");
    assert.equal(git(f.closure, "show", f.base + ":source.txt"), "actual pinned base");
    assert.equal(git(f.closure, "show", f.history + ":source.txt"), "feature history");
    assert.equal(git(f.closure, "merge-base", f.head, f.base), f.floor);
    for (const sha of [f.canary, f.foreign]) {
      assert.notEqual(spawnSync("git", ["cat-file", "-e", sha], { cwd: f.closure }).status, 0);
    }
    assert.equal(fs.existsSync(join(result.objects, "info", "alternates")), false);
    assert.equal(fs.existsSync(join(f.closure, ".env")), false);
    assert.equal(git(f.closure, "for-each-ref"), "");
    const packs = fs.readdirSync(join(result.objects, "pack"));
    assert.equal(packs.filter((name) => name.endsWith(".pack")).length, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("configured materialization reuses only admitted objects with independent refs/config/index and no target callbacks", () => {
  const f = fixture();
  try {
    const marker = join(f.root, "callback-ran");
    const hooks = join(f.root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      join(hooks, "post-checkout"),
      "#!/bin/sh\nprintf pwn > " + JSON.stringify(marker),
    );
    fs.chmodSync(join(hooks, "post-checkout"), 0o755);
    git(f.source, "config", "core.hooksPath", hooks);
    git(f.source, "config", "core.fsmonitor", "printf callback > " + JSON.stringify(marker));
    const copies = [join(f.root, "role-a"), join(f.root, "role-b")];
    for (const worktreeDir of copies) {
      assert.equal(
        materializePullRequestReviewTree({
          targetDir: f.source,
          worktreeDir,
          itemNumber: 0,
          headSha: f.head,
          independentGit: true,
          admittedObjects: { directory: f.closure, baseSha: f.base },
          deadlineAt: Date.now() + 30_000,
        }),
        true,
      );
      const alternate = fs
        .readFileSync(join(worktreeDir, ".git", "objects", "info", "alternates"), "utf8")
        .trim();
      assert.equal(alternate, join(f.closure, ".git", "objects"));
      assert.equal(git(worktreeDir, "show", f.history + ":source.txt"), "feature history");
      assert.equal(git(worktreeDir, "show", f.base + ":source.txt"), "actual pinned base");
      assert.equal(fs.existsSync(join(worktreeDir, ".env")), false);
      assert.notEqual(
        spawnSync("git", ["cat-file", "-e", f.canary], { cwd: worktreeDir }).status,
        0,
      );
      assert.equal(git(worktreeDir, "config", "--get", "core.repositoryformatversion"), "0");
      assert.notEqual(
        spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: worktreeDir }).status,
        0,
      );
    }
    git(copies[0]!, "update-ref", "refs/private/member", f.head);
    assert.equal(git(copies[1]!, "for-each-ref"), "");
    assert.equal(fs.existsSync(marker), false);
    assert.notEqual(
      fs.statSync(join(copies[0]!, ".git", "index")).ino,
      fs.statSync(join(copies[1]!, ".git", "index")).ino,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("closure disk refusal occurs before writing a pack or checkout", (t) => {
  const f = fixture();
  const original = fs.statfsSync;
  try {
    t.mock.method(fs, "statfsSync", (...args: Parameters<typeof fs.statfsSync>) => ({
      ...original(...args),
      bavail: 0,
    }));
    syncBuiltinESMExports();
    assert.throws(
      () =>
        prepareAdmittedReviewObjects({
          targetDir: f.source,
          directory: f.closure,
          revisions: [f.head, f.base],
          deadlineAt: Date.now() + 30_000,
        }),
      AgentInputScanError,
    );
    assert.equal(fs.existsSync(f.closure), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("expired closure and incomplete history cannot copy objects or fall back to the canonical store", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        prepareAdmittedReviewObjects({
          targetDir: f.source,
          directory: f.closure,
          revisions: [f.head, f.base],
          deadlineAt: Date.now() - 1,
        }),
      (e) => e instanceof AgentInputScanError && e.reason === "deadline",
    );
    assert.equal(fs.existsSync(f.closure), false);
    const blob = git(f.source, "rev-parse", f.history + ":source.txt");
    fs.rmSync(join(f.source, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    assert.throws(
      () =>
        prepareAdmittedReviewObjects({
          targetDir: f.source,
          directory: f.closure,
          revisions: [f.head, f.base],
          deadlineAt: Date.now() + 30_000,
        }),
      AgentInputScanError,
    );
    assert.equal(fs.existsSync(f.closure), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("object IDs quoted in PR source text do not admit dangling or unrelated history", () => {
  const f = fixture();
  try {
    git(f.source, "checkout", "--detach", f.head);
    fs.writeFileSync(join(f.source, "PR_TEXT.md"), "Inspect " + f.canary + " and " + f.foreign);
    git(f.source, "add", "PR_TEXT.md");
    git(f.source, "commit", "-qm", "Text is not Git authority\n\n" + trailer);
    const head = git(f.source, "rev-parse", "HEAD");
    prepareAdmittedReviewObjects({
      targetDir: f.source,
      directory: f.closure,
      revisions: [head, f.base],
      deadlineAt: Date.now() + 30_000,
    });
    assert.equal(
      git(f.closure, "show", head + ":PR_TEXT.md"),
      "Inspect " + f.canary + " and " + f.foreign,
    );
    for (const sha of [f.canary, f.foreign])
      assert.notEqual(spawnSync("git", ["cat-file", "-e", sha], { cwd: f.closure }).status, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("partial, redirected and foreign-field cached object stores fail closed", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.closure);
    assert.throws(
      () =>
        prepareAdmittedReviewObjects({
          targetDir: f.source,
          directory: f.closure,
          revisions: [f.head, f.base],
          deadlineAt: Date.now() + 30000,
        }),
      AgentInputScanError,
    );
    fs.rmSync(f.closure, { recursive: true });
    prepareAdmittedReviewObjects({
      targetDir: f.source,
      directory: f.closure,
      revisions: [f.head, f.base],
      deadlineAt: Date.now() + 30000,
    });
    const manifest = join(f.closure, "admitted.json");
    const receipt = JSON.parse(fs.readFileSync(manifest, "utf8"));
    fs.chmodSync(manifest, 0o600);
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...receipt, objects: join(f.source, ".git", "objects") }),
    );
    assert.throws(
      () =>
        prepareAdmittedReviewObjects({
          targetDir: f.source,
          directory: f.closure,
          revisions: [f.head, f.base],
          deadlineAt: Date.now() + 30000,
        }),
      AgentInputScanError,
    );
    fs.writeFileSync(manifest, JSON.stringify(receipt));
    fs.mkdirSync(join(f.closure, ".git", "objects", "info"));
    fs.writeFileSync(
      join(f.closure, ".git", "objects", "info", "alternates"),
      join(f.source, ".git", "objects"),
    );
    assert.throws(
      () =>
        prepareAdmittedReviewObjects({
          targetDir: f.source,
          directory: f.closure,
          revisions: [f.head, f.base],
          deadlineAt: Date.now() + 30000,
        }),
      AgentInputScanError,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const limit of ["objects", "bytes"] as const)
  test(
    "closure " + limit + " admission refuses before packing or checkout",
    { skip: process.platform === "win32" },
    () => {
      const f = fixture(),
        previous = process.env.PATH;
      try {
        const bin = join(f.root, "git-bin");
        fs.mkdirSync(bin);
        const native = execFileSync("/bin/sh", ["-c", "command -v git"], {
          encoding: "utf8",
        }).trim();
        const marker = join(f.root, "pack-started");
        const body = [
          "#!" + process.execPath,
          'const fs=require("node:fs"),cp=require("node:child_process");const a=process.argv.slice(2);',
          'if(a.includes("pack-objects"))fs.writeFileSync(' +
            JSON.stringify(marker) +
            ',"unexpected");',
          limit === "objects"
            ? 'if(a.includes("rev-list")&&a.includes("--objects")&&a.includes("--stdin")){fs.writeFileSync(1,Array.from({length:200001},(_,i)=>(i+1).toString(16).padStart(40,"0")).join(String.fromCharCode(10))+String.fromCharCode(10));process.exit(0);}'
            : "",
          "const r=cp.spawnSync(" +
            JSON.stringify(native) +
            ',a,{input:fs.readFileSync(0),encoding:"utf8",maxBuffer:70*1024*1024});',
          limit === "bytes"
            ? 'if(a.includes("cat-file")&&a.includes("--batch-check=%(objectname) %(objecttype) %(objectsize)")){r.stdout=r.stdout.replace(/^(\\w+ \\w+) \\d+/,(m,p)=>p+" 2147483649");}'
            : "",
          'process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status??1);',
        ].join("\n");
        fs.writeFileSync(join(bin, "git"), body, { mode: 0o755 });
        process.env.PATH = bin + ":" + previous;
        assert.throws(
          () =>
            prepareAdmittedReviewObjects({
              targetDir: f.source,
              directory: f.closure,
              revisions: [f.head, f.base],
              deadlineAt: Date.now() + 30000,
            }),
          (e) =>
            e instanceof AgentInputScanError &&
            e.reason === "incomplete_source" &&
            e.message.includes(limit === "objects" ? "object-count" : "object-byte"),
        );
        assert.equal(fs.existsSync(marker), false);
        assert.equal(fs.existsSync(f.closure), false);
      } finally {
        process.env.PATH = previous;
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

test("private closure honors a shallow merge floor without requiring excluded parents", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.source, ".git", "shallow"), f.floor + "\n");
    fs.rmSync(join(f.source, ".git", "objects", f.older.slice(0, 2), f.older.slice(2)));
    assert.equal(git(f.source, "merge-base", f.head, f.base), f.floor);
    const result = prepareAdmittedReviewObjects({
      targetDir: f.source,
      directory: f.closure,
      revisions: [f.head, f.base],
      deadlineAt: Date.now() + 30000,
    });
    assert.deepEqual(result.boundaries, [f.floor]);
    assert.equal(git(f.closure, "show", f.history + ":source.txt"), "feature history");
    assert.equal(git(f.closure, "show", f.base + ":source.txt"), "actual pinned base");
    assert.notEqual(spawnSync("git", ["cat-file", "-e", f.older], { cwd: f.closure }).status, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("shallow ancestry cut inside the required range and malformed boundaries fail closed", () => {
  for (const boundary of ["history", "invalid"]) {
    const f = fixture();
    try {
      fs.writeFileSync(
        join(f.source, ".git", "shallow"),
        boundary === "history" ? f.history + "\n" : "not-a-commit\n",
      );
      assert.throws(
        () =>
          prepareAdmittedReviewObjects({
            targetDir: f.source,
            directory: f.closure,
            revisions: [f.head, f.base],
            deadlineAt: Date.now() + 30000,
          }),
        AgentInputScanError,
      );
      assert.equal(fs.existsSync(f.closure), false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});
