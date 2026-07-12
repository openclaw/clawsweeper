import assert from "node:assert/strict";
import test from "node:test";

import {
  clawsweeperGitIdentityEnv,
  clawsweeperGitUserName,
  codexModelArgs,
  codexSubprocessEnv,
  internalCodexModel,
  repairCodexReasoningEffort,
  repairCodexServiceTier,
} from "../../dist/repair/process-env.js";

test("codexSubprocessEnv forces ClawSweeper git identity and strips tokens", () => {
  withEnv(
    {
      CLAWSWEEPER_GIT_USER_NAME: "clawsweeper-repair",
      CLAWSWEEPER_GIT_USER_EMAIL: "bot@example.invalid",
      CLAWSWEEPER_TARGET_GH_TOKEN: "secret",
      CLAWSWEEPER_RULESET_GH_TOKEN: "verifier-secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITHUB_ACTIONS: "true",
      OPENAI_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      CLAWSWEEPER_INTERNAL_MODEL: "secret-model",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-secret",
      CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: "service-secret",
      CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL: "wss://example.invalid/secret",
      CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: "https://example.invalid/secret",
    },
    () => {
      const env = codexSubprocessEnv();

      assert.equal(env.GIT_AUTHOR_NAME, "clawsweeper");
      assert.equal(env.GIT_AUTHOR_EMAIL, "bot@example.invalid");
      assert.equal(env.GIT_COMMITTER_NAME, "clawsweeper");
      assert.equal(env.GIT_COMMITTER_EMAIL, "bot@example.invalid");
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_TARGET_GH_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_RULESET_GH_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.equal(env.CLAWSWEEPER_INTERNAL_MODEL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL, undefined);
      assert.equal(internalCodexModel("internal"), "secret-model");
      assert.deepEqual(codexModelArgs("internal"), []);
      assert.deepEqual(codexModelArgs("secret-model"), []);
      assert.deepEqual(codexModelArgs("explicit-public-model"), [
        "--model",
        "explicit-public-model",
      ]);
    },
  );
});

test("clawsweeper git identity defaults to avatar-friendly bot name", () => {
  withEnv({ CLAWSWEEPER_GIT_USER_NAME: "", CLAWSWEEPER_GIT_USER_EMAIL: "" }, () => {
    assert.equal(clawsweeperGitUserName(), "clawsweeper");
    assert.deepEqual(clawsweeperGitIdentityEnv(), {
      GIT_AUTHOR_NAME: "clawsweeper",
      GIT_AUTHOR_EMAIL: "274271284+clawsweeper[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "clawsweeper",
      GIT_COMMITTER_EMAIL: "274271284+clawsweeper[bot]@users.noreply.github.com",
    });
  });
});

test("repair Codex config keeps repair workers on high fast", () => {
  assert.equal(repairCodexReasoningEffort(undefined), "high");
  assert.equal(repairCodexReasoningEffort(""), "high");
  assert.equal(repairCodexReasoningEffort("xhigh"), "high");
  assert.equal(repairCodexReasoningEffort("XHIGH"), "high");
  assert.equal(repairCodexReasoningEffort("medium"), "medium");

  assert.equal(repairCodexServiceTier(undefined), "fast");
  assert.equal(repairCodexServiceTier(""), "fast");
  assert.equal(repairCodexServiceTier("fast"), "fast");
});

function withEnv(values: Record<string, string>, callback: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  try {
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
