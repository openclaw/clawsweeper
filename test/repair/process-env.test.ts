import assert from "node:assert/strict";
import test from "node:test";
import {
  clawsweeperGitUserEmail,
  clawsweeperGitUserName,
  ghCliEnv,
} from "../../dist/repair/process-env.js";
import {
  CLAWSWEEPER_APP_LOGIN,
  CLAWSWEEPER_APP_NOREPLY_EMAIL,
  CLAWSWEEPER_APP_SLUG,
} from "../../dist/clawsweeper-bot-identity.js";

function withEnv(values: Record<string, string>, callback: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("state publication defaults to the avatar-friendly bot identity", () => {
  for (const name of ["", "clawsweeper-repair", CLAWSWEEPER_APP_LOGIN]) {
    withEnv({ CLAWSWEEPER_GIT_USER_NAME: name, CLAWSWEEPER_GIT_USER_EMAIL: "" }, () => {
      assert.equal(clawsweeperGitUserName(), CLAWSWEEPER_APP_SLUG);
      assert.equal(clawsweeperGitUserEmail(), CLAWSWEEPER_APP_NOREPLY_EMAIL);
    });
  }
  withEnv(
    { CLAWSWEEPER_GIT_USER_NAME: "publisher", CLAWSWEEPER_GIT_USER_EMAIL: "bot@example.invalid" },
    () => {
      assert.equal(clawsweeperGitUserName(), "publisher");
      assert.equal(clawsweeperGitUserEmail(), "bot@example.invalid");
    },
  );
});

test("GitHub CLI environment preserves explicit credentials and suppresses color", () => {
  const env = ghCliEnv({ GH_TOKEN: "explicit-test-token", FORCE_COLOR: "1" });
  assert.equal(env.GH_TOKEN, "explicit-test-token");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.CLICOLOR, "0");
  assert.equal(env.FORCE_COLOR, undefined);
});
