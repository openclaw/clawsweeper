import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  neutralizeProposalText,
  renderUmbrellaProposals,
  selectAppAuthoredUmbrellaProposalIssue,
  selectUmbrellaProposals,
  suggestedUmbrellaTitle,
  type ClusterMember,
} from "../../dist/repair/umbrella-consolidation.js";

const decisionLabel = "clawsweeper:needs-product-decision";

function member(number: number, overrides: Partial<ClusterMember> = {}): ClusterMember {
  return {
    clusterId: 42,
    number,
    kind: "issue",
    state: "open",
    title: `Telegram notification option ${number}`,
    author: `author${number}`,
    labels: [decisionLabel],
    ...overrides,
  };
}

test("proposal filtering applies threshold and exclusion gates", () => {
  const rows = [
    member(1),
    member(2),
    member(3),
    member(4, { labels: [decisionLabel, "clawsweeper:human-review"] }),
    member(5, { labels: [decisionLabel, "clawsweeper:idea-archive"] }),
    member(6, { labels: [] }),
    member(7, { state: "closed" }),
    member(8, { kind: "pull_request" }),
  ];
  assert.equal(selectUmbrellaProposals(rows, { minClusterSize: 4 }).length, 0);
  assert.deepEqual(
    selectUmbrellaProposals(rows, { minClusterSize: 3 })[0]?.members.map((item) => item.number),
    [1, 2, 3],
  );
});

test("title heuristic is deterministic and bounded at a token boundary", () => {
  const titles = [
    "Add Telegram notification routing",
    "Telegram notification filters",
    "Feature request: Telegram routing rules",
  ];
  assert.equal(suggestedUmbrellaTitle(titles), suggestedUmbrellaTitle([...titles].reverse()));
  assert.equal(suggestedUmbrellaTitle(titles), "Umbrella: Telegram Notification Routing");

  const longTokens = Array.from({ length: 8 }, (_, index) => `token${index}${"x".repeat(80)}`);
  const bounded = suggestedUmbrellaTitle([
    longTokens.join(" "),
    [...longTokens].reverse().join(" "),
  ]);
  assert.ok(bounded.length <= 120);
  assert.equal(bounded.endsWith("…"), false);
});

test("rolling issue lookup requires the exact app author", () => {
  const attacker = {
    number: 7,
    state: "open",
    title: "Umbrella consolidation proposals",
    body: "<!-- clawsweeper:umbrella-proposals -->",
    user: { login: "someone-else" },
  };
  assert.equal(selectAppAuthoredUmbrellaProposalIssue([attacker]), null);
  assert.equal(
    selectAppAuthoredUmbrellaProposalIssue([
      attacker,
      { ...attacker, number: 8, user: { login: "clawsweeper[bot]" } },
    ]),
    8,
  );
});

test("proposal rendering caps members, bounds total body, and contains no command", () => {
  const proposal = {
    clusterId: "gitcrawl-42",
    title: "Umbrella: Telegram Notifications",
    members: Array.from({ length: 7 }, (_, index) => member(index + 1)),
  };
  const rendered = renderUmbrellaProposals([proposal], {
    targetRepo: "openclaw/openclaw",
    generatedAt: "2026-07-16T00:00:00.000Z",
    maxMembersPerCluster: 3,
  });
  assert.match(rendered, /\.\.\.and 4 more eligible member\(s\)\./);
  assert.match(
    rendered,
    /consolidate these manually or wait for the upcoming consolidation command/,
  );
  assert.doesNotMatch(rendered, /@clawsweeper consolidate/);
  assert.equal((rendered.match(/github\.com\/openclaw\/openclaw\/issues\//g) ?? []).length, 3);

  const bounded = renderUmbrellaProposals([proposal, { ...proposal, clusterId: "gitcrawl-43" }], {
    targetRepo: "openclaw/openclaw",
    maxBodyChars: 450,
  });
  assert.ok(bounded.length <= 450);
  assert.match(bounded, /body limit reached|truncated/i);
});

test("proposal member titles are markdown-neutral and mentions inert", () => {
  const title = "Try `code` [link](https://example.com) @octocat *bold* <tag>";
  const neutral = neutralizeProposalText(title);
  assert.match(neutral, /\\`code\\`/);
  assert.match(neutral, /\\\[link\\\]/);
  assert.match(neutral, /@\u200boctocat/);
  assert.doesNotMatch(neutral, /@octocat/);

  const rendered = renderUmbrellaProposals(
    [{ clusterId: "gitcrawl-42", title: "Umbrella: Safe", members: [member(1, { title })] }],
    { targetRepo: "openclaw/openclaw" },
  );
  assert.doesNotMatch(rendered, /@octocat/);
  assert.doesNotMatch(rendered, /@clawsweeper consolidate/);
});

test("proposal workflow is weekly, app-authenticated, and proposal-only", () => {
  const workflow = readFileSync(".github/workflows/umbrella-proposals.yml", "utf8");
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /umbrella-proposals/);
  assert.match(workflow, /umbrella-proposal-issue-number/);
  assert.match(workflow, /clawsweeper\[bot\]/);
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /gh issue edit/);
  assert.doesNotMatch(workflow, /@clawsweeper consolidate/);
});
