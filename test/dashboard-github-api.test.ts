import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GITHUB_API_URL,
  githubApiBaseUrl,
  githubApiUrl,
  githubAppJson,
  GitHubRequestError,
} from "../dashboard/github-api.ts";

test("opt-in HTTP limit bounds streamed bytes, preserves error status and leaves defaults unchanged", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const status of [200, 403, 404]) {
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('"' + "é".repeat(40) + '"'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status },
      );
    await assert.rejects(
      githubAppJson("/fixture", "fixture-token", { maxResponseBytes: 32 }),
      (error: unknown) => error instanceof GitHubRequestError && error.status === status,
    );
    assert(cancelled);
  }
  globalThis.fetch = async () => Response.json({ value: "é" });
  assert.deepEqual(await githubAppJson("/fixture", "fixture-token", { maxResponseBytes: 14 }), {
    value: "é",
  });
  assert.deepEqual(await githubAppJson("/fixture", "fixture-token"), { value: "é" });
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    globalThis.fetch = async () => assert.fail("invalid cap reached transport");
    await assert.rejects(
      githubAppJson("/fixture", "fixture-token", { maxResponseBytes: limit }),
      /byte limit/,
    );
  }
  globalThis.fetch = async () => new Response('[{"id":7', { status: 200 });
  await assert.rejects(
    githubAppJson("/fixture", "fixture-token", { maxResponseBytes: 32 }),
    SyntaxError,
  );
});

test("GitHub API URL uses the production origin by default", () => {
  assert.equal(githubApiBaseUrl({}), DEFAULT_GITHUB_API_URL);
  assert.equal(
    githubApiBaseUrl({ GITHUB_API_URL: "https://api.github.com" }),
    DEFAULT_GITHUB_API_URL,
  );
  assert.equal(githubApiUrl({}, "/graphql"), "https://api.github.com/graphql");
});

test("GitHub API URL honors a validated loopback override", () => {
  const env = { GITHUB_API_URL: "http://127.0.0.1:8788" };
  assert.equal(githubApiBaseUrl(env), "http://127.0.0.1:8788");
  assert.equal(
    githubApiUrl(env, "/repos/openclaw/clawsweeper"),
    "http://127.0.0.1:8788/repos/openclaw/clawsweeper",
  );
  assert.equal(
    githubApiBaseUrl({ GITHUB_API_URL: "http://localhost:8788" }),
    "http://localhost:8788",
  );
});

test("GitHub API URL rejects non-default remote or non-origin overrides", () => {
  for (const value of [
    "http://github.example.test",
    "http://localhost",
    "http://127.0.0.1",
    "http://127.0.0.1:8788/api",
    "https://api.github.test/v3",
    "https://user@example.test",
    "https://evil.example",
    "https://api.github.com:8443",
  ]) {
    assert.throws(() => githubApiBaseUrl({ GITHUB_API_URL: value }), /invalid GITHUB_API_URL/);
  }
});

test("GitHub App requests reject an empty repository scope and canonicalize sets", async () => {
  const { githubAppTokenRequest } = await import("../dashboard/github-api.ts");
  for (const repositories of [[], [""], ["alpha", ""], ["owner/alpha"]]) {
    assert.throws(
      () => githubAppTokenRequest(repositories, { issues: "read" }),
      /explicit repository names/,
    );
  }
  assert.deepEqual(
    githubAppTokenRequest(["Beta", "alpha", "beta"], { pull_requests: "read", issues: "read" }),
    {
      repositories: ["alpha", "beta"],
      permissions: { issues: "read", pull_requests: "read" },
    },
  );
});
