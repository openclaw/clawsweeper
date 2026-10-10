import assert from "node:assert/strict";
import test from "node:test";

import {
  repairPauseLabel,
  validateAutonomousFixScope,
} from "../../dist/repair/execute-fix-validation.js";
import {
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
} from "../../dist/repair/exact-review-guard-labels.js";

function broadBranchRepairArtifact() {
  return {
    repair_strategy: "repair_contributor_branch",
    pr_title: "feat(file-transfer): refresh canonical node policy repair branch",
    summary:
      "Repair existing canonical PR by rebasing it onto current main and resolving stale branch fallout.",
    pr_body: "Refresh a broad existing contributor branch without expanding the requested scope.",
    affected_surfaces: [
      "extensions/file-transfer plugin",
      "Gateway node.invoke plugin policy seam",
      "Agent nodes-tool redirect messaging",
      "Plugin SDK/registry contract exports",
      "Docs, changelog, and labeler entries for the bundled plugin",
    ],
    likely_files: [
      "src/agents/tools/nodes-tool-commands.ts",
      "src/agents/tools/nodes-tool.test.ts",
      "extensions/file-transfer/src/shared/node-invoke-policy.ts",
      "extensions/file-transfer/src/shared/node-invoke-policy.test.ts",
      "extensions/file-transfer/src/tools/dir-fetch-tool.ts",
      "extensions/file-transfer/src/tools/dir-fetch-tool.test.ts",
      "src/gateway/node-invoke-plugin-policy.ts",
      "src/gateway/node-invoke-plugin-policy.test.ts",
    ],
    source_prs: [
      "https://github.com/openclaw/openclaw/pull/74742",
      "https://github.com/openclaw/openclaw/pull/74134",
    ],
  };
}

function validate(job, fixArtifact = broadBranchRepairArtifact()) {
  return validateAutonomousFixScope({
    job,
    fixArtifact,
    allowBroadFixArtifacts: false,
    maxAutonomousFixFiles: 3,
    maxAutonomousFixSurfaces: 3,
  });
}

test("autonomous scope validation blocks broad untrusted repair artifacts", () => {
  const block = validate({
    frontmatter: {
      source: "manual",
      allow_fix_pr: true,
      allowed_actions: ["fix", "raise_pr"],
      target_branch: "clawsweeper/example",
    },
  });

  assert.match(block.reason, /too broad for autonomous execution/);
});

const manualJob = {
  frontmatter: {
    source: "manual",
    allow_fix_pr: true,
    allowed_actions: ["fix", "raise_pr"],
    target_branch: "clawsweeper/example",
  },
};

test("autonomous scope validation ignores feature wording and file roles within the caps", () => {
  const block = validate(manualJob, {
    repair_strategy: "new_fix_pr",
    pr_title: "feat(config): add a new configuration surface with public docs and schema",
    summary: "Add a new config schema.",
    pr_body: "Adds public docs.",
    affected_surfaces: ["config schema", "docs"],
    likely_files: ["docs/config.md", "src/config/schema.ts", "src/config/schema.test.ts"],
    source_prs: [],
  });

  assert.equal(block, null);
});

test("autonomous scope validation blocks fix artifacts over the file cap without feature wording", () => {
  const block = validate(manualJob, {
    repair_strategy: "new_fix_pr",
    pr_title: "fix(gateway): keep retry state",
    summary: "Keep retry state.",
    pr_body: "Keeps retry state.",
    affected_surfaces: ["gateway"],
    likely_files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    source_prs: [],
  });

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("autonomous scope validation allows trusted adopted PR branch refreshes", () => {
  const block = validate({
    frontmatter: {
      source: "pr_automerge",
      allow_fix_pr: true,
      allowed_actions: ["fix", "raise_pr"],
      target_branch: "clawsweeper/automerge-openclaw-openclaw-74134",
    },
  });

  assert.equal(block, null);
});

test("autonomous scope validation allows repair-intake adopted branch refreshes", () => {
  const block = validate(
    {
      frontmatter: {
        repo: "openclaw/openclaw",
        cluster_id: "repair-pr-openclaw-openclaw-74742",
        canonical: ["#74742"],
        candidates: ["#74742"],
        cluster_refs: ["#74742"],
        source: "pr-repair-intake",
        job_intent: "pr_repair",
        allow_fix_pr: true,
        allowed_actions: ["fix", "raise_pr"],
        target_branch: "clawsweeper/repair-pr-openclaw-openclaw-74742",
      },
    },
    {
      ...broadBranchRepairArtifact(),
      source_prs: ["https://github.com/openclaw/openclaw/pull/74742"],
    },
  );

  assert.equal(block, null);
});

test("autonomous scope validation blocks repair-intake branch/source mismatches", () => {
  const block = validate(
    {
      frontmatter: {
        repo: "openclaw/openclaw",
        cluster_id: "repair-pr-openclaw-openclaw-74742",
        canonical: ["#74742"],
        candidates: ["#74742"],
        cluster_refs: ["#74742"],
        source: "pr-repair-intake",
        job_intent: "pr_repair",
        allow_fix_pr: true,
        allowed_actions: ["fix", "raise_pr"],
        target_branch: "clawsweeper/repair-pr-openclaw-openclaw-74742",
      },
    },
    {
      ...broadBranchRepairArtifact(),
      source_prs: ["https://github.com/openclaw/openclaw/pull/74743"],
    },
  );

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("autonomous scope validation accepts generated truncated repair-intake clusters", () => {
  const repo = `${"a".repeat(39)}/${"b".repeat(90)}`;
  const sourcePr = `https://github.com/${repo}/pull/74742`;
  const clusterId = `repair-pr-${repo.replace("/", "-")}-74742`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const block = validate(
    {
      frontmatter: {
        repo,
        cluster_id: clusterId,
        canonical: ["#74742"],
        candidates: ["#74742"],
        cluster_refs: ["#74742"],
        source: "pr-repair-intake",
        job_intent: "pr_repair",
        allow_fix_pr: true,
        allowed_actions: ["fix", "raise_pr"],
        target_branch: `clawsweeper/${clusterId}`,
      },
    },
    {
      ...broadBranchRepairArtifact(),
      source_prs: [sourcePr],
    },
  );

  assert.equal(block, null);
});

test("autonomous scope validation allows every authoritative reviewed issue lane", () => {
  for (const triggerSource of [
    "review_reproducible_bug",
    "review_viable_issue",
    "review_vision_fit",
  ]) {
    const block = validate(
      {
        frontmatter: {
          repo: "steipete/oracle",
          source: "issue_implementation",
          trigger_source: triggerSource,
          source_issue_repo: "steipete/oracle",
          source_issue_number: 241,
          source_issue_revision_sha256: "a".repeat(64),
          allow_fix_pr: true,
          allowed_actions: ["fix", "raise_pr"],
          target_branch: "clawsweeper/issue-steipete-oracle-241",
        },
      },
      {
        ...broadBranchRepairArtifact(),
        repair_strategy: "new_fix_pr",
        source_prs: [],
      },
    );

    assert.equal(block, null, triggerSource);
  }
});

test("autonomous scope validation rejects unrecognized issue review triggers", () => {
  const block = validate(
    {
      frontmatter: {
        repo: "steipete/oracle",
        source: "issue_implementation",
        trigger_source: "unreviewed_operator_request",
        source_issue_repo: "steipete/oracle",
        source_issue_number: 241,
        source_issue_revision_sha256: "a".repeat(64),
        allow_fix_pr: true,
        allowed_actions: ["fix", "raise_pr"],
        target_branch: "clawsweeper/issue-steipete-oracle-241",
      },
    },
    {
      ...broadBranchRepairArtifact(),
      repair_strategy: "new_fix_pr",
      source_prs: [],
    },
  );

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("autonomous scope validation blocks incomplete issue review metadata", () => {
  const block = validate(
    {
      frontmatter: {
        repo: "steipete/oracle",
        source: "issue_implementation",
        trigger_source: "review_viable_issue",
        source_issue_revision_sha256: "abc123",
        allow_fix_pr: true,
        allowed_actions: ["fix", "raise_pr"],
        target_branch: "clawsweeper/issue-steipete-oracle-241",
      },
    },
    {
      ...broadBranchRepairArtifact(),
      repair_strategy: "new_fix_pr",
      source_prs: [],
    },
  );

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("autonomous scope validation blocks issue implementations outside their dedicated branch", () => {
  const block = validate(
    {
      frontmatter: {
        repo: "steipete/oracle",
        source: "issue_implementation",
        trigger_source: "review_viable_issue",
        source_issue_repo: "steipete/oracle",
        source_issue_number: 241,
        source_issue_revision_sha256: "a".repeat(64),
        allow_fix_pr: true,
        allowed_actions: ["fix", "raise_pr"],
        target_branch: "feature/oracle-241",
      },
    },
    {
      ...broadBranchRepairArtifact(),
      repair_strategy: "new_fix_pr",
      source_prs: [],
    },
  );

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("autonomous scope validation still blocks adopted repairs outside ClawSweeper branches", () => {
  const block = validate({
    frontmatter: {
      source: "pr_automerge",
      allow_fix_pr: true,
      allowed_actions: ["fix", "raise_pr"],
      target_branch: "contributor/file-transfer",
    },
  });

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("repair pause labels block live branch mutation", () => {
  assert.equal(repairPauseLabel(["bug", HUMAN_REVIEW_LABEL]), HUMAN_REVIEW_LABEL);
  assert.equal(
    repairPauseLabel([{ name: "Bug" }, { name: "ClawSweeper:Human-Review" }]),
    HUMAN_REVIEW_LABEL,
  );
  assert.equal(repairPauseLabel(["clawsweeper:automerge"]), null);
  assert.equal(repairPauseLabel(["bug", MANUAL_ONLY_LABEL]), MANUAL_ONLY_LABEL);
});
