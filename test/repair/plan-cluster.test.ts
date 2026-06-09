import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("plan-cluster carries worker target checkout into artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-cluster-"));
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const targetCheckout = path.join(tmp, "target-openclaw");

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: clawsweeper-commit-openclaw-openclaw-deadbeef0000",
      "mode: autonomous",
      "allowed_actions:",
      "  - fix",
      "  - raise_pr",
      "source: clawsweeper_commit",
      "commit_sha: deadbeef00000000000000000000000000000000",
      "allow_fix_pr: true",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Repair the finding.",
      "",
    ].join("\n"),
  );

  execFileSync(
    process.execPath,
    ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir, "--offline"],
    {
      cwd: process.cwd(),
      env: { ...process.env, CLAWSWEEPER_TARGET_CHECKOUT: targetCheckout },
      stdio: "pipe",
    },
  );

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  const fixArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "fix-artifact.json"), "utf8"));

  assert.equal(clusterPlan.target_checkout, targetCheckout);
  assert.equal(fixArtifact.target_checkout, targetCheckout);
});

test("plan-cluster hydrates the repository default branch instead of hard-coding main", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-default-branch-"));
  const binDir = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), fakeGhScript(), { mode: 0o755 });

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: issue-implementation-openclaw-openclaw-74134",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "canonical:",
      "  - #74134",
      "candidates:",
      "  - #74134",
      "allow_fix_pr: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Plan this item.",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_DEFAULT_BRANCH: "master",
    },
    stdio: "pipe",
  });

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  assert.deepEqual(clusterPlan.main, {
    name: "master",
    sha: "master-sha",
    url: "https://github.com/openclaw/openclaw/tree/master",
  });
});

test("plan-cluster allows security repair for adopted PR autofix jobs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-security-autofix-"));
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-74134",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "source: pr_automerge",
      "canonical:",
      "  - #74134",
      "candidates:",
      "  - #74134",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Maintainer opted #74134 into ClawSweeper autofix.",
      "<!-- clawsweeper-security:security-sensitive item=74134 sha=abc123 -->",
      "",
    ].join("\n"),
  );

  execFileSync(
    process.execPath,
    ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir, "--offline"],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  const fixArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "fix-artifact.json"), "utf8"));

  assert.deepEqual(clusterPlan.security_boundary.security_sensitive_items, []);
  assert.deepEqual(clusterPlan.security_boundary.security_repair_allowed_items, ["#74134"]);
  assert.equal(clusterPlan.items[0].security_sensitive, false);
  assert.equal(clusterPlan.items[0].security_repair_allowed, true);
  assert.equal(
    clusterPlan.items[0].classification_hint,
    "security_sensitive_fix_allowed_by_opt_in",
  );
  assert.equal(fixArtifact.item_matrix[0].security_repair_allowed, true);
});

test("plan-cluster allows security repair for linked PRs with automation opt-in labels", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-linked-security-"));
  const binDir = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), fakeGhScript(), { mode: 0o755 });

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-74134",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "source: pr_automerge",
      "canonical:",
      "  - #74134",
      "candidates:",
      "  - #74134",
      "cluster_refs:",
      "  - #74134",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Maintainer opted #74134 into ClawSweeper autofix.",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CLAWSWEEPER_MAX_LINKED_REFS: "1",
    },
    stdio: "pipe",
  });

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  const linkedItem = clusterPlan.items.find((item) => item.ref === "#74742");

  assert.ok(linkedItem, "linked replacement PR should be hydrated");
  assert.equal(linkedItem.security_sensitive, false);
  assert.equal(linkedItem.security_repair_allowed, true);
  assert.equal(linkedItem.classification_hint, "security_sensitive_fix_allowed_by_opt_in");
  assert.deepEqual(clusterPlan.security_boundary.security_repair_allowed_items, ["#74742"]);
});

test("plan-cluster treats same-repo PR branches as writable despite raw maintainer flag", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-same-repo-writable-"));
  const binDir = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), fakeGhScript(), { mode: 0o755 });

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-74134",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "source: pr_automerge",
      "canonical:",
      "  - #74134",
      "candidates:",
      "  - #74134",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Maintainer opted #74134 into ClawSweeper automerge.",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_MAINTAINER_CAN_MODIFY: "false",
    },
    stdio: "pipe",
  });

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  const pull = clusterPlan.items[0].pull_request;

  assert.equal(pull.maintainer_can_modify, false);
  assert.equal(pull.same_repo_head, true);
  assert.equal(pull.branch_writable, true);
  assert.match(pull.branch_write_reason, /same-repo head branch/);
});

test("plan-cluster bounds PR file and commit hydration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-bounded-pr-"));
  const binDir = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), fakeGhScript(), { mode: 0o755 });

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-74134",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "source: pr_automerge",
      "canonical:",
      "  - #74134",
      "candidates:",
      "  - #74134",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Maintainer opted #74134 into ClawSweeper automerge.",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_LARGE_PR: "1",
      CLAWSWEEPER_MAX_FILES_PER_PR: "eighty",
      CLAWSWEEPER_MAX_COMMITS_PER_PR: "many",
    },
    stdio: "pipe",
  });

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  const pull = clusterPlan.items[0].pull_request;

  assert.equal(pull.changed_files, 120);
  assert.equal(pull.files_hydrated, 80);
  assert.equal(pull.files_truncated, 40);
  assert.equal(pull.files.length, 80);
  assert.equal(pull.commits_count, 120);
  assert.equal(pull.commits_hydrated, 80);
  assert.equal(pull.commits_truncated, 40);
  assert.equal(pull.commits.length, 80);
});

test("plan-cluster bounded PR hydration follows multiple GitHub pages", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-plan-bounded-pr-pages-"));
  const binDir = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const ghLog = path.join(tmp, "gh.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), fakeGhScript(), { mode: 0o755 });

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-74134",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "source: pr_automerge",
      "canonical:",
      "  - #74134",
      "candidates:",
      "  - #74134",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Maintainer opted #74134 into ClawSweeper automerge.",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, ["dist/repair/plan-cluster.js", jobPath, "--run-dir", runDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_LARGE_PR: "1",
      FAKE_GH_LARGE_PR_COUNT: "150",
      FAKE_GH_LOG: ghLog,
      CLAWSWEEPER_MAX_FILES_PER_PR: "150",
      CLAWSWEEPER_MAX_COMMITS_PER_PR: "150",
    },
    stdio: "pipe",
  });

  const clusterPlan = JSON.parse(fs.readFileSync(path.join(runDir, "cluster-plan.json"), "utf8"));
  const pull = clusterPlan.items[0].pull_request;
  const ghCalls = fs.readFileSync(ghLog, "utf8");

  assert.equal(pull.changed_files, 150);
  assert.equal(pull.files_hydrated, 150);
  assert.equal(pull.files_truncated, 0);
  assert.equal(pull.files.length, 150);
  assert.equal(pull.commits_count, 150);
  assert.equal(pull.commits_hydrated, 150);
  assert.equal(pull.commits_truncated, 0);
  assert.equal(pull.commits.length, 150);
  assert.equal((ghCalls.match(/pulls\/74134\/files\?per_page=100&page=/g) ?? []).length, 2);
  assert.equal((ghCalls.match(/pulls\/74134\/commits\?per_page=100&page=/g) ?? []).length, 2);
});

function fakeGhScript() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(" ") + "\\n");
function write(value) {
  process.stdout.write(JSON.stringify(value));
}
function isPaged() {
  return args.includes("--paginate") && args.includes("--slurp");
}
if (args[0] === "pr" && args[1] === "checks") {
  write([]);
  process.exit(0);
}
if (args[0] !== "api") {
  console.error("unexpected gh args: " + args.join(" "));
  process.exit(1);
}
const endpoint = args[1];
const defaultBranch = process.env.FAKE_DEFAULT_BRANCH || "main";
if (endpoint === "repos/openclaw/openclaw") {
  write({ default_branch: defaultBranch });
  process.exit(0);
}
if (endpoint === "repos/openclaw/openclaw/branches/" + encodeURIComponent(defaultBranch)) {
  write({ commit: { sha: defaultBranch + "-sha" }, _links: { html: "https://github.com/openclaw/openclaw/tree/" + defaultBranch } });
  process.exit(0);
}
if (isPaged()) {
  write([pagedResponse(endpoint)]);
  process.exit(0);
}
if (/\\?(?:.*&)?per_page=/.test(endpoint)) {
  write(pagedResponse(endpoint));
  process.exit(0);
}
if (endpoint === "repos/openclaw/openclaw/issues/74134") {
  write(issue(74134, [], "Replacement PR: https://github.com/openclaw/openclaw/pull/74742"));
  process.exit(0);
}
if (endpoint === "repos/openclaw/openclaw/issues/74742") {
  write(issue(74742, ["clawsweeper:automerge"], "<!-- clawsweeper-security:security-sensitive item=74742 sha=e371eeac -->"));
  process.exit(0);
}
if (endpoint === "repos/openclaw/openclaw/pulls/74134") {
  write(pull(74134, "cca706a"));
  process.exit(0);
}
if (endpoint === "repos/openclaw/openclaw/pulls/74742") {
  write(pull(74742, "e371eea"));
  process.exit(0);
}
console.error("unexpected endpoint: " + endpoint);
process.exit(1);
function issue(number, labels, body) {
  return {
    state: "open",
    title: "PR #" + number,
    html_url: "https://github.com/openclaw/openclaw/pull/" + number,
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    labels: labels.map((name) => ({ name })),
    created_at: "2026-04-30T00:00:00Z",
    updated_at: "2026-04-30T00:00:00Z",
    comments: 0,
    body,
    pull_request: {},
  };
}
function pull(number, sha) {
  const large = process.env.FAKE_GH_LARGE_PR === "1";
  const largeCount = Number(process.env.FAKE_GH_LARGE_PR_COUNT || 120);
  return {
    draft: false,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    mergeable: number === 74742 ? false : true,
    mergeable_state: number === 74742 ? "dirty" : "clean",
    base: { ref: "main" },
    head: {
      ref: "branch-" + number,
      sha,
      repo: { full_name: "openclaw/openclaw", owner: { login: "openclaw" } },
    },
    maintainer_can_modify: process.env.FAKE_GH_MAINTAINER_CAN_MODIFY === "false" ? false : true,
    requested_reviewers: [],
    requested_teams: [],
    additions: 1,
    deletions: 0,
    changed_files: large ? largeCount : 1,
    commits: large ? largeCount : 1,
    review_comments: 0,
  };
}
function pagedResponse(endpoint) {
  const [endpointPath, query = ""] = endpoint.split("?");
  const params = new URLSearchParams(query);
  const limit = Math.max(1, Number(params.get("per_page") || 1));
  const page = Math.max(1, Number(params.get("page") || 1));
  const total = Number(process.env.FAKE_GH_LARGE_PR_COUNT || 120);
  const start = (page - 1) * limit;
  const count = Math.max(0, Math.min(limit, total - start));
  if (endpointPath.endsWith("/files")) {
    return Array.from({ length: count }, (_, index) => ({
      filename: "src/file-" + (start + index) + ".ts",
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
  }
  if (endpointPath.endsWith("/commits")) {
    return Array.from({ length: count }, (_, index) => ({
      sha: "commit-sha-" + (start + index),
      commit: { message: "test " + (start + index) },
      author: { login: "contributor" },
    }));
  }
  return [];
}
`;
}
