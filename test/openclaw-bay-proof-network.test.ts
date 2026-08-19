import assert from "node:assert/strict";
import test from "node:test";

import { isGitHubApiHostname } from "../docs/proof/openclaw-bay/network-policy.mjs";

test("Bay proof classifies only the exact GitHub API hostname", () => {
  assert.equal(isGitHubApiHostname("api.github.com"), true);
  assert.equal(isGitHubApiHostname("API.GITHUB.COM."), true);
  assert.equal(isGitHubApiHostname("api.github.com.evil.example"), false);
  assert.equal(isGitHubApiHostname("evil-api.github.com"), false);
  assert.equal(isGitHubApiHostname("github.com"), false);
});
