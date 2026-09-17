import assert from "node:assert/strict";
import test from "node:test";
import { githubCredentialScopeForToken } from "../dist/github-retry.js";
import { createGitHubRuntime } from "../dist/clawsweeper-github-runtime.js";

test("credential identity classification is explicit and excludes absent repository tokens", () => {
  const identities = Object.freeze({
    CLAWSWEEPER_PUBLIC_GH_TOKEN: " synthetic-public ",
    REPO_TOKEN: "synthetic-repository",
    GITHUB_TOKEN: "synthetic-github",
  });
  for (const token of ["synthetic-public", "synthetic-repository", "synthetic-github"]) {
    assert.equal(githubCredentialScopeForToken(token, identities), "repository_actions");
  }
  for (const token of ["synthetic-app", "", " "]) {
    assert.equal(githubCredentialScopeForToken(token, identities), "target_app");
  }
  assert.equal(githubCredentialScopeForToken("", {}), "target_app");
  assert.equal(githubCredentialScopeForToken("", { GITHUB_TOKEN: " " }), "target_app");
});

test("runtime extraction preserves its existing selected-token precedence", (t) => {
  const env: NodeJS.ProcessEnv = {
    GH_TOKEN: "synthetic-app",
    GITHUB_TOKEN: "synthetic-github",
    REPO_TOKEN: "synthetic-repository",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "synthetic-public",
    GH_HOST: undefined,
    EXACT_EVENT_PUBLICATION: undefined,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: undefined,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: undefined,
    CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    targetRepo: () => "openclaw/openclaw",
    run: () => assert.fail("scope classification must not dispatch"),
  });
  const args = ["api", "repos/openclaw/openclaw/issues/123"];
  const cause = new Error("gh: rate limit exceeded (HTTP 429)");
  const cases: Array<{ args: string[]; overrides: NodeJS.ProcessEnv; scope: string }> = [
    { args, overrides: {}, scope: "repository_actions" },
    { args: [...args, "--method", "PATCH"], overrides: {}, scope: "target_app" },
    { args, overrides: { GH_TOKEN: "synthetic-repository" }, scope: "repository_actions" },
    {
      args,
      overrides: { GH_TOKEN: "synthetic-explicit", GITHUB_TOKEN: "synthetic-github" },
      scope: "target_app",
    },
    { args, overrides: { GITHUB_TOKEN: "synthetic-github" }, scope: "repository_actions" },
    {
      args,
      overrides: { GH_TOKEN: " ", GITHUB_TOKEN: "synthetic-github" },
      scope: "repository_actions",
    },
  ];
  for (const item of cases) {
    assert.equal(runtime.githubRateLimitError(cause, item.args, item.overrides).scope, item.scope);
  }
});
