#!/usr/bin/env node

// Controlled proof for changelog fragments. For one Git revision of this
// repository it exports the tree with `git archive`, then exercises that
// revision's own changelog mechanism with real `git` and `node`:
//
//   A. two concurrent PRs each add a changelog entry and one merges `main`;
//   B. `scripts/changelog-stitch.mjs` folds three fragments into the real
//      CHANGELOG.md copy, is rerun (idempotence), and a second copy with a
//      different fragment creation order is compared (determinism);
//   C. `pnpm run check:changelog` and `check:static` membership against a
//      malformed fragment.
//
// It also records, independently of the revision, whether the merge-only
// carry-forward preconditions from the lane order would hold for the
// CHANGELOG-conflict case (D).
//
// Usage: node docs/proof/changelog-fragments/run-proof.mjs --rev <rev> --out <file>
// The receipt contains no absolute paths: temporary roots become <tmp>.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const rev = option("--rev");
const out = option("--out");
if (!rev || !out) throw new Error("usage: run-proof.mjs --rev <rev> --out <file>");

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sha = execFileSync("git", ["-C", repo, "rev-parse", `${rev}^{commit}`], {
  encoding: "utf8",
}).trim();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "changelog-fragments-proof-")));
// Isolate synthetic repositories from the operator's Git configuration (hooks, signing).
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "proof",
  GIT_AUTHOR_EMAIL: "proof@example.invalid",
  GIT_COMMITTER_NAME: "proof",
  GIT_COMMITTER_EMAIL: "proof@example.invalid",
  GIT_AUTHOR_DATE: "2026-09-30T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-30T00:00:00Z",
};
const normalize = (text) => String(text ?? "").replaceAll(tmp, "<tmp>").replaceAll(repo, "<repo>");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const git = (cwd, ...gitArgs) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...gitArgs], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  }).trim();
const tryGit = (cwd, ...gitArgs) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", ...gitArgs], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  });
const exec = (cwd, command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  return {
    command: [command === process.execPath ? "node" : command, ...commandArgs]
      .map(normalize)
      .join(" "),
    status: result.status,
    stdout: normalize(result.stdout).trim(),
    stderr: normalize(result.stderr).trim().split("\n").slice(0, 8).join("\n"),
  };
};

function exportTree(name) {
  const target = path.join(tmp, name);
  fs.mkdirSync(target);
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha], {
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", target], { input: archive });
  return target;
}

const tree = exportTree("tree");
const hasFragments = fs.existsSync(path.join(tree, "scripts", "changelog-stitch.mjs"));
const changelogText = fs.readFileSync(path.join(tree, "CHANGELOG.md"), "utf8");
const unreleasedHeading = changelogText.split("\n").find((line) => / - Unreleased$/.test(line));

// Each revision's documented way to add an entry: fragments when the stitch
// exists, otherwise the legacy insertion at the top of the Unreleased section.
function addEntry(cwd, slug, bullet) {
  if (hasFragments) {
    fs.writeFileSync(path.join(cwd, "changelog.d", `${slug}.md`), `${bullet}\n`);
    return `changelog.d/${slug}.md`;
  }
  const file = path.join(cwd, "CHANGELOG.md");
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace(`${unreleasedHeading}\n\n`, `${unreleasedHeading}\n\n${bullet}\n`));
  return "CHANGELOG.md";
}

// A. Concurrent PRs.
function concurrentPullRequests() {
  const cwd = path.join(tmp, "concurrent");
  fs.mkdirSync(path.join(cwd, "changelog.d"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), changelogText);
  if (hasFragments) fs.copyFileSync(path.join(tree, "changelog.d", "README.md"), path.join(cwd, "changelog.d", "README.md"));
  else fs.writeFileSync(path.join(cwd, "changelog.d", ".keep"), "");
  git(cwd, "init", "-q");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "switch", "-q", "-c", "pr-a");
  const prFile = addEntry(cwd, "pr-a-entry", "- Synthetic PR A entry.");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "PR A");
  git(cwd, "switch", "-q", "main");
  git(cwd, "switch", "-q", "-c", "pr-b");
  addEntry(cwd, "pr-b-entry", "- Synthetic PR B entry.");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "PR B");
  git(cwd, "switch", "-q", "main");
  git(cwd, "merge", "-q", "--ff-only", "pr-b");
  git(cwd, "switch", "-q", "pr-a");
  const merge = tryGit(cwd, "merge", "--no-edit", "main");
  const conflicted = git(cwd, "diff", "--name-only", "--diff-filter=U")
    .split("\n")
    .filter(Boolean);
  const result = {
    pr_entry_file: prFile,
    merge_exit_status: merge.status,
    merge_conflicted: conflicted.length > 0,
    conflicted_paths: conflicted,
  };
  if (merge.status === 0 && hasFragments) {
    result.merged_tree_check = exec(cwd, process.execPath, [
      path.join(tree, "scripts", "changelog-stitch.mjs"),
      "--check",
      "--root",
      cwd,
    ]);
  } else if (merge.status !== 0) {
    tryGit(cwd, "merge", "--abort");
  }
  return result;
}

// B. Stitch, idempotence, determinism.
function stitchScenario() {
  const fragments = [
    ["docs-gamma.md", "- Synthetic gamma entry."],
    ["1720-alpha.md", "- Synthetic alpha entry."],
    ["1719-beta.md", "- Synthetic beta entry."],
  ];
  const copy = (name, order) => {
    const cwd = exportTree(name);
    fs.mkdirSync(path.join(cwd, "changelog.d"), { recursive: true });
    for (const [file, bullet] of order) fs.writeFileSync(path.join(cwd, "changelog.d", file), `${bullet}\n`);
    return cwd;
  };
  const first = copy("stitch-first", fragments);
  const second = copy("stitch-second", [...fragments].reverse());
  const script = path.join("scripts", "changelog-stitch.mjs");
  const before = fs.readFileSync(path.join(first, "CHANGELOG.md"), "utf8");
  // Pending fragments in the exported tree (the PR's own) are stitched too.
  const pending = fs
    .readdirSync(path.join(first, "changelog.d"))
    .filter((file) => file !== "README.md")
    .sort()
    .map((file) => fs.readFileSync(path.join(first, "changelog.d", file), "utf8"));
  const run1 = exec(first, process.execPath, [script]);
  if (run1.status !== 0) return { first_run: run1, stitched: false };
  const afterFirst = fs.readFileSync(path.join(first, "CHANGELOG.md"), "utf8");
  const run2 = exec(first, process.execPath, [script]);
  const afterSecond = fs.readFileSync(path.join(first, "CHANGELOG.md"), "utf8");
  const run3 = exec(second, process.execPath, [script]);
  const otherOrder = fs.readFileSync(path.join(second, "CHANGELOG.md"), "utf8");
  const lines = afterFirst.split("\n");
  const headingIndex = lines.indexOf(unreleasedHeading);
  return {
    first_run: run1,
    stitched: true,
    remaining_fragments_after_first_run: fs
      .readdirSync(path.join(first, "changelog.d"))
      .filter((file) => file !== "README.md")
      .sort(),
    unreleased_head_after_first_run: lines.slice(headingIndex, headingIndex + 6),
    changelog_sha256_before: digest(before),
    changelog_sha256_after_first_run: digest(afterFirst),
    changelog_bytes_added: Buffer.byteLength(afterFirst) - Buffer.byteLength(before),
    only_insertion:
      afterFirst === before.replace(`${unreleasedHeading}\n\n`, `${unreleasedHeading}\n\n${pending.join("")}`),
    second_run: run2,
    idempotent: afterSecond === afterFirst,
    reversed_creation_order_run: run3,
    deterministic: otherOrder === afterFirst,
  };
}

// C. Validation rejects a malformed fragment, through the package script.
function validationScenario() {
  const cwd = exportTree("validation");
  fs.mkdirSync(path.join(cwd, "changelog.d"), { recursive: true });
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  const valid = exec(cwd, "pnpm", ["run", "--silent", "check:changelog"]);
  // A real entry from the newest released section, as a stale keep-both merge would re-add it.
  const lines = changelogText.split("\n");
  const releasedHeading = lines.findIndex((line) => /^## \S+ - \d{4}-\d{2}-\d{2}$/.test(line));
  const releasedEntry = lines.slice(releasedHeading).find((line) => line.startsWith("- "));
  fs.writeFileSync(path.join(cwd, "changelog.d", "malformed.md"), "- First line.\n- Second line.\n");
  fs.writeFileSync(path.join(cwd, "changelog.d", "stale.md"), `${releasedEntry}\n`);
  const rejected = exec(cwd, "pnpm", ["run", "--silent", "check:changelog"]);
  return {
    check_static_runs_check_changelog: /check:changelog/.test(packageJson.scripts["check:static"] ?? ""),
    clean_tree: valid,
    stale_entry_sha256: digest(releasedEntry),
    malformed_and_stale_fragments: rejected,
  };
}

// D. Revision-independent diagnostic for the Part 2 carry-forward preconditions.
function carryForwardDiagnostic() {
  const cwd = path.join(tmp, "carry-forward");
  fs.mkdirSync(cwd);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  };
  const changelog = "# Changelog\n\n## 0.3.1 - Unreleased\n\n- Older entry one.\n- Older entry two.\n- Older entry three.\n";
  write("CHANGELOG.md", changelog);
  write("src/feature.ts", "export const feature = 1;\n");
  write("src/other.ts", "export const other = 1;\n");
  git(cwd, "init", "-q");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "switch", "-q", "-c", "pr");
  write("src/feature.ts", "export const feature = 2;\n");
  write("CHANGELOG.md", changelog.replace("Unreleased\n\n", "Unreleased\n\n- PR entry.\n"));
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "PR change");
  const reviewedHead = git(cwd, "rev-parse", "HEAD");
  const patchId = (base, head) =>
    execFileSync("git", ["patch-id", "--stable"], {
      cwd,
      env: gitEnv,
      input: execFileSync("git", ["diff", `${base}..${head}`], { cwd, env: gitEnv }),
      encoding: "utf8",
    }).split(" ")[0];
  const prFiles = (base, head) => git(cwd, "diff", "--name-only", `${base}..${head}`).split("\n").filter(Boolean);
  const reviewedBase = git(cwd, "merge-base", "main", reviewedHead);
  const reviewed = { patch_id: patchId(reviewedBase, reviewedHead), files: prFiles(reviewedBase, reviewedHead) };

  const evaluate = (label, mutateMain, resolve) => {
    git(cwd, "switch", "-q", "main");
    mutateMain();
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", `main ${label}`);
    git(cwd, "switch", "-q", "-c", `pr-${label}`, reviewedHead);
    const merge = tryGit(cwd, "merge", "--no-edit", "main");
    if (merge.status !== 0) {
      resolve();
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "--no-edit");
    }
    const head = git(cwd, "rev-parse", "HEAD");
    const base = git(cwd, "merge-base", "main", head);
    const baseChanged = git(cwd, "diff", "--name-only", `${reviewedBase}..${base}`).split("\n").filter(Boolean);
    const touchedByBoth = reviewed.files.filter((file) => baseChanged.includes(file));
    const id = patchId(base, head);
    git(cwd, "switch", "-q", "main");
    git(cwd, "reset", "-q", "--hard", reviewedBase);
    return {
      merge_conflicted: merge.status !== 0,
      patch_id_equal: id === reviewed.patch_id,
      pr_files_changed_between_merge_bases: touchedByBoth,
      carry_forward_preconditions_hold: id === reviewed.patch_id && touchedByBoth.length === 0,
    };
  };
  return {
    changelog_conflict_merge: evaluate(
      "changelog",
      () => write("CHANGELOG.md", changelog.replace("Unreleased\n\n", "Unreleased\n\n- Other PR entry.\n")),
      () =>
        write(
          "CHANGELOG.md",
          changelog.replace("Unreleased\n\n", "Unreleased\n\n- PR entry.\n- Other PR entry.\n"),
        ),
    ),
    unrelated_base_merge: evaluate(
      "unrelated",
      () => write("src/other.ts", "export const other = 2;\n"),
      () => {
        throw new Error("unexpected conflict");
      },
    ),
  };
}

const receipt = {
  proof: "changelog-fragments",
  revision: sha,
  mechanism: hasFragments ? "changelog.d fragments" : "direct CHANGELOG.md insertion",
  environment: {
    node: process.version,
    git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    platform: `${process.platform}-${process.arch}`,
  },
  changelog_sha256: digest(changelogText),
  unreleased_heading: unreleasedHeading,
  concurrent_pull_requests: concurrentPullRequests(),
  stitch: stitchScenario(),
  validation: validationScenario(),
  diagnostic_merge_only_carry_forward: carryForwardDiagnostic(),
};
fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${out}: ${digest(fs.readFileSync(out))}`);
