#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const statePath = process.env.CLAWSWEEPER_E2E_GITHUB_STATE;
if (!statePath) fail("CLAWSWEEPER_E2E_GITHUB_STATE is required");
const args = process.argv.slice(2);
const state = loadState();
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

assertKnownToken(token);
recordCall();

if (args[0] === "auth" && args[1] === "status") respondText("github.com: authenticated");
if (args[0] === "auth" && args[1] === "setup-git") respondText("");
if (args[0] === "auth" && args[1] === "token") respondText(token);

if (args[0] === "repo" && args[1] === "clone") {
  assertReadToken();
  const destination = args[3];
  if (args[2] !== state.repo || !destination) fail(`unsupported repo clone: ${args.join(" ")}`);
  // Production `gh repo clone` transfers a complete repository. Avoid both a
  // shallow boundary and Git's local hardlink shortcut: either can make this
  // fixture exercise object-availability behavior that GitHub never creates.
  // GitHub-hosted workspaces are group-writable. Recreate that checkout mode so
  // a real pnpm install must normalize tracked executable files to Git's 0755
  // semantics while maintaining tracked OpenClaw workspace/bin links.
  const previousUmask = process.umask(0o002);
  try {
    git(["clone", "--no-local", state.remote, destination]);
  } finally {
    process.umask(previousUmask);
  }
  const shallow = gitText(["-C", destination, "rev-parse", "--is-shallow-repository"]);
  if (shallow !== "false") fail(`target clone unexpectedly shallow: ${destination}`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "checks") {
  assertReadToken();
  respondJson(
    currentChecks().map((check) => ({
      name: check.name,
      state: check.conclusion || check.status,
      bucket: check.conclusion === "SUCCESS" ? "pass" : "pending",
      link: `https://github.com/${state.repo}/actions/runs/1`,
    })),
  );
}

if (args[0] === "pr" && args[1] === "view") {
  assertReadToken();
  const number = Number(args[2]);
  assertPr(number);
  const fields = new Set(String(optionValue("--json") || "").split(","));
  const pull = pullResponse();
  const view = {
    additions: 1,
    author: { login: state.pr.author, is_bot: false },
    baseRefName: state.pr.baseRef,
    body: state.pr.body,
    changedFiles: 1,
    deletions: 1,
    files: state.pr.files.map((file) => ({ path: file, additions: 1, deletions: 1 })),
    headRefName: state.pr.headRef,
    headRefOid: pull.head.sha,
    headRepository: { nameWithOwner: state.repo },
    isDraft: false,
    labels: state.pr.labels.map((name) => ({ name })),
    mergeable: "MERGEABLE",
    mergeCommit: state.pr.mergeCommitSha ? { oid: state.pr.mergeCommitSha } : null,
    mergeStateStatus: "CLEAN",
    mergedAt: state.pr.mergedAt,
    reviewDecision: "APPROVED",
    state: state.pr.mergedAt ? "MERGED" : state.pr.state.toUpperCase(),
    statusCheckRollup: currentChecks({ consumePending: fields.has("statusCheckRollup") }),
    title: state.pr.title,
    updatedAt: state.pr.updatedAt,
    url: `https://github.com/${state.repo}/pull/${state.pr.number}`,
  };
  respondJson(Object.fromEntries([...fields].filter(Boolean).map((field) => [field, view[field]])));
}

if (args[0] === "pr" && args[1] === "comment") {
  assertMutationToken();
  assertPr(Number(args[2]));
  addComment(String(optionValue("--body") ?? ""));
  respondText("commented");
}

if (args[0] === "pr" && args[1] === "merge") {
  assertPostToken();
  assertPr(Number(args[2]));
  mergePullRequest(String(optionValue("--match-head-commit") ?? ""));
  respondText("merged");
}

if (args[0] === "pr" && ["close", "reopen"].includes(args[1])) {
  assertMutationToken();
  assertPr(Number(args[2]));
  state.pr.state = args[1] === "close" ? "closed" : "open";
  saveState();
  respondText(state.pr.state);
}

if (args[0] === "issue" && args[1] === "edit") {
  assertMutationToken();
  assertPr(Number(args[2]));
  const add = optionValue("--add-label");
  const remove = optionValue("--remove-label");
  if (add && !state.pr.labels.includes(add)) state.pr.labels.push(add);
  if (remove) state.pr.labels = state.pr.labels.filter((label) => label !== remove);
  saveState();
  respondText("");
}

if (args[0] === "label" && args[1] === "create") {
  assertMutationToken();
  respondText("");
}

if (args[0] === "api") handleApi();

fail(`unexpected gh args: ${args.join(" ")}`);

function handleApi() {
  const endpoint = apiEndpoint();
  if (!endpoint) fail(`missing API endpoint: ${args.join(" ")}`);
  const method = String(optionValue("--method") || "GET").toUpperCase();

  if (endpoint === "user") {
    assertReadToken();
    respondJson({ id: 1, login: "clawsweeper[bot]", type: "Bot" });
  }

  if (endpoint === "graphql") {
    assertReadToken();
    const query = String(
      optionValue("query") || args.find((arg) => arg.startsWith("query=")) || "",
    );
    if (query.includes("resolveReviewThread")) {
      assertMutationToken();
      respondJson({
        data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } },
      });
    }
    respondJson({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      },
    });
  }

  if (endpoint === `repos/${state.repo}`) {
    assertReadToken();
    respondJson({ default_branch: state.pr.baseRef });
  }
  if (/^repos\/openclaw\/clawsweeper\/actions\/workflows\/[^/]+\/runs\?/.test(endpoint)) {
    assertReadToken();
    respondJson([]);
  }
  if (endpoint === `repos/${state.repo}/branches/${state.pr.baseRef}`) {
    assertReadToken();
    respondJson({
      commit: { sha: refSha(state.pr.baseRef) },
      _links: { html: `https://github.com/${state.repo}/tree/${state.pr.baseRef}` },
    });
  }
  const gitRef = endpoint.match(
    new RegExp(`^repos/${escapeRegExp(state.repo)}/git/ref/heads/(.+)$`),
  );
  if (gitRef) {
    assertReadToken();
    const branch = decodeURIComponent(gitRef[1]);
    try {
      const sha = refSha(branch);
      if (args.includes("--jq")) respondText(sha);
      respondJson({ object: { sha } });
    } catch {
      fail(`HTTP 404: Not Found (${branch})`);
    }
  }
  if (endpoint === `repos/${state.repo}/issues/${state.pr.number}`) {
    assertReadToken();
    respondJson(issueResponse());
  }
  if (endpoint.startsWith(`repos/${state.repo}/issues/${state.pr.number}/comments`)) {
    if (method === "POST") {
      assertMutationToken();
      addComment(readInput().body ?? "");
      respondJson(state.comments.at(-1));
    }
    assertReadToken();
    if (args.includes("--jq"))
      respondText(state.comments.map((comment) => comment.body).join("\n"));
    respondJson(state.comments, { paged: args.includes("--slurp") });
  }
  const commentGet = endpoint.match(
    new RegExp(`^repos/${escapeRegExp(state.repo)}/issues/comments/(\\d+)$`),
  );
  if (commentGet && method === "GET") {
    assertReadToken();
    const comment = state.comments.find((entry) => entry.id === Number(commentGet[1]));
    if (!comment) fail(`HTTP 404: Not Found (comment ${commentGet[1]})`);
    respondJson(comment);
  }
  const commentPatch = endpoint.match(
    new RegExp(`^repos/${escapeRegExp(state.repo)}/issues/comments/(\\d+)$`),
  );
  if (commentPatch && method === "PATCH") {
    assertMutationToken();
    const comment = state.comments.find((entry) => entry.id === Number(commentPatch[1]));
    if (!comment) fail(`unknown comment ${commentPatch[1]}`);
    comment.body = String(readInput().body ?? "");
    saveState();
    respondJson(comment);
  }
  if (endpoint === `repos/${state.repo}/pulls/${state.pr.number}`) {
    assertReadToken();
    respondJson(pullResponse());
  }
  if (endpoint.startsWith(`repos/${state.repo}/pulls/${state.pr.number}/files`)) {
    assertReadToken();
    respondJson(
      state.pr.files.map((file) => ({
        filename: file,
        status: "modified",
        additions: 1,
        deletions: 1,
      })),
      { paged: args.includes("--slurp") },
    );
  }
  if (endpoint.startsWith(`repos/${state.repo}/pulls/${state.pr.number}/commits`)) {
    assertReadToken();
    respondJson(
      [
        {
          sha: currentHead(),
          commit: { message: "feat: contributor change", author: { name: state.pr.author } },
          author: { login: state.pr.author },
        },
      ],
      { paged: args.includes("--slurp") },
    );
  }
  if (endpoint.startsWith(`repos/${state.repo}/pulls/${state.pr.number}/reviews`)) {
    assertReadToken();
    respondJson([], { paged: args.includes("--slurp") });
  }
  if (endpoint.startsWith(`repos/${state.repo}/pulls/${state.pr.number}/comments`)) {
    assertReadToken();
    respondJson([], { paged: args.includes("--slurp") });
  }
  if (endpoint === `users/${state.pr.author}`) {
    assertReadToken();
    respondJson({ id: 101, login: state.pr.author, name: "E2E Contributor" });
  }
  if (endpoint.endsWith("/dispatches") && method === "POST") {
    assertMutationToken();
    state.dispatches.push(readInput());
    saveState();
    respondText("");
  }
  fail(`unsupported API call: ${method} ${endpoint}`);
}

function issueResponse() {
  return {
    number: state.pr.number,
    state: state.pr.mergedAt ? "closed" : state.pr.state,
    title: state.pr.title,
    html_url: `https://github.com/${state.repo}/pull/${state.pr.number}`,
    user: { login: state.pr.author },
    author_association: "CONTRIBUTOR",
    labels: state.pr.labels.map((name) => ({ name })),
    created_at: state.pr.createdAt,
    updated_at: state.pr.updatedAt,
    closed_at: state.pr.mergedAt,
    body: state.pr.body,
    comments: state.comments.length,
    pull_request: { url: `https://api.github.com/repos/${state.repo}/pulls/${state.pr.number}` },
  };
}

function pullResponse() {
  return {
    number: state.pr.number,
    state: state.pr.mergedAt ? "closed" : state.pr.state,
    title: state.pr.title,
    body: state.pr.body,
    draft: false,
    merged: Boolean(state.pr.mergedAt),
    merged_at: state.pr.mergedAt,
    merge_commit_sha: state.pr.mergeCommitSha,
    mergeable: true,
    mergeable_state: "clean",
    maintainer_can_modify: true,
    changed_files: 1,
    additions: 1,
    deletions: 1,
    commits: 1,
    labels: state.pr.labels.map((name) => ({ name })),
    user: { login: state.pr.author },
    author_association: "CONTRIBUTOR",
    base: { ref: state.pr.baseRef, sha: refSha(state.pr.baseRef), repo: repoIdentity() },
    head: { ref: state.pr.headRef, sha: currentHead(), repo: repoIdentity() },
  };
}

function repoIdentity() {
  return { full_name: state.repo, owner: { login: state.repo.split("/")[0] } };
}

function currentChecks({ consumePending = false } = {}) {
  const pending = Number(state.pendingCheckReads ?? 0) > 0;
  if (pending && consumePending) {
    state.pendingCheckReads -= 1;
    saveState();
  }
  const now = new Date().toISOString();
  return [
    pending
      ? { name: "fixture-check", status: "IN_PROGRESS", conclusion: "", startedAt: now }
      : {
          name: "fixture-check",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: now,
          completedAt: now,
        },
  ];
}

function mergePullRequest(expectedHead) {
  const head = currentHead();
  if (expectedHead && expectedHead !== head)
    fail(`head branch was modified: expected ${expectedHead}, found ${head}`);
  if (state.pr.mergedAt) return;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-e2e-merge-"));
  try {
    git(["clone", state.remote, work]);
    git(["config", "user.name", "ClawSweeper E2E"], work);
    git(["config", "user.email", "clawsweeper-e2e@example.invalid"], work);
    git(["checkout", state.pr.baseRef], work);
    git(["merge", "--squash", `origin/${state.pr.headRef}`], work);
    git(["commit", "-m", state.pr.title], work);
    git(["push", "origin", state.pr.baseRef], work);
    state.pr.mergeCommitSha = gitText(["rev-parse", "HEAD"], work);
    state.pr.mergedAt = new Date().toISOString();
    state.pr.state = "closed";
    saveState();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function addComment(body) {
  const now = new Date().toISOString();
  const id = state.nextCommentId++;
  state.comments.push({
    id,
    body: String(body),
    issue_url: `https://api.github.com/repos/${state.repo}/issues/${state.pr.number}`,
    html_url: `https://github.com/${state.repo}/pull/${state.pr.number}#issuecomment-${id}`,
    user: { id: 1, login: "clawsweeper[bot]" },
    author_association: "MEMBER",
    created_at: now,
    updated_at: now,
  });
  saveState();
}

function readInput() {
  const inputPath = optionValue("--input");
  return inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : {};
}

function currentHead() {
  return refSha(state.pr.headRef);
}

function refSha(ref) {
  return gitText(["--git-dir", state.remote, "rev-parse", `refs/heads/${ref}`]);
}

function git(commandArgs, cwd = process.cwd()) {
  execFileSync("/usr/bin/git", commandArgs, { cwd, env: process.env, stdio: "ignore" });
}

function gitText(commandArgs, cwd = process.cwd()) {
  return execFileSync("/usr/bin/git", commandArgs, {
    cwd,
    env: process.env,
    encoding: "utf8",
  }).trim();
}

function optionValue(name) {
  const direct = args.indexOf(name);
  if (direct >= 0) return args[direct + 1] ?? "";
  const assignment = args.find((arg) => arg.startsWith(`${name}=`));
  return assignment ? assignment.slice(name.length + 1) : "";
}

function apiEndpoint() {
  const valueOptions = new Set([
    "--method",
    "-X",
    "--input",
    "--jq",
    "-q",
    "--header",
    "-H",
    "-f",
    "--raw-field",
    "-F",
    "--field",
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--paginate" || arg === "--slurp") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

function assertPr(number) {
  if (number !== state.pr.number) fail(`unexpected PR number: ${number}`);
}

function assertKnownToken(value) {
  if (!Object.values(state.tokens).includes(value)) fail("unknown or missing E2E GitHub token");
}

function assertReadToken() {
  assertKnownToken(token);
}

function assertMutationToken() {
  if (![state.tokens.write, state.tokens.post].includes(token))
    fail("read token attempted GitHub mutation");
}

function assertPostToken() {
  if (token !== state.tokens.post) fail("post-flight operation requires the fresh post token");
}

function recordCall() {
  state.calls.push({ args, token: tokenName(), at: new Date().toISOString() });
  saveState();
}

function tokenName() {
  return Object.entries(state.tokens).find(([, value]) => value === token)?.[0] ?? "unknown";
}

function loadState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState() {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function respondJson(value, { paged = false } = {}) {
  process.stdout.write(`${JSON.stringify(paged ? [value] : value)}\n`);
  process.exit(0);
}

function respondText(value) {
  process.stdout.write(value ? `${value}\n` : "");
  process.exit(0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
