import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GITHUB_API_URL, githubApiBaseUrl, githubApiUrl } from "../dashboard/github-api.ts";

test("GitHub API URL uses the production origin by default", () => {
  assert.equal(githubApiBaseUrl({}), DEFAULT_GITHUB_API_URL);
  assert.equal(githubApiUrl({}, "/graphql"), "https://api.github.com/graphql");
});

test("GitHub API URL honors a validated loopback override", () => {
  const env = { GITHUB_API_URL: "http://127.0.0.1:8788" };
  assert.equal(githubApiBaseUrl(env), "http://127.0.0.1:8788");
  assert.equal(
    githubApiUrl(env, "/repos/openclaw/clawsweeper"),
    "http://127.0.0.1:8788/repos/openclaw/clawsweeper",
  );
});

test("GitHub API URL rejects insecure or non-origin overrides", () => {
  for (const value of [
    "http://github.example.test",
    "http://localhost",
    "http://127.0.0.1:8788/api",
    "https://api.github.test/v3",
    "https://user@example.test",
  ]) {
    assert.throws(() => githubApiBaseUrl({ GITHUB_API_URL: value }), /invalid GITHUB_API_URL/);
  }
  assert.equal(
    githubApiBaseUrl({ GITHUB_API_URL: "https://api.github.test" }),
    "https://api.github.test",
  );
  assert.equal(
    githubApiBaseUrl({ GITHUB_API_URL: "http://localhost:8788" }),
    "http://localhost:8788",
  );
});
