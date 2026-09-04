import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeFakeScanner } from "../agent-input-scan-helpers.ts";

for (const strategy of ["repair_contributor_branch", "replace_uneditable_branch"]) {
  test(
    `replacement publication preserves contributor credit via ${strategy}`,
    { skip: process.platform === "win32" },
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fast-rebase-"));
      try {
        const target = path.join(root, "target");
        const remote = path.join(root, "remote.git");
        const bin = path.join(root, "bin");
        fs.mkdirSync(target);
        fs.mkdirSync(bin);
        writeFakeScanner(bin);
        const codex = path.join(bin, "codex");
        fs.writeFileSync(
          codex,
          `#!${process.execPath}
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
assert.ok(args.includes("--output-schema"), "only a review is expected");
fs.readFileSync(0, "utf8");
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
  status: "clean", summary: "Fixture review", findings: [], findings_addressed: true, evidence: []
}));
`,
          { mode: 0o755 },
        );
        const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
        const git = (...args: string[]) =>
          execFileSync(realGit, args, { cwd: target, encoding: "utf8" }).trim();
        git("init", "-b", "main");
        git("config", "user.name", "Fixture Author");
        git("config", "user.email", "fixture@example.invalid");
        fs.writeFileSync(path.join(target, "README.md"), "Base.\n");
        git("add", ".");
        git("commit", "-m", "base");
        git("checkout", "-b", "contributor");
        fs.writeFileSync(path.join(target, "CONTRIBUTING.md"), "Contribution.\n");
        git("add", ".");
        git("commit", "-m", "contributor change");
        fs.appendFileSync(path.join(target, "CONTRIBUTING.md"), "Follow-up.\n");
        git("commit", "-am", "contributor follow-up");
        const sourceHead = git("rev-parse", "HEAD");
        git("checkout", "main");
        fs.appendFileSync(path.join(target, "README.md"), "New base.\n");
        git("commit", "-am", "advance base");
        const baseSha = git("rev-parse", "HEAD");
        git("clone", "--bare", target, remote);
        git("--git-dir", remote, "update-ref", "refs/pull/1/head", sourceHead);
        git("remote", "add", "origin", remote);
        git("fetch", "origin");
        const trace = path.join(root, "commands.jsonl");
        fs.writeFileSync(
          path.join(bin, "git"),
          `#!/bin/sh\nexec '${process.execPath}' '${path.join(bin, "git.cjs")}' "$@"\n`,
          { mode: 0o755 },
        );
        fs.writeFileSync(
          path.join(bin, "git.cjs"),
          `
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
if (args.includes("push") && args.includes("https://github.com/contributor/fixture.git")) {
  if (args.includes("--dry-run")) process.exit(0);
  console.error("refusing to allow a GitHub App to create or update workflow .github/workflows/test.yml without workflows permission");
  process.exit(1);
}
const localArgs = args.map(arg => arg === "https://github.com/openclaw/fixture.git" ? ${JSON.stringify(remote)} : arg);
if (localArgs.some(arg => /^https?:/.test(arg))) throw new Error("unexpected network Git command");
const child = spawnSync(${JSON.stringify(realGit)}, localArgs, { stdio: "inherit", env: process.env });
process.exit(child.status ?? 1);
`,
        );
        const sourceUrl = "https://github.com/openclaw/fixture/pull/1";
        const replacementUrl = "https://github.com/openclaw/fixture/pull/2";
        const gh = path.join(bin, "gh.cjs");
        const publicationTrace = path.join(root, "publication.jsonl");
        fs.writeFileSync(
          gh,
          `
const args = process.argv.slice(2);
const fs = require("node:fs");
const endpoint = args[1] || "";
if (args[0] === "api" && endpoint === "repos/openclaw/fixture/pulls/1") {
  console.log(JSON.stringify({ state: "open", maintainer_can_modify: true, labels: [], head: { sha: ${JSON.stringify(sourceHead)}, ref: "contributor", repo: { full_name: "contributor/fixture" } }, base: { ref: "main", sha: ${JSON.stringify(baseSha)} } }));
} else if (args[0] === "api" && endpoint.includes("/git/ref/")) {
  console.error("Not Found (HTTP 404)"); process.exit(1);
} else if (args[0] === "api" && endpoint === "graphql") {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }));
} else if (args[0] === "api" && endpoint.includes("/comments")) {
  console.log("[]");
} else if (args[0] === "api" && endpoint === "users/octocat") {
  console.log(JSON.stringify({ id: 1, login: "octocat", name: "Mona Octocat" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ state: "OPEN", mergedAt: null, author: { login: "octocat", is_bot: false }, title: "Contribution", url: args[2] === "1" ? ${JSON.stringify(sourceUrl)} : ${JSON.stringify(replacementUrl)}, body: "", headRefOid: ${JSON.stringify(sourceHead)}, statusCheckRollup: [] }));
} else if (args[0] === "pr" && args[1] === "list") {
  console.log(args.includes("--jq") ? "" : "[]");
} else if (args[0] === "pr" && args[1] === "create") {
  fs.appendFileSync(${JSON.stringify(publicationTrace)}, JSON.stringify({ kind: "pr", body: fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8") }) + "\\n");
  console.log(${JSON.stringify(replacementUrl)});
} else if (args[0] === "pr" && args[1] === "comment") {
  fs.appendFileSync(${JSON.stringify(publicationTrace)}, JSON.stringify({ kind: "comment", number: args[2], body: args[args.indexOf("--body") + 1] }) + "\\n");
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit") || (args[0] === "pr" && args[1] === "edit")) {
  console.log("");
} else {
  console.error("unexpected gh command", JSON.stringify(args)); process.exit(1);
}
`,
        );
        const job = path.join(root, "job.md");
        const result = path.join(root, "result.json");
        fs.writeFileSync(
          job,
          "---\nrepo: openclaw/fixture\ncluster_id: automerge-fixture-1\nmode: autonomous\nsource: pr_automerge\nallowed_actions: [fix, raise_pr]\nallow_fix_pr: true\ncandidates: ['#1']\ncanonical: ['#1']\n---\nFixture\n",
        );
        fs.writeFileSync(
          result,
          JSON.stringify({
            repo: "openclaw/fixture",
            cluster_id: "automerge-fixture-1",
            mode: "autonomous",
            canonical_pr: sourceUrl,
            reviewed_sha: sourceHead,
            actions: [{ action: "fix_needed", target: sourceUrl, status: "planned" }],
            fix_artifact: {
              summary: "Rebase contribution",
              pr_title: "fix: preserve contribution",
              pr_body: "Preserve the contribution on current main.",
              affected_surfaces: ["docs"],
              likely_files: ["CONTRIBUTING.md"],
              linked_refs: [sourceUrl],
              validation_commands: ["git diff --check"],
              credit_notes: ["Fixture contribution"],
              changelog_required: false,
              repair_strategy: strategy,
              source_prs: [sourceUrl],
              deterministic_rebase_only: true,
            },
          }),
        );
        const child = spawnSync(
          process.execPath,
          [
            path.resolve("dist/repair/execute-fix-artifact.js"),
            job,
            result,
            "--target-dir",
            target,
            "--defer-publication",
          ],
          {
            encoding: "utf8",
            timeout: 120_000,
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              GH_BIN: process.execPath,
              GH_BIN_ARGS: JSON.stringify([gh]),
              CODEX_BIN:
                strategy === "repair_contributor_branch"
                  ? path.join(bin, "unexpected-codex")
                  : codex,
              GH_TOKEN: "fixture-token",
              GITHUB_TOKEN: "",
              CLAWSWEEPER_ALLOW_EXECUTE: "1",
              CLAWSWEEPER_ALLOW_FIX_PR: "1",
              CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
              CLAWSWEEPER_MODEL: "fixture-model",
              CLAWSWEEPER_INSTALL_TARGET_DEPS: "0",
              CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS: "0",
              CLAWSWEEPER_CLOSE_SUPERSEDED_SOURCE_PRS: "0",
            },
          },
        );
        assert.equal(child.status, 0, child.stdout + child.stderr);
        if (strategy === "repair_contributor_branch") {
          assert.match(child.stdout, /automerge deterministic rebase validated/);
          assert.match(child.stdout, /repair branch push blocked; publishing prepared repair/);
        }
        const report = JSON.parse(
          fs.readFileSync(path.join(root, "fix-execution-report.json"), "utf8"),
        );
        assert.equal(report.status, "opened", JSON.stringify(report));
        const published = report.actions.find((action) => action.action === "open_fix_pr");
        assert.equal(published.pr_url, replacementUrl);
        assert.equal(git("rev-parse", `${published.commit}^`), baseSha);
        assert.equal(
          git("--git-dir", remote, "rev-parse", "refs/heads/clawsweeper/automerge-fixture-1"),
          published.commit,
        );
        assert.equal(
          git("show", `${published.commit}:CONTRIBUTING.md`),
          "Contribution.\nFollow-up.",
        );
        const publications = fs
          .readFileSync(publicationTrace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.match(
          publications.find((entry) => entry.kind === "pr").body,
          /Original contributor: @octocat\./,
        );
        const comments = publications.filter((entry) => entry.kind === "comment");
        assert.equal(comments.length, 1);
        assert.equal(comments[0].number, "1");
        assert.match(comments[0].body, /Source PR status: left open/);
        assert.match(
          comments[0].body,
          /@octocat: Co-authored-by: Mona Octocat <1\+octocat@users\.noreply\.github\.com>/,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
