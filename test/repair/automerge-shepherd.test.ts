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
          body: "passed\n<!-- clawsweeper-verdict:pass live_verification=absent sha=abc123 -->",
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
          body: "passed\n<!-- clawsweeper-verdict:pass live_verification=absent sha=abc123 -->",
        },
      ],
      headSha,
    }),
    { status: "ready", reason: "checks and exact-head review are ready" },
  );
});

test("automerge shepherd refuses failed, malformed, and legacy verification markers", () => {
  const headSha = "abc123";
  const view = {
    state: "OPEN",
    headRefOid: headSha,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  const comment = (liveVerification: string | null) => ({
    user: { login: "clawsweeper[bot]" },
    body: `<!-- clawsweeper-verdict:pass sha=${headSha}${liveVerification ? ` live_verification=${liveVerification}` : ""} -->`,
  });

  for (const state of ["failed", "malformed"]) {
    assert.deepEqual(automergeShepherdReadiness({ view, comments: [comment(state)], headSha }), {
      status: "human",
      reason: `exact-head ClawSweeper review has ${state} live verification`,
    });
  }
  assert.deepEqual(automergeShepherdReadiness({ view, comments: [comment(null)], headSha }), {
    status: "waiting",
    reason: "waiting for exact-head ClawSweeper review pass",
  });
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
          body: "passed\n<!-- clawsweeper-verdict:pass live_verification=absent sha=abc123 -->",
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
    id: 101,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:00:00Z",
    body: "<!-- clawsweeper-action:fix-required item=1 sha=abc123 confidence=high -->",
  };
  const pass = {
    id: 102,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:01:00Z",
    body: "<!-- clawsweeper-verdict:pass live_verification=absent item=1 sha=abc123 confidence=high -->",
  };
  for (const comments of [
    [repair, pass],
    [pass, repair],
  ]) {
    assert.equal(hasTrustedRepairRequestForHead(comments, "abc123"), false);
    assert.equal(hasTrustedPassForHead(comments, "abc123"), true);
  }
});

test("automerge shepherd invalidates an older pass after an exact-head close verdict", () => {
  const pass = {
    id: 201,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:00:00Z",
    body: "<!-- clawsweeper-verdict:pass live_verification=absent item=1 sha=abc123 -->",
  };
  const close = {
    id: 202,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:01:00Z",
    body: "<!-- clawsweeper-verdict:close item=1 sha=abc123 reason=duplicate_or_superseded -->",
  };

  for (const comments of [
    [pass, close],
    [close, pass],
  ]) {
    assert.equal(hasTrustedPassForHead(comments, "abc123"), false);
  }
});

test("automerge shepherd stops when latest exact-head review requires human handling", () => {
  const pass = {
    id: 301,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:00:00Z",
    body: "<!-- clawsweeper-verdict:pass live_verification=absent item=1 sha=abc123 confidence=high -->",
  };
  const human = {
    id: 302,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-08-27T12:01:00Z",
    body: "<!-- clawsweeper-verdict:needs-human item=1 sha=abc123 confidence=high -->",
  };
  for (const comments of [
    [pass, human],
    [human, pass],
  ]) {
    assert.equal(hasTrustedHumanReviewForHead(comments, "abc123"), true);
    assert.equal(hasTrustedPassForHead(comments, "abc123"), false);
  }
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
