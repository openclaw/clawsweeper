import assert from "node:assert/strict";
import test from "node:test";

import { deterministicAutomergeResult } from "../../dist/repair/deterministic-automerge-result.js";
import { assertCodexActionMatchesSchema } from "./codex-result-schema.ts";

function job() {
  return {
    frontmatter: {
      repo: "openclaw/openclaw",
      cluster_id: "automerge-openclaw-openclaw-71898",
      source: "pr_automerge",
      canonical: ["#71898"],
      allow_fix_pr: true,
      allow_merge: false,
    },
  };
}

function clusterPlan(overrides = {}) {
  return {
    repo: "openclaw/openclaw",
    cluster_id: "automerge-openclaw-openclaw-71898",
    items: [
      {
        number: 71898,
        ref: "#71898",
        kind: "pull_request",
        state: "open",
        title: "fix(memory): preserve session corpus labels",
        updated_at: "2026-05-11T00:00:00Z",
        security_sensitive: false,
        security_repair_allowed: false,
        bot_comments: [
          {
            author: "openclaw-clawsweeper[bot]",
            body_excerpt:
              "Codex review: needs changes before merge. [P1] Detect conflict and upsert data-model changes.",
          },
        ],
        pull_request: {
          branch_writable: true,
          files_truncated: 0,
          checks: [
            {
              name: "checks-node-core-fast",
              state: "failure",
              link: "https://github.com/openclaw/openclaw/actions/runs/1/job/2",
            },
            {
              name: "Socket Security",
              state: "failure",
              link: "https://socket.dev/dashboard/org/openclaw/report/123",
            },
            { name: "lint", state: "success" },
          ],
          files: [
            { filename: "extensions/memory-core/src/tools.ts" },
            { filename: "extensions/memory-core/src/tools.test.ts" },
          ],
          review_bot_comments: [
            {
              author: "coderabbitai[bot]",
              body_excerpt: "[P1] Reject pending compatibility proof before pass.",
            },
          ],
        },
        ...overrides,
      },
    ],
  };
}

test("deterministic automerge result emits generic direct-Codex repair artifact", () => {
  const result = deterministicAutomergeResult({
    job: job(),
    mode: "autonomous",
    clusterPlan: clusterPlan(),
  });

  assert.equal(result?.status, "planned");
  assert.equal(result?.actions[0].action, "build_fix_artifact");
  assert.equal(result?.actions[0].target, "#71898");
  assert.equal(result?.actions[0].depends_on, null);
  assertCodexActionMatchesSchema(result?.actions[0]);
  assert.match(result?.actions[0].reason, /direct Codex edit loop/);
  assert.equal(result?.fix_artifact.repair_strategy, "repair_contributor_branch");
  assert.deepEqual(result?.fix_artifact.likely_files, [
    "extensions/memory-core/src/tools.ts",
    "extensions/memory-core/src/tools.test.ts",
  ]);
  assert.deepEqual(result?.fix_artifact.affected_surfaces, ["extensions/memory-core"]);
  assert.equal(result?.fix_artifact.changelog_required, false);
  assert.equal(result?.fix_artifact.repair_contract, null);
  assert.deepEqual(result?.fix_artifact.source_prs, [
    "https://github.com/openclaw/openclaw/pull/71898",
  ]);
  assert.deepEqual(result?.fix_artifact.review_findings, [
    "Codex review: needs changes before merge. [P1] Detect conflict and upsert data-model changes.",
    "[P1] Reject pending compatibility proof before pass.",
  ]);
  assert.match(result?.actions[0].evidence.join("\n"), /Failing check: checks-node-core-fast/);
  assert.match(
    result?.actions[0].evidence.join("\n"),
    /Failing check: Socket Security:failure \(external check details on socket\.dev\)/,
  );
  assert.doesNotMatch(result?.actions[0].evidence.join("\n"), /https:\/\/socket\.dev/);
  assert.match(result?.fix_artifact.pr_body, /Known failing checks/);
});

test("deterministic automerge result does not require a changelog blocker", () => {
  const result = deterministicAutomergeResult({
    job: job(),
    mode: "autonomous",
    clusterPlan: clusterPlan({
      title: "docs: refresh memory guide",
      pull_request: {
        branch_writable: false,
        branch_write_reason: "fork branch",
        files_truncated: 4,
        files: [{ filename: "docs/memory.md" }],
      },
    }),
  });

  assert.equal(result?.status, "planned");
  assert.equal(result?.fix_artifact.changelog_required, false);
  assert.deepEqual(result?.fix_artifact.likely_files, ["docs/memory.md"]);
  assert.match(result?.actions[0].evidence.join("\n"), /Branch writable: false/);
  assert.match(result?.actions[0].evidence.join("\n"), /Changed files truncated by 4/);
});

test("deterministic automerge result leaves non-automerge jobs to Codex", () => {
  assert.equal(
    deterministicAutomergeResult({
      job: {
        frontmatter: {
          ...job().frontmatter,
          source: "manual_cluster",
        },
      },
      mode: "autonomous",
      clusterPlan: clusterPlan(),
    }),
    null,
  );
});

test("deterministic automerge result keeps the openclaw/openclaw pnpm changed gate", () => {
  const result = deterministicAutomergeResult({
    job: job(),
    mode: "autonomous",
    clusterPlan: clusterPlan(),
  });
  assert.deepEqual(result?.fix_artifact.validation_commands, ["pnpm check:changed"]);
});

test("deterministic automerge result emits bun run check for openclaw/clawhub", () => {
  const clawhubJob = {
    frontmatter: {
      repo: "openclaw/clawhub",
      cluster_id: "automerge-openclaw-clawhub-42",
      source: "pr_automerge",
      canonical: ["#42"],
      allow_fix_pr: true,
      allow_merge: false,
    },
  };
  const clawhubPlan = {
    repo: "openclaw/clawhub",
    cluster_id: "automerge-openclaw-clawhub-42",
    items: [
      {
        number: 42,
        ref: "#42",
        kind: "pull_request",
        state: "open",
        title: "fix: tighten clawhub renderer fallbacks",
        updated_at: "2026-05-11T00:00:00Z",
        pull_request: {
          branch_writable: true,
          files_truncated: 0,
          checks: [],
          files: [{ filename: "src/renderer/index.tsx" }],
        },
      },
    ],
  };

  const result = deterministicAutomergeResult({
    job: clawhubJob,
    mode: "autonomous",
    clusterPlan: clawhubPlan,
  });

  assert.equal(result?.repo, "openclaw/clawhub");
  assert.deepEqual(result?.fix_artifact.validation_commands, ["bun run check"]);
});

test("deterministic automerge result uses git validation for generic repositories", () => {
  const genericJob = job();
  genericJob.frontmatter.repo = "openclaw/openclaw-ansible";
  const genericPlan = clusterPlan();
  genericPlan.repo = "openclaw/openclaw-ansible";

  const result = deterministicAutomergeResult({
    job: genericJob,
    mode: "autonomous",
    clusterPlan: genericPlan,
  });

  assert.deepEqual(result?.fix_artifact.validation_commands, ["git diff --check"]);
});
