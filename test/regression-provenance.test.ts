import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as provenance from "../dist/clawsweeper-regression-provenance.js";
import { parseDecision, renderReviewCommentFromReport } from "../dist/clawsweeper.js";
import { closeDecision, reportFrontMatter } from "./helpers.ts";
import { maintainerDecisionFromReport } from "../dist/decision-packets.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

function historyFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-owner-history-"));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    ).trim();
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Fixture Committer");
  git(source, "config", "user.email", "committer@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  const commit = (author: string, message: string) => {
    git(source, "add", ".");
    git(source, "commit", "-qm", message, "--author", `${author} <author@example.invalid>`);
    return git(source, "rev-parse", "HEAD");
  };
  writeFileSync(join(source, "README"), "fixture\n");
  const initial = commit("Initial Author", "initial");
  writeFileSync(join(source, "target.ts"), "export const target = true;\n");
  const introduced = commit("Code Author", "introduce target line (#936)");
  writeFileSync(join(source, "mobile.ts"), "export const mobile = true;\n");
  const unrelated = commit("Mobile Author", "unrelated mobile change");
  writeFileSync(join(source, "README"), "later tip\n");
  const tip = commit("Tip Author", "later tip");
  const shallow = (parentAvailable: boolean) => {
    const checkout = join(root, "review");
    git(root, "clone", "-q", "--depth=2", `file://${source}`, checkout);
    if (parentAvailable) git(checkout, "fetch", "-q", "--depth=1", "origin", introduced);
    return checkout;
  };
  return { root, source, git, commit, initial, introduced, unrelated, tip, shallow };
}

type Fixture = ReturnType<typeof historyFixture>;
function candidate(sha: string, overrides = {}) {
  return {
    repo: "openclaw/clawsweeper",
    pullRequestNumber: 936,
    pullRequestUrl: "https://github.com/openclaw/clawsweeper/pull/936",
    mergeCommitSha: sha,
    sourcePath: "target.ts",
    sourceLine: 1,
    ...overrides,
  };
}
function mergedPull(sha: string, overrides = {}) {
  return {
    number: 936,
    html_url: "https://github.com/openclaw/clawsweeper/pull/936",
    merged: true,
    merged_at: "2026-07-31T12:00:00Z",
    merge_commit_sha: sha,
    head: { sha },
    base: { ref: "main" },
    user: { login: "separate-pr-author" },
    merged_by: { login: "separate-merger" },
    ...overrides,
  };
}
function options(f: Fixture, sha = f.introduced, checkoutDir = f.source) {
  return {
    candidate: candidate(sha),
    item: { repo: "openclaw/clawsweeper", number: 946 },
    checkoutDir,
    targetBranch: "main",
    reviewedCommitShas: [f.tip],
  };
}
function verifier(sha: string, overrides = {}) {
  return provenance.createRegressionProvenanceVerifier({
    fetchPull: () => mergedPull(sha),
    fetchPullDiff: () => "",
    ...overrides,
  });
}
function owner(f: Fixture, sha = f.introduced, actor: "author" | "committer" = "author") {
  return {
    person: "Model Guessed Person",
    role: "introduced the feature",
    reason: "Blame alone proves introduction.",
    commits: [sha],
    files: ["target.ts"],
    confidence: "high" as const,
    history: { commitSha: sha, sourcePath: "target.ts", sourceLine: 1, actor },
  };
}
function verifyOwners(f: Fixture, owners: ReturnType<typeof owner>[], checkoutDir = f.source) {
  return provenance.verifyLikelyOwnerHistory(
    parseDecision(closeDecision({ likelyOwners: owners })),
    { checkoutDir, reviewedCommitShas: [f.tip] },
  ).likelyOwners;
}

for (const parentAvailable of [true, false]) {
  test(`real shallow blame cannot attribute an unchanged line with parent ${parentAvailable ? "available" : "missing"}`, () => {
    const f = historyFixture();
    try {
      const checkout = f.shallow(parentAvailable);
      assert.match(
        f.git(checkout, "cat-file", "commit", f.unrelated),
        new RegExp(`^parent ${f.introduced}$`, "m"),
      );
      assert.equal(f.git(checkout, "show", "-s", "--format=%P", f.unrelated), "");
      const blameArgs = ["blame", "--line-porcelain", "-L", "1,1", f.tip, "--", "target.ts"];
      assert.match(f.git(checkout, ...blameArgs), /^boundary$/m);
      assert.match(f.git(checkout, "blame", "-L", "1,1", "target.ts"), /^\^/);
      if (parentAvailable)
        assert.equal(f.git(checkout, "diff", f.introduced, f.unrelated, "--", "target.ts"), "");
      else assert.throws(() => f.git(checkout, "cat-file", "commit", f.introduced));
      for (const showRoot of [false, true]) {
        f.git(checkout, "config", "blame.showRoot", String(showRoot));
        if (showRoot) assert.doesNotMatch(f.git(checkout, ...blameArgs), /^boundary$/m);
        assert.equal(
          verifier(f.unrelated).verify(options(f, f.unrelated, checkout)),
          null,
          "An unchanged or unverifiable parent patch is not introduction evidence",
        );
        const [result] = verifyOwners(f, [owner(f, f.unrelated)], checkout);
        assert.equal(result?.person, "unknown");
        assert.equal(result?.confidence, "low");
        assert.equal(
          result?.role,
          parentAvailable ? "carried-forward source line" : "source history unknown",
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /Mobile Author|introduced the feature|Blame alone/,
        );
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("real introduction keeps code author, committer, PR author and merger independent", () => {
  const f = historyFixture();
  try {
    const result = verifier(f.introduced).verify(options(f));
    assert.equal(result?.evidenceType, "blame_to_merge_commit");
    assert.equal(result?.sourceCommitSha, f.introduced);
    assert.equal(result?.sourceAuthor, "Code Author");
    const owners = verifyOwners(f, [owner(f), owner(f, f.introduced, "committer")]);
    assert.deepEqual(
      owners.map(({ person, role, confidence }) => ({ person, role, confidence })),
      [
        { person: "Code Author", role: "source-line author", confidence: "high" },
        { person: "Fixture Committer", role: "source-line committer", confidence: "high" },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(owners),
      /separate-pr-author|separate-merger|Model Guessed Person|introduced the feature/,
    );
    // A visible boundary with a locally verifiable introducing patch is not blindly discarded.
    writeFileSync(join(f.source, ".git", "shallow"), `${f.introduced}\n`);
    assert.equal(verifier(f.introduced).verify(options(f))?.sourceAuthor, "Code Author");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("configured blame exclusions cannot certify an older version of the reviewed line", () => {
  const f = historyFixture();
  try {
    const context = "// retained first neighbor\n// retained second neighbor\n";
    writeFileSync(join(f.source, "target.ts"), "export const target = true;\n" + context);
    f.commit("Context Author", "add unchanged blame neighbors");
    writeFileSync(join(f.source, "target.ts"), "export const target = false;\n" + context);
    const changed = f.commit("Changed Author", "change target behavior");
    writeFileSync(join(f.source, ".git", "ignored-revs"), `${changed}\n`);
    f.git(f.source, "config", "blame.ignoreRevsFile", ".git/ignored-revs");
    const current = { ...f, tip: changed };
    const blame = f.git(
      f.source,
      "blame",
      "--line-porcelain",
      "-L",
      "1,1",
      changed,
      "--",
      "target.ts",
    );
    assert.ok(blame.startsWith(f.introduced));
    assert.match(blame, /\texport const target = false;/);
    assert.match(f.git(f.source, "show", `${f.introduced}:target.ts`), /target = true/);
    assert.equal(verifyOwners(current, [owner(current)])[0]?.person, "unknown");
    assert.equal(verifyOwners(current, [owner(current, changed)])[0]?.person, "Changed Author");
    const result = verifier(f.introduced).verify(options(current));
    assert.equal(result?.sourceCommitSha, changed);
    assert.equal(result?.sourceAuthor, "Changed Author");
    assert.equal(result?.evidenceType, "source_line");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const exact of [true, false]) {
  test(`shallow ${exact ? "exact" : "inexact"} rename cannot certify the renamer as the line author`, () => {
    const f = historyFixture();
    try {
      const text =
        "export const target = true;\n" +
        Array.from({ length: 9 }, (_, index) => `// retained context ${index}\n`).join("");
      writeFileSync(join(f.source, "target.ts"), text);
      f.commit("Context Author", "add rename context");
      f.git(f.source, "mv", "target.ts", "moved.ts");
      if (!exact) writeFileSync(join(f.source, "moved.ts"), text.replace("context 8", "changed 8"));
      const renamed = f.commit("Rename Author", "move target source");
      writeFileSync(join(f.source, ".git", "shallow"), `${renamed}\n`);
      const current = { ...f, tip: renamed };
      const pointer = {
        ...owner(current, renamed),
        history: {
          commitSha: renamed,
          sourcePath: "moved.ts",
          sourceLine: 1,
          actor: "author" as const,
        },
      };
      assert.equal(f.git(f.source, "show", "-s", "--format=%P", renamed), "");
      assert.match(
        f.git(f.source, "blame", "--line-porcelain", "-L", "1,1", renamed, "--", "moved.ts"),
        /^boundary$/m,
      );
      const [result] = verifyOwners(current, [pointer]);
      assert.equal(result?.person, "unknown");
      assert.equal(result?.role, exact ? "carried-forward source line" : "source history unknown");
      assert.equal(
        verifier(renamed).verify({
          ...options(current, renamed),
          candidate: candidate(renamed, { sourcePath: "moved.ts" }),
        }),
        null,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("commit file-touch and unchanged merge-parent lines cannot become introduction evidence", () => {
  const f = historyFixture();
  try {
    writeFileSync(
      join(f.source, "target.ts"),
      "export const target = true;\nexport const adjacent = true;\n",
    );
    const adjacent = f.commit("Adjacent Author", "change adjacent line");
    writeFileSync(join(f.source, ".git", "shallow"), `${adjacent}\n`);
    const current = { ...f, tip: adjacent };
    assert.equal(verifier(adjacent).verify(options(current, adjacent)), null);
    assert.equal(
      verifyOwners(current, [owner(current, adjacent)])[0]?.role,
      "carried-forward source line",
    );
    // Two raw parents: the merge result already exists in the second parent.
    const tree = f.git(f.source, "rev-parse", `${f.introduced}^{tree}`);
    const merge = f.git(
      f.source,
      "commit-tree",
      tree,
      "-p",
      f.initial,
      "-p",
      f.introduced,
      "-m",
      "merge",
    );
    f.git(f.source, "checkout", "-q", "--detach", merge);
    writeFileSync(join(f.source, ".git", "shallow"), `${merge}\n`);
    assert.equal(verifier(merge).verify(options({ ...f, tip: merge }, merge)), null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("raw parents ignore replacement commits and target diff callbacks", () => {
  const f = historyFixture();
  try {
    const checkout = f.shallow(false);
    // Forge a root replacement for the boundary; the raw reader must still see its missing parent.
    const tree = f.git(f.source, "rev-parse", `${f.unrelated}^{tree}`);
    const replacement = f.git(f.source, "commit-tree", tree, "-m", "forged root");
    f.git(checkout, "fetch", "-q", "origin", replacement);
    f.git(checkout, "replace", f.unrelated, replacement);
    f.git(checkout, "config", "blame.showRoot", "true");
    const sentinel = join(f.root, "callback-ran");
    const callback = join(f.root, "callback");
    writeFileSync(callback, `#!/bin/sh\nprintf called > '${sentinel}'\n`, { mode: 0o755 });
    f.git(checkout, "config", "diff.external", callback);
    f.git(checkout, "config", "core.fsmonitor", callback);
    f.git(checkout, "config", "diff.fixture.textconv", callback);
    writeFileSync(join(checkout, ".git", "info", "attributes"), "*.ts diff=fixture\n");
    assert.equal(verifier(f.unrelated).verify(options(f, f.unrelated, checkout)), null);
    assert.equal(verifyOwners(f, [owner(f, f.unrelated)], checkout)[0]?.person, "unknown");
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy grafts cannot make an unrelated root the source-line author", () => {
  const f = historyFixture();
  try {
    const tree = f.git(f.source, "rev-parse", `${f.tip}^{tree}`);
    const root = f.git(
      f.source,
      "-c",
      "user.name=Recorded Root Author",
      "commit-tree",
      tree,
      "-m",
      "recorded root",
    );
    const unrelated = f.git(
      f.source,
      "-c",
      "user.name=Unrelated Root Author",
      "commit-tree",
      tree,
      "-m",
      "unrelated root",
    );
    f.git(f.source, "checkout", "-q", "--detach", root);
    writeFileSync(join(f.source, ".git", "info", "grafts"), `${root} ${unrelated}\n`);
    assert.doesNotMatch(f.git(f.source, "cat-file", "commit", root), /^parent /m);
    assert.equal(f.git(f.source, "show", "-s", "--format=%P", root), unrelated);
    assert.ok(
      f
        .git(f.source, "blame", "--line-porcelain", "-L", "1,1", root, "--", "target.ts")
        .startsWith(unrelated),
    );
    const current = { ...f, tip: root };
    assert.equal(verifyOwners(current, [owner(current, unrelated)])[0]?.person, "unknown");
    assert.equal(verifyOwners(current, [owner(current, root)])[0]?.person, "Recorded Root Author");
    assert.equal(
      verifier(root).verify(options(current, root))?.sourceAuthor,
      "Recorded Root Author",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const [label, separator] of [
  ["CR", "\r"],
  ["line separator", String.fromCodePoint(0x2028)],
  ["paragraph separator", String.fromCodePoint(0x2029)],
] as const) {
  test(`Git identity records reject forged authors after ${label}`, () => {
    const f = historyFixture();
    try {
      writeFileSync(join(f.source, "target.ts"), "export const target = false;\n");
      const changed = f.commit(`A${separator}author Forged`, "change with unsafe author name");
      const raw = f.git(f.source, "cat-file", "commit", changed);
      assert.ok(
        raw
          .split("\n")
          .find((line) => line.startsWith("author "))
          ?.includes(`A${separator}author Forged`),
      );
      const current = { ...f, tip: changed };
      const owners = verifyOwners(current, [
        owner(current, changed),
        owner(current, changed, "committer"),
      ]);
      assert.deepEqual(
        owners.map((entry) => entry.person),
        ["unknown", "Fixture Committer"],
      );
      const result = verifier(changed).verify(options(current, changed));
      assert.equal(result?.evidenceType, "blame_to_merge_commit");
      assert.equal(result?.sourceAuthor, undefined);
      assert.doesNotMatch(JSON.stringify(owners), /Forged/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("porcelain filenames cannot be forged by CR inside a Git identity", () => {
  const f = historyFixture();
  try {
    writeFileSync(join(f.source, "injected.ts"), "export const injected = true;\n");
    const boundary = f.commit("A\rfilename injected.ts", "unrelated file with hostile identity");
    writeFileSync(join(f.source, ".git", "shallow"), `${boundary}\n`);
    const blame = f.git(
      f.source,
      "blame",
      "--line-porcelain",
      "-L",
      "1,1",
      boundary,
      "--",
      "target.ts",
    );
    assert.equal(
      blame.split("\n").find((line) => line.startsWith("filename ")),
      "filename target.ts",
    );
    assert.equal(f.git(f.source, "diff", f.tip, boundary, "--", "target.ts"), "");
    const current = { ...f, tip: boundary };
    const [result] = verifyOwners(current, [owner(current, boundary, "committer")]);
    assert.equal(result?.person, "unknown");
    assert.equal(result?.role, "carried-forward source line");
    assert.equal(verifier(boundary).verify(options(current, boundary)), null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("added source text cannot forge a diff hunk for an unchanged line", () => {
  const f = historyFixture();
  try {
    writeFileSync(
      join(f.source, "target.ts"),
      "export const target = true;\n// added \r@@ -0,0 +1 @@\n",
    );
    const boundary = f.commit("Append Author", "append unrelated source text");
    writeFileSync(join(f.source, ".git", "shallow"), `${boundary}\n`);
    const patch = f.git(f.source, "diff", "--unified=0", f.tip, boundary, "--", "target.ts");
    assert.ok(patch.includes("+// added \r@@ -0,0 +1 @@"));
    const current = { ...f, tip: boundary };
    const [result] = verifyOwners(current, [owner(current, boundary)]);
    assert.equal(result?.person, "unknown");
    assert.equal(result?.role, "carried-forward source line");
    assert.equal(verifier(boundary).verify(options(current, boundary)), null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("invalid source pointers, metadata, missing objects and stale checkout fail closed", () => {
  const f = historyFixture();
  try {
    for (const invalid of [
      candidate(f.introduced, { sourcePath: "../secrets" }),
      candidate(f.introduced, { sourcePath: ":(glob)*" }),
      candidate(f.introduced, { sourcePath: "missing.ts" }),
      candidate(f.introduced, { sourceLine: 99 }),
      candidate(f.introduced, { sourceLine: 1_000_001 }),
      candidate(f.introduced, { mergeCommitSha: `^${f.introduced}` }),
      candidate(f.introduced, { pullRequestNumber: 946 }),
      candidate(f.introduced, { pullRequestUrl: "https://github.com/other/repo/pull/936" }),
    ])
      assert.equal(verifier(f.introduced).verify({ ...options(f), candidate: invalid }), null);
    for (const metadata of [
      { merged: false },
      { base: { ref: "other" } },
      { merge_commit_sha: f.unrelated },
      { merged_at: "invalid" },
      { head: { sha: "unknown" } },
    ])
      assert.equal(
        verifier(f.introduced, { fetchPull: () => mergedPull(f.introduced, metadata) }).verify(
          options(f),
        ),
        null,
      );
    assert.equal(
      verifier(f.introduced, {
        fetchPull: () => {
          throw new Error("unavailable");
        },
      }).verify(options(f)),
      null,
    );
    assert.equal(
      verifier(f.introduced).verify({ ...options(f), reviewedCommitShas: [f.initial] }),
      null,
    );
    // Missing partial-clone blobs must not lazy-fetch even when a promisor remote exists.
    const blob = f.git(f.source, "rev-parse", `${f.introduced}:target.ts`);
    rmSync(join(f.source, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    f.git(f.source, "config", "remote.origin.promisor", "true");
    f.git(f.source, "config", "remote.origin.url", "https://invalid.example.test/missing.git");
    assert.equal(verifier(f.introduced).verify(options(f)), null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rewrite equivalence retains only exact location-and-context-preserving patch associations", () => {
  const f = historyFixture();
  try {
    const patch =
      f.git(f.source, "diff", "--unified=3", "--no-renames", f.initial, f.introduced, "--") + "\n";
    for (const [pullDiff, expected] of [
      [patch, "rewrite_equivalent"],
      [patch.replace("+1 @@", "+5 @@"), "source_line"],
      [patch.replace("export const", "export let"), "source_line"],
      ["different patch", "source_line"],
    ]) {
      const result = verifier(f.unrelated, { fetchPullDiff: () => pullDiff }).verify(
        options(f, f.unrelated),
      );
      assert.equal(result?.evidenceType, expected);
      assert.equal(result?.sourceAuthor, "Code Author");
      assert.equal(
        result?.relatedPullRequestNumber,
        expected === "rewrite_equivalent" ? 936 : null,
      );
    }
    assert.equal(
      verifier(f.unrelated, {
        fetchPullDiff: () => {
          throw new Error("unavailable");
        },
      }).verify(options(f, f.unrelated))?.evidenceType,
      "source_line",
    );
    f.git(f.source, "checkout", "-q", "--detach", f.initial);
    writeFileSync(join(f.source, "branch.ts"), "branch only\n");
    const branch = f.commit("Branch Author", "branch only");
    const branchOwner = {
      ...owner(f, branch),
      history: {
        commitSha: branch,
        sourcePath: "branch.ts",
        sourceLine: 1,
        actor: "author" as const,
      },
    };
    const routing = provenance.verifyLikelyOwnerHistory(
      parseDecision(closeDecision({ likelyOwners: [branchOwner] })),
      {
        checkoutDir: f.source,
        reviewedCommitShas: [f.tip, branch],
      },
    );
    assert.equal(
      routing.likelyOwners[0]?.person,
      "unknown",
      "A recorded PR head locates history but does not make branch-only authors feature-history owners",
    );
    assert.equal(
      verifier(f.unrelated).verify({
        ...options(f, f.unrelated),
        candidate: candidate(f.unrelated, { sourcePath: "branch.ts" }),
        reviewedCommitShas: [f.tip, branch],
      }),
      null,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy public reports cannot promote unverified owner prose", () => {
  const report = `${reportFrontMatter({ number: 946, repository: "openclaw/clawsweeper" })}\n## Likely Related People\n\n- **Mobile Author:** introduced the target structure\n  - reason: Blame proves feature introduction.\n  - confidence: high\n  - commits: ${"a".repeat(40)}\n  - files: target.ts\n`;
  for (const reason of ["none", "duplicate_or_superseded"]) {
    const comment = renderReviewCommentFromReport(report, reason);
    assert.match(comment, /Mobile Author/);
    assert.match(comment, /unverified routing candidate/);
    assert.match(comment, /confidence: low/);
    assert.doesNotMatch(comment, /introduced the target|Blame proves|confidence: high/);
    assert.doesNotMatch(comment, /\/commit\/|commits:/);
  }
});

test("required decision owner remains in the bounded normalized routing set", () => {
  const f = historyFixture();
  try {
    const selected = { ...owner(f), person: "Selected Reviewer", history: null };
    const decision = closeDecision({
      likelyOwners: [
        ...Array.from({ length: 5 }, (_, index) => ({ ...selected, person: `Candidate ${index}` })),
        selected,
      ],
      maintainerDecision: {
        required: true,
        kind: "manual_review",
        question: "Which repair should proceed?",
        rationale: "A maintainer must select the repair scope.",
        options: [{ title: "Review", body: "Inspect the relevant source.", recommended: true }],
        likelyOwner: {
          person: selected.person,
          reason: "This person introduced the feature.",
          confidence: "high",
        },
      },
    });
    const normalized = provenance.verifyLikelyOwnerHistory(decision, {
      checkoutDir: f.source,
      reviewedCommitShas: [f.tip],
    });
    assert.equal(normalized.likelyOwners.length, 5);
    assert.equal(normalized.likelyOwners.at(-1)?.person, selected.person);
    assert.deepEqual(normalized.maintainerDecision.likelyOwner, {
      person: selected.person,
      reason: "Suggested for follow-up; no historical authorship or introduction is verified.",
      confidence: "low",
    });
    assert.doesNotMatch(JSON.stringify(normalized.maintainerDecision), /introduced the feature/);
    assert.throws(
      () =>
        parseDecision(
          closeDecision({
            likelyOwners: [{ ...owner(f), attributionSource: "raw_parent_line_v1" }],
          }),
        ),
      /unexpected keys/,
    );
    assert.throws(
      () =>
        parseDecision(
          closeDecision({
            regressionProvenance: {
              ...candidate(f.introduced),
              verificationSource: "raw_parent_line_v1",
            },
          }),
        ),
      /unexpected keys/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("local review publishes host facts through the report and public comment round trip", (t) => {
  useFakeScanner(t);
  const f = historyFixture();
  try {
    const fakeCodexScript = join(f.root, "fake-codex.mjs");
    const fakeCodex = join(f.root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
    writeFileSync(
      fakeCodexScript,
      `import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'sandbox') {
  const start = args.indexOf('--') + 1;
  const result = spawnSync(args[start], args.slice(start + 1), { encoding: 'utf8' });
  process.stdout.write(result.stdout ?? '');
  process.exit(result.status ?? 1);
}
fs.readFileSync(0, 'utf8');
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], fs.readFileSync(process.env.FIXTURE_DECISION));
`,
    );
    writeFileSync(
      fakeCodex,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`,
      { mode: 0o755 },
    );
    const decisionFile = join(f.root, "decision.json");
    const runReview = (checkout: string, owners: unknown[], name: string) => {
      const artifacts = join(f.root, name);
      writeFileSync(
        decisionFile,
        JSON.stringify(
          closeDecision({
            decision: "keep_open",
            closeReason: "none",
            summary: "Review complete.",
            evidence: [],
            likelyOwners: owners,
            maintainerDecision: {
              required: true,
              kind: "manual_review",
              question: "Which repair should proceed?",
              rationale: "A maintainer must select the repair scope.",
              options: [
                { title: "Review", body: "Inspect the relevant source.", recommended: true },
              ],
              likelyOwner: {
                person: "Model Guessed Person",
                reason: "Introduced the feature.",
                confidence: "high",
              },
            },
            fixedSha: null,
            fixedAt: null,
          }),
        ),
      );
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url)),
          "review",
          "--local-range",
          "--base",
          f.unrelated,
          "--target-repo",
          "openclaw/clawsweeper",
          "--target-dir",
          checkout,
          "--artifact-dir",
          artifacts,
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: "1",
            CODEX_BIN: fakeCodex,
            FIXTURE_DECISION: decisionFile,
          },
        },
      );
      const report = readFileSync(join(artifacts, "0.md"), "utf8");
      assert.equal(result.status, 0, result.stderr + result.stdout + report);
      return { report, comment: renderReviewCommentFromReport(report, "none") };
    };
    const routing = {
      ...owner(f),
      person: "@reviewer",
      history: null,
      commits: [],
      role: "reviewer who introduced everything",
    };
    const positive = runReview(
      f.source,
      [owner(f), owner(f, f.introduced, "committer"), routing],
      "positive",
    );
    for (const text of [positive.report, positive.comment]) {
      assert.match(text, /Code Author/);
      assert.match(text, /source-line author/);
      assert.match(text, /Fixture Committer/);
      assert.match(text, /source-line committer/);
      assert.match(text, /@​reviewer/);
      assert.match(text, /unverified routing candidate/);
      assert.doesNotMatch(text, /Model Guessed Person|introduced everything|Blame alone/);
    }
    assert.match(positive.report, /attribution source: raw_parent_line_v1/);
    assert.equal(maintainerDecisionFromReport(positive.report)?.likelyOwner.person, "Code Author");
    assert.match(
      positive.report,
      /^author: Tip Author$/m,
      "Current proposal author is independent of historical actors",
    );
    const checkout = f.shallow(true);
    const negative = runReview(checkout, [owner(f, f.unrelated)], "negative");
    assert.equal(maintainerDecisionFromReport(negative.report)?.likelyOwner.person, "unknown");
    assert.equal(maintainerDecisionFromReport(negative.report)?.likelyOwner.confidence, "low");
    for (const text of [negative.report, negative.comment]) {
      assert.match(text, /carried-forward source line/);
      assert.doesNotMatch(text, /Mobile Author|Model Guessed Person|introduced the feature/);
    }
    assert.equal(f.git(f.source, "status", "--porcelain"), "");
    assert.equal(f.git(checkout, "status", "--porcelain"), "");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
