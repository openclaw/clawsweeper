import assert from "node:assert/strict";
import test from "node:test";
import {
  automergeShepherdReadiness,
  automergeShepherdWaitConfig,
  canUseAutomergeFastRebase,
  hasTrustedHumanReviewForHead,
  hasTrustedPassForHead,
  hasTrustedRepairRequestForHead,
} from "../../dist/repair/automerge-shepherd.js";

test("automerge fast rebase is limited to adopted branch repairs", () => {
  assert.equal(
    canUseAutomergeFastRebase({
      isAutomergeRepair: true,
      repairStrategy: "repair_contributor_branch",
      fixArtifact: { deterministic_rebase_only: true },
      env: {},
    }),
    true,
  );
  assert.equal(
    canUseAutomergeFastRebase({
      isAutomergeRepair: true,
      repairStrategy: "replace_uneditable_branch",
      fixArtifact: { deterministic_rebase_only: true },
      env: {},
    }),
    false,
  );
  assert.equal(
    canUseAutomergeFastRebase({
      isAutomergeRepair: true,
      repairStrategy: "repair_contributor_branch",
      fixArtifact: { deterministic_rebase_only: true },
      env: { CLAWSWEEPER_AUTOMERGE_FAST_REBASE: "0" },
    }),
    false,
  );
  assert.equal(
    canUseAutomergeFastRebase({
      isAutomergeRepair: true,
      repairStrategy: "repair_contributor_branch",
      fixArtifact: {
        summary: "Address ClawSweeper review feedback before automerge.",
        validation_commands: ["pnpm check:changed"],
      },
      env: {},
    }),
    false,
  );
});

test("automerge shepherd waits for an exact-head trusted pass", () => {
  const headSha = "abc123";
  const view = {
    state: "OPEN",
    headRefOid: headSha,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  assert.deepEqual(automergeShepherdReadiness({ view, comments: [], headSha }), {
    status: "waiting",
    reason: "waiting for exact-head ClawSweeper review pass",
  });
  assert.equal(
    hasTrustedPassForHead(
      [
        {
          user: { login: "clawsweeper[bot]" },
          body: "passed\n<!-- clawsweeper-verdict:pass sha=abc123 -->",
        },
      ],
      headSha,
    ),
    true,
  );
  assert.deepEqual(
    automergeShepherdReadiness({
      view,
      comments: [
        {
          user: { login: "clawsweeper[bot]" },
          body: "passed\n<!-- clawsweeper-verdict:pass sha=abc123 -->",
        },
      ],
      headSha,
    }),
    { status: "ready", reason: "checks and exact-head review are ready" },
  );
});

test("automerge shepherd accepts a behind head after exact-head review and checks pass", () => {
  const headSha = "abc123";
  assert.deepEqual(
    automergeShepherdReadiness({
      view: {
        state: "OPEN",
        headRefOid: headSha,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BEHIND",
        statusCheckRollup: [{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      comments: [
        {
          user: { login: "clawsweeper[bot]" },
          body: "passed\n<!-- clawsweeper-verdict:pass sha=abc123 -->",
        },
      ],
      headSha,
    }),
    { status: "ready", reason: "checks and exact-head review are ready" },
  );
});

test("automerge shepherd treats head movement as terminal for the current repair", () => {
  assert.deepEqual(
    automergeShepherdReadiness({
      view: { state: "OPEN", headRefOid: "def456" },
      comments: [],
      headSha: "abc123",
    }),
    { status: "stopped", reason: "head changed from abc123 to def456" },
  );
});

test("automerge shepherd releases the worker when exact-head review requests another repair", () => {
  const headSha = "abc123";
  const comments = [
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "needs changes",
        "<!-- clawsweeper-verdict:needs-changes item=1 sha=abc123 confidence=high -->",
        "<!-- clawsweeper-action:fix-required item=1 sha=abc123 confidence=high -->",
      ].join("\n"),
    },
  ];
  assert.equal(hasTrustedRepairRequestForHead(comments, headSha), true);
  assert.deepEqual(
    automergeShepherdReadiness({
      view: {
        state: "OPEN",
        headRefOid: headSha,
        statusCheckRollup: [{ name: "check", status: "IN_PROGRESS", conclusion: "" }],
      },
      comments,
      headSha,
    }),
    {
      status: "blocked",
      reason: "exact-head ClawSweeper review requires another repair",
    },
  );
});

test("automerge shepherd ignores stale and untrusted repair requests", () => {
  const comments = [
    {
      user: { login: "clawsweeper[bot]" },
      body: "<!-- clawsweeper-action:fix-required item=1 sha=oldhead confidence=high -->",
    },
    {
      user: { login: "contributor" },
      body: "<!-- clawsweeper-action:fix-required item=1 sha=abc123 confidence=high -->",
    },
  ];
  assert.equal(hasTrustedRepairRequestForHead(comments, "abc123"), false);
});

test("automerge shepherd uses the latest trusted exact-head review decision", () => {
  const repair = {
    user: { login: "clawsweeper[bot]" },
    body: "<!-- clawsweeper-action:fix-required item=1 sha=abc123 confidence=high -->",
  };
  const pass = {
    user: { login: "clawsweeper[bot]" },
    body: "<!-- clawsweeper-verdict:pass item=1 sha=abc123 confidence=high -->",
  };
  assert.equal(hasTrustedRepairRequestForHead([repair, pass], "abc123"), false);
  assert.equal(hasTrustedPassForHead([repair, pass], "abc123"), true);
  assert.equal(hasTrustedRepairRequestForHead([pass, repair], "abc123"), true);
  assert.equal(hasTrustedPassForHead([pass, repair], "abc123"), false);
});

test("automerge shepherd stops when latest exact-head review requires human handling", () => {
  const pass = {
    user: { login: "clawsweeper[bot]" },
    body: "<!-- clawsweeper-verdict:pass item=1 sha=abc123 confidence=high -->",
  };
  const human = {
    user: { login: "clawsweeper[bot]" },
    body: "<!-- clawsweeper-verdict:needs-human item=1 sha=abc123 confidence=high -->",
  };
  assert.equal(hasTrustedHumanReviewForHead([pass, human], "abc123"), true);
  assert.equal(hasTrustedPassForHead([pass, human], "abc123"), false);
  assert.equal(hasTrustedHumanReviewForHead([human, pass], "abc123"), false);
  assert.equal(hasTrustedPassForHead([human, pass], "abc123"), true);
  assert.deepEqual(
    automergeShepherdReadiness({
      view: { state: "OPEN", headRefOid: "abc123" },
      comments: [pass, human],
      headSha: "abc123",
    }),
    {
      status: "human",
      reason: "exact-head ClawSweeper review requires human handling",
    },
  );
});

test("automerge shepherd routes repairable needs-human findings back to repair", () => {
  const comments = [
    {
      user: { login: "clawsweeper[bot]" },
      body: [
        "**Review findings**",
        "- [P1] Fix the exact-head regression.",
        "",
        "<!-- clawsweeper-verdict:needs-human item=1 sha=abc123 confidence=high -->",
      ].join("\n"),
    },
  ];
  assert.equal(hasTrustedHumanReviewForHead(comments, "abc123"), false);
  assert.equal(hasTrustedRepairRequestForHead(comments, "abc123"), true);
});

test("automerge shepherd stops on terminal check failures before review pass", () => {
  const headSha = "abc123";
  assert.deepEqual(
    automergeShepherdReadiness({
      view: {
        state: "OPEN",
        headRefOid: headSha,
        statusCheckRollup: [
          { name: "check-lint", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "slow-check", status: "IN_PROGRESS", conclusion: "" },
        ],
      },
      comments: [],
      headSha,
    }),
    { status: "blocked", reason: "GitHub checks failed: check-lint:FAILURE" },
  );
});

test("automerge shepherd wait config is bounded and configurable", () => {
  assert.deepEqual(
    automergeShepherdWaitConfig({
      CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT_MS: "30000",
      CLAWSWEEPER_AUTOMERGE_SHEPHERD_POLL_MS: "5000",
    }),
    { maxWaitMs: 30000, intervalMs: 5000 },
  );
});
