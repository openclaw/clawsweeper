import assert from "node:assert/strict";
import test from "node:test";

import { codexEnv } from "../dist/codex-env.js";

test("codex subprocess env strips process-local Git config overrides", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "sentinel-clawsweeper-git-auth-boundary-20260920";
    process.env.GIT_CONFIG_KEY_1 = "user.email";
    process.env.GIT_CONFIG_VALUE_1 = "sentinel-count@invalid.example";
    process.env.GIT_CONFIG_KEY_10 = "alias.sentinel";
    process.env.GIT_CONFIG_VALUE_10 = "status";
    process.env.GIT_CONFIG_PARAMETERS = "'user.email=sentinel-params@invalid.example'";
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    process.env.GH_TOKEN = "synthetic-negative-control-gh";

    const env = codexEnv();

    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(env.GIT_CONFIG_KEY_1, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_1, undefined);
    assert.equal(env.GIT_CONFIG_KEY_10, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_10, undefined);
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    process.env = originalEnv;
  }
});
