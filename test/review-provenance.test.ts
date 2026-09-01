import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { reviewPromptForTest } from "../dist/clawsweeper.js";
import {
  ensurePullRequestReviewHead,
  ensureReviewTreeCommit,
  hydratePullRequestReviewHistory,
} from "../dist/clawsweeper-review-blobs.js";
import { git as reviewGit, item } from "./helpers.ts";

const upgradeFiles = [
  "docs/plugins/codex-computer-use.md",
  "docs/plugins/codex-harness-reference.md",
  "docs/plugins/codex-harness.md",
  "docs/plugins/codex-native-plugins.md",
  "extensions/codex/package.json",
  "extensions/codex/src/app-server/version.ts",
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-provenance-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Review Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message: string) => {
    git(root, "add", ".");
    git(root, "commit", "-qm", message);
    return git(root, "rev-parse", "HEAD");
  };
  upgradeFiles.forEach((path) => put(path, "Codex 0.149.1\n"));
  put("docs/hooks.md", "Old guide\n");
  put("src/caller.ts", 'export const mode = "safe";\n');
  put(
    "src/consumer.ts",
    'import { mode } from "./caller.js";\nexport const enabled = mode === "safe";\n',
  );
  const B = commit("base");
  git(root, "checkout", "-qb", "docs-pr");
  put("docs/hooks.md", "Clarified guide\n");
  const H = commit("unrelated docs");
  git(root, "checkout", "-q", "main");
  upgradeFiles.forEach((path) => put(path, "Codex 0.150.1\n"));
  const M = commit("main-only upgrade");
  git(root, "merge", "--no-ff", "-qm", "test merge", H);
  const T = git(root, "rev-parse", "HEAD");
  // The production reviewer checks out H, not the fetched main revision M.
  git(root, "checkout", "-q", "--detach", H);
  return { root, put, commit, B, H, M, T };
}

function promptEvidence(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const prompt = reviewPromptForTest(
    item({ kind: "pull_request" }),
    {
      issue: {},
      comments: [],
      timeline: [],
      pullRequest: {
        state: "open",
        merged: false,
        base: { sha: f.M },
        head: { sha: f.H },
        mergeCommitSha: f.T,
        ...overrides,
      },
      pullFiles: [
        { filename: "docs/hooks.md", patch: "@@ -1 +1 @@\n-Old guide\n+Clarified guide" },
      ],
    },
    { ...reviewGit, mainSha: f.M },
    "",
    { targetDir: f.root },
  );
  const section = prompt.match(/## PR Introduction Evidence\n\n```json\n([\s\S]*?)\n```/);
  assert.ok(section, "production prompt must serialize host-computed introduction evidence");
  return { prompt, evidence: JSON.parse(section[1]!) };
}

test("real Git graph distinguishes introduced changes from main-only upgrades and verifies test merge", () => {
  const f = fixture();
  try {
    assert.match(
      git(f.root, "diff", f.M, f.H, "--", upgradeFiles[1]!),
      /-Codex 0\.150\.1\n\+Codex 0\.149\.1/,
    );
    assert.equal(git(f.root, "diff", "--name-only", f.B, f.H), "docs/hooks.md");
    assert.equal(git(f.root, "show", "-s", "--format=%P", f.T), `${f.M} ${f.H}`);
    for (const path of upgradeFiles) {
      assert.equal(
        git(f.root, "rev-parse", `${f.M}:${path}`),
        git(f.root, "rev-parse", `${f.T}:${path}`),
      );
    }
    const { evidence } = promptEvidence(f);
    assert.equal(evidence.checkoutSha, f.H);
    assert.equal(evidence.fetchedMainSha, f.M);
    assert.equal(evidence.baseSha, f.M);
    assert.equal(evidence.headSha, f.H);
    assert.deepEqual(evidence.mergeBase, { status: "verified", sha: f.B });
    assert.equal(evidence.introduced.role, "pr_introduced");
    assert.deepEqual(evidence.introduced.files, ["docs/hooks.md"]);
    assert.equal(evidence.introduced.filesComplete, true);
    assert.equal(evidence.introduced.patchComplete, true);
    assert.match(evidence.introduced.patch, /\+Clarified guide/);
    assert.doesNotMatch(evidence.introduced.patch, /Codex/);
    assert.equal(evidence.endpointDrift.role, "endpoint_drift_not_introduction");
    assert.deepEqual(evidence.baseOnlyFiles, [...upgradeFiles].sort());
    assert.equal(evidence.testMerge.status, "verified");
    assert.deepEqual(evidence.testMerge.parents, [f.M, f.H]);
    assert.deepEqual(evidence.testMerge.result.files, ["docs/hooks.md"]);
    if (process.env.CLAWSWEEPER_PROVENANCE_PROOF_DIR) {
      writeFileSync(
        join(process.env.CLAWSWEEPER_PROVENANCE_PROOF_DIR, "fixture-evidence.json"),
        JSON.stringify(
          {
            sourceHead: git(process.cwd(), "rev-parse", "HEAD"),
            environment: { node: process.version, provider: "local-disposable-git" },
            graph: { B: f.B, H: f.H, M: f.M, T: f.T },
            observations: {
              endpointShowsDowngrade: true,
              introducedFiles: ["docs/hooks.md"],
              sixUpgradeBlobsPreserved: true,
            },
            evidence,
            limits:
              "Local Git and production review-input assembly only; no live model review, remote reads, or GitHub writes.",
          },
          null,
          2,
        ) + "\n",
      );
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("introduced downgrade and cross-file trigger remain reviewer-owned evidence", () => {
  const f = fixture();
  try {
    git(f.root, "checkout", "-q", "--detach", f.M);
    f.put(upgradeFiles[4]!, "Codex 0.149.1\n");
    f.put("src/caller.ts", 'export const mode = "unsafe";\n');
    const H = f.commit("real introduced downgrade and caller regression");
    const { evidence, prompt } = promptEvidence({ ...f, H }, { mergeCommitSha: undefined });
    assert.equal(evidence.mergeBase.sha, f.M);
    assert.match(evidence.introduced.patch, /-Codex 0\.150\.1\n\+Codex 0\.149\.1/);
    assert.ok(evidence.introduced.files.includes("src/caller.ts"));
    assert.ok(!evidence.introduced.files.includes("src/consumer.ts"));
    assert.match(prompt, /untouched affected file/);
    assert.match(prompt, /causal link/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("missing, stale and final merge identities do not claim verified merge results", () => {
  const f = fixture();
  try {
    for (const overrides of [
      { mergeCommitSha: undefined },
      { mergeCommitSha: "f".repeat(40) },
      { head: { sha: f.B } },
      { base: { sha: f.B } },
      { merged: true, state: "closed" },
      { mergeCommitSha: f.M },
    ]) {
      const { evidence } = promptEvidence(f, overrides);
      assert.notEqual(evidence.testMerge.status, "verified");
      assert.equal(evidence.testMerge.result, undefined);
      assert.ok(evidence.testMerge.reason);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("missing or shallow ancestry cannot turn endpoint drift into introduced evidence", () => {
  const f = fixture();
  try {
    const missing = promptEvidence(f, { head: { sha: "f".repeat(40) } }).evidence;
    assert.equal(missing.mergeBase.status, "unavailable");
    assert.equal(missing.introduced.filesComplete, false);
    assert.equal(missing.introduced.patch, null);
    writeFileSync(join(f.root, ".git", "shallow"), `${f.H}\n`);
    const shallow = promptEvidence(f).evidence;
    assert.equal(shallow.mergeBase.status, "unavailable");
    assert.equal(shallow.introduced.filesComplete, false);
    assert.equal(shallow.baseOnlyFiles, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("test-merge parents must be consecutive LF records after the tree", () => {
  const f = fixture();
  try {
    const tree = git(f.root, "rev-parse", `${f.T}^{tree}`);
    const ident = "Fixture <fixture@example.invalid> 1700000000 +0000";
    for (const [label, header] of [
      ["late parent headers", `author ${ident}\ncommitter ${ident}\nparent ${f.M}\nparent ${f.H}`],
      [
        "CRs in one identity",
        `author A\rparent ${f.M}\rparent ${f.H}\r${ident}\ncommitter ${ident}`,
      ],
    ]) {
      const rawFile = join(f.root, ".git", "fixture-commit");
      writeFileSync(rawFile, `tree ${tree}\n${header}\n\nfixture\n`);
      const fakeMerge = git(f.root, "hash-object", "-t", "commit", "-w", rawFile);
      assert.equal(git(f.root, "show", "-s", "--format=%P", fakeMerge), "", label);
      const { evidence } = promptEvidence(f, { mergeCommitSha: fakeMerge });
      assert.equal(evidence.testMerge.status, "stale", label);
      assert.deepEqual(evidence.testMerge.parents, [], label);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("production source preparation recovers a shallow PR tip and fetches the pinned test merge", () => {
  const f = fixture();
  const clone = mkdtempSync(join(tmpdir(), "clawsweeper-provenance-clone-"));
  try {
    git(f.root, "config", "uploadpack.allowFilter", "true");
    git(f.root, "update-ref", "refs/heads/main", f.M);
    git(f.root, "update-ref", "refs/pull/1/head", f.H);
    git(f.root, "update-ref", "refs/pull/1/merge", f.T);
    git(
      clone,
      "clone",
      "-q",
      "--no-checkout",
      "--single-branch",
      "--branch",
      "main",
      "--filter=blob:none",
      `file://${f.root}`,
      ".",
    );
    git(clone, "fetch", "-q", "--depth=1", "origin", "refs/pull/1/head:refs/pr-head");
    git(clone, "checkout", "-q", "--detach", f.H);
    assert.throws(() =>
      git(clone, "-c", "protocol.allow=never", "cat-file", "-e", `${f.T}^{commit}`),
    );
    assert.equal(promptEvidence({ ...f, root: clone }).evidence.mergeBase.status, "unavailable");
    assert.ok(
      ensureReviewTreeCommit({
        targetDir: clone,
        sha: f.M,
        sourceRef: "refs/heads/main",
        destinationRef: "refs/clawsweeper/review-cache/base-1",
      }),
    );
    assert.ok(ensurePullRequestReviewHead({ targetDir: clone, itemNumber: 1, headSha: f.H }));
    hydratePullRequestReviewHistory({
      targetDir: clone,
      baseSha: f.M,
      headSha: f.H,
      itemNumber: 1,
      testMergeSha: f.T,
    });
    const { evidence } = promptEvidence({ ...f, root: clone });
    assert.equal(evidence.mergeBase.sha, f.B);
    assert.equal(evidence.testMerge.status, "verified");
    assert.equal(evidence.checkoutSha, f.H);
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(clone, "status", "--porcelain"), "");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("bounded evidence marks oversized patches and file lists incomplete", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 81; index++)
      f.put(`docs/new-${index}.md`, "Added text\n".repeat(100));
    const H = f.commit("large documentation change");
    const { evidence } = promptEvidence({ ...f, H });
    assert.equal(evidence.introduced.files.length, 80);
    assert.equal(evidence.introduced.filesComplete, false);
    assert.equal(evidence.introduced.patch.length, 24_000);
    assert.equal(evidence.introduced.patchComplete, false);
    assert.equal(evidence.baseOnlyFiles, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("criss-cross ancestry does not guess a single introduced delta", () => {
  const f = fixture();
  try {
    const tree = git(f.root, "rev-parse", `${f.B}^{tree}`);
    const left = git(f.root, "commit-tree", tree, "-p", f.B, "-m", "left");
    const right = git(f.root, "commit-tree", tree, "-p", f.B, "-m", "right");
    const M = git(f.root, "commit-tree", tree, "-p", left, "-p", right, "-m", "left merge");
    const H = git(f.root, "commit-tree", tree, "-p", right, "-p", left, "-m", "right merge");
    const { evidence } = promptEvidence({ ...f, M, H });
    assert.equal(evidence.mergeBase.status, "ambiguous");
    assert.equal(evidence.mergeBase.sha, null);
    assert.equal(evidence.introduced.filesComplete, false);
    assert.equal(evidence.introduced.patch, null);
    assert.equal(evidence.baseOnlyFiles, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
