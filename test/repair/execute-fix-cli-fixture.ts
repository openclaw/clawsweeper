import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { writeFakeScanner } from "../agent-input-scan-helpers.ts";

const GIT_CALL_MARKER = "@@git-call";

// Drives dist/repair/execute-fix-artifact.js against a local target repository.
// Fake gh, git and codex binaries record every call; git goes to a local bare remote.

type Json = Record<string, unknown>;

type FixtureRepo = {
  git: (...args: string[]) => string;
  remoteGit: (...args: string[]) => string;
  target: string;
  remote: string;
};

export type ExecuteFixFixtureOptions = {
  targetRepo?: string;
  clusterId?: string;
  source?: string;
  jobFields?: string[];
  // Complete job markdown. It replaces the job that the fixture writes.
  job?: string;
  fixArtifact?: Json;
  // Files in the base commit next to README.md.
  baseFiles?: Record<string, string>;
  // Head repository of PR #1. The default is a contributor fork that rejects real pushes.
  headRepo?: string;
  // Successive `gh api repos/<repo>/pulls/1` responses; the last one repeats.
  pulls?: Json[];
  prView?: Json;
  issue?: { number: number; state: string; labels: string[] };
  // Body of a function that runs inside the fake codex binary with
  // ctx = { callIndex, review, git, pushRemote(branch, file, content), fs }.
  codex?: string;
  // Runs on the target repository with main checked out, before the remote is cloned.
  setup?: (repo: FixtureRepo & { sourceHead: string }) => void;
  env?: Record<string, string>;
};

export type GitCall = { args: string[]; askpass: boolean; token: string | null };
export type CodexCall = { args: string[]; prompt: string; files: string[] };

export function runExecuteFixFixture(t: TestContext, options: ExecuteFixFixtureOptions = {}) {
  const targetRepo = options.targetRepo ?? "openclaw/fixture";
  const clusterId = options.clusterId ?? "automerge-fixture-1";
  const headRepo = options.headRepo ?? "contributor/fixture";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-execute-fix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const remote = path.join(root, "remote.git");
  const bin = path.join(root, "bin");
  fs.mkdirSync(target);
  fs.mkdirSync(bin);
  writeFakeScanner(bin);

  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (...args: string[]) =>
    execFileSync(realGit, args, { cwd: target, encoding: "utf8", stdio: "pipe" }).trim();
  const remoteGit = (...args: string[]) => git("--git-dir", remote, ...args);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(target, "README.md"), "Base.\n");
  for (const [file, content] of Object.entries(options.baseFiles ?? {})) {
    fs.writeFileSync(path.join(target, file), content);
  }
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
  const repo = { git, remoteGit, target, remote };
  options.setup?.({ ...repo, sourceHead });
  const baseSha = git("rev-parse", "main");
  git("clone", "--bare", target, remote);
  remoteGit("update-ref", "refs/pull/1/head", sourceHead);
  git("remote", "add", "origin", remote);
  git("fetch", "origin");

  const traces = {
    git: path.join(root, "git.trace"),
    codex: path.join(root, "codex.jsonl"),
    publication: path.join(root, "publication.jsonl"),
  };
  const sourceUrl = `https://github.com/${targetRepo}/pull/1`;
  const replacementUrl = `https://github.com/${targetRepo}/pull/2`;
  const defaultPull = {
    state: "open",
    user: { login: "octocat" },
    maintainer_can_modify: true,
    labels: [],
    head: { sha: sourceHead, ref: "contributor", repo: { full_name: headRepo } },
    base: { ref: "main", sha: baseSha, repo: { full_name: targetRepo } },
  };
  const config = {
    realGit,
    remote,
    targetRepo,
    traces,
    pulls: (options.pulls ?? [{}]).map((pull) => ({
      ...defaultPull,
      ...pull,
      head: { ...defaultPull.head, ...(pull.head as Json | undefined) },
    })),
    pullCounter: path.join(root, "pull-counter"),
    prView: {
      state: "OPEN",
      mergedAt: null,
      author: { login: "octocat", is_bot: false },
      title: "Contribution",
      body: "",
      headRefOid: sourceHead,
      statusCheckRollup: [],
      ...options.prView,
    },
    sourceUrl,
    replacementUrl,
    issue: options.issue ?? null,
    codex: options.codex ?? "",
  };
  const configPath = path.join(root, "fixture.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  writeFakeBinaries(bin, configPath, config);

  const job = path.join(root, "job.md");
  const result = path.join(root, "result.json");
  fs.writeFileSync(
    job,
    options.job ??
      [
        "---",
        `repo: ${targetRepo}`,
        `cluster_id: ${clusterId}`,
        "mode: autonomous",
        `source: ${options.source ?? "pr_automerge"}`,
        "allowed_actions: [fix, raise_pr]",
        "allow_fix_pr: true",
        "candidates: ['#1']",
        "canonical: ['#1']",
        ...(options.jobFields ?? []),
        "---",
        "Fixture",
        "",
      ].join("\n"),
  );
  fs.writeFileSync(
    result,
    JSON.stringify({
      repo: targetRepo,
      cluster_id: clusterId,
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
        repair_strategy: "repair_contributor_branch",
        source_prs: [sourceUrl],
        deterministic_rebase_only: true,
        ...options.fixArtifact,
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
      timeout: 300_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([path.join(bin, "gh.cjs")]),
        CODEX_BIN: path.join(bin, "codex"),
        GH_TOKEN: "fixture-token",
        GITHUB_TOKEN: "",
        GITHUB_ACTIONS: "",
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOW_FIX_PR: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_MODEL: "fixture-model",
        CLAWSWEEPER_INSTALL_TARGET_DEPS: "0",
        CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS: "0",
        CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT: "0",
        CLAWSWEEPER_CLOSE_SUPERSEDED_SOURCE_PRS: "0",
        ...options.env,
      },
    },
  );
  const reportPath = path.join(root, "fix-execution-report.json");
  return {
    ...repo,
    baseSha,
    sourceHead,
    replacementUrl,
    workRoot: path.join(root, "fix-execution"),
    status: child.status,
    output: `${child.stdout}\n${child.stderr}`,
    report: fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null,
    gitCalls: readGitCalls(traces.git),
    codexCalls: readJsonLines<CodexCall>(traces.codex),
    publications: readJsonLines<Json>(traces.publication),
  };
}

export function branchPushes(calls: GitCall[]) {
  return calls.filter((call) => call.args.includes("push") && !call.args.includes("--dry-run"));
}

function readGitCalls(file: string): GitCall[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(`${GIT_CALL_MARKER}\0`)
    .slice(1)
    .map((record) => {
      const [askpass, token, ...args] = record.split("\0").slice(0, -1);
      return { args, askpass: askpass === "1", token: token || null };
    });
}

function readJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function writeFakeBinaries(
  bin: string,
  configPath: string,
  config: { realGit: string; remote: string; targetRepo: string; traces: { git: string } },
) {
  const header = `const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const args = process.argv.slice(2);
`;
  // The repair runs hundreds of git commands, so this wrapper stays in sh.
  // Each call is written as: marker, askpass flag, token, args; all NUL-terminated.
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
{
  printf '${GIT_CALL_MARKER}\\0%s\\0%s\\0' "\${GIT_ASKPASS:+1}" "\${CLAWSWEEPER_GIT_TOKEN-}"
  for arg in "$@"; do printf '%s\\0' "$arg"; done
} >> '${config.traces.git}'
push=0; dry=0; fork=0
for arg in "$@"; do
  case "$arg" in
    push) push=1 ;;
    --dry-run) dry=1 ;;
    https://github.com/contributor/fixture.git) fork=1 ;;
  esac
done
if [ "$push" = 1 ] && [ "$fork" = 1 ]; then
  [ "$dry" = 1 ] && exit 0
  echo "refusing to allow a GitHub App to create or update workflow .github/workflows/test.yml without workflows permission" >&2
  exit 1
fi
count=$#
for arg in "$@"; do
  case "$arg" in
    'https://github.com/${config.targetRepo}.git') arg='${config.remote}' ;;
    http://*|https://*) echo "unexpected network Git command: $arg" >&2; exit 1 ;;
  esac
  set -- "$@" "$arg"
done
shift "$count"
exec '${config.realGit}' "$@"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "gh.cjs"),
    `${header}
const repo = config.targetRepo;
const endpoint = args[1] || "";
const publish = (entry) => fs.appendFileSync(config.traces.publication, JSON.stringify(entry) + "\\n");
const remoteRef = (ref) => {
  const child = spawnSync(config.realGit, ["--git-dir", config.remote, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" });
  return child.status === 0 ? child.stdout.trim() : "";
};
if (args[0] === "api" && endpoint === "repos/" + repo + "/pulls/1") {
  const count = fs.existsSync(config.pullCounter) ? Number(fs.readFileSync(config.pullCounter, "utf8")) : 0;
  fs.writeFileSync(config.pullCounter, String(count + 1));
  console.log(JSON.stringify(config.pulls[Math.min(count, config.pulls.length - 1)]));
} else if (args[0] === "api" && endpoint.startsWith("repos/" + repo + "/git/ref/heads/")) {
  const sha = remoteRef("refs/heads/" + decodeURIComponent(endpoint.split("/git/ref/heads/")[1]));
  if (!sha) { console.error("Not Found (HTTP 404)"); process.exit(1); }
  console.log(sha);
} else if (config.issue && args[0] === "api" && endpoint === "repos/" + repo + "/issues/" + config.issue.number) {
  console.log(JSON.stringify({ state: config.issue.state, labels: config.issue.labels }));
} else if (args[0] === "api" && endpoint === "graphql") {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }));
} else if (args[0] === "api" && endpoint.includes("/comments")) {
  console.log("[]");
} else if (args[0] === "api" && endpoint === "users/octocat") {
  console.log(JSON.stringify({ id: 1, login: "octocat", name: "Mona Octocat" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ ...config.prView, url: args[2] === "1" ? config.sourceUrl : config.replacementUrl }));
} else if (args[0] === "pr" && args[1] === "list") {
  console.log(args.includes("--jq") ? "" : "[]");
} else if (args[0] === "pr" && args[1] === "create") {
  publish({ kind: "pr", body: fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8") });
  console.log(config.replacementUrl);
} else if (args[0] === "pr" && args[1] === "comment") {
  publish({ kind: "comment", number: args[2], body: args[args.indexOf("--body") + 1] });
} else if (args[0] === "pr" && args[1] === "close") {
  publish({ kind: "close", number: args[2] });
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit") || (args[0] === "pr" && args[1] === "edit")) {
  console.log("");
} else {
  console.error("unexpected gh command", JSON.stringify(args));
  process.exit(1);
}
`,
  );
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
${header}
const os = require("node:os");
const path = require("node:path");
const prompt = fs.readFileSync(0, "utf8");
const review = args.includes("--output-schema");
const outputPath = args[args.indexOf("--output-last-message") + 1];
const git = (...gitArgs) => execFileSync(config.realGit, gitArgs, { encoding: "utf8" }).trim();
fs.appendFileSync(config.traces.codex, JSON.stringify({
  args,
  prompt,
  files: fs.readdirSync(".").filter((name) => name !== ".git").sort(),
}) + "\\n");
// Another writer commits one file to a remote branch while this worker runs.
const pushRemote = (branch, file, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-remote-writer-"));
  git("clone", "--quiet", "--branch", branch, config.remote, dir);
  fs.writeFileSync(path.join(dir, file), content);
  git("-C", dir, "add", file);
  git("-C", dir, "-c", "user.name=Writer", "-c", "user.email=writer@example.invalid", "commit", "--quiet", "-m", "write " + file);
  git("-C", dir, "push", "--quiet", "origin", "HEAD:" + branch);
  fs.rmSync(dir, { recursive: true, force: true });
};
const callIndex = fs.readFileSync(config.traces.codex, "utf8").trim().split("\\n").length;
new Function("ctx", config.codex)({ callIndex, review, git, pushRemote, fs });
if (!fs.existsSync(outputPath)) {
  fs.writeFileSync(outputPath, review
    ? JSON.stringify({ status: "clean", summary: "Fixture review", findings: [], findings_addressed: true, evidence: [] })
    : "No repair needed.");
}
`,
    { mode: 0o755 },
  );
}
