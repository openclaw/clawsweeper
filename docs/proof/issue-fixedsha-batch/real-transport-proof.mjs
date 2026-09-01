import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { createStatusContext } from "../../../dist/clawsweeper-status-context.js";

const repo = "openclaw/clawsweeper";
const issueNumber = 1135;
const pullNumber = 1138;

function runGh(args) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

const candidate = runGh(["api", `repos/${repo}/pulls/${pullNumber}`]);
assert.equal(candidate.merged, true);
assert.equal(candidate.base?.ref, "main");
assert.match(candidate.body ?? "", /\bclose[sd]?\s+#1135\b/i);
assert.match(candidate.merge_commit_sha ?? "", /^[0-9a-f]{40}$/);
assert.match(candidate.head?.sha ?? "", /^[0-9a-f]{40}$/);

const candidateCommits = runGh(["api", `repos/${repo}/pulls/${pullNumber}/commits?per_page=100`]);
const interiorSha = candidateCommits
  .map((commit) => commit.sha)
  .find((sha) => sha !== candidate.head.sha && sha !== candidate.merge_commit_sha);
assert.match(interiorSha ?? "", /^[0-9a-f]{40}$/);

const recentPulls = runGh([
  "api",
  `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
]);
assert.ok(recentPulls.some((pull) => pull.number === pullNumber));

const resolverCalls = [];
const ghJson = (args) => {
  const path = args[1] ?? "";
  resolverCalls.push({
    route:
      path === `repos/${repo}`
        ? "repository"
        : path.includes("/pulls?state=all")
          ? "pulls_list"
          : /\/commits\/[^/]+\/pulls$/.test(path)
            ? "commit_pulls"
            : /\/commits\/[^/]+$/.test(path)
              ? "commit"
              : "other",
    path,
  });
  return runGh(args);
};

const context = createStatusContext({
  targetProfile: () => ({}),
  targetRepo: () => repo,
  markdownLink: (label) => label,
  repoUrlFor: () => "",
  linkedRelease: (tag) => tag,
  linkedSha: (sha) => sha,
  profileStatusStart: () => "",
  profileStatusEnd: () => "",
  sweepStatusPath: () => "",
  markdownRepository: () => repo,
  ghJson,
  asRecord: (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  frontMatterValue: (markdown, key) => {
    const value = markdown.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1];
    return value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  },
  stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
  numberOrUndefined: (value) => (typeof value === "number" ? value : undefined),
  recordOrUndefined: (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
});

function decision(fixedSha) {
  return {
    decision: "close",
    confidence: "high",
    fixedSha,
  };
}

const issue = {
  repo,
  number: issueNumber,
  kind: "issue",
};
const priorReport = `---
repository: ${repo}
number: ${issueNumber}
fixed_sha: ${candidate.merge_commit_sha}
fixed_pr_url: ${candidate.html_url}
fixed_pr_number: ${pullNumber}
fixed_pr_title: ${JSON.stringify(candidate.title)}
fixed_pr_merged_at: ${candidate.merged_at}
fixed_pr_sha: ${candidate.merge_commit_sha}
fixed_pr_confidence: high
fixed_pr_source: "GitHub commit PR lookup"
---
`;

for (let repeat = 0; repeat < 4; repeat += 1) {
  const resolved = context.attachFixedPullRequest(
    decision(candidate.merge_commit_sha),
    issue,
    {},
    priorReport,
  );
  assert.equal(resolved.fixedPullRequest?.number, pullNumber);
}
assert.equal(resolverCalls.length, 0, "persisted repeats must not invoke gh");

const mergeResolved = context.attachFixedPullRequest(
  decision(candidate.merge_commit_sha),
  issue,
  {},
);
assert.equal(mergeResolved.fixedPullRequest?.number, pullNumber);
assert.deepEqual(
  resolverCalls.map((call) => call.route),
  ["repository", "pulls_list"],
);

const headResolved = context.attachFixedPullRequest(decision(candidate.head.sha), issue, {});
assert.equal(headResolved.fixedPullRequest?.number, pullNumber);
assert.equal(resolverCalls.filter((call) => call.route === "pulls_list").length, 1);
assert.equal(resolverCalls.filter((call) => call.route === "commit_pulls").length, 1);

const interiorResolved = context.attachFixedPullRequest(decision(interiorSha), issue, {});
assert.equal(interiorResolved.fixedPullRequest?.number, pullNumber);
assert.equal(resolverCalls.filter((call) => call.route === "pulls_list").length, 1);
assert.equal(resolverCalls.filter((call) => call.route === "commit_pulls").length, 2);

const publicTrace = resolverCalls.map((call) => ({ route: call.route, path: call.path }));
console.log(
  JSON.stringify(
    {
      repository: repo,
      public_fixture: {
        issue: issueNumber,
        pull: pullNumber,
        merge_sha: candidate.merge_commit_sha,
        head_sha: candidate.head.sha,
        interior_sha: interiorSha,
      },
      before: { commit_pulls: 7, pulls_list: 0 },
      after: { commit_pulls: 2, pulls_list: 1, repeat_calls: 0 },
      resolved: {
        repeats: [pullNumber, pullNumber, pullNumber, pullNumber],
        merge_sha: mergeResolved.fixedPullRequest.number,
        head_sha: headResolved.fixedPullRequest.number,
        interior_sha: interiorResolved.fixedPullRequest.number,
      },
      resolver_transport_trace: publicTrace,
      setup_transport_calls: 3,
      result: "PASS",
    },
    null,
    2,
  ),
);
