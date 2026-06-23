import assert from "node:assert/strict";
import test from "node:test";

import {
  actionRunUrl,
  actionSessionOwner,
  actionSourceUrl,
  actionWorkKey,
  actionWorkKind,
} from "../../dist/repair/action-session.js";

test("action session classifies issue implementation and PR repair work", () => {
  assert.equal(
    actionWorkKind({ job_intent: "implement_issue", source: "issue_implementation" }),
    "issue_to_pr",
  );
  assert.equal(actionWorkKind({ job_intent: "automerge_pr" }), "pr_repair");
  assert.equal(actionWorkKind({ job_intent: "pr_repair" }), "pr_repair");
  assert.equal(actionWorkKind({ cluster_id: "automerge-openclaw-openclaw-123" }), "pr_repair");
  assert.equal(actionWorkKind({ cluster_id: "repair-pr-openclaw-clawsweeper-290" }), "pr_repair");
  assert.equal(actionWorkKind({ job_intent: "repair_cluster" }), "repair_cluster");
});

test("action session builds stable work and run identifiers", () => {
  assert.equal(
    actionWorkKey({ repo: "openclaw/openclaw", cluster_id: "issue-openclaw-openclaw-123" }),
    "openclaw/openclaw:issue-openclaw-openclaw-123",
  );
  assert.equal(
    actionRunUrl({
      GITHUB_SERVER_URL: "https://github.example/",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ID: "456",
    }),
    "https://github.example/openclaw/clawsweeper/actions/runs/456",
  );
});

test("action session reads the configured CrabFleet owner principal", () => {
  assert.equal(actionSessionOwner({ CLAWSWEEPER_CRABFLEET_OWNER: "@steipete" }), "@steipete");
  assert.throws(
    () => actionSessionOwner({}),
    /action session requires a configured CrabFleet owner/,
  );
});

test("action session prefers the full source URL from the job body", () => {
  assert.equal(
    actionSourceUrl({
      raw: "Source issue: https://github.com/openclaw/openclaw/issues/123\n",
      frontmatter: {
        repo: "openclaw/openclaw",
        canonical: ["#456"],
      },
    } as never),
    "https://github.com/openclaw/openclaw/issues/123",
  );
});
